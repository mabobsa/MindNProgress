import { isReferenceNode, projectReferenceNodeData, referenceLocalData } from '../server/lib/referenceProjection.mjs'

// 카드 변경 도구의 affected 응답을 만드는 순수 함수들.
// 변경 전 문서는 Ref 원본이 투영된 조회본(GET)이고, 저장 API(content-patch)는 투영하지 않은 저장본을 돌려준다.
// 두 문서를 그대로 비교하면 바뀌지 않은 Ref 카드가 모두 변경으로 잡히고 오래된 사본이 반환되므로,
// Ref 카드는 투영 필드를 빼고 비교하고 응답에는 조회 시점의 투영값을 쓴다.

function comparableNode(node) {
  return isReferenceNode(node) ? { ...node, data: referenceLocalData(node) } : node
}

export function changedCardIds(previousMap, savedMap) {
  const previousNodes = new Map(previousMap.nodes.map((node) => [node.id, JSON.stringify(comparableNode(node))]))
  return savedMap.nodes
    .filter((node) => previousNodes.get(node.id) !== JSON.stringify(comparableNode(node)))
    .map((node) => node.id)
}

/** 저장본의 Ref 카드에 원본 값을 투영한다. 같은 문서의 원본은 저장 후 값, 다른 문서의 원본은 조회 시점 값을 쓴다. */
export function referenceProjectedNode(savedNode, previousNode, savedMap) {
  if (!isReferenceNode(savedNode)) return savedNode
  const reference = savedNode.data.reference
  const sameDocumentSource = reference.mapId === savedMap?.id
    ? savedMap.nodes.find((node) => node.id === reference.nodeId && !isReferenceNode(node))
    : null
  const sourceData = sameDocumentSource?.data ?? (isReferenceNode(previousNode) ? previousNode.data : null)
  return sourceData ? { ...savedNode, data: projectReferenceNodeData(savedNode.data, sourceData) } : savedNode
}
