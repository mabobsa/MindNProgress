import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, scryptSync } from 'node:crypto'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { seedReadFixture } from './helpers/read-cost-fixture.mjs'
import { buildDocumentView } from '../mcp/documentViews.mjs'
import { imageCardLocalAccess } from '../mcp/imageAccess.mjs'
import { buildSharedKnowledgeReviewContext } from '../server/lib/sharedKnowledgeMaintenance.mjs'
import { reviewContextToken } from '../server/lib/contentPreconditions.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'
import { newStorageRequestId } from '../server/lib/storageJournal.mjs'

async function patch(api, id, cardId, dataSet) {
  const before = (await api.call(`/api/maps/${id}`)).body.map
  const next = structuredClone(before)
  Object.assign(next.nodes.find((node) => node.id === cardId).data, dataSet)
  const result = await api.call(`/api/maps/${id}/content-patch`, 'PATCH', { baseVersion: before.version,
    patch: createMapContentPatch(before, next) })
  assert.equal(result.status, 200, JSON.stringify(result))
}

test('선택 카드·문서 표현·댓글 페이지·검토 토큰은 전체 조회와 같다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 8, seed: seedReadFixture })
  for (const id of api.ids.slice(0, 2)) {
    const full = (await api.call(`/api/maps/${id}`)).body
    for (const view of ['full', 'compact', 'outline', 'version']) {
      const cardIds = view === 'outline' ? ['card-1', 'card-3'] : undefined
      const query = new URLSearchParams({ mcpView: view }); cardIds?.forEach((card) => query.append('cardId', card))
      const selected = await api.call(`/api/maps/${id}?${query}`)
      assert.equal(selected.status, 200, JSON.stringify(selected))
      assert.deepEqual(selected.body, JSON.parse(JSON.stringify(buildDocumentView(full, { view, cardIds, publicBaseUrl: api.base,
        imageAccessOf: (mapId, node) => imageCardLocalAccess(api.data, mapId, node) }))))
    }
    const comments = (await api.call(`/api/maps/${id}/comments?nodeId=card-1&includeDetail=false`)).body.comments
    for (const order of ['asc', 'desc']) {
      const selected = await api.call(`/api/maps/${id}?readCard=card-1&commentOffset=1&commentLimit=2&commentOrder=${order}`)
      assert.equal(selected.status, 200, JSON.stringify(selected))
      assert.deepEqual(selected.body.map.nodes, full.map.nodes.filter((node) => node.id === 'card-1'))
      assert.deepEqual(selected.body.comments, (order === 'asc' ? comments : [...comments].reverse()).slice(1, 3))
      assert.deepEqual(selected.body.commentsPage, { total: 5, offset: 1, limit: 2, order, hasMore: true, nextOffset: 3 })
    }
  }
  const id = api.ids[0], map = (await api.call(`/api/maps/${id}`)).body.map
  const comments = (await api.call(`/api/maps/${id}/comments?nodeId=card-1`)).body.comments
  const context = (await api.call(`/api/maps/${id}/cards/card-1/shared-knowledge-review-context`)).body.context
  const expected = buildSharedKnowledgeReviewContext(map, 'card-1')
  for (const key of Object.keys(expected)) assert.deepEqual(context[key], expected[key])
  assert.deepEqual(context.reviewContextToken, reviewContextToken(map, 'card-1', comments))
})

test('원본·댓글·Ref 원본과 원본 댓글·그룹·수명주기 변경을 즉시 반영한다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 8, seed: seedReadFixture }), id = api.ids[1], source = api.ids[3]
  const query = `/api/maps/${id}?mcpView=outline&cardId=card-1`
  let before = (await api.call(query)).body
  assert.equal((await api.call(`${query}&ifNoneMatch=${before.documentEtag}`)).body.notModified, true)
  await patch(api, source, 'card-1', { description: '변경된 Ref 원본', sharedKnowledge: '바뀐 원본 지식' })
  let after = (await api.call(`${query}&ifNoneMatch=${before.documentEtag}`)).body
  assert.notEqual(after.documentEtag, before.documentEtag)
  assert.equal(after.selectedCards[0].data.description, '변경된 Ref 원본')
  before = after
  assert.equal((await api.call(`/api/maps/${source}/comments`, 'POST', { nodeId: 'card-1', text: '원본 댓글 추가' })).status, 201)
  after = (await api.call(`${query}&ifNoneMatch=${before.documentEtag}`)).body
  assert.notEqual(after.documentEtag, before.documentEtag)
  assert.equal(after.referenceCommentStats['card-1'].total, 6)
  assert.equal((await api.call(`/api/maps/${id}/comments`, 'POST', { nodeId: 'card-1', text: '로컬 댓글 추가' })).status, 201)
  assert.equal((await api.call(`/api/maps/${id}?readCard=card-1`)).body.commentsPage.total, 6)
  await patch(api, id, 'card-0', { description: '로컬 원문 변경' })
  assert.equal((await api.call(`/api/maps/${id}?readCard=card-0`)).body.map.nodes[0].data.description, '로컬 원문 변경')
  const layout = (await api.call('/api/maps')).body.documentLayout
  const moved = { ...layout, groups: [{ id: 'group-read', name: '조회 검증 그룹', mapIds: [id] }],
    items: layout.items.filter((item) => item.id !== id && item.mapId !== id) }
  // 실제 저장 API의 현재 배치 규격으로 모든 문서를 정확히 한 번 배치한다.
  const response = await api.call('/api/maps/layout', 'PATCH', { documentLayout: {
    version: 1, groups: moved.groups, items: [{ type: 'group', id: 'group-read' }, ...api.ids.filter((value) => value !== id).map((value) => ({ type: 'map', id: value }))],
  } })
  assert.equal(response.status, 200, JSON.stringify(response))
  before = after
  after = (await api.call(`${query}&ifNoneMatch=${before.documentEtag}`)).body
  assert.equal(after.group?.name, '조회 검증 그룹')
  assert.notEqual(after.documentEtag, before.documentEtag)
  const preview = (await api.call(`/api/maps/${source}/trash-preview`)).body
  const trashed = await api.call(`/api/maps/${source}`, 'DELETE', { referenceVersion: preview.referenceVersion })
  assert.equal(trashed.status, 200, JSON.stringify(trashed))
  assert.ok((await api.call(query)).body.unresolvedReferenceNodeIds.includes('card-1'))
  assert.equal((await api.call(`/api/maps/${source}/restore`, 'POST', {})).status, 200)
  assert.equal((await api.call(query)).body.selectedCards[0].data.description, '변경된 Ref 원본')
  for (const archived of [true, false]) {
    const latest = (await api.call(`/api/maps/${source}`)).body.map
    const archive = await api.call(`/api/maps/${source}/archive`, 'PATCH', { archived, baseVersion: latest.version,
      baseLifecycleVersion: latest.lifecycleVersion ?? 0, reason: '조회 수명주기 회귀' })
    assert.equal(archive.status, 200, JSON.stringify(archive))
    const projected = (await api.call(`/api/maps/${source}?mcpView=outline`)).body
    assert.equal(Boolean(projected.map.archivedAt), archived)
    assert.equal(projected.groupMembership, archived ? 'archived' : 'ungrouped')
    assert.equal((await api.call(query)).body.selectedCards[0].data.description, '변경된 Ref 원본')
  }
})

test('비어 있지 않은 위임 목록의 정렬·조건부 응답·현재 권한·일정 중복 제거를 보존한다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 8, seed: seedReadFixture }), id = api.ids[7]
  const route = `${api.base}/api/maps/${id}/ai-delegations?includeResult=true`
  const first = await fetch(route, { headers: api.headers }), etag = first.headers.get('etag'), body = await first.json()
  assert.equal(body.delegations.length, 200)
  assert.equal(body.delegations[0].id, 'delegation-read-199')
  assert.equal((await fetch(route, { headers: { ...api.headers, 'If-None-Match': etag } })).status, 304)
  await patch(api, id, 'card-19', { progress: 100, status: 'done' })
  const changed = await fetch(route, { headers: { ...api.headers, 'If-None-Match': etag } })
  assert.equal(changed.status, 200)
  assert.equal((await changed.json()).delegations[0].taskCompletion.state, 'completed')
  const other = await fetch(route, { headers: { ...api.headers, 'X-MNP-AI-Editor-Id': 'user-second', 'If-None-Match': changed.headers.get('etag') } })
  assert.equal(other.status, 200, '다른 주체의 조건부 결과를 공유하지 않는다')
  const denied = await fetch(route, { headers: { 'If-None-Match': etag } })
  assert.notEqual(denied.status, 304)
  assert.ok([401, 403].includes(denied.status))
  const firstNotifications = (await api.call('/api/notifications')).body.notifications
  const repeated = await Promise.all(Array.from({ length: 20 }, () => api.call('/api/notifications')))
  for (const result of repeated) assert.deepEqual(result.body.notifications, firstNotifications)
  assert.equal(firstNotifications.filter((n) => n.type === 'schedule').length, 19)
  await patch(api, id, 'card-19', { progress: 0, status: 'planned' })
  assert.equal((await api.call('/api/notifications')).body.notifications.filter((n) => n.type === 'schedule').length, 20)
  // 권한 정본을 정지 상태에서 바꾸고 재시작한다. 운영 파일과 토큰은 사용하지 않는다.
  await api.stop()
  const users = JSON.parse(await readFile(path.join(api.data, '_users.json'), 'utf8'))
  users.find((user) => user.id === 'user-editor').role = 'viewer'
  await writeFile(path.join(api.data, '_users.json'), JSON.stringify(users))
  await writeFile(path.join(api.data, '_sessions.json'), JSON.stringify([{ tokenHash: createHash('sha256').update('read-test-viewer').digest('hex'),
    userId: 'user-editor', expiresAt: Date.now() + 60000 }]))
  await api.restart()
  assert.equal((await fetch(route, { headers: { Cookie: 'mnp_session=read-test-viewer', 'If-None-Match': etag } })).status, 403)
})

test('Ref 저장 확정 중 조회는 중간값을 내보내지 않고 독립 문서는 계속 처리한다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 8, seed: seedReadFixture }), id = api.ids[1], source = api.ids[3]
  await api.call(`/api/maps/${id}?readCard=card-1`)
  const barrier = await api.barrier(`${source}.json`, 'rename')
  const writing = patch(api, source, 'card-1', { description: '확정 뒤 Ref 원문' })
  await barrier.reached
  let resolved = false
  const reading = api.call(`/api/maps/${id}?readCard=card-1`).then((value) => { resolved = true; return value })
  const independent = await api.call(`/api/maps/${api.ids[0]}/comments`, 'POST', { nodeId: 'card-1', text: '독립 쓰기' })
  assert.equal(independent.status, 201)
  assert.equal(resolved, false)
  barrier.release(); await writing
  assert.equal((await reading).body.map.nodes[0].data.description, '확정 뒤 Ref 원문')
  const after = await api.call(`/api/maps/${id}?readCard=card-1`)
  assert.equal(after.body.map.nodes[0].data.description, '확정 뒤 Ref 원문')
})

test('이력 복원·커밋 뒤 재시작 복구·삭제가 선택 조회 캐시에 반영된다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 8, seed: seedReadFixture }), id = api.ids[0]
  const before = (await api.call(`/api/maps/${id}?readCard=card-1`)).body
  await patch(api, id, 'card-1', { description: '복원 전 변경' })
  await api.call(`/api/maps/${id}?readCard=card-1`)
  const revision = (await api.call(`/api/maps/${id}/history`)).body.revisions[0]
  const map = (await api.call(`/api/maps/${id}`)).body.map
  assert.equal((await api.call(`/api/maps/${id}/history/${revision.id}/restore`, 'POST', {
    baseVersion: map.version, baseLifecycleVersion: map.lifecycleVersion ?? 0, expectedSnapshotSha256: revision.snapshotSha256,
  })).status, 200)
  assert.equal((await api.call(`/api/maps/${id}?readCard=card-1`)).body.map.nodes[0].data.description, before.map.nodes[0].data.description)
  const requestId = newStorageRequestId()
  await api.crash('after-file', { index: 0 })
  await api.call(`/api/maps/${id}/comments`, 'POST', { nodeId: 'card-1', text: '재시작 복구 댓글' }, { 'Idempotency-Key': requestId }).catch(() => null)
  await api.restart()
  const recovered = await api.call(`/api/maps/${id}?readCard=card-1&includeCommentDetail=true`)
  assert.ok(recovered.body.comments.some((item) => item.text === '재시작 복구 댓글'))
  assert.equal((await api.call(`/api/maps/${id}`, 'DELETE')).status, 200)
  assert.equal((await api.call(`/api/maps/${id}?readCard=card-1`)).status, 404)
  assert.equal((await api.call('/api/maps/trash', 'DELETE', { mapIds: [id] })).status, 200)
  assert.equal((await api.call(`/api/maps/${id}?mcpView=outline`)).status, 404)
})

test('캐시를 채운 편집자의 권한을 회수하면 같은 세션의 조건부 조회도 거부한다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 8, seed: async (args) => {
    await seedReadFixture(args)
    const file = path.join(args.data, '_users.json'), users = JSON.parse(await readFile(file, 'utf8'))
    users[0].passwordHash = scryptSync('ReadTestOnly!2026', users[0].salt, 64).toString('hex')
    await writeFile(file, JSON.stringify(users))
  } })
  const login = async (email, password) => {
    const response = await fetch(`${api.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
    assert.equal(response.status, 200); await response.text(); return response.headers.get('set-cookie').split(';')[0]
  }
  const cookie = await login('editor@mind.local', 'ReadTestOnly!2026')
  const route = `${api.base}/api/maps/${api.ids[7]}/ai-delegations`
  const first = await fetch(route, { headers: { Cookie: cookie } }), etag = first.headers.get('etag'); await first.text()
  assert.equal((await fetch(route, { headers: { Cookie: cookie, 'If-None-Match': etag } })).status, 304)
  assert.equal((await fetch(`${api.base}/api/maps/${api.ids[0]}?readCard=card-1`, { headers: { Cookie: cookie } })).status, 200)
  const adminCookie = await login('isolated@mind.local', 'IsolatedOnly!2026')
  const changed = await fetch(`${api.base}/api/admin/editors/user-editor`, { method: 'PATCH', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) })
  assert.equal(changed.status, 200, await changed.text())
  assert.equal((await fetch(route, { headers: { Cookie: cookie, 'If-None-Match': etag } })).status, 401)
  assert.equal((await fetch(`${api.base}/api/maps/${api.ids[0]}?readCard=card-1`, { headers: { Cookie: cookie } })).status, 401)
})

test('그룹 설정 조회 중 배치 변경은 재검증하고 다른 문서 영구 삭제는 선택 조회를 막지 않는다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), [id, deleted] = api.ids
  const layout = { version: 1, groups: [{ id: 'group-race', name: '변경 전', mapIds: [id] }],
    items: [{ type: 'group', id: 'group-race' }, ...api.ids.slice(1).map((id) => ({ type: 'map', id }))] }
  assert.equal((await api.call('/api/maps/layout', 'PATCH', { documentLayout: layout })).status, 200)
  const readingGroup = await api.barrier('_group-projects/group-race.json', 'readFile')
  const reading = api.call(`/api/maps/${id}?readCard=card-1`)
  await readingGroup.reached
  layout.groups[0].name = '변경 후'
  assert.equal((await api.call('/api/maps/layout', 'PATCH', { documentLayout: layout })).status, 200)
  readingGroup.release()
  const result = await reading
  assert.equal(result.status, 200, JSON.stringify(result))
  assert.equal(result.body.group.name, '변경 후')
  assert.equal((await api.call(`/api/maps/${deleted}`, 'DELETE')).status, 200)
  const removing = await api.barrier(`${deleted}.json`, 'rm')
  const deletion = api.call('/api/maps/trash', 'DELETE', { mapIds: [deleted] })
  await removing.reached
  assert.equal((await api.call(`/api/maps/${id}?readCard=card-1`)).status, 200)
  removing.release()
  assert.equal((await deletion).status, 200)
})
