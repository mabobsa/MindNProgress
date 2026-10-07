import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeStoppingError, retryDispatchStatus, throwIfRuntimeStopping } from '../server/lib/runtimeStopping.mjs'

test('일반 원격 확인 실패는 기존 횟수 안에서 재시도한다', async () => {
  const controller = new AbortController()
  let reads = 0
  const result = await retryDispatchStatus(() => {
    if (++reads < 3) throw new Error('response lost')
    return { operationId: 'existing' }
  }, controller.signal, { delayMs: 1 })
  assert.deepEqual(result, { operationId: 'existing' })
  assert.equal(reads, 3)
})

test('원격 확인 재시도 대기는 종료 신호로 즉시 풀리고 다음 호출을 하지 않는다', async () => {
  const controller = new AbortController()
  let reads = 0
  const pending = retryDispatchStatus(() => { reads++; throw new Error('response lost') }, controller.signal)
  const rejected = assert.rejects(pending, error => error === controller.signal.reason)
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort(new RuntimeStoppingError())
  await rejected
  assert.equal(reads, 1)
})

test('종료 중단은 일반 실패 처리에 전달되지 않고 원래 전달 상태를 보존한다', () => {
  const error = new RuntimeStoppingError({ operationId: 'existing', deliveryState: 'dispatched' })
  assert.throws(() => throwIfRuntimeStopping(error), candidate => candidate === error && candidate.deliveryState === 'dispatched')
  const controller = new AbortController()
  controller.abort(new RuntimeStoppingError())
  assert.throws(() => throwIfRuntimeStopping(new Error('wrapped remote error'), controller.signal), candidate => candidate === controller.signal.reason)
  assert.doesNotThrow(() => throwIfRuntimeStopping(new Error('regular error')))
})
