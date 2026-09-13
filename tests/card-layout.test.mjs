import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutCards, createCardLayoutCandidates, validateCardLayoutTarget, cardLayoutAspectRatio, CARD_LAYOUT_RATIOS, CARD_LAYOUT_TARGET, validateCardLayoutPlan, verifyCardLayout, cardLayoutKind } from '../src/utils/cardLayout.mjs'
import { assertLayoutClear } from '../src/utils/mindMapLayout.mjs'
import { buildCardLayoutRequestPrompt } from '../src/utils/cardLayoutRequest.mjs'

const node = (id, data = {}) => ({ id, type: 'mind', position: { x: 500, y: -220 }, data: { label: id, kind: 'task', isWork: true, ...data } })
const edge = (source, target, relation) => ({ id: `${source}-${target}`, source, target, ...(relation ? { data: { relation } } : {}) })
const measure = (map) => map.nodes.map((card, index) => ({ cardId: card.id, ...card.position, width: index % 4 === 0 ? 700 : 218, height: 100 + index % 7 * 30, outsets: { left: 8, top: 48, right: 24, bottom: 8 } }))
const positions = (map, sizes) => sizes.map((size) => ({ ...size, ...map.nodes.find((node) => node.id === size.cardId).position }))
const cost = (c, ratio = 16 / 9) => Math.max(c.metrics.width / Math.sqrt(ratio), c.metrics.height * Math.sqrt(ratio)) * (1 + 0.08 * Math.abs(Math.log(c.metrics.aspectRatio / ratio)))

test('혼합 역할·이미지·독립 및 공유 자료·복수 트리를 보존하며 실제 점유 영역으로 배치한다', () => {
  const map = { nodes: [node('root', { kind: 'root', isWork: false }), node('a'), node('group', { isWork: false }), node('b'), node('child'), node('r2', { kind: 'branch' }), node('r2child'), node('image', { kind: 'image', image: { displayWidth: 700, displayHeight: 200 } }), node('ref', { reference: { mapId: 'elsewhere', nodeId: 'n' } }), node('plain', { isWork: false }), node('dooray', { externalLink: { provider: 'dooray-wiki' } })],
    edges: [edge('root', 'a'), edge('root', 'group'), edge('root', 'b'), edge('group', 'child'), edge('r2', 'r2child'), edge('image', 'a', 'knowledge'), edge('ref', 'a', 'knowledge'), edge('ref', 'r2child', 'knowledge')] }
  const before = structuredClone(map); const sizes = measure(map)
  const plan = { order: map.nodes.map((n) => n.id), reason: '같은 역할의 형제와 연결된 자료를 함께 배치합니다.' }
  const result = layoutCards(map, sizes, plan)
  assert.deepEqual(map, before)
  assert.deepEqual(result.map.nodes.map(({ position: _p, ...n }) => n), map.nodes.map(({ position: _p, ...n }) => n))
  assert.deepEqual(result.map.edges, map.edges)
  assert.deepEqual(result.map.nodes[0].position, map.nodes[0].position)
  assert.doesNotThrow(() => assertLayoutClear(result.layout.boxes))
  assert.equal(verifyCardLayout(result.map, result.layout, positions(result.map, sizes)), true)
  const byId = new Map(result.map.nodes.map((n) => [n.id, n]))
  assert.ok(byId.get('a').position.y < byId.get('b').position.y && byId.get('b').position.y < byId.get('group').position.y)
  for (const e of map.edges.filter((e) => !e.data)) assert.ok(byId.get(e.target).position.x > byId.get(e.source).position.x)
  assert.equal(cardLayoutKind(node('Feature', { isWork: false }), 1), 'group')
  assert.equal(cardLayoutKind(node('ref', { reference: {} })), 'reference')
  assert.deepEqual(layoutCards(map, sizes, plan), result)
  const changed = positions(result.map, sizes); changed[0].width += 200
  assert.throws(() => verifyCardLayout(result.map, result.layout, changed), /배치 영역/)
  const smaller = positions(result.map, sizes); smaller[0].width -= 20
  assert.throws(() => verifyCardLayout(result.map, result.layout, smaller), /표시 크기/)
})

test('계층 오류·누락·중복·직접 좌표 입력과 잘못된 측정은 거부한다', () => {
  const map = { nodes: [node('a'), node('b')], edges: [edge('a', 'b')] }
  assert.throws(() => layoutCards({ ...map, edges: [...map.edges, edge('b', 'a')] }, measure(map)), /순환/)
  assert.throws(() => layoutCards({ ...map, edges: [...map.edges, edge('a', 'b')] }, measure(map)), /부모/)
  assert.throws(() => layoutCards({ ...map, edges: [edge('a', 'missing')] }, measure(map)), /연결선/)
  assert.throws(() => layoutCards(map, measure(map).slice(1)), /모든 카드/)
  for (const plan of [{ order: ['a', 'a'], reason: '중복' }, { order: ['a'], reason: '누락' }, { order: ['a', 'b'], reason: '위치 변조', positions: [] }]) assert.throws(() => validateCardLayoutPlan(map, plan))
})

test('세 비율 모두 1500개 깊은 계층·넓은 계층·독립 카드를 겹침·누락 없이 배치한다', () => {
  for (const shape of ['deep', 'wide', 'detached']) {
    const map = { nodes: Array.from({ length: 1500 }, (_, i) => node(String(i))), edges: shape === 'detached' ? [] : Array.from({ length: 1499 }, (_, i) => edge(shape === 'deep' ? String(i) : '0', String(i + 1))) }
    for (const ratio of CARD_LAYOUT_RATIOS) {
      const result = layoutCards(map, measure(map), undefined, { target: { ratio } })
      assert.equal(result.map.nodes.length, 1500)
      assert.doesNotThrow(() => assertLayoutClear(result.layout.boxes))
    }
  }
})

test('AI 요청은 서버 승인·실측 조회와 제안 제출만 지시한다', () => {
  const prompt = buildCardLayoutRequestPrompt({ id: 'layout-request-test' })
  assert.match(prompt, /mindnprogress_get_card_layout_request/)
  assert.match(prompt, /mindnprogress_submit_card_layout_proposal/)
  assert.match(prompt, /좌표와 크기는 넣지 않습니다/)
  assert.match(prompt, /추가 AI 위임, 자동 적용은 허용되지 않습니다/)
  assert.match(prompt, /해상도 크기 제한은 없으며/)
  assert.doesNotMatch(prompt, /1600|900px/)
  assert.match(prompt, /16:9/)
  assert.match(buildCardLayoutRequestPrompt({ id: 'layout-request-custom', target: { width: 1920, height: 1080 } }), /16:9/)
  for (const ratio of CARD_LAYOUT_RATIOS) assert.ok(buildCardLayoutRequestPrompt({ id: 'layout-request-ratio', target: { ratio } }).includes(`비율은 ${ratio}`))
})

test('넓은 형제 카드는 여러 행·열로 나눠 모니터에 들어오는 서로 다른 후보를 제공한다', () => {
  const map = { nodes: Array.from({ length: 21 }, (_, i) => node(String(i), { kind: i ? 'task' : 'root' })), edges: Array.from({ length: 20 }, (_, i) => edge('0', String(i + 1))) }
  const sizes = map.nodes.map((n) => ({ cardId: n.id, ...n.position, width: 220, height: 100, outsets: { left: 0, right: 0, top: 0, bottom: 0 } }))
  const before = structuredClone(map)
  const candidates = createCardLayoutCandidates(map, sizes)
  assert.deepEqual(candidates.map((c) => c.id), ['balanced', 'spread', 'hierarchy'])
  const [balanced, spread, hierarchy] = candidates
  assert.ok(cost(balanced) < cost(hierarchy) / 3, '같은 크기의 카드를 보존하면서 긴 세로 배치보다 비율 적합도를 높인다')
  assert.equal(Object.hasOwn(balanced.metrics, 'fitScale'), false, '실제 화면 확대율은 배치 엔진에서 추측하지 않는다')
  assert.ok(spread.metrics.aspectRatio > balanced.metrics.aspectRatio)
  assert.ok(new Set(balanced.map.nodes.slice(1).map((n) => n.position.x)).size > 1)
  assert.ok(new Set(balanced.map.nodes.slice(1).map((n) => n.position.y)).size > 1)
  assert.equal(new Set(candidates.map((c) => JSON.stringify(c.map.nodes.map((n) => n.position)))).size, candidates.length)
  for (const candidate of candidates) {
    assert.doesNotThrow(() => assertLayoutClear(candidate.layout.boxes))
    assert.equal(verifyCardLayout(candidate.map, candidate.layout, positions(candidate.map, sizes)), true)
    assert.deepEqual(candidate.map.nodes.map(({ position: _p, ...n }) => n), before.nodes.map(({ position: _p, ...n }) => n))
    assert.deepEqual(candidate.map.edges, before.edges)
    assert.deepEqual(candidate.map.nodes[0].position, before.nodes[0].position)
    assert.deepEqual(layoutCards(map, sizes, undefined, { variant: candidate.id }), { map: candidate.map, layout: candidate.layout })
  }
  assert.deepEqual(map, before)
})

test('세 비율을 선택하며 기본 16:9와 크기 제한 없는 기존 요청 호환을 유지한다', () => {
  assert.deepEqual(validateCardLayoutTarget(), { ratio: '16:9' })
  assert.ok(Object.isFrozen(CARD_LAYOUT_TARGET))
  for (const ratio of CARD_LAYOUT_RATIOS) {
    const [width, height] = ratio.split(':').map(Number)
    assert.deepEqual(validateCardLayoutTarget({ ratio }), { ratio })
    assert.equal(cardLayoutAspectRatio({ ratio }), width / height)
    for (const scale of [0.01, 80, 100, 120, 160, 1000000]) assert.deepEqual(validateCardLayoutTarget({ width: width * scale, height: height * scale }), { ratio })
  }
  for (const target of [null, {}, [], '16:9', { ratio: '3:4' }, { ratio: '16:9', width: 16, height: 9 }, { width: 390, height: 844 }, { width: 1600, height: 900, positions: [] }, { width: '1600', height: 900 }, { width: 0, height: 0 }, { width: -16, height: -9 }, { width: Infinity, height: 9 }, { width: NaN, height: 9 }]) assert.throws(() => validateCardLayoutTarget(target), /16:9/)
  const map = { nodes: [node('single')], edges: [] }
  assert.equal(createCardLayoutCandidates(map, measure(map)).length, 1, '한 카드에 의미 없는 동일 후보를 생성하지 않는다')
  assert.throws(() => layoutCards(map, measure(map), undefined, { variant: 'missing' }), /후보/)
})

test('복수 트리·독립 자료는 가로 공간을 사용하고 깊은 계층은 누락 없이 보존한다', () => {
  for (const shape of ['forest', 'detached', 'deep']) {
    const map = { nodes: Array.from({ length: 60 }, (_, i) => node(String(i), { kind: i ? 'task' : 'root' })),
      edges: shape === 'detached' ? [] : Array.from({ length: 59 }, (_, i) => edge(shape === 'deep' ? String(i) : String(Math.floor((i + 1) / 3) * 3), String(i + 1))).filter((e) => e.source !== e.target) }
    const sizes = measure(map)
    const candidates = createCardLayoutCandidates(map, sizes)
    const balanced = candidates[0]
    if (shape === 'deep') assert.ok(balanced.metrics.aspectRatio > 10, '비율을 강제하려고 계층을 바꾸지 않는다')
    else {
      const hierarchy = candidates.find((c) => c.id === 'hierarchy')
      assert.ok(cost(balanced) < cost(hierarchy) / 2, shape)
      assert.ok(balanced.metrics.aspectRatio > 0.8 && balanced.metrics.aspectRatio < 4, shape)
    }
    for (const c of candidates) {
      assert.equal(c.map.nodes.length, 60)
      assert.equal(verifyCardLayout(c.map, c.layout, positions(c.map, sizes)), true)
    }
  }
})

test('크기가 다른 가지와 지식선을 섞은 30개 결정적 사례에서도 하위 트리 영역을 보존한다', () => {
  let seed = 52721
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const bounds = (boxes) => ({ left: Math.min(...boxes.map((b) => b.x)), top: Math.min(...boxes.map((b) => b.y)), right: Math.max(...boxes.map((b) => b.x + b.width)), bottom: Math.max(...boxes.map((b) => b.y + b.height)) })
  for (let sample = 0; sample < 30; sample++) {
    const map = { nodes: Array.from({ length: 35 }, (_, i) => node(String(i), { kind: i ? 'task' : 'root' })), edges: [] }
    for (let i = 1; i < 25; i++) map.edges.push(edge(String(Math.floor(random() * i)), String(i)))
    for (let i = 25; i < 32; i++) { map.edges.push(edge(String(i), String(Math.floor(random() * 25)), 'knowledge')); if (i % 2) map.edges.push(edge(String(i), String(Math.floor(random() * 25)), 'knowledge')) }
    const sizes = measure(map).map((m) => ({ ...m, width: 200 + Math.floor(random() * 600), height: 100 + Math.floor(random() * 400) }))
    const target = { ratio: CARD_LAYOUT_RATIOS[sample % 3] }
    const candidates = createCardLayoutCandidates(map, sizes, undefined, target)
    const targetCost = (candidate) => cost(candidate, cardLayoutAspectRatio(target))
    for (const candidate of candidates) {
      assert.ok(targetCost(candidates[0]) <= targetCost(candidate) + 0.000001, '기존 계층형을 포함한 후보 중 목표 비율 비용이 가장 낮은 안을 기본 제공')
      assert.equal(verifyCardLayout(candidate.map, candidate.layout, positions(candidate.map, sizes)), true)
      const boxes = new Map(candidate.layout.boxes.map((b) => [b.cardId, b]))
      const descendants = (id) => [id, ...map.edges.filter((e) => !e.data && e.source === id).flatMap((e) => descendants(e.target))]
      for (const n of map.nodes) {
        const children = map.edges.filter((e) => !e.data && e.source === n.id).map((e) => e.target)
        for (const id of children) assert.ok(boxes.get(id).x >= boxes.get(n.id).x + boxes.get(n.id).width + 32, '자식은 부모 점유 영역의 오른쪽')
        const areas = children.map((id) => bounds(descendants(id).map((child) => boxes.get(child))))
        for (let a = 0; a < areas.length; a++) for (let b = a + 1; b < areas.length; b++) {
          const x = areas[a]; const y = areas[b]
          assert.ok(x.right + 32 <= y.left || y.right + 32 <= x.left || x.bottom + 32 <= y.top || y.bottom + 32 <= x.top, '형제 하위 트리 영역은 섞이지 않는다')
        }
      }
    }
  }
})

test('같은 비율은 FHD·QHD·임의 크기에서도 모든 후보와 좌표가 완전히 같다', () => {
  const map = { nodes: Array.from({ length: 40 }, (_, i) => node(String(i), { kind: i ? 'task' : 'root' })), edges: Array.from({ length: 29 }, (_, i) => edge('0', String(i + 1))) }
  for (let i = 30; i < 38; i++) map.edges.push(edge(String(i), String(i - 25), 'knowledge'))
  const sizes = measure(map); const plan = { order: map.nodes.map((n) => n.id), reason: '동일한 내용과 순서 검증' }
  const shapes = []
  for (const ratio of CARD_LAYOUT_RATIOS) {
    const canonical = createCardLayoutCandidates(map, sizes, plan, { ratio })
    const aspect = cardLayoutAspectRatio({ ratio })
    for (const height of [9, 720, 1080, 1440, 2160, 9000000]) {
      assert.deepEqual(createCardLayoutCandidates(map, sizes, plan, { width: height * aspect, height }), canonical)
    }
    shapes.push(canonical[0].map.nodes.map((n) => n.position))
    for (const candidate of canonical) assert.equal(verifyCardLayout(candidate.map, candidate.layout, positions(candidate.map, sizes)), true)
  }
  assert.ok(new Set(shapes.map((p) => JSON.stringify(p))).size > 1, '목표 비율 변경은 실제 후보 형상에 반영된다')
})
