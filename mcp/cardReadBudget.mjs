// get_card·list_comments 응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 줄인다. 예산 값은 get_context·outline·list_ai_delegations와 같다.
// 댓글은 요청 순서의 앞쪽부터 예산에 드는 만큼만 돌려주고 limit·nextOffset을 반환한 댓글 기준으로 맞춘다. 반환한 댓글의 요약·상세는 줄이지 않고 건너뛴 댓글도 없다.
// get_card는 댓글 페이지를 먼저 줄이고, 그래도 넘으면 fields로 고르지 않은 2,000자 초과 보조 필드와 description·sharedKnowledge 원문(큰 것부터)을 생략한다.
// fields로 직접 고른 필드는 줄이지 않는다. 예산 안의 응답은 그대로 반환한다.

export const CARD_READ_RESPONSE_BUDGET_CHARS = 40_000
const CARD_KEPT_FIELDS = new Set(['label', 'kind', 'status', 'progress', 'isWork', 'description', 'sharedKnowledge', 'checklist', 'waitingItems', 'blockedBy'])
const CARD_TEXT_FIELDS = ['description', 'sharedKnowledge']
const CARD_LARGE_FIELD_CHARS = 2000
const size = (value) => JSON.stringify(value).length

// 예산에 드는 가장 많은 댓글 수를 찾는다. 댓글 수가 늘수록 응답도 커지므로 이분 탐색으로 충분하다.
function largestFittingCount(total, minimum, fitsWith) {
  let low = minimum
  let high = total
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fitsWith(middle)) low = middle
    else high = middle - 1
  }
  return low
}

// 반환한 댓글 기준으로 페이지 정보를 맞춘다. 단순히 offset+limit로 다음 위치를 계산해도 댓글을 건너뛰지 않게 limit도 반환 수로 바꾼다.
function shrunkPage(page, count) {
  const nextOffset = page.offset + count
  const hasMore = nextOffset < page.total
  return { ...page, limit: count, hasMore, nextOffset: hasMore ? nextOffset : null }
}

function finalize(result, budgetKey, limitChars) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const returnedChars = size(result)
    if (result[budgetKey].returnedChars === returnedChars) break
    result[budgetKey].returnedChars = returnedChars
    result[budgetKey].exceeded = returnedChars > limitChars
  }
  return result
}

/** list_comments 페이지가 limitChars를 넘을 때만 앞쪽 댓글부터 예산에 드는 만큼 남긴 새 응답을 만든다(최소 1건). */
export function applyCommentListBudget(response, { mapId, cardId, includeDetail = false, limitChars = CARD_READ_RESPONSE_BUDGET_CHARS } = {}) {
  if (!Array.isArray(response?.comments) || !Number.isInteger(response.offset) || !Number.isInteger(response.total)) return response
  const originalChars = size(response)
  if (originalChars <= limitChars) return response
  const { comments, ...page } = response
  const requestedLimit = response.limit
  const build = (count) => {
    const shown = shrunkPage(page, count)
    return {
      // 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이도록 맨 앞에 둔다.
      responseBudget: { limitChars, originalChars, returnedChars: limitChars, requestedLimit, returnedComments: count, exceeded: false },
      omitted: {
        scope: '응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 이 페이지의 댓글 수만 줄였습니다. 반환한 댓글의 요약·상세는 그대로이고 건너뛴 댓글은 없습니다.',
        rule: 'hasMore가 true이면 nextOffset부터 이어서 조회하세요. 반환하지 않은 댓글의 내용을 추측하지 마세요.',
        retrieval: { comments: { tool: 'mindnprogress_list_comments', arguments: {
          mapId, ...(cardId ? { cardId } : {}), offset: shown.nextOffset ?? shown.offset + count, limit: requestedLimit, order: page.order, includeDetail } } },
      },
      comments: comments.slice(0, count),
      ...shown,
    }
  }
  const count = largestFittingCount(comments.length - 1, Math.min(1, comments.length), (candidate) => size(build(candidate)) <= limitChars)
  return finalize(build(count), 'responseBudget', limitChars)
}

// 댓글 수와 그에 맞는 페이지·안내·회수 인자를 함께 바꾼다. 후보마다 안내까지 넣은 크기로 판정해야 최종 응답이 예산을 넘지 않는다.
function setCommentCount(working, state, context, count) {
  const { comments, page } = state.commentSource
  working.comments = comments.slice(0, count)
  if (count === comments.length) {
    working.commentsPage = page
    delete state.fields.comments
    delete state.retrieval.comments
    return
  }
  working.commentsPage = shrunkPage(page, count)
  state.fields.comments = count > 0
    ? `댓글 페이지를 앞쪽 ${count}건으로 줄였습니다. 반환한 댓글은 그대로이고, 나머지는 retrieval.comments(list_comments의 nextOffset)로 이어서 조회하세요.`
    : '댓글 본문을 모두 생략했습니다. 댓글은 retrieval.comments(list_comments)로 조회하세요.'
  state.retrieval.comments = { tool: 'mindnprogress_list_comments', arguments: {
    mapId: context.mapId, cardId: context.cardId, offset: page.offset + count, limit: context.commentLimit, order: page.order, includeDetail: context.includeCommentDetail } }
}

const CARD_READ_STEPS = [
  {
    id: 'commentPage',
    apply(working, state, fits, context) {
      if (!context.includeComments || !Array.isArray(working.comments) || working.comments.length === 0 || !working.commentsPage) return false
      state.commentSource = { comments: working.comments, page: working.commentsPage }
      // 이 단계 전에 예산을 넘었으므로 모든 댓글을 남기는 경우는 후보가 아니다.
      const count = largestFittingCount(working.comments.length - 1, 0, (candidate) => { setCommentCount(working, state, context, candidate); return fits() })
      setCommentCount(working, state, context, count)
      return true
    },
  },
  {
    id: 'cardLargeFields',
    apply(working, state, fits, context) {
      if (context.fields) return false
      const data = working.card?.data ?? {}
      const keys = Object.keys(data).filter((key) => !CARD_KEPT_FIELDS.has(key) && size(data[key]) > CARD_LARGE_FIELD_CHARS)
      if (keys.length === 0) return false
      for (const key of keys) delete data[key]
      state.omittedFields.push(...keys)
      state.fields['card.data(큰 보조 필드)'] = `${CARD_LARGE_FIELD_CHARS.toLocaleString('en-US')}자를 넘는 보조 필드(card.omittedFields)를 생략했습니다. 상태·checklist·waitingItems·blockedBy와 description·sharedKnowledge는 남겼습니다.`
      return true
    },
  },
  {
    id: 'cardTextFields',
    apply(working, state, fits, context) {
      if (context.fields) return false
      const data = working.card?.data ?? {}
      // 큰 원문부터 하나씩 뺀다. 한 필드만 빼서 예산에 들면 다른 원문은 그대로 둔다.
      const keys = CARD_TEXT_FIELDS.filter((key) => typeof data[key] === 'string').sort((a, b) => data[b].length - data[a].length)
      let removed = 0
      for (const key of keys) {
        if (fits()) break
        delete data[key]
        state.omittedFields.push(key)
        // 생략 기록을 먼저 남긴 뒤 크기를 다시 재야 최종 응답이 예산을 넘지 않는다.
        state.fields['card.data(원문)'] = '원문(card.omittedFields의 description·sharedKnowledge)을 생략했습니다. 길이·SHA-256은 card.textIntegrity에 있습니다. 작업을 판단하기 전에 retrieval.cardFields로 한 필드씩 먼저 읽으세요.'
        removed++
      }
      return removed > 0
    },
  },
]

export const CARD_READ_BUDGET_STEP_IDS = Object.freeze(CARD_READ_STEPS.map((step) => step.id))

function assembleCard(working, state, context) {
  const omittedFields = [...state.omittedFields]
  const retrieval = { ...state.retrieval }
  if (omittedFields.length > 0) {
    retrieval.cardFields = { tool: 'mindnprogress_get_card', arguments: { mapId: context.mapId, cardId: context.cardId, fields: ['<field>'], includeComments: false },
      note: '생략한 필드는 한 번에 하나씩 조회하세요. 원문 한 필드가 4만 자 안팎이면 그 조회도 클라이언트 한도를 넘을 수 있습니다.' }
  }
  const fields = { ...state.fields }
  if (context.fields) fields['card(fields)'] = 'fields로 고른 필드는 줄이지 않았습니다. 그 필드만으로 예산을 넘으면 fields를 나눠 한 필드씩 조회하세요.'
  const omitted = {
    scope: '응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 댓글 페이지를 먼저 줄이고, 그래도 넘으면 fields로 고르지 않은 큰 보조 필드와 description·sharedKnowledge 원문(큰 것부터)만 생략했습니다.',
    fields,
    ...(omittedFields.length > 0 ? { cardFields: omittedFields } : {}),
    rule: '생략된 원문이나 댓글을 추측하거나 삭제로 해석하지 말고, 판단·수정에 필요하면 retrieval로 먼저 조회하세요. card.textIntegrity는 생략과 무관하게 전체 원문 기준입니다.',
    retrieval,
  }
  const responseBudget = { limitChars: context.limitChars, originalChars: context.originalChars, returnedChars: context.limitChars,
    appliedSteps: [...state.applied], exceeded: false }
  // 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이도록 document 바로 뒤에 둔다.
  const result = {}
  for (const [key, value] of Object.entries(working)) {
    result[key] = key === 'card' && omittedFields.length > 0 ? { ...value, omittedFields } : value
    if (key === 'document') Object.assign(result, { responseBudget, omitted })
  }
  if (!('responseBudget' in result)) Object.assign(result, { responseBudget, omitted })
  return result
}

/** get_card 응답이 limitChars를 넘을 때만 댓글 페이지 → 큰 보조 필드 → 큰 원문 순으로 줄인 새 응답을 만든다. 넘지 않으면 원래 객체를 그대로 반환한다. */
export function applyCardReadBudget(response, {
  mapId, cardId, fields, includeComments = true, commentLimit = 20, includeCommentDetail = false, limitChars = CARD_READ_RESPONSE_BUDGET_CHARS,
} = {}) {
  if (!response?.card) return response
  const originalChars = size(response)
  if (originalChars <= limitChars) return response
  const working = structuredClone(response)
  const state = { fields: {}, omittedFields: [], retrieval: {}, applied: [] }
  const context = { mapId, cardId: cardId ?? response.card.id, fields, includeComments, commentLimit, includeCommentDetail, limitChars, originalChars }
  const fits = () => size(assembleCard(working, state, context)) <= limitChars
  for (const step of CARD_READ_STEPS) {
    // 단계 안에서 크기를 잴 때도 appliedSteps에 이 단계가 들어 있어야 최종 크기와 같다. 줄인 것이 없으면 뺀다.
    state.applied.push(step.id)
    if (!step.apply(working, state, fits, context)) state.applied.pop()
    if (fits()) break
  }
  // 보조 필드·원문을 생략해 생긴 여유만큼 댓글을 다시 채운다. 이미 생략한 필드는 댓글이 없어도 예산을 넘었으므로 되돌리지 않는다.
  if (state.commentSource && state.applied.length > 1) {
    const total = state.commentSource.comments.length
    const count = largestFittingCount(total, working.comments.length, (candidate) => { setCommentCount(working, state, context, candidate); return fits() })
    setCommentCount(working, state, context, count)
    if (count === total) state.applied.splice(state.applied.indexOf('commentPage'), 1)
  }
  return finalize(assembleCard(working, state, context), 'responseBudget', limitChars)
}
