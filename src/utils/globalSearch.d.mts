export type GlobalSearchPathOptions = {
  query?: string
  mode?: 'ranked' | 'catalog'
  cursor?: string
  limit?: number
  mapIds?: string[]
  groupIds?: string[]
  fields?: string[]
  kinds?: string[]
  statuses?: string[]
  assigneeIds?: string[]
  isWork?: boolean | null
  hasWaitingItems?: boolean | null
}

export function buildGlobalSearchPath(options?: GlobalSearchPathOptions): string
export function mergeGlobalSearchResults<T extends { mapId: string; cardId?: string | null; field: string; commentId?: string; snippet: string }>(current: T[], incoming: T[]): T[]
export function globalSearchHighlightSegments(text: string, matchedTerms?: string[]): Array<{ text: string; highlighted: boolean }>
