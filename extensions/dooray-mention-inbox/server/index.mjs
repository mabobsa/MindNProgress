import { spawn } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'

import {
  DEFAULT_DOORAY_API_BASE_URL,
  DEFAULT_DOORAY_WEB_HOSTNAME,
  DEFAULT_RANGE_DAYS,
  KIND_LABELS,
  createInbox,
  defaultStateDirectory,
  parseProjectCodes,
} from './inbox.mjs'
import { formatTime } from '../shared/inbox-shared.mjs'
import { SERVER_NAME, SERVER_VERSION, UI_RESOURCE_URI } from './version.mjs'
import { startWebServer } from './web.mjs'

export { SERVER_NAME, SERVER_VERSION, UI_RESOURCE_URI, formatTime }

// 확장 프로그램 설치 화면에서 받은 값은 환경 변수로 들어온다. 선택 항목을 비워 두면 치환되지 않은 문자열이 올 수 있어 빈 값으로 본다.
const setting = (name) => {
  const value = String(process.env[name] ?? '').trim()
  return value.startsWith('${') ? '' : value
}

const instructions = [
  'Dooray 멘션 확인함은 사용자가 멘션되거나 담당·참조로 지정된 Dooray 업무와 댓글을 모아 보고, 확인한 항목을 숨기는 도구입니다.',
  '사용자가 Dooray 멘션·확인함·확인할 업무·놓친 댓글을 물으면 open_dooray_mention_inbox로 확인함 화면을 여세요. 사용자는 화면에서 직접 확인 체크, 숨긴 항목 되돌리기, Dooray 원문 열기, AI 대화로 이어가기를 합니다.',
  '화면이 표시되지 않는 환경이거나 사용자가 브라우저로 보자고 하면 open_dooray_mention_inbox에 browser=true를 전달하세요. 채팅으로 목록을 보여 달라고 하면 list_dooray_mentions를 쓰세요.',
  'list_dooray_mentions가 수집 중이라고 답하면 사용자에게 진행 상황을 알리세요. 다시 호출하면 이어서 기다리거나 완성된 목록을 받습니다.',
  '확인 처리(숨김)는 사용자가 특정 항목을 확인했다고 말할 때만 check_dooray_mentions로 하세요. 목록을 보여 줬다는 이유만으로 확인 처리하지 마세요. 번호는 가장 최근 채팅 목록 기준입니다.',
  '사용자가 항목을 자세히 보거나 이어서 이야기하자고 하면 get_dooray_task_detail로 업무 본문과 댓글을 읽고 그 내용을 바탕으로 대화를 이어가세요.',
].join('\n')

// Windows 기본 브라우저로 로컬 주소를 연다. 셸을 거치지 않아 주소 문자가 명령으로 해석되지 않는다.
function openInDefaultBrowser(url) {
  if (process.platform !== 'win32') throw new Error('브라우저 열기는 Windows에서만 지원합니다.')
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

function itemLine(item, prefix) {
  const label = KIND_LABELS[item.kind] ?? item.kind ?? ''
  const subject = item.subject || '(제목 없음)'
  const meta = [item.taskNumber, item.actorName, formatTime(item.occurredAt)].filter(Boolean).join(' · ')
  const ids = [
    item.projectId && `projectId=${item.projectId}`,
    item.postId && `postId=${item.postId}`,
    item.commentId && `commentId=${item.commentId}`,
    `key=${item.key}`,
  ].filter(Boolean).join(' ')
  return [
    `${prefix} [${label}] ${subject}${meta ? ` — ${meta}` : ''}`,
    ...(item.excerpt ? [`   ${item.excerpt}`] : []),
    ...(item.url ? [`   ${item.url}`] : []),
    `   (${ids})`,
  ].join('\n')
}

const text = (value) => ({ content: [{ type: 'text', text: value }] })
const failure = (error) => ({ isError: true, content: [{ type: 'text', text: `오류: ${error?.message ?? String(error)}` }] })

export function defaultInboxFactory() {
  return createInbox({
    apiKey: setting('DOORAY_API_TOKEN'),
    baseUrl: setting('DOORAY_API_BASE_URL') || DEFAULT_DOORAY_API_BASE_URL,
    webHostname: setting('DOORAY_WEB_HOSTNAME') || DEFAULT_DOORAY_WEB_HOSTNAME,
    projectCodes: parseProjectCodes(setting('DOORAY_MENTION_PROJECT_CODES')),
    stateDirectory: defaultStateDirectory(),
  })
}

export function createServer({
  getInbox = (() => { let inbox = null; return () => (inbox ??= defaultInboxFactory()) })(),
  uiHtml = '',
  getBrowserUrl = () => null,
  openBrowser = openInDefaultBrowser,
} = {}) {
  // 목록 도구가 한 번에 기다리는 최대 시간. 클라이언트의 도구 응답 제한보다 짧게 둔다.
  const listWaitMs = Math.max(0, Number(setting('DOORAY_MENTION_WAIT_MS')) || 45_000)
  // 토큰이 없어도 서버는 시작해 도구 목록을 보여 주고, 호출 시 설정 안내를 돌려준다(getInbox가 그때 오류를 던진다).
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions })

  // 대화창 안에 표시할 확인함 화면(MCP Apps). 화면은 외부 주소를 불러오지 않고 서버 도구만 호출한다.
  registerAppResource(server, 'Dooray 멘션 확인함', UI_RESOURCE_URI, {
    description: 'Dooray 멘션·담당·참조 항목을 확인하고 숨기는 화면',
  }, async () => ({ contents: [{ uri: UI_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: uiHtml }] }))

  registerAppTool(server, 'open_dooray_mention_inbox', {
    title: 'Dooray 멘션 확인함 열기',
    description: 'Dooray 멘션 확인함 화면을 대화창 안에 엽니다. 사용자는 화면에서 확인 체크·숨긴 항목 되돌리기·원문 열기·AI 대화로 이어가기를 직접 합니다. browser=true이면 같은 화면을 이 PC의 기본 브라우저로도 엽니다.',
    inputSchema: { browser: z.boolean().optional().describe('true이면 기본 브라우저로 확인함 화면을 엶') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
  }, async ({ browser = false }) => {
    try {
      const url = getBrowserUrl()
      if (browser) {
        if (!url) return failure(new Error('브라우저 화면을 열 수 없습니다. 확장 프로그램을 다시 시작한 뒤 시도해 주세요.'))
        openBrowser(url)
        return text('기본 브라우저에서 Dooray 멘션 확인함을 열었습니다. 화면을 북마크해 두면 Claude 앱이 켜져 있는 동안 바로 열 수 있습니다.')
      }
      return text('Dooray 멘션 확인함 화면을 열었습니다. 화면에서 항목을 확인 체크하거나 AI 대화로 이어갈 수 있습니다. 화면이 보이지 않으면 브라우저로 열어 달라고 요청하세요.')
    } catch (error) { return failure(error) }
  })

  // 화면 전용 도구: 저장된 목록과 백그라운드 수집 진행률을 구조화 데이터로 돌려준다. AI에게는 보이지 않는다.
  registerAppTool(server, 'dooray_inbox_state', {
    title: 'Dooray 멘션 확인함 화면 상태',
    description: '확인함 화면이 목록·숨긴 항목·수집 진행률을 읽는 데 쓰는 도구입니다.',
    inputSchema: {
      refresh: z.boolean().optional().describe('true이면 Dooray에서 새로 수집을 시작'),
      days: z.number().int().min(1).max(180).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: UI_RESOURCE_URI, visibility: ['app'] } },
  }, async ({ refresh = false, days }) => {
    try {
      const state = await getInbox().uiState({ refresh, days })
      return {
        content: [{ type: 'text', text: `확인할 항목 ${state.items.length}건, 숨긴 항목 ${state.checkedTotal}건, 수집 상태 ${state.scan.status}` }],
        structuredContent: { ...state, browserUrl: getBrowserUrl() },
      }
    } catch (error) { return failure(error) }
  })

  server.registerTool('list_dooray_mentions', {
    title: 'Dooray 멘션 확인함 목록',
    description: '내가 멘션된 Dooray 업무 본문·댓글과 담당·참조로 지정된 업무, 그 업무의 새 댓글 중 아직 확인 처리하지 않은 항목을 최신순 번호 목록으로 돌려줍니다. 처음 확인하거나 기간을 늘리면 수집에 수 분이 걸릴 수 있어, 최대 약 45초 기다린 뒤 끝나지 않았으면 진행 상황을 돌려주고 수집은 백그라운드에서 계속합니다.',
    inputSchema: { days: z.number().int().min(1).max(180).optional().describe(`조회할 최근 기간(일). 기본 ${DEFAULT_RANGE_DAYS}일`) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ days }, extra) => {
    try {
      const progressToken = extra?._meta?.progressToken
      let step = 0
      let lastSentAt = 0
      const phaseLabels = { me: '사용자 확인', projects: '프로젝트 확인', posts: '업무 목록 조회', details: '업무 상세 확인', members: '작성자 확인', done: '완료' }
      const onProgress = progressToken === undefined ? undefined : ({ phase, done, total }) => {
        const nowMs = Date.now()
        if (phase !== 'done' && nowMs - lastSentAt < 1_000) return
        lastSentAt = nowMs
        step += 1
        void extra.sendNotification({ method: 'notifications/progress',
          params: { progressToken, progress: step, message: `${phaseLabels[phase] ?? phase} ${done}/${total}` } }).catch(() => {})
      }
      const result = await getInbox().listWithin({ days, waitMs: listWaitMs, onProgress })
      if (result.status === 'scanning') {
        const { phase, done, total } = result.progress
        return text([
          `Dooray 업무를 모으는 중입니다(최근 ${result.rangeDays}일). 현재 단계: ${phaseLabels[phase] ?? phase} ${done}/${total}`,
          '처음 확인하거나 기간을 늘리면 참여 중인 프로젝트의 업무를 모두 확인하느라 수 분이 걸릴 수 있습니다. 다음부터는 바뀐 업무만 확인해 빨라집니다.',
          '수집은 백그라운드에서 계속됩니다. 사용자에게 진행 상황을 알리고, list_dooray_mentions를 다시 호출하면 이어서 기다리거나 완성된 목록을 받을 수 있습니다.',
          ...(result.requestedDays !== result.rangeDays ? [`요청한 ${result.requestedDays}일이 아니라 이미 진행 중인 ${result.rangeDays}일 수집을 기다리는 중입니다. 끝난 뒤 다시 요청하세요.`] : []),
        ].join('\n'))
      }
      const header = `Dooray 멘션 확인함 — 최근 ${result.rangeDays}일, 확인할 항목 ${result.items.length}건`
        + (result.hiddenCount ? ` (확인 처리해 숨긴 항목 ${result.hiddenCount}건 제외)` : '')
        + `\n조회: 프로젝트 ${result.projectCount}개, 업무 ${result.scannedPostCount}건${result.failureCount ? `, 조회 실패 ${result.failureCount}건` : ''}`
      const body = result.items.length
        ? result.items.map((item) => itemLine(item, `${item.no}.`)).join('\n')
        : '확인할 새 항목이 없습니다.'
      return text(`${header}\n\n${body}`)
    } catch (error) { return failure(error) }
  })

  server.registerTool('check_dooray_mentions', {
    title: 'Dooray 멘션 확인 처리',
    description: '사용자가 확인했다고 말한 항목을 확인 처리해 이후 목록에서 숨기거나(checked=true), 숨긴 항목을 되돌립니다(checked=false). numbers는 가장 최근 list_dooray_mentions 결과의 번호이고, keys는 목록·숨긴 항목에 표시된 key입니다. 사용자의 요청 없이 호출하지 마세요.',
    inputSchema: {
      numbers: z.array(z.number().int().min(1)).max(200).optional().describe('가장 최근 목록의 항목 번호'),
      keys: z.array(z.string().min(1).max(200)).max(200).optional().describe('항목 key'),
      checked: z.boolean().optional().describe('true(기본)는 확인 처리해 숨김, false는 숨김 해제'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ numbers = [], keys = [], checked = true }) => {
    try {
      if (!numbers.length && !keys.length) return failure(new Error('확인 처리할 번호나 key를 지정하세요.'))
      const result = await getInbox().setChecked({ numbers, keys, checked })
      const verb = checked ? '확인 처리(숨김)' : '숨김 해제'
      const lines = [`${verb}: ${result.changed.length}건`]
      for (const item of result.changed) lines.push(`- ${item.subject || item.key}${item.url ? ` ${item.url}` : ''}`)
      if (result.unchanged.length) lines.push(`이미 ${checked ? '확인 처리된' : '숨겨지지 않은'} 항목: ${result.unchanged.length}건`)
      if (result.unknownNumbers.length) lines.push(`최근 목록에 없는 번호: ${result.unknownNumbers.join(', ')} (목록을 다시 조회한 뒤 지정하세요)`)
      return text(lines.join('\n'))
    } catch (error) { return failure(error) }
  })

  server.registerTool('get_dooray_task_detail', {
    title: 'Dooray 업무 상세',
    description: '목록 항목의 Dooray 업무 제목·상태·담당자·본문과 최근 댓글(최대 100개)을 읽습니다. 사용자가 항목을 자세히 보거나 이어서 이야기하려 할 때 사용합니다.',
    inputSchema: {
      projectId: z.string().regex(/^\d+$/).describe('목록에 표시된 projectId'),
      postId: z.string().regex(/^\d+$/).describe('목록에 표시된 postId'),
      commentId: z.string().regex(/^\d+$/).optional().describe('댓글 항목이면 commentId'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ projectId, postId, commentId }) => {
    try {
      const result = await getInbox().detail({ projectId, postId, commentId })
      const people = [
        result.author && `작성자: ${result.author}`,
        result.assignees.length && `담당: ${result.assignees.join(', ')}`,
        result.cc.length && `참조: ${result.cc.join(', ')}`,
      ].filter(Boolean).join(' / ')
      const lines = [
        `# ${result.subject || '(제목 없음)'}${result.taskNumber ? ` (${result.taskNumber})` : ''}`,
        `링크: ${result.url}`,
        `상태: ${result.workflow || '-'}${result.closed ? ' (완료)' : ''}${result.dueDate ? ` / 마감: ${result.dueDate}` : ''}`,
        ...(people ? [people] : []),
        '',
        '## 본문',
        result.body || '(본문 없음)',
        ...(result.bodyTruncated ? ['(본문이 길어 앞부분만 표시했습니다. 전체는 링크에서 확인하세요.)'] : []),
        '',
        `## 댓글 ${result.comments.length}개${result.commentsTruncated ? ' (최근 댓글만 표시)' : ''}`,
        ...result.comments.map((comment) => [
          `### ${comment.author || '(이름 없음)'} · ${formatTime(comment.createdAt)}${comment.id === result.focusCommentId ? ' ← 목록에서 선택한 댓글' : ''}`,
          comment.text || '(내용 없음)',
        ].join('\n')),
      ]
      return text(lines.join('\n'))
    } catch (error) { return failure(error) }
  })

  return server
}

export async function main({ uiHtml = '' } = {}) {
  let inbox = null
  const getInbox = () => (inbox ??= defaultInboxFactory())
  // 브라우저 화면은 실패해도 대화창 안 화면과 채팅 도구는 계속 쓸 수 있으므로 서버 시작을 막지 않는다.
  let web = null
  try {
    web = await startWebServer({ getInbox, html: uiHtml, stateDirectory: defaultStateDirectory(), log: (message) => console.error(`[dooray-mention-inbox] ${message}`) })
  } catch (error) {
    console.error('[dooray-mention-inbox] 브라우저 화면을 시작하지 못했습니다:', error?.message ?? error)
  }
  const server = createServer({ getInbox, uiHtml, getBrowserUrl: () => web?.url ?? null })
  await server.connect(new StdioServerTransport())
}
