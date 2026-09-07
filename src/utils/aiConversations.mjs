const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
const MACHINE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return [...value]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, maxLength)
}

function cleanOption(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = cleanText(value.id, 512)
  if (!id) return null
  return { id, label: cleanText(value.label, 160) || id }
}

function cleanOptions(value, limit = 128) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value.flatMap((item) => {
    const option = cleanOption(item)
    if (!option || seen.has(option.id) || seen.size >= limit) return []
    seen.add(option.id)
    return [option]
  })
}

function optionValues(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

function parallelOptions(ids, labels) {
  const normalizedIds = optionValues(ids)
  const normalizedLabels = optionValues(labels)
  return normalizedIds.map((id, index) => ({
    id: String(id),
    label: String(normalizedLabels[index] ?? id),
  }))
}

export function normalizeAiConversationLink(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const conversationId = cleanText(value.conversationId, 120)
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return null
  const agent = cleanOption(value.agent)
  const model = cleanOption(value.model)
  const mode = cleanOption(value.mode)
  const thoughtLevel = cleanOption(value.thoughtLevel)
  const startedBy = cleanOption(value.startedBy)
  const linkedAt = Number.isFinite(Date.parse(value.linkedAt)) ? new Date(value.linkedAt).toISOString() : null
  const startedAt = Number.isFinite(Date.parse(value.startedAt)) ? new Date(value.startedAt).toISOString() : linkedAt
  const candidateHomeMachineId = cleanText(value.homeMachineId, 64).toLowerCase()
  const homeMachineId = MACHINE_ID_PATTERN.test(candidateHomeMachineId) ? candidateHomeMachineId : ''
  return {
    conversationId,
    ...(homeMachineId ? { homeMachineId } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(cleanText(value.providerId, 120) ? { providerId: cleanText(value.providerId, 120) } : {}),
    ...(mode ? { mode } : {}),
    ...(thoughtLevel ? { thoughtLevel } : {}),
    skills: cleanOptions(value.skills),
    mcpServers: cleanOptions(value.mcpServers),
    ...(cleanText(value.workspace, 4_096) ? { workspace: cleanText(value.workspace, 4_096) } : {}),
    ...(cleanText(value.requestPreview, 240) ? { requestPreview: cleanText(value.requestPreview, 240) } : {}),
    ...(startedBy ? { startedBy } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(linkedAt ? { linkedAt } : {}),
  }
}

export function aiConversationLinksFromData(data) {
  const seen = new Set()
  const links = (Array.isArray(data?.aiConversations) ? data.aiConversations : []).flatMap((value) => {
    const link = normalizeAiConversationLink(value)
    if (!link || seen.has(link.conversationId)) return []
    seen.add(link.conversationId)
    return [link]
  })
  const latestConversationId = cleanText(data?.aiConversationId, 120)
  if (CONVERSATION_ID_PATTERN.test(latestConversationId) && !seen.has(latestConversationId)) {
    links.push({ conversationId: latestConversationId, skills: [], mcpServers: [] })
  }
  return links.sort((first, second) => String(first.startedAt ?? first.linkedAt ?? '')
    .localeCompare(String(second.startedAt ?? second.linkedAt ?? '')))
}

export function aiConversationIdsFromData(data) {
  return aiConversationLinksFromData(data).map((link) => link.conversationId)
}

export function isAiConversationLinked(data, conversationId) {
  return aiConversationIdsFromData(data).includes(String(conversationId ?? ''))
}

export function appendAiConversationLink(data, value) {
  const link = normalizeAiConversationLink(value)
  if (!link) return aiConversationLinksFromData(data)
  return [
    ...aiConversationLinksFromData(data).filter((current) => current.conversationId !== link.conversationId),
    link,
  ]
}

export function removeAiConversationLink(data, conversationId) {
  const targetId = cleanText(conversationId, 120)
  return aiConversationLinksFromData(data)
    .filter((current) => current.conversationId !== targetId)
}

export function aiConversationLinkFromAionUiConversation(conversation) {
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) return null
  const extra = conversation.extra && typeof conversation.extra === 'object' && !Array.isArray(conversation.extra)
    ? conversation.extra
    : {}
  const assistant = conversation.assistant && typeof conversation.assistant === 'object' && !Array.isArray(conversation.assistant)
    ? conversation.assistant
    : {}
  const assistantId = String(assistant.id ?? '').replace(/^bare:/, '')
  const agentId = String(extra.agent_id ?? assistantId).trim()
  const modelId = String(extra.current_model_id ?? '').trim()
  const modeId = String(extra.current_mode_id ?? extra.session_mode ?? '').trim()
  const thoughtLevelId = String(extra.thought_level ?? '').trim()
  const skills = optionValues(extra.skills).map((skill) => {
    if (skill && typeof skill === 'object') {
      const id = String(skill.id ?? skill.name ?? '').trim()
      return { id, label: String(skill.name ?? skill.label ?? id) }
    }
    return { id: String(skill), label: String(skill) }
  })
  return normalizeAiConversationLink({
    conversationId: conversation.id,
    ...(agentId ? { agent: { id: agentId, label: String(assistant.name ?? agentId) } } : {}),
    ...(modelId ? { model: { id: modelId, label: modelId } } : {}),
    ...(modeId ? { mode: { id: modeId, label: modeId } } : {}),
    ...(thoughtLevelId ? { thoughtLevel: { id: thoughtLevelId, label: thoughtLevelId } } : {}),
    skills,
    mcpServers: parallelOptions(extra.mcp_server_ids, extra.mcp_servers),
    workspace: extra.workspace,
    startedAt: conversation.created_at,
  })
}

export function aggregateAiConversationRuntime(runtimes) {
  const validRuntimes = Array.isArray(runtimes) ? runtimes.filter((runtime) => runtime?.conversationId) : []
  if (validRuntimes.length === 0) return null
  const preferred = validRuntimes.find((runtime) => runtime.state === 'running')
    ?? validRuntimes.find((runtime) => runtime.state === 'waiting-confirmation')
    ?? [...validRuntimes].reverse().find((runtime) => runtime.state === 'idle')
    ?? validRuntimes.at(-1)
  return {
    ...preferred,
    isProcessing: validRuntimes.some((runtime) => runtime.isProcessing),
    pendingConfirmations: validRuntimes.reduce((sum, runtime) => sum + Math.max(0, Number(runtime.pendingConfirmations) || 0), 0),
    conversationCount: validRuntimes.length,
    activeConversationIds: validRuntimes
      .filter((runtime) => runtime.state === 'running' || runtime.state === 'waiting-confirmation')
      .map((runtime) => runtime.conversationId),
  }
}
