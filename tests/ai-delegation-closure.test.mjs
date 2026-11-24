import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aiDelegationCanBeSupersededBy,
  aiDelegationClosureAvailability,
  aiDelegationDeletedTargetReleaseCandidate,
  aiDelegationIsTerminal,
  aiDelegationRecoveryAvailability,
  aiDelegationWorkPending,
  laterCompletedDelegationForCard,
  preservedIntegrationReleaseClosure,
  reconcilePreservedReleaseClosures,
} from '../server/lib/aiDelegations.mjs'

const completedAttempt = {
  id: 'old-report', state: 'parent-wake-failed', mapId: 'map-a',
  parentCardId: 'root-a', targetCardId: 'task-a',
  parentConversationId: 'old-parent', targetConversationId: 'removed-child',
  createdAt: '2026-09-01T00:00:00.000Z', childStatus: 'completed',
  workspaceLease: { leaseId: 'lease-a' }, workspaceResult: { status: 'completed' },
}

const replacement = {
  ...completedAttempt,
  id: 'replacement', state: 'completed',
  parentConversationId: 'new-parent', targetConversationId: 'new-child',
  createdAt: '2026-09-02T00:00:00.000Z', parentDispatchState: 'completed',
}

test('완료 후 보고 실패 기록은 대화가 달라도 같은 카드의 후속 성공으로 종료할 수 있다', () => {
  assert.equal(aiDelegationCanBeSupersededBy(completedAttempt, replacement), true)
  assert.deepEqual(aiDelegationClosureAvailability(completedAttempt), {
    closeAvailable: true,
    reason: 'completed-child-report-abandonment',
  })
})

test('그룹 위임은 기존 그룹 복구 흐름을 사용하고 일반 문서 사용자 종료로 우회하지 않는다', () => {
  const grouped = { ...completedAttempt, groupId: 'group-a' }
  assert.deepEqual(aiDelegationClosureAvailability(grouped), {
    closeAvailable: false,
    reason: 'group-managed',
  })
  assert.equal(aiDelegationCanBeSupersededBy(grouped, { ...replacement, groupId: 'group-a' }), false)
})

test('변경이 보존된 한도 중단은 사용자 종료를 막고 변경 없는 중단만 허용한다', () => {
  const waiting = {
    ...completedAttempt,
    state: 'waiting-usage-limit', childStatus: 'failed',
    childError: 'usage limit', workspaceResult: { status: 'quarantined' },
  }
  assert.equal(aiDelegationClosureAvailability(waiting)?.closeAvailable, false)
  assert.equal(aiDelegationClosureAvailability({ ...waiting, workspaceResult: { status: 'failed-clean' } })?.closeAvailable, true)
})

test('대상 대화 삭제가 확인된 한도 대기 위임만 격리 작업공간 반환 종료 후보로 표시한다', () => {
  const waiting = {
    ...completedAttempt, state: 'waiting-usage-limit', childStatus: 'failed', childError: 'usage limit', targetHomeMachineId: 'macbook',
    workspaceLease: { leaseId: 'lease-a', ownership: { machineId: 'macbook' } }, workspaceResult: { status: 'quarantined', leaseId: 'lease-a' },
  }
  const evidence = { conversationId: 'removed-child', machineId: 'macbook', observedAt: '2026-11-24T10:20:00.000Z', source: 'refresh' }
  // 삭제 근거가 없으면 기존처럼 보존 변경으로 막고, 근거 없이도 조회 대상인지만 따로 판단한다.
  assert.deepEqual(aiDelegationClosureAvailability(waiting), { closeAvailable: false, reason: 'workspace-changes-preserved' })
  assert.equal(aiDelegationDeletedTargetReleaseCandidate(waiting), false)
  assert.equal(aiDelegationDeletedTargetReleaseCandidate(waiting, { requireEvidence: false }), true)
  const deleted = { ...waiting, targetConversationMissing: evidence }
  assert.deepEqual(aiDelegationClosureAvailability(deleted),
    { closeAvailable: true, reason: 'target-conversation-deleted', workspaceReleaseRequired: true, targetDeletedRelease: true })
  for (const state of ['waiting-rate-limit', 'waiting-model-capacity']) {
    assert.equal(aiDelegationClosureAvailability({ ...deleted, state }).reason, 'target-conversation-deleted', state)
  }
  // 다른 대화·다른 머신·시각 없는 근거, 다른 lease의 격리 결과는 반환 후보가 아니다.
  for (const variant of [
    { targetConversationMissing: { ...evidence, conversationId: 'other-child' } },
    { targetConversationMissing: { ...evidence, machineId: 'other-machine' } },
    { targetConversationMissing: { ...evidence, observedAt: null } },
    { workspaceResult: { status: 'quarantined', leaseId: 'lease-other' } },
  ]) assert.equal(aiDelegationClosureAvailability({ ...deleted, ...variant }).reason, 'workspace-changes-preserved', JSON.stringify(variant))
  // 그룹 위임과 실행 중인 위임은 기존 판정을 그대로 따른다.
  assert.equal(aiDelegationClosureAvailability({ ...deleted, groupId: 'group-a' }).reason, 'group-managed')
  assert.equal(aiDelegationClosureAvailability({ ...deleted, state: 'running' }).reason, 'execution-or-recovery-still-active')
  assert.equal(aiDelegationDeletedTargetReleaseCandidate({ ...deleted, pendingRecovery: { id: 'r' } }), false)
  // 변경 없는 한도 중단은 기존 종료 경로를 그대로 쓴다.
  assert.deepEqual(aiDelegationClosureAvailability({ ...deleted, workspaceResult: { status: 'failed-clean' } }),
    { closeAvailable: true, reason: 'failed-child-no-preserved-changes' })
})

test('사용자 종료는 완료가 아니지만 미종료 작업 차단에서는 제외한다', () => {
  const closed = { ...completedAttempt, state: 'closed' }
  assert.equal(aiDelegationIsTerminal(closed), true)
  assert.equal(aiDelegationWorkPending(closed), false)
  assert.equal(aiDelegationClosureAvailability(closed), null)
})

test('완료 실행의 로컬 변경 통합 실패만 명시적 결과 보존 반환 후보로 표시한다', () => {
  const failed = { ...completedAttempt, state: 'failed', workspaceResult: { status: 'quarantined', childStatus: 'completed',
    integrationBranch: 'mnp/integrate/job', integrationBaseCommit: 'base',
    error: `Command failed: git -c core.autocrlf=false cherry-pick ${'a'.repeat(40)}\nerror: Your local changes would be overwritten by merge:\nfile` } }
  assert.equal(aiDelegationClosureAvailability(failed)?.workspaceReleaseRequired, true)
  for (const patch of [{ groupId: 'group' }, { workspaceLease: { leaseId: 'remote', ownership: {} } },
    { pendingRecovery: {} }, { integrationRecoveryRequest: { status: 'checking' } },
    { workspaceResult: { ...failed.workspaceResult, childStatus: 'failed' } },
    { workspaceResult: { ...failed.workspaceResult, unmergedFiles: ['conflict'] } }]) {
    assert.notEqual(aiDelegationClosureAvailability({ ...failed, ...patch })?.workspaceReleaseRequired, true)
  }
  assert.equal(aiDelegationCanBeSupersededBy(failed, replacement), false, '후속 성공만으로 자동 반환하지 않는다.')
})

test('풀 반환 후 위임 저장 전 중단은 귀속이 일치하는 반환 receipt로만 종료 대사한다', () => {
  const failed = { ...completedAttempt, state: 'failed', workspaceResult: { status: 'quarantined', childStatus: 'completed',
    headCommit: 'source', integrationBranch: 'mnp/integrate/job', integrationBaseCommit: 'base',
    error: `Command failed: git cherry-pick ${'a'.repeat(40)}\nerror: Your local changes would be overwritten by merge:\nfile` } }
  const scope = { leaseId: 'lease-a', jobId: 'job-a', mapId: failed.mapId, cardId: failed.targetCardId, conversationId: failed.targetConversationId }
  const lease = { ...scope, status: 'cancelled', result: { ...scope, status: 'released-preserved', integratedCommit: null,
    previousResult: failed.workspaceResult, preservedRelease: { phase: 'released', sourceHead: 'source', reason: '승인된 반환', releasedAt: '2026-10-14', approvedByOperator: 'NHN' } } }
  const patch = preservedIntegrationReleaseClosure(failed, lease)
  assert.equal(patch.state, 'closed')
  assert.equal(patch.closedByOperator, 'NHN')
  assert.deepEqual(patch.workspaceResult.previousResult, failed.workspaceResult)
  for (const invalid of [{ ...lease, status: 'quarantined' }, { ...lease, conversationId: 'other' },
    { ...lease, result: { ...lease.result, leaseId: 'other' } },
    { ...lease, result: { ...lease.result, previousResult: { headCommit: 'different' } } }]) {
    assert.equal(preservedIntegrationReleaseClosure(failed, invalid), null)
  }
  assert.equal(preservedIntegrationReleaseClosure({ ...failed, state: 'running' }, lease), null)
  assert.equal(preservedIntegrationReleaseClosure({ ...failed, ...patch }, lease), null)
})

const quarantinedBeforeIntegration = { ...completedAttempt, state: 'failed', workspaceResult: { status: 'quarantined', leaseId: 'lease-a',
  childStatus: 'completed', headCommit: null, integrationBranch: null, integratedCommit: null, unmergedFiles: [],
  error: "EBUSY: resource busy or locked, unlink 'C:\\fork2\\Assets\\nhncef_core.log'" } }

test('통합 전에 격리되고 지원 복구가 없는 실패 위임만 격리 작업공간 결과 보존 반환 후보로 표시한다', () => {
  assert.deepEqual(aiDelegationClosureAvailability(quarantinedBeforeIntegration), {
    closeAvailable: true, reason: 'preserve-quarantined-result', workspaceReleaseRequired: true, quarantinedRelease: true,
  })
  const childFailed = { ...quarantinedBeforeIntegration, childStatus: 'failed', workspaceResult: { ...quarantinedBeforeIntegration.workspaceResult,
    childStatus: 'failed', headCommit: 'base', childError: 'Failed to authenticate: OAuth token revoked. Please log in again.' } }
  assert.equal(aiDelegationClosureAvailability(childFailed)?.quarantinedRelease, true, '인증 실패처럼 재개 대상이 아닌 하위 실패도 반환할 수 있다')
  for (const patch of [{ groupId: 'group' }, { pendingRecovery: {} }, { resultCorrection: { phase: 'held' } },
    { workspaceLease: { leaseId: 'lease-a', ownership: {} } }, { workspaceLease: { leaseId: 'other-lease' } },
    { integrationRecoveryRequest: { status: 'checking' } },
    { workspaceResult: { ...quarantinedBeforeIntegration.workspaceResult, integrationBranch: 'mnp/integrate/job' } },
    { workspaceResult: { ...quarantinedBeforeIntegration.workspaceResult, integratedCommit: 'merged' } },
    { workspaceResult: { ...quarantinedBeforeIntegration.workspaceResult, status: 'waiting-integration' } },
    { state: 'running' }]) {
    assert.notEqual(aiDelegationClosureAvailability({ ...quarantinedBeforeIntegration, ...patch })?.quarantinedRelease, true, JSON.stringify(patch))
  }
  // 한도 중단처럼 기존 작업 재개가 가능한 실패는 반환 대신 재개 경로를 유지한다.
  const resumable = { ...childFailed, childError: 'usage limit', workspaceResult: { ...childFailed.workspaceResult, childError: 'usage limit' } }
  assert.equal(aiDelegationRecoveryAvailability(resumable)?.recoveryAvailable, true)
  assert.notEqual(aiDelegationClosureAvailability(resumable)?.quarantinedRelease, true)
})

test('격리 반환 receipt는 이전 결과에 HEAD가 없어도 반환 당시의 이전 HEAD로 종료를 대사한다', () => {
  const scope = { leaseId: 'lease-a', jobId: 'job-a', mapId: completedAttempt.mapId, cardId: completedAttempt.targetCardId, conversationId: completedAttempt.targetConversationId }
  const receipt = { kind: 'quarantined-release', phase: 'released', sourceRef: 'refs/mnp/preserved-results/job-a/source', sourceHead: 'checkpoint',
    previousHeadCommit: null, reason: '후속 재적용 위임이 통합해 반환합니다.', releasedAt: '2026-11-08', approvedByUserId: 'user-editor' }
  const lease = { ...scope, status: 'cancelled', result: { ...scope, status: 'released-preserved', integratedCommit: null,
    previousResult: quarantinedBeforeIntegration.workspaceResult, preservedRelease: receipt } }
  const patch = preservedIntegrationReleaseClosure(quarantinedBeforeIntegration, lease)
  assert.equal(patch.state, 'closed')
  assert.equal(patch.closedByUserId, 'user-editor')
  assert.equal(preservedIntegrationReleaseClosure(quarantinedBeforeIntegration,
    { ...lease, result: { ...lease.result, preservedRelease: { ...receipt, previousHeadCommit: 'different' } } }), null)
})

test('반환은 저장됐지만 위임 종료가 빠진 기록만 주기 대사로 종료하고 처리 중인 위임은 다음 주기로 미룬다', async () => {
  const scope = { leaseId: 'lease-a', jobId: 'job-a', mapId: completedAttempt.mapId, cardId: completedAttempt.targetCardId, conversationId: completedAttempt.targetConversationId }
  const released = { ...scope, status: 'cancelled', result: { ...scope, status: 'released-preserved', integratedCommit: null,
    previousResult: quarantinedBeforeIntegration.workspaceResult, preservedRelease: { kind: 'quarantined-release', phase: 'released',
      sourceHead: 'checkpoint', previousHeadCommit: null, reason: '요청이 끊겨 종료가 빠진 반환', releasedAt: '2026-11-08', approvedByUserId: 'user-editor' } } }
  const pending = { ...quarantinedBeforeIntegration, id: 'pending-release' }
  const stillQuarantined = { ...quarantinedBeforeIntegration, id: 'still-quarantined', workspaceLease: { leaseId: 'lease-b' },
    workspaceResult: { ...quarantinedBeforeIntegration.workspaceResult, leaseId: 'lease-b' } }
  const alreadyClosed = { ...pending, id: 'already-closed', state: 'closed' }
  const leases = { 'lease-a': released, 'lease-b': { ...released, leaseId: 'lease-b', status: 'quarantined', result: stillQuarantined.workspaceResult } }
  const updates = []
  const run = (busy) => reconcilePreservedReleaseClosures({ delegations: [pending, stillQuarantined, alreadyClosed],
    leaseFor: (leaseId) => leases[leaseId], busy, update: async (id, patch) => { updates.push({ id, patch }) } })
  assert.deepEqual(await run((id) => id === 'pending-release'), [], '처리 중인 요청의 위임은 건드리지 않는다')
  assert.deepEqual(await run(), ['pending-release'])
  assert.equal(updates.length, 1)
  assert.equal(updates[0].patch.state, 'closed')
  assert.equal(updates[0].patch.closedByUserId, 'user-editor')
  assert.equal(updates[0].patch.closureNote, '요청이 끊겨 종료가 빠진 반환')
})

test('같은 카드에서 나중에 성공한 위임만 이전 실패의 후속 완료로 찾는다', () => {
  const failed = { ...quarantinedBeforeIntegration, parentDispatchState: undefined }
  const reapplied = { ...failed, id: 'reapply', state: 'completed', createdAt: '2026-09-03T00:00:00.000Z', childStatus: 'completed',
    parentDispatchState: 'completed', workspaceResult: { status: 'completed', integratedCommit: 'merged' } }
  assert.equal(laterCompletedDelegationForCard(failed, [failed, reapplied])?.id, 'reapply')
  for (const other of [{ ...reapplied, targetCardId: 'task-b' }, { ...reapplied, parentCardId: 'root-b' },
    { ...reapplied, createdAt: '2026-08-31T00:00:00.000Z' }, { ...reapplied, state: 'failed' }]) {
    assert.equal(laterCompletedDelegationForCard(failed, [failed, other]), null, JSON.stringify(other))
  }
})
