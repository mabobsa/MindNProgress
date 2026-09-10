export type LayoutMeasurement = { cardId: string; x: number; y: number; width: number; height: number; outsets: { left: number; top: number; right: number; bottom: number } }
export type MindMapLayout = { version: string; gap: number; width: number; height: number; boxes: { cardId: string; x: number; y: number; width: number; height: number; body: { width: number; height: number; outsets: LayoutMeasurement['outsets'] } }[] }
export const MIND_MAP_LAYOUT_VERSION: string
export const MIND_MAP_LAYOUT_GAP: number
export function layoutMindMap<T extends { nodes: { id: string; position?: { x: number; y: number }; data: object }[]; edges: { source: string; target: string; data?: { relation?: string } }[] }>(map: T, measurements?: LayoutMeasurement[]): { map: T; layout: MindMapLayout }
export function validateLayoutMeasurements(nodes: { id: string }[], measurements: LayoutMeasurement[]): LayoutMeasurement[]
export function assertLayoutClear(boxes: { cardId: string; x: number; y: number; width: number; height: number }[], gap?: number): void
export function verifyRenderedLayout(map: { nodes: { id: string; position: { x: number; y: number } }[] }, layout: MindMapLayout, measurements: LayoutMeasurement[]): boolean
