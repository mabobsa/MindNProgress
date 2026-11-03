import assert from 'node:assert/strict'
import test from 'node:test'
import { searchGlobalContent } from '../server/lib/globalSearch.mjs'
import { applySearchResponseBudget, SEARCH_RESPONSE_BUDGET_CHARS } from '../mcp/searchBudget.mjs'

const size = (value) => JSON.stringify(value).length
const guide = { resultMeaning: '후보', verification: '최신 원문 확인', completeness: '커서 확인', reporting: '범위 보고' }

// 문서 6개 × 카드 20장. 카드마다 제목·설명·공유 지식에 검색어가 있어 ranked 결과가 360건이고, 한 건이 수백 자다.
function fixtureMaps({ extra = '' } = {}) {
  return Array.from({ length: 6 }, (_, documentIndex) => {
    const mapId = `map-search-${documentIndex}`
    const nodes = [{ id: 'root', type: 'mind', position: { x: 0, y: 0 }, data: { label: `검색 문서 ${documentIndex}`, kind: 'root', status: 'planned' } }]
    const edges = []
    for (let index = 1; index <= 20; index++) {
      nodes.push({ id: `card-${index}`, type: 'mind', position: { x: 0, y: 0 }, data: {
        label: `예산 검색어 카드 ${documentIndex}-${index}${extra}`, kind: 'task', status: 'in-progress', isWork: true,
        description: `예산 검색어가 들어 있는 설명 ${documentIndex}-${index}. ${'결과 내용은 줄이지 않는다. '.repeat(12)}${extra}`,
        sharedKnowledge: `예산 검색어 공유 지식 ${documentIndex}-${index}. ${'다음 커서로 이어서 읽는다. '.repeat(12)}${extra}`,
      } })
      edges.push({ id: `edge-${index}`, source: 'root', target: `card-${index}`, data: { relation: 'hierarchy' } })
    }
    return { id: mapId, title: `검색 예산 문서 ${documentIndex}`, version: 1, updatedAt: '2026-11-03T00:00:00.000Z', nodes, edges }
  })
}

// MCP 핸들러와 같은 방식으로, limit만 바꾼 같은 검색을 다시 요청하는 함수를 만든다.
function searchClient(request, { maps = fixtureMaps(), mapsForCall } = {}) {
  const calls = []
  const requestPage = async (limit) => {
    calls.push(limit)
    const currentMaps = mapsForCall?.(calls.length) ?? maps
    return { ...searchGlobalContent({ maps: currentMaps, publicBaseUrl: 'http://mnp.example:4175', request: { ...request, limit } }), guide }
  }
  return { calls, requestPage }
}

const resultKey = (item) => [item.mapId, item.cardId ?? '', item.field, item.commentId ?? ''].join('|')

test('예산 안의 검색 응답은 같은 객체를 그대로 반환하고 다시 요청하지 않는다', async () => {
  const client = searchClient({ query: '예산 검색어', mode: 'ranked' })
  const response = await client.requestPage(25)
  assert.ok(size(response) <= SEARCH_RESPONSE_BUDGET_CHARS, `기본 limit 응답 ${size(response)}자`)
  assert.equal(await applySearchResponseBudget(response, { requestPage: client.requestPage }), response)
  assert.deepEqual(client.calls, [25])
})

for (const mode of ['ranked', 'catalog']) {
  test(`${mode}: 예산을 넘으면 결과 내용은 두고 limit을 줄여 다시 요청하며 정확한 크기와 커서를 알린다`, async () => {
    const client = searchClient({ query: mode === 'ranked' ? '예산 검색어' : '', mode })
    const response = await client.requestPage(100)
    assert.ok(size(response) > SEARCH_RESPONSE_BUDGET_CHARS, `원래 응답 ${size(response)}자`)
    const result = await applySearchResponseBudget(response, { requestPage: client.requestPage })
    const returnedLimit = client.calls[1]
    assert.equal(client.calls.length, 2)
    assert.ok(returnedLimit < 100 && returnedLimit > 1, `줄인 limit ${returnedLimit}`)
    assert.equal(Object.keys(result)[0], 'responseBudget')
    assert.equal(result.responseBudget.returnedChars, size(result))
    assert.ok(size(result) <= SEARCH_RESPONSE_BUDGET_CHARS)
    assert.equal(result.responseBudget.exceeded, false)
    assert.equal(result.responseBudget.originalChars, size(response))
    assert.equal(result.responseBudget.requestedLimit, 100)
    assert.equal(result.responseBudget.returnedLimit, returnedLimit)
    assert.equal(result.responseBudget.deferredResults, 100 - returnedLimit)
    assert.equal(result.page.limit, returnedLimit)
    assert.equal(result.results.length, returnedLimit)
    assert.equal(result.page.hasMore, true)
    // 결과 내용은 원래 응답의 앞쪽 결과와 글자 단위로 같고, 다음 커서는 서버가 줄인 limit 기준으로 만든 것이다.
    assert.deepEqual(result.results, response.results.slice(0, returnedLimit))
    const next = await searchClient({ query: mode === 'ranked' ? '예산 검색어' : '', mode, cursor: result.page.nextCursor }).requestPage(25)
    assert.equal(next.page.offset, returnedLimit)
    assert.deepEqual(next.results[0], response.results[returnedLimit], '다음 페이지는 잘라낸 바로 다음 결과부터 시작한다')
    assert.match(result.responseBudget.rule, /건너뛴 결과도 없으니.*nextCursor/)
    assert.deepEqual(result.guide, guide)
  })
}

test('줄어든 페이지를 nextCursor로 끝까지 이어 읽으면 limit 25로 읽은 결과와 순서까지 같고 빠지거나 겹치지 않는다', async () => {
  const request = { query: '예산 검색어', mode: 'ranked' }
  const read = async (limit) => {
    const keys = []
    let cursor = ''
    for (let pages = 0; pages < 100; pages++) {
      const client = searchClient({ ...request, cursor })
      const response = await applySearchResponseBudget(await client.requestPage(limit), { requestPage: client.requestPage })
      assert.ok(size(response) <= SEARCH_RESPONSE_BUDGET_CHARS)
      keys.push(...response.results.map(resultKey))
      if (!response.page.hasMore) return keys
      cursor = response.page.nextCursor
    }
    throw new Error('페이지가 끝나지 않았습니다.')
  }
  const budgeted = await read(100)
  const small = await read(25)
  assert.equal(budgeted.length, 360)
  assert.equal(new Set(budgeted).size, budgeted.length)
  assert.deepEqual(budgeted, small)
})

test('재요청 사이에 결과가 커져도 다시 개수를 정해 예산 안으로 맞춘다', async () => {
  const grown = fixtureMaps({ extra: ' 재요청 사이에 늘어난 문장.'.repeat(20) })
  const client = searchClient({ query: '예산 검색어', mode: 'ranked' }, { mapsForCall: (call) => (call >= 2 ? grown : fixtureMaps()) })
  const result = await applySearchResponseBudget(await client.requestPage(100), { requestPage: client.requestPage })
  assert.equal(client.calls.length, 3)
  assert.ok(client.calls[2] < client.calls[1])
  assert.ok(size(result) <= SEARCH_RESPONSE_BUDGET_CHARS)
  assert.equal(result.responseBudget.returnedChars, size(result))
  assert.equal(result.responseBudget.exceeded, false)
})

test('한 건도 예산에 들지 않으면 1건을 돌려주고 초과를 정확히 알린다', async () => {
  const client = searchClient({ query: '예산 검색어', mode: 'ranked' })
  const result = await applySearchResponseBudget(await client.requestPage(10), { requestPage: client.requestPage, limitChars: 300 })
  assert.deepEqual(client.calls, [10, 1])
  assert.equal(result.results.length, 1)
  assert.equal(result.responseBudget.exceeded, true)
  assert.equal(result.responseBudget.returnedChars, size(result))
  assert.equal(result.page.hasMore, true)
})

test('재요청 결과 형식이 다르면 잘린 응답 대신 오류를 낸다', async () => {
  const client = searchClient({ query: '예산 검색어', mode: 'ranked' })
  const response = await client.requestPage(100)
  await assert.rejects(applySearchResponseBudget(response, { requestPage: async () => ({ error: 'x' }) }), /검색 결과 형식/)
})
