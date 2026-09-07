import {
  acceptedLongReviewMaxAgeDays,
  sharedKnowledgeReviewState,
  sharedKnowledgeReviewDue,
  sharedKnowledgeSha256,
} from './sharedKnowledgeReview.mjs'
import { sharedKnowledgeAuditThresholds } from '../../src/utils/sharedKnowledgePolicy.mjs'

export { sharedKnowledgeAuditThresholds }

export const sharedKnowledgeAuthoringPolicy = Object.freeze({
  writeWhen: '다른 카드나 후속 세션이 다시 사용할 새 사실·결정·제약·검증 결과 또는 적용 조건이 생기거나 기존 내용이 더 이상 유효하지 않을 때만 수정',
  keep: Object.freeze(['현재 유효한 사실', '확정된 결정과 제약', '검증된 결과', '적용·사용 조건', '원문을 확인할 수 있는 출처 링크']),
  exclude: Object.freeze(['시간순 진행 기록', '도구 호출과 원문 로그', '설명·댓글의 단순 복사', '중복 내용', '폐기되거나 대체된 결론']),
  update: '같은 주제의 결론이 바뀌면 새 이력 절을 덧붙이지 말고 기존 절만 해시 조건부로 교체하며, 무관한 유효 정보는 보존',
  history: '진행 과정, 시도와 검증 이력은 댓글에 기록',
})

export const sharedKnowledgeMaintenancePolicy = Object.freeze({
  periodicIntervalDays: 7,
  acceptedLongReviewMaxAgeDays,
  runOnlyWhenActionableCandidatesExist: true,
  eventTriggers: Object.freeze(['주요 마일스톤 완료 후', '다른 사람이나 AI에게 인수인계하기 전']),
  reviewOrder: Object.freeze(['priority', 'recommended', 'attention']),
  requiresExplicitApproval: true,
  automaticMutation: false,
  instruction: '후보가 있으면 주 1회와 주요 마일스톤·인수인계 시점에 점검하고, 우선 정리·정리 권장·관심 순으로 원문과 관계를 확인한 뒤 카드별로 승인. accepted-long은 30일 뒤 다시 검토',
})

const reviewLevelRank = {
  normal: 0,
  attention: 1,
  recommended: 2,
  priority: 3,
}

function nonEmptyLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function exactDuplicateStatementStats(text) {
  const statements = nonEmptyLines(text).flatMap((line) => {
    if (/^(?:#{1,6}\s|```|[-*_]{3,}$)/.test(line)) return []
    const withoutListMarker = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, '')
    return withoutListMarker
      .split(/(?<=[.!?。！？])\s+/u)
      .map((statement) => statement.replace(/\s+/g, ' ').trim())
      .filter((statement) => statement.length >= 8)
  })
  const counts = new Map()
  for (const statement of statements) counts.set(statement, (counts.get(statement) ?? 0) + 1)
  const duplicateGroups = [...counts.values()].filter((count) => count > 1)
  return {
    groupCount: duplicateGroups.length,
    repeatedCount: duplicateGroups.reduce((sum, count) => sum + count - 1, 0),
  }
}

function lengthReviewLevel(length, thresholds) {
  if (length >= thresholds.priorityCharacters) return 'priority'
  if (length >= thresholds.recommendedCharacters) return 'recommended'
  if (length >= thresholds.attentionCharacters) return 'attention'
  return 'normal'
}

export function analyzeSharedKnowledgeText(value, thresholds = sharedKnowledgeAuditThresholds) {
  const text = typeof value === 'string' ? value : ''
  const trimmed = text.trim()
  const lines = trimmed ? nonEmptyLines(text) : []
  const exactDuplicates = exactDuplicateStatementStats(text)
  const lengthLevel = lengthReviewLevel(text.length, thresholds)
  const reviewLevel = lengthLevel === 'normal' && exactDuplicates.repeatedCount > 0 ? 'attention' : lengthLevel
  const reasons = [
    ...(lengthLevel === 'attention' ? ['length-attention'] : []),
    ...(lengthLevel === 'recommended' ? ['length-recommended'] : []),
    ...(lengthLevel === 'priority' ? ['length-priority'] : []),
    ...(exactDuplicates.repeatedCount > 0 ? ['exact-duplicate-statements'] : []),
  ]

  return {
    length: text.length,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sharedKnowledgeSha256(text),
    paragraphCount: trimmed ? text.trim().split(/\r?\n(?:[ \t]*\r?\n)+/).filter((paragraph) => paragraph.trim()).length : 0,
    nonEmptyLineCount: lines.length,
    listItemCount: lines.filter((line) => /^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/.test(line)).length,
    exactDuplicateStatementGroupCount: exactDuplicates.groupCount,
    exactDuplicateStatementCount: exactDuplicates.repeatedCount,
    limitUsagePercent: Math.round((text.length / thresholds.limitCharacters) * 1_000) / 10,
    remainingCharacters: Math.max(0, thresholds.limitCharacters - text.length),
    lengthLevel,
    reviewLevel,
    needsReview: reviewLevel !== 'normal',
    reasons,
  }
}

function auditDocument(map, thresholds, generatedAt) {
  const nodes = Array.isArray(map?.nodes) ? map.nodes : []
  const nodeIds = new Set(nodes.map((node) => node.id))
  const consumersBySource = new Map()
  for (const edge of map?.edges ?? []) {
    if (edge?.data?.relation !== 'knowledge' || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    const consumers = consumersBySource.get(edge.source) ?? new Set()
    consumers.add(edge.target)
    consumersBySource.set(edge.source, consumers)
  }

  const cards = nodes.flatMap((node) => {
    const sharedKnowledge = typeof node.data?.sharedKnowledge === 'string' ? node.data.sharedKnowledge : ''
    if (!sharedKnowledge.trim()) return []
    const analysis = analyzeSharedKnowledgeText(sharedKnowledge, thresholds)
    const reviewStatus = sharedKnowledgeReviewState(
      sharedKnowledge,
      node.data?.sharedKnowledgeReview,
      analysis.sha256,
    )
    const reviewDue = sharedKnowledgeReviewDue(reviewStatus.review, generatedAt)
    const needsReview = analysis.needsReview && (reviewStatus.state !== 'current' || reviewDue.due)
    const isReference = Boolean(node.data?.reference)
    const sharedKnowledgeUpdatedAt = typeof node.data?.sharedKnowledgeUpdatedAt === 'string'
      ? node.data.sharedKnowledgeUpdatedAt
      : null
    return [{
      cardId: node.id,
      label: node.data?.label ?? node.id,
      kind: node.data?.kind ?? 'branch',
      isReference,
      maintenanceMode: isReference ? 'source-card-only' : 'direct',
      ...analysis,
      reasons: reviewDue.due ? [...analysis.reasons, 'accepted-long-review-expired'] : analysis.reasons,
      hasReviewSignals: analysis.needsReview,
      needsReview,
      actionable: needsReview && !isReference,
      reviewState: reviewStatus.state,
      review: reviewStatus.review,
      reviewDue: reviewDue.due,
      reviewDueAt: reviewDue.dueAt,
      consumerCount: consumersBySource.get(node.id)?.size ?? 0,
      consumerCardIds: [...(consumersBySource.get(node.id) ?? [])],
      lastKnownUpdatedAt: sharedKnowledgeUpdatedAt ?? map.updatedAt ?? null,
      lastKnownUpdatedAtSource: sharedKnowledgeUpdatedAt
        ? 'sharedKnowledge'
        : map.updatedAt ? 'document' : 'unavailable',
    }]
  }).sort((first, second) =>
    reviewLevelRank[second.reviewLevel] - reviewLevelRank[first.reviewLevel]
    || second.length - first.length
    || String(first.label).localeCompare(String(second.label), 'ko'))

  return {
    mapId: map.id,
    title: map.title ?? map.id,
    version: map.version ?? 1,
    updatedAt: map.updatedAt ?? null,
    cardCount: nodes.length,
    cardsWithSharedKnowledge: cards.length,
    candidateCount: cards.filter((card) => card.actionable).length,
    cards,
  }
}

export function buildSharedKnowledgeAudit(maps, {
  generatedAt = new Date().toISOString(),
  thresholds = sharedKnowledgeAuditThresholds,
} = {}) {
  const documents = (Array.isArray(maps) ? maps : [])
    .filter((map) => map && !map.trashedAt)
    .map((map) => auditDocument(map, thresholds, generatedAt))
  const cards = documents.flatMap((document) => document.cards.map((card) => ({
    mapId: document.mapId,
    documentTitle: document.title,
    documentVersion: document.version,
    ...card,
  })))
  const candidates = cards.filter((card) => card.actionable).sort((first, second) =>
    reviewLevelRank[second.reviewLevel] - reviewLevelRank[first.reviewLevel]
    || second.length - first.length
    || String(first.documentTitle).localeCompare(String(second.documentTitle), 'ko')
    || String(first.label).localeCompare(String(second.label), 'ko'))

  return {
    generatedAt,
    thresholds,
    maintenance: sharedKnowledgeMaintenancePolicy,
    summary: {
      documentCount: documents.length,
      cardCount: documents.reduce((sum, document) => sum + document.cardCount, 0),
      cardsWithSharedKnowledge: cards.length,
      actionableCandidateCount: candidates.length,
      referenceCardCount: cards.filter((card) => card.isReference).length,
      acceptedLongReviewDueCount: cards.filter((card) => card.reviewDue).length,
      totalCharacters: cards.reduce((sum, card) => sum + card.length, 0),
      reviewLevelCounts: Object.fromEntries(
        Object.keys(reviewLevelRank).map((level) => [level, cards.filter((card) => card.reviewLevel === level).length]),
      ),
      reviewStateCounts: Object.fromEntries(
        ['unreviewed', 'current', 'stale'].map((state) => [
          state,
          cards.filter((card) => card.reviewState === state).length,
        ]),
      ),
    },
    candidates,
    documents,
  }
}
