import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_EDITOR_REQUEST_MAX_LENGTH,
  aiConversationTitle,
  buildAiConversationPrompt,
  combineAiEditorRequest,
  buildSharedKnowledgeCleanupLaunch,
  buildSharedKnowledgeCleanupRequest,
  DEFAULT_AI_EDITOR_REQUEST,
  isAiConversationPurpose,
  normalizeAiCardTitle,
  normalizeAiEditorRequest,
  resolveAiConversationTarget,
} from '../src/utils/aiConversationLaunch.mjs'

const selection = {
  open: true,
  mapId: 'map-current',
  cardId: 'node-selected',
  cardLabel: '선택한 카드 (ref)',
  cardKind: 'task',
  isReference: false,
  documentTitle: '현재 문서',
  knowledgeSources: [{ id: 'node-source', label: '선행 지식', policy: 'reuse-first' }],
}

const reviewContext = {
  document: { id: 'map-other', title: '다른 문서' },
  card: { id: 'node-candidate', label: '정리 후보 카드', textIntegrity: { length: 8_432 } },
  candidate: { reviewLevel: 'recommended', limitUsagePercent: 56.2, exactDuplicateStatementCount: 3 },
  relations: { totals: { knowledgeConsumers: 2 } },
}

test('선택 카드가 없어도 바로 지정한 카드로 대화 대상을 만든다', () => {
  const target = resolveAiConversationTarget({
    explicitTarget: { mapId: 'map-other', cardId: 'node-candidate', cardTitle: '정리 후보 카드', documentTitle: '다른 문서', initialRequest: '정리안을 제안해 주세요.' },
    selection: null,
  })
  assert.deepEqual(target, {
    source: 'explicit',
    purpose: 'card',
    mapId: 'map-other',
    cardId: 'node-candidate',
    cardTitle: '정리 후보 카드',
    documentTitle: '다른 문서',
    knowledgeSources: [],
    initialRequest: '정리안을 제안해 주세요.',
  })
})

test('바로 지정한 카드는 선택 카드보다 우선한다', () => {
  const target = resolveAiConversationTarget({
    explicitTarget: { mapId: 'map-other', cardId: 'node-candidate' },
    selection,
  })
  assert.equal(target.mapId, 'map-other')
  assert.equal(target.cardId, 'node-candidate')
  assert.equal(target.cardTitle, 'node-candidate')
  assert.deepEqual(target.knowledgeSources, [])
  assert.equal(target.initialRequest, undefined)
})

test('선택 카드 경로는 기존 대상 계산을 유지한다', () => {
  const target = resolveAiConversationTarget({ explicitTarget: null, selection })
  assert.deepEqual(target, {
    source: 'selection',
    purpose: 'card',
    mapId: 'map-current',
    cardId: 'node-selected',
    cardTitle: '선택한 카드',
    documentTitle: '현재 문서',
    knowledgeSources: selection.knowledgeSources,
  })
})

test('Ref 카드는 선행 지식 목록을 넘기지 않는다', () => {
  const target = resolveAiConversationTarget({ selection: { ...selection, isReference: true } })
  assert.deepEqual(target.knowledgeSources, [])
})

test('열려 있지 않거나 대상이 없으면 대화를 시작하지 않는다', () => {
  assert.equal(resolveAiConversationTarget({ selection: { ...selection, open: false } }), null)
  assert.equal(resolveAiConversationTarget({ selection: { ...selection, cardKind: 'image' } }), null)
  assert.equal(resolveAiConversationTarget({ selection: { ...selection, documentTitle: null } }), null)
  assert.equal(resolveAiConversationTarget({ selection: { ...selection, mapId: '' } }), null)
  assert.equal(resolveAiConversationTarget({ explicitTarget: { mapId: 'map-other' } }), null)
  assert.equal(resolveAiConversationTarget({}), null)
  assert.equal(resolveAiConversationTarget(), null)
})

test('카드 제목의 ref 접미사만 정리한다', () => {
  assert.equal(normalizeAiCardTitle('카드 이름 (ref)'), '카드 이름')
  assert.equal(normalizeAiCardTitle('카드 (REF) '), '카드')
  assert.equal(normalizeAiCardTitle('참조(reference) 카드'), '참조(reference) 카드')
  assert.equal(normalizeAiCardTitle(undefined), '')
})

test('대화 용도에 따라 제목을 만들고 접두사를 보존한 채 120자로 제한한다', () => {
  assert.equal(aiConversationTitle({ documentTitle: '문서', cardTitle: '카드' }), '문서: 카드')
  assert.equal(aiConversationTitle({
    purpose: 'shared-knowledge-review',
    documentTitle: '문서\n제목',
    cardTitle: '카드   제목',
  }), '[지식정리] 문서 제목: 카드 제목')
  const longTitle = aiConversationTitle({
    purpose: 'shared-knowledge-review',
    documentTitle: '문서',
    cardTitle: '카드'.repeat(100),
  })
  assert.equal(longTitle.length, 120)
  assert.ok(longTitle.startsWith('[지식정리] '))
  assert.equal(isAiConversationPurpose('card'), true)
  assert.equal(isAiConversationPurpose('shared-knowledge-review'), true)
  assert.equal(isAiConversationPurpose('unknown'), false)
})

test('전문은 대상 식별자와 편집자 요청을 그대로 담는다', () => {
  const prompt = buildAiConversationPrompt({
    mapId: 'map-other',
    cardId: 'node-candidate',
    editorId: 'user-editor',
    attributionToken: 'token-1',
    request: '  정리안을 제안해 주세요.  ',
  })
  assert.match(prompt, /^# MindNProgress 작업 요청/)
  assert.ok(prompt.includes('- mapId: `map-other`'))
  assert.ok(prompt.includes('- cardId: `node-candidate`'))
  assert.ok(prompt.includes('- editorId: `user-editor`'))
  assert.ok(prompt.includes('- attributionToken: `token-1`'))
  assert.ok(prompt.includes('mindnprogress_get_context'))
  assert.ok(prompt.includes('한 번 성공적으로 호출'))
  assert.ok(prompt.includes('응답을 받지 못한 시도는 호출 횟수에 포함하지 말고'))
  assert.ok(prompt.endsWith('# 편집자 요청\n\n정리안을 제안해 주세요.'))
})

test('자동 적용 내용 뒤에 사용자 입력을 붙여 기존 편집자 요청 형식을 유지한다', () => {
  assert.equal(
    combineAiEditorRequest('  자동 적용 내용  ', '  추가 정보 또는 요청  '),
    '자동 적용 내용\n\n추가 정보 또는 요청',
  )
  assert.equal(combineAiEditorRequest('자동 적용 내용', '   '), '자동 적용 내용')
  assert.equal(combineAiEditorRequest('', '사용자 요청'), '사용자 요청')
})

test('전문 조립에 필요한 값이 없으면 실패로 알린다', () => {
  assert.throws(() => buildAiConversationPrompt({ mapId: 'map-other', cardId: 'node-candidate', editorId: 'user-editor', attributionToken: 'token-1', request: '   ' }), /정보가 부족/)
  assert.throws(() => buildAiConversationPrompt({ cardId: 'node-candidate', editorId: 'user-editor', attributionToken: 'token-1', request: '요청' }), /정보가 부족/)
})

test('정리 제안 전문은 자동 저장을 금지하고 검토 문맥 조회를 지시한다', () => {
  const request = buildSharedKnowledgeCleanupRequest(reviewContext)
  assert.ok(request.includes('mindnprogress_get_shared_knowledge_review_context'))
  assert.ok(request.includes('`mindnprogress_apply_shared_knowledge_review`를 호출하지 마세요.'))
  assert.ok(request.includes('공유 지식을 직접 고치지 마세요'))
  assert.ok(request.includes('지식선으로 소비하는 카드가 재사용하는 내용은 지우지 마세요'))
  assert.ok(request.includes('- 공유 지식 8,432자 (15,000자 제한의 56.2%) · 검토 수준 정리 권장'))
  assert.ok(request.includes('완전히 같은 문장 반복 3건 · 이 공유 지식을 지식선으로 쓰는 카드 2개'))
  assert.ok(request.length <= AI_EDITOR_REQUEST_MAX_LENGTH)
})

test('제한 사용률이 소수여도 버리지 않고 그대로 알린다', () => {
  const request = buildSharedKnowledgeCleanupRequest({
    ...reviewContext,
    card: { ...reviewContext.card, textIntegrity: { length: 6_040 } },
    candidate: { reviewLevel: 'attention', limitUsagePercent: 40.3, exactDuplicateStatementCount: 0 },
  })
  assert.ok(request.includes('- 공유 지식 6,040자 (15,000자 제한의 40.3%) · 검토 수준 확인 필요'))
})

test('지표가 없어도 정리 제안 전문을 만든다', () => {
  const request = buildSharedKnowledgeCleanupRequest({})
  assert.ok(!request.includes('- 공유 지식 '))
  assert.ok(request.includes('완전히 같은 문장 반복 0건 · 이 공유 지식을 지식선으로 쓰는 카드 0개'))
  assert.ok(request.includes('mindnprogress_get_shared_knowledge_review_context'))
})

test('검토 문맥에서 정리 제안 대상과 전문을 함께 만든다', () => {
  const launch = buildSharedKnowledgeCleanupLaunch(reviewContext)
  assert.equal(launch.purpose, 'shared-knowledge-review')
  assert.equal(launch.mapId, 'map-other')
  assert.equal(launch.cardId, 'node-candidate')
  assert.equal(launch.cardTitle, '정리 후보 카드')
  assert.equal(launch.documentTitle, '다른 문서')
  assert.equal(launch.initialRequest, buildSharedKnowledgeCleanupRequest(reviewContext))

  const target = resolveAiConversationTarget({ explicitTarget: launch, selection })
  assert.equal(target.mapId, 'map-other')
  assert.equal(target.cardId, 'node-candidate')
  assert.equal(target.purpose, 'shared-knowledge-review')
  assert.equal(target.initialRequest, launch.initialRequest)
})

test('검토 문맥에 문서나 카드 식별자가 없으면 대상을 만들지 않는다', () => {
  assert.equal(buildSharedKnowledgeCleanupLaunch({ card: { id: 'node-candidate' } }), null)
  assert.equal(buildSharedKnowledgeCleanupLaunch({ document: { id: 'map-other' } }), null)
  assert.equal(buildSharedKnowledgeCleanupLaunch(), null)
})

test('기본 요구 문구는 카드 검토 진입점 문구를 유지한다', () => {
  assert.ok(DEFAULT_AI_EDITOR_REQUEST.startsWith('이 카드의 최신 내용을 검토하세요.'))
  assert.match(DEFAULT_AI_EDITOR_REQUEST, /개발 계획을 세우거나 카드를 정비할 때.*구현·검증 조건이 2개 이상.*결과 중심 체크리스트/)
  assert.match(DEFAULT_AI_EDITOR_REQUEST, /별도 하위 카드.*체크리스트에 중복하지 말고/)
  assert.ok(DEFAULT_AI_EDITOR_REQUEST.includes('공유 지식에는 다른 카드가 다시 사용할 현재 유효한 결론만 남기세요.'))
  assert.ok(DEFAULT_AI_EDITOR_REQUEST.includes('그다음 수행할 작업을 우선순위와 완료 조건을 포함해 제안해 주세요.'))
  assert.equal(DEFAULT_AI_EDITOR_REQUEST, DEFAULT_AI_EDITOR_REQUEST.trim())
  assert.ok(DEFAULT_AI_EDITOR_REQUEST.length <= AI_EDITOR_REQUEST_MAX_LENGTH)
})

test('편집자 요청 문구는 상한을 넘기지 않는다', () => {
  assert.equal(normalizeAiEditorRequest('  요청  '), '요청')
  assert.equal(normalizeAiEditorRequest(42), '')
  assert.equal(normalizeAiEditorRequest('가'.repeat(AI_EDITOR_REQUEST_MAX_LENGTH + 50)).length, AI_EDITOR_REQUEST_MAX_LENGTH)
})
