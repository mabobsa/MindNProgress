import { groupWaitingPresentation } from './groupWaiting.mjs'

const criteriaFields = ['source', 'sourceVersion', 'objective', 'instructions']
export function groupProjectDraftAfterRefresh(current, previousBase, incoming) {
  if (!current || !previousBase) return incoming
  const edited = criteriaFields.some((key) => current[key] !== previousBase[key])
  const alreadyStale = current.version !== previousBase.version
  if (!edited && !alreadyStale) return incoming
  const criteriaChanged = criteriaFields.some((key) => incoming[key] !== previousBase[key])
  // 분류만 저장된 경우 원문 편집을 보존하고 버전만 따라간다. 실제 기준 충돌은 확인 전까지 유지한다.
  return criteriaChanged || alreadyStale ? current : { ...current, version: incoming.version }
}

const delegationLabels = {
  'recovery-dispatch-pending': '복구 요청 전달 확인 대기',
  'waiting-usage-limit': '사용량 회복 대기', 'waiting-rate-limit': '요청 제한 해제 대기',
  'parent-wake-failed': '총괄 보고 실패 · 확인 필요',
  running: '문서 AI 실행 중', 'waiting-document-work': '하위 업무·문서 검수 대기',
  starting: '실행 준비', 'running-child': '문서 AI 실행 중', 'waiting-child': '문서 AI 실행 중',
  'waiting-resource': '실행 자원 대기', 'waiting-child-resume': '문서 AI 재개 대기',
  'waiting-parent': '총괄 보고 대기', 'waking-parent': '총괄 AI 검토 중',
  completed: '실행 완료 · 검증 근거 확인', failed: '실행 실패', superseded: '후속 위임으로 이어짐', closed: '사용자 종료 · 완료 아님',
  'recovery-required': '복구 필요', 'integration-recovery-required': '통합 복구 필요',
  'waiting-workspace': '작업공간 대기', 'waiting-integration-clean': '통합 준비 대기',
  'waiting-integration': '통합 대기', 'integration-starting': '통합 준비',
  'integration-running': '통합 실행 중', 'integration-waiting-resource': '통합 자원 대기',
  'integration-waiting-resume': '통합 재개 대기', resuming: '재개 중',
}
const attentionStates = new Set([
  'waiting-usage-limit', 'waiting-rate-limit', 'parent-wake-failed', 'failed',
  'recovery-required', 'integration-recovery-required', 'waiting-child-resume',
  'integration-waiting-resume', 'recovery-dispatch-pending',
])

export function groupDelegationPresentation(item) {
  if (!item) return { label: '위임 없음', tone: 'muted', attention: false }
  const state = item.displayState ?? item.state
  const attention = attentionStates.has(state) || item.recovery?.recoveryAvailable === true || item.recovery?.reportRetryAvailable === true
  const label = item.workCompleted && item.reportPending
    ? '작업 완료 · 총괄 보고 대기'
    : delegationLabels[state] ?? state
  const tone = state === 'failed' ? 'danger' : attention ? 'warning'
    : state === 'completed' ? 'success' : ['superseded', 'closed'].includes(state) ? 'muted' : 'active'
  return { label, tone, attention }
}

export function groupOverviewRows(context) {
  if (!context) return []
  const rows = new Map(context.documents
    .filter((document) => document.id !== context.project.coordinatorMapId)
    .map((document) => [document.id, { mapId: document.id, title: document.title, document, delegations: [] }]))
  for (const item of context.delegations) {
    // 문서가 그룹에서 이동된 뒤에도 기존 위임·결과 이력을 숨기지 않는다.
    if (!rows.has(item.mapId)) rows.set(item.mapId, { mapId: item.mapId, title: item.targetCardLabel, document: null, delegations: [] })
    rows.get(item.mapId).delegations.push(item)
  }
  return [...rows.values()].map((row) => {
    row.delegations.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    const latest = row.delegations[0] ?? null
    const aiAttention = groupDelegationPresentation(latest).attention || row.document?.runtime?.state === 'waiting-confirmation'
    const waitingDetails = row.document?.waitingDetails ?? []
    const waitingUnavailable = Boolean(row.document && !Array.isArray(row.document.waitingDetails)
      && (row.document.work.waiting > 0 || row.document.root?.data.waitingItems?.length))
    const reasons = waitingDetails.map((detail) => ({ ...detail, ...groupWaitingPresentation(detail) }))
    const filters = [...new Set([
      ...(aiAttention ? ['ai'] : []), ...(waitingUnavailable ? ['unreviewed'] : []),
      ...reasons.flatMap((reason) => [reason.category, reason.impact]),
    ])]
    return { ...row, latest, aiAttention: Boolean(aiAttention), reasons, waitingUnavailable, filters,
      attention: filters.length > 0 }
  })
}

export function filterGroupOverviewRows(rows, query, filter = 'all') {
  const keyword = query.trim().toLocaleLowerCase()
  // boolean은 구버전 호출 호환용이다. 새 화면은 사유·영향별 문서 수를 사용한다.
  return rows.filter((row) => ((filter === true ? row.attention : filter === false || filter === 'all' || row.filters.includes(filter)))
    && (!keyword || `${row.title} ${row.mapId}`.toLocaleLowerCase().includes(keyword)))
}
