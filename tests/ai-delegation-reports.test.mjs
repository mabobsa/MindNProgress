import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { activeAiDelegationsForConversation } from '../server/lib/aiDelegations.mjs'
import { acknowledgeAiDelegationReport, aiDelegationDeliveredReportPatch, aiDelegationStoredReportDeliveryPatch, aiDelegationReportStatus } from '../server/lib/aiDelegationReports.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
function fixture() {
  return {
    id: 'report-a', mapId: 'map-a', targetCardId: 'child', targetConversationId: 'child-conversation',
    parentConversationId: 'parent-conversation', state: 'waking-parent',
    childStatus: 'completed', childTurnId: 'child-turn', childResultTurnId: 'child-turn',
    childResultSnapshot: '실제 완료 결과', childResultHash: hash('실제 완료 결과'),
    workspaceLease: { leaseId: 'lease-a' }, workspaceResult: { status: 'completed' },
    wakeOperationId: 'wake-a', reportPayloadHash: hash('실제 위임 결과 전문'),
    reportResultAvailability: 'captured', reportResultHash: hash('실제 완료 결과'), reportResultTurnId: 'child-turn',
  }
}
const dispatch = { operationId: 'wake-a', conversationId: 'parent-conversation', state: 'running', turnId: 'parent-turn' }

test('상위 턴이 계속 실행 중이어도 실제 전달이 확인된 하위 위임만 종결한다', () => {
  const d = fixture()
  const patch = aiDelegationDeliveredReportPatch(d, dispatch, '2026-09-12T00:00:00.000Z')
  assert.equal(patch.state, 'completed')
  assert.equal(patch.parentDispatchState, 'running')
  assert.equal(patch.reportReceipt.method, 'dispatch-delivered')
  assert.equal(patch.reportReceipt.resultHash, d.childResultHash)
  assert.equal(patch.childStatus, undefined)
  assert.equal(patch.workspaceResult, undefined)
  assert.equal(aiDelegationReportStatus({ ...d, ...patch }), 'received')
  assert.deepEqual(activeAiDelegationsForConversation([{ ...d, ...patch }], {
    mapId: d.mapId, targetCardId: d.targetCardId, targetConversationId: d.targetConversationId,
  }), [], '보고를 종결하면 같은 대화의 후속 위임을 막지 않는다.')
})

for (const state of ['starting', 'waiting_resource', 'failed', 'recovery_required']) test(`${state}만으로 수신 완료를 추측하지 않는다`, () => {
  assert.equal(aiDelegationDeliveredReportPatch(fixture(), { ...dispatch, state }), null)
})
for (const [label, patch] of [
  ['다른 대화', { conversationId: 'other-parent' }], ['다른 요청', { operationId: 'other-wake' }],
  ['실행 턴 없음', { turnId: null }],
]) test(`전달 확인 거절: ${label}`, () => {
  assert.equal(aiDelegationDeliveredReportPatch(fixture(), { ...dispatch, ...patch }), null)
})
for (const [label, patch] of [
  ['자식 실행 중', { childStatus: 'running' }], ['통합 미완료', { workspaceResult: { status: 'waiting-integration' } }],
  ['통합 실패', { workspaceError: '통합 오류' }], ['복구 접수 중', { pendingRecovery: {} }],
  ['원문 변조', { childResultSnapshot: '변조된 결과' }], ['다른 결과 전달', { reportResultHash: hash('다른 결과') }],
  ['다른 결과 턴', { reportResultTurnId: 'old-turn' }], ['다른 상위 턴', { parentTurnId: 'old-parent-turn' }],
  ['요청 원문 근거 없음', { reportPayloadHash: null }],
]) test(`전달 확인 안전성: ${label}`, () => {
  assert.equal(aiDelegationDeliveredReportPatch({ ...fixture(), ...patch }, dispatch), null)
})

test('재시작 또는 상위 사용자 중지 후에도 저장된 전달 근거로만 보고를 종결한다', () => {
  for (const parentDispatchState of ['running', 'waiting-resume', 'waiting_resume', 'completed']) {
    const d = { ...fixture(), parentDispatchState, parentTurnId: 'parent-turn' }
    assert.equal(aiDelegationStoredReportDeliveryPatch(d).state, 'completed')
    assert.equal(aiDelegationReportStatus(d), 'received')
  }
  assert.equal(aiDelegationStoredReportDeliveryPatch({ ...fixture(), parentDispatchState: 'failed', parentTurnId: 'parent-turn' }), null)
})

test('상위 AI가 읽은 결과의 명시적 수신 확인은 상위 실행과 무관하고 재호출 안전하다', () => {
  const d = { ...fixture(), state: 'waiting-parent' }
  const input = { conversationId: d.parentConversationId, resultHash: d.childResultHash }
  const patch = acknowledgeAiDelegationReport(d, input)
  assert.equal(patch.state, 'completed')
  assert.equal(patch.reportReceipt.method, 'parent-acknowledged')
  assert.equal(patch.reportReceipt.childTurnId, d.childTurnId)
  assert.deepEqual(acknowledgeAiDelegationReport({ ...d, ...patch }, input), {})
  assert.equal(d.state, 'waiting-parent')
})

for (const [label, dPatch, inputPatch] of [
  ['다른 상위 대화', {}, { conversationId: 'other-parent' }], ['대화 미확인', {}, { conversationId: null }],
  ['잘못된 결과 해시', {}, { resultHash: hash('다른 결과') }],
  ['원문 없음', { childResultSnapshot: null }, {}], ['결과 턴 불일치', { childResultTurnId: 'old-turn' }, {}],
  ['하위 실행 중', { state: 'running' }, {}], ['통합 미완료', { workspaceResult: { status: 'waiting-integration' } }, {}],
  ['결과 폐기', { state: 'closed' }, {}], ['복구 접수 중', { pendingRecovery: {} }, {}],
]) test(`수신 확인 거절: ${label}`, () => {
  const d = { ...fixture(), state: 'waiting-parent', ...dPatch }
  assert.throws(() => acknowledgeAiDelegationReport(d, { conversationId: d.parentConversationId, resultHash: hash('실제 완료 결과'), ...inputPatch }), { code: 'AI_DELEGATION_REPORT_ACK_REJECTED' })
})
