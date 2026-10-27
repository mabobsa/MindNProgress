import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { newStorageRequestId } from '../server/lib/storageJournal.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'

test('실제 MCP의 유한 재시도는 동일 ID·최초 본문·기한을 유지하고 충돌·인증은 반복하지 않는다', { timeout: 90000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), mapId = api.ids[0]
  let mode = '', remaining = 0, conflict = false
  const writes = []
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const writing = !['GET', 'HEAD'].includes(request.method) && !request.headers['x-mnp-result-only']
      if (writing) writes.push({ id: request.headers['idempotency-key'], body: bytes.toString(), at: performance.now(), deadline: request.headers['x-mnp-deadline-at'] })
      if (writing && remaining-- > 0 && mode !== 'drop') {
        if (conflict) {
          conflict = false
          const before = (await api.call(`/api/maps/${mapId}`)).body.map, next = structuredClone(before)
          next.nodes.find((node) => node.id === 'card-3').data.label = '경쟁 변경'
          const result = await api.call(`/api/maps/${mapId}/content-patch`, 'PATCH', { baseVersion: before.version, patch: createMapContentPatch(before, next) })
          assert.equal(result.status, 200, JSON.stringify(result))
        }
        const code = mode === 'auth' ? 'REQUEST_FORBIDDEN' : mode === 'format' ? 'CONTENT_PRECONDITION_REQUIRED' : 'WRITE_QUEUE_FULL'
        response.writeHead(mode === 'auth' ? 403 : mode === 'format' ? 400 : 503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ code, reasonCode: code, outcome: 'not-applied', retryable: mode === 'queue', retryAfterMs: 250 }))
        return
      }
      const upstream = await fetch(api.base + request.url, { method: request.method, headers: request.headers, ...(bytes.length ? { body: bytes } : {}) })
      const text = await upstream.text()
      if (writing && mode === 'drop' && remaining >= 0) { response.destroy(); return }
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(text)
    } catch { response.destroy() }
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const client = new Client({ name: 'budget-05', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'),
    env: { ...api.env, MNP_API_URL: `http://127.0.0.1:${proxy.address().port}` }, stderr: 'pipe' })
  t.after(async () => { await client.close(); await new Promise((resolve) => proxy.close(resolve)) })
  await client.connect(transport)
  const invoke = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    return JSON.parse(result.content.find((c) => c.type === 'text').text)
  }
  await invoke('mindnprogress_get_context', { mapId, cardId: 'card-1', editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' })
  const update = (cardId) => ({ requestId: newStorageRequestId(), mapId, cardId, data: { label: '유한 재시도' }, responseMode: 'affected' })
  const assertAttempts = (id, count) => {
    const attempts = writes.filter((w) => w.id === id)
    assert.equal(attempts.length, count)
    assert.equal(new Set(attempts.map((w) => w.body)).size, 1)
    assert.equal(new Set(attempts.map((w) => w.deadline)).size, 1)
    assert.ok(Number(attempts[0].deadline) > 0)
    for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i].at - attempts[i - 1].at >= (mode === 'drop' ? 75 : 250))
    return attempts
  }
  mode = 'queue'; remaining = 2
  const success = update('card-1')
  assert.equal((await invoke('mindnprogress_update_card', success)).outcome, 'committed')
  assertAttempts(success.requestId, 3)
  mode = 'queue'; remaining = 10
  const capped = update('card-2')
  assert.equal((await invoke('mindnprogress_update_card', capped)).reasonCode, 'WRITE_QUEUE_FULL')
  assertAttempts(capped.requestId, 3)
  remaining = 0
  assert.equal((await invoke('mindnprogress_update_card', capped)).outcome, 'committed')
  assert.equal(writes.filter((w) => w.id === capped.requestId).length, 4)
  mode = 'queue'; remaining = 1; conflict = true
  const stale = update('card-3')
  assert.equal((await invoke('mindnprogress_update_card', stale)).reasonCode, 'FIELD_CONFLICT')
  assertAttempts(stale.requestId, 2)
  for (const errorMode of ['auth', 'format']) {
    mode = errorMode; remaining = 10
    const input = update('card-4')
    const result = await invoke('mindnprogress_update_card', input)
    assert.equal(result.reasonCode, errorMode === 'auth' ? 'REQUEST_FORBIDDEN' : 'CONTENT_PRECONDITION_REQUIRED')
    assertAttempts(input.requestId, 1)
  }
  mode = 'drop'; remaining = 1
  const id = newStorageRequestId()
  const result = await invoke('mindnprogress_manage_comment', { requestId: id, mapId, operation: { action: 'add', cardId: 'card-1', summary: '[진행] 유실 재시도 확인' } })
  assert.equal(result.outcome, 'committed'); assertAttempts(id, 2)
  assert.equal((await api.read(`_comments/${mapId}.json`)).length, 1)
  t.diagnostic(JSON.stringify({ queueAttempts: 3, minimumDelayMs: 250, conflictAttempts: 2, authAttempts: 1, formatAttempts: 1, droppedResponseAttempts: 2 }))
})
