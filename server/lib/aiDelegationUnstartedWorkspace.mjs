import { assignmentMatches } from './remoteWorkspaceProtocol.mjs'

// dispatch 전송 전에만 발생하는 실패 코드다. 전송 이후의 실패·미확정 응답은 여기에 넣지 않는다.
const PRE_DISPATCH_FAILURE = /^(AI_DELEGATION_POLICY_RUNTIME_[A-Z_]+|AI_DELEGATION_PRIMARY_CHANGED)$/

// 격리된 원격 lease를 결과 없이 반환해도 되는지 위임 기록으로 확인한다.
// 하위 turn·결과·복구·재개 기록이 하나라도 있으면 실행 흔적이 있을 수 있으므로 반환하지 않는다.
// Core의 operation 부재 조회와 Runner의 worker 상태 확인은 호출하는 쪽에서 별도로 대조한다.
export function aiDelegationUnstartedWorkspaceEvidence(delegation, lease, { machineId } = {}) {
  const saved = delegation?.workspaceLease
  return Boolean(delegation && saved && lease && machineId
    && delegation.id === lease.requestId && (delegation.childOperationId ?? delegation.id) === delegation.id
    && delegation.state === 'failed' && delegation.childStatus === 'rejected'
    && PRE_DISPATCH_FAILURE.test(String(delegation.failureReasonCode ?? ''))
    && delegation.targetHomeMachineId === machineId && lease.ownership?.machineId === machineId
    && delegation.mapId === lease.mapId && delegation.targetCardId === lease.cardId
    && (!lease.conversationId || lease.conversationId === delegation.targetConversationId)
    && assignmentMatches(saved, lease)
    && !delegation.childTurnId && !delegation.childResultHash && !delegation.childResultSnapshot && !delegation.childResultTurnId
    && !delegation.workspaceResult && !delegation.pendingRecovery && !delegation.resumesDelegationId
    && !Number(delegation.recoveryAttempt ?? 0) && !delegation.recoveryOperationId && !delegation.recoveryWorkspaceLease)
}
