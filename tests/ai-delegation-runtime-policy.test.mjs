import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDelegationRuntimeSelection, delegationResumeRuntimePolicy, delegationRuntimeCandidateMatches, ensureDelegationRuntimePolicy } from '../server/lib/aiDelegationRuntimePolicy.mjs'

const policy = { modelId: 'gpt-6-astra', thoughtLevelId: 'xhigh' }
function runtimeFixture({ level = 'high', busy = false, source = 'runtime', confirmation = 'observed', apply = true,
  supported = true, readyAfter = 0, busyAfter = Infinity, latencyMs = 0, modelId = policy.modelId,
  backend = 'codex', modelSupported = true, modelApply = true, modelConfirmation = 'observed',
  oldModelEfforts = null, effortsReadyAfter = 0, firstEnsureMs = 0 } = {}) {
  const calls = []
  let time = 0
  let ensureCount = 0
  return { calls, run: (required = policy, extra = {}) => ensureDelegationRuntimePolicy({ conversationId: 'existing', machineId: 'machine', policy: required,
    now: () => time, wait: async ms => { time += ms }, ...extra,
    fetchOn: async (machine, url, options) => {
      assert.equal(machine, 'machine'); calls.push({ url, ...options, at: time }); time += latencyMs
      // 쉬던 대화의 세션 복원처럼 첫 runtime/ensure만 오래 걸리는 경우를 흉내 낸다.
      // 제한보다 늦게 돌아온 응답은 호출 직후의 남은 시간 확인에서 시간 초과로 처리된다(실제 대기 없이 시험).
      if (url.endsWith('/runtime/ensure') && ensureCount++ === 0) time += firstEnsureMs
      if (url.endsWith('/runtime-config')) return { model: { value: modelId, source },
        thought_level: { value: level, source: time >= readyAfter ? source : 'snapshot' } }
      if (options.method === 'PUT') {
        if (url.endsWith('/config-options/model')) { if (modelApply) modelId = options.body.value; return { confirmation: modelConfirmation } }
        if (apply) level = options.body.value; return { confirmation }
      }
      return { extra: { backend }, runtime: { state: busy || time >= busyAfter ? 'running' : 'idle', is_processing: busy }, config_options: time < readyAfter ? [] : [
        { id: 'model', category: 'model', options: (modelSupported ? ['gpt-6.1-sol', policy.modelId] : ['gpt-6.1-sol']).map(value => ({ value })) },
        { id: 'reasoning/effort', category: 'thought_level', options: (time < effortsReadyAfter ? [] : modelId !== policy.modelId && oldModelEfforts ? oldModelEfforts : supported ? ['high', 'xhigh', 'max'] : ['high']).map(value => ({ value })) },
      ] }
    } }) }
}

const modelPolicy = { ...policy, backend: 'codex' }
// 실행 환경 준비(대화 확인 + 첫 ensure)는 90초, 그 뒤 실행 설정 확인은 첫 ensure 완료 시각부터 30초 제한을 쓴다.
const assertPhaseTimeouts = (calls, configStartAt) => {
  const firstEnsure = calls.findIndex(c => c.url.endsWith('/runtime/ensure'))
  calls.forEach((c, index) => assert.equal(c.timeoutMs, index <= firstEnsure ? 90_000 - c.at : configStartAt + 30_000 - c.at, `${index}: ${c.url}`))
}
test('같은 CLI의 모델 변경도 자동 위임 제한 모델을 우회하지 않는다', async () => {
  const fixture = runtimeFixture({ modelId: 'gpt-6.1-sol' })
  await assert.rejects(fixture.run({ ...modelPolicy, modelId: 'gpt-6-sol' }), { code: 'AI_DELEGATION_POLICY_RUNTIME_MODEL_BLOCKED' })
  assert.equal(fixture.calls.some(c => c.method === 'PUT'), false)
})
test('모델을 바꾼 뒤 새 모델의 사고 레벨 목록으로 적용하며 대화 ID를 유지한다', async () => {
  const fixture = runtimeFixture({ modelId: 'gpt-6.1-sol', oldModelEfforts: ['high'] })
  const result = await fixture.run(modelPolicy)
  assert.equal(result.conversationId, 'existing')
  assert.equal(result.previousModelId, 'gpt-6.1-sol')
  assert.equal(result.modelId, policy.modelId)
  assert.equal(result.modelChanged, true)
  assert.deepEqual(fixture.calls.filter(c => c.method === 'PUT').map(c => c.body.value), ['gpt-6-astra', 'xhigh'])
  assert.ok(fixture.calls.every(c => c.url.startsWith('/api/conversations/existing')))
})

for (const [options, code] of [
  [{ backend: 'claude' }, 'BACKEND_MISMATCH'], [{ modelSupported: false }, 'MODEL_UNSUPPORTED'],
  [{ modelApply: false }, 'MODEL_MISMATCH'], [{ modelConfirmation: 'command_ack' }, 'MODEL_UNCONFIRMED'],
  [{ supported: false }, 'UNSUPPORTED'], [{ effortsReadyAfter: Infinity }, 'READINESS_TIMEOUT'],
]) test(`모델 변경 경로의 ${code}를 확인하면 위임을 중단한다`, async () => {
  const fixture = runtimeFixture({ modelId: 'gpt-6.1-sol', ...options })
  await assert.rejects(fixture.run(modelPolicy), { code: `AI_DELEGATION_POLICY_RUNTIME_${code}` })
  assert.equal(fixture.calls.some(c => c.url.endsWith('/config-options/reasoning%2Feffort')), false)
})

test('모델과 사고 레벨 준비는 하나의 30초 제한을 공유하며 모델 변경은 재전송하지 않는다', async () => {
  const fixture = runtimeFixture({ modelId: 'gpt-6.1-sol', readyAfter: 10_000, effortsReadyAfter: 25_000 })
  await fixture.run(modelPolicy)
  const writes = fixture.calls.filter(c => c.method === 'PUT')
  assert.deepEqual(writes.map(c => [c.body.value, c.at]), [['gpt-6-astra', 10_000], ['xhigh', 25_000]])
  assertPhaseTimeouts(fixture.calls, 0)
})

test('실행 환경 준비가 30초를 넘겨도 90초 안이면 이어서 설정을 확인하고, 확인은 준비 완료 시각부터 30초를 쓴다', async () => {
  // 2026-11-15 문맥 94% 검수 대화처럼 세션 복원에 60초가 걸린 경우
  const fixture = runtimeFixture({ level: 'max', firstEnsureMs: 60_000 })
  const result = await fixture.run({ ...policy, thoughtLevelId: 'max' })
  assert.equal(result.changed, false)
  assertPhaseTimeouts(fixture.calls, 60_000)
  // 준비 뒤 카탈로그가 25초 뒤 도착해도 새 30초 제한 안이면 적용한다.
  const late = runtimeFixture({ firstEnsureMs: 60_000, readyAfter: 85_000 })
  assert.equal((await late.run()).thoughtLevelId, 'xhigh')
  assertPhaseTimeouts(late.calls, 60_000)
})

test('실행 환경 준비가 제한을 넘기면 변경 없이 중단하고 접수 요청 경로는 30초 제한을 쓴다', async () => {
  const slow = runtimeFixture({ firstEnsureMs: 95_000 })
  await assert.rejects(slow.run(), { code: 'AI_DELEGATION_POLICY_RUNTIME_READINESS_TIMEOUT', message: /실행 환경 준비가 90초/ })
  assert.equal(slow.calls.some(c => c.method === 'PUT'), false)
  const requestPath = runtimeFixture({ firstEnsureMs: 40_000 })
  await assert.rejects(requestPath.run(policy, { startTimeoutMs: 30_000 }), { message: /실행 환경 준비가 30초/ })
  assert.equal(requestPath.calls.some(c => c.method === 'PUT'), false)
})

test('대기열의 새 정책은 CLI를 확인하고 구형 정책은 모델 일치를 유지하며 표시값도 갱신한다', () => {
  assert.equal(delegationRuntimeCandidateMatches(modelPolicy, 'gpt-6.1-sol', 'codex'), true)
  assert.equal(delegationRuntimeCandidateMatches(modelPolicy, policy.modelId, 'claude'), false)
  assert.equal(delegationRuntimeCandidateMatches(policy, 'gpt-6.1-sol', 'codex'), false)
  const selection = { model: { id: 'gpt-6.1-sol', label: 'Sol' }, mode: { id: 'auto' } }
  applyDelegationRuntimeSelection(selection, modelPolicy)
  assert.equal(selection.model.id, policy.modelId)
  assert.equal(selection.thoughtLevel.id, 'xhigh')
  assert.equal(selection.mode.id, 'auto')
})

test('동일 대화의 실제 사고 강도를 xhigh 또는 max로 바꾸고 다시 확인한다', async () => {
  for (const thoughtLevelId of ['xhigh', 'max']) {
    const fixture = runtimeFixture()
    const result = await fixture.run({ ...policy, thoughtLevelId })
    assert.equal(result.previousThoughtLevel, 'high'); assert.equal(result.thoughtLevelId, thoughtLevelId)
    assert.equal(result.changed, true)
    assert.equal(fixture.calls.filter(c => c.url.endsWith('/runtime-config')).length, 2)
    assert.ok(fixture.calls.some(c => c.url.endsWith('/config-options/reasoning%2Feffort') && c.body.value === thoughtLevelId))
  }
})
test('일치하는 런타임은 변경하지 않고 기존 작업 복구·명시적 예외에는 규칙을 적용하지 않는다', async () => {
  const fixture = runtimeFixture({ level: 'xhigh' })
  assert.equal((await fixture.run()).changed, false)
  assert.equal(fixture.calls.some(c => c.method === 'PUT'), false)
  for (const value of [delegationResumeRuntimePolicy('new', policy), delegationResumeRuntimePolicy('resume', null), delegationResumeRuntimePolicy('resume', policy, true)]) {
    const skipped = runtimeFixture(); assert.equal(await skipped.run(value), null); assert.equal(skipped.calls.length, 0)
  }
})
for (const [options, reason] of [
  [{ busy: true }, 'BUSY'], [{ source: 'snapshot' }, 'READINESS_TIMEOUT'], [{ modelId: 'wrong-model' }, 'MODEL_MISMATCH'], [{ supported: false }, 'UNSUPPORTED'],
  [{ confirmation: 'command_ack' }, 'UNCONFIRMED'], [{ apply: false }, 'MISMATCH'],
]) test(`규칙 확인 실패(${reason})는 작업 전 오류로 반환한다`, async () => {
  await assert.rejects(runtimeFixture(options).run(), { code: `AI_DELEGATION_POLICY_RUNTIME_${reason}` })
})

test('카탈로그가 10초 뒤 준비되면 한 번만 변경하고 실제 적용을 확인한다', async () => {
  const fixture = runtimeFixture({ readyAfter: 10_000 })
  const result = await fixture.run()
  assert.equal(result.thoughtLevelId, 'xhigh')
  const writes = fixture.calls.filter(c => c.method === 'PUT')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].at, 10_000)
  assert.equal(writes[0].timeoutMs, 20_000)
  assert.equal(fixture.calls.some(c => c.url.endsWith('/config-options')), false, '존재하지 않는 GET API를 호출하지 않는다.')
})

test('저장된 xhigh만으로 통과하지 않고 실제 런타임에서 확인한 뒤 변경 없이 진행한다', async () => {
  const fixture = runtimeFixture({ level: 'xhigh', readyAfter: 10_000 })
  assert.equal((await fixture.run()).changed, false)
  assert.ok(fixture.calls.at(-1).at >= 10_000)
  assert.equal(fixture.calls.some(c => c.method === 'PUT'), false)
})

for (const latencyMs of [0, 2_000]) test(`목록이 준비되지 않으면 API 지연 ${latencyMs}ms도 포함해 실행 환경 준비 뒤 30초에서 종료한다`, async () => {
  const fixture = runtimeFixture({ readyAfter: Infinity, latencyMs })
  await assert.rejects(fixture.run(), { code: 'AI_DELEGATION_POLICY_RUNTIME_READINESS_TIMEOUT', message: /실행 설정·사고 레벨/ })
  assert.equal(fixture.calls.some(c => c.method === 'PUT'), false)
  // 대화 확인과 첫 ensure의 지연(각 latencyMs)이 끝난 시각부터 설정 확인 30초가 시작된다.
  const configStartAt = latencyMs * 2
  assert.ok(fixture.calls.every(c => c.at < configStartAt + 30_000))
  assertPhaseTimeouts(fixture.calls, configStartAt)
  assert.ok(fixture.calls.length <= 121)
})

test('목록 대기 중 다른 작업이 시작되면 변경하지 않고 중단한다', async () => {
  const fixture = runtimeFixture({ readyAfter: 10_000, busyAfter: 1_000 })
  await assert.rejects(fixture.run(), { code: 'AI_DELEGATION_POLICY_RUNTIME_BUSY' })
  assert.equal(fixture.calls.some(c => c.method === 'PUT'), false)
})

test('조회 응답 자체가 돌아오지 않아도 실행 환경 준비 제한(90초)으로 종료한다', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  let settled = false
  const pending = ensureDelegationRuntimePolicy({ conversationId: 'stalled', policy, now: () => 0,
    fetchOn: async (_machine, url) => { calls.push(url); return new Promise(() => {}) } })
  pending.catch(() => {}).finally(() => { settled = true })
  const rejected = assert.rejects(pending, { code: 'AI_DELEGATION_POLICY_RUNTIME_READINESS_TIMEOUT' })
  t.mock.timers.tick(30_000)
  await Promise.resolve()
  assert.equal(settled, false, '실행 환경 준비 단계는 30초에서 끝내지 않는다.')
  t.mock.timers.tick(60_000)
  await rejected
  assert.equal(calls.length, 1, '응답이 늦은 호출 뒤 변경·실행 요청을 추가하지 않는다.')
})
