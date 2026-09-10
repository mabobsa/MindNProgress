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

export async function checkDoorayResponseBrowser({ directory, baseUrl, password, deleteConversation, complete = false }) {
  const profile = path.join(directory, complete ? 'browser-profile-completion' : 'browser-profile')
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
    assert.deepEqual(await evaluate(`(() => {
      const link = document.querySelector('.dooray-mentions-open');
      return { afterTime: link.previousElementSibling?.tagName, label: link.getAttribute('aria-label'),
        target: link.target, rel: link.rel, url: link.href, icon: Boolean(link.querySelector('svg')), text: link.textContent.trim() };
    })()`), { afterTime: 'TIME', label: 'Dooray에서 열기 (새 탭)', target: '_blank', rel: 'noreferrer noopener',
      url: 'https://nhnent.dooray.com/project/posts/post1#comment-comment1', icon: true, text: '' }, '시간 뒤의 아이콘은 원래 코멘트 URL을 새 탭으로 연다')
    assert.ok(await evaluate('Array.from(document.querySelectorAll(".dooray-response-actions button")).some(b => b.textContent === "대화에서 이어가기")'))
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".dooray-response-actions button"))[1]?.textContent'), '담당 카드로 전달하기')
    for (const [width, height] of [[1440, 1300], [1440, 720], [900, 480], [390, 640]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      const layout = await waitFor(() => evaluate(`(() => {
        const panel = document.querySelector('.dooray-mentions-panel').getBoundingClientRect();
        const close = document.querySelector('.dooray-mentions-close').getBoundingClientRect();
        const content = document.querySelector('.dooray-mentions-content');
        if (Math.abs(panel.height - (${height} - (${width} <= 640 ? 0 : 44))) > 2) return null;
        return { height: panel.height, top: panel.top, bottom: panel.bottom, right: panel.right, closeBottom: close.bottom,
          overflow: getComputedStyle(content).overflowY, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight };
      })()`))
      assert.ok(layout.top >= 0 && layout.bottom <= height + 1 && layout.right <= width + 1, JSON.stringify(layout))
      assert.ok(layout.closeBottom <= height, '닫기 버튼은 작은 화면에서도 보여야 한다')
      assert.equal(layout.overflow, 'auto')
      const openPosition = await evaluate(`(() => {
        const time = document.querySelector('.dooray-mentions-entry-time time').getBoundingClientRect();
        const link = document.querySelector('.dooray-mentions-open').getBoundingClientRect();
        return { gap: link.left - time.right, verticalOffset: Math.abs((link.top + link.bottom - time.top - time.bottom) / 2) };
      })()`)
      assert.ok(openPosition.gap >= 0 && openPosition.gap <= 8 && openPosition.verticalOffset <= 1, '작은 화면에서도 시간 바로 오른쪽에 아이콘을 유지한다')
      if (height === 1300) assert.ok(layout.height > 900, '기존 900px 상한보다 커져야 한다')
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
    if (!complete) {
      await evaluate('Array.from(document.querySelectorAll(".dooray-response-actions button")).find(b => b.textContent === "담당 카드로 전달하기").click()')
      await waitFor(() => evaluate('Boolean(document.querySelector(".dooray-response-handoff pre"))'))
      const handoffPrompt = await evaluate('document.querySelector(".dooray-response-handoff pre").textContent')
      assert.ok(handoffPrompt.length > 4000)
      const handoffState = await evaluate(`(() => {
        window.doorayPanelBeforeLaunch = document.querySelector('.dooray-mentions-panel');
        document.querySelector('.dooray-response-handoff details').open = true;
        const content = document.querySelector('.dooray-mentions-content');
        content.scrollTop = 120;
        return { scrollTop: content.scrollTop, conversation: document.querySelector('.dooray-response-handoff select').value };
      })()`)
      await evaluate('Array.from(document.querySelectorAll(".dooray-response-handoff button")).find(b => b.textContent === "담당 카드에 새 AI 대화").click()')
      await waitFor(() => evaluate('Boolean(document.querySelector(".ai-auto-request textarea"))'))
      assert.equal(await evaluate('document.querySelector(".ai-auto-request textarea").value'), handoffPrompt, '새 업무 대화에도 전문을 자르지 않고 전달한다')
      assert.equal(await evaluate('document.querySelector(".dooray-mentions-panel") === window.doorayPanelBeforeLaunch'), true, 'AI 옵션을 열어도 Dooray 참조 팝업은 그대로 유지한다')
      assert.equal(await evaluate('document.querySelector(".dooray-mentions-backdrop").inert'), true, 'AI 옵션 아래의 팝업은 입력을 받지 않는다')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await evaluate('document.querySelector(".dooray-mentions-backdrop").click()')
      assert.equal(await evaluate('document.querySelector(".dooray-mentions-panel") === window.doorayPanelBeforeLaunch'), true, 'AI 옵션이 열린 동안 Esc와 배경 클릭은 아래 팝업을 닫지 않는다')
      await evaluate('document.querySelector(\'button[aria-label="AI 대화 옵션 닫기"]\').click()')
      await waitFor(() => evaluate('!document.querySelector(".ai-dialog")'))
      assert.equal(await evaluate('document.querySelector(".dooray-mentions-panel") === window.doorayPanelBeforeLaunch'), true, 'AI 옵션을 닫아도 같은 팝업으로 돌아온다')
      assert.equal(await evaluate('document.querySelector(".dooray-mentions-backdrop").inert'), false)
      assert.equal(await evaluate('document.querySelector(".dooray-response-handoff details").open'), true, '전문 펼침 상태를 유지한다')
      assert.deepEqual(await evaluate(`({ scrollTop: document.querySelector('.dooray-mentions-content').scrollTop,
        conversation: document.querySelector('.dooray-response-handoff select').value })`), handoffState, '스크롤 위치와 담당 대화 선택을 유지한다')
    }
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
    if (complete) {
      await evaluate('document.querySelector(".dooray-response-toolbar button").click()')
      await waitFor(() => evaluate('Boolean(document.querySelector(".dooray-response-proposal"))'))
      await evaluate('Array.from(document.querySelectorAll(".dooray-response-actions button")).find(b => b.textContent === "담당 카드로 전달하기").click()')
      await waitFor(() => evaluate('document.querySelector(".dooray-response-handoff pre")?.textContent.includes("독립적으로 판단")'))
      assert.ok(await evaluate('document.querySelector(".dooray-response-handoff pre").textContent.includes("#comment-comment1")'))
      await evaluate('Array.from(document.querySelectorAll(".dooray-response-handoff button")).find(b => b.textContent === "선택한 대화로 전달").click()')
      await waitFor(() => evaluate('document.querySelector(".dooray-response-handoff")?.textContent.includes("전달했습니다.")'))
      await evaluate('Array.from(document.querySelectorAll(".dooray-response-actions button")).find(b => b.textContent === "대응 완료").click()')
      await waitFor(() => evaluate('document.querySelector(".dooray-response-request")?.textContent.includes("대응 완료")'))
      assert.equal(await evaluate('document.querySelector(".dooray-response-toolbar button").textContent.includes("1건")'), false)
      await evaluate('Array.from(document.querySelectorAll(".dooray-response-toolbar button")).find(b => b.textContent === "완료 내역 1건").click()')
      await waitFor(() => evaluate('document.querySelector(".dooray-response-proposal")?.textContent.includes("경계값")'))
      await deleteConversation?.()
      await send('Page.reload')
      await waitFor(() => evaluate(`Boolean(document.querySelector('button[aria-label="Dooray 참조"]'))`))
      await evaluate('document.querySelector(\'button[aria-label="Dooray 참조"]\').click()')
      await waitFor(() => evaluate('document.querySelector(".dooray-response-request")?.textContent.includes("대응 완료")'))
      assert.equal(await evaluate('document.querySelector(".dooray-response-toolbar button").textContent.includes("1건")'), false)
    } else if (deleteConversation) {
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
