import { useState } from 'react'
import type { DoorayResponseJob, useDoorayResponses } from './useDoorayResponses'
import type { DoorayHandoffLaunch } from './DoorayResponseHandoff'

export function DoorayResponseDecision({ job, response, disabled, onLaunchCard }: {
  job: DoorayResponseJob; response: ReturnType<typeof useDoorayResponses>; disabled: boolean
  onLaunchCard: (launch: DoorayHandoffLaunch) => void
}) {
  const [pending, setPending] = useState(false)
  const decision = job.decision
  const scope = decision?.approval
  const approval = job.approval
  const legacy = !decision && Boolean(job.proposal) && ['needs-input', 'proposal'].includes(job.status)
  return <section className="dooray-response-decision" aria-label="질문과 승인 구분">
    {decision && <p className="dooray-response-decision-reason">판단 근거: {decision.reason}</p>}
    {decision?.questions.length ? <><strong>답변이 필요한 질문</strong><ul>{decision.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
      <p>아래에 답변을 입력해 주세요. 필요한 정보가 정해지기 전에는 제안을 승인하지 않습니다.</p></> : null}
    {scope && <><strong>{scope.title}</strong><p>승인할 범위</p><ul>{scope.scope.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
      <p>승인에서 제외할 범위</p><ul>{scope.exclusions.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
    {approval && <p role="status">승인: {approval.approvedBy.name} · {new Date(approval.approvedAt).toLocaleString('ko-KR')}<br />
      {approval.conversation ? '새 승인 대화가 연결되었습니다. 작업 결과는 해당 대화에서 확인해 주세요.'
        : job.completedAt ? '새 대화가 연결되기 전에 대응 완료한 기록입니다. 이 기록으로 새 실행 대화를 시작할 수 없습니다.'
          : '아직 새 대화가 연결되지 않았습니다. 옵션 창을 취소했다면 다시 열어 시작할 수 있습니다.'}</p>}
    {job.completedAt && approval?.conversation && <p>대응 완료 후에도 연결된 승인 대화와 승인 범위는 유지됩니다. 해당 대화에서 서버 승인을 다시 확인하고 이어갈 수 있습니다.</p>}
    <div className="dooray-response-actions">
      {!job.completedAt && (job.status === 'needs-approval' || job.status === 'approved') && !approval?.conversation && <button type="button" disabled={pending || disabled}
        onClick={() => { setPending(true); void response.approve(job).then((launch) => { if (launch) onLaunchCard(launch) }).finally(() => setPending(false)) }}>
        {pending ? '승인 확인 중…' : approval ? '승인한 제안으로 AI 대화 시작' : '제안 승인 · AI 대화 시작'}</button>}
      {!job.completedAt && legacy && <button type="button" disabled={pending || disabled} onClick={() => {
        setPending(true)
        void response.refine(job.id, '기존 답변을 새 기준으로 다시 판단해 주세요. 실제로 답변이 필요한 사실 질문과 사용자 동의만 필요한 구체적인 실행안을 구분하여 decision에 반환하세요. 정보가 충분하면 승인 범위와 제외 범위를 명시하고, 혼합되었거나 불명확하면 질문을 우선하세요. 이것은 승인이나 실행 요청이 아닙니다.').finally(() => setPending(false))
      }}>{pending ? '다시 판단 요청 중…' : '질문·승인 다시 판단'}</button>}
    </div>
    {legacy && <p>이전 형식의 답변입니다. 다시 판단하면 AI가 질문과 승인 요청을 구분합니다. 자동 승인되지는 않습니다.</p>}
    {job.status === 'needs-approval' && <p>승인하면 AI 대화 시작 옵션이 열립니다. 새 대화를 시작하기 전에는 실제 작업을 실행하지 않습니다.</p>}
    {!!job.approvalHistory?.length && <details><summary>이전 승인 {job.approvalHistory.length}건 · 현재 제안에는 적용되지 않음</summary>
      {job.approvalHistory.map((entry) => <div key={entry.revision}><strong>{entry.title} · {new Date(entry.approvedAt).toLocaleString('ko-KR')}</strong><pre className="dooray-response-proposal">{entry.proposal}</pre></div>)}
    </details>}
  </section>
}
