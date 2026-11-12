import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { storageApi } from './helpers/storage-api-harness.mjs'

// npm run build 후 실행한다. 실제 문서·계정 대신 격리 서버와 별도 브라우저 프로필만 사용한다.
test('그룹의 추가 버튼으로 문서를 생성하고 소속·중복 방지·취소·실패 상태를 보존한다', {
  skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 90_000,
}, async (t) => {
  const server = await storageApi(t, { documents: 1 })
  const api = async (route, method = 'GET', body) => {
    const response = await server.call(route, method, body)
    assert.ok(response.status < 300, JSON.stringify(response.body))
    return response.body
  }
  const sourceId = server.ids[0]
  const groups = [{ id: 'group-create-a', name: '개발 문서', mapIds: [sourceId] }, { id: 'group-create-b', name: '빈 그룹', mapIds: [] }]
  await api('/api/maps/layout', 'PATCH', { documentLayout: { version: 1, groups, items: groups.map(({ id }) => ({ type: 'group', id })) } })
  await api('/api/groups/group-create-a', 'PATCH', { baseVersion: 0, coordinatorMapId: sourceId, objective: '기존 그룹 기준 보존' })
  const original = await api(`/api/maps/${sourceId}`)
  const project = (await api('/api/groups/group-create-a')).project
  const profile = await mkdtemp(path.join(tmpdir(), 'mnp-group-create-browser-'))
  const browser = spawn(process.env.MNP_BROWSER_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let socket, command
  const pending = new Map(), errors = []
  t.after(async () => {
    if (command && socket?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => {})
    socket?.close()
    if (browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    for (const entry of pending.values()) clearTimeout(entry.timer)
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(tmpdir()))
    assert.match(path.basename(profile), /^mnp-group-create-browser-/)
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const until = async (check, message) => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
    throw Error(message)
  }
  let port
  await until(async () => { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return Boolean(port) } catch { return false } }, '브라우저 준비 실패')
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), entry = pending.get(message.id)
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); if (message.error) entry.reject(Error(message.error.message)); else entry.resolve(message.result) }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  }
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method)) }, 10000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = async (selector, value) => {
    await evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  }
  const groupSelector = id => `[data-library-menu-kind="group"][data-library-menu-id="${id}"]`
  const add = id => `${groupSelector(id)} button[title="새 마인드맵 추가"]`
  const input = '.new-map-form input'
  const navigate = async id => {
    await command('Page.navigate', { url: `${server.base}/mindmap/${id}` })
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(add(groups[0].id))}))`).catch(() => false), '문서 목록 준비 실패')
  }
  await command('Runtime.enable')
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await command('Page.navigate', { url: server.base })
  await until(() => evaluate(`location.origin === ${JSON.stringify(server.base)} && document.readyState === 'complete'`).catch(() => false), '초기 화면 준비 실패')
  assert.equal(await evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'isolated@mind.local',password:'IsolatedOnly!2026'})}).then(r=>r.status)`), 200)
  await navigate(sourceId)
  const center = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(groupSelector(groups[0].id))}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`)
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...center })
  await until(() => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(groupSelector(groups[0].id) + ' .document-group-actions')})).opacity === '1'`), '마우스 오버 시 추가 버튼 표시')
  await click(add(groups[0].id))
  await until(() => evaluate('Boolean(document.querySelector(".document-group-items .group-new-map-form input"))'), '그룹 아래 입력란 표시')
  assert.equal(await evaluate('document.activeElement === document.querySelector(".new-map-form input")'), true)
  assert.equal(await evaluate('document.querySelector(".new-map-form button[type=submit]").disabled'), true)
  await fill(input, '취소할 문서')
  await click('.new-map-form button[type=button]')
  assert.equal((await api('/api/maps')).maps.length, 1)
  await click(add(groups[0].id))
  await fill(input, '그룹에서 바로 생성')
  // 응답 대기 중 연속 제출에도 생성 요청은 한 번만 보낸다.
  await evaluate(`window.originalFetch=window.fetch.bind(window);window.createPosts=0;window.fetch=async (url,init={})=>{if(String(url).endsWith('/documents')&&init.method==='POST'){window.createPosts++;await new Promise(resolve=>window.releaseCreate=resolve);}return window.originalFetch(url,init);};document.querySelector('.new-map-form').requestSubmit();document.querySelector('.new-map-form').requestSubmit();`)
  await until(() => evaluate('Boolean(window.releaseCreate)'), '생성 요청 대기')
  assert.equal(await evaluate('window.createPosts'), 1)
  assert.equal(await evaluate('document.querySelector(".new-map-form button[type=submit]").disabled'), true)
  const screenshot = await command('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = path.join(tmpdir(), 'mnp-group-create.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  t.diagnostic(`화면 확인: ${screenshotPath}`)
  await evaluate('window.releaseCreate();window.fetch=window.originalFetch')
  await until(() => evaluate('!document.querySelector(".new-map-form")'), '생성 완료 후 입력란 닫기')
  const library = await api('/api/maps'), created = library.maps.find(map => map.title === '그룹에서 바로 생성')
  assert.ok(created)
  assert.deepEqual(library.documentLayout.groups[0].mapIds, [sourceId, created.id])
  assert.equal(library.documentLayout.items.some(item => item.id === created.id), false)
  await until(() => evaluate(`Boolean(document.querySelector('.map-item.active[data-library-menu-id="${created.id}"]'))`), '생성된 그룹 문서로 이동')
  assert.deepEqual(await api(`/api/maps/${sourceId}`), original, '기존 문서 원문 보존')
  assert.deepEqual((await api('/api/groups/group-create-a')).project, project, '그룹 기준과 총괄 지정 보존')
  await navigate(created.id)
  assert.equal(await evaluate(`Boolean(document.querySelector('.document-group-items [data-library-menu-id="${created.id}"]'))`), true, '새로고침 뒤 그룹 소속 유지')

  // 실패하면 입력값을 유지하고, 일반 생성으로 바꾸면 이전 그룹을 따라가지 않는다.
  await click(add(groups[1].id))
  await fill(input, '실패 확인')
  await evaluate(`window.originalFetch=window.fetch.bind(window);window.fetch=(url,init={})=>String(url).endsWith('/documents')&&init.method==='POST'?Promise.resolve(new Response(JSON.stringify({error:'시험용 생성 거부'}),{status:409,headers:{'Content-Type':'application/json'}})):window.originalFetch(url,init);document.querySelector('.new-map-form').requestSubmit();`)
  await until(() => evaluate('document.querySelector(".save-error")?.textContent.includes("시험용 생성 거부")'), '생성 실패 표시')
  assert.equal(await evaluate('document.querySelector(".new-map-form input").value'), '실패 확인')
  assert.equal((await api('/api/maps')).maps.length, 2)
  await evaluate('window.fetch=window.originalFetch')
  await click('button[aria-label="새 마인드맵"]')
  assert.equal(await evaluate('document.querySelector(".new-map-form input").value'), '')
  await fill(input, '그룹 없는 문서')
  await click('.new-map-form button[type=submit]')
  await until(() => evaluate('!document.querySelector(".new-map-form")'), '일반 문서 생성 완료')
  const topLibrary = await api('/api/maps'), top = topLibrary.maps.find(map => map.title === '그룹 없는 문서')
  assert.ok(topLibrary.documentLayout.items.some(item => item.type === 'map' && item.id === top.id))
  assert.equal(topLibrary.documentLayout.groups.some(group => group.mapIds.includes(top.id)), false)
  await click(add(groups[1].id))
  await fill(input, '빈 그룹 첫 문서')
  await click('.new-map-form button[type=submit]')
  await until(() => evaluate('!document.querySelector(".new-map-form")'), '빈 그룹 생성 완료')
  const emptyLibrary = await api('/api/maps'), first = emptyLibrary.maps.find(map => map.title === '빈 그룹 첫 문서')
  assert.deepEqual(emptyLibrary.documentLayout.groups[1].mapIds, [first.id])
  assert.deepEqual(errors, [], '브라우저 예외 없음')
})
