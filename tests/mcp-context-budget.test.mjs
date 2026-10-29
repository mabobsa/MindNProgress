import assert from 'node:assert/strict'
import test from 'node:test'
import { applyContextBudget, CONTEXT_BUDGET_STEP_IDS, CONTEXT_RESPONSE_BUDGET_CHARS } from '../mcp/contextBudget.mjs'
import { cardTextIntegrity } from '../mcp/cardTextPatch.mjs'

const mapId = 'map-budget'
const cardId = 'task-selected'
const text = (label, length) => `${label} `.repeat(Math.ceil(length / (label.length + 1))).slice(0, length)
const compact = (id, extra = {}) => ({ id, label: `카드 ${id}`, kind: 'task', status: 'planned', progress: 0, isWork: true, waitingItems: [{ id: `w-${id}`, label: '외부 대기', resumeCondition: '전달물 수령', since: '2026-10-01' }], ...extra })
const source = (index, { description = 300, sharedKnowledge = 300 } = {}) => {
  const data = { label: `선행 지식 ${index}`, kind: 'task', status: 'done', progress: 100, isWork: true, description: text(`원천${index} 설명`, description), sharedKnowledge: text(`원천${index} 결론`, sharedKnowledge), checklist: [{ id: 'c', text: '검증', done: true }] }
  return {
    policy: 'reuse-first',
    card: { id: `source-${index}`, type: 'mind', data, textIntegrity: cardTextIntegrity(data) },
    accessUrl: `https://mnp.example/mindmap/${mapId}/source-${index}`,
    comments: [{ id: `sc-${index}`, nodeId: `source-${index}`, text: '원천 댓글 요약' }],
    commentsPage: { total: 1, included: 1, order: 'asc', hasMore: false, tool: 'mindnprogress_list_comments', detailToolArguments: null, nextToolArguments: null },
    taskLink: null,
    detailTool: 'mindnprogress_get_card',
    detailToolArguments: { mapId, cardId: `source-${index}`, includeCommentDetail: true },
  }
}
// get_context focused 응답과 같은 형태의 합성 응답. 규칙 문구는 실제처럼 크게 둔다.
function focusedResponse({ guideLength = 16000, sources = 4, sourceSize = {}, selectedDescription = 3000, outlineCards = 30, comments = 20, knowledgeLinks = 40 } = {}) {
  const selectedData = { label: '선택 카드', kind: 'task', status: 'in-progress', progress: 30, isWork: true, description: text('선택 카드 요구사항', selectedDescription), sharedKnowledge: text('선택 카드 결론', 2000), checklist: [{ id: 'k1', text: '완료 조건', done: false }], waitingItems: [{ id: 'sw', label: '기획 결정', note: '재개 조건 메모', resumeCondition: '기획 확정' }], remainingWorkItems: [text('남은 작업', 4000)] }
  return {
    contextSchemaVersion: '3.4',
    detailLevel: 'focused',
    group: null,
    documentGroups: [],
    groupProject: null,
    guide: { version: 'test', rules: text('제품 규칙', guideLength) },
    document: {
      id: mapId, title: '예산 문서', version: 7, accessUrl: `https://mnp.example/mindmap/${mapId}`,
      stats: { cardCount: outlineCards, hierarchyEdgeCount: outlineCards - 1, knowledgeEdgeCount: knowledgeLinks },
      outline: Array.from({ length: outlineCards }, (_, index) => ({ ...compact(`card-${index}`), parentId: index ? 'card-0' : null, childCount: 0, blockedByIds: [] })),
      knowledgeLinks: Array.from({ length: knowledgeLinks }, (_, index) => ({ sourceId: index === 0 ? 'source-0' : `card-${index}`, targetId: index === 0 ? cardId : `card-${index + 1}`, policy: 'reuse-first' })),
    },
    selection: {
      card: { id: cardId, type: 'mind', data: selectedData, textIntegrity: cardTextIntegrity(selectedData) },
      accessUrl: `https://mnp.example/mindmap/${mapId}/${cardId}`,
      parents: [compact('parent')], children: [], siblings: [compact('sibling-1'), compact('sibling-2')], ancestors: [compact('parent')],
      descendants: [], blockedBy: [], blocks: [],
      knowledgeSources: { primary: Array.from({ length: sources }, (_, index) => source(index, sourceSize)), fallback: [], rule: '선행 지식 규칙 원문' },
      aiWorkCoordination: { tool: 'mindnprogress_get_ai_work_states', instruction: text('위임 규칙', 3000) },
      taskLinks: { selectedCard: null, startupInspection: { mode: 'knowledge-guided', instruction: text('조사 규칙', 2000) }, rule: '업무 링크 규칙' },
      comments: Array.from({ length: comments }, (_, index) => ({ id: `comment-${index}`, nodeId: cardId, text: text(`댓글 ${index}`, 300), hasDetail: false })),
      commentsPage: { total: comments + 5, included: comments, order: 'asc', hasMore: true, tool: 'mindnprogress_list_comments', detailToolArguments: null, nextToolArguments: { mapId, cardId, offset: comments, limit: 50, order: 'desc', includeDetail: false } },
    },
    teamMembers: [{ id: 'user-editor', name: '김용민' }],
    nextStep: '다음 단계 규칙 원문',
  }
}
const rulesOf = (response) => ({ guide: response.guide, groupProject: response.groupProject, taskLinks: response.selection.taskLinks,
  aiWorkCoordination: response.selection.aiWorkCoordination, knowledgeRule: response.selection.knowledgeSources.rule, nextStep: response.nextStep })

test('예산 안의 focused 응답은 같은 객체를 그대로 반환한다', () => {
  const response = focusedResponse({ guideLength: 2000, sources: 1, outlineCards: 3, comments: 2, knowledgeLinks: 2, selectedDescription: 500 })
  assert.ok(JSON.stringify(response).length <= CONTEXT_RESPONSE_BUDGET_CHARS)
  assert.equal(applyContextBudget(response, { mapId, cardId }), response)
})

test('조금 넘으면 선행 지식 설명부터 줄이고 예산 안에 들어오면 멈춘다', () => {
  const response = focusedResponse({ guideLength: 14000, sources: 4, sourceSize: { description: 6000 }, outlineCards: 6, comments: 3, knowledgeLinks: 4, selectedDescription: 2000 })
  const before = structuredClone(response)
  const result = applyContextBudget(response, { mapId, cardId })
  assert.deepEqual(response, before, '입력 응답을 변경하지 않는다')
  assert.deepEqual(result.contextBudget.appliedSteps, ['knowledgeSourceSupplements'])
  assert.equal(result.contextBudget.exceeded, false)
  assert.equal(result.contextBudget.returnedChars, JSON.stringify(result).length)
  assert.ok(result.contextBudget.returnedChars <= CONTEXT_RESPONSE_BUDGET_CHARS)
  assert.deepEqual(Object.keys(result).slice(0, 4), ['contextSchemaVersion', 'detailLevel', 'contextBudget', 'omitted'])
  assert.deepEqual(rulesOf(result), rulesOf(before), '규칙 문구는 그대로 둔다')
  const first = result.selection.knowledgeSources.primary[0]
  assert.equal(first.card.data.description, undefined)
  assert.equal(first.card.data.sharedKnowledge, before.selection.knowledgeSources.primary[0].card.data.sharedKnowledge)
  assert.deepEqual(first.card.textIntegrity, before.selection.knowledgeSources.primary[0].card.textIntegrity)
  assert.deepEqual(first.comments, [])
  assert.equal(result.selection.card.data.description, before.selection.card.data.description, '선택 카드 원문은 마지막까지 남긴다')
  assert.deepEqual(result.omitted.retrieval.knowledgeSource.arguments, { mapId, cardId: '<cardId>', fields: ['sharedKnowledge'], includeComments: false })
})

test('크게 넘으면 정해진 순서로 줄이고 생략한 카드·필드·개수와 회수 경로를 남긴다', () => {
  const response = focusedResponse({ sources: 12, sourceSize: { description: 6000, sharedKnowledge: 3500 }, selectedDescription: 12000, outlineCards: 120, comments: 20, knowledgeLinks: 200 })
  const before = structuredClone(response)
  const result = applyContextBudget(response, { mapId, cardId })
  const applied = result.contextBudget.appliedSteps
  assert.deepEqual(applied, CONTEXT_BUDGET_STEP_IDS.filter((id) => applied.includes(id)), '단계 순서를 지킨다')
  assert.ok(applied.includes('knowledgeSourceSharedKnowledge'))
  assert.equal(result.contextBudget.exceeded, false)
  assert.ok(result.contextBudget.returnedChars <= CONTEXT_RESPONSE_BUDGET_CHARS)
  assert.deepEqual(rulesOf(result).guide, before.guide)
  assert.deepEqual(result.selection.taskLinks, before.selection.taskLinks)
  assert.deepEqual(result.selection.aiWorkCoordination, before.selection.aiWorkCoordination)
  assert.equal(result.nextStep, before.nextStep)
  // 선행 지식 색인은 모든 원천을 남기고, 원문을 뺀 원천의 ID를 기록한다.
  const primary = result.selection.knowledgeSources.primary
  assert.equal(primary.length, 12)
  const omittedIds = result.omitted.cardIds.knowledgeSourceSharedKnowledge
  assert.ok(omittedIds.length > 0)
  for (const entry of primary) {
    assert.equal(entry.card.data.sharedKnowledge === undefined, omittedIds.includes(entry.card.id))
    assert.equal(entry.card.textIntegrity.sharedKnowledge.length, before.selection.knowledgeSources.primary.find((item) => item.card.id === entry.card.id).card.textIntegrity.sharedKnowledge.length)
    assert.equal(entry.accessUrl, undefined)
  }
  assert.equal(result.omitted.cardAccessUrlTemplate, `https://mnp.example/mindmap/${mapId}/{cardId}`)
  // 선택 카드 지식선은 남고 나머지는 개수만 남는다.
  assert.deepEqual(result.document.knowledgeLinks, [{ sourceId: 'source-0', targetId: cardId, policy: 'reuse-first' }])
  assert.equal(result.omitted.counts['document.knowledgeLinks'], 199)
  // 선택 카드의 체크리스트·대기와 무결성 정보는 남는다.
  assert.deepEqual(result.selection.card.data.checklist, before.selection.card.data.checklist)
  assert.deepEqual(result.selection.card.data.waitingItems, before.selection.card.data.waitingItems)
  assert.deepEqual(result.selection.card.textIntegrity, before.selection.card.textIntegrity)
  assert.equal(result.selection.siblings[0].waitingItems, undefined)
  assert.equal(result.selection.siblings[0].waitingItemCount, 1)
  if (applied.includes('selectedDescription')) {
    assert.equal(result.selection.card.data.description, undefined)
    assert.deepEqual(result.omitted.retrieval.selectedCard.arguments.fields.slice(0, 1), ['description'])
    assert.equal(result.omitted.retrieval.selectedCard.arguments.includeComments, false)
  }
  if (result.omitted.counts['selection.comments']) {
    assert.equal(result.selection.commentsPage.included, result.selection.comments.length)
    assert.equal(result.selection.commentsPage.total, before.selection.commentsPage.total)
    assert.equal(result.omitted.retrieval.comments.tool, 'mindnprogress_list_comments')
  }
})

test('규칙만으로 예산을 넘으면 모든 단계를 적용하고 exceeded로 알리되 규칙은 줄이지 않는다', () => {
  const response = focusedResponse({ guideLength: 45000, sources: 3 })
  const result = applyContextBudget(response, { mapId, cardId })
  assert.equal(result.contextBudget.exceeded, true)
  assert.ok(result.contextBudget.returnedChars > CONTEXT_RESPONSE_BUDGET_CHARS)
  assert.deepEqual(result.guide, response.guide)
  assert.ok(result.contextBudget.appliedSteps.includes('selectedDescription'))
  assert.deepEqual(result.omitted.selectedCardFields, ['description', 'sharedKnowledge', 'remainingWorkItems'])
  assert.deepEqual(result.omitted.retrieval.selectedCard.arguments, { mapId, cardId, fields: ['description', 'sharedKnowledge', 'remainingWorkItems'], includeComments: false })
})
