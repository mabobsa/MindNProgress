import { createHash } from 'node:crypto'

import { DoorayTaskError } from './doorayTasks.mjs'

// Dooray API는 응답 헤더로 한도를 알려 준다. (replenish-rate 5/s, burst-capacity 20)
// 한도에 붙여 쓰면 429가 섞이므로 여유를 두고 4.5/s, burst 15로 요청한다.
export const DOORAY_MENTION_RATE_PER_SECOND = 4.5
export const DOORAY_MENTION_RATE_BURST = 15
export const DOORAY_MENTION_CONCURRENCY = 8
export const DOORAY_MENTION_MAX_RANGE_DAYS = 180
export const DOORAY_MENTION_EXCERPT_LENGTH = 400
export const DOORAY_MENTION_CACHE_RETENTION_DAYS = 60
export const DOORAY_MENTION_ACK_RETENTION_DAYS = 180
export const DOORAY_MENTION_MAX_STORED_ITEMS = 2_000

const defaultWebHostname = 'nhnent.dooray.com'
const webHostnamePattern = /^(?:[a-z0-9-]+\.)+dooray\.com$/i
const projectPageSize = 100
const postPageSize = 100
const commentPageSize = 100
const maximumPostPages = 20
const projectScopes = [
  { scope: 'private', type: 'public' },
  { scope: 'public', type: 'public' },
  { scope: 'private', type: 'private' },
]

export const DOORAY_MENTION_KINDS = Object.freeze([
  'mention-comment',
  'mention-body',
  'assigned',
  'cc',
  'related-comment',
])

const mentionKindOrder = new Map(DOORAY_MENTION_KINDS.map((kind, index) => [kind, index]))

function defaultSleep(durationMs) {
  return new Promise((resolve) => { setTimeout(resolve, durationMs) })
}

export function normalizeDoorayWebHostname(value) {
  const hostname = String(value ?? '').trim().toLowerCase()
  if (!hostname) return defaultWebHostname
  if (!webHostnamePattern.test(hostname)) {
    throw new DoorayTaskError('CONFIG_INVALID', 'Dooray 웹 주소가 올바르지 않습니다.', 503)
  }
  return hostname
}

export function createDoorayRateLimiter({
  ratePerSecond = DOORAY_MENTION_RATE_PER_SECOND,
  burst = DOORAY_MENTION_RATE_BURST,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  let tokens = burst
  let refilledAt = now()
  let queue = Promise.resolve()

  async function takeToken() {
    for (;;) {
      const currentTime = now()
      tokens = Math.min(burst, tokens + ((currentTime - refilledAt) / 1_000) * ratePerSecond)
      refilledAt = currentTime
      if (tokens >= 1) {
        tokens -= 1
        return
      }
      await sleep(Math.max(10, Math.ceil(((1 - tokens) / ratePerSecond) * 1_000)))
    }
  }

  // 토큰 확인과 차감 사이에 다른 호출이 끼어들면 한도를 넘기므로 직렬로 처리한다.
  return function acquire() {
    const next = queue.then(takeToken)
    queue = next.then(() => undefined, () => undefined)
    return next
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runnerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: runnerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}

export function createDoorayRequester(config, {
  fetchImpl = fetch,
  sleep = defaultSleep,
  timeoutMs = 15_000,
  maxRetries = 4,
  acquire = createDoorayRateLimiter({ sleep }),
} = {}) {
  if (!config?.apiKey) {
    throw new DoorayTaskError('CONFIG_UNAVAILABLE', 'Dooray API 키가 설정되어 있지 않습니다.', 503)
  }
  const stats = { requestCount: 0, throttledCount: 0, failureCount: 0 }

  async function request(endpointPath) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await acquire()
      stats.requestCount += 1
      let response
      try {
        response = await fetchImpl(`${config.baseUrl}${endpointPath}`, {
          headers: {
            Authorization: `dooray-api ${config.apiKey}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        if (attempt === maxRetries) {
          stats.failureCount += 1
          return null
        }
        await sleep(500 * (attempt + 1))
        continue
      }
      if (response.status === 429) {
        stats.throttledCount += 1
        if (attempt === maxRetries) {
          stats.failureCount += 1
          return null
        }
        await sleep(600 * (attempt + 1))
        continue
      }
      // 권한이 없거나 삭제된 업무는 건너뛴다. 수집 전체를 중단시키지 않는다.
      if (response.status === 401 || response.status === 403 || response.status === 404) return null
      if (!response.ok) {
        if (attempt === maxRetries) {
          stats.failureCount += 1
          return null
        }
        await sleep(500 * (attempt + 1))
        continue
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        stats.failureCount += 1
        return null
      }
      return payload?.header?.isSuccessful === true ? payload : null
    }
    return null
  }

  return { request, stats }
}

async function requestDoorayMentionProjects(request, onProgress = () => {}) {
  const groups = await mapWithConcurrency(projectScopes, projectScopes.length, async ({ scope, type }) => {
    const payload = await request(
      `/project/v1/projects?member=me&scope=${scope}&type=${type}&state=active&size=${projectPageSize}`,
    )
    onProgress()
    return payload?.result ?? []
  })
  const projectsById = new Map()
  for (const project of groups.flat()) {
    const id = String(project?.id ?? '').trim()
    if (!id) continue
    const existing = projectsById.get(id)
    projectsById.set(id, {
      id,
      code: String(project?.code ?? '').trim() || existing?.code || '',
      name: String(project?.name ?? '').trim() || existing?.name || '',
    })
  }
  return [...projectsById.values()].sort((left, right) => {
    const leftLabel = left.name || left.code || left.id
    const rightLabel = right.name || right.code || right.id
    return leftLabel.localeCompare(rightLabel, 'ko')
  })
}

export async function listDoorayMentionProjects(config, {
  fetchImpl = fetch,
  sleep = defaultSleep,
  timeoutMs = 15_000,
} = {}) {
  const { request, stats } = createDoorayRequester(config, { fetchImpl, sleep, timeoutMs })
  const projects = await requestDoorayMentionProjects(request)
  return { projects, ...stats }
}

const markdownMentionPattern = /\[@[^\]\n]{0,80}\]\(dooray:\/\/\d+\/members\/(\d+)[^)]*\)/g
const anchorTagPattern = /<a\b[^>]*>/gi
const anchorMemberIdPattern = /data-id="(\d+)"/i
const anchorHrefMemberPattern = /dooray:\/\/\d+\/members\/(\d+)/i

export function extractDoorayMentionMemberIds(content) {
  const text = String(content ?? '')
  if (!text) return []
  const memberIds = new Set()
  for (const match of text.matchAll(markdownMentionPattern)) memberIds.add(match[1])
  for (const match of text.matchAll(anchorTagPattern)) {
    const tag = match[0]
    const memberId = anchorMemberIdPattern.exec(tag)?.[1] ?? anchorHrefMemberPattern.exec(tag)?.[1]
    if (memberId) memberIds.add(memberId)
  }
  return [...memberIds]
}

export function mentionsDoorayMember(content, memberId) {
  const target = String(memberId ?? '').trim()
  if (!target) return false
  const text = String(content ?? '')
  // 본문에 해당 숫자가 아예 없으면 정규식을 돌리지 않는다.
  if (!text.includes(target)) return false
  return extractDoorayMentionMemberIds(text).includes(target)
}

const htmlEntities = new Map([
  ['&nbsp;', ' '],
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
])

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) => htmlEntities.get(entity) ?? entity)
    .replace(/&#(\d{1,6});/g, (_match, code) => {
      const codePoint = Number(code)
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match
    })
}

export function plainDoorayText(content, mimeType) {
  let text = String(content ?? '')
  if (!text) return ''
  if (mimeType !== 'text/html') {
    text = text.replace(markdownMentionPattern, (match) => {
      const label = /\[@([^\]\n]{0,80})\]/.exec(match)?.[1]
      return label ? `@${label}` : match
    })
    text = text.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '[이미지]')
  }
  // Dooray 마크다운 본문에도 <br>·<table>·<details> 같은 HTML이 그대로 섞여 들어온다.
  text = text.replace(/<a\b[^>]*>(@[^<]{0,80})<\/a>/gi, '$1')
  text = text.replace(/<br\s*\/?>/gi, ' ')
  text = text.replace(/<\/(?:p|div|tr|li|h[1-6]|summary|details)>/gi, ' ')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeHtmlEntities(text)
  if (mimeType !== 'text/html') {
    // Dooray 마크다운은 밑줄 등을 역슬래시로 이스케이프해서 보관한다.
    text = text.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1')
  }
  return text.replace(/\s+/g, ' ').trim()
}

export function doorayMentionExcerpt(content, mimeType, limit = DOORAY_MENTION_EXCERPT_LENGTH) {
  const text = plainDoorayText(content, mimeType)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function contentDigest(value) {
  return createHash('sha1').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 12)
}

export function doorayMentionItemKey(item) {
  if (item.kind === 'mention-comment' || item.kind === 'related-comment') {
    return `comment:${item.postId}:${item.commentId}`
  }
  if (item.kind === 'mention-body') return `post-body:${item.postId}:${item.bodyDigest}`
  return `post-role:${item.postId}:${item.kind}`
}

export function doorayTaskWebUrl(webHostname, projectId, postId, commentId = null) {
  const base = `https://${webHostname}/task/${projectId}/${postId}`
  return commentId ? `${base}#comment-${commentId}` : base
}

function memberIdOf(entry) {
  return String(entry?.member?.organizationMemberId ?? '').trim()
}

function memberNameOf(entry) {
  const candidates = [
    entry?.member?.name,
    entry?.emailUser?.name,
    entry?.emailUser?.emailAddress,
    entry?.group?.name,
  ]
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() ?? ''
}

function isoOrNull(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function buildPostItems(post, body, comments, {
  meId,
  webHostname,
  includeBody,
  includeComments,
  includeAssigned,
  includeCc,
}) {
  const projectId = String(post?.project?.id ?? post?._projectId ?? '').trim()
  const postId = String(post?.id ?? '').trim()
  if (!projectId || !postId) return []

  const shared = {
    projectId,
    projectCode: String(post?.project?.code ?? post?._projectCode ?? '').trim(),
    postId,
    postNumber: Number.isFinite(post?.number) ? post.number : null,
    taskNumber: String(post?.taskNumber ?? '').trim(),
    subject: String(post?.subject ?? '').trim().slice(0, 240),
    workflowName: String(post?.workflow?.name ?? '').trim().slice(0, 120),
    workflowClass: String(post?.workflowClass ?? '').trim().slice(0, 40),
    closed: post?.closed === true,
  }

  const assignedIds = (post?.users?.to ?? []).map(memberIdOf).filter(Boolean)
  const ccIds = (post?.users?.cc ?? []).map(memberIdOf).filter(Boolean)
  const isAssigned = assignedIds.includes(meId)
  const isCc = ccIds.includes(meId)
  const selectedRole = includeAssigned && isAssigned
    ? 'assigned'
    : includeCc && isCc ? 'cc' : null
  const isSelectedRelated = selectedRole !== null
  // 내가 등록하고 나를 지정한 업무는 확인할 대상이 아니다. (일일 취합 등 자동 생성 업무가 여기 해당한다)
  const authoredByMe = memberIdOf(post?.users?.from) === meId
  const items = []

  if (includeBody && !authoredByMe && body && mentionsDoorayMember(body.content, meId)) {
    const occurredAt = isoOrNull(post?.updatedAt) ?? isoOrNull(post?.createdAt)
    if (occurredAt) {
      items.push({
        ...shared,
        kind: 'mention-body',
        commentId: null,
        occurredAt,
        actorMemberId: memberIdOf(post?.users?.from),
        actorName: memberNameOf(post?.users?.from),
        bodyDigest: contentDigest(body.content),
        excerpt: doorayMentionExcerpt(body.content, body.mimeType),
        url: doorayTaskWebUrl(webHostname, projectId, postId),
      })
    }
  }

  if (isSelectedRelated && !authoredByMe) {
    const occurredAt = isoOrNull(post?.createdAt)
    if (occurredAt) {
      items.push({
        ...shared,
        kind: selectedRole,
        commentId: null,
        occurredAt,
        actorMemberId: memberIdOf(post?.users?.from),
        actorName: memberNameOf(post?.users?.from),
        excerpt: body ? doorayMentionExcerpt(body.content, body.mimeType) : '',
        url: doorayTaskWebUrl(webHostname, projectId, postId),
      })
    }
  }

  for (const comment of comments) {
    const commentId = String(comment?.id ?? '').trim()
    const occurredAt = isoOrNull(comment?.createdAt)
    if (!commentId || !occurredAt) continue
    const commentBody = comment?.body ?? {}
    const mentioned = mentionsDoorayMember(commentBody.content, meId)
    if (!(includeComments && mentioned) && !isSelectedRelated) continue
    const actorMemberId = memberIdOf(comment?.creator)
    // 내가 남긴 댓글은 확인할 대상이 아니다.
    if (actorMemberId === meId) continue
    items.push({
      ...shared,
      kind: includeComments && mentioned ? 'mention-comment' : 'related-comment',
      commentId,
      occurredAt,
      actorMemberId,
      actorName: memberNameOf(comment?.creator),
      excerpt: doorayMentionExcerpt(commentBody.content, commentBody.mimeType),
      url: doorayTaskWebUrl(webHostname, projectId, postId, commentId),
    })
  }

  return items.map((item) => ({ ...item, key: doorayMentionItemKey(item) }))
}

export function sortDoorayMentionItems(items) {
  return [...items].sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? 1 : -1
    const leftOrder = mentionKindOrder.get(left.kind) ?? 99
    const rightOrder = mentionKindOrder.get(right.kind) ?? 99
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return left.key < right.key ? -1 : 1
  })
}

export function pruneDoorayMentionCache(cache, { now = () => new Date(), retentionDays = DOORAY_MENTION_CACHE_RETENTION_DAYS } = {}) {
  const threshold = now().getTime() - retentionDays * 24 * 60 * 60 * 1_000
  const pruned = {}
  for (const [postId, entry] of Object.entries(cache ?? {})) {
    const seenAt = Date.parse(String(entry?.seenAt ?? ''))
    if (Number.isFinite(seenAt) && seenAt >= threshold) pruned[postId] = entry
  }
  return pruned
}

export function normalizeDoorayMentionRange({ since, until, now = () => new Date() }) {
  const untilTime = Date.parse(String(until ?? '')) || now().getTime()
  const sinceTime = Date.parse(String(since ?? ''))
  if (!Number.isFinite(sinceTime)) {
    throw new DoorayTaskError('INVALID_RANGE', '조회 시작 시각이 올바르지 않습니다.', 400)
  }
  if (sinceTime >= untilTime) {
    throw new DoorayTaskError('INVALID_RANGE', '조회 시작 시각은 종료 시각보다 앞서야 합니다.', 400)
  }
  const rangeDays = (untilTime - sinceTime) / (24 * 60 * 60 * 1_000)
  if (rangeDays > DOORAY_MENTION_MAX_RANGE_DAYS) {
    throw new DoorayTaskError('INVALID_RANGE', `조회 기간은 최대 ${DOORAY_MENTION_MAX_RANGE_DAYS}일까지 지정할 수 있습니다.`, 400)
  }
  return { since: new Date(sinceTime).toISOString(), until: new Date(untilTime).toISOString() }
}

export async function collectDoorayMentions({
  config,
  since,
  until,
  projectIds = [],
  projectCodes = [],
  includeBody = true,
  includeComments = true,
  includeAssigned = true,
  includeCc = includeAssigned,
  webHostname = defaultWebHostname,
  cache = {},
}, {
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = () => new Date(),
  onProgress = () => {},
  concurrency = DOORAY_MENTION_CONCURRENCY,
  timeoutMs = 15_000,
} = {}) {
  const range = normalizeDoorayMentionRange({ since, until, now })
  const host = normalizeDoorayWebHostname(webHostname)
  const { request, stats } = createDoorayRequester(config, { fetchImpl, sleep, timeoutMs })
  const startedAt = now().toISOString()
  const report = (phase, done, total) => { onProgress({ phase, done, total }) }

  report('me', 0, 1)
  const me = (await request('/common/v1/members/me'))?.result
  const meId = String(me?.id ?? '').trim()
  if (!meId) {
    throw new DoorayTaskError('ACCESS_DENIED', 'Dooray 사용자 정보를 확인하지 못했습니다.', 403)
  }
  report('me', 1, 1)

  const selectedProjectIds = [...new Set(projectIds.map((value) => String(value).trim()).filter(Boolean))]
  let projects
  if (selectedProjectIds.length > 0) {
    // 프로젝트 선택 화면에서 이미 받은 ID는 다시 전체 프로젝트 목록을 조회하지 않고 바로 사용한다.
    projects = selectedProjectIds.map((id) => ({ id, code: '', name: '' }))
    report('projects', projects.length, projects.length)
  } else {
    let loadedProjectScopes = 0
    report('projects', 0, projectScopes.length)
    projects = await requestDoorayMentionProjects(request, () => {
      loadedProjectScopes += 1
      report('projects', loadedProjectScopes, projectScopes.length)
    })
    if (projectCodes.length > 0) {
      const wanted = new Set(projectCodes.map((value) => String(value).trim()).filter(Boolean))
      projects = projects.filter((project) => wanted.has(project.code) || wanted.has(project.id))
    }
  }

  const sinceParameter = encodeURIComponent(range.since)
  let sweptProjects = 0
  report('posts', 0, projects.length)
  const postGroups = await mapWithConcurrency(projects, concurrency, async (project) => {
    const collected = []
    for (let page = 0; page < maximumPostPages; page += 1) {
      const payload = await request(
        `/project/v1/projects/${project.id}/posts?size=${postPageSize}&page=${page}`
        + `&order=-postUpdatedAt&updatedAt=${sinceParameter}`,
      )
      const rows = payload?.result ?? []
      for (const row of rows) {
        row._projectId = project.id
        row._projectCode = project.code
        collected.push(row)
      }
      if (rows.length < postPageSize) break
    }
    sweptProjects += 1
    report('posts', sweptProjects, projects.length)
    return collected
  })
  const posts = postGroups.flat()

  const scanTime = now().toISOString()
  const nextCache = {}
  let probedPosts = 0
  report('details', 0, posts.length)
  const itemGroups = await mapWithConcurrency(posts, concurrency, async (post) => {
    const postId = String(post?.id ?? '').trim()
    const updatedAt = String(post?.updatedAt ?? '').trim()
    const cached = cache?.[postId]
    // 업무의 updatedAt은 댓글이 달려도 갱신된다. 단, 수집 옵션에 따라 항목 구성이
    // 달라지므로 같은 옵션으로 만든 캐시만 재사용한다.
    const cacheMatchesOptions = cached?.includeBody === includeBody
      && cached?.includeComments === includeComments
      && cached?.includeAssigned === includeAssigned
      && cached?.includeCc === includeCc
    if (cached && cached.updatedAt === updatedAt && cacheMatchesOptions && Array.isArray(cached.items)) {
      nextCache[postId] = {
        updatedAt,
        seenAt: scanTime,
        includeBody,
        includeComments,
        includeAssigned,
        includeCc,
        items: cached.items,
      }
      probedPosts += 1
      report('details', probedPosts, posts.length)
      return cached.items
    }

    // 상세 본문과 댓글은 서로 의존하지 않는다. 같은 업무의 두 요청을 함께 시작해
    // 업무마다 왕복 시간을 두 번 연속 기다리지 않도록 한다.
    const [detail, logs] = await Promise.all([
      includeBody
        ? request(`/project/v1/projects/${post._projectId}/posts/${postId}`)
        : Promise.resolve(null),
      includeComments || includeAssigned || includeCc
        ? request(`/project/v1/projects/${post._projectId}/posts/${postId}/logs?size=${commentPageSize}`)
        : Promise.resolve(null),
    ])

    let body = null
    const result = detail?.result
    if (result) {
      body = result.body ?? null
      if (result.project?.id) post.project = result.project
      if (result.users) post.users = result.users
    }
    const comments = (logs?.result ?? []).filter((entry) => entry?.type === 'comment')
    const items = buildPostItems(post, body, comments, {
      meId,
      webHostname: host,
      includeBody,
      includeComments,
      includeAssigned,
      includeCc,
    })
    nextCache[postId] = {
      updatedAt,
      seenAt: scanTime,
      includeBody,
      includeComments,
      includeAssigned,
      includeCc,
      items,
    }
    probedPosts += 1
    report('details', probedPosts, posts.length)
    return items
  })

  const inRange = itemGroups
    .flat()
    .filter((item) => item.occurredAt >= range.since && item.occurredAt <= range.until)

  const nameById = new Map([[meId, String(me?.name ?? '').trim()]])
  const unresolved = [...new Set(
    inRange
      .filter((item) => !item.actorName && item.actorMemberId)
      .map((item) => item.actorMemberId),
  )]
  report('members', 0, unresolved.length)
  for (const [index, memberId] of unresolved.entries()) {
    const payload = await request(`/common/v1/members/${memberId}`)
    nameById.set(memberId, String(payload?.result?.name ?? '').trim())
    report('members', index + 1, unresolved.length)
  }
  const items = sortDoorayMentionItems(inRange.map((item) => ({
    ...item,
    actorName: item.actorName || nameById.get(item.actorMemberId) || '',
  })))

  report('done', posts.length, posts.length)
  return {
    me: { id: meId, name: String(me?.name ?? '').trim() },
    since: range.since,
    until: range.until,
    webHostname: host,
    projectCount: projects.length,
    scannedPostCount: posts.length,
    items,
    cache: pruneDoorayMentionCache({ ...cache, ...nextCache }, { now }),
    requestCount: stats.requestCount,
    throttledCount: stats.throttledCount,
    failureCount: stats.failureCount,
    startedAt,
    finishedAt: now().toISOString(),
  }
}

export function mergeDoorayMentionAcks(items, acks = {}) {
  return items.map((item) => {
    const acknowledgedAt = typeof acks?.[item.key]?.acknowledgedAt === 'string'
      ? acks[item.key].acknowledgedAt
      : null
    return { ...item, acknowledgedAt }
  })
}

// 확인 표시는 조회 기간 밖으로 밀려나도 유지해야 한다.
// 기간을 좁혀 다시 수집했다는 이유로 이미 확인한 항목이 되살아나면 안 된다.
export function pruneDoorayMentionAcks(acks, {
  now = () => new Date(),
  retentionDays = DOORAY_MENTION_ACK_RETENTION_DAYS,
} = {}) {
  const threshold = now().getTime() - retentionDays * 24 * 60 * 60 * 1_000
  const pruned = {}
  for (const [key, value] of Object.entries(acks ?? {})) {
    const acknowledgedAt = Date.parse(String(value?.acknowledgedAt ?? ''))
    if (Number.isFinite(acknowledgedAt) && acknowledgedAt >= threshold) pruned[key] = value
  }
  return pruned
}
