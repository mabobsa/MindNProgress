import { aiDelegationSucceeded } from './aiDelegations.mjs'
import { aiDelegationReportArchivePending } from './aiDelegationReportArchive.mjs'
import { integrationRecoveryPending } from './aiIntegrationRecovery.mjs'

export const COMPLETED_AI_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function latestHistoryTime(...values) {
  const times = values.map((value) => Date.parse(value ?? '')).filter(Number.isFinite)
  return times.length ? Math.max(...times) : null
}

// 보존되는 요청이 참조하는 완료 기록도 남긴다. 참조 사슬은 고정점까지 확인한다.
export function referencedHistoryIds(records, ids) {
  const found = new Set()
  const visit = (value) => {
    if (typeof value === 'string') { if (ids.has(value)) found.add(value); return }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item)
  }
  for (const record of records) visit(record)
  return found
}

export function completedDelegationIds(records, { now = Date.now(), retentionMs = COMPLETED_AI_RETENTION_MS,
  leases = {}, busy = () => false, extraReferences = [], protectedLeaseIds = new Set(), remoteLeaseIds = new Set() } = {}) {
  const candidates = new Set(records.filter((record) => {
    if (record.state !== 'completed' || !aiDelegationSucceeded(record) || busy(record.id)
      || record.pendingRecovery || integrationRecoveryPending(record) || aiDelegationReportArchivePending(record)
      || (record.reportArchive && record.reportArchive.status !== 'recorded')
      || record.reportApprovalRequired || (record.resultCorrection && record.resultCorrection.phase !== 'completed')) return false
    const receipt = record.reportReceipt
    if (!receipt || !['dispatch-delivered', 'parent-acknowledged'].includes(receipt.method)
      || typeof record.parentConversationId !== 'string' || !record.parentConversationId.trim()
      || receipt.parentConversationId !== record.parentConversationId || !Number.isFinite(Date.parse(receipt.at ?? ''))
      || !/^[a-f0-9]{64}$/.test(record.childResultHash ?? '') || receipt.resultHash !== record.childResultHash) return false
    const leaseIds = [record.workspaceLease?.leaseId, record.recoveryWorkspaceLease?.leaseId].filter(Boolean)
    if (record.workspaceLease?.leaseId && leases[record.workspaceLease.leaseId]?.status !== 'completed') return false
    if (leaseIds.some((id) => !['completed', 'cancelled'].includes(leases[id]?.status))) return false
    if (leaseIds.some((id) => protectedLeaseIds.has(id) || leases[id].cleanupPending || leases[id].executionUnconfirmed
      || (leases[id].resultCorrection && leases[id].resultCorrection.phase !== 'completed')
      || (remoteLeaseIds.has(id) && !leases[id].result?.remoteReleased))) return false
    const completedAt = latestHistoryTime(record.completedAt, record.reportReceipt?.at)
    if (completedAt === null) return false
    const lastActivity = latestHistoryTime(new Date(completedAt).toISOString(),
      record.updatedAt, record.reportArchive?.recordedAt,
      ...leaseIds.flatMap((id) => [leases[id]?.result?.completedAt, leases[id]?.completedAt, leases[id]?.updatedAt]))
    return lastActivity !== null && now - lastActivity >= retentionMs
  }).map((record) => record.id))
  let previousSize
  do {
    previousSize = candidates.size
    const retained = [...records.filter((record) => !candidates.has(record.id)), ...extraReferences]
    for (const id of referencedHistoryIds(retained, candidates)) candidates.delete(id)
  } while (previousSize !== candidates.size)
  return candidates
}

export function completedWorkspaceLeaseIds(state, { protectedLeaseIds = new Set(), now = Date.now(),
  retentionMs = COMPLETED_AI_RETENTION_MS, remote = false, allowedLeaseIds, expectedLeases } = {}) {
  const leases = Object.values(state?.leases ?? {})
  const protectedIds = new Set(protectedLeaseIds)
  if (state?.integrationLeaseId) protectedIds.add(state.integrationLeaseId)
  for (const current of Object.values(state?.workspaces ?? {})) if (current.leaseId) protectedIds.add(current.leaseId)
  const candidates = new Set(leases.filter((lease) => {
    const at = latestHistoryTime(lease.result?.completedAt, lease.completedAt, lease.updatedAt)
    return lease.status === 'completed' && !protectedIds.has(lease.leaseId) && !lease.executionUnconfirmed
      && (!remote || (lease.result?.remoteReleased && !lease.cleanupPending))
      && (!lease.resultCorrection || lease.resultCorrection.phase === 'completed')
      && (!allowedLeaseIds || allowedLeaseIds.has(lease.leaseId))
      && (!expectedLeases || JSON.stringify(expectedLeases[lease.leaseId]) === JSON.stringify(lease))
      && at !== null && now - at >= retentionMs
  }).map((lease) => lease.leaseId))
  let size
  do {
    size = candidates.size
    for (const id of referencedHistoryIds(leases.filter((lease) => !candidates.has(lease.leaseId)), candidates)) candidates.delete(id)
  } while (size !== candidates.size)
  return candidates
}

// 결과·지시·복구 전문은 보관하지 않는다. 지연된 재요청 차단과 대화 재사용 통계만 남긴다.
// 문맥 포화 예외(contextOverride)는 남용 여부를 나중에 확인할 수 있도록 상세 정리 뒤에도 보존한다.
export function completedRequestReceipt(record) {
  return Object.fromEntries(['id', 'requestSignature', 'mapId', 'parentMapId', 'targetConversationId',
    'strategy', 'contextOverride', 'createdAt', 'completedAt'].filter((key) => record[key] !== undefined).map((key) => [key, record[key]]))
}
