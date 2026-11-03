import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AI_USAGE_GUIDE, buildAiUsageResult } from '../mcp/aiUsage.mjs'
import { normalizeAionUiSubscriptionUsage } from '../server/lib/aionUiSubscriptionUsage.mjs'

const now = Date.parse('2026-10-21T10:00:00.000Z')
function snapshot() {
  return {
    schemaVersion: 1, state: 'ready', generatedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    claude: {
      state: 'ready', updatedAt: new Date(now - 60_000).toISOString(),
      session: { usedPercent: 0, resetsAt: '2026-10-21T12:00:00.000Z' },
      weekly: { usedPercent: 23.5, resetsAt: null },
    },
    codex: {
      state: 'ready', updatedAt: new Date(now - 30_000).toISOString(),
      weekly: { usedPercent: 93, resetsAt: '2026-10-27T06:38:23.000Z', windowDurationMins: 10080 },
      limitReached: false,
    },
  }
}

test('구독 사용량과 참고 잔여율을 제공자별로 반환하고 계정 일치를 추측하지 않는다', () => {
  const usage = normalizeAionUiSubscriptionUsage(snapshot(), { now })
  const result = buildAiUsageResult(usage, { now })
  assert.equal(result.source.machineScope, 'mnp-server')
  assert.equal(result.source.conversationAccountMatch, 'unverified')
  assert.equal(result.queriedAt, new Date(now).toISOString())
  assert.equal(result.providers.claude.session.usedPercent, 0)
  assert.equal(result.providers.claude.session.remainingPercent, 100)
  assert.equal(result.providers.claude.weekly.remainingPercent, 76.5)
  assert.equal(result.providers.codex.weekly.remainingPercent, 7)
  assert.equal(result.providers.codex.weekly.windowDurationMins, 10080)
  assert.equal(result.providers.codex.ageSeconds, 30)
  assert.equal(result.providers.codex.usable, true)
  assert.equal(result.providers.codex.limitReached, false)
})

test('전체 스냅샷이 ready여도 오래된 제공자만 현재 판단에 사용할 수 없게 표시한다', () => {
  const raw = snapshot()
  raw.claude.updatedAt = new Date(now - 181_000).toISOString()
  const result = buildAiUsageResult(normalizeAionUiSubscriptionUsage(raw, { now }), { now })
  assert.equal(result.snapshot.state, 'ready')
  assert.equal(result.providers.claude.stale, true)
  assert.equal(result.providers.claude.usable, false)
  assert.equal(result.providers.claude.weekly.usedPercent, 23.5)
  assert.equal(result.providers.codex.stale, false)
  assert.equal(result.providers.codex.usable, true)
})

test('provider 필터와 부분 로딩에서도 확인된 제공자 정보는 유지한다', () => {
  const raw = snapshot()
  raw.state = 'partial'
  raw.claude = { state: 'loading', updatedAt: null, session: null, weekly: null }
  const usage = normalizeAionUiSubscriptionUsage(raw, { now })
  const selected = buildAiUsageResult(usage, { provider: 'codex', now })
  assert.deepEqual(Object.keys(selected.providers), ['codex'])
  assert.equal(selected.providers.codex.usable, true)
  const loading = buildAiUsageResult(usage, { provider: 'claude', now })
  assert.equal(loading.providers.claude.state, 'loading')
  assert.equal(loading.providers.claude.usable, false)
  assert.equal(loading.providers.claude.ageSeconds, null)
  assert.equal(loading.providers.claude.session, null)
})

test('미확인 사용률과 한도 상태를 0 또는 여유 있음으로 변환하지 않는다', () => {
  const result = buildAiUsageResult(normalizeAionUiSubscriptionUsage(null, { now }), { now })
  assert.equal(result.snapshot.available, false)
  assert.equal(result.providers.claude.usable, false)
  assert.equal(result.providers.claude.session, null)
  assert.equal(result.providers.codex.weekly, null)
  assert.equal(result.providers.codex.limitReached, null)
  const raw = snapshot()
  raw.codex.weekly.usedPercent = null
  const invalid = buildAiUsageResult(normalizeAionUiSubscriptionUsage(raw, { now }), { now })
  assert.equal(invalid.providers.codex.weekly, null)
  assert.equal(invalid.providers.codex.usable, false)
})

test('실제 MCP 호출은 기존 API를 GET 한 번으로 조회하고 가이드와 필터를 제공한다', { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-ai-usage-test-'))
  const tokenFile = path.join(directory, 'token')
  await writeFile(tokenFile, 'test-usage-token-with-at-least-32-characters')
  t.after(async () => { await rm(tokenFile, { force: true }); await rmdir(directory) })
  const requests = []
  let responseStatus = 200
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url })
    response.writeHead(responseStatus, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(responseStatus === 200
      ? { usage: normalizeAionUiSubscriptionUsage(snapshot(), { now }) }
      : { error: '사용량 조회 권한이 없습니다.' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const client = new Client({ name: 'ai-usage-test', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dirname, '../mcp/server.mjs')],
    env: { ...process.env, MNP_API_URL: `http://127.0.0.1:${server.address().port}`, MNP_TOKEN_FILE: tokenFile, MNP_MCP_USAGE_DISABLED: '1' },
    stderr: 'pipe',
  }))
  const guide = JSON.parse((await client.callTool({ name: 'mindnprogress_read_me_first', arguments: {} })).content[0].text)
  assert.deepEqual(guide.guide.aiUsage, AI_USAGE_GUIDE)
  assert.equal(requests.length, 0)
  const tools = (await client.listTools()).tools
  assert.ok(tools.some(({ name }) => name === 'mindnprogress_get_ai_usage'))
  for (const provider of ['all', 'claude', 'codex']) {
    const response = await client.callTool({ name: 'mindnprogress_get_ai_usage', arguments: provider === 'all' ? {} : { provider } })
    assert.notEqual(response.isError, true)
    const result = JSON.parse(response.content[0].text)
    assert.deepEqual(Object.keys(result.providers), provider === 'all' ? ['claude', 'codex'] : [provider])
  }
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ({ method: 'GET', path: '/api/integrations/aionui/subscription-usage' })))
  const invalid = await client.callTool({ name: 'mindnprogress_get_ai_usage', arguments: { provider: 'unknown' } })
  assert.equal(invalid.isError, true)
  assert.equal(requests.length, 3)
  responseStatus = 403
  const denied = await client.callTool({ name: 'mindnprogress_get_ai_usage', arguments: {} })
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /사용량 조회 권한/)
})

test('Codex 5시간 창은 Claude session과 같은 형식으로 주고 없거나 null이면 null이다', () => {
  const raw = snapshot()
  raw.codex.session = { usedPercent: 49, resetsAt: '2026-10-21T13:00:00.000Z', windowDurationMins: 300 }
  raw.codex.limitReached = false
  const result = buildAiUsageResult(normalizeAionUiSubscriptionUsage(raw, { now }), { now })
  assert.deepEqual(result.providers.codex.session, { usedPercent: 49, remainingPercent: 51, resetsAt: '2026-10-21T13:00:00.000Z', windowDurationMins: 300 })
  assert.equal(result.providers.codex.weekly.usedPercent, 93)
  assert.equal(result.providers.codex.usable, true)
  assert.deepEqual(Object.keys(result.providers.codex), Object.keys(result.providers.claude).concat('limitReached'))

  // 한도 도달은 AionUi가 두 창을 함께 판정한 값을 그대로 쓴다.
  raw.codex.session.usedPercent = 100
  raw.codex.limitReached = true
  assert.equal(buildAiUsageResult(normalizeAionUiSubscriptionUsage(raw, { now }), { now }).providers.codex.limitReached, true)

  // 키가 없는 이전 스냅숏과 5시간 창이 없는 스냅숏은 같은 결과이며, session 외의 Codex 값은 그대로다.
  const missing = buildAiUsageResult(normalizeAionUiSubscriptionUsage(snapshot(), { now }), { now })
  const nullRaw = snapshot()
  nullRaw.codex.session = null
  assert.deepEqual(buildAiUsageResult(normalizeAionUiSubscriptionUsage(nullRaw, { now }), { now }), missing)
  assert.equal(missing.providers.codex.session, null)
  const { session: _session, ...codexWithoutSession } = missing.providers.codex
  assert.deepEqual(codexWithoutSession, { state: 'ready', usable: true, stale: false, updatedAt: new Date(now - 30_000).toISOString(), ageSeconds: 30,
    weekly: { usedPercent: 93, remainingPercent: 7, resetsAt: '2026-10-27T06:38:23.000Z', windowDurationMins: 10080 }, limitReached: false })

  // Claude와 같이 두 창 중 하나라도 확인되면 사용할 수 있다.
  const sessionOnly = snapshot()
  sessionOnly.codex.weekly = null
  sessionOnly.codex.session = { usedPercent: 12, resetsAt: null, windowDurationMins: 300 }
  assert.equal(buildAiUsageResult(normalizeAionUiSubscriptionUsage(sessionOnly, { now }), { now }).providers.codex.usable, true)
  sessionOnly.codex.session = null
  assert.equal(buildAiUsageResult(normalizeAionUiSubscriptionUsage(sessionOnly, { now }), { now }).providers.codex.usable, false)
})
