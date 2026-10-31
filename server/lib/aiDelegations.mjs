import { createHash } from 'node:crypto'
import { aiConversationTitle } from '../../src/utils/aiConversationLaunch.mjs'
import { integrationRecoveryPending } from './aiIntegrationRecovery.mjs'
import { aiDelegationResultCaptureMetadata } from './aiDelegationResultCapture.mjs'

export const AI_DELEGATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/
export const AI_DELEGATION_WAIT_POLL_DELAYS_MS = Object.freeze([3_000, 5_000, 10_000, 30_000])
export const AI_DELEGATION_TERMINAL_STATES = new Set(['completed', 'failed', 'superseded', 'closed'])

const AI_DELEGATION_STATE_REASONS = Object.freeze({
  'waiting-usage-limit': {
    reasonCode: 'AI_DELEGATION_WAITING_USAGE_LIMIT',
    message: 'AI 사용량 한도가 해제되기를 기다리고 있습니다. 기존 작업과 작업공간이 보존되므로 새 위임을 만들지 마세요.',
  },
  'waiting-rate-limit': {
    reasonCode: 'AI_DELEGATION_WAITING_RATE_LIMIT',
    message: 'AI 요청 한도가 해제되기를 기다리고 있습니다. 기존 작업과 작업공간이 보존되므로 새 위임을 만들지 마세요.',
  },
  'waiting-model-capacity': {
    reasonCode: 'AI_DELEGATION_WAITING_MODEL_CAPACITY',
    message: '선택한 AI 모델의 실행 용량이 확보되기를 기다리고 있습니다. 기존 작업과 작업공간이 보존되므로 새 위임을 만들지 마세요.',
  },
  'waiting-document-work': {
    reasonCode: 'AI_DELEGATION_WAITING_DOCUMENT_WORK',
    message: '문서 조정 결과는 준비됐지만 하위 업무 완료를 기다리고 있습니다.',
  },
  starting: {
    reasonCode: 'AI_DELEGATION_STARTING',
    message: '작업공간 배정을 마쳤고 대상 AI 대화를 시작하고 있습니다.',
  },
  'waiting-resource': {
    reasonCode: 'AI_DELEGATION_WAITING_RESOURCE',
    message: '대상 AI 실행 자원이 준비되기를 기다리고 있습니다. 같은 작업을 다시 위임하지 마세요.',
  },
  running: {
    reasonCode: 'AI_DELEGATION_RUNNING',
    message: '대상 AI가 위임 작업을 수행하고 있습니다.',
  },
  resuming: {
    reasonCode: 'AI_DELEGATION_RESUMING',
    message: '보존된 AI 대화와 작업공간에서 위임을 재개하고 있습니다.',
  },
  'waiting-child-resume': {
    reasonCode: 'AI_DELEGATION_WAITING_CHILD_RESUME',
    message: '중단된 하위 AI 대화의 명시적인 재개를 기다리고 있습니다. 새 위임을 만들지 마세요.',
  },
  'recovery-required': {
    reasonCode: 'AI_DELEGATION_RECOVERY_REQUIRED',
    message: '기존 AI 대화와 작업공간을 보존한 복구가 필요합니다. 새 위임 대신 기존 위임 복구를 사용하세요.',
  },
  'waiting-integration': {
    reasonCode: 'AI_DELEGATION_WAITING_INTEGRATION',
    message: '구현 작업을 마쳤고 통합 작업공간 반영 순서를 기다리고 있습니다.',
  },
  'integration-starting': {
    reasonCode: 'AI_DELEGATION_INTEGRATION_STARTING',
    message: '완료된 worker 변경의 통합을 시작하고 있습니다.',
  },
  'integration-waiting-resource': {
    reasonCode: 'AI_DELEGATION_INTEGRATION_WAITING_RESOURCE',
    message: '통합 검증에 필요한 AI 실행 자원이 준비되기를 기다리고 있습니다.',
  },
  'integration-running': {
    reasonCode: 'AI_DELEGATION_INTEGRATION_RUNNING',
    message: 'worker 변경을 통합하고 검증하고 있습니다.',
  },
  'integration-waiting-resume': {
    reasonCode: 'AI_DELEGATION_INTEGRATION_WAITING_RESUME',
    message: '통합 충돌을 해결할 기존 하위 AI 대화의 재개를 기다리고 있습니다.',
  },
  'integration-recovery-required': {
    reasonCode: 'AI_DELEGATION_INTEGRATION_RECOVERY_REQUIRED',
    message: '보존된 worker에서 통합 작업을 복구해야 합니다. 새 위임을 만들지 마세요.',
  },
  'waiting-parent': {
    reasonCode: 'AI_DELEGATION_WAITING_PARENT',
    message: '위임 결과가 준비됐고 상위 AI 대화가 유휴 상태가 되기를 기다리고 있습니다.',
  },
  'waking-parent': {
    reasonCode: 'AI_DELEGATION_WAKING_PARENT',
    message: '완료 결과를 상위 AI 대화에 전달하고 있습니다.',
  },
  completed: {
    reasonCode: 'AI_DELEGATION_COMPLETED',
    message: '위임 작업과 필요한 통합을 완료했습니다.',
  },
  superseded: {
    reasonCode: 'AI_DELEGATION_SUPERSEDED',
    message: '이 위임은 완료된 후속 위임으로 대체되었습니다.',
  },
  closed: {
    reasonCode: 'AI_DELEGATION_CLOSED',
    message: '업무 완료나 결과 전달로 처리하지 않고 위임 기록을 종료했습니다.',
  },
  'parent-wake-failed': {
    reasonCode: 'AI_DELEGATION_PARENT_WAKE_FAILED',
    message: '하위 작업은 끝났지만 상위 AI 대화에 결과를 전달하지 못했습니다.',
  },
  'recovery-dispatch-pending': {
    reasonCode: 'AI_DELEGATION_RECOVERY_DISPATCH_PENDING',
    message: '복구 요청의 전달 결과를 확인하고 있습니다. 같은 작업을 다시 위임하지 마세요.',
  },
})

function requiredAiDelegationReason(reasonCode, message) {
  const normalizedReasonCode = String(reasonCode ?? '').trim()
  const normalizedMessage = String(message ?? '').trim()
  if (!normalizedReasonCode || !normalizedMessage) {
    throw new TypeError('AI 위임 응답에는 reasonCode와 message가 모두 필요합니다.')
  }
  return { reasonCode: normalizedReasonCode, message: normalizedMessage }
}

export function aiDelegationResponseBody(statusCode, reasonCode, message, payload = {}) {
  const reason = requiredAiDelegationReason(reasonCode, message)
  const response = { ...payload, ...reason }
  if (Number(statusCode) >= 400 && !Object.hasOwn(response, 'error')) response.error = reason.message
  return response
}

export function aiDelegationStateReason(delegation) {
  if (integrationRecoveryPending(delegation)) return requiredAiDelegationReason(
    delegation.integrationRecoveryRequest.reasonCode, delegation.integrationRecoveryRequest.message)
  if (['failed', 'parent-wake-failed'].includes(delegation?.state) && aiDelegationDatabaseRecoveryCandidate(delegation)) return requiredAiDelegationReason(
    'AI_DELEGATION_DATABASE_DISPATCH_FAILED', 'AI 실행 전 DB 접수 오류로 시작되지 않은 실패가 기록돼 있습니다. 원 접수 기록을 검증해 수동 재개하거나 완료된 후속 위임을 확인하세요. 자동 재실행하지 않습니다.')
  if (delegation?.state === 'recovery-required' && !delegation.resultCorrection && delegation.recoveryDispatchRejection) return requiredAiDelegationReason(
    'AI_DELEGATION_RECOVERY_CONVERSATION_BUSY', '대상 대화가 사용 중이어서 복구 실행을 시작하지 않았습니다. 기존 작업과 작업공간을 보존했으며 대화가 유휴 상태가 된 뒤 같은 위임을 복구하세요.')
  if (delegation?.resultCorrection?.phase === 'held') return requiredAiDelegationReason('AI_DELEGATION_RESULT_CORRECTION_HELD',
    '결과 정정 실행 또는 Git 상태를 확인할 수 없어 기존 작업공간과 통합 잠금을 보존합니다. 별도 증거 검토가 필요합니다.')
  const displayState = aiDelegationDisplayState(delegation)
  if (displayState === 'waiting-workspace') {
    return requiredAiDelegationReason(
      delegation?.workspaceWaitReasonCode ?? 'AI_WORKSPACE_ALLOCATION_PENDING',
      delegation?.workspaceWaitMessage
        ?? delegation?.workspaceWaitError
        ?? '위임을 접수했고 작업공간을 비동기로 배정하고 있습니다. waiting-workspace만으로 모든 worker가 사용 중이라고 판단하지 마세요.',
    )
  }
  if (displayState === 'waiting-integration-clean') {
    return requiredAiDelegationReason(
      delegation?.workspaceWaitReasonCode ?? 'integration-worktree-dirty',
      delegation?.workspaceWaitMessage
        ?? delegation?.workspaceWaitError
        ?? '통합 작업공간의 추적 변경이 정리되기를 기다리고 있습니다. 정리되면 같은 위임이 자동으로 시작됩니다.',
    )
  }
  if (displayState === 'failed') {
    return requiredAiDelegationReason(
      delegation?.failureReasonCode
        ?? delegation?.workspaceResult?.reasonCode
        ?? 'AI_DELEGATION_FAILED',
      delegation?.childError
        ?? delegation?.workspaceError
        ?? delegation?.integrationError
        ?? 'AI 위임 작업을 완료하지 못했습니다.',
    )
  }
  if (displayState === 'waiting-integration' && delegation?.workspaceResult?.waitingReason) {
    const result = delegation.workspaceResult
    const paths = result.untrackedChanges?.length ? result.untrackedChanges : result.trackedChanges ?? []
    const label = ['integration-worktree-dirty', 'integration-untracked-collision'].includes(result.reasonCode)
      ? '작업 완료 · 통합 정리 대기' : '작업 완료 · 통합 대기'
    return requiredAiDelegationReason(
      result.reasonCode ?? 'AI_DELEGATION_WAITING_INTEGRATION',
      `${label}. ${aiDelegationRecoveryAvailability(delegation)?.recommendedAction === 'correct-integration-result'
        ? '사용자 통합 파일은 보존합니다. 승인된 기존 결과의 우발 변경은 원 담당자에게 명시적 통합 대기 결과 정정을 요청할 수 있습니다.'
        : result.waitingReason}${paths.length ? `\n충돌/변경 파일:\n${paths.join('\n')}` : ''}`,
    )
  }
  if (displayState === 'parent-wake-failed' && !aiDelegationSucceeded(delegation)) {
    return requiredAiDelegationReason('AI_DELEGATION_PARENT_WAKE_FAILED',
      (delegation.workspaceResult?.childStatus ?? delegation.childStatus) === 'failed'
        ? '하위 AI 실행이 중단됐으며 상위 AI로의 실패 보고도 전달하지 못했습니다. 보존된 작업의 복구가 필요합니다.'
        : '하위 업무 또는 필요한 통합을 완료하지 못했으며 상위 AI로의 상태 보고도 전달하지 못했습니다. 보존된 작업의 복구 상태를 확인하세요.')
  }
  const configured = AI_DELEGATION_STATE_REASONS[displayState]
  if (configured) return requiredAiDelegationReason(configured.reasonCode, configured.message)
  return requiredAiDelegationReason(
    'AI_DELEGATION_STATE_UNKNOWN',
    `AI 위임 상태 ${String(displayState || 'unknown')}의 안내 메시지가 등록되지 않았습니다.`,
  )
}

export const ACTIVE_AI_DELEGATION_STATES = new Set([
  'waiting-usage-limit',
  'waiting-rate-limit',
  'waiting-model-capacity',
  'waiting-document-work',
  'waiting-workspace',
  'waiting-integration-clean',
  'starting',
  'waiting-resource',
  'running',
  'resuming',
  'waiting-child-resume',
  'recovery-required',
  'waiting-integration',
  'integration-starting',
  'integration-waiting-resource',
  'integration-running',
  'integration-waiting-resume',
  'integration-recovery-required',
  'waiting-parent',
  'waking-parent',
])

const CHILD_WORKSPACE_RECONCILIATION_STATES = new Set([
  'starting',
  'waiting-resource',
  'running',
  'waiting-child-resume',
])

const EXPLICIT_COMPLETION_CANDIDATE_STATES = new Set([
  'starting',
  'waiting-resource',
  'running',
  'waiting-child-resume',
])

export function aiDelegationWaitPollDue(entry, delegation, now = Date.now()) {
  if (!entry || entry.state !== delegation?.state) return true
  return Number(entry.nextAt ?? 0) <= now
}

export function nextAiDelegationWaitPoll(entry, delegation, now = Date.now()) {
  const state = String(delegation?.state ?? '')
  const attempt = entry?.state === state ? Math.max(0, Number(entry.attempt) || 0) : 0
  const delayMs = AI_DELEGATION_WAIT_POLL_DELAYS_MS[
    Math.min(attempt, AI_DELEGATION_WAIT_POLL_DELAYS_MS.length - 1)
  ]
  return {
    state,
    attempt: attempt + 1,
    delayMs,
    nextAt: now + delayMs,
  }
}

export function shouldReconcileAiDelegationChildWorkspace(delegation) {
  return CHILD_WORKSPACE_RECONCILIATION_STATES.has(delegation?.state)
}

function normalizedSelectionOption(value, fallbackId = '') {
  if (value && typeof value === 'object') {
    const id = String(value.id ?? '').trim()
    return id ? { id, label: String(value.label ?? id).trim() || id } : null
  }
  const id = String(fallbackId || value || '').trim()
  return id ? { id, label: id } : null
}

function normalizedSelectionList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value?.id ?? value ?? '').trim()).filter(Boolean))].slice(0, 128)
}

function partialAiDelegationSelectionFromSource(source) {
  if (!source || typeof source !== 'object') return null
  const agent = normalizedSelectionOption(source.agent, source.agentId)
  const model = normalizedSelectionOption(source.model, source.modelId)
  return {
    agent,
    model,
    providerId: String(source.providerId ?? '').trim() || null,
    mode: normalizedSelectionOption(source.mode, source.modeId),
    thoughtLevel: normalizedSelectionOption(source.thoughtLevel, source.thoughtLevelId),
    enabledSkillIds: normalizedSelectionList(source.enabledSkillIds ?? source.skills),
    disabledBuiltinSkillIds: normalizedSelectionList(source.disabledBuiltinSkillIds),
    mcpIds: normalizedSelectionList(source.mcpIds ?? source.mcpServers),
    workspace: String(source.workspace ?? '').trim().slice(0, 4_096) || null,
    // Claude 멀티 계정: 계정이 1개면 비어 있어 기존 선택과 같다.
    claudeAccountId: String(source.claudeAccountId ?? '').trim().slice(0, 120) || null,
  }
}

export function aiDelegationSelectionFromSource(source) {
  const selection = partialAiDelegationSelectionFromSource(source)
  return selection?.agent && selection?.model ? selection : null
}

function sourceDefinesAny(source, keys) {
  return source && typeof source === 'object' && keys.some((key) => Object.hasOwn(source, key))
}

export function mergeAiDelegationSelections(...sources) {
  const entries = sources
    .map((source) => ({ source, selection: partialAiDelegationSelectionFromSource(source) }))
    .filter((entry) => entry.selection)
  if (entries.length === 0) return null

  const agent = entries.find((entry) => entry.selection.agent)?.selection.agent ?? null
  const compatibleEntries = agent
    ? [
        ...entries.filter((entry) => !entry.selection.agent || entry.selection.agent.id === agent.id),
        ...entries.filter((entry) => entry.selection.agent && entry.selection.agent.id !== agent.id),
      ]
    : entries
  const firstValue = (key, candidates = compatibleEntries) =>
    candidates.find((entry) => entry.selection[key])?.selection[key] ?? null
  const firstList = (keys, key) => compatibleEntries
    .find((entry) => sourceDefinesAny(entry.source, keys))?.selection[key]
    ?? compatibleEntries[0].selection[key]
  const merged = {
    agent,
    model: firstValue('model'),
    providerId: firstValue('providerId'),
    mode: firstValue('mode'),
    thoughtLevel: firstValue('thoughtLevel'),
    enabledSkillIds: firstList(['enabledSkillIds', 'skills'], 'enabledSkillIds'),
    disabledBuiltinSkillIds: firstList(['disabledBuiltinSkillIds'], 'disabledBuiltinSkillIds'),
    mcpIds: firstList(['mcpIds', 'mcpServers'], 'mcpIds'),
    workspace: firstValue('workspace', entries),
    // 계정은 같은 AI 종류의 선택에서만 물려받는다.
    claudeAccountId: firstValue('claudeAccountId', compatibleEntries
      .filter((entry) => !entry.selection.agent || entry.selection.agent.id === agent?.id)),
  }
  return merged.agent && merged.model ? merged : null
}

export function isValidAiDelegationId(value) {
  return AI_DELEGATION_ID_PATTERN.test(String(value ?? ''))
}

function normalizedRequestList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))].sort()
}

export function createAiDelegationRequestSignature({
  mapId,
  parentMapId,
  targetRevision,
  parentCardId,
  targetCardId,
  strategy,
  conversationId,
  machineId,
  instruction,
  decisionReason,
  sourceRevision,
  newConversation,
  contextOverride = null,
}) {
  const normalizedMachineId = String(machineId ?? '').trim()
  const requested = newConversation && typeof newConversation === 'object'
    ? {
        agentId: String(newConversation.agentId ?? '').trim() || null,
        modelId: String(newConversation.modelId ?? '').trim() || null,
        providerId: String(newConversation.providerId ?? '').trim() || null,
        modeId: String(newConversation.modeId ?? '').trim() || null,
        thoughtLevelId: String(newConversation.thoughtLevelId ?? '').trim() || null,
        enabledSkillIds: normalizedRequestList(newConversation.enabledSkillIds),
        disabledBuiltinSkillIds: normalizedRequestList(newConversation.disabledBuiltinSkillIds),
        mcpIds: normalizedRequestList(newConversation.mcpIds),
        workspace: String(newConversation.workspace ?? '').trim() || null,
      }
    : null
  return createHash('sha256').update(JSON.stringify({
    mapId,
    ...(parentMapId ? { parentMapId, targetRevision } : {}),
    parentCardId,
    targetCardId,
    strategy,
    conversationId,
    ...(normalizedMachineId ? { machineId: normalizedMachineId } : {}),
    instruction,
    decisionReason,
    sourceRevision,
    newConversation: strategy === 'new' ? requested : null,
    // 예외가 없는 요청의 서명은 이전과 같게 유지한다.
    ...(contextOverride ? { contextOverride: { reasonCode: contextOverride.reasonCode, reason: contextOverride.reason } } : {}),
  })).digest('hex')
}

function normalizedWorkspaceRoot(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

export function aiDelegationWorkspaceLeaseMatches(expected, actual) {
  if (!expected && !actual) return true
  if (!expected || !actual) return false
  // AionCore의 lease 응답 계약은 네 소유권 필드다. branch는 MnP 로컬
  // 세션/Git 검사 대상이며 응답에 포함된 경우에만 추가로 대조한다.
  return ['workspaceId', 'jobId', 'leaseId', 'projectRoot'].every((key) =>
    typeof expected[key] === 'string' && Boolean(expected[key].trim())
      && typeof actual[key] === 'string' && Boolean(actual[key].trim()))
    && expected.workspaceId === actual.workspaceId
    && expected.jobId === actual.jobId
    && expected.leaseId === actual.leaseId
    && normalizedWorkspaceRoot(expected.projectRoot) === normalizedWorkspaceRoot(actual.projectRoot)
    && (!expected.branch || !Object.hasOwn(actual, 'branch') || expected.branch === actual.branch)
    && (!expected.ownership || ['coordinatorId', 'machineId', 'poolId', 'generation'].every((key) => expected.ownership[key] === actual.ownership?.[key]))
}

export function aiDelegationNewWorkspace(requested, parent, target) {
  return [requested?.workspace, parent?.selection?.workspace, parent?.workspace, target?.workspace]
    .map((value) => String(value ?? '').trim()).find(Boolean) ?? null
}

export function failedAiIntegrationRecoveryRuntime(dispatch, recoveredAt = new Date().toISOString()) {
  if (String(dispatch?.state ?? '').trim() !== 'failed') return null
  return {
    state: 'integration-recovery-required',
    integrationStatus: 'failed',
    integrationTurnId: String(dispatch?.turnId ?? '').trim() || null,
    integrationError: String(dispatch?.errorMessage ?? '').trim()
      || '필수 체크포인트 또는 통합 작업이 실패해 명시적인 재개가 필요합니다.',
    recoveryRequiredAt: recoveredAt,
    integrationResource: null,
  }
}

export function aiDelegationSucceeded(delegation) {
  if (delegation?.state === 'waiting-document-work') return false
  if (delegation?.childStatus !== 'completed' || delegation?.workspaceError) return false
  if (delegation?.integrationOperationId && delegation?.integrationStatus !== 'completed') return false
  if (delegation?.workspaceLease?.leaseId && delegation?.workspaceResult?.status !== 'completed') return false
  return true
}

export const AI_DELEGATION_COMPLETION_NOTIFICATION_TYPE = 'ai-delegation-completed'

// 하위 AI 작업 완료 알림은 실제 작업 완료 판정(aiDelegationSucceeded)에 도달한 위임에 한 번만 만든다.
// 문서 조정 대기·실패·사용자 종료·대체된 위임은 완료로 알리지 않는다.
export function aiDelegationCompletionNotice(delegation) {
  if (!delegation?.id || ['failed', 'superseded', 'closed'].includes(delegation.state)) return null
  if (!aiDelegationSucceeded(delegation)) return null
  const dedupeKey = `ai-delegation-completed:${delegation.id}`
  if (delegation.completedNotificationKey === dedupeKey) return null
  const parentCardLabel = String(delegation.parentCardLabel ?? delegation.parentCardId ?? '').trim() || '상위 카드'
  return {
    dedupeKey,
    message: `하위 AI 작업이 완료되었습니다. 상위 카드 "${parentCardLabel}"의 AI 위임 진행 현황에서 결과 전달 상태를 확인할 수 있습니다.`,
  }
}

export function aiDelegationReportResult(delegation) {
  const text = typeof delegation?.childResultSnapshot === 'string'
    ? delegation.childResultSnapshot
    : ''
  if (!text.trim()) return { availability: 'unavailable', text: '', hash: null, turnId: null }

  const hash = createHash('sha256').update(text).digest('hex')
  const storedHash = String(delegation?.childResultHash ?? '').trim()
  const capturedTurnId = String(delegation?.childResultTurnId ?? '').trim()
  const childTurnId = String(delegation?.childTurnId ?? '').trim()
  if ((storedHash && storedHash !== hash) || (capturedTurnId && childTurnId && capturedTurnId !== childTurnId)) {
    return { availability: 'integrity-failed', text: '', hash: null, turnId: null }
  }
  const capture = aiDelegationResultCaptureMetadata(delegation, text)
  return { availability: 'captured', text, hash, turnId: capturedTurnId || childTurnId || null, ...(capture ? { capture } : {}) }
}

export function retryableExternalLimitCategory(error) {
  const message = String(error ?? '').trim()
  if (!message) return null
  if (/usage[_ -]?(limit|cap)|credit[_ -]?limit|insufficient[_ -]?(credits?|quota)|quota.{0,24}(exceed|exhaust)|exceeded.{0,24}quota|(?:hit|reached|exceeded) your (?:weekly |daily |session )?limit|out of (?:extra )?usage|사용량.{0,12}(제한|한도|초과|소진)|크레딧.{0,12}(부족|소진)/iu.test(message)) {
    return 'usage-limit'
  }
  if (/rate.?limit|too many requests|요청.{0,12}(제한|한도|초과)/iu.test(message)) return 'rate-limit'
  if (/(?:selected\s+)?model.{0,40}(?:at|over)\s+capacity|model.{0,40}capacity.{0,40}(?:unavailable|exhausted|full)|모델.{0,20}(?:용량|수용량).{0,20}(?:부족|초과|가득|없|대기)/iu.test(message)) {
    return 'model-capacity'
  }
  return null
}

export function retryableAiExecutionFailureCategory(error) {
  if (/^Internal error: Database error: error returned from database: \(code: 1\) cannot start a transaction within a transaction$/iu.test(String(error ?? '').trim())) return 'dispatch-database-transient'
  return retryableExternalLimitCategory(error)
    ?? (/^stream disconnected before completion(?::|$)/iu.test(String(error ?? '').trim()) ? 'upstream-interrupted' : null)
}

export function aiDelegationDatabaseDispatchRejected(dispatch, conversationId, operationId) {
  return Boolean(conversationId && operationId && dispatch?.operationId === operationId
    && dispatch.conversationId === conversationId && dispatch.state === 'failed' && !dispatch.turnId
    && retryableAiExecutionFailureCategory(dispatch.errorMessage) === 'dispatch-database-transient')
}

export function aiDelegationDatabaseRecoveryCandidate(delegation) {
  const result = delegation?.workspaceResult, lease = delegation?.workspaceLease
  return Boolean(!delegation?.childTurnId && delegation?.childOperationId && delegation?.childStatus === 'failed'
    && result?.status === 'failed-clean' && result.childStatus === 'failed' && !result.integratedCommit && !result.integrationBranch
    && result.headCommit === lease?.baseCommit && !result.unmergedFiles?.length
    && retryableAiExecutionFailureCategory(result.childError) === 'dispatch-database-transient'
    && ['workspaceId', 'jobId', 'leaseId', 'branch', 'baseCommit'].every(key => lease?.[key] && result[key] === lease[key])
    && result.mapId === delegation.mapId && result.cardId === delegation.targetCardId && result.conversationId === delegation.targetConversationId)
}

export function assertAiDelegationDatabaseRejection(delegation, dispatch, storedLease) {
  if (!aiDelegationDatabaseRecoveryCandidate(delegation)
    || !aiDelegationDatabaseDispatchRejected(dispatch, delegation.targetConversationId, delegation.childOperationId)
    || dispatch.errorMessage !== delegation.workspaceResult.childError
    || !aiDelegationWorkspaceLeaseMatches(delegation.workspaceLease, dispatch.workspaceLease)
    || !aiDelegationWorkspaceLeaseMatches(delegation.workspaceLease, storedLease)
    || storedLease?.mapId !== delegation.mapId || storedLease.cardId !== delegation.targetCardId || storedLease.conversationId !== delegation.targetConversationId
    || !['cancelled', 'failed-clean'].includes(storedLease.status)
    || JSON.stringify(storedLease.result) !== JSON.stringify(delegation.workspaceResult)
    || storedLease.checkpoints?.length) throw Object.assign(new Error('원 DB 접수 실패·실행 턴 없음·무변경 반환을 확인하지 못했습니다.'), { status: 409, code: 'AI_DELEGATION_DATABASE_REJECTION_UNCONFIRMED' })
}

// busy는 새 실행이 시작되지 않은 접수 거절이다. 실행 턴이 있으면 이 예외를 적용하지 않는다.
export function aiDelegationBusyDispatchRejected(dispatch, conversationId, operationId) {
  return Boolean(conversationId && operationId && dispatch?.operationId === operationId
    && dispatch.conversationId === conversationId && dispatch.state === 'failed' && !dispatch.turnId
    && dispatch.errorMessage === `Conversation is busy: conversation ${conversationId} is already running`)
}

export function aiDelegationBusyRecoveryOperation(delegation) {
  if (delegation?.resultCorrection) return null
  const rejection = delegation?.recoveryDispatchRejection
  if (delegation?.state === 'recovery-required' && rejection && delegation.recoveryOperationId === rejection.operationId
    && aiDelegationBusyDispatchRejected(rejection, delegation.targetConversationId, rejection.operationId)) return rejection.operationId
  // 이전 버전은 거절된 복구 요청을 child operation으로 바꾼 뒤 worker를 격리했다.
  const result = delegation?.workspaceResult
  const operationId = delegation?.recoveryOperationId
  if (delegation?.state !== 'failed' || !operationId || delegation.childOperationId !== operationId
    || !Number.isInteger(delegation.recoveryAttempt) || delegation.recoveryAttempt < 1 || delegation.childTurnId || result?.status !== 'quarantined'
    || result.childStatus !== 'failed' || result.integratedCommit || result.integrationBranch
    || result.unmergedFiles?.length || !['workspaceId', 'jobId', 'leaseId', 'branch', 'baseCommit'].every(key =>
      typeof delegation.workspaceLease?.[key] === 'string' && Boolean(delegation.workspaceLease[key])
      && result[key] === delegation.workspaceLease[key])
    || result.mapId !== delegation.mapId || result.cardId !== delegation.targetCardId
    || result.conversationId !== delegation.targetConversationId) return null
  return aiDelegationBusyDispatchRejected({ operationId, conversationId: delegation.targetConversationId,
    state: 'failed', errorMessage: result.childError }, delegation.targetConversationId, operationId) ? operationId : null
}

export function rejectedAiDelegationRecoveryPatch(delegation, pending, dispatch, at = new Date().toISOString()) {
  if (!aiDelegationBusyDispatchRejected(dispatch, delegation.targetConversationId, pending.operationId)
    || !aiDelegationWorkspaceLeaseMatches(pending.workspaceLease ?? null, dispatch.workspaceLease ?? null)) {
    throw new Error('복구 접수 거절의 실행·대화·작업공간을 확인하지 못했습니다.')
  }
  const rejection = { operationId: pending.operationId, conversationId: dispatch.conversationId,
    state: dispatch.state, errorMessage: dispatch.errorMessage, turnId: null, executionStarted: false, rejectedAt: at }
  return { state: pending.integrationRecovery ? 'integration-recovery-required' : 'recovery-required',
    pendingRecovery: null, recoveryWorkspaceLease: null, workspaceLease: pending.workspaceLease,
    recoveryAttempt: pending.attempt, recoveryOperationId: pending.operationId,
    recoverySourceState: pending.sourceState, recoveryRequiredAt: at, completedAt: null,
    recoveryDispatchError: dispatch.errorMessage, recoveryDispatchRejection: rejection,
    recoveryDispatchRejections: [...(delegation.recoveryDispatchRejections ?? []), rejection].slice(-20) }
}

export function localChangesIntegrationCommits(result) {
  if (result?.status !== 'quarantined' || result.childStatus !== 'completed'
    || result.integratedCommit || !result.integrationBranch || !result.integrationBaseCommit
    || result.conflictRound || result.unmergedFiles?.length) return null
  const error = String(result.error ?? '')
  const command = error.match(/^Command failed: git(?: -c core\.autocrlf=(?:false|input))? cherry-pick((?: [a-f0-9]{40})+)\r?\n/iu)
  if (!command || !/local changes[^\n]*would be overwritten by (?:cherry-pick|merge)/iu.test(error)) return null
  return command[1].trim().split(/\s+/)
}

export function integrationGitLockFailure(result) {
  if (result?.status !== 'quarantined' || result.childStatus !== 'completed'
    || result.integratedCommit || !result.integrationBranch || !result.integrationBaseCommit
    || result.conflictRound || result.unmergedFiles?.length) return null
  const error = String(result.error ?? '')
  const command = error.match(/^Command failed: git merge --ff-only(?: --no-overwrite-ignore)? ([a-f0-9]{40})\r?\n/iu)
  const lock = error.match(/^(?:error|fatal): Unable to create '([^'\r\n]+[/\\]index\.lock)': File exists\.[\t ]*\r?$/imu)
  if (!command || !lock || (result.integrationHeadCommit && result.integrationHeadCommit !== command[1])) return null
  return { candidateCommit: command[1], lockPath: lock[1] }
}

export function integrationHeadChangedFailure(result) {
  if (result?.status !== 'quarantined' || result.childStatus !== 'completed' || result.integratedCommit
    || !result.integrationBranch || result.conflictRound || result.unmergedFiles?.length
    || !['통합 직전에 통합 작업공간의 HEAD가 변경되었습니다.', '충돌 해결 중 통합 작업공간의 HEAD가 변경되었습니다.'].includes(String(result.error ?? '').trim())
    || !['headCommit', 'integrationBaseCommit', 'integrationHeadCommit'].every(key => /^[a-f0-9]{40}$/u.test(String(result[key] ?? '')))) return null
  return { candidateCommit: result.integrationHeadCommit }
}

export const integrationCandidateDirtyReasonCode = 'integration-candidate-worktree-dirty'

export function integrationCandidateWorktreeFailure(result) {
  if (result?.status !== 'quarantined' || result.childStatus !== 'completed' || result.childError
    || result.integratedCommit || !result.integrationBranch || result.conflictRound || result.unmergedFiles?.length
    || !['headCommit', 'integrationBaseCommit'].every(key => /^[a-f0-9]{40}$/u.test(String(result[key] ?? '')))) return null
  const failure = result.integrationFailure
  const legacy = !failure && result.error === '통합 브랜치에 커밋되지 않은 변경이 남아 있습니다.'
  if (!legacy && (failure?.reasonCode !== integrationCandidateDirtyReasonCode
    || failure.phase !== 'candidate-worktree' || failure.workspaceId !== result.workspaceId
    || failure.branch !== result.integrationBranch)) return null
  const candidateCommit = result.integrationHeadCommit ?? failure?.candidateCommit ?? null
  if ((candidateCommit && !/^[a-f0-9]{40}$/u.test(candidateCommit))
    || (!legacy && (!candidateCommit || failure.candidateCommit !== candidateCommit))) return null
  // 구버전은 후보 HEAD를 저장하기 전에 실패했다. 복구 시 현재 HEAD를 그대로 신뢰하지 않고
  // 모든 원 체크포인트를 적용한 tree와 각 부모 커밋을 공통 검증기로 대조한다.
  return { candidateCommit }
}

export function aiDelegationRecoveryAvailability(delegation) {
  if (integrationRecoveryPending(delegation)) return { failurePhase: 'integration', failureCategory: 'integration-recovery-pending',
    recoveryAvailable: false, recommendedAction: 'refresh-status', recoveryTool: 'mindnprogress_refresh_ai_delegation' }
  if (delegation?.resultCorrection && (['completed', 'superseded', 'closed'].includes(delegation.state)
    || aiDelegationSucceeded(delegation))) return null
  if (delegation?.resultCorrection?.phase === 'held') return { failurePhase: 'integration', failureCategory: 'integration-result-correction',
    recoveryAvailable: false, recommendedAction: 'inspect-failure' }
  if (delegation?.pendingRecovery) return { failurePhase: 'dispatch', failureCategory: 'unknown', recoveryAvailable: false, recommendedAction: 'refresh-status', recoveryTool: 'mindnprogress_refresh_ai_delegation' }
  if (!delegation?.resultCorrection && aiDelegationBusyRecoveryOperation(delegation)) {
    return { failurePhase: 'dispatch', failureCategory: 'recovery-dispatch-busy', recoveryAvailable: true,
      recommendedAction: 'resume-existing', recoveryTool: 'mindnprogress_recover_ai_delegation' }
  }
  if (delegation?.resultCorrection && (delegation.resultCorrection.phase === 'preparing'
    || ['recovery-required', 'waiting-child-resume'].includes(delegation.state))) {
    return { failurePhase: 'integration', failureCategory: 'integration-result-correction', recoveryAvailable: true,
      recommendedAction: 'correct-integration-result', recoveryTool: 'mindnprogress_recover_ai_delegation' }
  }
  if (delegation?.state === 'waiting-integration') {
    const result = delegation.workspaceResult
    if (!delegation.resultCorrection && delegation.workspaceLease?.leaseId && result?.status === 'waiting-integration'
      && result.childStatus === 'completed' && !result.integratedCommit && result.integrationHeadCommit
      && result.reasonCode === 'integration-untracked-collision') {
      return { failurePhase: 'integration', failureCategory: 'integration-result-correction', recoveryAvailable: true,
        recommendedAction: 'correct-integration-result', recoveryTool: 'mindnprogress_recover_ai_delegation' }
    }
    return null
  }
  // 완료 결과의 통합 실패는 상위 보고가 끝나기 전에도 명시적으로 재시도할 수 있다.
  // 보고 상태만으로 허용하지 않고 아래의 기존 실패 증거·lease 검증을 그대로 사용한다.
  const retryCompletedIntegration = delegation?.state === 'failed'
    || (!delegation?.resultCorrection && ['waiting-parent', 'waking-parent', 'parent-wake-failed'].includes(delegation?.state)
      && delegation.childStatus === 'completed')
  if (retryCompletedIntegration && delegation.workspaceLease?.leaseId
    && localChangesIntegrationCommits(delegation.workspaceResult)) {
    return { failurePhase: 'integration', failureCategory: 'workspace-local-changes', recoveryAvailable: true, recommendedAction: 'retry-integration', recoveryTool: 'mindnprogress_recover_ai_delegation' }
  }
  if (retryCompletedIntegration && delegation.workspaceLease?.leaseId
    && integrationGitLockFailure(delegation.workspaceResult)) {
    return { failurePhase: 'integration', failureCategory: 'integration-git-lock', recoveryAvailable: true,
      recommendedAction: 'retry-integration', recoveryTool: 'mindnprogress_recover_ai_delegation' }
  }
  if (retryCompletedIntegration && delegation.workspaceLease?.leaseId
    && integrationHeadChangedFailure(delegation.workspaceResult)) {
    return { failurePhase: 'integration', failureCategory: 'integration-head-changed', recoveryAvailable: true,
      recommendedAction: 'retry-integration', recoveryTool: 'mindnprogress_recover_ai_delegation' }
  }
  if (retryCompletedIntegration && delegation.workspaceLease?.leaseId
    && integrationCandidateWorktreeFailure(delegation.workspaceResult)) {
    return { failurePhase: 'integration', failureCategory: integrationCandidateDirtyReasonCode, recoveryAvailable: true,
      recommendedAction: 'retry-integration', recoveryTool: 'mindnprogress_recover_ai_delegation' }
  }
  if (!['parent-wake-failed', 'failed', 'waiting-usage-limit', 'waiting-rate-limit', 'waiting-model-capacity', 'recovery-required', 'integration-recovery-required', 'waiting-child-resume'].includes(delegation?.state)) return null
  if (['recovery-required', 'integration-recovery-required', 'waiting-child-resume'].includes(delegation.state)) {
    return { failurePhase: 'child', failureCategory: delegation.state === 'waiting-child-resume' ? 'user-stop' : 'restart', recoveryAvailable: true, recommendedAction: 'resume-existing', recoveryTool: 'mindnprogress_recover_ai_delegation' }
  }
  if (aiDelegationSucceeded(delegation)) {
    return {
      failurePhase: 'parent-wake',
      failureCategory: 'parent-notification',
      recoveryAvailable: false,
      recommendedAction: 'review-existing-result',
      reportRetryAvailable: delegation.state === 'parent-wake-failed',
    }
  }

  const childFailure = delegation?.workspaceResult?.childError ?? delegation?.childError
  const failureCategory = retryableAiExecutionFailureCategory(childFailure)
  const hasRecoverableWorkspace = Boolean(
    delegation?.workspaceLease?.leaseId
    && ['quarantined', 'failed-clean'].includes(delegation?.workspaceResult?.status)
    && delegation?.workspaceResult?.childStatus === 'failed',
  )
  const canResume = failureCategory === 'dispatch-database-transient' ? aiDelegationDatabaseRecoveryCandidate(delegation)
    : Boolean(failureCategory && (hasRecoverableWorkspace || !delegation?.workspaceLease?.leaseId))
  return {
    failurePhase: failureCategory === 'dispatch-database-transient' ? 'dispatch' : 'child',
    failureCategory: failureCategory ?? 'non-retryable',
    recoveryAvailable: canResume,
    recommendedAction: canResume
      ? 'resume-existing'
      : 'inspect-failure',
    ...(canResume
      ? { recoveryTool: 'mindnprogress_recover_ai_delegation' }
      : {}),
  }
}

export function aiDelegationLimitState(delegation) {
  if (aiDelegationSucceeded(delegation) || delegation?.childStatus !== 'failed') return null
  // 작업공간 종료 결과가 실제 하위 실행 오류를 보존하고, 상위 childError에는
  // "통합하지 않았습니다" 같은 일반 요약이 들어갈 수 있으므로 원인을 먼저 읽는다.
  const category = retryableExternalLimitCategory(delegation.workspaceResult?.childError ?? delegation.childError)
  return category === 'usage-limit' ? 'waiting-usage-limit'
    : category === 'rate-limit' ? 'waiting-rate-limit'
      : category === 'model-capacity' ? 'waiting-model-capacity'
        : null
}

export function aiDelegationAttemptHistory(delegation, reason, at = new Date().toISOString()) {
  // 직전 시도의 결과와 전달 실패를 보존한다. 현재 결과에는 새 시도의 결과만 표시한다.
  return [...(delegation.attemptHistory ?? []), {
    at, reason, state: delegation.state, operationId: delegation.childOperationId,
    childTurnId: delegation.childTurnId, childStatus: delegation.childStatus,
    childError: delegation.childError ?? null, parentError: delegation.parentError ?? null,
    workspaceLease: delegation.workspaceLease ?? null, workspaceResult: delegation.workspaceResult ?? null,
    parentDispatchState: delegation.parentDispatchState, wakeOperationId: delegation.wakeOperationId,
    result: delegation.childResultSnapshot ?? '', resultCapturedAt: delegation.childResultCapturedAt ?? null,
    resultHash: delegation.childResultHash ?? null, resultTurnId: delegation.childResultTurnId ?? null,
    reportPayloadHash: delegation.reportPayloadHash ?? null,
    reportResultAvailability: delegation.reportResultAvailability ?? null,
    reportResultHash: delegation.reportResultHash ?? null,
    reportResultTurnId: delegation.reportResultTurnId ?? null,
    reportPreparedAt: delegation.reportPreparedAt ?? null,
    reportReceipt: delegation.reportReceipt ?? null,
    reportArchive: delegation.reportArchive ?? null,
    parentWakeRetry: delegation.parentWakeRetry ?? null,
    parentWakeFailures: delegation.parentWakeFailures ?? [],
    parentRuntimeObservation: delegation.parentRuntimeObservation ?? null,
  }]
}

export function aiDelegationWorkPending(delegation) {
  // 업무 성공과 상위 결과 전달을 구분한다. 보고 실패만으로 하위 업무를 미완료 처리하지 않는다.
  return !aiDelegationSucceeded(delegation) && !aiDelegationIsTerminal(delegation)
}

export function aiDelegationIsTerminal(delegation) {
  if (integrationRecoveryPending(delegation)) return false
  return AI_DELEGATION_TERMINAL_STATES.has(String(delegation?.state ?? ''))
}

export function aiDelegationClosureAvailability(delegation) {
  if (delegation?.state === 'failed' && !delegation.groupId && !delegation.pendingRecovery
    && !integrationRecoveryPending(delegation) && !delegation.resultCorrection && !delegation.workspaceLease?.ownership
    && delegation.workspaceLease?.leaseId && localChangesIntegrationCommits(delegation.workspaceResult)) {
    return { closeAvailable: true, reason: 'preserve-integration-result', workspaceReleaseRequired: true }
  }
  if (!delegation || aiDelegationIsTerminal(delegation) || delegation.pendingRecovery || integrationRecoveryPending(delegation)) return null
  if (delegation.groupId) return { closeAvailable: false, reason: 'group-managed' }
  if (delegation.state === 'parent-wake-failed' && aiDelegationSucceeded(delegation)) {
    return { closeAvailable: true, reason: 'completed-child-report-abandonment' }
  }
  if (['waiting-usage-limit', 'waiting-rate-limit', 'waiting-model-capacity'].includes(delegation.state)) {
    const workspaceSafe = !delegation.workspaceLease?.leaseId
      || ['failed-clean', 'cancelled'].includes(delegation.workspaceResult?.status)
    return {
      closeAvailable: workspaceSafe,
      reason: workspaceSafe ? 'failed-child-no-preserved-changes' : 'workspace-changes-preserved',
    }
  }
  return { closeAvailable: false, reason: 'execution-or-recovery-still-active' }
}

export function preservedIntegrationReleaseClosure(delegation, lease) {
  const result = lease?.result
  const receipt = result?.preservedRelease
  if (delegation?.state !== 'failed' || delegation.pendingRecovery || integrationRecoveryPending(delegation)
    || !aiDelegationClosureAvailability(delegation)?.workspaceReleaseRequired
    || lease?.status !== 'cancelled' || result?.status !== 'released-preserved' || receipt?.phase !== 'released'
    || !receipt.releasedAt || !receipt.reason || result.integratedCommit
    || lease.leaseId !== delegation.workspaceLease?.leaseId || result.leaseId !== lease.leaseId
    || lease.jobId !== result.jobId || lease.mapId !== delegation.mapId || result.mapId !== delegation.mapId
    || lease.cardId !== delegation.targetCardId || result.cardId !== delegation.targetCardId
    || lease.conversationId !== delegation.targetConversationId || result.conversationId !== delegation.targetConversationId
    || result.previousResult?.headCommit !== delegation.workspaceResult?.headCommit
    || receipt.sourceHead !== delegation.workspaceResult?.headCommit) return null
  return { state: 'closed', workspaceResult: result, workspaceReleasedAt: receipt.releasedAt,
    closedAt: receipt.releasedAt, closedByUserId: receipt.approvedByUserId ?? null,
    closedByOperator: receipt.approvedByOperator ?? null, closureSourceState: delegation.state,
    closureReason: 'no-longer-needed', closureNote: receipt.reason,
    closureSource: 'workspace-pool-preserved-release', reportApprovalRequired: false, reportCancelledAt: receipt.releasedAt }
}

export function aiDelegationCanBeSupersededBy(delegation, replacement) {
  const failedCleanLimit = ['waiting-usage-limit', 'waiting-rate-limit', 'waiting-model-capacity'].includes(delegation?.state)
  const failedCleanDatabaseDispatch = ['failed', 'parent-wake-failed'].includes(delegation?.state) && aiDelegationDatabaseRecoveryCandidate(delegation)
  const completedReportFailure = !delegation?.groupId
    && delegation?.state === 'parent-wake-failed'
    && aiDelegationSucceeded(delegation)
  if (integrationRecoveryPending(delegation) || (!failedCleanLimit && !failedCleanDatabaseDispatch && !completedReportFailure)) return false
  if (!replacement || replacement.id === delegation.id || replacement.state !== 'completed' || !aiDelegationSucceeded(replacement)) return false
  if ((replacement.groupId ?? null) !== (delegation.groupId ?? null)) return false
  if (replacement.mapId !== delegation.mapId
      || (replacement.parentMapId ?? replacement.mapId) !== (delegation.parentMapId ?? delegation.mapId)
      || replacement.parentCardId !== delegation.parentCardId
      || replacement.targetCardId !== delegation.targetCardId) return false
  if (String(replacement.createdAt ?? '') <= String(delegation.createdAt ?? '')) return false
  if (failedCleanLimit && delegation.workspaceLease?.leaseId
      && !['failed-clean', 'cancelled'].includes(delegation.workspaceResult?.status)) return false
  return true
}

export function completedAiDelegationReplacement(delegation, delegations) {
  return [...delegations]
    .filter((candidate) => aiDelegationCanBeSupersededBy(delegation, candidate))
    .sort((first, second) => String(second.createdAt ?? '').localeCompare(String(first.createdAt ?? '')))[0]
    ?? null
}

export function aiDelegationDisplayState(delegation) {
  if (integrationRecoveryPending(delegation)) return 'integration-recovery-checking'
  if (delegation.pendingRecovery) return 'recovery-dispatch-pending'
  return aiDelegationLimitState(delegation) ?? delegation.state
}

export function aiDelegationStateAfterParentWake(delegation, parentDispatchState) {
  if (parentDispatchState !== 'completed') return 'parent-wake-failed'
  return aiDelegationSucceeded(delegation) ? 'completed' : 'failed'
}

export function aiDelegationBlocksResume(delegation, {
  parentConversationId,
  parentTurnId,
} = {}) {
  const sameCompletedParentWake = delegation?.state === 'waking-parent'
    && aiDelegationSucceeded(delegation)
    && String(parentConversationId ?? '').trim()
    && delegation.parentConversationId === parentConversationId
    && String(parentTurnId ?? '').trim()
    && delegation.parentTurnId === parentTurnId
  return !sameCompletedParentWake
}

export function activeAiDelegationsForConversation(delegations, {
  mapId,
  targetCardId,
  targetConversationId,
  excludeId = null,
} = {}) {
  return [...delegations]
    .filter((delegation) => delegation?.id !== excludeId
      && delegation?.mapId === mapId
      && delegation?.targetCardId === targetCardId
      && delegation?.targetConversationId === targetConversationId
      && (ACTIVE_AI_DELEGATION_STATES.has(delegation?.state) || integrationRecoveryPending(delegation)))
    .sort((first, second) => String(second.createdAt ?? '').localeCompare(String(first.createdAt ?? '')))
}

export function explicitCompletionAiDelegationsForConversation(delegations, {
  mapId,
  targetCardId,
  targetConversationId,
} = {}) {
  return [...delegations]
    .filter((delegation) => delegation?.mapId === mapId
      && delegation?.targetCardId === targetCardId
      && delegation?.targetConversationId === targetConversationId
      && EXPLICIT_COMPLETION_CANDIDATE_STATES.has(delegation?.state)
      && String(delegation?.childOperationId ?? '').trim())
    .sort((first, second) => String(second.updatedAt ?? second.createdAt ?? '')
      .localeCompare(String(first.updatedAt ?? first.createdAt ?? '')))
}

export function formatAiConversationTitle(documentTitle, cardTitle, options = {}) {
  return aiConversationTitle({ ...options, documentTitle, cardTitle })
}

export function initialAiDelegationRuntime(dispatch, completedAt = new Date().toISOString()) {
  const state = String(dispatch?.state ?? '').trim()
  const childTurnId = String(dispatch?.turnId ?? '').trim() || null
  const resource = dispatch?.resource && typeof dispatch.resource === 'object'
    ? dispatch.resource
    : null
  if (state === 'completed' || state === 'failed') {
    return {
      state: aiDelegationLimitState({ childStatus: state, childError: dispatch?.errorMessage }) ?? 'waiting-parent',
      childStatus: state,
      childTurnId,
      childError: String(dispatch?.errorMessage ?? '').trim() || null,
      childCompletedAt: completedAt,
    }
  }
  if (state === 'waiting_resume') {
    return {
      state: 'waiting-child-resume',
      childStatus: 'interrupted',
      childTurnId,
      childError: String(dispatch?.errorMessage ?? '').trim() || null,
      childInterruptedAt: completedAt,
    }
  }
  if (state === 'recovery_required') {
    return {
      state: 'recovery-required',
      childStatus: 'interrupted-by-restart',
      childTurnId,
      childError: String(dispatch?.errorMessage ?? '').trim() || 'interrupted_by_restart',
      recoveryRequiredAt: completedAt,
    }
  }
  if (state === 'waiting_resource') {
    return {
      state: 'waiting-resource',
      childTurnId,
      resource,
    }
  }
  return {
    state: state === 'running' ? 'running' : 'starting',
    childTurnId,
    ...(resource ? { resource } : {}),
  }
}
