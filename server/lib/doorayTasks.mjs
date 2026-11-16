import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const defaultDoorayBaseUrl = 'https://api.dooray.com'
const defaultDoorayMcpServerName = 'docker-dooray-mcp'
const doorayTaskHostnamePattern = /^(?:[a-z0-9-]+\.)+dooray\.com$/i
const doorayTaskPathPattern = /^\/task\/(\d+)\/(\d+)\/?$/
const doorayCopiedTaskPathPattern = /^\/project\/tasks\/(\d+)\/?$/
const doorayCommentHashPattern = /^#comment-(\d+)$/
const doorayWikiPathPattern = /^\/wiki\/(\d+)\/(\d+)\/?$/
const doorayCopiedWikiPathPattern = /^\/project\/pages\/(\d+)\/?$/
const maximumDoorayTaskUrlLength = 2_048

export class DoorayTaskError extends Error {
  constructor(code, message, status = 500) {
    super(message)
    this.name = 'DoorayTaskError'
    this.code = code
    this.status = status
  }
}

function normalizeDoorayBaseUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim() || defaultDoorayBaseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('UNSUPPORTED_PROTOCOL')
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new DoorayTaskError('CONFIG_INVALID', 'Dooray API 주소가 올바르지 않습니다.', 503)
  }
}

export async function loadDoorayApiConfig({
  env = process.env,
  homeDirectory = homedir(),
  readText = (filePath) => readFile(filePath, 'utf8'),
} = {}) {
  const environmentApiKey = String(env.MNP_DOORAY_API_KEY ?? env.DOORAY_API_KEY ?? '').trim()
  const environmentBaseUrl = String(env.MNP_DOORAY_BASE_URL ?? env.DOORAY_BASE_URL ?? '').trim()
  if (environmentApiKey) {
    return {
      apiKey: environmentApiKey,
      baseUrl: normalizeDoorayBaseUrl(environmentBaseUrl),
      source: 'environment',
    }
  }

  const configFile = path.resolve(
    String(env.MNP_DOORAY_CONFIG_FILE ?? '').trim() || path.join(homeDirectory, '.claude.json'),
  )
  let parsed
  try {
    parsed = JSON.parse(await readText(configFile))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        apiKey: '',
        baseUrl: normalizeDoorayBaseUrl(environmentBaseUrl),
        source: 'unavailable',
        configFile,
      }
    }
    throw new DoorayTaskError('CONFIG_INVALID', 'Dooray MCP 설정 파일을 읽지 못했습니다.', 503)
  }

  const serverName = String(env.MNP_DOORAY_MCP_SERVER_NAME ?? '').trim() || defaultDoorayMcpServerName
  const connectorEnv = parsed?.mcpServers?.[serverName]?.env ?? {}
  const apiKey = String(connectorEnv.DOORAY_API_KEY ?? '').trim()
  const baseUrl = environmentBaseUrl || String(connectorEnv.DOORAY_BASE_URL ?? '').trim()
  return {
    apiKey,
    baseUrl: normalizeDoorayBaseUrl(baseUrl),
    source: apiKey ? 'claude-config' : 'unavailable',
    configFile,
  }
}

export function parseDoorayTaskUrl(value) {
  const rawValue = String(value ?? '').trim()
  if (!rawValue || rawValue.length > maximumDoorayTaskUrlLength) {
    throw new DoorayTaskError('INVALID_URL', 'Dooray 업무 URL 형식이 올바르지 않습니다.', 400)
  }
  let url
  try {
    url = new URL(rawValue)
  } catch {
    throw new DoorayTaskError('INVALID_URL', 'Dooray 업무 URL 형식이 올바르지 않습니다.', 400)
  }
  const taskMatch = doorayTaskPathPattern.exec(url.pathname)
  const copiedTaskMatch = doorayCopiedTaskPathPattern.exec(url.pathname)
  if (url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || !doorayTaskHostnamePattern.test(url.hostname)
    || (!taskMatch && !copiedTaskMatch)) {
    throw new DoorayTaskError('INVALID_URL', 'Dooray 업무 URL 형식이 올바르지 않습니다.', 400)
  }
  if (url.hash.startsWith('#comment-') && !doorayCommentHashPattern.test(url.hash)) {
    throw new DoorayTaskError('INVALID_URL', 'Dooray 댓글 URL 형식이 올바르지 않습니다.', 400)
  }
  const projectId = taskMatch?.[1] ?? null
  const postId = taskMatch?.[2] ?? copiedTaskMatch[1]
  const commentId = doorayCommentHashPattern.exec(url.hash)?.[1] ?? null
  const hostname = url.hostname.toLowerCase()
  const pathName = projectId ? `/task/${projectId}/${postId}` : `/project/tasks/${postId}`
  const commentHash = commentId ? `#comment-${commentId}` : ''
  const key = `${hostname}:${postId}`
  return {
    projectId,
    postId,
    commentId,
    hostname,
    key,
    labelKey: commentId ? `${key}#comment-${commentId}` : key,
    url: `https://${hostname}${pathName}${commentHash}`,
  }
}

export function parseDoorayWikiUrl(value) {
  const rawValue = String(value ?? '').trim()
  if (!rawValue || rawValue.length > maximumDoorayTaskUrlLength) {
    throw new DoorayTaskError('INVALID_URL', 'Dooray Wiki URL 형식이 올바르지 않습니다.', 400)
  }
  let url
  try {
    url = new URL(rawValue)
  } catch {
    throw new DoorayTaskError('INVALID_URL', 'Dooray Wiki URL 형식이 올바르지 않습니다.', 400)
  }
  const wikiMatch = doorayWikiPathPattern.exec(url.pathname)
  const copiedWikiMatch = doorayCopiedWikiPathPattern.exec(url.pathname)
  if (url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || !doorayTaskHostnamePattern.test(url.hostname)
    || (!wikiMatch && !copiedWikiMatch)) {
    throw new DoorayTaskError('INVALID_URL', 'Dooray Wiki URL 형식이 올바르지 않습니다.', 400)
  }
  const spaceId = wikiMatch?.[1] ?? null
  const pageId = wikiMatch?.[2] ?? copiedWikiMatch[1]
  const hostname = url.hostname.toLowerCase()
  const pathName = spaceId ? `/wiki/${spaceId}/${pageId}` : `/project/pages/${pageId}`
  return {
    spaceId,
    pageId,
    hostname,
    key: `${hostname}:${pageId}`,
    url: `https://${hostname}${pathName}`,
  }
}

async function requestDoorayTask(endpoint, config, fetchImpl, timeoutMs) {
  try {
    return await fetchImpl(endpoint, {
      headers: {
        Authorization: `dooray-api ${config.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new DoorayTaskError('UPSTREAM_UNAVAILABLE', 'Dooray 업무 조회 서버에 연결하지 못했습니다.', 502)
  }
}

function throwForDoorayResponse(response, messages) {
  if (response.status === 401 || response.status === 403) {
    throw new DoorayTaskError('ACCESS_DENIED', messages.accessDenied, 403)
  }
  if (response.status === 404) {
    throw new DoorayTaskError('NOT_FOUND', messages.notFound, 404)
  }
  if (!response.ok) {
    throw new DoorayTaskError('UPSTREAM_ERROR', messages.upstreamError, 502)
  }
}

export async function fetchDoorayTaskPreview(taskUrl, config, {
  // 설정에 Dooray 연결 함수(외부 모듈 연결 지점, doorayTransport.mjs)가 있으면 그것을 쓴다.
  fetchImpl = config?.fetch ?? fetch,
  timeoutMs = 8_000,
  now = () => new Date(),
} = {}) {
  if (!config?.apiKey) {
    throw new DoorayTaskError('CONFIG_UNAVAILABLE', 'Dooray API 키가 설정되어 있지 않습니다.', 503)
  }
  const parsed = typeof taskUrl === 'string' ? parseDoorayTaskUrl(taskUrl) : taskUrl
  const baseUrl = normalizeDoorayBaseUrl(config.baseUrl)
  const globalEndpoint = `${baseUrl}/project/v1/posts/${encodeURIComponent(parsed.postId)}`
  let response = await requestDoorayTask(globalEndpoint, config, fetchImpl, timeoutMs)
  if (!response.ok && parsed.projectId) {
    const projectEndpoint = `${baseUrl}/project/v1/projects/${encodeURIComponent(parsed.projectId)}/posts/${encodeURIComponent(parsed.postId)}`
    response = await requestDoorayTask(projectEndpoint, config, fetchImpl, timeoutMs)
  }

  throwForDoorayResponse(response, {
    accessDenied: 'Dooray 업무를 조회할 권한이 없습니다.',
    notFound: 'Dooray 업무를 찾을 수 없습니다.',
    upstreamError: 'Dooray 업무를 조회하지 못했습니다.',
  })

  let payload
  try {
    payload = await response.json()
  } catch {
    throw new DoorayTaskError('INVALID_RESPONSE', 'Dooray 업무 응답을 해석하지 못했습니다.', 502)
  }
  const result = payload?.result
  const subject = typeof result?.subject === 'string' ? result.subject.trim().slice(0, 240) : ''
  if (!subject) {
    throw new DoorayTaskError('INVALID_RESPONSE', 'Dooray 업무 제목을 확인하지 못했습니다.', 502)
  }
  const resolvedProjectId = String(result?.project?.id ?? parsed.projectId ?? '').trim()
  if (!/^\d+$/.test(resolvedProjectId)) {
    throw new DoorayTaskError('INVALID_RESPONSE', 'Dooray 업무의 현재 프로젝트를 확인하지 못했습니다.', 502)
  }
  const canonicalUrl = `https://${parsed.hostname}/task/${resolvedProjectId}/${parsed.postId}`
  const navigationUrl = parsed.commentId ? `${canonicalUrl}#comment-${parsed.commentId}` : canonicalUrl

  return {
    provider: 'dooray-task',
    url: navigationUrl,
    hostname: parsed.hostname,
    projectId: resolvedProjectId,
    postId: parsed.postId,
    subject,
    taskNumber: typeof result.taskNumber === 'string' ? result.taskNumber.trim().slice(0, 160) : '',
    workflowName: typeof result.workflow?.name === 'string' ? result.workflow.name.trim().slice(0, 120) : '',
    workflowClass: typeof result.workflowClass === 'string' ? result.workflowClass.trim().slice(0, 40) : '',
    closed: result.closed === true,
    resolvedAt: now().toISOString(),
  }
}

export async function fetchDoorayWikiPreview(wikiUrl, config, {
  fetchImpl = config?.fetch ?? fetch,
  timeoutMs = 8_000,
  now = () => new Date(),
} = {}) {
  if (!config?.apiKey) {
    throw new DoorayTaskError('CONFIG_UNAVAILABLE', 'Dooray API 키가 설정되어 있지 않습니다.', 503)
  }
  const parsed = typeof wikiUrl === 'string' ? parseDoorayWikiUrl(wikiUrl) : wikiUrl
  const baseUrl = normalizeDoorayBaseUrl(config.baseUrl)
  const endpoint = `${baseUrl}/wiki/v1/pages/${encodeURIComponent(parsed.pageId)}`
  const response = await requestDoorayTask(endpoint, config, fetchImpl, timeoutMs)
  throwForDoorayResponse(response, {
    accessDenied: 'Dooray Wiki 페이지를 조회할 권한이 없습니다.',
    notFound: 'Dooray Wiki 페이지를 찾을 수 없습니다.',
    upstreamError: 'Dooray Wiki 페이지를 조회하지 못했습니다.',
  })

  let payload
  try {
    payload = await response.json()
  } catch {
    throw new DoorayTaskError('INVALID_RESPONSE', 'Dooray Wiki 응답을 해석하지 못했습니다.', 502)
  }
  const result = payload?.result
  const subject = typeof result?.subject === 'string' ? result.subject.trim().slice(0, 240) : ''
  const pageId = String(result?.id ?? '').trim()
  const wikiId = String(result?.wikiId ?? '').trim()
  if (!subject || pageId !== parsed.pageId || !/^\d+$/.test(wikiId)) {
    throw new DoorayTaskError('INVALID_RESPONSE', 'Dooray Wiki 페이지 정보를 확인하지 못했습니다.', 502)
  }

  return {
    provider: 'dooray-wiki',
    url: parsed.url,
    hostname: parsed.hostname,
    wikiId,
    pageId,
    subject,
    resolvedAt: now().toISOString(),
  }
}

export async function fetchDoorayCommentAuthor(taskUrl, config, {
  fetchImpl = config?.fetch ?? fetch,
  timeoutMs = 8_000,
} = {}) {
  if (!config?.apiKey) {
    throw new DoorayTaskError('CONFIG_UNAVAILABLE', 'Dooray API 키가 설정되어 있지 않습니다.', 503)
  }
  const parsed = typeof taskUrl === 'string' ? parseDoorayTaskUrl(taskUrl) : taskUrl
  if (!parsed.commentId || !parsed.projectId) return null

  const baseUrl = normalizeDoorayBaseUrl(config.baseUrl)
  const commentEndpoint = `${baseUrl}/project/v1/projects/${encodeURIComponent(parsed.projectId)}/posts/${encodeURIComponent(parsed.postId)}/logs/${encodeURIComponent(parsed.commentId)}`
  const commentResponse = await requestDoorayTask(commentEndpoint, config, fetchImpl, timeoutMs)
  throwForDoorayResponse(commentResponse, {
    accessDenied: 'Dooray 코멘트를 조회할 권한이 없습니다.',
    notFound: 'Dooray 코멘트를 찾을 수 없습니다.',
    upstreamError: 'Dooray 코멘트를 조회하지 못했습니다.',
  })

  let comment
  try {
    comment = (await commentResponse.json())?.result
  } catch {
    throw new DoorayTaskError('INVALID_RESPONSE', 'Dooray 코멘트 응답을 해석하지 못했습니다.', 502)
  }
  if (String(comment?.id ?? '') !== parsed.commentId) {
    throw new DoorayTaskError('INVALID_RESPONSE', 'Dooray 코멘트 정보를 확인하지 못했습니다.', 502)
  }

  const creator = comment?.creator
  const memberId = String(creator?.member?.organizationMemberId ?? '').trim()
  let authorName = [
    creator?.member?.name,
    creator?.emailUser?.name,
    creator?.emailUser?.emailAddress,
    creator?.group?.name,
    creator?.workflow?.name,
  ].find((value) => typeof value === 'string' && value.trim())?.trim() ?? ''

  if (!authorName && /^\d+$/.test(memberId)) {
    const memberEndpoint = `${baseUrl}/common/v1/members/${encodeURIComponent(memberId)}`
    const memberResponse = await requestDoorayTask(memberEndpoint, config, fetchImpl, timeoutMs)
    if (memberResponse.ok) {
      try {
        const member = (await memberResponse.json())?.result
        authorName = typeof member?.name === 'string' ? member.name.trim() : ''
      } catch {
        // 이름을 해석하지 못해도 코멘트 링크 자체는 계속 표시합니다.
      }
    }
  }

  return {
    id: parsed.commentId,
    authorName: authorName.slice(0, 120),
  }
}

export function isValidDoorayTaskLinkData(value) {
  if (!value || value.provider !== 'dooray-task') return false
  let parsed
  try {
    parsed = parseDoorayTaskUrl(value.url)
  } catch {
    return false
  }
  return parsed.projectId === value.projectId
    && parsed.postId === value.postId
    && typeof value.hostname === 'string'
    && value.hostname === parsed.hostname
    && (value.title === undefined || (typeof value.title === 'string' && value.title.length <= 240))
    && typeof value.taskNumber === 'string'
    && value.taskNumber.length <= 160
    && typeof value.workflowName === 'string'
    && value.workflowName.length <= 120
    && typeof value.workflowClass === 'string'
    && value.workflowClass.length <= 40
    && typeof value.closed === 'boolean'
    && typeof value.resolvedAt === 'string'
    && Number.isFinite(Date.parse(value.resolvedAt))
    && Number.isFinite(value.displayWidth)
    && value.displayWidth >= 160
    && value.displayWidth <= 1_200
    && Number.isFinite(value.displayHeight)
    && value.displayHeight >= 96
    && value.displayHeight <= 800
}

export function isValidDoorayWikiLinkData(value) {
  if (!value || value.provider !== 'dooray-wiki') return false
  let parsed
  try {
    parsed = parseDoorayWikiUrl(value.url)
  } catch {
    return false
  }
  return parsed.pageId === value.pageId
    && typeof value.hostname === 'string'
    && value.hostname === parsed.hostname
    && typeof value.wikiId === 'string'
    && /^\d+$/.test(value.wikiId)
    && (value.title === undefined || (typeof value.title === 'string' && value.title.length <= 240))
    && typeof value.resolvedAt === 'string'
    && Number.isFinite(Date.parse(value.resolvedAt))
    && Number.isFinite(value.displayWidth)
    && value.displayWidth >= 160
    && value.displayWidth <= 1_200
    && Number.isFinite(value.displayHeight)
    && value.displayHeight >= 96
    && value.displayHeight <= 800
}

export function isValidDoorayKnowledgeLinkData(value) {
  return isValidDoorayTaskLinkData(value) || isValidDoorayWikiLinkData(value)
}
