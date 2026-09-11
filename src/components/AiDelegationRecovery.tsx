import { useCallback, useEffect, useRef, useState } from 'react'
import { groupDelegationPresentation, type GroupDelegation } from '../utils/groupOverview.mjs'
import './AiDelegationRecovery.css'

type Delegation = GroupDelegation & {
  parentMapId?: string
  parentCardId: string
  groupId?: string
  recoveryDispatchError?: string
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

  async function action(item: Delegation, kind: 'refresh' | 'recover' | 'retry-report') {
    if (acting.current) return
    if (kind !== 'refresh' && !window.confirm(kind === 'recover'
      ? '중단 원인이 해소되었고 기존 승인 범위에서 작업을 이어갈까요? 현재 변경을 확인하고 남은 작업만 같은 AI 대화에서 진행합니다.'
      : '하위 작업의 저장된 결과를 상위 AI에 다시 전달할까요? 상위 AI가 결과 검토를 위해 실행됩니다.')) return
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
          ...(group ? { groupVersion: group.project.version } : {}), confirmApprovedScope: kind !== 'refresh',
          ...(kind === 'recover' ? { instruction: '사용자가 카드에서 기존 승인 범위의 작업 재개를 요청했습니다. 현재 카드, 최근 대화, 할당된 작업공간과 변경을 확인하세요. 완료된 작업이나 외부 처리는 반복하지 말고 미완료 부분만 이어가세요. 기준이나 범위가 바뀌었다면 변경안을 제안하세요.' } : {}),
        }),
      })
      if (mounted.current) setNotice(kind === 'refresh' ? '기존 실행 상태를 확인했습니다.' : kind === 'recover' ? '기존 작업의 재개를 접수했습니다.' : '완료 결과의 재전달을 접수했습니다.')
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

  const pending = items.filter((item) => !['completed', 'superseded', 'closed'].includes(item.state))
  if (!pending.length && !error && !notice) return null
  return <section className="ai-delegation-recovery" aria-label="AI 작업 복구">
    <strong>AI 작업 복구</strong>
    <p>중단된 작업은 한도 해제 후 여기서 이어갈 수 있습니다.</p>
    {pending.map((item) => <div className="ai-delegation-recovery-item" key={item.id}>
      <b>{item.targetCardLabel}</b>
      <span>{groupDelegationPresentation(item).label}</span>
      {(item.recoveryDispatchError || item.childError || item.parentError) && <p>{item.recoveryDispatchError || item.childError || item.parentError}</p>}
      <div className="ai-delegation-recovery-actions">
        <button disabled={busy} onClick={() => void action(item, 'refresh')}>상태 다시 확인</button>
        {item.recovery?.recoveryAvailable && <button disabled={busy} onClick={() => void action(item, 'recover')}>기존 작업 재개</button>}
        {item.recovery?.reportRetryAvailable && <button disabled={busy} onClick={() => void action(item, 'retry-report')}>결과 전달 재시도</button>}
      </div>
    </div>)}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
