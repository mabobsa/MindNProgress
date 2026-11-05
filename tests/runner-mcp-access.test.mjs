import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isRunnerMcpApiPathAllowed } from '../server/lib/runnerMcpAccess.mjs'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const adminEmail = 'runner-mcp-admin@mind.local'
const adminPassword = 'runner-mcp-admin-password'
const conversationId = 'conversation-on-sub-machine'

test('Runner 구독 사용량 조회는 정확한 경로의 GET만 허용한다', () => {
  const pathname = '/api/integrations/aionui/subscription-usage'
  assert.equal(isRunnerMcpApiPathAllowed('GET', pathname), true)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal(isRunnerMcpApiPathAllowed(method, pathname), false)
  }
  assert.equal(isRunnerMcpApiPathAllowed('GET', `${pathname}/extra`), false)
})

test('Runner 세션 메시지 중계는 정확한 경로의 POST만 허용한다', () => {
  const pathname = '/api/integrations/aionui/session-messages'
  assert.equal(isRunnerMcpApiPathAllowed('POST', pathname), true)
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal(isRunnerMcpApiPathAllowed(method, pathname), false)
  }
  assert.equal(isRunnerMcpApiPathAllowed('POST', `${pathname}/extra`), false)
})

test('Runner 카드 탐색은 조회 GET과 선택 POST 경로만 허용한다', () => {
  const pathname = `/api/integrations/aionui/conversations/${conversationId}/mindnprogress`
  assert.equal(isRunnerMcpApiPathAllowed('GET', pathname), true)
  assert.equal(isRunnerMcpApiPathAllowed('POST', `${pathname}/select`), true)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal(isRunnerMcpApiPathAllowed(method, pathname), false)
  }
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal(isRunnerMcpApiPathAllowed(method, `${pathname}/select`), false)
  }
  assert.equal(isRunnerMcpApiPathAllowed('GET', `${pathname}/extra`), false)
})

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
  throw new Error('Runner MCP 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

async function stopServer(server) {
  if (server.exitCode !== null) return
  server.kill()
  await new Promise((resolve) => server.once('exit', resolve))
}

async function jsonRequest(baseUrl, pathname, { method = 'GET', cookie = '', token = '', headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, body: await response.json() }
}

test('Runner MCP만 머신 대화로 승격하고 로컬·외부 웹 인증은 그대로 유지한다', { timeout: 45_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-mcp-'))
  await writeFile(path.join(dataDirectory, '_ai-conversation-origins.json'), JSON.stringify([{
    conversationId,
    homeMachineId: 'macbook',
    mapId: 'map-runner-mcp',
    cardId: 'root-card',
    startedBy: 'user-admin',
    linkedAt: new Date().toISOString(),
  }]))
  await writeFile(path.join(dataDirectory, '_ai-attributions.json'), JSON.stringify([{
    tokenHash: 'a'.repeat(64),
    conversationId: 'unlinked-approved-conversation',
    homeMachineId: 'macbook',
    startedBy: 'user-admin',
    authorName: '승인 실행 AI',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  }]))
  const port = 40_000 + Math.floor(Math.random() * 4_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_MACHINE_ID: 'desk-win',
      MNP_ADMIN_EMAIL: adminEmail,
      MNP_ADMIN_PASSWORD: adminPassword,
    },
    stdio: 'ignore',
  })

  try {
    await waitForServer(baseUrl)
    const login = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: adminPassword },
    })
    assert.equal(login.response.status, 200)
    const cookie = login.response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)

    assert.equal((await jsonRequest(baseUrl, '/api/machines', {
      method: 'POST', cookie, body: { machineId: 'macbook', label: '개발 맥북', platform: 'darwin' },
    })).response.status, 200)
    const issued = await jsonRequest(baseUrl, '/api/machines/macbook/token', { method: 'POST', cookie })
    assert.equal(issued.response.status, 200)
    const runnerToken = issued.body.token
    const integrationToken = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()

    // 외부 웹 포트의 계정 세션과 메인 로컬 MCP의 전역 연동 토큰은 기존 계약을 유지한다.
    assert.equal((await jsonRequest(baseUrl, '/api/maps', { cookie })).response.status, 200)
    assert.equal((await jsonRequest(baseUrl, '/api/maps', { token: integrationToken })).response.status, 200)

    const runnerHeaders = {
      'X-MnP-Runner-MCP-Machine-Id': 'macbook',
      'X-MnP-AI-Conversation-Id': conversationId,
    }
    const relayed = await jsonRequest(baseUrl, '/api/maps', { token: runnerToken, headers: runnerHeaders })
    assert.equal(relayed.response.status, 200)

    const usagePath = '/api/integrations/aionui/subscription-usage'
    const usage = await jsonRequest(baseUrl, usagePath, { token: runnerToken, headers: runnerHeaders })
    assert.equal(usage.response.status, 200)
    assert.equal(typeof usage.body.usage.available, 'boolean')
    const untrustedUsage = await jsonRequest(baseUrl, usagePath, {
      token: runnerToken, headers: { 'X-MnP-Runner-MCP-Machine-Id': 'macbook' },
    })
    assert.equal(untrustedUsage.response.status, 403)
    assert.equal(untrustedUsage.body.code, 'MNP_RUNNER_MCP_CONVERSATION_DENIED')

    const navigationPath = `/api/integrations/aionui/conversations/${conversationId}/mindnprogress`
    const unlinked = await jsonRequest(baseUrl, navigationPath, { token: runnerToken, headers: runnerHeaders })
    assert.equal(unlinked.response.status, 200)
    assert.equal(unlinked.body.exists, false)

    for (const suffix of ['', '/select']) {
      const method = suffix ? 'POST' : 'GET'
      const crossConversation = await jsonRequest(baseUrl,
        `/api/integrations/aionui/conversations/another-conversation/mindnprogress${suffix}`,
        { method, token: runnerToken, headers: runnerHeaders })
      assert.equal(crossConversation.response.status, 403)
      assert.equal(crossConversation.body.code, 'MNP_RUNNER_MCP_CONVERSATION_DENIED')

      const wrongAccount = await jsonRequest(baseUrl, `${navigationPath}${suffix}`, {
        method, token: runnerToken, headers: { ...runnerHeaders, 'X-MnP-AI-Editor-Id': 'user-other' },
      })
      assert.equal(wrongAccount.response.status, 403)
      assert.equal(wrongAccount.body.code, 'MNP_RUNNER_MCP_ACCOUNT_MISMATCH')

      const invalidToken = await jsonRequest(baseUrl, `${navigationPath}${suffix}`, {
        method, token: 'invalid-machine-token', headers: runnerHeaders,
      })
      assert.equal(invalidToken.response.status, 401)
      assert.equal(invalidToken.body.code, 'MNP_RUNNER_MCP_AUTH_FAILED')
    }

    const approvedWithoutCardLink = await jsonRequest(baseUrl, '/api/maps', {
      token: runnerToken,
      headers: {
        'X-MnP-Runner-MCP-Machine-Id': 'macbook',
        'X-MnP-AI-Conversation-Id': 'unlinked-approved-conversation',
      },
    })
    assert.equal(approvedWithoutCardLink.response.status, 200)

    const missingConversation = await jsonRequest(baseUrl, '/api/maps', {
      token: runnerToken,
      headers: { 'X-MnP-Runner-MCP-Machine-Id': 'macbook' },
    })
    assert.equal(missingConversation.response.status, 403)
    assert.equal(missingConversation.body.code, 'MNP_RUNNER_MCP_CONVERSATION_DENIED')

    const mismatchedAccount = await jsonRequest(baseUrl, '/api/maps', {
      token: runnerToken,
      headers: { ...runnerHeaders, 'X-MnP-AI-Editor-Id': 'user-other' },
    })
    assert.equal(mismatchedAccount.response.status, 403)
    assert.equal(mismatchedAccount.body.code, 'MNP_RUNNER_MCP_ACCOUNT_MISMATCH')

    const forbiddenRoute = await jsonRequest(baseUrl, '/api/auth/me', { token: runnerToken, headers: runnerHeaders })
    assert.equal(forbiddenRoute.response.status, 403)
    assert.equal(forbiddenRoute.body.code, 'MNP_RUNNER_MCP_PATH_DENIED')
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
