export type LibraryDropItem = { type: 'map' | 'group'; id: string }

export type LibraryDropTarget = {
  key: string
  action: 'top-start' | 'top-end' | 'top-before' | 'group-insert' | 'group-append' | string
  targetType: 'map' | 'group' | null
  targetId: string | null
  groupId: string | null
  mapId: string | null
}

export type LibraryDropDestination =
  | { type: 'top'; target?: LibraryDropItem }
  | { type: 'group'; groupId: string; targetMapId?: string }

export function libraryDropTargetFromElement(element: Element | null, draggedType: LibraryDropItem['type']): LibraryDropTarget | null

export function libraryDropDestination(
  target: LibraryDropTarget | null,
  dragged: LibraryDropItem | null,
  firstLayoutItem: LibraryDropItem | undefined,
): LibraryDropDestination | null
