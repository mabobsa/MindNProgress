import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export async function aiConversationLinkBrowser(api, t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-conversation-link-browser-'))
  const browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let socket, send, spawnError
  browser.on('error', (error) => { spawnError = error })
  const pending = new Map(), exceptions = []
  const waitFor = async (check, message) => {
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw Error(message)
  }
  try {
    let port
    await waitFor(async () => { try { port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return !!port } catch { return false } }, '브라우저 시작 실패')
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let sequence = 0
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data), item = pending.get(message.id)
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
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
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        if (!String(url).startsWith('/api/')) return originalFetch(url, options);
        const response = await originalFetch(url, options);
        if (String(url).includes('/ai-conversations/lookup') && window.holdLookup) {
          await new Promise(resolve => window.releaseLookup = resolve);
        }
        return response;
      };
    ` })
    await send('Page.navigate', { url: api.base })
    await waitFor(() => evaluate(`location.origin === ${JSON.stringify(api.base)} && document.readyState === 'complete'`).catch(() => false), '시험 페이지 준비 실패')
    assert.equal(await evaluate(`fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'editor@mind.local',password:'LinkTestOnly!2026'})}).then(response=>response.status)`), 200)
    const navigate = async (card) => {
      await send('Page.navigate', { url: `${api.base}/mindmap/${api.ids[0]}/${card}` })
      await waitFor(() => evaluate('!!document.querySelector(".ai-conversation-button")').catch(() => false), 'AI 대화 버튼 표시 실패')
    }
    const openLink = async () => {
      const point = await evaluate('(()=>{const r=document.querySelector(".ai-conversation-button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1, ...point })
      await waitFor(() => evaluate('!![...document.querySelectorAll(".ai-conversation-context-menu button")].find(b=>b.textContent.includes("AI 대화 연결"))'), '연결 메뉴 표시 실패')
      await evaluate('[...document.querySelectorAll(".ai-conversation-context-menu button")].find(b=>b.textContent.includes("AI 대화 연결")).click()')
      await waitFor(() => evaluate('!!document.querySelector("#ai-conversation-link-id")'), '연결 창 표시 실패')
    }
    const inputId = async (id) => {
      await evaluate(`(()=>{const el=document.querySelector('#ai-conversation-link-id');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(id)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    }
    const lookup = async (id) => {
      await inputId(id)
      await evaluate('document.querySelector(".ai-conversation-link-search button").click()')
      await waitFor(() => evaluate('!!document.querySelector(".ai-conversation-link-preview")'), '대화 정보 표시 실패')
    }
    await navigate('card-4')
    assert.ok((await evaluate('document.querySelector(".ai-conversation-button").textContent')).includes('AI 대화 시작'))
    await openLink()
    assert.ok(await evaluate('document.querySelector(".ai-conversation-link-dialog .primary").disabled'))
    await lookup('browser-archived')
    assert.ok((await evaluate('document.querySelector(".ai-conversation-link-preview").textContent')).includes('C:/Git/Example'))
    assert.equal(await evaluate('document.querySelector(".ai-conversation-link-dialog .primary").textContent'), '보관함에서 복원하고 연결')
    const screenshots = await mkdtemp(path.join(tmpdir(), 'mnp-conversation-link-screenshots-'))
    t.diagnostic(`화면 캡처: ${screenshots}`)
    await writeFile(path.join(screenshots, 'light.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    await evaluate('document.documentElement.dataset.theme="dark"')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    assert.ok(await evaluate('(()=>{const el=document.querySelector(".ai-conversation-link-dialog"),r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&el.scrollWidth<=el.clientWidth})()'))
    await writeFile(path.join(screenshots, 'dark-mobile.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    await evaluate('document.querySelector(".ai-conversation-link-dialog .primary").click()')
    await waitFor(() => evaluate('!document.querySelector(".ai-conversation-link-dialog")'), '연결 완료 후 창 닫기 실패')
    const map = (await api.call(`/api/maps/${api.ids[0]}`)).body.map
    assert.equal(map.nodes.find((node) => node.id === 'card-4').data.aiConversationId, 'browser-archived')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await navigate('card-0')
    assert.ok((await evaluate('document.querySelector(".ai-conversation-button").textContent')).includes('AI 대화 열기'))
    await openLink()
    await lookup('elsewhere')
    assert.ok((await evaluate('document.querySelector(".ai-conversation-link-preview").textContent')).includes('다른 카드'))
    assert.ok(await evaluate('document.querySelector(".ai-conversation-link-dialog .primary").disabled'))
    // 입력을 바꾼 뒤 늦게 도착한 과거 조회 결과를 표시하거나 연결하지 않는다.
    await evaluate('window.holdLookup=true')
    await inputId('active')
    await evaluate('document.querySelector(".ai-conversation-link-search button").click()')
    await waitFor(() => evaluate('typeof window.releaseLookup === "function"'), '지연 조회 준비 실패')
    await inputId('changed-id')
    await evaluate('window.releaseLookup();window.holdLookup=false')
    assert.ok(await evaluate('!document.querySelector(".ai-conversation-link-preview") && document.querySelector(".ai-conversation-link-dialog .primary").disabled'))
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await waitFor(() => evaluate('!document.querySelector(".ai-conversation-link-dialog")'), 'Escape 닫기 실패')
    assert.deepEqual(exceptions, [])
  } catch (error) {
    if (send && socket?.readyState === WebSocket.OPEN) {
      const capture = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
      if (capture) {
        const file = path.join(tmpdir(), `mnp-conversation-link-failed-${Date.now()}.png`)
        await writeFile(file, Buffer.from(capture.data, 'base64'))
        t.diagnostic(`실패 화면: ${file}`)
      }
    }
    throw error
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser.pid && browser.exitCode === null) { const exited = new Promise((resolve) => browser.once('exit', resolve)); browser.kill(); await exited }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('mnp-conversation-link-browser-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  }
}
