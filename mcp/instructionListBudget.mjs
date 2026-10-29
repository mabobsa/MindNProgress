// list_group_document_instructions 응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 정리된 이력만 줄인다.
// 전달 대기·응답 대기 지시(queued·delivered)는 그대로 둔다. 대상 문서별 최신 지시는 문서의 현재 지시이므로 마지막까지 남긴다.
// 정리된 이력(replied·failed·expired)은 오래된 지시의 원문 → 요약 → 최신 지시의 원문 → 요약 → 오래된 지시 개수화 → 최신 지시 개수화 순으로 줄이고,
// 예산 안에 들어오면 멈춘다. 예산 안의 응답은 그대로 반환한다. 예산 값은 get_context·outline·list_ai_delegations와 같다.

export const INSTRUCTION_LIST_RESPONSE_BUDGET_CHARS = 40_000
const PENDING_STATES = new Set(['queued', 'delivered'])
const CONTENT_KEYS = ['instruction', 'approvalEvidence', 'response']
const SUMMARY_KEYS = new Set(['id', 'state', 'groupId', 'groupProjectVersion', 'targetMapId', 'targetCardId', 'targetCardLabel', 'instructionType', 'approvalScope',
  'createdAt', 'updatedAt', 'deliveredAt', 'repliedAt', 'reasonCode', 'instructionHash', 'approvalEvidenceHash', 'responseHash', 'contentOmitted'])
const size = (value) => JSON.stringify(value).length
const SUMMARY_NOTE = 'summary=true인 지시는 ID·상태·대상·유형·승인 범위·시각·사유 코드·해시만 남긴 요약입니다. 미리보기·판단 사유·회신 대상·응답 기록은 retrieval.instruction으로 조회하세요.'

/** 상위 AI가 전달·응답을 기다리는 지시인지 판정한다. 이런 지시는 줄이지 않는다. */
export function instructionNeedsAttention(item) {
  return PENDING_STATES.has(String(item?.state ?? ''))
}

function dropContent(items, state) {
  let changed = 0
  for (const item of items) {
    if (!CONTENT_KEYS.some((key) => Object.hasOwn(item, key))) continue
    for (const key of CONTENT_KEYS) delete item[key]
    item.contentOmitted = true
    state.contentOmittedIds.push(item.id)
    changed++
  }
  return changed
}

function summarize(items) {
  let changed = 0
  for (const item of items) {
    if (item.summary) continue
    for (const key of Object.keys(item)) if (!SUMMARY_KEYS.has(key)) delete item[key]
    item.summary = true
    changed++
  }
  return changed
}

// 목록은 최신순이므로 뒤에서부터(오래된 것부터) 뺀다. 개수와 안내를 먼저 기록한 뒤 크기를 다시 재야 최종 응답이 예산을 넘지 않는다.
function removeOldest(response, removable, fits, state) {
  let removed = 0
  for (let index = response.instructions.length - 1; index >= 0 && !fits(); index--) {
    if (!removable(response.instructions[index])) continue
    const [item] = response.instructions.splice(index, 1)
    state.removedByTarget[item.targetMapId] = (state.removedByTarget[item.targetMapId] ?? 0) + 1
    state.counts.removedSettledInstructions = (state.counts.removedSettledInstructions ?? 0) + 1
    state.fields.instructions = '정리된 지시는 오래된 것부터 목록에서 빼고 대상 문서별 개수만 omitted.removedByTarget에 남겼습니다. 필요하면 retrieval.targetDocument로 문서별로 조회하세요.'
    removed++
  }
  return removed > 0
}

const INSTRUCTION_LIST_STEPS = [
  {
    id: 'olderSettledContent',
    apply(groups, state) {
      const changed = dropContent(groups.older, state)
      if (changed) state.fields['instructions[].instruction·approvalEvidence·response(오래된 지시)'] = '대상 문서별 최신이 아닌 지시의 원문을 생략했습니다. 해시는 남겼고 contentOmitted=true로 표시했습니다.'
      return changed > 0
    },
  },
  {
    id: 'olderSettledSummaries',
    apply(groups, state) {
      const changed = summarize(groups.older)
      if (changed) state.fields['instructions[](summary=true)'] = SUMMARY_NOTE
      return changed > 0
    },
  },
  {
    id: 'latestSettledContent',
    apply(groups, state) {
      const changed = dropContent(groups.latest, state)
      if (changed) state.fields['instructions[].instruction·approvalEvidence·response(최신 지시)'] = '대상 문서별 최신 지시의 원문도 생략했습니다. 검토에 필요하면 retrieval.instruction으로 읽으세요.'
      return changed > 0
    },
  },
  {
    id: 'latestSettledSummaries',
    apply(groups, state) {
      const changed = summarize(groups.latest)
      if (changed) state.fields['instructions[](summary=true)'] = SUMMARY_NOTE
      return changed > 0
    },
  },
  {
    id: 'olderSettledRemoved',
    apply(groups, state, fits, response) {
      return removeOldest(response, (item) => groups.older.includes(item), fits, state)
    },
  },
  {
    id: 'latestSettledRemoved',
    apply(groups, state, fits, response) {
      return removeOldest(response, (item) => groups.latest.includes(item), fits, state)
    },
  },
]

export const INSTRUCTION_LIST_BUDGET_STEP_IDS = Object.freeze(INSTRUCTION_LIST_STEPS.map((step) => step.id))

function assemble(working, state, context) {
  const omitted = {
    scope: '응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 전달·응답 대기 지시(queued·delivered)는 그대로 두고, 정리된 이력(replied·failed·expired)만 오래된 지시부터 줄였습니다. 대상 문서별 최신 지시는 마지막까지 남겼습니다.',
    fields: state.fields,
    ...(Object.keys(state.counts).length > 0 ? { counts: state.counts } : {}),
    ...(state.contentOmittedIds.length > 0 ? { contentOmittedInstructionIds: [...state.contentOmittedIds] } : {}),
    ...(Object.keys(state.removedByTarget).length > 0 ? { removedByTarget: state.removedByTarget } : {}),
    rule: '생략된 지시·응답 원문을 추측하지 말고, 검토·회신 판단에 필요하면 retrieval로 해당 지시를 먼저 조회하세요.',
    retrieval: {
      instruction: { tool: 'mindnprogress_list_group_document_instructions', arguments: { mapId: context.mapId, instructionId: '<instructionId>', includeContent: true } },
      targetDocument: { tool: 'mindnprogress_list_group_document_instructions', arguments: { mapId: context.mapId, targetMapId: '<targetMapId>', ...(context.includeContent ? { includeContent: true } : {}) } },
    },
  }
  const responseBudget = { limitChars: context.limitChars, originalChars: context.originalChars, returnedChars: context.limitChars,
    appliedSteps: [...state.applied], exceeded: false }
  // 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이도록 parentMapId 바로 뒤에 둔다.
  const result = {}
  for (const [key, value] of Object.entries(working)) {
    result[key] = value
    if (key === 'parentMapId') Object.assign(result, { responseBudget, omitted })
  }
  if (!('responseBudget' in result)) Object.assign(result, { responseBudget, omitted })
  return result
}

/** 지시 목록이 limitChars를 넘을 때만 정리된 이력을 단계적으로 줄인 새 응답을 만든다. 넘지 않으면 원래 객체를 그대로 반환한다. */
export function applyInstructionListBudget(response, { mapId, includeContent = false, limitChars = INSTRUCTION_LIST_RESPONSE_BUDGET_CHARS } = {}) {
  if (!Array.isArray(response?.instructions)) return response
  const originalChars = size(response)
  if (originalChars <= limitChars) return response
  const working = structuredClone(response)
  const state = { fields: {}, counts: {}, contentOmittedIds: [], removedByTarget: {}, applied: [] }
  const context = { mapId: mapId ?? working.parentMapId, includeContent, limitChars, originalChars }
  // 응답은 최신순이므로 대상 문서별로 처음 나오는 정리된 지시가 그 문서의 최신 지시다.
  const seenTargets = new Set()
  const groups = { older: [], latest: [] }
  for (const item of working.instructions) {
    if (instructionNeedsAttention(item)) continue
    if (seenTargets.has(item.targetMapId)) groups.older.push(item)
    else { seenTargets.add(item.targetMapId); groups.latest.push(item) }
  }
  const fits = () => size(assemble(working, state, context)) <= limitChars
  for (const step of INSTRUCTION_LIST_STEPS) {
    // 단계 안에서 크기를 잴 때도 appliedSteps에 이 단계가 들어 있어야 최종 크기와 같다. 줄인 것이 없으면 뺀다.
    state.applied.push(step.id)
    if (!step.apply(groups, state, fits, working)) state.applied.pop()
    if (fits()) break
  }
  const result = assemble(working, state, context)
  for (let attempt = 0; attempt < 3; attempt++) {
    const returnedChars = size(result)
    if (result.responseBudget.returnedChars === returnedChars) break
    result.responseBudget.returnedChars = returnedChars
    result.responseBudget.exceeded = returnedChars > limitChars
  }
  return result
}
