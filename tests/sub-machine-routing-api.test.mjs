import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const adminEmail = 'routing-admin@mind.local'
const adminPassword = 'routing-admin-password'

async function waitForServer(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch {
      // 서버 시작 대기
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('서브 머신 라우팅 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

async function stopServer(server) {
  if (server.exitCode !== null) return
  server.kill()
  await new Promise((resolve) => server.once('exit', resolve))
}

async function request(baseUrl, cookie, pathname, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, body: await response.json() }
}

async function login(baseUrl) {
  const result = await request(baseUrl, '', '/api/auth/login', 'POST', {
    email: adminEmail,
    password: adminPassword,
  })
  assert.equal(result.response.status, 200)
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return cookie
}

async function requestWithRunner(baseUrl, token, pendingRequest, resolver) {
  let outcome = null
  const trackedRequest = pendingRequest.then(
    (value) => { outcome = { value } },
    (error) => { outcome = { error } },
  )
  while (!outcome) {
    const claimed = await request(
      baseUrl,
      '',
      '/api/machines/macbook/runner/operations/claim',
      'POST',
      { waitMs: 1_000, limit: 16 },
      { Authorization: `Bearer ${token}` },
    )
    assert.equal(claimed.response.status, 200)
    for (const operation of claimed.body.operations) {
      const data = await resolver(operation.request)
      const settled = await request(
        baseUrl,
        '',
        `/api/machines/macbook/runner/operations/${operation.operationId}/result`,
        'POST',
        { ok: true, data },
        {
          Authorization: `Bearer ${token}`,
          'X-MnP-Operation-Token': operation.resultToken,
        },
      )
      assert.equal(settled.response.status, 200)
    }
    await Promise.race([trackedRequest, new Promise((resolve) => setTimeout(resolve, 5))])
  }
  await trackedRequest
  if (outcome.error) throw outcome.error
  return outcome.value
}

function subMachineResponse(request, conversationId = 'conversation-on-mac') {
  if (request.pathname === '/api/agents/management') {
    return [{
      id: 'claude',
      name: 'Claude on Mac',
      installed: true,
      enabled: true,
      status: 'ready',
      available_models: { available_models: [{ value: 'opus', name: 'Opus on Mac' }] },
    }]
  }
  if (['/api/providers', '/api/skills', '/api/mcp/servers'].includes(request.pathname)) return []
  if (request.pathname === '/api/internal/conversation-runtimes/active') {
    return { schema_version: 1, items: [] }
  }
  if (request.pathname === '/api/internal/external-conversation-dispatches/capabilities') {
    return { schemaVersion: 3, explicitCompletionAfterInterruption: true }
  }
  if (request.pathname === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
    return { conversationId: 'delegated-on-mac', state: 'running', turnId: 'turn-1' }
  }
  if (request.pathname === '/api/internal/external-conversation-launches') {
    return { launchId: 'a'.repeat(64), expiresAt: '2026-09-08T00:00:00.000Z' }
  }
  if (request.pathname === `/api/conversations/${conversationId}`) {
    return {
      id: conversationId,
      name: '맥북 대화',
      created_at: '2026-09-07T01:00:00.000Z',
      modified_at: '2026-09-07T01:01:00.000Z',
      extra: { agent_id: 'claude', current_model_id: 'opus', workspace: '/Users/editor/project' },
      runtime: { state: 'idle' },
    }
  }
  if (request.pathname.startsWith(`/api/conversations/${conversationId}/messages`)) {
    return { items: [{ id: 'message-1', type: 'text', position: 'right', content: '서브 머신에서 시작' }] }
  }
  if (request.pathname === '/api/conversations/delegated-on-mac' && request.method === 'PATCH') {
    return { id: 'delegated-on-mac', name: request.body.name, name_source: 'user' }
  }
  throw new Error(`예상하지 못한 서브 머신 요청: ${request.method} ${request.pathname}`)
}

test('새 대화와 일반 AI 위임의 전체 경로는 선택한 서브 머신에 고정된다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-sub-routing-'))
  await writeFile(path.join(dataDirectory, '_ai-conversation-origins.json'), JSON.stringify([{
    conversationId: 'legacy-main-conversation',
    mapId: 'legacy-map',
    cardId: 'legacy-card',
  }]))
  const port = 31_000 + Math.floor(Math.random() * 5_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_PUBLIC_URL: baseUrl,
      MNP_MACHINE_ID: 'desk-win',
      MNP_AIONUI_URL: 'http://127.0.0.1:9',
      MNP_AIONUI_WEB_URL: 'http://main.example:7777',
      MNP_ADMIN_EMAIL: adminEmail,
      MNP_ADMIN_PASSWORD: adminPassword,
    },
    stdio: 'ignore',
  })

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl)
    assert.equal((await request(baseUrl, cookie, '/api/machines', 'POST', {
      machineId: 'macbook', label: '개발 맥북', platform: 'darwin',
    })).response.status, 200)
    const issued = await request(baseUrl, cookie, '/api/machines/macbook/token', 'POST')
    const runnerToken = issued.body.token
    assert.equal((await request(baseUrl, cookie, '/api/account/distributed-work', 'PUT', {
      enabled: true, defaultMachineId: 'macbook',
    })).response.status, 200)

    const optionsRequest = request(baseUrl, cookie, '/api/integrations/aionui/options?machineId=macbook')
    const options = await requestWithRunner(baseUrl, runnerToken, optionsRequest, subMachineResponse)
    assert.equal(options.response.status, 200)
    assert.equal(options.body.machineId, 'macbook')
    assert.equal(options.body.machineLabel, '개발 맥북')
    assert.equal(options.body.defaultWorkspace, '')
    assert.equal(options.body.agents[0].name, 'Claude on Mac')

    const created = await request(baseUrl, cookie, '/api/maps', 'POST', {
      title: '서브 머신 라우팅',
      map: {
        nodes: [{
          id: 'root-card',
          type: 'mind',
          position: { x: 0, y: 0 },
          data: { label: '루트', description: '', kind: 'root', progress: 0, status: 'planned' },
        }, {
          id: 'child-card',
          type: 'mind',
          position: { x: 300, y: 0 },
          data: { label: '하위 작업', description: '', kind: 'task', progress: 0, status: 'planned' },
        }],
        edges: [{ id: 'root-child', source: 'root-card', target: 'child-card', data: { relation: 'hierarchy' } }],
      },
    })
    assert.equal(created.response.status, 201)
    const mapId = created.body.map.id

    const attributionRequest = request(baseUrl, cookie, '/api/integrations/aionui/attributions', 'POST', {
      workspace: '/Users/editor/project', workspaceConfirmed: true,
      machineId: 'macbook',
      agentId: 'claude',
      modelId: 'opus',
      mapId,
      cardId: 'root-card',
    })
    const attribution = await requestWithRunner(baseUrl, runnerToken, attributionRequest, subMachineResponse)
    assert.equal(attribution.response.status, 201)
    assert.equal(attribution.body.homeMachineId, 'macbook')
    assert.ok(attribution.body.completionUrl.startsWith(`${baseUrl}/api/integrations/aionui/launches/`))

    let relayedLaunchPayload = null
    const launchRequest = request(baseUrl, cookie, '/api/integrations/aionui/external-conversation-launches', 'POST', {
      workspace: '/Users/editor/project',
      agentId: 'claude',
      modelId: 'opus',
      prompt: '작업을 시작해 주세요.',
      completionUrl: attribution.body.completionUrl,
      autoSend: true,
    })
    const launch = await requestWithRunner(baseUrl, runnerToken, launchRequest, (operation) => {
      relayedLaunchPayload = operation.body
      return subMachineResponse(operation)
    })
    assert.equal(launch.response.status, 201)
    assert.equal(launch.body.homeMachineId, 'macbook')
    assert.match(launch.body.launchUrl, /^http:\/\/127\.0\.0\.1:7777\/#\/guid\?external-launch=/)
    assert.equal(relayedLaunchPayload.completionUrl, attribution.body.completionUrl)

    const conversationId = 'conversation-on-mac'
    const completionRequest = request(baseUrl, '', new URL(attribution.body.completionUrl).pathname, 'POST', { conversationId })
    const completion = await requestWithRunner(
      baseUrl,
      runnerToken,
      completionRequest,
      (operation) => subMachineResponse(operation, conversationId),
    )
    assert.equal(completion.response.status, 200)
    assert.equal(completion.body.homeMachineId, 'macbook')

    const map = (await request(baseUrl, cookie, `/api/maps/${mapId}`)).body.map
    const link = map.nodes[0].data.aiConversations[0]
    assert.equal(link.conversationId, conversationId)
    assert.equal(link.homeMachineId, 'macbook')

    const listRequest = request(baseUrl, cookie, `/api/maps/${mapId}/cards/root-card/ai-conversations`)
    const listed = await requestWithRunner(
      baseUrl,
      runnerToken,
      listRequest,
      (operation) => subMachineResponse(operation, conversationId),
    )
    assert.equal(listed.response.status, 200)
    assert.equal(listed.body.conversations[0].homeMachineId, 'macbook')
    assert.equal(listed.body.conversations[0].homeMachineLabel, '개발 맥북')
    assert.equal(listed.body.conversations[0].accessible, true)

    const transcriptRequest = request(
      baseUrl,
      cookie,
      `/api/integrations/aionui/conversations/${conversationId}/transcript`,
      'GET',
      undefined,
      { 'X-MnP-AI-Map-Id': mapId, 'X-MnP-AI-Card-Id': 'root-card' },
    )
    const transcript = await requestWithRunner(
      baseUrl,
      runnerToken,
      transcriptRequest,
      (operation) => subMachineResponse(operation, conversationId),
    )
    assert.equal(transcript.response.status, 200)
    assert.equal(transcript.body.homeMachineId, 'macbook')
    assert.match(transcript.body.transcript, /서브 머신에서 시작/)

    const workStatesRequest = request(baseUrl, cookie, `/api/maps/${mapId}/ai-conversation-work-states?cardId=root-card`)
    const workStates = await requestWithRunner(
      baseUrl,
      runnerToken,
      workStatesRequest,
      (operation) => subMachineResponse(operation, conversationId),
    )
    assert.equal(workStates.response.status, 200)
    assert.equal(workStates.body.cards[0].state, 'idle')

    // 대화 목록 조회에서 링크 메타데이터가 갱신될 수 있으므로 위임 직전 버전을 쓴다.
    const delegationMap = (await request(baseUrl, cookie, `/api/maps/${mapId}`)).body.map
    let delegatedDispatch = null
    const delegationRequest = request(
      baseUrl,
      cookie,
      `/api/maps/${mapId}/ai-delegations`,
      'POST',
      {
        targetCardId: 'child-card',
        sourceRevision: delegationMap.version,
        strategy: 'new',
        machineId: 'macbook',
        instruction: '서브 머신에서 하위 작업을 진행하세요.',
        decisionReason: '독립된 하위 작업입니다.',
        idempotencyKey: 'sub-machine-routing-delegation',
        newConversation: { agentId: 'claude', modelId: 'opus', workspace: '/Users/editor/project' },
      },
      {
        'X-MnP-AI-Map-Id': mapId,
        'X-MnP-AI-Card-Id': 'root-card',
        'X-MnP-AI-Conversation-Id': conversationId,
      },
    )
    const delegated = await requestWithRunner(baseUrl, runnerToken, delegationRequest, (operation) => {
      if (operation.pathname === '/api/internal/external-conversation-dispatches' && operation.method === 'POST') {
        delegatedDispatch = operation.body
      }
      // 응답을 회수하는 사이 시작된 폴링도 선택한 서브 머신에서 처리한다.
      // POST 전 상태 조회는 허용하지 않아 오래된 문서 버전 오류를 숨기지 않는다.
      if (delegatedDispatch && operation.method === 'GET'
        && operation.pathname === '/api/internal/external-conversation-dispatches/sub-machine-routing-delegation') {
        return { operationId: delegatedDispatch.operationId, conversationId: 'delegated-on-mac', state: 'running', turnId: 'turn-1' }
      }
      return subMachineResponse(operation, conversationId)
    })
    assert.equal(delegated.response.status, 202, JSON.stringify(delegated.body))
    assert.equal(delegated.body.delegation.parentHomeMachineId, 'macbook')
    assert.equal(delegated.body.delegation.targetHomeMachineId, 'macbook')
    assert.equal(delegated.body.delegation.targetConversationId, 'delegated-on-mac')
    assert.equal(delegatedDispatch.create.workspace, '/Users/editor/project')

    const delegatedMap = (await request(baseUrl, cookie, `/api/maps/${mapId}`)).body.map
    const delegatedLink = delegatedMap.nodes.find((node) => node.id === 'child-card').data.aiConversations[0]
    assert.equal(delegatedLink.conversationId, 'delegated-on-mac')
    assert.equal(delegatedLink.homeMachineId, 'macbook')

    const origins = JSON.parse(await readFile(path.join(dataDirectory, '_ai-conversation-origins.json'), 'utf8'))
    assert.equal(origins.find((origin) => origin.conversationId === 'legacy-main-conversation')?.homeMachineId, 'desk-win')
    assert.equal(origins.find((origin) => origin.conversationId === conversationId)?.homeMachineId, 'macbook')
    assert.equal(origins.find((origin) => origin.conversationId === 'delegated-on-mac')?.homeMachineId, 'macbook')
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
