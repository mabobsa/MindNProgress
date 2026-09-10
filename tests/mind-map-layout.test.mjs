import assert from 'node:assert/strict'
import test from 'node:test'
import { assertLayoutClear, layoutMindMap, validateLayoutMeasurements, verifyRenderedLayout, MIND_MAP_LAYOUT_VERSION } from '../src/utils/mindMapLayout.mjs'

const node = (id, data = {}) => ({ id, type: 'mind', hidden: true, parentId: '임의 부모', style: { transform: 'translate(-900px)' }, position: { x: 0, y: 0 }, data: { label: id, ...data } })
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })
const example = () => ({ id: 'layout-test', nodes: [node('root'), node('a'), node('b'), node('a1'), node('a2'), node('a11')], edges: [edge('root', 'a'), edge('root', 'b'), edge('a', 'a1'), edge('a', 'a2'), edge('a1', 'a11')] })
const measure = (map) => map.nodes.map((card, index) => ({ cardId: card.id, ...card.position, width: index === 1 ? 640 : 218, height: index === 1 ? 460 : 112 + index * 35, outsets: { left: 8, top: 42, right: 22, bottom: 8 } }))
const positioned = (map, measurements) => measurements.map((item) => ({ ...item, ...map.nodes.find((card) => card.id === item.cardId).position }))

test('공유 배치는 AI 좌표를 무시하고 가변 카드·돌출·하위 트리를 결정적으로 배치한다', () => {
  const input = example(); const copy = structuredClone(input); const sizes = measure(input)
  const result = layoutMindMap(input, sizes)
  assert.deepEqual(input, copy, '원본과 입력 전환안은 변경하지 않는다')
  assert.deepEqual(layoutMindMap(input, sizes), result)
  assert.equal(result.layout.version, MIND_MAP_LAYOUT_VERSION)
  assert.doesNotThrow(() => assertLayoutClear(result.layout.boxes))
  assert.equal(verifyRenderedLayout(result.map, result.layout, positioned(result.map, sizes)), true)
  assert.equal(new Set(result.map.nodes.map((card) => JSON.stringify(card.position))).size, input.nodes.length)
  assert.ok(result.map.nodes.every((card) => card.type === 'mind' && !('hidden' in card) && !('style' in card) && !('parentId' in card)))
  const otherCoordinates = structuredClone(input); otherCoordinates.nodes.forEach((card) => { card.position = { x: -100000, y: 999999 } })
  assert.deepEqual(layoutMindMap(otherCoordinates, sizes), result)
  const withKnowledge = structuredClone(input); withKnowledge.edges.push({ ...edge('b', 'a2'), data: { relation: 'knowledge' } })
  assert.deepEqual(layoutMindMap(withKnowledge, sizes).layout, result.layout)
  const y = (id) => result.map.nodes.find((card) => card.id === id).position.y
  assert.ok(y('a1') < y('a2') && y('a') < y('b'), '형제 순서는 입력 노드 순서로 고정')
})

test('측정 누락·중복·잘못된 크기와 최종 렌더 좌표·돌출 변경을 차단한다', () => {
  const input = example(); const sizes = measure(input); const { map, layout } = layoutMindMap(input, sizes)
  const good = positioned(map, sizes)
  assert.throws(() => validateLayoutMeasurements(input.nodes, sizes.slice(1)), /모든 카드/)
  assert.throws(() => validateLayoutMeasurements(input.nodes, sizes.map(() => sizes[0])), /중복/)
  for (const bad of [{ width: 0 }, { height: Infinity }, { x: NaN }, { outsets: { left: -1, top: 0, right: 0, bottom: 0 } }]) {
    assert.throws(() => validateLayoutMeasurements(input.nodes, [{ ...sizes[0], ...bad }, ...sizes.slice(1)]))
  }
  for (const bad of [{ x: good[0].x + 10 }, { height: good[0].height + 30 }, { outsets: { ...good[0].outsets, top: 300 } }]) {
    assert.throws(() => verifyRenderedLayout(map, layout, [{ ...good[0], ...bad }, ...good.slice(1)]), /좌표|배치 영역/)
  }
  assert.throws(() => assertLayoutClear([{ cardId: 'a', x: 0, y: 0, width: 200, height: 100 }, { cardId: 'b', x: 210, y: 0, width: 200, height: 100 }]), /최소 여백/)
})

test('깊거나 넓은 트리도 겹치지 않으며 다중 루트·순환·미연결 계층을 거부한다', () => {
  for (const shape of ['deep', 'wide']) {
    const map = { nodes: Array.from({ length: 1500 }, (_, i) => node(String(i))), edges: Array.from({ length: 1499 }, (_, i) => edge(shape === 'deep' ? String(i) : '0', String(i + 1))) }
    assert.doesNotThrow(() => assertLayoutClear(layoutMindMap(map).layout.boxes))
  }
  const map = example()
  assert.throws(() => layoutMindMap({ ...map, edges: [] }), /루트/)
  assert.throws(() => layoutMindMap({ ...map, edges: [...map.edges, edge('b', 'a')] }), /트리/)
  assert.throws(() => layoutMindMap({ ...map, edges: [...map.edges, edge('a11', 'root')] }), /루트/)
  assert.throws(() => layoutMindMap({ ...map, nodes: [...map.nodes, node('orphan1'), node('orphan2')], edges: [...map.edges, edge('orphan1', 'orphan2'), edge('orphan2', 'orphan1')] }), /연결되지/)
  assert.throws(() => layoutMindMap({ nodes: [node('external', { externalLink: { displayWidth: 0 } })], edges: [] }), /표시 크기/)
})
