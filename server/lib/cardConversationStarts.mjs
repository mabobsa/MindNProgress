import { createHash } from 'node:crypto'
import path from 'node:path'
import { MNP_CONTEXT_BOOTSTRAP_INSTRUCTION } from '../../src/utils/aiContextInstructions.mjs'
import { AI_EXECUTION_APPROVAL_INSTRUCTION } from '../../src/utils/aiApprovalInstructions.mjs'
import { aiDelegationResumeModelMatches } from './aiDelegationPolicy.mjs'

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
export const CARD_CONVERSATION_START_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,95}$/
const terminal = new Set(['ready', 'failed'])
const rejectedBeforeCreation = new Set(['EXTERNAL_DISPATCH_INVALID', 'EXTERNAL_DISPATCH_ACTOR_NOT_FOUND', 'EXTERNAL_DISPATCH_CAPACITY_EXHAUSTED'])
export const cardConversationStartHash = (value) => createHash('sha256').update(value).digest('hex')
export const cardConversationStartId = (userId, mapId, cardId, requestId) =>
  `ccs:${cardConversationStartHash(JSON.stringify([userId, mapId, cardId, requestId]))}`

export function isCardConversationWorkerWorkspace(workspace, roots) {
  const identity = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null
    const raw = value.trim().replaceAll('\\', '/')
    const normalized = path.posix.normalize(raw).replace(/\/$/, '')
    return /^[a-z]:\//i.test(raw) || raw.startsWith('//') ? normalized.toLowerCase() : normalized
  }
  const candidate = identity(workspace)
  return Boolean(candidate && roots.some((value) => {
    const root = identity(value)
    return root && (candidate === root || candidate.startsWith(`${root}/`))
  }))
}

export function cardConversationStartError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status, cardConversationStartError: true })
}

export function normalizeCardConversationStart(body) {
  const fail = () => { throw cardConversationStartError('CARD_CONVERSATION_START_INVALID', '대화 인계 요청 값이 올바르지 않습니다.', 400) }
  const text = (value, max, required = false) => {
    if (value === undefined && !required) return undefined
    if (typeof value !== 'string' || !value.trim() || value.length > max) return fail()
    return value.trim()
  }
  const requestId = text(body?.requestId, 96, true)
  if (!CARD_CONVERSATION_START_REQUEST_ID.test(requestId)) fail()
  if (body.acceptHandoff !== undefined && typeof body.acceptHandoff !== 'boolean') fail()
  if (body.resultOnly === true) return { requestId, resultOnly: true, ...(body.acceptHandoff ? { acceptHandoff: true } : {}) }
  if (body.acceptHandoff) fail()
  if (body.resultOnly !== undefined && body.resultOnly !== false) fail()
  const predecessorConversationId = text(body.predecessorConversationId, 120, true)
  if (!identifier.test(predecessorConversationId)) fail()
  const input = body.newConversation
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail()
  const newConversation = {}
  // claudeAccountId는 Claude 새 대화의 계정 선택이다. 생략하면 서버가 호출한 현재 대화와 같은 계정을 쓴다.
  for (const key of ['agentId', 'modelId', 'modeId', 'thoughtLevelId', 'workspace', 'claudeAccountId']) {
    const value = text(input[key], key === 'workspace' ? 4096 : key === 'claudeAccountId' ? 120 : 512, ['agentId', 'modelId'].includes(key))
    if (value !== undefined) newConversation[key] = value
  }
  for (const key of ['enabledSkillIds', 'disabledBuiltinSkillIds', 'mcpIds']) {
    if (input[key] === undefined) continue
    if (!Array.isArray(input[key]) || input[key].length > 128) fail()
    newConversation[key] = [...new Set(input[key].map((value) => text(value, 512, true)))].sort()
  }
  const machineId = text(body.machineId, 64)
  if (machineId && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(machineId)) fail()
  if (typeof body.initialMessage !== 'string' || !body.initialMessage.trim() || body.initialMessage.length > 100_000) fail()
  return { requestId, predecessorConversationId, newConversation, ...(machineId ? { machineId } : {}),
    initialMessage: body.initialMessage, decisionReason: text(body.decisionReason, 1000, true),
    approvalEvidence: text(body.approvalEvidence, 10_000, true) }
}

export function buildCardConversationStartPrompt(record, token) {
  const acceptance = record.acceptanceRequired ? `\n\n## 루트 담당 인수 확인\n\n이번 첫 턴은 인계문과 get_context·그룹 기준을 읽고 인수 가능 여부를 확인하는 작업만 수행하세요. 아직 담당 전환 전이며 카드·코드 변경, 위임, 외부 보고를 하지 마세요. 인수할 수 있으면 mindnprogress_start_card_conversation에 mapId=${record.mapId}, cardId=${record.cardId}, requestId=${record.requestId}, resultOnly=true, acceptHandoff=true를 보내세요. 인수할 수 없으면 해당 호출 없이 부족한 사항을 답변하세요. 확인 후 턴을 종료하고 서버가 보내는 다음 업무 지시를 기다리세요. 기존 사용자 대기·중지 지시는 인계 후에도 유효합니다.` : ''
  return `# MindNProgress 카드 대화 인계\n\n${MNP_CONTEXT_BOOTSTRAP_INSTRUCTION}\n\n- mapId: \`${record.mapId}\`\n- cardId: \`${record.cardId}\`\n- editorId: \`${record.startedBy}\`\n- attributionToken: \`${token}\`\n- 이전 대화: \`${record.predecessorConversationId}\`\n\n${AI_EXECUTION_APPROVAL_INSTRUCTION}\n\n이 대화는 같은 카드의 후속 대화입니다. 하위 카드 위임이나 worker 배정이 아닙니다. 최초 get_context의 역할·그룹 규칙을 따르고, 기존 승인 범위를 확대하지 마세요. 이전 대화의 종료, 진행 중인 위임의 소유권 이전과 외부 회신 주소 변경은 이 요청에 포함되지 않습니다.${acceptance}\n\n## 사용자 요청 근거\n\n${record.input.approvalEvidence}\n\n## 첫 메시지 원문\n\n${record.input.initialMessage}`
}

export function cardConversationStartView(record, repeated = false) {
  const ready = record.state === 'ready'
  return {
    requestId: record.requestId, mapId: record.mapId, cardId: record.cardId, state: record.state,
    conversationId: record.conversationId ?? null, predecessorConversationId: record.predecessorConversationId,
    machineId: record.machineId, repeated, reasonCode: record.reasonCode ?? null,
    message: ready ? '새 대화의 실행 시작과 카드 대표 연결을 확인했습니다. 업무 완료를 의미하지 않습니다.'
      : record.state === 'linked' ? '첫 메시지 실행과 대표 연결은 확인했으며 실제 실행 설정을 확인 중입니다.'
        : record.state === 'awaiting-acceptance' ? '후속 대화의 인수 확인을 기다리고 있습니다. 기존 담당은 유지합니다.'
        : record.state === 'failed' ? '대화 생성 전 요청이 거절됐습니다. 사유를 해결한 뒤 새 requestId로 요청하세요.'
        : record.state === 'recovery-required'
          ? '인계 처리가 완료되지 않았습니다. 같은 requestId로 결과를 확인하세요. 이전 대화는 중지하지 않았습니다.'
          : '대화 인계 요청을 처리 중입니다. 접수 상태는 대화 생성이나 메시지 전달 완료가 아닙니다.',
    delivery: { state: record.deliveryState ?? 'not-started', turnId: record.turnId ?? null, operationId: record.id },
    linked: Boolean(record.linkedAt), linkedAt: record.linkedAt ?? null,
    ...(record.acceptanceRequired ? { acceptanceRequired: true, acceptedAt: record.acceptedAt ?? null } : {}),
    requestedConfig: record.requestedConfig ?? null, runtimeConfig: record.runtimeConfig ?? null,
    initialMessage: { length: record.input.initialMessage.length, sha256: cardConversationStartHash(record.input.initialMessage) },
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(!ready ? { nextStep: record.state === 'failed' ? 'reasonCode의 거절 사유를 해결한 뒤 새 requestId로 요청하세요.'
      : '같은 도구에 mapId, cardId, requestId, resultOnly=true를 전달해 확인·복구하세요. 새 requestId로 중복 생성하지 마세요.' } : {}),
  }
}

// 원격 호출은 mutate 밖에서만 수행한다. 생성 직전 의도와 불변 payload를 저장하며,
// 결과가 불명확하면 operationId 조회만 수행해 중복 생성·전송을 피한다.
export function createCardConversationStarts({ records, mutate, persist, validate, prepare, bind, promote, enrich = (record) => record,
  call, background, now = Date.now, log = () => {} }) {
  const active = new Map()
  const logged = new Map()
  const timestamp = () => new Date(now()).toISOString()
  const save = async (record, patch) => {
    const next = { ...record, ...patch, updatedAt: timestamp() }
    records.set(record.id, next)
    await persist()
    return next
  }
  const update = (id, patch) => mutate(records.get(id)?.mapId, async () => {
    const record = records.get(id)
    if (!record) throw cardConversationStartError('CARD_CONVERSATION_START_NOT_FOUND', '인계 요청을 찾을 수 없습니다.', 404)
    return save(record, patch)
  })
  async function advance(id) {
    let record = records.get(id)
    if (!record || terminal.has(record.state)) return
    await mutate(record.mapId, () => validate(record, { initial: !record.attemptedAt }))
    if (record.state === 'reserved') {
      const prepared = await prepare(record)
      record = await mutate(record.mapId, async () => {
        const current = records.get(id)
        await validate(current, { initial: true })
        const materialized = await prepared.materialize()
        if (Buffer.byteLength(materialized.payload.instruction, 'utf8') > 256 * 1024) {
          throw cardConversationStartError('CARD_CONVERSATION_START_MESSAGE_TOO_LARGE', '안내를 포함한 첫 메시지가 전송 제한을 넘습니다. 원문을 자르지 않았습니다.', 400)
        }
        return save(current, { ...materialized, state: 'prepared' })
      })
    }
    let dispatch
    if (record.state === 'prepared') {
      record = await mutate(record.mapId, async () => {
        const current = records.get(id)
        await validate(current, { initial: true })
        return save(current, { state: 'dispatching', attemptedAt: timestamp() })
      })
      try {
        dispatch = await call(record.machineId, '/api/internal/external-conversation-dispatches', {
          method: 'POST', body: record.payload, timeoutMs: 30_000,
          noMutationRetry: true, singleTarget: true, strictJson: true,
        })
      } catch (error) {
        // Core에서 생성 전에 반환하는 것으로 확인된 거절만 종료한다. 통신·저장 오류는 결과 조회로 확인한다.
        if (error.status >= 400 && error.status < 500 && rejectedBeforeCreation.has(error.code)) {
          await update(id, { state: 'failed', reasonCode: error.code })
          return
        }
      }
    }
    if (!dispatch && !record.linkedAt) {
      try {
        dispatch = await call(record.machineId, `/api/internal/external-conversation-dispatches/${encodeURIComponent(id)}`,
          { timeoutMs: 10_000, singleTarget: true, strictJson: true })
      } catch {
        await update(id, { state: 'recovery-required', reasonCode: 'CARD_CONVERSATION_START_DELIVERY_UNCONFIRMED' })
        return
      }
    }
    if (dispatch) {
      if (dispatch.operationId !== id || !identifier.test(dispatch.conversationId ?? '')
        || record.conversationId && record.conversationId !== dispatch.conversationId) {
        await update(id, { state: 'recovery-required', reasonCode: 'CARD_CONVERSATION_START_DISPATCH_UNCONFIRMED' })
        return
      }
      record = await mutate(record.mapId, async () => {
        const current = records.get(id)
        await validate(current, { initial: false })
        if (!current.conversationId) await bind(current, dispatch.conversationId)
        return save(current, { conversationId: dispatch.conversationId, deliveryState: dispatch.state,
          turnId: dispatch.turnId ?? current.turnId ?? null, state: 'observing', reasonCode: null })
      })
      if (!['running', 'completed'].includes(dispatch.state) || !dispatch.turnId) {
        if (['failed', 'recovery_required', 'waiting_resume'].includes(dispatch.state)) {
          await update(id, { state: 'recovery-required', reasonCode: 'CARD_CONVERSATION_START_EXECUTION_UNCONFIRMED' })
        }
        return
      }
    }
    // 인수 확인과 동시에 진행된 이전 조회를 사용하지 않고, 확인 이후 다시 읽은 실행 설정으로 승격한다.
    const acceptedBeforeVerification = !record.acceptanceRequired || Boolean(record.acceptedAt)
    let runtimeConfig
    try {
      const raw = await call(record.machineId, `/api/conversations/${encodeURIComponent(record.conversationId)}/runtime-config`,
        { timeoutMs: 5_000, singleTarget: true, strictJson: true })
      const field = (value) => value && ['runtime', 'snapshot', 'unavailable'].includes(value.source)
        && (value.value === null || typeof value.value === 'string') ? { value: value.value, source: value.source }
        : { value: null, source: 'unavailable' }
      runtimeConfig = { model: field(raw?.model), mode: field(raw?.mode), thoughtLevel: field(raw?.thought_level) }
    } catch { return }
    const required = ['model', ...(record.requestedConfig.modeId ? ['mode'] : []),
      ...(record.requestedConfig.thoughtLevelId ? ['thoughtLevel'] : [])]
    const expected = { model: record.requestedConfig.modelId, mode: record.requestedConfig.modeId, thoughtLevel: record.requestedConfig.thoughtLevelId }
    const verified = required.every((key) => runtimeConfig[key].source === 'runtime'
      && (key === 'model' ? aiDelegationResumeModelMatches({ modelId: expected.model }, runtimeConfig.model.value) === true
        : runtimeConfig[key].value === expected[key]))
    record = await update(id, { runtimeConfig })
    if (!verified) {
      await update(id, { state: 'observing', reasonCode: 'CARD_CONVERSATION_START_RUNTIME_UNCONFIRMED' })
      return
    }
    if (!acceptedBeforeVerification) {
      await update(id, { state: 'awaiting-acceptance', reasonCode: 'CARD_CONVERSATION_START_ACCEPTANCE_REQUIRED' })
      return
    }
    await mutate(record.mapId, async () => {
      const current = records.get(id)
      await validate(current, { initial: false })
      if (!current.linkedAt) await promote(current)
      return save(current, { state: 'ready', linkedAt: current.linkedAt ?? timestamp(), reasonCode: null })
    })
  }
  function kick(id) {
    if (active.has(id) || terminal.has(records.get(id)?.state)) return
    const operation = background(async () => {
      try { await advance(id) }
      catch (error) {
        const record = records.get(id)
        if (record) await update(id, { state: record.linkedAt ? 'linked' : record.attemptedAt ? 'recovery-required'
          : error.cardConversationStartError ? 'failed' : record.state,
          reasonCode: error.cardConversationStartError ? error.code : 'CARD_CONVERSATION_START_RETRY_REQUIRED' })
      }
      finally {
        const record = records.get(id)
        if (record) {
          const entry = { requestId: record.requestId, mapId: record.mapId, cardId: record.cardId,
            conversationId: record.conversationId ?? null, state: record.state, reasonCode: record.reasonCode ?? null }
          const signature = JSON.stringify(entry)
          if (logged.get(id) !== signature) { logged.set(id, signature); log(entry) }
        }
      }
    })
    active.set(id, operation)
    void operation.catch(() => {}).finally(() => active.delete(id))
  }
  return {
    continue: (id) => kick(id),
    isActive: (mapId) => [...records.values()].some((record) => record.mapId === mapId && active.has(record.id)),
    isPending: (record) => !terminal.has(record.state) && !record.linkedAt,
    async submit({ userId, mapId, cardId, source }, body) {
      const input = normalizeCardConversationStart(body)
      if (!source || source.mapId !== mapId || source.cardId !== cardId || !identifier.test(source.conversationId ?? '')) {
        throw cardConversationStartError('CARD_CONVERSATION_START_OWN_CARD_REQUIRED', '현재 대화가 연결된 자기 원본 카드에서만 대화를 인계할 수 있습니다.', 403)
      }
      if (source.startedBy && source.startedBy !== userId) {
        throw cardConversationStartError('CARD_CONVERSATION_START_FORBIDDEN', '이 대화를 시작한 편집자 계정으로만 인계할 수 있습니다.', 403)
      }
      const id = cardConversationStartId(userId, mapId, cardId, input.requestId)
      const signature = input.resultOnly ? null : cardConversationStartHash(JSON.stringify(input))
      let repeated = false
      await mutate(mapId, async () => {
        const existing = records.get(id)
        if (existing) {
          if (signature && existing.signature !== signature) throw cardConversationStartError('CARD_CONVERSATION_START_IDEMPOTENCY_CONFLICT', '같은 requestId가 다른 인계 내용에 사용되었습니다.')
          repeated = true
          await validate(existing, { initial: false, resultOnly: true })
          if (input.acceptHandoff) {
            if (!existing.acceptanceRequired || source.conversationId !== existing.conversationId) {
              throw cardConversationStartError('CARD_CONVERSATION_START_ACCEPTOR_MISMATCH', '인수 확인은 새 후속 대화에서만 할 수 있습니다.', 403)
            }
            if (!existing.acceptedAt) await save(existing, { acceptedAt: timestamp(), acceptedByConversationId: source.conversationId })
          }
          return
        }
        if (input.resultOnly) throw cardConversationStartError('CARD_CONVERSATION_START_NOT_FOUND', '인계 요청을 찾을 수 없습니다.', 404)
        if (source.conversationId !== input.predecessorConversationId) throw cardConversationStartError('CARD_CONVERSATION_START_PREDECESSOR_MISMATCH', '이전 대화 ID가 도구를 호출한 대화와 다릅니다.')
        if ([...records.values()].some((record) => record.mapId === mapId && record.cardId === cardId && !terminal.has(record.state) && !record.linkedAt)) {
          throw cardConversationStartError('CARD_CONVERSATION_START_PENDING', '이 카드에 처리 중인 인계 요청이 있습니다. 기존 requestId로 확인하세요.')
        }
        const record = await enrich({ id, requestId: input.requestId, signature, input, mapId, cardId, startedBy: userId,
          predecessorConversationId: source.conversationId, machineId: input.machineId ?? source.homeMachineId,
          state: 'reserved', createdAt: timestamp(), updatedAt: timestamp() })
        await validate(record, { initial: true })
        records.set(id, record)
        await persist()
      })
      kick(id)
      return cardConversationStartView(records.get(id), repeated)
    },
    poll() {
      for (const record of records.values()) {
        // 자동 확인은 10분까지만 한다. 이후에는 같은 요청의 명시적 조회로 복구한다.
        if (now() - Date.parse(record.createdAt) < 10 * 60_000) kick(record.id)
      }
    },
  }
}
