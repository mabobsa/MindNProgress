import type { AiConversationLink, AiConversationRuntime, MindNodeData } from '../types/mindMap'

export function normalizeAiConversationLink(value: unknown): AiConversationLink | null
export function aiConversationLinksFromData(data: Partial<MindNodeData> | null | undefined): AiConversationLink[]
export function aiConversationIdsFromData(data: Partial<MindNodeData> | null | undefined): string[]
export function isAiConversationLinked(data: Partial<MindNodeData> | null | undefined, conversationId: unknown): boolean
export function primaryAiConversationIdFromData(data: Partial<MindNodeData> | null | undefined): string | null
export function withAiConversationLink(data: Partial<MindNodeData> | null | undefined, value: unknown, options?: { makePrimary?: boolean; makeCurrent?: boolean }): Partial<MindNodeData>
export function appendAiConversationLink(data: Partial<MindNodeData> | null | undefined, value: unknown): AiConversationLink[]
export function aiConversationLinkFromAionUiConversation(conversation: unknown): AiConversationLink | null
export function aggregateAiConversationRuntime(runtimes: AiConversationRuntime[]): AiConversationRuntime | null
