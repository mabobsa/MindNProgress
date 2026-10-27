import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { reconstructionLayoutFixture } from './helpers/reconstructionLayoutFixture.mjs'

const source = 'map-bench-0', target = 'map-bench-1'
async function moveSeed({ data }) {
  const map = fixture(target)
  map.nodes.forEach((node) => { node.id = `target-${node.id}` })
  map.edges.forEach((edge) => { edge.source = `target-${edge.source}`; edge.target = `target-${edge.target}` })
  await writeFile(path.join(data, `${target}.json`), JSON.stringify(map))
  const ref = fixture('map-bench-3')
  ref.nodes[1].data.reference = { mapId: source, nodeId: 'card-1' }
  await writeFile(path.join(data, `${ref.id}.json`), JSON.stringify(ref))
}
const move = (api, sourceMapId = source, targetMapId = target, cardId = 'card-1', targetParentCardId = 'target-card-0', sourceVersion = 1, targetVersion = 1) =>
  api.call(`/api/maps/${sourceMapId}/cards/${cardId}/move`, 'POST', { targetMapId, targetParentCardId, sourceVersion, targetVersion })

test('댓글 확정·카드 이동·Ref 수정과 반대 방향 이동은 직렬 순서에 맞게 보존된다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 5, seed: moveSeed })
  const barrier = await api.barrier(`_comments/${source}.json`, 'rename')
  const commentRequest = api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '이동 전 성공 댓글' })
  await barrier.reached
  const moving = move(api)
  const independent = await api.call('/api/maps/map-bench-2/comments', 'POST', { nodeId: 'card-1', text: '전환 중 독립 처리' })
  assert.equal(independent.status, 201)
  barrier.release()
  const comment = await commentRequest
  assert.equal(comment.status, 201)
  const moved = await moving
  assert.equal(moved.status, 200, JSON.stringify(moved) + api.output())
  assert.equal(moved.body.operation.movedCommentCount, 1)
  assert.equal((await api.read(`_comments/${target}.json`))[0].id, comment.body.comment.id)
  assert.equal((await api.read('map-bench-3.json')).nodes[1].data.reference.mapId, target)
  const [forward, reverse] = await Promise.all([
    move(api, source, target, 'card-2', 'target-card-0', 2, 2),
    move(api, target, source, 'target-card-1', 'card-0', 2, 2),
  ])
  assert.deepEqual([forward.status, reverse.status].sort(), [200, 409])
  const winner = forward.status === 200 ? forward : reverse
  const destination = await api.read(`${winner.body.targetMapId}.json`)
  assert.ok(destination.nodes.some((node) => node.id === winner.body.movedCardId))
  assert.equal((await api.read(`_comments/${target}.json`))[0].id, comment.body.comment.id)
})

test('다중 문서 반영 중 실패하면 파일·댓글·이력·새 조회를 이전 상태로 복구한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 5, seed: moveSeed })
  assert.equal((await api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '실패해도 보존' })).status, 201)
  const paths = [`${source}.json`, `${target}.json`, 'map-bench-3.json', `_comments/${source}.json`, '_notifications/user-second.json']
  const before = await Promise.all(paths.map((file) => readFile(path.join(api.data, file))))
  const barrier = await api.barrier(`${source}.json`, 'rename', { fail: true })
  const moving = move(api)
  await barrier.reached
  let readFinished = false
  const query = api.call(`/api/maps/${target}`).then((r) => { readFinished = true; return r })
  assert.equal((await api.call('/api/maps/map-bench-2', 'PATCH', { title: '복구 중 독립 문서', baseVersion: 1 })).status, 200)
  assert.equal(readFinished, false)
  barrier.release()
  assert.equal((await moving).status, 500)
  assert.equal((await query).body.map.version, 1)
  // 다른 문서의 새 알림은 정상 후속 변경이므로 알림 파일은 효과 ID로 대조한다.
  for (let i = 0; i < paths.length - 1; i++) assert.deepEqual(await readFile(path.join(api.data, paths[i])), before[i], paths[i])
  const notifications = await api.read('_notifications/user-second.json')
  for (const old of JSON.parse(before.at(-1))) assert.deepEqual(notifications.find((item) => item.id === old.id), old)
  assert.equal((await api.call(`/api/maps/${source}/history`)).body.revisions.length, 0)
  assert.equal((await api.call(`/api/maps/${target}/history`)).body.revisions.length, 0)
  assert.equal((await move(api)).status, 200, '복구 후 같은 자원으로 다시 작업할 수 있다')
})

test('보관·휴지통·복원은 진행 중 댓글 저장과 교차해도 성공 결과와 수명주기 버전을 보존한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const barrier = await api.barrier(`_comments/${source}.json`, 'rename')
  const comment = api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '보관 직전 확정' })
  await barrier.reached
  const archive = api.call(`/api/maps/${source}/archive`, 'PATCH', { baseVersion: 1, baseLifecycleVersion: 0, archived: true })
  assert.equal((await api.call(`/api/maps/${target}/comments`, 'POST', { nodeId: 'card-1', text: '보관 중 독립' })).status, 201)
  barrier.release()
  assert.equal((await comment).status, 201)
  assert.equal((await archive).status, 200)
  assert.equal((await api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '거부할 댓글' })).status, 409)
  assert.equal((await api.read(`_comments/${source}.json`)).length, 1)
  assert.equal((await api.call(`/api/maps/${source}/archive`, 'PATCH', { baseVersion: 1, baseLifecycleVersion: 1, archived: false })).status, 200)
  const trash = await api.call(`/api/maps/${source}`, 'DELETE')
  assert.equal(trash.status, 200, JSON.stringify(trash) + api.output())
  assert.equal((await api.call('/api/maps/trash')).body.maps.find((map) => map.id === source).lifecycleVersion, 3)
  const restored = await api.call(`/api/maps/${source}/restore`, 'POST', {})
  assert.equal(restored.status, 200)
  assert.equal(restored.body.map.lifecycleVersion, 4)
  assert.equal((await api.read(`_comments/${source}.json`)).length, 1)
})

async function verifiedReconstruction(api, id) {
  const context = (await api.call(`/api/document-reconstructions/context?mapId=${source}`)).body
  const map = (await api.call(`/api/maps/${source}`)).body.map
  const plan = { id, mode: 'compact', baseline: '현재 요구사항', reason: '격리 동시성 검증',
    sources: context.sources, groupBaselines: context.groupBaselines, targets: [{ key: 'next', title: '후속 문서', nodes: map.nodes, edges: map.edges }],
    decisions: map.nodes.map((node) => ({ mapId: source, cardId: node.id, disposition: 'carry', reason: '요구사항 보존', targets: [{ key: 'next', cardId: node.id }] })),
    approval: { statement: '격리 시험에서 전환합니다.', source: '자동 회귀 시험' } }
  let preview = await api.call('/api/document-reconstructions/preview', 'POST', { plan })
  for (const action of ['measure-layout', 'verify-layout']) {
    assert.equal(preview.status, 200, JSON.stringify(preview))
    preview = await api.call(`/api/document-reconstructions/${action}`, 'POST', { plan, previewHash: preview.body.previewHash, measurements: reconstructionLayoutFixture(preview.body) })
  }
  assert.equal(preview.status, 200, JSON.stringify(preview))
  return { plan, previewHash: preview.body.previewHash, targetId: preview.body.targets[0].map.id }
}

test('검증된 재구성안 뒤에 먼저 확정된 댓글이 있으면 전환을 충돌로 거부한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const { plan, previewHash } = await verifiedReconstruction(api, 'storage-race')
  const barrier = await api.barrier(`_comments/${source}.json`, 'rename')
  const commenting = api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '전환 검토 이후 확정' })
  await barrier.reached
  const applying = api.call('/api/document-reconstructions/apply', 'POST', { plan, previewHash })
  assert.equal((await api.call(`/api/maps/${target}/comments`, 'POST', { nodeId: 'card-1', text: '재구성 중 독립' })).status, 201)
  barrier.release()
  assert.equal((await commenting).status, 201)
  const rejected = await applying
  assert.equal(rejected.status, 409, JSON.stringify(rejected) + api.output())
  assert.equal(rejected.body.code, 'RECONSTRUCTION_STALE')
  assert.equal((await api.read(`_comments/${source}.json`)).length, 1)
  assert.equal(Boolean((await api.call(`/api/maps/${source}`)).body.map.archivedAt), false)
})

test('재구성 파일 교체 실패는 후보 문서와 수명주기를 복구하고 후속 저장을 보존한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const { plan, previewHash, targetId } = await verifiedReconstruction(api, 'storage-failure')
  const original = await readFile(path.join(api.data, `${source}.json`))
  const barrier = await api.barrier(`${targetId}.json`, 'rename', { fail: true })
  const applying = api.call('/api/document-reconstructions/apply', 'POST', { plan, previewHash })
  await barrier.reached
  let finished = false
  const comment = api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '실패 복구 뒤 저장' })
    .then((r) => { finished = true; return r })
  assert.equal((await api.call(`/api/maps/${target}`, 'PATCH', { title: '전환과 독립', baseVersion: 1 })).status, 200)
  assert.equal(finished, false)
  barrier.release()
  assert.equal((await applying).status, 500)
  assert.equal((await comment).status, 201)
  assert.deepEqual(await readFile(path.join(api.data, `${source}.json`)), original)
  await assert.rejects(readFile(path.join(api.data, `${targetId}.json`)), { code: 'ENOENT' })
  assert.equal(Boolean((await api.call(`/api/maps/${source}`)).body.map.archivedAt), false)
  assert.equal((await api.call('/api/document-reconstructions')).body.operations.length, 0)
  const next = await verifiedReconstruction(api, 'storage-success')
  const changed = await api.call('/api/document-reconstructions/apply', 'POST', { plan: next.plan, previewHash: next.previewHash })
  assert.equal(changed.status, 200, JSON.stringify(changed) + api.output())
  assert.equal((await api.read(`_comments/${source}.json`)).length, 1)
})

test('Ref 추가가 이동보다 먼저 확정되면 새 Ref도 이동 대상으로 함께 고친다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 5, seed: moveSeed })
  const map = (await api.call('/api/maps/map-bench-4')).body.map
  map.nodes[1].data.reference = { mapId: source, nodeId: 'card-1' }
  const barrier = await api.barrier('map-bench-4.json', 'rename')
  const reference = api.call('/api/maps/map-bench-4', 'PUT', { baseVersion: 1, baseLifecycleVersion: 0, map })
  await barrier.reached
  let moved = false
  const moving = move(api).then((r) => { moved = true; return r })
  assert.equal((await api.call('/api/maps/map-bench-2', 'PATCH', { title: 'Ref 전환과 독립', baseVersion: 1 })).status, 200)
  assert.equal(moved, false)
  barrier.release()
  assert.equal((await reference).status, 200)
  assert.equal((await moving).status, 200)
  for (const id of ['map-bench-3', 'map-bench-4']) assert.equal((await api.read(`${id}.json`)).nodes[1].data.reference.mapId, target)
})

test('영구 삭제 실패와 복원 경쟁은 휴지통 원본을 회복하고 성공 삭제 뒤 복원을 거부한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  assert.equal((await api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '삭제 검증 댓글' })).status, 201)
  assert.equal((await api.call(`/api/maps/${source}`, 'DELETE')).status, 200)
  for (const fail of [true, false]) {
    const barrier = await api.barrier(`${source}.json`, 'rm', { fail })
    const deleting = api.call('/api/maps/trash', 'DELETE', { mapIds: [source] })
    await barrier.reached
    let restored = false
    const restoring = api.call(`/api/maps/${source}/restore`, 'POST', {}).then((r) => { restored = true; return r })
    const other = (await api.call(`/api/maps/${target}`)).body.map
    assert.equal((await api.call(`/api/maps/${target}`, 'PATCH', { title: `삭제와 독립 ${fail}`, baseVersion: other.version })).status, 200)
    assert.equal(restored, false)
    barrier.release()
    assert.equal((await deleting).status, fail ? 500 : 200)
    assert.equal((await restoring).status, fail ? 200 : 404)
    if (fail) {
      assert.equal((await api.read(`_comments/${source}.json`))[0].text, '삭제 검증 댓글')
      assert.equal((await api.call(`/api/maps/${source}`, 'DELETE')).status, 200)
    } else await assert.rejects(readFile(path.join(api.data, `${source}.json`)), { code: 'ENOENT' })
  }
})
