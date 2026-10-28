// 07 비교 프로세스에만 주입한다. 두 버전의 같은 FS 비용과 기존 06 읽기 계측을 재사용한다.
import './read-cost-metrics.mjs'
import fs from 'node:fs/promises'
import http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { channel } from 'node:diagnostics_channel'

if (process.send) {
  const context = new AsyncLocalStorage()
  let requests = [], diagnostics = [], enabled = false
  const send = process.send.bind(process)
  process.send = (message, ...args) => {
    if (message?.phase === 'read-metrics') message.value = { ...message.value, requests, storageDiagnostics: diagnostics }
    return send(message, ...args)
  }
  process.on('message', (message) => {
    if (message?.action === 'read-metrics' && message.reset) { requests = []; diagnostics = []; enabled = true }
  })
  channel('mindnprogress.storage.diagnostic').subscribe((event) => { if (enabled) diagnostics.push(event) })
  const create = http.createServer
  http.createServer = function (...args) {
    const i = args.findIndex((v) => typeof v === 'function'), handler = args[i]
    if (i >= 0) args[i] = (request, response) => {
      const state = { requestId: request.headers['idempotency-key'] ?? null, method: request.method, route: request.url,
        queueWaitMs: 0, lockHoldMs: 0, persistMs: 0, externalWaitMs: 0, fsCalls: 0 }
      const start = performance.now()
      response.once('finish', () => { if (enabled) requests.push({ ...state, status: response.statusCode, elapsedMs: performance.now() - start }) })
      return context.run(state, () => handler(request, response))
    }
    return create.apply(this, args)
  }
  for (const method of ['writeFile', 'rename', 'rm']) {
    const original = fs[method]
    fs[method] = async (...args) => {
      const state = context.getStore(), start = performance.now()
      try { return await original(...args) } finally { if (state) { state.persistMs += performance.now() - start; state.fsCalls++ } }
    }
  }
  globalThis.__mnpIntegrationMetrics = { async acquire(operation) {
    const state = context.getStore(), start = performance.now(), release = await operation(), held = performance.now()
    if (state) state.queueWaitMs += held - start
    return () => { if (state) state.lockHoldMs += performance.now() - held; return release() }
  } }
  registerHooks({ load(url, ctx, next) {
    const result = next(url, ctx)
    if (!url.endsWith('/server/index.mjs')) return result
    const marker = "releaseDocumentMutation = await requestTiming.measure('mutationWaitMs', () => acquireDocumentMutation(isTransition))"
    const source = String(result.source)
    return { ...result, source: source.replace(marker, "releaseDocumentMutation = await globalThis.__mnpIntegrationMetrics.acquire(() => requestTiming.measure('mutationWaitMs', () => acquireDocumentMutation(isTransition)))") }
  } })
  syncBuiltinESMExports()
}
