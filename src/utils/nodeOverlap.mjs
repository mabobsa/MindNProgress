export const NODE_OVERLAP_MIN_PX = 5
// 저장 좌표가 같아도 렌더 측정에서 생길 수 있는 소수점 오차만 허용한다.
export const NODE_OVERLAP_STACK_SCREEN_PX = 1

function normalizedZoom(zoom) {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

function boundsOf(candidate) {
  return {
    left: candidate.x,
    top: candidate.y,
    right: candidate.x + candidate.width,
    bottom: candidate.y + candidate.height,
  }
}

function overlapsBy(a, b, minimumOverlap) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return width >= minimumOverlap && height >= minimumOverlap
}

function isSameStack(a, b, tolerance) {
  return Math.max(
    Math.abs(a.left - b.left),
    Math.abs(a.top - b.top),
    Math.abs(a.right - b.right),
    Math.abs(a.bottom - b.bottom),
  ) <= tolerance
}

export function nodeOverlapPresentation(candidates, {
  zoom = 1,
  selectedId = null,
  minimumOverlapPx = NODE_OVERLAP_MIN_PX,
  stackScreenPx = NODE_OVERLAP_STACK_SCREEN_PX,
} = {}) {
  const safeZoom = normalizedZoom(zoom)
  const minimumOverlap = Math.max(0, minimumOverlapPx)
  const stackTolerance = Math.max(0, stackScreenPx) / safeZoom
  const bounds = candidates.map(boundsOf)
  const warningIds = new Set()
  const groupedIndexes = []

  for (let index = 0; index < candidates.length; index += 1) {
    const matchingGroup = groupedIndexes.find((group) => group.every((memberIndex) => (
      isSameStack(bounds[index], bounds[memberIndex], stackTolerance)
    )))
    if (matchingGroup) matchingGroup.push(index)
    else groupedIndexes.push([index])
  }
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = bounds[leftIndex]
      const right = bounds[rightIndex]
      if (overlapsBy(left, right, minimumOverlap)) {
        warningIds.add(candidates[leftIndex].id)
        warningIds.add(candidates[rightIndex].id)
      }
    }
  }

  const stacks = groupedIndexes
    .filter((indexes) => indexes.length > 1)
    .map((indexes) => {
      const cards = indexes.map((index) => candidates[index])
      const selectedCard = cards.find((card) => card.id === selectedId)
      return {
        ids: cards.map((card) => card.id),
        titles: cards.map((card) => card.title),
        representativeId: selectedCard?.id ?? cards.at(-1).id,
      }
    })

  return {
    warningIds: candidates.filter((candidate) => warningIds.has(candidate.id)).map((candidate) => candidate.id),
    stacks,
  }
}

export function nextOverlappingNodeId(ids, selectedId = null) {
  if (ids.length === 0) return null
  const currentIndex = selectedId ? ids.indexOf(selectedId) : -1
  return ids[(currentIndex + 1) % ids.length]
}
