import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { GlobalSearchDialog } from '/src/components/GlobalSearchDialog.tsx';
import '/src/dark.css';
import { applyUiTheme } from '/src/theme.ts';
window.audit={calls:[],navigations:[],closed:0};
window.setTheme=applyUiTheme;
window.setTheme('light');
const base=(id,label)=>({entity:'card',mapId:'map-a',mapTitle:'검색 문서',mapVersion:3,group:{id:'group-a',name:'검색 그룹'},cardId:id,cardLabel:label,path:['전체 검색',label],kind:'task',isWork:true,status:'in-progress',assignee:{id:'editor',name:'검색 담당자'},hasWaitingItems:false,reference:null,field:'description',fieldLabel:'설명',snippet:label+'의 전체 검색 문맥',matchedTerms:['검색']});
const api=async pathname=>{
  window.audit.calls.push(pathname);
  const url=new URL(pathname,location.origin), cursor=url.searchParams.get('cursor');
  const results=cursor?[base('card-2','두 번째 카드')]:[base('card-1','첫 번째 카드')];
  return {query:url.searchParams.get('q'),mode:'ranked',coverage:{searchedDocumentCount:2,searchedCardCount:12,semanticCoverage:'not-guaranteed',note:'검색 결과는 후보이며 최신 카드를 확인하세요.'},page:{returned:1,total:2,hasMore:!cursor,nextCursor:cursor?null:'next-page'},results};
};
createRoot(document.getElementById('root')).render(React.createElement(GlobalSearchDialog,{
  api,documents:[{id:'map-a',title:'검색 문서'}],groups:[{id:'group-a',name:'검색 그룹',mapIds:['map-a']}],assignees:[{id:'editor',name:'검색 담당자'}],
  onNavigate:(mapId,cardId)=>window.audit.navigations.push({mapId,cardId}),onClose:()=>window.audit.closed++,
}));
`

test('전체 검색 화면이 필터·커서·이동과 다크·모바일 표시를 실제 브라우저에서 제공한다', {
  skip: process.env.MNP_BROWSER_TEST !== '1',
  timeout: 60_000,
}, async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const projectDirectory = path.resolve(import.meta.dirname, '..')
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-global-search-browser-'))
  const server = await createServer({
    configFile: false,
    root: projectDirectory,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [react(), {
      name: 'global-search-fixture',
      resolveId: (id) => id === '/global-search-fixture.js' ? '\0global-search-fixture' : null,
      load: (id) => id === '\0global-search-fixture' ? fixture : null,
      configureServer(vite) {
        vite.middlewares.use('/global-search-check', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(await vite.transformIndexHtml('/global-search-check', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/global-search-fixture.js"></script></body></html>'))
        })
      },
    }],
  })
  let browser
  let socket
  let send
  const pending = new Map()
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const waitFor = async (operation) => {
    let lastError
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const value = await operation()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await delay(100)
    }
    throw lastError ?? new Error('전체 검색 화면 검증 대기 시간 초과')
  }
  try {
    await server.listen()
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`,
      '--window-size=1000,900', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let spawnError
    browser.on('error', (error) => { spawnError = error })
    const debugPort = await waitFor(async () => {
      if (spawnError) throw spawnError
      return (await readFile(path.join(profileDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
    })
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let sequence = 0
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error(message.error.message))
      else item.resolve(message.result)
    }
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method)) }, 10_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/global-search-check` })
    await waitFor(() => evaluate('Boolean(document.querySelector(".global-search-dialog"))'))
    await evaluate(`(()=>{const input=document.querySelector('.global-search-query input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'검색');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await waitFor(() => evaluate('window.audit.calls.length>=1&&document.querySelectorAll(".global-search-result").length===1'))
    assert.match(await evaluate('window.audit.calls.at(-1)'), /q=%EA%B2%80%EC%83%89/)
    await evaluate(`(()=>{const select=document.querySelector('[aria-label="문서 또는 그룹"]');select.value='group:group-a';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await waitFor(() => evaluate('window.audit.calls.some(call=>call.includes("groupId=group-a"))'))
    await evaluate('document.querySelector(".global-search-more").click()')
    await waitFor(() => evaluate('document.querySelectorAll(".global-search-result").length===2'))
    assert.match(await evaluate('window.audit.calls.at(-1)'), /cursor=next-page/)
    await evaluate('document.querySelectorAll(".global-search-result")[1].click()')
    assert.deepEqual(await evaluate('window.audit.navigations'), [{ mapId: 'map-a', cardId: 'card-2' }])
    await evaluate('window.setTheme("dark")')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".global-search-dialog")).backgroundColor'), 'rgb(26, 29, 39)')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await delay(150)
    assert.equal(await evaluate('(()=>{const element=document.querySelector(".global-search-dialog"),rect=element.getBoundingClientRect();return rect.left===0&&rect.right===innerWidth&&element.scrollWidth<=element.clientWidth})()'), true)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await waitFor(() => evaluate('window.audit.closed===1'))
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) {
      const exited = new Promise((resolve) => browser.once('exit', resolve))
      browser.kill()
      await exited
    }
    await server.close()
    assert.equal(path.dirname(path.resolve(profileDirectory)), path.resolve(tmpdir()))
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
})
