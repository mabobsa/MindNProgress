import assert from 'node:assert/strict'
import test from 'node:test'
import { request as httpRequest } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { newStorageRequestId, storageHash } from '../server/lib/storageJournal.mjs'

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const route = '/api/maps/map-bench-0/comments'
const body = (text) => ({ nodeId: 'card-1', text })
const key = (id) => ({ 'Idempotency-Key': id })
const query = (api, id) => api.call(route, 'POST', undefined, { ...key(id), 'X-MNP-Result-Only': '1' })
async function independent(api, t) {
  const start = performance.now()
  const result = await api.call('/api/maps/map-bench-1/comments', 'POST', body('무관한 문서 저장'))
  const elapsedMs = performance.now() - start
  assert.equal(result.status, 201, JSON.stringify(result))
  assert.ok(elapsedMs < 5000, String(elapsedMs))
  t.diagnostic(JSON.stringify({ independentSaveMs: Math.round(elapsedMs), budgetMs: 5000 }))
}

test('느린 본문도 전체 기한에 포함하며 2,000,000바이트 제한과 독립 문서 저장을 유지한다', { timeout: 30000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const id = newStorageRequestId()
  let request
  const response = new Promise((resolve, reject) => {
    request = httpRequest(api.base + route, { method: 'POST', headers: { ...api.headers, ...key(id), 'X-MNP-Deadline-At': String(Date.now() + 800) } }, (incoming) => {
      let text = ''; incoming.on('data', (c) => { text += c }); incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(text) }))
    })
    request.on('error', reject); request.write('{"nodeId":')
  })
  await independent(api, t)
  const result = await response
  request.destroy()
  assert.equal(result.status, 503)
  assert.equal(result.body.code, 'REQUEST_DEADLINE_EXCEEDED')
  assert.equal((await query(api, id)).body.outcome, 'unknown')
  const tooLarge = await api.call(route, 'POST', body('a'.repeat(2_000_000)))
  assert.equal(tooLarge.status, 413)
  assert.equal((await api.call(route)).body.comments.length, 0)
})

test('동일 ID 합류는 큐를 점유하지 않고 실제 HTTP 128개 포화·취소 뒤 같은 ID를 재접수한다', { timeout: 45000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  const barrier = await api.barrier('_comments/map-bench-0.json', 'rename')
  const first = api.call(route, 'POST', body('확정할 첫 요청'), key(id))
  await barrier.reached
  try {
    const joined = await Promise.all(Array.from({ length: 20 }, () => api.call(route, 'POST', body('확정할 첫 요청'), key(id))))
    assert.ok(joined.every((result) => result.status === 202 && result.body.outcome === 'processing'), JSON.stringify(joined))
    const controllers = Array.from({ length: 128 }, () => new AbortController())
    const waiters = controllers.map((controller, i) => fetch(api.base + route, { method: 'POST',
      headers: api.headers, body: JSON.stringify(body(`취소 ${i}`)), signal: controller.signal }).then(async (r) => ({ status: r.status, body: await r.json() })).catch(() => ({ aborted: true })))
    await pause(400)
    const admissionId = newStorageRequestId()
    const full = await api.call(route, 'POST', body('포화 후 재접수'), key(admissionId))
    assert.equal(full.status, 503, JSON.stringify(full))
    assert.equal(full.body.code, 'WRITE_QUEUE_FULL')
    assert.equal(full.body.retryAfterMs, 250)
    assert.equal(full.body.outcome, 'not-applied')
    await independent(api, t)
    controllers.forEach((controller) => controller.abort())
    await Promise.all(waiters); await pause(100)
    assert.equal((await query(api, admissionId)).body.outcome, 'unknown')
    barrier.release(); assert.equal((await first).body.outcome, 'committed')
    assert.equal((await api.call(route, 'POST', body('포화 후 재접수'), key(admissionId))).body.outcome, 'committed')
    assert.deepEqual((await api.read('_comments/map-bench-0.json')).map((c) => c.text), ['확정할 첫 요청', '포화 후 재접수'])
  } finally { barrier.release() }
})

test('실제 5초 잠금 기한은 변경 전 거부이고 대기자 해제 뒤 독립·후속 저장이 가능하다', { timeout: 25000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  const barrier = await api.barrier('_comments/map-bench-0.json', 'rename')
  const first = api.call(route, 'POST', body('보호 중'))
  await barrier.reached
  try {
    const start = performance.now()
    const waiting = api.call(route, 'POST', body('기한 후 재접수'), key(id))
    await independent(api, t)
    const result = await waiting, elapsedMs = performance.now() - start
    assert.equal(result.body.code, 'LOCK_WAIT_TIMEOUT', JSON.stringify(result))
    assert.equal(result.body.retryAfterMs, 250)
    assert.ok(elapsedMs >= 4900 && elapsedMs < 6500, String(elapsedMs))
    t.diagnostic(JSON.stringify({ lockWaitMs: Math.round(elapsedMs), budgetMs: 5000 }))
    assert.equal((await query(api, id)).body.outcome, 'unknown')
    const retryStarted = performance.now()
    assert.equal((await api.call(route, 'POST', body('기한 후 재접수'), key(id))).body.code, 'LOCK_WAIT_TIMEOUT')
    assert.ok(performance.now() - retryStarted < 1000, '동일 요청에 새 5초 대기를 주지 않는다')
    barrier.release(); await first
    assert.equal((await api.call(route, 'POST', body('기한 후 재접수'), key(id))).body.outcome, 'committed')
    assert.equal((await api.read('_comments/map-bench-0.json')).length, 2)
  } finally { barrier.release() }
})

for (const phase of ['intent', 'canonical']) test(`연결 종료 ${phase}: 시작된 저장은 확정·결과 조회로 수렴한다`, { timeout: 25000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  const barrier = await api.barrier(phase === 'intent' ? `_storage-transactions/request-${storageHash(id)}/intent.json` : '_comments/map-bench-0.json', 'rename')
  const controller = new AbortController()
  const first = fetch(api.base + route, { method: 'POST', headers: { ...api.headers, ...key(id) }, body: JSON.stringify(body('연결 종료 뒤 확정')), signal: controller.signal }).catch(() => null)
  await barrier.reached; controller.abort(); await first
  assert.equal((await query(api, id)).body.outcome, 'processing')
  barrier.release()
  let result
  for (let n = 0; n < 100; n++) { result = await query(api, id); if (result.body.outcome === 'committed') break; await pause(20) }
  assert.equal(result.body.outcome, 'committed', JSON.stringify(result))
  assert.equal((await api.read('_comments/map-bench-0.json')).length, 1)
  await api.restart()
  assert.equal((await query(api, id)).body.transactionId, result.body.transactionId)
})

test('영속 준비 후 응답 기한은 202이며 marker 확정 뒤 동일 ID 결과를 보존한다', { timeout: 25000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  const barrier = await api.barrier('_comments/map-bench-0.json', 'rename')
  const first = api.call(route, 'POST', body('처리 중 응답'), { ...key(id), 'X-MNP-Deadline-At': String(Date.now() + 900) })
  await barrier.reached
  try {
    const result = await first
    assert.equal(result.status, 202, JSON.stringify(result)); assert.equal(result.body.requestId, id)
  } finally { barrier.release() }
  let result
  for (let n = 0; n < 100; n++) { result = await query(api, id); if (result.body.outcome === 'committed') break; await pause(20) }
  assert.equal(result.body.outcome, 'committed')
  assert.equal((await api.read('_comments/map-bench-0.json')).length, 1)
  const replayed = await api.call(route, 'POST', body('처리 중 응답'), { ...key(id), 'X-MNP-Deadline-At': String(Date.now() - 1000) })
  assert.equal(replayed.body.outcome, 'committed')
  assert.equal(replayed.body.replayed, true)
})

test('느린 AionUi 표시 조회 중 공용 AI 상태와 무관한 문서 저장은 계속한다', { timeout: 25000 }, async (t) => {
  const entered = deferred(), release = deferred()
  const api = await storageApi(t, { documents: 3, mockAion: async (url) => {
    if (url === '/api/conversations/slow-display') { entered.resolve(); await release.promise }
    return { id: url.split('/').at(-1), name: '모의 대화', runtimes: [] }
  } })
  const display = api.call('/api/integrations/aionui/conversation-display/resolve', 'POST', {}, { 'X-MNP-AI-Conversation-Id': 'slow-display' })
  await entered.promise
  try {
    await independent(api, t)
    const start = performance.now()
    const state = await api.call('/api/integrations/aionui/conversation-display/resolve', 'POST', {}, { 'X-MNP-AI-Conversation-Id': 'fast-display' })
    assert.equal(state.status, 200); assert.ok(performance.now() - start < 2500)
  } finally { release.resolve() }
  assert.equal((await display).status, 200)
})

test('미연결 Runner의 외부 확인과 정상 25초 long-poll 동안 무관한 문서는 5초 안에 저장한다', { timeout: 40000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const login = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: api.env.MNP_ADMIN_EMAIL, password: api.env.MNP_ADMIN_PASSWORD }) })
  assert.equal(login.status, 200)
  const signedIn = { Cookie: login.headers.get('set-cookie').split(';')[0] }, tokens = {}
  for (const machineId of ['offline-05', 'poll-05']) {
    assert.equal((await api.call('/api/machines', 'POST', { machineId, label: machineId }, signedIn)).status, 200)
    const issued = await api.call(`/api/machines/${machineId}/token`, 'POST', {}, signedIn)
    assert.equal(issued.status, 200)
    tokens[machineId] = { Authorization: `Bearer ${issued.body.token}` }
    assert.equal((await api.call(`/api/machines/${machineId}/runner/heartbeat`, 'POST', {}, tokens[machineId])).body.longPollMs, 25000)
  }
  const probe = api.call('/api/machines/offline-05/probe', 'POST', {}, { ...signedIn, 'X-MNP-Deadline-At': String(Date.now() + 1500) })
  const pollStarted = performance.now()
  const poll = fetch(api.base + '/api/machines/poll-05/runner/operations/claim', { method: 'POST',
    headers: { ...tokens['poll-05'], 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) })
  let waiting = false
  for (let n = 0; n < 50; n++) {
    const offline = await api.call('/api/machines/offline-05/runner/heartbeat', 'POST', {}, tokens['offline-05'])
    const idle = await api.call('/api/machines/poll-05/runner/heartbeat', 'POST', {}, tokens['poll-05'])
    if (offline.body.queue.pending === 1 && idle.body.queue.waiting === 1) { waiting = true; break }
    await pause(20)
  }
  assert.equal(waiting, true)
  await independent(api, t)
  assert.equal((await probe).body.reachable, false)
  // 시험이 만든 미전달 오퍼레이션만 취소하고 정상 long-poll은 원래 25초를 모두 기다린다.
  assert.equal((await api.call('/api/machines/offline-05/token', 'DELETE', {}, signedIn)).status, 200)
  const polled = await poll, elapsedMs = performance.now() - pollStarted
  assert.equal(polled.status, 200)
  assert.deepEqual((await polled.json()).operations, [])
  assert.ok(elapsedMs >= 24900 && elapsedMs < 28000, String(elapsedMs))
  assert.equal((await api.call('/api/machines/poll-05/runner/heartbeat', 'POST', {}, tokens['poll-05'])).body.queue.waiting, 0)
  assert.match(api.output(), /"phase":"runner-long-poll"/)
  t.diagnostic(JSON.stringify({ runnerLongPollMs: Math.round(elapsedMs), storageWaitBudgetMs: 5000 }))
})

test('launch callback 외부 확인 중 문서 저장을 허용하고 같은 예약·버전 변경을 재검증한다', { timeout: 35000 }, async (t) => {
  let blocked = true
  const entered = deferred(), release = deferred()
  const api = await storageApi(t, { documents: 3, mockAion: async (url) => {
    if (url === '/api/agents/management') return [{ id: 'fixture-agent', name: 'Fixture AI', installed: true, enabled: true,
      available_models: { available_models: [{ value: 'fixture-model', name: 'Fixture Model' }] } }]
    if (url === '/api/conversations/launch-conversation') {
      if (blocked) { entered.resolve(); await release.promise }
      return { id: 'launch-conversation', name: '모의 대화', extra: { agent_id: 'fixture-agent', current_model_id: 'fixture-model' } }
    }
    return []
  } })
  const launch = await api.call('/api/integrations/aionui/attributions', 'POST', { mapId: api.ids[0], cardId: 'card-1',
    agentId: 'fixture-agent', modelId: 'fixture-model', workspace: api.directory, workspaceConfirmed: true })
  assert.equal(launch.status, 201, JSON.stringify(launch))
  const complete = async () => {
    const response = await fetch(launch.body.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'launch-conversation' }) })
    return { status: response.status, body: await response.json() }
  }
  const completion = complete()
  await entered.promise
  try {
    await independent(api, t)
    assert.equal((await complete()).status, 409)
    assert.equal((await api.call(`/api/maps/${api.ids[0]}`, 'PATCH', { baseVersion: 1, title: '외부 확인 중 변경' })).status, 200)
  } finally { blocked = false; release.resolve() }
  const rejected = await completion
  assert.equal(rejected.status, 409, JSON.stringify(rejected))
  assert.equal((await api.read(`${api.ids[0]}.json`)).nodes[1].data.aiConversationId, undefined)
  const linked = await complete()
  assert.equal(linked.status, 200, JSON.stringify(linked) + api.output())
  assert.equal((await api.read(`${api.ids[0]}.json`)).nodes[1].data.aiConversationId, 'launch-conversation')
})

test('완료 이력 백업 파일 대기 중 무관한 저장·AI 상태 조회를 허용하고 재검증 후 정리한다', { timeout: 30000 }, async (t) => {
  const id = 'delegation-cleanup-05', old = '2026-09-01T00:00:00Z', hash = 'a'.repeat(64)
  const api = await storageApi(t, { documents: 3, seed: async ({ data, ids }) => {
    await writeFile(path.join(data, '_ai-delegations.json'), JSON.stringify([{ id, mapId: ids[0], parentMapId: ids[0],
      parentCardId: 'card-0', targetCardId: 'card-1', parentConversationId: 'parent-cleanup', targetConversationId: 'child-cleanup',
      state: 'completed', childStatus: 'completed', createdAt: old, completedAt: old, updatedAt: old, childResultHash: hash,
      reportReceipt: { at: old, method: 'parent-acknowledged', parentConversationId: 'parent-cleanup', resultHash: hash } }]))
  } })
  assert.ok((await api.read('_ai-delegations.json')).some((record) => record.id === id))
  const barrier = await api.barrier('_completed-ai-cleanup-backups', 'rename', { prefix: true })
  await api.enableCleanup(); await api.tick(15 * 60_000)
  await barrier.reached
  try {
    await independent(api, t)
    const state = await api.call(`/api/maps/${api.ids[0]}/ai-delegations`)
    assert.equal(state.status, 200)
  } finally { barrier.release() }
  let rows
  for (let n = 0; n < 100; n++) { rows = await api.read('_ai-delegations.json'); if (!rows.some((record) => record.id === id)) break; await pause(20) }
  assert.equal(rows.some((record) => record.id === id), false)
  assert.ok((await api.read('_ai-request-receipts.json')).some((record) => record.id === id))
})
