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
import { AiDelegationStatusBadge } from '/src/components/AiConversationRuntimeBadge.tsx';
import { aiDelegationStatusByCard } from '/src/utils/aiDelegationStatus.mjs';
const root = createRoot(document.getElementById('root'));
const originalFetch = window.fetch.bind(window);
window.audit = { calls: [], confirm: true, fail: false, focus: null, selection: null, preview: null };
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
const selectCard = (mapId,cardId) => { window.audit.selection = {mapId,cardId} };
const previewCards = (cards) => { window.audit.preview = cards };
window.renderChildRecovery = (props={}) => root.render(React.createElement(AiDelegationRecovery,{key:++sequence,mapId:'child-map',cardId:'child',onSelectCard:selectCard,onPreviewCards:previewCards,...props}));
window.renderRecovery = (props={}) => root.render(React.createElement(React.Fragment,null,
  React.createElement(AiDelegationStatusBadge,{status:aiDelegationStatusByCard([item],'parent-map').parent}),
  React.createElement(AiDelegationRecovery,{key:++sequence,mapId:'parent-map',cardId:'parent',onSelectCard:selectCard,onPreviewCards:previewCards,...props})));
window.failedRecovery = () => {item.state='failed';item.workspaceResult=null;item.workspaceError=null;item.recovery={recoveryAvailable:true};item.childError='모델 용량 초과';window.renderRecovery()};
window.quarantinedIntegration = () => {item.state='failed';item.childStatus='completed';item.workCompleted=false;item.reportPending=false;item.reportStatus=null;item.childError=null;item.parentError=null;item.workspaceError='로컬 변경으로 cherry-pick 실패';item.workspaceResult={status:'quarantined',childStatus:'completed'};item.recovery={recoveryAvailable:false,failureCategory:'non-retryable',recommendedAction:'inspect-failure'};item.closure={closeAvailable:false,reason:'workspace-changes-preserved'};window.renderRecovery()};
window.resolvedQuarantine = state => {item.state=state;item.recovery=null;window.renderRecovery()};
window.retryIntegration = () => {item.recovery={recoveryAvailable:true,failureCategory:'workspace-local-changes',recommendedAction:'retry-integration'};window.renderRecovery()};
window.reportOnly = () => {item.state='parent-wake-failed';item.childError=null;item.parentError='보고 사용량 초과';item.workCompleted=true;item.reportPending=true;item.recovery={recoveryAvailable:false,reportRetryAvailable:true};item.closure={closeAvailable:true,reason:'completed-child-report-abandonment'};window.renderRecovery()};
window.waitingReport = () => {item.state='waiting-parent';item.childError=null;item.parentError=null;item.workCompleted=true;item.reportPending=true;item.reportStatus='waiting';item.reportWaitReason='parent-busy';item.recovery=null;item.closure=null;window.renderRecovery()};
window.deliveringReport = () => {item.state='waking-parent';item.reportStatus='delivering';window.renderRecovery()};
window.receivedReport = () => {item.state='completed';item.reportPending=false;item.reportStatus='received';item.recovery=null;item.closure=null;window.renderRecovery()};
window.fixtureReady = true;
`

test('상위 카드 복구 화면은 하위 카드를 제외하고 AI 없이 재개·보고 재시도를 구분한다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 120000 }, async () => {
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
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method)) }, method === 'Page.navigate' ? 30000 : 10000)
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
    await evaluate('window.renderChildRecovery()')
    await waitFor(() => evaluate('window.audit.calls.some(c=>c.url==="/api/maps/child-map/ai-delegations")'))
    assert.equal(await evaluate('Boolean(document.querySelector(".ai-delegation-recovery"))'), false)
    await evaluate('window.renderRecovery({focusRequestId:7,onFocusHandled:id=>window.audit.focus=id})'); await ready()
    await waitFor(() => evaluate('window.audit.focus===7'))
    assert.equal(await evaluate('document.activeElement?.classList.contains("ai-delegation-recovery")'), true)
    assert.equal(await evaluate('document.body.textContent.includes("다른 카드 작업")'), false)
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.method==="POST").length'), 0)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="상태 다시 확인").title'), /새 AI 실행은 요청하지 않습니다/)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="기존 작업 재개").title'), /해당 AI가 다시 실행됩니다/)
    assert.equal(await evaluate(`(() => {
      const heading = document.querySelector('.ai-delegation-recovery-item-heading b');
      const bounds = heading.getBoundingClientRect();
      return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.classList.contains('ai-delegation-recovery-item-select');
    })()`), true)
    await evaluate(`document.querySelector('.ai-delegation-recovery-item').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`)
    assert.deepEqual(await evaluate('window.audit.preview'), {
      parent: { mapId: 'parent-map', cardId: 'parent' },
      target: { mapId: 'child-map', cardId: 'child' },
    })
    await evaluate(`document.querySelector('.ai-delegation-recovery-item').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))`)
    assert.equal(await evaluate('window.audit.preview'), null)
    await evaluate('document.querySelector(".ai-delegation-recovery-item-select").click()')
    assert.deepEqual(await evaluate('window.audit.selection'), { mapId: 'child-map', cardId: 'child' })
    await evaluate('window.audit.selection=null')
    await click('상태 다시 확인')
    assert.equal(await evaluate('window.audit.selection'), null)
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
    const beforeQuarantinePosts = await evaluate('window.audit.calls.filter(c=>c.method==="POST").length')
    await evaluate('window.quarantinedIntegration()'); await ready()
    assert.equal(await evaluate('document.querySelector(".ai-delegation-status-badge")?.textContent'), 'AI 위임 복구 필요')
    assert.match(await evaluate('document.querySelector(".ai-delegation-recovery-heading")?.textContent'), /복구 필요 1건/)
    assert.match(await evaluate('document.body.textContent'), /통합 복구 필요/)
    assert.match(await evaluate('document.body.textContent'), /격리되어 수동 확인과 복구가 필요/)
    assert.match(await evaluate('document.querySelector(".ai-delegation-recovery-error-detail")?.textContent'), /로컬 변경으로 cherry-pick 실패/)
    assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).some(b=>["기존 작업 재개","결과 전달 재시도","후속 성공으로 종료","보고하지 않고 종료"].includes(b.textContent))'), false)
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.method==="POST").length'), beforeQuarantinePosts)
    await evaluate('window.retryIntegration()'); await ready()
    assert.match(await evaluate('document.body.textContent'), /로컬 변경을 보존·정리한 뒤 통합 재시도/)
    assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="기존 작업 재개")'), false)
    assert.match(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="통합 재시도").title'), /하위 AI 작업은 다시 실행하지 않습니다/)
    await evaluate('window.audit.confirm=false'); await click('통합 재시도')
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.method==="POST").length'), beforeQuarantinePosts)
    await evaluate('window.audit.confirm=true'); await click('통합 재시도')
    await waitFor(() => evaluate('document.querySelector("[role=status]")?.textContent.includes("통합 재시도를 접수")')); await ready()
    const integrationPost = await evaluate('window.audit.calls.filter(c=>c.method==="POST").at(-1)')
    assert.ok(integrationPost.url.endsWith('/recover'))
    assert.match(integrationPost.body.instruction, /완료 커밋 통합 재시도/)
    assert.equal(integrationPost.body.confirmApprovedScope, true)
    for (const state of ['completed', 'superseded', 'closed']) {
      await evaluate(`window.resolvedQuarantine(${JSON.stringify(state)})`)
      await waitFor(() => evaluate('!document.querySelector(".ai-delegation-recovery") && !document.querySelector(".ai-delegation-status-badge")'))
    }
    await evaluate('window.failedRecovery()'); await ready()
    assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="기존 작업 재개")'), true)
    await evaluate('window.waitingReport()'); await ready()
    assert.match(await evaluate('document.body.textContent'), /총괄에 결과 전달 대기/)
    assert.match(await evaluate('document.body.textContent'), /상위 AI가 작업 중/)
    assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="기존 작업 재개" || b.textContent==="결과 전달 재시도")'), false)
    await evaluate('window.deliveringReport()'); await ready()
    assert.match(await evaluate('document.body.textContent'), /총괄에 결과 전달 중/)
    await evaluate('window.receivedReport()')
    await waitFor(() => evaluate('!document.querySelector(".ai-delegation-recovery")'))
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    await removeDirectory()
  }
})
