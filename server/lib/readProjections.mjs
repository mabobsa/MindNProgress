// 선택 범위는 캐시 원문 안에서 구성하고 반환할 값만 복제한다.
export function mapFields(map) {
  const { nodes: _nodes, edges: _edges, ...fields } = map
  return fields
}

export function referenceTargets(map, cardId) {
  return map.nodes.flatMap((node) => (!cardId || node.id === cardId) && node.data?.reference
    ? [{ localNodeId: node.id, ...node.data.reference }] : [])
}

export function reviewMap(map, cardId) {
  const card = map.nodes.find((node) => node.id === cardId)
  const edges = map.edges.filter((edge) => edge.source === cardId || edge.target === cardId)
  const ids = new Set([cardId, ...(card?.data?.blockedBy ?? []), ...edges.flatMap((edge) => [edge.source, edge.target]),
    ...map.nodes.filter((node) => node.data?.blockedBy?.includes(cardId)).map((node) => node.id)])
  return { ...mapFields(map), nodes: map.nodes.filter((node) => ids.has(node.id)), edges }
}

export function commentProjection(comments, mapId) {
  const sorted = (Array.isArray(comments) ? comments : []).filter((comment) => comment?.mapId === mapId)
    .map((comment) => ({ ...comment,
      parentId: typeof comment.parentId === 'string' ? comment.parentId : null,
      resolvedAt: typeof comment.resolvedAt === 'string' ? comment.resolvedAt : null,
      resolvedBy: comment.resolvedBy?.id ? comment.resolvedBy : null,
      reactions: comment.reactions && typeof comment.reactions === 'object' ? comment.reactions : {},
    })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const byNode = Object.create(null), stats = Object.create(null)
  for (const comment of sorted) {
    ;(byNode[comment.nodeId] ??= []).push(comment)
    const count = stats[comment.nodeId] ??= { total: 0, unresolved: 0 }
    count.total++; if (!comment.parentId && !comment.resolvedAt) count.unresolved++
  }
  return { comments: sorted, byNode, stats }
}

export function commentPage(comments, { offset = 0, limit = 20, order = 'desc' } = {}) {
  const ordered = order === 'asc' ? comments : [...comments].reverse()
  const items = ordered.slice(offset, offset + limit)
  const nextOffset = offset + items.length
  return { items, page: { total: comments.length, offset, limit, order,
    hasMore: nextOffset < comments.length, nextOffset: nextOffset < comments.length ? nextOffset : null } }
}
