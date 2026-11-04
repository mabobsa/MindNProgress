import assert from 'node:assert/strict'
import test from 'node:test'
import { libraryDropDestination, libraryDropTargetFromElement } from '../src/utils/libraryTouchDrop.mjs'

// closest·dataset·parentElement만 흉내 내는 최소 요소. 놓을 위치 선택자는 data-library-drop-key 하나뿐이다.
function element(dataset = {}, parent = null) {
  const node = { dataset, parentElement: parent }
  node.closest = (selector) => {
    assert.equal(selector, '[data-library-drop-key]')
    for (let current = node; current; current = current.parentElement) if (current.dataset.libraryDropKey) return current
    return null
  }
  return node
}

// App.tsx의 문서 목록 구조: 그룹 영역(그룹만 받음) > 그룹 헤더(문서만 받음)·그룹 안 문서(문서만 받음), 최상위 문서, 구분선, 목록 끝.
const nav = element()
const groupSection = element({ libraryDropKey: 'group:g1', libraryDropAccepts: 'group', libraryDropAction: 'top-before', libraryDropTargetType: 'group', libraryDropTargetId: 'g1' }, nav)
const groupHeader = element({ libraryDropKey: 'group:g1', libraryDropAccepts: 'map', libraryDropAction: 'group-append', libraryDropGroupId: 'g1' }, groupSection)
const headerLabel = element({}, groupHeader)
const groupItems = element({}, groupSection)
const groupMap = element({ libraryDropKey: 'group-map:g1:m2', libraryDropAccepts: 'map', libraryDropAction: 'group-insert', libraryDropGroupId: 'g1', libraryDropMapId: 'm2' }, groupItems)
const groupMapTitle = element({}, groupMap)
const topItem = element({}, nav)
const topMap = element({ libraryDropKey: 'top-map:m1', libraryDropAccepts: 'map', libraryDropAction: 'top-before', libraryDropTargetType: 'map', libraryDropTargetId: 'm1' }, topItem)
const topLine = element({ libraryDropKey: 'top-before:map:m1', libraryDropAccepts: 'any', libraryDropAction: 'top-before', libraryDropTargetType: 'map', libraryDropTargetId: 'm1' }, topItem)
const topStart = element({ libraryDropKey: 'top-start', libraryDropAccepts: 'any', libraryDropAction: 'top-start' }, nav)
const topEnd = element({ libraryDropKey: 'top-end', libraryDropAccepts: 'any', libraryDropAction: 'top-end' }, nav)
const first = { type: 'map', id: 'm1' }
const map = { type: 'map', id: 'm9' }
const group = { type: 'group', id: 'g9' }
const resolve = (start, dragged) => libraryDropDestination(libraryDropTargetFromElement(start, dragged.type), dragged, first)

test('문서를 끌면 PC 드래그와 같은 목적지로 옮긴다', () => {
  assert.deepEqual(resolve(groupMapTitle, map), { type: 'group', groupId: 'g1', targetMapId: 'm2' }, '그룹 안 문서 위: 그 문서 앞')
  assert.deepEqual(resolve(headerLabel, map), { type: 'group', groupId: 'g1' }, '그룹 헤더 위: 그룹 끝')
  assert.deepEqual(resolve(topMap, map), { type: 'top', target: { type: 'map', id: 'm1' } }, '최상위 문서 위: 그 문서 앞')
  assert.deepEqual(resolve(topLine, map), { type: 'top', target: { type: 'map', id: 'm1' } })
  assert.deepEqual(resolve(topStart, map), { type: 'top', target: first }, '목록 처음')
  assert.deepEqual(resolve(topEnd, map), { type: 'top' }, '목록 끝')
  assert.equal(resolve(groupItems, map), null, '그룹 영역 빈 곳은 문서를 받지 않는다(PC와 같음)')
  assert.equal(resolve(nav, map), null)
})

test('그룹을 끌면 그룹을 받는 바깥 위치까지 올라가 그룹 앞에 놓고, 그룹을 그룹 안에 넣지 않는다', () => {
  assert.deepEqual(resolve(groupMapTitle, group), { type: 'top', target: { type: 'group', id: 'g1' } }, '그룹 안 문서 위: 그 그룹 앞')
  assert.deepEqual(resolve(headerLabel, group), { type: 'top', target: { type: 'group', id: 'g1' } }, '그룹 헤더 위: 그 그룹 앞')
  assert.equal(resolve(topMap, group), null, '최상위 문서는 그룹을 받지 않는다')
  assert.deepEqual(resolve(topLine, group), { type: 'top', target: { type: 'map', id: 'm1' } }, '구분선은 모든 항목을 받는다')
  assert.deepEqual(resolve(topEnd, group), { type: 'top' })
  assert.equal(libraryDropDestination({ key: 'group:g1', action: 'group-append', groupId: 'g1' }, group, first), null)
  assert.equal(libraryDropDestination({ key: 'group-map:g1:m2', action: 'group-insert', groupId: 'g1', mapId: 'm2' }, group, first), null)
})

test('목록 밖이나 알 수 없는 위치는 놓지 않는다', () => {
  assert.equal(libraryDropTargetFromElement(null, 'map'), null)
  assert.equal(libraryDropDestination(null, map, first), null)
  assert.equal(libraryDropDestination({ key: 'x', action: 'unknown' }, map, first), null)
  assert.deepEqual(libraryDropDestination({ key: 'top-start', action: 'top-start' }, map, undefined), { type: 'top' }, '빈 목록의 처음은 끝과 같다')
})
