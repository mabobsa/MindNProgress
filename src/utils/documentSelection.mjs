export const PHONE_VIEWPORT_QUERY = '(max-width: 720px)'

export function isPhoneViewport(matchMedia = globalThis.window?.matchMedia?.bind(globalThis.window)) {
  return typeof matchMedia === 'function' && matchMedia(PHONE_VIEWPORT_QUERY).matches
}

export function resolveDocumentNodeSelection(nodes, preferredNodeId, phoneViewport) {
  const preferredNode = typeof preferredNodeId === 'string'
    ? nodes.find((node) => node.id === preferredNodeId)
    : null
  if (preferredNode) return preferredNode.id
  if (phoneViewport) return null
  return nodes[0]?.id ?? null
}

export function synchronizeNodeSelection(nodes, selectedId) {
  return nodes.map((node) => {
    const selected = node.id === selectedId
    return Boolean(node.selected) === selected ? node : { ...node, selected }
  })
}

export function hierarchyAncestorNodeIds(edges, nodeId) {
  const parentsById = new Map()
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge?.source || !edge?.target || edge.data?.relation === 'knowledge') continue
    parentsById.set(edge.target, [...(parentsById.get(edge.target) ?? []), edge.source])
  }

  const result = new Set()
  const remaining = [...(parentsById.get(nodeId) ?? [])]
  while (remaining.length > 0) {
    const ancestorId = remaining.pop()
    if (!ancestorId || ancestorId === nodeId || result.has(ancestorId)) continue
    result.add(ancestorId)
    remaining.push(...(parentsById.get(ancestorId) ?? []))
  }
  return result
}
