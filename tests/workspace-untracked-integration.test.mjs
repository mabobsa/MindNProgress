import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test, { describe } from 'node:test'
import {
  WorkspacePoolManager, integrationUntrackedCollisionReasonCode, legacyUntrackedIntegrationHead,
} from '../server/lib/workspacePool.mjs'

const exec = promisify(execFile)
const realGit = { skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행' }
const assetPaths = ['Assets/번역 자료/I2LanguagesJP.asset', 'Assets/번역 자료/I2LanguagesJP.asset.meta']
const commitMessage = {
  summary: '통합 재시도 검증', background: '미추적 충돌을 재현합니다.',
  cause: '통합 경로에 사용자 파일이 있습니다.', changes: '검증용 번역 파일을 추가합니다.',
}
async function git(cwd, args) {
  const result = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return String(result.stdout ?? '').trim()
}
async function put(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}
async function fixture(t, files = assetPaths) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-untracked-integration-'))
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}mnp-untracked-integration-`))
    await rm(root, { recursive: true, force: true })
  })
  const main = path.join(root, 'main')
  const worker = path.join(root, 'worker')
  const sharedRoot = path.join(root, 'shared')
  await Promise.all([mkdir(main), mkdir(sharedRoot)])
  await git(main, ['init', '-b', 'japan-master'])
  async function config(cwd) {
    await git(cwd, ['config', 'user.name', 'MNP Test'])
    await git(cwd, ['config', 'user.email', 'mnp@example.invalid'])
    await git(cwd, ['config', 'core.autocrlf', 'false'])
    await git(cwd, ['config', 'core.hooksPath', path.join(root, 'no-hooks')])
  }
  await config(main)
  await put(main, '.gitignore', '/.ai-session.json\n/.ai-workspace.json\n')
  await put(main, 'base.txt', 'base\n')
  await git(main, ['add', '.'])
  await git(main, ['commit', '-m', 'base'])
  await git(root, ['clone', '--branch', 'japan-master', main, worker])
  await config(worker)
  await put(worker, '.ai-workspace.json', JSON.stringify({ workspaceId: 'fork2', projectRoot: worker }))
  const registryFile = path.join(sharedRoot, 'workspaces.json')
  const stateFile = path.join(root, 'state.json')
  await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'holdem', sharedRoot,
    workspaces: [{ id: 'main', root: main, role: 'integration', enabled: true },
      { id: 'fork2', root: worker, role: 'worker', enabled: true }] }))
  const manager = new WorkspacePoolManager({ registryFile, stateFile })
  await manager.initialize()
  const lease = await manager.acquire({ workspaceHint: main, mapId: 'map-test', cardId: 'card-test', conversationId: 'conversation-test' })
  for (const relative of files) await put(worker, relative, `worker:${relative}\n`)
  await manager.checkpoint(lease.leaseId, { jobId: lease.jobId, mapId: 'map-test', cardId: 'card-test',
    conversationId: 'conversation-test', paths: files, commitMessage })
  return { root, main, worker, sharedRoot, registryFile, stateFile, manager, lease }
}

async function oldQuarantine(f) {
  const current = f.manager.state.leases[f.lease.leaseId]
  const head = current.integrationHeadCommit
  const error = new Error(`Command failed: git merge --ff-only ${head}\nerror: The following untracked working tree files would be overwritten by merge:\n\t${assetPaths.join('\n\t')}\nPlease move or remove them before you merge.\nAborting\n`)
  await f.manager.quarantineIntegrationFailure(current, { id: 'fork2', root: f.worker }, error, { childStatus: 'completed', childError: null })
  // 구버전에는 integrationHeadCommit이 없었다. 오류에 기록된 커밋을 검증해 복구해야 한다.
  delete current.integrationHeadCommit
  await f.manager.persist()
  return head
}

async function localChangesQuarantine(t) {
  const f = await fixture(t, ['first.txt'])
  await put(f.worker, 'base.txt', '완료된 두 번째 커밋\n')
  await f.manager.checkpoint(f.lease.leaseId, { jobId: f.lease.jobId, mapId: 'map-test', cardId: 'card-test',
    conversationId: 'conversation-test', paths: ['base.txt'], commitMessage })
  const hooks = path.join(f.root, 'integration-hooks')
  await put(hooks, 'post-commit', "#!/bin/sh\nprintf 'user local change\\n' > base.txt\n")
  await git(f.worker, ['config', 'core.hooksPath', hooks])
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' }), /local changes/i)
  await git(f.worker, ['config', 'core.hooksPath', path.join(f.root, 'no-hooks')])
  assert.equal(f.manager.state.leases[f.lease.leaseId].status, 'quarantined')
  return f
}
const localRecoveryScope = { mapId: 'map-test', cardId: 'card-test', conversationId: 'conversation-test' }

test('로컬 변경 해소 후 부분 적용을 보존하고 완료 커밋을 한 번만 통합한다', realGit, async (t) => {
  const f = await localChangesQuarantine(t)
  const original = structuredClone(f.manager.state)
  const failed = original.leases[f.lease.leaseId]
  const failedHead = await git(f.worker, ['rev-parse', 'HEAD'])
  assert.notEqual(failedHead, failed.integrationBaseCommit)
  assert.notEqual(failedHead, failed.headCommit)
  await assert.rejects(f.manager.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope), /로컬 변경/)
  assert.deepEqual(f.manager.state, original)
  assert.equal(await readFile(path.join(f.worker, 'base.txt'), 'utf8'), 'user local change\n')
  await rename(path.join(f.worker, 'base.txt'), path.join(f.root, 'user-backup.txt'))
  await git(f.worker, ['restore', 'base.txt'])
  await put(f.worker, 'user-untracked.txt', '사용자 파일\n')
  await assert.rejects(f.manager.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope), /로컬 변경/)
  await rename(path.join(f.worker, 'user-untracked.txt'), path.join(f.root, 'user-untracked-backup.txt'))
  // 구버전의 격리 결과에도 적용한다. 기록된 실패 HEAD 대신 체크포인트와 부분 적용을 대조한다.
  delete f.manager.state.leases[f.lease.leaseId].result.integrationFailureHeadCommit
  await f.manager.persist()
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  const recovered = await restarted.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope)
  assert.equal(recovered.status, 'waiting-integration')
  assert.equal(recovered.childStatus, 'completed')
  assert.equal(recovered.integrationHeadCommit, null, '부분 적용 HEAD를 완료 후보로 오인하면 안 된다.')
  const history = restarted.state.leases[f.lease.leaseId].integrationRecoveryHistory
  assert.equal(history.length, 1)
  assert.equal(await git(f.worker, ['rev-parse', history[0].backupRef]), failedHead)
  assert.equal(await git(f.worker, ['rev-parse', f.lease.branch]), failed.headCommit)
  const restartedAgain = new WorkspacePoolManager(f)
  await restartedAgain.initialize()
  assert.deepEqual(await restartedAgain.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope), recovered)
  assert.deepEqual(await restartedAgain.recoverUntrackedIntegrationFailure(f.lease.leaseId), recovered, '서버 위임 레코드 저장 전 장애도 이어 처리한다.')
  const completed = await restartedAgain.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  assert.equal(await git(f.main, ['rev-list', '--count', `${f.lease.baseCommit}..HEAD`]), '2')
  assert.equal(await readFile(path.join(f.main, 'base.txt'), 'utf8'), '완료된 두 번째 커밋\n')
  assert.equal(await readFile(path.join(f.main, 'first.txt'), 'utf8'), 'worker:first.txt\n')
  assert.equal(await readFile(path.join(f.root, 'user-backup.txt'), 'utf8'), 'user local change\n')
  assert.equal(restartedAgain.state.workspaces.fork2.status, 'idle')
  assert.deepEqual(await restartedAgain.finalize(f.lease.leaseId, { childStatus: 'completed' }), completed)
})

test('통합 재시도는 소유권·세션·체크포인트·수동 커밋 불일치를 격리 상태로 보존한다', realGit, async (t) => {
  const f = await localChangesQuarantine(t)
  await git(f.worker, ['restore', 'base.txt'])
  const original = structuredClone(f.manager.state)
  const sessionPath = path.join(f.worker, '.ai-session.json')
  const session = await readFile(sessionPath, 'utf8')
  await assert.rejects(f.manager.recoverLocalChangesIntegrationFailure(f.lease.leaseId, { ...localRecoveryScope, conversationId: 'other' }), /소유권/)
  await writeFile(sessionPath, JSON.stringify({ ...JSON.parse(session), leaseId: 'other' }))
  await assert.rejects(f.manager.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope), /세션/)
  await writeFile(sessionPath, session)
  f.manager.state.leases[f.lease.leaseId].checkpoints = []
  await assert.rejects(f.manager.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope), /체크포인트/)
  f.manager.state = structuredClone(original)
  await git(f.worker, ['cherry-pick', '--quit'])
  await git(f.worker, ['commit', '--allow-empty', '-m', '[김용민] 검증용 수동 커밋', '-m', '[배경]\n복구 검증\n[원인]\n통합 브랜치 변경 재현\n[수정]\n빈 커밋 추가'])
  await assert.rejects(f.manager.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope), /HEAD/)
  delete f.manager.state.leases[f.lease.leaseId].result.integrationFailureHeadCommit
  await assert.rejects(f.manager.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope), /적용 결과/)
  assert.equal(f.manager.state.leases[f.lease.leaseId].status, 'quarantined')
  assert.equal(f.manager.state.leases[f.lease.leaseId].integrationRecoveryHistory, undefined)
})

test('통합 복구 API는 최신 승인·유휴 대화·정리된 fork를 확인하고 하위 AI 실행 없이 통합 대기로 전환한다', realGit, async (t) => {
  const f = await localChangesQuarantine(t)
  const dataDirectory = path.join(f.root, 'server-data')
  await mkdir(dataDirectory)
  await writeFile(path.join(dataDirectory, '_workspace-pool.json'), JSON.stringify(f.manager.state))
  const now = new Date().toISOString()
  const resultText = '기존 완료 결과를 그대로 보존합니다.'
  const delegation = { id: 'local-integration', mapId: 'map-test', parentCardId: 'parent', targetCardId: 'card-test',
    parentConversationId: 'parent-conversation', targetConversationId: 'conversation-test', state: 'failed',
    childStatus: 'completed', childTurnId: 'original-turn', childOperationId: 'original-operation',
    childResultSnapshot: resultText, childResultHash: createHash('sha256').update(resultText).digest('hex'),
    childResultTurnId: 'original-turn', workspaceLease: f.lease,
    workspaceResult: f.manager.state.leases[f.lease.leaseId].result,
    startedBy: 'user-admin', createdAt: now, updatedAt: now, completedAt: now }
  await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify([delegation]))
  const map = { id: 'map-test', title: '통합 재시도 검증', version: 1,
    nodes: [{ id: 'parent', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', status: 'planned', progress: 0, aiConversationId: 'parent-conversation' } },
      { id: 'card-test', position: { x: 300, y: 0 }, data: { kind: 'task', label: '완료 작업', status: 'done', progress: 100, isWork: true, aiConversationId: 'conversation-test', sharedKnowledge: resultText } }],
    edges: [{ id: 'edge', source: 'parent', target: 'card-test' }] }
  await writeFile(path.join(dataDirectory, 'map-test.json'), JSON.stringify(map))
  const posts = []
  let runtimeState = 'idle'
  const upstream = createServer(async (request, response) => {
    if (request.method === 'POST') posts.push(request.url)
    const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
    if (request.url.endsWith('/capabilities')) return send({ schemaVersion: 3, workspaceLeaseVersion: 0, explicitCompletionAfterInterruption: false })
    if (request.url === '/api/conversations/conversation-test') return send({ id: 'conversation-test', runtime: { state: runtimeState, isProcessing: runtimeState !== 'idle', pendingConfirmations: 0 }, extra: { workspace: f.worker } })
    if (request.url === '/api/internal/conversation-runtimes/active') return send({ items: [] })
    return send({}, 404)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let errors = ''
  const server = spawn(process.execPath, ['server/index.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MNP_DATA_DIR: dataDirectory, MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_WORKSPACE_POOL_REGISTRY: f.registryFile,
      MNP_AIONUI_URL: `http://127.0.0.1:${upstream.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '60000', MNP_ADMIN_PASSWORD: 'test-integration-password' } })
  server.stderr.on('data', chunk => { errors += chunk })
  try {
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(baseUrl + '/api/health')).ok) { ready = true; break } } catch { /* 준비 대기 */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, errors)
    const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mind.local', password: 'test-integration-password' }) })
    assert.equal(login.status, 200)
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
    const endpoint = baseUrl + '/api/maps/map-test/ai-delegations/local-integration/recover'
    const input = { instruction: '로컬 변경을 해소했으므로 완료 커밋의 통합만 재시도합니다.', expectedUpdatedAt: now, sourceRevision: 1, targetRevision: 1, confirmApprovedScope: true }
    const post = body => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal((await post({ ...input, expectedUpdatedAt: 'stale' })).status, 409)
    assert.equal((await post({ ...input, confirmApprovedScope: false })).status, 400)
    runtimeState = 'running'
    assert.equal((await post(input)).status, 409)
    runtimeState = 'idle'
    const dirty = await post(input)
    assert.equal(dirty.status, 409)
    assert.match((await dirty.json()).error, /로컬 변경/)
    assert.equal(JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8')).leases[f.lease.leaseId].status, 'quarantined')
    await rename(path.join(f.worker, 'base.txt'), path.join(f.root, 'api-user-backup.txt'))
    await git(f.worker, ['restore', 'base.txt'])
    const response = await post(input)
    const body = await response.json()
    assert.equal(response.status, 202, JSON.stringify({ body, errors }))
    assert.equal(body.recovery.kind, 'retry-integration')
    assert.equal(body.recovery.childReexecuted, false)
    assert.equal(body.delegation.state, 'waiting-integration')
    const saved = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8'))[0]
    assert.equal(saved.childOperationId, delegation.childOperationId)
    assert.equal(saved.childResultSnapshot, resultText)
    assert.equal(saved.childResultHash, delegation.childResultHash)
    assert.equal(saved.childTurnId, delegation.childTurnId)
    assert.equal(saved.workspaceLease.leaseId, f.lease.leaseId)
    assert.equal(saved.attemptHistory.length, 1)
    assert.equal((await post(input)).status, 409, '중복 요청이 새 하위 실행을 만들면 안 된다.')
    assert.deepEqual(posts, [])
    const savedMap = JSON.parse(await readFile(path.join(dataDirectory, 'map-test.json'), 'utf8'))
    assert.deepEqual(savedMap.nodes, map.nodes)
  } finally {
    if (server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited }
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
})

describe('미추적 파일 충돌 통합 복구', { concurrency: 3 }, () => {
test('충돌 경로 조회 지연은 격리가 아니라 다음 폴링 대기로 보존한다', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-untracked-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const worker = { id: 'fork2', root: path.join(root, 'worker') }
  const lease = { leaseId: 'lease-test', jobId: 'job-test', workspaceId: worker.id,
    status: 'waiting-integration', baseBranch: 'japan-master', integrationHeadCommit: 'candidate',
    result: { reasonCode: integrationUntrackedCollisionReasonCode } }
  const manager = new WorkspacePoolManager({ stateFile: path.join(root, 'state.json'), registryFile: path.join(root, 'registry.json'),
    gitRunner: async (_cwd, _args, options) => {
      assert.ok(options.timeoutMs > 0)
      throw Object.assign(new Error('Git probe timeout'), { code: 'GIT_COMMAND_TIMEOUT' })
    } })
  manager.registry = { sharedRoot: root, workspaces: [worker], integration: { root: path.join(root, 'main') } }
  manager.state = { integrationLeaseId: lease.leaseId, leases: { [lease.leaseId]: lease }, workspaces: { fork2: { status: 'waiting-integration' } } }
  const waiting = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(waiting.status, 'waiting-integration')
  assert.equal(waiting.reasonCode, 'INTEGRATION_STATUS_RETRY')
  assert.equal(manager.state.integrationLeaseId, lease.leaseId)
  assert.equal(waiting.integrationHeadCommit, 'candidate')
})

test('과거 오류 분류는 완료된 fast-forward 미추적 충돌만 허용한다', () => {
  const result = { status: 'quarantined', childStatus: 'completed', integrationBranch: 'mnp/integrate/job-test',
    error: `Command failed: git merge --ff-only ${'a'.repeat(40)}\nerror: The following untracked working tree files would be overwritten by merge:\nfile` }
  assert.equal(legacyUntrackedIntegrationHead(result), 'a'.repeat(40))
  for (const patch of [{ childStatus: 'failed' }, { status: 'waiting-integration' }, { integratedCommit: 'abc' },
    { conflictRound: 1 }, { unmergedFiles: ['file'] }, { error: 'fatal: permission denied' }]) {
    assert.equal(legacyUntrackedIntegrationHead({ ...result, ...patch }), null)
  }
})

test('미추적 파일을 보존하며 대기하고 재시작·정리 후 동일 커밋을 한 번만 통합한다', realGit, async (t) => {
  const f = await fixture(t)
  for (const relative of assetPaths) await put(f.main, relative, `user:${relative}\n`)
  await put(f.main, 'unrelated.txt', '사용자 파일\n')
  const waiting = await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(waiting.status, 'waiting-integration')
  assert.equal(waiting.reasonCode, integrationUntrackedCollisionReasonCode)
  assert.deepEqual(waiting.untrackedChanges, assetPaths)
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), f.lease.baseCommit)
  const candidate = waiting.integrationHeadCommit
  const workerBranch = await git(f.worker, ['branch', '--show-current'])
  const again = await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(again.updatedAt, waiting.updatedAt)
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), candidate)
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  assert.equal(restarted.state.integrationLeaseId, f.lease.leaseId)
  for (let i = 0; i < assetPaths.length; i += 1) {
    assert.equal(await readFile(path.join(f.main, assetPaths[i]), 'utf8'), `user:${assetPaths[i]}\n`)
    await rename(path.join(f.main, assetPaths[i]), path.join(f.root, `backup-${i}`))
  }
  const completed = await restarted.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.integratedCommit, candidate)
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), candidate)
  assert.equal(await git(f.worker, ['rev-parse', workerBranch]), candidate)
  assert.equal(await git(f.worker, ['branch', '--show-current']), 'mnp/idle/fork2')
  assert.equal(restarted.state.workspaces.fork2.status, 'idle')
  assert.equal(restarted.state.integrationLeaseId, null)
  await assert.rejects(readFile(path.join(f.worker, '.ai-session.json')), { code: 'ENOENT' })
  for (const relative of assetPaths) assert.equal(await readFile(path.join(f.main, relative), 'utf8'), `worker:${relative}\n`)
  assert.equal(await readFile(path.join(f.main, 'unrelated.txt'), 'utf8'), '사용자 파일\n')
  assert.deepEqual(await restarted.finalize(f.lease.leaseId, { childStatus: 'completed' }), completed)
})

test('과거 격리를 검증해 복구하고 위임 레코드 저장 전 재시작도 이어 처리한다', realGit, async (t) => {
  const f = await fixture(t)
  await put(f.main, assetPaths[0], '사용자 데이터\n')
  await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  const candidate = await oldQuarantine(f)
  const saved = structuredClone(f.manager.state.leases[f.lease.leaseId].result)
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  const recovered = await restarted.recoverUntrackedIntegrationFailure(f.lease.leaseId)
  assert.equal(recovered.status, 'waiting-integration')
  assert.equal(recovered.recoveredFromQuarantine, true)
  assert.equal(recovered.integrationHeadCommit, candidate)
  assert.deepEqual(restarted.state.leases[f.lease.leaseId].integrationRecoveryHistory[0].previousResult, saved)
  const restartedAgain = new WorkspacePoolManager(f)
  await restartedAgain.initialize()
  assert.deepEqual(await restartedAgain.recoverUntrackedIntegrationFailure(f.lease.leaseId), recovered)
  restartedAgain.state.integrationLeaseId = 'another-integration'
  assert.deepEqual(await restartedAgain.finalize(f.lease.leaseId, { childStatus: 'completed' }), recovered)
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), f.lease.baseCommit)
  restartedAgain.state.integrationLeaseId = null
  await rename(path.join(f.main, assetPaths[0]), path.join(f.root, 'backup'))
  const completed = await restartedAgain.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.integratedCommit, candidate)
  assert.equal(restartedAgain.state.workspaces.fork2.status, 'idle')
})

test('과거 격리의 세션·체크포인트·후보 HEAD·main 기준 불일치는 자동 복구하지 않는다', realGit, async (t) => {
  const f = await fixture(t)
  await put(f.main, assetPaths[0], '사용자 데이터\n')
  await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  const waitingState = structuredClone(f.manager.state)
  await oldQuarantine(f)
  const original = structuredClone(f.manager.state)
  const sessionPath = path.join(f.worker, '.ai-session.json')
  const session = await readFile(sessionPath, 'utf8')
  await writeFile(sessionPath, JSON.stringify({ ...JSON.parse(session), leaseId: 'wrong' }))
  assert.equal(await f.manager.recoverUntrackedIntegrationFailure(f.lease.leaseId), null)
  assert.deepEqual(f.manager.state, original)
  await writeFile(sessionPath, session)
  f.manager.state.leases[f.lease.leaseId].checkpoints = []
  assert.equal(await f.manager.recoverUntrackedIntegrationFailure(f.lease.leaseId), null)
  f.manager.state = structuredClone(original)
  const lease = f.manager.state.leases[f.lease.leaseId]
  lease.result.error = lease.result.error.replace(/--ff-only [a-f0-9]{40}/, `--ff-only ${f.lease.baseCommit}`)
  assert.equal(await f.manager.recoverUntrackedIntegrationFailure(f.lease.leaseId), null)
  f.manager.state = structuredClone(original)
  await git(f.main, ['commit', '--allow-empty', '-m', '사용자가 변경한 기준'])
  assert.equal(await f.manager.recoverUntrackedIntegrationFailure(f.lease.leaseId), null)
  assert.equal(f.manager.state.workspaces.fork2.status, 'quarantined')
  assert.equal(await readFile(path.join(f.main, assetPaths[0]), 'utf8'), '사용자 데이터\n')
  f.manager.state = waitingState
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' }), /기준 커밋/)
  assert.equal(f.manager.state.workspaces.fork2.status, 'quarantined')
})

test('ignored 파일·상위 파일·디렉터리 내부의 미추적 파일도 자동으로 덮어쓰지 않는다', realGit, async (t) => {
  const f = await fixture(t, ['ignored.asset', 'parent/child.txt', 'directory'])
  await put(f.main, '.git/info/exclude', '/ignored.asset\n')
  await put(f.main, 'ignored.asset', 'ignored 사용자 데이터')
  await put(f.main, 'parent', '상위 경로를 차지한 사용자 파일')
  await put(f.main, 'directory/user.txt', '디렉터리 내부 사용자 파일')
  const result = await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'waiting-integration')
  assert.deepEqual(result.untrackedChanges, ['directory/user.txt', 'ignored.asset', 'parent'])
  assert.equal(await readFile(path.join(f.main, 'ignored.asset'), 'utf8'), 'ignored 사용자 데이터')
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), f.lease.baseCommit)
})

test('검사 직후 생긴 파일도 대기로 전환하고 무관한 Git 오류는 격리한다', realGit, async (t) => {
  const f = await fixture(t)
  const baseRunner = f.manager.git
  let raced = false
  f.manager.git = async (cwd, args, options) => {
    if (cwd === f.main && args[0] === 'merge' && !raced) {
      raced = true
      await put(f.main, assetPaths[0], '경쟁 상태에서 생성된 사용자 파일')
    }
    return baseRunner(cwd, args, options)
  }
  const result = await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.reasonCode, integrationUntrackedCollisionReasonCode)
  assert.equal(await readFile(path.join(f.main, assetPaths[0]), 'utf8'), '경쟁 상태에서 생성된 사용자 파일')
  await rename(path.join(f.main, assetPaths[0]), path.join(f.root, 'backup'))
  f.manager.git = async (cwd, args, options) => {
    if (cwd === f.main && args[0] === 'merge') throw new Error('fatal: permission denied')
    return baseRunner(cwd, args, options)
  }
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' }), /permission denied/)
  assert.equal(f.manager.state.workspaces.fork2.status, 'quarantined')
})

test('통합 직후 서버가 종료돼도 이미 반영된 파일을 새 충돌로 오인하지 않는다', realGit, async (t) => {
  const f = await fixture(t)
  await put(f.main, assetPaths[0], '사용자 파일')
  await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  await rename(path.join(f.main, assetPaths[0]), path.join(f.root, 'backup'))
  const candidate = f.manager.state.leases[f.lease.leaseId].integrationHeadCommit
  await git(f.main, ['fetch', f.worker, candidate])
  await git(f.main, ['merge', '--ff-only', candidate])
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  const completed = await restarted.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.integratedCommit, candidate)
  assert.equal(restarted.state.workspaces.fork2.status, 'idle')
})
})
