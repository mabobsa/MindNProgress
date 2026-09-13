import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkDoorayResponseBrowser } from './helpers/doorayResponseBrowser.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const item = { key: 'comment:post1:comment1', kind: 'mention-comment', projectId: 'p1', postId: 'post1', commentId: 'comment1',
  occurredAt: new Date().toISOString(), actorName: '검증 담당자',
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
  const executionWorkspace = path.join(directory, 'integration')
  await mkdir(executionWorkspace)
  const registryFile = path.join(directory, '_test-workspaces.json')
  await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'test-project', workspaces: [
    { id: 'main', root: executionWorkspace, role: 'integration', enabled: true },
    { id: 'worker', root: path.join(directory, 'worker'), role: 'worker', enabled: true },
  ] }))
  const operations = new Map()
  const created = []
  const paths = []
  const mcpNames = ['MindNProgress', 'unityMCP', 'docker-dooray-mcp', 'pptx-mcp']
  const requiredMcps = mcpNames.map((name, index) => ({ id: `required-mcp-${index}`, name, enabled: true }))
  const requiredMcpIds = requiredMcps.map((server) => server.id)
  const extraByConversation = new Map([['existing-chat', { mcp_server_ids: ['kept-mcp'], mcp_servers: ['existing-mcp'], session_mcp_servers: [{ name: 'session-tool', command: 'test-only' }] }]])
  const mcpReloads = []
  const archived = []
  const deleted = new Set()
  const reviewProposal = '금액 포맷터를 확인하고 경계값을 검증하는 작업을 제안합니다.\n' + '상세 조건을 확인합니다.\n'.repeat(320) + '제안의 마지막 검증 조건입니다.'
  let conversationFailure = null
  let approvalMode = false
  const approvalTickets = []
  const approvalDecision = { kind: 'approval', reason: '그룹·총괄 구성의 사실은 충분하고 실행 동의만 남았습니다.', questions: [],
    approval: { title: '연동 그룹과 총괄 구성', scope: ['연동 그룹과 총괄 문서를 생성한다.'], exclusions: ['기능 구현과 하위 AI 실행은 제외한다.'] } }
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
    if (url.pathname === '/project/v1/projects/p1/posts/post1/logs') return send([{ id: 'comment1', type: 'comment', body: { content: approvalMode ? '그룹과 총괄 문서 구성도 검토해 주세요.' : '김용민님, 금액 표시를 확인해 주세요.' } }], 200, true)
    if (url.pathname === '/api/internal/external-conversation-launches' && request.method === 'POST') {
      approvalTickets.push(body)
      return send({ launchId: 'a'.repeat(64) }, 201)
    }
    if (url.pathname === '/project/v1/projects') return send([], 200, true)
    if (url.pathname === '/api/agents/management') return send([{ id: 'test-agent', name: '검증 AI', installed: true, enabled: true,
      available_models: { current_model_id: 'test-model', available_models: [{ id: 'test-model', name: '검증 모델' }] } }])
    if (url.pathname === '/api/mcp/servers') return send([...requiredMcps, { id: 'kept-mcp', name: 'existing-mcp', enabled: true }])
    if (url.pathname === '/api/providers' || url.pathname === '/api/skills') return send([])
    if (url.pathname === '/api/conversations' && request.method === 'POST') {
      created.push(body)
      assert.deepEqual(body.assistant.conversation_overrides.mcp_ids, requiredMcpIds)
      assert.deepEqual(body.extra.selected_mcp_server_ids, requiredMcpIds)
      extraByConversation.set(`created-${created.length}`, { ...body.extra, mcp_server_ids: requiredMcpIds, mcp_servers: mcpNames })
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
      if (messageMatch[1] === 'approved-work') return send(url.searchParams.has('before') ? {
        items: [{ id: 'approval-user', position: 'right', type: 'text', created_at: 1, content: { content: '2단계 분석 계획 승인. 기존 결과는 재사용하세요.' } }], has_more_before: false,
      } : { items: [{ id: 'approval-answer', position: 'left', type: 'text', created_at: 2, content: { content: '문서 구성 완료. 남은 분석만 진행합니다.\n- attributionToken: secret-only-for-test-1234567890' } }], has_more_before: true, oldest_cursor: 'earlier-page' })
      if (messageMatch[1] === 'existing-chat') return send({ items: [{ position: 'left', type: 'text', content: { content: '기존 담당 대화의 확정 사항: 소수점 둘째 자리까지 표시' } }] })
      const op = [...operations.values()].reverse().find((entry) => entry.targetConversationId === messageMatch[1])
      if (!op) return send({ items: [] })
      const result = approvalMode ? { requestId: op.operationId, action: 'clarify', proposal: reviewProposal, decision: approvalDecision }
        : op.operationId.includes('-route-') ? { requestId: op.operationId, action: 'direct', mapId: 'map-test', cardId: 'task1', conversationId: 'existing-chat',
        requestSummary: '베팅 금액 표시 확인', reason: '해당 업무 URL이 연결된 담당 카드' } : { requestId: op.operationId, proposal: reviewProposal }
      return send({ items: [{ position: 'left', type: 'text', content: { content: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` } }] })
    }
    const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
    const currentFailure = deleted.has(conversation?.[1]) ? { status: 404, code: 'NOT_FOUND' } : conversation?.[1] === 'created-2' ? conversationFailure : null
    if (currentFailure) {
      response.writeHead(currentFailure.status, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify({ success: false, error: { code: currentFailure.code } }))
    }
    if (conversation) return send({ id: conversation[1], name: '베팅 표시 대화', runtime: { state: 'idle', isProcessing: false, pendingConfirmations: 0 },
      extra: { agent_id: 'test-agent', current_model_id: 'test-model', workspace: executionWorkspace, ...extraByConversation.get(conversation[1]) } })
    if (url.pathname === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
      assert.equal(body.strategy, 'resume')
      assert.equal(body.actorConversationId, body.targetConversationId)
      assert.match(body.instruction, /제안 작성만 허용/)
      if (body.operationId.includes('-handoff-')) {
        assert.equal(body.targetConversationId, 'existing-chat')
        assert.ok(body.instruction.includes(item.url))
        assert.match(body.instruction, /독립적으로 판단/)
        assert.match(body.instruction, /사용자의 별도 승인/)
      } else {
        assert.notEqual(body.targetConversationId, 'existing-chat')
        assert.match(body.instruction, /조회·검색/)
        for (const id of requiredMcpIds) assert.ok(extraByConversation.get(body.targetConversationId).mcp_server_ids.includes(id))
        if (body.operationId.includes('-review-')) assert.match(body.instruction, /소수점 둘째 자리/)
      }
      operations.set(body.operationId, body)
      return send({ conversationId: body.targetConversationId, operationId: body.operationId, state: 'completed' }, 202)
    }
    const dispatch = url.pathname.match(/^\/api\/internal\/external-conversation-dispatches\/([^/]+)$/)
    if (dispatch && operations.has(dispatch[1])) return send({ conversationId: operations.get(dispatch[1]).targetConversationId, operationId: dispatch[1], state: 'completed' })
    if (url.pathname === '/api/internal/conversation-runtimes/active') return send({ items: [] })
    const archive = url.pathname.match(/^\/api\/sidebar\/conversation\/([^/]+)\/archive$/)
    if (archive && request.method === 'POST') { assert.notEqual(archive[1], 'existing-chat'); archived.push(archive[1]); return send(null) }
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
  let serverErrors = ''
  const server = spawn(process.execPath, ['server/index.mjs'], { cwd: projectDirectory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
    ...process.env, MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
    MNP_WORKSPACE_POOL_REGISTRY: registryFile,
    MNP_ADMIN_PASSWORD: password, MNP_DOORAY_API_KEY: 'test-only', MNP_DOORAY_BASE_URL: upstreamUrl, MNP_AIONUI_URL: upstreamUrl, MNP_AIONUI_WEB_URL: upstreamUrl,
  } })
  server.stderr.on('data', (chunk) => { serverErrors += chunk })
  t.after(async () => {
    server.kill()
    await new Promise((resolve) => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve) })
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  try { await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok) }
  catch (failure) { throw new Error(`${failure.message}\n${serverErrors}`) }
  const endpoint = `${baseUrl}/api/integrations/dooray/mentions/responses`
  assert.equal((await fetch(endpoint)).status, 401)
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mind.local', password }) })
  assert.equal(login.status, 200)
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  const executionOptions = await (await fetch(`${baseUrl}/api/integrations/aionui/options?purpose=dooray-response`, { headers })).json()
  assert.equal(executionOptions.defaultWorkspace, '', '담당 미지정 시 MnP나 Holdem으로 임의 귀속하지 않는다')
  assert.deepEqual(executionOptions.workspaceContext.choices, [])
  const cardWorkspaceOptions = await (await fetch(`${baseUrl}/api/integrations/aionui/options?purpose=dooray-response&mapId=map-test&cardId=task1`, { headers })).json()
  assert.equal(cardWorkspaceOptions.defaultWorkspace, '')
  assert.ok(cardWorkspaceOptions.workspaceContext.choices.some((item) => item.workspace === executionWorkspace))
  const originalExtra = extraByConversation.get('existing-chat')
  extraByConversation.set('existing-chat', { ...originalExtra, workspace: projectDirectory })
  const maintenanceOptions = await (await fetch(`${baseUrl}/api/integrations/aionui/options?purpose=dooray-response&mapId=map-test&cardId=task1`, { headers })).json()
  assert.equal(maintenanceOptions.defaultWorkspace, '', '대화 이력은 추천 후보이며 명시적 기준이 아니다')
  assert.ok(maintenanceOptions.workspaceContext.choices.some((item) => item.workspace === projectDirectory))
  extraByConversation.set('existing-chat', originalExtra)
  const normalOptions = await (await fetch(`${baseUrl}/api/integrations/aionui/options`, { headers })).json()
  assert.equal(normalOptions.defaultWorkspace, '', '일반 카드도 MnP 기본 경로로 대체하지 않는다')
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
  assert.equal(latest.conversationId, 'created-2')
  assert.equal(latest.route.cardId, 'task1')
  assert.match(latest.proposal, /경계값/)
  assert.equal(created.length, 2)
  assert.equal(created[0].extra.workspace, created[1].extra.workspace)
  assert.match(created[0].extra.workspace, /user-admin[\\/]Dooray AI 대응$/)
  assert.notEqual(created[0].extra.mnpDoorayOperationId, created[1].extra.mnpDoorayOperationId)
  assert.equal(created[0].assistant.id, 'bare:test-agent')
  assert.equal(created[0].assistant.conversation_overrides.model, 'test-model')
  assert.equal(operations.size, 2)
  assert.deepEqual(mcpReloads, [], '기존 업무 대화의 MCP를 변경하지 않는다')
  assert.ok(extraByConversation.get('existing-chat').mcp_server_ids.includes('kept-mcp'))
  assert.deepEqual(extraByConversation.get('existing-chat').session_mcp_servers, [{ name: 'session-tool', command: 'test-only' }])
  const refinement = await fetch(`${endpoint}/${latest.id}/refine`, { method: 'POST', headers, body: JSON.stringify({ hint: '소수점 표시 조건도 검토해 주세요.' }) })
  assert.equal(refinement.status, 202)
  await waitFor(async () => {
    latest = (await (await fetch(endpoint, { headers })).json()).jobs[0]
    return latest?.status === 'proposal' && operations.size === 4
  })
  assert.equal(latest.conversationId, 'created-2', '실제 API에서도 같은 요청·담당의 제안 대화를 이어 쓴다')
  assert.equal(created.length, 2)
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
    await checkDoorayResponseBrowser({ directory, baseUrl, password, deleteConversation: () => { deleted.add('created-2') } })
  } else {
    deleted.add('created-2')
  }
  await waitFor(async () => (await (await fetch(endpoint, { headers })).json()).jobs.length === 0)
  assert.equal(created.length, 2, '삭제 확인으로 새 AI 대화를 자동 생성하지 않는다')
  assert.equal(operations.size, 4, '삭제된 AI 대화에 이전 지시를 다시 보내지 않는다')
  const restarted = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ itemKey: item.key }) })).json()
  assert.notEqual(restarted.job.id, accepted.job.id)
  await waitFor(async () => {
    latest = (await (await fetch(endpoint, { headers })).json()).jobs[0]
    return latest?.status === 'proposal' || latest?.status === 'failed'
  })
  assert.equal(latest.status, 'proposal', JSON.stringify(latest))
  assert.equal(latest.conversationId, 'created-4', '업무 대화 대신 새로운 전용 검토 대화를 만든다')
  assert.equal(created.length, 4)
  assert.equal(operations.size, 6)
  assert.equal(new Set(created.map((conversation) => conversation.extra.workspace)).size, 1, '서로 다른 요청도 같은 전용 프로젝트에 모인다')
  const handoffEndpoint = `${endpoint}/${latest.id}/handoff`
  const handoff = await (await fetch(handoffEndpoint, { headers })).json()
  assert.equal(handoff.conversations[0].conversationId, 'existing-chat')
  assert.ok(handoff.prompt.includes(latest.proposal))
  assert.ok(handoff.prompt.includes(item.url))
  assert.equal((await fetch(handoffEndpoint, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'created-4' }) })).status, 409)
  for (let index = 0; index < 2; index++) {
    const sent = await fetch(handoffEndpoint, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'existing-chat' }) })
    assert.equal(sent.status, 202, JSON.stringify(await sent.json()))
  }
  assert.equal(operations.size, 7, '명시적 전달만 업무 대화를 실행하며 중복 클릭은 한 실행으로 유지한다')
  assert.equal((await (await fetch(endpoint, { headers })).json()).jobs[0].conversationId, 'existing-chat', '제안 대화 보기는 실제 전달한 담당 카드 대화를 반환한다')
  if (process.env.MNP_RESPONSE_BROWSER_CHECK === '1') {
    await checkDoorayResponseBrowser({ directory, baseUrl, password, complete: true, deleteConversation: () => { deleted.add('created-3'); deleted.add('created-4') } })
  } else {
    const completed = await fetch(`${endpoint}/${latest.id}/complete`, { method: 'POST', headers })
    assert.equal(completed.status, 200)
    deleted.add('created-3'); deleted.add('created-4')
  }
  const final = (await (await fetch(endpoint, { headers })).json()).jobs[0]
  assert.equal(final.status, 'completed')
  assert.equal(final.proposal, latest.proposal)
  assert.equal(final.archiveStatus, 'done')
  assert.equal(final.conversationId, 'existing-chat', '완료 내역에도 담당 카드 대화 연결을 유지한다')
  assert.deepEqual(archived.sort(), ['created-3', 'created-4'])
  const repeated = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ itemKey: item.key }) })).json()
  assert.equal(repeated.job.id, final.id)
  assert.equal(repeated.job.status, 'completed')
  assert.equal(created.length, 4)
  const mapAfter = JSON.parse(await readFile(path.join(directory, 'map-test.json'), 'utf8'))
  assert.equal(mapAfter.version, 1, '제안 전용 대화는 업무 카드와 대화 연결을 변경하지 않는다')
  assert.equal(mapAfter.nodes.find((node) => node.id === 'task1').data.aiConversations.length, 1)
  const preserved = await (await fetch(`${baseUrl}/api/integrations/dooray/mentions`, { headers })).json()
  assert.equal(preserved.items[0].key, item.key)
  assert.equal(preserved.items[0].acknowledgedAt, null)
  assert.equal(paths.filter((entry) => entry.startsWith('POST /project')).length, 0)

  approvalMode = true
  const newApproval = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ itemKey: item.key }) })).json()
  let approvalJob
  await waitFor(async () => {
    approvalJob = (await (await fetch(endpoint, { headers })).json()).jobs.find((job) => job.id === newApproval.job.id)
    return approvalJob?.status === 'needs-approval'
  })
  assert.equal(approvalJob.route, null)
  const approveUrl = `${endpoint}/${approvalJob.id}/approve`
  const contextUrl = `${baseUrl}/api/integrations/dooray/response-approvals/${approvalJob.id}?revision=${approvalJob.proposalRevision}`
  assert.equal((await fetch(approveUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal((await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify({ proposalRevision: '0'.repeat(64) }) })).status, 409)
  const beforeApproval = { created: created.length, operations: operations.size }
  const verifyNoLaunch = async () => {
    assert.equal(approvalTickets.length, 0, '옵션 창 취소 시 새 대화를 시작하지 않는다')
    assert.deepEqual({ created: created.length, operations: operations.size }, beforeApproval, '승인만으로 기존 제안 AI를 재개하거나 새 AI를 만들지 않는다')
  }
  const verifyApprovalMcp = async () => {
    const payload = approvalTickets[0]
    const mcp = new Client({ name: 'dooray-approval-test', version: '1' })
    try {
      await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'], cwd: projectDirectory, stderr: 'pipe', env: {
        ...process.env, MNP_API_URL: baseUrl, MNP_DATA_DIR: directory, MNP_TOKEN_FILE: path.join(directory, '_integration-token'),
        MNP_MCP_USAGE_DISABLED: '1', AIONUI_CONVERSATION_ID: 'approved-work',
      } }))
      const args = { responseId: approvalJob.id, proposalRevision: approvalJob.proposalRevision, editorId: 'user-admin',
        attributionToken: payload.prompt.match(/^- attributionToken: (.+)$/m)[1] }
      const result = await mcp.callTool({ name: 'mindnprogress_get_dooray_response_approval', arguments: args })
      assert.notEqual(result.isError, true, JSON.stringify(result))
      const verified = JSON.parse(result.content[0].text)
      assert.equal(verified.approval.proposal, reviewProposal)
      assert.deepEqual(verified.approval.scope, approvalDecision.approval.scope)
      assert.deepEqual(verified.approval.exclusions, approvalDecision.approval.exclusions)
      assert.ok(verified.request.includes(reviewProposal))
      const wrongEditor = await mcp.callTool({ name: 'mindnprogress_get_dooray_response_approval', arguments: { ...args, editorId: 'another-editor' } })
      assert.equal(wrongEditor.isError, true)
    } finally { await mcp.close() }
  }
  const completeLaunch = async (request) => {
    await waitFor(() => approvalTickets.length === 1)
    const payload = approvalTickets[0]
    assert.ok(payload.prompt.includes(request))
    assert.ok(payload.prompt.includes(reviewProposal))
    assert.match(payload.prompt, /서버에 저장된 사용자 승인을 검증/)
    assert.match(payload.title, /^\[Dooray 승인\]/)
    assert.equal(payload.workspace, executionWorkspace)
    assert.equal(payload.agentId, 'test-agent')
    assert.equal(payload.autoSend, true)
    assert.equal((await fetch(`${contextUrl}&execution=1&conversationId=approved-work`, { headers })).status, 409)
    const linked = await fetch(payload.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'approved-work' }) })
    assert.equal(linked.status, 200, JSON.stringify(await linked.json()))
    assert.equal((await fetch(payload.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'approved-work' }) })).status, 200)
    assert.equal((await fetch(`${contextUrl}&execution=1&conversationId=approved-work`, { headers })).status, 200)
    assert.equal((await fetch(`${contextUrl}&execution=1&conversationId=other-work`, { headers })).status, 409)
    await verifyApprovalMcp()
  }
  if (['1', 'approval'].includes(process.env.MNP_RESPONSE_BROWSER_CHECK)) {
    await checkDoorayResponseBrowser({ directory, baseUrl, password, approvalFlow: { verifyNoLaunch, completeLaunch, proposalConversationId: approvalJob.conversationId, executionWorkspace } })
  } else {
    const approval = await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify({ proposalRevision: approvalJob.proposalRevision }) })
    assert.equal(approval.status, 200)
    await verifyNoLaunch()
    const { launch } = await (await fetch(contextUrl, { headers })).json()
    const attributionResponse = await fetch(`${baseUrl}/api/integrations/aionui/attributions`, { method: 'POST', headers, body: JSON.stringify({
      agentId: 'test-agent', modelId: 'test-model', purpose: launch.purpose, mapId: launch.mapId, cardId: launch.cardId,
      doorayApproval: launch.doorayApproval, workspace: executionWorkspace, workspaceConfirmed: true,
    }) })
    const attribution = await attributionResponse.json()
    assert.equal(attributionResponse.status, 201, JSON.stringify(attribution))
    const { buildAiConversationPrompt, aiConversationTitle } = await import('../src/utils/aiConversationLaunch.mjs')
    const prompt = buildAiConversationPrompt({ ...launch, editorId: attribution.editorId, attributionToken: attribution.attributionToken, request: attribution.approvalRequest })
    const payload = { agentId: 'test-agent', modelId: 'test-model', completionUrl: attribution.completionUrl, prompt,
      title: aiConversationTitle(launch), workspace: executionWorkspace, autoSend: true }
    const wrongWorkspace = await fetch(`${baseUrl}/api/integrations/aionui/external-conversation-launches`, { method: 'POST', headers, body: JSON.stringify({ ...payload, workspace: projectDirectory }) })
    assert.equal(wrongWorkspace.status, 409)
    assert.equal(approvalTickets.length, 0, '실행 요청의 작업공간 변조는 AionCore 전달 전에 막는다')
    const bad = await fetch(`${baseUrl}/api/integrations/aionui/external-conversation-launches`, { method: 'POST', headers, body: JSON.stringify({ ...payload, prompt: '전문 누락' }) })
    assert.equal(bad.status, 409)
    const ticket = await fetch(`${baseUrl}/api/integrations/aionui/external-conversation-launches`, { method: 'POST', headers, body: JSON.stringify(payload) })
    assert.equal(ticket.status, 201, JSON.stringify(await ticket.json()))
    await completeLaunch(launch.initialRequest)
    assert.equal((await fetch(`${endpoint}/${approvalJob.id}/complete`, { method: 'POST', headers })).status, 200)
  }
  const executionUrl = `${contextUrl}&execution=1&conversationId=approved-work`
  assert.equal((await fetch(executionUrl)).status, 401)
  const execution = await fetch(executionUrl, { headers })
  assert.equal(execution.status, 200, '대응 완료 후에도 기존 실행 대화에서 승인을 검증한다')
  const approvalFinal = (await execution.json()).job
  assert.equal(approvalFinal.status, 'completed')
  assert.equal(approvalFinal.approval.conversation.conversationId, 'approved-work')
  assert.ok(approvalFinal.completedAt)
  assert.equal(approvalFinal.approval.revision, approvalJob.proposalRevision)
  assert.ok(archived.includes(approvalJob.conversationId))
  assert.equal(archived.includes('approved-work'), false, '실행 대화는 완료 시 보관하지 않는다')
  assert.equal((await fetch(contextUrl, { headers })).status, 409, '완료된 승인으로 신규 대화 전문을 발급하지 않는다')
  for (const suffix of ['&execution=1', '&execution=1&conversationId=', '&execution=1&conversationId=other-work']) {
    assert.equal((await fetch(`${contextUrl}${suffix}`, { headers })).status, 409)
  }
  assert.equal((await fetch(executionUrl.replace(approvalJob.proposalRevision, '0'.repeat(64)), { headers })).status, 409)
  assert.equal((await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify({ proposalRevision: approvalJob.proposalRevision }) })).status, 409)
  const duplicateAttribution = await fetch(`${baseUrl}/api/integrations/aionui/attributions`, { method: 'POST', headers, body: JSON.stringify({
    agentId: 'test-agent', modelId: 'test-model', purpose: 'dooray-response', mapId: '', cardId: '', workspace: executionWorkspace,
    doorayApproval: { responseId: approvalJob.id, proposalRevision: approvalJob.proposalRevision },
  }) })
  assert.equal(duplicateAttribution.status, 409)
  const duplicateLaunch = await fetch(`${baseUrl}/api/integrations/aionui/external-conversation-launches`, { method: 'POST', headers, body: JSON.stringify(approvalTickets[0]) })
  assert.equal(duplicateLaunch.status, 409)
  assert.equal(approvalTickets.length, 1)
  await verifyApprovalMcp()
  assert.equal(JSON.parse(await readFile(path.join(directory, 'map-test.json'), 'utf8')).version, 1)
  assert.deepEqual({ created: created.length, operations: operations.size }, beforeApproval)

  // 완료한 승인 기록에서도 사용자가 루트와 전문을 확인해 정식 카드 대화로 인계한다.
  const executionHandoffUrl = `${endpoint}/${approvalJob.id}/execution-handoff`
  assert.equal((await fetch(executionHandoffUrl)).status, 401)
  const options = await (await fetch(executionHandoffUrl, { headers })).json()
  assert.equal(options.targets[0].cardId, 'root1')
  const prepared = await (await fetch(`${executionHandoffUrl}?mapId=map-test`, { headers })).json()
  assert.ok(prepared.preview.request.includes('2단계 분석 계획 승인'))
  assert.ok(prepared.preview.request.includes('문서 구성 완료'))
  assert.ok(prepared.preview.request.indexOf('2단계 분석 계획 승인') < prepared.preview.request.indexOf('문서 구성 완료'))
  assert.ok(!prepared.preview.request.includes('secret-only-for-test'))
  assert.ok(prepared.preview.request.includes(item.url))
  const handoffInput = { mapId: 'map-test', proposalRevision: approvalJob.proposalRevision, fingerprint: prepared.preview.fingerprint, confirmApprovedScope: true }
  assert.equal((await fetch(executionHandoffUrl, { method: 'POST', headers, body: JSON.stringify({ ...handoffInput, confirmApprovedScope: false }) })).status, 409)
  assert.equal((await fetch(executionHandoffUrl, { method: 'POST', headers, body: JSON.stringify({ ...handoffInput, fingerprint: 'stale' }) })).status, 409)
  const handoffResponse = await fetch(executionHandoffUrl, { method: 'POST', headers, body: JSON.stringify(handoffInput) })
  const handoffContext = await handoffResponse.json()
  assert.equal(handoffResponse.status, 200, JSON.stringify(handoffContext))
  assert.equal(handoffContext.launch.cardId, 'root1')
  const repeatedHandoff = await (await fetch(executionHandoffUrl, { method: 'POST', headers, body: JSON.stringify(handoffInput) })).json()
  assert.equal(repeatedHandoff.launch.doorayApproval.handoffId, handoffContext.launch.doorayApproval.handoffId)
  const launch = handoffContext.launch
  for (const workspace of ['', 'relative-path', path.join(directory, '_dooray-response-workspaces', 'user')]) {
    const rejected = await fetch(`${baseUrl}/api/integrations/aionui/attributions`, { method: 'POST', headers, body: JSON.stringify({
      agentId: 'test-agent', modelId: 'test-model', ...launch, workspace,
    }) })
    assert.equal(rejected.status, 409, '빈 경로·상대 경로·제안 보관 폴더에서 승인 인계를 시작하지 않는다')
  }
  const mnpChoice = await fetch(`${baseUrl}/api/integrations/aionui/attributions`, { method: 'POST', headers, body: JSON.stringify({
    agentId: 'test-agent', modelId: 'test-model', ...launch, workspace: projectDirectory, workspaceConfirmed: true,
  }) })
  assert.equal(mnpChoice.status, 201, '사용자가 선택한 MnP 작업공간을 차단하지 않는다')
  const attributionResponse = await fetch(`${baseUrl}/api/integrations/aionui/attributions`, { method: 'POST', headers, body: JSON.stringify({
    agentId: 'test-agent', modelId: 'test-model', ...launch, workspace: executionWorkspace, workspaceConfirmed: true,
  }) })
  const attribution = await attributionResponse.json()
  assert.equal(attributionResponse.status, 201, JSON.stringify(attribution))
  const { buildAiConversationPrompt, aiConversationTitle } = await import('../src/utils/aiConversationLaunch.mjs')
  const payload = { agentId: 'test-agent', modelId: 'test-model', title: aiConversationTitle(launch), completionUrl: attribution.completionUrl,
    workspace: executionWorkspace, autoSend: true,
    prompt: buildAiConversationPrompt({ ...launch, editorId: attribution.editorId, attributionToken: attribution.attributionToken, request: attribution.approvalRequest }) }
  const ticket = await fetch(`${baseUrl}/api/integrations/aionui/external-conversation-launches`, { method: 'POST', headers, body: JSON.stringify(payload) })
  assert.equal(ticket.status, 201, JSON.stringify(await ticket.json()))
  const wrongOrigin = await fetch(attribution.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'existing-chat' }) })
  assert.equal(wrongOrigin.status, 409, '다른 카드의 대화를 인계 루트 소속으로 옮기지 않는다')
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await fetch(attribution.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'root-approved-work' }) })
    assert.equal(completion.status, 200, JSON.stringify(await completion.json()))
  }
  const mapLinked = JSON.parse(await readFile(path.join(directory, 'map-test.json'), 'utf8'))
  assert.equal(mapLinked.version, 2, '중복 완료 통보는 문서 버전을 늘리지 않는다')
  assert.equal(mapLinked.nodes.find((node) => node.id === 'root1').data.aiConversationId, 'root-approved-work')
  assert.equal(mapLinked.nodes.find((node) => node.id === 'root1').data.aiConversations.at(-1).workspace, executionWorkspace, '하위 위임도 등록된 pool을 상속할 수 있도록 작업공간을 연결 정보에 저장한다')
  const origins = JSON.parse(await readFile(path.join(directory, '_ai-conversation-origins.json'), 'utf8'))
  assert.equal(origins.find((entry) => entry.conversationId === 'root-approved-work').cardId, 'root1')
  assert.ok(!origins.some((entry) => entry.conversationId === 'approved-work'), '기존 무소속 구성 대화의 시작 카드를 바꾸지 않는다')
  const verifiedHandoff = await (await fetch(`${contextUrl}&execution=1&conversationId=root-approved-work`, { headers })).json()
  assert.equal(verifiedHandoff.launch.cardId, 'root1')
  assert.equal(verifiedHandoff.job.approval.conversation.conversationId, 'approved-work')
  assert.equal(verifiedHandoff.job.approval.handoffs[0].conversation.conversationId, 'root-approved-work')
  assert.equal(verifiedHandoff.job.approval.handoffs[0].request, undefined, '목록에는 긴 전문을 반복하지 않는다')
  assert.equal((await fetch(`${contextUrl}&execution=1&conversationId=unrelated-work`, { headers })).status, 409)
  assert.equal((await fetch(`${contextUrl}&execution=1&conversationId=approved-work`, { headers })).status, 200)
})
