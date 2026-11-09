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

export function planCrossDocumentCardMove({ sourceMap, targetMap, cardId, cardIds, targetParentCardId, targetPosition }) {
  if (!sourceMap || !targetMap || !Array.isArray(sourceMap.nodes) || !Array.isArray(sourceMap.edges)
    || !Array.isArray(targetMap.nodes) || !Array.isArray(targetMap.edges)) {
    fail('원본 또는 대상 문서 형식이 올바르지 않습니다.', 400, 'CARD_MOVE_INVALID_DOCUMENT')
  }
  const sameDocument = sourceMap.id === targetMap.id
  const requestedIds = cardIds ?? [cardId]
  if (!Array.isArray(requestedIds) || !requestedIds.length || requestedIds.length > 1000
    || requestedIds.some((id) => typeof id !== 'string' || !id || id.length > 120)) {
    fail('이동할 카드 목록이 올바르지 않습니다.', 400, 'CARD_MOVE_INVALID_REQUEST')
  }
  const selectedIds = new Set(requestedIds)
  const sourceNodes = new Map(sourceMap.nodes.map((node) => [node.id, node]))
  for (const id of selectedIds) {
    if (!sourceNodes.has(id)) fail('이동할 카드를 찾을 수 없습니다.', 404, 'CARD_MOVE_CARD_NOT_FOUND', { cardIds: [id] })
    if (sourceNodes.get(id).data?.kind === 'root') {
      fail('문서의 최상위 카드는 이동할 수 없습니다.', 409, 'CARD_MOVE_ROOT_NOT_ALLOWED', { cardIds: [id] })
    }
  }
  const targetParent = targetMap.nodes.find((node) => node.id === targetParentCardId)
  if (!targetParent) fail('대상 문서에서 새 상위 카드를 찾을 수 없습니다.', 404, 'CARD_MOVE_PARENT_NOT_FOUND')

  const movedCardIds = new Set([...selectedIds].flatMap((id) => [...descendantsIncluding(id, sourceMap.edges)]))
  if (sameDocument && movedCardIds.has(targetParentCardId)) {
    fail('자기 자신이나 하위 카드 아래로 이동할 수 없습니다.', 409, 'CARD_MOVE_CYCLE', { cardIds: [targetParentCardId] })
  }
  const rootCardIds = sourceMap.nodes.filter((node) => selectedIds.has(node.id)
    && !sourceMap.edges.some((edge) => hierarchyEdge(edge) && edge.target === node.id && movedCardIds.has(edge.source))).map((node) => node.id)
  if (!rootCardIds.length) fail('이동할 카드의 계층이 순환합니다.', 409, 'CARD_MOVE_INVALID_HIERARCHY')
  const rootIds = new Set(rootCardIds)
  const reachableIds = new Set(rootCardIds.flatMap((id) => [...descendantsIncluding(id, sourceMap.edges)]))
  if (reachableIds.size !== movedCardIds.size) fail('이동할 카드의 계층이 순환합니다.', 409, 'CARD_MOVE_INVALID_HIERARCHY')
  const movedNodes = sourceMap.nodes.filter((node) => movedCardIds.has(node.id))
  const existingTargetCardIds = new Set(targetMap.nodes.filter((node) => !sameDocument || !movedCardIds.has(node.id)).map((node) => node.id))
  const collidingCardIds = movedNodes.filter((node) => existingTargetCardIds.has(node.id)).map((node) => node.id)
  if (collidingCardIds.length > 0) {
    fail('대상 문서에 같은 ID의 카드가 있어 이동할 수 없습니다.', 409, 'CARD_MOVE_CARD_ID_COLLISION', { cardIds: collidingCardIds })
  }

  const previousParentEdges = sourceMap.edges.filter((edge) => hierarchyEdge(edge) && rootIds.has(edge.target) && !movedCardIds.has(edge.source))
  const enteringHierarchyEdges = sourceMap.edges.filter((edge) => hierarchyEdge(edge)
    && !movedCardIds.has(edge.source) && movedCardIds.has(edge.target))
  const invalidInternalParents = movedNodes.flatMap((node) => {
    const incoming = sourceMap.edges.filter((edge) => hierarchyEdge(edge)
      && movedCardIds.has(edge.source) && edge.target === node.id)
    const expected = rootIds.has(node.id) ? 0 : 1
    return incoming.length === expected ? [] : [{ cardId: node.id, edgeIds: incoming.map((edge) => edge.id) }]
  })
  // 자유 배치한 Ref·자료 카드도 이동할 수 있지만 여러 상위를 가진 계층은 거부한다.
  if (rootCardIds.some((id) => previousParentEdges.filter((edge) => edge.target === id).length > 1)
    || enteringHierarchyEdges.some((edge) => !rootIds.has(edge.target)) || invalidInternalParents.length > 0) {
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
  if (!sameDocument && (boundaryKnowledgeEdges.length > 0 || boundaryBlockedBy.length > 0)) {
    fail('문서 경계를 가로지르게 되는 지식선 또는 선행 관계가 있어 이동할 수 없습니다. 관계를 제거하거나 Ref로 바꾼 뒤 다시 시도하세요.', 409, 'CARD_MOVE_CROSS_DOCUMENT_RELATION', {
      knowledgeEdges: boundaryKnowledgeEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
      blockedBy: boundaryBlockedBy,
    })
  }

  const internalEdges = sourceMap.edges.filter((edge) => movedCardIds.has(edge.source) && movedCardIds.has(edge.target))
  const remainingTargetEdges = sameDocument ? targetMap.edges.filter((edge) => !previousParentEdges.includes(edge)) : targetMap.edges
  const targetEdgeIds = new Set(remainingTargetEdges.filter((edge) => !sameDocument
    || !movedCardIds.has(edge.source) || !movedCardIds.has(edge.target)).map((edge) => edge.id))
  const collidingEdgeIds = internalEdges.filter((edge) => targetEdgeIds.has(edge.id)).map((edge) => edge.id)
  if (collidingEdgeIds.length > 0) {
    fail('대상 문서에 같은 ID의 관계선이 있어 이동할 수 없습니다.', 409, 'CARD_MOVE_EDGE_ID_COLLISION', { edgeIds: collidingEdgeIds })
  }

  const usedEdgeIds = new Set([...targetEdgeIds, ...internalEdges.map((edge) => edge.id)])
  const targetHierarchyEdges = rootCardIds.map((rootId) => {
    const hierarchyEdgeId = uniqueEdgeId(`edge-${targetParentCardId}-${rootId}`, usedEdgeIds)
    usedEdgeIds.add(hierarchyEdgeId)
    return {
      id: hierarchyEdgeId,
      source: targetParentCardId,
      target: rootId,
      type: 'default',
      data: { relation: 'hierarchy' },
      markerEnd: { type: 'arrowclosed', width: 16, height: 16 },
    }
  })
  if (targetPosition !== undefined && (!targetPosition || !Number.isFinite(targetPosition.x) || !Number.isFinite(targetPosition.y)
    || Math.abs(targetPosition.x) > 1_000_000 || Math.abs(targetPosition.y) > 1_000_000)) {
    fail('붙여넣을 위치가 올바르지 않습니다.', 400, 'CARD_MOVE_INVALID_POSITION')
  }
  const minX = Math.min(...movedNodes.map((node) => node.position.x))
  const minY = Math.min(...movedNodes.map((node) => node.position.y))
  const positionedNodes = structuredClone(movedNodes).map((node) => targetPosition
    ? { ...node, position: { x: targetPosition.x + node.position.x - minX, y: targetPosition.y + node.position.y - minY } } : node)
  const nextSourceMap = {
    ...sourceMap,
    nodes: sourceMap.nodes.filter((node) => !movedCardIds.has(node.id)),
    edges: sourceMap.edges.filter((edge) => !movedCardIds.has(edge.source) && !movedCardIds.has(edge.target)),
  }
  const positionedById = new Map(positionedNodes.map((node) => [node.id, node]))
  const nextTargetMap = {
    ...targetMap,
    nodes: sameDocument ? targetMap.nodes.map((node) => positionedById.get(node.id) ?? node)
      : [...targetMap.nodes, ...positionedNodes],
    edges: sameDocument ? [...remainingTargetEdges, ...targetHierarchyEdges]
      : [...targetMap.edges, ...structuredClone(internalEdges), ...targetHierarchyEdges],
  }
  if (nextTargetMap.nodes.length > 1000 || nextTargetMap.edges.length > 2000) {
    fail('대상 문서의 카드 또는 관계선 한도를 초과합니다.', 409, 'CARD_MOVE_TARGET_LIMIT', {
      nodeCount: nextTargetMap.nodes.length,
      edgeCount: nextTargetMap.edges.length,
    })
  }

  return {
    sourceMap: sameDocument ? nextTargetMap : nextSourceMap,
    targetMap: nextTargetMap,
    movedCardIds,
    rootCardIds,
    previousParentCardId: previousParentEdges.find((edge) => edge.target === rootCardIds[0])?.source ?? null,
    previousParents: rootCardIds.map((id) => ({ cardId: id, parentCardId: previousParentEdges.find((edge) => edge.target === id)?.source ?? null })),
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
