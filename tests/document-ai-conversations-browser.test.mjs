import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 실제 App의 문서 메뉴를 사용하고, 조회·삭제는 메모리 응답으로만 검증한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/src/App.tsx';
import { applyUiTheme } from '/src/theme.ts';
import '/src/index.css';
import '/src/dark.css';
window.setTheme=applyUiTheme;
applyUiTheme('light');
const conversation=(id,options={})=>({conversationId:id,name:'정리 검토 대화 '+id,
  agent:{id:'codex',label:'Codex'},model:{id:'hidden',label:'표시하지 않는 모델'},
  skills:[],mcpServers:[],requestPreview:'표시하지 않는 요청',workspace:'표시하지 않는 작업공간',
  homeMachineLabel:'개발 PC',homeMachineRole:'main',accessible:true,machineOnline:true,available:true,
  startedAt:'2026-10-25T12:30:00Z',runtime:{state:'idle'},...options});
const groups=[
  {cardId:'a',cardTitle:'카드A · 기준 정리',conversations:[conversation('a-new'),conversation('a-old',{startedAt:'2026-10-24T10:00:00Z'})]},
  {cardId:'b',cardTitle:'카드B · 화면 개발',conversations:[conversation('b-new'),conversation('b-old',{agent:{id:'claude',label:'Claude'}})]},
  {cardId:'offline',cardTitle:'연결이 끊긴 머신',conversations:[conversation('offline',{machineOnline:false,homeMachineLabel:'서브 PC'})]},
  {cardId:'locked',cardTitle:'권한 없는 머신',conversations:[conversation('locked',{accessible:false,homeMachineLabel:'권한 없는 PC'})]},
  {cardId:'e',cardTitle:'카드E · 회귀 확인',conversations:[conversation('e')]},
  {cardId:'f',cardTitle:'카드F · 결과 정리',conversations:[conversation('f')]},
].map(group=>({...group,latestConversationId:group.conversations[0].conversationId}));
const node=(id,label,extra={})=>({id,type:'mind',position:{x:0,y:0},data:{kind:'task',label,description:'',status:'planned',progress:0,...extra}});
const map=(id,title,nodes)=>({id,title,nodes,edges:[],version:1,color:'violet',updatedAt:'2026-10-26T00:00:00Z'});
const active=map('map-active','현재 열린 문서',[node('root','현재 루트',{kind:'root'})]);
const target=map('map-target','정리할 문서',groups.map(group=>node(group.cardId,group.cardTitle,{aiConversations:group.conversations,aiConversationId:group.latestConversationId})));
const summary=m=>({...m,nodeCount:m.nodes.length,rootProgress:0,rootStatus:'planned',waitingCount:0});
window.audit={requests:[],deletions:[],confirm:false,fail:false,pending:false,releaseDelete:null,details:{},listMode:'normal'};
window.confirm=()=>window.audit.confirm;
window.EventSource=class {static OPEN=1;static CONNECTING=0;static CLOSED=2;readyState=1;addEventListener(){}removeEventListener(){}close(){this.readyState=2}};
const originalFetch=window.fetch.bind(window);
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(url,init={})=>{
  if(!String(url).startsWith('/api/')) return originalFetch(url,init);
  window.audit.requests.push({url:String(url),method:init.method||'GET'});
  const pathname=new URL(url,location.origin).pathname;
  if(pathname==='/api/maps/map-target/ai-conversations') {
    if(window.audit.listMode==='error') return json({error:'문서 목록 조회 실패'},503);
    return json({cards:window.audit.listMode==='empty'?[]:groups.map(group=>({...group,conversations:group.conversations.map(c=>({...c,available:false,liveStatusChecked:false}))}))});
  }
  const route=pathname.match(/^\\/api\\/maps\\/map-target\\/cards\\/([^/]+)\\/ai-conversations(?:\\/([^/]+))?$/);
  if(route) {
    const group=groups.find(group=>group.cardId===route[1]);
    if(init.method==='DELETE') {
      window.audit.deletions.push({cardId:route[1],conversationId:route[2]});
      if(window.audit.fail) return json({error:'보관 확인 실패: 연결을 유지합니다.'},409);
      if(window.audit.pending) await new Promise(resolve=>window.audit.releaseDelete=resolve);
      group.conversations=group.conversations.filter(c=>c.conversationId!==route[2]);
      group.latestConversationId=group.conversations[0]?.conversationId??null;
      return json({map:target,latestConversationId:group.latestConversationId});
    }
    const snapshot=structuredClone(group);
    return new Promise(resolve=>window.audit.details[group.cardId]=()=>resolve(json(snapshot)));
  }
  if(pathname==='/api/auth/me') return json({user:{id:'fixture',name:'검증 사용자',email:'fixture@example.test',role:'editor'}});
  if(pathname==='/api/maps') return json({maps:[summary(active),summary(target)],documentLayout:{version:1,items:[{type:'map',id:active.id},{type:'map',id:target.id}],groups:[]}});
  if(['/api/maps/archive','/api/maps/trash'].includes(pathname)) return json({maps:[]});
  if(pathname==='/api/maps/'+active.id) return json({map:active});
  if(pathname==='/api/maps/'+target.id) return json({map:target});
  if(pathname==='/api/health') return json({publicBaseUrl:location.origin});
  return json({users:[],notifications:[],comments:[],stats:{},runtimes:{},activeCounts:{},clients:[],delegations:[]});
};
createRoot(document.getElementById('root')).render(React.createElement(App));
`

test('문서 메뉴에서 카드별 AI 대화를 간략히 표시하고 우클릭으로 하나씩 삭제한다', {
  skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 120_000,
}, async t => {
  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const root = path.resolve(import.meta.dirname, '..')
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let bundle
  try {
    bundle = await build({ configFile: false, root, logLevel: 'error',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: { write: false, lib: { entry: path.join(root, 'document-conversations-fixture.js'), formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' } },
      plugins: [react(), {
        name: 'document-conversations-fixture', enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('/document-conversations-fixture.js') || id.endsWith('\\document-conversations-fixture.js')) return '\0document-conversations-fixture'
          if (id.startsWith('/src/')) return path.join(root, id.slice(1))
        },
        load: id => id === '\0document-conversations-fixture' ? fixture : null,
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
    if (pathname.startsWith('/mindmap/')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return }
    const asset = outputs.find(output => `/${output.fileName}` === pathname)
    if (!asset) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', asset.type === 'chunk' ? 'text/javascript' : 'text/css')
    res.end(asset.type === 'chunk' ? asset.code : asset.source)
  })
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-document-conversations-'))
  let browser, socket, send
  const pending = new Map(), errors = []
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) {
      try { if (await check()) return } catch { /* 페이지 전환 중 재조회 */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw Error(`${message}: ${JSON.stringify(errors)}`)
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let port, spawnError
    browser.on('error', error => { spawnError = error })
    await until(async () => { if (spawnError) throw spawnError; port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return port }, '브라우저 시작 실패')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json()
    const target = targets.find(item => item.type === 'page' && item.url === 'about:blank')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
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
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: base + '/mindmap/map-active' })
    await until(() => evaluate('!!document.querySelector("[data-library-menu-id=map-target]")'), '문서 메뉴 준비 실패')
    const openDocumentList = async () => {
      await evaluate('document.querySelector("[data-library-menu-id=map-target]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:150,clientY:180}))')
      await until(() => evaluate('[...document.querySelectorAll(".document-context-menu [role=menuitem]")].some(el=>el.textContent.includes("AI 대화 목록"))'), '문서 AI 대화 목록 메뉴 누락')
      await evaluate('[...document.querySelectorAll(".document-context-menu [role=menuitem]")].find(el=>el.textContent.includes("AI 대화 목록")).click()')
      await until(() => evaluate('!!document.querySelector(".document-conversations")'), '문서 목록 열기 실패')
    }
    const rows = () => evaluate('[...document.querySelectorAll(".ai-conversation-card-group")].map(group=>({cardId:group.dataset.cardId,ids:[...group.querySelectorAll(".ai-conversation-choice")].map(el=>el.dataset.conversationId)}))')
    const row = id => `.ai-conversation-choice[data-conversation-id="${id}"]`
    const openRowMenu = async id => {
      await evaluate(`document.querySelector('${row(id)}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:280}))`)
      await until(() => evaluate('!!document.querySelector(".ai-conversation-picker-menu")'), '대화 우클릭 메뉴 누락')
    }
    const clickDelete = () => evaluate('document.querySelector(".ai-conversation-picker-menu [role=menuitem]").click()')
    const screenshot = async name => {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      const target = path.join(tmpdir(), `mnp-document-conversations-${name}.png`)
      await writeFile(target, Buffer.from(result.data, 'base64'))
      t.diagnostic(`화면 확인: ${target}`)
    }
    await openDocumentList()
    await until(() => evaluate('document.querySelectorAll(".ai-conversation-choice").length===8'), '전체 카드 대화 표시 실패')
    const initialRows = await rows()
    assert.deepEqual(initialRows, [
      { cardId: 'a', ids: ['a-new', 'a-old'] }, { cardId: 'b', ids: ['b-new', 'b-old'] },
      { cardId: 'offline', ids: ['offline'] }, { cardId: 'locked', ids: ['locked'] },
      { cardId: 'e', ids: ['e'] }, { cardId: 'f', ids: ['f'] },
    ])
    assert.equal(await evaluate('location.pathname'), '/mindmap/map-active', '다른 문서의 목록을 열어도 현재 작업 문서를 변경하지 않는다')
    assert.equal(await evaluate('document.querySelector(".document-conversations header small").textContent'), '정리할 문서')
    assert.equal(await evaluate('document.querySelectorAll(".compact .ai-conversation-choice-open > *").length'), 32, '대화마다 네 항목만 표시한다')
    assert.equal(await evaluate('document.querySelector(".document-conversations").textContent.includes("표시하지 않는")'), false)
    assert.equal(await evaluate('!!document.querySelector(".document-conversations .primary")'), false, '전체 목록은 새 대화 생성을 제공하지 않는다')
    await until(() => evaluate('Object.keys(window.audit.details).length===3'), '상세 조회 시작 실패')
    assert.deepEqual(await evaluate('Object.keys(window.audit.details)'), ['a', 'b', 'e'], '동시 조회는 세 카드로 제한하고 오프라인·권한 없는 머신은 건너뛴다')
    await evaluate('window.audit.details.b();window.audit.details.e()')
    await until(() => evaluate('typeof window.audit.details.f==="function"'), '다음 카드 조회 실패')
    await evaluate('window.audit.details.f()')
    assert.equal(await evaluate('document.querySelector(".compact").offsetHeight<60'), true, '기존 상세 대화 항목보다 높이를 줄인다')
    await screenshot('light')
    await evaluate('window.setTheme("dark");new Promise(resolve=>setTimeout(resolve,200))')
    await screenshot('dark')

    await openRowMenu('offline')
    assert.equal(await evaluate('document.querySelector(".ai-conversation-picker-menu button").disabled'), true)
    await openRowMenu('locked')
    assert.equal(await evaluate('document.querySelector(".ai-conversation-picker-menu button").disabled'), true)
    await openRowMenu('a-new')
    await clickDelete()
    assert.deepEqual(await evaluate('window.audit.deletions'), [], '확인 취소 시 삭제하지 않는다')
    await evaluate('window.audit.confirm=true;window.audit.pending=true')
    await openRowMenu('a-new')
    await clickDelete()
    await until(() => evaluate('typeof window.audit.releaseDelete==="function"'), '삭제 요청 실패')
    assert.equal(await evaluate('!!document.querySelector(".ai-conversation-picker-progress[role=status]")'), true)
    assert.equal(await evaluate('document.querySelector(".document-conversations header button").disabled'), true)
    await openRowMenu('b-new')
    assert.equal(await evaluate('document.querySelector(".ai-conversation-picker-menu button").disabled'), true, '다른 카드도 삭제 완료까지 다음 삭제를 막는다')
    await clickDelete()
    assert.equal(await evaluate('window.audit.deletions.length'), 1)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    assert.equal(await evaluate('!!document.querySelector(".document-conversations")'), true, '삭제 중 창이 닫혀 중복 삭제로 이어지지 않는다')
    await evaluate('window.audit.releaseDelete();window.audit.pending=false')
    await until(() => evaluate('document.querySelectorAll(".ai-conversation-choice").length===7'), '삭제 후 목록 갱신 실패')
    await evaluate('window.audit.details.a()')
    await until(() => evaluate('!document.querySelector("[data-card-id=a] .unavailable")'), '늦은 상세 조회 갱신 실패')
    assert.equal(await evaluate(`!!document.querySelector('${row('a-new')}')`), false, '늦은 조회 응답이 삭제한 대화를 복원하지 않는다')
    assert.deepEqual((await rows()).find(group => group.cardId === 'b'), initialRows[1], '다른 카드와 대화 순서는 유지한다')

    await evaluate('window.audit.fail=true')
    await openRowMenu('b-new')
    await clickDelete()
    await until(() => evaluate('document.querySelector("[role=alert]")?.textContent.includes("보관 확인 실패")'), '실패 안내 누락')
    assert.equal(await evaluate(`!!document.querySelector('${row('b-new')}')`), true, '실패한 대화는 목록에 남긴다')
    await evaluate('window.audit.fail=false')
    await openRowMenu('a-old')
    await clickDelete()
    await until(() => evaluate('!document.querySelector("[data-card-id=a]")'), '마지막 대화 삭제 후 빈 카드 그룹 제거 실패')
    assert.deepEqual(await evaluate('window.audit.deletions'), [
      { cardId: 'a', conversationId: 'a-new' }, { cardId: 'b', conversationId: 'b-new' }, { cardId: 'a', conversationId: 'a-old' },
    ])
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await screenshot('mobile')
    assert.equal(await evaluate('(()=>{const el=document.querySelector(".document-conversations"),r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&el.scrollWidth<=el.clientWidth})()'), true)
    await openRowMenu('b-old')
    assert.equal(await evaluate('(()=>{const r=document.querySelector(".ai-conversation-picker-menu").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'), true)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await evaluate('document.querySelector(".document-conversations header button").click();window.audit.listMode="empty"')
    await openDocumentList()
    await until(() => evaluate('document.querySelector(".document-conversations").textContent.includes("연결된 AI 대화가 없습니다.")'), '빈 목록 안내 실패')
    await evaluate('document.querySelector(".document-conversations header button").click();window.audit.listMode="error"')
    await openDocumentList()
    await until(() => evaluate('document.querySelector(".document-conversations").textContent.includes("문서 목록 조회 실패")'), '조회 오류 안내 실패')
    assert.deepEqual(errors, [], '처리되지 않은 브라우저 예외 없음')
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('mnp-document-conversations-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    }
  }
})
