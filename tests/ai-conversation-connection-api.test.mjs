import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { scryptSync } from 'node:crypto'
import path from 'node:path'
import { storageApi, fixture } from './helpers/storage-api-harness.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'

test('대화 ID 조회 후 복원·연결은 원본 문서와 귀속을 함께 저장하고 최신 편집을 보존한다', { timeout: 60_000 }, async (t) => {
  const states = new Map([['restore-me', 1793000000000], ['active', null], ['elsewhere', null]])
  const calls = []
  let releaseRestore, enteredRestore
  const entered = new Promise((resolve) => { enteredRestore = resolve })
  const api = await storageApi(t, { documents: 2,
    seed: async ({ data, ids }) => {
      const users = JSON.parse(await readFile(path.join(data, '_users.json'), 'utf8'))
      users[0].passwordHash = scryptSync('LinkTestOnly!2026', users[0].salt, 64).toString('hex')
      await writeFile(path.join(data, '_users.json'), JSON.stringify(users))
      const map = fixture(ids[0])
      map.nodes[0].data.aiConversationId = 'old'
      map.nodes[2].data.reference = { mapId: ids[1], nodeId: 'card-0' }
      const other = fixture(ids[1])
      other.nodes[0].data.aiConversationId = 'elsewhere'
      await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
      await writeFile(path.join(data, `${ids[1]}.json`), JSON.stringify(other))
    },
    mockAion: async (url) => {
      calls.push(url)
      const sidebar = url.match(/^\/api\/sidebar\/conversation\/([^/]+)\/(archive-state|unarchive)$/)
      if (sidebar) {
        const [, id, action] = sidebar
        if (action === 'archive-state') return { conversation_id: id, exists: states.has(id), archived_at: states.get(id) ?? null }
        if (id === 'restore-me') { enteredRestore(); await new Promise((resolve) => { releaseRestore = resolve }) }
        states.set(id, null)
        return null
      }
      const conversation = url.match(/^\/api\/conversations\/([^/]+)$/)
      if (conversation) return { id: conversation[1], name: '복원 검증 대화', created_at: 1793000000000,
        assistant: { id: 'codex', name: 'Codex' }, runtime: { state: 'idle', is_processing: false },
        extra: { agent_id: 'codex', current_model_id: 'fixture-model', workspace: 'C:/Git/Example' } }
      return []
    },
  })
  const [mapId] = api.ids
  const endpoint = `/api/maps/${mapId}/cards/card-0/ai-conversations`
  const lookup = (id) => api.call(`${endpoint}/lookup?conversationId=${id}`)
  const connect = (previewToken, extra = {}) => api.call(`${endpoint}/connect`, 'POST', { previewToken, ...extra })
  assert.equal((await fetch(api.base + `${endpoint}/lookup?conversationId=active`)).status, 401)
  assert.equal((await lookup('../bad')).status, 400)
  assert.equal((await api.call(`/api/maps/${mapId}/cards/missing/ai-conversations/lookup?conversationId=active`)).status, 404)
  for (const card of ['card-2']) {
    assert.equal((await api.call(`/api/maps/${mapId}/cards/${card}/ai-conversations/lookup?conversationId=active`)).status, 409)
  }
  const missing = await lookup('missing')
  assert.deepEqual(missing.body, { conversations: [], warnings: [] })
  const bound = await lookup('elsewhere')
  assert.equal(bound.body.conversations[0].binding.mapId, api.ids[1])
  assert.equal(bound.body.conversations[0].previewToken, null)
  const preview = await lookup('restore-me')
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  const token = preview.body.conversations[0].previewToken
  assert.ok(token)
  assert.equal(calls.filter((url) => url.endsWith('/unarchive')).length, 0, '조회만으로 복원하지 않는다')
  assert.equal((await connect(token + 'bad')).status, 409)
  const pending = connect(token, { conversationId: 'forged', agent: { id: 'forged' } })
  await entered
  assert.equal((await connect(token)).status, 409, '중복 연결 요청을 거절한다')
  assert.equal((await api.call(`${endpoint}/restore-me`, 'DELETE')).status, 409, '연결 중 삭제를 거절한다')
  const before = (await api.call(`/api/maps/${mapId}`)).body.map
  const next = structuredClone(before)
  next.nodes[0].data.description = '연결 조회 중 저장한 최신 본문'
  const edited = await api.call(`/api/maps/${mapId}/content-patch`, 'PATCH', {
    baseVersion: before.version, patch: createMapContentPatch(before, next),
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  releaseRestore()
  const result = await pending
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.card.data.description, '연결 조회 중 저장한 최신 본문')
  assert.equal(result.body.card.data.aiConversationId, 'restore-me')
  assert.deepEqual(result.body.card.data.aiConversations.map((item) => item.conversationId).sort(), ['old', 'restore-me'])
  assert.equal(result.body.conversation.agent.id, 'codex', '클라이언트가 보낸 가짜 메타데이터를 저장하지 않는다')
  assert.equal(result.body.conversation.startedAt, new Date(1793000000000).toISOString())
  const origins = await api.read('_ai-conversation-origins.json')
  assert.ok(origins.some((item) => item.conversationId === 'restore-me' && item.mapId === mapId && item.cardId === 'card-0'))
  const attributions = await api.read('_ai-conversation-attributions.json')
  assert.ok(attributions.some((item) => item.conversationId === 'restore-me' && item.modelId === 'fixture-model'))
  const again = await connect(token)
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.card.data.aiConversations.filter((item) => item.conversationId === 'restore-me').length, 1)
  assert.equal(calls.filter((url) => url.endsWith('/unarchive')).length, 1)
  const competing = await api.call(`/api/maps/${mapId}/cards/card-1/ai-conversations/lookup?conversationId=restore-me`)
  assert.equal(competing.body.conversations[0].binding.cardId, 'card-0')
  assert.equal(competing.body.conversations[0].previewToken, null)
  assert.equal((await connect((await lookup('active')).body.conversations[0].previewToken)).status, 200)
  assert.ok(!calls.some((url) => /messages|dispatch|\/archive$/.test(url)), '기존 대화 실행·메시지 전송·보관 요청을 만들지 않는다')
  // Aion 복원 후 확정 전 후보 파일 쓰기가 실패하면 문서·귀속을 함께 롤백하고 재시도한다.
  states.set('rollback', 1793000000000)
  const rollbackToken = (await lookup('rollback')).body.conversations[0].previewToken
  const beforeFailure = (await api.call(`/api/maps/${mapId}`)).body.map
  const failure = await api.barrier('_ai-conversation-origins.json', 'writeFile', { prefix: true, fail: true })
  const rejected = connect(rollbackToken)
  await failure.reached; failure.release()
  assert.equal((await rejected).status, 502)
  assert.deepEqual((await api.call(`/api/maps/${mapId}`)).body.map, beforeFailure)
  assert.ok(!(await api.read('_ai-conversation-origins.json')).some((item) => item.conversationId === 'rollback'))
  assert.ok(!(await api.read('_ai-conversation-attributions.json')).some((item) => item.conversationId === 'rollback'))
  assert.equal(states.get('rollback'), null)
  assert.equal((await connect(rollbackToken)).status, 200)
  assert.equal(calls.filter((url) => url.endsWith('/rollback/unarchive')).length, 1)
  // 저장 확정 뒤 일시 파일 교체 실패는 저장 계층이 재적용해 성공으로 수렴한다.
  states.set('redo-recovery', 1793000000000)
  const redoToken = (await lookup('redo-recovery')).body.conversations[0].previewToken
  const transientFailure = await api.barrier('_ai-conversation-origins.json', 'rename', { fail: true })
  const recovered = connect(redoToken)
  await transientFailure.reached; transientFailure.release()
  assert.equal((await recovered).status, 200)
  assert.equal((await api.call(`/api/maps/${mapId}`)).body.map.nodes[0].data.aiConversationId, 'redo-recovery')
  assert.ok((await api.read('_ai-conversation-origins.json')).some((item) => item.conversationId === 'redo-recovery'))
  assert.ok((await api.read('_ai-conversation-attributions.json')).some((item) => item.conversationId === 'redo-recovery'))
  assert.equal(calls.filter((url) => url.endsWith('/redo-recovery/unarchive')).length, 1)
  if (process.env.MNP_BROWSER_TEST === '1') {
    states.set('browser-archived', 1793000000000)
    const { aiConversationLinkBrowser } = await import('./helpers/aiConversationLinkBrowser.mjs')
    await aiConversationLinkBrowser(api, t)
  }
})
