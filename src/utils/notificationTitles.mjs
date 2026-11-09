export function notificationDelegationReference(notification) {
  if (notification?.type !== 'ai-delegation') return null
  if (notification.delegationId) return { id: notification.delegationId, kind: notification.delegationKind }
  // 기존 알림도 마이그레이션 없이 연결한다. 위임 ID 자체에 ':'가 들어갈 수 있다.
  const match = /^ai-delegation-(checkpoint|recovery|integration-clean):(.+):[^:]+$/u.exec(notification.dedupeKey ?? '')
  return match ? { id: match[2], kind: match[1] } : null
}

export function updateDelegationNotificationStatuses(notifications, status) {
  if (!status?.id) return notifications
  return notifications.map((notification) => {
    if (notificationDelegationReference(notification)?.id !== status.id) return notification
    const current = notification.delegationStatus
    if (current?.updatedAt && status.updatedAt && current.updatedAt > status.updatedAt) return notification
    return { ...notification, delegationStatus: status }
  })
}

// 발생 당시 알림과 현재 처리 상태를 구분한다. 완료 알림을 새로 만들지는 않는다.
export function notificationTitle(notification) {
  const actor = String(notification?.actor?.name ?? '').trim()
  switch (notification?.type) {
    case 'assignment':
      return `${actor}님이 담당자로 지정했습니다.`
    case 'schedule':
      return '담당 업무 일정 알림'
    case 'waiting-released':
      return `${actor}님이 외부 대기를 해제했습니다.`
    case 'ai-delegation': {
      const status = notification.delegationStatus?.status
      if (status === 'resolved') return '✅ AI 위임 알림 · 해결됨'
      if (status === 'ended') return 'AI 위임 알림 · 종료됨'
      if (status === 'action-required') return '⛔ AI 위임 · 사용자 조치 필요'
      if (status === 'report-pending') return 'AI 위임 · 결과 전달 대기'
      if (status === 'unknown') return 'AI 위임 알림 · 상태 확인 필요'
      const kind = notificationDelegationReference(notification)?.kind
      if (kind === 'checkpoint') return '⏳ AI 위임 자동 보완 중'
      if (status === 'in-progress') return kind === 'recovery' ? '⏳ AI 위임 복구 진행 중' : '⏳ AI 위임 진행 중'
      return 'AI 위임 알림'
    }
    case 'ai-delegation-completed':
      return '✅ AI 위임 완료 알림'
    case 'mention':
      return `${actor}님이 회원님을 멘션했습니다.`
    case 'reply':
      return `${actor}님이 답글을 남겼습니다.`
    default:
      return `${actor}님이 댓글을 남겼습니다.`
  }
}
