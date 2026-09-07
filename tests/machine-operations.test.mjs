import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MachineOperationError,
  MachineOperationQueue,
  normalizeMachineOperationRequest,
} from '../server/lib/machineOperations.mjs'

function createQueue(overrides = {}) {
  let current = 1_000
  let sequence = 0
  const queue = new MachineOperationQueue({
    now: () => current,
    createOperationId: () => `op-${(sequence += 1)}`,
    ...overrides,
  })
  return {
    queue,
    advance(ms) { current += ms },
    get time() { return current },
  }
}

async function settledState(promise) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
}

test('오퍼레이션 요청은 메서드와 경로를 검증한다', () => {
  assert.deepEqual(normalizeMachineOperationRequest({ pathname: '/api/conversations' }), {
    method: 'GET',
    pathname: '/api/conversations',
    timeoutMs: 8_000,
  })
  assert.equal(normalizeMachineOperationRequest({ pathname: '/a', method: 'post' }).method, 'POST')
  assert.throws(() => normalizeMachineOperationRequest({ pathname: '/a', method: 'TRACE' }), MachineOperationError)
  assert.throws(() => normalizeMachineOperationRequest({ pathname: 'api/x' }), MachineOperationError)
  assert.throws(() => normalizeMachineOperationRequest({ pathname: '//evil.example' }), MachineOperationError)
  assert.throws(() => normalizeMachineOperationRequest({ pathname: '/api/../secret' }), MachineOperationError)
  assert.throws(() => normalizeMachineOperationRequest(null), MachineOperationError)
})

test('요청 제한 시간은 하한과 상한 안으로 맞춘다', () => {
  assert.equal(normalizeMachineOperationRequest({ pathname: '/a', timeoutMs: 5 }).timeoutMs, 1_000)
  assert.equal(normalizeMachineOperationRequest({ pathname: '/a', timeoutMs: 900_000 }).timeoutMs, 600_000)
  assert.equal(normalizeMachineOperationRequest({ pathname: '/a', timeoutMs: 30_000 }).timeoutMs, 30_000)
})

test('Runner가 가져간 결과가 성공이면 요청자에게 응답 본문을 전달한다', async () => {
  const { queue } = createQueue()
  const { operationId, completion } = queue.enqueue('macbook', { pathname: '/api/conversations', method: 'POST', body: { title: '테스트' } })

  const claimed = queue.claim('macbook')
  assert.deepEqual(claimed, [{
    operationId,
    request: { method: 'POST', pathname: '/api/conversations', body: { title: '테스트' }, timeoutMs: 8_000 },
  }])

  queue.settle('macbook', operationId, { ok: true, data: { conversationId: 'abc' } })
  assert.deepEqual(await completion, { conversationId: 'abc' })
  assert.deepEqual(queue.snapshot('macbook'), { pending: 0, dispatched: 0, waiting: 0 })
})

test('원격 실패는 기존 AionUi 호출과 같은 오류 형태로 전달한다', async () => {
  const { queue } = createQueue()
  const { operationId, completion } = queue.enqueue('macbook', { pathname: '/api/conversations' })
  queue.claim('macbook')
  queue.settle('macbook', operationId, { ok: false, status: 404, code: 'NOT_FOUND' })

  const result = await settledState(completion)
  assert.equal(result.ok, false)
  assert.equal(result.error.message, 'AIONUI_REQUEST_FAILED:404')
  assert.equal(result.error.status, 404)
  assert.equal(result.error.code, 'NOT_FOUND')
})

test('가져가지 않았거나 이미 끝난 오퍼레이션은 결과를 받지 않는다', async () => {
  const { queue } = createQueue()
  const { operationId, completion } = queue.enqueue('macbook', { pathname: '/api/x' })

  assert.throws(() => queue.settle('macbook', operationId, { ok: true }), MachineOperationError)
  queue.claim('macbook')
  assert.throws(() => queue.settle('desk-win', operationId, { ok: true }), MachineOperationError)
  assert.throws(() => queue.settle('macbook', 'op-없음', { ok: true }), MachineOperationError)

  queue.settle('macbook', operationId, { ok: true, data: {} })
  await completion
  assert.throws(() => queue.settle('macbook', operationId, { ok: true }), MachineOperationError)
})

test('오퍼레이션은 머신별로 격리되고 등록 순서대로 전달한다', () => {
  const { queue } = createQueue()
  queue.enqueue('macbook', { pathname: '/api/first' })
  queue.enqueue('linux-box', { pathname: '/api/other' })
  queue.enqueue('macbook', { pathname: '/api/second' })

  assert.deepEqual(queue.claim('macbook', 5).map((operation) => operation.request.pathname), ['/api/first', '/api/second'])
  assert.deepEqual(queue.claim('linux-box', 5).map((operation) => operation.request.pathname), ['/api/other'])
  assert.deepEqual(queue.claim('macbook', 5), [])
})

test('한 번에 가져갈 개수를 제한한다', () => {
  const { queue } = createQueue()
  for (let index = 0; index < 4; index += 1) queue.enqueue('macbook', { pathname: `/api/${index}` })

  assert.equal(queue.claim('macbook', 2).length, 2)
  assert.equal(queue.snapshot('macbook').dispatched, 2)
  assert.equal(queue.claim('macbook', 99).length, 2)
})

test('Runner가 연결되지 않으면 전달 상한을 넘긴 요청을 실패로 확정한다', async () => {
  const { queue, advance } = createQueue({ dispatchTimeoutMs: 30_000 })
  const { completion } = queue.enqueue('macbook', { pathname: '/api/x' })

  advance(29_999)
  assert.equal(queue.sweep(), 0)

  advance(1)
  assert.equal(queue.sweep(), 1)
  const result = await settledState(completion)
  assert.equal(result.ok, false)
  assert.equal(result.error.reasonCode, 'RUNNER_UNAVAILABLE')
})

test('가져간 뒤 결과가 오지 않은 요청은 재전달하지 않고 실패로 확정한다', async () => {
  const { queue, advance } = createQueue({ dispatchTimeoutMs: 30_000, resultTimeoutMs: 60_000 })
  const { completion } = queue.enqueue('macbook', { pathname: '/api/x' })
  queue.claim('macbook')

  advance(60_000)
  assert.equal(queue.sweep(), 1)
  // 다시 내보내면 AionUi 대화가 중복 생성되므로 재전달하지 않는다.
  assert.deepEqual(queue.claim('macbook', 5), [])

  const result = await settledState(completion)
  assert.equal(result.ok, false)
  assert.equal(result.error.reasonCode, 'RESULT_TIMEOUT')
})

test('결과 대기 상한은 요청 자체의 제한 시간보다 짧아지지 않는다', async () => {
  const { queue, advance } = createQueue({ resultTimeoutMs: 10_000 })
  const { completion } = queue.enqueue('macbook', { pathname: '/api/slow', timeoutMs: 120_000 })
  queue.claim('macbook')

  advance(100_000)
  assert.equal(queue.sweep(), 0)
  advance(25_001)
  assert.equal(queue.sweep(), 1)

  const result = await settledState(completion)
  assert.equal(result.ok, false)
  assert.equal(result.error.reasonCode, 'RESULT_TIMEOUT')
})

test('대기 중인 Runner는 새 오퍼레이션이 등록되면 즉시 깨어난다', async () => {
  const { queue } = createQueue()
  const waiting = queue.waitForClaim('macbook', { waitMs: 5_000 })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(queue.snapshot('macbook').waiting, 1)

  queue.enqueue('macbook', { pathname: '/api/wake' })
  const claimed = await waiting
  assert.deepEqual(claimed.map((operation) => operation.request.pathname), ['/api/wake'])
  assert.equal(queue.snapshot('macbook').waiting, 0)
})

test('대기 시간이 지나면 빈 목록을 반환하고 대기자를 정리한다', async () => {
  const { queue } = createQueue()
  const timers = []
  let cleared = 0

  const waiting = queue.waitForClaim('macbook', {
    waitMs: 5_000,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer: () => { cleared += 1 },
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delayMs, 5_000)
  assert.equal(queue.snapshot('macbook').waiting, 1)

  // 대기 시간이 지난 상황을 재현한다.
  timers[0].callback()
  assert.deepEqual(await waiting, [])
  assert.equal(queue.snapshot('macbook').waiting, 0)
  assert.equal(cleared, 1)
})

test('대기 시간이 0 이하면 기다리지 않고 즉시 빈 목록을 반환한다', async () => {
  const { queue } = createQueue()
  assert.deepEqual(await queue.waitForClaim('macbook', { waitMs: 0 }), [])
  assert.equal(queue.snapshot('macbook').waiting, 0)
})

test('큐를 닫은 뒤에는 대기하지 않고 즉시 빈 목록을 반환한다', async () => {
  const { queue } = createQueue()
  queue.close()
  assert.deepEqual(await queue.waitForClaim('macbook', { waitMs: 60_000 }), [])
  assert.equal(queue.snapshot('macbook').waiting, 0)
})

test('이미 대기 중인 요청이 있으면 기다리지 않고 바로 가져간다', async () => {
  const { queue } = createQueue()
  queue.enqueue('macbook', { pathname: '/api/ready' })
  const claimed = await queue.waitForClaim('macbook', { waitMs: 60_000 })
  assert.deepEqual(claimed.map((operation) => operation.request.pathname), ['/api/ready'])
})

test('머신별 대기 상한을 넘는 요청은 거부한다', () => {
  const { queue } = createQueue({ maxPendingPerMachine: 2 })
  const first = queue.enqueue('macbook', { pathname: '/api/1' })
  queue.enqueue('macbook', { pathname: '/api/2' })

  assert.throws(() => queue.enqueue('macbook', { pathname: '/api/3' }), MachineOperationError)
  // 가져가면 대기열이 비므로 다시 등록할 수 있다.
  queue.claim('macbook', 2)
  assert.ok(queue.enqueue('macbook', { pathname: '/api/3' }).operationId)
  void first.completion.catch(() => {})
})

test('머신 등록을 삭제하면 그 머신으로 향하던 요청을 즉시 실패로 확정한다', async () => {
  const { queue } = createQueue()
  const pending = queue.enqueue('macbook', { pathname: '/api/1' })
  const dispatched = queue.enqueue('macbook', { pathname: '/api/2' })
  const other = queue.enqueue('desk-win', { pathname: '/api/3' })
  queue.claim('macbook', 1)

  assert.equal(queue.cancelMachine('macbook'), 2)
  for (const completion of [pending.completion, dispatched.completion]) {
    const result = await settledState(completion)
    assert.equal(result.ok, false)
    assert.equal(result.error.reasonCode, 'MACHINE_UNREGISTERED')
  }
  assert.equal(queue.snapshot('desk-win').pending, 1)
  void other.completion.catch(() => {})
})

test('큐를 닫으면 남은 요청을 모두 실패로 확정하고 새 요청을 받지 않는다', async () => {
  const { queue } = createQueue()
  const { completion } = queue.enqueue('macbook', { pathname: '/api/1' })

  queue.close()
  const result = await settledState(completion)
  assert.equal(result.ok, false)
  assert.equal(result.error.reasonCode, 'QUEUE_CLOSED')
  assert.throws(() => queue.enqueue('macbook', { pathname: '/api/2' }), MachineOperationError)
})
