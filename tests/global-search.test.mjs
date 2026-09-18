import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GlobalSearchInputError,
  normalizeGlobalSearchRequest,
  normalizeSearchText,
  searchGlobalContent,
} from '../server/lib/globalSearch.mjs'

function node(id, label, data = {}) {
  return {
    id,
    type: 'mind',
    position: { x: 0, y: 0 },
    data: { label, description: '', progress: 0, status: 'planned', kind: 'task', ...data },
  }
}

function map(id, title, nodes, edges = []) {
  return { id, title, version: 3, updatedAt: '2026-09-18T00:00:00.000Z', nodes, edges }
}

test('한글·공백을 정규화하고 카드의 사용자 콘텐츠별 일치 근거를 반환한다', () => {
  const document = map('map-a', '검색 문서', [
    node('root', '전체 검색', { kind: 'root' }),
    node('task', '권한 검증', {
      description: '편집자와 공개 뷰어의 접근 범위를 확인합니다.',
      sharedKnowledge: 'Ref 원본의 최신 결론을 사용합니다.',
      checklist: [{ id: 'check', text: '한글 검색을 검증한다.', done: false }],
      waitingItems: [{ id: 'wait', label: '서버 응답', note: '권한 필터 대기', resumeCondition: 'API 배포' }],
      isWork: true,
      assigneeId: 'editor',
    }),
  ], [{ source: 'root', target: 'task', data: { relation: 'hierarchy' } }])
  const commentsByMap = new Map([['map-a', [{
    id: 'comment-a', mapId: 'map-a', nodeId: 'task', summary: '공개 뷰어 확인', detail: '댓글 상세와 답글도 검색합니다.', parentId: null,
  }]]])
  const request = normalizeGlobalSearchRequest({ query: '공개   뷰어', limit: 20 })
  const result = searchGlobalContent({
    maps: [document],
    commentsByMap,
    users: [{ id: 'editor', name: '김용민' }],
    publicBaseUrl: 'http://example.test',
    request,
  })

  assert.equal(normalizeSearchText(' 공개\n\t뷰어 '), '공개 뷰어')
  assert.ok(result.results.some((item) => item.field === 'description'))
  assert.ok(result.results.some((item) => item.field === 'comments' && item.commentId === 'comment-a'))
  assert.equal(result.results[0].mapId, 'map-a')
  assert.equal(result.results[0].cardId, 'task')
  assert.deepEqual(result.results[0].path, ['전체 검색', '권한 검증'])
  assert.equal(result.coverage.semanticCoverage, 'not-guaranteed')
  assert.equal(result.page.hasMore, false)
})

test('필터를 조합하고 내부 AI 식별자는 검색하지 않는다', () => {
  const document = map('map-filter', '필터 문서', [
    node('work', '진행 업무', {
      isWork: true,
      status: 'in-progress',
      assigneeId: 'editor',
      waitingItems: [{ id: 'wait', label: '서버 대기' }],
      aiConversationId: 'secret-conversation',
    }),
    node('knowledge', '완료 지식', { kind: 'branch', status: 'done', isWork: false }),
  ])
  const filtered = searchGlobalContent({
    maps: [document],
    users: [{ id: 'editor', name: '김용민' }],
    request: {
      query: '김용민',
      kinds: ['task'],
      statuses: ['in-progress'],
      assigneeIds: ['editor'],
      isWork: true,
      hasWaitingItems: true,
    },
  })
  assert.equal(filtered.results.length, 1)
  assert.equal(filtered.results[0].fieldLabel, '담당자')

  const internal = searchGlobalContent({ maps: [document], request: { query: 'secret-conversation' } })
  assert.equal(internal.page.total, 0)
})

test('Ref 배치 결과는 저장된 복사본 대신 최신 원본과 원본 댓글을 검색한다', () => {
  const source = map('map-source', '원본 문서', [node('source-card', '최신 원본 제목', {
    description: '최신 검색 결론입니다.',
    sharedKnowledge: '검증된 원본 지식',
  })])
  const placement = map('map-placement', '배치 문서', [node('ref-card', '낡은 복사본 제목', {
    description: '낡은 복사본 내용',
    reference: { mapId: 'map-source', nodeId: 'source-card' },
  })])
  const commentsByMap = new Map([['map-source', [{
    id: 'source-comment', mapId: 'map-source', nodeId: 'source-card', text: '원본의 최신 댓글', parentId: null,
  }]]])

  const latest = searchGlobalContent({
    maps: [placement],
    sourceMaps: [placement, source],
    commentsByMap,
    request: { query: '최신' },
  })
  assert.ok(latest.results.some((item) => item.field === 'cardTitle'))
  assert.ok(latest.results.some((item) => item.field === 'description'))
  assert.ok(latest.results.some((item) => item.field === 'comments'))
  assert.ok(latest.results.every((item) => item.cardId === 'ref-card'))
  assert.ok(latest.results.every((item) => item.reference?.sourceCardId === 'source-card'))

  const stale = searchGlobalContent({ maps: [placement], sourceMaps: [placement, source], request: { query: '낡은 복사본' } })
  assert.equal(stale.page.total, 0)
})

test('상위 후보에서 멈추지 않고 커서 기반 카탈로그로 뒤의 담당 카드를 확인한다', () => {
  const cards = Array.from({ length: 11 }, (_, index) => node(
    `card-${index + 1}`,
    index === 10 ? '실제 담당 업무' : `검색 후보 ${index + 1}`,
    { description: index === 10 ? '표현이 달라 문자열 검색에는 나타나지 않는 진짜 소유 카드입니다.' : '일반 후보입니다.' },
  ))
  const document = map('map-catalog', '카탈로그 문서', cards)
  const first = searchGlobalContent({ maps: [document], request: { mode: 'catalog', limit: 10 } })
  assert.equal(first.page.total, 11)
  assert.equal(first.page.returned, 10)
  assert.equal(first.page.hasMore, true)
  assert.ok(first.page.nextCursor)
  assert.equal(first.results.some((item) => item.cardId === 'card-11'), false)

  const second = searchGlobalContent({
    maps: [document],
    request: { mode: 'catalog', limit: 10, cursor: first.page.nextCursor },
  })
  assert.equal(second.page.returned, 1)
  assert.equal(second.page.hasMore, false)
  assert.equal(second.results[0].cardId, 'card-11')
  assert.match(second.results[0].snippet, /진짜 소유 카드/)
})

test('검색 조건이 바뀐 커서와 잘못된 입력을 거부한다', () => {
  const document = map('map-cursor', '커서 문서', [node('a', '검색 A'), node('b', '검색 B')])
  const first = searchGlobalContent({ maps: [document], request: { query: '검색', limit: 1 } })
  assert.throws(
    () => searchGlobalContent({ maps: [document], request: { query: '다른 검색', limit: 1, cursor: first.page.nextCursor } }),
    (error) => error instanceof GlobalSearchInputError && error.code === 'GLOBAL_SEARCH_CURSOR_INVALID',
  )
  const changedDocument = { ...document, version: 4, nodes: [...document.nodes, node('c', '검색 C')] }
  assert.throws(
    () => searchGlobalContent({ maps: [changedDocument], request: { query: '검색', limit: 1, cursor: first.page.nextCursor } }),
    (error) => error instanceof GlobalSearchInputError && error.code === 'GLOBAL_SEARCH_CURSOR_INVALID',
  )
  assert.throws(() => normalizeGlobalSearchRequest({ mode: 'unknown' }), GlobalSearchInputError)
  assert.throws(() => normalizeGlobalSearchRequest({ limit: 101 }), GlobalSearchInputError)
  assert.throws(() => normalizeGlobalSearchRequest({ fields: ['internalToken'] }), GlobalSearchInputError)
})
