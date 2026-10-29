import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCardReadBudget, applyCommentListBudget, CARD_READ_BUDGET_STEP_IDS, CARD_READ_RESPONSE_BUDGET_CHARS } from '../mcp/cardReadBudget.mjs'
import { cardTextIntegrity } from '../mcp/cardTextPatch.mjs'

const mapId = 'map-card-read'
const cardId = 'card-heavy'
const LIMIT = CARD_READ_RESPONSE_BUDGET_CHARS
const text = (label, length) => `${label} `.repeat(Math.ceil(length / (label.length + 1))).slice(0, length)
// list_comments·get_card와 같은 형태의 댓글. 최신순(desc) 페이지의 앞쪽이 최신이다.
const comment = (index, detail = 3000) => ({
  id: `comment-${String(index).padStart(3, '0')}`, mapId, nodeId: cardId, contentFormat: 'summary-detail',
  summary: `[결과] ${index}번째 검증 결과를 기록했다.`, text: `[결과] ${index}번째 검증 결과를 기록했다.`,
  ...(detail ? { detail: text(`${index}번 상세`, detail) } : {}), parentId: null, resolvedAt: null, resolvedBy: null, reactions: {},
  createdAt: new Date(Date.UTC(2026, 9, 28) - index * 60_000).toISOString(), author: { id: 'user-editor', name: '김용민' },
})
const listPage = ({ count = 60, detail = 3000, offset = 0, limit = 100, total = count + offset } = {}) => ({
  comments: Array.from({ length: count }, (_, index) => comment(offset + index, detail)),
  total, offset, limit, order: 'desc', hasMore: offset + count < total, nextOffset: offset + count < total ? offset + count : null,
})
function cardResponse({ description = 3000, sharedKnowledge = 2000, extra = {}, comments = 20, detail = 2500, commentLimit = 20, total = comments } = {}) {
  const data = { label: '큰 카드', kind: 'task', status: 'in-progress', progress: 40, isWork: true,
    ...(description ? { description: text('요구사항 설명', description) } : {}), ...(sharedKnowledge ? { sharedKnowledge: text('결론 공유 지식', sharedKnowledge) } : {}),
    checklist: [{ id: 'c1', text: '완료 조건', done: false }], waitingItems: [{ id: 'w1', label: '외부 대기', resumeCondition: '회신 수령' }], ...extra }
  return {
    documentGroups: [],
    document: { id: mapId, title: '예산 문서', version: 3, updatedAt: '2026-10-28T00:00:00.000Z', updatedBy: { id: 'user-editor', name: '김용민' } },
    card: { id: cardId, type: 'mind', data, textIntegrity: cardTextIntegrity(data) },
    accessUrl: `https://mnp.example/mindmap/${mapId}/${cardId}`,
    comments: Array.from({ length: comments }, (_, index) => comment(index, detail)),
    commentsPage: { total, offset: 0, limit: commentLimit, order: 'desc', hasMore: total > comments, nextOffset: total > comments ? comments : null },
  }
}
const cardArgs = (extra = {}) => ({ mapId, cardId, includeComments: true, commentLimit: 20, includeCommentDetail: true, ...extra })

test('예산 안의 응답은 같은 객체를 그대로 반환한다', () => {
  const page = listPage({ count: 5 })
  assert.equal(applyCommentListBudget(page, { mapId, cardId, includeDetail: true }), page)
  const card = cardResponse({ comments: 3 })
  assert.equal(applyCardReadBudget(card, cardArgs()), card)
})

test('list_comments는 앞쪽 댓글부터 예산에 드는 만큼 남기고 limit·nextOffset을 반환한 댓글 기준으로 맞춘다', () => {
  const page = listPage({ count: 60, offset: 20, total: 150 })
  const before = structuredClone(page)
  const result = applyCommentListBudget(page, { mapId, cardId, includeDetail: true })
  assert.deepEqual(page, before, '입력 응답을 변경하지 않는다')
  assert.deepEqual(Object.keys(result).slice(0, 3), ['responseBudget', 'omitted', 'comments'])
  assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length)
  assert.ok(result.responseBudget.returnedChars <= LIMIT)
  assert.equal(result.responseBudget.exceeded, false)
  const count = result.comments.length
  assert.ok(count > 0 && count < 60)
  assert.deepEqual(result.comments, before.comments.slice(0, count), '반환한 댓글은 요약·상세를 줄이지 않는다')
  assert.equal(result.responseBudget.returnedComments, count)
  assert.equal(result.responseBudget.requestedLimit, 100)
  assert.equal(result.limit, count)
  assert.equal(result.offset, 20)
  assert.equal(result.nextOffset, 20 + count, '건너뛴 댓글이 없다')
  assert.equal(result.offset + result.limit, result.nextOffset)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.omitted.retrieval.comments.arguments, { mapId, cardId, offset: 20 + count, limit: 100, order: 'desc', includeDetail: true })
  // 다음 페이지를 이어 받으면 처음 요청한 범위의 댓글을 빠짐없이 받는다.
  const next = applyCommentListBudget(listPage({ count: 60 - count, offset: 20 + count, total: 150 }), { mapId, cardId, includeDetail: true })
  assert.equal((next.comments ?? []).at(0)?.id, before.comments[count]?.id)
})

test('list_comments는 댓글 하나만으로 넘어도 한 건은 돌려주고 exceeded로 알린다', () => {
  const result = applyCommentListBudget(listPage({ count: 2, detail: 6000 }), { mapId, includeDetail: true, limitChars: 5000 })
  assert.equal(result.comments.length, 1)
  assert.equal(result.responseBudget.exceeded, true)
  assert.equal(result.nextOffset, 1)
  assert.equal(result.omitted.retrieval.comments.arguments.cardId, undefined, '문서 전체 조회는 cardId를 넣지 않는다')
})

test('get_card는 댓글 페이지를 먼저 줄이고 카드 본문은 그대로 둔다', () => {
  const response = cardResponse({ comments: 40, detail: 3000, commentLimit: 50, total: 70 })
  const before = structuredClone(response)
  const result = applyCardReadBudget(response, cardArgs({ commentLimit: 50 }))
  assert.deepEqual(response, before)
  assert.deepEqual(result.responseBudget.appliedSteps, ['commentPage'])
  assert.deepEqual(Object.keys(result).slice(0, 4), ['documentGroups', 'document', 'responseBudget', 'omitted'])
  assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length)
  assert.ok(result.responseBudget.returnedChars <= LIMIT)
  assert.deepEqual(result.card, before.card, '카드 원문은 줄이지 않는다')
  const count = result.comments.length
  assert.ok(count > 0 && count < 40)
  assert.deepEqual(result.comments, before.comments.slice(0, count))
  assert.equal(result.commentsPage.nextOffset, count)
  assert.equal(result.commentsPage.limit, count)
  assert.deepEqual(result.omitted.retrieval.comments, { tool: 'mindnprogress_list_comments', arguments: { mapId, cardId, offset: count, limit: 50, order: 'desc', includeDetail: true } })
  assert.equal(result.omitted.retrieval.cardFields, undefined)
})

test('get_card는 큰 보조 필드를 생략하면 생긴 여유만큼 댓글을 다시 채운다', () => {
  const response = cardResponse({ extra: { requirementsLedger: [text('요구사항 원장', 60000)] }, comments: 6, detail: 2000 })
  const result = applyCardReadBudget(response, cardArgs())
  assert.deepEqual(result.responseBudget.appliedSteps, ['cardLargeFields'], '댓글은 결국 줄이지 않았으므로 단계에서 뺀다')
  assert.equal(result.comments.length, 6)
  assert.deepEqual(result.commentsPage, response.commentsPage)
  assert.deepEqual(result.card.omittedFields, ['requirementsLedger'])
  assert.equal(result.card.data.requirementsLedger, undefined)
  assert.equal(result.card.data.description, response.card.data.description)
  assert.deepEqual(result.card.data.checklist, response.card.data.checklist)
  assert.deepEqual(result.omitted.retrieval.cardFields.arguments, { mapId, cardId, fields: ['<field>'], includeComments: false })
  assert.equal(result.omitted.retrieval.comments, undefined)
})

test('get_card 원문은 큰 것부터 하나씩 생략하고 길이·SHA-256은 남긴다', () => {
  const response = cardResponse({ description: 30000, sharedKnowledge: 20000, comments: 0 })
  const result = applyCardReadBudget(response, cardArgs())
  assert.deepEqual(result.responseBudget.appliedSteps, ['cardTextFields'])
  assert.deepEqual(result.card.omittedFields, ['description'], '큰 원문 하나만 빼서 예산에 들면 다른 원문은 그대로 둔다')
  assert.equal(result.card.data.sharedKnowledge, response.card.data.sharedKnowledge)
  assert.deepEqual(result.card.textIntegrity, response.card.textIntegrity)
  assert.match(result.omitted.fields['card.data(원문)'], /retrieval\.cardFields로 한 필드씩/)
  const both = applyCardReadBudget(cardResponse({ description: 45000, sharedKnowledge: 42000, comments: 5 }), cardArgs())
  assert.deepEqual(both.card.omittedFields, ['description', 'sharedKnowledge'])
  assert.equal(both.responseBudget.exceeded, false)
  assert.ok(both.comments.length > 0, '원문을 뺀 뒤 남은 여유로 댓글을 채운다')
})

test('fields로 고른 필드는 줄이지 않고, 넘으면 exceeded와 함께 필드를 나누라고 안내한다', () => {
  const response = cardResponse({ description: 30000, sharedKnowledge: 20000, comments: 0 })
  const result = applyCardReadBudget(response, cardArgs({ fields: ['description', 'sharedKnowledge'] }))
  assert.equal(result.responseBudget.exceeded, true)
  assert.deepEqual(result.responseBudget.appliedSteps, [])
  assert.equal(result.card.data.description, response.card.data.description)
  assert.equal(result.card.omittedFields, undefined)
  assert.match(result.omitted.fields['card(fields)'], /fields를 나눠 한 필드씩/)
})

test('includeComments=false는 댓글 단계를 건너뛴다', () => {
  const response = cardResponse({ description: 30000, sharedKnowledge: 20000, comments: 0 })
  response.commentsPage = { total: 30, offset: 0, limit: 0, order: 'desc', hasMore: true, nextOffset: 0 }
  const result = applyCardReadBudget(response, cardArgs({ includeComments: false }))
  assert.deepEqual(result.responseBudget.appliedSteps, ['cardTextFields'])
  assert.deepEqual(result.commentsPage, response.commentsPage)
})

test('여러 규모에서 최종 크기가 예산을 지키고 단계 순서를 따른다', () => {
  let budgeted = 0
  for (const description of [5000, 18000, 26000, 41000]) for (const comments of [0, 12, 35]) for (const ledger of [0, 9000]) {
    const response = cardResponse({ description, sharedKnowledge: 15000, comments, detail: 2800, commentLimit: 50, total: comments + 10,
      extra: ledger ? { requirementsLedger: [text('원장', ledger)] } : {} })
    const result = applyCardReadBudget(response, cardArgs({ commentLimit: 50 }))
    if (!result.responseBudget) continue
    budgeted++
    const label = `설명 ${description}·댓글 ${comments}·원장 ${ledger}`
    const applied = result.responseBudget.appliedSteps
    assert.deepEqual(applied, CARD_READ_BUDGET_STEP_IDS.filter((id) => applied.includes(id)), label)
    assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length, label)
    assert.ok(result.responseBudget.returnedChars <= LIMIT, `${label}: ${result.responseBudget.returnedChars}자`)
    assert.equal(result.responseBudget.exceeded, false, label)
    assert.deepEqual(result.card.textIntegrity, response.card.textIntegrity, label)
  }
  assert.ok(budgeted >= 12, `예산이 적용된 규모 ${budgeted}개`)
})
