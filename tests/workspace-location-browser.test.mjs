import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/src/App.tsx';
import '/src/index.css';
import '/src/dark.css';
const user = {id:'selection-test',name:'선택 복원 검증',email:'selection@example.test',role:'viewer'};
const node = (id,label,kind,x) => ({id,type:'mind',position:{x,y:100},data:{label,kind,isWork:kind==='task',description:'검증용 카드',sharedKnowledge:'',status:'planned',progress:0}});
const makeMap = (id,title,task) => ({id,title,color:'violet',version:1,nodes:[node('root',title,'root',100),node(task,'선택할 작업','task',500)],edges:[{id:'edge',source:'root',target:task}],updatedAt:'2026-10-02T00:00:00Z'});
const maps = [makeMap('map-common','공통시스템','common-task'),makeMap('map-other','다른 문서','other-task')];
const summaries = maps.map(map => ({...map,nodeCount:2,rootProgress:0,rootStatus:'planned',waitingCount:0}));
const group = {id:'group-selection',name:'검증 그룹',mapIds:[]};
window.EventSource = class {static OPEN=1;static CONNECTING=0;static CLOSED=2;readyState=1;addEventListener(){}removeEventListener(){}close(){this.readyState=2}};
const originalFetch = window.fetch.bind(window);
window.fetch = async (url,init={}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url,init);
  const pathname = new URL(url,location.origin).pathname;
  let body = {users:[],notifications:[],comments:[],stats:{},runtimes:{},activeCounts:{},clients:[]};
  if (pathname==='/api/auth/me') body={user};
  else if (pathname==='/api/maps') body={maps:summaries,documentLayout:{version:1,items:[...maps.map(map=>({type:'map',id:map.id})),{type:'group',id:group.id}],groups:[group]}};
  else if (['/api/maps/archive','/api/maps/trash'].includes(pathname)) body={maps:[]};
  else if (maps.some(map=>pathname==='/api/maps/'+map.id)) body={map:maps.find(map=>pathname==='/api/maps/'+map.id)};
  else if (pathname==='/api/health') body={publicBaseUrl:location.origin};
  else if (pathname==='/api/groups/'+group.id) body={group,project:{version:1,coordinatorMapId:null,source:'',sourceVersion:'',objective:'',instructions:''},coordinator:null,documents:[],delegations:[],guide:{}};
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
};
window.fixtureLoadId = crypto.randomUUID();
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
`

test('휴대폰은 최근 카드 선택만 복원하고 문서 목록과 세부정보를 하나씩 열며 데스크톱 동작을 유지한다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 60000 }, async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-location-browser-'))
  const removeDirectory = async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mnp-location-browser-')) throw Error('테스트 임시 경로 검증 실패')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
  const server = await createServer({
    configFile: false, root: path.resolve(import.meta.dirname, '..'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [react(), {
      name: 'location-fixture',
      resolveId: id => id === '/location-fixture.js' ? '\0location-fixture' : null,
      load: id => id === '\0location-fixture' ? fixture : null,
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const pathname = new URL(req.url, 'http://fixture.test').pathname
          if (pathname !== '/' && !/^\/(viewer\/)?mindmap(?:\/|$)/.test(pathname) && !pathname.startsWith('/groups/')) return next()
          res.setHeader('Content-Type', 'text/html')
          res.end(await vite.transformIndexHtml(pathname, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/location-fixture.js"></script></body></html>'))
        })
      },
    }],
  })
  let browser, socket, send
  const pending = new Map()
  const errors = []
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) {
      try { if (await check()) return } catch { /* 새 문서가 준비될 때까지 기다린다. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw Error(`${message}: ${JSON.stringify(errors)}`)
  }
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let port
    await until(async () => { port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return Boolean(port) }, '브라우저 시작 실패')
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
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
    const loaded = async (cardId, pathname) => until(() => evaluate(`location.pathname===${JSON.stringify(pathname)} && Boolean(document.querySelector(${JSON.stringify(`.react-flow__node.selected[data-id="${cardId}"]`)}))`), `선택 복원 실패: ${pathname}`)
    const phonePanels = async (sidebar, inspector) => until(() => evaluate(`(() => {
      const library = document.querySelector('#document-library-panel');
      const details = document.querySelector('#node-inspector-panel');
      return library.classList.contains('mobile-open') === ${sidebar}
        && details.classList.contains('mobile-open') === ${inspector}
        && (getComputedStyle(library).visibility === 'visible') === ${sidebar}
        && (getComputedStyle(details).visibility === 'visible') === ${inspector}
        && document.querySelector('.mobile-library-toggle').getAttribute('aria-expanded') === '${sidebar}'
        && document.querySelector('.mobile-inspector-toggle').getAttribute('aria-expanded') === '${inspector}';
    })()`), '휴대폰 패널 열림 상태 불일치')
    const openLibrary = () => evaluate('document.querySelector(".mobile-library-toggle").click()')
    const openInspector = () => evaluate('document.querySelector(".mobile-inspector-toggle").click()')
    const navigate = async pathname => { await send('Page.navigate', { url: base + pathname }) }
    const reload = async () => {
      const previous = await evaluate('window.fixtureLoadId')
      await send('Page.reload')
      await until(() => evaluate(`Boolean(window.fixtureLoadId) && window.fixtureLoadId!==${JSON.stringify(previous)}`), '새로고침 실패')
    }
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await send('Emulation.setTouchEmulationEnabled', { enabled: true })
    await navigate('/mindmap/map-common/root?source=phone#keep')
    await loaded('root', '/mindmap/map-common/root')
    assert.equal(await evaluate('matchMedia("(max-width: 720px)").matches'), true)
    await phonePanels(false, false)
    await openLibrary(); await phonePanels(true, false)
    await evaluate('document.querySelector(".map-item[data-library-menu-id=map-other]").click()')
    await until(() => evaluate('Boolean(document.querySelector(".react-flow__node[data-id=other-task]"))'), '다른 문서 이동 실패')
    await evaluate('document.querySelector(".react-flow__node[data-id=other-task]").click()')
    await loaded('other-task', '/mindmap/map-other/other-task')
    await phonePanels(false, true)
    await openLibrary(); await phonePanels(true, false)
    await loaded('other-task', '/mindmap/map-other/other-task')
    await openInspector(); await phonePanels(false, true)
    await openInspector(); await phonePanels(false, false)
    // 같은 카드를 다시 선택하는 경로에서도 문서 목록과 세부정보가 동시에 열리지 않는다.
    await openLibrary(); await phonePanels(true, false)
    await evaluate('document.querySelector(".react-flow__node[data-id=other-task]").click()')
    await phonePanels(false, true)
    assert.equal(await evaluate('location.search+location.hash'), '?source=phone#keep')
    assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("mindnprogress-last-location:selection-test"))'), { mapId: 'map-other', viewMode: 'mindmap', nodeId: 'other-task' })
    await reload(); await loaded('other-task', '/mindmap/map-other/other-task')
    await phonePanels(false, false)
    await openInspector(); await phonePanels(false, true)
    await openLibrary(); await phonePanels(true, false)
    await reload(); await loaded('other-task', '/mindmap/map-other/other-task')
    await phonePanels(false, false)

    await navigate('/'); await loaded('other-task', '/mindmap/map-other/other-task')
    await phonePanels(false, false)
    await navigate('/mindmap/'); await loaded('other-task', '/mindmap/map-other/other-task')
    await phonePanels(false, false)
    await navigate('/viewer/mindmap/map-other/other-task'); await loaded('other-task', '/viewer/mindmap/map-other/other-task')
    await reload(); await loaded('other-task', '/viewer/mindmap/map-other/other-task')
    await phonePanels(false, false)

    await navigate('/mindmap/map-common/root'); await loaded('root', '/mindmap/map-common/root')
    await evaluate('document.querySelector(".react-flow__node[data-id=common-task]").click()')
    await loaded('common-task', '/mindmap/map-common/common-task')
    await reload(); await loaded('common-task', '/mindmap/map-common/common-task')
    await phonePanels(false, false)

    await evaluate('localStorage.setItem("mindnprogress-last-location:selection-test",JSON.stringify({mapId:"map-other",viewMode:"mindmap",nodeId:"deleted-card"}))')
    await navigate('/')
    await until(() => evaluate('location.pathname==="/mindmap/map-other" && Boolean(document.querySelector(".react-flow__node[data-id=other-task]"))'), '삭제된 카드 복원 처리 실패')
    assert.equal(await evaluate('Boolean(document.querySelector(".react-flow__node.selected"))'), false)
    await reload()
    await until(() => evaluate('Boolean(document.querySelector(".react-flow__node[data-id=other-task]"))'), '선택 없는 문서 복원 실패')
    assert.equal(await evaluate('Boolean(document.querySelector(".react-flow__node.selected"))'), false)

    await evaluate('document.querySelector(".document-group-open").click()')
    await until(() => evaluate('location.pathname==="/groups/group-selection" && Boolean(document.querySelector(".group-overview"))'), '그룹 주소 동기화 실패')
    await reload()
    await until(() => evaluate('location.pathname==="/groups/group-selection" && Boolean(document.querySelector(".group-overview"))'), '그룹 새로고침 실패')
    await evaluate('document.querySelector(".map-item[data-library-menu-id=map-other]").click()')
    await until(() => evaluate('Boolean(document.querySelector(".react-flow__node[data-id=other-task]"))'), '그룹 링크에서 문서 이동 실패')
    await evaluate('document.querySelector(".react-flow__node[data-id=other-task]").click()')
    await loaded('other-task', '/mindmap/map-other/other-task')
    await evaluate('document.querySelector("button[aria-label^=\\"화면 테마:\\"]").click()')
    await loaded('other-task', '/mindmap/map-other/other-task')
    await reload(); await loaded('other-task', '/mindmap/map-other/other-task')
    await phonePanels(false, false)

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await navigate('/mindmap/map-other/other-task'); await loaded('other-task', '/mindmap/map-other/other-task')
    await reload(); await loaded('other-task', '/mindmap/map-other/other-task')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#node-inspector-panel")).visibility'), 'visible')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#document-library-panel")).visibility'), 'visible')
    await evaluate('document.querySelector(".react-flow__node[data-id=root]").click()')
    await loaded('root', '/mindmap/map-other/root')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#node-inspector-panel")).visibility'), 'visible')
    assert.deepEqual(errors, [])
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    await removeDirectory()
  }
})
