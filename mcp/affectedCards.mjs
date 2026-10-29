import { isReferenceNode, projectReferenceNodeData, referenceLocalData } from '../server/lib/referenceProjection.mjs'

// 카드 변경 도구의 affected 응답을 만드는 순수 함수들.
// 변경 전 문서는 Ref 원본이 투영된 조회본(GET)이고, 저장 API(content-patch)는 투영하지 않은 저장본을 돌려준다.
// 두 문서를 그대로 비교하면 바뀌지 않은 Ref 카드가 모두 변경으로 잡히고 오래된 사본이 반환되므로,
// Ref 카드는 투영 필드를 빼고 비교하고 응답에는 조회 시점의 투영값을 쓴다.

export const UPDATE_CARD_UNCHANGED_FIELD_LIMIT = 1000
const ADJUSTED_SUMMARY_KEYS = ['label', 'kind', 'status', 'progress', 'isWork']

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

export function changedDataKeys(previousData, savedData) {
  const keys = new Set([...Object.keys(previousData ?? {}), ...Object.keys(savedData ?? {})])
  return [...keys].filter((key) => JSON.stringify(previousData?.[key]) !== JSON.stringify(savedData?.[key]))
}

function changedNodeKeys(previousNode, savedNode) {
  const keys = changedDataKeys(referenceLocalData(previousNode ?? {}) ?? {}, referenceLocalData(savedNode) ?? {})
  if (JSON.stringify(previousNode?.position) !== JSON.stringify(savedNode.position)) keys.push('position')
  return keys
}

/**
 * update_card affected 응답의 서버 조정 카드 요약. 요청 카드는 card에 있으므로 excludedCardIds로 뺀다.
 * 원문 대신 상태 요약과 바뀐 키만 주며, 원문은 get_card로 읽는다.
 */
export function adjustedCardSummaries(previousMap, savedMap, { rootCardId, excludedCardIds = [] } = {}) {
  const excluded = new Set(excludedCardIds)
  const changed = new Set(changedCardIds(previousMap, savedMap))
  const previousById = new Map(previousMap.nodes.map((node) => [node.id, node]))
  return savedMap.nodes
    .filter((node) => changed.has(node.id) && !excluded.has(node.id))
    .map((node) => {
      const previousNode = previousById.get(node.id)
      const shown = referenceProjectedNode(node, previousNode, savedMap)
      const changedKeys = previousNode ? changedNodeKeys(previousNode, node) : ['created']
      const data = Object.fromEntries(ADJUSTED_SUMMARY_KEYS
        .filter((key) => shown.data?.[key] !== undefined)
        .map((key) => [key, key === 'status' && shown.data?.progress >= 100 ? 'done' : shown.data[key]]))
      return {
        reason: node.id === rootCardId ? 'root-rollup' : 'server-adjusted',
        card: {
          id: node.id,
          data,
          changedKeys,
          ...(changedKeys.includes('position') ? { position: node.position } : {}),
        },
      }
    })
}

/**
 * update_card affected 응답의 요청 카드 data. 요청한 필드와 저장 중 바뀐 필드는 원문으로 두고,
 * 바꾸지 않은 필드 중 직렬화 크기가 limit를 넘는 값만 생략해 omittedFields로 알린다.
 */
export function compactRequestedCardData(previousData, savedData, shownData, requestedKeys, limit = UPDATE_CARD_UNCHANGED_FIELD_LIMIT) {
  const kept = new Set([...requestedKeys, ...changedDataKeys(previousData, savedData)])
  if (kept.has('aiConversations')) kept.add('aiConversationCount')
  const data = {}
  const omittedFields = []
  for (const [key, value] of Object.entries(shownData ?? {})) {
    if (kept.has(key) || JSON.stringify(value).length <= limit) data[key] = value
    else omittedFields.push(key)
  }
  return { data, omittedFields }
}
