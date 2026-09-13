import assert from 'node:assert/strict'

// CDP의 실제 터치 입력으로 pointer/touch 순서, 메뉴 전환, 저장/실행 취소까지 검사한다.
export async function touchMenuBrowser({ base, command, evaluate, until, api }) {
  const node = (id, x, y, kind = 'task') => ({ id, type: 'mind', position: { x, y }, data: { label: id, description: '길게 누르기와 카드 이동 검증', kind, isWork: kind === 'task', progress: 0, status: 'planned' } })
  const created = await api('/api/maps', 'POST', { title: '휴대폰 제스처 검증', map: { nodes: [node('touch-parent', 0, 0, 'root'), node('touch-child', 310, 0), node('touch-other', 620, 380)], edges: [{ id: 'touch-edge', source: 'touch-parent', target: 'touch-child' }] } })
  assert.equal(created.status, 201)
  const mapId = created.body.map.id
  const library = (await api('/api/maps')).body
  const groupId = 'group-touch-menu'
  const layout = { ...library.documentLayout, items: [...library.documentLayout.items, { type: 'group', id: groupId }], groups: [...library.documentLayout.groups, { id: groupId, name: '터치 메뉴 그룹', mapIds: [] }] }
  const grouped = await api('/api/maps/layout', 'PATCH', { documentLayout: layout })
  assert.equal(grouped.status, 200, JSON.stringify(grouped.body))
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const touch = (type, points) => command('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 2, radiusY: 2, force: 1 })) })
  const point = (selector, uncovered = false) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); const menu=document.querySelector('[role=menu]')?.getBoundingClientRect(); for(const px of [0.3,0.1,0.9])for(const py of [0.45,0.65,0.2]){const p={x:r.x+r.width*px,y:r.y+r.height*py}; if(p.x<5||p.y<5||p.x>innerWidth-5||p.y>innerHeight-5)continue; if(${uncovered}&&menu&&p.x>=menu.left&&p.x<=menu.right&&p.y>=menu.top&&p.y<=menu.bottom)continue;return p}throw Error('터치 가능한 카드 영역 없음:'+${JSON.stringify(selector)})})()`)
  const tap = async (selector) => { const p = await point(selector); await touch('touchStart', [p]); await pause(60); await touch('touchEnd', []); await pause(100) }
  const hold = async (selector) => { const p = await point(selector); await touch('touchStart', [p]); await pause(620); return p }
  const escape = async () => { for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }) }
  const positions = () => evaluate(`Object.fromEntries([...document.querySelectorAll('.canvas-wrap .react-flow__node')].map(e=>{const m=new DOMMatrix(getComputedStyle(e).transform);return [e.dataset.id,{x:m.e,y:m.f}]}))`)
  const viewport = () => evaluate(`getComputedStyle(document.querySelector('.canvas-wrap .react-flow__viewport')).transform`)
  const parent = '.canvas-wrap .react-flow__node[data-id="touch-parent"] .mind-node'
  const travel = async (p, dx, dy) => { for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ x: p.x + dx * i / 5, y: p.y + dy * i / 5 }]); await pause(30) } }
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  await command('Page.navigate', { url: `${base}/mindmap/${mapId}/touch-parent` })
  await until(() => evaluate(`document.querySelector(${JSON.stringify(parent)})!==null`), '터치 시험 카드 없음')
  await pause(400)
  await evaluate(`document.querySelector('button[aria-label="모바일 패널 닫기"]')?.click()`)
  await tap('button[aria-label="문서 목록 열기"]')
  const row = `[data-library-menu-id="${mapId}"]`
  await until(() => evaluate(`document.querySelector('.sidebar.mobile-open')!==null`), '모바일 문서 목록 열기 실패')
  await pause(250)
  await hold(row)
  await until(() => evaluate('document.querySelector(".document-context-menu")?.innerText.includes("AI 배치 제안")'), '문서 길게 누르기 실패')
  await touch('touchEnd', []); await pause(200)
  assert.equal(await evaluate('document.querySelector(".document-context-menu")!==null && document.querySelector(".sidebar.mobile-open")!==null'), true, '손을 떼도 메뉴 유지, 문서 클릭으로 전환하지 않음')
  const layoutButton = await evaluate(`(()=>{const b=[...document.querySelectorAll('.document-context-menu button')].find(e=>e.textContent.includes('AI 배치 제안'));const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await touch('touchStart', [layoutButton]); await touch('touchEnd', [])
  await until(() => evaluate('document.querySelector(".card-layout-dialog")!==null'), '터치 메뉴에서 배치 제안 열기 실패')
  await evaluate(`[...document.querySelectorAll('.card-layout-dialog button')].find(b=>b.textContent==='닫기').click()`)
  await pause(850)
  const swipe = await point(row)
  await touch('touchStart', [swipe]); await travel(swipe, 0, -35); await touch('touchEnd', []); await pause(650)
  assert.equal(await evaluate('document.querySelector(".document-context-menu")===null'), true, '목록 스크롤은 길게 누르기 메뉴를 열지 않는다')
  await evaluate(`document.querySelector('[data-library-menu-id="${groupId}"]').scrollIntoView({block:'center'})`)
  await hold(`[data-library-menu-id="${groupId}"]`); await touch('touchEnd', [])
  await until(() => evaluate('document.querySelector(".document-context-menu")?.innerText.includes("그룹 메뉴")'), '그룹 길게 누르기 실패')
  await escape()
  assert.deepEqual((await api('/api/maps')).body.documentLayout, layout, '터치 메뉴로 문서/그룹 순서나 소속을 바꾸지 않는다')
  await tap('button[aria-label="문서 목록 닫기"]'); await pause(250)
  const original = await positions(); const originalViewport = await viewport()
  // 길게 누르기 전 드래그는 카드가 아닌 화면 이동이다.
  let p = await point(parent); await touch('touchStart', [p]); await travel(p, 35, 25); await touch('touchEnd', []); await pause(100)
  assert.deepEqual(await positions(), original, '일반 쓸기는 카드 위치를 바꾸지 않는다')
  assert.notEqual(await viewport(), originalViewport, '일반 쓸기는 화면을 이동한다')
  const panBefore = await viewport()
  p = await hold(parent)
  await until(() => evaluate('document.querySelector("[role=menu]")?.innerText.includes("노드 메뉴")'), '카드 길게 누르기 메뉴 없음')
  assert.deepEqual(await positions(), original, '정지한 길게 누르기는 카드 불변')
  await travel(p, 60, -40)
  assert.equal(await evaluate('document.querySelector("[role=menu]")===null'), true, '이동 시작 시 메뉴 닫기')
  await touch('touchEnd', []); await pause(100)
  const moved = await positions()
  assert.notDeepEqual(moved['touch-parent'], original['touch-parent'], '누른 채 드래그로 카드 이동')
  for (const axis of ['x', 'y']) assert.equal(moved['touch-child'][axis] - original['touch-child'][axis], moved['touch-parent'][axis] - original['touch-parent'][axis], '하위 카드 동반 이동')
  assert.equal(await viewport(), panBefore, '카드 이동 중 화면 이동 없음')
  await until(async () => { const saved = (await api(`/api/maps/${mapId}`)).body.map; return JSON.stringify(saved.nodes.find(n=>n.id==='touch-parent').position)===JSON.stringify(moved['touch-parent']) }, '터치 드래그 저장 실패')
  assert.deepEqual((await api(`/api/maps/${mapId}`)).body.map.edges, created.body.map.edges, '위치 이동 시 관계 보존')
  await evaluate('document.querySelector("button[aria-label=\\"실행 취소\\"]").click()'); await pause(100)
  assert.deepEqual(await positions(), original, '드래그 한 번을 실행 취소 한 번으로 복원')
  // 메뉴를 연 뒤 손을 떼어도 같은 카드를 다시 밀면 재대기 없이 이동한다.
  await hold(parent); await touch('touchEnd', []); await pause(100)
  assert.equal(await evaluate('document.querySelector("[role=menu]")?.innerText.includes("노드 메뉴")'), true, '재터치 전 열린 카드 메뉴 유지')
  p = await point(parent, true)
  const hit = await evaluate(`document.elementFromPoint(${p.x},${p.y})?.outerHTML`)
  await touch('touchStart', [p]); await travel(p, 45, -25)
  assert.notDeepEqual((await positions())['touch-parent'], original['touch-parent'], '열린 메뉴 카드 재터치는 500ms 재대기 없이 이동: ' + hit)
  await touch('touchCancel', []); await pause(100)
  assert.deepEqual(await positions(), original, '터치 취소는 카드와 하위를 원위치 복원')
  await hold(parent)
  const second = { x: 350, y: 650 }
  p = await point(parent)
  await touch('touchStart', [p, second]); await touch('touchMove', [{x:p.x+10,y:p.y+10},{x:second.x+10,y:second.y+10}]); await touch('touchEnd', [])
  assert.deepEqual(await positions(), original, '두 손가락 전환 시 카드 이동 취소')
  return { documentLongPress: true, groupLongPress: true, dragAfterMenu: true, resumeDragAfterRelease: true, descendantsAndUndo: true, cancelAndPan: true }
}
