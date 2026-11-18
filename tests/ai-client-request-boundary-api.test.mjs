import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { scryptSync } from 'node:crypto'
import path from 'node:path'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { ensureMainMachine, normalizeMachineRegistry, setMachineToken, upsertSubMachine } from '../server/lib/subMachines.mjs'
import { conversationOwners, integrationIdentityMatches } from '../server/lib/aiAccessPolicy.mjs'

test('통합 대체 신원은 미상으로 취급하고 실제 시작자 기록을 보존한다', () => {
  assert.deepEqual(conversationOwners(undefined, { transient: [{ startedBy: 'pending-owner' }] }), [],
    '대화를 지정하지 않은 요청에 다른 미완료 시작의 귀속을 적용하지 않는다')
  const origins = new Map([['old', { conversationId: 'old', startedBy: 'system-aionui-ai' }]])
  assert.deepEqual(conversationOwners('old', { origins }), [])
  assert.deepEqual(conversationOwners('old', { origins, attributions: [{ conversationId: 'old', startedBy: 'user-editor' }] }), ['user-editor'])
  assert.deepEqual(conversationOwners('old', { origins, attributions: [
    { conversationId: 'old', startedBy: 'user-editor' }, { conversationId: 'old', startedBy: 'other' },
  ] }), ['user-editor', 'other'])
  assert.equal(integrationIdentityMatches({ editorId: 'user-editor', attribution: { startedBy: 'system-aionui-ai' }, owners: ['user-editor'] }), true)
})

test('실제 파일 토큰·Runner 헤더로 세션 메시지와 MCP 연동의 단일 사용자 흐름을 유지한다', { timeout: 120000 }, async (t) => {
  const main = 'isolated-storage'
  const entries = [
    ['main-mine', 'user-editor', main], ['mac-mine', 'user-editor', 'mac'],
    ['main-legacy', null, main], ['mac-legacy', null, 'mac'],
    ['mac-other', 'user-second', 'other-mac'], ['main-system', 'system-aionui-ai', main],
    ['mac-system', 'system-aionui-ai', 'mac'], ['admin-main', 'user-admin', main],
  ]
  const calls = []
  const api = await storageApi(t, { documents: 1, seed: async ({ data, ids }) => {
    const users = JSON.parse(await readFile(path.join(data, '_users.json'), 'utf8'))
    for (const user of users) user.passwordHash = scryptSync('ClientBoundary!2026', user.salt, 64).toString('hex')
    await writeFile(path.join(data, '_users.json'), JSON.stringify(users))
    let registry = ensureMainMachine(normalizeMachineRegistry([]), { machineId: main, label: '메인' })
    for (const [machineId, ownerUserId] of [['mac', 'user-editor'], ['other-mac', 'user-second']]) {
      registry = setMachineToken(upsertSubMachine(registry, { machineId, ownerUserId, label: machineId }), machineId, `${machineId}-test-token`)
    }
    await writeFile(path.join(data, '_machines.json'), JSON.stringify(registry.machines))
    const map = fixture(ids[0])
    const records = entries.map(([conversationId, startedBy, homeMachineId], i) => {
      map.nodes[i].data.aiConversations = [{ conversationId, homeMachineId }]
      map.nodes[i].data.aiConversationId = conversationId
      return { conversationId, startedBy, homeMachineId, mapId: ids[0], cardId: `card-${i}` }
    })
    await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
    await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify(records))
    await writeFile(path.join(data, '_ai-conversation-attributions.json'), JSON.stringify(records.filter(r => r.startedBy).map(r => ({
      ...r, startedBy: r.startedBy === 'system-aionui-ai' ? 'user-editor' : r.startedBy,
      authorName: 'Codex 검증', agentId: 'codex', agentName: 'Codex', modelId: 'fixture', modelName: 'fixture',
    }))))
  }, mockAion: url => {
    calls.push({ machineId: main, pathname: url })
    if (url.includes('/messages')) return { items: [] }
    if (url === '/api/internal/session-messages/remote') return { accepted: true }
    return { id: url.split('/').at(-1), name: '검증 대화', extra: { agent_id: 'codex', current_model_id: 'fixture' } }
  } })
  // AionCore service.rs: 파일 토큰은 Bearer만, Runner는 대화 헤더를 추가한다.
  // AionUi mcpRelay.ts는 Runner 토큰으로 바꾸고 머신 헤더를 붙여 MnP로 전달한다.
  const wire = async (route, { method = 'GET', body, headers = {}, machineId } = {}) => {
    const response = await fetch(api.base + route, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: machineId ? `Bearer ${machineId}-test-token` : api.headers.Authorization,
        ...(machineId ? { 'X-MnP-Runner-MCP-Machine-Id': machineId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  for (const machineId of ['mac', 'other-mac']) {
    assert.equal((await wire(`/api/machines/${machineId}/runner/heartbeat`, { method: 'POST', body: {},
      headers: { Authorization: `Bearer ${machineId}-test-token` } })).status, 200)
  }
  const withMac = async (pending) => {
    let result, failure, done = false
    const tracked = pending.then(r => { result = r }, e => { failure = e }).finally(() => { done = true })
    while (!done) {
      const claimed = await wire('/api/machines/mac/runner/operations/claim', { method: 'POST', body: { waitMs: 100, limit: 16 },
        headers: { Authorization: 'Bearer mac-test-token' } })
      assert.equal(claimed.status, 200)
      for (const operation of claimed.body.operations) {
        calls.push({ machineId: 'mac', ...operation.request })
        const data = operation.request.pathname === '/api/internal/session-messages/remote' ? { accepted: true }
          : operation.request.pathname.includes('/messages') ? { items: [] }
            : { id: operation.request.pathname.split('/').at(-1), name: '맥북 검증', extra: { agent_id: 'codex', current_model_id: 'fixture' } }
        assert.equal((await wire(`/api/machines/mac/runner/operations/${operation.operationId}/result`, {
          method: 'POST', body: { ok: true, data }, headers: { Authorization: 'Bearer mac-test-token', 'X-MnP-Operation-Token': operation.resultToken },
        })).status, 200)
      }
    }
    await tracked
    if (failure) throw failure
    return result
  }
  const send = (from, to, machineId, headers = {}) => wire('/api/integrations/aionui/session-messages', {
    method: 'POST', body: { fromConversationId: from, to, message: '실제 요청 형식 검증' }, machineId,
    headers: { ...(machineId ? { 'X-MNP-AI-Conversation-Id': from } : {}), ...headers },
  })
  await t.test('파일 토큰과 Runner의 알려진 시작자·이전 대화 양방향 전달', async () => {
    for (const [from, to, machineId] of [
      ['main-mine', 'mac-mine'], ['mac-mine', 'main-mine', 'mac'],
      ['main-legacy', 'mac-mine'], ['mac-legacy', 'main-mine', 'mac'],
      ['main-mine', 'mac-legacy'], ['mac-mine', 'main-legacy', 'mac'],
      ['main-legacy', 'mac-legacy'], ['mac-legacy', 'main-legacy', 'mac'],
      ['main-system', 'mac-mine'], ['mac-system', 'main-mine', 'mac'],
    ]) {
      const before = calls.filter(c => c.pathname === '/api/internal/session-messages/remote').length
      const result = machineId ? await send(from, to, machineId) : await withMac(send(from, to))
      assert.equal(result.status, 200, `${from} → ${to}: ${JSON.stringify(result)}`)
      assert.equal(calls.filter(c => c.pathname === '/api/internal/session-messages/remote').length, before + 1)
    }
  })
  await t.test('타인 소유·메인 불허·발신 헤더 위조는 외부 전달 전에 거부한다', async () => {
    const before = calls.filter(c => c.pathname === '/api/internal/session-messages/remote').length
    for (const request of [
      () => send('main-mine', 'mac-other'), () => send('mac-other', 'main-mine', 'other-mac'),
      () => send('mac-other', 'main-legacy', 'other-mac'),
      () => send('mac-mine', 'main-mine', 'mac', { 'X-MNP-AI-Conversation-Id': 'mac-legacy' }),
      () => send('main-mine', 'mac-mine', undefined, { 'X-MNP-AI-Conversation-Id': 'main-legacy' }),
      () => send('mac-mine', 'main-mine'),
    ]) assert.equal((await request()).status, 403)
    assert.equal(calls.filter(c => c.pathname === '/api/internal/session-messages/remote').length, before)
  })
  await t.test('AionCore 탐색과 MCP 귀속·표시·전문의 실제 헤더 형식', async () => {
    const login = await wire('/api/auth/login', { method: 'POST', body: { email: 'editor@mind.local', password: 'ClientBoundary!2026' } })
    assert.equal(login.status, 200)
    const abort = new AbortController()
    const events = await fetch(api.base + '/api/events?clientId=client-boundary', {
      headers: { Cookie: login.headers.get('set-cookie').split(';')[0] }, signal: abort.signal,
    })
    assert.equal(events.status, 200)
    const reader = events.body.getReader()
    await reader.read()
    try {
      for (const conversationId of ['main-mine', 'mac-mine', 'main-system', 'mac-system']) {
        const i = entries.findIndex(([id]) => id === conversationId)
        const machineId = conversationId.startsWith('mac-') ? 'mac' : undefined
        const current = { 'X-MNP-AI-Conversation-Id': conversationId }
        const scope = { ...current, 'X-MNP-AI-Map-Id': api.ids[0], 'X-MNP-AI-Card-Id': `card-${i}`, 'X-MNP-AI-Editor-Id': 'user-editor' }
        const run = opts => machineId ? withMac(wire(opts.route, { ...opts, machineId })) : wire(opts.route, opts)
        const navigation = `/api/integrations/aionui/conversations/${conversationId}/mindnprogress`
        for (const suffix of ['', '/select']) {
          const result = await run({ route: navigation + suffix, method: suffix ? 'POST' : 'GET',
            headers: { ...(machineId ? current : {}), 'X-MNP-Selection-Device-Address': '127.0.0.1' } })
          assert.equal(result.status, 200, JSON.stringify(result))
        }
        assert.equal((await run({ route: '/api/integrations/aionui/conversation-display/resolve', method: 'POST', body: {}, headers: current })).status, 200)
        const attribution = await run({ route: '/api/integrations/aionui/conversation-attribution/resolve', method: 'POST', body: {}, headers: scope })
        assert.equal(attribution.status, 201, JSON.stringify(attribution))
        const headers = { ...scope, 'X-MNP-AI-Attribution': attribution.body.attributionToken }
        assert.equal((await run({ route: `/api/integrations/aionui/conversations/${conversationId}/transcript`, headers })).status, 200)
        const target = machineId ? 'main-mine' : 'mac-mine'
        const targetHeaders = { ...headers, 'X-MNP-AI-Card-Id': machineId ? 'card-0' : 'card-1' }
        // MCP의 현재 대화 헤더는 조회 대상 대화로 바뀌지 않는다. 같은 소유자의 다른 머신 대화도 조회할 수 있다.
        assert.equal((await withMac(wire(`/api/integrations/aionui/conversations/${target}/transcript`, { machineId, headers: targetHeaders }))).status, 200)
        assert.equal((await run({ route: '/api/integrations/aionui/conversations/admin-main/transcript',
          headers: { ...headers, 'X-MNP-AI-Card-Id': 'card-7' } })).status, 403, '관리자 소유 대화는 김용민 계정의 소유가 아니다')
        assert.equal((await run({ route: `/api/maps/${api.ids[0]}`, headers })).status, 200)
        assert.equal((await run({ route: `/api/maps/${api.ids[0]}`, headers: { ...headers, 'X-MNP-AI-Editor-Id': 'user-second' } })).status, 403)
      }
    } finally { abort.abort(); await reader.cancel().catch(() => {}) }
    const origins = await api.read('_ai-conversation-origins.json')
    for (const id of ['main-system', 'mac-system']) assert.equal(origins.find(r => r.conversationId === id).startedBy, 'system-aionui-ai')
  })
  await t.test('메인 허용 해제는 양쪽 미상 호환 계정과 Runner의 미상 대화를 차단한다', async () => {
    const login = await wire('/api/auth/login', { method: 'POST', body: { email: 'isolated@mind.local', password: 'IsolatedOnly!2026' } })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await wire('/api/admin/editors/user-editor', { method: 'PATCH', body: { mainMachineAllowed: false },
      headers: { Authorization: '', Cookie: cookie } })).status, 200)
    assert.equal((await send('main-legacy', 'mac-legacy')).status, 403)
    assert.equal((await send('mac-legacy', 'main-mine', 'mac')).status, 403)
  })
})
