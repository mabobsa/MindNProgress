import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('작업공간 설정 API는 계정·문서·그룹·시작 경로를 함께 검증한다', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-api-'))
  const workspace = path.join(directory, 'project'), other = path.join(directory, 'other')
  await mkdir(workspace); await mkdir(other)
  const upstream = createServer((request, response) => {
    const body = request.url === '/api/agents/management' ? [{ id: 'test', name: '테스트', installed: true, enabled: true,
      available_models: { available_models: [{ value: 'test-model', name: '테스트 모델' }] } }] : []
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const probe = createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`, upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
  const server = spawn(process.execPath, ['server/index.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
      MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'), MNP_AIONUI_URL: upstreamUrl, MNP_AIONUI_WEB_URL: upstreamUrl,
      MNP_ADMIN_EMAIL: 'test@workspace.local', MNP_ADMIN_PASSWORD: 'test-workspace-password' } })
  let cookie = ''
  async function api(route, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + route, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, body: await response.json() }
  }
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/health')).ok) break } catch {} await new Promise((resolve) => setTimeout(resolve, 100)) }
    assert.equal((await api('/api/integrations/aionui/workspace-context')).status, 401)
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test@workspace.local', password: 'test-workspace-password' }) })
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0]
    const created = await api('/api/maps', { title: '작업공간 검증', map: { nodes: [{ id: 'root-test', type: 'mind', position: { x: 0, y: 0 }, data: { label: '루트', kind: 'root', description: '', isWork: false, status: 'planned', progress: 0 } }], edges: [] } })
    assert.equal(created.status, 201)
    const mapId = created.body.map.id
    const library = (await api('/api/maps')).body
    const ids = library.maps.map((m) => m.id)
    const groupId = 'group-workspace-test'
    assert.equal((await api('/api/maps/layout', { documentLayout: { version: 1, items: [...ids.filter((id) => id !== mapId).map((id) => ({ type: 'map', id })), { type: 'group', id: groupId }], groups: [{ id: groupId, name: '테스트 그룹', mapIds: [mapId] }] } }, 'PATCH')).status, 200)
    const route = `/api/integrations/aionui/workspace-context?mapId=${mapId}`
    const first = (await api(route)).body
    assert.equal(first.source, 'none'); assert.equal(first.workspace, ''); assert.equal(first.needsSelection, true)
    assert.equal((await api(`/api/integrations/aionui/options?mapId=${mapId}&purpose=card`)).body.defaultWorkspace, '')
    const launch = { mapId, cardId: 'root-test', machineId: first.machineId, agentId: 'test', modelId: 'test-model', workspace }
    assert.equal((await api('/api/integrations/aionui/attributions', launch)).status, 409)
    const save = (scope, value, version = 0) => api('/api/integrations/aionui/workspace-settings', { scope, id: scope === 'document' ? mapId : groupId, mapId, machineId: first.machineId, workspace: value, baseVersion: version })
    assert.equal((await save('group', workspace)).status, 200)
    const inherited = (await api(route)).body
    assert.equal(inherited.workspace, workspace); assert.equal(inherited.source, 'group')
    assert.equal((await api(`/api/integrations/aionui/options?mapId=${mapId}&purpose=card-layout`)).body.defaultWorkspace, workspace)
    assert.equal((await api(`/api/integrations/aionui/options?mapId=${mapId}&purpose=dooray-response`)).body.defaultWorkspace, workspace)
    assert.equal((await save('document', other)).status, 200)
    assert.equal((await api(route)).body.workspace, other)
    assert.equal((await save('document', workspace)).status, 409)
    assert.equal((await api('/api/integrations/aionui/attributions', { ...launch, workspaceConfirmed: true, workspaceToken: inherited.token })).status, 409)
    const current = (await api(route)).body
    const attribution = await api('/api/integrations/aionui/attributions', { ...launch, workspace: other, workspaceToken: current.token })
    assert.equal(attribution.status, 201, JSON.stringify(attribution.body)); assert.equal(attribution.body.workspace, other)
    assert.equal((await save('document', '', 1)).status, 200)
    assert.equal((await api(route)).body.workspace, workspace)
    const after = (await api(`/api/maps/${mapId}`)).body.map
    assert.equal(after.version, created.body.map.version, '기준 저장은 문서 내용·진행률·대화를 변경하지 않는다')
    assert.deepEqual(after.nodes, created.body.map.nodes)
    assert.equal((await save('document', path.join(directory, 'missing'), 2)).status, 409)
    assert.equal((await api('/api/integrations/aionui/workspace-settings', { scope: 'group', id: 'group-other', mapId, workspace, machineId: first.machineId, baseVersion: 0 })).status, 409)
  } finally {
    if (server.exitCode === null) { const exited = new Promise((resolve) => server.once('exit', resolve)); server.kill(); await exited }
    await new Promise((resolve) => upstream.close(resolve))
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
