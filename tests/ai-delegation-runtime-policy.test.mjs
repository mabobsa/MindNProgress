import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDelegationRuntimeSelection, delegationResumeRuntimePolicy, delegationRuntimeCandidateMatches, ensureDelegationRuntimePolicy } from '../server/lib/aiDelegationRuntimePolicy.mjs'

const policy = { modelId: 'gpt-6-astra', thoughtLevelId: 'xhigh' }
function runtimeFixture({ level = 'high', busy = false, source = 'runtime', confirmation = 'observed', apply = true,
  supported = true, readyAfter = 0, busyAfter = Infinity, latencyMs = 0, modelId = policy.modelId,
  backend = 'codex', modelSupported = true, modelApply = true, modelConfirmation = 'observed',
  oldModelEfforts = null, effortsReadyAfter = 0 } = {}) {
  const calls = []
  let time = 0
  return { calls, run: (required = policy) => ensureDelegationRuntimePolicy({ conversationId: 'existing', machineId: 'machine', policy: required,
    now: () => time, wait: async ms => { time += ms },
    fetchOn: async (machine, url, options) => {
      assert.equal(machine, 'machine'); calls.push({ url, ...options, at: time }); time += latencyMs
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
  assert.ok(fixture.calls.every(c => c.timeoutMs === 30_000 - c.at))
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

for (const latencyMs of [0, 2_000]) test(`목록이 준비되지 않으면 API 지연 ${latencyMs}ms도 포함한 총 30초에서 종료한다`, async () => {
  const fixture = runtimeFixture({ readyAfter: Infinity, latencyMs })
  await assert.rejects(fixture.run(), { code: 'AI_DELEGATION_POLICY_RUNTIME_READINESS_TIMEOUT' })
  assert.equal(fixture.calls.some(c => c.method === 'PUT'), false)
  assert.ok(fixture.calls.every(c => c.at < 30_000 && c.timeoutMs === 30_000 - c.at))
  assert.ok(fixture.calls.length <= 121)
})

test('목록 대기 중 다른 작업이 시작되면 변경하지 않고 중단한다', async () => {
  const fixture = runtimeFixture({ readyAfter: 10_000, busyAfter: 1_000 })
  await assert.rejects(fixture.run(), { code: 'AI_DELEGATION_POLICY_RUNTIME_BUSY' })
  assert.equal(fixture.calls.some(c => c.method === 'PUT'), false)
})

test('조회 응답 자체가 돌아오지 않아도 30초 제한으로 종료한다', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const pending = ensureDelegationRuntimePolicy({ conversationId: 'stalled', policy, now: () => 0,
    fetchOn: async (_machine, url) => { calls.push(url); return new Promise(() => {}) } })
  const rejected = assert.rejects(pending, { code: 'AI_DELEGATION_POLICY_RUNTIME_READINESS_TIMEOUT' })
  t.mock.timers.tick(30_000)
  await rejected
  assert.equal(calls.length, 1, '응답이 늦은 호출 뒤 변경·실행 요청을 추가하지 않는다.')
})
