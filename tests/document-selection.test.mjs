import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isPhoneViewport,
  PHONE_VIEWPORT_QUERY,
  resolveDocumentNodeSelection,
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
