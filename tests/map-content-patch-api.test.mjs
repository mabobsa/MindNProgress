import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const node = (id, description = '') => ({
  id, type: 'mind', position: { x: 0, y: 0 },
  data: { label: id, kind: id === 'root' ? 'root' : 'task', description, progress: 0, status: 'planned' },
})

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('부분 저장 API 검증 서버가 시작되지 않았습니다.')
}

test('2MB 넘는 문서도 변경 카드만 보내 저장하고 원문·버전·한도를 보존한다', { timeout: 90_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-content-patch-'))
  const port = 30_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: { ...process.env, MNP_DATA_DIR: dataDirectory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port) },
    stdio: 'ignore',
  })
  try {
    await waitForServer(baseUrl)
    const token = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
    const headers = { Authorization: `Bearer ${token}`, 'X-MNP-Editor-Id': 'user-editor', 'Content-Type': 'application/json' }
    const api = async (url, method = 'GET', body) => {
      const response = await fetch(`${baseUrl}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json() }
    }
    const created = await api('/api/maps', 'POST', { title: '장문 카드 부분 저장', map: { nodes: [node('root')], edges: [] } })
    assert.equal(created.status, 201)
    let map = created.body.map
    const url = `/api/maps/${map.id}`
    const patchUrl = `${url}/content-patch`
    const largeDescription = '한'.repeat(240_000)

    for (const id of ['root', 'first', 'second']) {
      const next = structuredClone(map)
      if (id === 'root') next.nodes[0].data.description = largeDescription
      else {
        next.nodes.push(node(id, largeDescription))
        next.edges.push({ id: `edge-${id}`, source: 'root', target: id, data: { relation: 'hierarchy' } })
      }
      const body = { baseVersion: map.version, patch: createMapContentPatch(map, next) }
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < 2_000_000)
      const saved = await api(patchUrl, 'PATCH', body)
      assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 200))
      map = saved.body.map
    }
    assert.ok(Buffer.byteLength(JSON.stringify({ map: { nodes: map.nodes, edges: map.edges }, baseVersion: map.version })) > 2_000_000)

    const staleVersion = map.version
    const next = structuredClone(map)
    next.nodes.push(node('small', '작은 카드'))
    next.edges.push({ id: 'edge-small', source: 'root', target: 'small', data: { relation: 'hierarchy' } })
    const body = { baseVersion: map.version, patch: createMapContentPatch(map, next) }
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 2_000)
    const saved = await api(patchUrl, 'PATCH', body)
    assert.equal(saved.status, 200)
    map = saved.body.map
    assert.equal(map.nodes.length, 4)
    for (const id of ['root', 'first', 'second']) {
      assert.equal(map.nodes.find((item) => item.id === id).data.description, largeDescription)
    }
    assert.equal(map.nodes.find((item) => item.id === 'small').data.description, '작은 카드')

    const editedDescription = `${largeDescription.slice(0, -1)}수정`
    const descriptionEdit = structuredClone(map)
    descriptionEdit.nodes.find((item) => item.id === 'first').data.description = editedDescription
    const descriptionBody = { baseVersion: map.version, patch: createMapContentPatch(map, descriptionEdit) }
    assert.equal(descriptionBody.patch.nodeChanges.length, 1)
    assert.deepEqual(Object.keys(descriptionBody.patch.nodeChanges[0].dataSet), ['description'])
    assert.ok(Buffer.byteLength(JSON.stringify(descriptionBody)) < 2_000_000)
    const descriptionSaved = await api(patchUrl, 'PATCH', descriptionBody)
    assert.equal(descriptionSaved.status, 200)
    map = descriptionSaved.body.map
    assert.equal(map.nodes.find((item) => item.id === 'first').data.description, editedDescription)
    assert.equal(map.nodes.find((item) => item.id === 'root').data.description, largeDescription)
    assert.equal(map.nodes.find((item) => item.id === 'second').data.description, largeDescription)

    const relationEdit = structuredClone(map)
    relationEdit.nodes.find((item) => item.id === 'second').position = { x: 340, y: 120 }
    relationEdit.nodes.find((item) => item.id === 'small').data.sharedKnowledge = '새 공유 지식'
    relationEdit.edges.find((item) => item.id === 'edge-small').source = 'first'
    relationEdit.edges.push({
      id: 'knowledge-first-second', source: 'first', target: 'second', type: 'default',
      data: { relation: 'knowledge', knowledgePolicy: 'reuse-first' },
    })
    const relationBody = { baseVersion: map.version, patch: createMapContentPatch(map, relationEdit) }
    assert.ok(Buffer.byteLength(JSON.stringify(relationBody)) < 2_000)
    assert.equal(JSON.stringify(relationBody).includes(largeDescription.slice(0, 100)), false)
    const relationSaved = await api(patchUrl, 'PATCH', relationBody)
    assert.equal(relationSaved.status, 200)
    map = relationSaved.body.map
    assert.deepEqual(map.nodes.find((item) => item.id === 'second').position, { x: 340, y: 120 })
    assert.equal(map.nodes.find((item) => item.id === 'small').data.sharedKnowledge, '새 공유 지식')
    assert.equal(map.edges.find((item) => item.id === 'edge-small').source, 'first')
    assert.equal(map.edges.find((item) => item.id === 'knowledge-first-second').data.knowledgePolicy, 'reuse-first')

    const updatedRelation = structuredClone(map)
    updatedRelation.edges.find((item) => item.id === 'knowledge-first-second').data.knowledgePolicy = 'inspect-if-insufficient'
    const updatedRelationSaved = await api(patchUrl, 'PATCH', {
      baseVersion: map.version, patch: createMapContentPatch(map, updatedRelation),
    })
    assert.equal(updatedRelationSaved.status, 200)
    map = updatedRelationSaved.body.map
    assert.equal(map.edges.find((item) => item.id === 'knowledge-first-second').data.knowledgePolicy, 'inspect-if-insufficient')

    const removedRelation = structuredClone(map)
    removedRelation.edges = removedRelation.edges.filter((item) => item.id !== 'knowledge-first-second')
    const removedRelationSaved = await api(patchUrl, 'PATCH', {
      baseVersion: map.version, patch: createMapContentPatch(map, removedRelation),
    })
    assert.equal(removedRelationSaved.status, 200)
    map = removedRelationSaved.body.map
    assert.equal(map.edges.some((item) => item.id === 'knowledge-first-second'), false)
    assert.equal(map.nodes.find((item) => item.id === 'first').data.description, editedDescription)

    const stale = await api(patchUrl, 'PATCH', { ...body, baseVersion: staleVersion })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'VERSION_CONFLICT')
    const firstChange = structuredClone(map)
    firstChange.nodes.find((item) => item.id === 'first').data.label = '첫 변경'
    const secondChange = structuredClone(map)
    secondChange.nodes.find((item) => item.id === 'second').data.label = '둘째 변경'
    const concurrent = await Promise.all([firstChange, secondChange].map((nextMap) => api(patchUrl, 'PATCH', {
      baseVersion: map.version,
      patch: createMapContentPatch(map, nextMap),
    })))
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409])
    map = concurrent.find((result) => result.status === 200).body.map
    assert.equal(map.nodes.find((item) => item.id === 'first').data.label === '첫 변경'
      && map.nodes.find((item) => item.id === 'second').data.label === '둘째 변경', false)
    const invalid = await api(patchUrl, 'PATCH', {
      baseVersion: map.version,
      patch: { ...createMapContentPatch(map, map), nodeOrder: [] },
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.code, 'MAP_CONTENT_PATCH_INVALID')
    const fullSave = await api(url, 'PUT', { map: { nodes: map.nodes, edges: map.edges }, baseVersion: map.version, baseLifecycleVersion: map.lifecycleVersion ?? 0 })
    assert.equal(fullSave.status, 413, '전체 요청의 2MB 상한은 유지되어야 합니다.')
    const reloaded = await api(url)
    assert.equal(reloaded.status, 200)
    assert.equal(reloaded.body.map.version, map.version)
    assert.equal(reloaded.body.map.nodes.length, 4)
    assert.equal(reloaded.body.map.nodes.find((item) => item.id === 'root').data.description, largeDescription)
  } finally {
    server.kill()
    await new Promise((resolve) => server.once('exit', resolve))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
