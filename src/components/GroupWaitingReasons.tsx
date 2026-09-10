import { useState } from 'react'
import { groupWaitingCategories, groupWaitingImpacts } from '../utils/groupWaiting.mjs'
import type { GroupOverviewRow, GroupProject, GroupWaitingCategory, GroupWaitingImpact, GroupWaitingReason } from '../utils/groupOverview.mjs'

export type GroupWaitingReviewInput = { mapId: string; cardId: string; waitingId: string; expectedFingerprint: string; category: GroupWaitingCategory; impact: GroupWaitingImpact }
const categoryLabel = (id: string) => groupWaitingCategories.find((value) => value.id === id)?.label ?? id
const impactLabel = (id: string) => groupWaitingImpacts.find((value) => value.id === id)?.label ?? id

function WaitingReason({ mapId, reason, editable, disabled, onNavigate, onReview }: {
  mapId: string; reason: GroupWaitingReason; editable: boolean; disabled: boolean
  onNavigate: (mapId: string, cardId?: string) => void
  onReview: (input: GroupWaitingReviewInput) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [category, setCategory] = useState(reason.category)
  const [impact, setImpact] = useState(reason.impact)
  return <article className="group-waiting-reason" data-waiting-id={reason.item.id}>
    <div className="group-reason-heading"><h3>{reason.item.label}</h3><button onClick={() => onNavigate(mapId, reason.cardId)}>원문 카드</button></div>
    <div className="group-reason-tags"><span className="group-status">{categoryLabel(reason.category)}{reason.reviewed ? ' · 직접 분류' : ' · 추정'}</span><span className={`group-status ${reason.impact === 'blocking' ? 'danger' : 'muted'}`}>{impactLabel(reason.impact)}</span></div>
    <p className="group-muted">{reason.isRoot ? '최상위 카드' : '하위 업무'} · {reason.cardTitle}{reason.item.since ? ` · 대기 등록 ${new Date(reason.item.since).toLocaleDateString()}` : ''}</p>
    {reason.stale && <p className="group-review-stale">{reason.review?.invalidReason || '기준 변경'}으로 이전 분류를 집계에서 제외했습니다. 다시 확인해 주세요.</p>}
    {reason.cardStatus === 'done' && <p className="group-muted">완료 카드에 대기 기록이 남아 있습니다. 원문에서 정합성을 확인해 주세요.</p>}
    <details className="group-waiting-evidence"><summary>대기 사유 · 재개 조건 원문</summary><h4>대기 사유</h4><p className="group-full-text">{reason.item.note || '별도 사유가 기록되지 않았습니다.'}</p><h4>재개 조건</h4><p className="group-full-text">{reason.item.resumeCondition || '재개 조건이 기록되지 않았습니다. 원문 카드에서 확인해 주세요.'}</p></details>
    {reason.reviewed && <small>분류 기록: {reason.review?.reviewedBy.name} · {new Date(reason.review!.reviewedAt).toLocaleString()}</small>}
    {editable && (!editing ? <button className="group-review-toggle" disabled={disabled} onClick={() => setEditing(true)}>분류·범위 확인</button> : <form className="group-waiting-review" onSubmit={async (event) => {
      event.preventDefault()
      if (disabled) return
      const saved = await onReview({ mapId, cardId: reason.cardId, waitingId: reason.item.id, expectedFingerprint: reason.fingerprint, category, impact })
      if (saved) setEditing(false)
    }}>
      <fieldset disabled={disabled}><label>사유 분류<select value={category} onChange={(event) => { const value = event.target.value as GroupWaitingCategory; setCategory(value); if (value !== 'external' && impact === 'deferred') setImpact('unreviewed') }}>{groupWaitingCategories.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
        <label>현재 기획 범위의 영향<select value={impact} onChange={(event) => setImpact(event.target.value as GroupWaitingImpact)}>{groupWaitingImpacts.filter((value) => value.id !== 'deferred' || category === 'external').map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
        <p className="group-muted">현재 기획 기준과 원문을 대조해 구분합니다. 분류 저장은 대기 해제·업무 완료·AI 실행 승인이 아닙니다.</p><div className="group-actions"><button type="submit">분류 저장</button><button type="button" onClick={() => { setEditing(false); setCategory(reason.category); setImpact(reason.impact) }}>취소</button></div>
      </fieldset>
    </form>)}
  </article>
}

export function GroupWaitingReasons({ row, project, editable, disabled, supported, filter, onNavigate, onReview, onAiDetails, onConversations }: {
  row: GroupOverviewRow; project: GroupProject; editable: boolean; disabled: boolean; supported: boolean; filter: string
  onNavigate: (mapId: string, cardId?: string) => void
  onReview: (input: GroupWaitingReviewInput) => Promise<boolean>
  onAiDetails: () => void; onConversations: () => void
}) {
  const [matchingOnly, setMatchingOnly] = useState(true)
  const reasonFilter = ['external', 'decision', 'verification', 'other', 'blocking', 'deferred', 'unreviewed'].includes(filter)
  const reasons = row.reasons.filter((reason) => !reasonFilter || !matchingOnly || reason.category === filter || reason.impact === filter)
  const workCards = row.waitingUnavailable ? row.document?.work.waiting ?? 0 : new Set(row.reasons.filter((reason) => !reason.isRoot).map((reason) => reason.cardId)).size
  const rootItems = row.reasons.filter((reason) => reason.isRoot).length
  return <div className="group-waiting-reasons">
    <p className="group-waiting-explanation">분류는 문서를 찾기 위한 참고이며 승인 요청 수가 아닙니다. 미확인 항목은 현재 범위 차단으로 세지 않습니다. 과거 버전 기록도 포함될 수 있습니다.</p>
    <details className="group-waiting-evidence"><summary>판단 기준 · {project.sourceVersion || '버전 미등록'}</summary><h4>전체 목표</h4><p className="group-full-text">{project.objective || '전체 목표 미등록'}</p><h4>공통 지침</h4><p className="group-full-text">{project.instructions || '공통 지침 미등록'}</p></details>
    {row.aiAttention && <div className="group-ai-attention"><h3>AI 확인·복구</h3>{row.document?.runtime?.state === 'waiting-confirmation' && <p>AionUi의 실행 권한 확인이 대기 중입니다. 기획 실행 계획의 사용자 승인과는 별개입니다. <button onClick={onConversations}>AI 대화 확인</button></p>}{row.latest && <p>선택 문서의 최신 위임 상태를 확인하세요. 재개·보고 재시도는 별도 요청이 필요합니다. <button onClick={onAiDetails}>위임 상태·결과 확인</button></p>}</div>}
    {row.waitingUnavailable && <p className="group-review-stale">현재 서버는 대기 건수만 제공합니다. MnP 서버를 재시작한 뒤 새로고침하면 사유를 볼 수 있습니다. 기존 대기는 범위 영향 미확인으로 유지합니다.</p>}
    <div className="group-waiting-summary"><strong>대기 업무 {workCards}개 · {row.waitingUnavailable ? '사유 상세 조회 필요' : `사유 ${row.reasons.length}개`}{rootItems ? ` (최상위 ${rootItems}개 포함)` : ''}</strong>{reasonFilter && <label><input type="checkbox" checked={matchingOnly} onChange={(event) => setMatchingOnly(event.target.checked)} />현재 필터에 해당하는 사유만</label>}</div>
    {!row.reasons.length && !row.waitingUnavailable && <p className="group-muted">등록된 업무 대기 사유가 없습니다.</p>}
    {reasons.map((reason) => <WaitingReason key={`${reason.cardId}:${reason.item.id}:${reason.fingerprint}:${reason.review?.reviewedAt ?? ''}:${reason.review?.valid}`} mapId={row.mapId} reason={reason} editable={editable && supported} disabled={disabled} onNavigate={onNavigate} onReview={onReview} />)}
  </div>
}
