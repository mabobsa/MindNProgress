import { useEffect, useState } from 'react'
import type { DoorayResponseJob, useDoorayResponses } from './useDoorayResponses'
import type { DoorayHandoffLaunch } from './DoorayResponseHandoff'

type Target = { mapId: string; cardId: string; documentTitle: string; cardTitle: string; version: number }
type Preview = { target: Target; request: string; fingerprint: string; sourceConversationId: string }

export function DoorayExecutionHandoff({ job, response, onLaunchCard, onClose }: {
  job: DoorayResponseJob; response: ReturnType<typeof useDoorayResponses>
  onLaunchCard: (launch: DoorayHandoffLaunch) => void; onClose: () => void
}) {
  const [targets, setTargets] = useState<Target[]>([])
  const [mapId, setMapId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const { requestJson, load } = response
  const endpoint = `/api/integrations/dooray/mentions/responses/${encodeURIComponent(job.id)}/execution-handoff`
  const pending = job.approval?.handoffs?.find((entry) => !entry.conversation)
  useEffect(() => {
    let active = true
    setLoading(true); setPreview(null); setConfirmed(false); setError('')
    void requestJson<{ targets: Target[]; preview?: Preview }>(`${endpoint}${mapId ? `?mapId=${encodeURIComponent(mapId)}` : ''}`)
      .then((result) => { if (active) { setTargets(result.targets); setPreview(result.preview ?? null) } })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : '인계 정보를 읽지 못했습니다.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [endpoint, mapId, requestJson, reload])

  const launch = async () => {
    setSending(true); setError('')
    try {
      const result = pending
        ? await requestJson<{ launch: DoorayHandoffLaunch }>(`/api/integrations/dooray/response-approvals/${encodeURIComponent(job.id)}?${new URLSearchParams({ revision: job.proposalRevision!, handoffId: pending.id })}`)
        : await requestJson<{ launch: DoorayHandoffLaunch }>(endpoint, { method: 'POST', body: JSON.stringify({
          mapId, fingerprint: preview?.fingerprint, proposalRevision: job.proposalRevision, confirmApprovedScope: confirmed,
        }) })
      await load()
      onLaunchCard(result.launch)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '인계 대화 준비에 실패했습니다.') }
    finally { setSending(false) }
  }
  return <section className="dooray-response-handoff" aria-label="승인 작업 상위 카드 인계">
    <div className="dooray-response-heading"><strong>새 문서의 상위 카드에서 이어가기</strong><button type="button" disabled={sending} onClick={onClose}>닫기</button></div>
    <p>선택한 문서의 원본 루트에서 새 대화를 시작합니다. 기존 대화의 소속과 위임 범위는 변경하지 않습니다. 인계는 기존 승인 범위만 유지하며 추가 작업을 승인하지 않습니다.</p>
    {pending ? <p>준비된 대상: {pending.target.documentTitle} → {pending.target.cardTitle}</p>
      : <label>인계할 문서<select value={mapId} disabled={sending} onChange={(event) => setMapId(event.target.value)}>
        <option value="">문서의 상위 카드를 선택해 주세요</option>
        {targets.map((target) => <option key={target.mapId} value={target.mapId}>{target.documentTitle} → {target.cardTitle}</option>)}
      </select></label>}
    {loading && <p role="status">인계 대상과 대화 전문을 확인하는 중…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setReload((value) => value + 1)}>다시 확인</button></p>}
    {preview && !pending && <>
      <p>시작 카드: {preview.target.documentTitle} → {preview.target.cardTitle}</p>
      <details><summary>승인 근거와 전달할 대화 전문 확인</summary><pre className="dooray-response-proposal">{preview.request}</pre></details>
      <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />인계 대상·전문과 기존 승인 범위를 확인했습니다.</label>
    </>}
    <button type="button" disabled={sending || (!pending && (loading || !preview || !confirmed))} onClick={() => void launch()}>
      {sending ? '인계 준비 중…' : pending ? '준비한 인계 대화 시작' : '확인한 상위 카드에서 AI 대화 시작'}
    </button>
  </section>
}
