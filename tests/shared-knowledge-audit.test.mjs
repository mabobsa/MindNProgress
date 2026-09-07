import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeSharedKnowledgeText,
  buildSharedKnowledgeAudit,
  sharedKnowledgeAuditThresholds,
} from '../server/lib/sharedKnowledgeAudit.mjs'
import { sharedKnowledgeSha256 } from '../server/lib/sharedKnowledgeReview.mjs'

test('공유 지식의 구조와 정확히 반복된 문장을 본문 노출 없이 집계한다', () => {
  const text = [
    '# 현재 결론',
    '- 검증된 결론 문장입니다.',
    '- 검증된 결론 문장입니다.',
    '',
    '1. 다른 적용 조건입니다.',
  ].join('\n')
  const result = analyzeSharedKnowledgeText(text)

  assert.equal(result.length, text.length)
  assert.ok(result.utf8Bytes > result.length)
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.paragraphCount, 2)
  assert.equal(result.nonEmptyLineCount, 4)
  assert.equal(result.listItemCount, 3)
  assert.equal(result.exactDuplicateStatementGroupCount, 1)
  assert.equal(result.exactDuplicateStatementCount, 1)
  assert.equal(result.lengthLevel, 'normal')
  assert.equal(result.reviewLevel, 'attention')
  assert.deepEqual(result.reasons, ['exact-duplicate-statements'])
  assert.equal(JSON.stringify(result).includes('검증된 결론'), false)
})

test('글자 수 임계값에 따라 관심·정리 권장·우선 정리 단계를 구분한다', () => {
  const { attentionCharacters, recommendedCharacters, priorityCharacters } = sharedKnowledgeAuditThresholds
  assert.deepEqual(sharedKnowledgeAuditThresholds, {
    attentionCharacters: 5_000,
    recommendedCharacters: 8_000,
    priorityCharacters: 12_000,
    limitCharacters: 15_000,
  })
  assert.equal(analyzeSharedKnowledgeText('가'.repeat(attentionCharacters - 1)).reviewLevel, 'normal')
  assert.equal(analyzeSharedKnowledgeText('가'.repeat(attentionCharacters)).reviewLevel, 'attention')
  assert.equal(analyzeSharedKnowledgeText('가'.repeat(recommendedCharacters)).reviewLevel, 'recommended')
  assert.equal(analyzeSharedKnowledgeText('가'.repeat(priorityCharacters)).reviewLevel, 'priority')
  assert.equal(analyzeSharedKnowledgeText('가'.repeat(priorityCharacters)).limitUsagePercent, 80)
})

test('30일이 지난 장문 유지 승인을 본문 변경 없이 다시 후보로 분류한다', () => {
  const sharedKnowledge = '가'.repeat(5_100)
  const audit = buildSharedKnowledgeAudit([{
    id: 'map-expired-review',
    title: '재검토 문서',
    nodes: [{
      id: 'accepted-long',
      data: {
        label: '장문 유지 카드',
        sharedKnowledge,
        sharedKnowledgeReview: {
          reviewedAt: '2026-07-19T00:00:00.000Z',
          reviewedHash: sharedKnowledgeSha256(sharedKnowledge),
          reviewedBy: { id: 'editor', name: '편집자' },
          reviewResult: 'accepted-long',
        },
      },
    }],
    edges: [],
  }], { generatedAt: '2026-08-18T00:00:00.000Z' })

  assert.equal(audit.summary.acceptedLongReviewDueCount, 1)
  assert.equal(audit.summary.actionableCandidateCount, 1)
  assert.equal(audit.candidates[0].reviewState, 'current')
  assert.equal(audit.candidates[0].reviewDue, true)
  assert.equal(audit.candidates[0].reviewDueAt, '2026-08-18T00:00:00.000Z')
  assert.ok(audit.candidates[0].reasons.includes('accepted-long-review-expired'))
})

test('활성 문서의 공유 지식 카드와 실제 지식선 소비자를 우선순위대로 집계한다', () => {
  const sourceKnowledge = `외부에 노출되면 안 되는 원문\n${'가'.repeat(5_100)}`
  const priorityKnowledge = '나'.repeat(12_100)
  const reviewedKnowledge = '다'.repeat(12_200)
  const staleKnowledge = '라'.repeat(5_200)
  const reviewMetadata = (reviewedHash, reviewResult) => ({
    reviewedAt: '2026-08-17T00:00:00.000Z',
    reviewedHash,
    reviewedBy: { id: 'user-editor', name: '김용민' },
    reviewResult,
  })
  const audit = buildSharedKnowledgeAudit([
    {
      id: 'map-a',
      title: '첫 문서',
      version: 3,
      updatedAt: '2026-08-18T00:00:00.000Z',
      nodes: [
        { id: 'source', data: { label: '공급 카드', kind: 'branch', sharedKnowledge: sourceKnowledge } },
        { id: 'consumer', data: { label: '소비 카드', kind: 'task' } },
        { id: 'reference', data: { label: '참조 카드', sharedKnowledge: priorityKnowledge, reference: { mapId: 'map-b', nodeId: 'root' } } },
        {
          id: 'reviewed',
          data: {
            label: '검토 완료 카드',
            sharedKnowledge: reviewedKnowledge,
            sharedKnowledgeReview: reviewMetadata(sharedKnowledgeSha256(reviewedKnowledge), 'accepted-long'),
          },
        },
        {
          id: 'stale',
          data: {
            label: '검토 후 변경 카드',
            sharedKnowledge: staleKnowledge,
            sharedKnowledgeReview: reviewMetadata(sharedKnowledgeSha256('변경 전 지식'), 'cleaned'),
          },
        },
      ],
      edges: [
        { source: 'source', target: 'consumer', data: { relation: 'knowledge' } },
        { source: 'source', target: 'consumer', data: { relation: 'knowledge' } },
      ],
    },
    {
      id: 'map-b',
      title: '둘째 문서',
      version: 1,
      nodes: [{ id: 'root', data: { label: '짧은 카드', sharedKnowledge: '짧은 지식' } }],
      edges: [],
    },
    {
      id: 'map-trashed',
      title: '휴지통 문서',
      trashedAt: '2026-08-18T00:00:00.000Z',
      nodes: [{ id: 'trashed', data: { sharedKnowledge: priorityKnowledge } }],
      edges: [],
    },
  ], { generatedAt: '2026-08-18T01:00:00.000Z' })

  assert.equal(audit.generatedAt, '2026-08-18T01:00:00.000Z')
  assert.equal(audit.maintenance.periodicIntervalDays, 7)
  assert.equal(audit.maintenance.runOnlyWhenActionableCandidatesExist, true)
  assert.deepEqual(audit.maintenance.reviewOrder, ['priority', 'recommended', 'attention'])
  assert.equal(audit.maintenance.requiresExplicitApproval, true)
  assert.equal(audit.maintenance.automaticMutation, false)
  assert.equal(audit.summary.documentCount, 2)
  assert.equal(audit.summary.cardCount, 6)
  assert.equal(audit.summary.cardsWithSharedKnowledge, 5)
  assert.equal(audit.summary.actionableCandidateCount, 2)
  assert.equal(audit.summary.referenceCardCount, 1)
  assert.deepEqual(audit.summary.reviewStateCounts, { unreviewed: 3, current: 1, stale: 1 })
  assert.deepEqual(audit.candidates.map((card) => card.cardId), ['stale', 'source'])
  assert.equal(audit.candidates[1].consumerCount, 1)
  assert.deepEqual(audit.candidates[1].consumerCardIds, ['consumer'])
  const reviewedCard = audit.documents[0].cards.find((card) => card.cardId === 'reviewed')
  assert.equal(reviewedCard.reviewState, 'current')
  assert.equal(reviewedCard.hasReviewSignals, true)
  assert.equal(reviewedCard.needsReview, false)
  assert.equal(reviewedCard.actionable, false)
  assert.equal(reviewedCard.review.reviewResult, 'accepted-long')
  const staleCard = audit.documents[0].cards.find((card) => card.cardId === 'stale')
  assert.equal(staleCard.reviewState, 'stale')
  assert.equal(staleCard.needsReview, true)
  assert.equal(staleCard.actionable, true)
  assert.equal(audit.documents[0].cards.find((card) => card.cardId === 'reference').maintenanceMode, 'source-card-only')
  assert.equal(audit.documents[0].cards.find((card) => card.cardId === 'reference').actionable, false)
  assert.equal(JSON.stringify(audit).includes('외부에 노출되면 안 되는 원문'), false)
})
