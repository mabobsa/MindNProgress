import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { createInbox, defaultStateDirectory, parseProjectCodes, readableDoorayText } from '../extensions/dooray-mention-inbox/server/inbox.mjs'
import { stageExtension } from '../extensions/dooray-mention-inbox/scripts/build.mjs'
import { createWebServer, loadWebSettings, startWebServer } from '../extensions/dooray-mention-inbox/server/web.mjs'
import { buildContinuePrompt, claudeNewChatUrl, formatTime, isDoorayUrl } from '../extensions/dooray-mention-inbox/shared/inbox-shared.mjs'

const NOW = new Date('2026-11-05T03:00:00.000Z')
const ok = (result, extra = {}) => ({ header: { isSuccessful: true, resultCode: 0 }, result, ...extra })
const member = (id, name) => ({ type: 'member', member: { organizationMemberId: id, ...(name ? { name } : {}) } })

// 가짜 Dooray: 나(1000001)를 본문·댓글에서 멘션한 업무, 나를 담당으로 지정한 업무, 관계없는 업무를 가진 프로젝트 하나.
// 실제 Dooray 구성원 ID는 숫자이고 멘션 판정도 숫자 ID만 인식하므로 가짜 ID도 숫자로 둔다.
function fakeDooray({ meId = '1000001', meName = '기획자' } = {}) {
  const calls = []
  const posts = [
    { id: '1001', subject: '로비 화면 문구 검토', taskNumber: 'PRJ/1', number: 1, updatedAt: '2026-11-04T10:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z',
      users: { from: member('2000001', '개발자'), to: [member('2000002')], cc: [] }, workflow: { name: '진행 중' },
      body: { mimeType: 'text/x-markdown', content: `[@${meName}](dooray://1/members/${meId} "member") 문구 확인 부탁드립니다.\n두 번째 줄` },
      logs: [
        { id: '5001', type: 'comment', createdAt: '2026-11-04T09:00:00.000Z', creator: member('2000002'), body: { mimeType: 'text/x-markdown', content: `[@${meName}](dooray://1/members/${meId}) 이 부분도 봐 주세요` } },
        { id: '5002', type: 'comment', createdAt: '2026-11-04T09:30:00.000Z', creator: member(meId, meName), body: { mimeType: 'text/x-markdown', content: '확인했습니다' } },
      ] },
    { id: '1002', subject: '상점 기획서 반영', taskNumber: 'PRJ/2', number: 2, updatedAt: '2026-11-03T10:00:00.000Z', createdAt: '2026-11-03T08:00:00.000Z',
      users: { from: member('2000001', '개발자'), to: [member(meId, meName)], cc: [] }, workflow: { name: '할 일' },
      body: { mimeType: 'text/html', content: '<p>상점 <b>기획서</b> 반영</p><p>둘째 문단</p>' },
      logs: [{ id: '5003', type: 'comment', createdAt: '2026-11-03T12:00:00.000Z', creator: member('2000001', '개발자'), body: { mimeType: 'text/x-markdown', content: '초안 올렸습니다' } }] },
    { id: '1003', subject: '관계없는 업무', taskNumber: 'PRJ/3', number: 3, updatedAt: '2026-11-02T10:00:00.000Z', createdAt: '2026-11-02T08:00:00.000Z',
      users: { from: member('2000001'), to: [member('2000002')], cc: [] }, workflow: { name: '할 일' },
      body: { mimeType: 'text/x-markdown', content: '나와 무관' }, logs: [] },
  ]
  const respond = (url) => {
    const { pathname, searchParams } = new URL(url)
    calls.push(pathname + (searchParams.size ? `?${searchParams}` : ''))
    if (pathname === '/common/v1/members/me') return ok({ id: meId, name: meName })
    if (pathname.startsWith('/common/v1/members/')) return ok({ id: pathname.split('/').at(-1), name: `구성원${pathname.split('/').at(-1)}` })
    if (pathname === '/project/v1/projects') return ok(searchParams.get('scope') === 'private' && searchParams.get('type') === 'public' ? [{ id: '77', code: 'PRJ', name: '시험 프로젝트' }] : [])
    const postList = /^\/project\/v1\/projects\/77\/posts$/.exec(pathname)
    if (postList) return ok(posts.map(({ body: _body, logs: _logs, ...post }) => post))
    const logs = /^\/project\/v1\/projects\/77\/posts\/(\d+)\/logs$/.exec(pathname)
    if (logs) { const post = posts.find((item) => item.id === logs[1]); return ok(post?.logs ?? [], { totalCount: post?.logs.length ?? 0 }) }
    const detail = /^\/project\/v1\/projects\/77\/posts\/(\d+)$/.exec(pathname)
    if (detail) { const post = posts.find((item) => item.id === detail[1]); return post ? ok({ ...post, project: { id: '77', code: 'PRJ' } }) : null }
    return null
  }
  const fetchImpl = async (url) => {
    const payload = respond(url)
    return payload
      ? new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 404 })
  }
  return { fetchImpl, calls, posts, respond }
}

async function tempState(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-mention-inbox-'))
  t.after(async () => {
    assert.ok(path.basename(directory).startsWith('mnp-mention-inbox-'))
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

const inboxFor = (dooray, stateDirectory, extra = {}) => createInbox({ apiKey: 'test-token', baseUrl: 'http://dooray.test', stateDirectory,
  fetchImpl: dooray.fetchImpl, sleep: async () => {}, now: () => NOW, ...extra })

test('멘션·담당 항목을 번호 목록으로 돌려주고 내가 쓴 댓글과 무관한 업무는 제외한다', async (t) => {
  const dooray = fakeDooray()
  const inbox = inboxFor(dooray, await tempState(t))
  const result = await inbox.list({ days: 14 })
  assert.equal(result.me.id, '1000001')
  assert.deepEqual(result.items.map((item) => [item.no, item.kind, item.postId, item.commentId]), [
    [1, 'mention-body', '1001', null],
    [2, 'mention-comment', '1001', '5001'],
    [3, 'related-comment', '1002', '5003'],
    [4, 'assigned', '1002', null],
  ])
  assert.equal(result.items[0].url, 'https://nhnent.dooray.com/task/77/1001')
  assert.equal(result.items[1].url, 'https://nhnent.dooray.com/task/77/1001#comment-5001')
  assert.ok(result.items.every((item) => item.postId !== '1003'))
  assert.equal(result.hiddenCount, 0)
})

test('번호와 key로 확인 처리하면 다음 목록에서 숨기고, 숨긴 항목 보기와 해제로 되돌린다', async (t) => {
  const dooray = fakeDooray()
  const stateDirectory = await tempState(t)
  const inbox = inboxFor(dooray, stateDirectory)
  const first = await inbox.list()
  const checked = await inbox.setChecked({ numbers: [2, 4, 9] })
  assert.deepEqual(checked.changed.map((item) => item.key), [first.items[1].key, first.items[3].key])
  assert.deepEqual(checked.unknownNumbers, [9])
  assert.equal(checked.changed[0].subject, '로비 화면 문구 검토')

  // 같은 상태 파일을 쓰는 새 프로세스도 확인 표시를 이어받는다.
  const reopened = inboxFor(dooray, stateDirectory)
  const second = await reopened.list()
  assert.deepEqual(second.items.map((item) => item.kind), ['mention-body', 'related-comment'])
  assert.equal(second.hiddenCount, 2)
  assert.deepEqual(second.items.map((item) => item.no), [1, 2], '숨긴 뒤 번호를 다시 매긴다')

  const hidden = await reopened.checkedItems()
  assert.equal(hidden.total, 2)
  assert.ok(hidden.items.every((item) => item.subject && item.url && item.acknowledgedAt))
  const again = await reopened.setChecked({ keys: [first.items[1].key] })
  assert.deepEqual(again.unchanged, [first.items[1].key])

  const restored = await reopened.setChecked({ keys: [first.items[1].key], checked: false })
  assert.equal(restored.changed.length, 1)
  const third = await reopened.list()
  assert.equal(third.items.length, 3)
  assert.equal(third.hiddenCount, 1)
})

test('Dooray 사용자가 바뀌면 확인 표시와 캐시를 사용자별로 나눠 쓴다', async (t) => {
  const stateDirectory = await tempState(t)
  const first = inboxFor(fakeDooray(), stateDirectory)
  await first.list()
  await first.setChecked({ numbers: [1] })
  const otherUser = inboxFor(fakeDooray({ meId: '2000002', meName: '다른 사람' }), stateDirectory)
  const otherList = await otherUser.list()
  assert.equal(otherList.hiddenCount, 0)
  assert.ok(otherList.items.length > 0)
  const state = JSON.parse(await readFile(path.join(stateDirectory, 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(state.users).sort(), ['1000001', '2000002'])
  assert.equal(Object.keys(state.users['1000001'].acks).length, 1)
  assert.equal(Object.keys(state.users['2000002'].acks).length, 0)
})

test('상세 조회는 줄바꿈을 살린 본문과 시간순 댓글, 작성자 이름을 돌려준다', async (t) => {
  const dooray = fakeDooray()
  const inbox = inboxFor(dooray, await tempState(t))
  const detail = await inbox.detail({ projectId: '77', postId: '1001', commentId: '5001' })
  assert.equal(detail.subject, '로비 화면 문구 검토')
  assert.equal(detail.body, '@기획자 문구 확인 부탁드립니다.\n두 번째 줄')
  assert.deepEqual(detail.comments.map((comment) => comment.id), ['5001', '5002'])
  assert.equal(detail.comments[0].author, '구성원2000002', '이름 없는 작성자는 구성원 조회로 채운다')
  assert.equal(detail.focusCommentId, '5001')
  assert.ok(dooray.calls.some((call) => call.includes('/posts/1001/logs') && call.includes('order=-createdAt')))
  const html = await inbox.detail({ projectId: '77', postId: '1002' })
  assert.equal(html.body, '상점 기획서 반영\n둘째 문단')
  await assert.rejects(inbox.detail({ projectId: '77', postId: '9999' }), { code: 'NOT_FOUND' })
  await assert.rejects(inbox.detail({ projectId: '../x', postId: '1' }), { code: 'INVALID_ID' })
})

test('수집이 대기 시간을 넘기면 진행 상황을 돌려주고, 백그라운드 결과는 보여 줄 때만 번호를 바꾼다', async (t) => {
  const dooray = fakeDooray()
  const stateDirectory = await tempState(t)
  let delayMs = 0
  const slowFetch = async (url) => { if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs)); return dooray.fetchImpl(url) }
  const inbox = inboxFor({ fetchImpl: slowFetch }, stateDirectory)
  const shown = await inbox.listWithin({ waitMs: 10_000 })
  assert.equal(shown.status, 'ready')
  const firstKey = shown.items[0].key

  // 새 멘션 댓글이 달린 뒤 느린 수집을 시작한다. 대기 시간 안에 끝나지 않으면 진행 상황만 돌려준다.
  dooray.posts[0].updatedAt = '2026-11-05T01:00:00.000Z'
  dooray.posts[0].logs.push({ id: '5009', type: 'comment', createdAt: '2026-11-05T01:00:00.000Z', creator: member('2000002'),
    body: { mimeType: 'text/x-markdown', content: '[@기획자](dooray://1/members/1000001) 새 요청입니다' } })
  delayMs = 25
  const pending = await inbox.listWithin({ waitMs: 20 })
  assert.equal(pending.status, 'scanning')
  assert.ok(pending.progress.phase)

  // 백그라운드 수집이 끝나도, 사용자가 본 이전 목록의 1번은 그대로 이전 항목을 가리킨다.
  const again = await inbox.listWithin({ waitMs: 20 })
  assert.equal(again.status, 'scanning', '진행 중인 수집에 이어서 기다린다')
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  const checked = await inbox.setChecked({ numbers: [1] })
  assert.deepEqual(checked.changed.map((item) => item.key), [firstKey])

  // 다음 요청은 끝난 수집 결과를 바로 보여 주고, 이미 확인 처리한 항목은 이 시점에 거른다.
  delayMs = 0
  const ready = await inbox.listWithin({ waitMs: 10 })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.items[0].commentId, '5009', '새 멘션 댓글이 1번이 된다')
  assert.ok(ready.items.every((item) => item.key !== firstKey))
  assert.equal(ready.hiddenCount, 1)
})

test('설정 값 해석과 읽기용 본문 변환', () => {
  assert.deepEqual(parseProjectCodes(' PRJ, ABC  PRJ\nDEF '), ['PRJ', 'ABC', 'DEF'])
  assert.deepEqual(parseProjectCodes(''), [])
  assert.equal(defaultStateDirectory({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\u' }),
    path.join('C:\\Users\\u\\AppData\\Roaming', 'dooray-mention-inbox'))
  assert.equal(defaultStateDirectory({ env: {}, platform: 'darwin', home: '/Users/u' }), path.join('/Users/u', 'Library', 'Application Support', 'dooray-mention-inbox'))
  assert.equal(defaultStateDirectory({ env: { DOORAY_MENTION_INBOX_STATE_DIR: '/tmp/x' }, platform: 'win32', home: '/h' }), '/tmp/x')
  assert.deepEqual(readableDoorayText('![캡처](/files/1) 확인\n\n\n\n다음'), { text: '[이미지] 확인\n\n다음', truncated: false })
  assert.deepEqual(readableDoorayText('가'.repeat(12), 'text/x-markdown', 10), { text: `${'가'.repeat(10)}…`, truncated: true })
  assert.throws(() => createInbox({ apiKey: '' }), { code: 'TOKEN_MISSING' })
})

const extensionDirectory = path.resolve(import.meta.dirname, '../extensions/dooray-mention-inbox')
const extensionDepsInstalled = existsSync(path.join(extensionDirectory, 'node_modules/@modelcontextprotocol/ext-apps/package.json'))
const skipWithoutDeps = extensionDepsInstalled ? false : '확장 의존성이 없습니다: npm install --prefix extensions/dooray-mention-inbox'
const extensionRequire = createRequire(path.join(extensionDirectory, 'package.json'))
const loadFromExtension = async (specifier) => import(pathToFileURL(extensionRequire.resolve(specifier)).href)

// 시험 파일 하나에서 한 번만 단계 폴더(.mcpb에 들어갈 파일)를 만든다.
let stagePromise = null
const stagedExtension = () => (stagePromise ??= (async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-mention-inbox-stage-'))
  await stageExtension(directory)
  return directory
})())
after(async () => {
  if (!stagePromise) return
  const directory = await stagePromise.catch(() => null)
  if (directory && path.basename(directory).startsWith('mnp-mention-inbox-stage-')) await rm(directory, { recursive: true, force: true })
})

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// fetch는 Host 헤더를 바꿀 수 없어 보안 검사 시험에는 http.request를 쓴다.
function rawRequest({ port, pathname, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: pathname, method, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

async function fakeDoorayHttp(t, dooray = fakeDooray()) {
  const http = createServer((request, response) => {
    const payload = dooray.respond(`http://dooray.test${request.url}`)
    response.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload ?? {}))
  })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => http.close(resolve)))
  return { dooray, baseUrl: `http://127.0.0.1:${http.address().port}` }
}

async function connectStaged(t, env) {
  const stage = await stagedExtension()
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DOORAY_')))
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(stage, 'server', 'main.mjs')], stderr: 'pipe', env: { ...clean, ...env } })
  const client = new Client({ name: 'mention-inbox-test', version: '1.0.0' })
  await client.connect(transport)
  t.after(() => client.close())
  return client
}

test('화면 상태는 저장된 목록을 바로 돌려주고, 새로고침 수집의 진행률·결과와 숨긴 항목을 함께 준다', async (t) => {
  const dooray = fakeDooray()
  let delayMs = 0
  const fetchImpl = async (url) => { if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs)); return dooray.fetchImpl(url) }
  const inbox = inboxFor({ fetchImpl }, await tempState(t))
  const empty = await inbox.uiState()
  assert.deepEqual([empty.scan.status, empty.items.length, empty.presentedAt], ['idle', 0, null])

  const refreshed = await inbox.uiState({ refresh: true, waitMs: 5_000 })
  assert.equal(refreshed.scan.status, 'updated')
  assert.equal(refreshed.items.length, 4)
  assert.equal(refreshed.rangeDays, 14)
  assert.ok(refreshed.presentedAt)
  assert.ok(refreshed.items.every((item) => item.key && item.subject && item.url))

  await inbox.setChecked({ keys: [refreshed.items[0].key] })
  const afterCheck = await inbox.uiState()
  assert.equal(afterCheck.scan.status, 'idle')
  assert.equal(afterCheck.items.length, 3)
  assert.equal(afterCheck.checkedTotal, 1)
  assert.equal(afterCheck.checked[0].key, refreshed.items[0].key)
  assert.equal(afterCheck.checked[0].subject, refreshed.items[0].subject)

  // 느린 수집 중에는 저장된 목록을 그대로 보여 주며 진행률을 알리고, 끝나면 새 목록으로 바꾼다.
  delayMs = 25
  const scanning = await inbox.uiState({ refresh: true, waitMs: 10 })
  assert.equal(scanning.scan.status, 'scanning')
  assert.equal(scanning.items.length, 3)
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  const finished = await inbox.uiState({ waitMs: 10 })
  assert.equal(finished.scan.status, 'updated')
  assert.equal(finished.items.length, 3)
})

test('화면 공통 함수: Dooray 링크 확인, 이어가기 요청 문구, Claude 새 대화 링크', () => {
  assert.equal(isDoorayUrl('https://nhnent.dooray.com/task/1/2#comment-3'), true)
  for (const url of ['javascript:alert(1)', 'http://nhnent.dooray.com/task/1/2', 'https://evil.test/dooray.com', 'https://dooray.com.evil.test/x', '']) {
    assert.equal(isDoorayUrl(url), false, url)
  }
  const item = { kind: 'mention-comment', subject: '로비 문구', taskNumber: 'PRJ/1', url: 'https://nhnent.dooray.com/task/77/1001#comment-5001', projectId: '77', postId: '1001', commentId: '5001' }
  const prompt = buildContinuePrompt(item)
  assert.match(prompt, /get_dooray_task_detail/)
  assert.match(prompt, /- 업무: 로비 문구 \(PRJ\/1\)/)
  assert.match(prompt, /- 종류: 댓글 멘션/)
  assert.match(prompt, /projectId=77 postId=1001 commentId=5001/)
  const link = claudeNewChatUrl(prompt)
  assert.ok(link.startsWith('claude://claude.ai/new?q='))
  assert.equal(decodeURIComponent(link.slice('claude://claude.ai/new?q='.length)), prompt)
  assert.equal(formatTime('잘못된 값'), '')
})

test('브라우저 화면 서버는 포트와 접근 키를 저장해 다시 쓰고, 이미 실행 중인 같은 서버를 재사용하며, 다른 프로그램이 포트를 쓰면 새 포트를 고른다', async (t) => {
  const directory = await tempState(t)
  const first = await loadWebSettings(directory)
  assert.ok(first.port >= 38100 && first.port <= 38999)
  assert.match(first.key, /^[a-f0-9]{48}$/)
  assert.deepEqual(await loadWebSettings(directory), first)

  const getInbox = () => ({ uiState: async () => ({ items: [] }), setChecked: async () => ({}) })
  const own = await startWebServer({ getInbox, html: '<html></html>', stateDirectory: directory })
  t.after(() => own.close())
  assert.equal(own.url, `http://127.0.0.1:${first.port}/?key=${first.key}`)
  const shared = await startWebServer({ getInbox, html: '<html></html>', stateDirectory: directory })
  assert.equal(shared.shared, true)
  assert.equal(shared.url, own.url)

  await own.close()
  const foreign = createServer((_request, response) => { response.writeHead(200); response.end('other') })
  await new Promise((resolve) => foreign.listen(first.port, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => foreign.close(resolve)))
  const moved = await startWebServer({ getInbox, html: '<html></html>', stateDirectory: directory })
  t.after(() => moved.close())
  assert.notEqual(moved.url, own.url)
  const saved = JSON.parse(await readFile(path.join(directory, 'web.json'), 'utf8'))
  assert.equal(moved.url, `http://127.0.0.1:${saved.port}/?key=${first.key}`, '접근 키는 유지하고 포트만 바꾼다')
})

test('브라우저 화면 API는 접근 키·Host·Origin을 확인하고 목록 조회와 확인 처리를 제공한다', async (t) => {
  const inbox = inboxFor(fakeDooray(), await tempState(t))
  const port = await freePort()
  const key = 'a'.repeat(48)
  const web = createWebServer({ getInbox: () => inbox, html: '<html><meta name="dooray-mention-inbox-mode" content="app"></html>', key, port })
  await web.listen()
  t.after(() => web.close())
  const headers = { 'X-Inbox-Key': key }

  const page = await rawRequest({ port, pathname: `/?key=${key}` })
  assert.equal(page.status, 200)
  assert.match(page.text, /content="web"/, '브라우저로 열면 화면이 web 모드로 동작한다')
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal((await rawRequest({ port, pathname: '/?key=wrong' })).status, 403)
  assert.equal((await rawRequest({ port, pathname: '/api/state' })).status, 403)
  assert.equal((await rawRequest({ port, pathname: '/api/state', headers: { ...headers, Host: `evil.test:${port}` } })).status, 403)
  assert.equal((await rawRequest({ port, pathname: '/api/state', headers: { ...headers, Origin: 'http://evil.test' } })).status, 403)
  assert.equal((await rawRequest({ port, pathname: '/api/check', method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)

  const state = JSON.parse((await rawRequest({ port, pathname: '/api/state?refresh=1&days=14', headers })).text)
  assert.equal(state.scan.status, 'updated')
  assert.equal(state.items.length, 4)
  const checked = await rawRequest({ port, pathname: '/api/check', method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ keys: [state.items[0].key], checked: true }) })
  assert.equal(checked.status, 200)
  const after = JSON.parse((await rawRequest({ port, pathname: '/api/state', headers })).text)
  assert.equal(after.items.length, 3)
  assert.equal(after.checkedTotal, 1)
  assert.equal(JSON.parse((await rawRequest({ port, pathname: '/api/ping', headers })).text).name, 'dooray-mention-inbox')
})

test('확장 서버는 확인함 화면 도구·화면 전용 도구·화면 리소스와 브라우저 화면을 함께 제공한다', { timeout: 180_000, skip: skipWithoutDeps }, async (t) => {
  const { baseUrl } = await fakeDoorayHttp(t)
  const directory = await tempState(t)
  const client = await connectStaged(t, { DOORAY_API_TOKEN: 'test-token', DOORAY_API_BASE_URL: baseUrl, DOORAY_MENTION_INBOX_STATE_DIR: directory })
  assert.equal(client.getServerVersion()?.name, 'dooray-mention-inbox')
  assert.equal(client.getServerVersion()?.version, '0.2.0')
  assert.match(client.getInstructions() ?? '', /open_dooray_mention_inbox로 확인함 화면을 여세요/)

  const tools = (await client.listTools()).tools
  assert.deepEqual(tools.map((tool) => tool.name).sort(),
    ['check_dooray_mentions', 'dooray_inbox_state', 'get_dooray_task_detail', 'list_dooray_mentions', 'open_dooray_mention_inbox'])
  const open = tools.find((tool) => tool.name === 'open_dooray_mention_inbox')
  assert.equal(open._meta.ui.resourceUri, 'ui://dooray-mention-inbox/inbox.html')
  assert.deepEqual(tools.find((tool) => tool.name === 'dooray_inbox_state')._meta.ui.visibility, ['app'])

  const resources = (await client.listResources()).resources
  assert.ok(resources.some((resource) => resource.uri === 'ui://dooray-mention-inbox/inbox.html' && resource.mimeType === 'text/html;profile=mcp-app'))
  const html = (await client.readResource({ uri: 'ui://dooray-mention-inbox/inbox.html' })).contents[0].text
  assert.match(html, /<script>/)
  assert.match(html, /dooray-mention-inbox-mode" content="app"/)
  assert.doesNotMatch(html, /APP_SCRIPT/)

  assert.match((await client.callTool({ name: 'open_dooray_mention_inbox', arguments: {} })).content[0].text, /확인함 화면을 열었습니다/)
  const state = (await client.callTool({ name: 'dooray_inbox_state', arguments: { refresh: true } })).structuredContent
  assert.equal(state.scan.status, 'updated')
  assert.equal(state.items.length, 4)
  assert.match(state.browserUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?key=[a-f0-9]{48}$/)

  // 같은 확장 서버가 띄운 브라우저 화면이 같은 상태 파일을 쓴다.
  const browser = new URL(state.browserUrl)
  const page = await fetch(state.browserUrl)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /content="web"/)
  const key = browser.searchParams.get('key')
  const viaWeb = await (await fetch(`${browser.origin}/api/state`, { headers: { 'X-Inbox-Key': key } })).json()
  assert.equal(viaWeb.items.length, 4)
  await fetch(`${browser.origin}/api/check`, { method: 'POST', headers: { 'X-Inbox-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [viaWeb.items[0].key] }) })
  const afterWeb = (await client.callTool({ name: 'dooray_inbox_state', arguments: {} })).structuredContent
  assert.equal(afterWeb.items.length, 3)
  assert.equal(afterWeb.checked[0].key, viaWeb.items[0].key)
  await client.callTool({ name: 'check_dooray_mentions', arguments: { keys: [viaWeb.items[0].key], checked: false } })
  assert.equal((await client.callTool({ name: 'dooray_inbox_state', arguments: {} })).structuredContent.items.length, 4)

  const detail = await client.callTool({ name: 'get_dooray_task_detail', arguments: { projectId: '77', postId: '1001', commentId: '5001' } })
  assert.match(detail.content[0].text, /← 목록에서 선택한 댓글/)
  const listed = await client.callTool({ name: 'list_dooray_mentions', arguments: {} })
  assert.match(listed.content[0].text, /확인할 항목 4건/)
})

test('토큰이 없어도 확장 서버는 시작하고, 화면 상태 도구는 설정 안내를 돌려준다', { timeout: 120_000, skip: skipWithoutDeps }, async (t) => {
  const directory = await tempState(t)
  const client = await connectStaged(t, { DOORAY_API_TOKEN: '${user_config.dooray_api_token}', DOORAY_MENTION_PROJECT_CODES: '${user_config.project_codes}', DOORAY_MENTION_INBOX_STATE_DIR: directory })
  assert.equal((await client.listTools()).tools.length, 5)
  const state = await client.callTool({ name: 'dooray_inbox_state', arguments: { refresh: true } })
  assert.equal(state.isError, true)
  assert.match(state.content[0].text, /Dooray API 토큰이 설정되지 않았습니다/)
  assert.match((await client.callTool({ name: 'open_dooray_mention_inbox', arguments: {} })).content[0].text, /확인함 화면을 열었습니다/)
})

test('브라우저로 열기는 브라우저 화면 주소를 기본 브라우저에 넘기고, 화면 서버가 없으면 오류를 알린다', { skip: skipWithoutDeps }, async () => {
  // 서버 모듈과 같은 MCP SDK 사본을 써야 메모리 전송으로 연결할 수 있다.
  const { createServer: createMcpServer } = await import(pathToFileURL(path.join(extensionDirectory, 'server', 'index.mjs')).href)
  const { Client: ExtensionClient } = await loadFromExtension('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await loadFromExtension('@modelcontextprotocol/sdk/inMemory.js')
  const connect = async (options) => {
    const server = createMcpServer(options)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new ExtensionClient({ name: 'open-browser-test', version: '1.0.0' })
    await client.connect(clientTransport)
    return client
  }
  const opened = []
  const url = `http://127.0.0.1:38123/?key=${'b'.repeat(48)}`
  const client = await connect({ getInbox: () => { throw new Error('호출되면 안 됨') }, getBrowserUrl: () => url, openBrowser: (target) => opened.push(target) })
  const result = await client.callTool({ name: 'open_dooray_mention_inbox', arguments: { browser: true } })
  assert.match(result.content[0].text, /기본 브라우저에서/)
  assert.deepEqual(opened, [url])
  await client.close()

  const withoutWeb = await connect({ getBrowserUrl: () => null, openBrowser: () => { throw new Error('호출되면 안 됨') } })
  const failed = await withoutWeb.callTool({ name: 'open_dooray_mention_inbox', arguments: { browser: true } })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /브라우저 화면을 열 수 없습니다/)
  await withoutWeb.close()
})
