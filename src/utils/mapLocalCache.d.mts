export type MapCacheContent<TNode, TEdge> = {
  nodes: TNode[]
  edges: TEdge[]
}

export const MAP_CACHE_PREFIX: string
export const MAP_CACHE_RETENTION_MS: number

export function mapCacheKey(mapId: string): string

export function isStorageQuotaError(error: unknown): boolean

export function tryWriteMapCache<TNode, TEdge>(
  storage: Storage,
  mapId: string,
  content: MapCacheContent<TNode, TEdge>,
  options?: { serverMap?: (MapCacheContent<TNode, TEdge> & { id: string; version: number }) | null; now?: number },
): { saved: boolean; quotaExceeded: boolean }

export function pruneExpiredMapCaches(storage: Storage, options?: { now?: number; keepMapId?: string | null }): number

export function isMapCacheSynchronized<TNode, TEdge>(
  cached: MapCacheContent<TNode, TEdge>,
  remote: MapCacheContent<TNode, TEdge>,
): boolean

export function reclaimSynchronizedMapCaches<TNode, TEdge>(options: {
  storage: Storage
  loadRemoteMap: (mapId: string) => Promise<MapCacheContent<TNode, TEdge>>
  retryWrite: () => boolean
}): Promise<boolean>
