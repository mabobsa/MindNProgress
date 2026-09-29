import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 실제 MnP·AionUi·사용자 프로필에 접근하지 않고 실제 팝업 컴포넌트만 실행한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '/src/index.css';
import { AiConversationDialog } from '/src/components/AiConversationDialog.tsx';
import { WorkspaceSettingsDialog } from '/src/components/WorkspaceSettingsDialog.tsx';
import '/src/dark.css';
const root = createRoot(document.getElementById('root'));
const originalFetch = window.fetch.bind(window);
const workspaceContext = {mapId:'map-coordinator',groupId:'group-manager',groupName:'테스트 그룹',machineId:'fixture',machineRole:'main',documentSetting:{version:0,workspace:''},groupSetting:{version:1,workspace:'/fixture/project'},source:'group',workspace:'/fixture/project',error:'',choices:[],token:'initial',needsSelection:false};
const options = {connected:true,machineId:'fixture',machineLabel:'테스트',machineRole:'main',machines:[{machineId:'fixture',label:'테스트',role:'main'}],protocol:'fixture:',defaultWorkspace:workspaceContext.workspace,workspaceContext,workspaceBrowseAvailable:false,skills:[{id:'skill-test',name:'테스트 스킬',description:'테스트용 지침'}],mcpServers:[{id:'mcp-required',name:'필수 도구',required:true,toolCount:1},{id:'mcp-optional',name:'선택 도구',required:false,toolCount:1}],agents:[{id:'test',name:'테스트 AI',models:[{id:'test',label:'테스트'}],defaultModelId:'test',modes:[],thoughtLevels:[]}]};
window.audit = { calls:[], fail:false, hold:false, closed:0, context:null };
window.sectionPreferences = {};
window.sectionFlags = {};
window.workspaceHistories = {};
window.historyFlags = {};
window.open = () => {window.audit.opened++;return {document:{body:{style:{}}},location:{href:''},closed:false,focus(){},close(){this.closed=true}}};
window.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url, init);
  const a = window.audit;
  a.calls.push({url,method:init.method || 'GET',body:init.body ? JSON.parse(init.body) : null});
  let body = {};
  if (url.startsWith('/api/maps/')) {
    if (a.hold) await new Promise((resolve,reject) => {a.release=resolve; init.signal?.addEventListener('abort',()=>reject(init.signal.reason),{once:true})});
    if (a.fail) return new Response(JSON.stringify({error:'그룹 역할 조회 실패'}),{status:503});
    body = a.context;
  } else if (url.startsWith('/api/integrations/aionui/options')) {
    const machineId=new URL(url,location.origin).searchParams.get('machineId') || a.optionOverrides?.machineId || 'fixture';
    const ctx=a.machineContexts?.[machineId] || a.workspaceContext || workspaceContext;
    body = {...options,...a.optionOverrides,...(a.machineContexts?{machineId,machineRole:ctx.machineRole,machineLabel:machineId,machines:ctx.machines}:{}),...(a.machineMcpServers?{mcpServers:a.machineMcpServers[machineId]||[]}:{}),workspaceContext:ctx};
    if(a.optionsFail) return new Response(JSON.stringify({...body,mcpServers:[],error:'테스트 머신 연결 실패'}),{status:503});
  }
  else if (url.startsWith('/api/integrations/aionui/workspace-context')) body = a.machineContexts?.[new URL(url,location.origin).searchParams.get('machineId')] || a.workspaceContext || workspaceContext;
  else if (url === '/api/integrations/aionui/workspace-settings') {
    if (a.workspaceSaveFail) return new Response(JSON.stringify({error:'작업공간 저장 실패'}),{status:503});
    const input=JSON.parse(init.body), ctx=a.workspaceContext || workspaceContext;
    const setting={version:(input.scope==='group'?ctx.groupSetting:ctx.documentSetting).version+1,workspace:input.workspace};
    a.workspaceContext={...ctx,[input.scope==='group'?'groupSetting':'documentSetting']:setting,workspace:input.workspace,source:input.scope,error:'',needsSelection:false,token:ctx.token+'-saved'};
    body={setting};
  }
  else if (url.startsWith('/api/integrations/aionui/workspaces?')) {
    const userId=a.userId||'fixture';
    const machineId=new URL(url,location.origin).searchParams.get('machineId');
    const key=JSON.stringify([userId,machineId]);
    const exists=Object.hasOwn(window.workspaceHistories,key)||(machineId==='fixture'&&Object.hasOwn(window.workspaceHistories,userId));
    let history=window.workspaceHistories[key]||(machineId==='fixture'?window.workspaceHistories[userId]:null)||[];
    if (init.method==='DELETE') {
      if(window.historyFlags.fail) return new Response(JSON.stringify({error:'테스트 이력 삭제 실패'}),{status:503});
      history=history.filter(item=>item!==JSON.parse(init.body).workspace);
      window.workspaceHistories[key]=history;
    } else if(init.method==='POST') {
      const input=JSON.parse(init.body);
      if(input.workspace) history=[input.workspace,...history.filter(item=>item!==input.workspace)];
      else if(input.migration&&!exists) history=input.workspaces;
      window.workspaceHistories[key]=history;
    }
    body={userId,machineId,workspaces:history};
    if(!init.method || init.method==='GET') {
      if(window.historyFlags.holdMachine===machineId) await new Promise(resolve=>window.historyFlags.release=resolve);
      if(window.historyFlags.wrongMachine===machineId) body.machineId='wrong-machine';
    }
  }
  else if (url === '/api/integrations/aionui/dialog-preferences') {
    const userId=a.userId||'fixture';
    const saved={workspace:true,mcp:true,skills:true,...window.sectionPreferences[userId]};
    if (init.method==='PATCH') {
      if(window.sectionFlags.delay) await new Promise(resolve=>setTimeout(resolve,window.sectionFlags.delay));
      if(window.sectionFlags.fail) return new Response(JSON.stringify({error:'테스트 저장 실패'}),{status:503});
      const input=JSON.parse(init.body);
      if(input.expectedUserId!==userId) return new Response(JSON.stringify({error:'계정 변경'}),{status:409});
      window.sectionPreferences[userId]={...saved,...input.sections};
    } else if(window.sectionFlags.hold) await new Promise(resolve=>window.sectionFlags.release=resolve);
    body={userId,sections:init.method==='PATCH'?window.sectionPreferences[userId]:saved};
  }
  else if (url === '/api/integrations/aionui/attributions') body = {editorId:'fixture',attributionToken:'fixture',completionUrl:'http://fixture.invalid/completion',statusUrl:'/api/integrations/aionui/launches/'+ 'A'.repeat(43) +'/status'};
  else if (url.endsWith('/status')) body = {status:'completed',conversationId:'fixture-conversation'};
  else if (url === '/api/integrations/aionui/external-conversation-launches') body = {launchUrl:'about:blank'};
  else throw new Error('예상하지 않은 테스트 요청: '+url);
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
};
let sequence = 0;
window.renderDialog = (input = {}, flags = {}) => {
  window.audit.machineContexts=null;
  Object.assign(window.audit,{calls:[],fail:false,hold:false,closed:0,opened:0,workspaceSaveFail:false,optionOverrides:null,machineMcpServers:null,optionsFail:false,context:{map:{id:'map-coordinator',nodes:[{id:'root',data:{kind:'root'}},{id:'child',data:{kind:'task'}}],edges:[{source:'root',target:'child'}]},groupProject:{groupId:'group-manager',role:'coordinator',coordinatorMapId:'map-coordinator'}},...flags});
  window.audit.userId=input.userId||'fixture';
  // 준비 상태 검사에서 이전 팝업의 DOM을 새 팝업으로 오인하지 않도록 먼저 교체한다.
  flushSync(()=>root.render(React.createElement(AiConversationDialog,{key:++sequence,userId:'fixture',documentId:'map-coordinator',documentTitle:'총괄 문서',cardId:'root',cardTitle:'총괄 루트',purpose:'card',knowledgeSources:[],launchInWebUi:true,onClose:()=>window.audit.closed++,...input})));
};
window.renderEditor = (editScope='document') => {
  root.render(React.createElement(WorkspaceSettingsDialog,{key:++sequence,userId:window.audit.userId||'fixture',mapId:editScope==='document'?'map-coordinator':'',groupId:editScope==='group'?'group-manager':'',name:'이름 편집',editScope,onRename:async(name)=>{window.audit.renamed=name},onClose:()=>window.audit.closed++}));
};
function WorkspaceModifierFocusHarness() {
  const [modifierDown,setModifierDown]=React.useState(false);
  React.useEffect(()=>{
    const update=(event)=>setModifierDown(event.ctrlKey||event.metaKey);
    window.addEventListener('keydown',update);window.addEventListener('keyup',update);
    return()=>{window.removeEventListener('keydown',update);window.removeEventListener('keyup',update)};
  },[]);
  return React.createElement('div',{'data-modifier-down':modifierDown},React.createElement(WorkspaceSettingsDialog,{userId:'focus-account',mapId:'map-coordinator',machineId:'fixture',name:'포커스 검증',initialWorkspace:'',onClose:()=>window.audit.closed++}));
}
window.renderWorkspaceModifierFocusHarness=()=>root.render(React.createElement(WorkspaceModifierFocusHarness));
window.fixtureReady = true;
`

test('작업공간 확인·문서/그룹 저장·공통 메뉴·이름 편집·계정별 접힘 상태를 검증한다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 60_000 }, async (t) => {
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
    const assertWorkspaceHintTypography = async () => {
      for (const theme of ['light', 'dark']) {
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
        const styles = await evaluate('[document.querySelector(".ai-request > small"),...document.querySelectorAll(".ai-workspace-field > small")].map(el=>{const s=getComputedStyle(el);return {size:s.fontSize,weight:s.fontWeight,line:s.lineHeight}})')
        assert.ok(styles.length >= 2)
        for (const style of styles) assert.deepEqual(style, { size: '8px', weight: '500', line: '11.6px' }, `${theme}: 작업공간 안내는 다른 보조 설명과 같은 글꼴 규격`)
        if (theme === 'dark') assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-dialog summary")].map(el=>getComputedStyle(el).color)'),['rgb(212, 207, 218)','rgb(212, 207, 218)','rgb(212, 207, 218)'],'접힘 제목도 다크모드에서 읽기 쉽게 표시')
      }
      await evaluate('document.documentElement.dataset.theme="light"')
    }

    const configured={mapId:'map-coordinator',groupId:'group-manager',groupName:'테스트 그룹',machineId:'fixture',machineRole:'main',documentSetting:{version:1,workspace:'/document'},groupSetting:{version:1,workspace:'/group'},source:'document',workspace:'/document',error:'',choices:[],token:'configured',needsSelection:false};
    const mixed={...configured,documentSetting:{version:0,workspace:''},groupSetting:{version:0,workspace:''},source:'none',workspace:'',needsSelection:true,token:'mixed',choices:[{workspace:'/project',reasons:['문서 루트 대화']},{workspace:'/mnp',reasons:['과거 대화']}]};
    await t.test('작업공간 경로 입력 중 Ctrl 상태의 부모 재렌더링에도 포커스와 입력 대상을 유지한다', async () => {
      await evaluate('window.audit.workspaceContext='+JSON.stringify(mixed)+';window.renderWorkspaceModifierFocusHarness()');
      await waitFor(()=>evaluate('Boolean(document.querySelector(".workspace-settings-path input"))'));
      await evaluate('document.querySelector(".workspace-settings-path input").focus()');
      assert.equal(await evaluate('document.activeElement===document.querySelector(".workspace-settings-path input")'),true);
      await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,nativeVirtualKeyCode:17,modifiers:2});
      await waitFor(()=>evaluate('Boolean(document.querySelector("[data-modifier-down=true]"))'));
      assert.equal(await evaluate('document.activeElement===document.querySelector(".workspace-settings-path input")'),true,'Ctrl 재렌더링 뒤에도 경로 입력 포커스 유지');
      await send('Input.insertText',{text:'C:\\Git\\붙여넣기-검증'});
      assert.equal(await evaluate('document.querySelector(".workspace-settings-path input").value'),'C:\\Git\\붙여넣기-검증');
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,nativeVirtualKeyCode:17});
      assert.equal(await evaluate('document.activeElement===document.querySelector(".workspace-settings-path input")'),true,'Ctrl 해제 뒤에도 경로 입력 포커스 유지');
    });
    await t.test('MCP 마지막 선택은 팝업 재진입·머신 전환·빈 목록·연결 실패에도 유지한다', async () => {
      const machines=[{machineId:'fixture',label:'메인',role:'main'},{machineId:'remote',label:'서브',role:'sub'},{machineId:'empty',label:'도구 없음',role:'sub'}];
      const machineContexts=Object.fromEntries(machines.map(machine=>[machine.machineId,{...configured,machineId:machine.machineId,machineRole:machine.role,machines}]));
      const machineMcpServers={
        fixture:[{id:'required',name:'필수 MCP',required:true},{id:'main-option',name:'메인 선택 MCP',required:false},{id:'shared-option',name:'공통 선택 MCP',required:false}],
        remote:[{id:'required',name:'필수 MCP',required:true},{id:'remote-option',name:'서브 선택 MCP',required:false},{id:'shared-option',name:'공통 선택 MCP',required:false}],
        empty:[],
      };
      const flags={machineContexts,machineMcpServers,workspaceContext:machineContexts.fixture};
      const stored=()=>evaluate('JSON.parse(localStorage.getItem("mindnprogress-ai-mcp-selections")||"[]").sort()');
      const checked=()=>evaluate('[...document.querySelectorAll(".ai-mcp-section input")].map(el=>({checked:el.checked,disabled:el.disabled}))');
      const toggle=async(index)=>{await evaluate(`document.querySelectorAll('.ai-mcp-section input')[${index}].click()`);await delay(50);};
      const switchMachine=async(machineId)=>{
        await evaluate(`(()=>{const select=document.querySelector('.ai-machine-select select');select.value=${JSON.stringify(machineId)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await waitFor(()=>evaluate(`document.querySelector('.ai-machine-select select')?.value===${JSON.stringify(machineId)}&&!document.querySelector('.ai-dialog footer .primary')?.disabled`));
      };
      await evaluate('localStorage.setItem("mindnprogress-ai-mcp-selections",JSON.stringify(["main-option"]))');
      await open({userId:'mcp-history'},flags);
      assert.deepEqual(await checked(),[{checked:true,disabled:true},{checked:true,disabled:false},{checked:false,disabled:false}]);
      await toggle(2);
      assert.deepEqual(await stored(),['main-option','shared-option']);
      await open({userId:'mcp-history'},flags);
      assert.equal((await checked())[2].checked,true,'닫고 다시 열어도 마지막 선택 복원');

      await switchMachine('remote');
      assert.deepEqual(await stored(),['main-option','shared-option'],'서브에 없는 메인 MCP 선택을 삭제하지 않는다');
      assert.deepEqual(await checked(),[{checked:true,disabled:true},{checked:false,disabled:false},{checked:true,disabled:false}]);
      await toggle(1);
      assert.deepEqual(await stored(),['main-option','remote-option','shared-option']);
      await toggle(2);
      assert.deepEqual(await stored(),['main-option','remote-option'],'사용자가 공통 MCP를 해제한 결과만 저장');
      await switchMachine('empty');
      assert.deepEqual(await stored(),['main-option','remote-option'],'빈 도구 목록은 사용자의 전체 해제가 아니다');
      await switchMachine('fixture');
      assert.deepEqual(await checked(),[{checked:true,disabled:true},{checked:true,disabled:false},{checked:false,disabled:false}]);

      await evaluate('window.renderDialog({userId:"mcp-history"},'+JSON.stringify({...flags,optionsFail:true})+')');
      await waitFor(()=>evaluate('document.querySelector(".ai-dialog-message.error")?.textContent.includes("테스트 머신 연결 실패")'));
      assert.deepEqual(await stored(),['main-option','remote-option'],'연결 실패 응답으로 선택 이력을 초기화하지 않는다');
      await open({userId:'mcp-history'},flags);
      await switchMachine('remote');
      assert.equal((await checked())[1].checked,true,'실패 후 다시 열어도 서브 선택 복원');
      await toggle(1);
      await switchMachine('fixture');
      await toggle(1);
      assert.deepEqual(await stored(),[],'사용자가 모든 선택을 해제한 빈 값은 기억한다');
      await open({userId:'mcp-history'},flags);
      assert.deepEqual(await checked(),[{checked:true,disabled:true},{checked:false,disabled:false},{checked:false,disabled:false}]);

      await toggle(1);
      await send('Page.reload');
      await waitFor(()=>evaluate('window.fixtureReady'));
      await open({userId:'mcp-history'},flags);
      assert.equal((await checked())[1].checked,true,'브라우저 새로고침 후에도 선택 복원');
      await evaluate('localStorage.removeItem("mindnprogress-ai-mcp-selections")');
    });
    await t.test('대화 팝업은 내용에 맞춰 줄고 화면이 작을 때만 본문을 스크롤한다', async () => {
      const layout = () => evaluate(`(() => {
        const dialog=document.querySelector('.ai-dialog'), content=dialog.querySelector('.ai-dialog-content');
        const box=dialog.getBoundingClientRect(), footer=dialog.querySelector('footer').getBoundingClientRect();
        const inset=parseFloat(getComputedStyle(dialog.parentElement).paddingTop);
        const contentBox=content?.getBoundingClientRect(), last=content?.lastElementChild.getBoundingClientRect();
        return {height:box.height, top:box.top, bottom:box.bottom, viewport:innerHeight, inset,
          footerVisible:footer.top>=box.top&&footer.bottom<=innerHeight-inset+1,
          scrollable:content?content.scrollHeight>content.clientHeight+1:false,
          bottomGap:contentBox?contentBox.bottom-last.bottom-parseFloat(getComputedStyle(content).paddingBottom):0};
      })()`);
      const fit = (result) => {
        assert.ok(result.top>=result.inset-1&&result.bottom<=result.viewport-result.inset+1,JSON.stringify(result));
        assert.equal(result.footerVisible,true,'하단 버튼은 팝업 안에 유지');
      };
      const sections = async (expanded) => {
        await evaluate(`document.querySelectorAll('.ai-dialog details').forEach(el=>{if(el.open!==${expanded})el.querySelector('summary').click()})`);
        await waitFor(()=>evaluate(`[...document.querySelectorAll('.ai-dialog details')].every(el=>el.open===${expanded})`));
      };
      const screenshots=process.env.MNP_TEST_SCREENSHOTS==='1'?await mkdtemp(path.join(tmpdir(),'mnp-dialog-height-screenshots-')):null;
      for(const theme of ['light','dark']) {
        await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1600,deviceScaleFactor:1,mobile:false});
        await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));
        await open({userId:'height-'+theme},{workspaceContext:configured});
        await sections(false);
        const collapsed=await layout();
        fit(collapsed);
        assert.ok(collapsed.height<collapsed.viewport-2*collapsed.inset-100,'내용이 적으면 화면 전체 높이를 채우지 않는다');
        assert.equal(collapsed.scrollable,false,'내용이 맞으면 본문 스크롤이 없다');
        assert.ok(Math.abs(collapsed.bottomGap)<=1,'마지막 항목 아래 불필요한 빈 공간이 없다');
        if(screenshots) {
          const shot=await send('Page.captureScreenshot',{format:'png'});
          await writeFile(path.join(screenshots,theme+'-collapsed.png'),Buffer.from(shot.data,'base64'));
        }
        await send('Emulation.setDeviceMetricsOverride',{width:1440,height:2000,deviceScaleFactor:1,mobile:false});
        assert.ok(Math.abs((await layout()).height-collapsed.height)<=1,'브라우저가 더 커져도 내용 높이는 유지');
        await sections(true);
        const expanded=await layout();
        fit(expanded);
        assert.ok(expanded.height>collapsed.height+50,'옵션을 펼치면 내용만큼 높이가 늘어난다');
        assert.ok(Math.abs(expanded.bottomGap)<=1);
        await sections(false);
        assert.ok(Math.abs((await layout()).height-collapsed.height)<=1,'다시 접으면 원래 높이로 돌아온다');
        await sections(true);
        for(const viewport of [{width:1440,height:600,mobile:false},{width:390,height:640,mobile:true}]) {
          await send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1});
          const constrained=await layout();
          fit(constrained);
          assert.equal(constrained.scrollable,true,'화면보다 내용이 많으면 본문만 스크롤');
        }
      }
      if(screenshots)t.diagnostic('내용 기준 높이 화면 캡처: '+screenshots);
      await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      await evaluate('document.documentElement.dataset.theme="light"');
    });
    for (const purpose of ['card','group-coordination','shared-knowledge-review','document-reconstruction','card-layout']) {
      await open({purpose,initialRequest:'검토 요청'}, {workspaceContext:mixed});
      await assertWorkspaceHintTypography();
      await evaluate('document.querySelector(".ai-dialog footer .primary").click()');
      await waitFor(()=>evaluate('Boolean(document.querySelector(".workspace-settings-dialog"))'));
      await waitFor(()=>evaluate('document.querySelectorAll(".workspace-settings-choices button").length===2'));
      assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/attributions"))'),false);
      assert.equal(await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").disabled'),true);
      await evaluate('document.querySelector(".workspace-settings-dialog header button").click()');
      await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog")'));
      assert.equal(await evaluate('window.audit.closed'),0);
      await evaluate('document.querySelector(".ai-workspace-field > button").click()');
      await waitFor(()=>evaluate('document.querySelectorAll(".workspace-settings-choices button").length===2'));
      assert.equal(await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").textContent'),'선택');
      await evaluate('document.querySelector(".workspace-settings-choices button").click()');
      await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog footer .primary").disabled'));
      await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").click()');
      await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog")'));
      assert.equal(await evaluate('document.querySelector(".ai-workspace-input-row input").value'),'/project');
      assert.equal(await evaluate('window.audit.closed'),0,'선택은 대화 시작 창을 닫지 않는다');
      assert.equal(await evaluate('window.audit.opened'),0,'선택만으로 AionUi 탭을 열지 않는다');
      assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/attributions")||c.url.endsWith("/external-conversation-launches"))'),false);
    }
    await open({}, {workspaceContext:{...configured,source:'group',groupName:'JP-매니저'}});
    assert.equal(await evaluate('document.querySelector(".ai-workspace-field > small").textContent'),'JP-매니저 그룹 작업공간 기준');
    await assertWorkspaceHintTypography();
    await evaluate('(()=>{const el=document.querySelector(".ai-workspace-input-row input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"/once");el.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await waitFor(()=>evaluate('document.querySelector(".ai-workspace-field > small").textContent.startsWith("이번 대화에서 선택한 경로")'));
    await assertWorkspaceHintTypography();
    await open({}, {workspaceContext:configured});
    await assertWorkspaceHintTypography();
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
      assert.deepEqual(sizes,{title:'16px',body:'10px',button:'10px'});
      assert.equal(await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").textContent'),'선택');
      await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").click()');
      await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog")'));
      assert.equal(await evaluate('window.audit.closed'),0);
      assert.equal(await evaluate('window.audit.opened'),0);
      assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/attributions")||c.url.endsWith("/external-conversation-launches"))'),false);
      assert.equal(await evaluate('document.querySelector(".ai-workspace-input-row input").value'),'/project');
      assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/workspace-settings"))'),scope!=='once');
      if(scope!=='once') assert.match(await evaluate('document.querySelector(".ai-workspace-field > small").textContent'),/기준에 저장한 경로/);
      // 선택 후에도 요청·MCP·스킬을 바꿀 수 있고 실제 시작은 별도 버튼으로만 수행한다.
      await evaluate('(()=>{const el=document.querySelector(".ai-user-request textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"선택 후 추가한 요청");el.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".ai-skills-section input").click();const mcp=document.querySelector(".ai-mcp-section input:not(:disabled)");if(!mcp.checked)mcp.click()})()');
      await evaluate('document.querySelector(".ai-dialog footer .primary").click()');
      await waitFor(()=>evaluate('window.audit.closed===1'));
      const posts=await evaluate('window.audit.calls.filter(c=>c.method==="POST")');
      assert.equal(posts.some(c=>c.url.endsWith('/workspace-settings')),scope!=='once');
      assert.equal(posts.find(c=>c.url.endsWith('/attributions')).body.workspace,'/project');
      assert.equal(posts.find(c=>c.url.endsWith('/attributions')).body.requestPreview,'선택 후 추가한 요청');
      assert.deepEqual(posts.find(c=>c.url.endsWith('/external-conversation-launches')).body.enabledSkillIds,['skill-test']);
      assert.ok(posts.find(c=>c.url.endsWith('/external-conversation-launches')).body.mcpIds.includes('mcp-optional'));
    }

    await open({}, {workspaceContext:mixed,workspaceSaveFail:true});
    await evaluate('document.querySelector(".ai-workspace-field > button").click()');
    await waitFor(()=>evaluate('document.querySelectorAll(".workspace-settings-choices button").length===2'));
    await evaluate('document.querySelector(".workspace-settings-choices button").click();document.querySelectorAll(".workspace-settings-dialog input[type=radio]")[1].click()');
    await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").click()');
    await waitFor(()=>evaluate('document.querySelector(".workspace-settings-error")?.textContent.includes("작업공간 저장 실패")'));
    assert.equal(await evaluate('window.audit.closed'),0);
    assert.equal(await evaluate('window.audit.opened'),0);
    await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog footer .primary").disabled'));
    await evaluate('window.audit.workspaceSaveFail=false;document.querySelector(".workspace-settings-dialog footer .primary").click()');
    await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog")'));
    await evaluate('window.audit.workspaceContext.token="changed-after-selection";document.querySelector(".ai-dialog footer .primary").click()');
    await waitFor(()=>evaluate('document.querySelector(".ai-launch-error")?.textContent.includes("작업공간 기준이 변경")'));
    assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/attributions"))'),false,'선택 후 기준이 바뀌면 실제 시작에서 차단');

    const sectionStates = () => evaluate('Object.fromEntries(["workspace","mcp","skills"].map(key=>[key,document.querySelector(".ai-"+key+"-section").open]))');
    const toggleSection = key => evaluate('document.querySelector(".ai-'+key+'-section > summary").click()');
    await open({}, {workspaceContext:configured});
    assert.deepEqual(await sectionStates(),{workspace:true,mcp:true,skills:true},'저장값이 없으면 세 영역 모두 펼침');
    assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/dialog-preferences")&&c.method==="PATCH")'),false,'초기 렌더는 저장하지 않는다');
    await evaluate('document.querySelector(".ai-skills-section input").click()');
    const selectedBefore=await evaluate('[...document.querySelectorAll(".ai-capability-list input")].map(el=>el.checked)');
    for(const key of ['workspace','mcp','skills']) await toggleSection(key);
    await waitFor(()=>evaluate('Object.values(window.sectionPreferences.fixture||{}).filter(v=>v===false).length===3'));
    assert.deepEqual(await sectionStates(),{workspace:false,mcp:false,skills:false});
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-capability-list input")].map(el=>el.checked)'),selectedBefore,'접어도 MCP·스킬 선택값 유지');
    assert.equal(await evaluate('document.querySelector(".ai-workspace-input-row input").checkVisibility()'),false,'작업공간 내용이 실제로 접힌다');
    assert.equal(await evaluate('document.querySelector(".ai-workspace-section .ai-section-selection").textContent'),'/document');
    assert.equal(await evaluate('document.querySelector(".ai-skills-section .ai-section-selection").textContent'),'테스트 스킬');
    assert.equal(await evaluate('document.querySelector(".ai-mcp-section .ai-section-selection").textContent'),await evaluate('[...document.querySelectorAll(".ai-mcp-section label")].filter(el=>el.querySelector("input").checked).map(el=>el.querySelector("strong").textContent.replace(" · 필수","")).join(", ")'));
    await open({purpose:'shared-knowledge-review',initialRequest:'검토 요청'}, {workspaceContext:configured});
    await waitFor(async()=>!(await sectionStates()).skills);
    assert.deepEqual(await sectionStates(),{workspace:false,mcp:false,skills:false},'다른 진입 메뉴에서도 계정 설정 복원');
    await open({userId:'second-account'}, {workspaceContext:configured});
    await waitFor(()=>evaluate('window.audit.calls.some(c=>c.url.endsWith("/dialog-preferences"))'));
    assert.deepEqual(await sectionStates(),{workspace:true,mcp:true,skills:true},'다른 계정에는 적용하지 않는다');
    await open({}, {workspaceContext:configured});
    await waitFor(async()=>!(await sectionStates()).workspace);
    await evaluate('window.sectionFlags.fail=true');
    await toggleSection('workspace');
    await waitFor(()=>evaluate('document.querySelector(".ai-section-preferences-error")?.textContent.includes("저장하지 못했습니다")'));
    assert.equal((await sectionStates()).workspace,true,'저장 실패도 현재 조작은 유지');
    assert.equal(await evaluate('window.sectionPreferences.fixture.workspace'),false);
    await evaluate('window.sectionFlags.fail=false;document.querySelector(".ai-section-preferences-error button").click()');
    await waitFor(()=>evaluate('!document.querySelector(".ai-section-preferences-error")&&window.sectionPreferences.fixture.workspace===true'));
    // 빠르게 접기→펼치기→접기 후 창을 다시 열어도 마지막 저장 이후 값을 읽는다.
    await evaluate('window.sectionFlags.delay=40');
    await toggleSection('workspace');await toggleSection('workspace');await toggleSection('workspace');
    await open({}, {workspaceContext:configured});
    await waitFor(async()=>!(await sectionStates()).workspace);
    assert.equal(await evaluate('window.sectionPreferences.fixture.workspace'),false);
    await evaluate('window.sectionFlags.delay=0;window.sectionFlags.hold=true');
    await open({}, {workspaceContext:configured});
    await waitFor(()=>evaluate('Boolean(window.sectionFlags.release)'));
    await toggleSection('workspace');
    await evaluate('window.sectionFlags.hold=false;window.sectionFlags.release()');
    await waitFor(async()=>!(await sectionStates()).mcp);
    assert.equal((await sectionStates()).workspace,false,'늦은 조회는 사용자가 이미 바꾼 상태를 되돌리지 않는다');
    await evaluate('document.querySelector(".ai-workspace-section summary").focus()');
    assert.equal(await evaluate('document.activeElement===document.querySelector(".ai-workspace-section summary")'),true);
    for(const type of ['keyDown','keyUp']) await send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\r',unmodifiedText:'\r'}:{})});
    await waitFor(async()=>(await sectionStates()).workspace);
    assert.equal(await evaluate('document.querySelector(".ai-workspace-input-row input").checkVisibility()'),true,'키보드로도 펼치기 가능');
    if (process.env.MNP_TEST_SCREENSHOTS === '1') {
      const artifacts=await mkdtemp(path.join(tmpdir(),'mnp-dialog-sections-screenshots-'));
      for(const theme of ['light','dark']) {
        await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme)+';document.documentElement.style.colorScheme='+JSON.stringify(theme)+';document.querySelector(".ai-dialog-content").scrollTop=99999');
        const screenshot=await send('Page.captureScreenshot',{format:'png'});
        await writeFile(path.join(artifacts,theme+'.png'),Buffer.from(screenshot.data,'base64'));
      }
      t.diagnostic('접힘 상태 화면 캡처: '+artifacts);
    }

    // 접힌 제목의 우측 요약은 현재 선택값만 표시하고 작은 화면에서도 한 줄로 줄인다.
    const longWorkspace='/fixture/'+'workspace-directory/'.repeat(25);
    const longMcp='필수 MCP 서버 이름 '.repeat(24), longSkill='선택한 스킬 이름 '.repeat(24);
    const optionOverrides={mcpServers:[{id:'summary-required',name:longMcp,required:true,toolCount:1},{id:'summary-optional',name:'선택 MCP',required:false,toolCount:2},{id:'summary-excluded',name:'선택하지 않은 MCP',required:false,toolCount:1}],skills:[{id:'summary-skill',name:longSkill,description:''},{id:'summary-skill-two',name:'두 번째 스킬',description:''},{id:'summary-skill-excluded',name:'선택하지 않은 스킬',description:''}]};
    await open({userId:'summary-account'}, {workspaceContext:{...configured,workspace:longWorkspace},optionOverrides});
    assert.equal(await evaluate('document.querySelectorAll(".ai-section-selection").length'),0,'펼침 상태에는 요약을 중복 표시하지 않는다');
    await evaluate('document.querySelectorAll(".ai-mcp-section input")[1].click();document.querySelectorAll(".ai-skills-section input")[0].click();document.querySelectorAll(".ai-skills-section input")[1].click()');
    for(const key of ['workspace','mcp','skills']) await toggleSection(key);
    await waitFor(()=>evaluate('document.querySelectorAll(".ai-section-selection").length===3'));
    const expectedSummaries=[longWorkspace,longMcp+', 선택 MCP',longSkill+', 두 번째 스킬'];
    const screenshotDirectory=process.env.MNP_TEST_SCREENSHOTS==='1'?await mkdtemp(path.join(tmpdir(),'mnp-collapsed-selection-screenshots-')):null;
    for(const width of [1440,390]) for(const theme of ['light','dark']) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});
      await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme)+';document.documentElement.style.colorScheme='+JSON.stringify(theme)+';document.querySelector(".ai-dialog-content").scrollTop=99999');
      const summaries=await evaluate('[...document.querySelectorAll(".ai-section-selection")].map(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect(),header=el.parentElement.getBoundingClientRect(),label=el.previousElementSibling.getBoundingClientRect();return {text:el.textContent,title:el.title,overflow:s.overflow,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace,fontSize:s.fontSize,color:s.color,truncated:el.scrollWidth>el.clientWidth,within:r.left>=label.right+6&&r.right<=header.right-12,headerHeight:header.height}})');
      assert.deepEqual(summaries.map(s=>s.text),expectedSummaries);
      assert.deepEqual(summaries.map(s=>s.title),expectedSummaries,'말줄임 뒤의 전체 값은 툴팁으로 제공');
      for(const summary of summaries) {
        assert.equal(summary.overflow,'hidden');assert.equal(summary.textOverflow,'ellipsis');assert.equal(summary.whiteSpace,'nowrap');
        assert.equal(summary.fontSize,'10px');assert.equal(summary.color,theme==='dark'?'rgb(170, 164, 178)':'rgb(119, 112, 128)');
        assert.equal(summary.truncated,true,`${width}/${theme}: 긴 선택값 말줄임`);
        assert.equal(summary.within,true,`${width}/${theme}: 제목·개수를 가리지 않고 우측 영역만 사용`);
        assert.ok(summary.headerHeight<50,'요약이 제목 높이를 늘리지 않는다');
      }
      assert.equal(await evaluate('document.querySelector(".ai-dialog-content").scrollWidth<=document.querySelector(".ai-dialog-content").clientWidth'),true,'수평 스크롤을 만들지 않는다');
      if(screenshotDirectory) {
        const shot=await send('Page.captureScreenshot',{format:'png'});
        await writeFile(path.join(screenshotDirectory,theme+'-'+width+'.png'),Buffer.from(shot.data,'base64'));
      }
    }
    if(screenshotDirectory) t.diagnostic('접힌 선택값 화면 캡처: '+screenshotDirectory);
    for(const key of ['workspace','mcp','skills']) await toggleSection(key);
    await waitFor(()=>evaluate('document.querySelectorAll(".ai-section-selection").length===0'));
    await evaluate('document.querySelectorAll(".ai-mcp-section input")[1].click();document.querySelectorAll(".ai-skills-section input")[0].click();document.querySelectorAll(".ai-skills-section input")[1].click();(()=>{const el=document.querySelector(".ai-workspace-input-row input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"");el.dispatchEvent(new Event("input",{bubbles:true}))})()');
    for(const key of ['workspace','mcp','skills']) await toggleSection(key);
    await waitFor(()=>evaluate('document.querySelectorAll(".ai-section-selection").length===3'));
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-section-selection")].map(el=>el.textContent)'),['선택 없음',longMcp,'선택 없음'],'선택 변경과 해제를 바로 반영');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-dialog summary b")].map(el=>el.textContent)'),['1','0']);
    assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/attributions"))'),false,'요약 확인은 대화를 시작하지 않는다');
    await open({userId:'empty-summary-account'}, {workspaceContext:mixed,optionOverrides:{skills:[],mcpServers:[]}});
    for(const key of ['workspace','mcp','skills']) await toggleSection(key);
    await waitFor(()=>evaluate('document.querySelectorAll(".ai-section-selection").length===3'));
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-section-selection")].map(el=>el.textContent)'),['선택 없음','선택 없음','선택 없음']);
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});

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
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".workspace-settings-dialog")).backgroundColor'),'rgb(26, 29, 39)');

    // 최근 목록은 시작 창에서 제거하고 확인 창에 기존 목록 스타일로 펼쳐 표시한다.
    const recentPaths=['/recent/project','/recent/'+'아주-긴-작업공간-경로/'.repeat(30),...Array.from({length:8},(_,i)=>'/recent/project-'+i)];
    await evaluate('window.workspaceHistories["history-account"]='+JSON.stringify(recentPaths));
    await open({userId:'history-account'}, {workspaceContext:configured});
    assert.equal(await evaluate(`document.querySelector('.ai-dialog [aria-label="최근 작업공간"]')`),null);
    assert.ok(await evaluate('document.querySelector(".ai-workspace-settings-button").getBoundingClientRect().height>=34'),'확인·설정 버튼 높이를 확보');
    await evaluate('document.querySelector(".ai-workspace-settings-button").click()');
    await waitFor(()=>evaluate('document.querySelectorAll(".workspace-settings-dialog .ai-workspace-history-select").length===10'));
    assert.equal(await evaluate('document.querySelector(".workspace-settings-path input").value'),'/document','최근 목록이 기존 문서 기준을 자동 변경하지 않는다');
    assert.equal(await evaluate('document.querySelector(".ai-workspace-history-list").closest("details")'),null,'추가 펼침 동작 없이 목록 표시');
    assert.equal(await evaluate('document.querySelector(".ai-workspace-history-list").checkVisibility()'),true);
    await evaluate('document.querySelector(".ai-workspace-history-select").click()');
    await waitFor(()=>evaluate('document.querySelector(".workspace-settings-path input").value==="/recent/project"'));
    assert.equal(await evaluate('document.querySelector(".ai-workspace-history-select[aria-pressed=true]").title'),recentPaths[0]);
    assert.equal(await evaluate('window.audit.calls.some(c=>c.url.endsWith("/workspace-settings")||c.url.endsWith("/attributions"))'),false,'목록 클릭만으로 저장·대화 시작하지 않는다');
    const historyShots=process.env.MNP_TEST_SCREENSHOTS==='1'?await mkdtemp(path.join(tmpdir(),'mnp-workspace-settings-screenshots-')):null;
    for(const width of [1440,390]) for(const theme of ['light','dark']) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:width===390?620:1000,deviceScaleFactor:1,mobile:width===390});
      await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme)+';document.documentElement.style.colorScheme='+JSON.stringify(theme));
      const layout=await evaluate(`(()=>{
        const popup=document.querySelector('.workspace-settings-dialog'), content=popup.querySelector('.workspace-settings-content'), footer=popup.querySelector('footer');
        const list=popup.querySelector('.ai-workspace-history-list'), label=popup.querySelectorAll('.ai-workspace-history-select > span')[1], style=getComputedStyle(label);
        return {surface:getComputedStyle(popup).backgroundColor, aiSurface:getComputedStyle(document.querySelector('.ai-dialog')).backgroundColor, radius:getComputedStyle(popup).borderRadius,
          title:getComputedStyle(popup.querySelector('header strong')).fontSize, path:getComputedStyle(popup.querySelector('input')).fontSize,
          font:style.fontSize, ellipsis:style.textOverflow, clipped:label.scrollWidth>label.clientWidth, tooltip:label.parentElement.title,
          listScroll:list.scrollHeight>list.clientHeight, contentFits:content.scrollWidth<=content.clientWidth, popupFits:popup.getBoundingClientRect().width<=innerWidth,
          footerVisible:footer.getBoundingClientRect().bottom<=innerHeight&&footer.getBoundingClientRect().top>=popup.getBoundingClientRect().top,
          selected:getComputedStyle(popup.querySelector('.ai-workspace-history-item.selected')).backgroundColor,
          rowBorder:getComputedStyle(label.parentElement).borderTopWidth, rowBackground:getComputedStyle(label.parentElement).backgroundColor};
      })()`);
      assert.equal(layout.surface,layout.aiSurface,`${theme}: AI 시작 창과 동일한 표면 색상`);
      assert.equal(layout.radius,'18px');assert.equal(layout.title,'16px');assert.equal(layout.path,'11px');
      assert.equal(layout.font,'9px');assert.equal(layout.ellipsis,'ellipsis');assert.equal(layout.clipped,true);assert.equal(layout.tooltip,recentPaths[1]);
      assert.equal(layout.listScroll,true);assert.equal(layout.contentFits,true);assert.equal(layout.popupFits,true);assert.equal(layout.footerVisible,true);
      assert.equal(layout.selected,theme==='dark'?'rgb(54, 49, 79)':'rgb(238, 235, 251)');
      assert.equal(layout.rowBorder,'0px');assert.equal(layout.rowBackground,'rgba(0, 0, 0, 0)','확인 창의 일반 버튼 스타일이 이력 행을 덮어쓰지 않는다');
      if(historyShots) {
        const shot=await send('Page.captureScreenshot',{format:'png'});
        await writeFile(path.join(historyShots,theme+'-'+width+'.png'),Buffer.from(shot.data,'base64'));
      }
    }
    if(historyShots) t.diagnostic('작업공간 확인 화면 캡처: '+historyShots);
    // 삭제 실패 시 목록을 복원하고, 성공 시 부모 목록·계정 캐시도 함께 갱신한다.
    await evaluate('window.historyFlags.fail=true;document.querySelector(".ai-workspace-history-remove").click()');
    await waitFor(()=>evaluate('document.querySelector(".workspace-settings-error")?.textContent.includes("이력 삭제 실패")'));
    assert.equal(await evaluate('document.querySelectorAll(".ai-workspace-history-select").length'),10);
    await evaluate('window.historyFlags.fail=false;document.querySelector(".ai-workspace-history-remove").click()');
    await waitFor(()=>evaluate('document.querySelectorAll(".ai-workspace-history-select").length===9&&!document.querySelector(".workspace-settings-dialog footer .primary").disabled'));
    assert.equal(await evaluate('document.querySelector(".workspace-settings-path input").value'),recentPaths[0],'이력 삭제는 현재 경로·기준 설정을 지우지 않는다');
    await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").click()');
    await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog")'));
    assert.equal(await evaluate('document.querySelector(".ai-workspace-input-row input").value'),recentPaths[0]);
    assert.equal(await evaluate('window.audit.opened'),0,'선택 후 옵션 창으로 돌아오며 대화를 시작하지 않는다');
    await evaluate('document.querySelector(".ai-workspace-settings-button").click()');
    await waitFor(()=>evaluate('document.querySelectorAll(".ai-workspace-history-select").length===9'));
    await open({userId:'history-other-account'}, {workspaceContext:configured});
    await evaluate('document.querySelector(".ai-workspace-settings-button").click()');
    await waitFor(()=>evaluate('Boolean(document.querySelector(".ai-workspace-history-empty"))'));
    assert.equal(await evaluate('document.querySelectorAll(".ai-workspace-history-select").length'),0,'다른 계정의 이력을 표시하지 않는다');

    // 서브 머신의 기존 계정·머신 캐시는 해당 머신의 서버 이력으로만 이전한다.
    await evaluate('localStorage.setItem("mindnprogress-ai-workspace-history-v2:remote-history:remote",JSON.stringify(["/remote/project"]))');
    await open({userId:'remote-history'}, {workspaceContext:{...mixed,machineId:'remote',machineRole:'sub'},optionOverrides:{machineId:'remote',machineRole:'sub',machines:[{machineId:'remote',label:'원격',role:'sub'}]}});
    await evaluate('document.querySelector(".ai-workspace-settings-button").click()');
    await waitFor(()=>evaluate('document.querySelector(".ai-workspace-history-select")?.title==="/remote/project"'));
    await evaluate('document.querySelector(".ai-workspace-history-remove").click()');
    await waitFor(()=>evaluate('Boolean(document.querySelector(".ai-workspace-history-empty"))'));
    await waitFor(()=>evaluate('window.audit.calls.some(c=>c.method==="DELETE"&&c.url.endsWith("/workspaces?machineId=remote"))'));
    assert.deepEqual(await evaluate('window.workspaceHistories[JSON.stringify(["remote-history","remote"])]'),[]);
    assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("mindnprogress-ai-workspace-history-v3:"+JSON.stringify(["remote-history","remote"])))'),[]);

    // 이름 편집에서 단독으로 열린 창도 같은 목록을 사용한다.
    await evaluate('window.audit.userId="editor-history";window.workspaceHistories["editor-history"]=["/editor/project"];window.audit.workspaceContext='+JSON.stringify(configured)+';window.renderEditor()');
    await waitFor(()=>evaluate('document.querySelector(".ai-workspace-history-select")?.title==="/editor/project"'));
    await evaluate('document.querySelector(".ai-workspace-history-remove").click()');
    await waitFor(()=>evaluate('Boolean(document.querySelector(".ai-workspace-history-empty"))'));

    await t.test('머신 전환 시 경로·후보·최근 이력을 분리하고 이전 응답을 무시한다', async () => {
      const machines=[{machineId:'fixture',label:'메인',role:'main'},{machineId:'remote-one',label:'원격 1',role:'sub'},{machineId:'remote-two',label:'원격 2',role:'sub'}];
      const machineContexts={
        fixture:{...configured,machines,workspace:'/main/configured'},
        'remote-one':{...configured,machines,machineId:'remote-one',machineRole:'sub',workspace:'/remote-one/configured',token:'remote-one',remotePathUnchecked:true},
        'remote-two':{...mixed,machines,machineId:'remote-two',machineRole:'sub',token:'remote-two',remotePathUnchecked:true,choices:[{workspace:'/remote-two/candidate',reasons:['원격 2 대화']}]},
      };
      await evaluate(`window.historyFlags={holdMachine:'fixture'};
        window.workspaceHistories[JSON.stringify(['machine-history','fixture'])]=['/main/recent'];
        window.workspaceHistories[JSON.stringify(['machine-history','remote-one'])]=['/remote-one/recent'];
        window.workspaceHistories[JSON.stringify(['machine-history','remote-two'])]=['/remote-two/recent'];`);
      await open({userId:'machine-history'},{machineContexts,workspaceContext:machineContexts.fixture});
      await waitFor(()=>evaluate('typeof window.historyFlags.release==="function"'));
      const switchMachine=async (machineId) => {
        await evaluate(`(()=>{const select=document.querySelector('.ai-machine-select select');select.value=${JSON.stringify(machineId)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await waitFor(()=>evaluate(`document.querySelector('.ai-machine-select select')?.value===${JSON.stringify(machineId)}&&!document.querySelector('.ai-dialog footer .primary')?.disabled`));
      };
      await switchMachine('remote-one');
      assert.equal(await evaluate('document.querySelector(".ai-workspace-input-row input").value'),'/remote-one/configured');
      await evaluate('document.querySelector(".ai-workspace-settings-button").click()');
      await waitFor(()=>evaluate('document.querySelector(".ai-workspace-history-select")?.title==="/remote-one/recent"'));
      await evaluate('window.historyFlags.holdMachine=null;window.historyFlags.release()');
      await delay(150);
      assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-workspace-history-select")].map(el=>el.title)'),['/remote-one/recent'],'이전 머신의 늦은 응답이 현재 목록을 바꾸지 않는다');
      await evaluate('document.querySelector(".ai-workspace-history-select").click()');
      await waitFor(()=>evaluate('document.querySelector(".workspace-settings-path input").value==="/remote-one/recent"'));
      await evaluate('document.querySelector(".workspace-settings-dialog footer .primary").click()');
      await waitFor(()=>evaluate('!document.querySelector(".workspace-settings-dialog")'));
      assert.equal(await evaluate('document.querySelector(".ai-workspace-input-row input").value'),'/remote-one/recent');

      await switchMachine('remote-two');
      assert.equal(await evaluate('document.querySelector(".ai-workspace-input-row input").value'),'','기준 없는 머신에 이전 머신의 선택값을 사용하지 않는다');
      await evaluate('document.querySelector(".ai-workspace-settings-button").click()');
      await waitFor(()=>evaluate('document.querySelector(".ai-workspace-history-select")?.title==="/remote-two/recent"'));
      assert.equal(await evaluate('document.querySelector(".workspace-settings-choices").textContent.includes("/remote-two/candidate")'),true);
      assert.equal(await evaluate('document.querySelector(".workspace-settings-dialog").textContent.includes("/remote-one/")'),false);
      await evaluate('document.querySelector(".ai-workspace-history-remove").click()');
      await waitFor(()=>evaluate('window.workspaceHistories[JSON.stringify(["machine-history","remote-two"])].length===0'));
      assert.deepEqual(await evaluate('window.workspaceHistories[JSON.stringify(["machine-history","remote-one"])]'),['/remote-one/recent']);
      await evaluate('document.querySelector(".workspace-settings-dialog header button").click()');
      await switchMachine('remote-one');
      await evaluate(`(()=>{const input=document.querySelector('.ai-workspace-input-row input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'/remote-one/new');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await evaluate('document.querySelector(".ai-dialog footer .primary").click()');
      await waitFor(()=>evaluate('window.workspaceHistories[JSON.stringify(["machine-history","remote-one"])][0]==="/remote-one/new"'));
      assert.deepEqual(await evaluate('window.workspaceHistories[JSON.stringify(["machine-history","fixture"])]'),['/main/recent']);

      // 문서 이름 편집에서 열리는 공통 작업공간 팝업도 머신을 바꿀 때 이력을 다시 조회한다.
      await evaluate('window.audit.workspaceContext=window.audit.machineContexts.fixture;window.renderEditor()');
      await waitFor(()=>evaluate('Boolean(document.querySelector(".workspace-settings-dialog select"))'));
      await evaluate(`(()=>{const select=document.querySelector('.workspace-settings-dialog select');select.value='remote-one';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      await waitFor(()=>evaluate('document.querySelector(".ai-workspace-history-select")?.title==="/remote-one/new"'));
      await evaluate(`(()=>{const select=document.querySelector('.workspace-settings-dialog select');select.value='remote-two';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      await waitFor(()=>evaluate('document.querySelector(".workspace-settings-dialog select")?.value==="remote-two"&&Boolean(document.querySelector(".ai-workspace-history-empty"))'));
      assert.equal(await evaluate('document.querySelector(".workspace-settings-path input").value'),'');

      // 잘못된 계정·머신 응답은 캐시에 저장하거나 목록에 반영하지 않는다.
      await evaluate('window.historyFlags={wrongMachine:"fixture"};window.workspaceHistories["mismatched-history"]=["/wrong-scope/project"]');
      await open({userId:'mismatched-history'},{workspaceContext:configured});
      await waitFor(()=>evaluate('document.querySelector(".ai-workspace-field [role=status]")?.textContent.includes("응답이 다릅니다")'));
      await evaluate('document.querySelector(".ai-workspace-settings-button").click()');
      await waitFor(()=>evaluate('Boolean(document.querySelector(".ai-workspace-history-empty"))'));
      assert.equal(await evaluate('document.querySelector(".workspace-settings-dialog").textContent.includes("/wrong-scope/project")'),false);
    });

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
