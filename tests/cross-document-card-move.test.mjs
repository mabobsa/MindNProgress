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
