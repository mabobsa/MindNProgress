import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isValidSharedKnowledgeReview,
  normalizeMapSharedKnowledgeReviews,
  normalizeSharedKnowledgeReview,
  reconcileSharedKnowledgeReviews,
  sharedKnowledgeReviewState,
  sharedKnowledgeSha256,
} from '../server/lib/sharedKnowledgeReview.mjs'

const reviewedAt = '2026-08-18T01:02:03.000Z'
const reviewedBy = { id: 'user-editor', name: '김용민' }

function reviewFor(text, reviewResult = 'cleaned') {
  return {
    reviewedAt,
    reviewedHash: sharedKnowledgeSha256(text),
    reviewedBy,
    reviewResult,
  }
}

test('공유 지식 검토 메타데이터를 정규화하고 엄격하게 검증한다', () => {
  const valid = reviewFor('검토한 지식', 'accepted-long')
  assert.deepEqual(normalizeSharedKnowledgeReview(valid), valid)
  assert.equal(isValidSharedKnowledgeReview(valid), true)
  assert.equal(isValidSharedKnowledgeReview({ ...valid, reviewedAt: '2026-08-18' }), false)
  assert.equal(isValidSharedKnowledgeReview({ ...valid, reviewedHash: valid.reviewedHash.toUpperCase() }), false)
  assert.equal(isValidSharedKnowledgeReview({ ...valid, reviewResult: 'approved' }), false)
  assert.equal(isValidSharedKnowledgeReview({ ...valid, reviewedBy: { id: '', name: '김용민' } }), false)
})

test('현재 공유 지식 해시와 검토 해시를 비교해 검토 상태를 판정한다', () => {
  const text = '확정된 공유 지식'
  const review = reviewFor(text)
  assert.equal(sharedKnowledgeReviewState('', review).state, 'not-applicable')
  assert.equal(sharedKnowledgeReviewState(text, null).state, 'unreviewed')
  assert.equal(sharedKnowledgeReviewState(text, review).state, 'current')
  assert.equal(sharedKnowledgeReviewState(`${text} 변경`, review).state, 'stale')
})

test('장문 유지 승인은 기간과 무관하게 본문이 바뀔 때까지 유지된다', () => {
  const text = '장문 공유 지식'
  const review = reviewFor(text, 'accepted-long')
  assert.equal(sharedKnowledgeReviewState(text, review).state, 'current')
  assert.equal(sharedKnowledgeReviewState(`${text} 변경`, review).state, 'stale')
})

test('일반 저장은 검토 메타데이터를 위조하지 못하고 기존 기록만 보존한다', () => {
  const originalText = '기존 공유 지식'
  const existingReview = reviewFor(originalText)
  const existing = {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: originalText, sharedKnowledgeReview: existingReview } }],
  }
  const forged = reviewFor('위조된 지식', 'accepted-long')
  const incoming = {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: `${originalText} 변경`, sharedKnowledgeReview: forged } }],
  }

  const reconciled = reconcileSharedKnowledgeReviews(existing, incoming)
  assert.deepEqual(reconciled.nodes[0].data.sharedKnowledgeReview, existingReview)
  assert.equal(sharedKnowledgeReviewState(
    reconciled.nodes[0].data.sharedKnowledge,
    reconciled.nodes[0].data.sharedKnowledgeReview,
  ).state, 'stale')

  const noExistingReview = reconcileSharedKnowledgeReviews(null, incoming)
  assert.equal(noExistingReview.nodes[0].data.sharedKnowledgeReview, undefined)

  const emptied = reconcileSharedKnowledgeReviews(existing, {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: '', sharedKnowledgeReview: existingReview } }],
  })
  assert.equal(emptied.nodes[0].data.sharedKnowledgeReview, undefined)
})

test('저장 데이터 정규화는 유효하고 내용이 있는 검토 기록만 유지한다', () => {
  const text = '공유 지식'
  const normalized = normalizeMapSharedKnowledgeReviews({
    nodes: [
      { id: 'valid', data: { sharedKnowledge: text, sharedKnowledgeReview: reviewFor(text) } },
      { id: 'invalid', data: { sharedKnowledge: text, sharedKnowledgeReview: { reviewedAt } } },
      { id: 'empty', data: { sharedKnowledge: ' ', sharedKnowledgeReview: reviewFor(' ') } },
    ],
  })

  assert.deepEqual(normalized.nodes[0].data.sharedKnowledgeReview, reviewFor(text))
  assert.equal(normalized.nodes[1].data.sharedKnowledgeReview, undefined)
  assert.equal(normalized.nodes[2].data.sharedKnowledgeReview, undefined)
})

test('전용 검토 요청만 서버가 검토자·시각·현재 해시를 기록한다', () => {
  const text = '정리한 공유 지식'
  const map = {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: text } }],
  }
  const reconciled = reconcileSharedKnowledgeReviews(null, map, {
    reviewRequests: new Map([['card-a', { reviewResult: 'cleaned' }]]),
    reviewer: reviewedBy,
    reviewedAt,
  })

  assert.deepEqual(reconciled.nodes[0].data.sharedKnowledgeReview, reviewFor(text))
})

test('잘못된 검토 요청은 명확한 오류 코드로 거부한다', () => {
  const actor = { reviewer: reviewedBy, reviewedAt }
  assert.throws(() => reconcileSharedKnowledgeReviews(null, {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: '지식' } }],
  }, {
    reviewRequests: new Map([['card-a', { reviewResult: 'invalid' }]]),
    ...actor,
  }), { code: 'SHARED_KNOWLEDGE_REVIEW_RESULT' })

  assert.throws(() => reconcileSharedKnowledgeReviews(null, {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: '지식', reference: { mapId: 'map-b', nodeId: 'source' } } }],
  }, {
    reviewRequests: new Map([['card-a', { reviewResult: 'cleaned' }]]),
    ...actor,
  }), { code: 'SHARED_KNOWLEDGE_REVIEW_REFERENCE' })

  assert.throws(() => reconcileSharedKnowledgeReviews(null, {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: '' } }],
  }, {
    reviewRequests: new Map([['card-a', { reviewResult: 'cleaned' }]]),
    ...actor,
  }), { code: 'SHARED_KNOWLEDGE_REVIEW_EMPTY' })

  assert.throws(() => reconcileSharedKnowledgeReviews(null, {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: '지식' } }],
  }, {
    reviewRequests: new Map([['missing', { reviewResult: 'cleaned' }]]),
    ...actor,
  }), { code: 'SHARED_KNOWLEDGE_REVIEW_CARD' })

  assert.throws(() => reconcileSharedKnowledgeReviews(null, {
    nodes: [{ id: 'card-a', data: { sharedKnowledge: '지식' } }],
  }, {
    reviewRequests: new Map([['card-a', { reviewResult: 'cleaned' }]]),
    reviewer: null,
    reviewedAt,
  }), { code: 'SHARED_KNOWLEDGE_REVIEW_ACTOR' })
})
