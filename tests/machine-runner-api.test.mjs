import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const adminEmail = 'runner-admin@mind.local'
const adminPassword = 'runner-admin-password'

async function waitForServer(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // 서버 시작 대기
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Runner API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

function startServer(dataDirectory, port, extraEnv = {}) {
  return spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_MACHINE_ID: 'desk-win',
      MNP_MACHINE_LABEL: '메인 데스크탑',
      MNP_ADMIN_EMAIL: adminEmail,
      MNP_ADMIN_PASSWORD: adminPassword,
      ...extraEnv,
    },
    stdio: 'ignore',
  })
}

async function stopServer(server) {
  if (server.exitCode !== null) return
  server.kill()
  await new Promise((resolve) => server.once('exit', resolve))
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return cookie
}

async function userRequest(baseUrl, cookie, pathname, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, body: await response.json() }
}

async function runnerRequest(baseUrl, token, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, body: await response.json() }
}

async function registerMacbook(baseUrl, cookie) {
  const registered = await userRequest(baseUrl, cookie, '/api/machines', 'POST', {
    machineId: 'macbook',
    label: '맥북',
    platform: 'darwin',
  })
  assert.equal(registered.response.status, 200)
  const issued = await userRequest(baseUrl, cookie, '/api/machines/macbook/token', 'POST')
  assert.equal(issued.response.status, 200)
  assert.match(issued.body.token, /^mnprn_[A-Za-z0-9_-]{20,}$/)
  return issued.body.token
}

test('Runner가 오퍼레이션을 가져가 결과를 올리면 요청자에게 응답이 전달된다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-'))
  const port = 4_962
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl)
    const token = await registerMacbook(baseUrl, cookie)

    // 연결 확인 요청은 Runner가 결과를 올릴 때까지 완료되지 않는다.
    const probe = userRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')

    const claimed = await runnerRequest(baseUrl, token, '/api/machines/macbook/runner/operations/claim', { waitMs: 10_000 })
    assert.equal(claimed.response.status, 200)
    assert.equal(claimed.body.operations.length, 1)
    assert.equal(claimed.body.operations[0].request.pathname, '/api/internal/conversation-runtimes/active')
    assert.equal(claimed.body.operations[0].request.method, 'GET')

    const operationId = claimed.body.operations[0].operationId
    const settled = await runnerRequest(baseUrl, token, `/api/machines/macbook/runner/operations/${operationId}/result`, {
      ok: true,
      data: { schema_version: 1, items: [{ conversation_id: 'abc', runtime: {} }] },
    })
    assert.equal(settled.response.status, 200)
    assert.equal(settled.body.state, 'succeeded')

    const probed = await probe
    assert.equal(probed.response.status, 200)
    assert.equal(probed.body.reachable, true)
    assert.equal(probed.body.conversationCount, 1)
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('Runner가 실패를 올리면 요청자에게 실패로 전달한다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-fail-'))
  const port = 4_963
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl)
    const token = await registerMacbook(baseUrl, cookie)

    const probe = userRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')
    const claimed = await runnerRequest(baseUrl, token, '/api/machines/macbook/runner/operations/claim', { waitMs: 10_000 })
    const operationId = claimed.body.operations[0].operationId

    await runnerRequest(baseUrl, token, `/api/machines/macbook/runner/operations/${operationId}/result`, {
      ok: false,
      status: 503,
      code: 'AIONUI_DOWN',
    })

    const probed = await probe
    assert.equal(probed.body.reachable, false)
    assert.match(probed.body.error, /AIONUI_REQUEST_FAILED:503/)

    // 같은 오퍼레이션에 결과를 두 번 올리면 거부한다.
    const duplicated = await runnerRequest(baseUrl, token, `/api/machines/macbook/runner/operations/${operationId}/result`, { ok: true })
    assert.equal(duplicated.response.status, 409)
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('Runner 토큰이 없거나 틀리면 오퍼레이션을 가져갈 수 없다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-auth-'))
  const port = 4_964
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl)
    const token = await registerMacbook(baseUrl, cookie)

    const claimPath = '/api/machines/macbook/runner/operations/claim'
    assert.equal((await runnerRequest(baseUrl, 'wrong-token', claimPath, { waitMs: 0 })).response.status, 401)
    assert.equal((await fetch(`${baseUrl}${claimPath}`, { method: 'POST' })).status, 401)

    // 메인 머신에는 Runner 토큰을 발급하지 않으므로 Runner로 접근할 수 없다.
    const mainToken = await userRequest(baseUrl, cookie, '/api/machines/desk-win/token', 'POST')
    assert.equal(mainToken.response.status, 400)
    assert.equal((await runnerRequest(baseUrl, token, '/api/machines/desk-win/runner/operations/claim', { waitMs: 0 })).response.status, 401)

    // 토큰을 폐기하면 곧바로 인증이 막힌다.
    assert.equal((await userRequest(baseUrl, cookie, '/api/machines/macbook/token', 'DELETE')).response.status, 200)
    assert.equal((await runnerRequest(baseUrl, token, claimPath, { waitMs: 0 })).response.status, 401)
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('Runner가 연결되지 않은 머신 요청은 전달 상한이 지나면 실패한다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-offline-'))
  const port = 4_965
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port, { MNP_MACHINE_DISPATCH_TIMEOUT_MS: '5000' })

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl)
    await registerMacbook(baseUrl, cookie)

    const probed = await userRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')
    assert.equal(probed.response.status, 200)
    assert.equal(probed.body.reachable, false)
    assert.equal(probed.body.reasonCode, 'RUNNER_UNAVAILABLE')
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('토큰을 발급하지 않은 머신과 등록되지 않은 머신은 즉시 사유를 알려준다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-unconfigured-'))
  const port = 4_966
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl)
    await userRequest(baseUrl, cookie, '/api/machines', 'POST', { machineId: 'macbook', label: '맥북' })

    const unconfigured = await userRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')
    assert.equal(unconfigured.body.reachable, false)
    assert.equal(unconfigured.body.reasonCode, 'RUNNER_NOT_CONFIGURED')

    const unknown = await userRequest(baseUrl, cookie, '/api/machines/unknown/probe', 'POST')
    assert.equal(unknown.response.status, 404)

    // 메인 머신 연결 확인은 기존 루프백 경로를 그대로 사용한다.
    const main = await userRequest(baseUrl, cookie, '/api/machines/desk-win/probe', 'POST')
    assert.equal(main.response.status, 200)
    assert.equal(main.body.machineId, 'desk-win')
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
