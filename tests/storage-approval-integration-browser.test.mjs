import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as proxyRequest } from 'node:http'
import { approvalIntegrationFixture } from './helpers/approval-integration-fixture-07.mjs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/App.tsx';
import '/src/index.css';
import '/src/dark.css';
window.audit=[];window.holdStatus=false;
window.open=()=>({document:{body:{style:{}}},location:{href:''},closed:false,focus(){},close(){this.closed=true}});
const originalFetch=window.fetch.bind(window);
window.fetch=async (url,init={})=>{
 if(!String(url).startsWith('/api/'))return originalFetch(url,init);
 if(window.holdStatus && String(url).endsWith('/status'))return new Response(JSON.stringify({status:'pending'}),{headers:{'Content-Type':'application/json'}});
 const response=await originalFetch(url,init);
 window.audit.push({url:String(url),method:init.method??'GET',status:response.status});
 return response;
};
createRoot(document.getElementById('root')).render(React.createElement(App));
`

for (const restart of [false, true]) test(`실제 App 승인 팝업은 생성된 같은 대화를 재확인하고 ${restart ? '서버 재시작 후 영속 연결 조회로' : '완료 조회로'} 닫힌다`, {
  skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 180_000,
}, async (t) => {
  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const root = path.resolve(process.env.MNP_STORAGE_TEST_SOURCE_ROOT ?? path.resolve(import.meta.dirname, '..'))
  const {api, workspace, revision} = await approvalIntegrationFixture(t)
  const login = await fetch(api.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'editor@mind.local',password:'ApprovalTestOnly!2026',rememberMe:true})})
  assert.equal(login.status,200)
  await login.text()
  const editorCookie=login.headers.get('set-cookie').split(';')[0]
  const launched = await api.call('/api/integrations/aionui/attributions', 'POST', {purpose:'dooray-response',mapId:api.ids[0],cardId:'card-1',agentId:'fixture-agent',modelId:'fixture-model',doorayApproval:{responseId:'dooray-launch-fixture',proposalRevision:revision},workspace,workspaceConfirmed:true})
  assert.equal(launched.status,201)
  const before = await api.read('_dooray-responses/user-editor.json')
  const barrier = await api.barrier('_dooray-responses/user-editor.json.', 'writeFile', {prefix:true,fail:true})
  const callback = api.call(new URL(launched.body.completionUrl).pathname,'POST',{conversationId:'approved-launch'})
  await barrier.reached; barrier.release()
  assert.equal((await callback).status,503)
  assert.deepEqual(await api.read('_dooray-responses/user-editor.json'),before)
  const failed = (await api.call(launched.body.statusUrl)).body
  assert.equal(failed.status,'confirmation-failed'); assert.equal(failed.createdConversationId,'approved-launch')
  const workspaceContext={mapId:api.ids[0],machineId:'isolated-storage',machineRole:'main',documentSetting:{version:0,workspace:''},groupSetting:null,source:'document',workspace,error:'',choices:[],token:'fixture-token',needsSelection:false}
  const options={connected:true,machineId:'isolated-storage',machineLabel:'격리 머신',machineRole:'main',machines:[{machineId:'isolated-storage',label:'격리 머신',role:'main'}],protocol:'fixture:',defaultWorkspace:workspace,workspaceContext,workspaceBrowseAvailable:false,skills:[],mcpServers:[],agents:[{id:'fixture-agent',name:'검증 AI',models:[{id:'fixture-model',label:'검증 모델'}],defaultModelId:'fixture-model',modes:[],thoughtLevels:[]}]}
  const ancillary = pathname => pathname==='/api/integrations/aionui/options' ? options
    : pathname==='/api/integrations/aionui/workspace-context' ? workspaceContext
    : pathname==='/api/integrations/dooray/mentions' ? {scan:{status:'idle'},lastScan:null,kinds:[],maxRangeDays:90,preferences:null,items:[]}
    : pathname==='/api/integrations/dooray/mentions/projects' ? {projects:[],selectedProjectIds:[],maxSelectedProjects:20} : null
  const artifacts=path.resolve(process.env.MNP_APPROVAL_BROWSER_ARTIFACTS??'.tmp/approval-integration-browser',restart?'restart':'retry')
  await mkdir(artifacts,{recursive:true})
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
    const fixtureResponse=ancillary(pathname)
    if(fixtureResponse){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixtureResponse));return}
    if(pathname.startsWith('/api/')) {
      const upstream=proxyRequest(api.base+req.url,{method:req.method,headers:{...req.headers,Cookie:editorCookie,host:new URL(api.base).host}},response=>{
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
    console.log('[승인 연결 검증] 격리 페이지 준비')
    const base = `http://127.0.0.1:${server.address().port}`
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let port
    await until(async () => { port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return Boolean(port) }, '브라우저 시작 실패')
    console.log('[승인 연결 검증] Chrome 시작 확인')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json()
    const target = targets.find(item => item.type === 'page' && item.url === 'about:blank')
    assert.ok(target, '격리 Chrome의 초기 탭이 있어야 한다.')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    console.log('[승인 연결 검증] Chrome 제어 연결')
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
    const screenshot=async name=>writeFile(path.join(artifacts,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
    const scope=JSON.stringify(['user-editor',api.ids[0],'card-1','dooray-response','dooray-launch-fixture',revision,null,null,null])
    const pendingValue={statusUrl:launched.body.statusUrl,useWeb:true,requestedAt:Date.now()}
    await send('Page.navigate',{url:base+'/mindmap/map-bench-0/card-1'})
    await until(()=>evaluate('!!document.querySelector(".description-field textarea")'),'실제 App 준비')
    await evaluate('sessionStorage.setItem('+JSON.stringify('mindnprogress-ai-launch:'+scope)+','+JSON.stringify(JSON.stringify(pendingValue))+')')
    await evaluate(`document.querySelector('[aria-label="Dooray 참조"]').click()`)
    await until(()=>evaluate('document.querySelector(".dooray-response-toolbar button")?.textContent.includes("1건")'),'합성 승인 기록 조회')
    await evaluate('document.querySelector(".dooray-response-toolbar button").click()')
    await until(()=>evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="승인한 제안으로 AI 대화 시작")'),'승인 시작 버튼')
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="승인한 제안으로 AI 대화 시작").click()')
    await until(()=>evaluate('document.querySelector(".ai-launch-confirmation strong")?.textContent==="대화 연결 확인 중…"'),'생성 성공·연결 실패 구분')
    await screenshot('confirmation-failed')
    assert.equal(await evaluate('document.querySelector(".ai-dialog footer .primary").disabled'),true)
    if(restart)await evaluate('window.holdStatus=true')
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="기존 대화 연결 다시 확인").click()')
    await until(()=>evaluate('window.audit.some(r=>r.url.endsWith("/confirm")&&r.status===200)'),'같은 생성 대화 재확인 완료')
    if(restart){
      assert.ok(await evaluate('!!document.querySelector(".ai-dialog")'))
      await api.restart()
      await evaluate('window.holdStatus=false;[...document.querySelectorAll("button")].find(b=>b.textContent==="상태 다시 확인").click()')
    }
    await until(()=>evaluate('!document.querySelector(".ai-dialog")'),'완료 후 팝업 닫힘')
    assert.equal(await evaluate('Object.keys(sessionStorage).some(k=>k.startsWith("mindnprogress-ai-launch:"))'),false)
    const calls=await evaluate('window.audit')
    assert.equal(calls.filter(r=>r.url.endsWith('/external-conversation-launches')).length,0,'재확인 중 새 대화 발급 없음')
    assert.equal(calls.filter(r=>r.url.endsWith('/attributions')).length,0,'기존 시작 귀속 유지')
    if(restart)assert.ok(calls.some(r=>r.url.includes('/confirmation?')&&r.status===200))
    const map=await api.read('map-bench-0.json'),approval=await api.read('_dooray-responses/user-editor.json')
    assert.equal(map.nodes[1].data.aiConversations.length,1)
    assert.equal(map.nodes[1].data.aiConversationId,'approved-launch')
    assert.equal(approval.jobs[0].approval.conversation.conversationId,'approved-launch')
    const preserved=structuredClone(approval.jobs[0].approval); delete preserved.conversation
    assert.deepEqual(preserved,before.jobs[0].approval)
    assert.equal((await api.call('/api/integrations/dooray/response-approvals/dooray-launch-fixture?execution=1&revision='+revision+'&conversationId=other-conversation')).status,409)
    await screenshot('completed')
    await writeFile(path.join(artifacts,'authority.json'),JSON.stringify({restart,failed,map,approval,calls},null,2))
    assert.deepEqual(errors,[],'처리되지 않은 브라우저 예외 없음')
  } finally {
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
