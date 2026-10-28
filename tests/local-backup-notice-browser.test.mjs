import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/src/App.tsx';
import { applyMapContentPatch } from '/src/utils/mapContentPatch.mjs';
import { tryWriteMapCache, MAP_CACHE_RETENTION_MS } from '/src/utils/mapLocalCache.mjs';
import '/src/index.css';
import '/src/dark.css';
const user = {id:'backup-test',name:'백업 경고 검증',email:'backup@example.test',role:'editor'};
const makeMap = id => ({id,title:id,color:'violet',version:1,updatedAt:'2026-10-15T00:00:00Z',
  nodes:[{id:'root',type:'mind',position:{x:100,y:100},data:{label:id,kind:'root',description:'원본 설명',sharedKnowledge:'',status:'planned',progress:0}}],edges:[]});
const maps = [makeMap('map-a'),makeMap('map-b')];
const summary = map => ({...map,nodeCount:1,rootProgress:0,rootStatus:'planned',waitingCount:0});
window.failLocalBackup = sessionStorage.getItem('backup-recovery-mode') !== '1';
window.failServerSave = false;
window.backupAttempts = 0;
window.saveAttempts = 0;
window.fixtureLoadId = crypto.randomUUID();
window.cacheTools = { retention:MAP_CACHE_RETENTION_MS, write:(id,content,synced,now)=>tryWriteMapCache(localStorage,id,content,{serverMap:synced?{id,version:1,...content}:null,now}) };
const originalSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function(key,value) {
  if (key.startsWith('mindnprogress-map-cache-v1:')) {
    window.backupAttempts++;
    if (window.failLocalBackup) throw new DOMException('테스트 저장 공간 부족','QuotaExceededError');
  }
  return originalSetItem.call(this,key,value);
};
window.EventSource = class {static OPEN=1;static CONNECTING=0;static CLOSED=2;readyState=1;addEventListener(){}removeEventListener(){}close(){this.readyState=2}};
const originalFetch = window.fetch.bind(window);
window.fetch = async (url,init={}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url,init);
  const pathname = new URL(url,location.origin).pathname;
  let body = {users:[],notifications:[],comments:[],stats:{},runtimes:{},activeCounts:{},clients:[]},status=200;
  const target = maps.find(map => pathname==='/api/maps/'+map.id+'/content-patch');
  if (target && init.method==='PATCH') {
    window.saveAttempts++;
    if (window.failServerSave) {status=503;body={error:'검증용 서버 저장 실패'};}
    else {Object.assign(target,applyMapContentPatch(target,JSON.parse(init.body).patch));target.version++;body={map:target,summary:summary(target)};}
  }
  else if (pathname==='/api/maps/legacy-reference') body={map:window.legacyReferenceRemote};
  else if (pathname==='/api/auth/me') body={user};
  else if (pathname==='/api/maps') body={maps:maps.map(summary),documentLayout:{version:1,items:maps.map(map=>({type:'map',id:map.id})),groups:[]}};
  else if (['/api/maps/archive','/api/maps/trash'].includes(pathname)) body={maps:[]};
  else if (maps.some(map=>pathname==='/api/maps/'+map.id)) body={map:maps.find(map=>pathname==='/api/maps/'+map.id)};
  else if (pathname==='/api/health') body={publicBaseUrl:location.origin};
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
`

test('휴대폰의 로컬 백업 단독 경고는 숨기고 서버 실패 경고와 데스크톱의 기존 닫기·재표시를 유지한다', {
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
      build: { write: false, lib: { entry: path.join(root, 'backup-notice-fixture.js'), formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' } },
      plugins: [react(), {
        name: 'backup-notice-fixture', enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('/backup-notice-fixture.js') || id.endsWith('\\backup-notice-fixture.js')) return '\0backup-notice-fixture'
          if (id.startsWith('/src/')) return path.join(root, id.slice(1))
        },
        load: id => id === '\0backup-notice-fixture' ? fixture : null,
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
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-backup-notice-'))
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
    console.log('[백업 경고 검증] 격리 페이지 준비')
    const base = `http://127.0.0.1:${server.address().port}`
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let port
    await until(async () => { port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return Boolean(port) }, '브라우저 시작 실패')
    console.log('[백업 경고 검증] Chrome 시작 확인')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json()
    const target = targets.find(item => item.type === 'page' && item.url === 'about:blank')
    assert.ok(target, '격리 Chrome의 초기 탭이 있어야 한다.')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    console.log('[백업 경고 검증] Chrome 제어 연결')
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
    const visible = expected => until(() => evaluate(`Boolean(document.querySelector('.local-backup-warning'))===${expected}`), '경고 표시 상태 불일치')
    const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const close = async () => { await evaluate('document.querySelector("button[aria-label=\\"로컬 백업 경고 닫기\\"]").click()'); await visible(false) }
    const edit = async text => {
      const before = await evaluate('window.saveAttempts')
      await evaluate(`(()=>{const e=document.querySelector('.description-field textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await until(() => evaluate(`window.saveAttempts>${before}`), '실제 자동 저장 요청 없음')
      await settle()
    }
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await send('Emulation.setTouchEmulationEnabled', { enabled: true })
    await send('Page.navigate', { url: base + '/mindmap/map-a/root' })
    await until(() => evaluate('window.backupAttempts>0 && Boolean(document.querySelector(".description-field textarea"))'), '휴대폰 문서와 백업 실패 준비')
    await settle(); await visible(false)
    const mobileWrites = await evaluate('window.backupAttempts')
    await edit('휴대폰의 로컬 백업 실패는 숨김')
    await visible(false)
    assert.ok(await evaluate('window.backupAttempts') > mobileWrites, '경고만 숨기고 백업 시도와 서버 저장은 계속한다.')
    await evaluate('window.failLocalBackup=false')
    await edit('휴대폰 백업 복구'); await visible(false)
    await evaluate('window.failLocalBackup=true')
    await edit('휴대폰 백업 재실패'); await visible(false)
    for (const mapId of ['map-b', 'map-a']) {
      await evaluate(`document.querySelector('.map-item[data-library-menu-id="${mapId}"]').click()`)
      await until(() => evaluate(`location.pathname.startsWith('/mindmap/${mapId}')`), '휴대폰 문서 전환 실패')
      await settle(); await visible(false)
    }
    const mobileLoadId = await evaluate('window.fixtureLoadId')
    await send('Page.reload')
    await until(() => evaluate(`window.fixtureLoadId && window.fixtureLoadId!==${JSON.stringify(mobileLoadId)} && window.backupAttempts>0`), '휴대폰 새로고침 실패')
    await settle(); await visible(false)
    console.log('[백업 경고 검증] 휴대폰 반복 실패·복구·재진입·새로고침에서 단독 경고 숨김')
    await send('Emulation.setDeviceMetricsOverride', { width: 721, height: 900, deviceScaleFactor: 1, mobile: false })
    await visible(true)
    await send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false })
    await visible(false)
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await visible(true)
    console.log('[백업 경고 검증] 기존 모바일 경계와 데스크톱 경고 표시')
    await evaluate('document.querySelector(".react-flow__node[data-id=root]").click()')
    await until(() => evaluate('Boolean(document.querySelector(".description-field textarea"))'), '편집 화면 준비 실패')
    const bounds = await evaluate('(()=>{const r=document.querySelector(".local-backup-warning button").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()')
    assert.ok(bounds.width >= 36 && bounds.height >= 36 && bounds.x >= 0 && bounds.right <= 1280 && bounds.bottom <= 900)
    await settle()
    const writes = await evaluate('window.backupAttempts')
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] })
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await visible(false)
    console.log('[백업 경고 검증] X 터치 닫기')
    assert.equal(await evaluate('window.backupAttempts'), writes, '닫기는 실패한 저장소에 쓰지 않는다.')
    await edit('닫은 뒤 반복 백업 실패')
    await visible(false)
    await evaluate('window.failServerSave=true')
    await edit('서버 저장도 실패')
    await visible(true)
    console.log('[백업 경고 검증] 서버 실패 재표시')
    assert.match(await evaluate('document.querySelector(".local-backup-warning").textContent'), /서버 저장에 실패/)
    await close(); await edit('같은 서버 실패 반복'); await visible(false)
    await evaluate('window.failServerSave=false')
    await edit('서버만 복구'); await visible(false)
    await evaluate('window.failLocalBackup=false')
    await edit('로컬 백업도 복구'); await visible(false)
    await evaluate('window.failLocalBackup=true')
    await edit('복구 이후 새 백업 실패'); await visible(true)
    console.log('[백업 경고 검증] 로컬 복구 후 재실패')
    await close()
    for (const mapId of ['map-b', 'map-a']) {
      await evaluate(`document.querySelector('.map-item[data-library-menu-id="${mapId}"]').click()`)
      await until(() => evaluate(`location.pathname.startsWith('/mindmap/${mapId}')`), '문서 전환 실패')
      await visible(true); await close()
    }
    const loadId = await evaluate('window.fixtureLoadId')
    await send('Page.reload')
    await until(() => evaluate(`window.fixtureLoadId && window.fixtureLoadId!==${JSON.stringify(loadId)}`), '페이지 새로고침 실패')
    await visible(true)
    console.log('[백업 경고 검증] 재진입·새로고침')
    await evaluate('document.documentElement.dataset.theme="dark"')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".local-backup-warning button")).color===getComputedStyle(document.querySelector(".local-backup-warning")).color'), true)
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await visible(false)
    await evaluate('window.failServerSave=true')
    await edit('휴대폰 서버 저장 실패는 숨기지 않음'); await visible(true)
    assert.match(await evaluate('document.querySelector(".local-backup-warning").textContent'), /서버 저장에 실패/)
    await evaluate('window.failServerSave=false')
    await edit('휴대폰 서버만 복구되면 단독 경고는 다시 숨김'); await visible(false)
    console.log('[백업 경고 검증] 휴대폰 서버 실패 경고 유지·복구 후 자동 숨김')

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await evaluate(`(() => {
      window.failLocalBackup=false;window.failServerSave=false;
      sessionStorage.setItem('backup-recovery-mode','1');
      for(const key of Object.keys(localStorage))if(key.startsWith('mindnprogress-map-cache-v1:'))localStorage.removeItem(key);
      const data={nodes:[{id:'root',data:{label:'별도 백업',description:'보존할 내용'}}],edges:[]};
      const old=Date.now()-window.cacheTools.retention-1000;
      window.cacheTools.write('expired-synced',data,true,old);
      window.cacheTools.write('offline-pending',data,false,old);
      const legacy={nodes:[{id:'ref',position:{x:0,y:0},data:{reference:{mapId:'source',nodeId:'source'},label:'구형 Ref',description:'x'.repeat(5*1024*1024-8192)}}],edges:[]};
      window.legacyReferenceRemote={...legacy,nodes:legacy.nodes.map(n=>({...n,data:{...n.data,label:'새 원본 제목',description:'새 원본 본문'}}))};
      localStorage.setItem('mindnprogress-map-cache-v1:legacy-reference',JSON.stringify(legacy));
    })()`)
    assert.ok(await evaluate(`Object.keys(localStorage).reduce((n,k)=>n+k.length+localStorage.getItem(k).length,0) > 5_200_000`), '실제 Chrome 저장 공간을 가득 채운다.')
    const nextMap = await evaluate(`location.pathname.includes('/map-a')?'map-b':'map-a'`)
    await evaluate(`document.querySelector('.map-item[data-library-menu-id="${nextMap}"]').click()`)
    await until(() => evaluate(`location.pathname.startsWith('/mindmap/${nextMap}') && Boolean(document.querySelector('.description-field textarea'))`), '복구 검증 문서 열기')
    assert.equal(await evaluate(`localStorage.getItem('mindnprogress-map-cache-v1:expired-synced')`), null, '7일 지난 서버 저장 백업 자동 삭제')
    await edit('용량 복구 검증 '.repeat(2000))
    await until(() => evaluate(`localStorage.getItem('mindnprogress-map-cache-v1:legacy-reference')===null`), 'Ref 표시값 차이가 있는 구형 백업 회수')
    await until(() => evaluate(`Boolean(JSON.parse(localStorage.getItem('mindnprogress-map-cache-v1:${nextMap}'))?.localBackup?.serverVersion)`), '실제 서버 저장 응답 이후 백업 확인 기록')
    await visible(false)
    assert.notEqual(await evaluate(`localStorage.getItem('mindnprogress-map-cache-v1:offline-pending')`), null, '7일 지난 미저장 백업은 보존')
    const recoveredLoadId = await evaluate('window.fixtureLoadId')
    await send('Page.reload')
    await until(() => evaluate(`window.fixtureLoadId && window.fixtureLoadId!==${JSON.stringify(recoveredLoadId)} && window.backupAttempts>0`), '복구 이후 새로고침')
    await settle(); await visible(false)
    assert.notEqual(await evaluate(`localStorage.getItem('mindnprogress-map-cache-v1:offline-pending')`), null)
    console.log('[백업 경고 검증] 실제 용량 부족에서 Ref 백업 회수·7일 자동 삭제·미저장 보존·새로고침 복구')
    assert.deepEqual(errors, [], '처리되지 않은 브라우저 예외 없음')
  } catch (error) {
    console.error('[백업 경고 검증 실패]', error)
    if (send && socket?.readyState === WebSocket.OPEN) {
      const state = await send('Runtime.evaluate', { expression: '({url:location.href,ready:document.readyState,loaded:window.fixtureLoadId,backupAttempts:window.backupAttempts,body:document.body.innerText.slice(0,1200)})', returnByValue: true }).catch(() => null)
      console.error('[백업 경고 화면 상태]', state?.result?.value)
    }
    throw error
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('mnp-backup-notice-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    }
  }
})
