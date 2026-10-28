import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/src/App.tsx';
import '/src/index.css';
import '/src/dark.css';
const user={id:'read-browser',name:'조회 검증',email:'read@example.test',role:'editor'};
const makeMap=id=>({id,title:id,color:'violet',version:1,updatedAt:'2026-10-27T00:00:00Z',nodes:[{id:'root',type:'mind',position:{x:100,y:100},data:{label:'조회 갱신 검증',kind:'root',description:'격리 브라우저 자료',sharedKnowledge:'',status:'planned',progress:0}}],edges:[]});
const maps=[makeMap('map-a'),makeMap('map-b')];
window.audit=[];window.revision=1;window.sources=[];window.polls=[];window.fail=false;window.hold=false;
const originalInterval=window.setInterval.bind(window);
window.setInterval=(fn,ms,...args)=>{if(ms===30000)window.polls.push(fn);return originalInterval(fn,ms,...args)};
window.EventSource=class { static OPEN=1;readyState=1;constructor(){window.sources.push(this)}addEventListener(){}removeEventListener(){}close(){this.readyState=2}};
window.emit=type=>window.sources.at(-1).onmessage?.({data:JSON.stringify({type,mapId:'map-a'})});
const originalFetch=window.fetch.bind(window);
window.fetch=async(url,init={})=>{
 if(!String(url).startsWith('/api/'))return originalFetch(url,init);
 const pathname=new URL(url,location.origin).pathname;
 let body={users:[],notifications:[],comments:[],stats:{},runtimes:[],activeCounts:{},clients:[],delegations:[]};
 if(pathname.endsWith('/ai-delegations')){
  const version=window.revision,etag='"'+pathname+':'+version+'"';
  window.audit.push({url:String(url),etag:init.headers?.['If-None-Match']??null,version});
  if(window.hold){window.hold=false;await new Promise(resolve=>window.release=resolve)}
  if(window.fail)return new Response('{}',{status:503});
  if(init.headers?.['If-None-Match']===etag)return new Response(null,{status:304,headers:{etag}});
  const item={id:'active',mapId:pathname.split('/')[3],parentCardId:'root',targetCardId:'root',createdAt:'2026-10-27',state:version===3?'completed':version===2?'recovery-required':'running',...(version===2?{recovery:{recoveryAvailable:true}}:{})};
  body={delegations:[item,...Array.from({length:200},(_,i)=>({...item,id:'history-'+i,state:'completed',recovery:null,createdAt:'2026-10-26',result:'고정 결과'.repeat(200)}))],requestFailures:[]};
  return new Response(JSON.stringify(body),{headers:{etag,'Content-Type':'application/json'}});
 }
 if(pathname==='/api/auth/me')body={user};
 else if(pathname==='/api/maps')body={maps:maps.map(map=>({...map,nodeCount:1,rootProgress:0,rootStatus:'planned',waitingCount:0})),documentLayout:{version:1,items:maps.map(map=>({type:'map',id:map.id})),groups:[]}};
 else if(['/api/maps/archive','/api/maps/trash'].includes(pathname))body={maps:[]};
 else if(maps.some(map=>pathname==='/api/maps/'+map.id))body={map:maps.find(map=>pathname==='/api/maps/'+map.id)};
 else if(pathname==='/api/health')body={publicBaseUrl:location.origin};
 return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
};
createRoot(document.getElementById('root')).render(React.createElement(App));
`

test('실제 App에서 조건부 위임 조회·이벤트·재연결·유실 보완·조회 중 변경·문서 전환을 확인한다', {
  skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const root = path.resolve(import.meta.dirname, '..')
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
    await send('Page.navigate', { url: base + '/mindmap/map-a/root' })
    await until(() => evaluate('window.audit?.length>0 && !!document.querySelector(".ai-delegation-status-badge.active")'), '첫 조회 표시')
    assert.equal(await evaluate('window.audit[0].etag'), null)
    const calls = await evaluate('window.audit.length')
    await evaluate('window.dispatchEvent(new Event("focus"))')
    await until(() => evaluate(`window.audit.length>${calls}`), '조건부 재조회')
    assert.ok(await evaluate('window.audit.at(-1).etag'))
    assert.ok(await evaluate('!!document.querySelector(".ai-delegation-status-badge.active")'))
    await evaluate('window.revision=2;window.emit("ai-delegation-changed")')
    await until(() => evaluate('!!document.querySelector(".ai-delegation-status-badge.recovery-required")'), '변경 이벤트 반영')
    await evaluate('window.fail=true;window.revision=3;window.emit("ai-delegation-request-resolved")')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.ok(await evaluate('!!document.querySelector(".ai-delegation-status-badge.recovery-required")'), '오류 중 기존 상태 유지')
    await evaluate('window.fail=false;window.sources.at(-1).onopen?.()')
    await until(() => evaluate('!document.querySelector(".ai-delegation-status-badge")'), '재연결 동기화')
    await evaluate('window.revision=2;window.polls.at(-1)()')
    await until(() => evaluate('!!document.querySelector(".ai-delegation-status-badge.recovery-required")'), 'SSE 유실 후 30초 주기 보완')
    await evaluate('window.hold=true;window.emit("ai-delegation-changed")')
    await until(() => evaluate('!!window.release'), '진행 중 조회 대기')
    await evaluate('window.revision=3;window.emit("ai-delegation-changed");window.release()')
    await until(() => evaluate('!document.querySelector(".ai-delegation-status-badge")'), '진행 중 도착한 변경의 후속 조회')
    await evaluate(`window.revision=1;document.querySelector('.map-item[data-library-menu-id="map-b"]').click()`)
    await until(() => evaluate('window.audit.some(item=>item.url.includes("map-b")) && !!document.querySelector(".ai-delegation-status-badge.active")'), '다른 문서 조회')
    assert.equal(await evaluate('window.audit.find(item=>item.url.includes("map-b")).etag'), null, '이전 문서 ETag를 재사용하지 않는다')
    const artifacts = path.resolve(process.env.MNP_READ_BROWSER_ARTIFACTS ?? '.tmp/read-cost-browser-artifacts')
    await mkdir(artifacts, { recursive: true })
    await writeFile(path.join(artifacts, 'refresh.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    await writeFile(path.join(artifacts, 'requests.json'), JSON.stringify(await evaluate('window.audit'), null, 2))
    assert.deepEqual(errors, [], '처리되지 않은 브라우저 예외 없음')
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('mnp-read-cost-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    }
  }
})
