import { createHash } from 'node:crypto'
import { aiDelegationReportResult, aiDelegationSucceeded } from './aiDelegations.mjs'
import { throwIfRuntimeStopping } from './runtimeStopping.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')

function archiveOperationId(delegation) {
  const result = aiDelegationReportResult(delegation)
  if (!aiDelegationSucceeded(delegation) || delegation.pendingRecovery
    || !delegation.parentConversationId || result.availability !== 'captured' || !result.turnId) return null
  return `mnp-report-${hash(JSON.stringify([delegation.id, delegation.parentConversationId, result.turnId, result.hash]))}`
}

export function aiDelegationReportArchived(delegation) {
  const archive = delegation?.reportArchive
  return Boolean(archive?.status === 'recorded' && archive.messageId
    && archive.operationId === archiveOperationId(delegation)
    && typeof archive.content === 'string' && hash(archive.content) === archive.contentHash)
}

export function aiDelegationReportArchivePending(delegation) {
  const eligible = delegation?.state === 'waiting-parent'
    || (delegation?.state === 'completed' && delegation.reportReceipt?.method === 'parent-acknowledged'
      && delegation.reportReceipt.parentConversationId === delegation.parentConversationId
      && delegation.reportReceipt.resultHash === aiDelegationReportResult(delegation).hash
      && delegation.reportReceipt.childTurnId === aiDelegationReportResult(delegation).turnId)
  return Boolean(eligible && !delegation.reportApprovalRequired && archiveOperationId(delegation)
    && !aiDelegationReportArchived(delegation))
}

// 전문을 먼저 내구 저장하고, AI 실행 여부는 기존 수신 확인/유휴 보고 경로가 결정한다.
// 본문과 operation ID를 고정하므로 응답 유실·재시작·문구 변경에도 같은 메시지만 재시도한다.
export function createAiDelegationReportArchiver({ update, fetchOn, capabilities, parentMachineId, instruction,
  now = Date.now, warn = console.warn }) {
  return async function archiveReport(delegation) {
    if (!aiDelegationReportArchivePending(delegation)) return delegation
    const operationId = archiveOperationId(delegation)
    let archive = delegation.reportArchive
    if (archive?.operationId !== operationId) {
      const content = await instruction(delegation, aiDelegationReportResult(delegation))
      archive = { operationId, content, contentHash: hash(content), status: 'pending', attempt: 0 }
      delegation = await update(delegation.id, { reportArchive: archive })
    }
    if (Date.parse(archive.nextAttemptAt ?? '') > now()) return delegation
    const attempt = Number(archive.attempt ?? 0) + 1
    try {
      if (typeof archive.content !== 'string' || hash(archive.content) !== archive.contentHash) {
        throw Object.assign(new Error('저장할 완료 전문의 무결성을 확인하지 못했습니다.'), { code: 'REPORT_ARCHIVE_INTEGRITY_ERROR' })
      }
      const machineId = parentMachineId(delegation)
      if ((await capabilities(machineId))?.historyOnlyReports !== true) {
        throw Object.assign(new Error('완료 전문 기록 API를 지원하는 AionCore의 적용을 기다립니다.'), { code: 'AIONCORE_HISTORY_REPORT_UNSUPPORTED' })
      }
      const result = await fetchOn(machineId, `/api/conversations/${encodeURIComponent(delegation.parentConversationId)}/external-reports`, {
        method: 'POST', body: { operationId, content: archive.content },
      })
      if (result?.operationId !== operationId || result.conversationId !== delegation.parentConversationId
        || !/^external-report-[a-f0-9]{64}$/.test(result.messageId ?? '')
        || result.contentHash !== archive.contentHash || result.executionRequested !== false) {
        throw Object.assign(new Error('완료 전문 저장 응답의 대상·본문·실행 여부가 일치하지 않습니다.'), { code: 'REPORT_ARCHIVE_RESPONSE_INVALID' })
      }
      return await update(delegation.id, { reportArchive: { ...archive, status: 'recorded', attempt,
        messageId: result.messageId, recordedAt: new Date(now()).toISOString(), nextAttemptAt: null, errorCode: null } })
    } catch (error) {
      throwIfRuntimeStopping(error)
      const errorCode = error?.code ?? (error?.status ? `HTTP_${error.status}` : 'REPORT_ARCHIVE_UNAVAILABLE')
      if (archive.errorCode !== errorCode) warn('[AI delegation report archive]', { delegationId: delegation.id, operationId, errorCode })
      return await update(delegation.id, { reportArchive: { ...archive, status: 'pending', attempt, errorCode,
        nextAttemptAt: new Date(now() + Math.min(60_000, 5_000 * 2 ** Math.min(attempt - 1, 4))).toISOString() } })
    }
  }
}
