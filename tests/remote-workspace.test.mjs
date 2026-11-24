import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
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
  // 모의 Runner는 정기 보고를 보내지 않는다. 실제 Git 실행 속도가 보고 만료 검증에 섞이지 않게 한다.
  const reportTime = Date.now()
  const remote = new RemoteWorkspacePool({ local, now: () => reportTime, stateFile: path.join(root, 'remote-state.json'), mainMachineId: () => 'main',
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

test('실제 Git: 원격 prepare → checkpoint → Git 객체 통합 → 반환 확인', async (t) => {
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
  await assert.rejects(() => stat(f.remote.integrationStore(lease.leaseId)), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'remote change\n')
  assert.equal(await jsonFile(path.join(f.worker, '.ai-session.json')), null)
  assert.equal(JSON.stringify(f.local.state.leases), localBefore)
  assert.equal(f.local.state.integrationLeaseId, null)
  await f.observe()
  const next = await f.acquire('delegation-2')
  assert.equal(next.ownership.generation, 2)
  assert.notEqual(next.leaseId, lease.leaseId)
})

test('원격 Fork는 무시 규칙 아래 추적 파일 삭제를 체크포인트하고 통합한다', async (t) => {
  const f = await fixture(t)
  const lease = await f.acquire()
  await writeFile(path.join(f.worker, '.gitignore'), '.ai-session.json\n/feature.txt\n')
  await unlink(path.join(f.worker, 'feature.txt'))
  const checkpoint = await f.checkpoint(lease, ['.gitignore', 'feature.txt'])
  assert.deepEqual(checkpoint.checkpoint.paths, ['.gitignore', 'feature.txt'])
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed')
  await assert.rejects(stat(path.join(f.integration, 'feature.txt')), { code: 'ENOENT' })
  assert.equal(await git(f.integration, ['status', '--porcelain']), '')
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

test('원격 통합은 메인 서버에 작업 트리를 만들지 않고 통합 저장소는 완료 후 정리한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'incoming.txt'), 'remote file\n'); await f.checkpoint(lease, ['incoming.txt'])
  // 메인에 같은 경로의 미추적 파일이 있으면 통합하지 않고 기다린다. 그동안 통합 저장소를 확인한다.
  await writeFile(path.join(f.integration, 'incoming.txt'), 'user untracked\n')
  const waiting = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(waiting.status, 'waiting-integration'); assert.equal(waiting.reasonCode, 'integration-untracked-collision')
  assert.deepEqual(waiting.untrackedChanges, ['incoming.txt'])
  assert.equal(waiting.integrationHeadCommit, undefined, '로컬 전용 결과 정정 복구를 원격 결과에 제시하지 않는다')
  const store = f.remote.integrationStore(lease.leaseId)
  assert.equal(await git(store, ['rev-parse', '--is-bare-repository']), 'true')
  for (const name of ['incoming.txt', 'feature.txt', '.gitignore']) await assert.rejects(() => stat(path.join(store, name)), { code: 'ENOENT' })
  await assert.rejects(() => stat(path.join(f.remote.root, 'staging', lease.leaseId)), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(f.integration, 'incoming.txt'), 'utf8'), 'user untracked\n')
  assert.equal(f.local.state.integrationLeaseId, null, '대기 중에는 메인 통합 잠금을 잡지 않는다')
  await rm(path.join(f.integration, 'incoming.txt'))
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed'); assert.equal(result.remoteReleased, true); assert.equal(result.replayed, false)
  assert.equal(await readFile(path.join(f.integration, 'incoming.txt'), 'utf8'), 'remote file\n')
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD']), f.remote.state.leases[lease.leaseId].headCommit, '메인이 그대로면 체크포인트 커밋을 그대로 반영한다')
  await assert.rejects(() => stat(store), { code: 'ENOENT' })
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

test('메인이 진행했으면 원격 결과를 Git 객체로 다시 쌓고 CRLF 기준선·속성과 원 작성자·메시지를 유지한다', async (t) => {
  const f = await fixture(t)
  const relative = 'ProjectSettings/AudioManager.asset'
  const attributes = `${relative} -text -eol\n`
  const baseline = '%YAML 1.1\r\nAudioManager:\r\n  m_Volume: 1\r\n'
  await mkdir(path.join(f.integration, 'ProjectSettings'))
  await writeFile(path.join(f.integration, '.gitattributes'), '*.txt text eol=lf\n*.asset merge=unityyamlmerge eol=lf\n')
  await writeFile(path.join(f.integration, '.git', 'info', 'attributes'), attributes)
  await writeFile(path.join(f.integration, relative), baseline)
  await git(f.integration, ['add', '.']); await git(f.integration, ['commit', '-m', '[김용민] 기존 CRLF 기준선 검증'])
  await writeFile(path.join(f.worker, '.git', 'info', 'attributes'), attributes)
  await git(f.worker, ['fetch', f.integration, 'main']); await git(f.worker, ['merge', '--ff-only', 'FETCH_HEAD'])
  await f.observe()
  const lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'attribute-safe result\n'); await f.checkpoint(lease)
  const mainMoved = await commitMain(f, 'other.txt', 'main progressed\n')
  // 통합 저장소에 신원이 없으면 원 커밋의 신원으로 다시 쌓는다.
  await git(f.integration, ['config', '--unset', 'user.name']); await git(f.integration, ['config', '--unset', 'user.email'])
  await writeFile(path.join(f.integration, relative), baseline.replace('m_Volume: 1', 'm_Volume: 2'))
  assert.equal((await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })).status, 'waiting-integration')
  assert.match(await readFile(path.join(f.integration, relative), 'utf8'), /m_Volume: 2/)
  await writeFile(path.join(f.integration, relative), baseline)
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed'); assert.equal(result.replayed, true)
  assert.equal(result.integrationBaseCommit, mainMoved)
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD^']), mainMoved)
  assert.equal(await readFile(path.join(f.integration, relative), 'utf8'), baseline)
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'attribute-safe result\n')
  assert.equal(await readFile(path.join(f.integration, 'other.txt'), 'utf8'), 'main progressed\n')
  assert.equal(await git(f.integration, ['status', '--porcelain', '--untracked-files=all']), '')
  const format = '--format=%an%n%ae%n%ad%n%cn%n%ce%n%B'
  const original = await git(f.worker, ['log', '-1', '--date=raw', format, f.remote.state.leases[lease.leaseId].headCommit])
  assert.equal(await git(f.integration, ['log', '-1', '--date=raw', format, 'HEAD']), original)
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

// 원격 결과와 메인이 같은 줄을 바꾼 충돌 상황을 만든다.
async function remoteConflict(f) {
  const lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(lease)
  const mainHead = await commitMain(f, 'feature.txt', 'main change\n')
  return { lease, mainHead, awaiting: await f.remote.finalize(lease.leaseId, { childStatus: 'completed' }) }
}

test('메인 충돌은 원격 Fork의 통합 브랜치에서 하위 AI가 해결하고 해결 후보만 메인에 반영한다', async (t) => {
  const f = await fixture(t)
  const { lease, mainHead, awaiting } = await remoteConflict(f)
  assert.equal(awaiting.status, 'awaiting-conflict-resolution'); assert.deepEqual(awaiting.unmergedFiles, ['feature.txt'])
  assert.equal(awaiting.conflictRound, 1); assert.equal(awaiting.integrationBaseCommit, mainHead)
  assert.equal(awaiting.integrationBranch, `mnp/integrate/${lease.jobId}-1`)
  // 메인은 바뀌지 않고 잠금도 잡지 않는다. Fork는 최신 메인 기준 통합 브랜치에 충돌을 남긴다.
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD']), mainHead)
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'main change\n')
  assert.equal(f.local.state.integrationLeaseId, null)
  assert.equal(await git(f.worker, ['branch', '--show-current']), awaiting.integrationBranch)
  assert.match(await readFile(path.join(f.worker, 'feature.txt'), 'utf8'), /<<<<<<<[\s\S]*main change[\s\S]*remote change/)
  const session = await jsonFile(path.join(f.worker, '.ai-session.json'))
  assert.equal(session.branch, lease.branch); assert.equal(session.integration.branch, awaiting.integrationBranch)
  // 충돌 해결 대화의 실행 전 검증은 통합 브랜치에서도 같은 lease로 통과한다.
  await f.agent().validateDispatch({ workspaceLease: lease, strategy: 'resume', targetConversationId: 'conversation-1' })
  assert.deepEqual(await f.remote.finalize(lease.leaseId, { childStatus: 'completed' }), awaiting, 'AI 해결 전에는 다시 준비하지 않는다')
  // 하위 AI가 해결한 것처럼 파일을 정리하고 stage한다. cherry-pick 마무리는 Runner가 한다.
  await writeFile(path.join(f.worker, 'feature.txt'), 'merged result\n'); await git(f.worker, ['add', 'feature.txt'])
  const result = await f.remote.completeConflictResolution(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed'); assert.equal(result.remoteReleased, true); assert.equal(result.conflictResolvedByAi, true)
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'merged result\n')
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD^']), mainHead)
  assert.equal(await git(f.integration, ['status', '--porcelain', '--untracked-files=all']), '')
  assert.equal(await git(f.worker, ['branch', '--show-current']), 'mnp/idle/fork1')
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), await git(f.integration, ['rev-parse', 'HEAD']))
  await assert.rejects(() => stat(f.remote.integrationStore(lease.leaseId)), { code: 'ENOENT' })
})

test('충돌 해결 중 메인이 더 진행하면 해결 후보를 최신 메인 위에 다시 쌓는다', async (t) => {
  const f = await fixture(t)
  const { lease, awaiting } = await remoteConflict(f)
  assert.equal(awaiting.status, 'awaiting-conflict-resolution')
  const later = await commitMain(f, 'other.txt', 'while resolving\n')
  await writeFile(path.join(f.worker, 'feature.txt'), 'merged result\n'); await git(f.worker, ['add', 'feature.txt'])
  const result = await f.remote.completeConflictResolution(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed'); assert.equal(result.replayed, true); assert.equal(result.integrationBaseCommit, later)
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD^']), later)
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'merged result\n')
  assert.equal(await readFile(path.join(f.integration, 'other.txt'), 'utf8'), 'while resolving\n')
})

test('하위 AI가 충돌을 남기면 같은 통합 브랜치로 다시 요청하고 한도를 넘거나 실패하면 메인을 바꾸지 않고 격리한다', async (t) => {
  const f = await fixture(t)
  const { lease, mainHead, awaiting } = await remoteConflict(f)
  const second = await f.remote.completeConflictResolution(lease.leaseId, { childStatus: 'completed' })
  assert.equal(second.status, 'awaiting-conflict-resolution'); assert.equal(second.conflictRound, 2)
  assert.equal(second.integrationBranch, awaiting.integrationBranch)
  const third = await f.remote.completeConflictResolution(lease.leaseId, { childStatus: 'completed' })
  assert.equal(third.conflictRound, 3)
  const held = await f.remote.completeConflictResolution(lease.leaseId, { childStatus: 'completed' })
  assert.equal(held.status, 'quarantined'); assert.equal(held.reasonCode, 'REMOTE_INTEGRATION_CONFLICT_LIMIT')
  assert.equal(held.phase, 'remote-integration'); assert.deepEqual(held.unmergedFiles, ['feature.txt'])
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD']), mainHead)

  const g = await fixture(t)
  const failed = await remoteConflict(g)
  const unresolved = await g.remote.completeConflictResolution(failed.lease.leaseId, { childStatus: 'failed', childError: '충돌 해결 중 중단' })
  assert.equal(unresolved.status, 'quarantined'); assert.equal(unresolved.reasonCode, 'REMOTE_INTEGRATION_CONFLICT_UNRESOLVED')
  assert.equal(unresolved.reason, '충돌 해결 중 중단')
  assert.equal(await git(g.integration, ['rev-parse', 'HEAD']), failed.mainHead)
})

test('충돌 해결 명령을 모르는 이전 Runner는 메인을 바꾸지 않고 갱신 안내로 격리하며 갱신 후 재시도로 이어간다', async (t) => {
  const f = await fixture(t)
  const callRunner = f.remote.callRunner
  f.remote.callRunner = async (machineId, pathname, options) => {
    if (String(options?.body?.action).startsWith('integrate-')) throw Object.assign(new Error('REMOTE_WORKSPACE_ACTION_INVALID'), { code: 'REMOTE_WORKSPACE_ACTION_INVALID' })
    return callRunner(machineId, pathname, options)
  }
  const { lease, mainHead, awaiting: held } = await remoteConflict(f)
  assert.equal(held.status, 'quarantined'); assert.equal(held.reasonCode, 'REMOTE_WORKSPACE_ACTION_INVALID')
  assert.match(held.reason, /서브 머신의 MnP를 갱신/)
  assert.equal(f.remote.state.leases[lease.leaseId].pendingOperation, undefined)
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD']), mainHead)
  f.remote.callRunner = callRunner
  const queued = await f.remote.retryIntegration(lease.leaseId, { confirmed: true, expectedHead: f.remote.state.leases[lease.leaseId].headCommit })
  assert.equal(queued.phase, 'integration-requeued')
  const awaiting = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(awaiting.status, 'awaiting-conflict-resolution'); assert.equal(awaiting.integrationBranch, `mnp/integrate/${lease.jobId}-2`)
  assert.equal(f.remote.state.leases[lease.leaseId].integrationHistory.length, 1)
})

test('충돌 해결이 중단된 원격 통합도 재시도로 Fork의 진행 중 충돌을 보존 정리하고 새 회차로 다시 준비한다', async (t) => {
  const f = await fixture(t)
  const { lease, awaiting } = await remoteConflict(f)
  await writeFile(path.join(f.worker, 'scratch.txt'), 'partial resolution note\n')
  await assert.rejects(() => f.remote.retryIntegration(lease.leaseId, { confirmed: true, expectedHead: 'a'.repeat(40) }),
    { reasonCode: 'REMOTE_WORKSPACE_RECOVERY_CONFIRMATION_REQUIRED' })
  const queued = await f.remote.retryIntegration(lease.leaseId, { confirmed: true, expectedHead: f.remote.state.leases[lease.leaseId].headCommit })
  assert.equal(queued.status, 'waiting-integration'); assert.equal(queued.previousResult.status, 'awaiting-conflict-resolution')
  const again = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(again.status, 'awaiting-conflict-resolution'); assert.equal(again.conflictRound, 1)
  assert.equal(again.integrationBranch, `mnp/integrate/${lease.jobId}-2`); assert.notEqual(again.integrationBranch, awaiting.integrationBranch)
  assert.equal(await git(f.worker, ['branch', '--show-current']), again.integrationBranch)
  const drift = f.agent().state.leases[lease.leaseId].remoteDriftArchives.at(-1)
  assert.equal(await readFile(path.join(drift, 'untracked', 'scratch.txt'), 'utf8'), 'partial resolution note\n')
  await writeFile(path.join(f.worker, 'feature.txt'), 'merged result\n'); await git(f.worker, ['add', 'feature.txt'])
  assert.equal((await f.remote.completeConflictResolution(lease.leaseId, { childStatus: 'completed' })).status, 'completed')
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'merged result\n')
})

test('fast-forward 뒤 기록 전에 중단돼도 같은 후보를 다시 쌓지 않고 반환만 이어간다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(lease)
  await commitMain(f, 'other.txt', 'main progressed\n')
  const release = f.remote.release
  f.remote.release = async () => { throw new Error('simulated stop after fast-forward') }
  await assert.rejects(() => f.remote.finalize(lease.leaseId, { childStatus: 'completed' }), /simulated stop/)
  const applied = await git(f.integration, ['rev-parse', 'HEAD'])
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'remote change\n')
  f.remote.release = release
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed'); assert.equal(result.integratedCommit, applied)
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD']), applied, '같은 변경을 다시 쌓지 않는다')
})

test('메인에 이미 같은 변경이 있으면 빈 커밋을 만들지 않고 기록만 남긴 뒤 반환한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'same change\n'); await f.checkpoint(lease)
  const mainHead = await commitMain(f, 'feature.txt', 'same change\n')
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed'); assert.equal(result.integratedCommit, mainHead)
  assert.deepEqual(result.droppedCommits, [f.remote.state.leases[lease.leaseId].headCommit])
  assert.equal(await git(f.integration, ['rev-parse', 'HEAD']), mainHead)
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), mainHead)
})

test('수정 전 staging 방식에서 격리된 기록도 재시도로 봉인 결과부터 통합하고 남은 staging 사본을 정리한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire()
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(lease)
  // 봉인까지만 진행하고, 수정 전 서버가 남긴 형식의 격리 기록과 미완성 staging 사본을 만든다.
  const stored = f.remote.state.leases[lease.leaseId]
  const sealed = await f.remote.command(stored, 'seal', { checkpointRound: stored.checkpoints.length })
  Object.assign(stored, { headCommit: sealed.headCommit, checkpoints: sealed.checkpoints, sealed: true, resultMode: sealed.resultMode, status: 'quarantined' })
  const repository = path.join(f.remote.root, 'staging', lease.leaseId, 'repository')
  stored.result = { status: 'quarantined', leaseId: lease.leaseId, jobId: lease.jobId,
    reason: `Command failed: git --no-optional-locks -C ${repository} switch ${lease.branch}\nerror: unable to create file Assets/Deep/Name.strings: Filename too long\n` }
  await f.remote.persist()
  await mkdir(repository, { recursive: true }); await writeFile(path.join(repository, 'partial.txt'), 'partial checkout\n')
  await assert.rejects(() => f.remote.retryIntegration(lease.leaseId, { confirmed: false, expectedHead: stored.headCommit }),
    { reasonCode: 'REMOTE_WORKSPACE_RECOVERY_CONFIRMATION_REQUIRED' })
  const queued = await f.remote.retryIntegration(lease.leaseId, { confirmed: true, expectedHead: stored.headCommit })
  assert.equal(queued.status, 'waiting-integration'); assert.equal(queued.phase, 'integration-requeued')
  assert.match(queued.previousResult.reason, /Filename too long/)
  assert.deepEqual(await f.remote.retryIntegration(lease.leaseId, {}), queued, '같은 재시도는 같은 기록을 돌려준다')
  const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.status, 'completed'); assert.equal(result.remoteReleased, true)
  assert.equal(await readFile(path.join(f.integration, 'feature.txt'), 'utf8'), 'remote change\n')
  await assert.rejects(() => stat(path.join(f.remote.root, 'staging', lease.leaseId)), { code: 'ENOENT' })
})

test('원격 통합 반복은 메인 서버에 staging이나 통합 저장소를 남기지 않는다', { timeout: 900_000 }, async (t) => {
  const f = await fixture(t)
  const count = Number(process.env.MNP_REMOTE_INTEGRATION_LOAD_COUNT ?? 30)
  const started = Date.now()
  for (let index = 0; index < count; index++) {
    await f.observe()
    const lease = await f.acquire(`load-${index}`)
    await writeFile(path.join(f.worker, `load-${index}.txt`), `remote ${index}\n`)
    await f.checkpoint(lease, [`load-${index}.txt`], `checkpoint-${index}`)
    // 다른 통합이 먼저 끝난 상황: 매 건 Git 객체로 메인 위에 다시 쌓는다.
    await commitMain(f, `main-${index}.txt`, `main ${index}\n`)
    const result = await f.remote.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(result.status, 'completed'); assert.equal(result.replayed, true)
  }
  const elapsed = Date.now() - started
  t.diagnostic(`remote integrations=${count} elapsedMs=${elapsed} averageMs=${Math.round(elapsed / count)}`)
  await assert.rejects(() => stat(path.join(f.remote.root, 'staging')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(path.join(f.remote.root, 'integration')).catch((error) => { if (error.code === 'ENOENT') return []; throw error }), [])
  assert.equal(await git(f.integration, ['status', '--porcelain', '--untracked-files=all']), '')
  assert.equal(Number(await git(f.integration, ['rev-list', '--count', 'HEAD'])), 1 + count * 2)
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

test('실제 Git: 명시한 원격 풀은 고정 대화에 증분 기준선을 배정하고 요청 중복을 재사용한다', async (t) => {
  const f = await fixture(t)
  const baseline = await git(f.worker, ['rev-parse', 'HEAD'])
  await writeFile(path.join(f.integration, 'main-latest.txt'), '메인 최신 변경\n')
  await git(f.integration, ['add', 'main-latest.txt'])
  await git(f.integration, ['commit', '-m', '[김용민] 메인 최신 기준'])
  const latest = await git(f.integration, ['rev-parse', 'HEAD'])
  const request = { machineId: 'macbook', workspacePoolId: 'mac-pool', requestId: 'fixed-to-pool',
    mapId: 'map', cardId: 'card', conversationId: 'fixed-conversation' }
  const lease = await f.facade.acquire(request)
  assert.equal(lease.projectRoot, f.worker)
  assert.equal(lease.baseCommit, latest)
  assert.equal(lease.baselineCommit, baseline)
  assert.equal(lease.baselineMode, 'delta')
  assert.equal(lease.ownership.machineId, 'macbook')
  assert.equal((await jsonFile(path.join(f.worker, '.ai-session.json'))).conversationId, 'fixed-conversation')
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), latest)
  assert.equal((await f.facade.acquire(request)).leaseId, lease.leaseId)
  await f.agent().validateDispatch({ strategy: 'resume', targetConversationId: 'fixed-conversation', workspaceLease: lease })
  await assert.rejects(f.agent().validateDispatch({ strategy: 'resume', targetConversationId: 'other-conversation', workspaceLease: lease }), { reasonCode: 'REMOTE_WORKSPACE_CONVERSATION_MISMATCH' })
})

async function commitMain(f, file, text) {
  await writeFile(path.join(f.integration, file), text)
  await git(f.integration, ['add', file]); await git(f.integration, ['commit', '-m', '[김용민] 메인 진행'])
  return git(f.integration, ['rev-parse', 'HEAD'])
}

test('실행 전 정책 실패로 격리된 lease는 최신 메인 증분으로 결과 없이 반환하고 기록을 보존한다', async (t) => {
  const f = await fixture(t), lease = await f.acquire('unstarted-policy')
  await f.remote.bindConversation(lease.leaseId, 'conversation-1')
  const failure = '대상 대화의 위임 규칙 적용·확인에 실패해 작업을 시작하지 않았습니다.'
  await f.remote.quarantine(lease.leaseId, failure)
  const mainHead = await commitMain(f, 'main-next.txt', '메인 진행\n')
  await f.observe()
  const result = await f.remote.releaseUnstarted(lease.leaseId, { reason: '실행 전 실패 반환', evidence: { kind: 'operator' } })
  assert.equal(result.status, 'cancelled'); assert.equal(result.releaseKind, 'unstarted'); assert.equal(result.remoteReleased, true)
  assert.equal(result.idleCommit, mainHead); assert.equal(result.releaseMode, 'delta')
  assert.equal(result.previousResult.status, 'quarantined'); assert.equal(result.previousResult.reason, failure)
  const stored = f.remote.state.leases[lease.leaseId]
  assert.equal(stored.status, 'completed'); assert.equal(stored.cleanupPending, false)
  assert.equal(stored.unstartedRelease.previousStatus, 'quarantined')
  assert.deepEqual(Object.values(stored.operations).map((item) => item.action).sort(), ['bind', 'prepare', 'quarantine', 'release'])
  assert.equal(await git(f.worker, ['rev-parse', 'HEAD']), mainHead)
  assert.equal(await git(f.worker, ['branch', '--show-current']), 'mnp/idle/fork1')
  assert.equal(await git(f.worker, ['rev-parse', `refs/heads/${lease.branch}`]), lease.baseCommit)
  assert.equal(await jsonFile(path.join(f.worker, '.ai-session.json')), null)
  assert.ok(await jsonFile(path.join(f.worker, '.git', 'mnp-remote-owner.json')))
  assert.equal(f.agent().state.leases[lease.leaseId].status, 'completed')
  await assert.rejects(() => f.agent().validateDispatch({ workspaceLease: lease, strategy: 'resume', targetConversationId: 'conversation-1' }), /RECOVERY_REQUIRED/)
  assert.deepEqual(await f.remote.releaseUnstarted(lease.leaseId, { reason: '같은 요청 반복' }), result)
  await f.observe()
  const next = await f.acquire('after-unstarted')
  assert.equal(next.ownership.generation, 2); assert.equal(next.baseCommit, mainHead); assert.equal(next.baselineMode, 'present')
})

test('실행 흔적이나 근거가 부족하면 결과 없는 반환을 거절하고 격리를 유지한다', async (t) => {
  const checkpointed = await fixture(t), withCheckpoint = await checkpointed.acquire('checkpointed')
  await writeFile(path.join(checkpointed.worker, 'feature.txt'), 'remote change\n'); await checkpointed.checkpoint(withCheckpoint)
  await checkpointed.remote.quarantine(withCheckpoint.leaseId, '확인 필요'); await checkpointed.observe()
  await assert.rejects(() => checkpointed.remote.releaseUnstarted(withCheckpoint.leaseId, { evidence: { kind: 'operator' } }), { code: 'REMOTE_WORKSPACE_UNSTARTED_EVIDENCE_REQUIRED' })
  assert.equal(checkpointed.remote.state.leases[withCheckpoint.leaseId].status, 'quarantined')

  const dirty = await fixture(t), dirtyLease = await dirty.acquire('dirty')
  await dirty.remote.quarantine(dirtyLease.leaseId, '정책 준비 실패')
  await writeFile(path.join(dirty.worker, 'unexpected.txt'), '실행 흔적\n'); await dirty.observe()
  await assert.rejects(() => dirty.remote.releaseUnstarted(dirtyLease.leaseId, { evidence: { kind: 'operator' } }), { code: 'REMOTE_WORKSPACE_UNSTARTED_EVIDENCE_REQUIRED' })
  assert.equal(await git(dirty.worker, ['branch', '--show-current']), dirtyLease.branch)
  assert.equal(dirty.remote.state.leases[dirtyLease.leaseId].status, 'quarantined')

  const running = await fixture(t), runningLease = await running.acquire('running')
  await running.remote.quarantine(runningLease.leaseId, '정책 준비 실패')
  running.active(true); await running.observe()
  await assert.rejects(() => running.remote.releaseUnstarted(runningLease.leaseId, { evidence: { kind: 'operator' } }), { code: 'REMOTE_WORKSPACE_UNSTARTED_EVIDENCE_REQUIRED' })

  // 운영자 반환은 최신 Runner 보고가 lease를 반영해야 한다.
  const stale = await fixture(t), staleLease = await stale.acquire('stale-report')
  await stale.remote.quarantine(staleLease.leaseId, '정책 준비 실패')
  await assert.rejects(() => stale.remote.releaseUnstarted(staleLease.leaseId, { evidence: { kind: 'operator' } }), { code: 'REMOTE_WORKSPACE_UNSTARTED_EVIDENCE_REQUIRED' })
  assert.equal(stale.remote.state.leases[staleLease.leaseId].status, 'quarantined')
  assert.equal(stale.remote.state.leases[staleLease.leaseId].unstartedRelease, undefined)

  const diverged = await fixture(t), divergedLease = await diverged.acquire('diverged')
  const failure = '정책 준비 실패'
  await diverged.remote.quarantine(divergedLease.leaseId, failure); await diverged.observe()
  const tree = await git(diverged.integration, ['rev-parse', 'HEAD^{tree}'])
  await git(diverged.integration, ['reset', '--hard', await git(diverged.integration, ['commit-tree', tree, '-m', '[김용민] 이력 재작성'])])
  await assert.rejects(() => diverged.remote.releaseUnstarted(divergedLease.leaseId, { evidence: { kind: 'operator' } }), { code: 'REMOTE_WORKSPACE_BASE_DIVERGED' })
  const restored = diverged.remote.state.leases[divergedLease.leaseId]
  assert.equal(restored.status, 'quarantined'); assert.equal(restored.result.reason, failure)
  assert.equal(restored.unstartedRelease.attempt, null); assert.equal(restored.unstartedRelease.attempts[0].code, 'REMOTE_WORKSPACE_BASE_DIVERGED')
  assert.equal(Object.values(restored.operations).some((item) => item.action === 'release'), false)
  assert.equal(await git(diverged.worker, ['branch', '--show-current']), divergedLease.branch)
})

test('결과 없는 반환의 응답 유실은 같은 시도 영수증으로만 확인하고 그동안 새 배정을 막는다', async (t) => {
  const f = await fixture(t), lease = await f.acquire('lost-unstarted-release')
  await f.remote.quarantine(lease.leaseId, '정책 준비 실패'); await f.observe()
  f.lose('release')
  await assert.rejects(() => f.remote.releaseUnstarted(lease.leaseId, { evidence: { kind: 'operator' } }), /lost response/)
  const stored = f.remote.state.leases[lease.leaseId]
  assert.equal(stored.status, 'release-pending')
  const attempt = stored.unstartedRelease.attempt
  assert.ok(attempt)
  await assert.rejects(() => f.acquire('other'), /사용 가능한 원격 worker/)
  await f.restartAgent()
  const result = await f.remote.releaseUnstarted(lease.leaseId, { evidence: { kind: 'operator' } })
  assert.equal(result.releaseKind, 'unstarted'); assert.equal(stored.unstartedRelease.attempt, attempt)
  assert.equal(Object.values(stored.operations).filter((item) => item.action === 'release').length, 1)
})

test('dispatch 전 실패 정리는 보고 갱신 전에도 반환하고 실행 흔적이 있으면 기존처럼 격리한다', async (t) => {
  const f = await fixture(t)
  const lease = await f.facade.acquire({ machineId: 'macbook', workspacePoolId: 'mac-pool', requestId: 'before-dispatch',
    mapId: 'map', cardId: 'card', conversationId: 'conversation-1' })
  await f.facade.bindConversation(lease.leaseId, 'conversation-1')
  const mainHead = await commitMain(f, 'main-before-dispatch.txt', '정책 실패 사이 메인 진행\n')
  const result = await f.facade.cancelBeforeDispatch(lease.leaseId, '실행 정책 준비 실패')
  assert.equal(result.status, 'cancelled'); assert.equal(result.releaseKind, 'unstarted'); assert.equal(result.idleCommit, mainHead)
  assert.equal(f.remote.state.leases[lease.leaseId].unstartedRelease.evidence.kind, 'before-dispatch')
  assert.equal(f.remote.state.leases[lease.leaseId].unstartedRelease.previousStatus, 'leased')
  assert.equal(await f.facade.cancelBeforeDispatch('missing-local-lease', '로컬 경로'), null)
  await f.observe()
  const second = await f.acquire('with-checkpoint-before-dispatch')
  await writeFile(path.join(f.worker, 'feature.txt'), 'remote change\n'); await f.checkpoint(second)
  const held = await f.facade.cancelBeforeDispatch(second.leaseId, '실행 정책 준비 실패')
  assert.equal(held.status, 'quarantined')
  assert.equal(f.remote.state.leases[second.leaseId].status, 'quarantined')
  assert.equal(f.agent().state.leases[second.leaseId].status, 'quarantined')
})
