import { createHash } from 'node:crypto'
import { verifyAiDelegationCompletedOriginalMessage } from './aiDelegationDispatchRecovery.mjs'
import { sameExecutionWorkspace } from './doorayExecutionWorkspace.mjs'

export const SOURCE_COMPLETION_MAX_PAGES = 20
export const SOURCE_COMPLETION_PAGE_SIZE = 100

export class AiDelegationSourceCompletionError extends Error {
  constructor(reason) {
    super(`원 실행 완료 증거를 확증하지 못해 통합 대기 결과 정정을 보류했습니다. (${reason})`)
    this.status = 409
    this.code = 'AI_DELEGATION_RESULT_CORRECTION_PROOF_UNCONFIRMED'
    this.proofHoldReason = reason
  }
}

const hold = reason => { throw new AiDelegationSourceCompletionError(reason) }
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const fingerprint = value => sha(JSON.stringify(canonical(value)))
const timestamp = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const text = message => typeof message.content === 'string' ? message.content : message.content?.content

function idleCompletedConversation(conversation, conversationId) {
  const runtime = conversation?.runtime
  return conversation?.id === conversationId && conversation.status === 'finished'
    && runtime?.state === 'idle' && runtime.is_processing === false && runtime.pending_confirmations === 0
    && runtime.has_task === false && runtime.task_status === null && runtime.turn_id === null
}

function pageRows(pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > SOURCE_COMPLETION_MAX_PAGES) hold('history-page-limit')
  const ids = new Set(), cursors = new Set(), rows = []
  let newerMinimum = Infinity
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]
    if (!Array.isArray(page?.items) || !page.items.length || page.items.length > SOURCE_COMPLETION_PAGE_SIZE
      || typeof page.has_more_before !== 'boolean' || typeof page.has_more_after !== 'boolean'
      || page.truncated === true || (index === 0 && page.has_more_after)
      || (index > 0 && !page.has_more_after)
      || page.has_more_before !== (index < pages.length - 1)
      || (page.has_more_before && page.items.length !== SOURCE_COMPLETION_PAGE_SIZE)) hold('history-page-incomplete')
    if (typeof page.oldest_cursor !== 'string' || !page.oldest_cursor.trim()
      || typeof page.newest_cursor !== 'string' || !page.newest_cursor.trim()
      || cursors.has(page.oldest_cursor)) hold('history-cursor-unstable')
    cursors.add(page.oldest_cursor)
    let minimum = Infinity, maximum = -Infinity
    for (const message of page.items) {
      if (!message || typeof message.id !== 'string' || !message.id.trim() || ids.has(message.id)
        || !timestamp(message.created_at) || message.truncated === true || message.content?.truncated === true) hold('history-row-incomplete')
      ids.add(message.id); rows.push(message)
      minimum = Math.min(minimum, message.created_at); maximum = Math.max(maximum, message.created_at)
    }
    if (maximum > newerMinimum) hold('history-range-overlap')
    newerMinimum = minimum
  }
  return rows.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
}

// completed는 과거 MnP의 관측이며 external turn과 backend UUID는 별개다.
// live dispatch의 state/turnId를 합성하지 않고 본문은 메모리에서만 대사한다.
export function verifyAiDelegationSourceCompletion(delegation, origin, conversation, pages) {
  const lease = delegation?.workspaceLease, result = delegation?.workspaceResult
  if (delegation?.strategy !== 'new' || delegation.state !== 'waiting-integration' || delegation.childStatus !== 'completed'
    || delegation.childOperationId !== delegation.id || Number(delegation.recoveryAttempt ?? 0) !== 0
    || delegation.recoveryOperationId || delegation.resumesDelegationId
    || delegation.pendingRecovery || delegation.resultCorrection?.previousOperationId
    || (delegation.resultCorrection && delegation.resultCorrection.phase !== 'preparing')
    || !lease || typeof delegation.childOperationId !== 'string' || !delegation.childOperationId.trim()
    || typeof delegation.childTurnId !== 'string' || !delegation.childTurnId.trim()
    || delegation.childResultTurnId !== delegation.childTurnId
    || !idleCompletedConversation(conversation, delegation.targetConversationId)) hold('first-completed-source-required')
  if (result?.status !== 'waiting-integration' || result.childStatus !== 'completed' || result.integratedCommit
    || result.reasonCode !== 'integration-untracked-collision') hold('historical-finalize-required')
  for (const [key, expected] of Object.entries({ mapId: delegation.mapId,
    cardId: delegation.targetCardId, conversationId: delegation.targetConversationId })) {
    if (!expected || result[key] !== expected) hold('historical-finalize-scope-mismatch')
  }
  for (const key of ['workspaceId', 'jobId', 'leaseId', 'branch', 'baseBranch', 'baseCommit']) {
    if (!lease[key] || result[key] !== lease[key]) hold('historical-finalize-lease-mismatch')
  }
  for (const key of ['headCommit', 'integrationHeadCommit', 'integrationBaseCommit']) {
    if (!/^[a-f0-9]{40}$/u.test(String(result[key] ?? ''))) hold('historical-source-head-missing')
  }
  if (!result.integrationBranch) hold('historical-candidate-missing')
  const snapshot = delegation.childResultSnapshot, capturedAt = Date.parse(delegation.childResultCapturedAt)
  const completedAt = Date.parse(delegation.childCompletedAt)
  if (typeof snapshot !== 'string' || !snapshot.trim() || !/^[a-f0-9]{64}$/u.test(String(delegation.childResultHash ?? ''))
    || sha(snapshot) !== delegation.childResultHash || !Number.isFinite(capturedAt) || !Number.isFinite(completedAt)
    || capturedAt > completedAt) hold('completed-capture-integrity')
  const rows = pageRows(pages)
  if (rows.some(message => message.conversation_id !== delegation.targetConversationId)) hold('history-conversation-mismatch')
  const requests = rows.filter(message => message.position === 'right')
  if (requests.length !== 1 || requests[0] !== rows[0] || requests[0].type !== 'text' || requests[0].status !== 'finish'
    || requests[0].backend_turn_id) hold('original-request-not-unique')
  let original
  try { original = verifyAiDelegationCompletedOriginalMessage(delegation, origin, conversation, requests[0]) }
  catch { hold('original-request-unconfirmed') }
  const substantive = rows.filter(message => message.position === 'left' && ['text', 'tool_call'].includes(message.type))
  if (!substantive.length) hold('completed-backend-missing')
  const backend = substantive[0].backend_turn_id
  if (typeof backend !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(backend)
    || substantive.some(message => message.backend_turn_id !== backend)) hold('backend-turn-not-unique')
  const tips = rows.filter(message => message.position === 'left' && message.type === 'tips')
  if (tips.length > 1 || tips.some(message => message.backend_turn_id || message.status !== 'finish'
    || message.created_at >= substantive[0].created_at)) hold('unbound-tips-not-initial')
  if (rows.length !== 1 + substantive.length + tips.length) hold('history-row-kind-unknown')
  let terminalToolErrors = 0
  for (const message of substantive) {
    if (message.type === 'text') {
      if (message.status !== 'finish' || typeof text(message) !== 'string') hold('assistant-text-not-finished')
    } else if (message.status === 'error' && message.content?.status === 'error') terminalToolErrors++
    else if (message.status !== 'finish' || message.content?.status !== 'completed') hold('tool-not-terminal')
  }
  const final = substantive.at(-1)
  if (final !== rows.at(-1) || final.type !== 'text' || final.status !== 'finish'
    || rows.some(message => message !== final && message.created_at >= final.created_at)) hold('final-result-not-latest')
  if (text(final) !== snapshot || sha(text(final)) !== delegation.childResultHash) hold('final-result-capture-mismatch')
  if (final.created_at > capturedAt) hold('completed-observation-time-mismatch')
  return { kind: 'source-bound-completed-observation-after-operation-expiry-v1',
    originalOperationId: delegation.childOperationId, conversationId: delegation.targetConversationId,
    observedOriginalTurnId: delegation.childTurnId, backendTurnId: backend,
    originalRequest: original.recoveryProof, completionMessageId: final.id, resultHash: delegation.childResultHash,
    completionCreatedAt: final.created_at, resultCapturedAt: delegation.childResultCapturedAt,
    observedCompletedAt: delegation.childCompletedAt, sourceHead: result.headCommit,
    candidateBranch: result.integrationBranch, candidateHead: result.integrationHeadCommit, candidateBase: result.integrationBaseCommit,
    workspaceLease: original.workspaceLease, messageCount: rows.length, pageCount: pages.length,
    historyHash: fingerprint(rows), terminalToolErrors, initialTipsMessageId: tips[0]?.id ?? null }
}

// public lease에는 head/candidate가 없다. proof가 pool의 같은 원 결과를 가리키는지
// API의 intent 저장 전과 pool의 exclusive prepare에서 각각 대사한다.
export function assertAiDelegationSourceCompletionLease(lease, proof, scope) {
  const correction = lease?.resultCorrection, result = correction?.previousResult ?? lease?.result
  if (proof?.kind !== 'source-bound-completed-observation-after-operation-expiry-v1'
    || !lease || proof.conversationId !== scope.conversationId
    || result?.status !== 'waiting-integration' || result.childStatus !== 'completed'
    || result.reasonCode !== 'integration-untracked-collision' || result.integratedCommit) hold('pool-original-result-mismatch')
  for (const key of ['mapId', 'cardId', 'conversationId']) {
    if (!scope[key] || lease[key] !== scope[key] || result[key] !== scope[key]) hold('pool-original-scope-mismatch')
  }
  for (const key of ['workspaceId', 'jobId', 'leaseId', 'branch', 'baseCommit']) {
    if (!proof.workspaceLease?.[key] || lease[key] !== proof.workspaceLease[key] || result[key] !== lease[key]) hold('pool-original-lease-mismatch')
  }
  if (!sameExecutionWorkspace(lease.projectRoot, proof.workspaceLease?.projectRoot)
    || result.baseBranch !== lease.baseBranch) hold('pool-original-lease-mismatch')
  const expected = { headCommit: proof.sourceHead, integrationBranch: proof.candidateBranch,
    integrationHeadCommit: proof.candidateHead, integrationBaseCommit: proof.candidateBase }
  const current = { headCommit: correction?.sourceHead ?? lease.headCommit,
    integrationBranch: correction?.candidateBranch ?? lease.integrationBranch,
    integrationHeadCommit: correction?.candidateHead ?? lease.integrationHeadCommit,
    integrationBaseCommit: correction?.candidateBase ?? lease.integrationBaseCommit }
  for (const key of Object.keys(expected)) {
    if (!expected[key] || result[key] !== expected[key] || current[key] !== expected[key]) hold('pool-original-source-mismatch')
  }
}

export async function readAiDelegationSourceCompletionProof(fetchOn, { machineId, delegation, origin }) {
  if (delegation.strategy !== 'new' || delegation.childOperationId !== delegation.id || Number(delegation.recoveryAttempt ?? 0) !== 0
    || delegation.recoveryOperationId || delegation.resumesDelegationId || delegation.pendingRecovery || delegation.resultCorrection?.previousOperationId
    || (delegation.resultCorrection && delegation.resultCorrection.phase !== 'preparing')) hold('first-completed-source-required')
  const conversationPath = `/api/conversations/${encodeURIComponent(delegation.targetConversationId)}`
  const conversation = await fetchOn(machineId, conversationPath)
  const pages = [], beforePages = [], cursors = new Set()
  let before = ''
  const readPage = cursor => fetchOn(machineId, `${conversationPath}/messages?${new URLSearchParams({
    limit: String(SOURCE_COMPLETION_PAGE_SIZE), content_mode: 'full', ...(cursor ? { before: cursor } : {}),
  })}`, { timeoutMs: 30_000 })
  for (let index = 0; index < SOURCE_COMPLETION_MAX_PAGES; index++) {
    const page = await readPage(before)
    pages.push(page); beforePages.push(before)
    if (page?.has_more_before === false) break
    const next = typeof page?.oldest_cursor === 'string' ? page.oldest_cursor.trim() : ''
    if (!next || next === before || cursors.has(next)) hold('history-cursor-unstable')
    cursors.add(next); before = next
  }
  const proof = verifyAiDelegationSourceCompletion(delegation, origin, conversation, pages)
  // 본문을 저장하지 않고 같은 유한 범위를 재조회해 추가·변경과 담당자 재실행을 거부한다.
  for (let index = 0; index < pages.length; index++) {
    if (fingerprint(await readPage(beforePages[index])) !== fingerprint(pages[index])) hold('history-changed-during-proof')
  }
  const current = await fetchOn(machineId, conversationPath)
  if (!idleCompletedConversation(current, delegation.targetConversationId)
    || current.created_at !== conversation.created_at
    || !sameExecutionWorkspace(current.extra?.workspace, conversation.extra?.workspace)) hold('owner-changed-during-proof')
  return proof
}
