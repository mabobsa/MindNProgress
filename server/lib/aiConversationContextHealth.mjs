import { createHash } from 'node:crypto'

export const AI_CONVERSATION_CONTEXT_THRESHOLDS = Object.freeze({
  cautionUsageRatio: 0.65,
  saturatedUsageRatio: 0.8,
  cautionMessageCount: 100,
  saturatedMessageCount: 180,
  cautionConsecutiveResumeCount: 5,
  saturatedConsecutiveResumeCount: 10,
})

function finiteCount(value) {
  if (value === null || value === undefined || value === '') return null
  return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : null
}

function contextUsage(value) {
  const used = finiteCount(value?.used)
  const size = finiteCount(value?.size)
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
  const messageCount = finiteCount(input?.messageCount)
  const messageCountExact = input?.messageCountExact === true
  const delegationCount = finiteCount(input?.delegationCount) ?? 0
  const consecutiveResumeCount = finiteCount(input?.consecutiveResumeCount) ?? 0
  const historyAvailable = messageCount !== null
  const saturatedReasons = []
  const cautionReasons = []

  if (usage.ratio !== null && usage.ratio >= AI_CONVERSATION_CONTEXT_THRESHOLDS.saturatedUsageRatio) {
    saturatedReasons.push(reason('CONVERSATION_CONTEXT_USAGE_HIGH', `문맥 사용률이 ${Math.round(usage.ratio * 100)}%입니다.`))
  } else if (usage.ratio !== null && usage.ratio >= AI_CONVERSATION_CONTEXT_THRESHOLDS.cautionUsageRatio) {
    cautionReasons.push(reason('CONVERSATION_CONTEXT_USAGE_CAUTION', `문맥 사용률이 ${Math.round(usage.ratio * 100)}%입니다.`))
  }
  if (messageCount !== null && messageCount >= AI_CONVERSATION_CONTEXT_THRESHOLDS.saturatedMessageCount) {
    saturatedReasons.push(reason('CONVERSATION_MESSAGE_COUNT_HIGH', `확인된 메시지가 ${messageCount}개입니다.`))
  } else if (messageCount !== null && messageCount >= AI_CONVERSATION_CONTEXT_THRESHOLDS.cautionMessageCount) {
    cautionReasons.push(reason('CONVERSATION_MESSAGE_COUNT_CAUTION', `확인된 메시지가 ${messageCount}개입니다.`))
  }
  if (consecutiveResumeCount >= AI_CONVERSATION_CONTEXT_THRESHOLDS.saturatedConsecutiveResumeCount) {
    saturatedReasons.push(reason('CONVERSATION_RESUME_STREAK_HIGH', `같은 대화를 연속 ${consecutiveResumeCount}회 이어갔습니다.`))
  } else if (consecutiveResumeCount >= AI_CONVERSATION_CONTEXT_THRESHOLDS.cautionConsecutiveResumeCount) {
    cautionReasons.push(reason('CONVERSATION_RESUME_STREAK_CAUTION', `같은 대화를 연속 ${consecutiveResumeCount}회 이어갔습니다.`))
  }
  if (historyAvailable && !messageCountExact) {
    cautionReasons.push(reason('CONVERSATION_HISTORY_INCOMPLETE', '메시지 이력이 한 페이지를 넘어 전체 개수는 하한값입니다.'))
  }

  const state = saturatedReasons.length > 0
    ? 'saturated'
    : !historyAvailable
      ? 'unknown'
      : cautionReasons.length > 0
        ? 'caution'
        : 'healthy'
  const reasons = state === 'saturated'
    ? [...saturatedReasons, ...cautionReasons]
    : state === 'unknown'
      ? [reason('CONVERSATION_CONTEXT_HEALTH_UNAVAILABLE', '대화 메시지 이력을 확인하지 못했습니다.')]
      : cautionReasons
  const recommendation = state === 'healthy' ? 'resume' : 'new'
  const resumeAllowed = state === 'healthy' || state === 'caution'
  const metrics = {
    contextUsed: usage.used,
    contextSize: usage.size,
    contextUsageRatio: usage.ratio,
    messageCount,
    messageCountExact,
    historyComplete: historyAvailable && messageCountExact,
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
    : state === 'caution'
      ? '대화 문맥이 길어지고 있어 새 대화를 권장합니다. 정확히 이어지는 후속 작업만 현재 평가를 확인한 뒤 재사용하세요.'
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
