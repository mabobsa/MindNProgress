import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { newStorageRequestId } from '../server/lib/storageJournal.mjs'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const measuredEnv={NODE_OPTIONS:`--import=${new URL('./helpers/fault-cost-metrics-07.mjs',import.meta.url).href}`}
async function independent(api,t) {
  const results=await Promise.all(api.ids.slice(1,21).map(async(mapId,i)=>{
    const requestId=newStorageRequestId(),text='07 외부 대기와 독립 저장 '+i,start=performance.now()
    const body=JSON.stringify({nodeId:'card-1',text})
    const raw=await fetch(api.base+'/api/maps/'+mapId+'/comments',{method:'POST',headers:{...api.headers,'Idempotency-Key':requestId},body})
    const responseText=await raw.text(),response={status:raw.status,body:JSON.parse(responseText)}
    const elapsedMs=performance.now()-start
    const comments=await api.read('_comments/'+mapId+'.json'),map=await api.read(mapId+'.json')
    assert.equal(response.status,201,JSON.stringify(response))
    assert.equal(response.body.outcome,'committed')
    assert.equal(comments.filter(c=>c.id===response.body.comment.id&&c.text===text).length,1)
    assert.equal(map.version,1)
    return {mapId,requestId,status:response.status,elapsedMs,requestUtf8Bytes:Buffer.byteLength(body),responseUtf8Bytes:Buffer.byteLength(responseText),commentId:response.body.comment.id,commentsSha256:createHash('sha256').update(JSON.stringify(comments)).digest('hex')}
  }))
  t.diagnostic(JSON.stringify({logicalRequests:20,committedIds:results.map(r=>r.requestId),expectedEffects:20,actualEffects:20,maxMs:Math.max(...results.map(r=>r.elapsedMs)),budgetMs:5000,results}))
  assert.ok(results.every(r=>r.elapsedMs<5000),JSON.stringify(results))
}
test('느린 AionUi 표시 조회 중 공용 AI 상태와 무관한 문서 저장은 8초 대기와 독립 20개 저장을 확인한다', { timeout: 60000 }, async (t) => {
  const entered = deferred(), release = deferred()
  const api = await storageApi(t, { documents: 23, env:measuredEnv, mockAion: async (url) => {
    if (url === '/api/conversations/slow-display') { entered.resolve(); await release.promise }
    return { id: url.split('/').at(-1), name: '모의 대화', runtimes: [] }
  } })
  await api.readMetrics(true)
  const display = api.call('/api/integrations/aionui/conversation-display/resolve', 'POST', {}, { 'X-MNP-AI-Conversation-Id': 'slow-display' })
  await entered.promise
  const heldAt=performance.now()
  try {
    await independent(api, t)
    const start = performance.now()
    const state = await api.call('/api/integrations/aionui/conversation-display/resolve', 'POST', {}, { 'X-MNP-AI-Conversation-Id': 'fast-display' })
    assert.equal(state.status, 200); assert.ok(performance.now() - start < 2500)
  } finally { await pause(Math.max(0,8000-(performance.now()-heldAt)));release.resolve() }
  assert.equal((await display).status, 200)
  t.diagnostic(JSON.stringify({category:'장애',scenario:'aion-delay',metrics:await api.readMetrics()}))
})

test('미연결 Runner의 외부 확인과 정상 25초 long-poll 동안 독립 20문서는 5초 안에 저장한다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 23, env:measuredEnv })
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
  await api.readMetrics(true)
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
  t.diagnostic(JSON.stringify({category:'장애',scenario:'runner-offline',metrics:await api.readMetrics()}))
})

test('완료 이력 백업 파일 대기 중 무관한 저장·AI 상태 조회를 허용하고 재검증 후 8초 대기와 독립 20개 저장 후 정리한다', { timeout: 60000 }, async (t) => {
  const id = 'delegation-cleanup-05', old = '2026-09-01T00:00:00Z', hash = 'a'.repeat(64)
  const api = await storageApi(t, { documents: 23, env:measuredEnv, seed: async ({ data, ids }) => {
    await writeFile(path.join(data, '_ai-delegations.json'), JSON.stringify([{ id, mapId: ids[0], parentMapId: ids[0],
      parentCardId: 'card-0', targetCardId: 'card-1', parentConversationId: 'parent-cleanup', targetConversationId: 'child-cleanup',
      state: 'completed', childStatus: 'completed', createdAt: old, completedAt: old, updatedAt: old, childResultHash: hash,
      reportReceipt: { at: old, method: 'parent-acknowledged', parentConversationId: 'parent-cleanup', resultHash: hash } }]))
  } })
  assert.ok((await api.read('_ai-delegations.json')).some((record) => record.id === id))
  await api.readMetrics(true)
  const barrier = await api.barrier('_completed-ai-cleanup-backups', 'rename', { prefix: true })
  await api.enableCleanup(); await api.tick(15 * 60_000)
  await barrier.reached
  const heldAt=performance.now()
  try {
    await independent(api, t)
    const state = await api.call(`/api/maps/${api.ids[0]}/ai-delegations`)
    assert.equal(state.status, 200)
  } finally { await pause(Math.max(0,8000-(performance.now()-heldAt)));barrier.release() }
  let rows
  for (let n = 0; n < 100; n++) { rows = await api.read('_ai-delegations.json'); if (!rows.some((record) => record.id === id)) break; await pause(20) }
  assert.equal(rows.some((record) => record.id === id), false)
  assert.ok((await api.read('_ai-request-receipts.json')).some((record) => record.id === id))
  t.diagnostic(JSON.stringify({category:'장애',scenario:'completed-cleanup',metrics:await api.readMetrics()}))
})
