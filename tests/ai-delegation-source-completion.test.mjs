import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyAiDelegationOriginalMessage } from '../server/lib/aiDelegationDispatchRecovery.mjs'
import { AiDelegationSourceCompletionError, assertAiDelegationSourceCompletionLease, readAiDelegationSourceCompletionProof, verifyAiDelegationSourceCompletion } from '../server/lib/aiDelegationSourceCompletion.mjs'
import { sourceBackendTurnId, sourceCompletionFixture, sourceCompletionPages, sourceHash } from './helpers/aiDelegationSourceCompletion.mjs'

const verify = f => verifyAiDelegationSourceCompletion(f.delegation, f.origin, f.conversation, f.pages)
const checkHold = f => assert.throws(() => verify(f), error => error instanceof AiDelegationSourceCompletionError
  && error.code === 'AI_DELEGATION_RESULT_CORRECTION_PROOF_UNCONFIRMED')

test('정상 소거한 pending은 durable hash로 대사하고 단일 완료 관측과 terminal tool error를 별도 provenance로 보존한다', () => {
  const f = sourceCompletionFixture(), proof = verify(f)
  assert.equal(Object.hasOwn(f.delegation.workspaceLease, 'mapId'), false)
  assert.equal(Object.hasOwn(f.delegation, 'pendingInstruction'), false)
  assert.equal(proof.kind, 'source-bound-completed-observation-after-operation-expiry-v1')
  assert.equal(proof.backendTurnId, sourceBackendTurnId); assert.equal(proof.observedOriginalTurnId, 'original-turn')
  assert.equal(proof.state, undefined); assert.equal(proof.turnId, undefined)
  assert.equal(proof.terminalToolErrors, 1); assert.equal(proof.initialTipsMessageId, 'initial-tip')
  assert.equal(proof.originalRequest.instructionEvidence, 'durable-instruction-hash')
  assert.equal(proof.resultHash, f.delegation.childResultHash)
  assert.equal(JSON.stringify(proof).includes('fixture-secret-original-token'), false)
  assert.equal(JSON.stringify(proof).includes(f.instruction), false)
  assert.equal(JSON.stringify(proof).includes(f.delegation.childResultSnapshot), false)
  assert.throws(() => verifyAiDelegationOriginalMessage(f.delegation, f.origin, f.conversation, f.rows[0]),
    { code: 'AI_DELEGATION_ORIGINAL_MESSAGE_UNCONFIRMED' })
  f.delegation.pendingInstruction = f.instruction
  assert.equal(verify(f).originalRequest.instructionEvidence, 'pending-instruction-exact')
})

for (const [name, mutate] of [
  ['origin 카드', f => { f.origin.cardId = 'other' }],
  ['origin 사용자', f => { f.origin.startedBy = 'other' }],
  ['origin 대화', f => { f.origin.conversationId = 'other' }],
  ['header lease', f => { f.rows[0].content.content = f.rows[0].content.content.replace('- leaseId: `lease`', '- leaseId: `other`') }],
  ['중복 header', f => { f.rows[0].content.content = f.rows[0].content.content.replace('- cardId: `card-test`', '- cardId: `card-test`\n- cardId: `card-test`') }],
  ['durable instruction hash', f => { f.delegation.instructionHash = '0'.repeat(64) }],
  ['present pending exact', f => { f.delegation.pendingInstruction = f.instruction + '추가' }],
  ['대화 workspace', f => { f.conversation.extra.workspace = 'C:/other' }],
  ['대화 status', f => { f.conversation.status = 'running' }],
  ['idle의 unknown task', f => { delete f.conversation.runtime.has_task }],
  ['idle의 active task', f => { f.conversation.runtime.has_task = true }],
  ['completed 관측', f => { f.delegation.childStatus = 'failed' }],
  ['외부 turn 누락', f => { f.delegation.childTurnId = null }],
  ['캡처 turn 불일치', f => { f.delegation.childResultTurnId = 'other' }],
  ['캡처 hash 불일치', f => { f.delegation.childResultHash = '0'.repeat(64) }],
  ['부분 캡처', f => { f.delegation.childResultSnapshot = '기존'; f.delegation.childResultHash = sourceHash('기존') }],
  ['latest drift', f => { f.rows.at(-1).content.content += '변경' }],
  ['다른 user request', f => { f.rows.push({ ...f.rows[0], id: 'extra-request', created_at: f.rows.at(-1).created_at + 1 }) }],
  ['다른 backend', f => { f.rows[2].backend_turn_id = '01a11291-a2d9-7db1-b2e0-6c1df6ea7ee9' }],
  ['substantive backend 없음', f => { delete f.rows[2].backend_turn_id }],
  ['다른 row 대화', f => { f.rows[2].conversation_id = 'other' }],
  ['late unbound tips', f => { f.rows[1].created_at = f.rows.at(-1).created_at }],
  ['unfinished text', f => { f.rows.at(-1).status = 'pending' }],
  ['error text', f => { f.rows.at(-1).status = 'error' }],
  ['unfinished tool', f => { f.rows[2].content.status = 'in_progress' }],
  ['모호한 tool error 조합', f => { f.rows[3].status = 'finish' }],
  ['최종 뒤 tool', f => { f.rows.push({ ...f.rows[2], id: 'late-tool', created_at: f.rows.at(-1).created_at + 1 }) }],
  ['final 이후 capturedAt 역전', f => { f.delegation.childResultCapturedAt = new Date(f.rows.at(-1).created_at - 1).toISOString() }],
  ['captured 이후 completedAt 역전', f => { f.delegation.childCompletedAt = new Date(Date.parse(f.delegation.childResultCapturedAt) - 1).toISOString() }],
  ['completedAt 누락', f => { delete f.delegation.childCompletedAt }],
  ['finalize scope', f => { f.delegation.workspaceResult.cardId = 'other' }],
  ['finalize lease', f => { f.delegation.workspaceResult.leaseId = 'other' }],
  ['finalize branch', f => { f.delegation.workspaceResult.branch = 'other' }],
  ['이미 integrated', f => { f.delegation.workspaceResult.integratedCommit = 'c'.repeat(40) }],
  ['resume 위임', f => { f.delegation.strategy = 'resume' }],
  ['일반 복구 뒤 operation', f => { f.delegation.childOperationId += '-recover-1' }],
  ['일반 복구 이력', f => { f.delegation.recoveryAttempt = 1 }],
  ['재사용 위임', f => { f.delegation.resumesDelegationId = 'other' }],
  ['정정 재개', f => { f.delegation.resultCorrection = { phase: 'preparing', previousOperationId: 'old-correction' } }],
  ['dispatched 정정', f => { f.delegation.resultCorrection = { phase: 'dispatched' } }],
]) test(`원 실행 완료 증거 HOLD: ${name}`, () => {
  const f = sourceCompletionFixture(); mutate(f); f.pages = sourceCompletionPages(f.rows); checkHold(f)
})

for (const [name, mutate] of [
  ['페이지 미완결', f => { f.pages[0].has_more_before = true }],
  ['latest 범위 미완결', f => { f.pages[0].has_more_after = true }],
  ['커서 누락', f => { f.pages[0].oldest_cursor = null }],
  ['중복 ID', f => { f.pages[0].items.push(f.pages[0].items[0]) }],
  ['잘린 raw row', f => { f.pages[0].items[0].truncated = true }],
]) test(`원 실행 완료 증거 HOLD: ${name}`, () => { const f = sourceCompletionFixture(); mutate(f); checkHold(f) })

test('20x100의 유한 원문 범위와 재조회 안정성·fresh owner를 검증한다', async () => {
  const f = sourceCompletionFixture()
  for (let index = 0; index < 100; index++) f.rows.push({ ...f.rows[2], id: `tool-${index}`, created_at: f.rows[2].created_at + index + 100 })
  f.pages = sourceCompletionPages(f.rows)
  assert.equal(verify(f).pageCount, 2)
  let changed = false, active = false, conversationReads = 0
  const reads = new Map()
  const fetchOn = async (_machine, pathname) => {
    if (!pathname.includes('/messages?')) {
      conversationReads++
      return active && conversationReads > 1 ? { ...f.conversation, runtime: { ...f.conversation.runtime, has_task: true } } : f.conversation
    }
    const before = new URL('http://fixture' + pathname).searchParams.get('before')
    const index = before ? f.pages.findIndex(page => page.oldest_cursor === before) + 1 : 0
    reads.set(index, (reads.get(index) ?? 0) + 1)
    const page = structuredClone(f.pages[index])
    if (changed && index === 1 && reads.get(index) > 1) page.items[0].content.content += '변경'
    return page
  }
  const options = { machineId: 'assigned-machine', delegation: f.delegation, origin: f.origin }
  assert.equal((await readAiDelegationSourceCompletionProof(fetchOn, options)).historyHash, verify(f).historyHash)
  reads.clear(); changed = true
  await assert.rejects(readAiDelegationSourceCompletionProof(fetchOn, options), { proofHoldReason: 'history-changed-during-proof' })
  changed = false; active = true; conversationReads = 0
  await assert.rejects(readAiDelegationSourceCompletionProof(fetchOn, options), { proofHoldReason: 'owner-changed-during-proof' })
  const duplicateCursor = structuredClone(f); duplicateCursor.pages[1].oldest_cursor = duplicateCursor.pages[0].oldest_cursor
  checkHold(duplicateCursor)
})

test('public lease 밖의 pool source·candidate·원 결과를 intent 저장 전과 exclusive prepare에서 정확 대사한다', () => {
  const f = sourceCompletionFixture(), proof = verify(f), result = f.delegation.workspaceResult
  const scope = { mapId: f.delegation.mapId, cardId: f.delegation.targetCardId, conversationId: f.delegation.targetConversationId }
  const lease = { ...f.delegation.workspaceLease, ...scope, result, headCommit: result.headCommit,
    integrationBranch: result.integrationBranch, integrationHeadCommit: result.integrationHeadCommit,
    integrationBaseCommit: result.integrationBaseCommit }
  assertAiDelegationSourceCompletionLease(lease, proof, scope)
  for (const mutate of [
    value => { value.headCommit = 'd'.repeat(40) },
    value => { value.integrationHeadCommit = 'd'.repeat(40) },
    value => { value.integrationBaseCommit = 'd'.repeat(40) },
    value => { value.integrationBranch = 'other' },
    value => { value.result.headCommit = 'd'.repeat(40) },
    value => { value.result.integrationHeadCommit = 'd'.repeat(40) },
    value => { value.result.conversationId = 'other' },
    value => { value.leaseId = 'other' },
    value => { value.result.integratedCommit = 'd'.repeat(40) },
  ]) {
    const changed = structuredClone(lease); mutate(changed)
    const before = structuredClone(changed)
    assert.throws(() => assertAiDelegationSourceCompletionLease(changed, proof, scope), AiDelegationSourceCompletionError)
    assert.deepEqual(changed, before)
  }
  const preparing = { ...lease, resultCorrection: { sourceHead: proof.sourceHead, candidateBranch: proof.candidateBranch,
    candidateHead: proof.candidateHead, candidateBase: proof.candidateBase, previousResult: result } }
  assertAiDelegationSourceCompletionLease(preparing, proof, scope)
  preparing.resultCorrection.previousResult = { ...result, headCommit: 'd'.repeat(40) }
  assert.throws(() => assertAiDelegationSourceCompletionLease(preparing, proof, scope), AiDelegationSourceCompletionError)
})
