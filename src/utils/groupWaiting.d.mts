import type { GroupWaitingCategory, GroupWaitingImpact, GroupWaitingDetail } from './groupOverview.mjs'
export const groupWaitingCategories: Array<{ id: GroupWaitingCategory; label: string }>
export const groupWaitingImpacts: Array<{ id: GroupWaitingImpact; label: string }>
export const groupOverviewFilters: Array<{ id: string; label: string }>
export function suggestGroupWaitingCategory(item?: { label?: string }): GroupWaitingCategory
export function groupWaitingPresentation(detail: GroupWaitingDetail): { category: GroupWaitingCategory; impact: GroupWaitingImpact; reviewed: boolean; stale: boolean }
