import assert from 'node:assert/strict'
import test from 'node:test'
import { nextOverlappingNodeId, nodeOverlapPresentation } from '../src/utils/nodeOverlap.mjs'

function card(id, x, y, width = 100, height = 60) {
  return { id, title: `카드 ${id}`, x, y, width, height }
}

test('사각형이 1px만 교차하면 부분 겹침으로 표시하지 않는다', () => {
  const result = nodeOverlapPresentation([card('a', 0, 0), card('b', 99, 0)])

  assert.deepEqual(result.warningIds, [])
  assert.deepEqual(result.stacks, [])
})

test('맵 좌표 기준 5px 이상 실제로 교차하는 카드를 확대 비율과 무관하게 표시한다', () => {
  const zoomedOut = nodeOverlapPresentation([card('a', 0, 0), card('b', 95, 0)], { zoom: 0.25 })
  const zoomedIn = nodeOverlapPresentation([card('a', 0, 0), card('b', 95, 0)], { zoom: 2 })

  assert.deepEqual(zoomedOut.warningIds, ['a', 'b'])
  assert.deepEqual(zoomedIn.warningIds, ['a', 'b'])
})

test('맵 좌표 기준 교차 폭이나 높이가 5px보다 작으면 표시하지 않는다', () => {
  const narrowWidth = nodeOverlapPresentation([card('a', 0, 0), card('b', 95.1, 0)], { zoom: 1 })
  const narrowHeight = nodeOverlapPresentation([card('a', 0, 0), card('b', 0, 55.1)], { zoom: 1 })

  assert.deepEqual(narrowWidth.warningIds, [])
  assert.deepEqual(narrowHeight.warningIds, [])
})

test('실제로 떨어진 카드는 가까워도 표시하지 않는다', () => {
  const result = nodeOverlapPresentation([card('a', 0, 0), card('b', 101, 0)], { zoom: 1 })

  assert.deepEqual(result.warningIds, [])
})

test('같은 위치와 크기의 카드는 겹침 묶음으로 만들고 맨 위 카드를 대표로 삼는다', () => {
  const result = nodeOverlapPresentation([
    card('a', 0, 0),
    card('b', 0.2, 0.2),
    card('c', 0.4, 0.4),
  ])

  assert.deepEqual(result.warningIds, ['a', 'b', 'c'])
  assert.deepEqual(result.stacks, [{
    ids: ['a', 'b', 'c'],
    titles: ['카드 a', '카드 b', '카드 c'],
    representativeId: 'c',
  }])
})

test('겹침 묶음에서 선택한 카드를 배지 대표로 삼는다', () => {
  const result = nodeOverlapPresentation([card('a', 0, 0), card('b', 0, 0)], { selectedId: 'a' })

  assert.equal(result.stacks[0].representativeId, 'a')
})

test('서로 직접 포개지지 않은 카드를 전이 관계만으로 같은 묶음에 넣지 않는다', () => {
  const result = nodeOverlapPresentation([
    card('a', 0, 0),
    card('b', 0.75, 0),
    card('c', 1.5, 0),
  ])

  assert.deepEqual(result.stacks.map((stack) => stack.ids), [['a', 'b']])
  assert.deepEqual(result.warningIds, ['a', 'b', 'c'])
})

test('겹친 카드는 현재 선택 다음 순서로 순환한다', () => {
  const ids = ['a', 'b', 'c']

  assert.equal(nextOverlappingNodeId(ids), 'a')
  assert.equal(nextOverlappingNodeId(ids, 'a'), 'b')
  assert.equal(nextOverlappingNodeId(ids, 'c'), 'a')
})
