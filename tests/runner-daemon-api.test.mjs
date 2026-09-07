// 실제 Runner 프로세스를 띄워 메인 머신 MnP와 가짜 로컬 AionUi 사이를 왕복시킨다.
// 큐·인증·long-poll·결과 전달이 실제 프로세스 경계를 넘어 동작하는지 확인한다.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const adminEmail = 'runner-daemon@mind.local'
const adminPassword = 'runner-daemon-password'

async function waitFor(check, { timeoutMs = 20_000, label = '조건' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label}이 제한 시간 안에 충족되지 않았습니다.`)
}

function startMnpServer(dataDirectory, port) {
  return spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_MACHINE_ID: 'desk-win',
      MNP_ADMIN_EMAIL: adminEmail,
      MNP_ADMIN_PASSWORD: adminPassword,
      // 테스트가 오래 매달리지 않도록 대기 시간과 전달 상한을 줄인다.
      MNP_MACHINE_LONG_POLL_MS: '2000',
      MNP_MACHINE_DISPATCH_TIMEOUT_MS: '5000',
    },
    stdio: 'ignore',
  })
}

// AionUi 백엔드를 대신하는 최소 서버다. 받은 요청을 기록해 Runner가 그대로 전달했는지 확인한다.
function startFakeAionUi(port) {
  const received = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : undefined })

      if (request.url === '/api/internal/conversation-runtimes/active') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ schema_version: 1, items: [{ conversation_id: 'sub-1', runtime: {} }] }))
        return
      }
      if (request.url === '/api/broken') {
        response.writeHead(503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'AIONUI_BUSY' } }))
        return
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, received }))
  })
}

function startRunner(apiPort, aionUiPort, machineId, token) {
  return spawn(process.execPath, ['runner/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_RUNNER_API_URL: `http://127.0.0.1:${apiPort}`,
      MNP_RUNNER_AIONUI_URL: `http://127.0.0.1:${aionUiPort}`,
      MNP_RUNNER_MACHINE_ID: machineId,
      MNP_RUNNER_TOKEN: token,
      MNP_RUNNER_RETRY_MS: '500',
    },
    stdio: 'ignore',
  })
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => child.once('exit', resolve))
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie')?.split(';')[0]
}

async function apiRequest(baseUrl, cookie, pathname, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, body: await response.json() }
}

test('실제 Runner 프로세스가 메인 머신 요청을 로컬 AionUi로 중계한다', { timeout: 90_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-daemon-'))
  const apiPort = 4_968
  const aionUiPort = 4_969
  const baseUrl = `http://127.0.0.1:${apiPort}`

  const mnpServer = startMnpServer(dataDirectory, apiPort)
  const { server: fakeAionUi, received } = await startFakeAionUi(aionUiPort)
  let runner = null

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/api/health`)).ok
      } catch {
        return false
      }
    }, { label: 'MnP 서버 시작' })

    const cookie = await login(baseUrl)
    assert.equal((await apiRequest(baseUrl, cookie, '/api/machines', 'POST', {
      machineId: 'macbook', label: '맥북', platform: 'darwin',
    })).response.status, 200)
    const issued = await apiRequest(baseUrl, cookie, '/api/machines/macbook/token', 'POST')
    assert.equal(issued.response.status, 200)

    // Runner가 붙기 전에는 전달할 곳이 없다.
    const beforeRunner = await apiRequest(baseUrl, cookie, '/api/machines')
    assert.equal(beforeRunner.body.machines.find((machine) => machine.machineId === 'macbook').lastSeenAt, null)

    runner = startRunner(apiPort, aionUiPort, 'macbook', issued.body.token)

    // 하트비트가 도착하면 마지막 접속 시각이 기록된다.
    await waitFor(async () => {
      const listed = await apiRequest(baseUrl, cookie, '/api/machines')
      return Boolean(listed.body.machines.find((machine) => machine.machineId === 'macbook').lastSeenAt)
    }, { label: 'Runner 하트비트' })

    // 연결 확인 요청이 Runner를 거쳐 가짜 AionUi까지 갔다 돌아온다.
    const probed = await apiRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')
    assert.equal(probed.response.status, 200)
    assert.equal(probed.body.reachable, true)
    assert.equal(probed.body.conversationCount, 1)

    const relayed = received.filter((entry) => entry.url === '/api/internal/conversation-runtimes/active')
    assert.equal(relayed.length, 1)
    assert.equal(relayed[0].method, 'GET')

    // 연속 요청도 같은 Runner가 계속 처리한다.
    const again = await apiRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')
    assert.equal(again.body.reachable, true)
    assert.equal(received.filter((entry) => entry.url === '/api/internal/conversation-runtimes/active').length, 2)

    // Runner를 내리면 long-poll이 끊긴다. 그 요청이 가져간 오퍼레이션은 대기열로 되돌아가고,
    // 받을 Runner가 없으므로 전달 상한에서 사유와 함께 실패한다.
    await stopProcess(runner)
    runner = null
    const stoppedAt = Date.now()
    const afterStop = await apiRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')
    assert.equal(afterStop.body.reachable, false)
    assert.equal(afterStop.body.reasonCode, 'RUNNER_UNAVAILABLE')
    // 끊긴 long-poll이 오퍼레이션을 가져가 버리면 전달 상한(5초) 대신 결과 상한(기본 180초)까지 묶인다.
    assert.ok(Date.now() - stoppedAt < 30_000, '끊긴 Runner가 오퍼레이션을 결과 상한까지 붙잡았습니다.')
  } finally {
    await stopProcess(runner)
    await stopProcess(mnpServer)
    await new Promise((resolve) => fakeAionUi.close(resolve))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

// 개발 서버는 0.0.0.0에 바인딩되고 /api를 로컬 API로 프록시한다.
// Runner도 브라우저와 같은 공개 주소를 쓰므로 API 포트를 LAN에 열지 않아도 된다.
// Vite 프록시는 proxyTimeout을 설정하지 않아 timeout이 없으므로, 여기서도 timeout 없는 프록시로 재현한다.
function startApiProxy(proxyPort, apiPort) {
  const server = createServer((request, response) => {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: apiPort,
      method: request.method,
      path: request.url,
      // Vite가 xfwd로 실제 접속 주소를 전달하는 동작을 재현한다.
      headers: { ...request.headers, 'x-forwarded-for': request.socket.remoteAddress ?? '' },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    request.pipe(upstream)
  })
  return new Promise((resolve) => server.listen(proxyPort, '127.0.0.1', () => resolve(server)))
}

test('Runner는 API 포트를 열지 않고 공개 주소의 프록시를 거쳐 동작한다', { timeout: 90_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-proxy-'))
  const apiPort = 4_974
  const proxyPort = 4_975
  const aionUiPort = 4_976
  const baseUrl = `http://127.0.0.1:${apiPort}`

  const mnpServer = startMnpServer(dataDirectory, apiPort)
  const proxy = await startApiProxy(proxyPort, apiPort)
  const { server: fakeAionUi, received } = await startFakeAionUi(aionUiPort)
  let runner = null

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/api/health`)).ok
      } catch {
        return false
      }
    }, { label: 'MnP 서버 시작' })

    const cookie = await login(baseUrl)
    await apiRequest(baseUrl, cookie, '/api/machines', 'POST', { machineId: 'macbook', label: '맥북' })
    const issued = await apiRequest(baseUrl, cookie, '/api/machines/macbook/token', 'POST')

    // Runner는 API 포트가 아니라 프록시 주소만 알고 있다.
    runner = startRunner(proxyPort, aionUiPort, 'macbook', issued.body.token)

    await waitFor(async () => {
      const listed = await apiRequest(baseUrl, cookie, '/api/machines')
      return Boolean(listed.body.machines.find((machine) => machine.machineId === 'macbook').lastSeenAt)
    }, { label: '프록시 경유 하트비트' })

    // long-poll이 프록시를 통과해 유지되는지 확인한다.
    const probed = await apiRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')
    assert.equal(probed.body.reachable, true)
    assert.equal(probed.body.conversationCount, 1)
    assert.equal(received.filter((entry) => entry.url === '/api/internal/conversation-runtimes/active').length, 1)
  } finally {
    await stopProcess(runner)
    await stopProcess(mnpServer)
    await new Promise((resolve) => proxy.close(resolve))
    await new Promise((resolve) => fakeAionUi.close(resolve))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('로컬 AionUi가 오류를 주면 Runner가 상태를 그대로 올린다', { timeout: 90_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-runner-daemon-fail-'))
  const apiPort = 4_970
  const aionUiPort = 4_971
  const baseUrl = `http://127.0.0.1:${apiPort}`

  const mnpServer = startMnpServer(dataDirectory, apiPort)
  const { server: fakeAionUi } = await startFakeAionUi(aionUiPort)
  let runner = null

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/api/health`)).ok
      } catch {
        return false
      }
    }, { label: 'MnP 서버 시작' })

    const cookie = await login(baseUrl)
    await apiRequest(baseUrl, cookie, '/api/machines', 'POST', { machineId: 'macbook', label: '맥북' })
    const issued = await apiRequest(baseUrl, cookie, '/api/machines/macbook/token', 'POST')

    // 로컬 AionUi를 내려 연결 자체가 실패하는 상황을 만든다.
    await new Promise((resolve) => fakeAionUi.close(resolve))
    runner = startRunner(apiPort, aionUiPort, 'macbook', issued.body.token)

    await waitFor(async () => {
      const listed = await apiRequest(baseUrl, cookie, '/api/machines')
      return Boolean(listed.body.machines.find((machine) => machine.machineId === 'macbook').lastSeenAt)
    }, { label: 'Runner 하트비트' })

    // Runner가 실패를 곧바로 올리므로 요청자는 서버 상한까지 기다리지 않는다.
    const startedAt = Date.now()
    const probed = await apiRequest(baseUrl, cookie, '/api/machines/macbook/probe', 'POST')
    assert.equal(probed.body.reachable, false)
    assert.notEqual(probed.body.reasonCode, 'RUNNER_UNAVAILABLE')
    assert.ok(Date.now() - startedAt < 25_000, '실패 결과가 전달 상한을 기다렸습니다.')
  } finally {
    await stopProcess(runner)
    await stopProcess(mnpServer)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
