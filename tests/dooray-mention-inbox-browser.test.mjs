import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { rolldown } from 'rolldown'

import { stageExtension } from '../extensions/dooray-mention-inbox/scripts/build.mjs'

// Dooray 멘션 확인함 화면을 실제 Chrome으로 확인한다.
// - 브라우저 화면: 확장 서버가 띄운 로컬 웹 화면을 그대로 연다.
// - 대화창 안 화면: MCP Apps SDK의 AppBridge로 Claude 앱 같은 Host 페이지를 만들고, 도구 호출은 실제 확장 서버로 전달한다.
const extensionDirectory = path.resolve(import.meta.dirname, '../extensions/dooray-mention-inbox')
const browserExecutable = process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const skip = process.env.MNP_BROWSER_TEST !== '1' ? 'MNP_BROWSER_TEST=1일 때만 실행합니다.'
  : !existsSync(path.join(extensionDirectory, 'node_modules/@modelcontextprotocol/ext-apps/package.json')) ? '확장 의존성이 없습니다: npm install --prefix extensions/dooray-mention-inbox'
    : !existsSync(browserExecutable) ? `브라우저가 없습니다: ${browserExecutable}` : false

const ok = (result, extra = {}) => ({ header: { isSuccessful: true, resultCode: 0 }, result, ...extra })
const member = (id, name) => ({ type: 'member', member: { organizationMemberId: id, ...(name ? { name } : {}) } })
const step = (label) => { if (process.env.MNP_MENTION_INBOX_TRACE) process.stderr.write(`[browser-test] ${label}
`) }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeDoorayResponder() {
  const me = '1000001'
  const posts = [1, 2, 3].map((index) => ({
    id: String(1000 + index), subject: index === 1 ? '확인할 업무 1 <img src=x onerror="window.__xss=1">' : `확인할 업무 ${index}`, taskNumber: `PRJ/${index}`, number: index,
    updatedAt: `2026-11-0${index}T10:00:00.000Z`, createdAt: `2026-11-0${index}T08:00:00.000Z`,
    users: { from: member('2000001', '개발자'), to: [member('2000002', '동료')], cc: [] }, workflow: { name: '진행 중' },
    body: { mimeType: 'text/x-markdown', content: `[@기획자](dooray://1/members/${me}) 업무 ${index} 확인 부탁드립니다 <script>alert(1)</script>` },
    logs: [],
  }))
  return (url) => {
    const { pathname } = new URL(url)
    if (pathname === '/common/v1/members/me') return ok({ id: me, name: '기획자' })
    if (pathname === '/project/v1/projects') return ok(url.includes('scope=private&type=public') ? [{ id: '77', code: 'PRJ', name: '시험' }] : [])
    if (pathname === '/project/v1/projects/77/posts') return ok(posts.map(({ body: _body, logs: _logs, ...post }) => post))
    const logs = /^\/project\/v1\/projects\/77\/posts\/(\d+)\/logs$/.exec(pathname)
    if (logs) return ok([], { totalCount: 0 })
    const detail = /^\/project\/v1\/projects\/77\/posts\/(\d+)$/.exec(pathname)
    if (detail) { const post = posts.find((item) => item.id === detail[1]); return post ? ok({ ...post, project: { id: '77', code: 'PRJ' } }) : null }
    return null
  }
}

async function startChrome(profileDirectory) {
  const browser = spawn(browserExecutable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`, '--window-size=1000,900', 'about:blank'],
  { stdio: 'ignore', windowsHide: true })
  let port
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    port = await readFile(path.join(profileDirectory, 'DevToolsActivePort'), 'utf8').then((text) => text.split('\n')[0]).catch(() => null)
    if (!port) await delay(100)
  }
  if (!port) throw new Error('Chrome 디버깅 포트를 찾지 못했습니다.')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const pending = new Map()
  let sequence = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.error) item.reject(new Error(message.error.message))
    else item.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 응답 시간 초과: ${method}`)) }, 15_000)
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500))
    return result.result.value
  }
  const waitFor = async (expression, label) => {
    let last
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if (await evaluate(expression)) return } catch (error) { last = error }
      await delay(100)
    }
    throw new Error(`${label} 대기 시간 초과 ${last?.message ?? ''}`)
  }
  const close = async () => {
    await send('Browser.close').catch(() => {})
    socket.close()
    if (browser.exitCode === null) { const exited = new Promise((resolve) => browser.once('exit', resolve)); browser.kill(); await exited }
  }
  return { send, evaluate, waitFor, close }
}

test('확인함 화면은 브라우저 화면과 대화창 안 화면 모두에서 목록·확인 체크·되돌리기·이어가기가 동작한다', { timeout: 240_000, skip }, async () => {
  // 정리는 등록의 역순으로 한다. Chrome이 프로필 폴더를 쓰는 동안 폴더를 지우면 이후 정리가 실행되지 않는다.
  const cleanups = []
  const defer = (operation) => cleanups.push(operation)
  try {
    const root = await mkdtemp(path.join(tmpdir(), 'mnp-mention-inbox-browser-'))
    defer(async () => {
      assert.ok(path.basename(root).startsWith('mnp-mention-inbox-browser-'))
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    })
    const stage = path.join(root, 'stage')
    await stageExtension(stage)
    step("await stageExtension(stage)")
    const uiHtml = await readFile(path.join(stage, 'ui', 'inbox.html'), 'utf8')

    const respond = fakeDoorayResponder()
    const dooray = createServer((request, response) => {
      const payload = respond(`http://dooray.test${request.url}`)
      response.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload ?? {}))
    })
    await new Promise((resolve) => dooray.listen(0, '127.0.0.1', resolve))
    defer(() => new Promise((resolve) => { dooray.closeAllConnections(); dooray.close(resolve) }))

    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DOORAY_')))
    const mcp = new Client({ name: 'browser-test', version: '1.0.0' })
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(stage, 'server', 'main.mjs')], stderr: 'pipe',
      env: { ...clean, DOORAY_API_TOKEN: 'test-token', DOORAY_API_BASE_URL: `http://127.0.0.1:${dooray.address().port}`, DOORAY_MENTION_INBOX_STATE_DIR: path.join(root, 'state') } }))
    defer(() => mcp.close())
    const { browserUrl } = (await mcp.callTool({ name: 'dooray_inbox_state', arguments: {} })).structuredContent
    step("const { browserUrl } =")

    // 대화창 안 화면용 Host 페이지: AppBridge로 화면과 연결하고 도구 호출은 실제 확장 서버로 넘긴다.
    const extensionRequire = createRequire(path.join(extensionDirectory, 'package.json'))
    const hostSource = path.join(root, 'host.mjs')
    await writeFile(hostSource, `
  import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
  window.audit = { links: [], messages: [], calls: [] }
  ;(async () => {
    const iframe = document.getElementById('view')
    const html = await (await fetch('/ui')).text()
    const bridge = new AppBridge(null, { name: 'test-host', version: '1.0.0' }, { openLinks: {}, serverTools: {}, message: { text: {} } }, { hostContext: { theme: 'dark' } })
    bridge.oncalltool = async (params) => { window.audit.calls.push(params.name); return (await fetch('/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })).json() }
    bridge.onopenlink = async ({ url }) => { window.audit.links.push(url); return {} }
    bridge.onmessage = async (params) => { window.audit.messages.push(params); return {} }
    await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow))
    iframe.srcdoc = html
  })()
  `)
    const hostBundle = await rolldown({ input: hostSource, platform: 'browser', logLevel: 'warn',
      resolve: { alias: { '@modelcontextprotocol/ext-apps/app-bridge': extensionRequire.resolve('@modelcontextprotocol/ext-apps/app-bridge') } } })
    const hostScript = (await hostBundle.generate({ format: 'iife', codeSplitting: false })).output[0].code
    await hostBundle.close()
    const host = createServer(async (request, response) => {
      if (request.url === '/host') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return response.end(`<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="view" style="width:960px;height:860px;border:0"></iframe><script>${hostScript.replace(/<\/script/gi, '<\\/script')}</script>`)
      }
      if (request.url === '/ui') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(uiHtml) }
      if (request.url === '/call') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const result = await mcp.callTool(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify(result))
      }
      response.writeHead(404); response.end()
    })
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve))
    step("await new Promise((resolve) =>")
    defer(() => new Promise((resolve) => { host.closeAllConnections(); host.close(resolve) }))

    const chrome = await startChrome(path.join(root, 'profile'))
    step("const chrome = await startChro")
    defer(() => chrome.close())
    const { send, evaluate, waitFor } = chrome
    await send('Page.enable')

    // 1) 브라우저 화면
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__navigated = []; window.__doorayInboxNavigate = (url) => window.__navigated.push(url)' })
    await send('Page.navigate', { url: browserUrl })
    await waitFor('document.querySelectorAll(".item").length === 3', '브라우저 화면 목록')
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".subject")).some((node) => node.textContent.includes("<img") && !node.querySelector("img"))'), true, '제목의 HTML은 글자로만 보인다')
    assert.equal(await evaluate('window.__xss === undefined'), true, '제목의 HTML이 실행되지 않는다')
    assert.equal(await evaluate('document.querySelectorAll("script").length'), 1, 'Dooray 내용의 스크립트가 실행되지 않는다')
    assert.deepEqual(await evaluate('Array.from(document.querySelector(".item .actions").children, b => b.textContent)'), ['Dooray에서 열기', '새 대화로 이어가기'])
    assert.equal(await evaluate('document.getElementById("browser").hidden'), true)
    await evaluate('document.querySelector(".item .check input").click()')
    await waitFor('document.querySelectorAll(".item").length === 2 && document.getElementById("tab-checked").textContent === "숨긴 항목 1"', '브라우저 화면 확인 체크')
    await evaluate('document.getElementById("tab-checked").click()')
    await waitFor('document.querySelectorAll(".item").length === 1 && document.querySelector(".item .check input").checked', '숨긴 항목 탭')
    await evaluate('document.querySelector(".item .check input").click()')
    await waitFor('document.getElementById("tab-open").textContent === "확인할 항목 3"', '되돌리기')
    await evaluate('document.getElementById("tab-open").click()')
    await evaluate('Array.from(document.querySelectorAll(".item .actions button")).find(b => b.textContent === "새 대화로 이어가기").click()')
    await waitFor('window.__navigated.length === 1', '새 대화 링크')
    const navigated = await evaluate('window.__navigated[0]')
    assert.ok(navigated.startsWith('claude://claude.ai/new?q='))
    assert.match(decodeURIComponent(navigated.split('?q=')[1]), /- 업무: 확인할 업무 3 \(PRJ\/3\)/)
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false })
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '좁은 창에서도 가로로 넘치지 않는다')
    await send('Emulation.clearDeviceMetricsOverride')

    // 2) 대화창 안 화면(MCP Apps)
    step("// 2) 대화창 안 화면(MCP Apps)")
    await send('Page.navigate', { url: `http://127.0.0.1:${host.address().port}/host` })
    const frame = 'document.getElementById("view").contentDocument'
    await waitFor(`${frame}?.querySelectorAll(".item").length === 3`, '대화창 안 화면 목록')
    assert.equal(await evaluate(`${frame}.documentElement.dataset.theme`), 'dark', 'Host 테마를 따른다')
    assert.deepEqual(await evaluate(`Array.from(${frame}.querySelector(".item .actions").children, b => b.textContent)`), ['Dooray에서 열기', '새 대화로 이어가기', '이 대화에서 이어가기'])
    assert.equal(await evaluate(`${frame}.getElementById("browser").hidden`), false)
    assert.ok((await evaluate('window.audit.calls')).every((name) => ['dooray_inbox_state', 'check_dooray_mentions'].includes(name)))
    await evaluate(`${frame}.querySelector(".item .check input").click()`)
    await waitFor(`${frame}.querySelectorAll(".item").length === 2`, '대화창 안 확인 체크')
    assert.ok((await evaluate('window.audit.calls')).includes('check_dooray_mentions'))
    await evaluate(`Array.from(${frame}.querySelectorAll(".item .actions button")).find(b => b.textContent === "이 대화에서 이어가기").click()`)
    await waitFor('window.audit.messages.length === 1', '이 대화에서 이어가기')
    const message = await evaluate('window.audit.messages[0]')
    assert.equal(message.role, 'user')
    assert.match(message.content[0].text, /get_dooray_task_detail/)
    await evaluate(`Array.from(${frame}.querySelectorAll(".item .actions button")).find(b => b.textContent === "새 대화로 이어가기").click()`)
    await evaluate(`${frame}.getElementById("browser").click()`)
    await evaluate(`Array.from(${frame}.querySelectorAll(".item .actions button")).find(b => b.textContent === "Dooray에서 열기").click()`)
    await waitFor('window.audit.links.length === 3', '링크 열기')
    const links = await evaluate('window.audit.links')
    assert.ok(links[0].startsWith('claude://claude.ai/new?q='))
    assert.equal(links[1], browserUrl)
    assert.match(links[2], /^https:\/\/nhnent\.dooray\.com\/task\/77\/\d+$/)

    // 두 화면은 같은 상태를 쓴다. 대화창 안에서 숨긴 항목이 확장 서버 상태에도 반영되어 있다.
    step("// 두 화면은 같은 상태를 쓴다.")
    const state = (await mcp.callTool({ name: 'dooray_inbox_state', arguments: {} })).structuredContent
    assert.equal(state.items.length, 2)
    assert.equal(state.checkedTotal, 1)
  } finally {
    for (const operation of cleanups.reverse()) {
      try { await operation() } catch (error) { process.stderr.write(`[browser-test] 정리 실패: ${error?.message ?? error}
`) }
    }
  }
})
