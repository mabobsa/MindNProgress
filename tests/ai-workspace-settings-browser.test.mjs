import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 실제 MnP·AionUi·사용자 프로필에 접근하지 않고 실제 팝업 컴포넌트만 실행한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AiConversationDialog } from '/src/components/AiConversationDialog.tsx';
import { WorkspaceSettingsDialog } from '/src/components/WorkspaceSettingsDialog.tsx';
const root = createRoot(document.getElementById('root'));
const originalFetch = window.fetch.bind(window);
const workspaceContext = {mapId:'map-coordinator',groupId:'group-manager',groupName:'테스트 그룹',machineId:'fixture',machineRole:'main',documentSetting:{version:0,workspace:''},groupSetting:{version:1,workspace:'/fixture/project'},source:'group',workspace:'/fixture/project',error:'',choices:[],token:'initial',needsSelection:false};
const options = {connected:true,machineId:'fixture',machineLabel:'테스트',machineRole:'main',machines:[{machineId:'fixture',label:'테스트',role:'main'}],protocol:'fixture:',defaultWorkspace:workspaceContext.workspace,workspaceContext,workspaceBrowseAvailable:false,skills:[],mcpServers:[],agents:[{id:'test',name:'테스트 AI',models:[{id:'test',label:'테스트'}],defaultModelId:'test',modes:[],thoughtLevels:[]}]};
window.audit = { calls:[], fail:false, hold:false, closed:0, context:null };
window.open = () => ({document:{body:{style:{}}},location:{href:''},closed:false,focus(){},close(){this.closed=true}});
window.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url, init);
  const a = window.audit;
  a.calls.push({url,method:init.method || 'GET',body:init.body ? JSON.parse(init.body) : null});
  let body = {};
  if (url.startsWith('/api/maps/')) {
    if (a.hold) await new Promise((resolve,reject) => {a.release=resolve; init.signal?.addEventListener('abort',()=>reject(init.signal.reason),{once:true})});
    if (a.fail) return new Response(JSON.stringify({error:'그룹 역할 조회 실패'}),{status:503});
    body = a.context;
  } else if (url.startsWith('/api/integrations/aionui/options')) body = {...options,workspaceContext:a.workspaceContext || workspaceContext};
  else if (url.startsWith('/api/integrations/aionui/workspace-context')) body = a.workspaceContext || workspaceContext;
  else if (url === '/api/integrations/aionui/workspace-settings') {
    const input=JSON.parse(init.body), ctx=a.workspaceContext || workspaceContext;
    const setting={version:(input.scope==='group'?ctx.groupSetting:ctx.documentSetting).version+1,workspace:input.workspace};
    a.workspaceContext={...ctx,[input.scope==='group'?'groupSetting':'documentSetting']:setting,workspace:input.workspace,source:input.scope,error:'',needsSelection:false,token:ctx.token+'-saved'};
    body={setting};
  }
  else if (url === '/api/integrations/aionui/workspaces') body = {workspaces:[]};
  else if (url === '/api/integrations/aionui/attributions') body = {editorId:'fixture',attributionToken:'fixture',completionUrl:'http://fixture.invalid/completion'};
  else if (url === '/api/integrations/aionui/external-conversation-launches') body = {launchUrl:'about:blank'};
  else throw new Error('예상하지 않은 테스트 요청: '+url);
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
};
let sequence = 0;
window.renderDialog = (input = {}, flags = {}) => {
  Object.assign(window.audit,{calls:[],fail:false,hold:false,closed:0,context:{map:{id:'map-coordinator',nodes:[{id:'root',data:{kind:'root'}},{id:'child',data:{kind:'task'}}],edges:[{source:'root',target:'child'}]},groupProject:{groupId:'group-manager',role:'coordinator',coordinatorMapId:'map-coordinator'}},...flags});
  root.render(React.createElement(AiConversationDialog,{key:++sequence,userId:'fixture',documentId:'map-coordinator',documentTitle:'총괄 문서',cardId:'root',cardTitle:'총괄 루트',purpose:'card',knowledgeSources:[],launchInWebUi:true,onClose:()=>window.audit.closed++,...input}));
};
window.renderEditor = (editScope='document') => {
  root.render(React.createElement(WorkspaceSettingsDialog,{key:++sequence,mapId:editScope==='document'?'map-coordinator':'',groupId:editScope==='group'?'group-manager':'',name:'이름 편집',editScope,onRename:async(name)=>{window.audit.renamed=name},onClose:()=>window.audit.closed++}));
};
window.fixtureReady = true;
`

test('작업공간 확인·문서/그룹 저장·공통 메뉴·이름 편집 UI를 검증한다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 60_000 }, async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-browser-'))
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, '..'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [react(), {
      name: 'role-fixture', resolveId: (id) => id === '/role-fixture.js' ? '\0role-fixture' : null,
      load: (id) => id === '\0role-fixture' ? fixture : null,
      configureServer(vite) { vite.middlewares.use('/role-check', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/role-check', '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/role-fixture.js"></script></body></html>'))
      }) },
    }],
  })
  let browser, socket, send
  const pending = new Map()
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (fn) => {
    let lastError
    for (let i = 0; i < 100; i++) { try { const value = await fn(); if (value) return value } catch (error) { lastError = error }; await delay(100) }
    throw lastError ?? Error('화면 검증 대기 시간 초과')
  }
  try {
    await server.listen()
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--window-size=1440,1000', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let spawnError
    browser.on('error', (error) => { spawnError = error })
    const port = await waitFor(async () => { if (spawnError) throw spawnError; return (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0] })
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
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/role-check` })
    await waitFor(() => evaluate('window.fixtureReady'))
    const open = async (input = {}, flags = {}) => {
      await evaluate(`window.renderDialog(${JSON.stringify(input)},${JSON.stringify(flags)})`)
      await waitFor(() => evaluate('Boolean(document.querySelector(".ai-auto-request textarea")) && !document.querySelector(".ai-dialog footer .primary").disabled'))
      return evaluate('document.querySelector(".ai-auto-request textarea").value')
    }

    const configured={mapId:'map-coordinator',groupId:'group-manager',groupName:'테스트 그룹',machineId:'fixture',machineRole:'main',documentSetting:{version:1,workspace:'/document'},groupSetting:{version:1,workspace:'/group'},source:'document',workspace:'/document',error:'',choices:[],token:'configured',needsSelection:false};
    const mixed={...configured,documentSetting:{version:0,workspace:''},groupSetting:{version:0,workspace:''},source:'none',workspace:'',needsSelection:true,token:'mixed',choices:[{workspace:'/project',reasons:['문서 루트 대화']},{workspace:'/mnp',reasons:['과거 대화']}]};
    for (const purpose of ['card','group-coordination','shared-knowledge-review','document-reconstruction','card-layout']) {
      await open({purpose,initialRequest:'검토 요청'}, {workspaceContext:mixed});
      await evaluate('document.querySelector(".ai-dialog footer .primary").click()');
      await waitFor(()=>evaluate('Boolean(document.querySelector(".workspace-settings-dialog"))'));
      await waitFor(()=>evaluate('document.querySelectorAll(".workspace-settings-choices button").length===2'));
      assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/attributions"))'),false);
      assert.equal(await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").disabled'),true);
      await evaluate('document.querySelector(".workspace-settings-dialog header button").click()');
      await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog")'));
      assert.equal(await evaluate('window.audit.closed'),0);
    }
    await open({}, {workspaceContext:configured});
    assert.match(await evaluate('document.querySelector(".ai-workspace-field").textContent'),/문서 작업공간 기준/);
    await evaluate('document.querySelector(".ai-dialog footer .primary").click()');
    await waitFor(()=>evaluate('window.audit.closed===1'));
    assert.equal(await evaluate('window.audit.calls.find(c=>c.url.endsWith("/attributions")).body.workspace'),'/document');

    for(const scope of ['once','document','group']) {
      await open({}, {workspaceContext:mixed});
      await evaluate('document.querySelector(".ai-dialog footer .primary").click()');
      await waitFor(()=>evaluate('document.querySelectorAll(".workspace-settings-choices button").length===2'));
      await evaluate('document.querySelector(".workspace-settings-choices button").click()');
      await evaluate('document.querySelectorAll(".workspace-settings-dialog input[type=radio]")['+(['once','document','group'].indexOf(scope))+'].click()');
      const sizes=await evaluate('({title:getComputedStyle(document.querySelector(".workspace-settings-dialog strong")).fontSize,body:getComputedStyle(document.querySelector(".workspace-settings-dialog")).fontSize,button:getComputedStyle(document.querySelector(".workspace-settings-dialog footer button")).fontSize})');
      assert.deepEqual(sizes,{title:'15px',body:'10px',button:'9px'});
      await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").click()');
      await waitFor(()=>evaluate('window.audit.closed===1'));
      const posts=await evaluate('window.audit.calls.filter(c=>c.method==="POST")');
      assert.equal(posts.some(c=>c.url.endsWith('/workspace-settings')),scope!=='once');
      assert.equal(posts.find(c=>c.url.endsWith('/attributions')).body.workspace,'/project');
    }

    for (const editScope of ['document','group']) {
      await evaluate('window.audit.workspaceContext='+JSON.stringify(configured)+';window.audit.calls=[];window.renderEditor('+JSON.stringify(editScope)+')');
      await waitFor(()=>evaluate('Boolean(document.querySelector(".workspace-settings-path input"))'));
      await evaluate('(()=>{const el=document.querySelector(".workspace-settings-path input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"");el.dispatchEvent(new Event("input",{bubbles:true}))})()');
      await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").click()');
      await waitFor(()=>evaluate('window.audit.calls.some(c=>c.url.endsWith("/workspace-settings"))'));
      assert.equal(await evaluate('window.audit.calls.find(c=>c.url.endsWith("/workspace-settings")).body.workspace'),'');
    }
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate('document.documentElement.dataset.theme="dark";window.renderEditor()');
    await waitFor(()=>evaluate('Boolean(document.querySelector(".workspace-settings-path input"))'));
    assert.equal(await evaluate('document.querySelector(".workspace-settings-dialog").getBoundingClientRect().width<=390'),true);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".workspace-settings-dialog")).backgroundColor'),'rgb(36, 34, 45)');

  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()), '테스트 임시 경로의 상위 폴더 확인')
    assert.ok(path.basename(directory).startsWith('mnp-workspace-browser-'), '테스트 전용 임시 폴더 확인')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
})
