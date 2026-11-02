import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { aiDelegationRecoveryAvailability, integrationHeadChangedFailure, integrationCandidateWorktreeFailure, integrationCandidateDirtyReasonCode, integrationGitStatusFailure, integrationGitStatusFailureReasonCode } from '../server/lib/aiDelegations.mjs'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'

const base = 'a'.repeat(40), source = 'b'.repeat(40), candidate = 'c'.repeat(40)
const oldMain = 'd'.repeat(40), newMain = 'e'.repeat(40), tree = 'f'.repeat(40)
const scope = { mapId: 'map-test', cardId: 'card-test', conversationId: 'conversation-test' }
const failureText = '통합 직전에 통합 작업공간의 HEAD가 변경되었습니다.'
function result() {
  return { schemaVersion: 1, poolId: 'holdem', workspaceId: 'fork2', jobId: 'job-test', leaseId: 'lease-test',
    ...scope, branch: 'mnp/job-test', baseBranch: 'japan-master', baseCommit: base,
    status: 'quarantined', childStatus: 'completed', childError: null, headCommit: source,
    integrationBranch: 'mnp/integrate/job-test', integrationBaseCommit: oldMain, integrationHeadCommit: candidate,
    integratedCommit: null, conflictRound: null, unmergedFiles: [], error: failureText }
}

test('완료된 원 후보가 있는 정확한 HEAD 변경만 구현 재실행 없이 통합 재시도로 분류한다', () => {
  const r = result(), delegation = { state: 'failed', childStatus: 'completed', workspaceLease: { leaseId: r.leaseId }, workspaceResult: r }
  assert.deepEqual(integrationHeadChangedFailure(r), { candidateCommit: candidate })
  assert.deepEqual(aiDelegationRecoveryAvailability(delegation), {
    failurePhase: 'integration', failureCategory: 'integration-head-changed', recoveryAvailable: true,
    recommendedAction: 'retry-integration', recoveryTool: 'mindnprogress_recover_ai_delegation',
  })
  assert.ok(integrationHeadChangedFailure({ ...r, error: '충돌 해결 중 통합 작업공간의 HEAD가 변경되었습니다.' }))
  for (const patch of [{ childStatus: 'failed' }, { integratedCommit: candidate }, { integrationBranch: null },
    { integrationHeadCommit: null }, { integrationBaseCommit: 'invalid' }, { headCommit: 'invalid' },
    { conflictRound: 1 }, { unmergedFiles: ['conflict.cs'] }, { error: 'main HEAD changed' }, { status: 'completed' }]) {
    assert.equal(integrationHeadChangedFailure({ ...r, ...patch }), null)
    assert.notEqual(aiDelegationRecoveryAvailability({ ...delegation, workspaceResult: { ...r, ...patch } })?.recommendedAction, 'retry-integration')
  }
  assert.equal(aiDelegationRecoveryAvailability({ ...delegation, state: 'completed' }), null)
})

function candidateResult(legacy = false) {
  const r = { ...result(), integrationHeadCommit: null, error: '통합 브랜치에 커밋되지 않은 변경이 남아 있습니다.' }
  if (!legacy) {
    r.error = 'Fork 작업공간 fork2의 통합 후보에 미추적 파일이 남아 있습니다.'
    r.integrationFailure = { reasonCode: integrationCandidateDirtyReasonCode, phase: 'candidate-worktree',
      workspaceId: r.workspaceId, branch: r.integrationBranch, candidateCommit: candidate,
      observedAt: new Date().toISOString(), trackedChanges: [], untrackedChanges: ['old-build/output.dll'] }
  }
  return r
}

test('통합 후보 변경은 단계·후보 증거 또는 정확한 구버전 오류만 명시적 재시도로 분류한다', () => {
  for (const legacy of [false, true]) {
    const r = candidateResult(legacy)
    const delegation = { state: 'failed', childStatus: 'completed', workspaceLease: { leaseId: r.leaseId }, workspaceResult: r }
    assert.deepEqual(integrationCandidateWorktreeFailure(r), { candidateCommit: legacy ? null : candidate })
    assert.deepEqual(aiDelegationRecoveryAvailability(delegation), {
      failurePhase: 'integration', failureCategory: integrationCandidateDirtyReasonCode, recoveryAvailable: true,
      recommendedAction: 'retry-integration', recoveryTool: 'mindnprogress_recover_ai_delegation',
    })
    for (const patch of [{ childStatus: 'failed' }, { childError: '중단' }, { integratedCommit: candidate },
      { status: 'completed' }, { conflictRound: 1 }, { unmergedFiles: ['conflict.cs'] },
      { integrationBranch: null }, { integrationBaseCommit: 'invalid' }, { headCommit: null },
      { integrationHeadCommit: 'invalid' }, { error: '알 수 없는 실패', integrationFailure: undefined }]) {
      assert.equal(integrationCandidateWorktreeFailure({ ...r, ...patch }), null)
    }
  }
  const r = candidateResult()
  for (const patch of [{ reasonCode: 'unknown' }, { phase: 'child' }, { candidateCommit: null },
    { candidateCommit: 'invalid' }, { workspaceId: 'other' }, { branch: 'other' }]) {
    assert.equal(integrationCandidateWorktreeFailure({ ...r, integrationFailure: { ...r.integrationFailure, ...patch } }), null)
  }
  assert.equal(integrationCandidateWorktreeFailure({ ...r, integrationHeadCommit: '9'.repeat(40) }), null)
})

function statusResult(legacy = false) {
  const r = { ...result(), integrationHeadCommit: null, error: 'Command failed: git status --porcelain --untracked-files=all\n' }
  if (!legacy) r.integrationFailure = { reasonCode: integrationGitStatusFailureReasonCode, phase: 'candidate-status',
    workspaceId: r.workspaceId, branch: r.integrationBranch, candidateCommit: null,
    command: 'git status --porcelain --untracked-files=all', exitCode: 128, signal: null }
  return r
}

test('Git 상태 조회 실패는 완료 체크포인트가 있는 통합 단계만 재시도 후보로 표시한다', () => {
  for (const legacy of [false, true]) {
    const r = statusResult(legacy)
    for (const state of ['failed', 'waiting-parent', 'waking-parent', 'parent-wake-failed']) {
      const delegation = { state, childStatus: 'completed', workspaceLease: { leaseId: r.leaseId }, workspaceResult: r }
      assert.deepEqual(integrationGitStatusFailure(r), { candidateCommit: null })
      assert.deepEqual(aiDelegationRecoveryAvailability(delegation), {
        failurePhase: 'integration', failureCategory: integrationGitStatusFailureReasonCode, recoveryAvailable: true,
        recommendedAction: 'retry-integration', recoveryTool: 'mindnprogress_recover_ai_delegation',
      })
    }
    for (const patch of [{ childStatus: 'failed' }, { childError: '중단' }, { integratedCommit: candidate },
      { status: 'completed' }, { conflictRound: 1 }, { unmergedFiles: ['conflict.cs'] },
      { integrationBranch: null }, { integrationBaseCommit: 'invalid' }, { headCommit: null },
      { integrationHeadCommit: 'invalid' }, { error: '다른 Git 명령 실패', integrationFailure: undefined }]) {
      assert.equal(integrationGitStatusFailure({ ...r, ...patch }), null)
    }
    for (const state of ['completed', 'closed', 'superseded']) {
      assert.equal(aiDelegationRecoveryAvailability({ state, workspaceLease: { leaseId: r.leaseId }, workspaceResult: r }), null)
    }
  }
  const r = statusResult()
  for (const patch of [{ reasonCode: 'unknown' }, { phase: 'child' }, { command: 'git reset --hard' },
    { candidateCommit: 'invalid' }, { workspaceId: 'other' }, { branch: 'other' }]) {
    assert.equal(integrationGitStatusFailure({ ...r, integrationFailure: { ...r.integrationFailure, ...patch } }), null)
  }
  assert.equal(integrationGitStatusFailure({ ...r, integrationHeadCommit: candidate,
    integrationFailure: { ...r.integrationFailure, candidateCommit: '9'.repeat(40) } }), null)
})

async function fixture(t, options = {}) {
  // 실제 Git 프로세스 대신 결정적인 응답으로 원 manager의 모든 복구 검증·기록을 실행한다.
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-head-recovery-'))
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'mnp-head-recovery-')))
    await rm(root, { recursive: true, force: true })
  })
  const mainRoot = path.join(root, 'main'), workerRoot = path.join(root, 'worker'), sharedRoot = path.join(root, 'shared')
  await Promise.all([mkdir(mainRoot), mkdir(workerRoot), mkdir(sharedRoot)])
  const r = options.kind === 'head-changed' ? result() : options.kind?.startsWith('status')
    ? statusResult(options.kind === 'status-legacy') : candidateResult(options.kind === 'candidate-legacy'), calls = []
  const lease = { ...r, projectRoot: workerRoot, integrationWorkspaceId: 'main', commits: [source],
    checkpoints: [{ commit: source, paths: ['implementation.cs'] }] }
  lease.result = r
  const worker = { id: 'fork2', root: workerRoot, role: 'worker', enabled: true }
  const main = { id: 'main', root: mainRoot, role: 'integration', enabled: true }
  const notFound = () => { throw Object.assign(new Error('not found'), { code: 1 }) }
  const gitRunner = async (cwd, args) => {
    calls.push({ cwd, args })
    if (args[0] === 'status') {
      if (cwd === workerRoot && options.statusError) throw options.statusError
      return cwd === mainRoot ? options.mainDirty ?? '' : options.workerDirty ?? ''
    }
    if (args[0] === 'branch') return cwd === mainRoot ? lease.baseBranch : options.branch ?? r.integrationBranch
    if (args[0] === 'rev-parse') {
      if (args[1] === '--git-path') return path.join(cwd, '.git', args[2])
      if (args[1] === 'HEAD') return cwd === mainRoot ? options.mainHead ?? newMain : options.head ?? candidate
      if (args[1] === `refs/heads/${lease.branch}`) return options.workHead ?? source
      if (args.includes('--quiet')) {
        if (cwd === mainRoot && args.at(-1) === `${candidate}^{commit}` && options.alreadyIntegrated) return candidate
        if (args.at(-1).startsWith('refs/heads/') && options.existingRetryBranch) return '9'.repeat(40)
        return notFound()
      }
      if (args[1] === `${source}^@`) return base
      if (args[1] === `${candidate}^@`) return oldMain
      if (args[1] === `${candidate}^{tree}`) return options.changedTree ? '0'.repeat(40) : tree
    }
    if (args[0] === 'merge-base') {
      if (args[2] === candidate && args[3] !== candidate && !options.alreadyIntegrated) return notFound()
      if (args[2] === oldMain && cwd === mainRoot && options.rewrittenMain) return notFound()
      return ''
    }
    if (args[0] === 'rev-list') return args[2] === `${base}..${source}` ? source : candidate
    if (args[0] === 'merge-tree') return tree
    if (args[0] === 'update-ref') return ''
    throw new Error(`예상하지 않은 Git 호출: ${args.join(' ')}`)
  }
  const manager = new WorkspacePoolManager({ registryFile: path.join(root, 'registry.json'), stateFile: path.join(root, 'state.json'), gitRunner })
  manager.registry = { poolId: 'holdem', sharedRoot, integration: main, workers: [worker], workspaces: [main, worker] }
  manager.state = { leases: { [lease.leaseId]: lease }, workspaces: {
    fork2: { status: 'quarantined', leaseId: lease.leaseId, jobId: lease.jobId },
  }, integrationLeaseId: null }
  const session = { workspaceId: lease.workspaceId, jobId: lease.jobId, leaseId: lease.leaseId,
    conversationId: lease.conversationId, branch: lease.branch, baseCommit: base, projectRoot: workerRoot }
  await writeFile(path.join(workerRoot, '.ai-workspace.json'), JSON.stringify({ workspaceId: 'fork2', projectRoot: workerRoot }))
  await writeFile(path.join(workerRoot, '.ai-session.json'), JSON.stringify(session))
  return { manager, lease, r, options, calls, worker, main, session, root }
}

for (const kind of ['head-changed', 'candidate', 'candidate-legacy', 'status', 'status-legacy']) {
const recover = f => kind === 'head-changed'
  ? f.manager.recoverIntegrationHeadChangedFailure(f.lease.leaseId, scope)
  : kind.startsWith('status') ? f.manager.recoverIntegrationGitStatusFailure(f.lease.leaseId, scope)
    : f.manager.recoverIntegrationCandidateWorktreeFailure(f.lease.leaseId, scope)
test(`${kind}: 최신 main을 기준으로 새 후보를 예약하고 원 실패·후보·체크포인트를 보존한다`, async t => {
  const f = await fixture(t, { kind })
  const recovered = await recover(f)
  assert.equal(recovered.status, 'waiting-integration')
  assert.equal(f.lease.integrationBranch, 'mnp/integrate/job-test-retry-1')
  assert.equal(f.lease.integrationHeadCommit, null)
  assert.deepEqual(f.lease.checkpoints, [{ commit: source, paths: ['implementation.cs'] }])
  const history = f.lease.integrationRecoveryHistory[0]
  assert.deepEqual(history.previousResult, f.r)
  assert.equal(history.preservedHead, candidate)
  assert.equal(history.mainHeadAtRecovery, newMain)
  const suffix = kind === 'head-changed' ? '/head-changed-1' : kind.startsWith('status') ? '/git-status-failed-1' : '/candidate-worktree-dirty-1'
  assert.ok(f.calls.some(c => c.args[0] === 'update-ref' && c.args[1].endsWith(suffix) && c.args[2] === candidate))
  assert.equal(f.calls.some(c => ['switch', 'cherry-pick', 'reset', 'clean', 'commit', 'merge'].includes(c.args[0])), false)
  assert.equal(f.calls.some(c => c.cwd === f.main.root && c.args[0] === 'merge-base' && c.args[2] === candidate), false,
    'worker에만 있는 후보는 main의 ancestor 검사로 전달하면 안 된다.')
  assert.deepEqual(await recover(f), recovered)
  const stored = JSON.parse(await readFile(path.join(f.root, 'state.json'), 'utf8'))
  assert.equal(stored.leases[f.lease.leaseId].integrationRecoveryHistory[0].preservedHead, candidate)
})

test(`${kind}: 원 후보가 이미 main의 조상이면 다시 적용하지 않고 같은 후보의 완료만 확인한다`, async t => {
  const f = await fixture(t, { kind, alreadyIntegrated: true })
  await recover(f)
  assert.equal(f.lease.integrationBranch, f.r.integrationBranch)
  assert.equal(f.lease.integrationHeadCommit, candidate)
  assert.equal(await f.manager.applyIntegration(f.lease, f.worker, f.main), newMain)
  assert.equal(f.calls.some(c => ['fetch', 'switch', 'cherry-pick', 'merge'].includes(c.args[0])), false)
})

for (const [label, mutate] of [
  ['다른 작업공간 점유', f => { f.manager.state.workspaces.fork2.leaseId = 'another-lease' }],
  ['다른 통합 작업 진행', f => { f.manager.state.integrationLeaseId = 'another-lease' }],
  ['main의 사용자 변경', f => { f.options.mainDirty = ' M user.cs' }],
  ['worker의 미커밋 변경', f => { f.options.workerDirty = '?? user.txt' }],
  ['상태 조회 재실패', f => { f.options.statusError = Object.assign(new Error('Git 조회 실패'), { code: 128 }) }],
  ['후보 HEAD 변경', f => { f.options.head = '9'.repeat(40) }],
  ['원 작업 HEAD 변경', f => { f.options.workHead = '9'.repeat(40) }],
  ['후보 tree 변조', f => { f.options.changedTree = true }],
  ['체크포인트 누락', f => { f.lease.checkpoints = [] }],
  ['main 이력 원복', f => { f.options.rewrittenMain = true }],
  ['이미 존재하는 재시도 브랜치', f => { f.options.existingRetryBranch = true }],
  ['세션 변경', async f => { await writeFile(path.join(f.worker.root, '.ai-session.json'), JSON.stringify({ ...f.session, jobId: 'other-job' })) }],
  ['진행 중 Git', async f => { await mkdir(path.join(f.worker.root, '.git')); await writeFile(path.join(f.worker.root, '.git', 'MERGE_HEAD'), candidate) }],
]) test(`${kind} 복구는 안전 조건을 우회하지 않는다: ${label}`, async t => {
  const f = await fixture(t, { kind }); await mutate(f)
  await assert.rejects(() => recover(f))
  assert.equal(f.lease.status, 'quarantined')
  assert.equal(f.calls.some(c => c.args[0] === 'update-ref'), false)
  assert.equal(f.lease.integrationRecoveryHistory, undefined)
})
}

test('Git 상태 조회 실패의 단계·명령·종료 코드·신호·제한된 stderr를 격리 기록에 보존한다', async t => {
  const f = await fixture(t, { kind: 'status', statusError: Object.assign(new Error('Git 실행 중단'), {
    code: 128, signal: 'SIGTERM', killed: true, stderr: '오류'.repeat(3_000), stdout: '출력에 포함하지 않을 내용',
  }) })
  let failure
  await assert.rejects(f.manager.applyIntegration(f.lease, f.worker, f.main), error => { failure = error; return true })
  assert.match(failure.message, /종료 코드 128.*SIGTERM/)
  const quarantined = await f.manager.quarantineIntegrationFailure(f.lease, f.worker, failure, { childStatus: 'completed', childError: null })
  assert.equal(quarantined.details.status, 'quarantined')
  const stored = JSON.parse(await readFile(path.join(f.root, 'state.json'), 'utf8')).leases[f.lease.leaseId].result
  assert.deepEqual(stored.integrationFailure, {
    reasonCode: integrationGitStatusFailureReasonCode, phase: 'candidate-status', workspaceId: f.worker.id,
    branch: f.lease.integrationBranch, candidateCommit: null, observedAt: failure.integrationFailure.observedAt,
    cwd: f.worker.root, command: 'git status --porcelain --untracked-files=all',
    exitCode: 128, code: null, signal: 'SIGTERM', killed: true, timedOut: false, stderr: '오류'.repeat(2_000),
  })
  assert.deepEqual(integrationGitStatusFailure(stored), { candidateCommit: null })
  assert.equal(JSON.stringify(stored).includes('출력에 포함하지 않을 내용'), false)
  assert.equal(f.calls.some(c => c.cwd === f.main.root), false)
})
