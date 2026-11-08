export type AiDelegationSummary = {
  id: string
  state: string
  kind?: 'request-failure' | 'task-attention'
  completedExecutionCount?: number
  resolvedByDelegationId?: string | null
  accepted?: boolean
  requestClosure?: { reason: 'cancelled' | 'no-longer-needed'; note: string; at: string; actorId: string }
  requestedDelegationId?: string
  executionState?: 'not-started' | 'unknown'
  phase?: 'preflight' | 'dispatch'
  targetHomeMachineId?: string
  taskCompletion?: { state: 'completed' | 'incomplete'; status: string; progress: number; message: string }
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
  instructionPreview?: string
  requestSummary?: string
  retryVerification?: {
    state: 'confirmed' | 'unverified' | 'not-found' | 'execution-unknown' | 'closed'
    method: string | null
    message: string
    replacement: { id: string; targetCardLabel?: string; instructionPreview?: string; createdAt: string; state: string; targetConversationId?: string } | null
  }
  createdAt: string
  updatedAt: string
  childStatus?: string | null
  childError?: string | null
  workspaceError?: string | null
  integrationError?: string | null
  parentDispatchState?: string | null
  parentError?: string | null
  parentWakeRetry?: { status: 'scheduled' | 'checking' | 'waiting' | 'stopped' | 'received'; phase: string; attempt: number; nextAttemptAt?: string | null; stopReason?: string | null; lastFailure?: { phase: string; observedAt: string; code: string; status?: number | null; causeCodes?: string[] } } | null
  recoveryDispatchError?: string | null
  integrationRecoveryRequest?: { requestId: string; status: 'queued' | 'checking' | 'accepted' | 'failed'; message: string; reasonCode: string; requestedAt: string; startedAt?: string | null; completedAt?: string | null } | null
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
    blockedReasonCode?: string
    blockedByDelegationId?: string
    message?: string
  } | null
  closure?: { closeAvailable: boolean; reason?: string; workspaceReleaseRequired?: boolean; quarantinedRelease?: boolean } | null
  closedAt?: string
  closedByUserId?: string
  closureReason?: string
  closureNote?: string
  supersededByDelegationId?: string
}

export function completedReplacementDelegations(delegation: AiDelegationSummary, delegations: AiDelegationSummary[]): AiDelegationSummary[]
export function requestFailureReplacementDelegations(failure: AiDelegationSummary, delegations: AiDelegationSummary[]): AiDelegationSummary[]
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
