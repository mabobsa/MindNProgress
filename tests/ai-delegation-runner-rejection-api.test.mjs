import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const adminEmail = 'runner-reject-admin@mind.local'
const adminPassword = 'runner-reject-password'
// 2026-11 실제로 서브 머신에서 starting에 멈춘 위임과 같은 형식(콜론 포함)의 기존 ID다.
const legacyId = 'v1:child-card:legacy'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForServer(baseUrl, server, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch {
      // 서버 시작 대기
    }
    await pause(100)
  }
  throw new Error(`Runner 거부 검증 서버가 시작되지 않았습니다. ${server.diagnostics}`)
}

function startServer(dataDirectory, port) {
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_WORKSPACE_POOL_REGISTRY: path.join(dataDirectory, 'absent-workspaces.json'),
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_MACHINE_ID: 'desk-win',
      MNP_AIONUI_URL: 'http://127.0.0.1:9',
      MNP_AI_DELEGATION_POLL_INTERVAL_MS: '500',
      MNP_ADMIN_EMAIL: adminEmail,
      MNP_ADMIN_PASSWORD: adminPassword,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.diagnostics = ''
  server.stderr.on('data', (chunk) => { server.diagnostics += chunk })
  return server
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return
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
  const result = await request(baseUrl, '', '/api/auth/login', 'POST', { email: adminEmail, password: adminPassword })
  assert.equal(result.response.status, 200)
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return cookie
}

// 서브 머신의 AionUi 내장 Runner를 흉내 낸다. 실제 Runner처럼 실행 ID 경로에 허용 문자 밖의 값이 있으면 거부한다.
function startRunner(baseUrl, token, resolve) {
  let stopped = false
  const requests = []
  const loop = (async () => {
    while (!stopped) {
      let claimed
      try {
        claimed = await request(baseUrl, '', '/api/machines/macbook/runner/operations/claim', 'POST',
          { waitMs: 200, limit: 16, callbackBaseUrl: 'http://127.0.0.1:43129' }, { Authorization: `Bearer ${token}` })
      } catch {
        if (!stopped) await pause(50)
        continue
      }
      for (const operation of claimed.body.operations ?? []) {
        requests.push(operation.request)
        await request(baseUrl, '', `/api/machines/macbook/runner/operations/${operation.operationId}/result`, 'POST',
          resolve(operation.request), { Authorization: `Bearer ${token}`, 'X-MnP-Operation-Token': operation.resultToken })
      }
    }
  })()
  return { requests, stop: async () => { stopped = true; await loop } }
}

test('콜론 실행 ID로 멈춘 서브 머신 위임은 원인을 남기고 대상 대화가 끝난 뒤에만 사용자 종료할 수 있다', { timeout: 90_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-reject-'))
  const port = 36_000 + Math.floor(Math.random() * 4_000)
  const baseUrl = `http://127.0.0.1:${port}`
  let server = startServer(dataDirectory, port)
  let runner = null

  try {
    await waitForServer(baseUrl, server)
    let cookie = await login(baseUrl)
    assert.equal((await request(baseUrl, cookie, '/api/machines', 'POST', {
      machineId: 'macbook', label: '개발 맥북', platform: 'darwin',
    })).response.status, 200)
    const runnerToken = (await request(baseUrl, cookie, '/api/machines/macbook/token', 'POST')).body.token
    assert.equal((await request(baseUrl, cookie, '/api/account/distributed-work', 'PUT', {
      enabled: true, defaultMachineId: 'macbook',
    })).response.status, 200)
    const created = await request(baseUrl, cookie, '/api/maps', 'POST', {
      title: 'Runner 거부 위임',
      map: {
        nodes: [{
          id: 'root-card', type: 'mind', position: { x: 0, y: 0 },
          data: {
            label: '루트', description: '', kind: 'root', progress: 0, status: 'planned',
            aiConversationId: 'parent-on-mac', aiConversations: [{ conversationId: 'parent-on-mac', homeMachineId: 'macbook' }],
          },
        }, {
          id: 'child-card', type: 'mind', position: { x: 300, y: 0 },
          data: {
            label: '하위 작업', description: '', kind: 'task', isWork: true, progress: 0, status: 'planned',
            aiConversationId: 'child-on-mac', aiConversations: [{ conversationId: 'child-on-mac', homeMachineId: 'macbook' }],
          },
        }],
        edges: [{ id: 'root-child', source: 'root-card', target: 'child-card', data: { relation: 'hierarchy' } }],
      },
    })
    assert.equal(created.response.status, 201, JSON.stringify(created.body))
    const mapId = created.body.map.id
    await stopServer(server)

    const createdAt = '2026-11-12T07:52:01.585Z'
    await writeFile(path.join(dataDirectory, '_ai-conversation-origins.json'), JSON.stringify([{
      conversationId: 'parent-on-mac', homeMachineId: 'macbook', mapId, cardId: 'root-card', startedBy: null, linkedAt: createdAt,
    }]))
    await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify([{
      id: legacyId, requestSignature: 'legacy-signature', mapId,
      parentCardId: 'root-card', parentCardLabel: '루트', targetCardId: 'child-card', targetCardLabel: '하위 작업',
      parentConversationId: 'parent-on-mac', parentHomeMachineId: 'macbook',
      targetConversationId: 'child-on-mac', targetHomeMachineId: 'macbook',
      childOperationId: legacyId, strategy: 'new', state: 'starting', childTurnId: null, linkError: null,
      workspaceLease: null, createdAt, updatedAt: createdAt,
    }]))

    server = startServer(dataDirectory, port)
    await waitForServer(baseUrl, server)
    cookie = await login(baseUrl)
    let childRuntime = { state: 'running', is_processing: true, turn_id: 'turn-child' }
    runner = startRunner(baseUrl, runnerToken, ({ pathname }) => {
      const dispatch = pathname.match(/^\/api\/internal\/external-conversation-dispatches\/([^/]+)(\/complete)?$/)
      if (dispatch && dispatch[1] !== 'capabilities' && !/^[A-Za-z0-9_-]{1,160}$/.test(dispatch[1])) {
        return { ok: false, status: null, code: 'RUNNER_OPERATION_REJECTED', message: 'Runner operation is not allowed.' }
      }
      if (pathname === '/api/internal/external-conversation-dispatches/capabilities') {
        return { ok: true, data: { schemaVersion: 3, explicitCompletionAfterInterruption: true } }
      }
      if (pathname === '/api/internal/conversation-runtimes/active') return { ok: true, data: { schema_version: 1, items: [] } }
      if (pathname === '/api/agents/management') return { ok: true, data: [] }
      if (['/api/providers', '/api/skills', '/api/mcp/servers'].includes(pathname)) return { ok: true, data: [] }
      if (pathname === '/api/conversations/child-on-mac') return { ok: true, data: { id: 'child-on-mac', runtime: childRuntime } }
      if (pathname === '/api/conversations/parent-on-mac') return { ok: true, data: { id: 'parent-on-mac', runtime: { state: 'idle' } } }
      return { ok: false, status: 404, code: 'NOT_FOUND' }
    })
    const listDelegations = async () => (await request(baseUrl, cookie, `/api/maps/${mapId}/ai-delegations`)).body
    const currentMap = async () => (await request(baseUrl, cookie, `/api/maps/${mapId}`)).body.map

    // 1) 주기 폴링이 Runner 거부를 위임에 남기고, 상태는 바꾸지 않은 채 사용자 종료 후보로 표시한다.
    let legacy
    for (let attempt = 0; attempt < 100 && !legacy?.runnerRejection; attempt++) {
      legacy = (await listDelegations()).delegations.find((item) => item.id === legacyId)
      if (!legacy?.runnerRejection) await pause(100)
    }
    assert.ok(legacy?.runnerRejection, server.diagnostics)
    assert.equal(legacy.state, 'starting')
    assert.equal(legacy.runnerRejection.code, 'RUNNER_OPERATION_REJECTED')
    assert.equal(legacy.runnerRejection.operationId, legacyId)
    assert.equal(legacy.runnerRejection.machineId, 'macbook')
    assert.deepEqual(legacy.closure, { closeAvailable: true, reason: 'runner-rejected-operation' })
    assert.ok(runner.requests.some((item) => item.pathname === `/api/internal/external-conversation-dispatches/${encodeURIComponent(legacyId)}`),
      '콜론은 %3A로 인코딩되어 Runner 경로 검사에서 거부된다')

    // 2) 상태 다시 확인은 일반 500 대신 원인 코드를 돌려주고 AI를 다시 실행하지 않는다.
    let map = await currentMap()
    const refreshed = await request(baseUrl, cookie, `/api/maps/${mapId}/ai-delegations/${encodeURIComponent(legacyId)}/refresh`, 'POST', {
      expectedUpdatedAt: legacy.updatedAt, sourceRevision: map.version, targetRevision: map.version,
    })
    assert.equal(refreshed.response.status, 409, JSON.stringify(refreshed.body))
    assert.equal(refreshed.body.code, 'AI_DELEGATION_RUNNER_REJECTED')
    assert.equal(refreshed.body.executionRequested, false)
    assert.equal(refreshed.body.delegation.state, 'starting')
    assert.equal(refreshed.body.delegation.runnerRejection.operationId, legacyId)

    // 3) 대상 대화가 아직 실행 중이면 종료하지 않는다.
    const closeBody = () => ({
      expectedUpdatedAt: legacy.updatedAt, sourceRevision: map.version, targetRevision: map.version,
      reason: 'no-longer-needed', note: '서브 머신 Runner 거부로 멈춘 위임 정리',
      confirmClosedWithoutCompletion: true, confirmResultReportDiscarded: true,
    })
    legacy = (await listDelegations()).delegations.find((item) => item.id === legacyId)
    map = await currentMap()
    const busyClose = await request(baseUrl, cookie, `/api/maps/${mapId}/ai-delegations/${encodeURIComponent(legacyId)}/close`, 'POST', closeBody())
    assert.equal(busyClose.response.status, 409, JSON.stringify(busyClose.body))
    assert.match(busyClose.body.error, /대상 AI 대화가 아직 실행 중/)
    assert.equal((await listDelegations()).delegations.find((item) => item.id === legacyId).state, 'starting')

    // 4) 대화가 끝나면 사용자 종료로 정리한다. 하위 실행이나 결과 보고는 요청하지 않는다.
    childRuntime = { state: 'idle' }
    legacy = (await listDelegations()).delegations.find((item) => item.id === legacyId)
    map = await currentMap()
    const closed = await request(baseUrl, cookie, `/api/maps/${mapId}/ai-delegations/${encodeURIComponent(legacyId)}/close`, 'POST', closeBody())
    assert.equal(closed.response.status, 200, JSON.stringify(closed.body))
    assert.equal(closed.body.delegation.state, 'closed')
    assert.equal(closed.body.delegation.closureSourceState, 'starting')
    assert.equal(closed.body.delegation.closureReason, 'no-longer-needed')
    assert.equal(closed.body.childExecutionRequested, false)
    assert.equal(closed.body.resultReported, false)

    // 5) 새 위임의 콜론 ID는 접수 전에 거부하고 접수 실패 기록도 남기지 않는다.
    map = await currentMap()
    const scope = { 'X-MnP-AI-Map-Id': mapId, 'X-MnP-AI-Card-Id': 'root-card', 'X-MnP-AI-Conversation-Id': 'parent-on-mac' }
    const delegationBody = (idempotencyKey) => ({
      targetCardId: 'child-card', sourceRevision: map.version, strategy: 'new', machineId: 'macbook',
      instruction: '하위 작업을 진행하세요.', decisionReason: '독립된 하위 작업입니다.', idempotencyKey,
      newConversation: { agentId: 'claude', modelId: 'opus', workspace: '/Users/editor/project' },
    })
    const colon = await request(baseUrl, cookie, `/api/maps/${mapId}/ai-delegations`, 'POST', delegationBody('v2:child-card:new'), scope)
    assert.equal(colon.response.status, 400, JSON.stringify(colon.body))
    assert.equal(colon.body.reasonCode, 'AI_DELEGATION_ID_UNSUPPORTED')
    const listed = await listDelegations()
    assert.equal(listed.delegations.some((item) => item.id === 'v2:child-card:new'), false)
    assert.deepEqual(listed.requestFailures, [])

    // 6) 이미 있는 콜론 ID의 재요청은 새 규칙에 막히지 않고 기존 멱등 검사로 처리한다.
    const replay = await request(baseUrl, cookie, `/api/maps/${mapId}/ai-delegations`, 'POST', delegationBody(legacyId), scope)
    assert.equal(replay.response.status, 409, JSON.stringify(replay.body))
    assert.equal(replay.body.reasonCode, 'AI_DELEGATION_IDEMPOTENCY_CONFLICT')

    // 7) 새 그룹 문서 지시도 콜론 ID를 거부한다.
    const instruction = await request(baseUrl, cookie, `/api/maps/${mapId}/group-document-instructions`, 'POST', {
      idempotencyKey: 'v1:group:colon', targetMapId: 'map-other-target', strategy: 'new',
      instructionType: 'execution', approvalScope: 'implementation', approvalEvidence: '사용자 승인',
      instruction: '대상 문서를 정비하세요.', decisionReason: '문서 담당 대화가 없습니다.',
      sourceRevision: 1, targetRevision: 1, groupProjectVersion: 1,
    }, scope)
    assert.equal(instruction.response.status, 400, JSON.stringify(instruction.body))
    assert.equal(instruction.body.reasonCode, 'GROUP_DOCUMENT_INSTRUCTION_ID_UNSUPPORTED')
  } finally {
    if (runner) await runner.stop()
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
