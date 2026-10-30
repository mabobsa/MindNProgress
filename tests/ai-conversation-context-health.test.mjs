import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_CONVERSATION_CONTEXT_OVERRIDE_REASON_CODES,
  AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED,
  applyAiConversationDelegationModelPolicy,
  assessAiConversationContextHealth as assessContextHealth,
  isAiDelegationModelBlocked,
  normalizeAiConversationContextOverride,
  resolveAiConversationContextOverride,
} from '../server/lib/aiConversationContextHealth.mjs'

// ON 판정을 명시해 기본값이 바뀌어도 같은 기준을 검증한다. 응급 OFF는 contextReuseGuardEnabled: false로 따로 검증한다.
function assessAiConversationContextHealth(input, observedAt) {
  return assessContextHealth(input, observedAt, { contextReuseGuardEnabled: true })
}
const assessOff = (input, observedAt) => assessContextHealth(input, observedAt, { contextReuseGuardEnabled: false })
const override = { reasonCode: 'unrecorded-context', reason: '대화에만 있는 결정 맥락을 이어서 수정해야 합니다.' }

const base = {
  conversationId: 'conversation-a',
  modifiedAt: '2026-09-22T00:00:00.000Z',
  runtimeState: 'idle',
  usage: { used: 20_000, size: 200_000 },
  conversationTurnCount: 20,
  conversationTurnCountExact: true,
  delegationCount: 1,
  consecutiveResumeCount: 1,
}

test('공통 스위치는 기본 ON이며 사용률 80% 이상 대화의 일반 이어가기를 막는다', () => {
  const result = assessContextHealth({ ...base, usage: { used: 190_000, size: 200_000 } })
  assert.equal(AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED, true)
  assert.equal(result.contextReuseGuardEnabled, true)
  assert.equal(result.state, 'saturated')
  assert.equal(result.metrics.contextUsageRatio, 0.95)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_CONTEXT_USAGE_HIGH'])
  assert.equal(result.resumeAllowed, false)
  assert.equal(result.recommendation, 'new')
  assert.equal(result.contextOverrideEligible, false, '90% 이상은 예외도 허용하지 않는다.')
  assert.match(result.message, /새 대화로 시작해야 합니다\. 사용률이 90% 이상이라 contextOverride 예외도 허용하지 않습니다\.$/)
})

test('예외 가능 구간은 사용률 80% 이상 90% 미만이며 경계값을 그대로 따른다', () => {
  for (const [used, state, eligible] of [
    [159_999, 'caution', false],
    [160_000, 'saturated', true],
    [179_999, 'saturated', true],
    [180_000, 'saturated', false],
  ]) {
    const result = assessContextHealth({ ...base, usage: { used, size: 200_000 } })
    assert.equal(result.state, state, `${used}`)
    assert.equal(result.contextOverrideEligible, eligible, `${used}`)
  }
  const eligible = assessContextHealth({ ...base, usage: { used: 170_000, size: 200_000 } })
  assert.equal(eligible.resumeAllowed, false)
  assert.match(eligible.message, /사용률이 90% 미만이므로 같은 업무의 후속 작업이 카드에 기록되지 않은 대화 맥락에 의존하거나 사용자가 이 대화를 이어가라고 직접 지시한 경우에만 contextOverride/)
})

test('응급 OFF에서는 높은 사용률·주의·긴 대화·연속 재사용·통계 미확인도 교체 사유로 삼지 않는다', () => {
  for (const input of [
    { ...base, usage: { used: 190_000, size: 200_000 } },
    { ...base, usage: { used: 140_000, size: 200_000 } },
    { ...base, usage: {}, conversationTurnCount: 100, consecutiveResumeCount: 15 },
    { ...base, usage: {}, conversationTurnCount: null, conversationTurnCountExact: false },
  ]) {
    const result = assessOff(input)
    assert.equal(result.contextReuseGuardEnabled, false)
    assert.equal(result.resumeAllowed, true)
    assert.equal(result.recommendation, 'resume')
    assert.equal(result.contextOverrideEligible, false)
  }
  const saturated = assessOff({ ...base, usage: { used: 190_000, size: 200_000 } })
  assert.equal(saturated.state, 'saturated', '관측 지표와 판정 자체는 참고용으로 남긴다.')
  assert.match(saturated.message, /임시로 OFF/)
  assert.doesNotMatch(saturated.message, /새 대화로 시작해야/)
})

test('스위치 ON·OFF 전환은 같은 지표라도 평가 ID를 구분한다', () => {
  const input = { ...base, usage: { used: 190_000, size: 200_000 } }
  const off = assessOff(input)
  const on = assessContextHealth(input)
  assert.equal(on.resumeAllowed, false)
  assert.equal(off.resumeAllowed, true)
  assert.deepEqual(off.metrics, on.metrics)
  assert.notEqual(off.assessmentId, on.assessmentId)
})

test('포화 예외는 90% 미만 포화 대화에만 적용하고 적용한 예외만 기록 값으로 돌려준다', () => {
  const eligible = assessContextHealth({ ...base, usage: { used: 170_000, size: 200_000 } })
  const blocked = resolveAiConversationContextOverride(eligible, null)
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.code, 'SATURATED')
  assert.equal(blocked.message, eligible.message)
  const applied = resolveAiConversationContextOverride(eligible, override)
  assert.equal(applied.allowed, true)
  assert.deepEqual(applied.contextOverride, { ...override, contextUsageRatio: 0.85, assessmentId: eligible.assessmentId })

  const limited = assessContextHealth({ ...base, usage: { used: 180_000, size: 200_000 } })
  const overLimit = resolveAiConversationContextOverride(limited, override)
  assert.equal(overLimit.allowed, false)
  assert.equal(overLimit.code, 'OVERRIDE_LIMIT')
  assert.match(overLimit.message, /90% 이상이라 예외로도 이어갈 수 없습니다.*같은 대화로 다시 요청하지 말고 새 대화로 위임/)
  assert.equal(resolveAiConversationContextOverride(limited, null).code, 'SATURATED')

  const unknown = assessContextHealth({ ...base, conversationTurnCount: null, conversationTurnCountExact: false })
  const unknownOverride = resolveAiConversationContextOverride(unknown, override)
  assert.equal(unknownOverride.allowed, false)
  assert.equal(unknownOverride.code, 'UNKNOWN')
  assert.match(unknownOverride.message, /상태를 확인할 수 없는 대화에는 contextOverride를 적용하지 않습니다/)
  assert.equal(resolveAiConversationContextOverride(unknown, null).message, unknown.message)

  for (const contextHealth of [
    assessAiConversationContextHealth(base),
    assessContextHealth({ ...base, usage: { used: 140_000, size: 200_000 } }),
    assessOff({ ...base, usage: { used: 190_000, size: 200_000 } }),
  ]) {
    const ignored = resolveAiConversationContextOverride(contextHealth, override)
    assert.equal(ignored.allowed, true)
    assert.equal(ignored.contextOverride, null, '예외가 필요 없는 대화의 예외는 기록하지 않는다.')
  }
})

test('금지 모델 대화는 포화 예외로도 이어가지 않는다', () => {
  const eligible = assessContextHealth({ ...base, usage: { used: 170_000, size: 200_000 } })
  const blocked = applyAiConversationDelegationModelPolicy(eligible, { linkedModelId: 'gpt-6-sol', runtimeModelId: 'gpt-6.1-sol' })
  assert.equal(blocked.contextOverrideEligible, false)
  const decision = resolveAiConversationContextOverride(blocked, override)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, 'MODEL_BLOCKED')
  assert.equal(decision.contextOverride, null)
  const allowed = applyAiConversationDelegationModelPolicy(eligible, { linkedModelId: 'gpt-6.1-sol', runtimeModelId: 'gpt-6.1-sol' })
  assert.equal(allowed.contextOverrideEligible, true)
  assert.equal(resolveAiConversationContextOverride(allowed, override).allowed, true)
})

test('예외 인자는 허용 사유 코드와 500자 이하 근거만 받는다', () => {
  assert.deepEqual(AI_CONVERSATION_CONTEXT_OVERRIDE_REASON_CODES, ['unrecorded-context', 'final-step', 'continued-review', 'user-requested'])
  assert.equal(normalizeAiConversationContextOverride(undefined), null)
  assert.equal(normalizeAiConversationContextOverride(null), null)
  for (const reasonCode of AI_CONVERSATION_CONTEXT_OVERRIDE_REASON_CODES) {
    assert.deepEqual(normalizeAiConversationContextOverride({ reasonCode, reason: '  근거  ', extra: 'ignored' }), { reasonCode, reason: '근거' })
  }
  assert.equal(normalizeAiConversationContextOverride({ reasonCode: 'final-step', reason: '가'.repeat(500) }).reason.length, 500)
  for (const invalid of [
    'unrecorded-context', [], {}, { reasonCode: 'convenience', reason: '편의' }, { reasonCode: 'final-step' },
    { reasonCode: 'final-step', reason: '   ' }, { reasonCode: 'final-step', reason: '가'.repeat(501) },
    { reasonCode: 'final-step', reason: 1 }, { reasonCode: ['final-step'], reason: '근거' },
  ]) {
    assert.equal(normalizeAiConversationContextOverride(invalid), undefined, JSON.stringify(invalid))
  }
})

test('컨텍스트 스위치가 OFF여도 금지 모델은 기존·실행 모델 양쪽에서 재사용을 차단한다', () => {
  const contextHealth = assessOff({ ...base, usage: { used: 190_000, size: 200_000 } })
  for (const modelId of ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.0-sol']) {
    for (const models of [{ linkedModelId: modelId, runtimeModelId: 'gpt-6.1-sol' },
      { linkedModelId: 'gpt-6.1-sol', runtimeModelId: modelId }]) {
      const blocked = applyAiConversationDelegationModelPolicy(contextHealth, models)
      assert.equal(blocked.contextReuseGuardEnabled, false)
      assert.equal(blocked.resumeAllowed, false)
      assert.equal(blocked.recommendation, 'new')
      assert.ok(blocked.reasonCodes.includes('CONVERSATION_MODEL_REUSE_BLOCKED'))
    }
  }
})

test('짧고 사용량이 낮은 대화는 같은 업무 후속 작업의 이어가기를 허용한다', () => {
  const result = assessAiConversationContextHealth(base, '2026-09-22T01:00:00.000Z')
  assert.equal(result.state, 'healthy')
  assert.equal(result.recommendation, 'resume')
  assert.equal(result.resumeAllowed, true)
  assert.equal(result.metrics.contextUsageRatio, 0.1)
  assert.equal(result.metrics.estimatedContextSize, null)
})

test('사용량이 없으면 실행 턴 80개와 연속 이어가기 12회도 포화로 단정하지 않는다', () => {
  const result = assessAiConversationContextHealth({
    ...base,
    usage: {},
    conversationTurnCount: 80,
    conversationTurnCountExact: false,
    delegationCount: 13,
    consecutiveResumeCount: 12,
  })
  assert.equal(result.state, 'caution')
  assert.equal(result.recommendation, 'new')
  assert.equal(result.resumeAllowed, true)
  assert.deepEqual(result.reasonCodes, [
    'CONVERSATION_TURN_COUNT_HIGH',
    'CONVERSATION_RESUME_STREAK_HIGH',
    'CONVERSATION_HISTORY_INCOMPLETE',
  ])
})

test('문맥 사용률이 주의 구간이면 새 대화를 권장하되 명시적 이어가기는 허용한다', () => {
  const result = assessAiConversationContextHealth({ ...base, usage: { used: 140, size: 200 } })
  assert.equal(result.state, 'caution')
  assert.equal(result.recommendation, 'new')
  assert.equal(result.resumeAllowed, true)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_CONTEXT_USAGE_CAUTION'])
})

test('검증된 전체 문맥 크기의 사용률이 80% 이상이면 이어가기를 차단한다', () => {
  const result = assessAiConversationContextHealth({ ...base, usage: { used: 160_000, size: 200_000 } })
  assert.equal(result.state, 'saturated')
  assert.equal(result.recommendation, 'new')
  assert.equal(result.resumeAllowed, false)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_CONTEXT_USAGE_HIGH'])
})

test('전체 문맥 크기가 0으로 보고되면 크기 미확인으로 취급하고 포화를 단정하지 않는다', () => {
  const result = assessAiConversationContextHealth({ ...base, usage: { used: 188_230, size: 0 } })
  assert.equal(result.state, 'unverified')
  assert.equal(result.recommendation, 'resume')
  assert.equal(result.resumeAllowed, true)
  assert.equal(result.metrics.contextSize, null)
  assert.equal(result.metrics.contextUsageRatio, null)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_CONTEXT_SIZE_UNKNOWN'])
})

test('문맥 크기가 없고 실행 턴이 많으면 주의하되 이어가기를 차단하지 않는다', () => {
  const result = assessAiConversationContextHealth({
    ...base,
    usage: { used: 188_230, size: null },
    conversationTurnCount: 80,
  })
  assert.equal(result.state, 'caution')
  assert.equal(result.resumeAllowed, true)
  assert.deepEqual(result.reasonCodes, [
    'CONVERSATION_TURN_COUNT_HIGH',
    'CONVERSATION_CONTEXT_SIZE_UNKNOWN',
  ])
})

test('실제 사용량이 낮으면 재개 횟수만으로 새 대화를 강제하지 않는다', () => {
  const result = assessAiConversationContextHealth({
    ...base,
    conversationTurnCount: 12,
    delegationCount: 13,
    consecutiveResumeCount: 12,
  })
  assert.equal(result.state, 'healthy')
  assert.equal(result.recommendation, 'resume')
  assert.deepEqual(result.reasonCodes, [])
})

test('대화 이력을 확인하지 못한 대화는 안전하게 새 대화를 요구한다', () => {
  const result = assessAiConversationContextHealth({
    ...base,
    conversationTurnCount: null,
    conversationTurnCountExact: false,
  })
  assert.equal(result.state, 'unknown')
  assert.equal(result.resumeAllowed, false)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_CONTEXT_HEALTH_UNAVAILABLE'])
})

test('사용량을 확인했다면 일부 이력의 낮은 실행 턴 수 자체를 경고 상태로 올리지 않는다', () => {
  const result = assessAiConversationContextHealth({
    ...base,
    conversationTurnCount: 1,
    conversationTurnCountExact: false,
    eventCount: 200,
    toolCallCount: 183,
  })
  assert.equal(result.state, 'healthy')
  assert.equal(result.recommendation, 'resume')
  assert.equal(result.resumeAllowed, true)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_HISTORY_INCOMPLETE'])
})

test('사용량과 전체 이력을 모두 확인하지 못하면 새 대화를 권장한다', () => {
  const result = assessAiConversationContextHealth({
    ...base,
    usage: {},
    conversationTurnCount: 1,
    conversationTurnCountExact: false,
  })
  assert.equal(result.state, 'caution')
  assert.equal(result.recommendation, 'new')
  assert.equal(result.resumeAllowed, true)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_HISTORY_INCOMPLETE'])
})

test('평가 ID는 관측 시각이 아니라 대화 변경과 객관적 지표에만 반응한다', () => {
  const first = assessAiConversationContextHealth(base, '2026-09-22T01:00:00.000Z')
  const second = assessAiConversationContextHealth(base, '2026-09-22T02:00:00.000Z')
  const changed = assessAiConversationContextHealth({ ...base, conversationTurnCount: 21 }, '2026-09-22T02:00:00.000Z')
  assert.equal(first.assessmentId, second.assessmentId)
  assert.equal(first.assessmentId, assessAiConversationContextHealth({
    ...base,
    runtimeState: 'running',
  }, '2026-09-22T02:00:00.000Z').assessmentId)
  assert.notEqual(first.assessmentId, changed.assessmentId)
})

test('첫 대화가 포화여도 별도 대화의 문맥 평가와 이어가기 허용에는 영향을 주지 않는다', () => {
  const first = assessAiConversationContextHealth({ ...base, conversationId: 'first-review', usage: { used: 160_000, size: 200_000 } })
  const next = assessAiConversationContextHealth({
    ...base,
    conversationId: 'next-review',
    usage: { used: 32_788, size: null },
    conversationTurnCount: 1,
    conversationTurnCountExact: false,
    historyComplete: true,
    delegationCount: 1,
    consecutiveResumeCount: 0,
  })
  assert.equal(first.resumeAllowed, false)
  assert.equal(first.state, 'saturated')
  assert.equal(next.resumeAllowed, true)
  assert.equal(next.state, 'unverified')
  assert.equal(next.recommendation, 'resume')
  assert.equal(next.metrics.contextUsed, 32_788)
  assert.equal(next.metrics.consecutiveResumeCount, 0)
  assert.notEqual(first.assessmentId, next.assessmentId)
})

test('객관적 지표가 같아도 다른 대화의 평가 ID를 재사용할 수 없다', () => {
  const first = assessAiConversationContextHealth({ ...base, conversationId: 'first-review' })
  const next = assessAiConversationContextHealth({ ...base, conversationId: 'next-review' })
  assert.deepEqual(first.metrics, next.metrics)
  assert.notEqual(first.assessmentId, next.assessmentId)
})

test('GPT-5.6-Sol과 GPT-6-Sol로 기록되었거나 현재 사용하는 대화는 새 위임에 이어 쓰지 않는다', () => {
  const healthy = assessAiConversationContextHealth(base)
  const recorded = applyAiConversationDelegationModelPolicy(healthy, { linkedModelId: 'gpt-5.6-sol', runtimeModelId: 'gpt-6.1-sol' })
  const current = applyAiConversationDelegationModelPolicy(healthy, { linkedModelId: 'gpt-6.1-sol', runtimeModelId: 'GPT-5.6-Sol[1m]' })
  const recordedSix = applyAiConversationDelegationModelPolicy(healthy, { linkedModelId: 'gpt-6-sol', runtimeModelId: 'gpt-6.1-sol' })
  const currentSix = applyAiConversationDelegationModelPolicy(healthy, { linkedModelId: 'gpt-6.1-sol', runtimeModelId: 'GPT-6-Sol[1m]' })
  const other = applyAiConversationDelegationModelPolicy(healthy, { linkedModelId: 'gpt-6.1-sol', runtimeModelId: 'gpt-6.1-sol' })
  assert.equal(recorded.state, 'healthy')
  assert.equal(recorded.resumeAllowed, false)
  assert.equal(current.resumeAllowed, false)
  assert.equal(recordedSix.resumeAllowed, false)
  assert.equal(currentSix.resumeAllowed, false)
  assert.equal(recorded.recommendation, 'new')
  assert.ok(recorded.reasonCodes.includes('CONVERSATION_MODEL_REUSE_BLOCKED'))
  assert.equal(other.resumeAllowed, true)
  assert.notEqual(recorded.assessmentId, current.assessmentId)
  assert.notEqual(other.assessmentId, healthy.assessmentId)
  assert.equal(isAiDelegationModelBlocked('gpt-5.6-sol'), true)
  assert.equal(isAiDelegationModelBlocked('gpt-6-sol'), true)
  assert.equal(isAiDelegationModelBlocked('gpt-6.0-sol'), true)
  assert.equal(isAiDelegationModelBlocked('GPT-6-Sol[1m]'), true)
  assert.equal(isAiDelegationModelBlocked('gpt-6.1-sol'), false)
  assert.equal(isAiDelegationModelBlocked('gpt-5.6-solution'), false)
})

// AionCore가 /usage의 _meta에 남기는 사용량 확인 상태 확장을 붙인 응답이다.
const confirmedAtMs = Date.parse('2026-10-30T14:00:00.000Z')
function usageWith(used, status, freshness = {}) {
  return {
    used,
    size: 200_000,
    _meta: {
      'aionui/contextUsage': {
        status,
        turn_id: 'turn-1',
        updated_at: confirmedAtMs,
        status_changed_at: confirmedAtMs + 100,
        reason: null,
        ...freshness,
      },
    },
  }
}

test('사용량 확인 상태가 current이거나 확장이 없으면 기존 사용률 판정을 그대로 따른다', () => {
  for (const used of [20_000, 140_000, 170_000, 190_000]) {
    const legacy = assessAiConversationContextHealth({ ...base, usage: { used, size: 200_000 } })
    const current = assessAiConversationContextHealth({ ...base, usage: usageWith(used, 'current') })
    for (const key of ['state', 'resumeAllowed', 'recommendation', 'contextOverrideEligible', 'reasonCodes', 'message']) {
      assert.deepEqual(current[key], legacy[key], `${used} ${key}`)
    }
    assert.equal(legacy.metrics.contextUsageStatus, null)
    assert.equal(legacy.metrics.contextUsageUpdatedAt, null)
    assert.equal(current.metrics.contextUsageStatus, 'current')
    assert.equal(current.metrics.contextUsageUpdatedAt, '2026-10-30T14:00:00.000Z')
  }
})

test('확인되지 않은 낮은 사용률은 여유로 판정하지 않고 확인 불가로 둔다', () => {
  const result = assessAiConversationContextHealth({ ...base, usage: usageWith(20_000, 'pending') })
  assert.equal(result.state, 'unverified')
  assert.equal(result.resumeAllowed, true)
  assert.equal(result.recommendation, 'resume')
  assert.equal(result.contextOverrideEligible, false)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_CONTEXT_USAGE_UNCONFIRMED'])
  assert.equal(result.metrics.contextUsageRatio, 0.1, '마지막으로 확인된 값은 그대로 보여 준다.')
  assert.equal(result.metrics.contextUsageStatus, 'pending')
  assert.match(result.message, /^현재 문맥 사용량이 확인되지 않아 포화 여부를 검증할 수 없습니다\. 마지막으로 확인된 사용률은 10%입니다\./)
  const [unconfirmed] = result.reasons
  assert.match(unconfirmed.message, /^이번 턴의 문맥 사용량을 아직 확인하지 못했습니다\(pending\)\. 표시된 사용량은 마지막으로 확인된 값이라 현재 사용률과 다를 수 있습니다\./)
  assert.match(unconfirmed.message, /마지막 확인 시각은 2026-10-30T14:00:00\.000Z입니다\./)
})

test('확인되지 않은 사용률이 주의·포화 기준 이상이면 보수적으로 판정하고 포화 예외를 허용하지 않는다', () => {
  const caution = assessAiConversationContextHealth({ ...base, usage: usageWith(140_000, 'unavailable', { reason: 'timed_out' }) })
  assert.equal(caution.state, 'caution')
  assert.equal(caution.resumeAllowed, true)
  assert.equal(caution.recommendation, 'new')
  assert.deepEqual(caution.reasonCodes, ['CONVERSATION_CONTEXT_USAGE_CAUTION', 'CONVERSATION_CONTEXT_USAGE_UNCONFIRMED'])
  assert.equal(caution.reasons[0].message, '마지막으로 확인된 문맥 사용률이 70%입니다. 현재 사용률은 확인되지 않았습니다.')
  assert.match(caution.reasons[1].message, /^마지막 턴의 문맥 사용량을 확인하지 못했습니다\(unavailable, timed_out\)\./)

  const legacy = assessAiConversationContextHealth({ ...base, usage: { used: 170_000, size: 200_000 } })
  const saturated = assessAiConversationContextHealth({ ...base, usage: usageWith(170_000, 'unavailable', { reason: 'timed_out' }) })
  assert.equal(legacy.contextOverrideEligible, true, '확인된 85%는 예외 대상이다.')
  assert.equal(saturated.state, 'saturated')
  assert.equal(saturated.resumeAllowed, false)
  assert.equal(saturated.contextOverrideEligible, false, '미확인 사용률로는 90% 미만인지 알 수 없다.')
  assert.deepEqual(saturated.reasonCodes, ['CONVERSATION_CONTEXT_USAGE_HIGH', 'CONVERSATION_CONTEXT_USAGE_UNCONFIRMED'])
  assert.equal(saturated.message, '마지막으로 확인된 문맥 사용률이 포화 기준 이상이고 현재 사용률은 확인되지 않아, 일반적인 새 위임은 새 대화로 시작해야 합니다. 사용률이 90% 미만인지 알 수 없으므로 contextOverride 예외도 허용하지 않습니다.')
  assert.equal(resolveAiConversationContextOverride(legacy, override).allowed, true)
  const decision = resolveAiConversationContextOverride(saturated, override)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, 'OVERRIDE_LIMIT')
  assert.equal(decision.contextOverride, null)
  assert.match(decision.message, /^현재 문맥 사용률이 확인되지 않아 90% 미만인지 알 수 없으므로 예외로도 이어갈 수 없습니다\./)
  assert.match(resolveAiConversationContextOverride(assessAiConversationContextHealth({ ...base, usage: { used: 190_000, size: 200_000 } }), override).message,
    /^문맥 사용률이 90% 이상이라 예외로도 이어갈 수 없습니다\./)

  const off = assessOff({ ...base, usage: usageWith(190_000, 'unavailable') })
  assert.equal(off.resumeAllowed, true, '응급 OFF에서는 미확인 포화도 이어가기를 막지 않는다.')
  assert.equal(off.contextOverrideEligible, false)
})

test('확인되지 않은 사용량에서는 실행 턴 수와 연속 재사용을 주의 신호로 다시 쓴다', () => {
  const longConversation = { ...base, conversationTurnCount: 85, consecutiveResumeCount: 6 }
  const legacy = assessAiConversationContextHealth({ ...longConversation, usage: { used: 20_000, size: 200_000 } })
  const pending = assessAiConversationContextHealth({ ...longConversation, usage: usageWith(20_000, 'pending') })
  assert.equal(legacy.state, 'healthy', '확인된 낮은 사용률이면 길이 신호를 쓰지 않는다.')
  assert.equal(pending.state, 'caution')
  assert.equal(pending.resumeAllowed, true)
  assert.deepEqual(pending.reasonCodes, [
    'CONVERSATION_TURN_COUNT_HIGH',
    'CONVERSATION_RESUME_STREAK_CAUTION',
    'CONVERSATION_CONTEXT_USAGE_UNCONFIRMED',
  ])
})

test('알 수 없는 확인 상태는 미확인으로 다루고 사용량 수치가 없으면 기존 판정을 유지한다', () => {
  const unknownStatus = assessAiConversationContextHealth({ ...base, usage: usageWith(20_000, 'estimated', { updated_at: 'x' }) })
  assert.equal(unknownStatus.state, 'unverified')
  assert.equal(unknownStatus.metrics.contextUsageStatus, 'estimated')
  assert.equal(unknownStatus.metrics.contextUsageUpdatedAt, null)
  assert.match(unknownStatus.reasons[0].message, /^문맥 사용량의 확인 상태를 알 수 없습니다\(estimated\)\./)
  assert.doesNotMatch(unknownStatus.reasons[0].message, /마지막 확인 시각/)

  const legacyEmpty = assessAiConversationContextHealth({ ...base, usage: {} })
  const pendingEmpty = assessAiConversationContextHealth({ ...base, usage: { _meta: usageWith(null, 'pending')._meta } })
  assert.equal(pendingEmpty.state, legacyEmpty.state)
  assert.deepEqual(pendingEmpty.reasonCodes, legacyEmpty.reasonCodes)
  assert.equal(pendingEmpty.metrics.contextUsageStatus, 'pending')

  const malformed = assessAiConversationContextHealth({ ...base, usage: { used: 20_000, size: 200_000, _meta: { 'aionui/contextUsage': ['pending'] } } })
  assert.equal(malformed.state, 'healthy', '형식이 맞지 않는 확장은 없는 것으로 본다.')
  assert.equal(malformed.metrics.contextUsageStatus, null)
  const farFuture = assessAiConversationContextHealth({ ...base, usage: usageWith(20_000, 'current', { updated_at: 9e15 }) })
  assert.equal(farFuture.metrics.contextUsageUpdatedAt, null)
})

test('사용량 확인 상태가 바뀌면 같은 수치라도 평가 ID가 달라진다', () => {
  const pending = assessAiConversationContextHealth({ ...base, usage: usageWith(20_000, 'pending') })
  const current = assessAiConversationContextHealth({ ...base, usage: usageWith(20_000, 'current') })
  const unavailable = assessAiConversationContextHealth({ ...base, usage: usageWith(20_000, 'unavailable', { reason: 'not_reported' }) })
  assert.notEqual(pending.assessmentId, current.assessmentId)
  assert.notEqual(pending.assessmentId, unavailable.assessmentId)
  assert.notEqual(current.assessmentId, unavailable.assessmentId)
})
