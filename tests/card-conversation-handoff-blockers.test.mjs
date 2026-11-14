import assert from 'node:assert/strict'
import test from 'node:test'
import { cardConversationHandoffBlockers, cardConversationHandoffBlockersSummary } from '../server/lib/cardConversationHandoffBlockers.mjs'

const conversationId = 'parent-chat'
const delegation = (patch) => ({ id: 'delegation', mapId: 'map', parentCardId: 'root', targetCardId: 'task', parentConversationId: conversationId,
  targetConversationId: 'child-chat', createdAt: '2026-11-11T00:00:00.000Z', ...patch })
const ids = (blockers) => blockers.map((item) => item.id)

test('끝난 실패·대체 위임은 인계를 막지 않고 진행 중·재개 가능·결과 보존 위임만 막는다', () => {
  const delegations = [
    // 2026-11-11 사례: 사고 강도 확인 실패로 시작 전에 거부되고 작업공간도 변경 없이 반납된 실패(후속 retry가 완료)
    delegation({ id: 'rejected-before-start', state: 'failed', childStatus: 'rejected',
      childError: '대상 대화에서 사고 강도 xhigh를 지원하는지 확인하지 못해 작업을 시작하지 않았습니다.', workspaceLease: { leaseId: 'cancelled-lease' } }),
    delegation({ id: 'retry-completed', state: 'completed', childStatus: 'completed', parentDispatchState: 'completed' }),
    delegation({ id: 'superseded', state: 'superseded' }),
    delegation({ id: 'closed', state: 'closed' }),
    delegation({ id: 'running', state: 'running' }),
    delegation({ id: 'parent-wake-failed', state: 'parent-wake-failed', childStatus: 'completed' }),
    // 한도 중단처럼 기존 작업 재개가 가능한 실패는 복구 보고가 이전 대화로 가지 않도록 막는다.
    delegation({ id: 'resumable-failure', state: 'failed', childStatus: 'failed', childError: 'usage limit',
      workspaceLease: { leaseId: 'released' }, workspaceResult: { status: 'failed-clean', childStatus: 'failed', childError: 'usage limit' } }),
    delegation({ id: 'preserved-workspace', state: 'failed', childStatus: 'completed', workspaceLease: { leaseId: 'kept' },
      workspaceResult: { status: 'quarantined', leaseId: 'kept', childStatus: 'completed', integrationBranch: null } }),
    delegation({ id: 'pending-recovery', state: 'failed', pendingRecovery: { operationId: 'recover-1' } }),
    delegation({ id: 'other-conversation', state: 'running', parentConversationId: 'other-parent' }),
  ]
  const blockers = cardConversationHandoffBlockers(conversationId, { delegations })
  assert.deepEqual(ids(blockers).sort(), ['parent-wake-failed', 'pending-recovery', 'preserved-workspace', 'resumable-failure', 'running'])
  assert.deepEqual(cardConversationHandoffBlockers(conversationId, { delegations: [delegations[0], delegations[1], delegations[2]] }), [])
  // 처리 중인 동작이 있으면 끝난 위임도 막는다.
  assert.deepEqual(ids(cardConversationHandoffBlockers(conversationId, { delegations: [delegations[0]], delegationActive: (id) => id === 'rejected-before-start' })),
    ['rejected-before-start'])
})

test('그룹 지시와 작업공간 lease는 기존 기준을 유지하고 막는 항목을 종류·ID·상태로 알려 준다', () => {
  const instructions = [
    { id: 'queued', state: 'queued', requestedConversationId: conversationId },
    { id: 'failed', state: 'failed', requestedConversationId: conversationId },
    { id: 'replied', state: 'replied', requestedConversationId: conversationId },
    { id: 'excluded', state: 'queued', requestedConversationId: conversationId },
  ]
  const leases = [
    { leaseId: 'lease-active', workspaceId: 'fork1', status: 'leased', conversationId },
    { leaseId: 'lease-done', workspaceId: 'fork2', status: 'cancelled', conversationId },
  ]
  const blockers = cardConversationHandoffBlockers(conversationId, { instructions, leases, excludedInstructionId: 'excluded',
    instructionActive: (id) => id === 'replied' })
  assert.deepEqual(blockers, [
    { kind: 'group-instruction', id: 'queued', state: 'queued' },
    { kind: 'group-instruction', id: 'replied', state: 'replied' },
    { kind: 'workspace-lease', id: 'lease-active', workspaceId: 'fork1', state: 'leased' },
  ])
  assert.equal(cardConversationHandoffBlockersSummary(blockers, 2), '그룹 지시 queued(queued), 그룹 지시 replied(replied) 외 1건')
})
