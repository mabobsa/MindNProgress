import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteWorkspacePool, remoteWorkspaceFacade } from '../server/lib/remoteWorkspacePool.mjs'

function fixture() {
  let localCalls = 0, remoteCalls = 0
  const local = { state: {}, registry: { integration: {} },
    poolForWorkspace: root => root === 'C:/Main/Fork' ? { poolId: 'main' } : null,
    acquire: () => { localCalls++; return 'local-lease' } }
  const remote = new RemoteWorkspacePool({ local, stateFile: '/unused/state.json', mainMachineId: () => 'main', now: () => 500000 })
  remote.state = { pools: {}, reports: {}, leases: {} }
  remote.acquire = options => { remoteCalls++; return remote.pool(options.machineId) }
  return { remote, facade: remoteWorkspaceFacade(local, remote), counts: () => ({ localCalls, remoteCalls }) }
}

test('일반 Mac 경로는 풀 없이 null을 반환하고 Windows worker를 선택하지 않는다', () => {
  const f = fixture()
  assert.equal(f.facade.acquire({ machineId: 'mac', workspaceHint: '/Users/developer/project', requestId: 'request-new' }), null)
  assert.equal(f.facade.acquire({ machineId: 'mac', workspaceHint: '/Users/developer/project', requestId: 'request-resume' }), null)
  assert.deepEqual(f.counts(), { localCalls: 0, remoteCalls: 0 })
})

test('HEAD 변경 복구와 공통 내부 복구는 원격 lease를 로컬 manager로 우회시키지 않는다', () => {
  const f = fixture()
  f.remote.state.leases['remote-lease'] = { ownership: { machineId: 'mac' } }
  for (const method of ['resumeIntegrationConflict', 'recoverIntegrationHeadChangedFailure', 'recoverIntegrationCandidateWorktreeFailure', 'recoverIntegrationGitStatusFailure', 'recoverCheckpointIntegrationFailure', 'releasePreservedIntegrationFailure']) {
    let calls = 0
    f.facade[method] = () => { calls++; return 'local-head-recovery' }
    assert.throws(() => f.facade[method]('remote-lease', {}), { reasonCode: 'REMOTE_WORKSPACE_EXPLICIT_RECOVERY_REQUIRED' })
    assert.equal(calls, 0)
    assert.equal(f.facade[method]('local-lease', {}), 'local-head-recovery')
  }
})

test('관리 대상 원격 경로는 미승인·만료 보고에서도 일반 실행으로 우회하지 않는다', () => {
  const f = fixture()
  const report = { machineId: 'mac', poolId: 'mac-pool', version: 2, receivedAt: 500000,
    workspaces: [{ projectRoot: '/Users/developer/Fork' }] }
  f.remote.state.reports.mac = report
  assert.throws(() => f.facade.acquire({ machineId: 'mac', workspaceHint: '/Users/developer/Fork/' }), { reasonCode: 'REMOTE_WORKSPACE_POOL_NOT_APPROVED', status: 409 })
  report.receivedAt = 0
  assert.throws(() => f.facade.acquire({ machineId: 'mac', workspaceHint: '/Users/developer/Fork' }), { reasonCode: 'REMOTE_WORKSPACE_RUNNER_STALE', status: 409 })
  delete f.remote.state.reports.mac
  f.remote.state.pools['mac:mac-pool'] = report
  assert.throws(() => f.facade.acquire({ machineId: 'mac', workspaceHint: '/Users/developer/Fork' }), { reasonCode: 'REMOTE_WORKSPACE_RUNNER_STALE' })
  assert.equal(f.counts().localCalls, 0)
})

test('보고·승인이 없어져도 기존 lease 경로와 요청은 원격 관리 경로를 유지한다', () => {
  const f = fixture()
  f.remote.state.leases.lease = { projectRoot: '/Users/developer/Fork', requestId: 'existing', poolId: 'mac-pool', ownership: { machineId: 'mac' } }
  assert.ok(f.facade.poolForWorkspace('/Users/developer/Fork/', 'mac'))
  for (const workspaceHint of ['/Users/developer/Fork', '/ordinary']) {
    assert.throws(() => f.facade.acquire({ machineId: 'mac', workspaceHint, requestId: 'existing' }), { reasonCode: 'REMOTE_WORKSPACE_RUNNER_STALE' })
  }
  assert.equal(f.counts().localCalls, 0)
})

test('다른 머신의 관리 대상 또는 Windows worker를 Mac 요청에 배정하지 않는다', () => {
  const f = fixture()
  f.remote.state.pools.pool = { machineId: 'other-mac', workspaces: [{ projectRoot: '/managed' }] }
  for (const workspaceHint of ['/managed', 'C:/Main/Fork']) {
    assert.throws(() => f.facade.acquire({ machineId: 'mac', workspaceHint }), { reasonCode: 'REMOTE_WORKSPACE_SCOPE_MISMATCH' })
  }
  assert.deepEqual(f.counts(), { localCalls: 0, remoteCalls: 0 })
  assert.equal(f.facade.acquire({ machineId: 'main', workspaceHint: 'C:/Main/Fork' }), 'local-lease')
})

test('명시한 풀은 경로 없이 머신에 귀속되고 일반 대화로 우회하지 않는다', () => {
  const f = fixture()
  const report = { machineId: 'mac', poolId: 'mac-pool', version: 2, receivedAt: 500000, registryDigest: 'digest',
    workspaces: [{ projectRoot: '/managed/mac-fork' }] }
  f.remote.state.reports.mac = report
  const options = { machineId: 'mac', workspacePoolId: 'mac-pool', requestId: 'explicit-pool' }
  assert.throws(() => f.facade.acquire(options), { reasonCode: 'REMOTE_WORKSPACE_POOL_NOT_APPROVED' })
  f.remote.state.pools['mac:mac-pool'] = { ...report, enabled: true, protocolVersion: 2 }
  assert.equal(f.facade.resolvePoolHint({ machineId: 'mac', poolId: 'mac-pool' }), '/managed/mac-fork')
  assert.equal(f.facade.acquire(options).pool.poolId, 'mac-pool')
  assert.throws(() => f.facade.acquire({ ...options, workspacePoolId: 'other-pool' }), { reasonCode: 'AI_WORKSPACE_POOL_SCOPE_MISMATCH' })
  assert.throws(() => f.facade.acquire({ ...options, machineId: 'main' }), { reasonCode: 'AI_WORKSPACE_POOL_SCOPE_MISMATCH' })
  report.receivedAt = 0
  assert.throws(() => f.facade.acquire(options), { reasonCode: 'REMOTE_WORKSPACE_RUNNER_STALE' })
  assert.equal(f.counts().localCalls, 0)
})

test('명시한 로컬 풀은 integration 기준으로 배정하며 기존 원격 요청 ID 귀속을 보존한다', () => {
  const f = fixture()
  f.facade.registry = { poolId: 'main-pool', integration: { root: 'C:/Main/Fork' } }
  assert.equal(f.facade.acquire({ machineId: 'main', workspacePoolId: 'main-pool' }), 'local-lease')
  f.remote.state.leases.old = { requestId: 'old-request', poolId: 'remote-pool', ownership: { machineId: 'mac' } }
  assert.throws(() => f.facade.acquire({ machineId: 'main', workspacePoolId: 'main-pool', requestId: 'old-request' }), { reasonCode: 'AI_WORKSPACE_POOL_SCOPE_MISMATCH' })
})

test('대기 후 lease 재사용도 요청한 풀과 머신을 재확인한다', () => {
  const f = fixture()
  const report = { machineId: 'mac', poolId: 'mac-pool', version: 2, receivedAt: 500000, registryDigest: 'digest',
    workspaces: [{ projectRoot: '/managed/mac-fork' }] }
  f.remote.state.reports.mac = report
  f.remote.state.pools['mac:mac-pool'] = { ...report, enabled: true, protocolVersion: 2 }
  f.remote.state.leases.existing = { poolId: 'mac-pool', ownership: { machineId: 'mac' } }
  let calls = 0
  f.remote.reuseLease = () => { calls++; return 'reused' }
  const options = { machineId: 'mac', workspacePoolId: 'mac-pool' }
  assert.equal(f.facade.reuseLease('existing', options), 'reused')
  f.remote.state.leases.existing.poolId = 'different-pool'
  assert.throws(() => f.facade.reuseLease('existing', options), { reasonCode: 'AI_WORKSPACE_POOL_SCOPE_MISMATCH' })
  f.remote.state.leases.existing.poolId = 'mac-pool'
  f.remote.state.leases.existing.ownership.machineId = 'different-mac'
  assert.throws(() => f.facade.reuseLease('existing', options), { reasonCode: 'AI_WORKSPACE_POOL_SCOPE_MISMATCH' })
  f.remote.state.leases.existing.ownership.machineId = 'mac'
  report.receivedAt = 0
  assert.throws(() => f.facade.reuseLease('existing', options), { reasonCode: 'REMOTE_WORKSPACE_RUNNER_STALE' })
  assert.equal(calls, 1)
})
