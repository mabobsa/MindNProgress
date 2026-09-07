import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aiConversationIdsFromData,
  aiConversationLinkFromAionUiConversation,
  aiConversationLinksFromData,
  aggregateAiConversationRuntime,
  appendAiConversationLink,
  isAiConversationLinked,
  normalizeAiConversationLink,
  removeAiConversationLink,
} from '../src/utils/aiConversations.mjs'

test('기존 단일 대화 ID를 정보가 없는 연결 이력으로 호환한다', () => {
  assert.deepEqual(aiConversationLinksFromData({ aiConversationId: 'conversation-legacy' }), [{
    conversationId: 'conversation-legacy',
    skills: [],
    mcpServers: [],
  }])
})

test('대화가 생성된 머신 ID를 정규화하고 올바르지 않은 값은 버린다', () => {
  assert.equal(normalizeAiConversationLink({
    conversationId: 'conversation-on-sub',
    homeMachineId: 'MacBook-Pro',
  }).homeMachineId, 'macbook-pro')
  assert.equal(normalizeAiConversationLink({
    conversationId: 'conversation-on-main',
    homeMachineId: '../other-machine',
  }).homeMachineId, undefined)
})

test('새 대화를 추가해도 기존 대화와 시작 옵션을 유지한다', () => {
  const existing = {
    aiConversationId: 'conversation-first',
    aiConversations: [{
      conversationId: 'conversation-first',
      agent: { id: 'claude', label: 'Claude Code' },
      model: { id: 'opus', label: 'Opus' },
      skills: [],
      mcpServers: [],
      linkedAt: '2026-08-10T00:00:00.000Z',
    }],
  }
  const links = appendAiConversationLink(existing, {
    conversationId: 'conversation-second',
    agent: { id: 'codex', label: 'Codex CLI' },
    model: { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    thoughtLevel: { id: 'xhigh', label: 'xhigh' },
    skills: [{ id: 'mnp-dooray', label: 'mnp-dooray' }],
    mcpServers: [{ id: 'mindnprogress', label: 'MindNProgress' }],
    linkedAt: '2026-08-10T01:00:00.000Z',
  })
  assert.deepEqual(links.map((link) => link.conversationId), ['conversation-first', 'conversation-second'])
  assert.equal(links[1].thoughtLevel.label, 'xhigh')
  assert.equal(links[1].skills[0].label, 'mnp-dooray')
})

test('중복과 올바르지 않은 대화 이력을 정리하고 연결 여부를 판단한다', () => {
  const data = {
    aiConversationId: 'conversation-latest',
    aiConversations: [
      { conversationId: 'conversation-old', skills: [], mcpServers: [] },
      { conversationId: 'conversation-old', skills: [], mcpServers: [] },
      { conversationId: '../invalid', skills: [], mcpServers: [] },
    ],
  }
  assert.deepEqual(aiConversationIdsFromData(data), ['conversation-old', 'conversation-latest'])
  assert.equal(isAiConversationLinked(data, 'conversation-old'), true)
  assert.equal(isAiConversationLinked(data, 'missing'), false)
  assert.equal(normalizeAiConversationLink({ conversationId: '../invalid' }), null)
})

test('찾을 수 없는 대화 연결만 제거하고 남은 최신 대화를 유지한다', () => {
  const data = {
    aiConversationId: 'conversation-missing',
    aiConversations: [
      { conversationId: 'conversation-first', skills: [], mcpServers: [], linkedAt: '2026-08-10T00:00:00.000Z' },
      { conversationId: 'conversation-missing', skills: [], mcpServers: [], linkedAt: '2026-08-10T01:00:00.000Z' },
    ],
  }
  const links = removeAiConversationLink(data, 'conversation-missing')
  assert.deepEqual(links.map((link) => link.conversationId), ['conversation-first'])
  assert.equal(links.at(-1)?.conversationId, 'conversation-first')
})

test('여러 대화 중 작업 중인 상태를 카드 대표 상태로 집계한다', () => {
  const runtime = aggregateAiConversationRuntime([
    { conversationId: 'idle', state: 'idle', isProcessing: false, pendingConfirmations: 0, turnId: null, observedAt: '2026-08-10T00:00:00.000Z' },
    { conversationId: 'waiting', state: 'waiting-confirmation', isProcessing: false, pendingConfirmations: 1, turnId: null, observedAt: '2026-08-10T00:00:00.000Z' },
    { conversationId: 'running', state: 'running', isProcessing: true, pendingConfirmations: 0, turnId: 'turn-1', observedAt: '2026-08-10T00:00:00.000Z' },
  ])
  assert.equal(runtime.state, 'running')
  assert.equal(runtime.conversationId, 'running')
  assert.equal(runtime.conversationCount, 3)
  assert.deepEqual(runtime.activeConversationIds, ['waiting', 'running'])
  assert.equal(runtime.pendingConfirmations, 1)
})

test('기존 대화는 AionUi 세션 정보에서 시작 옵션을 복원한다', () => {
  const link = aiConversationLinkFromAionUiConversation({
    id: 'conversation-legacy',
    created_at: '2026-08-10T07:00:00.000Z',
    assistant: { id: 'bare:claude-agent', name: 'Claude Code' },
    extra: {
      agent_id: 'claude-agent',
      current_model_id: 'opus[1m]',
      thought_level: 'high',
      current_mode_id: 'bypassPermissions',
      workspace: 'C:\\Git\\MindNProgress',
      skills: ['mnp-dooray'],
      mcp_server_ids: 'mcp-mindnprogress',
      mcp_servers: 'MindNProgress',
    },
  })

  assert.equal(link.agent.label, 'Claude Code')
  assert.equal(link.model.id, 'opus[1m]')
  assert.equal(link.thoughtLevel.id, 'high')
  assert.equal(link.mode.id, 'bypassPermissions')
  assert.equal(link.workspace, 'C:\\Git\\MindNProgress')
  assert.deepEqual(link.skills, [{ id: 'mnp-dooray', label: 'mnp-dooray' }])
  assert.deepEqual(link.mcpServers, [{ id: 'mcp-mindnprogress', label: 'MindNProgress' }])
})
