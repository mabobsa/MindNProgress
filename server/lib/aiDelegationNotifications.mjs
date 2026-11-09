import { aiDelegationDisplayState, aiDelegationStateReason, aiDelegationSucceeded } from './aiDelegations.mjs'
import { notificationDelegationReference } from '../../src/utils/notificationTitles.mjs'

const actionRequiredStates = new Set([
  'failed', 'parent-wake-failed', 'recovery-required', 'integration-recovery-required',
  'waiting-child-resume', 'integration-waiting-resume', 'waiting-integration-clean',
  'waiting-usage-limit', 'waiting-rate-limit', 'waiting-model-capacity',
])

// 조회와 기존 위임 SSE에서만 계산한다. 알림 원문·읽음 여부나 위임 실행 상태는 변경하지 않는다.
export function aiDelegationNotificationStatus(delegation) {
  const state = aiDelegationDisplayState(delegation)
  const base = { id: delegation.id, state, updatedAt: delegation.updatedAt ?? delegation.completedAt ?? null }
  if (state === 'closed' || state === 'superseded') return { ...base, status: 'ended', message: aiDelegationStateReason(delegation).message }
  if (actionRequiredStates.has(state) || delegation.resultCorrection?.phase === 'held') {
    return { ...base, status: 'action-required', message: aiDelegationStateReason(delegation).message }
  }
  if (state === 'completed') {
    return aiDelegationSucceeded(delegation)
      ? { ...base, status: 'resolved', message: '알림 원인이 해결되었고 위임 작업과 결과 전달이 완료되었습니다.' }
      : { ...base, status: 'unknown', message: '완료 기록과 작업 결과가 일치하지 않습니다. 위임 상태를 확인해 주세요.' }
  }
  if (aiDelegationSucceeded(delegation) && ['waiting-parent', 'waking-parent'].includes(state)) {
    return { ...base, status: 'report-pending', message: '하위 작업은 완료됐으며 상위 AI에 결과를 전달하고 있습니다.' }
  }
  const reason = aiDelegationStateReason(delegation)
  return { ...base, status: reason.reasonCode === 'AI_DELEGATION_STATE_UNKNOWN' ? 'unknown' : 'in-progress', message: reason.message }
}

export function withAiDelegationNotificationStatus(notification, delegations, receipts) {
  if (notification.type !== 'ai-delegation') return notification
  let reference = notificationDelegationReference(notification)
  // 이전 한도 알림은 operationId에도 ':'가 들어갈 수 있으므로 저장된 키와 정확히 대조한다.
  if (!reference && notification.dedupeKey?.startsWith('ai-delegation-limit:')) {
    const record = [...delegations.values()].find((item) => item.limitNotificationKey === notification.dedupeKey)
    if (record) reference = { id: record.id, kind: 'limit' }
  }
  const delegation = reference && delegations.get(reference.id)
  const receipt = reference && receipts?.get(reference.id)
  const delegationStatus = delegation ? aiDelegationNotificationStatus(delegation)
    : receipt?.completedAt ? { id: reference.id, state: 'completed', status: 'resolved', updatedAt: receipt.completedAt,
      message: '위임 작업과 결과 전달이 완료되어 상세 이력이 정리된 알림입니다.' }
      : { id: reference?.id ?? null, state: null, status: 'unknown', updatedAt: null,
        message: '현재 위임 기록을 확인할 수 없습니다. 이 알림은 발생 당시의 기록입니다.' }
  return { ...notification, ...(reference ? { delegationId: reference.id, delegationKind: reference.kind } : {}), delegationStatus }
}
