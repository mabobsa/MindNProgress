export type NodeOverlapCandidate = {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
}

export type NodeOverlapStack = {
  ids: string[]
  titles: string[]
  representativeId: string
}

export type NodeOverlapPresentation = {
  warningIds: string[]
  stacks: NodeOverlapStack[]
}

export const NODE_OVERLAP_MIN_PX: number
export const NODE_OVERLAP_STACK_SCREEN_PX: number

export function nodeOverlapPresentation(
  candidates: NodeOverlapCandidate[],
  options?: {
    zoom?: number
    selectedId?: string | null
    minimumOverlapPx?: number
    stackScreenPx?: number
  },
): NodeOverlapPresentation

export function nextOverlappingNodeId(ids: string[], selectedId?: string | null): string | null
