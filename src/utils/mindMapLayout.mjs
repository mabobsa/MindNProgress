// 좌표가 아닌 계층·형제 순서와 카드의 실제 점유 영역으로 배치한다.
export const MIND_MAP_LAYOUT_VERSION = 'subtree-bounds-v1'
export const MIND_MAP_LAYOUT_GAP = 32
const columnGap = 96
const siblingGap = 48
const fail = (message) => { throw Object.assign(new Error(message), { code: 'RECONSTRUCTION_LAYOUT_INVALID', status: 400, reconstructionError: true }) }
const positive = (value, max = 4000) => Number.isFinite(value) && value > 0 && value <= max
// 화면 배율로 역산한 218.000001px 같은 부동소수점 흔들림이 예약 영역을 매번 1px 키우지 않게 한다.
const pixelCeil = (value) => Math.ceil(value - 0.001)
const outsetsOf = (value) => {
  const outsets = {}
  for (const side of ['left', 'top', 'right', 'bottom']) {
    const amount = value?.[side]
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000) fail('카드 돌출 영역의 크기를 확인하세요.')
    outsets[side] = pixelCeil(amount)
  }
  return outsets
}

export function validateLayoutMeasurements(nodes, measurements) {
  if (!Array.isArray(measurements) || measurements.length !== nodes.length) fail('모든 카드의 실제 렌더 크기가 필요합니다.')
  const ids = new Set(nodes.map((node) => node.id)); const seen = new Set()
  return measurements.map((item) => {
    if (!ids.has(item?.cardId) || seen.has(item.cardId)) fail('렌더 크기에 중복 또는 알 수 없는 카드가 있습니다.')
    seen.add(item.cardId)
    if (!positive(item.width) || !positive(item.height) || !Number.isFinite(item.x) || !Number.isFinite(item.y)) fail('카드 크기 또는 실제 좌표를 확인할 수 없습니다.')
    return { cardId: item.cardId, x: item.x, y: item.y, width: pixelCeil(item.width), height: pixelCeil(item.height), outsets: outsetsOf(item.outsets) }
  })
}

export function assertLayoutClear(rects, gap = MIND_MAP_LAYOUT_GAP) {
  const sorted = [...rects].sort((a, b) => a.x - b.x)
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    if (!positive(a.width, 10000) || !positive(a.height, 10000) || !Number.isFinite(a.x) || !Number.isFinite(a.y)) fail('배치 영역이 올바르지 않습니다.')
    for (let j = i + 1; j < sorted.length && sorted[j].x < a.x + a.width + gap; j++) {
      const b = sorted[j]
      if (a.y < b.y + b.height + gap && b.y < a.y + a.height + gap) fail(`카드 점유 영역 또는 최소 여백이 겹칩니다: ${a.cardId}, ${b.cardId}`)
    }
  }
}

export function layoutMindMap(map, measurements) {
  if (!Array.isArray(map?.nodes) || !map.nodes.length || map.nodes.length > 2000) fail('자동 배치는 문서당 1~2000개 카드를 지원합니다.')
  const byId = new Map(map.nodes.map((node) => [node.id, node]))
  if (byId.size !== map.nodes.length) fail('카드 ID가 중복되었습니다.')
  const order = new Map(map.nodes.map((node, index) => [node.id, index]))
  const children = new Map(map.nodes.map((node) => [node.id, []])); const parents = new Map()
  for (const edge of map.edges ?? []) {
    if (edge.data?.relation === 'knowledge') continue
    if (!byId.has(edge.source) || !byId.has(edge.target) || parents.has(edge.target)) fail('배치할 계층이 트리가 아닙니다.')
    parents.set(edge.target, edge.source); children.get(edge.source).push(edge.target)
  }
  const roots = map.nodes.filter((node) => !parents.has(node.id))
  if (roots.length !== 1) fail('배치할 루트는 하나여야 합니다.')
  for (const ids of children.values()) ids.sort((a, b) => order.get(a) - order.get(b))
  const supplied = measurements ? new Map(validateLayoutMeasurements(map.nodes, measurements).map((item) => [item.cardId, item])) : null
  const sizes = new Map(map.nodes.map((node) => {
    if (node.data?.kind === 'image') fail('이미지 카드는 원본 문서에 보존하고 링크로 승계하세요.')
    const external = node.data?.externalLink
    if (external && (!positive(external.displayWidth) || !positive(external.displayHeight))) fail('외부 링크 카드의 표시 크기가 확정되지 않았습니다.')
    const size = supplied?.get(node.id) ?? { width: external?.displayWidth ?? 218, height: external?.displayHeight ?? 180,
      outsets: { left: 12, top: node.data?.waitingItems?.length ? 40 : 12, right: children.get(node.id).length ? 24 : 12, bottom: 12 } }
    return [node.id, { width: pixelCeil(size.width), height: pixelCeil(size.height), outsets: size.outsets }]
  }))
  const sequence = []; const depths = new Map([[roots[0].id, 0]]); const stack = [roots[0].id]
  while (stack.length) {
    const id = stack.pop(); sequence.push(id)
    for (const child of [...children.get(id)].reverse()) {
      if (depths.has(child)) fail('계층 순환 때문에 배치할 수 없습니다.')
      depths.set(child, depths.get(id) + 1); stack.push(child)
    }
  }
  if (sequence.length !== map.nodes.length) fail('루트에 연결되지 않은 카드가 있습니다.')
  const columnWidths = []; const heights = new Map()
  for (const id of [...sequence].reverse()) {
    const size = sizes.get(id); const depth = depths.get(id)
    columnWidths[depth] = Math.max(columnWidths[depth] ?? 0, size.width + size.outsets.left + size.outsets.right)
    const kids = children.get(id)
    heights.set(id, Math.max(size.height + size.outsets.top + size.outsets.bottom, kids.reduce((sum, child) => sum + heights.get(child), 0) + Math.max(0, kids.length - 1) * siblingGap))
  }
  const columns = [0]
  for (let depth = 1; depth < columnWidths.length; depth++) columns[depth] = columns[depth - 1] + columnWidths[depth - 1] + columnGap
  const tops = new Map([[roots[0].id, 0]]); const positions = new Map(); const boxes = []
  for (const id of sequence) {
    const size = sizes.get(id); const height = heights.get(id); const top = tops.get(id)
    const envelopeHeight = size.height + size.outsets.top + size.outsets.bottom
    const box = { cardId: id, x: columns[depths.get(id)], y: top + Math.floor((height - envelopeHeight) / 2), width: size.width + size.outsets.left + size.outsets.right, height: envelopeHeight, body: size }
    boxes.push(box); positions.set(id, { x: box.x + size.outsets.left, y: box.y + size.outsets.top })
    const kids = children.get(id)
    const childrenHeight = kids.reduce((sum, child) => sum + heights.get(child), 0) + Math.max(0, kids.length - 1) * siblingGap
    let childTop = top + Math.floor((height - childrenHeight) / 2)
    for (const child of kids) { tops.set(child, childTop); childTop += heights.get(child) + siblingGap }
  }
  assertLayoutClear(boxes)
  // AI가 넣은 hidden/parentId/style/transform 등 렌더 배치 우회 필드는 새 문서에 복제하지 않는다.
  return { map: { ...map, nodes: map.nodes.map((node) => ({ id: node.id, type: 'mind', position: positions.get(node.id), data: structuredClone(node.data) })) },
    layout: { version: MIND_MAP_LAYOUT_VERSION, gap: MIND_MAP_LAYOUT_GAP, boxes, width: Math.max(...boxes.map((box) => box.x + box.width)), height: Math.max(...boxes.map((box) => box.y + box.height)) } }
}

export function verifyRenderedLayout(map, layout, measurements) {
  const measured = validateLayoutMeasurements(map.nodes, measurements)
  const nodeById = new Map(map.nodes.map((node) => [node.id, node]))
  const boxesById = new Map(layout.boxes.map((box) => [box.cardId, box]))
  const actualBoxes = measured.map((item) => {
    const node = nodeById.get(item.cardId); const box = boxesById.get(item.cardId)
    if (Math.abs(item.x - node.position.x) > 1 || Math.abs(item.y - node.position.y) > 1) fail(`미리보기 카드 좌표가 달라졌습니다: ${item.cardId}`)
    const actual = { cardId: item.cardId, x: item.x - item.outsets.left, y: item.y - item.outsets.top,
      width: item.width + item.outsets.left + item.outsets.right, height: item.height + item.outsets.top + item.outsets.bottom }
    if (actual.x < box.x - 1 || actual.y < box.y - 1 || actual.x + actual.width > box.x + box.width + 1 || actual.y + actual.height > box.y + box.height + 1) fail(`카드 크기가 검증한 배치 영역을 벗어났습니다: ${item.cardId}`)
    return actual
  })
  assertLayoutClear(actualBoxes, MIND_MAP_LAYOUT_GAP - 2)
  return true
}
