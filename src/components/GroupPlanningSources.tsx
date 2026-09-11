import { GROUP_PLANNING_SOURCE_LIMIT, groupPlanningSources } from '../utils/groupPlanningSources.mjs'
import type { GroupPlanningSource } from '../utils/groupPlanningSources.mjs'
import type { GroupProject } from '../utils/groupOverview.mjs'

export function GroupPlanningSourceList({ project }: { project: GroupProject }) {
  const sources = groupPlanningSources(project)
  return sources.length ? <ol className="group-source-list">{sources.map((item, index) => <li key={item.id}>
    <strong>{item.title || `기획서 ${index + 1}`} · {item.sourceVersion || '버전 미등록'}</strong>
    <p className="group-full-text">{item.source || '원본 미등록'}</p>
  </li>)}</ol> : <p className="group-muted">기획서가 등록되지 않았습니다.</p>
}

export function GroupPlanningSourceEditor({ sources, onChange }: { sources: GroupPlanningSource[]; onChange: (sources: GroupPlanningSource[]) => void }) {
  const update = (id: string, key: 'title' | 'source' | 'sourceVersion', value: string) => onChange(sources.map((item) => item.id === id ? { ...item, [key]: value } : item))
  return <section className="group-planning-sources" aria-label="기획서 목록 편집">
    <div className="group-source-heading"><h3>기획서 <span>{sources.length}개</span></h3><button type="button" disabled={sources.length >= GROUP_PLANNING_SOURCE_LIMIT} onClick={() => onChange([...sources, { id: `source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, title: '', source: '', sourceVersion: '' }])}>기획서 추가</button></div>
    <p className="group-muted">기획서별 주소와 버전을 등록하세요. 전체 목표·공통 지침은 모든 기획서에 함께 적용됩니다. 추가·제거는 기준 저장 후 반영됩니다.</p>
    {!sources.length && <p className="group-muted">등록된 기획서가 없습니다. 기획서 추가로 시작하세요.</p>}
    {sources.map((item, index) => <div className="group-source-entry" key={item.id}>
      <div className="group-source-heading"><strong>기획서 {index + 1}</strong><button type="button" aria-label={`기획서 ${index + 1} 제거`} onClick={() => {
        if ((item.title || item.source || item.sourceVersion) && !window.confirm(`${item.title || `기획서 ${index + 1}`}를 기준 목록에서 제거할까요? 원본 파일이나 문서는 삭제하지 않으며 기준 저장 후 반영됩니다.`)) return
        onChange(sources.filter((source) => source.id !== item.id))
      }}>제거</button></div>
      <label>이름 (선택)<input aria-label={`기획서 ${index + 1} 이름`} value={item.title} maxLength={120} onChange={(event) => update(item.id, 'title', event.target.value)} placeholder="예: 기본 기획, 옷장 추가 기획" /></label>
      <div className="group-source-fields"><label>원본 링크 또는 파일 경로<input aria-label={`기획서 ${index + 1} 주소`} value={item.source} maxLength={4096} onChange={(event) => update(item.id, 'source', event.target.value)} placeholder="기획서 업무 링크 또는 AI가 읽을 수 있는 파일 경로" /></label><label>기준 버전<input aria-label={`기획서 ${index + 1} 버전`} value={item.sourceVersion} maxLength={240} onChange={(event) => update(item.id, 'sourceVersion', event.target.value)} placeholder="예: v0.4" /></label></div>
    </div>)}
    <p className="group-muted">추가 기획서가 기존 원본을 자동 대체하지 않습니다. 기준 변경 시 영향받는 실행 계획은 사용자 재승인 확인이 필요합니다.</p>
  </section>
}
