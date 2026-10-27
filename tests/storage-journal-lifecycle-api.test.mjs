import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { reconstructionLayoutFixture } from './helpers/reconstructionLayoutFixture.mjs'
import { newStorageRequestId, storageHash } from '../server/lib/storageJournal.mjs'

const source = 'map-bench-0', target = 'map-bench-1'
async function prepare(t, kind) {
  const api = await storageApi(t, { documents: 5, seed: async ({ data }) => {
    const map = fixture(target)
    map.nodes.forEach((node) => { node.id = `target-${node.id}` })
    map.edges.forEach((edge) => { edge.source = `target-${edge.source}`; edge.target = `target-${edge.target}` })
    await writeFile(path.join(data, `${target}.json`), JSON.stringify(map))
  } })
  const requestId = newStorageRequestId(), headers = { 'Idempotency-Key': requestId }
  const query = () => api.call('/api/maps', 'GET', undefined, { ...headers, 'X-MNP-Result-Only': '1' })
  let route, body, method = 'POST'
  if (kind === 'move') {
    await api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '이동할 댓글' })
    route = `/api/maps/${source}/cards/card-1/move`
    body = { targetMapId: target, targetParentCardId: 'target-card-0', sourceVersion: 1, targetVersion: 1 }
  } else if (kind === 'delete') {
    await api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '삭제할 댓글' })
    assert.equal((await api.call(`/api/maps/${source}`, 'DELETE')).status, 200)
    route = '/api/maps/trash'; method = 'DELETE'; body = { mapIds: [source] }
  } else if (kind === 'restore') {
    await api.call(`/api/maps/${source}`, 'PATCH', { title: '복원 전 변경', baseVersion: 1 })
    const revision = (await api.call(`/api/maps/${source}/history`)).body.revisions[0]
    route = `/api/maps/${source}/history/${revision.id}/restore`
    body = { baseVersion: 2, baseLifecycleVersion: 0, expectedSnapshotSha256: revision.snapshotSha256 }
  } else {
    const context = (await api.call(`/api/document-reconstructions/context?mapId=${source}`)).body
    const map = (await api.call(`/api/maps/${source}`)).body.map
    const plan = { id: 'crash-reconstruct', mode: 'compact', baseline: '현재 요구사항', reason: '격리 복구 검증',
      sources: context.sources, groupBaselines: context.groupBaselines,
      targets: [{ key: 'next', title: '복구 후속 문서', nodes: map.nodes, edges: map.edges }],
      decisions: map.nodes.map((node) => ({ mapId: source, cardId: node.id, disposition: 'carry', reason: '요구사항 보존', targets: [{ key: 'next', cardId: node.id }] })),
      approval: { statement: '격리 시험에서 전환합니다.', source: '자동 회귀 시험' } }
    let preview = await api.call('/api/document-reconstructions/preview', 'POST', { plan })
    for (const action of ['measure-layout', 'verify-layout']) {
      assert.equal(preview.status, 200, JSON.stringify(preview))
      preview = await api.call(`/api/document-reconstructions/${action}`, 'POST', { plan, previewHash: preview.body.previewHash, measurements: reconstructionLayoutFixture(preview.body) })
    }
    route = '/api/document-reconstructions/apply'; body = { plan, previewHash: preview.body.previewHash }
  }
  return { api, requestId, query, send: () => api.call(route, method, body, headers) }
}

for (const kind of ['move', 'restore', 'delete', 'reconstruct']) {
  test(`${kind}: 모든 정본 교체 사이 강제 종료와 재시작 복구`, { timeout: 240_000 }, async (t) => {
    let count = 0
    await t.test('commit marker 직후', async (sub) => {
      const setup = await prepare(sub, kind)
      await setup.api.crash('after-commit')
      await setup.send().catch(() => null)
      await setup.api.restart()
      const result = await setup.query()
      assert.equal(result.body.outcome, 'committed', JSON.stringify(result) + setup.api.output())
      const intent = await setup.api.read(`_storage-transactions/${result.body.transactionId}/intent.json`)
      count = intent.files.length
      assert.ok(count > 1)
    })
    for (let index = 0; index < count; index++) await t.test(`정본 ${index + 1}/${count} 교체 직후`, async (sub) => {
      const setup = await prepare(sub, kind), { api } = setup
      await api.crash('after-file', { index })
      await setup.send().catch(() => null)
      await api.restart()
      const result = await setup.query()
      assert.equal(result.body.outcome, 'committed', JSON.stringify(result) + api.output())
      const intent = await api.read(`_storage-transactions/${result.body.transactionId}/intent.json`)
      for (const entry of intent.files) {
        const bytes = await readFile(path.join(api.data, entry.path)).catch((e) => { if (e.code === 'ENOENT') return null; throw e })
        if (storageHash(bytes) !== entry.after && entry.image) {
          const expected = JSON.parse(await readFile(path.join(api.data, '_storage-transactions', result.body.transactionId, entry.image)))
          const actual = JSON.parse(bytes)
          const differences = []
          const compare = (a, b, p = '') => {
            if (JSON.stringify(a) === JSON.stringify(b)) return
            if (a && b && typeof a === 'object' && typeof b === 'object') {
              for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], `${p}/${key}`)
            } else differences.push({ path: p, expected: a, actual: b })
          }
          compare(expected, actual)
          sub.diagnostic(JSON.stringify({ file: entry.path, differences }))
        }
        assert.equal(storageHash(bytes), entry.after, `${kind}: ${entry.path}`)
      }
      const replay = await setup.send()
      assert.equal(replay.body.transactionId, result.body.transactionId)
      assert.deepEqual(replay.body.sideEffectsPending, [])
      if (kind === 'delete') {
        assert.equal((await api.call(`/api/maps/${source}/restore`, 'POST', {})).status, 404)
        const denied = await api.call('/api/maps', 'GET', undefined, { 'Idempotency-Key': setup.requestId,
          'X-MNP-Result-Only': '1', 'X-MNP-AI-Editor-Id': 'user-second' })
        assert.equal(denied.status, 404); assert.equal(denied.body.deletedIds, undefined)
      }
    })
    t.diagnostic(JSON.stringify({ kind, canonicalFiles: count, crashes: count + 1 }))
  })
}

test('실제 시작 redo의 해시 불일치는 관련 읽기·쓰기를 격리하고 다른 문서를 계속 제공한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  await api.crash('after-commit')
  await api.call(`/api/maps/${source}`, 'PATCH', { title: '확정된 후보', baseVersion: 1 }, { 'Idempotency-Key': id }).catch(() => null)
  const map = await api.read(`${source}.json`); map.title = '해시 불일치 원문'
  const original = JSON.stringify(map)
  await writeFile(path.join(api.data, `${source}.json`), original)
  await api.restart()
  assert.equal((await api.call(`/api/maps/${source}`)).body.code, 'RECOVERY_REQUIRED')
  assert.equal((await api.call(`/api/maps/${source}`, 'PATCH', { title: '금지', baseVersion: 1 })).status, 503)
  assert.equal((await api.call(`/api/maps/${target}`)).status, 200)
  assert.equal(await readFile(path.join(api.data, `${source}.json`), 'utf8'), original)
  const result = await api.call('/api/maps', 'GET', undefined, { 'Idempotency-Key': id, 'X-MNP-Result-Only': '1' })
  assert.equal(result.status, 503); assert.equal(result.body.outcome, 'processing')
})
