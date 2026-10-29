import { cardTextIntegrity } from '../../mcp/cardTextPatch.mjs'

// 그룹 문맥 요약은 AI 조회 전용이다. 화면은 기존 전체 응답을 그대로 사용한다.
// 원문은 길이·SHA-256·건수·미리보기로 바꾸되 생략한 항목과 회수 경로를 detail에 남겨 조용히 누락하지 않는다.
// project와 guide는 판단 기준이므로 전문을 유지한다.
export const GROUP_CONTEXT_SUMMARY_LIMITS = Object.freeze({ documentInstructions: 20, delegations: 20, waitingCardsPerDocument: 20 })

const pendingInstructionStates = new Set(['queued', 'delivered'])
const instructionFields = ['id', 'targetMapId', 'state', 'approvalScope', 'instructionType', 'groupProjectVersion', 'createdAt', 'repliedAt']
const delegationFields = ['id', 'state', 'mapId', 'parentMapId', 'targetCardId', 'coordinationOnly', 'childStatus', 'createdAt', 'completedAt']

const pick = (item, keys) => Object.fromEntries(keys.filter((key) => item[key] !== undefined && item[key] !== null).map((key) => [key, item[key]]))
const countBy = (items, key) => {
  const counts = {}
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1
  return counts
}

export function groupContextRole(context, mapId) {
  if (mapId && mapId === context.project.coordinatorMapId) return 'coordinator'
  return mapId && context.group.mapIds.includes(mapId) ? 'document' : 'group'
}

function documentSummary(document, coordinatorMapId) {
  const data = document.root?.data ?? {}
  const cards = new Map()
  for (const detail of document.waitingDetails ?? []) {
    const card = cards.get(detail.cardId) ?? { cardId: detail.cardId, cardTitle: detail.cardTitle, cardStatus: detail.cardStatus, isRoot: detail.isRoot, labels: [] }
    card.labels.push(detail.item.label)
    cards.set(detail.cardId, card)
  }
  const reviews = (document.waitingDetails ?? []).map((detail) => detail.review)
  // 루트 대기는 문서 전체를 막을 수 있으므로 상한에 걸리지 않게 앞에 둔다.
  const waitingCards = [...cards.values()].sort((a, b) => Number(b.isRoot) - Number(a.isRoot))
  const omittedCards = waitingCards.slice(GROUP_CONTEXT_SUMMARY_LIMITS.waitingCardsPerDocument)
  return {
    id: document.id, title: document.title, version: document.version, coordinator: document.id === coordinatorMapId,
    // get_document outline처럼 긴 본문은 data에서 빼고 textIntegrity(길이·SHA-256)만 둔다. get_card 응답과 그대로 대조된다.
    root: document.root ? {
      id: document.root.id,
      data: { label: data.label, status: data.status, progress: data.progress, aiConversationCount: data.aiConversations?.length ?? (data.aiConversationId ? 1 : 0) },
      textIntegrity: cardTextIntegrity(data),
    } : null,
    runtime: document.runtime, work: document.work,
    waiting: {
      items: reviews.length, reviewed: reviews.filter(Boolean).length, invalidReviews: reviews.filter((review) => review && !review.valid).length,
      cards: waitingCards.slice(0, GROUP_CONTEXT_SUMMARY_LIMITS.waitingCardsPerDocument),
      // 상한 밖 카드도 get_card로 바로 읽을 수 있게 ID를 남긴다. outline은 큰 문서에서 도구 출력 한도를 넘는다.
      omittedCards: omittedCards.length, omittedCardIds: omittedCards.map((card) => card.cardId),
    },
  }
}

// 현재 소속 문서별 최신 지시와 전달·응답 대기 지시는 상한과 관계없이 남긴다. 총괄이 문서별 현재 지시를 놓치지 않게 한다.
function selectInstructions(instructions, memberIds) {
  const key = new Set()
  const targets = new Set()
  for (const item of instructions) {
    if ((memberIds.includes(item.targetMapId) && !targets.has(item.targetMapId)) || pendingInstructionStates.has(item.state)) key.add(item.id)
    targets.add(item.targetMapId)
  }
  const shown = instructions.filter((item, index) => key.has(item.id) || index < GROUP_CONTEXT_SUMMARY_LIMITS.documentInstructions)
  return { shown, key }
}

function instructionSummary(item, { key, memberIds, coordinatorMapId, withReplyTarget }) {
  return {
    ...pick(item, instructionFields),
    // 상태와 같은 기본 사유는 반복하지 않고 실패·만료 등 구분이 필요한 사유만 남긴다.
    ...(item.reasonCode && item.reasonCode !== `GROUP_DOCUMENT_INSTRUCTION_${String(item.state).toUpperCase()}` ? { reasonCode: item.reasonCode } : {}),
    // 총괄 문서가 바뀐 뒤의 과거 지시는 발신 문서로 조회해야 하므로 다를 때만 남긴다.
    ...(item.parentMapId !== coordinatorMapId ? { parentMapId: item.parentMapId } : {}),
    ...(memberIds.includes(item.targetMapId) ? {} : { outsideGroup: true }),
    ...(key.has(item.id) ? { instructionPreview: item.instructionPreview ?? '' } : {}),
    // 문서 담당은 최종 보고 직전에 회신 대상을 다시 확인한다. 전달 시점의 유효 대상만 남긴다.
    ...(withReplyTarget && item.replyTarget ? { replyTarget: pick(item.replyTarget, ['mode', 'effectiveConversationId']) } : {}),
  }
}

export function summarizeGroupContext(context, { mapId = '' } = {}) {
  const role = groupContextRole(context, mapId)
  const ownOnly = role === 'document'
  const memberIds = context.group.mapIds
  const coordinatorMapId = context.project.coordinatorMapId
  const allInstructions = context.documentInstructions ?? []
  const instructions = ownOnly ? allInstructions.filter((item) => item.targetMapId === mapId) : allInstructions
  const { shown: shownInstructions, key } = selectInstructions(instructions, memberIds)
  const shownInstructionIds = new Set(shownInstructions.map((item) => item.id))
  const allDelegations = context.delegations ?? []
  const delegations = ownOnly ? allDelegations.filter((item) => item.mapId === mapId || item.parentMapId === mapId) : allDelegations
  const shownDelegations = delegations.slice(0, GROUP_CONTEXT_SUMMARY_LIMITS.delegations)
  const coordinator = context.coordinator
  return {
    view: 'summary', role, mapId: role === 'group' ? null : mapId,
    // 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 생략 사실과 회수 경로가 보이도록 앞에 둔다.
    detail: {
      scope: 'detailLevel=summary 응답입니다. project와 guide는 전문이고, 문서 루트·대기·지시·위임 원문은 길이·SHA-256·건수·미리보기로 대신했습니다. 요약·미리보기는 실행 승인이나 완료 판단의 근거가 아닙니다. 실행 범위·문서 경계·완료를 판단하거나 문서별 지시 전문을 작성·검토하기 전에는 아래 경로로 대상 문서의 루트 원문과 관련 지시 전문을 읽으세요.',
      role: role === 'document' ? '문서 담당 관점입니다. documentInstructions와 delegations는 이 문서가 대상인 기록만 담았고, 다른 문서 기록 수는 documentInstructionCounts.otherDocuments와 delegationCounts.otherDocuments에 있습니다. 그룹 전체 기록이 필요하면 mapId=project.coordinatorMapId로 다시 조회하세요. documentInstructions[].replyTarget은 지시 전달 시점의 유효 회신 대상이며, 이후 사용자가 같은 instructionId에 다른 대상을 지정했다면 그 대상이 우선합니다.'
        : role === 'coordinator' ? '그룹 총괄 관점입니다. 그룹의 문서 지시와 위임 기록을 최신순으로 담았습니다.'
          : 'mapId로 역할을 확인하지 못해 그룹의 문서 지시와 위임 기록을 최신순으로 담았습니다.',
      rootText: 'documents[].root.data에는 description·sharedKnowledge 원문이 없고, root.textIntegrity에 각 원문의 length·sha256이 있습니다. 원문은 mindnprogress_get_card(mapId=documents[].id, cardId=documents[].root.id)로 읽고 textIntegrity가 같은지 확인하세요. 이전에 읽은 원문과 sha256이 다르면 담당 범위가 바뀌었을 수 있으니 다시 읽으세요.',
      waiting: `documents[].waiting은 카드별 대기 제목과 건수만 담았습니다. 카드는 문서당 ${GROUP_CONTEXT_SUMMARY_LIMITS.waitingCardsPerDocument}장까지 cards에 두고 나머지 카드 ID는 omittedCardIds에 있습니다. 사유 note·재개 조건 원문은 mindnprogress_get_card(mapId=documents[].id, cardId)로 카드별로 읽으세요. mindnprogress_get_document(view=outline)는 문서의 대기 원문을 한 번에 주지만 큰 문서에서는 도구 출력 한도를 넘을 수 있습니다. guide.waiting의 waitingDetails는 detailLevel=full 응답의 필드입니다. 분류 기록 원본은 project.waitingReviews에 있고, 항목별 유효 여부(valid)는 full의 waitingDetails[].review에만 있습니다.`,
      documentInstructions: `지시·승인 근거·응답 전문은 mindnprogress_list_group_document_instructions에 mapId(항목의 parentMapId, 없으면 project.coordinatorMapId)·instructionId·includeContent=true를 지정해 한 건씩 읽으세요. 현재 소속 문서별 최신 지시와 queued·delivered 지시는 항상 포함하고 instructionPreview를 붙였으며, 그 밖에는 최신 ${GROUP_CONTEXT_SUMMARY_LIMITS.documentInstructions}건까지 담았습니다. 생략한 지시 수는 documentInstructionCounts.omittedByTarget에 대상 문서별로 있고, 같은 도구의 targetMapId 필터로 찾을 수 있습니다. 지시가 많은 문서는 이 목록도 도구 출력 한도를 넘을 수 있습니다.`,
      delegations: `과거 그룹 위임의 지시 미리보기와 결과 원문은 mindnprogress_list_ai_delegations(mapId=delegations[].parentMapId, targetCardId, includeResult=true)로 읽으세요. 위임은 최신 ${GROUP_CONTEXT_SUMMARY_LIMITS.delegations}건까지 담았고 나머지 수는 delegationCounts.omitted에 있습니다.`,
      full: '모든 원문을 한 번에 받으려면 detailLevel=full로 다시 조회하세요. 응답이 매우 커서 AI 클라이언트의 도구 출력 한도를 넘을 수 있습니다.',
    },
    group: context.group, project: context.project,
    coordinator: coordinator ? { id: coordinator.id, title: coordinator.title, version: coordinator.version, rootId: coordinator.root?.id ?? null } : null,
    documents: context.documents.map((document) => documentSummary(document, coordinatorMapId)),
    documentInstructions: shownInstructions.map((item) => instructionSummary(item, { key, memberIds, coordinatorMapId, withReplyTarget: ownOnly })),
    documentInstructionCounts: {
      total: instructions.length, shown: shownInstructions.length, omitted: instructions.length - shownInstructions.length,
      omittedByTarget: countBy(instructions.filter((item) => !shownInstructionIds.has(item.id)), 'targetMapId'),
      byState: countBy(instructions, 'state'), otherDocuments: allInstructions.length - instructions.length,
    },
    delegations: shownDelegations.map((item) => pick(item, delegationFields)),
    delegationCounts: { total: delegations.length, shown: shownDelegations.length, omitted: delegations.length - shownDelegations.length, otherDocuments: allDelegations.length - delegations.length },
    waitingReviewSupported: context.waitingReviewSupported, sourcesSupported: context.sourcesSupported,
    guide: context.guide,
  }
}
