import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDocumentView, OUTLINE_BUDGET_STEP_IDS, OUTLINE_POSTPROCESS_RESERVE_CHARS, OUTLINE_RESPONSE_BUDGET_CHARS } from '../mcp/documentViews.mjs'

const actor = { id: 'user-editor', name: '김용민' }
const text = (label, length) => `${label} `.repeat(Math.ceil(length / (label.length + 1))).slice(0, length)
function documentResult({ cards = 20, ledger = 0, waitingNotes = 0, metadata = 0, links = 0 } = {}) {
  const nodes = Array.from({ length: cards }, (_, index) => ({
    id: `card-${index}`, type: 'mind', position: { x: index * 10, y: 0 },
    data: {
      label: `카드 ${index}`, kind: index ? 'task' : 'root', status: 'planned', progress: 0, isWork: index > 0,
      description: text('설명', 300), sharedKnowledge: text('공유 지식', 300),
      ...(ledger && index === 1 ? { requirementsLedger: [text('요구사항 원장', ledger)] } : {}),
      // 대기 메모는 저장 한도(1,000자) 안에서 카드마다 두 건을 둔다.
      ...(waitingNotes ? { waitingItems: [1, 2].map((item) => ({ id: `w-${index}-${item}`, label: '외부 대기', resumeCondition: '전달물 수령', since: '2026-10-01', note: text(`카드 ${index} 대기 메모 ${item}`, waitingNotes) })) } : {}),
      ...(metadata ? { sharedKnowledgeUpdatedBy: actor, sharedKnowledgeUpdatedAt: '2026-10-28T00:00:00.000Z', reconstructionSources: [{ mapId: 'map-old', cardId: `old-${index}`, note: text('출처', metadata) }] } : {}),
    },
  }))
  const edges = nodes.slice(1).map((node) => ({ id: `edge-${node.id}`, source: 'card-0', target: node.id, data: { relation: 'hierarchy' } }))
  for (let index = 0; index < links; index++) edges.push({ id: `link-${index}`, source: `card-${(index % (cards - 1)) + 1}`, target: `card-${((index + 1) % (cards - 1)) + 1}`, data: { relation: 'knowledge', knowledgePolicy: 'reuse-first' } })
  return { map: { id: 'map-budget', title: '예산 문서', version: 3, createdBy: actor, updatedBy: actor, nodes, edges }, documentGroups: [] }
}
const outline = (result, cardIds) => buildDocumentView(result, { view: 'outline', ...(cardIds ? { cardIds } : {}), publicBaseUrl: 'https://mnp.example', imageAccessOf: () => null })

test('예산 안의 outline은 예산 표기 없이 그대로다', () => {
  const view = outline(documentResult())
  assert.ok(JSON.stringify(view).length <= OUTLINE_RESPONSE_BUDGET_CHARS)
  assert.equal(view.responseBudget, undefined)
  assert.match(view.omitted.notOmitted, /waitingItems 항목 전체\(note 원문 포함\)/)
})

test('큰 비원문 필드만 넘으면 그 필드만 생략하고 카드별 이름·회수 경로를 남긴다', () => {
  const result = documentResult({ ledger: 60000 })
  const view = outline(result, ['card-2'])
  assert.deepEqual(view.responseBudget.appliedSteps, ['largeFields'])
  assert.deepEqual(Object.keys(view).slice(0, 2), ['view', 'responseBudget'])
  assert.equal(view.responseBudget.returnedChars, JSON.stringify(view).length)
  assert.ok(view.responseBudget.returnedChars <= OUTLINE_RESPONSE_BUDGET_CHARS)
  assert.equal(view.responseBudget.exceeded, false)
  const card = view.cards.find((item) => item.id === 'card-1')
  assert.equal(card.data.requirementsLedger, undefined)
  assert.deepEqual(card.omittedFields, ['requirementsLedger'])
  assert.ok(card.textIntegrity.description.sha256, '이번 단계에서는 해시를 그대로 둔다')
  assert.equal(view.selectedCards[0].data.description, result.map.nodes[2].data.description, 'cardIds로 고른 카드 전문은 줄이지 않는다')
  assert.deepEqual(view.omitted.retrieval.cardFields.arguments, { mapId: 'map-budget', cardId: '<cardId>', fields: ['<field>'], includeComments: false })
  assert.match(view.omitted.notOmitted, /cardIds로 고른 카드의 전문\(selectedCards\)/)
})

test('대기 메모가 많으면 메모를 줄이되 판단 전에 원문을 확인하라고 안내한다', () => {
  const view = outline(documentResult({ cards: 40, waitingNotes: 700, metadata: 200 }))
  const applied = view.responseBudget.appliedSteps
  assert.deepEqual(applied, OUTLINE_BUDGET_STEP_IDS.filter((id) => applied.includes(id)), '단계 순서를 지킨다')
  assert.ok(applied.includes('waitingNotes'))
  assert.ok(view.responseBudget.returnedChars <= OUTLINE_RESPONSE_BUDGET_CHARS)
  // 큰 카드부터 필요한 만큼만 메모를 줄이므로, 생략 수는 실제로 메모가 빠진 항목 수와 같고 일부 카드는 원문을 유지한다.
  const items = view.cards.flatMap((item) => item.data.waitingItems ?? [])
  const withoutNote = items.filter((item) => item.note === undefined)
  const dropped = view.omitted.counts['cards[].data.waitingItems[].note']
  assert.ok(dropped > 0 && dropped <= 80)
  if (!applied.includes('waitingCounts')) {
    assert.equal(withoutNote.length, dropped)
    assert.ok(items.some((item) => item.note), '예산에 들면 남은 카드의 메모는 그대로 둔다')
    assert.ok(withoutNote.every((item) => item.resumeCondition === '전달물 수령'))
  }
  assert.match(view.omitted.fields['cards[].data.waitingItems[].note'], /재개를 제한하는 조건.*대기 재개·완료·위임 판단 전.*retrieval\.cardFields/s)
  assert.equal(view.cards.find((item) => item.id === 'card-3').data.sharedKnowledgeUpdatedBy, undefined)
})

test('아주 큰 문서도 구조를 남긴 채 예산 안으로 줄이고, 줄일 수 없으면 exceeded로 알린다', () => {
  const view = outline(documentResult({ cards: 250, waitingNotes: 600, metadata: 300, links: 120 }))
  assert.ok(view.responseBudget.appliedSteps.includes('minimalCards'))
  assert.equal(view.cards.length, 250)
  const minimal = view.cards.filter((item) => item.minimal)
  assert.ok(minimal.length > 0)
  assert.deepEqual(Object.keys(minimal[0]).sort(), ['childCount', 'data', 'id', 'minimal', 'parentId'])
  assert.equal(view.omitted.counts['cards[].minimal'], minimal.length)
  assert.ok(view.cards.every((item) => item.id && (item.parentId === null || item.parentId === 'card-0')))
  assert.equal(view.responseBudget.exceeded, view.responseBudget.returnedChars > OUTLINE_RESPONSE_BUDGET_CHARS)
  assert.equal(view.stats.cardCount, 250)
  const impossible = outline(documentResult({ cards: 900 }))
  assert.equal(impossible.responseBudget.exceeded, true)
  assert.equal(impossible.cards.length, 900, '카드 목록 자체는 자르지 않는다')
})

test('카드별로 줄이다 멈춰도 후처리 여유분을 남긴다', () => {
  let progressive = 0
  for (let cards = 60; cards <= 200; cards += 3) {
    const view = outline(documentResult({ cards, waitingNotes: 40 }))
    // 모든 카드를 최소 형태로 줄여도 여유분 안에 못 들면 줄일 것이 없으므로 한도(40,000자)만 지킨다.
    if (!view.responseBudget || view.responseBudget.exceeded || view.cards.every((card) => card.minimal)) continue
    if (['waitingNotes', 'waitingCounts', 'minimalCards'].includes(view.responseBudget.appliedSteps.at(-1))) progressive++
    assert.equal(view.responseBudget.returnedChars, JSON.stringify(view).length)
    assert.ok(view.responseBudget.returnedChars <= OUTLINE_RESPONSE_BUDGET_CHARS - OUTLINE_POSTPROCESS_RESERVE_CHARS, `${cards}장: ${view.responseBudget.returnedChars}자`)
  }
  assert.ok(progressive >= 10, `카드별 단계에서 멈춘 규모 ${progressive}개`)
})

test('cardIds로 고른 카드 전문만으로 예산을 넘으면 개요를 줄이지 않고 cardIds를 줄이라고 안내한다', () => {
  const result = documentResult({ ledger: 60000 })
  const view = outline(result, ['card-1'])
  assert.deepEqual(view.responseBudget.appliedSteps, [])
  assert.equal(view.responseBudget.exceeded, true)
  assert.deepEqual(view.selectedCards[0].data.requirementsLedger, result.map.nodes[1].data.requirementsLedger)
  assert.ok(view.cards.find((item) => item.id === 'card-1').data.requirementsLedger, '개요의 필드도 그대로 둔다')
  assert.match(view.omitted.fields.selectedCards, /cardIds를 줄이거나 retrieval\.cardFields/)
})
