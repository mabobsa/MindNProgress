export const PHONE_VIEWPORT_QUERY: '(max-width: 720px)'

export function isPhoneViewport(
  matchMedia?: (query: string) => { matches: boolean },
): boolean

export function resolveDocumentNodeSelection(
  nodes: ReadonlyArray<{ id: string }>,
  preferredNodeId: string | null | undefined,
  phoneViewport: boolean,
): string | null
