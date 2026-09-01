export type CopiedImagePlacementItem = {
  position: { x: number; y: number }
  image: {
    displayWidth: number
    displayHeight: number
  }
  description: string
}

export type CopiedImagePlacementOverride = {
  displayWidth: number
  displayHeight: number
  description: string
  offsetX: number
  offsetY: number
}

export function copiedImagePlacementOverrides(
  items: CopiedImagePlacementItem[],
): CopiedImagePlacementOverride[]
