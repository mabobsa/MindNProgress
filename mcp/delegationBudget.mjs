// list_ai_delegations 응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 정리된 이력만 줄인다.
// 판단이 필요한 위임(미종료·실패·복구 가능·종료 처리 가능·보고 대기)과 미해결 접수 실패(재접수 미확인·실행 불확실·재접수 없음)는 그대로 둔다.
// 정리된 이력은 카드별 최신이 아닌 위임 결과 원문 → 정리된 접수 실패 요약 → 위임 요약 → 정리된 접수 실패 개수화 → 최신 위임 결과 → 최신 위임 요약 →
// 오래된 위임 개수화 순으로 줄이고, 예산 안에 들어오면 멈춘다. 예산 안의 응답은 그대로 반환한다. 예산 값은 get_context·outline과 같다.

export const DELEGATION_RESPONSE_BUDGET_CHARS = 40_000
const SETTLED_STATES = new Set(['completed', 'superseded', 'closed'])
const SETTLED_REQUEST_FAILURE_STATES = new Set(['confirmed', 'closed'])
const RESULT_KEYS = ['result', 'resultFull', 'resultFullHash', 'resultFullTruncated']
const SUMMARY_KEYS = new Set(['id', 'state', 'displayState', 'mapId', 'parentMapId', 'parentCardId', 'targetCardId', 'parentConversationId',
  'targetConversationId', 'groupId', 'createdAt', 'updatedAt', 'completedAt', 'workCompleted', 'reportStatus', 'resultAvailability',
  'resultHash', 'resultHashBasis', 'resultTurnId', 'resultOriginalLength', 'resultTruncated', 'resultOmitted', 'taskCompletion'])
const REQUEST_FAILURE_SUMMARY_KEYS = new Set(['id', 'kind', 'state', 'mapId', 'parentMapId', 'parentCardId', 'targetCardId', 'parentConversationId',
  'reasonCode', 'createdAt', 'updatedAt', 'resolvedByDelegationId'])
const size = (value) => JSON.stringify(value).length
const SUMMARY_NOTE = 'summary=true인 정리된 이력은 ID·상태·카드·대화·시각·보고 상태·결과 해시만 남긴 요약입니다. 작업공간 결과·lease·판정 사유·지시 미리보기·보고 수신 기록은 retrieval.delegation으로 조회하세요.'
const REQUEST_FAILURE_SUMMARY_NOTE = 'summary=true인 접수 실패는 재접수 확인(confirmed)·사용자 종료(closed)로 정리된 기록입니다. ID·카드·사유 코드·시각·재접수 위임 ID와 retryVerification.state·method만 남겼습니다. 메시지·요청 요약·처리 기록은 retrieval.targetCard로 조회하세요.'

/** 상위 AI가 상태·복구·보고를 판단해야 하는 위임인지 판정한다. 이런 위임은 줄이지 않는다. */
export function delegationNeedsAttention(item) {
  return !SETTLED_STATES.has(String(item?.state ?? ''))
    || (typeof item?.displayState === 'string' && item.displayState !== item.state)
    || item?.recovery?.recoveryAvailable === true
    || item?.closure?.closeAvailable === true
    || item?.reportPending === true
}

/** 상위 AI가 재접수·실행 여부를 확인해야 하는 접수 실패인지 판정한다. 이런 기록은 줄이지 않는다. */
export function requestFailureNeedsAttention(item) {
  return !SETTLED_REQUEST_FAILURE_STATES.has(String(item?.retryVerification?.state ?? '')) || Boolean(item?.retryReference)
}

const targetKey = (item) => `${item.mapId ?? ''}/${item.targetCardId ?? ''}`
const increment = (record, key) => { record[key] = (record[key] ?? 0) + 1 }

// 목록은 최신순이므로 뒤에서부터(오래된 것부터) 뺀다. 개수와 안내를 먼저 기록한 뒤 크기를 다시 재야 최종 응답이 예산을 넘지 않는다.
function removeOldest(list, removable, fits, record) {
  let removed = 0
  for (let index = (list?.length ?? 0) - 1; index >= 0 && !fits(); index--) {
    if (!removable(list[index])) continue
    record(list.splice(index, 1)[0])
    removed++
  }
  return removed > 0
}

function dropResults(items, state) {
  let changed = 0
  for (const item of items) {
    if (!RESULT_KEYS.some((key) => Object.hasOwn(item, key))) continue
    for (const key of RESULT_KEYS) delete item[key]
    item.resultOmitted = true
    state.resultOmittedIds.push(item.id)
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

function summarizeRequestFailures(items) {
  let changed = 0
  for (const item of items) {
    if (item.summary) continue
    const verification = item.retryVerification
    for (const key of Object.keys(item)) if (!REQUEST_FAILURE_SUMMARY_KEYS.has(key)) delete item[key]
    if (verification) item.retryVerification = { state: verification.state, method: verification.method }
    item.summary = true
    changed++
  }
  return changed
}

const DELEGATION_BUDGET_STEPS = [
  {
    id: 'olderSettledResults',
    apply(groups, state) {
      const changed = dropResults(groups.olderSettled, state)
      if (changed) state.fields['delegations[].result(카드별 최신이 아닌 정리된 이력)'] = '결과 원문을 생략했습니다. resultHash와 길이는 남겼고 resultOmitted=true로 표시했습니다.'
      return changed > 0
    },
  },
  {
    id: 'settledRequestFailureSummaries',
    apply(groups, state) {
      const changed = summarizeRequestFailures(groups.settledRequestFailures)
      if (changed) state.fields['requestFailures[](summary=true)'] = REQUEST_FAILURE_SUMMARY_NOTE
      return changed > 0
    },
  },
  {
    id: 'olderSettledSummaries',
    apply(groups, state) {
      const changed = summarize(groups.olderSettled)
      if (changed) state.fields['delegations[](summary=true)'] = SUMMARY_NOTE
      return changed > 0
    },
  },
  {
    id: 'settledRequestFailuresRemoved',
    apply(groups, state, fits, response) {
      return removeOldest(response.requestFailures, (item) => !requestFailureNeedsAttention(item), fits, (item) => {
        increment(state.removedRequestFailuresByTarget, targetKey(item))
        increment(state.counts, 'removedSettledRequestFailures')
        state.fields['requestFailures(오래된 정리된 접수 실패)'] = '오래된 정리된 접수 실패는 목록에서 빼고 문서/카드별 개수만 omitted.removedRequestFailuresByTarget에 남겼습니다. 필요하면 retrieval.targetCard로 카드별로 조회하세요.'
      })
    },
  },
  {
    id: 'latestSettledResults',
    apply(groups, state) {
      const changed = dropResults(groups.latestSettled, state)
      if (changed) state.fields['delegations[].result(카드별 최신 정리된 이력)'] = '카드별 최신 이력의 결과 원문도 생략했습니다. 검토에 필요하면 retrieval.delegation으로 읽으세요.'
      return changed > 0
    },
  },
  {
    id: 'latestSettledSummaries',
    apply(groups, state) {
      const changed = summarize(groups.latestSettled)
      if (changed) state.fields['delegations[](summary=true)'] = SUMMARY_NOTE
      return changed > 0
    },
  },
  {
    id: 'oldSettledRemoved',
    apply(groups, state, fits, response) {
      return removeOldest(response.delegations, (item) => !delegationNeedsAttention(item), fits, (item) => {
        increment(state.removedByTarget, targetKey(item))
        increment(state.counts, 'removedSettledDelegations')
        state.fields['delegations(오래된 정리된 이력)'] = '오래된 정리된 이력은 목록에서 빼고 문서/카드별 개수만 omitted.removedByTarget에 남겼습니다. 필요하면 retrieval.targetCard로 카드별로 조회하세요.'
      })
    },
  },
]

export const DELEGATION_BUDGET_STEP_IDS = Object.freeze(DELEGATION_BUDGET_STEPS.map((step) => step.id))

function assemble(working, state, context) {
  const omitted = {
    scope: '응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 판단이 필요한 위임(미종료·실패·복구 가능·종료 처리 가능·보고 대기)과 미해결 접수 실패는 그대로 두고 정리된 이력(완료·대체·종료된 위임과 재접수 확인·종료된 접수 실패)만 줄였습니다.',
    fields: state.fields,
    ...(Object.keys(state.counts).length > 0 ? { counts: state.counts } : {}),
    ...(state.resultOmittedIds.length > 0 ? { resultOmittedDelegationIds: [...state.resultOmittedIds] } : {}),
    ...(Object.keys(state.removedByTarget).length > 0 ? { removedByTarget: state.removedByTarget } : {}),
    ...(Object.keys(state.removedRequestFailuresByTarget).length > 0 ? { removedRequestFailuresByTarget: state.removedRequestFailuresByTarget } : {}),
    rule: '생략된 결과나 세부 기록을 추측하지 말고, 검토·수신 확인·복구 판단에 필요하면 retrieval로 해당 위임을 먼저 조회하세요.',
    retrieval: {
      delegation: { tool: 'mindnprogress_list_ai_delegations', arguments: { mapId: context.mapId, delegationId: '<delegationId>', includeResult: true } },
      targetCard: { tool: 'mindnprogress_list_ai_delegations', arguments: { mapId: context.mapId, targetCardId: '<targetCardId>', includeResult: true } },
    },
  }
  const responseBudget = { limitChars: context.limitChars, originalChars: context.originalChars, returnedChars: context.limitChars,
    appliedSteps: [...state.applied], exceeded: false }
  // 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이도록 mapId 바로 뒤에 둔다.
  const result = {}
  for (const [key, value] of Object.entries(working)) {
    result[key] = value
    if (key === 'mapId') Object.assign(result, { responseBudget, omitted })
  }
  if (!('responseBudget' in result)) Object.assign(result, { responseBudget, omitted })
  return result
}

/** 응답이 limitChars를 넘을 때만 정리된 이력을 단계적으로 줄인 새 응답을 만든다. 넘지 않으면 원래 객체를 그대로 반환한다. */
export function applyDelegationBudget(response, { mapId, limitChars = DELEGATION_RESPONSE_BUDGET_CHARS } = {}) {
  if (!Array.isArray(response?.delegations)) return response
  const originalChars = size(response)
  if (originalChars <= limitChars) return response
  const working = structuredClone(response)
  const state = { fields: {}, counts: {}, resultOmittedIds: [], removedByTarget: {}, removedRequestFailuresByTarget: {}, applied: [] }
  const context = { mapId: mapId ?? working.mapId, limitChars, originalChars }
  const latest = new Set()
  for (const item of working.delegations) {
    if (delegationNeedsAttention(item) || latest.has(targetKey(item))) continue
    latest.add(targetKey(item))
    item.__latest = true
  }
  const groups = {
    olderSettled: working.delegations.filter((item) => !delegationNeedsAttention(item) && !item.__latest),
    latestSettled: working.delegations.filter((item) => item.__latest),
    settledRequestFailures: (working.requestFailures ?? []).filter((item) => !requestFailureNeedsAttention(item)),
  }
  for (const item of working.delegations) delete item.__latest
  const fits = () => size(assemble(working, state, context)) <= limitChars
  for (const step of DELEGATION_BUDGET_STEPS) {
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
