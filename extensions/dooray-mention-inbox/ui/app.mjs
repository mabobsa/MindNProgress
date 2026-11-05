// Dooray 멘션 확인함 화면. 같은 코드가 두 곳에서 동작한다.
// - app: Claude 대화창 안 화면(MCP Apps). 서버 도구를 호스트를 거쳐 호출한다.
// - web: 확장 서버가 띄우는 이 PC 전용 브라우저 화면. 로컬 API를 접근 키와 함께 호출한다.
// Dooray에서 온 값은 외부 데이터이므로 textContent로만 넣고 HTML로 해석하지 않는다.
import { App } from '@modelcontextprotocol/ext-apps'
import { KIND_LABELS, buildContinuePrompt, claudeNewChatUrl, formatTime, isDoorayUrl } from '../shared/inbox-shared.mjs'

const mode = document.querySelector('meta[name="dooray-mention-inbox-mode"]')?.content === 'web' ? 'web' : 'app'
const webKey = new URLSearchParams(location.search).get('key') ?? ''
const POLL_MS = 1_000
const element = (id) => document.getElementById(id)

let app = null
let current = { items: [], checked: [], checkedTotal: 0, scan: { status: 'idle' }, browserUrl: null }
let tab = 'open'
let pollTimer = null
const pending = new Set()

function toast(message) {
  const box = element('toast')
  box.textContent = message
  box.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => box.classList.remove('show'), 2_600)
}

function resultText(result) {
  return (result?.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
}

const backend = mode === 'web' ? {
  async state({ refresh, days }) {
    const response = await fetch(`/api/state?refresh=${refresh ? 1 : 0}&days=${days}`, { headers: { 'X-Inbox-Key': webKey } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error ?? `요청 실패 (${response.status})`)
    return body
  },
  async check(keys, checked) {
    const response = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Inbox-Key': webKey }, body: JSON.stringify({ keys, checked }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error ?? `요청 실패 (${response.status})`)
    return body
  },
  canOpenLinks: true,
  async openDooray(url) { window.open(url, '_blank', 'noopener,noreferrer') },
  // claude:// 링크는 브라우저가 Claude 앱을 열지 묻는다. 입력창에만 채워지고 자동으로 보내지지 않는다.
  // 시험에서 실제 이동 대신 주소를 확인할 수 있도록 이동 함수를 한 곳에 둔다.
  async openNewChat(url) { (window.__doorayInboxNavigate ?? ((target) => { window.location.href = target }))(url) },
  continueHere: null,
} : {
  async state({ refresh, days }) {
    const result = await app.callServerTool({ name: 'dooray_inbox_state', arguments: { refresh, days } })
    if (result.isError) throw new Error(resultText(result) || '상태를 읽지 못했습니다.')
    return result.structuredContent ?? {}
  },
  async check(keys, checked) {
    const result = await app.callServerTool({ name: 'check_dooray_mentions', arguments: { keys, checked } })
    if (result.isError) throw new Error(resultText(result) || '확인 처리에 실패했습니다.')
    return result
  },
  // Host가 지원하지 않는 기능의 버튼은 연결 뒤 숨긴다(start에서 갱신).
  canOpenLinks: false,
  async openDooray(url) {
    const result = await app.openLink({ url })
    if (result?.isError) throw new Error('링크를 열 수 없습니다.')
  },
  async openNewChat(url) {
    const result = await app.openLink({ url })
    if (result?.isError) throw new Error('새 대화 링크를 열 수 없습니다. 「이 대화에서 이어가기」를 사용해 주세요.')
  },
  async continueHere(prompt) {
    const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] })
    if (result?.isError) throw new Error('대화에 메시지를 넣지 못했습니다.')
  },
}

const phaseLabels = { me: '사용자 확인', projects: '프로젝트 확인', posts: '업무 목록 조회', details: '업무 상세 확인', members: '작성자 확인', done: '마무리' }

function selectedDays() {
  return Number(element('days').value) || 14
}

function renderStatus(error) {
  const status = element('status')
  const progress = element('progress')
  status.classList.toggle('error', Boolean(error))
  progress.hidden = true
  if (error) { status.textContent = `오류: ${error}`; return }
  const scan = current.scan ?? { status: 'idle' }
  if (scan.status === 'scanning') {
    const { phase, done = 0, total = 0 } = scan.progress ?? {}
    status.textContent = `Dooray 업무를 확인하는 중입니다 — ${phaseLabels[phase] ?? phase ?? ''} ${done}/${total}. 처음에는 몇 분 걸릴 수 있습니다.`
    progress.hidden = false
    if (total > 0) { progress.max = total; progress.value = done } else progress.removeAttribute('value')
    return
  }
  if (scan.status === 'error') { status.classList.add('error'); status.textContent = `수집 실패: ${scan.message ?? ''}`; return }
  status.textContent = scan.status === 'updated' ? '새 목록을 불러왔습니다.' : ''
}

function renderHeader() {
  const parts = []
  if (current.rangeDays) parts.push(`최근 ${current.rangeDays}일`)
  if (current.presentedAt) parts.push(`마지막 확인 ${formatTime(current.presentedAt)}`)
  if (current.summary?.failureCount) parts.push(`조회 실패 ${current.summary.failureCount}건`)
  element('sub').textContent = parts.join(' · ')
  element('tab-open').textContent = `확인할 항목 ${current.items.length}`
  element('tab-checked').textContent = `숨긴 항목 ${current.checkedTotal ?? current.checked.length}`
  element('browser').hidden = !(mode === 'app' && backend.canOpenLinks && current.browserUrl)
  element('refresh').disabled = current.scan?.status === 'scanning'
}

function button(label, onClick) {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = label
  node.addEventListener('click', onClick)
  return node
}

function renderItem(item, isChecked) {
  const row = document.createElement('li')
  row.className = 'item'
  if (pending.has(item.key)) row.classList.add('leaving')

  const checkCell = document.createElement('label')
  checkCell.className = 'check'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = isChecked
  checkbox.title = isChecked ? '체크를 풀면 다시 확인할 항목으로 돌아갑니다' : '확인했으면 체크하세요'
  checkbox.setAttribute('aria-label', `${item.subject ?? ''} 확인 표시`)
  checkbox.disabled = pending.has(item.key)
  checkbox.addEventListener('change', () => setChecked(item, checkbox.checked))
  checkCell.append(checkbox)

  const title = document.createElement('div')
  title.className = 'title'
  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.textContent = KIND_LABELS[item.kind] ?? item.kind ?? ''
  const subject = document.createElement(backend.canOpenLinks && isDoorayUrl(item.url) ? 'a' : 'span')
  subject.className = 'subject'
  subject.textContent = item.subject || '(제목 없음)'
  if (subject.tagName === 'A') {
    subject.href = item.url
    subject.rel = 'noopener noreferrer'
    subject.addEventListener('click', (event) => { event.preventDefault(); openDooray(item) })
  }
  title.append(badge, subject)

  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = [item.taskNumber, item.actorName, formatTime(item.occurredAt), isChecked && item.acknowledgedAt ? `확인 ${formatTime(item.acknowledgedAt)}` : '']
    .filter(Boolean).join(' · ')

  const actions = document.createElement('div')
  actions.className = 'actions'
  if (backend.canOpenLinks && isDoorayUrl(item.url)) actions.append(button('Dooray에서 열기', () => openDooray(item)))
  if (item.projectId && item.postId) {
    if (backend.canOpenLinks) actions.append(button('새 대화로 이어가기', () => continueInNewChat(item)))
    if (backend.continueHere) actions.append(button('이 대화에서 이어가기', () => continueHere(item)))
  }

  row.append(checkCell, title, meta)
  if (item.excerpt) {
    const excerpt = document.createElement('div')
    excerpt.className = 'excerpt'
    excerpt.textContent = item.excerpt
    row.append(excerpt)
  }
  row.append(actions)
  return row
}

function renderList() {
  const list = element('list')
  const items = tab === 'open' ? current.items : current.checked
  list.replaceChildren(...items.map((item) => renderItem(item, tab === 'checked')))
  if (!items.length) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    if (tab === 'checked') empty.textContent = '숨긴 항목이 없습니다.'
    else if (!current.presentedAt && current.scan?.status === 'scanning') empty.textContent = '처음 확인하는 중입니다. 잠시만 기다려 주세요.'
    else if (!current.presentedAt) empty.textContent = '아직 확인한 적이 없습니다. 새로고침을 눌러 주세요.'
    else empty.textContent = '확인할 새 항목이 없습니다.'
    list.append(empty)
  }
  element('tab-open').setAttribute('aria-selected', String(tab === 'open'))
  element('tab-checked').setAttribute('aria-selected', String(tab === 'checked'))
}

function render(error) {
  renderHeader()
  renderStatus(error)
  renderList()
}

async function load({ refresh }) {
  clearTimeout(pollTimer)
  try {
    const state = await backend.state({ refresh, days: selectedDays() })
    current = { items: [], checked: [], checkedTotal: 0, ...state, scan: state.scan ?? { status: 'idle' } }
    render()
    if (current.scan.status === 'scanning') pollTimer = setTimeout(() => load({ refresh: false }), POLL_MS)
  } catch (error) {
    render(error?.message ?? String(error))
  }
}

async function setChecked(item, checked) {
  pending.add(item.key)
  renderList()
  try {
    await backend.check([item.key], checked)
    if (checked) {
      current.items = current.items.filter((candidate) => candidate.key !== item.key)
      current.checked = [{ ...item, acknowledgedAt: new Date().toISOString() }, ...current.checked]
      current.checkedTotal = (current.checkedTotal ?? 0) + 1
      toast('확인 처리했습니다. 숨긴 항목에서 되돌릴 수 있습니다.')
    } else {
      current.checked = current.checked.filter((candidate) => candidate.key !== item.key)
      current.checkedTotal = Math.max(0, (current.checkedTotal ?? 1) - 1)
      current.items = [{ ...item, acknowledgedAt: undefined }, ...current.items]
        .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
      toast('확인할 항목으로 되돌렸습니다.')
    }
    pending.delete(item.key)
    render()
  } catch (error) {
    pending.delete(item.key)
    render(error?.message ?? String(error))
  }
}

async function openDooray(item) {
  if (!isDoorayUrl(item.url)) return
  try { await backend.openDooray(item.url) } catch (error) { toast(error?.message ?? String(error)) }
}

async function continueInNewChat(item) {
  try {
    await backend.openNewChat(claudeNewChatUrl(buildContinuePrompt(item)))
    toast('Claude 새 대화 입력창에 요청을 채웠습니다. 확인하고 보내 주세요.')
  } catch (error) { toast(error?.message ?? String(error)) }
}

async function continueHere(item) {
  try {
    await backend.continueHere(buildContinuePrompt(item))
    toast('이 대화에 요청을 보냈습니다.')
  } catch (error) { toast(error?.message ?? String(error)) }
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme
}

function bindControls() {
  element('refresh').addEventListener('click', () => load({ refresh: true }))
  element('days').addEventListener('change', () => load({ refresh: true }))
  element('tab-open').addEventListener('click', () => { tab = 'open'; renderList() })
  element('tab-checked').addEventListener('click', () => { tab = 'checked'; renderList() })
  element('browser').addEventListener('click', async () => {
    if (!current.browserUrl) return
    try {
      const result = await app.openLink({ url: current.browserUrl })
      if (result?.isError) throw new Error('브라우저를 열 수 없습니다.')
      toast('브라우저에서 열었습니다. 북마크해 두면 다음에 바로 열 수 있습니다.')
    } catch (error) { toast(error?.message ?? String(error)) }
  })
}

async function start() {
  if (mode === 'app') document.body.classList.add('app')
  bindControls()
  render()
  if (mode === 'app') {
    app = new App({ name: 'dooray-mention-inbox', version: '0.2.0' })
    app.onhostcontextchanged = (context) => applyTheme(context?.theme)
    // 확인함 열기 도구의 결과는 안내 문구뿐이라 화면에서는 쓰지 않는다.
    app.ontoolresult = () => {}
    await app.connect()
    applyTheme(app.getHostContext()?.theme)
    const capabilities = app.getHostCapabilities() ?? {}
    backend.canOpenLinks = Boolean(capabilities.openLinks)
    if (!capabilities.message) backend.continueHere = null
  }
  // 저장된 마지막 목록을 먼저 보여 주고, 백그라운드에서 새로 확인한다.
  await load({ refresh: true })
}

start().catch((error) => render(error?.message ?? String(error)))
