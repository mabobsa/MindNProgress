import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CrossDocumentCardMoveError,
  planCrossDocumentCardMove,
  rewriteMovedCardReferences,
} from '../server/lib/crossDocumentCardMove.mjs'

const node = (id, kind = 'task', data = {}) => ({
  id,
  type: 'mind',
  position: { x: 0, y: 0 },
  data: { label: id, kind, isWork: kind === 'task', status: 'planned', progress: 0, ...data },
})
const edge = (id, source, target, relation = 'hierarchy') => ({ id, source, target, data: { relation } })

function fixture() {
  return {
    sourceMap: {
      id: 'map-source',
      nodes: [node('source-root', 'root'), node('branch', 'branch'), node('child'), node('sibling')],
      edges: [
        edge('source-branch', 'source-root', 'branch'),
        edge('branch-child', 'branch', 'child'),
        edge('source-sibling', 'source-root', 'sibling'),
        edge('internal-knowledge', 'branch', 'child', 'knowledge'),
      ],
    },
    targetMap: {
      id: 'map-target',
      nodes: [node('target-root', 'root'), node('target-parent', 'branch')],
      edges: [edge('target-parent-edge', 'target-root', 'target-parent')],
    },
  }
}

test('다중 선택에서 부모·자식 중복을 제거하고 여러 하위 트리를 함께 옮긴다', () => {
  const maps = fixture()
  maps.sourceMap.nodes[2].data.aiConversationId = 'conversation-child'
  maps.sourceMap.edges.push(edge('between-trees', 'child', 'sibling', 'knowledge'))
  const before = structuredClone(maps)
  const result = planCrossDocumentCardMove({ ...maps, cardIds: ['child', 'branch', 'sibling', 'branch'],
    targetParentCardId: 'target-parent', targetPosition: { x: 400, y: 200 } })
  assert.deepEqual(result.rootCardIds, ['branch', 'sibling'])
  assert.deepEqual(result.sourceMap.nodes.map((n) => n.id), ['source-root'])
  assert.equal(result.targetMap.nodes.filter((n) => n.id === 'child').length, 1)
  assert.equal(result.targetMap.nodes.find((n) => n.id === 'child').data.aiConversationId, 'conversation-child')
  assert.deepEqual(result.targetMap.nodes.find((n) => n.id === 'child').position, { x: 400, y: 200 })
  assert.ok(result.targetMap.edges.some((e) => e.id === 'between-trees'))
  assert.equal(result.targetMap.edges.filter((e) => e.source === 'target-parent').length, 2)
  assert.deepEqual(maps, before)
})

test('같은 문서 이동은 외부 지식선·선행 관계를 유지하며 자기 하위로 붙여넣기를 거부한다', () => {
  const { sourceMap } = fixture()
  sourceMap.nodes[2].data.blockedBy = ['sibling']
  sourceMap.edges.push(edge('outside-knowledge', 'sibling', 'child', 'knowledge'))
  const result = planCrossDocumentCardMove({ sourceMap, targetMap: sourceMap, cardIds: ['branch', 'child'], targetParentCardId: 'sibling' })
  assert.equal(result.sourceMap, result.targetMap)
  assert.equal(result.targetMap.nodes.length, sourceMap.nodes.length)
  assert.ok(result.targetMap.edges.some((e) => e.source === 'sibling' && e.target === 'branch'))
  assert.ok(result.targetMap.edges.some((e) => e.id === 'outside-knowledge'))
  assert.deepEqual(result.targetMap.nodes[2].data.blockedBy, ['sibling'])
  assert.throws(() => planCrossDocumentCardMove({ sourceMap, targetMap: sourceMap, cardIds: ['branch'], targetParentCardId: 'child' }),
    (error) => error.code === 'CARD_MOVE_CYCLE')
})

test('다중 이동 중 한 카드의 충돌이나 루트 포함은 전체 이동을 거부한다', () => {
  const maps = fixture(), before = structuredClone(maps)
  maps.targetMap.nodes.push(node('sibling'))
  assert.throws(() => planCrossDocumentCardMove({ ...maps, cardIds: ['branch', 'sibling'], targetParentCardId: 'target-parent' }),
    (error) => error.code === 'CARD_MOVE_CARD_ID_COLLISION')
  assert.deepEqual(maps.sourceMap, before.sourceMap)
  assert.throws(() => planCrossDocumentCardMove({ ...maps, cardIds: ['branch', 'source-root'], targetParentCardId: 'target-parent' }),
    (error) => error.code === 'CARD_MOVE_ROOT_NOT_ALLOWED')
})

test('계층선 없이 배치된 자료·Ref 카드도 이동할 수 있다', () => {
  const maps = fixture()
  maps.sourceMap.edges = maps.sourceMap.edges.filter((e) => e.id !== 'source-sibling')
  const result = planCrossDocumentCardMove({ ...maps, cardIds: ['sibling'], targetParentCardId: 'target-parent' })
  assert.equal(result.previousParentCardId, null)
  assert.ok(result.targetMap.edges.some((e) => e.target === 'sibling'))
})

test('카드와 하위 트리를 ID와 내부 관계 그대로 다른 문서로 이동한다', () => {
  const result = planCrossDocumentCardMove({
    ...fixture(),
    cardId: 'branch',
    targetParentCardId: 'target-parent',
  })

  assert.deepEqual([...result.movedCardIds], ['branch', 'child'])
  assert.deepEqual(result.sourceMap.nodes.map((item) => item.id), ['source-root', 'sibling'])
  assert.deepEqual(result.sourceMap.edges.map((item) => item.id), ['source-sibling'])
  assert.deepEqual(result.targetMap.nodes.map((item) => item.id), ['target-root', 'target-parent', 'branch', 'child'])
  assert.equal(result.targetMap.edges.some((item) => item.id === 'branch-child'), true)
  assert.equal(result.targetMap.edges.some((item) => item.id === 'internal-knowledge'), true)
  assert.equal(result.targetMap.edges.some((item) => item.source === 'target-parent' && item.target === 'branch'), true)
  assert.equal(result.previousParentCardId, 'source-root')
})

test('이동 트리와 원본에 걸친 지식선과 선행 관계를 상세 정보와 함께 거부한다', () => {
  const knowledge = fixture()
  knowledge.sourceMap.edges.push(edge('boundary-knowledge', 'sibling', 'child', 'knowledge'))
  assert.throws(() => planCrossDocumentCardMove({
    ...knowledge,
    cardId: 'branch',
    targetParentCardId: 'target-parent',
  }), (error) => {
    assert.equal(error instanceof CrossDocumentCardMoveError, true)
    assert.equal(error.code, 'CARD_MOVE_CROSS_DOCUMENT_RELATION')
    assert.deepEqual(error.details.knowledgeEdges, [{ id: 'boundary-knowledge', source: 'sibling', target: 'child' }])
    return true
  })

  const blocked = fixture()
  blocked.sourceMap.nodes.find((item) => item.id === 'child').data.blockedBy = ['sibling']
  assert.throws(() => planCrossDocumentCardMove({
    ...blocked,
    cardId: 'branch',
    targetParentCardId: 'target-parent',
  }), (error) => error.code === 'CARD_MOVE_CROSS_DOCUMENT_RELATION'
    && error.details.blockedBy[0].cardId === 'child')
})

test('이동된 카드를 가리키는 Ref는 카드 ID를 유지하고 문서 ID만 변경한다', () => {
  const referenceMap = {
    id: 'map-reference',
    nodes: [
      node('ref-moved', 'branch', { reference: { mapId: 'map-source', nodeId: 'child' } }),
      node('ref-stays', 'branch', { reference: { mapId: 'map-source', nodeId: 'sibling' } }),
    ],
    edges: [],
  }
  const result = rewriteMovedCardReferences(referenceMap, 'map-source', 'map-target', new Set(['branch', 'child']))
  assert.equal(result.updatedReferenceCount, 1)
  assert.deepEqual(result.map.nodes[0].data.reference, { mapId: 'map-target', nodeId: 'child' })
  assert.deepEqual(result.map.nodes[1].data.reference, { mapId: 'map-source', nodeId: 'sibling' })
})

test('루트 카드와 대상 문서의 카드 ID 충돌을 거부한다', () => {
  const maps = fixture()
  assert.throws(() => planCrossDocumentCardMove({
    ...maps,
    cardId: 'source-root',
    targetParentCardId: 'target-parent',
  }), (error) => error.code === 'CARD_MOVE_ROOT_NOT_ALLOWED')

  maps.targetMap.nodes.push(node('child'))
  assert.throws(() => planCrossDocumentCardMove({
    ...maps,
    cardId: 'branch',
    targetParentCardId: 'target-parent',
  }), (error) => error.code === 'CARD_MOVE_CARD_ID_COLLISION'
    && error.details.cardIds.includes('child'))
})
