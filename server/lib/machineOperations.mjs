// 서브 머신의 AionUi를 메인 머신에서 직접 호출하면 서브가 inbound 주소를 열어야 하고
// AionUi 내부 API가 인증 없이 사내망에 노출된다. 그래서 방향을 뒤집어
// 서브 머신의 Runner가 이 큐를 long-poll로 당겨가고 결과만 올려보낸다.
//
// 재전달은 하지 않는다. AionUi 대화 생성과 dispatch는 멱등하지 않으므로
// 가져간 뒤 응답이 없는 오퍼레이션을 다시 내보내면 대화가 중복 생성된다.
// 가져간 오퍼레이션이 제한 시간을 넘기면 재시도 없이 실패로 확정한다.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const MACHINE_OPERATION_STATES = Object.freeze(['pending', 'dispatched', 'succeeded', 'failed'])

export const MACHINE_OPERATION_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export class MachineOperationError extends Error {
  constructor(message, { status = null, code = null, reasonCode = null } = {}) {
    super(message)
    this.name = 'MachineOperationError'
    this.status = status
    this.code = code
    this.reasonCode = reasonCode
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function tokenHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest()
}

function tokenMatches(value, expectedHash) {
  if (typeof value !== 'string' || !value || !Buffer.isBuffer(expectedHash)) return false
  const candidate = tokenHash(value)
  return candidate.length === expectedHash.length && timingSafeEqual(candidate, expectedHash)
}

export function normalizeMachineOperationRequest(value) {
  if (!isRecord(value)) throw new MachineOperationError('오퍼레이션 요청이 올바르지 않습니다.')

  const method = String(value.method ?? 'GET').trim().toUpperCase()
  if (!MACHINE_OPERATION_METHODS.includes(method)) {
    throw new MachineOperationError('지원하지 않는 오퍼레이션 메서드입니다.')
  }

  const pathname = String(value.pathname ?? '').trim()
  // Runner는 이 경로를 자기 로컬 AionUi 주소에 그대로 붙인다. 절대 주소나 상위 경로 탈출을 막는다.
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('..')) {
    throw new MachineOperationError('오퍼레이션 경로가 올바르지 않습니다.')
  }

  return {
    method,
    pathname,
    ...(value.body === undefined ? {} : { body: value.body }),
    timeoutMs: Math.max(1_000, Math.min(600_000, Math.trunc(Number(value.timeoutMs) || 0) || 8_000)),
  }
}

export class MachineOperationQueue {
  constructor({
    dispatchTimeoutMs = 30_000,
    resultTimeoutMs = 180_000,
    maxPendingPerMachine = 64,
    createOperationId = () => `op-${Math.random().toString(36).slice(2, 12)}`,
    createResultToken = () => `mnop_${randomBytes(32).toString('base64url')}`,
    completedRetentionMs = 10 * 60_000,
    maxCompletedOperations = 1_024,
    now = () => Date.now(),
  } = {}) {
    this.dispatchTimeoutMs = dispatchTimeoutMs
    this.resultTimeoutMs = resultTimeoutMs
    this.maxPendingPerMachine = maxPendingPerMachine
    this.createOperationId = createOperationId
    this.createResultToken = createResultToken
    this.completedRetentionMs = completedRetentionMs
    this.maxCompletedOperations = maxCompletedOperations
    this.now = now
    this.operations = new Map()
    this.completedOperations = new Map()
    this.waiters = new Map()
    this.closed = false
  }

  // 실행 대기 중인 오퍼레이션을 기다리는 Runner를 깨운다.
  wake(machineId) {
    const machineWaiters = this.waiters.get(machineId)
    if (!machineWaiters || machineWaiters.size === 0) return
    for (const waiter of [...machineWaiters]) {
      machineWaiters.delete(waiter)
      waiter()
    }
    if (machineWaiters.size === 0) this.waiters.delete(machineId)
  }

  pendingOperations(machineId) {
    return [...this.operations.values()]
      .filter((operation) => operation.machineId === machineId && operation.state === 'pending')
      .sort((first, second) => first.createdAt - second.createdAt)
  }

  enqueue(machineId, request) {
    if (this.closed) throw new MachineOperationError('오퍼레이션 큐가 종료되었습니다.', { reasonCode: 'QUEUE_CLOSED' })

    const normalizedRequest = normalizeMachineOperationRequest(request)
    if (this.pendingOperations(machineId).length >= this.maxPendingPerMachine) {
      throw new MachineOperationError(
        `${machineId} 머신의 대기 중인 요청이 너무 많습니다.`,
        { reasonCode: 'QUEUE_FULL' },
      )
    }

    const createdAt = this.now()
    const resultToken = this.createResultToken()
    const operation = {
      operationId: this.createOperationId(),
      machineId,
      request: normalizedRequest,
      state: 'pending',
      createdAt,
      dispatchedAt: null,
      settledAt: null,
      // 가져가기 전에는 dispatch 상한, 가져간 뒤에는 실행 결과 상한을 적용한다.
      expiresAt: createdAt + this.dispatchTimeoutMs,
      resolve: null,
      reject: null,
      settled: false,
      resultToken,
      resultTokenHash: tokenHash(resultToken),
    }

    const completion = new Promise((resolve, reject) => {
      operation.resolve = resolve
      operation.reject = reject
    })

    this.operations.set(operation.operationId, operation)
    this.wake(machineId)
    return { operationId: operation.operationId, completion }
  }

  claim(machineId, limit = 1) {
    const claimLimit = Math.max(1, Math.min(32, Math.trunc(Number(limit) || 1)))
    const claimed = this.pendingOperations(machineId).slice(0, claimLimit)
    const dispatchedAt = this.now()

    for (const operation of claimed) {
      operation.state = 'dispatched'
      operation.dispatchedAt = dispatchedAt
      operation.expiresAt = dispatchedAt + Math.max(this.resultTimeoutMs, operation.request.timeoutMs + 5_000)
    }

    return claimed.map((operation) => ({
      operationId: operation.operationId,
      resultToken: operation.resultToken,
      request: operation.request,
    }))
  }

  // pending이 있으면 즉시 반환하고, 없으면 waitMs 동안 기다렸다가 빈 배열을 반환한다.
  async waitForClaim(machineId, {
    limit = 1,
    waitMs = 25_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    shouldClaim = () => true,
  } = {}) {
    const immediate = shouldClaim() ? this.claim(machineId, limit) : []
    if (immediate.length > 0 || waitMs <= 0 || this.closed) return immediate

    await new Promise((resolve) => {
      let timer = null
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        const machineWaiters = this.waiters.get(machineId)
        machineWaiters?.delete(finish)
        if (machineWaiters?.size === 0) this.waiters.delete(machineId)
        clearTimer(timer)
        resolve()
      }
      // 대기자를 먼저 등록해야 타이머가 즉시 실행되더라도 대기자가 남지 않는다.
      if (!this.waiters.has(machineId)) this.waiters.set(machineId, new Set())
      this.waiters.get(machineId).add(finish)
      timer = setTimer(finish, waitMs)
      if (typeof timer?.unref === 'function') timer.unref()
    })

    return shouldClaim() ? this.claim(machineId, limit) : []
  }

  // long-poll 응답이 Runner에 전달되지 못한 경우다.
  // Runner가 받지 못했으므로 다시 대기열로 돌려도 중복 실행이 되지 않는다.
  // 이 되돌림이 없으면 절전이나 종료로 끊긴 연결이 다음 요청을 결과 상한까지 묶는다.
  release(machineId, operationIds) {
    let released = 0
    for (const operationId of operationIds ?? []) {
      const operation = this.operations.get(String(operationId ?? ''))
      if (!operation || operation.machineId !== machineId || operation.state !== 'dispatched') continue
      operation.state = 'pending'
      operation.dispatchedAt = null
      // Runner가 계속 끊겼다 붙어도 전달 상한이 무한히 늘어나지 않도록 등록 시점을 기준으로 둔다.
      operation.expiresAt = operation.createdAt + this.dispatchTimeoutMs
      released += 1
    }
    if (released > 0) this.wake(machineId)
    return released
  }

  settle(machineId, operationId, result) {
    const operation = this.operations.get(String(operationId ?? ''))
    if (!operation || operation.machineId !== machineId) {
      const completed = this.completedOperations.get(String(operationId ?? ''))
      if (completed?.machineId === machineId) {
        return { operationId: completed.operationId, state: completed.state, duplicate: true }
      }
      throw new MachineOperationError('오퍼레이션을 찾지 못했습니다.', { reasonCode: 'OPERATION_NOT_FOUND' })
    }
    if (operation.state !== 'dispatched') {
      throw new MachineOperationError(
        '가져가지 않았거나 이미 끝난 오퍼레이션입니다.',
        { reasonCode: 'OPERATION_NOT_DISPATCHED' },
      )
    }

    operation.settledAt = this.now()
    if (isRecord(result) && result.ok === true) {
      operation.state = 'succeeded'
      this.finish(operation, null, result.data ?? {})
    } else {
      const status = Number.isInteger(result?.status) ? result.status : null
      operation.state = 'failed'
      this.finish(operation, new MachineOperationError(
        `AIONUI_REQUEST_FAILED${status === null ? '' : `:${status}`}`,
        { status, code: result?.code ?? null, reasonCode: 'REMOTE_REQUEST_FAILED' },
      ))
    }

    return { operationId: operation.operationId, state: operation.state }
  }

  finish(operation, error, value) {
    if (operation.settled) return
    operation.settled = true
    if (error) operation.reject(error)
    else operation.resolve(value)
    // Runner가 결과를 올렸지만 성공 응답을 받지 못하면 같은 결과를 다시 보낸다.
    // 짧은 완료 확인 기록을 남겨 재전송을 멱등하게 확인한다.
    this.completedOperations.set(operation.operationId, {
      operationId: operation.operationId,
      machineId: operation.machineId,
      state: operation.state,
      resultTokenHash: operation.resultTokenHash,
      expiresAt: this.now() + this.completedRetentionMs,
    })
    this.operations.delete(operation.operationId)
    this.sweepCompleted()
  }

  verifyResultToken(machineId, operationId, resultToken) {
    const normalizedOperationId = String(operationId ?? '')
    const operation = this.operations.get(normalizedOperationId)
    if (operation?.machineId === machineId) return tokenMatches(resultToken, operation.resultTokenHash)
    const completed = this.completedOperations.get(normalizedOperationId)
    if (completed?.expiresAt <= this.now()) {
      this.completedOperations.delete(normalizedOperationId)
      return false
    }
    return completed?.machineId === machineId && tokenMatches(resultToken, completed.resultTokenHash)
  }

  sweepCompleted() {
    const current = this.now()
    for (const [operationId, operation] of this.completedOperations) {
      if (operation.expiresAt <= current) this.completedOperations.delete(operationId)
    }
    while (this.completedOperations.size > this.maxCompletedOperations) {
      const oldestOperationId = this.completedOperations.keys().next().value
      if (oldestOperationId === undefined) break
      this.completedOperations.delete(oldestOperationId)
    }
  }

  // 제한 시간을 넘긴 오퍼레이션을 재시도 없이 실패로 확정한다.
  sweep() {
    const current = this.now()
    let expired = 0
    for (const operation of [...this.operations.values()]) {
      if (operation.state !== 'pending' && operation.state !== 'dispatched') continue
      if (operation.expiresAt > current) continue
      const waitingForClaim = operation.state === 'pending'
      operation.state = 'failed'
      operation.settledAt = current
      this.finish(operation, new MachineOperationError(
        waitingForClaim
          ? `${operation.machineId} 머신의 Runner가 연결되지 않아 요청을 전달하지 못했습니다.`
          : `${operation.machineId} 머신이 요청 결과를 제한 시간 안에 보내지 않았습니다.`,
        { reasonCode: waitingForClaim ? 'RUNNER_UNAVAILABLE' : 'RESULT_TIMEOUT' },
      ))
      expired += 1
    }
    this.sweepCompleted()
    return expired
  }

  // Runner 등록이 취소되면 그 머신으로 향하던 요청을 즉시 실패로 확정한다.
  cancelMachine(machineId, reason = '머신 등록이 삭제되었습니다.') {
    let cancelled = 0
    for (const operation of [...this.operations.values()]) {
      if (operation.machineId !== machineId) continue
      operation.state = 'failed'
      operation.settledAt = this.now()
      this.finish(operation, new MachineOperationError(reason, { reasonCode: 'MACHINE_UNREGISTERED' }))
      cancelled += 1
    }
    this.wake(machineId)
    return cancelled
  }

  snapshot(machineId) {
    const operations = [...this.operations.values()].filter((operation) => operation.machineId === machineId)
    return {
      pending: operations.filter((operation) => operation.state === 'pending').length,
      dispatched: operations.filter((operation) => operation.state === 'dispatched').length,
      waiting: this.waiters.get(machineId)?.size ?? 0,
    }
  }

  close(reason = '서버가 종료되었습니다.') {
    this.closed = true
    for (const operation of [...this.operations.values()]) {
      operation.state = 'failed'
      this.finish(operation, new MachineOperationError(reason, { reasonCode: 'QUEUE_CLOSED' }))
    }
    for (const machineId of [...this.waiters.keys()]) this.wake(machineId)
  }
}
