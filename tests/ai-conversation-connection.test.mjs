import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiConversationConnection } from '../server/lib/aiConversationConnection.mjs'

const user = { id: 'editor' }
function fixture() {
  const state = { archivedAt: null, exists: true, calls: [], links: [], binding: null, removing: false,
    machines: [{ machineId: 'main', label: '주 머신', online: true }], time: 1000,
    conversation: { id: 'conversation', name: '다시 연결할 대화', created_at: 1793000000000,
      extra: { workspace: 'C:/Git/Example', agent_id: 'codex', current_model_id: 'model' } },
    unarchive: () => { state.archivedAt = null }, commit: (action) => action() }
  const service = createAiConversationConnection({
    readContext: async () => ({ card: { data: {} } }),
    machinesForUser: () => state.machines, findBinding: async () => state.binding,
    isRemoving: () => state.removing, now: () => state.time,
    withMutation: (_id, action) => state.commit(action),
    link: async (_context, conversation, machineId) => { state.links.push([conversation.id, machineId]); return { linked: true } },
    call: async (machine, path, options) => {
      state.calls.push({ machine, path, options })
      if (path.endsWith('/unarchive')) return state.unarchive()
      if (path.endsWith('/archive-state')) return { conversation_id: 'conversation', exists: state.exists, archived_at: state.archivedAt }
      return structuredClone(state.conversation)
    },
  })
  return { state, service, preview: () => service.preview(user, 'map', 'card', 'conversation'),
    connect: (token) => service.connect(user, 'map', 'card', token) }
}

test('조회는 변경하지 않고 실제 대화 정보와 보관 여부를 제공한다', async () => {
  const f = fixture(); f.state.archivedAt = 123
  const result = await f.preview(), item = result.conversations[0]
  assert.equal(item.name, '다시 연결할 대화')
  assert.equal(item.workspace, 'C:/Git/Example')
  assert.equal(item.createdAt, new Date(1793000000000).toISOString())
  assert.equal(item.archivedAt, 123)
  assert.equal(f.state.calls.some((call) => call.options.method === 'POST'), false)
  assert.deepEqual(f.state.links, [])
  assert.ok(item.previewToken)
})

test('서명·사용자·카드·유효기간이 다른 조회 결과는 연결할 수 없다', async () => {
  const f = fixture(), token = (await f.preview()).conversations[0].previewToken
  await assert.rejects(() => f.connect(token + 'bad'), { code: 'AI_CONVERSATION_PREVIEW_EXPIRED' })
  await assert.rejects(() => f.service.connect({ id: 'other' }, 'map', 'card', token), { code: 'AI_CONVERSATION_PREVIEW_EXPIRED' })
  await assert.rejects(() => f.service.connect(user, 'map', 'other', token), { code: 'AI_CONVERSATION_PREVIEW_EXPIRED' })
  f.state.time += 600_001
  await assert.rejects(() => f.connect(token), { code: 'AI_CONVERSATION_PREVIEW_EXPIRED' })
  assert.equal(f.state.links.length, 0)
})

test('미보관 대화는 실행·보관 변경 없이 연결하고 복원 응답 유실은 상태 조회로 확인한다', async () => {
  const f = fixture()
  await f.connect((await f.preview()).conversations[0].previewToken)
  assert.deepEqual(f.state.links, [['conversation', 'main']])
  assert.equal(f.state.calls.some((call) => call.options.method === 'POST'), false)
  f.state.archivedAt = 123
  const token = (await f.preview()).conversations[0].previewToken
  f.state.unarchive = () => { f.state.archivedAt = null; throw Error('응답 유실') }
  await f.connect(token)
  await f.connect(token)
  assert.equal(f.state.calls.filter((call) => call.options.method === 'POST').length, 1)
  const mutation = f.state.calls.find((call) => call.options.method === 'POST')
  assert.ok(mutation.options.singleTarget && mutation.options.noMutationRetry)
})

test('복원을 확인하지 못하면 MnP 연결을 저장하지 않는다', async () => {
  const f = fixture(); f.state.archivedAt = 123; f.state.unarchive = () => { throw Error('복원 실패') }
  const token = (await f.preview()).conversations[0].previewToken
  await assert.rejects(() => f.connect(token), /복원된 것을 확인하지 못했습니다/)
  assert.equal(f.state.links.length, 0)
})

test('조회 이후 새로 보관되거나 작업공간이 바뀌면 재조회를 요구한다', async () => {
  for (const change of [(state) => { state.archivedAt = 123 }, (state) => { state.conversation.extra.workspace = 'C:/Other' }]) {
    const f = fixture(), token = (await f.preview()).conversations[0].previewToken
    change(f.state)
    await assert.rejects(() => f.connect(token), /다시 조회/)
    assert.equal(f.state.links.length, 0)
    assert.equal(f.state.calls.some((call) => call.options.method === 'POST'), false)
  }
})

test('다른 카드 소속, 접근 권한 변경, 저장 직전 소속 변경을 거부한다', async () => {
  const f = fixture(), token = (await f.preview()).conversations[0].previewToken
  f.state.binding = { mapId: 'other', cardId: 'other' }
  assert.equal((await f.preview()).conversations[0].previewToken, null)
  await assert.rejects(() => f.connect(token), /다른 카드/)
  f.state.binding = null; f.state.machines = []
  await assert.rejects(() => f.connect(token), { status: 403 })
  f.state.machines = [{ machineId: 'main', label: '주 머신', online: true }]
  f.state.commit = (action) => { f.state.binding = { mapId: 'other' }; return action() }
  await assert.rejects(() => f.connect(token), /다른 카드/)
  assert.equal(f.state.links.length, 0)
})

test('중복 연결과 삭제 경합을 차단하고 실패 뒤에는 다시 시도할 수 있다', async () => {
  const f = fixture(), token = (await f.preview()).conversations[0].previewToken
  f.state.removing = true
  await assert.rejects(() => f.connect(token), /처리 중/)
  f.state.removing = false
  let release, entered
  const waiting = new Promise((resolve) => { entered = resolve })
  f.state.commit = async (action) => { entered(); await new Promise((resolve) => { release = resolve }); return action() }
  const connecting = f.connect(token); await waiting
  assert.ok(f.service.isLinking('conversation'))
  await assert.rejects(() => f.connect(token), /처리 중/)
  release(); await connecting
  assert.equal(f.service.isLinking('conversation'), false)
  assert.equal(f.state.links.length, 1)
})

test('부재·오프라인·조회 실패를 구분하고 여러 머신 후보를 제공한다', async () => {
  const f = fixture()
  f.state.machines.push({ machineId: 'sub', label: '보조 머신', online: true }, { machineId: 'offline', label: '오프라인 머신', online: false })
  let result = await f.preview()
  assert.equal(result.conversations.length, 2)
  assert.equal(result.warnings.length, 1)
  assert.ok(!f.state.calls.some((call) => call.machine === 'offline'))
  f.state.exists = false
  result = await f.preview()
  assert.equal(result.conversations.length, 0)
  f.state.archivedAt = 'invalid'
  result = await f.preview()
  assert.equal(result.warnings.length, 3)
})
