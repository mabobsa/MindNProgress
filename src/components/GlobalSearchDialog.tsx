import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildGlobalSearchPath,
  globalSearchHighlightSegments,
  mergeGlobalSearchResults,
} from '../utils/globalSearch.mjs'
import './GlobalSearchDialog.css'

type GlobalSearchDocument = { id: string; title: string }
type GlobalSearchGroup = { id: string; name: string; mapIds: string[] }
type GlobalSearchAssignee = { id: string; name: string }

type GlobalSearchResult = {
  entity: 'document' | 'card'
  mapId: string
  mapTitle: string
  mapVersion: number
  group: { id: string; name: string } | null
  cardId: string | null
  cardLabel: string | null
  path: string[]
  kind: 'root' | 'branch' | 'task' | 'image' | null
  isWork: boolean | null
  status: 'planned' | 'in-progress' | 'done' | null
  assignee: { id: string; name: string } | null
  hasWaitingItems: boolean
  reference: {
    sourceMapId: string
    sourceCardId: string
    sourceMapTitle: string | null
    sourceCardLabel: string | null
    unresolved: boolean
  } | null
  field: string
  fieldLabel: string
  snippet: string
  matchedTerms: string[]
  commentId?: string
}

type GlobalSearchResponse = {
  query: string
  mode: 'ranked' | 'catalog'
  coverage: {
    searchedDocumentCount: number
    searchedCardCount: number
    semanticCoverage: string
    note: string
  }
  page: {
    returned: number
    total: number
    hasMore: boolean
    nextCursor: string | null
  }
  results: GlobalSearchResult[]
}

type GlobalSearchApi = <T>(pathname: string, init?: RequestInit) => Promise<T>

const fieldOptions = [
  ['', '모든 필드'],
  ['documentTitle', '문서 제목'],
  ['cardTitle', '카드 제목'],
  ['description', '설명'],
  ['sharedKnowledge', '공유 지식'],
  ['comments', '댓글·답글'],
  ['checklist', '체크리스트'],
  ['waiting', '대기 항목'],
  ['metadata', '업무 메타데이터'],
] as const

const kindOptions = [
  ['', '모든 카드'],
  ['root', '루트'],
  ['branch', '분류'],
  ['task', '업무 카드'],
  ['image', '이미지'],
] as const

const statusOptions = [
  ['', '모든 상태'],
  ['planned', '예정'],
  ['in-progress', '진행 중'],
  ['done', '완료'],
] as const

const statusLabel = { planned: '예정', 'in-progress': '진행 중', done: '완료' } as const

function HighlightedSnippet({ text, terms }: { text: string; terms: string[] }) {
  return <>{globalSearchHighlightSegments(text, terms).map((segment, index) => (
    segment.highlighted
      ? <mark key={`${index}-${segment.text}`}>{segment.text}</mark>
      : <span key={`${index}-${segment.text}`}>{segment.text}</span>
  ))}</>
}

export function GlobalSearchDialog({
  api,
  documents,
  groups,
  assignees,
  onNavigate,
  onClose,
}: {
  api: GlobalSearchApi
  documents: GlobalSearchDocument[]
  groups: GlobalSearchGroup[]
  assignees: GlobalSearchAssignee[]
  onNavigate: (mapId: string, cardId: string | null) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('')
  const [field, setField] = useState('')
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [workType, setWorkType] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [waiting, setWaiting] = useState('')
  const [results, setResults] = useState<GlobalSearchResult[]>([])
  const [response, setResponse] = useState<GlobalSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const requestSequence = useRef(0)

  const searchOptions = useMemo(() => {
    const mapIds = scope.startsWith('map:') ? [scope.slice(4)] : []
    const groupIds = scope.startsWith('group:') ? [scope.slice(6)] : []
    return {
      query,
      mapIds,
      groupIds,
      fields: field ? [field] : [],
      kinds: kind ? [kind] : [],
      statuses: status ? [status] : [],
      assigneeIds: assigneeId ? [assigneeId] : [],
      isWork: workType === 'work' ? true : workType === 'non-work' ? false : null,
      hasWaitingItems: waiting === 'yes' ? true : waiting === 'no' ? false : null,
      limit: 25,
    }
  }, [assigneeId, field, kind, query, scope, status, waiting, workType])

  const runSearch = useCallback(async (cursor = '', append = false) => {
    if (!query.trim()) {
      setResults([])
      setResponse(null)
      setError('')
      return
    }
    const sequence = ++requestSequence.current
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError('')
    try {
      const result = await api<GlobalSearchResponse>(buildGlobalSearchPath({ ...searchOptions, cursor }))
      if (sequence !== requestSequence.current) return
      setResponse(result)
      setResults((current) => append ? mergeGlobalSearchResults(current, result.results) : result.results)
    } catch (requestError) {
      if (sequence !== requestSequence.current) return
      setError(requestError instanceof Error ? requestError.message : '전체 검색 결과를 불러오지 못했습니다.')
      if (!append) {
        setResults([])
        setResponse(null)
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [api, query, searchOptions])

  useEffect(() => {
    const timer = window.setTimeout(() => { void runSearch() }, 280)
    return () => window.clearTimeout(timer)
  }, [runSearch])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const resetFilters = () => {
    setScope('')
    setField('')
    setKind('')
    setStatus('')
    setWorkType('')
    setAssigneeId('')
    setWaiting('')
  }

  return (
    <div className="global-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="global-search-dialog" role="dialog" aria-modal="true" aria-labelledby="global-search-title">
        <header className="global-search-header">
          <div>
            <h2 id="global-search-title">전체 문서 검색</h2>
            <p>사람과 AI가 공유하는 검색 범위에서 문서·카드·댓글·업무 정보를 찾습니다.</p>
          </div>
          <button type="button" className="global-search-close" onClick={onClose} aria-label="전체 검색 닫기">×</button>
        </header>

        <div className="global-search-query">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="문서, 카드, 설명, 댓글, 담당자 검색"
            maxLength={240}
            aria-label="전체 문서 검색어"
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="검색어 지우기">×</button>}
        </div>

        <div className="global-search-filters" aria-label="전체 검색 필터">
          <select value={scope} onChange={(event) => setScope(event.target.value)} aria-label="문서 또는 그룹">
            <option value="">모든 문서</option>
            {groups.map((group) => <option key={group.id} value={`group:${group.id}`}>그룹 · {group.name}</option>)}
            {documents.map((document) => <option key={document.id} value={`map:${document.id}`}>문서 · {document.title}</option>)}
          </select>
          <select value={field} onChange={(event) => setField(event.target.value)} aria-label="검색 필드">
            {fieldOptions.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
          </select>
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="카드 종류">
            {kindOptions.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
          </select>
          <select value={workType} onChange={(event) => setWorkType(event.target.value)} aria-label="업무 여부">
            <option value="">업무 여부</option><option value="work">실제 업무</option><option value="non-work">비업무</option>
          </select>
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="업무 상태">
            {statusOptions.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
          </select>
          <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} aria-label="담당자">
            <option value="">모든 담당자</option>
            {assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.name}</option>)}
          </select>
          <select value={waiting} onChange={(event) => setWaiting(event.target.value)} aria-label="대기 항목 여부">
            <option value="">대기 여부</option><option value="yes">대기 있음</option><option value="no">대기 없음</option>
          </select>
          <button type="button" onClick={resetFilters}>필터 초기화</button>
        </div>

        <div className="global-search-status" aria-live="polite">
          {!query.trim() && <span>검색어를 입력하면 현재 열람 가능한 활성 문서 전체를 확인합니다.</span>}
          {query.trim() && loading && <span>검색 중…</span>}
          {query.trim() && !loading && !error && response && (
            <span>{response.page.total}건 · 문서 {response.coverage.searchedDocumentCount}개, 카드 {response.coverage.searchedCardCount}개 확인</span>
          )}
          {error && <span className="error">{error}</span>}
        </div>

        <div className="global-search-results">
          {!loading && query.trim() && !error && response && results.length === 0 && (
            <div className="global-search-empty">일치하는 결과가 없습니다. 표현을 바꾸거나 필터 범위를 넓혀 보세요.</div>
          )}
          {results.map((result, index) => (
            <button
              type="button"
              className="global-search-result"
              key={`${result.mapId}:${result.cardId ?? 'document'}:${result.field}:${result.commentId ?? index}:${index}`}
              onClick={() => onNavigate(result.mapId, result.cardId)}
            >
              <span className="global-search-result-location">
                {result.group && <em>{result.group.name}</em>}
                <strong>{result.mapTitle}</strong>
                {result.path.length > 0 && <span>{result.path.join(' › ')}</span>}
              </span>
              <span className="global-search-result-tags">
                <small>{result.fieldLabel}</small>
                {result.isWork && <small>업무</small>}
                {result.status && <small>{statusLabel[result.status]}</small>}
                {result.assignee && <small>{result.assignee.name}</small>}
                {result.hasWaitingItems && <small>대기 있음</small>}
                {result.reference && <small className={result.reference.unresolved ? 'warning' : 'reference'}>{result.reference.unresolved ? 'Ref 원본 없음' : 'Ref 최신 원본'}</small>}
              </span>
              <span className="global-search-result-snippet">
                <HighlightedSnippet text={result.snippet} terms={result.matchedTerms} />
              </span>
              {result.reference && !result.reference.unresolved && (
                <span className="global-search-reference">원본 · {result.reference.sourceMapTitle} / {result.reference.sourceCardLabel}</span>
              )}
            </button>
          ))}
          {response?.page.hasMore && (
            <button
              type="button"
              className="global-search-more"
              disabled={loadingMore || !response.page.nextCursor}
              onClick={() => { if (response.page.nextCursor) void runSearch(response.page.nextCursor, true) }}
            >
              {loadingMore ? '더 불러오는 중…' : `더 보기 · ${results.length}/${response.page.total}`}
            </button>
          )}
        </div>

        {response && <footer className="global-search-footer">{response.coverage.note}</footer>}
      </section>
    </div>
  )
}
