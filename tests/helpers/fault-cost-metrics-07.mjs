// 장애 시험에서는 background 동작을 바꾸지 않고 프로세스 비용과 제품 진단만 관측한다.
import { channel } from 'node:diagnostics_channel'

if (process.send) {
  let enabled = false, diagnostics = [], cpu = process.cpuUsage(), started = performance.now(), peak = 0
  const sample = () => { if (enabled) peak = Math.max(peak, process.memoryUsage().rss) }
  setInterval(sample, 10).unref()
  channel('mindnprogress.storage.diagnostic').subscribe(event => { if (enabled) diagnostics.push(event) })
  process.on('message', message => {
    if (message?.action !== 'read-metrics') return
    sample()
    const usage = process.cpuUsage(cpu)
    const value = { cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000,
      rssPeakBytes: peak, elapsedMs: performance.now() - started, storageDiagnostics: diagnostics }
    if (message.reset) { enabled = true; diagnostics = []; cpu = process.cpuUsage(); started = performance.now(); peak = process.memoryUsage().rss }
    process.send({ id: message.id, phase: 'read-metrics', value })
  })
}
