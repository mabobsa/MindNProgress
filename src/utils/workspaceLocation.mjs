const workspaceLocationStoragePrefix = 'mindnprogress-last-location'
const workspaceViewModes = new Set(['mindmap', 'kanban', 'timeline', 'dashboard'])
const maximumWorkspaceIdLength = 120

function normalizedId(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= maximumWorkspaceIdLength ? id : null
}

export function workspaceLocationStorageKey(userId) {
  const normalizedUserId = normalizedId(userId)
  return normalizedUserId ? `${workspaceLocationStoragePrefix}:${normalizedUserId}` : null
}

export function normalizeWorkspaceLocation(value) {
  if (!value || typeof value !== 'object') return null
  const mapId = normalizedId(value.mapId)
  const viewMode = typeof value.viewMode === 'string' && workspaceViewModes.has(value.viewMode)
    ? value.viewMode
    : null
  if (!mapId || !viewMode) return null
  return {
    mapId,
    viewMode,
    nodeId: normalizedId(value.nodeId),
  }
}

export function restorableWorkspaceLocation(value, availableMapIds) {
  const location = normalizeWorkspaceLocation(value)
  if (!location || !Array.isArray(availableMapIds) || !availableMapIds.includes(location.mapId)) return null
  return location
}

export function workspaceLocationPath(value, viewerEntry = false) {
  const location = normalizeWorkspaceLocation(value)
  if (!location) return null
  const segments = [location.viewMode, location.mapId]
  if (location.nodeId) segments.push(location.nodeId)
  return `${viewerEntry ? '/viewer' : ''}/${segments.map(encodeURIComponent).join('/')}`
}
