import { createHash } from 'node:crypto'

const fail = (message, status = 409) => Object.assign(new Error(message), { status })

// 시작 응답과 완료 통보를 분리한다. 접수 불명확 상태에서 새 ticket을 발급하지 않는다.
export function createAionUiLaunchTracking({ now = Date.now } = {}) {
  const entries = new Map()
  const find = (key) => {
    const entry = entries.get(key)
    if (!entry || entry.expiresAt <= now()) throw fail('시작 확인 정보가 만료되었거나 서버가 재시작되었습니다. AionUi의 대화 목록을 먼저 확인해 주세요.', 404)
    return entry
  }
  return {
    register(key, ownerId, expiresAt) {
      for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id)
      entries.set(key, { ownerId, expiresAt, status: 'pending', error: '', conversationId: null })
    },
    read(key, ownerId) {
      const entry = find(key)
      if (entry.ownerId !== ownerId) throw fail('시작 확인 정보를 찾을 수 없습니다.', 404)
      return { status: entry.status, error: entry.error, conversationId: entry.conversationId,
        expiresAt: entry.expiresAt, launchUrl: entry.ticket?.launchUrl ?? null, desktopLaunchUrl: entry.ticket?.desktopLaunchUrl ?? null }
    },
    issue(key, payload, create) {
      const entry = find(key)
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      if (entry.payloadHash && entry.payloadHash !== hash) throw fail('이미 준비한 대화의 실행 옵션은 변경할 수 없습니다.')
      if (!entry.issuing) {
        entry.payloadHash = hash
        entry.issuing = Promise.resolve().then(create).then((ticket) => { entry.ticket = ticket; return ticket }, (error) => {
          entry.status = 'delivery-unknown'
          entry.error = 'AionUi 시작 정보의 발급 여부를 확인하지 못했습니다. 중복 실행을 피하기 위해 자동 재요청하지 않습니다.'
          throw error
        })
      }
      return entry.issuing
    },
    finish(key, status, body) {
      const entry = entries.get(key)
      if (!entry || entry.status === 'completed') return
      if (status >= 200 && status < 300 && body.conversationId) {
        Object.assign(entry, { status: 'completed', conversationId: body.conversationId, error: '' })
      } else if (status >= 400) {
        Object.assign(entry, { status: 'confirmation-failed', error: body.error || '생성된 대화의 연결 확인에 실패했습니다.' })
      }
    },
  }
}
