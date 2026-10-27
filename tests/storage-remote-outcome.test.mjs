import assert from 'node:assert/strict'
import test from 'node:test'
import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStorageBudget, currentStorageBudget, storageAdmissionError, withStorageBudget } from '../server/lib/storageBudget.mjs'
import { RemoteWorkspacePool } from '../server/lib/remoteWorkspacePool.mjs'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-05-outcome-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }))
  const options = { stateFile: path.join(root, 'remote.json'), local: { registry: { integration: {} }, state: {} }, mainMachineId: () => 'main' }
  const remote = new RemoteWorkspacePool(options)
  await remote.initialize()
  remote.state.pools['slow:pool'] = { enabled: true, poolId: 'pool', protocolVersion: 2, registryDigest: 'a'.repeat(64) }
  remote.state.reports.slow = { receivedAt: Date.now(), poolId: 'pool', version: 2, registryDigest: 'a'.repeat(64) }
  remote.state.leases.slow = { leaseId: 'slow', poolId: 'pool', status: 'leased', conversationId: '',
    ownership: { machineId: 'slow', coordinatorId: remote.state.coordinatorId, generation: 1 }, checkpoints: [] }
  return { remote, options, stored: async () => JSON.parse(await readFile(options.stateFile, 'utf8')) }
}

for (const mode of ['deadline', 'cancel']) test(`외부 접수 후 ${mode}: 미확정·영속 같은 명령·늦은 완료 한 번·재시작 수렴`, { timeout: 5000 }, async (t) => {
  const { remote, options, stored } = await fixture(t), entered = deferred(), release = deferred(), applied = deferred()
  const operations = [], completed = new Set()
  let effects = 0
  const callRunner = (_machine, _path, { body }) => currentStorageBudget().wait(async () => {
    operations.push(structuredClone(body)); entered.resolve(); await release.promise
    if (!completed.has(body.operationId)) { completed.add(body.operationId); effects++ }
    applied.resolve(); return { ok: true }
  })
  remote.callRunner = callRunner
  const budget = createStorageBudget({ totalMs: 1000 })
  const work = withStorageBudget(budget, () => remote.bindConversation('slow', 'conversation-slow'))
  const rejected = assert.rejects(work, (error) => {
    assert.equal(error.code, 'REMOTE_WORKSPACE_RESPONSE_PENDING')
    assert.equal(error.status, 503); assert.equal(error.outcome, 'processing'); assert.equal(error.retryable, false)
    assert.equal(error.storageResourceError, true)
    assert.equal(error.cause.code, mode === 'cancel' ? 'REQUEST_CANCELLED' : 'REQUEST_DEADLINE_EXCEEDED')
    return true
  })
  await entered.promise
  if (mode === 'cancel') budget.cancel()
  await rejected
  const pending = remote.state.leases.slow.pendingOperation
  assert.equal(pending, operations[0].operationId)
  assert.equal((await stored()).leases.slow.pendingOperation, pending)
  assert.equal(remote.reservations.size, 0); assert.deepEqual(remote.queue.pending(), [])
  assert.equal(getEventListeners(budget.signal, 'abort').length, 0)
  assert.equal(budget.signal.reason?.externalOperationStarted, undefined, '공유 취소 사유를 오염시키지 않는다')
  await assert.rejects(remote.bindConversation('slow', 'different-command'), { code: 'REMOTE_WORKSPACE_OPERATION_PENDING' })
  assert.equal(operations.length, 1)
  release.resolve(); await applied.promise
  assert.equal(effects, 1)
  const restarted = new RemoteWorkspacePool({ ...options, callRunner })
  await restarted.initialize()
  const retry = await withStorageBudget(createStorageBudget(), () => restarted.bindConversation('slow', 'conversation-slow'))
  assert.equal(retry.conversationId, 'conversation-slow')
  assert.deepEqual(operations[1], operations[0]); assert.equal(effects, 1)
  assert.equal((await stored()).leases.slow.pendingOperation, undefined)
  t.diagnostic(JSON.stringify({ mode, outcome: 'processing', sameOperation: true, effects, reservations: remote.reservations.size }))
})

test('외부 호출 직전 기한·취소 거부는 변경 없음이고 새 pending 예약을 정리한다', async (t) => {
  for (const mode of ['deadline', 'cancel']) {
    const { remote, stored } = await fixture(t)
    let clock = 0, calls = 0
    const budget = createStorageBudget({ now: () => clock, totalMs: 100 })
    remote.callRunner = () => {
      if (mode === 'cancel') budget.cancel()
      else clock = 100
      return budget.wait(() => { calls++; return {} })
    }
    await assert.rejects(withStorageBudget(budget, () => remote.bindConversation('slow', 'conversation-slow')), {
      code: mode === 'cancel' ? 'REQUEST_CANCELLED' : 'REQUEST_DEADLINE_EXCEEDED', outcome: 'not-applied',
    })
    assert.equal(calls, 0); assert.equal((await stored()).leases.slow.pendingOperation, undefined)
    assert.equal(remote.reservations.size, 0); assert.deepEqual(remote.queue.pending(), [])
  }
})

test('wait 등록 직후 같은 tick 취소는 외부 콜백을 시작하지 않고 리스너를 정리한다', async () => {
  const budget = createStorageBudget()
  let calls = 0
  const work = budget.wait(() => { calls++; return {} })
  budget.cancel()
  await assert.rejects(work, { code: 'REQUEST_CANCELLED', outcome: 'not-applied', externalOperationStarted: false })
  assert.equal(calls, 0); assert.equal(getEventListeners(budget.signal, 'abort').length, 0)
})

test('확인된 큐 거부·인증 오류를 외부 미확정으로 바꾸지 않는다', async (t) => {
  const { remote } = await fixture(t)
  for (const failure of [storageAdmissionError('WRITE_QUEUE_FULL'), Object.assign(new Error('인증 실패'), { status: 401, code: 'REQUEST_UNAUTHORIZED' })]) {
    remote.callRunner = () => currentStorageBudget().wait(() => { throw failure })
    await assert.rejects(withStorageBudget(createStorageBudget(), () => remote.bindConversation('slow', 'conversation-slow')), (error) => error === failure)
    assert.equal(remote.reservations.size, 0)
  }
})

test('이미 미확정인 명령은 재확인 호출 전 기한 종료로 변경 없음이 되지 않는다', async (t) => {
  const { remote, stored } = await fixture(t)
  remote.callRunner = () => currentStorageBudget().wait(() => new Promise(() => {}))
  await assert.rejects(withStorageBudget(createStorageBudget({ totalMs: 30 }), () => remote.bindConversation('slow', 'conversation-slow')), { outcome: 'processing' })
  const pending = (await stored()).leases.slow.pendingOperation
  const budget = createStorageBudget()
  remote.callRunner = () => { budget.cancel(); return budget.wait(() => assert.fail('실행 금지')) }
  await assert.rejects(withStorageBudget(budget, () => remote.bindConversation('slow', 'conversation-slow')), { outcome: 'processing' })
  assert.equal((await stored()).leases.slow.pendingOperation, pending)
  assert.equal(remote.reservations.size, 0)
})
