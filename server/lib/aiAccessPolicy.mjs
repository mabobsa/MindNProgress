// 계정 설정과 대화 시작 기록을 기준으로 판단한다. 관리자는 타인의 대화 소유권을 얻지 않는다.
export function mainMachineAllowed(user) {
  return user?.active !== false && (user?.role === 'admin'
    || user?.role === 'editor' && user?.mainMachineAllowed === true)
}

export function conversationStarterId(value) {
  const id = typeof value === 'string' ? value : value?.id
  // 편집자를 지정하지 않은 과거 연동 요청의 대체 신원은 실제 계정이 아니다.
  return id && id !== 'system-aionui-ai' ? id : null
}

export function conversationOwners(conversationId, { origins, attributions = [], transient = [], link } = {}) {
  if (!conversationId) return []
  const records = [origins?.get(conversationId), ...attributions, ...transient]
    .filter((record) => record && record.conversationId === conversationId)
  if (link && link.conversationId === conversationId) records.push(link)
  return [...new Set(records.map((record) => conversationStarterId(record.startedBy)).filter(Boolean))]
}

export function conversationOwnedBy(user, owners) {
  if (!user || user.active === false || !['admin', 'editor'].includes(user.role)) return false
  return owners.length ? owners.every((owner) => owner === user.id) : mainMachineAllowed(user)
}

export function integrationIdentityMatches({ editorId, conversationId, attribution, owners }) {
  const startedBy = conversationStarterId(attribution?.startedBy)
  if (editorId && startedBy && editorId !== startedBy) return false
  if (conversationId && attribution?.conversationId && conversationId !== attribution.conversationId) return false
  const actor = startedBy || editorId
  return actor ? owners.every((owner) => owner === actor) : owners.length <= 1
}

export function redactAttributionTokens(value) {
  if (typeof value === 'string') return value.replace(
    /((?:attributionToken|x-mnp-ai-attribution)[`"'\s]*[:=][`"'\s]*)([A-Za-z0-9_-]{16,})/gi,
    '$1[비공개]',
  )
  if (Array.isArray(value)) return value.map(redactAttributionTokens)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(attributionToken|x-mnp-ai-attribution)$/i.test(key) ? '[비공개]' : redactAttributionTokens(item)]))
  return value
}
