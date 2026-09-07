import { useEffect, useState } from 'react'
import type { AiConversationLink, AiConversationRuntime } from '../types/mindMap'
import './AiConversationPickerDialog.css'

type ConversationListItem = AiConversationLink & {
  homeMachineLabel: string
  homeMachineRole: 'main' | 'sub'
  accessible: boolean
  available: boolean
  name: string
  modifiedAt: string | null
  runtime: AiConversationRuntime
}

type ConversationListResponse = {
  latestConversationId: string | null
  conversations: ConversationListItem[]
  error?: string
}

function displayDate(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '시작 시각 정보 없음'
  return new Date(value).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
}

function runtimeLabel(runtime: AiConversationRuntime, available: boolean) {
  if (!available) return { className: 'unavailable', label: '상태 미확인' }
  if (runtime.state === 'running') return { className: 'running', label: 'AI 작업 중' }
  if (runtime.state === 'waiting-confirmation') return { className: 'waiting', label: '승인 대기' }
  if (runtime.state === 'unknown') return { className: 'unknown', label: '상태 확인 불가' }
  return { className: 'idle', label: '대화 대기' }
}

export function AiConversationPickerDialog({ mapId, cardId, cardTitle, onSelect, onStartNew, onDeleteUnavailable, onClose }: {
  mapId: string
  cardId: string
  cardTitle: string
  onSelect: (conversation: ConversationListItem) => void
  onStartNew: () => void
  onDeleteUnavailable: (conversationId: string) => Promise<{ latestConversationId: string | null }>
  onClose: () => void
}) {
  const [result, setResult] = useState<ConversationListResponse | null>(null)
  const [error, setError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null)

  const deleteUnavailableConversation = async (conversation: ConversationListItem) => {
    if (conversation.available || deletingConversationId) return
    const confirmed = window.confirm('AionUi에서 찾을 수 없는 대화입니다. 이 카드에 남은 대화 연결 기록을 삭제할까요?')
    if (!confirmed) return
    setDeleteError('')
    setDeletingConversationId(conversation.conversationId)
    try {
      const deleted = await onDeleteUnavailable(conversation.conversationId)
      setResult((current) => current ? {
        ...current,
        latestConversationId: deleted.latestConversationId,
        conversations: current.conversations.filter((item) => item.conversationId !== conversation.conversationId),
      } : current)
    } catch (deleteFailure) {
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : '대화 연결 기록을 삭제하지 못했습니다.')
    } finally {
      setDeletingConversationId(null)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/maps/${encodeURIComponent(mapId)}/cards/${encodeURIComponent(cardId)}/ai-conversations`, {
      credentials: 'include',
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as ConversationListResponse
      if (!response.ok) throw new Error(body.error ?? 'AI 대화 목록을 불러오지 못했습니다.')
      setResult(body)
    }).catch((loadError) => {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return
      setError(loadError instanceof Error ? loadError.message : 'AI 대화 목록을 불러오지 못했습니다.')
    })
    return () => controller.abort()
  }, [cardId, mapId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="ai-conversation-picker-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="ai-conversation-picker" role="dialog" aria-modal="true" aria-label="AI 대화 선택">
        <header>
          <div><span>AionUi 연동</span><strong>AI 대화 선택</strong><small>{cardTitle}</small></div>
          <button type="button" onClick={onClose} aria-label="AI 대화 선택 닫기">×</button>
        </header>
        <div className="ai-conversation-picker-content">
          {!result && !error && <div className="ai-conversation-picker-message">연결된 대화를 확인하는 중…</div>}
          {error && <div className="ai-conversation-picker-message error"><strong>대화 목록을 불러오지 못했습니다.</strong><span>{error}</span></div>}
          {deleteError && <div className="ai-conversation-picker-delete-error" role="alert">{deleteError}</div>}
          {result?.conversations.map((conversation) => {
            const status = runtimeLabel(conversation.runtime, conversation.available)
            const isLatest = result.latestConversationId === conversation.conversationId
            return (
              <article
                className={`ai-conversation-choice ${conversation.available ? '' : 'unavailable'}`}
                key={conversation.conversationId}
              >
                <button
                  type="button"
                  className="ai-conversation-choice-open"
                  disabled={!conversation.accessible || deletingConversationId === conversation.conversationId}
                  onClick={() => onSelect(conversation)}
                >
                  <span className="ai-conversation-choice-heading">
                    <span className={`ai-conversation-choice-status ${status.className}`}><i />{status.label}</span>
                    {isLatest && <em>최근 연결</em>}
                  </span>
                  <strong>{conversation.name || 'AionUi 대화'}</strong>
                  <span className="ai-conversation-choice-model">
                    {conversation.agent?.label ?? 'AI 종류 정보 없음'} <span>({conversation.model?.label ?? '모델 정보 없음'})</span>
                  </span>
                  <span className="ai-conversation-choice-options">
                    <span>실행 머신 {conversation.homeMachineLabel}{conversation.homeMachineRole === 'main' ? ' · 메인' : ' · 서브'}</span>
                    {!conversation.accessible && <span>이 머신을 사용할 권한 없음</span>}
                  </span>
                  {(conversation.mode || conversation.thoughtLevel) && (
                    <span className="ai-conversation-choice-options">
                      {conversation.mode && <span>권한 {conversation.mode.label}</span>}
                      {conversation.thoughtLevel && <span>사고 수준 {conversation.thoughtLevel.label}</span>}
                    </span>
                  )}
                  {conversation.requestPreview && <span className="ai-conversation-choice-request">{conversation.requestPreview}</span>}
                  {conversation.workspace && <small className="workspace" title={conversation.workspace}>{conversation.workspace}</small>}
                  <span className="ai-conversation-choice-capabilities">
                    <span title={conversation.skills.map((item) => item.label).join(', ')}><b>스킬</b>{conversation.skills.length > 0 ? conversation.skills.map((item) => item.label).join(', ') : '없음'}</span>
                    <span title={conversation.mcpServers.map((item) => item.label).join(', ')}><b>MCP</b>{conversation.mcpServers.length > 0 ? conversation.mcpServers.map((item) => item.label).join(', ') : '없음'}</span>
                  </span>
                  <span className="ai-conversation-choice-meta"><span>{conversation.startedBy?.label ?? '시작한 편집자 정보 없음'}</span><time>{displayDate(conversation.startedAt ?? conversation.linkedAt)}</time></span>
                </button>
                {conversation.accessible && !conversation.available && (
                  <button
                    type="button"
                    className="ai-conversation-choice-delete"
                    disabled={deletingConversationId !== null}
                    onClick={() => { void deleteUnavailableConversation(conversation) }}
                    aria-label={`${conversation.name || 'AionUi 대화'} 연결 기록 삭제`}
                  >
                    {deletingConversationId === conversation.conversationId ? '삭제 중…' : '삭제'}
                  </button>
                )}
              </article>
            )
          })}
          {result && result.conversations.length === 0 && <div className="ai-conversation-picker-message">연결된 AI 대화가 없습니다.</div>}
        </div>
        <footer className="ai-conversation-picker-actions">
          <button type="button" onClick={onClose}>취소</button>
          <button type="button" className="primary" onClick={onStartNew}><span aria-hidden="true">✦</span>새 AI 대화 시작</button>
        </footer>
      </section>
    </div>
  )
}
