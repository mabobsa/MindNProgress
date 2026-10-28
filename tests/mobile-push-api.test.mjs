import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { storageApi } from './helpers/storage-api-harness.mjs'

test('발송 API는 로그인·대상 권한을 확인하고 로컬 중계 접수를 반환한다', { timeout: 60000 }, async (t) => {
  const token = 'a'.repeat(43)
  let received
  const relay = createServer(async (request, response) => {
    assert.equal(request.url, '/api/internal/mobile-push/mnp')
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString())
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ state: 'queued', eventId: received.eventId }))
  })
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => relay.close(resolve)))
  let relayFile
  const env = {}
  const api = await storageApi(t, { documents: 1,
    seed: async ({ data }) => {
      relayFile = path.join(data, '_relay.json')
      await writeFile(relayFile, JSON.stringify({ schemaVersion: 1, baseUrl: `http://127.0.0.1:${relay.address().port}`, token }))
      env.AIONUI_PUSH_RELAY_FILE = relayFile
    },
    env,
  })
  const route = '/api/integrations/aionui/push-notifications'
  const body = { machineId: 'isolated-storage', eventId: 'event-1', kind: 'info', title: '업무 알림', body: '상세 내용' }
  assert.equal((await fetch(api.base + route, { method: 'POST' })).status, 401)
  assert.equal((await api.call(route, 'POST', body)).status, 403)
  const login = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'isolated@mind.local', password: 'IsolatedOnly!2026' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const response = await fetch(api.base + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(response.status, 202)
  assert.equal((await response.json()).receivedOnPhone, false)
  assert.equal(received.body, '상세 내용')
})
