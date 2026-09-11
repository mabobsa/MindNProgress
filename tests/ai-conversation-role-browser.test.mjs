import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildGroupCoordinatorRequest } from '../src/utils/aiApprovalInstructions.mjs'
import { DEFAULT_AI_EDITOR_REQUEST } from '../src/utils/aiConversationLaunch.mjs'

// 실제 MnP·AionUi·사용자 프로필에 접근하지 않고 실제 팝업 컴포넌트만 실행한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AiConversationDialog } from '/src/components/AiConversationDialog.tsx';
const root = createRoot(document.getElementById('root'));
const originalFetch = window.fetch.bind(window);
const options = {connected:true,machineId:'fixture',machineLabel:'테스트',machineRole:'main',machines:[{machineId:'fixture',label:'테스트',role:'main'}],protocol:'fixture:',defaultWorkspace:'',workspaceBrowseAvailable:false,skills:[],mcpServers:[],agents:[{id:'test',name:'테스트 AI',models:[{id:'test',label:'테스트'}],defaultModelId:'test',modes:[],thoughtLevels:[]}]};
window.audit = { calls:[], fail:false, hold:false, closed:0, context:null };
window.open = () => ({document:{body:{style:{}}},location:{href:''},closed:false,focus(){},close(){this.closed=true}});
window.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url, init);
  const a = window.audit;
  a.calls.push({url,method:init.method || 'GET',body:init.body ? JSON.parse(init.body) : null});
  let body = {};
  if (url.startsWith('/api/maps/')) {
    if (a.hold) await new Promise((resolve,reject) => {a.release=resolve; init.signal?.addEventListener('abort',()=>reject(init.signal.reason),{once:true})});
    if (a.fail) return new Response(JSON.stringify({error:'그룹 역할 조회 실패'}),{status:503});
    body = a.context;
  } else if (url.startsWith('/api/integrations/aionui/options')) body = options;
  else if (url === '/api/integrations/aionui/workspaces') body = {workspaces:[]};
  else if (url === '/api/integrations/aionui/attributions') body = {editorId:'fixture',attributionToken:'fixture',completionUrl:'http://fixture.invalid/completion'};
  else if (url === '/api/integrations/aionui/external-conversation-launches') body = {launchUrl:'about:blank'};
  else throw new Error('예상하지 않은 테스트 요청: '+url);
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
};
let sequence = 0;
window.renderDialog = (input = {}, flags = {}) => {
  Object.assign(window.audit,{calls:[],fail:false,hold:false,closed:0,context:{map:{id:'map-coordinator',nodes:[{id:'root',data:{kind:'root'}},{id:'child',data:{kind:'task'}}],edges:[{source:'root',target:'child'}]},groupProject:{groupId:'group-manager',role:'coordinator',coordinatorMapId:'map-coordinator'}},...flags});
  root.render(React.createElement(AiConversationDialog,{key:++sequence,userId:'fixture',documentId:'map-coordinator',documentTitle:'총괄 문서',cardId:'root',cardTitle:'총괄 루트',purpose:'card',knowledgeSources:[],launchInWebUi:true,onClose:()=>window.audit.closed++,...input}));
};
window.fixtureReady = true;
`

test('실제 대화 팝업의 총괄 전문·전달 목적·조회 중 잠금·오류·역할 변경을 검증한다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 60_000 }, async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-role-browser-'))
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, '..'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [react(), {
      name: 'role-fixture', resolveId: (id) => id === '/role-fixture.js' ? '\0role-fixture' : null,
      load: (id) => id === '\0role-fixture' ? fixture : null,
      configureServer(vite) { vite.middlewares.use('/role-check', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/role-check', '<!doctype html><html><body><div id="root"></div><script type="module" src="/role-fixture.js"></script></body></html>'))
      }) },
    }],
  })
  let browser, socket, send
  const pending = new Map()
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (fn) => {
    let lastError
    for (let i = 0; i < 100; i++) { try { const value = await fn(); if (value) return value } catch (error) { lastError = error }; await delay(100) }
    throw lastError ?? Error('화면 검증 대기 시간 초과')
  }
  try {
    await server.listen()
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--window-size=1440,1000', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let spawnError
    browser.on('error', (error) => { spawnError = error })
    const port = await waitFor(async () => { if (spawnError) throw spawnError; return (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0] })
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let sequence = 0
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data), item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id); clearTimeout(item.timer)
      if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result)
    }
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method)) }, 10000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/role-check` })
    await waitFor(() => evaluate('window.fixtureReady'))
    const open = async (input = {}, flags = {}) => {
      await evaluate(`window.renderDialog(${JSON.stringify(input)},${JSON.stringify(flags)})`)
      await waitFor(() => evaluate('Boolean(document.querySelector(".ai-auto-request textarea")) && !document.querySelector(".ai-dialog footer .primary").disabled'))
      return evaluate('document.querySelector(".ai-auto-request textarea").value')
    }
    const expected = buildGroupCoordinatorRequest({ groupId: 'group-manager' })
    assert.equal(await open(), expected)
    assert.equal(await open({ purpose: 'group-coordination', groupId: 'group-manager', initialRequest: expected, fullInitialRequest: true }), expected)
    assert.equal(await open({ cardId: 'child' }), DEFAULT_AI_EDITOR_REQUEST)
    assert.equal(await open({ purpose: 'shared-knowledge-review', initialRequest: '지식 정리 제안만' }, { fail: true }), '지식 정리 제안만')
    assert.equal(await evaluate('window.audit.calls.some(c=>c.url.startsWith("/api/maps/"))'), false)
    await open()
    await evaluate('document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('window.audit.closed === 1'))
    const posts = await evaluate('window.audit.calls.filter(c=>c.method === "POST")')
    assert.equal(posts.find(c => c.url.endsWith('/attributions')).body.purpose, 'group-coordination')
    const payload = posts.find(c => c.url.endsWith('/external-conversation-launches')).body
    assert.ok(payload.prompt.includes(expected)); assert.match(payload.title, /^\[그룹 총괄\]/)

    await evaluate('window.renderDialog({}, {hold:true})')
    await waitFor(() => evaluate('document.querySelector(".ai-dialog [role=status]")?.textContent.includes("대화 역할")'))
    assert.equal(await evaluate('document.querySelector(".ai-dialog footer .primary").disabled'), true)
    assert.equal(await evaluate('Boolean(document.querySelector(".ai-auto-request textarea"))'), false)
    await evaluate('window.audit.hold=false; window.audit.release()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-auto-request textarea"))'))

    await evaluate('window.renderDialog({}, {fail:true})')
    await waitFor(() => evaluate('document.querySelector(".ai-dialog [role=alert]")?.textContent.includes("역할 조회 실패")'))
    assert.equal(await evaluate('document.querySelector(".ai-dialog footer .primary").disabled'), true)
    await open()
    await evaluate('window.audit.context.groupProject=null; document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('document.querySelector(".ai-launch-error")?.textContent.includes("그룹 역할이 변경")'))
    assert.equal(await evaluate('document.querySelector(".ai-auto-request textarea").value'), DEFAULT_AI_EDITOR_REQUEST)
    assert.equal(await evaluate('window.audit.calls.some(c=>c.method === "POST")'), false)
    // 요청 대상 변경 시 늦은 응답이 현재 카드의 전문을 덮어쓰지 않아야 한다.
    await evaluate('window.renderDialog({}, {hold:true})')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-dialog [role=status]"))'))
    assert.equal(await open({ cardId: 'child' }), DEFAULT_AI_EDITOR_REQUEST)
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mnp-role-browser-')) throw Error('테스트 임시 경로 검증 실패')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
})
