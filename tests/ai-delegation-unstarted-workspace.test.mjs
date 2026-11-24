import assert from 'node:assert/strict'
import test from 'node:test'
import { aiDelegationUnstartedWorkspaceEvidence } from '../server/lib/aiDelegationUnstartedWorkspace.mjs'

const ownership = { coordinatorId: 'mnp-coordinator', machineId: 'macbook', poolId: 'unity-macbook', generation: 1 }
const lease = { leaseId: 'lease-1', jobId: 'job-1', workspaceId: 'fork1', projectRoot: '/Users/test/fork1', branch: 'mnp/job-1',
  baseCommit: 'a'.repeat(40), baselineCommit: 'b'.repeat(40), baselineMode: 'delta', ownership, poolId: 'unity-macbook',
  requestId: 'v512-event', mapId: 'map', cardId: 'card', conversationId: '898ff574' }
const delegation = { id: 'v512-event', childOperationId: 'v512-event', state: 'failed', childStatus: 'rejected',
  failureReasonCode: 'AI_DELEGATION_POLICY_RUNTIME_UNAVAILABLE', targetHomeMachineId: 'macbook', mapId: 'map',
  targetCardId: 'card', targetConversationId: '898ff574', workspaceLease: { ...lease, status: 'leased' } }

test('실행 전 정책 실패 위임은 결과 없는 작업공간 반환 근거를 충족한다', () => {
  assert.equal(aiDelegationUnstartedWorkspaceEvidence(delegation, lease, { machineId: 'macbook' }), true)
  assert.equal(aiDelegationUnstartedWorkspaceEvidence({ ...delegation, failureReasonCode: 'AI_DELEGATION_PRIMARY_CHANGED' }, lease, { machineId: 'macbook' }), true)
})

test('하위 실행·결과·복구 흔적이나 다른 귀속이 있으면 반환 근거로 보지 않는다', () => {
  const rejected = [
    { childTurnId: 'turn-1' }, { childResultHash: 'c'.repeat(64) }, { childResultSnapshot: { text: '결과' } }, { childResultTurnId: 'turn-1' },
    { state: 'running' }, { childStatus: 'failed' }, { failureReasonCode: 'AI_DELEGATION_DISPATCH_FAILED' }, { failureReasonCode: null },
    { pendingRecovery: { requestedAt: 'now' } }, { resumesDelegationId: 'v511-event' }, { recoveryAttempt: 1 }, { recoveryOperationId: 'recover-1' },
    { recoveryWorkspaceLease: { leaseId: 'lease-2' } }, { workspaceResult: { status: 'quarantined' } }, { targetConversationId: 'other' },
    { childOperationId: 'other-operation' }, { targetHomeMachineId: 'other-machine' }, { targetCardId: 'other-card' },
    { workspaceLease: { ...lease, ownership: { ...ownership, generation: 2 } } }, { workspaceLease: { ...lease, baseCommit: 'd'.repeat(40) } },
    { workspaceLease: null },
  ]
  for (const patch of rejected) {
    assert.equal(aiDelegationUnstartedWorkspaceEvidence({ ...delegation, ...patch }, lease, { machineId: 'macbook' }), false, JSON.stringify(patch))
  }
  assert.equal(aiDelegationUnstartedWorkspaceEvidence(delegation, lease, { machineId: 'other-machine' }), false)
  assert.equal(aiDelegationUnstartedWorkspaceEvidence(delegation, { ...lease, requestId: 'other' }, { machineId: 'macbook' }), false)
  assert.equal(aiDelegationUnstartedWorkspaceEvidence(delegation, lease, {}), false)
  assert.equal(aiDelegationUnstartedWorkspaceEvidence(null, lease, { machineId: 'macbook' }), false)
})
