import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

// 별도 headless 프로필만 사용한다. 실제 사용자 브라우저와 문서에는 접근하지 않는다.
export async function documentLifecycleBrowser(base, directory, sourceId, nextId) {
  const browser = spawn(process.env.MNP_BROWSER_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'browser-profile')}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let socket; let command; const errors = []; const pending = new Map(); let sequence = 0
  const until = async (check, message) => {
    for (let i = 0; i < 160; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
    throw new Error(message)
  }
  try {
    let port
    await until(async () => { try { port = Number((await readFile(path.join(directory, 'browser-profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0 } catch { return false } }, '시험 브라우저 시작 실패')
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) { const entry = pending.get(message.id); if (entry) { pending.delete(message.id); clearTimeout(entry.timer); if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result) } }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description ?? ''))
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
    await command('Runtime.enable'); await command('Page.enable')
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await command('Page.navigate', { url: base })
    await until(() => evaluate(`location.origin === ${JSON.stringify(base)} && document.readyState === 'complete'`).catch(() => false), '페이지 로딩 실패')
    // 시험용 관리자만 인증한다. 비밀번호는 실제 계정이 아닌 임시 서버 입력이다.
    assert.equal(await evaluate(`fetch('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'reconstruction-test@mind.local',password:'TestOnly!2026'})}).then(r=>r.status)`), 200)
    await command('Page.navigate', { url: `${base}/mindmap/${sourceId}/task` })
    await until(() => evaluate('document.body.innerText.includes("보관 문서 (읽기 전용)")'), '보관 링크가 보관 문서를 열지 못했습니다.')
    assert.equal(await evaluate('document.querySelector(".comment-form") === null'), true, '보관 문서 댓글 작성 금지')
    assert.equal(await evaluate('document.querySelector(".react-flow__node[data-id=task]") !== null'), true, '기존 카드 ID 열람')
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("보관함 · 문서 재구성")).click()')
    await until(() => evaluate('document.querySelector(".lifecycle-dialog")?.innerText.includes("v0.4 원본")'), '보관함 목록 표시 실패')
    assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].some(b=>b.textContent === "복원")'), true)
    const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-reconstruction-screenshots-'))
    const capture = async (name) => {
      const result = await command('Page.captureScreenshot', { format: 'png' })
      await writeFile(path.join(artifactDirectory, name), Buffer.from(result.data, 'base64'))
    }
    const screenshot = await command('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = path.join(artifactDirectory, 'archive.png')
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    await evaluate('[...document.querySelectorAll(".lifecycle-dialog nav button")].find(b=>b.textContent === "문서 정리").click()')
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="AI 문서 재구성안 JSON"]') !== null`), true)
    await evaluate('[...document.querySelectorAll(".lifecycle-dialog nav button")].find(b=>b.textContent === "전환 이력").click()')
    await until(() => evaluate('document.querySelector(".lifecycle-dialog")?.innerText.includes("compact-api")'), '전환 이력 표시 실패')
    await command('Page.navigate', { url: `${base}/mindmap/${nextId}/task-next` })
    await until(() => evaluate('document.body.innerText.includes("이 카드가 이어받은 원본")'), '후속 카드 출처 표시 실패')
    assert.equal(await evaluate(`document.querySelector('a[href="/mindmap/${sourceId}/task"]') !== null`), true)
    await evaluate('document.fonts.ready')
    const nodeTypography = (scope) => `(() => {
      const node = document.querySelector(${JSON.stringify(`${scope} .react-flow__node[data-id="task-next"] .mind-node`)});
      return [node, ...node.querySelectorAll('h3, p')].map(element => {
        const style = getComputedStyle(element);
        return { tag: element.tagName, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight };
      });
    })()`
    const mainNodeTypography = await evaluate(nodeTypography('.app-shell'))
    // 기존 MnP 화면과 동일한 브라우저 배율에서 제목 크기를 비교한다.
    await evaluate('document.querySelector("button[title=\\"공유 지식 정리 후보 검토\\"]").click()')
    await until(() => evaluate('document.querySelector(".shared-knowledge-review-header strong") !== null'), '기존 MnP 비교 화면 없음')
    const referenceTitleSize = await evaluate('getComputedStyle(document.querySelector(".shared-knowledge-review-header strong")).fontSize')
    await capture('reference-knowledge.png')
    await evaluate('document.querySelector("button[aria-label=\\"공유 지식 검토 닫기\\"]").click()')
    // 현재 선택 문서와 무관하게 우클릭한 그룹/문서가 정리 대상이 된다.
    await evaluate('document.querySelector(".document-group-header").dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,clientX:130,clientY:260}))')
    await until(() => evaluate('document.querySelector("[role=menu]")?.innerText.includes("문서 정리")'), '그룹 우클릭 메뉴 없음')
    await evaluate('[...document.querySelectorAll("[role=menu] button")].find(b=>b.textContent.includes("문서 정리")).click()')
    await until(() => evaluate('document.querySelectorAll(".lifecycle-sources input:checked").length === 2'), '그룹 하위 문서 자동 선택 실패')
    assert.equal(await evaluate('document.querySelector(".lifecycle-dialog nav button[aria-pressed=true]").textContent'), '문서 정리')
    await evaluate('[...document.querySelectorAll(".lifecycle-dialog header button")].find(b=>b.textContent === "닫기").click()')
    await evaluate(`const toggle = document.querySelector('.document-group-toggle'); if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();`)
    await until(() => evaluate('[...document.querySelectorAll(".map-item")].some(e=>e.textContent.includes("정리된 현재 업무"))'), '시험 문서 행 없음')
    await evaluate(`const row = [...document.querySelectorAll('.map-item')].find(e=>e.textContent.includes('정리된 현재 업무')); row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:130,clientY:320}));`)
    await until(() => evaluate('document.querySelector("[role=menu]")?.innerText.includes("문서 정리")'), '문서 우클릭 메뉴 없음')
    await evaluate('[...document.querySelectorAll("[role=menu] button")].find(b=>b.textContent.includes("문서 정리")).click()')
    await until(() => evaluate('document.querySelectorAll(".lifecycle-sources input:checked").length === 1'), '단일 문서 범위 선택 실패')
    assert.equal(await evaluate('document.querySelector(".lifecycle-sources").innerText.includes("새 문서 간 참조")'), false)
    await evaluate(`Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(document.querySelector('select[aria-label="정리 목적"]'),'spec-update'); document.querySelector('select[aria-label="정리 목적"]').dispatchEvent(new Event('change',{bubbles:true}));`)
    await until(() => evaluate('document.querySelector("input[aria-label=\\"새 기획서 출처\\"]") !== null'), '새 기획서 입력 없음')
    assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent === "AI 정리안 요청").disabled'), true, '새 기획 출처 없이 요청 금지')
    await evaluate(`Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(document.querySelector('select[aria-label="정리 목적"]'),'compact'); document.querySelector('select[aria-label="정리 목적"]').dispatchEvent(new Event('change',{bubbles:true})); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('input[aria-label="현재 기준"]'),'v0.4'); document.querySelector('input[aria-label="현재 기준"]').dispatchEvent(new Event('input',{bubbles:true}));`)
    await until(() => evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent === "AI 정리안 요청").disabled === false'), '정리안 요청 입력 반영 실패')
    const typography = await evaluate(`Object.fromEntries(Object.entries({title:'.lifecycle-dialog h2',body:'.lifecycle-dialog p',label:'.lifecycle-dialog label',input:'.lifecycle-dialog input[aria-label="현재 기준"]',notes:'.lifecycle-dialog .lifecycle-notes',button:'.lifecycle-dialog .lifecycle-primary'}).map(([key,selector])=>[key,getComputedStyle(document.querySelector(selector)).fontSize]))`)
    assert.deepEqual(typography, { title: referenceTitleSize, body: '9px', label: '9px', input: '10px', notes: '10px', button: '9px' }, '기존 MnP와 일치하는 제목 및 명시적 본문·입력·버튼 크기')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".lifecycle-dialog .lifecycle-primary")).minHeight'), '28px')
    const assertRequestPanel = async () => {
      const bounds = await evaluate(`(() => {
        const panel = document.querySelector('.lifecycle-dialog fieldset');
        const box = panel.getBoundingClientRect();
        const title = panel.querySelector('legend').getBoundingClientRect();
        const sources = panel.querySelector('.lifecycle-sources').getBoundingClientRect();
        const style = getComputedStyle(panel);
        return { top: title.top - box.top, left: title.left - box.left, bottom: box.bottom - title.bottom, right: box.right - title.right, gap: sources.top - title.bottom, inset: parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth) };
      })()`)
      assert.ok(bounds.top >= bounds.inset - 0.5 && bounds.left >= 10 && bounds.bottom > 0 && bounds.right >= 10, '정리 요청 제목이 테두리가 아닌 패널 내부 여백에 위치한다: ' + JSON.stringify(bounds))
      assert.ok(bounds.gap >= 8, '제목과 문서 선택 목록 사이 여백 유지')
    }
    await assertRequestPanel()
    assert.equal(await evaluate(`(() => {
      const panel = document.querySelector('.lifecycle-dialog fieldset');
      const previous = panel.disabled;
      try { panel.disabled = true; return [...panel.querySelectorAll('input, select, textarea, button')].every(control => control.matches(':disabled')); }
      finally { panel.disabled = previous; }
    })()`), true, 'fieldset의 전체 입력 잠금 유지')
    await capture('request-light.png')
    const lightBackground = await evaluate('getComputedStyle(document.querySelector(".lifecycle-dialog")).backgroundColor')
    await evaluate('document.querySelector("button[aria-label^=\\"화면 테마:\\"]").click()')
    await until(() => evaluate(`getComputedStyle(document.querySelector('.lifecycle-dialog')).backgroundColor !== ${JSON.stringify(lightBackground)}`), '어두운 테마 적용 실패')
    await assertRequestPanel()
    await capture('request-dark.png')
    await evaluate('document.querySelector("button[aria-label^=\\"화면 테마:\\"]").click()')
    await until(() => evaluate(`getComputedStyle(document.querySelector('.lifecycle-dialog')).backgroundColor === ${JSON.stringify(lightBackground)}`), '밝은 테마 복원 실패')
    await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent === "AI 정리안 요청").click()')
    await until(() => evaluate('document.querySelector(".ai-dialog") !== null'), '기존 AI 선택 화면 연결 실패')
    // AI를 실제 실행하지 않고 옵션 화면을 닫는다. 가짜 제안을 시험 서버에 제출한다.
    await evaluate('document.querySelector("button[aria-label=\\"AI 대화 옵션 닫기\\"]").click()')
    const browserProposal = await evaluate(`(async()=>{
      const requests = await (await fetch('/api/document-reconstructions/requests')).json(); const request = requests.requests.find(r=>r.baseline==='v0.4' && r.mapIds.length===1 && r.mapIds[0]===${JSON.stringify(nextId)});
      const context = await (await fetch('/api/document-reconstructions/context?mapId='+${JSON.stringify(nextId)})).json(); const source = (await (await fetch('/api/maps/'+${JSON.stringify(nextId)})).json()).map;
      const plan = {id:'browser-proposal',mode:'compact',baseline:request.baseline,reason:'브라우저 제안함 검증',sources:context.sources,groupBaselines:context.groupBaselines,targets:[{key:'next',title:'브라우저 정리안',nodes:source.nodes,edges:source.edges}],decisions:source.nodes.map(n=>({mapId:source.id,cardId:n.id,disposition:'carry',reason:'미완료 조건과 현재 지식 유지',targets:[{key:'next',cardId:n.id}]}))};
      const extra=(id,label)=>({id,type:'mind',position:{x:0,y:0},data:{label,description:'배치 검증용 지식 카드',kind:'branch',isWork:false,status:'planned',progress:0}});
      const wide=extra('wide','크기가 큰 외부 링크 카드'); wide.data.taskUrl='https://test.dooray.com/wiki/1/2'; wide.data.externalLink={provider:'dooray-wiki',url:wide.data.taskUrl,hostname:'test.dooray.com',wikiId:'1',pageId:'2',title:'600px 크기 · 긴 제목의 외부 지식 카드',resolvedAt:'2026-09-10T00:00:00Z',displayWidth:600,displayHeight:360};
      const ref=extra('ref-wide','같은 정리안 안의 참조'); ref.data.reference={targetKey:'next',nodeId:'wide'};
      plan.targets[0].nodes.push(wide,extra('child-a','하위 지식 A'),extra('child-b','하위 지식 B'),ref);
      for(const [parent,child] of [[source.nodes[0].id,'wide'],['wide','child-a'],['wide','child-b'],[source.nodes[0].id,'ref-wide']]) plan.targets[0].edges.push({id:parent+'-'+child,source:parent,target:child});
      const res=await fetch('/api/document-reconstructions/requests/'+request.id+'/proposal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:request.revision,plan})}); return {status:res.status,body:await res.json()};
    })()`)
    assert.equal(browserProposal.status, 200, JSON.stringify(browserProposal))
    await evaluate(`globalThis.layoutRequests=[]; const originalFetch=globalThis.fetch; globalThis.fetch=async(...args)=>{const response=await originalFetch(...args); if(typeof args[0]==='string' && /\\/(preview|measure-layout|verify-layout)$/.test(args[0])) globalThis.layoutRequests.push({url:args[0],request:args[1]?.body,response:await response.clone().json()}); return response;}`)
    await until(() => evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].some(b=>b.textContent.includes("미리보기 검증"))'), '정리안 자동 수신 실패')
    await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent.includes("미리보기 검증")).click()')
    await until(() => evaluate('document.querySelector(".lifecycle-dialog")?.innerText.includes("새 문서: 브라우저 정리안")'), '정리안 미리보기 실패')
    await until(() => evaluate('document.querySelector(".lifecycle-dialog")?.innerText.includes("최소 여백 검증을 통과했습니다")'), '실제 렌더 배치 검증 실패')
    assert.equal(await evaluate('document.querySelectorAll(".reconstruction-map .mind-node").length > 1'), true, '실제 카드 컴포넌트 렌더')
    assert.equal(await evaluate('document.querySelectorAll(".reconstruction-map .dooray-task-node").length'), 2, '가변 크기 외부 카드와 새 문서 Ref 렌더')
    assert.deepEqual(await evaluate(nodeTypography('.reconstruction-map')), mainNodeTypography, '관리 화면의 축소 스타일이 실제 카드 글꼴·줄간격을 바꾸지 않는다')
    assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent === "승인한 전환안 적용").disabled'), true, '별도 승인 전 적용 금지')
    assert.equal(await evaluate(`fetch('/api/maps/${nextId}').then(r=>r.json()).then(r=>Boolean(r.map.archivedAt))`), false, '제안만으로 원본 보관 금지')
    assert.equal(await evaluate('document.querySelector(".lifecycle-dialog").innerText.includes("미완료 조건과 현재 지식 유지")'), true, 'JSON 없이 카드 대응 이유 표시')
    await evaluate('document.querySelector(".reconstruction-map").scrollIntoView({block:"center"})')
    const proposalScreenshot = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(artifactDirectory, 'right-click-proposal.png'), Buffer.from(proposalScreenshot.data, 'base64'))
    const reopenSaved = async () => {
      await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("보관함 · 문서 재구성")).click()')
      await evaluate('[...document.querySelectorAll(".lifecycle-dialog nav button")].find(b=>b.textContent === "문서 정리").click()')
      await until(() => evaluate('document.querySelector(".lifecycle-dialog")?.innerText.includes("정리안 도착")'), '저장된 제안함 재조회 실패')
      await evaluate('[...document.querySelectorAll(".lifecycle-dialog article button")].find(b=>b.textContent.includes("v0.4")).click()')
      await until(() => evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].some(b=>b.textContent.includes("미리보기 검증"))'), '저장된 AI 정리안 다시 열기 실패')
      assert.equal(await evaluate('document.querySelector(".reconstruction-map") === null'), true, '승인과 렌더 검증은 복원하지 않는다')
      await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent.includes("미리보기 검증")).click()')
      await until(() => evaluate('document.querySelector(".lifecycle-dialog")?.innerText.includes("최소 여백 검증을 통과했습니다")'), '재진입 후 실제 렌더 검증 실패')
      assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent === "승인한 전환안 적용").disabled'), true, '재진입 후 별도 승인 필요')
    }
    await evaluate('[...document.querySelectorAll(".lifecycle-dialog header button")].find(b=>b.textContent === "닫기").click()')
    await reopenSaved()
    await evaluate('[...document.querySelectorAll(".lifecycle-dialog label")].find(e=>e.textContent.includes("카드 대응표와 현재 지식")).querySelector("input").click()')
    assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent === "승인한 전환안 적용").disabled'), false)
    await command('Page.reload')
    await until(() => evaluate('document.querySelector(".lifecycle-dialog") === null && [...document.querySelectorAll("button")].some(b=>b.textContent.includes("보관함 · 문서 재구성"))').catch(() => false), '새로고침 실패')
    await reopenSaved()
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    assert.equal(await evaluate('document.querySelector(".lifecycle-dialog").getBoundingClientRect().width <= innerWidth'), true, '모바일 화면 폭 안에 대화상자 배치')
    await evaluate('document.querySelector(".lifecycle-dialog").scrollTop = 0')
    await assertRequestPanel()
    await capture('request-mobile.png')
    // 서버 fixture가 아닌 실제 DOM으로 검증한 배치가 UI 승인 후 그대로 저장되는지 확인한다.
    const expectedPositions = await evaluate('[...document.querySelectorAll(".reconstruction-map .react-flow__node")].map(e=>({id:e.dataset.id,transform:e.style.transform}))')
    await evaluate('window.confirm=()=>true; [...document.querySelectorAll(".lifecycle-dialog label")].find(e=>e.textContent.includes("카드 대응표와 현재 지식")).querySelector("input").click()')
    await until(() => evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent === "승인한 전환안 적용").disabled === false'), '브라우저 시험 승인 실패')
    await evaluate('[...document.querySelectorAll(".lifecycle-dialog button")].find(b=>b.textContent === "승인한 전환안 적용").click()')
    await until(() => evaluate('document.querySelector(".lifecycle-dialog")?.innerText.includes("전환했습니다")'), '실제 렌더 검증안 UI 적용 실패')
    const savedPositions = await evaluate(`(async()=>{const result=await (await fetch('/api/document-reconstructions/browser-proposal')).json(); const map=(await (await fetch('/api/maps/'+result.targetMapIds[0])).json()).map; return map.nodes.map(n=>({id:n.id,transform:'translate('+n.position.x+'px, '+n.position.y+'px)'}));})()`)
    assert.deepEqual(savedPositions, expectedPositions, '미리보기와 실제 저장 좌표 일치')
    assert.equal(await evaluate(`fetch('/api/document-reconstructions/browser-proposal/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)`), 200, '시험 전환 되돌리기')
    assert.deepEqual(errors, [], '브라우저 실행 오류 없음')
    return { screenshotPath, proposalScreenshotPath: path.join(artifactDirectory, 'right-click-proposal.png'), typography, checked: ['기존 MnP 제목 크기 비교', '본문·입력·버튼 크기', '밝은·어두운 테마', '실제 카드 타이포그래피 격리', '보관 원본 딥링크', '읽기 전용', '그룹·문서 우클릭', '정확한 정리 대상', '새 기획 원본 필수', 'AI 옵션 연결·실행 전 취소', '제안함 자동 수신', 'JSON 없는 대응표 검토', '실제 가변 카드·Ref 렌더 배치 검증', '창 닫기·새로고침 후 제안 복원과 승인 초기화', '실제 렌더 좌표와 UI 적용 결과 일치', '별도 적용 승인', '전환 이력', '후속 카드 출처', '모바일 폭', '브라우저 실행 오류 없음'] }
  } catch (error) {
    if (command && socket?.readyState === WebSocket.OPEN) {
      const diagnostic = await command('Runtime.evaluate', { expression: '({text:document.querySelector(".lifecycle-dialog")?.innerText, measurements:globalThis.layoutRequests?.map(r=>({url:r.url,measurements:JSON.parse(r.request).measurements,layout:r.response.targets?.map(t=>t.layout),error:r.response.error})), nodes:[...document.querySelectorAll(".reconstruction-map .react-flow__node")].map(e=>({id:e.dataset.id,style:e.getAttribute("style"),body:e.querySelector(".mind-node")?.getBoundingClientRect().toJSON()}))})', returnByValue: true }).catch(() => null)
      console.error('브라우저 검증 실패 진단:', JSON.stringify(diagnostic?.result?.value), errors)
    }
    throw error
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer)
    if (command && socket?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => {})
    socket?.close()
    if (browser.exitCode === null) { const exited = new Promise((resolve) => browser.once('exit', resolve)); browser.kill(); await exited }
  }
}
