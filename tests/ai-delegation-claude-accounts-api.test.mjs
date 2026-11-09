import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'

test('실제 위임 도구는 명시 계정을 정책보다 우선하고 생략·중복·잘못된 선택과 인계 경계를 보존한다', { timeout: 60_000 }, async t => {
  const creates = []
  const dispatches = new Map()
  let accounts = [{ id: 'default', number: 1, label: '회사 Team' }, { id: 'personal', number: 2, label: '개인 Max' }]
  const remote = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost').pathname
    const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
    if (url === '/api/agents/management') return send([
      { id: 'claude', name: 'Claude Code', backend: 'claude', installed: true, enabled: true,
        available_models: { available_models: [{ value: 'opus', name: 'Opus' }] }, claude_accounts: accounts },
      { id: 'codex', name: 'Codex', backend: 'codex', installed: true, enabled: true,
        available_models: { available_models: [{ value: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }] } },
    ])
    if (url === '/api/internal/external-conversation-dispatches/capabilities') return send({ schemaVersion: 3, explicitCompletionAfterInterruption: true, historyOnlyReports: true })
    if (url === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      creates.push(body)
      const dispatch = { operationId: body.operationId, conversationId: `child-${creates.length}`, state: 'running', turnId: `turn-${creates.length}` }
      dispatches.set(body.operationId, dispatch)
      return send(dispatch, 202)
    }
    if (url.startsWith('/api/internal/external-conversation-dispatches/')) {
      const dispatch = dispatches.get(decodeURIComponent(url.split('/').at(-1)))
      return send(dispatch ?? {}, dispatch ? 200 : 404)
    }
    if (url.startsWith('/api/conversations/')) return send({ id: url.split('/')[3], type: 'acp', extra: { agent_id: 'claude', current_model_id: 'opus' },
      runtime: { state: 'idle', is_processing: false, pending_confirmations: 0 } })
    return send([])
  })
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => remote.close(resolve)))
  const policy = { version: 1, machines: { 'isolated-storage': { others: 'personal' } } }
  const api = await storageApi(t, { documents: 2,
    env: { MNP_AIONUI_URL: `http://127.0.0.1:${remote.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '600000' },
    seed: async ({ data, ids }) => {
      const map = fixture(ids[0])
      map.nodes[0].data.aiConversationId = 'parent'
      map.nodes[0].data.aiConversations = [{ conversationId: 'parent', homeMachineId: 'isolated-storage',
        agent: { id: 'claude', label: 'Claude Code' }, model: { id: 'opus', label: 'Opus' },
        skills: [], mcpServers: [], claudeAccountId: 'default', startedBy: { id: 'user-editor', label: '김용민' } }]
      await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
      await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify([
        { mapId: ids[0], cardId: 'card-0', conversationId: 'parent', homeMachineId: 'isolated-storage', startedBy: 'user-editor' },
      ]))
      await writeFile(path.join(data, '_ai-claude-account-policy.json'), JSON.stringify(policy))
      await writeFile(path.join(data, '_map-order.json'), JSON.stringify({ version: 1,
        items: [{ type: 'group', id: 'group-accounts' }], groups: [{ id: 'group-accounts', name: '계정 검증 그룹', mapIds: ids }] }))
      await mkdir(path.join(data, '_group-projects'), { recursive: true })
      await writeFile(path.join(data, '_group-projects/group-accounts.json'), JSON.stringify({ version: 1,
        coordinatorMapId: ids[0], sources: [], objective: '계정 전달 검증', instructions: '' }))
    },
  })
  const [mapId, targetMapId] = api.ids
  const currentMap = async id => (await api.call(`/api/maps/${id}`)).body.map
  const endpoint = `/api/maps/${mapId}/ai-delegations`
  const origin = { 'X-MNP-AI-Conversation-Id': 'parent', 'X-MNP-AI-Map-Id': mapId, 'X-MNP-AI-Card-Id': 'card-0' }
  const request = async (card, account = {}) => ({ targetCardId: `card-${card}`, strategy: 'new',
    instruction: '계정 선택을 검증하는 조사만 수행하세요.', decisionReason: '사용자가 지정한 계정으로 조사 요청',
    sourceRevision: (await currentMap(mapId)).version, idempotencyKey: `account:card-${card}`,
    newConversation: { agentId: 'claude', modelId: 'opus', ...account } })
  const client = new Client({ name: 'delegation-claude-account-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...api.env, AIONUI_CONVERSATION_ID: 'parent' }, stderr: 'pipe' })
  try {
    await client.connect(transport)
    const invoke = async (name, args) => {
      const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
      assert.notEqual(result.isError, true, JSON.stringify(result))
      return JSON.parse(result.content.find(part => part.type === 'text').text)
    }
    await invoke('get_context', { mapId, cardId: 'card-0', editorId: 'user-editor' })
    const tools = await client.listTools()
    for (const name of ['delegate_ai_work', 'send_group_document_instruction']) {
      const schema = tools.tools.find(tool => tool.name === `mindnprogress_${name}`).inputSchema.properties.newConversation
      assert.ok(schema.properties.claudeAccountNumber)
      assert.ok(schema.properties.claudeAccountId)
    }
    const first = await request(1, { claudeAccountNumber: 1 })
    const delegated = await invoke('delegate_ai_work', { mapId, workType: 'review', ...first })
    assert.equal(delegated.reasonCode, 'AI_DELEGATION_ACCEPTED', JSON.stringify(delegated))
    assert.equal(creates[0].create.claudeAccountId, undefined, '1번 기본 계정은 개인 계정 정책을 따르지 않는다.')
    assert.equal((await currentMap(mapId)).nodes[1].data.aiConversations.at(-1).claudeAccountId, 'default')
    const repeated = await invoke('delegate_ai_work', { mapId, workType: 'review', ...first })
    assert.equal(repeated.repeated, true)
    assert.equal(creates.length, 1)
    const changed = await api.call(endpoint, 'POST', { ...first, newConversation: { ...first.newConversation, claudeAccountNumber: 2 } }, origin)
    assert.equal(changed.status, 409)
    assert.equal(changed.body.reasonCode, 'AI_DELEGATION_IDEMPOTENCY_CONFLICT')
    for (const [card, account, expected] of [[2, { claudeAccountId: 'personal' }, 'personal'], [3, {}, 'personal']]) {
      await invoke('delegate_ai_work', { mapId, workType: 'review', ...await request(card, account) })
      assert.equal(creates.at(-1).create.claudeAccountId, expected)
      assert.equal((await currentMap(mapId)).nodes[card].data.aiConversations.at(-1).claudeAccountId, expected)
    }
    accounts = [{ id: 'personal', number: 1, label: '개인 Max' }, { id: 'default', number: 2, label: '회사 Team' }]
    await invoke('delegate_ai_work', { mapId, workType: 'review', ...await request(4, { claudeAccountNumber: 1 }) })
    assert.equal(creates.at(-1).create.claudeAccountId, 'personal', '순서 변경 후에는 실행 머신의 새 번호를 사용한다.')
    const countBeforeInvalid = creates.length
    for (const account of [{ claudeAccountId: 'missing' }, { claudeAccountNumber: 3 }, { claudeAccountNumber: 0 },
      { claudeAccountNumber: '1' }, { claudeAccountId: null }, { claudeAccountId: 'default', claudeAccountNumber: 1 },
      { agentId: 'codex', modelId: 'gpt-6.1-sol', claudeAccountNumber: 1 }]) {
      const invalid = await api.call(endpoint, 'POST', await request(10, account), origin)
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body))
      assert.equal(invalid.body.reasonCode, 'AI_DELEGATION_SELECTION_INVALID')
    }
    const resumed = await api.call(endpoint, 'POST', { ...await request(1, { claudeAccountNumber: 1 }),
      idempotencyKey: 'account:resume', strategy: 'resume', conversationId: 'child-1' }, origin)
    assert.equal(resumed.body.reasonCode, 'AI_DELEGATION_CLAUDE_ACCOUNT_REQUIRES_NEW')
    assert.equal(creates.length, countBeforeInvalid)
    accounts = undefined
    await invoke('delegate_ai_work', { mapId, workType: 'review', ...await request(5, { claudeAccountNumber: 1 }) })
    assert.equal(creates.at(-1).create.claudeAccountId, undefined)
    const invalidSingle = await api.call(endpoint, 'POST', await request(6, { claudeAccountNumber: 2 }), origin)
    assert.equal(invalidSingle.status, 400)
    accounts = [{ id: 'personal', number: 1, label: '개인 Max' }, { id: 'default', number: 2, label: '회사 Team' }]
    const groupRequest = { mapId, targetMapId, targetRevision: (await currentMap(targetMapId)).version,
      groupProjectVersion: 1, sourceRevision: (await currentMap(mapId)).version, strategy: 'new',
      instructionType: 'planning', approvalScope: 'analysis-only', approvalEvidence: '사용자가 회사 계정으로 조사를 요청했습니다.',
      instruction: '분석 결과를 정리하세요. 구현은 하지 마세요.', decisionReason: '문서 담당 대화 생성',
      idempotencyKey: 'account:group', newConversation: { agentId: 'claude', modelId: 'opus', claudeAccountNumber: 2 } }
    const groupResult = await invoke('send_group_document_instruction', { ...groupRequest, workType: 'other' })
    assert.equal(groupResult.reasonCode, 'GROUP_DOCUMENT_INSTRUCTION_DELIVERED', JSON.stringify(groupResult))
    assert.equal(creates.at(-1).operationId, 'gdi:account:group')
    assert.equal(creates.at(-1).create.claudeAccountId, undefined)
    const groupResume = await api.call(`/api/maps/${mapId}/group-document-instructions`, 'POST', {
      ...groupRequest, idempotencyKey: 'account:group-resume', strategy: 'resume', conversationId: 'child-6',
    }, origin)
    assert.equal(groupResume.body.reasonCode, 'GROUP_DOCUMENT_INSTRUCTION_CLAUDE_ACCOUNT_REQUIRES_NEW')
    assert.deepEqual(await api.read('_ai-claude-account-policy.json'), policy)
  } finally { await client.close() }
})
