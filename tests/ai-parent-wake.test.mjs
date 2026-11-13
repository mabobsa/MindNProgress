import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createAiParentWakeProcessor, parentWakeFailureDiagnostic, recoverableLegacyParentWake } from '../server/lib/aiParentWake.mjs'
import { acknowledgeAiDelegationReport, aiDelegationStoredReportDeliveryPatch } from '../server/lib/aiDelegationReports.mjs'
import { RuntimeStoppingError } from '../server/lib/runtimeStopping.mjs'
import { groupDelegationReportHint } from '../src/utils/groupOverview.mjs'
import { aiDelegationStartupFailureInstruction, queuedDelegationFailureReportPatch } from '../server/lib/aiDelegationStartupFailure.mjs'
import { aiDelegationReportStatus } from '../server/lib/aiDelegationReports.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const networkError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('private socket detail'), { code: 'ECONNRESET' }) })
function fixture() {
  const d = { id: 'wake-test', state: 'waiting-parent', parentConversationId: 'parent', childStatus: 'completed',
    childTurnId: 'child-turn', childResultTurnId: 'child-turn', childResultSnapshot: '보존된 결과', childResultHash: hash('보존된 결과'),
    workspaceLease: { leaseId: 'completed-lease' }, workspaceResult: { status: 'completed', integratedCommit: 'main-commit' } }
  d.reportArchive = { status: 'recorded', operationId: `mnp-report-${hash(JSON.stringify([d.id, 'parent', 'child-turn', d.childResultHash]))}`,
    messageId: `external-report-${hash('message')}`, content: '완료 보고 전문', contentHash: hash('완료 보고 전문') }
  return d
}
function harness(initial = fixture()) {
  let stored = structuredClone(initial)
  let time = Date.parse('2026-10-15T09:00:00Z')
  const requests = [], warnings = [], operations = new Map()
  const controls = { busy: false, runtimeError: null, capabilityError: null, lostResponse: false, statusError: null }
  const options = {
    get: () => stored, values: () => [stored], update: async (_id, patch) => (stored = { ...stored, ...patch, updatedAt: new Date(time).toISOString() }),
    archive: async d => d, coordinationPending: async () => false, capabilities: async () => {
      if (controls.capabilityError) throw controls.capabilityError
      return { historyOnlyReports: true }
    },
    parentMachineId: () => 'main', runtime: async () => {
      if (controls.runtimeError) throw controls.runtimeError
      return { state: controls.busy ? 'running' : 'idle', turnId: controls.busy ? 'busy-turn' : null }
    }, normalizeRuntime: (_id, value) => value, instruction: async () => '완료 보고 전문', operationId: (id, suffix) => `${id}-${suffix}`,
    now: () => time, warn: (...args) => warnings.push(args),
    fetchOn: async (machineId, pathname, input = {}) => {
      requests.push({ machineId, pathname, ...input })
      if (input.method === 'POST') {
        assert.equal(stored.state, 'waking-parent')
        assert.equal(stored.wakeOperationId, input.body.operationId, 'POST 전에 intent가 저장된다.')
        assert.equal(input.noMutationRetry, true, '전송 오류 뒤 다른 base URL로 POST를 반복하지 않는다.')
        const dispatch = { operationId: input.body.operationId, conversationId: 'parent', state: 'running', turnId: 'parent-turn' }
        operations.set(input.body.operationId, dispatch)
        if (controls.lostResponse) throw networkError()
        return dispatch
      }
      if (controls.statusError) throw controls.statusError
      const status = operations.get(pathname.split('/').at(-1))
      if (!status) throw Object.assign(new Error('not found'), { status: 404 })
      return status
    },
  }
  return { options, controls, requests, warnings, operations, get stored() { return stored },
    advance: (ms = 61_000) => { time += ms }, replace: d => { stored = d },
    process: () => createAiParentWakeProcessor(options)(stored) }
}

for (const lostResponse of [false, true]) test(`접수 후 시작 실패를 상위에 한 번 전달하고 실패 상태를 유지한다(응답 유실=${lostResponse})`, async () => {
  const initial = { id: 'rejected', mapId: 'map', parentConversationId: 'parent', targetConversationId: 'child',
    ...queuedDelegationFailureReportPatch({ state: 'failed', childStatus: 'rejected',
      childError: '사고 레벨 목록 준비 시간 초과', failureReasonCode: 'AI_DELEGATION_POLICY_RUNTIME_READINESS_TIMEOUT' }) }
  const h = harness(initial)
  h.options.instruction = aiDelegationStartupFailureInstruction
  h.controls.busy = true
  await h.process()
  assert.equal(h.stored.reportWaitReason, 'parent-busy')
  assert.equal(h.requests.length, 0)
  h.controls.busy = false; h.controls.lostResponse = lostResponse
  await h.process()
  assert.match(h.requests[0].body.instruction, /위임 시작 실패 알림/)
  assert.match(h.requests[0].body.instruction, /AI_DELEGATION_POLICY_RUNTIME_READINESS_TIMEOUT/)
  if (lostResponse) {
    assert.equal(h.stored.state, 'waking-parent')
    h.advance(); await h.process()
  }
  assert.equal(h.stored.state, 'failed')
  assert.equal(h.stored.childStatus, 'rejected')
  assert.equal(h.stored.reportReceipt.kind, 'startup-failure')
  assert.equal(aiDelegationReportStatus(h.stored), 'received')
  await h.process()
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1)
  assert.equal(h.requests[0].body.targetConversationId, 'parent')
  assert.equal(h.requests[0].body.workspaceLease, undefined)
})

test('기존 실패 기록을 자동 재전송하지 않고 lease 복구 필요 상태를 보존한다', async () => {
  const h = harness({ id: 'old-failure', parentConversationId: 'parent', state: 'failed', childStatus: 'rejected' })
  await h.process(); assert.equal(h.requests.length, 0)
  const recovery = { state: 'recovery-required', childStatus: 'interrupted' }
  assert.deepEqual(queuedDelegationFailureReportPatch(recovery), recovery)
})

test('busy→idle은 관측 시각·턴을 남기고 원 결과로 상위를 한 번만 재개한다', async () => {
  const h = harness(); h.controls.busy = true
  await h.process()
  assert.equal(h.stored.reportWaitReason, 'parent-busy')
  assert.equal(h.stored.parentRuntimeObservation.turnId, 'busy-turn')
  assert.ok(h.stored.parentRuntimeObservation.observedAt)
  assert.equal(h.requests.length, 0)
  h.controls.busy = false; await h.process()
  assert.equal(h.stored.state, 'completed')
  assert.equal(h.stored.reportReceipt.method, 'dispatch-delivered')
  assert.equal(h.stored.parentWakeRetry.status, 'received')
  await h.process()
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.stored.workspaceResult, fixture().workspaceResult)
})

for (const phase of ['capabilities', 'parent-runtime']) test(`${phase} 일시 실패는 busy 흔적을 지우고 재시작 뒤 저장된 간격으로 복구한다`, async () => {
  const h = harness({ ...fixture(), reportWaitReason: 'parent-busy' })
  h.controls[phase === 'capabilities' ? 'capabilityError' : 'runtimeError'] = networkError()
  await h.process()
  assert.equal(h.stored.state, 'waiting-parent')
  assert.equal(h.stored.reportWaitReason, null)
  assert.equal(h.stored.parentDispatchState, 'not-sent')
  assert.equal(h.stored.parentWakeRetry.lastFailure.phase, phase)
  assert.deepEqual(h.stored.parentWakeRetry.lastFailure.causeCodes, ['ECONNRESET'])
  assert.equal(Date.parse(h.stored.parentWakeRetry.nextAttemptAt) - Date.parse(h.stored.parentWakeRetry.lastAttemptAt), 5000)
  assert.match(groupDelegationReportHint(h.stored), /자동 재시도/)
  const restarted = harness(JSON.parse(JSON.stringify(h.stored)))
  await restarted.process(); assert.equal(restarted.requests.length, 0)
  restarted.advance(); await restarted.process()
  assert.equal(restarted.stored.state, 'completed')
  assert.equal(restarted.requests.length, 1)
  assert.equal(restarted.stored.parentWakeFailures[0].phase, phase)
})

test('연속 조회 실패는 60초까지 지수 대기하며 복구 가능한 항목을 실패 종결하지 않는다', async () => {
  const h = harness(); h.controls.runtimeError = networkError()
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000, 60000]) {
    await h.process()
    assert.equal(h.stored.state, 'waiting-parent')
    assert.equal(Date.parse(h.stored.parentWakeRetry.nextAttemptAt) - Date.parse(h.stored.parentWakeRetry.lastAttemptAt), delay)
    h.advance()
  }
  assert.equal(h.stored.parentWakeRetry.attempt, 7)
  assert.equal(h.stored.parentWakeFailures.length, 5, '오류 이력 크기는 제한한다.')
  assert.equal(h.requests.length, 0)
})

test('POST 접수 후 응답 유실·재시작은 같은 operation 조회로만 수신을 확인한다', async () => {
  const h = harness(); h.controls.lostResponse = true
  await h.process()
  assert.equal(h.stored.state, 'waking-parent')
  assert.equal(h.stored.parentWakeRetry.phase, 'dispatch-status')
  const operation = h.stored.wakeOperationId
  const restarted = harness(JSON.parse(JSON.stringify(h.stored)))
  restarted.operations.set(operation, h.operations.get(operation))
  restarted.advance(); restarted.controls.statusError = networkError(); await restarted.process()
  assert.equal(restarted.stored.state, 'waking-parent')
  restarted.advance(); restarted.controls.statusError = null; await restarted.process()
  assert.equal(restarted.stored.state, 'completed')
  assert.equal(restarted.stored.wakeOperationId, operation)
  assert.equal(restarted.stored.parentWakeAttempt, 1)
  assert.ok(restarted.requests.every(r => r.method !== 'POST'))
})

test('전송 intent 저장 직후 중단되면 재시작 후 조회만 하고 404를 새 전송으로 우회하지 않는다', async () => {
  const h = harness()
  await assert.rejects(createAiParentWakeProcessor({ ...h.options, fetchOn: async () => { throw new RuntimeStoppingError() } })(h.stored), RuntimeStoppingError)
  assert.equal(h.stored.state, 'waking-parent')
  assert.equal(h.stored.parentWakeFailures, undefined)
  await h.process()
  assert.equal(h.stored.state, 'parent-wake-failed')
  assert.equal(h.stored.parentWakeRetry.stopReason, 'HTTP_404')
  assert.match(groupDelegationReportHint(h.stored), /자동 복구를 중지/)
  assert.ok(h.requests.every(r => r.method !== 'POST'))
})

for (const [label, patch] of [
  ['다른 대화', { conversationId: 'other' }], ['다른 operation', { operationId: 'other' }],
  ['턴 근거 없음', { turnId: null }], ['Core 재시작', { state: 'recovery_required' }],
]) test(`${label}: 상태 조회를 성공 수신이나 새 실행으로 바꾸지 않는다`, async () => {
  const h = harness(); h.controls.lostResponse = true; await h.process()
  h.operations.set(h.stored.wakeOperationId, { ...h.operations.get(h.stored.wakeOperationId), ...patch })
  h.advance(); await h.process()
  assert.equal(h.stored.state, 'parent-wake-failed')
  assert.equal(h.stored.reportReceipt, null)
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1)
  assert.equal(h.stored.parentWakeRetry.status, 'stopped')
})

test('권한 오류는 사전 조회 중단으로 표시하고 새 턴을 실행하지 않는다', async () => {
  const h = harness(); h.controls.runtimeError = Object.assign(new Error('forbidden'), { status: 403 })
  await h.process()
  assert.equal(h.stored.parentWakeRetry.status, 'stopped')
  assert.equal(h.stored.parentWakeRetry.nextAttemptAt, null)
  assert.equal(h.stored.parentWakeRetry.lastFailure.pathname, '/api/conversations/parent')
  assert.equal(h.requests.length, 0)
})

test('머신 비활성·미등록은 네트워크 재시도로 숨기지 않는다', async () => {
  for (const reasonCode of ['MACHINE_DISABLED', 'MACHINE_UNREGISTERED', 'RUNNER_NOT_CONFIGURED']) {
    const h = harness(); h.controls.runtimeError = Object.assign(new Error('설정 확인 필요'), { reasonCode })
    await h.process()
    assert.equal(h.stored.parentWakeRetry.status, 'stopped')
    assert.equal(h.stored.parentWakeRetry.stopReason, reasonCode)
    assert.equal(h.requests.length, 0)
  }
})

test('중복 폴링은 같은 완료 보고를 두 번 전송하지 않는다', async () => {
  const h = harness()
  const processor = createAiParentWakeProcessor(h.options)
  await Promise.all([processor(h.stored), processor(h.stored), processor(h.stored)])
  assert.equal(h.requests.length, 1)
  const restored = aiDelegationStoredReportDeliveryPatch({ ...h.stored, state: 'waking-parent' })
  assert.equal(typeof restored.reportReceipt.at, 'string')
  assert.equal(restored.parentWakeRetry.status, 'received')
})

test('전송 뒤 결과가 변조되면 완료 응답도 수신 근거로 사용하지 않는다', async () => {
  const h = harness(); h.controls.lostResponse = true; await h.process()
  h.replace({ ...h.stored, childResultSnapshot: '다른 원문' })
  h.advance(); await h.process()
  assert.equal(h.stored.state, 'parent-wake-failed')
  assert.equal(h.stored.parentWakeRetry.stopReason, 'REPORT_DELIVERY_UNVERIFIED')
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1)
})

test('이미 수신한 결과와 승인 대기·실제 실행 실패는 레거시 자동 복구 대상이 아니다', async () => {
  const base = { ...fixture(), state: 'parent-wake-failed', parentError: 'fetch failed', parentDispatchState: 'unknown' }
  assert.equal(recoverableLegacyParentWake(base), true)
  for (const patch of [{ reportReceipt: {} }, { reportApprovalRequired: true }, { state: 'completed' },
    { state: 'closed' }, { parentWakeRetry: { status: 'stopped' } }, { childStatus: 'failed' }, { parentError: 'arbitrary' }]) {
    assert.equal(recoverableLegacyParentWake({ ...base, ...patch }), false)
  }
  const h = harness(base); await h.process()
  assert.equal(h.stored.state, 'waiting-parent')
  assert.equal(h.stored.parentWakeRetry.restoredAt, '2026-10-15T09:00:00.000Z')
  await h.process(); assert.equal(h.stored.state, 'completed')
})

for (const phase of ['runtime', 'dispatch']) test(`수신 확인과 ${phase} 대기가 경합해도 늦은 응답이 완료를 되돌리지 않는다`, async () => {
  const h = harness()
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const options = { ...h.options, [phase === 'runtime' ? 'runtime' : 'fetchOn']: async (...args) => {
    entered(); await gate; return h.options[phase === 'runtime' ? 'runtime' : 'fetchOn'](...args)
  } }
  const process = createAiParentWakeProcessor(options)
  const pending = process(h.stored); await started
  const receipt = acknowledgeAiDelegationReport(h.stored, { conversationId: 'parent', resultHash: h.stored.childResultHash })
  h.replace({ ...h.stored, ...receipt })
  release(); await pending
  assert.equal(h.stored.state, 'completed')
  assert.equal(h.stored.reportReceipt.method, 'parent-acknowledged')
  assert.equal(typeof h.stored.reportReceipt.at, 'string')
  if (h.stored.parentWakeRetry) assert.equal(h.stored.parentWakeRetry.status, 'received')
  await process(h.stored)
  assert.equal(h.requests.length, phase === 'runtime' ? 0 : 1)
})

test('진단은 안전한 원인 코드·대상 origin만 남기고 토큰·본문·URL query는 버린다', () => {
  const error = new Error('Bearer private-secret 완료 전문'); error.code = 'ECONNRESET'
  error.requestOrigin = 'http://user:password@localhost:7777/path?token=secret'
  error.cause = { code: 'ENOTFOUND', message: 'sensitive', errors: [{ code: 'EAI_AGAIN' }] }
  const d = parentWakeFailureDiagnostic(error, { phase: 'parent-runtime', method: 'GET', pathname: '/api/conversations/parent', at: 'now', machineId: 'main' })
  assert.equal(d.category, 'dns'); assert.equal(d.origin, 'http://localhost:7777')
  assert.deepEqual(d.causeCodes, ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'])
  assert.doesNotMatch(JSON.stringify(d), /password|secret|sensitive|완료 전문/)
})

test('통합 재시도 접수·검증 중에는 실패 보고를 보내거나 완료 상태를 대사하지 않는다', async () => {
  for (const state of ['waiting-parent', 'waking-parent']) {
    for (const status of ['queued', 'checking']) {
      const h = harness({ ...fixture(), state, workspaceResult: { status: 'quarantined', childStatus: 'completed' },
        wakeOperationId: 'old-wake', parentDispatchState: 'waiting-resume', integrationRecoveryRequest: { status } })
      const before = structuredClone(h.stored)
      const processor = createAiParentWakeProcessor({ ...h.options,
        runtime: async () => assert.fail('복구 검증 중 상위 대화를 재개하지 않는다.'),
        fetchOn: async () => assert.fail('복구 검증 중 이전 보고 완료를 조회하지 않는다.') })
      await processor(h.stored)
      assert.deepEqual(h.stored, before)
    }
  }
})

test('통합 재시도 접수와 경합한 이전 상위 보고의 완료 응답은 복구 상태를 덮어쓰지 않는다', async () => {
  const h = harness({ ...fixture(), state: 'waking-parent', wakeOperationId: 'old-wake',
    parentDispatchState: 'waiting-resume', workspaceResult: { status: 'quarantined', childStatus: 'completed' } })
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const processor = createAiParentWakeProcessor({ ...h.options, fetchOn: async () => {
    entered(); await gate
    return { operationId: 'old-wake', conversationId: 'parent', state: 'completed', turnId: 'old-report-turn' }
  } })
  const pending = processor(h.stored)
  await started
  h.replace({ ...h.stored, integrationRecoveryRequest: { requestId: 'new-recovery', status: 'queued' } })
  const accepted = structuredClone(h.stored)
  release(); await pending
  assert.deepEqual(h.stored, accepted, '늦은 보고 완료로 failed 전환·복구 snapshot 변경을 하지 않는다.')
})
