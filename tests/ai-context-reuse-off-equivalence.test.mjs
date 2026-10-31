import assert from 'node:assert/strict'
import test from 'node:test'
import * as current from '../server/lib/aiConversationContextHealth.mjs'
import * as currentSelection from '../mcp/aiConversationSelectionPolicy.mjs'
import * as legacy from './fixtures/legacy-131eace/aiConversationContextHealth.mjs'
import * as legacySelection from './fixtures/legacy-131eace/aiConversationSelectionPolicy.mjs'

// 문맥 기준 재사용 개선(77581d7·f93cfc1) 코드를 남긴 채 스위치를 끄고 운영한다(2026-10-31 사용자 결정).
// OFF일 때 판정 결과와 선택 안내가 개선 전(131eace) 원문과 직렬화까지 같은지 확인한다.
// 초기 안내 기준선(initial-guidance-restoration)과 도구 스키마 스냅샷(mcp-instruction-surface)은 기존 테스트가 같은 원문으로 확인한다.

const off = { contextReuseGuardEnabled: false }
const observedAt = '2026-10-31T00:00:00.000Z'

const freshness = (status, extra = {}) => ({
  'aionui/contextUsage': {
    status, turn_id: 'turn-1', updated_at: 1_793_400_000_000, status_changed_at: 1_793_400_000_100, reason: null, ...extra,
  },
})

function* usages() {
  yield undefined
  yield null
  yield {}
  yield { used: 20_000 }
  yield { used: 20_000, size: 0 }
  yield { used: '30000', size: '200000' }
  yield { _meta: freshness('pending') }
  for (const ratio of [0, 0.1, 0.5, 0.649, 0.65, 0.79, 0.8, 0.85, 0.899, 0.9, 0.95, 1.2]) {
    const usage = { used: Math.round(ratio * 1_000_000), size: 1_000_000 }
    yield usage
    for (const meta of [
      freshness('current'),
      freshness('pending'),
      freshness('unavailable', { reason: 'timed_out' }),
      freshness('estimated', { updated_at: 'x' }),
      { 'aionui/contextUsage': ['pending'] },
    ]) yield { ...usage, _meta: meta }
  }
}

const histories = [
  {},
  { conversationTurnCount: 10, conversationTurnCountExact: true },
  { conversationTurnCount: 45, conversationTurnCountExact: false, historyComplete: true },
  { conversationTurnCount: 85, conversationTurnCountExact: true, consecutiveResumeCount: 6, delegationCount: 3 },
  { conversationTurnCount: 5, conversationTurnCountExact: false, historyComplete: false },
  { messageCount: 90, messageCountExact: true, consecutiveResumeCount: 12, eventCount: 400, eventCountExact: true, toolCallCount: 120 },
]

const modelCases = [
  {},
  { linkedModelId: 'gpt-6-sol' },
  { runtimeModelId: 'GPT-5.6-Sol[1m]' },
  { linkedModelId: 'gpt-6.1-sol', runtimeModelId: 'claude-opus-5-5' },
]

function* inputs() {
  for (const usage of usages()) {
    for (const history of histories) {
      yield { conversationId: 'conversation-a', modifiedAt: '2026-10-30T00:00:00.000Z', usage, ...history }
    }
  }
}

test('문맥 기준 재사용 스위치는 OFF다', () => {
  assert.equal(current.AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED, false,
    '다시 켤 때는 docs/ai-conversation-context-reuse.md의 재활성화 절차를 따른다.')
})

test('OFF 판정 결과는 개선 전과 직렬화까지 같다', () => {
  let count = 0
  for (const input of inputs()) {
    const label = JSON.stringify(input)
    assert.equal(JSON.stringify(current.assessAiConversationContextHealth(input, observedAt, off)),
      JSON.stringify(legacy.assessAiConversationContextHealth(input, observedAt, off)), label)
    assert.equal(JSON.stringify(current.assessAiConversationContextHealth(input, observedAt)),
      JSON.stringify(legacy.assessAiConversationContextHealth(input, observedAt)), label)
    count += 1
  }
  assert.ok(count >= 400, `비교한 입력 수: ${count}`)
})

test('OFF 금지 모델 판정은 개선 전과 직렬화까지 같다', () => {
  for (const input of inputs()) {
    for (const models of modelCases) {
      const expected = legacy.applyAiConversationDelegationModelPolicy(legacy.assessAiConversationContextHealth(input, observedAt, off), models)
      const actual = current.applyAiConversationDelegationModelPolicy(current.assessAiConversationContextHealth(input, observedAt, off), models)
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), JSON.stringify({ input, models }))
    }
  }
})

test('OFF 이어가기 허용 여부와 거절 메시지는 개선 전 판정 그대로다', () => {
  // 개선 전 서버는 resumeAllowed만으로 409를 정하고 contextHealth.message를 돌려줬다.
  // OFF 서버는 요청의 contextOverride를 받지 않으므로 예외 없이(null) 같은 결정을 내려야 한다.
  for (const input of inputs()) {
    for (const models of modelCases) {
      const health = current.applyAiConversationDelegationModelPolicy(current.assessAiConversationContextHealth(input, observedAt, off), models)
      const decision = current.resolveAiConversationContextOverride(health, null)
      assert.equal(decision.allowed, health.resumeAllowed)
      assert.equal(decision.message, health.message)
      assert.equal(decision.contextOverride, null)
      if (!decision.allowed) assert.equal(decision.code, 'MODEL_BLOCKED')
    }
  }
})

test('OFF 선택 안내와 선택 규칙은 개선 전 원문과 같다', () => {
  assert.equal(currentSelection.AI_CONVERSATION_SELECTION_INSTRUCTION, legacySelection.AI_CONVERSATION_SELECTION_INSTRUCTION)
  assert.equal(currentSelection.aiConversationSelectionInstruction(off), legacySelection.aiConversationSelectionInstruction(off))
  assert.equal(JSON.stringify(currentSelection.aiConversationSelectionRules()), JSON.stringify(legacySelection.aiConversationSelectionRules()))
  assert.equal(JSON.stringify(currentSelection.aiConversationSelectionRules(off)), JSON.stringify(legacySelection.aiConversationSelectionRules(off)))
})
