import { analyzeSharedKnowledgeText } from './sharedKnowledgeAudit.mjs'
import {
  acceptedLongReviewMaxAgeDays,
  sharedKnowledgeReviewResults,
  sharedKnowledgeReviewDue,
  sharedKnowledgeReviewState,
  sharedKnowledgeSha256,
} from './sharedKnowledgeReview.mjs'
import { sharedKnowledgeMaxLength } from '../../src/utils/sharedKnowledgePolicy.mjs'

const maximumBatchSize = 20
const maximumRelatedCardsPerType = 40
const relatedDescriptionPreviewLength = 600

export class SharedKnowledgeMaintenanceError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message)
    this.name = 'SharedKnowledgeMaintenanceError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function fail(code, message, status = 400, details = {}) {
  throw new SharedKnowledgeMaintenanceError(code, message, status, details)
}

function isKnowledgeEdge(edge) {
  return edge?.data?.relation === 'knowledge'
}

function relatedCard(node) {
  const description = typeof node?.data?.description === 'string' ? node.data.description : ''
  const sharedKnowledge = typeof node?.data?.sharedKnowledge === 'string' ? node.data.sharedKnowledge : ''
  const reviewStatus = sharedKnowledgeReviewState(sharedKnowledge, node?.data?.sharedKnowledgeReview)
  return {
    id: node.id,
    label: node.data?.label ?? node.id,
    kind: node.data?.kind ?? 'branch',
    descriptionPreview: description.slice(0, relatedDescriptionPreviewLength),
    descriptionTruncated: description.length > relatedDescriptionPreviewLength,
    sharedKnowledgeLength: sharedKnowledge.length,
    sharedKnowledgeSha256: sharedKnowledgeSha256(sharedKnowledge),
    reviewState: reviewStatus.state,
  }
}

function existingUniqueIds(ids, nodesById) {
  return [...new Set(ids)].filter((id) => nodesById.has(id))
}

function cardsForIds(ids, nodesById) {
  return ids.slice(0, maximumRelatedCardsPerType).flatMap((id) => {
    const node = nodesById.get(id)
    return node ? [relatedCard(node)] : []
  })
}

export function buildSharedKnowledgeReviewContext(map, cardId, { now = new Date() } = {}) {
  if (!map || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) {
    fail('SHARED_KNOWLEDGE_REVIEW_MAP', '공유 지식 검토 문서가 올바르지 않습니다.')
  }
  const card = map.nodes.find((node) => node.id === cardId)
  if (!card) fail('SHARED_KNOWLEDGE_REVIEW_CARD', `공유 지식 카드를 찾을 수 없습니다: ${cardId}`, 404)
  if (card.data?.reference) {
    fail('SHARED_KNOWLEDGE_REVIEW_REFERENCE', 'Ref 카드는 원본 카드에서 공유 지식을 검토해야 합니다.', 409, {
      reference: card.data.reference,
    })
  }

  const sharedKnowledge = typeof card.data?.sharedKnowledge === 'string' ? card.data.sharedKnowledge : ''
  if (!sharedKnowledge.trim()) {
    fail('SHARED_KNOWLEDGE_REVIEW_EMPTY', '검토할 공유 지식이 없습니다.', 409)
  }
  const analysis = analyzeSharedKnowledgeText(sharedKnowledge)
  const reviewStatus = sharedKnowledgeReviewState(
    sharedKnowledge,
    card.data?.sharedKnowledgeReview,
    analysis.sha256,
  )
  const reviewDue = sharedKnowledgeReviewDue(reviewStatus.review, now)
  const needsReview = analysis.needsReview && (reviewStatus.state !== 'current' || reviewDue.due)
  if (!needsReview) {
    const code = reviewStatus.state === 'current'
      ? 'SHARED_KNOWLEDGE_REVIEW_CURRENT'
      : 'SHARED_KNOWLEDGE_REVIEW_NOT_CANDIDATE'
    fail(code, reviewStatus.state === 'current'
      ? '현재 본문은 이미 검토 완료 상태입니다.'
      : '현재 공유 지식은 정리 후보가 아닙니다.', 409, {
      reviewState: reviewStatus.state,
      reviewLevel: analysis.reviewLevel,
    })
  }

  const nodesById = new Map(map.nodes.map((node) => [node.id, node]))
  const hierarchyEdges = map.edges.filter((edge) => !isKnowledgeEdge(edge))
  const knowledgeEdges = map.edges.filter(isKnowledgeEdge)
  const relationIds = {
    parents: existingUniqueIds(hierarchyEdges.filter((edge) => edge.target === cardId).map((edge) => edge.source), nodesById),
    children: existingUniqueIds(hierarchyEdges.filter((edge) => edge.source === cardId).map((edge) => edge.target), nodesById),
    knowledgeSources: existingUniqueIds(knowledgeEdges.filter((edge) => edge.target === cardId).map((edge) => edge.source), nodesById),
    knowledgeConsumers: existingUniqueIds(knowledgeEdges.filter((edge) => edge.source === cardId).map((edge) => edge.target), nodesById),
  }
  return {
    document: {
      id: map.id,
      title: map.title ?? map.id,
      version: map.version ?? 1,
      updatedAt: map.updatedAt ?? null,
    },
    card: {
      id: card.id,
      label: card.data?.label ?? card.id,
      kind: card.data?.kind ?? 'branch',
      description: typeof card.data?.description === 'string' ? card.data.description : '',
      sharedKnowledge,
      sharedKnowledgeUpdatedAt: card.data?.sharedKnowledgeUpdatedAt ?? null,
      sharedKnowledgeUpdatedBy: card.data?.sharedKnowledgeUpdatedBy ?? null,
      textIntegrity: {
        length: analysis.length,
        utf8Bytes: analysis.utf8Bytes,
        sha256: analysis.sha256,
      },
      reviewState: reviewStatus.state,
      review: reviewStatus.review,
      reviewDue: reviewDue.due,
      reviewDueAt: reviewDue.dueAt,
    },
    candidate: {
      reviewLevel: analysis.reviewLevel,
      reasons: reviewDue.due ? [...analysis.reasons, 'accepted-long-review-expired'] : analysis.reasons,
      paragraphCount: analysis.paragraphCount,
      nonEmptyLineCount: analysis.nonEmptyLineCount,
      listItemCount: analysis.listItemCount,
      exactDuplicateStatementGroupCount: analysis.exactDuplicateStatementGroupCount,
      exactDuplicateStatementCount: analysis.exactDuplicateStatementCount,
      limitUsagePercent: analysis.limitUsagePercent,
      remainingCharacters: analysis.remainingCharacters,
    },
    relations: {
      parents: cardsForIds(relationIds.parents, nodesById),
      children: cardsForIds(relationIds.children, nodesById),
      knowledgeSources: cardsForIds(relationIds.knowledgeSources, nodesById),
      knowledgeConsumers: cardsForIds(relationIds.knowledgeConsumers, nodesById),
      totals: Object.fromEntries(Object.entries(relationIds).map(([name, ids]) => [name, ids.length])),
      maxCardsPerType: maximumRelatedCardsPerType,
      truncatedTypes: Object.entries(relationIds)
        .filter(([, ids]) => ids.length > maximumRelatedCardsPerType)
        .map(([name]) => name),
    },
    guidance: {
      keep: '후속 카드나 AI가 다시 사용해야 하는 현재의 확정 사실·결정·제약·검증 결과와 적용 조건만 유지합니다.',
      remove: '시간순 진행 기록, 도구 호출과 원문 로그, 중복·폐기된 결론, description의 요구사항 단순 복사는 제외합니다.',
      preserveMeaning: '근거 없이 내용을 추가하거나 사용자가 작성한 요구사항의 의미를 바꾸지 않습니다.',
      resultChoice: `본문을 실제로 정리하면 cleaned, 길지만 모든 내용이 계속 필요하면 replacement 없이 accepted-long을 사용합니다. accepted-long은 ${acceptedLongReviewMaxAgeDays}일 뒤 다시 검토합니다.`,
    },
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function validatePatchShape(patch, index) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('SHARED_KNOWLEDGE_REVIEW_PATCH', `${index + 1}번째 검토 변경이 올바르지 않습니다.`)
  }
  const cardId = typeof patch.cardId === 'string' ? patch.cardId.trim() : ''
  if (!cardId || cardId.length > 120) {
    fail('SHARED_KNOWLEDGE_REVIEW_CARD', `${index + 1}번째 카드 ID가 올바르지 않습니다.`)
  }
  if (!/^[a-f0-9]{64}$/.test(patch.expectedSha256)) {
    fail('SHARED_KNOWLEDGE_REVIEW_HASH', `${cardId} 카드의 예상 SHA-256이 올바르지 않습니다.`)
  }
  if (!sharedKnowledgeReviewResults.includes(patch.reviewResult)) {
    fail('SHARED_KNOWLEDGE_REVIEW_RESULT', `${cardId} 카드의 검토 결과가 올바르지 않습니다.`)
  }
  const hasReplacement = hasOwn(patch, 'replacement')
  if (patch.reviewResult === 'cleaned' && (!hasReplacement || typeof patch.replacement !== 'string')) {
    fail('SHARED_KNOWLEDGE_REVIEW_REPLACEMENT', `${cardId} 카드를 cleaned로 처리하려면 정리된 replacement가 필요합니다.`)
  }
  if (patch.reviewResult === 'accepted-long' && hasReplacement) {
    fail('SHARED_KNOWLEDGE_REVIEW_REPLACEMENT', `${cardId} 카드를 accepted-long으로 처리할 때는 replacement를 보내지 않습니다.`)
  }
  if (typeof patch.replacement === 'string' && patch.replacement.length > sharedKnowledgeMaxLength) {
    fail('SHARED_KNOWLEDGE_REVIEW_LENGTH', `정리된 sharedKnowledge는 ${sharedKnowledgeMaxLength.toLocaleString('en-US')}자 이하여야 합니다.`, 400, {
      cardId,
      resultLength: patch.replacement.length,
    })
  }
  return { ...patch, cardId }
}

export function prepareSharedKnowledgeReviewBatch(map, patches, { now = new Date() } = {}) {
  if (!map || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) {
    fail('SHARED_KNOWLEDGE_REVIEW_MAP', '공유 지식 검토 문서가 올바르지 않습니다.')
  }
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > maximumBatchSize) {
    fail('SHARED_KNOWLEDGE_REVIEW_BATCH_SIZE', `한 번에 검토할 카드는 1~${maximumBatchSize}개여야 합니다.`)
  }

  const normalizedPatches = patches.map(validatePatchShape)
  const uniqueCardIds = new Set(normalizedPatches.map((patch) => patch.cardId))
  if (uniqueCardIds.size !== normalizedPatches.length) {
    fail('SHARED_KNOWLEDGE_REVIEW_DUPLICATE_CARD', '한 번의 요청에서 같은 카드를 두 번 변경할 수 없습니다.')
  }

  const nodesById = new Map(map.nodes.map((node) => [node.id, node]))
  const prepared = normalizedPatches.map((patch) => {
    const node = nodesById.get(patch.cardId)
    if (!node) fail('SHARED_KNOWLEDGE_REVIEW_CARD', `공유 지식 카드를 찾을 수 없습니다: ${patch.cardId}`, 404)
    if (node.data?.reference) {
      fail('SHARED_KNOWLEDGE_REVIEW_REFERENCE', 'Ref 카드는 원본 카드에서 공유 지식을 검토해야 합니다.', 409, {
        cardId: patch.cardId,
        reference: node.data.reference,
      })
    }
    const currentText = typeof node.data?.sharedKnowledge === 'string' ? node.data.sharedKnowledge : ''
    if (!currentText.trim()) {
      fail('SHARED_KNOWLEDGE_REVIEW_EMPTY', '내용이 없는 공유 지식은 검토할 수 없습니다.', 409, { cardId: patch.cardId })
    }
    const currentAnalysis = analyzeSharedKnowledgeText(currentText)
    if (currentAnalysis.sha256 !== patch.expectedSha256) {
      fail('SHARED_KNOWLEDGE_REVIEW_HASH_MISMATCH', '공유 지식이 조회 이후 변경되었습니다. 최신 검토 문맥을 다시 조회해 주세요.', 409, {
        cardId: patch.cardId,
        currentSha256: currentAnalysis.sha256,
        currentLength: currentAnalysis.length,
      })
    }
    const reviewStatus = sharedKnowledgeReviewState(
      currentText,
      node.data?.sharedKnowledgeReview,
      currentAnalysis.sha256,
    )
    const reviewDue = sharedKnowledgeReviewDue(reviewStatus.review, now)
    if (reviewStatus.state === 'current' && !reviewDue.due) {
      fail('SHARED_KNOWLEDGE_REVIEW_CURRENT', '현재 본문은 이미 검토 완료 상태입니다.', 409, { cardId: patch.cardId })
    }
    if (!currentAnalysis.needsReview) {
      fail('SHARED_KNOWLEDGE_REVIEW_NOT_CANDIDATE', '현재 공유 지식은 정리 후보가 아닙니다.', 409, {
        cardId: patch.cardId,
        reviewLevel: currentAnalysis.reviewLevel,
      })
    }

    const replacement = patch.reviewResult === 'cleaned' && !patch.replacement.trim() ? '' : patch.replacement
    const nextText = patch.reviewResult === 'cleaned' ? replacement : currentText
    if (nextText === currentText && patch.reviewResult === 'cleaned') {
      fail('SHARED_KNOWLEDGE_REVIEW_NO_CHANGE', 'cleaned 결과는 현재 본문과 다른 정리 결과가 필요합니다.', 409, {
        cardId: patch.cardId,
      })
    }
    return {
      cardId: patch.cardId,
      label: node.data?.label ?? patch.cardId,
      reviewResult: patch.reviewResult,
      before: {
        length: currentAnalysis.length,
        utf8Bytes: currentAnalysis.utf8Bytes,
        sha256: currentAnalysis.sha256,
      },
      nextText,
      after: {
        length: nextText.length,
        utf8Bytes: Buffer.byteLength(nextText, 'utf8'),
        sha256: sharedKnowledgeSha256(nextText),
      },
      cleared: !nextText.trim(),
    }
  })

  const preparedByCardId = new Map(prepared.map((change) => [change.cardId, change]))
  const reviewRequests = new Map(prepared
    .filter((change) => !change.cleared)
    .map((change) => [change.cardId, { reviewResult: change.reviewResult }]))
  return {
    map: {
      ...map,
      nodes: map.nodes.map((node) => {
        const change = preparedByCardId.get(node.id)
        return change
          ? { ...node, data: { ...node.data, sharedKnowledge: change.nextText } }
          : node
      }),
    },
    reviewRequests,
    changes: prepared.map((change) => ({
      cardId: change.cardId,
      label: change.label,
      reviewResult: change.reviewResult,
      before: change.before,
      after: change.after,
      cleared: change.cleared,
    })),
  }
}

export function verifySharedKnowledgeReviewChanges(map, changes) {
  if (!map || !Array.isArray(map.nodes) || !Array.isArray(changes)) {
    fail('SHARED_KNOWLEDGE_REVIEW_STORAGE_MISMATCH', '저장 전 공유 지식 검증 데이터가 올바르지 않습니다.', 500)
  }
  return changes.map((change) => {
    const card = map.nodes.find((node) => node.id === change.cardId)
    const sharedKnowledge = typeof card?.data?.sharedKnowledge === 'string' ? card.data.sharedKnowledge : ''
    const storedSha256 = sharedKnowledgeSha256(sharedKnowledge)
    if (!card || storedSha256 !== change.after?.sha256) {
      fail('SHARED_KNOWLEDGE_REVIEW_STORAGE_MISMATCH', `저장 전 공유 지식 해시 검증에 실패했습니다: ${change.cardId}`, 500, {
        cardId: change.cardId,
        expectedSha256: change.after?.sha256 ?? null,
        actualSha256: card ? storedSha256 : null,
      })
    }
    const reviewStatus = sharedKnowledgeReviewState(sharedKnowledge, card.data?.sharedKnowledgeReview, storedSha256)
    const expectedReviewState = change.cleared ? 'not-applicable' : 'current'
    const storedReviewResult = reviewStatus.review?.reviewResult ?? null
    if (reviewStatus.state !== expectedReviewState
      || (!change.cleared && storedReviewResult !== change.reviewResult)) {
      fail('SHARED_KNOWLEDGE_REVIEW_STORAGE_MISMATCH', `저장 전 공유 지식 검토 상태 검증에 실패했습니다: ${change.cardId}`, 500, {
        cardId: change.cardId,
        expectedReviewState,
        actualReviewState: reviewStatus.state,
        expectedReviewResult: change.cleared ? null : change.reviewResult,
        actualReviewResult: storedReviewResult,
      })
    }
    return {
      ...change,
      reviewState: reviewStatus.state,
      review: reviewStatus.review,
    }
  })
}
