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
  assert.equal(health.state, 'unverified')
  assert.equal(health.recommendation, 'resume')
  assert.equal(health.resumeAllowed, true)
  assert.equal(health.metrics.estimatedContextSize, null)
  assert.equal(health.metrics.estimatedContextUsageRatio, null)
  assert.deepEqual(health.reasonCodes, [
    'CONVERSATION_HISTORY_INCOMPLETE',
    'CONVERSATION_CONTEXT_SIZE_UNKNOWN',
  ])
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

test('도구 결과와 그룹 이벤트는 도구 호출 건수에 더하지 않는다', () => {
  const statistics = summarizeAiConversationMessages([
    event('user', 'text', 'right', 'turn-1'),
    event('call', 'acp_tool_call', 'left', 'turn-1'),
    event('result', 'acp_tool_result', 'left', 'turn-1'),
    event('group', 'tool_group', 'left', 'turn-1'),
  ], { historyComplete: true })
  assert.equal(statistics.eventCount, 4)
  assert.equal(statistics.toolCallCount, 1)
  assert.equal(statistics.otherEventCount, 2)
  assert.equal(statistics.conversationTurnCountExact, true)
})

test('페이지가 완전해도 실행 턴 ID가 없는 이벤트가 있으면 턴 수를 정확하다고 표시하지 않는다', () => {
  const statistics = summarizeAiConversationMessages([
    event('user-1', 'text', 'right', 'turn-1'),
    event('assistant-1', 'text', 'left', 'turn-1'),
    event('legacy-assistant', 'text', 'left', null),
  ], { historyComplete: true })
  assert.equal(statistics.historyComplete, true)
  assert.equal(statistics.conversationTurnCount, 1)
  assert.equal(statistics.conversationTurnCountExact, false)
  const health = assessAiConversationContextHealth({
    conversationId: 'conversation-mixed-turn-ids',
    usage: { used: 10_000, size: 200_000 },
    ...statistics,
  })
  assert.equal(health.metrics.historyComplete, true)
  assert.equal(health.metrics.conversationTurnCountExact, false)
  assert.deepEqual(health.reasonCodes, ['CONVERSATION_TURN_ATTRIBUTION_INCOMPLETE'])
})

test('막 생성된 대화의 첫 메시지에 턴 ID와 사용량이 없어도 새 대화를 권장하지 않는다', () => {
  const statistics = summarizeAiConversationMessages([
    event('user-1', 'text', 'right', null),
  ], { historyComplete: true })
  const health = assessAiConversationContextHealth({
    conversationId: 'conversation-new',
    usage: {},
    ...statistics,
  })
  assert.equal(statistics.conversationTurnCount, 1)
  assert.equal(statistics.conversationTurnCountExact, false)
  assert.equal(health.state, 'unverified')
  assert.equal(health.recommendation, 'resume')
  assert.equal(health.resumeAllowed, true)
  assert.deepEqual(health.reasonCodes, ['CONVERSATION_TURN_ATTRIBUTION_INCOMPLETE'])
  assert.match(health.message, /문맥 사용량이 아직 보고되지 않았고/)
})

test('서로 다른 backend 실행 턴 80개도 사용량을 모르면 주의 신호일 뿐 포화 확정은 아니다', () => {
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
  assert.equal(health.state, 'caution')
  assert.equal(health.resumeAllowed, true)
  assert.deepEqual(health.reasonCodes, ['CONVERSATION_TURN_COUNT_HIGH'])
})

test('전체 문맥 크기가 없으면 큰 사용량을 임의 비율로 환산해 이어가기를 차단하지 않는다', () => {
  const health = assessAiConversationContextHealth({
    conversationId: 'conversation-large-usage',
    runtimeState: 'idle',
    usage: { used: 188_230 },
    conversationTurnCount: 1,
    conversationTurnCountExact: true,
    eventCount: 269,
    toolCallCount: 250,
  })
  assert.equal(health.state, 'unverified')
  assert.equal(health.resumeAllowed, true)
  assert.equal(health.metrics.contextUsed, 188_230)
  assert.equal(health.metrics.contextSize, null)
  assert.equal(health.metrics.conversationTurnCount, 1)
  assert.equal(health.metrics.eventCount, 269)
  assert.equal(health.metrics.toolCallCount, 250)
  assert.match(health.message, /포화 여부를 검증할 수 없습니다/)
  assert.deepEqual(health.reasonCodes, ['CONVERSATION_CONTEXT_SIZE_UNKNOWN'])
})
