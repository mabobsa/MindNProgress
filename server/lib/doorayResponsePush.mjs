import { createHash } from 'node:crypto'
import { doorayProposalRevision } from './doorayResponseDecision.mjs'

const waitingStates = new Set(['needs-input', 'needs-approval'])
const pendingStates = new Set(['pending', 'sending'])
export const DOORAY_PUSH_MAX_ATTEMPTS = 5
export const DOORAY_PUSH_LIFETIME_MS = 30 * 60_000
const retryDelays = [15_000, 60_000, 180_000, 600_000]
const shorten = (value, length) => {
  const chars = Array.from(String(value ?? '').trim())
  return chars.length > length ? `${chars.slice(0, length).join('')}…` : chars.join('')
}

export function doorayPushEventId(job) {
  if (!waitingStates.has(job.status) || job.completedAt) return null
  const key = [job.id, job.attempt ?? 0, job.status, doorayProposalRevision(job)]
  return `dooray-${createHash('sha256').update(JSON.stringify(key)).digest('hex')}`
}

// 대응 상태와 같은 저장에 기록한다. 구형 대기 기록을 읽었다는 이유로 일괄 발송하지 않는다.
export function reconcileDoorayPush(job, previousEventId, now) {
  const eventId = doorayPushEventId(job)
  if (!eventId || job.settings?.pushEnabled !== true || !job.settings.pushMachineId) {
    if (pendingStates.has(job.pushNotification?.state)) job.pushNotification.state = 'cancelled'
    return
  }
  if (job.pushNotification?.eventId === eventId || eventId === previousEventId) return
  job.pushNotification = { eventId, machineId: job.settings.pushMachineId, state: 'pending',
    attempts: 0, createdAt: now, nextAttemptAt: now, error: '', errorCode: '' }
}

export function doorayPushDue(job, now) {
  return pendingStates.has(job.pushNotification?.state) && job.pushNotification.nextAttemptAt <= now
}

export function claimDoorayPush(job, now) {
  const notification = job.pushNotification
  if (!doorayPushDue(job, now)) return null
  if (notification.eventId !== doorayPushEventId(job) || job.settings?.pushEnabled !== true) {
    notification.state = 'cancelled'
    return null
  }
  if (notification.attempts >= DOORAY_PUSH_MAX_ATTEMPTS || now - notification.createdAt >= DOORAY_PUSH_LIFETIME_MS) {
    Object.assign(notification, { state: 'failed', errorCode: 'PUSH_RETRY_EXHAUSTED', error: '푸시 재시도 기한 또는 횟수를 초과했습니다.' })
    return null
  }
  Object.assign(notification, { state: 'sending', attempts: notification.attempts + 1, nextAttemptAt: now + 60_000 })
  return structuredClone(job)
}

export function buildDoorayResponsePush(job, originUrl) {
  const approval = job.status === 'needs-approval'
  const questions = job.decision?.questions ?? []
  const scope = job.decision?.approval
  const details = approval
    ? [shorten(scope?.title || job.proposal, 250), ...(scope?.scope ?? []).slice(0, 3).map(line => `• ${shorten(line, 350)}`)]
    : questions.length ? questions.slice(0, 3).map(line => `• ${shorten(line, 350)}`) : [shorten(job.proposal, 900)]
  if (!approval && questions.length > 3) details.push(`외 ${questions.length - 3}개 질문은 MnP에서 확인해 주세요.`)
  let webUrl
  try {
    const url = new URL('/', originUrl)
    if (url.protocol === 'https:' && !url.username && !url.password) {
      url.searchParams.set('doorayResponseId', job.id)
      webUrl = url.href
    }
  } catch { /* 공개 HTTPS 주소가 없으면 본문 알림만 전송한다. */ }
  return { machineId: job.pushNotification.machineId, eventId: job.pushNotification.eventId, revision: 1,
    kind: 'choice', title: approval ? 'AI 대응 제안이 승인 대기 중입니다' : 'AI 대응에 추가 답변이 필요합니다',
    body: [`업무: ${shorten(job.source.subject, 250)}`, '', ...details, '',
      approval ? 'MnP의 Dooray 참조에서 제안 범위를 확인하고 승인해 주세요.' : 'MnP의 Dooray 참조에서 추가 정보를 입력해 주세요.'].join('\n'),
    ...(job.route?.mapId ? { mapId: job.route.mapId, cardId: job.route.cardId } : {}), ...(webUrl ? { webUrl } : {}) }
}

const failureMessages = {
  RUNNER_OFFLINE: '알림을 보낼 PC의 Runner가 연결되어 있지 않습니다.',
  RUNNER_NOT_CONFIGURED: '알림을 보낼 PC의 Runner 설정이 필요합니다.',
  PUSH_RELAY_UNAVAILABLE: '알림을 보낼 PC의 AionUi 푸시 연결을 확인해 주세요.',
  FORBIDDEN: '알림을 보낼 PC의 사용 권한이 없습니다.',
  MACHINE_NOT_FOUND: '알림을 보낼 PC를 찾을 수 없습니다.',
  MACHINE_DISABLED: '알림을 보낼 PC가 비활성화되어 있습니다.',
  disabled: 'AionUi에서 휴대폰 푸시와 MnP 알림 받기를 켜 주세요.',
  device: 'AionUi에 활성 휴대폰이 연결되어 있지 않습니다.',
}

export function finishDoorayPush(job, claimed, failure, now) {
  const current = job.pushNotification
  if (current?.eventId !== claimed.eventId || current.attempts !== claimed.attempts || current.state !== 'sending') return
  if (!failure) {
    Object.assign(current, { state: 'queued', queuedAt: now, error: '', errorCode: '' })
    return
  }
  const code = String(failure.code ?? failure.reasonCode ?? 'PUSH_FAILED')
  const terminal = [400, 401, 403, 404, 409].includes(failure.status) || ['disabled', 'device'].includes(code)
    || current.attempts >= DOORAY_PUSH_MAX_ATTEMPTS || now - current.createdAt >= DOORAY_PUSH_LIFETIME_MS
  Object.assign(current, { state: terminal ? 'failed' : 'pending', errorCode: code,
    error: failureMessages[code] ?? '푸시를 접수하지 못했습니다. 연결 상태를 확인해 주세요.',
    nextAttemptAt: now + (retryDelays[current.attempts - 1] ?? 600_000) })
}

export function publicDoorayPush(job) {
  const value = job.pushNotification
  if (!value) return null
  return { state: value.state, machineId: value.machineId, attempts: value.attempts,
    error: value.error, errorCode: value.errorCode, queuedAt: value.queuedAt ?? null }
}
