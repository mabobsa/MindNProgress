import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectDragDescendantIds,
  collectDragDescendantOwners,
  dragRootIds,
  hierarchyReparentPairs,
} from '../src/utils/hierarchyDrag.mjs'

// root ─┬─ mid-a ─┬─ leaf-a1
//       │         └─ leaf-a2 ── leaf-a2-child
//       ├─ mid-b ─── leaf-b1
//       └─ mid-c ─── leaf-c1
const edges = [
  { source: 'root', target: 'mid-a' },
  { source: 'root', target: 'mid-b' },
  { source: 'root', target: 'mid-c' },
  { source: 'mid-a', target: 'leaf-a1' },
  { source: 'mid-a', target: 'leaf-a2' },
  { source: 'leaf-a2', target: 'leaf-a2-child' },
  { source: 'mid-b', target: 'leaf-b1' },
  { source: 'mid-c', target: 'leaf-c1' },
]

test('중간 계층 카드 하나를 끌면 그 아래만 따라온다', () => {
  const roots = dragRootIds('mid-a', [])
  assert.deepEqual([...roots], ['mid-a'])
  assert.deepEqual([...collectDragDescendantIds(roots, edges)].sort(), ['leaf-a1', 'leaf-a2', 'leaf-a2-child'])
})

test('선택한 카드 2개를 함께 끌면 각각의 하위가 모두 따라온다', () => {
  const roots = dragRootIds('mid-a', ['mid-a', 'mid-b'])
  assert.deepEqual([...roots].sort(), ['mid-a', 'mid-b'])
  assert.deepEqual([...collectDragDescendantIds(roots, edges)].sort(), [
    'leaf-a1',
    'leaf-a2',
    'leaf-a2-child',
    'leaf-b1',
  ])
})

test('선택하지 않은 카드를 끌면 선택 상태를 무시하고 그 카드만 기준으로 삼는다', () => {
  const roots = dragRootIds('mid-c', ['mid-a', 'mid-b'])
  assert.deepEqual([...roots], ['mid-c'])
  assert.deepEqual([...collectDragDescendantIds(roots, edges)], ['leaf-c1'])
})

test('함께 끄는 카드는 다른 카드의 하위로 잡지 않는다', () => {
  // mid-a와 그 자식 leaf-a2를 같이 선택한 경우 leaf-a2는 자기 위치로 움직인다.
  const roots = dragRootIds('mid-a', ['mid-a', 'leaf-a2'])
  const descendants = collectDragDescendantIds(roots, edges)
  assert.equal(descendants.has('leaf-a2'), false)
  // 선택한 카드의 하위는 그대로 따라온다.
  assert.equal(descendants.has('leaf-a2-child'), true)
  assert.deepEqual([...descendants].sort(), ['leaf-a1', 'leaf-a2-child'])
})

test('선택한 카드마다 자신에게 딸린 하위 카드의 이동 책임을 구분한다', () => {
  const owners = collectDragDescendantOwners(new Set(['mid-a', 'mid-b']), edges)
  assert.deepEqual([...owners.entries()].sort(), [
    ['leaf-a1', 'mid-a'],
    ['leaf-a2', 'mid-a'],
    ['leaf-a2-child', 'mid-a'],
    ['leaf-b1', 'mid-b'],
  ])
})

test('선택한 카드 3개를 다른 카드에 놓으면 모두 대상의 직접 자식이 된다', () => {
  assert.deepEqual(hierarchyReparentPairs('new-parent', ['mid-a', 'mid-b', 'mid-c']), [
    { source: 'new-parent', target: 'mid-a' },
    { source: 'new-parent', target: 'mid-b' },
    { source: 'new-parent', target: 'mid-c' },
  ])
})

test('부모 변경 대상은 중복 카드와 대상 카드 자신을 제외한다', () => {
  assert.deepEqual(hierarchyReparentPairs('new-parent', ['mid-a', 'mid-a', 'new-parent']), [
    { source: 'new-parent', target: 'mid-a' },
  ])
})

test('부모와 자식을 함께 선택하면 선택한 자식의 하위는 자식 카드가 맡는다', () => {
  const owners = collectDragDescendantOwners(new Set(['mid-a', 'leaf-a2']), edges)
  assert.equal(owners.get('leaf-a1'), 'mid-a')
  assert.equal(owners.get('leaf-a2-child'), 'leaf-a2')
  assert.equal(owners.has('leaf-a2'), false)
})

test('순환 연결이 있어도 무한히 돌지 않는다', () => {
  const cyclicEdges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' },
  ]
  assert.deepEqual([...collectDragDescendantIds(new Set(['a']), cyclicEdges)].sort(), ['b', 'c'])
})

test('연결선이 없으면 하위가 없다', () => {
  assert.deepEqual([...collectDragDescendantIds(new Set(['mid-a']), [])], [])
  assert.deepEqual([...collectDragDescendantIds(new Set(['mid-a']), undefined)], [])
})
