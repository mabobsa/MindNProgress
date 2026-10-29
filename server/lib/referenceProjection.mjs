// Ref 카드는 조회할 때 아래 data 필드를 원본 카드 값으로 덮어쓰고 label 끝에 (ref)를 붙인다.
// 저장본의 Ref 카드에는 이 필드의 오래된 사본이 남아 있을 수 있으므로, 저장본과 조회본을 비교할 때는 이 필드와 label을 빼야 한다.
export const REFERENCE_CONTENT_KEYS = Object.freeze([
  'description',
  'sharedKnowledge',
  'sharedKnowledgeUpdatedAt',
  'sharedKnowledgeUpdatedBy',
  'sharedKnowledgeReview',
  'progress',
  'status',
  'taskUrl',
  'externalLink',
  'webLink',
  'aiConversationId',
  'aiConversations',
  'isWork',
  'assigneeId',
  'dueDate',
  'checklist',
  'waitingItems',
])

export function isReferenceNode(node) {
  const reference = node?.data?.reference
  return typeof reference?.mapId === 'string' && typeof reference?.nodeId === 'string'
}

export function projectReferenceNodeData(localData, sourceData) {
  const projected = { ...localData }
  for (const key of REFERENCE_CONTENT_KEYS) {
    if (Object.hasOwn(sourceData, key)) projected[key] = structuredClone(sourceData[key])
    else delete projected[key]
  }
  const sourceLabel = String(sourceData.label ?? '').replace(/\s*\(ref\)\s*$/i, '').trim()
  projected.label = `${sourceLabel || String(localData.label ?? '').replace(/\s*\(ref\)\s*$/i, '').trim()} (ref)`
  return projected
}

/** Ref 카드에서 원본 투영 필드와 label을 뺀 비교용 data. Ref가 아니면 그대로 반환한다. */
export function referenceLocalData(node) {
  if (!isReferenceNode(node)) return node?.data
  const local = { ...node.data }
  for (const key of REFERENCE_CONTENT_KEYS) delete local[key]
  delete local.label
  return local
}
