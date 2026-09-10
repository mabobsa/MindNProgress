import { useCallback, useEffect, useRef, useState } from 'react'
import { documentReconstructionGuide } from '../utils/documentReconstructionGuide.mjs'
import { buildReconstructionRequestPrompt } from '../utils/documentReconstructionRequest.mjs'
import { AiConversationDialog } from './AiConversationDialog'
import type { TeamMember } from '../types/mindMap'
import { ReconstructionMap, type ReconstructionPreviewMap } from './ReconstructionMap'
import { verifyRenderedLayout, type LayoutMeasurement, type MindMapLayout } from '../utils/mindMapLayout.mjs'
import './DocumentLifecycle.css'

type Document = { id: string; title: string; version: number; nodeCount: number; lifecycleVersion?: number; archivedAt?: string | null; archiveReason?: string; successorMapIds?: string[] }
type Operation = { id: string; state: string; reason: string; createdAt: string; sources: { mapId: string }[]; targetMapIds: string[]; decisions: { mapId: string; cardId: string; disposition: string; reason: string; evidence?: string; targets?: { key: string; cardId: string }[] }[] }
type Stats = { documents: number; cards: number; work: number; done: number; unfinished: number; waitingCards: number; references: number }
type Preview = { id: string; previewHash: string; layoutPhase: 'draft' | 'measured' | 'verified'; baseline: string; reason: string; newSource?: string; changeSummary?: string; before: Stats; after: Stats; warnings: string[]; dispositionCounts: Record<string, number>; sourceCards: { mapId: string; cardId: string; label: string }[]; targets: { key: string; map: ReconstructionPreviewMap; renderMap: ReconstructionPreviewMap; layout: MindMapLayout }[] }
type Scope = { type: 'map' | 'group'; id: string }
type Choice = { id: string; title: string; excluded: boolean }
type ReconstructionRequest = { id: string; mode: 'compact' | 'spec-update'; baseline: string; notes: string; newSource: string; createdAt: string; createdBy: { id: string }; revision: number; mapIds: string[]; documents: { id: string; title: string }[]; hasProposal?: boolean; planId?: string; plan?: Record<string, unknown>; conversation?: { id: string }; launchTarget: { mapId: string; cardId: string; cardTitle: string; documentTitle: string } }
type Api = <T>(path: string, init?: RequestInit) => Promise<T>

export function DocumentLifecycle({ api, editable, documents, initialIds, scope, initialTab = 'archive', userId, members, launchInWebUi, onClose, onChanged, onNavigate }: {
  api: Api; editable: boolean; documents: Document[]; initialIds: string[]
  scope?: Scope; initialTab?: 'archive' | 'reconstruction'; userId: string; members: TeamMember[]; launchInWebUi: boolean
  onClose: () => void; onChanged: () => Promise<void>; onNavigate: (id: string) => void
}) {
  const [tab, setTab] = useState<'archive' | 'reconstruction' | 'history'>(initialTab)
  const [archived, setArchived] = useState<Document[]>([])
  const [operations, setOperations] = useState<Operation[]>([])
  const [selected, setSelected] = useState(new Set(initialIds.filter((id) => documents.some((doc) => doc.id === id))))
  const initialSelection = useRef(initialIds)
  const [choices, setChoices] = useState<Choice[]>([])
  const [choicesLoaded, setChoicesLoaded] = useState(false)
  const [purpose, setPurpose] = useState<'compact' | 'spec-update'>('compact')
  const [baseline, setBaseline] = useState('')
  const [newSource, setNewSource] = useState('')
  const [notes, setNotes] = useState('')
  const [requests, setRequests] = useState<ReconstructionRequest[]>([])
  const [activeRequest, setActiveRequest] = useState<ReconstructionRequest | null>(null)
  const [launchRequest, setLaunchRequest] = useState<ReconstructionRequest | null>(null)
  const requestSelection = useRef(0)
  const [context, setContext] = useState('')
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [layoutError, setLayoutError] = useState('')
  const measurements = useRef(new Map<string, LayoutMeasurement[]>())
  const measurementKey = useRef('')
  const lastMeasurement = useRef('')
  const layoutInFlight = useRef(false)
  const currentPreview = useRef(preview)
  currentPreview.current = preview
  const [approved, setApproved] = useState(false)
  const appliedPlan = useRef<{ draft: string; plan: Record<string, unknown> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dialog = useRef<HTMLElement>(null)
  const refresh = useCallback(async () => {
    const [archive, history, proposals] = await Promise.all([api<{ maps: Document[] }>('/api/maps/archive'), api<{ operations: Operation[] }>('/api/document-reconstructions'), api<{ requests: ReconstructionRequest[] }>('/api/document-reconstructions/requests')])
    setArchived(archive.maps); setOperations(history.operations); setRequests(proposals.requests)
  }, [api])
  useEffect(() => { void refresh().catch((error: Error) => setError(error.message)) }, [refresh])
  const scopeId = scope?.id
  const scopeType = scope?.type
  useEffect(() => {
    let active = true
    const query = scopeId ? new URLSearchParams({ [scopeType === 'group' ? 'groupId' : 'mapId']: scopeId }).toString() : ''
    void api<{ documents: Choice[]; baseline: string }>(`/api/document-reconstructions/choices?${query}`).then((result) => {
      if (!active) return
      setChoices(result.documents); setBaseline(result.baseline); setChoicesLoaded(true)
      setSelected(new Set(result.documents.filter((doc) => !doc.excluded && (scopeId || initialSelection.current.includes(doc.id))).map((doc) => doc.id)))
    }).catch((error: Error) => { if (active) setError(error.message) })
    return () => { active = false }
  }, [api, scopeId, scopeType])
  useEffect(() => {
    if (!activeRequest || busy || launchRequest || tab !== 'reconstruction') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api<ReconstructionRequest>(`/api/document-reconstructions/requests/${encodeURIComponent(activeRequest.id)}`)
        if (stopped) return
        if (result.revision !== activeRequest.revision || result.conversation?.id !== activeRequest.conversation?.id) {
          setActiveRequest(result); setPreview(null); setApproved(false)
          if (result.plan) { setDraft(JSON.stringify(result.plan, null, 2)); setNotice('AI 정리안이 도착했습니다. 미리보기 검증 후 내용을 검토해 주세요.') }
          void refresh().catch(() => {})
        }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : '제안함을 조회하지 못했습니다.') }
      if (!stopped) timer = setTimeout(() => { void poll() }, 5000)
    }
    timer = setTimeout(() => { void poll() }, 1000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [activeRequest, api, busy, launchRequest, refresh, tab])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => previous?.focus()
  }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : '처리하지 못했습니다.') }
    finally { setBusy(false) }
  }
  const restore = (doc: Document) => run(async () => {
    if (!window.confirm(`“${doc.title}”을 활성 문서로 복원할까요? 후속 문서는 그대로 유지됩니다.`)) return
    await api(`/api/maps/${encodeURIComponent(doc.id)}/archive`, { method: 'PATCH', body: JSON.stringify({ baseVersion: doc.version, baseLifecycleVersion: doc.lifecycleVersion ?? 0, archived: false, reason: '보관함에서 사용자 복원' }) })
    await refresh(); await onChanged(); setNotice('문서를 복원했습니다. 후속 문서와 함께 활성 상태입니다.')
  })
  const inspect = () => run(async () => {
    setPreview(null); setApproved(false); setLayoutError(''); lastMeasurement.current = ''
    const result = await api<Preview>('/api/document-reconstructions/preview', { method: 'POST', body: JSON.stringify({ plan: JSON.parse(draft) }) })
    setPreview({ ...result, layoutPhase: 'draft' }); setApproved(false)
  })
  const layoutFailure = useCallback((message: string) => { setLayoutError(message); setApproved(false) }, [])
  const measuredLayout = useCallback((key: string, cards: LayoutMeasurement[]) => {
    if (!preview || currentPreview.current !== preview) return
    const phaseKey = `${preview.previewHash}:${preview.layoutPhase}`
    if (measurementKey.current !== phaseKey) { measurementKey.current = phaseKey; measurements.current.clear(); lastMeasurement.current = '' }
    measurements.current.set(key, cards)
    if (preview.layoutPhase === 'verified') {
      const target = preview.targets.find((target) => target.key === key)
      try { if (target) verifyRenderedLayout(target.map, target.layout, cards) } catch (error) { layoutFailure(error instanceof Error ? error.message : '배치가 변경되었습니다.') }
      return
    }
    if (!editable || layoutInFlight.current || measurements.current.size !== preview.targets.length) return
    const all = preview.targets.map((target) => ({ key: target.key, cards: measurements.current.get(target.key)! }))
    const signature = JSON.stringify({ phaseKey, all })
    if (lastMeasurement.current === signature) return
    lastMeasurement.current = signature; layoutInFlight.current = true; setLayoutBusy(true); setLayoutError(''); setApproved(false)
    void api<Preview>(`/api/document-reconstructions/${preview.layoutPhase === 'draft' ? 'measure-layout' : 'verify-layout'}`, { method: 'POST', body: JSON.stringify({ plan: JSON.parse(draft), previewHash: preview.previewHash, measurements: all }) })
      .then((result) => { if (currentPreview.current === preview) setPreview(result) })
      .catch((error: Error) => { if (currentPreview.current === preview) layoutFailure(error.message) })
      .finally(() => { layoutInFlight.current = false; setLayoutBusy(false) })
  }, [api, draft, editable, layoutFailure, preview])
  const apply = () => run(async () => {
    if (!preview || !approved || !editable || layoutBusy || layoutError || preview.layoutPhase !== 'verified') return
    if (!window.confirm('검토한 새 문서를 생성하고 원본 문서를 보관할까요? 원본의 상태는 완료로 바꾸지 않습니다.')) return
    const plan = appliedPlan.current?.draft === draft ? appliedPlan.current.plan : {
      ...JSON.parse(draft), approval: { statement: `문서 재구성 ${preview.id}의 미리보기와 카드 대응표를 확인하고 적용을 승인합니다.`, source: `MindNProgress 문서 재구성 화면의 사용자 확인 · ${new Date().toISOString()}` },
    }
    appliedPlan.current = { draft, plan }
    await api('/api/document-reconstructions/apply', { method: 'POST', body: JSON.stringify({ plan, previewHash: preview.previewHash }) })
    setPreview(null); setApproved(false); setActiveRequest(null); await refresh(); await onChanged(); setTab('history'); setNotice('전환했습니다. 원본과 후속 문서 및 카드 대응표를 확인하세요.')
  })
  const selectRequest = (id: string) => run(async () => {
    const selection = ++requestSelection.current
    setPreview(null); setApproved(false); setDraft(''); setActiveRequest(null)
    const result = await api<ReconstructionRequest>(`/api/document-reconstructions/requests/${encodeURIComponent(id)}`)
    if (selection !== requestSelection.current) return
    setActiveRequest(result)
    if (result.plan) setDraft(JSON.stringify(result.plan, null, 2))
  })
  const requestProposal = () => run(async () => {
    if (!editable) return
    const result = await api<ReconstructionRequest>('/api/document-reconstructions/requests', { method: 'POST', body: JSON.stringify({ mapIds: [...selected], mode: purpose, baseline, newSource, notes, analysisOnly: true }) })
    setActiveRequest(result); setLaunchRequest(result); setDraft(''); setPreview(null); setApproved(false)
    await refresh()
  })
  const labels: Record<keyof Stats, string> = { documents: '문서', cards: '전체 카드', work: '실제 업무', done: '완료 업무', unfinished: '미완료 업무', waitingCards: '대기 카드', references: 'Ref' }
  return <><div className="lifecycle-backdrop" inert={Boolean(launchRequest)} onKeyDown={(event) => {
    event.stopPropagation()
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
    if (event.key !== 'Tab') return
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary') ?? [])].filter((element) => element.getClientRects().length > 0)
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus() }
    if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus() }
  }}>
    <section ref={dialog} className="lifecycle-dialog" role="dialog" aria-modal="true" aria-label="문서 보관함과 재구성">
      <header><h2>문서 보관함과 재구성</h2><button type="button" onClick={onClose} disabled={busy} autoFocus>닫기</button></header>
      <nav aria-label="문서 관리 탭">{(['archive', 'reconstruction', 'history'] as const).map((value) => <button key={value} disabled={busy} aria-pressed={tab === value} onClick={() => setTab(value)}>{({ archive: '보관함', reconstruction: '문서 정리', history: '전환 이력' })[value]}</button>)}</nav>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {tab === 'archive' && <>
        <p>보관 문서는 활성 목록과 업무 집계에서 제외됩니다. 원문·댓글·이미지·기존 링크는 유지되며 수정하려면 복원해야 합니다. 휴지통과는 별개입니다.</p>
        {archived.length === 0 && <p>보관된 문서가 없습니다.</p>}
        {archived.map((doc) => <article key={doc.id}>
          <button className="lifecycle-link" onClick={() => onNavigate(doc.id)}>{doc.title}</button><small>{doc.nodeCount}개 카드 · {doc.archivedAt && new Date(doc.archivedAt).toLocaleString('ko-KR')}</small><p>{doc.archiveReason}</p>
          {doc.successorMapIds?.map((id) => <a key={id} href={`/mindmap/${encodeURIComponent(id)}`}>후속 문서 {documents.find((doc) => doc.id === id)?.title ?? id}</a>)}
          {editable && <button onClick={() => void restore(doc)} disabled={busy}>복원</button>}
        </article>)}
      </>}
      {tab === 'reconstruction' && <>
        <p>정리안 요청 → AI 선택·시작 → 제안 검토 → 별도 적용 승인. 요청만으로 원본이나 카드를 변경하지 않습니다.</p>
        <p>제안함에 제출된 AI 정리안은 창을 닫거나 새로고침해도 남습니다. 다시 요청을 선택하고 미리보기부터 검증하세요. 입력 중인 요청·직접 편집한 JSON·승인 체크는 저장하지 않습니다.</p>
        <details><summary>일관된 정리 기준</summary><ol>{documentReconstructionGuide.steps.map((step: string) => <li key={step}>{step}</li>)}</ol></details>
        <fieldset disabled={busy || !editable || !choicesLoaded}><legend>새 정리 요청 · 원본 문서 선택</legend>
          <div className="lifecycle-sources">{choices.map((doc) => <label key={doc.id}><input type="checkbox" disabled={doc.excluded} checked={selected.has(doc.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(doc.id); else next.delete(doc.id); return next })} />{doc.title}{doc.excluded && ' · 총괄 문서 유지'}</label>)}</div>
          {choicesLoaded && choices.length === 0 && <p>정리할 활성 문서가 없습니다.</p>}
          <small>선택 {selected.size}개 / 한 번에 최대 30개. 같은 그룹의 문서끼리 정리합니다.</small>
          <label>정리 목적<select aria-label="정리 목적" value={purpose} onChange={(event) => setPurpose(event.target.value as typeof purpose)}><option value="compact">규모 정리 · 현재 요구사항 유지</option><option value="spec-update">새 기획 반영 · 변경 요구사항 분석</option></select></label>
          <label>현재 기준<input aria-label="현재 기준" value={baseline} onChange={(event) => setBaseline(event.target.value)} placeholder="예: v0.4 · 현재 승인된 기획" maxLength={1000} /></label>
          {purpose === 'spec-update' && <label>새 기획서 출처<input aria-label="새 기획서 출처" value={newSource} onChange={(event) => setNewSource(event.target.value)} placeholder="AI가 조회할 수 있는 원본 링크 또는 파일 경로와 버전" maxLength={2000} /></label>}
          <label>요청사항<textarea className="lifecycle-notes" aria-label="정리 요청사항" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="보존해야 할 기준, 복잡한 부분, 정리 시 주의할 점" maxLength={4000} /></label>
          <p>아래 버튼은 읽기 전용 조사와 이 요청의 제안함 제출만 요청합니다. 이어지는 AI 옵션에서 시작을 확인합니다. 문서 생성·보관·삭제·개발·추가 위임은 승인하지 않습니다.</p>
          <button className="lifecycle-primary" disabled={!selected.size || selected.size > 30 || !baseline.trim() || (purpose === 'spec-update' && !newSource.trim())} onClick={() => void requestProposal()}>AI 정리안 요청</button>
        </fieldset>
        <h3>요청과 AI 제안함</h3><button disabled={busy} onClick={() => void run(refresh)}>제안함 새로고침</button>
        {requests.filter((request) => !scopeId || request.mapIds.some((id) => choices.some((doc) => doc.id === id))).map((request) => <article key={request.id}>
          <button disabled={busy} aria-pressed={activeRequest?.id === request.id} onClick={() => void selectRequest(request.id)}>{request.mode === 'compact' ? '규모 정리' : '새 기획 반영'} · {request.baseline} · {request.documents.map((doc) => doc.title).join(', ')}</button>
          <small>{new Date(request.createdAt).toLocaleString('ko-KR')} · {operations.some((operation) => operation.id === request.planId && operation.state === 'applied') ? '적용됨' : request.hasProposal ? '정리안 도착 · 검토 필요' : request.conversation ? 'AI 대화 연결됨 · 정리안 미제출' : '요청 준비 · AI 시작 확인 필요'}</small>
        </article>)}
        {activeRequest && <article className="lifecycle-request-detail"><strong>선택한 요청: {activeRequest.baseline} · {activeRequest.documents.map((doc) => doc.title).join(', ')}</strong><p>{activeRequest.notes}</p>{activeRequest.newSource && <p>새 원본: {activeRequest.newSource}</p>}
          {!activeRequest.plan && <p>정리안이 아직 제출되지 않았습니다. 이 화면을 열어 두면 도착 여부를 확인합니다.</p>}
          {editable && activeRequest.createdBy.id === userId && !activeRequest.conversation && !activeRequest.plan && <button disabled={busy} onClick={() => setLaunchRequest(activeRequest)}>AI 선택·시작</button>}
          {activeRequest.conversation && <small>AI 대화 ID: {activeRequest.conversation.id} · 응답과 추가 질문은 AionUi에서 확인하세요.</small>}
        </article>}
        <details><summary>고급 · 원본 정보와 정리안 JSON 직접 입력</summary>
          <button disabled={busy || !selected.size || selected.size > 30} onClick={() => void run(async () => { setContext(JSON.stringify(await api(`/api/document-reconstructions/context?${new URLSearchParams([...selected].map((id) => ['mapId', id]))}`), null, 2)) })}>AI용 원본 정보 조회</button>
          {context && <textarea readOnly aria-label="재구성 원본 정보" value={context} onFocus={(event) => event.target.select()} />}
          <label>AI가 만든 전환안 JSON<textarea aria-label="AI 문서 재구성안 JSON" value={draft} placeholder="MCP preview_reconstruction과 동일한 plan 객체" onChange={(event) => { setDraft(event.target.value); setActiveRequest(null); setPreview(null); setApproved(false) }} disabled={busy} /></label>
        </details>
        {draft.trim() && <button className="lifecycle-primary" onClick={() => void inspect()} disabled={busy}>미리보기 검증 · 저장하지 않음</button>}
        {preview && <>
          <h3>전환 {preview.id}</h3><p>현재 기준: {preview.baseline}</p><p>{preview.reason}</p>
          {preview.newSource && <p>새 기획 원본: {preview.newSource}</p>}{preview.changeSummary && <p>기획 변경 분석: {preview.changeSummary}</p>}
          <table><thead><tr><th>항목</th><th>현재</th><th>전환 후</th></tr></thead><tbody>{(Object.keys(labels) as (keyof Stats)[]).map((key) => <tr key={key}><th>{labels[key]}</th><td>{preview.before[key]}</td><td>{preview.after[key]}</td></tr>)}</tbody></table>
          {preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          <h3>실제 마인드맵 배치 미리보기</h3>
          <p role="status">{layoutError ? `배치 검증 실패: ${layoutError}` : preview.layoutPhase === 'verified' ? '전체 펼침 상태의 실제 카드·배지 크기와 최소 여백 검증을 통과했습니다. 이 좌표로 저장합니다.' : editable ? '실제 카드 크기를 측정하고 겹침을 검사하는 중입니다. 완료 전에는 적용할 수 없습니다.' : '열람용 미리보기입니다. 편집자가 렌더 배치 검증을 완료해야 적용할 수 있습니다.'}</p>
          {preview.targets.map((target) => <section key={`${target.key}:${preview.previewHash}:${preview.layoutPhase}`}>
            <strong>{target.map.title}</strong><small> · {target.layout.version} · 최소 여백 {target.layout.gap}px</small>
            <ReconstructionMap map={target.renderMap} members={members} onMeasured={(cards) => measuredLayout(target.key, cards)} onError={layoutFailure} />
          </section>)}
          {preview.targets.map(({ key, map }) => <details key={key}><summary>새 문서: {map.title} · {map.nodes.length}개 카드</summary>{map.nodes.map((node) => <article key={node.id}>
            <strong>{node.data.label}</strong><small> · {node.data.isWork ? '실행 업무' : '기준·지식'} · {node.data.status} · {node.data.progress}%</small>
            <small> · 상위: {map.nodes.find((parent) => parent.id === map.edges.find((edge) => edge.target === node.id && edge.data?.relation !== 'knowledge')?.source)?.data.label ?? '문서 루트'}</small>
            <p>{node.data.description}</p>{node.data.sharedKnowledge && <><strong>현재 공유 지식</strong><p>{node.data.sharedKnowledge}</p></>}
            {node.data.checklist?.map((item) => <div key={item.id}>{item.done ? '☑' : '☐'} {item.text}</div>)}
            {node.data.waitingItems?.map((item) => <p key={item.id}>대기: {item.label} · {item.note} · 재개: {item.resumeCondition}</p>)}
            {node.data.blockedBy?.length ? <p>선행 업무: {node.data.blockedBy.map((id) => map.nodes.find((card) => card.id === id)?.data.label ?? id).join(', ')}</p> : null}
            {node.data.reference && <p>참조 원본: {node.data.reference.mapId} / {node.data.reference.nodeId}</p>}
          </article>)}</details>)}
          <details open><summary>카드별 처리 이유와 승계 대상</summary>{(JSON.parse(draft).decisions as Operation['decisions']).map((decision) => <article key={`${decision.mapId}/${decision.cardId}`}>
            <a href={`/mindmap/${encodeURIComponent(decision.mapId)}/${encodeURIComponent(decision.cardId)}`} target="_blank" rel="noreferrer">{preview.sourceCards?.find((card) => card.mapId === decision.mapId && card.cardId === decision.cardId)?.label ?? decision.cardId}</a>
            <strong>{({ carry: '승계', merge: '통합', knowledge: '현재 지식으로 승계', history: '과거 근거로 보관', drop: '새 기획에서 제외' } as Record<string, string>)[decision.disposition]}</strong><p>{decision.reason}</p>
            {decision.evidence && <p>제외 근거: {decision.evidence}</p>}
            {decision.targets?.map((target) => { const doc = preview.targets.find((doc) => doc.key === target.key); return <div key={`${target.key}/${target.cardId}`}>→ {doc?.map.title} / {doc?.map.nodes.find((node) => node.id === target.cardId)?.data.label ?? target.cardId}</div> })}
          </article>)}</details>
          {editable && <><label><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} disabled={busy || layoutBusy || Boolean(layoutError) || preview.layoutPhase !== 'verified'} />카드 대응표와 현재 지식·미완료 조건의 의미 보존을 검토했으며, 이 전환안의 적용을 승인합니다.</label><button className="lifecycle-primary" onClick={() => void apply()} disabled={busy || !approved || layoutBusy || Boolean(layoutError) || preview.layoutPhase !== 'verified'}>승인한 전환안 적용</button></>}
        </>}
      </>}
      {tab === 'history' && <>
        <p>전환 이력은 기존 카드와 새 카드의 대응 및 승인 근거를 보존합니다. 후속 문서나 댓글이 변경되면 일괄 되돌리기는 거부됩니다.</p>
        {operations.length === 0 && <p>전환 이력이 없습니다.</p>}
        {operations.map((operation) => <article key={operation.id}><h3>{operation.reason}</h3><small>{operation.id} · {operation.state}</small>
          <div>원본: {operation.sources.map(({ mapId }) => <a key={mapId} href={`/mindmap/${encodeURIComponent(mapId)}`}>{mapId}</a>)}</div>
          <div>후속: {operation.targetMapIds.map((id) => <a key={id} href={`/mindmap/${encodeURIComponent(id)}`}>{id}</a>)}</div>
          <details><summary>대응표·승인 근거·검증 결과</summary><pre>{JSON.stringify(operation, null, 2)}</pre></details>
          {editable && operation.state === 'applied' && <button disabled={busy} onClick={() => void run(async () => {
            if (!window.confirm('이 전환의 원본을 복원하고 후속 문서를 보관할까요?')) return
            await api(`/api/document-reconstructions/${encodeURIComponent(operation.id)}/rollback`, { method: 'POST', body: '{}' })
            await refresh(); await onChanged(); setNotice('전환을 되돌렸습니다. 후속 문서도 보관함에서 확인할 수 있습니다.')
          })}>전환 되돌리기</button>}
        </article>)}
      </>}
    </section>
  </div>{launchRequest && <AiConversationDialog userId={userId} documentId={launchRequest.launchTarget.mapId} documentTitle={launchRequest.launchTarget.documentTitle} cardId={launchRequest.launchTarget.cardId} cardTitle={launchRequest.launchTarget.cardTitle} purpose="document-reconstruction" knowledgeSources={[]} initialRequest={buildReconstructionRequestPrompt(launchRequest)} reconstructionRequestId={launchRequest.id} launchInWebUi={launchInWebUi} onClose={() => { setLaunchRequest(null); void refresh().catch(() => {}) }} />}</>
}
