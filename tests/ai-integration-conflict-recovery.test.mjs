import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'
import { storageApi } from './helpers/storage-api-harness.mjs'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim()
const realGit = { skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행', timeout: 180_000 }
const scope = { mapId: 'map-test', cardId: 'card-test', conversationId: 'conversation-test' }
const message = { summary: '통합 복구 검증', background: '중단된 충돌 해결 재개', cause: '동일 파일 충돌', changes: '담당 변경 적용' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-conflict-resume-'))
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'mnp-conflict-resume-'))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const main = path.join(root, 'main'), worker = path.join(root, 'worker'), sharedRoot = path.join(root, 'shared')
  await mkdir(main); await mkdir(sharedRoot)
  await git(main, 'init', '-b', 'japan-master')
  const config = async dir => {
    await git(dir, 'config', 'user.name', 'MNP Test'); await git(dir, 'config', 'user.email', 'mnp@example.invalid')
    await git(dir, 'config', 'core.autocrlf', 'false'); await git(dir, 'config', 'core.hooksPath', path.join(root, 'no-hooks'))
  }
  await config(main)
  await writeFile(path.join(main, '.gitignore'), '/.ai-session.json\n/.ai-workspace.json\n')
  await writeFile(path.join(main, '.gitattributes'), '*.txt -text\n')
  await writeFile(path.join(main, 'conflict.txt'), 'base\n')
  await writeFile(path.join(main, 'settings.txt'), 'saved\nsettings\n')
  await git(main, 'add', '.'); await git(main, 'commit', '-m', 'base')
  await git(root, 'clone', main, worker); await config(worker)
  await writeFile(path.join(worker, '.ai-workspace.json'), JSON.stringify({ workspaceId: 'worker', projectRoot: worker }))
  const registryFile = path.join(sharedRoot, 'workspaces.json'), stateFile = path.join(root, 'state.json')
  await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'test', sharedRoot,
    workspaces: [{ id: 'main', role: 'integration', root: main, enabled: true }, { id: 'worker', role: 'worker', root: worker, enabled: true }] }))
  const createManager = () => new WorkspacePoolManager({ registryFile, stateFile })
  const manager = createManager(); await manager.initialize()
  const lease = await manager.acquire({ workspaceHint: main, ...scope })
  await writeFile(path.join(worker, 'conflict.txt'), 'worker\n')
  await manager.checkpoint(lease.leaseId, { ...scope, jobId: lease.jobId, paths: ['conflict.txt'], commitMessage: message })
  await writeFile(path.join(main, 'conflict.txt'), 'main\n'); await git(main, 'add', '.'); await git(main, 'commit', '-m', 'main change')
  const result = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'awaiting-conflict-resolution')
  const resolve = async () => {
    await writeFile(path.join(worker, 'conflict.txt'), 'main and worker\n')
    await git(worker, 'add', 'conflict.txt'); await git(worker, '-c', 'core.editor=true', 'cherry-pick', '--continue')
  }
  const resume = (target = manager, extra = {}) => target.resumeIntegrationConflict(lease.leaseId, { ...scope, expectedLease: lease, ...extra })
  return { root, main, worker, sharedRoot, registryFile, stateFile, manager, lease, result, createManager, resolve, resume }
}

test('충돌 해결 전·후 재시작은 같은 통합 브랜치·잠금을 유지하고 완료 시에만 잠금을 해제한다', realGit, async t => {
  const f = await fixture(t)
  await assert.rejects(f.manager.reuseLease(f.lease.leaseId, scope), /lease를 찾지/)
  const before = JSON.stringify(f.manager.state)
  const unresolved = await f.resume()
  assert.equal(unresolved.branch, f.result.integrationBranch); assert.equal(unresolved.phase, 'integration-conflict')
  assert.equal(unresolved.baseCommit, f.result.integrationBaseCommit); assert.equal(unresolved.sourceBranch, f.lease.branch)
  assert.equal(JSON.stringify(f.manager.state), before)
  await f.resolve()
  const candidate = await git(f.worker, 'rev-parse', 'HEAD')
  const restarted = f.createManager(); await restarted.initialize()
  assert.deepEqual(await f.resume(restarted), unresolved)
  assert.deepEqual(await f.resume(restarted), unresolved)
  assert.equal(restarted.state.integrationLeaseId, f.lease.leaseId)
  assert.equal(await git(f.worker, 'rev-parse', 'HEAD'), candidate)
  const completed = await restarted.completeConflictResolution(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed'); assert.equal(completed.integratedCommit, candidate)
  assert.equal(restarted.state.integrationLeaseId, null)
  assert.equal(await readFile(path.join(f.main, 'conflict.txt'), 'utf8'), 'main and worker\n')
  await assert.rejects(f.resume(restarted), /lease를 확인/)
})

test('문서·카드·대화·잠금·세션·브랜치가 다르면 통합 복구를 거부하고 상태를 보존한다', realGit, async t => {
  const f = await fixture(t)
  for (const extra of [{ mapId: 'other' }, { cardId: 'other' }, { conversationId: 'other' },
    { expectedLease: { ...f.lease, jobId: 'other' } }, { expectedLease: { ...f.lease, projectRoot: f.main } }]) {
    await assert.rejects(f.resume(f.manager, extra), /일치하지/)
  }
  const saved = structuredClone(f.manager.state)
  for (const mutate of [state => { state.integrationLeaseId = 'other' },
    state => { state.workspaces.worker.leaseId = 'other' },
    state => { state.leases[f.lease.leaseId].integrationBranch = 'other' },
    state => { state.leases[f.lease.leaseId].headCommit = '0'.repeat(40) }]) {
    mutate(f.manager.state)
    const before = JSON.stringify(f.manager.state)
    await assert.rejects(f.resume(), { reasonCode: 'INTEGRATION_CONFLICT_RECOVERY_UNSAFE' })
    assert.equal(JSON.stringify(f.manager.state), before)
    f.manager.state = structuredClone(saved)
  }
  const sessionPath = path.join(f.worker, '.ai-session.json'), original = await readFile(sessionPath)
  await writeFile(sessionPath, JSON.stringify({ ...JSON.parse(original), phase: 'work' }))
  await assert.rejects(f.resume(), /세션/)
  await writeFile(sessionPath, original)
  await f.resolve()
  await git(f.worker, 'switch', '-c', 'wrong-branch')
  await assert.rejects(f.resume(), /브랜치/)
  await git(f.worker, 'switch', f.result.integrationBranch)
  await git(f.main, 'commit', '--allow-empty', '-m', 'advanced')
  await assert.rejects(f.resume(), /HEAD가 변경/)
  assert.equal(JSON.stringify(f.manager.state), JSON.stringify(saved))
})

test('승인한 CRLF 변경만 백업하고 복구하며 내용 변경·틀린 해시·다른 파일·index 변경은 보존한다', realGit, async t => {
  const f = await fixture(t); await f.resolve()
  const file = path.join(f.worker, 'settings.txt'), original = Buffer.from('saved\r\nsettings\r\n')
  const plan = { expectedHead: await git(f.worker, 'rev-parse', 'HEAD'), files: [{ path: 'settings.txt', expectedSha256: digest(original) }] }
  const attempt = plan => f.resume(f.manager, { trackedEolRecovery: plan, actor: { human: true, editorId: 'test' } })
  await writeFile(file, 'changed\r\nsettings\r\n')
  await assert.rejects(attempt(plan), /내용|원본/)
  assert.equal(await readFile(file, 'utf8'), 'changed\r\nsettings\r\n')
  await writeFile(file, original)
  await assert.rejects(attempt({ ...plan, expectedHead: '0'.repeat(40) }), /HEAD/)
  await assert.rejects(attempt({ ...plan, files: [{ ...plan.files[0], expectedSha256: '0'.repeat(64) }] }), /원문/)
  await writeFile(path.join(f.worker, 'unknown.txt'), 'keep')
  await assert.rejects(attempt(plan), /승인 대상 외/)
  await rm(path.join(f.worker, 'unknown.txt'))
  await git(f.worker, 'add', 'settings.txt')
  await assert.rejects(attempt(plan), /index/)
  await git(f.worker, 'restore', '--staged', 'settings.txt')
  const resumed = await attempt(plan)
  assert.equal(resumed.phase, 'integration-conflict')
  const record = f.manager.state.leases[f.lease.leaseId].trackedEolRecovery
  assert.equal(record.phase, 'normalized')
  assert.deepEqual(await readFile(path.join(f.sharedRoot, record.archiveRelative, 'original-0')), original)
  assert.equal(await readFile(file, 'utf8'), 'saved\nsettings\n')
  assert.equal(await git(f.worker, 'status', '--porcelain'), '')
  const restarted = f.createManager(); await restarted.initialize()
  await f.resume(restarted, { trackedEolRecovery: plan, actor: { human: true, editorId: 'test' } })
  assert.equal(restarted.state.integrationLeaseId, f.lease.leaseId)
})

test('통합 복구 API는 원 실행을 대사하고 응답 유실·서버 재시작 뒤 같은 요청만 이어간다', realGit, async t => {
  const f = await fixture(t); await f.resolve()
  const now = new Date().toISOString(), resultText = '원 하위 완료 결과'
  const original = { id: 'conflict-test', ...scope, targetCardId: scope.cardId, targetConversationId: scope.conversationId,
    parentCardId: 'parent', parentConversationId: 'parent-chat', state: 'integration-recovery-required',
    childStatus: 'completed', childOperationId: 'child-op', childTurnId: 'child-turn',
    childResultSnapshot: resultText, childResultHash: digest(resultText), childResultTurnId: 'child-turn',
    integrationOperationId: 'conflict-op', integrationTurnId: 'conflict-turn',
    workspaceLease: f.lease, workspaceResult: f.result, startedBy: 'user-admin', createdAt: now, updatedAt: now }
  let wrongTurn = true, drop = true, missing = true
  const posts = [], dispatches = new Map()
  const upstream = createServer(async (req, res) => {
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: status < 400, data })) }
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.endsWith('/capabilities')) return send({ schemaVersion: 3, workspaceLeaseVersion: 2, explicitCompletionAfterInterruption: true })
    if (url.pathname === `/api/conversations/${scope.conversationId}`) return send({ id: scope.conversationId, runtime: { state: 'idle' }, extra: { workspace: f.worker } })
    if (url.pathname.endsWith('/active')) return send({ items: [] })
    if (url.pathname.endsWith('/conflict-op')) return send({ operationId: 'conflict-op', turnId: wrongTurn ? 'wrong-turn' : 'conflict-turn',
      conversationId: scope.conversationId, state: 'recovery_required', workspaceLease: f.lease })
    if (req.method === 'POST' && url.pathname === '/api/internal/external-conversation-dispatches') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks)); posts.push(body)
      const dispatch = { operationId: body.operationId, conversationId: scope.conversationId, turnId: 'recovered-turn', state: 'running', workspaceLease: body.workspaceLease }
      dispatches.set(body.operationId, dispatch)
      if (drop) { res.destroy(); return }
      return send(dispatch)
    }
    const operation = decodeURIComponent(url.pathname.split('/').at(-1))
    return dispatches.has(operation) && !missing ? send(dispatches.get(operation)) : send({}, 404)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const api = await storageApi(t, { documents: 0, env: { MNP_WORKSPACE_POOL_REGISTRY: f.registryFile,
    MNP_AIONUI_URL: `http://127.0.0.1:${upstream.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '600000' },
    seed: async ({ data }) => {
      await writeFile(path.join(data, '_workspace-pool.json'), await readFile(f.stateFile))
      await writeFile(path.join(data, '_ai-delegations.json'), JSON.stringify([original]))
      await writeFile(path.join(data, 'map-test.json'), JSON.stringify({ id: scope.mapId, title: '통합 복구 검증', version: 1,
        nodes: [{ id: 'parent', position: { x: 0, y: 0 }, data: { label: '상위', kind: 'root', aiConversationId: 'parent-chat' } },
          { id: scope.cardId, position: { x: 300, y: 0 }, data: { label: '하위', kind: 'task', aiConversationId: scope.conversationId,
            aiConversations: [{ conversationId: scope.conversationId, workspace: f.worker, agent: { id: 'test-agent', label: '검증 AI' }, model: { id: 'test-model', label: '검증 모델' } }] } }],
        edges: [{ id: 'edge', source: 'parent', target: scope.cardId }] }))
    } })
  let cookie
  const login = async () => {
    const res = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'isolated@mind.local', password: 'IsolatedOnly!2026' }) })
    assert.equal(res.status, 200); cookie = res.headers.get('set-cookie').split(';')[0]
  }
  await login()
  const read = async name => JSON.parse(await readFile(path.join(api.data, name), 'utf8'))
  const recover = async () => {
    const current = (await read('_ai-delegations.json'))[0]
    return fetch(api.base + '/api/maps/map-test/ai-delegations/conflict-test/recover', { method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: '완료된 후보를 재적용하지 말고 최종 검증만 진행하세요.',
        sourceRevision: 1, targetRevision: 1, expectedUpdatedAt: current.updatedAt, confirmApprovedScope: true }) })
  }
  const rejected = await recover(); assert.equal(rejected.status, 409, JSON.stringify(await rejected.json()))
  assert.equal(posts.length, 0)
  wrongTurn = false
  const uncertain = await recover(); assert.equal(uncertain.status, 503, JSON.stringify(await uncertain.json()))
  assert.equal(posts.length, 1)
  assert.equal(posts[0].workspaceLease.branch, f.result.integrationBranch)
  assert.match(posts[0].instruction, /이미 해결·커밋/)
  const stored = (await read('_ai-delegations.json'))[0]
  assert.equal(stored.pendingRecovery.conflictRecovery, true)
  assert.equal((await read('_workspace-pool.json')).integrationLeaseId, f.lease.leaseId)
  await api.restart(); await login()
  drop = false
  const resumed = await recover(); assert.equal(resumed.status, 202, JSON.stringify(await resumed.json()))
  assert.equal(posts.length, 2); assert.deepEqual(posts[1], posts[0])
  missing = false
  const settled = (await read('_ai-delegations.json'))[0]
  assert.equal(settled.integrationOperationId, posts[0].operationId)
  assert.equal(settled.childOperationId, 'child-op'); assert.equal(settled.childResultSnapshot, resultText)
  assert.equal(settled.workspaceLease.branch, f.result.integrationBranch)
  assert.equal((await recover()).status, 409)
  assert.equal(posts.length, 2)
  await api.stop()
})
