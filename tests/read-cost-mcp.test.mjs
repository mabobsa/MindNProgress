import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { seedReadFixture } from './helpers/read-cost-fixture.mjs'

test('실제 MCP의 카드·문서 조회는 HTTP 한 번으로 귀속·원문·페이지·그룹을 유지한다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 8, seed: seedReadFixture }), calls = []
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      calls.push(request.url)
      const upstream = await fetch(api.base + request.url, { method: request.method, headers: request.headers,
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Buffer.concat(chunks) }) })
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch { response.writeHead(502); response.end('{}') }
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const client = new Client({ name: 'read-cost-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'),
    env: { ...api.env, MNP_API_URL: `http://127.0.0.1:${proxy.address().port}` }, stderr: 'pipe' })
  t.after(async () => { await client.close(); await new Promise((resolve) => proxy.close(resolve)) })
  await client.connect(transport)
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return JSON.parse(result.content.find((part) => part.type === 'text').text)
  }
  const mapId = api.ids[1]
  const context = await invoke('get_context', { mapId, cardId: 'card-1', editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' })
  assert.equal(context.guide.contextLifecycle.refresh.repeatGetContext, false)
  calls.length = 0
  const card = await invoke('get_card', { mapId, cardId: 'card-1', commentOffset: 1, commentLimit: 2 })
  assert.equal(calls.length, 1, JSON.stringify(calls))
  assert.equal(card.comments.length, 2); assert.equal(card.commentsPage.total, 5)
  assert.ok(card.card.data.sharedKnowledge); assert.ok(card.card.textIntegrity.description.sha256)
  assert.equal(card.documentGroupsStatus, 'available')
  calls.length = 0
  const doc = await invoke('get_document', { mapId, view: 'outline', cardIds: ['card-1'] })
  assert.equal(calls.length, 1, JSON.stringify(calls)); assert.equal(doc.cards.length, 20)
  assert.equal(doc.selectedCards[0].data.sharedKnowledge, card.card.data.sharedKnowledge)
  calls.length = 0
  const unchanged = await invoke('get_document', { mapId, view: 'outline', cardIds: ['card-1'], ifNoneMatch: doc.documentEtag })
  assert.equal(calls.length, 1); assert.equal(unchanged.notModified, true)
})
