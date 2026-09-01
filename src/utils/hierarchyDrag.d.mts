export type HierarchyDragEdge = {
  source: string
  target: string
}

export function dragRootIds(draggedNodeId: string, selectedNodeIds?: Iterable<string>): Set<string>
export function hierarchyReparentPairs(
  targetId: string,
  movedNodeIds: Iterable<string>,
): HierarchyDragEdge[]
export function collectDragDescendantIds(
  rootIds: Iterable<string>,
  hierarchyEdges: HierarchyDragEdge[],
): Set<string>
export function collectDragDescendantOwners(
  rootIds: Iterable<string>,
  hierarchyEdges: HierarchyDragEdge[],
): Map<string, string>
