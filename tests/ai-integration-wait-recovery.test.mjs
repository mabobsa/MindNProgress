import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'
import { lostIntegrationWaitCandidate, reconcileLostIntegrationWaits } from '../server/lib/aiIntegrationWaitRecovery.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-lost-integration-wait-'))
  t.after(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('mnp-lost-integration-wait-')) throw new Error('격리 폴더 경로 확인 실패')
    await rm(root, { recursive: true, force: true })
  })
  const workerRoot = path.join(root, 'worker'), sharedRoot = path.join(root, 'shared')
  await mkdir(workerRoot); await mkdir(sharedRoot); await mkdir(path.join(workerRoot, '.git'))
  const base = 'a'.repeat(40), head = 'b'.repeat(40), calls = []
  const lease = { poolId: 'test', workspaceId: 'worker', jobId: 'job-test', leaseId: 'lease-test',
    projectRoot: workerRoot, branch: 'mnp/job-test', baseCommit: base, baseBranch: 'main', headCommit: head,
    mapId: 'map-test', cardId: 'card-test', conversationId: 'chat-test', status: 'waiting-integration',
    checkpoints: [{ commit: head }], commits: [head] }
  const result = { ...lease, checkpoints: undefined, commits: undefined, childStatus: 'completed', childError: null,
    integratedCommit: null, reasonCode: 'integration-worktree-dirty', trackedChanges: ['Main.asset'] }
  lease.result = result
  const manager = new WorkspacePoolManager({ registryFile: path.join(root, 'registry.json'), stateFile: path.join(root, 'state.json'),
    gitRunner: async (cwd, args) => {
      calls.push({ cwd, args })
      assert.equal(cwd, workerRoot, '이 검증은 다른 작업공간을 조작하지 않는다.')
      if (args[0] === 'status') return manager.testDirty ?? ''
      if (args[0] === 'branch') return manager.testBranch ?? lease.branch
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return `.git/${args[2]}`
      if (args[0] === 'rev-parse') return manager.testHead ?? head
      if (args[0] === 'rev-list') return manager.testCommits ?? head
      if (args[0] === 'merge-base') { if (manager.testAncestryError) throw new Error('조상 검사 실패'); return '' }
      throw new Error(`허용하지 않은 Git 명령: ${args[0]}`)
    } })
  manager.registry = { poolId: 'test', sharedRoot, workers: [{ id: 'worker', root: workerRoot, role: 'worker', enabled: true }] }
  manager.state = { leases: { [lease.leaseId]: lease }, workspaces: { worker: { status: 'waiting-integration', jobId: lease.jobId, leaseId: lease.leaseId } } }
  const session = { ...lease }; delete session.result; delete session.checkpoints; delete session.commits
  await writeFile(path.join(workerRoot, '.ai-session.json'), JSON.stringify(session))
  await writeFile(path.join(workerRoot, '.ai-workspace.json'), JSON.stringify({ workspaceId: 'worker', projectRoot: workerRoot }))
  const delegation = { id: 'delegation-test', mapId: lease.mapId, targetCardId: lease.cardId, targetConversationId: lease.conversationId,
    workspaceLease: { ...session }, workspaceResult: null, state: 'failed', childStatus: 'completed', childError: null,
    workspaceError: '통합 작업공간의 Git 상태 확인이 지연되어 다음 폴링에서 다시 시도합니다.',
    childOperationId: 'original-child', childTurnId: 'original-turn', childResultSnapshot: '원 구현 결과', childResultHash: 'original-hash',
    completedAt: '2026-11-04T11:26:59.722Z', parentWakeAttempt: 1, wakeOperationId: 'wake-1', parentDispatchState: 'completed' }
  const rows = new Map([[delegation.id, delegation]]), updates = [], warnings = []
  const reconcile = () => reconcileLostIntegrationWaits({ values: () => rows.values(), get: id => rows.get(id), workspacePool: manager,
    update: async (id, patch) => { updates.push(patch); rows.set(id, { ...rows.get(id), ...patch }) }, warn: (...args) => warnings.push(args) })
  return { manager, lease, session, delegation, rows, updates, calls, warnings, reconcile, root, workerRoot }
}

test('failed/null 결과를 동일 작업공간의 실제 체크포인트와 대사해 통합 대기로 복구하고 이력을 보존한다', async t => {
  const f = await fixture(t), before = structuredClone(f.manager.state)
  const sessionText = await readFile(path.join(f.workerRoot, '.ai-session.json'), 'utf8')
  await f.reconcile()
  const d = f.rows.get(f.delegation.id)
  assert.equal(d.state, 'waiting-integration')
  assert.deepEqual(d.workspaceResult, f.lease.result)
  assert.equal(d.workspaceError, null)
  assert.equal(d.completedAt, null)
  assert.equal(d.wakeOperationId, null)
  assert.equal(d.parentWakeAttempt, 1, '이전 실패 보고 operation을 재사용하지 않는다.')
  assert.equal(d.attemptHistory.at(-1).wakeOperationId, 'wake-1')
  assert.equal(d.integrationWaitRecovery.previousError, f.delegation.workspaceError)
  assert.equal(d.integrationWaitRecovery.previousCompletedAt, f.delegation.completedAt)
  for (const k of ['workspaceLease', 'childOperationId', 'childTurnId', 'childResultSnapshot', 'childResultHash']) assert.deepEqual(d[k], f.delegation[k])
  assert.deepEqual(f.manager.state, before, '위임 대사 과정에서 풀·lease·체크포인트를 변경하지 않는다.')
  assert.equal(await readFile(path.join(f.workerRoot, '.ai-session.json'), 'utf8'), sessionText)
  assert.ok(f.calls.every(c => ['status', 'branch', 'rev-parse', 'rev-list', 'merge-base'].includes(c.args[0])))
  const callsBefore = f.calls.length
  await f.reconcile()
  assert.equal(f.updates.length, 1)
  assert.equal(f.calls.length, callsBefore, '복구된 위임을 반복 검사하거나 이력을 중복 작성하지 않는다.')
})

for (const [label, mutate] of [
  ['일반 실패', f => { f.delegation.workspaceError = '컴파일 실패' }],
  ['실제 하위 실패', f => { f.delegation.childStatus = 'failed' }],
  ['하위 오류 원문', f => { f.delegation.childError = '실패' }],
  ['이미 완료된 위임', f => { f.delegation.state = 'completed' }],
  ['명시적 복구 접수', f => { f.delegation.pendingRecovery = { operationId: 'other' } }],
  ['통합 후보 생성됨', f => { f.lease.integrationBranch = 'candidate' }],
  ['다른 작업공간 점유', f => { f.manager.state.workspaces.worker.leaseId = 'other' }],
  ['다른 카드', f => { f.lease.cardId = 'other' }],
  ['다른 대화', f => { f.lease.conversationId = 'other' }],
  ['이미 통합됨', f => { f.lease.result.integratedCommit = f.lease.headCommit }],
  ['다른 결과의 lease', f => { f.lease.result.leaseId = 'other' }],
  ['세션 변경', async f => { await writeFile(path.join(f.workerRoot, '.ai-session.json'), JSON.stringify({ ...f.session, leaseId: 'other' })) }],
  ['메타데이터 변경', async f => { await writeFile(path.join(f.workerRoot, '.ai-workspace.json'), '{}') }],
  ['worker 미커밋', f => { f.manager.testDirty = ' M other.cs' }],
  ['브랜치 변경', f => { f.manager.testBranch = 'other' }],
  ['HEAD 변경', f => { f.manager.testHead = 'c'.repeat(40) }],
  ['체크포인트 외 커밋', f => { f.manager.testCommits = `${'c'.repeat(40)}\n${f.lease.headCommit}`; f.lease.commits = f.manager.testCommits.split('\n') }],
  ['Git 조상 검사 실패', f => { f.manager.testAncestryError = true }],
  ['진행 중 Git 작업', async f => { await writeFile(path.join(f.workerRoot, '.git', 'index.lock'), '기존 잠금') }],
  ['같은 대화의 후속 위임', f => { f.rows.set('next', { ...f.delegation, id: 'next', state: 'running' }) }],
  ['같은 lease의 다른 위임', f => { f.rows.set('next', { ...f.delegation, id: 'next', targetConversationId: 'next-chat', targetCardId: 'next-card', state: 'running' }) }],
  ['원격 소유권', f => { f.delegation.workspaceLease.ownership = { machineId: 'remote' } }],
  ['결과 정정 중', f => { f.lease.resultCorrection = { phase: 'correcting' } }],
]) test(`통합 대기 자동 복구 제외: ${label}`, async t => {
  const f = await fixture(t)
  await mutate(f)
  const before = structuredClone(f.manager.state)
  await f.reconcile()
  assert.equal(f.updates.length, 0)
  assert.deepEqual(f.manager.state, before)
})

test('조회 시간 초과로 복구 검증이 실패하면 원 기록을 보존하고 서버 시작을 중단하지 않는다', async t => {
  const f = await fixture(t)
  assert.equal(lostIntegrationWaitCandidate(f.delegation), true)
  f.manager.verifiedWaitingIntegrationResult = async () => { throw Object.assign(new Error('조회 시간 초과'), { code: 'GIT_COMMAND_TIMEOUT' }) }
  await f.reconcile()
  assert.equal(f.updates.length, 0)
  assert.equal(f.warnings.length, 1)
  assert.equal(f.rows.get(f.delegation.id), f.delegation)
})
