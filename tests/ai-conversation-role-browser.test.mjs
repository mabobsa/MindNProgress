import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildGroupCoordinatorRequest } from '../src/utils/aiApprovalInstructions.mjs'
import { DEFAULT_AI_EDITOR_REQUEST } from '../src/utils/aiConversationLaunch.mjs'

// 실제 MnP·AionUi·사용자 프로필에 접근하지 않고 실제 팝업 컴포넌트만 실행한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '/src/index.css';
import { AiConversationDialog } from '/src/components/AiConversationDialog.tsx';
import '/src/dark.css';
const root = createRoot(document.getElementById('root'));
const originalFetch = window.fetch.bind(window);
const workspaceContext = {mapId:'map-coordinator',groupId:'group-manager',groupName:'테스트 그룹',machineId:'fixture',machineRole:'main',documentSetting:{version:0,workspace:''},groupSetting:{version:1,workspace:'/fixture/project'},source:'group',workspace:'/fixture/project',error:'',choices:[],token:'initial',needsSelection:false};
const options = {connected:true,machineId:'fixture',machineLabel:'테스트',machineRole:'main',machines:[{machineId:'fixture',label:'테스트',role:'main'}],protocol:'fixture:',defaultWorkspace:workspaceContext.workspace,workspaceContext,workspaceBrowseAvailable:false,skills:[],mcpServers:[],agents:[{id:'test',name:'테스트 AI',models:[{id:'test',label:'테스트'}],defaultModelId:'test',modes:[],thoughtLevels:[]}]};
options.agents.push({id:'claude',name:'Claude Code',models:[{id:'opus',label:'Opus'},{id:'sonnet',label:'Sonnet'}],defaultModelId:'sonnet',modes:[{id:'accept-edits',label:'편집 허용'}],defaultMode:'accept-edits',thoughtLevels:[{id:'high',label:'높음'}],defaultThoughtLevel:'high'});
options.machines.push({machineId:'sub',label:'서브 머신',role:'sub'});
window.fixtureOptions = options;
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
  } else if (url.startsWith('/api/integrations/aionui/options')) {
    const machineId=new URL(url,location.origin).searchParams.get('machineId') || 'fixture';
    body={...options,machineId,machineRole:machineId==='sub'?'sub':'main',workspaceContext:{...workspaceContext,machineId},agents:machineId==='sub'?[options.agents[0]]:options.agents};
  }
  else if (url.startsWith('/api/integrations/aionui/workspace-context')) body = {...workspaceContext,machineId:new URL(url,location.origin).searchParams.get('machineId')};
  else if (url.startsWith('/api/integrations/aionui/workspaces?')) body = {userId:a.userId,machineId:new URL(url,location.origin).searchParams.get('machineId'),workspaces:[]};
  else if (url === '/api/integrations/aionui/dialog-preferences') body = {userId:a.userId,sections:{workspace:true,mcp:true,skills:true}};
  else if (url === '/api/integrations/aionui/attributions') body = {editorId:'fixture',attributionToken:'fixture',completionUrl:'http://fixture.invalid/completion',statusUrl:'/api/integrations/aionui/launches/'+ 'A'.repeat(43) +'/status',approvalRequest:a.approvalRequest};
  else if (url.endsWith('/status')) {
    if (a.statusHttp) return new Response(JSON.stringify({error:'시작 상태 조회 실패'}),{status:a.statusHttp});
    body = {status:a.launchStatus || 'completed',conversationId:a.launchStatus ? null : 'fixture-conversation',launchUrl:'about:blank',error:a.confirmationError || '',createdConversationId:a.createdConversationId,canRetry:a.canRetry};
  }
  else if (url.endsWith('/confirm')) { a.launchStatus=null; a.confirmationError=''; a.canRetry=false; body={conversationId:a.createdConversationId}; }
  else if (url.includes('/response-approvals/') && url.includes('/confirmation?')) body={status:'completed',conversationId:'fixture-conversation'};
  else if (url === '/api/integrations/aionui/external-conversation-launches') body = {launchUrl:'about:blank'};
  else throw new Error('예상하지 않은 테스트 요청: '+url);
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
};
let sequence = 0;
window.renderDialog = (input = {}, flags = {}) => {
  Object.assign(window.audit,{calls:[],fail:false,hold:false,closed:0,launchStatus:null,statusHttp:0,confirmationError:'',createdConversationId:null,canRetry:false,approvalRequest:null,context:{map:{id:'map-coordinator',nodes:[{id:'root',data:{kind:'root'}},{id:'child',data:{kind:'task'}}],edges:[{source:'root',target:'child'}]},groupProject:{groupId:'group-manager',role:'coordinator',coordinatorMapId:'map-coordinator'}},...flags});
  window.audit.userId = input.userId || 'fixture';
  flushSync(()=>root.render(React.createElement(AiConversationDialog,{key:++sequence,userId:'fixture',documentId:'map-coordinator',documentTitle:'총괄 문서',cardId:'root',cardTitle:'총괄 루트',purpose:'card',knowledgeSources:[],launchInWebUi:true,onClose:()=>window.audit.closed++,...input})));
};
window.fixtureReady = true;
`

test('실제 대화 팝업의 총괄 전문·선택적 위임 모델·전달 목적·조회 중 잠금·오류·역할 변경을 검증한다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 90_000 }, async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-role-browser-'))
  // 고정 UI 검사에는 전체 설치 폴더의 의존성 탐색·파일 감시와 운영 캐시 공유가 필요 없다.
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, '..'), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [react(), {
      name: 'role-fixture', resolveId: (id) => id === '/role-fixture.js' ? '\0role-fixture' : null,
      load: (id) => id === '\0role-fixture' ? fixture : null,
      configureServer(vite) { vite.middlewares.use('/role-check', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/role-check', '<!doctype html><html><body><div id="root"></div><script type="module" src="/role-fixture.js"></script></body></html>'))
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
    const enterUserRequest = (value) => evaluate(`(() => {
      const input = document.querySelector('.ai-user-request textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    const expected = buildGroupCoordinatorRequest({ groupId: 'group-manager' })
    assert.equal(await open(), expected)
    assert.equal(await open({ purpose: 'group-coordination', groupId: 'group-manager', initialRequest: expected, fullInitialRequest: true }), expected)
    assert.equal(await open({ cardId: 'child' }), DEFAULT_AI_EDITOR_REQUEST)
    assert.equal(await open({ purpose: 'shared-knowledge-review', initialRequest: '지식 정리 제안만' }, { fail: true }), '지식 정리 제안만')
    assert.equal(await evaluate('window.audit.calls.some(c=>c.url.startsWith("/api/maps/"))'), false)
    await open()
    await evaluate('document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('window.audit.closed === 1'))
    const posts = await evaluate('window.audit.calls.filter(c=>c.method === "POST")')
    assert.equal(posts.find(c => c.url.endsWith('/attributions')).body.purpose, 'group-coordination')
    const payload = posts.find(c => c.url.endsWith('/external-conversation-launches')).body
    assert.ok(payload.prompt.includes(expected)); assert.match(payload.title, /^\[그룹 총괄\]/)
    assert.ok(!payload.prompt.includes('# 사용자 요청'), '사용자 입력이 없으면 빈 요청 절을 추가하지 않는다')

    await open({ cardId: 'child' })
    const userRequest = '첫 번째 요청\n\n- 두 번째 요청'
    await enterUserRequest(userRequest)
    assert.equal(await evaluate('document.querySelector(".ai-auto-request textarea").value'), DEFAULT_AI_EDITOR_REQUEST)
    await evaluate('document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('window.audit.closed === 1'))
    const userPrompt = await evaluate('window.audit.calls.find(c=>c.url.endsWith("/external-conversation-launches")).body.prompt')
    assert.ok(userPrompt.endsWith(`${DEFAULT_AI_EDITOR_REQUEST}\n\n# 사용자 요청\n${userRequest}`), '입력한 본문은 최종 전송 전문의 사용자 요청 절에 들어간다')

    const preview = () => evaluate('document.querySelector(".ai-auto-request textarea").value')
    const choose = async (selector, value) => {
      await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    }
    const chooseDelegation = (index, value) => choose(`.ai-delegation-model-section .ai-dialog-grid label:nth-child(${index + 1}) select`, value)
    const delegationValues = () => evaluate('[...document.querySelectorAll(".ai-delegation-model-section select")].map(el=>el.value)')
    const toggleNarrative = () => evaluate('document.querySelector(".ai-delegation-model-section").open=true;document.querySelector(".ai-delegation-narrative-toggle input").click()')
    const enterNarrative = value => evaluate(`(() => {
      const input = document.querySelector('.ai-delegation-narrative textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await open()
    assert.equal(await evaluate('document.querySelector(".ai-delegation-model-section").open'), false)
    assert.equal(await evaluate('document.querySelector(".ai-delegation-restore")'), null, '마지막 선택값 적용 버튼을 제거한다')
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative-toggle input").checked'), false)
    assert.equal(await preview(), expected)
    await evaluate('document.querySelector(".ai-delegation-model-section summary").click()')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-delegation-model-section select")].map(el=>el.value)'), ['', '', '', ''])
    await chooseDelegation(0, 'claude')
    await waitFor(async () => (await preview()).includes('AI 종류 `Claude Code`'))
    assert.equal(await preview(), expected + '\n\n하위 카드에 업무를 위임할 때 다음 AI 설정을 사용하세요: AI 종류 `Claude Code`.')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-delegation-model-section select")].map(el=>el.value)'), ['claude', '', '', ''], 'AI 종류를 골라도 모델·권한·사고 수준 기본값을 채우지 않는다')
    await chooseDelegation(1, 'opus')
    await chooseDelegation(2, 'accept-edits')
    await chooseDelegation(3, 'high')
    const instruction = '하위 카드에 업무를 위임할 때 다음 AI 설정을 사용하세요: AI 종류 `Claude Code`, 모델 `Opus`, 권한 `편집 허용`, 사고 수준 `높음`.'
    await waitFor(async () => (await preview()).endsWith(instruction))
    const currentAgentSelector = '.ai-dialog-options > .ai-dialog-grid label:first-child select'
    await choose(currentAgentSelector, 'claude')
    await choose(currentAgentSelector, 'test')
    assert.equal(await preview(), expected + '\n\n' + instruction, '현재 대화 모델을 바꿔도 위임 설정은 유지한다')
    for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.ai-delegation-model-section').scrollIntoView({block:'center'})`)
      const layout = await evaluate(`(() => {const section=document.querySelector('.ai-delegation-model-section'),content=document.querySelector('.ai-dialog-content'),guidance=section.querySelector('.ai-delegation-model-guidance').getBoundingClientRect(),toggle=section.querySelector('.ai-delegation-narrative-toggle').getBoundingClientRect(),text=section.querySelector('.ai-delegation-model-guidance p').getBoundingClientRect();return {fits:content.scrollWidth<=content.clientWidth,selectsFit:[...section.querySelectorAll('select')].every(el=>el.getBoundingClientRect().right<=section.getBoundingClientRect().right),toggleRightAligned:Math.abs(toggle.right-guidance.right)<1,textNotOverlapped:text.right<toggle.left}})()`)
      assert.deepEqual(layout, { fits: true, selectsFit: true, toggleRightAligned: true, textNotOverlapped: true })
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const shotPath = path.join(tmpdir(), `mnp-delegation-model-${width}-${theme}.png`)
      await writeFile(shotPath, Buffer.from(shot.data, 'base64'))
      console.log(`위임 모델 UI: ${shotPath}`)
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await evaluate('document.documentElement.dataset.theme="light";document.querySelector(".ai-delegation-model-section summary").click()')
    assert.equal(await preview(), expected + '\n\n' + instruction, '접어도 선택한 설정은 유지한다')
    await evaluate('document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('window.audit.closed === 1'))
    const delegationPosts = await evaluate('window.audit.calls.filter(c=>c.method === "POST")')
    const delegationPayload = delegationPosts.find(c => c.url.endsWith('/external-conversation-launches')).body
    assert.equal(delegationPayload.agentId, 'test')
    assert.equal(delegationPayload.modelId, 'test')
    assert.equal(delegationPayload.mode, undefined)
    assert.equal(delegationPayload.thoughtLevel, undefined)
    assert.equal(delegationPosts.find(c => c.url.endsWith('/attributions')).body.agentId, 'test')
    assert.ok(delegationPayload.prompt.endsWith(expected + '\n\n' + instruction), '현재 대화 실행 옵션을 바꾸지 않고 위임 요청만 전달한다')

    await open({ cardId: 'child' })
    assert.deepEqual(await delegationValues(), ['claude', 'opus', 'accept-edits', 'high'])
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST + '\n\n' + instruction, '다시 열면 마지막 설정을 자동 적용한다')
    assert.equal(await evaluate('window.audit.calls.some(c=>c.method==="POST")'), false, '자동 복원은 대화나 위임을 실행하지 않는다')

    await evaluate('window.fixtureReady=false')
    await send('Page.reload')
    await waitFor(() => evaluate('window.fixtureReady'))
    await open({ cardId: 'child' })
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST + '\n\n' + instruction, '페이지 새로고침 후에도 자동 복원한다')
    assert.deepEqual(await delegationValues(), ['claude', 'opus', 'accept-edits', 'high'], '브라우저 저장값을 다시 읽는다')

    await open({ userId: 'other-account', cardId: 'child' })
    assert.deepEqual(await delegationValues(), ['', '', '', ''], '다른 계정의 저장 설정을 불러오지 않는다')
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative-toggle input").checked'), false)
    await evaluate('window.fixtureOptions.agents[1].models=[{id:"sonnet",label:"Sonnet"}]')
    await open({ cardId: 'child' })
    assert.deepEqual(await delegationValues(), ['claude', '', 'accept-edits', 'high'], '없어진 모델은 기본 모델로 바꾸지 않는다')
    assert.match(await evaluate('document.querySelector(".ai-delegation-model-notice").textContent'), /현재 목록에 없는 모델/)
    await evaluate('window.fixtureOptions.agents[1].models=[{id:"opus",label:"Opus"},{id:"sonnet",label:"Sonnet"}]')
    await open({ cardId: 'child' })
    assert.deepEqual(await delegationValues(), ['claude', 'opus', 'accept-edits', 'high'], '불러오기 검증은 저장 원본을 덮어쓰지 않는다')
    await evaluate('window.allFixtureAgents=window.fixtureOptions.agents;window.fixtureOptions.agents=window.fixtureOptions.agents.filter(a=>a.id!=="claude")')
    await open({ cardId: 'child' })
    assert.deepEqual(await delegationValues(), ['', '', '', ''])
    assert.match(await evaluate('document.querySelector(".ai-delegation-model-notice").textContent'), /현재 목록에 없는 AI 종류/)
    await evaluate('window.fixtureOptions.agents=window.allFixtureAgents')
    await open({ cardId: 'child' })

    const narrativeText = '  구현은 Claude Code의 Opus로 위임하세요.\n검수는 Codex, 사고 수준은 높음으로 진행하세요.  '
    const narrativeInstruction = '하위 카드에 업무를 위임할 때 다음 AI 설정을 사용하세요:\n' + narrativeText.trim()
    await toggleNarrative()
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST, '빈 서술형은 이전 선택형 요청을 전달하지 않는다')
    assert.deepEqual(await delegationValues(), [])
    await enterNarrative(narrativeText)
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST + '\n\n' + narrativeInstruction)
    await open({ cardId: 'child' })
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative-toggle input").checked'), true)
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative textarea").value'), narrativeText)
    await evaluate('window.fixtureReady=false')
    await send('Page.reload')
    await waitFor(() => evaluate('window.fixtureReady'))
    await open({ cardId: 'child' })
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative-toggle input").checked'), true)
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative textarea").value'), narrativeText, '새로고침 뒤 원문과 체크 상태 보존')
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST + '\n\n' + narrativeInstruction)
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false })
    await evaluate('document.documentElement.dataset.theme="dark";document.querySelector(".ai-delegation-model-section").open=true;document.querySelector(".ai-delegation-model-section").scrollIntoView({block:"center"})')
    assert.equal(await evaluate('document.querySelector(".ai-dialog-content").scrollWidth <= document.querySelector(".ai-dialog-content").clientWidth'), true)
    const narrativeShot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(tmpdir(), 'mnp-delegation-narrative-mobile.png'), Buffer.from(narrativeShot.data, 'base64'))
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await evaluate('document.documentElement.dataset.theme="light";document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('window.audit.closed === 1'))
    const narrativePayload = await evaluate('window.audit.calls.find(c=>c.url.endsWith("/external-conversation-launches")).body')
    assert.ok(narrativePayload.prompt.endsWith(DEFAULT_AI_EDITOR_REQUEST + '\n\n' + narrativeInstruction))
    assert.equal(narrativePayload.agentId, 'test', '서술형도 현재 대화 모델을 바꾸지 않는다')
    await open({ cardId: 'child' })
    await toggleNarrative()
    assert.deepEqual(await delegationValues(), ['claude', 'opus', 'accept-edits', 'high'], '선택형 값은 서술형 입력과 별도 보존한다')
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST + '\n\n' + instruction)
    await toggleNarrative()
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative textarea").value'), narrativeText)
    await enterNarrative('')
    await open({ cardId: 'child' })
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative-toggle input").checked'), true)
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative textarea").value'), '', '명시적 본문 삭제도 보존한다')
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST)
    await enterNarrative(narrativeText)
    await toggleNarrative()

    await chooseDelegation(0, 'claude')
    await chooseDelegation(1, 'opus')
    await chooseDelegation(0, 'test')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".ai-delegation-model-section select")].map(el=>el.value)'), ['test', '', '', ''], '위임 AI를 바꾸면 이전 모델·권한·사고 수준을 지운다')
    await chooseDelegation(0, '')
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST, '전체 선택 해제 시 원문으로 복원한다')
    await open({ cardId: 'child' })
    assert.deepEqual(await delegationValues(), ['', '', '', ''], '전체 선택 해제도 다음 진입에 유지한다')
    await chooseDelegation(0, 'claude')
    await chooseDelegation(1, 'opus')
    await choose('.ai-machine-select select', 'sub')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-auto-request textarea")) && document.querySelector(".ai-machine-select select").value === "sub"'))
    assert.equal(await preview(), DEFAULT_AI_EDITOR_REQUEST, '머신 변경 시 이전 머신 위임 설정을 전달하지 않는다')
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative-toggle input").checked'), false)
    await chooseDelegation(0, 'test')
    await toggleNarrative()
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative textarea").value'), '', '다른 머신의 본문을 불러오지 않는다')
    await enterNarrative('서브 머신 전용 위임 설정')
    await choose('.ai-machine-select select', 'fixture')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-auto-request textarea")) && document.querySelector(".ai-machine-select select").value === "fixture"'))
    assert.deepEqual(await delegationValues(), ['claude', 'opus', '', ''], '머신별 마지막 지정값을 구분하고 선택하지 않은 값은 비워 둔다')
    await toggleNarrative()
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative textarea").value'), narrativeText)
    await toggleNarrative()
    await evaluate('window.originalStorageSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith("mindnprogress-ai-delegation-runtime:"))throw new DOMException("용량 초과","QuotaExceededError");return window.originalStorageSetItem.call(this,key,value)}')
    await chooseDelegation(3, 'high')
    assert.match(await evaluate('document.querySelector(".ai-delegation-model-notice").textContent'), /저장하지 못했습니다/)
    assert.deepEqual(await delegationValues(), ['claude', 'opus', '', 'high'], '브라우저 저장이 실패해도 현재 선택은 유지한다')
    assert.ok((await preview()).includes('사고 수준 `높음`'))
    await toggleNarrative()
    await enterNarrative('저장에 실패한 새 서술형 설정')
    assert.match(await evaluate('document.querySelector(".ai-delegation-model-notice").textContent'), /저장하지 못했습니다/)
    assert.ok((await preview()).endsWith('저장에 실패한 새 서술형 설정'), '저장소 오류에도 현재 체크 상태와 입력은 적용한다')
    await evaluate('Storage.prototype.setItem=window.originalStorageSetItem')

    const longApproval = '서버 승인 전문\n' + '조건'.repeat(2500) + '\n마지막 승인 조건'
    await open({ purpose: 'dooray-response', initialRequest: '화면 인계 내용', doorayApproval: { responseId: 'dooray-fixture', proposalRevision: 'a'.repeat(64) } }, { approvalRequest: longApproval })
    await chooseDelegation(0, 'claude')
    await chooseDelegation(1, 'opus')
    await enterUserRequest('승인 범위 내에서 추가 조건을 확인하세요.')
    await evaluate('document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('window.audit.closed === 1'))
    const approvalPrompt = await evaluate('window.audit.calls.find(c=>c.url.endsWith("/external-conversation-launches")).body.prompt')
    assert.ok(approvalPrompt.includes(longApproval), 'Dooray 서버 승인 원문을 보존한다')
    assert.ok(approvalPrompt.endsWith('하위 카드에 업무를 위임할 때 다음 AI 설정을 사용하세요: AI 종류 `Claude Code`, 모델 `Opus`.\n\n# 사용자 요청\n승인 범위 내에서 추가 조건을 확인하세요.'))

    await open({}, { launchStatus: 'pending' })
    await evaluate('document.querySelector(".ai-dialog footer .primary").click(); document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-launch-confirmation")) && !document.querySelector(".ai-dialog header button").disabled'))
    assert.equal(await evaluate('window.audit.closed'), 0, 'ticket 발급만으로 팝업을 닫지 않는다')
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.url.endsWith("/external-conversation-launches")).length'), 1)
    assert.equal(await evaluate('document.querySelector(".ai-workspace-input input").matches(":disabled")'), true)
    assert.equal(await evaluate('document.querySelector(".ai-delegation-narrative-toggle input").matches(":disabled")'), true, '시작 확인 중에는 서술형 전환으로 요청을 변경할 수 없다')
    for (const [width, height] of [[1440, 900], [900, 480], [390, 640]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      const layout = await evaluate(`(() => {
        const content=document.querySelector('.ai-dialog-content'), notice=document.querySelector('.ai-launch-confirmation'), footer=document.querySelector('.ai-dialog footer');
        return { contentBottom:content.getBoundingClientRect().bottom, noticeTop:notice.getBoundingClientRect().top,
          noticeBottom:notice.getBoundingClientRect().bottom, footerTop:footer.getBoundingClientRect().top,
          footerBottom:footer.getBoundingClientRect().bottom, overflow:getComputedStyle(content).overflowY };
      })()`)
      assert.ok(layout.contentBottom <= layout.noticeTop + 1 && layout.noticeBottom <= layout.footerTop + 1, '대기 안내는 스크롤되는 옵션 영역·하단 버튼과 겹치지 않는다')
      assert.ok(layout.footerBottom <= height, '작은 화면에서도 닫기 버튼을 유지한다')
      assert.equal(layout.overflow, 'auto')
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    const pendingScreenshot = await send('Page.captureScreenshot', { format: 'png' })
    const pendingScreenshotPath = path.join(tmpdir(), `mnp-ai-launch-pending-${Date.now()}.png`)
    await writeFile(pendingScreenshotPath, Buffer.from(pendingScreenshot.data, 'base64'))
    console.log(`AI 대화 생성 확인 UI: ${pendingScreenshotPath}`)
    await evaluate('window.renderDialog({}, {launchStatus:"pending"})')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-launch-confirmation"))'))
    assert.equal(await evaluate('document.querySelector(".ai-dialog footer .primary").disabled'), true)
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.method==="POST").length'), 0, '재마운트는 저장한 시작 상태만 확인한다')
    await evaluate('window.audit.statusHttp=503; Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="상태 다시 확인").click()')
    await waitFor(() => evaluate('document.querySelector(".ai-launch-error")?.textContent.includes("조회 실패")'))
    assert.equal(await evaluate('window.audit.closed'), 0)
    await evaluate('window.audit.statusHttp=0;window.audit.launchStatus="confirmation-failed";window.audit.confirmationError="작업공간 연결 검증 실패";Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="상태 다시 확인").click()')
    await waitFor(() => evaluate('document.querySelector(".ai-launch-error")?.textContent.includes("작업공간 연결 검증 실패")'))
    assert.equal(await evaluate('window.audit.closed'), 0)
    await evaluate('window.audit.createdConversationId="fixture-conversation";window.audit.canRetry=true;Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="상태 다시 확인").click()')
    await waitFor(() => evaluate('document.querySelector(".ai-launch-confirmation strong")?.textContent==="대화 연결 확인 중…"'))
    const repairScreenshot = await send('Page.captureScreenshot', { format: 'png' })
    const repairScreenshotPath = path.join(tmpdir(), `mnp-approval-repair-${Date.now()}.png`)
    await writeFile(repairScreenshotPath, Buffer.from(repairScreenshot.data, 'base64'))
    console.log(`승인 연결 재확인 UI: ${repairScreenshotPath}`)
    await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="기존 대화 연결 다시 확인").click()')
    await waitFor(() => evaluate('window.audit.closed === 1'))
    assert.equal(await evaluate('Object.keys(sessionStorage).some(k=>k.startsWith("mindnprogress-ai-launch:"))'), false)

    await open({}, { launchStatus: 'pending' })
    await evaluate('document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-launch-confirmation")) && !document.querySelector(".ai-dialog header button").disabled'))
    await evaluate('window.audit.statusHttp=404;Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="상태 다시 확인").click()')
    await waitFor(() => evaluate('document.querySelector(".ai-launch-error")?.textContent.includes("조회 실패")'))
    await evaluate('window.confirm=()=>false;Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="대화 목록 확인 후 새로 준비").click()')
    assert.equal(await evaluate('document.querySelector(".ai-dialog footer .primary").disabled'), true, '초기화 확인 취소 시 불명확 접수 상태를 유지한다')
    await evaluate('window.confirm=()=>true;Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="대화 목록 확인 후 새로 준비").click()')
    await waitFor(() => evaluate('!document.querySelector(".ai-launch-confirmation")'))
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.url.endsWith("/external-conversation-launches")).length'), 1, '초기화는 자동 재시작하지 않는다')

    await open({ purpose: 'dooray-response', doorayApproval: { responseId: 'repair-approval', proposalRevision: 'a'.repeat(64) } }, { launchStatus: 'pending', approvalRequest: '저장된 승인 전문' })
    await evaluate('document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-launch-confirmation")) && !document.querySelector(".ai-dialog header button").disabled'))
    await evaluate('window.audit.statusHttp=404;Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="상태 다시 확인").click()')
    await waitFor(() => evaluate('window.audit.closed===1'))
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.url.includes("/confirmation?")).length'), 1)
    assert.equal(await evaluate('window.audit.calls.filter(c=>c.url.endsWith("/external-conversation-launches")).length'), 1, '만료 후 실제 승인 연결 조회도 새 대화를 만들지 않는다')

    await evaluate('localStorage.removeItem("mindnprogress-ai-delegation-runtime:fixture:fixture");window.renderDialog({}, {hold:true})')
    await waitFor(() => evaluate('document.querySelector(".ai-dialog [role=status]")?.textContent.includes("대화 역할")'))
    assert.equal(await evaluate('document.querySelector(".ai-dialog footer .primary").disabled'), true)
    assert.equal(await evaluate('Boolean(document.querySelector(".ai-auto-request textarea"))'), false)
    await evaluate('window.audit.hold=false; window.audit.release()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-auto-request textarea"))'))

    await evaluate('window.renderDialog({}, {fail:true})')
    await waitFor(() => evaluate('document.querySelector(".ai-dialog [role=alert]")?.textContent.includes("역할 조회 실패")'))
    assert.equal(await evaluate('document.querySelector(".ai-dialog footer .primary").disabled'), true)
    await open()
    await evaluate('window.audit.context.groupProject=null; document.querySelector(".ai-dialog footer .primary").click()')
    await waitFor(() => evaluate('document.querySelector(".ai-launch-error")?.textContent.includes("그룹 역할이 변경")'))
    assert.equal(await evaluate('document.querySelector(".ai-auto-request textarea").value'), DEFAULT_AI_EDITOR_REQUEST)
    assert.equal(await evaluate('window.audit.calls.some(c=>c.method === "POST")'), false)
    // 요청 대상 변경 시 늦은 응답이 현재 카드의 전문을 덮어쓰지 않아야 한다.
    await evaluate('window.renderDialog({}, {hold:true})')
    await waitFor(() => evaluate('Boolean(document.querySelector(".ai-dialog [role=status]"))'))
    assert.equal(await open({ cardId: 'child' }), DEFAULT_AI_EDITOR_REQUEST)
  } catch (error) {
    console.error('대화 팝업 검증 실패:', error)
    throw error
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mnp-role-browser-')) throw Error('테스트 임시 경로 검증 실패')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
})
