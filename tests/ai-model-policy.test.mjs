import assert from 'node:assert/strict'
import test from 'node:test'
import { aiModelPolicy, aiModelPolicyRevision, assertAutomatedAiModelAllowed, canReuseAutomatedAiConversation, filterAutomatedAiAgents, isAiModelBlocked, resolveAutomatedAiModel } from '../server/lib/aiModelPolicy.mjs'
import { applyAiConversationDelegationModelPolicy, isAiDelegationModelBlocked } from '../server/lib/aiConversationContextHealth.mjs'

const agent = { id: 'codex', defaultModelId: 'gpt-5.6-sol', models: ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.0-sol', 'gpt-6.1-sol'].map((id) => ({ id, label: id })) }
const healthy = { assessmentId: 'healthy', resumeAllowed: true, reasonCodes: [], reasons: [] }

test('단일 정책이 별칭·문맥 변형을 포함한 제한 모델에 동일하게 적용된다', () => {
  for (const id of ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.0-sol', ' GPT-6.0-Sol[1m] ']) {
    assert.equal(isAiModelBlocked(id), true)
    assert.equal(isAiDelegationModelBlocked(id), true)
    assert.throws(() => assertAutomatedAiModelAllowed(id), { code: 'AI_AUTOMATION_MODEL_BLOCKED' })
  }
  for (const id of ['gpt-6.1-sol', 'gpt-5.6-solution', 'opus']) assert.equal(isAiModelBlocked(id), false)
  assert.throws(() => assertAutomatedAiModelAllowed(''), { code: 'AI_AUTOMATION_MODEL_BLOCKED' })
})

test('제안 저장값과 제한된 기본 모델을 같은 AI의 권장 허용 모델로 보정한다', () => {
  for (const id of [undefined, 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.0-sol[1m]']) {
    const selected = resolveAutomatedAiModel(agent, id)
    assert.equal(selected.model.id, 'gpt-6.1-sol')
    assert.equal(selected.modelPolicy.changed, true)
    assert.ok(selected.modelPolicy.message.includes('gpt-6.1-sol'))
  }
  const allowed = { ...agent, defaultModelId: 'opus', models: [...agent.models, { id: 'opus' }] }
  assert.equal(resolveAutomatedAiModel(allowed, 'opus').model.id, 'opus')
  assert.equal(resolveAutomatedAiModel(allowed).model.id, 'opus', '사용자가 고른 허용 모델과 허용 기본값을 강제로 상향하지 않는다')
  assert.equal(resolveAutomatedAiModel({ ...agent, models: agent.models.slice(3) }, 'gpt-5.6-sol').model.id, 'gpt-6.1-sol', '이미 카탈로그에서 사라진 제한 저장값도 보정한다')
  assert.throws(() => resolveAutomatedAiModel(agent, 'invented-model'), { status: 400 })
})

test('허용 대안이 없으면 다른 AI로 전환하거나 제한 모델을 사용하지 않는다', () => {
  const unavailable = { ...agent, models: agent.models.slice(0, 3) }
  assert.throws(() => resolveAutomatedAiModel(unavailable, 'gpt-5.6-sol'), { code: 'AI_AUTOMATION_MODEL_UNAVAILABLE' })
  assert.deepEqual(filterAutomatedAiAgents([unavailable]), [])
  const filtered = filterAutomatedAiAgents([agent])[0]
  assert.deepEqual(filtered.models.map((model) => model.id), ['gpt-6.1-sol'])
  assert.equal(filtered.defaultModelId, 'gpt-6.1-sol')
  assert.equal(agent.models.length, 4, '일반 수동 대화의 원래 카탈로그는 변경하지 않는다')
})

test('저장 모델·현재 모델을 모두 확인하고 선택 모델이 달라지면 전용 대화를 재사용하지 않는다', () => {
  assert.equal(canReuseAutomatedAiConversation('gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6.1-sol'), false)
  assert.equal(canReuseAutomatedAiConversation('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6.1-sol'), false)
  assert.equal(canReuseAutomatedAiConversation('gpt-6.1-sol', 'opus', 'gpt-6.1-sol'), false)
  assert.equal(canReuseAutomatedAiConversation('gpt-6.1-sol', undefined, 'gpt-6.1-sol'), false)
  assert.equal(canReuseAutomatedAiConversation(undefined, 'GPT-6.1-Sol[1m]', 'gpt-6.1-sol'), true)
})

test('정책에 다음 제한 모델을 추가하면 위임 평가·Dooray 선택·목록·재사용이 함께 변경된다', () => {
  const next = { ...aiModelPolicy, blockedModels: [...aiModelPolicy.blockedModels, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }], preferredModelIds: ['gpt-6.2-sol'] }
  const catalog = { ...agent, models: [...agent.models, { id: 'gpt-6.2-sol' }] }
  const original = applyAiConversationDelegationModelPolicy(healthy, { runtimeModelId: 'gpt-6.1-sol' })
  const revised = applyAiConversationDelegationModelPolicy(healthy, { runtimeModelId: 'gpt-6.1-sol' }, next)
  assert.equal(original.resumeAllowed, true)
  assert.equal(revised.resumeAllowed, false)
  assert.notEqual(original.assessmentId, revised.assessmentId)
  assert.notEqual(aiModelPolicyRevision(), aiModelPolicyRevision(next))
  assert.equal(isAiDelegationModelBlocked('gpt-6.1-sol', next), true)
  assert.equal(resolveAutomatedAiModel(catalog, 'gpt-6.1-sol', next).model.id, 'gpt-6.2-sol')
  assert.deepEqual(filterAutomatedAiAgents([catalog], next)[0].models.map((model) => model.id), ['gpt-6.2-sol'])
  assert.equal(canReuseAutomatedAiConversation('gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol', next), false)
  assert.throws(() => assertAutomatedAiModelAllowed('gpt-6.1-sol', next), { code: 'AI_AUTOMATION_MODEL_BLOCKED' })
})
