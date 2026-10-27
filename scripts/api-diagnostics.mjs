#!/usr/bin/env node
// 임시 계측의 구간 지정·집계. 본문·토큰을 수집하거나 업무 API를 호출하지 않는다.
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { readToolUsageTotals } from '../server/lib/mcpToolUsage.mjs'
import { loadLocalEnvironment } from './local-environment.mjs'

export function diagnosticRoute(value) {
  return value.replace(/^(\/api\/maps)\/[^/]+/, '$1/:mapId')
    .replace(/(\/cards)\/[^/]+/g, '$1/:cardId')
    .replace(/^(\/api\/ai-workspaces)\/[^/]+/, '$1/:leaseId')
    .replace(/(\/ai-conversations|\/conversations|\/leases)\/[^/]+/g, '$1/:id')
    .replace(/^(\/api\/machines)\/[^/]+/, '$1/:machineId')
    .replace(/(\/ai-delegations)\/(?!complete(?:\/|$))[^/]+/g, '$1/:delegationId')
    .replace(/(\/launches)\/[^/]+/g, '$1/:token')
}

const rounded = (value) => Math.round(value * 10) / 10
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return { samples: sorted.length, total: rounded(total), mean: sorted.length ? rounded(total / sorted.length) : null,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null, max: sorted.at(-1) ?? null }
}

export function createApiDiagnosticSummary({ from, to } = {}) {
  const lower = from ? Date.parse(from) : -Infinity, upper = to ? Date.parse(to) : Infinity
  if (Number.isNaN(lower) || Number.isNaN(upper) || lower > upper) throw new Error('측정 시작·종료 시각을 확인하세요.')
  const requests = new Map(), samples = [], warnings = new Set()
  return {
    add(event) {
      const time = Date.parse(event.startedAt ?? event.at)
      if (time >= lower && time <= upper && (event.event === 'truncated' || event.dropped > 0 || event.writeFailures > 0 || event.untracked > 0)) {
        warnings.add('로그의 용량 제한·저장 실패·버퍼 또는 추적 제한 기록이 있습니다. 누락 가능성을 확인하세요.')
      }
      if (event.event === 'request-start' && time >= lower && time <= upper) requests.set(event.requestId, { start: event })
      else if (event.event === 'sample' && time >= lower && time <= upper) samples.push(event)
      else if (requests.has(event.requestId) && ['response', 'handler-end'].includes(event.event)) {
        requests.get(event.requestId)[event.event] = event
      }
    },
    finish() {
      const groups = new Map()
      for (const entry of requests.values()) {
        const { start, response, 'handler-end': end } = entry
        const route = `${start.method} ${diagnosticRoute(start.path)}`
        const key = `${start.source} ${route}`
        const group = groups.get(key) ?? { source: start.source, route, calls: 0, aborted: 0, httpErrors: 0,
          missingResponses: 0, pendingHandlers: 0, endedAfterDisconnect: 0, responseChars: 0,
          responseTimes: [], handlerTimes: [], stages: {}, interruptedStages: {} }
        group.calls++
        if (response) {
          group.responseTimes.push(response.elapsedMs)
          if (response.aborted) group.aborted++
          if (!response.aborted && response.status >= 400) group.httpErrors++
          if (response.aborted && end && Date.parse(end.at) >= Date.parse(response.at)) group.endedAfterDisconnect++
          if (response.aborted) for (const name of Object.keys(response.inFlightStages ?? {})) {
            group.interruptedStages[name] = (group.interruptedStages[name] ?? 0) + 1
          }
        } else group.missingResponses++
        if (end) group.handlerTimes.push(end.elapsedMs)
        else group.pendingHandlers++
        group.responseChars += end?.responseChars ?? response?.responseChars ?? 0
        for (const [name, duration] of Object.entries((end ?? response)?.stages ?? {})) {
          (group.stages[name] ??= []).push(duration)
        }
        groups.set(key, group)
      }
      const apis = [...groups.values()].map(({ responseTimes, handlerTimes, stages, ...group }) => ({ ...group,
        responseMs: distribution(responseTimes), handlerMs: distribution(handlerTimes),
        stages: Object.fromEntries(Object.entries(stages).map(([name, values]) => [name, distribution(values)])) }))
        .sort((a, b) => b.responseMs.total - a.responseMs.total)
      if (apis.some((row) => row.pendingHandlers || row.missingResponses)) warnings.add('측정 구간에 시작했으나 응답 또는 서버 처리 종료가 확인되지 않은 요청이 있습니다.')
      return { from: from ?? null, to: to ?? null, requestCount: requests.size, apis, warnings: [...warnings],
        server: { samples: samples.length, cpuPercent: distribution(samples.map((s) => s.cpuPercent)),
          eventLoopMaxMs: distribution(samples.map((s) => s.eventLoopMaxMs)),
          peakActiveHandlers: Math.max(0, ...samples.map((s) => s.activeHandlers)),
          peakRssBytes: Math.max(0, ...samples.map((s) => s.rssBytes)),
          peakHeapUsedBytes: Math.max(0, ...samples.map((s) => s.heapUsedBytes)),
          snapshots: samples },
        notes: ['처리 시간 합계는 병렬 요청의 합산이며 실제 작업 경과 시간이나 API별 CPU 사용 시간이 아닙니다.',
          'aborted는 응답 완료 전 연결 종료입니다. 호출 측 타임아웃과 사용자 취소를 단독으로 구분하지 못합니다.',
          '응답 문자 수는 서버가 생성한 JSON 길이이며 실제 전송 완료 바이트가 아닙니다. SSE는 제외합니다.',
          '잠금 보유자는 계측하지 않습니다. 기록된 단계 밖의 내부 대기열·파일·외부 호출은 처리 시간에 포함됩니다.'] }
    },
  }
}

export async function readApiDiagnosticSummary(directory, options = {}) {
  const collector = createApiDiagnosticSummary(options)
  const files = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()
  let invalidLines = 0
  for (const file of files) {
    const input = createReadStream(path.join(directory, file), { encoding: 'utf8' })
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      try { collector.add(JSON.parse(line)) } catch { invalidLines++ }
    }
  }
  const result = collector.finish()
  if (invalidLines) result.warnings.push(`읽지 못한 로그 ${invalidLines}행이 있습니다. 저장 중이면 잠시 후 다시 집계하세요.`)
  return result
}

function printReport(report) {
  console.log(`측정 구간: ${report.from ?? '전체'} ~ ${report.to ?? '현재'} / 요청 ${report.requestCount}회`)
  console.table(report.apis.map((row) => ({ 구분: row.source, API: row.route, 호출: row.calls,
    평균ms: row.responseMs.mean, P95ms: row.responseMs.p95, 최대ms: row.responseMs.max,
    연결종료: row.aborted, HTTP오류: row.httpErrors, 처리중: row.pendingHandlers, 응답문자: row.responseChars })))
  console.log(`서버 표본 ${report.server.samples}개 / 최대 처리 중 ${report.server.peakActiveHandlers}개 / 이벤트 루프 최대 지연 ${report.server.eventLoopMaxMs.max ?? '-'}ms`)
  for (const warning of report.warnings) console.log(`주의: ${warning}`)
  for (const note of report.notes) console.log(note)
}

async function main() {
  loadLocalEnvironment()
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const data = path.resolve(process.env.MNP_DATA_DIR?.trim() || path.join(root, 'server', 'data'))
  const args = process.argv.slice(2), command = args[0] ?? 'report'
  const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  const directory = path.resolve(option('--directory') || path.join(data, '_api-diagnostics'))
  const usage = () => readToolUsageTotals(path.resolve(process.env.MNP_MCP_USAGE_DIR?.trim() || path.join(data, '_mcp-tool-usage')))
  if (command === 'begin') {
    const files = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.jsonl'))
    const modified = await Promise.all(files.map(async (name) => ({ name, ...await stat(path.join(directory, name)) })))
    const latest = modified.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (!latest || Date.now() - latest.mtimeMs > 15_000) throw new Error('갱신 중인 API 진단 로그가 없습니다. 계측 코드가 적용된 MnP 서버의 실행 상태를 먼저 확인하세요.')
    const handle = await open(path.join(directory, latest.name), 'r')
    let tail
    try {
      const bytes = Buffer.alloc(Math.min(latest.size, 8192))
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, Math.max(0, latest.size - bytes.length))
      tail = bytes.subarray(0, bytesRead).toString('utf8').trim().split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
    } finally { await handle.close() }
    if (tail.some((event) => ['truncated', 'session-end'].includes(event.event))) throw new Error('최근 진단 세션이 종료되었거나 파일 용량 제한에 도달했습니다. 실행 상태를 확인하세요.')
    const mcpBefore = await usage()
    const from = new Date().toISOString()
    const file = path.join(directory, `run-${from.replace(/[:.]/g, '-')}.json`)
    await mkdir(directory, { recursive: true })
    await writeFile(file, `${JSON.stringify({ from, directory, mcpBefore }, null, 2)}\n`, 'utf8')
    console.log(`측정 시작: ${from}\n구간 파일: ${file}`)
    return
  }
  if (command === 'end') {
    const file = path.resolve(option('--run') || '')
    if (!option('--run')) throw new Error('begin에서 출력한 구간 파일을 --run으로 지정하세요.')
    const run = JSON.parse(await readFile(file, 'utf8'))
    if (run.to) throw new Error('이미 종료한 측정 구간입니다. 저장된 보고서를 확인하세요.')
    const to = new Date().toISOString()
    // API 로그는 1초, 기존 MCP 통계는 기본 2초 간격으로 저장된다.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const after = await usage()
    const report = await readApiDiagnosticSummary(run.directory, { from: run.from, to })
    const before = new Map(run.mcpBefore.tools.map((tool) => [tool.name, tool]))
    report.mcpTools = after.tools.map((tool) => ({ name: tool.name,
      calls: tool.calls - (before.get(tool.name)?.calls ?? 0), fail: tool.fail - (before.get(tool.name)?.fail ?? 0),
      chars: tool.chars - (before.get(tool.name)?.chars ?? 0) })).filter((tool) => tool.calls || tool.chars)
    if (report.mcpTools.some((tool) => tool.calls < 0 || tool.fail < 0 || tool.chars < 0)) report.warnings.push('측정 중 MCP 통계 파일이 제거되었거나 초기화되어 도구 사용량 차이가 유효하지 않습니다.')
    await writeFile(file, `${JSON.stringify({ ...run, to }, null, 2)}\n`, 'utf8')
    const reportFile = file.replace(/\.json$/, '.report.json')
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    printReport(report)
    console.table(report.mcpTools)
    console.log(`상세 보고서: ${reportFile}`)
    return
  }
  if (command !== 'report') throw new Error('begin, end, report 중 하나를 지정하세요.')
  const report = await readApiDiagnosticSummary(directory, { from: option('--from'), to: option('--to') })
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
