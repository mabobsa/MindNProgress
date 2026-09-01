export function copiedImagePlacementOverrides(items) {
  if (!Array.isArray(items) || items.length === 0) return []

  const minX = Math.min(...items.map((item) => item.position.x))
  const minY = Math.min(...items.map((item) => item.position.y))
  const maxX = Math.max(...items.map((item) => item.position.x + item.image.displayWidth))
  const maxY = Math.max(...items.map((item) => item.position.y + item.image.displayHeight))
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  return items.map((item) => ({
    displayWidth: item.image.displayWidth,
    displayHeight: item.image.displayHeight,
    description: item.description,
    offsetX: item.position.x + item.image.displayWidth / 2 - centerX,
    offsetY: item.position.y + item.image.displayHeight / 2 - centerY,
  }))
}
