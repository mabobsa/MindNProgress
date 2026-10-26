import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { documentTrashReviewBrowser } from './helpers/documentTrashReviewBrowser.mjs'

const root = path.resolve(import.meta.dirname, '..')
const node = (id, data = {}) => ({ id, type: 'mind', position: { x: 0, y: 0 }, data: {
  label: id, description: '원문을 보존합니다.', sharedKnowledge: '', kind: 'task', isWork: false, status: 'planned', progress: 0, ...data,
} })

test('일반·보관 휴지통 이동은 최신 외부 Ref 확인과 편집 권한을 요구한다', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-trash-review-api-'))
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const fakeAion = createHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: true, data: { unavailable: true } }))
  })
  await new Promise((resolve) => fakeAion.listen(0, '127.0.0.1', resolve))
  const tokenFile = path.join(directory, '_integration-token')
  const env = { ...process.env, MNP_DATA_DIR: directory, MNP_TOKEN_FILE: tokenFile,
    MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_API_URL: base,
    MNP_ADMIN_PASSWORD: 'TestOnly!2026', MNP_ADMIN_EMAIL: 'reconstruction-test@mind.local',
    MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'), MNP_MCP_USAGE_DISABLED: '1', AIONUI_CONVERSATION_ID: '',
    MNP_AIONUI_URL: `http://127.0.0.1:${fakeAion.address().port}`, MNP_AIONUI_DISCOVERY_FILE: path.join(directory, 'no-discovery.json') }
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (value) => { stderr += value })
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await exited }
    await new Promise((resolve) => fakeAion.close(resolve))
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.match(path.basename(directory), /^mnp-trash-review-api-/)
    await rm(directory, { recursive: true, force: true })
  })
  let ready = false
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(base + '/api/health')).ok) { ready = true; break } } catch { /* 임시 서버 시작 대기 */ }
    if (child.exitCode !== null) throw new Error(stderr)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(ready, true, '임시 서버 시작 실패: ' + stderr)
  const headers = { Authorization: `Bearer ${(await readFile(tokenFile, 'utf8')).trim()}`, 'X-MNP-Editor-Id': 'user-editor', 'Content-Type': 'application/json' }
  const api = async (url, method = 'GET', body, customHeaders = headers) => {
    const response = await fetch(base + url, { method, headers: customHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const create = async (title, nodes) => {
    const result = await api('/api/maps', 'POST', { title, map: { nodes, edges: [] } })
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.map
  }
  const archive = async (map) => {
    const result = await api(`/api/maps/${map.id}/archive`, 'PATCH', { baseVersion: map.version, baseLifecycleVersion: map.lifecycleVersion ?? 0, archived: true })
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.map
  }
  const source = await create('휴지통 대상 원본', [node('original', { kind: 'root', label: '원본 카드' })])
  const ref = (id) => node(id, { label: id, reference: { mapId: source.id, nodeId: 'original' } })
  const active = await create('활성 참조 문서', [ref('ref-active'), ref('ref-second')])
  const archived = await archive(await create('보관 참조 문서', [ref('ref-archived')]))
  const trashed = await create('휴지통 참조 문서', [ref('ref-trashed')])
  assert.equal((await api(`/api/maps/${trashed.id}`, 'DELETE')).status, 200)
  const previewUrl = `/api/maps/${source.id}/trash-preview`
  assert.equal((await api(previewUrl, 'GET', undefined, {})).status, 401)
  const viewerLogin = await fetch(base + '/api/auth/viewer-access', { method: 'POST' })
  const viewer = { Cookie: viewerLogin.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  assert.equal((await api(previewUrl, 'GET', undefined, viewer)).status, 403)
  const preview = (await api(previewUrl)).body
  assert.deepEqual(preview.references.map((item) => item.cardId).sort(), ['ref-active', 'ref-archived', 'ref-second'])
  assert.equal(preview.references.find((item) => item.mapId === archived.id).archived, true)
  const sourceFile = path.join(directory, source.id + '.json')
  const before = await readFile(sourceFile)
  const blocked = await api(`/api/maps/${source.id}`, 'DELETE')
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'TRASH_REFERENCES_CHANGED')
  assert.deepEqual(await readFile(sourceFile), before, '확인 전에는 원본을 변경하지 않는다')
  const late = await create('확인 중 추가된 참조', [ref('ref-late')])
  const changed = await api(`/api/maps/${source.id}`, 'DELETE', { referenceVersion: preview.referenceVersion })
  assert.equal(changed.status, 409)
  assert.equal(changed.body.preview.references.length, 4)
  assert.deepEqual(await readFile(sourceFile), before)
  assert.equal((await api(`/api/maps/${source.id}`, 'DELETE', { referenceVersion: changed.body.preview.referenceVersion }, viewer)).status, 403)
  const removed = await api(`/api/maps/${source.id}`, 'DELETE', { referenceVersion: changed.body.preview.referenceVersion })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  for (const id of [active.id, archived.id, late.id]) assert.equal((await api(`/api/maps/${id}`)).status, 200)
  const restored = await api(`/api/maps/${source.id}/restore`, 'POST', {})
  assert.equal(restored.status, 200)
  const archivedSource = await archive(restored.body.map)
  const archiveUrl = `/api/maps/${source.id}/archive`
  const version = { baseVersion: archivedSource.version, baseLifecycleVersion: archivedSource.lifecycleVersion }
  assert.equal((await api(archiveUrl, 'DELETE', version)).status, 409)
  const archivePreview = (await api(previewUrl)).body
  assert.equal(archivePreview.target.archived, true)
  assert.equal((await api(archiveUrl, 'DELETE', { ...version, referenceVersion: archivePreview.referenceVersion }, viewer)).status, 403)
  assert.equal((await api(archiveUrl, 'DELETE', { ...version, referenceVersion: archivePreview.referenceVersion })).status, 200)
  assert.equal((await api('/api/maps/trash')).body.maps.some((item) => item.id === source.id && item.archivedAt), true)
  assert.equal((await api(previewUrl)).status, 409)
  if (process.env.MNP_BROWSER_TEST === '1') t.diagnostic(JSON.stringify(await documentTrashReviewBrowser({ base, directory, api, create, archive, node })))
})
