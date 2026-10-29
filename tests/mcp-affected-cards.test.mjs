import assert from 'node:assert/strict'
import test from 'node:test'
import { changedCardIds, referenceProjectedNode } from '../mcp/affectedCards.mjs'
import { projectReferenceNodeData } from '../server/lib/referenceProjection.mjs'

const source = { label: '원본 정책', description: '원본의 최신 설명', sharedKnowledge: '원본의 최신 공유 지식', progress: 40, status: 'in-progress' }
// 저장본(content-patch 응답)의 Ref 카드: 원본 투영 필드에 오래된 사본이 남아 있다.
const storedReference = (overrides = {}) => ({
  id: 'ref-card', type: 'mind', position: { x: 10, y: 20 },
  data: { label: '원본 정책 (ref)', kind: 'task', description: '예전 설명 사본', sharedKnowledge: '예전 공유 지식 사본', progress: 0, status: 'planned', reference: { mapId: 'map-source', nodeId: 'source-card' }, ...overrides },
})
// 변경 전 문서(GET 조회본)의 같은 Ref 카드: 원본 값이 투영돼 있다.
const resolvedReference = () => {
  const stored = storedReference()
  return { ...stored, data: projectReferenceNodeData(stored.data, source) }
}
const plain = (id, data = {}) => ({ id, type: 'mind', position: { x: 0, y: 0 }, data: { label: id, kind: 'task', progress: 0, status: 'planned', ...data } })

test('저장본과 조회본의 Ref 투영 차이만 있으면 변경으로 잡지 않는다', () => {
  const previousMap = { id: 'map-a', nodes: [plain('task-a'), resolvedReference()], edges: [] }
  const savedMap = { id: 'map-a', nodes: [plain('task-a', { progress: 50, status: 'in-progress' }), storedReference()], edges: [] }
  assert.deepEqual(changedCardIds(previousMap, savedMap), ['task-a'])
})

test('Ref 카드의 로컬 필드·위치 변경은 변경으로 잡는다', () => {
  const previousMap = { id: 'map-a', nodes: [resolvedReference()], edges: [] }
  assert.deepEqual(changedCardIds(previousMap, { id: 'map-a', nodes: [{ ...storedReference(), position: { x: 99, y: 20 } }], edges: [] }), ['ref-card'])
  assert.deepEqual(changedCardIds(previousMap, { id: 'map-a', nodes: [storedReference({ reference: { mapId: 'map-source', nodeId: 'other-card' } })], edges: [] }), ['ref-card'])
})

test('Ref 카드가 아니던 카드가 Ref가 되면 변경으로 잡는다', () => {
  const previousMap = { id: 'map-a', nodes: [plain('ref-card')], edges: [] }
  assert.deepEqual(changedCardIds(previousMap, { id: 'map-a', nodes: [storedReference()], edges: [] }), ['ref-card'])
})

test('응답의 Ref 카드는 다른 문서 원본이면 조회 시점 투영값을 쓴다', () => {
  const shown = referenceProjectedNode(storedReference(), resolvedReference(), { id: 'map-a', nodes: [] })
  assert.equal(shown.data.description, '원본의 최신 설명')
  assert.equal(shown.data.sharedKnowledge, '원본의 최신 공유 지식')
  assert.equal(shown.data.label, '원본 정책 (ref)')
  assert.deepEqual(shown.data.reference, { mapId: 'map-source', nodeId: 'source-card' })
  assert.deepEqual(shown.position, { x: 10, y: 20 })
})

test('같은 문서 원본을 가리키는 Ref 카드는 저장 후 원본 값을 투영한다', () => {
  const savedSource = plain('source-card', { label: '같은 문서 원본', description: '저장 후 원본 설명', progress: 100, status: 'done' })
  const stored = storedReference({ reference: { mapId: 'map-a', nodeId: 'source-card' } })
  const shown = referenceProjectedNode(stored, { ...stored, data: projectReferenceNodeData(stored.data, source) }, { id: 'map-a', nodes: [savedSource, stored] })
  assert.equal(shown.data.description, '저장 후 원본 설명')
  assert.equal(shown.data.status, 'done')
  assert.equal(shown.data.label, '같은 문서 원본 (ref)')
})

test('Ref가 아니거나 투영 근거가 없으면 저장본을 그대로 쓴다', () => {
  const card = plain('task-a')
  assert.equal(referenceProjectedNode(card, card, { id: 'map-a', nodes: [card] }), card)
  const newReference = storedReference()
  assert.equal(referenceProjectedNode(newReference, plain('ref-card'), { id: 'map-a', nodes: [] }), newReference)
})
