import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'

// 대상 AI 대화가 삭제된 한도 대기 위임의 근거 기록·사용자 종료·작업공간 반환을 실제 서버와 실제 Git 로컬 풀로 검증한다.
// Aion은 격리된 모의 서버이며 운영 데이터·대화를 사용하지 않는다.
const exec = promisify(execFile)
const realGit = { skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행', timeout: Number(process.env.MNP_REAL_GIT_TEST_TIMEOUT_MS) || 300_000 }
const usageLimit = "You've hit your 5-hour limit · resets 7:10pm (Asia/Seoul)"
const commitMessage = { summary: '삭제 대화 반환 검증', background: '검수 대화가 한도에 걸렸습니다.', cause: '대상 대화가 삭제됐습니다.', changes: '검증 파일을 추가합니다.' }

async function git(cwd, args) {
  const result = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return String(result.stdout ?? '').trim()
}

async function put(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

// 통합 작업공간 1개와 worker 2개의 실제 Git 풀을 만들고, 두 위임의 lease를 한도 중단처럼 격리한다.
async function quarantinedPool(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-deleted-target-'))
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}mnp-deleted-target-`))
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  })
  const main = path.join(root, 'main'), sharedRoot = path.join(root, 'shared')
  await Promise.all([mkdir(main), mkdir(sharedRoot)])
  const config = async (cwd) => {
    for (const [key, value] of [['user.name', 'MNP Test'], ['user.email', 'mnp@example.invalid'], ['core.autocrlf', 'false'],
      ['core.hooksPath', path.join(root, 'no-hooks')]]) await git(cwd, ['config', key, value])
  }
  await git(main, ['init', '-b', 'japan-master'])
  await config(main)
  await put(main, '.gitignore', '/.ai-session.json\n/.ai-workspace.json\n')
  await put(main, 'base.txt', 'base\n')
  await git(main, ['add', '.'])
  await git(main, ['commit', '-m', 'base'])
  const workers = {}
  for (const id of ['fork2', 'fork3']) {
    workers[id] = path.join(root, id)
    await git(root, ['clone', '--branch', 'japan-master', main, workers[id]])
    await config(workers[id])
    await put(workers[id], '.ai-workspace.json', JSON.stringify({ workspaceId: id, projectRoot: workers[id] }))
  }
  const registryFile = path.join(sharedRoot, 'workspaces.json')
  const stateFile = path.join(root, 'state.json')
  await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'holdem', sharedRoot,
    workspaces: [{ id: 'main', root: main, role: 'integration', enabled: true },
      ...Object.entries(workers).map(([id, workerRoot]) => ({ id, root: workerRoot, role: 'worker', enabled: true }))] }))
  const manager = new WorkspacePoolManager({ registryFile, stateFile })
  await manager.initialize()
  // 위임 A: 체크포인트가 있는 검수 대화(연결 삭제 경로), 위임 B: 이미 연결이 지워진 대화(상태 다시 확인 경로)
  const leaseA = await manager.acquire({ requestId: 'deleted-review-a', workspaceHint: main, mapId: 'map-test', cardId: 'card-a', conversationId: 'conversation-a' })
  await put(manager.state.leases[leaseA.leaseId].projectRoot, 'review-note.txt', '체크포인트로 남긴 검수 메모\n')
  await manager.checkpoint(leaseA.leaseId, { jobId: leaseA.jobId, mapId: 'map-test', cardId: 'card-a', conversationId: 'conversation-a',
    paths: ['review-note.txt'], commitMessage })
  await manager.quarantine(leaseA.leaseId, usageLimit)
  const leaseB = await manager.acquire({ requestId: 'deleted-review-b', workspaceHint: main, mapId: 'map-test', cardId: 'card-b', conversationId: 'conversation-b' })
  await manager.quarantine(leaseB.leaseId, usageLimit)
  return { root, main, registryFile, manager, leaseA: manager.state.leases[leaseA.leaseId], leaseB: manager.state.leases[leaseB.leaseId] }
}

test('삭제된 대상 대화의 한도 대기 위임은 삭제를 확인한 뒤에만 종료하고 변경 없는 격리 작업공간을 반환한다', realGit, async (t) => {
  const f = await quarantinedPool(t)
  const dataDirectory = path.join(f.root, 'server-data')
  await mkdir(dataDirectory)
  await writeFile(path.join(dataDirectory, '_workspace-pool.json'), JSON.stringify(f.manager.state))
  const now = new Date().toISOString()
  const delegation = (id, lease, cardId, conversationId) => ({ id, mapId: 'map-test', parentCardId: 'parent', targetCardId: cardId,
    parentConversationId: 'parent-conversation', targetConversationId: conversationId, strategy: 'new',
    state: 'waiting-usage-limit', childStatus: 'failed', childError: usageLimit, childOperationId: `${id}-operation`, childTurnId: `${id}-turn`,
    workspaceLease: { ...lease, result: undefined }, workspaceResult: lease.result, startedBy: 'user-admin', createdAt: now, updatedAt: now })
  await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify([
    delegation('deleted-review-a', f.leaseA, 'card-a', 'conversation-a'),
    delegation('deleted-review-b', f.leaseB, 'card-b', 'conversation-b'),
  ]))
  const link = { conversationId: 'conversation-a', agent: { id: 'claude', label: 'Claude Code' }, model: { id: 'opus', label: 'Opus' }, startedBy: { id: 'user-admin' } }
  await writeFile(path.join(dataDirectory, 'map-test.json'), JSON.stringify({ id: 'map-test', title: '삭제 대화 위임 정리', version: 1,
    nodes: [
      { id: 'parent', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', status: 'planned', progress: 0, aiConversationId: 'parent-conversation' } },
      { id: 'card-a', position: { x: 300, y: 0 }, data: { kind: 'task', label: '검수 A', status: 'in-progress', progress: 10, isWork: true,
        aiConversationId: 'conversation-a', aiPrimaryConversationId: 'conversation-a', aiConversations: [link] } },
      { id: 'card-b', position: { x: 300, y: 200 }, data: { kind: 'task', label: '검수 B', status: 'in-progress', progress: 10, isWork: true } },
    ],
    edges: [{ id: 'edge-a', source: 'parent', target: 'card-a' }, { id: 'edge-b', source: 'parent', target: 'card-b' }] }))

  // 모의 Aion: 보관 상태(exists)와 실행 기록만 답한다. 삭제된 대화는 404다.
  const exists = { 'conversation-a': true, 'conversation-b': true }
  const posts = [], archiveReads = []
  const upstream = createServer(async (request, response) => {
    const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
    const archive = request.url.match(/^\/api\/sidebar\/conversation\/([^/]+)\/archive-state$/)
    if (archive) {
      archiveReads.push(archive[1])
      return send({ conversation_id: archive[1], exists: exists[archive[1]] === true, archived_at: null })
    }
    if (request.method === 'POST') posts.push(request.url)
    if (request.url.endsWith('/capabilities')) return send({ schemaVersion: 3, workspaceLeaseVersion: 0, explicitCompletionAfterInterruption: false })
    if (request.url === '/api/internal/conversation-runtimes/active') return send({ items: [] })
    const dispatch = request.url.match(/^\/api\/internal\/external-conversation-dispatches\/(deleted-review-[ab])-operation$/)
    if (dispatch) return send({ state: 'failed', operationId: `${dispatch[1]}-operation`, conversationId: `conversation-${dispatch[1].at(-1)}`,
      turnId: `${dispatch[1]}-turn`, errorMessage: usageLimit })
    const conversation = request.url.match(/^\/api\/conversations\/(conversation-[ab])$/)
    if (conversation && exists[conversation[1]]) return send({ id: conversation[1], runtime: { state: 'idle', is_processing: false, pending_confirmations: 0 } })
    return send({}, 404)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let errors = ''
  const server = spawn(process.execPath, ['server/index.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MNP_DATA_DIR: dataDirectory, MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_WORKSPACE_POOL_REGISTRY: f.registryFile,
      MNP_AIONUI_URL: `http://127.0.0.1:${upstream.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '600000', MNP_ADMIN_PASSWORD: 'test-deleted-target-password' } })
  server.stderr.on('data', chunk => { errors += chunk })
  t.after(() => { if (server.exitCode === null) server.kill() })
  let ready = false
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    try { ready = (await fetch(baseUrl + '/api/health')).ok } catch { /* 준비 대기 */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, errors)
  const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@mind.local', password: 'test-deleted-target-password' }) })
  assert.equal(login.status, 200)
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(baseUrl + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  const find = async (id) => (await call('/api/maps/map-test/ai-delegations')).body.delegations.find(item => item.id === id)
  const pool = async () => JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8'))
  // 사람 요청은 최신 위임 시각과 문서 버전을 함께 보내야 한다(대화 연결 삭제는 문서 버전을 올린다).
  const revision = async () => (await call('/api/maps/map-test')).body.map.version
  const refresh = async (id) => {
    const [current, version] = await Promise.all([find(id), revision()])
    return call(`/api/maps/map-test/ai-delegations/${id}/refresh`, 'POST', { expectedUpdatedAt: current.updatedAt, sourceRevision: version, targetRevision: version })
  }
  const close = async (id, patch = {}) => {
    const [current, version] = await Promise.all([find(id), revision()])
    return call(`/api/maps/map-test/ai-delegations/${id}/close`, 'POST', { expectedUpdatedAt: current.updatedAt, sourceRevision: version, targetRevision: version,
      reason: 'conversation-removed', note: '검수 대화를 삭제해 이어 갈 수 없어 종료합니다.',
      confirmClosedWithoutCompletion: true, confirmResultReportDiscarded: true, confirmPreserveWorkspaceResult: true, ...patch })
  }

  await t.test('대화가 남아 있으면 상태 확인으로 근거를 남기지 않고 종료도 막는다', async () => {
    assert.equal((await find('deleted-review-b')).closure.reason, 'workspace-changes-preserved')
    const refreshed = await refresh('deleted-review-b')
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed))
    assert.equal(refreshed.body.delegation.closure.reason, 'workspace-changes-preserved')
    assert.ok(archiveReads.includes('conversation-b'), '한도 대기·격리 위임은 상태 확인 때 보관 상태를 조회한다')
    // 변경 없는 로컬 격리 lease B는 서버 시작 복구가 이미 깨끗이 반환했다. 위임 기록에는 이전 격리 결과가 남아 있다.
    const leaseBefore = (await pool()).leases[f.leaseB.leaseId]
    assert.equal(leaseBefore.result.status, 'failed-clean')
    assert.equal((await close('deleted-review-b')).status, 409)
    assert.deepEqual((await pool()).leases[f.leaseB.leaseId], leaseBefore, '종료가 거부되면 풀 상태를 바꾸지 않는다')
  })

  await t.test('상태 다시 확인이 삭제를 확인하면 근거를 남겨 종료를 연다', async () => {
    exists['conversation-b'] = false
    const refreshed = await refresh('deleted-review-b')
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed))
    assert.deepEqual(refreshed.body.delegation.closure,
      { closeAvailable: true, reason: 'target-conversation-deleted', workspaceReleaseRequired: true, targetDeletedRelease: true })
    const stored = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8')).find(item => item.id === 'deleted-review-b')
    assert.equal(stored.targetConversationMissing.conversationId, 'conversation-b')
    assert.equal(stored.targetConversationMissing.source, 'refresh')
    assert.equal(stored.state, 'waiting-usage-limit', '근거 기록은 위임 상태를 바꾸지 않는다')
  })

  await t.test('대화 연결 삭제에서 부재가 확인되면 같은 대화를 대상으로 한 위임에 근거를 남긴다', async () => {
    exists['conversation-a'] = false
    const removed = await call('/api/maps/map-test/cards/card-a/ai-conversations/conversation-a', 'DELETE')
    assert.equal(removed.status, 200, JSON.stringify(removed))
    assert.equal(removed.body.archiveState, 'missing')
    const current = await find('deleted-review-a')
    assert.equal(current.closure.reason, 'target-conversation-deleted')
    const stored = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8')).find(item => item.id === 'deleted-review-a')
    assert.equal(stored.targetConversationMissing.source, 'conversation-removal')
  })

  await t.test('사유가 다르거나 종료 직전에 대화가 다시 확인되면 반환하지 않는다', async () => {
    const wrongReason = await close('deleted-review-a', { reason: 'no-longer-needed' })
    assert.equal(wrongReason.status, 400)
    assert.match(wrongReason.body.error, /실행 또는 상위 대화가 삭제됨/)
    exists['conversation-a'] = true
    const present = await close('deleted-review-a')
    assert.equal(present.status, 409)
    assert.equal(present.body.reasonCode, 'AI_DELEGATION_TARGET_CONVERSATION_NOT_CONFIRMED_DELETED')
    exists['conversation-a'] = false
    assert.equal((await pool()).leases[f.leaseA.leaseId].status, 'quarantined')
    assert.equal((await find('deleted-review-a')).state, 'waiting-usage-limit')
  })

  await t.test('작업공간에 미커밋 변경이 있으면 반환하지 않고 격리를 유지한다', async () => {
    await put(f.leaseA.projectRoot, 'unsaved.txt', '커밋하지 않은 변경\n')
    const dirty = await close('deleted-review-a')
    assert.equal(dirty.status, 409)
    assert.match(dirty.body.error, /커밋되지 않은 변경/)
    assert.equal((await pool()).leases[f.leaseA.leaseId].status, 'quarantined')
    await rm(path.join(f.leaseA.projectRoot, 'unsaved.txt'))
  })

  await t.test('삭제와 무변경이 확인되면 체크포인트를 보존한 채 반환하고 위임만 종료한다', async () => {
    const beforeMap = await readFile(path.join(dataDirectory, 'map-test.json'), 'utf8')
    const mainHead = await git(f.main, ['rev-parse', 'HEAD'])
    const closed = await close('deleted-review-a')
    assert.equal(closed.status, 200, JSON.stringify(closed))
    assert.equal(closed.body.delegation.state, 'closed')
    assert.equal(closed.body.delegation.workCompleted, false)
    assert.equal(closed.body.workspaceChanged, true)
    assert.equal(closed.body.childExecutionRequested, false)
    assert.equal(closed.body.delegation.workspaceResult.status, 'released-preserved')
    const sourceRef = closed.body.delegation.workspaceResult.preservedRelease.sourceRef
    assert.equal(sourceRef, `refs/mnp/preserved-results/${f.leaseA.jobId}/source`)
    assert.equal(await git(f.leaseA.projectRoot, ['show', `${sourceRef}:review-note.txt`]), '체크포인트로 남긴 검수 메모')
    const state = await pool()
    assert.equal(state.leases[f.leaseA.leaseId].status, 'cancelled')
    assert.equal(state.workspaces[f.leaseA.workspaceId].status, 'idle')
    assert.equal(await git(f.main, ['rev-parse', 'HEAD']), mainHead, 'main에 통합하지 않는다')
    assert.equal(await readFile(path.join(dataDirectory, 'map-test.json'), 'utf8'), beforeMap, '카드를 바꾸지 않는다')

    const closedB = await close('deleted-review-b')
    assert.equal(closedB.status, 200, JSON.stringify(closedB))
    // 이미 깨끗이 반환된 lease는 다시 반환하지 않고 그 결과로 종료한다.
    assert.equal(closedB.body.delegation.state, 'closed')
    assert.equal(closedB.body.delegation.workspaceResult.status, 'failed-clean')
    assert.equal((await pool()).leases[f.leaseB.leaseId].status, 'cancelled')
    assert.deepEqual(posts, [], 'AI 실행·재개 요청을 보내지 않는다')
  })
})
