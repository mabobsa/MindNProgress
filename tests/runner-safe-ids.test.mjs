import assert from 'node:assert/strict'
import test from 'node:test'
import { aiDelegationClosureAvailability, isValidAiDelegationId } from '../server/lib/aiDelegations.mjs'
import {
  aiDelegationReadsChildOperation,
  aiDelegationRunnerRejectedClosable,
  aiDelegationRunnerRejectionPatch,
  isNewAiDelegationIdAllowed,
  isNewGroupDocumentInstructionIdAllowed,
  isRunnerOperationRejected,
  runnerRejectsOperationId,
  runnerSafeOperationIdPart,
} from '../server/lib/runnerSafeIds.mjs'

const runnerRejected = Object.assign(new Error('Runner operation is not allowed.'), {
  status: null, code: 'RUNNER_OPERATION_REJECTED', reasonCode: 'REMOTE_REQUEST_FAILED',
})

test('새 위임·그룹 지시 ID는 서브 머신 Runner가 허용하는 문자만 받고 기존 콜론 ID는 계속 읽는다', () => {
  assert.equal(isNewAiDelegationIdAllowed('v623-node-mwcz8s59-8a8491-proto-notes'), true)
  assert.equal(isNewAiDelegationIdAllowed('v623_card_1'), true)
  assert.equal(isNewAiDelegationIdAllowed('v623:node-mwcz8s59-8a8491:proto-notes'), false)
  assert.equal(isNewAiDelegationIdAllowed('-leading-hyphen'), false)
  assert.equal(isNewAiDelegationIdAllowed('a'.repeat(129)), false)
  assert.equal(isNewGroupDocumentInstructionIdAllowed('group-3-map-lobby-v7'), true)
  assert.equal(isNewGroupDocumentInstructionIdAllowed('group:3-map-lobby-v7'), false)
  assert.equal(isNewGroupDocumentInstructionIdAllowed('a'.repeat(97)), false)
  // 저장된 기록 형식은 바꾸지 않는다. 바꾸면 서버 시작 때 기존 콜론 위임을 읽지 않고 다음 저장에서 지운다.
  assert.equal(isValidAiDelegationId('v623:node-mwcz8s59-8a8491:proto-notes'), true)
})

test('Runner 실행 ID 조각은 허용 문자면 그대로 두고 아니면 결정적으로 치환해 충돌을 피한다', () => {
  assert.equal(runnerSafeOperationIdPart('group-instruction-first'), 'group-instruction-first')
  const colon = runnerSafeOperationIdPart('a:b')
  assert.match(colon, /^a-b-[a-f0-9]{12}$/)
  assert.equal(runnerSafeOperationIdPart('a:b'), colon)
  assert.notEqual(runnerSafeOperationIdPart('a/b'), colon)
  assert.notEqual(colon, 'a-b')
})

test('Runner 거부만 위임에 한 번 기록하고 같은 실행 ID는 다시 저장하지 않는다', () => {
  const delegation = { id: 'v1:card:legacy', childOperationId: 'v1:card:legacy', state: 'starting' }
  assert.equal(isRunnerOperationRejected(runnerRejected), true)
  assert.equal(isRunnerOperationRejected(Object.assign(new Error('timeout'), { code: 'RESULT_TIMEOUT' })), false)
  assert.equal(aiDelegationRunnerRejectionPatch(delegation, new Error('fetch failed'), { operationId: delegation.id }), null)

  const patch = aiDelegationRunnerRejectionPatch(delegation, runnerRejected, { operationId: delegation.id, machineId: 'macbook' }, '2026-11-12T10:00:00.000Z')
  assert.deepEqual(patch, { runnerRejection: {
    code: 'RUNNER_OPERATION_REJECTED', operationId: 'v1:card:legacy', machineId: 'macbook',
    message: 'Runner operation is not allowed.', observedAt: '2026-11-12T10:00:00.000Z',
  } })
  assert.equal(aiDelegationRunnerRejectionPatch({ ...delegation, ...patch }, runnerRejected, { operationId: delegation.id }), null)
  // 실행 ID가 Runner 규칙에 맞으면 결과 수집 등 다른 요청의 거부이므로 이 실행 ID의 원인으로 남기지 않는다.
  assert.equal(runnerRejectsOperationId('v1-card-safe'), false)
  assert.equal(runnerRejectsOperationId('v1:card:legacy'), true)
  assert.equal(aiDelegationRunnerRejectionPatch({ ...delegation, childOperationId: 'v1-card-safe' }, runnerRejected, { operationId: 'v1-card-safe' }), null)
})

test('하위 실행 ID 조회가 Runner에서 거부된 위임만 사용자 종료 후보가 된다', () => {
  const base = { id: 'v1:card:legacy', childOperationId: 'v1:card:legacy', state: 'starting', workspaceLease: null }
  const rejected = { ...base, runnerRejection: { code: 'RUNNER_OPERATION_REJECTED', operationId: 'v1:card:legacy' } }

  assert.deepEqual(aiDelegationClosureAvailability(base), { closeAvailable: false, reason: 'execution-or-recovery-still-active' })
  assert.deepEqual(aiDelegationClosureAvailability(rejected), { closeAvailable: true, reason: 'runner-rejected-operation' })
  for (const state of ['waiting-resource', 'running', 'waiting-child-resume']) {
    assert.equal(aiDelegationClosureAvailability({ ...rejected, state }).closeAvailable, true, state)
  }

  // 작업공간·그룹·복구가 걸렸거나 다른 실행 ID의 거부면 기존 판정을 유지한다.
  assert.equal(aiDelegationRunnerRejectedClosable({ ...rejected, workspaceLease: { leaseId: 'lease-1' } }), false)
  assert.deepEqual(aiDelegationClosureAvailability({ ...rejected, groupId: 'group-1' }), { closeAvailable: false, reason: 'group-managed' })
  assert.equal(aiDelegationClosureAvailability({ ...rejected, pendingRecovery: { operationId: 'recover-1' } }), null)
  assert.equal(aiDelegationRunnerRejectedClosable({ ...rejected, recoveryDispatchRejection: { operationId: 'x' } }), false)
  assert.equal(aiDelegationRunnerRejectedClosable({ ...rejected, runnerRejection: { operationId: 'other' } }), false)
  assert.equal(aiDelegationRunnerRejectedClosable({ ...rejected, state: 'waiting-parent' }), false)
  assert.equal(aiDelegationClosureAvailability({ ...rejected, state: 'closed' }), null)

  assert.equal(aiDelegationReadsChildOperation(base), true)
  assert.equal(aiDelegationReadsChildOperation({ ...base, state: 'waking-parent' }), false)
  assert.equal(aiDelegationReadsChildOperation({ ...base, pendingRecovery: { operationId: 'recover-1' } }), false)
})
