const LAUNCH_ID_PATTERN = /^[0-9a-f]{64}$/
const COMPLETION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export class AionUiExternalLaunchPayloadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AionUiExternalLaunchPayloadError'
  }
}

function requiredString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AionUiExternalLaunchPayloadError(`${label} 값이 필요합니다.`)
  }
  if (value.length > maxLength) {
    throw new AionUiExternalLaunchPayloadError(`${label} 값이 너무 깁니다.`)
  }
  return value.trim()
}

function optionalString(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new AionUiExternalLaunchPayloadError(`${label} 값이 올바르지 않습니다.`)
  }
  return value.trim() || undefined
}

function optionalStringList(value, label) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 128) {
    throw new AionUiExternalLaunchPayloadError(`${label} 목록이 올바르지 않습니다.`)
  }
  const result = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 512) {
      throw new AionUiExternalLaunchPayloadError(`${label} 목록에 올바르지 않은 값이 있습니다.`)
    }
    const normalized = item.trim()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export function normalizeAionUiExternalLaunchPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AionUiExternalLaunchPayloadError('AI 대화 시작 정보가 올바르지 않습니다.')
  }
  if (value.autoSend !== undefined && typeof value.autoSend !== 'boolean') {
    throw new AionUiExternalLaunchPayloadError('첫 메시지 자동 전송 설정이 올바르지 않습니다.')
  }

  const payload = {
    agentId: requiredString(value.agentId, 'AI 종류', 512),
    completionUrl: optionalString(value.completionUrl, '완료 통보 주소', 4_096),
    title: optionalString(value.title, '대화 제목', 120),
    prompt: requiredString(value.prompt, '대화 요청', 256 * 1_024),
    modelId: optionalString(value.modelId, '모델', 512),
    providerId: optionalString(value.providerId, '모델 제공자', 512),
    mode: optionalString(value.mode, '권한', 512),
    thoughtLevel: optionalString(value.thoughtLevel, '사고 수준', 512),
    enabledSkillIds: optionalStringList(value.enabledSkillIds, '활성 스킬'),
    disabledBuiltinSkillIds: optionalStringList(value.disabledBuiltinSkillIds, '비활성 기본 스킬'),
    mcpIds: optionalStringList(value.mcpIds, 'MCP 도구'),
    workspace: optionalString(value.workspace, '작업공간', 4_096),
    autoSend: value.autoSend === true,
  }

  return Object.fromEntries(Object.entries(payload).filter(([, item]) => item !== undefined))
}

export function parseMindNProgressCompletionToken(value, allowedTarget) {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    const allowedOrigins = typeof allowedTarget === 'number'
      ? new Set([`http://127.0.0.1:${allowedTarget}`, `http://[::1]:${allowedTarget}`])
      : new Set((Array.isArray(allowedTarget) ? allowedTarget : [allowedTarget])
        .flatMap((candidate) => {
          try { return [new URL(String(candidate)).origin] } catch { return [] }
        }))
    const route = url.pathname.match(/^\/api\/integrations\/aionui\/launches\/([^/]+)\/conversation$/)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || !allowedOrigins.has(url.origin)
      || url.username
      || url.password
      || url.search
      || url.hash
      || !route
    ) return null
    const token = decodeURIComponent(route[1])
    return COMPLETION_TOKEN_PATTERN.test(token) ? token : null
  } catch {
    return null
  }
}

export function createAionUiWebLaunchUrl(baseUrl, launchId) {
  if (!LAUNCH_ID_PATTERN.test(String(launchId ?? ''))) {
    throw new Error('AIONUI_EXTERNAL_LAUNCH_ID_INVALID')
  }
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AIONUI_WEB_URL_INVALID')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = `/guid?${new URLSearchParams({ 'external-launch': launchId }).toString()}`
  return url.toString()
}
