import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiConversationRemoval, ensureConversationArchived } from '../server/lib/aiConversationRemoval.mjs'

function fixture() {
  const f = { linked: true, archived: false, exists: true, events: [], locked: false, machineId: 'main' }
  const dependencies = {
    readContext: async () => ({ machineId: f.machineId, link: f.linked ? { conversationId: 'chat' } : undefined }),
    assertSafe: async () => { if (f.busy) throw Error('위임 처리 중') },
    call: async (machine, pathname, options = {}) => {
      assert.equal(f.locked, false, 'Aion 대기 중에는 문서 변경 잠금을 잡지 않는다')
      assert.equal(machine, 'main')
      f.events.push(options.method === 'POST' ? 'archive' : 'read-state')
      if (options.method === 'POST') {
        assert.equal(options.noMutationRetry, true)
        if (!f.archiveRejected) f.archived = true
        if (f.onArchive) await f.onArchive()
        if (f.lostResponse) throw Error('응답 유실')
      } else {
        if (f.readError) throw f.readError
        return { conversation_id: 'chat', exists: f.exists, archived_at: f.archived ? 123 : null }
      }
    },
    assertIdle: async () => { f.events.push('idle'); if (f.running) throw Error('실행 중') },
    acquireMutation: async () => { f.locked = true; return () => { f.locked = false } },
    unlink: async () => {
      assert.equal(f.locked, true)
      if (f.saveFails) throw Error('저장 실패')
      f.events.push('unlink')
      f.linked = false
      return { latestConversationId: null }
    },
  }
  f.service = createAiConversationRemoval(dependencies)
  f.remove = () => f.service.remove({ id: 'user' }, 'map-test', 'root', 'chat')
  return f
}

test('보관 요청 뒤 저장 상태를 확인한 후에만 연결을 삭제한다', async () => {
  const f = fixture()
  assert.equal((await f.remove()).archiveState, 'archived')
  assert.deepEqual(f.events, ['read-state', 'idle', 'archive', 'read-state', 'unlink'])
})

test('이미 보관된 대화와 명시적으로 부재인 대화는 보관 요청을 반복하지 않는다', async () => {
  for (const kind of ['archived', 'missing']) {
    const f = fixture()
    if (kind === 'archived') f.archived = true
    else f.exists = false
    assert.equal((await f.remove()).archiveState, kind)
    assert.equal(f.events.includes('archive'), false)
    assert.equal(f.linked, false)
  }
})

test('보관 응답 유실 뒤 실제 보관이 확인되면 연결 삭제를 완료한다', async () => {
  const f = fixture()
  f.lostResponse = true
  await f.remove()
  assert.equal(f.linked, false)
  assert.equal(f.events.filter((event) => event === 'archive').length, 1)
})

test('보관 미반영, 실행 중, 위임 처리 중이면 연결을 남긴다', async () => {
  for (const reason of ['archiveRejected', 'running', 'busy']) {
    const f = fixture()
    f[reason] = true
    await assert.rejects(f.remove())
    assert.equal(f.linked, true)
    assert.equal(f.service.isRemoving('chat'), false)
    if (reason !== 'archiveRejected') assert.equal(f.events.includes('archive'), false)
  }
})

test('404·권한 오류·타임아웃은 대화 부재로 취급하지 않는다', async () => {
  for (const status of [404, 401, 403, 500, undefined]) {
    const f = fixture()
    f.readError = Object.assign(Error('조회 실패'), { status })
    await assert.rejects(f.remove(), /조회 실패/)
    assert.equal(f.linked, true)
    assert.deepEqual(f.events, ['read-state'])
  }
})

test('잘못된 보관 응답은 삭제 증거로 사용할 수 없다', async () => {
  for (const state of [null, {}, { conversation_id: 'other', exists: false, archived_at: null },
    { conversation_id: 'chat', exists: false }, { conversation_id: 'chat', exists: false, archived_at: 1 },
    { conversation_id: 'chat', exists: true, archived_at: '123' }]) {
    await assert.rejects(ensureConversationArchived({ conversationId: 'chat',
      call: async () => state, assertIdle: async () => assert.fail('잘못된 상태에서는 실행 조회도 진행하지 않는다'),
    }), { code: 'AIONUI_ARCHIVE_STATE_INVALID' })
  }
})

test('보관 후 재조회가 실패하면 연결을 남겨 재시도할 수 있다', async () => {
  const f = fixture()
  f.onArchive = async () => { f.readError = Error('재조회 실패') }
  await assert.rejects(f.remove(), /재조회 실패/)
  assert.equal(f.archived, true)
  assert.equal(f.linked, true)
  f.readError = null
  await f.remove()
  assert.equal(f.events.filter((event) => event === 'archive').length, 1)
})

test('MnP 저장 실패 재시도는 보관을 반복하지 않고 최신 연결을 정리한다', async () => {
  const f = fixture()
  f.saveFails = true
  await assert.rejects(f.remove(), /저장 실패/)
  assert.equal(f.locked, false)
  f.saveFails = false
  await f.remove()
  const beforeRetry = f.events.length
  assert.equal((await f.remove()).archiveState, 'unlinked')
  assert.deepEqual(f.events.slice(beforeRetry), ['unlink'])
  assert.equal(f.events.filter((event) => event === 'archive').length, 1)
})

test('동시 삭제 요청은 중복 보관하지 않고 기존 작업의 결과를 기다리도록 알린다', async () => {
  const f = fixture()
  let resume
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  f.onArchive = () => { entered(); return new Promise((resolve) => { resume = resolve }) }
  const first = f.remove()
  await started
  assert.equal(f.service.isRemoving('chat'), true)
  await assert.rejects(f.remove(), /처리 중/)
  resume()
  await first
  assert.equal(f.service.isRemoving('chat'), false)
})

test('외부 확인 중 새 위임 또는 머신 변경이 생기면 최신 연결을 보존한다', async () => {
  for (const change of ['busy', 'machine']) {
    const f = fixture()
    f.onArchive = async () => { if (change === 'busy') f.busy = true; else f.machineId = 'other' }
    await assert.rejects(f.remove(), change === 'busy' ? /위임 처리 중/ : /연결이 변경/)
    assert.equal(f.linked, true)
    assert.equal(f.locked, false)
  }
})
