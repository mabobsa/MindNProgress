type Setting = { version: number; workspace: string }
export type WorkspaceContext = {
  mapId: string; groupId: string | null; groupName: string; machineId: string
  machineRole?: string; machines?: { machineId: string; label: string }[]; workspaceBrowseAvailable?: boolean
  documentSetting: Setting; groupSetting: Setting; workspace: string; source: 'document' | 'group' | 'none'
  error: string; choices: { workspace: string; reasons: string[] }[]; token: string; needsSelection: boolean; remotePathUnchecked?: boolean
}
export type WorkspaceChoice = { workspace: string; scope: 'once' | 'document' | 'group'; context: WorkspaceContext }
export async function jsonRequest<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? '작업공간 정보를 확인하지 못했습니다.')
  return result
}
export function loadWorkspaceContext(mapId: string, machineId = '', groupId = '') {
  return jsonRequest<WorkspaceContext>(`/api/integrations/aionui/workspace-context?${new URLSearchParams({ mapId, machineId, groupId })}`)
}
export function saveWorkspaceSetting(choice: WorkspaceChoice) {
  const { context, scope, workspace } = choice
  if (scope === 'once') return Promise.resolve(null)
  return jsonRequest<{ setting: Setting }>('/api/integrations/aionui/workspace-settings', {
    scope, workspace, mapId: context.mapId, id: scope === 'document' ? context.mapId : context.groupId,
    machineId: context.machineId, baseVersion: scope === 'document' ? context.documentSetting.version : context.groupSetting.version,
  })
}
