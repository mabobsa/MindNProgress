import { createHash } from 'node:crypto'

// 자동 AI 요청의 단일 정책 원본. 모델 상향 시 이 목록과 권장 모델만 변경한다.
// 버전 숫자 비교로 다른 계열 모델까지 차단하지 않고 확인된 모델 ID와 별칭만 제한한다.
export const aiModelPolicy = Object.freeze({
  blockedModels: Object.freeze([
    Object.freeze({ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', aliases: Object.freeze([]) }),
    Object.freeze({ id: 'gpt-6-sol', label: 'GPT-6.0-Sol', aliases: Object.freeze(['gpt-6.0-sol']) }),
  ]),
  preferredModelIds: Object.freeze(['gpt-6.1-sol']),
})

export const normalizeAiModelId = (value) => String(value ?? '').trim().toLowerCase().replace(/\[.*\]$/, '')
export const aiModelPolicyRevision = (policy = aiModelPolicy) => createHash('sha256').update(JSON.stringify(policy)).digest('hex')
export const blockedAiModelLabels = (policy = aiModelPolicy) => policy.blockedModels.map((model) => model.label).join(' 또는 ')

export function isAiModelBlocked(modelId, policy = aiModelPolicy) {
  const id = normalizeAiModelId(modelId)
  return policy.blockedModels.some((model) => [model.id, ...(model.aliases ?? [])].some((alias) => normalizeAiModelId(alias) === id))
}

export function assertAutomatedAiModelAllowed(modelId, policy = aiModelPolicy) {
  if (!normalizeAiModelId(modelId) || isAiModelBlocked(modelId, policy)) {
    const message = !normalizeAiModelId(modelId) ? '실제 AI 모델을 확인하지 못해 자동 요청을 전달하지 않았습니다. 대화의 모델 설정을 확인해 주세요.'
      : `자동 AI 요청에는 ${blockedAiModelLabels(policy)} 모델을 사용할 수 없습니다. 사용 가능한 허용 모델을 선택해 주세요.`
    throw Object.assign(new Error(message),
      { status: 409, code: 'AI_AUTOMATION_MODEL_BLOCKED', doorayResponseError: true })
  }
}

export function resolveAutomatedAiModel(agent, requestedModelId, policy = aiModelPolicy) {
  const models = agent?.models ?? []
  const requested = models.find((model) => model.id === requestedModelId)
  const originalModelId = requestedModelId || agent?.defaultModelId || models[0]?.id || ''
  // 존재하지 않는 임의 ID는 설정 오류다. 제한된 저장값만 명시적으로 보정한다.
  if (requestedModelId && !requested && !isAiModelBlocked(requestedModelId, policy)) {
    throw Object.assign(new Error('선택한 AI 모델을 AionUi에서 확인할 수 없습니다. AI 설정을 다시 선택해 주세요.'), { status: 400, doorayResponseError: true })
  }
  const allowed = models.filter((model) => !isAiModelBlocked(model.id, policy))
  const selected = requested && !isAiModelBlocked(requested.id, policy) ? requested
    : (!requestedModelId && allowed.find((model) => model.id === agent?.defaultModelId))
      || policy.preferredModelIds.map((id) => allowed.find((model) => normalizeAiModelId(model.id) === normalizeAiModelId(id))).find(Boolean)
      || allowed.find((model) => model.id === agent?.defaultModelId) || allowed[0]
  if (!selected) throw Object.assign(new Error('이 AI에는 자동 요청에 사용할 허용 모델이 없습니다. AionUi 모델 목록과 공통 모델 정책을 확인해 주세요.'),
    { status: 409, code: 'AI_AUTOMATION_MODEL_UNAVAILABLE', doorayResponseError: true })
  const changed = originalModelId !== selected.id
  return { model: selected, modelPolicy: { revision: aiModelPolicyRevision(policy), changed, previousModelId: changed ? originalModelId : null,
    message: changed ? `저장된 모델 ${originalModelId || '(미지정)'} 대신 공통 모델 정책의 허용 모델 ${selected.id}을 사용합니다.` : '' } }
}

export function filterAutomatedAiAgents(agents, policy = aiModelPolicy) {
  return agents.flatMap((agent) => {
    const models = agent.models.filter((model) => !isAiModelBlocked(model.id, policy))
    if (!models.length) return []
    return [{ ...agent, models, defaultModelId: resolveAutomatedAiModel(agent, undefined, policy).model.id }]
  })
}

export function canReuseAutomatedAiConversation(recordedModelId, runtimeModelId, selectedModelId, policy = aiModelPolicy) {
  return Boolean(normalizeAiModelId(runtimeModelId)) && ![recordedModelId, runtimeModelId].some((id) => isAiModelBlocked(id, policy))
    && (!selectedModelId || normalizeAiModelId(runtimeModelId) === normalizeAiModelId(selectedModelId))
}
