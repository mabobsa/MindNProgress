import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSharedKnowledgeReviewContext,
  prepareSharedKnowledgeReviewBatch,
  verifySharedKnowledgeReviewChanges,
} from '../server/lib/sharedKnowledgeMaintenance.mjs'
import {
  reconcileSharedKnowledgeReviews,
  sharedKnowledgeSha256,
} from '../server/lib/sharedKnowledgeReview.mjs'

function candidateText(character = '가', length = 8_100) {
  return character.repeat(length)
}

function testMap() {
  const firstText = candidateText('가')
  const secondText = candidateText('나', 12_100)
  return {
    id: 'map-review',
    title: '공유 지식 검토',
    version: 7,
    updatedAt: '2026-08-18T00:00:00.000Z',
    nodes: [
      {
        id: 'parent',
        data: { label: '상위 카드', kind: 'branch', description: '상위 범위' },
      },
      {
        id: 'first',
        data: {
          label: '첫 후보',
          kind: 'branch',
          description: '첫 후보가 보존해야 하는 목적과 범위',
          sharedKnowledge: firstText,
        },
      },
      {
        id: 'second',
        data: {
          label: '둘째 후보',
          kind: 'branch',
          description: '둘째 후보 설명',
          sharedKnowledge: secondText,
        },
      },
      {
        id: 'consumer',
        data: { label: '소비 카드', kind: 'task', description: '첫 후보 지식을 이용하는 작업' },
      },
    ],
    edges: [
      { source: 'parent', target: 'first', data: { relation: 'hierarchy' } },
      { source: 'first', target: 'second', data: { relation: 'hierarchy' } },
      { source: 'first', target: 'consumer', data: { relation: 'knowledge' } },
    ],
  }
}

test('검토 문맥은 선택한 후보 원문과 직접 관계만 명시적으로 반환한다', () => {
  const map = testMap()
  const context = buildSharedKnowledgeReviewContext(map, 'first')

  assert.equal(context.document.version, 7)
  assert.equal(context.card.sharedKnowledge, map.nodes[1].data.sharedKnowledge)
  assert.equal(context.card.textIntegrity.sha256, sharedKnowledgeSha256(map.nodes[1].data.sharedKnowledge))
  assert.equal(context.candidate.reviewLevel, 'recommended')
  assert.deepEqual(context.relations.parents.map((card) => card.id), ['parent'])
  assert.deepEqual(context.relations.children.map((card) => card.id), ['second'])
  assert.deepEqual(context.relations.knowledgeConsumers.map((card) => card.id), ['consumer'])
  assert.deepEqual(context.relations.totals, {
    parents: 1,
    children: 1,
    knowledgeSources: 0,
    knowledgeConsumers: 1,
  })
  assert.deepEqual(context.relations.truncatedTypes, [])
  assert.equal(context.relations.children[0].sharedKnowledgeLength, 12_100)
  assert.equal(context.relations.children[0].descriptionPreview, '둘째 후보 설명')
  assert.equal(Object.hasOwn(context.relations.children[0], 'sharedKnowledge'), false)
})

test('복수 카드의 cleaned와 accepted-long 결과를 한 문서 변경으로 준비한다', () => {
  const map = testMap()
  const before = structuredClone(map)
  const firstText = map.nodes[1].data.sharedKnowledge
  const secondText = map.nodes[2].data.sharedKnowledge
  const prepared = prepareSharedKnowledgeReviewBatch(map, [
    {
      cardId: 'first',
      expectedSha256: sharedKnowledgeSha256(firstText),
      reviewResult: 'cleaned',
      replacement: '재사용할 확정 결론만 유지',
    },
    {
      cardId: 'second',
      expectedSha256: sharedKnowledgeSha256(secondText),
      reviewResult: 'accepted-long',
    },
  ])

  assert.deepEqual(map, before, '준비 과정이 입력 문서를 변경했습니다.')
  assert.equal(prepared.map.nodes.find((node) => node.id === 'first').data.sharedKnowledge, '재사용할 확정 결론만 유지')
  assert.equal(prepared.map.nodes.find((node) => node.id === 'second').data.sharedKnowledge, secondText)
  assert.deepEqual([...prepared.reviewRequests], [
    ['first', { reviewResult: 'cleaned' }],
    ['second', { reviewResult: 'accepted-long' }],
  ])
  assert.equal(prepared.changes[0].before.sha256, sharedKnowledgeSha256(firstText))
  assert.equal(prepared.changes[0].after.sha256, sharedKnowledgeSha256('재사용할 확정 결론만 유지'))
  assert.equal(Object.hasOwn(prepared.changes[0], 'nextText'), false)
})

test('정규화된 최종 payload를 파일 저장 전에 해시와 검토 상태로 검증한다', () => {
  const map = testMap()
  const firstText = map.nodes[1].data.sharedKnowledge
  const prepared = prepareSharedKnowledgeReviewBatch(map, [{
    cardId: 'first',
    expectedSha256: sharedKnowledgeSha256(firstText),
    reviewResult: 'cleaned',
    replacement: '재사용할 확정 결론만 유지',
  }])
  const payload = reconcileSharedKnowledgeReviews(map, prepared.map, {
    reviewRequests: prepared.reviewRequests,
    reviewer: { id: 'editor', name: '편집자' },
    reviewedAt: '2026-08-19T00:00:00.000Z',
  })

  const verified = verifySharedKnowledgeReviewChanges(payload, prepared.changes)
  assert.equal(verified[0].reviewState, 'current')
  assert.equal(verified[0].review.reviewResult, 'cleaned')

  const changedText = structuredClone(payload)
  changedText.nodes.find((node) => node.id === 'first').data.sharedKnowledge += '변조'
  assert.throws(() => verifySharedKnowledgeReviewChanges(changedText, prepared.changes), {
    code: 'SHARED_KNOWLEDGE_REVIEW_STORAGE_MISMATCH',
  })

  const missingReview = structuredClone(payload)
  delete missingReview.nodes.find((node) => node.id === 'first').data.sharedKnowledgeReview
  assert.throws(() => verifySharedKnowledgeReviewChanges(missingReview, prepared.changes), {
    code: 'SHARED_KNOWLEDGE_REVIEW_STORAGE_MISMATCH',
  })

  const cleared = prepareSharedKnowledgeReviewBatch(map, [{
    cardId: 'first',
    expectedSha256: sharedKnowledgeSha256(firstText),
    reviewResult: 'cleaned',
    replacement: '',
  }])
  const clearedPayload = reconcileSharedKnowledgeReviews(map, cleared.map, {
    reviewRequests: cleared.reviewRequests,
    reviewer: { id: 'editor', name: '편집자' },
    reviewedAt: '2026-08-19T00:00:00.000Z',
  })
  assert.equal(verifySharedKnowledgeReviewChanges(clearedPayload, cleared.changes)[0].reviewState, 'not-applicable')
})

test('공유 지식을 비우는 정리는 검토 기록 없이 후보 자체를 제거한다', () => {
  const map = testMap()
  const currentText = map.nodes[1].data.sharedKnowledge
  const prepared = prepareSharedKnowledgeReviewBatch(map, [{
    cardId: 'first',
    expectedSha256: sharedKnowledgeSha256(currentText),
    reviewResult: 'cleaned',
    replacement: '',
  }])

  assert.equal(prepared.map.nodes.find((node) => node.id === 'first').data.sharedKnowledge, '')
  assert.equal(prepared.reviewRequests.size, 0)
  assert.equal(prepared.changes[0].cleared, true)
})

test('하나의 해시가 달라도 일괄 변경 전체를 준비하지 않는다', () => {
  const map = testMap()
  const before = structuredClone(map)
  assert.throws(() => prepareSharedKnowledgeReviewBatch(map, [
    {
      cardId: 'first',
      expectedSha256: sharedKnowledgeSha256(map.nodes[1].data.sharedKnowledge),
      reviewResult: 'cleaned',
      replacement: '정리 결과',
    },
    {
      cardId: 'second',
      expectedSha256: '0'.repeat(64),
      reviewResult: 'accepted-long',
    },
  ]), { code: 'SHARED_KNOWLEDGE_REVIEW_HASH_MISMATCH' })
  assert.deepEqual(map, before)
})

test('중복 카드, Ref, 이미 검토한 카드와 결과별 잘못된 replacement를 거부한다', () => {
  const map = testMap()
  const firstText = map.nodes[1].data.sharedKnowledge
  const firstHash = sharedKnowledgeSha256(firstText)
  assert.throws(() => prepareSharedKnowledgeReviewBatch(map, [
    { cardId: 'first', expectedSha256: firstHash, reviewResult: 'accepted-long' },
    { cardId: 'first', expectedSha256: firstHash, reviewResult: 'accepted-long' },
  ]), { code: 'SHARED_KNOWLEDGE_REVIEW_DUPLICATE_CARD' })

  const referenceMap = testMap()
  referenceMap.nodes[1].data.reference = { mapId: 'map-source', nodeId: 'source' }
  assert.throws(() => buildSharedKnowledgeReviewContext(referenceMap, 'first'), {
    code: 'SHARED_KNOWLEDGE_REVIEW_REFERENCE',
  })

  const reviewedMap = testMap()
  reviewedMap.nodes[1].data.sharedKnowledgeReview = {
    reviewedAt: '2026-08-18T00:00:00.000Z',
    reviewedHash: firstHash,
    reviewedBy: { id: 'editor', name: '편집자' },
    reviewResult: 'accepted-long',
  }
  assert.throws(() => prepareSharedKnowledgeReviewBatch(reviewedMap, [{
    cardId: 'first', expectedSha256: firstHash, reviewResult: 'accepted-long',
  }], { now: '2026-08-19T00:00:00.000Z' }), { code: 'SHARED_KNOWLEDGE_REVIEW_CURRENT' })

  const expiredContext = buildSharedKnowledgeReviewContext(reviewedMap, 'first', {
    now: '2026-09-17T00:00:00.000Z',
  })
  assert.equal(expiredContext.card.reviewDue, true)
  assert.ok(expiredContext.candidate.reasons.includes('accepted-long-review-expired'))
  const renewed = prepareSharedKnowledgeReviewBatch(reviewedMap, [{
    cardId: 'first', expectedSha256: firstHash, reviewResult: 'accepted-long',
  }], { now: '2026-09-17T00:00:00.000Z' })
  assert.deepEqual([...renewed.reviewRequests], [['first', { reviewResult: 'accepted-long' }]])

  assert.throws(() => prepareSharedKnowledgeReviewBatch(map, [{
    cardId: 'first', expectedSha256: firstHash, reviewResult: 'cleaned',
  }]), { code: 'SHARED_KNOWLEDGE_REVIEW_REPLACEMENT' })
  assert.throws(() => prepareSharedKnowledgeReviewBatch(map, [{
    cardId: 'first', expectedSha256: firstHash, reviewResult: 'accepted-long', replacement: '보내면 안 됨',
  }]), { code: 'SHARED_KNOWLEDGE_REVIEW_REPLACEMENT' })
})
