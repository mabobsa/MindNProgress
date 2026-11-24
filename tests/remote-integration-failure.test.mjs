import assert from 'node:assert/strict'
import test from 'node:test'
import { aiDelegationRecoveryAvailability, aiDelegationStateReason } from '../server/lib/aiDelegations.mjs'
import { workspaceError } from '../server/lib/remoteWorkspaceProtocol.mjs'
import {
  REMOTE_INTEGRATION_FAILED, REMOTE_STAGING_PATH_TOO_LONG, REMOTE_STAGING_PREPARATION_FAILED, remoteIntegrationFailure,
  remoteIntegrationFailureReason, remoteIntegrationHold, summarizeRemoteStagingFailure,
} from '../server/lib/remoteIntegrationFailure.mjs'

const leaseId = 'lease-b3ea5885-e99e-4eba-b022-2fcd7a1f0f8c'
const repository = `C:\\Git\\MindNProgress\\MindNProgress\\server\\data\\remote-workspaces\\staging\\${leaseId}\\repository`
const longFile = 'Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/AdPopcornOfferwall.bundle/Contents/Resources/en.lproj/Localizable.strings'
// 수정 전 Windows 서버가 lease와 위임에 그대로 저장한 Git 출력과 같은 형태다.
const legacyReason = [
  `Command failed: git --no-optional-locks -C ${repository} switch mnp/job-626dd211-3ec8-4c08-b704-9a02bb105ee3`,
  `error: unable to create file ${longFile}: Filename too long`,
  'error: unable to create file Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/Headers/AdPopcornOfferwall.h: Filename too long',
  "fatal: cannot create directory at 'Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/Modules/Deep': Filename too long",
].join('\r\n')

function remoteDelegation(workspaceResult, patch = {}) {
  return { id: 'delegation-1', state: 'integration-recovery-required', childStatus: 'completed',
    workspaceLease: { leaseId, ownership: { machineId: 'macbook', generation: 3 } },
    workspaceResult, workspaceError: workspaceResult.reason ?? null, integrationError: workspaceResult.reason ?? null, ...patch }
}

test('수정 전 staging 경로 초과 출력은 파일별 오류 대신 건수와 예시만 남긴다', () => {
  const summary = summarizeRemoteStagingFailure(legacyReason)
  assert.equal(summary.reasonCode, REMOTE_STAGING_PATH_TOO_LONG)
  assert.equal(summary.pathCount, 3)
  assert.equal(summary.examples[0], longFile)
  assert.match(summary.message, /^경로 길이 제한으로 통합 준비용 staging에 결과를 꺼내지 못했습니다\(경로 초과 3건\)\. 메인과 완료된 작업 결과는 변경되지 않았습니다\./)
  assert.doesNotMatch(summary.message, /Command failed|\r/)
  const other = summarizeRemoteStagingFailure(`\n  fatal: ${'x'.repeat(400)}\nsecond line`)
  assert.equal(other.reasonCode, REMOTE_STAGING_PREPARATION_FAILED)
  assert.ok(other.message.endsWith(`원인: fatal: ${'x'.repeat(293)}`))
})

test('메인 통합 실패 사유는 첫 줄만 남기고 원 사유 코드를 유지한다', () => {
  const coded = remoteIntegrationFailureReason(workspaceError('REMOTE_WORKSPACE_BASE_DIVERGED', '메인 이력이 이어지지 않습니다.\n세부'))
  assert.equal(coded.reasonCode, 'REMOTE_WORKSPACE_BASE_DIVERGED')
  assert.equal(coded.message, '원격 결과를 메인에 통합하지 못했습니다. 메인과 완료된 작업 결과는 변경되지 않았습니다. 원인: 메인 이력이 이어지지 않습니다.')
  const raw = remoteIntegrationFailureReason(Object.assign(new Error('Command failed: git merge\nerror: details'), { code: 128 }))
  assert.equal(raw.reasonCode, REMOTE_INTEGRATION_FAILED)
  assert.match(raw.message, /원인: Command failed: git merge$/)
})

test('원격 통합 단계 기록은 새 단계 표시와 같은 lease의 수정 전 staging 경로로만 판정한다', () => {
  assert.equal(remoteIntegrationHold(leaseId, { status: 'quarantined', phase: 'remote-integration', reasonCode: 'REMOTE_INTEGRATION_CONFLICT_LIMIT' }), true)
  assert.equal(remoteIntegrationHold(leaseId, { status: 'awaiting-conflict-resolution', phase: 'remote-integration' }), true)
  assert.equal(remoteIntegrationHold(leaseId, { status: 'waiting-integration', phase: 'remote-integration' }), false)
  assert.equal(remoteIntegrationHold(leaseId, { status: 'quarantined', phase: 'staging-preparation' }), true)
  assert.equal(remoteIntegrationHold(leaseId, { status: 'quarantined', reason: legacyReason }), true)
  assert.equal(remoteIntegrationHold('lease-other', { status: 'quarantined', reason: legacyReason }), false, '다른 lease의 staging 경로')
  assert.equal(remoteIntegrationHold(leaseId, { status: 'quarantined', reason: legacyReason, reasonCode: 'REMOTE_INTEGRATION_CONFLICT_MANUAL_REVIEW' }), false)
  assert.equal(remoteIntegrationHold(leaseId, { status: 'quarantined', reason: legacyReason, stagingRoot: repository, stagedResult: null }), false)
  assert.equal(remoteIntegrationHold(leaseId, { status: 'quarantined', reason: '원격 작업 취소: 실행 여부 확인 후 명시적 복구가 필요합니다.' }), false)
  assert.equal(remoteIntegrationHold('../escape', { status: 'quarantined', reason: legacyReason }), false)
  assert.equal(remoteIntegrationHold(leaseId, null), false)
})

test('기존 Windows 기록의 staging 실패는 AI 재개 대신 원격 통합 재시도를 안내한다', () => {
  const delegation = remoteDelegation({ status: 'quarantined', leaseId, jobId: 'job-1', reason: legacyReason })
  const recovery = aiDelegationRecoveryAvailability(delegation)
  assert.equal(recovery.failureCategory, 'remote-integration')
  assert.equal(recovery.recoveryAvailable, false)
  assert.equal(recovery.recommendedAction, 'retry-remote-integration')
  assert.equal(recovery.reasonCode, REMOTE_STAGING_PATH_TOO_LONG)
  assert.equal(recovery.leaseId, leaseId)
  assert.equal(recovery.recoveryTool, undefined)
  assert.match(recovery.message, /경로 초과 3건/)
  assert.match(recovery.message, /하위 AI를 다시 실행하거나 새 위임을 만들 필요는 없습니다\./)
  assert.match(recovery.message, /봉인된 결과부터 다시 통합합니다\.$/)
  assert.doesNotMatch(recovery.message, /Command failed/)
  const reason = aiDelegationStateReason(delegation)
  assert.equal(reason.reasonCode, REMOTE_STAGING_PATH_TOO_LONG)
  assert.equal(reason.message, recovery.message)
})

test('새 형식의 원격 통합 격리와 중단된 원격 충돌 해결도 같은 재시도 안내를 쓴다', () => {
  const held = remoteDelegation({ status: 'quarantined', leaseId, phase: 'remote-integration', reasonCode: 'REMOTE_INTEGRATION_CONFLICT_LIMIT',
    reason: 'AI 충돌 해결 재시도 한도(3회)를 초과했습니다.', childStatus: 'completed' })
  const recovery = aiDelegationRecoveryAvailability(held)
  assert.equal(recovery.failureCategory, 'remote-integration'); assert.equal(recovery.reasonCode, 'REMOTE_INTEGRATION_CONFLICT_LIMIT')
  assert.match(recovery.message, /^AI 충돌 해결 재시도 한도\(3회\)를 초과했습니다\. 하위 AI를/)
  const interrupted = remoteDelegation({ status: 'awaiting-conflict-resolution', leaseId, phase: 'remote-integration',
    unmergedFiles: ['Assets/A.prefab', 'Assets/B.cs'], conflictRound: 1 }, { integrationError: 'AionCore 재시작으로 통합 충돌 해결의 명시적인 재개가 필요합니다.' })
  const resume = aiDelegationRecoveryAvailability(interrupted)
  assert.equal(resume.failureCategory, 'remote-integration'); assert.equal(resume.reasonCode, 'REMOTE_INTEGRATION_CONFLICT_INTERRUPTED')
  assert.match(resume.message, /충돌 파일 2건/)
  assert.deepEqual(remoteIntegrationFailure(interrupted).reasonCode, 'REMOTE_INTEGRATION_CONFLICT_INTERRUPTED')
})

test('원격 통합 단계가 아닌 통합 복구와 로컬 작업공간은 기존 재개 분류를 유지한다', () => {
  const conflict = remoteDelegation({ status: 'quarantined', leaseId, reason: '원격 결과의 메인 staging 통합 충돌입니다.',
    reasonCode: 'REMOTE_INTEGRATION_CONFLICT_MANUAL_REVIEW', stagingRoot: repository, stagedResult: { status: 'awaiting-conflict-resolution' } })
  assert.equal(aiDelegationRecoveryAvailability(conflict).recommendedAction, 'resume-existing')
  assert.equal(aiDelegationStateReason(conflict).reasonCode, 'AI_DELEGATION_INTEGRATION_RECOVERY_REQUIRED')
  const local = remoteDelegation({ status: 'awaiting-conflict-resolution', leaseId, phase: 'remote-integration' }, { workspaceLease: { leaseId } })
  assert.equal(aiDelegationRecoveryAvailability(local).recommendedAction, 'resume-existing')
  const checkpoint = remoteDelegation({ status: 'checkpoint-required', leaseId, checkpointRound: 1 })
  assert.equal(aiDelegationRecoveryAvailability(checkpoint).recommendedAction, 'resume-existing')
  const otherState = remoteDelegation({ status: 'quarantined', leaseId, reason: legacyReason }, { state: 'recovery-required' })
  assert.equal(aiDelegationRecoveryAvailability(otherState).failureCategory, 'restart')
})
