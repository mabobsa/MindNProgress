import { aiDelegationClosureAvailability, aiDelegationIsTerminal, aiDelegationRecoveryAvailability } from './aiDelegations.mjs'

const REFERENCE_KEYS = ['conversationId', 'parentConversationId', 'targetConversationId', 'requestedConversationId', 'sourceConversationId', 'replyConversationId']
const RESOLVED_INSTRUCTION_STATES = new Set(['replied', 'failed', 'cancelled', 'closed', 'expired'])
const PRESERVED_WORKSPACE_RESULTS = new Set(['quarantined', 'waiting-integration'])
const FINISHED_LEASE_STATES = new Set(['completed', 'cancelled'])

const references = (item, conversationId) => REFERENCE_KEYS.some((key) => item?.[key] === conversationId)

// 끝난 실패 위임은 인계를 막지 않는다. 다만 재개·통합 재시도가 가능하거나 작업공간 결과가 보존된 실패는
// 인계 뒤 복구 보고가 이전 대화로 가지 않도록 계속 막는다(예: 시작 전에 거부되고 후속 위임이 완료한 실패는 막지 않는다).
function delegationBlocksHandoff(item, active) {
  if (!aiDelegationIsTerminal(item) || item.reportPending || item.pendingRecovery || active(item.id)) return true
  if (item.state !== 'failed') return false
  return aiDelegationRecoveryAvailability(item)?.recoveryAvailable === true
    || PRESERVED_WORKSPACE_RESULTS.has(item.workspaceResult?.status)
    || aiDelegationClosureAvailability(item)?.workspaceReleaseRequired === true
}

// 대화 인계(카드 후속 대화·서버 루트 인계)를 막는 진행 중 작업을 찾는다. 막는 항목의 종류·ID·상태를 돌려준다.
export function cardConversationHandoffBlockers(conversationId, {
  delegations = [], instructions = [], leases = [], excludedInstructionId = null,
  delegationActive = () => false, instructionActive = () => false,
} = {}) {
  const blockers = []
  for (const item of delegations) {
    if (references(item, conversationId) && delegationBlocksHandoff(item, delegationActive)) {
      blockers.push({ kind: 'delegation', id: item.id, state: item.state ?? null })
    }
  }
  // failed 그룹 지시는 폴링·재전송으로 다시 처리되지 않는 종료 상태라 인계를 막지 않는다.
  for (const item of instructions) {
    if (item.id !== excludedInstructionId && references(item, conversationId)
      && (!RESOLVED_INSTRUCTION_STATES.has(item.state) || instructionActive(item.id))) {
      blockers.push({ kind: 'group-instruction', id: item.id, state: item.state ?? null })
    }
  }
  for (const item of leases) {
    if (references(item, conversationId) && !FINISHED_LEASE_STATES.has(item.status)) {
      blockers.push({ kind: 'workspace-lease', id: item.leaseId ?? null, workspaceId: item.workspaceId ?? null, state: item.status ?? null })
    }
  }
  return blockers
}

export function cardConversationHandoffBlockersSummary(blockers, limit = 3) {
  const label = { delegation: '위임', 'group-instruction': '그룹 지시', 'workspace-lease': '작업공간' }
  const shown = blockers.slice(0, limit).map((item) => `${label[item.kind] ?? item.kind} ${item.id}(${item.state ?? '상태 미확인'})`)
  return blockers.length > limit ? `${shown.join(', ')} 외 ${blockers.length - limit}건` : shown.join(', ')
}
