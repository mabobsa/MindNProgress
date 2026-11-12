import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCoordinatorArchiveAllowed } from '../server/lib/coordinatorArchive.mjs'

const fixture = (extra = {}) => ({ group: { id: 'group-history', mapIds: ['map-coordinator'] },
  coordinatorMapId: 'map-coordinator', delegations: [], documentInstructions: [], ...extra })

test('다른 활성 문서가 없는 총괄은 종료 이력을 보존한 채 보관할 수 있다', () => {
  const input = fixture({
    delegations: ['completed', 'failed', 'superseded', 'closed'].map(state => ({ groupId: 'group-history', state })),
    documentInstructions: ['replied', 'expired', 'failed', 'cancelled', 'closed'].map(state => ({ groupId: 'group-history', state })),
  })
  const before = structuredClone(input)
  assert.doesNotThrow(() => assertCoordinatorArchiveAllowed(input))
  assert.deepEqual(input, before)
})

test('다른 활성 문서가 있으면 총괄 보관을 막는다', () => {
  assert.throws(() => assertCoordinatorArchiveAllowed(fixture({
    group: { id: 'group-history', mapIds: ['map-coordinator', 'map-child'] },
  })), { code: 'RECONSTRUCTION_COORDINATOR' })
})

for (const state of ['waiting-workspace', 'running', 'waiting-parent', 'recovery-required']) {
  test(`${state} 위임은 대상 문서가 그룹을 떠났어도 총괄 보관을 막는다`, () => {
    assert.throws(() => assertCoordinatorArchiveAllowed(fixture({ delegations: [
      { id: 'active-job', groupId: 'group-history', mapId: 'map-moved', state },
    ] })), { code: 'RECONSTRUCTION_AI_BUSY' })
  })
}

test('종료 상태에서도 복구나 실행 처리가 진행 중이면 보관하지 않는다', () => {
  const item = { id: 'job', parentMapId: 'map-coordinator', groupId: 'group-other', state: 'failed' }
  for (const extra of [
    { delegations: [{ ...item, pendingRecovery: {} }] },
    { delegations: [item], delegationInFlight: () => true },
  ]) assert.throws(() => assertCoordinatorArchiveAllowed(fixture(extra)), { code: 'RECONSTRUCTION_AI_BUSY' })
})

for (const state of ['queued', 'delivered', 'reply-pending', 'unknown']) {
  test(`${state} 문서 지시는 총괄 보관 전에 전달·회신을 끝내야 한다`, () => {
    assert.throws(() => assertCoordinatorArchiveAllowed(fixture({ documentInstructions: [
      { id: 'instruction', groupId: 'group-history', state },
    ] })), { code: 'RECONSTRUCTION_GROUP_INSTRUCTION_BUSY' })
  })
}

test('다른 그룹에서 온 지시와 종료 직후 진행 중인 처리도 확인한다', () => {
  for (const extra of [
    { documentInstructions: [{ id: 'instruction', groupId: 'group-other', targetMapId: 'map-coordinator', state: 'delivered' }] },
    { documentInstructions: [{ id: 'instruction', groupId: 'group-history', state: 'replied' }], instructionInFlight: () => true },
  ]) assert.throws(() => assertCoordinatorArchiveAllowed(fixture(extra)), { code: 'RECONSTRUCTION_GROUP_INSTRUCTION_BUSY' })
  assert.doesNotThrow(() => assertCoordinatorArchiveAllowed(fixture({
    delegations: [{ groupId: 'group-other', mapId: 'map-other', state: 'running' }],
    documentInstructions: [{ groupId: 'group-other', targetMapId: 'map-other', state: 'queued' }],
  })))
})
