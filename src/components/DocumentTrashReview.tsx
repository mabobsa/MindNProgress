import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { trashPreviewFromError, type DocumentTrashPreview } from '../utils/documentTrashReview'
import './DocumentTrashReview.css'

type Api = <T>(path: string, init?: RequestInit) => Promise<T>
const visitKey = (item: DocumentTrashPreview['references'][number]) => `${item.mapId}/${item.cardId}/${item.sourceCardId}`

export function DocumentTrashReview({ initialPreview, initialMessage, api, onNavigate, onTrash, onClose }: {
  initialPreview: DocumentTrashPreview
  initialMessage?: string
  api: Api
  onNavigate: (mapId: string, cardId: string | null) => void
  onTrash: (preview: DocumentTrashPreview) => Promise<void>
  onClose: () => void
}) {
  const [preview, setPreview] = useState(initialPreview)
  const [visited, setVisited] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState(initialMessage ?? '')
  const [unverified, setUnverified] = useState(false)
  const [moved, setMoved] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const [position, setPosition] = useState(() => ({ left: Math.max(12, window.innerWidth - 500), top: 72 }))
  const groups = useMemo(() => {
    const result = new Map<string, DocumentTrashPreview['references']>()
    for (const item of preview.references) result.set(item.mapId, [...(result.get(item.mapId) ?? []), item])
    return [...result.values()]
  }, [preview.references])
  const clamp = (left: number, top: number) => {
    const bounds = panel.current?.getBoundingClientRect()
    return { left: Math.max(8, Math.min(left, window.innerWidth - (bounds?.width ?? 480) - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - (bounds?.height ?? 300) - 8)) }
  }
  useEffect(() => {
    const keepVisible = () => setPosition((current) => {
      const next = clamp(current.left, current.top)
      return current.left === next.left && current.top === next.top ? current : next
    })
    const observer = new ResizeObserver(keepVisible)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', keepVisible)
    keepVisible()
    return () => { observer.disconnect(); window.removeEventListener('resize', keepVisible) }
  }, [])
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, ...position }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const start = drag.current
    if (!start || start.pointerId !== event.pointerId) return
    setPosition(clamp(start.left + event.clientX - start.x, start.top + event.clientY - start.y))
  }
  const refresh = async () => {
    if (busyRef.current || moved) return
    busyRef.current = true; setBusy(true); setError('')
    try {
      const next = await api<DocumentTrashPreview>(`/api/maps/${encodeURIComponent(preview.target.id)}/trash-preview`)
      setPreview(next); setUnverified(false)
    } catch (error) {
      setUnverified(true); setError(error instanceof Error ? error.message : '참조 목록을 확인하지 못했습니다.')
    } finally { busyRef.current = false; setBusy(false) }
  }
  const trash = async () => {
    if (busyRef.current || moved || unverified) return
    busyRef.current = true; setBusy(true); setError('')
    try { await onTrash(preview); setMoved(true) }
    catch (error) {
      const latest = trashPreviewFromError(error)
      if (latest?.target.id === preview.target.id) { setPreview(latest); setVisited(new Set()); setUnverified(false) }
      setError(error instanceof Error ? error.message : '휴지통으로 이동하지 못했습니다.')
    } finally { busyRef.current = false; setBusy(false) }
  }
  return <section ref={panel} className="document-trash-review" style={{ left: position.left, top: position.top }}
    role="dialog" aria-modal="false" aria-labelledby="document-trash-review-title"
    onKeyDown={(event) => event.stopPropagation()}>
    <header onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}>
      <h2 id="document-trash-review-title">휴지통 이동 전 Ref 참조 확인</h2>
      <button type="button" onClick={onClose} disabled={busy} aria-label="참조 확인 닫기">닫기</button>
    </header>
    <div className="document-trash-review-target">
      <small>{moved ? '휴지통으로 이동한 문서' : '휴지통으로 이동할 문서'} · {preview.target.archived ? '보관 문서' : '일반 문서'}</small>
      <strong>{preview.target.title}</strong>
      <p>다른 문서로 이동해도 이 창과 대상 문서는 유지됩니다. 제목 표시줄을 끌어 옮길 수 있습니다.</p>
      <div className="document-trash-review-tools">
        <button type="button" onClick={() => onNavigate(preview.target.id, null)} disabled={moved}>대상 문서로 돌아가기</button>
        <button type="button" onClick={() => void refresh()} disabled={busy || moved}>새로고침</button>
        <span>{groups.length}개 문서 · Ref {preview.references.length}개</span>
      </div>
    </div>
    {error && <p className="document-trash-review-error" role="alert">{error}</p>}
    {moved && <p className="document-trash-review-notice" role="status">“{preview.target.title}” 문서를 휴지통으로 이동했습니다.</p>}
    <div className="document-trash-review-list" aria-label="참조 위치 목록">
      {groups.map((items) => <section key={items[0].mapId}>
        <h3>{items[0].mapTitle}<small>{items[0].archived ? '보관 문서' : '활성 문서'}</small></h3>
        <ul>{items.map((item) => <li key={item.cardId}>
          <button type="button" className={visited.has(visitKey(item)) ? 'visited' : ''}
            onClick={() => { onNavigate(item.mapId, item.cardId); setVisited((current) => new Set(current).add(visitKey(item))) }}>
            <strong>{item.cardTitle}</strong><span>원본: {item.sourceCardTitle}</span>
            <small>{visited.has(visitKey(item)) ? '방문함' : '카드로 이동'}</small>
          </button>
        </li>)}</ul>
      </section>)}
      {!groups.length && <p>현재 다른 문서에서 참조하는 Ref 카드가 없습니다.</p>}
    </div>
    <footer>
      <p>휴지통으로 옮기면 위 Ref는 원본과 동기화되지 않습니다. 문서·카드·댓글은 휴지통에서 복원할 수 있습니다.</p>
      {preview.target.archived && <p>복원하면 보관함으로 돌아옵니다. 보관 상태가 변경되어 기존 문서 재구성의 일괄 되돌리기는 차단됩니다.</p>}
      <button type="button" className="document-trash-review-delete" disabled={busy || moved || unverified} onClick={() => void trash()}>
        {busy ? '확인·처리 중…' : `“${preview.target.title}”을 휴지통으로 이동`}
      </button>
    </footer>
  </section>
}
