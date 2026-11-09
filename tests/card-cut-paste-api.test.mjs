import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { cardMoveRequestId, resolveCardMove } from '../src/utils/cardMove.mjs'

const source = 'map-bench-0', target = 'map-bench-1'
async function setup(t) {
  return storageApi(t, { documents: 3, seed: async ({ data }) => {
    const map = fixture(target)
    map.nodes.forEach((n) => { n.id = `target-${n.id}` })
    map.edges.forEach((e) => { e.id = `target-${e.id}`; e.source = `target-${e.source}`; e.target = `target-${e.target}` })
    await writeFile(path.join(data, `${target}.json`), JSON.stringify(map))
    const src = fixture(source)
    src.nodes[1].data.aiConversationId = 'move-conversation'
    src.nodes[1].data.aiConversations = [{ conversationId: 'move-conversation', title: '보존할 대화' }]
    src.edges.find((e) => e.target === 'card-2').source = 'card-1'
    await writeFile(path.join(data, `${source}.json`), JSON.stringify(src))
  } })
}
const request = (overrides = {}) => ({ requestId: cardMoveRequestId(), sourceMapId: source, body: {
  cardIds: ['card-1', 'card-2', 'card-3'], sourceVersion: 1, targetVersion: 1,
  targetMapId: target, targetParentCardId: 'target-card-0', responseMode: 'full', ...overrides } })
const adapter = (api) => (url, init) => fetch(api.base + url, { ...init, headers: { ...api.headers, ...init.headers } })

test('다중 이동 응답 유실 후 실제 결과 조회와 반복 호출은 한 번의 이동만 확정한다', async (t) => {
  const api = await setup(t), req = request(), fetchImpl = adapter(api)
  await api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-2', text: '보존할 하위 댓글' })
  let posts = 0
  const result = await resolveCardMove(req, { delay: async () => {}, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init)
    if (init.method === 'POST' && posts++ === 0) { await response.text(); throw Error('응답 유실') }
    return response
  } })
  assert.equal(result.state, 'committed', JSON.stringify(result) + api.output())
  assert.equal(posts, 1)
  assert.deepEqual(result.body.movedRootCardIds, ['card-1', 'card-3'])
  const before = await api.read(`${target}.json`)
  const replay = await resolveCardMove(req, { fetchImpl, delay: async () => {} })
  assert.equal(replay.body.operation.id, result.body.operation.id)
  assert.deepEqual(await api.read(`${target}.json`), before)
  assert.equal((await api.read(`${source}.json`)).nodes.some((n) => req.body.cardIds.includes(n.id)), false)
  assert.equal(before.nodes.find((n) => n.id === 'card-1').data.aiConversationId, 'move-conversation')
  assert.equal((await api.read(`_comments/${target}.json`))[0].nodeId, 'card-2')
})

test('다중 이동의 버전 충돌은 원본과 대상 모두 변경하지 않는다', async (t) => {
  const api = await setup(t), before = await Promise.all([api.read(`${source}.json`), api.read(`${target}.json`)])
  const result = await resolveCardMove(request({ sourceVersion: 999 }), { fetchImpl: adapter(api), delay: async () => {} })
  assert.equal(result.state, 'rejected', JSON.stringify(result))
  assert.equal(result.body.code, 'VERSION_CONFLICT')
  assert.deepEqual(await Promise.all([api.read(`${source}.json`), api.read(`${target}.json`)]), before)
})

test('같은 문서에서 여러 카드 이동은 버전 하나만 올리고 대화와 댓글을 그대로 보존한다', async (t) => {
  const api = await setup(t)
  await api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-2', text: '같은 문서 댓글' })
  const comments = await api.read(`_comments/${source}.json`)
  const result = await resolveCardMove(request({ targetMapId: source, targetParentCardId: 'card-4' }), { fetchImpl: adapter(api), delay: async () => {} })
  assert.equal(result.state, 'committed', JSON.stringify(result) + api.output())
  const after = await api.read(`${source}.json`)
  assert.equal(after.version, 2)
  assert.equal(after.nodes.length, 20)
  assert.equal(after.edges.filter((e) => e.source === 'card-4').length, 2)
  assert.deepEqual(await api.read(`_comments/${source}.json`), comments)
})

test('휴지통 문서에 남아 있는 Ref를 이유로 이동할 때 문서를 몰래 복원하지 않는다', async (t) => {
  const api = await setup(t), referenceId = 'map-bench-2'
  const map = (await api.call(`/api/maps/${referenceId}`)).body.map
  map.nodes[1].data.reference = { mapId: source, nodeId: 'card-1' }
  assert.equal((await api.call(`/api/maps/${referenceId}`, 'PUT', { map, baseVersion: map.version, baseLifecycleVersion: map.lifecycleVersion ?? 0 })).status, 200)
  assert.equal((await api.call(`/api/maps/${referenceId}`, 'DELETE')).status, 200)
  const before = await Promise.all([api.read(`${source}.json`), api.read(`${target}.json`), api.read(`${referenceId}.json`)])
  const result = await resolveCardMove(request(), { fetchImpl: adapter(api), delay: async () => {} })
  assert.equal(result.state, 'rejected', JSON.stringify(result))
  assert.equal(result.body.code, 'CARD_MOVE_REFERENCE_DOCUMENT_UNAVAILABLE')
  assert.deepEqual(await Promise.all([api.read(`${source}.json`), api.read(`${target}.json`), api.read(`${referenceId}.json`)]), before)
})

test('다중 이동 도중 서버 종료 후 재시작하면 전체 이동과 같은 요청 결과가 복구된다', async (t) => {
  const api = await setup(t), req = request()
  await api.crash('after-file', { index: 0 })
  await adapter(api)(`/api/maps/${source}/cards/card-1/move`, { method: 'POST', body: JSON.stringify(req.body),
    headers: { 'Idempotency-Key': req.requestId, 'X-MNP-Write-Map-Id': source, 'X-MNP-Write-Card-Id': 'card-1' } }).catch(() => null)
  await api.restart()
  const result = await resolveCardMove(req, { fetchImpl: adapter(api), resultOnly: true, delay: async () => {} })
  assert.equal(result.state, 'committed', JSON.stringify(result) + api.output())
  const from = await api.read(`${source}.json`), to = await api.read(`${target}.json`)
  for (const id of req.body.cardIds) {
    assert.equal(from.nodes.some((n) => n.id === id), false)
    assert.equal(to.nodes.filter((n) => n.id === id).length, 1)
  }
  const intent = await api.read(`_storage-transactions/${result.body.transactionId}/intent.json`)
  assert.ok(intent.files.length > 2)
  assert.ok((await readFile(path.join(api.data, '_card-move-operations.json'), 'utf8')).includes(result.body.operation.id))
})
