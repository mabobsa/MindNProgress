import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createAionUiCaller } from '../../runner/lib/aionUiClient.mjs'
import { aiConversationLinksFromData, appendAiConversationLink } from '../../src/utils/aiConversations.mjs'
import { createDoorayResponseService, readDoorayResponseSource } from './doorayResponses.mjs'
import { createDoorayRateLimiter } from './doorayMentions.mjs'

const fail = (message, status = 409) => Object.assign(new Error(message), { status, doorayResponseError: true })
const excerpt = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : ''

export const doorayResponseMcpNames = ['MindNProgress', 'unityMCP', 'docker-dooray-mcp', 'pptx-mcp']

export function selectDoorayResponseMcps(servers) {
  return doorayResponseMcpNames.map((name) => {
    const matches = (Array.isArray(servers) ? servers : []).filter((server) => server.name === name && server.enabled === true && !server.builtin)
    if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id) throw fail(`필수 MCP '${name}'을 하나로 확인할 수 없습니다. 실행 머신의 AionUi에서 등록·활성화 상태를 확인해 주세요.`)
    return { id: matches[0].id, label: name }
  })
}

export async function prepareDoorayResponseMcps(call, normalizeRuntime, operation) {
  const catalog = await call(operation.machineId, '/api/mcp/servers')
  const required = selectDoorayResponseMcps(catalog)
  const pathname = `/api/conversations/${encodeURIComponent(operation.conversationId)}`
  const conversation = await call(operation.machineId, pathname)
  if (conversation?.id !== operation.conversationId) throw fail('MCP를 적용할 AI 대화를 확인할 수 없습니다.', 502)
  if (normalizeRuntime(operation.conversationId, conversation).state !== 'idle') return { waiting: true, reason: '대화의 기존 실행이 끝난 뒤 필수 MCP를 적용합니다.' }
  const extra = conversation.extra ?? {}
  for (const field of ['mcp_server_ids', 'mcp_servers', 'session_mcp_servers']) {
    if (extra[field] != null && !Array.isArray(extra[field])) throw fail('기존 MCP 설정의 형식을 확인할 수 없어 변경하지 않았습니다.', 502)
  }
  const hasRequired = (value) => Array.isArray(value?.mcp_server_ids) && Array.isArray(value?.mcp_servers)
    && required.every((server) => value.mcp_server_ids.includes(server.id) && value.mcp_servers.includes(server.label))
  if (!hasRequired(extra)) {
    // 다른 대화에서 사용하던 선택과 세션 전용 MCP는 유지하고 필수 네 종류만 추가한다.
    const previousIds = Array.isArray(extra.mcp_server_ids) ? extra.mcp_server_ids : []
    const previousNames = Array.isArray(extra.mcp_servers) ? extra.mcp_servers : []
    const selectedIds = [...new Set([
      ...previousIds,
      ...catalog.filter((server) => previousNames.includes(server.name) && server.enabled && !server.builtin).map((server) => server.id),
      ...required.map((server) => server.id),
    ])]
    await call(operation.machineId, `${pathname}/mcp-servers`, { method: 'PUT', timeoutMs: 30_000, body: {
      sync_aionui_catalog: true, mcp_server_ids: selectedIds,
      session_mcp_servers: Array.isArray(extra.session_mcp_servers) ? extra.session_mcp_servers : [],
    } })
    const saved = await call(operation.machineId, pathname)
    if (saved?.id !== operation.conversationId || !hasRequired(saved.extra)) throw fail('필수 MCP 연결을 저장한 뒤 확인하지 못했습니다. 대화 설정을 확인해 주세요.', 502)
  }
  return { mcpServers: required }
}

export function createDoorayResponseIntegration(d) {
  const acquire = createDoorayRateLimiter()
  // 일반 대화 생성은 멱등 API가 아니므로 응답이 불확실한 POST를 다른 주소에 재전송하지 않는다.
  const safeMainCall = createAionUiCaller({ candidateBaseUrls: d.aionUiCandidateBaseUrls })
  const call = async (machineId, pathname, options = {}) => {
    if (machineId !== d.mainMachineId) return d.fetchAionUiOn(machineId, pathname, options)
    const result = await safeMainCall({ pathname, method: options.method ?? 'GET', timeoutMs: options.timeoutMs ?? 15_000, body: options.body })
    if (!result.ok) throw Object.assign(fail(`AionUi 요청에 실패했습니다. (${result.code ?? result.status})`, result.status), { code: result.code })
    return result.data
  }
  const readConversation = async (machineId, conversationId) => {
    try {
      const conversation = await call(machineId, `/api/conversations/${encodeURIComponent(conversationId)}`)
      if (conversation?.id !== conversationId) throw fail('조회한 AI 대화의 ID를 확인할 수 없습니다.', 502)
      return conversation
    }
    catch (failure) {
      // 라우트 누락·러너 장애의 404와 구분해 AionUi의 대화 없음 응답만 삭제로 판단한다.
      if (failure.status === 404 && failure.code === 'NOT_FOUND') return null
      throw failure
    }
  }
  const resolveSettings = async (user, requested = {}) => {
    const { machineId } = d.resolveTargetMachineForUser(user, requested.machineId)
    const [rawAgents, providers, servers] = await Promise.all([call(machineId, '/api/agents/management'), call(machineId, '/api/providers'), call(machineId, '/api/mcp/servers')])
    const mcpServers = selectDoorayResponseMcps(servers)
    const agents = (Array.isArray(rawAgents) ? rawAgents : []).filter((agent) => agent.enabled !== false && agent.installed === true)
      .map((agent) => d.normalizeAionUiAgent(agent, Array.isArray(providers) ? providers.filter((provider) => provider.enabled !== false) : []))
    const agent = requested.agentId ? agents.find((entry) => entry.id === requested.agentId) : agents.find((entry) => entry.models.length)
    const model = requested.modelId ? agent?.models.find((entry) => entry.id === requested.modelId)
      : agent?.models.find((entry) => entry.id === agent.defaultModelId) ?? agent?.models[0]
    if (!agent || !model) throw fail('사용할 AI와 모델을 AionUi에서 확인할 수 없습니다. AI 설정을 다시 선택해 주세요.', 400)
    const option = (list, requestedId, defaultId) => {
      if (requestedId && !list.some((entry) => entry.id === requestedId)) throw fail('선택한 AI 실행 옵션을 사용할 수 없습니다.', 400)
      return requestedId || (list.some((entry) => entry.id === defaultId) ? defaultId : list[0]?.id) || null
    }
    return { machineId, machineRole: machineId === d.mainMachineId ? 'main' : 'sub', agentId: agent.id, agentName: agent.name, modelId: model.id, modelName: model.label, mcpServers,
      mode: option(agent.modes, requested.mode, agent.defaultMode),
      thoughtLevel: option(agent.thoughtLevels, requested.thoughtLevel, agent.defaultThoughtLevel) }
  }
  const loadMaps = async () => {
    const summaries = await d.listMaps()
    const maps = (await Promise.all(summaries.map((summary) => d.readMap(summary.id)))).filter(Boolean)
    const layout = await d.readDocumentLayout(maps.map((map) => map.id))
    for (const group of layout.groups) {
      const project = await d.groupProjects.read(group.id)
      if (!project.coordinatorMapId) continue
      for (const map of maps.filter((map) => group.mapIds.includes(map.id))) {
        map.responseGroup = { groupId: group.id, name: group.name, coordinatorMapId: project.coordinatorMapId,
          role: map.id === project.coordinatorMapId ? 'coordinator' : 'document' }
      }
    }
    return maps
  }
  return createDoorayResponseService({
    directory: path.join(d.dataDirectory, '_dooray-responses'), read: d.readStoredRecord, write: d.writeStoredRecord,
    user: d.user, resolveSettings, loadMaps,
    authorize: (user, machineId) => { if (!d.machineAccessibleByUser(user, machineId)) throw fail('이 AI 실행 머신에 접근할 수 없습니다.', 403) },
    async conversationExists(user, conversation) {
      if (!d.machineAccessibleByUser(user, conversation.machineId)) throw fail('이 AI 실행 머신에 접근할 수 없습니다.', 403)
      return Boolean(await readConversation(conversation.machineId, conversation.conversationId))
    },
    loadSource: async (item) => readDoorayResponseSource(item, await d.getDoorayApiConfig(), { acquire }),
    async createConversation(settings, title, operationId) {
      const mcpServers = selectDoorayResponseMcps(await call(settings.machineId, '/api/mcp/servers'))
      const mcpIds = mcpServers.map((server) => server.id)
      const workspace = settings.machineId === d.mainMachineId ? path.join(d.dataDirectory, '_dooray-response-workspaces', operationId) : null
      if (workspace) await mkdir(workspace, { recursive: true })
      const conversation = await call(settings.machineId, '/api/conversations', { method: 'POST', timeoutMs: 30_000, body: {
        name: title.slice(0, 120),
        assistant: { id: `bare:${settings.agentId}`, conversation_overrides: {
          model: settings.modelId, permission: settings.mode, thought_level: settings.thoughtLevel,
          skill_ids: [], mcp_ids: mcpIds,
        } },
        extra: { custom_workspace: Boolean(workspace), ...(workspace ? { workspace } : {}), selected_mcp_server_ids: mcpIds, mnpDoorayOperationId: operationId },
      } })
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(conversation?.id ?? '')) throw fail('AionUi가 생성한 대화 ID를 확인할 수 없습니다.', 502)
      return conversation
    },
    prepareConversation: (_user, operation) => prepareDoorayResponseMcps(call, d.normalizeAiConversationRuntime, operation),
    async prepareReview(user, route, settings) {
      const map = await d.readMap(route.mapId)
      const card = map?.nodes.find((node) => node.id === route.cardId)
      if (!card || map.trashedAt) throw fail('담당 카드가 삭제되었습니다.')
      const links = aiConversationLinksFromData(card.data)
      const active = d.activeDelegations(route.mapId, route.cardId)
      if (active) return { waiting: true, reason: '담당 카드의 기존 AI 작업이 끝나기를 기다리는 중입니다.' }
      const states = (await Promise.all(links.map(async (link) => {
        const machineId = d.conversationHomeMachineId(link.conversationId, link)
        if (!d.machineAccessibleByUser(user, machineId)) throw fail('담당 대화가 있는 머신에 접근할 수 없습니다.', 403)
        const conversation = await readConversation(machineId, link.conversationId)
        if (!conversation) return null
        return { link, machineId, conversation, state: d.normalizeAiConversationRuntime(link.conversationId, conversation).state }
      }))).filter(Boolean)
      if (states.some((entry) => entry.state !== 'idle')) return { waiting: true, reason: '담당 카드의 대화가 실행 중이거나 상태를 확인하는 중입니다.' }
      const resume = states.find((entry) => entry.link.conversationId === route.conversationId)
      if (route.conversationId && !links.some((link) => link.conversationId === route.conversationId)) throw fail('이어갈 담당 대화의 연결이 변경되었습니다.')
      const connectedIds = new Set([card.id])
      for (const edge of map.edges) if (edge.source === card.id || edge.target === card.id) { connectedIds.add(edge.source); connectedIds.add(edge.target) }
      const nearbyCards = map.nodes.filter((node) => connectedIds.has(node.id)).sort((a, b) => Number(b.id === card.id) - Number(a.id === card.id))
      const context = { document: { id: map.id, title: map.title, version: map.version },
        cards: nearbyCards.slice(0, 12).map((node) => ({ id: node.id, ...node.data,
          description: excerpt(node.data.description, 5000), sharedKnowledge: excerpt(node.data.sharedKnowledge, 6000),
          aiConversations: undefined, aiConversationRuntime: undefined })),
        comments: (await d.listComments(map.id)).filter((comment) => comment.nodeId === card.id).slice(-5)
          .map((comment) => ({ summary: excerpt(comment.summary ?? comment.body, 700), detail: excerpt(comment.detail, 1200) })),
        relations: map.edges.filter((edge) => connectedIds.has(edge.source) && connectedIds.has(edge.target)),
      }
      if (route.action === 'group') {
        const group = await d.groupProjects.forDocument(map.id)
        const groupContext = await d.groupProjects.context(group.groupId)
        context.group = { objective: excerpt(groupContext.project.objective, 3000), instructions: excerpt(groupContext.project.instructions, 3000),
          documents: groupContext.documents.map((entry) => ({ id: entry.id, title: entry.title, work: entry.work })) }
      }
      while (JSON.stringify(context).length > 34_000 && context.cards.length > 1) context.cards.pop()
      context.omittedCards = nearbyCards.length - context.cards.length
      const includedIds = new Set(context.cards.map((entry) => entry.id))
      context.relations = context.relations.filter((edge) => includedIds.has(edge.source) && includedIds.has(edge.target))
      context.coverage = '설명·공유 지식은 카드별 앞부분이며 댓글은 최근 5개입니다. 생략된 자료가 결론에 필요하면 추가 확인 사항으로 제안에 명시하세요.'
      const machineId = resume?.machineId ?? settings.machineId
      return { conversationId: resume?.link.conversationId ?? null, settings: { ...settings, machineId, machineRole: machineId === d.mainMachineId ? 'main' : 'sub' }, context }
    },
    async linkReview(user, route, operation) {
      const map = await d.readMap(route.mapId)
      const card = map?.nodes.find((node) => node.id === route.cardId)
      if (!card || map.trashedAt) throw fail('대화를 연결할 담당 카드가 없습니다.')
      if (!aiConversationLinksFromData(card.data).some((link) => link.conversationId === operation.conversationId)) {
        const now = new Date().toISOString()
        const settings = operation.settings
        const link = { conversationId: operation.conversationId, homeMachineId: operation.machineId,
          agent: { id: settings.agentId, label: settings.agentName }, model: { id: settings.modelId, label: settings.modelName },
          ...(settings.thoughtLevel ? { thoughtLevel: { id: settings.thoughtLevel, label: settings.thoughtLevel } } : {}),
          skills: [], mcpServers: settings.mcpServers ?? [], requestPreview: `Dooray 대응 제안: ${route.requestSummary}`,
          startedBy: { id: user.id, label: user.name }, startedAt: now, linkedAt: now }
        const updated = await d.saveMap(map.id, { nodes: map.nodes.map((node) => node.id === card.id ? { ...node,
          data: { ...node.data, aiConversationId: operation.conversationId, aiConversations: appendAiConversationLink(node.data, link) } } : node), edges: map.edges },
        user, map.title, map.color, 'content', { expectedVersion: map.version })
        d.broadcastEvent({ type: 'ai-conversation-linked', mapId: map.id, nodeId: card.id, conversationId: operation.conversationId,
          conversation: link, sourceClientId: null, updatedAt: updated.updatedAt, updatedBy: d.publicUser(user) })
      }
      d.rememberAiConversationOrigin({ conversationId: operation.conversationId, mapId: map.id, cardId: card.id,
        startedBy: user.id, linkedAt: new Date().toISOString(), homeMachineId: operation.machineId })
      await d.persistAiConversationOrigins()
    },
    dispatch: (op) => call(op.machineId, '/api/internal/external-conversation-dispatches', { method: 'POST', timeoutMs: 30_000, body: {
      operationId: op.id, actorConversationId: op.conversationId, targetConversationId: op.conversationId,
      strategy: 'resume', instruction: op.prompt, explicitCompletionAfterInterruption: false,
    } }),
    getDispatch: (op) => call(op.machineId, `/api/internal/external-conversation-dispatches/${encodeURIComponent(op.id)}`),
    async messages(op) {
      const response = await call(op.machineId, `/api/conversations/${encodeURIComponent(op.conversationId)}/messages?limit=200&content_mode=full`)
      return (Array.isArray(response?.items) ? response.items : Array.isArray(response) ? response : [])
        .map((message) => ({ ...message, content: d.readAionUiMessageContent(message) }))
    },
  })
}
