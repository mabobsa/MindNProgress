import { createHash, randomUUID } from 'node:crypto'

function sameRequestScope(failure, delegation) {
  return Boolean(delegation?.id && delegation.requestSignature
    && delegation.createdAt >= failure.createdAt
    && delegation.mapId === failure.mapId
    && (delegation.parentMapId ?? delegation.mapId) === failure.parentMapId
    && delegation.parentCardId === failure.parentCardId
    && delegation.targetCardId === failure.targetCardId
    && failure.targetHomeMachineId
    && delegation.targetHomeMachineId === failure.targetHomeMachineId)
}

function publicFailure(record, resolvedByDelegationId = record.resolution?.delegationId ?? null) {
  const { requestSignature: _signature, instructionHash: _instructionHash, ...publicRecord } = record
  return { ...publicRecord, resolvedByDelegationId,
    ...(!resolvedByDelegationId && !record.requestClosure && record.instructionHash && record.phase === 'preflight' && record.executionState === 'not-started'
      ? { retryReference: { requestId: record.id, instruction: '동일 업무를 다시 요청할 때 retryOfRequestId에 requestId를 전달하세요. instruction은 그대로 유지하고 sourceRevision 등 요청 메타데이터만 갱신하세요. 새 업무에는 이 참조를 사용하지 마세요.' } } : {}) }
}

function failureError(status, reasonCode, message) {
  return Object.assign(new Error(message), { status, reasonCode })
}

const retryablePreflightCodes = new Set(['AI_DELEGATION_VERSION_CONFLICT', 'AI_DELEGATION_ALREADY_ACTIVE', 'AI_DELEGATION_CONVERSATION_BUSY'])
const instructionDigest = instruction => createHash('sha256').update(instruction).digest('hex')

function sameWork(failure, candidate) {
  return sameRequestScope(failure, candidate) && failure.instructionHash
    && failure.instructionHash === candidate.instructionHash
    && failure.parentConversationId && failure.parentConversationId === candidate.parentConversationId
    && failure.strategy === candidate.strategy
    && (!failure.requestedConversationId || failure.requestedConversationId === candidate.targetConversationId)
}

function verifiedReplacement(failure, delegations, records = []) {
  if (failure.requestClosure) return null
  if (failure.resolution) return { id: failure.resolution.delegationId, method: failure.resolution.method }
  const accepted = delegations.get(failure.requestedDelegationId)
  if (sameRequestScope(failure, accepted) && failure.requestSignature && accepted.requestSignature === failure.requestSignature) {
    return { id: accepted.id, method: 'same-request' }
  }
  if (failure.phase !== 'preflight' || failure.executionState !== 'not-started') return null
  const referencesFailure = candidate => {
    let id = candidate.retryOfRequestId
    const visited = new Set()
    while (id && !visited.has(id)) {
      visited.add(id)
      if (id === failure.id) return true
      const previous = records.find(record => record.id === id)
      if (!previous || previous.phase !== 'preflight' || previous.executionState !== 'not-started' || !sameWork(previous, candidate)) return false
      id = previous.retryOfRequestId
    }
    return false
  }
  const candidate = [...delegations.values()].filter(item => sameWork(failure, item)
    && (retryablePreflightCodes.has(failure.reasonCode) || referencesFailure(item)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  return candidate ? { id: candidate.id, method: referencesFailure(candidate) ? 'retry-reference' : 'same-instruction' } : null
}

function verificationView(failure, delegations, records) {
  const verified = verifiedReplacement(failure, delegations, records)
  const replacement = verified && delegations.get(verified.id)
  const candidates = [...delegations.values()].filter(item => sameRequestScope(failure, item))
  const state = failure.requestClosure ? 'closed' : verified ? 'confirmed' : failure.executionState === 'unknown' ? 'execution-unknown'
    : candidates.length ? 'unverified' : 'not-found'
  return { ...publicFailure(failure, verified?.id ?? null), retryVerification: {
    state, method: verified?.method ?? null,
    message: ({ closed: '사용자가 미접수 요청을 종료했습니다. 재접수나 업무 완료가 아니며 원래 실패 이력을 보존합니다.',
      confirmed: '정상 재접수가 확인되어 접수 실패 경고를 해제했습니다. 업무 완료 판정과는 별개입니다.',
      unverified: '후속 접수는 있지만 같은 업무의 재접수인지 확인할 근거가 부족합니다. 담당 상위 AI의 요청 기록 확인이 필요합니다.',
      'not-found': '이 실패 이후 같은 대상의 재접수 기록이 없습니다. 담당 상위 AI가 원인과 재접수 필요 여부를 확인해야 합니다.',
      'execution-unknown': '원 요청의 실행 여부가 불확실합니다. 중복 실행을 피하기 위해 접수 기록 확인이 필요합니다.' })[state],
    replacement: replacement ? { id: replacement.id, targetCardLabel: replacement.targetCardLabel,
      instructionPreview: replacement.instructionPreview, createdAt: replacement.createdAt, state: replacement.state,
      targetConversationId: replacement.targetConversationId } : null,
  } }
}

export function safeDelegationFailureMessage(message, instruction = '') {
  let text = String(message ?? '')
  if (instruction) text = text.replaceAll(instruction, '[지시 전문 생략]')
  return text.replace(/Bearer\s+[a-z0-9._~+/-]+/gi, 'Bearer [비공개]')
    .replace(/((?:access[_-]?token|api[_-]?key|authorization|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[비공개]').slice(0, 4000)
}

// Request failures are not executable delegations and never enter the delegation poller.
export async function createAiDelegationRequestFailures({ filePath, readJson, writeJson, deletedMapIds = new Set(), withMutation, onRollback = () => {} }) {
  let records = await readJson(filePath)
  let queue = Promise.resolve()
  const exclusive = (action) => {
    const protectedAction = async () => {
      const previous = records
      const previousDeleted = [...deletedMapIds]
      onRollback(() => { records = previous; deletedMapIds.clear(); for (const id of previousDeleted) deletedMapIds.add(id) })
      return action()
    }
    if (withMutation) return withMutation(protectedAction)
    const result = queue.catch(() => {}).then(protectedAction)
    queue = result.catch(() => {})
    return result
  }
  return {
    record(context, { status, reasonCode, message }) {
      const action = async () => {
        if (deletedMapIds.has(context.mapId) || deletedMapIds.has(context.parentMapId)) return null
        const now = new Date().toISOString()
        const record = {
          id: context.requestId || `request-${randomUUID()}`, kind: 'request-failure', state: 'request-failed',
          requestedDelegationId: context.delegationId, requestSignature: context.requestSignature,
          mapId: context.mapId, parentMapId: context.parentMapId,
          parentCardId: context.parentCardId, parentCardLabel: context.parentCardLabel,
          parentConversationId: context.parentConversationId,
          requestedConversationId: context.requestedConversationId || null,
          targetCardId: context.targetCardId, targetCardLabel: context.targetCardLabel,
          parentHomeMachineId: context.parentHomeMachineId, targetHomeMachineId: context.targetHomeMachineId,
          strategy: context.strategy, phase: context.dispatchStarted ? 'dispatch' : 'preflight',
          accepted: false, executionState: context.dispatchStarted && !context.definitelyRejected ? 'unknown' : 'not-started',
          automaticRetry: false, status, reasonCode, message: safeDelegationFailureMessage(message, context.instruction), createdAt: now, updatedAt: now,
          instructionHash: context.instruction ? createHash('sha256').update(context.instruction).digest('hex') : null,
          // 실패 기록에 지시 전문을 복제하지 않는다. 공개용으로 별도 제공한 요약만 저장한다.
          requestSummary: safeDelegationFailureMessage(context.taskSummary ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
          ...(context.retryOfRequestId ? { retryOfRequestId: context.retryOfRequestId } : {}),
        }
        const next = [...records, record]
        await writeJson(filePath, next)
        records = next
        return publicFailure(record)
      }
      return exclusive(action)
    },
    purgeMaps(mapIds) {
      const ids = new Set(mapIds)
      const action = async () => {
        const next = records.filter(item => !ids.has(item.mapId) && !ids.has(item.parentMapId))
        const removedCount = records.length - next.length
        if (removedCount) await writeJson(filePath, next)
        records = next
        for (const mapId of ids) deletedMapIds.add(mapId)
        return removedCount
      }
      return exclusive(action)
    },
    list({ mapId, parentCardId, targetCardId, delegations }) {
      return records.filter(item => (item.parentMapId === mapId || item.mapId === mapId)
        && (!parentCardId || item.parentCardId === parentCardId)
        && (!targetCardId || item.targetCardId === targetCardId)).map(item => verificationView(item, delegations, records))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    preserveResolutionsBeforeCleanup(delegationIds, delegations) {
      const action = async () => {
        let changed = false
        const next = records.map((record) => {
          if (record.resolution || record.requestClosure) return record
          const verified = verifiedReplacement(record, delegations, records)
          if (!verified || !delegationIds.has(verified.id)) return record
          changed = true
          const at = new Date().toISOString()
          return { ...record, updatedAt: at, resolution: { delegationId: verified.id, method: verified.method,
            at, actorId: 'system', note: '완료 상세 이력 정리 전에 정상 재접수 근거를 확인했습니다.' } }
        })
        if (changed) { await writeJson(filePath, next); records = next }
      }
      return exclusive(action)
    },
    validateRetry(context, requestId, delegations) {
      if (requestId === undefined) return null
      const failure = records.find(item => item.id === requestId)
      if (failure?.requestClosure) throw failureError(409, 'AI_DELEGATION_REQUEST_FAILURE_CLOSED', '사용자가 종료한 요청은 재접수 참조로 사용할 수 없습니다. 새 작업은 승인 범위를 확인하고 별도로 요청하세요.')
      const candidate = { ...context, id: context.delegationId, createdAt: new Date().toISOString(),
        targetConversationId: context.requestedConversationId, instructionHash: instructionDigest(context.instruction) }
      if (!failure || failure.phase !== 'preflight' || failure.executionState !== 'not-started'
        || !sameWork(failure, candidate)) throw failureError(409, 'AI_DELEGATION_RETRY_REFERENCE_INVALID',
        '재접수 참조의 문서·카드·상위 대화·머신·지시가 원 요청과 다릅니다. 같은 업무는 원 지시를 유지하고 문서 버전 등 메타데이터만 갱신하세요. 새 업무는 참조 없이 요청하세요.')
      const replacement = verifiedReplacement(failure, delegations, records)
      if (replacement && replacement.id !== context.delegationId) throw Object.assign(failureError(409, 'AI_DELEGATION_RETRY_ALREADY_ACCEPTED',
        '이 실패 요청은 이미 정상 재접수됐습니다. 새 위임을 만들지 말고 기존 위임 현황을 확인하세요.'), { delegationId: replacement.id })
      return requestId
    },
    recheck({ mapId, failureId, expectedUpdatedAt, actorId }, delegations) {
      const action = async () => {
        const record = records.find(item => item.id === failureId && item.parentMapId === mapId)
        if (!record) throw failureError(404, 'AI_DELEGATION_REQUEST_FAILURE_NOT_FOUND', '접수 실패 기록을 찾을 수 없습니다.')
        if (!actorId) throw failureError(403, 'AI_DELEGATION_EDITOR_REQUIRED', '편집자만 접수 확인을 요청할 수 있습니다.')
        if (!record.resolution && !record.requestClosure && expectedUpdatedAt !== record.updatedAt) throw failureError(409, 'AI_DELEGATION_REQUEST_FAILURE_CHANGED', '접수 실패 기록이 변경됐습니다. 최신 상태를 다시 확인하세요.')
        const verified = verifiedReplacement(record, delegations, records)
        if (verified && !record.resolution) {
          const now = new Date().toISOString()
          const updated = { ...record, updatedAt: now, resolution: { delegationId: verified.id,
            method: verified.method, at: now, actorId, note: '서버가 저장된 요청과 실제 재접수의 일치 근거를 확인했습니다.' } }
          const next = records.map(item => item.id === record.id ? updated : item)
          await writeJson(filePath, next)
          records = next
          return { requestFailure: verificationView(updated, delegations, records) }
        }
        return { requestFailure: verificationView(record, delegations, records) }
      }
      return exclusive(action)
    },
    get(id) {
      const record = records.find(item => item.id === id)
      return record ? structuredClone(record) : null
    },
    close({ mapId, failureId, expectedUpdatedAt, reason, note, confirmNotExecuted, actorId }, delegations) {
      const action = async () => {
        const record = records.find(item => item.id === failureId && item.parentMapId === mapId)
        if (!record) throw failureError(404, 'AI_DELEGATION_REQUEST_FAILURE_NOT_FOUND', '접수 실패 기록을 찾을 수 없습니다.')
        if (!actorId) throw failureError(403, 'AI_DELEGATION_EDITOR_REQUIRED', '편집자만 미접수 요청을 종료할 수 있습니다.')
        if (confirmNotExecuted !== true || !['cancelled', 'no-longer-needed'].includes(reason)
          || typeof note !== 'string' || note.trim().length < 3 || note.length > 1000) throw failureError(400,
          'AI_DELEGATION_REQUEST_FAILURE_CLOSE_CONFIRMATION_REQUIRED', '미실행 요청 종료를 확인하고 사유와 3자 이상 1000자 이하의 메모를 남겨 주세요.')
        if (record.requestClosure) {
          if (record.requestClosure.reason !== reason || record.requestClosure.note !== note.trim()) throw failureError(409,
            'AI_DELEGATION_REQUEST_FAILURE_CLOSED', '이미 종료한 요청입니다. 기존 종료 이력을 변경할 수 없습니다.')
          return { requestFailure: verificationView(record, delegations, records), repeated: true }
        }
        if (expectedUpdatedAt !== record.updatedAt) throw failureError(409, 'AI_DELEGATION_REQUEST_FAILURE_CHANGED', '접수 실패 기록이 변경됐습니다. 최신 상태를 다시 확인하세요.')
        if (record.phase !== 'preflight' || record.executionState !== 'not-started' || record.accepted !== false) throw failureError(409,
          'AI_DELEGATION_REQUEST_FAILURE_EXECUTION_UNCERTAIN', '접수 전 미실행이 확인된 요청만 종료할 수 있습니다. 실행 여부가 불확실하면 먼저 접수 기록을 확인하세요.')
        if (verifiedReplacement(record, delegations, records)) throw failureError(409,
          'AI_DELEGATION_REQUEST_FAILURE_ALREADY_RESOLVED', '정상 재접수가 확인된 요청입니다. 재접수 확인으로 처리하고 실제 위임은 별도로 확인하세요.')
        const now = new Date().toISOString()
        const updated = { ...record, updatedAt: now, requestClosure: { reason, note: note.trim(), at: now, actorId } }
        const next = records.map(item => item.id === record.id ? updated : item)
        await writeJson(filePath, next)
        records = next
        return { requestFailure: verificationView(updated, delegations, records), repeated: false }
      }
      return exclusive(action)
    },
    resolve({ mapId, failureId, replacementDelegationId, expectedUpdatedAt, confirmSameWork, note, actorId }, delegations) {
      const action = async () => {
        const record = records.find(item => item.id === failureId && item.parentMapId === mapId)
        if (!record) throw failureError(404, 'AI_DELEGATION_REQUEST_FAILURE_NOT_FOUND', '접수 실패 기록을 찾을 수 없습니다.')
        if (record.requestClosure) throw failureError(409, 'AI_DELEGATION_REQUEST_FAILURE_CLOSED', '이미 종료한 요청을 정상 재접수로 변경할 수 없습니다.')
        if (record.resolution) {
          if (record.resolution.delegationId !== replacementDelegationId) throw failureError(409, 'AI_DELEGATION_REQUEST_FAILURE_ALREADY_RESOLVED', '다른 재접수 위임으로 이미 처리한 기록입니다.')
          return { requestFailure: publicFailure(record), repeated: true }
        }
        if (!expectedUpdatedAt || expectedUpdatedAt !== record.updatedAt) throw failureError(409, 'AI_DELEGATION_REQUEST_FAILURE_CHANGED', '접수 실패 기록이 변경됐습니다. 최신 상태를 다시 확인하세요.')
        if (confirmSameWork !== true || typeof note !== 'string' || note.trim().length < 3 || note.length > 1000
          || !actorId) throw failureError(400, 'AI_DELEGATION_REQUEST_FAILURE_CONFIRMATION_REQUIRED', '동일 업무의 재접수를 확인하고 3자 이상 1000자 이하의 감사 메모를 남겨 주세요.')
        if (record.phase !== 'preflight' || record.executionState !== 'not-started') throw failureError(409, 'AI_DELEGATION_REQUEST_FAILURE_EXECUTION_UNCERTAIN', '실행 여부가 불확실한 요청은 재접수 확인으로 해제할 수 없습니다.')
        const accepted = delegations.get(replacementDelegationId)
        if (!sameRequestScope(record, accepted)) throw failureError(409, 'AI_DELEGATION_REQUEST_FAILURE_REPLACEMENT_INVALID', '같은 문서·상위·대상 카드·머신에서 나중에 실제 접수된 위임을 선택해야 합니다.')
        const now = new Date().toISOString()
        const updated = { ...record, updatedAt: now, resolution: {
          delegationId: accepted.id, method: 'confirmed-retry', at: now, actorId, note: note.trim(),
        } }
        const next = records.map(item => item.id === record.id ? updated : item)
        await writeJson(filePath, next)
        records = next
        return { requestFailure: publicFailure(updated), repeated: false }
      }
      return exclusive(action)
    },
  }
}

export function withDelegationTaskCompletion(delegation, map) {
  const target = map?.nodes.find(node => node.id === delegation.targetCardId)
  if (delegation.state !== 'completed' || target?.data?.isWork !== true) return delegation
  const { status, progress } = target.data
  return { ...delegation, taskCompletion: {
    state: status === 'done' && progress === 100 ? 'completed' : 'incomplete', status, progress,
    message: status === 'done' && progress === 100
      ? 'AI 실행은 종료됐고 카드 업무는 완료 상태입니다. 품질과 기록의 검증을 대신하지 않습니다.'
      : 'AI 실행은 종료됐지만 카드 업무는 아직 미완료입니다. 결과와 카드 기록을 담당 AI가 확인해야 하며 자동 재실행하지 않습니다.',
  } }
}
