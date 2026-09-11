import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited
}

test('삭제된 대화의 일반 문서 위임을 후속 성공 또는 사용자 종료로 안전하게 종결한다', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-delegation-close-'))
  const fake = createServer((request, response) => {
    if (request.url?.endsWith('/live-wake')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: true, data: { operationId: 'live-wake', conversationId: 'removed-parent', state: 'running' } }))
      return
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: false, error: { message: 'operation not found' } }))
  })
  const fakePort = await listen(fake)
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let child
  let errors = ''

  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: projectDirectory, env: {
      ...process.env,
      MNP_DATA_DIR: directory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_AIONUI_URL: `http://127.0.0.1:${fakePort}`,
      MNP_AI_DELEGATION_POLL_INTERVAL_MS: '60000',
      MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-workspace-pool.json'),
      MNP_ADMIN_EMAIL: 'close-test@mind.local',
      MNP_ADMIN_PASSWORD: 'CloseTest!2026',
    }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr.on('data', (chunk) => { errors += chunk })
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(baseUrl + '/api/health')).ok) return } catch { /* 서버 시작 대기 */ }
      await pause(100)
    }
    throw new Error(`서버를 시작하지 못했습니다. ${errors}`)
  }

  async function login() {
    const response = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'close-test@mind.local', password: 'CloseTest!2026' }),
    })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }

  async function api(cookie, pathname, method = 'GET', body) {
    const response = await fetch(baseUrl + pathname, {
      method,
      headers: { Cookie: cookie, 'X-MNP-Client': 'closure-api-test', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }

  try {
    await start()
    let cookie = await login()
    const created = await api(cookie, '/api/maps', 'POST', { title: '일반 문서 위임 종료', map: {
      nodes: [
        { id: 'root-close', type: 'mind', position: { x: 0, y: 0 }, data: { label: '상위 카드', description: '', kind: 'root', isWork: false, status: 'planned', progress: 0, aiConversationId: 'current-parent' } },
        { id: 'task-close', type: 'mind', position: { x: 300, y: 0 }, data: { label: '대상 카드', description: '', kind: 'task', isWork: true, status: 'in-progress', progress: 50, aiConversationId: 'current-child' } },
      ],
      edges: [],
    } })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const mapId = created.body.map.id
    const base = {
      mapId, parentCardId: 'root-close', parentCardLabel: '상위 카드',
      targetCardId: 'task-close', targetCardLabel: '대상 카드',
      parentConversationId: 'removed-parent', targetConversationId: 'removed-child',
      childStatus: 'completed', workspaceLease: { leaseId: 'old-lease' },
      workspaceResult: { status: 'completed', childStatus: 'completed', integratedCommit: 'old-integrated' },
      parentDispatchState: 'failed', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }
    await stop(child)
    child = null
    await writeFile(path.join(directory, '_ai-delegations.json'), JSON.stringify([
      { ...base, id: 'old-report', state: 'parent-wake-failed', wakeOperationId: 'missing-old-wake' },
      { ...base, id: 'replacement', state: 'completed', parentConversationId: 'new-parent', targetConversationId: 'new-child', parentDispatchState: 'completed', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' },
      { ...base, id: 'discard-report', state: 'parent-wake-failed', wakeOperationId: 'missing-discard-wake', createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' },
      { ...base, id: 'live-report', state: 'parent-wake-failed', wakeOperationId: 'live-wake', createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z' },
    ], null, 2), 'utf8')
    await start()
    cookie = await login()
    const beforeMap = (await api(cookie, `/api/maps/${mapId}`)).body.map
    const before = (await api(cookie, `/api/maps/${mapId}/ai-delegations`)).body.delegations
    const old = before.find((item) => item.id === 'old-report')
    const discard = before.find((item) => item.id === 'discard-report')
    const live = before.find((item) => item.id === 'live-report')

    const blockedArchive = await api(cookie, `/api/maps/${mapId}/archive`, 'PATCH', {
      baseVersion: beforeMap.version, baseLifecycleVersion: 0, archived: true, reason: '차단 정보 확인',
    })
    assert.equal(blockedArchive.status, 409, JSON.stringify(blockedArchive.body))
    assert.equal(blockedArchive.body.code, 'RECONSTRUCTION_AI_BUSY')
    assert.deepEqual(blockedArchive.body.details.delegation, {
      id: 'old-report', state: 'parent-wake-failed', mapId, cardId: 'task-close', cardLabel: '대상 카드',
    })

    const superseded = await api(cookie, `/api/maps/${mapId}/ai-delegations/old-report/supersede`, 'POST', {
      expectedUpdatedAt: old.updatedAt, sourceRevision: beforeMap.version, targetRevision: beforeMap.version,
      replacementDelegationId: 'replacement', confirmSupersededByCompletedDelegation: true,
    })
    assert.equal(superseded.status, 200, JSON.stringify(superseded.body))
    assert.equal(superseded.body.delegation.state, 'superseded')

    const closed = await api(cookie, `/api/maps/${mapId}/ai-delegations/discard-report/close`, 'POST', {
      expectedUpdatedAt: discard.updatedAt, sourceRevision: beforeMap.version, targetRevision: beforeMap.version,
      reason: 'result-invalidated', note: '통합 결과가 되돌려져 상위 결과 보고를 폐기합니다.',
      confirmClosedWithoutCompletion: true, confirmResultReportDiscarded: true,
    })
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.equal(closed.body.delegation.state, 'closed')
    assert.equal(closed.body.delegation.reportPending, false)
    assert.equal(closed.body.resultReported, false)
    assert.equal(closed.body.cardChanged, false)
    assert.deepEqual((await api(cookie, `/api/maps/${mapId}`)).body.map, beforeMap)

    const refused = await api(cookie, `/api/maps/${mapId}/ai-delegations/live-report/close`, 'POST', {
      expectedUpdatedAt: live.updatedAt, sourceRevision: beforeMap.version, targetRevision: beforeMap.version,
      reason: 'conversation-removed', note: '실행 대화가 삭제된 것으로 보여 종료를 요청합니다.',
      confirmClosedWithoutCompletion: true, confirmResultReportDiscarded: true,
    })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error, /아직 실행 또는 재개 대기 중/)

    const stored = JSON.parse(await readFile(path.join(directory, '_ai-delegations.json'), 'utf8'))
    assert.equal(stored.find((item) => item.id === 'old-report').supersededByDelegationId, 'replacement')
    assert.equal(stored.find((item) => item.id === 'discard-report').closureReason, 'result-invalidated')
    assert.equal(stored.find((item) => item.id === 'discard-report').closureNote, '통합 결과가 되돌려져 상위 결과 보고를 폐기합니다.')
    assert.equal(stored.find((item) => item.id === 'live-report').state, 'parent-wake-failed')
  } finally {
    await stop(child)
    await new Promise((resolve) => fake.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
