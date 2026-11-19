import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-allocation-retry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const shared = path.join(root, 'shared'), main = path.join(root, 'main')
  const workers = ['worker-a', 'worker-b'].map(id => ({ id, root: path.join(root, id), role: 'worker', enabled: true }))
  await Promise.all([shared, main, ...workers.map(w => w.root)].map(dir => mkdir(dir)))
  const registryFile = path.join(shared, 'workspaces.json'), stateFile = path.join(shared, 'state.json')
  await writeFile(registryFile, JSON.stringify({ poolId: 'test', sharedRoot: shared,
    workspaces: [{ id: 'main', root: main, role: 'integration', enabled: true }, ...workers] }))
  const branches = new Map(), heads = new Map(), changes = new Map(), operations = new Set()
  const createManager = () => {
    const manager = new WorkspacePoolManager({ registryFile, stateFile, gitRunner: async (cwd, args) => {
      if (args[0] === 'rev-parse') return heads.get(cwd) ?? 'a'.repeat(40)
      if (args[0] === 'branch' && args[1] === '--show-current') return branches.get(cwd) ?? 'main'
      if (args[0] === 'status') return changes.get(cwd) ?? ''
      if (args[0] === 'switch') branches.set(cwd, args[1] === '-C' ? args[2] : args[1])
      return ''
    } })
    manager.claimLocalWorkspace = async () => async () => {}
    manager.isRemotelyOwned = async () => false
    manager.gitPathExists = async (cwd, name) => operations.has(`${cwd}/${name}`)
    return manager
  }
  const manager = createManager()
  await manager.initialize()
  const request = { requestId: 'delegation-a', workspaceHint: main, mapId: 'map-a', cardId: 'card-a', conversationId: 'chat-a' }
  return { manager, request, createManager, workers, branches, heads, changes, operations }
}

for (const conversationId of ['chat-a', '']) test(`같은 요청은 동시 재시도와 재시작 후에도 한 번만 배정한다: ${conversationId || '새 대화'}`, async t => {
  const f = await fixture(t), request = { ...f.request, conversationId }
  const [first, retry] = await Promise.all([f.manager.acquire(request), f.manager.acquire(request)])
  assert.equal(first.leaseId, retry.leaseId)
  if (!conversationId) await f.manager.bindConversation(first.leaseId, 'created-chat')
  const restarted = f.createManager()
  await restarted.initialize()
  assert.equal((await restarted.acquire(request)).leaseId, first.leaseId)
  assert.equal(Object.keys(restarted.state.leases).length, 1)
  assert.equal(restarted.state.leases[first.leaseId].requestId, request.requestId)
  assert.equal(restarted.state.workspaces['worker-b'].status, 'idle')
})

for (const patch of [{ mapId: 'other' }, { cardId: 'other' }, { conversationId: 'other' }, { replacesLeaseId: 'other' }]) {
  test(`같은 배정 요청 ID의 범위 변경은 거부한다: ${Object.keys(patch)[0]}`, async t => {
    const f = await fixture(t)
    await f.manager.acquire(f.request)
    await assert.rejects(f.manager.acquire({ ...f.request, ...patch }), { reasonCode: 'WORKSPACE_REQUEST_SCOPE_MISMATCH' })
    assert.equal(Object.keys(f.manager.state.leases).length, 1)
  })
}

test('다른 요청도 이미 점유한 대화에는 새 worker를 배정하지 않는다', async t => {
  const f = await fixture(t), first = await f.manager.acquire(f.request)
  await assert.rejects(f.manager.acquire({ ...f.request, requestId: 'other' }), { reasonCode: 'CONVERSATION_ALREADY_LEASED' })
  await f.manager.quarantine(first.leaseId, '실행 여부 확인 필요')
  await assert.rejects(f.manager.acquire({ ...f.request, requestId: 'other' }), { reasonCode: 'CONVERSATION_ALREADY_LEASED' })
  await assert.rejects(f.manager.acquire(f.request), { reasonCode: 'WORKSPACE_REQUEST_RECOVERY_REQUIRED' })
})

test('동일 요청이어도 세션·브랜치가 다르면 반환하지 않는다', async t => {
  const f = await fixture(t), lease = await f.manager.acquire(f.request)
  const file = path.join(lease.projectRoot, '.ai-session.json'), session = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...session, jobId: 'other' }))
  await assert.rejects(f.manager.acquire(f.request), { reasonCode: 'WORKSPACE_REQUEST_RECOVERY_REQUIRED' })
  await writeFile(file, JSON.stringify(session))
  f.branches.set(lease.projectRoot, 'other')
  await assert.rejects(f.manager.acquire(f.request), { reasonCode: 'WORKSPACE_REQUEST_RECOVERY_REQUIRED' })
})

async function duplicateFixture(t) {
  const f = await fixture(t), createdAt = new Date(Date.now() - 1000).toISOString()
  // 과거 버전이 만든 중복 배정을 재현한다. 운영 데이터는 수정하지 않는다.
  const orphan = await f.manager.acquire({ ...f.request, requestId: undefined })
  const authoritative = await f.manager.acquire({ ...f.request, requestId: undefined, conversationId: 'temporary-chat' })
  f.manager.state.leases[authoritative.leaseId].conversationId = f.request.conversationId
  const file = path.join(authoritative.projectRoot, '.ai-session.json')
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), conversationId: f.request.conversationId }))
  await f.manager.quarantine(authoritative.leaseId, '대화 중복 점유')
  const options = { ...f.request, failureCategory: 'confirmed-dispatch', confirmedDispatchLease: authoritative,
    duplicateAllocationRecovery: { requestId: f.request.requestId, createdAt, leaseIds: [orphan.leaseId] } }
  return { ...f, orphan, authoritative, options }
}

test('원 실행과 무변경이 검증된 고아 배정만 반환하고 권위 lease에서 복구한다', async t => {
  const f = await duplicateFixture(t)
  const result = await f.manager.reactivateQuarantinedLease(f.authoritative.leaseId, f.options)
  assert.equal(result.leaseId, f.authoritative.leaseId)
  assert.equal(f.manager.state.leases[f.orphan.leaseId].status, 'cancelled')
  assert.equal(f.manager.state.leases[f.orphan.leaseId].result.duplicateOfLeaseId, result.leaseId)
  assert.equal(f.manager.state.workspaces[f.orphan.workspaceId].status, 'idle')
  assert.equal(f.manager.state.workspaces[f.authoritative.workspaceId].status, 'leased')
  assert.equal((await f.manager.reactivateQuarantinedLease(result.leaseId, f.options)).leaseId, result.leaseId)
})

for (const [label, mutate] of [
  ['미커밋 변경', f => f.changes.set(f.orphan.projectRoot, ' M work.txt')],
  ['미기록 커밋', f => f.heads.set(f.orphan.projectRoot, 'b'.repeat(40))],
  ['체크포인트', f => { f.manager.state.leases[f.orphan.leaseId].checkpoints = [{ commit: 'a' }] }],
  ['다른 카드', f => { f.manager.state.leases[f.orphan.leaseId].cardId = 'other' }],
  ['다른 요청', f => { f.manager.state.leases[f.orphan.leaseId].requestId = 'other' }],
  ['이전 작업', f => { f.options.duplicateAllocationRecovery.createdAt = new Date(Date.now() + 1000).toISOString() }],
  ['Git 잠금', f => f.operations.add(`${f.orphan.projectRoot}/index.lock`)],
  ['다른 기록의 참조', f => { f.options.duplicateAllocationRecovery.leaseIds = [] }],
]) test(`고아 배정 반환 거부: ${label}`, async t => {
  const f = await duplicateFixture(t)
  mutate(f)
  await assert.rejects(f.manager.reactivateQuarantinedLease(f.authoritative.leaseId, f.options))
  assert.equal(f.manager.state.leases[f.orphan.leaseId].status, 'leased')
  assert.equal(f.manager.state.leases[f.authoritative.leaseId].status, 'quarantined')
})
