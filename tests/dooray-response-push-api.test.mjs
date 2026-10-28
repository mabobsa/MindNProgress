import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { reconcileDoorayPush } from '../server/lib/doorayResponsePush.mjs'

test('실제 서버의 저장 잠금 밖에서 발송하고 승인으로 미확정 알림을 취소한다', { timeout: 60000 }, async t => {
  const requests = [], replies = []
  const relay = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    replies.push(() => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ state: 'queued' })) })
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  t.after(() => { for (const reply of replies) reply(); relay.closeAllConnections(); relay.close() })
  const env = { MNP_MOBILE_PUSH_MAIN_USER_ID: 'user-editor' }
  const password = 'IsolatedPushOnly!2026'
  const api = await storageApi(t, { documents: 1, env, seed: async ({ data }) => {
    const users = JSON.parse(await readFile(path.join(data, '_users.json'), 'utf8'))
    const owner = users.find(user => user.id === 'user-editor')
    owner.salt = randomBytes(16).toString('hex')
    owner.passwordHash = scryptSync(password, owner.salt, 64).toString('hex')
    await writeFile(path.join(data, '_users.json'), JSON.stringify(users))
    const file = path.join(data, '_relay.json')
    await writeFile(file, JSON.stringify({ schemaVersion: 1, baseUrl: `http://127.0.0.1:${relay.address().port}`, token: 'a'.repeat(43) }))
    env.AIONUI_PUSH_RELAY_FILE = file
    const jobs = ['notify', 'approve'].map(id => {
      const job = { id, userId: 'user-editor', status: 'needs-approval', attempt: 0,
        source: { subject: '검증용 업무', fingerprint: id, item: { key: id, postId: id } },
        settings: { machineId: 'isolated-storage', agentId: 'test', modelId: 'test', pushEnabled: true, pushMachineId: 'isolated-storage' },
        proposal: '표시 수정 제안', decision: { kind: 'approval', reason: '사용자 승인 필요', questions: [],
          approval: { title: '표시 수정', scope: ['금액 표시 수정'], exclusions: ['결제 변경'] } },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      reconcileDoorayPush(job, null, Date.now())
      return job
    })
    await mkdir(path.join(data, '_dooray-responses'))
    await writeFile(path.join(data, '_dooray-responses', 'user-editor.json'), JSON.stringify({ jobs }))
  } })
  const login = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'editor@mind.local', password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const call = async (pathname, body) => {
    const response = await fetch(api.base + pathname, { method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(3000), headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const waitFor = async predicate => {
    for (let index = 0; index < 100; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
    assert.fail('격리 서버의 푸시 상태 갱신 시간 초과')
  }
  await api.tick(3000)
  await waitFor(() => requests.length === 2)
  const route = '/api/integrations/dooray/mentions/responses'
  const { jobs } = await call(route)
  assert.equal(jobs.find(job => job.id === 'notify').pushNotification.state, 'sending')
  const approval = jobs.find(job => job.id === 'approve')
  await call(`${route}/approve/approve`, { proposalRevision: approval.proposalRevision })
  for (const reply of replies) reply()
  replies.length = 0
  await waitFor(async () => (await api.read('_dooray-responses/user-editor.json')).jobs.find(job => job.id === 'notify').pushNotification.state === 'queued')
  const stored = (await api.read('_dooray-responses/user-editor.json')).jobs
  assert.equal(stored.find(job => job.id === 'approve').status, 'approved')
  assert.equal(stored.find(job => job.id === 'approve').pushNotification.state, 'cancelled')
  await api.tick(3000)
  assert.equal(requests.length, 2, '완료된 전송을 중복 접수하지 않는다')
  const forbidden = await api.call('/api/integrations/aionui/push-notifications', 'POST', {
    machineId: 'isolated-storage', eventId: 'forged', kind: 'choice', title: '허용되지 않은 발송', body: '본문', mainUserId: 'user-second',
  }, { 'X-MNP-AI-Editor-Id': 'user-second' })
  assert.equal(forbidden.status, 403, '다른 편집자는 메인 PC 푸시 권한을 얻지 못한다')
  const manual = api.call('/api/integrations/aionui/push-notifications', 'POST', {
    machineId: 'isolated-storage', eventId: 'manual', kind: 'info', title: '직접 발송', body: '본문', mapId: api.ids[0],
  })
  await waitFor(() => requests.length === 3)
  const map = await fetch(`${api.base}/api/maps/${api.ids[0]}`, { headers: api.headers, signal: AbortSignal.timeout(3000) })
  assert.equal(map.status, 200, '직접 발송 API도 관련 문서의 저장 잠금을 점유하지 않는다')
  for (const reply of replies) reply()
  replies.length = 0
  assert.equal((await manual).status, 202)
})
