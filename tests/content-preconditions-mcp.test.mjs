import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'
import { commentContentHash } from '../server/lib/contentPreconditions.mjs'
import { textIntegrity } from '../mcp/cardTextPatch.mjs'

test('실제 MCP는 원래 사전조건·검토 토큰을 전달하고 충돌 뒤 기대값 교체나 재시도를 하지 않는다', { timeout: 90_000 }, async (t) => {
  const api = await storageApi(t, { documents: 5 }), id = api.ids[0]
  let gate = null
  const writes = []
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      if (!['GET', 'HEAD'].includes(request.method)) writes.push({ method: request.method, url: request.url, body: body.length ? JSON.parse(body) : null })
      const active = gate
      if (active && request.url === active.url && request.method === active.method) {
        active.arrived++
        if (active.arrived === active.count) active.reached()
        await active.releasePromise
      }
      const upstream = await fetch(api.base + request.url, { method: request.method,
        headers: request.headers, ...(body.length ? { body } : {}) })
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' })
      response.end(await upstream.text())
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const pause = (url, count, method = 'PATCH') => {
    let reached, release
    const reachedPromise = new Promise((r) => { reached = r })
    const releasePromise = new Promise((r) => { release = r })
    gate = { url, count, method, arrived: 0, reached, releasePromise }
    return { reached: reachedPromise, release: () => { gate = null; release() } }
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'], cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, MNP_API_URL: `http://127.0.0.1:${proxy.address().port}`, MNP_TOKEN_FILE: path.join(api.data, '_integration-token'),
      MNP_DATA_DIR: api.data, AIONUI_CONVERSATION_ID: '', MNP_MCP_USAGE_DISABLED: '1' }, stderr: 'pipe' })
  const client = new Client({ name: 'content-preconditions-test', version: '1.0.0' })
  await client.connect(transport)
  t.after(async () => { await client.close(); await new Promise((r) => proxy.close(r)) })
  const invoke = async (name, args) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content.find((c) => c.type === 'text').text
    let data; try { data = JSON.parse(text) } catch { data = text }
    return { error: r.isError === true, data }
  }
  const bootstrap = await invoke('mindnprogress_get_context', { mapId: id, cardId: 'card-1', editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' })
  assert.equal(bootstrap.error, false)
  let blocked = pause(`/api/maps/${id}/content-patch`, 20)
  const independent = Array.from({ length: 20 }, (_, i) => invoke('mindnprogress_update_card', { mapId: id, cardId: `card-${i}`,
    data: { description: `MCP 독립 변경 ${i}` }, responseMode: 'affected' }))
  await blocked.reached
  const captured = writes.slice(-20)
  assert.ok(captured.every((w) => w.body.baseVersion === 1 && w.body.preconditions?.schemaVersion === 1))
  blocked.release()
  assert.ok((await Promise.all(independent)).every((r) => !r.error))
  for (const map of [await api.read(`${id}.json`), (await api.call(`/api/maps/${id}`)).body.map]) {
    assert.equal(map.version, 21)
    for (let i = 0; i < 20; i++) assert.equal(map.nodes[i].data.description, `MCP 독립 변경 ${i}`)
  }
  const attemptsBefore = writes.length
  blocked = pause(`/api/maps/${id}/content-patch`, 2)
  const competitors = ['먼저', '나중'].map((label) => invoke('mindnprogress_update_card', { mapId: id, cardId: 'card-1', data: { label } }))
  await blocked.reached; blocked.release()
  const results = await Promise.all(competitors)
  assert.equal(results.filter((r) => r.error).length, 1)
  const rejection = results.find((r) => r.error).data
  assert.equal(rejection.code, 'VERSION_CONFLICT'); assert.equal(rejection.reasonCode, 'FIELD_CONFLICT')
  assert.equal(rejection.outcome, 'not-applied'); assert.equal(rejection.retryable, false); assert.ok(rejection.conflicts.length)
  assert.equal(writes.length - attemptsBefore, 2)

  const original = (await api.call(`/api/maps/${id}`)).body.map.nodes[2].data.description
  const textPatch = await invoke('mindnprogress_patch_card_text', { mapId: id, cardId: 'card-2', field: 'description',
    expectedSha256: textIntegrity(original).sha256, operation: { type: 'append', text: '추가 본문', separator: 'newline' } })
  assert.equal(textPatch.error, false, JSON.stringify(textPatch))
  assert.equal(writes.at(-1).body.textOperations[0].expectedSha256, textIntegrity(original).sha256)
  const stale = await invoke('mindnprogress_patch_card_text', { mapId: id, cardId: 'card-2', field: 'description',
    expectedSha256: textIntegrity(original).sha256, operation: { type: 'append', text: '낡은 의도', separator: 'newline' } })
  assert.equal(stale.error, true); assert.equal(stale.data.code, 'TEXT_HASH_MISMATCH'); assert.equal(stale.data.retryable, false)

  const reviewId = api.ids[1]
  const context = (await invoke('mindnprogress_get_shared_knowledge_review_context', { mapId: reviewId, cardId: 'card-1' })).data
  const map = (await api.call(`/api/maps/${reviewId}`)).body.map, next = structuredClone(map); next.nodes[10].data.label = '무관한 수정'
  assert.equal((await api.call(`/api/maps/${reviewId}/content-patch`, 'PATCH', { baseVersion: map.version, patch: createMapContentPatch(map, next) })).status, 200)
  const applied = await invoke('mindnprogress_apply_shared_knowledge_review', { mapId: reviewId, baseVersion: context.document.version,
    patches: [{ cardId: 'card-1', expectedSha256: context.card.textIntegrity.sha256, reviewContextToken: context.reviewContextToken,
      reviewResult: 'cleaned', replacement: 'MCP 검토 결과' }] })
  assert.equal(applied.error, false, JSON.stringify(applied))
  assert.deepEqual(writes.at(-1).body.patches[0].reviewContextToken, context.reviewContextToken)
  const dependent = (await invoke('mindnprogress_get_shared_knowledge_review_context', { mapId: reviewId, cardId: 'card-2' })).data
  await api.call(`/api/maps/${reviewId}/comments`, 'POST', { nodeId: 'card-2', text: '새 검토 근거' })
  const rejected = await invoke('mindnprogress_apply_shared_knowledge_review', { mapId: reviewId, baseVersion: dependent.document.version,
    patches: [{ cardId: 'card-2', expectedSha256: dependent.card.textIntegrity.sha256, reviewContextToken: dependent.reviewContextToken,
      reviewResult: 'cleaned', replacement: '거부 결과' }] })
  assert.equal(rejected.error, true); assert.equal(rejected.data.reasonCode, 'READ_DEPENDENCY_CHANGED'); assert.equal(rejected.data.retryable, false)

  const added = (await invoke('mindnprogress_manage_comment', { mapId: id, operation: { action: 'add', cardId: 'card-1', summary: '[진행] 댓글', detail: '기존 상세' } })).data.comment
  await api.call(`/api/maps/${id}/comments/${added.id}`, 'PATCH', { detail: '외부 상세' })
  const edit = await invoke('mindnprogress_manage_comment', { mapId: id, operation: { action: 'update', commentId: added.id,
    detail: '낡은 상세', expectedContentSha256: commentContentHash(added) } })
  assert.equal(edit.error, true); assert.equal(edit.data.reasonCode, 'FIELD_CONFLICT')

  const relationCount = writes.length
  blocked = pause(`/api/maps/${id}/content-patch`, 2)
  const relations = [3, 4].map((i) => invoke('mindnprogress_manage_knowledge_line', { mapId: id, sourceCardId: `card-${i}`, targetCardId: 'card-5', operation: { action: 'add' } }))
  await blocked.reached; blocked.release()
  const related = await Promise.all(relations)
  assert.equal(related.filter((r) => r.error).length, 1)
  assert.equal(related.find((r) => r.error).data.reasonCode, 'READ_DEPENDENCY_CHANGED')
  assert.equal(writes.length - relationCount, 2, '구조 충돌 뒤 새 버전으로 의도를 재계산하지 않는다')
  t.diagnostic(JSON.stringify({ independent: 20, sameFieldSuccess: 1, sameFieldConflict: 1, sameFieldAttempts: 2, relationAttempts: 2 }))
})
