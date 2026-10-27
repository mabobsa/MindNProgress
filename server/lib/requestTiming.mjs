import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const responseTiming = Symbol('requestTiming')

export function stringifyTimedResponse(response, body) {
  const timing = response[responseTiming]
  if (!timing) return JSON.stringify(body)
  return timing.serialize(body)
}

export function startRequestTiming(request, response, {
  now = () => performance.now(), wallNow = () => new Date().toISOString(), warn = console.warn, slowMs = 1000, diagnostics = null,
} = {}) {
  const id = randomUUID()
  const started = now()
  const startedAt = wallNow()
  const stages = {}
  const measuring = new Map()
  const pathname = String(request.url ?? '').split('?')[0]
  // 시작 확인 토큰과 쿼리·본문·인증 헤더는 진단 파일에 남기지 않는다.
  const diagnosticPath = pathname.replace(/(\/launches\/)[^/]+/g, '$1:token')
  const tracked = pathname.startsWith('/api/') && pathname !== '/api/events'
  const source = /^\/api\/machines\/[^/]+\/runner\/(operations\/|heartbeat)/.test(pathname) ? 'runner'
    : request.headers?.['x-mnp-ai-conversation-id'] ? 'mcp' : 'other'
  const snapshot = () => ({ elapsedMs: Math.round(now() - started), stages: { ...stages },
    inFlightStages: Object.fromEntries([...measuring.values()].map(({ name, at }) => [name, Math.round(now() - at)])) })
  const emit = (value) => {
    if (tracked) { try { diagnostics?.emit({ ...value, requestId: id }) } catch { /* 진단 실패는 요청에 영향 없음 */ } }
  }
  if (tracked) {
    try { diagnostics?.begin(id, { method: request.method, path: diagnosticPath, snapshot }) } catch { /* 진단 실패는 요청에 영향 없음 */ }
    emit({ event: 'request-start', startedAt, method: request.method, path: diagnosticPath, source })
  }
  response.setHeader('X-MNP-Request-Id', id)
  let reported = false
  let completed = false
  let responseChars = null
  const finish = () => {
    if (reported) return
    reported = true
    const elapsedMs = Math.round(now() - started)
    const state = snapshot()
    emit({ event: 'response', status: response.statusCode, aborted: !response.writableFinished, responseChars, ...state })
    if (pathname === '/api/events' || (elapsedMs < slowMs && response.statusCode < 500 && response.writableFinished)) return
    try {
      warn('[API timing]', JSON.stringify({ requestId: id, at: wallNow(), startedAt, method: request.method, path: diagnosticPath,
        status: response.statusCode, ...state, aborted: !response.writableFinished }))
    } catch { /* 진단 실패는 요청에 전파하지 않는다. */ }
  }
  response.once('finish', finish)
  response.once('close', finish)
  const timing = {
    async measure(name, operation) {
      const at = now()
      const token = Symbol(name)
      measuring.set(token, { name, at })
      try { return await operation() } finally {
        measuring.delete(token)
        stages[name] = (stages[name] ?? 0) + Math.round(now() - at)
      }
    },
    serialize(body) {
      const at = now()
      try {
        const text = JSON.stringify(body)
        responseChars = text?.length ?? 0
        return text
      } finally { stages.serializeMs = (stages.serializeMs ?? 0) + Math.round(now() - at) }
    },
    complete() {
      if (completed) return
      completed = true
      emit({ event: 'handler-end', status: response.statusCode, responseChars, ...snapshot() })
      try { diagnostics?.end(id) } catch { /* 진단 실패는 요청에 영향 없음 */ }
    },
  }
  response[responseTiming] = timing
  return timing
}
