import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'
import { RemoteWorkspacePool, remoteWorkspaceFacade } from '../server/lib/remoteWorkspacePool.mjs'
import { createWorkspaceAgent } from '../runner/lib/workspaceAgent.mjs'
import { git, jsonFile, saveJson, workspaceLock } from '../server/lib/remoteWorkspaceProtocol.mjs'
import { RemoteWorkspaceArtifacts } from '../server/lib/remoteWorkspaceArtifacts.mjs'

const message = { summary: '원격 Fork 기능 검증', background: '원격 작업 결과를 안전하게 전달해야 합니다.', cause: '머신 간 작업공간이 분리되어 있습니다.', changes: '의도한 기능 파일만 체크포인트로 전달했습니다.' }
async function fixture(t, { remoteCommitPrefix } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mnp-remote-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const integration = path.join(root, 'integration'), localRoot = path.join(root, 'local-worker'), worker = path.join(root, 'remote-worker')
  await mkdir(integration)
  await git(integration, ['init', '-b', 'main'])
  await git(integration, ['config', 'user.name', 'MnP test'])
  await git(integration, ['config', 'user.email', 'mnp@example.invalid'])
  await writeFile(path.join(integration, '.gitignore'), '.ai-session.json\n')
  await writeFile(path.join(integration, '.gitattributes'), '*.txt text eol=lf\n')
  await writeFile(path.join(integration, 'feature.txt'), 'baseline\n')
  await git(integration, ['add', '.']); await git(integration, ['commit', '-m', '[김용민] 테스트 기준선'])
  const originUrl = 'https://example.invalid/project.git'
  await git(integration, ['remote', 'add', 'origin', originUrl])
  for (const clone of [localRoot, worker]) {
    await git(integration, ['clone', integration, clone])
    await git(clone, ['remote', 'set-url', 'origin', originUrl])
    await git(clone, ['config', 'user.name', 'MnP test']); await git(clone, ['config', 'user.email', 'mnp@example.invalid'])
  }
  const registryFile = path.join(root, 'local.json')
  await saveJson(registryFile, { schemaVersion: 1, poolId: 'main-pool', sharedRoot: path.join(root, 'local-shared'), originUrl,
    workspaces: [{ id: 'integration', root: integration, role: 'integration' }, { id: 'fork1', root: localRoot, role: 'worker' }] })
  const local = new WorkspacePoolManager({ registryFile, stateFile: path.join(root, 'local-state.json') })
  await local.initialize()
  let agent, lostAction = null, active = false
  const remote = new RemoteWorkspacePool({ local, stateFile: path.join(root, 'remote-state.json'), mainMachineId: () => 'main',
    callRunner: async (machineId, pathname, { body }) => {
      assert.equal(machineId, 'macbook'); assert.equal(pathname, '/mnp/workspaces')
      const result = await agent.execute(body)
      if (lostAction === body.action) { lostAction = null; throw new Error('simulated lost response') }
      return result
    } })
  await remote.initialize()
  const remoteRegistry = path.join(root, 'remote.json')
  await saveJson(remoteRegistry, { schemaVersion: 1, coordinatorId: remote.state.coordinatorId, poolId: 'mac-pool', originUrl,
    sharedRoot: path.join(root, 'remote-shared'), workspaces: [{ id: 'fork1', root: worker, role: 'worker' }],
    ...(remoteCommitPrefix === undefined ? {} : { commitPrefix: remoteCommitPrefix }) })
  const buildAgent = () => createWorkspaceAgent({ registryFile: remoteRegistry, machineId: 'macbook', runtimeIdle: async () => !active,
    request: (pathname, body, method) => {
      const match = /^\/api\/machines\/([^/]+)\/runner\/workspace-artifacts\/([^/]+)\/([^/]+)\/(.*)$/.exec(pathname)
      return remote.artifactRequest(match[1], match[2], match[3], match[4], method, body)
    } })
  agent = await buildAgent()
  const observe = () => agent.report().then((report) => remote.observe('macbook', report))
  await observe()
  const report = remote.report('macbook')
  await remote.approve('macbook', { poolId: report.poolId, registryDigest: report.registryDigest, enabled: true })
  const acquire = (requestId = 'delegation-1') => remote.acquire({ machineId: 'macbook', requestId, mapId: 'map', cardId: 'card', conversationId: 'conversation-1', cardLabel: '검증' })
  const checkpoint = (lease, paths = ['feature.txt'], requestId = 'checkpoint-1') => remote.checkpoint(lease.leaseId, { requestId, jobId: lease.jobId, mapId: 'map', cardId: 'card', conversationId: 'conversation-1', paths, commitMessage: message })
  return { root, integration, localRoot, worker, local, remote, acquire, checkpoint, observe, facade: remoteWorkspaceFacade(local, remote),
    agent: () => agent, restartAgent: async () => { agent = await buildAgent() }, lose: (action) => { lostAction = action }, active: (value) => { active = value } }
}

test('실제 Git: 원격 prepare → checkpoint → staging 통합 → 반환 확인', async (t) => {
  const f = await fixture(t)
  const localBefore = JSON.stringify(f.local.state.leases)
  const lease = await f.acquire()
  assert.equal(lease.ownership.machineId, 'macbook')
  assert.equal(lease.projectRoot, f.worker)
  assert.equal(lease.baselineMode, 'present')
  assert.equal(await jsonFile(path.join(f.remote.artifacts.directory(lease.leaseId, 'baseline'), 'manifest.json')), null)
  const snapshot = f.facade.publicSnapshot({ machineId: 'macbook', conversationId: 'conversation-1' })
  assert.equal(snapshot.workspaces.length, 1)
  assert.equal(snapshot.workspaces[0].assignedToCurrentConversation, true)
  assert.equal(snapshot.workspaces[0].projectRoot, f.worker)
  await f.agent().validateDispatch({ workspaceLease: lease, strategy: 'resume', targetConversationId: 'conversation-1' })
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n')
  const checkpoint = await f.checkpoint(lease)
  assert.equal(checkpoint.lease.ownership.generation, 1)
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed'); assert.equal(result.remoteReleased, true)
  assert.equal(f.remote.state.leases[lease.leaseId].cleanupPending, false)
  assert.equal(f.agent().state.leases[lease.leaseId].cleanupPending, false)
  await assert.rejects(() => stat(path.join(f.remote.artifacts.root, lease.leaseId)), { code: 'ENOENT' })
  await assert.rejects(() => stat(path.join(f.root, 'remote-shared', 'remote-runner', 'artifacts', lease.leaseId)), { code: 'ENOENT' })
  await assert.rejects(() => stat(path.join(f.remote.root, 'staging', lease.leaseId)), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'remote change\n')
  assert.equal(await jsonFile(path.join(f.worker, '.ai-session.json')), null)
  assert.equal(JSON.stringify(f.local.state.leases), localBefore)
  assert.equal(f.local.state.integrationLeaseId, null)
  await f.observe()
  const next = await f.acquire('delegation-2')
  assert.equal(next.ownership.generation, 2)
  assert.notEqual(next.leaseId, lease.leaseId)
})

test('원격 Fork 체크포인트 제목은 Runner registry의 commitPrefix를 우선하고 없으면 전달된 계정 이름을 쓴다', async (t) => {
  for (const [remoteCommitPrefix, expectedTitle] of [['[원격팀]', `[원격팀] ${message.summary}`], [undefined, `[김용민] ${message.summary}`]]) {
    const f = await fixture(t, { remoteCommitPrefix }), lease = await f.acquire()
    await writeFile(path.join(f.worker, 'feature.txt'), 'remote prefix change\n')
    const result = await f.remote.checkpoint(lease.leaseId, { requestId: 'checkpoint-prefix', jobId: lease.jobId, mapId: 'map', cardId: 'card',
      conversationId: 'conversation-1', paths: ['feature.txt'], commitMessage: message, commitAuthorName: '김용민' })
    assert.equal(await git(f.worker, ['log', '-1', '--format=%s']), expectedTitle)
    assert.equal(result.checkpoint.commitPrefix, expectedTitle.slice(0, expectedTitle.indexOf(']') + 1))
  }
})

test('원격 Fork 체크포인트도 로컬과 같은 knowledge-inbox 경로 거부를 적용한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  const head = await git(f.worker, ['rev-parse', 'HEAD'])
  await mkdir(path.join(f.worker, 'knowledge-inbox'), { recursive: true })
  await writeFile(path.join(f.worker, 'knowledge-inbox', 'job-1.md'), 'proposal\n')
  await assert.rejects(() => f.checkpoint(lease, ['knowledge-inbox/job-1.md'], 'checkpoint-inbox'), (error) => {
    assert.equal(error.reasonCode, 'AI_WORKSPACE_CHECKPOINT_PATH_REJECTED')
    assert.match(error.message, /knowledge-inbox\/job-1\.md/)
    return true
  })
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), head, '거부된 경로는 커밋하지 않는다')
  assert.match(await git(f.worker, ['status', '--porcelain=v1', '--untracked-files=all']), /knowledge-inbox\/job-1\.md/)

  // Runner HTTP 응답처럼 code만 전달돼도 같은 reasonCode로 보고한다.
  const callRunner = f.remote.callRunner
  f.remote.callRunner = async (...args) => {
    try { return await callRunner(...args) } catch (error) {
      throw Object.assign(new Error(error.message), { code: error.reasonCode ?? error.code, reasonCode: 'REMOTE_REQUEST_FAILED' })
    }
  }
  await assert.rejects(() => f.checkpoint(lease, ['knowledge-inbox/job-1.md'], 'checkpoint-inbox-http'), { reasonCode: 'AI_WORKSPACE_CHECKPOINT_PATH_REJECTED' })
  f.remote.callRunner = callRunner

  await rm(path.join(f.worker, 'knowledge-inbox'), { recursive: true, force: true })
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n')
  const checkpoint = await f.checkpoint(lease, ['feature.txt'], 'checkpoint-after-inbox')
  assert.ok(checkpoint.checkpoint?.commit, '다른 경로는 새 requestId로 정상 체크포인트한다')
})

test('기준 커밋이 뒤처진 worker에는 전체 이력 대신 작은 증분 bundle만 전송한다', async (t) => {
  const f = await fixture(t)
  await writeFile(path.join(f.integration, 'feature.txt'), 'next baseline\n')
  await git(f.integration, ['add', 'feature.txt']); await git(f.integration, ['commit', '-m', '[김용민] 기준선 변경'])
  const baseCommit = await git(f.integration, ['rev-parse', 'HEAD'])
  const lease = await f.acquire()
  assert.equal(lease.baselineMode, 'delta')
  assert.equal(lease.baseCommit, baseCommit)
  assert.equal((await f.remote.artifacts.manifest(lease.leaseId, 'baseline')).size < 100_000, true)
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), baseCommit)
})

test('공통 기준을 확인할 수 없는 worker는 전체 이력 전송으로 우회하지 않는다', async (t) => {
  const f = await fixture(t)
  await writeFile(path.join(f.worker, 'feature.txt'), 'worker-only\n')
  await git(f.worker, ['add', 'feature.txt']); await git(f.worker, ['commit', '-m', '[김용민] 원격 전용 변경'])
  await f.observe()
  await assert.rejects(() => f.acquire(), /REMOTE_WORKSPACE_BOOTSTRAP_REQUIRED/)
  assert.equal(Object.keys(f.remote.state.leases).length, 0)
})

test('이전 전송 버전의 승인 기록은 새 버전에서 자동 재활성화되지 않는다', async (t) => {
  const f = await fixture(t)
  const approval = Object.values(f.remote.state.pools)[0]
  approval.protocolVersion = 1
  assert.equal(f.remote.snapshot('macbook').remotePools[0].approved, false)
  await assert.rejects(() => f.acquire(), /REMOTE_WORKSPACE_POOL_NOT_APPROVED/)
  assert.equal(Object.keys(f.remote.state.leases).length, 0)
})

test('결과 bundle은 기준 커밋 이후 변경만 담고 완료 후 모두 정리한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'small result\n')
  await f.checkpoint(lease)
  const sealed = await f.remote.command(f.remote.state.leases[lease.leaseId], 'seal', { checkpointRound: 1 })
  assert.equal(sealed.status, 'sealed')
  assert.equal(sealed.manifest.size < 100_000, true)
  assert.equal((await stat(f.remote.artifacts.file(lease.leaseId, 'result'))).size, sealed.manifest.size)
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed')
  await assert.rejects(() => stat(f.remote.artifacts.file(lease.leaseId, 'result')), { code: 'ENOENT' })
})

test('무변경 체크포인트는 빈 결과 bundle 없이 완료하고 worker를 반환한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  const checkpoint = await f.remote.checkpoint(lease.leaseId, { requestId: 'no-change', jobId: lease.jobId,
    mapId: 'map', cardId: 'card', conversationId: 'conversation-1', paths: [], confirmNoChanges: true })
  assert.equal(checkpoint.noChanges, true)
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed')
  assert.equal(f.remote.state.leases[lease.leaseId].resultMode, 'present')
  assert.equal(f.remote.state.leases[lease.leaseId].releaseMode, 'present')
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), lease.baseCommit)
  await assert.rejects(() => stat(f.remote.artifacts.file(lease.leaseId, 'result')), { code: 'ENOENT' })
})

test('완료 후 산출물 정리가 실패하면 결과는 유지하고 다음 배정을 차단한 뒤 재시도한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(lease)
  const cleanup = f.remote.artifacts.cleanup.bind(f.remote.artifacts)
  f.remote.artifacts.cleanup = async () => { throw new Error('simulated cleanup failure') }
  assert.equal((await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })).status, 'completed')
  assert.equal(f.remote.state.leases[lease.leaseId].cleanupPending, true)
  await assert.rejects(() => f.acquire('delegation-2'), /REMOTE_WORKSPACE_CLEANUP_REQUIRED/)
  f.remote.artifacts.cleanup = cleanup
  await f.observe()
  const next = await f.acquire('delegation-2')
  assert.notEqual(next.leaseId, lease.leaseId)
  assert.equal(f.remote.state.leases[lease.leaseId].cleanupPending, false)
  await assert.rejects(() => stat(path.join(f.remote.artifacts.root, lease.leaseId)), { code: 'ENOENT' })
})

test('완료 정리는 staging 밖의 추적·미추적 drift 복구 자료와 결과 기록을 보존한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'checkpointed result\n')
  await f.checkpoint(lease)
  const stored = f.remote.state.leases[lease.leaseId]
  const sealed = await f.remote.command(stored, 'seal', { checkpointRound: 1 })
  stored.headCommit = sealed.headCommit; stored.resultMode = sealed.resultMode
  const stage = await f.remote.stage(stored)
  const projectRoot = stage.state.leases[lease.leaseId].projectRoot
  await writeFile(path.join(projectRoot, 'feature.txt'), 'uncheckpointed review\n')
  await writeFile(path.join(projectRoot, 'operator-review.txt'), 'preserve review material\n')

  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed')
  const recoveryRoot = path.join(f.remote.root, 'recovery', lease.leaseId)
  assert.ok(result.driftArchive.startsWith(`${recoveryRoot}${path.sep}`))
  assert.equal(await readFile(path.join(result.driftArchive, 'untracked', 'operator-review.txt'), 'utf8'), 'preserve review material\n')
  assert.match(await readFile(path.join(result.driftArchive, 'tracked.diff'), 'utf8'), /uncheckpointed review/)
  assert.equal((await jsonFile(path.join(recoveryRoot, 'job-results', `${lease.jobId}.json`))).driftArchive, result.driftArchive)
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'checkpointed result\n')
  await assert.rejects(() => stat(path.join(f.remote.root, 'staging', lease.leaseId)), { code: 'ENOENT' })
  await assert.rejects(() => stat(path.join(f.remote.artifacts.root, lease.leaseId)), { code: 'ENOENT' })
})

test('재시작 후 이전 버전의 staging 복구 경로는 유지하고 큰 저장소만 정리한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await f.remote.checkpoint(lease.leaseId, { requestId: 'no-change', jobId: lease.jobId,
    mapId: 'map', cardId: 'card', conversationId: 'conversation-1', paths: [], confirmNoChanges: true })
  await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  const stagingRoot = path.join(f.remote.root, 'staging', lease.leaseId)
  const archive = path.join(stagingRoot, 'workspace-drift', 'fork1', 'legacy-archive')
  await mkdir(path.join(archive, 'untracked'), { recursive: true })
  await writeFile(path.join(archive, 'untracked', 'review.txt'), 'legacy recovery\n')
  await mkdir(path.join(stagingRoot, 'repository'))
  await writeFile(path.join(stagingRoot, 'repository', 'large-worktree.txt'), 'discardable checkout\n')
  await saveJson(path.join(stagingRoot, 'state.json'), { leases: {} })
  const stored = f.remote.state.leases[lease.leaseId]
  stored.result.driftArchive = archive; stored.cleanupPending = true
  await saveJson(path.join(stagingRoot, 'job-results', `${lease.jobId}.json`), stored.result)
  await f.remote.persist()

  const restarted = new RemoteWorkspacePool({ local: f.local, stateFile: f.remote.stateFile,
    mainMachineId: f.remote.mainMachineId, callRunner: f.remote.callRunner })
  await restarted.initialize()
  await restarted.cleanupCompletedLeases()
  assert.equal(restarted.state.leases[lease.leaseId].cleanupPending, false)
  assert.equal(restarted.state.leases[lease.leaseId].result.driftArchive, archive)
  assert.equal(await readFile(path.join(archive, 'untracked', 'review.txt'), 'utf8'), 'legacy recovery\n')
  assert.equal((await jsonFile(path.join(stagingRoot, 'job-results', `${lease.jobId}.json`))).driftArchive, archive)
  await assert.rejects(() => stat(path.join(stagingRoot, 'repository')), { code: 'ENOENT' })
  await assert.rejects(() => stat(path.join(stagingRoot, 'state.json')), { code: 'ENOENT' })
})

test('봉인 전에 접수된 대기 중 chunk는 완료 시 거절되고 정리 후 산출물을 재생성하지 않는다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'late duplicate chunk\n'); await f.checkpoint(lease)
  const sealed = await f.remote.command(f.remote.state.leases[lease.leaseId], 'seal', { checkpointRound: 1 })
  const chunk = await f.remote.artifacts.chunk(lease.leaseId, 'result', 0)
  let resume, cleanupStarted
  // 큐 구현의 변경에 맞춰 접수 직후 스케줄러를 정지한다. 기한 시험은 storage-budgets가 맡고
  // 여기서는 기존의 완료 후 재검증·파일 재생성 금지 판정을 그대로 확인한다.
  const acquire = f.remote.artifactLocks.acquire
  f.remote.artifactLocks.acquire = (key, ...args) => {
    if (key !== `state:remote-artifact/${lease.leaseId}:result`) return acquire(key, ...args)
    f.remote.artifactLocks.acquire = acquire
    return new Promise((resolve) => { resume = () => resolve(acquire(key, ...args)) })
  }
  const cleaning = new Promise((resolve) => { cleanupStarted = resolve })
  const cleanup = f.remote.cleanupCompletedLease.bind(f.remote)
  f.remote.cleanupCompletedLease = (stored) => { cleanupStarted(); return cleanup(stored) }
  const pendingUpload = f.remote.artifactRequest('macbook', lease.leaseId, 'result', 'chunks/0', 'POST',
    { manifest: sealed.manifest, chunk }).catch((error) => error)
  const finalizing = f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  try {
    await cleaning
    assert.equal(f.remote.state.leases[lease.leaseId].cleanupPending, true)
    assert.ok(await stat(path.join(f.remote.artifacts.root, lease.leaseId)))
  } finally { resume() }
  assert.equal((await pendingUpload).code, 'REMOTE_WORKSPACE_ARTIFACT_LEASE_COMPLETED')
  assert.equal((await finalizing).status, 'completed')
  assert.equal(f.remote.state.leases[lease.leaseId].cleanupPending, false)
  await assert.rejects(() => stat(path.join(f.remote.artifacts.root, lease.leaseId)), { code: 'ENOENT' })
  assert.equal(f.remote.artifactQueues.has(`${lease.leaseId}:result`), false)
})

test('이미 실행 중인 chunk 저장을 기다린 뒤 완료 산출물을 정리한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'in-flight duplicate chunk\n'); await f.checkpoint(lease)
  const sealed = await f.remote.command(f.remote.state.leases[lease.leaseId], 'seal', { checkpointRound: 1 })
  const chunk = await f.remote.artifacts.chunk(lease.leaseId, 'result', 0)
  let resume, uploadStarted, cleanupStarted
  const blocked = new Promise((resolve) => { resume = resolve })
  const uploading = new Promise((resolve) => { uploadStarted = resolve })
  const cleaning = new Promise((resolve) => { cleanupStarted = resolve })
  const receive = f.remote.artifacts.receive.bind(f.remote.artifacts)
  f.remote.artifacts.receive = async (...args) => { uploadStarted(); await blocked; return receive(...args) }
  const cleanup = f.remote.cleanupCompletedLease.bind(f.remote)
  f.remote.cleanupCompletedLease = (stored) => { cleanupStarted(); return cleanup(stored) }
  const pendingUpload = f.remote.artifactRequest('macbook', lease.leaseId, 'result', 'chunks/0', 'POST', { manifest: sealed.manifest, chunk })
  await uploading
  const finalizing = f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  try {
    await cleaning
    assert.equal(f.remote.state.leases[lease.leaseId].cleanupPending, true)
    assert.ok(await stat(path.join(f.remote.artifacts.root, lease.leaseId)))
  } finally { resume() }
  assert.equal((await pendingUpload).received, true)
  assert.equal((await finalizing).status, 'completed')
  await assert.rejects(() => stat(path.join(f.remote.artifacts.root, lease.leaseId)), { code: 'ENOENT' })
})

test('완료 정리·Runner 재시작 후 receipt 재조회는 파일 없이 멱등하고 새 전송은 차단한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'receipt replay\n'); await f.checkpoint(lease)
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  const release = Object.values(f.remote.state.leases[lease.leaseId].operations).find((operation) => operation.action === 'release')
  await f.restartAgent()
  assert.equal((await f.agent().execute(release)).released, true)
  assert.deepEqual(await f.remote.finalize(lease.leaseId, { childStatus: 'completed' }), result)
  await assert.rejects(() => f.remote.artifactRequest('macbook', lease.leaseId, 'result', 'complete', 'POST'), /ARTIFACT_LEASE_COMPLETED/)
  await assert.rejects(() => f.remote.artifactRequest('macbook', lease.leaseId, 'release', 'manifest', 'GET'), /ARTIFACT_LEASE_COMPLETED/)
  await assert.rejects(() => stat(path.join(f.remote.artifacts.root, lease.leaseId)), { code: 'ENOENT' })
})

test('staging은 로컬 속성·메타데이터 제외를 복사하고 미설정 신원·실제 변경을 안전하게 처리한다', async (t) => {
  const f = await fixture(t)
  const relative = 'ProjectSettings/AudioManager.asset'
  const attributes = `${relative} -text -eol\n`
  const baseline = '%YAML 1.1\r\nAudioManager:\r\n  m_Volume: 1\r\n'
  await mkdir(path.join(f.integration, 'ProjectSettings'))
  await writeFile(path.join(f.integration, '.gitignore'), '')
  await writeFile(path.join(f.integration, '.gitattributes'), '*.txt text eol=lf\n*.asset merge=unityyamlmerge eol=lf\n')
  await writeFile(path.join(f.integration, '.git', 'info', 'attributes'), attributes)
  await writeFile(path.join(f.integration, '.git', 'info', 'exclude'), '/.ai-session.json\n')
  await writeFile(path.join(f.integration, relative), baseline)
  await git(f.integration, ['add', '.']); await git(f.integration, ['commit', '-m', '[김용민] 기존 CRLF 기준선 검증'])
  await writeFile(path.join(f.worker, '.git', 'info', 'attributes'), attributes)
  await writeFile(path.join(f.worker, '.git', 'info', 'exclude'), '/.ai-session.json\n')
  await git(f.worker, ['fetch', f.integration, 'main']); await git(f.worker, ['merge', '--ff-only', 'FETCH_HEAD'])
  await f.observe()
  const lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'attribute-safe result\n'); await f.checkpoint(lease)
  const stored = f.remote.state.leases[lease.leaseId]
  const sealed = await f.remote.command(stored, 'seal', { checkpointRound: 1 })
  stored.headCommit = sealed.headCommit; stored.resultMode = sealed.resultMode
  await git(f.integration, ['config', '--unset', 'user.name'])
  await git(f.integration, ['config', '--unset', 'user.email'])
  const stage = await f.remote.stage(stored)
  const projectRoot = stage.state.leases[lease.leaseId].projectRoot
  assert.equal(await readFile(path.join(projectRoot, '.git', 'info', 'attributes'), 'utf8'), attributes)
  assert.equal(await readFile(path.join(projectRoot, '.git', 'info', 'exclude'), 'utf8'), '/.ai-session.json\n')
  assert.equal(await readFile(path.join(projectRoot, relative), 'utf8'), baseline)
  assert.equal(await git(projectRoot, ['status', '--porcelain', '--untracked-files=all']), '')
  for (const key of ['user.name', 'user.email']) {
    const identity = await git(f.integration, ['config', '--get', key]).catch((error) => {
      if (error.code === 1) return null
      throw error
    })
    const copied = await git(projectRoot, ['config', '--local', '--get', key]).catch((error) => {
      if (error.code === 1) return null
      throw error
    })
    assert.equal(copied, identity)
  }
  await git(f.integration, ['config', 'user.name', 'MnP test'])
  await git(f.integration, ['config', 'user.email', 'mnp@example.invalid'])

  await writeFile(path.join(f.integration, relative), baseline.replace('m_Volume: 1', 'm_Volume: 2'))
  assert.equal((await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })).status, 'waiting-integration')
  assert.match(await readFile(path.join(f.integration, relative), 'utf8'), /m_Volume: 2/)
  await writeFile(path.join(f.integration, relative), baseline)
  assert.equal((await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })).status, 'completed')
})

test('원격 결과 통합은 최신 main 미커밋 변경을 보존하고 자동 대기한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(lease)
  await writeFile(path.join(f.integration, 'feature.txt'), 'user uncommitted\n')
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'waiting-integration')
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'user uncommitted\n')
  assert.ok(await jsonFile(path.join(f.worker, '.ai-session.json')))
})

test('prepare 응답 유실·Runner 재시작은 같은 lease/receipt만 재사용한다', async (t) => {
  const f = await fixture(t)
  f.lose('prepare')
  await assert.rejects(f.acquire(), /lost response/)
  const stored = Object.values(f.remote.state.leases)[0]
  await f.restartAgent()
  const lease = await f.acquire()
  assert.equal(lease.leaseId, stored.leaseId)
  assert.equal(Object.keys(f.agent().state.leases).length, 1)
  const prepare = Object.values(stored.operations)[0]
  await assert.rejects(() => f.agent().execute({ ...prepare, lease: { ...prepare.lease, branch: 'other' } }), /REMOTE_WORKSPACE_OPERATION_CONFLICT/)
  await assert.rejects(() => f.agent().validateDispatch({ workspaceLease: { ...lease, ownership: { ...lease.ownership, generation: 2 } }, strategy: 'resume', targetConversationId: 'conversation-1' }), /ASSIGNMENT_MISMATCH/)
  await assert.rejects(() => f.agent().validateDispatch({ workspaceLease: lease, strategy: 'resume', targetConversationId: 'another' }), /CONVERSATION_MISMATCH/)
})

test('release 응답 유실은 통합 완료와 worker 반환을 구분하고 멱등 복구한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(lease)
  f.lose('release')
  await assert.rejects(() => f.remote.finalize(lease.leaseId, { childStatus: 'completed' }), /lost response/)
  assert.equal(f.remote.state.leases[lease.leaseId].status, 'release-pending')
  assert.ok(await jsonFile(path.join(f.remote.artifacts.directory(lease.leaseId, 'result'), 'manifest.json')))
  await assert.rejects(() => f.acquire('other'), /사용 가능한 원격 worker/)
  await f.restartAgent()
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed')
  assert.equal(result.remoteReleased, true)
})

test('원격 통합 충돌은 main을 보존하고 메인 staging 수동 복구로만 해제한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(lease)
  await writeFile(path.join(f.integration, 'feature.txt'), 'main change\n')
  await git(f.integration, ['add', 'feature.txt']); await git(f.integration, ['commit', '-m', '[김용민] 메인 변경'])
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'quarantined'); assert.equal(result.reasonCode, 'REMOTE_INTEGRATION_CONFLICT_MANUAL_REVIEW')
  assert.notEqual(result.stagingRoot, f.worker)
  assert.ok((await readFile(path.join(result.stagingRoot, '.git', 'objects', 'info', 'alternates'), 'utf8')).includes(path.basename(f.integration)))
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'main change\n')
  await writeFile(path.join(result.stagingRoot, 'feature.txt'), 'merged result\n')
  await git(result.stagingRoot, ['add', 'feature.txt'])
  const recovered = await f.remote.retryIntegration(lease.leaseId, { confirmed: true, expectedHead: await git(result.stagingRoot, ['rev-parse', 'HEAD']) })
  assert.equal(recovered.status, 'completed')
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'merged result\n')
})

test('물리 잠금과 coordinator 소유권은 다른 풀의 동시 점유를 차단한다', async (t) => {
  const f = await fixture(t)
  await workspaceLock(f.worker, () => assert.rejects(() => f.acquire(), /REMOTE_WORKSPACE_LOCKED/))
  assert.equal(await git(f.worker, ['branch', '--show-current']), 'main')
  assert.equal(await jsonFile(path.join(f.worker, '.ai-session.json')), null)
  const localWorker = { id: 'fork1', root: f.worker }
  const release = await f.local.claimLocalWorkspace(localWorker)
  await release()
  assert.ok(await jsonFile(path.join(f.worker, '.git', 'mnp-local-owner.json')))
})

test('artifact 크기·hash·chunk 중복/변조·경로 탈출을 검증한다', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-artifact-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sender = new RemoteWorkspaceArtifacts(path.join(root, 'send')), receiver = new RemoteWorkspaceArtifacts(path.join(root, 'receive'))
  await mkdir(path.dirname(sender.file('lease-1', 'result')), { recursive: true })
  await writeFile(sender.file('lease-1', 'result'), Buffer.alloc(300_000, 42))
  const manifest = await sender.publish('lease-1', 'result')
  const first = await sender.chunk('lease-1', 'result', 0)
  await receiver.receive('lease-1', 'result', manifest, first)
  await receiver.receive('lease-1', 'result', manifest, first)
  await assert.rejects(() => receiver.receive('lease-1', 'result', manifest, { ...first, sha256: 'a'.repeat(64) }), /HASH_MISMATCH/)
  await assert.rejects(() => receiver.finish('lease-1', 'result'))
  await receiver.receive('lease-1', 'result', manifest, await sender.chunk('lease-1', 'result', 1))
  assert.deepEqual(await receiver.finish('lease-1', 'result'), manifest)
  assert.throws(() => receiver.file('../escape', 'result'), /ID_INVALID/)
  assert.throws(() => receiver.validate({ size: 9 * 1024 ** 3, sha256: 'a'.repeat(64) }), /MANIFEST_INVALID/)
})

test('체크포인트 requestId는 중복 커밋을 방지하고 새 변경과 입력 충돌을 구분한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'first\n')
  const first = await f.checkpoint(lease)
  assert.deepEqual((await f.checkpoint(lease)).checkpoint, first.checkpoint)
  await assert.rejects(() => f.checkpoint(lease, ['another.txt']), /OPERATION_CONFLICT/)
  await writeFile(path.join(f.worker, 'feature.txt'), 'second\n')
  const second = await f.checkpoint(lease, ['feature.txt'], 'checkpoint-2')
  assert.notEqual(first.checkpoint.commit, second.checkpoint.commit)
  assert.equal(f.agent().state.leases[lease.leaseId].checkpoints.length, 2)
})

test('빈 변경 체크포인트는 개수를 늘리지 않고 격리 후 재시도로 lease를 활성화하지 않는다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  const empty = await f.checkpoint(lease)
  assert.equal(empty.checkpoint, null)
  assert.equal(empty.lease.checkpointCount, 0)
  assert.equal(f.agent().state.leases[lease.leaseId].checkpoints.length, 0)
  await f.remote.quarantine(lease.leaseId, '실행 확인 필요')
  await assert.rejects(() => f.checkpoint(lease), /RECOVERY_REQUIRED/)
  assert.equal(f.remote.state.leases[lease.leaseId].status, 'quarantined')
  assert.equal(f.agent().state.leases[lease.leaseId].status, 'quarantined')
})

test('local 통합 잠금을 가진 진행 중 lease는 remote 통합에서 변경하지 않는다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  f.local.state.integrationLeaseId = 'existing-local-lease'
  f.local.state.leases['existing-local-lease'] = { status: 'integrating', marker: 'user-owned' }
  await f.local.persist()
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(lease)
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'waiting-integration')
  assert.equal(f.local.state.integrationLeaseId, 'existing-local-lease')
  assert.deepEqual(f.local.state.leases['existing-local-lease'], { status: 'integrating', marker: 'user-owned' })
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'baseline\n')
})

test('등록 승인·보고 만료·artifact 머신 귀속 및 원격 소유 Fork 로컬 동기화를 차단한다', async (t) => {
  const f = await fixture(t), report = f.remote.report('macbook')
  await assert.rejects(() => f.remote.approve('macbook', { poolId: report.poolId, registryDigest: 'b'.repeat(64), enabled: true }), /REGISTRATION_MISMATCH/)
  const lease = await f.acquire()
  await assert.rejects(() => f.remote.artifactRequest('other-machine', lease.leaseId, 'baseline', 'manifest', 'GET'), /ASSIGNMENT_MISMATCH/)
  assert.equal(await f.local.claimLocalWorkspace({ id: 'fork1', root: f.worker }), null)
  const localGuard = new WorkspacePoolManager({ stateFile: path.join(f.root, 'guard.json') })
  localGuard.registry = { ...f.local.registry, workers: [{ id: 'fork1', root: f.worker }], workspaces: [f.local.registry.integration, { id: 'fork1', root: f.worker }] }
  localGuard.state = { integrationLeaseId: null, leases: {}, workspaces: { fork1: { status: 'idle' } } }
  await assert.rejects(() => localGuard.synchronizeIdleWorkersToIntegration(), /원격 coordinator/)
  await f.remote.observe('macbook', undefined)
  assert.equal(f.remote.snapshot('macbook').remotePools[0].stale, true)
  assert.ok(f.remote.poolForWorkspace(f.worker, 'macbook'))
  assert.throws(() => f.remote.pool('macbook'), /RUNNER_STALE/)
})

test('runtime 경합은 Git을 변경하지 않고 명시적 prepare 복구 뒤 같은 lease만 준비한다', async (t) => {
  const f = await fixture(t)
  const head = await git(f.worker, ['rev-parse', 'HEAD'])
  f.active(true)
  await assert.rejects(() => f.acquire(), /RUNTIME_ACTIVE/)
  const lease = Object.values(f.remote.state.leases)[0]
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), head)
  assert.equal(await git(f.worker, ['branch', '--show-current']), 'main')
  assert.equal(await jsonFile(path.join(f.worker, '.ai-session.json')), null)
  await assert.rejects(() => f.remote.retryPreparation(lease.leaseId, { confirmed: true, expectedLeaseId: lease.leaseId, generation: 2 }), /CONFIRMATION_REQUIRED/)
  f.active(false)
  const prepared = await f.remote.retryPreparation(lease.leaseId, { confirmed: true, expectedLeaseId: lease.leaseId, generation: 1 })
  assert.equal(prepared.leaseId, lease.leaseId)
  assert.equal(Object.keys(f.agent().state.leases).length, 1)
})

test('최초 Runner 보고 전에도 coordinator ID는 서버 재시작 후 유지된다', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-coordinator-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { local: {}, stateFile: path.join(root, '_state.json'), mainMachineId: () => 'main' }
  const first = new RemoteWorkspacePool(options)
  await first.initialize()
  const restarted = new RemoteWorkspacePool(options)
  await restarted.initialize()
  assert.equal(restarted.state.coordinatorId, first.state.coordinatorId)
})
