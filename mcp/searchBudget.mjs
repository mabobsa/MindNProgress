// search_content 응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 한 번에 돌려주는 결과 수만 줄인다.
// 결과 내용(snippet·path 등)은 줄이지 않고, 남은 결과는 서버가 만든 nextCursor로 이어 읽게 한다.
// 커서는 서버만 만든다. 결과를 잘라 서버 커서를 그대로 넘기면 잘라낸 결과를 건너뛰므로,
// 같은 조건·커서로 limit만 줄여 서버에 다시 요청한다. 예산 안의 응답은 그대로 반환한다. 예산 값은 다른 조회 도구와 같다.

export const SEARCH_RESPONSE_BUDGET_CHARS = 40_000
// 재요청 사이에 데이터가 바뀌어 결과가 커질 수 있으므로 처음 요청을 포함해 최대 이만큼만 요청한다.
const MAX_SEARCH_REQUESTS = 3
const size = (value) => JSON.stringify(value).length

// 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이도록 맨 앞에 둔다.
const withBudget = (response, budget) => ({ responseBudget: budget, ...response })

function budgetFor(page, context) {
  const wanted = Math.max(0, Math.min(context.requestedLimit, Number(page.page.total) - Number(page.page.offset)))
  return {
    limitChars: context.limitChars,
    originalChars: context.originalChars,
    returnedChars: context.limitChars,
    requestedLimit: context.requestedLimit,
    returnedLimit: page.page.limit,
    deferredResults: Math.max(0, wanted - page.results.length),
    exceeded: false,
    rule: '응답이 약 4만 자를 넘어 요청한 limit보다 적은 앞쪽 결과만 반환했습니다. 결과 내용은 줄이지 않았고 건너뛴 결과도 없으니 page.hasMore가 true이면 page.nextCursor로 이어서 조회하세요.',
  }
}

// 앞쪽 결과부터 예산에 드는 최대 개수. 한 건도 들지 않으면 1건은 돌려준다.
function fittingCount(response, context) {
  const fits = (count) => {
    const page = { ...response, page: { ...response.page, limit: count, returned: count }, results: response.results.slice(0, count) }
    return size(withBudget(page, budgetFor(page, context))) <= context.limitChars
  }
  let low = 1
  let high = Math.max(1, response.results.length)
  if (!fits(low)) return low
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return low
}

function assertSearchPage(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.results) || !value.page) {
    throw new Error('검색 결과 형식을 확인하지 못했습니다.')
  }
  return value
}

/**
 * search_content 응답이 limitChars를 넘을 때만 같은 조건·커서로 limit을 줄여 다시 요청한 응답을 만든다.
 * requestPage(limit)는 limit만 바꾼 같은 검색을 서버에 요청해 MCP 응답 형태로 돌려준다. 넘지 않으면 원래 객체를 그대로 반환한다.
 */
export async function applySearchResponseBudget(response, { requestPage, limitChars = SEARCH_RESPONSE_BUDGET_CHARS } = {}) {
  if (!Array.isArray(response?.results) || !response.page || typeof requestPage !== 'function') return response
  const originalChars = size(response)
  if (originalChars <= limitChars) return response
  const context = { limitChars, originalChars, requestedLimit: Number(response.page.limit) || response.results.length }
  let current = response
  let result = null
  for (let request = 1; request < MAX_SEARCH_REQUESTS; request++) {
    const count = fittingCount(current, context)
    const page = assertSearchPage(await requestPage(count))
    result = withBudget(page, budgetFor(page, context))
    if (size(result) <= limitChars || count <= 1) break
    // 재요청 사이에 결과가 커졌다. 새 응답 기준으로 다시 개수를 정한다.
    current = page
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const returnedChars = size(result)
    if (result.responseBudget.returnedChars === returnedChars) break
    result.responseBudget.returnedChars = returnedChars
    result.responseBudget.exceeded = returnedChars > limitChars
  }
  return result
}
