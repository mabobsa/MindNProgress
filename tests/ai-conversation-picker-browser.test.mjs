import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 실제 사용자 데이터·AionUi·브라우저 프로필 없이 팝업과 제품 테마를 함께 검증한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { AiConversationPickerDialog } from '/src/components/AiConversationPickerDialog.tsx';
import '/src/dark.css';
import { applyUiTheme } from '/src/theme.ts';
window.setTheme = theme => applyUiTheme(theme);
window.setTheme('light');
const originalFetch = window.fetch.bind(window);
const conversations = ['running','waiting-confirmation','idle','unknown','unavailable','locked'].map((state,index)=>({
  conversationId:'conversation-'+index,name:'작업공간 설정 검토 · '+(index+1),
  homeMachineLabel:'개발 PC',homeMachineRole:'main',accessible:state!=='locked',available:state!=='unavailable',
  runtime:{state:state==='locked'?'idle':state},agent:{label:'Codex'},model:{label:'테스트 모델'},
  mode:{label:'작업공간 쓰기'},thoughtLevel:{label:'높음'},
  requestPreview:'문서와 그룹의 작업공간 기준을 확인하고 승인한 범위에서 개선합니다.',
  workspace:'C:/Git/ExampleProject',skills:[{label:'개발 지침'}],mcpServers:[{label:'MindNProgress'},{label:'테스트 MCP'}],
  startedBy:{label:'테스트 편집자'},startedAt:'2026-09-13T01:30:00Z',
}));
window.audit={selected:null,started:0,closed:0};
window.fetch = async (url,init) => String(url).startsWith('/api/maps/')
  ? new Response(JSON.stringify({latestConversationId:'conversation-0',conversations})) : originalFetch(url,init);
createRoot(document.getElementById('root')).render(React.createElement(AiConversationPickerDialog,{
  mapId:'test-map',cardId:'root',cardTitle:'문서 작업공간 개선',onClose:()=>window.audit.closed++,
  onSelect:c=>window.audit.selected=c.conversationId,onStartNew:()=>window.audit.started++,
  onDeleteUnavailable:async()=>({latestConversationId:'conversation-0'}),
}));
// 텍스트 자신의 배경뿐 아니라 투명한 부모를 통과한 실제 배경과 대비를 계산한다.
window.textContrast = () => {
  const rgba = value => value.match(/[\\d.]+/g).map(Number);
  const over = (front,back) => front.slice(0,3).map((v,i)=>v*(front[3]??1)+back[i]*(1-(front[3]??1)));
  const background = el => el ? over(rgba(getComputedStyle(el).backgroundColor),background(el.parentElement)) : [255,255,255];
  const luminance = rgb => rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  return [...document.querySelectorAll('.ai-conversation-picker *')].filter(el=>[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim())).map(el=>{
    const style=getComputedStyle(el),bg=background(el),fg=over(rgba(style.color),bg),a=luminance(fg),b=luminance(bg);
    return {text:el.textContent.trim(),className:el.className,color:style.color,background:bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
  });
};
`

test('대화 선택 목록의 보조 정보는 다크모드·호버·비활성 상태에서도 읽을 수 있다', {
  skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 60_000,
}, async (t) => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-picker-browser-'))
  const removeProfile = async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('mnp-picker-browser-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, '..'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [react(), {
      name: 'picker-fixture', resolveId: id => id === '/picker-fixture.js' ? '\0picker-fixture' : null,
      load: id => id === '\0picker-fixture' ? fixture : null,
      configureServer(vite) { vite.middlewares.use('/picker-check', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/picker-check', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/picker-fixture.js"></script></body></html>'))
      }) },
    }],
  })
  let browser, socket, send
  const pending = new Map()
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async fn => {
    let lastError
    for (let i = 0; i < 100; i++) {
      try { const value = await fn(); if (value) return value } catch (error) { lastError = error }
      await delay(100)
    }
    throw lastError ?? Error('대화 선택 팝업 검증 대기 시간 초과')
  }
  try {
    await server.listen()
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--window-size=1000,1000', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let spawnError
    browser.on('error', error => { spawnError = error })
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
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/picker-check` })
    await waitFor(() => evaluate('document.querySelectorAll(".ai-conversation-choice").length===6'))
    const typography = () => evaluate('[...document.querySelectorAll(".ai-conversation-choice:first-child *")].map(el=>getComputedStyle(el).fontSize)')
    const lightTypography = await typography()
    const lightColors = await evaluate('window.textContrast().map(item=>item.color)')
    const artifacts = await mkdtemp(path.join(tmpdir(), 'mnp-picker-screenshots-'))
    t.diagnostic(`화면 캡처: ${artifacts}`)
    const screenshot = async name => {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(path.join(artifacts, name), Buffer.from(result.data, 'base64'))
    }
    await screenshot('light.png')
    await evaluate('window.setTheme("dark")')
    await delay(180)
    const assertContrast = async label => {
      const measurements = await evaluate('window.textContrast()')
      assert.ok(measurements.length > 80, '모델·옵션·요청·작업공간·스킬/MCP·날짜·모든 상태를 측정한다')
      assert.deepEqual(measurements.filter(item => item.ratio < 4.5), [], label)
      return Math.min(...measurements.map(item => item.ratio))
    }
    const minimum = await assertContrast('다크모드의 작은 글자는 실제 배경 대비 4.5:1 이상')
    assert.deepEqual(await typography(), lightTypography, '테마 변경으로 글자 크기를 변경하지 않는다')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".ai-conversation-choice-open:disabled")).opacity'), '1')
    await screenshot('dark.png')
    await evaluate('document.querySelector(".ai-conversation-picker-content").scrollTop=99999')
    await screenshot('dark-unavailable.png')
    await evaluate('document.querySelector(".ai-conversation-picker-content").scrollTop=0')
    // 실제 포인터로 카드 호버 배경이 적용된 상태도 검사한다.
    const point = await evaluate('(()=>{const r=document.querySelector(".ai-conversation-choice").getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await delay(180)
    assert.equal(await evaluate('document.querySelector(".ai-conversation-choice").matches(":hover")'), true)
    const hoverMinimum = await assertContrast('호버 중에도 모든 보조 정보의 대비 유지')
    await screenshot('dark-hover.png')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await delay(180)
    await assertContrast('좁은 화면에서도 보조 정보의 대비 유지')
    assert.equal(await evaluate('(()=>{const el=document.querySelector(".ai-conversation-picker"),r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&el.scrollWidth<=el.clientWidth})()'), true)
    await screenshot('dark-mobile.png')
    await evaluate('window.setTheme("light")')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
    await delay(180)
    assert.deepEqual(await evaluate('window.textContrast().map(item=>item.color)'), lightColors, '라이트모드 색상 유지')
    await evaluate('document.querySelector(".ai-conversation-choice-open").click();document.querySelector(".ai-conversation-picker-actions .primary").click()')
    assert.deepEqual(await evaluate('window.audit'), { selected: 'conversation-0', started: 1, closed: 0 })
    t.diagnostic(`다크모드 최소 대비 ${minimum.toFixed(2)}:1, 호버 최소 대비 ${hoverMinimum.toFixed(2)}:1`)
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    await removeProfile()
  }
})
