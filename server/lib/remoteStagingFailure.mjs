// 원격 Fork 결과를 메인에 통합하기 전 staging 준비 단계의 실패를 구분한다.
// 이 단계는 메인 통합 저장소를 바꾸기 전이므로 하위 AI를 다시 실행할 대상이 아니다.
export const REMOTE_STAGING_PATH_TOO_LONG = 'REMOTE_WORKSPACE_STAGING_PATH_TOO_LONG'
export const REMOTE_STAGING_PREPARATION_FAILED = 'REMOTE_WORKSPACE_STAGING_PREPARATION_FAILED'
export const REMOTE_STAGING_PHASE = 'staging-preparation'
// staging을 다시 만들고 일반 통합 대기로 돌려보낸 lease 결과의 단계 표시다.
export const STAGING_RECREATED = 'staging-recreated'
export const REMOTE_STAGING_RECOVERY_GUIDANCE = '하위 AI를 다시 실행하거나 새 위임을 만들 필요는 없습니다. 원인을 해소한 뒤 머신 담당자가 원격 작업공간 풀에서 이 lease의 통합 재시도(retry-integration)를 요청하세요.'

const KEPT = '메인과 완료된 작업 결과는 변경되지 않았습니다.'

// Git의 파일별 오류 전문을 그대로 남기지 않는다. 경로 길이 초과는 개수와 예시만, 그 밖에는 첫 줄만 남긴다.
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
  const firstLine = source.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 300) || '알 수 없는 오류'
  return { reasonCode: REMOTE_STAGING_PREPARATION_FAILED, examples: [], pathCount: 0,
    message: `통합 준비용 staging을 만들지 못했습니다. ${KEPT} 원인: ${firstLine}` }
}

// staging 준비 중 실패한 오류를 격리 사유로 바꾼다. 이미 구분한 오류는 그대로 쓰고, 그 밖의 오류는 요약하되 원 사유 코드는 유지한다.
export function remoteStagingHoldReason(error) {
  if ([REMOTE_STAGING_PATH_TOO_LONG, REMOTE_STAGING_PREPARATION_FAILED].includes(error?.reasonCode)) {
    return { reasonCode: error.reasonCode, message: error.message, details: error.details ?? null }
  }
  const summary = summarizeRemoteStagingFailure(error?.message ?? error)
  return { reasonCode: typeof error?.reasonCode === 'string' && error.reasonCode ? error.reasonCode : summary.reasonCode,
    message: summary.message, details: summary.pathCount ? { examples: summary.examples, pathCount: summary.pathCount } : null }
}

// 원격 lease 결과가 staging 준비 단계의 격리인지 판정한다.
// 수정 전 기록은 사유 코드 없이 Git 출력만 남았으므로, staging 통합 기록이 없고 사유에 이 lease의 staging 경로가 있는 경우만 같은 분류로 본다.
export function remoteStagingHold(leaseId, result) {
  if (result?.status !== 'quarantined') return false
  if (result.phase === REMOTE_STAGING_PHASE) return true
  if (result.phase || result.reasonCode || Object.hasOwn(result, 'stagingRoot') || Object.hasOwn(result, 'stagedResult')) return false
  const id = String(leaseId ?? '')
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id)
    && String(result.reason ?? '').replaceAll('\\', '/').includes(`/remote-workspaces/staging/${id}/`)
}

// 원격 lease가 staging 준비 실패로 격리된 위임인지 판정하고 화면·AI에 보일 요약을 만든다.
export function remoteStagingPreparationFailure(delegation) {
  const result = delegation?.workspaceResult
  if (!delegation?.workspaceLease?.ownership || !remoteStagingHold(delegation.workspaceLease.leaseId, result)) return null
  if (result.phase === REMOTE_STAGING_PHASE) {
    return { reasonCode: result.reasonCode || REMOTE_STAGING_PREPARATION_FAILED,
      message: String(result.reason ?? '').trim() || summarizeRemoteStagingFailure('').message }
  }
  const summary = summarizeRemoteStagingFailure(result.reason)
  return { reasonCode: summary.reasonCode, message: summary.message }
}
