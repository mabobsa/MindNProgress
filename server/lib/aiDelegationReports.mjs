import { aiDelegationReportResult, aiDelegationSucceeded } from './aiDelegations.mjs'

const reportStates = new Set(['waiting-parent', 'waking-parent', 'parent-wake-failed'])
const sha256 = /^[a-f0-9]{64}$/

function receivedPatch(receipt) {
  return {
    state: 'completed', reportReceipt: receipt, reportWaitReason: null,
    reportApprovalRequired: false, parentError: null, completedAt: receipt.at,
  }
}

// 실행 요청 접수(starting/자원 대기)와 실제 상위 턴에 전달된 결과를 구분한다.
// 상위 턴의 성공/실패는 별도 대화 상태다. 결과 전달 뒤 장시간 실행하거나
// 사용자가 중지해도 이미 전달된 하위 결과를 미보고/실패로 되돌리지 않는다.
export function aiDelegationDeliveredReportPatch(delegation, dispatch, at = new Date().toISOString()) {
  if (!reportStates.has(delegation?.state) || !aiDelegationSucceeded(delegation) || delegation.pendingRecovery) return null
  if (!delegation.wakeOperationId || !sha256.test(delegation.reportPayloadHash ?? '')) return null
  if (dispatch?.conversationId !== delegation.parentConversationId
    || (dispatch.operationId && dispatch.operationId !== delegation.wakeOperationId)) return null
  if (!['running', 'completed', 'waiting_resume', 'waiting-resume'].includes(dispatch.state)) return null
  const turnId = String(dispatch.turnId ?? '').trim()
  if (!turnId || (delegation.parentTurnId && delegation.parentTurnId !== turnId)) return null
  const result = aiDelegationReportResult(delegation)
  if (delegation.reportResultAvailability === 'captured'
    && (result.availability !== 'captured' || delegation.reportResultHash !== result.hash
      || delegation.reportResultTurnId !== result.turnId)) return null
  return {
    ...receivedPatch({
      at, method: 'dispatch-delivered', parentConversationId: delegation.parentConversationId,
      parentTurnId: turnId, operationId: delegation.wakeOperationId,
      payloadHash: delegation.reportPayloadHash, resultHash: delegation.reportResultHash ?? null,
      childTurnId: delegation.childTurnId ?? null,
    }),
    parentTurnId: turnId, parentDispatchState: dispatch.state,
  }
}

export function aiDelegationStoredReportDeliveryPatch(delegation) {
  return aiDelegationDeliveredReportPatch(delegation, {
    operationId: delegation?.wakeOperationId, conversationId: delegation?.parentConversationId,
    state: delegation?.parentDispatchState, turnId: delegation?.parentTurnId,
  })
}

// GET 조회는 수신 확인이 아니다. 담당 상위 AI가 읽은 정확한 결과의 해시를
// 명시한 POST에서만 대기 보고를 소비한다. 카드/작업공간/승인은 변경하지 않는다.
export function acknowledgeAiDelegationReport(delegation, { conversationId, resultHash }, at = new Date().toISOString()) {
  const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status, code: 'AI_DELEGATION_REPORT_ACK_REJECTED', groupProjectError: true }) }
  if (!conversationId || conversationId !== delegation?.parentConversationId) fail('이 위임을 시작한 상위 AI 대화만 결과 수신을 확인할 수 있습니다.', 403)
  if ((!reportStates.has(delegation.state) && !(delegation.state === 'completed' && delegation.reportReceipt))
    || !aiDelegationSucceeded(delegation) || delegation.pendingRecovery) fail('하위 실행과 통합이 완료된 결과만 수신 확인할 수 있습니다.')
  const result = aiDelegationReportResult(delegation)
  if (!sha256.test(resultHash ?? '') || result.availability !== 'captured' || !result.turnId || result.hash !== resultHash) fail('읽은 결과의 해시 또는 실행 턴이 현재 위임 결과와 일치하지 않습니다. 결과 원문을 다시 조회하세요.')
  if (delegation.reportReceipt) {
    if (delegation.state !== 'completed' || delegation.reportReceipt.parentConversationId !== conversationId
      || delegation.reportReceipt.resultHash !== resultHash || delegation.reportReceipt.childTurnId !== result.turnId) fail('기존 수신 확인과 현재 결과가 일치하지 않습니다.')
    return {}
  }
  return receivedPatch({
    at, method: 'parent-acknowledged', parentConversationId: conversationId,
    resultHash, childTurnId: result.turnId,
  })
}

export function aiDelegationReportStatus(delegation) {
  if (delegation?.state === 'completed') return 'received'
  if (delegation?.state === 'parent-wake-failed') return 'failed'
  if (delegation?.state === 'waiting-parent') return 'waiting'
  if (delegation?.state === 'waking-parent') {
    return aiDelegationStoredReportDeliveryPatch(delegation) ? 'received' : 'delivering'
  }
  return null
}
