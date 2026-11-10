import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { aiConversationLinksFromData, normalizeAiConversationLink, primaryAiConversationIdFromData, withAiConversationLink } from '../src/utils/aiConversations.mjs'

// 외부 전송 후 저장 경계에 최신 문서 상태를 주입하여 실제 서버의 연결 함수를 검증한다.
const server = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const start = server.indexOf('async function linkAiDelegationConversation(')
const end = server.indexOf('async function dispatchPreparedAiDelegation(', start)
assert.ok(start > 0 && end > start)
const source = server.slice(start, end)
const createdAt = '2026-11-08T00:00:00.000Z'
const link = (conversationId) => ({ conversationId, startedAt: createdAt, linkedAt: createdAt })
const original = { id: 'map-test', version: 1, title: '담당 저장 검증', nodes: [{ id: 'child', data: {
  aiPrimaryConversationId: 'old', aiConversationId: 'human', aiConversations: ['old', 'target', 'human'].map(link), description: '원래 설명',
} }], edges: [] }

function harness(currentPrimary, { removeTarget = false } = {}) {
  let current = structuredClone(original)
  current.version = 2
  Object.assign(current.nodes[0].data, { aiPrimaryConversationId: currentPrimary, description: '전송 대기 중 수정한 설명' })
  if (removeTarget) current.nodes[0].data.aiConversations = current.nodes[0].data.aiConversations.filter(item => item.conversationId !== 'target')
  const events = []
  let saves = 0
  let locked = false
  const execute = vm.runInNewContext(source + '\nlinkAiDelegationConversation', {
    aiConversationLinksFromData, normalizeAiConversationLink, primaryAiConversationIdFromData, withAiConversationLink,
    users: [{ id: 'editor', name: '편집자' }], console: { warn() {} },
    documentReconstruction: { assertWritable() { assert.ok(locked) } },
    withDocument: async (_id, action) => { locked = true; try { return await action() } finally { locked = false } },
    readMap: async () => structuredClone(current),
    saveMap: async (_id, content, _user, _title, _color, _kind, { expectedVersion }) => {
      assert.ok(locked)
      assert.equal(expectedVersion, current.version, '전송 전 버전이 아닌 최신 문서 버전으로 저장한다')
      saves++
      current = { ...current, ...structuredClone(content), version: current.version + 1 }
      return structuredClone(current)
    },
    publicUser: user => user, broadcastEvent: event => events.push(event),
  })
  return {
    current: () => current, saves: () => saves, events,
    run: strategy => execute({ map: original, targetCard: original.nodes[0], strategy,
      targetConversationId: strategy === 'new' ? 'created' : 'target', primarySelection: { expectedConversationId: 'old' },
      selection: { agent: { id: 'codex', label: 'Codex' }, model: { id: 'gpt-6.1-sol', label: 'Sol' }, enabledSkillIds: [], mcpIds: [] },
      user: { id: 'editor' }, startedAt: '2026-11-11T00:00:00.000Z' }),
  }
}

for (const strategy of ['resume', 'new']) for (const primary of ['human', null]) {
  test(`${strategy} 전송 중 사용자가 담당을 ${primary ? '교체' : '해제'}해도 그 선택과 최신 본문을 보존한다`, async () => {
    const state = harness(primary)
    const result = await state.run(strategy)
    assert.match(result.linkError, /담당이 변경/)
    const data = state.current().nodes[0].data
    assert.equal(data.aiPrimaryConversationId, primary)
    assert.equal(data.description, '전송 대기 중 수정한 설명')
    assert.equal(state.saves(), strategy === 'new' ? 1 : 0)
    assert.equal(data.aiConversations.length, strategy === 'new' ? 4 : 3)
    assert.ok(data.aiConversations.some(item => item.conversationId === (strategy === 'new' ? 'created' : 'target')))
  })
}

test('기존 대화를 담당으로 승격해도 생성 시각·최신 대화·동시에 수정한 본문은 보존한다', async () => {
  const state = harness('old')
  assert.equal((await state.run('resume')).linkError, null)
  const data = state.current().nodes[0].data
  assert.equal(data.aiPrimaryConversationId, 'target')
  assert.equal(data.aiConversationId, 'human')
  assert.equal(data.aiConversations.find(item => item.conversationId === 'target').startedAt, createdAt)
  assert.equal(data.description, '전송 대기 중 수정한 설명')
  assert.equal(state.saves(), 1)
  assert.equal(state.events.length, 1)
})

test('전송 중 해제된 카드 연결을 되살려 담당으로 저장하지 않는다', async () => {
  const state = harness('old', { removeTarget: true })
  assert.match((await state.run('resume')).linkError, /저장하지 못했습니다/)
  assert.equal(state.saves(), 0)
  assert.equal(state.current().nodes[0].data.aiPrimaryConversationId, 'old')
})
