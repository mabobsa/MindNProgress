import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildGlobalSearchPath,
  globalSearchHighlightSegments,
  mergeGlobalSearchResults,
} from '../src/utils/globalSearch.mjs'

test('화면 검색 요청이 조합된 필터와 커서를 반복 쿼리로 전달한다', () => {
  const path = buildGlobalSearchPath({
    query: '담당 카드',
    groupIds: ['group-a'],
    fields: ['cardTitle', 'description'],
    kinds: ['task'],
    statuses: ['planned', 'in-progress'],
    assigneeIds: ['editor'],
    isWork: true,
    hasWaitingItems: false,
    limit: 30,
    cursor: 'next-page',
  })
  const url = new URL(path, 'http://localhost')
  assert.equal(url.pathname, '/api/search')
  assert.equal(url.searchParams.get('q'), '담당 카드')
  assert.deepEqual(url.searchParams.getAll('field'), ['cardTitle', 'description'])
  assert.deepEqual(url.searchParams.getAll('status'), ['planned', 'in-progress'])
  assert.equal(url.searchParams.get('isWork'), 'true')
  assert.equal(url.searchParams.get('hasWaitingItems'), 'false')
  assert.equal(url.searchParams.get('cursor'), 'next-page')
})

test('다음 페이지를 합칠 때 기존 검색 결과를 중복 추가하지 않는다', () => {
  const first = [{ mapId: 'map-a', cardId: 'card-a', field: 'description', snippet: '같은 결과' }]
  const merged = mergeGlobalSearchResults(first, [
    ...first,
    { mapId: 'map-a', cardId: 'card-b', field: 'description', snippet: '다음 결과' },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged[1].cardId, 'card-b')
})

test('일치 단어가 겹쳐도 문맥을 손실하지 않고 하이라이트 구간을 만든다', () => {
  const segments = globalSearchHighlightSegments('담당 카드와 카드 담당자', ['담당', '카드', '담당 카드'])
  assert.equal(segments.map((segment) => segment.text).join(''), '담당 카드와 카드 담당자')
  assert.ok(segments.some((segment) => segment.highlighted && segment.text === '담당 카드'))
  assert.ok(segments.some((segment) => segment.highlighted && segment.text === '카드'))
})
