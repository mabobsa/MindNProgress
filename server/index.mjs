import { createServer } from 'node:http'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyProgressRollup } from './lib/progressRollup.mjs'
import { detectReleasedWaitingItems } from './lib/waitingItems.mjs'
import { resolveAttributionWithoutToken, resolveScopedAttribution } from './lib/attributionScope.mjs'
import { readAionUiSubscriptionUsage } from './lib/aionUiSubscriptionUsage.mjs'
import {
  inactiveAiConversationRuntime,
  normalizeAionUiConversationRuntime,
  parseAionUiActiveConversationRuntimeSnapshot,
  unavailableAiConversationRuntime,
} from './lib/aionUiConversationRuntimes.mjs'
import {
  activeAiDelegationsForConversation,
  aiDelegationWaitPollDue,
  aiDelegationBlocksResume,
  aiDelegationStateAfterParentWake,
  aiDelegationSucceeded,
  aiDelegationWorkspaceLeaseMatches,
  aiDelegationSelectionFromSource,
  createAiDelegationRequestSignature,
  explicitCompletionAiDelegationsForConversation,
  failedAiIntegrationRecoveryRuntime,
  formatAiConversationTitle,
  initialAiDelegationRuntime,
  isValidAiDelegationId,
  mergeAiDelegationSelections,
  nextAiDelegationWaitPoll,
  shouldReconcileAiDelegationChildWorkspace,
} from './lib/aiDelegations.mjs'
import {
  detectImageAssetType,
  imageAssetMimeType,
  isValidImageAssetId,
  isValidImageNodeData,
} from './lib/imageAssets.mjs'
import {
  commentForResponse,
  createCommentContent,
  updateCommentContent,
} from './lib/commentContent.mjs'
import {
  DoorayTaskError,
  fetchDoorayCommentAuthor,
  fetchDoorayTaskPreview,
  fetchDoorayWikiPreview,
  isValidDoorayKnowledgeLinkData,
  loadDoorayApiConfig,
  parseDoorayTaskUrl,
  parseDoorayWikiUrl,
} from './lib/doorayTasks.mjs'
import {
  AI_WORKSPACE_HISTORY_LIMIT,
  AI_WORKSPACE_MAX_LENGTH,
  normalizeAiWorkspaceHistory,
  rememberAiWorkspace,
  removeAiWorkspace,
} from '../src/utils/aiWorkspaceHistory.mjs'
import {
  isAiConversationPurpose,
} from '../src/utils/aiConversationLaunch.mjs'
import {
  aiConversationIdsFromData,
  aiConversationLinkFromAionUiConversation,
  aiConversationLinksFromData,
  aggregateAiConversationRuntime,
  appendAiConversationLink,
  isAiConversationLinked,
  normalizeAiConversationLink,
  removeAiConversationLink,
} from '../src/utils/aiConversations.mjs'
import {
  AionUiExternalLaunchPayloadError,
  createAionUiWebLaunchUrl,
  normalizeAionUiExternalLaunchPayload,
  parseMindNProgressCompletionToken,
} from './lib/aionUiExternalLaunch.mjs'
import { isLocalLoopbackRequest, localLoopbackRedirectLocation } from './lib/localLoopbackRedirect.mjs'
import { listWorkspaceDirectory, listWorkspaceRoots } from './lib/workspaceBrowse.mjs'
import { buildSharedKnowledgeAudit } from './lib/sharedKnowledgeAudit.mjs'
import {
  SharedKnowledgeMaintenanceError,
  buildSharedKnowledgeReviewContext,
  prepareSharedKnowledgeReviewBatch,
  verifySharedKnowledgeReviewChanges,
} from './lib/sharedKnowledgeMaintenance.mjs'
import {
  isValidSharedKnowledgeReview,
  normalizeMapSharedKnowledgeReviews,
  reconcileSharedKnowledgeReviews,
} from './lib/sharedKnowledgeReview.mjs'
import {
  WorkspacePoolIntegrationError,
  WorkspacePoolManager,
  WorkspacePoolUnavailableError,
  buildWorkspaceInstruction,
  checkpointCommitMessageExample,
  integrationStatusRetryReasonCode,
  integrationWorktreeDirtyMessage,
  integrationWorktreeDirtyReasonCode,
} from './lib/workspacePool.mjs'

const serverDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectDirectory = path.resolve(serverDirectory, '..')
const dataDirectory = path.resolve(String(process.env.MNP_DATA_DIR ?? '').trim() || path.join(serverDirectory, 'data'))
const historyDirectory = path.join(dataDirectory, '_history')
const dailyBackupDirectory = path.join(dataDirectory, '_daily-backups')
const commentsDirectory = path.join(dataDirectory, '_comments')
const notificationsDirectory = path.join(dataDirectory, '_notifications')
const imageAssetsDirectory = path.join(dataDirectory, '_assets')
const usersFile = path.join(dataDirectory, '_users.json')
const sessionsFile = path.join(dataDirectory, '_sessions.json')
const aiAttributionsFile = path.join(dataDirectory, '_ai-attributions.json')
const aiConversationAttributionsFile = path.join(dataDirectory, '_ai-conversation-attributions.json')
const aiConversationOriginsFile = path.join(dataDirectory, '_ai-conversation-origins.json')
const aiDelegationsFile = path.join(dataDirectory, '_ai-delegations.json')
const workspacePoolStateFile = path.join(dataDirectory, '_workspace-pool.json')
const aiWorkspaceHistoriesFile = path.join(dataDirectory, '_ai-workspace-histories.json')
const integrationTokenFile = path.join(dataDirectory, '_integration-token')
const mapOrderFile = path.join(dataDirectory, '_map-order.json')
const distDirectory = path.join(projectDirectory, 'dist')
const port = Number(process.env.MNP_API_PORT ?? 4176)
const host = process.env.MNP_API_HOST ?? '127.0.0.1'
const webPort = Number(process.env.MNP_WEB_PORT ?? 4175)
const configuredAionUiBaseUrl = String(process.env.MNP_AIONUI_URL ?? '').trim()
const configuredAionUiBaseUrls = configuredAionUiBaseUrl ? [configuredAionUiBaseUrl.replace(/\/+$/, '')] : []
const configuredAionUiWebBaseUrl = String(process.env.MNP_AIONUI_WEB_URL ?? '').trim()
const fallbackAionUiBaseUrls = ['http://127.0.0.1:1986', 'http://127.0.0.1:5830']
const aionUiDiscoveryFile = path.resolve(
  String(process.env.MNP_AIONUI_DISCOVERY_FILE ?? '').trim() || path.join(tmpdir(), 'aionui-backend.json'),
)
const aionUiSubscriptionUsageFile = path.resolve(
  String(process.env.MNP_AIONUI_USAGE_FILE ?? '').trim() || path.join(tmpdir(), 'aionui-subscription-usage.json'),
)
const aionUiSubscriptionUsageStaleAfterMs = Math.max(
  60_000,
  Number(process.env.MNP_AIONUI_USAGE_STALE_AFTER_MS) || 180_000,
)
const workspacePoolRegistryFile = path.resolve(
  String(process.env.MNP_WORKSPACE_POOL_REGISTRY ?? '').trim()
    || path.join(projectDirectory, 'workspaces.json'),
)
const imageAssetMaxBytes = Math.max(1_000_000, Number(process.env.MNP_IMAGE_MAX_BYTES) || 15_000_000)
let activeAionUiBaseUrl = configuredAionUiBaseUrls[0] ?? fallbackAionUiBaseUrls[0]
let doorayApiConfigPromise = null
const doorayTaskPreviewCache = new Map()
const doorayCommentAuthorCache = new Map()
const doorayTaskTitleCacheDurationMs = 5 * 60 * 1000
const doorayTaskTitleBatchLimit = 50
const sessionDurationMs = 8 * 60 * 60 * 1000
const rememberedSessionDurationMs = 30 * 24 * 60 * 60 * 1000
const sessions = new Map()
let sessionWriteQueue = Promise.resolve()
const eventClients = new Map()
const eventHeartbeatIntervalMs = Math.max(100, Number(process.env.MNP_EVENT_HEARTBEAT_INTERVAL_MS) || 25_000)
const aiConversationRuntimeStates = new Map()
const aiConversationRuntimeRefreshes = new Map()
const aiConversationRuntimeRequests = new Map()
const aiConversationRuntimeSummaries = new Map()
const aiDelegations = new Map()
let aiDelegationWriteQueue = Promise.resolve()
let aiDelegationPollRunning = false
const aiDelegationWaitPolls = new Map()
const workspacePoolManager = new WorkspacePoolManager({
  registryFile: workspacePoolRegistryFile,
  stateFile: workspacePoolStateFile,
})
let aiConversationRuntimeLibraryRefresh = null
let aiConversationRuntimeSnapshotRequest = null
let aiConversationRuntimeSnapshotCache = null
let aiConversationRuntimeSnapshotCachedAt = 0
let aiConversationRuntimeSnapshotLastSuccessAt = 0
let aionCoreDispatchCapabilitiesCache = null
let aionCoreDispatchCapabilitiesCachedAt = 0
let aionCoreDispatchCapabilitiesRequest = null
const aionCoreDispatchCapabilitiesCacheMs = Math.max(
  500,
  Number(process.env.MNP_AIONCORE_CAPABILITIES_CACHE_MS) || 3_000,
)
const aiConversationRuntimePollIntervalMs = Math.max(2_000, Number(process.env.MNP_AI_RUNTIME_POLL_INTERVAL_MS) || 4_000)
const aiConversationRuntimeFailureGraceMs = Math.max(
  aiConversationRuntimePollIntervalMs * 2,
  Number(process.env.MNP_AI_RUNTIME_FAILURE_GRACE_MS) || 10_000,
)
const aiDelegationPollIntervalMs = Math.max(100, Number(process.env.MNP_AI_DELEGATION_POLL_INTERVAL_MS) || 3_000)
const mapColors = ['violet', 'indigo', 'blue', 'cyan', 'teal', 'green', 'amber', 'orange', 'red', 'pink']
const commentReactions = ['👍', '❤️', '🎉', '👀']
const serverStartedAt = new Date().toISOString()

function detectedPublicIpv4() {
  const virtualInterfacePattern = /(?:vethernet|wsl|docker|hyper-v|vmware|virtualbox|loopback|터널)/i
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => (address.family === 'IPv4' || address.family === 4)
        && !address.internal
        && !address.address.startsWith('169.254.'))
      .map((address) => ({ name, address: address.address })))
  candidates.sort((first, second) => Number(virtualInterfacePattern.test(first.name)) - Number(virtualInterfacePattern.test(second.name)))
  return candidates[0]?.address ?? '127.0.0.1'
}

function resolvePublicBaseUrl() {
  const configured = String(process.env.MNP_PUBLIC_URL ?? '').trim()
  if (configured) {
    try {
      const url = new URL(/^https?:\/\//i.test(configured) ? configured : `http://${configured}`)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        url.search = ''
        url.hash = ''
        return url.toString().replace(/\/+$/, '')
      }
    } catch {
      console.warn('[Mind & Progress] MNP_PUBLIC_URL이 올바르지 않아 자동 감지 주소를 사용합니다.')
    }
  }
  return `http://${detectedPublicIpv4()}:${webPort}`
}

const publicBaseUrl = resolvePublicBaseUrl()

function resolveAionUiWebBaseUrl() {
  const candidate = configuredAionUiWebBaseUrl || (() => {
    const url = new URL(publicBaseUrl)
    url.port = '7777'
    return url.toString()
  })()

  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('UNSUPPORTED_PROTOCOL')
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    console.warn('[Mind & Progress] MNP_AIONUI_WEB_URL이 올바르지 않아 공개 주소의 7777 포트를 사용합니다.')
    const fallback = new URL(publicBaseUrl)
    fallback.port = '7777'
    fallback.pathname = '/'
    fallback.search = ''
    fallback.hash = ''
    return fallback.toString().replace(/\/+$/, '')
  }
}

const aionUiWebBaseUrl = resolveAionUiWebBaseUrl()

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64)
}

function temporaryPassword() {
  return `${randomBytes(8).toString('base64url')}!A7`
}

const bootstrapAdminEmail = String(process.env.MNP_ADMIN_EMAIL ?? 'admin@mind.local').trim().toLowerCase()
const configuredAdminPassword = String(process.env.MNP_ADMIN_PASSWORD ?? '')
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapAdminEmail)) {
  throw new Error('MNP_ADMIN_EMAIL must be a valid email address.')
}
if (configuredAdminPassword && configuredAdminPassword.length < 8) {
  throw new Error('MNP_ADMIN_PASSWORD must be at least 8 characters.')
}

const generatedAdminPassword = configuredAdminPassword ? null : temporaryPassword()
const bootstrapAdminPassword = configuredAdminPassword || generatedAdminPassword
const bootstrapAdminSalt = randomBytes(16).toString('hex')
const seedAdmin = {
  id: 'user-admin',
  name: '시스템 관리자',
  email: bootstrapAdminEmail,
  role: 'admin',
  active: true,
  createdAt: serverStartedAt,
  updatedAt: serverStartedAt,
  lastLoginAt: null,
  salt: bootstrapAdminSalt,
  passwordHash: hashPassword(bootstrapAdminPassword, bootstrapAdminSalt),
}
const seedPublicViewer = {
  id: 'user-public-viewer',
  name: '공개 뷰어',
  email: 'public-viewer@mind.invalid',
  role: 'viewer',
  active: true,
  systemManaged: true,
  createdAt: serverStartedAt,
  updatedAt: serverStartedAt,
  lastLoginAt: null,
  salt: randomBytes(16).toString('hex'),
  passwordHash: randomBytes(64),
}
const seedUsers = [seedAdmin, seedPublicViewer]
let users = seedUsers
const systemUser = { id: 'system', name: 'Mind & Progress', email: 'system@mind.local', role: 'viewer' }
const integrationUser = {
  id: 'system-aionui-ai',
  name: 'AI(모델 미지정)',
  email: 'aionui-ai@mind.invalid',
  role: 'editor',
  active: true,
}
let integrationToken = ''
const aiAttributionDurationMs = Math.max(50, Number(process.env.MNP_AI_ATTRIBUTION_DURATION_MS) || 8 * 60 * 60 * 1000)
const aiAttributions = new Map()
const aiConversationAttributions = new Map()
const aiConversationOrigins = new Map()
const aiConversationLaunches = new Map()
const aiWorkspaceHistories = new Map()
const aiAttributionContinuationToken = Symbol('aiAttributionContinuationToken')
let aiAttributionWriteQueue = Promise.resolve()
let aiConversationAttributionWriteQueue = Promise.resolve()
let aiConversationOriginWriteQueue = Promise.resolve()
let aiWorkspaceHistoryWriteQueue = Promise.resolve()

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, publicAccess: user.systemManaged === true }
}

function accountUser(user) {
  return {
    ...publicUser(user),
    active: user.active !== false,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
  }
}

function canEdit(user) {
  return user?.role === 'editor' || user?.role === 'admin'
}

function isPublicViewer(user) {
  return user?.systemManaged === true
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

function sendSharedKnowledgeMaintenanceError(response, error) {
  if (!(error instanceof SharedKnowledgeMaintenanceError)) return false
  sendJson(response, error.status, {
    error: error.message,
    code: error.code,
    ...error.details,
  })
  return true
}

function requestClientId(request) {
  return String(request.headers['x-mnp-client'] ?? '').slice(0, 120) || null
}

function removeEventClient(client) {
  const clientInfo = eventClients.get(client)
  if (!eventClients.delete(client) || !clientInfo?.mapId) return
  queueMicrotask(() => broadcastPresence(clientInfo.mapId))
}

async function replaceFileWithRetry(temporaryFile, targetFile) {
  const retryableCodes = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM'])
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporaryFile, targetFile)
      return
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt === 5) {
        await rm(temporaryFile, { force: true }).catch(() => undefined)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 15 * (2 ** attempt)))
    }
  }
}

function broadcastEvent(payload, predicate = () => true) {
  const message = `data: ${JSON.stringify(payload)}\n\n`
  for (const [client, clientInfo] of eventClients) {
    if (!predicate(clientInfo)) continue
    if (client.destroyed || client.writableEnded) {
      removeEventClient(client)
      continue
    }
    try {
      client.write(message)
    } catch {
      removeEventClient(client)
    }
  }
}

function broadcastNotification(notification) {
  broadcastEvent({ type: 'notification', notification }, (client) => client.user.id === notification.userId)
}

function broadcastPresence(mapId) {
  if (!mapId) return
  const clientsById = new Map()
  for (const client of eventClients.values()) {
    if (client.mapId === mapId) clientsById.set(client.clientId, { clientId: client.clientId, user: client.user })
  }
  broadcastEvent({ type: 'presence', mapId, clients: [...clientsById.values()] })
}

function broadcastMapChange(request, mapId, action, user) {
  broadcastEvent({
    type: 'map-changed',
    mapId,
    action,
    sourceClientId: requestClientId(request),
    updatedAt: new Date().toISOString(),
    updatedBy: publicUser(user),
  })
}

function parseCookies(request) {
  const cookies = new Map()
  for (const item of (request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    cookies.set(item.slice(0, separator).trim(), decodeURIComponent(item.slice(separator + 1).trim()))
  }
  return cookies
}

function sessionTokenKey(token) {
  return createHash('sha256').update(token).digest('hex')
}

function integrationRequestScope(request) {
  return {
    mapId: String(request.headers['x-mnp-ai-map-id'] ?? '').trim().slice(0, 120),
    cardId: String(request.headers['x-mnp-ai-card-id'] ?? '').trim().slice(0, 120),
    editorId: String(request.headers['x-mnp-ai-editor-id'] ?? '').trim().slice(0, 120),
    conversationId: String(request.headers['x-mnp-ai-conversation-id'] ?? '').trim().slice(0, 120),
  }
}

function conversationAttributionKey(mapId, cardId) {
  return `${mapId}:${cardId}`
}

function validAiConversationId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(String(value ?? ''))
}

function normalizeAiConversationOrigin(value) {
  const conversationId = String(value?.conversationId ?? '').trim()
  const mapId = String(value?.mapId ?? '').trim()
  const cardId = String(value?.cardId ?? '').trim()
  if (!validAiConversationId(conversationId) || !isValidMapId(mapId) || !cardId || cardId.length > 120) return null
  const workspace = String(value?.workspace ?? '').trim().slice(0, 4_096) || null
  const workspacePoolId = String(value?.workspacePoolId ?? '').trim().slice(0, 120) || null
  return {
    conversationId,
    mapId,
    cardId,
    startedBy: String(value?.startedBy ?? '').trim().slice(0, 120) || null,
    linkedAt: normalizedIsoDate(value?.linkedAt),
    ...(workspace ? { workspace } : {}),
    ...(workspacePoolId ? { workspacePoolId } : {}),
  }
}

function rememberAiConversationOrigin(value) {
  const origin = normalizeAiConversationOrigin(value)
  if (!origin) return null
  const existing = aiConversationOrigins.get(origin.conversationId)
  if (existing) {
    const enriched = {
      ...existing,
      ...(origin.workspace ? { workspace: origin.workspace } : {}),
      ...(origin.workspacePoolId ? { workspacePoolId: origin.workspacePoolId } : {}),
    }
    aiConversationOrigins.set(origin.conversationId, enriched)
    return enriched
  }
  aiConversationOrigins.set(origin.conversationId, origin)
  return origin
}

function scopedAttribution(request) {
  return resolveScopedAttribution(integrationRequestScope(request), [...aiAttributions.values()], aiConversationAttributions)
}

function attributionUser(attribution) {
  const editor = users.find((candidate) => candidate.id === attribution.startedBy
    && candidate.active !== false && canEdit(candidate))
  return editor
    ? { ...editor, name: attribution.authorName }
    : { ...integrationUser, name: attribution.authorName }
}

function requestDeclaredAiAuthorName(request) {
  const cleanIdentityPart = (value, maxLength) => [...String(value ?? '')]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('').trim().slice(0, maxLength)
  const aiType = cleanIdentityPart(request.headers['x-mnp-ai-type'], 120)
  const aiModel = cleanIdentityPart(request.headers['x-mnp-ai-model'], 160)
  return aiType && aiModel ? `${aiType}(${aiModel})` : ''
}

function traceAttribution(request, source, user, scope, attributionToken = '') {
  if (request.method === 'GET' && source === 'token') return
  let pathname = String(request.url ?? '')
  try { pathname = new URL(pathname, 'http://mindnprogress.local').pathname } catch { /* 원문 경로를 사용합니다. */ }
  console.log('[AI attribution]', JSON.stringify({
    source,
    method: request.method,
    path: pathname,
    mapId: scope.mapId || null,
    cardId: scope.cardId || null,
    editorId: scope.editorId || null,
    conversationId: scope.conversationId || null,
    actorId: user?.id ?? null,
    authorName: user?.name ?? null,
    tokenHashPrefix: attributionToken ? sessionTokenKey(attributionToken).slice(0, 12) : null,
    continuationIssued: Boolean(request[aiAttributionContinuationToken]),
  }))
}

function canContinueScopedAttribution(attribution, scope, match) {
  // 카드에 잠시 발급된 귀속만으로는 현재 호출자와 같은 AI인지 알 수 없다.
  // 요청이 밝힌 conversationId로 찾은 귀속, 영속 대화 귀속이거나
  // 동일 conversationId로 검증된 카드 귀속만 세션으로 이어간다.
  if (match === 'conversation-id' || match === 'conversation') return true
  if (match !== 'card' || !attribution.conversationId) return false
  const conversation = aiConversationAttributions.get(conversationAttributionKey(scope.mapId, scope.cardId))
  return Boolean(conversation
    && conversation.conversationId === attribution.conversationId
    && conversation.authorName === attribution.authorName
    && conversation.startedBy === attribution.startedBy)
}

function issueAttributionContinuation(request, attribution, scope, match) {
  if (String(request.headers['x-mnp-ai-request-attribution-continuation'] ?? '').trim().toLowerCase() !== 'true') return
  if (!attribution?.authorName || !scope.mapId || !scope.cardId) return
  if (!canContinueScopedAttribution(attribution, scope, match)) return

  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  aiAttributions.set(sessionTokenKey(token), {
    authorName: attribution.authorName,
    agentId: attribution.agentId ?? null,
    agentName: attribution.agentName ?? null,
    modelId: attribution.modelId ?? null,
    modelName: attribution.modelName ?? null,
    providerId: attribution.providerId ?? null,
    mapId: scope.mapId,
    cardId: scope.cardId,
    startedBy: attribution.startedBy ?? null,
    createdAt: now,
    expiresAt: now + aiAttributionDurationMs,
    ...(attribution.conversationId ? { conversationId: attribution.conversationId } : {}),
  })
  request[aiAttributionContinuationToken] = token
  void persistAiAttributions().catch((error) => console.error('[AI attribution persistence]', error))
}

function attributedIntegrationUser(request) {
  const editorId = String(request.headers['x-mnp-ai-editor-id'] ?? '').trim()
  const editor = editorId
    ? users.find((candidate) => candidate.id === editorId && candidate.active !== false && canEdit(candidate))
    : null
  const attributionToken = String(request.headers['x-mnp-ai-attribution'] ?? '').trim()
  if (!attributionToken) {
    const declaredAuthorName = requestDeclaredAiAuthorName(request)
    const resolved = resolveAttributionWithoutToken(
      integrationRequestScope(request),
      declaredAuthorName,
      [...aiAttributions.values()],
      aiConversationAttributions,
    )
    if (resolved.authorName) {
      const user = { ...(editor ?? integrationUser), name: resolved.authorName }
      traceAttribution(request, 'self-declared', user, resolved.scope)
      return user
    }
    if (resolved.attribution) {
      const user = attributionUser(resolved.attribution)
      issueAttributionContinuation(request, resolved.attribution, resolved.scope, resolved.match)
      traceAttribution(request, `${resolved.match}-scope-fallback`, user, resolved.scope)
      return user
    }
    const user = editor ? { ...editor, name: `${editor.name}의 AI` } : integrationUser
    traceAttribution(request, editor ? 'editor-fallback' : 'model-unspecified', user, resolved.scope)
    return user
  }
  const scoped = scopedAttribution(request)
  const tokenKey = sessionTokenKey(attributionToken)
  const attribution = aiAttributions.get(tokenKey)
  if (!attribution) {
    if (scoped.attribution) {
      const user = attributionUser(scoped.attribution)
      issueAttributionContinuation(request, scoped.attribution, scoped.scope, scoped.match)
      traceAttribution(request, `unknown-token-${scoped.match}-scope-fallback`, user, scoped.scope, attributionToken)
      return user
    }
    const user = editor ? { ...editor, name: `${editor.name}의 AI` } : null
    traceAttribution(request, editor ? 'unknown-token-editor-fallback' : 'unknown-token', user, scoped.scope, attributionToken)
    return user
  }
  if (attribution.expiresAt <= Date.now()) {
    aiAttributions.delete(tokenKey)
    void persistAiAttributions().catch((error) => console.error('[AI attribution persistence]', error))
    if (scoped.attribution) {
      const user = attributionUser(scoped.attribution)
      issueAttributionContinuation(request, scoped.attribution, scoped.scope, scoped.match)
      traceAttribution(request, `expired-token-${scoped.match}-scope-fallback`, user, scoped.scope, attributionToken)
      return user
    }
    const user = editor ? { ...editor, name: `${editor.name}의 AI` } : null
    traceAttribution(request, editor ? 'expired-token-editor-fallback' : 'expired-token', user, scoped.scope, attributionToken)
    return user
  }
  const user = attributionUser(attribution)
  traceAttribution(request, 'token', user, scoped.scope, attributionToken)
  return user
}

function hasValidIntegrationBearer(request) {
  const authorization = String(request.headers.authorization ?? '')
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!bearerToken || !integrationToken) return false
  const candidate = Buffer.from(bearerToken)
  const expected = Buffer.from(integrationToken)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

function getSignedInUser(request) {
  const token = parseCookies(request).get('mnp_session')
  if (!token) return null
  const tokenKey = sessionTokenKey(token)
  const session = sessions.get(tokenKey)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenKey)
    if (session.persistent) void persistSessions().catch((error) => console.error('[Session cleanup]', error))
    return null
  }
  return users.find((user) => user.id === session.userId && user.active !== false) ?? null
}

function getCurrentUser(request) {
  if (hasValidIntegrationBearer(request)) return attributedIntegrationUser(request)
  return getSignedInUser(request)
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > 2_000_000) throw new Error('PAYLOAD_TOO_LARGE')
    chunks.push(chunk)
  }

  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function getDoorayApiConfig() {
  doorayApiConfigPromise ??= loadDoorayApiConfig()
  return doorayApiConfigPromise
}

async function resolveDoorayTaskPreview(parsed, config) {
  const cached = doorayTaskPreviewCache.get(parsed.key)
  if (cached && cached.expiresAt > Date.now()) return cached.task

  const task = await fetchDoorayTaskPreview(parsed, config)
  doorayTaskPreviewCache.set(parsed.key, {
    task,
    expiresAt: Date.now() + doorayTaskTitleCacheDurationMs,
  })
  return task
}

async function resolveDoorayComment(parsed, task, config) {
  if (!parsed.commentId) return null
  const cached = doorayCommentAuthorCache.get(parsed.labelKey)
  if (cached && cached.expiresAt > Date.now()) return cached.comment

  const comment = await fetchDoorayCommentAuthor({
    ...parsed,
    projectId: task.projectId,
  }, config)
  doorayCommentAuthorCache.set(parsed.labelKey, {
    comment,
    expiresAt: Date.now() + doorayTaskTitleCacheDurationMs,
  })
  return comment
}

async function readBinaryBody(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new Error('PAYLOAD_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function requireUser(request, response) {
  const user = getCurrentUser(request)
  const continuationToken = request[aiAttributionContinuationToken]
  if (user && continuationToken) response.setHeader('X-MNP-AI-Attribution-Continuation', continuationToken)
  if (!user) sendJson(response, 401, { error: '로그인이 필요합니다.' })
  return user
}

function requireSignedInUser(request, response) {
  const user = getSignedInUser(request)
  if (!user) sendJson(response, 401, { error: '로그인이 필요합니다.' })
  return user
}

function requireAdmin(request, response) {
  const user = requireUser(request, response)
  if (!user) return null
  if (user.role !== 'admin') {
    sendJson(response, 403, { error: '관리자 권한이 필요합니다.' })
    return null
  }
  return user
}

function isValidMap(map) {
  if (!map || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) return false
  if (map.nodes.length > 1000 || map.edges.length > 2000) return false
  return map.nodes.every((node) =>
    typeof node?.id === 'string'
    && node.id.length <= 120
    && (node.data?.kind !== 'image' || isValidImageNodeData(node.data?.image))
    && (node.data?.externalLink === undefined
      || (isValidDoorayKnowledgeLinkData(node.data.externalLink)
        && node.data.taskUrl === node.data.externalLink.url))
    && (node.data?.sharedKnowledge === undefined
      || (typeof node.data.sharedKnowledge === 'string' && node.data.sharedKnowledge.length <= 10_000))
    && (node.data?.sharedKnowledgeReview === undefined
      || isValidSharedKnowledgeReview(node.data.sharedKnowledgeReview))
    && (node.data?.waitingItems === undefined
      || (Array.isArray(node.data.waitingItems)
        && node.data.waitingItems.length <= 20
        && node.data.waitingItems.every((item) =>
          typeof item?.id === 'string'
          && item.id.length > 0
          && item.id.length <= 120
          && typeof item.label === 'string'
          && item.label.trim().length > 0
          && item.label.length <= 120
          && (item.note === undefined || (typeof item.note === 'string' && item.note.length <= 1000))
          && (item.resumeCondition === undefined || (typeof item.resumeCondition === 'string' && item.resumeCondition.length <= 500))
          && typeof item.since === 'string'
          && item.since.length <= 40
          && Number.isFinite(Date.parse(item.since))))))
    && map.edges.every((edge) => typeof edge?.id === 'string' && typeof edge?.source === 'string' && typeof edge?.target === 'string')
}

function normalizeMapRuntimeState(map) {
  if (!map || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) return map
  return {
    ...map,
    nodes: map.nodes.map((node) => {
      const normalized = { ...node }
      delete normalized.selected
      delete normalized.dragging
      delete normalized.measured
      delete normalized.width
      delete normalized.height
      delete normalized.resizing
      return normalized
    }),
    edges: map.edges.map((edge) => {
      const normalized = { ...edge }
      delete normalized.selected
      return normalized
    }),
  }
}

function normalizeMapEdges(map) {
  if (!map || !Array.isArray(map.edges)) return map
  return {
    ...map,
    edges: map.edges.map((edge) => ({
      ...edge,
      type: 'default',
      markerEnd: {
        ...edge.markerEnd,
        type: 'arrowclosed',
        width: 16,
        height: 16,
      },
    })),
  }
}

function normalizeMapAssignees(map) {
  if (!map || !Array.isArray(map.nodes)) return map
  const editorIds = new Set(users.filter((user) => user.role === 'editor').map((user) => user.id))
  return {
    ...map,
    nodes: map.nodes.map((node) => {
      const currentId = node.data?.assigneeId
      if (!currentId) return node
      const normalizedId = currentId === 'kim' ? 'user-editor' : currentId
      if (!editorIds.has(normalizedId)) {
        const data = { ...node.data }
        delete data.assigneeId
        return { ...node, data }
      }
      if (normalizedId !== currentId) return { ...node, data: { ...node.data, assigneeId: normalizedId } }
      return node
    }),
  }
}

function normalizeMapAiConversations(map) {
  if (!map || !Array.isArray(map.nodes)) return map
  return {
    ...map,
    nodes: map.nodes.map((node) => {
      const links = aiConversationLinksFromData(node.data)
      const data = { ...(node.data ?? {}) }
      if (links.length === 0) {
        delete data.aiConversationId
        delete data.aiConversations
      } else {
        data.aiConversations = links
        if (!isAiConversationLinked(data, data.aiConversationId)) data.aiConversationId = links.at(-1).conversationId
      }
      return { ...node, data }
    }),
  }
}

function normalizeMapForPersistence(map) {
  return applyProgressRollup(normalizeMapAiConversations(normalizeMapAssignees(normalizeMapSharedKnowledgeReviews(
    normalizeMapRuntimeState(normalizeMapEdges(map)),
  ))))
}

function normalizeSharedKnowledgeMetadata(existing, map, user, updatedAt) {
  if (!map || !Array.isArray(map.nodes)) return map
  const existingNodes = new Map((existing?.nodes ?? []).map((node) => [node.id, node]))
  const updatedBy = publicUser(user)

  return {
    ...map,
    nodes: map.nodes.map((node) => {
      const data = { ...(node.data ?? {}) }
      const existingData = existingNodes.get(node.id)?.data
      const sharedKnowledge = typeof data.sharedKnowledge === 'string' ? data.sharedKnowledge : ''
      const existingSharedKnowledge = typeof existingData?.sharedKnowledge === 'string' ? existingData.sharedKnowledge : ''

      if (sharedKnowledge !== existingSharedKnowledge || !existingData) {
        if (sharedKnowledge.trim()) {
          data.sharedKnowledgeUpdatedAt = updatedAt
          data.sharedKnowledgeUpdatedBy = updatedBy
        } else {
          delete data.sharedKnowledgeUpdatedAt
          delete data.sharedKnowledgeUpdatedBy
        }
      } else {
        if (existingData.sharedKnowledgeUpdatedAt) data.sharedKnowledgeUpdatedAt = existingData.sharedKnowledgeUpdatedAt
        else delete data.sharedKnowledgeUpdatedAt
        if (existingData.sharedKnowledgeUpdatedBy) data.sharedKnowledgeUpdatedBy = existingData.sharedKnowledgeUpdatedBy
        else delete data.sharedKnowledgeUpdatedBy
      }

      return { ...node, data }
    }),
  }
}

function isValidMapId(mapId) {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(mapId)
}

function mapFileForId(mapId) {
  if (!isValidMapId(mapId)) throw new Error('INVALID_MAP_ID')
  return path.join(dataDirectory, `${mapId}.json`)
}

function imageAssetsDirectoryForMap(mapId) {
  if (!isValidMapId(mapId)) throw new Error('INVALID_MAP_ID')
  return path.join(imageAssetsDirectory, mapId)
}

function imageAssetFile(mapId, assetId) {
  if (!isValidImageAssetId(assetId)) throw new Error('INVALID_IMAGE_ASSET_ID')
  return path.join(imageAssetsDirectoryForMap(mapId), assetId)
}

function normalizeTitle(title, fallback = '새 마인드맵') {
  const normalized = String(title ?? '').trim().slice(0, 80)
  return normalized || fallback
}

function defaultMapColor(mapId) {
  const colorIndex = [...mapId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % mapColors.length
  return mapColors[colorIndex]
}

function normalizeMapColor(color, fallback) {
  return mapColors.includes(color) ? color : fallback
}

function mapRootState(map) {
  const hierarchyTargets = new Set((map.edges ?? [])
    .filter((edge) => edge.data?.relation !== 'knowledge')
    .map((edge) => edge.target))
  const root = map.nodes.find((node) => node.data?.kind === 'root' && !hierarchyTargets.has(node.id))
    ?? map.nodes.find((node) => node.data?.kind === 'root')
    ?? map.nodes.find((node) => !hierarchyTargets.has(node.id))
    ?? map.nodes[0]
  const progress = Number(root?.data?.progress)
  return {
    progress: Number.isFinite(progress) ? Math.round(Math.max(0, Math.min(100, progress))) : null,
    status: typeof root?.data?.status === 'string' ? root.data.status : null,
  }
}

function mapSummary(map) {
  const root = mapRootState(map)
  const waitingCount = map.nodes.reduce((count, node) => count + (
    Array.isArray(node.data?.waitingItems)
      ? node.data.waitingItems.filter((item) => typeof item?.label === 'string' && item.label.trim()).length
      : 0
  ), 0)
  return {
    id: map.id,
    title: map.title,
    color: normalizeMapColor(map.color, defaultMapColor(map.id)),
    nodeCount: map.nodes.length,
    rootProgress: root.progress,
    rootStatus: root.status,
    waitingCount,
    version: map.version ?? 1,
    updatedAt: map.updatedAt ?? null,
    updatedBy: map.updatedBy ?? null,
    createdAt: map.createdAt ?? map.updatedAt ?? null,
    createdBy: map.createdBy ?? map.updatedBy ?? null,
    trashedAt: map.trashedAt ?? null,
    trashedBy: map.trashedBy ?? null,
  }
}

async function readMap(mapId) {
  try {
    const stored = JSON.parse(await readFile(mapFileForId(mapId), 'utf8'))
    return normalizeMapForPersistence({
      ...stored,
      id: mapId,
      title: normalizeTitle(stored.title, '새 마인드맵'),
      createdAt: stored.createdAt ?? stored.updatedAt ?? null,
      createdBy: stored.createdBy ?? stored.updatedBy ?? null,
      version: Number.isInteger(stored.version) && stored.version > 0 ? stored.version : 1,
    })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function listMaps({ trashedOnly = false } = {}) {
  await mkdir(dataDirectory, { recursive: true })
  const entries = await readdir(dataDirectory, { withFileTypes: true })
  const maps = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && isValidMapId(entry.name.slice(0, -5)))
    .map((entry) => readMap(entry.name.slice(0, -5))))
  const summaries = maps
    .filter((map) => map && (trashedOnly ? Boolean(map.trashedAt) : !map.trashedAt))
    .map(mapSummary)
  if (trashedOnly) {
    return summaries.sort((first, second) => String(second.trashedAt ?? '').localeCompare(String(first.trashedAt ?? '')))
  }
  const documentLayout = await readDocumentLayout(summaries.map((map) => map.id))
  const savedOrder = flattenDocumentLayout(documentLayout)
  const orderIndex = new Map(savedOrder.map((mapId, index) => [mapId, index]))
  return summaries.sort((first, second) => {
      const firstIndex = orderIndex.get(first.id)
      const secondIndex = orderIndex.get(second.id)
      if (firstIndex !== undefined || secondIndex !== undefined) {
        if (firstIndex === undefined) return 1
        if (secondIndex === undefined) return -1
        return firstIndex - secondIndex
      }
      return String(second.updatedAt ?? '').localeCompare(String(first.updatedAt ?? ''))
    })
}

function defaultDocumentLayout(mapIds) {
  return {
    version: 1,
    items: mapIds.map((id) => ({ type: 'map', id })),
    groups: [],
  }
}

function isValidDocumentGroupId(groupId) {
  return typeof groupId === 'string' && /^group-[a-zA-Z0-9_-]{1,100}$/.test(groupId)
}

function normalizeDocumentLayout(value, mapIds) {
  const existingMapIds = new Set(mapIds)
  if (Array.isArray(value)) {
    const orderedIds = [...new Set(value.filter((mapId) => typeof mapId === 'string' && existingMapIds.has(mapId)))]
    return defaultDocumentLayout([...orderedIds, ...mapIds.filter((mapId) => !orderedIds.includes(mapId))])
  }
  if (!value || typeof value !== 'object') return defaultDocumentLayout(mapIds)

  const usedMapIds = new Set()
  const groups = []
  const groupsById = new Map()
  for (const candidate of Array.isArray(value.groups) ? value.groups : []) {
    const id = candidate?.id
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
    if (!isValidDocumentGroupId(id) || !name || name.length > 80 || groupsById.has(id)) continue
    const group = {
      id,
      name,
      mapIds: [...new Set((Array.isArray(candidate.mapIds) ? candidate.mapIds : [])
        .filter((mapId) => typeof mapId === 'string' && existingMapIds.has(mapId) && !usedMapIds.has(mapId)))],
    }
    group.mapIds.forEach((mapId) => usedMapIds.add(mapId))
    groups.push(group)
    groupsById.set(id, group)
  }

  const items = []
  const usedGroupIds = new Set()
  for (const candidate of Array.isArray(value.items) ? value.items : []) {
    if (candidate?.type === 'group' && groupsById.has(candidate.id) && !usedGroupIds.has(candidate.id)) {
      items.push({ type: 'group', id: candidate.id })
      usedGroupIds.add(candidate.id)
    } else if (candidate?.type === 'map'
      && existingMapIds.has(candidate.id)
      && !usedMapIds.has(candidate.id)) {
      items.push({ type: 'map', id: candidate.id })
      usedMapIds.add(candidate.id)
    }
  }

  groups.forEach((group) => {
    if (!usedGroupIds.has(group.id)) items.push({ type: 'group', id: group.id })
  })
  mapIds.forEach((mapId) => {
    if (!usedMapIds.has(mapId)) items.push({ type: 'map', id: mapId })
  })
  return { version: 1, items, groups }
}

function flattenDocumentLayout(layout) {
  const groupsById = new Map(layout.groups.map((group) => [group.id, group]))
  return layout.items.flatMap((item) => item.type === 'map'
    ? [item.id]
    : groupsById.get(item.id)?.mapIds ?? [])
}

function isCompleteDocumentLayout(layout, mapIds) {
  if (!layout || layout.version !== 1 || !Array.isArray(layout.items) || !Array.isArray(layout.groups)) return false
  if (layout.groups.length > 100 || layout.items.length > mapIds.length + layout.groups.length) return false
  const groupIds = new Set()
  const assignedMapIds = new Set()
  for (const group of layout.groups) {
    if (!isValidDocumentGroupId(group?.id)
      || groupIds.has(group.id)
      || typeof group.name !== 'string'
      || !group.name.trim()
      || group.name.trim().length > 80
      || !Array.isArray(group.mapIds)) return false
    groupIds.add(group.id)
    for (const mapId of group.mapIds) {
      if (typeof mapId !== 'string' || assignedMapIds.has(mapId)) return false
      assignedMapIds.add(mapId)
    }
  }
  const listedGroupIds = new Set()
  for (const item of layout.items) {
    if (item?.type === 'group') {
      if (!groupIds.has(item.id) || listedGroupIds.has(item.id)) return false
      listedGroupIds.add(item.id)
    } else if (item?.type === 'map') {
      if (typeof item.id !== 'string' || assignedMapIds.has(item.id)) return false
      assignedMapIds.add(item.id)
    } else {
      return false
    }
  }
  return listedGroupIds.size === groupIds.size
    && assignedMapIds.size === mapIds.length
    && mapIds.every((mapId) => assignedMapIds.has(mapId))
}

async function readDocumentLayout(mapIds) {
  try {
    return normalizeDocumentLayout(JSON.parse(await readFile(mapOrderFile, 'utf8')), mapIds)
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultDocumentLayout(mapIds)
    throw error
  }
}

async function writeDocumentLayout(layout) {
  await mkdir(dataDirectory, { recursive: true })
  const temporaryFile = `${mapOrderFile}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(layout, null, 2)}\n`, 'utf8')
  await replaceFileWithRetry(temporaryFile, mapOrderFile)
}

async function reconcileDocumentLayout(mapIds) {
  const layout = await readDocumentLayout(mapIds)
  await writeDocumentLayout(layout)
  return layout
}

async function writeStoredMap(mapId, payload) {
  await mkdir(dataDirectory, { recursive: true })
  const mapFile = mapFileForId(mapId)
  const temporaryFile = `${mapFile}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await replaceFileWithRetry(temporaryFile, mapFile)
}

async function migrateStoredMapEdges() {
  await mkdir(dataDirectory, { recursive: true })
  const entries = await readdir(dataDirectory, { withFileTypes: true })
  let migratedDocuments = 0
  let migratedEdges = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('_')) continue
    const mapId = entry.name.slice(0, -5)
    if (!isValidMapId(mapId)) continue
    const stored = JSON.parse(await readFile(path.join(dataDirectory, entry.name), 'utf8'))
    if (!isValidMap(stored)) continue
    const normalized = normalizeMapEdges(stored)
    const changedEdges = stored.edges.filter((edge, index) => JSON.stringify(edge) !== JSON.stringify(normalized.edges[index])).length
    if (changedEdges === 0) continue
    await writeStoredMap(mapId, normalized)
    migratedDocuments += 1
    migratedEdges += changedEdges
  }
  return { migratedDocuments, migratedEdges }
}

async function migrateStoredMapCreationMetadata() {
  await mkdir(dataDirectory, { recursive: true })
  const entries = await readdir(dataDirectory, { withFileTypes: true })
  let migratedDocuments = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('_')) continue
    const mapId = entry.name.slice(0, -5)
    if (!isValidMapId(mapId)) continue
    const stored = JSON.parse(await readFile(path.join(dataDirectory, entry.name), 'utf8'))
    if (!isValidMap(stored) || stored.createdAt && stored.createdBy) continue

    let earliestRevision = null
    try {
      const revisionDirectory = revisionDirectoryForMap(mapId)
      const revisionEntries = await readdir(revisionDirectory, { withFileTypes: true })
      for (const revisionEntry of revisionEntries) {
        if (!revisionEntry.isFile() || !revisionEntry.name.endsWith('.json')) continue
        const revision = JSON.parse(await readFile(path.join(revisionDirectory, revisionEntry.name), 'utf8'))
        if (revision?.mapId !== mapId || !isValidMap(revision.map)) continue
        if (!earliestRevision || String(revision.archivedAt).localeCompare(String(earliestRevision.archivedAt)) < 0) earliestRevision = revision
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    const createdAt = earliestRevision?.map?.createdAt
      ?? earliestRevision?.map?.updatedAt
      ?? earliestRevision?.archivedAt
      ?? stored.updatedAt
      ?? serverStartedAt
    const createdBy = earliestRevision?.map?.createdBy
      ?? earliestRevision?.map?.updatedBy
      ?? earliestRevision?.archivedBy
      ?? stored.updatedBy
      ?? systemUser
    await writeStoredMap(mapId, { ...stored, createdAt, createdBy })
    migratedDocuments += 1
  }
  return { migratedDocuments }
}

async function readStoredArray(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function writeStoredArray(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryFile = `${filePath}.${randomBytes(5).toString('hex')}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await replaceFileWithRetry(temporaryFile, filePath)
}

function serializedUser(user) {
  return {
    ...user,
    passwordHash: Buffer.isBuffer(user.passwordHash) ? user.passwordHash.toString('hex') : String(user.passwordHash ?? ''),
  }
}

async function persistUsers() {
  await writeStoredArray(usersFile, users.map(serializedUser))
}

function persistSessions() {
  const now = Date.now()
  const storedSessions = [...sessions.entries()]
    .filter(([, session]) => session.persistent && session.expiresAt > now)
    .map(([tokenHash, session]) => ({ tokenHash, userId: session.userId, expiresAt: session.expiresAt }))
  sessionWriteQueue = sessionWriteQueue.catch(() => {}).then(() => writeStoredArray(sessionsFile, storedSessions))
  return sessionWriteQueue
}

function persistAiAttributions() {
  const now = Date.now()
  const storedAttributions = [...aiAttributions.entries()]
    .filter(([, attribution]) => attribution.expiresAt > now)
    .map(([tokenHash, attribution]) => ({ tokenHash, ...attribution }))
  aiAttributionWriteQueue = aiAttributionWriteQueue.catch(() => {})
    .then(() => writeStoredArray(aiAttributionsFile, storedAttributions))
  return aiAttributionWriteQueue
}

function persistAiConversationAttributions() {
  const storedAttributions = [...aiConversationAttributions.values()]
    .sort((first, second) => String(first.mapId).localeCompare(String(second.mapId))
      || String(first.cardId).localeCompare(String(second.cardId)))
  aiConversationAttributionWriteQueue = aiConversationAttributionWriteQueue.catch(() => {})
    .then(() => writeStoredArray(aiConversationAttributionsFile, storedAttributions))
  return aiConversationAttributionWriteQueue
}

function persistAiConversationOrigins() {
  const storedOrigins = [...aiConversationOrigins.values()]
    .sort((first, second) => String(first.linkedAt).localeCompare(String(second.linkedAt))
      || String(first.conversationId).localeCompare(String(second.conversationId)))
  aiConversationOriginWriteQueue = aiConversationOriginWriteQueue.catch(() => {})
    .then(() => writeStoredArray(aiConversationOriginsFile, storedOrigins))
  return aiConversationOriginWriteQueue
}

function persistAiDelegations() {
  const storedDelegations = [...aiDelegations.values()]
    .sort((first, second) => String(first.createdAt).localeCompare(String(second.createdAt)))
  aiDelegationWriteQueue = aiDelegationWriteQueue.catch(() => {})
    .then(() => writeStoredArray(aiDelegationsFile, storedDelegations))
  return aiDelegationWriteQueue
}

function persistAiWorkspaceHistories() {
  const storedHistories = [...aiWorkspaceHistories.entries()]
    .sort(([firstUserId], [secondUserId]) => firstUserId.localeCompare(secondUserId))
    .map(([userId, workspaces]) => ({ userId, workspaces }))
  aiWorkspaceHistoryWriteQueue = aiWorkspaceHistoryWriteQueue.catch(() => {})
    .then(() => writeStoredArray(aiWorkspaceHistoriesFile, storedHistories))
  return aiWorkspaceHistoryWriteQueue
}

async function loadAiAttributions() {
  const now = Date.now()
  const storedAttributions = await readStoredArray(aiAttributionsFile)
  for (const attribution of storedAttributions) {
    if (!/^[a-f0-9]{64}$/.test(String(attribution?.tokenHash ?? ''))) continue
    if (!Number.isFinite(attribution?.expiresAt) || attribution.expiresAt <= now) continue
    const hasDocumentScope = isValidMapId(attribution?.mapId) && typeof attribution?.cardId === 'string' && attribution.cardId
    const hasConversationScope = validAiConversationId(attribution?.conversationId)
    if (!hasDocumentScope && !hasConversationScope) continue
    if (typeof attribution?.authorName !== 'string' || !attribution.authorName.trim()) continue
    const { tokenHash, ...value } = attribution
    aiAttributions.set(tokenHash, value)
  }
  await persistAiAttributions()
}

async function loadAiConversationAttributions() {
  const storedAttributions = await readStoredArray(aiConversationAttributionsFile)
  for (const attribution of storedAttributions) {
    if (!isValidMapId(attribution?.mapId) || typeof attribution?.cardId !== 'string' || !attribution.cardId) continue
    if (typeof attribution?.conversationId !== 'string' || !attribution.conversationId) continue
    if (typeof attribution?.authorName !== 'string' || !attribution.authorName.trim()) continue
    aiConversationAttributions.set(conversationAttributionKey(attribution.mapId, attribution.cardId), attribution)
  }
  await persistAiConversationAttributions()
}

async function loadAiConversationOrigins() {
  const storedOrigins = await readStoredArray(aiConversationOriginsFile)
  for (const storedOrigin of storedOrigins) rememberAiConversationOrigin(storedOrigin)
  await persistAiConversationOrigins()
}

async function recoverAiConversationOrigins() {
  const candidates = []
  for (const summary of await listMaps()) {
    const map = await readMap(summary.id)
    if (!map || map.trashedAt) continue
    for (const node of map.nodes) {
      for (const link of aiConversationLinksFromData(node.data)) {
        candidates.push({
          conversationId: link.conversationId,
          mapId: map.id,
          cardId: node.id,
          startedBy: link.startedBy?.id ?? null,
          linkedAt: link.startedAt ?? link.linkedAt,
          workspace: link.workspace,
        })
      }
    }
  }
  candidates.sort((first, second) => String(first.linkedAt ?? '').localeCompare(String(second.linkedAt ?? ''))
    || String(first.mapId).localeCompare(String(second.mapId))
    || String(first.cardId).localeCompare(String(second.cardId)))
  for (const candidate of candidates) rememberAiConversationOrigin(candidate)
  await persistAiConversationOrigins()
}

async function loadAiDelegations() {
  const storedDelegations = await readStoredArray(aiDelegationsFile)
  let rejectedCount = 0
  let repairedCount = 0
  for (const delegation of storedDelegations) {
    if (!isValidAiDelegationId(delegation?.id)) {
      rejectedCount += 1
      continue
    }
    if (!isValidMapId(delegation?.mapId)
      || typeof delegation?.parentCardId !== 'string'
      || typeof delegation?.targetCardId !== 'string'
      || typeof delegation?.parentConversationId !== 'string'
      || typeof delegation?.targetConversationId !== 'string') {
      rejectedCount += 1
      continue
    }
    const normalized = delegation.state === 'completed' && delegation.parentDispatchState !== 'completed'
      ? { ...delegation, parentDispatchState: 'completed' }
      : delegation
    if (normalized !== delegation) repairedCount += 1
    aiDelegations.set(normalized.id, normalized)
  }
  if (rejectedCount > 0) {
    console.warn(`[AI delegation storage] ${rejectedCount}개 항목을 무시했으며 원본 파일은 덮어쓰지 않았습니다.`)
  }
  if (repairedCount > 0) {
    await persistAiDelegations()
    console.log(`[AI delegation storage] 완료된 ${repairedCount}개 위임의 상위 재개 상태를 보정했습니다.`)
  }
}

async function loadAiWorkspaceHistories() {
  const storedHistories = await readStoredArray(aiWorkspaceHistoriesFile)
  for (const history of storedHistories) {
    if (typeof history?.userId !== 'string' || !Array.isArray(history.workspaces)
      || !users.some((user) => user.id === history.userId)) continue
    const workspaces = normalizeAiWorkspaceHistory(history.workspaces)
    aiWorkspaceHistories.set(history.userId, workspaces)
  }
  await persistAiWorkspaceHistories()
}

async function loadSessions() {
  const now = Date.now()
  const storedSessions = await readStoredArray(sessionsFile)
  for (const session of storedSessions) {
    if (!/^[a-f0-9]{64}$/.test(String(session?.tokenHash ?? ''))) continue
    if (!Number.isFinite(session?.expiresAt) || session.expiresAt <= now) continue
    if (!users.some((user) => user.id === session.userId && user.active !== false)) continue
    sessions.set(session.tokenHash, {
      userId: session.userId,
      expiresAt: session.expiresAt,
      persistent: true,
    })
  }
  await persistSessions()
}

async function loadIntegrationToken() {
  await mkdir(dataDirectory, { recursive: true })
  try {
    const stored = (await readFile(integrationTokenFile, 'utf8')).trim()
    if (stored.length >= 32) return stored
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const token = randomBytes(32).toString('base64url')
  await writeFile(integrationTokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return token
}

async function discoverAionUiBaseUrl() {
  try {
    const record = JSON.parse(await readFile(aionUiDiscoveryFile, 'utf8'))
    const port = Number(record?.port)
    if (record?.schemaVersion !== 1 || record?.host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return null
    }
    return `http://127.0.0.1:${port}`
  } catch (error) {
    if (error?.code !== 'ENOENT' && error instanceof SyntaxError === false) {
      console.warn('[AionUi discovery]', error)
    }
    return null
  }
}

async function aionUiCandidateBaseUrls() {
  const discoveredBaseUrl = await discoverAionUiBaseUrl()
  return [...new Set([
    ...configuredAionUiBaseUrls,
    discoveredBaseUrl,
    activeAionUiBaseUrl,
    ...fallbackAionUiBaseUrls,
  ].filter(Boolean))]
}

async function fetchAionUi(pathname, { timeoutMs = 8_000, method = 'GET', body } = {}) {
  let lastError = null
  const candidates = await aionUiCandidateBaseUrls()
  for (const baseUrl of candidates) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const responseBody = await response.json().catch(() => ({}))
      if (!response.ok || responseBody?.success === false) {
        const requestError = new Error(`AIONUI_REQUEST_FAILED:${response.status}`)
        requestError.status = response.status
        requestError.code = responseBody?.error?.code ?? responseBody?.code ?? null
        throw requestError
      }
      activeAionUiBaseUrl = baseUrl
      return responseBody?.data ?? responseBody
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('AIONUI_REQUEST_FAILED')
}

function fetchAionCoreDispatchCapabilities() {
  if (aionCoreDispatchCapabilitiesRequest) return aionCoreDispatchCapabilitiesRequest
  if (aionCoreDispatchCapabilitiesCache
    && Date.now() - aionCoreDispatchCapabilitiesCachedAt < aionCoreDispatchCapabilitiesCacheMs) {
    return Promise.resolve(aionCoreDispatchCapabilitiesCache)
  }
  const request = fetchAionUi('/api/internal/external-conversation-dispatches/capabilities', {
    timeoutMs: 3_000,
  })
    .then((capabilities) => {
      aionCoreDispatchCapabilitiesCache = capabilities
      aionCoreDispatchCapabilitiesCachedAt = Date.now()
      return capabilities
    })
    .catch((error) => {
      aionCoreDispatchCapabilitiesCache = null
      aionCoreDispatchCapabilitiesCachedAt = 0
      throw error
    })
    .finally(() => {
      aionCoreDispatchCapabilitiesRequest = null
    })
  aionCoreDispatchCapabilitiesRequest = request
  return request
}

async function aionCoreSupportsWorkspaceLease() {
  try {
    const capabilities = await fetchAionCoreDispatchCapabilities()
    return capabilities?.workspaceLeaseVersion >= 2
      && capabilities?.atomicWorkspaceRebind === true
      && capabilities?.releasesRuntimeOnTerminal === true
  } catch {
    return false
  }
}

async function aionCoreSupportsExplicitCompletionAfterInterruption() {
  try {
    const capabilities = await fetchAionCoreDispatchCapabilities()
    return capabilities?.schemaVersion >= 3
      && capabilities?.explicitCompletionAfterInterruption === true
  } catch {
    return false
  }
}

async function protectAionUiConversationTitle(conversationId, title) {
  const protectedConversation = await fetchAionUi(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: { name: title, name_source: 'user' },
  })
  if (String(protectedConversation?.id ?? '') !== conversationId
    || String(protectedConversation?.name ?? '') !== title
    || protectedConversation?.name_source !== 'user') {
    throw new Error('AIONUI_CONVERSATION_TITLE_NOT_PROTECTED')
  }
}

function delegationSourceForRequest(scope, mapId) {
  if (!scope.conversationId) {
    return scope.mapId === mapId && scope.cardId
      ? { mapId, cardId: scope.cardId, conversationId: null, startedBy: null, source: 'legacy-mcp-process' }
      : null
  }
  const origin = aiConversationOrigins.get(scope.conversationId)
  if (!origin || origin.mapId !== mapId) return null
  return { ...origin, source: 'conversation-origin' }
}

async function resolveOrRememberDelegationSource(scope, mapId, map) {
  const existing = delegationSourceForRequest(scope, mapId)
  if (existing || !scope.conversationId || scope.mapId !== mapId || !scope.cardId
    || !map.nodes.some((node) => node.id === scope.cardId)) return existing
  const origin = rememberAiConversationOrigin({
    conversationId: scope.conversationId,
    mapId,
    cardId: scope.cardId,
    startedBy: scope.editorId,
    linkedAt: new Date().toISOString(),
  })
  if (!origin) return null
  await persistAiConversationOrigins()
  return { ...origin, source: 'conversation-origin' }
}

function delegationParentAttribution(request, source, parentCard, fallbackUser) {
  const scope = integrationRequestScope(request)
  const token = String(request.headers['x-mnp-ai-attribution'] ?? '').trim()
  const tokenAttribution = token ? aiAttributions.get(sessionTokenKey(token)) : null
  const currentAttribution = aiConversationAttributions.get(conversationAttributionKey(source.mapId, source.cardId))
  const transientAttribution = [...aiAttributions.values()].find((candidate) =>
    candidate.conversationId === source.conversationId
    && candidate.mapId === source.mapId
    && candidate.cardId === source.cardId)
  const matchingAttribution = [tokenAttribution, transientAttribution, currentAttribution]
    .find((candidate) => candidate
      && candidate.mapId === source.mapId
      && candidate.cardId === source.cardId
      && (!source.conversationId || candidate.conversationId === source.conversationId)
      && (!scope.editorId || candidate.startedBy === scope.editorId))
  const conversationLink = source.conversationId
    ? aiConversationLinksFromData(parentCard.data).find((link) => link.conversationId === source.conversationId)
    : null
  const conversationId = source.conversationId ?? matchingAttribution?.conversationId
  if (!conversationId) return null
  return {
    ...(matchingAttribution ?? {}),
    mapId: source.mapId,
    cardId: source.cardId,
    conversationId,
    startedBy: matchingAttribution?.startedBy
      ?? source.startedBy
      ?? conversationLink?.startedBy?.id
      ?? fallbackUser.id,
    selection: matchingAttribution?.selection ?? conversationLink ?? null,
    workspace: matchingAttribution?.selection?.workspace
      ?? matchingAttribution?.workspace
      ?? conversationLink?.workspace
      ?? source.workspace
      ?? null,
  }
}

function isHierarchyDescendant(map, parentCardId, targetCardId) {
  const childrenByParent = new Map()
  for (const edge of map.edges.filter((edge) => edge.data?.relation !== 'knowledge')) {
    const children = childrenByParent.get(edge.source) ?? []
    children.push(edge.target)
    childrenByParent.set(edge.source, children)
  }
  const pending = [...(childrenByParent.get(parentCardId) ?? [])]
  const visited = new Set()
  while (pending.length > 0) {
    const cardId = pending.shift()
    if (!cardId || visited.has(cardId)) continue
    if (cardId === targetCardId) return true
    visited.add(cardId)
    pending.push(...(childrenByParent.get(cardId) ?? []))
  }
  return false
}

async function delegationCreateSelection(targetCard, requestedSelection, parentAttribution) {
  const linkedConversations = aiConversationLinksFromData(targetCard.data)
  const latestLink = linkedConversations.at(-1)
  const selection = mergeAiDelegationSelections(
    requestedSelection,
    latestLink,
    parentAttribution?.selection,
    parentAttribution,
  )
  if (!selection) throw new AionUiExternalLaunchPayloadError('새 AI 대화에 사용할 AI 종류와 모델을 확인할 수 없습니다.')

  const [agents, providers, rawMcpServers] = await Promise.all([
    fetchAionUi('/api/agents/management'),
    fetchAionUi('/api/providers'),
    fetchAionUi('/api/mcp/servers'),
  ])
  const normalizedAgents = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.enabled !== false && agent?.installed === true)
    .map((agent) => normalizeAionUiAgent(agent, Array.isArray(providers) ? providers.filter((item) => item?.enabled !== false) : []))
  const resolvedAgent = normalizedAgents.find((agent) => agent.id === selection.agent.id)
  const resolvedModel = resolvedAgent?.models.find((model) => model.id === selection.model.id)
  if (!resolvedAgent || !resolvedModel) {
    throw new AionUiExternalLaunchPayloadError('새 AI 대화에 사용할 AI 종류 또는 모델을 AionUi에서 확인할 수 없습니다.')
  }
  selection.agent = { id: resolvedAgent.id, label: resolvedAgent.name }
  selection.model = { id: resolvedModel.id, label: resolvedModel.label }
  selection.providerId = resolvedModel.providerId ?? selection.providerId

  const mcpServers = normalizeAionUiMcpServers(rawMcpServers)
  const requiredMcpIds = mcpServers.filter((server) => server.required).map((server) => server.id)
  selection.mcpIds = [...new Set([...selection.mcpIds, ...requiredMcpIds])]
  return selection
}

function issueDelegatedAttribution({ mapId, cardId, conversationId, selection, startedBy }) {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const attribution = {
    authorName: `${selection.agent.label}(${selection.model.label})`,
    agentId: selection.agent.id,
    agentName: selection.agent.label,
    modelId: selection.model.id,
    modelName: selection.model.label,
    providerId: selection.providerId,
    mapId,
    cardId,
    startedBy,
    selection: {
      agent: selection.agent,
      model: selection.model,
      providerId: selection.providerId,
      ...(selection.mode ? { mode: selection.mode } : {}),
      ...(selection.thoughtLevel ? { thoughtLevel: selection.thoughtLevel } : {}),
      skills: selection.enabledSkillIds.map((id) => ({ id, label: id })),
      mcpServers: selection.mcpIds.map((id) => ({ id, label: id })),
      workspace: selection.workspace,
    },
    createdAt: now,
    expiresAt: now + aiAttributionDurationMs,
    ...(conversationId ? { conversationId } : {}),
  }
  aiAttributions.set(sessionTokenKey(token), attribution)
  return { token, attribution }
}

function buildDelegatedInstruction({ mapId, cardId, editorId, attributionToken, instruction, workspaceLease }) {
  const workspaceInstruction = buildWorkspaceInstruction(workspaceLease)
  return `# MindNProgress 하위 카드 위임 작업 요청

가장 먼저 MindNProgress MCP 도구 \`mindnprogress_get_context\`를 아래 값으로 한 번 성공적으로 호출하세요. 사용자 중지, 취소, 시간 초과 또는 연결 종료로 응답을 받지 못한 시도는 호출 횟수에 포함하지 말고, 같은 대화를 이어갈 때 다시 호출하세요. 성공 응답을 받은 뒤에는 같은 대화에서 반복 호출하지 마세요. 이 요청은 상위 카드의 AI가 현재 하위 카드에 실행을 위임한 것이므로, 일반적인 다음 작업 제안에 그치지 말고 아래 "상위 AI 지시"를 실제로 수행하세요. \`editorId\`와 \`attributionToken\`은 이후 MindNProgress MCP 작업이 끝날 때까지 유지하세요.

- mapId: \`${mapId}\`
- cardId: \`${cardId}\`
- editorId: \`${editorId}\`
- attributionToken: \`${attributionToken}\`

MCP 조회 결과의 \`guide\`, \`selection.taskLinks.startupInspection\`, \`selection.aiWorkCoordination\`과 \`nextStep\`을 확인하고 따르세요. 관련 카드를 수정하기 전에는 AI 작업 상태를 확인하고, 실행 결과를 카드 댓글과 공유 지식에 알맞게 기록하세요.

이 위임 실행이 사용자의 중지로 끊긴 뒤 같은 대화에서 직접 이어진 경우, 단순 질의 응답이나 중간 보고는 위임 완료가 아닙니다. 실제 위임 작업과 카드 기록, 필요한 작업공간 체크포인트까지 모두 끝낸 마지막 턴에서만 최종 답변 직전에 \`mindnprogress_complete_ai_delegation\`을 호출하세요. 중단 없이 진행된 최초 실행에는 이 완료 신호가 필요하지 않습니다.

MCP 도구를 사용할 수 없거나 문서 또는 카드를 찾지 못하면 임의로 추측하지 말고 확인 가능한 범위만 수행한 뒤 제약을 명확히 남기세요.

${workspaceInstruction ? `${workspaceInstruction}\n` : ''}

# 상위 AI 지시

${instruction.trim()}`
}

function delegationRecoveryInstruction(delegation, instruction) {
  return `# 재시작 후 위임 복구

AionCore 또는 MindNProgress 재시작으로 이전 실행의 메모리 상태가 끊겼습니다. 원래 지시를 처음부터 반복하지 말고, 현재 카드와 할당된 작업공간의 실제 상태를 먼저 확인한 뒤 미완료 부분만 이어서 수행하세요.

- 위임 ID: ${delegation.id}
- 대상 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- 대상 대화: ${delegation.targetConversationId}
- 작업공간: ${delegation.workspaceLease?.projectRoot ?? '기존 대화 작업공간'}

먼저 \`.ai-session.json\`, 현재 브랜치, Git 변경과 최근 대화·카드 결과를 서로 대조하세요. 이미 완료된 변경이나 외부 처리는 중복 실행하지 말고 검증과 결과 보고만 하세요. 다른 작업공간으로 이동하거나 새 lease를 만들지 마세요.

# 복구 후 수행 지시

${instruction.trim()}`
}

function delegationPublicView(delegation) {
  const publicDelegation = { ...delegation }
  delete publicDelegation.instructionHash
  delete publicDelegation.recoveryInstructionHash
  delete publicDelegation.requestSignature
  delete publicDelegation.pendingInstruction
  delete publicDelegation.pendingSelection
  delete publicDelegation.pendingWorkspaceHint
  delete publicDelegation.childResultSnapshot
  return publicDelegation
}

async function resolveAiDelegationWorkspacePool({ selection, targetCard, parentAttribution, requested }) {
  const candidates = [
    selection?.workspace,
    requested?.workspace,
    ...aiConversationLinksFromData(targetCard?.data).map((link) => link.workspace),
    parentAttribution?.selection?.workspace,
    parentAttribution?.workspace,
  ].map((candidate) => String(candidate ?? '').trim()).filter(Boolean)
  const directHint = candidates.find((candidate) => workspacePoolManager.poolForWorkspace(candidate)) ?? null
  if (directHint) return { known: true, workspaceHint: directHint, expectsWorkspacePool: true }

  const parentConversationId = String(parentAttribution?.conversationId ?? '').trim()
  if (validAiConversationId(parentConversationId)) {
    try {
      const conversation = await fetchAiConversationRuntime(parentConversationId)
      const liveWorkspace = aiConversationLinkFromAionUiConversation(conversation)?.workspace ?? null
      if (liveWorkspace) {
        const pool = workspacePoolManager.poolForWorkspace(liveWorkspace)
        rememberAiConversationOrigin({
          ...(aiConversationOrigins.get(parentConversationId) ?? {}),
          conversationId: parentConversationId,
          mapId: parentAttribution.mapId,
          cardId: parentAttribution.cardId,
          startedBy: parentAttribution.startedBy,
          linkedAt: aiConversationOrigins.get(parentConversationId)?.linkedAt ?? new Date().toISOString(),
          workspace: liveWorkspace,
          workspacePoolId: pool?.poolId ?? null,
        })
        await persistAiConversationOrigins()
        if (pool) return { known: true, workspaceHint: liveWorkspace, expectsWorkspacePool: true }
        return { known: true, workspaceHint: null, expectsWorkspacePool: false }
      }
    } catch {
      // 명시적으로 저장된 workspace 후보가 있으면 해당 경로를 기준으로 비-pool 여부를 판단합니다.
    }
  }

  if (candidates.length > 0 || workspacePoolManager.publicSnapshot().available !== true) {
    return { known: true, workspaceHint: null, expectsWorkspacePool: false }
  }
  return { known: false, workspaceHint: null, expectsWorkspacePool: false }
}

function aiDelegationDispatchError(message, status = 503, code = 'AI_DELEGATION_DISPATCH_FAILED') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function aiDelegationWorkspaceLeaseError(message, expected, actual) {
  const error = aiDelegationDispatchError(message, 409, 'AI_WORKSPACE_LEASE_MISMATCH')
  error.details = {
    expectedLeaseId: expected?.leaseId ?? null,
    expectedWorkspaceId: expected?.workspaceId ?? null,
    actualLeaseId: actual?.leaseId ?? null,
    actualWorkspaceId: actual?.workspaceId ?? null,
  }
  return error
}

async function updateAiDelegation(id, updates) {
  const current = aiDelegations.get(id)
  if (!current) return null
  const changed = Object.entries(updates).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value))
  if (!changed) return current
  const next = { ...current, ...updates, updatedAt: new Date().toISOString() }
  aiDelegations.set(id, next)
  await persistAiDelegations()
  broadcastEvent({ type: 'ai-delegation-changed', delegation: delegationPublicView(next) })
  return next
}

async function restoreAiDelegationResumeReservation(delegation, error) {
  if (!delegation || aiDelegations.get(delegation.id)?.state !== 'resuming') return
  await updateAiDelegation(delegation.id, {
    state: 'waiting-child-resume',
    resumingByDelegationId: null,
    resumeError: error?.message ?? String(error ?? 'AI 위임 재개를 완료하지 못했습니다.'),
  })
}

async function dispatchPreparedAiDelegation({
  queuedDelegation = null,
  id,
  requestSignature,
  map,
  parentCard,
  targetCard,
  parentAttribution,
  targetConversationId: requestedConversationId,
  strategy,
  decisionReason,
  sourceRevision,
  instruction,
  selection,
  workspaceLease,
  resumedDelegation,
  user,
  expectsWorkspacePool = false,
}) {
  if (!await aionCoreSupportsExplicitCompletionAfterInterruption()) {
    throw aiDelegationDispatchError(
      '현재 AionCore가 중단 후 명시적 완료 신호를 지원하지 않습니다. AionCore를 최신 빌드로 재기동해 주세요.',
      503,
      'AIONCORE_EXPLICIT_COMPLETION_UNAVAILABLE',
    )
  }
  if (expectsWorkspacePool && !workspaceLease) {
    throw aiDelegationDispatchError(
      '등록된 AI 작업공간 풀의 lease 없이 작업을 시작할 수 없습니다.',
      503,
      'AI_WORKSPACE_LEASE_REQUIRED',
    )
  }

  let targetConversationId = requestedConversationId
  let reservedDelegation = resumedDelegation
  if (reservedDelegation && aiDelegations.get(reservedDelegation.id)?.state !== 'resuming') {
    reservedDelegation = await updateAiDelegation(reservedDelegation.id, {
      state: 'resuming',
      resumingByDelegationId: id,
      resumeRequestedAt: new Date().toISOString(),
    })
  }

  const { token: attributionToken, attribution } = issueDelegatedAttribution({
    mapId: map.id,
    cardId: targetCard.id,
    conversationId: strategy === 'resume' ? targetConversationId : null,
    selection,
    startedBy: parentAttribution.startedBy ?? user.id,
  })
  await persistAiAttributions()
  const delegatedInstruction = buildDelegatedInstruction({
    mapId: map.id,
    cardId: targetCard.id,
    editorId: parentAttribution.startedBy ?? user.id,
    attributionToken,
    instruction,
    workspaceLease,
  })
  const delegatedConversationTitle = strategy === 'new'
    ? formatAiConversationTitle(map.title, targetCard.data?.label ?? targetCard.id)
    : null

  let dispatch
  try {
    dispatch = await fetchAionUi('/api/internal/external-conversation-dispatches', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        operationId: id,
        actorConversationId: parentAttribution.conversationId,
        strategy,
        explicitCompletionAfterInterruption: true,
        ...(workspaceLease ? { workspaceLease } : {}),
        ...(strategy === 'resume' ? { targetConversationId } : {
          create: {
            agentId: selection.agent.id,
            title: delegatedConversationTitle,
            modelId: selection.model.id,
            mode: selection.mode?.id ?? null,
            thoughtLevel: selection.thoughtLevel?.id ?? null,
            enabledSkillIds: selection.enabledSkillIds,
            disabledBuiltinSkillIds: selection.disabledBuiltinSkillIds,
            mcpIds: selection.mcpIds,
            workspace: selection.workspace,
          },
        }),
        instruction: delegatedInstruction,
      },
    })
  } catch (error) {
    for (let attempt = 0; attempt < 10 && !dispatch; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        dispatch = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(id)}`)
      } catch {
        // The POST may have reached AionCore even if its response was lost.
      }
    }
    if (!dispatch) {
      aiAttributions.delete(sessionTokenKey(attributionToken))
      const definitelyRejected = Number.isInteger(error?.status)
        && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429
      await restoreAiDelegationResumeReservation(reservedDelegation, error)
      await Promise.all([
        persistAiAttributions(),
        workspaceLease && !reservedDelegation
          ? (definitelyRejected
              ? workspacePoolManager.cancel(workspaceLease.leaseId, 'AionCore가 위임 요청을 실행 전에 거부했습니다.')
              : workspacePoolManager.quarantine(workspaceLease.leaseId, 'AionUi 위임 요청의 실행 여부를 확인하지 못했습니다.'))
          : Promise.resolve(),
      ])
      throw aiDelegationDispatchError(
        error?.status === 409
          ? '대상 AI 대화가 이미 작업 중이거나 같은 위임 요청이 준비 중입니다.'
          : 'AionUi에 AI 작업을 위임하지 못했습니다.',
        error?.status === 409 ? 409 : 503,
      )
    }
  }

  if (!aiDelegationWorkspaceLeaseMatches(workspaceLease, dispatch?.workspaceLease ?? null)) {
    aiAttributions.delete(sessionTokenKey(attributionToken))
    await restoreAiDelegationResumeReservation(reservedDelegation, 'AionCore의 작업공간 lease가 요청과 일치하지 않습니다.')
    await Promise.all([
      persistAiAttributions(),
      workspaceLease && !reservedDelegation
        ? workspacePoolManager.quarantine(
            workspaceLease.leaseId,
            'AionCore가 보고한 작업공간 lease와 MindNProgress 요청이 일치하지 않습니다.',
          )
        : Promise.resolve(),
    ])
    throw aiDelegationWorkspaceLeaseError(
      workspaceLease
        ? 'AionCore가 보고한 작업공간 lease가 MindNProgress 요청과 일치하지 않습니다.'
        : '동일한 위임 ID가 작업공간 lease를 사용하는 다른 실행에 연결되어 있습니다.',
      workspaceLease,
      dispatch?.workspaceLease ?? null,
    )
  }

  targetConversationId = String(dispatch.conversationId ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(targetConversationId)) {
    await restoreAiDelegationResumeReservation(reservedDelegation, 'AionUi가 유효한 위임 대화 ID를 반환하지 않았습니다.')
    if (workspaceLease && !reservedDelegation) {
      await workspacePoolManager.quarantine(workspaceLease.leaseId, 'AionUi가 유효한 위임 대화 ID를 반환하지 않았습니다.')
    }
    throw aiDelegationDispatchError('AionUi가 위임 대화 ID를 반환하지 않았습니다.')
  }
  if (workspaceLease) {
    try {
      workspaceLease = await workspacePoolManager.bindConversation(workspaceLease.leaseId, targetConversationId)
        ?? workspaceLease
    } catch (error) {
      await workspacePoolManager.quarantine(
        workspaceLease.leaseId,
        `AI 작업공간과 대화 연결을 확정하지 못했습니다: ${error?.message ?? String(error)}`,
      )
      const bindingError = aiDelegationDispatchError(
        'AI 작업공간과 대상 대화의 연결을 확정하지 못했습니다.',
        409,
        'AI_WORKSPACE_CONVERSATION_CONFLICT',
      )
      bindingError.details = { leaseId: workspaceLease.leaseId, conversationId: targetConversationId }
      throw bindingError
    }
  }
  if (delegatedConversationTitle) {
    try {
      await protectAionUiConversationTitle(targetConversationId, delegatedConversationTitle)
    } catch (error) {
      console.warn('[AI delegation conversation title protection]', JSON.stringify({
        mapId: map.id,
        cardId: targetCard.id,
        conversationId: targetConversationId,
        error: error?.message ?? String(error),
      }))
    }
  }

  attribution.conversationId = targetConversationId
  rememberAiConversationOrigin({
    conversationId: targetConversationId,
    mapId: map.id,
    cardId: targetCard.id,
    startedBy: attribution.startedBy,
    linkedAt: new Date().toISOString(),
    workspace: selection.workspace,
    workspacePoolId: workspaceLease?.poolId ?? null,
  })
  aiConversationAttributions.set(conversationAttributionKey(map.id, targetCard.id), {
    mapId: map.id,
    cardId: targetCard.id,
    conversationId: targetConversationId,
    authorName: attribution.authorName,
    agentId: attribution.agentId,
    agentName: attribution.agentName,
    modelId: attribution.modelId,
    modelName: attribution.modelName,
    providerId: attribution.providerId,
    startedBy: attribution.startedBy,
    linkedAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
  })
  await Promise.all([persistAiAttributions(), persistAiConversationAttributions(), persistAiConversationOrigins()])

  let updatedMap = map
  let linkError = null
  if (strategy === 'new') {
    const latestMap = await readMap(map.id)
    const latestTargetCard = latestMap?.nodes.find((node) => node.id === targetCard.id)
    if (!latestMap || latestMap.trashedAt || !latestTargetCard) {
      linkError = '새 대화는 생성됐지만 대상 카드가 변경되어 연결하지 못했습니다.'
    } else {
      const conversationLink = normalizeAiConversationLink({
        conversationId: targetConversationId,
        agent: selection.agent,
        model: selection.model,
        providerId: selection.providerId,
        mode: selection.mode,
        thoughtLevel: selection.thoughtLevel,
        skills: selection.enabledSkillIds.map((skillId) => ({ id: skillId, label: skillId })),
        mcpServers: selection.mcpIds.map((mcpId) => ({ id: mcpId, label: mcpId })),
        workspace: selection.workspace,
        requestPreview: instruction,
        startedBy: { id: attribution.startedBy, label: users.find((candidate) => candidate.id === attribution.startedBy)?.name ?? attribution.startedBy },
        startedAt: new Date().toISOString(),
        linkedAt: new Date().toISOString(),
      })
      try {
        updatedMap = await saveMap(map.id, {
          nodes: latestMap.nodes.map((node) => node.id === targetCard.id ? {
            ...node,
            data: {
              ...node.data,
              aiConversationId: targetConversationId,
              aiConversations: appendAiConversationLink(node.data, conversationLink),
            },
          } : node),
          edges: latestMap.edges,
        }, user, latestMap.title, latestMap.color, 'content')
        broadcastEvent({
          type: 'ai-conversation-linked', mapId: map.id, nodeId: targetCard.id,
          conversationId: targetConversationId, conversation: conversationLink,
          sourceClientId: null, updatedAt: updatedMap.updatedAt, updatedBy: publicUser(user),
        })
      } catch (error) {
        linkError = '새 대화는 생성됐지만 대상 카드의 대화 목록에 연결하지 못했습니다.'
        console.warn('[AI delegation conversation link]', error)
      }
    }
  }

  const now = new Date().toISOString()
  const delegation = {
    ...(queuedDelegation ?? {}),
    id,
    requestSignature,
    mapId: map.id,
    parentCardId: parentCard.id,
    parentCardLabel: parentCard.data?.label ?? parentCard.id,
    targetCardId: targetCard.id,
    targetCardLabel: targetCard.data?.label ?? targetCard.id,
    parentConversationId: parentAttribution.conversationId,
    targetConversationId,
    childOperationId: id,
    strategy,
    decisionReason,
    sourceRevision,
    instructionPreview: instruction.replace(/\s+/g, ' ').slice(0, 240),
    instructionHash: createHash('sha256').update(instruction).digest('hex'),
    ...initialAiDelegationRuntime(dispatch, now),
    linkError,
    startedBy: attribution.startedBy,
    workspaceLease,
    ...(reservedDelegation ? { resumesDelegationId: reservedDelegation.id } : {}),
    createdAt: queuedDelegation?.createdAt ?? now,
    updatedAt: now,
    ...(queuedDelegation ? { workspaceWaitCompletedAt: now } : {}),
  }
  delete delegation.pendingInstruction
  delete delegation.pendingSelection
  delete delegation.pendingWorkspaceHint
  delete delegation.workspaceWaitError
  if (reservedDelegation) {
    const superseded = {
      ...reservedDelegation,
      state: 'superseded',
      supersededByDelegationId: id,
      supersededAt: now,
      resumingByDelegationId: null,
      updatedAt: now,
    }
    aiDelegations.set(superseded.id, superseded)
    broadcastEvent({ type: 'ai-delegation-changed', delegation: delegationPublicView(superseded) })
  }
  aiDelegations.set(id, delegation)
  await persistAiDelegations()
  broadcastEvent({ type: 'ai-delegation-changed', delegation: delegationPublicView(delegation) })
  return { delegation, updatedMap }
}

async function reconcileAiDelegationWorkspaceLeases() {
  const legacyIntegrationDirtyFailures = [...aiDelegations.values()].filter((delegation) =>
    delegation.state === 'failed'
    && delegation.childStatus === 'rejected'
    && !delegation.workspaceLease?.leaseId
    && delegation.childError === integrationWorktreeDirtyMessage
    && delegation.workspaceWaitError === integrationWorktreeDirtyMessage
    && typeof delegation.pendingInstruction === 'string'
    && delegation.pendingInstruction.trim()
    && delegation.pendingSelection
    && typeof delegation.pendingSelection === 'object')
  if (legacyIntegrationDirtyFailures.length > 0) {
    try {
      const integrationChanges = await workspacePoolManager.integrationTrackedChanges()
      const snapshot = workspacePoolManager.publicSnapshot()
      for (const delegation of legacyIntegrationDirtyFailures) {
        const now = new Date().toISOString()
        await updateAiDelegation(delegation.id, {
          state: integrationChanges.dirty ? 'waiting-integration-clean' : 'waiting-workspace',
          childStatus: null,
          childError: null,
          workspaceWaitError: integrationChanges.dirty ? integrationWorktreeDirtyMessage : null,
          integrationCleanTrackedChanges: integrationChanges.paths,
          integrationCleanWaitStartedAt: delegation.integrationCleanWaitStartedAt ?? now,
          legacyIntegrationCleanRecoveredAt: now,
          resource: {
            kind: integrationChanges.dirty ? 'integration_workspace' : 'workspace_pool',
            key: integrationChanges.dirty ? snapshot.integrationWorkspaceId : snapshot.poolId,
            projectRoot: delegation.pendingWorkspaceHint,
          },
          completedAt: null,
        })
      }
    } catch (error) {
      console.warn('[AI delegation integration clean startup recovery]', error)
    }
  }

  for (const delegation of aiDelegations.values()) {
    if (delegation.state !== 'resuming') continue
    await updateAiDelegation(delegation.id, {
      state: 'waiting-child-resume',
      resumingByDelegationId: null,
      resumeError: 'MindNProgress 재시작으로 완료되지 않은 재개 예약을 해제했습니다.',
    })
  }

  for (const delegation of aiDelegations.values()) {
    if (delegation.state !== 'failed'
      || delegation.childStatus !== 'completed'
      || delegation.workspaceResult?.status !== 'quarantined'
      || !delegation.workspaceLease?.leaseId) continue
    try {
      const workspaceResult = await workspacePoolManager.recoverCheckpointedFinalizationFailure(
        delegation.workspaceLease.leaseId,
      ) ?? await workspacePoolManager.recoverLegacyDirtyIntegration(delegation.workspaceLease.leaseId)
      if (workspaceResult?.status !== 'waiting-integration') continue
      await updateAiDelegation(delegation.id, {
        state: 'waiting-integration',
        childError: workspaceResult.childError ?? null,
        workspaceResult,
        workspaceError: null,
        parentDispatchState: null,
        parentTurnId: null,
        parentError: null,
        parentResource: null,
        completedAt: null,
        legacyIntegrationRecoveredAt: new Date().toISOString(),
      })
      console.log(`[AI workspace pool] 체크포인트가 보존된 격리 작업을 통합 대기로 복구했습니다: ${delegation.id}`)
    } catch (error) {
      console.warn('[AI workspace pool checkpointed integration recovery]', JSON.stringify({
        delegationId: delegation.id,
        leaseId: delegation.workspaceLease.leaseId,
        error: error?.message ?? String(error),
      }))
    }
  }

  const delegations = [...aiDelegations.values()]
  if (await aionCoreSupportsWorkspaceLease()) {
    for (const delegation of delegations) {
      const suspiciousTerminalWorkspace = delegation.state === 'completed'
        && delegation.childStatus === 'completed'
        && ['failed-clean', 'cancelled', 'quarantined'].includes(delegation.workspaceResult?.status)
      if ((!shouldReconcileAiDelegationChildWorkspace(delegation) && !suspiciousTerminalWorkspace)
        || !delegation.childOperationId
        || !delegation.targetConversationId) continue
      try {
        const status = await fetchAionUi(
          `/api/internal/external-conversation-dispatches/${encodeURIComponent(delegation.childOperationId)}`,
          { timeoutMs: 3_000 },
        )
        await reconcileAiDelegationWorkspaceLeaseStatus(delegation, status, 'startup')
      } catch (error) {
        console.warn('[AI delegation workspace conversation recovery]', JSON.stringify({
          delegationId: delegation.id,
          leaseId: delegation.workspaceLease?.leaseId ?? null,
          error: error?.message ?? String(error),
        }))
      }
    }
  }

  const visited = new Set()
  for (const delegation of delegations) {
    const key = `${delegation.mapId}\u0000${delegation.targetCardId}\u0000${delegation.targetConversationId}`
    if (visited.has(key)) continue
    visited.add(key)
    const active = activeAiDelegationsForConversation(aiDelegations.values(), {
      mapId: delegation.mapId,
      targetCardId: delegation.targetCardId,
      targetConversationId: delegation.targetConversationId,
    })
    if (active.length < 2) continue
    const canonical = active[0]
    if (canonical.state === 'waiting-child-resume') continue
    for (const supersededCandidate of active.slice(1)) {
      if (supersededCandidate.state !== 'waiting-child-resume') continue
      const oldLeaseId = supersededCandidate.workspaceLease?.leaseId
      const canonicalLeaseId = canonical.workspaceLease?.leaseId
      let workspaceResult = supersededCandidate.workspaceResult ?? null
      if (oldLeaseId && oldLeaseId !== canonicalLeaseId) {
        workspaceResult = await workspacePoolManager.cancel(
          oldLeaseId,
          `새 위임 ${canonical.id}이 같은 카드와 대화의 작업을 이어받았습니다.`,
        )
      }
      await updateAiDelegation(supersededCandidate.id, {
        state: 'superseded',
        supersededByDelegationId: canonical.id,
        supersededAt: new Date().toISOString(),
        workspaceResult,
      })
    }
  }
}

async function reconcileAiDelegationWorkspaceLeaseStatus(delegation, status, source) {
  const actualLease = status?.workspaceLease ?? null
  const expectedLease = delegation.workspaceLease ?? null
  if (!actualLease?.leaseId) {
    if (!expectedLease?.leaseId) return true
    await updateAiDelegation(delegation.id, {
      state: 'recovery-required',
      childStatus: 'interrupted-by-workspace-conflict',
      childError: 'AionCore가 위임 실행에 실제 사용한 작업공간 lease를 반환하지 않아 안전하게 완료 여부를 판단할 수 없습니다.',
      recoveryRequiredAt: delegation.recoveryRequiredAt ?? new Date().toISOString(),
      workspaceLeaseReconciledAt: new Date().toISOString(),
      workspaceLeaseReconciliationSource: source,
      resource: null,
    })
    return false
  }

  if (aiDelegationWorkspaceLeaseMatches(expectedLease, actualLease)) {
    try {
      const reboundLease = await workspacePoolManager.bindConversation(
        actualLease.leaseId,
        delegation.targetConversationId,
      )
      if (!aiDelegationWorkspaceLeaseMatches(actualLease, reboundLease)) {
        throw new Error('작업공간 lease가 더 이상 활성 상태가 아니거나 실제 실행 정보와 일치하지 않습니다.')
      }
      return true
    } catch (error) {
      await updateAiDelegation(delegation.id, {
        state: 'recovery-required',
        childStatus: 'interrupted-by-workspace-conflict',
        childError: `AI 대화와 작업공간 lease 연결을 복구하지 못했습니다: ${error?.message ?? String(error)}`,
        recoveryRequiredAt: delegation.recoveryRequiredAt ?? new Date().toISOString(),
        workspaceLeaseReconciledAt: new Date().toISOString(),
        workspaceLeaseReconciliationSource: source,
        resource: null,
      })
      return false
    }
  }

  let recoveredLease = actualLease
  let recoveryError = null
  try {
    recoveredLease = await workspacePoolManager.reuseLease(actualLease.leaseId, {
      mapId: delegation.mapId,
      cardId: delegation.targetCardId,
      conversationId: delegation.targetConversationId,
    })
    if (!aiDelegationWorkspaceLeaseMatches(actualLease, recoveredLease)) {
      throw new Error('AionCore 응답과 로컬 작업공간 lease 정보가 일치하지 않습니다.')
    }
  } catch (error) {
    recoveryError = error?.message ?? String(error)
    await workspacePoolManager.quarantine(
      actualLease.leaseId,
      `AionCore의 실제 작업공간 lease를 안전하게 복구하지 못했습니다: ${recoveryError}`,
    )
  }

  const oldLeaseId = expectedLease?.leaseId
  let previousWorkspaceResult = null
  if (!recoveryError && oldLeaseId && oldLeaseId !== actualLease.leaseId) {
    previousWorkspaceResult = await workspacePoolManager.cancel(
      oldLeaseId,
      `AionCore가 보고한 실제 lease ${actualLease.leaseId}로 위임 정합성을 복구했습니다.`,
    )
  }

  await updateAiDelegation(delegation.id, {
    state: 'recovery-required',
    childStatus: 'interrupted-by-workspace-mismatch',
    childError: recoveryError
      ? `AionCore의 실제 작업공간 lease를 확인했지만 안전하게 복구하지 못했습니다: ${recoveryError}`
      : 'MindNProgress에 저장된 작업공간과 AionCore가 실제 사용한 작업공간이 달라 실제 lease로 복구했습니다. 작업 상태를 확인한 뒤 명시적으로 재개하세요.',
    workspaceLease: recoveredLease,
    workspaceResult: previousWorkspaceResult,
    workspaceError: recoveryError,
    recoveryRequiredAt: delegation.recoveryRequiredAt ?? new Date().toISOString(),
    workspaceLeaseReconciledAt: new Date().toISOString(),
    workspaceLeaseReconciliationSource: source,
    resource: null,
  })
  return false
}

async function latestAssistantResult(conversationId) {
  try {
    const messagePage = await fetchAionUi(`/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=100&content_mode=full`, { timeoutMs: 30_000 })
    const messages = Array.isArray(messagePage?.items) ? messagePage.items : Array.isArray(messagePage) ? messagePage : []
    const message = [...messages].reverse().find((candidate) => candidate?.position === 'left'
      && (candidate.type === 'text' || candidate.type === 'tips')
      && readAionUiMessageContent(candidate).trim())
    return readAionUiMessageContent(message).trim().slice(0, 12_000)
  } catch {
    return ''
  }
}

async function captureAiDelegationChildResult(delegation) {
  if (delegation?.childResultSnapshot) return delegation
  const lastAttempt = Date.parse(String(delegation?.childResultCaptureAttemptedAt ?? ''))
  if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 10_000) return delegation
  const result = await latestAssistantResult(delegation?.targetConversationId)
  const attemptedAt = new Date().toISOString()
  return updateAiDelegation(delegation.id, result
    ? {
        childResultSnapshot: result,
        childResultHash: createHash('sha256').update(result).digest('hex'),
        childResultCapturedAt: attemptedAt,
        childResultCaptureAttemptedAt: attemptedAt,
      }
    : { childResultCaptureAttemptedAt: attemptedAt })
}

function parentWakeInstruction(delegation, result) {
  const integrationFailure = delegation.integrationStatus && delegation.integrationStatus !== 'completed'
    ? delegation.integrationError ?? delegation.workspaceError ?? delegation.integrationStatus
    : null
  const outcome = integrationFailure
    ? `작업 완료 후 필수 체크포인트 또는 통합 실패 (${integrationFailure})`
    : delegation.workspaceError
      ? `작업 완료 후 통합 실패 (${delegation.workspaceError})`
      : aiDelegationSucceeded(delegation)
        ? '완료'
        : `실패 또는 중단 (${delegation.childError ?? '상세 원인 없음'})`
  const workspaceResult = delegation.workspaceResult
    ? `- 작업공간: ${delegation.workspaceResult.workspaceId ?? delegation.workspaceLease?.workspaceId ?? '미확인'}\n- 체크포인트: ${delegation.workspaceResult.headCommit ?? '변경 없음'}\n- 통합 커밋: ${delegation.workspaceResult.integratedCommit ?? '통합되지 않음'}\n- 작업공간 결과: ${delegation.workspaceResult.status ?? '미확인'}\n`
    : ''
  return `# MindNProgress 하위 AI 작업 결과

상위 카드에서 위임한 하위 카드 작업이 ${outcome} 상태가 되었습니다.

- 위임 ID: ${delegation.id}
- 하위 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- 실행 대화: ${delegation.targetConversationId}
- 선택 방식: ${delegation.strategy === 'resume' ? '기존 대화 이어가기' : '새 대화 시작'}
- 선택 이유: ${delegation.decisionReason}
${workspaceResult}

${result ? `## 하위 AI의 마지막 응답\n\n${result}\n\n` : ''}MindNProgress에서 하위 카드의 최신 설명·공유 지식·댓글·상태를 다시 확인하고, 결과가 상위 업무와 다른 하위 업무에 미치는 영향을 판단해 다음 작업을 이어가세요. 하위 AI의 응답은 참고 자료이므로 실제 카드와 산출물을 기준으로 검증하세요.

다음 작업을 위임하기로 판단했다면 이번 턴의 최종 응답 전에 mindnprogress_delegate_ai_work를 실제로 호출하고 성공 결과를 확인하세요. 성공을 확인하기 전에는 “위임했습니다”라고 쓰지 말고, 실제 호출 없이 “위임하겠습니다” 또는 “이어서 진행하겠습니다”와 같은 미래형 약속으로 턴을 끝내지 마세요. 위임할 수 없다면 실행을 약속하지 말고 차단 원인과 필요한 조치를 현재 응답에 명시하세요.`
}

function aiDelegationRecoveryKey(delegation) {
  return [
    Number(delegation?.recoveryAttempt ?? 0),
    String(delegation?.recoveryRequiredAt ?? ''),
    String(delegation?.state ?? ''),
  ].join(':')
}

function parentRecoveryInstruction(delegation) {
  const error = delegation.integrationError ?? delegation.childError ?? delegation.workspaceError ?? '상세 원인 없음'
  const checkpoint = delegation.workspaceResult?.status === 'checkpoint-required'
    ? `- 체크포인트 회차: ${delegation.workspaceResult.checkpointRound ?? '미확인'}\n`
    : ''
  const result = delegation.childResultSnapshot
  return `# MindNProgress 하위 AI 작업 복구 필요

상위 카드에서 위임한 하위 카드 작업이 완료 보고 전 복구 필요 상태가 되었습니다. 이 알림은 완료 보고가 아니며 기존 위임은 아직 활성 상태입니다.

- 위임 ID: ${delegation.id}
- 하위 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- 실행 대화: ${delegation.targetConversationId}
- 상태: ${delegation.state}
${checkpoint}- 원인: ${error}

${result ? `## 보존된 하위 AI의 마지막 응답\n\n${result}\n\n` : ''}같은 작업을 새로 위임하지 마세요. MindNProgress에서 기존 위임과 하위 카드·작업공간 상태를 확인한 뒤, 안전하게 이어갈 수 있을 때만 mindnprogress_recover_ai_delegation으로 기존 위임을 복구하세요. 자동 판단이 어렵다면 사용자에게 현재 상태와 필요한 확인을 알리세요.`
}

async function ensureAiDelegationNotification(delegation, { kind, message, dedupeKey }) {
  const notificationKey = `${kind}NotificationKey`
  if (delegation?.[notificationKey] === dedupeKey) return delegation
  const recipient = users.find((candidate) => candidate.id === delegation?.startedBy
    && candidate.role === 'editor' && candidate.active !== false)
  const map = await readMap(delegation?.mapId)
  const node = map?.nodes.find((candidate) => candidate.id === delegation?.targetCardId)
  if (!recipient || !map || map.trashedAt || !node) return delegation
  const notification = await createNotification(recipient, {
    type: 'ai-delegation',
    mapId: map.id,
    mapTitle: map.title,
    nodeId: node.id,
    nodeLabel: node.data?.label ?? delegation.targetCardLabel ?? node.id,
    message,
    actor: systemUser,
    dedupeKey,
  })
  return updateAiDelegation(delegation.id, {
    [notificationKey]: dedupeKey,
    [`${kind}NotificationId`]: notification.id,
    [`${kind}NotifiedAt`]: notification.createdAt,
  })
}

async function ensureCheckpointRequiredNotification(delegation, workspaceResult) {
  const round = Number(workspaceResult?.checkpointRound ?? 0)
  return ensureAiDelegationNotification(delegation, {
    kind: 'checkpoint',
    dedupeKey: `ai-delegation-checkpoint:${delegation.id}:${round}`,
    message: `하위 AI 작업은 종료됐지만 명시적 체크포인트가 없어 자동 보완을 요청했습니다. (회차 ${round || '미확인'})`,
  })
}

function integrationCleanWaitKey(delegation) {
  return createHash('sha256').update(JSON.stringify({
    id: delegation?.id,
    startedAt: delegation?.integrationCleanWaitStartedAt,
  })).digest('hex').slice(0, 16)
}

function integrationCleanWaitMessage(delegation) {
  const paths = Array.isArray(delegation?.integrationCleanTrackedChanges)
    ? delegation.integrationCleanTrackedChanges
    : []
  const pathSummary = paths.length > 0
    ? ` 차단 파일: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` 외 ${paths.length - 3}건` : ''}`
    : ''
  return `통합 작업공간의 커밋되지 않은 추적 변경 때문에 하위 AI 전문을 아직 전달하지 않았습니다. 변경이 정리되면 같은 위임을 자동 시작합니다.${pathSummary}`
}

function parentIntegrationCleanWaitInstruction(delegation) {
  const paths = Array.isArray(delegation?.integrationCleanTrackedChanges)
    ? delegation.integrationCleanTrackedChanges
    : []
  const pathList = paths.length > 0
    ? paths.map((item) => `- ${item}`).join('\n')
    : '- 파일 목록을 확인하지 못했습니다.'
  return `# MindNProgress 하위 AI 위임 시작 대기

하위 카드 위임은 접수됐지만 통합 작업공간에 커밋되지 않은 추적 변경이 있어 하위 AI 대화에는 아직 전문을 전달하지 않았습니다.

- 위임 ID: ${delegation.id}
- 하위 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- 대상 대화: ${delegation.targetConversationId}
- 상태: waiting-integration-clean

## 차단 중인 추적 파일

${pathList}

이 상태는 실패나 완료가 아니며 같은 위임이 유지됩니다. 같은 작업을 다시 위임하지 마세요. 사용자가 변경을 커밋하거나 안전하게 정리해 통합 작업공간이 깨끗해지면 MindNProgress가 같은 위임을 자동 시작합니다. 현재 상태가 이미 달라졌을 수 있으므로 필요하면 mindnprogress_list_ai_delegations로 다시 확인하고, 사용자에게는 하위 AI에 전문이 아직 전달되지 않았다는 사실과 필요한 조치만 알리세요.`
}

async function processAiDelegationIntegrationCleanWaitNotice(originalDelegation) {
  let delegation = originalDelegation
  const waitKey = integrationCleanWaitKey(delegation)
  try {
    delegation = await ensureAiDelegationNotification(delegation, {
      kind: 'integrationCleanWait',
      dedupeKey: `ai-delegation-integration-clean:${delegation.id}:${waitKey}`,
      message: integrationCleanWaitMessage(delegation),
    })
  } catch (error) {
    console.warn('[AI delegation integration clean editor notification]', error)
  }

  if (delegation.integrationCleanWakeKey === waitKey
    && delegation.integrationCleanWakeDeliveredAt) return
  if (delegation.integrationCleanWakeKey === waitKey && delegation.integrationCleanWakeOperationId) {
    try {
      const status = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(delegation.integrationCleanWakeOperationId)}`)
      if (['starting', 'waiting_resource', 'running', 'waiting_resume'].includes(status.state)) {
        await updateAiDelegation(delegation.id, {
          integrationCleanWakeState: status.state,
          integrationCleanWakeTurnId: status.turnId ?? delegation.integrationCleanWakeTurnId ?? null,
          integrationCleanWakeError: status.errorMessage ?? null,
        })
        return
      }
      await updateAiDelegation(delegation.id, {
        integrationCleanWakeState: status.state,
        integrationCleanWakeTurnId: status.turnId ?? delegation.integrationCleanWakeTurnId ?? null,
        integrationCleanWakeError: status.errorMessage ?? null,
        integrationCleanWakeDeliveredAt: status.state === 'completed' ? new Date().toISOString() : null,
        integrationCleanWakeFailedAt: status.state === 'completed' ? null : new Date().toISOString(),
      })
    } catch (error) {
      await updateAiDelegation(delegation.id, {
        integrationCleanWakeState: 'unavailable',
        integrationCleanWakeError: error?.message ?? String(error),
        integrationCleanWakeFailedAt: new Date().toISOString(),
      })
    }
    return
  }

  const anotherParentWakeInProgress = [...aiDelegations.values()].some((candidate) =>
    candidate.id !== delegation.id
    && candidate.parentConversationId === delegation.parentConversationId
    && (candidate.state === 'waking-parent'
      || ['starting', 'waiting_resource', 'running', 'waiting_resume'].includes(candidate.recoveryWakeState)
      || ['starting', 'waiting_resource', 'running', 'waiting_resume'].includes(candidate.integrationCleanWakeState)))
  if (anotherParentWakeInProgress) return
  const parent = await fetchAiConversationRuntime(delegation.parentConversationId)
  const runtime = normalizeAiConversationRuntime(delegation.parentConversationId, parent)
  if (runtime.state !== 'idle') return

  const attempt = Number(delegation.integrationCleanWakeAttempt ?? 0) + 1
  const operationId = boundedAionOperationId(delegation.id, `integration-clean-notice-${attempt}`)
  const response = await fetchAionUi('/api/internal/external-conversation-dispatches', {
    method: 'POST',
    body: {
      operationId,
      actorConversationId: delegation.parentConversationId,
      strategy: 'resume',
      targetConversationId: delegation.parentConversationId,
      instruction: parentIntegrationCleanWaitInstruction(delegation),
    },
  })
  await updateAiDelegation(delegation.id, {
    integrationCleanWakeKey: waitKey,
    integrationCleanWakeOperationId: operationId,
    integrationCleanWakeAttempt: attempt,
    integrationCleanWakeState: response.state,
    integrationCleanWakeTurnId: response.turnId ?? null,
    integrationCleanWakeError: null,
    integrationCleanWakeStartedAt: new Date().toISOString(),
    integrationCleanWakeDeliveredAt: null,
    integrationCleanWakeFailedAt: null,
  })
}

async function processAiDelegationRecoveryNotice(originalDelegation) {
  let delegation = originalDelegation
  const recoveryKey = aiDelegationRecoveryKey(delegation)
  try {
    delegation = await ensureAiDelegationNotification(delegation, {
      kind: 'recovery',
      dedupeKey: `ai-delegation-recovery:${delegation.id}:${createHash('sha256').update(recoveryKey).digest('hex').slice(0, 16)}`,
      message: `하위 AI 작업이 완료 보고 전에 복구 필요 상태가 되었습니다. 기존 위임을 확인해 복구해 주세요. (${delegation.integrationError ?? delegation.childError ?? delegation.workspaceError ?? delegation.state})`,
    })
  } catch (error) {
    console.warn('[AI delegation editor recovery notification]', error)
  }

  if (delegation.recoveryWakeKey === recoveryKey
    && (delegation.recoveryWakeDeliveredAt || delegation.recoveryWakeFailedAt)) return
  if (delegation.recoveryWakeKey === recoveryKey && delegation.recoveryWakeOperationId) {
    try {
      const status = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(delegation.recoveryWakeOperationId)}`)
      if (['starting', 'waiting_resource', 'running', 'waiting_resume'].includes(status.state)) {
        await updateAiDelegation(delegation.id, {
          recoveryWakeState: status.state,
          recoveryWakeTurnId: status.turnId ?? delegation.recoveryWakeTurnId ?? null,
          recoveryWakeError: status.errorMessage ?? null,
        })
        return
      }
      await updateAiDelegation(delegation.id, {
        recoveryWakeState: status.state,
        recoveryWakeTurnId: status.turnId ?? delegation.recoveryWakeTurnId ?? null,
        recoveryWakeError: status.errorMessage ?? null,
        recoveryWakeDeliveredAt: status.state === 'completed' ? new Date().toISOString() : null,
        recoveryWakeFailedAt: status.state === 'completed' ? null : new Date().toISOString(),
      })
    } catch (error) {
      await updateAiDelegation(delegation.id, {
        recoveryWakeState: 'unavailable',
        recoveryWakeError: error?.message ?? String(error),
        recoveryWakeFailedAt: new Date().toISOString(),
      })
    }
    return
  }

  delegation = await captureAiDelegationChildResult(delegation)

  const anotherParentWakeInProgress = [...aiDelegations.values()].some((candidate) =>
    candidate.id !== delegation.id
    && candidate.parentConversationId === delegation.parentConversationId
    && (candidate.state === 'waking-parent'
      || ['starting', 'waiting_resource', 'running', 'waiting_resume'].includes(candidate.recoveryWakeState)))
  if (anotherParentWakeInProgress) return
  const parent = await fetchAiConversationRuntime(delegation.parentConversationId)
  const runtime = normalizeAiConversationRuntime(delegation.parentConversationId, parent)
  if (runtime.state !== 'idle') return

  const recoveryWakeAttempt = Number(delegation.recoveryWakeAttempt ?? 0) + 1
  const operationId = boundedAionOperationId(delegation.id, `recovery-notice-${recoveryWakeAttempt}`)
  const response = await fetchAionUi('/api/internal/external-conversation-dispatches', {
    method: 'POST',
    body: {
      operationId,
      actorConversationId: delegation.parentConversationId,
      strategy: 'resume',
      targetConversationId: delegation.parentConversationId,
      instruction: parentRecoveryInstruction(delegation),
    },
  })
  await updateAiDelegation(delegation.id, {
    recoveryWakeKey: recoveryKey,
    recoveryWakeOperationId: operationId,
    recoveryWakeAttempt,
    recoveryWakeState: response.state,
    recoveryWakeTurnId: response.turnId ?? null,
    recoveryWakeError: null,
    recoveryWakeStartedAt: new Date().toISOString(),
    recoveryWakeDeliveredAt: null,
    recoveryWakeFailedAt: null,
  })
}

async function finalizeDelegationWorkspace(delegation, childStatus, childError) {
  if (!delegation.workspaceLease?.leaseId) return { result: null, error: null }
  try {
    const result = await workspacePoolManager.finalize(delegation.workspaceLease.leaseId, {
      childStatus,
      childError,
    })
    return { result, error: null }
  } catch (error) {
    if (error instanceof WorkspacePoolIntegrationError) {
      return { result: error.details ?? null, error: error.message }
    }
    return { result: null, error: error?.message ?? String(error) }
  }
}

async function completeDelegationWorkspaceConflict(delegation, childStatus, childError) {
  if (!delegation.workspaceLease?.leaseId) return { result: null, error: null }
  try {
    const result = await workspacePoolManager.completeConflictResolution(delegation.workspaceLease.leaseId, {
      childStatus,
      childError,
    })
    return { result, error: null }
  } catch (error) {
    if (error instanceof WorkspacePoolIntegrationError) {
      return { result: error.details ?? null, error: error.message }
    }
    return { result: null, error: error?.message ?? String(error) }
  }
}

function integrationDelegationState(state) {
  if (state === 'waiting_resource') return 'integration-waiting-resource'
  if (state === 'waiting_resume') return 'integration-waiting-resume'
  if (state === 'running') return 'integration-running'
  return 'integration-starting'
}

function boundedAionOperationId(base, suffix) {
  const candidate = `${base}-${suffix}`
  if (candidate.length <= 128) return candidate
  const digest = createHash('sha256').update(candidate).digest('hex').slice(0, 16)
  const tail = `-${suffix}-${digest}`
  return `${String(base).slice(0, 128 - tail.length)}${tail}`
}

function workspaceConflictInstruction(delegation, workspaceResult) {
  const files = Array.isArray(workspaceResult?.unmergedFiles) && workspaceResult.unmergedFiles.length > 0
    ? workspaceResult.unmergedFiles.map((file) => `- ${file}`).join('\n')
    : '- Git 상태에서 충돌 파일을 직접 확인하세요.'
  return `# MindNProgress 통합 충돌 해결 요청

앞서 완료한 하위 카드 작업을 최신 main 기준 통합 브랜치에 적용하는 중 충돌이 발생했습니다. 같은 작업 맥락을 유지한 채 할당된 worker에서만 충돌을 해결하고 최종 검증까지 완료하세요.

- 하위 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- workspaceId: ${delegation.workspaceLease.workspaceId}
- jobId: ${delegation.workspaceLease.jobId}
- leaseId: ${delegation.workspaceLease.leaseId}
- projectRoot: ${delegation.workspaceLease.projectRoot}
- 통합 브랜치: ${workspaceResult.integrationBranch}
- 통합 기준 커밋: ${workspaceResult.integrationBaseCommit}
- 충돌 해결 회차: ${workspaceResult.conflictRound}

## 충돌 파일

${files}

현재 진행 중인 cherry-pick의 충돌만 해결하세요. 요구사항과 기존 구현 의도를 함께 대조하고, 해결한 파일을 stage한 뒤 모든 cherry-pick이 끝날 때까지 \`git cherry-pick --continue\`를 수행하세요. 이 통합 과정에 필요한 보완 변경은 허용하지만 다른 등록 작업공간이나 main을 직접 수정하지 말고, 브랜치를 바꾸거나 lease를 해제하지 마세요. 관련 검증을 실행한 뒤 해결 내용과 검증 결과를 최종 응답으로 보고하세요. 해결할 수 없다면 임의 선택하지 말고 충돌한 의도와 필요한 판단을 구체적으로 보고하세요.`
}

function workspaceCheckpointInstruction(delegation, workspaceResult) {
  const files = Array.isArray(workspaceResult?.changedFiles) && workspaceResult.changedFiles.length > 0
    ? workspaceResult.changedFiles.map((file) => `- ${file}`).join('\n')
    : '- Git status로 현재 변경을 다시 확인하세요.'
  return `# MindNProgress 명시적 체크포인트 요청

하위 작업이 완료되었지만 Unity Play·재임포트·동적 자산 생성 등의 부산물과 구현 변경을 구분할 명시적 체크포인트가 없어 main 통합을 중단했습니다.

- 하위 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- workspaceId: ${delegation.workspaceLease.workspaceId}
- jobId: ${delegation.workspaceLease.jobId}
- leaseId: ${delegation.workspaceLease.leaseId}
- projectRoot: ${delegation.workspaceLease.projectRoot}
- 요청 회차: ${workspaceResult.checkpointRound}

## 현재 변경 후보

${files}

최신 카드 요구사항과 Git diff를 대조해 의도한 구현 변경과 검증 부산물을 구분하세요. 의도한 파일만 \`mindnprogress_checkpoint_ai_workspace\`의 \`paths\`에 넣고, \`commitMessage\`에는 이번 변경을 실제로 설명하는 \`summary\`·\`background\`·\`cause\`·\`changes\`와 필요한 경우 \`scope\`를 작성하세요. \`summary\`의 \`[김용민]\` prefix와 출처를 나타내는 \`[MnP]\` 및 나머지 본문 섹션은 서버가 추가하므로 직접 넣지 마세요. 자동 변경은 포함하지 마세요. 의도한 파일 변경이 없다면 \`mindnprogress_confirm_ai_workspace_no_changes\`를 호출하세요. 구현과 자동 변경이 같은 파일에 섞여 있으면 기준 내용으로 되돌린 뒤 의도한 수정만 다시 적용하세요. 체크포인트 후 필수 검증을 다시 수행하고 최종 결과를 보고하세요.`
}

async function startWorkspaceCheckpointResolution(delegation, workspaceResult) {
  const operationId = boundedAionOperationId(delegation.id, `checkpoint-${workspaceResult.checkpointRound}`)
  let dispatch = null
  try {
    dispatch = await fetchAionUi('/api/internal/external-conversation-dispatches', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        operationId,
        actorConversationId: delegation.parentConversationId,
        strategy: 'resume',
        targetConversationId: delegation.targetConversationId,
        workspaceLease: delegation.workspaceLease,
        instruction: workspaceCheckpointInstruction(delegation, workspaceResult),
      },
    })
  } catch (error) {
    for (let attempt = 0; attempt < 10 && !dispatch; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        dispatch = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(operationId)}`)
      } catch {
        // The checkpoint dispatch may have started even when its POST response was lost.
      }
    }
    if (!dispatch) {
      const reason = `체크포인트 보완 요청을 AionUi에 전달하지 못했습니다: ${error?.message ?? String(error)}`
      return updateAiDelegation(delegation.id, {
        state: 'integration-recovery-required',
        workspaceResult,
        workspaceError: null,
        integrationOperationId: operationId,
        integrationStatus: 'dispatch-unavailable',
        integrationError: reason,
        recoveryRequiredAt: new Date().toISOString(),
      })
    }
  }

  return updateAiDelegation(delegation.id, {
    state: integrationDelegationState(dispatch.state),
    workspaceResult,
    workspaceError: null,
    integrationOperationId: operationId,
    integrationTurnId: dispatch.turnId ?? null,
    integrationStartedAt: new Date().toISOString(),
  })
}

async function startWorkspaceConflictResolution(delegation, workspaceResult) {
  const operationId = boundedAionOperationId(delegation.id, `integrate-${workspaceResult.conflictRound}`)
  let dispatch = null
  try {
    dispatch = await fetchAionUi('/api/internal/external-conversation-dispatches', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        operationId,
        actorConversationId: delegation.parentConversationId,
        strategy: 'resume',
        targetConversationId: delegation.targetConversationId,
        workspaceLease: delegation.workspaceLease,
        instruction: workspaceConflictInstruction(delegation, workspaceResult),
      },
    })
  } catch (error) {
    for (let attempt = 0; attempt < 10 && !dispatch; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        dispatch = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(operationId)}`)
      } catch {
        // The conflict-resolution dispatch may have started even when its POST response was lost.
      }
    }
    if (!dispatch) {
      const reason = `통합 충돌 해결 요청을 AionUi에 전달하지 못했습니다: ${error?.message ?? String(error)}`
      return updateAiDelegation(delegation.id, {
        state: 'integration-recovery-required',
        workspaceResult,
        workspaceError: null,
        integrationOperationId: operationId,
        integrationStatus: 'dispatch-unavailable',
        integrationError: reason,
        recoveryRequiredAt: new Date().toISOString(),
      })
    }
  }

  return updateAiDelegation(delegation.id, {
    state: integrationDelegationState(dispatch.state),
    workspaceResult,
    workspaceError: null,
    integrationOperationId: operationId,
    integrationTurnId: dispatch.turnId ?? null,
    integrationStartedAt: new Date().toISOString(),
  })
}

async function advanceWorkspaceIntegration(delegation, workspace) {
  if (workspace.result?.status === 'waiting-integration') {
    const waiting = await updateAiDelegation(delegation.id, {
      state: 'waiting-integration',
      workspaceResult: workspace.result,
      workspaceError: null,
    })
    scheduleAiDelegationWaitPoll(waiting)
    return true
  }
  if (workspace.result?.status === 'awaiting-conflict-resolution') {
    clearAiDelegationWaitPoll(delegation.id)
    await startWorkspaceConflictResolution(delegation, workspace.result)
    return true
  }
  if (workspace.result?.status === 'checkpoint-required') {
    clearAiDelegationWaitPoll(delegation.id)
    let notifiedDelegation = delegation
    try {
      notifiedDelegation = await ensureCheckpointRequiredNotification(delegation, workspace.result)
    } catch (error) {
      console.warn('[AI delegation checkpoint notification]', error)
    }
    await startWorkspaceCheckpointResolution(notifiedDelegation, workspace.result)
    return true
  }
  clearAiDelegationWaitPoll(delegation.id)
  return false
}

function clearAiDelegationWaitPoll(delegationId) {
  aiDelegationWaitPolls.delete(String(delegationId ?? ''))
}

function scheduleAiDelegationWaitPoll(delegation, now = Date.now()) {
  if (!delegation?.id) return
  aiDelegationWaitPolls.set(
    delegation.id,
    nextAiDelegationWaitPoll(aiDelegationWaitPolls.get(delegation.id), delegation, now),
  )
}

async function drainWaitingWorkspaceDelegations() {
  const waiting = [...aiDelegations.values()]
    .filter((delegation) => ['waiting-workspace', 'waiting-integration-clean'].includes(delegation.state))
    .sort((first, second) => String(first.createdAt).localeCompare(String(second.createdAt)))
  const waitingIds = new Set([...aiDelegations.values()]
    .filter((delegation) => [
      'waiting-workspace',
      'waiting-integration-clean',
      'waiting-integration',
    ].includes(delegation.state))
    .map((delegation) => delegation.id))
  for (const delegationId of aiDelegationWaitPolls.keys()) {
    if (!waitingIds.has(delegationId)) aiDelegationWaitPolls.delete(delegationId)
  }
  let integrationDirtyThisTick = null
  for (const queued of waiting) {
    if (!aiDelegationWaitPollDue(aiDelegationWaitPolls.get(queued.id), queued)) continue
    if (integrationDirtyThisTick) {
      const blocked = await updateAiDelegation(queued.id, {
        state: 'waiting-integration-clean',
        childStatus: null,
        childError: null,
        workspaceWaitError: integrationDirtyThisTick.message,
        integrationCleanTrackedChanges: integrationDirtyThisTick.trackedChanges,
        integrationCleanWaitStartedAt: queued.integrationCleanWaitStartedAt ?? new Date().toISOString(),
        resource: {
          kind: 'integration_workspace',
          key: workspacePoolManager.publicSnapshot().integrationWorkspaceId,
          projectRoot: queued.pendingWorkspaceHint,
        },
      })
      scheduleAiDelegationWaitPoll(blocked)
      continue
    }
    const map = await readMap(queued.mapId)
    const parentCard = map?.nodes.find((node) => node.id === queued.parentCardId)
    const targetCard = map?.nodes.find((node) => node.id === queued.targetCardId)
    const user = users.find((candidate) => candidate.id === queued.startedBy)
    if (!map || map.trashedAt || !parentCard || !targetCard || !user
      || !isHierarchyDescendant(map, parentCard.id, targetCard.id)
      || !isAiConversationLinked(parentCard.data, queued.parentConversationId)) {
      await updateAiDelegation(queued.id, {
        state: 'failed',
        childStatus: 'rejected',
        childError: '대기 중 상위 카드, 대상 카드, 편집자 또는 카드 계층이 변경되어 위임을 시작하지 않았습니다.',
        resource: null,
      })
      clearAiDelegationWaitPoll(queued.id)
      continue
    }

    let resumedDelegation = queued.resumesDelegationId
      ? aiDelegations.get(queued.resumesDelegationId) ?? null
      : null
    if (queued.strategy === 'resume') {
      if (!isAiConversationLinked(targetCard.data, queued.targetConversationId)) {
        await updateAiDelegation(queued.id, {
          state: 'failed',
          childStatus: 'rejected',
          childError: '대기 중 대상 카드와 이어갈 AI 대화의 연결이 사라졌습니다.',
          resource: null,
        })
        clearAiDelegationWaitPoll(queued.id)
        continue
      }
      const runtimeSnapshot = await fetchAiConversationRuntimeSnapshot()
      const activeRuntime = runtimeSnapshot.available
        ? runtimeSnapshot.runtimes.get(queued.targetConversationId) ?? null
        : null
      if (activeRuntime && activeRuntime.state !== 'idle') {
        const blocked = await updateAiDelegation(queued.id, {
          workspaceWaitError: `대상 대화가 ${activeRuntime.state} 상태이므로 유휴 상태를 기다리고 있습니다.`,
        })
        scheduleAiDelegationWaitPoll(blocked)
        continue
      }
      if (resumedDelegation && resumedDelegation.state !== 'waiting-child-resume') {
        await updateAiDelegation(queued.id, {
          state: 'failed',
          childStatus: 'rejected',
          childError: '이어받을 이전 위임이 더 이상 재개 대기 상태가 아닙니다.',
          resource: null,
        })
        clearAiDelegationWaitPoll(queued.id)
        continue
      }
    } else {
      resumedDelegation = null
    }

    if (!await aionCoreSupportsWorkspaceLease()) {
      const blocked = await updateAiDelegation(queued.id, {
        workspaceWaitError: '현재 AionCore가 작업공간 lease를 지원하지 않아 재기동을 기다리고 있습니다.',
      })
      scheduleAiDelegationWaitPoll(blocked)
      break
    }
    if (!await aionCoreSupportsExplicitCompletionAfterInterruption()) {
      const blocked = await updateAiDelegation(queued.id, {
        workspaceWaitError: '현재 AionCore가 중단 후 명시적 완료 신호를 지원하지 않아 재기동을 기다리고 있습니다.',
      })
      scheduleAiDelegationWaitPoll(blocked)
      break
    }

    if (queued.strategy === 'resume') {
      try {
        const conversation = await fetchAiConversationRuntime(queued.targetConversationId)
        const runtime = normalizeAiConversationRuntime(queued.targetConversationId, conversation)
        if (runtime.state !== 'idle') {
          const blocked = await updateAiDelegation(queued.id, {
            workspaceWaitError: `대상 대화가 ${runtime.state} 상태이므로 유휴 상태를 기다리고 있습니다.`,
          })
          scheduleAiDelegationWaitPoll(blocked)
          continue
        }
      } catch (error) {
        const blocked = await updateAiDelegation(queued.id, {
          workspaceWaitError: `대상 AionUi 대화 상태를 확인하지 못했습니다: ${error?.message ?? String(error)}`,
        })
        scheduleAiDelegationWaitPoll(blocked)
        continue
      }
    }

    const selection = structuredClone(queued.pendingSelection)
    let workspaceLease
    try {
      workspaceLease = resumedDelegation?.workspaceLease?.leaseId
        ? await workspacePoolManager.reuseLease(resumedDelegation.workspaceLease.leaseId, {
            mapId: map.id,
            cardId: targetCard.id,
            conversationId: queued.targetConversationId,
          })
        : await workspacePoolManager.acquire({
            workspaceHint: queued.pendingWorkspaceHint,
            mapId: map.id,
            cardId: targetCard.id,
            conversationId: queued.strategy === 'resume' ? queued.targetConversationId : '',
            cardLabel: targetCard.data?.label ?? targetCard.id,
          })
    } catch (error) {
      if (error instanceof WorkspacePoolUnavailableError && error.reasonCode === 'CAPACITY_EXHAUSTED') {
        const blocked = queued.state === 'waiting-integration-clean'
          ? await updateAiDelegation(queued.id, {
              state: 'waiting-workspace',
              workspaceWaitError: '사용 가능한 AI 작업공간을 기다리고 있습니다.',
              integrationCleanResolvedAt: new Date().toISOString(),
              resource: { kind: 'workspace_pool', key: workspacePoolManager.publicSnapshot().poolId },
            })
          : queued
        scheduleAiDelegationWaitPoll(blocked)
        break
      }
      if (error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === integrationStatusRetryReasonCode) {
        const blocked = await updateAiDelegation(queued.id, {
          workspaceWaitError: error.message,
        })
        scheduleAiDelegationWaitPoll(blocked)
        break
      }
      if (error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === integrationWorktreeDirtyReasonCode) {
        const trackedChanges = Array.isArray(error.details)
          ? error.details.map((item) => String(item ?? '').trim()).filter(Boolean)
          : []
        integrationDirtyThisTick = { message: error.message, trackedChanges }
        const blocked = await updateAiDelegation(queued.id, {
          state: 'waiting-integration-clean',
          childStatus: null,
          childError: null,
          workspaceWaitError: error.message,
          integrationCleanTrackedChanges: trackedChanges,
          integrationCleanWaitStartedAt: queued.integrationCleanWaitStartedAt ?? new Date().toISOString(),
          resource: {
            kind: 'integration_workspace',
            key: workspacePoolManager.publicSnapshot().integrationWorkspaceId,
            projectRoot: queued.pendingWorkspaceHint,
          },
        })
        scheduleAiDelegationWaitPoll(blocked)
        continue
      }
      await updateAiDelegation(queued.id, {
        state: 'failed',
        childStatus: 'rejected',
        childError: error?.message ?? String(error),
        workspaceWaitError: error?.message ?? String(error),
        resource: null,
      })
      clearAiDelegationWaitPoll(queued.id)
      continue
    }
    if (!workspaceLease) {
      await updateAiDelegation(queued.id, {
        state: 'failed',
        childStatus: 'rejected',
        childError: '등록된 AI 작업공간 풀의 lease를 확보하지 못했습니다.',
        resource: null,
      })
      clearAiDelegationWaitPoll(queued.id)
      continue
    }
    selection.workspace = workspaceLease.projectRoot
    const starting = await updateAiDelegation(queued.id, {
      state: 'starting',
      workspaceLease,
      resource: null,
      workspaceWaitError: null,
      ...(queued.state === 'waiting-integration-clean'
        ? { integrationCleanResolvedAt: new Date().toISOString() }
        : {}),
    })
    clearAiDelegationWaitPoll(queued.id)
    try {
      await dispatchPreparedAiDelegation({
        queuedDelegation: starting,
        id: queued.id,
        requestSignature: queued.requestSignature,
        map,
        parentCard,
        targetCard,
        parentAttribution: {
          conversationId: queued.parentConversationId,
          startedBy: queued.startedBy,
        },
        targetConversationId: queued.targetConversationId,
        strategy: queued.strategy,
        decisionReason: queued.decisionReason,
        sourceRevision: queued.sourceRevision,
        instruction: queued.pendingInstruction,
        selection,
        workspaceLease,
        resumedDelegation,
        user,
        expectsWorkspacePool: true,
      })
    } catch (error) {
      const needsRecovery = ['AI_WORKSPACE_LEASE_MISMATCH', 'AI_WORKSPACE_CONVERSATION_CONFLICT'].includes(error?.code)
      await updateAiDelegation(queued.id, {
        state: needsRecovery ? 'recovery-required' : 'failed',
        childStatus: needsRecovery ? 'interrupted' : 'rejected',
        childError: error?.message ?? String(error),
        ...(needsRecovery ? { recoveryRequiredAt: new Date().toISOString(), recoveryDetails: error?.details ?? null } : {}),
        resource: null,
      })
      clearAiDelegationWaitPoll(queued.id)
    }
  }
}

async function pollAiDelegations() {
  if (aiDelegationPollRunning) return
  aiDelegationPollRunning = true
  try {
    await drainWaitingWorkspaceDelegations()
    const active = [...aiDelegations.values()].filter((delegation) =>
      [
        'waiting-integration-clean',
        'starting', 'waiting-resource', 'running', 'waiting-child-resume',
        'recovery-required',
        'waiting-integration', 'integration-starting', 'integration-waiting-resource',
        'integration-running', 'integration-waiting-resume', 'integration-recovery-required',
        'waiting-parent', 'waking-parent',
      ].includes(delegation.state))
    for (const delegation of active) {
      if (delegation.state === 'waiting-integration-clean') {
        try {
          await processAiDelegationIntegrationCleanWaitNotice(delegation)
        } catch (error) {
          console.warn('[AI delegation integration clean notification]', error)
        }
        continue
      }
      if (['recovery-required', 'integration-recovery-required'].includes(delegation.state)) {
        try {
          await processAiDelegationRecoveryNotice(delegation)
        } catch (error) {
          console.warn('[AI delegation recovery notification]', error)
        }
        continue
      }
      if (['starting', 'waiting-resource', 'running', 'waiting-child-resume'].includes(delegation.state)) {
        try {
          const operationId = delegation.childOperationId ?? delegation.id
          const status = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(operationId)}`)
          if (!await reconcileAiDelegationWorkspaceLeaseStatus(delegation, status, 'poll')) continue
          if (status.state === 'recovery_required') {
            await updateAiDelegation(delegation.id, {
              state: 'recovery-required',
              childStatus: 'interrupted-by-restart',
              childTurnId: status.turnId ?? delegation.childTurnId ?? null,
              childError: status.errorMessage ?? 'AionCore 재시작으로 명시적인 작업 재개가 필요합니다.',
              recoveryRequiredAt: delegation.recoveryRequiredAt ?? new Date().toISOString(),
              resource: null,
            })
            continue
          }
          if (['starting', 'waiting_resource', 'running', 'waiting_resume'].includes(status.state)) {
            await updateAiDelegation(delegation.id, {
              state: status.state === 'waiting_resource'
                ? 'waiting-resource'
                : status.state === 'waiting_resume' ? 'waiting-child-resume' : status.state,
              childStatus: status.state === 'waiting_resume' ? 'interrupted' : delegation.childStatus,
              childTurnId: status.turnId ?? delegation.childTurnId ?? null,
              childError: status.state === 'waiting_resume'
                ? status.errorMessage ?? delegation.childError ?? null
                : delegation.childError,
              resource: status.resource ?? delegation.resource ?? null,
              ...(status.state === 'waiting_resume' && !delegation.childInterruptedAt
                ? { childInterruptedAt: new Date().toISOString() }
                : {}),
            })
            continue
          }
          const childStatus = status.state
          const childError = status.errorMessage ?? null
          const capturedDelegation = await captureAiDelegationChildResult(delegation)
          const workspace = await finalizeDelegationWorkspace(capturedDelegation, childStatus, childError)
          const updated = await updateAiDelegation(capturedDelegation.id, {
            childStatus,
            childTurnId: status.turnId ?? delegation.childTurnId ?? null,
            childError: workspace.error ?? childError,
            childCompletedAt: new Date().toISOString(),
            workspaceResult: workspace.result,
            workspaceError: workspace.error,
          })
          if (await advanceWorkspaceIntegration(updated, workspace)) continue
          await updateAiDelegation(delegation.id, {
            state: 'waiting-parent',
          })
        } catch (error) {
          if (error?.status !== 404) continue
          await updateAiDelegation(delegation.id, {
            state: 'recovery-required',
            childStatus: 'interrupted-by-restart',
            childError: 'AionUi가 위임 실행 상태를 더 이상 보유하지 않습니다. 작업공간을 보존한 채 명시적인 재개가 필요합니다.',
            recoveryRequiredAt: delegation.recoveryRequiredAt ?? new Date().toISOString(),
            resource: null,
          })
        }
        continue
      }

      if (delegation.state === 'waiting-integration') {
        if (!aiDelegationWaitPollDue(aiDelegationWaitPolls.get(delegation.id), delegation)) continue
        const workspace = await finalizeDelegationWorkspace(
          delegation,
          delegation.childStatus ?? 'completed',
          delegation.childError ?? null,
        )
        const updated = await updateAiDelegation(delegation.id, {
          workspaceResult: workspace.result,
          workspaceError: workspace.error,
          childError: workspace.error ?? delegation.childError ?? null,
        })
        if (await advanceWorkspaceIntegration(updated, workspace)) continue
        await updateAiDelegation(delegation.id, { state: 'waiting-parent' })
        continue
      }

      if (['integration-starting', 'integration-waiting-resource', 'integration-running', 'integration-waiting-resume'].includes(delegation.state)) {
        try {
          const status = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(delegation.integrationOperationId)}`)
          if (status.state === 'recovery_required') {
            await updateAiDelegation(delegation.id, {
              state: 'integration-recovery-required',
              integrationStatus: 'interrupted-by-restart',
              integrationTurnId: status.turnId ?? delegation.integrationTurnId ?? null,
              integrationError: status.errorMessage ?? 'AionCore 재시작으로 통합 충돌 해결의 명시적인 재개가 필요합니다.',
              recoveryRequiredAt: delegation.recoveryRequiredAt ?? new Date().toISOString(),
              integrationResource: null,
            })
            continue
          }
          if (['starting', 'waiting_resource', 'running', 'waiting_resume'].includes(status.state)) {
            await updateAiDelegation(delegation.id, {
              state: integrationDelegationState(status.state),
              integrationTurnId: status.turnId ?? delegation.integrationTurnId ?? null,
              integrationError: status.state === 'waiting_resume'
                ? status.errorMessage ?? delegation.integrationError ?? null
                : delegation.integrationError,
              integrationResource: status.resource ?? delegation.integrationResource ?? null,
            })
            continue
          }
          const failedIntegration = failedAiIntegrationRecoveryRuntime(status)
          if (failedIntegration) {
            await updateAiDelegation(delegation.id, failedIntegration)
            continue
          }
          const integrationError = status.errorMessage ?? null
          const workspace = delegation.workspaceResult?.status === 'checkpoint-required'
            ? await finalizeDelegationWorkspace(delegation, status.state, integrationError)
            : await completeDelegationWorkspaceConflict(delegation, status.state, integrationError)
          const updated = await updateAiDelegation(delegation.id, {
            integrationStatus: status.state,
            integrationTurnId: status.turnId ?? delegation.integrationTurnId ?? null,
            integrationError,
            integrationCompletedAt: new Date().toISOString(),
            workspaceResult: workspace.result,
            workspaceError: workspace.error,
            childError: workspace.error ?? delegation.childError ?? null,
          })
          if (await advanceWorkspaceIntegration(updated, workspace)) continue
          await updateAiDelegation(delegation.id, { state: 'waiting-parent' })
        } catch (error) {
          if (error?.status !== 404) continue
          await updateAiDelegation(delegation.id, {
            state: 'integration-recovery-required',
            integrationStatus: 'interrupted-by-restart',
            integrationError: 'AionUi가 통합 충돌 해결 실행 상태를 더 이상 보유하지 않습니다. 작업공간을 보존한 채 명시적인 재개가 필요합니다.',
            recoveryRequiredAt: delegation.recoveryRequiredAt ?? new Date().toISOString(),
            integrationResource: null,
          })
        }
        continue
      }

      if (delegation.state === 'waiting-parent') {
        const anotherWakeInProgress = [...aiDelegations.values()].some((candidate) =>
          candidate.id !== delegation.id
          && candidate.parentConversationId === delegation.parentConversationId
          && candidate.state === 'waking-parent')
        if (anotherWakeInProgress) continue
        try {
          const parent = await fetchAiConversationRuntime(delegation.parentConversationId)
          const runtime = normalizeAiConversationRuntime(delegation.parentConversationId, parent)
          if (runtime.state !== 'idle') continue
          const result = delegation.childResultSnapshot || await latestAssistantResult(delegation.targetConversationId)
          const parentWakeAttempt = Number(delegation.parentWakeAttempt ?? 0) + 1
          const wakeOperationId = boundedAionOperationId(delegation.id, `wake-${parentWakeAttempt}`)
          const response = await fetchAionUi('/api/internal/external-conversation-dispatches', {
            method: 'POST',
            body: {
              operationId: wakeOperationId,
              actorConversationId: delegation.parentConversationId,
              strategy: 'resume',
              targetConversationId: delegation.parentConversationId,
              instruction: parentWakeInstruction(delegation, result),
            },
          })
          await updateAiDelegation(delegation.id, {
            state: 'waking-parent',
            wakeOperationId,
            parentWakeAttempt,
            parentTurnId: response.turnId ?? null,
          })
        } catch {
          continue
        }
        continue
      }

      try {
        const status = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(delegation.wakeOperationId)}`)
        if (status.state === 'recovery_required') {
          await updateAiDelegation(delegation.id, {
            state: 'waiting-parent',
            parentDispatchState: 'interrupted-by-restart',
            parentError: 'AionCore 재시작으로 상위 대화 재개 알림을 다시 전달합니다.',
          })
          continue
        }
        if (['starting', 'waiting_resource', 'running', 'waiting_resume'].includes(status.state)) {
          await updateAiDelegation(delegation.id, {
            parentTurnId: status.turnId ?? delegation.parentTurnId ?? null,
            parentDispatchState: status.state === 'waiting_resource'
              ? 'waiting-resource'
              : status.state === 'waiting_resume' ? 'waiting-resume' : status.state,
            parentError: status.state === 'waiting_resume'
              ? status.errorMessage ?? delegation.parentError ?? null
              : delegation.parentError,
            parentResource: status.resource ?? delegation.parentResource ?? null,
          })
          continue
        }
        await updateAiDelegation(delegation.id, {
          state: aiDelegationStateAfterParentWake(delegation, status.state),
          parentTurnId: status.turnId ?? delegation.parentTurnId ?? null,
          parentDispatchState: status.state,
          parentError: status.errorMessage ?? null,
          completedAt: new Date().toISOString(),
        })
      } catch (error) {
        if (error?.status === 404) {
          await updateAiDelegation(delegation.id, {
            state: 'waiting-parent',
            parentDispatchState: 'interrupted-by-restart',
            parentError: 'AionUi가 상위 대화 재개 상태를 더 이상 보유하지 않아 다시 전달합니다.',
          })
        }
        continue
      }
    }
  } finally {
    aiDelegationPollRunning = false
  }
}

function sameAiConversationRuntime(first, second) {
  return first?.conversationId === second?.conversationId
    && first?.state === second?.state
    && first?.isProcessing === second?.isProcessing
    && first?.pendingConfirmations === second?.pendingConfirmations
    && first?.turnId === second?.turnId
    && first?.conversationCount === second?.conversationCount
    && JSON.stringify(first?.activeConversationIds ?? []) === JSON.stringify(second?.activeConversationIds ?? [])
}

function normalizeAiConversationRuntime(conversationId, conversation, observedAt = new Date().toISOString()) {
  return conversation?.runtime && typeof conversation.runtime === 'object'
    ? normalizeAionUiConversationRuntime(conversationId, conversation.runtime, observedAt)
    : unavailableAiConversationRuntime(conversationId, observedAt)
}

function aiConversationRuntimeSnapshot(mapId) {
  const prefix = `${mapId}:`
  return [...aiConversationRuntimeStates.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, runtime]) => ({ nodeId: key.slice(prefix.length), runtime }))
}

function aiConversationRuntimeSummary(mapId) {
  return {
    mapId,
    activeCount: aiConversationRuntimeSnapshot(mapId).filter((item) => item.runtime.state === 'running').length,
  }
}

async function aiConversationWorkStates(mapId, requestedCardIds = []) {
  const map = await readMap(mapId)
  if (!map || map.trashedAt) return null

  const requestedIds = [...new Set(requestedCardIds)]
  const nodesById = new Map(map.nodes.map((node) => [node.id, node]))
  const missingCardIds = requestedIds.filter((cardId) => !nodesById.has(cardId))
  if (missingCardIds.length > 0) {
    return { error: 'CARD_NOT_FOUND', missingCardIds }
  }

  const runtimes = await refreshAiConversationRuntimeForMap(mapId)
  const runtimesByNodeId = new Map(runtimes.map((item) => [item.nodeId, item.runtime]))
  const nodes = requestedIds.length > 0 ? requestedIds.map((cardId) => nodesById.get(cardId)) : map.nodes
  const cards = nodes.map((node) => {
    const conversationIds = aiConversationIdsFromData(node.data)
    const conversationId = typeof node.data?.aiConversationId === 'string' ? node.data.aiConversationId.trim() : conversationIds.at(-1) ?? ''
    const runtime = conversationIds.length > 0 ? runtimesByNodeId.get(node.id) : null
    const state = runtime?.state ?? (conversationIds.length > 0 ? 'unknown' : 'unlinked')
    return {
      cardId: node.id,
      label: node.data?.label ?? node.id,
      conversationId: conversationId || null,
      conversationCount: conversationIds.length,
      activeConversationIds: runtime?.activeConversationIds ?? [],
      state,
      isActive: state === 'running' || state === 'waiting-confirmation',
      isProcessing: runtime?.isProcessing ?? false,
      pendingConfirmations: runtime?.pendingConfirmations ?? 0,
      turnId: runtime?.turnId ?? null,
      observedAt: runtime?.observedAt ?? null,
    }
  })

  return {
    mapId,
    mapVersion: map.version,
    cards,
    activeCardIds: cards.filter((card) => card.isActive).map((card) => card.cardId),
    stateGuide: {
      running: 'AI가 현재 응답을 생성하거나 도구를 실행하는 중',
      'waiting-confirmation': 'AI 작업이 사용자 승인 또는 확인을 기다리는 중',
      idle: '연결된 AI 대화가 현재 작업 중이 아님. 카드 업무 완료를 뜻하지 않음',
      unknown: '대화는 연결되어 있지만 AionUi 런타임 상태를 확인하지 못함',
      unlinked: '연결된 AI 대화가 없음',
    },
  }
}

function broadcastAiConversationRuntime(mapId, nodeId, runtime) {
  broadcastEvent(
    { type: 'ai-conversation-runtime', mapId, nodeId, runtime },
    (client) => client.mapId === mapId,
  )
}

function updateAiConversationRuntimeSummary(mapId) {
  const summary = aiConversationRuntimeSummary(mapId)
  const previousCount = aiConversationRuntimeSummaries.get(mapId)
  aiConversationRuntimeSummaries.set(mapId, summary.activeCount)
  if (previousCount !== summary.activeCount) {
    broadcastEvent({ type: 'ai-conversation-runtime-summary', ...summary })
  }
  return summary
}

function clearAiConversationRuntimeMap(mapId) {
  const prefix = `${mapId}:`
  for (const [key] of aiConversationRuntimeStates) {
    if (!key.startsWith(prefix)) continue
    aiConversationRuntimeStates.delete(key)
    broadcastAiConversationRuntime(mapId, key.slice(prefix.length), null)
  }
  const previousCount = aiConversationRuntimeSummaries.get(mapId)
  aiConversationRuntimeSummaries.delete(mapId)
  if (previousCount !== undefined && previousCount !== 0) {
    broadcastEvent({ type: 'ai-conversation-runtime-summary', mapId, activeCount: 0 })
  }
}

function fetchAiConversationRuntimeSnapshot(force = false) {
  if (aiConversationRuntimeSnapshotRequest) return aiConversationRuntimeSnapshotRequest
  if (!force
    && aiConversationRuntimeSnapshotCache
    && Date.now() - aiConversationRuntimeSnapshotCachedAt < aiConversationRuntimePollIntervalMs) {
    return Promise.resolve(aiConversationRuntimeSnapshotCache)
  }
  const request = fetchAionUi('/api/internal/conversation-runtimes/active', { timeoutMs: 2_500 })
    .then((snapshot) => {
      const parsed = parseAionUiActiveConversationRuntimeSnapshot(snapshot)
      aiConversationRuntimeSnapshotLastSuccessAt = Date.now()
      return { available: true, retainPrevious: false, ...parsed }
    })
    .catch(() => ({
      available: false,
      retainPrevious: aiConversationRuntimeSnapshotLastSuccessAt > 0
        && Date.now() - aiConversationRuntimeSnapshotLastSuccessAt <= aiConversationRuntimeFailureGraceMs,
      observedAt: new Date().toISOString(),
      runtimes: new Map(),
    }))
    .then((snapshot) => {
      aiConversationRuntimeSnapshotCache = snapshot
      aiConversationRuntimeSnapshotCachedAt = Date.now()
      return snapshot
    })
    .finally(() => {
      aiConversationRuntimeSnapshotRequest = null
    })
  aiConversationRuntimeSnapshotRequest = request
  return request
}

function fetchAiConversationRuntime(conversationId) {
  const existing = aiConversationRuntimeRequests.get(conversationId)
  if (existing) return existing
  const request = fetchAionUi(`/api/conversations/${encodeURIComponent(conversationId)}`, { timeoutMs: 2_500 })
    .finally(() => aiConversationRuntimeRequests.delete(conversationId))
  aiConversationRuntimeRequests.set(conversationId, request)
  return request
}

function refreshAiConversationRuntimeForMap(mapId, suppliedRuntimeSnapshot = null) {
  const existing = aiConversationRuntimeRefreshes.get(mapId)
  if (existing) return existing

  const refresh = (async () => {
    const runtimeSnapshot = suppliedRuntimeSnapshot ?? await fetchAiConversationRuntimeSnapshot()
    const map = await readMap(mapId)
    const targets = map && !map.trashedAt
      ? map.nodes.flatMap((node) => {
          const conversationIds = aiConversationIdsFromData(node.data)
          return conversationIds.length > 0 ? [{ nodeId: node.id, conversationIds }] : []
        })
      : []
    const targetKeys = new Set(targets.map((target) => conversationAttributionKey(mapId, target.nodeId)))
    const prefix = `${mapId}:`

    for (const [key] of aiConversationRuntimeStates) {
      if (!key.startsWith(prefix) || targetKeys.has(key)) continue
      aiConversationRuntimeStates.delete(key)
      broadcastAiConversationRuntime(mapId, key.slice(prefix.length), null)
    }

    if (runtimeSnapshot.retainPrevious) {
      updateAiConversationRuntimeSummary(mapId)
      return aiConversationRuntimeSnapshot(mapId)
    }

    for (const target of targets) {
      const key = conversationAttributionKey(mapId, target.nodeId)
      const runtime = aggregateAiConversationRuntime(target.conversationIds.map((conversationId) => (
        runtimeSnapshot.runtimes.get(conversationId)
          ?? (runtimeSnapshot.available
            ? inactiveAiConversationRuntime(conversationId, runtimeSnapshot.observedAt)
            : unavailableAiConversationRuntime(conversationId, runtimeSnapshot.observedAt))
      )))
      if (!runtime) continue
      const previous = aiConversationRuntimeStates.get(key)
      aiConversationRuntimeStates.set(key, runtime)
      if (!sameAiConversationRuntime(previous, runtime)) {
        broadcastAiConversationRuntime(mapId, target.nodeId, runtime)
      }
    }

    updateAiConversationRuntimeSummary(mapId)
    return aiConversationRuntimeSnapshot(mapId)
  })().finally(() => aiConversationRuntimeRefreshes.delete(mapId))

  aiConversationRuntimeRefreshes.set(mapId, refresh)
  return refresh
}

function refreshAiConversationRuntimeLibrary(forceSnapshot = false) {
  if (aiConversationRuntimeLibraryRefresh) return aiConversationRuntimeLibraryRefresh
  const refresh = (async () => {
    const runtimeSnapshot = await fetchAiConversationRuntimeSnapshot(forceSnapshot)
    const maps = await listMaps()
    const mapIds = maps.map((map) => map.id)
    const mapIdSet = new Set(mapIds)
    await Promise.allSettled(mapIds.map((mapId) => refreshAiConversationRuntimeForMap(mapId, runtimeSnapshot)))
    for (const mapId of aiConversationRuntimeSummaries.keys()) {
      if (!mapIdSet.has(mapId)) clearAiConversationRuntimeMap(mapId)
    }
    return mapIds.map(aiConversationRuntimeSummary)
  })().finally(() => {
    aiConversationRuntimeLibraryRefresh = null
  })
  aiConversationRuntimeLibraryRefresh = refresh
  return refresh
}

async function refreshVisibleAiConversationRuntimes() {
  if (eventClients.size === 0) return
  await refreshAiConversationRuntimeLibrary(true)
}

function readAionUiMessageContent(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (content && typeof content === 'object' && typeof content.content === 'string') return content.content
  try {
    return JSON.stringify(content ?? {}, null, 2)
  } catch {
    return String(content ?? '')
  }
}

function aionUiMessageRoleLabel(message) {
  if (message?.position === 'right') return '사용자'
  if (message?.position === 'left') return '어시스턴트'
  return '시스템'
}

function buildAionUiConversationTranscript(conversation, messages, exportedAt = new Date().toISOString()) {
  const lines = [
    `대화: ${conversation?.name || '대화'}`,
    `대화 ID: ${conversation?.id ?? ''}`,
    `내보낸 시각: ${exportedAt}`,
    `유형: ${conversation?.type ?? ''}`,
    '',
  ]
  const exportableMessages = messages.filter((message) => message?.type === 'text' || message?.type === 'tips')
  for (const message of exportableMessages) {
    lines.push(`${aionUiMessageRoleLabel(message)}:`)
    lines.push(readAionUiMessageContent(message))
    lines.push('')
  }
  if (exportableMessages.length === 0) {
    lines.push('메시지가 없습니다')
    lines.push('')
  }
  return {
    transcript: lines.join('\n').trimEnd(),
    exportedMessageCount: exportableMessages.length,
  }
}

function normalizeAionUiOption(option) {
  return {
    id: String(option?.value ?? option?.id ?? ''),
    label: String(option?.name ?? option?.label ?? option?.value ?? option?.id ?? ''),
    description: typeof option?.description === 'string' ? option.description : '',
  }
}

function normalizeAionUiAgent(agent, providers) {
  const rawConfigOptions = agent?.config_options
  const configOptions = Array.isArray(rawConfigOptions)
    ? rawConfigOptions
    : Array.isArray(rawConfigOptions?.config_options) ? rawConfigOptions.config_options : []
  const modelOption = configOptions.find((option) => option.category === 'model')
  const modeOption = configOptions.find((option) => option.category === 'mode')
  const thoughtOption = configOptions.find((option) => option.category === 'thought_level')
  const availableModels = Array.isArray(agent?.available_models?.available_models)
    ? agent.available_models.available_models.map(normalizeAionUiOption)
    : Array.isArray(modelOption?.options) ? modelOption.options.map(normalizeAionUiOption) : []
  const availableModes = Array.isArray(agent?.available_modes?.available_modes)
    ? agent.available_modes.available_modes.map(normalizeAionUiOption)
    : Array.isArray(modeOption?.options) ? modeOption.options.map(normalizeAionUiOption) : []
  const providerModels = agent?.agent_type === 'aionrs'
    ? providers.flatMap((provider) => (Array.isArray(provider.models) ? provider.models : []).map((model) => ({
        id: String(model),
        label: String(model),
        description: String(provider.name ?? ''),
        providerId: String(provider.id),
      })))
    : []

  return {
    id: String(agent.id),
    name: String(agent.name ?? agent.id),
    icon: typeof agent.icon === 'string' ? `${activeAionUiBaseUrl}${agent.icon}` : null,
    backend: String(agent.backend ?? agent.agent_type ?? ''),
    status: String(agent.status ?? 'unknown'),
    models: availableModels.length > 0 ? availableModels : providerModels,
    defaultModelId: String(
      agent?.available_models?.current_model_id
      ?? modelOption?.currentValue
      ?? modelOption?.current_value
      ?? providerModels[0]?.id
      ?? '',
    ),
    modes: availableModes,
    defaultMode: String(
      agent?.available_modes?.current_mode_id
      ?? modeOption?.currentValue
      ?? modeOption?.current_value
      ?? availableModes[0]?.id
      ?? '',
    ),
    thoughtLevels: Array.isArray(thoughtOption?.options) ? thoughtOption.options.map(normalizeAionUiOption) : [],
    defaultThoughtLevel: String(thoughtOption?.currentValue ?? thoughtOption?.current_value ?? ''),
  }
}

function normalizeAionUiSkills(skills) {
  return (Array.isArray(skills) ? skills : []).map((skill) => ({
    id: String(skill.name),
    name: String(skill.name),
    description: String(skill.description ?? ''),
    autoInject: skill.is_auto_inject === true,
  }))
}

function normalizeAionUiMcpServers(mcpServers) {
  return (Array.isArray(mcpServers) ? mcpServers : [])
    .filter((server) => server?.enabled !== false)
    .map((server) => ({
      id: String(server.id),
      name: String(server.name ?? server.id),
      description: String(server.description ?? ''),
      toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
      required: String(server.name ?? '').toLowerCase() === 'mindnprogress',
    }))
}

function aiConversationSelectionSnapshot(body, agent, model, skills, mcpServers) {
  const enabledSkillIds = new Set(Array.isArray(body.enabledSkillIds) ? body.enabledSkillIds.map(String) : [])
  const disabledBuiltinSkillIds = new Set(Array.isArray(body.disabledBuiltinSkillIds) ? body.disabledBuiltinSkillIds.map(String) : [])
  const selectedMcpIds = new Set(Array.isArray(body.mcpIds) ? body.mcpIds.map(String) : [])
  const mode = agent.modes.find((item) => item.id === String(body.mode ?? ''))
  const thoughtLevel = agent.thoughtLevels.find((item) => item.id === String(body.thoughtLevel ?? ''))
  return {
    agent: { id: agent.id, label: agent.name },
    model: { id: model.id, label: model.label },
    providerId: model.providerId ?? null,
    ...(mode ? { mode: { id: mode.id, label: mode.label } } : {}),
    ...(thoughtLevel ? { thoughtLevel: { id: thoughtLevel.id, label: thoughtLevel.label } } : {}),
    skills: skills
      .filter((skill) => skill.autoInject ? !disabledBuiltinSkillIds.has(skill.id) : enabledSkillIds.has(skill.id))
      .map((skill) => ({ id: skill.id, label: skill.name })),
    mcpServers: mcpServers
      .filter((server) => server.required || selectedMcpIds.has(server.id))
      .map((server) => ({ id: server.id, label: server.name })),
    workspace: String(body.workspace ?? '').trim().slice(0, 4_096) || null,
    requestPreview: String(body.requestPreview ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) || null,
  }
}

function cleanAionUiValue(value) {
  return String(value ?? '').replace(/\[[0-9;]*m\]?/g, '').trim()
}

function normalizedIsoDate(value, fallback = new Date().toISOString()) {
  const numericValue = typeof value === 'number' || /^\d+$/.test(String(value ?? '')) ? Number(value) : Number.NaN
  const timestamp = Number.isFinite(numericValue)
    ? (numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue)
    : Date.parse(String(value ?? ''))
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

async function repairUnspecifiedConversationComments(attribution, replaceableAuthorNames = []) {
  const comments = await listComments(attribution.mapId)
  const linkedAt = Date.parse(attribution.linkedAt)
  const actor = publicUser(attributionUser(attribution))
  const replaceableNames = new Set([integrationUser.name, ...replaceableAuthorNames].filter(Boolean))
  const repaired = []
  const nextComments = comments.map((comment) => {
    const createdAt = Date.parse(comment.createdAt)
    if (comment.nodeId !== attribution.cardId
      || comment.author?.id !== integrationUser.id
      || !replaceableNames.has(comment.author?.name)
      || (Number.isFinite(linkedAt) && (!Number.isFinite(createdAt) || createdAt < linkedAt))) {
      return comment
    }
    const next = { ...comment, author: actor }
    repaired.push(next)
    return next
  })
  if (repaired.length === 0) return 0
  await writeStoredArray(commentFileForMap(attribution.mapId), nextComments)
  for (const comment of repaired) {
    broadcastEvent({ type: 'comment-changed', mapId: attribution.mapId, nodeId: attribution.cardId, action: 'updated', comment })
  }
  return repaired.length
}

async function repairUnspecifiedConversationNotifications(attribution) {
  const linkedAt = Date.parse(attribution.linkedAt)
  const attributableComments = new Map((await listComments(attribution.mapId, attribution.cardId))
    .filter((comment) => {
      const createdAt = Date.parse(comment.createdAt)
      return comment.author?.name === attribution.authorName
        && (!Number.isFinite(linkedAt) || (Number.isFinite(createdAt) && createdAt >= linkedAt))
    })
    .map((comment) => [comment.id, comment]))
  if (attributableComments.size === 0) return 0

  const notificationEntries = await readdir(notificationsDirectory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  let repairedCount = 0
  for (const entry of notificationEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = path.join(notificationsDirectory, entry.name)
    const notifications = await readStoredArray(filePath).catch((error) => {
      console.warn('[AI conversation notification recovery]', JSON.stringify({ file: entry.name, error: error?.message ?? String(error) }))
      return null
    })
    if (!notifications) continue
    const repaired = []
    const removed = []
    const updated = notifications.flatMap((notification) => {
      const comment = attributableComments.get(notification.commentId)
      if (!comment
        || notification.mapId !== attribution.mapId
        || notification.nodeId !== attribution.cardId
        || notification.actor?.id !== integrationUser.id
        || notification.actor?.name !== integrationUser.name) {
        return [notification]
      }
      if (notification.userId === comment.author.id) {
        removed.push(notification)
        return []
      }
      const next = { ...notification, actor: comment.author }
      repaired.push(next)
      return [next]
    })
    if (repaired.length === 0 && removed.length === 0) continue
    await writeStoredArray(filePath, updated)
    repairedCount += repaired.length + removed.length
    for (const notification of repaired) broadcastNotification(notification)
    const removedByUser = new Map()
    for (const notification of removed) {
      const userNotifications = removedByUser.get(notification.userId) ?? []
      userNotifications.push(notification)
      removedByUser.set(notification.userId, userNotifications)
    }
    for (const [userId, userNotifications] of removedByUser) {
      broadcastEvent({
        type: 'notifications-removed',
        userId,
        notificationIds: userNotifications.map((notification) => notification.id),
      }, (client) => client.user.id === userId)
    }
  }
  return repairedCount
}

async function resolveConversationAttribution(
  mapId,
  cardId,
  conversationId,
  startedBy = null,
  fallback = null,
  { inferStartedBy = true } = {},
) {
  const [conversation, agents, providers] = await Promise.all([
    fetchAionUi(`/api/conversations/${encodeURIComponent(conversationId)}`),
    fetchAionUi('/api/agents/management'),
    fetchAionUi('/api/providers'),
  ])
  if (!conversation || conversation.id !== conversationId) throw new Error('AIONUI_CONVERSATION_NOT_FOUND')

  const normalizedAgents = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.enabled !== false && agent?.installed === true)
    .map((agent) => normalizeAionUiAgent(agent, Array.isArray(providers) ? providers.filter((item) => item?.enabled !== false) : []))
  const agentId = cleanAionUiValue(conversation?.extra?.agent_id) || cleanAionUiValue(fallback?.agentId)
  const modelId = cleanAionUiValue(conversation?.extra?.current_model_id) || cleanAionUiValue(fallback?.modelId)
  const agent = normalizedAgents.find((candidate) => cleanAionUiValue(candidate.id) === agentId)
  const model = agent?.models.find((candidate) => cleanAionUiValue(candidate.id) === modelId)
  const agentName = cleanAionUiValue(agent?.name) || cleanAionUiValue(fallback?.agentName) || agentId
  const modelName = cleanAionUiValue(model?.label) || cleanAionUiValue(fallback?.modelName) || modelId
  if (!agentId || !modelId || !agentName || !modelName) throw new Error('AIONUI_ATTRIBUTION_NOT_FOUND')

  let resolvedStartedBy = startedBy || fallback?.startedBy || null
  const authorName = `${agentName}(${modelName})`
  if (!resolvedStartedBy && inferStartedBy) {
    const comments = await listComments(mapId)
    const previousAuthor = [...comments].reverse().find((comment) => comment.nodeId === cardId
      && comment.author?.name === authorName
      && users.some((candidate) => candidate.id === comment.author.id && candidate.active !== false && canEdit(candidate)))
    resolvedStartedBy = previousAuthor?.author.id ?? null
  }

  return {
    mapId,
    cardId,
    conversationId,
    authorName,
    agentId,
    agentName,
    modelId,
    modelName,
    providerId: cleanAionUiValue(model?.providerId) || cleanAionUiValue(fallback?.providerId) || null,
    startedBy: resolvedStartedBy,
    linkedAt: normalizedIsoDate(conversation.created_at, fallback?.linkedAt),
    refreshedAt: new Date().toISOString(),
  }
}

async function refreshConversationAttribution(mapId, cardId, conversationId, startedBy = null, fallback = null, { makeCurrent = true } = {}) {
  const attribution = await resolveConversationAttribution(mapId, cardId, conversationId, startedBy, fallback)
  if (makeCurrent) {
    aiConversationAttributions.set(conversationAttributionKey(mapId, cardId), attribution)
    await persistAiConversationAttributions()
  }
  const fallbackModelId = String(fallback?.modelId ?? '')
  const malformedFallbackAuthor = (fallbackModelId.includes('[') || fallbackModelId.includes(']')) ? fallback?.authorName : null
  const repairedComments = await repairUnspecifiedConversationComments(attribution, [malformedFallbackAuthor])
  const repairedNotifications = await repairUnspecifiedConversationNotifications(attribution)
  console.log('[AI conversation attribution]', JSON.stringify({
    source: fallback ? 'conversation-linked' : 'conversation-recovered',
    mapId,
    cardId,
    conversationId,
    authorName: attribution.authorName,
    repairedComments,
    repairedNotifications,
  }))
  return { attribution, repairedComments, repairedNotifications }
}

async function recoverLinkedConversationAttributions() {
  const summaries = await listMaps()
  const targets = []
  for (const summary of summaries) {
    const map = await readMap(summary.id)
    if (!map || map.trashedAt) continue
    for (const node of map.nodes) {
      const conversationId = cleanAionUiValue(node.data?.aiConversationId)
      if (!conversationId) continue
      const existing = aiConversationAttributions.get(conversationAttributionKey(map.id, node.id))
      targets.push({ mapId: map.id, cardId: node.id, conversationId, existing })
    }
  }

  let recovered = 0
  let repairedComments = 0
  let repairedNotifications = 0
  for (const target of targets) {
    try {
      const result = await refreshConversationAttribution(
        target.mapId,
        target.cardId,
        target.conversationId,
        target.existing?.startedBy,
        target.existing,
      )
      recovered += 1
      repairedComments += result.repairedComments
      repairedNotifications += result.repairedNotifications
    } catch (error) {
      console.warn('[AI conversation attribution recovery]', JSON.stringify({ ...target, error: error?.message ?? String(error) }))
    }
  }
  if (targets.length > 0) {
    console.log(`[AI conversation attribution] 연결 대화 ${targets.length}개 중 AI 작성자 정보 ${recovered}개 복원, 댓글 ${repairedComments}개·알림 ${repairedNotifications}개 보정`)
  }
}

async function loadUsers() {
  const stored = await readStoredArray(usersFile)
  if (stored.length === 0) {
    users = seedUsers
    await persistUsers()
    return true
  }
  users = stored
    .filter((user) => typeof user?.id === 'string' && typeof user?.email === 'string' && ['admin', 'editor', 'viewer'].includes(user.role))
    .map((user) => ({
      ...user,
      active: user.active !== false,
      passwordHash: Buffer.from(String(user.passwordHash ?? ''), 'hex'),
    }))
    .filter((user) => user.passwordHash.length === 64)
  const adminCreated = !users.some((user) => user.role === 'admin')
  if (adminCreated) users.unshift(seedAdmin)
  if (!users.some((user) => user.id === 'user-public-viewer')) {
    users.push(seedPublicViewer)
  }
  await persistUsers()
  return adminCreated
}

async function invalidateUserSessions(userId, keepToken = null) {
  const keepTokenKey = keepToken ? sessionTokenKey(keepToken) : null
  let persistentSessionRemoved = false
  for (const [tokenKey, session] of sessions) {
    if (session.userId === userId && tokenKey !== keepTokenKey) {
      sessions.delete(tokenKey)
      persistentSessionRemoved ||= Boolean(session.persistent)
    }
  }
  if (persistentSessionRemoved) await persistSessions()
}

function commentFileForMap(mapId) {
  if (!isValidMapId(mapId)) throw new Error('INVALID_MAP_ID')
  return path.join(commentsDirectory, `${mapId}.json`)
}

function notificationFileForUser(userId) {
  if (!users.some((user) => user.id === userId) && userId !== integrationUser.id) throw new Error('INVALID_USER_ID')
  return path.join(notificationsDirectory, `${userId}.json`)
}

async function listComments(mapId, nodeId) {
  const comments = await readStoredArray(commentFileForMap(mapId))
  return comments
    .filter((comment) => comment?.mapId === mapId && (!nodeId || comment.nodeId === nodeId))
    .map((comment) => ({
      ...comment,
      parentId: typeof comment.parentId === 'string' ? comment.parentId : null,
      resolvedAt: typeof comment.resolvedAt === 'string' ? comment.resolvedAt : null,
      resolvedBy: comment.resolvedBy?.id ? comment.resolvedBy : null,
      reactions: comment.reactions && typeof comment.reactions === 'object' ? comment.reactions : {},
    }))
    .sort((first, second) => String(first.createdAt).localeCompare(String(second.createdAt)))
}

function buildNodeCommentStats(comments) {
  return comments.reduce((stats, comment) => {
    const current = stats[comment.nodeId] ?? { total: 0, unresolved: 0 }
    stats[comment.nodeId] = {
      total: current.total + 1,
      unresolved: current.unresolved + (!comment.parentId && !comment.resolvedAt ? 1 : 0),
    }
    return stats
  }, {})
}

const referenceContentKeys = [
  'description',
  'sharedKnowledge',
  'sharedKnowledgeUpdatedAt',
  'sharedKnowledgeUpdatedBy',
  'sharedKnowledgeReview',
  'progress',
  'status',
  'taskUrl',
  'externalLink',
  'aiConversationId',
  'aiConversations',
  'isWork',
  'assigneeId',
  'dueDate',
  'checklist',
  'waitingItems',
]

function projectReferenceNodeData(localData, sourceData) {
  const projected = { ...localData }
  for (const key of referenceContentKeys) {
    if (Object.hasOwn(sourceData, key)) projected[key] = structuredClone(sourceData[key])
    else delete projected[key]
  }
  const sourceLabel = String(sourceData.label ?? '').replace(/\s*\(ref\)\s*$/i, '').trim()
  projected.label = `${sourceLabel || String(localData.label ?? '').replace(/\s*\(ref\)\s*$/i, '').trim()} (ref)`
  return projected
}

async function resolveReferencesForMap(map) {
  const targets = (map.nodes ?? []).flatMap((node) => {
    const reference = node.data?.reference
    return typeof node.id === 'string'
      && typeof reference?.mapId === 'string'
      && typeof reference?.nodeId === 'string'
      ? [{ localNodeId: node.id, mapId: reference.mapId, nodeId: reference.nodeId }]
      : []
  })
  if (targets.length === 0) return { map, referenceCommentStats: {}, unresolvedReferenceNodeIds: [] }

  const referencesByMap = new Map(await Promise.all(
    [...new Set(targets.map((target) => target.mapId))].map(async (mapId) => {
      try {
        const referencedMap = await readMap(mapId)
        if (!referencedMap || referencedMap.trashedAt) return [mapId, { map: null, stats: {} }]
        const comments = await listComments(mapId)
        return [mapId, { map: referencedMap, stats: buildNodeCommentStats(comments) }]
      } catch {
        return [mapId, { map: null, stats: {} }]
      }
    }),
  ))

  const targetByLocalNodeId = new Map(targets.map((target) => [target.localNodeId, target]))
  const unresolvedReferenceNodeIds = []
  const resolvedNodes = map.nodes.map((node) => {
    const target = targetByLocalNodeId.get(node.id)
    if (!target) return node
    const referencedMap = referencesByMap.get(target.mapId)?.map
    const sourceNode = referencedMap?.nodes.find((candidate) => candidate.id === target.nodeId)
    if (!sourceNode) {
      unresolvedReferenceNodeIds.push(node.id)
      return node
    }
    return {
      ...node,
      data: projectReferenceNodeData(node.data, sourceNode.data),
    }
  })
  const referenceCommentStats = Object.fromEntries(targets.map((target) => [
    target.localNodeId,
    referencesByMap.get(target.mapId)?.stats[target.nodeId] ?? { total: 0, unresolved: 0 },
  ]))

  return {
    map: { ...map, nodes: resolvedNodes },
    referenceCommentStats,
    unresolvedReferenceNodeIds,
  }
}

function mentionedUsers(text) {
  return users.filter((candidate) => candidate.active !== false && !isPublicViewer(candidate) && text.includes(`@${candidate.name}`))
}

async function listNotifications(userId) {
  let notifications
  try {
    notifications = await readStoredArray(notificationFileForUser(userId))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    console.warn(`[Notifications] 손상된 알림 파일을 빈 목록으로 처리합니다: ${userId}`)
    notifications = []
  }
  return notifications
    .filter((notification) => notification?.userId === userId)
    .sort((first, second) => String(second.createdAt).localeCompare(String(first.createdAt)))
    .slice(0, 200)
}

function reportRejectedSideEffects(results, label) {
  for (const result of results) {
    if (result.status === 'rejected') console.error(`[${label}]`, result.reason)
  }
}

async function createNotification(user, payload) {
  const notifications = await listNotifications(user.id)
  if (payload.dedupeKey) {
    const existing = notifications.find((notification) => notification.dedupeKey === payload.dedupeKey)
    if (existing) return existing
  }
  const notification = {
    id: `notification-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    userId: user.id,
    createdAt: new Date().toISOString(),
    readAt: null,
    ...payload,
  }
  await writeStoredArray(notificationFileForUser(user.id), [notification, ...notifications].slice(0, 200))
  broadcastNotification(notification)
  return notification
}

function seoulDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function dateSerial(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue ?? ''))
  return match ? Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000) : null
}

async function ensureScheduleNotifications(user) {
  if (user.role !== 'editor' || user.active === false) return
  const today = seoulDateString()
  const todaySerial = dateSerial(today)
  const notifications = await listNotifications(user.id)
  const dedupeKeys = new Set(notifications.map((notification) => notification.dedupeKey).filter(Boolean))
  const maps = await listMaps()

  for (const summary of maps) {
    const map = await readMap(summary.id)
    if (!map || map.trashedAt) continue
    for (const node of map.nodes) {
      const dueSerial = dateSerial(node.data?.dueDate)
      const completed = Number(node.data?.progress) >= 100 || node.data?.status === 'done'
      if (!node.data?.isWork || node.data.assigneeId !== user.id || completed || dueSerial === null || todaySerial === null) continue
      const daysUntilDue = dueSerial - todaySerial
      if (daysUntilDue > 3) continue
      const timing = daysUntilDue < 0 ? 'overdue' : daysUntilDue === 0 ? 'today' : 'upcoming'
      const dedupeKey = `schedule:${map.id}:${node.id}:${today}:${timing}`
      if (dedupeKeys.has(dedupeKey)) continue
      const message = daysUntilDue < 0
        ? `마감일이 ${Math.abs(daysUntilDue)}일 지났습니다.`
        : daysUntilDue === 0 ? '오늘이 마감일입니다.' : `마감일까지 ${daysUntilDue}일 남았습니다.`
      await createNotification(user, {
        type: 'schedule',
        mapId: map.id,
        mapTitle: map.title,
        nodeId: node.id,
        nodeLabel: node.data.label,
        message,
        actor: systemUser,
        dedupeKey,
      })
      dedupeKeys.add(dedupeKey)
    }
  }
}

async function createWorkChangeNotifications(existing, map, actor, suppressedNodeIds = new Set()) {
  const previousNodes = new Map((existing?.nodes ?? []).map((node) => [node.id, node]))
  for (const node of map.nodes) {
    if (!node.data?.isWork) continue
    if (suppressedNodeIds.has(node.id)) continue
    const previous = previousNodes.get(node.id)
    const assigneeChanged = previous?.data?.assigneeId !== node.data.assigneeId
    const dueDateChanged = previous?.data?.dueDate !== node.data.dueDate
    const recipient = users.find((candidate) => candidate.id === node.data.assigneeId && candidate.role === 'editor' && candidate.active !== false)
    if (!recipient) continue

    if (assigneeChanged) {
      await createNotification(recipient, {
        type: 'assignment',
        mapId: map.id,
        mapTitle: map.title,
        nodeId: node.id,
        nodeLabel: node.data.label,
        message: node.data.dueDate ? `담당자로 지정되었습니다. 마감일 ${node.data.dueDate}` : '담당자로 지정되었습니다.',
        actor: publicUser(actor),
      })
    } else if (dueDateChanged && node.data.dueDate) {
      await createNotification(recipient, {
        type: 'schedule',
        mapId: map.id,
        mapTitle: map.title,
        nodeId: node.id,
        nodeLabel: node.data.label,
        message: `마감일이 ${node.data.dueDate}(으)로 변경되었습니다.`,
        actor: publicUser(actor),
      })
    }
  }
}

async function createWaitingReleaseNotifications(existing, map, actor, { includeActor = false } = {}) {
  const released = detectReleasedWaitingItems(existing?.nodes, map.nodes)
  for (const release of released) {
    const assignee = users.find((candidate) => candidate.id === release.assigneeId && candidate.role === 'editor' && candidate.active !== false)
    const recipients = (assignee ? [assignee] : users.filter((candidate) => candidate.role === 'editor' && candidate.active !== false))
      .filter((recipient) => includeActor || recipient.id !== actor.id)
    for (const recipient of recipients) {
      await createNotification(recipient, {
        type: 'waiting-released',
        mapId: map.id,
        mapTitle: map.title,
        nodeId: release.nodeId,
        nodeLabel: release.nodeLabel,
        message: `외부 대기 '${release.item.label}'이(가) 해제되었습니다.`,
        actor: publicUser(actor),
      })
    }
  }
}

function isValidRevisionId(revisionId) {
  return /^[a-z0-9-]{8,80}$/.test(revisionId)
}

function revisionDirectoryForMap(mapId) {
  if (!isValidMapId(mapId)) throw new Error('INVALID_MAP_ID')
  return path.join(historyDirectory, mapId)
}

function isValidDailyBackupDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
}

function dailyBackupDirectoryForMap(mapId) {
  if (!isValidMapId(mapId)) throw new Error('INVALID_MAP_ID')
  return path.join(dailyBackupDirectory, mapId)
}

function dailyBackupFileForMap(mapId, date) {
  if (!isValidDailyBackupDate(date)) throw new Error('INVALID_DAILY_BACKUP_DATE')
  return path.join(dailyBackupDirectoryForMap(mapId), `${date}.json`)
}

function mapContentSignature(map) {
  const normalized = normalizeMapForPersistence(map)
  return JSON.stringify({ title: normalized.title, color: normalized.color, nodes: normalized.nodes, edges: normalized.edges })
}

async function archiveMapRevision(map, user, reason) {
  if (!map || !isValidMap(map)) return null
  const revisionId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  const directory = revisionDirectoryForMap(map.id)
  await mkdir(directory, { recursive: true })
  const revision = {
    id: revisionId,
    mapId: map.id,
    archivedAt: new Date().toISOString(),
    archivedBy: publicUser(user),
    reason,
    map: {
      id: map.id,
      title: map.title,
      color: normalizeMapColor(map.color, defaultMapColor(map.id)),
      nodes: map.nodes,
      edges: map.edges,
      updatedAt: map.updatedAt ?? null,
      updatedBy: map.updatedBy ?? null,
      createdAt: map.createdAt ?? map.updatedAt ?? null,
      createdBy: map.createdBy ?? map.updatedBy ?? null,
      version: map.version ?? 1,
    },
  }
  const revisionFile = path.join(directory, `${revisionId}.json`)
  const temporaryFile = `${revisionFile}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(revision, null, 2)}\n`, 'utf8')
  await replaceFileWithRetry(temporaryFile, revisionFile)
  return revision
}

async function writeDailyBackup(map, user, reason = 'automatic', date = seoulDateString(), { overwrite = true } = {}) {
  if (!map || map.trashedAt || !isValidMap(map) || !isValidDailyBackupDate(date)) return null
  const directory = dailyBackupDirectoryForMap(map.id)
  const backupFile = dailyBackupFileForMap(map.id, date)
  if (!overwrite) {
    try {
      await stat(backupFile)
      return null
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  await mkdir(directory, { recursive: true })
  const backup = {
    date,
    mapId: map.id,
    backedUpAt: new Date().toISOString(),
    backedUpBy: publicUser(user),
    reason,
    map: {
      id: map.id,
      title: map.title,
      color: normalizeMapColor(map.color, defaultMapColor(map.id)),
      nodes: map.nodes,
      edges: map.edges,
      updatedAt: map.updatedAt ?? null,
      updatedBy: map.updatedBy ?? null,
      createdAt: map.createdAt ?? map.updatedAt ?? null,
      createdBy: map.createdBy ?? map.updatedBy ?? null,
      version: map.version ?? 1,
    },
  }
  const temporaryFile = `${backupFile}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(backup, null, 2)}\n`, 'utf8')
  await replaceFileWithRetry(temporaryFile, backupFile)
  return backup
}

function dailyBackupSummary(backup) {
  return {
    date: backup.date,
    mapId: backup.mapId,
    title: backup.map.title,
    color: backup.map.color,
    nodeCount: backup.map.nodes.length,
    backedUpAt: backup.backedUpAt,
    backedUpBy: backup.backedUpBy,
    reason: backup.reason,
    mapUpdatedAt: backup.map.updatedAt,
    mapUpdatedBy: backup.map.updatedBy,
  }
}

async function listDailyBackups(mapId) {
  const directory = dailyBackupDirectoryForMap(mapId)
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const backups = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && isValidDailyBackupDate(entry.name.slice(0, -5)))
      .map(async (entry) => JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'))))
    return backups
      .filter((backup) => backup?.mapId === mapId && isValidDailyBackupDate(backup.date) && isValidMap(backup.map))
      .sort((first, second) => String(second.date).localeCompare(String(first.date)))
      .map(dailyBackupSummary)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function readDailyBackup(mapId, date) {
  if (!isValidDailyBackupDate(date)) return null
  try {
    const backup = JSON.parse(await readFile(dailyBackupFileForMap(mapId, date), 'utf8'))
    return backup?.mapId === mapId && backup.date === date && isValidMap(backup.map)
      ? { ...backup, map: normalizeMapForPersistence(backup.map) }
      : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function ensureDailyBackups() {
  const summaries = await listMaps()
  let created = 0
  for (const summary of summaries) {
    const map = await readMap(summary.id)
    if (!map || map.trashedAt) continue
    const backup = await writeDailyBackup(map, systemUser, 'scheduled', seoulDateString(), { overwrite: false })
    if (backup) created += 1
  }
  return created
}

async function backfillDailyBackupsFromHistory() {
  const summaries = await listMaps()
  let created = 0
  for (const summary of summaries) {
    const map = await readMap(summary.id)
    if (!map || map.trashedAt) continue
    const revisions = await readAllMapRevisions(map.id)
    const latestByDate = new Map()
    for (const revision of revisions) {
      const snapshotAt = new Date(revision.map.updatedAt ?? revision.archivedAt)
      if (!Number.isFinite(snapshotAt.getTime())) continue
      const date = seoulDateString(snapshotAt)
      const previous = latestByDate.get(date)
      if (!previous || snapshotAt > previous.snapshotAt) latestByDate.set(date, { revision, snapshotAt })
    }
    const currentSnapshotAt = new Date(map.updatedAt ?? Date.now())
    if (Number.isFinite(currentSnapshotAt.getTime())) {
      const date = seoulDateString(currentSnapshotAt)
      const previous = latestByDate.get(date)
      if (!previous || currentSnapshotAt > previous.snapshotAt) latestByDate.set(date, {
        revision: { map, archivedBy: map.updatedBy ?? systemUser },
        snapshotAt: currentSnapshotAt,
      })
    }
    for (const [date, { revision }] of latestByDate) {
      const backup = await writeDailyBackup(revision.map, revision.archivedBy ?? systemUser, 'history-backfill', date, { overwrite: false })
      if (backup) created += 1
    }
  }
  return created
}

async function readAllMapRevisions(mapId) {
  const directory = revisionDirectoryForMap(mapId)
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const revisions = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && isValidRevisionId(entry.name.slice(0, -5)))
      .map(async (entry) => JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'))))
    return revisions.filter((revision) => revision?.mapId === mapId && isValidMap(revision.map))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function revisionSummary(revision) {
  return {
    id: revision.id,
    mapId: revision.mapId,
    title: revision.map.title,
    color: revision.map.color,
    nodeCount: revision.map.nodes.length,
    archivedAt: revision.archivedAt,
    archivedBy: revision.archivedBy,
    reason: revision.reason,
    mapUpdatedAt: revision.map.updatedAt,
    mapUpdatedBy: revision.map.updatedBy,
  }
}

async function listMapRevisions(mapId, { offset = 0, limit = 50 } = {}) {
  const directory = revisionDirectoryForMap(mapId)
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const revisions = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && isValidRevisionId(entry.name.slice(0, -5)))
      .map(async (entry) => JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'))))
    const summaries = revisions
      .filter((revision) => revision?.mapId === mapId && isValidMap(revision.map))
      .sort((first, second) => String(second.archivedAt).localeCompare(String(first.archivedAt)))
      .map(revisionSummary)
    const page = summaries.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    return {
      revisions: page,
      hasMore: nextOffset < summaries.length,
      nextOffset: nextOffset < summaries.length ? nextOffset : null,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { revisions: [], hasMore: false, nextOffset: null }
    throw error
  }
}

async function readMapRevision(mapId, revisionId) {
  if (!isValidRevisionId(revisionId)) return null
  try {
    const revision = JSON.parse(await readFile(path.join(revisionDirectoryForMap(mapId), `${revisionId}.json`), 'utf8'))
    return revision?.mapId === mapId && isValidMap(revision.map)
      ? { ...revision, map: normalizeMapForPersistence(revision.map) }
      : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function saveMap(mapId, map, user, title, color, revisionReason = 'edit', {
  sharedKnowledgeReviewRequests = new Map(),
  expectedVersion = null,
  validatePayload = null,
} = {}) {
  await mkdir(dataDirectory, { recursive: true })
  const existing = await readMap(mapId)
  if (Number.isInteger(expectedVersion) && existing?.version !== expectedVersion) {
    const error = new Error('다른 사용자가 먼저 문서를 변경했습니다.')
    error.code = 'VERSION_CONFLICT'
    error.currentVersion = existing?.version ?? null
    throw error
  }
  const now = new Date().toISOString()
  const normalizedMap = reconcileSharedKnowledgeReviews(
    existing,
    normalizeSharedKnowledgeMetadata(existing, normalizeMapForPersistence(map), user, now),
    {
      reviewRequests: sharedKnowledgeReviewRequests,
      reviewer: publicUser(user),
      reviewedAt: now,
    },
  )
  const payload = {
    nodes: normalizedMap.nodes,
    edges: normalizeMapEdges(normalizedMap).edges,
    id: mapId,
    title: normalizeTitle(title, existing?.title ?? '새 마인드맵'),
    color: normalizeMapColor(color, normalizeMapColor(existing?.color, defaultMapColor(mapId))),
    createdAt: existing?.createdAt ?? now,
    createdBy: existing?.createdBy ?? publicUser(user),
    updatedAt: now,
    updatedBy: publicUser(user),
    version: (existing?.version ?? 0) + 1,
  }
  if (validatePayload) validatePayload(payload)
  if (existing && mapContentSignature(existing) === mapContentSignature(payload)) return existing
  if (existing && !existing.trashedAt) {
    await archiveMapRevision(existing, user, revisionReason)
  }
  await writeStoredMap(mapId, payload)
  try {
    await writeDailyBackup(payload, user, 'automatic')
  } catch (error) {
    console.warn(`[Daily backup] ${mapId} 백업을 저장하지 못했습니다.`, error)
  }
  return payload
}

async function trashMap(mapId, user) {
  const map = await readMap(mapId)
  if (!map || map.trashedAt) return null
  const payload = {
    ...map,
    trashedAt: new Date().toISOString(),
    trashedBy: publicUser(user),
  }
  await writeStoredMap(mapId, payload)
  return payload
}

async function restoreMap(mapId, user) {
  const map = await readMap(mapId)
  if (!map?.trashedAt) return null
  const payload = {
    ...map,
    updatedAt: new Date().toISOString(),
    updatedBy: publicUser(user),
  }
  delete payload.trashedAt
  delete payload.trashedBy
  await writeStoredMap(mapId, payload)
  return payload
}

async function permanentlyDeleteTrashedMaps(mapIds) {
  const uniqueMapIds = [...new Set(mapIds)]
  const maps = await Promise.all(uniqueMapIds.map((mapId) => readMap(mapId)))
  if (maps.some((map) => !map?.trashedAt)) return null

  await Promise.all(uniqueMapIds.flatMap((mapId) => [
    rm(mapFileForId(mapId), { force: true }),
    rm(commentFileForMap(mapId), { force: true }),
    rm(revisionDirectoryForMap(mapId), { recursive: true, force: true }),
    rm(dailyBackupDirectoryForMap(mapId), { recursive: true, force: true }),
    rm(imageAssetsDirectoryForMap(mapId), { recursive: true, force: true }),
  ]))

  const deletedMapIds = new Set(uniqueMapIds)
  const notificationEntries = await readdir(notificationsDirectory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(notificationEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const filePath = path.join(notificationsDirectory, entry.name)
      const notifications = await readStoredArray(filePath).catch(() => null)
      if (!notifications) return
      const remaining = notifications.filter((notification) => !deletedMapIds.has(notification.mapId))
      if (remaining.length !== notifications.length) await writeStoredArray(filePath, remaining)
    }))

  const remainingMaps = await listMaps()
  await reconcileDocumentLayout(remainingMaps.map((map) => map.id))
  return uniqueMapIds
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

async function serveStatic(request, response, pathname) {
  let requestedPath = pathname === '/' ? '/index.html' : pathname
  let filePath = path.resolve(distDirectory, `.${requestedPath}`)
  if (!filePath.startsWith(distDirectory)) return false

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return false
  } catch {
    if (!path.extname(requestedPath)) filePath = path.join(distDirectory, 'index.html')
    else return false
  }

  try {
    const content = await readFile(filePath)
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(content)
    return true
  } catch {
    return false
  }
}

integrationToken = await loadIntegrationToken()
const adminBootstrapped = await loadUsers()
await loadSessions()
await loadAiAttributions()
await loadAiConversationAttributions()
await loadAiConversationOrigins()
await loadAiDelegations()
await loadAiWorkspaceHistories()
try {
  if (await workspacePoolManager.initialize()) {
    console.log(`[Mind & Progress] AI 작업공간 pool registry를 불러왔습니다: ${workspacePoolRegistryFile}`)
    await reconcileAiDelegationWorkspaceLeases()
  }
} catch (error) {
  console.warn('[AI workspace pool startup]', error)
}
await recoverAiConversationOrigins()
const metadataMigration = await migrateStoredMapCreationMetadata()
if (metadataMigration.migratedDocuments > 0) {
  console.log(`[Mind & Progress] 문서 ${metadataMigration.migratedDocuments}개에 생성자와 생성 시각을 복원했습니다.`)
}
const edgeMigration = await migrateStoredMapEdges()
if (edgeMigration.migratedDocuments > 0) {
  console.log(`[Mind & Progress] 베지어 화살표로 문서 ${edgeMigration.migratedDocuments}개, 연결선 ${edgeMigration.migratedEdges}개를 변환했습니다.`)
}
const dailyBackupMigrationCount = await backfillDailyBackupsFromHistory()
if (dailyBackupMigrationCount > 0) {
  console.log(`[Mind & Progress] 기존 변경 이력에서 일일 백업 ${dailyBackupMigrationCount}개를 복원했습니다.`)
}
const initialDailyBackupCount = await ensureDailyBackups()
if (initialDailyBackupCount > 0) {
  console.log(`[Mind & Progress] 오늘의 일일 백업 ${initialDailyBackupCount}개를 생성했습니다.`)
}
if (adminBootstrapped) {
  console.log(`[Mind & Progress] 초기 관리자 이메일: ${bootstrapAdminEmail}`)
  if (generatedAdminPassword) {
    console.log(`[Mind & Progress] 최초 실행 임시 관리자 비밀번호: ${generatedAdminPassword}`)
  } else {
    console.log('[Mind & Progress] MNP_ADMIN_PASSWORD 환경변수로 초기 관리자 계정을 생성했습니다.')
  }
  console.log('[Mind & Progress] 로그인 후 즉시 비밀번호를 변경해 주세요.')
}

const server = createServer(async (request, response) => {
  const loopbackLocation = localLoopbackRedirectLocation(request)
  if (loopbackLocation) {
    response.writeHead(307, {
      Location: loopbackLocation,
      'Cache-Control': 'no-store',
    })
    response.end()
    return
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        status: 'ok',
        publicBaseUrl,
        aionUiWebBaseUrl,
        aionUiWebConfigured: Boolean(configuredAionUiWebBaseUrl),
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/integrations/aionui/conversation-attribution/resolve') {
      if (!hasValidIntegrationBearer(request)) {
        return sendJson(response, 401, { error: '올바른 MindNProgress 연동 토큰이 필요합니다.' })
      }
      const scope = integrationRequestScope(request)
      if (!validAiConversationId(scope.conversationId)) {
        return sendJson(response, 400, {
          error: '현재 AionUi 대화 ID를 확인할 수 없습니다.',
          code: 'AI_ATTRIBUTION_CONVERSATION_REQUIRED',
        })
      }
      if (Boolean(scope.mapId) !== Boolean(scope.cardId)) {
        return sendJson(response, 400, {
          error: 'AI 작성자 귀속 범위를 지정하려면 문서와 카드 ID를 함께 보내야 합니다.',
          code: 'AI_ATTRIBUTION_SCOPE_REQUIRED',
        })
      }
      if (scope.mapId) {
        if (!isValidMapId(scope.mapId)) {
          return sendJson(response, 400, {
            error: 'AI 작성자 귀속을 확인할 문서 ID가 올바르지 않습니다.',
            code: 'AI_ATTRIBUTION_SCOPE_REQUIRED',
          })
        }
        const map = await readMap(scope.mapId)
        if (!map || map.trashedAt || !map.nodes.some((node) => node.id === scope.cardId)) {
          return sendJson(response, 404, {
            error: 'AI 작성자 귀속을 확인할 문서 또는 카드를 찾을 수 없습니다.',
            code: 'AI_ATTRIBUTION_SCOPE_NOT_FOUND',
          })
        }
      }
      const editor = scope.editorId
        ? users.find((candidate) => candidate.id === scope.editorId && candidate.active !== false && canEdit(candidate))
        : null
      if (scope.editorId && !editor) {
        return sendJson(response, 403, {
          error: 'AI 작성자 귀속에 지정된 편집자 계정을 사용할 수 없습니다.',
          code: 'AI_ATTRIBUTION_EDITOR_NOT_FOUND',
        })
      }

      try {
        const existing = resolveScopedAttribution(
          scope,
          [...aiAttributions.values()],
          aiConversationAttributions,
        ).attribution
        const attribution = existing ?? await resolveConversationAttribution(
          scope.mapId,
          scope.cardId,
          scope.conversationId,
          editor?.id ?? null,
          null,
          { inferStartedBy: false },
        )
        const attributionToken = randomBytes(32).toString('base64url')
        const now = Date.now()
        const expiresAt = now + aiAttributionDurationMs
        aiAttributions.set(sessionTokenKey(attributionToken), {
          ...attribution,
          createdAt: now,
          expiresAt,
        })
        await persistAiAttributions()
        console.log('[AI attribution]', JSON.stringify({
          source: existing ? 'conversation-preflight-existing' : 'conversation-preflight',
          mapId: scope.mapId,
          cardId: scope.cardId,
          editorId: editor?.id ?? null,
          conversationId: scope.conversationId,
          actorId: editor?.id ?? integrationUser.id,
          authorName: attribution.authorName,
          tokenHashPrefix: sessionTokenKey(attributionToken).slice(0, 12),
        }))
        return sendJson(response, 201, {
          attributionToken,
          authorName: attribution.authorName,
          editorId: editor?.id ?? null,
          conversationId: scope.conversationId,
          expiresAt,
        })
      } catch (error) {
        console.warn('[AionUi conversation attribution preflight]', JSON.stringify({
          mapId: scope.mapId,
          cardId: scope.cardId,
          editorId: scope.editorId || null,
          conversationId: scope.conversationId,
          error: error?.message ?? String(error),
        }))
        return sendJson(response, 503, {
          error: 'AionUi에서 현재 대화의 AI 종류와 모델을 확인하지 못했습니다.',
          code: 'AI_ATTRIBUTION_UNRESOLVED',
        })
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJsonBody(request)
      const user = users.find((candidate) => candidate.email.toLowerCase() === String(body.email ?? '').toLowerCase())
      const suppliedHash = user ? hashPassword(String(body.password ?? ''), user.salt) : hashPassword(String(body.password ?? ''), 'invalid-user')
      if (!user || user.active === false || isPublicViewer(user) || !timingSafeEqual(user.passwordHash, suppliedHash)) {
        return sendJson(response, 401, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' })
      }

      const token = randomBytes(32).toString('base64url')
      const rememberMe = body.rememberMe === true
      const durationMs = rememberMe ? rememberedSessionDurationMs : sessionDurationMs
      const expiresAt = Date.now() + durationMs
      sessions.set(sessionTokenKey(token), { userId: user.id, expiresAt, persistent: rememberMe })
      if (rememberMe) await persistSessions()
      user.lastLoginAt = new Date().toISOString()
      user.updatedAt = user.updatedAt ?? user.lastLoginAt
      await persistUsers()
      return sendJson(response, 200, { user: publicUser(user), rememberMe, expiresAt }, {
        'Set-Cookie': [
          `mnp_session=${token}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Strict',
          ...(rememberMe ? [`Max-Age=${rememberedSessionDurationMs / 1000}`] : []),
        ].join('; '),
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/viewer-access') {
      const viewer = users.find((candidate) => candidate.id === 'user-public-viewer' && isPublicViewer(candidate) && candidate.active !== false)
      if (!viewer) return sendJson(response, 503, { error: '공개 뷰어 계정이 준비되지 않았습니다.' })
      const token = randomBytes(32).toString('base64url')
      sessions.set(sessionTokenKey(token), { userId: viewer.id, expiresAt: Date.now() + sessionDurationMs, persistent: false })
      return sendJson(response, 200, { user: publicUser(viewer) }, {
        'Set-Cookie': `mnp_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDurationMs / 1000}`,
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      const user = getCurrentUser(request)
      return sendJson(response, 200, { user: user ? publicUser(user) : null })
    }

    if (request.method === 'POST' && url.pathname === '/api/integrations/dooray/task-preview') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 Dooray 업무를 추가할 수 있습니다.' })
      const body = await readJsonBody(request)
      try {
        const parsed = parseDoorayTaskUrl(body.url)
        const task = await fetchDoorayTaskPreview(parsed, await getDoorayApiConfig())
        return sendJson(response, 200, { task })
      } catch (error) {
        if (error instanceof DoorayTaskError) return sendJson(response, error.status, { error: error.message, code: error.code })
        throw error
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/integrations/dooray/wiki-preview') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 Dooray Wiki를 추가할 수 있습니다.' })
      const body = await readJsonBody(request)
      try {
        const parsed = parseDoorayWikiUrl(body.url)
        const wiki = await fetchDoorayWikiPreview(parsed, await getDoorayApiConfig())
        return sendJson(response, 200, { wiki })
      } catch (error) {
        if (error instanceof DoorayTaskError) return sendJson(response, error.status, { error: error.message, code: error.code })
        throw error
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/integrations/dooray/task-titles') {
      const user = requireUser(request, response)
      if (!user) return
      const body = await readJsonBody(request)
      if (!Array.isArray(body.urls) || body.urls.length === 0 || body.urls.length > doorayTaskTitleBatchLimit) {
        return sendJson(response, 400, { error: `Dooray 업무 URL은 한 번에 1~${doorayTaskTitleBatchLimit}개까지 조회할 수 있습니다.` })
      }

      let tasks
      try {
        const parsedTaskMap = new Map()
        body.urls.forEach((taskUrl) => {
          const parsed = parseDoorayTaskUrl(taskUrl)
          if (!parsedTaskMap.has(parsed.labelKey)) parsedTaskMap.set(parsed.labelKey, parsed)
        })
        const parsedTasks = [...parsedTaskMap.values()]
        const config = await getDoorayApiConfig()
        const taskRequests = new Map()
        const getTask = (parsed) => {
          if (!taskRequests.has(parsed.key)) taskRequests.set(parsed.key, resolveDoorayTaskPreview(parsed, config))
          return taskRequests.get(parsed.key)
        }
        tasks = (await Promise.all(parsedTasks.map(async (parsed) => {
          try {
            const task = await getTask(parsed)
            const comment = await resolveDoorayComment(parsed, task, config).catch(() => null)
            return {
              key: parsed.labelKey,
              url: parsed.url,
              title: task.subject,
              ...(parsed.commentId ? { comment: comment ?? { id: parsed.commentId, authorName: '' } } : {}),
            }
          } catch (error) {
            if (error instanceof DoorayTaskError) return null
            throw error
          }
        }))).filter(Boolean)
      } catch (error) {
        if (error instanceof DoorayTaskError) return sendJson(response, error.status, { error: error.message, code: error.code })
        throw error
      }
      return sendJson(response, 200, { tasks })
    }

    if (request.method === 'GET' && url.pathname === '/api/integrations/aionui/subscription-usage') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 구독 사용량을 확인할 수 있습니다.' })
      const usage = await readAionUiSubscriptionUsage(aionUiSubscriptionUsageFile, {
        readText: (filePath) => readFile(filePath, 'utf8'),
        staleAfterMs: aionUiSubscriptionUsageStaleAfterMs,
      })
      return sendJson(response, 200, { usage })
    }

    if (request.method === 'GET' && url.pathname === '/api/users') {
      const user = requireUser(request, response)
      if (!user) return
      return sendJson(response, 200, { users: users.filter((candidate) => candidate.active !== false && !isPublicViewer(candidate)).map(publicUser) })
    }

    if (request.method === 'GET' && url.pathname === '/api/assignees') {
      const user = requireUser(request, response)
      if (!user) return
      return sendJson(response, 200, { users: users.filter((candidate) => candidate.role === 'editor').map(accountUser) })
    }

    if (request.method === 'POST' && url.pathname === '/api/integrations/aionui/attributions') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 대화를 시작할 수 있습니다.' })
      const body = await readJsonBody(request)
      const agentId = String(body.agentId ?? '').trim().slice(0, 120)
      const modelId = String(body.modelId ?? '').trim().slice(0, 240)
      const providerId = String(body.providerId ?? '').trim().slice(0, 120)
      const mapId = String(body.mapId ?? '').trim().slice(0, 120)
      const cardId = String(body.cardId ?? '').trim().slice(0, 120)
      const purpose = body.purpose === undefined ? 'card' : String(body.purpose).trim()
      if (!agentId || !modelId || !isValidMapId(mapId) || !cardId) {
        return sendJson(response, 400, { error: 'AI 종류, 모델, 문서와 카드를 모두 지정해 주세요.' })
      }
      if (!isAiConversationPurpose(purpose)) {
        return sendJson(response, 400, { error: 'AI 대화 용도가 올바르지 않습니다.' })
      }
      const map = await readMap(mapId)
      if (!map || map.trashedAt || !map.nodes.some((node) => node.id === cardId)) {
        return sendJson(response, 404, { error: 'AI 대화를 시작할 문서 또는 카드를 찾을 수 없습니다.' })
      }
      if (purpose === 'shared-knowledge-review') {
        try {
          buildSharedKnowledgeReviewContext(map, cardId)
        } catch (error) {
          if (sendSharedKnowledgeMaintenanceError(response, error)) return
          throw error
        }
      }

      try {
        const [agents, providers, skills, mcpServers] = await Promise.all([
          fetchAionUi('/api/agents/management'),
          fetchAionUi('/api/providers'),
          fetchAionUi('/api/skills'),
          fetchAionUi('/api/mcp/servers'),
        ])
        const normalizedAgents = (Array.isArray(agents) ? agents : [])
          .filter((agent) => agent?.enabled !== false && agent?.installed === true)
          .map((agent) => normalizeAionUiAgent(agent, Array.isArray(providers) ? providers.filter((item) => item?.enabled !== false) : []))
        const normalizedSkills = normalizeAionUiSkills(skills)
        const normalizedMcpServers = normalizeAionUiMcpServers(mcpServers)
        const agent = normalizedAgents.find((candidate) => candidate.id === agentId)
        const model = agent?.models.find((candidate) => candidate.id === modelId
          && (!providerId || !candidate.providerId || candidate.providerId === providerId))
        if (!agent || !model) return sendJson(response, 400, { error: '선택한 AI 종류 또는 모델을 AionUi에서 확인할 수 없습니다.' })

        const agentName = agent.name.replace(/\s+/g, ' ').trim().slice(0, 80) || agent.id
        const modelName = model.label.replace(/\s+/g, ' ').trim().slice(0, 120) || model.id
        const authorName = `${agentName}(${modelName})`
        const attributionToken = randomBytes(32).toString('base64url')
        const completionToken = randomBytes(32).toString('base64url')
        const expiresAt = Date.now() + aiAttributionDurationMs
        for (const [tokenKey, attribution] of aiAttributions) {
          if (attribution.expiresAt <= Date.now()) aiAttributions.delete(tokenKey)
        }
        for (const [tokenKey, launch] of aiConversationLaunches) {
          if (launch.expiresAt <= Date.now()) aiConversationLaunches.delete(tokenKey)
        }
        aiAttributions.set(sessionTokenKey(attributionToken), {
          authorName,
          agentId: agent.id,
          agentName,
          modelId: model.id,
          modelName,
          providerId: model.providerId ?? null,
          mapId,
          cardId,
          startedBy: user.id,
          selection: aiConversationSelectionSnapshot(body, agent, model, normalizedSkills, normalizedMcpServers),
          createdAt: Date.now(),
          expiresAt,
        })
        aiConversationLaunches.set(sessionTokenKey(completionToken), {
          attributionKey: sessionTokenKey(attributionToken),
          mapId,
          cardId,
          purpose,
          startedBy: user.id,
          expiresAt,
        })
        const completionUrl = `http://127.0.0.1:${port}/api/integrations/aionui/launches/${completionToken}/conversation`
        await persistAiAttributions()
        console.log('[AI attribution]', JSON.stringify({
          source: 'created', mapId, cardId, actorId: user.id, authorName,
          tokenHashPrefix: sessionTokenKey(attributionToken).slice(0, 12),
        }))
        return sendJson(response, 201, { attributionToken, completionUrl, authorName, editorId: user.id, expiresAt })
      } catch (error) {
        console.error('[AionUi attribution]', error)
        return sendJson(response, 503, { error: 'AionUi에서 선택한 AI 정보를 확인할 수 없습니다.' })
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/integrations/aionui/external-conversation-launches') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 대화를 시작할 수 있습니다.' })

      try {
        const payload = normalizeAionUiExternalLaunchPayload(await readJsonBody(request))
        const completionToken = parseMindNProgressCompletionToken(payload.completionUrl, port)
        if (!completionToken) {
          return sendJson(response, 400, { error: 'AI 대화 완료 통보 주소가 올바르지 않습니다.' })
        }

        const launch = aiConversationLaunches.get(sessionTokenKey(completionToken))
        if (!launch || launch.expiresAt <= Date.now()) {
          if (launch) aiConversationLaunches.delete(sessionTokenKey(completionToken))
          return sendJson(response, 404, { error: 'AI 대화 시작 정보를 찾을 수 없습니다. 다시 시도해 주세요.' })
        }
        if (launch.startedBy !== user.id) {
          return sendJson(response, 403, { error: '다른 편집자의 AI 대화 시작 정보는 사용할 수 없습니다.' })
        }

        const attribution = aiAttributions.get(launch.attributionKey)
        if (!attribution
          || attribution.agentId !== payload.agentId
          || attribution.modelId !== payload.modelId
          || (payload.providerId && attribution.providerId && attribution.providerId !== payload.providerId)) {
          return sendJson(response, 409, { error: 'AI 종류와 모델 정보가 작성자 귀속 정보와 일치하지 않습니다.' })
        }

        const ticket = await fetchAionUi('/api/internal/external-conversation-launches', {
          method: 'POST',
          body: payload,
        })
        const launchUrl = createAionUiWebLaunchUrl(aionUiWebBaseUrl, ticket?.launchId)
        return sendJson(response, 201, {
          launchId: ticket.launchId,
          expiresAt: ticket.expiresAt ?? null,
          launchUrl,
        })
      } catch (error) {
        if (error instanceof AionUiExternalLaunchPayloadError) {
          return sendJson(response, 400, { error: error.message })
        }
        console.error('[AionUi external conversation launch]', error)
        return sendJson(response, 503, { error: 'AionUi WebUI 대화 시작 정보를 발급하지 못했습니다.' })
      }
    }

    const aionUiLaunchCompletionRoute = url.pathname.match(/^\/api\/integrations\/aionui\/launches\/([^/]+)\/conversation$/)
    if (aionUiLaunchCompletionRoute && request.method === 'POST') {
      const tokenKey = sessionTokenKey(decodeURIComponent(aionUiLaunchCompletionRoute[1]))
      const launch = aiConversationLaunches.get(tokenKey)
      if (!launch || launch.expiresAt <= Date.now()) {
        aiConversationLaunches.delete(tokenKey)
        return sendJson(response, 404, { error: 'AI 대화 시작 정보를 찾을 수 없습니다.' })
      }
      const body = await readJsonBody(request)
      const conversationId = String(body.conversationId ?? '').trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(conversationId)) {
        return sendJson(response, 400, { error: '올바르지 않은 AionUi 대화 ID입니다.' })
      }

      try {
        const conversation = await fetchAionUi(`/api/conversations/${encodeURIComponent(conversationId)}`)
        if (!conversation || conversation.id !== conversationId) {
          return sendJson(response, 409, { error: '생성된 AionUi 대화를 확인할 수 없습니다.' })
        }
        const map = await readMap(launch.mapId)
        const targetNode = map?.nodes.find((node) => node.id === launch.cardId)
        if (!map || map.trashedAt || !targetNode) {
          aiConversationLaunches.delete(tokenKey)
          return sendJson(response, 404, { error: 'AI 대화를 연결할 문서 또는 카드를 찾을 수 없습니다.' })
        }
        const attribution = aiAttributions.get(launch.attributionKey)
        if (attribution) {
          attribution.conversationId = conversationId
          await persistAiAttributions()
        }
        if (launch.purpose === 'shared-knowledge-review') {
          aiConversationLaunches.delete(tokenKey)
          return sendJson(response, 200, {
            conversationId,
            linked: false,
            purpose: launch.purpose,
          })
        }

        const actor = users.find((candidate) => candidate.id === launch.startedBy) ?? integrationUser
        const selection = attribution?.selection ?? {
          agent: attribution?.agentId ? { id: attribution.agentId, label: attribution.agentName ?? attribution.agentId } : null,
          model: attribution?.modelId ? { id: attribution.modelId, label: attribution.modelName ?? attribution.modelId } : null,
          providerId: attribution?.providerId ?? null,
          skills: [],
          mcpServers: [],
        }
        const conversationLink = normalizeAiConversationLink({
          conversationId,
          ...selection,
          startedBy: { id: actor.id, label: actor.name },
          startedAt: normalizedIsoDate(conversation.created_at),
          linkedAt: new Date().toISOString(),
        })
        const updatedMap = await saveMap(launch.mapId, {
          nodes: map.nodes.map((node) => node.id === launch.cardId
            ? {
                ...node,
                data: {
                  ...node.data,
                  aiConversationId: conversationId,
                  aiConversations: appendAiConversationLink(node.data, conversationLink),
                },
              }
            : node),
          edges: map.edges,
        }, actor, map.title, map.color, 'content')
        rememberAiConversationOrigin({
          conversationId,
          mapId: launch.mapId,
          cardId: launch.cardId,
          startedBy: launch.startedBy,
          linkedAt: conversationLink.startedAt ?? conversationLink.linkedAt,
          workspace: conversationLink.workspace,
          workspacePoolId: workspacePoolManager.poolForWorkspace(conversationLink.workspace)?.poolId ?? null,
        })
        await persistAiConversationOrigins()
        if (attribution) {
          try {
            await refreshConversationAttribution(launch.mapId, launch.cardId, conversationId, launch.startedBy, attribution)
          } catch (error) {
            const fallbackAttribution = {
              mapId: launch.mapId,
              cardId: launch.cardId,
              conversationId,
              authorName: attribution.authorName,
              agentId: attribution.agentId,
              agentName: attribution.agentName,
              modelId: attribution.modelId,
              modelName: attribution.modelName,
              providerId: attribution.providerId ?? null,
              startedBy: launch.startedBy,
              linkedAt: normalizedIsoDate(conversation.created_at),
              refreshedAt: new Date().toISOString(),
            }
            aiConversationAttributions.set(conversationAttributionKey(launch.mapId, launch.cardId), fallbackAttribution)
            await persistAiConversationAttributions()
            console.warn('[AI conversation attribution link]', error)
          }
        }
        aiConversationLaunches.delete(tokenKey)
        broadcastEvent({
          type: 'ai-conversation-linked',
          mapId: launch.mapId,
          nodeId: launch.cardId,
          conversationId,
          conversation: conversationLink,
          sourceClientId: null,
          updatedAt: updatedMap.updatedAt,
          updatedBy: publicUser(actor),
        })
        void refreshAiConversationRuntimeForMap(launch.mapId).catch((error) => {
          console.warn('[AI conversation runtime link refresh]', error)
        })
        return sendJson(response, 200, { conversationId })
      } catch (error) {
        console.error('[AionUi conversation completion]', error)
        return sendJson(response, 503, { error: '생성된 AionUi 대화를 확인하지 못했습니다.' })
      }
    }

    const aionUiConversationTranscriptRoute = url.pathname.match(/^\/api\/integrations\/aionui\/conversations\/([^/]+)\/transcript$/)

    const aiDelegationsRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/ai-delegations$/)
    const aiDelegationCompletionRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/ai-delegations\/complete$/)
    const aiDelegationRecoveryRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/ai-delegations\/([^/]+)\/recover$/)
    const aiWorkspacesRoute = url.pathname === '/api/ai-workspaces'
    const aiWorkspaceCheckpointRoute = url.pathname.match(/^\/api\/ai-workspaces\/([^/]+)\/checkpoint$/)

    if (aiWorkspacesRoute && request.method === 'GET') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 작업공간 풀을 조회할 수 있습니다.' })
      const scope = integrationRequestScope(request)
      return sendJson(response, 200, workspacePoolManager.publicSnapshot({
        conversationId: scope.conversationId,
      }))
    }

    if (aiWorkspaceCheckpointRoute && request.method === 'POST') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 작업공간 체크포인트를 생성할 수 있습니다.' })
      const leaseId = decodeURIComponent(aiWorkspaceCheckpointRoute[1])
      const scope = integrationRequestScope(request)
      const source = scope.mapId && scope.conversationId
        ? delegationSourceForRequest(scope, scope.mapId)
        : null
      if (scope.conversationId && !source) {
        return sendJson(response, 409, {
          error: '현재 AionUi 대화가 시작된 MindNProgress 카드를 확인할 수 없습니다.',
          code: 'AI_WORKSPACE_CHECKPOINT_ORIGIN_NOT_FOUND',
          conversationId: scope.conversationId,
        })
      }
      if (source && scope.cardId && scope.cardId !== source.cardId) {
        return sendJson(response, 409, {
          error: '현재 MCP 범위와 AionUi 대화의 시작 카드가 일치하지 않습니다.',
          code: 'AI_WORKSPACE_CHECKPOINT_ORIGIN_MISMATCH',
          conversationId: scope.conversationId,
          sourceCardId: source.cardId,
        })
      }
      const checkpointCardId = source?.cardId ?? scope.cardId
      if (!scope.mapId || !checkpointCardId) {
        return sendJson(response, 400, {
          error: '현재 AI 대화의 문서와 카드 범위가 필요합니다.',
          code: 'AI_WORKSPACE_CHECKPOINT_SCOPE_REQUIRED',
        })
      }
      const body = await readJsonBody(request)
      const paths = Array.isArray(body.paths) ? body.paths : []
      const confirmNoChanges = body.confirmNoChanges === true
      if (!body.jobId || paths.length > 2_000) {
        return sendJson(response, 400, {
          error: '현재 jobId와 체크포인트에 포함할 변경 경로가 필요합니다.',
          code: 'AI_WORKSPACE_CHECKPOINT_INPUT_INVALID',
        })
      }
      if (confirmNoChanges && (paths.length > 0 || body.commitMessage !== undefined)) {
        return sendJson(response, 400, {
          error: '무변경 확인에는 paths 또는 commitMessage를 전달할 수 없습니다.',
          code: 'AI_WORKSPACE_CHECKPOINT_INPUT_INVALID',
        })
      }
      if (!confirmNoChanges && paths.length === 0) {
        return sendJson(response, 400, {
          error: '변경 체크포인트에는 한 개 이상의 paths가 필요합니다. 변경이 없다면 무변경 확인 도구를 사용하세요.',
          code: 'AI_WORKSPACE_CHECKPOINT_INPUT_INVALID',
        })
      }
      if (!confirmNoChanges && (!body.commitMessage || typeof body.commitMessage !== 'object')) {
        return sendJson(response, 400, {
          error: '변경 체크포인트에는 실제 변경을 설명하는 commitMessage가 필요합니다.',
          code: 'AI_WORKSPACE_CHECKPOINT_MESSAGE_REQUIRED',
          details: [{ commitMessage: checkpointCommitMessageExample }],
        })
      }
      let map = null
      try {
        map = await readMap(scope.mapId)
      } catch (error) {
        console.warn('[AI workspace checkpoint context]', error)
      }
      const card = map?.nodes.find((node) => node.id === checkpointCardId)
      try {
        const result = await workspacePoolManager.checkpoint(leaseId, {
          jobId: String(body.jobId),
          mapId: scope.mapId,
          cardId: checkpointCardId,
          conversationId: scope.conversationId,
          paths,
          confirmNoChanges,
          commitMessage: body.commitMessage,
          mnpContext: {
            mapId: scope.mapId,
            cardId: checkpointCardId,
            documentTitle: map?.title,
            cardTitle: card?.data?.label,
          },
        })
        return sendJson(response, result.noChanges ? 200 : 201, result)
      } catch (error) {
        if (error instanceof WorkspacePoolUnavailableError) {
          return sendJson(response, 409, {
            error: error.message,
            code: error.reasonCode ?? error.code,
            details: error.details,
          })
        }
        throw error
      }
    }

    if (aiDelegationCompletionRoute && request.method === 'POST') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 위임 완료를 확인할 수 있습니다.' })
      const mapId = decodeURIComponent(aiDelegationCompletionRoute[1])
      const scope = integrationRequestScope(request)
      if (!isValidMapId(mapId)
        || (scope.mapId && scope.mapId !== mapId)
        || !validAiConversationId(scope.conversationId)) {
        return sendJson(response, 400, {
          error: '현재 AI 대화의 문서와 대화 범위가 필요합니다.',
          code: 'AI_DELEGATION_COMPLETION_SCOPE_REQUIRED',
        })
      }
      const source = delegationSourceForRequest(scope, mapId)
      if (!source) {
        return sendJson(response, 409, {
          error: '현재 AionUi 대화가 시작된 MindNProgress 카드를 확인할 수 없습니다.',
          code: 'AI_DELEGATION_COMPLETION_ORIGIN_NOT_FOUND',
          conversationId: scope.conversationId,
        })
      }
      if (scope.cardId && scope.cardId !== source.cardId) {
        return sendJson(response, 409, {
          error: '현재 MCP 범위와 AionUi 대화의 시작 카드가 일치하지 않습니다.',
          code: 'AI_DELEGATION_COMPLETION_ORIGIN_MISMATCH',
          conversationId: scope.conversationId,
          sourceCardId: source.cardId,
        })
      }
      const targetCardId = source.cardId
      const map = await readMap(mapId)
      if (!map || map.trashedAt || !map.nodes.some((node) => node.id === targetCardId)) {
        return sendJson(response, 404, { error: 'AI 위임 완료 대상 문서 또는 카드를 찾지 못했습니다.' })
      }
      const candidates = explicitCompletionAiDelegationsForConversation(aiDelegations.values(), {
        mapId,
        targetCardId,
        targetConversationId: scope.conversationId,
      })
      if (candidates.length === 0) {
        return sendJson(response, 200, {
          accepted: false,
          required: false,
          state: 'not-required',
          instruction: '현재 카드와 AI 대화에는 명시적 완료 신호가 필요한 위임이 없습니다. 중단 없이 진행된 위임은 최종 답변을 마치면 자동으로 상위 AI에 보고됩니다.',
        })
      }
      if (candidates.length > 1) {
        return sendJson(response, 409, {
          error: '명시적 완료를 기다리는 AI 위임이 여러 개라 자동으로 선택할 수 없습니다.',
          code: 'AI_DELEGATION_EXPLICIT_COMPLETION_AMBIGUOUS',
          delegations: candidates.map(delegationPublicView),
        })
      }
      const delegation = candidates[0]
      const dispatchPath = `/api/internal/external-conversation-dispatches/${encodeURIComponent(delegation.childOperationId)}`
      try {
        const dispatch = await fetchAionUi(dispatchPath)
        const dispatchState = String(dispatch?.state ?? '').trim()
        if (dispatchState !== 'waiting_resume') {
          if (dispatchState === 'failed' || dispatchState === 'recovery_required') {
            const code = dispatchState === 'failed'
              ? 'AI_DELEGATION_CHILD_ALREADY_FAILED'
              : 'AI_DELEGATION_CHILD_RECOVERY_REQUIRED'
            return sendJson(response, 409, {
              error: dispatchState === 'failed'
                ? `현재 AI 위임은 이미 실패 상태라 완료 신호를 받을 수 없습니다. (${code})`
                : `현재 AI 위임은 복구가 필요한 상태라 완료 신호보다 위임 복구가 먼저 필요합니다. (${code})`,
              code,
              state: dispatchState,
              delegation: delegationPublicView(delegation),
            })
          }
          if (['starting', 'waiting_resource', 'running', 'completed'].includes(dispatchState)) {
            return sendJson(response, 200, {
              accepted: false,
              required: false,
              state: dispatchState,
              delegation: delegationPublicView(delegation),
              instruction: dispatchState === 'completed'
                ? '현재 위임은 이미 완료됐습니다. MindNProgress가 상위 AI 재개 상태를 동기화합니다.'
                : '현재 위임은 사용자 중지 후 재개를 기다리는 상태가 아니므로 별도 완료 신호가 필요하지 않습니다. 실제 작업의 최종 답변을 마치면 AionCore가 자동으로 완료를 확정하고 상위 AI에 보고합니다.',
            })
          }
          return sendJson(response, 409, {
            error: `AionCore가 알 수 없는 AI 위임 상태를 반환했습니다. (AI_DELEGATION_EXPLICIT_COMPLETION_STATE_UNKNOWN: ${dispatchState || 'empty'})`,
            code: 'AI_DELEGATION_EXPLICIT_COMPLETION_STATE_UNKNOWN',
            state: dispatchState || null,
            delegation: delegationPublicView(delegation),
          })
        }
        const confirmation = await fetchAionUi(
          `${dispatchPath}/complete`,
          {
            method: 'POST',
            body: { conversationId: scope.conversationId },
          },
        )
        const requestedAt = new Date().toISOString()
        const updated = await updateAiDelegation(delegation.id, {
          explicitCompletionRequestedAt: requestedAt,
          explicitCompletionTurnId: confirmation.turnId ?? null,
          explicitCompletionRequestedBy: user.id,
        })
        return sendJson(response, 202, {
          accepted: confirmation.accepted === true,
          required: true,
          turnId: confirmation.turnId ?? null,
          delegation: delegationPublicView(updated),
          instruction: '현재 턴의 최종 답변을 마치면 AionCore가 위임 완료를 확정하고 상위 AI 재개 절차를 진행합니다.',
        })
      } catch (error) {
        const code = error?.code ?? 'AI_DELEGATION_EXPLICIT_COMPLETION_FAILED'
        const turnNotActive = code === 'EXTERNAL_DISPATCH_COMPLETION_TURN_NOT_ACTIVE'
        return sendJson(response, error?.status === 404 ? 404 : 409, {
          error: turnNotActive
            ? `현재 AI 대화에 진행 중인 턴이 없어 완료 신호를 연결할 수 없습니다. 실제 작업 턴의 최종 답변 전에 호출하세요. (${code})`
            : `AionCore가 현재 AI 위임의 명시적 완료 신호를 받지 못했습니다. (${code})`,
          code,
        })
      }
    }

    if (aiDelegationRecoveryRoute && request.method === 'POST') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 위임을 복구할 수 있습니다.' })
      const mapId = decodeURIComponent(aiDelegationRecoveryRoute[1])
      const delegationId = decodeURIComponent(aiDelegationRecoveryRoute[2])
      const requestScope = integrationRequestScope(request)
      const source = delegationSourceForRequest(requestScope, mapId)
      if (!isValidMapId(mapId) || !isValidAiDelegationId(delegationId) || !source) {
        return sendJson(response, 400, { error: '복구할 AI 위임의 문서, 대화 또는 위임 ID가 올바르지 않습니다.' })
      }

      const delegation = aiDelegations.get(delegationId)
      if (!delegation || delegation.mapId !== mapId) {
        return sendJson(response, 404, { error: '복구할 AI 위임을 찾을 수 없습니다.' })
      }
      if (!await aionCoreSupportsExplicitCompletionAfterInterruption()) {
        return sendJson(response, 503, {
          error: '현재 실행 중인 AionCore가 중단 후 명시적 완료 신호를 지원하지 않습니다. AionCore를 최신 빌드로 재기동해 주세요.',
          code: 'AIONCORE_EXPLICIT_COMPLETION_UNAVAILABLE',
        })
      }
      if (delegation.parentCardId !== source.cardId
        || (source.conversationId && delegation.parentConversationId !== source.conversationId)) {
        return sendJson(response, 403, {
          error: '이 위임을 시작한 상위 카드와 AI 대화에서만 복구할 수 있습니다.',
          code: 'AI_DELEGATION_RECOVERY_ORIGIN_MISMATCH',
        })
      }
      if (!['recovery-required', 'integration-recovery-required'].includes(delegation.state)) {
        return sendJson(response, 409, {
          error: `현재 위임 상태(${delegation.state})는 명시적인 재시작 복구 대상이 아닙니다.`,
          code: 'AI_DELEGATION_RECOVERY_NOT_REQUIRED',
          delegation: delegationPublicView(delegation),
        })
      }

      const body = await readJsonBody(request)
      const instruction = String(body.instruction ?? '').trim()
      const sourceRevision = Number(body.sourceRevision)
      if (!instruction || instruction.length > 100_000
        || !Number.isInteger(sourceRevision) || sourceRevision < 1) {
        return sendJson(response, 400, { error: '복구 지시와 최신 문서 version이 필요합니다.' })
      }

      const map = await readMap(mapId)
      const parentCard = map?.nodes.find((node) => node.id === delegation.parentCardId)
      const targetCard = map?.nodes.find((node) => node.id === delegation.targetCardId)
      if (!map || map.trashedAt || !parentCard || !targetCard) {
        return sendJson(response, 404, { error: '상위 카드 또는 위임 대상 카드를 찾을 수 없습니다.' })
      }
      if (map.version !== sourceRevision) {
        return sendJson(response, 409, {
          error: `문서가 변경되었습니다. 최신 버전 ${map.version}을 다시 확인해 주세요.`,
          currentVersion: map.version,
        })
      }
      if (!isAiConversationLinked(targetCard.data, delegation.targetConversationId)) {
        return sendJson(response, 409, { error: '위임 대상 카드와 기존 AI 대화의 연결을 확인할 수 없습니다.' })
      }

      const linked = aiConversationLinksFromData(targetCard.data)
        .find((candidate) => candidate.conversationId === delegation.targetConversationId)
      let selection
      try {
        const conversation = await fetchAiConversationRuntime(delegation.targetConversationId)
        const runtime = normalizeAiConversationRuntime(delegation.targetConversationId, conversation)
        if (runtime.state !== 'idle') {
          return sendJson(response, 409, {
            error: `대상 대화가 ${runtime.state} 상태이므로 지금 복구할 수 없습니다.`,
            runtime,
          })
        }
        const recovered = aiConversationLinkFromAionUiConversation(conversation)
            selection = aiDelegationSelectionFromSource({
          ...recovered,
          ...linked,
          agent: linked?.agent ?? recovered?.agent,
          model: linked?.model ?? recovered?.model,
          mode: linked?.mode ?? recovered?.mode,
          thoughtLevel: linked?.thoughtLevel ?? recovered?.thoughtLevel,
          skills: linked?.skills?.length ? linked.skills : recovered?.skills,
          mcpServers: linked?.mcpServers?.length ? linked.mcpServers : recovered?.mcpServers,
          workspace: delegation.workspaceLease?.projectRoot ?? linked?.workspace ?? recovered?.workspace,
        })
      } catch (error) {
        return sendJson(response, 503, { error: `이어갈 AionUi 대화 상태를 확인하지 못했습니다: ${error?.message ?? String(error)}` })
      }
      if (!selection) return sendJson(response, 409, { error: '복구할 AI 대화의 실행 환경을 확인하지 못했습니다.' })

      let workspaceLease = delegation.workspaceLease ?? null
      if (workspaceLease?.leaseId) {
        try {
          workspaceLease = await workspacePoolManager.reuseLease(workspaceLease.leaseId, {
            mapId,
            cardId: targetCard.id,
            conversationId: delegation.targetConversationId,
          })
          selection.workspace = workspaceLease.projectRoot
        } catch (error) {
          return sendJson(response, 409, {
            error: `기존 작업공간 lease를 복구하지 못했습니다: ${error?.message ?? String(error)}`,
            code: error?.code ?? 'AI_DELEGATION_WORKSPACE_RECOVERY_FAILED',
          })
        }
      }

      const { token: attributionToken, attribution } = issueDelegatedAttribution({
        mapId,
        cardId: targetCard.id,
        conversationId: delegation.targetConversationId,
        selection,
        startedBy: delegation.startedBy ?? user.id,
      })
      await persistAiAttributions()

      const recoveryAttempt = Number(delegation.recoveryAttempt ?? 0) + 1
      const integrationRecovery = delegation.state === 'integration-recovery-required'
      const operationId = boundedAionOperationId(
        delegation.id,
        `${integrationRecovery ? 'integrate-' : ''}recover-${recoveryAttempt}`,
      )
      const requestedInstruction = integrationRecovery
        ? `${delegation.workspaceResult?.status === 'checkpoint-required'
            ? workspaceCheckpointInstruction(delegation, delegation.workspaceResult)
            : workspaceConflictInstruction(delegation, delegation.workspaceResult)}\n\n${delegationRecoveryInstruction(delegation, instruction)}`
        : delegationRecoveryInstruction(delegation, instruction)
      const delegatedInstruction = buildDelegatedInstruction({
        mapId,
        cardId: targetCard.id,
        editorId: delegation.startedBy ?? user.id,
        attributionToken,
        instruction: requestedInstruction,
        workspaceLease,
      })

      let dispatch
      try {
        dispatch = await fetchAionUi('/api/internal/external-conversation-dispatches', {
          method: 'POST',
          timeoutMs: 30_000,
          body: {
            operationId,
            actorConversationId: delegation.parentConversationId,
            strategy: 'resume',
            explicitCompletionAfterInterruption: true,
            targetConversationId: delegation.targetConversationId,
            ...(workspaceLease ? { workspaceLease } : {}),
            instruction: delegatedInstruction,
          },
        })
      } catch (error) {
        for (let attempt = 0; attempt < 10 && !dispatch; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500))
          try {
            dispatch = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(operationId)}`)
          } catch {
            // The recovery dispatch may have started even when its POST response was lost.
          }
        }
        if (!dispatch) {
          aiAttributions.delete(sessionTokenKey(attributionToken))
          await persistAiAttributions()
          return sendJson(response, error?.status === 409 ? 409 : 503, {
            error: `AionUi에 복구 작업을 전달하지 못했습니다: ${error?.message ?? String(error)}`,
          })
        }
      }

      attribution.conversationId = delegation.targetConversationId
      const now = new Date().toISOString()
      const nextState = integrationRecovery
        ? integrationDelegationState(dispatch.state)
        : (dispatch.state === 'waiting_resource'
            ? 'waiting-resource'
            : dispatch.state === 'waiting_resume' ? 'waiting-child-resume' : 'starting')
      const updated = await updateAiDelegation(delegation.id, {
        state: nextState,
        childOperationId: integrationRecovery ? delegation.childOperationId : operationId,
        integrationOperationId: integrationRecovery ? operationId : delegation.integrationOperationId,
        recoveryAttempt,
        recoveryOperationId: operationId,
        recoveryInstructionPreview: instruction.replace(/\s+/g, ' ').slice(0, 240),
        recoveryInstructionHash: createHash('sha256').update(instruction).digest('hex'),
        recoveryRequestedAt: now,
        recoveryRequiredAt: null,
        childError: integrationRecovery ? delegation.childError : null,
        integrationError: integrationRecovery ? null : delegation.integrationError,
        childTurnId: integrationRecovery ? delegation.childTurnId : (dispatch.turnId ?? null),
        integrationTurnId: integrationRecovery ? (dispatch.turnId ?? null) : delegation.integrationTurnId,
        ...(integrationRecovery ? {} : {
          childResultSnapshot: null,
          childResultHash: null,
          childResultCapturedAt: null,
          childResultCaptureAttemptedAt: null,
        }),
        workspaceLease,
      })
      return sendJson(response, 202, {
        delegation: delegationPublicView(updated),
        recovery: { operationId, attempt: recoveryAttempt, reusedConversation: true, reusedWorkspace: Boolean(workspaceLease) },
      })
    }

    if (aiDelegationsRoute && request.method === 'GET') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 위임 목록을 확인할 수 있습니다.' })
      const mapId = decodeURIComponent(aiDelegationsRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '문서 ID가 올바르지 않습니다.' })
      const parentCardId = String(url.searchParams.get('parentCardId') ?? '').trim()
      const targetCardId = String(url.searchParams.get('targetCardId') ?? '').trim()
      const delegations = [...aiDelegations.values()]
        .filter((delegation) => delegation.mapId === mapId
          && (!parentCardId || delegation.parentCardId === parentCardId)
          && (!targetCardId || delegation.targetCardId === targetCardId))
        .sort((first, second) => String(second.createdAt).localeCompare(String(first.createdAt)))
        .map(delegationPublicView)
      return sendJson(response, 200, { mapId, delegations })
    }

    if (aiDelegationsRoute && request.method === 'POST') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 작업을 위임할 수 있습니다.' })
      const mapId = decodeURIComponent(aiDelegationsRoute[1])
      const requestScope = integrationRequestScope(request)
      const source = delegationSourceForRequest(requestScope, mapId)
      if (!isValidMapId(mapId) || !source) {
        if (requestScope.conversationId) {
          return sendJson(response, 409, {
            error: '현재 AionUi 대화가 시작된 MindNProgress 카드를 확인할 수 없습니다. 카드의 AI 대화 연결 상태를 확인해 주세요.',
            code: 'AI_DELEGATION_ORIGIN_NOT_FOUND',
            conversationId: requestScope.conversationId,
          })
        }
        return sendJson(response, 400, { error: '현재 상위 카드의 문서와 카드 범위가 필요합니다.' })
      }
      if (!await aionCoreSupportsExplicitCompletionAfterInterruption()) {
        return sendJson(response, 503, {
          error: '현재 실행 중인 AionCore가 중단 후 명시적 완료 신호를 지원하지 않습니다. AionCore를 최신 빌드로 재기동해 주세요.',
          code: 'AIONCORE_EXPLICIT_COMPLETION_UNAVAILABLE',
        })
      }

      const body = await readJsonBody(request)
      const id = String(body.idempotencyKey ?? '').trim()
      const targetCardId = String(body.targetCardId ?? '').trim()
      const strategy = String(body.strategy ?? '').trim()
      const conversationId = String(body.conversationId ?? '').trim()
      const instruction = String(body.instruction ?? '').trim()
      const decisionReason = String(body.decisionReason ?? '').trim()
      const sourceRevision = Number(body.sourceRevision)
      if (!isValidAiDelegationId(id)
        || !targetCardId || targetCardId.length > 120
        || !['resume', 'new'].includes(strategy)
        || !instruction || instruction.length > 100_000
        || !decisionReason || decisionReason.length > 1_000
        || !Number.isInteger(sourceRevision) || sourceRevision < 1) {
        return sendJson(response, 400, { error: 'AI 작업 위임 값이 올바르지 않습니다.' })
      }

      const requestSignature = createAiDelegationRequestSignature({
        mapId,
        parentCardId: source.cardId,
        targetCardId,
        strategy,
        conversationId,
        instruction,
        decisionReason,
        sourceRevision,
        newConversation: body.newConversation,
      })
      const existingDelegation = aiDelegations.get(id)
      if (existingDelegation) {
        if (existingDelegation.requestSignature !== requestSignature) {
          return sendJson(response, 409, { error: '같은 idempotencyKey가 다른 AI 위임 요청에 사용되었습니다.' })
        }
        return sendJson(response, 200, { delegation: delegationPublicView(existingDelegation), repeated: true })
      }

      const map = await readMap(mapId)
      const parentCard = map?.nodes.find((node) => node.id === source.cardId)
      const targetCard = map?.nodes.find((node) => node.id === targetCardId)
      if (!map || map.trashedAt || !parentCard || !targetCard) {
        return sendJson(response, 404, { error: '상위 카드 또는 위임 대상 카드를 찾을 수 없습니다.' })
      }
      const parentAttribution = delegationParentAttribution(request, source, parentCard, user)
      if (!parentAttribution?.conversationId
        || (source.conversationId && !isAiConversationLinked(parentCard.data, source.conversationId))) {
        return sendJson(response, 409, {
          error: '현재 AI 대화와 대화가 시작된 카드의 연결을 확인할 수 없습니다.',
          code: 'AI_DELEGATION_ORIGIN_LINK_MISSING',
          conversationId: source.conversationId,
          sourceCardId: source.cardId,
        })
      }
      if (!isHierarchyDescendant(map, parentCard.id, targetCard.id)) {
        return sendJson(response, 400, {
          error: `위임 기준 카드 "${parentCard.data?.label ?? parentCard.id}"(${parentCard.id})의 계층상 하위 카드에만 AI 작업을 위임할 수 있습니다. 대상은 "${targetCard.data?.label ?? targetCard.id}"(${targetCard.id})입니다.`,
          code: 'AI_DELEGATION_TARGET_OUTSIDE_SOURCE',
          sourceCardId: parentCard.id,
          targetCardId: targetCard.id,
        })
      }
      if (map.version !== sourceRevision) {
        let recoveredDispatch = null
        try {
          const candidate = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(id)}`)
          const recoveredConversationId = String(candidate?.conversationId ?? '').trim()
          const linkedToTarget = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(recoveredConversationId)
            && isAiConversationLinked(targetCard.data, recoveredConversationId)
          if (linkedToTarget && (strategy === 'new' || recoveredConversationId === conversationId)) {
            recoveredDispatch = candidate
          }
        } catch {
          // AionCore에도 실행 기록이 없으면 일반적인 문서 버전 충돌로 처리합니다.
        }
        if (recoveredDispatch) {
          const now = new Date().toISOString()
          const targetConversationId = String(recoveredDispatch.conversationId).trim()
          let recoveredWorkspaceLease = recoveredDispatch.workspaceLease ?? null
          let workspaceRecoveryError = null
          if (recoveredWorkspaceLease?.leaseId) {
            try {
              recoveredWorkspaceLease = await workspacePoolManager.reuseLease(recoveredWorkspaceLease.leaseId, {
                mapId,
                cardId: targetCard.id,
                conversationId: targetConversationId,
              })
            } catch (error) {
              workspaceRecoveryError = error?.message ?? String(error)
              await workspacePoolManager.quarantine(
                recoveredWorkspaceLease.leaseId,
                `AionCore에 남은 위임의 실제 작업공간 lease를 복구하지 못했습니다: ${workspaceRecoveryError}`,
              )
            }
          }
          const delegation = {
            id,
            requestSignature,
            mapId,
            parentCardId: parentCard.id,
            parentCardLabel: parentCard.data?.label ?? parentCard.id,
            targetCardId: targetCard.id,
            targetCardLabel: targetCard.data?.label ?? targetCard.id,
            parentConversationId: parentAttribution.conversationId,
            targetConversationId,
            childOperationId: id,
            strategy,
            decisionReason,
            sourceRevision,
            instructionPreview: instruction.replace(/\s+/g, ' ').slice(0, 240),
            instructionHash: createHash('sha256').update(instruction).digest('hex'),
            ...(workspaceRecoveryError
              ? {
                  state: 'recovery-required',
                  childStatus: 'interrupted-by-workspace-conflict',
                  childTurnId: recoveredDispatch.turnId ?? null,
                  childError: `AionCore에 남은 위임의 실제 작업공간 lease를 복구하지 못했습니다: ${workspaceRecoveryError}`,
                  recoveryRequiredAt: now,
                }
              : initialAiDelegationRuntime(recoveredDispatch, now)),
            workspaceLease: recoveredWorkspaceLease,
            workspaceError: workspaceRecoveryError,
            linkError: null,
            startedBy: parentAttribution.startedBy ?? user.id,
            createdAt: now,
            updatedAt: now,
            recoveredAt: now,
          }
          aiDelegations.set(id, delegation)
          await persistAiDelegations()
          broadcastEvent({ type: 'ai-delegation-changed', delegation: delegationPublicView(delegation) })
          return sendJson(response, 202, {
            delegation: delegationPublicView(delegation),
            mapVersion: map.version,
            repeated: true,
            recovered: true,
          })
        }
        return sendJson(response, 409, { error: `문서가 변경되었습니다. 최신 버전 ${map.version}을 다시 확인해 주세요.`, currentVersion: map.version })
      }
      let selection = null
      let targetConversationId = conversationId
      if (strategy === 'resume') {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(targetConversationId)
          || !isAiConversationLinked(targetCard.data, targetConversationId)) {
          return sendJson(response, 400, { error: '이어갈 대화는 대상 카드에 연결된 conversationId여야 합니다.' })
        }
        const linked = aiConversationLinksFromData(targetCard.data)
          .find((candidate) => candidate.conversationId === targetConversationId)
        try {
          const conversation = await fetchAiConversationRuntime(targetConversationId)
          const runtime = normalizeAiConversationRuntime(targetConversationId, conversation)
          if (runtime.state !== 'idle') {
            return sendJson(response, 409, { error: `대화가 ${runtime.state} 상태이므로 지금 이어갈 수 없습니다.`, runtime })
          }
          const recovered = aiConversationLinkFromAionUiConversation(conversation)
          selection = aiDelegationSelectionFromSource({
            ...recovered,
            ...linked,
            agent: linked?.agent ?? recovered?.agent,
            model: linked?.model ?? recovered?.model,
            mode: linked?.mode ?? recovered?.mode,
            thoughtLevel: linked?.thoughtLevel ?? recovered?.thoughtLevel,
            skills: linked?.skills?.length ? linked.skills : recovered?.skills,
            mcpServers: linked?.mcpServers?.length ? linked.mcpServers : recovered?.mcpServers,
            workspace: linked?.workspace ?? recovered?.workspace,
          })
        } catch {
          return sendJson(response, 503, { error: '이어갈 AionUi 대화 상태를 확인하지 못했습니다.' })
        }
      } else {
        try {
          selection = await delegationCreateSelection(targetCard, body.newConversation, parentAttribution)
        } catch (error) {
          return sendJson(response, 400, { error: error.message })
        }
      }
      if (!selection) return sendJson(response, 409, { error: '위임 대화의 AI 종류와 모델 정보를 확인하지 못했습니다.' })

      let resumedDelegation = null
      if (strategy === 'resume') {
        const activeDelegations = activeAiDelegationsForConversation(aiDelegations.values(), {
          mapId,
          targetCardId: targetCard.id,
          targetConversationId,
          excludeId: id,
        })
        let parentTurnId = null
        if (activeDelegations.some((delegation) => delegation.state === 'waking-parent')) {
          try {
            const parentConversation = await fetchAiConversationRuntime(parentAttribution.conversationId)
            const parentRuntime = normalizeAiConversationRuntime(parentAttribution.conversationId, parentConversation)
            if (parentRuntime.state === 'running') parentTurnId = parentRuntime.turnId
          } catch {
            // 상위 대화의 현재 turn을 확증하지 못하면 기존 위임을 그대로 활성 상태로 취급합니다.
          }
        }
        const blockingDelegations = activeDelegations.filter((delegation) => aiDelegationBlocksResume(delegation, {
          parentConversationId: parentAttribution.conversationId,
          parentTurnId,
        }))
        const nonResumable = blockingDelegations.find((delegation) => delegation.state !== 'waiting-child-resume')
        if (nonResumable) {
          return sendJson(response, 409, {
            error: '같은 카드와 AI 대화에 아직 끝나지 않은 위임이 있습니다.',
            code: 'AI_DELEGATION_ALREADY_ACTIVE',
            delegation: delegationPublicView(nonResumable),
          })
        }
        if (blockingDelegations.length > 1) {
          return sendJson(response, 409, {
            error: '같은 카드와 AI 대화에 재개 대기 중인 위임이 여러 개 있어 자동으로 선택할 수 없습니다.',
            code: 'AI_DELEGATION_RESUME_AMBIGUOUS',
            delegations: blockingDelegations.map(delegationPublicView),
          })
        }
        resumedDelegation = blockingDelegations[0] ?? null
      }

      const workspacePoolResolution = await resolveAiDelegationWorkspacePool({
        selection,
        targetCard,
        parentAttribution,
        requested: body.newConversation,
      })
      if (!workspacePoolResolution.known && !resumedDelegation?.workspaceLease?.leaseId) {
        return sendJson(response, 503, {
          error: '현재 AI 대화의 작업공간이 등록된 pool 대상인지 확인하지 못했습니다. AionUi 대화의 workspace 정보를 확인해 주세요.',
          code: 'AI_DELEGATION_WORKSPACE_SCOPE_UNKNOWN',
        })
      }
      const workspacePoolHint = workspacePoolResolution.workspaceHint
        ?? resumedDelegation?.workspaceLease?.projectRoot
        ?? null
      const expectsWorkspacePool = Boolean(workspacePoolResolution.expectsWorkspacePool
        || resumedDelegation?.workspaceLease?.leaseId)
      if (expectsWorkspacePool) {
        const now = new Date().toISOString()
        let integrationChanges = { dirty: false, paths: [] }
        try {
          integrationChanges = await workspacePoolManager.integrationTrackedChanges()
        } catch (error) {
          console.warn('[AI delegation integration workspace preflight]', error)
        }
        const waitingForIntegrationClean = integrationChanges.dirty === true
        const workspacePoolSnapshot = workspacePoolManager.publicSnapshot()
        const waitingDelegation = {
          id,
          requestSignature,
          mapId,
          parentCardId: parentCard.id,
          parentCardLabel: parentCard.data?.label ?? parentCard.id,
          targetCardId: targetCard.id,
          targetCardLabel: targetCard.data?.label ?? targetCard.id,
          parentConversationId: parentAttribution.conversationId,
          targetConversationId,
          childOperationId: id,
          strategy,
          decisionReason,
          sourceRevision,
          instructionPreview: instruction.replace(/\s+/g, ' ').slice(0, 240),
          instructionHash: createHash('sha256').update(instruction).digest('hex'),
          state: waitingForIntegrationClean ? 'waiting-integration-clean' : 'waiting-workspace',
          resource: {
            kind: waitingForIntegrationClean ? 'integration_workspace' : 'workspace_pool',
            key: waitingForIntegrationClean
              ? workspacePoolSnapshot.integrationWorkspaceId
              : workspacePoolSnapshot.poolId,
            projectRoot: workspacePoolHint,
          },
          startedBy: parentAttribution.startedBy ?? user.id,
          pendingInstruction: instruction,
          pendingSelection: selection,
          pendingWorkspaceHint: workspacePoolHint,
          ...(resumedDelegation ? { resumesDelegationId: resumedDelegation.id } : {}),
          workspaceWaitStartedAt: now,
          ...(waitingForIntegrationClean ? {
            workspaceWaitError: integrationWorktreeDirtyMessage,
            integrationCleanTrackedChanges: integrationChanges.paths,
            integrationCleanWaitStartedAt: now,
          } : {}),
          createdAt: now,
          updatedAt: now,
        }
        aiDelegations.set(id, waitingDelegation)
        await persistAiDelegations()
        broadcastEvent({ type: 'ai-delegation-changed', delegation: delegationPublicView(waitingDelegation) })
        void pollAiDelegations().catch((error) => console.warn('[AI delegation queue start]', error))
        return sendJson(response, 202, {
          delegation: delegationPublicView(waitingDelegation),
          mapVersion: map.version,
          repeated: false,
        })
      }
      let workspaceLease = null
      if (expectsWorkspacePool
        && !await aionCoreSupportsWorkspaceLease()) {
        return sendJson(response, 503, {
          error: '현재 실행 중인 AionCore가 AI 작업공간 lease를 지원하지 않습니다. AionCore를 최신 빌드로 재기동해 주세요.',
          code: 'AIONCORE_WORKSPACE_LEASE_UNAVAILABLE',
        })
      }
      try {
        workspaceLease = resumedDelegation?.workspaceLease?.leaseId
          ? await workspacePoolManager.reuseLease(resumedDelegation.workspaceLease.leaseId, {
              mapId,
              cardId: targetCard.id,
              conversationId: targetConversationId,
            })
          : await workspacePoolManager.acquire({
              workspaceHint: workspacePoolHint ?? selection.workspace,
              mapId,
              cardId: targetCard.id,
              conversationId: strategy === 'resume' ? targetConversationId : '',
              cardLabel: targetCard.data?.label ?? targetCard.id,
            })
        if (workspaceLease) selection.workspace = workspaceLease.projectRoot
        if (expectsWorkspacePool && !workspaceLease) {
          throw aiDelegationDispatchError(
            '등록된 AI 작업공간 풀의 lease를 확보하지 못했습니다.',
            503,
            'AI_WORKSPACE_LEASE_REQUIRED',
          )
        }
      } catch (error) {
        if (error instanceof WorkspacePoolUnavailableError) {
          if (error.reasonCode === 'CAPACITY_EXHAUSTED' && expectsWorkspacePool) {
            const now = new Date().toISOString()
            const waitingDelegation = {
              id,
              requestSignature,
              mapId,
              parentCardId: parentCard.id,
              parentCardLabel: parentCard.data?.label ?? parentCard.id,
              targetCardId: targetCard.id,
              targetCardLabel: targetCard.data?.label ?? targetCard.id,
              parentConversationId: parentAttribution.conversationId,
              targetConversationId,
              childOperationId: id,
              strategy,
              decisionReason,
              sourceRevision,
              instructionPreview: instruction.replace(/\s+/g, ' ').slice(0, 240),
              instructionHash: createHash('sha256').update(instruction).digest('hex'),
              state: 'waiting-workspace',
              resource: {
                kind: 'workspace_pool',
                key: workspacePoolManager.publicSnapshot().poolId,
                projectRoot: workspacePoolHint,
              },
              startedBy: parentAttribution.startedBy ?? user.id,
              pendingInstruction: instruction,
              pendingSelection: selection,
              pendingWorkspaceHint: workspacePoolHint,
              ...(resumedDelegation ? { resumesDelegationId: resumedDelegation.id } : {}),
              workspaceWaitStartedAt: now,
              createdAt: now,
              updatedAt: now,
            }
            aiDelegations.set(id, waitingDelegation)
            await persistAiDelegations()
            broadcastEvent({ type: 'ai-delegation-changed', delegation: delegationPublicView(waitingDelegation) })
            return sendJson(response, 202, {
              delegation: delegationPublicView(waitingDelegation),
              mapVersion: map.version,
              repeated: false,
            })
          }
          return sendJson(response, 409, {
            error: error.message,
            code: error.code,
            reasonCode: error.reasonCode,
            details: error.details,
          })
        }
        throw error
      }

      if (resumedDelegation) {
        resumedDelegation = await updateAiDelegation(resumedDelegation.id, {
          state: 'resuming',
          resumingByDelegationId: id,
          resumeRequestedAt: new Date().toISOString(),
        })
      }

      const { token: attributionToken, attribution } = issueDelegatedAttribution({
        mapId,
        cardId: targetCard.id,
        conversationId: strategy === 'resume' ? targetConversationId : null,
        selection,
        startedBy: parentAttribution.startedBy ?? user.id,
      })
      await persistAiAttributions()
      const delegatedInstruction = buildDelegatedInstruction({
        mapId,
        cardId: targetCard.id,
        editorId: parentAttribution.startedBy ?? user.id,
        attributionToken,
        instruction,
        workspaceLease,
      })

      const delegatedConversationTitle = strategy === 'new'
        ? formatAiConversationTitle(map.title, targetCard.data?.label ?? targetCard.id)
        : null
      let dispatch
      try {
        dispatch = await fetchAionUi('/api/internal/external-conversation-dispatches', {
          method: 'POST',
          timeoutMs: 30_000,
          body: {
            operationId: id,
            actorConversationId: parentAttribution.conversationId,
            strategy,
            explicitCompletionAfterInterruption: true,
            ...(workspaceLease ? { workspaceLease } : {}),
            ...(strategy === 'resume' ? { targetConversationId } : {
              create: {
                agentId: selection.agent.id,
                title: delegatedConversationTitle,
                modelId: selection.model.id,
                mode: selection.mode?.id ?? null,
                thoughtLevel: selection.thoughtLevel?.id ?? null,
                enabledSkillIds: selection.enabledSkillIds,
                disabledBuiltinSkillIds: selection.disabledBuiltinSkillIds,
                mcpIds: selection.mcpIds,
                workspace: selection.workspace,
              },
            }),
            instruction: delegatedInstruction,
          },
        })
      } catch (error) {
        for (let attempt = 0; attempt < 10 && !dispatch; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500))
          try {
            dispatch = await fetchAionUi(`/api/internal/external-conversation-dispatches/${encodeURIComponent(id)}`)
          } catch {
            // The POST may have reached AionCore even if its response was lost.
          }
        }
        if (!dispatch) {
          aiAttributions.delete(sessionTokenKey(attributionToken))
          const definitelyRejected = Number.isInteger(error?.status)
            && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429
          await restoreAiDelegationResumeReservation(resumedDelegation, error)
          await Promise.all([
            persistAiAttributions(),
            workspaceLease && !resumedDelegation
              ? (definitelyRejected
                  ? workspacePoolManager.cancel(workspaceLease.leaseId, 'AionCore가 위임 요청을 실행 전에 거부했습니다.')
                  : workspacePoolManager.quarantine(workspaceLease.leaseId, 'AionUi 위임 요청의 실행 여부를 확인하지 못했습니다.'))
              : Promise.resolve(),
          ])
          return sendJson(response, error?.status === 409 ? 409 : 503, {
            error: error?.status === 409
              ? '대상 AI 대화가 이미 작업 중이거나 같은 위임 요청이 준비 중입니다.'
              : 'AionUi에 AI 작업을 위임하지 못했습니다.',
          })
        }
      }

      targetConversationId = String(dispatch.conversationId ?? '').trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(targetConversationId)) {
        await restoreAiDelegationResumeReservation(resumedDelegation, 'AionUi가 유효한 위임 대화 ID를 반환하지 않았습니다.')
        if (workspaceLease && !resumedDelegation) {
          await workspacePoolManager.quarantine(workspaceLease.leaseId, 'AionUi가 유효한 위임 대화 ID를 반환하지 않았습니다.')
        }
        return sendJson(response, 503, { error: 'AionUi가 위임 대화 ID를 반환하지 않았습니다.' })
      }
      if (workspaceLease) {
        try {
          workspaceLease = await workspacePoolManager.bindConversation(workspaceLease.leaseId, targetConversationId)
            ?? workspaceLease
        } catch (error) {
          console.warn('[AI delegation workspace conversation binding]', JSON.stringify({
            mapId,
            cardId: targetCard.id,
            conversationId: targetConversationId,
            leaseId: workspaceLease.leaseId,
            error: error?.message ?? String(error),
          }))
        }
      }
      if (delegatedConversationTitle) {
        try {
          await protectAionUiConversationTitle(targetConversationId, delegatedConversationTitle)
        } catch (error) {
          console.warn('[AI delegation conversation title protection]', JSON.stringify({
            mapId,
            cardId: targetCard.id,
            conversationId: targetConversationId,
            error: error?.message ?? String(error),
          }))
        }
      }
      attribution.conversationId = targetConversationId
      rememberAiConversationOrigin({
        conversationId: targetConversationId,
        mapId,
        cardId: targetCard.id,
        startedBy: attribution.startedBy,
        linkedAt: new Date().toISOString(),
      })
      aiConversationAttributions.set(conversationAttributionKey(mapId, targetCard.id), {
        mapId,
        cardId: targetCard.id,
        conversationId: targetConversationId,
        authorName: attribution.authorName,
        agentId: attribution.agentId,
        agentName: attribution.agentName,
        modelId: attribution.modelId,
        modelName: attribution.modelName,
        providerId: attribution.providerId,
        startedBy: attribution.startedBy,
        linkedAt: new Date().toISOString(),
        refreshedAt: new Date().toISOString(),
      })
      await Promise.all([persistAiAttributions(), persistAiConversationAttributions(), persistAiConversationOrigins()])

      let updatedMap = map
      let linkError = null
      if (strategy === 'new') {
        const latestMap = await readMap(mapId)
        const latestTargetCard = latestMap?.nodes.find((node) => node.id === targetCard.id)
        if (!latestMap || latestMap.trashedAt || !latestTargetCard) {
          linkError = '새 대화는 생성됐지만 대상 카드가 변경되어 연결하지 못했습니다.'
        } else {
          const conversationLink = normalizeAiConversationLink({
            conversationId: targetConversationId,
            agent: selection.agent,
            model: selection.model,
            providerId: selection.providerId,
            mode: selection.mode,
            thoughtLevel: selection.thoughtLevel,
            skills: selection.enabledSkillIds.map((skillId) => ({ id: skillId, label: skillId })),
            mcpServers: selection.mcpIds.map((mcpId) => ({ id: mcpId, label: mcpId })),
            workspace: selection.workspace,
            requestPreview: instruction,
            startedBy: { id: attribution.startedBy, label: users.find((candidate) => candidate.id === attribution.startedBy)?.name ?? attribution.startedBy },
            startedAt: new Date().toISOString(),
            linkedAt: new Date().toISOString(),
          })
          try {
            updatedMap = await saveMap(mapId, {
              nodes: latestMap.nodes.map((node) => node.id === targetCard.id ? {
                ...node,
                data: {
                  ...node.data,
                  aiConversationId: targetConversationId,
                  aiConversations: appendAiConversationLink(node.data, conversationLink),
                },
              } : node),
              edges: latestMap.edges,
            }, user, latestMap.title, latestMap.color, 'content')
            broadcastEvent({
              type: 'ai-conversation-linked', mapId, nodeId: targetCard.id,
              conversationId: targetConversationId, conversation: conversationLink,
              sourceClientId: null, updatedAt: updatedMap.updatedAt, updatedBy: publicUser(user),
            })
          } catch (error) {
            linkError = '새 대화는 생성됐지만 대상 카드의 대화 목록에 연결하지 못했습니다.'
            console.warn('[AI delegation conversation link]', error)
          }
        }
      }

      const now = new Date().toISOString()
      const delegation = {
        id,
        requestSignature,
        mapId,
        parentCardId: parentCard.id,
        parentCardLabel: parentCard.data?.label ?? parentCard.id,
        targetCardId: targetCard.id,
        targetCardLabel: targetCard.data?.label ?? targetCard.id,
        parentConversationId: parentAttribution.conversationId,
        targetConversationId,
        childOperationId: id,
        strategy,
        decisionReason,
        sourceRevision,
        instructionPreview: instruction.replace(/\s+/g, ' ').slice(0, 240),
        instructionHash: createHash('sha256').update(instruction).digest('hex'),
        ...initialAiDelegationRuntime(dispatch, now),
        linkError,
        startedBy: attribution.startedBy,
        workspaceLease,
        ...(resumedDelegation ? { resumesDelegationId: resumedDelegation.id } : {}),
        createdAt: now,
        updatedAt: now,
      }
      if (resumedDelegation) {
        const superseded = {
          ...resumedDelegation,
          state: 'superseded',
          supersededByDelegationId: id,
          supersededAt: now,
          resumingByDelegationId: null,
          updatedAt: now,
        }
        aiDelegations.set(superseded.id, superseded)
        broadcastEvent({ type: 'ai-delegation-changed', delegation: delegationPublicView(superseded) })
      }
      aiDelegations.set(id, delegation)
      await persistAiDelegations()
      broadcastEvent({ type: 'ai-delegation-changed', delegation: delegationPublicView(delegation) })
      return sendJson(response, 202, {
        delegation: delegationPublicView(delegation),
        mapVersion: updatedMap.version,
        repeated: false,
      })
    }

    const cardAiConversationItemRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/cards\/([^/]+)\/ai-conversations\/([^/]+)$/)
    if (cardAiConversationItemRoute && request.method === 'DELETE') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 대화 연결을 삭제할 수 있습니다.' })
      const mapId = decodeURIComponent(cardAiConversationItemRoute[1])
      const cardId = decodeURIComponent(cardAiConversationItemRoute[2])
      const conversationId = decodeURIComponent(cardAiConversationItemRoute[3])
      if (!isValidMapId(mapId)
        || !cardId || cardId.length > 120
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(conversationId)) {
        return sendJson(response, 400, { error: '문서, 카드 또는 대화 ID가 올바르지 않습니다.' })
      }
      const map = await readMap(mapId)
      const card = map?.nodes.find((node) => node.id === cardId)
      if (!map || map.trashedAt || !card) return sendJson(response, 404, { error: '카드를 찾을 수 없습니다.' })
      if (!isAiConversationLinked(card.data, conversationId)) {
        return sendJson(response, 404, { error: '카드에 연결된 AI 대화를 찾을 수 없습니다.' })
      }

      const remainingLinks = removeAiConversationLink(card.data, conversationId)
      const latestConversationId = remainingLinks.at(-1)?.conversationId ?? null
      const nextData = { ...card.data }
      if (remainingLinks.length > 0) nextData.aiConversations = remainingLinks
      else delete nextData.aiConversations
      if (latestConversationId) nextData.aiConversationId = latestConversationId
      else delete nextData.aiConversationId
      const updatedMap = await saveMap(mapId, {
        nodes: map.nodes.map((node) => node.id === cardId ? { ...node, data: nextData } : node),
        edges: map.edges,
      }, user, map.title, map.color, 'content')

      const attributionKey = conversationAttributionKey(mapId, cardId)
      if (aiConversationAttributions.get(attributionKey)?.conversationId === conversationId) {
        aiConversationAttributions.delete(attributionKey)
      }
      for (const [tokenHash, attribution] of aiAttributions.entries()) {
        if (attribution.mapId === mapId && attribution.cardId === cardId && attribution.conversationId === conversationId) {
          aiAttributions.delete(tokenHash)
        }
      }
      const origin = aiConversationOrigins.get(conversationId)
      if (origin?.mapId === mapId && origin.cardId === cardId) aiConversationOrigins.delete(conversationId)
      await Promise.all([persistAiAttributions(), persistAiConversationAttributions(), persistAiConversationOrigins()])
      broadcastMapChange(request, mapId, 'content', user)
      return sendJson(response, 200, {
        map: updatedMap,
        card: updatedMap.nodes.find((node) => node.id === cardId),
        removedConversationId: conversationId,
        latestConversationId,
      })
    }

    const cardAiConversationsRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/cards\/([^/]+)\/ai-conversations$/)
    if (cardAiConversationsRoute && request.method === 'GET') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 대화 목록을 확인할 수 있습니다.' })
      const mapId = decodeURIComponent(cardAiConversationsRoute[1])
      const cardId = decodeURIComponent(cardAiConversationsRoute[2])
      if (!isValidMapId(mapId) || !cardId || cardId.length > 120) {
        return sendJson(response, 400, { error: '문서와 카드 ID가 올바르지 않습니다.' })
      }
      const map = await readMap(mapId)
      const card = map?.nodes.find((node) => node.id === cardId)
      if (!map || map.trashedAt || !card) return sendJson(response, 404, { error: '카드를 찾을 수 없습니다.' })
      const currentAttribution = aiConversationAttributions.get(conversationAttributionKey(mapId, cardId))
      const links = aiConversationLinksFromData(card.data).map((link) => {
        if (link.conversationId !== currentAttribution?.conversationId) return link
        return normalizeAiConversationLink({
          ...link,
          agent: link.agent ?? (currentAttribution.agentId ? {
            id: currentAttribution.agentId,
            label: currentAttribution.agentName ?? currentAttribution.agentId,
          } : null),
          model: link.model ?? (currentAttribution.modelId ? {
            id: currentAttribution.modelId,
            label: currentAttribution.modelName ?? currentAttribution.modelId,
          } : null),
          providerId: link.providerId ?? currentAttribution.providerId,
          startedBy: link.startedBy ?? (currentAttribution.startedBy ? {
            id: currentAttribution.startedBy,
            label: users.find((candidate) => candidate.id === currentAttribution.startedBy)?.name ?? currentAttribution.startedBy,
          } : null),
          startedAt: link.startedAt ?? currentAttribution.linkedAt,
          linkedAt: link.linkedAt ?? currentAttribution.linkedAt,
        })
      }).filter(Boolean)
      const observedAt = new Date().toISOString()
      const conversations = await Promise.all(links.map(async (link) => {
        try {
          const conversation = await fetchAiConversationRuntime(link.conversationId)
          if (!conversation || String(conversation.id) !== link.conversationId) throw new Error('AIONUI_CONVERSATION_NOT_FOUND')
          const recoveredLink = aiConversationLinkFromAionUiConversation(conversation)
          const enrichedLink = normalizeAiConversationLink({
            ...link,
            agent: link.agent ?? recoveredLink?.agent,
            model: link.model ?? recoveredLink?.model,
            providerId: link.providerId ?? recoveredLink?.providerId,
            mode: link.mode ?? recoveredLink?.mode,
            thoughtLevel: link.thoughtLevel ?? recoveredLink?.thoughtLevel,
            skills: link.skills.length > 0 ? link.skills : recoveredLink?.skills,
            mcpServers: link.mcpServers.length > 0 ? link.mcpServers : recoveredLink?.mcpServers,
            workspace: link.workspace ?? recoveredLink?.workspace,
            startedAt: link.startedAt ?? recoveredLink?.startedAt,
          }) ?? link
          return {
            ...enrichedLink,
            available: true,
            name: String(conversation.name ?? ''),
            startedAt: enrichedLink.startedAt ?? normalizedIsoDate(conversation.created_at),
            modifiedAt: normalizedIsoDate(conversation.modified_at, enrichedLink.linkedAt ?? null),
            runtime: normalizeAiConversationRuntime(link.conversationId, conversation, observedAt),
          }
        } catch {
          return {
            ...link,
            available: false,
            name: '',
            modifiedAt: null,
            runtime: normalizeAiConversationRuntime(link.conversationId, null, observedAt),
          }
        }
      }))
      conversations.sort((first, second) => String(second.startedAt ?? second.linkedAt ?? '')
        .localeCompare(String(first.startedAt ?? first.linkedAt ?? '')))
      return sendJson(response, 200, {
        mapId,
        cardId,
        latestConversationId: card.data?.aiConversationId ?? null,
        conversations,
      })
    }

    if (aionUiConversationTranscriptRoute && request.method === 'GET') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 대화 전체 내용을 조회할 수 있습니다.' })
      const conversationId = decodeURIComponent(aionUiConversationTranscriptRoute[1])
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(conversationId)) {
        return sendJson(response, 400, { error: '올바르지 않은 AionUi 대화 ID입니다.' })
      }
      const scope = integrationRequestScope(request)
      if (!isValidMapId(scope.mapId) || !scope.cardId) {
        return sendJson(response, 400, { error: '대화가 연결된 문서와 카드 범위가 필요합니다.' })
      }
      const map = await readMap(scope.mapId)
      const card = map?.nodes.find((node) => node.id === scope.cardId)
      if (!map || map.trashedAt || !card || !isAiConversationLinked(card.data, conversationId)) {
        return sendJson(response, 404, { error: '카드에 연결된 AI 대화를 찾을 수 없습니다.' })
      }
      try {
        const [conversation, messagePage] = await Promise.all([
          fetchAionUi(`/api/conversations/${encodeURIComponent(conversationId)}`),
          fetchAionUi(`/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=10000&content_mode=full`, { timeoutMs: 30_000 }),
        ])
        if (!conversation || conversation.id !== conversationId) {
          return sendJson(response, 404, { error: 'AionUi 대화를 찾을 수 없습니다.' })
        }
        const messages = Array.isArray(messagePage?.items) ? messagePage.items : []
        const exportedAt = new Date().toISOString()
        const exported = buildAionUiConversationTranscript(conversation, messages, exportedAt)
        return sendJson(response, 200, {
          conversation: {
            id: conversation.id,
            name: String(conversation.name ?? ''),
            type: String(conversation.type ?? ''),
            createdAt: conversation.created_at ?? null,
            modifiedAt: conversation.modified_at ?? null,
          },
          card: { mapId: map.id, cardId: card.id, label: card.data?.label ?? card.id },
          exportedAt,
          messageCount: messages.length,
          exportedMessageCount: exported.exportedMessageCount,
          truncated: messagePage?.has_more_before === true || messagePage?.has_more_after === true,
          transcript: exported.transcript,
        })
      } catch (error) {
        console.error('[AionUi conversation transcript]', error)
        return sendJson(response, 503, { error: 'AionUi 대화 전체 내용을 가져오지 못했습니다.' })
      }
    }

    const aionUiConversationAttributionRoute = url.pathname.match(/^\/api\/integrations\/aionui\/conversations\/([^/]+)\/attribution$/)
    if (aionUiConversationAttributionRoute && request.method === 'POST') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 대화 정보를 갱신할 수 있습니다.' })
      const conversationId = decodeURIComponent(aionUiConversationAttributionRoute[1])
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(conversationId)) {
        return sendJson(response, 400, { error: '올바르지 않은 AionUi 대화 ID입니다.' })
      }
      const body = await readJsonBody(request)
      const mapId = String(body.mapId ?? '').trim().slice(0, 120)
      const cardId = String(body.cardId ?? '').trim().slice(0, 120)
      if (!isValidMapId(mapId) || !cardId) return sendJson(response, 400, { error: '문서와 카드 ID가 필요합니다.' })
      const map = await readMap(mapId)
      const card = map?.nodes.find((node) => node.id === cardId)
      if (!map || map.trashedAt || !card || !isAiConversationLinked(card.data, conversationId)) {
        return sendJson(response, 404, { error: '연결된 AI 대화의 문서 또는 카드를 찾을 수 없습니다.' })
      }
      try {
        const result = await refreshConversationAttribution(mapId, cardId, conversationId, user.id, null, {
          makeCurrent: card.data?.aiConversationId === conversationId,
        })
        return sendJson(response, 200, result)
      } catch (error) {
        console.error('[AionUi conversation attribution refresh]', error)
        return sendJson(response, 503, { error: 'AionUi에서 AI 종류와 모델을 확인하지 못했습니다.' })
      }
    }

    if (url.pathname === '/api/integrations/aionui/workspaces') {
      const user = requireSignedInUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 작업공간 이력을 사용할 수 있습니다.' })

      if (request.method === 'GET') {
        return sendJson(response, 200, { workspaces: aiWorkspaceHistories.get(user.id) ?? [] })
      }

      if (request.method === 'POST') {
        const body = await readJsonBody(request)
        const currentWorkspaces = aiWorkspaceHistories.get(user.id) ?? []

        if (typeof body?.workspace === 'string') {
          const workspace = body.workspace.trim()
          if (!workspace || workspace.length > AI_WORKSPACE_MAX_LENGTH) {
            return sendJson(response, 400, { error: '추가할 작업공간이 올바르지 않습니다.' })
          }
          const workspaces = rememberAiWorkspace(currentWorkspaces, workspace)
          aiWorkspaceHistories.set(user.id, workspaces)
          await persistAiWorkspaceHistories()
          return sendJson(response, 200, { workspaces })
        }

        if (body?.migration === true) {
          if (!Array.isArray(body.workspaces) || body.workspaces.length > AI_WORKSPACE_HISTORY_LIMIT
            || body.workspaces.some((workspace) => typeof workspace !== 'string'
              || !workspace.trim()
              || workspace.trim().length > AI_WORKSPACE_MAX_LENGTH)) {
            return sendJson(response, 400, { error: '가져올 작업공간 이력이 올바르지 않습니다.' })
          }
          if (aiWorkspaceHistories.has(user.id)) return sendJson(response, 200, { workspaces: currentWorkspaces })
          const workspaces = normalizeAiWorkspaceHistory(body.workspaces)
          if (workspaces.length > 0) {
            aiWorkspaceHistories.set(user.id, workspaces)
            await persistAiWorkspaceHistories()
          }
          return sendJson(response, 200, { workspaces })
        }

        return sendJson(response, 400, { error: '추가할 작업공간이 올바르지 않습니다.' })
      }

      if (request.method === 'DELETE') {
        const body = await readJsonBody(request)
        const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
        if (!workspace || workspace.length > AI_WORKSPACE_MAX_LENGTH) {
          return sendJson(response, 400, { error: '삭제할 작업공간이 올바르지 않습니다.' })
        }
        const workspaces = removeAiWorkspace(aiWorkspaceHistories.get(user.id) ?? [], workspace)
        aiWorkspaceHistories.set(user.id, workspaces)
        await persistAiWorkspaceHistories()
        return sendJson(response, 200, { workspaces })
      }

      return sendJson(response, 405, { error: '지원하지 않는 요청입니다.' })
    }

    if (request.method === 'GET' && url.pathname === '/api/integrations/aionui/directories') {
      const user = requireSignedInUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 작업공간을 탐색할 수 있습니다.' })
      if (!isLocalLoopbackRequest(request)) {
        return sendJson(response, 403, {
          code: 'REMOTE_CLIENT',
          error: '작업공간 탐색은 서버와 같은 PC에서만 할 수 있습니다. 경로를 직접 입력해 주세요.',
        })
      }

      const requestedPath = (url.searchParams.get('path') ?? '').trim()
      if (requestedPath.length > AI_WORKSPACE_MAX_LENGTH) {
        return sendJson(response, 400, { error: '탐색할 경로가 너무 깁니다.' })
      }
      if (!requestedPath) return sendJson(response, 200, await listWorkspaceRoots())

      try {
        return sendJson(response, 200, await listWorkspaceDirectory(requestedPath))
      } catch (error) {
        if (error?.code === 'ENOENT') return sendJson(response, 404, { error: '폴더를 찾을 수 없습니다.' })
        if (error?.code === 'ENOTDIR') return sendJson(response, 400, { error: '폴더가 아닙니다.' })
        if (error?.code === 'EACCES' || error?.code === 'EPERM') {
          return sendJson(response, 403, { error: '이 폴더를 읽을 권한이 없습니다.' })
        }
        console.error('[workspace browse]', error)
        return sendJson(response, 500, { error: '폴더 목록을 불러오지 못했습니다.' })
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/integrations/aionui/options') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '편집자만 AI 대화를 시작할 수 있습니다.' })

      try {
        const [agents, providers, skills, mcpServers] = await Promise.all([
          fetchAionUi('/api/agents/management'),
          fetchAionUi('/api/providers'),
          fetchAionUi('/api/skills'),
          fetchAionUi('/api/mcp/servers'),
        ])
        const normalizedAgents = (Array.isArray(agents) ? agents : [])
          .filter((agent) => agent?.enabled !== false && agent?.installed === true)
          .map((agent) => normalizeAionUiAgent(agent, Array.isArray(providers) ? providers.filter((item) => item?.enabled !== false) : []))
          .filter((agent) => agent.models.length > 0 || agent.backend === 'aionrs')
        const normalizedSkills = normalizeAionUiSkills(skills)
        const normalizedMcpServers = normalizeAionUiMcpServers(mcpServers)
        return sendJson(response, 200, {
          connected: true,
          aionUiUrl: activeAionUiBaseUrl,
          protocol: 'aionui://conversation/new',
          defaultWorkspace: projectDirectory,
          agents: normalizedAgents,
          skills: normalizedSkills,
          mcpServers: normalizedMcpServers,
        })
      } catch (error) {
        console.error('[AionUi integration]', error)
        return sendJson(response, 503, {
          error: 'AionUi에 연결할 수 없습니다. AionUi가 실행 중인지 확인해 주세요.',
          connected: false,
        })
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/account/password') {
      const user = requireUser(request, response)
      if (!user) return
      if (isPublicViewer(user)) return sendJson(response, 403, { error: '공개 뷰어 계정은 비밀번호를 변경할 수 없습니다.' })
      const body = await readJsonBody(request)
      const currentPassword = String(body.currentPassword ?? '')
      const newPassword = String(body.newPassword ?? '')
      if (!currentPassword) return sendJson(response, 400, { error: '현재 비밀번호를 입력해 주세요.' })
      if (newPassword.length < 8) return sendJson(response, 400, { error: '새 비밀번호는 8자 이상이어야 합니다.' })
      if (newPassword.length > 128) return sendJson(response, 400, { error: '새 비밀번호는 128자 이하여야 합니다.' })
      const currentHash = hashPassword(currentPassword, user.salt)
      if (!timingSafeEqual(user.passwordHash, currentHash)) {
        return sendJson(response, 401, { error: '현재 비밀번호가 올바르지 않습니다.' })
      }
      if (timingSafeEqual(user.passwordHash, hashPassword(newPassword, user.salt))) {
        return sendJson(response, 400, { error: '현재 비밀번호와 다른 비밀번호를 입력해 주세요.' })
      }
      user.salt = randomBytes(16).toString('hex')
      user.passwordHash = hashPassword(newPassword, user.salt)
      user.updatedAt = new Date().toISOString()
      const currentToken = parseCookies(request).get('mnp_session') ?? null
      await invalidateUserSessions(user.id, currentToken)
      await persistUsers()
      return sendJson(response, 200, { ok: true })
    }

    if (url.pathname === '/api/admin/editors') {
      const admin = requireAdmin(request, response)
      if (!admin) return
      if (request.method === 'GET') {
        const editors = users.filter((candidate) => candidate.role === 'editor').map(accountUser)
        return sendJson(response, 200, { editors })
      }
      if (request.method === 'POST') {
        const body = await readJsonBody(request)
        const name = String(body.name ?? '').trim().slice(0, 60)
        const email = String(body.email ?? '').trim().toLowerCase().slice(0, 160)
        const suppliedPassword = String(body.password ?? '')
        if (name.length < 2) return sendJson(response, 400, { error: '이름을 2자 이상 입력해 주세요.' })
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(response, 400, { error: '올바른 이메일을 입력해 주세요.' })
        if (users.some((candidate) => candidate.email.toLowerCase() === email)) return sendJson(response, 409, { error: '이미 사용 중인 이메일입니다.' })
        if (suppliedPassword && suppliedPassword.length < 8) return sendJson(response, 400, { error: '비밀번호는 8자 이상이어야 합니다.' })
        const generatedPassword = suppliedPassword || temporaryPassword()
        const salt = randomBytes(16).toString('hex')
        const now = new Date().toISOString()
        const editor = {
          id: `user-editor-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
          name,
          email,
          role: 'editor',
          active: true,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: null,
          createdBy: admin.id,
          salt,
          passwordHash: hashPassword(generatedPassword, salt),
        }
        users.push(editor)
        await persistUsers()
        return sendJson(response, 201, {
          editor: accountUser(editor),
          temporaryPassword: suppliedPassword ? null : generatedPassword,
        })
      }
      return sendJson(response, 405, { error: '지원하지 않는 요청입니다.' })
    }

    const editorPasswordRoute = url.pathname.match(/^\/api\/admin\/editors\/([^/]+)\/reset-password$/)
    if (editorPasswordRoute && request.method === 'POST') {
      const admin = requireAdmin(request, response)
      if (!admin) return
      const editorId = decodeURIComponent(editorPasswordRoute[1])
      const editor = users.find((candidate) => candidate.id === editorId && candidate.role === 'editor')
      if (!editor) return sendJson(response, 404, { error: '편집자 계정을 찾을 수 없습니다.' })
      const password = temporaryPassword()
      editor.salt = randomBytes(16).toString('hex')
      editor.passwordHash = hashPassword(password, editor.salt)
      editor.updatedAt = new Date().toISOString()
      await invalidateUserSessions(editor.id)
      await persistUsers()
      return sendJson(response, 200, { editor: accountUser(editor), temporaryPassword: password })
    }

    const editorAccountRoute = url.pathname.match(/^\/api\/admin\/editors\/([^/]+)$/)
    if (editorAccountRoute) {
      const admin = requireAdmin(request, response)
      if (!admin) return
      const editorId = decodeURIComponent(editorAccountRoute[1])
      const editor = users.find((candidate) => candidate.id === editorId && candidate.role === 'editor')
      if (!editor) return sendJson(response, 404, { error: '편집자 계정을 찾을 수 없습니다.' })

      if (request.method === 'PATCH') {
        const body = await readJsonBody(request)
        const name = body.name === undefined ? editor.name : String(body.name).trim().slice(0, 60)
        const email = body.email === undefined ? editor.email : String(body.email).trim().toLowerCase().slice(0, 160)
        const active = body.active === undefined ? editor.active !== false : body.active === true
        if (name.length < 2) return sendJson(response, 400, { error: '이름을 2자 이상 입력해 주세요.' })
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(response, 400, { error: '올바른 이메일을 입력해 주세요.' })
        if (users.some((candidate) => candidate.id !== editor.id && candidate.email.toLowerCase() === email)) {
          return sendJson(response, 409, { error: '이미 사용 중인 이메일입니다.' })
        }
        editor.name = name
        editor.email = email
        editor.active = active
        editor.updatedAt = new Date().toISOString()
        if (!active) await invalidateUserSessions(editor.id)
        await persistUsers()
        return sendJson(response, 200, { editor: accountUser(editor) })
      }

      if (request.method === 'DELETE') {
        users = users.filter((candidate) => candidate.id !== editor.id)
        await invalidateUserSessions(editor.id)
        aiWorkspaceHistories.delete(editor.id)
        await persistAiWorkspaceHistories()
        await persistUsers()
        return sendJson(response, 200, { deletedId: editor.id })
      }
      return sendJson(response, 405, { error: '지원하지 않는 요청입니다.' })
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      const user = requireUser(request, response)
      if (!user) return
      const clientId = String(url.searchParams.get('clientId') ?? '').slice(0, 120) || `stream-${randomBytes(8).toString('hex')}`
      const requestedMapId = String(url.searchParams.get('mapId') ?? '')
      const mapId = isValidMapId(requestedMapId) ? requestedMapId : null
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      response.write(`data: ${JSON.stringify({ type: 'connected', user: publicUser(user), clientId, mapId })}\n\n`)
      eventClients.set(response, { clientId, mapId, user: publicUser(user) })
      broadcastPresence(mapId)
      void refreshAiConversationRuntimeLibrary()
        .then((summaries) => {
          if (!eventClients.has(response)) return
          response.write(`data: ${JSON.stringify({ type: 'ai-conversation-runtime-summary-snapshot', summaries })}\n\n`)
          if (mapId) {
            const runtimes = aiConversationRuntimeSnapshot(mapId)
            response.write(`data: ${JSON.stringify({ type: 'ai-conversation-runtime-snapshot', mapId, runtimes })}\n\n`)
          }
        })
        .catch((error) => console.warn('[AI conversation runtime initial refresh]', error))
      const cleanup = () => removeEventClient(response)
      request.on('close', cleanup)
      request.on('aborted', cleanup)
      response.on('error', cleanup)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/presence/cursor') {
      const user = requireUser(request, response)
      if (!user) return
      const body = await readJsonBody(request)
      const mapId = String(body.mapId ?? '')
      const x = Number(body.x)
      const y = Number(body.y)
      if (!isValidMapId(mapId) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return sendJson(response, 400, { error: '올바르지 않은 커서 위치입니다.' })
      }
      broadcastEvent({
        type: 'cursor',
        mapId,
        x,
        y,
        sourceClientId: requestClientId(request),
        user: publicUser(user),
        updatedAt: new Date().toISOString(),
      })
      return sendJson(response, 200, { ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/api/notifications') {
      const user = requireUser(request, response)
      if (!user) return
      if (isPublicViewer(user)) return sendJson(response, 200, { notifications: [] })
      await ensureScheduleNotifications(user)
      return sendJson(response, 200, { notifications: await listNotifications(user.id) })
    }

    if (request.method === 'POST' && url.pathname === '/api/notifications/read-all') {
      const user = requireUser(request, response)
      if (!user) return
      if (isPublicViewer(user)) return sendJson(response, 200, { notifications: [] })
      const readAt = new Date().toISOString()
      const notifications = (await listNotifications(user.id)).map((notification) => ({
        ...notification,
        readAt: notification.readAt ?? readAt,
      }))
      await writeStoredArray(notificationFileForUser(user.id), notifications)
      broadcastEvent({ type: 'notifications-read', userId: user.id, notificationId: null, readAt }, (client) => client.user.id === user.id)
      return sendJson(response, 200, { notifications })
    }

    const notificationReadRoute = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/)
    if (notificationReadRoute && request.method === 'PATCH') {
      const user = requireUser(request, response)
      if (!user) return
      if (isPublicViewer(user)) return sendJson(response, 404, { error: '알림을 찾을 수 없습니다.' })
      const notificationId = decodeURIComponent(notificationReadRoute[1])
      const notifications = await listNotifications(user.id)
      const target = notifications.find((notification) => notification.id === notificationId)
      if (!target) return sendJson(response, 404, { error: '알림을 찾을 수 없습니다.' })
      const readAt = target.readAt ?? new Date().toISOString()
      const updated = notifications.map((notification) => notification.id === notificationId ? { ...notification, readAt } : notification)
      await writeStoredArray(notificationFileForUser(user.id), updated)
      broadcastEvent({ type: 'notifications-read', userId: user.id, notificationId, readAt }, (client) => client.user.id === user.id)
      return sendJson(response, 200, { notification: { ...target, readAt } })
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = parseCookies(request).get('mnp_session')
      if (token) {
        const session = sessions.get(sessionTokenKey(token))
        sessions.delete(sessionTokenKey(token))
        if (session?.persistent) await persistSessions()
      }
      return sendJson(response, 200, { ok: true }, {
        'Set-Cookie': 'mnp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/maps') {
      const user = requireUser(request, response)
      if (!user) return
      const maps = await listMaps()
      return sendJson(response, 200, {
        maps,
        documentLayout: await readDocumentLayout(maps.map((map) => map.id)),
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/shared-knowledge/audit') {
      const user = requireUser(request, response)
      if (!user) return
      const requestedMapIdParameter = url.searchParams.get('mapId')
      const requestedMapId = requestedMapIdParameter?.trim() ?? ''
      if (requestedMapIdParameter !== null && !isValidMapId(requestedMapId)) {
        return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      }
      const summaries = await listMaps()
      const selectedSummaries = requestedMapId
        ? summaries.filter((summary) => summary.id === requestedMapId)
        : summaries
      if (requestedMapId && selectedSummaries.length === 0) {
        return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      }
      const maps = (await Promise.all(selectedSummaries.map((summary) => readMap(summary.id)))).filter(Boolean)
      return sendJson(response, 200, { audit: buildSharedKnowledgeAudit(maps) })
    }

    const sharedKnowledgeReviewContextRoute = url.pathname.match(
      /^\/api\/maps\/([^/]+)\/cards\/([^/]+)\/shared-knowledge-review-context$/,
    )
    if (sharedKnowledgeReviewContextRoute && request.method === 'GET') {
      const mapId = decodeURIComponent(sharedKnowledgeReviewContextRoute[1])
      const cardId = decodeURIComponent(sharedKnowledgeReviewContextRoute[2])
      if (!isValidMapId(mapId) || !cardId || cardId.length > 120) {
        return sendJson(response, 400, { error: '문서 또는 카드 ID가 올바르지 않습니다.' })
      }
      const user = requireUser(request, response)
      if (!user) return
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const rawCommentLimit = url.searchParams.get('commentLimit')
      const commentLimit = rawCommentLimit === null ? 10 : Number(rawCommentLimit)
      if (!Number.isInteger(commentLimit) || commentLimit < 0 || commentLimit > 20) {
        return sendJson(response, 400, { error: 'commentLimit은 0~20의 정수여야 합니다.' })
      }
      const includeCommentDetail = url.searchParams.get('includeCommentDetail') === 'true'
      try {
        const context = buildSharedKnowledgeReviewContext(map, cardId)
        const allComments = await listComments(mapId, cardId)
        const comments = commentLimit > 0
          ? [...allComments].reverse().slice(0, commentLimit).map((comment) => commentForResponse(comment, includeCommentDetail))
          : []
        return sendJson(response, 200, {
          context: {
            ...context,
            accessUrl: `${publicBaseUrl}/mindmap/${encodeURIComponent(mapId)}/${encodeURIComponent(cardId)}`,
            comments,
            commentsPage: {
              total: allComments.length,
              returned: comments.length,
              order: 'desc',
              includesDetail: includeCommentDetail,
            },
          },
        })
      } catch (error) {
        if (sendSharedKnowledgeMaintenanceError(response, error)) return
        throw error
      }
    }

    const sharedKnowledgeReviewsRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/shared-knowledge\/reviews$/)
    if (sharedKnowledgeReviewsRoute && request.method === 'POST') {
      const mapId = decodeURIComponent(sharedKnowledgeReviewsRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 공유 지식 검토 결과를 저장할 수 없습니다.' })
      const existing = await readMap(mapId)
      if (!existing || existing.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const body = await readJsonBody(request)
      const baseVersion = Number(body.baseVersion)
      if (!Number.isInteger(baseVersion) || baseVersion < 1) {
        return sendJson(response, 400, { error: '검토 문맥에서 확인한 문서 버전을 입력해 주세요.' })
      }
      if (baseVersion !== existing.version) {
        return sendJson(response, 409, {
          error: '다른 사용자가 먼저 문서를 변경했습니다. 검토 후보와 문맥을 다시 조회해 주세요.',
          code: 'VERSION_CONFLICT',
          currentVersion: existing.version,
        })
      }

      let prepared
      try {
        prepared = prepareSharedKnowledgeReviewBatch(existing, body.patches)
      } catch (error) {
        if (sendSharedKnowledgeMaintenanceError(response, error)) return
        throw error
      }

      let map
      let verifiedChanges
      try {
        map = await saveMap(
          mapId,
          prepared.map,
          user,
          existing.title,
          existing.color,
          'shared-knowledge-review',
          {
            sharedKnowledgeReviewRequests: prepared.reviewRequests,
            expectedVersion: baseVersion,
            validatePayload: (payload) => {
              verifiedChanges = verifySharedKnowledgeReviewChanges(payload, prepared.changes)
            },
          },
        )
      } catch (error) {
        if (error?.code === 'VERSION_CONFLICT') {
          return sendJson(response, 409, {
            error: '다른 사용자가 먼저 문서를 변경했습니다. 검토 후보와 문맥을 다시 조회해 주세요.',
            code: 'VERSION_CONFLICT',
            currentVersion: error.currentVersion,
          })
        }
        if (sendSharedKnowledgeMaintenanceError(response, error)) return
        throw error
      }

      broadcastMapChange(request, mapId, 'shared-knowledge-reviewed', user)
      return sendJson(response, 200, {
        document: mapSummary(map),
        changes: verifiedChanges,
        atomic: true,
      })
    }

    const mapImageAssetRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/images\/([^/]+)$/)
    if (mapImageAssetRoute && request.method === 'GET') {
      const user = requireUser(request, response)
      if (!user) return
      const mapId = decodeURIComponent(mapImageAssetRoute[1])
      const assetId = decodeURIComponent(mapImageAssetRoute[2])
      if (!isValidMapId(mapId) || !isValidImageAssetId(assetId)) {
        return sendJson(response, 400, { error: '올바르지 않은 이미지 자산 경로입니다.' })
      }
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '이미지가 속한 문서를 찾을 수 없습니다.' })
      try {
        const content = await readFile(imageAssetFile(mapId, assetId))
        response.writeHead(200, {
          'Content-Type': imageAssetMimeType(assetId),
          'Content-Length': content.length,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Content-Disposition': 'inline',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(content)
        return
      } catch (error) {
        if (error?.code === 'ENOENT') return sendJson(response, 404, { error: '이미지 자산을 찾을 수 없습니다.' })
        throw error
      }
    }

    if (mapImageAssetRoute && request.method === 'DELETE') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 이미지 자산을 삭제할 수 없습니다.' })
      const mapId = decodeURIComponent(mapImageAssetRoute[1])
      const assetId = decodeURIComponent(mapImageAssetRoute[2])
      if (!isValidMapId(mapId) || !isValidImageAssetId(assetId)) {
        return sendJson(response, 400, { error: '올바르지 않은 이미지 자산 경로입니다.' })
      }
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '이미지가 속한 문서를 찾을 수 없습니다.' })
      const deletedNodeIds = map.nodes
        .filter((node) => node.data?.kind === 'image' && node.data?.image?.assetId === assetId)
        .map((node) => node.id)
      const deletedNodeIdSet = new Set(deletedNodeIds)
      let updatedMap = map
      if (deletedNodeIds.length > 0) {
        updatedMap = await saveMap(mapId, {
          nodes: map.nodes.filter((node) => !deletedNodeIdSet.has(node.id)),
          edges: map.edges.filter((edge) => !deletedNodeIdSet.has(edge.source) && !deletedNodeIdSet.has(edge.target)),
        }, user, undefined, undefined, 'content')
      }
      if (deletedNodeIds.length > 0) broadcastMapChange(request, mapId, 'content', user)
      return sendJson(response, 200, {
        deletedAssetId: null,
        retainedAssetId: assetId,
        assetDeletionDeferred: true,
        deletedNodeIds,
        map: updatedMap,
        summary: mapSummary(updatedMap),
      })
    }

    const mapImageUploadRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/images$/)
    if (mapImageUploadRoute && request.method === 'POST') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 이미지를 추가할 수 없습니다.' })
      const mapId = decodeURIComponent(mapImageUploadRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '이미지를 추가할 문서를 찾을 수 없습니다.' })
      const declaredSize = Number(request.headers['content-length'])
      if (Number.isFinite(declaredSize) && declaredSize > imageAssetMaxBytes) {
        return sendJson(response, 413, { error: `이미지는 ${Math.round(imageAssetMaxBytes / 1_000_000)}MB 이하만 추가할 수 있습니다.` })
      }
      const content = await readBinaryBody(request, imageAssetMaxBytes)
      const detectedType = detectImageAssetType(content)
      if (!detectedType) {
        return sendJson(response, 415, { error: 'PNG, JPEG, GIF 또는 WebP 이미지만 추가할 수 있습니다.' })
      }
      const assetId = `${randomBytes(16).toString('hex')}.${detectedType.extension}`
      const targetDirectory = imageAssetsDirectoryForMap(mapId)
      await mkdir(targetDirectory, { recursive: true })
      await writeFile(imageAssetFile(mapId, assetId), content, { flag: 'wx', mode: 0o600 })
      return sendJson(response, 201, {
        image: {
          assetId,
          mimeType: detectedType.mimeType,
        },
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/maps/trash') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 휴지통을 볼 수 없습니다.' })
      return sendJson(response, 200, { maps: await listMaps({ trashedOnly: true }) })
    }

    if (request.method === 'DELETE' && url.pathname === '/api/maps/trash') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 휴지통 문서를 영구 삭제할 수 없습니다.' })
      const body = await readJsonBody(request)
      const trash = await listMaps({ trashedOnly: true })
      const requestedIds = body.all === true
        ? trash.map((map) => map.id)
        : Array.isArray(body.mapIds) ? [...new Set(body.mapIds)] : []
      if (requestedIds.length === 0) return sendJson(response, 400, { error: '영구 삭제할 휴지통 문서를 선택해 주세요.' })
      if (requestedIds.some((mapId) => typeof mapId !== 'string' || !isValidMapId(mapId))) {
        return sendJson(response, 400, { error: '올바르지 않은 문서 ID가 포함되어 있습니다.' })
      }
      const trashIds = new Set(trash.map((map) => map.id))
      if (requestedIds.some((mapId) => !trashIds.has(mapId))) {
        return sendJson(response, 404, { error: '휴지통에서 일부 문서를 찾을 수 없습니다. 목록을 새로고침해 주세요.' })
      }
      const deletedIds = await permanentlyDeleteTrashedMaps(requestedIds)
      if (!deletedIds) return sendJson(response, 409, { error: '휴지통 상태가 변경되었습니다. 목록을 새로고침해 주세요.' })
      broadcastEvent({
        type: 'map-changed',
        mapId: null,
        action: body.all === true ? 'trash-emptied' : 'trash-deleted',
        deletedIds,
        sourceClientId: requestClientId(request),
        updatedAt: new Date().toISOString(),
        updatedBy: publicUser(user),
      })
      return sendJson(response, 200, {
        deletedIds,
        trash: await listMaps({ trashedOnly: true }),
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/maps') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) {
        return sendJson(response, 403, { error: '뷰어는 마인드맵을 생성할 수 없습니다.' })
      }
      const body = await readJsonBody(request)
      if (!isValidMap(body.map)) return sendJson(response, 400, { error: '올바르지 않은 마인드맵 데이터입니다.' })
      if (body.color !== undefined && !mapColors.includes(body.color)) return sendJson(response, 400, { error: '올바르지 않은 문서 색상입니다.' })
      const mapId = `map-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
      const map = await saveMap(mapId, body.map, user, body.title, body.color)
      const maps = await listMaps()
      const documentLayout = await reconcileDocumentLayout(maps.map((item) => item.id))
      broadcastMapChange(request, mapId, 'created', user)
      return sendJson(response, 201, { map, summary: mapSummary(map), documentLayout })
    }

    if (request.method === 'PATCH' && url.pathname === '/api/maps/layout') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 문서 그룹과 순서를 변경할 수 없습니다.' })
      const body = await readJsonBody(request)
      const maps = await listMaps()
      const mapIds = maps.map((map) => map.id)
      if (!isCompleteDocumentLayout(body.documentLayout, mapIds)) {
        return sendJson(response, 400, { error: '문서 그룹과 순서 데이터가 올바르지 않습니다.' })
      }
      const documentLayout = normalizeDocumentLayout(body.documentLayout, mapIds)
      await writeDocumentLayout(documentLayout)
      broadcastEvent({
        type: 'map-changed',
        mapId: null,
        action: 'layout',
        sourceClientId: requestClientId(request),
        updatedAt: new Date().toISOString(),
        updatedBy: publicUser(user),
      })
      return sendJson(response, 200, { maps: await listMaps(), documentLayout })
    }

    if (request.method === 'PATCH' && url.pathname === '/api/maps/order') {
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 문서 순서를 변경할 수 없습니다.' })
      const body = await readJsonBody(request)
      const requestedIds = Array.isArray(body.mapIds) ? [...new Set(body.mapIds)] : []
      const existingIds = (await listMaps()).map((map) => map.id)
      const hasSameMaps = requestedIds.length === existingIds.length
        && requestedIds.every((mapId) => typeof mapId === 'string' && existingIds.includes(mapId))
      if (!hasSameMaps) return sendJson(response, 400, { error: '문서 순서 데이터가 올바르지 않습니다.' })
      const orderIndex = new Map(requestedIds.map((mapId, index) => [mapId, index]))
      const currentLayout = await readDocumentLayout(existingIds)
      const groups = currentLayout.groups.map((group) => ({
        ...group,
        mapIds: [...group.mapIds].sort((first, second) => orderIndex.get(first) - orderIndex.get(second)),
      }))
      const groupsById = new Map(groups.map((group) => [group.id, group]))
      const documentLayout = {
        version: 1,
        groups,
        items: currentLayout.items
          .map((item, index) => ({
            item,
            index,
            order: item.type === 'map'
              ? orderIndex.get(item.id)
              : Math.min(...(groupsById.get(item.id)?.mapIds ?? []).map((mapId) => orderIndex.get(mapId)), Number.MAX_SAFE_INTEGER),
          }))
          .sort((first, second) => first.order - second.order || first.index - second.index)
          .map(({ item }) => item),
      }
      await writeDocumentLayout(documentLayout)
      broadcastEvent({
        type: 'map-changed',
        mapId: null,
        action: 'order',
        sourceClientId: requestClientId(request),
        updatedAt: new Date().toISOString(),
        updatedBy: publicUser(user),
      })
      return sendJson(response, 200, { maps: await listMaps(), documentLayout })
    }

    const commentStatsRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/comments\/stats$/)
    if (commentStatsRoute && request.method === 'GET') {
      const mapId = decodeURIComponent(commentStatsRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      return sendJson(response, 200, { stats: buildNodeCommentStats(await listComments(mapId)) })
    }

    const commentReactionRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/comments\/([^/]+)\/reactions$/)
    if (commentReactionRoute && request.method === 'POST') {
      const mapId = decodeURIComponent(commentReactionRoute[1])
      const commentId = decodeURIComponent(commentReactionRoute[2])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      if (isPublicViewer(user)) return sendJson(response, 403, { error: '공개 뷰어는 댓글 반응을 변경할 수 없습니다.' })
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const body = await readJsonBody(request)
      const emoji = String(body.emoji ?? '')
      if (!commentReactions.includes(emoji)) return sendJson(response, 400, { error: '지원하지 않는 댓글 반응입니다.' })
      const comments = await listComments(mapId)
      const target = comments.find((item) => item.id === commentId)
      if (!target) return sendJson(response, 404, { error: '댓글을 찾을 수 없습니다.' })
      const currentUsers = Array.isArray(target.reactions?.[emoji]) ? target.reactions[emoji] : []
      const reacted = currentUsers.includes(user.id)
      const comment = {
        ...target,
        reactions: {
          ...target.reactions,
          [emoji]: reacted ? currentUsers.filter((userId) => userId !== user.id) : [...currentUsers, user.id],
        },
      }
      await writeStoredArray(commentFileForMap(mapId), comments.map((item) => item.id === commentId ? comment : item))
      broadcastEvent({ type: 'comment-changed', mapId, nodeId: comment.nodeId, action: 'updated', comment })
      return sendJson(response, 200, { comment })
    }

    const commentResolveRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/comments\/([^/]+)\/resolve$/)
    if (commentResolveRoute && request.method === 'PATCH') {
      const mapId = decodeURIComponent(commentResolveRoute[1])
      const commentId = decodeURIComponent(commentResolveRoute[2])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      if (isPublicViewer(user)) return sendJson(response, 403, { error: '공개 뷰어는 댓글 상태를 변경할 수 없습니다.' })
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const comments = await listComments(mapId)
      const target = comments.find((item) => item.id === commentId)
      if (!target) return sendJson(response, 404, { error: '댓글을 찾을 수 없습니다.' })
      if (!canEdit(user) && target.author.id !== user.id) {
        return sendJson(response, 403, { error: '댓글 작성자 또는 편집자만 해결 상태를 변경할 수 있습니다.' })
      }
      const body = await readJsonBody(request)
      const resolved = body.resolved === true
      const comment = {
        ...target,
        resolvedAt: resolved ? new Date().toISOString() : null,
        resolvedBy: resolved ? publicUser(user) : null,
      }
      await writeStoredArray(commentFileForMap(mapId), comments.map((item) => item.id === commentId ? comment : item))
      broadcastEvent({ type: 'comment-changed', mapId, nodeId: comment.nodeId, action: 'updated', comment })
      return sendJson(response, 200, { comment })
    }

    const commentItemRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/comments\/([^/]+)$/)
    if (commentItemRoute && request.method === 'PATCH') {
      const mapId = decodeURIComponent(commentItemRoute[1])
      const commentId = decodeURIComponent(commentItemRoute[2])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      if (isPublicViewer(user)) return sendJson(response, 403, { error: '공개 뷰어는 댓글을 수정할 수 없습니다.' })
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const comments = await listComments(mapId)
      const target = comments.find((item) => item.id === commentId)
      if (!target) return sendJson(response, 404, { error: '댓글을 찾을 수 없습니다.' })
      if (!canEdit(user) && target.author.id !== user.id) {
        return sendJson(response, 403, { error: '댓글 작성자 또는 편집자만 댓글을 수정할 수 있습니다.' })
      }
      const body = await readJsonBody(request)
      if (typeof body.expectedText === 'string' && target.text !== body.expectedText) {
        return sendJson(response, 409, {
          error: '댓글 원문이 조회 이후 변경되었습니다. 최신 댓글을 다시 확인해 주세요.',
          currentComment: commentForResponse(target, true),
        })
      }
      const updatedContent = updateCommentContent(target, body)
      if (updatedContent.error) return sendJson(response, 400, { error: updatedContent.error })
      const comment = {
        ...updatedContent.content,
        updatedAt: new Date().toISOString(),
      }
      await writeStoredArray(commentFileForMap(mapId), comments.map((item) => item.id === commentId ? comment : item))
      broadcastEvent({ type: 'comment-changed', mapId, nodeId: comment.nodeId, action: 'updated', comment })
      return sendJson(response, 200, { comment })
    }

    if (commentItemRoute && request.method === 'DELETE') {
      const mapId = decodeURIComponent(commentItemRoute[1])
      const commentId = decodeURIComponent(commentItemRoute[2])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      if (isPublicViewer(user)) return sendJson(response, 403, { error: '공개 뷰어는 댓글을 삭제할 수 없습니다.' })
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const comments = await listComments(mapId)
      const comment = comments.find((item) => item.id === commentId)
      if (!comment) return sendJson(response, 404, { error: '댓글을 찾을 수 없습니다.' })
      if (!canEdit(user) && comment.author.id !== user.id) {
        return sendJson(response, 403, { error: '자신이 작성한 댓글만 삭제할 수 있습니다.' })
      }
      const deletedIds = new Set([commentId])
      let foundDescendant = true
      while (foundDescendant) {
        foundDescendant = false
        for (const item of comments) {
          if (item.parentId && deletedIds.has(item.parentId) && !deletedIds.has(item.id)) {
            deletedIds.add(item.id)
            foundDescendant = true
          }
        }
      }
      await writeStoredArray(commentFileForMap(mapId), comments.filter((item) => !deletedIds.has(item.id)))
      const notificationCleanupResults = await Promise.allSettled(users.map(async (recipient) => {
        const notifications = await listNotifications(recipient.id)
        const removedIds = notifications.filter((notification) => deletedIds.has(notification.commentId)).map((notification) => notification.id)
        if (removedIds.length === 0) return
        await writeStoredArray(notificationFileForUser(recipient.id), notifications.filter((notification) => !deletedIds.has(notification.commentId)))
        broadcastEvent({ type: 'notifications-removed', userId: recipient.id, notificationIds: removedIds }, (client) => client.user.id === recipient.id)
      }))
      reportRejectedSideEffects(notificationCleanupResults, 'Comment notification cleanup')
      broadcastEvent({ type: 'comment-changed', mapId, nodeId: comment.nodeId, action: 'deleted', commentIds: [...deletedIds] })
      return sendJson(response, 200, { deletedIds: [...deletedIds] })
    }

    const commentsRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/comments$/)
    if (commentsRoute) {
      const mapId = decodeURIComponent(commentsRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })

      if (request.method === 'GET') {
        const nodeId = String(url.searchParams.get('nodeId') ?? '').slice(0, 120)
        const comments = await listComments(mapId, nodeId || undefined)
        const includeDetail = url.searchParams.get('includeDetail') !== 'false'
        const responseComments = comments.map((comment) => commentForResponse(comment, includeDetail))
        const limitValue = url.searchParams.get('limit')
        if (limitValue === null) return sendJson(response, 200, { comments: responseComments })
        const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
        const limit = Math.min(100, Math.max(1, Number.parseInt(limitValue, 10) || 50))
        const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc'
        const ordered = order === 'asc' ? responseComments : [...responseComments].reverse()
        const page = ordered.slice(offset, offset + limit)
        const nextOffset = offset + page.length
        return sendJson(response, 200, {
          comments: page,
          total: responseComments.length,
          offset,
          limit,
          order,
          hasMore: nextOffset < comments.length,
          nextOffset: nextOffset < comments.length ? nextOffset : null,
        })
      }

      if (request.method === 'POST') {
        if (isPublicViewer(user)) return sendJson(response, 403, { error: '공개 뷰어는 댓글을 작성할 수 없습니다.' })
        const body = await readJsonBody(request)
        const nodeId = String(body.nodeId ?? '').slice(0, 120)
        const node = map.nodes.find((item) => item.id === nodeId)
        if (!node) return sendJson(response, 400, { error: '댓글을 남길 노드를 찾을 수 없습니다.' })
        const createdContent = createCommentContent(body)
        if (createdContent.error) return sendJson(response, 400, { error: createdContent.error })
        const comments = await listComments(mapId)
        const requestedParentId = typeof body.parentId === 'string' ? body.parentId : null
        const requestedParent = requestedParentId ? comments.find((item) => item.id === requestedParentId && item.nodeId === nodeId) : null
        if (requestedParentId && !requestedParent) return sendJson(response, 400, { error: '답글을 남길 댓글을 찾을 수 없습니다.' })
        const parent = requestedParent ? comments.find((item) => item.id === (requestedParent.parentId ?? requestedParent.id)) ?? requestedParent : null
        const comment = {
          id: `comment-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
          mapId,
          nodeId,
          ...createdContent.content,
          parentId: parent?.id ?? null,
          resolvedAt: null,
          resolvedBy: null,
          reactions: {},
          createdAt: new Date().toISOString(),
          author: publicUser(user),
        }
        await writeStoredArray(commentFileForMap(mapId), [...comments, comment])
        const notificationSummary = comment.summary ?? comment.text
        const mentionSource = [notificationSummary, comment.detail].filter(Boolean).join('\n')
        const mentionedIds = new Set(mentionedUsers(mentionSource).map((candidate) => candidate.id))
        const notificationResults = await Promise.allSettled(users
          .filter((recipient) => recipient.id !== user.id && recipient.active !== false && !isPublicViewer(recipient))
          .map((recipient) => createNotification(recipient, {
            type: mentionedIds.has(recipient.id) ? 'mention' : parent?.author.id === recipient.id ? 'reply' : 'comment',
            mapId,
            mapTitle: map.title,
            nodeId,
            nodeLabel: node.data.label,
            commentId: comment.id,
            message: notificationSummary.slice(0, 180),
            actor: publicUser(user),
          })))
        reportRejectedSideEffects(notificationResults, 'Comment notification creation')
        broadcastEvent({ type: 'comment-changed', mapId, nodeId, action: 'created', comment })
        return sendJson(response, 201, { comment })
      }
    }

    const revisionRestoreRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/history\/([^/]+)\/restore$/)
    if (revisionRestoreRoute && request.method === 'POST') {
      const mapId = decodeURIComponent(revisionRestoreRoute[1])
      const revisionId = decodeURIComponent(revisionRestoreRoute[2])
      if (!isValidMapId(mapId) || !isValidRevisionId(revisionId)) return sendJson(response, 400, { error: '올바르지 않은 변경 이력 요청입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 이전 버전을 복원할 수 없습니다.' })
      const current = await readMap(mapId)
      if (!current || current.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const revision = await readMapRevision(mapId, revisionId)
      if (!revision) return sendJson(response, 404, { error: '변경 이력을 찾을 수 없습니다.' })
      await writeDailyBackup(current, user, 'before-history-restore')
      await archiveMapRevision(current, user, 'history-restore')
      const map = {
        id: mapId,
        title: normalizeTitle(revision.map.title, current.title),
        color: normalizeMapColor(revision.map.color, current.color),
        nodes: revision.map.nodes,
        edges: revision.map.edges,
        updatedAt: new Date().toISOString(),
        updatedBy: publicUser(user),
        version: (current.version ?? 1) + 1,
        restoredFrom: revisionId,
      }
      await writeStoredMap(mapId, map)
      broadcastMapChange(request, mapId, 'history-restored', user)
      const historyPage = await listMapRevisions(mapId)
      return sendJson(response, 200, {
        map,
        summary: mapSummary(map),
        revisions: historyPage.revisions,
        historyHasMore: historyPage.hasMore,
        historyNextOffset: historyPage.nextOffset,
      })
    }

    const dailyBackupRestoreRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/backups\/daily\/(\d{4}-\d{2}-\d{2})\/restore$/)
    if (dailyBackupRestoreRoute && request.method === 'POST') {
      const mapId = decodeURIComponent(dailyBackupRestoreRoute[1])
      const date = dailyBackupRestoreRoute[2]
      if (!isValidMapId(mapId) || !isValidDailyBackupDate(date)) return sendJson(response, 400, { error: '올바르지 않은 일일 백업 요청입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 일일 백업을 복원할 수 없습니다.' })
      const current = await readMap(mapId)
      if (!current || current.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const backup = await readDailyBackup(mapId, date)
      if (!backup) return sendJson(response, 404, { error: '일일 백업을 찾을 수 없습니다.' })
      await writeDailyBackup(current, user, 'before-daily-restore')
      await archiveMapRevision(current, user, 'daily-backup-restore')
      const map = {
        id: mapId,
        title: normalizeTitle(backup.map.title, current.title),
        color: normalizeMapColor(backup.map.color, current.color),
        nodes: backup.map.nodes,
        edges: backup.map.edges,
        createdAt: current.createdAt ?? backup.map.createdAt ?? null,
        createdBy: current.createdBy ?? backup.map.createdBy ?? null,
        updatedAt: new Date().toISOString(),
        updatedBy: publicUser(user),
        version: (current.version ?? 1) + 1,
        restoredFromDailyBackup: date,
      }
      await writeStoredMap(mapId, map)
      broadcastMapChange(request, mapId, 'daily-backup-restored', user)
      const historyPage = await listMapRevisions(mapId)
      return sendJson(response, 200, {
        map,
        summary: mapSummary(map),
        dailyBackups: await listDailyBackups(mapId),
        revisions: historyPage.revisions,
        historyHasMore: historyPage.hasMore,
        historyNextOffset: historyPage.nextOffset,
      })
    }

    const dailyBackupPreviewRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/backups\/daily\/(\d{4}-\d{2}-\d{2})\/preview$/)
    if (dailyBackupPreviewRoute && request.method === 'GET') {
      const mapId = decodeURIComponent(dailyBackupPreviewRoute[1])
      const date = dailyBackupPreviewRoute[2]
      if (!isValidMapId(mapId) || !isValidDailyBackupDate(date)) return sendJson(response, 400, { error: '올바르지 않은 일일 백업 요청입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const backup = await readDailyBackup(mapId, date)
      if (!backup) return sendJson(response, 404, { error: '일일 백업을 찾을 수 없습니다.' })
      return sendJson(response, 200, {
        backup: {
          ...dailyBackupSummary(backup),
          map: backup.map,
        },
      })
    }

    const dailyBackupsRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/backups\/daily$/)
    if (dailyBackupsRoute && request.method === 'GET') {
      const mapId = decodeURIComponent(dailyBackupsRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      return sendJson(response, 200, { dailyBackups: await listDailyBackups(mapId) })
    }

    const historyRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/history$/)
    if (historyRoute && request.method === 'GET') {
      const mapId = decodeURIComponent(historyRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      const map = await readMap(mapId)
      if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(response, 400, { error: '변경 이력 조회 범위가 올바르지 않습니다.' })
      }
      return sendJson(response, 200, await listMapRevisions(mapId, { offset, limit }))
    }

    const restoreRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/restore$/)
    if (restoreRoute && request.method === 'POST') {
      const mapId = decodeURIComponent(restoreRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 문서를 복원할 수 없습니다.' })
      const map = await restoreMap(mapId, user)
      if (!map) return sendJson(response, 404, { error: '휴지통에서 문서를 찾을 수 없습니다.' })
      const maps = await listMaps()
      const documentLayout = await reconcileDocumentLayout(maps.map((item) => item.id))
      broadcastMapChange(request, mapId, 'trash-restored', user)
      return sendJson(response, 200, {
        map,
        summary: mapSummary(map),
        maps,
        documentLayout,
        trash: await listMaps({ trashedOnly: true }),
      })
    }

    const aiConversationWorkStatesRoute = url.pathname.match(/^\/api\/maps\/([^/]+)\/ai-conversation-work-states$/)
    if (aiConversationWorkStatesRoute && request.method === 'GET') {
      const mapId = decodeURIComponent(aiConversationWorkStatesRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return
      const requestedCardIds = url.searchParams.getAll('cardId').map((cardId) => cardId.trim()).filter(Boolean)
      if (requestedCardIds.length > 200 || requestedCardIds.some((cardId) => cardId.length > 120)) {
        return sendJson(response, 400, { error: '조회할 카드 ID가 올바르지 않습니다.' })
      }
      const result = await aiConversationWorkStates(mapId, requestedCardIds)
      if (!result) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      if (result.error === 'CARD_NOT_FOUND') {
        return sendJson(response, 404, {
          error: '카드를 찾을 수 없습니다.',
          missingCardIds: result.missingCardIds,
        })
      }
      return sendJson(response, 200, result)
    }

    const mapRoute = url.pathname.match(/^\/api\/maps\/([^/]+)$/)
    if (mapRoute) {
      const mapId = decodeURIComponent(mapRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return

      if (request.method === 'GET') {
        const map = await readMap(mapId)
        if (!map || map.trashedAt) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
        const resolved = await resolveReferencesForMap(map)
        const delegationOrigin = await resolveOrRememberDelegationSource(integrationRequestScope(request), mapId, map)
        return sendJson(response, 200, {
          map: resolved.map,
          referenceCommentStats: resolved.referenceCommentStats,
          unresolvedReferenceNodeIds: resolved.unresolvedReferenceNodeIds,
          ...(delegationOrigin ? { delegationOrigin } : {}),
        })
      }

      if (request.method === 'PUT') {
        if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 마인드맵을 변경할 수 없습니다.' })
        const existing = await readMap(mapId)
        if (existing?.trashedAt) return sendJson(response, 409, { error: '휴지통에 있는 문서는 변경할 수 없습니다.' })
        const body = await readJsonBody(request)
        if (!isValidMap(body.map)) return sendJson(response, 400, { error: '올바르지 않은 마인드맵 데이터입니다.' })
        const normalizedIncomingMap = reconcileSharedKnowledgeReviews(existing, normalizeMapForPersistence(body.map))
        const baseVersion = Number(body.baseVersion)
        if (existing && Number.isInteger(baseVersion) && baseVersion !== existing.version && body.force !== true) {
          return sendJson(response, 409, {
            error: '다른 사용자가 먼저 문서를 변경했습니다.',
            code: 'VERSION_CONFLICT',
            map: existing,
            summary: mapSummary(existing),
          })
        }
        const contentChanged = !existing || JSON.stringify({ nodes: existing.nodes, edges: existing.edges }) !== JSON.stringify({
          nodes: normalizedIncomingMap.nodes,
          edges: normalizedIncomingMap.edges,
        })
        if (!contentChanged && existing) return sendJson(response, 200, { map: existing, summary: mapSummary(existing) })
        const suppressedWorkNotificationNodeIds = new Set(
          (Array.isArray(body.suppressWorkNotificationNodeIds) ? body.suppressWorkNotificationNodeIds : [])
            .filter((nodeId) => typeof nodeId === 'string' && body.map.nodes.some((node) => node.id === nodeId))
            .slice(0, 100),
        )
        const map = await saveMap(mapId, normalizedIncomingMap, user, undefined, undefined, 'content')
        await createWorkChangeNotifications(existing, map, user, suppressedWorkNotificationNodeIds)
        await createWaitingReleaseNotifications(existing, map, user, {
          includeActor: hasValidIntegrationBearer(request),
        })
        if (contentChanged) broadcastMapChange(request, mapId, 'content', user)
        return sendJson(response, 200, { map, summary: mapSummary(map) })
      }

      if (request.method === 'PATCH') {
        if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 문서 정보를 변경할 수 없습니다.' })
        const existing = await readMap(mapId)
        if (!existing) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
        if (existing?.trashedAt) return sendJson(response, 409, { error: '휴지통에 있는 문서는 변경할 수 없습니다.' })
        const body = await readJsonBody(request)
        const hasTitle = typeof body.title === 'string'
        const hasColor = typeof body.color === 'string'
        if (!hasTitle && !hasColor) return sendJson(response, 400, { error: '변경할 문서 정보를 입력해 주세요.' })
        const baseVersion = Number(body.baseVersion)
        if (Number.isInteger(baseVersion) && baseVersion !== existing.version && body.force !== true) {
          return sendJson(response, 409, {
            error: '다른 사용자가 먼저 문서 정보를 변경했습니다.',
            code: 'VERSION_CONFLICT',
            map: existing,
            summary: mapSummary(existing),
          })
        }
        const title = hasTitle ? normalizeTitle(body.title, '') : existing.title
        if (!title) return sendJson(response, 400, { error: '문서 이름을 입력해 주세요.' })
        if (hasColor && !mapColors.includes(body.color)) return sendJson(response, 400, { error: '올바르지 않은 문서 색상입니다.' })
        const nextColor = hasColor ? body.color : existing.color
        const metadataChanged = title !== existing.title || nextColor !== existing.color
        const map = await saveMap(
          mapId,
          { nodes: existing.nodes, edges: existing.edges },
          user,
          title,
          nextColor,
          hasTitle && hasColor ? 'metadata' : hasTitle ? 'rename' : 'color',
        )
        if (metadataChanged) broadcastMapChange(request, mapId, hasTitle && hasColor ? 'metadata' : hasTitle ? 'rename' : 'color', user)
        return sendJson(response, 200, { map, summary: mapSummary(map) })
      }

      if (request.method === 'DELETE') {
        if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 문서를 휴지통으로 이동할 수 없습니다.' })
        const maps = await listMaps()
        if (maps.length <= 1) return sendJson(response, 409, { error: '마지막 문서는 휴지통으로 이동할 수 없습니다.' })
        const map = await trashMap(mapId, user)
        if (!map) return sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
        const remainingMaps = maps.filter((item) => item.id !== mapId)
        const documentLayout = await reconcileDocumentLayout(remainingMaps.map((item) => item.id))
        broadcastMapChange(request, mapId, 'trashed', user)
        return sendJson(response, 200, {
          trashedId: mapId,
          maps: await listMaps(),
          documentLayout,
          trash: await listMaps({ trashedOnly: true }),
        })
      }
    }

    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveStatic(request, response, url.pathname)) return
    }

    return sendJson(response, 404, { error: '요청한 경로를 찾을 수 없습니다.' })
  } catch (error) {
    if (error?.message === 'PAYLOAD_TOO_LARGE') return sendJson(response, 413, { error: '요청 데이터가 너무 큽니다.' })
    if (error instanceof SyntaxError) return sendJson(response, 400, { error: 'JSON 형식이 올바르지 않습니다.' })
    console.error(error)
    return sendJson(response, 500, { error: '서버 오류가 발생했습니다.' })
  }
})

setInterval(() => {
  broadcastEvent({ type: 'heartbeat', sentAt: new Date().toISOString() })
}, eventHeartbeatIntervalMs).unref()

setInterval(() => {
  void refreshVisibleAiConversationRuntimes().catch((error) => console.warn('[AI conversation runtime poll]', error))
}, aiConversationRuntimePollIntervalMs).unref()

setInterval(() => {
  void pollAiDelegations().catch((error) => console.warn('[AI delegation poll]', error))
}, aiDelegationPollIntervalMs).unref()

setInterval(() => {
  void ensureDailyBackups().catch((error) => console.warn('[Daily backup scheduler]', error))
}, 60 * 60 * 1000).unref()

server.listen(port, host, () => {
  console.log(`[Mind & Progress API] http://${host}:${port}`)
  console.log(`[Mind & Progress Public] ${publicBaseUrl}`)
  void recoverLinkedConversationAttributions().catch((error) => {
    console.warn('[AI conversation attribution startup recovery]', error)
  })
})
