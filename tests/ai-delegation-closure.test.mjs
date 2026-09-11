import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aiDelegationCanBeSupersededBy,
  aiDelegationClosureAvailability,
  aiDelegationIsTerminal,
  aiDelegationWorkPending,
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

test('사용자 종료는 완료가 아니지만 미종료 작업 차단에서는 제외한다', () => {
  const closed = { ...completedAttempt, state: 'closed' }
  assert.equal(aiDelegationIsTerminal(closed), true)
  assert.equal(aiDelegationWorkPending(closed), false)
  assert.equal(aiDelegationClosureAvailability(closed), null)
})
