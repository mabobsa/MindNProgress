// npm run build 후 실행. 실제 API·계정·AI 대신 메모리 fixture와 별도 브라우저 프로필만 사용한다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dist = path.resolve(import.meta.dirname, '../dist')
const directory = await mkdtemp(path.join(tmpdir(), 'mnp-group-ui-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message) {
  for (let attempt = 0; attempt < 160; attempt++) { if (await check()) return; await pause(100) }
  throw new Error(message)
}
const titles = ['공통 구조와 화면 이동', '로비와 입장', '테이블 화면', '게임 진행', '베팅 입력', '팝업과 안내', '결과와 정산', '통합 검수']
const rootData = (title) => ({ label: title, kind: 'root', isWork: true, status: 'in-progress', progress: 30, description: `담당 범위: ${title}\n기획서의 화면·상태·예외 조건을 확인하고 검증 근거를 남깁니다.\n${'상세 요구사항과 기존 결과를 대조합니다.\n'.repeat(30)}`, sharedKnowledge: '공통 기준을 먼저 확인합니다.\n검증 근거는 원문 카드에 보관합니다.', aiConversationId: 'fixture-conversation' })
const makeDocument = (id, title, state = 'idle') => ({ id, title, version: 7, root: { id: `root-${id}`, data: rootData(title) }, runtime: { state, pendingConfirmations: state === 'waiting-confirmation' ? 1 : 0 }, work: { total: 12, done: 4, waiting: 0 } })
const coordinator = makeDocument('coordinator', '통합 관리', 'running')
const documents = titles.map((title, index) => makeDocument(`doc-${index}`, title, index === 2 ? 'running' : index === 3 ? 'waiting-confirmation' : 'idle'))
const makeDelegation = (mapId, state, extra = {}) => ({ id: `delegation-${mapId}`, mapId, targetCardId: `root-${mapId}`, targetCardLabel: documents.find((d) => d.id === mapId)?.title ?? '이전 문서', state, displayState: state, instructionPreview: '승인받은 계획에 따라 담당 범위를 점검하고 남은 업무만 수행하세요.', createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T01:00:00Z', recovery: { recoveryAvailable: false }, ...extra })
let context = {
  group: { id: 'group-test', name: 'JP-매니저', mapIds: ['coordinator', ...documents.map((d) => d.id)] },
  project: { version: 3, coordinatorMapId: 'coordinator', source: 'https://example.test/spec/v0.4', sourceVersion: 'v0.4', objective: '클라이언트 영역의 기획 요구사항을 구현한다.\n더미 UI와 더미 데이터를 이용하여 Play 가능하도록 개발한다.', instructions: '렌더링된 기획 시안을 직접 확인한다.\n사용자 승인 후 실행한다.\n' + '화면 구조, 상태, 문구, 색상과 배치를 확인한다.\n'.repeat(20) },
  coordinator, documents: [coordinator, ...documents], guide: { coordinator: '' },
  delegations: [
    makeDelegation('doc-0', 'waiting-usage-limit', { childError: '사용량 제한으로 대기 중입니다.', recovery: { recoveryAvailable: true }, result: '첫 화면 구현 결과를 보존했습니다. 남은 검수가 필요합니다.\n' + '완료된 작업을 반복하지 않습니다.\n'.repeat(45), attemptHistory: [{ at: '2026-09-09T23:00:00Z', reason: 'usage-limit', childError: '이전 제한 오류', result: '보존된 이전 결과' }] }),
    makeDelegation('doc-0', 'failed', { id: 'older-doc-0', createdAt: '2026-09-09T00:00:00Z', result: '이전 위임 결과 원문' }),
    makeDelegation('doc-1', 'parent-wake-failed', { workCompleted: true, reportPending: true, recovery: { recoveryAvailable: false, reportRetryAvailable: true }, result: '문서 검수를 마쳤습니다. 총괄 보고만 남았습니다.' }),
    makeDelegation('doc-2', 'running-child'), makeDelegation('doc-4', 'completed', { workCompleted: true }),
    makeDelegation('orphan', 'failed', { recovery: { recoveryAvailable: true }, result: '그룹 이동 전 보관 결과' }),
  ],
}
const originalContext = structuredClone(context)
let role = 'editor'; let groupError = false; let actionError = true; let groupReads = 0
const requests = []; const apiErrors = []
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    let body = {}
    if (['POST', 'PATCH'].includes(req.method)) { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || '{}') }
    if (req.method !== 'GET') requests.push({ url: url.pathname, method: req.method, body })
    if (url.pathname === '/api/auth/me') return send({ user: { id: 'fixture-user', name: 'UI 검증', email: 'fixture@example.test', role } })
    if (url.pathname === '/api/health') return send({ publicBaseUrl: base, aionUiWebConfigured: false })
    if (url.pathname === '/api/integrations/aionui/subscription-usage') return send({ error: '시험 환경에서는 사용량을 조회하지 않습니다.' }, 503)
    if (url.pathname === '/api/maps') return send({ maps: context.documents.map((d) => ({ id: d.id, title: d.title, color: 'purple', nodeCount: 13, rootProgress: 30, rootStatus: 'in-progress', waitingCount: d.work.waiting, version: d.version, updatedAt: '2026-09-10T00:00:00Z' })), documentLayout: { version: 1, items: [{ type: 'group', id: context.group.id }], groups: [context.group] } })
    if (['/api/maps/trash', '/api/maps/archive'].includes(url.pathname)) return send({ maps: [] })
    if (url.pathname === '/api/groups/group-test' && req.method === 'GET') { groupReads++; return groupError ? send({ error: '시험용 연결 오류' }, 503) : send(context) }
    if (url.pathname === '/api/groups/group-test' && req.method === 'PATCH') {
      if (body.baseVersion !== context.project.version) return send({ error: '기준 버전 충돌' }, 409)
      const { source, sourceVersion, objective, instructions } = body
      context.project = { ...context.project, source, sourceVersion, objective, instructions, version: context.project.version + 1 }
      return send(context)
    }
    if (url.pathname.startsWith('/api/maps/coordinator/ai-delegations/')) return actionError ? send({ error: '시험용 위임 버전 충돌: 다시 확인해 주세요.' }, 409) : send({ success: true })
    if (url.pathname === '/api/notifications') return send({ notifications: [] })
    if (['/api/users', '/api/assignees'].includes(url.pathname)) return send({ users: [] })
    if (url.pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': fixture\n\n'); return }
    if (url.pathname.endsWith('/comments/stats')) return send({ stats: {} })
    if (url.pathname.startsWith('/api/')) { apiErrors.push(`${req.method} ${url.pathname}`); return send({ error: '시험 범위 밖 API' }, 404) }
    const file = url.pathname.startsWith('/assets/') ? path.resolve(dist, '.' + url.pathname) : path.join(dist, 'index.html')
    if (!file.startsWith(dist + path.sep)) return send({}, 403)
    res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(await readFile(file))
  } catch (error) { res.writeHead(500); res.end(String(error)) }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = spawn(process.env.MNP_BROWSER_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'browser-profile')}`, 'about:blank'], { stdio: 'ignore', windowsHide: true })
let socket; let command; let evaluate; let sequence = 0; const pending = new Map(); const errors = []
try {
  let port
  await until(async () => { try { port = Number((await readFile(path.join(directory, 'browser-profile/DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0 } catch { return false } }, '브라우저 시작 실패')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const entry = pending.get(message.id)
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result) }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  })
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 시간 초과: ' + method)) }, 15000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  const click = async (text) => { await evaluate(`(() => { const b = [...document.querySelectorAll('.group-overview button')].find(b => b.textContent === ${JSON.stringify(text)}); if (!b) throw Error('버튼 없음: ' + ${JSON.stringify(text)}); b.click(); })()`); await pause(60) }
  const selectDocument = async (id) => { await evaluate(`document.querySelector('[data-map-id="${id}"]').click()`); await pause(60) }
  const fill = async (selector, value) => { await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true})); })()`); await pause(60) }
  const capture = async (name) => { const result = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(directory, name + '.png'), Buffer.from(result.data, 'base64')) }
  const load = async () => { await command('Page.navigate', { url: `${base}/groups/group-test` }); await until(() => evaluate('document.querySelector(".group-master-detail") !== null').catch(() => false), '그룹 딥링크 표시 실패'); await evaluate('document.fonts.ready') }
  const checkLayout = async () => {
    const metrics = await evaluate(`(() => { const q = s => document.querySelector(s); return { pageWidth: q('.group-overview').scrollWidth, width: q('.group-overview').clientWidth, pageHeight: q('.group-overview').scrollHeight, height: q('.group-overview').clientHeight, detailHeight: q('.group-detail-scroll')?.clientHeight, footerBottom: q('.group-feedback').getBoundingClientRect().bottom, viewport: innerHeight, title: getComputedStyle(q('.group-page-title h1')).fontSize, body: getComputedStyle(q('.group-overview')).fontSize, button: getComputedStyle(q('.group-header-actions button')).fontSize }; })()`)
    assert.equal(metrics.title, '15px'); assert.equal(metrics.body, '10px'); assert.equal(metrics.button, '9px')
    assert.ok(metrics.pageWidth <= metrics.width + 1, JSON.stringify(metrics))
    assert.ok(metrics.pageHeight <= metrics.height + 1, JSON.stringify(metrics))
    assert.ok(metrics.detailHeight > 60, JSON.stringify(metrics))
    assert.ok(metrics.footerBottom <= metrics.viewport + 1, JSON.stringify(metrics))
    return metrics
  }
  await command('Runtime.enable'); await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await load()
  assert.equal(await evaluate('document.querySelectorAll(".group-document-row").length'), 9)
  assert.equal(await evaluate('document.querySelectorAll(".group-execution-picker option").length'), 2)
  assert.equal(await evaluate('document.querySelector(".group-link-copy-button rect")?.getAttribute("x")'), '8', '기존 MnP 겹친 문서 복사 아이콘')
  const typography = await checkLayout(); await capture('overview-light')
  await evaluate('document.querySelector(\'button[aria-label^="화면 테마:"]\').click()'); await pause(100)
  await checkLayout(); await capture('overview-dark')
  await click('담당 범위')
  assert.equal(await evaluate('document.querySelector(".group-detail-scroll").innerText.includes("공통 기준을 먼저 확인합니다.")'), true)
  await click('위임·결과 2'); await click('복구 이력')
  assert.equal(await evaluate('document.querySelector(".group-detail-scroll").innerText.includes("보존된 이전 결과")'), true)
  await click('위임·결과 2'); await fill('select[aria-label="위임 기록 선택"]', 'older-doc-0')
  assert.equal(await evaluate('document.querySelector(".group-detail-scroll").innerText.includes("이전 위임 결과 원문")'), true)
  await selectDocument('orphan')
  assert.equal(await evaluate('document.querySelector(".group-detail-panel").innerText.includes("읽기 전용")'), true)
  assert.equal(await evaluate('document.querySelector(".group-recovery-actions") === null'), true)
  await click('확인 필요 4')
  assert.equal(await evaluate('document.querySelectorAll(".group-document-row").length'), 4)
  await fill('input[type="search"]', '없는 문서')
  assert.equal(await evaluate('document.querySelector(".group-detail-panel").innerText.includes("검색 조건")'), true)
  await fill('input[type="search"]', ''); await click('전체 9'); await selectDocument('doc-0')
  // 취소는 POST하지 않으며 승인 시 기존 요청의 버전·범위 계약을 그대로 사용한다.
  await evaluate('window.confirm=()=>false'); const beforeCancel = requests.length
  await click('승인 범위 작업 재개'); assert.equal(requests.length, beforeCancel)
  await evaluate('window.confirm=()=>true'); await click('승인 범위 작업 재개')
  await until(() => evaluate('document.querySelector(".group-feedback [role=alert]")?.textContent.includes("시험용 위임 버전 충돌")'), '실행 오류 표시 실패')
  const recoveryRequest = requests.find((r) => r.url.endsWith('/recover'))
  assert.equal(recoveryRequest.url, '/api/maps/coordinator/ai-delegations/delegation-doc-0/recover')
  assert.equal(recoveryRequest.body.confirmApprovedScope, true); assert.equal(recoveryRequest.body.groupVersion, 3)
  assert.equal(recoveryRequest.body.sourceRevision, 7); assert.equal(recoveryRequest.body.targetRevision, 7)
  assert.equal(recoveryRequest.body.expectedUpdatedAt, originalContext.delegations[0].updatedAt)
  assert.ok(recoveryRequest.body.instruction.includes('재승인을 기다리세요'))
  const readCount = groupReads
  await until(() => Promise.resolve(groupReads > readCount), '8초 자동 갱신 실패')
  assert.equal(await evaluate('document.querySelector(".group-feedback [role=alert]")?.textContent.includes("시험용 위임 버전 충돌")'), true, '갱신 후 작업 오류 보존')
  await evaluate('document.querySelector(".group-detail-scroll").scrollTop = 99999')
  await checkLayout(); await capture('recovery-error')
  await evaluate('document.querySelector(\'button[aria-label="작업 오류 닫기"]\').click()')
  actionError = false; await selectDocument('doc-1'); await click('결과 전달 재시도')
  await until(() => evaluate('document.querySelector(".group-feedback [role=status]")?.textContent.includes("하위 작업은 재실행하지 않습니다")'), '보고 전용 재시도 실패')
  assert.ok(requests.some((r) => r.url.endsWith('/delegation-doc-1/retry-report') && r.body.confirmApprovedScope))
  await evaluate('document.querySelector(\'button[aria-label="작업 알림 닫기"]\').click()')
  await click('기획 기준')
  assert.equal(await evaluate('document.querySelectorAll("#group-criteria-form textarea")[1].value'), originalContext.project.instructions)
  await fill('#group-criteria-form textarea', '사용자 편집 중인 목표\n내용 보존')
  await click('새로고침')
  assert.equal(await evaluate('document.querySelector("#group-criteria-form textarea").value'), '사용자 편집 중인 목표\n내용 보존')
  assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent === "총괄 AI 대화 시작").disabled'), true)
  context.project.version++; context.project.objective = '다른 곳에서 변경된 목표'; await click('새로고침')
  await until(() => evaluate('document.querySelector(".group-feedback").innerText.includes("작성 중인 내용은 보존")'), '기준 버전 충돌 표시 실패')
  assert.equal(await evaluate('document.querySelector("#group-criteria-form textarea").value'), '사용자 편집 중인 목표\n내용 보존')
  await click('최신 내용 불러오기')
  await fill('#group-criteria-form textarea', '사용자 승인용 새 목표'); await click('기준 저장')
  await until(() => Promise.resolve(context.project.objective === '사용자 승인용 새 목표'), '기준 저장 실패')
  assert.equal(context.project.instructions, originalContext.project.instructions)
  await capture('criteria-dark')
  groupError = true; await click('새로고침')
  await until(() => evaluate('document.querySelector(".group-feedback").innerText.includes("정보 갱신 실패")'), '통신 오류 표시 실패')
  assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent === "총괄 AI 대화 시작").disabled'), true)
  groupError = false; await click('새로고침')
  await evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.copiedGroupLink=text}}})')
  await evaluate('document.querySelector(\'button[aria-label="총괄 AI 페이지 URL 복사"]\').click()')
  await until(() => evaluate(`window.copiedGroupLink === ${JSON.stringify(base + '/groups/group-test')}`), 'URL 복사 실패')
  await click('문서로 돌아가기'); await selectDocument('doc-0')
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  // 기존 MnP 사이드바의 모바일 전환 애니메이션(200ms)이 끝난 뒤 확인한다.
  await pause(350); await checkLayout(); await capture('overview-mobile')
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  role = 'viewer'; await load()
  assert.equal(await evaluate('[...document.querySelectorAll(".group-overview button")].some(b=>["총괄 AI 대화 시작","위임 제안 요청","승인 범위 작업 재개","문서 추가"].includes(b.textContent))'), false)
  await click('기획 기준')
  assert.equal(await evaluate('document.querySelector(".group-detail-scroll").innerText.includes("사용자 승인 후 실행한다.")'), true)
  context = { ...context, project: { ...context.project, coordinatorMapId: null }, coordinator: null, documents: [], delegations: [], group: { ...context.group, mapIds: [] } }
  role = 'editor'; await load(); await click('기획 기준과 총괄 설정')
  assert.equal(await evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent === "기준 저장 · 총괄 준비" && !b.disabled)'), true)
  await capture('empty-setup')
  assert.deepEqual(errors, [], '브라우저 예외 없음')
  assert.deepEqual(apiErrors, [], '시험 범위 밖 API 호출 없음')
  console.log(JSON.stringify({ passed: true, directory, typography, checked: ['전체 MnP 그룹 딥링크', '8개 문서와 이전 이력', '밝은·어두운 테마', '선택·검색·확인 필요', '전체 기준·결과 보존', '복구 취소와 승인 요청', '보고만 재시도', '자동 갱신 후 오류 보존', '편집 중 갱신·버전 충돌·저장', '갱신 실패 시 실행 차단', 'URL 복사', '모바일 배치', '읽기 전용', '빈 그룹 설정'] }, null, 2))
} catch (error) {
  if (evaluate) console.error(await evaluate('({text:document.querySelector(".group-overview")?.innerText, width:innerWidth,height:innerHeight})').catch(() => null))
  if (command) { const shot = await command('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (shot) await writeFile(path.join(directory, 'failure.png'), Buffer.from(shot.data, 'base64')) }
  console.error({ directory, errors, apiErrors }); throw error
} finally {
  if (command && socket?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => {})
  for (const entry of pending.values()) clearTimeout(entry.timer)
  socket?.close()
  if (browser.exitCode === null) { const exited = new Promise((resolve) => browser.once('exit', resolve)); browser.kill(); await exited }
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
}
