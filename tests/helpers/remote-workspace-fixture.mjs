import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkspacePoolManager } from '../../server/lib/workspacePool.mjs'
import { RemoteWorkspacePool, remoteWorkspaceFacade } from '../../server/lib/remoteWorkspacePool.mjs'
import { createWorkspaceAgent } from '../../runner/lib/workspaceAgent.mjs'
import { git, saveJson } from '../../server/lib/remoteWorkspaceProtocol.mjs'

const message = { summary: '원격 Fork 기능 검증', background: '원격 작업 결과를 안전하게 전달해야 합니다.', cause: '머신 간 작업공간이 분리되어 있습니다.', changes: '의도한 기능 파일만 체크포인트로 전달했습니다.' }
export async function remoteWorkspaceFixture(t, { remoteCommitPrefix, mapId = 'map', cardId = 'card', conversationId = 'conversation-1' } = {}) {
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
  const acquire = (requestId = 'delegation-1') => remote.acquire({ machineId: 'macbook', requestId, mapId, cardId, conversationId, cardLabel: '검증' })
  const checkpoint = (lease, paths = ['feature.txt'], requestId = 'checkpoint-1') => remote.checkpoint(lease.leaseId, { requestId, jobId: lease.jobId, mapId, cardId, conversationId, paths, commitMessage: message })
  return { root, integration, localRoot, worker, local, remote, acquire, checkpoint, observe, facade: remoteWorkspaceFacade(local, remote),
    agent: () => agent, restartAgent: async () => { agent = await buildAgent() }, lose: (action) => { lostAction = action }, active: (value) => { active = value } }
}
