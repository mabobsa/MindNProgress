import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test, { describe } from 'node:test'
import {
  WorkspacePoolManager, integrationUntrackedCollisionReasonCode, legacyUntrackedIntegrationHead,
} from '../server/lib/workspacePool.mjs'
import { integrationCandidateDirtyReasonCode, integrationGitStatusFailureReasonCode } from '../server/lib/aiDelegations.mjs'

const exec = promisify(execFile)
const realGit = { skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행', timeout: Number(process.env.MNP_REAL_GIT_TEST_TIMEOUT_MS) || 300_000 }
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
async function fixture(t, files = assetPaths, { baseFiles = {} } = {}) {
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
  for (const [relative, content] of Object.entries(baseFiles)) await put(main, relative, content)
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
  if (files.length) await manager.checkpoint(lease.leaseId, { jobId: lease.jobId, mapId: 'map-test', cardId: 'card-test',
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
  // Git ignores non-executable hooks on macOS/Linux; the fixture must actually run.
  await chmod(path.join(hooks, 'post-commit'), 0o755)
  await git(f.worker, ['config', 'core.hooksPath', hooks])
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' }), /local changes/i)
  await git(f.worker, ['config', 'core.hooksPath', path.join(f.root, 'no-hooks')])
  assert.equal(f.manager.state.leases[f.lease.leaseId].status, 'quarantined')
  return f
}
const localRecoveryScope = { mapId: 'map-test', cardId: 'card-test', conversationId: 'conversation-test' }

async function candidateWorktreeQuarantine(t, legacy = false) {
  const f = await fixture(t, ['first.txt'], { baseFiles: { 'old/.gitignore': 'compile-output/\n', 'old/source.txt': '과거 검증 입력\n' } })
  const artifact = 'old/compile-output/output.dll'
  await put(f.worker, artifact, '기존 ignored 검증 산출물\n')
  assert.equal(await git(f.worker, ['status', '--porcelain', '--untracked-files=all']), '')
  await git(f.main, ['rm', 'old/.gitignore', 'old/source.txt'])
  await git(f.main, ['commit', '-m', '과거 검증 폴더 정리'])
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' }), /Fork 작업공간 fork2/)
  const stored = f.manager.state.leases[f.lease.leaseId]
  assert.equal(stored.result.integrationFailure.reasonCode, integrationCandidateDirtyReasonCode)
  assert.deepEqual(stored.result.integrationFailure.trackedChanges, [])
  assert.deepEqual(stored.result.integrationFailure.untrackedChanges, [artifact])
  assert.equal(stored.result.integrationFailure.candidateCommit, await git(f.worker, ['rev-parse', 'HEAD']))
  assert.equal(await git(f.main, ['status', '--porcelain', '--untracked-files=all']), '')
  assert.equal(stored.status, 'quarantined')
  if (legacy) {
    delete stored.result.integrationFailure
    stored.result.error = '통합 브랜치에 커밋되지 않은 변경이 남아 있습니다.'
    assert.equal(stored.result.integrationHeadCommit, null)
  }
  await f.manager.persist()
  return { ...f, artifact }
}

async function gitStatusQuarantine(t, legacy = false) {
  const f = await fixture(t, ['first.txt'])
  const originalGit = f.manager.git
  f.manager.git = async (cwd, args, ...options) => {
    if (cwd === f.worker && args.join(' ') === 'status --porcelain --untracked-files=all'
      && f.manager.state.leases[f.lease.leaseId].status === 'integrating') {
      throw Object.assign(new Error('Command failed: git status --porcelain --untracked-files=all\n'), {
        code: 128, signal: 'SIGTERM', killed: true, stderr: '검증용 상태 조회 중단',
      })
    }
    return originalGit(cwd, args, ...options)
  }
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' }), /Git 상태 조회/)
  f.manager.git = originalGit
  const stored = f.manager.state.leases[f.lease.leaseId]
  assert.equal(stored.result.integrationFailure.reasonCode, integrationGitStatusFailureReasonCode)
  assert.equal(stored.result.integrationFailure.exitCode, 128)
  assert.equal(stored.result.integrationFailure.signal, 'SIGTERM')
  assert.equal(stored.result.integrationHeadCommit, null)
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), f.lease.baseCommit)
  if (legacy) {
    delete stored.result.integrationFailure
    stored.result.error = 'Command failed: git status --porcelain --untracked-files=all\n'
  }
  await f.manager.persist()
  return f
}

for (const legacy of [false, true]) test(`Git 상태 조회 실패 뒤 기존 후보를 보존하고 최신 main으로 통합한다: ${legacy ? '구버전' : '구조화 기록'}`, realGit, async t => {
  const f = await gitStatusQuarantine(t, legacy)
  const failed = structuredClone(f.manager.state.leases[f.lease.leaseId].result)
  const candidate = await git(f.worker, ['rev-parse', 'HEAD'])
  await put(f.main, 'later.txt', '사용자의 후속 작업\n')
  await git(f.main, ['add', 'later.txt'])
  await git(f.main, ['commit', '-m', 'later user work'])
  const mainHead = await git(f.main, ['rev-parse', 'HEAD'])
  const recovered = await f.manager.recoverIntegrationGitStatusFailure(f.lease.leaseId, localRecoveryScope)
  assert.equal(recovered.status, 'waiting-integration')
  const history = f.manager.state.leases[f.lease.leaseId].integrationRecoveryHistory[0]
  assert.deepEqual(history.previousResult, failed)
  assert.equal(await git(f.worker, ['rev-parse', history.backupRef]), candidate)
  assert.equal(await git(f.worker, ['rev-parse', failed.branch]), failed.headCommit)
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize({ recoverWorkspaces: false })
  assert.deepEqual(await restarted.recoverIntegrationGitStatusFailure(f.lease.leaseId, localRecoveryScope), recovered)
  const completed = await restarted.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.integrationBaseCommit, mainHead)
  assert.equal(await git(f.main, ['rev-list', '--count', `${mainHead}..HEAD`]), '1')
  assert.equal(await readFile(path.join(f.main, 'first.txt'), 'utf8'), 'worker:first.txt\n')
  assert.equal(await readFile(path.join(f.main, 'later.txt'), 'utf8'), '사용자의 후속 작업\n')
  assert.equal(restarted.state.workspaces.fork2.status, 'idle')
  assert.deepEqual(await restarted.finalize(f.lease.leaseId, { childStatus: 'completed' }), completed)
})

for (const legacy of [false, true]) test(`ignore 삭제로 드러난 worker 산출물은 보존·정리 후 기존 결과만 통합한다: ${legacy ? '구버전' : '구조화 기록'}`, realGit, async t => {
  const f = await candidateWorktreeQuarantine(t, legacy)
  const original = await readFile(path.join(f.worker, f.artifact))
  const failed = structuredClone(f.manager.state.leases[f.lease.leaseId].result)
  const candidate = await git(f.worker, ['rev-parse', 'HEAD'])
  await assert.rejects(f.manager.recoverIntegrationCandidateWorktreeFailure(f.lease.leaseId, localRecoveryScope), /로컬 변경/)
  assert.deepEqual(await readFile(path.join(f.worker, f.artifact)), original)
  // 원인 처리는 명시적 보존·정리다. 복구 메서드가 파일을 삭제하거나 오류를 무시하지 않는다.
  await rename(path.join(f.worker, f.artifact), path.join(f.root, 'preserved-output.dll'))
  const recovered = await f.manager.recoverIntegrationCandidateWorktreeFailure(f.lease.leaseId, localRecoveryScope)
  assert.equal(recovered.status, 'waiting-integration')
  assert.equal(recovered.integrationHeadCommit, candidate)
  assert.deepEqual(f.manager.state.leases[f.lease.leaseId].integrationRecoveryHistory[0].previousResult, failed)
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize({ recoverWorkspaces: false })
  assert.deepEqual(await restarted.recoverIntegrationCandidateWorktreeFailure(f.lease.leaseId, localRecoveryScope), recovered)
  const completed = await restarted.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.integratedCommit, candidate)
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), candidate)
  assert.equal(await git(f.main, ['rev-list', '--count', `${failed.integrationBaseCommit}..HEAD`]), '1')
  assert.equal(restarted.state.workspaces.fork2.status, 'idle')
  assert.deepEqual(await restarted.finalize(f.lease.leaseId, { childStatus: 'completed' }), completed)
  assert.deepEqual(await readFile(path.join(f.root, 'preserved-output.dll')), original)
})

test('반환된 과거 lease의 늦은 완료·격리 호출은 새 배정을 건드리지 않는다', async () => {
  const manager = new WorkspacePoolManager({ registryFile: 'unused', stateFile: 'unused', gitRunner: () => { throw new Error('Git 호출 금지') } })
  const result = { status: 'released-preserved' }
  manager.state = { leases: { old: { leaseId: 'old', workspaceId: 'fork1', status: 'cancelled', result } },
    workspaces: { fork1: { status: 'leased', leaseId: 'new' } } }
  const before = structuredClone(manager.state)
  for (const method of ['finalize', 'completeConflictResolution', 'quarantine', 'cancel']) {
    assert.deepEqual(await manager[method]('old', { childStatus: 'completed' }), result)
    assert.deepEqual(manager.state, before)
  }
})

test('CRLF 자동 변환 뒤 -text가 추가된 체크포인트도 원본 바이트로 통합한다', realGit, async (t) => {
  const f = await fixture(t, ['first.txt'])
  await git(f.worker, ['config', 'core.autocrlf', 'true'])
  const raw = Buffer.from('first\r\nsecond\nthird\r\n')
  const checkpoint = paths => f.manager.checkpoint(f.lease.leaseId, { jobId: f.lease.jobId, ...localRecoveryScope, paths, commitMessage })
  await put(f.worker, 'shadow/before.bytes', raw.toString().replaceAll('\r\n', '\n'))
  await checkpoint(['shadow/before.bytes'])
  await put(f.worker, 'shadow/.gitattributes', '*.bytes -text\n')
  await checkpoint(['shadow/.gitattributes'])
  await put(f.worker, 'shadow/.gitattributes', '*.bytes -text -diff\n')
  await put(f.worker, 'shadow/before.bytes', raw)
  await checkpoint(['shadow/.gitattributes', 'shadow/before.bytes'])
  const source = await git(f.worker, ['rev-parse', 'HEAD'])
  // 구버전의 실제 실패를 먼저 증명한다. 운영 worker가 아닌 격리 fixture다.
  const legacy = path.join(f.root, 'legacy-replay')
  await git(f.root, ['clone', '--no-checkout', f.worker, legacy])
  await git(legacy, ['config', 'core.autocrlf', 'true'])
  await git(legacy, ['config', 'user.name', 'MNP Test'])
  await git(legacy, ['config', 'user.email', 'mnp@example.invalid'])
  await git(legacy, ['config', 'core.hooksPath', path.join(f.root, 'no-hooks')])
  await git(legacy, ['switch', '-c', 'old-replay', f.lease.baseCommit])
  const commits = (await git(f.worker, ['rev-list', '--reverse', `${f.lease.baseCommit}..${source}`])).split('\n')
  await assert.rejects(git(legacy, ['cherry-pick', ...commits]), /local changes/i)
  const completed = await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(await readFile(path.join(f.main, 'shadow/before.bytes')), raw)
  assert.equal(await git(f.worker, ['config', '--local', 'core.autocrlf']), 'true', '사용자 설정은 변경하지 않는다.')
  assert.equal(await git(f.worker, ['rev-parse', f.lease.branch]), source)
  assert.equal(await git(f.main, ['rev-list', '--count', `${f.lease.baseCommit}..HEAD`]), String(commits.length))
})

test('기준 브랜치에 이미 있던 파일도 전환부터 LF로 준비해 -text 체크포인트를 통합한다', realGit, async (t) => {
  const file = 'journal/receipt.json'
  const f = await fixture(t, [], { baseFiles: { [file]: '{\n  "status": "completed"\n}\n', 'journal/.gitattributes': '*.bytes -text -diff\n' } })
  await git(f.worker, ['config', 'core.autocrlf', 'true'])
  const raw = Buffer.from('{\r\n  "status": "verified"\n}\r\n')
  const checkpoint = paths => f.manager.checkpoint(f.lease.leaseId, { jobId: f.lease.jobId, ...localRecoveryScope, paths, commitMessage })
  await put(f.worker, 'journal/.gitattributes', '* -text\n')
  await checkpoint(['journal/.gitattributes'])
  await put(f.worker, file, raw)
  await checkpoint([file])
  const source = await git(f.worker, ['rev-parse', 'HEAD'])
  const legacy = path.join(f.root, 'legacy-base-replay')
  await git(f.root, ['clone', '--no-checkout', f.worker, legacy])
  for (const [key, value] of [['core.autocrlf', 'true'], ['user.name', 'MNP Test'], ['user.email', 'mnp@example.invalid'], ['core.hooksPath', path.join(f.root, 'no-hooks')]]) {
    await git(legacy, ['config', key, value])
  }
  await git(legacy, ['switch', '-c', 'old-replay', f.lease.baseCommit])
  const commits = (await git(f.worker, ['rev-list', '--reverse', `${f.lease.baseCommit}..${source}`])).split('\n')
  await assert.rejects(git(legacy, ['-c', 'core.autocrlf=input', 'cherry-pick', ...commits]), /local changes/i,
    '이전 보완처럼 cherry-pick만 LF 정책으로 실행하면 기준 checkout의 CRLF가 남는다.')
  const completed = await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(await readFile(path.join(f.main, file)), raw)
  assert.equal(await git(f.worker, ['status', '--porcelain']), '')
  assert.equal(await git(f.worker, ['config', '--local', 'core.autocrlf']), 'true')
  assert.equal(await git(f.worker, ['rev-parse', f.lease.branch]), source)
})

test('기준 checkout의 CRLF 격리는 승인한 원문만 보존·정리하고 중단 후 반환을 이어간다', { ...realGit, timeout: Math.max(realGit.timeout, 900_000) }, async (t) => {
  const file = 'journal/검증.json'
  const base = Buffer.from('{\n  "status": "completed"\n}\n')
  const original = Buffer.from(base.toString().replaceAll('\n', '\r\n'))
  const f = await fixture(t, [], { baseFiles: { [file]: base, 'journal/.gitattributes': '*.bytes -text -diff\n' } })
  await git(f.worker, ['config', 'core.autocrlf', 'true'])
  const checkpoint = paths => f.manager.checkpoint(f.lease.leaseId, { jobId: f.lease.jobId, ...localRecoveryScope, paths, commitMessage })
  await put(f.worker, 'journal/.gitattributes', '* -text\n')
  await checkpoint(['journal/.gitattributes'])
  await put(f.worker, file, Buffer.from('{\r\n  "status": "verified"\n}\r\n'))
  await checkpoint([file])
  const source = await git(f.worker, ['rev-parse', 'HEAD'])
  const mainHead = await git(f.main, ['rev-parse', 'HEAD'])
  const originalGit = f.manager.git
  f.manager.git = (cwd, args, options) => originalGit(cwd, args, args[0] === 'switch' ? {} : options)
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' }), /local changes/i,
    '실제 이전 manager의 기준 전환 → 속성 커밋 → 다음 커밋 순서가 실패해야 한다.')
  f.manager.git = originalGit
  const head = await git(f.worker, ['rev-parse', 'HEAD'])
  assert.deepEqual(await readFile(path.join(f.worker, file)), original)
  const plan = { expectedHead: head, files: [{ path: file, expectedSha256: createHash('sha256').update(original).digest('hex') }] }
  const release = trackedEolRecovery => f.manager.releasePreservedIntegrationFailure(f.lease.leaseId,
    { ...localRecoveryScope, operator: 'MNP Test' }, { reason: '후속 결과가 진행되어 승인된 줄바꿈만 보존 정리하고 반환합니다.', trackedEolRecovery })
  await assert.rejects(release(), /로컬 변경/)
  await assert.rejects(release({ ...plan, expectedHead: mainHead }), /HEAD/)
  await assert.rejects(release({ ...plan, files: [{ path: file, expectedSha256: '0'.repeat(64) }] }), /CRLF/)
  await put(f.worker, 'unrelated.txt', '사용자 변경\n')
  await assert.rejects(release(plan), /승인 대상 외/)
  assert.equal(await readFile(path.join(f.worker, 'unrelated.txt'), 'utf8'), '사용자 변경\n')
  await rm(path.join(f.worker, 'unrelated.txt'))
  await put(f.worker, file, Buffer.from('실제 내용 변경\r\n'))
  await assert.rejects(release(plan), /줄바꿈 외/)
  await put(f.worker, file, original)
  await git(f.worker, ['add', '--', file])
  await assert.rejects(release(plan), /index 변경/)
  await git(f.worker, ['restore', '--staged', '--', file])
  const persist = f.manager.persist.bind(f.manager)
  f.manager.persist = async () => {
    if (f.manager.state.leases[f.lease.leaseId].trackedEolRecovery?.phase === 'normalized') throw new Error('injected normalization receipt failure')
    return persist()
  }
  await assert.rejects(release(plan), /injected normalization/)
  assert.deepEqual(await readFile(path.join(f.worker, file)), base)
  const persisted = JSON.parse(await readFile(f.stateFile, 'utf8')).leases[f.lease.leaseId].trackedEolRecovery
  assert.equal(persisted.phase, 'preserved')
  assert.deepEqual(await readFile(path.join(f.sharedRoot, persisted.archiveRelative, 'original-0')), original)
  assert.deepEqual(await readFile(path.join(f.sharedRoot, persisted.archiveRelative, 'removed-0')), original)
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize({ recoverWorkspaces: false })
  const released = await restarted.releasePreservedIntegrationFailure(f.lease.leaseId, localRecoveryScope, { reason: '승인한 반환 재개' })
  assert.equal(released.status, 'released-preserved')
  assert.equal(released.preservedRelease.trackedEolRecovery.phase, 'normalized')
  assert.equal(released.preservedRelease.trackedEolRecovery.actor.operator, 'MNP Test')
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), mainHead)
  assert.equal(await git(f.worker, ['rev-parse', f.lease.branch]), source)
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), head)
  assert.equal(await git(f.worker, ['status', '--porcelain']), '')
  assert.equal(restarted.state.workspaces.fork2.status, 'idle')
})

test('격리된 부분 통합은 명시적 반환 시 원본·후보를 보존하고 main을 변경하지 않는다', realGit, async (t) => {
  const f = await localChangesQuarantine(t)
  const release = (scope = localRecoveryScope) => f.manager.releasePreservedIntegrationFailure(f.lease.leaseId, scope, { reason: '후속 업무가 별도 진행되어 이전 결과는 보존하고 반환합니다.' })
  const previous = structuredClone(f.manager.state.leases[f.lease.leaseId].result)
  const mainHead = await git(f.main, ['rev-parse', 'HEAD'])
  await assert.rejects(release(), /로컬 변경/)
  await git(f.worker, ['restore', 'base.txt'])
  await assert.rejects(release({ ...localRecoveryScope, conversationId: 'other' }), /소유권/)
  const session = await readFile(path.join(f.worker, '.ai-session.json'), 'utf8')
  await put(f.worker, '.ai-session.json', JSON.stringify({ ...JSON.parse(session), leaseId: 'other' }))
  await assert.rejects(release(), /세션/)
  await put(f.worker, '.ai-session.json', session)
  const head = await git(f.worker, ['rev-parse', 'HEAD'])
  const released = await release()
  assert.equal(released.status, 'released-preserved')
  assert.equal(released.integratedCommit, null)
  assert.deepEqual(released.previousResult, previous)
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), mainHead)
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), head)
  assert.equal(await git(f.worker, ['rev-parse', released.preservedRelease.backupRef]), head)
  assert.equal(await git(f.worker, ['rev-parse', released.preservedRelease.sourceRef]), previous.headCommit)
  assert.equal(f.manager.state.workspaces.fork2.status, 'idle')
  await assert.rejects(readFile(path.join(f.worker, '.ai-session.json')), { code: 'ENOENT' })
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  assert.deepEqual(await restarted.releasePreservedIntegrationFailure(f.lease.leaseId, localRecoveryScope, { reason: '동일 반환 재조회' }), released)
  const next = await restarted.acquire({ workspaceHint: f.main, mapId: 'next-map', cardId: 'next-card', conversationId: 'next-conversation' })
  assert.notEqual(next.leaseId, f.lease.leaseId)
  assert.equal(next.baseCommit, mainHead)
  assert.equal(await git(f.worker, ['rev-parse', released.preservedRelease.sourceRef]), previous.headCommit)
  assert.deepEqual(await restarted.releasePreservedIntegrationFailure(f.lease.leaseId, localRecoveryScope, { reason: '새 lease 이후 재조회' }), released)
  assert.equal(restarted.state.workspaces.fork2.leaseId, next.leaseId)
})

test('결과 보존 반환의 세션 제거 후 중단은 재시작해 마무리한다', realGit, async (t) => {
  const f = await localChangesQuarantine(t)
  await git(f.worker, ['restore', 'base.txt'])
  const originalWrite = f.manager.writeResult.bind(f.manager)
  f.manager.writeResult = async () => { throw new Error('injected release write failure') }
  await assert.rejects(f.manager.releasePreservedIntegrationFailure(f.lease.leaseId, localRecoveryScope, { reason: '승인된 격리 반환' }), /injected/)
  f.manager.writeResult = originalWrite
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  assert.equal(restarted.state.workspaces.fork2.status, 'quarantined')
  await assert.rejects(restarted.recoverLocalChangesIntegrationFailure(f.lease.leaseId, localRecoveryScope), /반환을 마무리/)
  const released = await restarted.releasePreservedIntegrationFailure(f.lease.leaseId, localRecoveryScope, { reason: '승인된 격리 반환' })
  assert.equal(released.status, 'released-preserved')
  assert.equal(restarted.state.workspaces.fork2.status, 'idle')
})

async function gitLockQuarantine(t) {
  const f = await fixture(t, ['first.txt'])
  // source와 원 main의 tree가 달라도 정확한 cherry-pick 결과를 검증해야 한다.
  await put(f.main, 'main-before.txt', '원래 main 변경\n')
  await git(f.main, ['add', 'main-before.txt'])
  await git(f.main, ['commit', '-m', 'main before integration'])
  f.lockPath = path.resolve(f.main, await git(f.main, ['rev-parse', '--git-path', 'index.lock']))
  await writeFile(f.lockPath, '다른 Git 작업의 잠금')
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' }), /index\.lock/)
  f.failed = structuredClone(f.manager.state.leases[f.lease.leaseId])
  assert.equal(f.failed.result.childStatus, 'completed')
  assert.equal(f.failed.result.childError, null)
  return f
}

test('Git 잠금 해소 후 최신 main에서 별도 후보로 통합하고 이전 후보·사용자 파일을 보존한다', realGit, async (t) => {
  const f = await gitLockQuarantine(t)
  const original = structuredClone(f.manager.state)
  await assert.rejects(f.manager.recoverIntegrationGitLockFailure(f.lease.leaseId, localRecoveryScope), /Git 잠금/)
  assert.equal(await readFile(f.lockPath, 'utf8'), '다른 Git 작업의 잠금')
  assert.deepEqual(f.manager.state, original)
  await rm(f.lockPath)
  await put(f.main, 'main-after.txt', '이후 다른 업무\n')
  await git(f.main, ['add', 'main-after.txt'])
  await git(f.main, ['commit', '-m', 'main advanced'])
  const advanced = await git(f.main, ['rev-parse', 'HEAD'])
  await put(f.main, 'user-untracked.txt', '사용자 미추적 파일\n')
  await put(f.main, '.ai-session.json', '사용자 ignored 파일\n')
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  const recovered = await restarted.recoverIntegrationGitLockFailure(f.lease.leaseId, localRecoveryScope)
  assert.equal(recovered.status, 'waiting-integration')
  assert.equal(recovered.integrationHeadCommit, null)
  const history = restarted.state.leases[f.lease.leaseId].integrationRecoveryHistory
  assert.equal(history.length, 1)
  assert.deepEqual(history[0].previousResult, f.failed.result)
  assert.notEqual(history[0].retryBranch, f.failed.integrationBranch)
  assert.equal(await git(f.worker, ['rev-parse', history[0].backupRef]), f.failed.integrationHeadCommit)
  const restartedAgain = new WorkspacePoolManager(f)
  await restartedAgain.initialize()
  assert.deepEqual(await restartedAgain.recoverIntegrationGitLockFailure(f.lease.leaseId, localRecoveryScope), recovered)
  assert.deepEqual(await restartedAgain.recoverUntrackedIntegrationFailure(f.lease.leaseId), recovered, '풀 저장 후 위임 저장 전 중단도 대사한다.')
  const completed = await restartedAgain.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.integrationBaseCommit, advanced)
  assert.equal(await git(f.main, ['rev-list', '--count', `${advanced}..HEAD`]), '1')
  for (const [file, content] of [['main-before.txt', '원래 main 변경\n'], ['main-after.txt', '이후 다른 업무\n'],
    ['first.txt', 'worker:first.txt\n'], ['user-untracked.txt', '사용자 미추적 파일\n'], ['.ai-session.json', '사용자 ignored 파일\n']]) {
    assert.equal(await readFile(path.join(f.main, file), 'utf8'), content)
  }
  assert.equal(await git(f.worker, ['rev-parse', f.failed.integrationBranch]), f.failed.integrationHeadCommit)
  assert.equal(await git(f.worker, ['rev-parse', f.lease.branch]), f.failed.headCommit)
  assert.equal(restartedAgain.state.workspaces.fork2.status, 'idle')
  assert.deepEqual(await restartedAgain.finalize(f.lease.leaseId, { childStatus: 'completed' }), completed)
})

test('승인 메타 보존 후 최신 main의 등록 메타를 유지하며 기존 완료 커밋을 통합한다', realGit, async (t) => {
  const f = await gitLockQuarantine(t)
  await rm(f.lockPath)
  const metaPath = 'Assets/Scripts/Guard.cs.meta'
  const guid = 'a15eb8176d53e3d4f868808613a85690'
  const generated = Buffer.from(`fileFormatVersion: 2\nguid: ${guid}`)
  const registered = `fileFormatVersion: 2\nguid: ${guid}\nMonoImporter:\n  executionOrder: 0\n`
  await put(f.main, metaPath, registered)
  await git(f.main, ['add', metaPath])
  await git(f.main, ['commit', '-m', 'register missing meta'])
  const mainCommit = await git(f.main, ['rev-parse', 'HEAD'])
  await put(f.worker, metaPath, generated)
  const options = { untrackedMetaRecovery: { path: metaPath, expectedSha256: createHash('sha256').update(generated).digest('hex'), mainCommit } }
  await assert.rejects(f.manager.recoverIntegrationGitLockFailure(f.lease.leaseId, localRecoveryScope), /로컬 변경/)
  await f.manager.recoverIntegrationGitLockFailure(f.lease.leaseId, localRecoveryScope, options)
  assert.deepEqual(await readFile(path.join(f.worker, metaPath)), generated, '접수만으로 원본을 제거하지 않는다.')
  const restarted = new WorkspacePoolManager(f)
  await restarted.initialize()
  const result = await restarted.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed')
  assert.equal(result.integrationBaseCommit, mainCommit)
  assert.equal(await readFile(path.join(f.main, metaPath), 'utf8'), registered)
  assert.equal(await readFile(path.join(f.worker, metaPath), 'utf8'), registered)
  const record = restarted.state.leases[f.lease.leaseId].untrackedMetaRecovery
  assert.deepEqual(await readFile(path.join(f.sharedRoot, record.archiveRelative, 'original.meta')), generated)
  assert.equal(await git(f.worker, ['rev-parse', f.failed.integrationBranch]), f.failed.integrationHeadCommit)
  assert.equal(await git(f.worker, ['rev-parse', f.lease.branch]), f.failed.headCommit)
  assert.equal(restarted.state.workspaces.fork2.status, 'idle')
})

for (const alreadyApplied of [false, true]) {
test(`Git 잠금 복구 접수 후 main 진행(${alreadyApplied ? '기존 후보 반영 후' : '기존 후보 미반영'})도 결과를 중복 적용하지 않는다`, realGit, async (t) => {
  const f = await gitLockQuarantine(t)
  await rm(f.lockPath)
  // 구버전 기록: 응답에 후보가 없어도 오류·실제 Git·체크포인트로 검증한다.
  delete f.manager.state.leases[f.lease.leaseId].result.integrationHeadCommit
  const recovered = await f.manager.recoverIntegrationGitLockFailure(f.lease.leaseId, localRecoveryScope)
  assert.equal(recovered.integrationHeadCommit, f.failed.integrationHeadCommit)
  if (alreadyApplied) await git(f.main, ['merge', '--ff-only', '--no-overwrite-ignore', f.failed.integrationHeadCommit])
  await put(f.main, 'later.txt', '후속 커밋\n')
  await git(f.main, ['add', 'later.txt'])
  await git(f.main, ['commit', '-m', 'later commit'])
  const mainHead = await git(f.main, ['rev-parse', 'HEAD'])
  const completed = await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  if (alreadyApplied) {
    assert.equal(completed.integratedCommit, mainHead)
    assert.equal(await git(f.main, ['rev-parse', 'HEAD']), mainHead)
  } else {
    assert.equal(completed.integrationBaseCommit, mainHead)
    assert.equal(await git(f.main, ['rev-list', '--count', `${mainHead}..HEAD`]), '1')
  }
  assert.equal(await readFile(path.join(f.main, 'first.txt'), 'utf8'), 'worker:first.txt\n')
  assert.equal(await readFile(path.join(f.main, 'later.txt'), 'utf8'), '후속 커밋\n')
  assert.equal(await git(f.worker, ['rev-parse', f.failed.integrationBranch]), f.failed.integrationHeadCommit)
  assert.equal(f.manager.state.workspaces.fork2.status, 'idle')
})
}

for (const failureType of ['integration-git-lock', 'integration-head-changed', integrationCandidateDirtyReasonCode, integrationGitStatusFailureReasonCode]) test(`${failureType} 재시도 후보 생성 중 재시작은 일부 체크포인트만 완료로 반영하지 않는다`, async () => {
  const base = 'a'.repeat(40), first = 'b'.repeat(40), head = 'c'.repeat(40), candidate = 'd'.repeat(40)
  const workspace = { root: 'worker' }, integration = { root: 'main' }
  const calls = []
  const manager = new WorkspacePoolManager({ gitRunner: async (cwd, args) => {
    calls.push({ cwd, args })
    assert.equal(cwd, workspace.root, '불완전 후보가 main을 조회하거나 변경하면 안 된다.')
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? candidate : head
    if (args[0] === 'merge-base') return ''
    if (args[0] === 'rev-list') return args[2] === `${base}..${head}` ? `${first}\n${head}` : first
    throw new Error(`예기치 않은 Git 명령: ${args.join(' ')}`)
  } })
  const lease = { branch: 'source', baseCommit: base, headCommit: head, integrationBaseCommit: base,
    integrationHeadCommit: null, commits: [first, head], checkpoints: [{ commit: first }, { commit: head }],
    integrationRecoveryHistory: [{ type: failureType }] }
  await assert.rejects(manager.applyIntegration(lease, workspace, integration), /커밋 수/)
  assert.equal(lease.integrationHeadCommit, null)
  assert.ok(calls.length > 0)
})

test('Git 잠금 복구는 다른 경로·점유·세션·체크포인트·후보 변경·진행 중 Git을 거부한다', realGit, async (t) => {
  const f = await gitLockQuarantine(t)
  await rm(f.lockPath)
  const original = structuredClone(f.manager.state)
  const recover = () => f.manager.recoverIntegrationGitLockFailure(f.lease.leaseId, localRecoveryScope)
  await assert.rejects(f.manager.recoverIntegrationGitLockFailure(f.lease.leaseId, { ...localRecoveryScope, conversationId: 'other' }), /소유권/)
  f.manager.state.leases[f.lease.leaseId].result.jobId = 'other-job'
  await assert.rejects(recover(), /배정/)
  f.manager.state = structuredClone(original)
  f.manager.state.integrationLeaseId = 'other-lease'
  await assert.rejects(recover(), /다른 위임/)
  f.manager.state = structuredClone(original)
  f.manager.state.leases[f.lease.leaseId].result.error = f.failed.result.error.replaceAll(f.main.replaceAll('\\', '/'), f.worker.replaceAll('\\', '/'))
  await assert.rejects(recover(), /잠금 경로/)
  f.manager.state = structuredClone(original)
  for (const [root, entry] of [[f.worker, 'index.lock'], [f.main, 'MERGE_HEAD'], [f.main, 'CHERRY_PICK_HEAD'],
    [f.main, 'REBASE_HEAD'], [f.main, 'REVERT_HEAD'], [f.main, 'sequencer']]) {
    const target = path.resolve(root, await git(root, ['rev-parse', '--git-path', entry]))
    await writeFile(target, '진행 중인 Git 작업')
    await assert.rejects(recover(), /진행 중인/)
    assert.equal(await readFile(target, 'utf8'), '진행 중인 Git 작업')
    await rm(target)
  }
  const sessionPath = path.join(f.worker, '.ai-session.json')
  const session = await readFile(sessionPath, 'utf8')
  await writeFile(sessionPath, JSON.stringify({ ...JSON.parse(session), leaseId: 'other' }))
  await assert.rejects(recover(), /세션/)
  await writeFile(sessionPath, session)
  await put(f.main, 'base.txt', '사용자 추적 파일 변경\n')
  await assert.rejects(recover(), /로컬 변경/)
  assert.equal(await readFile(path.join(f.main, 'base.txt'), 'utf8'), '사용자 추적 파일 변경\n')
  await git(f.main, ['restore', 'base.txt'])
  f.manager.state.leases[f.lease.leaseId].checkpoints = []
  await assert.rejects(recover(), /체크포인트/)
  f.manager.state = structuredClone(original)
  await put(f.worker, 'first.txt', '수동 후보 변경\n')
  await git(f.worker, ['add', 'first.txt'])
  await git(f.worker, ['commit', '--amend', '--no-edit'])
  const forged = await git(f.worker, ['rev-parse', 'HEAD'])
  await assert.rejects(recover(), /HEAD/)
  // 오류·후보 해시까지 같이 바꿔도 완료 커밋의 tree 검증을 우회할 수 없다.
  const lease = f.manager.state.leases[f.lease.leaseId]
  lease.integrationHeadCommit = forged
  lease.result.integrationHeadCommit = forged
  lease.result.error = f.failed.result.error.replaceAll(f.failed.integrationHeadCommit, forged)
  await assert.rejects(recover(), /적용 결과/)
  assert.equal(lease.status, 'quarantined')
  assert.equal(lease.integrationRecoveryHistory, undefined)
})

test('Git 잠금 재시도에서 새 기준의 실제 충돌은 격리 해제로 우회하지 않는다', realGit, async (t) => {
  const f = await gitLockQuarantine(t)
  await rm(f.lockPath)
  await put(f.main, 'first.txt', '다른 업무의 충돌 변경\n')
  await git(f.main, ['add', 'first.txt'])
  await git(f.main, ['commit', '-m', 'conflicting main advance'])
  const mainHead = await git(f.main, ['rev-parse', 'HEAD'])
  await f.manager.recoverIntegrationGitLockFailure(f.lease.leaseId, localRecoveryScope)
  const result = await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'awaiting-conflict-resolution')
  assert.deepEqual(result.unmergedFiles, ['first.txt'])
  assert.equal(await git(f.main, ['rev-parse', 'HEAD']), mainHead)
  assert.equal(await readFile(path.join(f.main, 'first.txt'), 'utf8'), '다른 업무의 충돌 변경\n')
  assert.equal(await git(f.worker, ['rev-parse', f.failed.integrationBranch]), f.failed.integrationHeadCommit)
  assert.equal(f.manager.state.workspaces.fork2.status, 'resolving-integration-conflict')
})

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

for (const failureType of ['local-changes', 'integration-git-lock', 'integration-git-lock-reporting', 'integration-git-lock-meta', 'integration-head-changed', 'candidate-worktree', 'candidate-worktree-legacy', 'git-status', 'git-status-legacy', 'preserved-release', 'released-startup']) {
test(`통합 복구 API(${failureType})는 최신 승인·유휴 대화를 확인하고 결과 해시를 보존하며 하위 AI 실행 없이 복구한다`, realGit, async (t) => {
  const releasePreserved = ['preserved-release', 'released-startup'].includes(failureType)
  const reporting = failureType === 'integration-git-lock-reporting'
  const candidateWorktree = failureType.startsWith('candidate-worktree')
  const gitStatus = failureType.startsWith('git-status')
  const gitLock = failureType !== 'local-changes' && !releasePreserved && !candidateWorktree && !gitStatus
  const f = gitStatus ? await gitStatusQuarantine(t, failureType === 'git-status-legacy')
    : candidateWorktree ? await candidateWorktreeQuarantine(t, failureType === 'candidate-worktree-legacy')
    : await (gitLock ? gitLockQuarantine : localChangesQuarantine)(t)
  if (gitStatus) {
    f.artifact = 'untracked-after-status-failure.txt'
    await put(f.worker, f.artifact, '상태 조회 실패 뒤 보존해야 할 사용자 자료\n')
  }
  if (failureType === 'integration-head-changed') f.manager.state.leases[f.lease.leaseId].result.error = '통합 직전에 통합 작업공간의 HEAD가 변경되었습니다.'
  let untrackedMetaRecovery
  if (failureType === 'integration-git-lock-meta') {
    await rm(f.lockPath)
    const metaPath = 'Assets/Scripts/Guard.cs.meta'
    const guid = 'a15eb8176d53e3d4f868808613a85690'
    const original = `fileFormatVersion: 2\nguid: ${guid}`
    await put(f.main, metaPath, `${original}\nMonoImporter:\n  executionOrder: 0\n`)
    await git(f.main, ['add', metaPath])
    await git(f.main, ['commit', '-m', 'register missing meta'])
    await put(f.worker, metaPath, original)
    untrackedMetaRecovery = { path: metaPath, expectedSha256: createHash('sha256').update(original).digest('hex'), mainCommit: await git(f.main, ['rev-parse', 'HEAD']) }
    await writeFile(f.lockPath, '다른 Git 작업의 잠금')
  }
  const dataDirectory = path.join(f.root, 'server-data')
  await mkdir(dataDirectory)
  if (failureType === 'released-startup') {
    await git(f.worker, ['restore', 'base.txt'])
    // 서버 중지 유지보수는 다른 worker의 복구를 실행하거나 초기 상태를 다시 저장하지 않는다.
    const before = await readFile(f.stateFile, 'utf8')
    const maintenance = new WorkspacePoolManager(f)
    await maintenance.initialize({ recoverWorkspaces: false })
    assert.equal(await readFile(f.stateFile, 'utf8'), before)
    await maintenance.releasePreservedIntegrationFailure(f.lease.leaseId, { ...localRecoveryScope, operator: 'NHN' }, { reason: '사용자가 승인한 유지보수 반환' })
    f.manager = maintenance
  }
  await writeFile(path.join(dataDirectory, '_workspace-pool.json'), JSON.stringify(f.manager.state))
  const now = new Date().toISOString()
  const resultText = '기존 완료 결과를 그대로 보존합니다.'
  const delegation = { id: 'local-integration', mapId: 'map-test', parentCardId: 'parent', targetCardId: 'card-test',
    parentConversationId: 'parent-conversation', targetConversationId: 'conversation-test', state: 'failed',
    childStatus: 'completed', childTurnId: 'original-turn', childOperationId: 'original-operation',
    childResultSnapshot: resultText, childResultHash: createHash('sha256').update(resultText).digest('hex'),
    childResultTurnId: 'original-turn', workspaceLease: f.lease,
    workspaceResult: f.manager.state.leases[f.lease.leaseId].result.previousResult ?? f.manager.state.leases[f.lease.leaseId].result,
    startedBy: 'user-admin', createdAt: now, updatedAt: now, completedAt: now }
  if (reporting) Object.assign(delegation, { state: 'waking-parent', completedAt: null,
    wakeOperationId: 'interrupted-report', parentDispatchState: 'waiting-resume', parentTurnId: 'old-report-turn' })
  const successor = { ...delegation, id: 'successor', state: 'running', childStatus: null, childOperationId: 'successor-operation',
    childTurnId: 'successor-turn', workspaceLease: { leaseId: 'different-lease', workspaceId: 'fork-other' }, workspaceResult: null }
  await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify(releasePreserved ? [delegation, successor] : [delegation]))
  const map = { id: 'map-test', title: '통합 재시도 검증', version: 1,
    nodes: [{ id: 'parent', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', status: 'planned', progress: 0, aiConversationId: 'parent-conversation' } },
      { id: 'card-test', position: { x: 300, y: 0 }, data: { kind: 'task', label: '완료 작업', status: 'done', progress: 100, isWork: true, aiConversationId: 'conversation-test', sharedKnowledge: resultText } }],
    edges: [{ id: 'edge', source: 'parent', target: 'card-test' }] }
  await writeFile(path.join(dataDirectory, 'map-test.json'), JSON.stringify(map))
  const posts = []
  let runtimeState = 'idle'
  let originalDispatchState = 'completed'
  const upstream = createServer(async (request, response) => {
    if (request.method === 'POST') posts.push(request.url)
    const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
    if (request.url.endsWith('/capabilities')) return send({ schemaVersion: 3, workspaceLeaseVersion: 0, explicitCompletionAfterInterruption: false })
    if (request.url === '/api/conversations/conversation-test') return send({ id: 'conversation-test', runtime: { state: runtimeState, isProcessing: runtimeState !== 'idle', pendingConfirmations: 0 }, extra: { workspace: f.worker } })
    if (request.url === '/api/internal/conversation-runtimes/active') return send({ items: [] })
    if (reporting && request.url.endsWith('/interrupted-report')) return send({ state: 'waiting_resume',
      operationId: 'interrupted-report', conversationId: 'parent-conversation', turnId: 'old-report-turn' })
    if (releasePreserved && request.url.endsWith('/original-operation')) return send({ state: originalDispatchState, operationId: 'original-operation', conversationId: 'conversation-test', turnId: 'original-turn' })
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
    if (failureType === 'released-startup') {
      const list = (await (await fetch(baseUrl + '/api/maps/map-test/ai-delegations', { headers })).json()).delegations
      const closed = list.find(item => item.id === delegation.id)
      assert.equal(closed.state, 'closed')
      assert.equal(closed.workCompleted, false)
      assert.equal(closed.closedByOperator, 'NHN')
      assert.equal(closed.workspaceResult.status, 'released-preserved')
      assert.equal(closed.recovery, undefined)
      assert.equal(list.find(item => item.id === successor.id).state, 'running')
      assert.equal(await git(f.main, ['rev-parse', 'HEAD']), f.lease.baseCommit)
      assert.equal(JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8')).workspaces.fork2.status, 'idle')
      assert.deepEqual(posts, [])
      return
    }
    if (releasePreserved) {
      const list = async () => (await (await fetch(baseUrl + '/api/maps/map-test/ai-delegations', { headers })).json()).delegations
      const before = (await list()).find(item => item.id === delegation.id)
      assert.equal(before.recovery.recoveryAvailable, false)
      assert.equal(before.recovery.blockedReasonCode, 'AI_DELEGATION_ALREADY_ACTIVE')
      assert.equal(before.recovery.blockedByDelegationId, successor.id)
      assert.equal(before.closure.workspaceReleaseRequired, true)
      const endpoint = baseUrl + '/api/maps/map-test/ai-delegations/local-integration/close'
      const input = { expectedUpdatedAt: before.updatedAt, sourceRevision: 1, targetRevision: 1,
        reason: 'no-longer-needed', note: '후속 별도 위임은 유지하고 과거 결과를 보존하여 반환합니다.',
        confirmClosedWithoutCompletion: true, confirmResultReportDiscarded: true, confirmPreserveWorkspaceResult: true }
      const post = body => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
      assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401)
      assert.equal((await post({ ...input, confirmPreserveWorkspaceResult: false })).status, 400)
      assert.equal((await post({ ...input, expectedUpdatedAt: 'stale' })).status, 409)
      originalDispatchState = 'running'
      assert.match((await (await post(input)).json()).error, /아직 실행/)
      originalDispatchState = 'completed'
      assert.match((await (await post(input)).json()).error, /로컬 변경/)
      await git(f.worker, ['restore', 'base.txt'])
      const beforeMap = await readFile(path.join(dataDirectory, 'map-test.json'), 'utf8')
      const closedResponse = await post(input)
      const closed = await closedResponse.json()
      assert.equal(closedResponse.status, 200, JSON.stringify(closed))
      assert.equal(closed.delegation.state, 'closed')
      assert.equal(closed.delegation.workCompleted, false)
      assert.equal(closed.delegation.workspaceResult.status, 'released-preserved')
      assert.equal(closed.workspaceChanged, true)
      assert.equal(closed.cardChanged, false)
      assert.equal(closed.childExecutionRequested, false)
      assert.equal((await list()).find(item => item.id === successor.id).state, 'running')
      assert.equal(await readFile(path.join(dataDirectory, 'map-test.json'), 'utf8'), beforeMap)
      assert.equal(await git(f.main, ['rev-parse', 'HEAD']), f.lease.baseCommit)
      assert.deepEqual(posts, [])
      return
    }
    const endpoint = baseUrl + '/api/maps/map-test/ai-delegations/local-integration/recover'
    const input = { instruction: '로컬 변경을 해소했으므로 완료 커밋의 통합만 재시도합니다.', expectedUpdatedAt: now, sourceRevision: 1, targetRevision: 1, confirmApprovedScope: true,
      ...(untrackedMetaRecovery ? { untrackedMetaRecovery } : {}) }
    let lastInput
    const post = async body => {
      const latest = (await (await fetch(baseUrl + '/api/maps/map-test/ai-delegations', { headers })).json()).delegations[0]
      lastInput = { ...body, expectedUpdatedAt: body.expectedUpdatedAt === now ? latest.updatedAt : body.expectedUpdatedAt,
        recoveryRequestId: 'request-' + Date.now() + '-' + Math.random().toString(36).slice(2) }
      return fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(lastInput) })
    }
    const settle = async response => {
      assert.equal(response.status, 202)
      const accepted = await response.json()
      for (let attempt = 0; attempt < 400; attempt++) {
        const latest = (await (await fetch(baseUrl + '/api/maps/map-test/ai-delegations', { headers })).json()).delegations[0]
        if (['failed', 'accepted'].includes(latest.integrationRecoveryRequest?.status)) return latest
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(JSON.stringify({ accepted, errors }))
    }
    assert.equal((await post({ ...input, expectedUpdatedAt: 'stale' })).status, 409)
    assert.equal((await post({ ...input, confirmApprovedScope: false })).status, 400)
    runtimeState = 'running'
    assert.match((await settle(await post(input))).integrationRecoveryRequest.message, /running/)
    runtimeState = 'idle'
    const dirty = await settle(await post(input))
    assert.equal(dirty.integrationRecoveryRequest.status, 'failed')
    assert.match(dirty.integrationRecoveryRequest.message, gitLock ? /Git 잠금/ : /로컬 변경/)
    assert.equal(JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8')).leases[f.lease.leaseId].status, 'quarantined')
    if (candidateWorktree || gitStatus) await rename(path.join(f.worker, f.artifact), path.join(f.root, 'api-preserved-output.dll'))
    else if (gitLock) await rm(f.lockPath)
    else {
      await rename(path.join(f.worker, 'base.txt'), path.join(f.root, 'api-user-backup.txt'))
      await git(f.worker, ['restore', 'base.txt'])
    }
    if (untrackedMetaRecovery) {
      assert.equal((await post({ ...input, untrackedMetaRecovery: { ...untrackedMetaRecovery, path: '../outside.cs.meta' } })).status, 400)
      assert.equal((await settle(await post({ ...input, untrackedMetaRecovery: { ...untrackedMetaRecovery, expectedSha256: 'a'.repeat(64) } }))).integrationRecoveryRequest.status, 'failed')
      assert.equal((await settle(await post({ ...input, untrackedMetaRecovery: undefined }))).integrationRecoveryRequest.status, 'failed')
    } else if (!gitLock || failureType === 'integration-head-changed') {
      assert.equal((await post({ ...input, untrackedMetaRecovery: { path: 'Assets/Guard.cs.meta', expectedSha256: 'a'.repeat(64), mainCommit: 'b'.repeat(40) } })).status, 400)
    }
    const response = await post(input)
    const body = await response.clone().json()
    assert.equal(response.status, 202, JSON.stringify({ body, errors }))
    assert.equal(body.recovery.kind, 'retry-integration')
    assert.equal(body.recovery.childReexecuted, false)
    assert.equal(body.recovery.status, 'queued')
    const settled = await settle(response)
    assert.equal(settled.state, 'waiting-integration')
    const saved = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8'))[0]
    assert.equal(saved.childOperationId, delegation.childOperationId)
    assert.equal(saved.childResultSnapshot, resultText)
    assert.equal(saved.childResultHash, delegation.childResultHash)
    assert.equal(saved.childTurnId, delegation.childTurnId)
    assert.equal(saved.workspaceLease.leaseId, f.lease.leaseId)
    assert.equal(saved.attemptHistory.length, 1)
    if (reporting) {
      assert.equal(saved.attemptHistory[0].state, 'waking-parent')
      assert.equal(saved.attemptHistory[0].wakeOperationId, 'interrupted-report')
      assert.equal(saved.attemptHistory[0].parentDispatchState, 'waiting-resume')
      assert.equal(saved.wakeOperationId, null, '이전 실패 보고와 새 통합 결과의 보고를 분리한다.')
    }
    const duplicate = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(lastInput) })
    assert.equal(duplicate.status, 202, '같은 요청은 새 하위 실행 없이 기존 receipt로 확인한다.')
    assert.equal((await duplicate.json()).repeated, true)
    assert.deepEqual(posts, [])
    if (untrackedMetaRecovery) {
      const pool = JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8'))
      const record = pool.leases[f.lease.leaseId].untrackedMetaRecovery
      const original = await readFile(path.join(f.worker, untrackedMetaRecovery.path))
      assert.deepEqual(await readFile(path.join(f.sharedRoot, record.archiveRelative, 'original.meta')), original)
      assert.equal(createHash('sha256').update(original).digest('hex'), untrackedMetaRecovery.expectedSha256)
    }
    const savedMap = JSON.parse(await readFile(path.join(dataDirectory, 'map-test.json'), 'utf8'))
    assert.deepEqual(savedMap.nodes, map.nodes)
  } finally {
    if (server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited }
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
})
}

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
