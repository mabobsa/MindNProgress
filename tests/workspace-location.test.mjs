import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeWorkspaceLocation,
  restorableWorkspaceLocation,
  workspaceLocationStorageKey,
  workspaceLocationPath,
} from '../src/utils/workspaceLocation.mjs'

test('마지막 작업 위치를 계정별 저장 형식으로 정규화한다', () => {
  assert.equal(workspaceLocationStorageKey(' user-editor '), 'mindnprogress-last-location:user-editor')
  assert.deepEqual(normalizeWorkspaceLocation({
    mapId: ' map-2 ',
    viewMode: 'kanban',
    nodeId: ' node-3 ',
  }), {
    mapId: 'map-2',
    viewMode: 'kanban',
    nodeId: 'node-3',
  })
})

test('손상되었거나 지원하지 않는 마지막 작업 위치는 사용하지 않는다', () => {
  assert.equal(normalizeWorkspaceLocation(null), null)
  assert.equal(normalizeWorkspaceLocation({ mapId: '', viewMode: 'mindmap' }), null)
  assert.equal(normalizeWorkspaceLocation({ mapId: 'map-1', viewMode: 'unknown' }), null)
  assert.equal(workspaceLocationStorageKey(''), null)
})

test('현재 문서 목록에 남아 있는 마지막 작업 위치만 복원한다', () => {
  const location = { mapId: 'map-2', viewMode: 'timeline', nodeId: 'node-7' }
  assert.deepEqual(restorableWorkspaceLocation(location, ['map-1', 'map-2']), location)
  assert.equal(restorableWorkspaceLocation(location, ['map-1']), null)
  assert.equal(restorableWorkspaceLocation(location, null), null)
})

test('선택한 문서와 카드의 새로고침 주소를 보기 방식과 함께 만든다', () => {
  assert.equal(workspaceLocationPath({ mapId: 'map-other', viewMode: 'mindmap', nodeId: 'task' }), '/mindmap/map-other/task')
  assert.equal(workspaceLocationPath({ mapId: 'map-other', viewMode: 'kanban', nodeId: null }), '/kanban/map-other')
  assert.equal(workspaceLocationPath({ mapId: '문서/1', viewMode: 'timeline', nodeId: '카드 #2' }, true), `/viewer/timeline/${encodeURIComponent('문서/1')}/${encodeURIComponent('카드 #2')}`)
  assert.equal(workspaceLocationPath({ mapId: '', viewMode: 'mindmap' }), null)
})
