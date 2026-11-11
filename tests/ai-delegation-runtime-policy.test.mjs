import assert from 'node:assert/strict'
import test from 'node:test'
import { delegationResumeRuntimePolicy, ensureDelegationRuntimePolicy } from '../server/lib/aiDelegationRuntimePolicy.mjs'

const policy = { modelId: 'gpt-6-astra', thoughtLevelId: 'xhigh' }
function runtimeFixture({ level = 'high', busy = false, source = 'runtime', confirmation = 'observed', apply = true, supported = true } = {}) {
  const calls = []
  return { calls, run: (required = policy) => ensureDelegationRuntimePolicy({ conversationId: 'existing', machineId: 'machine', policy: required,
    fetchOn: async (machine, url, options) => {
      assert.equal(machine, 'machine'); calls.push({ url, ...options })
      if (url.endsWith('/runtime-config')) return { model: { value: policy.modelId, source }, thought_level: { value: level, source } }
      if (options.method === 'PUT') { if (apply) level = options.body.value; return { confirmation } }
      return { runtime: { state: busy ? 'running' : 'idle', is_processing: busy }, config_options: [
        { id: 'reasoning/effort', category: 'thought_level', options: (supported ? ['high', 'xhigh', 'max'] : ['high']).map(value => ({ value })) },
      ] }
    } }) }
}

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
  [{ busy: true }, 'BUSY'], [{ source: 'snapshot' }, 'MODEL_MISMATCH'], [{ supported: false }, 'UNSUPPORTED'],
  [{ confirmation: 'command_ack' }, 'UNCONFIRMED'], [{ apply: false }, 'MISMATCH'],
]) test(`규칙 확인 실패(${reason})는 작업 전 오류로 반환한다`, async () => {
  await assert.rejects(runtimeFixture(options).run(), { code: `AI_DELEGATION_POLICY_RUNTIME_${reason}` })
})
