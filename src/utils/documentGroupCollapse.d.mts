export function collapsedDocumentGroupsStorageKey(userId: unknown): string | null
export function normalizeCollapsedDocumentGroupIds(value: unknown): string[] | null
export function initialCollapsedDocumentGroupIds(storedGroupIds: unknown, availableGroupIds: unknown): string[]
export function activeDocumentCountInGroup(mapIds: string[], activeCounts: Record<string, number>): number
