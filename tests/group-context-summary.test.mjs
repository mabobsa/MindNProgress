import assert from 'node:assert/strict'
import test from 'node:test'
import { createGroupProjects } from '../server/lib/groupProjects.mjs'
import { groupDocumentInstructionPublicView } from '../server/lib/groupDocumentInstructions.mjs'
import { GROUP_CONTEXT_SUMMARY_LIMITS, summarizeGroupContext } from '../server/lib/groupContextSummary.mjs'
import { textIntegrity } from '../mcp/cardTextPatch.mjs'

const wait = (id, label) => ({ id, label, note: `${label} 사유 원문`, resumeCondition: `${label} 재개 조건`, since: '2026-10-01T00:00:00Z' })
const node = (id, data) => ({ id, type: 'mind', position: { x: 0, y: 0 }, data: { status: 'in-progress', progress: 0, ...data } })
const documentMap = (id, { description = `${id} 담당 범위`, waitingCards = 0 } = {}) => ({
  id, title: `${id} 문서`, version: 3,
  nodes: [
    ...Array.from({ length: waitingCards }, (_, index) => node(`${id}-task-${index}`, { label: `업무 ${index}`, kind: 'task', isWork: true, waitingItems: [wait(`w${index}`, `대기 ${index}`)] })),
    node(`${id}-root`, { label: `${id} 루트`, kind: 'root', isWork: false, description, sharedKnowledge: `${id} 공유 지식`, waitingItems: [wait('root-wait', '루트 대기')] }),
  ],
  edges: Array.from({ length: waitingCards }, (_, index) => ({ id: `e${index}`, source: `${id}-root`, target: `${id}-task-${index}`, type: 'default' })),
})
const instruction = (id, targetMapId, minute, extra = {}) => ({
  id, groupId: 'group-summary', parentMapId: 'map-coordinator', targetMapId, targetCardId: `${targetMapId}-root`, state: 'replied',
  reasonCode: 'GROUP_DOCUMENT_INSTRUCTION_REPLIED', approvalScope: 'implementation', instructionType: 'execution', groupProjectVersion: 2, targetRevision: 3,
  createdAt: `2026-10-28T00:${String(minute).padStart(2, '0')}:00.000Z`, repliedAt: `2026-10-28T01:${String(minute).padStart(2, '0')}:00.000Z`,
  instruction: `${id} 지시 전문`, approvalEvidence: `${id} 승인 근거`, response: `${id} 응답 전문`, instructionPreview: `${id} 미리보기`,
  replyTarget: { mode: 'origin', defaultConversationId: 'conversation-coordinator', explicitConversationId: null, effectiveConversationId: 'conversation-coordinator', evidence: null },
  requestSignature: 'secret-signature', ...extra,
})

async function fullContext() {
  const maps = [
    documentMap('map-coordinator'),
    documentMap('map-a', { description: '가'.repeat(5000), waitingCards: GROUP_CONTEXT_SUMMARY_LIMITS.waitingCardsPerDocument + 3 }),
    documentMap('map-b'),
  ]
  const group = { id: 'group-summary', name: '요약 그룹', mapIds: maps.map((map) => map.id) }
  const instructions = [
    ...Array.from({ length: 25 }, (_, index) => instruction(`a-${index}`, 'map-a', 30 + index)),
    instruction('b-old', 'map-b', 1),
    instruction('b-queued', 'map-b', 2, { state: 'queued', reasonCode: null, repliedAt: null }),
    instruction('outside', 'map-left-group', 3, { state: 'failed', reasonCode: 'GROUP_DOCUMENT_INSTRUCTION_DISPATCH_FAILED', repliedAt: null }),
    instruction('old-parent', 'map-a', 4, { parentMapId: 'map-old-coordinator' }),
  ]
  const delegations = [{ id: 'delegation-a', groupId: group.id, mapId: 'map-a', parentMapId: 'map-coordinator', targetCardId: 'map-a-root', state: 'completed',
    coordinationOnly: true, createdAt: '2026-09-01T00:00:00.000Z', instructionPreview: '위임 미리보기', childResultSnapshot: '위임 결과 원문' }]
  const groups = createGroupProjects({
    dataDirectory: 'unused', replaceFile: async () => { throw new Error('읽기 전용') }, readStoredFile: async () => JSON.stringify({ version: 2, coordinatorMapId: 'map-coordinator', sources: [], objective: '그룹 목표 원문', instructions: '공통 지침 원문' }),
    listMaps: async () => maps, readMap: async (id) => maps.find((map) => map.id === id), saveMap: async () => { throw new Error('읽기 전용') },
    readLayout: async () => ({ groups: [group] }), writeLayout: async () => { throw new Error('읽기 전용') },
    delegations: new Map(delegations.map((item) => [item.id, item])), publicDelegation: ({ childResultSnapshot: _result, ...item }) => item,
    documentInstructions: new Map(instructions.map((item) => [item.id, item])), publicDocumentInstruction: groupDocumentInstructionPublicView,
    runtimeSnapshot: () => [],
  })
  return groups.context(group.id)
}

test('요약은 그룹 기준·guide 전문을 유지하고 원문 대신 길이와 회수 경로를 준다', async () => {
  const full = await fullContext()
  const before = structuredClone(full)
  const summary = summarizeGroupContext(full, { mapId: 'map-coordinator' })
  assert.deepEqual(full, before, '요약 변환이 전체 문맥을 변경하지 않는다')
  assert.equal(summary.view, 'summary')
  assert.equal(summary.role, 'coordinator')
  assert.deepEqual(summary.project, full.project)
  assert.deepEqual(summary.guide, full.guide)
  assert.deepEqual(summary.coordinator, { id: 'map-coordinator', title: 'map-coordinator 문서', version: 3, rootId: 'map-coordinator-root' })
  const text = JSON.stringify(summary)
  for (const original of ['a-24 지시 전문', 'a-24 승인 근거', 'a-24 응답 전문', '루트 대기 사유 원문', '루트 대기 재개 조건', 'map-a 공유 지식', '위임 결과 원문', '위임 미리보기', 'secret-signature', '가'.repeat(100)]) {
    assert.ok(!text.includes(original), `${original}은 요약에 포함하지 않는다`)
  }
  assert.deepEqual(Object.keys(summary).slice(0, 4), ['view', 'role', 'mapId', 'detail'], '일부만 출력되거나 중간이 잘려도 생략 안내가 보이도록 앞에 둔다')
  for (const document of full.documents) {
    const item = summary.documents.find((value) => value.id === document.id)
    assert.equal(item.version, document.version)
    assert.equal(item.root.id, document.root.id)
    // get_card의 textIntegrity와 같은 계산이어야 AI가 원문 회수 결과와 변경 여부를 대조할 수 있다.
    assert.deepEqual(item.root.textIntegrity, { description: textIntegrity(document.root.data.description), sharedKnowledge: textIntegrity(document.root.data.sharedKnowledge) })
    assert.deepEqual(item.root.data, { label: document.root.data.label, status: document.root.data.status, progress: document.root.data.progress, aiConversationCount: 0 })
    assert.deepEqual(item.work, document.work)
    assert.equal(item.waiting.items, document.waitingDetails.length, '대기 건수는 생략 없이 원문 수와 같다')
    assert.equal(item.waiting.cards.reduce((sum, card) => sum + card.labels.length, 0) + item.waiting.omittedCards, item.waiting.items)
    assert.equal(item.waiting.cards[0].isRoot, true, '루트 대기는 상한에 걸리지 않게 먼저 둔다')
    const waitingCardIds = new Set(document.waitingDetails.map((detail) => detail.cardId))
    assert.equal(item.waiting.omittedCardIds.length, item.waiting.omittedCards)
    assert.deepEqual(new Set([...item.waiting.cards.map((card) => card.cardId), ...item.waiting.omittedCardIds]), waitingCardIds, '상한 밖 카드도 ID로 회수할 수 있다')
  }
  assert.equal(summary.documents.find((item) => item.id === 'map-a').waiting.omittedCards, 4)
  assert.match(summary.detail.waiting, /omittedCardIds.*mindnprogress_get_card.*outline.*도구 출력 한도/s)
  assert.match(summary.detail.waiting, /project\.waitingReviews.*valid.*full의 waitingDetails\[\]\.review/s)
  assert.match(summary.detail.rootText, /root\.textIntegrity.*sha256이 다르면/s)
  for (const key of ['rootText', 'waiting', 'documentInstructions', 'delegations', 'full']) assert.match(summary.detail[key], /mindnprogress_|detailLevel=full/)
  assert.match(summary.detail.scope, /실행 승인이나 완료 판단의 근거가 아닙니다/)
})

test('총괄 요약은 문서별 최신·대기 지시를 상한과 관계없이 담고 생략 수를 밝힌다', async () => {
  const full = await fullContext()
  const summary = summarizeGroupContext(full, { mapId: 'map-coordinator' })
  const ids = summary.documentInstructions.map((item) => item.id)
  assert.deepEqual(ids, full.documentInstructions.map((item) => item.id).filter((id) => ids.includes(id)), '최신순을 유지한다')
  assert.ok(ids.includes('a-24') && ids.includes('b-queued') && ids.includes('b-old') === false)
  const counts = summary.documentInstructionCounts
  assert.equal(counts.total, full.documentInstructions.length)
  assert.equal(counts.shown + counts.omitted, counts.total)
  assert.ok(counts.shown <= GROUP_CONTEXT_SUMMARY_LIMITS.documentInstructions + 2)
  assert.deepEqual(counts.byState, { replied: 27, queued: 1, failed: 1 })
  // 생략 ID 전체는 크기 부담이 커서 대상 문서별 수만 남기고 targetMapId 필터 조회로 안내한다.
  assert.deepEqual(counts.omittedByTarget, { 'map-a': 6, 'map-left-group': 1, 'map-b': 1 })
  assert.equal(Object.values(counts.omittedByTarget).reduce((sum, value) => sum + value, 0), counts.omitted)
  assert.ok(summary.documentInstructions.every((item) => item.replyTarget === undefined), '회신 대상은 문서 담당 관점에만 둔다')
  const byId = new Map(summary.documentInstructions.map((item) => [item.id, item]))
  assert.equal(byId.get('a-24').instructionPreview, 'a-24 미리보기')
  assert.equal(byId.get('b-queued').instructionPreview, 'b-queued 미리보기')
  assert.equal(byId.get('a-23').instructionPreview, undefined, '최신이 아닌 응답 완료 지시는 미리보기를 생략한다')
  assert.equal(byId.get('a-24').reasonCode, undefined, '상태와 같은 기본 사유는 반복하지 않는다')
  for (const item of summary.documentInstructions) {
    for (const field of ['instruction', 'approvalEvidence', 'response', 'requestSignature']) assert.equal(item[field], undefined)
  }
})

test('그룹 밖 대상과 이전 총괄의 지시는 구분 표시를 남긴다', async () => {
  const full = await fullContext()
  const summary = summarizeGroupContext(full, { mapId: 'map-coordinator' })
  const older = full.documentInstructions.filter((item) => ['outside', 'old-parent'].includes(item.id))
  const all = summarizeGroupContext({ ...full, documentInstructions: older }, { mapId: 'map-coordinator' })
  const outside = all.documentInstructions.find((item) => item.id === 'outside')
  assert.equal(outside.outsideGroup, true)
  assert.equal(outside.reasonCode, 'GROUP_DOCUMENT_INSTRUCTION_DISPATCH_FAILED', '상태만으로 구분되지 않는 실패 사유는 남긴다')
  assert.equal(outside.instructionPreview, undefined, '그룹 밖 문서의 과거 지시는 현재 지시로 취급하지 않는다')
  assert.equal(all.documentInstructions.find((item) => item.id === 'old-parent').parentMapId, 'map-old-coordinator')
  assert.equal(summary.documentInstructions.find((item) => item.id === 'a-24').parentMapId, undefined)
})

test('문서 담당 요약은 자기 문서가 대상인 지시·위임만 담고 다른 문서 수를 밝힌다', async () => {
  const full = await fullContext()
  const summary = summarizeGroupContext(full, { mapId: 'map-b' })
  assert.equal(summary.role, 'document')
  assert.deepEqual(summary.documentInstructions.map((item) => item.id), ['b-queued', 'b-old'])
  // 최종 보고 직전 재확인용으로 전달 시점의 유효 회신 대상만 준다(증거·기본값 등 나머지 필드는 제외).
  for (const item of summary.documentInstructions) assert.deepEqual(item.replyTarget, { mode: 'origin', effectiveConversationId: 'conversation-coordinator' })
  assert.match(summary.detail.role, /mapId=project\.coordinatorMapId로 다시 조회.*replyTarget은 지시 전달 시점의 유효 회신 대상/s)
  assert.deepEqual(summary.documentInstructionCounts.omittedByTarget, {})
  assert.equal(summary.documentInstructionCounts.otherDocuments, full.documentInstructions.length - 2)
  assert.deepEqual(summary.delegations, [])
  assert.equal(summary.delegationCounts.otherDocuments, 1)
  assert.equal(summary.documents.length, full.documents.length, '문서 경계 판단용 문서 현황은 모두 유지한다')
  assert.deepEqual(summary.guide, full.guide)
  const unknown = summarizeGroupContext(full, { mapId: 'map-not-in-group' })
  assert.equal(unknown.role, 'group')
  assert.equal(unknown.mapId, null)
  assert.equal(unknown.documentInstructionCounts.total, full.documentInstructions.length)
  const coordinatorDelegation = summarizeGroupContext(full, {}).delegations[0]
  assert.deepEqual(Object.keys(coordinatorDelegation).sort(), ['coordinationOnly', 'createdAt', 'id', 'mapId', 'parentMapId', 'state', 'targetCardId'])
})
