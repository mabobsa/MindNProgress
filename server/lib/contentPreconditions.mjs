import { createHash } from 'node:crypto'
import { applyCardTextPatch, textIntegrity } from '../../mcp/cardTextPatch.mjs'

// 객체 키 순서는 의미가 없지만 배열 순서와 속성 없음/null은 서로 다르다.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const digest = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
export const fieldStamp = (object, field) => Object.hasOwn(object ?? {}, field)
  ? { exists: true, encoding: typeof object[field] === 'string' ? 'utf8' : 'canonical-json',
      sha256: typeof object[field] === 'string' ? textIntegrity(object[field]).sha256 : digest(object[field]) } : { exists: false }
const identity = (node) => ({ type: fieldStamp(node, 'type'), kind: fieldStamp(node?.data, 'kind'), reference: fieldStamp(node?.data, 'reference') })
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const workflowFields = ['status', 'progress', 'checklist', 'waitingItems', 'isWork']

export class ContentConditionError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}
const invalid = () => { throw new ContentConditionError('CONTENT_PRECONDITION_INVALID', '변경 전 조건 형식 또는 필수 읽기 조건이 올바르지 않습니다.') }
export function conflict(code, reasonCode, resource, field, expected, current, cardId) {
  throw new ContentConditionError(code, `${code}: 조회 이후 변경 전 조건이 달라져 요청을 적용하지 않았습니다. 충돌 대상을 다시 검토해 주세요.`, 409, {
    reasonCode, outcome: 'not-applied', retryable: false,
    conflicts: [{ resource, ...(cardId ? { cardId } : {}), field, expected, current, kind: reasonCode }],
  })
}
export function assertLifecycle(map, expected) {
  if (!Number.isInteger(expected) || expected < 0) invalid()
  if (expected !== (map.lifecycleVersion ?? 0) || map.trashedAt || map.archivedAt || map.reconstructionPending) {
    conflict('VERSION_CONFLICT', 'LIFECYCLE_CONFLICT', map.id, 'lifecycleVersion', expected, map.lifecycleVersion ?? 0)
  }
}
export function assertVersion(map, expected) {
  if (expected !== map.version) conflict('VERSION_CONFLICT', 'READ_DEPENDENCY_CHANGED', map.id, 'version', expected, map.version)
}
export function assertReplacementConditions(map, body, snapshot) {
  if (!Number.isInteger(body.baseVersion) || body.baseVersion < 1 || !Number.isInteger(body.baseLifecycleVersion)
    || body.baseLifecycleVersion < 0 || snapshot && !validHash(body.expectedSnapshotSha256)) {
    throw new ContentConditionError('CONTENT_PRECONDITION_REQUIRED', '전체 교체·복원에는 검토한 baseVersion과 baseLifecycleVersion이 필요하며 복원에는 expectedSnapshotSha256도 필요합니다.')
  }
  assertLifecycle(map, body.baseLifecycleVersion)
  assertVersion(map, body.baseVersion)
  if (snapshot && body.expectedSnapshotSha256 !== digest(snapshot)) {
    conflict('VERSION_CONFLICT', 'READ_DEPENDENCY_CHANGED', map.id, 'snapshot', body.expectedSnapshotSha256, digest(snapshot))
  }
}
function changedFields(change) {
  return [...Object.keys(change.set ?? {}).map((field) => ['node', field]), ...(change.remove ?? []).map((field) => ['node', field]),
    ...Object.keys(change.dataSet ?? {}).map((field) => ['data', field]), ...(change.dataRemove ?? []).map((field) => ['data', field])]
}
function structurallyChanges(patch, conditions) {
  return Boolean(patch.nodeAdds?.length || patch.nodeDeletes?.length || patch.edgeUpserts?.length || patch.edgeDeletes?.length
    || digest(patch.nodeOrder) !== conditions.nodeOrder || digest(patch.edgeOrder) !== conditions.edgeOrder
    || patch.nodeChanges?.some((c) => changedFields(c).some(([scope, field]) => scope === 'node' && field === 'type'
      || scope === 'data' && ['kind', 'reference', 'isWork', 'blockedBy'].includes(field))))
}
export function createContentPreconditions(before, patch) {
  return { schemaVersion: 1, mapId: before.id, lifecycleVersion: before.lifecycleVersion ?? 0,
    nodeOrder: digest(before.nodes.map((n) => n.id)), edgeOrder: digest(before.edges.map((e) => e.id)),
    cards: patch.nodeChanges.map((change) => {
      const node = before.nodes.find((n) => n.id === change.id)
      const fields = changedFields(change)
      if (fields.some(([scope, field]) => scope === 'data' && workflowFields.includes(field))) {
        for (const field of workflowFields) if (!fields.some(([s, f]) => s === 'data' && f === field)) fields.push(['data', field])
      }
      return { cardId: change.id, identity: digest(identity(node)), fields: fields.map(([scope, field]) => ({
        scope, field, expected: fieldStamp(scope === 'data' ? node.data : node, field),
      })) }
    }) }
}

export function validateContentPreconditions(map, body) {
  const p = body.preconditions
  if (p === undefined) { assertVersion(map, body.baseVersion); return body.patch }
  if (!p || p.schemaVersion !== 1 || p.mapId !== map.id || !Array.isArray(p.cards)
    || !validHash(p.nodeOrder) || !validHash(p.edgeOrder)) invalid()
  assertLifecycle(map, p.lifecycleVersion)
  const patch = body.patch
  if (!patch || !Array.isArray(patch.nodeChanges) || patch.nodeChanges.some((c) => !c || typeof c.id !== 'string')
    || !Array.isArray(patch.nodeOrder) || !Array.isArray(patch.edgeOrder)) invalid()
  const structural = structurallyChanges(patch, p)
  if (structural) assertVersion(map, body.baseVersion)
  const cards = new Map(p.cards.map((c) => [c?.cardId, c]))
  if (cards.size !== p.cards.length) invalid()
  for (const c of p.cards) {
    if (!c || typeof c.cardId !== 'string' || c.cardId.length > 120 || !validHash(c.identity) || !Array.isArray(c.fields)) invalid()
    const node = map.nodes.find((n) => n.id === c.cardId)
    if (!node || digest(identity(node)) !== c.identity) {
      conflict('VERSION_CONFLICT', 'READ_DEPENDENCY_CHANGED', map.id, 'identity', c.identity, node ? digest(identity(node)) : null, c.cardId)
    }
    const keys = new Set()
    for (const f of c.fields) {
      if (!f || !['node', 'data'].includes(f.scope) || typeof f.field !== 'string' || f.field.length > 120 || ['__proto__', 'prototype', 'constructor'].includes(f.field)
        || !f.expected || typeof f.expected.exists !== 'boolean' || f.expected.exists && (!validHash(f.expected.sha256)
          || !['utf8', 'canonical-json'].includes(f.expected.encoding))
        || Object.keys(f.expected).some((key) => !(f.expected.exists ? ['exists', 'sha256', 'encoding'] : ['exists']).includes(key))) invalid()
      const key = `${f.scope}.${f.field}`
      if (keys.has(key)) invalid()
      keys.add(key)
      const current = fieldStamp(f.scope === 'data' ? node.data : node, f.field)
      if (canonicalJson(current) !== canonicalJson(f.expected)) {
        const written = patch.nodeChanges.some((change) => change.id === c.cardId && changedFields(change).some(([s, field]) => s === f.scope && field === f.field))
        conflict('VERSION_CONFLICT', written ? 'FIELD_CONFLICT' : 'READ_DEPENDENCY_CHANGED', map.id, key, f.expected, current, c.cardId)
      }
    }
  }
  for (const change of patch.nodeChanges) {
    const c = cards.get(change.id)
    if (!c) invalid()
    const required = changedFields(change)
    if (required.some(([s, f]) => s === 'data' && workflowFields.includes(f))) {
      required.push(...workflowFields.map((f) => ['data', f]))
    }
    if (required.some(([s, f]) => !c.fields.some((v) => v.scope === s && v.field === f))) invalid()
  }
  // 전체 순서를 재전송하는 기존 patch 형식은 유지하되 독립 필드 요청은 최신 순서를 보존한다.
  return structural ? patch : { ...patch, nodeOrder: map.nodes.map((n) => n.id), edgeOrder: map.edges.map((e) => e.id) }
}

export function validateTextOperations(map, patch, operations) {
  if (operations === undefined) return
  if (!Array.isArray(operations) || operations.length > 20) invalid()
  for (const item of operations) {
    if (!item || !['description', 'sharedKnowledge'].includes(item.field) || !validHash(item.expectedSha256)) invalid()
    const operation = item.operation
    if (!operation || !['append', 'replace_once', 'replace_between'].includes(operation.type)
      || operation.type === 'append' && (typeof operation.text !== 'string' || !['none', 'newline', 'blank-line'].includes(operation.separator))
      || operation.type === 'replace_once' && (typeof operation.find !== 'string' || !operation.find || typeof operation.replace !== 'string')
      || operation.type === 'replace_between' && (typeof operation.startMarker !== 'string' || !operation.startMarker
        || typeof operation.endMarker !== 'string' || !operation.endMarker || typeof operation.replacement !== 'string')) invalid()
    const node = map.nodes.find((n) => n.id === item.cardId)
    if (!node || node.data?.reference) conflict('TEXT_PATCH_REFERENCE_CARD', 'READ_DEPENDENCY_CHANGED', map.id, 'identity', null, null, item.cardId)
    const before = typeof node.data?.[item.field] === 'string' ? node.data[item.field] : ''
    const hash = textIntegrity(before).sha256
    if (hash !== item.expectedSha256) conflict('TEXT_HASH_MISMATCH', 'FIELD_CONFLICT', map.id, item.field, item.expectedSha256, hash, item.cardId)
    let next
    try { next = applyCardTextPatch(before, item.operation) } catch (error) {
      throw new ContentConditionError(error.message.split(':')[0], error.message)
    }
    if (patch.nodeChanges.find((c) => c.id === item.cardId)?.dataSet?.[item.field] !== next) invalid()
  }
}

// 검토 당시 실제 제공한 카드 문맥과 필수 출처를 구성요소별로 비교한다. 문서 version은 제외한다.
export function reviewContextToken(map, cardId, comments, sources = []) {
  const card = map.nodes.find((n) => n.id === cardId)
  const edges = map.edges.filter((e) => e.source === cardId || e.target === cardId)
  const relatedIds = new Set(edges.flatMap((e) => [e.source, e.target]).filter((id) => id !== cardId))
  const contextCard = (n) => ({ id: n.id, type: n.type, data: Object.fromEntries([
    'label', 'description', 'kind', 'reference', 'taskUrl', 'reconstructionSources',
    'sharedKnowledge', 'sharedKnowledgeReview', 'sharedKnowledgeUpdatedAt', 'sharedKnowledgeUpdatedBy',
  ].filter((f) => Object.hasOwn(n.data ?? {}, f)).map((f) => [f, n.data[f]])) })
  return { schemaVersion: 1, mapId: map.id, cardId, lifecycleVersion: map.lifecycleVersion ?? 0,
    dependencies: {
      card: digest(card ? contextCard(card) : null),
      relations: digest(edges),
      relatedCards: digest(map.nodes.filter((n) => relatedIds.has(n.id)).map(contextCard)),
      comments: digest(comments), sources: digest(sources),
    } }
}
export function validateReviewContext(map, expected, current) {
  if (!expected || expected.schemaVersion !== 1 || expected.mapId !== map.id || expected.cardId !== current.cardId || !expected.dependencies) invalid()
  assertLifecycle(map, expected.lifecycleVersion)
  for (const [field, hash] of Object.entries(current.dependencies)) {
    if (!validHash(expected.dependencies[field])) invalid()
    if (expected.dependencies[field] !== hash) conflict('SHARED_KNOWLEDGE_REVIEW_CONTEXT_MISMATCH', 'READ_DEPENDENCY_CHANGED', map.id, field, expected.dependencies[field], hash, current.cardId)
  }
}

export const commentContentHash = (comment) => digest(Object.fromEntries(['summary', 'detail', 'text', 'contentFormat'].map((f) => [f, fieldStamp(comment, f)])))
export const commentResolvedHash = (comment) => digest({ resolvedAt: fieldStamp(comment, 'resolvedAt'), resolvedBy: fieldStamp(comment, 'resolvedBy') })
export function commentDeleteHash(comments, id) {
  const ids = new Set([id])
  let count
  do { count = ids.size; for (const c of comments) if (ids.has(c.parentId)) ids.add(c.id) } while (ids.size !== count)
  return digest(comments.filter((c) => ids.has(c.id)))
}
export function validateCommentCondition(mapId, comment, body, action, comments, actorId) {
  const fields = { update: ['expectedContentSha256', () => commentContentHash(comment)],
    resolve: ['expectedResolvedSha256', () => commentResolvedHash(comment)],
    delete: ['expectedDeleteSha256', () => commentDeleteHash(comments, comment.id)],
    reaction: ['expectedReacted', () => (comment.reactions?.[body.emoji] ?? []).includes(actorId)] }
  const [field, currentValue] = fields[action]
  if (!Object.hasOwn(body, field)) return
  if (action === 'reaction' ? typeof body[field] !== 'boolean' : !validHash(body[field])) invalid()
  const current = currentValue()
  if (body[field] !== current) conflict('COMMENT_CONFLICT', action === 'delete' ? 'READ_DEPENDENCY_CHANGED' : 'FIELD_CONFLICT', `${mapId}/comments/${comment.id}`, field, body[field], current, comment.nodeId)
}
