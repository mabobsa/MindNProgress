import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'

const context = new AsyncLocalStorage()
let processWaiting = 0
export const storageDiagnostic = channel('mindnprogress.storage.diagnostic')
export const storageLimits = Object.freeze({ totalMs: 30_000, multiTotalMs: 60_000, waitMs: 5_000, multiWaitMs: 10_000, perKey: 128, total: 1_024 })
export const currentStorageBudget = () => context.getStore() ?? null
export const withStorageBudget = (budget, operation) => context.run(budget, operation)
export const detachedStorageBudget = (operation) => context.run(null, operation)

export function storageAdmissionError(code = 'LOCK_WAIT_TIMEOUT') {
  return Object.assign(new Error(code === 'WRITE_QUEUE_FULL' ? '저장 대기열이 가득 찼습니다.'
    : code === 'REQUEST_CANCELLED' ? '저장 준비 전에 요청이 취소되었습니다.' : '요청의 대기 기한이 지났습니다.'), {
    code, status: code === 'REQUEST_CANCELLED' ? 499 : 503, outcome: 'not-applied',
    retryable: ['LOCK_WAIT_TIMEOUT', 'WRITE_QUEUE_FULL'].includes(code), retryAfterMs: 250, storageResourceError: true,
  })
}

export function createStorageBudget({ multi = false, totalMs = multi ? storageLimits.multiTotalMs : storageLimits.totalMs,
  waitMs = multi ? storageLimits.multiWaitMs : storageLimits.waitMs, deadlineAt, signal, requestId = '', now = Date.now } = {}) {
  const startedAt = now()
  const controller = new AbortController()
  const budget = { requestId, deadlineAt: Math.min(startedAt + totalMs, Number.isFinite(deadlineAt) ? deadlineAt : Infinity),
    waitMs, queueWaitMs: 0, lockHoldMs: 0, persistMs: 0, externalWaitMs: 0, retries: 0,
    phase: 'body', preparing: false, signal: controller.signal, resources: new Set(),
    remaining: () => Math.max(0, budget.deadlineAt - now()),
    assert() {
      if (budget.preparing) return
      if (controller.signal.aborted) throw controller.signal.reason
      if (budget.remaining() <= 0) throw storageAdmissionError('REQUEST_DEADLINE_EXCEEDED')
    },
    prepare() { budget.assert(); budget.preparing = true; budget.phase = 'persist' },
    cancel() { if (!budget.preparing) controller.abort(storageAdmissionError('REQUEST_CANCELLED')) },
    async wait(operation, phase = 'external') {
      budget.assert()
      const started = now()
      budget.phase = phase
      let timer, abort
      try {
        return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
          abort = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', abort, { once: true })
          timer = setTimeout(() => reject(storageAdmissionError('REQUEST_DEADLINE_EXCEEDED')), budget.remaining())
        })])
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener('abort', abort)
        if (phase === 'external') budget.externalWaitMs += now() - started
      }
    },
    finish(outcome) {
      signal?.removeEventListener('abort', cancel)
      storageDiagnostic.publish({ requestId, resources: [...budget.resources], phase: budget.phase,
        queueWaitMs: budget.queueWaitMs, lockHoldMs: budget.lockHoldMs, persistMs: budget.persistMs,
        externalWaitMs: budget.externalWaitMs, retries: budget.retries, outcome })
    },
  }
  const cancel = () => budget.cancel()
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  return budget
}

// FIFO 대기자만 계수한다. 같은 요청의 합류는 journal lookup에서 이 큐에 오기 전에 처리한다.
export function createResourceQueue({ perKey = storageLimits.perKey, total = storageLimits.total } = {}) {
  const locks = new Map()
  let waiting = 0
  function acquire(key, mode = 'write', budget = currentStorageBudget()) {
    budget?.assert()
    budget?.resources.add(key)
    let lock = locks.get(key)
    if (!lock) { lock = { readers: 0, writer: false, pending: [] }; locks.set(key, lock) }
    const prune = () => { if (!lock.writer && !lock.readers && !lock.pending.length) locks.delete(key) }
    const grant = (resolve) => {
      if (mode === 'write') lock.writer = true
      else lock.readers++
      let released = false
      resolve(() => { if (released) return; released = true
        if (mode === 'write') lock.writer = false
        else lock.readers--
        drain(); prune()
      })
    }
    const drain = () => {
      while (lock.pending.length && !lock.writer) {
        const next = lock.pending[0]
        if (next.mode === 'write' && lock.readers) break
        lock.pending.shift(); next.cleanup()
        try {
          next.budget?.assert()
          if (Date.now() >= next.waitUntil) throw storageAdmissionError()
        } catch (error) { next.reject(error); continue }
        next.grant()
      }
      prune()
    }
    if (!lock.pending.length && !lock.writer && (mode === 'read' || !lock.readers)) return new Promise(grant)
    if (lock.pending.length >= perKey || processWaiting >= total) { prune(); throw storageAdmissionError('WRITE_QUEUE_FULL') }
    const started = Date.now()
    const limit = budget ? Math.min(budget.remaining(), budget.waitMs - budget.queueWaitMs) : storageLimits.waitMs
    if (limit <= 0) throw storageAdmissionError()
    if (budget) budget.phase = 'queue'
    return new Promise((resolve, reject) => {
      let timer
      const abort = () => remove(budget.signal.reason)
      const item = { mode, budget, reject, waitUntil: started + limit, grant: () => grant(resolve), cleanup: () => {
        waiting--; processWaiting--; clearTimeout(timer); budget?.signal.removeEventListener('abort', abort)
        if (budget) budget.queueWaitMs += Date.now() - started
      } }
      const remove = (error) => {
        const index = lock.pending.indexOf(item)
        if (index < 0) return
        lock.pending.splice(index, 1); item.cleanup(); reject(error); drain()
      }
      waiting++; processWaiting++; lock.pending.push(item)
      timer = setTimeout(() => remove(storageAdmissionError()), limit)
      if (!budget?.preparing) budget?.signal.addEventListener('abort', abort, { once: true })
    })
  }
  return { acquire, pending: () => [...locks].map(([key, lock]) => ({ key, readers: lock.readers, writer: lock.writer, pending: lock.pending.length })), waiting: () => waiting }
}

export function readBoundedBody(request, maximum, signal, budget = currentStorageBudget()) {
  budget?.assert()
  return new Promise((resolve, reject) => {
    let size = 0, timer
    const chunks = []
    const cleanup = () => {
      clearTimeout(timer)
      for (const [event, handler] of [['data', data], ['end', end], ['error', fail], ['aborted', aborted]]) request.off(event, handler)
      signal?.removeEventListener('abort', abort)
      budget?.signal.removeEventListener('abort', cancel)
    }
    const fail = (error) => { cleanup(); request.resume(); reject(error) }
    const abort = () => fail(signal.reason)
    const cancel = () => fail(budget.signal.reason)
    const aborted = () => fail(storageAdmissionError('REQUEST_CANCELLED'))
    const data = (chunk) => {
      size += chunk.length
      if (size > maximum) return fail(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }))
      chunks.push(chunk)
    }
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    if (signal?.aborted) return abort()
    if (budget?.signal.aborted) return cancel()
    request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', aborted)
    signal?.addEventListener('abort', abort, { once: true })
    budget?.signal.addEventListener('abort', cancel, { once: true })
    if (budget) timer = setTimeout(() => fail(storageAdmissionError('REQUEST_DEADLINE_EXCEEDED')), budget.remaining())
  })
}
