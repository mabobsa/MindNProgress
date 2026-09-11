import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AiDelegationRecovery } from '/src/components/AiDelegationRecovery.tsx';
const root = createRoot(document.getElementById('root'));
const originalFetch = window.fetch.bind(window);
window.audit = { calls: [], confirm: true, fail: false };
window.confirm = () => window.audit.confirm;
const item = { id:'limited',mapId:'child-map',parentMapId:'parent-map',parentCardId:'parent',targetCardId:'child',targetCardLabel:'하위 작업',state:'waiting-usage-limit',createdAt:'2026-09-11',updatedAt:'current',recovery:{recoveryAvailable:true},childError:'사용량 초과' };
const replacement = {...item,id:'replacement',state:'completed',createdAt:'2026-09-12',updatedAt:'replacement-current',workCompleted:true,recovery:null,childError:null};
window.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url, init);
  window.audit.calls.push({url,method:init.method || 'GET',body:init.body ? JSON.parse(init.body) : null});
  if (init.method === 'POST') {
    if (window.audit.fail) return new Response(JSON.stringify({error:'서버 상태가 변경되었습니다.'}),{status:409});
    return new Response(JSON.stringify({delegation:item}));
  }
  if (url.endsWith('/ai-delegations')) return new Response(JSON.stringify({delegations:[item,replacement,{...item,id:'unrelated',targetCardId:'someone-else',parentCardId:'someone-else',targetCardLabel:'다른 카드 작업'}]}));
  return new Response(JSON.stringify({map:{version:url.includes('parent-map') ? 7 : 9}}));
};
let sequence = 0;
window.renderRecovery = (props={}) => root.render(React.createElement(AiDelegationRecovery,{key:++sequence,mapId:'child-map',cardId:'child',...props}));
window.reportOnly = () => {item.state='parent-wake-failed';item.childError=null;item.parentError='보고 사용량 초과';item.workCompleted=true;item.reportPending=true;item.recovery={recoveryAvailable:false,reportRetryAvailable:true};item.closure={closeAvailable:true,reason:'completed-child-report-abandonment'};window.renderRecovery()};
window.fixtureReady = true;
`

test('하위 카드 복구 화면은 AI 없이 재개·보고 재시도를 구분하고 다른 카드 요청을 보내지 않는다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 60000 }, async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-recovery-browser-'))
  const removeDirectory = async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mnp-recovery-browser-')) throw Error('테스트 임시 경로 검증 실패')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, '..'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [react(), {
      name: 'recovery-fixture', resolveId: id => id === '/recovery-fixture.js' ? '\0recovery-fixture' : null,
      load: id => id === '\0recovery-fixture' ? fixture : null,
      configureServer(vite) { vite.middlewares.use('/recovery-check', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/recovery-check', '<!doctype html><html><body><div id="root"></div><script type="module" src="/recovery-fixture.js"></script></body></html>'))
      }) },
    }],
  })
  let browser, socket, send
  const pending = new Map()
  const waitFor = async fn => {
    for (let i = 0; i < 100; i++) { try { const value = await fn(); if (value) return value } catch {} await new Promise(resolve => setTimeout(resolve, 100)) }
    throw Error('복구 화면 검증 대기 시간 초과')
  }
  try {
    await server.listen()
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--window-size=1000,800', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    const port = await waitFor(async () => (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
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
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`)
    const ready = () => waitFor(() => evaluate('Boolean(document.querySelector("button")) && !document.querySelector("button").disabled'))
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/recovery-check` })
    await waitFor(() => evaluate('window.fixtureReady'))
    await evaluate('window.renderRecovery()'); await ready()
    assert.equal(await evaluate('document.body.textContent.includes("다른 카드 작업")'), false)
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.method==="POST").length'), 0)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="상태 다시 확인").title'), /새 AI 실행은 요청하지 않습니다/)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="기존 작업 재개").title'), /해당 AI가 다시 실행됩니다/)
    await click('상태 다시 확인')
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=status]"))')); await ready()
    let posts = await evaluate('window.audit.calls.filter(c=>c.method==="POST")')
    assert.equal(posts[0].url, '/api/maps/parent-map/ai-delegations/limited/refresh')
    assert.equal(posts[0].body.sourceRevision, 7)
    assert.equal(posts[0].body.targetRevision, 9)
    await evaluate('window.audit.confirm=false'); await click('기존 작업 재개')
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.method==="POST").length'), 1)
    await evaluate('window.audit.confirm=true'); await click('기존 작업 재개')
    await waitFor(() => evaluate('document.querySelector("[role=status]")?.textContent.includes("재개를 접수")')); await ready()
    posts = await evaluate('window.audit.calls.filter(c=>c.method==="POST")')
    assert.ok(posts[1].url.endsWith('/recover'))
    assert.equal(posts[1].body.expectedUpdatedAt, 'current')
    assert.equal(posts[1].body.confirmApprovedScope, true)
    await evaluate('window.audit.fail=true'); await click('기존 작업 재개')
    await waitFor(() => evaluate('document.querySelector("[role=alert]")?.textContent.includes("서버 상태")')); await ready()
    await evaluate('window.audit.fail=false; window.reportOnly()')
    await waitFor(() => evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="결과 전달 재시도")')); await ready()
    assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="기존 작업 재개")'), false)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="결과 전달 재시도").title'), /하위 작업은 다시 실행하지 않고/)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="후속 성공으로 종료").title'), /완료 처리하지 않고/)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="보고하지 않고 종료").title'), /바로 종료되지 않으며/)
    await click('결과 전달 재시도')
    await waitFor(() => evaluate('document.querySelector("[role=status]")?.textContent.includes("재전달을 접수")'))
    assert.ok((await evaluate('window.audit.calls.filter(c=>c.method==="POST").at(-1).url')).endsWith('/retry-report'))
    await click('후속 성공으로 종료')
    await waitFor(() => evaluate('document.querySelector("[role=status]")?.textContent.includes("후속 성공 위임")'))
    let last = await evaluate('window.audit.calls.filter(c=>c.method==="POST").at(-1)')
    assert.ok(last.url.endsWith('/supersede'))
    assert.equal(last.body.replacementDelegationId, 'replacement')
    assert.equal(last.body.confirmSupersededByCompletedDelegation, true)
    await click('보고하지 않고 종료')
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="취소").title'), /위임 상태와 저장된 결과는 변경되지 않습니다/)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="보고하지 않고 종료").title'), /완료로 기록하지 않고/)
    await evaluate(`(() => { const textarea=document.querySelector('.ai-delegation-close-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'되돌린 결과이므로 상위 보고 없이 종료합니다.');textarea.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'종료'})); })()`)
    await waitFor(() => evaluate('!Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="보고하지 않고 종료").disabled'))
    await click('보고하지 않고 종료')
    await waitFor(() => evaluate('document.querySelector("[role=status]")?.textContent.includes("사용자 종료 상태")'))
    last = await evaluate('window.audit.calls.filter(c=>c.method==="POST").at(-1)')
    assert.ok(last.url.endsWith('/close'))
    assert.equal(last.body.confirmClosedWithoutCompletion, true)
    assert.equal(last.body.confirmResultReportDiscarded, true)
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    await removeDirectory()
  }
})
