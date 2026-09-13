import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { cardLayoutBrowser } from './helpers/cardLayoutBrowser.mjs'

const root = path.resolve(import.meta.dirname, '..')
const node = (id, data = {}) => ({ id, type: 'mind', position: { x: id === 'root' ? 40 : 350, y: 40 }, data: { label: id, description: '카드 내용과 관계를 보존하는 배치 검증입니다.', kind: 'task', isWork: true, status: 'planned', progress: 0, ...data } })
test('배치 HTTP·MCP·실제 브라우저는 원본을 보존하고 승인한 위치만 적용한다', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-layout-api-'))
  const conversations = new Map()
  const fake = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost'); let data = []
    if (url.pathname === '/api/agents/management') data = [{ id: 'claude', name: 'Claude', installed: true, enabled: true, status: 'ready', available_models: { available_models: [{ value: 'opus', name: 'Opus' }] } }]
    else if (url.pathname === '/api/internal/conversation-runtimes/active') data = { conversations: [] }
    else if (url.pathname.startsWith('/api/conversations/')) data = conversations.get(url.pathname.split('/').at(-1)) ?? {}
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data))
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const probe = createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const env = { ...process.env, MNP_DATA_DIR: directory, MNP_TOKEN_FILE: path.join(directory, '_integration-token'), MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_API_URL: base,
    MNP_ADMIN_EMAIL: 'layout-test@mind.local', MNP_ADMIN_PASSWORD: 'TestOnly!2026', MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'), MNP_MCP_USAGE_DISABLED: '1', AIONUI_CONVERSATION_ID: '',
    MNP_AIONUI_URL: `http://127.0.0.1:${fake.address().port}`, MNP_AIONUI_DISCOVERY_FILE: path.join(directory, 'no-discovery.json') }
  let child; let stderr = ''; let mcp
  const stop = async () => { if (child?.exitCode === null) { const done = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await done } }
  t.after(async () => { await mcp?.close(); await stop(); await new Promise((resolve) => fake.close(resolve)); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^mnp-layout-api-/); await rm(directory, { recursive: true, force: true }) })
  const start = async () => {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr.on('data', (data) => { stderr += data })
    for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/api/health')).ok) return } catch { /* 임시 서버 준비 */ } if (child.exitCode !== null) throw Error(stderr); await new Promise((resolve) => setTimeout(resolve, 100)) }
    throw Error(stderr || '임시 서버 준비 실패')
  }
  await start()
  const headers = { Authorization: `Bearer ${(await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()}`, 'X-MNP-AI-Editor-Id': 'user-admin', 'Content-Type': 'application/json' }
  const api = async (url, method = 'GET', body, custom = headers) => { const r = await fetch(base + url, { method, headers: custom, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() } }
  const created = await api('/api/maps', 'POST', { title: '배치 검증 문서', map: { nodes: [node('root', { kind: 'root', isWork: false }), node('group', { kind: 'branch', isWork: false }), node('a'), node('b'), node('memo', { isWork: false })], edges: [{ id: 'e1', source: 'root', target: 'group' }, { id: 'e2', source: 'group', target: 'a' }, { id: 'e3', source: 'group', target: 'b' }] } })
  assert.equal(created.status, 201, JSON.stringify(created.body)); let map = created.body.map
  const referenceSource = (await api('/api/maps', 'POST', { title: '배치 Ref 원본', map: { nodes: [node('ref-source', { kind: 'root', isWork: false, label: '현재 참조된 지식' })], edges: [] } })).body.map
  const doorayUrl = 'https://test.dooray.com/wiki/1/2'
  map.nodes.push(node('dooray', { isWork: false, taskUrl: doorayUrl, externalLink: { provider: 'dooray-wiki', url: doorayUrl, hostname: 'test.dooray.com', wikiId: '1', pageId: '2', title: '크기가 큰 Dooray 자료', resolvedAt: '2026-09-12T00:00:00Z', displayWidth: 500, displayHeight: 240 } }),
    node('ref', { isWork: false, reference: { mapId: referenceSource.id, nodeId: 'ref-source' } }), node('tree-2', { kind: 'branch', isWork: false }), node('tree-2-child'))
  map.edges.push({ id: 'independent-tree', source: 'tree-2', target: 'tree-2-child' }, { id: 'dooray-a', source: 'dooray', target: 'a', data: { relation: 'knowledge' } },
    { id: 'ref-a', source: 'ref', target: 'a', data: { relation: 'knowledge' } }, { id: 'ref-b', source: 'ref', target: 'tree-2-child', data: { relation: 'knowledge', knowledgePolicy: 'inspect-if-insufficient' } })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1cAAAAASUVORK5CYII=', 'base64')
  const uploaded = await fetch(`${base}/api/maps/${map.id}/images`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: png })
  assert.equal(uploaded.status, 201); const asset = (await uploaded.json()).image
  map.nodes.push(node('image', { kind: 'image', isWork: false, image: { assetId: asset.assetId, fileName: '검증.png', mimeType: 'image/png', naturalWidth: 1, naturalHeight: 1, displayWidth: 460, displayHeight: 220 } }))
  map.edges.push({ id: 'knowledge', source: 'image', target: 'a', data: { relation: 'knowledge', knowledgePolicy: 'reuse-first' } })
  const updated = await api(`/api/maps/${map.id}`, 'PUT', { baseVersion: map.version, map }); assert.equal(updated.status, 200, JSON.stringify(updated.body)); map = updated.body.map
  const file = path.join(directory, map.id + '.json'); const before = await readFile(file)
  let request = (await api('/api/card-layouts', 'POST', { mapId: map.id, proposalOnly: true })).body
  assert.deepEqual(request.target, { ratio: '16:9' })
  assert.equal((await api('/api/card-layouts', 'POST', { mapId: map.id, proposalOnly: true, target: { ratio: '3:4' } })).status, 400)
  const sizes = (m) => m.nodes.map((n) => ({ cardId: n.id, ...n.position, width: n.data.image?.displayWidth ?? 218, height: n.data.image?.displayHeight ?? 170, outsets: { left: 8, right: 8, top: 40, bottom: 8 } }))
  assert.equal((await api(`/api/card-layouts/${request.id}/capture`, 'POST', { measurements: sizes(map) })).status, 200)
  const attribution = await api('/api/integrations/aionui/attributions', 'POST', { agentId: 'claude', modelId: 'opus', mapId: map.id, cardId: 'root', purpose: 'card-layout', cardLayoutRequestId: request.id, workspace: directory, workspaceConfirmed: true })
  assert.equal(attribution.status, 201, JSON.stringify(attribution.body))
  conversations.set('layout-test-conversation', { id: 'layout-test-conversation', type: 'claude', name: '[배치 제안] 검증', extra: {} })
  const complete = await fetch(attribution.body.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'layout-test-conversation' }) })
  assert.equal(complete.status, 200, await complete.clone().text()); assert.equal((await complete.json()).linked, false)
  assert.deepEqual(await readFile(file), before, 'AI 대화 연결은 원본 문서를 바꾸지 않는다')
  mcp = new Client({ name: 'layout-test', version: '1' })
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'], cwd: root, env, stderr: 'pipe' }))
  // 별도 시험 MCP 세션에서만 시험 계정을 바인딩한다. 실제 작업 카드와 현재 MCP 세션에는 접근하지 않는다.
  const binding = await mcp.callTool({ name: 'mindnprogress_get_context', arguments: { mapId: map.id, cardId: 'root', editorId: 'user-admin', attributionToken: attribution.body.attributionToken } })
  assert.equal(binding.isError, undefined, JSON.stringify(binding))
  const toolList = await mcp.listTools()
  for (const name of ['mindnprogress_get_card_layout_request', 'mindnprogress_submit_card_layout_proposal']) assert.ok(toolList.tools.some((tool) => tool.name === name))
  const submit = async (id) => {
    const result = await mcp.callTool({ name: 'mindnprogress_get_card_layout_request', arguments: { requestId: id } })
    assert.equal(result.isError, undefined, JSON.stringify(result)); const context = JSON.parse(result.content[0].text)
    const proposed = await mcp.callTool({ name: 'mindnprogress_submit_card_layout_proposal', arguments: { requestId: id, baseRevision: context.revision, plan: { order: context.snapshot.map.nodes.map((n) => n.id), reason: '하위 계층은 오른쪽에, 이미지 자료는 연결된 업무 가까이에 배치했습니다. 종류별 묶음과 카드 크기를 함께 고려했습니다.' } } })
    assert.equal(proposed.isError, undefined, JSON.stringify(proposed))
  }
  await submit(request.id)
  assert.deepEqual(await readFile(file), before, 'MCP 배치 제안 제출도 원본을 바꾸지 않는다')
  let preview = (await api(`/api/card-layouts/${request.id}/preview`, 'POST', {})).body
  for (const target of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
    const compatible = await api(`/api/card-layouts/${request.id}/preview`, 'POST', { target })
    assert.equal(compatible.status, 200)
    assert.deepEqual(compatible.body.target, { ratio: '16:9' })
    assert.deepEqual(compatible.body.map, preview.map)
    assert.deepEqual(compatible.body.candidates, preview.candidates)
    preview = compatible.body
  }
  assert.equal((await api(`/api/card-layouts/${request.id}/apply`, 'POST', { approved: true, previewHash: preview.previewHash, measurements: sizes(preview.map) })).status, 409)
  for (const action of ['measure', 'verify']) { const r = await api(`/api/card-layouts/${request.id}/${action}`, 'POST', { previewHash: preview.previewHash, measurements: sizes(preview.map) }); assert.equal(r.status, 200, JSON.stringify(r.body)); preview = r.body }
  const login = await fetch(base + '/api/auth/viewer-access', { method: 'POST' }); const viewer = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  assert.equal((await api(`/api/card-layouts/${request.id}/apply`, 'POST', { approved: true, previewHash: preview.previewHash }, viewer)).status, 403)
  await stop(); await start()
  assert.equal((await api(`/api/card-layouts/${request.id}`)).body.plan.order.length, map.nodes.length)
  assert.equal((await api(`/api/card-layouts/${request.id}/apply`, 'POST', { approved: true, previewHash: preview.previewHash, measurements: sizes(preview.map) })).status, 409, '서버 재시작 후 실측 검증 갱신 필요')
  await api(`/api/card-layouts/${request.id}/cancel`, 'POST', {})
  if (process.env.MNP_LAYOUT_BROWSER === '1') {
    const report = await cardLayoutBrowser({ base, directory, mapId: map.id, api, submit })
    console.log('배치 브라우저 검증:', JSON.stringify(report))
  } else {
    request = (await api('/api/card-layouts', 'POST', { mapId: map.id, proposalOnly: true })).body
    await api(`/api/card-layouts/${request.id}/capture`, 'POST', { measurements: sizes(map) }); await submit(request.id)
    preview = (await api(`/api/card-layouts/${request.id}/preview`, 'POST', {})).body
    for (const action of ['measure', 'verify']) preview = (await api(`/api/card-layouts/${request.id}/${action}`, 'POST', { previewHash: preview.previewHash, measurements: sizes(preview.map) })).body
    const applied = await api(`/api/card-layouts/${request.id}/apply`, 'POST', { approved: true, previewHash: preview.previewHash, measurements: sizes(preview.map) }); assert.equal(applied.status, 200, JSON.stringify(applied.body))
  }
  const saved = JSON.parse(await readFile(file, 'utf8')); const original = JSON.parse(before)
  assert.deepEqual(saved.nodes.map(({ position: _p, ...node }) => node), original.nodes.map(({ position: _p, ...node }) => node))
  assert.deepEqual(saved.edges, original.edges)
  assert.deepEqual(saved.nodes[0].position, original.nodes[0].position)
})
