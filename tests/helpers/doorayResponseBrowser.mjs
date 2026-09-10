import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(action) {
  let lastError
  for (let i = 0; i < 150; i++) {
    try { const result = await action(); if (result) return result } catch (error) { lastError = error }
    await delay(100)
  }
  throw lastError ?? new Error('브라우저 검증 대기 시간 초과')
}

export async function checkDoorayResponseBrowser({ directory, baseUrl, password, deleteConversation }) {
  const profile = path.join(directory, 'browser-profile')
  await mkdir(profile, { recursive: true })
  const child = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1440,1100', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let socket
  let send
  let spawnError
  child.on('error', (error) => { spawnError = error })
  try {
    const port = await waitFor(async () => { if (spawnError) throw spawnError; return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] })
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let sequence = 0
    const pending = new Map()
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const callback = pending.get(message.id)
      if (callback) {
        pending.delete(message.id)
        if (message.error) callback.reject(new Error(message.error.message))
        else callback.resolve(message.result)
      }
    }
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`브라우저 응답 시간 초과: ${method}`)) }, 10_000)
      timer.unref()
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result?.value
    }
    await send('Page.enable')
    await send('Page.navigate', { url: baseUrl })
    await waitFor(() => evaluate('document.readyState === "complete"'))
    assert.equal(await evaluate(`fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:'admin@mind.local',password:${JSON.stringify(password)}}) }).then(r => r.status)`), 200)
    await send('Page.reload')
    await waitFor(() => evaluate(`Boolean(document.querySelector('button[aria-label="Dooray 참조"]'))`))
    await evaluate('document.querySelector(\'button[aria-label="Dooray 참조"]\').click()')
    await waitFor(() => evaluate('Boolean(document.querySelector(".dooray-response-request"))'))
    await evaluate('document.querySelector(".dooray-response-request").click()')
    await waitFor(() => evaluate('document.querySelector(".dooray-response-proposal")?.textContent.includes("경계값")'))
    assert.equal(await evaluate('document.querySelector(".dooray-mentions-check input").checked'), false)
    assert.equal(await evaluate('document.querySelector(".dooray-response-target").textContent'), '홀덤 UI → 베팅')
    assert.ok(await evaluate('Array.from(document.querySelectorAll(".dooray-response-actions button")).some(b => b.textContent === "대화에서 이어가기")'))
    await evaluate('Array.from(document.querySelectorAll(".dooray-response-toolbar button")).find(b => b.textContent === "AI 설정").click()')
    await waitFor(() => evaluate('document.querySelector(".dooray-response-settings")?.textContent.includes("검증 모델")'))
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = path.join(tmpdir(), `mnp-dooray-response-ui-${Date.now()}.png`)
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    console.log(`Dooray 대응 UI 검증 화면: ${screenshotPath}`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(() => evaluate('!document.querySelector(".dooray-mentions-panel")'))
    await evaluate('document.querySelector(\'button[aria-label="Dooray 참조"]\').click()')
    await waitFor(() => evaluate('document.querySelector(".dooray-response-toolbar")?.textContent.includes("1건")'))
    if (deleteConversation) {
      await deleteConversation()
      await waitFor(() => evaluate('document.querySelector(".dooray-response-request")?.textContent.trim() === "AI 대응 제안"'))
      assert.equal(await evaluate('Boolean(document.querySelector(".dooray-response-proposal"))'), false)
      assert.equal(await evaluate('document.querySelector(".dooray-mentions-check input").checked'), false)
      assert.equal(await evaluate('document.querySelector(".dooray-response-toolbar").textContent.includes("1건")'), false)
    }
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) {
      void send('Browser.close').catch(() => {})
      await delay(600)
    }
    socket?.close()
    if (child.exitCode === null) { child.kill(); await delay(300) }
  }
}
