import assert from 'node:assert/strict'
import test from 'node:test'
import { createDocumentReadStore } from '../server/lib/documentReadStore.mjs'
import { commentProjection } from '../server/lib/readProjections.mjs'

test('동시 목록·본문 조회는 파일 읽기를 공유하고 반환값 수정은 다음 조회에 섞이지 않는다', async () => {
  let reads = 0, projections = 0, revision = 1
  const store = createDocumentReadStore({ fileForId: (id) => id,
    inspect: async () => ({ size: 100, mtimeMs: revision, ctimeMs: revision, ino: revision }),
    read: async () => { reads++; await new Promise((resolve) => setTimeout(resolve, 5)); return JSON.stringify({ title: '원문', version: revision }) },
  })
  const project = (value) => { projections++; return { map: value, summary: { title: value.title, version: value.version } } }
  const values = await Promise.all(Array.from({ length: 12 }, () => store.select('map-a', 'editor', project, (value) => value.summary)))
  assert.equal(reads, 1); assert.equal(projections, 1)
  values[0].title = '로컬 편집'
  assert.equal((await store.select('map-a', 'editor', project)).map.title, '원문')
  assert.equal(reads, 1)
  revision++
  assert.equal((await store.select('map-a', 'editor', project)).map.version, 2)
  assert.equal(reads, 2)
  await store.select('map-a', 'viewer', project)
  assert.equal(reads, 2); assert.equal(projections, 3, '권한·수명 메타데이터 변경은 본문 재읽기 없이 재계산한다')
})

test('조회 도중 저장·삭제가 발생해도 오래된 읽기를 캐시에 재삽입하지 않는다', async () => {
  let version = 1, exists = true, unblock
  const store = createDocumentReadStore({ fileForId: (id) => id,
    inspect: async () => { if (!exists) throw Object.assign(Error('없음'), { code: 'ENOENT' }); return { size: 10, mtimeMs: version, ctimeMs: version } },
    read: async () => { const value = version; if (value === 1) await new Promise((resolve) => { unblock = resolve }); return JSON.stringify({ version: value }) },
  })
  const first = store.select('map-a', '', (value) => value)
  while (!unblock) await new Promise((resolve) => setTimeout(resolve, 1))
  version = 2; store.invalidate('map-a'); unblock()
  assert.equal((await first).version, 2)
  exists = false
  assert.equal(await store.select('map-a', '', (value) => value), null)
})

test('공유 promise의 반환 직전 무효화도 재검증하며 표현·원문의 총 LRU 크기를 제한한다', async () => {
  let version = 1, release, reads = 0
  const store = createDocumentReadStore({ fileForId: (id) => id, maxBytes: 700,
    inspect: async () => ({ size: 100, mtimeMs: 1, ctimeMs: 1 }),
    read: async () => { reads++; const value = version; if (!release) await new Promise((resolve) => { release = resolve }); return JSON.stringify({ version: value, text: '자료'.repeat(30) }) },
  })
  const first = store.select('a', '', (value) => value)
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
  const second = store.select('a', '', (value) => value)
  version++; store.invalidate('a'); release()
  assert.deepEqual((await Promise.all([first, second])).map((value) => value.version), [2, 2])
  assert.equal(reads, 2)
  let builds = 0
  const select = (value) => { builds++; return { ...value, selected: true } }
  await store.select('a', '', (value) => value, select, 'one')
  await store.select('a', '', (value) => value, select, 'one')
  assert.equal(builds, 1)
  for (let i = 0; i < 30; i++) {
    await store.select(String(i), '', (value) => value, select, 'one')
    assert.ok(store.usage().bytes <= 700)
  }
  assert.ok(store.usage().generations <= 2)
})

test('댓글 인덱스는 객체 내장 속성과 같은 카드 ID도 보존한다', () => {
  const comments = ['__proto__', 'constructor'].map((nodeId) => ({ id: nodeId, nodeId, mapId: 'map-a', text: '댓글' }))
  const projected = commentProjection(comments, 'map-a')
  for (const id of ['__proto__', 'constructor']) {
    assert.equal(projected.byNode[id][0].nodeId, id)
    assert.deepEqual(projected.stats[id], { total: 1, unresolved: 1 })
  }
})
