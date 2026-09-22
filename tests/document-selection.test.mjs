import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hierarchyAncestorNodeIds,
  isPhoneViewport,
  PHONE_VIEWPORT_QUERY,
  resolveDocumentNodeSelection,
  synchronizeNodeSelection,
} from '../src/utils/documentSelection.mjs'

const nodes = [{ id: 'root' }, { id: 'work' }]

test('휴대폰에서는 문서의 첫 카드를 자동 선택하지 않는다', () => {
  assert.equal(resolveDocumentNodeSelection(nodes, null, true), null)
})

test('태블릿과 데스크톱에서는 문서의 첫 카드 자동 선택을 유지한다', () => {
  assert.equal(resolveDocumentNodeSelection(nodes, null, false), 'root')
})

test('카드가 명시된 링크와 이동은 휴대폰에서도 해당 카드를 선택한다', () => {
  assert.equal(resolveDocumentNodeSelection(nodes, 'work', true), 'work')
})

test('휴대폰 판별은 기존 모바일 UI 경계와 같은 미디어 쿼리를 사용한다', () => {
  let receivedQuery = ''
  const matches = isPhoneViewport((query) => {
    receivedQuery = query
    return { matches: true }
  })

  assert.equal(matches, true)
  assert.equal(receivedQuery, PHONE_VIEWPORT_QUERY)
})

test('자식 카드를 추가해 선택하면 기존 부모 하이라이트를 해제하고 자식 하나만 하이라이트한다', () => {
  const parent = { id: 'parent', selected: true, label: '부모' }
  const sibling = { id: 'sibling', selected: false, label: '형제' }
  const child = { id: 'child', label: '새 자식' }
  const selected = synchronizeNodeSelection([parent, sibling, child], child.id)

  assert.deepEqual(selected.map((node) => [node.id, Boolean(node.selected)]), [
    ['parent', false],
    ['sibling', false],
    ['child', true],
  ])
  assert.equal(selected[1], sibling, '선택 상태가 바뀌지 않은 카드는 불필요하게 복제하지 않는다')
})

test('자동 선택으로 펼칠 상위 경로는 계층선만 따라가고 순환 관계에서도 종료한다', () => {
  const ancestors = hierarchyAncestorNodeIds([
    { source: 'root', target: 'branch' },
    { source: 'branch', target: 'work', data: { relation: 'hierarchy' } },
    { source: 'unrelated', target: 'work', data: { relation: 'knowledge' } },
    { source: 'work', target: 'root' },
  ], 'work')

  assert.deepEqual([...ancestors].sort(), ['branch', 'root'])
})
