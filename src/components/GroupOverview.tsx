import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiConversationExplicitTarget } from '../utils/aiConversationLaunch.mjs'
import { buildGroupCoordinatorRequest, buildGroupDocumentRequest, buildGroupDocumentProposalRequest } from '../utils/aiApprovalInstructions.mjs'
import { copyTextToClipboard } from '../utils/clipboardText.mjs'
import { groupPageUrl } from '../utils/groupDeepLink.mjs'
import { filterGroupOverviewRows, groupDelegationPresentation, groupDelegationReportHint, groupOverviewRows, groupProjectDraftAfterRefresh } from '../utils/groupOverview.mjs'
import type { GroupContext, GroupDelegation as Delegation, GroupDocument, GroupProject as Project } from '../utils/groupOverview.mjs'
import { AiConversationRuntimeBadge } from './AiConversationRuntimeBadge'
import { groupOverviewFilters, groupWaitingCategories } from '../utils/groupWaiting.mjs'
import { GroupWaitingReasons, type GroupWaitingReviewInput } from './GroupWaitingReasons'
import { groupPlanningSources, groupPlanningSourceSummary, groupPlanningBaseline, groupProjectCriteriaEqual, withGroupPlanningSources } from '../utils/groupPlanningSources.mjs'
import { GroupPlanningSourceEditor, GroupPlanningSourceList } from './GroupPlanningSources'
import './GroupOverview.css'

export type GroupAiTarget = AiConversationExplicitTarget & { initialRequest: string }

const linked = (document: GroupDocument) => Boolean(document.root?.data.aiConversations?.length || document.root?.data.aiConversationId)
function RuntimeStatus({ document }: { document: GroupDocument }) {
  if (document.runtime?.state === 'running' || document.runtime?.state === 'waiting-confirmation') {
    return <AiConversationRuntimeBadge runtime={document.runtime} />
  }
  return <span className="group-muted">{document.runtime?.state === 'idle' ? 'AI 대기' : linked(document) ? 'AI 상태 확인 불가' : '대화 미연결'}</span>
}
function DelegationStatus({ item }: { item?: Delegation | null }) {
  const status = groupDelegationPresentation(item)
  return <span className={`group-status ${status.tone}`} title={groupDelegationReportHint(item)}>{status.label}</span>
}
const formatTime = (value: string) => new Date(value).toLocaleString()

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
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [linkCopyState, setLinkCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const linkCopyTimer = useRef<number | null>(null)
  const [coordinatorChoice, setCoordinatorChoice] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [panel, setPanel] = useState<'document' | 'criteria' | 'create'>('document')
  const [selectedMapId, setSelectedMapId] = useState('')
  const [selectedDelegationId, setSelectedDelegationId] = useState('')
  const [detailTab, setDetailTab] = useState<'scope' | 'results' | 'history' | 'reasons'>('results')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
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
      const previousBase = draftBase.current
      draftBase.current = value.project
      // StrictMode의 updater 재호출에서도 동일한 기준을 사용한다.
      setDraft((current) => groupProjectDraftAfterRefresh(current, previousBase, value.project))
      setLoadError('')
    } catch (reason) {
      if (mounted.current && sequence === loadSequence.current) setLoadError(reason instanceof Error ? reason.message : '그룹을 불러오지 못했습니다.')
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

  const changed = Boolean(draft && context && !groupProjectCriteriaEqual(draft, context.project))
  const stale = draft && context && draft.version !== context.project.version
  const updateField = (key: 'objective' | 'instructions', value: string) => setDraft((current) => current ? { ...current, [key]: value } : current)
  const save = async (prepare = false) => {
    if (!draft || !editable || !context?.sourcesSupported || busy || stale || loadError || (!prepare && !changed)) return
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await request<GroupContext>(baseUrl, clientId, { method: 'PATCH', body: JSON.stringify({
        baseVersion: draft.version, sources: groupPlanningSources(draft), objective: draft.objective, instructions: draft.instructions,
        ...(prepare ? coordinatorChoice ? { coordinatorMapId: coordinatorChoice } : { createCoordinator: true } : {}),
      }) })
      if (!mounted.current) return
      loadSequence.current++
      draftBase.current = value.project
      setContext(value); setDraft(value.project); setNotice(prepare ? '총괄 문서를 연결했습니다. AI에게 진행 방향을 제안받고 승인 후 실행할 수 있습니다.' : '그룹 정보를 저장했습니다.')
      setLoadError('')
      onLibraryChanged()
    } catch (reason) { if (mounted.current) setError(`기획 기준: ${reason instanceof Error ? reason.message : '저장하지 못했습니다.'}`) }
    finally { if (mounted.current) setBusy(false) }
  }
  function aiTarget(document: GroupDocument, instruction?: string): GroupAiTarget | null {
    if (!document.root || !context) return null
    const coordinator = document.id === context.project.coordinatorMapId
    return {
      purpose: coordinator ? 'group-coordination' : 'card', mapId: document.id, cardId: document.root.id,
      ...(coordinator ? { groupId, fullInitialRequest: true } : {}),
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
    if (!context || !newTitle.trim() || !editable || busy || changed || stale || loadError) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request(baseUrl + '/documents', clientId, { method: 'POST', body: JSON.stringify({ baseVersion: context.project.version, title: newTitle.trim(), description: newDescription }) })
      if (!mounted.current) return
      setNewTitle(''); setNewDescription(''); setNotice('문서와 최상위 카드를 만들었습니다. 담당 범위를 확인한 뒤 위임하세요.')
      await refresh(); onLibraryChanged()
    } catch (reason) { if (mounted.current) setError(`문서 추가: ${reason instanceof Error ? reason.message : '문서를 생성하지 못했습니다.'}`) }
    finally { if (mounted.current) setBusy(false) }
  }
  const rows = groupOverviewRows(context)
  const documents = rows.filter((row) => row.document)
  const visibleRows = filterGroupOverviewRows(rows, query, statusFilter)
  const selected = visibleRows.find((row) => row.mapId === selectedMapId) ?? visibleRows[0] ?? null
  const selectedDocument = selected?.document
  const delegation = selected?.delegations.find((item) => item.id === selectedDelegationId) ?? selected?.latest
  const coordinator = context?.coordinator
  const aiDisabled = busy || changed || Boolean(stale) || Boolean(loadError)
  async function reviewWaiting(input: GroupWaitingReviewInput): Promise<boolean> {
    if (!context || !editable || aiDisabled || !context.waitingReviewSupported) return false
    const target = context.documents.find((item) => item.id === input.mapId)
    if (!target) return false
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await request<GroupContext>(baseUrl, clientId, { method: 'PATCH', body: JSON.stringify({ baseVersion: context.project.version, baseWaitingReviewVersion: context.project.waitingReviewVersion ?? 0, waitingReview: input }) })
      if (!mounted.current) return false
      loadSequence.current++; draftBase.current = value.project
      setContext(value); setDraft(value.project); setLoadError('')
      // 분류 변경으로 현재 필터에서 사라져도 다른 문서를 조용히 선택하지 않는다.
      setStatusFilter('all'); setSelectedMapId(input.mapId)
      setNotice(`${target.title}: 대기 분류를 저장했습니다. 원문·대기 상태·업무 진행률은 변경하지 않았습니다.`)
      return true
    } catch (reason) {
      await refresh()
      if (mounted.current) setError(`${target.title} 대기 분류: ${reason instanceof Error ? reason.message : '저장하지 못했습니다.'}`)
      return false
    } finally { if (mounted.current) setBusy(false) }
  }
  function completedReplacement(item: Delegation) {
    return context?.delegations
      .filter((candidate) => candidate.id !== item.id && candidate.mapId === item.mapId
        && candidate.targetCardId === item.targetCardId && candidate.state === 'completed'
        && candidate.createdAt > item.createdAt)
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt))[0] ?? null
  }
  async function delegationAction(item: Delegation, action: 'refresh' | 'recover' | 'retry-report' | 'finalize-coordination' | 'supersede') {
    if (!context || !coordinator || !editable || aiDisabled) return
    const target = context.documents.find((document) => document.id === item.mapId)
    if (!target) return
    const replacement = action === 'supersede' ? completedReplacement(item) : null
    if (action === 'supersede' && !replacement) return setError('같은 카드에서 나중에 완료된 후속 위임을 찾을 수 없습니다.')
    if (action !== 'refresh' && !window.confirm(action === 'recover'
      ? '중단 원인이 해소되었고 현재 기획 기준·범위가 기존 사용자 승인 계획과 같음을 확인했나요? 같은 대화에서 현재 결과를 확인하고 미완료 부분만 이어갑니다. 이미 끝난 작업은 반복하지 않습니다. 기준이나 방향이 달라졌다면 취소하고 새 계획을 승인해 주세요.'
      : action === 'finalize-coordination'
        ? '문서 조정 AI의 실행만 종료해 현재 결과를 총괄 AI에 전달합니다. 카드 상태·진행률·외부 대기와 실제 미완료 하위 위임은 그대로 유지합니다. 변경 없이 한도에 막힌 과거 시도에 같은 카드의 완료된 후속 위임이 있으면 그 과거 시도만 후속 성공 이력으로 함께 정리합니다. 이 상태로 조정 실행을 종료할까요?'
        : action === 'supersede'
          ? `과거 한도 대기 위임을 완료 처리하지 않고, 성공한 후속 위임 ${replacement?.id}으로 이어졌다는 감사 이력을 남겨 종료합니다. 카드와 작업공간은 변경하지 않습니다. 계속할까요?`
        : item.resultAvailability === 'captured'
          ? '하위 작업은 재실행하지 않고 캡처된 기존 완료 결과를 총괄 AI에 전달합니다. 총괄 AI가 실행 중이면 전달 순서를 기다립니다. 기존 승인 범위에서 결과를 검토하도록 재개할까요?'
          : '하위 작업은 재실행하지 않습니다. 이 위임의 결과 원문이 캡처되지 않았거나 무결성을 확인할 수 없어, 다른 작업의 최신 응답 대신 작업공간·체크포인트·통합 메타데이터만 총괄 AI에 전달합니다. 계속할까요?')) return
    setBusy(true); setError(''); setNotice('')
    try {
      const actionResult = await request<{ supersededDelegations?: Array<{ delegationId: string; replacementDelegationId: string }> }>(`/api/maps/${encodeURIComponent(coordinator.id)}/ai-delegations/${encodeURIComponent(item.id)}/${action}`, clientId, { method: 'POST', body: JSON.stringify({
        expectedUpdatedAt: item.updatedAt, sourceRevision: coordinator.version, targetRevision: target.version,
        groupVersion: context.project.version, confirmApprovedScope: action !== 'refresh',
        confirmPendingWorkPreserved: action === 'finalize-coordination',
        confirmSupersededByCompletedDelegation: action === 'supersede',
        ...(replacement ? { replacementDelegationId: replacement.id } : {}),
        ...(action === 'recover' ? { instruction: '사용자가 총괄 화면에서 기존 승인 범위의 재개를 요청했습니다. 최신 그룹 기준과 원래 사용자 승인 근거·계획을 먼저 대조하세요. 같은 대화에서 이미 진행된 문서·하위 위임·검수 결과를 확인하고, 완료된 작업은 반복하지 말고 결과를 보고하세요. 남은 작업만 기존 승인 범위에서 이어가며 기준·방향·범위가 달라졌으면 제안 후 재승인을 기다리세요. 새 작업공간을 임의 점유하거나 새 위임으로 우회하지 마세요.' } : {}),
      }) })
      await refresh()
      const supersededCount = actionResult.supersededDelegations?.length ?? 0
      if (mounted.current) setNotice(`${target.title}: ${action === 'refresh' ? '실행 요청 없이 기존 위임 상태를 확인했습니다.' : action === 'recover' ? '기존 대화에 재개 요청을 전달했습니다. 완료된 작업은 확인하고 미완료 부분만 이어갑니다.' : action === 'finalize-coordination' ? `카드와 외부 대기를 유지한 채 문서 조정 종료와 총괄 보고를 접수했습니다.${supersededCount ? ` 후속 성공으로 해소된 과거 한도 대기 ${supersededCount}건도 함께 정리했습니다.` : ''}` : action === 'supersede' ? '과거 한도 대기 위임을 성공한 후속 위임과 연결해 종료했습니다.' : item.resultAvailability === 'captured' ? '캡처된 결과 재전달을 접수했습니다. 하위 작업은 재실행하지 않습니다.' : '결과 원문을 제외한 메타데이터 전용 재전달을 접수했습니다. 하위 작업은 재실행하지 않습니다.'}`)
    } catch (reason) {
      await refresh()
      if (mounted.current) setError(`${target.title}: ${reason instanceof Error ? reason.message : '위임 상태를 처리하지 못했습니다.'}`)
    } finally { if (mounted.current) setBusy(false) }
  }

  return <section className="group-overview" aria-label={`${name} 그룹 개요`}>
    <header className="group-overview-header"><div className="group-heading"><small>그룹 · 총괄 AI</small><div className="group-page-title"><h1>{name}</h1>
      <button type="button" className={`group-link-copy-button ${linkCopyState}`} onClick={() => void copyPageLink()} disabled={linkCopyState === 'copying'} aria-label="총괄 AI 페이지 URL 복사" title={linkCopyState === 'copied' ? '링크가 복사되었습니다' : '총괄 AI 페이지 URL 복사'}>
        <svg className="icon" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">{linkCopyState === 'copied' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>}</svg>
      </button>
    </div></div><div className="group-actions group-header-actions">
      {coordinator ? <><RuntimeStatus document={coordinator} />{editable && <button className="primary" disabled={aiDisabled || !coordinator.root} onClick={() => launch(coordinator)}>총괄 AI 대화 시작</button>}{linked(coordinator) && <button onClick={() => openConversations(coordinator)}>연결된 대화</button>}<button onClick={() => onNavigate(coordinator.id, coordinator.root?.id)}>통합 관리 문서</button></>
        : context && <button onClick={() => setPanel('criteria')}>총괄 {editable ? '설정' : '미연결'}</button>}
      <button onClick={() => void refresh()} disabled={busy}>새로고침</button>
    </div></header>
    {!context || !draft ? <div className="group-empty" aria-live="polite">{loadError ? '그룹 정보를 불러오지 못했습니다. 새로고침으로 다시 시도해 주세요.' : '그룹 정보를 불러오는 중…'}</div> : <>
      <div className="group-criteria-strip">
        <button aria-pressed={panel === 'criteria'} onClick={() => setPanel(panel === 'criteria' ? 'document' : 'criteria')}>기획 기준{changed ? ' · 미저장' : ''}</button>
        <strong title={groupPlanningBaseline(context.project)}>{groupPlanningSourceSummary(context.project)}</strong><span title={context.project.objective}>{context.project.objective || '전체 목표를 등록해 주세요.'}</span>
      </div>
      <div className="group-master-detail">
        <section className="group-list-panel" aria-label="담당 문서 목록">
          <div className="group-panel-heading"><h2>담당 문서 <span>{documents.length}</span></h2>{editable && <button aria-pressed={panel === 'create'} onClick={() => setPanel('create')}>문서 추가</button>}</div>
          <div className="group-list-tools">
            <input type="search" aria-label="담당 문서 검색" placeholder="문서 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
            <select className="group-status-filter" aria-label="문서 상태 필터" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPanel('document'); if (event.target.value !== 'all') setDetailTab('reasons') }}>{groupOverviewFilters.map((filter) => <option key={filter.id} value={filter.id}>{filter.label} · {filter.id === 'all' ? rows.length : rows.filter((row) => row.filters.includes(filter.id)).length}문서</option>)}</select>
            <small className="group-filter-explanation">문서 수 기준 · 한 문서가 여러 분류에 포함될 수 있습니다.</small>
          </div>
          <div className="group-document-list">
            {!visibleRows.length && <p className="group-empty">{rows.length ? '조건에 맞는 문서가 없습니다.' : '왼쪽 보관함에서 문서를 그룹으로 드래그하거나 문서를 추가하세요.'}</p>}
            {visibleRows.map((row) => <button key={row.mapId} className="group-document-row" data-map-id={row.mapId} aria-pressed={panel === 'document' && selected?.mapId === row.mapId} onClick={() => { setSelectedMapId(row.mapId); setSelectedDelegationId(''); setPanel('document') }}>
              <span className="group-document-heading"><strong>{row.title}</strong>{row.document ? <RuntimeStatus document={row.document} /> : <span className="group-muted">이전 소속 · 이력</span>}</span>
              <span className="group-row-meta">{row.document ? `하위 업무 ${row.document.work.done}/${row.document.work.total} 완료 · 대기 업무 ${row.document.work.waiting}개` : `이전 위임 ${row.delegations.length}건`}</span>
              <DelegationStatus item={row.latest} />
              {row.attention && <span className="group-reason-tags">{row.aiAttention && <span className="group-status warning">AI 확인·복구</span>}{row.filters.includes('blocking') && <span className="group-status danger">현재 범위 차단</span>}{row.filters.includes('deferred') && <span className="group-status">예정된 외부 대기</span>}{groupWaitingCategories.filter((category) => row.filters.includes(category.id)).map((category) => <span className="group-status" key={category.id}>{category.label}</span>)}{row.filters.includes('unreviewed') && <span className="group-status">범위 영향 미확인</span>}</span>}
            </button>)}
          </div>
          <div className="group-list-note">업무 카드 집계이며 요구사항 검증 완료율은 아닙니다.{rows.length > documents.length && ' 이전 소속 문서의 위임 이력도 표시합니다.'}</div>
        </section>
        <section className="group-detail-panel" aria-label={panel === 'criteria' ? '기획 기준 상세' : panel === 'create' ? '문서 추가' : '문서 상세'}>
          {panel === 'criteria' ? <>
            <div className="group-panel-heading"><h2>기획 기준</h2><button onClick={() => setPanel('document')}>문서로 돌아가기</button></div>
            <div className="group-detail-scroll">
              <p className="group-muted">총괄 AI와 문서 AI가 공유하는 기준입니다. 저장만으로 AI 작업이 실행되지는 않습니다.</p>
              {!context.sourcesSupported && <p className="group-inline-error" role="alert">여러 기획서 등록을 사용하려면 MnP 서버를 재시작한 뒤 새로고침해 주세요. 현재 기준은 그대로 보존됩니다.</p>}
              {editable ? <form id="group-criteria-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
                <fieldset disabled={busy || !context.sourcesSupported}><GroupPlanningSourceEditor sources={groupPlanningSources(draft)} onChange={(sources) => setDraft((current) => current ? withGroupPlanningSources(current, sources) : current)} />
                <label>전체 목표<textarea value={draft.objective} maxLength={10000} rows={5} onChange={(event) => updateField('objective', event.target.value)} placeholder="완성할 사용자 흐름과 개발 범위" /></label>
                <label>공통 지침<textarea value={draft.instructions} maxLength={20000} rows={8} onChange={(event) => updateField('instructions', event.target.value)} placeholder="공통 제약, 기존 구현 활용 기준, 외부 대기와 완료 조건" /></label></fieldset>
              </form> : <><h3>기획서</h3><GroupPlanningSourceList project={context.project} /><h3>전체 목표</h3><p className="group-full-text">{context.project.objective || '목표 미등록'}</p><h3>공통 지침</h3><p className="group-full-text">{context.project.instructions || '지침 미등록'}</p></>}
              <div className="group-coordinator-settings"><h3>총괄 문서</h3>{coordinator ? <p>결정과 검증 근거는 <button className="group-text-button" onClick={() => onNavigate(coordinator.id, coordinator.root?.id)}>{coordinator.title}</button>에 기록합니다.</p> : <><p>통합 관리 문서에 총괄 대화와 전역 요구사항 원장을 연결합니다.</p>{editable && <label>통합 관리 문서 선택<select value={coordinatorChoice} disabled={busy} onChange={(event) => setCoordinatorChoice(event.target.value)}><option value="">새 통합 관리 문서 만들기</option>{context.documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>}</>}</div>
            </div>
            {editable && <div className="group-detail-actions"><button type="submit" form="group-criteria-form" className="primary" disabled={busy || !context.sourcesSupported || Boolean(stale) || Boolean(loadError) || !changed}>기준 저장</button>{!coordinator && <button disabled={busy || !context.sourcesSupported || Boolean(stale) || Boolean(loadError)} onClick={() => void save(true)}>기준 저장 · 총괄 준비</button>}</div>}
          </> : panel === 'create' && editable ? <>
            <div className="group-panel-heading"><h2>문서 추가</h2><button onClick={() => setPanel('document')}>문서로 돌아가기</button></div>
            <div className="group-detail-scroll"><p className="group-muted">문서와 최상위 카드만 만듭니다. AI 위임은 별도로 제안받고 승인합니다.</p><form id="group-create-form" onSubmit={(event) => { event.preventDefault(); void createDocument() }}><fieldset disabled={busy}><label>문서 이름<input value={newTitle} maxLength={80} required onChange={(event) => setNewTitle(event.target.value)} /></label><label>최상위 카드의 담당 범위와 완료 조건<textarea value={newDescription} maxLength={100000} rows={12} onChange={(event) => setNewDescription(event.target.value)} /></label></fieldset></form></div>
            <div className="group-detail-actions"><button type="submit" form="group-create-form" className="primary" disabled={aiDisabled || !newTitle.trim()}>문서 만들기</button></div>
          </> : selected ? <>
            <div className="group-panel-heading group-detail-heading"><div><h2>{selected.title}</h2><small>{selectedDocument ? '최상위 카드의 담당 범위와 실행 기록' : '현재 그룹에서 제외된 문서 · 위임 이력 읽기 전용'}</small></div>{selectedDocument && <RuntimeStatus document={selectedDocument} />}</div>
            <nav className="group-detail-tabs" aria-label="문서 상세 보기"><button aria-pressed={detailTab === 'scope'} onClick={() => setDetailTab('scope')}>담당 범위</button><button aria-pressed={detailTab === 'reasons'} onClick={() => setDetailTab('reasons')}>대기 사유 {selected.reasons.length}{selected.waitingUnavailable ? '+' : ''}</button><button aria-pressed={detailTab === 'results'} onClick={() => setDetailTab('results')}>위임·결과 {selected.delegations.length}</button><button aria-pressed={detailTab === 'history'} onClick={() => setDetailTab('history')}>복구 이력</button></nav>
            {(detailTab === 'results' || detailTab === 'history') && delegation && <div className="group-execution-picker"><label>위임 기록<select aria-label="위임 기록 선택" value={delegation.id} onChange={(event) => setSelectedDelegationId(event.target.value)}>{selected.delegations.map((item, index) => <option key={item.id} value={item.id}>{index === 0 ? '최신 · ' : ''}{formatTime(item.createdAt)} · {groupDelegationPresentation(item).label}</option>)}</select></label></div>}
            <div className="group-detail-scroll" key={`${selected.mapId}-${detailTab}-${delegation?.id ?? ''}`}>
              {detailTab === 'reasons' ? <GroupWaitingReasons key={`${selected.mapId}:${statusFilter}`} row={selected} project={context.project} editable={editable} disabled={aiDisabled} supported={Boolean(context.waitingReviewSupported)} filter={statusFilter} onNavigate={onNavigate} onReview={reviewWaiting} onAiDetails={() => { setSelectedDelegationId(''); setDetailTab('results') }} onConversations={() => { if (selectedDocument) openConversations(selectedDocument) }} />
                : detailTab === 'scope' ? <><h3>담당 범위 · 완료 조건</h3><p className="group-full-text">{selectedDocument?.root?.data.description || (selectedDocument ? '담당 범위가 비어 있습니다. 최상위 카드에서 작성해 주세요.' : '현재 그룹 소속이 아닙니다. 원문 문서에서 담당 범위를 확인해 주세요.')}</p>{selectedDocument?.root?.data.sharedKnowledge && <><h3>공유 지식 · 검증 근거</h3><p className="group-full-text">{selectedDocument.root.data.sharedKnowledge}</p></>}</>
                : !delegation ? <p className="group-empty">아직 위임 기록이 없습니다. 총괄 AI에게 문서별 실행 계획을 제안받고 승인한 뒤 진행하세요.</p>
                  : detailTab === 'history' ? <><p className="group-muted">선택한 위임의 이전 실행·복구 기록입니다. 현재 결과와 구분해 확인하세요.</p>{delegation.attemptHistory?.length ? delegation.attemptHistory.map((attempt, index) => <article className="group-attempt" key={index}><h3>{formatTime(attempt.at)} · {attempt.reason}</h3>{attempt.childError && <p className="group-inline-error">문서 AI: {attempt.childError}</p>}{attempt.parentError && <p className="group-inline-error">총괄 AI: {attempt.parentError}</p>}{attempt.result && <pre className="group-full-text">{attempt.result}</pre>}</article>) : <p className="group-empty">이 위임에 기록된 복구 이력이 없습니다.</p>}</>
                    : <><div className="group-result-status"><DelegationStatus item={delegation} /><small>상태 변경 {formatTime(delegation.updatedAt || delegation.createdAt)}</small></div><h3>위임 지시</h3><p className="group-full-text">{delegation.instructionPreview || '기록된 지시가 없습니다.'}</p>
                      {([['문서 AI', delegation.childError], ['총괄 AI', delegation.parentError], ['연결', delegation.linkError], ['복구 전달', delegation.recoveryWakeError]] as const).map(([label, message]) => message && <p className="group-inline-error" key={label}>{label}: {message}</p>)}
                      {groupDelegationReportHint(delegation) && <p className="group-muted">{groupDelegationReportHint(delegation)}</p>}
                      <h3>{delegation.workCompleted ? '실행 결과 요약' : '중간 결과'}</h3><p className="group-muted">{delegation.workCompleted ? '실행 완료와 요구사항 검증 완료는 다릅니다. 검증 근거는 문서에서 확인하세요.' : '중단 시점의 결과는 완료 근거가 아닙니다.'}</p>
                      {delegation.resultAvailability === 'integrity-failed' && <p className="group-inline-error">저장된 결과의 해시 또는 실행 턴이 위임 기록과 일치하지 않아 원문을 표시하거나 재전달하지 않습니다.</p>}
                      {delegation.resultAvailability === 'unavailable' && <p className="group-inline-error">이 위임의 결과 원문이 캡처되지 않았습니다. 재전달 시 다른 작업의 최신 응답으로 대체하지 않고 메타데이터만 전달합니다.</p>}
                      <pre className="group-full-text">{delegation.result || (delegation.resultAvailability === 'integrity-failed' ? '무결성을 확인할 수 없는 결과는 제외했습니다.' : delegation.resultAvailability === 'unavailable' ? '캡처된 결과 원문이 없습니다.' : '아직 전달된 결과가 없습니다.')}</pre>
                    </>}
            </div>
            <div className="group-detail-footer">
              <div className="group-detail-actions">
                <button onClick={() => onNavigate(selected.mapId, selectedDocument?.root?.id ?? delegation?.targetCardId)}>문서와 검증 근거 확인</button>
                {selectedDocument && linked(selectedDocument) && <button onClick={() => openConversations(selectedDocument)}>AI 대화</button>}
                {editable && coordinator && selectedDocument && <button disabled={aiDisabled || !selectedDocument.root || !coordinator.root} onClick={() => launch(coordinator, buildGroupDocumentProposalRequest({ mapId: selectedDocument.id, cardId: selectedDocument.root?.id ?? '', title: selectedDocument.title }))}>위임 제안 요청</button>}
              </div>
              {(detailTab === 'results' || detailTab === 'history') && delegation && editable && selectedDocument && coordinator && <div className="group-recovery-actions"><small>선택 위임 · {formatTime(delegation.createdAt)}</small><div className="group-actions">
                {delegation.displayState && <button disabled={aiDisabled} onClick={() => void delegationAction(delegation, 'refresh')}>상태 다시 확인</button>}
                {delegation.displayState && delegation.recovery?.recoveryAvailable && <button disabled={aiDisabled} onClick={() => void delegationAction(delegation, 'recover')}>승인 범위 작업 재개</button>}
                {delegation.coordinationOnly && (delegation.state === 'waiting-document-work' || (delegation.state === 'recovery-required' && delegation.result)) && <button disabled={aiDisabled} onClick={() => void delegationAction(delegation, 'finalize-coordination')}>대기 유지하고 조정 종료</button>}
                {['waiting-usage-limit', 'waiting-rate-limit'].includes(delegation.state) && completedReplacement(delegation) && <button disabled={aiDisabled} onClick={() => void delegationAction(delegation, 'supersede')}>후속 성공으로 종료</button>}
                {delegation.recovery?.reportRetryAvailable && <button disabled={aiDisabled} onClick={() => void delegationAction(delegation, 'retry-report')}>결과 전달 재시도</button>}
              </div></div>}
            </div>
          </> : <div className="group-empty">{rows.length ? '문서를 선택하거나 검색 조건을 바꿔 주세요.' : <>총괄 AI에게 기획 분석과 문서 구성을 제안받으세요.{!coordinator && <button onClick={() => setPanel('criteria')}>기획 기준과 총괄 설정</button>}</>}</div>}
        </section>
      </div>
    </>}
    <footer className="group-feedback">
      <div className="group-approval-note">전체 방향 제안 → 사용자 승인 → 문서별 계획 제안 → 사용자 승인 후 실행</div>
      {loadError && <div className="group-message error" role="alert">정보 갱신 실패: {loadError} · 실행 전 새로고침해 주세요.</div>}
      {error && <div className="group-message error" role="alert"><span>{error}</span><button aria-label="작업 오류 닫기" onClick={() => setError('')}>닫기</button></div>}
      {notice && <div className="group-message" role="status"><span>{notice}</span><button aria-label="작업 알림 닫기" onClick={() => setNotice('')}>닫기</button></div>}
      <div aria-live="polite" aria-atomic="true">{linkCopyState === 'copied' && <div className="group-message">총괄 AI 페이지 링크를 복사했습니다.</div>}{linkCopyState === 'failed' && <div className="group-message error">링크를 복사하지 못했습니다. 연결과 클립보드 권한을 확인한 뒤 다시 시도해 주세요.</div>}</div>
      {stale && context ? <div className="group-message warning">다른 곳에서 기획 기준이 변경되었습니다. 작성 중인 내용은 보존했습니다.<button disabled={busy} onClick={() => { if (window.confirm('작성 중인 그룹 설정을 최신 저장 내용으로 바꿀까요?')) { draftBase.current = context.project; setDraft(context.project) } }}>최신 내용 불러오기</button></div> : changed && <div className="group-message warning">기획 기준에 저장하지 않은 변경이 있습니다. AI 실행 전에 저장해 주세요.<button onClick={() => setPanel('criteria')}>기준 확인</button></div>}
    </footer>
  </section>
}
