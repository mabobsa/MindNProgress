import { createServer } from 'node:http'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectDirectory = path.resolve(serverDirectory, '..')
const dataDirectory = path.resolve(String(process.env.MNP_DATA_DIR ?? '').trim() || path.join(serverDirectory, 'data'))
const historyDirectory = path.join(dataDirectory, '_history')
const dailyBackupDirectory = path.join(dataDirectory, '_daily-backups')
const commentsDirectory = path.join(dataDirectory, '_comments')
const notificationsDirectory = path.join(dataDirectory, '_notifications')
const usersFile = path.join(dataDirectory, '_users.json')
const sessionsFile = path.join(dataDirectory, '_sessions.json')
const integrationTokenFile = path.join(dataDirectory, '_integration-token')
const mapOrderFile = path.join(dataDirectory, '_map-order.json')
const distDirectory = path.join(projectDirectory, 'dist')
const port = Number(process.env.MNP_API_PORT ?? 4176)
const host = process.env.MNP_API_HOST ?? '127.0.0.1'
const configuredAionUiBaseUrl = String(process.env.MNP_AIONUI_URL ?? '').trim()
const aionUiBaseUrls = (configuredAionUiBaseUrl
  ? [configuredAionUiBaseUrl]
  : ['http://127.0.0.1:1986', 'http://127.0.0.1:5830'])
  .map((baseUrl) => baseUrl.replace(/\/+$/, ''))
let activeAionUiBaseUrl = aionUiBaseUrls[0]
const sessionDurationMs = 8 * 60 * 60 * 1000
const rememberedSessionDurationMs = 30 * 24 * 60 * 60 * 1000
const sessions = new Map()
let sessionWriteQueue = Promise.resolve()
const eventClients = new Map()
const mapColors = ['violet', 'indigo', 'blue', 'cyan', 'teal', 'green', 'amber', 'orange', 'red', 'pink']
const commentReactions = ['👍', '❤️', '🎉', '👀']
const serverStartedAt = new Date().toISOString()

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
  name: 'AionUi AI',
  email: 'aionui-ai@mind.invalid',
  role: 'editor',
  active: true,
}
let integrationToken = ''

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

function requestClientId(request) {
  return String(request.headers['x-mnp-client'] ?? '').slice(0, 120) || null
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
    try {
      client.write(message)
    } catch {
      eventClients.delete(client)
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

function getCurrentUser(request) {
  const authorization = String(request.headers.authorization ?? '')
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (bearerToken && integrationToken) {
    const candidate = Buffer.from(bearerToken)
    const expected = Buffer.from(integrationToken)
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return integrationUser
  }

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

function requireUser(request, response) {
  const user = getCurrentUser(request)
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
  return map.nodes.every((node) => typeof node?.id === 'string' && node.id.length <= 120)
    && map.edges.every((edge) => typeof edge?.id === 'string' && typeof edge?.source === 'string' && typeof edge?.target === 'string')
}

function normalizeMapEdges(map) {
  if (!map || !Array.isArray(map.edges)) return map
  return {
    ...map,
    edges: map.edges.map((edge) => ({
      ...edge,
      type: 'bezier',
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

function isValidMapId(mapId) {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(mapId)
}

function mapFileForId(mapId) {
  if (!isValidMapId(mapId)) throw new Error('INVALID_MAP_ID')
  return path.join(dataDirectory, `${mapId}.json`)
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

function mapSummary(map) {
  return {
    id: map.id,
    title: map.title,
    color: normalizeMapColor(map.color, defaultMapColor(map.id)),
    nodeCount: map.nodes.length,
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
    return normalizeMapAssignees(normalizeMapEdges({
      ...stored,
      id: mapId,
      title: normalizeTitle(stored.title, '새 마인드맵'),
      createdAt: stored.createdAt ?? stored.updatedAt ?? null,
      createdBy: stored.createdBy ?? stored.updatedBy ?? null,
      version: Number.isInteger(stored.version) && stored.version > 0 ? stored.version : 1,
    }))
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
  const savedOrder = await readMapOrder()
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

async function readMapOrder() {
  try {
    const order = JSON.parse(await readFile(mapOrderFile, 'utf8'))
    return Array.isArray(order) ? order.filter((mapId) => typeof mapId === 'string' && isValidMapId(mapId)) : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function writeMapOrder(mapIds) {
  await mkdir(dataDirectory, { recursive: true })
  const temporaryFile = `${mapOrderFile}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(mapIds, null, 2)}\n`, 'utf8')
  await replaceFileWithRetry(temporaryFile, mapOrderFile)
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

async function fetchAionUi(pathname) {
  let lastError = null
  const candidates = [activeAionUiBaseUrl, ...aionUiBaseUrls.filter((baseUrl) => baseUrl !== activeAionUiBaseUrl)]
  for (const baseUrl of candidates) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.success === false) throw new Error(`AIONUI_REQUEST_FAILED:${response.status}`)
      activeAionUiBaseUrl = baseUrl
      return body?.data ?? body
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('AIONUI_REQUEST_FAILED')
}

function normalizeAionUiOption(option) {
  return {
    id: String(option?.value ?? option?.id ?? ''),
    label: String(option?.name ?? option?.label ?? option?.value ?? option?.id ?? ''),
    description: typeof option?.description === 'string' ? option.description : '',
  }
}

function normalizeAionUiAgent(agent, providers) {
  const configOptions = Array.isArray(agent?.config_options?.config_options) ? agent.config_options.config_options : []
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
  const notification = {
    id: `notification-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    userId: user.id,
    createdAt: new Date().toISOString(),
    readAt: null,
    ...payload,
  }
  const notifications = await listNotifications(user.id)
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

async function createWorkChangeNotifications(existing, map, actor) {
  const previousNodes = new Map((existing?.nodes ?? []).map((node) => [node.id, node]))
  for (const node of map.nodes) {
    if (!node.data?.isWork) continue
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
  return JSON.stringify({ title: map.title, color: map.color, nodes: map.nodes, edges: map.edges })
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
      ? { ...backup, map: normalizeMapAssignees(normalizeMapEdges(backup.map)) }
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
      ? { ...revision, map: normalizeMapAssignees(normalizeMapEdges(revision.map)) }
      : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function saveMap(mapId, map, user, title, color, revisionReason = 'edit') {
  await mkdir(dataDirectory, { recursive: true })
  const existing = await readMap(mapId)
  const now = new Date().toISOString()
  const normalizedMap = normalizeMapAssignees(map)
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
  if (existing && !existing.trashedAt && mapContentSignature(existing) !== mapContentSignature(payload)) {
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

  const mapOrder = await readMapOrder()
  const nextMapOrder = mapOrder.filter((mapId) => !deletedMapIds.has(mapId))
  if (nextMapOrder.length !== mapOrder.length) await writeMapOrder(nextMapOrder)
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
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { status: 'ok' })
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
        const normalizedSkills = (Array.isArray(skills) ? skills : []).map((skill) => ({
          id: String(skill.name),
          name: String(skill.name),
          description: String(skill.description ?? ''),
          autoInject: skill.is_auto_inject === true,
        }))
        const normalizedMcpServers = (Array.isArray(mcpServers) ? mcpServers : [])
          .filter((server) => server?.enabled !== false)
          .map((server) => ({
            id: String(server.id),
            name: String(server.name ?? server.id),
            description: String(server.description ?? ''),
            toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
            required: String(server.name ?? '').toLowerCase() === 'mindnprogress',
          }))
        return sendJson(response, 200, {
          connected: true,
          aionUiUrl: activeAionUiBaseUrl,
          protocol: 'aionui://conversation/new',
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
      request.on('close', () => {
        eventClients.delete(response)
        broadcastPresence(mapId)
      })
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
      return sendJson(response, 200, { maps: await listMaps() })
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
      await writeMapOrder((await listMaps()).map((item) => item.id))
      broadcastMapChange(request, mapId, 'created', user)
      return sendJson(response, 201, { map, summary: mapSummary(map) })
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
      await writeMapOrder(requestedIds)
      broadcastEvent({
        type: 'map-changed',
        mapId: null,
        action: 'order',
        sourceClientId: requestClientId(request),
        updatedAt: new Date().toISOString(),
        updatedBy: publicUser(user),
      })
      return sendJson(response, 200, { maps: await listMaps() })
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
      if (target.parentId) return sendJson(response, 400, { error: '답글이 아닌 댓글 스레드에서 해결 상태를 변경해 주세요.' })
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
        return sendJson(response, 200, { comments: await listComments(mapId, nodeId || undefined) })
      }

      if (request.method === 'POST') {
        if (isPublicViewer(user)) return sendJson(response, 403, { error: '공개 뷰어는 댓글을 작성할 수 없습니다.' })
        const body = await readJsonBody(request)
        const nodeId = String(body.nodeId ?? '').slice(0, 120)
        const text = String(body.text ?? '').trim().slice(0, 1000)
        const node = map.nodes.find((item) => item.id === nodeId)
        if (!node) return sendJson(response, 400, { error: '댓글을 남길 노드를 찾을 수 없습니다.' })
        if (!text) return sendJson(response, 400, { error: '댓글 내용을 입력해 주세요.' })
        const comments = await listComments(mapId)
        const requestedParentId = typeof body.parentId === 'string' ? body.parentId : null
        const requestedParent = requestedParentId ? comments.find((item) => item.id === requestedParentId && item.nodeId === nodeId) : null
        if (requestedParentId && !requestedParent) return sendJson(response, 400, { error: '답글을 남길 댓글을 찾을 수 없습니다.' })
        const parent = requestedParent ? comments.find((item) => item.id === (requestedParent.parentId ?? requestedParent.id)) ?? requestedParent : null
        const comment = {
          id: `comment-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
          mapId,
          nodeId,
          text,
          parentId: parent?.id ?? null,
          resolvedAt: null,
          resolvedBy: null,
          reactions: {},
          createdAt: new Date().toISOString(),
          author: publicUser(user),
        }
        await writeStoredArray(commentFileForMap(mapId), [...comments, comment])
        const mentionedIds = new Set(mentionedUsers(text).map((candidate) => candidate.id))
        const notificationResults = await Promise.allSettled(users
          .filter((recipient) => recipient.id !== user.id && recipient.active !== false && !isPublicViewer(recipient))
          .map((recipient) => createNotification(recipient, {
            type: mentionedIds.has(recipient.id) ? 'mention' : parent?.author.id === recipient.id ? 'reply' : 'comment',
            mapId,
            mapTitle: map.title,
            nodeId,
            nodeLabel: node.data.label,
            commentId: comment.id,
            message: text.slice(0, 180),
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
      await writeMapOrder(maps.map((item) => item.id))
      broadcastMapChange(request, mapId, 'trash-restored', user)
      return sendJson(response, 200, {
        map,
        summary: mapSummary(map),
        maps,
        trash: await listMaps({ trashedOnly: true }),
      })
    }

    const mapRoute = url.pathname.match(/^\/api\/maps\/([^/]+)$/)
    if (mapRoute) {
      const mapId = decodeURIComponent(mapRoute[1])
      if (!isValidMapId(mapId)) return sendJson(response, 400, { error: '올바르지 않은 문서 ID입니다.' })
      const user = requireUser(request, response)
      if (!user) return

      if (request.method === 'GET') {
        const map = await readMap(mapId)
        return map && !map.trashedAt
          ? sendJson(response, 200, { map })
          : sendJson(response, 404, { error: '마인드맵을 찾을 수 없습니다.' })
      }

      if (request.method === 'PUT') {
        if (!canEdit(user)) return sendJson(response, 403, { error: '뷰어는 마인드맵을 변경할 수 없습니다.' })
        const existing = await readMap(mapId)
        if (existing?.trashedAt) return sendJson(response, 409, { error: '휴지통에 있는 문서는 변경할 수 없습니다.' })
        const body = await readJsonBody(request)
        if (!isValidMap(body.map)) return sendJson(response, 400, { error: '올바르지 않은 마인드맵 데이터입니다.' })
        const baseVersion = Number(body.baseVersion)
        if (existing && Number.isInteger(baseVersion) && baseVersion !== existing.version && body.force !== true) {
          return sendJson(response, 409, {
            error: '다른 사용자가 먼저 문서를 변경했습니다.',
            code: 'VERSION_CONFLICT',
            map: existing,
            summary: mapSummary(existing),
          })
        }
        const contentChanged = !existing || JSON.stringify({ nodes: existing.nodes, edges: existing.edges }) !== JSON.stringify({ nodes: body.map.nodes, edges: body.map.edges })
        if (!contentChanged && existing) return sendJson(response, 200, { map: existing, summary: mapSummary(existing) })
        const map = await saveMap(mapId, body.map, user, undefined, undefined, 'content')
        await createWorkChangeNotifications(existing, map, user)
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
        await writeMapOrder(maps.filter((item) => item.id !== mapId).map((item) => item.id))
        broadcastMapChange(request, mapId, 'trashed', user)
        return sendJson(response, 200, {
          trashedId: mapId,
          maps: await listMaps(),
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
  for (const [client] of eventClients) {
    try {
      client.write(': keep-alive\n\n')
    } catch {
      eventClients.delete(client)
    }
  }
}, 25_000).unref()

setInterval(() => {
  void ensureDailyBackups().catch((error) => console.warn('[Daily backup scheduler]', error))
}, 60 * 60 * 1000).unref()

server.listen(port, host, () => {
  console.log(`[Mind & Progress API] http://${host}:${port}`)
})
