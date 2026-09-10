import { useCallback, useEffect, useRef, useState } from 'react'
import type { MindNodeData, AiConversationRuntime } from '../types/mindMap'
import type { AiConversationExplicitTarget } from '../utils/aiConversationLaunch.mjs'
import { buildGroupCoordinatorRequest, buildGroupDocumentRequest, buildGroupDocumentProposalRequest } from '../utils/aiApprovalInstructions.mjs'
import { copyTextToClipboard } from '../utils/clipboardText.mjs'
import { groupPageUrl } from '../utils/groupDeepLink.mjs'
import './GroupOverview.css'

type Project = { version: number; coordinatorMapId: string | null; source: string; sourceVersion: string; objective: string; instructions: string }
type GroupDocument = { id: string; title: string; version: number; root: { id: string; data: MindNodeData } | null; runtime: AiConversationRuntime | null; work: { total: number; done: number; waiting: number } }
type Delegation = { id: string; mapId: string; targetCardId: string; targetCardLabel: string; state: string; displayState?: string; instructionPreview: string; childError?: string; parentError?: string; recoveryWakeError?: string; linkError?: string; createdAt: string; updatedAt: string; result?: string; workCompleted?: boolean; reportPending?: boolean; recovery?: { recoveryAvailable: boolean; reportRetryAvailable?: boolean; failureCategory?: string }; attemptHistory?: Array<{ at: string; reason: string; childError?: string; parentError?: string; result?: string }> }
type GroupContext = { group: { id: string; name: string; mapIds: string[] }; project: Project; coordinator: GroupDocument | null; documents: GroupDocument[]; delegations: Delegation[]; guide: { coordinator: string } }
export type GroupAiTarget = AiConversationExplicitTarget & { initialRequest: string }

const runtimeLabels: Record<string, string> = { running: 'AI 실행 중', 'waiting-confirmation': 'AI 확인 대기', idle: 'AI 대기', unknown: 'AI 상태 확인 불가' }
const delegationLabels: Record<string, string> = {
  'recovery-dispatch-pending': '복구 요청 전달 확인 대기',
  'waiting-usage-limit': '사용량 회복 대기', 'waiting-rate-limit': '요청 제한 해제 대기', 'parent-wake-failed': '총괄 보고 실패 · 확인 필요',
  running: '문서 AI 실행 중', 'waiting-document-work': '하위 업무와 문서 검수 대기',
  starting: '실행 준비', 'running-child': '문서 AI 실행 중', 'waiting-child': '문서 AI 실행 중', 'waiting-resource': '실행 자원 대기',
  'waiting-child-resume': '문서 AI 재개 대기', 'waiting-parent': '총괄 보고 대기', 'waking-parent': '총괄 AI 검토 중',
  completed: '실행 완료 · 검증 근거 확인', failed: '실행 실패', superseded: '후속 위임으로 이어짐',
  'recovery-required': '복구 필요', 'integration-recovery-required': '통합 복구 필요', 'waiting-workspace': '작업공간 대기',
  'waiting-integration-clean': '통합 준비 대기', resuming: '재개 중',
}
const delegationLabel = (item: Delegation) => item.workCompleted && item.reportPending
  ? '작업 완료 · 총괄 보고 대기'
  : delegationLabels[item.displayState ?? item.state] ?? item.state

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
  const [linkCopyState, setLinkCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const linkCopyTimer = useRef<number | null>(null)
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

  useEffect(() => () => {
    if (linkCopyTimer.current !== null) window.clearTimeout(linkCopyTimer.current)
  }, [])

  const copyPageLink = async () => {
    if (linkCopyState === 'copying') return
    if (linkCopyTimer.current !== null) window.clearTimeout(linkCopyTimer.current)
    setLinkCopyState('copying')
    try {
      const health = await request<{ publicBaseUrl: string }>('/api/health', clientId)
      await copyTextToClipboard(groupPageUrl(health.publicBaseUrl, groupId))
      if (!mounted.current) return
      setLinkCopyState('copied')
      linkCopyTimer.current = window.setTimeout(() => setLinkCopyState('idle'), 2500)
    } catch {
      if (mounted.current) setLinkCopyState('failed')
    }
  }

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
      setContext(value); setDraft(value.project); setNotice(prepare ? '총괄 문서를 연결했습니다. AI에게 진행 방향을 제안받고 승인 후 실행할 수 있습니다.' : '그룹 정보를 저장했습니다.')
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
        ? buildGroupCoordinatorRequest({ groupId, instruction })
        : buildGroupDocumentRequest({ groupId, groupName: name }),
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
  async function delegationAction(item: Delegation, action: 'refresh' | 'recover' | 'retry-report') {
    if (!context || !coordinator) return
    const target = context.documents.find((document) => document.id === item.mapId)
    if (!target) return
    if (action !== 'refresh' && !window.confirm(action === 'recover'
      ? '중단 원인이 해소되었고 현재 기획 기준·범위가 기존 사용자 승인 계획과 같음을 확인했나요? 같은 대화에서 현재 결과를 확인하고 미완료 부분만 이어갑니다. 이미 끝난 작업은 반복하지 않습니다. 기준이나 방향이 달라졌다면 취소하고 새 계획을 승인해 주세요.'
      : '하위 작업은 재실행하지 않고 기존 완료 결과를 총괄 AI에 전달합니다. 총괄 AI가 실행 중이면 전달 순서를 기다립니다. 기존 승인 범위에서 결과를 검토하도록 재개할까요?')) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request(`/api/maps/${encodeURIComponent(coordinator.id)}/ai-delegations/${encodeURIComponent(item.id)}/${action}`, clientId, { method: 'POST', body: JSON.stringify({
        expectedUpdatedAt: item.updatedAt, sourceRevision: coordinator.version, targetRevision: target.version,
        groupVersion: context.project.version, confirmApprovedScope: action !== 'refresh',
        ...(action === 'recover' ? { instruction: '사용자가 총괄 화면에서 기존 승인 범위의 재개를 요청했습니다. 최신 그룹 기준과 원래 사용자 승인 근거·계획을 먼저 대조하세요. 같은 대화에서 이미 진행된 문서·하위 위임·검수 결과를 확인하고, 완료된 작업은 반복하지 말고 결과를 보고하세요. 남은 작업만 기존 승인 범위에서 이어가며 기준·방향·범위가 달라졌으면 제안 후 재승인을 기다리세요. 새 작업공간을 임의 점유하거나 새 위임으로 우회하지 마세요.' } : {}),
      }) })
      await refresh()
      setNotice(action === 'refresh' ? '실행 요청 없이 기존 위임 상태를 확인했습니다. 다른 턴에서 이어진 작업은 재개 기능으로 기존 결과부터 확인할 수 있습니다.' : action === 'recover' ? '기존 대화에 재개 요청을 전달했습니다. 완료된 작업은 재검토하고 미완료 부분만 이어갑니다.' : '결과 재전달을 접수했습니다. 하위 작업은 재실행하지 않습니다.')
    } catch (reason) {
      await refresh()
      setError(reason instanceof Error ? reason.message : '위임 상태를 처리하지 못했습니다.')
    } finally { setBusy(false) }
  }

  return <section className="group-overview" aria-label={`${name} 그룹 개요`}>
    <header className="group-overview-header"><div><small>그룹 · 기획과 개발</small><div className="group-page-title"><h1>{name}</h1>
      <button type="button" className={`group-link-copy-button ${linkCopyState}`} onClick={() => void copyPageLink()} disabled={linkCopyState === 'copying'} aria-label="총괄 AI 페이지 URL 복사" title={linkCopyState === 'copied' ? '링크가 복사되었습니다' : '총괄 AI 페이지 URL 복사'}>
        <svg className="icon" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">{linkCopyState === 'copied' ? <path d="m5 12 4 4L19 6" /> : <><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>}</svg>
      </button>
    </div><p>기획 기준과 담당 범위를 공유하고, 문서별 분석·개발 결과를 모읍니다.</p></div><button onClick={() => void refresh()} disabled={busy}>새로고침</button></header>
    <div aria-live="polite" aria-atomic="true">{linkCopyState === 'copied' && <p className="group-message">총괄 AI 페이지 링크를 복사했습니다.</p>}{linkCopyState === 'failed' && <p className="group-message error">링크를 복사하지 못했습니다. 연결과 클립보드 권한을 확인한 뒤 다시 시도해 주세요.</p>}</div>
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
        <p className="group-muted">전체 방향 승인 후에도 문서별 실행 계획을 사용자에게 제안하고 승인받습니다. 업무 카드 집계와 요구사항 검증 현황은 별도로 확인합니다.</p>
        {documents.length === 0 ? <div className="group-empty">문서를 드래그해 넣거나 총괄 AI에게 기획 분석과 문서 구성을 요청하세요.</div> : <div className="group-document-list">{documents.map((document) => {
          const latest = context.delegations.find((item) => item.mapId === document.id)
          return <article key={document.id} className="group-document-row"><div className="group-document-heading"><button className="group-text-button" onClick={() => onNavigate(document.id, document.root?.id)}>{document.title}</button><span className="group-badge">{document.runtime ? runtimeLabels[document.runtime.state] ?? 'AI 상태 확인 불가' : linked(document) ? 'AI 상태 확인 불가' : '대화 미연결'}</span></div>
            <p className="group-scope">{document.root?.data.description || '담당 범위가 비어 있습니다. 최상위 카드에서 작성해 주세요.'}</p>
            <div className="group-row-meta"><span>하위 업무 {document.work.done}/{document.work.total} 완료 · 대기 {document.work.waiting}개</span>{latest && <span>{delegationLabel(latest)}</span>}</div>
            <div className="group-actions"><button onClick={() => onNavigate(document.id, document.root?.id)}>최상위 카드 열기</button>{linked(document) && <button onClick={() => openConversations(document)}>AI 대화</button>}{editable && coordinator && <button disabled={aiDisabled || !document.root} onClick={() => launch(coordinator, buildGroupDocumentProposalRequest({ mapId: document.id, cardId: document.root?.id ?? '', title: document.title }))}>총괄 AI에 위임 제안 요청</button>}</div>
          </article>
        })}</div>}
        {editable && <details className="group-new-document"><summary>문서 직접 추가</summary><form onSubmit={(event) => { event.preventDefault(); void createDocument() }}><label>문서 이름<input value={newTitle} maxLength={80} required onChange={(event) => setNewTitle(event.target.value)} /></label><label>최상위 카드의 담당 범위와 완료 조건<textarea value={newDescription} maxLength={100000} rows={4} onChange={(event) => setNewDescription(event.target.value)} /></label><button disabled={busy || !newTitle.trim()}>문서 만들기</button></form></details>}
      </section>
      <section className="group-project-card"><div className="group-section-title"><h2>문서 위임과 결과</h2><small>{context.delegations.length}건</small></div>
        <p className="group-muted">사용량 제한은 실행 실패와 구분합니다. 작업 재개는 기존 승인 범위에서만 수행하며, 보고 재시도는 하위 작업을 다시 실행하지 않습니다.</p>
        {context.delegations.length === 0 ? <p className="group-muted">총괄 AI가 문서 루트에 위임하면 실행 상태와 결과가 여기에 표시됩니다.</p> : context.delegations.map((item) => <details className="group-delegation" key={item.id}>
          <summary><strong>{item.targetCardLabel}</strong><span>{delegationLabel(item)}</span></summary>
          <p>{item.instructionPreview}</p><p className="group-muted">마지막 상태 변경: {new Date(item.updatedAt ?? item.createdAt).toLocaleString()}</p>
          {(item.childError || item.parentError || item.linkError || item.recoveryWakeError) && <p className="group-message error">{item.childError || item.parentError || item.linkError || item.recoveryWakeError}</p>}
          {item.result && <><small>{item.workCompleted ? '실행 결과 요약 · 요구사항 검증 근거는 문서에서 확인' : '중단 시점 결과 · 완료 근거가 아닙니다'}</small><pre>{item.result}</pre></>}
          <div className="group-actions"><button onClick={() => onNavigate(item.mapId, item.targetCardId)}>문서와 검증 근거 확인</button>
            {editable && item.displayState && <button disabled={aiDisabled} onClick={() => void delegationAction(item, 'refresh')}>상태 다시 확인</button>}
            {editable && item.displayState && item.recovery?.recoveryAvailable && <button disabled={aiDisabled} onClick={() => void delegationAction(item, 'recover')}>승인 범위 작업 재개</button>}
            {editable && item.recovery?.reportRetryAvailable && <button disabled={aiDisabled} onClick={() => void delegationAction(item, 'retry-report')}>결과 전달 재시도</button>}
          </div>
          {!!item.attemptHistory?.length && <details><summary>이전 실행·복구 이력 {item.attemptHistory.length}건</summary>{item.attemptHistory.map((attempt, index) => <div key={index}><p>{new Date(attempt.at).toLocaleString()} · {attempt.reason}</p>{(attempt.childError || attempt.parentError) && <p>{attempt.childError || attempt.parentError}</p>}{attempt.result && <pre>{attempt.result}</pre>}</div>)}</details>}
        </details>)}
      </section>
    </>}
  </section>
}
