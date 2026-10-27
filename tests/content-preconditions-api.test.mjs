import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { storageApi, fixture, actor } from './helpers/storage-api-harness.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'
import { createContentPreconditions, commentContentHash, commentResolvedHash, commentDeleteHash, digest } from '../server/lib/contentPreconditions.mjs'
import { textIntegrity } from '../mcp/cardTextPatch.mjs'

export function contentRequest(before, mutate) {
  const next = structuredClone(before); mutate(next)
  const patch = createMapContentPatch(before, next)
  return { baseVersion: before.version, patch, preconditions: createContentPreconditions(before, patch) }
}
const getMap = async (api, id) => (await api.call(`/api/maps/${id}`)).body.map
const save = (api, id, body) => api.call(`/api/maps/${id}/content-patch`, 'PATCH', body)
const review = (api, id, body) => api.call(`/api/maps/${id}/shared-knowledge/reviews`, 'POST', body)
const getContext = async (api, id, card = 'card-1') => {
  const r = await api.call(`/api/maps/${id}/cards/${card}/shared-knowledge-review-context`)
  assert.equal(r.status, 200, JSON.stringify(r)); return r.body.context
}
const reviewRequest = (context, replacement = '정리된 공유 지식') => ({ baseVersion: context.document.version, patches: [{
  cardId: context.card.id, expectedSha256: context.card.textIntegrity.sha256, reviewContextToken: context.reviewContextToken,
  reviewResult: 'cleaned', replacement,
}] })
async function effects(api, id) {
  const files = {}
  async function walk(relative) {
    try {
      for (const e of await readdir(path.join(api.data, relative), { withFileTypes: true })) {
        const file = path.join(relative, e.name)
        if (e.isDirectory()) await walk(file)
        else files[file] = (await readFile(path.join(api.data, file))).toString('base64')
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  files.map = await readFile(path.join(api.data, `${id}.json`), 'utf8')
  for (const dir of [`_history/${id}`, `_daily-backups/${id}`, '_notifications', '_comments']) await walk(dir)
  return files
}
async function rejectedWithoutEffects(api, id, call, reason) {
  const before = await effects(api, id)
  const r = await call()
  assert.equal(r.status, 409, JSON.stringify(r)); assert.equal(r.body.reasonCode, reason, JSON.stringify(r))
  assert.equal(r.body.outcome, 'not-applied'); assert.equal(r.body.retryable, false); assert.ok(r.body.conflicts.length)
  assert.deepEqual(await effects(api, id), before)
  assert.equal((await getMap(api, id)).version, JSON.parse(before.map).version)
  return r
}

test('새 카드·필드·검토 계약: 동시 1/10/20, 새 fixture 3회, 회당 독립 변경 20개를 모두 보존한다', { timeout: 300_000 }, async (t) => {
  const api = await storageApi(t, { seed: async ({ data, ids }) => {
    // 검토 의존성이 서로 겹치지 않는 카드. 연결된 검토는 아래 의존 충돌 시험에서 다룬다.
    for (const id of ids.slice(10)) { const map = fixture(id); map.edges = []; await writeFile(path.join(data, `${id}.json`), JSON.stringify(map)) }
    const ref = fixture(ids[1]); for (let i = 1; i < 20; i++) ref.nodes[i].data.reference = { mapId: ids[2 + i % 5], nodeId: `card-${i}` }
    await writeFile(path.join(data, `${ids[1]}.json`), JSON.stringify(ref))
    await writeFile(path.join(data, '_comments', `${ids[0]}.json`), JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
      id: `comment-${i}`, mapId: ids[0], nodeId: `card-${i % 20}`, text: '검증 댓글'.repeat(100), createdAt: '2026-10-26T00:00:00.000Z', author: actor,
    }))))
  } })
  let fixtureIndex = 10
  for (const mode of ['cards', 'fields', 'reviews']) for (const concurrency of [1, 10, 20]) for (let round = 0; round < 3; round++) {
    const id = api.ids[fixtureIndex++], before = await getMap(api, id)
    const expected = Array.from({ length: 20 }, (_, i) => ({ card: mode === 'fields' ? Math.floor(i / 2) : i,
      field: mode === 'fields' && i % 2 === 0 ? 'label' : mode === 'reviews' ? 'sharedKnowledge' : 'description', value: `보존 ${mode}/${concurrency}/${round}/${i}` }))
    const requests = []
    for (const e of expected) requests.push(mode === 'reviews'
      ? reviewRequest(await getContext(api, id, `card-${e.card}`), e.value)
      : contentRequest(before, (m) => { m.nodes[e.card].data[e.field] = e.value }))
    const responses = []
    for (let offset = 0; offset < 20; offset += concurrency) {
      const barrier = await api.barrier(`${id}.json`, 'rename')
      const send = (body) => mode === 'reviews' ? review(api, id, body) : save(api, id, body)
      const first = send(requests[offset]); await barrier.reached
      const rest = requests.slice(offset + 1, offset + concurrency).map(send)
      assert.equal((await api.call(`/api/maps/${api.ids[0]}`)).status, 200)
      barrier.release()
      responses.push(...await Promise.all([first, ...rest]))
    }
    assert.ok(responses.every((r) => r.status === 200), JSON.stringify(responses.filter((r) => r.status !== 200)) + api.output())
    const versions = responses.map((r) => r.body.map?.version ?? r.body.document.version)
    assert.deepEqual([...versions].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 2))
    for (const actual of [await api.read(`${id}.json`), await getMap(api, id)]) {
      assert.equal(actual.version, 21)
      for (const e of expected) assert.equal(actual.nodes.find((n) => n.id === `card-${e.card}`).data[e.field], e.value)
    }
    t.diagnostic(JSON.stringify({ mode, concurrency, round, success: 20, preserved: 20, version: 21, fixtureSha256: digest(before), resultSha256: digest(await api.read(`${id}.json`)) }))
  }
})

test('같은 before의 같은 필드는 승자 하나이며 거부된 변경은 파일·버전·이력·알림에 효과가 없다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = api.ids[0], before = await getMap(api, id)
  const a = contentRequest(before, (m) => { m.nodes[1].data.description = '승자 본문' })
  const b = contentRequest(before, (m) => { m.nodes[1].data.description = '거부할 본문' })
  const barrier = await api.barrier(`${id}.json`, 'rename')
  const first = save(api, id, a); await barrier.reached
  const second = save(api, id, b)
  assert.equal((await api.call(`/api/maps/${api.ids[1]}`)).status, 200)
  barrier.release(); assert.equal((await first).status, 200)
  const losing = await second; assert.equal(losing.status, 409); assert.equal(losing.body.reasonCode, 'FIELD_CONFLICT')
  const stable = await effects(api, id)
  await rejectedWithoutEffects(api, id, () => save(api, id, b), 'FIELD_CONFLICT')
  assert.deepEqual(await effects(api, id), stable)
  assert.equal((await getMap(api, id)).nodes[1].data.description, '승자 본문')
  assert.equal((await getMap(api, id)).version, 2)
  assert.ok(JSON.stringify(losing.body).length < 1200)
})

test('검토 문맥은 무관한 카드 변경을 허용하고 설명·종류·관계·댓글·Ref 원본 변경을 거부한다', { timeout: 60_000 }, async (t) => {
  const api = await storageApi(t, { documents: 12, seed: async ({ data, ids }) => {
    const m = fixture(ids[6]); m.nodes[0].data.reference = { mapId: ids[9], nodeId: 'card-1' }
    await writeFile(path.join(data, `${m.id}.json`), JSON.stringify(m))
  } })
  const independent = api.ids[0], ctx = await getContext(api, independent)
  assert.equal((await save(api, independent, contentRequest(await getMap(api, independent), (m) => { m.nodes[10].data.description = '무관한 변경' }))).status, 200)
  assert.equal((await review(api, independent, reviewRequest(ctx))).status, 200)
  const cases = [
    async (id) => save(api, id, contentRequest(await getMap(api, id), (m) => { m.nodes[1].data.description = '설명 변경' })),
    async (id) => save(api, id, contentRequest(await getMap(api, id), (m) => { m.nodes[1].data.kind = 'task' })),
    async (id) => save(api, id, contentRequest(await getMap(api, id), (m) => { m.edges[0].data.knowledgePolicy = 'inspect-if-insufficient' })),
    async (id) => api.call(`/api/maps/${id}/comments`, 'POST', { nodeId: 'card-1', summary: '관련 댓글', detail: '검토 근거 변경' }),
    async (id) => save(api, id, contentRequest(await getMap(api, id), (m) => { m.nodes[0].data.description = '부모 설명 변경' })),
    async () => save(api, api.ids[9], contentRequest(await getMap(api, api.ids[9]), (m) => { m.nodes[1].data.description = 'Ref 원본 설명 변경' })),
  ]
  for (let i = 0; i < cases.length; i++) {
    const id = api.ids[i + 1], context = await getContext(api, id)
    assert.ok([200, 201].includes((await cases[i](id)).status))
    await rejectedWithoutEffects(api, id, () => review(api, id, reviewRequest(context)), 'READ_DEPENDENCY_CHANGED')
  }
  const id = api.ids[7], original = await getContext(api, id)
  assert.equal((await save(api, id, contentRequest(await getMap(api, id), (m) => { m.nodes[1].data.sharedKnowledge = '다른 원문'.repeat(1000) }))).status, 200)
  const r = await rejectedWithoutEffects(api, id, () => review(api, id, reviewRequest(original)), 'FIELD_CONFLICT')
  assert.equal(r.body.code, 'SHARED_KNOWLEDGE_REVIEW_HASH_MISMATCH')
})

test('댓글 본문·해결·actor별 반응·답글 삭제 조건은 다른 댓글의 독립 변경을 보존한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = api.ids[0], route = `/api/maps/${id}/comments`
  const target = (await api.call(route, 'POST', { nodeId: 'card-1', summary: '요약', detail: '기존 상세' })).body.comment
  const item = `${route}/${target.id}`, contentHash = commentContentHash(target)
  assert.equal((await api.call(route, 'POST', { nodeId: 'card-2', text: '다른 댓글' })).status, 201)
  assert.equal((await api.call(item, 'PATCH', { detail: '새 상세', expectedContentSha256: contentHash })).status, 200)
  await rejectedWithoutEffects(api, id, () => api.call(item, 'PATCH', { detail: '덮어쓰기', expectedContentSha256: contentHash }), 'FIELD_CONFLICT')
  const resolved = { resolved: true, expectedResolvedSha256: commentResolvedHash(target) }
  assert.equal((await api.call(`${item}/resolve`, 'PATCH', resolved)).status, 200)
  await rejectedWithoutEffects(api, id, () => api.call(`${item}/resolve`, 'PATCH', resolved), 'FIELD_CONFLICT')
  assert.equal((await api.call(`${item}/reactions`, 'POST', { emoji: '👍', expectedReacted: false })).status, 200)
  assert.equal((await api.call(`${item}/reactions`, 'POST', { emoji: '👍', expectedReacted: false }, { 'X-MNP-AI-Editor-Id': 'user-second' })).status, 200)
  await rejectedWithoutEffects(api, id, () => api.call(`${item}/reactions`, 'POST', { emoji: '👍', expectedReacted: false }), 'FIELD_CONFLICT')
  const all = (await api.call(route)).body.comments, expectedDeleteSha256 = commentDeleteHash(all, target.id)
  assert.equal((await api.call(route, 'POST', { nodeId: 'card-1', parentId: target.id, text: '새 답글' })).status, 201)
  await rejectedWithoutEffects(api, id, () => api.call(item, 'DELETE', { expectedDeleteSha256 }), 'READ_DEPENDENCY_CHANGED')
})

test('레거시 버전·구조 변경·전체 교체는 엄격하며 본문 해시·경계는 보호 구간에서도 검사한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = api.ids[0], before = await getMap(api, id)
  const legacy = contentRequest(before, (m) => { m.nodes[1].data.label = '레거시' }); delete legacy.preconditions
  const structure = contentRequest(before, (m) => { m.nodes.reverse() })
  assert.equal((await save(api, id, contentRequest(before, (m) => { m.nodes[2].data.label = '다른 변경' }))).status, 200)
  await rejectedWithoutEffects(api, id, () => save(api, id, legacy), 'READ_DEPENDENCY_CHANGED')
  await rejectedWithoutEffects(api, id, () => save(api, id, structure), 'READ_DEPENDENCY_CHANGED')
  const put = await api.call(`/api/maps/${id}`, 'PUT', { baseVersion: 1, baseLifecycleVersion: 0, map: before })
  assert.equal(put.status, 409); assert.equal(put.body.code, 'VERSION_CONFLICT')
  const current = await getMap(api, id), text = current.nodes[1].data.description
  const body = contentRequest(current, (m) => { m.nodes[1].data.description = '경계 무시' })
  body.textOperations = [{ cardId: 'card-1', field: 'description', expectedSha256: textIntegrity(text).sha256,
    operation: { type: 'replace_once', find: '격리', replace: '수정' } }]
  const stable = await effects(api, id), failed = await save(api, id, body)
  assert.equal(failed.status, 400); assert.equal(failed.body.code, 'TEXT_PATCH_MATCH_COUNT'); assert.deepEqual(await effects(api, id), stable)
  body.textOperations[0].expectedSha256 = '0'.repeat(64)
  const r = await rejectedWithoutEffects(api, id, () => save(api, id, body), 'FIELD_CONFLICT'); assert.equal(r.body.code, 'TEXT_HASH_MISMATCH')
  const lifecycle = contentRequest(current, (m) => { m.nodes[1].data.label = '수명주기 충돌' }); lifecycle.preconditions.lifecycleVersion = 1
  await rejectedWithoutEffects(api, id, () => save(api, id, lifecycle), 'LIFECYCLE_CONFLICT')
})

test('실제 수명주기 전환과 전체 복원 조건은 버전·출처가 달라지면 무효과 충돌한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = api.ids[0], before = await getMap(api, id)
  const patch = contentRequest(before, (m) => { m.nodes[1].data.label = '낡은 변경' })
  const context = await getContext(api, id)
  assert.equal((await api.call(`/api/maps/${id}/archive`, 'PATCH', { baseVersion: 1, baseLifecycleVersion: 0, archived: true })).status, 200)
  await rejectedWithoutEffects(api, id, () => save(api, id, patch), 'LIFECYCLE_CONFLICT')
  assert.equal((await api.call(`/api/maps/${id}/archive`, 'PATCH', { baseVersion: 1, baseLifecycleVersion: 1, archived: false })).status, 200)
  await rejectedWithoutEffects(api, id, () => save(api, id, patch), 'LIFECYCLE_CONFLICT')
  await rejectedWithoutEffects(api, id, () => review(api, id, reviewRequest(context)), 'LIFECYCLE_CONFLICT')
  const current = await getMap(api, id)
  assert.equal((await save(api, id, contentRequest(current, (m) => { m.nodes[1].data.label = '최신 변경' }))).status, 200)
  const history = (await api.call(`/api/maps/${id}/history`)).body.revisions[0]
  const route = `/api/maps/${id}/history/${history.id}/restore`
  assert.equal((await api.call(route, 'POST', {})).status, 400)
  assert.equal((await api.call(`/api/maps/${id}`, 'PUT', { map: current })).status, 400)
  await rejectedWithoutEffects(api, id, () => api.call(route, 'POST', { baseVersion: 1, baseLifecycleVersion: 2, expectedSnapshotSha256: history.snapshotSha256 }), 'READ_DEPENDENCY_CHANGED')
  await rejectedWithoutEffects(api, id, () => api.call(route, 'POST', { baseVersion: 2, baseLifecycleVersion: 1, expectedSnapshotSha256: history.snapshotSha256 }), 'LIFECYCLE_CONFLICT')
  await rejectedWithoutEffects(api, id, () => api.call(route, 'POST', { baseVersion: 2, baseLifecycleVersion: 2, expectedSnapshotSha256: '0'.repeat(64) }), 'READ_DEPENDENCY_CHANGED')
  assert.equal((await api.call(route, 'POST', { baseVersion: 2, baseLifecycleVersion: 2, expectedSnapshotSha256: history.snapshotSha256 })).status, 200)
  assert.equal((await getMap(api, id)).version, 3)
  assert.equal((await api.call(`/api/maps/${id}`, 'PUT', { baseVersion: 3, baseLifecycleVersion: 1, map: current })).status, 409)
})
