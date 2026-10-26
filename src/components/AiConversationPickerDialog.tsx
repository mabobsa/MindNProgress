import { useEffect, useRef, useState } from 'react'
import type { AiConversationLink, AiConversationRuntime } from '../types/mindMap'
import { claudeAccountMark } from '../utils/claudeAccounts.mjs'
import './AiConversationPickerDialog.css'

type ConversationListItem = AiConversationLink & {
  /** Claude 멀티 계정: 계정이 2개 이상일 때만 서버가 붙인다. */
  claudeAccount?: { id: string; number: number; label: string }
  homeMachineLabel: string
  homeMachineRole: 'main' | 'sub'
  accessible: boolean
  machineOnline?: boolean
  liveStatusChecked?: boolean
  linkMissing?: boolean
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

type ConversationCardGroup = ConversationListResponse & { cardId: string; cardTitle: string }
type DocumentConversationListResponse = { cards: ConversationCardGroup[]; error?: string }

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

export function AiConversationPickerDialog({ mapId, cardId, cardTitle, documentTitle, onSelect, onStartNew, onDeleteConversation, onClose }: {
  mapId: string
  cardId?: string
  cardTitle?: string
  documentTitle?: string
  onSelect: (conversation: ConversationListItem, cardId: string) => void
  onStartNew?: () => void
  onDeleteConversation: (conversationId: string, cardId: string) => Promise<{ latestConversationId: string | null }>
  onClose: () => void
}) {
  const documentMode = !cardId
  const [groups, setGroups] = useState<ConversationCardGroup[] | null>(null)
  const [error, setError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState<{ cardId: string; conversationId: string; name: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ cardId: string; conversation: ConversationListItem; x: number; y: number; trigger: HTMLElement } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const deletionPending = useRef(false)

  const deleteConversation = async (conversation: ConversationListItem, targetCardId: string) => {
    if (!conversation.accessible || conversation.machineOnline === false || deletionPending.current) return
    setContextMenu(null)
    const confirmed = window.confirm(`${conversation.name || 'AI 대화'}를 삭제할까요?\nAion에 존재하는 대화는 보관함으로 옮긴 것을 확인한 뒤 이 카드의 연결 기록을 삭제합니다.`)
    if (!confirmed) return
    deletionPending.current = true
    setDeleteError('')
    setDeleting({ cardId: targetCardId, conversationId: conversation.conversationId, name: conversation.name || 'AI 대화' })
    try {
      const deleted = await onDeleteConversation(conversation.conversationId, targetCardId)
      setGroups((current) => current?.map((group) => group.cardId === targetCardId ? {
        ...group,
        latestConversationId: deleted.latestConversationId,
        conversations: group.conversations.filter((item) => item.conversationId !== conversation.conversationId),
      } : group) ?? current)
    } catch (deleteFailure) {
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : '대화 연결 기록을 삭제하지 못했습니다.')
    } finally {
      deletionPending.current = false
      setDeleting(null)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    const basePath = `/api/maps/${encodeURIComponent(mapId)}`
    const cardPath = (id: string) => `${basePath}/cards/${encodeURIComponent(id)}/ai-conversations`
    const updateDetails = async (group: ConversationCardGroup) => {
      try {
        const response = await fetch(`${cardPath(group.cardId)}${documentMode ? '?view=compact' : ''}`, { credentials: 'include', signal: controller.signal })
        const detailed = await response.json() as ConversationListResponse
        if (!response.ok || controller.signal.aborted) return
        setGroups((current) => current?.map((currentGroup) => currentGroup.cardId === group.cardId ? {
          ...currentGroup,
          // 조회 중 삭제한 연결은 늦게 도착한 응답으로 되살리지 않는다.
          conversations: detailed.conversations.flatMap((conversation) => {
            const linked = currentGroup.conversations.find((item) => item.conversationId === conversation.conversationId)
            if (!linked) return []
            // 문서 목록의 모델·사고 레벨은 MnP 연결 기록만 표시한다.
            return [documentMode ? { ...conversation, model: linked.model, thoughtLevel: linked.thoughtLevel } : conversation]
          }),
        } : currentGroup) ?? current)
      } catch { /* 상세 조회 실패 시 연결 기록으로 목록과 삭제 기능을 유지한다. */ }
    }
    const load = async () => {
      try {
        const response = await fetch(cardId ? `${cardPath(cardId)}?view=linked` : `${basePath}/ai-conversations`, { credentials: 'include', signal: controller.signal })
        const linked = await response.json().catch(() => ({})) as ConversationListResponse & DocumentConversationListResponse
        if (!response.ok) throw new Error(linked.error ?? 'AI 대화 목록을 불러오지 못했습니다.')
        if (controller.signal.aborted) return
        const linkedGroups = cardId ? [{ ...linked, cardId, cardTitle: cardTitle ?? '' }] : linked.cards
        setGroups(linkedGroups)
        // 전체 문서도 카드 세 개씩 조회해 원격 머신의 요청이 한꺼번에 쌓이지 않도록 한다.
        const pending = linkedGroups.filter((group) => group.conversations.some((conversation) => conversation.accessible && conversation.machineOnline))
        let index = 0
        await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (!controller.signal.aborted && index < pending.length) await updateDetails(pending[index++])
        }))
      } catch (loadError) {
        if (controller.signal.aborted) return
        setError(loadError instanceof Error ? loadError.message : 'AI 대화 목록을 불러오지 못했습니다.')
      }
    }
    void load()
    return () => controller.abort()
  }, [cardId, cardTitle, documentMode, mapId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (contextMenu) {
        contextMenu.trigger.focus()
        setContextMenu(null)
      } else if (!deletionPending.current) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [contextMenu, onClose])

  useEffect(() => {
    if (!contextMenu) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const dismiss = () => setContextMenu(null)
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) dismiss() }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [contextMenu])

  const openMenu = (conversation: ConversationListItem, targetCardId: string, x: number, y: number, trigger: HTMLElement) => {
    setContextMenu({ conversation, cardId: targetCardId, x: Math.max(8, Math.min(x, window.innerWidth - 168)), y: Math.max(8, Math.min(y, window.innerHeight - 56)), trigger })
  }

  return (
    <div className="ai-conversation-picker-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) { if (contextMenu) setContextMenu(null); else if (!deletionPending.current) onClose() } }}>
      <section className={`ai-conversation-picker${documentMode ? ' document-conversations' : ''}`} role="dialog" aria-modal="true" aria-label={documentMode ? '문서 AI 대화 목록' : 'AI 대화 선택'}>
        <header>
          <div><span>AionUi 연동</span><strong>{documentMode ? 'AI 대화 목록' : 'AI 대화 선택'}</strong><small>{documentMode ? documentTitle : cardTitle}</small></div>
          <button type="button" onClick={onClose} disabled={Boolean(deleting)} aria-label="AI 대화 선택 닫기">×</button>
        </header>
        {deleting && <div className="ai-conversation-picker-progress" role="status">{deleting.name} 보관·삭제 중… 완료될 때까지 기다려 주세요.</div>}
        <div className="ai-conversation-picker-content">
          {!groups && !error && <div className="ai-conversation-picker-message">연결된 대화를 확인하는 중…</div>}
          {error && <div className="ai-conversation-picker-message error"><strong>대화 목록을 불러오지 못했습니다.</strong><span>{error}</span></div>}
          {deleteError && <div className="ai-conversation-picker-delete-error" role="alert">{deleteError}</div>}
          {groups?.filter((group) => group.conversations.length > 0).map((group) => (
            <div className={documentMode ? 'ai-conversation-card-group' : 'ai-conversation-single-card'} key={group.cardId} data-card-id={group.cardId}>
              {documentMode && <h3 title={group.cardTitle}>{group.cardTitle}</h3>}
              {group.conversations.map((conversation) => {
                const status = conversation.liveStatusChecked === false
                  ? conversation.machineOnline === false
                    ? { className: 'unavailable', label: '머신 연결 안 됨' }
                    : { className: 'unknown', label: '상태 확인 중' }
                  : runtimeLabel(conversation.runtime, conversation.available)
                const isLatest = group.latestConversationId === conversation.conversationId
                const isDeleting = deleting?.cardId === group.cardId && deleting.conversationId === conversation.conversationId
                return (
                  <article
                    className={`ai-conversation-choice ${conversation.available ? '' : 'unavailable'}${documentMode ? ' compact' : ''}`}
                    key={conversation.conversationId}
                    data-conversation-id={conversation.conversationId}
                    aria-busy={isDeleting}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      const trigger = event.currentTarget.querySelector<HTMLElement>('.ai-conversation-choice-open') ?? event.currentTarget
                      openMenu(conversation, group.cardId, event.clientX, event.clientY, trigger)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                      event.preventDefault()
                      const rect = event.currentTarget.getBoundingClientRect()
                      openMenu(conversation, group.cardId, rect.left + 16, rect.top + 28, event.target as HTMLElement)
                    }}
                  >
                    <button
                      type="button"
                      className="ai-conversation-choice-open"
                      disabled={!conversation.accessible || conversation.machineOnline === false || Boolean(deleting)}
                      title={!conversation.accessible ? '이 머신을 사용할 권한이 없습니다.' : conversation.machineOnline === false ? '머신이 연결되어 있지 않습니다.' : undefined}
                      onClick={() => onSelect(conversation, group.cardId)}
                    >
                      {documentMode ? <>
                        <strong title={conversation.name || 'AionUi 대화'}>{conversation.name || 'AionUi 대화'}</strong>
                        <span className="ai-conversation-compact-ai">
                          <span className="ai-conversation-compact-agent" title={conversation.agent?.label}>{conversation.agent?.label ?? 'AI 종류 미확인'}</span>
                          <span className="ai-conversation-compact-model" title={`MnP에 저장된 모델: ${conversation.model?.label ?? '정보 없음'}`}>{conversation.model?.label ?? '모델 정보 없음'}</span>
                          <span className="ai-conversation-compact-thought" title={`MnP에 저장된 사고 레벨: ${conversation.thoughtLevel?.label ?? '정보 없음'}`}>사고 {conversation.thoughtLevel?.label ?? '정보 없음'}</span>
                        </span>
                        <span className="ai-conversation-compact-machine" title={conversation.homeMachineLabel}>{conversation.homeMachineLabel}</span>
                        <time>{displayDate(conversation.startedAt ?? conversation.linkedAt)}</time>
                      </> : <>
                        <span className="ai-conversation-choice-heading">
                          <span className={`ai-conversation-choice-status ${status.className}`}><i />{status.label}</span>
                          {isDeleting ? <em>보관·삭제 중…</em> : isLatest && <em>최근 연결</em>}
                        </span>
                        <strong>{conversation.name || 'AionUi 대화'}</strong>
                        <span className="ai-conversation-choice-model">
                          {conversation.agent?.label ?? 'AI 종류 정보 없음'}
                          {conversation.claudeAccount && ` ${claudeAccountMark(conversation.claudeAccount.number)} ${conversation.claudeAccount.label}`}
                          {' '}<span>({conversation.model?.label ?? '모델 정보 없음'})</span>
                        </span>
                        <span className="ai-conversation-choice-options">
                          <span>실행 머신 {conversation.homeMachineLabel}{conversation.homeMachineRole === 'main' ? ' · 메인' : ' · 서브'}</span>
                          {!conversation.accessible && <span>이 머신을 사용할 권한 없음</span>}
                          {conversation.accessible && conversation.machineOnline === false && <span>서브 머신이 다시 연결되면 열 수 있습니다</span>}
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
                      </>}
                    </button>
                    {!documentMode && conversation.accessible && conversation.linkMissing === true && (
                      <button
                        type="button"
                        className="ai-conversation-choice-delete"
                        disabled={Boolean(deleting) || conversation.machineOnline === false}
                        onClick={() => { void deleteConversation(conversation, group.cardId) }}
                        aria-label={`${conversation.name || 'AionUi 대화'} 연결 기록 삭제`}
                      >
                        {isDeleting ? '삭제 중…' : '삭제'}
                      </button>
                    )}
                  </article>
                )
              })}
            </div>
          ))}
          {groups && groups.every((group) => group.conversations.length === 0) && <div className="ai-conversation-picker-message">연결된 AI 대화가 없습니다.</div>}
        </div>
        <footer className="ai-conversation-picker-actions">
          {documentMode && <small>대화를 우클릭해 하나씩 삭제할 수 있습니다.</small>}
          <button type="button" onClick={onClose} disabled={Boolean(deleting)}>{documentMode ? '닫기' : '취소'}</button>
          {!documentMode && onStartNew && <button type="button" className="primary" onClick={onStartNew} disabled={Boolean(deleting)}><span aria-hidden="true">✦</span>새 AI 대화 시작</button>}
        </footer>
        {contextMenu && (
          <div ref={menuRef} className="ai-conversation-picker-menu" role="menu" aria-label="AI 대화 메뉴"
            style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => { if (event.key === 'Tab') setContextMenu(null) }}>
            <button type="button" role="menuitem"
              disabled={!contextMenu.conversation.accessible || contextMenu.conversation.machineOnline === false || Boolean(deleting)}
              onClick={() => { void deleteConversation(contextMenu.conversation, contextMenu.cardId) }}>삭제</button>
          </div>
        )}
      </section>
    </div>
  )
}
