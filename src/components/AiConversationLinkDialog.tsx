import { useEffect, useRef, useState } from 'react'
import './AiConversationPickerDialog.css'
import './AiConversationLinkDialog.css'

type ConversationPreview = {
  conversationId: string
  homeMachineId: string
  homeMachineLabel: string
  name: string
  agent: string | null
  model: string | null
  workspace: string | null
  createdAt: string | null
  modifiedAt: string | null
  archivedAt: number | null
  runtimeState: string
  alreadyLinked: boolean
  binding: { mapId: string; cardId: string; documentTitle: string; cardTitle: string; homeMachineLabel: string } | null
  previewToken: string | null
}

export type AiConversationLookup = { conversations: ConversationPreview[]; warnings: string[] }

const dateLabel = (value: string | number | null) => value === null || !Number.isFinite(new Date(value).getTime())
  ? '정보 없음' : new Date(value).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })

export function AiConversationLinkDialog({ cardTitle, onLookup, onConnect, onClose }: {
  cardTitle: string
  onLookup: (conversationId: string, signal: AbortSignal) => Promise<AiConversationLookup>
  onConnect: (previewToken: string) => Promise<void>
  onClose: () => void
}) {
  const [conversationId, setConversationId] = useState('')
  const [result, setResult] = useState<AiConversationLookup | null>(null)
  const [selectedMachine, setSelectedMachine] = useState('')
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const pendingConnection = useRef(false)
  const lookupSequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const dialog = useRef<HTMLElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const selected = result?.conversations.find((item) => item.homeMachineId === selectedMachine)

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    input.current?.focus()
    // DOM이 아닌 요청 ref를 사용하므로 창을 닫을 때 가장 최근 요청을 취소한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { controller.current?.abort(); lookupSequence.current++; previousFocus?.focus() }
  }, [])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (!pendingConnection.current) onClose()
      }
      if (event.key === 'Tab') {
        const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') ?? [])]
        const first = elements[0], last = elements.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [onClose])

  const lookup = async () => {
    const id = conversationId.trim()
    if (!id || pendingConnection.current) return
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const sequence = ++lookupSequence.current
    setLoading(true); setResult(null); setSelectedMachine(''); setError('')
    try {
      const found = await onLookup(id, abort.signal)
      if (sequence !== lookupSequence.current) return
      setResult(found)
      if (found.conversations.length === 1) setSelectedMachine(found.conversations[0].homeMachineId)
    } catch (reason) {
      if (sequence === lookupSequence.current && !abort.signal.aborted) setError(reason instanceof Error ? reason.message : '대화를 조회하지 못했습니다.')
    } finally { if (sequence === lookupSequence.current) setLoading(false) }
  }
  const connect = async () => {
    if (!selected?.previewToken || pendingConnection.current) return
    pendingConnection.current = true
    setConnecting(true); setError('')
    try { await onConnect(selected.previewToken); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '대화를 연결하지 못했습니다. 다시 조회해 주세요.') }
    finally { pendingConnection.current = false; setConnecting(false) }
  }

  return <div className="ai-conversation-picker-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !pendingConnection.current) onClose()
  }}>
    <section ref={dialog} className="ai-conversation-picker ai-conversation-link-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-conversation-link-title" aria-busy={loading || connecting}>
      <header>
        <div><strong id="ai-conversation-link-title">AI 대화 연결</strong><small>{cardTitle}</small></div>
        <button type="button" aria-label="닫기" disabled={connecting} onClick={onClose}>×</button>
      </header>
      <div className="ai-conversation-link-content">
        <p>AionUi 대화 ID를 조회하고 정보를 확인한 뒤 이 카드에 연결하세요.</p>
        <form onSubmit={(event) => { event.preventDefault(); void lookup() }}>
          <label htmlFor="ai-conversation-link-id">대화 ID</label>
          <div className="ai-conversation-link-search">
            <input ref={input} id="ai-conversation-link-id" value={conversationId} maxLength={120} placeholder="예: b2d63f29" autoComplete="off" spellCheck={false} disabled={connecting}
              onChange={(event) => {
                controller.current?.abort(); lookupSequence.current++
                setConversationId(event.target.value); setResult(null); setSelectedMachine(''); setError(''); setLoading(false)
              }} />
            <button type="submit" disabled={!conversationId.trim() || loading || connecting}>{loading ? '조회 중…' : '조회'}</button>
          </div>
        </form>
        {error && <p className="ai-conversation-link-error" role="alert">{error}</p>}
        {result?.warnings.map((warning) => <p className="ai-conversation-link-warning" role="status" key={warning}>{warning}</p>)}
        {result?.conversations.length === 0 && <p role="status">{result.warnings.length
          ? '대화를 확인하지 못했습니다. 위의 조회 상태를 확인한 뒤 다시 조회해 주세요.'
          : '해당 대화를 찾지 못했습니다. 대화 ID를 확인해 주세요.'}</p>}
        {result?.conversations.map((item) => <div className="ai-conversation-link-preview" key={item.homeMachineId}>
          {result.conversations.length > 1 && <label className="ai-conversation-link-candidate">
            <input type="radio" name="conversation-machine" value={item.homeMachineId} checked={selectedMachine === item.homeMachineId} disabled={connecting}
              onChange={() => setSelectedMachine(item.homeMachineId)} />{item.homeMachineLabel}의 대화 선택
          </label>}
          <strong>{item.name}</strong>
          <dl>
            <dt>대화 ID</dt><dd>{item.conversationId}</dd>
            <dt>머신</dt><dd>{item.homeMachineLabel}</dd>
            <dt>AI / 모델</dt><dd>{item.agent ?? '정보 없음'} / {item.model ?? '정보 없음'}</dd>
            <dt>작업공간</dt><dd>{item.workspace ?? '정보 없음'}</dd>
            <dt>시작 일시</dt><dd>{dateLabel(item.createdAt)}</dd>
            <dt>최근 변경</dt><dd>{dateLabel(item.modifiedAt)}</dd>
            <dt>현재 상태</dt><dd>{({ idle: '대화 대기', running: 'AI 작업 중', waiting_confirmation: '승인 대기', 'waiting-confirmation': '승인 대기' } as Record<string, string>)[item.runtimeState] ?? '상태 미확인'}</dd>
            <dt>보관 상태</dt><dd>{item.archivedAt === null ? '보관되지 않음' : `보관됨 · ${dateLabel(item.archivedAt)}`}</dd>
          </dl>
          {item.binding && <p className="ai-conversation-link-warning">다른 카드 또는 머신에 연결되어 있습니다: {item.binding.documentTitle} / {item.binding.cardTitle} ({item.binding.homeMachineLabel})</p>}
        </div>)}
        {selected?.previewToken && <p className="ai-conversation-link-note">
          {selected.archivedAt !== null && '보관함에서 복원한 것을 확인한 뒤 연결합니다. '}
          {selected.alreadyLinked ? '이미 연결된 대화입니다. 연결 정보를 갱신합니다.' : '기존 연결은 유지하며, 이 대화를 기본 대화로 설정합니다.'}
        </p>}
        {connecting && <p role="status">대화 상태를 확인하고 연결을 저장하고 있습니다…</p>}
      </div>
      <footer className="ai-conversation-picker-actions">
        <button type="button" onClick={onClose} disabled={connecting}>취소</button>
        <button type="button" className="primary" disabled={!selected?.previewToken || connecting || loading} onClick={() => void connect()}>
          {connecting ? '연결 중…' : selected?.archivedAt != null ? '보관함에서 복원하고 연결' : '이 카드에 연결'}
        </button>
      </footer>
    </section>
  </div>
}
