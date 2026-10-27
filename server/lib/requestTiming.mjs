import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export function startRequestTiming(request, response, { now = () => performance.now(), warn = console.warn, slowMs = 1000 } = {}) {
  const id = randomUUID()
  const started = now()
  const stages = {}
  response.setHeader('X-MNP-Request-Id', id)
  let reported = false
  const finish = () => {
    if (reported) return
    reported = true
    const elapsedMs = Math.round(now() - started)
    const pathname = String(request.url ?? '').split('?')[0]
    if (pathname === '/api/events' || (elapsedMs < slowMs && response.statusCode < 500 && response.writableFinished)) return
    warn('[API timing]', JSON.stringify({ requestId: id, method: request.method, path: pathname,
      status: response.statusCode, elapsedMs, stages, aborted: !response.writableFinished }))
  }
  response.once('finish', finish)
  response.once('close', finish)
  return {
    async measure(name, operation) {
      const at = now()
      try { return await operation() } finally { stages[name] = Math.round(now() - at) }
    },
  }
}
