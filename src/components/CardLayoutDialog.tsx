import { useCallback, useEffect, useRef, useState } from 'react'
import type { TeamMember } from '../types/mindMap'
import type { LayoutMeasurement, MindMapLayout } from '../utils/mindMapLayout.mjs'
import { CARD_LAYOUT_TARGET, verifyCardLayout, type CardLayoutPlan, type CardLayoutTarget, type CardLayoutVariant, type CardLayoutMetrics } from '../utils/cardLayout.mjs'
import { buildCardLayoutRequestPrompt } from '../utils/cardLayoutRequest.mjs'
import { ReconstructionMap, type ReconstructionPreviewMap } from './ReconstructionMap'
import { AiConversationDialog } from './AiConversationDialog'
import './DocumentLifecycle.css'
import './CardLayoutDialog.css'

type Request = {
  id: string; mapId: string; documentTitle: string; state: string; createdAt: string; revision: number; stale?: boolean
  snapshot: { renderMap: ReconstructionPreviewMap }; measurements?: LayoutMeasurement[]; plan?: CardLayoutPlan
  target?: CardLayoutTarget; conversation?: { id: string }; launchTarget: { mapId: string; cardId: string; cardTitle: string }
}
type Preview = { requestId: string; previewHash: string; phase: 'draft' | 'measured' | 'verified'; map: ReconstructionPreviewMap; layout: MindMapLayout;
  target: CardLayoutTarget; variant: CardLayoutVariant; metrics: CardLayoutMetrics; candidates: { id: CardLayoutVariant; label: string; metrics: CardLayoutMetrics }[] }
type Api = <T>(path: string, init?: RequestInit) => Promise<T>

export function CardLayoutDialog({ mapId, title, api, userId, members, launchInWebUi, ensureClean, onClose, onChanged }: {
  mapId: string; title: string; api: Api; userId: string; members: TeamMember[]; launchInWebUi: boolean
  ensureClean: () => boolean; onClose: () => void; onChanged: () => Promise<void>
}) {
  const [requests, setRequests] = useState<Request[]>([])
  const [request, setRequest] = useState<Request | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [targetScreen, setTargetScreen] = useState<CardLayoutTarget>({ ...CARD_LAYOUT_TARGET })
  const [launch, setLaunch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [measurementError, setMeasurementError] = useState('')
  const [approved, setApproved] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [renderReady, setRenderReady] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  const generation = useRef(0)
  const active = useRef({ request, preview }); active.current = { request, preview }
  const inFlight = useRef(false)
  const lastMeasured = useRef<LayoutMeasurement[] | null>(null)
  const refresh = useCallback(async () => {
    const result = await api<{ requests: Request[] }>(`/api/card-layouts?mapId=${encodeURIComponent(mapId)}`)
    setRequests(result.requests.filter((item) => item.state === 'open'))
  }, [api, mapId])
  const invalidate = useCallback(() => { generation.current++ }, [])
  useEffect(() => { void refresh().catch((e: Error) => setError(e.message)); return invalidate }, [refresh, invalidate])
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || busy || launch) return
      event.preventDefault(); event.stopPropagation(); onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [busy, launch, onClose])
  useEffect(() => {
    if (!request || request.state !== 'open') return
    let stopped = false
    const poll = async () => {
      try {
        const result = await api<Request>(`/api/card-layouts/${request.id}`)
        if (stopped) return
        if (result.revision !== request.revision || result.stale !== request.stale || result.state !== request.state || result.conversation?.id !== request.conversation?.id) {
          setRequest(result)
          if (result.stale || result.revision !== request.revision) { setPreview(null); setApproved(false); setRenderReady(false); lastMeasured.current = null }
        }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : '배치 요청을 확인하지 못했습니다.') }
    }
    const timer = setInterval(() => { void poll() }, 2500)
    return () => { stopped = true; clearInterval(timer) }
  }, [api, request])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : '배치 요청을 처리하지 못했습니다.') }
    finally { setBusy(false) }
  }
  const choose = (next: Request) => {
    generation.current++; setRequest(next); setPreview(null); setApproved(false); setRenderReady(false); setShowOriginal(false); setMeasurementError(''); lastMeasured.current = null
    setTargetScreen(next.target ?? { ...CARD_LAYOUT_TARGET })
  }
  const post = <T,>(id: string, action: string, body: object = {}) => api<T>(`/api/card-layouts/${id}/${action}`, { method: 'POST', body: JSON.stringify(body) })
  const create = () => run(async () => {
    if (!ensureClean()) throw new Error('현재 문서의 변경을 저장한 뒤 배치 제안을 요청하세요.')
    choose(await api<Request>('/api/card-layouts', { method: 'POST', body: JSON.stringify({ mapId, proposalOnly: true, target: targetScreen }) }))
    await refresh()
  })
  const measurementFailed = useCallback((message: string) => { setMeasurementError(message); setApproved(false); setRenderReady(false); lastMeasured.current = null }, [])
  const measured = useCallback((cards: LayoutMeasurement[]) => {
    const target = active.current
    if (!target.request || target.request.stale || target.request.state !== 'open') return
    if (target.preview?.phase === 'verified') {
      try { verifyCardLayout(target.preview.map, target.preview.layout, cards); lastMeasured.current = cards; setRenderReady(true) }
      catch (e) { measurementFailed(e instanceof Error ? e.message : '표시 크기가 변경되었습니다.') }
      return
    }
    if (!target.preview && target.request.measurements) return
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    const currentGeneration = generation.current
    const action = !target.preview ? 'capture' : target.preview.phase === 'draft' ? 'measure' : 'verify'
    void api<Request | Preview>(`/api/card-layouts/${target.request.id}/${action}`, { method: 'POST', body: JSON.stringify({ measurements: cards, previewHash: target.preview?.previewHash }) })
      .then((result) => {
        if (generation.current !== currentGeneration || active.current.preview !== target.preview || active.current.request?.id !== target.request?.id) return
        setMeasurementError(''); setApproved(false); setRenderReady(false)
        if (action === 'capture') setRequest(result as Request)
        else { setPreview(result as Preview); lastMeasured.current = action === 'verify' ? cards : null }
      })
      .catch((e: Error) => { if (generation.current === currentGeneration) measurementFailed(e.message) })
      .finally(() => { inFlight.current = false; setBusy(false) })
  }, [api, measurementFailed])
  const inspect = (variant: CardLayoutVariant = 'balanced', target = targetScreen) => run(async () => {
    if (!request) return
    const inspectionGeneration = ++generation.current
    setApproved(false); setRenderReady(false); setShowOriginal(false); setMeasurementError(''); lastMeasured.current = null
    // 후보 전환 중 기존 화면의 측정 콜백이 새 승인 상태를 다시 열지 않게 한다.
    active.current = { request, preview: null }; setPreview(null)
    const result = await post<Preview>(request.id, 'preview', { variant, target })
    if (!result.target || !result.metrics || !result.candidates?.length) throw new Error('모니터형 배치를 지원하는 서버 업데이트가 필요합니다. MnP 서버를 재시작한 뒤 미리보기를 다시 열어 주세요.')
    if (generation.current === inspectionGeneration) { setPreview(result); setTargetScreen(result.target) }
  })
  const changeTarget = (width: number) => {
    const target = { width, height: width * 9 / 16 }
    setTargetScreen(target); setApproved(false)
    if (request?.plan) void inspect('balanced', target)
  }
  const apply = () => run(async () => {
    if (!request || !preview || !approved || !renderReady || preview.phase !== 'verified' || !lastMeasured.current || measurementError) return
    if (!ensureClean()) throw new Error('저장되지 않은 편집이 있습니다. 저장 후 최신 문서로 다시 제안해 주세요.')
    await post(request.id, 'apply', { previewHash: preview.previewHash, approved: true, measurements: lastMeasured.current })
    await onChanged(); onClose()
  })
  const inputMap = request?.snapshot.renderMap
  const step = preview ? 3 : request?.measurements ? 2 : 1
  return <>
    <div className="lifecycle-backdrop card-layout-backdrop" inert={launch} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape' && !busy && !launch) { event.preventDefault(); onClose() }
      if (event.key !== 'Tab') return
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])].filter((e) => e.getClientRects().length)
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus() }
    }}>
      <section ref={dialog} className="lifecycle-dialog card-layout-dialog" role="dialog" aria-modal="true" aria-label="AI 배치 제안">
        <header><div><h2>AI 배치 제안</h2><p>{title}</p></div><button onClick={onClose} disabled={busy} autoFocus>닫기</button></header>
        {!preview && <p>현재 문서의 카드 배치를 제안합니다. 실제 화면을 확인하고 적용하면 카드 위치만 바뀝니다.</p>}
        <div className="card-layout-target"><label>목표 캔버스 <select aria-label="목표 캔버스" value={targetScreen.width} disabled={busy || Boolean(request && !request.plan)} onChange={(event) => changeTarget(Number(event.target.value))}>
          {[1280, 1600, 1920].map((width) => <option key={width} value={width}>모니터형 16:9 · {width} × {width * 9 / 16}</option>)}
        </select></label><p>휴대폰에서 요청해도 선택한 모니터 비율로 배치합니다. 수치는 화면 전체가 아닌 사용할 캔버스 크기입니다.</p></div>
        {!preview && <ol className="card-layout-steps" aria-label="배치 제안 순서">{['현재 배치 확인', 'AI 제안 받기', '미리보기·적용'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>}
        <details className="card-layout-request-tools" open={!preview}><summary>배치 요청 관리</summary>
        <div className="card-layout-actions"><button className={!request ? 'lifecycle-primary' : undefined} disabled={busy} onClick={() => void create()}>새 배치 제안 요청</button>
          {requests.length > 0 && <label>기존 요청 <select aria-label="기존 배치 요청" disabled={busy} value={request?.id ?? ''} onChange={(e) => { const id = e.target.value; if (id) void run(async () => choose(await api<Request>(`/api/card-layouts/${id}`))) }}>
            <option value="">요청 선택</option>{requests.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('ko-KR')}</option>)}
          </select></label>}
        </div>
        </details>
        {error && <p role="alert">{error}</p>}
        {request?.stale && <><p role="alert">원본 또는 표시 내용이 변경되었습니다. 최신 문서로 새 배치 제안을 요청하세요.</p><button disabled={busy} onClick={() => void run(async () => { await post(request.id, 'cancel'); setRequest(null); setPreview(null); await refresh() })}>이전 제안 취소</button></>}
        {!request && <div className="card-layout-empty"><strong>보기 편한 카드 배치를 제안받으세요.</strong><p>새 요청을 시작하면 현재 카드 크기를 확인합니다. AI의 배치 이유와 실제 화면을 비교한 뒤 적용할 수 있습니다.</p></div>}
        {request && request.state === 'open' && !request.stale && <>
          <div className="card-layout-preview-heading"><h3>{preview && !showOriginal ? '제안된 실제 배치' : '현재 배치와 카드 크기 확인'}</h3>
            {preview && <div className="card-layout-view-switch" role="group" aria-label="배치 비교"><button disabled={busy} aria-pressed={showOriginal} onClick={() => { if (!showOriginal) { setShowOriginal(true); setApproved(false); setRenderReady(false); lastMeasured.current = null } }}>현재 배치</button><button disabled={busy} aria-pressed={!showOriginal} onClick={() => { if (showOriginal) { setShowOriginal(false); setApproved(false); setRenderReady(false); lastMeasured.current = null } }}>제안 배치</button></div>}
          </div>
          {preview?.candidates && <div className="card-layout-candidates" role="group" aria-label="배치 후보 비교">
            {preview.candidates.map((candidate) => <button key={candidate.id} aria-pressed={!showOriginal && preview.variant === candidate.id} disabled={busy} onClick={() => { if (showOriginal || preview.variant !== candidate.id) void inspect(candidate.id) }}>
              <strong>{candidate.label}</strong><span>{Math.round(candidate.metrics.width)} × {Math.round(candidate.metrics.height)} · 예상 {Math.round(candidate.metrics.fitScale * 100)}%</span>
            </button>)}
          </div>}
          {preview?.metrics && <div className="card-layout-fit" aria-live="polite">
            <p>모니터형 16:9 · {preview.target.width} × {preview.target.height} 기준 예상 배율 <strong>{Math.round(preview.metrics.fitScale * 100)}%</strong> · 카드 {preview.map.nodes.length}개 전체 표시</p>
            <p>이 미리보기는 전체 구조를 보여 줍니다. 위 배율은 목표 캔버스 기준이며 휴대폰 미리보기의 실제 배율과 다릅니다.</p>
            {preview.metrics.needsZoom && <p className="card-layout-fit-warning">한 화면에 모두 담으면 글자가 작아질 수 있습니다. 내용을 읽으려면 확대하세요. 카드·내용·표시 크기는 줄이거나 숨기지 않았습니다.</p>}
            {preview.candidates.length === 1 && <p>현재 구조에서 구별되는 배치 후보는 하나입니다.</p>}
          </div>}
          {measurementError && <p role="alert">{measurementError}</p>}
          <p role="status">{preview ? preview.phase === 'verified' ? '카드 크기와 겹침 검증을 통과했습니다. 배치를 확인한 뒤 적용하세요.' : '실제 크기를 반영해 배치와 겹침을 검사하고 있습니다.' : request.measurements ? '실제 크기를 확인했습니다.' : '모든 카드와 이미지의 실제 크기를 확인하고 있습니다.'}</p>
          {(preview?.map ?? inputMap) && <div className="card-layout-screen" aria-label="모니터형 16:9 배치 미리보기"><ReconstructionMap key={`${preview?.previewHash ?? request.id}:${showOriginal}`} map={(showOriginal ? inputMap : preview?.map ?? inputMap)!} members={members} layoutProposal onMeasured={showOriginal ? () => {} : measured} onError={measurementFailed} /></div>}
          {!request.plan && <p>{request.conversation ? 'AI가 배치안을 작성하고 있습니다. 제안이 도착하면 여기에서 미리볼 수 있습니다.' : '크기 확인 후 AI를 선택해 배치안을 요청하세요.'}</p>}
          <div className="card-layout-actions">
            {!request.plan && !request.conversation && <button className="lifecycle-primary" disabled={busy || !request.measurements || Boolean(measurementError)} onClick={() => setLaunch(true)}>AI 선택·시작</button>}
            {request.plan && <button className={!preview ? 'lifecycle-primary' : undefined} disabled={busy} onClick={() => void inspect()}>배치 미리보기</button>}
            <button disabled={busy} onClick={() => void run(async () => { await post(request.id, 'cancel'); setRequest(null); setPreview(null); await refresh() })}>제안 취소</button>
          </div>
          {request.plan && <details open><summary>AI의 배치 제안 이유</summary><p className="card-layout-reason">{request.plan.reason}</p></details>}
          {preview && <footer className="card-layout-footer"><label className="card-layout-approval"><input type="checkbox" checked={approved} disabled={busy || showOriginal || !renderReady || preview.phase !== 'verified' || Boolean(measurementError)} onChange={(e) => setApproved(e.target.checked)} />제안된 실제 배치를 확인했으며 이 위치로 적용합니다.</label>
            <button className="lifecycle-primary" disabled={busy || showOriginal || !renderReady || !approved || preview.phase !== 'verified' || Boolean(measurementError)} onClick={() => void apply()}>확인한 배치 적용</button></footer>}
        </>}
      </section>
    </div>
    {launch && request && <AiConversationDialog userId={userId} documentId={mapId} documentTitle={title} cardId={request.launchTarget.cardId} cardTitle={request.launchTarget.cardTitle} purpose="card-layout" knowledgeSources={[]} initialRequest={buildCardLayoutRequestPrompt(request)} cardLayoutRequestId={request.id} launchInWebUi={launchInWebUi} onClose={() => { setLaunch(false); void refresh().catch(() => {}) }} />}
  </>
}
