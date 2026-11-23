import { createHash } from 'node:crypto'

export const sharedKnowledgeReviewResults = Object.freeze([
  'cleaned',
  'accepted-long',
])

export function sharedKnowledgeSha256(value) {
  const text = typeof value === 'string' ? value : ''
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizeReviewer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!id || id.length > 120 || !name || name.length > 200) return null
  return { id, name }
}

function isCanonicalIsoDate(value) {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

export function normalizeSharedKnowledgeReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const reviewedBy = normalizeReviewer(value.reviewedBy)
  if (!isCanonicalIsoDate(value.reviewedAt)
    || !/^[a-f0-9]{64}$/.test(value.reviewedHash)
    || !sharedKnowledgeReviewResults.includes(value.reviewResult)
    || !reviewedBy) return null

  return {
    reviewedAt: value.reviewedAt,
    reviewedHash: value.reviewedHash,
    reviewedBy,
    reviewResult: value.reviewResult,
  }
}

export function isValidSharedKnowledgeReview(value) {
  return normalizeSharedKnowledgeReview(value) !== null
}

export function sharedKnowledgeReviewState(value, review, currentHash = sharedKnowledgeSha256(value)) {
  const text = typeof value === 'string' ? value : ''
  if (!text.trim()) return { state: 'not-applicable', review: null }

  const normalizedReview = normalizeSharedKnowledgeReview(review)
  if (!normalizedReview) return { state: 'unreviewed', review: null }
  return {
    state: normalizedReview.reviewedHash === currentHash ? 'current' : 'stale',
    review: normalizedReview,
  }
}

export function normalizeMapSharedKnowledgeReviews(map) {
  if (!map || !Array.isArray(map.nodes)) return map
  return {
    ...map,
    nodes: map.nodes.map((node) => {
      const data = { ...(node.data ?? {}) }
      const sharedKnowledge = typeof data.sharedKnowledge === 'string' ? data.sharedKnowledge : ''
      const review = normalizeSharedKnowledgeReview(data.sharedKnowledgeReview)
      if (sharedKnowledge.trim() && review) data.sharedKnowledgeReview = review
      else delete data.sharedKnowledgeReview
      return { ...node, data }
    }),
  }
}

function reviewRequestEntries(reviewRequests) {
  if (reviewRequests instanceof Map) return [...reviewRequests.entries()]
  if (reviewRequests && typeof reviewRequests === 'object' && !Array.isArray(reviewRequests)) {
    return Object.entries(reviewRequests)
  }
  return []
}

function reviewError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function reconcileSharedKnowledgeReviews(existing, map, {
  reviewRequests = new Map(),
  reviewer = null,
  reviewedAt = null,
} = {}) {
  if (!map || !Array.isArray(map.nodes)) return map
  const requestEntries = reviewRequestEntries(reviewRequests)
  const requests = new Map(requestEntries)
  const existingNodes = new Map((existing?.nodes ?? []).map((node) => [node.id, node]))
  const nodeIds = new Set(map.nodes.map((node) => node.id))

  for (const [nodeId] of requestEntries) {
    if (!nodeIds.has(nodeId)) {
      throw reviewError('SHARED_KNOWLEDGE_REVIEW_CARD', `검토할 공유 지식 카드를 찾을 수 없습니다: ${nodeId}`)
    }
  }

  let normalizedReviewer = null
  let normalizedReviewedAt = null
  if (requests.size > 0) {
    normalizedReviewer = normalizeReviewer(reviewer)
    normalizedReviewedAt = isCanonicalIsoDate(reviewedAt) ? reviewedAt : null
    if (!normalizedReviewer || !normalizedReviewedAt) {
      throw reviewError('SHARED_KNOWLEDGE_REVIEW_ACTOR', '공유 지식 검토자와 검토 시각이 올바르지 않습니다.')
    }
  }

  return {
    ...map,
    nodes: map.nodes.map((node) => {
      const data = { ...(node.data ?? {}) }
      const existingData = existingNodes.get(node.id)?.data
      const sharedKnowledge = typeof data.sharedKnowledge === 'string' ? data.sharedKnowledge : ''
      delete data.sharedKnowledgeReview

      const hasRequest = requests.has(node.id)
      const request = requests.get(node.id)
      if (!sharedKnowledge.trim()) {
        if (hasRequest) {
          throw reviewError('SHARED_KNOWLEDGE_REVIEW_EMPTY', '내용이 없는 공유 지식은 검토 완료로 기록할 수 없습니다.')
        }
        return { ...node, data }
      }

      if (hasRequest) {
        if (data.reference) {
          throw reviewError('SHARED_KNOWLEDGE_REVIEW_REFERENCE', 'Ref 카드는 원본 카드에서 공유 지식을 검토해야 합니다.')
        }
        const reviewResult = typeof request === 'string' ? request : request?.reviewResult
        if (!sharedKnowledgeReviewResults.includes(reviewResult)) {
          throw reviewError('SHARED_KNOWLEDGE_REVIEW_RESULT', '공유 지식 검토 결과가 올바르지 않습니다.')
        }
        data.sharedKnowledgeReview = {
          reviewedAt: normalizedReviewedAt,
          reviewedHash: sharedKnowledgeSha256(sharedKnowledge),
          reviewedBy: normalizedReviewer,
          reviewResult,
        }
        return { ...node, data }
      }

      const existingReview = normalizeSharedKnowledgeReview(existingData?.sharedKnowledgeReview)
      if (existingReview) data.sharedKnowledgeReview = existingReview
      return { ...node, data }
    }),
  }
}
