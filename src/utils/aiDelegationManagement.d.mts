export type AiDelegationSummary = {
  id: string
  state: string
  displayState?: string
  mapId: string
  parentMapId?: string | null
  groupId?: string | null
  parentCardId: string
  parentCardLabel?: string
  targetCardId: string
  targetCardLabel?: string
  parentConversationId?: string
  targetConversationId?: string
  createdAt: string
  updatedAt: string
  childStatus?: string | null
  childError?: string | null
  parentDispatchState?: string | null
  parentError?: string | null
  result?: string
  resultAvailability?: 'captured' | 'unavailable' | 'integrity-failed'
  workCompleted?: boolean
  reportPending?: boolean
  workspaceLease?: { leaseId?: string } | null
  workspaceResult?: { status?: string; headCommit?: string; integratedCommit?: string } | null
  recovery?: {
    recoveryAvailable: boolean
    reportRetryAvailable?: boolean
    failureCategory?: string
    recommendedAction?: string
  } | null
  closure?: { closeAvailable: boolean; reason?: string } | null
  closedAt?: string
  closedByUserId?: string
  closureReason?: string
  closureNote?: string
  supersededByDelegationId?: string
}

export function completedReplacementDelegations(delegation: AiDelegationSummary, delegations: AiDelegationSummary[]): AiDelegationSummary[]
