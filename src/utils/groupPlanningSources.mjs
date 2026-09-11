export const GROUP_PLANNING_SOURCE_LIMIT = 50

// 기존 단일 원본은 읽을 때만 목록으로 해석한다. 조회로 저장 버전이나 승인 기준을 바꾸지 않는다.
export function groupPlanningSources(project) {
  if (Array.isArray(project.sources)) return project.sources
  return project.source || project.sourceVersion
    ? [{ id: 'source-legacy', title: '', source: project.source ?? '', sourceVersion: project.sourceVersion ?? '' }]
    : []
}

export function withGroupPlanningSources(project, sources) {
  // 단일 원본 필드는 구버전 소비자를 위한 첫 항목 별칭이다. 전체 기준은 sources다.
  return { ...project, sources, source: sources[0]?.source ?? '', sourceVersion: sources[0]?.sourceVersion ?? '' }
}

export function groupProjectCriteriaEqual(first, second) {
  const content = (project) => [groupPlanningSources(project).map(({ title, source, sourceVersion }) => [title, source, sourceVersion]), project.objective ?? '', project.instructions ?? '']
  return JSON.stringify(content(first)) === JSON.stringify(content(second))
}

export function groupPlanningSourceSummary(project) {
  const sources = groupPlanningSources(project)
  if (!sources.length) return '기획서 미등록'
  if (sources.length === 1) return sources[0].sourceVersion || '버전 미등록'
  return `기획서 ${sources.length}개`
}

export function groupPlanningBaseline(project) {
  const sources = groupPlanningSources(project)
  return sources.length <= 1 ? sources[0]?.sourceVersion ?? ''
    : sources.map((item, index) => `${item.title || `기획서 ${index + 1}`} · ${item.sourceVersion || '버전 미등록'}`).join(' / ')
}
