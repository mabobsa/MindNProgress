import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isMapCacheSynchronized,
  mapCacheKey,
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
  const storage = fakeStorage(160)
  const synchronized = content('서버와 동일')
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
  assert.equal(storage.getItem(mapCacheKey('new')), JSON.stringify(desired))
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
