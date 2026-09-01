// 카드를 끌 때 함께 움직일 하위 카드를 모은다.
// 여러 카드를 선택해 끌면 선택한 카드 각각의 하위가 모두 따라와야 하므로
// 드래그한 카드 하나가 아니라 함께 움직이는 카드 전체에서 출발한다.

export function dragRootIds(draggedNodeId, selectedNodeIds = []) {
  const rootIds = new Set([draggedNodeId])
  // 드래그한 카드가 선택에 포함되지 않았다면 그 카드만 끄는 것이므로 선택은 무시한다.
  if (![...selectedNodeIds].includes(draggedNodeId)) return rootIds
  for (const nodeId of selectedNodeIds) rootIds.add(nodeId)
  return rootIds
}

export function hierarchyReparentPairs(targetId, movedNodeIds) {
  const movedIds = [...new Set(movedNodeIds)].filter((nodeId) => nodeId && nodeId !== targetId)
  return movedIds.map((nodeId) => ({ source: targetId, target: nodeId }))
}

export function collectDragDescendantIds(rootIds, hierarchyEdges) {
  return new Set(collectDragDescendantOwners(rootIds, hierarchyEdges).keys())
}

export function collectDragDescendantOwners(rootIds, hierarchyEdges) {
  const roots = new Set(rootIds)
  const childrenByParent = new Map()
  for (const edge of hierarchyEdges ?? []) {
    const children = childrenByParent.get(edge.source) ?? []
    children.push(edge.target)
    childrenByParent.set(edge.source, children)
  }

  const descendantOwners = new Map()
  const pending = [...roots].map((rootId) => ({ nodeId: rootId, rootId }))
  while (pending.length > 0) {
    const current = pending.shift()
    if (!current) continue
    for (const childId of childrenByParent.get(current.nodeId) ?? []) {
      // 함께 끄는 카드는 자기 위치로 움직이므로 하위 목록에 넣지 않는다.
      if (descendantOwners.has(childId) || roots.has(childId)) continue
      descendantOwners.set(childId, current.rootId)
      pending.push({ nodeId: childId, rootId: current.rootId })
    }
  }
  return descendantOwners
}
