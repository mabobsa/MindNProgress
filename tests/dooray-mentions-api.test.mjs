import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const adminPassword = 'dooray-mention-admin-password'
const meId = '1561544322715661170'
const mentionMarkup = `[@김용민](dooray://1387695619080878080/members/${meId} "me")`

async function waitForServer(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // 서버 시작 대기
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Dooray 참조 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

function createUpstream(state) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://upstream.invalid')
    state.paths.push(url.pathname)
    const send = (result) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ header: { isSuccessful: true, resultCode: 0, resultMessage: '' }, result }))
    }
    if (url.pathname === '/common/v1/members/me') return send({ id: meId, name: '김용민' })
    if (url.pathname === '/project/v1/projects') {
      const isPrimary = url.searchParams.get('scope') === 'private' && url.searchParams.get('type') === 'public'
      return send(isPrimary ? state.projects : [])
    }
    if (url.pathname === '/project/v1/projects/p1/posts') {
      state.postQueries.push(url.searchParams.get('updatedAt'))
      return send(Number(url.searchParams.get('page')) === 0 ? state.posts : [])
    }
    if (url.pathname === '/project/v1/projects/p1/posts/a1') return send(state.detail)
    if (url.pathname === '/project/v1/projects/p1/posts/a1/logs') {
      state.onLogsRequest?.()
      if (state.logsGate) await state.logsGate
      return send(state.logs)
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ header: { isSuccessful: false, resultMessage: 'null' } }))
  })
}

async function waitForScan(baseUrl, headers, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/integrations/dooray/mentions`, { headers })
    assert.equal(response.status, 200)
    const body = await response.json()
    if (body.scan.status !== 'running') return body
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Dooray 참조 수집이 제한 시간 안에 끝나지 않았습니다.')
}

test('기간을 지정해 Dooray 참조를 수집하고 확인 상태를 저장한다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-dooray-mentions-'))
  const state = {
    paths: [],
    postQueries: [],
    projects: [{ id: 'p1', code: 'roy-jp', name: 'J로얄' }],
    posts: [{
      id: 'a1',
      number: 70,
      taskNumber: 'roy-jp/70',
      subject: '[J로얄]<서버> 로그인 구현',
      createdAt: '2026-09-04T10:00:00+09:00',
      updatedAt: '2026-09-09T18:54:53+09:00',
      closed: false,
      workflowClass: 'working',
      workflow: { id: 'w1', name: '진행 중' },
      project: { id: 'p1', code: 'roy-jp' },
      users: {
        from: { type: 'member', member: { organizationMemberId: '200', name: '천기환' } },
        to: [{ type: 'member', member: { organizationMemberId: meId, name: '김용민' } }],
        cc: [],
      },
    }],
    logs: [{
      id: 'c1',
      type: 'comment',
      createdAt: '2026-09-07T16:08:15+09:00',
      creator: { type: 'member', member: { organizationMemberId: '200', name: '천기환' } },
      body: { mimeType: 'text/x-markdown', content: `${mentionMarkup} 프로토콜 공유드립니다` },
    }],
  }
  state.detail = {
    ...state.posts[0],
    body: { mimeType: 'text/x-markdown', content: '본문에는 멘션이 없습니다.' },
  }

  const upstream = createUpstream(state)
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object')

  const port = 30_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_ADMIN_PASSWORD: adminPassword,
      MNP_DOORAY_API_KEY: 'integration-dooray-key',
      MNP_DOORAY_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      MNP_DOORAY_WEB_HOST: 'nhnent.dooray.com',
    },
    stdio: 'ignore',
  })

  try {
    await waitForServer(baseUrl)
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@mind.local', password: adminPassword }),
    })
    assert.equal(loginResponse.status, 200)
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' }

    const empty = await fetch(`${baseUrl}/api/integrations/dooray/mentions`, { headers })
    assert.equal(empty.status, 200)
    const emptyBody = await empty.json()
    assert.deepEqual(emptyBody.items, [])
    assert.equal(emptyBody.scan.status, 'idle')
    assert.equal(emptyBody.lastScan, null)
    assert.equal(emptyBody.preferences, null)

    const initialProjectsResponse = await fetch(`${baseUrl}/api/integrations/dooray/mentions/projects`, { headers })
    assert.equal(initialProjectsResponse.status, 200)
    const initialProjects = await initialProjectsResponse.json()
    assert.deepEqual(initialProjects.projects, [{ id: 'p1', code: 'roy-jp', name: 'J로얄' }])
    assert.deepEqual(initialProjects.selectedProjectIds, [])

    const noProjectScan = await fetch(`${baseUrl}/api/integrations/dooray/mentions/scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ since: '2026-09-03T00:00:00+09:00', until: '2026-09-10T00:00:00+09:00' }),
    })
    assert.equal(noProjectScan.status, 400)
    assert.equal((await noProjectScan.json()).code, 'PROJECT_SELECTION_REQUIRED')

    const selectionResponse = await fetch(`${baseUrl}/api/integrations/dooray/mentions/projects`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ projectIds: ['p1'] }),
    })
    assert.equal(selectionResponse.status, 200)
    assert.deepEqual((await selectionResponse.json()).selectedProjectIds, ['p1'])

    const preferencesResponse = await fetch(`${baseUrl}/api/integrations/dooray/mentions/preferences`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        since: '2026-09-08',
        until: '2026-09-10',
        quickRangeId: 'two-days',
        sortOrder: 'time-asc',
        includeBody: false,
        includeComments: false,
        includeAssigned: true,
        includeCc: false,
        unacknowledgedOnly: false,
        hiddenKinds: ['related-comment', 'not-a-kind'],
      }),
    })
    assert.equal(preferencesResponse.status, 200)
    const storedPreferences = (await preferencesResponse.json()).preferences
    assert.deepEqual(storedPreferences, {
      since: '2026-09-08',
      until: '2026-09-10',
      quickRangeId: 'two-days',
      sortOrder: 'time-asc',
      includeBody: false,
      includeComments: false,
      includeAssigned: true,
      includeCc: false,
      unacknowledgedOnly: false,
      hiddenKinds: ['related-comment'],
    })
    const preferencesReloaded = await (await fetch(
      `${baseUrl}/api/integrations/dooray/mentions`,
      { headers },
    )).json()
    assert.deepEqual(preferencesReloaded.preferences, storedPreferences)

    // 새로 초대된 프로젝트는 목록에는 보이지만 자동 선택하지 않는다.
    state.projects.push({ id: 'p2', code: 'new-project', name: '새 프로젝트' })
    const invitedProjects = await (await fetch(
      `${baseUrl}/api/integrations/dooray/mentions/projects`,
      { headers },
    )).json()
    assert.deepEqual(invitedProjects.projects.map((project) => project.id).sort(), ['p1', 'p2'])
    assert.deepEqual(invitedProjects.selectedProjectIds, ['p1'])
    state.paths.length = 0

    const scanResponse = await fetch(`${baseUrl}/api/integrations/dooray/mentions/scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ since: '2026-09-03T00:00:00+09:00', until: '2026-09-10T00:00:00+09:00' }),
    })
    assert.equal(scanResponse.status, 202)
    assert.equal((await scanResponse.json()).scan.status, 'running')

    const scanned = await waitForScan(baseUrl, headers)
    assert.equal(scanned.scan.status, 'idle')
    assert.equal(scanned.scan.error, null)
    assert.equal(scanned.lastScan.scannedPostCount, 1)
    assert.equal(scanned.lastScan.throttledCount, 0)
    assert.equal(scanned.lastScan.webHostname, 'nhnent.dooray.com')
    assert.equal(scanned.lastScan.includeComments, true)
    assert.equal(scanned.lastScan.includeAssigned, true)
    assert.equal(scanned.lastScan.includeCc, true)
    assert.equal(state.postQueries[0], '2026-09-02T15:00:00.000Z')
    assert.equal(state.paths.includes('/project/v1/projects'), false)
    assert.equal(state.paths.includes('/project/v1/projects/p2/posts'), false)

    assert.deepEqual(scanned.items.map((item) => item.kind), ['mention-comment', 'assigned'])
    const mention = scanned.items[0]
    assert.equal(mention.key, 'comment:a1:c1')
    assert.equal(mention.url, 'https://nhnent.dooray.com/task/p1/a1#comment-c1')
    assert.equal(mention.actorName, '천기환')
    assert.equal(mention.excerpt, '@김용민 프로토콜 공유드립니다')
    assert.equal(mention.acknowledgedAt, null)

    const ackResponse = await fetch(`${baseUrl}/api/integrations/dooray/mentions/acknowledgements`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ keys: [mention.key], acknowledged: true }),
    })
    assert.equal(ackResponse.status, 200)
    const acked = await ackResponse.json()
    assert.equal(typeof acked.items.find((item) => item.key === mention.key).acknowledgedAt, 'string')
    assert.equal(acked.items.find((item) => item.kind === 'assigned').acknowledgedAt, null)

    // 프로젝트에서 제외되면 저장된 선택에서도 사라지고, 다시 초대되어도 자동 선택되지 않는다.
    state.projects = [{ id: 'p2', code: 'new-project', name: '새 프로젝트' }]
    const afterRemoval = await (await fetch(
      `${baseUrl}/api/integrations/dooray/mentions/projects`,
      { headers },
    )).json()
    assert.deepEqual(afterRemoval.selectedProjectIds, [])
    state.projects = [
      { id: 'p1', code: 'roy-jp', name: 'J로얄' },
      { id: 'p2', code: 'new-project', name: '새 프로젝트' },
    ]
    const afterReinvite = await (await fetch(
      `${baseUrl}/api/integrations/dooray/mentions/projects`,
      { headers },
    )).json()
    assert.deepEqual(afterReinvite.selectedProjectIds, [])
    await fetch(`${baseUrl}/api/integrations/dooray/mentions/projects`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ projectIds: ['p1'] }),
    })

    const reloaded = await (await fetch(`${baseUrl}/api/integrations/dooray/mentions`, { headers })).json()
    assert.equal(typeof reloaded.items.find((item) => item.key === mention.key).acknowledgedAt, 'string')
    assert.deepEqual(reloaded.preferences, storedPreferences)

    const undoResponse = await fetch(`${baseUrl}/api/integrations/dooray/mentions/acknowledgements`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ keys: [mention.key], acknowledged: false }),
    })
    assert.equal(undoResponse.status, 200)
    assert.equal((await undoResponse.json()).items.find((item) => item.key === mention.key).acknowledgedAt, null)

    const unknownAck = await fetch(`${baseUrl}/api/integrations/dooray/mentions/acknowledgements`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ keys: ['comment:zz:zz'] }),
    })
    assert.equal(unknownAck.status, 404)

    const badRange = await fetch(`${baseUrl}/api/integrations/dooray/mentions/scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ since: '2026-09-10T00:00:00Z', until: '2026-09-03T00:00:00Z' }),
    })
    assert.equal(badRange.status, 400)
    assert.equal((await badRange.json()).code, 'INVALID_RANGE')

    // 두 번째 수집은 업무의 updatedAt이 같으므로 상세와 댓글을 다시 읽지 않는다.
    state.paths.length = 0
    const rescan = await fetch(`${baseUrl}/api/integrations/dooray/mentions/scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ since: '2026-09-03T00:00:00+09:00', until: '2026-09-10T00:00:00+09:00' }),
    })
    assert.equal(rescan.status, 202)
    const rescanned = await waitForScan(baseUrl, headers)
   assert.equal(rescanned.items.length, 2)
   assert.equal(state.paths.includes('/project/v1/projects/p1/posts/a1/logs'), false)

    // 오래 걸리는 재수집 중에 저장한 확인 상태가 수집 시작 시점 값으로 되돌아가지 않아야 한다.
    state.posts[0] = { ...state.posts[0], updatedAt: '2026-09-09T19:00:00+09:00' }
    state.detail = { ...state.detail, updatedAt: state.posts[0].updatedAt }
    let releaseLogs
    let logsStarted
    const logsStartedPromise = new Promise((resolve) => { logsStarted = resolve })
    state.logsGate = new Promise((resolve) => { releaseLogs = resolve })
    state.onLogsRequest = logsStarted
    const racingScan = await fetch(`${baseUrl}/api/integrations/dooray/mentions/scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ since: '2026-09-03T00:00:00+09:00', until: '2026-09-10T00:00:00+09:00' }),
    })
    assert.equal(racingScan.status, 202)
    await Promise.race([
      logsStartedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('댓글 조회가 시작되지 않았습니다.')), 5_000)),
    ])
    try {
      const ackDuringScan = await fetch(`${baseUrl}/api/integrations/dooray/mentions/acknowledgements`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ keys: [mention.key], acknowledged: true }),
      })
      assert.equal(ackDuringScan.status, 200)
    } finally {
      releaseLogs()
      state.logsGate = null
      state.onLogsRequest = null
    }
    const raced = await waitForScan(baseUrl, headers)
    assert.equal(typeof raced.items.find((item) => item.key === mention.key).acknowledgedAt, 'string')

   const anonymous = await fetch(`${baseUrl}/api/integrations/dooray/mentions`)
    assert.equal(anonymous.status, 401)
  } finally {
    server.kill()
    await new Promise((resolve) => server.once('exit', resolve))
    await new Promise((resolve) => upstream.close(resolve))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
