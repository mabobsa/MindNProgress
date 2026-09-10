const groupIdPattern = /^group-[a-zA-Z0-9_-]{1,100}$/

export function parseGroupDeepLink(pathname) {
  const match = String(pathname ?? '').match(/^\/groups\/([^/]+)\/?$/)
  if (!match) return null
  try {
    const groupId = decodeURIComponent(match[1])
    return groupIdPattern.test(groupId) ? groupId : null
  } catch {
    return null
  }
}

export function groupPageUrl(publicBaseUrl, groupId) {
  if (!groupIdPattern.test(groupId)) throw new Error('올바르지 않은 그룹 ID입니다.')
  const url = new URL(publicBaseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('공개 접근 주소를 확인하지 못했습니다.')
  }
  url.pathname = `/groups/${encodeURIComponent(groupId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}
