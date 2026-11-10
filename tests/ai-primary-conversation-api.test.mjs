import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'

test('담당 체크는 사람의 선택만 저장하며 재시작·동시 변경·연결 검증을 지원한다', { timeout: 60_000 }, async (t) => {
  const password = 'PrimaryFixture!2026'
  let aionCalls = 0
  const api = await storageApi(t, { documents: 1, mockAion: () => { aionCalls++; return {} }, seed: async ({ data, ids }) => {
    await writeFile(path.join(data, '_users.json'), JSON.stringify([{ id: 'user-editor', name: '김용민', email: 'editor@mind.local', role: 'editor', active: true,
      salt: 'fixture', passwordHash: scryptSync(password, 'fixture', 64).toString('hex') }]))
    const map = fixture(ids[0])
    Object.assign(map.nodes[0].data, { aiConversationId: 'newer', aiConversations: [
      { conversationId: 'older', homeMachineId: 'isolated-storage', startedAt: '2026-11-09T00:00:00Z' },
      { conversationId: 'newer', homeMachineId: 'isolated-storage', startedAt: '2026-11-10T00:00:00Z' },
    ] })
    await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
    await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify(['older', 'newer'].map((conversationId) => ({
      conversationId, mapId: ids[0], cardId: 'card-0', homeMachineId: 'isolated-storage', startedBy: 'user-editor',
    }))))
  } })
  const endpoint = `/api/maps/${api.ids[0]}/cards/card-0/ai-conversations`
  const initial = await api.call(endpoint + '?view=linked')
  assert.equal(initial.body.primaryConversationId, 'newer')
  const navigation = async (id) => {
    const result = await api.call(`/api/integrations/aionui/conversations/${id}/mindnprogress`)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.exists, true)
    return result.body.target
  }
  const initialAionCalls = aionCalls
  assert.equal((await navigation('older')).conversationRole, 'auxiliary')
  assert.equal((await navigation('newer')).conversationRole, 'primary', '지정되지 않은 기존 카드도 최신 대화를 담당으로 알린다')
  assert.equal(aionCalls, initialAionCalls, '연결 역할 조회는 Aion을 추가 조회하지 않는다')
  assert.equal((await api.call(endpoint + '/primary', 'PUT', { conversationId: 'older', expectedPrimaryConversationId: 'newer' })).status, 401)
  const login = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'editor@mind.local', password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const select = async (conversationId, expectedPrimaryConversationId) => {
    const response = await fetch(api.base + endpoint + '/primary', { method: 'PUT', signal: AbortSignal.timeout(15000), headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, expectedPrimaryConversationId }) })
    return { status: response.status, body: await response.json() }
  }
  const before = aionCalls
  const saved = await select('older', 'newer')
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.primaryConversationId, 'older')
  assert.equal(saved.body.map.nodes[0].data.aiConversationId, 'newer', '최근 대화 정보는 유지한다')
  for (const id of ['older', 'newer']) {
    const target = await navigation(id)
    assert.equal(target.cardRole, 'document-root')
    assert.equal(target.conversationRole, id === 'older' ? 'primary' : 'auxiliary')
    assert.equal(target.primaryConversationId, 'older')
    assert.equal(target.titlePrefix, '[상위] ', '담당·보조 분류를 추가해도 기존 접두어 계약은 유지한다')
  }
  assert.equal((await select('older', 'older')).body.map.version, saved.body.map.version, '같은 선택은 문서를 다시 저장하지 않는다')
  assert.equal((await select('newer', 'newer')).status, 409, '이전 체크를 보고 변경하는 동시 요청은 거절한다')
  assert.equal((await select('unlinked', 'older')).status, 409)
  assert.equal((await api.read(`${api.ids[0]}.json`)).nodes[0].data.aiPrimaryConversationId, 'older')
  assert.equal(aionCalls, before, '담당 선택 때문에 Aion 조회·메시지·대화를 생성하지 않는다')
  await api.restart()
  assert.equal((await api.call(endpoint + '?view=linked')).body.primaryConversationId, 'older')
  assert.equal((await navigation('older')).conversationRole, 'primary')
  // 담당 삭제 후 재선택 대기 상태에서는 남은 연결 모두 보조이며 담당 ID는 null이다.
  const map = (await api.call(`/api/maps/${api.ids[0]}`)).body.map, cleared = structuredClone(map)
  cleared.nodes[0].data.aiPrimaryConversationId = null
  const savedEmpty = await api.call(`/api/maps/${api.ids[0]}/content-patch`, 'PATCH', { baseVersion: map.version, patch: createMapContentPatch(map, cleared) })
  assert.equal(savedEmpty.status, 200, JSON.stringify(savedEmpty.body))
  const clearedVersion = savedEmpty.body.map?.version ?? (await api.call(`/api/maps/${api.ids[0]}`)).body.map.version
  for (const id of ['older', 'newer']) {
    const target = await navigation(id)
    assert.equal(target.conversationRole, 'auxiliary')
    assert.equal(target.primaryConversationId, null)
  }
  assert.equal((await api.call(`/api/maps/${api.ids[0]}`)).body.map.version, clearedVersion, '역할 조회만으로 담당을 지정하거나 문서를 수정하지 않는다')
})
