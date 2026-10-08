const collapsedDocumentGroupsStoragePrefix = 'mindnprogress-collapsed-document-groups-v2'
const maximumDocumentGroupIdLength = 120

function normalizedGroupIds(value) {
  if (!Array.isArray(value)) return null
  const result = []
  const seen = new Set()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const groupId = candidate.trim()
    if (!groupId || groupId.length > maximumDocumentGroupIdLength || seen.has(groupId)) continue
    seen.add(groupId)
    result.push(groupId)
  }
  return result
}

export function collapsedDocumentGroupsStorageKey(userId) {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  return normalizedUserId ? `${collapsedDocumentGroupsStoragePrefix}:${normalizedUserId}` : null
}

export function normalizeCollapsedDocumentGroupIds(value) {
  return normalizedGroupIds(value)
}

export function initialCollapsedDocumentGroupIds(storedGroupIds, availableGroupIds) {
  const available = normalizedGroupIds(availableGroupIds) ?? []
  const stored = normalizedGroupIds(storedGroupIds)
  if (stored === null) return available
  const availableSet = new Set(available)
  return stored.filter((groupId) => availableSet.has(groupId))
}

export function activeDocumentCountInGroup(mapIds, activeCounts) {
  return [...new Set(mapIds)].filter((mapId) => (activeCounts[mapId] ?? 0) > 0).length
}
