import test from 'node:test'
import assert from 'node:assert/strict'
import { completedReplacementDelegations } from '../src/utils/aiDelegationManagement.mjs'

const delegation = (id, state, createdAt, overrides = {}) => ({
  id, state, createdAt, updatedAt: createdAt,
  mapId: 'map-a', parentCardId: 'root-a', targetCardId: 'task-a',
  ...overrides,
})

test('후속 성공 후보는 대화 ID가 달라도 같은 카드 범위의 가장 가까운 완료부터 제시한다', () => {
  const original = delegation('original', 'parent-wake-failed', '2026-09-01T00:00:00.000Z', { targetConversationId: 'removed', workCompleted: true })
  const later = delegation('later', 'completed', '2026-09-03T00:00:00.000Z', { workCompleted: true, targetConversationId: 'newer' })
  const closest = delegation('closest', 'completed', '2026-09-02T00:00:00.000Z', { workCompleted: true, targetConversationId: 'replacement' })
  const otherCard = delegation('other-card', 'completed', '2026-09-02T00:00:00.000Z', { workCompleted: true, targetCardId: 'task-b' })
  assert.deepEqual(completedReplacementDelegations(original, [later, otherCard, closest]).map((item) => item.id), ['closest', 'later'])
})

test('그룹 위임과 변경이 보존된 한도 중단에는 일반 문서 종료 후보를 제시하지 않는다', () => {
  const completed = delegation('completed', 'completed', '2026-09-02T00:00:00.000Z', { workCompleted: true })
  const grouped = delegation('grouped', 'parent-wake-failed', '2026-09-01T00:00:00.000Z', { groupId: 'group-a', workCompleted: true })
  const quarantined = delegation('quarantined', 'waiting-usage-limit', '2026-09-01T00:00:00.000Z', {
    workspaceLease: { leaseId: 'lease-a' }, workspaceResult: { status: 'quarantined' },
  })
  assert.deepEqual(completedReplacementDelegations(grouped, [{ ...completed, groupId: 'group-a' }]), [])
  assert.deepEqual(completedReplacementDelegations(quarantined, [completed]), [])
})
