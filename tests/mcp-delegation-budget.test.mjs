import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDelegationBudget, delegationNeedsAttention, DELEGATION_BUDGET_STEP_IDS, DELEGATION_RESPONSE_BUDGET_CHARS, requestFailureNeedsAttention } from '../mcp/delegationBudget.mjs'

const mapId = 'map-delegations'
const text = (label, length) => `${label} `.repeat(Math.ceil(length / (label.length + 1))).slice(0, length)
// list_ai_delegations 공개 응답과 같은 형태의 위임. 최신순으로 쌓는다.
const delegation = (id, { state = 'completed', target = 'card-a', result = 3000, createdAt, ...extra } = {}) => ({
  id, mapId, parentMapId: mapId, parentCardId: 'root', targetCardId: target, parentConversationId: 'conv-parent', targetConversationId: `conv-${target}`,
  state, displayState: extra.displayState ?? state, createdAt, updatedAt: createdAt,
  workspaceResult: { status: 'completed', branch: `ai/${id}`, changedFiles: Array.from({ length: 12 }, (_, i) => `src/file-${i}.mjs`) },
  workspaceLease: { leaseId: `lease-${id}`, workspaceId: 'fork-1', ownership: null },
  decisionReason: text('위임 판단 사유', 300), instructionPreview: text('지시 미리보기', 240), attemptHistory: [{ at: createdAt, outcome: 'started' }],
  workCompleted: state === 'completed', reportStatus: state === 'completed' ? 'received' : null, resultAvailability: 'captured', resultHash: `hash-${id}`,
  ...(result ? { result: text(`${id} 결과`, result) } : {}),
  ...extra,
})
// 공개 접수 실패 기록과 같은 형태. confirmed·closed는 정리된 기록이고 나머지는 상위 AI가 확인해야 한다.
const requestFailure = (id, { state = 'confirmed', target = 'card-a', createdAt, ...extra } = {}) => {
  const replacementId = state === 'confirmed' ? `${id}-retry` : null
  return {
    id, kind: 'request-failure', state: 'request-failed', requestedDelegationId: `${id}-requested`, mapId, parentMapId: mapId, parentCardId: 'root',
    parentCardLabel: '상위 카드', parentConversationId: 'conv-parent', requestedConversationId: null, targetCardId: target, targetCardLabel: '대상 카드',
    parentHomeMachineId: 'machine-a', targetHomeMachineId: 'machine-a', strategy: 'new', phase: 'preflight', accepted: false, executionState: 'not-started',
    automaticRetry: false, status: 409, reasonCode: 'AI_DELEGATION_VERSION_CONFLICT', message: text('문서 버전 충돌 안내', 300), createdAt, updatedAt: createdAt,
    requestSummary: text('요청 요약', 240),
    ...(replacementId ? { resolution: { delegationId: replacementId, method: 'same-instruction', at: createdAt, actorId: 'system', note: text('재접수 확인 메모', 120) } } : {}),
    ...(state === 'closed' ? { requestClosure: { reason: 'no-longer-needed', note: text('종료 메모', 120), at: createdAt, actorId: 'user-editor' } } : {}),
    resolvedByDelegationId: replacementId,
    retryVerification: { state, method: replacementId ? 'same-instruction' : null, message: text('재접수 판정 안내', 80),
      replacement: replacementId ? { id: replacementId, targetCardLabel: '대상 카드', instructionPreview: text('재접수 지시', 240), createdAt, state: 'completed', targetConversationId: 'conv-retry' } : null },
    ...extra,
  }
}
const response = (delegations, requestFailures = []) => ({ mapId, delegations, requestFailures })
const at = (index) => `2026-10-${String(28 - Math.floor(index / 3)).padStart(2, '0')}T0${index % 10}:00:00.000Z`
const hoursAgo = (index) => new Date(Date.UTC(2026, 9, 28, 12) - index * 3_600_000).toISOString()

test('판단이 필요한 위임을 미종료·실패·복구·종료 처리·보고 대기와 표시 상태로 가른다', () => {
  for (const state of ['completed', 'superseded', 'closed']) assert.equal(delegationNeedsAttention({ state, displayState: state }), false, state)
  for (const state of ['failed', 'running', 'waiting-workspace', 'recovery-required', 'waiting-parent']) assert.equal(delegationNeedsAttention({ state, displayState: state }), true, state)
  assert.equal(delegationNeedsAttention({ state: 'completed', displayState: 'integration-recovery-checking' }), true)
  assert.equal(delegationNeedsAttention({ state: 'completed', closure: { closeAvailable: true } }), true)
  assert.equal(delegationNeedsAttention({ state: 'completed', recovery: { recoveryAvailable: true } }), true)
  assert.equal(delegationNeedsAttention({ state: 'completed', reportPending: true }), true)
  for (const state of ['confirmed', 'closed']) assert.equal(requestFailureNeedsAttention({ retryVerification: { state } }), false, state)
  for (const state of ['not-found', 'unverified', 'execution-unknown', undefined]) assert.equal(requestFailureNeedsAttention({ retryVerification: { state } }), true, String(state))
  assert.equal(requestFailureNeedsAttention({ retryVerification: { state: 'confirmed' }, retryReference: { requestId: 'r-1' } }), true)
})

test('예산 안의 응답은 같은 객체를 그대로 반환한다', () => {
  const value = response([delegation('d-1', { createdAt: at(0) }), delegation('d-2', { createdAt: at(1), target: 'card-b' })])
  assert.ok(JSON.stringify(value).length <= DELEGATION_RESPONSE_BUDGET_CHARS)
  assert.equal(applyDelegationBudget(value, { mapId }), value)
})

test('판단이 필요한 위임은 그대로 두고 카드별 최신이 아닌 정리된 이력부터 줄인다', () => {
  const attention = delegation('d-recovery', { state: 'recovery-required', target: 'card-r', createdAt: at(0), result: 4000,
    recovery: { recoveryAvailable: true, recommendedAction: 'resume-existing', recoveryTool: 'mindnprogress_recover_ai_delegation' } })
  const history = Array.from({ length: 10 }, (_, index) => delegation(`d-a-${index}`, { createdAt: at(index + 1), result: 3500 }))
  const value = response([attention, ...history])
  const before = structuredClone(value)
  const result = applyDelegationBudget(value, { mapId })
  assert.deepEqual(value, before, '입력 응답을 변경하지 않는다')
  assert.deepEqual(Object.keys(result).slice(0, 3), ['mapId', 'responseBudget', 'omitted'])
  assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length)
  assert.ok(result.responseBudget.returnedChars <= DELEGATION_RESPONSE_BUDGET_CHARS)
  assert.equal(result.responseBudget.exceeded, false)
  assert.deepEqual(result.responseBudget.appliedSteps, DELEGATION_BUDGET_STEP_IDS.filter((id) => result.responseBudget.appliedSteps.includes(id)))
  assert.deepEqual(result.delegations[0], before.delegations[0], '판단이 필요한 위임은 결과와 세부 기록을 그대로 둔다')
  const latest = result.delegations.find((item) => item.id === 'd-a-0')
  assert.equal(latest.result, before.delegations[1].result, '카드별 최신 정리된 이력은 마지막까지 결과를 남긴다')
  const older = result.delegations.find((item) => item.id === 'd-a-9')
  assert.equal(older.result, undefined)
  assert.equal(older.resultOmitted, true)
  assert.equal(older.resultHash, 'hash-d-a-9', '결과 해시는 남긴다')
  assert.ok(result.omitted.resultOmittedDelegationIds.includes('d-a-9'))
  assert.deepEqual(result.omitted.retrieval.delegation.arguments, { mapId, delegationId: '<delegationId>', includeResult: true })
})

test('아주 많은 이력은 요약 뒤 오래된 것부터 목록에서 빼고 카드별 개수를 남긴다', () => {
  const attention = delegation('d-running', { state: 'running', target: 'card-r', createdAt: at(0), result: 0 })
  const history = Array.from({ length: 160 }, (_, index) => delegation(`d-h-${index}`, { target: `card-${index % 4}`, createdAt: at(index + 1), result: 2000 }))
  const result = applyDelegationBudget(response([attention, ...history]), { mapId })
  const applied = result.responseBudget.appliedSteps
  assert.ok(applied.includes('olderSettledSummaries'))
  assert.ok(applied.includes('oldSettledRemoved'))
  assert.ok(result.responseBudget.returnedChars <= DELEGATION_RESPONSE_BUDGET_CHARS)
  assert.equal(result.delegations[0].id, 'd-running', '판단이 필요한 위임은 빼지 않는다')
  assert.ok(result.delegations.filter((item) => item.summary).every((item) => item.workspaceResult === undefined && item.id && item.state))
  const removed = Object.values(result.omitted.removedByTarget).reduce((sum, count) => sum + count, 0)
  assert.equal(removed, result.omitted.counts.removedSettledDelegations)
  assert.equal(result.delegations.length + removed, 161)
  // 오래된 이력부터 뺐으므로 남은 정리된 이력은 앞쪽(최신)이다.
  assert.ok(result.delegations.some((item) => item.id === 'd-h-0'))
  assert.ok(!result.delegations.some((item) => item.id === 'd-h-159'))
})

test('미해결 접수 실패는 그대로 두고 정리된 접수 실패를 요약한 뒤 오래된 것부터 개수로 바꾼다', () => {
  const unresolved = requestFailure('rf-open', { state: 'not-found', createdAt: hoursAgo(0), retryReference: { requestId: 'rf-open', instruction: '재접수 안내' } })
  const unknown = requestFailure('rf-unknown', { state: 'execution-unknown', createdAt: hoursAgo(1), phase: 'dispatch', executionState: 'unknown' })
  const settled = Array.from({ length: 150 }, (_, index) => requestFailure(`rf-${index}`, { state: index % 10 === 9 ? 'closed' : 'confirmed', target: `card-${index % 3}`, createdAt: hoursAgo(index + 2) }))
  const value = response([delegation('d-failed', { state: 'failed', createdAt: hoursAgo(0) })], [unresolved, unknown, ...settled])
  const before = structuredClone(value)
  const result = applyDelegationBudget(value, { mapId })
  assert.deepEqual(value, before, '입력 응답을 변경하지 않는다')
  assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length)
  assert.ok(result.responseBudget.returnedChars <= DELEGATION_RESPONSE_BUDGET_CHARS)
  assert.equal(result.responseBudget.exceeded, false)
  assert.deepEqual(result.responseBudget.appliedSteps, ['settledRequestFailureSummaries', 'settledRequestFailuresRemoved'])
  assert.deepEqual(result.delegations, before.delegations, '실패한 위임은 그대로 둔다')
  assert.deepEqual(result.requestFailures.slice(0, 2), before.requestFailures.slice(0, 2), '미해결 접수 실패는 그대로 둔다')
  const summary = result.requestFailures.find((item) => item.id === 'rf-0')
  assert.equal(summary.summary, true)
  assert.deepEqual(summary.retryVerification, { state: 'confirmed', method: 'same-instruction' })
  assert.equal(summary.resolvedByDelegationId, 'rf-0-retry')
  assert.equal(summary.reasonCode, 'AI_DELEGATION_VERSION_CONFLICT')
  assert.equal(summary.message, undefined)
  assert.equal(summary.resolution, undefined)
  const removed = Object.values(result.omitted.removedRequestFailuresByTarget).reduce((sum, count) => sum + count, 0)
  assert.ok(removed > 0)
  assert.equal(removed, result.omitted.counts.removedSettledRequestFailures)
  assert.equal(result.requestFailures.length + removed, 152)
  assert.ok(!result.requestFailures.some((item) => item.id === 'rf-149'), '오래된 정리된 접수 실패부터 뺀다')
  assert.equal(result.omitted.removedByTarget, undefined, '위임 개수와 섞지 않는다')
})

test('이력 규모와 관계없이 줄일 이력이 남아 있으면 최종 응답이 예산 안에 든다', () => {
  // 개수 기록과 안내를 덧붙인 뒤의 최종 크기가 예산을 넘지 않는지 여러 규모로 확인한다.
  let budgeted = 0
  for (let count = 20; count <= 240; count += 11) {
    const history = Array.from({ length: count }, (_, index) => delegation(`d-s-${index}`, { target: `card-${index % 7}`, createdAt: hoursAgo(index), result: 1500 + (index % 5) * 300 }))
    const failures = Array.from({ length: count % 40 }, (_, index) => requestFailure(`rf-s-${index}`, { target: `card-${index % 7}`, createdAt: hoursAgo(index) }))
    const result = applyDelegationBudget(response(history, failures), { mapId })
    if (!result.responseBudget) continue
    budgeted++
    assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length, `${count}건`)
    assert.ok(result.responseBudget.returnedChars <= DELEGATION_RESPONSE_BUDGET_CHARS, `${count}건: ${result.responseBudget.returnedChars}자`)
    assert.equal(result.responseBudget.exceeded, false, `${count}건`)
  }
  assert.ok(budgeted >= 15, `예산이 적용된 규모 ${budgeted}개`)
})
