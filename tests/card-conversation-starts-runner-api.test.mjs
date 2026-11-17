import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { storageApi, fixture } from './helpers/storage-api-harness.mjs'
import { cardConversationStartHash, cardConversationStartId, normalizeCardConversationStart } from '../server/lib/cardConversationStarts.mjs'

// AionUi mindnprogressRunner/runtime.ts:isAllowedLocalRequest (2026-11-17).
// 실제 허용 목록을 고정해 금지 경로를 반환하는 느슨한 모의 서버로 회귀를 숨기지 않는다.
function allowed(method, pathname) {
  const url = new URL(pathname, 'http://localhost'), p = url.pathname, query = url.searchParams.size > 0
  const id = '[A-Za-z0-9_-]{1,160}'
  if (method === 'GET') {
    if (!query && ['/api/agents/management', '/api/providers', '/api/skills', '/api/mcp/servers',
      '/api/internal/conversation-runtimes/active', '/api/internal/external-conversation-dispatches/capabilities'].includes(p)) return true
    if (!query && [new RegExp(`^/api/conversations/${id}$`), new RegExp(`^/api/sidebar/conversation/${id}/archive-state$`),
      new RegExp(`^/api/internal/external-conversation-dispatches/${id}$`)].some(re => re.test(p))) return true
    if (!new RegExp(`^/api/conversations/${id}/messages$`).test(p)) return false
    const keys = [...url.searchParams.keys()]
    return keys.length === 2 && new Set(keys).size === 2 && ['100', '10000'].includes(url.searchParams.get('limit'))
      && url.searchParams.get('content_mode') === 'full'
  }
  if (method === 'PATCH') return !query && new RegExp(`^/api/conversations/${id}$`).test(p)
  if (method === 'POST') return !query && (['/api/internal/mobile-push/mnp', '/api/internal/external-conversation-dispatches',
    '/api/internal/external-conversation-launches', '/api/internal/session-messages/remote'].includes(p)
    || [new RegExp(`^/api/sidebar/conversation/${id}/archive$`), new RegExp(`^/api/conversations/${id}/external-reports$`),
      new RegExp(`^/api/internal/external-conversation-dispatches/${id}/complete$`)].some(re => re.test(p)))
  return false
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, message) {
  for (let i = 0; i < 150; i++) { const value = await action(); if (value) return value; await pause(30) }
  assert.fail(message)
}
const input = (requestId, previous) => ({ requestId, predecessorConversationId: previous,
  newConversation: { agentId: 'claude', modelId: 'opus', modeId: 'acceptEdits', thoughtLevelId: 'max' },
  initialMessage: '검증된 인계 원문', decisionReason: '사용자 요청', approvalEvidence: '사용자가 인계를 요청했습니다.' })

test('Runner 허용 경로로 새 인계·기존 콜론 복구·수동 대표 지정·명시 종료·기존 대상 인계를 처리한다', { timeout: 90_000 }, async t => {
  const createdAt = '2026-11-17T00:00:00.000Z', runnerToken = 'isolated-runner-token'
  const records = [], calls = [], posts = [], dispatches = new Map(), conversations = new Map(), messages = new Map()
  const extra = { current_model_id: 'opus', current_mode_id: 'acceptEdits', thought_level: 'max' }
  const makeConversation = id => ({ id, extra: { ...extra }, runtime: { state: 'idle', is_processing: false, turn_id: null } })
  const api = await storageApi(t, { documents: 1, seed: async ({ data, ids }) => {
    const map = fixture(ids[0])
    const origins = []
    for (let i = 0; i < 5; i++) {
      const previous = `previous-${i}`, successor = `successor-${i}`, cardId = `card-${i}`
      const links = [previous, successor].map(conversationId => ({ conversationId, homeMachineId: 'macbook',
        agent: { id: 'claude', label: 'Claude' }, model: { id: 'opus', label: 'Opus' },
        workspace: '/tmp/isolated-handoff', startedBy: { id: 'user-editor', label: '김용민' } }))
      Object.assign(map.nodes[i].data, { aiConversationId: i === 2 ? successor : previous,
        aiPrimaryConversationId: i === 2 ? successor : previous, aiConversations: links })
      for (const { conversationId } of links) {
        origins.push({ mapId: ids[0], cardId, conversationId, homeMachineId: 'macbook', startedBy: 'user-editor' })
        conversations.set(conversationId, makeConversation(conversationId))
      }
      if (i === 0 || i === 4) continue
      const normalized = normalizeCardConversationStart(input(`legacy-${i}`, previous))
      const id = cardConversationStartId('user-editor', ids[0], cardId, normalized.requestId).replace('ccs-', 'ccs:')
      const instruction = `# MindNProgress 카드 대화 인계\n\n고유 인계문 ${i}`
      records.push({ id, requestId: normalized.requestId, signature: cardConversationStartHash(JSON.stringify(normalized)),
        mapId: ids[0], cardId, startedBy: 'user-editor', machineId: 'macbook', predecessorConversationId: previous,
        conversationId: successor, state: 'recovery-required', reasonCode: 'CARD_CONVERSATION_START_DELIVERY_UNCONFIRMED',
        deliveryState: 'starting', turnId: null, attemptedAt: createdAt, createdAt, updatedAt: createdAt,
        input: normalized, requestedConfig: normalized.newConversation, payload: { operationId: id, instruction } })
      messages.set(successor, { items: i === 3 ? [] : [
        { id: `prompt-${i}`, conversation_id: successor, type: 'text', position: 'right', created_at: Date.parse(createdAt) + 1, content: { content: instruction } },
        { id: `reply-${i}`, conversation_id: successor, type: 'text', position: 'left', created_at: Date.parse(createdAt) + 2, content: { content: '인계문을 확인했습니다.' } },
      ] })
    }
    await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
    await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify(origins))
    await writeFile(path.join(data, '_card-conversation-starts.json'), JSON.stringify(records))
    await writeFile(path.join(data, '_machines.json'), JSON.stringify([
      { machineId: 'isolated-storage', role: 'main', label: '메인' },
      { machineId: 'macbook', role: 'sub', label: '맥북', ownerUserId: 'user-editor', enabled: true, tokenHash: cardConversationStartHash(runnerToken) },
    ]))
    await writeFile(path.join(data, '_distributed-work-settings.json'), JSON.stringify({ 'user-editor': { enabled: true, defaultMachineId: 'macbook' } }))
  } })
  const [mapId] = api.ids
  let stopped = false, mismatch = true
  const denied = []
  const resolve = ({ method, pathname, body }) => {
    calls.push({ method, pathname })
    if (!allowed(method, pathname)) { denied.push(pathname); return { ok: false, error: { code: 'RUNNER_OPERATION_REJECTED', message: '허용되지 않은 경로' } } }
    const send = data => ({ ok: true, data })
    if (pathname === '/api/agents/management') return send([{ id: 'claude', name: 'Claude', backend: 'claude', installed: true, enabled: true,
      available_models: { available_models: [{ value: 'opus', name: 'Opus' }] } }])
    if (pathname === '/api/mcp/servers') return send([{ id: 'mnp', name: 'MindNProgress', enabled: true }])
    if (pathname === '/api/internal/external-conversation-dispatches') {
      const payload = typeof body === 'string' ? JSON.parse(body) : body
      posts.push(payload)
      assert.match(payload.operationId, /^[A-Za-z0-9_-]{1,160}$/)
      const id = payload.targetConversationId ?? `new-${posts.length}`
      conversations.set(id, makeConversation(id))
      const dispatch = { operationId: payload.operationId, conversationId: id, state: 'running', turnId: `turn-${posts.length}` }
      dispatches.set(payload.operationId, dispatch)
      return send({ ...dispatch, state: 'starting', turnId: null })
    }
    if (pathname.startsWith('/api/internal/external-conversation-dispatches/')) return send(dispatches.get(pathname.split('/').at(-1)))
    const message = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\?/)
    if (message) return send(messages.get(message[1]) ?? { items: [] })
    const conversation = pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (conversation) {
      const value = conversations.get(conversation[1])
      return send(value?.id === 'new-1' && mismatch ? { ...value, extra: { ...extra, thought_level: 'low' } } : value)
    }
    return send([])
  }
  const loop = (async () => {
    while (!stopped) {
      let claimed
      try { claimed = await api.call('/api/machines/macbook/runner/operations/claim', 'POST', { waitMs: 50, limit: 16 }, { Authorization: `Bearer ${runnerToken}` }) }
      catch { if (!stopped) await pause(30); continue }
      for (const operation of claimed.body.operations ?? []) {
        await api.call(`/api/machines/macbook/runner/operations/${operation.operationId}/result`, 'POST', resolve(operation.request),
          { Authorization: `Bearer ${runnerToken}`, 'X-MnP-Operation-Token': operation.resultToken }).catch(() => {}) // 격리 서버 재시작 중 연결 단절
      }
    }
  })()
  t.after(async () => { stopped = true; await loop })
  const submit = (i, body, caller = `previous-${i}`) => api.call(`/api/maps/${mapId}/cards/card-${i}/ai-conversation-starts`, 'POST', body,
    { 'X-MNP-AI-Conversation-Id': caller, 'X-MNP-AI-Map-Id': mapId, 'X-MNP-AI-Card-Id': `card-${i}` })
  const query = (i, requestId, patch = {}, caller) => submit(i, { requestId, resultOnly: true, ...patch }, caller)
  const ready = (i, id) => until(async () => { const r = await query(i, id); assert.ok([200, 202].includes(r.status), JSON.stringify(r.body)); return r.body.state === 'ready' && r.body }, `${id} 인계 미완료`)
  assert.equal((await submit(0, input('fresh', 'previous-0'))).status, 202)
  await until(async () => (await query(0, 'fresh')).body.reasonCode === 'CARD_CONVERSATION_START_RUNTIME_UNCONFIRMED', '설정 불일치를 잡지 못했습니다.')
  assert.equal((await api.call(`/api/maps/${mapId}`)).body.map.nodes[0].data.aiPrimaryConversationId, 'previous-0')
  mismatch = false
  const fresh = await ready(0, 'fresh')
  assert.equal(fresh.runtimeConfig.model.source, 'snapshot')
  assert.equal(posts.length, 1)
  // 원래 서명 그대로 재시도해도 기존 콜론 요청 한 건을 이어간다.
  assert.equal((await submit(1, input('legacy-1', 'previous-1'))).body.delivery.operationId, records[0].id)
  for (const i of [1, 2]) {
    const recovered = await ready(i, `legacy-${i}`)
    assert.equal(recovered.delivery.operationId, records[i - 1].id)
    assert.equal(recovered.deliveryEvidence.execution, 'assistant-reply')
  }
  assert.equal(posts.length, 1, '기존 인계를 재전송하지 않는다')
  const map = (await api.call(`/api/maps/${mapId}`)).body.map
  for (const i of [1, 2]) assert.equal(map.nodes[i].data.aiPrimaryConversationId, `successor-${i}`)
  // 메시지 근거가 없으면 대화가 존재해도 승격하지 않는다. 사용자 명시 종료로 새 인계를 허용한다.
  await query(3, 'legacy-3')
  await until(async () => (await query(3, 'legacy-3')).body.state === 'recovery-required', '근거 없는 복구를 차단하지 못했습니다.')
  const closed = await until(async () => { const r = await query(3, 'legacy-3', { closeReason: '근거가 없어 기존 인계를 종료합니다.' }); return r.status === 200 && r.body.state === 'closed' && r.body }, '기록 종료 실패')
  assert.equal(closed.linked, false)
  assert.equal((await submit(3, input('after-close', 'previous-3'))).status, 202)
  await ready(3, 'after-close')
  // 기존 대화 지정의 사용자 메시지 조회 역시 Runner가 허용하는 limit=100을 사용한다.
  messages.set('previous-4', { items: [{ id: 'user-choice', conversation_id: 'previous-4', position: 'right', type: 'text', created_at: Date.now(), content: 'successor-4로 인계하세요.' }] })
  const existing = input('existing', 'previous-4'); delete existing.newConversation; existing.targetConversationId = 'successor-4'
  assert.equal((await submit(4, existing)).status, 202)
  await ready(4, 'existing')
  assert.equal(posts.at(-1).strategy, 'resume')
  assert.equal(posts.length, 3)
  // 새 형식과 기존 형식, closed 상태를 서버 재시작 후에도 모두 읽는다.
  await api.restart()
  assert.equal((await query(0, 'fresh')).body.state, 'ready')
  assert.equal((await query(1, 'legacy-1')).body.delivery.operationId, records[0].id)
  assert.equal((await query(3, 'legacy-3')).body.state, 'closed')
  assert.equal(posts.length, 3)
  assert.deepEqual(denied, [])
  assert.ok(calls.some(item => item.pathname.endsWith('/messages?limit=10000&content_mode=full')))
  assert.ok(calls.some(item => /external-conversation-dispatches\/ccs-/.test(item.pathname)))
})
