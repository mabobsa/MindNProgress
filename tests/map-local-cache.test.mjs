import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isMapCacheSynchronized,
  MAP_CACHE_RETENTION_MS,
  mapCacheKey,
  pruneExpiredMapCaches,
  reclaimSynchronizedMapCaches,
  tryWriteMapCache,
} from '../src/utils/mapLocalCache.mjs'

function fakeStorage(capacity) {
  const entries = new Map()
  return {
    get length() { return entries.size },
    key(index) { return [...entries.keys()][index] ?? null },
    getItem(key) { return entries.get(key) ?? null },
    setItem(key, value) {
      const used = [...entries].reduce((sum, [entryKey, entryValue]) => sum + (entryKey === key ? 0 : entryValue.length), 0)
      if (used + value.length > capacity) throw new DOMException('저장 공간 부족', 'QuotaExceededError')
      entries.set(key, value)
    },
    removeItem(key) { entries.delete(key) },
  }
}

const content = (label) => ({ nodes: [{ id: 'root', data: { label } }], edges: [] })

test('캐시 용량 오류는 호출자를 중단시키지 않고 결과로 반환한다', () => {
  const storage = fakeStorage(1)
  assert.deepEqual(tryWriteMapCache(storage, 'map-one', content('문서')), {
    saved: false,
    quotaExceeded: true,
  })
  assert.deepEqual(tryWriteMapCache({
    setItem() { throw new DOMException('저장소 사용 불가', 'SecurityError') },
  }, 'map-one', content('문서')), {
    saved: false,
    quotaExceeded: false,
  })
})

test('기존 캐시의 선택·측정 필드는 서버 동기화 판정에서 제외한다', () => {
  const cached = content('동일')
  cached.nodes[0].selected = true
  cached.nodes[0].measured = { width: 100, height: 20 }
  assert.equal(isMapCacheSynchronized(cached, content('동일')), true)
  assert.equal(isMapCacheSynchronized(cached, content('다름')), false)
  assert.equal(isMapCacheSynchronized({ nodes: [null], edges: [] }, content('동일')), false)
})

test('서버와 동일한 캐시만 정리하고 실패한 쓰기를 재시도한다', async () => {
  const storage = fakeStorage(800)
  const synchronized = content('서버와 동일'.repeat(100))
  const localOnly = content('로컬 전용')
  storage.setItem(mapCacheKey('synced'), JSON.stringify(synchronized))
  storage.setItem(mapCacheKey('local'), JSON.stringify(localOnly))
  const desired = content('새 문서')
  assert.equal(tryWriteMapCache(storage, 'new', desired).saved, false)

  const recovered = await reclaimSynchronizedMapCaches({
    storage,
    loadRemoteMap: async (mapId) => mapId === 'synced' ? synchronized : content('서버의 다른 내용'),
    retryWrite: () => tryWriteMapCache(storage, 'new', desired).saved,
  })

  assert.equal(recovered, true)
  assert.equal(storage.getItem(mapCacheKey('synced')), null)
  assert.equal(storage.getItem(mapCacheKey('local')), JSON.stringify(localOnly))
  const saved = JSON.parse(storage.getItem(mapCacheKey('new')))
  assert.deepEqual({ nodes: saved.nodes, edges: saved.edges }, desired)
  assert.equal(saved.localBackup.serverVersion, null)
})

const serverMap = (mapId, data, version = 3) => ({ id: mapId, version, ...data })
const referenceContent = (label = '원본 제목') => ({
  nodes: [{ id: 'ref', position: { x: 120, y: 80 }, data: {
    reference: { mapId: 'source-map', nodeId: 'source-node' },
    label, description: '원본 본문', sharedKnowledge: '원본 지식',
    status: 'planned', progress: 0, collapsed: false,
  } }],
  edges: [{ id: 'edge', source: 'parent', target: 'ref', data: { relation: 'hierarchy' } }],
})

test('Ref 원본의 표시값만 바뀌어도 동기화된 구형 백업을 확인할 수 있다', () => {
  const cached = referenceContent()
  const remote = referenceContent('바뀐 원본 제목 (ref)')
  Object.assign(remote.nodes[0].data, { description: '최신 원본', sharedKnowledge: '최신 지식',
    sharedKnowledgeUpdatedAt: '2026-10-27T00:00:00Z', status: 'done', progress: 100 })
  assert.equal(isMapCacheSynchronized(cached, remote), true)
  const reordered = { edges: remote.edges, nodes: remote.nodes.map(n => ({ data: n.data, position: n.position, id: n.id })) }
  assert.equal(isMapCacheSynchronized(cached, reordered), true, '객체 필드 순서는 편집 내용이 아니다.')
})

test('Ref 위치·대상·접힘·관계와 일반 카드의 로컬 변경은 보존한다', () => {
  const remote = referenceContent('최신 제목')
  for (const modify of [
    c => { c.nodes[0].position.x += 24 },
    c => { c.nodes[0].data.reference.nodeId = 'other-node' },
    c => { c.nodes[0].data.collapsed = true },
    c => { c.edges[0].data.relation = 'knowledge' },
    c => { c.nodes.push({ id: 'local', data: { label: '미저장 카드' } }) },
  ]) {
    const cached = referenceContent()
    modify(cached)
    assert.equal(isMapCacheSynchronized(cached, remote), false)
  }
  assert.equal(isMapCacheSynchronized(content('로컬 본문'), content('서버 본문')), false)
  const invalid = referenceContent()
  invalid.nodes[0].data.reference.nodeId = ''
  assert.equal(isMapCacheSynchronized(invalid, referenceContent('다른 내용')), false)
})

test('확인된 서버 버전은 동일 백업 값에 기록하며 새 미저장 변경에는 승계하지 않는다', () => {
  const storage = fakeStorage(10_000)
  const saved = content('서버 저장 완료')
  const options = { serverMap: serverMap('map', saved), now: 1_000 }
  assert.equal(tryWriteMapCache(storage, 'map', saved, options).saved, true)
  assert.equal(JSON.parse(storage.getItem(mapCacheKey('map'))).localBackup.serverVersion, 3)
  const changed = content('응답 대기 중 추가한 로컬 수정')
  assert.equal(tryWriteMapCache(storage, 'map', changed, options).saved, true)
  assert.equal(JSON.parse(storage.getItem(mapCacheKey('map'))).localBackup.serverVersion, null)
  assert.equal(tryWriteMapCache(storage, 'other-map', saved, options).saved, true)
  assert.equal(JSON.parse(storage.getItem(mapCacheKey('other-map'))).localBackup.serverVersion, null)
})

test('용량 오류로 새 변경을 저장하지 못해도 기존 백업과 확인 기록은 함께 보존된다', () => {
  const storage = fakeStorage(400)
  const saved = content('기존 서버 저장')
  tryWriteMapCache(storage, 'map', saved, { serverMap: serverMap('map', saved), now: 1_000 })
  const before = storage.getItem(mapCacheKey('map'))
  assert.equal(tryWriteMapCache(storage, 'map', content('미저장'.repeat(500))).quotaExceeded, true)
  assert.equal(storage.getItem(mapCacheKey('map')), before)
})

test('7일 지난 서버 저장 백업만 자동 삭제하고 현재 문서·미저장·구형 백업은 보존한다', () => {
  const storage = fakeStorage(10_000)
  const now = 2 * MAP_CACHE_RETENTION_MS
  const data = content('서버 저장')
  for (const id of ['expired','current','recent']) {
    tryWriteMapCache(storage, id, data, { serverMap: serverMap(id, data),
      now: now - MAP_CACHE_RETENTION_MS + (id === 'recent' ? 1 : 0) })
  }
  tryWriteMapCache(storage, 'pending', content('오프라인 미저장'), { now: 1 })
  storage.setItem(mapCacheKey('legacy'), JSON.stringify(data))
  storage.setItem(mapCacheKey('invalid'), '{invalid')
  storage.setItem('other-app', '다른 설정')
  assert.equal(pruneExpiredMapCaches(storage, { now, keepMapId: 'current' }), 1)
  assert.equal(storage.getItem(mapCacheKey('expired')), null)
  for (const id of ['current','recent','pending','legacy','invalid']) assert.notEqual(storage.getItem(mapCacheKey(id)), null)
  assert.equal(storage.getItem('other-app'), '다른 설정')
})

test('서버 저장이 확인된 백업은 원본 변경·삭제 후에도 추가 API 조회 없이 회수한다', async () => {
  const storage = fakeStorage(10_000)
  const data = content('저장했던 내용')
  tryWriteMapCache(storage, 'synced', data, { serverMap: serverMap('synced', data), now: 1_000 })
  let attempts = 0
  const result = await reclaimSynchronizedMapCaches({ storage,
    loadRemoteMap: async () => { assert.fail('저장 확인이 있는 백업에는 조회가 필요하지 않다.') },
    retryWrite: () => ++attempts > 1,
  })
  assert.equal(result, true)
  assert.equal(storage.getItem(mapCacheKey('synced')), null)
})

test('Ref 변화만 있는 구형 백업을 정리하되 조회 실패한 미확인 백업은 지우지 않는다', async () => {
  const storage = fakeStorage(20_000)
  const legacy = referenceContent('이전 제목')
  storage.setItem(mapCacheKey('legacy'), JSON.stringify(legacy))
  storage.setItem(mapCacheKey('missing'), JSON.stringify(content('삭제된 문서인지 확인 불가')))
  const result = await reclaimSynchronizedMapCaches({ storage,
    loadRemoteMap: async id => {
      if (id === 'missing') throw Object.assign(new Error('조회 실패'), { status: 404 })
      return referenceContent('새 원본 제목')
    },
    retryWrite: () => storage.getItem(mapCacheKey('legacy')) === null,
  })
  assert.equal(result, true)
  assert.equal(storage.getItem(mapCacheKey('legacy')), null)
  assert.notEqual(storage.getItem(mapCacheKey('missing')), null)
})

test('서버에 없는 로컬 변경만 남았다면 공간 확보를 포기하고 캐시를 보존한다', async () => {
  const storage = fakeStorage(100)
  const localOnly = content('로컬에서 수정')
  storage.setItem(mapCacheKey('local'), JSON.stringify(localOnly))
  const desired = content('새 문서')

  const recovered = await reclaimSynchronizedMapCaches({
    storage,
    loadRemoteMap: async () => content('서버 상태'),
    retryWrite: () => tryWriteMapCache(storage, 'new', desired).saved,
  })

  assert.equal(recovered, false)
  assert.equal(storage.getItem(mapCacheKey('local')), JSON.stringify(localOnly))
  assert.equal(storage.getItem(mapCacheKey('new')), null)
})

test('서버 조회 실패 및 조회 도중 변경된 캐시는 삭제하지 않는다', async () => {
  const storage = fakeStorage(200)
  const original = content('원본')
  storage.setItem(mapCacheKey('changed'), JSON.stringify(original))
  storage.setItem(mapCacheKey('unavailable'), JSON.stringify(content('조회 실패')))

  const recovered = await reclaimSynchronizedMapCaches({
    storage,
    loadRemoteMap: async (mapId) => {
      if (mapId === 'unavailable') throw new Error('서버 조회 실패')
      storage.setItem(mapCacheKey('changed'), JSON.stringify(content('다른 탭의 변경')))
      return original
    },
    retryWrite: () => false,
  })

  assert.equal(recovered, false)
  assert.equal(storage.getItem(mapCacheKey('changed')), JSON.stringify(content('다른 탭의 변경')))
  assert.notEqual(storage.getItem(mapCacheKey('unavailable')), null)
})
