import assert from 'node:assert/strict'
import test from 'node:test'
import { getEventListeners, setMaxListeners } from 'node:events'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStorageResources } from '../server/lib/storageResources.mjs'
import { createStorageChanges } from '../server/lib/storageChanges.mjs'
import { createStorageJournal, newStorageRequestId } from '../server/lib/storageJournal.mjs'
import { createStorageBudget, createResourceQueue, storageLimits, storageDiagnostic, withStorageBudget } from '../server/lib/storageBudget.mjs'
import { retryDelay, retryStorageRequest } from '../mcp/requestRetry.mjs'
import { RemoteWorkspacePool } from '../server/lib/remoteWorkspacePool.mjs'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function temp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-budget-05-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }))
  return root
}

test('05 계약 기본값과 키당 128·프로세스 전체 1024의 대기 상한 및 취소 정리', async () => {
  assert.deepEqual(storageLimits, { totalMs: 30000, multiTotalMs: 60000, waitMs: 5000, multiWaitMs: 10000, perKey: 128, total: 1024 })
  const queue = createResourceQueue(), releases = [], pending = []
  const budget = createStorageBudget()
  setMaxListeners(0, budget.signal)
  for (let i = 0; i < 9; i++) releases.push(await queue.acquire(`doc:${i}`))
  for (let i = 0; i < 8; i++) for (let n = 0; n < 128; n++) {
    pending.push(queue.acquire(`doc:${i}`, 'write', budget).catch((error) => error.code))
  }
  assert.equal(queue.waiting(), 1024)
  assert.throws(() => queue.acquire('doc:0'), { code: 'WRITE_QUEUE_FULL', outcome: 'not-applied', retryAfterMs: 250 })
  assert.throws(() => queue.acquire('doc:8'), { code: 'WRITE_QUEUE_FULL' })
  const anotherQueue = createResourceQueue(), other = await anotherQueue.acquire('doc:other')
  assert.throws(() => anotherQueue.acquire('doc:other'), { code: 'WRITE_QUEUE_FULL' })
  budget.cancel()
  assert.ok((await Promise.all(pending)).every((code) => code === 'REQUEST_CANCELLED'))
  assert.equal(queue.waiting(), 0)
  assert.equal(getEventListeners(budget.signal, 'abort').length, 0)
  for (const release of releases) release()
  other()
  assert.deepEqual(queue.pending(), [])
})

test('누적 키 대기·재수집은 같은 예산을 사용하고 앞서 잡은 키를 역순 해제한다', async () => {
  const resources = createStorageResources(), heldA = deferred(), heldB = deferred(), enteredA = deferred(), enteredB = deferred()
  const a = resources.withResources(['doc:a'], async () => { enteredA.resolve(); await heldA.promise })
  const b = resources.withResources(['doc:b'], async () => { enteredB.resolve(); await heldB.promise })
  await Promise.all([enteredA.promise, enteredB.promise])
  const budget = createStorageBudget({ waitMs: 90 })
  const pending = withStorageBudget(budget, () => resources.withResources(['doc:b', 'doc:a'], () => assert.fail('기한 후 실행 금지')))
  const failed = assert.rejects(pending, { code: 'LOCK_WAIT_TIMEOUT', retryAfterMs: 250 })
  await pause(45); heldA.resolve(); await a
  await failed
  assert.ok(budget.queueWaitMs >= 80 && budget.queueWaitMs < 250, String(budget.queueWaitMs))
  assert.equal(resources.pending().some((item) => item.key === 'doc:a'), false)
  await assert.rejects(withStorageBudget(budget, () => resources.withResources(['doc:b'], () => {})), { code: 'LOCK_WAIT_TIMEOUT' })
  heldB.resolve(); await b
  assert.deepEqual(resources.pending(), [])
})

test('타이머 실행이 늦어져도 기한이 지난 대기자를 잠금 해제 시 실행하지 않는다', async () => {
  const queue = createResourceQueue(), release = await queue.acquire('doc:late')
  const budget = createStorageBudget({ waitMs: 10 })
  const failed = assert.rejects(queue.acquire('doc:late', 'write', budget), { code: 'LOCK_WAIT_TIMEOUT' })
  const until = Date.now() + 20
  while (Date.now() < until) { /* 이벤트 루프 정체를 재현해 timeout callback 전에 잠금을 해제한다. */ }
  release(); await failed
  assert.deepEqual(queue.pending(), [])
  assert.equal(getEventListeners(budget.signal, 'abort').length, 0)
})

test('변경 준비 전 취소는 원문 보존, 영속 준비·marker 뒤 취소는 확정 결과 보존', async (t) => {
  const root = await temp(t), file = path.join(root, 'map.json'), resources = createStorageResources()
  const keyForFile = () => 'doc:map'
  await writeFile(file, '이전')
  let barrier = null
  const journal = createStorageJournal({ root, resources, keyForFile, phase: async (name) => {
    if (barrier?.name === name) { barrier.reached.resolve(); await barrier.release.promise }
  } })
  const changes = createStorageChanges({ root, resources, keyForFile, journal })
  const firstBudget = createStorageBudget()
  await assert.rejects(withStorageBudget(firstBudget, () => resources.withResources(['doc:map'], () => changes.run(async () => {
    await changes.stage(file, '취소할 후보'); firstBudget.cancel()
  }))), { code: 'REQUEST_CANCELLED' })
  assert.equal(await readFile(file, 'utf8'), '이전')
  for (const name of ['before-intent', 'after-commit']) {
    barrier = { name, reached: deferred(), release: deferred() }
    const request = { requestId: newStorageRequestId(), digest: name, scope: { editorId: 'fixture' } }
    const budget = createStorageBudget({ totalMs: 40 })
    const work = withStorageBudget(budget, () => resources.withResources(['doc:map'], () => changes.run(async () => {
      await changes.stage(file, name); changes.deferResponse(200, () => {}, { ok: true })
    }, { request })))
    await barrier.reached.promise; budget.cancel(); await pause(45); barrier.release.resolve(); await work
    assert.equal(await readFile(file, 'utf8'), name)
    assert.equal(journal.lookup(request, true).body.outcome, 'committed')
  }
  assert.deepEqual(resources.pending(), [])
})

test('재시도 최초 포함 3회, 100/200ms ±25%, retryAfter 하한과 전체 기한·충돌 비재시도', async () => {
  assert.equal(retryDelay(1, 0, () => 0), 75); assert.equal(retryDelay(1, 0, () => 1), 125)
  assert.equal(retryDelay(2, 0, () => 0), 150); assert.equal(retryDelay(2, 0, () => 1), 250)
  const transient = () => Object.assign(new Error('대기'), { code: 'WRITE_QUEUE_FULL', outcome: 'not-applied', retryable: true, retryAfterMs: 250 })
  let time = 0, calls = 0
  const delays = []
  await assert.rejects(retryStorageRequest(() => { calls++; throw transient() }, {
    deadlineAt: 1000, now: () => time, random: () => 0, sleep: async (ms) => { delays.push(ms); time += ms },
  }), { code: 'WRITE_QUEUE_FULL' })
  assert.equal(calls, 3); assert.deepEqual(delays, [250, 250])
  calls = 0; time = 0
  await assert.rejects(retryStorageRequest(() => { calls++; throw transient() }, {
    deadlineAt: 240, now: () => time, sleep: () => assert.fail('기한을 넘는 대기 금지'),
  }))
  assert.equal(calls, 1)
  for (const code of ['FIELD_CONFLICT', 'READ_DEPENDENCY_CHANGED', 'REQUEST_FORBIDDEN', 'REQUEST_UNAUTHORIZED', 'CONTENT_PRECONDITION_REQUIRED']) {
    calls = 0
    await assert.rejects(retryStorageRequest(() => { calls++; throw { code, outcome: 'not-applied', retryable: false } }, { deadlineAt: Date.now() + 1000 }), { code })
    assert.equal(calls, 1)
  }
})

async function remoteFixture(t) {
  const root = await temp(t)
  const remote = new RemoteWorkspacePool({ stateFile: path.join(root, 'remote.json'), local: { registry: { integration: {} }, state: {} }, mainMachineId: () => 'main' })
  await remote.initialize()
  for (const machineId of ['slow', 'fast']) {
    remote.state.pools[`${machineId}:pool`] = { enabled: true, poolId: 'pool', protocolVersion: 2, registryDigest: 'a'.repeat(64) }
    remote.state.reports[machineId] = { receivedAt: Date.now(), poolId: 'pool', version: 2, registryDigest: 'a'.repeat(64) }
    remote.state.leases[machineId] = { leaseId: machineId, poolId: 'pool', status: 'leased', conversationId: '',
      ownership: { machineId, coordinatorId: remote.state.coordinatorId, generation: 1 }, checkpoints: [] }
  }
  return remote
}

test('느린 Runner는 원격 공용 큐를 놓고 다른 머신 처리·같은 예약 거부·승인 재검증을 유지한다', async (t) => {
  const remote = await remoteFixture(t), entered = deferred(), release = deferred()
  remote.callRunner = async (machineId) => { if (machineId === 'slow') { entered.resolve(); await release.promise } return { ok: true } }
  const slow = remote.bindConversation('slow', 'conversation-slow')
  const rejected = assert.rejects(slow, { code: 'REMOTE_WORKSPACE_POOL_NOT_APPROVED' })
  await entered.promise
  const started = Date.now()
  assert.equal((await remote.bindConversation('fast', 'conversation-fast')).conversationId, 'conversation-fast')
  assert.ok(Date.now() - started < 5000)
  await assert.rejects(remote.bindConversation('slow', 'hijack'), { code: 'REMOTE_WORKSPACE_OPERATION_PENDING' })
  await remote.approve('slow', { poolId: 'pool', enabled: false })
  release.resolve(); await rejected
  assert.equal(remote.state.leases.slow.conversationId, '')
  assert.ok(remote.state.leases.slow.pendingOperation)
  assert.equal(remote.reservations.size, 0)
})

test('정리 파일 대기 동안 다른 원격 자원을 처리하고 같은 완료 리스를 다시 점유하지 않는다', async (t) => {
  const remote = await remoteFixture(t), entered = deferred(), release = deferred()
  remote.state.leases.slow.status = 'completed'; remote.state.leases.slow.cleanupPending = true
  remote.artifacts.cleanup = async () => { entered.resolve(); await release.promise }
  remote.callRunner = async () => ({ ok: true })
  const cleaning = remote.cleanupCompletedLease(remote.state.leases.slow)
  await entered.promise
  assert.equal((await remote.bindConversation('fast', 'conversation-fast')).conversationId, 'conversation-fast')
  await assert.rejects(remote.bindConversation('slow', 'hijack'), { code: 'REMOTE_WORKSPACE_OPERATION_PENDING' })
  release.resolve(); await cleaning
  assert.equal(remote.state.leases.slow.cleanupPending, false)
})

test('외부 수행 뒤 재획득 실패는 메모리 예약을 해제하고 영속 동일 작업으로 재확인한다', async (t) => {
  const remote = await remoteFixture(t), acquire = remote.queue.acquire
  const operationIds = []
  remote.callRunner = async (_machineId, _path, { body }) => {
    operationIds.push(body.operationId)
    if (operationIds.length === 1) remote.queue.acquire = () => { throw Object.assign(new Error('대기 포화'), { code: 'WRITE_QUEUE_FULL' }) }
    return { ok: true }
  }
  await assert.rejects(remote.bindConversation('slow', 'conversation-slow'), { code: 'WRITE_QUEUE_FULL' })
  assert.equal(remote.reservations.size, 0)
  assert.ok(remote.state.leases.slow.pendingOperation)
  assert.equal(remote.state.leases.slow.conversationId, '')
  remote.queue.acquire = acquire
  assert.equal((await remote.bindConversation('slow', 'conversation-slow')).conversationId, 'conversation-slow')
  assert.equal(operationIds.length, 2)
  assert.equal(operationIds[0], operationIds[1])
  assert.equal(remote.state.leases.slow.pendingOperation, undefined)
})

test('최소 진단은 자원·대기 단계·시간·재시도·결과만 포함한다', () => {
  const events = [], listener = (value) => events.push(value)
  storageDiagnostic.subscribe(listener)
  try {
    const budget = createStorageBudget({ requestId: 'fixture-request' })
    budget.resources.add('doc:fixture'); budget.phase = 'external'; budget.externalWaitMs = 25; budget.finish('not-applied')
    assert.deepEqual(Object.keys(events[0]).sort(), ['requestId', 'resources', 'phase', 'queueWaitMs', 'lockHoldMs', 'persistMs', 'externalWaitMs', 'retries', 'outcome'].sort())
    assert.equal(events[0].externalWaitMs, 25)
    assert.equal(events[0].phase, 'external')
  } finally { storageDiagnostic.unsubscribe(listener) }
})
