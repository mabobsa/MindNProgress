import type { MindNodeData } from '../types/mindMap'
import './NodeOverlapBadge.css'

export function NodeOverlapBadge({ data }: { data: MindNodeData }) {
  const overlap = data.overlapStack
  if (!overlap) return null

  return (
    <button
      type="button"
      className="node-overlap-badge nodrag nopan"
      aria-label={`겹친 카드 ${overlap.count}개. 클릭하여 다음 카드 선택`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        data.onCycleOverlap?.()
      }}
    >
      겹침 {overlap.count}
      <span className="node-overlap-tooltip" role="tooltip">
        <strong>겹친 카드</strong>
        {overlap.titles.map((title, index) => <span key={`${index}-${title}`}>{index + 1}. {title}</span>)}
        <small>클릭하면 다음 카드를 선택합니다.</small>
      </span>
    </button>
  )
}
