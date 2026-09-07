import { useEffect, useMemo, useRef, useState } from 'react'
import { buildSharedKnowledgeCleanupLaunch, type AiConversationExplicitTarget } from '../utils/aiConversationLaunch.mjs'
import { sharedKnowledgeAuditThresholds, sharedKnowledgeMaxLength } from '../utils/sharedKnowledgePolicy.mjs'
import './SharedKnowledgeReviewDialog.css'

type ReviewLevel = 'attention' | 'recommended' | 'priority'
type ReviewDecision = 'cleaned' | 'accepted-long'
type ReviewState = 'unreviewed' | 'current' | 'stale'

type AuditCandidate = {
  mapId: string
  documentTitle: string
  documentVersion: number
  cardId: string
  label: string
  kind: string
  reviewLevel: ReviewLevel
  reasons: string[]
  length: number
  utf8Bytes: number
  sha256: string
  reviewState: ReviewState
  consumerCount: number
  exactDuplicateStatementGroupCount: number
  exactDuplicateStatementCount: number
  limitUsagePercent: number
  remainingCharacters: number
  lastKnownUpdatedAt: string | null
}

type SharedKnowledgeAudit = {
  generatedAt: string
  summary: {
    documentCount: number
    cardsWithSharedKnowledge: number
    actionableCandidateCount: number
    totalCharacters: number
  }
  candidates: AuditCandidate[]
}

type RelatedCard = {
  id: string
  label: string
  kind: string
  descriptionPreview: string
  descriptionTruncated: boolean
  sharedKnowledgeLength: number
  reviewState: ReviewState
}

type ReviewComment = {
  id: string
  text: string
  summary?: string
  hasDetail?: boolean
  createdAt: string
  author: { id: string; name: string }
}

type SharedKnowledgeReviewContext = {
  document: {
    id: string
    title: string
    version: number
    updatedAt: string | null
  }
  card: {
    id: string
    label: string
    kind: string
    description: string
    sharedKnowledge: string
    sharedKnowledgeUpdatedAt: string | null
    sharedKnowledgeUpdatedBy: { id: string; name: string } | null
    textIntegrity: {
      length: number
      utf8Bytes: number
      sha256: string
    }
    reviewState: ReviewState
  }
  candidate: {
    reviewLevel: ReviewLevel
    reasons: string[]
    paragraphCount: number
    nonEmptyLineCount: number
    listItemCount: number
    exactDuplicateStatementGroupCount: number
    exactDuplicateStatementCount: number
    limitUsagePercent: number
    remainingCharacters: number
  }
  relations: {
    parents: RelatedCard[]
    children: RelatedCard[]
    knowledgeSources: RelatedCard[]
    knowledgeConsumers: RelatedCard[]
    totals: Record<'parents' | 'children' | 'knowledgeSources' | 'knowledgeConsumers', number>
    truncatedTypes: string[]
  }
  guidance: {
    keep: string
    remove: string
    preserveMeaning: string
    resultChoice: string
  }
  accessUrl: string
  comments: ReviewComment[]
  commentsPage: {
    total: number
    returned: number
  }
}

type ReviewDocumentSummary = {
  id: string
  title: string
  version: number
  updatedAt: string | null
}

export type SharedKnowledgeReviewApplied = {
  mapId: string
  cardId: string
  result: ReviewDecision
  document: ReviewDocumentSummary
}

type SharedKnowledgeReviewDialogProps = {
  activeMapId: string | null
  clientId: string
  /** AI 정리 제안 대화를 이 다이얼로그 위에 겹쳐 여는 동안 Esc와 배경 닫기를 멈춥니다. */
  aiRequestOpen?: boolean
  onRequestAiCleanup?: (target: AiConversationExplicitTarget & { initialRequest: string }) => void
  onApplied: (applied: SharedKnowledgeReviewApplied) => void | Promise<void>
  onClose: () => void
}

class ReviewRequestError extends Error {
  status: number
  body: Record<string, unknown>

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message)
    this.name = 'ReviewRequestError'
    this.status = status
    this.body = body
  }
}

async function reviewRequest<T>(clientId: string, pathname: string, init?: RequestInit) {
  const response = await fetch(pathname, {
    ...init,
    credentials: 'include',
    headers: {
      'X-MNP-Client': clientId,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) {
    throw new ReviewRequestError(body.error ?? '공유 지식 검토 요청을 처리하지 못했습니다.', response.status, body)
  }
  return body
}

const reviewLevelLabels: Record<ReviewLevel, string> = {
  attention: '확인 필요',
  recommended: '정리 권장',
  priority: '우선 정리',
}

const reasonLabels: Record<string, string> = {
  'length-attention': `${sharedKnowledgeAuditThresholds.attentionCharacters.toLocaleString('ko-KR')}자 이상`,
  'length-recommended': `${sharedKnowledgeAuditThresholds.recommendedCharacters.toLocaleString('ko-KR')}자 이상`,
  'length-priority': `${sharedKnowledgeAuditThresholds.priorityCharacters.toLocaleString('ko-KR')}자 이상`,
  'exact-duplicate-statements': '동일 문장 반복',
  'accepted-long-review-expired': '장문 유지 30일 재검토',
}

const relationLabels: Array<{
  key: keyof SharedKnowledgeReviewContext['relations']['totals']
  label: string
}> = [
  { key: 'parents', label: '상위 카드' },
  { key: 'children', label: '하위 카드' },
  { key: 'knowledgeSources', label: '연결된 지식' },
  { key: 'knowledgeConsumers', label: '이 지식을 쓰는 카드' },
]

function candidateKey(candidate: Pick<AuditCandidate, 'mapId' | 'cardId'>) {
  return `${candidate.mapId}\u0000${candidate.cardId}`
}

function formatCount(value: number) {
  return value.toLocaleString('ko-KR')
}

function formatDate(value: string | null) {
  if (!value) return '기록 없음'
  return new Date(value).toLocaleString('ko-KR')
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
    </svg>
  )
}

function EmptyReviewState({ filtered }: { filtered: boolean }) {
  return (
    <div className="shared-knowledge-review-empty">
      <span aria-hidden="true">✓</span>
      <strong>{filtered ? '현재 문서에 정리 후보가 없습니다.' : '정리할 공유 지식이 없습니다.'}</strong>
      <p>이미 검토했거나 기준보다 짧은 공유 지식은 목록에 나타나지 않습니다.</p>
    </div>
  )
}

export function SharedKnowledgeReviewDialog({
  activeMapId,
  clientId,
  aiRequestOpen = false,
  onRequestAiCleanup,
  onApplied,
  onClose,
}: SharedKnowledgeReviewDialogProps) {
  const [scope, setScope] = useState<'all' | 'current'>(() => activeMapId ? 'current' : 'all')
  const [audit, setAudit] = useState<SharedKnowledgeAudit | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [context, setContext] = useState<SharedKnowledgeReviewContext | null>(null)
  const [decision, setDecision] = useState<ReviewDecision | null>(null)
  const [proposal, setProposal] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [contextLoading, setContextLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [listError, setListError] = useState('')
  const [contextError, setContextError] = useState('')
  const [applyError, setApplyError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [auditReloadToken, setAuditReloadToken] = useState(0)
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  const candidates = useMemo(() => audit?.candidates ?? [], [audit])
  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidateKey(candidate) === selectedKey) ?? null,
    [candidates, selectedKey],
  )
  const contextKey = selectedCandidate ? candidateKey(selectedCandidate) : null

  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (aiRequestOpen) return
      if (event.key === 'Escape' && !applying) {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), summary',
      ) ?? [])].filter((element) => element.getAttribute('aria-hidden') !== 'true')
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [aiRequestOpen, applying, onClose])

  useEffect(() => {
    const controller = new AbortController()
    setListLoading(true)
    setListError('')
    const query = scope === 'current' && activeMapId
      ? `?mapId=${encodeURIComponent(activeMapId)}`
      : ''
    void reviewRequest<{ audit: SharedKnowledgeAudit }>(clientId, `/api/shared-knowledge/audit${query}`, {
      signal: controller.signal,
    })
      .then(({ audit: nextAudit }) => {
        setAudit(nextAudit)
        setSelectedKey((current) => nextAudit.candidates.some((candidate) => candidateKey(candidate) === current)
          ? current
          : nextAudit.candidates[0] ? candidateKey(nextAudit.candidates[0]) : null)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setAudit(null)
        setSelectedKey(null)
        setListError(errorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false)
      })
    return () => controller.abort()
  }, [activeMapId, auditReloadToken, clientId, scope])

  useEffect(() => {
    setContext(null)
    setContextError('')
    setApplyError('')
    setDecision(null)
    setProposal('')
    setConfirmed(false)
    if (!selectedCandidate || !contextKey) return

    const controller = new AbortController()
    setContextLoading(true)
    const pathname = `/api/maps/${encodeURIComponent(selectedCandidate.mapId)}/cards/${encodeURIComponent(selectedCandidate.cardId)}/shared-knowledge-review-context?commentLimit=5&includeCommentDetail=false`
    void reviewRequest<{ context: SharedKnowledgeReviewContext }>(clientId, pathname, {
      signal: controller.signal,
    })
      .then(({ context: nextContext }) => {
        setContext(nextContext)
        setProposal(nextContext.card.sharedKnowledge)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setContextError(errorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setContextLoading(false)
      })
    return () => controller.abort()
  }, [clientId, contextKey, selectedCandidate])

  const proposalChanged = Boolean(context && proposal !== context.card.sharedKnowledge)
  const proposalOverLimit = proposal.length > sharedKnowledgeMaxLength
  const canApply = Boolean(
    context
    && decision
    && confirmed
    && !applying
    && !proposalOverLimit
    && (decision === 'accepted-long' || proposalChanged),
  )

  const refresh = () => {
    setContext(null)
    setAuditReloadToken((current) => current + 1)
  }

  const applyReview = async () => {
    if (!context || !decision || !canApply) return
    setApplying(true)
    setApplyError('')
    setSuccessMessage('')
    try {
      const patch = decision === 'cleaned'
        ? {
            cardId: context.card.id,
            expectedSha256: context.card.textIntegrity.sha256,
            reviewResult: decision,
            replacement: proposal,
          }
        : {
            cardId: context.card.id,
            expectedSha256: context.card.textIntegrity.sha256,
            reviewResult: decision,
          }
      const result = await reviewRequest<{
        document: ReviewDocumentSummary
        changes: Array<{ cardId: string }>
        atomic: boolean
      }>(clientId, `/api/maps/${encodeURIComponent(context.document.id)}/shared-knowledge/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          baseVersion: context.document.version,
          patches: [patch],
        }),
      })
      await onApplied({
        mapId: context.document.id,
        cardId: context.card.id,
        result: decision,
        document: result.document,
      })
      setSuccessMessage(decision === 'cleaned'
        ? '정리안을 적용하고 검토 완료로 기록했습니다.'
        : '현재 내용을 유지하는 것으로 검토 완료했습니다.')
      setContext(null)
      setSelectedKey(null)
      setAuditReloadToken((current) => current + 1)
    } catch (error) {
      if (error instanceof ReviewRequestError && error.status === 409) {
        setApplyError(`${error.message} 목록과 원문을 새로 불러온 뒤 다시 확인해 주세요.`)
      } else {
        setApplyError(errorMessage(error))
      }
    } finally {
      setApplying(false)
    }
  }

  const relatedGroups = context ? relationLabels.filter(({ key }) => context.relations.totals[key] > 0) : []
  const candidateDelta = context ? proposal.length - context.card.textIntegrity.length : 0

  return (
    <div
      className="shared-knowledge-review-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !applying && !aiRequestOpen) onClose()
      }}
    >
      <section ref={dialogRef} className="shared-knowledge-review-dialog" role="dialog" aria-modal="true" aria-labelledby="shared-knowledge-review-title">
        <header className="shared-knowledge-review-header">
          <div>
            <span>공유 지식 유지관리</span>
            <strong id="shared-knowledge-review-title">정리 후보 검토</strong>
            <small>원문과 문맥을 확인한 뒤 한 카드씩 명시적으로 승인합니다.</small>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} disabled={applying} aria-label="공유 지식 검토 닫기" title="닫기 (Esc)">
            <CloseIcon />
          </button>
        </header>

        <div className="shared-knowledge-review-body">
          <aside className="shared-knowledge-review-sidebar">
            <div className="shared-knowledge-review-scope" role="group" aria-label="검토 문서 범위">
              <button
                type="button"
                className={scope === 'all' ? 'active' : ''}
                onClick={() => {
                  setScope('all')
                  setAudit(null)
                  setContext(null)
                  setSelectedKey(null)
                  setSuccessMessage('')
                }}
              >전체 문서</button>
              <button
                type="button"
                className={scope === 'current' ? 'active' : ''}
                onClick={() => {
                  setScope('current')
                  setAudit(null)
                  setContext(null)
                  setSelectedKey(null)
                  setSuccessMessage('')
                }}
                disabled={!activeMapId}
              >현재 문서</button>
            </div>
            <div className="shared-knowledge-review-summary">
              <span>검토 대기</span>
              <strong>{listLoading ? '—' : formatCount(audit?.summary.actionableCandidateCount ?? 0)}</strong>
              <small>{scope === 'current' ? '현재 문서 기준' : `${formatCount(audit?.summary.documentCount ?? 0)}개 문서 기준`}</small>
            </div>
            <div className="shared-knowledge-review-list" aria-label="공유 지식 정리 후보">
              {listLoading && <div className="shared-knowledge-review-message">후보를 불러오는 중…</div>}
              {!listLoading && listError && (
                <div className="shared-knowledge-review-message error">
                  <span>{listError}</span>
                  <button type="button" onClick={refresh}>다시 시도</button>
                </div>
              )}
              {!listLoading && !listError && candidates.length === 0 && <EmptyReviewState filtered={scope === 'current'} />}
              {!listLoading && !listError && candidates.map((candidate) => (
                <button
                  type="button"
                  className={`shared-knowledge-review-candidate ${candidate.reviewLevel} ${candidateKey(candidate) === selectedKey ? 'selected' : ''}`}
                  key={candidateKey(candidate)}
                  onClick={() => {
                    setSuccessMessage('')
                    setSelectedKey(candidateKey(candidate))
                  }}
                  aria-current={candidateKey(candidate) === selectedKey}
                >
                  <span className="shared-knowledge-review-candidate-topline">
                    <em>{reviewLevelLabels[candidate.reviewLevel]}</em>
                    <small>{formatCount(candidate.length)}자</small>
                  </span>
                  <strong>{candidate.label}</strong>
                  <span className="shared-knowledge-review-document">{candidate.documentTitle}</span>
                  <span className="shared-knowledge-review-reasons">
                    {candidate.reasons.map((reason) => reasonLabels[reason] ?? reason).join(' · ')}
                  </span>
                </button>
              ))}
            </div>
            <button type="button" className="shared-knowledge-review-refresh" onClick={refresh} disabled={listLoading || applying}>
              <RefreshIcon /> 새로고침
            </button>
          </aside>

          <main className="shared-knowledge-review-main">
            {successMessage && <div className="shared-knowledge-review-success" role="status">{successMessage}</div>}
            {contextLoading && <div className="shared-knowledge-review-detail-message">검토 문맥과 원문을 불러오는 중…</div>}
            {!contextLoading && contextError && (
              <div className="shared-knowledge-review-detail-message error">
                <strong>검토 문맥을 불러오지 못했습니다.</strong>
                <span>{contextError}</span>
                <button type="button" onClick={refresh}>목록과 원문 새로고침</button>
              </div>
            )}
            {!contextLoading && !contextError && !context && !successMessage && candidates.length > 0 && (
              <div className="shared-knowledge-review-detail-message">왼쪽에서 검토할 카드를 선택해 주세요.</div>
            )}
            {!contextLoading && !contextError && !context && candidates.length === 0 && !listLoading && (
              <EmptyReviewState filtered={scope === 'current'} />
            )}
            {context && (
              <>
                <div className="shared-knowledge-review-card-header">
                  <div>
                    <span>{context.document.title}</span>
                    <strong>{context.card.label}</strong>
                    <small>공유 지식 수정 {formatDate(context.card.sharedKnowledgeUpdatedAt)} · 문서 버전 {context.document.version}</small>
                  </div>
                  <div className="shared-knowledge-review-card-actions">
                    {onRequestAiCleanup && (
                      <button
                        type="button"
                        className="shared-knowledge-review-ai-request"
                        onClick={() => {
                          const target = buildSharedKnowledgeCleanupLaunch(context)
                          if (target) onRequestAiCleanup(target)
                        }}
                        disabled={applying || aiRequestOpen}
                        title="이 카드를 대상으로 AI에게 정리안을 요청합니다. 자동 저장되지 않습니다."
                      >AI 정리 제안</button>
                    )}
                    <a href={context.accessUrl} target="_blank" rel="noreferrer">카드 열기 ↗</a>
                  </div>
                </div>

                <div className="shared-knowledge-review-stats" aria-label="공유 지식 분석 결과">
                  <span><small>길이</small><strong>{formatCount(context.card.textIntegrity.length)}자</strong></span>
                  <span><small>제한 사용</small><strong>{context.candidate.limitUsagePercent}%</strong></span>
                  <span><small>문단</small><strong>{formatCount(context.candidate.paragraphCount)}</strong></span>
                  <span><small>반복 문장</small><strong>{formatCount(context.candidate.exactDuplicateStatementCount)}</strong></span>
                  <span><small>지식 소비 카드</small><strong>{formatCount(context.relations.totals.knowledgeConsumers)}</strong></span>
                </div>

                <details className="shared-knowledge-review-context" open>
                  <summary>정리 기준과 주변 문맥</summary>
                  <div className="shared-knowledge-review-guidance">
                    <p><strong>유지</strong>{context.guidance.keep}</p>
                    <p><strong>제외</strong>{context.guidance.remove}</p>
                    <p><strong>보호</strong>{context.guidance.preserveMeaning}</p>
                  </div>
                  {context.card.description && (
                    <div className="shared-knowledge-review-description">
                      <strong>카드 요구사항</strong>
                      <p>{context.card.description}</p>
                    </div>
                  )}
                  {relatedGroups.length > 0 && (
                    <div className="shared-knowledge-review-relations">
                      {relatedGroups.map(({ key, label }) => (
                        <section key={key}>
                          <strong>{label} <small>{context.relations.totals[key]}</small></strong>
                          <div>
                            {context.relations[key].map((card) => <span key={card.id} title={card.descriptionPreview}>{card.label}</span>)}
                            {context.relations.truncatedTypes.includes(key) && <em>일부만 표시</em>}
                          </div>
                        </section>
                      ))}
                    </div>
                  )}
                  {context.comments.length > 0 && (
                    <div className="shared-knowledge-review-comments">
                      <strong>최근 댓글 <small>{context.commentsPage.returned}/{context.commentsPage.total}</small></strong>
                      {context.comments.map((comment) => (
                        <p key={comment.id}>
                          <span>{comment.author.name} · {formatDate(comment.createdAt)}</span>
                          {comment.summary ?? comment.text}
                          {comment.hasDetail && <em>상세 내용 있음</em>}
                        </p>
                      ))}
                    </div>
                  )}
                </details>

                <div className="shared-knowledge-review-compare">
                  <label>
                    <span><strong>현재 원문</strong><small>{formatCount(context.card.textIntegrity.length)}자 · 읽기 전용</small></span>
                    <textarea value={context.card.sharedKnowledge} readOnly spellCheck={false} aria-label="현재 공유 지식 원문" />
                  </label>
                  <label className={decision === 'accepted-long' ? 'disabled' : ''}>
                    <span>
                      <strong>정리안</strong>
                      <small className={proposalOverLimit ? 'over-limit' : ''}>
                        {formatCount(proposal.length)}자 · {candidateDelta > 0 ? '+' : ''}{formatCount(candidateDelta)}자
                      </small>
                    </span>
                    <textarea
                      value={proposal}
                      onChange={(event) => {
                        setProposal(event.target.value)
                        setConfirmed(false)
                        setApplyError('')
                      }}
                      readOnly={decision === 'accepted-long'}
                      spellCheck
                      aria-label="공유 지식 정리안"
                    />
                  </label>
                </div>

                <div className="shared-knowledge-review-decision" role="radiogroup" aria-label="검토 결과">
                  <label className={decision === 'cleaned' ? 'selected' : ''}>
                    <input
                      type="radio"
                      name="shared-knowledge-review-decision"
                      checked={decision === 'cleaned'}
                      onChange={() => { setDecision('cleaned'); setConfirmed(false); setApplyError('') }}
                    />
                    <span><strong>정리안으로 교체</strong><small>현재 원문과 다른 정리안을 저장합니다.</small></span>
                  </label>
                  <label className={decision === 'accepted-long' ? 'selected' : ''}>
                    <input
                      type="radio"
                      name="shared-knowledge-review-decision"
                      checked={decision === 'accepted-long'}
                      onChange={() => {
                        setDecision('accepted-long')
                        setProposal(context.card.sharedKnowledge)
                        setConfirmed(false)
                        setApplyError('')
                      }}
                    />
                    <span><strong>긴 내용 그대로 유지</strong><small>모든 내용이 계속 필요함을 확인하고 원문을 유지합니다.</small></span>
                  </label>
                </div>

                {decision === 'cleaned' && !proposalChanged && (
                  <div className="shared-knowledge-review-inline-warning">정리안이 현재 원문과 같습니다. 실제로 정리한 뒤 승인해 주세요.</div>
                )}
                {decision === 'cleaned' && !proposal.trim() && (
                  <div className="shared-knowledge-review-inline-warning danger">적용하면 이 카드의 공유 지식이 모두 제거됩니다.</div>
                )}
                {proposalOverLimit && (
                  <div className="shared-knowledge-review-inline-warning danger">정리안은 {formatCount(sharedKnowledgeMaxLength)}자를 넘을 수 없습니다.</div>
                )}
                {applyError && (
                  <div className="shared-knowledge-review-apply-error" role="alert">
                    <span>{applyError}</span>
                    <button type="button" onClick={refresh}>목록과 원문 새로고침</button>
                  </div>
                )}

                <footer className="shared-knowledge-review-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      disabled={!decision || proposalOverLimit || (decision === 'cleaned' && !proposalChanged)}
                    />
                    <span>원문·주변 문맥·선택한 결과를 확인했습니다.</span>
                  </label>
                  <button type="button" onClick={() => { void applyReview() }} disabled={!canApply}>
                    {applying ? '적용 중…' : decision === 'accepted-long' ? '유지로 승인' : '정리안 적용'}
                  </button>
                </footer>
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  )
}
