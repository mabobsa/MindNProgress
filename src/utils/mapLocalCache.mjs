export const MAP_CACHE_PREFIX = 'mindnprogress-map-cache-v1:'

export function mapCacheKey(mapId) {
  return `${MAP_CACHE_PREFIX}${mapId}`
}

export function isStorageQuotaError(error) {
  return error?.name === 'QuotaExceededError'
    || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22
    || error?.code === 1014
}

export function tryWriteMapCache(storage, mapId, content) {
  try {
    storage.setItem(mapCacheKey(mapId), JSON.stringify(content))
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
      return copy
    }),
    edges: content.edges.map((edge) => {
      const copy = { ...edge }
      delete copy.selected
      return copy
    }),
  }
}

export function isMapCacheSynchronized(cached, remote) {
  try {
    const cachedContent = comparableMapContent(cached)
    const remoteContent = comparableMapContent(remote)
    return cachedContent !== null && remoteContent !== null
      && JSON.stringify(cachedContent) === JSON.stringify(remoteContent)
  } catch {
    return false
  }
}

export async function reclaimSynchronizedMapCaches({ storage, loadRemoteMap, retryWrite }) {
  let candidates
  try {
    candidates = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => key?.startsWith(MAP_CACHE_PREFIX) && key.length > MAP_CACHE_PREFIX.length)
      .map((key) => ({ key, size: storage.getItem(key)?.length ?? 0 }))
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
    let remote
    try {
      remote = await loadRemoteMap(key.slice(MAP_CACHE_PREFIX.length))
    } catch {
      continue
    }
    if (!isMapCacheSynchronized(cached, remote)) continue
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
