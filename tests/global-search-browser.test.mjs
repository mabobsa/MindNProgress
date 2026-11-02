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

test('줄임표가 포함된 검색 미리보기에서 다음 문자가 아닌 검색어를 강조한다', () => {
  for (const text of [
    '…Intel 실행 시 호환 중앙 지연이 약 2.41초였다.',
    '…CPU 20.001초 → GPU 2.216초였다.',
    '…1초…다시 1초…',
  ]) {
    const segments = globalSearchHighlightSegments(text, ['1초'])
    assert.equal(segments.map(segment => segment.text).join(''), text)
    assert.deepEqual(segments.filter(segment => segment.highlighted).map(segment => segment.text),
      [...text.matchAll(/1초/g)].map(match => match[0]))
  }
})

test('정규화로 길이가 바뀌어도 원문 범위와 대소문자 검색을 보존한다', () => {
  for (const [text, terms, highlighted] of [
    ['…Ｆｏｏ １초였다.', ['foo', '1초'], ['Ｆｏｏ', '１초']],
    ['ﬃ 지연 1초였다.', ['ffi', '1초'], ['ﬃ', '1초']],
    ['İ 지연 1초였다.', ['1초'], ['1초']],
    ['각 지연 1초였다.', ['각', '1초'], ['각', '1초']],
    ['ㄱㅏ 지연 1초였다.', ['가', '1초'], ['ㄱㅏ', '1초']],
    ['é 지연 1초였다.', ['é', '1초'], ['é', '1초']],
    ['😀…1초 → 2초', ['😀', '1초'], ['😀', '1초']],
    ['ΟΣ…1초', ['ος', '1초'], ['ΟΣ', '1초']],
    ['…ﬃ와 1초', ['f', 'fi', '1초'], ['ﬃ', '1초']],
  ]) {
    const segments = globalSearchHighlightSegments(text, terms)
    assert.equal(segments.map(segment => segment.text).join(''), text)
    assert.deepEqual(segments.filter(segment => segment.highlighted).map(segment => segment.text), highlighted, text)
  }
})
