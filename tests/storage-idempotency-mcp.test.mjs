import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { newStorageRequestId } from '../server/lib/storageJournal.mjs'

test('실제 stdio MCP는 동시 재전송·응답 유실·프로세스 재접속에 같은 ID와 최초 의도를 유지한다', { timeout: 90_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), mapId = api.ids[0]
  let drop = 0, suppress = 0
  const writes = []
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const writing = !['GET', 'HEAD'].includes(request.method)
      if (writing) writes.push({ body: body.toString(), id: request.headers['idempotency-key'] })
      if (writing && suppress > 0) { suppress--; response.destroy(); return }
      const upstream = await fetch(api.base + request.url, { method: request.method, headers: request.headers, ...(body.length ? { body } : {}) })
      const text = await upstream.text()
      if (writing && drop > 0) { drop--; response.destroy(); return }
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(text)
    } catch { response.destroy() }
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  let client
  const connect = async () => {
    client = new Client({ name: 'storage-idempotency-test', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
      cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'),
      env: { ...api.env, MNP_API_URL: `http://127.0.0.1:${proxy.address().port}` }, stderr: 'pipe' })
    await client.connect(transport)
    await invoke('mindnprogress_get_context', { mapId, cardId: 'card-1', editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' })
  }
  const invoke = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    const text = result.content.find((part) => part.type === 'text').text
    let data; try { data = JSON.parse(text) } catch { data = text }
    return { data, error: result.isError === true }
  }
  t.after(async () => { await client?.close(); await new Promise((resolve) => proxy.close(resolve)) })
  await connect()
  const requestId = newStorageRequestId(), args = { requestId, mapId, cardId: 'card-1', data: { label: 'MCP 한 번' }, responseMode: 'affected' }
  const results = await Promise.all(Array.from({ length: 20 }, () => invoke('mindnprogress_update_card', args)))
  assert.ok(results.every((result) => !result.error && result.data.outcome === 'committed'), JSON.stringify(results))
  assert.equal(new Set(results.map((r) => r.data.transactionId)).size, 1)
  assert.equal(writes.length, 1)
  assert.equal((await api.read(`${mapId}.json`)).version, 2)
  const mismatch = await invoke('mindnprogress_update_card', { ...args, data: { label: '다른 내용' } })
  assert.equal(mismatch.data.code, 'REQUEST_ID_REUSED')
  const only = await invoke('mindnprogress_update_card', { requestId, resultOnly: true })
  assert.equal(only.data.outcome, 'committed'); assert.equal(writes.length, 1)
  const empty = await invoke('mindnprogress_update_card', { requestId: newStorageRequestId(), resultOnly: true })
  assert.equal(empty.data.outcome, 'unknown'); assert.equal(writes.length, 1)

  drop = 3
  const lostId = newStorageRequestId()
  const commentArgs = { requestId: lostId, mapId, operation: { action: 'add', cardId: 'card-1', summary: '[진행] 응답 유실' } }
  const lost = await invoke('mindnprogress_manage_comment', commentArgs)
  assert.equal(lost.data.outcome, 'unknown', JSON.stringify(lost)); assert.equal(lost.data.requestId, lostId)
  await client.close(); await api.restart(); await connect()
  const found = await invoke('mindnprogress_manage_comment', { requestId: lostId, resultOnly: true })
  assert.equal(found.data.outcome, 'committed', JSON.stringify(found))
  const replay = await invoke('mindnprogress_manage_comment', commentArgs)
  assert.equal(replay.data.comment.id, found.data.comment.id)
  assert.equal((await api.read(`_comments/${mapId}.json`)).length, 1)

  // 최초 전송이 도달하지 않은 동안 다른 작성자가 변경했다. 재시도는 최초 read-set으로 충돌해야 한다.
  suppress = 3
  const staleArgs = { requestId: newStorageRequestId(), mapId, cardId: 'card-2', data: { label: '최초 의도' } }
  assert.equal((await invoke('mindnprogress_update_card', staleArgs)).data.outcome, 'unknown')
  const first = writes.at(-1)
  await invoke('mindnprogress_update_card', { mapId, cardId: 'card-2', data: { label: '외부 변경' } })
  await client.close(); await connect()
  const stale = await invoke('mindnprogress_update_card', staleArgs)
  assert.equal(stale.data.reasonCode, 'FIELD_CONFLICT', JSON.stringify(stale))
  assert.equal(writes.at(-1).body, first.body)
  assert.equal(writes.at(-1).id, first.id)
  assert.equal((await api.read(`${mapId}.json`)).nodes.find((n) => n.id === 'card-2').data.label, '외부 변경')
  const count = writes.length
  assert.equal((await invoke('mindnprogress_update_card', staleArgs)).data.reasonCode, 'FIELD_CONFLICT')
  assert.equal(writes.length, count)
  await api.stop()
  const users = await api.read('_users.json')
  users.find((user) => user.id === 'user-editor').active = false
  await writeFile(path.join(api.data, '_users.json'), JSON.stringify(users))
  await api.restart()
  const revoked = await invoke('mindnprogress_update_card', { ...args, data: { label: '권한 회수 후 다른 내용' } })
  assert.equal(revoked.data.reasonCode, 'REQUEST_FORBIDDEN', JSON.stringify(revoked))
  assert.equal(writes.length, count)
})
