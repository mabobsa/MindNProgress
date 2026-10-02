export type StoredWorkspaceViewMode = 'mindmap' | 'kanban' | 'timeline' | 'dashboard'

export type StoredWorkspaceLocation = {
  mapId: string
  viewMode: StoredWorkspaceViewMode
  nodeId: string | null
}

export function workspaceLocationStorageKey(userId: unknown): string | null
export function normalizeWorkspaceLocation(value: unknown): StoredWorkspaceLocation | null
export function restorableWorkspaceLocation(value: unknown, availableMapIds: unknown): StoredWorkspaceLocation | null
export function workspaceLocationPath(value: unknown, viewerEntry?: boolean): string | null
