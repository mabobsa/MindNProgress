import assert from 'node:assert/strict'
import test from 'node:test'
import { applyAiConversationDelegationModelPolicy, assessAiConversationContextHealth, isAiDelegationModelBlocked } from '../server/lib/aiConversationContextHealth.mjs'

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

test('GPT-5.6-Sol로 기록되었거나 현재 사용하는 대화는 문맥이 건강해도 새 위임에 이어 쓰지 않는다', () => {
  const healthy = assessAiConversationContextHealth(base)
  const recorded = applyAiConversationDelegationModelPolicy(healthy, { linkedModelId: 'gpt-5.6-sol', runtimeModelId: 'gpt-6-sol' })
  const current = applyAiConversationDelegationModelPolicy(healthy, { linkedModelId: 'gpt-6-sol', runtimeModelId: 'GPT-5.6-Sol[1m]' })
  const other = applyAiConversationDelegationModelPolicy(healthy, { linkedModelId: 'gpt-6-sol', runtimeModelId: 'gpt-6-sol' })
  assert.equal(recorded.state, 'healthy')
  assert.equal(recorded.resumeAllowed, false)
  assert.equal(current.resumeAllowed, false)
  assert.equal(recorded.recommendation, 'new')
  assert.ok(recorded.reasonCodes.includes('CONVERSATION_MODEL_REUSE_BLOCKED'))
  assert.equal(other.resumeAllowed, true)
  assert.notEqual(recorded.assessmentId, current.assessmentId)
  assert.notEqual(other.assessmentId, healthy.assessmentId)
  assert.equal(isAiDelegationModelBlocked('gpt-5.6-sol'), true)
  assert.equal(isAiDelegationModelBlocked('gpt-5.6-solution'), false)
})
