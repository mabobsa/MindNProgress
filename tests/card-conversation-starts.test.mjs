import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCardConversationStartPrompt, cardConversationStartHash, cardConversationStartView,
  cardConversationStartId, createCardConversationStarts, isCardConversationWorkerWorkspace, normalizeCardConversationStart } from '../server/lib/cardConversationStarts.mjs'

const input = { requestId: 'handoff:1', predecessorConversationId: 'previous',
  newConversation: { agentId: 'claude', modelId: 'opus', mcpIds: ['b', 'a', 'b'] },
  initialMessage: '  첫 메시지 원문\r\n\r\n인계 내용입니다.\n ',
  decisionReason: '사용자 요청으로 인계', approvalEvidence: '사용자가 같은 카드의 새 대화로 인계하라고 요청했습니다.' }

test('인계 전문은 공백·줄바꿈까지 보존하고 요청 설정은 안정적으로 정규화한다', () => {
  const normalized = normalizeCardConversationStart(input)
  assert.equal(normalized.initialMessage, input.initialMessage)
  assert.deepEqual(normalized.newConversation.mcpIds, ['a', 'b'])
  // Claude 계정은 선택 항목이다. 생략하면 서버가 호출한 현재 대화와 같은 계정을 정한다.
  assert.equal(normalized.newConversation.claudeAccountId, undefined)
  assert.equal(normalizeCardConversationStart({ ...input, newConversation: { ...input.newConversation, claudeAccountId: ' acct-2 ' } })
    .newConversation.claudeAccountId, 'acct-2')
  const record = { id: 'operation', requestId: input.requestId, mapId: 'map', cardId: 'card', startedBy: 'editor',
    predecessorConversationId: 'previous', input: normalized, state: 'reserved' }
  const prompt = buildCardConversationStartPrompt(record, 'secret-attribution-token')
  assert.ok(prompt.endsWith(input.initialMessage))
  assert.match(prompt, /get_context/)
  const view = cardConversationStartView({ ...record, payload: { instruction: prompt }, attributionKey: 'secret-key' })
  assert.equal(view.initialMessage.sha256, cardConversationStartHash(input.initialMessage))
  assert.doesNotMatch(JSON.stringify(view), /secret-attribution-token|secret-key|인계 내용입니다/)
})

test('결과 조회는 첫 메시지 없이 가능하고 잘못된 요청·초과 본문은 자르지 않고 거절한다', () => {
  assert.deepEqual(normalizeCardConversationStart({ requestId: 'handoff:1', resultOnly: true }), { requestId: 'handoff:1', resultOnly: true })
  for (const patch of [{ requestId: '../bad' }, { initialMessage: '가'.repeat(100001) }, { initialMessage: '  ' },
    { predecessorConversationId: '../bad' }, { newConversation: {} }, { newConversation: { ...input.newConversation, enabledSkillIds: 'skill' } },
    { machineId: 'bad machine' }, { approvalEvidence: '' }, { resultOnly: 'true' },
    { newConversation: { ...input.newConversation, claudeAccountId: 'a'.repeat(121) } },
    { newConversation: { ...input.newConversation, claudeAccountId: 2 } }]) {
    assert.throws(() => normalizeCardConversationStart({ ...input, ...patch }), { code: 'CARD_CONVERSATION_START_INVALID' })
  }
})

test('worker 루트와 하위 폴더는 차단하며 통합·형제 경로는 구분한다', () => {
  const roots = ['C:/Git/Fork1', '/Users/nhn/worker']
  for (const workspace of ['c:\\git\\fork1', 'C:/Git/Fork1/Assets', 'C:/Git/Fork2/../Fork1', '/Users/nhn/worker/Assets']) {
    assert.equal(isCardConversationWorkerWorkspace(workspace, roots), true, workspace)
  }
  for (const workspace of ['C:/Git/Main', 'C:/Git/Fork10', 'C:/Git/Fork1/../Main', '/Users/other/worker', null]) {
    assert.equal(isCardConversationWorkerWorkspace(workspace, roots), false, String(workspace))
  }
})

test('인수 확인과 겹친 이전 실행 설정 조회로 담당을 전환하지 않고 확인 후 다시 검증한다', async () => {
  const id = cardConversationStartId('editor', 'map', 'card', input.requestId)
  const records = new Map([[id, { id, requestId: input.requestId, mapId: 'map', cardId: 'card', startedBy: 'editor',
    input, predecessorConversationId: 'previous', conversationId: 'successor', state: 'observing',
    acceptanceRequired: true, attemptedAt: new Date().toISOString(), requestedConfig: { modelId: 'opus', thoughtLevelId: 'xhigh' } }]])
  let firstConfigRead, releaseFirstRead, promotions = 0, level = 'high'
  const reading = new Promise(resolve => { firstConfigRead = resolve })
  const firstResponse = new Promise(resolve => { releaseFirstRead = resolve })
  const pending = []
  const config = value => ({ model: { value: 'opus', source: 'runtime' }, thought_level: { value, source: 'runtime' } })
  const starts = createCardConversationStarts({ records, mutate: async (_map, action) => action(), persist: async () => {},
    validate: async () => {}, promote: async () => { promotions++ }, background: action => {
      const promise = Promise.resolve().then(action); pending.push(promise); return promise
    }, call: async (_machine, url) => {
      if (url.includes('/external-conversation-dispatches/')) return { operationId: id, conversationId: 'successor', turnId: 'turn', state: 'running' }
      if (firstConfigRead) { const notify = firstConfigRead; firstConfigRead = null; notify(); return firstResponse }
      return config(level)
    } })
  const query = (conversationId = 'previous', acceptHandoff = false) => starts.submit({ userId: 'editor', mapId: 'map', cardId: 'card',
    source: { mapId: 'map', cardId: 'card', conversationId, startedBy: 'editor' } }, { requestId: input.requestId, resultOnly: true, acceptHandoff })
  await query(); await reading
  await query('successor', true)
  releaseFirstRead(config('xhigh'))
  await pending.at(-1)
  assert.equal(promotions, 0, '인수 전에 시작한 설정 조회는 전환 근거로 사용하지 않는다')
  await query(); await pending.at(-1)
  assert.equal(promotions, 0, '인수 후 실제 설정이 다르면 담당을 유지한다')
  level = 'xhigh'
  await query(); await pending.at(-1)
  assert.equal(promotions, 1)
  assert.equal(records.get(id).state, 'ready')
})
