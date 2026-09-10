import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkDoorayResponseBrowser } from './helpers/doorayResponseBrowser.mjs'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const item = { key: 'comment:post1:comment1', kind: 'mention-comment', projectId: 'p1', postId: 'post1', commentId: 'comment1',
  subject: '베팅 표시 수정', excerpt: '표시를 확인해 주세요.', url: 'https://nhnent.dooray.com/project/posts/post1#comment-comment1', acknowledgedAt: null }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check, timeout = 20_000) {
  const deadline = Date.now() + timeout
  let latest
  while (Date.now() < deadline) {
    try { latest = await check(); if (latest) return latest } catch { /* 테스트 서버 준비 대기 */ }
    await pause(60)
  }
  assert.fail(`제한 시간 안에 응답이 준비되지 않았습니다. ${JSON.stringify(latest)}`)
}

test('로그인 계정의 실제 서버 API에서 제안 접수·삭제 초기화·새 제안을 연결한다', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dooray-response-api-'))
  const operations = new Map()
  const created = []
  const paths = []
  const mcpNames = ['MindNProgress', 'unityMCP', 'docker-dooray-mcp', 'pptx-mcp']
  const requiredMcps = mcpNames.map((name, index) => ({ id: `required-mcp-${index}`, name, enabled: true }))
  const requiredMcpIds = requiredMcps.map((server) => server.id)
  const extraByConversation = new Map([['existing-chat', { mcp_server_ids: ['kept-mcp'], mcp_servers: ['existing-mcp'], session_mcp_servers: [{ name: 'session-tool', command: 'test-only' }] }]])
  const mcpReloads = []
  let conversationFailure = null
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    paths.push(`${request.method} ${url.pathname}`)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const send = (result, status = 200, dooray = false) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(dooray ? { header: { isSuccessful: true }, result } : { success: status < 400, data: result }))
    }
    if (url.pathname === '/project/v1/projects/p1/posts/post1') return send({ subject: item.subject, body: { content: '베팅 금액은 천 단위 구분자를 표시합니다.' } }, 200, true)
    if (url.pathname === '/project/v1/projects/p1/posts/post1/logs') return send([{ id: 'comment1', type: 'comment', body: { content: '김용민님, 금액 표시를 확인해 주세요.' } }], 200, true)
    if (url.pathname === '/project/v1/projects') return send([], 200, true)
    if (url.pathname === '/api/agents/management') return send([{ id: 'test-agent', name: '검증 AI', installed: true, enabled: true,
      available_models: { current_model_id: 'test-model', available_models: [{ id: 'test-model', name: '검증 모델' }] } }])
    if (url.pathname === '/api/mcp/servers') return send([...requiredMcps, { id: 'kept-mcp', name: 'existing-mcp', enabled: true }])
    if (url.pathname === '/api/providers' || url.pathname === '/api/skills') return send([])
    if (url.pathname === '/api/conversations' && request.method === 'POST') {
      created.push(body)
      assert.deepEqual(body.assistant.conversation_overrides.mcp_ids, requiredMcpIds)
      assert.deepEqual(body.extra.selected_mcp_server_ids, requiredMcpIds)
      extraByConversation.set(`created-${created.length}`, { mcp_server_ids: requiredMcpIds, mcp_servers: mcpNames })
      return send({ id: `created-${created.length}`, name: body.name }, 201)
    }
    const mcpReload = url.pathname.match(/^\/api\/conversations\/([^/]+)\/mcp-servers$/)
    if (mcpReload && request.method === 'PUT') {
      assert.equal(body.sync_aionui_catalog, true)
      mcpReloads.push(mcpReload[1])
      extraByConversation.set(mcpReload[1], { mcp_server_ids: body.mcp_server_ids,
        mcp_servers: body.mcp_server_ids.map((id) => [...requiredMcps, { id: 'kept-mcp', name: 'existing-mcp' }].find((server) => server.id === id)?.name),
        session_mcp_servers: body.session_mcp_servers })
      return send({ id: mcpReload[1], extra: extraByConversation.get(mcpReload[1]) })
    }
    const messageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/)
    if (messageMatch) {
      const op = [...operations.values()].reverse().find((entry) => entry.targetConversationId === messageMatch[1])
      if (!op) return send({ items: [] })
      const result = op.operationId.includes('-route-') ? { requestId: op.operationId, action: 'direct', mapId: 'map-test', cardId: 'task1', conversationId: 'existing-chat',
        requestSummary: '베팅 금액 표시 확인', reason: '해당 업무 URL이 연결된 담당 카드' } : { requestId: op.operationId, proposal: '금액 포맷터를 확인하고 경계값을 검증하는 작업을 제안합니다.' }
      return send({ items: [{ position: 'left', type: 'text', content: { content: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` } }] })
    }
    const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (conversation?.[1] === 'existing-chat' && conversationFailure) {
      response.writeHead(conversationFailure.status, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify({ success: false, error: { code: conversationFailure.code } }))
    }
    if (conversation) return send({ id: conversation[1], name: '베팅 표시 대화', runtime: { state: 'idle', isProcessing: false, pendingConfirmations: 0 },
      extra: { agent_id: 'test-agent', current_model_id: 'test-model', ...extraByConversation.get(conversation[1]) } })
    if (url.pathname === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
      assert.equal(body.strategy, 'resume')
      assert.equal(body.actorConversationId, body.targetConversationId)
      assert.match(body.instruction, /제안 작성만 허용/)
      assert.match(body.instruction, /조회·검색/)
      for (const id of requiredMcpIds) assert.ok(extraByConversation.get(body.targetConversationId).mcp_server_ids.includes(id))
      operations.set(body.operationId, body)
      return send({ conversationId: body.targetConversationId, operationId: body.operationId, state: 'completed' }, 202)
    }
    const dispatch = url.pathname.match(/^\/api\/internal\/external-conversation-dispatches\/([^/]+)$/)
    if (dispatch && operations.has(dispatch[1])) return send({ conversationId: operations.get(dispatch[1]).targetConversationId, operationId: dispatch[1], state: 'completed' })
    if (url.pathname === '/api/internal/conversation-runtimes/active') return send({ items: [] })
    return send({}, 404)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
  await mkdir(path.join(directory, '_dooray-mentions'), { recursive: true })
  await writeFile(path.join(directory, '_dooray-mentions', 'user-admin.json'), JSON.stringify({ items: [item] }))
  await writeFile(path.join(directory, 'map-test.json'), JSON.stringify({ id: 'map-test', title: '홀덤 UI', version: 1,
    nodes: [{ id: 'root1', position: { x: 0, y: 0 }, data: { label: 'UI', kind: 'root', description: '', progress: 0, status: 'planned' } },
      { id: 'task1', position: { x: 200, y: 0 }, data: { label: '베팅', kind: 'task', description: '금액 표시 정책', progress: 0, status: 'planned',
        taskUrl: item.url, aiConversationId: 'existing-chat', aiConversations: [{ conversationId: 'existing-chat', skills: [], mcpServers: [] }] } }],
    edges: [{ id: 'edge1', source: 'root1', target: 'task1' }] }))
  const port = 20_000 + Math.floor(Math.random() * 8000)
  const baseUrl = `http://127.0.0.1:${port}`
  const password = 'response-test-password'
  const server = spawn(process.execPath, ['server/index.mjs'], { cwd: projectDirectory, stdio: 'ignore', env: {
    ...process.env, MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
    MNP_ADMIN_PASSWORD: password, MNP_DOORAY_API_KEY: 'test-only', MNP_DOORAY_BASE_URL: upstreamUrl, MNP_AIONUI_URL: upstreamUrl,
  } })
  t.after(async () => {
    server.kill()
    await new Promise((resolve) => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve) })
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok)
  const endpoint = `${baseUrl}/api/integrations/dooray/mentions/responses`
  assert.equal((await fetch(endpoint)).status, 401)
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mind.local', password }) })
  assert.equal(login.status, 200)
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  assert.deepEqual((await (await fetch(endpoint, { headers })).json()).jobs, [])
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ itemKey: 'foreign' }) })).status, 404)
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ itemKey: item.key, settings: { agentId: 'test-agent', modelId: 'test-model' }, url: 'http://untrusted.invalid' }) })
  const accepted = await response.json()
  assert.equal(response.status, 202, JSON.stringify(accepted))
  const duplicate = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ itemKey: item.key }) })
  assert.equal((await duplicate.json()).job.id, accepted.job.id)
  let latest
  await waitFor(async () => {
    latest = (await (await fetch(endpoint, { headers })).json()).jobs[0]
    return latest.status === 'proposal' || latest.status === 'failed'
  })
  assert.equal(latest.status, 'proposal', JSON.stringify(latest))
  assert.equal(latest.conversationId, 'existing-chat')
  assert.equal(latest.route.cardId, 'task1')
  assert.match(latest.proposal, /경계값/)
  assert.equal(created.length, 1)
  assert.equal(created[0].assistant.id, 'bare:test-agent')
  assert.equal(created[0].assistant.conversation_overrides.model, 'test-model')
  assert.equal(operations.size, 2)
  assert.deepEqual(mcpReloads, ['existing-chat'], '기존 대화에만 MCP를 추가하고 새 대화는 생성 설정을 사용한다')
  assert.ok(extraByConversation.get('existing-chat').mcp_server_ids.includes('kept-mcp'))
  assert.deepEqual(extraByConversation.get('existing-chat').session_mcp_servers, [{ name: 'session-tool', command: 'test-only' }])
  assert.equal(paths.filter((entry) => entry.startsWith('POST /project')).length, 0)
  const mentions = await (await fetch(`${baseUrl}/api/integrations/dooray/mentions`, { headers })).json()
  assert.equal(mentions.items[0].acknowledgedAt, null)
  for (const failure of [{ status: 503, code: 'UNAVAILABLE' }, { status: 403, code: 'FORBIDDEN' }, { status: 404, code: 'ROUTE_NOT_FOUND' }]) {
    conversationFailure = failure
    const unchanged = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ itemKey: item.key }) })).json()
    assert.equal(unchanged.job.id, accepted.job.id, '서버 장애나 권한 오류로 제안 기록을 초기화하지 않는다')
  }
  conversationFailure = null
  if (process.env.MNP_RESPONSE_BROWSER_CHECK === '1') {
    await checkDoorayResponseBrowser({ directory, baseUrl, password, deleteConversation: () => { conversationFailure = { status: 404, code: 'NOT_FOUND' } } })
  } else {
    conversationFailure = { status: 404, code: 'NOT_FOUND' }
  }
  await waitFor(async () => (await (await fetch(endpoint, { headers })).json()).jobs.length === 0)
  assert.equal(created.length, 1, '삭제 확인으로 새 AI 대화를 자동 생성하지 않는다')
  assert.equal(operations.size, 2, '삭제된 AI 대화에 이전 지시를 다시 보내지 않는다')
  const restarted = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ itemKey: item.key }) })).json()
  assert.notEqual(restarted.job.id, accepted.job.id)
  await waitFor(async () => {
    latest = (await (await fetch(endpoint, { headers })).json()).jobs[0]
    return latest?.status === 'proposal' || latest?.status === 'failed'
  })
  assert.equal(latest.status, 'proposal', JSON.stringify(latest))
  assert.equal(latest.conversationId, 'created-3', '삭제된 카드 연결을 건너뛰고 새 검토 대화를 연결한다')
  assert.equal(created.length, 3)
  assert.equal(operations.size, 4)
  const preserved = await (await fetch(`${baseUrl}/api/integrations/dooray/mentions`, { headers })).json()
  assert.equal(preserved.items[0].key, item.key)
  assert.equal(preserved.items[0].acknowledgedAt, null)
  assert.equal(paths.filter((entry) => entry.startsWith('POST /project')).length, 0)
})
