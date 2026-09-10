import { useEffect, useState } from 'react'
import type { AiConversationExplicitTarget } from '../utils/aiConversationLaunch.mjs'
import type { DoorayResponseJob, useDoorayResponses } from './useDoorayResponses'

export type DoorayHandoffLaunch = AiConversationExplicitTarget & { initialRequest: string }
type Handoff = {
  route: NonNullable<DoorayResponseJob['route']>
  prompt: string
  conversations: { conversationId: string; name: string; idle: boolean; available: boolean; homeMachineRole: 'main' | 'sub' }[]
  handedOffAt: string | null
  handoffConversationId: string | null
}

export function DoorayResponseHandoff({ job, response, onLaunchCard, onOpenConversation, onClose }: {
  job: DoorayResponseJob
  response: ReturnType<typeof useDoorayResponses>
  onLaunchCard: (launch: DoorayHandoffLaunch) => void
  onOpenConversation: (job: DoorayResponseJob) => void
  onClose: () => void
}) {
  const [data, setData] = useState<Handoff | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [sent, setSent] = useState<{ conversationId: string; homeMachineRole: 'main' | 'sub' } | null>(null)
  const { requestJson, load } = response
  const endpoint = `/api/integrations/dooray/mentions/responses/${encodeURIComponent(job.id)}/handoff`
  useEffect(() => {
    let mounted = true
    void requestJson<Handoff>(endpoint).then((result) => {
      if (!mounted) return
      setData(result)
      setSelected(result.handoffConversationId ?? result.conversations.find((entry) => entry.idle)?.conversationId ?? result.conversations[0]?.conversationId ?? '')
    }).catch((failure: unknown) => { if (mounted) setError(failure instanceof Error ? failure.message : '전달 정보를 불러오지 못했습니다.') })
    return () => { mounted = false }
  }, [endpoint, requestJson])
  const send = async () => {
    setSending(true); setAttempted(true); setError('')
    try {
      setSent(await requestJson(endpoint, { method: 'POST', body: JSON.stringify({ conversationId: selected }) }))
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '전달에 실패했습니다. 같은 버튼으로 전송 상태를 확인해 주세요.') }
    finally { setSending(false) }
  }
  return <section className="dooray-response-handoff" aria-label="담당 카드로 전달">
    <div className="dooray-response-heading"><strong>담당 카드로 전달하기</strong><button type="button" disabled={sending} onClick={onClose}>닫기</button></div>
    <p>Dooray 본문·코멘트 URL과 제안 전문을 전달합니다. 담당 AI는 최신 상황을 확인해 다시 제안하며, 작업 실행은 승인하지 않습니다.</p>
    {error && <p role="alert" className="dooray-response-error">{error}</p>}
    {!data && !error && <p role="status">담당 카드의 대화를 확인하는 중…</p>}
    {data && <>
      <details><summary>전달할 전문 확인</summary><pre className="dooray-response-proposal">{data.prompt}</pre></details>
      {data.conversations.length > 0 ? <label>전달할 담당 대화<select value={selected} disabled={attempted || Boolean(data.handoffConversationId)} onChange={(event) => setSelected(event.target.value)}>
        {data.conversations.map((entry) => <option key={entry.conversationId} value={entry.conversationId}>{entry.name}{entry.idle ? '' : ' · 실행 중'}</option>)}
      </select></label> : <p>연결된 업무 대화가 없습니다. 담당 카드에 새 AI 대화를 열어 전달할 수 있습니다.</p>}
      <div className="dooray-response-actions">
        {sent ? <><span role="status">전달했습니다. 새 제안은 담당 대화에서 확인해 주세요.</span><button type="button" onClick={() => onOpenConversation({ ...job, ...sent })}>전달한 대화 열기</button></>
          : <>
            {selected && <button type="button" disabled={sending} onClick={() => void send()}>{sending ? '전달 상태 확인 중…' : '선택한 대화로 전달'}</button>}
            <button type="button" disabled={attempted || Boolean(data.handoffConversationId)} onClick={() => onLaunchCard({ purpose: 'card', mapId: data.route.mapId, cardId: data.route.cardId,
              documentTitle: data.route.documentTitle, cardTitle: data.route.cardTitle, initialRequest: data.prompt, fullInitialRequest: true })}>담당 카드에 새 AI 대화</button>
          </>}
      </div>
    </>}
  </section>
}
