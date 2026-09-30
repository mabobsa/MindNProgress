import assert from 'node:assert/strict'
import test from 'node:test'
import { assessAiConversationContextHealth } from '../server/lib/aiConversationContextHealth.mjs'
import { summarizeAiConversationMessages } from '../server/lib/aiConversationMessageStatistics.mjs'

function event(id, type, position, backendTurnId) {
  return { id, type, position, backend_turn_id: backendTurnId }
}

test('한 실행 턴의 도구 이벤트 183개는 대화 200턴으로 계산하지 않는다', () => {
  const items = [
    ...Array.from({ length: 16 }, (_, index) => event(`assistant-${index}`, 'text', 'left', 'turn-1')),
    event('user-1', 'text', 'right', 'turn-1'),
    ...Array.from({ length: 183 }, (_, index) => event(`tool-${index}`, 'tool_call', 'left', 'turn-1')),
  ]
  const statistics = summarizeAiConversationMessages(items, { historyComplete: false, pageCount: 1 })
  assert.equal(statistics.eventCount, 200)
  assert.equal(statistics.textMessageCount, 17)
  assert.equal(statistics.toolCallCount, 183)
  assert.equal(statistics.backendTurnCount, 1)
  assert.equal(statistics.conversationTurnCount, 1)
  assert.equal(statistics.conversationTurnCountExact, false)

  const health = assessAiConversationContextHealth({
    conversationId: 'conversation-tool-heavy',
    runtimeState: 'idle',
    usage: { used: 86_970 },
    ...statistics,
  })
  assert.equal(health.state, 'healthy')
  assert.equal(health.recommendation, 'resume')
  assert.equal(health.resumeAllowed, true)
  assert.equal(health.metrics.estimatedContextSize, 200_000)
  assert.equal(health.metrics.estimatedContextUsageRatio, 86_970 / 200_000)
  assert.deepEqual(health.reasonCodes, ['CONVERSATION_HISTORY_INCOMPLETE'])
})

test('여러 페이지의 중복 이벤트를 제거하고 실제 backend 실행 턴을 센다', () => {
  const statistics = summarizeAiConversationMessages([
    event('user-1', 'text', 'right', 'turn-1'),
    event('tool-1', 'acp_tool_call', 'left', 'turn-1'),
    event('assistant-1', 'text', 'left', 'turn-1'),
    event('assistant-1', 'text', 'left', 'turn-1'),
    event('user-2', 'text', 'right', 'turn-2'),
    event('assistant-2', 'text', 'left', 'turn-2'),
  ], { historyComplete: true, pageCount: 2 })
  assert.equal(statistics.eventCount, 5)
  assert.equal(statistics.conversationTurnCount, 2)
  assert.equal(statistics.userMessageCount, 2)
  assert.equal(statistics.historyComplete, true)
  assert.equal(statistics.pageCount, 2)
})

test('서로 다른 backend 실행 턴 80개는 사용량을 알 수 없을 때 포화 기준에 도달한다', () => {
  const statistics = summarizeAiConversationMessages(
    Array.from({ length: 80 }, (_, index) => event(`assistant-${index}`, 'text', 'left', `turn-${index}`)),
    { historyComplete: true },
  )
  const health = assessAiConversationContextHealth({
    conversationId: 'conversation-long',
    runtimeState: 'idle',
    usage: {},
    ...statistics,
  })
  assert.equal(health.state, 'saturated')
  assert.deepEqual(health.reasonCodes, ['CONVERSATION_TURN_COUNT_HIGH'])
})

test('전체 문맥 크기가 없으면 보수적인 200K 기준의 80%부터 이어가기를 차단한다', () => {
  const health = assessAiConversationContextHealth({
    conversationId: 'conversation-large-usage',
    runtimeState: 'idle',
    usage: { used: 160_000 },
    conversationTurnCount: 2,
    conversationTurnCountExact: true,
  })
  assert.equal(health.state, 'saturated')
  assert.equal(health.resumeAllowed, false)
  assert.deepEqual(health.reasonCodes, ['CONVERSATION_CONTEXT_USED_HIGH'])
})
