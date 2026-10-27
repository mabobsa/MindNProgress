import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createApiDiagnostics, createDiagnosticWriter } from '../server/lib/apiDiagnostics.mjs'
import { startRequestTiming, stringifyTimedResponse } from '../server/lib/requestTiming.mjs'
import { createApiDiagnosticSummary, readApiDiagnosticSummary } from '../scripts/api-diagnostics.mjs'

function harness(url = '/api/maps/map-one?token=private') {
  let clock = 0
  const records = [], warnings = []
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false, setHeader() {} })
  const request = { method: 'GET', url, headers: { 'x-mnp-ai-conversation-id': 'conversation' } }
  const diagnostics = { emit: (value) => records.push({ at: new Date(clock).toISOString(), ...value }), begin() {}, end() {} }
  const timing = startRequestTiming(request, response, { diagnostics, now: () => clock,
    wallNow: () => new Date(clock).toISOString(), warn: (...args) => warnings.push(args) })
  return { timing, response, records, warnings, time: (value) => { clock = value } }
}

test('빠른 정상 API도 기록하고 기존 느린 요청 로그는 늘리지 않는다', () => {
  const h = harness()
  assert.equal(stringifyTimedResponse(h.response, { text: '공유 지식' }), '{"text":"공유 지식"}')
  h.time(12); h.timing.complete()
  h.response.writableFinished = true
  h.response.emit('finish'); h.response.emit('close')
  assert.deepEqual(h.records.map((r) => r.event), ['request-start', 'handler-end', 'response'])
  assert.equal(h.records[0].path, '/api/maps/map-one')
  assert.equal(h.records[0].source, 'mcp')
  assert.equal(h.records.at(-1).elapsedMs, 12)
  assert.equal(h.records.at(-1).responseChars, '{"text":"공유 지식"}'.length)
  assert.equal(h.warnings.length, 0)
})

test('대기 중 연결 종료 시 미완료 단계와 이후 서버 처리 종료를 각각 기록한다', async () => {
  const h = harness()
  let release
  const waiting = h.timing.measure('mutationWaitMs', () => new Promise((resolve) => { release = resolve }))
  h.time(30_000); h.response.emit('close')
  const closed = h.records.at(-1)
  assert.equal(closed.aborted, true)
  assert.deepEqual(closed.inFlightStages, { mutationWaitMs: 30_000 })
  assert.deepEqual(closed.stages, {})
  h.time(40_000); release(); await waiting
  h.timing.complete(); h.timing.complete()
  assert.equal(h.records.at(-1).event, 'handler-end')
  assert.equal(h.records.at(-1).stages.mutationWaitMs, 40_000)
  assert.deepEqual(closed.stages, {})
  const collector = createApiDiagnosticSummary()
  h.records.forEach(collector.add)
  const result = collector.finish().apis[0]
  assert.equal(result.calls, 1)
  assert.equal(result.aborted, 1)
  assert.equal(result.endedAfterDisconnect, 1)
  assert.equal(result.responseMs.max, 30_000)
  assert.equal(result.handlerMs.max, 40_000)
  assert.equal(result.stages.mutationWaitMs.samples, 1)
})

test('진단 실패는 처리 결과와 예외 전파를 바꾸지 않는다', async () => {
  const response = Object.assign(new EventEmitter(), { statusCode: 500, writableFinished: false, setHeader() {} })
  const fail = () => { throw new Error('진단 저장 실패') }
  const timing = startRequestTiming({ method: 'POST', url: '/api/maps', headers: {} }, response,
    { diagnostics: { emit: fail, begin: fail, end: fail }, warn: fail })
  await assert.rejects(timing.measure('readMapMs', async () => { throw new Error('원래 오류') }), /원래 오류/)
  assert.doesNotThrow(() => response.emit('close'))
  assert.doesNotThrow(() => timing.complete())
})

test('SSE는 제외하고 시작 토큰은 가리며 Runner 요청은 구분한다', () => {
  const events = harness('/api/events')
  events.timing.complete(); events.response.emit('close')
  assert.equal(events.records.length, 0)
  const launch = harness('/api/integrations/aionui/launches/secret-token/conversation?secret=1')
  assert.equal(launch.records[0].path, '/api/integrations/aionui/launches/:token/conversation')
  assert.equal(harness('/api/machines/macbook/runner/operations/claim').records[0].source, 'runner')
})

test('로그 저장은 일괄 비동기이고 버퍼 초과는 누락 표시로 남긴다', async () => {
  const writes = []
  const writer = createDiagnosticWriter({ file: 'unused', prepare: async () => {},
    append: async (_file, text) => writes.push(text), maxBufferedBytes: 80 })
  writer.record({ event: 'one' }); writer.record({ event: 'two' })
  writer.record({ event: 'oversize', value: 'x'.repeat(100) })
  assert.equal(writes.length, 0)
  await writer.flush()
  const records = writes[0].trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map((r) => r.event), ['one', 'two', 'diagnostic-loss'])
  assert.equal(records.at(-1).dropped, 1)
})

test('디스크 실패와 파일 제한은 요청을 막지 않고 불완전한 계측임을 표시한다', async () => {
  const writes = []
  let broken = true
  const writer = createDiagnosticWriter({ file: 'unused', prepare: async () => {}, warn() {},
    append: async (_file, text) => { if (broken) throw new Error('디스크 실패'); writes.push(text) } })
  writer.record({ event: 'one' }); await writer.flush()
  assert.equal(writer.stats().writeFailures, 1)
  broken = false; await writer.flush()
  assert.equal(JSON.parse(writes[0]).event, 'diagnostic-loss')
  const limited = createDiagnosticWriter({ file: 'unused', prepare: async () => {}, warn() {},
    append: async (_file, text) => writes.push(text), maxBytes: 10 })
  limited.record({ event: 'too-large' }); await limited.flush()
  limited.record({ event: 'again' }); await limited.flush()
  assert.equal(limited.stats().capped, true)
  assert.equal(JSON.parse(writes.at(-1)).event, 'truncated')
})

test('구간·경로별 집계와 처리 중 요청을 구분하며 누락된 단계를 0으로 오인하지 않는다', () => {
  const collector = createApiDiagnosticSummary({ from: '2026-10-27T01:00:00Z', to: '2026-10-27T01:01:00Z' })
  collector.add({ event: 'request-start', requestId: 'before', at: '2026-10-27T00:59:00Z', method: 'GET', path: '/api/maps/map-a', source: 'mcp' })
  for (const id of ['a', 'b']) collector.add({ event: 'request-start', requestId: id, at: '2026-10-27T01:00:10Z', method: 'GET', path: `/api/maps/map-${id}`, source: 'mcp' })
  collector.add({ event: 'response', requestId: 'a', at: '2026-10-27T01:00:11Z', elapsedMs: 1000, status: 200, aborted: false, stages: { readMapMs: 900 } })
  collector.add({ event: 'handler-end', requestId: 'a', at: '2026-10-27T01:00:11Z', elapsedMs: 1000, stages: { readMapMs: 900 } })
  const result = collector.finish()
  assert.equal(result.requestCount, 2)
  assert.equal(result.apis.length, 1)
  assert.equal(result.apis[0].pendingHandlers, 1)
  assert.equal(result.apis[0].responseMs.samples, 1)
  assert.equal(result.apis[0].stages.readMapMs.samples, 1)
  assert.equal(result.apis[0].stages.mutationWaitMs, undefined)
  assert.equal(result.warnings.length, 1)
})

test('실제 HTTP 응답과 서버 종료 후 진단 파일을 집계한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-api-diagnostics-'))
  const diagnostics = createApiDiagnostics(directory)
  const server = createServer(async (request, response) => {
    const timing = startRequestTiming(request, response, { diagnostics, warn() {} })
    try {
      await timing.measure('readMapMs', async () => {})
      response.setHeader('Content-Type', 'application/json')
      response.end(stringifyTimedResponse(response, { ok: true, text: '공유 지식' }))
    } finally { timing.complete() }
  })
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/maps/map-one`)
    assert.ok(response.headers.get('X-MNP-Request-Id'))
    assert.deepEqual(await response.json(), { ok: true, text: '공유 지식' })
    await new Promise((resolve) => server.close(resolve))
    await diagnostics.close()
    const report = await readApiDiagnosticSummary(directory)
    assert.equal(report.requestCount, 1)
    assert.equal(report.apis[0].route, 'GET /api/maps/:mapId')
    assert.equal(report.apis[0].missingResponses, 0)
    assert.equal(report.apis[0].pendingHandlers, 0)
    assert.equal(report.server.samples, 1)
    assert.equal((await readFile(diagnostics.file, 'utf8')).includes('공유 지식'), false)
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
    await diagnostics.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('측정 시작·종료 명령이 실제 요청을 구간 보고서로 저장한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-api-window-'))
  const diagnostics = createApiDiagnostics(directory)
  const script = fileURLToPath(new URL('../scripts/api-diagnostics.mjs', import.meta.url))
  const invoke = (args) => promisify(execFile)(process.execPath, [script, ...args], {
    windowsHide: true, env: { ...process.env, MNP_MCP_USAGE_DIR: path.join(directory, 'usage') }, timeout: 15_000,
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const begin = await invoke(['begin', '--directory', directory])
    const runFile = begin.stdout.match(/구간 파일: (.+)/)?.[1].trim()
    assert.ok(runFile)
    const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false, setHeader() {} })
    const timing = startRequestTiming({ method: 'GET', url: '/api/maps/map-window', headers: {} }, response, { diagnostics })
    response.writableFinished = true; response.emit('finish'); timing.complete()
    await invoke(['end', '--run', runFile])
    const report = JSON.parse(await readFile(runFile.replace(/\.json$/, '.report.json'), 'utf8'))
    assert.equal(report.requestCount, 1)
    assert.equal(report.apis[0].route, 'GET /api/maps/:mapId')
    assert.deepEqual(report.mcpTools, [])
    await assert.rejects(invoke(['end', '--run', runFile]), /이미 종료한 측정 구간/)
    await diagnostics.close()
    await assert.rejects(invoke(['begin', '--directory', directory]), /진단 세션이 종료/)
  } finally {
    await diagnostics.close()
    await rm(directory, { recursive: true, force: true })
  }
})
