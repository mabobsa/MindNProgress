import type { MindNodeData, AiConversationRuntime } from '../types/mindMap'

export type GroupProject = { version: number; coordinatorMapId: string | null; source: string; sourceVersion: string; objective: string; instructions: string }
export type GroupDocument = { id: string; title: string; version: number; root: { id: string; data: MindNodeData } | null; runtime: AiConversationRuntime | null; work: { total: number; done: number; waiting: number } }
export type GroupDelegation = { id: string; mapId: string; targetCardId: string; targetCardLabel: string; state: string; displayState?: string; instructionPreview: string; childError?: string; parentError?: string; recoveryWakeError?: string; linkError?: string; createdAt: string; updatedAt: string; result?: string; workCompleted?: boolean; reportPending?: boolean; recovery?: { recoveryAvailable: boolean; reportRetryAvailable?: boolean; failureCategory?: string }; attemptHistory?: Array<{ at: string; reason: string; childError?: string; parentError?: string; result?: string }> }
export type GroupContext = { group: { id: string; name: string; mapIds: string[] }; project: GroupProject; coordinator: GroupDocument | null; documents: GroupDocument[]; delegations: GroupDelegation[]; guide: { coordinator: string } }
export type GroupOverviewRow = { mapId: string; title: string; document: GroupDocument | null; delegations: GroupDelegation[]; latest: GroupDelegation | null; attention: boolean }
export function groupDelegationPresentation(item?: GroupDelegation | null): { label: string; tone: string; attention: boolean }
export function groupOverviewRows(context?: GroupContext | null): GroupOverviewRow[]
export function filterGroupOverviewRows(rows: GroupOverviewRow[], query: string, attentionOnly: boolean): GroupOverviewRow[]
