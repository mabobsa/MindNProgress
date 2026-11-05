import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  DOORAY_MENTION_MAX_RANGE_DAYS,
  collectDoorayMentions,
  createDoorayRequester,
  pruneDoorayMentionAcks,
} from '../../../server/lib/doorayMentions.mjs'

// 멘션 수집·판정은 MnP의 Dooray 참조 기능과 같은 모듈을 그대로 쓴다.
// 이 파일은 확인함에 필요한 확인 표시 저장, 번호 목록, 상세 조회만 담당한다.

export const DEFAULT_DOORAY_API_BASE_URL = 'https://api.dooray.com'
export const DEFAULT_DOORAY_WEB_HOSTNAME = 'nhnent.dooray.com'
export const DEFAULT_RANGE_DAYS = 14
export const STATE_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1_000
const DETAIL_BODY_LIMIT = 20_000
const DETAIL_COMMENT_LIMIT = 4_000
const DETAIL_COMMENT_PAGE_SIZE = 100
const MAX_ACK_SNAPSHOTS = 2_000

export { KIND_LABELS } from '../shared/inbox-shared.mjs'

export class InboxError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'InboxError'
    this.code = code
  }
}

export function defaultStateDirectory({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const configured = String(env.DOORAY_MENTION_INBOX_STATE_DIR ?? '').trim()
  if (configured) return configured
  if (platform === 'win32') {
    return path.join(String(env.APPDATA ?? '').trim() || path.join(home, 'AppData', 'Roaming'), 'dooray-mention-inbox')
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'dooray-mention-inbox')
  return path.join(String(env.XDG_STATE_HOME ?? '').trim() || path.join(home, '.local', 'state'), 'dooray-mention-inbox')
}

export function parseProjectCodes(value) {
  return [...new Set(String(value ?? '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]
}

const emptyBucket = () => ({ acks: {}, cache: {}, lastList: [], lastItems: {} })

function normalizeBucket(value) {
  const bucket = value && typeof value === 'object' ? value : {}
  const objectOr = (candidate) => (candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {})
  return {
    acks: objectOr(bucket.acks),
    cache: objectOr(bucket.cache),
    lastList: Array.isArray(bucket.lastList) ? bucket.lastList.filter((key) => typeof key === 'string') : [],
    lastItems: objectOr(bucket.lastItems),
    ...(typeof bucket.lastPresentedAt === 'string' ? { lastPresentedAt: bucket.lastPresentedAt } : {}),
    ...(Number.isInteger(bucket.lastRangeDays) ? { lastRangeDays: bucket.lastRangeDays } : {}),
    ...(bucket.lastScanSummary && typeof bucket.lastScanSummary === 'object' ? { lastScanSummary: bucket.lastScanSummary } : {}),
  }
}

async function readState(file) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: STATE_VERSION, users: {} }
    // 손상된 파일은 덮어쓰기 전에 이름을 바꿔 보존한다.
    if (error instanceof SyntaxError) {
      await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
      return { version: STATE_VERSION, users: {} }
    }
    throw error
  }
  const users = parsed?.version === STATE_VERSION && parsed.users && typeof parsed.users === 'object' ? parsed.users : {}
  return { version: STATE_VERSION, users: Object.fromEntries(Object.entries(users).map(([id, bucket]) => [id, normalizeBucket(bucket)])) }
}

async function writeState(file, state) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function snapshot(item) {
  return {
    kind: item.kind,
    subject: item.subject,
    taskNumber: item.taskNumber,
    actorName: item.actorName,
    occurredAt: item.occurredAt,
    url: item.url,
    excerpt: String(item.excerpt ?? '').slice(0, 200),
    projectId: item.projectId,
    postId: item.postId,
    commentId: item.commentId ?? null,
  }
}

const markdownMentionPattern = /\[@([^\]\n]{0,80})\]\(dooray:\/\/\d+\/members\/\d+[^)]*\)/g

// AI가 이어서 읽을 수 있도록 줄바꿈을 살린 읽기용 본문을 만든다. 목록 미리보기와 달리 공백을 한 줄로 합치지 않는다.
export function readableDoorayText(content, mimeType, limit = DETAIL_BODY_LIMIT) {
  let text = String(content ?? '')
  if (!text) return { text: '', truncated: false }
  text = text.replace(markdownMentionPattern, (_match, label) => `@${label}`)
  if (mimeType === 'text/html' || /<(?:br|p|div|table|tr|li|details)\b/i.test(text)) {
    text = text
      .replace(/<a\b[^>]*>(@[^<]{0,80})<\/a>/gi, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|tr|li|h[1-6]|summary|details)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  }
  text = text.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '[이미지]').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > limit ? { text: `${text.slice(0, limit)}…`, truncated: true } : { text, truncated: false }
}

function memberName(entry) {
  return [entry?.member?.name, entry?.emailUser?.name, entry?.emailUser?.emailAddress, entry?.group?.name]
    .find((value) => typeof value === 'string' && value.trim())?.trim() ?? ''
}

function memberId(entry) {
  return String(entry?.member?.organizationMemberId ?? '').trim()
}

export function createInbox({
  apiKey,
  baseUrl = DEFAULT_DOORAY_API_BASE_URL,
  webHostname = DEFAULT_DOORAY_WEB_HOSTNAME,
  projectCodes = [],
  stateDirectory = defaultStateDirectory(),
  fetchImpl = fetch,
  sleep,
  now = () => new Date(),
  timeoutMs = 15_000,
} = {}) {
  if (!String(apiKey ?? '').trim()) {
    throw new InboxError('TOKEN_MISSING', 'Dooray API 토큰이 설정되지 않았습니다. 확장 프로그램 설정에서 토큰을 입력하세요.')
  }
  const config = { apiKey: String(apiKey).trim(), baseUrl: String(baseUrl || DEFAULT_DOORAY_API_BASE_URL).replace(/\/+$/, '') }
  const stateFile = path.join(stateDirectory, 'state.json')
  const requesterOptions = { fetchImpl, timeoutMs, ...(sleep ? { sleep } : {}) }

  // 같은 프로세스 안의 도구 호출이 상태 파일을 동시에 읽고 쓰지 않도록 순서대로 처리한다.
  let queue = Promise.resolve()
  const exclusive = (operation) => {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }

  // 확인 표시와 캐시는 Dooray 사용자별로 나눈다. 토큰을 다시 발급해도 같은 사람이면 확인 표시가 유지된다.
  let mePromise = null
  const me = () => {
    mePromise ??= (async () => {
      const { request } = createDoorayRequester(config, requesterOptions)
      const id = String((await request('/common/v1/members/me'))?.result?.id ?? '').trim()
      if (!id) throw new InboxError('ACCESS_DENIED', 'Dooray 사용자 정보를 확인하지 못했습니다. 토큰이 올바른지 확인하세요.')
      return id
    })().catch((error) => { mePromise = null; throw error })
    return mePromise
  }

  const updateBucket = (meId, update) => exclusive(async () => {
    const state = await readState(stateFile)
    const bucket = state.users[meId] ?? emptyBucket()
    const result = await update(bucket)
    state.users[meId] = bucket
    await writeState(stateFile, state)
    return result
  })
  const readBucket = async (meId) => exclusive(async () => (await readState(stateFile)).users[meId] ?? emptyBucket())

  const normalizeDays = (days) => Math.min(DOORAY_MENTION_MAX_RANGE_DAYS, Math.max(1, Math.round(Number(days) || DEFAULT_RANGE_DAYS)))

  // Dooray에서 항목을 모으고 캐시만 저장한다. 번호 목록은 바꾸지 않는다.
  async function scan({ days = DEFAULT_RANGE_DAYS, onProgress } = {}) {
    const rangeDays = normalizeDays(days)
    const meId = await me()
    const before = await readBucket(meId)
    const until = now()
    const result = await collectDoorayMentions({
      config,
      since: new Date(until.getTime() - rangeDays * DAY_MS).toISOString(),
      until: until.toISOString(),
      projectCodes,
      webHostname,
      cache: before.cache,
    }, { ...requesterOptions, now, onProgress: onProgress ?? (() => {}) })
    await updateBucket(meId, (bucket) => { bucket.cache = result.cache })
    return { ...result, meId, rangeDays }
  }

  // 사용자에게 실제로 보여 줄 때만 번호를 매기고 저장한다. 수집 도중 확인 처리한 항목도 이 시점에 다시 거른다.
  function present(scanned) {
    return updateBucket(scanned.meId, (bucket) => {
      bucket.acks = pruneDoorayMentionAcks(bucket.acks, { now })
      const visible = scanned.items.filter((item) => !bucket.acks[item.key])
      bucket.lastList = visible.map((item) => item.key)
      bucket.lastItems = Object.fromEntries(visible.map((item) => [item.key, snapshot(item)]))
      bucket.lastPresentedAt = now().toISOString()
      bucket.lastRangeDays = scanned.rangeDays
      bucket.lastScanSummary = { projectCount: scanned.projectCount, scannedPostCount: scanned.scannedPostCount, failureCount: scanned.failureCount }
      return {
        me: scanned.me,
        rangeDays: scanned.rangeDays,
        since: scanned.since,
        until: scanned.until,
        projectCount: scanned.projectCount,
        scannedPostCount: scanned.scannedPostCount,
        requestCount: scanned.requestCount,
        failureCount: scanned.failureCount,
        hiddenCount: scanned.items.length - visible.length,
        items: visible.map((item, index) => ({ no: index + 1, key: item.key, ...snapshot(item) })),
      }
    })
  }

  async function list(options = {}) {
    return present(await scan(options))
  }

  // 처음 수집은 Dooray 요청 한도 때문에 수 분이 걸릴 수 있다. 수집은 백그라운드에서 계속하고,
  // 도구 호출은 정해진 시간만 기다린 뒤 완료 결과나 진행 상황을 돌려준다.
  let job = null
  const RESULT_REUSE_MS = 3 * 60 * 1_000
  function startJob(rangeDays) {
    if (job && !job.settled) return job
    const current = { rangeDays, progress: { phase: 'me', done: 0, total: 1 }, listeners: new Set(), settled: false, failed: false, delivered: false, finishedAt: 0 }
    current.promise = scan({ days: rangeDays, onProgress: (value) => {
      current.progress = value
      for (const listener of current.listeners) listener(value)
    } })
    current.promise.then(() => {}, () => { current.failed = true })
      .finally(() => { current.settled = true; current.finishedAt = Date.now() })
    job = current
    return current
  }

  async function listWithin({ days = DEFAULT_RANGE_DAYS, waitMs = 45_000, onProgress } = {}) {
    const rangeDays = normalizeDays(days)
    // 백그라운드에서 막 끝난 같은 기간의 결과가 아직 전달되지 않았다면 그대로 보여 준다.
    const reusable = job && job.settled && !job.failed && !job.delivered && job.rangeDays === rangeDays
      && Date.now() - job.finishedAt < RESULT_REUSE_MS
    const current = reusable ? job : startJob(rangeDays)
    if (onProgress) current.listeners.add(onProgress)
    let timer
    try {
      const outcome = await Promise.race([
        current.promise.then((scanned) => ({ scanned })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ pending: true }), Math.max(0, waitMs)) }),
      ])
      if (outcome.pending) {
        return { status: 'scanning', rangeDays: current.rangeDays, requestedDays: rangeDays, progress: { ...current.progress } }
      }
      current.delivered = true
      return { status: 'ready', ...(await present(outcome.scanned)), requestedDays: rangeDays }
    } finally {
      clearTimeout(timer)
      if (onProgress) current.listeners.delete(onProgress)
    }
  }

  // 화면은 저장된 마지막 목록을 바로 보여 준다. 새로고침을 요청하면 백그라운드 수집을 시작하고,
  // 진행 중이면 진행률을, 끝났으면 새 목록을 돌려준다. 화면은 key로 항목을 가리키므로 번호에 의존하지 않는다.
  async function uiState({ refresh = false, days = DEFAULT_RANGE_DAYS, waitMs = 1_500 } = {}) {
    const meId = await me()
    if (refresh) startJob(normalizeDays(days))
    const running = job && !job.settled ? job : null
    if (running && waitMs > 0) {
      let timer
      await Promise.race([running.promise.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, waitMs) })])
      clearTimeout(timer)
    }
    let scanState = { status: 'idle' }
    if (job && !job.settled) {
      scanState = { status: 'scanning', rangeDays: job.rangeDays, progress: { ...job.progress } }
    } else if (job && !job.delivered) {
      job.delivered = true
      try {
        await present(await job.promise)
        scanState = { status: 'updated', rangeDays: job.rangeDays }
      } catch (error) {
        scanState = { status: 'error', rangeDays: job.rangeDays, message: error?.message ?? String(error) }
      }
    }
    const bucket = await readBucket(meId)
    const acks = pruneDoorayMentionAcks(bucket.acks, { now })
    const items = bucket.lastList.filter((key) => !acks[key] && bucket.lastItems[key]).map((key) => ({ key, ...bucket.lastItems[key] }))
    const checkedEntries = Object.entries(acks).sort((left, right) => String(right[1].acknowledgedAt).localeCompare(String(left[1].acknowledgedAt)))
    return {
      scan: scanState,
      rangeDays: bucket.lastRangeDays ?? null,
      presentedAt: bucket.lastPresentedAt ?? null,
      summary: bucket.lastScanSummary ?? null,
      items,
      checked: checkedEntries.slice(0, 100).map(([key, value]) => ({ key, acknowledgedAt: value.acknowledgedAt, ...(value.item ?? {}) })),
      checkedTotal: checkedEntries.length,
    }
  }

  async function setChecked({ numbers = [], keys = [], checked = true } = {}) {
    const meId = await me()
    return updateBucket(meId, (bucket) => {
      const targets = []
      const unknownNumbers = []
      for (const number of numbers) {
        const key = Number.isInteger(Number(number)) ? bucket.lastList[Number(number) - 1] : undefined
        if (key) targets.push(key)
        else unknownNumbers.push(number)
      }
      for (const key of keys) if (typeof key === 'string' && key.trim()) targets.push(key.trim())
      const changed = []
      const unchanged = []
      for (const key of [...new Set(targets)]) {
        if (checked === !!bucket.acks[key]) { unchanged.push(key); continue }
        if (checked) bucket.acks[key] = { acknowledgedAt: now().toISOString(), ...(bucket.lastItems[key] ? { item: bucket.lastItems[key] } : {}) }
        const item = bucket.acks[key]?.item ?? bucket.lastItems[key] ?? {}
        if (!checked) delete bucket.acks[key]
        changed.push({ key, ...item })
      }
      // 확인 기록이 너무 많아지면 오래된 항목의 표시용 사본만 지운다. 확인 표시 자체는 보존 기간 동안 유지한다.
      const ordered = Object.values(bucket.acks).sort((left, right) => String(right.acknowledgedAt).localeCompare(String(left.acknowledgedAt)))
      for (const value of ordered.slice(MAX_ACK_SNAPSHOTS)) delete value.item
      bucket.acks = pruneDoorayMentionAcks(bucket.acks, { now })
      return { checked, changed, unchanged, unknownNumbers }
    })
  }

  async function checkedItems({ limit = 30 } = {}) {
    const bucket = await readBucket(await me())
    const entries = Object.entries(pruneDoorayMentionAcks(bucket.acks, { now }))
      .sort((left, right) => String(right[1].acknowledgedAt).localeCompare(String(left[1].acknowledgedAt)))
    return {
      total: entries.length,
      items: entries.slice(0, Math.max(1, Math.min(200, Math.round(Number(limit) || 30))))
        .map(([key, value]) => ({ key, acknowledgedAt: value.acknowledgedAt, ...(value.item ?? {}) })),
    }
  }

  async function detail({ projectId, postId, commentId = null } = {}) {
    const project = String(projectId ?? '').trim()
    const post = String(postId ?? '').trim()
    if (!/^\d+$/.test(project) || !/^\d+$/.test(post)) {
      throw new InboxError('INVALID_ID', 'projectId와 postId는 목록에 표시된 숫자 ID여야 합니다.')
    }
    const { request, stats } = createDoorayRequester(config, requesterOptions)
    // 댓글이 많으면 최신 댓글을 우선 받아 시간순으로 다시 정렬한다.
    const [postPayload, logsPayload] = await Promise.all([
      request(`/project/v1/projects/${project}/posts/${post}`),
      request(`/project/v1/projects/${project}/posts/${post}/logs?size=${DETAIL_COMMENT_PAGE_SIZE}&page=0&order=-createdAt`),
    ])
    const result = postPayload?.result
    if (!result) throw new InboxError('NOT_FOUND', '업무를 찾을 수 없거나 조회 권한이 없습니다.')
    const comments = (logsPayload?.result ?? []).filter((entry) => entry?.type === 'comment')
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    // 댓글 작성자 이름이 응답에 없으면 구성원 조회로 채운다. 같은 사람은 한 번만 조회한다.
    const names = new Map()
    const unresolved = [...new Set(comments.filter((comment) => !memberName(comment.creator))
      .map((comment) => memberId(comment.creator)).filter(Boolean))].slice(0, 30)
    for (const id of unresolved) names.set(id, String((await request(`/common/v1/members/${id}`))?.result?.name ?? '').trim())
    const body = readableDoorayText(result.body?.content, result.body?.mimeType)
    const people = (entries) => (entries ?? []).map(memberName).filter(Boolean)
    const url = `https://${webHostname}/task/${project}/${post}`
    const totalComments = Number(logsPayload?.totalCount)
    return {
      projectId: project,
      postId: post,
      focusCommentId: commentId ? String(commentId) : null,
      taskNumber: String(result.taskNumber ?? '').trim(),
      subject: String(result.subject ?? '').trim(),
      url,
      workflow: String(result.workflow?.name ?? '').trim(),
      closed: result.closed === true,
      dueDate: result.dueDate ?? null,
      author: memberName(result.users?.from),
      assignees: people(result.users?.to),
      cc: people(result.users?.cc),
      createdAt: result.createdAt ?? null,
      updatedAt: result.updatedAt ?? null,
      body: body.text,
      bodyTruncated: body.truncated,
      comments: comments.map((comment) => {
        const text = readableDoorayText(comment.body?.content, comment.body?.mimeType, DETAIL_COMMENT_LIMIT)
        return {
          id: String(comment.id ?? ''),
          author: memberName(comment.creator) || names.get(memberId(comment.creator)) || '',
          createdAt: comment.createdAt ?? null,
          text: text.text,
          truncated: text.truncated,
          url: `${url}#comment-${comment.id}`,
        }
      }),
      commentsTruncated: Number.isFinite(totalComments) && totalComments > comments.length,
      requestCount: stats.requestCount,
    }
  }

  return { list, listWithin, uiState, setChecked, checkedItems, detail, stateFile }
}
