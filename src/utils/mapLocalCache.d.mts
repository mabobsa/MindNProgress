export type MapCacheContent<TNode, TEdge> = {
  nodes: TNode[]
  edges: TEdge[]
}

export const MAP_CACHE_PREFIX: string

export function mapCacheKey(mapId: string): string

export function isStorageQuotaError(error: unknown): boolean

export function tryWriteMapCache<TNode, TEdge>(
  storage: Storage,
  mapId: string,
  content: MapCacheContent<TNode, TEdge>,
): { saved: boolean; quotaExceeded: boolean }

export function isMapCacheSynchronized<TNode, TEdge>(
  cached: MapCacheContent<TNode, TEdge>,
  remote: MapCacheContent<TNode, TEdge>,
): boolean

export function reclaimSynchronizedMapCaches<TNode, TEdge>(options: {
  storage: Storage
  loadRemoteMap: (mapId: string) => Promise<MapCacheContent<TNode, TEdge>>
  retryWrite: () => boolean
}): Promise<boolean>
