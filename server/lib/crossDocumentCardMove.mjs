export class CrossDocumentCardMoveError extends Error {
  constructor(message, status = 400, code = 'CARD_MOVE_INVALID', details = undefined) {
    super(message)
    this.name = 'CrossDocumentCardMoveError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const hierarchyEdge = (edge) => edge?.data?.relation !== 'knowledge'
const knowledgeEdge = (edge) => edge?.data?.relation === 'knowledge'

function fail(message, status, code, details) {
  throw new CrossDocumentCardMoveError(message, status, code, details)
}

function descendantsIncluding(cardId, edges) {
  const children = new Map()
  for (const edge of edges.filter(hierarchyEdge)) {
    const values = children.get(edge.source) ?? []
    values.push(edge.target)
    children.set(edge.source, values)
  }
  const moved = new Set()
  const pending = [cardId]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || moved.has(current)) continue
    moved.add(current)
    pending.push(...(children.get(current) ?? []))
  }
  return moved
}

function uniqueEdgeId(preferred, used) {
  if (!used.has(preferred)) return preferred
  let suffix = 2
  while (used.has(`${preferred}-${suffix}`)) suffix += 1
  return `${preferred}-${suffix}`
}

function blockedByBoundary(sourceMap, movedCardIds) {
  const conflicts = []
  for (const node of sourceMap.nodes) {
    for (const blockedById of Array.isArray(node.data?.blockedBy) ? node.data.blockedBy : []) {
      if ((movedCardIds.has(node.id) && !movedCardIds.has(blockedById))
        || (!movedCardIds.has(node.id) && movedCardIds.has(blockedById))) {
        conflicts.push({ cardId: node.id, blockedByCardId: blockedById })
      }
    }
  }
  return conflicts
}

export function planCrossDocumentCardMove({ sourceMap, targetMap, cardId, targetParentCardId }) {
  if (!sourceMap || !targetMap || !Array.isArray(sourceMap.nodes) || !Array.isArray(sourceMap.edges)
    || !Array.isArray(targetMap.nodes) || !Array.isArray(targetMap.edges)) {
    fail('원본 또는 대상 문서 형식이 올바르지 않습니다.', 400, 'CARD_MOVE_INVALID_DOCUMENT')
  }
  if (sourceMap.id === targetMap.id) {
    fail('문서 간 이동에는 서로 다른 원본과 대상 문서가 필요합니다.', 400, 'CARD_MOVE_SAME_DOCUMENT')
  }
  const movedRoot = sourceMap.nodes.find((node) => node.id === cardId)
  if (!movedRoot) fail('이동할 카드를 찾을 수 없습니다.', 404, 'CARD_MOVE_CARD_NOT_FOUND')
  if (movedRoot.data?.kind === 'root') {
    fail('문서의 최상위 카드는 다른 문서로 이동할 수 없습니다.', 409, 'CARD_MOVE_ROOT_NOT_ALLOWED')
  }
  const targetParent = targetMap.nodes.find((node) => node.id === targetParentCardId)
  if (!targetParent) fail('대상 문서에서 새 상위 카드를 찾을 수 없습니다.', 404, 'CARD_MOVE_PARENT_NOT_FOUND')

  const movedCardIds = descendantsIncluding(cardId, sourceMap.edges)
  const movedNodes = sourceMap.nodes.filter((node) => movedCardIds.has(node.id))
  const existingTargetCardIds = new Set(targetMap.nodes.map((node) => node.id))
  const collidingCardIds = movedNodes.filter((node) => existingTargetCardIds.has(node.id)).map((node) => node.id)
  if (collidingCardIds.length > 0) {
    fail('대상 문서에 같은 ID의 카드가 있어 이동할 수 없습니다.', 409, 'CARD_MOVE_CARD_ID_COLLISION', { cardIds: collidingCardIds })
  }

  const previousParentEdges = sourceMap.edges.filter((edge) => hierarchyEdge(edge) && edge.target === cardId && !movedCardIds.has(edge.source))
  const enteringHierarchyEdges = sourceMap.edges.filter((edge) => hierarchyEdge(edge)
    && !movedCardIds.has(edge.source) && movedCardIds.has(edge.target))
  const invalidInternalParents = movedNodes.flatMap((node) => {
    const incoming = sourceMap.edges.filter((edge) => hierarchyEdge(edge)
      && movedCardIds.has(edge.source) && edge.target === node.id)
    const expected = node.id === cardId ? 0 : 1
    return incoming.length === expected ? [] : [{ cardId: node.id, edgeIds: incoming.map((edge) => edge.id) }]
  })
  if (previousParentEdges.length !== 1 || enteringHierarchyEdges.length !== 1
    || enteringHierarchyEdges[0]?.id !== previousParentEdges[0]?.id || invalidInternalParents.length > 0) {
    fail('이동할 카드의 상위 계층 관계가 하나가 아닙니다.', 409, 'CARD_MOVE_INVALID_HIERARCHY', {
      cardId,
      parentEdgeIds: enteringHierarchyEdges.map((edge) => edge.id),
      invalidInternalParents,
    })
  }
  const escapingHierarchyEdges = sourceMap.edges.filter((edge) => hierarchyEdge(edge)
    && movedCardIds.has(edge.source) && !movedCardIds.has(edge.target))
  if (escapingHierarchyEdges.length > 0) {
    fail('이동할 하위 트리의 계층 관계가 완전하지 않습니다.', 409, 'CARD_MOVE_INVALID_HIERARCHY', {
      edgeIds: escapingHierarchyEdges.map((edge) => edge.id),
    })
  }

  const boundaryKnowledgeEdges = sourceMap.edges.filter((edge) => knowledgeEdge(edge)
    && movedCardIds.has(edge.source) !== movedCardIds.has(edge.target))
  const boundaryBlockedBy = blockedByBoundary(sourceMap, movedCardIds)
  if (boundaryKnowledgeEdges.length > 0 || boundaryBlockedBy.length > 0) {
    fail('문서 경계를 가로지르게 되는 지식선 또는 선행 관계가 있어 이동할 수 없습니다. 관계를 제거하거나 Ref로 바꾼 뒤 다시 시도하세요.', 409, 'CARD_MOVE_CROSS_DOCUMENT_RELATION', {
      knowledgeEdges: boundaryKnowledgeEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
      blockedBy: boundaryBlockedBy,
    })
  }

  const internalEdges = sourceMap.edges.filter((edge) => movedCardIds.has(edge.source) && movedCardIds.has(edge.target))
  const targetEdgeIds = new Set(targetMap.edges.map((edge) => edge.id))
  const collidingEdgeIds = internalEdges.filter((edge) => targetEdgeIds.has(edge.id)).map((edge) => edge.id)
  if (collidingEdgeIds.length > 0) {
    fail('대상 문서에 같은 ID의 관계선이 있어 이동할 수 없습니다.', 409, 'CARD_MOVE_EDGE_ID_COLLISION', { edgeIds: collidingEdgeIds })
  }

  const usedEdgeIds = new Set([...targetEdgeIds, ...internalEdges.map((edge) => edge.id)])
  const hierarchyEdgeId = uniqueEdgeId(`edge-${targetParentCardId}-${cardId}`, usedEdgeIds)
  const targetHierarchyEdge = {
    id: hierarchyEdgeId,
    source: targetParentCardId,
    target: cardId,
    type: 'default',
    data: { relation: 'hierarchy' },
    markerEnd: { type: 'arrowclosed', width: 16, height: 16 },
  }
  const nextSourceMap = {
    ...sourceMap,
    nodes: sourceMap.nodes.filter((node) => !movedCardIds.has(node.id)),
    edges: sourceMap.edges.filter((edge) => !movedCardIds.has(edge.source) && !movedCardIds.has(edge.target)),
  }
  const nextTargetMap = {
    ...targetMap,
    nodes: [...targetMap.nodes, ...structuredClone(movedNodes)],
    edges: [...targetMap.edges, ...structuredClone(internalEdges), targetHierarchyEdge],
  }
  if (nextTargetMap.nodes.length > 1000 || nextTargetMap.edges.length > 2000) {
    fail('대상 문서의 카드 또는 관계선 한도를 초과합니다.', 409, 'CARD_MOVE_TARGET_LIMIT', {
      nodeCount: nextTargetMap.nodes.length,
      edgeCount: nextTargetMap.edges.length,
    })
  }

  return {
    sourceMap: nextSourceMap,
    targetMap: nextTargetMap,
    movedCardIds,
    previousParentCardId: previousParentEdges[0].source,
    targetParentCardId,
  }
}

export function rewriteMovedCardReferences(map, sourceMapId, targetMapId, movedCardIds) {
  let updatedReferenceCount = 0
  const nodes = map.nodes.map((node) => {
    const reference = node.data?.reference
    if (!reference || reference.mapId !== sourceMapId || !movedCardIds.has(reference.nodeId)) return node
    updatedReferenceCount += 1
    return {
      ...node,
      data: {
        ...node.data,
        reference: { ...reference, mapId: targetMapId },
      },
    }
  })
  return {
    map: updatedReferenceCount > 0 ? { ...map, nodes } : map,
    updatedReferenceCount,
  }
}
