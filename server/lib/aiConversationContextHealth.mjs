import { createHash } from 'node:crypto'

export const AI_CONVERSATION_CONTEXT_THRESHOLDS = Object.freeze({
  cautionUsageRatio: 0.65,
  saturatedUsageRatio: 0.8,
  cautionConversationTurnCount: 40,
  highConversationTurnCount: 80,
  cautionConsecutiveResumeCount: 5,
  highConsecutiveResumeCount: 10,
})

function finiteCount(value) {
  if (value === null || value === undefined || value === '') return null
  return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : null
}

function contextUsage(value) {
  const used = finiteCount(value?.used)
  const reportedSize = finiteCount(value?.size)
  const size = reportedSize > 0 ? reportedSize : null
  return {
    used,
    size,
    ratio: used !== null && size ? used / size : null,
  }
}

function reason(code, message) {
  return { code, message }
}

export function assessAiConversationContextHealth(input, observedAt = new Date().toISOString()) {
  const usage = contextUsage(input?.usage)
  const conversationTurnCount = finiteCount(input?.conversationTurnCount ?? input?.messageCount)
  const conversationTurnCountExact = input?.conversationTurnCountExact === true
    || input?.messageCountExact === true
  const delegationCount = finiteCount(input?.delegationCount) ?? 0
  const consecutiveResumeCount = finiteCount(input?.consecutiveResumeCount) ?? 0
  const historyAvailable = conversationTurnCount !== null
  const historyComplete = historyAvailable && (input?.historyComplete === undefined
    ? conversationTurnCountExact
    : input.historyComplete === true)
  const saturatedReasons = []
  const cautionReasons = []
  const coverageReasons = []

  if (usage.ratio !== null && usage.ratio >= AI_CONVERSATION_CONTEXT_THRESHOLDS.saturatedUsageRatio) {
    saturatedReasons.push(reason('CONVERSATION_CONTEXT_USAGE_HIGH', `문맥 사용률이 ${Math.round(usage.ratio * 100)}%입니다.`))
  } else if (usage.ratio !== null && usage.ratio >= AI_CONVERSATION_CONTEXT_THRESHOLDS.cautionUsageRatio) {
    cautionReasons.push(reason('CONVERSATION_CONTEXT_USAGE_CAUTION', `문맥 사용률이 ${Math.round(usage.ratio * 100)}%입니다.`))
  }
  if (usage.ratio === null && conversationTurnCount !== null
    && conversationTurnCount >= AI_CONVERSATION_CONTEXT_THRESHOLDS.highConversationTurnCount) {
    cautionReasons.push(reason('CONVERSATION_TURN_COUNT_HIGH', `확인된 대화 실행 턴이 ${conversationTurnCount}개입니다. 실제 문맥 포화 여부는 확인되지 않았습니다.`))
  } else if (usage.ratio === null && conversationTurnCount !== null
    && conversationTurnCount >= AI_CONVERSATION_CONTEXT_THRESHOLDS.cautionConversationTurnCount) {
    cautionReasons.push(reason('CONVERSATION_TURN_COUNT_CAUTION', `확인된 대화 실행 턴이 ${conversationTurnCount}개입니다.`))
  }
  if (usage.ratio === null
    && consecutiveResumeCount >= AI_CONVERSATION_CONTEXT_THRESHOLDS.highConsecutiveResumeCount) {
    cautionReasons.push(reason('CONVERSATION_RESUME_STREAK_HIGH', `같은 대화를 연속 ${consecutiveResumeCount}회 이어갔습니다. 실제 문맥 포화 여부는 확인되지 않았습니다.`))
  } else if (usage.ratio === null
    && consecutiveResumeCount >= AI_CONVERSATION_CONTEXT_THRESHOLDS.cautionConsecutiveResumeCount) {
    cautionReasons.push(reason('CONVERSATION_RESUME_STREAK_CAUTION', `같은 대화를 연속 ${consecutiveResumeCount}회 이어갔습니다.`))
  }
  if (historyAvailable && (!historyComplete || !conversationTurnCountExact)) {
    const incompleteCoverage = !historyComplete
      ? reason('CONVERSATION_HISTORY_INCOMPLETE', '대화 이력 통계가 일부 범위이므로 실행 턴 수는 하한값입니다.')
      : reason('CONVERSATION_TURN_ATTRIBUTION_INCOMPLETE', '전체 이력을 조회했지만 일부 이벤트의 실행 턴 ID가 없어 턴 수는 하한값입니다.')
    if (usage.used === null) cautionReasons.push(incompleteCoverage)
    else coverageReasons.push(incompleteCoverage)
  }
  if (usage.used !== null && usage.size === null) {
    coverageReasons.push(reason(
      'CONVERSATION_CONTEXT_SIZE_UNKNOWN',
      `Aion이 문맥 사용량 ${usage.used.toLocaleString('ko-KR')}은 제공했지만 전체 문맥 크기는 제공하지 않아 사용률로 환산하지 않았습니다.`,
    ))
  }

  const state = saturatedReasons.length > 0
    ? 'saturated'
    : !historyAvailable
      ? 'unknown'
      : cautionReasons.length > 0
        ? 'caution'
        : usage.used !== null && usage.size === null
          ? 'unverified'
          : 'healthy'
  const reasons = state === 'saturated'
    ? [...saturatedReasons, ...cautionReasons, ...coverageReasons]
    : state === 'unknown'
      ? [reason('CONVERSATION_CONTEXT_HEALTH_UNAVAILABLE', '대화 메시지 이력을 확인하지 못했습니다.')]
      : [...cautionReasons, ...coverageReasons]
  const recommendation = state === 'healthy' || state === 'unverified' ? 'resume' : 'new'
  const resumeAllowed = state === 'healthy' || state === 'unverified' || state === 'caution'
  const metrics = {
    contextUsed: usage.used,
    contextSize: usage.size,
    contextUsageRatio: usage.ratio,
    // 기존 응답 소비자와의 호환을 위해 필드는 유지하되, 알 수 없는 크기를 추정하지 않습니다.
    estimatedContextSize: null,
    estimatedContextUsageRatio: null,
    conversationTurnCount,
    conversationTurnCountExact,
    messageCount: conversationTurnCount,
    messageCountExact: conversationTurnCountExact,
    historyComplete,
    eventCount: finiteCount(input?.eventCount),
    eventCountExact: input?.eventCountExact === true,
    textMessageCount: finiteCount(input?.textMessageCount),
    userMessageCount: finiteCount(input?.userMessageCount),
    assistantMessageCount: finiteCount(input?.assistantMessageCount),
    toolCallCount: finiteCount(input?.toolCallCount),
    otherEventCount: finiteCount(input?.otherEventCount),
    backendTurnCount: finiteCount(input?.backendTurnCount),
    messagePageCount: finiteCount(input?.pageCount),
    delegationCount,
    consecutiveResumeCount,
  }
  const assessmentId = createHash('sha256').update(JSON.stringify({
    conversationId: String(input?.conversationId ?? ''),
    modifiedAt: input?.modifiedAt ?? null,
    metrics,
    state,
  })).digest('hex')
  const message = state === 'healthy'
    ? '현재 문맥 상태에서 같은 업무 흐름의 후속 작업은 이어갈 수 있습니다.'
    : state === 'unverified'
      ? '전체 문맥 크기가 없어 포화 여부를 검증할 수 없습니다. 실제 사용량과 업무 연속성을 확인한 뒤, 같은 흐름의 후속 작업에 한해 이어가기를 시도할 수 있습니다.'
    : state === 'caution'
      ? '문맥 사용률 또는 대화 길이에서 주의 신호가 있습니다. 새 대화를 고려하되, 정확히 이어지는 후속 작업은 현재 평가를 확인한 뒤 재사용할 수 있습니다.'
      : state === 'saturated'
        ? '대화 문맥이 포화 기준에 도달해 일반적인 새 위임은 새 대화로 시작해야 합니다.'
        : '대화 문맥 상태를 확인하지 못해 일반적인 새 위임은 새 대화로 시작해야 합니다.'

  return {
    state,
    recommendation,
    resumeAllowed,
    assessmentId,
    observedAt,
    metrics,
    reasonCodes: reasons.map((entry) => entry.code),
    reasons,
    message,
  }
}

export function isAiDelegationModelBlocked(modelId) {
  return /^gpt-5\.6-sol(?:\[.*\])?$/.test(String(modelId ?? '').trim().toLowerCase())
}

export function applyAiConversationDelegationModelPolicy(contextHealth, { linkedModelId, runtimeModelId } = {}) {
  const linked = String(linkedModelId ?? '').trim().toLowerCase()
  const runtime = String(runtimeModelId ?? '').trim().toLowerCase()
  const blocked = [linked, runtime].some(isAiDelegationModelBlocked)
  const assessmentId = createHash('sha256').update(JSON.stringify({
    contextAssessmentId: contextHealth.assessmentId,
    linkedModelId: linked,
    runtimeModelId: runtime,
  })).digest('hex')
  if (!blocked) return { ...contextHealth, assessmentId }
  const code = 'CONVERSATION_MODEL_REUSE_BLOCKED'
  const message = 'GPT-5.6-Sol로 진행된 대화는 새 AI 위임에 이어 쓰지 않습니다. 다른 모델을 명시해 새 대화를 만드세요.'
  return {
    ...contextHealth,
    assessmentId,
    recommendation: 'new',
    resumeAllowed: false,
    reasonCodes: [...contextHealth.reasonCodes, code],
    reasons: [...contextHealth.reasons, { code, message }],
    message,
  }
}
