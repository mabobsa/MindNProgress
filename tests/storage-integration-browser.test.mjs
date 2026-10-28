import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as proxyRequest } from 'node:http'
import { storageApi, fixture as mapFixture } from './helpers/storage-api-harness.mjs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/App.tsx';
import '/src/index.css';
import '/src/dark.css';
window.audit=[];window.failNextWrite=false;
const originalFetch=window.fetch.bind(window);
window.fetch=async (url,init={})=>{
 if(!String(url).startsWith('/api/'))return originalFetch(url,init);
 if(window.failNextWrite && String(url).endsWith('/content-patch')){window.failNextWrite=false;window.audit.push({url:String(url),status:503,injected:true});return new Response(JSON.stringify({error:'격리 화면 저장 실패 주입'}),{status:503,headers:{'Content-Type':'application/json'}});}
 const response=await originalFetch(url,init);
 window.audit.push({url:String(url),method:init.method??'GET',status:response.status});
 return response;
};
createRoot(document.getElementById('root')).render(React.createElement(App));
`

test('실제 App·격리 API에서 본문·지식·댓글 저장과 오류·프로세스 재시작 후 SSE 복구를 확인한다', {
  skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 180_000,
}, async (t) => {
  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const root = path.resolve(process.env.MNP_STORAGE_TEST_SOURCE_ROOT ?? path.resolve(import.meta.dirname, '..'))
  const api=await storageApi(t,{documents:3,seed:async({data,ids})=>{for(const id of ids){const map=mapFixture(id);for(const n of map.nodes){n.data.description='화면 검수 원문';n.data.sharedKnowledge='화면 검수 지식'};await writeFile(path.join(data,id+'.json'),JSON.stringify(map))}}})
  const upstreams=new Set()
  // 실행 중인 설치의 파일 감시·의존성 캐시를 건드리지 않고 실제 App을 한 번 빌드한다.
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let bundle
  try {
    bundle = await build({ configFile: false, root, logLevel: 'error',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: { write: false, lib: { entry: path.join(root, 'read-cost-fixture.js'), formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' } },
      plugins: [react(), {
        name: 'read-cost-fixture', enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('/read-cost-fixture.js') || id.endsWith('\\read-cost-fixture.js')) return '\0read-cost-fixture'
          if (id.startsWith('/src/')) return path.join(root, id.slice(1))
        },
        load: id => id === '\0read-cost-fixture' ? fixture : null,
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
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-read-cost-'))
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
    console.log('[조회 갱신 검증] 격리 페이지 준비')
    const base = `http://127.0.0.1:${server.address().port}`
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let port
    await until(async () => { port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return Boolean(port) }, '브라우저 시작 실패')
    console.log('[조회 갱신 검증] Chrome 시작 확인')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json()
    const target = targets.find(item => item.type === 'page' && item.url === 'about:blank')
    assert.ok(target, '격리 Chrome의 초기 탭이 있어야 한다.')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    console.log('[조회 갱신 검증] Chrome 제어 연결')
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
    const artifacts=path.resolve(process.env.MNP_INTEGRATION_BROWSER_ARTIFACTS??'.tmp/storage-integration-browser');
    await mkdir(artifacts,{recursive:true});
    const screenshot=async name=>writeFile(path.join(artifacts,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    const edit=async(selector,value)=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("입력 요소 없음");e.scrollIntoView({block:"center"});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
    const map=async()=>api.read('map-bench-0.json');
    const saved=async(field,value)=>until(async()=> (await map()).nodes[1].data[field]===value,'권위 저장 '+field);
    await send('Page.navigate',{url:base+'/mindmap/map-bench-0/card-1'});
    await until(()=>evaluate('!!document.querySelector(".description-field textarea")'),'실제 문서 화면');
    await edit('.description-field textarea','07 실제 화면 본문 저장');
    await saved('description','07 실제 화면 본문 저장');
    await edit('.shared-knowledge-field textarea','07 실제 화면 공유 지식 저장');
    await saved('sharedKnowledge','07 실제 화면 공유 지식 저장');
    await screenshot('saved');
    await edit('.comment-summary-editor textarea','[진행] 07 실제 화면 댓글 저장');
    await until(()=>evaluate('document.querySelector(".node-comments .comment-form button[type=submit]")?.disabled===false'),'댓글 입력 완료');
    await evaluate('document.querySelector(".node-comments .comment-form button[type=submit]").click()');
    await until(async()=>{try{return(await api.read('_comments/map-bench-0.json')).some(c=>c.summary==='[진행] 07 실제 화면 댓글 저장')}catch{return false}},'권위 댓글 저장');
    await until(()=>evaluate('document.querySelector(".comment-list").textContent.includes("07 실제 화면 댓글 저장")'),'댓글 화면 반영');
    await screenshot('comment');
    await evaluate('window.failNextWrite=true');
    await edit('.description-field textarea','07 실패한 화면 입력');
    await until(()=>evaluate('document.body.textContent.includes("격리 화면 저장 실패 주입")'),'저장 실패 표시');
    assert.equal((await map()).nodes[1].data.description,'07 실제 화면 본문 저장');
    await screenshot('save-error');
    await edit('.description-field textarea','07 오류 이후 화면 저장 복구');
    await saved('description','07 오류 이후 화면 저장 복구');
    await until(()=>evaluate('window.audit.filter(r=>r.method==="PATCH"&&r.status===200&&r.url.endsWith("/content-patch")).length>=3'),'저장 성공 응답 수신');
    await api.restart();
    const before=(await api.call('/api/maps/map-bench-0')).body.map;
    // 외부 저장은 실제 API의 전체 PUT 계약을 사용한다. 화면에는 실제 SSE로 전달된다.
    const next=structuredClone(before);next.nodes[1].data.sharedKnowledge='07 재시작 이후 외부 지식 반영';
    const external=await api.call('/api/maps/map-bench-0','PUT',{map:next,baseVersion:before.version,baseLifecycleVersion:before.lifecycleVersion??0});
    assert.equal(external.status,200,JSON.stringify(external));
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await until(()=>evaluate('document.querySelector(".shared-knowledge-field textarea").value==="07 재시작 이후 외부 지식 반영" || [...document.querySelectorAll("button")].some(b=>b.textContent==="변경 내용 불러오기")'),'재연결 이후 최신 내용 또는 변경 안내');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="변경 내용 불러오기")?.click()');
    await until(()=>evaluate('document.querySelector(".shared-knowledge-field textarea").value==="07 재시작 이후 외부 지식 반영"'),'재시작·재연결 이후 최신 지식');
    await screenshot('reconnected');
    await send('Page.reload');
    await until(()=>evaluate('document.querySelector(".description-field textarea")?.value==="07 오류 이후 화면 저장 복구"'),'새로고침 권위 본문');
    await until(()=>evaluate('document.querySelector(".comment-list")?.textContent.includes("07 실제 화면 댓글 저장")'),'새로고침 댓글');
    const final=await map(),comments=await api.read('_comments/map-bench-0.json');
    const files={};for(const file of ['map-bench-0.json','_comments/map-bench-0.json']){const raw=await readFile(path.join(api.data,file));files[file]={sha256:createHash('sha256').update(raw).digest('hex'),bytes:raw.length}};
    await writeFile(path.join(artifacts,'authority.json'),JSON.stringify({final,comments,files},null,2));
    await writeFile(path.join(artifacts,'requests.json'),JSON.stringify(await evaluate('window.audit'),null,2));
    await writeFile(path.join(artifacts,'server.log'),api.output());
    assert.deepEqual(errors, [], '처리되지 않은 브라우저 예외 없음')
  } finally {
    const artifacts=path.resolve(process.env.MNP_INTEGRATION_BROWSER_ARTIFACTS??'.tmp/storage-integration-browser');
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
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('mnp-read-cost-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    }
  }
})
