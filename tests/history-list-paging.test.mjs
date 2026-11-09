import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { compareRevisionsNewestFirst, compressedRevisionFileName, encodeRevisionBytes, rawRevisionFileName, revisionIdTime } from '../server/lib/revisionFiles.mjs'
import { storageApi } from './helpers/storage-api-harness.mjs'

test('이력 ID에서 저장 시각을 읽고 최신순·ID순으로 비교한다', () => {
  const time = Date.UTC(2026, 10, 9, 1, 2, 3, 456)
  assert.equal(revisionIdTime(`${time.toString(36)}-0a1b2c3d`), time)
  for (const id of ['legacy-import-one', 'ZZZZZZ-00', `${(1).toString(36).padStart(6, '0')}-00`, 'abc']) assert.equal(revisionIdTime(id), null, id)
  const sorted = [{ id: 'a', time: 1 }, { id: 'c', time: 2 }, { id: 'b', time: 2 }].sort(compareRevisionsNewestFirst)
  assert.deepEqual(sorted.map((item) => item.id), ['c', 'b', 'a'])
})

const base = Date.UTC(2026, 9, 1)
const revisionId = (index) => `${(base + index * 60_000).toString(36)}-${randomBytes(4).toString('hex')}`
function revision(id, mapId, archivedAt, label) {
  return { id, mapId, archivedAt, archivedBy: { id: 'user-editor', name: '김용민' }, reason: 'update',
    map: { id: mapId, title: label, nodes: [{ id: 'card-0', type: 'mind', position: { x: 0, y: 0 }, data: { label, kind: 'root', status: 'planned', progress: 0 } }], edges: [], version: 1 } }
}

test('이력 목록은 이름순으로 요청한 쪽만 읽고, 끝까지 이어 읽으면 기존 방식의 전체 목록과 같다', { timeout: 90_000 }, async (t) => {
  const valid = []
  const api = await storageApi(t, { documents: 1, seed: async ({ data, ids }) => {
    const mapId = ids[0]
    const directory = path.join(data, '_history', mapId)
    await mkdir(directory, { recursive: true })
    for (let index = 0; index < 12; index++) {
      const id = revisionId(index)
      const body = revision(id, mapId, new Date(base + index * 60_000 + 5).toISOString(), `이력 ${index}`)
      valid.push(body)
      // 짝수는 압축본, 홀수는 원문으로 둔다. 3번은 같은 ID의 원문·압축본이 함께 있다(중간에 끊긴 변환).
      if (index % 2 === 0 || index === 3) await writeFile(path.join(directory, compressedRevisionFileName(id)), encodeRevisionBytes(JSON.stringify(body)))
      if (index % 2 === 1) await writeFile(path.join(directory, rawRevisionFileName(id)), `${JSON.stringify(body, null, 2)}\n`)
    }
    // 이력 ID 규칙 밖의 이름은 archivedAt(5번과 6번 사이)으로 자리를 정한다.
    const legacy = revision('legacy-import-one', mapId, new Date(base + 5 * 60_000 + 30_000).toISOString(), '규칙 밖 이력')
    valid.push(legacy)
    await writeFile(path.join(directory, rawRevisionFileName(legacy.id)), JSON.stringify(legacy))
    // 다른 문서의 이력은 건너뛴다.
    const foreignId = revisionId(20)
    await writeFile(path.join(directory, rawRevisionFileName(foreignId)), JSON.stringify(revision(foreignId, 'map-other-doc', new Date(base + 20 * 60_000).toISOString(), '다른 문서')))
  } })
  const [mapId] = api.ids
  // 손상된 압축본도 목록에서는 건너뛴다. 기동 때 일일 백업 보정은 손상 이력을 오류로 알리는 기존 동작이라 기동 뒤에 넣는다.
  const corruptName = compressedRevisionFileName(revisionId(21))
  await writeFile(path.join(api.data, '_history', mapId, corruptName), randomBytes(64))
  const expected = valid.slice().sort((first, second) => second.archivedAt.localeCompare(first.archivedAt)).map((item) => item.id)

  const collected = []
  let offset = 0
  let pages = 0
  for (;;) {
    const page = await api.call(`/api/maps/${mapId}/history?offset=${offset}&limit=4`)
    assert.equal(page.status, 200, JSON.stringify(page.body))
    assert.ok(page.body.revisions.length <= 4)
    collected.push(...page.body.revisions.map((item) => item.id))
    pages++
    if (!page.body.hasMore) { assert.equal(page.body.nextOffset, null); break }
    assert.ok(page.body.nextOffset > offset, '다음 위치는 항상 앞으로 간다')
    offset = page.body.nextOffset
    assert.ok(pages < 10)
  }
  assert.deepEqual(collected, expected, '이어 읽은 결과가 유효한 이력을 archivedAt으로 정렬한 기존 전체 목록과 같다')
  assert.equal(new Set(collected).size, collected.length, '같은 ID의 원문·압축본은 한 번만 나온다')
  assert.match(api.output(), /\[History list skipped\].*not a revision of this document/)
  assert.ok(api.output().split('\n').some((line) => line.startsWith('[History list skipped]') && line.includes(corruptName)), '손상된 압축본을 건너뛰고 기록한다')

  // 첫 쪽의 요약은 기존과 같은 필드를 주고, 그 해시로 바로 복원할 수 있다.
  const first = (await api.call(`/api/maps/${mapId}/history?limit=2`)).body
  assert.deepEqual(first.revisions.map((item) => item.id), expected.slice(0, 2))
  assert.equal(first.hasMore, true)
  // offset은 정렬한 이력 파일 위치다. 맨 앞의 손상 파일·다른 문서 이력 2개를 건너뛰고 유효한 2개를 채웠으므로 4다.
  assert.equal(first.nextOffset, 4)
  for (const key of ['snapshotSha256', 'id', 'mapId', 'title', 'nodeCount', 'archivedAt', 'archivedBy', 'reason']) assert.ok(key in first.revisions[0], key)
  const current = (await api.call(`/api/maps/${mapId}`)).body.map
  const restored = await api.call(`/api/maps/${mapId}/history/${first.revisions[1].id}/restore`, 'POST', {
    baseVersion: current.version, baseLifecycleVersion: current.lifecycleVersion ?? 0, expectedSnapshotSha256: first.revisions[1].snapshotSha256 })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  assert.equal(restored.body.revisions[0].reason, 'history-restore', '복원 직후 목록 맨 앞은 복원 직전 상태다')

  const empty = await api.call(`/api/maps/${mapId}/history?offset=500&limit=4`)
  assert.deepEqual(empty.body, { revisions: [], hasMore: false, nextOffset: null })
})
