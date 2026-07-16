import type { Node } from '@xyflow/react'
import type { MindNodeData } from '../types/mindMap'

export type DependencyNode = Node<MindNodeData, 'mind'>

export function isWorkComplete(node: DependencyNode | undefined) {
  return Boolean(node && (node.data.progress >= 100 || node.data.status === 'done'))
}

export function blockingNodes(node: DependencyNode, nodes: DependencyNode[]) {
  const nodesById = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  return (node.data.blockedBy ?? [])
    .map((nodeId) => nodesById.get(nodeId))
    .filter((candidate): candidate is DependencyNode => Boolean(candidate) && !isWorkComplete(candidate))
}

export function prerequisiteNodes(node: DependencyNode, nodes: DependencyNode[]) {
  const nodesById = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  return (node.data.blockedBy ?? [])
    .map((nodeId) => nodesById.get(nodeId))
    .filter((candidate): candidate is DependencyNode => Boolean(candidate))
}

export function dependentNodes(nodeId: string, nodes: DependencyNode[]) {
  return nodes.filter((node) => (node.data.blockedBy ?? []).includes(nodeId))
}

export function createsDependencyCycle(taskId: string, prerequisiteId: string, nodes: DependencyNode[]) {
  if (taskId === prerequisiteId) return true
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const visited = new Set<string>()
  const stack = [prerequisiteId]

  while (stack.length > 0) {
    const currentId = stack.pop() as string
    if (currentId === taskId) return true
    if (visited.has(currentId)) continue
    visited.add(currentId)
    stack.push(...(nodesById.get(currentId)?.data.blockedBy ?? []))
  }
  return false
}
