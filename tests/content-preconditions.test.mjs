import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createMapContentPatch, applyMapContentPatch } from '../src/utils/mapContentPatch.mjs'
import { canonicalJson, digest, fieldStamp, createContentPreconditions, validateContentPreconditions, validateTextOperations } from '../server/lib/contentPreconditions.mjs'
import { textIntegrity } from '../mcp/cardTextPatch.mjs'
import { fixture } from './helpers/storage-api-harness.mjs'

const request = (map, change) => {
  const next = structuredClone(map); change(next)
  const patch = createMapContentPatch(map, next)
  return { baseVersion: map.version, patch, preconditions: createContentPreconditions(map, patch) }
}
test('사전조건 digest는 객체 키 순서·배열 순서·속성 없음/null·UTF-8 계약을 따른다', () => {
  assert.equal(digest({ b: 1, a: '한글' }), digest({ a: '한글', b: 1 }))
  assert.notEqual(digest([1, 2]), digest([2, 1]))
  assert.notDeepEqual(fieldStamp({}, 'x'), fieldStamp({ x: null }, 'x'))
  assert.notDeepEqual(fieldStamp({ x: 'null' }, 'x'), fieldStamp({ x: null }, 'x'))
  assert.equal(fieldStamp({ x: '한글' }, 'x').sha256, textIntegrity('한글').sha256)
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(textIntegrity('한글').sha256, createHash('sha256').update(Buffer.from('ed959ceab880', 'hex')).digest('hex'))
})
test('같은 카드의 독립 필드를 보존하고 필드·종류·Ref·수명주기와 누락 조건을 거부한다', () => {
  const before = fixture('map-unit')
  const body = request(before, (m) => { m.nodes[1].data.label = '새 제목' })
  const latest = structuredClone(before); latest.version++; latest.nodes[1].data.description = '독립 본문'
  const result = applyMapContentPatch(latest, validateContentPreconditions(latest, body))
  assert.equal(result.nodes[1].data.label, '새 제목'); assert.equal(result.nodes[1].data.description, '독립 본문')
  for (const [mutate, reason] of [
    [(m) => { m.nodes[1].data.label = '다른 제목' }, 'FIELD_CONFLICT'],
    [(m) => { m.nodes[1].data.kind = 'task' }, 'READ_DEPENDENCY_CHANGED'],
    [(m) => { m.nodes[1].data.reference = { mapId: 'other', nodeId: 'x' } }, 'READ_DEPENDENCY_CHANGED'],
    [(m) => { m.nodes.splice(1, 1) }, 'READ_DEPENDENCY_CHANGED'],
    [(m) => { m.lifecycleVersion = 1 }, 'LIFECYCLE_CONFLICT'],
  ]) {
    const current = structuredClone(latest); mutate(current)
    assert.throws(() => validateContentPreconditions(current, body), (e) => e.status === 409 && e.details.reasonCode === reason && e.details.retryable === false)
  }
  const missing = structuredClone(body); missing.preconditions.cards[0].fields = []
  assert.throws(() => validateContentPreconditions(before, missing), { code: 'CONTENT_PRECONDITION_INVALID' })
})
test('새 필드 계약은 최신 배열 순서를 보존하고 실제 순서·관계 변경과 레거시는 엄격하다', () => {
  const before = fixture('map-unit')
  const body = request(before, (m) => { m.nodes[1].data.description = '수정' })
  const latest = structuredClone(before); latest.version++; latest.nodes.reverse()
  assert.deepEqual(validateContentPreconditions(latest, body).nodeOrder, latest.nodes.map((n) => n.id))
  const reorder = request(before, (m) => { m.nodes.reverse() })
  assert.throws(() => validateContentPreconditions(latest, reorder), { code: 'VERSION_CONFLICT' })
  const edge = request(before, (m) => { m.edges[0].data.knowledgePolicy = 'reuse-first' })
  assert.throws(() => validateContentPreconditions(latest, edge), { code: 'VERSION_CONFLICT' })
  delete body.preconditions
  assert.throws(() => validateContentPreconditions(latest, body), { code: 'VERSION_CONFLICT' })
})
test('완료·대기 해제의 읽기 조건과 보호 구간의 텍스트 경계 유일성을 검사한다', () => {
  const before = fixture('map-unit')
  const body = request(before, (m) => { m.nodes[1].data.status = 'done' })
  const latest = structuredClone(before); latest.nodes[1].data.waitingItems = [{ label: '새 대기' }]
  assert.throws(() => validateContentPreconditions(latest, body), (e) => e.details.reasonCode === 'READ_DEPENDENCY_CHANGED')
  before.nodes[1].data.description = '경계 경계'
  const p = request(before, (m) => { m.nodes[1].data.description = '새 본문' })
  const op = { cardId: 'card-1', field: 'description', expectedSha256: textIntegrity('경계 경계').sha256,
    operation: { type: 'replace_once', find: '경계', replace: '수정' } }
  assert.throws(() => validateTextOperations(before, p.patch, [op]), { code: 'TEXT_PATCH_MATCH_COUNT' })
})
