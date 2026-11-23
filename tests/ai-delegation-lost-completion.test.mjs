import assert from 'node:assert/strict'
import test from 'node:test'
import { aiDelegationFinalizedOwnLease, aiDelegationLostCompletionResumable } from '../server/lib/aiDelegations.mjs'

// 2026-11-23 실제 사례: 검수 위임의 작업공간 마무리(lease completed)는 끝났지만 같은 확인 주기에서 위임 완료 저장이 실패했다.
// 다음 주기의 lease 대조가 끝난 lease에 다시 연결하려다 충돌로 판단해 recovery-required가 됐고, 복구·종료도 거부됐다.
const workspaceLease = { poolId: 'pool', workspaceId: 'fork4', jobId: 'job-1', leaseId: 'lease-1', projectRoot: 'C:\\pool\\fork4\\client', branch: 'mnp/job-1' }
const delegation = (overrides = {}) => ({
  id: 'review-1', childOperationId: 'review-1', state: 'running', targetConversationId: 'conversation-1',
  childTurnId: 'turn-1', workspaceLease, ...overrides,
})
const finalizedLease = (overrides = {}) => ({
  leaseId: 'lease-1', workspaceId: 'fork4', jobId: 'job-1', conversationId: 'conversation-1', status: 'completed',
  result: { status: 'completed', childStatus: 'completed', leaseId: 'lease-1' }, ...overrides,
})
const dispatch = (overrides = {}) => ({ operationId: 'review-1', state: 'completed', turnId: 'turn-1', workspaceLease: { ...workspaceLease }, ...overrides })

test('이 위임이 마무리까지 마친 로컬 lease만 완료 처리를 이어갈 근거로 쓴다', () => {
  const lease = finalizedLease()
  assert.equal(aiDelegationFinalizedOwnLease(delegation(), { leases: { 'lease-1': lease }, delegations: [delegation()] }), lease)
  for (const [label, leases, delegations, target] of [
    ['lease 없음', {}, [], delegation()],
    ['아직 진행 중인 lease', { 'lease-1': finalizedLease({ status: 'leased' }) }, [], delegation()],
    ['완료가 아닌 마무리 결과', { 'lease-1': finalizedLease({ result: { status: 'failed-clean' } }) }, [], delegation()],
    ['다른 job', { 'lease-1': finalizedLease({ jobId: 'job-2' }) }, [], delegation()],
    ['다른 작업공간', { 'lease-1': finalizedLease({ workspaceId: 'fork5' }) }, [], delegation()],
    ['다른 대화', { 'lease-1': finalizedLease({ conversationId: 'conversation-2' }) }, [], delegation()],
    ['원격 풀 lease', { 'lease-1': lease }, [], delegation({ workspaceLease: { ...workspaceLease, ownership: { coordinatorId: 'c' } } })],
    ['같은 lease를 쓰는 다른 진행 중 위임', { 'lease-1': lease }, [delegation(), delegation({ id: 'other', state: 'running' })], delegation()],
  ]) assert.equal(aiDelegationFinalizedOwnLease(target, { leases, delegations }), null, label)
  assert.equal(aiDelegationFinalizedOwnLease(delegation(), { leases: { 'lease-1': lease },
    delegations: [delegation({ id: 'old', state: 'completed' })] }), lease, '끝난 다른 위임은 막지 않는다')
})

test('lease 충돌로 복구 필요가 된 위임은 같은 실행이 같은 lease로 끝났을 때만 다시 실행 없이 완료를 이어간다', () => {
  const stuck = delegation({ state: 'recovery-required', childStatus: 'interrupted-by-workspace-conflict' })
  const lease = finalizedLease()
  assert.equal(aiDelegationLostCompletionResumable(stuck, lease, dispatch()), true)
  assert.equal(aiDelegationLostCompletionResumable(stuck, lease, dispatch({ state: 'failed' })), true, '실패로 끝난 실행도 기존 완료 경로로 처리한다')
  for (const [label, target, finalized, status] of [
    ['마무리된 lease 없음', stuck, null, dispatch()],
    ['다른 복구 사유', { ...stuck, childStatus: 'interrupted-by-restart' }, lease, dispatch()],
    ['복구 필요 상태가 아님', { ...stuck, state: 'running' }, lease, dispatch()],
    ['다른 복구 진행 중', { ...stuck, pendingRecovery: { operationId: 'x' } }, lease, dispatch()],
    ['결과 정정 중', { ...stuck, resultCorrection: { phase: 'held' } }, lease, dispatch()],
    ['아직 실행 중', stuck, lease, dispatch({ state: 'running' })],
    ['다른 실행', stuck, lease, dispatch({ operationId: 'other-op' })],
    ['다른 lease', stuck, lease, dispatch({ workspaceLease: { ...workspaceLease, leaseId: 'lease-2' } })],
    ['다른 턴', stuck, lease, dispatch({ turnId: 'turn-2' })],
    ['조회 응답 없음', stuck, lease, null],
  ]) assert.equal(aiDelegationLostCompletionResumable(target, finalized, status), false, label)
})
