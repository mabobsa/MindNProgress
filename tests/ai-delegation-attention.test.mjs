import assert from 'node:assert/strict'
import test from 'node:test'
import { aiDelegationStatusByCard } from '../src/utils/aiDelegationStatus.mjs'

test('현재 문서에서 진행 중이거나 복구 가능한 위임을 카드 상태로 만든다', () => {
  const result = aiDelegationStatusByCard([
    { id: 'recover-new', mapId: 'map-a', parentCardId: 'card-a', targetCardId: 'child-a', updatedAt: '2026-09-16T02:00:00.000Z', childError: '모델 용량 초과', recovery: { recoveryAvailable: true } },
    { id: 'recover-old', mapId: 'map-a', parentCardId: 'card-a', targetCardId: 'child-b', updatedAt: '2026-09-16T01:00:00.000Z', recovery: { recoveryAvailable: true } },
    { id: 'running', mapId: 'map-a', parentCardId: 'card-b', targetCardId: 'child-c', state: 'running', updatedAt: '2026-09-16T03:00:00.000Z', recovery: { recoveryAvailable: false } },
    { id: 'completed', mapId: 'map-a', parentCardId: 'card-b', targetCardId: 'child-d', updatedAt: '2026-09-16T01:00:00.000Z', state: 'completed', recovery: { recoveryAvailable: false } },
    { id: 'other-map', mapId: 'map-b', parentCardId: 'card-c', targetCardId: 'child-e', updatedAt: '2026-09-16T01:00:00.000Z', recovery: { recoveryAvailable: true } },
  ], 'map-a')

  assert.deepEqual(Object.keys(result), ['card-a', 'card-b'])
  assert.equal(result['card-a'].kind, 'recovery')
  assert.equal(result['card-a'].count, 2)
  assert.match(result['card-a'].title, /모델 용량 초과/)
  assert.equal(result['card-b'].kind, 'active')
  assert.equal(result['card-b'].activeCount, 1)
  assert.match(result['card-b'].title, /AI 위임 진행 1건/)
})

test('작업 재개가 없고 결과 재전달만 가능하면 별도 상태로 표시한다', () => {
  const result = aiDelegationStatusByCard([
    { id: 'report', mapId: 'map-a', parentCardId: 'card-a', targetCardId: 'child-a', updatedAt: '2026-09-16T02:00:00.000Z', recovery: { recoveryAvailable: false, reportRetryAvailable: true } },
  ], 'map-a')

  assert.equal(result['card-a'].kind, 'report')
  assert.equal(result['card-a'].reportCount, 1)
  assert.match(result['card-a'].title, /AI 결과 전달 필요 1건/)
})

test('재개와 결과 재전달이 함께 있으면 재개를 우선하고 나머지도 알린다', () => {
  const result = aiDelegationStatusByCard([
    { id: 'recover', mapId: 'map-a', parentCardId: 'card-a', targetCardId: 'child-a', updatedAt: '2026-09-16T02:00:00.000Z', recovery: { recoveryAvailable: true } },
    { id: 'report', mapId: 'map-a', parentCardId: 'card-a', targetCardId: 'child-b', updatedAt: '2026-09-16T01:00:00.000Z', recovery: { recoveryAvailable: false, reportRetryAvailable: true } },
  ], 'map-a')

  assert.equal(result['card-a'].kind, 'recovery')
  assert.equal(result['card-a'].count, 2)
  assert.equal(result['card-a'].recoveryCount, 1)
  assert.equal(result['card-a'].reportCount, 1)
  assert.match(result['card-a'].title, /AI 결과 전달 필요 1건/)
})

test('위임 현황은 위임한 상위 카드에만 표시하고 위임받은 하위 카드는 제외한다', () => {
  const result = aiDelegationStatusByCard([
    { id: 'cross-map', mapId: 'child-map', parentMapId: 'map-a', parentCardId: 'parent', targetCardId: 'child', state: 'waiting-workspace', updatedAt: '2026-09-16T02:00:00.000Z' },
    { id: 'same-card', mapId: 'map-a', parentMapId: 'map-a', parentCardId: 'same', targetCardId: 'same', state: 'running', updatedAt: '2026-09-16T01:00:00.000Z' },
  ], 'map-a')

  assert.equal(result.parent.activeCount, 1)
  assert.equal(result.child, undefined)
  assert.equal(result.same.count, 1)
})

test('자동 재개가 불가능한 격리 위임도 상위 카드의 복구 필요 건수에 포함한다', () => {
  const item = {
    id: 'quarantined', mapId: 'child-map', parentMapId: 'map-a', parentCardId: 'parent', targetCardId: 'child',
    state: 'failed', childStatus: 'completed', updatedAt: '2026-10-02T02:52:12.649Z',
    workspaceResult: { status: 'quarantined' }, workspaceError: '로컬 변경으로 통합 실패',
    recovery: { recoveryAvailable: false, failureCategory: 'non-retryable', recommendedAction: 'inspect-failure' },
  }
  const original = structuredClone(item)
  const result = aiDelegationStatusByCard([
    item,
    { id: 'active', mapId: 'map-a', parentCardId: 'parent', state: 'running' },
    { id: 'report', mapId: 'map-a', parentCardId: 'parent', state: 'parent-wake-failed', recovery: { recoveryAvailable: false, reportRetryAvailable: true } },
  ], 'map-a')

  assert.equal(result.parent.kind, 'recovery')
  assert.equal(result.parent.count, 3)
  assert.equal(result.parent.recoveryCount, 1)
  assert.equal(result.parent.activeCount, 1)
  assert.equal(result.parent.reportCount, 1)
  assert.match(result.parent.title, /AI 작업 복구 필요 1건/)
  assert.match(result.parent.title, /로컬 변경으로 통합 실패/)
  assert.equal(result.child, undefined)
  assert.deepEqual(item, original, '표시를 위해 자동 재개 가능 여부나 위임 기록을 바꾸지 않는다')
})

test('종료된 격리 이력과 변경이 보존되지 않은 일반 실패는 복구 배지를 남기지 않는다', () => {
  const items = ['completed', 'superseded', 'closed'].map((state) => ({
    id: state, mapId: 'map-a', parentCardId: 'parent', state,
    workspaceResult: { status: 'quarantined' }, recovery: { recoveryAvailable: false },
  }))
  items.push({ id: 'clean-failure', mapId: 'map-a', parentCardId: 'parent', state: 'failed', workspaceResult: { status: 'failed-clean' }, recovery: { recoveryAvailable: false } })

  assert.deepEqual(aiDelegationStatusByCard(items, 'map-a'), {})
})
