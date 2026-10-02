import type { AiDelegationSummary } from './aiDelegationManagement.mjs'
import type { AiDelegationCardStatus } from '../types/mindMap'

type DelegationRecoveryState = Pick<AiDelegationSummary, 'state' | 'workspaceResult' | 'recovery'>

export function aiDelegationRequiresRecovery(item?: DelegationRecoveryState | null): boolean
export function isVisibleAiDelegation(item?: DelegationRecoveryState | null): boolean

export function aiDelegationStatusByCard(
  delegations: AiDelegationSummary[],
  mapId: string,
): Record<string, AiDelegationCardStatus>
