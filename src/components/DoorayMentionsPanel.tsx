import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './DoorayMentionsPanel.css'

export type DoorayMentionKind = 'mention-comment' | 'mention-body' | 'assigned' | 'cc' | 'related-comment'

export type DoorayMentionItem = {
  key: string
  kind: DoorayMentionKind
  occurredAt: string
  actorName: string
  actorMemberId: string
  projectId: string
  projectCode: string
  postId: string
  postNumber: number | null
  taskNumber: string
  subject: string
  workflowName: string
  workflowClass: string
  closed: boolean
  commentId: string | null
  excerpt: string
  url: string
  acknowledgedAt: string | null
}

type DoorayMentionScan = {
  status: 'idle' | 'running' | 'failed'
  phase: string | null
  done: number
  total: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

type DoorayMentionLastScan = {
  since: string
  until: string
  projectCount: number
  scannedPostCount: number
  itemCount: number
  requestCount: number
  throttledCount: number
  failureCount: number
  startedAt: string
  finishedAt: string
} | null

type DoorayMentionsResponse = {
  scan: DoorayMentionScan
  lastScan: DoorayMentionLastScan
  kinds: DoorayMentionKind[]
  maxRangeDays: number
  preferences: DoorayMentionPreferences | null
  items: DoorayMentionItem[]
}

type DoorayMentionPreferences = {
  since: string
  until: string
  quickRangeId: string | null
  sortOrder: DoorayMentionSortOrder
  includeBody: boolean
  includeComments: boolean
  includeAssigned: boolean
  includeCc: boolean
  unacknowledgedOnly: boolean
  hiddenKinds: DoorayMentionKind[]
}

type DoorayMentionSortOrder = 'current' | 'time-desc' | 'time-asc'

type DoorayMentionProject = {
  id: string
  code: string
  name: string
}

type DoorayMentionProjectsResponse = {
  projects: DoorayMentionProject[]
  selectedProjectIds: string[]
  maxSelectedProjects: number
}

const kindLabels: Record<DoorayMentionKind, string> = {
  'mention-comment': '댓글 멘션',
  'mention-body': '본문 멘션',
  assigned: '담당 지정',
  cc: '참조 지정',
  'related-comment': '관련 업무 댓글',
}

const phaseLabels: Record<string, string> = {
  me: '사용자 확인',
  projects: '프로젝트 목록',
  posts: '업무 목록',
  details: '본문과 댓글',
  members: '작성자 이름',
  done: '완료',
}

const quickRanges = [
  { id: 'today', calendarDays: 1, label: '오늘', title: '오늘 0시부터 현재까지' },
  { id: 'one-day', rollingHours: 24, label: '1일', title: '현재 시각 기준 최근 24시간' },
  { id: 'two-days', rollingHours: 48, label: '2일', title: '현재 시각 기준 최근 48시간' },
  { id: 'three-days', calendarDays: 3, label: '3일', title: '오늘을 포함한 최근 3개 날짜' },
  { id: 'seven-days', calendarDays: 7, label: '7일', title: '오늘을 포함한 최근 7개 날짜' },
  { id: 'thirty-days', calendarDays: 30, label: '30일', title: '오늘을 포함한 최근 30개 날짜' },
]

function quickRangeDateValues(rangeId: string, currentTime = new Date()) {
  const range = quickRanges.find((candidate) => candidate.id === rangeId)
  if (!range) return null
  const start = new Date(currentTime)
  if (range.rollingHours) start.setTime(start.getTime() - range.rollingHours * 60 * 60 * 1_000)
  else start.setDate(start.getDate() - ((range.calendarDays ?? 1) - 1))
  return { since: toDateInputValue(start), until: toDateInputValue(currentTime) }
}

function toDateInputValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

function startOfDayIso(value: string) {
  return new Date(`${value}T00:00:00`).toISOString()
}

function endOfDayIso(value: string) {
  return new Date(`${value}T23:59:59.999`).toISOString()
}

function formatMoment(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hour = `${date.getHours()}`.padStart(2, '0')
  const minute = `${date.getMinutes()}`.padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

function formatDuration(startedAt: string, finishedAt: string) {
  const seconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1_000))
  if (seconds < 60) return `${seconds}초`
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
}

async function mentionRequest<T>(clientId: string, pathname: string, init?: RequestInit) {
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
  if (!response.ok) throw new Error(body.error ?? 'Dooray 참조 요청을 처리하지 못했습니다.')
  return body
}

type PostGroup = {
  key: string
  postId: string
  subject: string
  projectCode: string
  taskNumber: string
  workflowName: string
  closed: boolean
  postUrl: string
  latestAt: string
  items: DoorayMentionItem[]
}

function postGroupForItem(item: DoorayMentionItem, key = item.postId): PostGroup {
  return {
    key,
    postId: item.postId,
    subject: item.subject,
    projectCode: item.projectCode,
    taskNumber: item.taskNumber,
    workflowName: item.workflowName,
    closed: item.closed,
    postUrl: item.url.split('#')[0],
    latestAt: item.occurredAt,
    items: [item],
  }
}

export function DoorayMentionsPanel({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const today = useMemo(() => toDateInputValue(new Date()), [])
  const [since, setSince] = useState(() => {
    const start = new Date()
    start.setDate(start.getDate() - 6)
    return toDateInputValue(start)
  })
  const [until, setUntil] = useState(today)
  const [quickRangeId, setQuickRangeId] = useState<string | null>('seven-days')
  const [sortOrder, setSortOrder] = useState<DoorayMentionSortOrder>('current')
  const [includeBody, setIncludeBody] = useState(true)
  const [includeComments, setIncludeComments] = useState(true)
  const [includeAssigned, setIncludeAssigned] = useState(true)
  const [includeCc, setIncludeCc] = useState(true)
  const [projects, setProjects] = useState<DoorayMentionProject[]>([])
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set())
  const [maxSelectedProjects, setMaxSelectedProjects] = useState(100)
  const [projectQuery, setProjectQuery] = useState('')
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectSelectionRequired, setProjectSelectionRequired] = useState(false)
  const [selectionSaving, setSelectionSaving] = useState(false)
  const [data, setData] = useState<DoorayMentionsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [unacknowledgedOnly, setUnacknowledgedOnly] = useState(true)
  const [hiddenKinds, setHiddenKinds] = useState<Set<DoorayMentionKind>>(new Set())
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const lifecycleControllerRef = useRef<AbortController | null>(null)
  const loadSequenceRef = useRef(0)
  const projectSelectionSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const projectSelectionSaveSequenceRef = useRef(0)
  const preferencesInitializedRef = useRef(false)
  const preferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const projectPickerRef = useRef<HTMLDetailsElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    lifecycleControllerRef.current = controller
    return () => {
      controller.abort()
      if (lifecycleControllerRef.current === controller) lifecycleControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [onClose])

  const loadProjects = useCallback(async () => {
    const signal = lifecycleControllerRef.current?.signal
    if (!signal) return
    setProjectsLoading(true)
    try {
      const body = await mentionRequest<DoorayMentionProjectsResponse>(
        clientId,
        '/api/integrations/dooray/mentions/projects',
        { signal },
      )
      if (signal.aborted) return
      setProjects(body.projects)
      setSelectedProjectIds(new Set(body.selectedProjectIds))
      setMaxSelectedProjects(body.maxSelectedProjects)
      setProjectError(null)
    } catch (loadError) {
      if (!signal.aborted) {
        setProjectError(loadError instanceof Error ? loadError.message : '프로젝트 목록을 불러오지 못했습니다.')
      }
    } finally {
      if (!signal.aborted) setProjectsLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const saveProjectSelection = useCallback((nextSelection: Set<string>) => {
    const projectIds = [...nextSelection]
    setSelectedProjectIds(nextSelection)
    setProjectSelectionRequired(projectIds.length === 0)
    setProjectError(null)
    setError(null)
    setSelectionSaving(true)
    const sequence = ++projectSelectionSaveSequenceRef.current
    const pending = projectSelectionSaveQueueRef.current.catch(() => {}).then(async () => {
      const signal = lifecycleControllerRef.current?.signal
      if (!signal) return
      try {
        await mentionRequest(clientId, '/api/integrations/dooray/mentions/projects', {
          method: 'PUT',
          signal,
          body: JSON.stringify({ projectIds }),
        })
      } catch (saveError) {
        if (!signal.aborted) {
          setProjectError(saveError instanceof Error ? saveError.message : '프로젝트 선택을 저장하지 못했습니다.')
        }
      } finally {
        if (!signal.aborted && sequence === projectSelectionSaveSequenceRef.current) setSelectionSaving(false)
      }
    })
    projectSelectionSaveQueueRef.current = pending
  }, [clientId])

  const persistPreferences = useCallback((patch: Partial<DoorayMentionPreferences>) => {
    preferencesInitializedRef.current = true
    const preferences: DoorayMentionPreferences = {
      since,
      until,
      quickRangeId,
      sortOrder,
      includeBody,
      includeComments,
      includeAssigned,
      includeCc,
      unacknowledgedOnly,
      hiddenKinds: [...hiddenKinds],
      ...patch,
    }
    const pending = preferenceSaveQueueRef.current.catch(() => {}).then(async () => {
      const signal = lifecycleControllerRef.current?.signal
      if (!signal) return
      try {
        await mentionRequest(clientId, '/api/integrations/dooray/mentions/preferences', {
          method: 'PUT',
          signal,
          body: JSON.stringify(preferences),
        })
      } catch (saveError) {
        if (!signal.aborted) {
          setError(saveError instanceof Error ? saveError.message : '조회 조건을 저장하지 못했습니다.')
        }
      }
    })
    preferenceSaveQueueRef.current = pending
  }, [clientId, since, until, quickRangeId, sortOrder, includeBody, includeComments, includeAssigned, includeCc, unacknowledgedOnly, hiddenKinds])

  const load = useCallback(async () => {
    const signal = lifecycleControllerRef.current?.signal
    if (!signal) return null
    const sequence = ++loadSequenceRef.current
    try {
      const body = await mentionRequest<DoorayMentionsResponse>(clientId, '/api/integrations/dooray/mentions', { signal })
      if (signal.aborted || sequence !== loadSequenceRef.current) return body
      setData(body)
      if (!preferencesInitializedRef.current) {
        const preferences = body.preferences
        if (preferences) {
          const quickDates = preferences.quickRangeId
            ? quickRangeDateValues(preferences.quickRangeId)
            : null
          setSince(quickDates?.since ?? preferences.since)
          setUntil(quickDates?.until ?? preferences.until)
          setQuickRangeId(preferences.quickRangeId)
          setSortOrder(preferences.sortOrder)
          setIncludeBody(preferences.includeBody)
          setIncludeComments(preferences.includeComments)
          setIncludeAssigned(preferences.includeAssigned)
          setIncludeCc(preferences.includeCc)
          setUnacknowledgedOnly(preferences.unacknowledgedOnly)
          setHiddenKinds(new Set(preferences.hiddenKinds))
        }
        preferencesInitializedRef.current = true
      }
      setError(null)
      return body
    } catch (loadError) {
      if (!signal.aborted && sequence === loadSequenceRef.current) {
        setError(loadError instanceof Error ? loadError.message : '조회에 실패했습니다.')
      }
      return null
    } finally {
      if (!signal.aborted && sequence === loadSequenceRef.current) setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const running = data?.scan.status === 'running'
  useEffect(() => {
    if (!running) return undefined
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      await load()
      if (!cancelled) timer = window.setTimeout(() => { void poll() }, 800)
    }
    timer = window.setTimeout(() => { void poll() }, 800)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [running, load])

  const startScan = useCallback(async () => {
    const signal = lifecycleControllerRef.current?.signal
    if (!signal) return
    setError(null)
    if (selectedProjectIds.size === 0) {
      setProjectSelectionRequired(true)
      setError('탐색할 프로젝트를 하나 이상 선택해 주세요.')
      const projectPicker = projectPickerRef.current
      if (projectPicker) {
        projectPicker.open = true
        projectPicker.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
      return
    }
    try {
      const selectedQuickRange = quickRanges.find((range) => range.id === quickRangeId)
      const currentTime = new Date()
      let requestSince = startOfDayIso(since)
      let requestUntil = endOfDayIso(until)
      if (selectedQuickRange?.rollingHours) {
        requestSince = new Date(currentTime.getTime() - selectedQuickRange.rollingHours * 60 * 60 * 1_000).toISOString()
        requestUntil = currentTime.toISOString()
      } else if (selectedQuickRange?.calendarDays) {
        const start = new Date(currentTime)
        start.setDate(start.getDate() - (selectedQuickRange.calendarDays - 1))
        requestSince = startOfDayIso(toDateInputValue(start))
        requestUntil = currentTime.toISOString()
      }
      await mentionRequest(clientId, '/api/integrations/dooray/mentions/scan', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          since: requestSince,
          until: requestUntil,
          includeBody,
          includeComments,
          includeAssigned,
          includeCc,
          projectIds: [...selectedProjectIds],
        }),
      })
      if (signal.aborted) return
      await load()
    } catch (scanError) {
      if (!signal.aborted) setError(scanError instanceof Error ? scanError.message : '수집을 시작하지 못했습니다.')
    }
  }, [clientId, since, until, quickRangeId, includeBody, includeComments, includeAssigned, includeCc, selectedProjectIds, load])

  const acknowledge = useCallback(async (keys: string[], acknowledged: boolean) => {
    if (keys.length === 0) return
    const signal = lifecycleControllerRef.current?.signal
    if (!signal) return
    setPendingKeys((current) => new Set([...current, ...keys]))
    try {
      const body = await mentionRequest<DoorayMentionsResponse>(clientId, '/api/integrations/dooray/mentions/acknowledgements', {
        method: 'POST',
        signal,
        body: JSON.stringify({ keys, acknowledged }),
      })
      if (!signal.aborted) setData(body)
    } catch (ackError) {
      if (!signal.aborted) setError(ackError instanceof Error ? ackError.message : '확인 표시를 저장하지 못했습니다.')
    } finally {
      if (!signal.aborted) {
        setPendingKeys((current) => {
          const next = new Set(current)
          for (const key of keys) next.delete(key)
          return next
        })
      }
    }
  }, [clientId])

  const items = useMemo(() => data?.items ?? [], [data])
  const visibleItems = useMemo(() => items.filter((item) => {
    if (hiddenKinds.has(item.kind)) return false
    if (unacknowledgedOnly && item.acknowledgedAt) return false
    return true
  }), [items, hiddenKinds, unacknowledgedOnly])

  const groups = useMemo(() => {
    if (sortOrder !== 'current') {
      const direction = sortOrder === 'time-asc' ? 1 : -1
      const orderedItems = [...visibleItems].sort((left, right) => {
        const byTime = left.occurredAt.localeCompare(right.occurredAt) * direction
        return byTime || left.key.localeCompare(right.key)
      })
      const chronologicalGroups: PostGroup[] = []
      for (const item of orderedItems) {
        const previous = chronologicalGroups.at(-1)
        if (previous?.postId === item.postId) {
          previous.items.push(item)
          if (item.occurredAt > previous.latestAt) previous.latestAt = item.occurredAt
        } else {
          chronologicalGroups.push(postGroupForItem(item, `${item.postId}:${item.key}`))
        }
      }
      return chronologicalGroups
    }

    const byPost = new Map<string, PostGroup>()
    for (const item of visibleItems) {
      const existing = byPost.get(item.postId)
      if (existing) {
        existing.items.push(item)
        if (item.occurredAt > existing.latestAt) existing.latestAt = item.occurredAt
        continue
      }
      byPost.set(item.postId, postGroupForItem(item))
    }
    return [...byPost.values()].sort((left, right) => right.latestAt.localeCompare(left.latestAt))
  }, [visibleItems, sortOrder])

  const kindCounts = useMemo(() => {
    const counts = new Map<DoorayMentionKind, number>()
    for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
    return counts
  }, [items])

  const unacknowledgedCount = items.filter((item) => !item.acknowledgedAt).length
  const scan = data?.scan
  const lastScan = data?.lastScan ?? null
  const progressRatio = scan && scan.total > 0 ? Math.min(1, scan.done / scan.total) : 0

  return (
    <div className="dooray-mentions-backdrop" role="presentation" onClick={onClose}>
      <section
        className="dooray-mentions-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Dooray 참조"
        aria-busy={loading}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dooray-mentions-header">
          <div>
            <h2>Dooray 참조</h2>
            <p>기간 안에 나를 멘션했거나 내가 담당·참조로 걸린 업무 활동을 모읍니다.</p>
          </div>
          <button type="button" className="dooray-mentions-close" onClick={onClose} aria-label="닫기">✕</button>
        </header>

        {loading && (
          <div className="dooray-mentions-initial-loading" role="status" aria-live="polite">
            불러오는 중…
          </div>
        )}
        <div className="dooray-mentions-content" hidden={loading}>
        <div className="dooray-mentions-controls">
          <div className="dooray-mentions-range">
            {quickRanges.map((range) => (
              <button
                key={range.id}
                type="button"
                className={quickRangeId === range.id ? 'active' : ''}
                aria-pressed={quickRangeId === range.id}
                title={range.title}
                onClick={() => {
                  const dates = quickRangeDateValues(range.id)
                  if (!dates) return
                  setSince(dates.since)
                  setUntil(dates.until)
                  setQuickRangeId(range.id)
                  persistPreferences({ ...dates, quickRangeId: range.id })
                }}
              >
                {range.label}
              </button>
            ))}
            <input type="date" value={since} max={until} onChange={(event) => {
              setSince(event.target.value)
              setQuickRangeId(null)
              persistPreferences({ since: event.target.value, quickRangeId: null })
            }} aria-label="시작일" />
            <span>~</span>
            <input type="date" value={until} min={since} onChange={(event) => {
              setUntil(event.target.value)
              setQuickRangeId(null)
              persistPreferences({ until: event.target.value, quickRangeId: null })
            }} aria-label="종료일" />
          </div>
          <div className="dooray-mentions-options">
            <label>
              <input type="checkbox" checked={includeBody} onChange={(event) => {
                setIncludeBody(event.target.checked)
                persistPreferences({ includeBody: event.target.checked })
              }} />
              본문 멘션
            </label>
            <label>
              <input type="checkbox" checked={includeComments} onChange={(event) => {
                setIncludeComments(event.target.checked)
                persistPreferences({ includeComments: event.target.checked })
              }} />
              댓글 멘션
            </label>
            <label>
              <input type="checkbox" checked={includeAssigned} onChange={(event) => {
                setIncludeAssigned(event.target.checked)
                persistPreferences({ includeAssigned: event.target.checked })
              }} />
              담당 업무
            </label>
            <label>
              <input type="checkbox" checked={includeCc} onChange={(event) => {
                setIncludeCc(event.target.checked)
                persistPreferences({ includeCc: event.target.checked })
              }} />
              참조 업무
            </label>
            <button type="button" className="dooray-mentions-scan" onClick={() => void startScan()} disabled={running || projectsLoading}>
              {running ? '수집 중…' : '수집'}
            </button>
          </div>
        </div>

        <details
          ref={projectPickerRef}
          className={`dooray-mentions-projects ${projectSelectionRequired ? 'required' : ''}`}
        >
          <summary>
            <strong>탐색 프로젝트</strong>
            <span>{selectedProjectIds.size}/{projects.length}개 선택</span>
            {selectionSaving && <span>저장 중…</span>}
          </summary>
          <div className="dooray-mentions-projects-body">
            <div className="dooray-mentions-projects-head">
              <input
                type="search"
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
                placeholder="프로젝트 검색"
                aria-label="프로젝트 검색"
              />
              <button type="button" onClick={() => saveProjectSelection(new Set(
                projects.slice(0, maxSelectedProjects).map((project) => project.id),
              ))}>
                전체 선택
              </button>
              <button type="button" onClick={() => saveProjectSelection(new Set())}>전체 해제</button>
              <button type="button" onClick={() => void loadProjects()} disabled={projectsLoading}>새로고침</button>
            </div>
            {projectsLoading && <p>프로젝트 목록을 불러오는 중…</p>}
            {!projectsLoading && projects.length === 0 && !projectError && <p>선택할 수 있는 프로젝트가 없습니다.</p>}
            {projectError && <p className="dooray-mentions-project-error">{projectError}</p>}
            {!projectsLoading && projects.length > 0 && (
              <div className="dooray-mentions-project-list">
                {projects.filter((project) => {
                  const query = projectQuery.trim().toLocaleLowerCase()
                  if (!query) return true
                  return `${project.code} ${project.name}`.toLocaleLowerCase().includes(query)
                }).map((project) => (
                  <label key={project.id}>
                    <input
                      type="checkbox"
                      checked={selectedProjectIds.has(project.id)}
                      onChange={(event) => {
                        const next = new Set(selectedProjectIds)
                        if (event.target.checked) {
                          if (next.size >= maxSelectedProjects) {
                            setProjectError(`프로젝트는 최대 ${maxSelectedProjects}개까지 선택할 수 있습니다.`)
                            return
                          }
                          next.add(project.id)
                        } else next.delete(project.id)
                        saveProjectSelection(next)
                      }}
                    />
                    <span className="dooray-mentions-project-code">{project.code || project.id}</span>
                    {project.name && project.name !== project.code && <span>{project.name}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        </details>

        {running && scan && (
          <div className="dooray-mentions-progress">
            <div className="dooray-mentions-progress-bar">
              <span style={{ width: `${Math.round(progressRatio * 100)}%` }} />
            </div>
            <span className="dooray-mentions-progress-label">
              {phaseLabels[scan.phase ?? ''] ?? '준비'} {scan.total > 0 ? `${scan.done}/${scan.total}` : ''}
            </span>
          </div>
        )}

        {error && <p className="dooray-mentions-error">{error}</p>}
        {scan?.status === 'failed' && scan.error && <p className="dooray-mentions-error">{scan.error}</p>}

        {lastScan && (
          <p className="dooray-mentions-summary">
            {formatMoment(lastScan.since)} ~ {formatMoment(lastScan.until)} · 프로젝트 {lastScan.projectCount}개 ·
            {' '}변경 업무 {lastScan.scannedPostCount}건 · <strong>참조 {lastScan.itemCount}건</strong> ·
            {' '}요청 {lastScan.requestCount}회 · {formatDuration(lastScan.startedAt, lastScan.finishedAt)} 소요
          </p>
        )}

        <div className="dooray-mentions-filters">
          <label className="dooray-mentions-toggle">
            <input
              type="checkbox"
              checked={unacknowledgedOnly}
              onChange={(event) => {
                setUnacknowledgedOnly(event.target.checked)
                persistPreferences({ unacknowledgedOnly: event.target.checked })
              }}
            />
            미확인만 ({unacknowledgedCount})
          </label>
          {(data?.kinds ?? []).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`dooray-mentions-chip ${hiddenKinds.has(kind) ? 'off' : ''}`}
              onClick={() => {
                const next = new Set(hiddenKinds)
                if (next.has(kind)) next.delete(kind)
                else next.add(kind)
                setHiddenKinds(next)
                persistPreferences({ hiddenKinds: [...next] })
              }}
            >
              {kindLabels[kind]} {kindCounts.get(kind) ?? 0}
            </button>
          ))}
          <label className="dooray-mentions-sort">
            <span>정렬</span>
            <select
              value={sortOrder}
              onChange={(event) => {
                const next = event.target.value as DoorayMentionSortOrder
                setSortOrder(next)
                persistPreferences({ sortOrder: next })
                event.currentTarget.blur()
              }}
              aria-label="결과 정렬"
            >
              <option value="current">프로젝트 기준</option>
              <option value="time-desc">시간순 내림차순</option>
              <option value="time-asc">시간순 오름차순</option>
            </select>
          </label>
        </div>

        <div className="dooray-mentions-list">
          {loading && <p className="dooray-mentions-empty">불러오는 중…</p>}
          {!loading && groups.length === 0 && (
            <p className="dooray-mentions-empty">
              {items.length === 0 ? '수집한 참조가 없습니다. 기간을 정하고 수집을 눌러 주세요.' : '조건에 맞는 참조가 없습니다.'}
            </p>
          )}
          {groups.map((group) => {
            const openKeys = group.items.filter((item) => !item.acknowledgedAt).map((item) => item.key)
            return (
              <article key={group.key} className="dooray-mentions-group">
                <header>
                  <a href={group.postUrl} target="_blank" rel="noreferrer noopener" className="dooray-mentions-subject">
                    {group.subject || '(제목 없음)'}
                  </a>
                  <div className="dooray-mentions-meta">
                    <span>{group.taskNumber || group.projectCode}</span>
                    {group.workflowName && <span className={`dooray-mentions-state ${group.closed ? 'closed' : ''}`}>{group.workflowName}</span>}
                    {openKeys.length > 0 && (
                      <button type="button" onClick={() => void acknowledge(openKeys, true)}>
                        {openKeys.length}건 모두 확인
                      </button>
                    )}
                  </div>
                </header>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.key} className={item.acknowledgedAt ? 'acknowledged' : ''}>
                      <label className="dooray-mentions-check">
                        <input
                          type="checkbox"
                          checked={Boolean(item.acknowledgedAt)}
                          disabled={pendingKeys.has(item.key)}
                          onChange={(event) => void acknowledge([item.key], event.target.checked)}
                          aria-label="확인함"
                        />
                      </label>
                      <div className="dooray-mentions-entry">
                        <div className="dooray-mentions-entry-head">
                          <div className="dooray-mentions-entry-meta">
                            <span className={`dooray-mentions-kind ${item.kind}`}>{kindLabels[item.kind]}</span>
                            <span className="dooray-mentions-actor">{item.actorName || '알 수 없음'}</span>
                            <time dateTime={item.occurredAt}>{formatMoment(item.occurredAt)}</time>
                          </div>
                          <a href={item.url} target="_blank" rel="noreferrer noopener">열기</a>
                        </div>
                        {item.excerpt && <p className="dooray-mentions-excerpt">{item.excerpt}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
            )
          })}
        </div>
        </div>
      </section>
    </div>
  )
}
