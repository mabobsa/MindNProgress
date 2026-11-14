import { aiDelegationResumeModelMatches } from './aiDelegationPolicy.mjs'
import { isAiModelBlocked } from './aiModelPolicy.mjs'
import { setTimeout as pause } from 'node:timers/promises'

export const AI_DELEGATION_RUNTIME_READY_TIMEOUT_MS = 30_000

const failure = (suffix, message, status = 409) => Object.assign(new Error(message), {
  status, code: `AI_DELEGATION_POLICY_RUNTIME_${suffix}`, reasonCode: `AI_DELEGATION_POLICY_RUNTIME_${suffix}`,
})

// 대기열에서도 접수 당시 규칙을 사용한다. 중단된 기존 작업의 복구에는 새 규칙을 적용하지 않는다.
export function delegationResumeRuntimePolicy(strategy, rule, interrupted = false) {
  return strategy === 'resume' && rule && !interrupted
    ? { modelId: rule.modelId, thoughtLevelId: rule.thoughtLevelId, ...(rule.agent?.backend ? { backend: rule.agent.backend } : {}) } : null
}

export function delegationRuntimeCandidateMatches(policy, modelId, backend) {
  return policy?.backend ? backend === policy.backend : aiDelegationResumeModelMatches(policy, modelId) === true
}

export function applyDelegationRuntimeSelection(selection, policy) {
  if (!policy) return
  if (selection.model?.id !== policy.modelId) selection.model = { id: policy.modelId, label: policy.modelId }
  selection.thoughtLevel = { id: policy.thoughtLevelId, label: policy.thoughtLevelId }
}

/** 실제 실행 직전에 같은 CLI의 모델과 사고 강도를 순서대로 맞춘다. 확인 실패 시 지시를 전송하지 않는다. */
export async function ensureDelegationRuntimePolicy({ conversationId, policy, fetchOn, machineId,
  signal, now = () => performance.now(), wait = (ms) => pause(ms, undefined, { signal }) }) {
  if (!policy) return null
  const base = `/api/conversations/${encodeURIComponent(conversationId)}`
  const deadline = now() + AI_DELEGATION_RUNTIME_READY_TIMEOUT_MS
  const timeout = () => failure('READINESS_TIMEOUT', '대상 대화의 실행 설정·사고 레벨 목록 준비 또는 적용 확인이 30초를 초과해 작업을 시작하지 않았습니다.', 504)
  const remaining = () => {
    signal?.throwIfAborted()
    const ms = Math.ceil(deadline - now())
    if (ms <= 0) throw timeout()
    return ms
  }
  const call = async (suffix, options = {}) => {
    const timeoutMs = remaining()
    let timer
    try {
      // Runner 대기나 응답 지연도 전체 제한에 포함한다. 늦게 온 응답으로 지시를 전송하지 않는다.
      const result = await Promise.race([
        fetchOn(machineId, `${base}${suffix}`, {
          strictJson: true, singleTarget: true, noMutationRetry: true, ...options, timeoutMs,
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), timeoutMs) }),
      ])
      remaining()
      return result
    } catch (error) {
      if (now() >= deadline) throw timeout()
      throw error
    } finally { clearTimeout(timer) }
  }
  const assertIdle = (runtime) => {
    if (runtime?.state !== 'idle' || runtime.is_processing === true || runtime.pending_confirmations > 0
      || runtime.can_send_message === false) {
      throw failure('BUSY', '대상 대화가 유휴 상태가 아니어서 위임 규칙의 실행 설정 변경을 중단했습니다.')
    }
  }
  const assertModel = (config) => {
    if (config?.model?.source !== 'runtime' || aiDelegationResumeModelMatches(policy, config.model.value) !== true) {
      throw failure('MODEL_MISMATCH', '실제 실행 모델이 위임 규칙과 일치하는지 확인하지 못해 작업을 시작하지 않았습니다.')
    }
  }
  try {
    const checkConversation = async () => {
      const conversation = await call('')
      assertIdle(conversation.runtime)
      if (policy.backend && conversation.extra?.backend !== policy.backend) {
        throw failure('BACKEND_MISMATCH', '대상 대화의 CLI가 위임 규칙과 달라 실행 설정을 변경하지 않았습니다.')
      }
    }
    await checkConversation()
    // 종료된 런타임도 메시지를 보내지 않고 준비하여 실제 옵션 ID와 허용 값을 확인한다.
    let ensured = await call('/runtime/ensure', { method: 'POST' })
    assertIdle(ensured.runtime)
    let before
    let option
    let previousModelId
    let modelChanged = false
    // 모델과 사고 강도의 카탈로그 준비·적용 확인은 동일한 30초 제한을 공유한다.
    while (true) {
      before = await call('/runtime-config')
      if (before?.model?.source === 'runtime') {
        previousModelId = before.model.value
        if (aiDelegationResumeModelMatches(policy, previousModelId) === true) break
        if (!policy.backend) assertModel(before) // 구형 대기열은 접수 때 확인한 모델만 재사용한다.
        if (isAiModelBlocked(policy.modelId)) throw failure('MODEL_BLOCKED', '자동 위임에서 제한된 모델로 변경하지 않았습니다.')
        const modelOption = ensured.config_options?.find(item => item.category === 'model' || item.id === 'model')
        if (modelOption?.options?.length) {
          const target = modelOption.options.find(item => aiDelegationResumeModelMatches(policy, item.value) === true)
          if (!target) throw failure('MODEL_UNSUPPORTED', `대상 대화의 모델 목록에 ${policy.modelId}가 없어 작업을 시작하지 않았습니다.`)
          await checkConversation()
          const result = await call(`/config-options/${encodeURIComponent(modelOption.id)}`, {
            method: 'PUT', body: { value: target.value },
          })
          if (!['observed', 'pending_next_turn'].includes(result?.confirmation)) {
            throw failure('MODEL_UNCONFIRMED', 'AionCore가 모델 변경을 확인하지 못해 작업을 시작하지 않았습니다.')
          }
          modelChanged = true
          // 새 모델 기준의 사고 레벨 목록을 다시 받는다. 변경 전 옵션은 사용하지 않는다.
          ensured = await call('/runtime/ensure', { method: 'POST' })
          assertIdle(ensured.runtime)
          before = await call('/runtime-config')
          assertModel(before)
          break
        }
      }
      await wait(Math.min(500, remaining()))
      ensured = await call('/runtime/ensure', { method: 'POST' })
      assertIdle(ensured.runtime)
    }
    const matches = (config) => config?.thought_level?.source === 'runtime'
      && config.thought_level.value === policy.thoughtLevelId
    // ensure는 런타임 생성 완료만 보장한다. 모델 카탈로그는 수 초 뒤 도착할 수 있다.
    // 별도 GET config-options API는 없으므로 동일 런타임의 ensure 응답을 다시 조회한다.
    while (true) {
      before ??= await call('/runtime-config')
      if (before?.model?.source === 'runtime') {
        assertModel(before)
        if (matches(before) && !modelChanged) break
        option = ensured.config_options?.find((item) => item.category === 'thought_level')
          ?? ensured.config_options?.find((item) => ['effort', 'reasoning_effort', 'thought_level'].includes(item.id))
        if (option?.id && option.options?.length) break
      }
      await wait(Math.min(500, remaining()))
      ensured = await call('/runtime/ensure', { method: 'POST' })
      assertIdle(ensured.runtime)
      before = null
    }
    assertModel(before)
    const previousThoughtLevel = before.thought_level?.value ?? null
    const thoughtLevelChanged = !matches(before) || modelChanged
    if (thoughtLevelChanged) {
      if (!option.options.some((item) => item.value === policy.thoughtLevelId)) {
        throw failure('UNSUPPORTED', `대상 대화의 사고 레벨 목록에 ${policy.thoughtLevelId}가 없어 작업을 시작하지 않았습니다.`)
      }
      await checkConversation()
      const result = await call(`/config-options/${encodeURIComponent(option.id)}`, {
        method: 'PUT', body: { value: policy.thoughtLevelId },
      })
      if (!['observed', 'pending_next_turn'].includes(result?.confirmation)) {
        throw failure('UNCONFIRMED', 'AionCore가 사고 강도 적용을 확인하지 못해 작업을 시작하지 않았습니다.')
      }
    }
    const actual = thoughtLevelChanged ? await call('/runtime-config') : before
    assertModel(actual)
    if (!matches(actual)) throw failure('MISMATCH', `사고 강도가 위임 규칙(${policy.thoughtLevelId})과 달라 작업을 시작하지 않았습니다.`)
    await checkConversation()
    return { conversationId, modelId: actual.model.value, previousModelId, previousThoughtLevel,
      thoughtLevelId: actual.thought_level.value, modelChanged, thoughtLevelChanged,
      changed: modelChanged || thoughtLevelChanged, verifiedAt: new Date().toISOString() }
  } catch (error) {
    signal?.throwIfAborted()
    if (error?.code?.startsWith('AI_DELEGATION_POLICY_RUNTIME_') || error?.name === 'AbortError') throw error
    throw failure('UNAVAILABLE', '대상 대화의 위임 규칙 적용·확인에 실패해 작업을 시작하지 않았습니다.', 503)
  }
}
