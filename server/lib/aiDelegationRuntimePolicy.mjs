import { aiDelegationResumeModelMatches } from './aiDelegationPolicy.mjs'

const failure = (suffix, message, status = 409) => Object.assign(new Error(message), {
  status, code: `AI_DELEGATION_POLICY_RUNTIME_${suffix}`, reasonCode: `AI_DELEGATION_POLICY_RUNTIME_${suffix}`,
})

// 대기열에서도 접수 당시 규칙을 사용한다. 중단된 기존 작업의 복구에는 새 규칙을 적용하지 않는다.
export function delegationResumeRuntimePolicy(strategy, rule, interrupted = false) {
  return strategy === 'resume' && rule && !interrupted
    ? { modelId: rule.modelId, thoughtLevelId: rule.thoughtLevelId } : null
}

/** 실제 실행 직전에 같은 대화의 사고 강도를 맞춘다. 확인 실패 시 호출자는 지시를 전송하지 않는다. */
export async function ensureDelegationRuntimePolicy({ conversationId, policy, fetchOn, machineId }) {
  if (!policy) return null
  const base = `/api/conversations/${encodeURIComponent(conversationId)}`
  const call = (suffix, options = {}) => fetchOn(machineId, `${base}${suffix}`, {
    timeoutMs: 30_000, strictJson: true, singleTarget: true, noMutationRetry: true, ...options,
  })
  const assertIdle = (runtime) => {
    if (runtime?.state !== 'idle' || runtime.is_processing === true || runtime.pending_confirmations > 0
      || runtime.can_send_message === false) {
      throw failure('BUSY', '대상 대화가 유휴 상태가 아니어서 위임 규칙의 사고 강도를 변경하지 않았습니다.')
    }
  }
  const assertModel = (config) => {
    if (config?.model?.source !== 'runtime' || aiDelegationResumeModelMatches(policy, config.model.value) !== true) {
      throw failure('MODEL_MISMATCH', '실제 실행 모델이 위임 규칙과 일치하는지 확인하지 못해 작업을 시작하지 않았습니다.')
    }
  }
  try {
    assertIdle((await call('')).runtime)
    // 종료된 런타임도 메시지를 보내지 않고 준비하여 실제 옵션 ID와 허용 값을 확인한다.
    const ensured = await call('/runtime/ensure', { method: 'POST' })
    assertIdle(ensured.runtime)
    const before = await call('/runtime-config')
    assertModel(before)
    const previousThoughtLevel = before.thought_level?.value ?? null
    const matches = (config) => config?.thought_level?.source === 'runtime'
      && config.thought_level.value === policy.thoughtLevelId
    const changed = !matches(before)
    if (changed) {
      const option = ensured.config_options?.find((item) => item.category === 'thought_level')
        ?? ensured.config_options?.find((item) => ['effort', 'reasoning_effort', 'thought_level'].includes(item.id))
      if (!option?.id || !option.options?.some((item) => item.value === policy.thoughtLevelId)) {
        throw failure('UNSUPPORTED', `대상 대화에서 사고 강도 ${policy.thoughtLevelId}를 지원하는지 확인하지 못해 작업을 시작하지 않았습니다.`)
      }
      const result = await call(`/config-options/${encodeURIComponent(option.id)}`, {
        method: 'PUT', body: { value: policy.thoughtLevelId },
      })
      if (!['observed', 'pending_next_turn'].includes(result?.confirmation)) {
        throw failure('UNCONFIRMED', 'AionCore가 사고 강도 적용을 확인하지 못해 작업을 시작하지 않았습니다.')
      }
    }
    const actual = changed ? await call('/runtime-config') : before
    assertModel(actual)
    if (!matches(actual)) throw failure('MISMATCH', `사고 강도가 위임 규칙(${policy.thoughtLevelId})과 달라 작업을 시작하지 않았습니다.`)
    assertIdle((await call('')).runtime)
    return { conversationId, modelId: actual.model.value, previousThoughtLevel,
      thoughtLevelId: actual.thought_level.value, changed, verifiedAt: new Date().toISOString() }
  } catch (error) {
    if (error?.code?.startsWith('AI_DELEGATION_POLICY_RUNTIME_') || error?.name === 'AbortError') throw error
    throw failure('UNAVAILABLE', '대상 대화의 위임 규칙 적용·확인에 실패해 작업을 시작하지 않았습니다.', 503)
  }
}
