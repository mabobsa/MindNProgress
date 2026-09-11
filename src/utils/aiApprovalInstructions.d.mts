export const AI_EXECUTION_APPROVAL_INSTRUCTION: string
export const GROUP_APPROVAL_INSTRUCTION: string
export const GROUP_COORDINATOR_INSTRUCTION: string
export const DOCUMENT_COORDINATOR_INSTRUCTION: string
export const AI_DELEGATION_FOLLOWUP_INSTRUCTION: string
export const AI_DELEGATION_REPORT_INSTRUCTION: string
export function buildGroupCoordinatorRequest(input: { groupId: string; instruction?: string }): string
export function buildGroupDocumentRequest(input: { groupId: string; groupName: string }): string
export function buildGroupDocumentProposalRequest(input: { mapId: string; cardId: string; title: string }): string
