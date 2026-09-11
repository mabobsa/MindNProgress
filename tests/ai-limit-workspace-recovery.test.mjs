import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim()

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-limit-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const integration = path.join(root, 'integration')
  const worker = path.join(root, 'worker')
  const shared = path.join(root, 'shared')
  await mkdir(integration); await mkdir(shared)
  await git(integration, 'init', '--initial-branch=main')
  await git(integration, 'config', 'user.name', 'Recovery Test')
  await git(integration, 'config', 'user.email', 'recovery@example.test')
  await writeFile(path.join(integration, '.gitignore'), '.ai-session.json\n.ai-workspace.json\n')
  await writeFile(path.join(integration, 'work.txt'), '원래 작업\n')
  await git(integration, 'add', '.')
  await git(integration, 'commit', '-m', '[김용민] 복구 검증 기준선', '-m', '[배경]\n격리된 테스트 저장소 구성\n[원인]\n복구 검증 기준선 필요\n[수정]\n초기 파일 생성')
  await git(root, 'clone', integration, worker)
  const registryFile = path.join(shared, 'workspaces.json')
  const stateFile = path.join(shared, 'state.json')
  await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'test', sharedRoot: shared, workspaces: [
    { id: 'integration', root: integration, role: 'integration', enabled: true },
    { id: 'worker', root: worker, role: 'worker', enabled: true },
  ] }))
  const createManager = () => new WorkspacePoolManager({ registryFile, stateFile })
  const manager = createManager()
  await manager.initialize()
  const scope = { workspaceHint: integration, mapId: 'map-a', cardId: 'card-a', conversationId: 'conversation-a', cardLabel: '중단 복구 검증' }
  const lease = await manager.acquire(scope)
  return { manager, createManager, scope, lease, worker }
}

for (const dirty of [false, true]) test(`한도 중단은 ${dirty ? '미커밋 변경' : '변경 없는 세션'}을 재시작 뒤에도 보존하고 같은 lease로 재개한다`, async (t) => {
  const { manager, createManager, scope, lease, worker } = await fixture(t)
  const draft = '중단 시점의 수정\n'
  if (dirty) {
    await writeFile(path.join(worker, 'work.txt'), draft)
    await writeFile(path.join(worker, 'new.txt'), draft)
  }
  await assert.rejects(() => manager.finalize(lease.leaseId, { childStatus: 'failed', childError: 'usage limit exceeded' }))
  assert.equal(manager.state.leases[lease.leaseId].status, 'quarantined')
  assert.equal(manager.recoverableIdleWorkspaceState('worker'), false)
  const restarted = createManager()
  await restarted.initialize()
  assert.equal(restarted.state.leases[lease.leaseId].status, 'quarantined')
  await assert.rejects(() => restarted.acquire({ ...scope, conversationId: 'another-conversation' }))
  assert.equal(JSON.parse(await readFile(path.join(worker, '.ai-session.json'), 'utf8')).leaseId, lease.leaseId)
  const resumed = await restarted.reactivateQuarantinedLease(lease.leaseId, { ...scope, failureCategory: 'usage-limit' })
  assert.equal(resumed.leaseId, lease.leaseId)
  const repeated = await restarted.reactivateQuarantinedLease(lease.leaseId, { ...scope, failureCategory: 'usage-limit' })
  assert.equal(repeated.leaseId, lease.leaseId, '재개 요청 저장 전 장애가 같은 lease 복구를 막았습니다.')
  assert.equal(await git(worker, 'branch', '--show-current'), lease.branch)
  if (dirty) {
    assert.equal(await readFile(path.join(worker, 'work.txt'), 'utf8'), draft)
    assert.equal(await readFile(path.join(worker, 'new.txt'), 'utf8'), draft)
  }
  await assert.rejects(() => restarted.finalize(lease.leaseId, { childStatus: 'failed', childError: 'too many requests' }))
  await restarted.reactivateQuarantinedLease(lease.leaseId, { ...scope, failureCategory: 'rate-limit' })
  assert.equal(restarted.state.leases[lease.leaseId].recoveryHistory.length, 2)
})

test('구버전에서 변경 없이 반납한 한도 중단은 풀에서 복구용 lease를 한 번만 배정한다', async (t) => {
  const { manager, createManager, scope, lease } = await fixture(t)
  await manager.finalize(lease.leaseId, { childStatus: 'failed', childError: 'legacy failure' })
  const previous = manager.state.leases[lease.leaseId]
  previous.result.childError = 'usage limit exceeded'
  await manager.persist()
  const replacement = await manager.acquire({ ...scope, replacesLeaseId: lease.leaseId })
  assert.notEqual(replacement.leaseId, lease.leaseId)
  const restarted = createManager()
  await restarted.initialize()
  const repeated = await restarted.acquire({ ...scope, replacesLeaseId: lease.leaseId })
  assert.equal(repeated.leaseId, replacement.leaseId)
  await assert.rejects(() => restarted.acquire({ ...scope, cardId: 'another-card', replacesLeaseId: lease.leaseId }))
  assert.equal(restarted.state.leases[lease.leaseId].result.status, 'failed-clean')
})
