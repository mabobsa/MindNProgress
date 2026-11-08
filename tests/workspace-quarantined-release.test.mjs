import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'

const exec = promisify(execFile)
const realGit = { skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행', timeout: Number(process.env.MNP_REAL_GIT_TEST_TIMEOUT_MS) || 300_000 }
const commitMessage = { summary: '격리 반환 검증', background: '격리 작업공간 반환을 재현합니다.', cause: '정리 단계가 실패했습니다.', changes: '검증 파일을 추가합니다.' }
const scope = { mapId: 'map-test', cardId: 'card-test', conversationId: 'conversation-test', userId: 'user-editor' }

async function git(cwd, args) {
  const result = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return String(result.stdout ?? '').trim()
}
async function put(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

// 통합 전에 격리된 lease를 만든다. checkpoint=true면 코드 체크포인트, false면 무변경 확인 체크포인트를 남긴다.
async function quarantinedFixture(t, { checkpoint = true, childStatus = 'completed', error = 'EBUSY: resource busy or locked, unlink nhncef_core.log' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-quarantined-release-'))
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}mnp-quarantined-release-`))
    await rm(root, { recursive: true, force: true })
  })
  const main = path.join(root, 'main')
  const worker = path.join(root, 'worker')
  const sharedRoot = path.join(root, 'shared')
  await Promise.all([mkdir(main), mkdir(sharedRoot)])
  await git(main, ['init', '-b', 'japan-master'])
  const config = async (cwd) => {
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
    workspaces: [{ id: 'main', root: main, role: 'integration', enabled: true }, { id: 'fork2', root: worker, role: 'worker', enabled: true }] }))
  const manager = new WorkspacePoolManager({ registryFile, stateFile })
  await manager.initialize()
  const lease = await manager.acquire({ workspaceHint: main, ...scope })
  if (checkpoint) {
    await put(worker, 'feature.txt', 'checkpointed\n')
    await manager.checkpoint(lease.leaseId, { jobId: lease.jobId, ...scope, paths: ['feature.txt'], commitMessage })
  } else {
    await manager.checkpoint(lease.leaseId, { jobId: lease.jobId, ...scope, paths: [], confirmNoChanges: true })
  }
  // 마무리 정리 실패(EBUSY)나 하위 실행 실패로 통합 전에 격리된 상태를 기록한다.
  const stored = manager.state.leases[lease.leaseId]
  const completedAt = new Date().toISOString()
  stored.status = 'quarantined'
  stored.result = { status: 'quarantined', leaseId: lease.leaseId, childStatus, childError: childStatus === 'failed' ? 'Failed to authenticate: OAuth token revoked.' : null,
    headCommit: checkpoint ? null : stored.baseCommit, integrationBranch: null, integratedCommit: null, unmergedFiles: [], error, completedAt }
  manager.state.workspaces.fork2 = { status: 'quarantined', reason: error, jobId: lease.jobId, leaseId: lease.leaseId, updatedAt: completedAt }
  await manager.persist()
  return { root, main, worker, sharedRoot, registryFile, stateFile, manager, lease }
}

test('통합 전에 격리된 체크포인트 작업은 미커밋 변경을 정리한 뒤 원 브랜치를 참조로 보존하고 반환한다', realGit, async (t) => {
  const f = await quarantinedFixture(t)
  const release = (reason = '후속 재적용 위임이 같은 결과를 통합해 반환합니다.', releaseScope = scope) =>
    f.manager.releasePreservedQuarantinedResult(f.lease.leaseId, releaseScope, { reason })
  const mainHead = await git(f.main, ['rev-parse', 'HEAD'])
  const checkpointHead = await git(f.worker, ['rev-parse', 'HEAD'])
  await assert.rejects(release('짧'), /사용자 종료 사유/)
  await assert.rejects(release(undefined, { ...scope, conversationId: 'other' }), /소유권/)
  // Unity가 만든 로그처럼 미커밋 파일이 남아 있으면 반환하지 않고 격리를 유지한다.
  await put(f.worker, 'Assets/nhncef_core.log', 'locked log\n')
  await assert.rejects(release(), /커밋되지 않은 변경/)
  assert.equal(f.manager.state.workspaces.fork2.status, 'quarantined')
  await rm(path.join(f.worker, 'Assets'), { recursive: true, force: true })
  const released = await release()
  assert.equal(released.status, 'released-preserved')
  assert.equal(released.integratedCommit, null)
  assert.equal(released.previousResult.error.startsWith('EBUSY'), true)
  assert.equal(released.preservedRelease.kind, 'quarantined-release')
  assert.equal(released.preservedRelease.commitCount, 1)
  assert.equal(released.preservedRelease.approvedByUserId, 'user-editor')
  assert.equal(await git(f.worker, ['rev-parse', released.preservedRelease.sourceRef]), checkpointHead)
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), mainHead, 'main에는 반영하지 않는다')
  await assert.rejects(readFile(path.join(f.worker, '.ai-session.json')), { code: 'ENOENT' })
  assert.equal(f.manager.state.workspaces.fork2.status, 'idle')
  assert.equal(f.manager.state.leases[f.lease.leaseId].status, 'cancelled')
  const stored = JSON.parse(await readFile(path.join(f.sharedRoot, 'job-results', `${f.lease.jobId}.json`), 'utf8'))
  assert.equal(stored.status, 'released-preserved')
  // 같은 요청은 같은 결과를 돌려주고, 반환된 작업공간은 최신 main 기준으로 다시 배정된다.
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  assert.deepEqual(await restarted.releasePreservedQuarantinedResult(f.lease.leaseId, scope, { reason: '동일 반환 재조회' }), released)
  const next = await restarted.acquire({ workspaceHint: f.main, mapId: 'next-map', cardId: 'next-card', conversationId: 'next-conversation' })
  assert.equal(next.baseCommit, mainHead)
  assert.equal(await git(f.worker, ['rev-parse', released.preservedRelease.sourceRef]), checkpointHead, '다음 배정 뒤에도 원 체크포인트 참조를 보존한다')
})

test('하위 실행 실패와 무변경 확인만 남은 격리 작업공간도 반환하며 체크포인트가 아닌 커밋이 있으면 거부한다', realGit, async (t) => {
  const f = await quarantinedFixture(t, { checkpoint: false, childStatus: 'failed', error: '하위 AI 작업이 완료되지 않아 변경을 통합하지 않았습니다.' })
  await put(f.worker, 'manual.txt', 'manual\n')
  await git(f.worker, ['add', 'manual.txt'])
  await git(f.worker, ['commit', '-m', 'manual'])
  await assert.rejects(f.manager.releasePreservedQuarantinedResult(f.lease.leaseId, scope, { reason: '인증 실패 뒤 반환' }), /체크포인트가 아닌 커밋/)
  await git(f.worker, ['reset', '--hard', 'HEAD~1'])
  const released = await f.manager.releasePreservedQuarantinedResult(f.lease.leaseId, scope, { reason: '인증 실패 뒤 반환' })
  assert.equal(released.status, 'released-preserved')
  assert.equal(released.childStatus, 'failed')
  assert.equal(released.preservedRelease.commitCount, 0)
  assert.equal(released.preservedRelease.sourceRef, null)
  assert.equal(f.manager.state.workspaces.fork2.status, 'idle')
})

test('통합이 시작된 격리나 세션이 바뀐 작업공간은 이 경로로 반환하지 않는다', realGit, async (t) => {
  const f = await quarantinedFixture(t)
  const stored = f.manager.state.leases[f.lease.leaseId]
  stored.integrationBranch = `mnp/integrate/${f.lease.jobId}`
  await assert.rejects(f.manager.releasePreservedQuarantinedResult(f.lease.leaseId, scope, { reason: '통합 시작 뒤 반환' }), /통합 전에 격리된/)
  delete stored.integrationBranch
  const sessionFile = path.join(f.worker, '.ai-session.json')
  const session = JSON.parse(await readFile(sessionFile, 'utf8'))
  await writeFile(sessionFile, JSON.stringify({ ...session, leaseId: 'other-lease' }))
  await assert.rejects(f.manager.releasePreservedQuarantinedResult(f.lease.leaseId, scope, { reason: '세션 변경 뒤 반환' }), /세션/)
  assert.equal(f.manager.state.workspaces.fork2.status, 'quarantined')
})
