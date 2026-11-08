import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { completedReplacementDelegations, type AiDelegationSummary } from '../utils/aiDelegationManagement.mjs'
import { aiDelegationDisplayItems, aiDelegationDisplaySections, aiDelegationRequiresRecovery } from '../utils/aiDelegationStatus.mjs'
import { groupDelegationPresentation, groupDelegationReportHint, type GroupDelegation } from '../utils/groupOverview.mjs'
import { integrationRecoveryPending, integrationRecoveryUnconfirmed, reconcileIntegrationRecoveryRequests, submitIntegrationRecovery } from '../utils/aiIntegrationRecovery.mjs'
import './AiDelegationRecovery.css'

type Delegation = GroupDelegation & AiDelegationSummary & {
  recoveryDispatchError?: string
}

type CloseReason = 'result-invalidated' | 'conversation-removed' | 'no-longer-needed'
type RequestCloseReason = 'cancelled' | 'no-longer-needed'
const requestCloseReasonLabels: Record<RequestCloseReason, string> = {
  cancelled: '요청 취소',
  'no-longer-needed': '더 이상 진행할 필요 없음',
}

const closeReasonLabels: Record<CloseReason, string> = {
  'result-invalidated': '결과가 되돌려졌거나 더 이상 유효하지 않음',
  'conversation-removed': '실행 또는 상위 대화가 삭제됨',
  'no-longer-needed': '재개나 결과 보고가 더 이상 필요하지 않음',
}

const actionHints = {
  refresh: '기존 실행 기록의 상태만 조회해 화면과 저장 상태를 동기화합니다. 새 AI 실행은 요청하지 않습니다.',
  recover: '중단된 작업을 같은 AI 대화와 작업공간에서 이어갑니다. 확인창에서 승인하면 해당 AI가 다시 실행됩니다.',
  retryIntegration: '보존된 완료 커밋의 통합을 다시 요청합니다. 현재 Git 잠금과 변경 상태를 먼저 확인하며 상위 보고 완료를 기다리지 않습니다. 하위 AI 작업은 다시 실행하지 않습니다.',
  correctResult: '원 담당 AI가 같은 worker에서 자기 결과를 정정하고 새 체크포인트를 만듭니다. 통합 사용자 파일은 보존하며 결과 정정은 품질 승인이나 삭제 권한이 아닙니다.',
  retryReport: '완료된 하위 작업은 다시 실행하지 않고 저장된 결과만 상위 AI에 전달합니다. 상위 AI는 결과 검토를 위해 실행됩니다.',
  supersede: '이 위임을 완료 처리하지 않고 선택한 후속 성공 위임으로 대체되었다는 이력을 남겨 닫습니다. 카드·코드·작업공간은 변경하지 않으며 UI에서 되돌릴 수 없습니다.',
  checkRequest: '서버 기록에서 같은 업무의 재접수가 확인되는지 검사합니다. 근거가 일치할 때만 경고를 해제하며 AI 실행이나 업무 완료 처리를 하지 않습니다.',
  openClose: '결과 전달과 완료 처리를 포기하고 위임 기록만 닫는 절차를 엽니다. 바로 종료되지 않으며 사유·감사 메모 입력과 최종 확인이 필요합니다.',
  cancelClose: '사용자 종료 입력을 취소합니다. 위임 상태와 저장된 결과는 변경되지 않습니다.',
  confirmClose: '결과를 상위 AI에 보고하지 않고 위임을 사용자 종료 상태로 닫습니다. 완료로 기록하지 않고 카드·코드·작업공간은 변경하지 않으며 UI에서 되돌릴 수 없습니다.',
} as const

function actionAccessibility(label: string, hint: string) {
  return { title: hint, 'aria-label': `${label}. ${hint}` }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, signal: init?.signal ?? AbortSignal.timeout(65_000) })
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'AI 작업 상태를 확인하지 못했습니다.'), { status: response.status, code: body.code })
  return body as T
}

export type AiDelegationPreviewCard = { mapId: string; cardId: string }
export type AiDelegationPreview = { parent: AiDelegationPreviewCard; target: AiDelegationPreviewCard }

export function AiDelegationRecovery({ mapId, cardId, focusRequestId, onFocusHandled, onSelectCard, onPreviewCards }: {
  mapId: string
  cardId: string
  focusRequestId?: number
  onFocusHandled?: (requestId: number) => void
  onSelectCard: (mapId: string, cardId: string) => void
  onPreviewCards: (preview: AiDelegationPreview | null) => void
}) {
  const [items, setItems] = useState<Delegation[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Record<string, { error?: boolean; message: string }>>({})
  const [historyOpen, setHistoryOpen] = useState(false)
  const [requestHistoryOpen, setRequestHistoryOpen] = useState(false)
  const [requestHistory, setRequestHistory] = useState<Delegation[]>([])
  const [replacementIds, setReplacementIds] = useState<Record<string, string>>({})
  const [closeDraft, setCloseDraft] = useState<{ id: string; reason: CloseReason; note: string } | null>(null)
  const [requestCloseDraft, setRequestCloseDraft] = useState<{ id: string; reason: RequestCloseReason; note: string; expectedUpdatedAt: string } | null>(null)
  const mounted = useRef(true)
  const acting = useRef(false)
  const sectionRef = useRef<HTMLElement | null>(null)
  const previewedItem = useRef<{ id: string; history: boolean } | null>(null)
  const listUrl = `/api/maps/${encodeURIComponent(mapId)}/ai-delegations`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const data = await request<{ delegations: Delegation[]; requestFailures?: Delegation[] }>(listUrl, { signal })
    const relevant = aiDelegationDisplayItems(data.delegations, data.requestFailures).filter((item) =>
      (item.parentMapId ?? item.mapId) === mapId && item.parentCardId === cardId)
    reconcileIntegrationRecoveryRequests(relevant)
    if (mounted.current) {
      setItems(relevant)
      setRequestHistory((data.requestFailures ?? []).filter(item => (item.resolvedByDelegationId || item.requestClosure)
        && (item.parentMapId ?? item.mapId) === mapId && item.parentCardId === cardId))
      setLoaded(true)
    }
  }, [listUrl, mapId, cardId])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { if (!acting.current) await refresh(controller.signal) }
      catch (reason) {
        if (!controller.signal.aborted && mounted.current) setError(reason instanceof Error ? reason.message : '조회 실패')
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5_000)
    }
    void poll()
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer) }
  }, [refresh])

  useEffect(() => () => onPreviewCards(null), [onPreviewCards])
  useEffect(() => { setHistoryOpen(false); setRequestHistoryOpen(false); setRequestCloseDraft(null) }, [mapId, cardId])

  async function openConversation(item: Delegation, conversationId: string) {
    // 클릭 동기 경계에서 창을 만들고 기존 권한·머신 검증 API로 주소를 확인한다.
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    try {
      const result = await request<{ openUrl: string }>(`/api/maps/${encodeURIComponent(item.mapId)}/cards/${encodeURIComponent(item.targetCardId)}/ai-conversations/${encodeURIComponent(conversationId)}/open-url`)
      if (tab) tab.location.href = result.openUrl
      else setError('브라우저에서 새 창이 차단됐습니다. 팝업을 허용한 뒤 다시 열어 주세요.')
    } catch (reason) {
      tab?.close()
      setError(reason instanceof Error ? reason.message : '대화를 열지 못했습니다.')
    }
  }

  async function action(item: Delegation, kind: 'refresh' | 'recover' | 'retry-report' | 'supersede' | 'recheck-integration' | 'check-request') {
    if (acting.current) return
    if (kind === 'check-request') {
      acting.current = true; setBusy(true); setError(''); setNotice('')
      setFeedback(current => ({ ...current, [item.id]: { message: '서버의 재접수 기록을 확인하고 있습니다.' } }))
      try {
        const result = await request<{ message: string }>(`/api/maps/${encodeURIComponent(item.parentMapId ?? item.mapId)}/ai-delegation-request-failures/${encodeURIComponent(item.id)}/recheck`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }),
        })
        if (mounted.current) {
          setNotice(result.message)
          setFeedback(current => ({ ...current, [item.id]: { message: result.message } }))
        }
      } catch (reason) {
        if (mounted.current) setError(reason instanceof Error ? reason.message : '재접수 확인 실패')
      } finally {
        try { await refresh() } catch { /* 처리 결과를 유지한다. */ }
        acting.current = false
        if (mounted.current) setBusy(false)
      }
      return
    }
    if (kind === 'recheck-integration') {
      if (!integrationRecoveryUnconfirmed(item)) return
      acting.current = true; setBusy(true)
      try {
        const result = await submitIntegrationRecovery(item, {}, request)
        if (mounted.current) setFeedback(current => ({ ...current, [item.id]: { message: result.message } }))
      } catch (reason) {
        if (mounted.current) setFeedback(current => ({ ...current, [item.id]: { error: true, message: reason instanceof Error ? reason.message : '접수 재확인 실패' } }))
      } finally {
        try { await refresh() } catch { /* 동일 요청 자료와 안내를 보존한다. */ }
        acting.current = false
        if (mounted.current) setBusy(false)
      }
      return
    }
    if (kind === 'refresh' && (item.integrationRecoveryRequest || integrationRecoveryUnconfirmed(item))) {
      try { await refresh() } catch (reason) { setFeedback(current => ({ ...current, [item.id]: { error: true, message: reason instanceof Error ? reason.message : '접수 상태 조회 실패' } })) }
      return
    }
    if (kind === 'recover' && (integrationRecoveryPending(item) || integrationRecoveryUnconfirmed(item))) return
    const candidates = completedReplacementDelegations(item, items)
    const replacementId = replacementIds[item.id] ?? candidates[0]?.id
    if (kind === 'supersede' && !replacementId) return
    const retryIntegration = item.recovery?.recommendedAction === 'retry-integration'
    const correctResult = item.recovery?.recommendedAction === 'correct-integration-result'
    const confirmation = kind === 'recover'
      ? correctResult ? '통합 대기 결과 정정을 승인할까요? 원 담당 AI가 같은 worker에서 요구사항과 증거를 대사하고 자기 우발 변경을 새 체크포인트로 정정합니다. 통합 사용자 파일은 보존합니다. 이 요청은 업무 완료·품질 승인이나 사용자 파일 삭제 권한을 부여하지 않습니다.' : retryIntegration
        ? '보존된 완료 커밋의 통합을 다시 시도할까요? 현재 Git 잠금과 변경 상태를 먼저 확인합니다. 상위 보고 완료를 기다리지 않으며 사용자 파일과 기존 후보를 보존합니다. 하위 AI 작업은 다시 실행하지 않습니다.'
        : '중단 원인이 해소되었고 기존 승인 범위에서 작업을 이어갈까요? 현재 변경을 확인하고 남은 작업만 같은 AI 대화에서 진행합니다.'
      : kind === 'retry-report'
        ? '하위 작업을 재실행하지 않고 저장된 결과를 상위 AI에 다시 전달할까요? 상위 AI가 결과 검토를 위해 실행됩니다.'
        : kind === 'supersede'
          ? `이 위임을 완료 처리하지 않고 후속 성공 위임 ${replacementId}으로 대체됐다는 이력을 남겨 종료할까요?`
          : ''
    if (confirmation && !window.confirm(confirmation)) return
    acting.current = true
    setBusy(true); setError(''); setNotice('')
    setFeedback(current => ({ ...current, [item.id]: { message: kind === 'recover' ? '복구 요청을 접수하고 있습니다. 잠시 기다려 주세요.' : '요청을 처리하고 있습니다.' } }))
    try {
      const parentMapId = item.parentMapId ?? item.mapId
      const [parent, target, group] = await Promise.all([
        request<{ map: { version: number } }>(`/api/maps/${encodeURIComponent(parentMapId)}`),
        request<{ map: { version: number } }>(`/api/maps/${encodeURIComponent(item.mapId)}`),
        item.groupId ? request<{ project: { version: number } }>(`/api/groups/${encodeURIComponent(item.groupId)}`) : Promise.resolve(null),
      ])
      const body = {
          expectedUpdatedAt: item.updatedAt, sourceRevision: parent.map.version, targetRevision: target.map.version,
          ...(group ? { groupVersion: group.project.version } : {}),
          confirmApprovedScope: kind === 'recover' || kind === 'retry-report',
          ...(kind === 'recover' && correctResult ? { recoveryMode: 'correct-integration-result' } : {}),
          ...(kind === 'recover' ? { instruction: correctResult
            ? '사용자가 통합 대기 결과 정정을 승인했습니다. 원 요구사항과 source 체크포인트 증거를 대사하고 본인의 우발 변경만 같은 worker에서 정정하세요. integration 사용자 파일은 보존하세요. 정상 변경 체크포인트 후 정정 검증 결과를 보고하세요.' : retryIntegration
            ? '사용자가 기존 승인 범위의 완료 커밋 통합 재시도를 요청했습니다. 현재 Git 잠금과 변경 상태를 확인하고 보존된 결과만 통합하세요.'
            : '사용자가 카드에서 기존 승인 범위의 작업 재개를 요청했습니다. 현재 카드, 최근 대화, 할당된 작업공간과 변경을 확인하세요. 완료된 작업이나 외부 처리는 반복하지 말고 미완료 부분만 이어가세요. 기준이나 범위가 바뀌었다면 변경안을 제안하세요.' } : {}),
          ...(kind === 'supersede' ? { replacementDelegationId: replacementId, confirmSupersededByCompletedDelegation: true } : {}),
        }
      if (kind === 'recover' && retryIntegration) {
        const result = await submitIntegrationRecovery(item, body, request)
        if (mounted.current) {
          const failed = result.delegation?.integrationRecoveryRequest?.status === 'failed'
          setFeedback(current => ({ ...current, [item.id]: { error: failed, message: result.message } }))
          if (failed) setError(result.message); else setNotice(result.message)
        }
        return
      } else {
        await request(`/api/maps/${encodeURIComponent(parentMapId)}/ai-delegations/${encodeURIComponent(item.id)}/${kind}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (mounted.current) setFeedback(current => ({ ...current, [item.id]: { message: '요청을 처리했습니다. 최신 위임 상태를 확인하세요.' } }))
      }
      if (mounted.current) setNotice(kind === 'refresh' ? '기존 실행 상태를 확인했습니다.'
        : kind === 'recover' ? correctResult ? '원 담당자의 통합 대기 결과 정정을 접수했습니다.' : retryIntegration ? '완료된 커밋의 통합 재시도를 접수했습니다.' : '기존 작업의 재개를 접수했습니다.'
          : kind === 'retry-report' ? '완료 결과의 재전달을 접수했습니다.'
            : '후속 성공 위임과 연결해 종료했습니다.')
    } catch (reason) {
      if (mounted.current) {
        const message = reason instanceof Error ? reason.message : '복구 요청 실패'
        setError(message)
        setFeedback(current => ({ ...current, [item.id]: { error: true, message } }))
      }
    } finally {
      if (mounted.current) {
        try { await refresh() } catch { /* 작업 오류 메시지를 보존한다. */ }
        setBusy(false)
      }
      acting.current = false
    }
  }

  async function closeRequest(item: Delegation) {
    if (acting.current || !requestCloseDraft || requestCloseDraft.id !== item.id || requestCloseDraft.note.trim().length < 3) return
    acting.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await request<{ message: string }>(`/api/maps/${encodeURIComponent(item.parentMapId ?? item.mapId)}/ai-delegation-request-failures/${encodeURIComponent(item.id)}/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          expectedUpdatedAt: requestCloseDraft.expectedUpdatedAt, reason: requestCloseDraft.reason,
          note: requestCloseDraft.note.trim(), confirmNotExecuted: true,
        }),
      })
      if (mounted.current) { setRequestCloseDraft(null); setNotice(result.message) }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '미접수 요청을 종료하지 못했습니다.')
    } finally {
      if (mounted.current) {
        try { await refresh() } catch { /* 원 요청과 종료 입력을 보존한다. */ }
        setBusy(false)
      }
      acting.current = false
    }
  }

  async function closeDelegation(item: Delegation) {
    if (acting.current || !closeDraft || closeDraft.id !== item.id || closeDraft.note.trim().length < 3) return
    if (!window.confirm(item.closure?.quarantinedRelease
      ? '격리된 작업공간을 반환할까요? 원 작업 브랜치의 체크포인트와 실패 이력은 Git 참조와 기록으로 보존합니다. 결과를 main에 통합하거나 AI를 다시 실행하지 않으며, 미커밋 변경이 있으면 반환하지 않습니다.'
      : item.closure?.workspaceReleaseRequired
      ? '이 위임의 통합을 종료하고 작업공간을 반환할까요? 원본 커밋·부분 통합 후보·실패 이력은 보존합니다. 업무를 완료 처리하거나 결과를 main에 통합하지 않으며 다른 위임은 유지합니다.'
      : '이 위임을 완료 처리하거나 결과를 전달하지 않고 사용자 종료 상태로 전환합니다. 카드·코드·작업공간과 실행 이력은 그대로 보존됩니다. 계속할까요?')) return
    acting.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      const parentMapId = item.parentMapId ?? item.mapId
      const [parent, target] = await Promise.all([
        request<{ map: { version: number } }>(`/api/maps/${encodeURIComponent(parentMapId)}`),
        request<{ map: { version: number } }>(`/api/maps/${encodeURIComponent(item.mapId)}`),
      ])
      await request(`/api/maps/${encodeURIComponent(parentMapId)}/ai-delegations/${encodeURIComponent(item.id)}/close`, {
        // 결과 보존 반환은 작업공간 Git 검증 때문에 오래 걸릴 수 있다. 서버 저장 기한(60초)보다 길게 기다려 실제 결과를 받는다.
        ...(item.closure?.workspaceReleaseRequired ? { signal: AbortSignal.timeout(120_000) } : {}),
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          expectedUpdatedAt: item.updatedAt, sourceRevision: parent.map.version, targetRevision: target.map.version,
          reason: closeDraft.reason, note: closeDraft.note.trim(),
          confirmClosedWithoutCompletion: true, confirmResultReportDiscarded: true,
          ...(item.closure?.workspaceReleaseRequired ? { confirmPreserveWorkspaceResult: true } : {}),
        }),
      })
      if (mounted.current) {
        setCloseDraft(null)
        setNotice(item.closure?.workspaceReleaseRequired
          ? '결과를 보존하고 작업공간을 반환했습니다. 업무 완료나 결과 전달로 기록하지 않았습니다.'
          : '완료나 결과 전달로 기록하지 않고 사용자 종료 상태로 전환했습니다.')
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'AI 위임을 종료하지 못했습니다.'
      // 작업공간 반환이 먼저 저장됐는데 응답이 끊긴 경우 서버가 반환 기록으로 위임 종료를 곧 대사한다.
      if (mounted.current) setError(item.closure?.workspaceReleaseRequired
        ? `${message} 작업공간 반환이 이미 저장됐다면 잠시 뒤 자동으로 종료 처리됩니다. 상태가 바뀌지 않으면 같은 버튼을 다시 눌러 주세요.`
        : message)
    } finally {
      if (mounted.current) {
        try { await refresh() } catch { /* 작업 오류 메시지를 보존한다. */ }
        setBusy(false)
      }
      acting.current = false
    }
  }

  const { currentItems: pending, completedHistory } = useMemo(() => aiDelegationDisplaySections(items), [items])
  const recoveryCount = pending.filter((item) => aiDelegationRequiresRecovery(item) || item.recovery?.reportRetryAvailable).length
  const requestFailureCount = pending.filter(item => item.kind === 'request-failure').length
  const incompleteTaskCount = pending.filter(item => item.kind === 'task-attention').length
  const activeCount = pending.length - recoveryCount - requestFailureCount - incompleteTaskCount
  const sectionTitle = !pending.length && requestHistory.length ? 'AI 위임 처리 이력' : requestFailureCount || incompleteTaskCount ? 'AI 위임 현황 및 확인 사항' : recoveryCount > 0
    ? activeCount > 0 ? 'AI 위임 현황 및 복구' : 'AI 작업 복구'
    : 'AI 위임 진행 현황'
  const sectionCount = [
    activeCount > 0 ? `진행 중 ${activeCount}건` : '',
    recoveryCount > 0 ? `복구 필요 ${recoveryCount}건` : '',
    requestFailureCount > 0 ? `접수 실패 ${requestFailureCount}건` : '',
    incompleteTaskCount > 0 ? `업무 확인 ${incompleteTaskCount}개 카드` : '',
  ].filter(Boolean).join(' · ') || '상태 확인'
  const sectionSummary = !pending.length && requestHistory.length ? '현재 접수 실패 경고는 없습니다. 과거 실패·재접수 확인·사용자 종료 이력을 펼쳐 볼 수 있습니다.' : requestFailureCount || incompleteTaskCount
    ? '현재 위임·접수 실패와 카드 단위 확인 사항을 표시합니다. 단계별 실행 완료는 카드 전체 완료를 뜻하지 않으며, 완료 이력은 아래에서 펼쳐 볼 수 있습니다. 자동 재실행하지 않습니다.'
    : recoveryCount > 0
    ? activeCount > 0
      ? '진행 중인 AI 위임과 복구가 필요한 작업을 확인하고, 가능한 후속 조치를 할 수 있습니다.'
      : '복구가 필요한 위임의 오류를 확인하고, 가능한 작업 재개·통합 재시도·결과 전달을 진행할 수 있습니다.'
    : '진행 중인 AI 위임의 현재 상태를 확인할 수 있습니다.'
  useEffect(() => {
    const preview = previewedItem.current
    if (!preview) return
    const visibleItems = preview.history ? [...(historyOpen ? completedHistory : []), ...(requestHistoryOpen ? requestHistory : [])] : pending
    if (visibleItems.some(item => item.id === preview.id)) return
    previewedItem.current = null
    onPreviewCards(null)
  }, [onPreviewCards, historyOpen, pending, completedHistory, requestHistoryOpen, requestHistory])
  useEffect(() => {
    if (!focusRequestId || (!loaded && !error && !notice)) return
    const frame = window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ block: 'start' })
      sectionRef.current?.focus({ preventScroll: true })
      onFocusHandled?.(focusRequestId)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [error, focusRequestId, loaded, notice, onFocusHandled, pending.length])
  if (!pending.length && !requestHistory.length && !error && !notice) return null
  const renderItem = (item: Delegation, history = false) => {
      const cardAttention = item.kind === 'task-attention'
      const requestFailure = item.kind === 'request-failure'
      const candidates = history || cardAttention || requestFailure ? [] : completedReplacementDelegations(item, items)
      const replacement = item.retryVerification?.replacement
      const selectedReplacementId = replacementIds[item.id] ?? candidates[0]?.id ?? ''
      const closing = closeDraft?.id === item.id
      const retryIntegration = item.recovery?.recommendedAction === 'retry-integration'
      const correctResult = item.recovery?.recommendedAction === 'correct-integration-result'
      const checking = integrationRecoveryPending(item)
      const unconfirmed = integrationRecoveryUnconfirmed(item)
      const actionFeedback = item.integrationRecoveryRequest?.status === 'failed'
        ? { error: true, message: `이전 복구 시도 (${item.integrationRecoveryRequest.completedAt || item.integrationRecoveryRequest.requestedAt}): ${item.integrationRecoveryRequest.message} 현재 Git 상태를 실시간 확인한 결과는 아닙니다.` }
        : checking ? { message: item.integrationRecoveryRequest!.message }
          : unconfirmed ? { message: '접수 여부를 확인 중입니다. 다시 실행하지 않고 상태를 조회합니다.' } : feedback[item.id]
      const errorDetail = cardAttention ? '' : (requestFailure ? `${item.reasonCode}: ${item.message}` : '') || item.recoveryDispatchError || item.childError || item.workspaceError || item.workspaceResult?.error || item.integrationError || item.parentError
      return <div
        className={`ai-delegation-recovery-item${history ? ' ai-delegation-history-item' : ''}`}
        key={item.id}
        onMouseEnter={() => {
          previewedItem.current = { id: item.id, history }
          onPreviewCards({
            parent: { mapId: item.parentMapId ?? item.mapId, cardId: item.parentCardId },
            target: { mapId: item.mapId, cardId: item.targetCardId },
          })
        }}
        onMouseLeave={() => {
          if (previewedItem.current?.id !== item.id || previewedItem.current.history !== history) return
          previewedItem.current = null
          onPreviewCards(null)
        }}
      >
        <button
          type="button"
          className="ai-delegation-recovery-item-select"
          aria-label={`${item.targetCardLabel || item.targetCardId} 카드 선택`}
          title={`${item.targetCardLabel || item.targetCardId} 카드 선택`}
          onClick={() => onSelectCard(item.mapId, item.targetCardId)}
        />
        <div className="ai-delegation-recovery-item-heading">
          <div>
            <b>{item.targetCardLabel || item.targetCardId}</b>
            {!requestFailure && <small className="ai-delegation-recovery-id" title={item.id}>{cardAttention ? `완료된 실행 ${item.completedExecutionCount}건 · 카드 단위 확인` : item.id}</small>}
          </div>
          <span>{requestFailure && item.requestClosure ? '사용자 종료 · 미실행' : requestFailure && history ? '재접수 확인 · 경고 해제' : history ? item.reportStatus === 'received' ? 'AI 실행 종료 · 결과 수신 완료' : 'AI 실행 종료' : groupDelegationPresentation(item).label}</span>
        </div>
        {(history || requestFailure) && <small className="ai-delegation-history-date">{requestFailure ? '접수 실패: ' : ''}{new Date(item.createdAt).toLocaleString('ko-KR')}</small>}
        {history && item.instructionPreview && <p className="ai-delegation-history-instruction">{item.instructionPreview}</p>}
        {requestFailure ? <>
          <p className="ai-delegation-history-instruction">{item.requestSummary || '업무 요약이 없는 요청입니다. 요청 시각과 실패 사유를 확인하세요.'}</p>
          <p className="ai-delegation-recovery-guidance">{item.retryVerification?.message || '서버 기록으로 재접수 여부를 확인하세요. 확인되지 않은 요청은 자동 실행하지 않습니다.'}</p>
          {item.requestClosure && <p className="ai-delegation-history-instruction">종료: {new Date(item.requestClosure.at).toLocaleString('ko-KR')} · {requestCloseReasonLabels[item.requestClosure.reason]}<br />{item.requestClosure.note}</p>}
          {replacement && <p className="ai-delegation-history-instruction">후속 접수: {new Date(replacement.createdAt).toLocaleString('ko-KR')} · {groupDelegationPresentation({ ...item, ...replacement, kind: undefined } as Delegation).label}<br />{replacement.instructionPreview || '후속 요청 요약 없음'}</p>}
          <details className="ai-delegation-technical"><summary>기술 정보</summary><p>실패 기록: {item.id}<br />요청: {item.requestedDelegationId}{item.resolvedByDelegationId && <><br />재접수: {item.resolvedByDelegationId}</>}{item.requestClosure && <><br />종료 처리 계정: {item.requestClosure.actorId}</>}</p></details>
        </> : groupDelegationReportHint(item) && <p className="ai-delegation-recovery-guidance">{groupDelegationReportHint(item)}</p>}
        {!history && item.recovery?.blockedReasonCode && <p className="ai-delegation-recovery-guidance">현재 차단 사유: {item.recovery.message}</p>}
        {errorDetail && <p className="ai-delegation-recovery-error-detail">{errorDetail}</p>}
        {!history && actionFeedback && <p className="ai-delegation-action-feedback" role={actionFeedback.error ? 'alert' : 'status'}>{actionFeedback.message}</p>}
        {candidates.length > 1 && <label className="ai-delegation-replacement">
          <span>완료된 후속 위임</span>
          <select disabled={busy} value={selectedReplacementId} onChange={(event) => setReplacementIds((current) => ({ ...current, [item.id]: event.target.value }))}>
            {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}
          </select>
        </label>}
        {requestFailure && <>
          <div className="ai-delegation-recovery-actions">
            {!history && <button type="button" {...actionAccessibility('재접수 확인', actionHints.checkRequest)} disabled={busy} onClick={() => void action(item, 'check-request')}>재접수 확인</button>}
            {!history && item.phase === 'preflight' && item.executionState === 'not-started' && item.accepted === false && <button type="button" className="danger" title="미접수 요청의 종료 사유를 입력합니다. AI 실행이나 업무 완료 처리는 하지 않습니다." disabled={busy} onClick={() => setRequestCloseDraft({ id: item.id, reason: 'no-longer-needed', note: '', expectedUpdatedAt: item.updatedAt })}>취소·진행 불필요로 종료</button>}
            <button type="button" onClick={() => onSelectCard(item.mapId, item.targetCardId)}>대상 카드 보기</button>
            {replacement?.targetConversationId && <button type="button" onClick={() => void openConversation(item, replacement.targetConversationId!)}>관련 대화 열기</button>}
          </div>
          {!history && requestCloseDraft?.id === item.id && <div className="ai-delegation-close-form ai-delegation-request-close-form">
            <p>실행되지 않은 접수 실패의 경고만 해제합니다. 업무 완료나 정상 재접수로 처리하지 않으며, 원래 오류와 종료 이력을 보존합니다. 종료 후에는 되돌릴 수 없습니다.</p>
            <label><span>요청 종료 사유</span><select disabled={busy} value={requestCloseDraft.reason} onChange={event => setRequestCloseDraft({ ...requestCloseDraft, reason: event.target.value as RequestCloseReason })}>{Object.entries(requestCloseReasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>종료 메모</span><textarea disabled={busy} maxLength={1000} rows={3} value={requestCloseDraft.note} placeholder="더 이상 재접수하지 않는 이유를 남겨 주세요. 비밀값은 입력하지 마세요." onChange={event => setRequestCloseDraft({ ...requestCloseDraft, note: event.target.value })} /></label>
            <div className="ai-delegation-recovery-actions">
              <button type="button" disabled={busy} onClick={() => setRequestCloseDraft(null)}>입력 취소</button>
              <button type="button" className="danger" disabled={busy || requestCloseDraft.note.trim().length < 3} onClick={() => void closeRequest(item)}>미접수 요청 종료 확정</button>
            </div>
          </div>}
        </>}
        {!history && !cardAttention && closing ? <div className="ai-delegation-close-form">
          {item.closure?.workspaceReleaseRequired && <p>{item.closure.quarantinedRelease
            ? '원 작업 브랜치의 체크포인트와 실패 이력을 보존하고 격리된 작업공간만 반환합니다. main 반영·AI 재실행·업무 완료 처리는 하지 않으며, 대화가 실행 중이거나 미커밋 변경이 있으면 반환하지 않습니다.'
            : '원본 커밋·부분 통합 결과·실패 이력을 보존하고 작업공간을 반환합니다. main 반영이나 업무 완료 처리는 하지 않습니다.'}</p>}
          <label><span>종료 사유</span><select disabled={busy} value={closeDraft.reason} onChange={(event) => setCloseDraft({ ...closeDraft, reason: event.target.value as CloseReason })}>{Object.entries(closeReasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>감사 메모</span><textarea disabled={busy} maxLength={1000} rows={3} value={closeDraft.note} placeholder="복구하거나 결과를 보고하지 않고 종료하는 이유를 남겨 주세요." onChange={(event) => setCloseDraft({ ...closeDraft, note: event.target.value })} /></label>
          <div className="ai-delegation-recovery-actions">
            <button type="button" {...actionAccessibility('취소', actionHints.cancelClose)} disabled={busy} onClick={() => setCloseDraft(null)}>취소</button>
            <button type="button" {...actionAccessibility('보고하지 않고 종료', item.closure?.workspaceReleaseRequired ? '결과와 실패 이력을 보존하고 작업공간만 반환합니다. main 통합·업무 완료·후속 AI 중지는 하지 않습니다.' : actionHints.confirmClose)} className="danger" disabled={busy || closeDraft.note.trim().length < 3} onClick={() => void closeDelegation(item)}>보고하지 않고 종료</button>
          </div>
        </div> : !history && !cardAttention && !requestFailure && <div className="ai-delegation-recovery-actions">
          <button type="button" {...actionAccessibility('상태 다시 확인', actionHints.refresh)} disabled={busy} onClick={() => void action(item, 'refresh')}>상태 다시 확인</button>
          {unconfirmed && <button type="button" title="새 요청 ID를 만들지 않고 이전에 승인한 동일 요청의 접수 여부를 재확인합니다." disabled={busy} onClick={() => void action(item, 'recheck-integration')}>동일 요청 재확인</button>}
          {item.recovery?.recoveryAvailable && <button type="button" {...actionAccessibility(correctResult ? '통합 대기 결과 정정' : retryIntegration ? '통합 재시도' : '기존 작업 재개', correctResult ? actionHints.correctResult : retryIntegration ? actionHints.retryIntegration : actionHints.recover)} disabled={busy || checking || unconfirmed} onClick={() => void action(item, 'recover')}>{correctResult ? '통합 대기 결과 정정' : retryIntegration ? '통합 재시도' : '기존 작업 재개'}</button>}
          {item.recovery?.reportRetryAvailable && <button type="button" {...actionAccessibility('결과 전달 재시도', actionHints.retryReport)} disabled={busy} onClick={() => void action(item, 'retry-report')}>결과 전달 재시도</button>}
          {candidates.length > 0 && <button type="button" {...actionAccessibility('후속 성공으로 종료', actionHints.supersede)} disabled={busy} onClick={() => void action(item, 'supersede')}>후속 성공으로 종료</button>}
          {item.closure?.closeAvailable && <button type="button" {...actionAccessibility(item.closure.workspaceReleaseRequired ? '결과 보존 후 반환' : '보고하지 않고 종료', item.closure.workspaceReleaseRequired ? '보존 반환 사유 입력 창을 엽니다. 마지막 확인 전에는 작업공간을 변경하지 않습니다.' : actionHints.openClose)} className="danger" disabled={busy} onClick={() => setCloseDraft({ id: item.id, reason: item.workCompleted ? 'result-invalidated' : 'no-longer-needed', note: '' })}>{item.closure.workspaceReleaseRequired ? '결과 보존 후 반환' : '보고하지 않고 종료'}</button>}
        </div>}
        {!history && !cardAttention && item.closure?.reason === 'workspace-changes-preserved' && <p className="ai-delegation-recovery-guidance">보존할 작업공간 변경이 있어 종료할 수 없습니다. 기존 변경을 보존한 채 작업공간을 먼저 복구하세요.</p>}
      </div>
  }
  return <section ref={sectionRef} className="ai-delegation-recovery" aria-label={sectionTitle} tabIndex={-1}>
    <div className="ai-delegation-recovery-heading">
      <strong>{sectionTitle}</strong>
      <small>{sectionCount}</small>
    </div>
    <p className="ai-delegation-recovery-summary">{sectionSummary}</p>
    {pending.map(item => renderItem(item))}
    {requestHistory.length > 0 && <details className="ai-delegation-request-history ai-delegation-completed-history" open={requestHistoryOpen} onToggle={event => setRequestHistoryOpen(event.currentTarget.open)}>
      <summary>처리된 요청 이력 {requestHistory.length}건</summary>
      {requestHistoryOpen && requestHistory.map(item => renderItem(item, true))}
    </details>}
    {completedHistory.length > 0 && <details key={`${mapId}:${cardId}`} className="ai-delegation-completed-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary>완료된 실행 이력 {completedHistory.length}건</summary>
      {historyOpen && <>
        <p className="ai-delegation-recovery-summary">단계별 실행 이력입니다. 카드 전체 업무의 완료·품질 검증과 구분하며, 이력 열람은 AI를 실행하지 않습니다.</p>
        {completedHistory.map(item => renderItem(item, true))}
      </>}
    </details>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
