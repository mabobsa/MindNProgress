import { assertLayoutClear, validateLayoutMeasurements, verifyRenderedLayout } from './mindMapLayout.mjs'

export const CARD_LAYOUT_VERSION = 'card-layout-v2'
export const CARD_LAYOUT_GAP = 32
export const CARD_LAYOUT_TARGET = Object.freeze({ width: 1600, height: 900 })
const fail = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'CARD_LAYOUT_INVALID', reconstructionError: true }) }
const knowledge = (edge) => edge.data?.relation === 'knowledge'
const finite = (value) => Number.isFinite(value)

export function cardLayoutGraph(map) {
  if (!Array.isArray(map?.nodes) || !map.nodes.length || map.nodes.length > 2000) fail('배치 제안은 문서당 1~2000개 카드를 지원합니다.')
  const byId = new Map(map.nodes.map((node) => [node.id, node]))
  if (byId.size !== map.nodes.length || map.nodes.some((node) => !node.id || !finite(node.position?.x) || !finite(node.position?.y))) fail('카드 ID 또는 위치가 올바르지 않습니다.')
  const children = new Map(map.nodes.map((node) => [node.id, []])); const parents = new Map()
  for (const edge of map.edges ?? []) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) fail('연결선의 카드를 찾을 수 없습니다.')
    if (knowledge(edge)) continue
    if (parents.has(edge.target)) fail('부모가 여러 개인 계층은 자동으로 수정하지 않습니다.')
    parents.set(edge.target, edge.source); children.get(edge.source).push(edge.target)
  }
  const roots = map.nodes.filter((node) => !parents.has(node.id)).map((node) => node.id)
  const visited = new Set(); const stack = [...roots]
  while (stack.length) {
    const id = stack.pop()
    if (visited.has(id)) fail('계층에 순환이 있습니다.')
    visited.add(id); stack.push(...children.get(id))
  }
  if (visited.size !== map.nodes.length) fail('계층에 순환이 있습니다.')
  return { byId, children, parents, roots }
}

export function cardLayoutKind(node, childCount = 0) {
  if (node.data.kind === 'image') return 'image'
  if (node.data.reference) return 'reference'
  if (node.data.externalLink) return 'dooray'
  if (node.data.isWork) return 'work'
  return childCount || ['root', 'branch'].includes(node.data.kind) ? 'group' : 'knowledge'
}

export function validateCardLayoutPlan(map, plan) {
  cardLayoutGraph(map)
  if (!plan || Object.keys(plan).some((key) => !['order', 'reason'].includes(key))) fail('배치안에는 카드 순서와 제안 이유만 포함하세요.')
  if (typeof plan.reason !== 'string' || !plan.reason.trim() || plan.reason.length > 8000) fail('배치 제안 이유를 작성하세요. (최대 8000자)')
  const ids = new Set(map.nodes.map((node) => node.id))
  if (!Array.isArray(plan.order) || plan.order.length !== ids.size || new Set(plan.order).size !== ids.size || plan.order.some((id) => !ids.has(id))) fail('배치안에는 모든 카드 ID가 정확히 한 번 있어야 합니다.')
  return { order: [...plan.order], reason: plan.reason.trim() }
}

const overlaps = (a, b) => a.x < b.x + b.width + CARD_LAYOUT_GAP && b.x < a.x + a.width + CARD_LAYOUT_GAP && a.y < b.y + b.height + CARD_LAYOUT_GAP && b.y < a.y + a.height + CARD_LAYOUT_GAP
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
const crosses = (a, b, c, d) => {
  const turn = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0
}

function layoutHierarchyCards(map, measurements, plan) {
  const { byId, children, parents, roots } = cardLayoutGraph(map)
  const supplied = new Map(validateLayoutMeasurements(map.nodes, measurements).map((item) => [item.cardId, item]))
  const order = plan ? validateCardLayoutPlan(map, plan).order : [...map.nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).map((node) => node.id)
  const rank = new Map(order.map((id, index) => [id, index]))
  for (const ids of children.values()) {
    ids.sort((a, b) => rank.get(a) - rank.get(b))
    const groups = new Map()
    for (const id of ids) {
      const kind = cardLayoutKind(byId.get(id), children.get(id).length)
      if (!groups.has(kind)) groups.set(kind, [])
      groups.get(kind).push(id)
    }
    ids.splice(0, ids.length, ...[...groups.values()].flat())
  }
  const main = roots.find((id) => byId.get(id).data.kind === 'root' && !byId.get(id).data.reference) ?? roots.find((id) => children.get(id).length) ?? roots[0]
  const treeRoots = roots.filter((id) => id === main || children.get(id).length).sort((a, b) => a === main ? -1 : b === main ? 1 : rank.get(a) - rank.get(b))
  const sizes = new Map(map.nodes.map(({ id }) => {
    const body = supplied.get(id)
    return [id, { body, width: body.width + body.outsets.left + body.outsets.right, height: body.height + body.outsets.top + body.outsets.bottom }]
  }))
  const sequence = []; const depths = new Map(); const heights = new Map(); const columns = []
  for (const root of treeRoots) {
    const stack = [[root, 0]]
    while (stack.length) {
      const [id, depth] = stack.pop(); sequence.push(id); depths.set(id, depth)
      columns[depth] = Math.max(columns[depth] ?? 0, sizes.get(id).width)
      for (const child of [...children.get(id)].reverse()) stack.push([child, depth + 1])
    }
  }
  for (const id of [...sequence].reverse()) {
    const kids = children.get(id)
    heights.set(id, Math.max(sizes.get(id).height, kids.reduce((sum, child) => sum + heights.get(child), 0) + Math.max(0, kids.length - 1) * 48))
  }
  const xs = [0]
  for (let i = 1; i < columns.length; i++) xs[i] = xs[i - 1] + columns[i - 1] + 96
  const boxes = []; const placed = new Map(); const tops = new Map(); let treeTop = 0
  for (const root of treeRoots) { tops.set(root, treeTop); treeTop += heights.get(root) + 96 }
  for (const id of sequence) {
    const size = sizes.get(id); const height = heights.get(id); const top = tops.get(id)
    const box = { cardId: id, x: xs[depths.get(id)], y: top + (height - size.height) / 2, ...size }
    boxes.push(box); placed.set(id, box)
    const kids = children.get(id)
    let childTop = top + (height - kids.reduce((sum, child) => sum + heights.get(child), 0) - Math.max(0, kids.length - 1) * 48) / 2
    for (const child of kids) { tops.set(child, childTop); childTop += heights.get(child) + 48 }
  }
  const related = new Map(map.nodes.map((node) => [node.id, []]))
  for (const edge of map.edges.filter(knowledge)) {
    const weight = edge.data?.knowledgePolicy === 'inspect-if-insufficient' ? 1 : 2
    related.get(edge.source).push({ id: edge.target, weight }); related.get(edge.target).push({ id: edge.source, weight })
  }
  const free = roots.filter((id) => !placed.has(id)).sort((a, b) => rank.get(a) - rank.get(b))
  const grouped = new Map()
  for (const id of free) {
    const kind = cardLayoutKind(byId.get(id))
    if (!grouped.has(kind)) grouped.set(kind, [])
    grouped.get(kind).push(id)
  }
  const pending = [...grouped.values()].flat()
  while (pending.length) {
    let index = pending.findIndex((id) => related.get(id).some((item) => placed.has(item.id)))
    if (index < 0) index = 0
    const id = pending.splice(index, 1)[0]; const size = sizes.get(id)
    const links = related.get(id).filter((item) => placed.has(item.id))
    let candidates
    if (links.length) {
      const weight = links.reduce((sum, item) => sum + item.weight, 0)
      const target = links.reduce((point, item) => { const p = center(placed.get(item.id)); return { x: point.x + p.x * item.weight / weight, y: point.y + p.y * item.weight / weight } }, { x: 0, y: 0 })
      const ancestors = (nodeId) => { const ids = []; while (nodeId) { ids.push(nodeId); nodeId = parents.get(nodeId) } return ids }
      const common = ancestors(links[0].id).find((candidate) => links.every((link) => ancestors(link.id).includes(candidate)))
      const anchor = placed.get(common) ?? { x: target.x, y: target.y, width: 0, height: 0 }
      candidates = [
        { x: anchor.x - size.width - 64, y: target.y - size.height / 2 },
        { x: anchor.x + anchor.width + 64, y: target.y - size.height / 2 },
        { x: target.x - size.width / 2, y: Math.min(...links.map((item) => placed.get(item.id).y)) - size.height - 64 },
        { x: target.x - size.width / 2, y: Math.max(...links.map((item) => placed.get(item.id).y + placed.get(item.id).height)) + 64 },
      ]
    } else candidates = [{ x: xs.at(-1) + columns.at(-1) + 160, y: 0 }]
    const existingLines = map.edges.filter((edge) => placed.has(edge.source) && placed.has(edge.target)).map((edge) => [center(placed.get(edge.source)), center(placed.get(edge.target))])
    const options = candidates.map((candidate) => {
      const box = { cardId: id, ...candidate, ...size }
      // 같은 수평 구간의 점유 영역을 한 번 순회해 빈 세로 구간을 찾는다.
      // 독립 카드가 많아도 전체 목록을 겹침마다 다시 검색하지 않는다.
      const column = boxes.filter((other) => box.x < other.x + other.width + CARD_LAYOUT_GAP && other.x < box.x + box.width + CARD_LAYOUT_GAP).sort((a, b) => a.y - b.y)
      for (const other of column) {
        if (other.y >= box.y + box.height + CARD_LAYOUT_GAP) break
        if (overlaps(box, other)) box.y = other.y + other.height + 48
      }
      const p = center(box)
      const score = links.reduce((sum, link) => { const q = center(placed.get(link.id)); return sum + link.weight * (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + existingLines.filter(([a, b]) => crosses(p, q, a, b)).length * 160) }, 0)
      return { box, score }
    }).sort((a, b) => a.score - b.score)
    const box = options[0].box; placed.set(id, box); boxes.push(box)
  }
  const originalRoot = byId.get(main).position; const rootBox = placed.get(main)
  const delta = { x: originalRoot.x - rootBox.x - rootBox.body.outsets.left, y: originalRoot.y - rootBox.y - rootBox.body.outsets.top }
  for (const box of boxes) { box.x += delta.x; box.y += delta.y }
  assertLayoutClear(boxes)
  const nodes = map.nodes.map((node) => {
    const box = placed.get(node.id)
    return { ...structuredClone(node), position: { x: box.x + box.body.outsets.left, y: box.y + box.body.outsets.top } }
  })
  return { map: { ...map, nodes }, layout: { version: CARD_LAYOUT_VERSION, gap: CARD_LAYOUT_GAP, boxes,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - Math.min(...boxes.map((box) => box.x)),
    height: Math.max(...boxes.map((box) => box.y + box.height)) - Math.min(...boxes.map((box) => box.y)) } }
}

export function validateCardLayoutTarget(target = CARD_LAYOUT_TARGET) {
  if (!target || Object.keys(target).some((key) => !['width', 'height'].includes(key)) || ![1280, 1600, 1920].includes(target.width) || target.height !== target.width * 9 / 16) fail('목표 화면은 지원하는 모니터형 16:9 크기를 선택하세요.')
  return { width: target.width, height: target.height }
}

export function cardLayoutMetrics(layout, target = CARD_LAYOUT_TARGET) {
  const screen = validateCardLayoutTarget(target)
  const fitScale = Math.min(1, (screen.width - 64) / layout.width, (screen.height - 64) / layout.height)
  return { target: screen, width: layout.width, height: layout.height, aspectRatio: layout.width / layout.height, fitScale, needsZoom: fitScale < 0.65 }
}

const extent = (boxes) => {
  const left = Math.min(...boxes.map((b) => b.x)); const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width)); const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}
const screenCost = (bounds, target) => Math.max(bounds.width / (target.width - 64), bounds.height / (target.height - 64)) * (1 + 0.08 * Math.abs(Math.log(bounds.width / bounds.height / (target.width / target.height))))

// 하위 트리 전체를 예약한 사각형 단위로 열을 나눈다.
// 자식은 부모보다 오른쪽에 두고 다른 가지의 하위 트리와 섞지 않는다.
function packColumns(items, heightLimit) {
  const positions = new Map(); let x = 0; let y = 0; let columnWidth = 0; let height = 0
  for (const item of items) {
    if (y > 0 && y + item.height > heightLimit) { x += columnWidth + 64; y = 0; columnWidth = 0 }
    positions.set(item.id, { x, y }); columnWidth = Math.max(columnWidth, item.width)
    height = Math.max(height, y + item.height); y += item.height + 48
  }
  return { positions, width: x + columnWidth, height }
}

function compactBoxes(map, measurements, plan, heightLimit, target) {
  const { byId, children, parents, roots } = cardLayoutGraph(map)
  const order = plan ? validateCardLayoutPlan(map, plan).order : [...map.nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).map((n) => n.id)
  const rank = new Map(order.map((id, i) => [id, i]))
  const group = (ids) => {
    const groups = new Map()
    for (const id of [...ids].sort((a, b) => rank.get(a) - rank.get(b))) {
      const kind = cardLayoutKind(byId.get(id), children.get(id).length)
      if (!groups.has(kind)) groups.set(kind, [])
      groups.get(kind).push(id)
    }
    return [...groups.values()].flat()
  }
  for (const [id, ids] of children) children.set(id, group(ids))
  const main = roots.find((id) => byId.get(id).data.kind === 'root' && !byId.get(id).data.reference) ?? roots.find((id) => children.get(id).length) ?? roots[0]
  const treeRoots = [main, ...group(roots.filter((id) => id !== main && children.get(id).length))]
  const sizes = new Map(measurements.map((body) => [body.cardId, { body, width: body.width + body.outsets.left + body.outsets.right, height: body.height + body.outsets.top + body.outsets.bottom }]))
  const sequence = []; const stack = [...treeRoots].reverse()
  while (stack.length) { const id = stack.pop(); sequence.push(id); stack.push(...[...children.get(id)].reverse()) }
  const blocks = new Map()
  for (const id of [...sequence].reverse()) {
    const size = sizes.get(id); const kids = children.get(id)
    const packed = packColumns(kids.map((child) => ({ id: child, ...blocks.get(child) })), heightLimit)
    const height = Math.max(size.height, packed.height)
    blocks.set(id, { width: size.width + (kids.length ? 96 + packed.width : 0), height, packed, bodyY: (height - size.height) / 2 })
  }
  const forest = packColumns(treeRoots.map((id) => ({ id, ...blocks.get(id) })), heightLimit)
  const positions = new Map(forest.positions); const placed = new Map(); const boxes = []
  for (const id of sequence) {
    const block = blocks.get(id); const p = positions.get(id); const size = sizes.get(id)
    const box = { cardId: id, x: p.x, y: p.y + block.bodyY, ...size }
    boxes.push(box); placed.set(id, box)
    for (const child of children.get(id)) {
      const offset = block.packed.positions.get(child)
      positions.set(child, { x: p.x + size.width + 96 + offset.x, y: p.y + (block.height - block.packed.height) / 2 + offset.y })
    }
  }
  const related = new Map(map.nodes.map((n) => [n.id, []]))
  for (const edge of map.edges.filter(knowledge)) {
    const weight = edge.data?.knowledgePolicy === 'inspect-if-insufficient' ? 1 : 2
    related.get(edge.source).push({ id: edge.target, weight }); related.get(edge.target).push({ id: edge.source, weight })
  }
  const pending = group(roots.filter((id) => !placed.has(id)))
  while (pending.length) {
    const index = pending.findIndex((id) => related.get(id).some((link) => placed.has(link.id)))
    if (index < 0) break
    const id = pending.splice(index, 1)[0]; const size = sizes.get(id)
    const links = related.get(id).filter((link) => placed.has(link.id))
    const weight = links.reduce((sum, link) => sum + link.weight, 0)
    const point = links.reduce((p, link) => { const q = center(placed.get(link.id)); return { x: p.x + q.x * link.weight / weight, y: p.y + q.y * link.weight / weight } }, { x: 0, y: 0 })
    const ancestors = (nodeId) => { const ids = []; while (nodeId) { ids.push(nodeId); nodeId = parents.get(nodeId) } return ids }
    const common = ancestors(links[0].id).find((candidate) => links.every((link) => ancestors(link.id).includes(candidate)))
    const anchor = placed.get(common) ?? { x: point.x, y: point.y, width: 0, height: 0 }
    const bounds = extent(boxes)
    const seeds = [
      { x: anchor.x - size.width - 64, y: point.y - size.height / 2 }, { x: anchor.x + anchor.width + 64, y: point.y - size.height / 2 },
      { x: point.x - size.width / 2, y: anchor.y - size.height - 64 }, { x: point.x - size.width / 2, y: anchor.y + anchor.height + 64 },
      { x: bounds.x, y: bounds.y + bounds.height + 64 }, { x: bounds.x + bounds.width + 64, y: bounds.y },
    ]
    const lines = map.edges.filter((e) => placed.has(e.source) && placed.has(e.target)).map((e) => [center(placed.get(e.source)), center(placed.get(e.target))])
    const options = seeds.flatMap((seed) => ['x', 'y'].map((axis) => {
      const box = { cardId: id, ...seed, ...size }
      for (const other of [...boxes].sort((a, b) => a[axis] - b[axis])) if (overlaps(box, other)) box[axis] = other[axis] + other[axis === 'x' ? 'width' : 'height'] + 48
      const p = center(box)
      const linkCost = links.reduce((sum, link) => { const q = center(placed.get(link.id)); return sum + link.weight * (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + lines.filter(([a, b]) => crosses(p, q, a, b)).length * 160) }, 0)
      return { box, cost: screenCost(extent([...boxes, box]), target) + linkCost / (target.width + target.height) * 0.15 }
    })).sort((a, b) => a.cost - b.cost)
    const box = options[0].box; boxes.push(box); placed.set(id, box)
  }
  if (pending.length) {
    const packed = packColumns(pending.map((id) => ({ id, ...sizes.get(id) })), heightLimit)
    const bounds = extent(boxes)
    const areas = [
      { x: bounds.x + bounds.width + 96, y: bounds.y }, { x: bounds.x, y: bounds.y + bounds.height + 96 },
    ].map((p) => ({ ...p, width: packed.width, height: packed.height }))
      .sort((a, b) => screenCost(extent([bounds, a]), target) - screenCost(extent([bounds, b]), target))
    for (const id of pending) { const p = packed.positions.get(id); const box = { cardId: id, x: areas[0].x + p.x, y: areas[0].y + p.y, ...sizes.get(id) }; boxes.push(box); placed.set(id, box) }
  }
  const root = placed.get(main); const origin = byId.get(main).position
  const delta = { x: origin.x - root.x - root.body.outsets.left, y: origin.y - root.y - root.body.outsets.top }
  for (const box of boxes) { box.x += delta.x; box.y += delta.y }
  return { boxes, ...extent(boxes) }
}

export function createCardLayoutCandidates(map, measurements, plan, target = CARD_LAYOUT_TARGET) {
  const screen = validateCardLayoutTarget(target)
  cardLayoutGraph(map)
  const supplied = validateLayoutMeasurements(map.nodes, measurements)
  if (plan) validateCardLayoutPlan(map, plan)
  const area = supplied.reduce((sum, m) => sum + (m.width + m.outsets.left + m.outsets.right + 64) * (m.height + m.outsets.top + m.outsets.bottom + 48), 0)
  const idealHeight = Math.sqrt(area / (screen.width / screen.height))
  const seen = new Set()
  const positionKey = (boxes) => { const byId = new Map(boxes.map((b) => [b.cardId, b])); return JSON.stringify(map.nodes.map((n) => { const b = byId.get(n.id); return [b.x, b.y] })) }
  const options = [0.45, 0.65, 0.85, 1, 1.2, 1.5, 1.9, 2.5, 3.5, 5].map((factor) => compactBoxes(map, supplied, plan, idealHeight * factor, screen)).filter((item) => {
    const key = positionKey(item.boxes)
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  // 기존 계층형이 이미 화면에 더 잘 맞는 문서도 동일한 기준으로 비교한다.
  const hierarchy = layoutHierarchyCards(map, supplied, plan)
  if (!seen.has(positionKey(hierarchy.layout.boxes))) options.push(hierarchy.layout)
  options.sort((a, b) => screenCost(a, screen) - screenCost(b, screen))
  const first = options[0]
  const wider = options.find((option) => option.width / option.height > first.width / first.height * 1.15 && screenCost(option, screen) < screenCost(first, screen) * 1.5)
  const second = wider ?? options[1]
  const make = (option, id, label) => {
    assertLayoutClear(option.boxes)
    const byId = new Map(option.boxes.map((b) => [b.cardId, b]))
    const nodes = map.nodes.map((node) => { const box = byId.get(node.id); return { ...structuredClone(node), position: { x: box.x + box.body.outsets.left, y: box.y + box.body.outsets.top } } })
    const layout = { version: CARD_LAYOUT_VERSION, gap: CARD_LAYOUT_GAP, width: option.width, height: option.height, boxes: option.boxes }
    return { id, label, map: { ...map, nodes }, layout, metrics: cardLayoutMetrics(layout, screen) }
  }
  const candidates = [make(first, 'balanced', '화면 균형형')]
  if (second) candidates.push(make(second, 'spread', second.width / second.height > first.width / first.height ? '가로 분산형' : '묶음 분산형'))
  if (!candidates.some((candidate) => JSON.stringify(candidate.map.nodes.map((n) => n.position)) === JSON.stringify(hierarchy.map.nodes.map((n) => n.position)))) candidates.push({ id: 'hierarchy', label: '계층형 · 비교용', ...hierarchy, metrics: cardLayoutMetrics(hierarchy.layout, screen) })
  return candidates
}

export function layoutCards(map, measurements, plan, options = {}) {
  const candidates = createCardLayoutCandidates(map, measurements, plan, options.target)
  const selected = candidates.find((candidate) => candidate.id === (options.variant ?? 'balanced'))
  if (!selected) fail('이 문서에서 사용할 수 없는 배치 후보입니다. 다시 미리보기를 열어 주세요.')
  return { map: selected.map, layout: selected.layout }
}

export function verifyCardLayout(map, layout, measurements) {
  verifyRenderedLayout(map, layout, measurements)
  const bodies = new Map(layout.boxes.map((box) => [box.cardId, box.body]))
  for (const item of measurements) {
    const body = bodies.get(item.cardId)
    if (Math.abs(item.width - body.width) > 1 || Math.abs(item.height - body.height) > 1 || ['left', 'right', 'top', 'bottom'].some((side) => Math.abs(item.outsets[side] - body.outsets[side]) > 1)) fail(`카드 표시 크기가 변경되었습니다. 다시 미리보기를 확인하세요: ${item.cardId}`)
  }
  return true
}
