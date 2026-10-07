import { RuntimeStoppingError, isRuntimeStoppingError } from './runtimeStopping.mjs'
import { setMaxListeners } from 'node:events'

function requestLabel(request) {
  const resources = new Set(['maps', 'machines', 'integrations', 'ai-workspaces', 'ai-delegations', 'document-groups', 'users', 'auth'])
  const actions = new Set(['claim', 'result', 'heartbeat', 'checkpoint', 'status'])
  const parts = String(request.url ?? '').split('?')[0].split('/').filter(Boolean)
  const resource = parts[0] === 'api' && resources.has(parts[1]) ? `/api/${parts[1]}` : 'request'
  const action = actions.has(parts.at(-1)) ? `/${parts.at(-1)}` : ''
  return `HTTP ${request.method ?? 'request'} ${resource}${action}`
}

// HTTP 응답 종료와 비동기 저장 완료는 다르므로 요청 함수 자체를 추적한다.
const defaultConnectionGraceMs = Number(process.env.MNP_SHUTDOWN_CONNECTION_GRACE_MS ?? 5_000)
const defaultDiagnosticMs = Number(process.env.MNP_SHUTDOWN_DIAGNOSTIC_MS ?? 30_000)

export function createRuntimeLifecycle() {
  const pending = new Map()
  const timers = new Set()
  const controller = new AbortController()
  // 여러 요청의 본문 읽기가 같은 종료 신호를 구독하며, 각 요청의 finally에서 해제한다.
  setMaxListeners(0, controller.signal)
  let stopping = false
  let shutdown = null
  const track = (work, label = 'Background work') => {
    const promise = Promise.resolve().then(work)
    pending.set(promise, { label, startedAt: performance.now() })
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  return {
    track,
    signal: controller.signal,
    throwIfStopping() { controller.signal.throwIfAborted() },
    async readJsonBody(request) {
      const abort = () => { if (!request.complete) request.destroy(controller.signal.reason) }
      controller.signal.throwIfAborted()
      controller.signal.addEventListener('abort', abort, { once: true })
      try {
        const chunks = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 2_000_000) throw new Error('PAYLOAD_TOO_LARGE')
          chunks.push(chunk)
        }
        return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        if (!request.complete && controller.signal.aborted) throw controller.signal.reason
        throw error
      } finally { controller.signal.removeEventListener('abort', abort) }
    },
    request(handler) {
      return (request, response) => {
        if (stopping) {
          response.writeHead(503, { Connection: 'close', 'Retry-After': '2', 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: '서버를 종료하고 있습니다. 잠시 후 다시 시도해 주세요.' }))
          return
        }
        // 실제 URL의 ID·쿼리·토큰은 진단 라벨에 넣지 않는다.
        void track(() => handler(request, response), requestLabel(request)).catch((error) => {
          if (isRuntimeStoppingError(error)) {
            if (!response.destroyed && !response.headersSent) {
              response.writeHead(503, { Connection: 'close', 'Retry-After': '2', 'Content-Type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ error: error.message, reasonCode: error.reasonCode }))
            } else response.destroy()
            return
          }
          console.error('[Runtime request]', error)
          response.destroy()
        })
      }
    },
    interval(work, milliseconds, label) {
      const timer = setInterval(() => {
        if (!stopping) void track(work, label).catch((error) => {
          if (!isRuntimeStoppingError(error)) console.warn(`[${label}]`, error)
        })
      }, milliseconds)
      timers.add(timer)
      timer.unref()
      return timer
    },
    stop(server, closeStreams = () => {}, { connectionGraceMs = defaultConnectionGraceMs, diagnosticMs = defaultDiagnosticMs, warn = console.warn } = {}) {
      if (shutdown) return shutdown
      stopping = true
      for (const timer of timers) clearInterval(timer)
      let phase = 'draining tasks'
      // 진단은 추적 대상이 아니며 새로운 종료 대기를 만들지 않는다.
      const diagnostic = setTimeout(() => {
        const tasks = [...pending.values()].map(({ label, startedAt }) => ({ label, elapsedMs: Math.round(performance.now() - startedAt) }))
        warn('[Runtime] shutdown waiting', JSON.stringify({ phase, tasks }))
      }, diagnosticMs)
      diagnostic.unref()
      shutdown = (async () => {
        // 우선 신규 연결을 막되 진행 중인 요청·백그라운드 저장은 끊지 않는다.
        let drained = false
        const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        void closed.then(() => { drained = true }, () => { drained = true })
        controller.abort(new RuntimeStoppingError())
        closeStreams()
        while (pending.size) await Promise.allSettled([...pending.keys()])
        // 종료 직전에 등록된 SSE와 유휴 연결도 정리한다.
        closeStreams()
        server.closeIdleConnections?.()
        phase = 'closing connections'
        // 추적 중인 요청과 저장이 모두 끝난 뒤이므로 남은 연결을 더 기다릴 이유가 없다.
        // server.close() 이후에는 node가 headersTimeout을 강제하지 않아, 응답을 끝내지 않는
        // 연결 하나가 종료를 무기한 막을 수 있다. 유예 시간이 지나면 남은 연결을 정리한다.
        let connectionTimer
        try {
          await Promise.race([closed, new Promise(resolve => { connectionTimer = setTimeout(resolve, connectionGraceMs) })])
        } finally { clearTimeout(connectionTimer) }
        if (!drained) {
          console.warn(`[Runtime] ${connectionGraceMs}ms 안에 닫히지 않은 연결을 정리하고 종료합니다.`)
          server.closeAllConnections?.()
        }
        await closed
      })().finally(() => clearTimeout(diagnostic))
      return shutdown
    },
  }
}

export function installRuntimeShutdown(shutdown) {
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    const started = performance.now()
    void Promise.resolve().then(shutdown).then(() => {
      console.log(`[Runtime] graceful shutdown ${Math.round(performance.now() - started)}ms`)
      process.exit(0)
    }).catch((error) => {
      // 드레인이 실패해도 프로세스는 반드시 끝낸다. 여기서 남으면 감시자가 자식 종료를
      // 무제한 기다리므로 재시작 전체가 멈춘다. 저장은 이미 드레인 단계에서 기다린 뒤다.
      console.error('[Runtime shutdown failed]', error)
      process.exit(1)
    })
  }
  process.on('message', (message) => { if (message?.type === 'mnp:shutdown') stop() })
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // 감시자 자체가 비정상 종료되어도 서버만 남지 않도록 한다.
  if (process.connected) {
    process.on('disconnect', stop)
    process.send({ type: 'mnp:shutdown-ready' }, () => {})
  }
}
