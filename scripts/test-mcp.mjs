import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testDataDirectory = path.resolve(projectDirectory, '.mcp-test-data')
const expectedPrefix = `${projectDirectory}${path.sep}`
if (!testDataDirectory.startsWith(expectedPrefix) || path.basename(testDataDirectory) !== '.mcp-test-data') {
  throw new Error('MCP 테스트 데이터 경로가 프로젝트 내부의 전용 디렉터리가 아닙니다.')
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : null
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function startMockAionUi({
  agentId = 'agent-claude-test',
  agentName = 'Claude Code',
  modelId = 'claude-test-model',
  modelName = 'Claude Test Model',
  conversationId = 'conversation-test',
  conversationCreatedAt = Date.parse('2026-07-20T00:00:00.000Z'),
  conversationModelId = `${modelId}[1m]`,
} = {}) {
  const server = createHttpServer((request, response) => {
    const send = (data) => {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ success: true, data }))
    }
    if (request.url === '/api/agents/management') {
      return send([{
        id: agentId,
        name: agentName,
        agent_type: 'acp',
        backend: 'claude',
        installed: true,
        enabled: true,
        available_models: {
          current_model_id: modelId,
          available_models: [{ value: modelId, name: modelName }],
        },
      }])
    }
    if (request.url === '/api/providers') return send([])
    if (request.url === '/api/skills') return send([])
    if (request.url === '/api/mcp/servers') return send([])
    if (request.url === `/api/conversations/${conversationId}`) {
      return send({
        id: conversationId,
        name: 'MCP 전체 대화 조회 검증',
        type: 'acp',
        created_at: conversationCreatedAt,
        modified_at: conversationCreatedAt + 60_000,
        extra: { agent_id: agentId, current_model_id: conversationModelId, backend: 'claude' },
      })
    }
    if (request.url === `/api/conversations/${conversationId}/messages?limit=10000&content_mode=full`) {
      return send({
        items: [
          { id: 'message-user', type: 'text', position: 'right', content: { content: '첫 사용자 요청' } },
          { id: 'message-tool', type: 'acp_tool_call', position: 'left', content: { name: 'internal_tool' } },
          { id: 'message-tip', type: 'tips', position: 'center', content: '중간 시스템 안내' },
          { id: 'message-assistant', type: 'text', position: 'left', content: '최종 어시스턴트 응답' },
        ],
        oldest_cursor: 'message-user',
        newest_cursor: 'message-assistant',
        has_more_before: false,
        has_more_after: false,
      })
    }
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ success: false, error: 'not found' }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(typeof address === 'object' && address, '가짜 AionUi 포트를 할당하지 못했습니다.')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function publishMockAionUiDiscovery(discoveryFile, mockAionUi) {
  const port = Number(new URL(mockAionUi.baseUrl).port)
  await writeFile(discoveryFile, `${JSON.stringify({
    schemaVersion: 1,
    host: '127.0.0.1',
    port,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  })}\n`, 'utf8')
}

async function waitForServer(baseUrl, child, logs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) throw new Error(`격리 API 서버가 종료되었습니다.\n${logs.join('')}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // 서버가 수신 준비를 마칠 때까지 재시도합니다.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`격리 API 서버 시작 시간이 초과되었습니다.\n${logs.join('')}`)
}

function parseToolResult(name, result) {
  const text = result.content?.find((item) => item.type === 'text')?.text ?? ''
  if (result.isError) throw new Error(`${name}: ${text || '알 수 없는 MCP 오류'}`)
  assert.ok(text, `${name}: 텍스트 결과가 없습니다.`)
  return JSON.parse(text)
}

async function main() {
  await rm(testDataDirectory, { recursive: true, force: true })
  await mkdir(testDataDirectory, { recursive: true })
  const port = await availablePort()
  assert.ok(port, '테스트 포트를 할당하지 못했습니다.')
  const apiBaseUrl = `http://127.0.0.1:${port}`
  let mockAionUi = await startMockAionUi()
  const aionUiDiscoveryFile = path.join(testDataDirectory, '_aionui-backend.json')
  await publishMockAionUiDiscovery(aionUiDiscoveryFile, mockAionUi)
  const environment = {
    ...process.env,
    MNP_API_HOST: '127.0.0.1',
    MNP_API_PORT: String(port),
    MNP_API_URL: apiBaseUrl,
    MNP_PUBLIC_URL: 'https://mindnprogress.test',
    MNP_DATA_DIR: testDataDirectory,
    MNP_AIONUI_URL: '',
    MNP_AIONUI_DISCOVERY_FILE: aionUiDiscoveryFile,
    MNP_ADMIN_EMAIL: 'mcp-test-admin@mind.local',
    MNP_ADMIN_PASSWORD: 'McpTest!2026',
    MNP_AI_ATTRIBUTION_DURATION_MS: '10000',
  }
  const serverLogs = []
  const apiServer = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  apiServer.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()))
  apiServer.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()))

  let client = null
  const calledTools = new Map()
  try {
    await waitForServer(apiBaseUrl, apiServer, serverLogs)
    await access(path.join(testDataDirectory, '_integration-token'))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: environment,
      stderr: 'pipe',
    })
    client = new Client({ name: 'mindnprogress-full-regression', version: '1.0.0' })
    await client.connect(transport)
    const listedTools = await client.listTools()
    const registeredToolNames = listedTools.tools.map((tool) => tool.name).sort()
    assert.equal(registeredToolNames.length, 31, `예상과 다른 MCP 도구 수: ${registeredToolNames.length}`)

    const invoke = async (name, args = {}) => {
      calledTools.set(name, (calledTools.get(name) ?? 0) + 1)
      return parseToolResult(name, await client.callTool({ name, arguments: args }))
    }
    const invokeExpectError = async (name, args, expectedText) => {
      calledTools.set(name, (calledTools.get(name) ?? 0) + 1)
      const result = await client.callTool({ name, arguments: args })
      const text = result.content?.find((item) => item.type === 'text')?.text ?? ''
      assert.equal(result.isError, true, `${name}: 실패해야 하는 요청이 성공했습니다.`)
      assert.match(text, expectedText, `${name}: 예상한 오류가 아닙니다. ${text}`)
    }

    const guide = await invoke('mindnprogress_read_me_first')
    assert.equal(guide.guide.product.name, 'MindNProgress')
    assert.match(guide.guide.dataModel.cardContent.sharedKnowledge, /재사용/)

    const createdMindmap = await invoke('mindnprogress_create_mindmap', {
      title: 'MCP 전체 회귀 문서',
      color: 'blue',
      cards: [
        { key: 'root', label: '전체 회귀', kind: 'root', description: '루트 업무 https://example.com/root', taskUrl: 'https://example.com/root' },
        { key: 'branch-a', parentKey: 'root', label: '기능 A', kind: 'branch', sharedKnowledge: '기능 A의 재사용 가능한 결정과 결과' },
        { key: 'branch-b', parentKey: 'root', label: '기능 B', kind: 'branch' },
        { key: 'task-a', parentKey: 'branch-a', label: '업무 A', kind: 'task', isWork: true, status: 'in-progress', progress: 30, taskUrl: 'https://example.com/task-a' },
      ],
    })
    const mapId = createdMindmap.document.id
    assert.equal(createdMindmap.cardCount, 4)

    const createdSingle = await invoke('mindnprogress_create_document', {
      title: 'MCP 단일 문서', color: 'green', rootLabel: '단일 루트', rootDescription: '삭제 및 복원 검증',
    })
    const secondaryMapId = createdSingle.map.id
    const secondaryRootId = createdSingle.map.nodes[0].id

    const documents = await invoke('mindnprogress_list_documents')
    assert.deepEqual(documents.maps.map((map) => map.id).sort(), [mapId, secondaryMapId].sort())

    let documentResult = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(documentResult.map.nodes.length, 4)
    assert.equal(documentResult.map.nodes.find((node) => node.id === 'branch-a')?.data.sharedKnowledge, '기능 A의 재사용 가능한 결정과 결과')
    assert.equal(documentResult.access.documentUrl, `https://mindnprogress.test/mindmap/${mapId}`)
    assert.equal(documentResult.access.cards.find((card) => card.cardId === 'task-a')?.accessUrl, `https://mindnprogress.test/mindmap/${mapId}/task-a`)
    const loginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mcp-test-admin@mind.local', password: 'McpTest!2026' }),
    })
    assert.equal(loginResponse.status, 200)
    const sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(sessionCookie, '테스트 관리자 세션 쿠키가 없습니다.')
    const integrationToken = (await readFile(path.join(testDataDirectory, '_integration-token'), 'utf8')).trim()
    const unspecifiedCommentResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${integrationToken}`,
        'Content-Type': 'application/json',
        'X-MNP-AI-Map-Id': mapId,
        'X-MNP-AI-Card-Id': 'task-a',
      },
      body: JSON.stringify({ nodeId: 'task-a', text: '대화 귀속 복구 전 모델 미지정 댓글' }),
    })
    assert.equal(unspecifiedCommentResponse.status, 201)
    const unspecifiedComment = await unspecifiedCommentResponse.json()
    assert.equal(unspecifiedComment.comment.author.name, 'AI(모델 미지정)')
    const attributionResponse = await fetch(`${apiBaseUrl}/api/integrations/aionui/attributions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        agentId: 'agent-claude-test',
        modelId: 'claude-test-model',
        mapId,
        cardId: 'task-a',
      }),
    })
    assert.equal(attributionResponse.status, 201)
    const attribution = await attributionResponse.json()
    assert.equal(attribution.authorName, 'Claude Code(Claude Test Model)')
    assert.ok(attribution.attributionToken)
    assert.equal(attribution.editorId, 'user-admin')

    const context = await invoke('mindnprogress_get_context', {
      mapId,
      cardId: 'task-a',
      editorId: attribution.editorId,
      attributionToken: attribution.attributionToken,
    })
    assert.equal(context.selection.card.id, 'task-a')
    assert.equal(context.selection.taskLinks.available.length, 2)
    assert.equal(context.selection.taskLinks.startupInspection.mode, 'default')
    assert.equal(context.selection.taskLinks.startupInspection.conversationInspection.mode, 'not-applicable')
    assert.deepEqual(context.selection.taskLinks.startupInspection.conversationInspection.sources, [])
    assert.equal(context.selection.knowledgeSources.all.length, 0)
    assert.equal(context.selection.accessUrl, `https://mindnprogress.test/mindmap/${mapId}/task-a`)

    const completionResponse = await fetch(attribution.completionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conversation-test' }),
    })
    assert.equal(completionResponse.status, 200)
    await access(path.join(testDataDirectory, '_ai-conversation-attributions.json'))
    const repairedCommentsResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/comments?nodeId=task-a`, {
      headers: { Cookie: sessionCookie },
    })
    assert.equal(repairedCommentsResponse.status, 200)
    const repairedComments = await repairedCommentsResponse.json()
    assert.equal(
      repairedComments.comments.find((comment) => comment.id === unspecifiedComment.comment.id)?.author.name,
      'Claude Code(Claude Test Model)',
    )
    const repairedNotificationsResponse = await fetch(`${apiBaseUrl}/api/notifications`, {
      headers: { Cookie: sessionCookie },
    })
    assert.equal(repairedNotificationsResponse.status, 200)
    const repairedNotifications = await repairedNotificationsResponse.json()
    assert.equal(
      repairedNotifications.notifications.find((notification) => notification.commentId === unspecifiedComment.comment.id)?.actor.name,
      'Claude Code(Claude Test Model)',
    )
    documentResult = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(documentResult.map.nodes.find((node) => node.id === 'task-a')?.data.aiConversationId, 'conversation-test')
    const conversationTranscript = await invoke('mindnprogress_get_ai_conversation_transcript', { mapId, cardId: 'task-a' })
    assert.equal(conversationTranscript.conversation.id, 'conversation-test')
    assert.equal(conversationTranscript.card.cardId, 'task-a')
    assert.equal(conversationTranscript.messageCount, 4)
    assert.equal(conversationTranscript.exportedMessageCount, 3)
    assert.equal(conversationTranscript.truncated, false)
    assert.match(conversationTranscript.transcript, /^대화: MCP 전체 대화 조회 검증\n대화 ID: conversation-test\n내보낸 시각: .+\n유형: acp/)
    assert.match(conversationTranscript.transcript, /사용자:\n첫 사용자 요청/)
    assert.match(conversationTranscript.transcript, /시스템:\n중간 시스템 안내/)
    assert.match(conversationTranscript.transcript, /어시스턴트:\n최종 어시스턴트 응답/)
    assert.doesNotMatch(conversationTranscript.transcript, /internal_tool|acp_tool_call/)
    await invokeExpectError('mindnprogress_get_ai_conversation_transcript', {
      mapId, cardId: 'branch-a',
    }, /카드에 연결된 AI 대화가 없습니다/)

    const freshTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: environment,
      stderr: 'pipe',
    })
    const freshClient = new Client({ name: 'mindnprogress-attribution-reconnect', version: '1.0.0' })
    await freshClient.connect(freshTransport)
    try {
      const reconnectedComment = parseToolResult('mindnprogress_add_comment', await freshClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, nodeId: 'task-a', text: 'MCP 재연결 후 모델 귀속 검증' },
      }))
      assert.equal(reconnectedComment.comment.author.name, 'Claude Code(Claude Test Model)')
    } finally {
      await freshClient.close()
    }

    const idFallbackContext = await invoke('mindnprogress_get_context', {
      mapId,
      cardId: 'task-a',
      editorId: attribution.editorId,
      attributionToken: 'expired-attribution-token-00000000',
    })
    assert.equal(idFallbackContext.selection.card.id, 'task-a')

    await new Promise((resolve) => mockAionUi.server.close(resolve))
    mockAionUi = await startMockAionUi({
      agentId: 'agent-codex-restarted',
      agentName: 'Codex',
      modelId: 'gpt-restarted',
      modelName: 'GPT Restarted',
    })
    await publishMockAionUiDiscovery(aionUiDiscoveryFile, mockAionUi)
    const restartedOptionsResponse = await fetch(`${apiBaseUrl}/api/integrations/aionui/options`, {
      headers: { Cookie: sessionCookie },
    })
    assert.equal(restartedOptionsResponse.status, 200)
    const restartedOptions = await restartedOptionsResponse.json()
    assert.equal(restartedOptions.aionUiUrl, mockAionUi.baseUrl)
    assert.equal(restartedOptions.agents[0].id, 'agent-codex-restarted')

    const users = await invoke('mindnprogress_list_users')
    assert.ok(Array.isArray(users.users))

    documentResult.map.nodes[0].data.description = '전체 저장 회귀 변경'
    const saved = await invoke('mindnprogress_save_document', {
      mapId,
      baseVersion: documentResult.map.version,
      nodes: documentResult.map.nodes,
      edges: documentResult.map.edges,
    })
    assert.ok(saved.map.version > documentResult.map.version)
    assert.equal(saved.map.updatedBy.id, attribution.editorId)
    assert.equal(saved.map.updatedBy.name, 'Claude Code(Claude Test Model)')

    const knowledgeComment = await invoke('mindnprogress_add_comment', {
      mapId, nodeId: 'branch-a', text: '선행 분석 결과를 재사용합니다.',
    })
    const knowledgeSaved = await invoke('mindnprogress_save_document', {
      mapId,
      baseVersion: saved.map.version,
      nodes: saved.map.nodes.map((node) => node.id === 'branch-a'
        ? { ...node, data: { ...node.data, aiConversationId: 'conversation-test' } }
        : node),
      edges: [
        ...saved.map.edges,
        {
          id: 'knowledge-branch-a-task-a', source: 'branch-a', target: 'task-a', type: 'bezier',
          data: { relation: 'knowledge', knowledgePolicy: 'reuse-first' },
        },
        {
          id: 'knowledge-root-task-a', source: 'root', target: 'task-a', type: 'bezier',
          data: { relation: 'knowledge', knowledgePolicy: 'inspect-if-insufficient' },
        },
      ],
    })
    assert.ok(knowledgeSaved.map.edges.some((edge) => edge.data?.relation === 'knowledge'))

    const knowledgeContext = await invoke('mindnprogress_get_context', {
      mapId,
      cardId: 'task-a',
      editorId: attribution.editorId,
      attributionToken: attribution.attributionToken,
    })
    assert.equal(knowledgeContext.selection.taskLinks.startupInspection.mode, 'knowledge-guided')
    assert.deepEqual(knowledgeContext.selection.parents.map((card) => card.id), ['branch-a'])
    assert.deepEqual(knowledgeContext.selection.knowledgeSources.primary.map((source) => source.card.id), ['branch-a'])
    assert.deepEqual(knowledgeContext.selection.knowledgeSources.fallback.map((source) => source.card.id), ['root'])
    assert.equal(knowledgeContext.selection.knowledgeSources.primary[0].card.data.sharedKnowledge, '기능 A의 재사용 가능한 결정과 결과')
    assert.equal(knowledgeContext.selection.knowledgeSources.primary[0].comments[0].id, knowledgeComment.comment.id)
    assert.deepEqual(knowledgeContext.selection.taskLinks.startupInspection.targets.map((target) => target.url), ['https://example.com/task-a'])
    assert.deepEqual(knowledgeContext.selection.taskLinks.startupInspection.fallbackTargets.map((target) => target.url), ['https://example.com/root'])
    assert.deepEqual(knowledgeContext.selection.taskLinks.startupInspection.conversationInspection, {
      mode: 'on-demand',
      required: false,
      tool: 'mindnprogress_get_ai_conversation_transcript',
      sources: [{
        cardId: 'branch-a',
        label: '기능 A',
        conversationAvailable: true,
        toolArguments: { mapId, cardId: 'branch-a' },
      }],
      triggers: [
        '공유 지식, 설명과 댓글만으로 현재 작업에 필요한 결정 근거가 부족함',
        '예외 조건 또는 이전 실패 원인을 확인해야 함',
        '공유 지식과 댓글이 서로 충돌하여 원래 대화 맥락이 필요함',
        '사용자가 과거 AI 대화를 직접 확인하도록 요청함',
      ],
      instruction: 'primarySources의 sharedKnowledge, 설명과 댓글을 먼저 사용하세요. 그래도 현재 작업에 필요한 결정 근거, 예외 조건 또는 이전 실패 원인이 구체적으로 부족할 때만 sources 중 필요한 카드의 toolArguments로 대화 기록을 조회하세요.',
      evidenceRule: '대화 내용은 보조 근거로 취급합니다. 실제 코드와 산출물로 검증하고, 대화 전문을 댓글이나 sharedKnowledge에 복사하지 말며, 검증된 재사용 가능 결론만 sharedKnowledge에 요약하세요.',
    })

    const history = await invoke('mindnprogress_list_history', { mapId, limit: 1 })
    assert.equal(history.revisions.length, 1)
    assert.equal(history.hasMore, true)
    assert.equal(history.nextOffset, 1)
    const nextHistory = await invoke('mindnprogress_list_history', { mapId, offset: history.nextOffset, limit: 1 })
    assert.equal(nextHistory.revisions.length, 1)
    assert.notEqual(nextHistory.revisions[0].id, history.revisions[0].id)
    const restoredHistory = await invoke('mindnprogress_restore_history', { mapId, revisionId: history.revisions[0].id })
    assert.equal(restoredHistory.map.id, mapId)

    const addedCardResult = await invoke('mindnprogress_add_card', {
      mapId,
      parentId: 'root',
      data: { label: '추가 카드', description: '', kind: 'branch', status: 'planned', progress: 0 },
    })
    const addedCard = addedCardResult.map.nodes.find((node) => node.data.label === '추가 카드')
    assert.ok(addedCard)
    assert.equal(addedCard.data.sharedKnowledge, '')

    const updatedCardResult = await invoke('mindnprogress_update_card', {
      mapId,
      nodeId: addedCard.id,
      data: {
        label: '수정된 업무 카드', description: '업데이트 검증', sharedKnowledge: '후속 카드가 재사용할 완료 결과', kind: 'task', isWork: true,
        status: 'done', progress: 100, dueDate: '2026-07-31', checklist: [{ id: 'check-regression', text: '완료 조건', done: true }],
      },
      position: { x: 700, y: 220 },
    })
    const updatedCard = updatedCardResult.map.nodes.find((node) => node.id === addedCard.id)
    assert.equal(updatedCard.data.progress, 100)
    assert.equal(updatedCard.data.sharedKnowledge, '후속 카드가 재사용할 완료 결과')
    assert.equal(updatedCard.data.sharedKnowledgeUpdatedBy.name, 'Claude Code(Claude Test Model)')
    assert.ok(updatedCard.data.sharedKnowledgeUpdatedAt)

    const movedCardResult = await invoke('mindnprogress_move_card', { mapId, nodeId: addedCard.id, newParentId: 'branch-b' })
    assert.ok(movedCardResult.map.edges.some((edge) => edge.source === 'branch-b' && edge.target === addedCard.id))

    const deletedCardResult = await invoke('mindnprogress_delete_card', { mapId, nodeId: addedCard.id, includeDescendants: true })
    assert.ok(!deletedCardResult.map.nodes.some((node) => node.id === addedCard.id))

    documentResult = await invoke('mindnprogress_get_document', { mapId })
    const metadataResult = await invoke('mindnprogress_update_document_info', {
      mapId, baseVersion: documentResult.map.version, title: 'MCP 전체 회귀 문서 수정', color: 'red',
    })
    assert.equal(metadataResult.summary.color, 'red')

    const reordered = await invoke('mindnprogress_reorder_documents', { mapIds: [secondaryMapId, mapId] })
    assert.deepEqual(reordered.maps.map((map) => map.id), [secondaryMapId, mapId])

    const notificationsPath = path.join(testDataDirectory, '_notifications')
    await rm(notificationsPath, { recursive: true, force: true })
    await writeFile(notificationsPath, '알림 디렉터리 접근 실패 회귀 조건', 'utf8')
    const commentWithFailedNotification = await invoke('mindnprogress_add_comment', {
      mapId, nodeId: 'root', text: '알림 실패와 무관하게 한 번만 생성되어야 합니다.',
    })
    assert.equal(commentWithFailedNotification.comment.author.name, 'Claude Code(Claude Test Model)')
    let commentList = await invoke('mindnprogress_list_comments', { mapId, nodeId: 'root' })
    assert.equal(commentList.comments.filter((comment) => comment.id === commentWithFailedNotification.comment.id).length, 1)
    const deletedWithFailedNotification = await invoke('mindnprogress_delete_comment', {
      mapId, commentId: commentWithFailedNotification.comment.id,
    })
    assert.deepEqual(deletedWithFailedNotification.deletedIds, [commentWithFailedNotification.comment.id])
    await rm(notificationsPath, { force: true })
    await mkdir(notificationsPath, { recursive: true })

    await writeFile(path.join(notificationsPath, 'user-admin.json'), '{', 'utf8')
    const parentComment = await invoke('mindnprogress_add_comment', { mapId, nodeId: 'root', text: '댓글 상태와 반응 검증' })
    const replyComment = await invoke('mindnprogress_add_comment', {
      mapId, nodeId: 'root', parentId: parentComment.comment.id, text: '답글 검증',
    })
    assert.equal(replyComment.comment.parentId, parentComment.comment.id)
    const resolved = await invoke('mindnprogress_set_comment_resolved', {
      mapId, commentId: parentComment.comment.id, resolved: true,
    })
    assert.ok(resolved.comment.resolvedAt)
    const reacted = await invoke('mindnprogress_toggle_comment_reaction', {
      mapId, commentId: parentComment.comment.id, emoji: '👍',
    })
    assert.ok(reacted.comment.reactions['👍'].includes(attribution.editorId))
    const updatedComment = await invoke('mindnprogress_update_comment', {
      mapId, commentId: parentComment.comment.id, text: '댓글 본문 수정과 메타데이터 보존 검증',
    })
    assert.equal(updatedComment.comment.id, parentComment.comment.id)
    assert.equal(updatedComment.comment.text, '댓글 본문 수정과 메타데이터 보존 검증')
    assert.equal(updatedComment.comment.createdAt, parentComment.comment.createdAt)
    assert.equal(updatedComment.comment.author.name, parentComment.comment.author.name)
    assert.equal(updatedComment.comment.resolvedAt, resolved.comment.resolvedAt)
    assert.ok(updatedComment.comment.reactions['👍'].includes(attribution.editorId))
    assert.ok(updatedComment.comment.updatedAt)
    commentList = await invoke('mindnprogress_list_comments', { mapId, nodeId: 'root' })
    assert.equal(commentList.comments.length, 2)
    assert.equal(commentList.comments.find((comment) => comment.id === replyComment.comment.id)?.parentId, parentComment.comment.id)
    const deletedThread = await invoke('mindnprogress_delete_comment', { mapId, commentId: parentComment.comment.id })
    assert.equal(deletedThread.deletedIds.length, 2)

    const integrationNotifications = [
      { id: 'notification-regression-1', userId: attribution.editorId, createdAt: '2026-07-17T00:00:00.000Z', readAt: null, message: '첫 알림' },
      { id: 'notification-regression-2', userId: attribution.editorId, createdAt: '2026-07-17T00:01:00.000Z', readAt: null, message: '둘째 알림' },
    ]
    await writeFile(path.join(notificationsPath, `${attribution.editorId}.json`), `${JSON.stringify(integrationNotifications, null, 2)}\n`, 'utf8')
    const notificationList = await invoke('mindnprogress_list_notifications')
    assert.equal(notificationList.notifications.length, 2)
    const readOne = await invoke('mindnprogress_mark_notification_read', { notificationId: 'notification-regression-1' })
    assert.ok(readOne.notification.readAt)
    const readAll = await invoke('mindnprogress_mark_all_notifications_read')
    assert.ok(readAll.notifications.every((notification) => notification.readAt))

    const trashed = await invoke('mindnprogress_move_document_to_trash', { mapId: secondaryMapId })
    assert.equal(trashed.trashedId, secondaryMapId)
    let trash = await invoke('mindnprogress_list_trash')
    assert.ok(trash.maps.some((map) => map.id === secondaryMapId))
    const restored = await invoke('mindnprogress_restore_document', { mapId: secondaryMapId })
    assert.equal(restored.map.id, secondaryMapId)
    await invoke('mindnprogress_move_document_to_trash', { mapId: secondaryMapId })
    const permanentlyDeleted = await invoke('mindnprogress_delete_trashed_documents', {
      mapIds: [secondaryMapId], confirmPermanentDeletion: true,
    })
    assert.deepEqual(permanentlyDeleted.deletedIds, [secondaryMapId])

    const emptyTarget = await invoke('mindnprogress_create_document', {
      title: '전체 비우기 대상', color: 'amber', rootLabel: '비우기 대상', rootDescription: '',
    })
    await invoke('mindnprogress_move_document_to_trash', { mapId: emptyTarget.map.id })
    const emptied = await invoke('mindnprogress_empty_trash', { confirmPermanentDeletion: true })
    assert.ok(emptied.deletedIds.includes(emptyTarget.map.id))
    trash = await invoke('mindnprogress_list_trash')
    assert.equal(trash.maps.length, 0)

    const finalDocument = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(finalDocument.map.id, mapId)
    assert.ok(!finalDocument.map.nodes.some((node) => node.id === secondaryRootId))

    await invokeExpectError('mindnprogress_create_mindmap', {
      title: '잘못된 다중 루트',
      cards: [
        { key: 'root-a', label: '루트 A', kind: 'root' },
        { key: 'root-b', label: '루트 B', kind: 'root' },
      ],
    }, /루트 카드는 정확히 하나/)
    await invokeExpectError('mindnprogress_create_mindmap', {
      title: '잘못된 하위 루트',
      cards: [
        { key: 'root', label: '루트', kind: 'root' },
        { key: 'nested-root', parentKey: 'root', label: '하위 루트', kind: 'root' },
      ],
    }, /하위 카드는 kind=root/)
    await invokeExpectError('mindnprogress_save_document', {
      mapId,
      baseVersion: Math.max(1, finalDocument.map.version - 1),
      nodes: finalDocument.map.nodes,
      edges: finalDocument.map.edges,
    }, /다른 사용자가 먼저/)
    await invokeExpectError('mindnprogress_move_card', {
      mapId, nodeId: 'branch-a', newParentId: 'task-a',
    }, /자기 자신이나 하위 카드/)
    await invokeExpectError('mindnprogress_delete_card', {
      mapId, nodeId: 'root', includeDescendants: true,
    }, /루트 카드는 삭제할 수 없습니다/)
    await invokeExpectError('mindnprogress_add_comment', {
      mapId, nodeId: 'missing-card', text: '존재하지 않는 카드',
    }, /댓글을 남길 노드를 찾을 수 없습니다/)
    await invokeExpectError('mindnprogress_update_comment', {
      mapId, commentId: 'missing-comment', text: '존재하지 않는 댓글',
    }, /댓글을 찾을 수 없습니다/)
    await invokeExpectError('mindnprogress_restore_history', {
      mapId, revisionId: 'missing-revision',
    }, /변경 이력을 찾을 수 없습니다/)
    await invokeExpectError('mindnprogress_delete_trashed_documents', {
      mapIds: [mapId], confirmPermanentDeletion: false,
    }, /Invalid literal value|Invalid input/)
    await invokeExpectError('mindnprogress_empty_trash', {
      confirmPermanentDeletion: false,
    }, /Invalid literal value|Invalid input/)
    await invokeExpectError('mindnprogress_mark_notification_read', {
      notificationId: 'missing-notification',
    }, /알림을 찾을 수 없습니다/)
    await invokeExpectError('mindnprogress_move_document_to_trash', { mapId }, /마지막 문서/)

    const afterRejectedOperations = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(afterRejectedOperations.map.version, finalDocument.map.version)

    const attributionExpiresAt = Number(attribution.expiresAt)
    assert.ok(Number.isFinite(attributionExpiresAt), 'AI 귀속 만료 시각이 숫자가 아닙니다.')
    const attributionExpiryDelay = Math.max(0, attributionExpiresAt - Date.now() + 100)
    await new Promise((resolve) => setTimeout(resolve, attributionExpiryDelay))
    const postExpiryTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: environment,
      stderr: 'pipe',
    })
    const postExpiryClient = new Client({ name: 'mindnprogress-persistent-attribution', version: '1.0.0' })
    await postExpiryClient.connect(postExpiryTransport)
    try {
      const persistedComment = parseToolResult('mindnprogress_add_comment', await postExpiryClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, nodeId: 'task-a', text: '단기 토큰 만료 후 장기 대화 귀속 검증' },
      }))
      assert.equal(persistedComment.comment.author.name, 'Claude Code(Claude Test Model)')
    } finally {
      await postExpiryClient.close()
    }

    const uncalledTools = registeredToolNames.filter((name) => !calledTools.has(name))
    assert.deepEqual(uncalledTools, [], `호출되지 않은 MCP 도구: ${uncalledTools.join(', ')}`)
    console.log(JSON.stringify({
      registeredTools: registeredToolNames.length,
      calledTools: calledTools.size,
      totalCalls: [...calledTools.values()].reduce((sum, count) => sum + count, 0),
      status: 'passed',
    }, null, 2))
  } catch (error) {
    if (serverLogs.length > 0) console.error(serverLogs.join(''))
    throw error
  } finally {
    if (client) await client.close().catch(() => undefined)
    if (apiServer.exitCode === null) {
      apiServer.kill()
      await new Promise((resolve) => apiServer.once('exit', resolve))
    }
    await new Promise((resolve) => mockAionUi.server.close(resolve))
    await rm(testDataDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
