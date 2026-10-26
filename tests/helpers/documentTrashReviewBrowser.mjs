import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 임시 서버·문서·브라우저 프로필에서만 실제 탐색과 휴지통 이동을 실행한다.
export async function documentTrashReviewBrowser({ base, directory, api, create, archive, node }) {
  const source = await create('브라우저 휴지통 대상', [node('original', { label: '원본 카드', kind: 'root' })])
  const ref = (id, mapId = source.id) => node(id, { label: id, reference: { mapId, nodeId: 'original' } })
  const active = await create('활성 참조 위치', [ref('ref-active'), ref('ref-second')])
  const archived = await archive(await create('보관 참조 위치', [ref('ref-archived')]))
  const archiveTarget = await archive(await create('브라우저 보관 대상', [node('original', { label: '보관 원본', kind: 'root' })]))
  const archiveRef = await create('보관 대상 참조 위치', [ref('ref-archive-target', archiveTarget.id)])
  const profile = path.join(directory, 'trash-review-browser')
  const browser = spawn(process.env.MNP_BROWSER_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let socket; let command; let sequence = 0
  const pending = new Map(); const errors = []
  const until = async (check, message) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(message)
  }
  try {
    let port
    await until(async () => {
      try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0 } catch { return false }
    }, '임시 브라우저 시작 실패')
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const entry = pending.get(message.id)
        if (entry) { pending.delete(message.id); clearTimeout(entry.timer); if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result) }
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    })
    command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('브라우저 응답 시간 초과: ' + method)) }, 15000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const button = (text, scope = '.document-trash-review') => `[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent === ${JSON.stringify(text)})`
    const click = (text, scope) => evaluate(`${button(text, scope)}.click()`)
    const row = (id) => `[...document.querySelectorAll('.document-trash-review-list button')].find(b=>b.querySelector('strong').textContent === ${JSON.stringify(id)})`
    const selected = (mapId, cardId) => `location.pathname === '/mindmap/${mapId}/${cardId}' && document.querySelector('.react-flow__node.selected[data-id="${cardId}"]') !== null`
    const title = 'document.querySelector(".document-trash-review-target > strong")?.textContent'
    const rect = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`)
    const boundsFit = async () => until(() => evaluate(`(() => {
      const r = document.querySelector('.document-trash-review').getBoundingClientRect();
      const f = document.querySelector('.document-trash-review > footer').getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && f.bottom <= r.bottom;
    })()`), '팝업과 이동 버튼이 화면 안에 유지되지 않습니다.')
    await command('Runtime.enable'); await command('Page.enable')
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await command('Page.navigate', { url: base })
    await until(() => evaluate(`location.origin === ${JSON.stringify(base)} && document.readyState === 'complete'`).catch(() => false), '페이지 로딩 실패')
    assert.equal(await evaluate(`fetch('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'reconstruction-test@mind.local',password:'TestOnly!2026'})}).then(r=>r.status)`), 200)
    await command('Page.navigate', { url: `${base}/mindmap/${source.id}/original` })
    await until(() => evaluate(`document.querySelector('[data-library-menu-id="${source.id}"]') !== null`), '휴지통 대상 문서 표시 실패')
    await evaluate(`document.querySelector('[data-library-menu-id="${source.id}"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:150,clientY:200}))`)
    const trashMenuButton = `[...document.querySelectorAll('[role=menu] button')].find(b=>b.textContent.includes('휴지통으로 이동'))`
    await until(() => evaluate(`${trashMenuButton} !== undefined`), '휴지통 우클릭 메뉴 표시 실패')
    await evaluate(`${trashMenuButton}.click()`)
    await until(() => evaluate(`${title} === '브라우저 휴지통 대상'`), '참조 확인 팝업 표시 실패')
    assert.equal(await evaluate('document.querySelectorAll(".document-trash-review-list li").length'), 3)
    assert.equal(await evaluate('document.querySelector(".document-trash-review").getAttribute("aria-modal")'), 'false')
    assert.equal((await api(`/api/maps/${source.id}`)).status, 200, '팝업만 열어서는 휴지통 이동하지 않는다')
    // 실제 포인터 입력으로 드래그한다.
    const beforeDrag = await rect('.document-trash-review')
    const header = await rect('.document-trash-review > header')
    const x = header.x + 150; const y = header.y + header.height / 2
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 300, y: y + 140, button: 'left', buttons: 1 })
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 300, y: y + 140, button: 'left', clickCount: 1 })
    assert.ok((await rect('.document-trash-review')).left < beforeDrag.left - 100, '제목 표시줄 드래그로 이동한다')
    await boundsFit()
    // 바깥 클릭·ESC·문서 전환으로 닫히지 않는다.
    await evaluate(`document.body.dispatchEvent(new MouseEvent('pointerdown', {bubbles:true})); document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`)
    await evaluate(`${row('ref-active')}.click()`)
    await until(() => evaluate(selected(active.id, 'ref-active')), '활성 문서 Ref 카드 선택 실패')
    assert.equal(await evaluate(title), source.title)
    assert.equal(await evaluate(`${row('ref-active')}.textContent.includes('방문함')`), true)
    await evaluate(`${row('ref-archived')}.click()`)
    await until(() => evaluate(selected(archived.id, 'ref-archived')), '보관 문서 Ref 카드 선택 실패')
    assert.equal(await evaluate('document.body.innerText.includes("보관 문서 (읽기 전용)")'), true)
    assert.equal(await evaluate(title), source.title)
    await click('대상 문서로 돌아가기')
    await until(() => evaluate(`location.pathname.includes('${source.id}')`), '대상 문서로 복귀 실패')
    // 새로고침 실패를 참조 없음으로 처리하거나 삭제를 허용하지 않는다.
    const previewUrl = `/api/maps/${source.id}/trash-preview`
    await evaluate(`window.originalFetch = window.fetch; window.fetch = (...args) => args[0] === ${JSON.stringify(previewUrl)} ? Promise.reject(new Error('참조 조회 시험 실패')) : window.originalFetch(...args)`)
    await click('새로고침')
    await until(() => evaluate('document.querySelector(".document-trash-review-error")?.textContent.includes("참조 조회 시험 실패")'), '조회 실패 표시 없음')
    assert.equal(await evaluate('document.querySelector(".document-trash-review-delete").disabled'), true)
    await evaluate('window.fetch = window.originalFetch')
    await click('새로고침')
    await until(() => evaluate('!document.querySelector(".document-trash-review-delete").disabled'), '재조회 뒤 이동 버튼 복구 실패')
    const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-trash-review-screenshots-'))
    const capture = async (name) => {
      const image = await command('Page.captureScreenshot', { format: 'png' })
      await writeFile(path.join(artifactDirectory, name), Buffer.from(image.data, 'base64'))
    }
    await capture('desktop.png')
    await evaluate('document.querySelector(".theme-switch").click()')
    await capture('alternate-theme.png')
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
    await boundsFit(); await capture('mobile.png')
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    // 다른 문서를 보고 있어도 최초 대상만 이동하며, 중간에 생긴 참조는 재확인한다.
    await evaluate(`${row('ref-active')}.click()`)
    await until(() => evaluate(selected(active.id, 'ref-active')), '이동 전 참조 문서 탐색 실패')
    await create('늦게 추가된 참조 위치', [ref('ref-late')])
    await evaluate('document.querySelector(".document-trash-review-delete").click()')
    await until(() => evaluate('document.querySelector(".document-trash-review-error")?.textContent.includes("변경되었습니다")'), '새 참조 추가 후 재확인하지 않음')
    assert.equal(await evaluate('document.querySelectorAll(".document-trash-review-list li").length'), 4)
    assert.equal((await api(`/api/maps/${source.id}`)).status, 200)
    await evaluate('document.querySelector(".document-trash-review-delete").click()')
    await until(() => evaluate('document.querySelector(".document-trash-review-notice")?.textContent.includes("휴지통으로 이동했습니다")'), '대상 휴지통 이동 실패')
    assert.equal((await api('/api/maps/trash')).body.maps.some((map) => map.id === source.id), true)
    assert.equal((await api(`/api/maps/${active.id}`)).status, 200)
    assert.equal(await evaluate(title), source.title, '이동 후에도 명시적으로 닫기 전까지 팝업 유지')
    await click('닫기')
    // 보관함의 이동 버튼도 같은 팝업을 연다.
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("보관함 · 문서 재구성")).click()')
    const archiveArticle = `[...document.querySelectorAll('.lifecycle-dialog article')].find(a=>a.querySelector('.lifecycle-link')?.textContent === '브라우저 보관 대상')`
    await until(() => evaluate(`Boolean(${archiveArticle})`), '보관함 대상 표시 실패')
    await evaluate(`[...${archiveArticle}.querySelectorAll('button')].find(b=>b.textContent === '휴지통으로 이동').click()`)
    await until(() => evaluate(`${title} === '브라우저 보관 대상'`), '보관함에서 참조 확인 팝업 열기 실패')
    assert.equal(await evaluate('document.querySelector(".lifecycle-dialog") === null'), true)
    await evaluate(`${row('ref-archive-target')}.click()`)
    await until(() => evaluate(selected(archiveRef.id, 'ref-archive-target')), '보관 대상 참조 카드 이동 실패')
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
    await boundsFit(); await capture('archive-mobile.png')
    await evaluate('document.querySelector(".document-trash-review-delete").click()')
    await until(() => evaluate('document.querySelector(".document-trash-review-notice") !== null'), '보관 문서 휴지통 이동 실패')
    assert.equal((await api('/api/maps/trash')).body.maps.some((map) => map.id === archiveTarget.id && map.archivedAt), true)
    assert.deepEqual(errors, [], '브라우저 실행 오류 없음')
    return { artifactDirectory, checked: ['일반·보관 진입', '모든 Ref 목록', '드래그', '활성·보관 카드 선택', '방문 표시', '외부 클릭·탐색 후 유지', '대상 문서 복귀', '조회 실패 차단', '참조 변경 재확인', '최초 대상만 이동', '밝은·어두운 테마', '모바일 화면 경계'] }
  } catch (error) {
    if (command && socket?.readyState === WebSocket.OPEN) {
      const diagnostic = await command('Runtime.evaluate', { expression: '({url:location.pathname,panel:document.querySelector(".document-trash-review")?.getBoundingClientRect().toJSON(),footer:document.querySelector(".document-trash-review > footer")?.getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight],text:document.body.innerText.slice(-5000)})', returnByValue: true }).catch(() => null)
      console.error('참조 팝업 검증 실패:', diagnostic?.result?.value, errors)
    }
    throw error
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer)
    if (command && socket?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => {})
    socket?.close()
    if (browser.exitCode === null) { const exited = new Promise((resolve) => browser.once('exit', resolve)); browser.kill(); await exited }
  }
}
