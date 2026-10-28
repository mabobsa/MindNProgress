import { REFERENCE_MANAGED_DATA_KEYS } from './referenceNodeFields.mjs'

export const MAP_CACHE_PREFIX = 'mindnprogress-map-cache-v1:'
export const MAP_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function mapCacheKey(mapId) {
  return `${MAP_CACHE_PREFIX}${mapId}`
}

export function isStorageQuotaError(error) {
  return error?.name === 'QuotaExceededError'
    || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22
    || error?.code === 1014
}

export function tryWriteMapCache(storage, mapId, content, { serverMap = null, now = Date.now() } = {}) {
  try {
    // 내용과 저장 확인을 한 값으로 교체한다. 새 로컬 수정에 이전 확인 표식이 남지 않는다.
    const synchronized = serverMap?.id === mapId && Number.isInteger(serverMap.version)
      && serverMap.version > 0 && isMapCacheSynchronized(content, serverMap)
    storage.setItem(mapCacheKey(mapId), JSON.stringify({
      nodes: content.nodes,
      edges: content.edges,
      localBackup: { version: 1, mapId, savedAt: now,
        serverVersion: synchronized ? serverMap.version : null },
    }))
    return { saved: true, quotaExceeded: false }
  } catch (error) {
    return { saved: false, quotaExceeded: isStorageQuotaError(error) }
  }
}

function comparableMapContent(content) {
  if (!content || !Array.isArray(content.nodes) || !Array.isArray(content.edges)) return null
  if (content.nodes.some((node) => !node || typeof node !== 'object' || Array.isArray(node))
    || content.edges.some((edge) => !edge || typeof edge !== 'object' || Array.isArray(edge))) return null
  return {
    nodes: content.nodes.map((node) => {
      const copy = { ...node }
      delete copy.width
      delete copy.height
      delete copy.resizing
      delete copy.selected
      delete copy.dragging
      delete copy.measured
      // Ref 본문은 서버가 원본의 최신 값으로 투영한다. 위치·연결·참조 대상은 비교한다.
      if (typeof copy.data?.reference?.mapId === 'string' && copy.data.reference.mapId
        && typeof copy.data.reference.nodeId === 'string' && copy.data.reference.nodeId) {
        copy.data = { ...copy.data }
        for (const key of REFERENCE_MANAGED_DATA_KEYS) delete copy.data[key]
      }
      return copy
    }),
    edges: content.edges.map((edge) => {
      const copy = { ...edge }
      delete copy.selected
      return copy
    }),
  }
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item)
}

export function isMapCacheSynchronized(cached, remote) {
  try {
    const cachedContent = comparableMapContent(cached)
    const remoteContent = comparableMapContent(remote)
    return cachedContent !== null && remoteContent !== null
      && canonicalJson(cachedContent) === canonicalJson(remoteContent)
  } catch {
    return false
  }
}

function confirmedBackup(cached, mapId) {
  const metadata = cached?.localBackup
  return metadata?.version === 1 && metadata.mapId === mapId
    && Number.isFinite(metadata.savedAt) && metadata.savedAt > 0
    && Number.isInteger(metadata.serverVersion) && metadata.serverVersion > 0
    && comparableMapContent(cached) !== null
}

function cacheEntries(storage) {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key) => key?.startsWith(MAP_CACHE_PREFIX) && key.length > MAP_CACHE_PREFIX.length)
    .map((key) => ({ key, size: storage.getItem(key)?.length ?? 0 }))
}

export function pruneExpiredMapCaches(storage, { now = Date.now(), keepMapId = null } = {}) {
  let entries
  try { entries = cacheEntries(storage) } catch { return 0 }
  let removed = 0
  for (const { key } of entries) {
    const mapId = key.slice(MAP_CACHE_PREFIX.length)
    if (mapId === keepMapId) continue
    try {
      const value = storage.getItem(key)
      const cached = JSON.parse(value)
      // 날짜·저장 확인이 없는 구형 백업과 미저장 변경은 기간만으로 삭제하지 않는다.
      if (!confirmedBackup(cached, mapId) || now - cached.localBackup.savedAt < MAP_CACHE_RETENTION_MS) continue
      if (storage.getItem(key) !== value) continue
      storage.removeItem(key)
      removed++
    } catch { /* 확인할 수 없는 백업은 보존한다. */ }
  }
  return removed
}

export async function reclaimSynchronizedMapCaches({ storage, loadRemoteMap, retryWrite }) {
  let candidates
  try {
    candidates = cacheEntries(storage)
      .sort((first, second) => second.size - first.size)
  } catch {
    return false
  }

  for (const { key } of candidates) {
    if (retryWrite()) return true
    let value
    try {
      value = storage.getItem(key)
    } catch {
      continue
    }
    if (!value) continue
    let cached
    try {
      cached = JSON.parse(value)
    } catch {
      continue
    }
    const mapId = key.slice(MAP_CACHE_PREFIX.length)
    if (!confirmedBackup(cached, mapId)) {
      let remote
      try {
        remote = await loadRemoteMap(mapId)
      } catch {
        continue
      }
      if (!isMapCacheSynchronized(cached, remote)) continue
    }
    try {
      // 다른 탭이 조회 중 캐시를 바꿨다면 그 변경을 보존한다.
      if (storage.getItem(key) !== value) continue
      storage.removeItem(key)
    } catch {
      continue
    }
    if (retryWrite()) return true
  }
  return retryWrite()
}
