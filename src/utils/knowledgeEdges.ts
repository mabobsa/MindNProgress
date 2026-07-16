import type { KnowledgePolicy, MindMapEdgeData } from '../types/mindMap'

type RelationEdge = {
  source: string
  target: string
  data?: MindMapEdgeData
}

export function isKnowledgeEdge(edge: RelationEdge) {
  return edge.data?.relation === 'knowledge'
}

export function isHierarchyEdge(edge: RelationEdge) {
  return !isKnowledgeEdge(edge)
}

export function knowledgePolicyOf(edge: RelationEdge): KnowledgePolicy {
  return edge.data?.knowledgePolicy === 'inspect-if-insufficient'
    ? 'inspect-if-insufficient'
    : 'reuse-first'
}

export function createsKnowledgeCycle(sourceId: string, targetId: string, edges: RelationEdge[]) {
  if (sourceId === targetId) return true
  const knowledgeEdges = edges.filter(isKnowledgeEdge)
  const visited = new Set<string>()
  const stack = [targetId]
  while (stack.length > 0) {
    const currentId = stack.pop()
    if (!currentId || visited.has(currentId)) continue
    if (currentId === sourceId) return true
    visited.add(currentId)
    knowledgeEdges
      .filter((edge) => edge.source === currentId)
      .forEach((edge) => stack.push(edge.target))
  }
  return false
}
