import { useEffect, useRef, useState } from 'react'
import { availableAiRuntimeOptionId } from '../utils/aiRuntimeSelections.mjs'
import { doorayResponseStatus, type Options, type DoorayResponseJob, type useDoorayResponses } from './useDoorayResponses'
import './DoorayResponseInbox.css'
import { DoorayResponseHandoff, type DoorayHandoffLaunch } from './DoorayResponseHandoff'
import { DoorayResponseDecision } from './DoorayResponseDecision'
import { DoorayExecutionHandoff } from './DoorayExecutionHandoff'

export function DoorayResponseInbox({ response, onOpenConversation, onOpenCard, onLaunchCard }: {
  response: ReturnType<typeof useDoorayResponses>
  onOpenConversation: (job: DoorayResponseJob) => void
  onOpenCard: (mapId: string, cardId: string) => void
  onLaunchCard: (launch: DoorayHandoffLaunch) => void
}) {
  const requestJson = response.requestJson
  const saveSettings = response.saveSettings
  const savedSettings = useRef(response.settings)
  useEffect(() => { savedSettings.current = response.settings }, [response.settings])
  const [options, setOptions] = useState<Options | null>(null)
  const [optionsError, setOptionsError] = useState('')
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [machine, setMachine] = useState(response.settings.machineId ?? '')
  const [hint, setHint] = useState('')
  const [refining, setRefining] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [handoffId, setHandoffId] = useState('')
  const [executionHandoffId, setExecutionHandoffId] = useState('')
  const outstanding = response.jobs.filter((entry) => !entry.completedAt)
  const completed = response.jobs.filter((entry) => entry.completedAt)
  const visibleJobs = response.showCompleted ? completed : outstanding
  const job = visibleJobs.find((entry) => entry.id === response.selectedId) ?? visibleJobs[0]
  const approvalConversation = job?.approval?.conversation
  const executionHandoffs = job?.approval?.handoffs?.filter((entry) => entry.conversation) ?? []
  useEffect(() => { setHint('') }, [job?.id])
  const running = response.jobs.filter((entry) => ['routing', 'reviewing', 'waiting-target'].includes(entry.status)).length
  useEffect(() => {
    if (!settingsOpen) return
    let mounted = true
    setOptionsLoading(true)
    setOptionsError('')
    void requestJson<Options>(`/api/integrations/aionui/options${machine ? `?machineId=${encodeURIComponent(machine)}` : ''}`)
      .then((result) => {
        if (!mounted) return
        setOptions(result)
        const saved = savedSettings.current
        const initial = result.agents.find((entry) => entry.id === saved.agentId && entry.models.length > 0) ?? result.agents.find((entry) => entry.models.length > 0)
        if (initial) saveSettings({ machineId: result.machineId, agentId: initial.id, proposalWorkspace: saved.proposalWorkspace,
          modelId: availableAiRuntimeOptionId(initial.models, saved.modelId, initial.defaultModelId),
          mode: availableAiRuntimeOptionId(initial.modes, saved.mode, initial.defaultMode),
          thoughtLevel: availableAiRuntimeOptionId(initial.thoughtLevels, saved.thoughtLevel, initial.defaultThoughtLevel) })
      })
      .catch((failure: unknown) => { if (mounted) setOptionsError(failure instanceof Error ? failure.message : 'AI 설정을 불러오지 못했습니다.') })
      .finally(() => { if (mounted) setOptionsLoading(false) })
    return () => { mounted = false }
  }, [machine, requestJson, saveSettings, settingsOpen])
  const agent = options?.agents.find((entry) => entry.id === response.settings.agentId) ?? options?.agents[0]
  const chooseAgent = (id: string) => {
    const next = options?.agents.find((entry) => entry.id === id)
    if (!next || !options) return
    response.saveSettings({ machineId: options.machineId, agentId: next.id, proposalWorkspace: response.settings.proposalWorkspace,
      modelId: availableAiRuntimeOptionId(next.models, '', next.defaultModelId),
      mode: availableAiRuntimeOptionId(next.modes, '', next.defaultMode),
      thoughtLevel: availableAiRuntimeOptionId(next.thoughtLevels, '', next.defaultThoughtLevel) })
  }
  return (
    <section className="dooray-response-inbox" aria-label="AI 대응">
      <div className="dooray-response-toolbar">
        <button type="button" aria-expanded={response.open} onClick={() => response.setOpen(!response.open)}>
          AI 대응 {outstanding.length > 0 && `${outstanding.length}건`}{running > 0 && ` · ${running}건 진행 중`}
        </button>
        <span>담당을 찾아 대응안을 제안합니다.</span>
        <button type="button" aria-pressed={response.showCompleted} onClick={() => {
          response.setShowCompleted(!response.showCompleted); response.setSelectedId(''); response.setOpen(true)
        }}>{response.showCompleted ? '미완료 보기' : `완료 내역 ${completed.length}건`}</button>
        <button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>AI 설정</button>
      </div>
      {settingsOpen && <div className="dooray-response-settings">
        {optionsLoading && <span role="status">AI 설정을 불러오는 중…</span>}
        {optionsError && <p role="alert">{optionsError}</p>}
        {options && !optionsLoading && <>
          <label>실행 머신<select value={machine || options.machineId} onChange={(event) => {
            setMachine(event.target.value); response.saveSettings({ machineId: event.target.value }); setOptions(null)
          }}>{options.machines.map((entry) => <option key={entry.machineId} value={entry.machineId}>{entry.label}</option>)}</select></label>
          <label>AI<select value={agent?.id ?? ''} onChange={(event) => chooseAgent(event.target.value)}>
            {options.agents.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select></label>
          {agent && <>
            <label>모델<select value={availableAiRuntimeOptionId(agent.models, response.settings.modelId, agent.defaultModelId)} onChange={(event) => response.saveSettings({ ...response.settings, machineId: options.machineId, agentId: agent.id, modelId: event.target.value })}>
              {agent.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select></label>
            {agent.thoughtLevels.length > 0 && <label>사고 강도<select value={availableAiRuntimeOptionId(agent.thoughtLevels, response.settings.thoughtLevel, agent.defaultThoughtLevel)} onChange={(event) => response.saveSettings({ ...response.settings, machineId: options.machineId, agentId: agent.id, thoughtLevel: event.target.value })}>
              {agent.thoughtLevels.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select></label>}
          </>}
          {options.machineRole === 'sub' && <label className="dooray-response-workspace">서브 머신의 제안 전용 폴더
            <input value={response.settings.proposalWorkspace ?? ''} onChange={(event) => response.saveSettings({ ...response.settings, proposalWorkspace: event.target.value })}
              placeholder="해당 머신에 만든 공통 폴더의 절대 경로" />
          </label>}
        </>}
      </div>}
      {response.error && <p className="dooray-response-error" role="alert">{response.error} <button type="button" onClick={() => void response.load()}>새로고침</button></p>}
      {response.notice && <p className="dooray-response-notice" role="status">{response.notice}</p>}
      {response.open && <div className="dooray-response-detail">
        {response.pendingKeys.size > 0 && <p role="status">선택한 Dooray 원문을 확인하고 AI 요청을 준비하는 중…</p>}
        {visibleJobs.length > 0 ? <>
          <label className="dooray-response-picker">대응 기록<select value={job?.id ?? ''} onChange={(event) => response.setSelectedId(event.target.value)}>
            {visibleJobs.map((entry) => <option key={entry.id} value={entry.id}>{doorayResponseStatus[entry.status] ?? entry.status} · {entry.subject}</option>)}
          </select></label>
          {job && <article aria-live="polite">
            <div className="dooray-response-heading"><strong>{doorayResponseStatus[job.status] ?? job.status}</strong><a href={job.sourceUrl} target="_blank" rel="noopener noreferrer">Dooray 원문</a></div>
            {job.route && <>
              <p><strong>{job.route.requestSummary}</strong></p>
              <button type="button" className="dooray-response-target" onClick={() => onOpenCard(job.route!.mapId, job.route!.cardId)}>{job.route.documentTitle} → {job.route.cardTitle}</button>
              <p>{job.route.reason}</p>
            </>}
            {job.proposal && <div className="dooray-response-proposal">{job.proposal}</div>}
            {job.proposal && <DoorayResponseDecision key={`${job.id}:${job.proposalRevision}`} job={job} response={response}
              disabled={completing || refining} onLaunchCard={onLaunchCard} />}
            {job.error && <p className="dooray-response-error">{job.error}</p>}
            {job.completedAt && <p>완료: {new Date(job.completedAt).toLocaleString('ko-KR')} · 제안과 완료 기록은 대화 삭제 후에도 보존됩니다.</p>}
            {job.archiveError && <p className="dooray-response-error">{job.archiveError}</p>}
            <div className="dooray-response-actions">
              {job.conversationId && <button type="button" onClick={() => onOpenConversation(job)}>제안 대화 보기</button>}
              {approvalConversation && <button type="button" onClick={() => onOpenConversation({ ...job, ...approvalConversation })}>승인 대화 보기</button>}
              {executionHandoffs.map((entry) => <button type="button" key={entry.id} onClick={() => onOpenConversation({ ...job, ...entry.conversation! })}>인계 대화 보기 · {entry.target.documentTitle}</button>)}
              {approvalConversation && <button type="button" disabled={completing || refining} onClick={() => setExecutionHandoffId(job.id)}>새 문서의 상위 카드에서 이어가기</button>}
              {['proposal', 'needs-approval', 'approved'].includes(job.status) && job.route && <button type="button" disabled={completing || refining} onClick={() => setHandoffId(job.id)}>담당 카드로 전달하기</button>}
              {job.canRetry && <button type="button" onClick={() => void response.retry(job.id)}>상태 다시 확인</button>}
              {(['proposal', 'needs-input', 'needs-approval', 'approved', 'failed'].includes(job.status) || (job.completedAt && job.archiveStatus !== 'done')) && <button type="button"
                disabled={completing || refining} onClick={() => {
                  setCompleting(true)
                  void response.complete(job.id).finally(() => setCompleting(false))
                }}>{completing ? '완료·보관 처리 중…' : job.completedAt ? '대화 보관 다시 시도' : '대응 완료'}</button>}
            </div>
            {['proposal', 'needs-approval', 'approved'].includes(job.status) && handoffId === job.id && <DoorayResponseHandoff key={job.id} job={job} response={response}
              onLaunchCard={onLaunchCard} onOpenConversation={onOpenConversation} onClose={() => setHandoffId('')} />}
            {approvalConversation && executionHandoffId === job.id && <DoorayExecutionHandoff key={job.id} job={job} response={response}
              onLaunchCard={onLaunchCard} onClose={() => setExecutionHandoffId('')} />}
            {!job.completedAt && ['proposal', 'needs-input', 'needs-approval', 'approved', 'failed'].includes(job.status) && <p className="dooray-response-completion-help">대응 완료 시 건수에서 제외하고 제안 전용 대화를 보관합니다. 이미 연결된 실행 대화의 승인은 유지하며, Dooray 업무 상태와 실행 대화·기존 업무 대화는 변경하지 않습니다.</p>}
            {['proposal', 'needs-input', 'needs-approval', 'approved', 'failed'].includes(job.status) && !job.approval?.conversation && <form className="dooray-response-refine" onSubmit={(event) => {
              event.preventDefault()
              setRefining(true)
              void response.refine(job.id, hint).then((ok) => { if (ok) setHint('') }).finally(() => setRefining(false))
            }}>
              <label>추가 정보·담당 변경<textarea value={hint} maxLength={4000} rows={2} onChange={(event) => setHint(event.target.value)} placeholder="관련 문서나 카드, 추가로 확인할 내용을 알려 주세요." /></label>
              <button type="submit" disabled={refining || completing || !hint.trim()}>{refining ? '전달 중…' : '다시 제안받기'}</button>
            </form>}
          </article>}
        </> : response.pendingKeys.size === 0 && <p>{response.showCompleted ? '완료한 대응이 없습니다.' : '미완료 대응이 없습니다. 참조 항목의 ‘AI 대응 제안’을 누르면 담당 탐색과 제안을 시작합니다.'}</p>}
      </div>}
    </section>
  )
}
