import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { storageApi } from './helpers/storage-api-harness.mjs'

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const machine = 'outcome-05', leaseId = 'lease-outcome-05', file = '_remote-workspace-pools.json'
const route = `/api/ai-workspaces/${leaseId}/checkpoint`

async function fixture(t) {
  const api = await storageApi(t, { documents: 2, seed: async ({ data, ids }) => {
    // 실제 풀이나 Git 작업공간을 사용하지 않는 격리 상태다. 체크포인트 수행자는 아래 모의 Runner다.
    const registry = { poolId: 'local-fixture', workspaces: [
      { id: 'main', role: 'integration', root: path.join(data, 'unused-main') },
      { id: 'worker', role: 'worker', root: path.join(data, 'unused-worker') },
    ] }
    await writeFile(path.join(data, '../no-pool.json'), JSON.stringify(registry))
    await writeFile(path.join(data, file), JSON.stringify({ schemaVersion: 1, coordinatorId: 'fixture-coordinator',
      pools: { [`${machine}:pool`]: { enabled: true, machineId: machine, poolId: 'pool', protocolVersion: 2, registryDigest: 'a'.repeat(64), workspaces: [] } },
      reports: { [machine]: { machineId: machine, receivedAt: Date.now(), poolId: 'pool', version: 2, registryDigest: 'a'.repeat(64), workspaces: [] } },
      leases: { [leaseId]: { leaseId, jobId: 'job-outcome-05', poolId: 'pool', status: 'leased', conversationId: '',
        mapId: ids[0], cardId: 'card-1', ownership: { machineId: machine, coordinatorId: 'fixture-coordinator', generation: 1 }, checkpoints: [] } },
    }))
  } })
  const login = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: api.env.MNP_ADMIN_EMAIL, password: api.env.MNP_ADMIN_PASSWORD }) })
  assert.equal(login.status, 200, `${await login.text()}\n${api.output()}`)
  const signedIn = { Cookie: login.headers.get('set-cookie').split(';')[0] }
  const created = await api.call('/api/machines', 'POST', { machineId: machine, label: '미확정 경계 모의 Runner' }, signedIn)
  assert.equal(created.status, 200, `${JSON.stringify(created)}\n${api.output()}`)
  const issued = await api.call(`/api/machines/${machine}/token`, 'POST', {}, signedIn)
  assert.equal(issued.status, 200)
  const runner = { Authorization: `Bearer ${issued.body.token}` }
  const headers = { 'X-MNP-AI-Map-Id': api.ids[0], 'X-MNP-AI-Card-Id': 'card-1' }
  const body = { jobId: 'job-outcome-05', requestId: 'checkpoint-outcome-05', confirmNoChanges: true }
  const claim = async (waitMs = 1000) => {
    const response = await api.call(`/api/machines/${machine}/runner/operations/claim`, 'POST', { waitMs }, runner)
    assert.equal(response.status, 200, JSON.stringify(response))
    return response.body.operations
  }
  const completed = new Map()
  let effects = 0
  const complete = async (operation) => {
    const id = operation.request.body.operationId
    if (!completed.has(id)) { effects++; completed.set(id, { noChanges: true }) }
    const response = await api.call(`/api/machines/${machine}/runner/operations/${operation.operationId}/result`, 'POST',
      { ok: true, data: completed.get(id) }, runner)
    assert.equal(response.status, 200, JSON.stringify(response))
  }
  return { api, headers, body, claim, complete, effects: () => effects }
}

for (const mode of ['deadline', 'disconnect']) test(`실제 HTTP 원격 체크포인트 ${mode}: 전달 전 거부와 전달 후 미확정·같은 명령 확인`, { timeout: 20000 }, async (t) => {
  const { api, headers, body, claim, complete, effects } = await fixture(t)
  const before = await api.read(file)
  const expired = await api.call(route, 'POST', body, { ...headers, 'X-MNP-Deadline-At': String(Date.now() - 1) })
  assert.equal(expired.status, 503, JSON.stringify(expired)); assert.equal(expired.body.outcome, 'not-applied')
  assert.equal(expired.body.code, 'REQUEST_DEADLINE_EXCEEDED')
  assert.deepEqual(await api.read(file), before); assert.deepEqual(await claim(1), [])

  const cancel = new AbortController()
  const started = Date.now()
  const work = fetch(api.base + route, { method: 'POST', signal: cancel.signal,
    headers: { ...api.headers, ...headers, 'X-MNP-Deadline-At': String(Date.now() + (mode === 'deadline' ? 1500 : 15000)) },
    body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }), (error) => ({ error }))
  const operations = await claim()
  assert.equal(operations.length, 1)
  const first = operations[0]
  assert.equal(first.request.pathname, '/mnp/workspaces'); assert.equal(first.request.body.action, 'checkpoint')
  if (mode === 'disconnect') cancel.abort()
  const response = await work
  const firstResponseMs = Date.now() - started
  if (mode === 'deadline') {
    assert.equal(response.status, 503, JSON.stringify(response))
    assert.equal(response.body.code, 'REMOTE_WORKSPACE_RESPONSE_PENDING')
    assert.equal(response.body.outcome, 'processing'); assert.equal(response.body.retryable, false)
  } else assert.equal(response.error.name, 'AbortError')
  // 연결이 없어도 같은 오류 경로를 마쳤는지 서버의 최소 진단으로 확인한다.
  for (let n = 0; n < 100 && !api.output().includes('REMOTE_WORKSPACE_RESPONSE_PENDING'); n++) await pause(20)
  const diagnostic = api.output().split('\n').find((line) => line.startsWith('[Storage request]') && line.includes('REMOTE_WORKSPACE_RESPONSE_PENDING'))
  assert.ok(diagnostic, api.output())
  assert.equal(JSON.parse(diagnostic.slice('[Storage request] '.length)).outcome, 'processing')
  const pending = (await api.read(file)).leases[leaseId]
  assert.equal(pending.pendingOperation, first.request.body.operationId)
  assert.equal(pending.checkpoints.length, 0)
  const other = await api.call(route, 'POST', { ...body, requestId: 'different-command' }, headers)
  assert.equal(other.status, 409); assert.equal(other.body.code, 'REMOTE_WORKSPACE_OPERATION_PENDING')
  assert.deepEqual(await claim(1), [])

  // HTTP 응답 기한/연결 종료 뒤에도 Runner의 실제 완료는 가능하다.
  await complete(first); assert.equal(effects(), 1)
  if (mode === 'deadline') await api.restart()
  const retry = api.call(route, 'POST', body, headers)
  const repeated = await claim()
  assert.equal(repeated.length, 1)
  assert.deepEqual(repeated[0].request.body, first.request.body, '전송용 큐 ID와 별개로 영속 명령 ID·원문은 동일하다')
  await complete(repeated[0])
  const result = await retry
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.noChanges, true)
  assert.equal(effects(), 1)
  assert.equal((await api.read(file)).leases[leaseId].pendingOperation, undefined)
  assert.deepEqual(await claim(1), [])
  t.diagnostic(JSON.stringify({ mode, firstResponseMs, effects: effects(), sameOperation: true,
    preExecution: 'not-applied', postDispatch: mode === 'deadline' ? response.body.outcome : '연결 종료 후 같은 명령 확인' }))
})
