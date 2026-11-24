// 원격 Fork 결과를 메인에 통합하는 단계의 대기·격리를 구분한다.
// 이 단계는 봉인된 결과를 다루므로 하위 AI를 다시 실행할 대상이 아니다.
export const REMOTE_INTEGRATION_PHASE = 'remote-integration'
export const INTEGRATION_REQUEUED = 'integration-requeued'
// 수정 전(staging 방식) 기록의 단계 표시다. 새 기록은 만들지 않지만 조회와 재시도에서 같은 분류로 다룬다.
export const LEGACY_STAGING_PHASE = 'staging-preparation'
export const REMOTE_STAGING_PATH_TOO_LONG = 'REMOTE_WORKSPACE_STAGING_PATH_TOO_LONG'
export const REMOTE_STAGING_PREPARATION_FAILED = 'REMOTE_WORKSPACE_STAGING_PREPARATION_FAILED'
export const REMOTE_INTEGRATION_FAILED = 'REMOTE_INTEGRATION_FAILED'
export const REMOTE_INTEGRATION_RECOVERY_GUIDANCE = '하위 AI를 다시 실행하거나 새 위임을 만들 필요는 없습니다. 원인을 해소한 뒤 머신 담당자가 원격 작업공간 풀에서 이 lease의 통합 재시도(retry-integration)를 요청하세요. 봉인된 결과부터 다시 통합합니다.'

const KEPT = '메인과 완료된 작업 결과는 변경되지 않았습니다.'
const firstLine = (text) => String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 300) || '알 수 없는 오류'

// 수정 전 staging 방식이 남긴 Git 파일별 오류 전문을 요약한다. 경로 길이 초과는 개수와 예시만 남긴다.
export function summarizeRemoteStagingFailure(text) {
  const source = String(text ?? '')
  const files = [...source.matchAll(/unable to create file (.+?): File ?name too long/gi)].map((match) => match[1].trim())
  const directories = [...source.matchAll(/cannot create directory at '(.+?)': File ?name too long/gi)].map((match) => match[1].trim())
  const paths = [...files, ...directories]
  if (paths.length) {
    const examples = paths.slice(0, 3)
    return { reasonCode: REMOTE_STAGING_PATH_TOO_LONG, examples, pathCount: paths.length,
      message: `경로 길이 제한으로 통합 준비용 staging에 결과를 꺼내지 못했습니다(경로 초과 ${paths.length}건). ${KEPT} 예: ${examples.join(', ')}` }
  }
  return { reasonCode: REMOTE_STAGING_PREPARATION_FAILED, examples: [], pathCount: 0,
    message: `통합 준비용 staging을 만들지 못했습니다. ${KEPT} 원인: ${firstLine(source)}` }
}

// 메인 쪽 통합 실패를 격리 사유로 바꾼다. Git 출력 전문은 남기지 않고 원 사유 코드는 유지한다.
export function remoteIntegrationFailureReason(error) {
  return { reasonCode: typeof error?.reasonCode === 'string' && error.reasonCode ? error.reasonCode : REMOTE_INTEGRATION_FAILED,
    message: `원격 결과를 메인에 통합하지 못했습니다. ${KEPT} 원인: ${firstLine(error?.message ?? error)}` }
}

function legacyStagingHold(leaseId, result) {
  if (result.phase || result.reasonCode || Object.hasOwn(result, 'stagingRoot') || Object.hasOwn(result, 'stagedResult')) return false
  const id = String(leaseId ?? '')
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id)
    && String(result.reason ?? '').replaceAll('\\', '/').includes(`/remote-workspaces/staging/${id}/`)
}

// 원격 lease 결과가 메인 통합 단계에서 멈춘 기록인지 판정한다.
// 새 기록은 단계 표시로, 수정 전 staging 기록은 사유에 담긴 이 lease의 staging 경로로 구분한다.
export function remoteIntegrationHold(leaseId, result) {
  if (!result) return false
  if ([REMOTE_INTEGRATION_PHASE, LEGACY_STAGING_PHASE].includes(result.phase)) {
    return ['quarantined', 'awaiting-conflict-resolution'].includes(result.status)
  }
  return result.status === 'quarantined' && legacyStagingHold(leaseId, result)
}

// 원격 통합이 멈춘 위임의 화면·AI 안내를 만든다. 원격 lease가 아니거나 통합 단계 기록이 아니면 null이다.
export function remoteIntegrationFailure(delegation) {
  const result = delegation?.workspaceResult
  if (!delegation?.workspaceLease?.ownership || !remoteIntegrationHold(delegation.workspaceLease.leaseId, result)) return null
  if (result.status === 'awaiting-conflict-resolution') {
    const files = Array.isArray(result.unmergedFiles) ? result.unmergedFiles : []
    return { reasonCode: 'REMOTE_INTEGRATION_CONFLICT_INTERRUPTED',
      message: `원격 Fork의 통합 충돌 해결이 끝나지 않았습니다(충돌 파일 ${files.length}건). ${KEPT}` }
  }
  if (result.phase === REMOTE_INTEGRATION_PHASE) {
    return { reasonCode: result.reasonCode || REMOTE_INTEGRATION_FAILED, message: String(result.reason ?? '').trim() || remoteIntegrationFailureReason('').message }
  }
  if (result.phase === LEGACY_STAGING_PHASE) {
    return { reasonCode: result.reasonCode || REMOTE_STAGING_PREPARATION_FAILED, message: String(result.reason ?? '').trim() || summarizeRemoteStagingFailure('').message }
  }
  const summary = summarizeRemoteStagingFailure(result.reason)
  return { reasonCode: summary.reasonCode, message: summary.message }
}
