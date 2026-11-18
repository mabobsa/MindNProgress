import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash, scryptSync } from 'node:crypto'
import path from 'node:path'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'
import { authorizeRunnerMcpRequest } from '../server/lib/runnerMcpAccess.mjs'
import { ensureMainMachine, normalizeMachineRegistry, upsertSubMachine, setMachineToken } from '../server/lib/subMachines.mjs'
import { conversationOwners, conversationOwnedBy, integrationIdentityMatches, redactAttributionTokens } from '../server/lib/aiAccessPolicy.mjs'

test('시작자 미상·충돌 기록과 편집자 생략을 일관되게 판정한다', () => {
  assert.deepEqual(conversationOwners(undefined, { origins: new Map() }), [])
  const permitted = { id: 'owner', role: 'editor', mainMachineAllowed: true }
  assert.equal(conversationOwnedBy(permitted, []), true)
  assert.equal(conversationOwnedBy({ ...permitted, mainMachineAllowed: false }, []), false)
  assert.equal(conversationOwnedBy(permitted, ['owner']), true)
  assert.equal(conversationOwnedBy(permitted, ['owner', 'other']), false)
  assert.equal(conversationOwnedBy({ id: 'admin', role: 'admin' }, ['owner']), false)
  assert.equal(integrationIdentityMatches({ owners: ['owner'] }), true, '명시한 편집자가 없으면 기록의 시작자로 귀속한다')
  assert.equal(integrationIdentityMatches({ editorId: 'other', owners: ['owner'] }), false)
})

test('다중 사용자 API는 메인 허용·소유권·귀속·중계 경계를 실행 전에 검사한다', { timeout: 60000 }, async (t) => {
  const secret = 'test-attribution-secret-012345678901234567890'
  const calls = []
  const api = await storageApi(t, { documents: 1, seed: async ({ data, ids }) => {
    const users = JSON.parse(await readFile(path.join(data, '_users.json'), 'utf8'))
    for (const user of users) user.passwordHash = scryptSync('BoundaryOnly!2026', user.salt, 64).toString('hex')
    await writeFile(path.join(data, '_users.json'), JSON.stringify(users))
    const registry = upsertSubMachine(ensureMainMachine(normalizeMachineRegistry([]), { machineId: 'isolated-storage', label: '검증 메인' }),
      { machineId: 'owned-mac', label: '검증 맥북', ownerUserId: 'user-editor' })
    await writeFile(path.join(data, '_machines.json'), JSON.stringify(registry.machines))
    const map = fixture(ids[0])
    map.nodes[0].data.aiConversationId = 'mine'
    map.nodes[0].data.aiConversations = ['mine', 'other', 'legacy'].map(conversationId => ({ conversationId, homeMachineId: 'isolated-storage' }))
    map.nodes[1].data.aiConversationId = 'other'
    await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
    await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify([
      ['mine', 'user-editor'], ['other', 'user-second'], ['legacy', null], ['remote-mine', 'user-editor'], ['legacy-mac', null],
    ].map(([conversationId, startedBy]) => ({ conversationId, startedBy, homeMachineId: conversationId === 'legacy-mac' ? 'owned-mac' : 'isolated-storage', mapId: ids[0], cardId: 'card-0' }))))
    await writeFile(path.join(data, '_ai-attributions.json'), JSON.stringify([{ tokenHash: createHash('sha256').update(secret).digest('hex'),
      conversationId: 'mine', startedBy: 'user-editor', mapId: ids[0], cardId: 'card-0', expiresAt: Date.now() + 3600000,
      authorName: 'Codex 검증', agentId: 'codex', agentLabel: 'Codex', modelId: 'fixture', modelLabel: 'fixture' }]))
  }, mockAion: url => {
    calls.push(url)
    if (url === '/api/agents/management') return [{ id: 'codex', name: 'Codex', installed: true, enabled: true, status: 'ready', available_models: { available_models: [{ value: 'fixture', name: '검증 모델' }] } }]
    if (['/api/providers', '/api/skills', '/api/mcp/servers'].includes(url)) return []
    if (url.includes('/messages')) return { items: [{ id: 'm1', type: 'text', position: 'right', content: `- attributionToken: \`${secret}\`\n원문 보존` }] }
    return { id: url.split('/').at(-1), name: '권한 검증 대화' }
  } })
  const login = async (email, password = 'BoundaryOnly!2026') => {
    const response = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  const mine = await login('editor@mind.local'), other = await login('second@mind.local')
  const admin = await login('isolated@mind.local', 'IsolatedOnly!2026')
  const as = (cookie, url, method = 'GET', body, headers = {}) => api.call(url, method, body, { Authorization: '', Cookie: cookie, ...headers })
  const endpoint = `/api/maps/${api.ids[0]}/cards/card-0/ai-conversations`
  const editors = await as(admin, '/api/admin/editors')
  assert.equal(editors.body.editors.find(u => u.id === 'user-editor').mainMachineAllowed, true)
  assert.equal(editors.body.editors.find(u => u.id === 'user-second').mainMachineAllowed, false)
  assert.equal((await as(other, '/api/admin/editors/user-second', 'PATCH', { mainMachineAllowed: true })).status, 403)
  const launch = () => as(other, '/api/integrations/aionui/attributions', 'POST', {
    agentId: 'codex', modelId: 'fixture', mapId: api.ids[0], cardId: 'card-0', workspace: api.directory, workspaceConfirmed: true,
  })
  const before = calls.length
  assert.equal((await launch()).status, 400)
  for (const id of ['mine', 'legacy']) assert.equal((await as(other, `${endpoint}/${id}/open-url`)).status, 403)
  assert.equal((await as(other, `${endpoint}/lookup?conversationId=mine`)).status, 403)
  assert.equal(calls.length, before, '거부 요청은 Aion에 도달하지 않는다')
  assert.equal((await as(admin, '/api/admin/editors/user-second', 'PATCH', { mainMachineAllowed: true })).status, 200)
  assert.equal((await as(other, `${endpoint}/mine/open-url`)).status, 403, '메인 허용이 타인 소유권을 부여하지 않는다')
  assert.equal((await as(admin, `${endpoint}/mine/open-url`)).status, 403, '관리자도 타인의 대화 소유권을 얻지 않는다')
  assert.equal((await as(other, `${endpoint}/legacy/open-url`)).status, 200)
  assert.equal((await as(other, `${endpoint}/other/open-url`)).status, 200)
  assert.equal((await as(mine, `${endpoint}/mine/open-url`)).status, 200)
  const current = (await api.call(endpoint + '?view=linked')).body.primaryConversationId
  assert.equal((await as(other, `${endpoint}/primary`, 'PUT', { conversationId: 'mine', expectedPrimaryConversationId: current })).status, 403)
  const original = (await api.call(`/api/maps/${api.ids[0]}`)).body.map
  const forged = structuredClone(original)
  forged.nodes[0].data.aiPrimaryConversationId = 'mine'
  assert.equal((await as(other, `/api/maps/${api.ids[0]}`, 'PUT', { map: forged, force: true })).status, 403)
  assert.equal((await as(other, `/api/maps/${api.ids[0]}/content-patch`, 'PATCH', {
    baseVersion: original.version, patch: createMapContentPatch(original, forged),
  })).status, 403, '일반 문서 저장으로 담당 지정 검사를 우회할 수 없다')
  const scope = { 'X-MNP-AI-Map-Id': api.ids[0], 'X-MNP-AI-Card-Id': 'card-0' }
  const transcript = `/api/integrations/aionui/conversations/mine/transcript`
  assert.equal((await as(other, transcript, 'GET', undefined, scope)).status, 403)
  const exported = await as(mine, transcript, 'GET', undefined, scope)
  assert.equal(exported.status, 200)
  assert.ok(exported.body.transcript.includes('[비공개]'))
  assert.ok(exported.body.transcript.includes('원문 보존'))
  assert.ok(!JSON.stringify(exported.body).includes(secret))
  assert.equal((await api.call('/api/maps', 'GET', undefined, { 'X-MNP-AI-Conversation-Id': 'mine', 'X-MNP-AI-Editor-Id': 'user-second' })).status, 403)
  assert.equal((await api.call('/api/maps', 'GET', undefined, { 'X-MNP-AI-Conversation-Id': 'mine' })).status, 200)
  assert.equal((await api.call('/api/maps', 'GET', undefined, { 'X-MNP-AI-Attribution': secret, 'X-MNP-AI-Editor-Id': 'user-second' })).status, 403)
  const beforeResume = calls.length
  const resume = await as(mine, `/api/maps/${api.ids[0]}/ai-delegations`, 'POST', {
    targetCardId: 'card-1', sourceRevision: 1, strategy: 'resume', conversationId: 'other',
    conversationAssessmentId: 'a'.repeat(64), instruction: '실행되면 안 되는 타인 대화 재개', decisionReason: '거부 검증', idempotencyKey: 'foreign-resume',
  }, { ...scope, 'X-MNP-AI-Conversation-Id': 'mine' })
  assert.equal(resume.status, 403, JSON.stringify(resume.body))
  assert.equal(calls.length, beforeResume)
  const relay = (from, to, claimed = 'mine') => api.call('/api/integrations/aionui/session-messages', 'POST',
    { fromConversationId: from, to, message: '격리 검증' }, { 'X-MNP-AI-Conversation-Id': claimed })
  const beforeRelay = calls.length
  assert.equal((await relay('other', 'remote-mine')).status, 403)
  assert.equal((await relay('mine', 'other')).status, 403)
  assert.equal((await relay('mine', 'legacy')).status, 404, '메인 허용 계정은 시작자 미상 대화의 접근 검사도 통과한다')
  assert.equal(calls.length, beforeRelay)
  assert.equal((await relay('mine', 'remote-mine')).status, 404, '같은 시작자는 권한 검사를 통과하고 머신 탐색으로 진행한다')
  const pending = await as(mine, '/api/integrations/aionui/attributions', 'POST', {
    agentId: 'codex', modelId: 'fixture', mapId: api.ids[0], cardId: 'card-0', workspace: api.directory, workspaceConfirmed: true,
  })
  assert.equal(pending.status, 201, JSON.stringify(pending.body))
  const completion = await fetch(pending.body.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'other' }) })
  assert.equal(completion.status, 403, await completion.text())
  assert.equal((await api.read('_ai-conversation-origins.json')).find(item => item.conversationId === 'other').startedBy, 'user-second')
  assert.equal((await as(admin, '/api/admin/editors/user-editor', 'PATCH', { mainMachineAllowed: false })).status, 200)
  const legacyCompletion = await fetch(pending.body.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'legacy-mac' }) })
  assert.equal(legacyCompletion.status, 403, await legacyCompletion.text())
  await api.restart()
  assert.equal((await api.read('_users.json')).find(u => u.id === 'user-editor').mainMachineAllowed, false, '재시작이 해제를 되돌리지 않는다')
})

test('Runner는 머신 소유자와 다른 귀속 토큰을 거부한다', () => {
  let registry = ensureMainMachine(normalizeMachineRegistry([]), { machineId: 'main', label: '메인' })
  registry = upsertSubMachine(registry, { machineId: 'mac', label: '맥북', ownerUserId: 'owner' })
  registry = setMachineToken(registry, 'mac', 'runner-token')
  const args = { pathname: '/api/maps', machineRegistry: registry, users: [{ id: 'owner', role: 'editor' }],
    conversationOrigins: new Map([['mine', { conversationId: 'mine', startedBy: 'owner', homeMachineId: 'mac' }]]),
    request: { method: 'GET', headers: { authorization: 'Bearer runner-token', 'x-mnp-runner-mcp-machine-id': 'mac',
      'x-mnp-ai-conversation-id': 'mine', 'x-mnp-ai-attribution': 'foreign-token' } } }
  assert.equal(authorizeRunnerMcpRequest({ ...args, attributionForToken: () => ({ startedBy: 'other' }) }).kind, 'rejected')
  assert.equal(authorizeRunnerMcpRequest({ ...args, attributionForToken: () => ({ startedBy: 'owner' }) }).kind, 'authorized')
  const legacyToken = { conversationId: 'mine', startedBy: 'system-aionui-ai' }
  assert.equal(authorizeRunnerMcpRequest({ ...args, attributionForToken: () => legacyToken }).kind, 'authorized')
  assert.equal(authorizeRunnerMcpRequest({ ...args, attributionForToken: () => ({ ...legacyToken, conversationId: 'other' }) }).kind, 'rejected')
  const legacyConversation = { ...args, users: [{ id: 'owner', role: 'editor', mainMachineAllowed: true }],
    conversationOrigins: new Map([['mine', { ...legacyToken, homeMachineId: 'mac' }]]) }
  assert.equal(authorizeRunnerMcpRequest({ ...legacyConversation, attributionForToken: () => legacyToken }).kind, 'rejected')
  assert.deepEqual(redactAttributionTokens({ nested: [{ attributionToken: 'secret' }] }), { nested: [{ attributionToken: '[비공개]' }] })
})
