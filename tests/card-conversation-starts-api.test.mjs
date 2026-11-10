import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { storageApi, fixture } from './helpers/storage-api-harness.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'
import { cardConversationStartHash, cardConversationStartId } from '../server/lib/cardConversationStarts.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(action, label) {
  for (let i = 0; i < 120; i++) { const result = await action(); if (result) return result; await pause(50) }
  assert.fail(label)
}

test('자기 카드 대화 인계는 원문·권한·중복 방지·원격 호출 중 편집·재시작과 연결 실패 복구를 보장한다', { timeout: 90_000 }, async (t) => {
  const dispatches = new Map(), creates = [], calls = []
  // AionUi가 대화 조회에 돌려줄 실제 Claude 계정. 빈 값은 기본 계정이고, 없는 대화는 확인하지 못한 경우다.
  const actualAccounts = new Map()
  let releaseCreate, enteredCreate
  const entered = new Promise((resolve) => { enteredCreate = resolve })
  const held = new Promise((resolve) => { releaseCreate = resolve })
  let loseResponse = false, rejectNext = false, configSource = 'snapshot', accountsAvailable = true
  const remote = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    calls.push({ url, method: req.method })
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: status < 400, data })) }
    if (url === '/api/agents/management') return send([{ id: 'claude', name: 'Claude', backend: 'claude', installed: true, enabled: true,
      available_models: { available_models: [{ value: 'opus', name: 'Opus' }] },
      ...(accountsAvailable ? { claude_accounts: [{ id: 'default', number: 1, label: '회사' }, { id: 'acct-2', number: 2, label: '개인' }] } : {}) }])
    if (url === '/api/mcp/servers') return send([{ id: 'mnp', name: 'MindNProgress', enabled: true }])
    if (url === '/api/internal/external-conversation-dispatches' && req.method === 'POST') {
      if (rejectNext) {
        rejectNext = false
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: { code: 'EXTERNAL_DISPATCH_INVALID' } }))
        return
      }
      creates.push(body)
      const dispatch = { operationId: body.operationId, conversationId: `next-${creates.length}`, state: 'starting' }
      dispatches.set(body.operationId, dispatch)
      if (creates.length === 1) { enteredCreate(); await held }
      if (loseResponse) { res.destroy(); return }
      return send(dispatch, 202)
    }
    const conversation = url.match(/^\/api\/conversations\/([^/]+)$/)
    if (conversation && actualAccounts.has(decodeURIComponent(conversation[1]))) {
      const id = decodeURIComponent(conversation[1]), account = actualAccounts.get(id)
      return send({ id, extra: account ? { claude_account_id: account } : {} })
    }
    const match = url.match(/^\/api\/internal\/external-conversation-dispatches\/([^/]+)$/)
    if (match) { const record = dispatches.get(decodeURIComponent(match[1])); return send(record ?? {}, record ? 200 : 404) }
    if (url.endsWith('/runtime-config')) return send({ model: { value: 'opus', source: configSource },
      mode: { value: 'acceptEdits', source: configSource }, thought_level: { value: 'max', source: configSource } })
    if (url === '/api/internal/conversation-runtimes/active') return send({ conversations: [] })
    return send([])
  })
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => remote.close(resolve)))
  const api = await storageApi(t, { documents: 2,
    env: { MNP_AIONUI_URL: `http://127.0.0.1:${remote.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '600000' },
    seed: async ({ data, ids }) => {
      const map = fixture(ids[0])
      map.nodes[0].data.aiConversationId = 'previous'
      map.nodes[0].data.aiConversations = [{ conversationId: 'previous', homeMachineId: 'isolated-storage',
        agent: { id: 'claude', label: 'Claude' }, model: { id: 'opus', label: 'Opus' },
        mode: { id: 'acceptEdits', label: '편집 허용' }, thoughtLevel: { id: 'max', label: '최대' },
        skills: [{ id: 'session-message', label: '대화 전달' }], mcpServers: [{ id: 'mnp', label: 'MnP' }],
        workspace: 'C:/Git/Example', startedBy: { id: 'user-editor', label: '김용민' } }]
      for (const [index, id] of [[1, 'other-owner'], [2, 'busy'], [3, 'ref']]) map.nodes[index].data.aiConversationId = id
      map.nodes[3].data.reference = { mapId: ids[1], nodeId: 'card-0' }
      await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
      await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify([
        { mapId: ids[0], cardId: 'card-0', conversationId: 'previous', homeMachineId: 'isolated-storage', startedBy: 'user-editor' },
        ...[[1, 'other-owner'], [2, 'busy'], [3, 'ref']].map(([index, conversationId]) => ({
          mapId: ids[0], cardId: `card-${index}`, conversationId, homeMachineId: 'isolated-storage', startedBy: index === 1 ? 'user-second' : 'user-editor',
        })),
      ]))
      // 위임·그룹 지시용 '그 외' 계정 정책이 있어도 인계는 호출한 현재 대화와 같은 계정을 쓴다.
      await writeFile(path.join(data, '_ai-claude-account-policy.json'), JSON.stringify({
        version: 1, machines: { 'isolated-storage': { others: 'acct-2' } } }))
      await writeFile(path.join(data, '_group-document-instructions.json'), JSON.stringify([{
        id: 'instruction-busy', parentMapId: ids[0], parentCardId: 'card-2', parentConversationId: 'busy',
        targetMapId: ids[1], targetCardId: 'card-0', state: 'delivered', targetConversationId: 'child',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }, {
        // 다시 처리되지 않는 failed 지시(예: AionCore 재시작으로 중단)는 이전 대화의 인계를 막지 않는다.
        id: 'instruction-failed', parentMapId: ids[0], parentCardId: 'card-0', parentConversationId: 'previous',
        targetMapId: ids[1], targetCardId: 'card-0', state: 'failed', reasonCode: 'GROUP_DOCUMENT_INSTRUCTION_INTERRUPTED',
        dispatchState: 'recovery_required', targetConversationId: 'child-failed',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]))
    },
  })
  const [mapId] = api.ids
  const endpoint = `/api/maps/${mapId}/cards/card-0/ai-conversation-starts`
  const headers = (id = 'previous') => ({ 'X-MNP-AI-Conversation-Id': id, 'X-MNP-AI-Map-Id': mapId, 'X-MNP-AI-Card-Id': 'card-0' })
  const request = { requestId: 'handoff:one', predecessorConversationId: 'previous',
    newConversation: { agentId: 'claude', modelId: 'opus', modeId: 'acceptEdits', thoughtLevelId: 'max' },
    initialMessage: '  인계 원문\r\n\r\n마지막 줄\n ', decisionReason: '사용자 요청', approvalEvidence: '같은 카드의 새 대화로 인계를 요청했습니다.' }
  const start = (input = request, id = 'previous') => api.call(endpoint, 'POST', input, headers(id))
  const result = (requestId = request.requestId, id = 'previous') => start({ requestId, resultOnly: true }, id)
  const currentMap = async () => (await api.call(`/api/maps/${mapId}`)).body.map
  assert.equal((await fetch(api.base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status, 401)
  assert.equal((await api.call(endpoint, 'POST', request)).body.code, 'CARD_CONVERSATION_START_OWN_CARD_REQUIRED')
  assert.equal((await api.call(endpoint.replace('card-0', 'card-1'), 'POST', request, headers())).body.code, 'CARD_CONVERSATION_START_OWN_CARD_REQUIRED')
  assert.equal((await start({ ...request, predecessorConversationId: 'forged' })).body.code, 'CARD_CONVERSATION_START_PREDECESSOR_MISMATCH')
  assert.equal((await start({ ...request, machineId: 'other-machine' })).status, 403)
  for (const [index, id, code] of [[1, 'other-owner', 'CARD_CONVERSATION_START_FORBIDDEN'],
    [2, 'busy', 'CARD_CONVERSATION_START_WORK_BUSY'], [3, 'ref', 'CARD_CONVERSATION_START_ORIGINAL_CARD_REQUIRED']]) {
    const response = await api.call(endpoint.replace('card-0', `card-${index}`), 'POST',
      { ...request, predecessorConversationId: id }, { ...headers(id), 'X-MNP-AI-Card-Id': `card-${index}` })
    assert.equal(response.body.code, code, JSON.stringify(response.body))
  }
  rejectNext = true
  const rejected = { ...request, requestId: 'handoff:rejected' }
  await start(rejected)
  const failure = await until(async () => {
    const response = (await result(rejected.requestId)).body
    return response.state === 'failed' && response
  }, '생성 전 거절을 확정하지 못했습니다.')
  assert.equal(failure.reasonCode, 'EXTERNAL_DISPATCH_INVALID')
  assert.equal(creates.length, 0)
  assert.match(failure.nextStep, /새 requestId/)
  // 새 대화의 AI 종류에서 고를 수 없는 Claude 계정은 생성 전에 거절한다.
  const invalidAccount = { ...request, requestId: 'handoff:invalid-account',
    newConversation: { ...request.newConversation, claudeAccountId: 'missing-account' } }
  await start(invalidAccount)
  const invalidAccountFailure = await until(async () => {
    const response = (await result(invalidAccount.requestId)).body
    return response.state === 'failed' && response
  }, '고를 수 없는 Claude 계정을 거절하지 못했습니다.')
  assert.equal(invalidAccountFailure.reasonCode, 'CARD_CONVERSATION_START_CLAUDE_ACCOUNT_INVALID')
  assert.equal(creates.length, 0)
  for (const [currentAccount, available] of [['missing-account', true], ['acct-2', false]]) {
    actualAccounts.set('previous', currentAccount)
    accountsAvailable = available
    const requestId = `handoff:inherit-${currentAccount}`
    await start({ ...request, requestId })
    const rejected = await until(async () => {
      const response = (await result(requestId)).body
      return response.state === 'failed' && response
    }, '상속 계정이 불명확한 요청을 거절하지 못했습니다.')
    assert.equal(rejected.reasonCode, 'CARD_CONVERSATION_START_CLAUDE_ACCOUNT_INVALID')
    assert.equal(creates.length, 0, '확인하지 못한 상속 계정을 기본 계정으로 바꿔 생성하지 않는다')
  }
  actualAccounts.clear()
  accountsAvailable = true
  const accepted = await start()
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body))
  await entered
  assert.equal((await currentMap()).nodes[0].data.aiConversationId, 'previous')
  assert.equal((await start({ ...request, initialMessage: '다른 요청' })).body.code, 'CARD_CONVERSATION_START_IDEMPOTENCY_CONFLICT')
  assert.equal((await start({ ...request, requestId: 'second-request' })).body.code, 'CARD_CONVERSATION_START_PENDING')
  assert.equal((await start()).body.repeated, true)
  // 원격 응답을 기다리는 동안 콘텐츠 쓰기가 막히지 않고, 인계 저장이 최신 본문을 보존한다.
  const before = await currentMap(), edited = structuredClone(before)
  edited.nodes[0].data.description = '인계 중 사용자가 저장한 최신 본문'
  assert.equal((await api.call(`/api/maps/${mapId}/content-patch`, 'PATCH', {
    baseVersion: before.version, patch: createMapContentPatch(before, edited),
  })).status, 200)
  releaseCreate()
  await until(async () => (await result()).body.state === 'observing', '생성 접수 상태를 확인하지 못했습니다.')
  assert.equal((await currentMap()).nodes[0].data.aiConversationId, 'previous', 'starting을 전달 완료로 간주하지 않는다')
  assert.ok(creates[0].instruction.endsWith(request.initialMessage))
  assert.match(creates[0].instruction, /attributionToken: `/)
  assert.deepEqual(creates[0].create.enabledSkillIds, ['session-message'])
  assert.deepEqual(creates[0].create.mcpIds, ['mnp'])
  // AionUi에서 현재 대화를 확인하지 못하고 연결 기록에도 계정이 없으면 기본 계정을 쓴다. 기본 계정은 생성 요청에 넣지 않는다.
  assert.equal(creates[0].create.claudeAccountId, undefined)
  dispatches.get(creates[0].operationId).state = 'running'
  dispatches.get(creates[0].operationId).turnId = 'turn-one'
  await until(async () => (await result()).body.state === 'linked', '첫 실행 확인 뒤 대표 연결이 전환되지 않았습니다.')
  const linked = (await result()).body
  assert.equal(linked.runtimeConfig.model.source, 'snapshot')
  assert.equal(linked.requestedConfig.claudeAccountId, 'default')
  assert.equal(linked.requestedConfig.claudeAccount.number, 1)
  assert.equal(linked.initialMessage.sha256, cardConversationStartHash(request.initialMessage))
  assert.doesNotMatch(JSON.stringify(linked), /attributionToken|사용자 요청으로|첫 메시지 원문/)
  configSource = 'runtime'
  await until(async () => (await result()).body.state === 'ready', '실행 설정 확인이 완료되지 않았습니다.')
  const map = await currentMap()
  assert.equal(map.nodes[0].data.aiConversationId, 'next-1')
  assert.equal(map.nodes[0].data.description, edited.nodes[0].data.description)
  assert.deepEqual(map.nodes[0].data.aiConversations.map((item) => item.conversationId).sort(), ['next-1', 'previous'])
  assert.equal(creates.length, 1)
  // 응답 유실과 서버 재시작 후에도 이미 생성한 대화만 조회해 이어간다.
  loseResponse = true
  // 두 번째 인계는 MCP 도구로 다른 Claude 계정을 명시한다.
  const second = { ...request, requestId: 'handoff:two', predecessorConversationId: 'next-1',
    newConversation: { ...request.newConversation, claudeAccountId: 'acct-2' } }
  // 새 대화가 받은 귀속 토큰으로 문맥에 붙고 실제 MCP 도구로 후속 인계를 접수한다.
  const client = new Client({ name: 'card-handoff-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...api.env, AIONUI_CONVERSATION_ID: 'next-1' }, stderr: 'pipe' })
  try {
    await client.connect(transport)
    const invoke = async (name, args) => {
      const response = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
      assert.notEqual(response.isError, true, JSON.stringify(response))
      return JSON.parse(response.content.find((part) => part.type === 'text').text)
    }
    const attributionToken = creates[0].instruction.match(/attributionToken: `([^`]+)`/)[1]
    await invoke('get_context', { mapId, cardId: 'card-0', editorId: 'user-editor', attributionToken })
    const previousResult = await invoke('start_card_conversation', { mapId, cardId: 'card-0', requestId: request.requestId, resultOnly: true })
    assert.equal(previousResult.conversationId, 'next-1')
    const accepted = await invoke('start_card_conversation', { mapId, cardId: 'card-0', ...second })
    assert.equal(accepted.requestId, second.requestId)
  } finally { await client.close() }
  await until(async () => (await result(second.requestId, 'next-1')).body.state === 'observing', '유실된 응답을 조회로 복구하지 못했습니다.')
  assert.equal(creates[1].create.claudeAccountId, 'acct-2')
  Object.assign(dispatches.get(creates[1].operationId), { state: 'completed', turnId: 'turn-two' })
  await until(async () => (await result(second.requestId, 'next-1')).body.state === 'ready', '재시작 이후 인계 복구 실패')
  assert.equal(creates.length, 2)
  assert.equal((await currentMap()).nodes[0].data.aiConversationId, 'next-2')
  // 카드 연결 저장 실패 시 생성된 원격 대화만 재조회한다. 전문 재전송은 하지 않는다.
  const failedWrite = await api.barrier('_ai-conversation-origins.json', 'writeFile', { prefix: true, fail: true })
  const third = { ...request, requestId: 'handoff:three', predecessorConversationId: 'next-2' }
  actualAccounts.set('next-2', 'acct-2')
  await start(third, 'next-2')
  await failedWrite.reached; failedWrite.release()
  await until(async () => (await result(third.requestId, 'next-2')).body.conversationId === 'next-3', '실패한 연결 단계 복구 실패')
  // 계정을 생략하면 호출한 현재 대화(next-2)의 실제 계정을 쓴다.
  assert.equal(creates[2].create.claudeAccountId, 'acct-2')
  await api.restart()
  Object.assign(dispatches.get(creates[2].operationId), { state: 'running', turnId: 'turn-three' })
  await until(async () => (await result(third.requestId, 'next-2')).body.state === 'ready', '세 번째 인계 완료 실패')
  assert.equal(creates.length, 3)
  assert.equal((await currentMap()).nodes[0].data.aiConversationId, 'next-3')
  const fourth = { ...request, requestId: 'handoff:four', predecessorConversationId: 'next-3' }
  actualAccounts.set('next-3', '')
  await start(fourth, 'next-3')
  await until(async () => (await result(fourth.requestId, 'next-3')).body.state === 'observing', '네 번째 생성 상태 확인 실패')
  // 연결 기록(acct-2)보다 AionUi가 반환한 현재 대화의 실제 계정(기본 계정)을 우선한다.
  assert.equal(creates[3].create.claudeAccountId, undefined)
  const latest = await currentMap(), switched = structuredClone(latest)
  switched.nodes[0].data.aiPrimaryConversationId = 'previous'
  const changed = await api.call(`/api/maps/${mapId}/content-patch`, 'PATCH', {
    baseVersion: latest.version, patch: createMapContentPatch(latest, switched),
  })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  Object.assign(dispatches.get(creates[3].operationId), { state: 'running', turnId: 'turn-four' })
  await until(async () => (await result(fourth.requestId, 'next-3')).body.reasonCode === 'CARD_CONVERSATION_START_REPRESENTATIVE_CHANGED', '대표 변경 충돌 확인 실패')
  assert.equal((await currentMap()).nodes[0].data.aiPrimaryConversationId, 'previous', '도중에 바뀐 담당 연결을 덮어쓰지 않는다')
  assert.equal(creates.length, 4)
  assert.ok(!calls.some(({ url }) => /stop|cancel|interrupt|archive/.test(url)), '이전 대화를 중지하거나 보관하지 않는다')
})

test('단일 Claude 계정에서 default를 명시해도 유효한 인계로 접수한다', { timeout: 30_000 }, async (t) => {
  const requestId = 'single-default'
  const api = await storageApi(t, { documents: 1, seed: async ({ data, ids }) => {
    const map = fixture(ids[0])
    map.nodes[0].data.aiConversationId = 'previous'
    await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
    await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify([{
      mapId: ids[0], cardId: 'card-0', conversationId: 'previous', homeMachineId: 'isolated-storage', startedBy: 'user-editor',
    }]))
  }, mockAion: (url) => {
    if (url === '/api/agents/management') return [{ id: 'claude', name: 'Claude', backend: 'claude', enabled: true, installed: true,
      available_models: { available_models: [{ value: 'opus', name: 'Opus' }] } }]
    if (url.includes('/external-conversation-dispatches')) return {
      operationId: cardConversationStartId('user-editor', 'map-bench-0', 'card-0', requestId), conversationId: 'successor', state: 'starting',
    }
    return []
  } })
  const endpoint = `/api/maps/${api.ids[0]}/cards/card-0/ai-conversation-starts`
  const headers = { 'X-MNP-AI-Conversation-Id': 'previous', 'X-MNP-AI-Map-Id': api.ids[0], 'X-MNP-AI-Card-Id': 'card-0' }
  await api.call(endpoint, 'POST', { requestId, predecessorConversationId: 'previous',
    newConversation: { agentId: 'claude', modelId: 'opus', claudeAccountId: 'default' },
    initialMessage: '기본 계정 인계 검증', decisionReason: '사용자 요청', approvalEvidence: '기본 계정으로 인계 요청' }, headers)
  const result = await until(async () => {
    const response = (await api.call(endpoint, 'POST', { requestId, resultOnly: true }, headers)).body
    assert.notEqual(response.state, 'failed', JSON.stringify(response))
    return response.state === 'observing' && response
  }, '기본 계정 인계를 생성하지 못했습니다.')
  assert.equal(result.requestedConfig.claudeAccountId, 'default')
  assert.equal(result.conversationId, 'successor')
  assert.equal((await api.read('_card-conversation-starts.json'))[0].payload.create.claudeAccountId, undefined)
})

test('문서 영구 삭제 시 완료된 인계 요청 원문과 처리 기록도 함께 삭제한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 1, seed: async ({ data, ids }) => {
    await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify({ ...fixture(ids[0]), trashedAt: new Date().toISOString() }))
    await writeFile(path.join(data, '_card-conversation-starts.json'), JSON.stringify([{
      id: `ccs:${'a'.repeat(64)}`, mapId: ids[0], cardId: 'card-0', requestId: 'cleanup', state: 'ready',
      input: { initialMessage: '영구 삭제할 인계 원문' }, createdAt: new Date().toISOString(),
    }]))
  } })
  const deleted = await api.call('/api/maps/trash', 'DELETE', { mapIds: api.ids })
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  assert.deepEqual(await api.read('_card-conversation-starts.json'), [])
})
