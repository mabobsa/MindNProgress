import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 실제 지도·상세창을 실행하고 저장은 격리된 메모리 문서에만 반영한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow } from '@xyflow/react';
import App from '/src/App.tsx';
import { MindNode } from '/src/components/MindNode.tsx';
import { applyMapContentPatch } from '/src/utils/mapContentPatch.mjs';
import { applyUiTheme } from '/src/theme.ts';
import '/src/index.css';
import '/src/dark.css';
window.setTheme = applyUiTheme;
applyUiTheme('light');
const card = (id, data={}, x=0, y=0) => ({id,type:'mind',position:{x,y},data:{
  kind:'task',label:id,description:'원본 설명 보존',sharedKnowledge:'원본 공유 지식 보존',status:'planned',progress:0,isWork:false,...data}});
const material = card('material',{kind:'branch',label:'구현 기준 · KR 흐름 재사용·JP 화면 유지',status:'in-progress',progress:45,
  checklist:[{id:'check',text:'기존 체크리스트',done:false}],dueDate:'2026-12-31'},320,0);
const nodes = [card('root',{kind:'root',label:'문서 루트'},0,140),material,
  card('materials',{kind:'branch',label:'자료 묶음'},0,0),
  card('criteria',{kind:'branch',label:'요구사항 단계 배정표'},320,-140),
  card('tasks',{kind:'branch',label:'업무 묶음'},0,300),
  card('planned',{label:'실제 예정 업무',isWork:true},320,180),
  card('done',{label:'완료 업무',isWork:true,status:'done',progress:100},320,370)];
const edge = (source,target) => ({id:source+'-'+target,source,target});
const map = {id:'map-purpose',title:'카드 용도 검증',color:'violet',version:1,updatedAt:'2026-10-25T00:00:00Z',nodes,
  edges:[edge('root','materials'),edge('root','tasks'),edge('materials','material'),edge('materials','criteria'),edge('tasks','planned'),edge('tasks','done')]};
const summary = () => ({...map,nodeCount:map.nodes.length,rootProgress:50,rootStatus:'in-progress',waitingCount:0});
window.savedMap = map;
window.saveAttempts = 0;
window.EventSource = class {static OPEN=1;static CONNECTING=0;static CLOSED=2;readyState=1;addEventListener(){}removeEventListener(){}close(){this.readyState=2}};
const originalFetch = window.fetch.bind(window);
window.fetch = async (url,init={}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url,init);
  const pathname = new URL(url,location.origin).pathname;
  let body = {users:[],notifications:[],comments:[],stats:{},runtimes:{},activeCounts:{},clients:[],delegations:[]};
  if (pathname==='/api/maps/'+map.id+'/content-patch' && init.method==='PATCH') {
    Object.assign(map,applyMapContentPatch(map,JSON.parse(init.body).patch));map.version++;
    window.saveAttempts++;body={map,summary:summary()};
  }
  else if (pathname==='/api/auth/me') body={user:{id:'fixture',name:'검증 사용자',email:'fixture@example.test',role:'editor'}};
  else if (pathname==='/api/maps') body={maps:[summary()],documentLayout:{version:1,items:[{type:'map',id:map.id}],groups:[]}};
  else if (['/api/maps/archive','/api/maps/trash'].includes(pathname)) body={maps:[]};
  else if (pathname==='/api/maps/'+map.id) body={map};
  else if (pathname==='/api/health') body={publicBaseUrl:location.origin};
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
};
const root = createRoot(document.getElementById('root'));
const gallery = [card('plain',{label:'원장·감사 SHOP · 27건'}),
  card('long',{label:'긴 제목 자료 카드는 한 줄로 표시하고 넘치는 부분은 말줄임표로 표시합니다'},260,0),
  card('comments',{label:'댓글이 있는 자료',commentCount:3},520,0),
  card('alerts',{label:'복구가 필요한 자료',commentCount:2,unresolvedCommentCount:1,
    aiConversationRuntime:{state:'running'},aiDelegationStatus:{kind:'attention',recoveryCount:1,reportCount:0,title:'검증용 복구'},
    waitingItems:[{id:'waiting',label:'검토',since:'2026-10-25'}],onOpenWaitingItems:()=>window.waitingOpened=true},0,180),
  card('reference',{label:'다른 문서 자료 (Ref)',reference:{mapId:'other',nodeId:'source'}},260,180),
  card('dooray',{label:'Dooray 링크가 있는 긴 제목 자료 카드도 한 줄로 표시합니다',taskUrl:'https://fixture.dooray.com/task/1/2',commentCount:1},520,180),
  card('planned',{label:'실제 예정 업무',isWork:true},0,380),
  card('wiki',{label:'Wiki 링크가 있는 자료',taskUrl:'https://fixture.dooray.com/wiki/1/2'},260,380),
  card('runtime',{label:'AI 승인 대기 중인 자료',aiConversationRuntime:{state:'waiting-confirmation',pendingConfirmations:1}},520,380),
  card('branch-leaf',{kind:'branch',label:'하위 카드가 없는 기준 자료'},0,550),
  card('branch-group',{kind:'branch',label:'기준 · 자료 묶음',hasChildren:true,hiddenDescendantCount:2},260,550),
  card('task-group',{label:'일반 카드로 만든 자료 묶음',hasChildren:true,hiddenDescendantCount:2},520,550)];
window.showGallery = () => root.render(React.createElement(ReactFlow,{nodes:gallery,nodeTypes:{mind:MindNode},fitView:true}));
const refCard = (id, data, x, y) => card(id,{reference:{mapId:'other',nodeId:'source'},...data},x,y);
const references = [
  refCard('ref-plain',{label:'댓글 없는 Ref 자료'},0,0),
  refCard('ref-comments',{label:'댓글 있는 Ref 자료',commentCount:3},260,0),
  refCard('ref-broken',{label:'원본 연결이 끊긴 Ref 자료',referenceUnresolved:true},520,0),
  refCard('ref-work',{label:'진행 중인 원본 참조',kind:'branch',isWork:true,status:'in-progress',progress:40},0,180),
  refCard('ref-work-comments',{label:'댓글 있는 원본 참조',kind:'branch',isWork:true,status:'in-progress',progress:40,commentCount:3},260,180),
  refCard('ref-done',{label:'완료된 원본 참조',isWork:true,status:'done',progress:100},520,180),
];
window.showReferences = () => root.render(React.createElement(ReactFlow,{nodes:references,nodeTypes:{mind:MindNode},fitView:true}));
if (location.pathname==='/mindmap/gallery') window.showGallery();
else root.render(React.createElement(React.StrictMode,null,React.createElement(App)));
`

test('자료 제목을 세로 중앙 한 줄로 표시하고 용도 전환 시 원문·업무 값과 하위 업무 집계·알림을 보존한다', {
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
      build: { write: false, lib: { entry: path.join(root, 'material-fixture.js'), formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' } },
      plugins: [react(), {
        name: 'material-fixture', enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('/material-fixture.js') || id.endsWith('\\material-fixture.js')) return '\0material-fixture'
          if (id.startsWith('/src/')) return path.join(root, id.slice(1))
        },
        load: id => id === '\0material-fixture' ? fixture : null,
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
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-material-card-'))
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
    const state = id => evaluate(`(() => {const n=document.querySelector('.react-flow__node[data-id="${id}"] .mind-node');const h=n?.querySelector('h3');return n && {
      height:n.offsetHeight,width:n.offsetWidth,material:n.classList.contains('material'),text:n.textContent,
      background:getComputedStyle(n).backgroundColor,backgroundImage:getComputedStyle(n).backgroundImage,border:getComputedStyle(n).borderTopColor,
      descriptionTop:n.querySelector('p')?.offsetTop,
      titleTop:h.offsetTop,titleHeight:h.offsetHeight,titleLineHeight:parseFloat(getComputedStyle(h).lineHeight),
      titleOverflow:getComputedStyle(h).textOverflow,titleWhiteSpace:getComputedStyle(h).whiteSpace,
      titleClipped:h.scrollWidth>h.clientWidth,titleTooltip:h.title,titleText:h.textContent,
      status:n.querySelector('.node-status-badge')?.textContent,progress:n.querySelector('.node-progress')?.getAttribute('aria-label'),
      description:Boolean(n.querySelector('p')),comments:Boolean(n.querySelector('.node-comments-badge')),
      runtime:Boolean(n.querySelector('.ai-conversation-runtime-badge')),recovery:Boolean(n.querySelector('.ai-delegation-status-badge')),
      waiting:Boolean(n.querySelector('.node-waiting')),reference:Boolean(n.querySelector('.node-ref-badge'))};})()`)
    const screenshot = async name => {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      const target = path.join(tmpdir(), `mnp-material-${name}.png`)
      await writeFile(target, Buffer.from(result.data, 'base64'))
      t.diagnostic(`화면 확인: ${target}`)
    }
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: base + '/mindmap/gallery' })
    await until(() => state('plain'), '자료 카드 렌더링 실패')
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.setTheme('${theme}')`)
      // 배경색 전환 중간 프레임이 아닌 최종 화면을 확인한다.
      await evaluate('new Promise(resolve=>setTimeout(resolve,250))')
      const plain = await state('plain'), long = await state('long'), work = await state('planned'), alerts = await state('alerts')
      assert.ok(plain.height >= 80 && plain.height <= 100, `자료 카드 높이: ${plain.height}`)
      assert.equal(plain.width, work.width)
      assert.ok(plain.height < work.height)
      assert.equal(plain.status, undefined)
      assert.equal(plain.description, false)
      assert.equal(plain.progress, undefined)
      assert.equal(long.height, plain.height)
      assert.equal(long.titleClipped, true, '긴 제목은 카드 너비 안에서 잘린다')
      for (const id of ['plain','long','comments','alerts','dooray','wiki','runtime','branch-leaf','branch-group','task-group']) {
        const cardState = await state(id)
        assert.equal(cardState.material, true, `${id}: 자료는 내부 종류·하위 자료 유무와 관계없이 자료 스타일을 적용한다`)
        assert.equal(cardState.height, plain.height)
        assert.equal(cardState.background, plain.background)
        assert.equal(cardState.titleTop, plain.titleTop, `${id}: 상단 배지·링크·AI 표시와 무관하게 제목 위치를 유지한다`)
        assert.ok(Math.abs(cardState.titleTop + cardState.titleHeight / 2 - cardState.height / 2) <= 1, `${id}: 제목을 카드의 세로 중앙에 배치한다`)
        assert.ok(cardState.titleHeight <= Math.ceil(cardState.titleLineHeight), `${id}: 제목은 한 줄이다`)
        assert.equal(cardState.titleWhiteSpace, 'nowrap')
        assert.equal(cardState.titleOverflow, 'ellipsis')
        assert.equal(cardState.titleTooltip, cardState.titleText, '마우스를 올리면 전체 제목을 확인할 수 있다')
      }
      assert.match(work.status, /예정/)
      assert.equal(alerts.status, undefined)
      assert.ok(alerts.comments && alerts.runtime && alerts.recovery && alerts.waiting)
      assert.ok((await state('reference')).reference)
      await screenshot(theme)
    }
    await evaluate('document.querySelector(".node-waiting").click()')
    assert.equal(await evaluate('window.waitingOpened'), true)
    await evaluate('window.showReferences()')
    await until(() => state('ref-plain'), 'Ref 검증 화면 준비 실패')
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.setTheme('${theme}');new Promise(resolve=>setTimeout(resolve,250))`)
      for (const [withoutComments, withComments] of [['ref-plain','ref-comments'], ['ref-work','ref-work-comments']]) {
        const plain = await state(withoutComments), comments = await state(withComments)
        assert.equal(plain.titleTop, comments.titleTop, '댓글 유무와 관계없이 Ref 제목 위치를 유지한다')
        assert.equal(plain.descriptionTop, comments.descriptionTop, '댓글 유무와 관계없이 Ref 본문 위치를 유지한다')
        assert.equal(plain.height, comments.height)
        assert.ok(plain.reference && comments.reference)
      }
      if (theme === 'dark') {
        const plain = await state('ref-plain')
        assert.equal(plain.background, 'rgb(26, 29, 39)', 'Ref 배경은 어두운 자료 카드 색상과 일치한다')
        for (const id of ['ref-comments','ref-broken','ref-work','ref-work-comments','ref-done']) {
          const reference = await state(id)
          assert.equal(reference.background, plain.background)
          assert.equal(reference.backgroundImage, 'none', '원본 상태의 배경 그라데이션이 Ref 색상을 덮지 않는다')
          assert.equal(reference.border, plain.border)
        }
      }
      assert.match((await state('ref-done')).status, /완료/)
      await screenshot(`references-${theme}`)
    }
    await send('Page.navigate', { url: base + '/mindmap/map-purpose/material' })
    await until(() => evaluate('Boolean(document.querySelector(".card-purpose-options"))'), '카드 용도 선택 준비 실패')
    await evaluate('document.querySelector(".react-flow__node[data-id=material]").click()')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
    await evaluate('document.querySelector(".react-flow__node[data-id=criteria]").click()')
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
    await until(() => evaluate('document.querySelectorAll(".react-flow__node.selected").length===2'), '카드 다중 선택 실패')
    await evaluate('document.querySelector(".react-flow__node[data-id=material]").dispatchEvent(new MouseEvent("contextmenu", { bubbles:true, cancelable:true, button:2, clientX:400, clientY:300 }))')
    await until(() => evaluate('Boolean([...document.querySelectorAll(".node-context-menu [role=menuitem]")].find(el=>el.textContent.includes("복사 (2개)")))'), '다중 선택 복사 메뉴 누락')
    assert.equal(await evaluate('document.querySelectorAll(".react-flow__node.selected").length'), 2, '선택된 카드를 우클릭해도 다중 선택을 유지한다')
    await evaluate('[...document.querySelectorAll(".node-context-menu [role=menuitem]")].find(el=>el.textContent.includes("복사 (2개)")).click()')
    await evaluate('document.querySelector(".react-flow__node[data-id=tasks]").dispatchEvent(new MouseEvent("contextmenu", { bubbles:true, cancelable:true, button:2, clientX:400, clientY:300 }))')
    await until(() => evaluate('Boolean([...document.querySelectorAll(".node-context-menu [role=menuitem]")].find(el=>el.textContent.includes("2개 노드 복사본 생성")))'), '다중 카드 복사 결과 누락')
    assert.equal(await evaluate('document.querySelectorAll(".react-flow__node.selected").length'), 1, '선택 밖 카드를 우클릭하면 해당 카드만 선택한다')
    await evaluate('document.querySelector(".react-flow__node[data-id=material]").click()')
    await until(() => evaluate('Boolean(document.querySelector(".card-purpose-options button[aria-pressed=true]"))'), '자료 카드 다시 선택 실패')
    const saved = () => evaluate('window.savedMap.nodes.find(n=>n.id==="material").data')
    const original = await saved()
    const hasStatus = () => evaluate('Boolean([...document.querySelectorAll(".inspector label")].find(el=>el.querySelector("span")?.textContent==="상태"))')
    assert.equal(await hasStatus(), false)
    assert.equal(await evaluate('Boolean(document.querySelector(".progress-field"))'), false)
    assert.equal(await evaluate('document.querySelector(".card-purpose-options button[aria-pressed=true]").textContent'), '자료')
    assert.equal(await evaluate('document.querySelector(".description-field textarea").value'), original.description)
    for (const id of ['material', 'materials', 'criteria']) {
      const cardState = await state(id)
      assert.equal(cardState.material, true, `${id}: 자료인 branch 카드와 그 부모에 자료 스타일을 적용한다`)
      assert.equal(cardState.status, undefined, '자료만 묶으면 상태를 표시하지 않는다')
      assert.ok(cardState.height >= 80 && cardState.height <= 100)
    }
    assert.equal((await state('tasks')).material, false, '실제 하위 업무가 있으면 집계 카드 표시를 유지한다')
    assert.match((await state('tasks')).progress, /업무 2개.*50%/, '실제 업무만 자동 집계한다')
    assert.match((await state('root')).progress, /업무 2개.*50%/)
    const collapse = () => evaluate('document.querySelector(\'.react-flow__node[data-id="materials"] .node-collapse-toggle\').click()')
    await collapse()
    await until(() => evaluate('!document.querySelector(\'.react-flow__node[data-id="material"]\') && !document.querySelector(\'.react-flow__node[data-id="criteria"]\')'), '자료 묶음 접기 실패')
    assert.equal((await state('materials')).material, true, '접힌 자료 묶음도 자료 표시를 유지한다')
    await collapse()
    await until(() => state('material'), '자료 묶음 펼치기 실패')
    // 숨겨진 자식의 선택은 해제되므로, 펼친 카드를 다시 선택한 뒤 용도를 바꾼다.
    await evaluate('document.querySelector(\'.react-flow__node[data-id="material"]\').click()')
    await until(() => evaluate('document.querySelectorAll(".card-purpose-options button").length===2'), '펼친 자료 카드 선택 실패')
    for (const isWork of [true, false]) {
      const before = await evaluate('window.saveAttempts')
      await evaluate(`document.querySelectorAll('.card-purpose-options button')[${isWork ? 0 : 1}].click()`)
      await until(() => evaluate(`window.saveAttempts>${before} && window.savedMap.nodes.find(n=>n.id==='material').data.isWork===${isWork}`), '용도 저장 실패')
      assert.deepEqual(await saved(), { ...original, isWork }, '용도만 변경하고 본문·지식·업무 값을 보존한다')
      assert.equal(await hasStatus(), isWork)
      assert.equal((await state('material')).material, !isWork)
      assert.equal((await state('materials')).material, !isWork, '하위 자료의 업무 전환에 따라 부모 표시도 전환한다')
      if (isWork) assert.match((await state('materials')).progress, /업무 1개.*45%/)
      if (isWork) assert.match((await state('material')).status, /진행 중/, '기존 상태를 복원한다')
    }
    await evaluate('window.setTheme("dark")')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await evaluate('document.querySelector(".mobile-inspector-toggle").click()')
    await until(() => evaluate('Boolean(document.querySelector(".inspector.mobile-open"))'), '휴대폰 상세창 열기 실패')
    await evaluate('new Promise(resolve=>setTimeout(resolve,250))')
    await evaluate('document.querySelector(".card-purpose-options").scrollIntoView({block:"center"});new Promise(resolve=>setTimeout(resolve,250))')
    await screenshot('mobile-inspector')
    const bounds = await evaluate(`(() => {const r=document.querySelector('.card-purpose-options').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`)
    assert.ok(bounds.left>=0 && bounds.right<=bounds.width && bounds.top>=0 && bounds.bottom<=bounds.height, `휴대폰 용도 선택 영역: ${JSON.stringify(bounds)}`)
    assert.deepEqual(errors, [], '처리되지 않은 브라우저 예외 없음')
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('mnp-material-card-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    }
  }
})
