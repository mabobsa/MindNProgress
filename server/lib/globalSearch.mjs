import { createHash } from 'node:crypto'

export const GLOBAL_SEARCH_MODES = Object.freeze(['ranked', 'catalog'])
export const GLOBAL_SEARCH_FIELDS = Object.freeze([
  'documentTitle',
  'cardTitle',
  'description',
  'sharedKnowledge',
  'comments',
  'checklist',
  'waiting',
  'metadata',
])
export const GLOBAL_SEARCH_KINDS = Object.freeze(['root', 'branch', 'task', 'image'])
export const GLOBAL_SEARCH_STATUSES = Object.freeze(['planned', 'in-progress', 'done'])
export const GLOBAL_SEARCH_DEFAULT_LIMIT = 25
export const GLOBAL_SEARCH_MAX_LIMIT = 100
export const GLOBAL_SEARCH_MAX_QUERY_LENGTH = 240

const statusLabels = Object.freeze({ planned: '예정', 'in-progress': '진행 중', done: '완료' })
const kindLabels = Object.freeze({ root: '루트', branch: '분류', task: '업무', image: '이미지' })
const fieldWeights = Object.freeze({
  documentTitle: 140,
  cardTitle: 130,
  metadata: 90,
  description: 75,
  sharedKnowledge: 70,
  checklist: 65,
  waiting: 60,
  comments: 55,
})

export class GlobalSearchInputError extends Error {
  constructor(message, code = 'GLOBAL_SEARCH_INPUT_INVALID') {
    super(message)
    this.name = 'GlobalSearchInputError'
    this.code = code
    this.status = 400
  }
}

function uniqueStrings(value, allowed = null, max = 100) {
  const values = [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean))]
  if (values.length > max) throw new GlobalSearchInputError(`필터는 종류별로 ${max}개 이하만 지정할 수 있습니다.`)
  if (allowed && values.some((item) => !allowed.includes(item))) {
    throw new GlobalSearchInputError('지원하지 않는 검색 필터가 포함되어 있습니다.')
  }
  return values.sort((first, second) => first.localeCompare(second))
}

function optionalBoolean(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new GlobalSearchInputError(`${label}은 true 또는 false여야 합니다.`)
}

export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim()
}

export function normalizeGlobalSearchRequest(value = {}) {
  const mode = String(value.mode ?? 'ranked').trim() || 'ranked'
  if (!GLOBAL_SEARCH_MODES.includes(mode)) throw new GlobalSearchInputError('검색 모드는 ranked 또는 catalog여야 합니다.')
  const query = String(value.query ?? value.q ?? '').trim()
  if (query.length > GLOBAL_SEARCH_MAX_QUERY_LENGTH) {
    throw new GlobalSearchInputError(`검색어는 ${GLOBAL_SEARCH_MAX_QUERY_LENGTH}자 이하여야 합니다.`)
  }
  const limit = value.limit === undefined || value.limit === null || value.limit === ''
    ? GLOBAL_SEARCH_DEFAULT_LIMIT
    : Number(value.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > GLOBAL_SEARCH_MAX_LIMIT) {
    throw new GlobalSearchInputError(`limit은 1~${GLOBAL_SEARCH_MAX_LIMIT}의 정수여야 합니다.`)
  }
  const cursor = String(value.cursor ?? '').trim()
  if (cursor.length > 1_000) throw new GlobalSearchInputError('검색 커서가 너무 깁니다.')
  return {
    mode,
    query,
    normalizedQuery: normalizeSearchText(query),
    limit,
    cursor,
    filters: {
      mapIds: uniqueStrings(value.mapIds),
      groupIds: uniqueStrings(value.groupIds),
      fields: uniqueStrings(value.fields, GLOBAL_SEARCH_FIELDS),
      kinds: uniqueStrings(value.kinds, GLOBAL_SEARCH_KINDS),
      statuses: uniqueStrings(value.statuses, GLOBAL_SEARCH_STATUSES),
      assigneeIds: uniqueStrings(value.assigneeIds),
      isWork: optionalBoolean(value.isWork, 'isWork'),
      hasWaitingItems: optionalBoolean(value.hasWaitingItems, 'hasWaitingItems'),
    },
  }
}

function resultSetFingerprint(request, results) {
  return createHash('sha256').update(JSON.stringify({
    mode: request.mode,
    query: request.normalizedQuery,
    filters: request.filters,
    results: results.map((result) => ({
      mapId: result.mapId,
      mapVersion: result.mapVersion,
      cardId: result.cardId,
      field: result.field,
      commentId: result.commentId ?? null,
      snippet: result.snippet,
      score: result.score,
      order: result.order,
    })),
  })).digest('base64url').slice(0, 22)
}

function decodeCursor(cursor, fingerprint) {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (parsed?.v !== 1 || parsed?.key !== fingerprint || !Number.isInteger(parsed?.offset) || parsed.offset < 0) {
      throw new Error('invalid')
    }
    return parsed.offset
  } catch {
    throw new GlobalSearchInputError('현재 검색 조건과 일치하지 않는 커서입니다.', 'GLOBAL_SEARCH_CURSOR_INVALID')
  }
}

function encodeCursor(offset, fingerprint) {
  return Buffer.from(JSON.stringify({ v: 1, offset, key: fingerprint }), 'utf8').toString('base64url')
}

function groupByMapId(documentLayout) {
  const result = new Map()
  for (const group of documentLayout?.groups ?? []) {
    for (const mapId of group.mapIds ?? []) result.set(mapId, { id: group.id, name: group.name })
  }
  return result
}

function commentList(commentsByMap, mapId) {
  if (commentsByMap instanceof Map) return commentsByMap.get(mapId) ?? []
  return commentsByMap?.[mapId] ?? []
}

function resolvedNode(node, mapsById) {
  const reference = node?.data?.reference
  if (!reference?.mapId || !reference?.nodeId) {
    return { data: node?.data ?? {}, reference: null, sourceMap: null, sourceNode: null }
  }
  const sourceMap = mapsById.get(reference.mapId) ?? null
  const sourceNode = sourceMap?.nodes?.find((candidate) => candidate.id === reference.nodeId) ?? null
  if (!sourceNode || sourceMap?.trashedAt) {
    return {
      data: { label: '참조 원본을 찾을 수 없음', kind: node?.data?.kind ?? 'task' },
      reference: {
        sourceMapId: reference.mapId,
        sourceCardId: reference.nodeId,
        sourceMapTitle: sourceMap?.title ?? null,
        sourceCardLabel: null,
        unresolved: true,
      },
      sourceMap,
      sourceNode: null,
    }
  }
  return {
    data: sourceNode.data ?? {},
    reference: {
      sourceMapId: sourceMap.id,
      sourceCardId: sourceNode.id,
      sourceMapTitle: sourceMap.title,
      sourceCardLabel: sourceNode.data?.label ?? sourceNode.id,
      unresolved: false,
    },
    sourceMap,
    sourceNode,
  }
}

function cardPath(map, node, mapsById) {
  const byId = new Map((map.nodes ?? []).map((candidate) => [candidate.id, candidate]))
  const parentById = new Map((map.edges ?? [])
    .filter((edge) => edge?.data?.relation !== 'knowledge')
    .map((edge) => [edge.target, edge.source]))
  const ids = []
  const visited = new Set()
  let currentId = node.id
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    ids.unshift(currentId)
    currentId = parentById.get(currentId)
  }
  return ids.map((id) => {
    const candidate = byId.get(id)
    return String(resolvedNode(candidate, mapsById).data?.label ?? candidate?.id ?? id)
  })
}

function cardMatchesFilters(data, filters) {
  if (filters.kinds.length && !filters.kinds.includes(String(data.kind ?? 'task'))) return false
  if (filters.statuses.length && !filters.statuses.includes(String(data.status ?? 'planned'))) return false
  if (filters.assigneeIds.length && !filters.assigneeIds.includes(String(data.assigneeId ?? ''))) return false
  if (filters.isWork !== null && Boolean(data.isWork) !== filters.isWork) return false
  const hasWaitingItems = Array.isArray(data.waitingItems) && data.waitingItems.some((item) => String(item?.label ?? '').trim())
  if (filters.hasWaitingItems !== null && hasWaitingItems !== filters.hasWaitingItems) return false
  return true
}

function hasCardFilters(filters) {
  return filters.kinds.length > 0
    || filters.statuses.length > 0
    || filters.assigneeIds.length > 0
    || filters.isWork !== null
    || filters.hasWaitingItems !== null
}

function matchText(value, normalizedQuery) {
  const displayText = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!displayText || !normalizedQuery) return null
  const normalizedValue = normalizeSearchText(displayText)
  const compactValue = normalizedValue.replace(/\s/g, '')
  const compactQuery = normalizedQuery.replace(/\s/g, '')
  const tokens = [...new Set(normalizedQuery.split(' ').filter(Boolean))]
  const phraseIndex = normalizedValue.indexOf(normalizedQuery)
  const compactIndex = compactQuery ? compactValue.indexOf(compactQuery) : -1
  const matchedTerms = tokens.filter((token) => normalizedValue.includes(token))
  if (normalizedValue === normalizedQuery) return { score: 100, index: 0, matchedTerms }
  if (normalizedValue.startsWith(normalizedQuery)) return { score: 82, index: 0, matchedTerms }
  if (phraseIndex >= 0) return { score: 68, index: phraseIndex, matchedTerms }
  if (compactIndex >= 0) return { score: 58, index: Math.max(0, compactIndex), matchedTerms }
  if (tokens.length && matchedTerms.length === tokens.length) {
    return { score: 45 + Math.min(10, tokens.length * 2), index: normalizedValue.indexOf(matchedTerms[0]), matchedTerms }
  }
  return null
}

function textPreview(value, index = 0, maxLength = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  const start = Math.max(0, Math.min(text.length - maxLength, index - Math.floor(maxLength * 0.32)))
  const sliced = text.slice(start, start + maxLength)
  return `${start > 0 ? '…' : ''}${sliced}${start + maxLength < text.length ? '…' : ''}`
}

function cardBase({ map, node, data, reference, group, usersById, mapsById, publicBaseUrl }) {
  const waitingItems = Array.isArray(data.waitingItems) ? data.waitingItems : []
  const assignee = usersById.get(data.assigneeId) ?? null
  const baseUrl = String(publicBaseUrl ?? '').replace(/\/+$/, '')
  return {
    entity: 'card',
    mapId: map.id,
    mapTitle: map.title,
    mapVersion: map.version ?? 1,
    mapUpdatedAt: map.updatedAt ?? null,
    group,
    cardId: node.id,
    cardLabel: String(data.label ?? node.id),
    path: cardPath(map, node, mapsById),
    kind: GLOBAL_SEARCH_KINDS.includes(data.kind) ? data.kind : 'task',
    isWork: data.isWork === true,
    status: GLOBAL_SEARCH_STATUSES.includes(data.status) ? data.status : 'planned',
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    dueDate: typeof data.dueDate === 'string' && data.dueDate ? data.dueDate : null,
    hasWaitingItems: waitingItems.some((item) => String(item?.label ?? '').trim()),
    reference,
    accessUrl: `${baseUrl}/mindmap/${encodeURIComponent(map.id)}/${encodeURIComponent(node.id)}`,
  }
}

function documentBase(map, group, publicBaseUrl) {
  const baseUrl = String(publicBaseUrl ?? '').replace(/\/+$/, '')
  return {
    entity: 'document',
    mapId: map.id,
    mapTitle: map.title,
    mapVersion: map.version ?? 1,
    mapUpdatedAt: map.updatedAt ?? null,
    group,
    cardId: null,
    cardLabel: null,
    path: [],
    kind: null,
    isWork: null,
    status: null,
    assignee: null,
    dueDate: null,
    hasWaitingItems: false,
    reference: null,
    accessUrl: `${baseUrl}/mindmap/${encodeURIComponent(map.id)}`,
  }
}

function fieldEnabled(filters, field) {
  return filters.fields.length === 0 || filters.fields.includes(field)
}

function searchableCardValues(data, comments, usersById) {
  const assignee = usersById.get(data.assigneeId)
  const values = [
    { field: 'cardTitle', fieldLabel: '카드 제목', value: data.label },
    { field: 'description', fieldLabel: '설명', value: data.description },
    { field: 'sharedKnowledge', fieldLabel: '공유 지식', value: data.sharedKnowledge },
  ]
  for (const comment of comments) {
    const replyPrefix = comment.parentId ? '답글' : '댓글'
    values.push({
      field: 'comments',
      fieldLabel: `${replyPrefix} 요약`,
      value: comment.summary ?? comment.text,
      commentId: comment.id,
      parentCommentId: comment.parentId ?? null,
    })
    values.push({
      field: 'comments',
      fieldLabel: `${replyPrefix} 상세`,
      value: comment.detail,
      commentId: comment.id,
      parentCommentId: comment.parentId ?? null,
    })
  }
  for (const item of data.checklist ?? []) {
    values.push({ field: 'checklist', fieldLabel: item.done ? '체크리스트 · 완료' : '체크리스트 · 미완료', value: item.text })
  }
  for (const item of data.waitingItems ?? []) {
    values.push({ field: 'waiting', fieldLabel: '대기 항목', value: item.label })
    values.push({ field: 'waiting', fieldLabel: '대기 메모', value: item.note })
    values.push({ field: 'waiting', fieldLabel: '재개 조건', value: item.resumeCondition })
  }
  values.push(
    { field: 'metadata', fieldLabel: '카드 종류', value: `${data.kind ?? 'task'} ${kindLabels[data.kind] ?? ''}` },
    { field: 'metadata', fieldLabel: '업무 상태', value: `${data.status ?? 'planned'} ${statusLabels[data.status] ?? ''}` },
    { field: 'metadata', fieldLabel: '업무 여부', value: data.isWork ? '업무 실제 업무' : '비업무 묶음 지식' },
    { field: 'metadata', fieldLabel: '담당자', value: assignee ? `${assignee.name} ${assignee.id}` : data.assigneeId },
    { field: 'metadata', fieldLabel: '마감일', value: data.dueDate },
    { field: 'metadata', fieldLabel: '업무 링크', value: data.taskUrl },
    { field: 'metadata', fieldLabel: '외부 자료', value: [data.externalLink?.title, data.externalLink?.url, data.externalLink?.taskNumber].filter(Boolean).join(' ') },
  )
  return values
}

function rankedResults({ scopedMaps, mapsById, commentsByMap, groupsByMap, usersById, publicBaseUrl, request }) {
  const results = []
  let order = 0
  for (const map of scopedMaps) {
    const group = groupsByMap.get(map.id) ?? null
    if (fieldEnabled(request.filters, 'documentTitle') && !hasCardFilters(request.filters)) {
      const match = matchText(map.title, request.normalizedQuery)
      if (match) results.push({
        ...documentBase(map, group, publicBaseUrl),
        field: 'documentTitle',
        fieldLabel: '문서 제목',
        snippet: textPreview(map.title, match.index),
        matchedTerms: match.matchedTerms,
        score: fieldWeights.documentTitle + match.score,
        order: order++,
      })
    }
    for (const node of map.nodes ?? []) {
      const resolved = resolvedNode(node, mapsById)
      const data = resolved.data
      if (!cardMatchesFilters(data, request.filters)) continue
      const commentsMapId = resolved.reference?.sourceMapId ?? map.id
      const commentsNodeId = resolved.reference?.sourceCardId ?? node.id
      const comments = commentList(commentsByMap, commentsMapId).filter((comment) => comment?.nodeId === commentsNodeId)
      const base = cardBase({ map, node, data, reference: resolved.reference, group, usersById, mapsById, publicBaseUrl })
      for (const entry of searchableCardValues(data, comments, usersById)) {
        if (!fieldEnabled(request.filters, entry.field)) continue
        const match = matchText(entry.value, request.normalizedQuery)
        if (!match) continue
        results.push({
          ...base,
          field: entry.field,
          fieldLabel: entry.fieldLabel,
          snippet: textPreview(entry.value, match.index),
          matchedTerms: match.matchedTerms,
          score: (fieldWeights[entry.field] ?? 0) + match.score,
          ...(entry.commentId ? { commentId: entry.commentId, parentCommentId: entry.parentCommentId } : {}),
          order: order++,
        })
      }
    }
  }
  return results.sort((first, second) => second.score - first.score || first.order - second.order)
}

function catalogResults({ scopedMaps, mapsById, groupsByMap, usersById, publicBaseUrl, request }) {
  const results = []
  let order = 0
  for (const map of scopedMaps) {
    const group = groupsByMap.get(map.id) ?? null
    for (const node of map.nodes ?? []) {
      const resolved = resolvedNode(node, mapsById)
      const data = resolved.data
      if (!cardMatchesFilters(data, request.filters)) continue
      const summary = String(data.description ?? '').trim()
        || String(data.sharedKnowledge ?? '').trim()
        || String(data.label ?? node.id)
      results.push({
        ...cardBase({ map, node, data, reference: resolved.reference, group, usersById, mapsById, publicBaseUrl }),
        field: 'catalog',
        fieldLabel: '카드 카탈로그',
        snippet: textPreview(summary, 0, 280),
        matchedTerms: [],
        score: null,
        order: order++,
      })
    }
  }
  return results
}

export function searchGlobalContent({
  maps = [],
  sourceMaps = maps,
  commentsByMap = new Map(),
  documentLayout = { groups: [] },
  users = [],
  publicBaseUrl = '',
  request: rawRequest = {},
} = {}) {
  const request = rawRequest?.normalizedQuery !== undefined ? rawRequest : normalizeGlobalSearchRequest(rawRequest)
  const groupsByMap = groupByMapId(documentLayout)
  const mapsById = new Map(sourceMaps.filter(Boolean).map((map) => [map.id, map]))
  const usersById = new Map(users.filter((user) => user?.id).map((user) => [user.id, user]))
  const scopedMaps = maps.filter((map) => {
    if (!map || map.trashedAt || map.archivedAt) return false
    if (request.filters.mapIds.length && !request.filters.mapIds.includes(map.id)) return false
    const group = groupsByMap.get(map.id)
    if (request.filters.groupIds.length && (!group || !request.filters.groupIds.includes(group.id))) return false
    return true
  })
  const scannedCardCount = scopedMaps.reduce((count, map) => count + (map.nodes?.length ?? 0), 0)
  const allResults = request.mode === 'catalog'
    ? catalogResults({ scopedMaps, mapsById, groupsByMap, usersById, publicBaseUrl, request })
    : request.normalizedQuery
      ? rankedResults({ scopedMaps, mapsById, commentsByMap, groupsByMap, usersById, publicBaseUrl, request })
      : []
  const fingerprint = resultSetFingerprint(request, allResults)
  const offset = decodeCursor(request.cursor, fingerprint)
  if (offset > allResults.length) throw new GlobalSearchInputError('검색 결과 범위를 벗어난 커서입니다.', 'GLOBAL_SEARCH_CURSOR_INVALID')
  const results = allResults.slice(offset, offset + request.limit).map(({ order: _order, ...result }) => result)
  const nextOffset = offset + results.length
  const hasMore = nextOffset < allResults.length
  return {
    query: request.query,
    mode: request.mode,
    filters: request.filters,
    coverage: {
      searchedDocumentCount: scopedMaps.length,
      searchedCardCount: scannedCardCount,
      lexicalCoverage: 'complete-within-selected-scope',
      semanticCoverage: 'not-guaranteed',
      note: request.mode === 'catalog'
        ? '카탈로그는 선택 범위의 카드를 커서 순서로 반환합니다.'
        : '관련도 검색은 선택 범위의 문자열 일치를 모두 검사하지만 표현이 다른 의미상 관련 카드는 보장하지 않습니다.',
    },
    page: {
      offset,
      limit: request.limit,
      returned: results.length,
      total: allResults.length,
      hasMore,
      nextCursor: hasMore ? encodeCursor(nextOffset, fingerprint) : null,
    },
    results,
  }
}
