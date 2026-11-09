import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as proxyRequest } from 'node:http'
import { storageApi, fixture as mapFixture } from './helpers/storage-api-harness.mjs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/App.tsx';
import '/src/index.css';
import '/src/dark.css';
window.audit=[];window.loseMove=false;window.blockMoveResults=false;window.oldServer=false;
const originalFetch=window.fetch.bind(window);
window.fetch=async (url,init={})=>{
 if(!String(url).startsWith('/api/'))return originalFetch(url,init);
 if(window.oldServer && String(url)==='/api/health')return new Response(JSON.stringify({status:'ok'}),{status:200,headers:{'Content-Type':'application/json'}});
 if(window.blockMoveResults && init.headers?.['X-MNP-Result-Only']==='1')throw Error('결과 조회 일시 중단');

 const response=await originalFetch(url,init);
 window.audit.push({url:String(url),method:init.method??'GET',status:response.status});
 if(window.loseMove && String(url).endsWith('/move')){window.loseMove=false;await response.text();throw Error('이동 응답 유실');}
 return response;
};
createRoot(document.getElementById('root')).render(React.createElement(App));
`

test('실제 화면에서 다중 카드 잘라내기·문서 간 이동·취소·응답 유실 복구를 확인한다', {
  skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 180_000,
}, async (t) => {
  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const root = path.resolve(process.env.MNP_STORAGE_TEST_SOURCE_ROOT ?? path.resolve(import.meta.dirname, '..'))
  const api = await storageApi(t, { documents: 2, seed: async ({ data, ids }) => {
    for (const [index, id] of ids.entries()) {
      const map = mapFixture(id)
      map.nodes = map.nodes.slice(0, 6)
      map.edges = map.edges.slice(0, 5)
      map.nodes.forEach((n, i) => { n.position = { x: i % 3 * 280, y: Math.floor(i / 3) * 160 }; n.data.description = '화면 검수 원문'; n.data.sharedKnowledge = '' })
      if (index) {
        map.nodes.forEach((n) => { n.id = 'target-' + n.id })
        map.edges.forEach((e) => { e.id = 'target-' + e.id; e.source = 'target-' + e.source; e.target = 'target-' + e.target })
      } else {
        map.edges.find((e) => e.target === 'card-2').source = 'card-1'
        map.nodes[1].data.aiConversationId = 'browser-conversation'
      }
      await writeFile(path.join(data, id + '.json'), JSON.stringify(map))
    }
  } })
  const upstreams=new Set()
  // 실행 중인 설치의 파일 감시·의존성 캐시를 건드리지 않고 실제 App을 한 번 빌드한다.
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let bundle
  try {
    bundle = await build({ configFile: false, root, logLevel: 'error',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: { write: false, lib: { entry: path.join(root, 'card-cut-paste-fixture.js'), formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' } },
      plugins: [react(), {
        name: 'card-cut-paste-fixture', enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('/card-cut-paste-fixture.js') || id.endsWith('\\card-cut-paste-fixture.js')) return '\0card-cut-paste-fixture'
          if (id.startsWith('/src/')) return path.join(root, id.slice(1))
        },
        load: id => id === '\0card-cut-paste-fixture' ? fixture : null,
      }],
    })
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
  const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output)
  const entry = outputs.find(output => output.type === 'chunk' && output.isEntry)
  const styles = outputs.filter(output => output.fileName.endsWith('.css'))
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map(style => `<link rel="stylesheet" href="/${style.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture.test').pathname
    if(pathname.startsWith('/api/')) {
      const upstream=proxyRequest(api.base+req.url,{method:req.method,headers:{...req.headers,...api.headers,host:new URL(api.base).host}},response=>{
        res.writeHead(response.statusCode,response.headers);response.pipe(res);
      });
      upstreams.add(upstream);upstream.once('close',()=>upstreams.delete(upstream));
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()});
      res.once('close',()=>upstream.destroy());req.pipe(upstream);return;
    }
    if (pathname.startsWith('/mindmap/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(html)
      return
    }
    const asset = outputs.find(output => `/${output.fileName}` === pathname)
    if (!asset) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', asset.type === 'chunk' ? 'text/javascript' : 'text/css')
    res.end(asset.type === 'chunk' ? asset.code : asset.source)
  })
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-card-cut-paste-'))
  let browser, socket, send
  const pending = new Map(), errors = []
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) {
      try { if (await check()) return } catch { /* 페이지 전환 중에만 재조회한다. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw Error(`${message}: ${JSON.stringify(errors)}`)
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    console.log('[카드 이동 검증] 격리 페이지 준비')
    const base = `http://127.0.0.1:${server.address().port}`
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let port
    await until(async () => { port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return Boolean(port) }, '브라우저 시작 실패')
    console.log('[카드 이동 검증] Chrome 시작 확인')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json()
    const target = targets.find(item => item.type === 'page' && item.url === 'about:blank')
    assert.ok(target, '격리 Chrome의 초기 탭이 있어야 한다.')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    console.log('[카드 이동 검증] Chrome 제어 연결')
    let sequence = 0
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
      const item = pending.get(message.id)
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
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    const artifacts=path.resolve(process.env.MNP_INTEGRATION_BROWSER_ARTIFACTS??'.tmp/card-cut-paste-browser');
    await mkdir(artifacts,{recursive:true});
    const screenshot=async name=>{await new Promise(resolve=>setTimeout(resolve,200));return writeFile(path.join(artifacts,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))};
    const context = async (id) => evaluate(`document.querySelector('[data-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:650,clientY:200,button:2}))`)
    const menu = async (text) => evaluate(`(()=>{const b=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(text)});if(!b)throw Error('메뉴 없음');b.click()})()`)
    const idle = () => until(() => evaluate('!document.querySelector(".card-move-dialog")'), '이동 완료')
    await send('Page.navigate', { url: base + '/mindmap/map-bench-0/card-1' })
    await until(() => evaluate('!!document.querySelector(".description-field textarea")'), '실제 문서 화면')
    // 선택 카드와 하위 카드를 잘라내고 취소해도 정본이 바뀌지 않는다.
    const original = await api.read('map-bench-0.json')
    await context('card-1'); await menu('잘라내기'); await idle()
    assert.equal(await evaluate('document.querySelectorAll(".card-cut-pending").length'), 2)
    assert.deepEqual(await api.read('map-bench-0.json'), original)
    await screenshot('cut-preview')
    await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
    await until(() => evaluate('!document.querySelector(".card-cut-notice")'), '잘라내기 취소')
    assert.deepEqual(await api.read('map-bench-0.json'), original)
    // Ctrl 범위 선택으로 다른 카드를 추가한 뒤 우클릭해도 다중 선택이 유지된다.
    await evaluate(`(()=>{
      const r=document.querySelector('[data-id="card-3"]').getBoundingClientRect();
      document.querySelector('.react-flow__pane').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:42,button:0,ctrlKey:true,clientX:r.left-8,clientY:r.top-8}));
      window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:42,button:0,ctrlKey:true,clientX:r.right+8,clientY:r.bottom+8}));
      window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:42,button:0}));
    })()`)
    await until(() => evaluate('document.querySelectorAll(".react-flow__node.selected").length===2'), '다중 선택')
    await context('card-1'); await menu('잘라내기'); await idle()
    assert.equal(await evaluate('document.querySelectorAll(".card-cut-pending").length'), 3)
    await evaluate('document.querySelector("button[data-library-menu-id=map-bench-1]").click()')
    await until(() => evaluate('!!document.querySelector("[data-id=target-card-0]")'), '대상 문서 열기')
    await evaluate('window.oldServer=true')
    await context('target-card-0'); await menu('붙여넣기 (이동)'); await idle()
    assert.equal(await evaluate('window.audit.filter(r=>r.url.endsWith("/move")).length'),0)
    assert.equal(await evaluate('document.body.textContent.includes("서버에 카드 잘라내기·붙여넣기 기능이 아직 반영되지 않았습니다")'),true)
    await evaluate('window.oldServer=false')
    await context('target-card-0'); await screenshot('paste-menu')
    await evaluate('window.loseMove=true;window.blockMoveResults=true')
    await menu('붙여넣기 (이동)')
    await until(() => evaluate('!!document.querySelector(".card-move-dialog button")'), '결과 확인 대기')
    assert.equal(await evaluate('document.querySelector(".app-shell").inert'), true)
    assert.equal(await evaluate('window.audit.filter(r=>r.url.endsWith("/move")).length'),1)
    await screenshot('pending-result')
    await send('Page.reload')
    await until(() => evaluate('!!document.querySelector(".card-move-dialog button")'), '새로고침 후 결과 확인 대기 유지')
    await evaluate('document.querySelector(".card-move-dialog button").click()')
    await idle()
    const from = await api.read('map-bench-0.json'), to = await api.read('map-bench-1.json')
    for (const id of ['card-1','card-2','card-3']) {
      assert.equal(from.nodes.some(n=>n.id===id), false)
      assert.equal(to.nodes.filter(n=>n.id===id).length, 1)
    }
    assert.equal(to.nodes.find(n=>n.id==='card-1').data.aiConversationId,'browser-conversation')
    assert.ok(to.nodes.filter(n=>['card-1','card-2','card-3'].includes(n.id)).every(n=>n.position.y>300), '기존 카드 아래 빈 공간에 이동')
    assert.equal((await api.read('_card-move-operations.json')).length, 1)
    assert.equal(await evaluate('window.audit.filter(r=>r.url.endsWith("/move")).length'),0)
    assert.equal(await evaluate('document.querySelectorAll(".card-cut-pending").length'),0)
    await screenshot('moved')
    await evaluate('document.documentElement.dataset.theme="dark"')
    await context('card-3'); await menu('잘라내기'); await idle()
    await screenshot('dark-cut')
    await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
    await send('Page.reload')
    await until(() => evaluate('!!document.querySelector("[data-id=card-1]")'), '새로고침 후 이동 카드')
    assert.equal((await api.read('_card-move-operations.json')).length, 1)
    await writeFile(path.join(artifacts,'requests.json'),JSON.stringify(await evaluate('window.audit'),null,2))
    assert.deepEqual(errors, [], '처리되지 않은 브라우저 예외 없음')
  } finally {
    const artifacts=path.resolve(process.env.MNP_INTEGRATION_BROWSER_ARTIFACTS??'.tmp/card-cut-paste-browser');
    await mkdir(artifacts,{recursive:true});
    await writeFile(path.join(artifacts,'server-final.log'),api.output());
    if(send && socket?.readyState===WebSocket.OPEN){
      const state=await send('Runtime.evaluate',{expression:'JSON.stringify({audit:window.audit,text:document.body.innerText})',returnByValue:true}).catch(()=>null);
      if(state)await writeFile(path.join(artifacts,'page-final.json'),state.result.value);
      const screen=await send('Page.captureScreenshot',{format:'png'}).catch(()=>null);
      if(screen)await writeFile(path.join(artifacts,'final.png'),Buffer.from(screen.data,'base64'));
    }
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    for(const upstream of upstreams)upstream.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('mnp-card-cut-paste-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    }
  }
})
