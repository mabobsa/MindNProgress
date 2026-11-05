// 서버와 화면(대화창 안 화면·브라우저 화면)이 함께 쓰는 순수 함수. Node·브라우저 전용 API를 쓰지 않는다.

export const KIND_LABELS = Object.freeze({
  'mention-body': '본문 멘션',
  'mention-comment': '댓글 멘션',
  assigned: '담당 지정',
  cc: '참조 지정',
  'related-comment': '관련 댓글',
})

const timeFormat = new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// 이 컴퓨터의 시간대로 "11-03 21:00" 형식을 만든다.
export function formatTime(value) {
  const time = Date.parse(String(value ?? ''))
  if (!Number.isFinite(time)) return ''
  const parts = Object.fromEntries(timeFormat.formatToParts(new Date(time)).map((part) => [part.type, part.value]))
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

// Dooray 원문 링크만 열도록 확인한다. 화면에 들어오는 값은 외부 데이터이므로 javascript: 같은 주소를 막는다.
export function isDoorayUrl(value) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'https:' && /(^|\.)dooray\.com$/i.test(url.hostname)
  } catch {
    return false
  }
}

// "AI 대화로 이어가기"에서 Claude 입력창에 미리 채울 요청. 자동 전송되지 않으므로 사용자가 확인하고 보낸다.
export function buildContinuePrompt(item) {
  const kind = KIND_LABELS[item?.kind] ?? ''
  const ids = [`projectId=${item?.projectId}`, `postId=${item?.postId}`, ...(item?.commentId ? [`commentId=${item.commentId}`] : [])].join(' ')
  return [
    'Dooray 멘션 확인함에서 이어서 이야기할 업무입니다. get_dooray_task_detail로 업무 본문과 댓글을 읽고 내용을 정리해 주세요.',
    `- 업무: ${item?.subject || '(제목 없음)'}${item?.taskNumber ? ` (${item.taskNumber})` : ''}`,
    ...(kind ? [`- 종류: ${kind}`] : []),
    ...(item?.url ? [`- 링크: ${item.url}`] : []),
    `- 조회 정보: ${ids}`,
  ].join('\n')
}

// Claude 데스크톱 새 대화를 여는 링크. https://support.claude.com/en/articles/14729294
export function claudeNewChatUrl(prompt) {
  return `claude://claude.ai/new?q=${encodeURIComponent(String(prompt ?? ''))}`
}
