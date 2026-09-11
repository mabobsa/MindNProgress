import type { AiConversationPurpose } from './aiConversationLaunch.mjs'

export type AiConversationRoleInput = {
  mapId: string
  cardId: string
  purpose?: AiConversationPurpose
  initialRequest?: string
  fullInitialRequest?: boolean
  groupId?: string
}
export type AiConversationRole = {
  purpose: AiConversationPurpose
  automaticRequest: string
  fullInitialRequest: boolean
  groupId: string | null
}
export function resolveAiConversationRole(input: AiConversationRoleInput, context?: unknown): AiConversationRole
export function loadAiConversationRole(input: AiConversationRoleInput, options?: { signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<AiConversationRole>
