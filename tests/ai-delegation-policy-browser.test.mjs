import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 계정 메뉴 「AI 위임 규칙」 화면을 격리 서버와 실제 브라우저(CDP)로 확인한다.
// 화면은 dist를 쓰므로 먼저 `npx vite build`를 실행한 뒤 MNP_AI_POLICY_BROWSER=1로 실행한다.
// MNP_AI_POLICY_SCREENSHOT_DIR을 주면 화면 사진을 남긴다.
const root = path.resolve(import.meta.dirname, '..')
const enabled = process.env.MNP_AI_POLICY_BROWSER === '1'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause(100) }
  throw new Error(message)
}
const options = (...ids) => ids.map((value) => ({ value, name: value }))
const agents = [
  { id: 'claude', name: 'Claude Code', backend: 'claude', installed: true, enabled: true,
    available_models: { current_model_id: 'opus', available_models: options('opus', 'sonnet') },
    available_modes: { available_modes: options('default', 'acceptEdits', 'bypassPermissions') },
    config_options: [{ category: 'thought_level', currentValue: 'high', options: options('high', 'xhigh', 'max') }] },
  { id: 'codex', name: 'Codex CLI', backend: 'codex', installed: true, enabled: true,
    available_models: { current_model_id: 'gpt-6.1-sol', available_models: options('gpt-6.1-sol', 'gpt-6-astra') },
    available_modes: { available_modes: options('read-only', 'full-access') },
    config_options: [{ category: 'thought_level', currentValue: 'high', options: options('high', 'xhigh', 'max') }] },
]

test('계정 메뉴의 AI 위임 규칙 화면은 규칙을 보여주고, 조건 누락을 막으며, 바꾼 모델을 저장한다', { skip: !enabled, timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-ai-policy-browser-'))
  const fake = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const data = url.pathname === '/api/agents/management' ? agents
      : url.pathname === '/api/internal/conversation-runtimes/active' ? { conversations: [] } : []
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: true, data }))
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const probe = createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const env = { ...process.env, MNP_DATA_DIR: directory, MNP_TOKEN_FILE: path.join(directory, '_integration-token'), MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_API_URL: base,
    MNP_ADMIN_EMAIL: 'ai-policy@mind.local', MNP_ADMIN_PASSWORD: 'TestOnly!2026', MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'), MNP_MCP_USAGE_DISABLED: '1', AIONUI_CONVERSATION_ID: '',
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
    assert.match(path.basename(directory), /^mnp-ai-policy-browser-/)
    await pause(300)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  await until(async () => { try { return (await fetch(base + '/api/health')).ok } catch { if (server.exitCode !== null) throw Error(stderr); return false } }, '임시 서버 준비 실패')
  const headers = { Authorization: `Bearer ${(await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()}`, 'X-MNP-AI-Editor-Id': 'user-admin', 'Content-Type': 'application/json' }
  const created = await fetch(base + '/api/maps', { method: 'POST', headers, body: JSON.stringify({ title: '위임 규칙 화면', map: { nodes: [{ id: 'root', type: 'mind', position: { x: 0, y: 0 }, data: { label: '루트', kind: 'root', status: 'planned', progress: 0 } }], edges: [] } }) })
  assert.equal(created.status, 201)
  const mapId = (await created.json()).map.id

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
  const click = (selector, text) => evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find((c)=>!${JSON.stringify(text ?? '')}||c.textContent.includes(${JSON.stringify(text ?? '')})); if(!e) throw Error('요소 없음'); e.click(); return true})()`)
  const dialog = '[role="dialog"][aria-label="AI 위임 규칙"]'
  const select = (label, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(`${dialog} select[aria-label="${label}"]`)}); if(!e) throw Error('선택 상자 없음');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('change',{bubbles:true})); return e.value})()`)
  const screenshot = async (name) => {
    if (!process.env.MNP_AI_POLICY_SCREENSHOT_DIR) return
    const { data } = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(process.env.MNP_AI_POLICY_SCREENSHOT_DIR, name), Buffer.from(data, 'base64'))
  }
  const savedPolicy = () => evaluate(`fetch('/api/account/ai-delegation-policy').then((r)=>r.json())`)

  await command('Runtime.enable'); await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await command('Page.navigate', { url: base })
  await until(() => evaluate(`document.readyState==='complete'`).catch(() => false), '페이지 로딩 실패')
  assert.equal(await evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'ai-policy@mind.local',password:'TestOnly!2026'})}).then(r=>r.status)`), 200)
  await command('Page.navigate', { url: `${base}/mindmap/${mapId}` })
  await until(() => evaluate('document.querySelector(".user-menu")!==null'), '문서 화면 로딩 실패')

  // 1. 계정 메뉴에서 화면을 열면 기본 규칙 5행과 AionUi 선택지가 보인다.
  await click('.user-menu')
  await until(() => evaluate('document.querySelector(".account-popover")!==null'), '계정 메뉴 열기 실패')
  await click('.account-popover button', 'AI 위임 규칙')
  await until(() => evaluate(`document.querySelectorAll(${JSON.stringify(`${dialog} tbody tr`)}).length===5`), '위임 규칙 표 로딩 실패')
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(`${dialog} select[aria-label="4번째 행 모델"]`)}).disabled`), 'AionUi 선택지 로딩 실패')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(${JSON.stringify(`${dialog} select[aria-label="4번째 행 모델"] option`)})].map((o)=>o.value)`), ['gpt-6.1-sol', 'gpt-6-astra'])
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(dialog)}).textContent`), /아직 저장한 적이 없어 기본 규칙/)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${dialog} footer button[type="submit"]`)}).disabled`), true, '바꾸기 전에는 저장할 수 없다')
  await screenshot('ai-delegation-policy-initial.png')

  // 2. 행을 지워 조건이 빠지면 알리고 저장을 막는다. 변경 취소로 되돌린다.
  await click(`${dialog} button[aria-label="5번째 행 삭제"]`)
  await until(() => evaluate(`document.querySelector(${JSON.stringify(dialog)}).textContent.includes('검수 외·하위 카드·대규모·복잡한 분석 (맞는 행 없음)')`), '조건 누락 안내 없음')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${dialog} footer button[type="submit"]`)}).disabled`), true, '조건이 빠지면 저장할 수 없다')
  await screenshot('ai-delegation-policy-invalid.png')
  await click(`${dialog} .ai-delegation-policy-row-actions button`, '변경 취소')
  await until(() => evaluate(`document.querySelectorAll(${JSON.stringify(`${dialog} tbody tr`)}).length===5`), '변경 취소 실패')

  // 3. 하위 카드 기본 행의 모델·사고 강도를 바꿔 저장하면 서버 규칙이 바뀐다. CLI를 바꾸면 그 CLI의 모델로 맞춘다.
  assert.equal(await select('4번째 행 모델', 'gpt-6-astra'), 'gpt-6-astra')
  assert.equal(await select('4번째 행 사고 강도', 'high'), 'high')
  await select('5번째 행 CLI', 'claude')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${dialog} select[aria-label="5번째 행 모델"]`)}).value`), 'opus')
  await select('5번째 행 CLI', 'codex')
  await click(`${dialog} footer button[type="submit"]`)
  await until(() => evaluate(`document.querySelector(${JSON.stringify(dialog)}).textContent.includes('위임 규칙을 저장했습니다')`), '저장 실패')
  const saved = await savedPolicy()
  assert.equal(saved.source, 'saved')
  const subRule = saved.policy.rules.find((rule) => rule.workType === 'other' && rule.cardLevel === 'sub-card' && rule.analysisDepth === 'standard')
  assert.deepEqual([subRule.agent.backend, subRule.modelId, subRule.thoughtLevelId], ['codex', 'gpt-6-astra', 'high'])
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(dialog)}).textContent`), /마지막 저장: /)
  await screenshot('ai-delegation-policy-saved.png')
  assert.deepEqual(errors, [], '화면 스크립트 오류가 없다')
})
