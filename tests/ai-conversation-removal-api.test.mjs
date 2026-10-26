import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
const listen = async (server) => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port }
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('실제 삭제 API는 보관 검증·실행 및 공용 연결 보호·재시도를 수행한다', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-conversation-removal-'))
  const ids = ['active', 'archived', 'missing', 'running', 'waiting-confirmation', 'unknown', 'unsupported', 'lost', 'rejected', 'shared', 'delegated', 'expired-instruction', 'queued-instruction', 'delivered-instruction', 'delayed']
  const archived = new Set(['archived'])
  const archivedCalls = []
  const conversationQueries = []
  const historyQueries = []
  let releaseArchive
  let archiveEntered
  const entered = new Promise((resolve) => { archiveEntered = resolve })
  const fake = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname.match(/^\/api\/sidebar\/conversation\/([^/]+)\/(archive-state|archive)$/)
    if (route) {
      const [, id, action] = route
      if (id === 'unsupported') return json(res, 404, { error: '이 API를 지원하지 않습니다.' })
      if (action === 'archive-state') return json(res, 200, { data: { conversation_id: id, exists: id !== 'missing', archived_at: archived.has(id) ? 123 : null } })
      archivedCalls.push(id)
      if (id === 'rejected') return json(res, 409, { error: '보관 거절' })
      if (id === 'delayed') { archiveEntered(); await new Promise((resolve) => { releaseArchive = resolve }) }
      archived.add(id)
      if (id === 'lost') { res.destroy(); return }
      return json(res, 200, { success: true, data: null })
    }
    const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (conversation) {
      conversationQueries.push(conversation[1])
      return json(res, 200, { id: conversation[1], name: `검증 대화 ${conversation[1]}`,
        created_at: '2026-10-26T00:00:00Z', assistant: { id: 'codex', name: 'Codex' }, runtime: conversation[1] === 'unknown' ? {} : {
      state: conversation[1] === 'running' ? 'running' : conversation[1] === 'waiting-confirmation' ? 'waiting_confirmation' : 'idle',
      is_processing: ['running', 'waiting-confirmation'].includes(conversation[1]),
      has_task: false, pending_confirmations: conversation[1] === 'waiting-confirmation' ? 1 : 0, turn_id: null,
      } })
    }
    if (url.pathname.includes('/messages')) historyQueries.push(url.pathname)
    if (url.pathname === '/api/internal/conversation-runtimes/active') return json(res, 200, { schema_version: 1, items: [] })
    return json(res, 200, [])
  })
  let child
  let output = ''
  try {
    const fakePort = await listen(fake)
    const probe = createServer()
    const port = await listen(probe)
    await close(probe)
    const mapId = 'map-conversation-removal'
    await writeFile(path.join(directory, `${mapId}.json`), JSON.stringify({
      id: mapId, title: '삭제 검증', version: 1,
      nodes: [
        { id: 'root', type: 'mind', position: { x: 0, y: 0 }, data: { label: '원본', kind: 'root',
          aiConversationId: 'active', aiConversations: ids.map((conversationId, index) => ({ conversationId, linkedAt: `2026-10-${String(10 + index).padStart(2, '0')}T00:00:00Z` })) } },
        { id: 'other', type: 'mind', position: { x: 100, y: 0 }, data: { label: '공용 연결', aiConversationId: 'shared' } },
        { id: 'empty', type: 'mind', position: { x: 100, y: 100 }, data: { label: '연결 없는 카드' } },
      ], edges: [],
    }))
    await writeFile(path.join(directory, '_ai-delegations.json'), JSON.stringify([{
      id: 'pending-integration', mapId, parentCardId: 'other', targetCardId: 'root',
      parentConversationId: 'parent', targetConversationId: 'delegated', state: 'integration-recovery-required',
      childStatus: 'completed', workspaceError: '통합 복구 필요', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]))
    const instructions = ['expired', 'queued', 'delivered'].map((state) => ({
      id: `instruction-${state}`, state, parentMapId: mapId, parentCardId: 'other', parentConversationId: 'parent',
      targetMapId: mapId, targetCardId: 'root', targetConversationId: `${state}-instruction`,
      requestedConversationId: `${state}-instruction`,
      createdAt: '2026-10-23T11:10:23.023Z', updatedAt: '2026-10-23T11:16:55.455Z',
      // 실제 만료 기록처럼 이전 전달 메타데이터가 남아 있어도 재실행 대기로 판단하지 않는다.
      dispatchState: 'starting', dispatchOperationId: `gdi:instruction-${state}`, turnId: null,
      deliveredAt: '2026-10-23T11:10:23.801Z',
      ...(state === 'expired' ? { reasonCode: 'GROUP_DOCUMENT_INSTRUCTION_REVISION_CONFLICT' } : {}),
    }))
    await writeFile(path.join(directory, '_group-document-instructions.json'), JSON.stringify(instructions))
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_AIONUI_URL: `http://127.0.0.1:${fakePort}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '60000' },
    })
    child.stdout.on('data', (data) => { output = (output + data).slice(-6000) })
    child.stderr.on('data', (data) => { output = (output + data).slice(-6000) })
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw Error(output)
      try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break } } catch { /* 테스트 서버 준비 대기 */ }
      await pause(100)
    }
    assert.ok(ready, output)
    const token = (await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()
    const headers = { Authorization: `Bearer ${token}`, 'X-MNP-Editor-Id': 'removal-test', 'Content-Type': 'application/json' }
    const request = async (pathname, options = {}) => {
      const res = await fetch(`${base}${pathname}`, { headers, ...options })
      return { status: res.status, body: await res.json() }
    }
    const endpoint = `/api/maps/${mapId}/cards/root/ai-conversations`
    const documentEndpoint = `/api/maps/${mapId}/ai-conversations`
    const remove = (id) => request(`${endpoint}/${id}`, { method: 'DELETE' })
    assert.equal((await fetch(`${base}${documentEndpoint}`)).status, 401)
    assert.equal((await request('/api/maps/map-missing/ai-conversations')).status, 404)
    assert.equal((await request('/api/maps/%20/ai-conversations')).status, 400)
    const queriesBeforeList = [...conversationQueries]
    const documentList = await request(documentEndpoint)
    assert.equal(documentList.status, 200, JSON.stringify(documentList.body))
    assert.equal(documentList.body.documentTitle, '삭제 검증')
    assert.deepEqual(documentList.body.cards.map((card) => [card.cardId, card.cardTitle]), [['root', '원본'], ['other', '공용 연결']],
      '전체 카드의 연결을 묶고, 연결 없는 카드는 제외한다')
    assert.deepEqual(documentList.body.cards[0].conversations.map((item) => item.conversationId), [...ids].reverse())
    assert.deepEqual(documentList.body.cards[1].conversations.map((item) => item.conversationId), ['shared'],
      '이전 형식의 단일 연결도 포함한다')
    assert.deepEqual(conversationQueries, queriesBeforeList, '문서 연결 목록을 만들 때 원격 대화 조회를 기다리지 않는다')
    const linkInfo = (items) => items.map(({ conversationId, startedAt, homeMachineId, accessible, machineOnline }) => ({ conversationId, startedAt, homeMachineId, accessible, machineOnline }))
    assert.deepEqual(linkInfo(documentList.body.cards[0].conversations), linkInfo((await request(`${endpoint}?view=linked`)).body.conversations),
      '카드 목록과 같은 연결 정보·순서·권한을 사용한다')
    const historyBeforeCompact = [...historyQueries]
    const compact = await request(`${endpoint}?view=compact`)
    assert.equal(compact.status, 200)
    assert.deepEqual(compact.body.conversations.map((item) => item.conversationId), [...ids].reverse())
    assert.ok(compact.body.conversations.every((item) => item.name.startsWith('검증 대화 ') && item.agent.label === 'Codex' && item.homeMachineLabel))
    assert.deepEqual(historyQueries, historyBeforeCompact, '간략 목록에서는 대화 이력·문맥 상태를 분석하지 않는다')
    const detailed = await request(endpoint)
    assert.deepEqual(compact.body.conversations.map((item) => item.conversationId), detailed.body.conversations.map((item) => item.conversationId),
      '상세 AI 대화 열기와 간략 목록의 대화 순서가 일치한다')
    assert.equal((await fetch(`${base}${endpoint}/active`, { method: 'DELETE' })).status, 401)
    for (const id of ['active', 'archived', 'missing', 'lost', 'expired-instruction']) {
      const result = await remove(id)
      assert.equal(result.status, 200, JSON.stringify(result.body))
      assert.equal(result.body.archiveState, id === 'missing' ? 'missing' : 'archived')
      assert.ok(!result.body.card.data.aiConversations.some((link) => link.conversationId === id))
    }
    assert.deepEqual(archivedCalls, ['active', 'lost', 'expired-instruction'])
    const remainingDocument = (await request(documentEndpoint)).body
    assert.deepEqual(linkInfo(remainingDocument.cards[1].conversations), linkInfo(documentList.body.cards[1].conversations), '다른 카드의 연결은 변경하지 않는다')
    assert.ok(remainingDocument.cards[0].conversations.every((item) => !['active', 'archived', 'missing', 'lost', 'expired-instruction'].includes(item.conversationId)),
      '삭제한 대화는 문서 전체 목록에서도 제외한다')
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, '_group-document-instructions.json'), 'utf8')), instructions,
      '만료 지시를 강제로 완료 처리하거나 지우지 않고 대화 연결만 삭제한다')
    assert.equal((await remove('active')).status, 200, '응답 재시도에서도 보관을 반복하지 않는다')
    for (const [id, status] of [['running', 409], ['waiting-confirmation', 409], ['unknown', 409], ['unsupported', 502], ['rejected', 502], ['shared', 409], ['delegated', 409], ['queued-instruction', 409], ['delivered-instruction', 409]]) {
      const result = await remove(id)
      assert.equal(result.status, status, `${id}: ${JSON.stringify(result.body)}`)
      if (status === 409) assert.equal(result.body.code, 'AI_CONVERSATION_REMOVAL_BLOCKED', id)
    }
    const remaining = await request(`${endpoint}?view=linked`)
    assert.ok(remaining.body.conversations.some((item) => item.conversationId === 'unsupported'))
    assert.ok(remaining.body.conversations.some((item) => item.conversationId === 'rejected'))
    for (const id of ['running', 'waiting-confirmation', 'delegated', 'queued-instruction', 'delivered-instruction']) {
      assert.ok(remaining.body.conversations.some((item) => item.conversationId === id), `${id} 연결을 유지한다`)
      assert.ok(!archivedCalls.includes(id), `${id} 보관 요청을 보내지 않는다`)
    }
    assert.deepEqual(archivedCalls, ['active', 'lost', 'expired-instruction', 'rejected'])

    const deleting = remove('delayed')
    await entered
    // 보관이 대기 중이어도 배타 문서 변경이 진행된다. 삭제 완료는 최신 본문을 보존해야 한다.
    const before = (await request(`/api/maps/${mapId}`)).body.map
    const next = structuredClone(before)
    next.nodes.find((node) => node.id === 'root').data.description = '보관 확인 중 작성한 최신 본문'
    const changed = await request(`/api/maps/${mapId}/content-patch`, { method: 'PATCH', signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ baseVersion: before.version, patch: createMapContentPatch(before, next) }) })
    assert.equal(changed.status, 200, JSON.stringify(changed.body))
    const conflict = await remove('delayed')
    assert.equal(conflict.status, 409)
    releaseArchive()
    const deleted = await deleting
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.card.data.description, '보관 확인 중 작성한 최신 본문')
  } finally {
    releaseArchive?.()
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000) }) }
    await close(fake)
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('mnp-conversation-removal-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
})
