import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 실제 컴포넌트와 훅을 사용하되 모든 업무·AI 요청은 브라우저 안의 격리 응답으로 처리한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { DoorayMentionsPanel } from '/src/components/DoorayMentionsPanel.tsx';
import { doorayResponseIdFromSearch } from '/src/utils/doorayResponseLink.mjs';
import '/src/dark.css';
import { applyUiTheme } from '/src/theme.ts';
window.setTheme = applyUiTheme;
applyUiTheme('light');
const base = '/api/integrations/dooray/mentions';
const now = new Date().toISOString();
const item = { key:'mention-new',kind:'mention-comment',occurredAt:now,actorName:'검증 담당자',projectId:'project',
  postId:'post',projectCode:'개발',taskNumber:'1',subject:'모바일에서 모델을 확인하고 대응 제안받기',
  workflowName:'진행',url:'https://example.invalid/post',acknowledgedAt:null,excerpt:'제안 요청 전에 모델을 선택합니다.' };
window.audit = { writes:[], starts:[], closed:0 };
window.saved = {agentId:'agent-a',modelId:'model-old',thoughtLevel:'medium',mode:'write',machineId:'fixture'};
window.failSave = false;
window.failStart = false;
window.delayOptions = false;
let jobs = JSON.parse(sessionStorage.getItem('push-link-jobs') || '[]');
window.fetch = async (input, init = {}) => {
  const url = new URL(input, location.href), method = init.method || 'GET', body = init.body && JSON.parse(init.body);
  const reply = (value, status = 200) => new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json'}});
  if (method !== 'GET') window.audit.writes.push({path:url.pathname,body});
  if (url.pathname === base + '/response-settings') {
    if (method === 'PUT') {
      if (window.failSave) return reply({error:'설정 저장 테스트 오류'},500);
      window.saved = body.settings;
    }
    return reply({userId:'fixture',settings:window.saved});
  }
  if (url.pathname === '/api/integrations/aionui/options') {
    if (window.delayOptions) await new Promise(resolve => {window.releaseOptions = resolve});
    return reply({machineId:'fixture',machines:[],pushMachines:[{machineId:'phone-pc',label:'휴대폰 연결 PC'},{machineId:'other-pc',label:'다른 PC'}],agents:[
      {id:'agent-a',name:'검증 AI',models:[{id:'model-old',label:'기존 모델'},{id:'model-new',label:'변경 모델'}],
        thoughtLevels:[{id:'medium',label:'보통'},{id:'high',label:'높음'}],modes:[{id:'write',label:'작업'}],
        defaultModelId:'model-old',defaultThoughtLevel:'medium',defaultMode:'write'},
      {id:'agent-b',name:'다른 AI',models:[{id:'model-b',label:'다른 모델'}],thoughtLevels:[],modes:[],defaultModelId:'model-b'}
    ]});
  }
  if (url.pathname === base + '/responses') {
    if (method === 'POST') {
      window.audit.starts.push({itemKey:body.itemKey,settings:{...window.saved}});
      if (window.failStart) return reply({error:'제안 접수 테스트 오류'},503);
      const job = {id:'dooray-fixture',itemKey:body.itemKey,postId:'post',subject:item.subject,sourceUrl:item.url,
        status:'proposal',proposal:'확인된 모델로 받은 제안',error:'',createdAt:now,updatedAt:now,conversationId:null,
        homeMachineRole:'main',canRetry:false,route:null,settings:{...window.saved}};
      jobs = [job]; return reply({job},202);
    }
    return reply({jobs});
  }
  if (url.pathname === base) return reply({items:[item],scan:{status:'idle'},lastScan:null,preferences:null,kinds:[],maxRangeDays:90});
  if (url.pathname === base + '/projects') return reply({projects:[],selectedProjectIds:[],maxSelectedProjects:100});
  throw Error('예상하지 못한 요청: ' + url.pathname);
};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,
  React.createElement(DoorayMentionsPanel,{clientId:'fixture',userId:'fixture',initialResponseId:doorayResponseIdFromSearch(location.search),onClose:()=>window.audit.closed++,
    onOpenConversation:()=>{},onOpenCard:()=>{},onLaunchCard:()=>{}})));
`

test('AI 대응 제안은 모델 확인·취소·저장 실패·중복 클릭을 처리하고 기존 기록 열기를 유지한다', {
  skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 60000,
}, async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dooray-options-browser-'))
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, '..'),
    cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [react(), {
      name: 'dooray-options-fixture', resolveId: id => id === '/dooray-options-fixture.js' ? '\0dooray-options-fixture' : null,
      load: id => id === '\0dooray-options-fixture' ? fixture : null,
      configureServer(vite) { vite.middlewares.use('/options-check', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/options-check', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/dooray-options-fixture.js"></script></body></html>'))
      }) },
    }],
  })
  let browser, socket, send
  const pending = new Map()
  const waitFor = async fn => {
    let lastError
    for (let i = 0; i < 100; i++) {
      try { if (await fn()) return } catch (error) { lastError = error }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw lastError ?? Error('제안 옵션 화면 검증 시간 초과')
  }
  try {
    await server.listen()
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let spawnError, port
    browser.on('error', error => { spawnError = error })
    await waitFor(async () => { if (spawnError) throw spawnError; port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return port })
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let sequence = 0
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data), entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id); clearTimeout(entry.timer)
      if (message.error) entry.reject(Error(message.error.message)); else entry.resolve(message.result)
    }
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method)) }, 10000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const open = async () => {
      await evaluate('document.querySelector(".dooray-response-request").click()')
      await waitFor(() => evaluate('Boolean(document.querySelector(".dooray-response-request-dialog select"))'))
    }
    const select = (index, value) => evaluate(`(() => {const el=document.querySelectorAll('.dooray-response-request-dialog select')[${index}];el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    const submit = () => evaluate('document.querySelector(".dooray-response-request-dialog button[type=submit]").click()')
    const escape = async () => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/options-check` })
    await waitFor(() => evaluate('Boolean(document.querySelector(".dooray-response-request"))'))
    await evaluate('window.delayOptions=true;document.querySelector(".dooray-response-request").click()')
    await waitFor(() => evaluate('typeof window.releaseOptions === "function"'))
    assert.equal(await evaluate('document.querySelector(".dooray-response-request-dialog button[type=submit]").disabled'), true)
    assert.deepEqual(await evaluate('window.audit.writes'), [])
    await evaluate('window.delayOptions=false;window.releaseOptions()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".dooray-response-request-dialog select"))'))
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".dooray-response-request-dialog select")].map(el=>el.value)'), ['agent-a', 'model-old', 'medium'])
    await select(0, 'agent-b')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".dooray-response-request-dialog select")].map(el=>el.value)'), ['agent-b', 'model-b', ''])
    await select(0, 'agent-a')
    await select(1, 'model-new')
    await select(2, 'high')
    assert.equal(await evaluate('(()=>{const el=document.querySelector(".dooray-response-request-dialog"),r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&el.scrollWidth<=el.clientWidth})()'), true)
    await evaluate('window.setTheme("dark")')
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = path.join(tmpdir(), `mnp-dooray-options-${Date.now()}.png`)
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    console.log(`제안 옵션 모바일 검증 화면: ${screenshotPath}`)
    await escape()
    await waitFor(() => evaluate('!document.querySelector(".dooray-response-request-dialog")'))
    assert.equal(await evaluate('window.audit.closed'), 0, 'Esc는 옵션창만 닫는다.')
    assert.deepEqual(await evaluate('window.audit.writes'), [], '확인 전 선택 변경이나 취소는 저장·실행하지 않는다.')

    await open()
    await evaluate('document.querySelector(".dooray-response-request-dialog button[type=button]").click()')
    await waitFor(() => evaluate('!document.querySelector(".dooray-response-request-dialog")'))
    assert.deepEqual(await evaluate('window.audit.writes'), [])
    await open()
    await select(1, 'model-new')
    await select(2, 'high')
    await evaluate('window.failSave=true')
    await submit()
    await waitFor(() => evaluate('document.querySelector(".dooray-response-request-dialog")?.textContent.includes("설정 저장 테스트 오류")'))
    assert.equal(await evaluate('window.audit.starts.length'), 0, '설정 저장 실패 시 제안을 요청하지 않는다.')
    await evaluate('window.failSave=false;window.failStart=true')
    await submit()
    await waitFor(() => evaluate('document.querySelector(".dooray-response-request-dialog")?.textContent.includes("제안 접수 테스트 오류")'))
    await evaluate('window.failStart=false;window.audit.writes=[];window.audit.starts=[]')
    await evaluate('document.querySelector(".dooray-response-request-dialog button[type=submit]").click();document.querySelector(".dooray-response-request-dialog button[type=submit]").click()')
    await waitFor(() => evaluate('!document.querySelector(".dooray-response-request-dialog")'))
    assert.deepEqual(await evaluate('window.audit.writes.map(entry=>entry.path)'), [
      '/api/integrations/dooray/mentions/response-settings', '/api/integrations/dooray/mentions/responses',
    ], '확인한 설정을 먼저 저장하고 한 번만 접수한다.')
    const starts = await evaluate('window.audit.starts')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].itemKey, 'mention-new')
    assert.equal(starts[0].settings.modelId, 'model-new')
    assert.equal(starts[0].settings.thoughtLevel, 'high')
    await evaluate('document.querySelector(".dooray-response-request").click()')
    assert.equal(await evaluate('Boolean(document.querySelector(".dooray-response-request-dialog"))'), false, '기존 요청은 옵션창 없이 기록을 연다.')
    assert.equal(await evaluate('window.audit.starts.length'), 1)
    await evaluate('document.querySelector(".dooray-mentions-ai-settings").click()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".dooray-response-settings select"))'))
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".dooray-response-settings select")].map(el=>el.value)'), ['agent-a', 'model-new', 'high'], '계정 설정에도 변경한 모델이 유지된다.')
    await evaluate('document.querySelector(".dooray-response-push-toggle input").click()')
    assert.equal(await evaluate('document.querySelector(".dooray-response-settings button[type=submit]").disabled'), true, '수신 PC가 없으면 알림 설정을 저장하지 않는다')
    await evaluate(`(() => {const el=document.querySelector('select[aria-label="휴대폰이 연결된 PC"]');el.value='phone-pc';el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await evaluate('document.querySelector(".dooray-response-settings button[type=submit]").click()')
    await waitFor(() => evaluate('!document.querySelector(".dooray-response-settings")'))
    assert.equal(await evaluate('window.saved.pushEnabled'), true)
    assert.equal(await evaluate('window.saved.pushMachineId'), 'phone-pc')
    assert.equal(await evaluate('window.audit.starts.length'), 1, '알림 설정은 AI를 다시 실행하지 않는다')
    await evaluate('document.querySelector(".dooray-mentions-ai-settings").click()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".dooray-response-push-toggle input")?.checked)'))
    assert.equal(await evaluate('document.querySelector(\'select[aria-label="휴대폰이 연결된 PC"]\').value'), 'phone-pc')
    await evaluate(`sessionStorage.setItem('push-link-jobs',JSON.stringify([
      {id:'latest',subject:'다른 요청',status:'proposal',proposal:'다른 제안',createdAt:'2026-10-28',updatedAt:'2026-10-28',route:null},
      {id:'dooray-target',subject:'알림에서 연 업무',status:'needs-input',proposal:'확인할 질문',createdAt:'2026-10-28',updatedAt:'2026-10-28',route:null,
       decision:{kind:'input',reason:'대상 확인 필요',questions:['대상 화면은 어디인가요?'],approval:null},
       pushNotification:{state:'queued',machineId:'phone-pc',attempts:1,error:'',errorCode:'',queuedAt:1}}
    ]))`)
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/options-check?doorayResponseId=dooray-target` })
    await waitFor(() => evaluate('document.querySelector(".dooray-response-picker select")?.value === "dooray-target"'))
    assert.ok(await evaluate('document.querySelector(".dooray-response-detail").textContent.includes("대상 화면은 어디인가요?")'))
    assert.ok(await evaluate('document.querySelector(".dooray-response-push-status").textContent.includes("접수됨")'))
    assert.equal(await evaluate('window.audit.starts.length'), 0, '알림을 열어도 AI 실행·승인을 하지 않는다')
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/options-check?doorayResponseId=missing` })
    await waitFor(() => evaluate('document.querySelector(".dooray-response-notice")?.textContent.includes("로그인 계정")'))
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const entry of pending.values()) clearTimeout(entry.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('mnp-dooray-options-browser-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
