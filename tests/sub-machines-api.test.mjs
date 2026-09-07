import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const adminEmail = 'machine-admin@mind.local'
const adminPassword = 'machine-admin-password'

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
  throw new Error('머신 레지스트리 API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
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

async function login(baseUrl, email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return cookie
}

async function apiRequest(baseUrl, cookie, pathname, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, body: await response.json() }
}

test('머신 레지스트리와 사용자별 분산 작업 설정을 관리한다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-machines-'))
  const port = 4_960
  const baseUrl = `http://127.0.0.1:${port}`
  let server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl, adminEmail, adminPassword)

    // 메인 머신은 서버가 기동할 때 자동으로 등록되고 항상 목록 맨 앞에 온다.
    const initial = await apiRequest(baseUrl, cookie, '/api/machines')
    assert.equal(initial.response.status, 200)
    assert.equal(initial.body.mainMachineId, 'desk-win')
    assert.deepEqual(initial.body.machines.map((machine) => machine.machineId), ['desk-win'])
    assert.equal(initial.body.machines[0].role, 'main')
    assert.equal(initial.body.machines[0].label, '메인 데스크탑')

    // 활성화 전에는 메인 머신만 위임 대상으로 노출한다.
    const beforeEnable = await apiRequest(baseUrl, cookie, '/api/account/distributed-work')
    assert.equal(beforeEnable.response.status, 200)
    assert.deepEqual(beforeEnable.body.settings, { enabled: false, defaultMachineId: null })
    assert.deepEqual(beforeEnable.body.targets.machines.map((machine) => machine.machineId), ['desk-win'])

    const registered = await apiRequest(baseUrl, cookie, '/api/machines', 'POST', {
      machineId: 'macbook',
      label: '맥북',
      platform: 'darwin',
      workspacePoolIds: ['holdem'],
    })
    assert.equal(registered.response.status, 200)
    assert.deepEqual(registered.body.machines.map((machine) => machine.machineId), ['desk-win', 'macbook'])
    assert.equal(registered.body.machines[1].role, 'sub')

    // 서브 머신을 등록해도 활성화하지 않은 사용자의 대상 목록은 그대로다.
    const stillMainOnly = await apiRequest(baseUrl, cookie, '/api/account/distributed-work')
    assert.deepEqual(stillMainOnly.body.targets.machines.map((machine) => machine.machineId), ['desk-win'])

    const enabled = await apiRequest(baseUrl, cookie, '/api/account/distributed-work', 'PUT', {
      enabled: true,
      defaultMachineId: 'macbook',
    })
    assert.equal(enabled.response.status, 200)
    assert.deepEqual(enabled.body.settings, { enabled: true, defaultMachineId: 'macbook' })
    assert.deepEqual(enabled.body.targets.machines.map((machine) => machine.machineId), ['desk-win', 'macbook'])

    // 등록되지 않은 머신은 기본값으로 저장하지 않는다.
    const rejected = await apiRequest(baseUrl, cookie, '/api/account/distributed-work', 'PUT', {
      enabled: true,
      defaultMachineId: 'unknown',
    })
    assert.equal(rejected.response.status, 400)

    const invalidMachine = await apiRequest(baseUrl, cookie, '/api/machines', 'POST', {
      machineId: 'bad_id',
      label: '형식 오류',
    })
    assert.equal(invalidMachine.response.status, 400)

    const mainAsSub = await apiRequest(baseUrl, cookie, '/api/machines', 'POST', {
      machineId: 'desk-win',
      label: '메인 재등록',
    })
    assert.equal(mainAsSub.response.status, 400)

    const mainDelete = await apiRequest(baseUrl, cookie, '/api/machines', 'DELETE', { machineId: 'desk-win' })
    assert.equal(mainDelete.response.status, 400)

    // 재시작 후에도 등록과 설정이 유지된다.
    await stopServer(server)
    server = startServer(dataDirectory, port)
    await waitForServer(baseUrl)
    const restartedCookie = await login(baseUrl, adminEmail, adminPassword)

    const restored = await apiRequest(baseUrl, restartedCookie, '/api/account/distributed-work')
    assert.deepEqual(restored.body.settings, { enabled: true, defaultMachineId: 'macbook' })
    assert.deepEqual(restored.body.targets.machines.map((machine) => machine.machineId), ['desk-win', 'macbook'])

    const storedMachines = JSON.parse(await readFile(path.join(dataDirectory, '_machines.json'), 'utf8'))
    assert.deepEqual(storedMachines.map((machine) => [machine.machineId, machine.role]), [
      ['desk-win', 'main'],
      ['macbook', 'sub'],
    ])

    // 머신을 삭제하면 그 머신을 기본값으로 쓰던 설정도 함께 해제된다.
    const removed = await apiRequest(baseUrl, restartedCookie, '/api/machines', 'DELETE', { machineId: 'macbook' })
    assert.equal(removed.response.status, 200)
    assert.deepEqual(removed.body.machines.map((machine) => machine.machineId), ['desk-win'])

    const afterRemoval = await apiRequest(baseUrl, restartedCookie, '/api/account/distributed-work')
    assert.deepEqual(afterRemoval.body.settings, { enabled: true, defaultMachineId: null })

    const storedSettings = JSON.parse(await readFile(path.join(dataDirectory, '_distributed-work-settings.json'), 'utf8'))
    assert.equal(storedSettings.length, 1)
    assert.equal(storedSettings[0].defaultMachineId, null)
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('루프백 바인딩이면 Runner가 접속할 수 없다고 알린다', { timeout: 45_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-machines-bind-'))
  const port = 4_972
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl, adminEmail, adminPassword)
    const listed = await apiRequest(baseUrl, cookie, '/api/machines')

    // 테스트 서버는 127.0.0.1에 바인딩하므로 다른 장비의 Runner가 붙을 수 없다.
    assert.equal(listed.body.runner.lanReachable, false)
    assert.equal(listed.body.runner.bindHost, '127.0.0.1')
    // 실행 명령에 쓸 주소는 루프백이 아니라 LAN 주소여야 한다.
    assert.match(listed.body.runner.apiUrl, new RegExp(`^http://\\d+\\.\\d+\\.\\d+\\.\\d+:${port}$`))
    assert.ok(listed.body.runner.onlineWithinMs > 0)
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('서브 머신 접속 상태는 하트비트 시각으로 판정하고 메인 머신에는 없다', { timeout: 45_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-machines-online-'))
  const port = 4_973
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port, { MNP_API_HOST: '0.0.0.0' })

  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl, adminEmail, adminPassword)

    // 0.0.0.0에 바인딩하면 경고가 사라진다.
    const bound = await apiRequest(baseUrl, cookie, '/api/machines')
    assert.equal(bound.body.runner.lanReachable, true)
    assert.equal(bound.body.machines[0].online, null, '메인 머신은 Runner가 없어 접속 상태가 없다')

    await apiRequest(baseUrl, cookie, '/api/machines', 'POST', { machineId: 'macbook', label: '맥북' })
    const issued = await apiRequest(baseUrl, cookie, '/api/machines/macbook/token', 'POST')

    // Runner가 한 번도 붙지 않았으면 끊김이다.
    const before = await apiRequest(baseUrl, cookie, '/api/machines')
    const beforeMachine = before.body.machines.find((machine) => machine.machineId === 'macbook')
    assert.equal(beforeMachine.online, false)
    assert.equal(beforeMachine.lastSeenAt, null)

    // 하트비트가 오면 연결됨으로 바뀐다.
    const heartbeat = await fetch(`${baseUrl}/api/machines/macbook/runner/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${issued.body.token}` },
    })
    assert.equal(heartbeat.status, 200)

    const after = await apiRequest(baseUrl, cookie, '/api/machines')
    const afterMachine = after.body.machines.find((machine) => machine.machineId === 'macbook')
    assert.equal(afterMachine.online, true)
    assert.ok(Number.isFinite(Date.parse(afterMachine.lastSeenAt)))
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('편집자는 본인 서브 머신만 등록·관리하고 위임 대상으로 쓸 수 있다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-machines-owner-'))
  const port = 4_967
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)
    const adminCookie = await login(baseUrl, adminEmail, adminPassword)

    const first = await apiRequest(baseUrl, adminCookie, '/api/admin/editors', 'POST', {
      name: '첫째 편집자', email: 'first-editor@mind.local', password: 'first-editor-password',
    })
    assert.equal(first.response.status, 201)
    const second = await apiRequest(baseUrl, adminCookie, '/api/admin/editors', 'POST', {
      name: '둘째 편집자', email: 'second-editor@mind.local', password: 'second-editor-password',
    })
    assert.equal(second.response.status, 201)

    const firstCookie = await login(baseUrl, 'first-editor@mind.local', 'first-editor-password')
    const secondCookie = await login(baseUrl, 'second-editor@mind.local', 'second-editor-password')

    // 편집자가 관리자 권한 없이 자기 장비를 등록한다.
    const registered = await apiRequest(baseUrl, firstCookie, '/api/machines', 'POST', {
      machineId: 'first-mac', label: '첫째 맥북', platform: 'darwin',
    })
    assert.equal(registered.response.status, 200)
    const firstMac = registered.body.machines.find((machine) => machine.machineId === 'first-mac')
    assert.equal(firstMac.ownerUserId, first.body.editor.id)
    assert.equal(firstMac.ownerName, '첫째 편집자')
    assert.equal(firstMac.manageable, true)

    // 소유자는 토큰을 발급할 수 있다.
    const issued = await apiRequest(baseUrl, firstCookie, '/api/machines/first-mac/token', 'POST')
    assert.equal(issued.response.status, 200)
    assert.match(issued.body.token, /^mnprn_/)

    // 다른 편집자는 목록은 보지만 관리할 수 없다.
    const seenByOther = await apiRequest(baseUrl, secondCookie, '/api/machines')
    assert.equal(seenByOther.body.machines.find((machine) => machine.machineId === 'first-mac').manageable, false)
    for (const [method, pathname] of [
      ['POST', '/api/machines/first-mac/token'],
      ['DELETE', '/api/machines/first-mac/token'],
    ]) {
      assert.equal((await apiRequest(baseUrl, secondCookie, pathname, method)).response.status, 403)
    }
    assert.equal((await apiRequest(baseUrl, secondCookie, '/api/machines', 'POST', { machineId: 'first-mac', label: '가로채기' })).response.status, 403)
    assert.equal((await apiRequest(baseUrl, secondCookie, '/api/machines', 'DELETE', { machineId: 'first-mac' })).response.status, 403)
    assert.equal((await apiRequest(baseUrl, secondCookie, '/api/machines/first-mac/probe', 'POST')).response.status, 403)

    // 남의 장비는 위임 대상에도 오르지 않고 기본 머신으로 저장되지도 않는다.
    const otherTargets = await apiRequest(baseUrl, secondCookie, '/api/account/distributed-work', 'PUT', { enabled: true })
    assert.deepEqual(otherTargets.body.targets.machines.map((machine) => machine.machineId), ['desk-win'])
    assert.equal((await apiRequest(baseUrl, secondCookie, '/api/account/distributed-work', 'PUT', {
      enabled: true, defaultMachineId: 'first-mac',
    })).response.status, 400)

    // 소유자에게는 위임 대상으로 노출된다.
    const ownerTargets = await apiRequest(baseUrl, firstCookie, '/api/account/distributed-work', 'PUT', {
      enabled: true, defaultMachineId: 'first-mac',
    })
    assert.deepEqual(ownerTargets.body.settings, { enabled: true, defaultMachineId: 'first-mac' })
    assert.deepEqual(ownerTargets.body.targets.machines.map((machine) => machine.machineId), ['desk-win', 'first-mac'])

    // 편집자는 메인 머신을 다룰 수 없지만 관리자는 남의 서브 머신도 정리할 수 있다.
    assert.equal((await apiRequest(baseUrl, firstCookie, '/api/machines', 'DELETE', { machineId: 'desk-win' })).response.status, 403)
    assert.equal((await apiRequest(baseUrl, adminCookie, '/api/machines', 'DELETE', { machineId: 'first-mac' })).response.status, 200)
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('로그인하지 않으면 머신 목록과 분산 작업 설정을 사용할 수 없다', { timeout: 45_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-machines-auth-'))
  const port = 4_961
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)

    for (const pathname of ['/api/machines', '/api/account/distributed-work']) {
      const response = await fetch(`${baseUrl}${pathname}`)
      assert.equal(response.status, 401)
    }
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
