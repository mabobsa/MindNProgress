import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeDocumentCountInGroup,
  collapsedDocumentGroupsStorageKey,
  initialCollapsedDocumentGroupIds,
  normalizeCollapsedDocumentGroupIds,
} from '../src/utils/documentGroupCollapse.mjs'

test('저장된 선택이 없으면 모든 문서 그룹을 기본으로 접는다', () => {
  assert.deepEqual(initialCollapsedDocumentGroupIds(null, ['group-1', 'group-2']), ['group-1', 'group-2'])
  assert.deepEqual(initialCollapsedDocumentGroupIds(undefined, ['group-1']), ['group-1'])
})

test('저장된 접기 상태가 있으면 현재 존재하는 그룹만 복원한다', () => {
  assert.deepEqual(initialCollapsedDocumentGroupIds(['group-2', 'deleted-group'], ['group-1', 'group-2']), ['group-2'])
  assert.deepEqual(initialCollapsedDocumentGroupIds([], ['group-1', 'group-2']), [])
})

test('그룹 ID와 계정별 저장 키를 안전하게 정규화한다', () => {
  assert.deepEqual(normalizeCollapsedDocumentGroupIds([' group-1 ', 'group-1', '', 3]), ['group-1'])
  assert.equal(normalizeCollapsedDocumentGroupIds({}), null)
  assert.equal(collapsedDocumentGroupsStorageKey(' user-editor '), 'mindnprogress-collapsed-document-groups-v2:user-editor')
})

test('접힌 그룹의 AI 활동은 카드 수가 아닌 작업 중인 문서 수로 집계한다', () => {
  const activeCounts = { 'map-a': 3, 'map-b': 1, 'map-c': 0, 'map-outside': 2 }
  assert.equal(activeDocumentCountInGroup(['map-a', 'map-b', 'map-c'], activeCounts), 2)
  assert.equal(activeDocumentCountInGroup(['map-a', 'map-a'], activeCounts), 1)
  assert.equal(activeDocumentCountInGroup(['map-c'], activeCounts), 0)
  assert.equal(activeDocumentCountInGroup([], activeCounts), 0)
})
