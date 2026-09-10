export type AiConversationKnowledgeSource = { id: string; label: string; policy: string }
export type AiConversationPurpose = 'card' | 'shared-knowledge-review' | 'group-coordination' | 'document-reconstruction'

export const AI_CONVERSATION_PURPOSES: readonly AiConversationPurpose[]

export type AiConversationExplicitTarget = {
  purpose?: AiConversationPurpose
  mapId: string
  cardId: string
  cardTitle?: string
  documentTitle?: string
  initialRequest?: string
}

export type AiConversationTarget<TSource = AiConversationKnowledgeSource> = {
  source: 'explicit' | 'selection'
  purpose: AiConversationPurpose
  mapId: string
  cardId: string
  cardTitle: string
  documentTitle: string
  knowledgeSources: TSource[]
  initialRequest?: string
}

export type AiConversationSelection<TSource = AiConversationKnowledgeSource> = {
  open?: boolean
  mapId?: string | null
  cardId?: string | null
  cardLabel?: string | null
  cardKind?: string | null
  isReference?: boolean
  documentTitle?: string | null
  knowledgeSources?: TSource[]
}

export type SharedKnowledgeCleanupContext = {
  document?: { id?: string; title?: string } | null
  card?: {
    id?: string
    label?: string
    textIntegrity?: { length?: number } | null
  } | null
  candidate?: {
    reviewLevel?: string
    limitUsagePercent?: number
    exactDuplicateStatementCount?: number
  } | null
  relations?: { totals?: { knowledgeConsumers?: number } | null } | null
}

export const AI_EDITOR_REQUEST_MAX_LENGTH: number
export const DEFAULT_AI_EDITOR_REQUEST: string

export function normalizeAiCardTitle(value: unknown): string
export function normalizeAiEditorRequest(value: unknown): string
export function combineAiEditorRequest(automaticRequest: unknown, userInput: unknown): string
export function isAiConversationPurpose(value: unknown): value is AiConversationPurpose
export function normalizeAiConversationPurpose(value: unknown): AiConversationPurpose
export function aiConversationTitle(input?: {
  purpose?: AiConversationPurpose
  documentTitle?: unknown
  cardTitle?: unknown
}): string

export function resolveAiConversationTarget<TSource = AiConversationKnowledgeSource>(input: {
  explicitTarget?: AiConversationExplicitTarget | null
  selection?: AiConversationSelection<TSource> | null
}): AiConversationTarget<TSource> | null

export function buildAiConversationPrompt(input: {
  mapId: string
  cardId: string
  editorId: string
  attributionToken: string
  request: string
}): string

export function buildSharedKnowledgeCleanupRequest(context: SharedKnowledgeCleanupContext): string
export function buildSharedKnowledgeCleanupLaunch(
  context: SharedKnowledgeCleanupContext,
): (AiConversationExplicitTarget & { initialRequest: string }) | null
