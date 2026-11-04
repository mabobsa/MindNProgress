import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 휴대폰 문서 목록의 꾹 누른 뒤 끌기를 격리 서버와 실제 브라우저 터치 입력(CDP)으로 확인한다.
// 화면은 dist를 쓰므로 먼저 `npx vite build`를 실행한 뒤 MNP_LIBRARY_TOUCH_BROWSER=1로 실행한다.
const root = path.resolve(import.meta.dirname, '..')
const enabled = process.env.MNP_LIBRARY_TOUCH_BROWSER === '1'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause(100) }
  throw new Error(message)
}

test('휴대폰 문서 목록은 꾹 누른 뒤 끌어 문서·그룹 위치를 옮기고, 쓸기·탭·떼기는 그대로 둔다', { skip: !enabled, timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-library-touch-'))
  const fake = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const data = url.pathname === '/api/internal/conversation-runtimes/active' ? { conversations: [] } : []
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data))
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const probe = createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const env = { ...process.env, MNP_DATA_DIR: directory, MNP_TOKEN_FILE: path.join(directory, '_integration-token'), MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_API_URL: base,
    MNP_ADMIN_EMAIL: 'touch-library@mind.local', MNP_ADMIN_PASSWORD: 'TestOnly!2026', MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'), MNP_MCP_USAGE_DISABLED: '1', AIONUI_CONVERSATION_ID: '',
    MNP_AIONUI_URL: `http://127.0.0.1:${fake.address().port}`, MNP_AIONUI_DISCOVERY_FILE: path.join(directory, 'no-discovery.json') }
  const server = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''; server.stderr.on('data', (data) => { stderr += data })
  const profile = path.join(directory, 'browser-profile')
  let browser; let socket; let command
  t.after(async () => {
    if (command && socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close') } catch { /* 종료 중 연결 종료 */ } }
    if (browser?.exitCode === null) browser.kill()
    if (server.exitCode === null) { const done = new Promise((resolve) => server.once('exit', resolve)); server.kill(); await done }
    await new Promise((resolve) => fake.close(resolve))
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.match(path.basename(directory), /^mnp-library-touch-/)
    await pause(300)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  await until(async () => { try { return (await fetch(base + '/api/health')).ok } catch { if (server.exitCode !== null) throw Error(stderr); return false } }, '임시 서버 준비 실패')
  const headers = { Authorization: `Bearer ${(await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()}`, 'X-MNP-AI-Editor-Id': 'user-admin', 'Content-Type': 'application/json' }
  const api = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() } }

  const ids = {}
  for (const name of ['A', 'B', 'C']) {
    const created = await api('/api/maps', 'POST', { title: `터치 문서 ${name}`, map: { nodes: [{ id: 'root', type: 'mind', position: { x: 0, y: 0 }, data: { label: name, kind: 'root', status: 'planned', progress: 0 } }], edges: [] } })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    ids[name] = created.body.map.id
  }
  const groupId = 'group-touch-drag'
  const initialLayout = { ...(await api('/api/maps')).body.documentLayout,
    items: [{ type: 'map', id: ids.A }, { type: 'map', id: ids.B }, { type: 'map', id: ids.C }, { type: 'group', id: groupId }],
    groups: [{ id: groupId, name: '터치 끌기 그룹', mapIds: [] }] }
  assert.equal((await api('/api/maps/layout', 'PATCH', { documentLayout: initialLayout })).status, 200)
  const layout = async () => (await api('/api/maps')).body.documentLayout
  const order = async () => { const current = await layout(); return { items: current.items.map((item) => `${item.type}:${item.id}`), group: current.groups.find((g) => g.id === groupId)?.mapIds ?? [] } }

  browser = spawn(process.env.MNP_BROWSER_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let devtoolsPort
  await until(async () => { try { const content = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); devtoolsPort = Number(content.split('\n')[0]); return devtoolsPort > 0 } catch { return false } }, '브라우저 시작 실패')
  const target = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0; const pending = new Map(); const errors = []
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) { const entry = pending.get(message.id); if (entry) { pending.delete(message.id); if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result) } }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  })
  command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const touch = (type, points) => command('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 2, radiusY: 2, force: 1 })) })
  const center = (selector) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('요소 없음: '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width*0.3,y:r.y+r.height/2}})()`)
  const travel = async (from, to, steps = 8) => { for (let i = 1; i <= steps; i++) { await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]); await pause(30) } }
  const hold = async (selector) => { const p = await center(selector); await touch('touchStart', [p]); await pause(620); return p }
  const row = (id) => `.sidebar [data-library-menu-id="${id}"]`
  const menuOpen = () => evaluate('document.querySelector(".document-context-menu")!==null')

  await command('Runtime.enable'); await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  await command('Page.navigate', { url: base })
  await until(() => evaluate(`document.readyState==='complete'`).catch(() => false), '페이지 로딩 실패')
  assert.equal(await evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'touch-library@mind.local',password:'TestOnly!2026'})}).then(r=>r.status)`), 200)
  await command('Page.navigate', { url: `${base}/mindmap/${ids.A}` })
  await until(() => evaluate('document.querySelector(\'button[aria-label="문서 목록 열기"]\')!==null'), '문서 화면 로딩 실패')
  await pause(400)
  const openList = async () => {
    if (await evaluate('document.querySelector(".sidebar.mobile-open")!==null')) return
    const p = await center('button[aria-label="문서 목록 열기"]'); await touch('touchStart', [p]); await pause(60); await touch('touchEnd', [])
    await until(() => evaluate('document.querySelector(".sidebar.mobile-open")!==null'), '모바일 문서 목록 열기 실패')
    await pause(300)
  }
  await openList()

  // 1. 꾹 누른 뒤 다른 문서 위로 끌면 메뉴가 닫히고 그 문서 앞으로 옮긴다.
  let start = await hold(row(ids.C))
  await until(menuOpen, '꾹 누르기 메뉴가 열리지 않음')
  await travel(start, await center(row(ids.A)))
  assert.equal(await menuOpen(), false, '끌기를 시작하면 메뉴를 닫는다')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row(ids.C))}).classList.contains('dragging')`), true, '끄는 문서 표시')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row(ids.A))}).classList.contains('document-drop-target')`), true, '놓을 위치 표시')
  await touch('touchEnd', [])
  await until(async () => (await order()).items.join() === [`map:${ids.C}`, `map:${ids.A}`, `map:${ids.B}`, `group:${groupId}`].join(), '문서 앞 이동 저장 실패')
  await pause(300)
  await openList()

  // 2. 문서를 그룹 헤더로 끌면 그룹 안으로 넣는다.
  start = await hold(row(ids.B))
  await until(menuOpen, '두 번째 꾹 누르기 메뉴 없음')
  await travel(start, await center(row(groupId)))
  await touch('touchEnd', [])
  await until(async () => { const current = await order(); return current.group.join() === ids.B && !current.items.includes(`map:${ids.B}`) }, '그룹 안 이동 저장 실패')
  await pause(300)
  await openList()

  // 3. 그룹을 끌어 목록 맨 앞(끄는 동안 나타나는 위치)에 놓는다.
  start = await hold(row(groupId))
  await until(menuOpen, '그룹 꾹 누르기 메뉴 없음')
  await travel(start, { x: start.x, y: start.y - 20 }, 3)
  await until(() => evaluate('document.querySelector(".library-top-insertion-target")!==null'), '끄는 동안 목록 맨 앞 위치가 보이지 않음')
  const topStart = await evaluate('(()=>{const r=document.querySelector(".library-top-insertion-target").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
  await travel({ x: start.x, y: start.y - 20 }, topStart)
  await touch('touchEnd', [])
  await until(async () => (await order()).items[0] === `group:${groupId}`, '그룹 맨 앞 이동 저장 실패')
  await pause(300)
  await openList()
  const settled = await order()

  // 4. 꾹 누르기 없이 쓸면 스크롤일 뿐이고, 꾹 누른 뒤 그냥 떼면 메뉴만 남는다.
  start = await center(row(ids.A))
  await touch('touchStart', [start]); await travel(start, { x: start.x, y: start.y - 60 }, 5); await touch('touchEnd', []); await pause(700)
  assert.equal(await menuOpen(), false, '쓸기는 메뉴를 열지 않는다')
  await hold(row(ids.A)); await touch('touchEnd', []); await pause(300)
  assert.equal(await menuOpen(), true, '꾹 누른 뒤 떼면 메뉴 유지')
  assert.equal(await evaluate('document.querySelector(".sidebar.mobile-open")!==null'), true, '떼기로 문서를 열지 않는다')
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await pause(200)

  // 5. 끄는 중 터치가 취소되면 옮기지 않는다.
  start = await hold(row(ids.A))
  await travel(start, await center(row(ids.C)))
  await touch('touchCancel', []); await pause(300)
  assert.equal(await evaluate('document.querySelector(".sidebar .dragging, .sidebar .document-drop-target")===null'), true, '취소하면 끌기 표시를 지운다')
  await pause(500)
  assert.deepEqual(await order(), settled, '쓸기·떼기·취소는 순서를 바꾸지 않는다')
  assert.deepEqual(errors, [], '브라우저 예외 없음')
})
