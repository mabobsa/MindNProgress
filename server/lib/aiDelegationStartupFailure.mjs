// 접수된 위임의 시작 거부를 상위 보고 대상으로 만든다. 과거 실패의 일괄 재전송은 하지 않는다.
export function queuedDelegationFailureReportPatch(updates, at = new Date().toISOString()) {
  if (updates.state !== 'failed' || updates.childStatus !== 'rejected') return updates
  return { ...updates, state: 'waiting-parent', reportKind: 'startup-failure', startupFailedAt: at,
    failureReasonCode: updates.failureReasonCode ?? updates.workspaceWaitReasonCode ?? 'AI_DELEGATION_START_REJECTED',
    reportApprovalRequired: false, reportReceipt: null, reportWaitReason: null,
    workspaceWaitReasonCode: null, workspaceWaitMessage: null, workspaceWaitError: null }
}

export function isAiDelegationStartupFailure(delegation) {
  return delegation?.reportKind === 'startup-failure' && delegation.childStatus === 'rejected'
}

export function aiDelegationStartupFailureInstruction(delegation) {
  return `# MindNProgress 위임 시작 실패 알림

위임 접수 이후 시작 처리에서 오류가 발생했습니다. 접수 응답만으로 하위 AI의 실행·완료 여부를 판단하지 마세요.

- 위임 ID: ${delegation.id}
- 대상 문서: ${delegation.mapId}
- 상위 카드: ${delegation.parentCardLabel ?? delegation.parentCardId}
- 하위 카드: ${delegation.targetCardLabel ?? delegation.targetCardId} (${delegation.targetCardId})
- 대상 대화: ${delegation.targetConversationId || '생성 전'}
- 실패 코드: ${delegation.failureReasonCode}
- 원인: ${delegation.childError ?? '상세 원인 없음'}

이 알림은 완료 보고가 아닙니다. 사용자에게 시작 처리 실패와 위 원인을 알리세요.
최신 위임·카드·작업공간 상태와 동일 작업의 후속 위임 여부를 조회한 뒤 해결 방안을 판단하세요. 전송 결과가 불명확한 오류는 실제 실행 상태부터 대사하세요. 기존 요청의 반복 호출이나 자동 재위임으로 중복 작업을 만들지 마세요.`
}
