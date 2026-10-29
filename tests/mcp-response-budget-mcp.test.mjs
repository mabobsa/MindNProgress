import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { knowledge, storageApi } from './helpers/storage-api-harness.mjs'
import { CONTEXT_RESPONSE_BUDGET_CHARS } from '../mcp/contextBudget.mjs'

// 문서 0: card-13이 card-1~12의 결과를 주요 선행 지식(reuse-first)으로 쓴다.
// 문서 1: card-5는 문서 0의 card-1을 가리키는 Ref이고, 저장본에는 예전 제목·설명 사본이 남아 있다.
async function seed({ data, ids }) {
  const heavyPath = path.join(data, `${ids[0]}.json`)
  const heavy = JSON.parse(await readFile(heavyPath, 'utf8'))
  heavy.edges.push(...Array.from({ length: 12 }, (_, i) => ({
    id: `knowledge-${i}`, source: `card-${i + 1}`, target: 'card-13', data: { relation: 'knowledge', knowledgePolicy: 'reuse-first' },
  })))
  // 선택 카드 자체는 짧게 두어, 선행 지식 원문이 먼저 빠지고 선택 카드 원문은 남는 순서를 확인한다.
  heavy.nodes.find((node) => node.id === 'card-13').data.sharedKnowledge = '선택 카드의 짧은 공유 지식'
  await writeFile(heavyPath, JSON.stringify(heavy))
  const referencePath = path.join(data, `${ids[1]}.json`)
  const withReference = JSON.parse(await readFile(referencePath, 'utf8'))
  const referenceCard = withReference.nodes.find((node) => node.id === 'card-5')
  referenceCard.data = { ...referenceCard.data, label: '예전 제목 (ref)', description: '저장본에 남은 예전 설명', reference: { mapId: ids[0], nodeId: 'card-1' } }
  await writeFile(referencePath, JSON.stringify(withReference))
}

test('실제 MCP의 get_context 예산 축소·get_card 회수 인자·update_card affected 정리', { timeout: 90000 }, async (t) => {
  const api = await storageApi(t, { documents: 2, seed })
  const client = new Client({ name: 'response-budget-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'), env: api.env, stderr: 'pipe' })
  t.after(async () => { await client.close() })
  await client.connect(transport)
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    const text = result.content.find((part) => part.type === 'text').text
    return { value: JSON.parse(text), chars: text.length }
  }
  const [heavyMapId, referenceMapId] = api.ids
  const attribution = { editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' }

  // 선행 지식이 많아 한도를 넘는 문맥은 규칙을 그대로 두고 데이터만 줄이며, 최종 응답 크기를 정확히 알린다.
  const { value: context, chars } = await invoke('get_context', { mapId: heavyMapId, cardId: 'card-13', ...attribution })
  assert.equal(context.contextSchemaVersion, '3.4')
  assert.ok(context.contextBudget, '예산을 넘는 focused 응답에는 contextBudget이 있어야 합니다.')
  assert.equal(context.contextBudget.returnedChars, chars)
  assert.equal(context.contextBudget.exceeded, false)
  assert.ok(chars <= CONTEXT_RESPONSE_BUDGET_CHARS, `응답 ${chars}자`)
  assert.ok(context.contextBudget.focusedChars > CONTEXT_RESPONSE_BUDGET_CHARS)
  assert.deepEqual(Object.keys(context).slice(1, 4), ['detailLevel', 'contextBudget', 'omitted'])
  assert.ok(context.guide.operationRules.length > 0)
  assert.ok(context.selection.taskLinks.startupInspection.instruction)
  assert.ok(context.selection.aiWorkCoordination.childDelegation.instruction)
  assert.ok(context.nextStep)
  const primary = context.selection.knowledgeSources.primary
  assert.equal(primary.length, 12, '모든 선행 지식 원천의 색인은 남는다')
  assert.equal(context.selection.card.data.description, '격리 환경의 시험 본문입니다. '.repeat(100), '선택 카드 원문은 마지막까지 남긴다')
  const omittedSourceIds = context.omitted.cardIds.knowledgeSourceSharedKnowledge
  assert.ok(omittedSourceIds.length > 0)

  // omitted.retrieval의 인자로 생략된 원천을 회수하면 색인의 길이와 같은 원문을 작게 받는다.
  const retrieval = context.omitted.retrieval.knowledgeSource
  assert.equal(retrieval.tool, 'mindnprogress_get_card')
  const { value: sourceCard, chars: sourceChars } = await invoke('get_card', { ...retrieval.arguments, cardId: omittedSourceIds[0] })
  assert.equal(sourceCard.card.data.sharedKnowledge, knowledge)
  assert.deepEqual(Object.keys(sourceCard.card.data).sort(), ['label', 'sharedKnowledge'])
  assert.equal(sourceCard.card.textIntegrity.sharedKnowledge.length,
    primary.find((entry) => entry.card.id === omittedSourceIds[0]).card.textIntegrity.sharedKnowledge.length)
  assert.ok(sourceCard.card.textIntegrity.description.sha256)
  assert.deepEqual(sourceCard.comments, [])
  assert.equal(sourceCard.commentsPage.limit, 0)
  assert.ok(sourceChars < 12000, `회수 응답 ${sourceChars}자`)
  // 인자를 주지 않은 get_card는 기존과 같다.
  const { value: fullCard } = await invoke('get_card', { mapId: heavyMapId, cardId: omittedSourceIds[0] })
  assert.equal(fullCard.card.data.description, '격리 환경의 시험 본문입니다. '.repeat(100))
  assert.equal(fullCard.commentsPage.limit, 20)

  // 예산 안의 문맥은 표기 없이 그대로다.
  const { value: small, chars: smallChars } = await invoke('get_context', { mapId: referenceMapId, cardId: 'card-6', ...attribution })
  assert.ok(smallChars <= CONTEXT_RESPONSE_BUDGET_CHARS, `작은 문맥 ${smallChars}자`)
  assert.equal(small.contextBudget, undefined)
  assert.equal(small.omitted, undefined)
  assert.equal(small.selection.card.data.sharedKnowledge, knowledge)

  // update_card affected: 저장본과 조회본의 Ref 투영 차이를 서버 조정으로 보고하지 않고 요청 카드를 중복하지 않는다.
  const { value: updated } = await invoke('update_card', { mapId: referenceMapId, cardId: 'card-6', responseMode: 'affected', data: { status: 'in-progress' } })
  assert.ok(updated.affectedCards.every((entry) => entry.card.id !== 'card-5'), JSON.stringify(updated.affectedCards))
  assert.ok(updated.affectedCards.every((entry) => entry.card.id !== 'card-6'))
  assert.equal(updated.card.data.status, 'in-progress')
  assert.deepEqual(updated.card.omittedFields, ['description', 'sharedKnowledge'])
  assert.equal(updated.card.textIntegrity.sharedKnowledge.length, knowledge.length)
  assert.equal(updated.omitted.retrieval.tool, 'mindnprogress_get_card')

  // Ref 카드를 직접 바꿔도 응답은 저장본의 예전 사본이 아니라 원본 투영값을 쓴다.
  const { value: referenceUpdated } = await invoke('update_card', { mapId: referenceMapId, cardId: 'card-5', responseMode: 'affected', data: { kind: 'task' } })
  assert.equal(referenceUpdated.card.data.label, '검증 카드 1 (ref)')
  assert.equal(referenceUpdated.card.data.kind, 'task')
  assert.equal(referenceUpdated.card.textIntegrity.description.length, '격리 환경의 시험 본문입니다. '.repeat(100).length)
  assert.ok(referenceUpdated.affectedCards.every((entry) => entry.card.id !== 'card-5'))
})

// 문서 0의 카드마다 긴 대기 메모(저장 한도 1,000자 안) 두 건을 두어 outline이 예산을 넘게 한다.
async function seedWaitingNotes({ data, ids }) {
  const file = path.join(data, `${ids[0]}.json`)
  const map = JSON.parse(await readFile(file, 'utf8'))
  for (const node of map.nodes) {
    node.data.waitingItems = [1, 2].map((index) => ({ id: `wait-${node.id}-${index}`, label: `외부 전달물 대기 ${index}`, resumeCondition: '전달물 수령 후 재개',
      since: '2026-10-01T00:00:00.000Z', note: `${node.id} 대기 메모 ${index}: 임시 리소스로 대체하지 않는다. `.repeat(30).slice(0, 990) }))
  }
  await writeFile(file, JSON.stringify(map))
}

test('실제 MCP의 get_document outline은 예산을 넘으면 줄이고 최종 응답 크기를 정확히 알린다', { timeout: 90000 }, async (t) => {
  const api = await storageApi(t, { documents: 1, seed: seedWaitingNotes })
  const client = new Client({ name: 'outline-budget-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'), env: api.env, stderr: 'pipe' })
  t.after(async () => { await client.close() })
  await client.connect(transport)
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    const text = result.content.find((part) => part.type === 'text').text
    return { value: JSON.parse(text), chars: text.length }
  }
  const [mapId] = api.ids
  const { value: outline, chars } = await invoke('get_document', { mapId, view: 'outline' })
  assert.ok(outline.responseBudget, '예산을 넘는 outline에는 responseBudget이 있어야 합니다.')
  assert.equal(outline.responseBudget.returnedChars, chars, 'MCP가 덧붙인 그룹 메타데이터까지 포함한 최종 크기여야 합니다.')
  assert.ok(chars <= 40000, `outline ${chars}자`)
  assert.equal(outline.responseBudget.exceeded, false)
  assert.ok(outline.responseBudget.appliedSteps.includes('waitingNotes'))
  assert.equal(outline.cards.length, 20)
  assert.equal(outline.cards.find((card) => card.id === 'card-3').parentId, 'card-0')
  // 회수 경로로 받은 대기 메모 원문은 줄이지 않은 원문이다.
  const retrieval = outline.omitted.retrieval.cardFields
  const { value: card } = await invoke(retrieval.tool.replace('mindnprogress_', ''), { ...retrieval.arguments, cardId: 'card-3', fields: ['waitingItems'] })
  assert.match(card.card.data.waitingItems[0].note, /임시 리소스로 대체하지 않는다/)
  assert.deepEqual(Object.keys(card.card.data).sort(), ['label', 'waitingItems'])
})

// 문서 0: card-3에 완료 위임 12건(결과 원문 포함), card-4에 복구가 필요한 위임 1건을 둔다. 최신 위임일수록 createdAt이 늦다.
const delegationResult = (index) => `위임 ${index}의 하위 결과 보고: 재시도 정책 점검 ${index}회차를 마쳤다. `.repeat(70)
async function seedDelegations({ data, ids }) {
  const [mapId] = ids
  const base = (id, extra) => ({ id, mapId, parentMapId: mapId, parentCardId: 'card-0', parentConversationId: 'conv-parent',
    parentHomeMachineId: 'isolated-storage', targetHomeMachineId: 'isolated-storage', ...extra })
  const delegations = Array.from({ length: 12 }, (_, index) => base(`delegation-card3-${String(index).padStart(2, '0')}`, {
    targetCardId: 'card-3', targetConversationId: `conv-card3-${index}`, state: 'completed', childStatus: 'completed', parentDispatchState: 'completed',
    createdAt: `2026-10-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`, updatedAt: `2026-10-${String(10 + index).padStart(2, '0')}T01:00:00.000Z`,
    decisionReason: '격리 검증용 완료 위임'.repeat(20), instructionPreview: '재시도 정책 점검 지시'.repeat(20), childResultSnapshot: delegationResult(index),
  }))
  delegations.push(base('delegation-card4-recovery', { targetCardId: 'card-4', targetConversationId: 'conv-card4', state: 'recovery-required',
    childStatus: 'running', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:30:00.000Z', childResultSnapshot: '복구 대기 위임의 중간 보고' }))
  await writeFile(path.join(data, '_ai-delegations.json'), JSON.stringify(delegations))
  // card-3의 접수 실패 두 건은 각각 다른 위임으로 재접수가 확인됐다.
  const failure = (id, delegationId, createdAt) => ({ id, kind: 'request-failure', state: 'request-failed', requestedDelegationId: `${id}-requested`,
    mapId, parentMapId: mapId, parentCardId: 'card-0', parentConversationId: 'conv-parent', targetCardId: 'card-3',
    parentHomeMachineId: 'isolated-storage', targetHomeMachineId: 'isolated-storage', strategy: 'new', phase: 'preflight', accepted: false,
    executionState: 'not-started', automaticRetry: false, status: 409, reasonCode: 'AI_DELEGATION_VERSION_CONFLICT', message: '문서 버전이 바뀌어 접수하지 못했습니다.',
    createdAt, updatedAt: createdAt, instructionHash: null, requestSummary: '재시도 정책 점검',
    resolution: { delegationId, method: 'confirmed-retry', at: createdAt, actorId: 'user-editor', note: '같은 업무의 재접수를 확인했습니다.' } })
  await writeFile(path.join(data, '_ai-delegation-request-failures.json'), JSON.stringify([
    failure('request-card3-latest', 'delegation-card3-11', '2026-10-21T12:00:00.000Z'),
    failure('request-card3-older', 'delegation-card3-05', '2026-10-15T12:00:00.000Z'),
  ]))
}

test('실제 MCP의 list_ai_delegations는 정리된 이력만 줄이고 delegationId로 원문을 회수한다', { timeout: 90000 }, async (t) => {
  const api = await storageApi(t, { documents: 1, seed: seedDelegations })
  const client = new Client({ name: 'delegation-budget-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'), env: api.env, stderr: 'pipe' })
  t.after(async () => { await client.close() })
  await client.connect(transport)
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    const text = result.content.find((part) => part.type === 'text').text
    return { value: JSON.parse(text), chars: text.length }
  }
  const [mapId] = api.ids
  await invoke('get_context', { mapId, cardId: 'card-0', editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' })
  const { value: history, chars } = await invoke('list_ai_delegations', { mapId, targetCardId: 'card-3', includeResult: true })
  assert.ok(history.responseBudget, `카드 이력이 예산을 넘어야 합니다(${chars}자).`)
  assert.equal(history.responseBudget.returnedChars, chars)
  assert.ok(chars <= 40000, `응답 ${chars}자`)
  assert.equal(history.delegations[0].id, 'delegation-card3-11', '최신순을 유지한다')
  assert.equal(history.delegations[0].result, delegationResult(11), '카드별 최신 이력은 결과를 남긴다')
  const omittedId = history.omitted.resultOmittedDelegationIds.at(-1)
  assert.ok(omittedId)
  // 생략된 결과는 delegationId로 한 건만, 줄이지 않고 받는다.
  const { value: single } = await invoke('list_ai_delegations', { ...history.omitted.retrieval.delegation.arguments, delegationId: omittedId })
  assert.equal(single.delegations.length, 1)
  assert.equal(single.responseBudget, undefined)
  assert.equal(single.delegations[0].result, delegationResult(Number(omittedId.slice(-2))))
  assert.equal(single.delegations[0].summary, undefined, '단건 조회는 요약하지 않는다')
  assert.match(single.delegations[0].decisionReason, /격리 검증용 완료 위임/, '세부 기록도 그대로 준다')
  // 단건 조회의 접수 실패는 그 위임에 연결된 기록만 준다. 카드 이력 조회에는 모두 있다.
  assert.deepEqual(history.requestFailures.map((item) => item.id), ['request-card3-latest', 'request-card3-older'])
  const { value: latest } = await invoke('list_ai_delegations', { mapId, delegationId: 'delegation-card3-11' })
  assert.deepEqual(latest.requestFailures.map((item) => [item.id, item.resolvedByDelegationId, item.retryVerification.state]),
    [['request-card3-latest', 'delegation-card3-11', 'confirmed']])
  // 문서 전체 조회에서도 복구가 필요한 위임은 그대로 둔다.
  const { value: all } = await invoke('list_ai_delegations', { mapId, includeResult: true })
  const recovery = all.delegations.find((item) => item.id === 'delegation-card4-recovery')
  assert.equal(recovery.recovery.recoveryAvailable, true)
  assert.equal(recovery.result, '복구 대기 위임의 중간 보고')
  assert.equal(recovery.summary, undefined)
})

// 문서 0: card-3은 설명 30,000자·공유 지식 14,000자(저장 한도 15,000자 안)에 상세 댓글 45건이 있고, card-5~9에 상세 댓글 30건이 더 있다.
const longComment = (mapId, nodeId, index) => ({ id: `comment-${nodeId}-${String(index).padStart(2, '0')}`, mapId, nodeId, contentFormat: 'summary-detail',
  summary: `[결과] ${nodeId} ${index}번째 검증`, text: `[결과] ${nodeId} ${index}번째 검증`, detail: `${nodeId} ${index}번째 상세 근거. `.repeat(200).slice(0, 2500),
  parentId: null, resolvedAt: null, resolvedBy: null, reactions: {}, createdAt: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString(),
  author: { id: 'user-editor', name: '김용민' } })
async function seedCardRead({ data, ids }) {
  const [mapId] = ids
  const mapPath = path.join(data, `${mapId}.json`)
  const map = JSON.parse(await readFile(mapPath, 'utf8'))
  const heavy = map.nodes.find((node) => node.id === 'card-3')
  heavy.data = { ...heavy.data, description: '큰 카드의 요구사항 설명. '.repeat(2400).slice(0, 30000), sharedKnowledge: '큰 카드의 결론. '.repeat(2000).slice(0, 14000) }
  await writeFile(mapPath, JSON.stringify(map))
  const comments = [...Array.from({ length: 45 }, (_, index) => longComment(mapId, 'card-3', index)),
    ...Array.from({ length: 30 }, (_, index) => longComment(mapId, `card-${5 + (index % 5)}`, index))]
  await writeFile(path.join(data, '_comments', `${mapId}.json`), JSON.stringify(comments))
}

test('실제 MCP의 get_card·list_comments는 예산을 넘으면 댓글 페이지와 큰 원문을 줄이고 빠짐없이 회수하게 한다', { timeout: 120000 }, async (t) => {
  const api = await storageApi(t, { documents: 1, seed: seedCardRead })
  const client = new Client({ name: 'card-read-budget-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'), env: api.env, stderr: 'pipe' })
  t.after(async () => { await client.close() })
  await client.connect(transport)
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    const text = result.content.find((part) => part.type === 'text').text
    return { value: JSON.parse(text), chars: text.length }
  }
  const [mapId] = api.ids
  await invoke('get_context', { mapId, cardId: 'card-0', editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' })
  const stored = JSON.parse(await readFile(path.join(api.data, `${mapId}.json`), 'utf8')).nodes.find((node) => node.id === 'card-3').data
  const { value: card, chars } = await invoke('get_card', { mapId, cardId: 'card-3', commentLimit: 50, includeCommentDetail: true })
  assert.ok(card.responseBudget, `get_card가 예산을 넘어야 합니다(${chars}자).`)
  assert.equal(card.responseBudget.returnedChars, chars, 'MCP가 덧붙인 그룹 메타데이터까지 포함한 최종 크기여야 합니다.')
  assert.ok(chars <= 40000, `get_card ${chars}자`)
  assert.deepEqual(card.card.omittedFields, ['description'], '큰 원문 하나만 생략한다')
  assert.equal(card.card.data.sharedKnowledge, stored.sharedKnowledge)
  assert.equal(card.card.textIntegrity.description.length, stored.description.length)
  // 생략한 원문은 fields로 그대로 회수하고 textIntegrity와 맞는지 확인한다.
  const { value: description } = await invoke('get_card', { ...card.omitted.retrieval.cardFields.arguments, fields: ['description'] })
  assert.equal(description.card.data.description, stored.description)
  assert.equal(description.card.textIntegrity.description.sha256, card.card.textIntegrity.description.sha256)
  // 댓글은 get_card가 준 앞쪽부터 retrieval.comments로 이어 받으면 45건을 빠짐없이 최신순으로 받는다.
  const received = card.comments.map((item) => item.id)
  let next = card.omitted.retrieval.comments?.arguments
  assert.ok(next, '댓글 페이지를 줄였으면 이어 받을 인자가 있어야 합니다.')
  while (next) {
    const { value: page, chars: pageChars } = await invoke('list_comments', next)
    assert.ok(pageChars <= 40000, `list_comments ${pageChars}자`)
    assert.ok(page.comments.every((item) => item.detail?.length === 2500), '반환한 댓글의 상세는 줄이지 않는다')
    received.push(...page.comments.map((item) => item.id))
    next = page.hasMore ? { ...next, offset: page.nextOffset } : null
  }
  assert.deepEqual(received, Array.from({ length: 45 }, (_, index) => `comment-card-3-${String(44 - index).padStart(2, '0')}`))
  // 문서 전체 상세 조회도 페이지를 줄이고 nextOffset으로 75건을 모두 받는다.
  let offset = 0
  const all = []
  for (let guard = 0; guard < 20; guard++) {
    const { value: page, chars: pageChars } = await invoke('list_comments', { mapId, offset, limit: 100, includeDetail: true })
    assert.ok(pageChars <= 40000, `문서 전체 list_comments ${pageChars}자`)
    if (offset === 0) assert.ok(page.responseBudget && page.limit < 100 && page.limit === page.comments.length)
    all.push(...page.comments.map((item) => item.id))
    if (!page.hasMore) break
    offset = page.nextOffset
  }
  assert.equal(new Set(all).size, 75)
  assert.equal(all.length, 75)

  // add·move·delete affected 응답의 서버 조정 카드는 상태 요약만 준다.
  const isSummary = (entry) => Object.keys(entry.card.data).every((key) => ['label', 'kind', 'status', 'progress', 'isWork'].includes(key)) && Array.isArray(entry.card.changedKeys)
  const { value: added } = await invoke('add_card', { mapId, parentCardId: 'card-3', data: { label: '완료된 하위 검증', status: 'done', progress: 100, isWork: true } })
  assert.ok(added.affectedCards.length > 0, JSON.stringify(added.affectedCards))
  assert.ok(added.affectedCards.every(isSummary), JSON.stringify(added.affectedCards))
  assert.ok(added.affectedCards.every((entry) => entry.card.id !== added.card.id))
  assert.match(added.omitted.fields['affectedCards[].card'], /상태 요약과 바뀐 키/)
  assert.equal(added.card.data.label, '완료된 하위 검증', '추가한 카드는 그대로 준다')
  const { value: moved, chars: movedChars } = await invoke('move_card', { mapId, cardId: 'card-3', newParentCardId: 'card-4' })
  assert.deepEqual(moved.card.omittedFields?.sort(), ['description', 'sharedKnowledge'], '이동한 카드의 바뀌지 않은 큰 필드는 생략한다')
  assert.equal(moved.card.textIntegrity.description.sha256, card.card.textIntegrity.description.sha256)
  assert.ok(moved.affectedCards.every(isSummary))
  assert.equal(moved.omitted.retrieval.arguments.cardId, 'card-3')
  assert.ok(movedChars < 10000, `move_card ${movedChars}자`)
  const { value: deleted } = await invoke('delete_card', { mapId, cardId: added.card.id })
  assert.deepEqual(deleted.deletedCardIds, [added.card.id])
  assert.ok(deleted.affectedCards.every(isSummary))
})

// 문서 85개 중 6개는 그룹(총괄 문서 0)에 속한다. 총괄 문서는 소속 문서 5개에 지시 40건을 보냈고 가장 최근 1건은 응답 대기(delivered)다.
const E2E_GROUP_ID = 'group-e2e-budget'
const e2eInstructionResponse = (index) => `${index}번 응답 원문: 합의한 마감일은 D-${index}이다. `.repeat(30)
async function seedDocumentGroups({ data, ids }) {
  await writeFile(path.join(data, '_map-order.json'), JSON.stringify({ version: 1, items: [{ type: 'group', id: E2E_GROUP_ID }, ...ids.slice(6).map((id) => ({ type: 'map', id }))],
    groups: [{ id: E2E_GROUP_ID, name: '격리 그룹', mapIds: ids.slice(0, 6) }] }))
  await mkdir(path.join(data, '_group-projects'), { recursive: true })
  await writeFile(path.join(data, '_group-projects', `${E2E_GROUP_ID}.json`), JSON.stringify({ version: 1, coordinatorMapId: ids[0], source: 'manual', sourceVersion: 'manual-1',
    objective: '격리 검증 그룹 목표', instructions: '격리 검증 그룹 지침', updatedAt: '2026-10-27T00:00:00.000Z', updatedBy: { id: 'user-editor', name: '김용민' } }))
  const instructions = Array.from({ length: 40 }, (_, index) => {
    const state = index === 0 ? 'delivered' : 'replied'
    const createdAt = new Date(Date.UTC(2026, 9, 28) - index * 3_600_000).toISOString()
    return { id: `e2e-instruction-${String(index).padStart(2, '0')}`, groupId: E2E_GROUP_ID, groupProjectVersion: 1, parentMapId: ids[0], parentCardId: 'card-0',
      parentCardLabel: '검증 카드 0', parentConversationId: 'conv-coordinator', targetMapId: ids[1 + (index % 5)], targetCardId: 'card-0', targetCardLabel: '검증 카드 0',
      strategy: 'new', instructionType: 'planning', approvalScope: 'document', instructionPreview: `${index}번 지시 미리보기`, instructionHash: 'a'.repeat(64),
      approvalEvidencePreview: '승인 근거 미리보기', approvalEvidenceHash: 'b'.repeat(64), decisionReason: '격리 검증 지시', state, reasonCode: `GROUP_DOCUMENT_INSTRUCTION_${state.toUpperCase()}`,
      message: '지시 상태를 기록했습니다.', createdAt, updatedAt: createdAt, deliveredAt: createdAt, instruction: `${index}번 지시 원문. `.repeat(250), approvalEvidence: '사용자 승인 근거. '.repeat(40),
      ...(state === 'replied' ? { response: e2eInstructionResponse(index), responseHash: 'c'.repeat(64), repliedAt: createdAt } : {}) }
  })
  await writeFile(path.join(data, '_group-document-instructions.json'), JSON.stringify(instructions))
}

test('실제 MCP의 list_documents·list_group_document_instructions는 예산을 넘으면 문서·대기 지시를 두고 줄인다', { timeout: 180000 }, async (t) => {
  const api = await storageApi(t, { documents: 85, seed: seedDocumentGroups })
  const client = new Client({ name: 'list-budget-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'), env: api.env, stderr: 'pipe' })
  t.after(async () => { await client.close() })
  await client.connect(transport)
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    const text = result.content.find((part) => part.type === 'text').text
    return { value: JSON.parse(text), chars: text.length }
  }
  const [coordinatorMapId] = api.ids
  await invoke('get_context', { mapId: coordinatorMapId, cardId: 'card-0', editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' })
  const { value: documents, chars } = await invoke('list_documents', {})
  assert.ok(documents.responseBudget, `문서 목록이 예산을 넘어야 합니다(${chars}자).`)
  assert.equal(documents.responseBudget.returnedChars, chars)
  assert.ok(chars <= 40000, `list_documents ${chars}자`)
  assert.equal(documents.maps.length, 85, '문서 항목은 빼지 않는다')
  assert.equal(documents.documentGroups, undefined, '문서 항목과 같은 값인 documentGroups를 생략한다')
  const grouped = documents.maps.filter((map) => map.group?.id === E2E_GROUP_ID)
  assert.equal(grouped.length, 6, '그룹 정보는 문서 항목에 남는다')
  assert.ok(grouped.every((map) => map.groupProject?.coordinatorMapId === coordinatorMapId))
  assert.equal(grouped.find((map) => map.id === coordinatorMapId).groupProject.role, 'coordinator')
  assert.ok(documents.maps.every((map) => map.updatedBy === undefined || Object.keys(map.updatedBy).every((key) => key === 'id' || key === 'name')))

  const { value: history, chars: historyChars } = await invoke('list_group_document_instructions', { mapId: coordinatorMapId, includeContent: true })
  assert.ok(history.responseBudget, `지시 목록이 예산을 넘어야 합니다(${historyChars}자).`)
  assert.equal(history.responseBudget.returnedChars, historyChars)
  assert.ok(historyChars <= 40000, `list_group_document_instructions ${historyChars}자`)
  const delivered = history.instructions.find((item) => item.id === 'e2e-instruction-00')
  assert.equal(delivered.state, 'delivered')
  assert.equal(delivered.instruction, '0번 지시 원문. '.repeat(250), '응답 대기 지시는 원문까지 그대로 둔다')
  // 대상 문서 5개의 최신 정리된 지시(1~5번)는 목록에 남는다.
  for (let index = 1; index <= 5; index++) assert.ok(history.instructions.some((item) => item.id === `e2e-instruction-0${index}`), `${index}번`)
  const omittedId = history.omitted.contentOmittedInstructionIds.at(-1)
  assert.ok(omittedId)
  const { value: single } = await invoke('list_group_document_instructions', { ...history.omitted.retrieval.instruction.arguments, instructionId: omittedId })
  assert.equal(single.responseBudget, undefined, '한 건 조회는 줄이지 않는다')
  assert.equal(single.instructions[0].response, e2eInstructionResponse(Number(omittedId.slice(-2))))
})
