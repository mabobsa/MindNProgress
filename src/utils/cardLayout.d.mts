import type { LayoutMeasurement, MindMapLayout } from './mindMapLayout.mjs'
export type CardLayoutPlan = { order: string[]; reason: string }
export type CardLayoutRatio = '4:3' | '16:9' | '21:9'
export type CardLayoutTarget = { ratio: CardLayoutRatio }
export type CardLayoutTargetInput = CardLayoutTarget | { width: number; height: number }
export type CardLayoutVariant = 'balanced' | 'spread' | 'hierarchy'
export type CardLayoutMetrics = { target: CardLayoutTarget; width: number; height: number; aspectRatio: number }
export type CardLayoutCandidate<T = LayoutMap> = { id: CardLayoutVariant; label: string; map: T; layout: MindMapLayout; metrics: CardLayoutMetrics }
type LayoutNode = { id: string; position: { x: number; y: number }; data: { kind?: string; isWork?: boolean; reference?: unknown; externalLink?: unknown } }
type LayoutMap = { nodes: LayoutNode[]; edges: { source: string; target: string; data?: { relation?: string } }[] }
export const CARD_LAYOUT_VERSION: string
export const CARD_LAYOUT_GAP: number
export const CARD_LAYOUT_TARGET: Readonly<CardLayoutTarget>
export const CARD_LAYOUT_RATIOS: readonly CardLayoutRatio[]
export function validateCardLayoutTarget(target?: CardLayoutTargetInput): CardLayoutTarget
export function cardLayoutAspectRatio(target?: CardLayoutTargetInput): number
export function cardLayoutMetrics(layout: MindMapLayout, target?: CardLayoutTargetInput): CardLayoutMetrics
export function createCardLayoutCandidates<T extends LayoutMap>(map: T, measurements: LayoutMeasurement[], plan?: CardLayoutPlan, target?: CardLayoutTargetInput): CardLayoutCandidate<T>[]
export function cardLayoutKind(node: LayoutNode, childCount?: number): string
export function validateCardLayoutPlan(map: LayoutMap, plan: CardLayoutPlan): CardLayoutPlan
export function layoutCards<T extends LayoutMap>(map: T, measurements: LayoutMeasurement[], plan?: CardLayoutPlan, options?: { target?: CardLayoutTargetInput; variant?: CardLayoutVariant }): { map: T; layout: MindMapLayout }
export function verifyCardLayout(map: LayoutMap, layout: MindMapLayout, measurements: LayoutMeasurement[]): boolean
