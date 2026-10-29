import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDocumentListBudget, DOCUMENT_LIST_BUDGET_STEP_IDS, DOCUMENT_LIST_RESPONSE_BUDGET_CHARS } from '../mcp/documentListBudget.mjs'
import { applyInstructionListBudget, INSTRUCTION_LIST_BUDGET_STEP_IDS, INSTRUCTION_LIST_RESPONSE_BUDGET_CHARS, instructionNeedsAttention } from '../mcp/instructionListBudget.mjs'

const text = (label, length) => `${label} `.repeat(Math.ceil(length / (label.length + 1))).slice(0, length)
const id = (index) => `map-${String(index).padStart(4, '0')}`

// /api/maps 응답과 같은 형태. 그룹 문서는 documentGroups에도 같은 그룹 필드가 한 번 더 들어간다.
const author = (index) => ({ id: `user-${index % 3}`, name: `작성자 ${index % 3}`, email: `user${index % 3}@example.com`, role: 'editor', publicAccess: false })
function documentList(count, { groupSize = 6 } = {}) {
  const maps = Array.from({ length: count }, (_, index) => {
    const groupIndex = Math.floor(index / groupSize)
    const grouped = groupIndex % 2 === 0
    const coordinator = groupIndex * groupSize
    return {
      id: id(index), title: `문서 ${index}`, color: 'teal', nodeCount: 20, rootProgress: index % 100, rootStatus: 'in-progress', waitingCount: index % 3, version: 3,
      updatedAt: '2026-10-28T00:00:00.000Z', updatedBy: author(index), createdAt: '2026-10-01T00:00:00.000Z', createdBy: author(index + 1),
      trashedAt: null, trashedBy: null, archivedAt: null, archiveReason: '', lifecycleVersion: 1, predecessorMapIds: [], successorMapIds: [], reconstructionId: null,
      ...(grouped ? {
        group: { id: `group-${groupIndex}`, name: `그룹 ${groupIndex}` }, groupMembership: index === coordinator ? 'coordinator' : 'member',
        groupProject: { groupId: `group-${groupIndex}`, name: `그룹 ${groupIndex}`, coordinatorMapId: id(coordinator), role: index === coordinator ? 'coordinator' : 'document', contextTool: 'mindnprogress_get_group_context' },
      } : {}),
    }
  })
  return {
    maps,
    documentLayout: { version: 1, items: maps.map((map) => ({ type: 'map', id: map.id })), groups: [] },
    documentGroups: maps.filter((map) => map.group).map((map) => ({ mapId: map.id, group: map.group, groupMembership: map.groupMembership, groupProject: map.groupProject })),
    documentGroupsStatus: 'available', lifecycleCounts: { archived: 2, trashed: 1 },
  }
}

test('list_documents: 예산 안의 응답은 같은 객체를 그대로 반환한다', () => {
  const value = documentList(10)
  assert.equal(applyDocumentListBudget(value), value)
})

test('list_documents: 문서 항목은 모두 두고 같은 값인 documentGroups부터 줄인다', () => {
  const value = documentList(55)
  const before = structuredClone(value)
  const result = applyDocumentListBudget(value)
  assert.deepEqual(value, before, '입력 응답을 변경하지 않는다')
  assert.deepEqual(Object.keys(result).slice(0, 3), ['responseBudget', 'omitted', 'maps'])
  assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length)
  assert.ok(result.responseBudget.returnedChars <= DOCUMENT_LIST_RESPONSE_BUDGET_CHARS)
  assert.equal(result.responseBudget.exceeded, false)
  assert.equal(result.maps.length, 55)
  assert.deepEqual(result.maps.map((map) => map.id), before.maps.map((map) => map.id))
  assert.equal(result.responseBudget.appliedSteps[0], 'documentGroups')
  assert.equal(result.documentGroups, undefined)
  assert.equal(result.omitted.counts.documentGroups, before.documentGroups.length)
  assert.match(result.omitted.fields.documentGroups, /maps\[\]\.group·groupMembership·groupProject/)
  // 그룹 정보는 문서 항목에 그대로 있다.
  for (const map of result.maps.filter((item) => item.group)) assert.deepEqual(map.group, before.maps.find((item) => item.id === map.id).group)
  assert.deepEqual(result.documentLayout, before.documentLayout)
  assert.deepEqual(result.lifecycleCounts, before.lifecycleCounts)
})

test('list_documents: 단계마다 작성자·groupProject·빈 필드를 줄이고 정보가 다르면 documentGroups를 남긴다', () => {
  const value = documentList(70)
  value.documentGroups[0].groupMembership = 'different'
  const result = applyDocumentListBudget(value)
  assert.ok(result.documentGroups, '문서 항목과 값이 다르면 생략하지 않는다')
  assert.ok(!result.responseBudget.appliedSteps.includes('documentGroups'))
  assert.ok(result.responseBudget.appliedSteps.includes('authors'))
  const map = result.maps[0]
  assert.deepEqual(map.createdBy, { id: 'user-1', name: '작성자 1' })
  assert.equal(map.updatedBy.email, undefined)
  if (result.responseBudget.appliedSteps.includes('groupProject')) {
    assert.deepEqual(map.groupProject, { coordinatorMapId: id(0), role: 'coordinator' })
    assert.match(result.omitted.fields['maps[].groupProject'], /mindnprogress_get_group_context\(groupId\)/)
    assert.deepEqual(result.omitted.retrieval.group, { tool: 'mindnprogress_get_group_context', arguments: { groupId: '<groupId>' } })
  }
  assert.deepEqual(result.omitted.retrieval.users, { tool: 'mindnprogress_list_users', arguments: {} })
})

test('list_documents: 아주 많으면 문서별 최소 필드만 남기고, 그래도 넘으면 exceeded로 알린다', () => {
  const many = applyDocumentListBudget(documentList(220))
  assert.ok(many.responseBudget.appliedSteps.includes('minimalDocuments'))
  assert.equal(many.maps.length, 220)
  assert.deepEqual(Object.keys(many.maps[0]).sort(), ['group', 'groupMembership', 'groupProject', 'id', 'nodeCount', 'rootProgress', 'rootStatus', 'title', 'updatedAt', 'version', 'waitingCount'])
  assert.equal(many.maps[0].trashedAt, undefined)
  assert.deepEqual(many.omitted.retrieval.document, { tool: 'mindnprogress_get_document', arguments: { mapId: '<mapId>', view: 'outline' } })
  const huge = applyDocumentListBudget(documentList(900))
  assert.equal(huge.maps.length, 900, '문서 항목은 빼지 않는다')
  assert.equal(huge.responseBudget.exceeded, true)
})

test('list_documents: 여러 규모에서 최종 크기가 예산을 지키고 단계 순서를 따른다', () => {
  let budgeted = 0
  for (let count = 40; count <= 300; count += 13) {
    const result = applyDocumentListBudget(documentList(count))
    if (!result.responseBudget) continue
    budgeted++
    const applied = result.responseBudget.appliedSteps
    assert.deepEqual(applied, DOCUMENT_LIST_BUDGET_STEP_IDS.filter((step) => applied.includes(step)), `${count}건`)
    assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length, `${count}건`)
    assert.equal(result.maps.length, count)
    if (!result.responseBudget.exceeded) assert.ok(result.responseBudget.returnedChars <= DOCUMENT_LIST_RESPONSE_BUDGET_CHARS, `${count}건`)
  }
  assert.ok(budgeted >= 15)
})

// list_group_document_instructions 응답과 같은 형태. 최신순이다.
const hours = (index) => new Date(Date.UTC(2026, 9, 28, 12) - index * 3_600_000).toISOString()
function instruction(index, { target, state = 'replied', content = 3000 } = {}) {
  const createdAt = hours(index)
  return {
    id: `instruction-${String(index).padStart(3, '0')}`, groupId: 'group-a', groupProjectVersion: 3, parentMapId: 'map-coord', parentCardId: 'root', parentCardLabel: '총괄',
    parentConversationId: 'conv-parent', parentHomeMachineId: 'machine-a', targetMapId: target, targetCardId: 'root', targetCardLabel: '루트', targetRevision: 2, sourceRevision: 3,
    targetHomeMachineId: 'machine-a', requestedConversationId: null, strategy: 'new', instructionType: 'execute', approvalScope: 'document',
    instructionPreview: text(`지시 ${index} 미리보기`, 240), instructionHash: 'a'.repeat(64), approvalEvidencePreview: text(`승인 ${index} 미리보기`, 240), approvalEvidenceHash: 'b'.repeat(64),
    decisionReason: text('판단 사유', 200), state, reasonCode: `GROUP_DOCUMENT_INSTRUCTION_${state.toUpperCase()}`, message: '지시 상태를 기록했습니다.',
    startedBy: { id: 'user-editor', name: '김용민' }, createdAt, updatedAt: createdAt, targetConversationId: `conv-${target}`, dispatchOperationId: `op-${index}`, dispatchState: 'done',
    turnId: `turn-${index}`, deliveredAt: createdAt, mapVersion: 3, linkError: null, replyTarget: { mode: 'parent', effectiveConversationId: 'conv-parent' },
    conversationAssessmentId: 'c'.repeat(64),
    ...(state === 'replied' ? { response: text(`응답 ${index}`, 600), responseHash: 'd'.repeat(64), repliedAt: createdAt } : {}),
    ...(content ? { instruction: text(`지시 ${index} 원문`, content), approvalEvidence: text('승인 근거', 500) } : {}),
  }
}
const instructionList = (instructions) => ({ ok: true, reasonCode: 'GROUP_DOCUMENT_INSTRUCTION_LISTED', message: '그룹 문서 지시 내역을 조회했습니다.', parentMapId: 'map-coord', instructions })

test('지시 목록: 전달·응답 대기 지시만 판단이 필요한 지시로 본다', () => {
  for (const state of ['queued', 'delivered']) assert.equal(instructionNeedsAttention({ state }), true, state)
  for (const state of ['replied', 'failed', 'expired']) assert.equal(instructionNeedsAttention({ state }), false, state)
})

test('지시 목록: 대기 지시와 문서별 최신 지시는 두고 오래된 지시의 원문부터 줄인다', () => {
  const items = [instruction(0, { target: 'map-a', state: 'delivered' }), ...Array.from({ length: 14 }, (_, index) => instruction(index + 1, { target: `map-${'abc'[index % 3]}` }))]
  const value = instructionList(items)
  const before = structuredClone(value)
  const result = applyInstructionListBudget(value, { mapId: 'map-coord', includeContent: true })
  assert.deepEqual(value, before)
  assert.deepEqual(Object.keys(result).slice(0, 6), ['ok', 'reasonCode', 'message', 'parentMapId', 'responseBudget', 'omitted'])
  assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length)
  assert.ok(result.responseBudget.returnedChars <= INSTRUCTION_LIST_RESPONSE_BUDGET_CHARS)
  assert.equal(result.responseBudget.appliedSteps[0], 'olderSettledContent')
  assert.ok(!result.responseBudget.appliedSteps.includes('latestSettledContent'), '최신 지시의 원문까지 줄일 필요는 없다')
  assert.deepEqual(result.instructions[0], before.instructions[0], '전달 대기 지시는 그대로 둔다')
  // 문서별 최신 지시(정리된 지시 중 처음 나오는 것)는 원문을 남긴다.
  for (const target of ['map-a', 'map-b', 'map-c']) {
    const latest = result.instructions.find((item) => item.targetMapId === target && item.state === 'replied')
    assert.equal(latest.instruction, before.instructions.find((item) => item.id === latest.id).instruction, target)
  }
  const older = result.instructions.at(-1)
  assert.equal(older.instruction, undefined)
  assert.equal(older.contentOmitted, true)
  assert.equal(older.instructionHash, 'a'.repeat(64))
  assert.ok(result.omitted.contentOmittedInstructionIds.includes(older.id))
  assert.deepEqual(result.omitted.retrieval.instruction.arguments, { mapId: 'map-coord', instructionId: '<instructionId>', includeContent: true })
  assert.deepEqual(result.omitted.retrieval.targetDocument.arguments, { mapId: 'map-coord', targetMapId: '<targetMapId>', includeContent: true })
})

test('지시 목록: 많으면 요약 뒤 오래된 지시부터 빼되 오래전 지시가 최신인 문서의 지시는 남긴다', () => {
  // map-z의 유일한 지시는 가장 오래됐지만 그 문서의 최신(현재) 지시다.
  const items = [...Array.from({ length: 200 }, (_, index) => instruction(index, { target: `map-${index % 4}`, content: 0 })), instruction(500, { target: 'map-z', content: 0 })]
  const result = applyInstructionListBudget(instructionList(items), { mapId: 'map-coord' })
  const applied = result.responseBudget.appliedSteps
  assert.deepEqual(applied, INSTRUCTION_LIST_BUDGET_STEP_IDS.filter((step) => applied.includes(step)))
  assert.ok(applied.includes('olderSettledRemoved'))
  assert.ok(!applied.includes('latestSettledRemoved'))
  assert.ok(result.responseBudget.returnedChars <= INSTRUCTION_LIST_RESPONSE_BUDGET_CHARS)
  assert.ok(result.instructions.some((item) => item.targetMapId === 'map-z'), '오래된 문서의 현재 지시를 남긴다')
  for (const target of ['map-0', 'map-1', 'map-2', 'map-3']) assert.ok(result.instructions.some((item) => item.id === `instruction-${String(Number(target.at(-1))).padStart(3, '0')}`), target)
  const removed = Object.values(result.omitted.removedByTarget).reduce((sum, count) => sum + count, 0)
  assert.equal(removed, result.omitted.counts.removedSettledInstructions)
  assert.equal(result.instructions.length + removed, 201)
  const summary = result.instructions.find((item) => item.summary)
  assert.equal(summary.instructionPreview, undefined)
  assert.equal(summary.decisionReason, undefined)
  assert.ok(summary.id && summary.state && summary.targetMapId && summary.responseHash)
})

test('지시 목록: 여러 규모에서 최종 크기가 예산을 지킨다', () => {
  let budgeted = 0
  for (let count = 10; count <= 260; count += 17) for (const content of [0, 2500]) {
    const items = Array.from({ length: count }, (_, index) => instruction(index, { target: `map-${index % 7}`, content, state: index % 11 === 5 ? 'expired' : 'replied' }))
    const result = applyInstructionListBudget(instructionList(items), { mapId: 'map-coord', includeContent: content > 0 })
    if (!result.responseBudget) continue
    budgeted++
    assert.equal(result.responseBudget.returnedChars, JSON.stringify(result).length, `${count}건`)
    assert.ok(result.responseBudget.returnedChars <= INSTRUCTION_LIST_RESPONSE_BUDGET_CHARS, `${count}건·원문 ${content}: ${result.responseBudget.returnedChars}자`)
    assert.equal(result.responseBudget.exceeded, false)
  }
  assert.ok(budgeted >= 15)
})
