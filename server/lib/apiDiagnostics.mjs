// 임시 API 계측: 요청 처리는 로그 저장을 기다리지 않는다. 측정 후 별도 커밋을 되돌린다.
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

export function createDiagnosticWriter({ file, append = appendFile, prepare = () => mkdir(path.dirname(file), { recursive: true }),
  maxBytes = 64 * 1024 * 1024, maxBufferedBytes = 1024 * 1024, warn = console.warn } = {}) {
  let buffer = [], bufferedBytes = 0, acceptedBytes = 0, writing = null, prepared = false
  let dropped = 0, writeFailures = 0, capped = false, reportedDropped = 0
  const stats = () => ({ dropped, writeFailures, capped })
  const warning = (message) => { try { warn(`[API diagnostics] ${message}`) } catch { /* 진단 오류를 요청에 전파하지 않는다. */ } }
  function record(value) {
    try {
      if (capped) { dropped++; return }
      const line = `${JSON.stringify(value)}\n`
      const size = Buffer.byteLength(line)
      if (acceptedBytes + size > maxBytes) {
        capped = true; dropped++
        const marker = `${JSON.stringify({ event: 'truncated', at: new Date().toISOString(), reason: 'file-limit', ...stats() })}\n`
        buffer.push(marker); bufferedBytes += Buffer.byteLength(marker)
        warning('파일 용량 제한에 도달했습니다. 이 파일의 측정 결과는 불완전합니다.')
        return
      }
      if (bufferedBytes + size > maxBufferedBytes) { dropped++; return }
      buffer.push(line); bufferedBytes += size; acceptedBytes += size
    } catch { dropped++ }
  }
  async function flush() {
    if (writing) { await writing; return flush() }
    if (!buffer.length && (capped || dropped === reportedDropped)) return
    const count = buffer.length
    const loss = !capped && dropped > reportedDropped
      ? `${JSON.stringify({ event: 'diagnostic-loss', at: new Date().toISOString(), ...stats() })}\n` : ''
    const text = buffer.join('') + loss
    const observedDropped = dropped
    buffer = []; bufferedBytes = 0
    writing = (async () => {
      try {
        if (!prepared) { await prepare(); prepared = true }
        await append(file, text, 'utf8')
        reportedDropped = observedDropped
      } catch {
        dropped += count; writeFailures++
        if (writeFailures === 1) warning('로그 저장에 실패했습니다. 요청 처리는 계속하지만 측정 결과가 누락될 수 있습니다.')
      }
    })()
    try { await writing } finally { writing = null }
  }
  return { record, flush, stats }
}

export function createApiDiagnostics(directory) {
  const startedAt = new Date().toISOString()
  const file = path.join(directory, `api-${startedAt.replace(/[:.]/g, '-')}-${process.pid}.jsonl`)
  const writer = createDiagnosticWriter({ file })
  const active = new Map()
  let untracked = 0, closing = null
  const emit = (value) => writer.record({ schemaVersion: 1, pid: process.pid, at: new Date().toISOString(), ...value })
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  let previousCpu = process.cpuUsage(), previousAt = performance.now()
  function sample() {
    const currentAt = performance.now(), cpu = process.cpuUsage(), memory = process.memoryUsage()
    const activeStages = {}
    const oldest = []
    for (const [requestId, entry] of active) {
      const state = entry.snapshot()
      for (const name of Object.keys(state.inFlightStages)) activeStages[name] = (activeStages[name] ?? 0) + 1
      oldest.push({ requestId, method: entry.method, path: entry.path, ...state })
    }
    oldest.sort((a, b) => b.elapsedMs - a.elapsedMs)
    emit({ event: 'sample', intervalMs: Math.round(currentAt - previousAt),
      cpuPercent: Math.round(((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / Math.max(1, currentAt - previousAt)) / 10,
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
      eventLoopP95Ms: Math.round(delay.percentile(95) / 1e6), eventLoopMaxMs: Math.round(delay.max / 1e6),
      activeHandlers: active.size, untracked, activeStages, oldest: oldest.slice(0, 5), ...writer.stats() })
    previousAt = currentAt; previousCpu = cpu; delay.reset()
  }
  emit({ event: 'session-start', startedAt, limits: { fileBytes: 64 * 1024 * 1024, bufferBytes: 1024 * 1024 } })
  const flushTimer = setInterval(() => { void writer.flush() }, 1000)
  const sampleTimer = setInterval(sample, 5000)
  flushTimer.unref(); sampleTimer.unref()
  return {
    file, emit,
    begin(requestId, entry) {
      if (active.size < 10_000) active.set(requestId, entry)
      else untracked++
    },
    end(requestId) { active.delete(requestId) },
    close() {
      closing ??= (async () => {
        clearInterval(flushTimer); clearInterval(sampleTimer)
        sample(); delay.disable()
        emit({ event: 'session-end', ...writer.stats() })
        await writer.flush()
      })()
      return closing
    },
  }
}
