export type AiDelegationRuntime = { agentId: string; modelId: string; mode: string; thoughtLevel: string }
export type AiDelegationPreferences = { enabled: boolean; selection: AiDelegationRuntime; narrativeMode: boolean; narrativeText: string }
export const AI_DELEGATION_NARRATIVE_MAX_LENGTH: number
export const AI_DELEGATION_DIALOG_SETTING_AVAILABLE: boolean
type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>
type Agent = { id: string; models: readonly { id: string }[]; modes: readonly { id: string }[]; thoughtLevels: readonly { id: string }[] }

export function normalizeAiDelegationRuntime(value: unknown): AiDelegationRuntime
export function normalizeAiDelegationPreferences(value: unknown): AiDelegationPreferences
export function readAiDelegationPreferences(userId: string, machineId: string, storage?: StorageReader): AiDelegationPreferences | null
export function saveAiDelegationPreferences(userId: string, machineId: string, value: unknown, storage?: StorageWriter): boolean
export function resolveAiDelegationRuntime(value: unknown, agents: readonly Agent[]): { selection: AiDelegationRuntime; unavailableFields: string[] }
