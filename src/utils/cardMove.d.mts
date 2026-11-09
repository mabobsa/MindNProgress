export type CardCut = { sourceMapId: string; sourceVersion: number; sourceTitle: string; cardIds: string[]; movedCardIds: string[]; labels: Record<string, string> }
export type CardMoveRequest = { requestId: string; sourceMapId: string; body: { cardIds: string[]; targetMapId: string; targetParentCardId: string; sourceVersion: number; targetVersion: number; targetPosition: { x: number; y: number }; responseMode: 'full' } }
export function cutCardSelection(nodes: { id: string; selected?: boolean; data: { kind: string } }[], edges: { source: string; target: string; data?: { relation?: string } }[], clickedId: string): { cardIds: string[]; movedCardIds: string[] }
export function cardMoveRequestId(): string
export function resolveCardMove(request: CardMoveRequest, options?: { fetchImpl?: typeof fetch; resultOnly?: boolean; attempts?: number; timeoutMs?: number; delay?: () => Promise<void> }): Promise<{ state: 'committed' | 'rejected' | 'pending'; body: Record<string, unknown> }>
