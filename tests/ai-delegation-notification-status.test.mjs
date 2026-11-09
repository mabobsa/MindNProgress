import assert from 'node:assert/strict'
import test from 'node:test'
import { aiDelegationNotificationStatus, withAiDelegationNotificationStatus } from '../server/lib/aiDelegationNotifications.mjs'
import { notificationTitle, notificationDelegationReference, updateDelegationNotificationStatuses } from '../src/utils/notificationTitles.mjs'

const id = 'rev52:card:waiting-recheck'
const createdAt = '2026-11-09T09:32:38.371Z'
const updatedAt = '2026-11-09T09:36:59.396Z'
const notice = { id: 'notification-checkpoint', userId: 'user-editor', type: 'ai-delegation',
  message: '명시적 체크포인트가 없어 자동 보완을 요청했습니다.', dedupeKey: `ai-delegation-checkpoint:${id}:1`, createdAt, readAt: null }
const completed = { id, state: 'completed', childStatus: 'completed', workspaceLease: { leaseId: 'lease' },
  workspaceResult: { status: 'completed' }, integrationOperationId: 'checkpoint', integrationStatus: 'completed', completedAt: updatedAt, updatedAt }
const view = (delegation, notification = notice) => withAiDelegationNotificationStatus(notification, new Map([[delegation.id, delegation]]), new Map())

test('기존 알림에서 콜론이 포함된 위임 ID를 정확히 찾아 해결됨으로 표시하고 원문과 읽음 상태를 보존한다', () => {
  assert.deepEqual(notificationDelegationReference(notice), { id, kind: 'checkpoint' })
  const result = view(completed)
  assert.equal(result.delegationStatus.status, 'resolved')
  assert.equal(notificationTitle(result), '✅ AI 위임 알림 · 해결됨')
  assert.equal(result.message, notice.message)
  assert.equal(result.createdAt, createdAt)
  assert.equal(result.readAt, null)
  assert.equal(notice.delegationStatus, undefined, '저장 원본에 표시 상태를 쓰지 않는다')
})

test('자동 보완 진행과 실패로 사용자의 조치가 필요한 상태를 구분한다', () => {
  const running = { ...completed, state: 'integration-running', workspaceResult: { status: 'checkpoint-required' }, integrationStatus: 'running' }
  assert.equal(notificationTitle(view(running)), '⏳ AI 위임 자동 보완 중')
  for (const state of ['integration-recovery-required', 'integration-waiting-resume', 'recovery-required', 'waiting-child-resume', 'failed', 'parent-wake-failed', 'waiting-integration-clean']) {
    const result = view({ ...running, state })
    assert.equal(result.delegationStatus.status, 'action-required', state)
    assert.equal(notificationTitle(result), '⛔ AI 위임 · 사용자 조치 필요', state)
  }
})

test('복구 재개 중에는 기존 복구 필요 알림을 진행 중으로 바꾼다', () => {
  const recovery = { ...notice, dedupeKey: `ai-delegation-recovery:${id}:abc123` }
  assert.equal(notificationTitle(view({ id, state: 'running' }, recovery)), '⏳ AI 위임 복구 진행 중')
  assert.equal(notificationTitle(view(completed, recovery)), '✅ AI 위임 알림 · 해결됨')
})

test('상위 보고 대기, 수동 종료, 대체, 불완전한 완료 기록을 성공으로 오인하지 않는다', () => {
  for (const state of ['waiting-parent', 'waking-parent']) {
    assert.equal(notificationTitle(view({ ...completed, state })), 'AI 위임 · 결과 전달 대기')
  }
  for (const state of ['closed', 'superseded']) assert.equal(view({ ...completed, state }).delegationStatus.status, 'ended')
  assert.equal(view({ ...completed, childStatus: 'failed' }).delegationStatus.status, 'unknown')
  assert.equal(view({ ...completed, resultCorrection: { phase: 'held' } }).delegationStatus.status, 'action-required')
})

test('완료 이력이 정리된 알림은 완료 영수증으로 판단하고 누락된 기록은 미확인으로 남긴다', () => {
  const receipt = { id, completedAt: updatedAt }
  assert.equal(withAiDelegationNotificationStatus(notice, new Map(), new Map([[id, receipt]])).delegationStatus.status, 'resolved')
  const missing = withAiDelegationNotificationStatus(notice, new Map(), new Map())
  assert.equal(notificationTitle(missing), 'AI 위임 알림 · 상태 확인 필요')
  assert.equal(withAiDelegationNotificationStatus({ ...notice, type: 'mention' }, new Map()).delegationStatus, undefined)
})

test('신규 연결 메타데이터와 이전 한도·통합 정리 대기 알림도 현재 위임에 연결한다', () => {
  assert.equal(view(completed, { ...notice, dedupeKey: '다른 키', delegationId: id, delegationKind: 'recovery' }).delegationStatus.status, 'resolved')
  const key = `ai-delegation-limit:${id}:${id}:operation`
  assert.equal(view({ ...completed, limitNotificationKey: key }, { ...notice, dedupeKey: key }).delegationId, id)
  assert.deepEqual(notificationDelegationReference({ ...notice, dedupeKey: `ai-delegation-integration-clean:${id}:hash` }), { id, kind: 'integration-clean' })
})

test('위임 SSE는 같은 위임의 기존 알림만 갱신하고 새 알림·읽지 않음을 생성하지 않는다', () => {
  const read = { ...notice, readAt: createdAt }
  const other = { ...notice, id: 'other', dedupeKey: `ai-delegation-checkpoint:${id}-other:1` }
  const status = aiDelegationNotificationStatus(completed)
  const result = updateDelegationNotificationStatuses([read, other], status)
  assert.equal(result.length, 2)
  assert.equal(result[0].readAt, createdAt)
  assert.equal(result[0].delegationStatus.status, 'resolved')
  assert.equal(result[1], other)
  const stale = { ...status, status: 'in-progress', updatedAt: createdAt }
  assert.equal(updateDelegationNotificationStatuses(result, stale)[0], result[0], '늦게 온 과거 이벤트로 해결됨을 되돌리지 않는다')
})
