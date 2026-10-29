import { createHash } from 'node:crypto'
import { cardTextIntegrity } from './cardTextPatch.mjs'

// get_document view projections. full is the default and must stay byte-identical to the legacy response.
// compact/outline/version are opt-in and must report every omission together with the retrieval path.
export const DOCUMENT_VIEWS = Object.freeze(['full', 'compact', 'outline', 'version'])
export const DOCUMENT_VIEW_CARD_ID_LIMIT = 50

const DOCUMENT_ACCESS_RULE = '웹 링크를 기록할 때 localhost나 127.0.0.1로 재작성하지 말고 accessUrl을 그대로 사용하세요. 이미지 카드의 imageAccess.localPath는 기록용 링크가 아니라 로컬 원본을 직접 열람할 때만 사용하세요.'
const CARD_ACCESS_TEMPLATE_RULE = '카드 accessUrl은 cardAccessUrlTemplate의 {cardId}를 encodeURIComponent로 인코딩한 카드 ID로 바꿔 만드세요.'
const OMITTED_TEXT_RULE = '생략된 원문을 추측하거나 생략된 상태를 근거로 판단·수정하지 말고 retrieval의 도구로 필요한 카드 원문을 먼저 조회하세요.'
const VERSION_SCOPE_RULE = '문서 version은 카드·관계 편집과 AI 대화 연결만 반영합니다. 댓글은 mindnprogress_list_comments로, Ref 카드 원본 변경은 documentEtag 또는 원문 조회로 확인하세요.'

export function documentAccessUrl(publicBaseUrl, mapId) {
  return `${String(publicBaseUrl).replace(/\/+$/, '')}/mindmap/${encodeURIComponent(mapId)}`
}

export function cardAccessUrl(publicBaseUrl, mapId, cardId) {
  return `${documentAccessUrl(publicBaseUrl, mapId)}/${encodeURIComponent(cardId)}`
}

function isKnowledgeEdge(edge) {
  return edge?.data?.relation === 'knowledge'
}

function knowledgePolicyOf(edge) {
  return edge?.data?.knowledgePolicy === 'inspect-if-insufficient' ? 'inspect-if-insufficient' : 'reuse-first'
}

function aiConversationCountOf(data) {
  return Array.isArray(data.aiConversations) ? data.aiConversations.length : data.aiConversationId ? 1 : 0
}

/** Same node projection as update_card full: aiConversations are replaced by their count. */
export function updateCardFullNode(node) {
  const data = { ...(node.data ?? {}) }
  const aiConversationCount = aiConversationCountOf(data)
  delete data.aiConversations
  if (aiConversationCount > 0) data.aiConversationCount = aiConversationCount
  return {
    id: node.id,
    position: node.position,
    data,
  }
}

/** Same edge projection as update_card full: rendering-only keys are removed. */
export function updateCardFullEdge(edge) {
  const relation = isKnowledgeEdge(edge) ? 'knowledge' : 'hierarchy'
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: {
      relation,
      ...(relation === 'knowledge' ? { knowledgePolicy: knowledgePolicyOf(edge) } : {}),
    },
  }
}

/** Legacy get_document response. Do not change its key order or values. */
export function fullDocumentResponse(documentResult, publicBaseUrl, imageAccessOf) {
  return {
    ...documentResult,
    access: {
      publicBaseUrl,
      documentUrl: documentAccessUrl(publicBaseUrl, documentResult.map.id),
      cards: documentResult.map.nodes.map((node) => {
        const imageAccess = imageAccessOf(documentResult.map.id, node)
        return {
          cardId: node.id,
          label: node.data?.label ?? node.id,
          kind: node.data?.kind,
          accessUrl: cardAccessUrl(publicBaseUrl, documentResult.map.id, node.id),
          ...(imageAccess ? { imageAccess } : {}),
        }
      }),
      rule: DOCUMENT_ACCESS_RULE,
    },
  }
}

function shortUser(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return user
  return {
    ...(user.id === undefined ? {} : { id: user.id }),
    ...(user.name === undefined ? {} : { name: user.name }),
  }
}

const shortenedMapUserKeys = ['createdBy', 'updatedBy', 'trashedBy', 'archivedBy']

function documentFields(map) {
  const { nodes: _nodes, edges: _edges, ...fields } = map
  for (const key of shortenedMapUserKeys) if (fields[key]) fields[key] = shortUser(fields[key])
  return fields
}

function shortCardData(data) {
  return data.sharedKnowledgeUpdatedBy ? { ...data, sharedKnowledgeUpdatedBy: shortUser(data.sharedKnowledgeUpdatedBy) } : data
}

function compactNode(node) {
  const projected = updateCardFullNode(node)
  return {
    ...projected,
    data: shortCardData(projected.data),
    textIntegrity: cardTextIntegrity(node.data),
  }
}

function checklistSummary(checklist) {
  if (!Array.isArray(checklist)) return null
  return {
    total: checklist.length,
    done: checklist.filter((item) => item?.done === true).length,
  }
}

function outlineCard(node, parentId, childCount) {
  const { description: _description, sharedKnowledge: _sharedKnowledge, aiConversations: _aiConversations, checklist, ...rest } = node.data ?? {}
  const aiConversationCount = aiConversationCountOf(node.data ?? {})
  const summary = checklistSummary(checklist)
  // waitingItems keep the note text: notes often hold the restrictions that limit resuming a wait.
  return {
    id: node.id,
    parentId,
    childCount,
    data: {
      ...shortCardData(rest),
      ...(aiConversationCount > 0 ? { aiConversationCount } : {}),
      ...(summary ? { checklistSummary: summary } : {}),
    },
    textIntegrity: cardTextIntegrity(node.data),
  }
}

function selectedCard(node, mapId, publicBaseUrl, imageAccessOf) {
  const imageAccess = imageAccessOf(mapId, node)
  const projected = updateCardFullNode(node)
  return {
    id: node.id,
    position: node.position,
    data: projected.data,
    textIntegrity: cardTextIntegrity(node.data),
    accessUrl: cardAccessUrl(publicBaseUrl, mapId, node.id),
    ...(imageAccess ? { imageAccess } : {}),
  }
}

function compactAccess(map, publicBaseUrl, imageAccessOf) {
  const documentUrl = documentAccessUrl(publicBaseUrl, map.id)
  return {
    publicBaseUrl,
    documentUrl,
    cardAccessUrlTemplate: `${documentUrl}/{cardId}`,
    imageCards: map.nodes.flatMap((node) => {
      const imageAccess = imageAccessOf(map.id, node)
      return imageAccess ? [{ cardId: node.id, imageAccess }] : []
    }),
    rule: `${DOCUMENT_ACCESS_RULE} ${CARD_ACCESS_TEMPLATE_RULE}`,
  }
}

function referenceCardIds(map) {
  return map.nodes.filter((node) => typeof node.data?.reference?.mapId === 'string').map((node) => node.id)
}

function documentStats(map) {
  const knowledgeEdgeCount = map.edges.filter(isKnowledgeEdge).length
  return {
    cardCount: map.nodes.length,
    hierarchyEdgeCount: map.edges.length - knowledgeEdgeCount,
    knowledgeEdgeCount,
    referenceCardCount: referenceCardIds(map).length,
  }
}

/** Metadata returned by the document API next to map (group, membership, Ref state, delegation origin). */
function documentMetadata(documentResult, { includeReferenceCommentStats = true } = {}) {
  const { map: _map, ...metadata } = documentResult
  if (!includeReferenceCommentStats) delete metadata.referenceCommentStats
  return metadata
}

/** Sorted unique card ids that change the outline representation. Other views ignore cardIds. */
function representationCardIds(view, cardIds) {
  return view === 'outline' ? [...new Set(cardIds ?? [])].sort() : []
}

/**
 * Response representation format of the projected views. Bump it whenever a view's response shape or
 * wording changes, so an etag issued for an older response body never yields notModified.
 * 3: 현재 그룹 소속도 조건부 응답의 의존성에 포함한다.
 * 4: outline이 응답 예산(OUTLINE_RESPONSE_BUDGET_CHARS)을 넘으면 필드를 단계적으로 생략하고 responseBudget을 붙인다.
 */
export const DOCUMENT_VIEW_FORMAT = 4

/**
 * Content token for re-fetch avoidance. It covers the resolved map (including Ref projections),
 * Ref comment state, the response format and the requested representation (view and outline cardIds),
 * so a matching token means the caller already holds this exact response body.
 */
export function documentEtag(documentResult, { view = 'full', cardIds } = {}) {
  const selectedCardIds = representationCardIds(view, cardIds)
  const digest = createHash('sha256').update(JSON.stringify({
    format: DOCUMENT_VIEW_FORMAT,
    view,
    cardIds: selectedCardIds,
    map: documentResult.map,
    referenceCommentStats: documentResult.referenceCommentStats ?? {},
    unresolvedReferenceNodeIds: documentResult.unresolvedReferenceNodeIds ?? [],
    documentGroups: documentResult.documentGroups ?? [],
    groupProject: documentResult.groupProject ?? null,
  }), 'utf8').digest('hex').slice(0, 32)
  return `v${documentResult.map.version}-${view}-${digest}`
}

/**
 * Decide whether the caller already holds the current body of the requested representation.
 * Only ifNoneMatch can omit the body because the etag is bound to view and cardIds.
 * knownVersion only reports whether the version matches; the server cannot know which view the caller received.
 */
export function documentFreshness(documentResult, { view = 'full', cardIds, knownVersion, ifNoneMatch } = {}) {
  if (knownVersion === undefined && ifNoneMatch === undefined) return null
  const map = documentResult.map
  const etag = documentEtag(documentResult, { view, cardIds })
  const referenceCount = referenceCardIds(map).length
  const versionMatched = knownVersion === undefined ? null : knownVersion === map.version
  const etagMatched = ifNoneMatch === undefined ? null : ifNoneMatch === etag
  let notModified = false
  let reason
  if (versionMatched === false) {
    reason = '전달한 knownVersion이 현재 문서 version과 다릅니다.'
  } else if (etagMatched === false) {
    reason = 'ifNoneMatch가 요청한 view·cardIds의 현재 documentEtag와 다릅니다. 문서가 바뀌었거나 다른 view·cardIds 응답에서 받은 값입니다.'
  } else if (etagMatched === true) {
    notModified = true
    reason = 'ifNoneMatch가 요청한 view·cardIds의 현재 documentEtag와 같습니다.'
  } else {
    reason = 'knownVersion은 version 일치 여부만 확인하며 본문을 생략하지 않습니다. 본문 생략이 필요하면 같은 view·cardIds로 받은 응답의 documentEtag를 ifNoneMatch로 전달하세요.'
    if (referenceCount > 0) reason += ` Ref 카드 ${referenceCount}장의 원본 변경은 문서 version을 올리지 않으므로 version이 같아도 Ref 본문은 바뀌었을 수 있습니다.`
  }
  return {
    notModified,
    currentVersion: map.version,
    documentEtag: etag,
    ...(knownVersion === undefined ? {} : { knownVersion, versionMatched }),
    ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
    reason,
  }
}

function retrievalFor(mapId) {
  return {
    selectedCards: {
      tool: 'mindnprogress_get_document',
      arguments: { mapId, view: 'outline', cardIds: ['<cardId>'] },
      maxCardIds: DOCUMENT_VIEW_CARD_ID_LIMIT,
    },
    singleCard: { tool: 'mindnprogress_get_card', arguments: { mapId, cardId: '<cardId>' } },
    compactDocument: { tool: 'mindnprogress_get_document', arguments: { mapId, view: 'compact' } },
    fullDocument: { tool: 'mindnprogress_get_document', arguments: { mapId, view: 'full' } },
    aiConversations: { tool: 'mindnprogress_list_ai_conversations', arguments: { mapId, cardId: '<cardId>' } },
    users: { tool: 'mindnprogress_list_users', arguments: {} },
    comments: { tool: 'mindnprogress_list_comments', arguments: { mapId, cardId: '<cardId>' } },
  }
}

function notModifiedResponse(documentResult, view, cardIds, freshness) {
  const map = documentResult.map
  const selectedCardIds = representationCardIds(view, cardIds)
  const scopeArguments = selectedCardIds.length > 0 ? { view, cardIds: selectedCardIds } : { view }
  return {
    view,
    notModified: true,
    ...documentMetadata(documentResult, { includeReferenceCommentStats: false }),
    map: {
      id: map.id,
      title: map.title,
      version: map.version,
      updatedAt: map.updatedAt,
      updatedBy: shortUser(map.updatedBy),
    },
    freshness,
    omitted: {
      scope: selectedCardIds.length > 0
        ? `요청한 view(${view})와 cardIds(${selectedCardIds.join(', ')})의 문서 본문 전체`
        : `요청한 view(${view})의 문서 본문 전체`,
      reason: freshness.reason,
      rule: '같은 view·cardIds로 이전에 받은 이 문서의 응답(documentEtag가 같은 응답)을 그대로 사용하세요. 그 응답이 대화 문맥에 남아 있지 않으면 ifNoneMatch 없이 다시 조회하세요. 그 응답 원문을 끝까지 읽었고 원문 그대로 남아 있을 때만 사용할 수 있습니다. 응답이 잘렸거나 일부만 읽었거나, 문맥 요약·압축으로 원문 대신 요약만 남았거나, 원문이 남아 있는지 확신할 수 없으면 ifNoneMatch 없이 다시 조회하세요. 파일로 저장된 응답은 그 파일을 끝까지 읽은 경우에만 보유한 원문으로 봅니다.',
      retrieval: { tool: 'mindnprogress_get_document', arguments: { mapId: map.id, ...scopeArguments } },
    },
    versionScope: VERSION_SCOPE_RULE,
  }
}

function versionResponse(documentResult, freshness) {
  const map = documentResult.map
  const { archiveHistory: _archiveHistory, ...fields } = documentFields(map)
  return {
    view: 'version',
    ...documentMetadata(documentResult, { includeReferenceCommentStats: false }),
    map: fields,
    documentEtag: documentEtag(documentResult, { view: 'version' }),
    stats: documentStats(map),
    ...(freshness ? { freshness } : {}),
    omitted: {
      scope: '카드·관계·접근 URL 전체와 archiveHistory',
      rule: '쓰기 전 baseVersion 확인과 같은 버전 재조회 회피에만 사용하세요. 문서 version 일치는 카드·관계 편집이 없었다는 뜻일 뿐입니다. stats.referenceCardCount가 0보다 크면 version이 같아도 Ref 카드 원본은 바뀌었을 수 있으므로, 이전 응답의 Ref 카드 본문을 다시 쓰기 전에 같은 view·cardIds로 받은 documentEtag를 ifNoneMatch로 확인하거나 mindnprogress_get_card로 다시 확인하세요. 이전 응답이 documentEtag가 없는 full이면 ifNoneMatch로 확인할 수 없으므로 mindnprogress_get_card로 확인하세요. 카드 내용 판단에는 다른 view나 mindnprogress_get_card를 사용하세요.',
      retrieval: retrievalFor(map.id),
    },
    versionScope: VERSION_SCOPE_RULE,
  }
}

function compactResponse(documentResult, publicBaseUrl, imageAccessOf, freshness) {
  const map = documentResult.map
  return {
    view: 'compact',
    ...documentMetadata(documentResult),
    map: {
      ...documentFields(map),
      nodes: map.nodes.map(compactNode),
      edges: map.edges.map(updateCardFullEdge),
    },
    documentEtag: documentEtag(documentResult, { view: 'compact' }),
    ...(freshness ? { freshness } : {}),
    access: compactAccess(map, publicBaseUrl, imageAccessOf),
    omitted: {
      fields: {
        'nodes[].data.aiConversations': 'aiConversationCount만 제공합니다. 대화 상세는 retrieval.aiConversations로 조회하세요.',
        'nodes[].type': '렌더링 전용 값이라 제외했습니다.',
        'edges[].type·markerEnd·reconnectable·style': '렌더링 전용 값이라 제외했습니다. relation과 knowledgePolicy는 edges[].data에 있습니다.',
        'access.cards': 'label·kind는 nodes[].data에 있고 accessUrl은 access.cardAccessUrlTemplate으로 만듭니다. 이미지 카드의 imageAccess는 access.imageCards에 있습니다.',
        'createdBy·updatedBy·sharedKnowledgeUpdatedBy 등 사용자 객체': 'id와 name만 제공합니다. 다른 계정 정보는 retrieval.users로 조회하세요.',
      },
      notOmitted: '카드 원문(description·sharedKnowledge·checklist·waitingItems·requirement 계열 등 aiConversations 이외의 모든 data 필드. aiConversations는 위 fields대로 aiConversationCount만 제공), version, 관계 edge, knowledgePolicy, group·membership, access.rule은 그대로 제공합니다.',
      rule: '렌더링 전용 값이나 계정 상세가 필요할 때만 retrieval의 도구를 사용하세요.',
      retrieval: retrievalFor(map.id),
    },
  }
}

/**
 * outline 응답 예산. get_context 예산과 같은 Claude Code 실측(MnP JSON 48,499자 통과, 56,289자 초과)에 여유를 둔 값이다.
 * 넘을 때만 구조·상태·관계와 selectedCards는 두고 아래 단계를 차례로 적용하며, 들어오면 멈춘다.
 */
export const OUTLINE_RESPONSE_BUDGET_CHARS = 40_000
// 서버가 만든 outline에 MCP가 그룹 메타데이터와 로컬 이미지 경로를 덧붙이는 몫
export const OUTLINE_POSTPROCESS_RESERVE_CHARS = 1_000
const OUTLINE_KEPT_FIELDS = new Set(['label', 'kind', 'status', 'progress', 'isWork', 'blockedBy', 'waitingItems', 'checklistSummary', 'aiConversationCount', 'reference', 'taskUrl', 'assigneeId', 'dueDate'])
const OUTLINE_METADATA_FIELDS = ['sharedKnowledgeUpdatedBy', 'sharedKnowledgeUpdatedAt', 'sharedKnowledgeReview', 'reconstructionSources', 'restructureV2Changes', 'externalLink']
const OUTLINE_MINIMAL_FIELDS = ['label', 'kind', 'status', 'progress', 'isWork', 'blockedBy', 'waitingItemCount']
const responseSize = (value) => JSON.stringify(value).length

/** 조건에 맞는 카드를 measure 값의 직렬화 크기가 큰 순서로 돌려준다. 같은 크기는 문서 순서를 지킨다. */
function cardsBySize(response, predicate, measure) {
  return response.cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => predicate(card))
    .map(({ card, index }) => ({ card, index, size: responseSize(measure(card)) }))
    .sort((a, b) => b.size - a.size || a.index - b.index)
    .map(({ card }) => card)
}

function dropOutlineFields(response, state, limit) {
  let dropped = 0
  for (const card of response.cards) {
    for (const [key, value] of Object.entries(card.data ?? {})) {
      if (OUTLINE_KEPT_FIELDS.has(key) || responseSize(value) <= limit) continue
      delete card.data[key]
      card.omittedFields = [...new Set([...(card.omittedFields ?? []), key])]
      state.fieldNames.add(key)
      dropped++
    }
  }
  return dropped
}

const OUTLINE_BUDGET_STEPS = [
  {
    id: 'largeFields',
    apply(response, state) {
      const dropped = dropOutlineFields(response, state, 2000)
      if (dropped) state.fields['cards[].data(2,000자 초과 필드)'] = '원문 이외의 큰 필드를 생략했습니다. 카드별 이름은 cards[].omittedFields에 있습니다.'
      return dropped > 0
    },
  },
  {
    id: 'integrityLengths',
    apply(response, state) {
      for (const card of response.cards) {
        card.textIntegrity = Object.fromEntries(Object.entries(card.textIntegrity ?? {}).map(([field, value]) => [field, { length: value?.length ?? 0 }]))
      }
      state.fields['cards[].textIntegrity.*.sha256'] = 'SHA-256을 생략하고 길이만 남겼습니다. 해시가 필요하면 retrieval.selectedCards나 retrieval.singleCard로 조회하세요.'
      return response.cards.length > 0
    },
  },
  {
    id: 'metadataFields',
    apply(response, state) {
      let dropped = 0
      for (const card of response.cards) for (const key of OUTLINE_METADATA_FIELDS) if (Object.hasOwn(card.data ?? {}, key)) { delete card.data[key]; dropped++ }
      if (dropped) state.fields[`cards[].data.${OUTLINE_METADATA_FIELDS.join('·')}`] = '공유 지식 갱신·검토 기록, 재구성 출처, 외부 링크 미리보기를 생략했습니다.'
      return dropped > 0
    },
  },
  {
    id: 'mediumFields',
    apply(response, state) {
      const dropped = dropOutlineFields(response, state, 500)
      if (dropped) state.fields['cards[].data(500자 초과 필드)'] = '원문 이외의 500자 초과 필드를 생략했습니다. 카드별 이름은 cards[].omittedFields에 있습니다.'
      return dropped > 0
    },
  },
  // 아래 세 단계는 문서 전체에 한꺼번에 적용하지 않고 큰 카드부터 하나씩 적용하다가 예산에 들면 멈춘다.
  {
    id: 'waitingNotes',
    apply(response, state, fits) {
      let dropped = 0
      for (const card of cardsBySize(response, (card) => (card.data?.waitingItems ?? []).some((item) => item && Object.hasOwn(item, 'note')), (card) => card.data.waitingItems)) {
        if (fits()) break
        for (const item of card.data.waitingItems) if (item && Object.hasOwn(item, 'note')) { delete item.note; dropped++ }
        state.counts['cards[].data.waitingItems[].note'] = dropped
        state.fields['cards[].data.waitingItems[].note'] = '일부 카드의 대기 메모 원문을 생략했습니다(개수는 omitted.counts). 메모에는 재개를 제한하는 조건이 있을 수 있으므로 note가 없는 대기 항목은 대기 재개·완료·위임 판단 전에 retrieval.cardFields로 해당 카드의 waitingItems 원문을 확인하세요.'
      }
      return dropped > 0
    },
  },
  {
    id: 'waitingCounts',
    apply(response, state, fits) {
      let changed = 0
      for (const card of cardsBySize(response, (card) => Array.isArray(card.data?.waitingItems), (card) => card.data.waitingItems)) {
        if (fits()) break
        card.data.waitingItemCount = card.data.waitingItems.length
        delete card.data.waitingItems
        changed++
        state.counts['cards[].data.waitingItemCount'] = changed
        state.fields['cards[].data.waitingItems'] = 'waitingItemCount가 있는 카드는 대기 항목 원문 대신 개수만 줍니다. 대기 판단 전에는 retrieval.cardFields로 해당 카드의 waitingItems를 확인하세요.'
      }
      return changed > 0
    },
  },
  {
    id: 'minimalCards',
    apply(response, state, fits) {
      let changed = 0
      const indexById = new Map(response.cards.map((card, index) => [card.id, index]))
      for (const card of cardsBySize(response, () => true, (card) => card)) {
        if (fits()) break
        changed++
        response.cards[indexById.get(card.id)] = {
          id: card.id,
          parentId: card.parentId,
          childCount: card.childCount,
          data: Object.fromEntries(OUTLINE_MINIMAL_FIELDS.filter((key) => card.data?.[key] !== undefined).map((key) => [key, card.data[key]])),
          minimal: true,
        }
        state.counts['cards[].minimal'] = changed
        state.fields['cards[]'] = `minimal=true인 카드는 id·parentId·childCount와 ${OUTLINE_MINIMAL_FIELDS.join('·')}만 남겼습니다. 다른 필드는 retrieval.selectedCards나 retrieval.cardFields로 조회하세요.`
      }
      return changed > 0
    },
  },
  {
    id: 'knowledgeLinks',
    apply(response, state) {
      if (!response.knowledgeLinks?.length) return false
      state.counts.knowledgeLinks = response.knowledgeLinks.length
      response.knowledgeLinks = []
      state.fields.knowledgeLinks = '지식선 목록을 생략했습니다. 개수는 omitted.counts.knowledgeLinks에 있습니다. 지식선 전역 점검에는 view를 생략한 full을 사용하세요.'
      return true
    },
  },
]

export const OUTLINE_BUDGET_STEP_IDS = Object.freeze(OUTLINE_BUDGET_STEPS.map((step) => step.id))

function withOutlineBudget(response, state, mapId, limitChars, originalChars) {
  const omitted = {
    ...response.omitted,
    fields: { ...response.omitted.fields, ...state.fields },
    ...(Object.keys(state.counts).length > 0 ? { counts: { ...state.counts } } : {}),
    notOmitted: 'responseBudget.appliedSteps로 줄인 필드 외에 version, 상태·진행률, 계층(parentId·childCount), cardIds로 고른 카드의 전문(selectedCards), group·membership, access.rule은 그대로 제공합니다.',
    retrieval: { ...response.omitted.retrieval, cardFields: { tool: 'mindnprogress_get_card', arguments: { mapId, cardId: '<cardId>', fields: ['<field>'], includeComments: false } } },
  }
  // 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이도록 view 바로 뒤에 둔다.
  const responseBudget = { limitChars, originalChars, returnedChars: limitChars, appliedSteps: [...state.applied], exceeded: false }
  const result = {}
  for (const [key, value] of Object.entries(response)) {
    result[key] = key === 'omitted' ? omitted : value
    if (key === 'view') result.responseBudget = responseBudget
  }
  return result
}

/**
 * outline 응답이 limitChars를 넘을 때만 단계적으로 줄인 새 응답을 만든다. 넘지 않으면 원래 객체를 그대로 반환한다.
 * reserveChars는 이후 단계(MCP의 그룹 메타데이터·로컬 이미지 경로)가 덧붙일 여유분이다.
 */
export function applyOutlineBudget(response, { mapId, limitChars = OUTLINE_RESPONSE_BUDGET_CHARS, reserveChars = 0 } = {}) {
  const originalChars = responseSize(response)
  const targetChars = limitChars - reserveChars
  if (originalChars <= targetChars) return response
  const working = structuredClone(response)
  const state = { fields: {}, counts: {}, fieldNames: new Set(), applied: [] }
  const fits = () => responseSize(withOutlineBudget(working, state, mapId, limitChars, originalChars)) <= targetChars
  // cardIds로 고른 카드 전문 등 줄이지 않는 부분만으로 예산을 넘으면, 개요를 줄여도 한도를 넘으므로 정보만 잃는다.
  const floor = responseSize(withOutlineBudget({ ...working, cards: [], knowledgeLinks: [] }, state, mapId, limitChars, originalChars))
  if (floor > targetChars) {
    state.fields.selectedCards = 'cardIds로 고른 카드 전문만으로 응답 예산을 넘어 개요를 줄이지 않았습니다. cardIds를 줄이거나 retrieval.cardFields로 필요한 필드만 조회하세요.'
  } else {
    for (const step of OUTLINE_BUDGET_STEPS) {
      // 단계 안에서 크기를 잴 때도 appliedSteps에 이 단계가 들어 있어야 최종 크기와 같다. 줄인 것이 없으면 뺀다.
      state.applied.push(step.id)
      if (!step.apply(working, state, fits)) state.applied.pop()
      if (fits()) break
    }
  }
  return finalizeResponseBudget(withOutlineBudget(working, state, mapId, limitChars, originalChars))
}

/** 예산을 적용한 응답의 returnedChars·exceeded를 지금 크기로 맞춘다. 이후 단계에서 응답이 커진 경우에도 다시 호출한다. */
export function finalizeResponseBudget(response) {
  const budget = response?.responseBudget
  if (!budget) return response
  for (let attempt = 0; attempt < 3; attempt++) {
    const returnedChars = responseSize(response)
    if (budget.returnedChars === returnedChars) break
    budget.returnedChars = returnedChars
    budget.exceeded = returnedChars > budget.limitChars
  }
  return response
}

function outlineResponse(documentResult, publicBaseUrl, imageAccessOf, cardIds, freshness) {
  const map = documentResult.map
  const hierarchyEdges = map.edges.filter((edge) => !isKnowledgeEdge(edge))
  const parentOf = new Map()
  const childCount = new Map()
  for (const edge of hierarchyEdges) {
    if (!parentOf.has(edge.target)) parentOf.set(edge.target, edge.source)
    childCount.set(edge.source, (childCount.get(edge.source) ?? 0) + 1)
  }
  const selectedIds = [...new Set(cardIds ?? [])]
  const nodesById = new Map(map.nodes.map((node) => [node.id, node]))
  const selected = new Set(selectedIds)
  const omittedCardIds = map.nodes.filter((node) => !selected.has(node.id)).map((node) => node.id)
  return applyOutlineBudget({
    view: 'outline',
    ...documentMetadata(documentResult),
    map: { ...documentFields(map), accessUrl: documentAccessUrl(publicBaseUrl, map.id) },
    documentEtag: documentEtag(documentResult, { view: 'outline', cardIds: selectedIds }),
    ...(freshness ? { freshness } : {}),
    stats: { ...documentStats(map), selectedCardCount: selectedIds.length },
    cards: map.nodes.map((node) => outlineCard(node, parentOf.get(node.id) ?? null, childCount.get(node.id) ?? 0)),
    knowledgeLinks: map.edges.filter(isKnowledgeEdge).map((edge) => ({
      sourceId: edge.source,
      targetId: edge.target,
      policy: knowledgePolicyOf(edge),
    })),
    selectedCards: selectedIds.map((id) => selectedCard(nodesById.get(id), map.id, publicBaseUrl, imageAccessOf)),
    access: compactAccess(map, publicBaseUrl, imageAccessOf),
    omitted: {
      cardIds: omittedCardIds,
      fields: {
        'cards[].data.description': '원문을 생략했습니다. 길이와 SHA-256은 cards[].textIntegrity.description에 있습니다.',
        'cards[].data.sharedKnowledge': '원문을 생략했습니다. 길이와 SHA-256은 cards[].textIntegrity.sharedKnowledge에 있습니다.',
        'cards[].data.checklist': '항목 원문을 생략했습니다. 개수와 완료 수는 cards[].data.checklistSummary에 있습니다. 미완료 항목에는 승인·검증 조건이 있을 수 있으므로 완료·검수·위임 판단 전에는 retrieval.selectedCards 또는 retrieval.singleCard로 항목 원문을 확인하세요.',
        'cards[].data.aiConversations': 'aiConversationCount만 제공합니다.',
        'cards[].position·type, edges[]의 id와 렌더링 키': '배치·렌더링 전용 값이라 제외했습니다. 계층은 cards[].parentId, 지식선은 knowledgeLinks의 sourceId·targetId·policy에 있습니다.',
        '사용자 객체': 'id와 name만 제공합니다.',
      },
      notOmitted: 'version, 상태·진행률, waitingItems 항목 전체(note 원문 포함), blockedBy, requirement 계열 등 원문 이외의 카드 data 필드, 계층·지식선, knowledgePolicy, group·membership, access.rule은 그대로 제공합니다. selectedCards에는 cardIds로 고른 카드의 전문이 있습니다.',
      rule: OMITTED_TEXT_RULE,
      retrieval: retrievalFor(map.id),
    },
  }, { mapId: map.id, reserveChars: OUTLINE_POSTPROCESS_RESERVE_CHARS })
}

function assertCardIdsExist(map, cardIds) {
  const nodeIds = new Set(map.nodes.map((node) => node.id))
  const missing = [...new Set(cardIds ?? [])].filter((id) => !nodeIds.has(id))
  if (missing.length === 0) return
  const error = new Error(`cardIds에 문서에 없는 카드 ID가 있습니다: ${missing.join(', ')}. 카드 ID를 view='outline' 응답의 cards[].id에서 다시 확인하세요.`)
  error.reasonCode = 'DOCUMENT_CARD_NOT_FOUND'
  error.details = { mapId: map.id, missingCardIds: missing }
  throw error
}

/**
 * Build the get_document response for the requested view.
 * imageAccessOf(mapId, node) returns the local image access object or null.
 */
export function buildDocumentView(documentResult, {
  view = 'full',
  cardIds,
  knownVersion,
  ifNoneMatch,
  publicBaseUrl,
  imageAccessOf,
}) {
  if (!DOCUMENT_VIEWS.includes(view)) throw new Error(`지원하지 않는 view입니다: ${view}`)
  if (cardIds !== undefined && view !== 'outline') {
    const error = new Error("cardIds는 view='outline'에서만 사용할 수 있습니다. full과 compact는 이미 모든 카드 원문을 반환합니다.")
    error.reasonCode = 'DOCUMENT_VIEW_ARGUMENT_INVALID'
    throw error
  }
  if (view === 'outline') assertCardIdsExist(documentResult.map, cardIds)
  const freshness = documentFreshness(documentResult, { view, cardIds, knownVersion, ifNoneMatch })
  if (freshness?.notModified) return notModifiedResponse(documentResult, view, cardIds, freshness)
  if (view === 'version') return versionResponse(documentResult, freshness)
  if (view === 'compact') return compactResponse(documentResult, publicBaseUrl, imageAccessOf, freshness)
  if (view === 'outline') return outlineResponse(documentResult, publicBaseUrl, imageAccessOf, cardIds, freshness)
  return fullDocumentResponse(documentResult, publicBaseUrl, imageAccessOf)
}
