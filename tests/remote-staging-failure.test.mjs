import assert from 'node:assert/strict'
import test from 'node:test'
import { aiDelegationRecoveryAvailability, aiDelegationStateReason } from '../server/lib/aiDelegations.mjs'
import { workspaceError } from '../server/lib/remoteWorkspaceProtocol.mjs'
import {
  REMOTE_STAGING_PATH_TOO_LONG, REMOTE_STAGING_PREPARATION_FAILED, remoteStagingHold, remoteStagingHoldReason,
  remoteStagingPreparationFailure, summarizeRemoteStagingFailure,
} from '../server/lib/remoteStagingFailure.mjs'

const leaseId = 'lease-b3ea5885-e99e-4eba-b022-2fcd7a1f0f8c'
const repository = `C:\\Git\\MindNProgress\\MindNProgress\\server\\data\\remote-workspaces\\staging\\${leaseId}\\repository`
const longFile = 'Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/AdPopcornOfferwall.bundle/Contents/Resources/en.lproj/Localizable.strings'
// 수정 전 Windows 서버가 lease와 위임에 그대로 저장한 Git 출력과 같은 형태다.
const legacyReason = [
  `Command failed: git --no-optional-locks -C ${repository} switch mnp/job-626dd211-3ec8-4c08-b704-9a02bb105ee3`,
  `error: unable to create file ${longFile}: Filename too long`,
  'error: unable to create file Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/Headers/AdPopcornOfferwall.h: Filename too long',
  "fatal: cannot create directory at 'Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/Modules/Deep': Filename too long",
  'Updating files: 100% (52011/52011), done.',
].join('\r\n')

function remoteDelegation(workspaceResult, patch = {}) {
  return { id: 'delegation-1', state: 'integration-recovery-required', childStatus: 'completed',
    workspaceLease: { leaseId, ownership: { machineId: 'macbook', generation: 3 } },
    workspaceResult, workspaceError: workspaceResult.reason, integrationError: workspaceResult.reason, ...patch }
}

test('staging 경로 초과 출력은 파일별 오류 대신 건수와 예시만 남긴다', () => {
  const summary = summarizeRemoteStagingFailure(legacyReason)
  assert.equal(summary.reasonCode, REMOTE_STAGING_PATH_TOO_LONG)
  assert.equal(summary.pathCount, 3)
  assert.deepEqual(summary.examples, [longFile,
    'Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/Headers/AdPopcornOfferwall.h',
    'Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/Modules/Deep'])
  assert.match(summary.message, /^경로 길이 제한으로 통합 준비용 staging에 결과를 꺼내지 못했습니다\(경로 초과 3건\)\. 메인과 완료된 작업 결과는 변경되지 않았습니다\./)
  assert.doesNotMatch(summary.message, /Command failed|Updating files|\r/)
})

test('그 밖의 staging 실패는 첫 줄만 300자 이내로 남긴다', () => {
  const summary = summarizeRemoteStagingFailure(`\n  fatal: ${'x'.repeat(400)}\nsecond line`)
  assert.equal(summary.reasonCode, REMOTE_STAGING_PREPARATION_FAILED)
  assert.equal(summary.pathCount, 0)
  assert.ok(summary.message.endsWith(`원인: fatal: ${'x'.repeat(293)}`))
  assert.doesNotMatch(summary.message, /second line/)
  assert.match(summarizeRemoteStagingFailure('').message, /원인: 알 수 없는 오류$/)
})

test('격리 사유는 구분된 오류를 유지하고 그 밖의 오류는 요약하되 원 사유 코드를 남긴다', () => {
  const classified = Object.assign(workspaceError(REMOTE_STAGING_PATH_TOO_LONG, '요약된 사유'), { details: { examples: ['a'], pathCount: 1 } })
  assert.deepEqual(remoteStagingHoldReason(classified), { reasonCode: REMOTE_STAGING_PATH_TOO_LONG, message: '요약된 사유',
    details: { examples: ['a'], pathCount: 1 } })
  const pending = remoteStagingHoldReason(workspaceError('REMOTE_WORKSPACE_OPERATION_PENDING'))
  assert.equal(pending.reasonCode, 'REMOTE_WORKSPACE_OPERATION_PENDING')
  assert.match(pending.message, /^통합 준비용 staging을 만들지 못했습니다\. .*원인: REMOTE_WORKSPACE_OPERATION_PENDING$/)
  assert.equal(pending.details, null)
  const raw = remoteStagingHoldReason(Object.assign(new Error(legacyReason), { code: 128 }))
  assert.equal(raw.reasonCode, REMOTE_STAGING_PATH_TOO_LONG)
  assert.equal(raw.details.pathCount, 3)
})

test('staging 준비 격리는 새 기록의 단계 표시나 같은 lease의 기존 staging 경로 출력으로만 판정한다', () => {
  assert.equal(remoteStagingHold(leaseId, { status: 'quarantined', phase: 'staging-preparation', reasonCode: REMOTE_STAGING_PREPARATION_FAILED }), true)
  assert.equal(remoteStagingHold(leaseId, { status: 'quarantined', reason: legacyReason }), true)
  assert.equal(remoteStagingHold(leaseId, { status: 'quarantined', reason: legacyReason.replaceAll('\\', '/') }), true)
  assert.equal(remoteStagingHold('lease-other', { status: 'quarantined', reason: legacyReason }), false, '다른 lease의 staging 경로')
  assert.equal(remoteStagingHold(leaseId, { status: 'waiting-integration', reason: legacyReason }), false)
  assert.equal(remoteStagingHold(leaseId, { status: 'quarantined', reason: legacyReason, reasonCode: 'REMOTE_INTEGRATION_CONFLICT_MANUAL_REVIEW' }), false)
  assert.equal(remoteStagingHold(leaseId, { status: 'quarantined', reason: legacyReason, stagingRoot: repository, stagedResult: null }), false,
    'staging 통합 단계의 실패')
  assert.equal(remoteStagingHold(leaseId, { status: 'quarantined', reason: '원격 작업 취소: 실행 여부 확인 후 명시적 복구가 필요합니다.' }), false)
  assert.equal(remoteStagingHold('../escape', { status: 'quarantined', reason: legacyReason }), false)
})

test('기존 Windows 기록의 staging 실패는 AI 재개 대신 원격 통합 재시도를 안내한다', () => {
  const delegation = remoteDelegation({ status: 'quarantined', leaseId, jobId: 'job-1', reason: legacyReason })
  const recovery = aiDelegationRecoveryAvailability(delegation)
  assert.equal(recovery.failureCategory, 'remote-staging-preparation')
  assert.equal(recovery.recoveryAvailable, false)
  assert.equal(recovery.recommendedAction, 'retry-remote-integration')
  assert.equal(recovery.reasonCode, REMOTE_STAGING_PATH_TOO_LONG)
  assert.equal(recovery.leaseId, leaseId)
  assert.equal(recovery.recoveryTool, undefined)
  assert.match(recovery.message, /경로 초과 3건/)
  assert.match(recovery.message, /하위 AI를 다시 실행하거나 새 위임을 만들 필요는 없습니다\./)
  assert.match(recovery.message, /retry-integration/)
  assert.doesNotMatch(recovery.message, /Command failed/)
  const reason = aiDelegationStateReason(delegation)
  assert.equal(reason.reasonCode, REMOTE_STAGING_PATH_TOO_LONG)
  assert.equal(reason.message, recovery.message)
  assert.deepEqual(remoteStagingPreparationFailure(delegation), { reasonCode: REMOTE_STAGING_PATH_TOO_LONG,
    message: summarizeRemoteStagingFailure(legacyReason).message })
})

test('새 형식의 staging 실패 기록은 저장된 요약을 그대로 쓴다', () => {
  const delegation = remoteDelegation({ status: 'quarantined', leaseId, jobId: 'job-1', phase: 'staging-preparation',
    reasonCode: 'REMOTE_WORKSPACE_OPERATION_PENDING', reason: '통합 준비용 staging을 만들지 못했습니다. 원인: 예약 대기', childStatus: 'completed' })
  const recovery = aiDelegationRecoveryAvailability(delegation)
  assert.equal(recovery.failureCategory, 'remote-staging-preparation')
  assert.equal(recovery.reasonCode, 'REMOTE_WORKSPACE_OPERATION_PENDING')
  assert.match(recovery.message, /^통합 준비용 staging을 만들지 못했습니다\. 원인: 예약 대기 하위 AI를/)
})

test('staging 준비가 아닌 통합 복구와 로컬 작업공간은 기존 재개 분류를 유지한다', () => {
  const conflict = remoteDelegation({ status: 'quarantined', leaseId, reason: '원격 결과의 메인 staging 통합 충돌입니다.',
    reasonCode: 'REMOTE_INTEGRATION_CONFLICT_MANUAL_REVIEW', stagingRoot: repository, stagedResult: { status: 'awaiting-conflict-resolution' } })
  assert.equal(aiDelegationRecoveryAvailability(conflict).recommendedAction, 'resume-existing')
  assert.equal(aiDelegationStateReason(conflict).reasonCode, 'AI_DELEGATION_INTEGRATION_RECOVERY_REQUIRED')
  const local = remoteDelegation({ status: 'quarantined', leaseId, reason: legacyReason }, { workspaceLease: { leaseId } })
  assert.equal(aiDelegationRecoveryAvailability(local).recommendedAction, 'resume-existing')
  const otherState = remoteDelegation({ status: 'quarantined', leaseId, reason: legacyReason }, { state: 'recovery-required' })
  assert.equal(aiDelegationRecoveryAvailability(otherState).failureCategory, 'restart')
})
