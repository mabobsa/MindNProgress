import { useCallback, useEffect, useRef, useState } from 'react'
import type { MindNodeData, AiConversationRuntime } from '../types/mindMap'
import type { AiConversationExplicitTarget } from '../utils/aiConversationLaunch.mjs'
import './GroupOverview.css'

type Project = { version: number; coordinatorMapId: string | null; source: string; sourceVersion: string; objective: string; instructions: string }
type GroupDocument = { id: string; title: string; version: number; root: { id: string; data: MindNodeData } | null; runtime: AiConversationRuntime | null; work: { total: number; done: number; waiting: number } }
type Delegation = { id: string; mapId: string; targetCardId: string; targetCardLabel: string; state: string; instructionPreview: string; childError?: string; recoveryWakeError?: string; linkError?: string; createdAt: string; result?: string }
type GroupContext = { group: { id: string; name: string; mapIds: string[] }; project: Project; coordinator: GroupDocument | null; documents: GroupDocument[]; delegations: Delegation[]; guide: { coordinator: string } }
export type GroupAiTarget = AiConversationExplicitTarget & { initialRequest: string }

const runtimeLabels: Record<string, string> = { running: 'AI 실행 중', 'waiting-confirmation': 'AI 확인 대기', idle: 'AI 대기', unknown: 'AI 상태 확인 불가' }
const delegationLabels: Record<string, string> = {
  running: '문서 AI 실행 중', 'waiting-document-work': '하위 업무와 문서 검수 대기',
  starting: '실행 준비', 'running-child': '문서 AI 실행 중', 'waiting-child': '문서 AI 실행 중', 'waiting-resource': '실행 자원 대기',
  'waiting-child-resume': '문서 AI 재개 대기', 'waiting-parent': '총괄 보고 대기', 'waking-parent': '총괄 AI 검토 중',
  completed: '실행 완료 · 검증 근거 확인', failed: '실행 실패', superseded: '후속 위임으로 이어짐',
  'recovery-required': '복구 필요', 'integration-recovery-required': '통합 복구 필요', 'waiting-workspace': '작업공간 대기',
  'waiting-integration-clean': '통합 준비 대기', resuming: '재개 중',
}

async function request<T>(url: string, clientId: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-MNP-Client': clientId, ...options.headers } })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '그룹 정보를 처리하지 못했습니다.')
  return result
}

export function GroupOverview({ groupId, name, membershipKey, editable, clientId, onNavigate, onLaunch, onConversations, onLibraryChanged }: {
  groupId: string; name: string; membershipKey: string; editable: boolean; clientId: string
  onNavigate: (mapId: string, rootId?: string) => void
  onLaunch: (target: GroupAiTarget) => void
  onConversations: (target: GroupAiTarget) => void
  onLibraryChanged: () => void
}) {
  const [context, setContext] = useState<GroupContext | null>(null)
  const [draft, setDraft] = useState<Project | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [coordinatorChoice, setCoordinatorChoice] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const mounted = useRef(true)
  const draftBase = useRef<Project | null>(null)
  const loadSequence = useRef(0)
  const baseUrl = `/api/groups/${encodeURIComponent(groupId)}`
  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current
    try {
      const value = await request<GroupContext>(baseUrl, clientId)
      if (!mounted.current || sequence !== loadSequence.current) return
      setContext(value)
      setDraft((current) => {
        const edited = current && draftBase.current && ['source', 'sourceVersion', 'objective', 'instructions'].some((key) => current[key as keyof Project] !== draftBase.current?.[key as keyof Project])
        if (edited) return current
        draftBase.current = value.project
        return value.project
      })
      setError('')
    } catch (reason) {
      if (mounted.current && sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : '그룹을 불러오지 못했습니다.')
    }
  }, [baseUrl, clientId])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 8000)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { mounted.current = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [refresh, membershipKey])

  const changed = Boolean(draft && context && ['source', 'sourceVersion', 'objective', 'instructions'].some((key) => draft[key as keyof Project] !== context.project[key as keyof Project]))
  const stale = draft && context && draft.version !== context.project.version
  const updateField = (key: 'source' | 'sourceVersion' | 'objective' | 'instructions', value: string) => setDraft((current) => current ? { ...current, [key]: value } : current)
  const save = async (prepare = false) => {
    if (!draft) return
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await request<GroupContext>(baseUrl, clientId, { method: 'PATCH', body: JSON.stringify({
        baseVersion: draft.version, source: draft.source, sourceVersion: draft.sourceVersion, objective: draft.objective, instructions: draft.instructions,
        ...(prepare ? coordinatorChoice ? { coordinatorMapId: coordinatorChoice } : { createCoordinator: true } : {}),
      }) })
      if (!mounted.current) return
      loadSequence.current++
      draftBase.current = value.project
      setContext(value); setDraft(value.project); setNotice(prepare ? '총괄 문서를 연결했습니다. AI 대화에서 기획 분석을 시작할 수 있습니다.' : '그룹 정보를 저장했습니다.')
      setSettingsOpen(false)
      onLibraryChanged()
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.') }
    finally { if (mounted.current) setBusy(false) }
  }
  function aiTarget(document: GroupDocument, instruction?: string): GroupAiTarget | null {
    if (!document.root || !context) return null
    const coordinator = document.id === context.project.coordinatorMapId
    return {
      purpose: coordinator ? 'group-coordination' : 'card', mapId: document.id, cardId: document.root.id,
      documentTitle: document.title, cardTitle: document.root.data.label,
      initialRequest: coordinator
        ? `그룹 총괄 업무입니다. mindnprogress_get_group_context를 groupId="${groupId}"로 먼저 조회하세요.\n\n${instruction ?? '그룹의 기획 원본과 목표를 확인하고, 원본 전수 분석·문서 분할·루트 실행 계약 작성·문서별 분석 위임·개발 및 검수 조정을 진행하세요. 기존 문서는 현재 요구사항과 구현을 감사하여 활용하세요. 필요한 원본이나 결정이 없으면 구체적으로 알리세요.'}\n\n${context.guide.coordinator}`
        : `그룹 "${name}"의 문서 담당 업무입니다. mindnprogress_get_group_context를 groupId="${groupId}"로 조회하고 이 루트의 최신 실행 계약을 확인하세요. 담당 범위 분석과 하위 업무 구성을 진행하고, 실제 구현은 하위 카드로 위임하세요.`,
    }
  }
  function launch(document: GroupDocument, instruction?: string) {
    const target = aiTarget(document, instruction)
    if (target) onLaunch(target)
  }
  function openConversations(document: GroupDocument) {
    const target = aiTarget(document)
    if (target) onConversations(target)
  }
  const createDocument = async () => {
    if (!context || !newTitle.trim()) return
    setBusy(true); setError('')
    try {
      await request(baseUrl + '/documents', clientId, { method: 'POST', body: JSON.stringify({ baseVersion: context.project.version, title: newTitle.trim(), description: newDescription }) })
      if (!mounted.current) return
      setNewTitle(''); setNewDescription(''); setNotice('문서와 최상위 카드를 만들었습니다. 담당 범위를 확인한 뒤 위임하세요.')
      await refresh(); onLibraryChanged()
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '문서를 생성하지 못했습니다.') }
    finally { if (mounted.current) setBusy(false) }
  }
  const documents = context?.documents.filter((item) => item.id !== context.project.coordinatorMapId) ?? []
  const coordinator = context?.coordinator
  const linked = (document: GroupDocument) => Boolean(document.root?.data.aiConversations?.length || document.root?.data.aiConversationId)
  const aiDisabled = busy || changed || Boolean(stale)

  return <section className="group-overview" aria-label={`${name} 그룹 개요`}>
    <header className="group-overview-header"><div><small>그룹 · 기획과 개발</small><h1>{name}</h1><p>기획 기준과 담당 범위를 공유하고, 문서별 분석·개발 결과를 모읍니다.</p></div><button onClick={() => void refresh()} disabled={busy}>새로고침</button></header>
    {error && <div className="group-message error" role="alert">{error}</div>}
    {notice && <div className="group-message" role="status">{notice}</div>}
    {!context || !draft ? <p aria-live="polite">그룹 정보를 불러오는 중…</p> : <>
      <section className="group-project-card">
        <div className="group-section-title"><h2>기획 기준</h2>{editable && <button onClick={() => setSettingsOpen((current) => !current)}>{settingsOpen ? '편집 접기' : '기준 편집'}</button>}</div>
        {editable && (settingsOpen || !coordinator) ? <form onSubmit={(event) => { event.preventDefault(); void save() }}>
          <div className="group-source-fields"><label>원본 링크 또는 파일 경로<input value={draft.source} maxLength={4096} onChange={(event) => updateField('source', event.target.value)} placeholder="기획서 업무 링크 또는 AI가 읽을 수 있는 파일 경로" /></label><label>기준 버전<input value={draft.sourceVersion} maxLength={240} onChange={(event) => updateField('sourceVersion', event.target.value)} placeholder="예: v0.3" /></label></div>
          <label>전체 목표<textarea value={draft.objective} maxLength={10000} rows={3} onChange={(event) => updateField('objective', event.target.value)} placeholder="완성할 사용자 흐름과 개발 범위" /></label>
          <label>공통 지침<textarea value={draft.instructions} maxLength={20000} rows={3} onChange={(event) => updateField('instructions', event.target.value)} placeholder="공통 제약, 기존 구현 활용 기준, 외부 대기와 완료 조건" /></label>
          {stale && <p className="group-message error">다른 곳에서 그룹 설정을 변경했습니다. 작성 중인 내용을 확인한 뒤 최신 내용을 불러오세요. <button type="button" onClick={() => { if (window.confirm('작성 중인 그룹 설정을 최신 저장 내용으로 바꿀까요?')) { draftBase.current = context.project; setDraft(context.project) } }}>최신 내용 불러오기</button></p>}
          <div className="group-actions"><button type="submit" disabled={busy || Boolean(stale) || !changed}>기준 저장</button>{changed && <small>AI를 시작하기 전에 변경 내용을 저장해 주세요.</small>}</div>
        </form> : <div className="group-project-summary"><p><strong>{context.project.sourceVersion || '버전 미등록'}</strong> · {context.project.source || '기획 원본을 등록해 주세요.'}</p><p>{context.project.objective || '전체 목표를 등록해 주세요.'}</p>{context.project.instructions && <details><summary>공통 지침</summary><p>{context.project.instructions}</p></details>}</div>}
      </section>
      <section className="group-project-card">
        <div className="group-section-title"><h2>총괄 AI</h2>{coordinator && <span className="group-badge">{coordinator.runtime ? runtimeLabels[coordinator.runtime.state] ?? 'AI 상태 확인 불가' : linked(coordinator) ? 'AI 상태 확인 불가' : '대화 미연결'}</span>}</div>
        {coordinator ? <><p>원본 분석, 문서 분할, 요구사항 소유권과 실행 순서를 관리합니다. 결정과 검증 근거는 <button className="group-text-button" onClick={() => onNavigate(coordinator.id, coordinator.root?.id)}>{coordinator.title}</button>에 기록합니다.</p>
          <div className="group-actions">{editable && <button className="primary" disabled={aiDisabled} onClick={() => launch(coordinator)}>총괄 AI 대화 시작</button>}{linked(coordinator) && <button onClick={() => openConversations(coordinator)}>연결된 대화 열기</button>}<button onClick={() => onNavigate(coordinator.id, coordinator.root?.id)}>통합 관리 문서 열기</button></div></>
          : <><p>통합 관리 문서에 총괄 대화와 전역 요구사항 원장을 연결합니다.</p>{editable && <div className="group-actions"><select aria-label="통합 관리 문서 선택" value={coordinatorChoice} onChange={(event) => setCoordinatorChoice(event.target.value)}><option value="">새 통합 관리 문서 만들기</option>{context.documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select><button className="primary" disabled={busy || Boolean(stale)} onClick={() => void save(true)}>총괄 준비</button></div>}</>}
      </section>
      <section className="group-project-card">
        <div className="group-section-title"><h2>담당 문서 <span>{documents.length}</span></h2><small>문서를 그룹으로 드래그하여 추가</small></div>
        <p className="group-muted">문서의 최상위 카드에 담당 범위와 완료 조건을 기록합니다. 업무 카드 집계와 요구사항 검증 현황은 별도로 확인합니다.</p>
        {documents.length === 0 ? <div className="group-empty">문서를 드래그해 넣거나 총괄 AI에게 기획 분석과 문서 구성을 요청하세요.</div> : <div className="group-document-list">{documents.map((document) => {
          const latest = context.delegations.find((item) => item.mapId === document.id)
          return <article key={document.id} className="group-document-row"><div className="group-document-heading"><button className="group-text-button" onClick={() => onNavigate(document.id, document.root?.id)}>{document.title}</button><span className="group-badge">{document.runtime ? runtimeLabels[document.runtime.state] ?? 'AI 상태 확인 불가' : linked(document) ? 'AI 상태 확인 불가' : '대화 미연결'}</span></div>
            <p className="group-scope">{document.root?.data.description || '담당 범위가 비어 있습니다. 최상위 카드에서 작성해 주세요.'}</p>
            <div className="group-row-meta"><span>하위 업무 {document.work.done}/{document.work.total} 완료 · 대기 {document.work.waiting}개</span>{latest && <span>{delegationLabels[latest.state] ?? latest.state}</span>}</div>
            <div className="group-actions"><button onClick={() => onNavigate(document.id, document.root?.id)}>최상위 카드 열기</button>{linked(document) && <button onClick={() => openConversations(document)}>AI 대화</button>}{editable && coordinator && <button disabled={aiDisabled || !document.root} onClick={() => launch(coordinator, `문서 "${document.title}"(targetMapId: ${document.id}, targetCardId: ${document.root?.id})의 최신 루트와 AI 작업 상태를 확인하세요. 담당 범위와 분석·검수 조건을 보완한 뒤, 적절한 기존 대화를 이어가거나 새 대화로 문서 분석·조정을 실제 위임하세요. 이미 진행 중인 작업이 있으면 중복 위임하지 말고 상태와 다음 단계를 알려주세요.`)}>총괄 AI에 위임 요청</button>}</div>
          </article>
        })}</div>}
        {editable && <details className="group-new-document"><summary>문서 직접 추가</summary><form onSubmit={(event) => { event.preventDefault(); void createDocument() }}><label>문서 이름<input value={newTitle} maxLength={80} required onChange={(event) => setNewTitle(event.target.value)} /></label><label>최상위 카드의 담당 범위와 완료 조건<textarea value={newDescription} maxLength={100000} rows={4} onChange={(event) => setNewDescription(event.target.value)} /></label><button disabled={busy || !newTitle.trim()}>문서 만들기</button></form></details>}
      </section>
      <section className="group-project-card"><div className="group-section-title"><h2>문서 위임과 결과</h2><small>{context.delegations.length}건</small></div>
        {context.delegations.length === 0 ? <p className="group-muted">총괄 AI가 문서 루트에 위임하면 실행 상태와 결과가 여기에 표시됩니다.</p> : context.delegations.map((item) => <details className="group-delegation" key={item.id}><summary><strong>{item.targetCardLabel}</strong><span>{delegationLabels[item.state] ?? item.state}</span></summary><p>{item.instructionPreview}</p>{(item.childError || item.linkError || item.recoveryWakeError) && <p className="group-message error">{item.childError || item.linkError || item.recoveryWakeError}</p>}{item.result && <pre>{item.result}</pre>}<button onClick={() => onNavigate(item.mapId, item.targetCardId)}>문서와 검증 근거 확인</button></details>)}
      </section>
    </>}
  </section>
}
