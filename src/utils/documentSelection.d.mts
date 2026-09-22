export const PHONE_VIEWPORT_QUERY: '(max-width: 720px)'

export function isPhoneViewport(
  matchMedia?: (query: string) => { matches: boolean },
): boolean

export function resolveDocumentNodeSelection(
  nodes: ReadonlyArray<{ id: string }>,
  preferredNodeId: string | null | undefined,
  phoneViewport: boolean,
): string | null

export function synchronizeNodeSelection<T extends { id: string; selected?: boolean }>(
  nodes: ReadonlyArray<T>,
  selectedId: string | null,
): T[]

export function hierarchyAncestorNodeIds(
  edges: ReadonlyArray<{
    source: string
    target: string
    data?: { relation?: string }
  }>,
  nodeId: string,
): Set<string>
