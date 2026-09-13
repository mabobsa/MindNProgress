import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { touchMenuBrowser } from './touchMenuBrowser.mjs'

// 실제 사용자 세션 및 AI는 사용하지 않고 격리된 서버·브라우저에서 검증한다.
export async function cardLayoutBrowser({ base, directory, mapId, api, submit }) {
  const profile = path.join(directory, 'browser-profile')
  const browser = spawn(process.env.MNP_BROWSER_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let socket; let command; let sequence = 0; const pending = new Map(); const errors = []
  const until = async (check, message) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
    throw new Error(message)
  }
  try {
    let port
    await until(async () => { try { const content = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); if (!/^\d{4,5}\r?\n\/devtools\//.test(content)) return false; port = Number(content.split('\n')[0]); return port > 0 } catch { return false } }, '브라우저 시작 실패')
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) { const entry = pending.get(message.id); if (entry) { pending.delete(message.id); clearTimeout(entry.timer); if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result) } }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    })
    command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 시간 초과: ' + method)) }, 15000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const click = (text, scope = '.card-layout-dialog') => evaluate(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`)
    const escape = async () => { for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }) }
    await command('Runtime.enable'); await command('Page.enable')
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await command('Page.navigate', { url: base })
    await until(() => evaluate(`location.origin===${JSON.stringify(base)} && document.readyState==='complete'`).catch(() => false), '페이지 로딩 실패')
    assert.equal(await evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'layout-test@mind.local',password:'TestOnly!2026'})}).then(r=>r.status)`), 200)
    if (process.env.MNP_TOUCH_MENU_BROWSER === '1') {
      const touchMenus = await touchMenuBrowser({ base, command, evaluate, until, api })
      assert.deepEqual(errors, [], '브라우저 예외 없음')
      return { touchMenus }
    }
    await command('Page.navigate', { url: `${base}/mindmap/${mapId}/root` })
    await until(() => evaluate('document.querySelector(".react-flow__node[data-id=root] .mind-node") !== null'), '문서 카드 로딩 실패')
    const typography = (scope) => evaluate(`(() => { const n=document.querySelector(${JSON.stringify(scope + ' .react-flow__node[data-id=root] .mind-node')});return [n,...n.querySelectorAll('h3,p')].map(e=>{const s=getComputedStyle(e);return {tag:e.tagName,size:s.fontSize,line:s.lineHeight,weight:s.fontWeight}})})()`)
    const mainTypography = await typography('.app-shell')
    const open = async () => {
      await until(() => evaluate('[...document.querySelectorAll(".map-item")].some(e=>e.textContent.includes("배치 검증 문서"))'), '문서 행 없음')
      await evaluate(`(()=>{const row=[...document.querySelectorAll('.map-item')].find(e=>e.textContent.includes('배치 검증 문서'));row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:140,clientY:320}));})()`)
      await until(() => evaluate('document.querySelector("[role=menu]")?.innerText.includes("AI 배치 제안")'), '우클릭 배치 메뉴 없음')
      await evaluate('[...document.querySelectorAll("[role=menu] button")].find(b=>b.textContent.includes("AI 배치 제안")).click()')
      await until(() => evaluate('document.querySelector(".card-layout-dialog") !== null'), '배치 팝업 없음')
    }
    await open()
    await evaluate('document.activeElement?.blur()'); await escape()
    await until(() => evaluate('document.querySelector(".card-layout-dialog") === null'), '포커스 밖 ESC 닫기 실패')
    await open()
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".card-layout-dialog h2")).fontSize'), '15px')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".card-layout-dialog button")).fontSize'), '9px')
    const before = (await api(`/api/maps/${mapId}`)).body.map
    const create = async () => {
      await until(() => evaluate('[...document.querySelectorAll(".card-layout-dialog button")].some(b=>b.textContent==="새 배치 제안 요청" && !b.disabled)'), '새 요청 버튼 준비 실패')
      await click('새 배치 제안 요청')
      await until(async () => {
        assert.deepEqual(await evaluate('[...document.querySelectorAll(".card-layout-dialog [role=alert]")].map(e=>e.textContent)'), [], '카드 크기 측정 오류')
        return evaluate('document.querySelector(".card-layout-dialog")?.innerText.includes("실제 크기를 확인했습니다.")')
      }, '실제 카드·이미지 크기 측정 실패')
      const list = (await api(`/api/card-layouts?mapId=${mapId}`)).body.requests
      return list.find((r) => r.state === 'open').id
    }
    let requestId = await create()
    assert.deepEqual(await typography('.card-layout-dialog'), mainTypography, '관리 팝업의 스타일이 실제 카드 글꼴에 영향을 주지 않는다')
    assert.equal(await evaluate('document.querySelectorAll(".card-layout-dialog .mind-image-node").length'), 1)
    assert.equal(await evaluate('document.querySelectorAll(".card-layout-dialog .dooray-task-node").length'), 1)
    assert.equal(await evaluate('document.querySelector(".card-layout-dialog .react-flow__node[data-id=ref]").innerText.includes("현재 참조된 지식")'), true, 'Ref는 원본의 최신 표시 내용으로 측정한다')
    await click('AI 선택·시작')
    await until(() => evaluate('document.querySelector(".ai-dialog") !== null'), '기존 AI 선택 화면 연결 실패')
    await escape()
    assert.equal(await evaluate('document.querySelector(".card-layout-dialog") !== null'), true, 'AI 옵션이 열린 동안 부모 ESC 방지')
    await evaluate('document.querySelector("button[aria-label=\\"AI 대화 옵션 닫기\\"]").click()')
    const verified = async () => {
      await until(async () => {
        const alerts = await evaluate('[...document.querySelectorAll(".card-layout-dialog [role=alert]")].map(e=>e.textContent)')
        assert.deepEqual(alerts, [], '배치 실측 오류')
        return evaluate('document.querySelector(".card-layout-dialog")?.innerText.includes("카드 크기와 겹침 검증을 통과했습니다.") && document.querySelector(".card-layout-approval input")?.disabled === false')
      }, '실제 미리보기 검증 실패')
    }
    const preview = async (id) => {
      await submit(id)
      await until(() => evaluate('[...document.querySelectorAll(".card-layout-dialog button")].some(b=>b.textContent==="배치 미리보기")'), 'MCP 제안 자동 수신 실패')
      await click('배치 미리보기')
      await verified()
    }
    const nodePositions = () => evaluate('Object.fromEntries([...document.querySelectorAll(".card-layout-dialog .react-flow__node")].map(e=>{const m=new DOMMatrix(getComputedStyle(e).transform);return [e.dataset.id,{x:m.e,y:m.f}]}))')
    const selectCandidate = async (index) => {
      const previous = await nodePositions()
      await evaluate('document.querySelector(".card-layout-approval input").click()')
      await evaluate(`document.querySelectorAll('.card-layout-candidates button')[${index}].click()`)
      assert.equal(await evaluate('document.querySelector(".card-layout-approval input")?.checked===true'), false, '후보 변경 시 이전 확인 해제')
      await verified()
      assert.notDeepEqual(await nodePositions(), previous, '순서만 바꾸지 않고 실제 형태 변경')
      assert.equal(await evaluate('document.querySelector(".card-layout-approval input").checked'), false)
    }
    const selectTarget = async (ratio) => {
      if (await evaluate('document.querySelector("select[aria-label=\\"목표 캔버스\\"]").value') === ratio) return
      await evaluate('document.querySelector(".card-layout-approval input").click()')
      await evaluate(`(()=>{const s=document.querySelector('select[aria-label="목표 캔버스"]');s.value='${ratio}';s.dispatchEvent(new Event('change',{bubbles:true}));})()`)
      assert.equal(await evaluate('document.querySelector(".card-layout-approval input")?.checked===true'), false, '목표 변경 시 이전 확인 해제')
      await verified()
      assert.equal(await evaluate('document.querySelector(".card-layout-approval input").checked'), false)
      assert.ok((await evaluate('document.querySelector(".card-layout-fit").innerText')).includes(`목표 ${ratio}`))
    }
    const frameRatio = async () => {
      const ratio = await evaluate('(()=>{const r=document.querySelector(".card-layout-screen").getBoundingClientRect();return r.width/r.height})()')
      const selected = await evaluate('document.querySelector("select[aria-label=\\"목표 캔버스\\"]").value')
      const [width, height] = selected.split(':').map(Number)
      assert.ok(Math.abs(ratio - width / height) < 0.02, `휴대폰·데스크톱 모두 선택한 ${selected} 미리보기`)
      assert.equal(await evaluate('(()=>{const r=document.querySelector(".card-layout-screen").getBoundingClientRect();const f=document.querySelector(".card-layout-footer").getBoundingClientRect();return r.top>=0 && r.bottom<=f.top+1 && r.bottom<=innerHeight})()'), true, '미리보기 전체가 화면에 들어오고 적용 영역에 가리지 않는다')
      assert.equal(await evaluate('(()=>{const r=document.querySelector(".card-layout-screen").getBoundingClientRect();return [...document.querySelectorAll(".card-layout-screen .react-flow__node")].every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left-1 && b.right<=r.right+1 && b.top>=r.top-1 && b.bottom<=r.bottom+1})})()'), true, '전체 카드가 미리보기 안에 표시된다')
    }
    const actualZoom = async () => {
      const read = () => evaluate('(()=>{const e=document.querySelector("[data-preview-zoom]");const m=new DOMMatrix(getComputedStyle(document.querySelector(".card-layout-screen .react-flow__viewport")).transform);return {actual:m.a,reported:Number(e?.dataset.previewZoom),text:e?.textContent}})()')
      await until(async () => { const z = await read(); return z.actual > 0 && Math.abs(z.actual - z.reported) < 0.00001 && z.text === `${(z.reported * 100).toFixed(1)}%` }, '표시 확대율과 실제 카메라 확대율 불일치')
      return (await read()).reported
    }
    await preview(requestId)
    assert.equal(await evaluate('document.querySelector("select[aria-label=\\"목표 캔버스\\"]").value'), '16:9')
    assert.deepEqual(await evaluate('[...document.querySelector("select[aria-label=\\"목표 캔버스\\"]").options].map(o=>o.value)'), ['4:3', '16:9', '21:9'])
    assert.ok(await evaluate('document.querySelectorAll(".card-layout-candidates button").length>=2'))
    await frameRatio()
    await selectCandidate(1)
    await selectTarget('4:3')
    assert.deepEqual((await api(`/api/maps/${mapId}`)).body.map, before, '제안·미리보기는 원본 불변')
    assert.equal(await evaluate('[...document.querySelectorAll(".card-layout-dialog button")].find(b=>b.textContent==="확인한 배치 적용").disabled'), true)
    const artifacts = await mkdtemp(path.join(tmpdir(), 'mnp-layout-screenshots-'))
    const screenshot = async (name) => { const result = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(artifacts, name), Buffer.from(result.data, 'base64')) }
    const ratioChecks = []
    for (const ratio of ['4:3', '16:9', '21:9']) {
      await selectTarget(ratio)
      const expected = await nodePositions(); const zooms = []
      for (const device of [{ name: 'fhd', width: 1920, height: 1080, mobile: false }, { name: 'qhd', width: 2560, height: 1440, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
        await command('Emulation.setDeviceMetricsOverride', { width: device.width, height: device.height, deviceScaleFactor: 1, mobile: device.mobile })
        await new Promise((resolve) => setTimeout(resolve, 400))
        await frameRatio(); zooms.push(await actualZoom())
        assert.deepEqual(await nodePositions(), expected, `${ratio}: ${device.name}에서도 좌표 불변`)
        await screenshot(`preview-${ratio.replace(':', '-')}-${device.name}.png`)
      }
      assert.notEqual(zooms[0], zooms[2], '동일 배치라도 화면에 맞춘 실제 확대율은 다르다')
      ratioChecks.push({ ratio, zooms })
      await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    const beforeZoom = await actualZoom(); const positionsBeforeZoom = await nodePositions()
    await evaluate('document.querySelector(".card-layout-screen .react-flow__controls-zoomin").click()')
    await until(async () => (await actualZoom()) > beforeZoom, '확대 조작이 현재 확대율에 반영되지 않음')
    assert.deepEqual(await nodePositions(), positionsBeforeZoom, '확대는 카드 배치를 바꾸지 않는다')
    await evaluate('document.querySelector(".card-layout-screen .react-flow__controls-fitview").click()')
    await new Promise((resolve) => setTimeout(resolve, 400))
    await screenshot('preview-light.png')
    const light = await evaluate('getComputedStyle(document.querySelector(".card-layout-dialog")).backgroundColor')
    await evaluate('document.querySelector("button[aria-label^=\\"화면 테마:\\"]").click()')
    await until(() => evaluate(`getComputedStyle(document.querySelector('.card-layout-dialog')).backgroundColor!==${JSON.stringify(light)}`), '어두운 테마 반영 실패')
    await screenshot('preview-dark.png')
    const desktopPositions = await nodePositions()
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    await screenshot('preview-mobile.png')
    await frameRatio()
    assert.deepEqual(await nodePositions(), desktopPositions, '휴대폰으로 전환해도 배치 좌표 불변')
    assert.equal(await evaluate('(()=>{const e=document.querySelector(".card-layout-dialog"),r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && e.scrollWidth<=e.clientWidth+1})()'), true, '좁은 화면 가로 넘침 없음')
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await evaluate('document.querySelector("button[aria-label^=\\"화면 테마:\\"]").click()')
    await evaluate('document.querySelector(".card-layout-approval input").click()')
    await click('현재 배치')
    assert.equal(await evaluate('document.querySelector(".card-layout-approval input").checked'), false, '비교 화면 변경 시 승인 초기화')
    assert.equal(await evaluate('document.querySelector(".card-layout-approval input").disabled'), true, '현재 배치에서 적용 승인 금지')
    await click('제안 취소')
    assert.deepEqual((await api(`/api/maps/${mapId}`)).body.map, before, '취소는 원본 불변')
    requestId = await create(); await preview(requestId)
    await selectTarget('4:3')
    await selectCandidate(1)
    // 실제 브라우저가 검증받은 좌표와 최종 저장 좌표를 비교한다.
    const expected = await nodePositions()
    await evaluate('document.querySelector(".card-layout-approval input").click()'); await click('확인한 배치 적용')
    await until(() => evaluate('document.querySelector(".card-layout-dialog") === null'), '승인한 배치 저장 실패')
    const saved = (await api(`/api/maps/${mapId}`)).body.map
    const applied = (await api(`/api/card-layouts/${requestId}`)).body
    assert.deepEqual(applied.appliedLayout.target, { ratio: '4:3' })
    assert.notEqual(applied.appliedLayout.variant, 'balanced', '사용자가 마지막 확인한 후보 저장')
    for (const node of saved.nodes) { assert.ok(Math.abs(node.position.x - expected[node.id].x) < 0.01); assert.ok(Math.abs(node.position.y - expected[node.id].y) < 0.01) }
    const touchMenus = await touchMenuBrowser({ base, command, evaluate, until, api })
    assert.deepEqual(errors, [], '브라우저 예외 없음')
    return { artifacts, ratioChecks, cardCount: saved.nodes.length, typography: mainTypography, actualPreviewPositionsSaved: true, touchMenus }
  } finally {
    if (command && socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close') } catch { /* 종료 중 연결 종료 */ } }
    socket?.close(); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('브라우저 종료')) }
    if (browser.exitCode === null) { const done = new Promise((resolve) => browser.once('exit', resolve)); browser.kill(); await done }
  }
}
