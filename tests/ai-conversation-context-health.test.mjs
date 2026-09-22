import assert from 'node:assert/strict'
import test from 'node:test'
import { assessAiConversationContextHealth } from '../server/lib/aiConversationContextHealth.mjs'

const base = {
  conversationId: 'conversation-a',
  modifiedAt: '2026-09-22T00:00:00.000Z',
  runtimeState: 'idle',
  usage: { used: 20_000, size: 200_000 },
  messageCount: 20,
  messageCountExact: true,
  delegationCount: 1,
  consecutiveResumeCount: 1,
}

test('짧고 사용량이 낮은 대화는 같은 업무 후속 작업의 이어가기를 허용한다', () => {
  const result = assessAiConversationContextHealth(base, '2026-09-22T01:00:00.000Z')
  assert.equal(result.state, 'healthy')
  assert.equal(result.recommendation, 'resume')
  assert.equal(result.resumeAllowed, true)
  assert.equal(result.metrics.contextUsageRatio, 0.1)
})

test('메시지 200개와 연속 이어가기 12회인 대화는 새 대화를 강제한다', () => {
  const result = assessAiConversationContextHealth({
    ...base,
    usage: { used: 0, size: 0 },
    messageCount: 200,
    messageCountExact: false,
    delegationCount: 13,
    consecutiveResumeCount: 12,
  })
  assert.equal(result.state, 'saturated')
  assert.equal(result.recommendation, 'new')
  assert.equal(result.resumeAllowed, false)
  assert.deepEqual(result.reasonCodes, [
    'CONVERSATION_MESSAGE_COUNT_HIGH',
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

test('메시지 이력을 확인하지 못한 대화는 안전하게 새 대화를 요구한다', () => {
  const result = assessAiConversationContextHealth({ ...base, messageCount: null, messageCountExact: false })
  assert.equal(result.state, 'unknown')
  assert.equal(result.resumeAllowed, false)
  assert.deepEqual(result.reasonCodes, ['CONVERSATION_CONTEXT_HEALTH_UNAVAILABLE'])
})

test('평가 ID는 관측 시각이 아니라 대화 변경과 객관적 지표에만 반응한다', () => {
  const first = assessAiConversationContextHealth(base, '2026-09-22T01:00:00.000Z')
  const second = assessAiConversationContextHealth(base, '2026-09-22T02:00:00.000Z')
  const changed = assessAiConversationContextHealth({ ...base, messageCount: 21 }, '2026-09-22T02:00:00.000Z')
  assert.equal(first.assessmentId, second.assessmentId)
  assert.equal(first.assessmentId, assessAiConversationContextHealth({
    ...base,
    runtimeState: 'running',
  }, '2026-09-22T02:00:00.000Z').assessmentId)
  assert.notEqual(first.assessmentId, changed.assessmentId)
})
