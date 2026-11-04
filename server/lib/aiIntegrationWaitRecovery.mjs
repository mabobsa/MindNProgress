import { activeAiDelegationsForConversation, aiDelegationAttemptHistory } from './aiDelegations.mjs'
import { integrationRecoveryPending } from './aiIntegrationRecovery.mjs'

// 구버전이 대기 결과를 null로 덮어쓴 정확한 오류만 복원한다. 일반 실패를 자동 재실행하지 않는다.
export function lostIntegrationWaitCandidate(delegation) {
  return delegation?.state === 'failed' && delegation.childStatus === 'completed' && !delegation.childError
    && delegation.workspaceResult === null
    && delegation.workspaceError === '통합 작업공간의 Git 상태 확인이 지연되어 다음 폴링에서 다시 시도합니다.'
    && Boolean(delegation.workspaceLease?.leaseId) && !delegation.workspaceLease.ownership
    && !delegation.pendingRecovery && !delegation.resultCorrection && !integrationRecoveryPending(delegation)
    && !delegation.integrationOperationId
}

export async function reconcileLostIntegrationWaits({ values, get, workspacePool, update, warn = console.warn }) {
  for (const delegation of values()) {
    if (!lostIntegrationWaitCandidate(delegation)) continue
    if (activeAiDelegationsForConversation(values(), { mapId: delegation.mapId, targetCardId: delegation.targetCardId,
      targetConversationId: delegation.targetConversationId, excludeId: delegation.id }).length) continue
    if ([...values()].some(other => other.id !== delegation.id && other.workspaceLease?.leaseId === delegation.workspaceLease.leaseId
      && !['completed', 'failed', 'closed', 'superseded', 'cancelled'].includes(other.state))) continue
    try {
      const result = await workspacePool.verifiedWaitingIntegrationResult(delegation.workspaceLease.leaseId, {
        mapId: delegation.mapId, cardId: delegation.targetCardId, conversationId: delegation.targetConversationId,
        expectedLease: delegation.workspaceLease,
      })
      if (!result || get(delegation.id) !== delegation) continue
      const at = new Date().toISOString()
      await update(delegation.id, {
        state: 'waiting-integration', workspaceResult: result, workspaceError: null, completedAt: null,
        parentDispatchState: null, parentTurnId: null, parentError: null, parentResource: null, wakeOperationId: null,
        reportReceipt: null, reportWaitReason: null, reportArchive: null, parentWakeRetry: null, parentRuntimeObservation: null,
        reportPayloadHash: null, reportResultAvailability: null, reportResultHash: null, reportResultTurnId: null, reportPreparedAt: null,
        attemptHistory: aiDelegationAttemptHistory(delegation, 'Git 조회 시간 초과로 유실된 통합 대기를 보존된 lease·세션·체크포인트 대사 후 복구', at),
        integrationWaitRecovery: { at, previousState: delegation.state, previousError: delegation.workspaceError,
          previousCompletedAt: delegation.completedAt, leaseId: delegation.workspaceLease.leaseId, headCommit: result.headCommit },
      })
    } catch (error) {
      warn('[AI delegation integration wait recovery]', { delegationId: delegation.id, error: error?.message ?? String(error) })
    }
  }
}
