// get_context(focused) 응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 데이터만 줄인다.
// 규칙(guide, groupProject, selection.taskLinks, selection.aiWorkCoordination, knowledgeSources.rule, nextStep)은 그대로 둔다.
// 덜 중요한 데이터부터 줄이고 예산 안에 들어오면 멈추며, 생략한 경로·개수·회수 도구를 응답 앞쪽 omitted에 기록한다.
// 예산 안의 응답은 그대로 반환한다. Claude Code 실측(MnP JSON 48,499자 통과, 56,289자 초과)에 여유를 둔 값이다.

export const CONTEXT_RESPONSE_BUDGET_CHARS = 40_000
const RECENT_COMMENT_LIMIT = 5
const SELECTED_LARGE_FIELD_CHARS = 2000
const SELECTED_KEPT_FIELDS = new Set(['label', 'kind', 'status', 'progress', 'isWork', 'checklist', 'waitingItems', 'blockedBy'])
const KNOWLEDGE_SOURCE_CORE_KEYS = new Set(['label', 'kind', 'status', 'progress', 'isWork', 'sharedKnowledge', 'sharedKnowledgeUpdatedAt', 'reference'])
const KNOWLEDGE_SOURCE_INDEX_KEYS = ['label', 'kind', 'status', 'progress', 'sharedKnowledge', 'reference']
const RELATION_KEYS = ['parents', 'children', 'siblings', 'ancestors', 'descendants', 'blockedBy', 'blocks']
const OMITTED_RULE = '생략된 원문을 추측하거나 생략된 상태를 근거로 판단·수정하지 말고, 판단과 작업에 필요한 원문은 retrieval의 도구로 먼저 조회하세요. 규칙(guide·groupProject·selection.taskLinks·selection.aiWorkCoordination·nextStep)은 생략하지 않았습니다.'
const NOT_OMITTED = 'guide, groupProject, aiAttribution, document의 메타·stats, selection.card의 상태·checklist·waitingItems·blockedBy·textIntegrity, selection.taskLinks(startupInspection 포함), selection.aiWorkCoordination, selection.knowledgeSources.rule과 모든 선행 지식 원천의 ID·정책·상태, selection.commentsPage, teamMembers, nextStep은 그대로 제공합니다.'

const size = (value) => JSON.stringify(value).length
const primaryOf = (response) => response.selection?.knowledgeSources?.primary ?? []
const fallbackOf = (response) => response.selection?.knowledgeSources?.fallback ?? []
const pick = (data, keys) => Object.fromEntries(keys.filter((key) => data?.[key] !== undefined).map((key) => [key, data[key]]))
const lengthsOnly = (textIntegrity) => Object.fromEntries(Object.entries(textIntegrity ?? {})
  .map(([field, value]) => [field, { length: value?.length ?? 0 }]))

function slimWaitingItems(card) {
  if (!Array.isArray(card?.waitingItems)) return false
  card.waitingItemCount = card.waitingItems.length
  delete card.waitingItems
  return true
}

function windowComments(response, mapId, cardId, keep) {
  const selection = response.selection
  if (!Array.isArray(selection?.comments) || selection.comments.length <= keep) return 0
  const removed = selection.comments.length - keep
  selection.comments = keep > 0 ? selection.comments.slice(-keep) : []
  const page = selection.commentsPage ?? {}
  selection.commentsPage = {
    ...page,
    included: selection.comments.length,
    hasMore: (page.total ?? 0) > selection.comments.length,
    detailToolArguments: selection.comments.some((comment) => comment.hasDetail === true)
      ? { mapId, cardId, offset: 0, limit: selection.comments.length, order: 'desc', includeDetail: true }
      : null,
    nextToolArguments: (page.total ?? 0) > selection.comments.length
      ? { mapId, cardId, offset: selection.comments.length, limit: 50, order: 'desc', includeDetail: false }
      : null,
  }
  return removed
}

// 낮은 가치부터 순서대로 적용한다. 각 단계는 실제로 줄인 것이 있을 때만 true를 반환하고 state에 생략 내용을 남긴다.
const BUDGET_STEPS = [
  {
    id: 'knowledgeSourceSupplements',
    apply(response, { state }) {
      let changed = false
      for (const source of primaryOf(response)) {
        for (const key of Object.keys(source.card?.data ?? {})) {
          if (!KNOWLEDGE_SOURCE_CORE_KEYS.has(key)) { delete source.card.data[key]; changed = true }
        }
        if (source.comments?.length) { source.comments = []; changed = true }
      }
      if (changed) {
        state.fields['selection.knowledgeSources.primary[].card.data'] = '설명(description)과 보조 필드를 생략했습니다. sharedKnowledge·상태와 본문 길이(card.textIntegrity)는 남겼습니다.'
        state.fields['selection.knowledgeSources.primary[].comments'] = '댓글을 생략했습니다. 개수는 commentsPage.total에 있습니다.'
        state.retrieval.add('knowledgeSource')
      }
      return changed
    },
  },
  {
    id: 'knowledgeSourceIndex',
    apply(response, { state }) {
      const knowledgeSources = response.selection?.knowledgeSources
      if (!knowledgeSources || (primaryOf(response).length === 0 && fallbackOf(response).length === 0)) return false
      knowledgeSources.primary = primaryOf(response).map((source) => ({
        policy: source.policy,
        card: { id: source.card?.id, data: pick(source.card?.data, KNOWLEDGE_SOURCE_INDEX_KEYS), textIntegrity: lengthsOnly(source.card?.textIntegrity) },
        commentsPage: { total: source.commentsPage?.total ?? 0 },
        ...(source.imageAccess ? { imageAccess: source.imageAccess } : {}),
      }))
      knowledgeSources.fallback = fallbackOf(response).map((source) => ({
        policy: source.policy,
        card: pick(source.card, ['id', 'label', 'kind', 'status', 'progress']),
        commentsPage: { total: source.commentsPage?.total ?? 0 },
        ...(source.imageAccess ? { imageAccess: source.imageAccess } : {}),
      }))
      state.fields['selection.knowledgeSources.primary[]·fallback[]'] = 'ID·제목·정책·상태와 본문 길이(card.textIntegrity의 length)만 남긴 색인입니다. accessUrl은 omitted.cardAccessUrlTemplate으로 만들고, 원문·SHA-256·댓글은 retrieval.knowledgeSource로 조회하세요.'
      state.cardAccessUrlTemplate = true
      state.retrieval.add('knowledgeSource')
      return true
    },
  },
  {
    id: 'knowledgeLinksScope',
    apply(response, { state, cardId }) {
      const links = response.document?.knowledgeLinks
      if (!Array.isArray(links)) return false
      const kept = links.filter((link) => link.sourceId === cardId || link.targetId === cardId)
      if (kept.length === links.length) return false
      response.document.knowledgeLinks = kept
      state.counts['document.knowledgeLinks'] = links.length - kept.length
      state.fields['document.knowledgeLinks'] = '선택 카드가 sourceId나 targetId인 지식선만 남겼습니다. 생략한 수는 omitted.counts에 있습니다.'
      state.retrieval.add('document')
      return true
    },
  },
  {
    id: 'waitingDetails',
    apply(response, { state }) {
      const selection = response.selection ?? {}
      let changed = false
      for (const key of RELATION_KEYS) for (const card of selection[key] ?? []) changed = slimWaitingItems(card) || changed
      for (const card of response.document?.outline ?? []) changed = slimWaitingItems(card) || changed
      if (changed) state.fields['selection.(관계 카드)[]·document.outline[]의 waitingItems'] = '대기 항목 원문 대신 waitingItemCount를 줍니다. 선택 카드의 waitingItems는 그대로입니다.'
      const topLevel = (selection.parents ?? []).length === 0
      if (topLevel && (selection.descendants ?? []).length > 0 && (response.document?.outline ?? []).length > 0) {
        state.counts['selection.descendants'] = selection.descendants.length
        selection.descendants = []
        state.fields['selection.descendants'] = '최상위 카드를 선택해 document.outline과 같은 카드라 생략했습니다. 생략한 수는 omitted.counts에 있습니다.'
        changed = true
      }
      return changed
    },
  },
  {
    id: 'recentComments',
    apply(response, { state, mapId, cardId }) {
      const removed = windowComments(response, mapId, cardId, RECENT_COMMENT_LIMIT)
      if (!removed) return false
      state.counts['selection.comments'] = (state.counts['selection.comments'] ?? 0) + removed
      state.fields['selection.comments'] = `최근 ${RECENT_COMMENT_LIMIT}건만 남겼습니다. 이전 댓글은 selection.commentsPage.nextToolArguments로 조회하세요.`
      return true
    },
  },
  {
    id: 'outlineFields',
    apply(response, { state }) {
      const outline = response.document?.outline
      if (!Array.isArray(outline) || outline.length === 0) return false
      response.document.outline = outline.map((card) => pick(card, ['id', 'label', 'parentId', 'status', 'progress']))
      state.fields['document.outline[]'] = 'id·label·parentId·status·progress만 남겼습니다.'
      state.retrieval.add('document')
      return true
    },
  },
  {
    id: 'knowledgeSourceSharedKnowledge',
    apply(response, { state, fits }) {
      const omitted = []
      const sources = primaryOf(response)
      for (let index = sources.length - 1; index >= 0 && !fits(); index--) {
        const data = sources[index].card?.data
        if (typeof data?.sharedKnowledge !== 'string') continue
        delete data.sharedKnowledge
        omitted.unshift(sources[index].card.id)
        state.cardIds.knowledgeSourceSharedKnowledge = [...omitted]
      }
      if (omitted.length === 0) return false
      state.fields['selection.knowledgeSources.primary[].card.data.sharedKnowledge'] = 'omitted.cardIds.knowledgeSourceSharedKnowledge의 카드는 원문을 생략했습니다. 길이는 card.textIntegrity.sharedKnowledge.length에 있습니다.'
      state.retrieval.add('knowledgeSource')
      return true
    },
  },
  {
    id: 'selectionComments',
    apply(response, { state, mapId, cardId }) {
      const removed = windowComments(response, mapId, cardId, 0)
      if (!removed) return false
      state.counts['selection.comments'] = (state.counts['selection.comments'] ?? 0) + removed
      state.fields['selection.comments'] = '댓글 원문을 모두 생략했습니다. 개수는 selection.commentsPage.total에 있고 selection.commentsPage.nextToolArguments로 조회합니다.'
      return true
    },
  },
  {
    id: 'outline',
    apply(response, { state }) {
      const outline = response.document?.outline
      if (!Array.isArray(outline) || outline.length === 0) return false
      state.counts['document.outline'] = outline.length
      response.document.outline = []
      state.fields['document.outline'] = '문서 개요를 생략했습니다. 카드 수는 document.stats에 있습니다. 큰 문서는 get_document 응답도 한도를 넘을 수 있으니 필요한 카드만 get_card로 조회하세요.'
      state.retrieval.add('document')
      return true
    },
  },
  ...['description', 'sharedKnowledge'].map((field) => ({
    id: field === 'description' ? 'selectedDescription' : 'selectedSharedKnowledge',
    apply(response, { state }) {
      const data = response.selection?.card?.data
      if (typeof data?.[field] !== 'string') return false
      delete data[field]
      state.selectedCardFields.push(field)
      state.fields[`selection.card.data.${field}`] = `원문을 생략했습니다. 길이·SHA-256은 selection.card.textIntegrity.${field}에 있습니다. 작업을 판단하기 전에 retrieval.selectedCard로 먼저 읽으세요.`
      state.retrieval.add('selectedCard')
      return true
    },
  })),
  {
    id: 'selectedLargeFields',
    apply(response, { state }) {
      const data = response.selection?.card?.data ?? {}
      const fields = Object.keys(data).filter((key) => !SELECTED_KEPT_FIELDS.has(key) && size(data[key]) > SELECTED_LARGE_FIELD_CHARS)
      if (fields.length === 0) return false
      for (const key of fields) delete data[key]
      state.selectedCardFields.push(...fields)
      state.fields['selection.card.data(큰 보조 필드)'] = `${SELECTED_LARGE_FIELD_CHARS.toLocaleString('en-US')}자를 넘는 보조 필드(omitted.selectedCardFields)를 생략했습니다. checklist·waitingItems는 그대로입니다.`
      state.retrieval.add('selectedCard')
      return true
    },
  },
]

export const CONTEXT_BUDGET_STEP_IDS = Object.freeze(BUDGET_STEPS.map((step) => step.id))

function retrievalOf(state, { mapId, cardId }) {
  const retrieval = {}
  if (state.retrieval.has('selectedCard')) {
    retrieval.selectedCard = { tool: 'mindnprogress_get_card', arguments: { mapId, cardId, fields: [...state.selectedCardFields], includeComments: false } }
  }
  if (state.retrieval.has('knowledgeSource')) {
    retrieval.knowledgeSource = {
      tool: 'mindnprogress_get_card',
      arguments: { mapId, cardId: '<cardId>', fields: ['sharedKnowledge'], includeComments: false },
      note: '설명이나 다른 필드가 필요하면 fields에 추가하고, 댓글이 필요하면 includeComments를 생략하세요. 큰 설명은 단독으로도 한도를 넘을 수 있으니 길이(textIntegrity)를 먼저 확인하세요.',
    }
  }
  if (state.counts['selection.comments']) {
    retrieval.comments = { tool: 'mindnprogress_list_comments', arguments: { mapId, cardId, offset: 0, limit: 50, order: 'desc', includeDetail: false } }
  }
  if (state.retrieval.has('document')) {
    retrieval.document = { tool: 'mindnprogress_get_document', arguments: { mapId, view: 'outline' }, caution: '큰 문서는 이 응답도 도구 출력 한도를 넘을 수 있습니다.' }
  }
  return retrieval
}

function assemble(working, state, context) {
  const omitted = {
    scope: '응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 규칙은 그대로 두고 아래 데이터만 생략했습니다.',
    fields: state.fields,
    ...(Object.keys(state.counts).length > 0 ? { counts: state.counts } : {}),
    ...(Object.keys(state.cardIds).length > 0 ? { cardIds: state.cardIds } : {}),
    ...(state.selectedCardFields.length > 0 ? { selectedCardFields: [...state.selectedCardFields] } : {}),
    ...(state.cardAccessUrlTemplate && working.document?.accessUrl ? { cardAccessUrlTemplate: `${working.document.accessUrl}/{cardId}` } : {}),
    notOmitted: NOT_OMITTED,
    rule: OMITTED_RULE,
    retrieval: retrievalOf(state, context),
  }
  const contextBudget = {
    limitChars: context.limitChars,
    focusedChars: context.focusedChars,
    // 판정 중에는 실제 값과 자릿수가 같거나 큰 한도 값을 넣어, 최종 크기를 기록할 때 예산을 넘지 않게 한다.
    returnedChars: context.limitChars,
    appliedSteps: [...state.applied],
    exceeded: false,
  }
  // 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이도록 detailLevel 바로 뒤에 둔다.
  const result = {}
  for (const [key, value] of Object.entries(working)) {
    result[key] = value
    if (key === 'detailLevel') Object.assign(result, { contextBudget, omitted })
  }
  if (!('contextBudget' in result)) Object.assign(result, { contextBudget, omitted })
  return result
}

/** focused 응답이 limitChars를 넘을 때만 데이터를 단계적으로 줄인 새 응답을 만든다. 넘지 않으면 원래 객체를 그대로 반환한다. */
export function applyContextBudget(response, { mapId, cardId, limitChars = CONTEXT_RESPONSE_BUDGET_CHARS } = {}) {
  const focusedChars = size(response)
  if (focusedChars <= limitChars) return response
  const working = structuredClone(response)
  const state = { fields: {}, counts: {}, cardIds: {}, selectedCardFields: [], applied: [], retrieval: new Set(), cardAccessUrlTemplate: false }
  const context = { mapId, cardId, limitChars, focusedChars }
  const fits = () => size(assemble(working, state, context)) <= limitChars
  for (const step of BUDGET_STEPS) {
    if (step.apply(working, { state, fits, mapId, cardId })) state.applied.push(step.id)
    if (fits()) break
  }
  const result = assemble(working, state, context)
  for (let attempt = 0; attempt < 3; attempt++) {
    const returnedChars = size(result)
    if (result.contextBudget.returnedChars === returnedChars) break
    result.contextBudget.returnedChars = returnedChars
    result.contextBudget.exceeded = returnedChars > limitChars
  }
  return result
}
