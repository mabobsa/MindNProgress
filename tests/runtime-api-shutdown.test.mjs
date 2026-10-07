import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const project = path.resolve(import.meta.dirname, '..')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('실제 API는 머신 요청·25초 롱폴·본문이 멈춘 로컬 AionUi 응답을 종료 신호로 해제한다', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-api-shutdown-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const email = 'shutdown-test@mind.local', password = 'isolated-shutdown-test-password'
  let localReceived = false
  const aion = createServer((_request, response) => {
    localReceived = true
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{"success":true,"data":')
  })
  await new Promise(resolve => aion.listen(0, '127.0.0.1', resolve))
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, MNP_DATA_DIR: path.join(directory, 'data'), MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port), MNP_API_HOST: '127.0.0.1', MNP_MACHINE_ID: 'shutdown-main',
      MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'),
      MNP_AIONUI_URL: `http://127.0.0.1:${aion.address().port}`,
      MNP_AIONUI_DISCOVERY_FILE: path.join(directory, 'no-aion.json'),
      MNP_ADMIN_EMAIL: email, MNP_ADMIN_PASSWORD: password },
  })
  let output = '', ipcReady = false
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  child.on('message', message => { if (message?.type === 'mnp:shutdown-ready') ipcReady = true })
  const done = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  const request = async (pathname, headers = {}, body) => {
    const response = await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) })
    return { status: response.status, body: await response.json(), response }
  }
  try {
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, output)
      try { if (ipcReady && (await fetch(base + '/api/health')).ok) break } catch {}
      await wait(100)
    }
    assert.ok(ipcReady, output)
    const login = await request('/api/auth/login', {}, { email, password })
    assert.equal(login.status, 200)
    const cookie = { Cookie: login.response.headers.get('set-cookie').split(';')[0] }
    const tokens = {}
    for (const machineId of ['busy', 'idle']) {
      assert.equal((await request('/api/machines', cookie, { machineId, label: machineId })).status, 200)
      const issued = await request(`/api/machines/${machineId}/token`, cookie)
      assert.equal(issued.status, 200)
      tokens[machineId] = { Authorization: `Bearer ${issued.body.token}` }
      assert.equal((await request(`/api/machines/${machineId}/runner/heartbeat`, tokens[machineId])).status, 200)
    }
    const deliveredProbe = request('/api/machines/busy/probe', cookie)
    const claimed = await request('/api/machines/busy/runner/operations/claim', tokens.busy)
    assert.equal(claimed.status, 200)
    assert.equal(claimed.body.operations.length, 1)
    // 결과를 보내지 않는 이미 전달된 요청, 아직 가져가지 않은 요청, 빈 큐 롱폴을 함께 남긴다.
    const pendingProbe = request('/api/machines/busy/probe', cookie)
    const idlePoll = request('/api/machines/idle/runner/operations/claim', tokens.idle)
    const localProbe = request('/api/machines/shutdown-main/probe', cookie)
    let blocked = false
    for (let i = 0; i < 50; i++) {
      const busy = await request('/api/machines/busy/runner/heartbeat', tokens.busy)
      const idle = await request('/api/machines/idle/runner/heartbeat', tokens.idle)
      if (busy.body.queue.pending === 1 && busy.body.queue.dispatched === 1 && idle.body.queue.waiting === 1 && localReceived) { blocked = true; break }
      await wait(20)
    }
    assert.ok(blocked, '머신 요청 두 개와 Runner 롱폴이 실제로 대기해야 한다.')
    const started = performance.now()
    child.send({ type: 'mnp:shutdown' })
    for (const result of await Promise.all([deliveredProbe, pendingProbe, idlePoll, localProbe])) {
      assert.equal(result.status, 503)
      assert.equal(result.body.reasonCode, 'RUNTIME_STOPPING')
    }
    assert.equal(await done, 0, output)
    const elapsed = Math.round(performance.now() - started)
    assert.ok(elapsed < 5000, output)
    assert.match(output, /machine operation waits interrupted/)
    assert.match(output, /"deliveryState":"dispatched"/)
    assert.match(output, /"deliveryState":"pending"/)
    assert.match(output, /graceful shutdown/)
    assert.doesNotMatch(output, /QUEUE_CLOSED|Runtime shutdown failed/)
    console.log(`[isolated API shutdown with machine waits] ${elapsed}ms`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'mnp:shutdown' }, () => {})
      await Promise.race([done, wait(2000)])
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await done }
    }
    aion.closeAllConnections()
    await new Promise(resolve => aion.close(resolve))
    assert.equal(path.dirname(directory), tmpdir())
    assert.ok(path.basename(directory).startsWith('mnp-api-shutdown-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
