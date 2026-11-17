import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')

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
  throw new Error('작업공간 이력 API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

function startServer(dataDirectory, port) {
  return spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_ADMIN_EMAIL: 'workspace-admin@mind.local',
      MNP_ADMIN_PASSWORD: 'workspace-admin-password',
      MNP_MACHINE_ID: 'history-main',
      MNP_WORKSPACE_POOL_REGISTRY: path.join(dataDirectory, 'absent-workspaces.json'),
    },
    windowsHide: true,
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

async function workspaceRequest(baseUrl, cookie, method = 'GET', body, machineId = '') {
  const query = machineId ? `?${new URLSearchParams({ machineId })}` : ''
  const response = await fetch(`${baseUrl}/api/integrations/aionui/workspaces${query}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, body: await response.json() }
}

test('최근 AI 작업공간을 로그인 계정별로 공유하고 서버 재시작 후에도 유지한다', { timeout: 45_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-ai-workspaces-'))
  const port = 45_000 + Math.floor(Math.random() * 4_000)
  const baseUrl = `http://127.0.0.1:${port}`
  let server = startServer(dataDirectory, port)

  try {
    await waitForServer(baseUrl)
    const unauthorized = await fetch(`${baseUrl}/api/integrations/aionui/workspaces`)
    assert.equal(unauthorized.status, 401)

    const integrationToken = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
    const integrationResponse = await fetch(`${baseUrl}/api/integrations/aionui/workspaces`, {
      headers: { Authorization: `Bearer ${integrationToken}`, 'X-MNP-Editor-Id': 'user-admin' },
    })
    assert.equal(integrationResponse.status, 401)

    const adminCookieOnPc = await login(baseUrl, 'workspace-admin@mind.local', 'workspace-admin-password')
    const migratedByPc = await workspaceRequest(baseUrl, adminCookieOnPc, 'POST', {
      migration: true,
      workspaces: [' C:\\Git\\MindNProgress ', 'C:\\Git\\Other'],
    })
    assert.equal(migratedByPc.response.status, 200)
    assert.deepEqual(migratedByPc.body.workspaces, ['C:\\Git\\MindNProgress', 'C:\\Git\\Other'])

    const adminCookieOnWeb = await login(baseUrl, 'workspace-admin@mind.local', 'workspace-admin-password')
    const readOnWeb = await workspaceRequest(baseUrl, adminCookieOnWeb)
    assert.equal(readOnWeb.response.status, 200)
    assert.deepEqual(readOnWeb.body.workspaces, migratedByPc.body.workspaces)

    const rememberedByWeb = await workspaceRequest(baseUrl, adminCookieOnWeb, 'POST', {
      workspace: 'C:\\Git\\Other',
    })
    assert.equal(rememberedByWeb.response.status, 200)
    assert.deepEqual(rememberedByWeb.body.workspaces, ['C:\\Git\\Other', 'C:\\Git\\MindNProgress'])

    const createEditor = await fetch(`${baseUrl}/api/admin/editors`, {
      method: 'POST',
      headers: { Cookie: adminCookieOnPc, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '작업공간 편집자',
        email: 'workspace-editor@mind.local',
        password: 'workspace-editor-password',
      }),
    })
    assert.equal(createEditor.status, 201)
    const editorCookie = await login(baseUrl, 'workspace-editor@mind.local', 'workspace-editor-password')
    const editorHistory = await workspaceRequest(baseUrl, editorCookie)
    assert.equal(editorHistory.response.status, 400, '새 편집자의 메인 머신은 기본 불허다')

    const removedOnPc = await workspaceRequest(baseUrl, adminCookieOnPc, 'DELETE', {
      workspace: 'C:\\Git\\MindNProgress',
    })
    assert.equal(removedOnPc.response.status, 200)
    assert.deepEqual(removedOnPc.body.workspaces, ['C:\\Git\\Other'])

    const rejectedStaleCache = await workspaceRequest(baseUrl, adminCookieOnPc, 'POST', {
      workspaces: ['C:\\Git\\MindNProgress', 'C:\\Git\\Other'],
    })
    assert.equal(rejectedStaleCache.response.status, 400)

    const ignoredStaleMigration = await workspaceRequest(baseUrl, adminCookieOnPc, 'POST', {
      migration: true,
      workspaces: ['C:\\Git\\MindNProgress', 'C:\\Git\\Other'],
    })
    assert.equal(ignoredStaleMigration.response.status, 200)
    assert.deepEqual(ignoredStaleMigration.body.workspaces, ['C:\\Git\\Other'])

    const removedVisibleOnWeb = await workspaceRequest(baseUrl, adminCookieOnWeb)
    assert.deepEqual(removedVisibleOnWeb.body.workspaces, ['C:\\Git\\Other'])

    const removedAllOnWeb = await workspaceRequest(baseUrl, adminCookieOnWeb, 'DELETE', {
      workspace: 'C:\\Git\\Other',
    })
    assert.equal(removedAllOnWeb.response.status, 200)
    assert.deepEqual(removedAllOnWeb.body.workspaces, [])

    const ignoredMigrationAfterRemovingAll = await workspaceRequest(baseUrl, adminCookieOnPc, 'POST', {
      migration: true,
      workspaces: ['C:\\Git\\MindNProgress', 'C:\\Git\\Other'],
    })
    assert.equal(ignoredMigrationAfterRemovingAll.response.status, 200)
    assert.deepEqual(ignoredMigrationAfterRemovingAll.body.workspaces, [])

    await stopServer(server)
    server = startServer(dataDirectory, port)
    await waitForServer(baseUrl)
    const adminCookieAfterRestart = await login(baseUrl, 'workspace-admin@mind.local', 'workspace-admin-password')
    const persisted = await workspaceRequest(baseUrl, adminCookieAfterRestart)
    assert.equal(persisted.response.status, 200)
    assert.deepEqual(persisted.body.workspaces, [])

    const ignoredMigrationAfterRestart = await workspaceRequest(baseUrl, adminCookieAfterRestart, 'POST', {
      migration: true,
      workspaces: ['C:\\Git\\MindNProgress', 'C:\\Git\\Other'],
    })
    assert.equal(ignoredMigrationAfterRestart.response.status, 200)
    assert.deepEqual(ignoredMigrationAfterRestart.body.workspaces, [])
  } finally {
    await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('최근 이력은 계정·머신별로 저장하고 구버전 서버 이력은 메인에만 이전한다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-machine-workspaces-'))
  const port = 45_000 + Math.floor(Math.random() * 4_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const historyFile = path.join(dataDirectory, '_ai-workspace-histories.json')
  await writeFile(historyFile, JSON.stringify([
    { userId: 'user-admin', workspaces: ['C:/legacy/main'] },
    { userId: 'user-admin', machineId: 'remote-two', workspaces: [] },
  ]))
  let server = startServer(dataDirectory, port)
  try {
    await waitForServer(baseUrl)
    const cookie = await login(baseUrl, 'workspace-admin@mind.local', 'workspace-admin-password')
    const api = async (route, method, body, accountCookie = cookie) => {
      const response = await fetch(`${baseUrl}${route}`, { method, headers: { Cookie: accountCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }
    for (const machineId of ['remote-one', 'remote-two']) {
      assert.equal((await api('/api/machines', 'POST', { machineId, label: machineId, platform: 'darwin' })).status, 200)
    }
    assert.equal((await api('/api/account/distributed-work', 'PUT', { enabled: true, defaultMachineId: 'remote-one' })).status, 200)
    const legacy = await workspaceRequest(baseUrl, cookie)
    assert.equal(legacy.body.machineId, 'history-main', '생략된 머신은 계정 기본 머신이 아닌 구버전 메인')
    assert.equal(legacy.body.userId, 'user-admin')
    assert.deepEqual(legacy.body.workspaces, ['C:/legacy/main'])
    assert.deepEqual((await workspaceRequest(baseUrl, cookie, 'GET', undefined, 'remote-one')).body.workspaces, [])
    assert.deepEqual((await workspaceRequest(baseUrl, cookie, 'GET', undefined, 'remote-two')).body.workspaces, [])

    // 동일 계정·머신의 다른 브라우저도 서버 이력을 조회하며 머신 사이에 복제하지 않는다.
    const migrated = await workspaceRequest(baseUrl, cookie, 'POST', { migration: true, workspaces: ['/remote/old'] }, 'remote-one')
    assert.equal(migrated.response.status, 200)
    assert.deepEqual(migrated.body.workspaces, ['/remote/old'])
    const cachedEmpty = await workspaceRequest(baseUrl, cookie, 'POST', { migration: true, workspaces: ['/wrong/stale'] }, 'remote-two')
    assert.deepEqual(cachedEmpty.body.workspaces, [], '명시적 빈 기록도 오래된 캐시로 복구하지 않는다')
    const otherBrowser = await login(baseUrl, 'workspace-admin@mind.local', 'workspace-admin-password')
    const saved = await workspaceRequest(baseUrl, otherBrowser, 'POST', { workspace: '/remote/new', expectedUserId: 'user-admin' }, 'remote-one')
    assert.deepEqual(saved.body.workspaces, ['/remote/new', '/remote/old'])
    assert.deepEqual((await workspaceRequest(baseUrl, cookie, 'GET', undefined, 'remote-one')).body.workspaces, saved.body.workspaces)
    assert.deepEqual((await workspaceRequest(baseUrl, cookie)).body.workspaces, ['C:/legacy/main'])
    const removed = await workspaceRequest(baseUrl, cookie, 'DELETE', { workspace: '/remote/old' }, 'remote-one')
    assert.deepEqual(removed.body.workspaces, ['/remote/new'])
    assert.equal((await workspaceRequest(baseUrl, cookie, 'POST', { workspace: '/wrong/account', expectedUserId: 'someone-else' }, 'remote-one')).response.status, 409)
    assert.equal((await workspaceRequest(baseUrl, cookie, 'POST', { workspace: '/wrong/machine', machineId: 'remote-two' }, 'remote-one')).response.status, 400)
    assert.equal((await workspaceRequest(baseUrl, cookie, 'GET', undefined, 'unknown')).response.status, 400)

    const editor = await api('/api/admin/editors', 'POST', { name: '다른 편집자', email: 'machine-editor@mind.local', password: 'machine-editor-password' })
    assert.equal(editor.status, 201)
    const editorCookie = await login(baseUrl, 'machine-editor@mind.local', 'machine-editor-password')
    assert.equal((await workspaceRequest(baseUrl, editorCookie, 'GET', undefined, 'remote-one')).response.status, 400, '다른 사람의 서브 머신 이력에 접근하지 않는다')
    assert.equal((await workspaceRequest(baseUrl, editorCookie)).response.status, 400)
    assert.equal((await api(`/api/admin/editors/${editor.body.editor.id}`, 'PATCH', { mainMachineAllowed: true })).status, 200)
    assert.equal((await api('/api/account/distributed-work', 'PUT', { enabled: true }, editorCookie)).status, 200)
    assert.equal((await api('/api/machines', 'POST', { machineId: 'editor-machine', label: '편집자 머신' }, editorCookie)).status, 200)
    assert.equal((await workspaceRequest(baseUrl, editorCookie, 'POST', { workspace: '/editor/project' }, 'editor-machine')).response.status, 200)
    assert.equal((await workspaceRequest(baseUrl, cookie, 'GET', undefined, 'editor-machine')).response.status, 400, '다른 계정의 전용 실행 머신을 대상으로 삼지 않는다')
    assert.equal((await workspaceRequest(baseUrl, editorCookie, 'POST', { workspace: 'C:/editor/main' })).response.status, 200)
    assert.deepEqual((await workspaceRequest(baseUrl, cookie)).body.workspaces, ['C:/legacy/main'], '같은 메인 머신에서도 계정별로 분리한다')

    await stopServer(server)
    // 뒤쪽에 구버전 기록이 남아 있어도 이미 저장된 머신별 기록을 덮어쓰지 않는다.
    const beforeRestart = JSON.parse(await readFile(historyFile, 'utf8'))
    await writeFile(historyFile, JSON.stringify([...beforeRestart, { userId: 'user-admin', workspaces: ['/obsolete/legacy'] }]))
    server = startServer(dataDirectory, port)
    await waitForServer(baseUrl)
    const restarted = await login(baseUrl, 'workspace-admin@mind.local', 'workspace-admin-password')
    assert.deepEqual((await workspaceRequest(baseUrl, restarted, 'GET', undefined, 'remote-one')).body.workspaces, ['/remote/new'])
    assert.deepEqual((await workspaceRequest(baseUrl, restarted)).body.workspaces, ['C:/legacy/main'])
    let stored = JSON.parse(await readFile(historyFile, 'utf8'))
    assert.ok(stored.every((entry) => typeof entry.machineId === 'string'))
    const editorId = stored.find((entry) => entry.machineId === 'editor-machine').userId
    assert.equal((await api(`/api/admin/editors/${editorId}`, 'DELETE', {}, restarted)).status, 200)
    stored = JSON.parse(await readFile(historyFile, 'utf8'))
    assert.ok(stored.every((entry) => entry.userId !== editorId), '계정 삭제 시 모든 머신의 이력 제거')
  } finally {
    await stopServer(server)
    assert.ok(path.resolve(dataDirectory).startsWith(`${path.resolve(tmpdir())}${path.sep}mindnprogress-machine-workspaces-`))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
