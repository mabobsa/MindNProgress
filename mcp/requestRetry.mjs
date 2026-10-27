const transientCodes = new Set(['WRITE_QUEUE_FULL', 'LOCK_WAIT_TIMEOUT'])
export function retryDelay(attempt, retryAfterMs = 0, random = Math.random) {
  return Math.max(Number(retryAfterMs) || 0, Math.round(100 * 2 ** (attempt - 1) * (0.75 + random() * 0.5)))
}
export function requestDeadlineError() {
  return Object.assign(new Error('논리 요청의 전체 기한이 지났습니다. 같은 요청 ID로 결과를 확인하세요.'), {
    code: 'REQUEST_DEADLINE_EXCEEDED', reasonCode: 'REQUEST_DEADLINE_EXCEEDED', outcome: 'unknown', retryable: false,
  })
}
export async function retryStorageRequest(operation, { deadlineAt, now = Date.now, random = Math.random,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onRetry = () => {} } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (now() >= deadlineAt) throw requestDeadlineError()
    try { return await operation(attempt) } catch (error) {
      const safe = error.outcome === 'unknown' && error.reasonCode === 'REQUEST_RESPONSE_UNKNOWN'
        || error.outcome === 'not-applied' && error.retryable === true && transientCodes.has(error.code)
      if (!safe || attempt === 3) throw error
      const delay = retryDelay(attempt, error.retryAfterMs, random)
      if (now() + delay >= deadlineAt) throw error
      onRetry(attempt)
      await sleep(delay)
    }
  }
}
