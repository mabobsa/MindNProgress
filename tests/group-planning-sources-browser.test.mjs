import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 실제 그룹 화면을 사용하되 통신·프로필은 격리한다. 실행 중 MnP와 사용자 데이터에는 접근하지 않는다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GroupOverview } from '/src/components/GroupOverview.tsx';
import '/src/index.css';
import '/src/dark.css';
const root = createRoot(document.getElementById('root'));
const originalFetch = window.fetch.bind(window);
window.confirm = () => true;
const legacy = {version:7,coordinatorMapId:'map-coordinator',source:'https://example.invalid/기본',sourceVersion:'v0.4',objective:'전체 목표 원문',instructions:'공통 지침 원문'};
const coordinator = {id:'map-coordinator',title:'통합 관리',version:1,root:{id:'root',data:{kind:'root',label:'총괄'}},work:{total:0,done:0,waiting:0}};
const makeContext = (supported=true) => ({group:{id:'group-test',name:'JP-매니저',mapIds:['map-coordinator']},project:{...legacy,...(supported?{sources:[{id:'source-legacy',title:'',source:legacy.source,sourceVersion:legacy.sourceVersion}]}:{})},coordinator,documents:[coordinator],delegations:[],guide:{coordinator:''},waitingReviewSupported:true,sourcesSupported:supported});
window.audit = {context:makeContext(),patches:[],launches:[],fail:false};
window.fetch = async (url, init={}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url,init);
  if (url !== '/api/groups/group-test') throw Error('예상하지 않은 통신: '+url);
  const a=window.audit;
  if (init.method==='PATCH') {
    const body=JSON.parse(init.body); a.patches.push(body);
    if(a.fail) return new Response(JSON.stringify({error:'시험 저장 실패'}),{status:503});
    if(body.baseVersion!==a.context.project.version) return new Response(JSON.stringify({error:'버전 충돌'}),{status:409});
    const {baseVersion,sources,...fields}=body;
    a.context.project={...a.context.project,...fields,sources,source:sources[0]?.source||'',sourceVersion:sources[0]?.sourceVersion||'',version:baseVersion+1};
  }
  return new Response(JSON.stringify(a.context),{headers:{'Content-Type':'application/json'}});
};
let sequence=0;
window.renderGroup=(editable=true,supported=true,reset=false)=>{
  if(reset) window.audit={context:makeContext(supported),patches:[],launches:[],fail:false};
  root.render(React.createElement(GroupOverview,{key:++sequence,groupId:'group-test',name:'JP-매니저',membershipKey:'test',editable,clientId:'fixture',onNavigate(){},onLaunch(target){window.audit.launches.push(target)},onConversations(){},onLibraryChanged(){}}));
};
window.renderGroup(); window.fixtureReady=true;
`

test('총괄 화면에서 기획서 추가·저장·제거·새로고침 보존·읽기 전용·구서버 잠금을 검증한다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 60_000 }, async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-sources-browser-'))
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
  assert.ok(path.basename(directory).startsWith('mnp-sources-browser-'))
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, '..'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [react(), {
    name: 'sources-fixture', resolveId: (id) => id === '/sources-fixture.js' ? '\0sources-fixture' : null,
    load: (id) => id === '\0sources-fixture' ? fixture : null,
    configureServer(vite) { vite.middlewares.use('/sources-check', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await vite.transformIndexHtml('/sources-check', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>#root{display:flex}</style></head><body><div id="root"></div><script type="module" src="/sources-fixture.js"></script></body></html>'))
    }) },
  }] })
  let browser, socket, send
  const pending = new Map()
  const errors = []
  const waitFor = async (action) => {
    let lastError
    for (let i = 0; i < 100; i++) { try { const result = await action(); if (result) return result } catch (error) { lastError = error }; await new Promise((resolve) => setTimeout(resolve, 100)) }
    throw lastError ?? Error('화면 검증 대기 시간 초과')
  }
  try {
    await server.listen()
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore', windowsHide: true })
    let spawnError
    browser.on('error', (error) => { spawnError = error })
    const port = await waitFor(async () => { if (spawnError) throw spawnError; return (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0] })
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let sequence = 0
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
      const item = pending.get(message.id)
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
    const click = (text) => evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(text)}).click()`)
    const setInput = (label, value) => evaluate(`(() => {const input=document.querySelector('input[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    const saveDisabled = () => evaluate('document.querySelector("button[form=group-criteria-form]").disabled')
    await send('Runtime.enable')
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/sources-check` })
    await waitFor(() => evaluate('window.fixtureReady && Boolean(document.querySelector(".group-criteria-strip"))'))
    await click('기획 기준')
    await waitFor(() => evaluate('document.querySelectorAll(".group-source-entry").length===1'))
    assert.equal(await evaluate(`document.querySelector('input[aria-label="기획서 1 주소"]').value`), 'https://example.invalid/기본')
    assert.equal(await saveDisabled(), true)
    await click('기획서 추가')
    await waitFor(() => evaluate('document.querySelectorAll(".group-source-entry").length===2'))
    await setInput('기획서 2 이름', '옷장 추가 기획')
    await setInput('기획서 2 주소', 'C:\\기획 자료\\추가.pptx')
    await setInput('기획서 2 버전', 'v0.1')
    await click('새로고침')
    assert.equal(await evaluate(`document.querySelector('input[aria-label="기획서 2 버전"]').value`), 'v0.1')
    assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="총괄 AI 대화 시작").disabled'), true)
    await evaluate('window.audit.fail=true')
    await click('기준 저장')
    await waitFor(() => evaluate('document.querySelector("[role=alert]")?.textContent.includes("시험 저장 실패")'))
    assert.equal(await evaluate('document.querySelectorAll(".group-source-entry").length'), 2)
    await evaluate('window.audit.fail=false')
    await click('기준 저장')
    await waitFor(() => saveDisabled())
    assert.equal(await evaluate('window.audit.context.project.sources.length'), 2)
    assert.equal(await evaluate('window.audit.context.project.objective'), '전체 목표 원문')
    assert.equal(await evaluate('window.audit.context.project.instructions'), '공통 지침 원문')
    assert.equal(await evaluate('window.audit.patches.some(body=>"source" in body || "sourceVersion" in body)'), false)
    assert.equal(await evaluate('document.querySelector(".group-criteria-strip strong").textContent'), '기획서 2개')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".group-source-entry input")).fontSize'), '11px')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".group-source-entry label")).fontSize'), '9px')
    const artifacts = await mkdtemp(path.join(tmpdir(), 'mnp-sources-screenshots-'))
    const capture = async (name) => { const result = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(artifacts, name), Buffer.from(result.data, 'base64')) }
    await capture('sources-desktop.png')
    await evaluate('document.documentElement.dataset.theme="dark"')
    await capture('sources-dark.png')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    assert.equal(await evaluate('innerWidth'), 390)
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
    await capture('sources-mobile.png')
    console.log('기획서 목록 화면 검증 이미지:', artifacts)
    await send('Emulation.clearDeviceMetricsOverride')
    await setInput('기획서 2 버전', '편집 중')
    await evaluate('window.audit.context.project.version++; window.audit.context.project.sources[1].sourceVersion="다른 세션 수정"')
    await click('새로고침')
    await waitFor(() => evaluate('document.querySelector(".group-message.warning")?.textContent.includes("다른 곳에서")'))
    await click('새로고침')
    assert.equal(await evaluate(`document.querySelector('input[aria-label="기획서 2 버전"]').value`), '편집 중')
    assert.equal(await saveDisabled(), true)
    await click('최신 내용 불러오기')
    await evaluate(`document.querySelector('button[aria-label="기획서 2 제거"]').click()`)
    await click('기준 저장')
    await waitFor(() => evaluate('window.audit.context.project.sources.length===1'))
    await evaluate('window.renderGroup(false)')
    await waitFor(() => evaluate('Boolean(document.querySelector(".group-criteria-strip"))'))
    await click('기획 기준')
    assert.equal(await evaluate('document.querySelectorAll(".group-source-list li").length'), 1)
    assert.equal(await evaluate('Boolean(document.querySelector(".group-source-entry"))'), false)
    await evaluate('window.renderGroup(true,false,true)')
    await waitFor(() => evaluate('Boolean(document.querySelector(".group-criteria-strip"))'))
    await click('기획 기준')
    assert.equal(await evaluate('document.querySelector("[role=alert]").textContent.includes("서버를 재시작")'), true)
    assert.equal(await evaluate('document.querySelector(".group-source-entry input").matches(":disabled")'), true)
    assert.equal(await saveDisabled(), true)
    assert.deepEqual(errors, [])
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise((resolve) => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
})
