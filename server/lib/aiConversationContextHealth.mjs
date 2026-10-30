import { createHash } from 'node:crypto'
import { aiModelPolicy, aiModelPolicyRevision, blockedAiModelLabels, isAiModelBlocked } from './aiModelPolicy.mjs'

// 응급 OFF 스위치다. false로 내리면 서버 차단·예외 상한과 MCP 선택 안내를 함께 끈다.
// 문맥 지표 수집·평가와 금지 모델 등 다른 재사용 안전 조건은 스위치와 무관하게 유지한다.
export const AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED = true

export const AI_CONVERSATION_CONTEXT_THRESHOLDS = Object.freeze({
  cautionUsageRatio: 0.65,
  saturatedUsageRatio: 0.8,
  // 포화 대화를 상위 AI의 사유로 예외 이어가기할 수 있는 사용률 상한(미만)이다.
  overrideLimitUsageRatio: 0.9,
  cautionConversationTurnCount: 40,
  highConversationTurnCount: 80,
  cautionConsecutiveResumeCount: 5,
  highConsecutiveResumeCount: 10,
})

// 포화 대화의 예외 이어가기에 상위 AI가 붙일 수 있는 사유 코드다. 사유 설명은 위임·지시 기록에 남는다.
export const AI_CONVERSATION_CONTEXT_OVERRIDE_REASON_CODES = Object.freeze([
  'unrecorded-context',
  'final-step',
  'continued-review',
  'user-requested',
])
export const AI_CONVERSATION_CONTEXT_OVERRIDE_REASON_MAX_LENGTH = 500

export function aiConversationContextUsagePercent(ratio) {
  return `${Math.round(ratio * 100)}%`
}

const overrideLimitPercent = aiConversationContextUsagePercent(AI_CONVERSATION_CONTEXT_THRESHOLDS.overrideLimitUsageRatio)

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

export function assessAiConversationContextHealth(input, observedAt = new Date().toISOString(), {
  contextReuseGuardEnabled = AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED,
} = {}) {
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
    // 전체 이력을 확보했다면 턴 ID 누락만으로 새 대화를 권장하지 않습니다.
    if (usage.used === null && !historyComplete) cautionReasons.push(incompleteCoverage)
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
        : (usage.used !== null && usage.size === null)
          || (usage.used === null && historyComplete && !conversationTurnCountExact)
          ? 'unverified'
          : 'healthy'
  const reasons = state === 'saturated'
    ? [...saturatedReasons, ...cautionReasons, ...coverageReasons]
    : state === 'unknown'
      ? [reason('CONVERSATION_CONTEXT_HEALTH_UNAVAILABLE', '대화 메시지 이력을 확인하지 못했습니다.')]
      : [...cautionReasons, ...coverageReasons]
  const recommendation = !contextReuseGuardEnabled || state === 'healthy' || state === 'unverified' ? 'resume' : 'new'
  const resumeAllowed = !contextReuseGuardEnabled || state === 'healthy' || state === 'unverified' || state === 'caution'
  // 포화 판정은 실제 사용률로만 내려지므로 saturated이면 사용률이 항상 있다.
  const belowOverrideLimit = usage.ratio !== null && usage.ratio < AI_CONVERSATION_CONTEXT_THRESHOLDS.overrideLimitUsageRatio
  const contextOverrideEligible = contextReuseGuardEnabled && state === 'saturated' && belowOverrideLimit
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
    contextReuseGuardEnabled,
  })).digest('hex')
  const assessedMessage = state === 'healthy'
    ? '현재 문맥 상태에서 같은 업무 흐름의 후속 작업은 이어갈 수 있습니다.'
    : state === 'unverified'
      ? usage.used === null
        ? '문맥 사용량이 아직 보고되지 않았고 일부 실행 턴 ID가 없어 포화 여부를 검증할 수 없습니다. 같은 흐름의 후속 작업은 최신 상태를 확인한 뒤 이어갈 수 있습니다.'
        : '전체 문맥 크기가 없어 포화 여부를 검증할 수 없습니다. 실제 사용량과 업무 연속성을 확인한 뒤, 같은 흐름의 후속 작업에 한해 이어가기를 시도할 수 있습니다.'
    : state === 'caution'
      ? '문맥 사용률 또는 대화 길이에서 주의 신호가 있습니다. 새 대화를 고려하되, 정확히 이어지는 후속 작업은 현재 평가를 확인한 뒤 재사용할 수 있습니다.'
      : state === 'saturated'
        ? `대화 문맥이 포화 기준에 도달해 일반적인 새 위임은 새 대화로 시작해야 합니다. ${belowOverrideLimit
          ? `사용률이 ${overrideLimitPercent} 미만이므로 같은 업무의 후속 작업이 카드에 기록되지 않은 대화 맥락에 의존하거나 사용자가 이 대화를 이어가라고 직접 지시한 경우에만 contextOverride에 사유를 붙여 예외로 이어갈 수 있습니다.`
          : `사용률이 ${overrideLimitPercent} 이상이라 contextOverride 예외도 허용하지 않습니다.`}`
        : '대화 문맥 상태를 확인하지 못해 일반적인 새 위임은 새 대화로 시작해야 합니다.'
  const message = contextReuseGuardEnabled ? assessedMessage
    : '컨텍스트 기준 새 대화 전환은 임시로 OFF입니다. 문맥 지표는 참고용이며 크기·길이·통계 미확인만으로 새 대화를 요구하거나 이어가기를 차단하지 않습니다.'
      + (state === 'healthy' || state === 'unverified' ? ` ${assessedMessage}` : '')

  return {
    state,
    contextReuseGuardEnabled,
    recommendation,
    resumeAllowed,
    contextOverrideEligible,
    assessmentId,
    observedAt,
    metrics,
    reasonCodes: reasons.map((entry) => entry.code),
    reasons,
    message,
  }
}

export { isAiModelBlocked as isAiDelegationModelBlocked } from './aiModelPolicy.mjs'

export function applyAiConversationDelegationModelPolicy(contextHealth, { linkedModelId, runtimeModelId } = {}, policy = aiModelPolicy) {
  const linked = String(linkedModelId ?? '').trim().toLowerCase()
  const runtime = String(runtimeModelId ?? '').trim().toLowerCase()
  const blocked = [linked, runtime].some((id) => isAiModelBlocked(id, policy))
  const assessmentId = createHash('sha256').update(JSON.stringify({
    contextAssessmentId: contextHealth.assessmentId,
    linkedModelId: linked,
    runtimeModelId: runtime,
    modelPolicyRevision: aiModelPolicyRevision(policy),
  })).digest('hex')
  if (!blocked) return { ...contextHealth, assessmentId }
  const code = 'CONVERSATION_MODEL_REUSE_BLOCKED'
  const message = `${blockedAiModelLabels(policy)}로 진행된 대화는 새 AI 위임에 이어 쓰지 않습니다. 다른 모델을 명시해 새 대화를 만드세요.`
  return {
    ...contextHealth,
    assessmentId,
    recommendation: 'new',
    resumeAllowed: false,
    contextOverrideEligible: false,
    reasonCodes: [...contextHealth.reasonCodes, code],
    reasons: [...contextHealth.reasons, { code, message }],
    message,
  }
}

// 요청의 contextOverride를 정규화한다. 없으면 null, 형식이 맞지 않으면 undefined를 반환한다.
export function normalizeAiConversationContextOverride(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const reasonCode = typeof value.reasonCode === 'string' ? value.reasonCode.trim() : ''
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  if (!AI_CONVERSATION_CONTEXT_OVERRIDE_REASON_CODES.includes(reasonCode)
    || !reason || reason.length > AI_CONVERSATION_CONTEXT_OVERRIDE_REASON_MAX_LENGTH) return undefined
  return { reasonCode, reason }
}

// 최신 평가에 contextOverride를 적용해 이어가기 허용 여부를 정한다. 평가(assessmentId)와 분리해
// 후보 조회와 요청, 대기 후 시작 재확인이 같은 평가를 공유한다. 허용된 예외만 기록 값으로 돌려준다.
export function resolveAiConversationContextOverride(contextHealth, contextOverride = null) {
  if (contextHealth.resumeAllowed) return { allowed: true, code: null, message: contextHealth.message, contextOverride: null }
  if (contextHealth.reasonCodes.includes('CONVERSATION_MODEL_REUSE_BLOCKED')) {
    return { allowed: false, code: 'MODEL_BLOCKED', message: contextHealth.message, contextOverride: null }
  }
  if (contextHealth.state === 'saturated') {
    if (!contextOverride) return { allowed: false, code: 'SATURATED', message: contextHealth.message, contextOverride: null }
    if (!contextHealth.contextOverrideEligible) {
      return {
        allowed: false,
        code: 'OVERRIDE_LIMIT',
        message: `문맥 사용률이 ${overrideLimitPercent} 이상이라 예외로도 이어갈 수 없습니다. 같은 대화로 다시 요청하지 말고 새 대화로 위임하며, 필요한 맥락은 instruction에 요약하세요.`,
        contextOverride: null,
      }
    }
    return {
      allowed: true,
      code: null,
      message: contextHealth.message,
      contextOverride: {
        reasonCode: contextOverride.reasonCode,
        reason: contextOverride.reason,
        contextUsageRatio: contextHealth.metrics.contextUsageRatio,
        assessmentId: contextHealth.assessmentId,
      },
    }
  }
  return {
    allowed: false,
    code: 'UNKNOWN',
    message: contextOverride
      ? `${contextHealth.message} 상태를 확인할 수 없는 대화에는 contextOverride를 적용하지 않습니다.`
      : contextHealth.message,
    contextOverride: null,
  }
}
