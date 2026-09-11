export type GroupPlanningSource = { id: string; title: string; source: string; sourceVersion: string }
type PlanningProject = { sources?: GroupPlanningSource[]; source?: string; sourceVersion?: string }
export const GROUP_PLANNING_SOURCE_LIMIT: number
export function groupPlanningSources(project: PlanningProject): GroupPlanningSource[]
export function withGroupPlanningSources<T extends PlanningProject>(project: T, sources: GroupPlanningSource[]): T & { sources: GroupPlanningSource[]; source: string; sourceVersion: string }
export function groupProjectCriteriaEqual(first: PlanningProject & { objective?: string; instructions?: string }, second: PlanningProject & { objective?: string; instructions?: string }): boolean
export function groupPlanningSourceSummary(project: PlanningProject): string
export function groupPlanningBaseline(project: PlanningProject): string
