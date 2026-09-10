export const groupWaitingCategories = [
  { id: 'external', label: '외부 자료 대기' },
  { id: 'decision', label: '기획 결정 대기' },
  { id: 'verification', label: '검증 대기' },
  { id: 'other', label: '기타·분류 확인' },
]
export const groupWaitingImpacts = [
  { id: 'unreviewed', label: '현재 범위 영향 미확인' },
  { id: 'blocking', label: '현재 범위 차단' },
  { id: 'deferred', label: '예정된 외부 대기' },
]

// 사유를 찾기 위한 표시용 후보일 뿐, 실행 범위·승인 여부나 실제 장애를 판정하지 않는다.
// note·재개 조건은 배경/부정문이 섞이므로 키워드 분류에 사용하지 않는다.
export function suggestGroupWaitingCategory(item) {
  const label = typeof item?.label === 'string' ? item.label : ''
  if (/검증|검수|감사|증거|재현|테스트 환경|실경로/.test(label)) return 'verification'
  if (/기획|정책|가격|밸런스|표시안|표시 방식|표시 항목|필드|말투|사실|FAQ.*범위|대사.*확정|콘텐츠.*확정/.test(label)) return 'decision'
  if (/서버|API|프로토콜|아트|리소스|에셋|자산|Sprite|원화|사운드|보이스.*전달|계약/.test(label)) return 'external'
  return 'other'
}

export function groupWaitingPresentation(detail) {
  const reviewed = detail.review?.valid === true
  return {
    category: reviewed ? detail.review.category : suggestGroupWaitingCategory(detail.item),
    impact: reviewed ? detail.review.impact : 'unreviewed',
    reviewed,
    stale: Boolean(detail.review && !reviewed),
  }
}

export const groupOverviewFilters = [
  { id: 'all', label: '전체 문서' },
  { id: 'ai', label: 'AI 확인·복구' },
  { id: 'blocking', label: '현재 범위 차단' },
  { id: 'deferred', label: '예정된 외부 대기' },
  { id: 'unreviewed', label: '범위 영향 미확인' },
  { id: 'external', label: '외부 자료 대기' },
  { id: 'decision', label: '기획 결정 대기' },
  { id: 'verification', label: '검증 대기' },
  { id: 'other', label: '기타·분류 확인' },
]
