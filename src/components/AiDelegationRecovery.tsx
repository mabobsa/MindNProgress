import { useCallback, useEffect, useRef, useState } from 'react'
import { completedReplacementDelegations, type AiDelegationSummary } from '../utils/aiDelegationManagement.mjs'
import { groupDelegationPresentation, type GroupDelegation } from '../utils/groupOverview.mjs'
import './AiDelegationRecovery.css'

type Delegation = GroupDelegation & AiDelegationSummary & {
  recoveryDispatchError?: string
}

type CloseReason = 'result-invalidated' | 'conversation-removed' | 'no-longer-needed'

const closeReasonLabels: Record<CloseReason, string> = {
  'result-invalidated': '결과가 되돌려졌거나 더 이상 유효하지 않음',
  'conversation-removed': '실행 또는 상위 대화가 삭제됨',
  'no-longer-needed': '재개나 결과 보고가 더 이상 필요하지 않음',
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, signal: init?.signal ?? AbortSignal.timeout(65_000) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? 'AI 작업 상태를 확인하지 못했습니다.')
  return body as T
}

export function AiDelegationRecovery({ mapId, cardId }: { mapId: string; cardId: string }) {
  const [items, setItems] = useState<Delegation[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [replacementIds, setReplacementIds] = useState<Record<string, string>>({})
  const [closeDraft, setCloseDraft] = useState<{ id: string; reason: CloseReason; note: string } | null>(null)
  const mounted = useRef(true)
  const acting = useRef(false)
  const listUrl = `/api/maps/${encodeURIComponent(mapId)}/ai-delegations`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const data = await request<{ delegations: Delegation[] }>(listUrl, { signal })
    const relevant = data.delegations.filter((item) =>
      item.mapId === mapId && item.targetCardId === cardId
      || (item.parentMapId ?? item.mapId) === mapId && item.parentCardId === cardId)
    if (mounted.current) setItems(relevant)
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

  async function action(item: Delegation, kind: 'refresh' | 'recover' | 'retry-report' | 'supersede') {
    if (acting.current) return
    const candidates = completedReplacementDelegations(item, items)
    const replacementId = replacementIds[item.id] ?? candidates[0]?.id
    if (kind === 'supersede' && !replacementId) return
    const confirmation = kind === 'recover'
      ? '중단 원인이 해소되었고 기존 승인 범위에서 작업을 이어갈까요? 현재 변경을 확인하고 남은 작업만 같은 AI 대화에서 진행합니다.'
      : kind === 'retry-report'
        ? '하위 작업을 재실행하지 않고 저장된 결과를 상위 AI에 다시 전달할까요? 상위 AI가 결과 검토를 위해 실행됩니다.'
        : kind === 'supersede'
          ? `이 위임을 완료 처리하지 않고 후속 성공 위임 ${replacementId}으로 대체됐다는 이력을 남겨 종료할까요?`
          : ''
    if (confirmation && !window.confirm(confirmation)) return
    acting.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      const parentMapId = item.parentMapId ?? item.mapId
      const [parent, target, group] = await Promise.all([
        request<{ map: { version: number } }>(`/api/maps/${encodeURIComponent(parentMapId)}`),
        request<{ map: { version: number } }>(`/api/maps/${encodeURIComponent(item.mapId)}`),
        item.groupId ? request<{ project: { version: number } }>(`/api/groups/${encodeURIComponent(item.groupId)}`) : Promise.resolve(null),
      ])
      await request(`/api/maps/${encodeURIComponent(parentMapId)}/ai-delegations/${encodeURIComponent(item.id)}/${kind}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          expectedUpdatedAt: item.updatedAt, sourceRevision: parent.map.version, targetRevision: target.map.version,
          ...(group ? { groupVersion: group.project.version } : {}),
          confirmApprovedScope: kind === 'recover' || kind === 'retry-report',
          ...(kind === 'recover' ? { instruction: '사용자가 카드에서 기존 승인 범위의 작업 재개를 요청했습니다. 현재 카드, 최근 대화, 할당된 작업공간과 변경을 확인하세요. 완료된 작업이나 외부 처리는 반복하지 말고 미완료 부분만 이어가세요. 기준이나 범위가 바뀌었다면 변경안을 제안하세요.' } : {}),
          ...(kind === 'supersede' ? { replacementDelegationId: replacementId, confirmSupersededByCompletedDelegation: true } : {}),
        }),
      })
      if (mounted.current) setNotice(kind === 'refresh' ? '기존 실행 상태를 확인했습니다.'
        : kind === 'recover' ? '기존 작업의 재개를 접수했습니다.'
          : kind === 'retry-report' ? '완료 결과의 재전달을 접수했습니다.'
            : '후속 성공 위임과 연결해 종료했습니다.')
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '복구 요청 실패')
    } finally {
      if (mounted.current) {
        try { await refresh() } catch { /* 작업 오류 메시지를 보존한다. */ }
        setBusy(false)
      }
      acting.current = false
    }
  }

  async function closeDelegation(item: Delegation) {
    if (acting.current || !closeDraft || closeDraft.id !== item.id || closeDraft.note.trim().length < 3) return
    if (!window.confirm('이 위임을 완료 처리하거나 결과를 전달하지 않고 사용자 종료 상태로 전환합니다. 카드·코드·작업공간과 실행 이력은 그대로 보존됩니다. 계속할까요?')) return
    acting.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      const parentMapId = item.parentMapId ?? item.mapId
      const [parent, target] = await Promise.all([
        request<{ map: { version: number } }>(`/api/maps/${encodeURIComponent(parentMapId)}`),
        request<{ map: { version: number } }>(`/api/maps/${encodeURIComponent(item.mapId)}`),
      ])
      await request(`/api/maps/${encodeURIComponent(parentMapId)}/ai-delegations/${encodeURIComponent(item.id)}/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          expectedUpdatedAt: item.updatedAt, sourceRevision: parent.map.version, targetRevision: target.map.version,
          reason: closeDraft.reason, note: closeDraft.note.trim(),
          confirmClosedWithoutCompletion: true, confirmResultReportDiscarded: true,
        }),
      })
      if (mounted.current) {
        setCloseDraft(null)
        setNotice('완료나 결과 전달로 기록하지 않고 사용자 종료 상태로 전환했습니다.')
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'AI 위임을 종료하지 못했습니다.')
    } finally {
      if (mounted.current) {
        try { await refresh() } catch { /* 작업 오류 메시지를 보존한다. */ }
        setBusy(false)
      }
      acting.current = false
    }
  }

  const pending = items.filter((item) => !['completed', 'failed', 'superseded', 'closed'].includes(item.state))
  if (!pending.length && !error && !notice) return null
  return <section className="ai-delegation-recovery" aria-label="AI 작업 복구">
    <div className="ai-delegation-recovery-heading">
      <strong>AI 작업 복구</strong>
      <small>{pending.length ? `미종료 위임 ${pending.length}건` : '상태 확인'}</small>
    </div>
    <p className="ai-delegation-recovery-summary">중단 작업을 이어가거나, 복구할 수 없는 기록을 완료로 표시하지 않고 정리할 수 있습니다.</p>
    {pending.map((item) => {
      const candidates = completedReplacementDelegations(item, items)
      const selectedReplacementId = replacementIds[item.id] ?? candidates[0]?.id ?? ''
      const closing = closeDraft?.id === item.id
      return <div className="ai-delegation-recovery-item" key={item.id}>
        <div className="ai-delegation-recovery-item-heading">
          <div>
            <b>{item.targetCardLabel}</b>
            <small className="ai-delegation-recovery-id" title={item.id}>{item.id}</small>
          </div>
          <span>{groupDelegationPresentation(item).label}</span>
        </div>
        {(item.recoveryDispatchError || item.childError || item.parentError) && <p className="ai-delegation-recovery-error-detail">{item.recoveryDispatchError || item.childError || item.parentError}</p>}
        {candidates.length > 1 && <label className="ai-delegation-replacement">
          <span>완료된 후속 위임</span>
          <select disabled={busy} value={selectedReplacementId} onChange={(event) => setReplacementIds((current) => ({ ...current, [item.id]: event.target.value }))}>
            {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}
          </select>
        </label>}
        {closing ? <div className="ai-delegation-close-form">
          <label><span>종료 사유</span><select disabled={busy} value={closeDraft.reason} onChange={(event) => setCloseDraft({ ...closeDraft, reason: event.target.value as CloseReason })}>{Object.entries(closeReasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>감사 메모</span><textarea disabled={busy} maxLength={1000} rows={3} value={closeDraft.note} placeholder="복구하거나 결과를 보고하지 않고 종료하는 이유를 남겨 주세요." onChange={(event) => setCloseDraft({ ...closeDraft, note: event.target.value })} /></label>
          <div className="ai-delegation-recovery-actions">
            <button disabled={busy} onClick={() => setCloseDraft(null)}>취소</button>
            <button className="danger" disabled={busy || closeDraft.note.trim().length < 3} onClick={() => void closeDelegation(item)}>보고하지 않고 종료</button>
          </div>
        </div> : <div className="ai-delegation-recovery-actions">
          <button disabled={busy} onClick={() => void action(item, 'refresh')}>상태 다시 확인</button>
          {item.recovery?.recoveryAvailable && <button disabled={busy} onClick={() => void action(item, 'recover')}>기존 작업 재개</button>}
          {item.recovery?.reportRetryAvailable && <button disabled={busy} onClick={() => void action(item, 'retry-report')}>결과 전달 재시도</button>}
          {candidates.length > 0 && <button disabled={busy} onClick={() => void action(item, 'supersede')}>후속 성공으로 종료</button>}
          {item.closure?.closeAvailable && <button className="danger" disabled={busy} onClick={() => setCloseDraft({ id: item.id, reason: item.workCompleted ? 'result-invalidated' : 'no-longer-needed', note: '' })}>보고하지 않고 종료</button>}
        </div>}
        {item.closure?.reason === 'workspace-changes-preserved' && <p className="ai-delegation-recovery-guidance">보존할 작업공간 변경이 있어 종료할 수 없습니다. 기존 작업을 재개하거나 작업공간을 먼저 정리하세요.</p>}
      </div>
    })}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
