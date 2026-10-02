export type AiDelegationSummary = {
  id: string
  state: string
  displayState?: string
  reasonCode?: string
  message?: string
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
  workspaceError?: string | null
  integrationError?: string | null
  parentDispatchState?: string | null
  parentError?: string | null
  recoveryDispatchError?: string | null
  result?: string
  resultAvailability?: 'captured' | 'unavailable' | 'integrity-failed'
  workCompleted?: boolean
  reportPending?: boolean
  workspaceLease?: { leaseId?: string } | null
  workspaceResult?: { status?: string; headCommit?: string; integratedCommit?: string; childStatus?: string; error?: string } | null
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
export function delegationHierarchyPathNodeIds(
  parentCardId: string,
  targetCardId: string,
  hierarchyEdges: Array<{ source: string; target: string }>,
): Set<string>
export function delegationPreviewEdgeState(
  edge: { source: string; target: string; data?: { relation?: string } },
  pathNodeIds: Set<string> | null,
): '' | 'edge-linked' | 'edge-dimmed'
export function delegationPreviewNodeRole(
  preview: {
    parent: { mapId: string; cardId: string }
    target: { mapId: string; cardId: string }
  } | null,
  activeMapId: string,
  nodeId: string,
): 'source' | 'target' | undefined
