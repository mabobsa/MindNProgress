import assert from 'node:assert/strict'
import test from 'node:test'
import { rootHandoffDocumentHash, rootHandoffDocumentMatches, upgradeRootHandoffHash } from '../server/lib/rootConversationHandoff.mjs'

const map = { id: 'map-fixture', version: 176, title: '인계 시험', nodes: [
  { id: 'root', data: { label: '루트', description: '사용자 승인 범위', aiPrimaryConversationId: 'previous', aiConversations: [] } },
  { id: 'child', data: { label: '하위', description: '업무 원문', checklist: [{ id: 'a', checked: false }, { id: 'b', checked: true }],
    sharedKnowledgeReview: { version: 1, status: 'accepted' }, aiPrimaryConversationId: 'worker' } },
], edges: [{ id: 'edge', source: 'root', target: 'child', data: { relation: 'hierarchy' } }] }
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value

test('인계 내용 해시는 저장 시 객체 속성 순서가 바뀌어도 같고 실제 값과 배열 순서 변경은 구분한다', () => {
  const changedOrder = reorder(map)
  changedOrder.version++
  changedOrder.nodes[0].data.aiConversations.push({ conversationId: 'successor' })
  assert.equal(rootHandoffDocumentHash(map, 'root'), rootHandoffDocumentHash(changedOrder, 'root'))
  assert.notEqual(rootHandoffDocumentHash(map, 'root', 1), rootHandoffDocumentHash(changedOrder, 'root', 1))
  for (const change of [m => { m.nodes[1].data.description += ' 변경' }, m => m.nodes[1].data.checklist.reverse(),
    m => { m.nodes[1].data.sharedKnowledgeReview.status = 'pending' }, m => { m.edges[0].target = 'other' },
    m => { m.nodes[0].data.description = '' }, m => { m.nodes[1].data.aiPrimaryConversationId = 'other' }]) {
    const modified = structuredClone(map); change(modified)
    assert.notEqual(rootHandoffDocumentHash(map, 'root'), rootHandoffDocumentHash(modified, 'root'))
  }
})

test('구버전 해시 복구는 원래 해시에 맞는 이력과 현재 내용 일치를 모두 증명해야 한다', () => {
  const instruction = { targetMapId: map.id, targetCardId: 'root', targetRevision: map.version, state: 'failed',
    reasonCode: 'GROUP_DOCUMENT_INSTRUCTION_HANDOFF_REVISION_CHANGED', rootHandoff: {
      requestId: 'unchanged-request', operationId: 'unchanged-operation', documentHash: rootHandoffDocumentHash(map, 'root', 1),
    } }
  const baseline = { map, revisionId: 'original-revision' }, current = reorder(map)
  current.version++
  const upgraded = upgradeRootHandoffHash(instruction, baseline, current, '2026-11-11T07:30:00.000Z')
  assert.equal(upgraded.documentHashVersion, 2)
  assert.equal(upgraded.requestId, instruction.rootHandoff.requestId)
  assert.equal(upgraded.operationId, instruction.rootHandoff.operationId)
  assert.equal(upgraded.legacyDocumentHash, instruction.rootHandoff.documentHash)
  assert.equal(upgraded.hashUpgrade.baselineRevisionId, baseline.revisionId)
  assert.equal(upgraded.hashUpgrade.previousReasonCode, instruction.reasonCode)
  assert.equal(rootHandoffDocumentMatches(current, 'root', upgraded), true)
  assert.equal(upgradeRootHandoffHash(instruction, { map: current }, current), null, '현재 값으로 기대값을 덮어쓰지 않는다')
  assert.equal(upgradeRootHandoffHash(instruction, null, current), null, '이력 증거가 없으면 복구하지 않는다')
  const wrongVersion = { map: { ...map, version: 175 }, revisionId: 'other-revision' }
  assert.equal(upgradeRootHandoffHash(instruction, wrongVersion, current), null)
  current.nodes[1].data.description += ' 실제 변경'
  assert.equal(upgradeRootHandoffHash(instruction, baseline, current), null)
  assert.equal(upgradeRootHandoffHash({ ...instruction, rootHandoff: upgraded }, baseline, map), null, '갱신은 한 번만 수행한다')
})
