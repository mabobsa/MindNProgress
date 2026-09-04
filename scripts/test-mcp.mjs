import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MCP_TOOL_USAGE_DIRECTORY_NAME, readToolUsageTotals } from '../server/lib/mcpToolUsage.mjs'

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
  generalModelId = 'claude-general-model',
  generalModelName = 'Claude General Model',
  conversationId = 'conversation-test',
  conversationCreatedAt = Date.parse('2026-07-20T00:00:00.000Z'),
  conversationModelId = `${modelId}[1m]`,
} = {}) {
  let conversationRuntimeState = 'running'
  const dispatchRequests = []
  const conversationTitleUpdates = []
  const dispatches = new Map()
  const server = createHttpServer((request, response) => {
    const send = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
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
          available_models: [
            { value: modelId, name: modelName },
            { value: generalModelId, name: generalModelName },
          ],
        },
      }])
    }
    if (request.url === '/api/providers') return send([])
    if (request.url === '/api/skills') return send([])
    if (request.url === '/api/mcp/servers') return send([])
    if (request.url === '/api/internal/conversation-runtimes/active') {
      return send({
        schema_version: 1,
        generated_at: Date.now(),
        items: conversationRuntimeState === 'running'
          ? [{
              conversation_id: conversationId,
              runtime: {
                state: 'running',
                is_processing: true,
                task_status: 'running',
                pending_confirmations: 0,
                turn_id: 'turn-mcp-runtime-test',
              },
            }]
          : [],
      })
    }
    if (request.url === `/api/conversations/${conversationId}`) {
      return send({
        id: conversationId,
        name: 'MCP 전체 대화 조회 검증',
        type: 'acp',
        created_at: conversationCreatedAt,
        modified_at: conversationCreatedAt + 60_000,
        extra: { agent_id: agentId, current_model_id: conversationModelId, backend: 'claude' },
        runtime: {
          state: conversationRuntimeState,
          is_processing: conversationRuntimeState === 'running',
          task_status: conversationRuntimeState === 'running' ? 'running' : 'finished',
          can_send_message: conversationRuntimeState === 'idle',
          pending_confirmations: 0,
          turn_id: conversationRuntimeState === 'running' ? 'turn-mcp-runtime-test' : null,
        },
      })
    }
    if (request.url === '/api/conversations/conversation-unlinked-known') {
      return send({
        id: 'conversation-unlinked-known',
        name: 'MindNProgress 밖에서 시작한 일반 대화',
        type: 'acp',
        created_at: conversationCreatedAt + 240_000,
        modified_at: conversationCreatedAt + 300_000,
        extra: { agent_id: agentId, current_model_id: generalModelId, backend: 'claude' },
        runtime: {
          state: 'idle', is_processing: false, task_status: 'finished', can_send_message: true,
          pending_confirmations: 0, turn_id: null,
        },
      })
    }
    if (request.url === '/api/conversations/conversation-delegated') {
      if (request.method === 'PATCH') {
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          conversationTitleUpdates.push(body)
          send({
            id: 'conversation-delegated',
            name: body.name,
            name_source: body.name_source,
          })
        })
        return
      }
      return send({
        id: 'conversation-delegated',
        name: '위임 하위 카드',
        type: 'acp',
        created_at: conversationCreatedAt + 120_000,
        modified_at: conversationCreatedAt + 180_000,
        extra: { agent_id: agentId, current_model_id: modelId, backend: 'claude' },
        runtime: {
          state: 'idle', is_processing: false, task_status: 'finished', can_send_message: true,
          pending_confirmations: 0, turn_id: null,
        },
      })
    }
    if (request.url === '/api/conversations/conversation-inspected-card') {
      return send({
        id: 'conversation-inspected-card',
        name: '추가 조회 카드 대화',
        type: 'acp',
        created_at: conversationCreatedAt + 90_000,
        modified_at: conversationCreatedAt + 100_000,
        extra: { agent_id: agentId, current_model_id: modelId, backend: 'claude' },
        runtime: {
          state: 'idle', is_processing: false, task_status: 'finished', can_send_message: true,
          pending_confirmations: 0, turn_id: null,
        },
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
    if (request.url === '/api/conversations/conversation-delegated/messages?limit=100&content_mode=full') {
      return send({
        items: [
          { id: 'delegated-user', type: 'text', position: 'right', content: '하위 작업 지시' },
          { id: 'delegated-assistant', type: 'text', position: 'left', content: '하위 카드 작업을 완료하고 결과를 기록했습니다.' },
        ],
      })
    }
    if (request.method === 'GET'
      && request.url === '/api/internal/external-conversation-dispatches/capabilities') {
      return send({
        schemaVersion: 3,
        workspaceLeaseVersion: 2,
        atomicWorkspaceRebind: true,
        releasesRuntimeOnTerminal: true,
        persistentRecoveryState: true,
        explicitCompletionAfterInterruption: true,
      })
    }
    if (request.method === 'POST' && request.url === '/api/internal/external-conversation-dispatches') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const existing = dispatches.get(body.operationId)
        if (existing) {
          send({ ...existing, repeated: true }, 200)
          return
        }
        dispatchRequests.push(body)
        const targetConversationId = body.strategy === 'new' ? 'conversation-delegated' : body.targetConversationId
        const stored = {
          operationId: body.operationId,
          conversationId: targetConversationId,
          state: /-wake-\d+$/.test(body.operationId) ? 'completed' : 'running',
          turnId: `turn-${body.operationId}`,
          repeated: false,
        }
        dispatches.set(body.operationId, stored)
        send({ ...stored, state: 'starting', turnId: null }, 202)
      })
      return
    }
    const dispatchCompletionMatch = request.url?.match(
      /^\/api\/internal\/external-conversation-dispatches\/([^/?]+)\/complete$/,
    )
    if (request.method === 'POST' && dispatchCompletionMatch) {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const operationId = decodeURIComponent(dispatchCompletionMatch[1])
        const dispatch = dispatches.get(operationId)
        if (!dispatch) {
          response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ success: false, error: { code: 'EXTERNAL_DISPATCH_NOT_FOUND' } }))
          return
        }
        if (dispatch.state !== 'waiting_resume') {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({
            success: false,
            error: {
              code: 'EXTERNAL_DISPATCH_COMPLETION_NOT_ALLOWED',
              message: 'The dispatch is not waiting for explicit completion.',
            },
          }))
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        send({
          operationId,
          conversationId: body.conversationId,
          turnId: 'turn-explicit-completion',
          accepted: true,
        })
      })
      return
    }
    const dispatchStatusMatch = request.url?.match(/^\/api\/internal\/external-conversation-dispatches\/([^/?]+)$/)
    if (request.method === 'GET' && dispatchStatusMatch) {
      const dispatch = dispatches.get(decodeURIComponent(dispatchStatusMatch[1]))
      if (dispatch) return send(dispatch)
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
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispatchRequests,
    conversationTitleUpdates,
    setConversationRuntimeState: (state) => { conversationRuntimeState = state },
    completeDispatch: (operationId) => {
      const dispatch = dispatches.get(operationId)
      assert.ok(dispatch, `완료할 위임 operation을 찾지 못했습니다: ${operationId}`)
      dispatches.set(operationId, { ...dispatch, state: 'completed' })
    },
    setDispatchState: (operationId, state, resource = null) => {
      const dispatch = dispatches.get(operationId)
      assert.ok(dispatch, `상태를 변경할 위임 operation을 찾지 못했습니다: ${operationId}`)
      dispatches.set(operationId, { ...dispatch, state, resource })
    },
  }
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
    MNP_WORKSPACE_POOL_REGISTRY: path.join(testDataDirectory, '_missing-workspaces.json'),
    MNP_AIONUI_URL: '',
    MNP_AIONUI_DISCOVERY_FILE: aionUiDiscoveryFile,
    MNP_ADMIN_EMAIL: 'mcp-test-admin@mind.local',
    MNP_ADMIN_PASSWORD: 'McpTest!2026',
    MNP_AI_ATTRIBUTION_DURATION_MS: '10000',
    MNP_AI_DELEGATION_POLL_INTERVAL_MS: '100',
    AIONUI_CONVERSATION_ID: 'conversation-test',
    // 계측 쓰기를 기다리지 않고 검증할 수 있도록 스로틀만 짧게 줄인다.
    MNP_MCP_USAGE_FLUSH_MS: '1',
  }
  const serverLogs = []
  const startApiServer = () => {
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: projectDirectory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()))
    child.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()))
    return child
  }
  let apiServer = startApiServer()

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
    assert.equal(registeredToolNames.length, 49, `예상과 다른 MCP 도구 수: ${registeredToolNames.length}`)
    const toolSchema = (name) => listedTools.tools.find((tool) => tool.name === name)?.inputSchema
    const toolDescription = (name) => listedTools.tools.find((tool) => tool.name === name)?.description ?? ''
    for (const name of ['mindnprogress_update_card', 'mindnprogress_move_card', 'mindnprogress_delete_card', 'mindnprogress_list_comments', 'mindnprogress_add_comment']) {
      assert.ok(toolSchema(name)?.properties?.cardId, `${name}: cardId 공개 인자가 없습니다.`)
      assert.match(toolSchema(name)?.properties?.nodeId?.description ?? '', /기존 대화 호환용/)
    }
    assert.deepEqual(toolSchema('mindnprogress_update_card')?.properties?.responseMode?.enum, ['full', 'affected'])
    assert.equal(toolSchema('mindnprogress_update_card')?.properties?.responseMode?.default, 'full')
    for (const name of ['mindnprogress_add_card', 'mindnprogress_move_card', 'mindnprogress_delete_card']) {
      assert.deepEqual(toolSchema(name)?.properties?.responseMode?.enum, ['full', 'affected'])
      assert.equal(toolSchema(name)?.properties?.responseMode?.default, 'affected')
    }
    assert.deepEqual(toolSchema('mindnprogress_patch_card_text')?.properties?.field?.enum, ['description', 'sharedKnowledge'])
    assert.equal(toolSchema('mindnprogress_patch_card_text')?.properties?.expectedSha256?.pattern, '^[a-f0-9]{64}$')
    assert.ok(toolSchema('mindnprogress_patch_card_text')?.required?.includes('operation'))
    assert.equal(toolSchema('mindnprogress_list_shared_knowledge_candidates')?.properties?.limit?.maximum, 100)
    assert.equal(toolSchema('mindnprogress_get_shared_knowledge_review_context')?.properties?.commentLimit?.minimum, 0)
    assert.equal(toolSchema('mindnprogress_apply_shared_knowledge_review')?.properties?.patches?.maxItems, 20)
    assert.deepEqual(
      toolSchema('mindnprogress_apply_shared_knowledge_review')?.properties?.patches?.items?.properties?.reviewResult?.enum,
      ['cleaned', 'accepted-long'],
    )
    assert.ok(toolSchema('mindnprogress_add_card')?.properties?.parentCardId)
    assert.ok(toolSchema('mindnprogress_move_card')?.properties?.newParentCardId)
    assert.ok(toolSchema('mindnprogress_add_comment')?.properties?.parentCommentId)
    assert.ok(toolSchema('mindnprogress_add_comment')?.required?.includes('summary'))
    assert.equal(toolSchema('mindnprogress_add_comment')?.properties?.text, undefined)
    assert.ok(toolSchema('mindnprogress_recover_ai_delegation')?.properties?.delegationId)
    assert.ok(toolSchema('mindnprogress_recover_ai_delegation')?.required?.includes('instruction'))
    assert.ok(toolSchema('mindnprogress_checkpoint_ai_workspace')?.properties?.leaseId)
    assert.ok(toolSchema('mindnprogress_checkpoint_ai_workspace')?.properties?.jobId)
    assert.equal(toolSchema('mindnprogress_checkpoint_ai_workspace')?.properties?.paths?.minItems, 1)
    assert.ok(toolSchema('mindnprogress_checkpoint_ai_workspace')?.required?.includes('paths'))
    assert.ok(toolSchema('mindnprogress_checkpoint_ai_workspace')?.required?.includes('commitMessage'))
    assert.deepEqual(
      toolSchema('mindnprogress_checkpoint_ai_workspace')?.properties?.commitMessage?.required,
      ['summary', 'background', 'cause', 'changes'],
    )
    assert.equal(toolSchema('mindnprogress_checkpoint_ai_workspace')?.properties?.confirmNoChanges, undefined)
    assert.ok(toolSchema('mindnprogress_confirm_ai_workspace_no_changes')?.properties?.leaseId)
    assert.ok(toolSchema('mindnprogress_confirm_ai_workspace_no_changes')?.properties?.jobId)
    assert.ok(toolSchema('mindnprogress_complete_ai_delegation')?.required?.includes('mapId'))

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
    assert.equal(guide.guide.version, '4.13')
    assert.match(guide.guide.operationRules.join('\n'), /AionUi에서 시작한 대화.*임시 귀속.*AI_ATTRIBUTION_UNRESOLVED/)
    assert.match(guide.guide.operationRules.join('\n'), /응답을 받지 못한 시도는 횟수에 포함하지 않고/)
    assert.match(guide.guide.operationRules.join('\n'), /mindnprogress_complete_ai_delegation/)
    assert.match(guide.guide.operationRules.join('\n'), /중지된 위임을 resume하면 같은 AI 대화와 기존 worker lease/)
    assert.match(guide.guide.dataModel.cardContent.sharedKnowledge, /재사용/)
    assert.match(guide.guide.sharedKnowledgePolicy.writeWhen, /새 사실·결정·제약·검증 결과.*기존 내용이 더 이상 유효하지 않을 때만 수정/)
    assert.match(guide.guide.sharedKnowledgePolicy.update, /새 이력 절을 덧붙이지 말고 기존 절만 해시 조건부로 교체/)
    assert.deepEqual(guide.guide.sharedKnowledgePolicy.maintenance.reviewOrder, ['priority', 'recommended', 'attention'])
    assert.equal(guide.guide.sharedKnowledgePolicy.maintenance.acceptedLongReviewMaxAgeDays, 30)
    assert.equal(guide.guide.sharedKnowledgePolicy.maintenance.automaticMutation, false)
    assert.match(guide.guide.dataModel.workFields.progress, /일반 isWork=false 묶음 카드.*읽기 전용 요약값/)
    assert.match(guide.guide.authoringRules.join('\n'), /모든 실제 isWork=true 후손.*동일 가중치.*중간 묶음의 요약값은 상위 집계에 다시 포함하지 않음/)
    assert.match(guide.guide.authoringRules.join('\n'), /이미지·Ref·Dooray 지식 카드.*자동 집계하지 않음/)
    assert.equal(guide.guide.knowledgeLinePolicy.mode, 'actual-use-only')
    assert.equal(guide.guide.knowledgeLinePolicy.evaluateAt, 'after-work')
    assert.match(guide.guide.knowledgeLinePolicy.discovery, /전수 검색하지 않음.*실제로 조회하고 근거로 사용/)
    assert.match(guide.guide.knowledgeLinePolicy.autoConnectWhenAll.join('\n'), /검증된 sharedKnowledge[\s\S]*직접 영향을 줌[\s\S]*후속 세션[\s\S]*같은 문서/)
    assert.match(guide.guide.knowledgeLinePolicy.proposeOnlyWhenAny.join('\n'), /아직 확정되지 않았거나[\s\S]*관련 가능성만[\s\S]*다른 문서[\s\S]*명확히 판단할 수 없음/)
    assert.match(guide.guide.knowledgeLinePolicy.neverConnectFor.join('\n'), /비슷한 제목[\s\S]*일회성 참조[\s\S]*업무 선행 관계/)
    assert.match(guide.guide.knowledgeLinePolicy.policySelection['reuse-first'], /우선 재사용/)
    assert.match(guide.guide.knowledgeLinePolicy.policySelection['inspect-if-insufficient'], /부족할 때만/)
    assert.doesNotMatch(guide.guide.authoringRules.join('\n'), /주요 지식선|보조 지식선/)
    assert.match(toolDescription('mindnprogress_add_knowledge_line'), /guide\.knowledgeLinePolicy/)
    assert.match(guide.guide.authoringRules.join('\n'), /실제로 실행할 카드.*구현·검증 조건이 2개 이상.*결과 중심 체크리스트.*별도 하위 카드.*중복하지 않/)
    assert.match(guide.guide.operationRules.join('\n'), /변경할 필드만 보내고/)
    assert.match(guide.guide.operationRules.join('\n'), /textIntegrity SHA-256.*mindnprogress_patch_card_text.*필드 전체를 다시 생성하지 않음/)
    assert.ok(guide.guide.operationRules.join('\n').includes('\\uXXXX'))
    assert.match(guide.guide.operationRules.join('\n'), /after\.sha256.*expectedSha256.*이전 해시를 재사용하지 않음/)
    assert.ok(toolDescription('mindnprogress_patch_card_text').includes('\\uXXXX'))
    assert.match(toolDescription('mindnprogress_patch_card_text'), /after\.sha256.*expectedSha256.*이전 해시를 재사용하지 않음/)
    assert.match(guide.guide.operationRules.join('\n'), /mindnprogress_list_shared_knowledge_candidates.*mindnprogress_get_shared_knowledge_review_context.*mindnprogress_apply_shared_knowledge_review/)
    assert.match(guide.guide.operationRules.join('\n'), /cardId.*nodeId.*기존 대화 호환용/)
    assert.match(guide.guide.operationRules.join('\n'), /조회 도구는 문서 version을 변경하지 않으며/)
    assert.match(guide.guide.operationRules.join('\n'), /mindnprogress_get_ai_work_states.*동시에 수정하지 않음/)
    assert.match(guide.guide.operationRules.join('\n'), /mindnprogress_get_ai_workspace_pool.*임의로 worker를 사용하지 않음/)
    assert.match(guide.guide.operationRules.join('\n'), /작업공간 pool.*병렬 위임.*직렬 통합/)
    assert.match(guide.guide.operationRules.join('\n'), /mindnprogress_checkpoint_ai_workspace.*동적 폰트·Atlas|동적 폰트·Atlas.*mindnprogress_checkpoint_ai_workspace/)
    assert.match(guide.guide.operationRules.join('\n'), /\[MnP\].*mapId.*cardId|mapId.*cardId.*\[MnP\]/)
    assert.match(guide.guide.operationRules.join('\n'), /파일 변경이 없는 조사·검증 작업.*mindnprogress_confirm_ai_workspace_no_changes/)
    assert.match(guide.guide.operationRules.join('\n'), /commitMessage.*summary.*background.*cause.*changes/)
    assert.match(guide.guide.operationRules.join('\n'), /기존 AI 대화를 이어갈지 새로 시작할지.*mindnprogress_list_ai_conversations/)
    assert.match(guide.guide.operationRules.join('\n'), /복수의 독립적인 완료 조건.*필요한 최소한의 결과 중심 체크리스트.*억지로 나누거나.*별도 하위 카드.*중복하지 않/)
    assert.match(toolDescription('mindnprogress_update_card'), /checklist.*완료 비율로 progress와 status를 자동 계산/)
    assert.match(toolSchema('mindnprogress_update_card')?.properties?.data?.properties?.checklist?.description ?? '', /전체 배열.*완료 비율로 progress와 status를 자동 계산/)
    assert.match(guide.guide.operationRules.join('\n'), /위임 기준.*AionUi 대화 ID.*MCP 재연결.*모든 깊이/)
    assert.match(guide.guide.operationRules.join('\n'), /자동 재개된 턴.*mindnprogress_delegate_ai_work.*미래형 약속/)
    assert.match(guide.guide.operationRules.join('\n'), /waiting-integration-clean.*하위 AI 전문이 아직 전달되지 않음.*자동 시작.*재위임하지 않음/)
    assert.match(guide.guide.operationRules.join('\n'), /recovery-required.*mindnprogress_recover_ai_delegation/)
    assert.match(guide.guide.operationRules.join('\n'), /mindnprogress_update_card.*responseMode.*full.*기본값.*AI 대화 상세 목록.*affected/)
    assert.match(guide.guide.operationRules.join('\n'), /댓글 summary는 \[진행\].*\[차단\].*\[결과\]/)
    assert.match(guide.guide.commentRules.detail, /작업을 이어가거나 결과를 검증/)
    assert.match(guide.guide.commentRules.legacy, /자동 분리하거나 다시 쓰지 않음/)
    assert.match(guide.guide.operationRules.join('\n'), /waitingItems가 해제되면 서버가 관련 사용자에게 알림/)
    assert.match(guide.guide.operationRules.join('\n'), /kind=image.*imageAccess\.localPath.*로컬 이미지 열람 도구/)

    const createdMindmap = await invoke('mindnprogress_create_mindmap', {
      title: 'MCP 전체 회귀 문서',
      color: 'blue',
      cards: [
        { key: 'root', label: '전체 회귀', kind: 'root', description: '루트 업무 https://example.com/root', taskUrl: 'https://example.com/root' },
        { key: 'branch-a', parentKey: 'root', label: '기능 A', kind: 'branch', sharedKnowledge: '기능 A의 재사용 가능한 결정과 결과' },
        { key: 'branch-b', parentKey: 'root', label: '기능 B', kind: 'branch', sharedKnowledge: '현재 선택과 무관한 장문 지식 '.repeat(300) },
        {
          key: 'task-a',
          parentKey: 'branch-a',
          label: '업무 A',
          kind: 'task',
          isWork: true,
          status: 'in-progress',
          progress: 30,
          taskUrl: 'https://example.com/task-a',
          waitingItems: [{ label: '서버 API 완료', note: '응답 형식 확정 필요', resumeCondition: '개발 서버 배포' }],
        },
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
    assert.equal(documents.maps.find((map) => map.id === mapId)?.waitingCount, 1)

    let documentResult = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(documentResult.map.nodes.length, 4)
    assert.equal(documentResult.map.nodes.find((node) => node.id === 'branch-a')?.data.sharedKnowledge, '기능 A의 재사용 가능한 결정과 결과')
    const createdWaitingItem = documentResult.map.nodes.find((node) => node.id === 'task-a')?.data.waitingItems?.[0]
    assert.equal(createdWaitingItem?.label, '서버 API 완료')
    assert.ok(createdWaitingItem?.id)
    assert.ok(createdWaitingItem?.since)
    assert.equal(documentResult.map.nodes.find((node) => node.id === 'root')?.data.progress, 30)
    assert.equal(documentResult.map.nodes.find((node) => node.id === 'root')?.data.status, 'in-progress')
    assert.equal(documentResult.access.documentUrl, `https://mindnprogress.test/mindmap/${mapId}`)
    assert.equal(documentResult.access.cards.find((card) => card.cardId === 'task-a')?.accessUrl, `https://mindnprogress.test/mindmap/${mapId}/task-a`)
    const knowledgeCandidates = await invoke('mindnprogress_list_shared_knowledge_candidates', { mapId, limit: 10 })
    assert.equal(knowledgeCandidates.maintenance.periodicIntervalDays, 7)
    assert.equal(knowledgeCandidates.maintenance.requiresExplicitApproval, true)
    assert.equal(knowledgeCandidates.page.total, 1)
    assert.equal(knowledgeCandidates.candidates[0].cardId, 'branch-b')
    assert.equal(knowledgeCandidates.candidates[0].documentVersion, documentResult.map.version)
    assert.equal(Object.hasOwn(knowledgeCandidates.candidates[0], 'sharedKnowledge'), false)
    const knowledgeReviewContext = await invoke('mindnprogress_get_shared_knowledge_review_context', {
      mapId,
      cardId: 'branch-b',
      commentLimit: 0,
    })
    assert.equal(knowledgeReviewContext.document.version, documentResult.map.version)
    assert.match(knowledgeReviewContext.card.sharedKnowledge, /현재 선택과 무관한 장문 지식/)
    assert.deepEqual(knowledgeReviewContext.comments, [])
    const acceptedKnowledgeReview = await invoke('mindnprogress_apply_shared_knowledge_review', {
      mapId,
      baseVersion: knowledgeReviewContext.document.version,
      patches: [{
        cardId: 'branch-b',
        expectedSha256: knowledgeReviewContext.card.textIntegrity.sha256,
        reviewResult: 'accepted-long',
      }],
    })
    assert.equal(acceptedKnowledgeReview.atomic, true)
    assert.equal(acceptedKnowledgeReview.changes[0].reviewState, 'current')
    assert.equal(acceptedKnowledgeReview.changes[0].review.reviewResult, 'accepted-long')
    documentResult = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(documentResult.map.version, acceptedKnowledgeReview.document.version)
    let loginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mcp-test-admin@mind.local', password: 'McpTest!2026' }),
    })
    assert.equal(loginResponse.status, 200)
    let sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(sessionCookie, '테스트 관리자 세션 쿠키가 없습니다.')
    const editorCreateResponse = await fetch(`${apiBaseUrl}/api/admin/editors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        name: 'MCP 테스트 편집자',
        email: 'mcp-test-editor@mind.local',
        password: 'McpEditor!2026',
      }),
    })
    assert.equal(editorCreateResponse.status, 201)
    const testEditor = (await editorCreateResponse.json()).editor
    assert.equal(testEditor.role, 'editor')
    const editorLoginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mcp-test-editor@mind.local', password: 'McpEditor!2026' }),
    })
    assert.equal(editorLoginResponse.status, 200)
    let editorSessionCookie = editorLoginResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(editorSessionCookie, '테스트 편집자 세션 쿠키가 없습니다.')
    const referencedCommentResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ nodeId: 'branch-b', text: '참조 노드 초기 댓글 통계 검증' }),
    })
    assert.equal(referencedCommentResponse.status, 201)
    const updatedReferenceSource = await invoke('mindnprogress_update_card', {
      mapId,
      nodeId: 'branch-b',
      responseMode: 'affected',
      data: {
        description: '원본에서 변경된 최신 업무 설명',
        progress: 65,
        status: 'in-progress',
      },
    })
    assert.equal(updatedReferenceSource.card.data.description, '원본에서 변경된 최신 업무 설명')
    assert.deepEqual(updatedReferenceSource.changedFields, ['description', 'progress', 'status'])
    const referencedRootResult = await invoke('mindnprogress_update_card', {
      mapId: secondaryMapId,
      nodeId: secondaryRootId,
      responseMode: 'affected',
      data: { reference: { mapId, nodeId: 'branch-b' } },
    })
    assert.deepEqual(
      referencedRootResult.card.data.reference,
      { mapId, nodeId: 'branch-b' },
    )
    await invokeExpectError('mindnprogress_patch_card_text', {
      mapId: secondaryMapId,
      cardId: secondaryRootId,
      field: 'description',
      expectedSha256: referencedRootResult.card.textIntegrity.description.sha256,
      operation: { type: 'append', text: '수정 시도' },
    }, /TEXT_PATCH_REFERENCE_CARD/)
    const referencedDocumentResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(secondaryMapId)}`, {
      headers: { Cookie: sessionCookie },
    })
    assert.equal(referencedDocumentResponse.status, 200)
    const referencedDocument = await referencedDocumentResponse.json()
    const resolvedReferenceNode = referencedDocument.map.nodes.find((node) => node.id === secondaryRootId)
    assert.equal(resolvedReferenceNode.data.label, '기능 B (ref)')
    assert.equal(resolvedReferenceNode.data.description, '원본에서 변경된 최신 업무 설명')
    assert.equal(resolvedReferenceNode.data.progress, 0)
    assert.equal(resolvedReferenceNode.data.status, 'in-progress')
    assert.match(resolvedReferenceNode.data.sharedKnowledge, /현재 선택과 무관한 장문 지식/)
    assert.deepEqual(
      referencedDocument.referenceCommentStats[secondaryRootId],
      { total: 1, unresolved: 1 },
      '참조 노드 댓글 통계가 문서 초기 응답에 포함되지 않았습니다.',
    )
    assert.deepEqual(referencedDocument.unresolvedReferenceNodeIds, [])
    const referencedDocumentSecondResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(secondaryMapId)}`, {
      headers: { Cookie: sessionCookie },
    })
    assert.equal(referencedDocumentSecondResponse.status, 200)
    const referencedDocumentSecond = await referencedDocumentSecondResponse.json()
    assert.equal(
      referencedDocumentSecond.map.version,
      referencedRootResult.document.version,
      'Ref 원본 내용을 투영하는 조회가 대상 문서 버전을 변경했습니다.',
    )
    documentResult = await invoke('mindnprogress_get_document', { mapId })
    const versionBeforeReadOnlyTools = documentResult.map.version
    const transientOnlyMap = structuredClone(documentResult.map)
    transientOnlyMap.nodes[0].selected = true
    transientOnlyMap.nodes[0].dragging = false
    transientOnlyMap.nodes[0].measured = { width: 218, height: 141 }
    transientOnlyMap.nodes[0].width = 218
    transientOnlyMap.nodes[0].height = 141
    const transientOnlySaveResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        map: { nodes: transientOnlyMap.nodes, edges: transientOnlyMap.edges },
        baseVersion: documentResult.map.version,
      }),
    })
    assert.equal(transientOnlySaveResponse.status, 200)
    const transientOnlySave = await transientOnlySaveResponse.json()
    assert.equal(transientOnlySave.map.version, documentResult.map.version, '화면 전용 노드 상태가 문서 버전을 변경했습니다.')
    assert.equal(transientOnlySave.map.nodes[0].selected, undefined)
    assert.equal(transientOnlySave.map.nodes[0].dragging, undefined)
    assert.equal(transientOnlySave.map.nodes[0].measured, undefined)
    assert.equal(transientOnlySave.map.nodes[0].width, undefined)
    assert.equal(transientOnlySave.map.nodes[0].height, undefined)
    const layoutResponse = await fetch(`${apiBaseUrl}/api/maps/layout`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        documentLayout: {
          version: 1,
          items: [
            { type: 'map', id: secondaryMapId },
            { type: 'group', id: 'group-mcp-regression' },
          ],
          groups: [{
            id: 'group-mcp-regression',
            name: 'JP-매니저',
            mapIds: [mapId],
          }],
        },
      }),
    })
    assert.equal(layoutResponse.status, 200)
    const groupedLibrary = await layoutResponse.json()
    assert.deepEqual(groupedLibrary.documentLayout.items, [
      { type: 'map', id: secondaryMapId },
      { type: 'group', id: 'group-mcp-regression' },
    ])
    assert.deepEqual(groupedLibrary.documentLayout.groups[0].mapIds, [mapId])
    assert.deepEqual(groupedLibrary.maps.map((map) => map.id), [secondaryMapId, mapId])
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
      headers: { 'Content-Type': 'application/json', Cookie: editorSessionCookie },
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
    assert.equal(attribution.editorId, testEditor.id)

    const mismatchedEditorCommentResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${integrationToken}`,
        'Content-Type': 'application/json',
        'X-MNP-AI-Map-Id': mapId,
        'X-MNP-AI-Card-Id': 'branch-b',
        'X-MNP-AI-Editor-Id': 'user-admin',
      },
      body: JSON.stringify({ nodeId: 'branch-b', text: '다른 편집자의 AI 귀속을 사용하지 않는지 검증' }),
    })
    assert.equal(mismatchedEditorCommentResponse.status, 201)
    const mismatchedEditorComment = await mismatchedEditorCommentResponse.json()
    assert.equal(mismatchedEditorComment.comment.author.id, 'user-admin')
    assert.notEqual(mismatchedEditorComment.comment.author.name, attribution.authorName)

    const context = await invoke('mindnprogress_get_context', {
      mapId,
      cardId: 'task-a',
      editorId: attribution.editorId,
      attributionToken: attribution.attributionToken,
    })
    assert.equal(context.contextSchemaVersion, '3.0')
    assert.equal(context.detailLevel, 'focused')
    assert.equal(context.document.nodes, undefined)
    assert.equal(context.document.outline.length, 4)
    assert.equal(context.document.outline.find((card) => card.id === 'task-a')?.parentId, 'branch-a')
    assert.equal(context.document.outline.find((card) => card.id === 'task-a')?.waitingItems[0].resumeCondition, '개발 서버 배포')
    assert.equal(context.selection.card.id, 'task-a')
    assert.equal(context.selection.card.data.waitingItems[0].note, '응답 형식 확정 필요')
    assert.equal(context.selection.card.position, undefined)
    assert.equal(context.selection.taskLinks.available.length, 2)
    assert.equal(context.selection.taskLinks.startupInspection.mode, 'default')
    assert.equal(context.selection.taskLinks.startupInspection.conversationInspection.mode, 'not-applicable')
    assert.deepEqual(context.selection.taskLinks.startupInspection.conversationInspection.sources, [])
    assert.equal(context.selection.knowledgeSources.all, undefined)
    assert.equal(context.selection.aiWorkCoordination.tool, 'mindnprogress_get_ai_work_states')
    assert.equal(context.selection.aiWorkCoordination.delegationOrigin.cardId, 'task-a')
    assert.equal(context.selection.aiWorkCoordination.delegationOrigin.conversationId, 'conversation-test')
    assert.equal(context.selection.aiWorkCoordination.childDelegation.delegateTool, 'mindnprogress_delegate_ai_work')
    assert.match(context.selection.aiWorkCoordination.childDelegation.waitStateInstruction, /waiting-integration-clean.*전문이 아직 전달되지 않은 상태.*재위임하지 마세요/)
    assert.deepEqual(context.selection.aiWorkCoordination.siblingCardIds, [])
    assert.equal(context.selection.aiWorkCoordination.toolArguments, null)
    assert.equal(context.selection.accessUrl, `https://mindnprogress.test/mindmap/${mapId}/task-a`)
    assert.equal(context.selection.commentsPage.total, 1)
    assert.equal(context.selection.commentsPage.hasMore, false)
    assert.match(context.nextStep, /guide\.knowledgeLinePolicy.*작업 종료 전에 연결 또는 제안 여부/)
    assert.ok(context.teamMembers.every((member) => member.lastLoginAt === undefined))

    await invokeExpectError('mindnprogress_checkpoint_ai_workspace', {
      mapId,
      leaseId: 'lease-not-found',
      jobId: 'job-not-found',
      paths: ['Assets/Test.cs'],
      commitMessage: {
        summary: '테스트 변경 체크포인트 생성',
        background: '구조화된 커밋 메시지 전달 경로를 검증해야 합니다.',
        cause: '기존 고정 템플릿은 실제 변경 내용을 설명하지 못했습니다.',
        changes: '체크포인트 도구에 실제 변경 설명을 함께 전달합니다.',
        scope: 'MCP 회귀 테스트에만 해당합니다.',
      },
    }, /활성 AI 작업공간 lease를 찾지 못했습니다/)

    await invokeExpectError('mindnprogress_confirm_ai_workspace_no_changes', {
      mapId,
      leaseId: 'lease-not-found',
      jobId: 'job-not-found',
    }, /활성 AI 작업공간 lease를 찾지 못했습니다/)

    const legacyMcpEnvironment = { ...environment }
    delete legacyMcpEnvironment.AIONUI_CONVERSATION_ID
    const legacyCheckpointTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: legacyMcpEnvironment,
      stderr: 'pipe',
    })
    const legacyCheckpointClient = new Client({ name: 'mindnprogress-checkpoint-legacy-scope', version: '1.0.0' })
    await legacyCheckpointClient.connect(legacyCheckpointTransport)
    try {
      parseToolResult('mindnprogress_get_context', await legacyCheckpointClient.callTool({
        name: 'mindnprogress_get_context',
        arguments: {
          mapId,
          cardId: 'task-a',
          editorId: attribution.editorId,
          attributionToken: attribution.attributionToken,
        },
      }))
      const legacyCheckpointResult = await legacyCheckpointClient.callTool({
        name: 'mindnprogress_confirm_ai_workspace_no_changes',
        arguments: {
          mapId,
          leaseId: 'lease-not-found',
          jobId: 'job-not-found',
        },
      })
      assert.equal(legacyCheckpointResult.isError, true)
      assert.match(
        legacyCheckpointResult.content?.find((item) => item.type === 'text')?.text ?? '',
        /활성 AI 작업공간 lease를 찾지 못했습니다/,
      )
    } finally {
      await legacyCheckpointClient.close()
    }

    const fullContext = await invoke('mindnprogress_get_context', {
      mapId,
      cardId: 'task-a',
      editorId: attribution.editorId,
      attributionToken: attribution.attributionToken,
      detailLevel: 'full',
    })
    assert.equal(fullContext.detailLevel, 'full')
    assert.equal(fullContext.document.nodes.length, 4)
    assert.equal(fullContext.document.outline, undefined)
    assert.equal(fullContext.selection.knowledgeSources.all.length, 0)
    assert.ok(JSON.stringify(context).length < JSON.stringify(fullContext).length)
    assert.ok(JSON.stringify(context).length < 25_000, 'focused 컨텍스트가 크기 회귀 기준을 초과했습니다.')
    documentResult = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(documentResult.map.version, versionBeforeReadOnlyTools, '조회 도구가 문서 버전을 변경했습니다.')

    const knowledgeLineAdded = await invoke('mindnprogress_add_knowledge_line', {
      mapId,
      sourceCardId: 'branch-a',
      targetCardId: 'task-a',
      knowledgePolicy: 'reuse-first',
    })
    assert.equal(knowledgeLineAdded.knowledgeLine.knowledgePolicy, 'reuse-first')
    assert.equal(knowledgeLineAdded.knowledgeLine.sourceCardId, 'branch-a')
    assert.equal(knowledgeLineAdded.knowledgeLine.targetCardId, 'task-a')
    assert.equal(knowledgeLineAdded.version, documentResult.map.version + 1, '지식선 추가가 문서 버전을 한 번 증가시키지 않았습니다.')
    await invokeExpectError('mindnprogress_add_knowledge_line', {
      mapId,
      sourceCardId: 'branch-a',
      targetCardId: 'task-a',
      knowledgePolicy: 'reuse-first',
    }, /이미 연결된 지식선/)
    const knowledgeLineUpdated = await invoke('mindnprogress_update_knowledge_line', {
      mapId,
      sourceCardId: 'branch-a',
      targetCardId: 'task-a',
      knowledgePolicy: 'inspect-if-insufficient',
    })
    assert.equal(knowledgeLineUpdated.knowledgeLine.knowledgePolicy, 'inspect-if-insufficient')
    assert.equal(knowledgeLineUpdated.version, knowledgeLineAdded.version + 1, '지식선 정책 변경이 문서 버전을 한 번 증가시키지 않았습니다.')
    await invokeExpectError('mindnprogress_add_knowledge_line', {
      mapId,
      sourceCardId: 'task-a',
      targetCardId: 'branch-a',
      knowledgePolicy: 'reuse-first',
    }, /순환 지식선/)
    const knowledgeLineDeleted = await invoke('mindnprogress_delete_knowledge_line', {
      mapId,
      sourceCardId: 'branch-a',
      targetCardId: 'task-a',
    })
    assert.equal(knowledgeLineDeleted.deletedKnowledgeLineIds.length, 1)
    assert.equal(knowledgeLineDeleted.version, knowledgeLineUpdated.version + 1, '지식선 삭제가 문서 버전을 한 번 증가시키지 않았습니다.')
    documentResult = await invoke('mindnprogress_get_document', { mapId })
    assert.ok(!documentResult.map.edges.some((edge) => edge.data?.relation === 'knowledge'
      && edge.source === 'branch-a' && edge.target === 'task-a'))
    const versionBeforeConversationLink = documentResult.map.version

    const completionResponse = await fetch(attribution.completionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conversation-test' }),
    })
    assert.equal(completionResponse.status, 200)
    await access(path.join(testDataDirectory, '_ai-conversation-attributions.json'))
    await access(path.join(testDataDirectory, '_ai-conversation-origins.json'))
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
    const repairedAuthorNotificationsResponse = await fetch(`${apiBaseUrl}/api/notifications`, {
      headers: { Cookie: editorSessionCookie },
    })
    assert.equal(repairedAuthorNotificationsResponse.status, 200)
    const repairedAuthorNotifications = await repairedAuthorNotificationsResponse.json()
    assert.ok(
      !repairedAuthorNotifications.notifications.some((notification) => notification.commentId === unspecifiedComment.comment.id),
      '댓글 작성자 귀속을 복구한 뒤 작성자 본인의 알림이 남았습니다.',
    )
    documentResult = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(documentResult.map.version, versionBeforeConversationLink + 1, 'AI 대화 ID 연결은 문서 버전을 한 번 증가시켜야 합니다.')
    assert.equal(documentResult.map.nodes.find((node) => node.id === 'task-a')?.data.aiConversationId, 'conversation-test')
    const linkedConversations = documentResult.map.nodes.find((node) => node.id === 'task-a')?.data.aiConversations
    assert.equal(linkedConversations.length, 1)
    assert.equal(linkedConversations[0].conversationId, 'conversation-test')
    assert.equal(linkedConversations[0].agent.label, 'Claude Code')
    assert.equal(linkedConversations[0].model.label, 'Claude Test Model')
    assert.equal(linkedConversations[0].startedBy.label, 'MCP 테스트 편집자')
    const conversationListResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/cards/task-a/ai-conversations`, {
      headers: { Cookie: editorSessionCookie },
    })
    assert.equal(conversationListResponse.status, 200)
    const conversationList = await conversationListResponse.json()
    assert.equal(conversationList.latestConversationId, 'conversation-test')
    assert.equal(conversationList.conversations.length, 1)
    assert.equal(conversationList.conversations[0].runtime.state, 'running')
    assert.equal(conversationList.conversations[0].available, true)
    const conversationCandidates = await invoke('mindnprogress_list_ai_conversations', { mapId, cardId: 'task-a' })
    assert.equal(conversationCandidates.latestConversationId, 'conversation-test')
    assert.equal(conversationCandidates.conversations.length, 1)
    assert.equal(conversationCandidates.conversations[0].agent.label, 'Claude Code')
    assert.equal(conversationCandidates.conversations[0].model.label, 'Claude Test Model')
    assert.equal(conversationCandidates.conversations[0].runtime.state, 'running')
    assert.match(conversationCandidates.selectionRule.exclude, /running.*waiting-confirmation/)
    const emptyDelegations = await invoke('mindnprogress_list_ai_delegations', { mapId, parentCardId: 'task-a' })
    assert.deepEqual(emptyDelegations.delegations, [])
    await invokeExpectError('mindnprogress_delegate_ai_work', {
      mapId,
      targetCardId: 'branch-a',
      strategy: 'new',
      instruction: '하위 카드 작업을 실제로 수행하세요.',
      decisionReason: '회귀 테스트에서 상위-하위 범위 검증',
      sourceRevision: documentResult.map.version,
      idempotencyKey: 'mcp-regression-invalid-parent',
    }, /하위 카드에만 AI 작업을 위임/)
    const versionBeforeAiWorkStateRead = documentResult.map.version
    const aiWorkStates = await invoke('mindnprogress_get_ai_work_states', {
      mapId,
      cardIds: ['task-a', 'branch-a'],
    })
    assert.equal(aiWorkStates.mapVersion, versionBeforeAiWorkStateRead)
    assert.deepEqual(aiWorkStates.activeCardIds, ['task-a'])
    assert.equal(aiWorkStates.cards.find((card) => card.cardId === 'task-a')?.state, 'running')
    assert.equal(aiWorkStates.cards.find((card) => card.cardId === 'task-a')?.isActive, true)
    assert.equal(aiWorkStates.cards.find((card) => card.cardId === 'task-a')?.conversationCount, 1)
    assert.deepEqual(aiWorkStates.cards.find((card) => card.cardId === 'task-a')?.activeConversationIds, ['conversation-test'])
    assert.equal(aiWorkStates.cards.find((card) => card.cardId === 'task-a')?.turnId, 'turn-mcp-runtime-test')
    assert.equal(aiWorkStates.cards.find((card) => card.cardId === 'branch-a')?.state, 'unlinked')
    assert.equal(aiWorkStates.cards.find((card) => card.cardId === 'branch-a')?.isActive, false)
    assert.match(aiWorkStates.coordinationRule, /동시에 수정하지 마세요/)
    const workspacePool = await invoke('mindnprogress_get_ai_workspace_pool')
    assert.equal(typeof workspacePool.available, 'boolean')
    assert.ok(Array.isArray(workspacePool.workspaces))
    assert.match(workspacePool.coordinationRule, /직접 선택·점유·전환·해제하지 않습니다/)
    assert.equal(JSON.stringify(workspacePool).includes('leaseId'), false)
    assert.equal(JSON.stringify(workspacePool).includes('jobId'), false)
    const afterAiWorkStateRead = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(afterAiWorkStateRead.map.version, versionBeforeAiWorkStateRead, 'AI 작업 상태 조회가 문서 버전을 변경했습니다.')
    await invokeExpectError('mindnprogress_get_ai_work_states', {
      mapId,
      cardIds: ['missing-card'],
    }, /카드를 찾을 수 없습니다/)
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

    const delegatedChildCreated = await invoke('mindnprogress_add_card', {
      mapId,
      parentId: 'task-a',
      data: { label: '위임 하위 카드', kind: 'task', isWork: false, status: 'planned', progress: 0 },
    })
    const delegatedChild = delegatedChildCreated.card
    assert.ok(delegatedChild)
    assert.equal(delegatedChild.data?.label, '위임 하위 카드')
    const inspectedCardAttributionResponse = await fetch(`${apiBaseUrl}/api/integrations/aionui/attributions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: editorSessionCookie },
      body: JSON.stringify({
        agentId: 'agent-claude-test',
        modelId: 'claude-test-model',
        mapId,
        cardId: delegatedChild.id,
      }),
    })
    assert.equal(inspectedCardAttributionResponse.status, 201)
    const inspectedCardAttribution = await inspectedCardAttributionResponse.json()
    const inspectedCardCompletionResponse = await fetch(inspectedCardAttribution.completionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conversation-inspected-card' }),
    })
    assert.equal(inspectedCardCompletionResponse.status, 200)
    const delegationSourceDocument = await invoke('mindnprogress_get_document', { mapId })
    const delegationArguments = {
      mapId,
      targetCardId: delegatedChild.id,
      strategy: 'new',
      instruction: '하위 카드의 요구사항을 확인하고 구현과 검증을 완료한 뒤 결과를 기록하세요.',
      decisionReason: '기존 대화가 없어 상위 대화와 같은 실행 환경으로 새 대화를 시작합니다.',
      sourceRevision: delegationSourceDocument.map.version,
      idempotencyKey: `mcp-regression:${delegatedChild.id}:${delegationSourceDocument.map.version}`,
    }
    const [inspectedChildContext, inspectedUnrelatedContext] = await Promise.all([
      invoke('mindnprogress_get_context', {
        mapId,
        cardId: delegatedChild.id,
        editorId: attribution.editorId,
        attributionToken: attribution.attributionToken,
      }),
      invoke('mindnprogress_get_context', {
        mapId,
        cardId: 'branch-b',
        editorId: attribution.editorId,
        attributionToken: attribution.attributionToken,
      }),
    ])
    assert.equal(inspectedChildContext.selection.card.id, delegatedChild.id)
    assert.equal(inspectedUnrelatedContext.selection.card.id, 'branch-b')
    const originReconnectTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: environment,
      stderr: 'pipe',
    })
    const originReconnectClient = new Client({ name: 'mindnprogress-delegation-origin-reconnect', version: '1.0.0' })
    await originReconnectClient.connect(originReconnectTransport)
    let delegated
    try {
      delegated = parseToolResult('mindnprogress_delegate_ai_work', await originReconnectClient.callTool({
        name: 'mindnprogress_delegate_ai_work',
        arguments: delegationArguments,
      }))
    } finally {
      await originReconnectClient.close()
    }
    assert.equal(delegated.delegation.targetConversationId, 'conversation-delegated')
    assert.equal(delegated.delegation.parentConversationId, 'conversation-test')
    assert.equal(delegated.delegation.parentCardId, 'task-a', '다른 카드 get_context 조회가 위임 기준 카드를 변경했습니다.')
    assert.equal(delegated.delegation.strategy, 'new')
    assert.equal(delegated.mapVersion, delegationArguments.sourceRevision + 1)
    const delegatedRepeat = await invoke('mindnprogress_delegate_ai_work', delegationArguments)
    assert.equal(delegatedRepeat.repeated, true)
    assert.equal(mockAionUi.dispatchRequests.length, 1, '멱등 재호출이 하위 대화를 중복 실행했습니다.')
    assert.deepEqual(mockAionUi.conversationTitleUpdates, [{
      name: 'MCP 전체 회귀 문서: 위임 하위 카드',
      name_source: 'user',
    }], '위임으로 만든 새 대화 제목을 Claude 자동 제목으로부터 보호하지 못했습니다.')
    const delegatedDocument = await invoke('mindnprogress_get_document', { mapId })
    documentResult = delegatedDocument
    assert.equal(
      delegatedDocument.map.nodes.find((node) => node.id === delegatedChild.id)?.data.aiConversationId,
      'conversation-delegated',
    )
    assert.match(mockAionUi.dispatchRequests[0].instruction, /MindNProgress 하위 카드 위임 작업 요청/)
    assert.match(mockAionUi.dispatchRequests[0].instruction, /실제로 수행/)
    assert.match(mockAionUi.dispatchRequests[0].instruction, /한 번 성공적으로 호출/)
    assert.match(mockAionUi.dispatchRequests[0].instruction, /응답을 받지 못한 시도는 호출 횟수에 포함하지 말고/)
    assert.match(mockAionUi.dispatchRequests[0].instruction, /mindnprogress_complete_ai_delegation/)
    assert.equal(mockAionUi.dispatchRequests[0].explicitCompletionAfterInterruption, true)

    const childCompletionTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: { ...environment, AIONUI_CONVERSATION_ID: 'conversation-delegated' },
      stderr: 'pipe',
    })
    const childCompletionClient = new Client({ name: 'mindnprogress-explicit-completion', version: '1.0.0' })
    await childCompletionClient.connect(childCompletionTransport)
    const unnecessaryCompletion = parseToolResult('mindnprogress_complete_ai_delegation',
      await childCompletionClient.callTool({
        name: 'mindnprogress_complete_ai_delegation',
        arguments: { mapId },
      }))
    assert.equal(unnecessaryCompletion.accepted, false)
    assert.equal(unnecessaryCompletion.required, false)
    assert.equal(unnecessaryCompletion.state, 'running')
    assert.match(unnecessaryCompletion.instruction, /자동으로 완료를 확정하고 상위 AI에 보고/)

    mockAionUi.setDispatchState(delegationArguments.idempotencyKey, 'waiting_resume')
    let interruptedDelegation = null
    const resumeWaitStartedAt = Date.now()
    while (Date.now() - resumeWaitStartedAt < 6_000) {
      const delegationList = await invoke('mindnprogress_list_ai_delegations', {
        mapId,
        parentCardId: 'task-a',
        targetCardId: delegatedChild.id,
      })
      interruptedDelegation = delegationList.delegations[0] ?? null
      if (interruptedDelegation?.state === 'waiting-child-resume') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(interruptedDelegation?.state, 'waiting-child-resume')
    assert.equal(interruptedDelegation?.childStatus, 'interrupted')
    assert.equal(mockAionUi.dispatchRequests.length, 1, '중지된 하위 턴을 완료로 오인해 상위 대화를 재개했습니다.')

    try {
      const explicitCompletion = parseToolResult('mindnprogress_complete_ai_delegation',
        await childCompletionClient.callTool({
          name: 'mindnprogress_complete_ai_delegation',
          arguments: { mapId },
        }))
      calledTools.set('mindnprogress_complete_ai_delegation', 1)
      assert.equal(explicitCompletion.accepted, true)
      assert.equal(explicitCompletion.required, true)
      assert.equal(explicitCompletion.turnId, 'turn-explicit-completion')
      assert.equal(explicitCompletion.delegation.id, delegationArguments.idempotencyKey)
    } finally {
      await childCompletionClient.close()
    }

    mockAionUi.setDispatchState(delegationArguments.idempotencyKey, 'waiting_resource', {
      kind: 'unity_project',
      key: 'unity:test-project',
      projectRoot: 'C:/Git/Test/UnityProject',
    })
    let waitingDelegation = null
    const resourceWaitStartedAt = Date.now()
    while (Date.now() - resourceWaitStartedAt < 6_000) {
      const delegationList = await invoke('mindnprogress_list_ai_delegations', {
        mapId,
        parentCardId: 'task-a',
        targetCardId: delegatedChild.id,
      })
      waitingDelegation = delegationList.delegations[0] ?? null
      if (waitingDelegation?.state === 'waiting-resource') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(waitingDelegation?.state, 'waiting-resource')
    assert.equal(waitingDelegation?.resource?.key, 'unity:test-project')
    assert.equal(mockAionUi.dispatchRequests.length, 1, 'Unity 자원 대기를 완료로 오인해 상위 대화를 재개했습니다.')

    mockAionUi.setDispatchState(delegationArguments.idempotencyKey, 'recovery_required')
    let recoveryRequiredDelegation = null
    const recoveryRequiredStartedAt = Date.now()
    while (Date.now() - recoveryRequiredStartedAt < 6_000) {
      const delegationList = await invoke('mindnprogress_list_ai_delegations', {
        mapId,
        parentCardId: 'task-a',
        targetCardId: delegatedChild.id,
      })
      recoveryRequiredDelegation = delegationList.delegations[0] ?? null
      if (recoveryRequiredDelegation?.state === 'recovery-required') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(recoveryRequiredDelegation?.state, 'recovery-required')
    assert.equal(recoveryRequiredDelegation?.childStatus, 'interrupted-by-restart')
    assert.equal(recoveryRequiredDelegation?.workspaceResult, undefined, '복구 필요 상태에서 작업공간을 완료 처리했습니다.')

    const recoverySourceDocument = await invoke('mindnprogress_get_document', { mapId })
    const recoveredRun = await invoke('mindnprogress_recover_ai_delegation', {
      mapId,
      delegationId: delegationArguments.idempotencyKey,
      instruction: '현재 카드와 Git 변경을 확인하고 아직 끝나지 않은 구현과 검증만 이어서 완료하세요.',
      sourceRevision: recoverySourceDocument.map.version,
    })
    assert.equal(recoveredRun.delegation.state, 'starting')
    assert.equal(recoveredRun.recovery.reusedConversation, true)
    assert.equal(mockAionUi.dispatchRequests.length, 2)
    assert.equal(mockAionUi.dispatchRequests[1].targetConversationId, 'conversation-delegated')
    assert.match(mockAionUi.dispatchRequests[1].instruction, /원래 지시를 처음부터 반복하지 말고/)
    const recoveryOperationId = recoveredRun.recovery.operationId
    mockAionUi.setDispatchState(recoveryOperationId, 'waiting_resource', {
      kind: 'unity_project',
      key: 'unity:test-project',
      projectRoot: 'C:/Git/Test/UnityProject',
    })
    const recoveredResourceWaitStartedAt = Date.now()
    while (Date.now() - recoveredResourceWaitStartedAt < 6_000) {
      const delegationList = await invoke('mindnprogress_list_ai_delegations', {
        mapId,
        parentCardId: 'task-a',
        targetCardId: delegatedChild.id,
      })
      waitingDelegation = delegationList.delegations[0] ?? null
      if (waitingDelegation?.state === 'waiting-resource') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(waitingDelegation?.state, 'waiting-resource')
    assert.equal(waitingDelegation?.childOperationId, recoveryOperationId)

    apiServer.kill()
    await new Promise((resolve) => apiServer.once('exit', resolve))
    apiServer = startApiServer()
    await waitForServer(apiBaseUrl, apiServer, serverLogs)
    const restartedEditorLoginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mcp-test-editor@mind.local', password: 'McpEditor!2026' }),
    })
    assert.equal(restartedEditorLoginResponse.status, 200)
    editorSessionCookie = restartedEditorLoginResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(editorSessionCookie, '재시작 후 테스트 편집자 세션 쿠키가 없습니다.')
    const restoredDelegationList = await invoke('mindnprogress_list_ai_delegations', {
      mapId,
      parentCardId: 'task-a',
      targetCardId: delegatedChild.id,
    })
    assert.equal(restoredDelegationList.delegations[0]?.id, delegationArguments.idempotencyKey)
    assert.equal(restoredDelegationList.delegations[0]?.state, 'waiting-resource')

    apiServer.kill()
    await new Promise((resolve) => apiServer.once('exit', resolve))
    await writeFile(path.join(testDataDirectory, '_ai-delegations.json'), '[]\n', 'utf8')
    mockAionUi.completeDispatch(recoveryOperationId)
    mockAionUi.completeDispatch(delegationArguments.idempotencyKey)
    apiServer = startApiServer()
    await waitForServer(apiBaseUrl, apiServer, serverLogs)
    const recoveryEditorLoginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mcp-test-editor@mind.local', password: 'McpEditor!2026' }),
    })
    assert.equal(recoveryEditorLoginResponse.status, 200)
    editorSessionCookie = recoveryEditorLoginResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(editorSessionCookie, '위임 복구 후 테스트 편집자 세션 쿠키가 없습니다.')
    const recoveredDelegation = await invoke('mindnprogress_delegate_ai_work', delegationArguments)
    assert.equal(recoveredDelegation.recovered, true)
    assert.equal(recoveredDelegation.repeated, true)
    assert.equal(recoveredDelegation.delegation.state, 'waiting-parent')

    mockAionUi.setConversationRuntimeState('idle')
    let completedDelegation = null
    const delegationWaitStartedAt = Date.now()
    while (Date.now() - delegationWaitStartedAt < 12_000) {
      const delegationList = await invoke('mindnprogress_list_ai_delegations', {
        mapId,
        parentCardId: 'task-a',
        targetCardId: delegatedChild.id,
      })
      completedDelegation = delegationList.delegations[0] ?? null
      if (completedDelegation?.state === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.equal(completedDelegation?.state, 'completed')
    assert.equal(completedDelegation?.childStatus, 'completed')
    assert.equal(completedDelegation?.parentDispatchState, 'completed')
    assert.equal(mockAionUi.dispatchRequests.length, 3)
    assert.equal(mockAionUi.dispatchRequests[2].targetConversationId, 'conversation-test')
    assert.match(mockAionUi.dispatchRequests[2].instruction, /하위 카드 작업을 완료하고 결과를 기록했습니다/)

    const unlinkedAttributionResponse = await fetch(`${apiBaseUrl}/api/integrations/aionui/attributions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: editorSessionCookie },
      body: JSON.stringify({
        agentId: 'agent-claude-test',
        modelId: 'claude-test-model',
        mapId: secondaryMapId,
        cardId: secondaryRootId,
      }),
    })
    assert.equal(unlinkedAttributionResponse.status, 201)

    apiServer.kill()
    await new Promise((resolve) => apiServer.once('exit', resolve))
    apiServer = startApiServer()
    await waitForServer(apiBaseUrl, apiServer, serverLogs)
    loginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mcp-test-admin@mind.local', password: 'McpTest!2026' }),
    })
    assert.equal(loginResponse.status, 200)
    sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(sessionCookie, '재시작 후 테스트 관리자 세션 쿠키가 없습니다.')

    const persistedTokenComment = await invoke('mindnprogress_add_comment', {
      mapId,
      nodeId: 'task-a',
      summary: '[진행] API 서버 재시작 후 기존 MCP 토큰 귀속을 검증합니다.',
    })
    assert.equal(persistedTokenComment.comment.author.name, 'Claude Code(Claude Test Model)')

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
      const unlinkedCardComment = parseToolResult('mindnprogress_add_comment', await freshClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId: secondaryMapId, nodeId: secondaryRootId, summary: '[진행] 연결 완료 전 카드 귀속의 요청 한정 적용을 검증합니다.' },
      }))
      assert.equal(unlinkedCardComment.comment.author.name, 'Claude Code(Claude Test Model)')

      parseToolResult('mindnprogress_update_card', await freshClient.callTool({
        name: 'mindnprogress_update_card',
        arguments: { mapId, nodeId: 'task-a', data: { label: '업무 A' } },
      }))

      const mapScopedComment = parseToolResult('mindnprogress_add_comment', await freshClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, nodeId: 'branch-b', summary: '[진행] 대화가 시작된 카드 밖 편집의 conversationId 귀속을 검증합니다.' },
      }))
      assert.equal(mapScopedComment.comment.author.name, 'Claude Code(Claude Test Model)')

      const [reconnectedResult, continuedResult] = await Promise.all([
        freshClient.callTool({
          name: 'mindnprogress_add_comment',
          arguments: { mapId, nodeId: 'task-a', summary: '[진행] MCP 재연결 후 연결 대화 모델 귀속을 검증합니다.' },
        }),
        freshClient.callTool({
          name: 'mindnprogress_add_comment',
          arguments: { mapId, nodeId: 'branch-b', summary: '[진행] 첫 댓글에서 복구한 AI 귀속의 병렬 카드 연속 적용을 검증합니다.' },
        }),
      ])
      const reconnectedComment = parseToolResult('mindnprogress_add_comment', reconnectedResult)
      assert.equal(reconnectedComment.comment.author.name, 'Claude Code(Claude Test Model)')

      const continuedComment = parseToolResult('mindnprogress_add_comment', continuedResult)
      assert.equal(continuedComment.comment.author.name, 'Claude Code(Claude Test Model)')

      parseToolResult('mindnprogress_get_context', await freshClient.callTool({
        name: 'mindnprogress_get_context',
        arguments: {
          mapId,
          cardId: 'task-a',
          editorId: attribution.editorId,
          aiType: 'Codex CLI',
          aiModel: 'GPT-5.6-Sol',
        },
      }))
      const selfDeclaredComment = parseToolResult('mindnprogress_add_comment', await freshClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, nodeId: 'task-a', summary: '[진행] 외부 MCP 세션의 명시적 AI 종류와 모델 귀속을 검증합니다.' },
      }))
      assert.equal(selfDeclaredComment.comment.author.id, attribution.editorId)
      assert.equal(selfDeclaredComment.comment.author.name, 'Codex CLI(GPT-5.6-Sol)')

      parseToolResult('mindnprogress_get_context', await freshClient.callTool({
        name: 'mindnprogress_get_context',
        arguments: { mapId, cardId: 'task-a', editorId: attribution.editorId },
      }))
      const contextContinuedComment = parseToolResult('mindnprogress_add_comment', await freshClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, nodeId: 'branch-b', summary: '[진행] 컨텍스트에서 복구한 AI 귀속의 다른 카드 연속 적용을 검증합니다.' },
      }))
      assert.equal(contextContinuedComment.comment.author.name, 'Claude Code(Claude Test Model)')
      const clearedIdentityComment = parseToolResult('mindnprogress_add_comment', await freshClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, nodeId: 'task-a', summary: '[진행] 자기 식별 해제 후 연결 대화 귀속 복원을 검증합니다.' },
      }))
      assert.equal(clearedIdentityComment.comment.author.name, 'Claude Code(Claude Test Model)')
    } finally {
      await freshClient.close()
    }

    // MindNProgress 밖에서 시작해 카드에 연결되지 않은 AionUi 대화도 현재 대화의
    // 실제 모델을 조회해 임시로 귀속하되, 카드의 대화 목록과 문서 버전은 바꾸지 않는다.
    const documentBeforeGeneralConversation = await invoke('mindnprogress_get_document', { mapId })
    const generalConversationTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: { ...environment, AIONUI_CONVERSATION_ID: 'conversation-unlinked-known' },
      stderr: 'pipe',
    })
    const generalConversationClient = new Client({ name: 'mindnprogress-attribution-general-conversation', version: '1.0.0' })
    await generalConversationClient.connect(generalConversationTransport)
    try {
      const generalContext = parseToolResult('mindnprogress_get_context', await generalConversationClient.callTool({
        name: 'mindnprogress_get_context',
        arguments: { mapId, cardId: 'branch-b' },
      }))
      assert.deepEqual(generalContext.aiAttribution, {
        status: 'resolved',
        source: 'aionui-conversation',
        authorName: 'Claude Code(Claude General Model)',
        conversationId: 'conversation-unlinked-known',
      })
      const generalConversationComment = parseToolResult('mindnprogress_add_comment', await generalConversationClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, cardId: 'task-a', summary: '[진행] 일반 AionUi 대화의 실제 모델 귀속을 검증합니다.' },
      }))
      assert.equal(generalConversationComment.comment.author.name, 'Claude Code(Claude General Model)')
    } finally {
      await generalConversationClient.close()
    }
    const documentAfterGeneralConversation = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(documentAfterGeneralConversation.map.version, documentBeforeGeneralConversation.map.version)
    assert.equal(documentAfterGeneralConversation.map.nodes.some((node) =>
      node.data?.aiConversationId === 'conversation-unlinked-known'
      || node.data?.aiConversations?.some((conversation) => conversation.conversationId === 'conversation-unlinked-known')), false)

    // AionUi에서 대화 정보를 찾지 못하면 조회는 허용하지만 모델 미지정 댓글이
    // 저장되지 않도록 편집 도구를 명시적으로 차단한다.
    const unknownConversationTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: { ...environment, AIONUI_CONVERSATION_ID: 'conversation-not-linked' },
      stderr: 'pipe',
    })
    const unknownConversationClient = new Client({ name: 'mindnprogress-attribution-unknown-conversation', version: '1.0.0' })
    await unknownConversationClient.connect(unknownConversationTransport)
    try {
      const unknownConversationContext = parseToolResult('mindnprogress_get_context', await unknownConversationClient.callTool({
        name: 'mindnprogress_get_context',
        arguments: { mapId, cardId: 'branch-b' },
      }))
      assert.equal(unknownConversationContext.aiAttribution.status, 'unresolved')
      assert.equal(unknownConversationContext.aiAttribution.code, 'AI_ATTRIBUTION_UNRESOLVED')
      const unknownConversationComment = await unknownConversationClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, cardId: 'branch-b', summary: '[진행] 확인되지 않은 AionUi 대화의 쓰기 차단을 검증합니다.' },
      })
      const unknownConversationError = unknownConversationComment.content?.find((item) => item.type === 'text')?.text ?? ''
      assert.equal(unknownConversationComment.isError, true)
      assert.match(unknownConversationError, /AionUi에서 현재 대화의 AI 종류와 모델을 확인하지 못했습니다/)
    } finally {
      await unknownConversationClient.close()
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
    assert.equal(restartedOptions.defaultWorkspace, projectDirectory)
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
    assert.ok(saved.map.edges.every((edge) => edge.type === 'default'))

    const knowledgeComment = await invoke('mindnprogress_add_comment', {
      mapId,
      nodeId: 'branch-a',
      summary: '[결과] 선행 분석 결과를 재사용할 수 있습니다.',
      detail: '검증된 결정과 적용 범위를 공유 지식과 함께 확인했습니다.',
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
    assert.ok(knowledgeSaved.map.edges.every((edge) => edge.type === 'default'))

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
    assert.equal(knowledgeContext.selection.knowledgeSources.primary[0].comments[0].detail, undefined)
    assert.equal(knowledgeContext.selection.knowledgeSources.primary[0].comments[0].hasDetail, true)
    assert.equal(knowledgeContext.selection.knowledgeSources.primary[0].commentsPage.total, 1)
    assert.deepEqual(knowledgeContext.selection.knowledgeSources.primary[0].commentsPage.detailToolArguments, {
      mapId,
      cardId: 'branch-a',
      offset: 0,
      limit: 1,
      order: 'desc',
      includeDetail: true,
    })
    assert.equal(knowledgeContext.selection.knowledgeSources.fallback[0].card.data, undefined)
    assert.deepEqual(knowledgeContext.selection.knowledgeSources.fallback[0].detailToolArguments, {
      mapId,
      cardId: 'root',
      includeCommentDetail: true,
    })
    assert.equal(knowledgeContext.selection.knowledgeSources.all, undefined)
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

    const sourceImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const imageUploadResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Cookie: sessionCookie },
      body: sourceImage,
    })
    assert.equal(imageUploadResponse.status, 201)
    const uploadedImage = (await imageUploadResponse.json()).image
    const imageCardId = 'image-primary-knowledge'
    const imageNode = {
      id: imageCardId,
      type: 'mind',
      position: { x: 700, y: 500 },
      data: {
        label: 'image.png',
        description: '화면 기획 원본',
        progress: 0,
        status: 'planned',
        kind: 'image',
        image: {
          assetId: uploadedImage.assetId,
          fileName: 'image.png',
          mimeType: uploadedImage.mimeType,
          naturalWidth: 1920,
          naturalHeight: 1080,
          displayWidth: 640,
          displayHeight: 360,
        },
      },
    }
    await invoke('mindnprogress_save_document', {
      mapId,
      baseVersion: knowledgeSaved.map.version,
      nodes: [...knowledgeSaved.map.nodes, imageNode],
      edges: [
        ...knowledgeSaved.map.edges,
        {
          id: 'knowledge-image-task-a',
          source: imageCardId,
          target: 'task-a',
          data: { relation: 'knowledge', knowledgePolicy: 'reuse-first' },
        },
      ],
    })

    const expectedImageLocalPath = path.resolve(testDataDirectory, '_assets', mapId, uploadedImage.assetId)
    await access(expectedImageLocalPath)
    const imageKnowledgeContext = await invoke('mindnprogress_get_context', {
      mapId,
      cardId: 'task-a',
      editorId: attribution.editorId,
      attributionToken: attribution.attributionToken,
    })
    const primaryImageSource = imageKnowledgeContext.selection.knowledgeSources.primary
      .find((source) => source.card.id === imageCardId)
    assert.equal(primaryImageSource.imageAccess.mode, 'local-file')
    assert.equal(primaryImageSource.imageAccess.localPath, expectedImageLocalPath)
    assert.equal(primaryImageSource.imageAccess.mimeType, 'image/png')
    const startupImageSource = imageKnowledgeContext.selection.taskLinks.startupInspection.primarySources
      .find((source) => source.cardId === imageCardId)
    assert.equal(startupImageSource.kind, 'image')
    assert.equal(startupImageSource.imageAccess.localPath, expectedImageLocalPath)
    assert.match(imageKnowledgeContext.selection.taskLinks.startupInspection.instruction, /imageAccess\.localPath.*로컬 이미지 열람 도구/)

    const imageCardDetail = await invoke('mindnprogress_get_card', { mapId, cardId: imageCardId })
    assert.equal(imageCardDetail.card.imageAccess.localPath, expectedImageLocalPath)
    assert.equal(imageCardDetail.card.data.description, '화면 기획 원본')
    const imageDocument = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(
      imageDocument.access.cards.find((card) => card.cardId === imageCardId)?.imageAccess.localPath,
      expectedImageLocalPath,
    )

    const cardDetail = await invoke('mindnprogress_get_card', {
      mapId,
      cardId: 'task-a',
      commentLimit: 1,
      commentOrder: 'desc',
    })
    assert.equal(cardDetail.card.id, 'task-a')
    assert.equal(cardDetail.card.position, undefined)
    assert.equal(cardDetail.card.textIntegrity.description.length, cardDetail.card.data.description.length)
    assert.match(cardDetail.card.textIntegrity.description.sha256, /^[a-f0-9]{64}$/)
    assert.equal(cardDetail.card.textIntegrity.sharedKnowledge.length, cardDetail.card.data.sharedKnowledge.length)
    assert.match(cardDetail.card.textIntegrity.sharedKnowledge.sha256, /^[a-f0-9]{64}$/)
    assert.equal(cardDetail.comments.length, 1)
    assert.ok(cardDetail.commentsPage.total >= 2)
    assert.equal(cardDetail.commentsPage.hasMore, true)
    assert.equal(cardDetail.accessUrl, `https://mindnprogress.test/mindmap/${mapId}/task-a`)

    const commentPage = await invoke('mindnprogress_list_comments', {
      mapId,
      cardId: 'task-a',
      offset: 0,
      limit: 1,
      order: 'desc',
    })
    assert.equal(commentPage.comments.length, 1)
    assert.ok(commentPage.total >= 2)
    assert.equal(commentPage.hasMore, true)
    assert.equal(commentPage.nextOffset, 1)
    const knowledgeCommentDetail = await invoke('mindnprogress_list_comments', {
      mapId,
      cardId: 'branch-a',
      includeDetail: true,
    })
    assert.equal(knowledgeCommentDetail.comments[0].detail, '검증된 결정과 적용 범위를 공유 지식과 함께 확인했습니다.')
    await invokeExpectError('mindnprogress_update_card', {
      mapId,
      cardId: 'task-a',
      nodeId: 'branch-a',
      data: {},
    }, /cardId와 호환용 nodeId의 값이 서로 다릅니다/)
    await invokeExpectError('mindnprogress_update_card', { mapId, data: {} }, /cardId를 입력해 주세요/)

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
      parentCardId: 'root',
      data: { label: '추가 카드', description: '', kind: 'branch', status: 'planned', progress: 0 },
    })
    assert.equal(addedCardResult.responseMode, 'affected')
    assert.equal(addedCardResult.map, undefined, 'add_card 기본 응답에 전체 문서가 담기면 안 됩니다.')
    assert.equal(addedCardResult.parentCardId, 'root')
    assert.equal(addedCardResult.document.id, mapId)
    assert.ok(
      addedCardResult.affectedCards.every((entry) => entry.card.id !== addedCardResult.card.id),
      'affected 응답은 card와 affectedCards에 같은 카드를 중복해서 담지 않아야 합니다.',
    )
    const addedCard = addedCardResult.card
    assert.ok(addedCard)
    assert.equal(addedCard.data.label, '추가 카드')
    assert.equal(addedCard.data.sharedKnowledge, '')
    assert.equal(addedCard.position.x % 24, 0)
    assert.equal(addedCard.position.y % 24, 0)

    const secondAddedCardResult = await invoke('mindnprogress_add_card', {
      mapId,
      parentId: 'root',
      data: { label: '두 번째 추가 카드', description: '', kind: 'branch', status: 'planned', progress: 0 },
      responseMode: 'full',
    })
    assert.equal(secondAddedCardResult.responseMode, 'full')
    assert.ok(secondAddedCardResult.createdCardId)
    assert.ok(secondAddedCardResult.map.createdAt)
    assert.ok(secondAddedCardResult.map.createdBy?.id)
    const secondAddedCard = secondAddedCardResult.map.nodes.find((node) => node.data.label === '두 번째 추가 카드')
    assert.ok(secondAddedCard)
    assert.equal(secondAddedCard.id, secondAddedCardResult.createdCardId)
    assert.equal(secondAddedCard.type, 'mind')
    assert.equal(secondAddedCard.position.x, addedCard.position.x)
    assert.equal(secondAddedCard.position.y - addedCard.position.y, 144)
    const secondAddedCardEdge = secondAddedCardResult.map.edges
      .find((edge) => edge.source === 'root' && edge.target === secondAddedCard.id)
    assert.equal(secondAddedCardEdge?.type, 'default')
    assert.equal(secondAddedCardEdge?.markerEnd?.type, 'arrowclosed')

    const waitingCardResult = await invoke('mindnprogress_update_card', {
      mapId,
      cardId: addedCard.id,
      responseMode: 'affected',
      data: {
        description: '부분 병합 보존 설명',
        kind: 'task',
        isWork: true,
        taskUrl: 'https://example.com/partial-merge',
        assigneeId: attribution.editorId,
        dueDate: '2026-07-30',
        checklist: [{ id: 'check-partial-merge', text: '부분 병합 보존', done: false }],
        blockedBy: ['task-a'],
        aiConversationId: 'conversation-partial-merge',
        waitingItems: [{ label: '캐릭터 아트 전달', resumeCondition: '최종 PNG 수령' }],
      },
    })
    const waitingCard = waitingCardResult.card
    assert.equal(waitingCard.data.label, '추가 카드')
    assert.equal(waitingCard.data.progress, 0)
    assert.equal(waitingCard.data.status, 'planned')
    assert.equal(waitingCard.data.waitingItems[0].label, '캐릭터 아트 전달')
    assert.ok(waitingCard.data.waitingItems[0].id)
    assert.ok(waitingCard.data.waitingItems[0].since)
    assert.equal(waitingCardResult.document.rootProgress, 15)
    assert.equal(waitingCardResult.document.rootStatus, 'in-progress')
    assert.equal(waitingCardResult.root.progress, 15)
    assert.equal(waitingCardResult.root.status, 'in-progress')
    assert.equal(waitingCardResult.responseMode, 'affected')
    assert.ok(waitingCardResult.changedFields.includes('progress'))
    assert.ok(waitingCardResult.changedFields.includes('status'))
    assert.ok(waitingCardResult.affectedCards.some((item) => item.card.id === addedCard.id && item.reason === 'requested'))
    assert.ok(waitingCardResult.affectedCards.some((item) => item.card.id === 'root' && item.reason === 'root-rollup'))

    const partialMergePreservedFields = [
      'label',
      'description',
      'progress',
      'status',
      'kind',
      'taskUrl',
      'isWork',
      'assigneeId',
      'dueDate',
      'checklist',
      'blockedBy',
      'waitingItems',
      'aiConversationId',
    ]
    const preservedCardData = Object.fromEntries(
      partialMergePreservedFields.map((field) => [field, waitingCard.data[field]]),
    )
    const partialUpdateResult = await invoke('mindnprogress_update_card', {
      mapId,
      cardId: addedCard.id,
      data: { sharedKnowledge: '공유 지식만 부분 수정' },
    })
    const partiallyUpdatedCard = partialUpdateResult.map.nodes.find((node) => node.id === addedCard.id)
    assert.ok(partiallyUpdatedCard)
    assert.equal(partiallyUpdatedCard.data.sharedKnowledge, '공유 지식만 부분 수정')
    assert.deepEqual(
      Object.fromEntries(partialMergePreservedFields.map((field) => [field, partiallyUpdatedCard.data[field]])),
      preservedCardData,
    )
    assert.deepEqual(partiallyUpdatedCard.position, waitingCard.position)
    assert.equal(partialUpdateResult.responseMode, 'full')
    assert.equal(partialUpdateResult.summary.version, partialUpdateResult.map.version)
    assert.equal(partialUpdateResult.changedCardId, addedCard.id)
    assert.deepEqual(partialUpdateResult.changedFields, ['sharedKnowledge'])
    assert.match(JSON.stringify(partialUpdateResult), /현재 선택과 무관한 장문 지식/)
    assert.ok(partialUpdateResult.map.nodes.every((node) => node.type === undefined))
    assert.ok(partialUpdateResult.map.nodes.every((node) => node.data.aiConversations === undefined))
    assert.ok(partialUpdateResult.map.edges.every((edge) => edge.type === undefined && edge.markerEnd === undefined && edge.reconnectable === undefined))
    assert.ok(partialUpdateResult.map.edges.some((edge) => edge.data.relation === 'knowledge' && edge.data.knowledgePolicy === 'inspect-if-insufficient'))

    const patchBase = await invoke('mindnprogress_get_card', { mapId, cardId: addedCard.id })
    const descriptionPatch = await invoke('mindnprogress_patch_card_text', {
      mapId,
      cardId: addedCard.id,
      field: 'description',
      expectedSha256: patchBase.card.textIntegrity.description.sha256,
      operation: { type: 'replace_once', find: '보존', replace: '안전' },
    })
    const descriptionPatchCard = await invoke('mindnprogress_get_card', { mapId, cardId: addedCard.id })
    assert.equal(descriptionPatchCard.card.data.description, '부분 병합 안전 설명')
    assert.deepEqual(descriptionPatchCard.card.textIntegrity.description, descriptionPatch.after)

    const patchResult = await invoke('mindnprogress_patch_card_text', {
      mapId,
      cardId: addedCard.id,
      field: 'sharedKnowledge',
      expectedSha256: patchBase.card.textIntegrity.sharedKnowledge.sha256,
      operation: { type: 'replace_once', find: '부분 수정', replace: '안전 수정' },
    })
    assert.equal(patchResult.operation, 'replace_once')
    assert.deepEqual(patchResult.before, patchBase.card.textIntegrity.sharedKnowledge)
    assert.notEqual(patchResult.after.sha256, patchResult.before.sha256)
    assert.equal(patchResult.verification.storedMatchesExpected, true)

    const replacedPatchCard = await invoke('mindnprogress_get_card', { mapId, cardId: addedCard.id })
    assert.equal(replacedPatchCard.card.data.sharedKnowledge, '공유 지식만 안전 수정')
    assert.deepEqual(replacedPatchCard.card.textIntegrity.sharedKnowledge, patchResult.after)
    const versionAfterReplace = replacedPatchCard.document.version
    await invokeExpectError('mindnprogress_patch_card_text', {
      mapId,
      cardId: addedCard.id,
      field: 'sharedKnowledge',
      expectedSha256: patchBase.card.textIntegrity.sharedKnowledge.sha256,
      operation: { type: 'append', text: '추가' },
    }, /TEXT_HASH_MISMATCH/)
    const staleHashCard = await invoke('mindnprogress_get_card', { mapId, cardId: addedCard.id })
    assert.equal(staleHashCard.document.version, versionAfterReplace)
    assert.equal(staleHashCard.card.data.sharedKnowledge, '공유 지식만 안전 수정')

    const appendedPatch = await invoke('mindnprogress_patch_card_text', {
      mapId,
      cardId: addedCard.id,
      field: 'sharedKnowledge',
      expectedSha256: staleHashCard.card.textIntegrity.sharedKnowledge.sha256,
      operation: { type: 'append', text: '반복 반복' },
    })
    const appendedPatchCard = await invoke('mindnprogress_get_card', { mapId, cardId: addedCard.id })
    assert.equal(appendedPatchCard.card.data.sharedKnowledge, '공유 지식만 안전 수정\n\n반복 반복')
    assert.deepEqual(appendedPatchCard.card.textIntegrity.sharedKnowledge, appendedPatch.after)
    await invokeExpectError('mindnprogress_patch_card_text', {
      mapId,
      cardId: addedCard.id,
      field: 'sharedKnowledge',
      expectedSha256: appendedPatch.after.sha256,
      operation: { type: 'replace_once', find: '반복', replace: '교체' },
    }, /TEXT_PATCH_MATCH_COUNT.*일치 2개/)

    const structuredPatch = await invoke('mindnprogress_patch_card_text', {
      mapId,
      cardId: addedCard.id,
      field: 'sharedKnowledge',
      expectedSha256: appendedPatch.after.sha256,
      operation: {
        type: 'replace_once',
        find: appendedPatchCard.card.data.sharedKnowledge,
        replace: '앞[시작]기존[끝]뒤',
      },
    })
    const betweenPatch = await invoke('mindnprogress_patch_card_text', {
      mapId,
      cardId: addedCard.id,
      field: 'sharedKnowledge',
      expectedSha256: structuredPatch.after.sha256,
      operation: {
        type: 'replace_between',
        startMarker: '[시작]',
        endMarker: '[끝]',
        replacement: '교체',
      },
    })
    const betweenPatchCard = await invoke('mindnprogress_get_card', { mapId, cardId: addedCard.id })
    assert.equal(betweenPatchCard.card.data.sharedKnowledge, '앞[시작]교체[끝]뒤')
    assert.deepEqual(betweenPatchCard.card.textIntegrity.sharedKnowledge, betweenPatch.after)
    const versionBeforeLengthError = betweenPatchCard.document.version
    await invokeExpectError('mindnprogress_patch_card_text', {
      mapId,
      cardId: addedCard.id,
      field: 'sharedKnowledge',
      expectedSha256: betweenPatch.after.sha256,
      operation: { type: 'append', text: '가'.repeat(10_001) },
    }, /TEXT_PATCH_LENGTH_LIMIT.*10,000자/)
    const lengthErrorCard = await invoke('mindnprogress_get_card', { mapId, cardId: addedCard.id })
    assert.equal(lengthErrorCard.document.version, versionBeforeLengthError)
    assert.equal(lengthErrorCard.card.data.sharedKnowledge, '앞[시작]교체[끝]뒤')

    const updatedCardResult = await invoke('mindnprogress_update_card', {
      mapId,
      cardId: addedCard.id,
      responseMode: 'affected',
      data: {
        label: '수정된 업무 카드', description: '업데이트 검증', sharedKnowledge: '후속 카드가 재사용할 완료 결과', kind: 'task', isWork: true,
        status: 'done', progress: 100, dueDate: '2026-07-31', checklist: [{ id: 'check-regression', text: '완료 조건', done: true }],
      },
      position: { x: 700, y: 220 },
    })
    const updatedCard = updatedCardResult.card
    assert.equal(updatedCard.data.progress, 100)
    assert.deepEqual(updatedCard.data.waitingItems, [])
    assert.equal(updatedCard.data.sharedKnowledge, '후속 카드가 재사용할 완료 결과')
    assert.equal(updatedCard.data.sharedKnowledgeUpdatedBy.name, 'Claude Code(Claude Test Model)')
    assert.ok(updatedCard.data.sharedKnowledgeUpdatedAt)
    assert.equal(updatedCardResult.document.rootProgress, 65)
    assert.equal(updatedCardResult.document.rootStatus, 'in-progress')
    assert.equal(updatedCardResult.root.progress, 65)
    assert.equal(updatedCardResult.root.status, 'in-progress')
    assert.ok(updatedCardResult.changedFields.includes('position'))

    const waitingReleaseNotifications = await invoke('mindnprogress_list_notifications')
    const waitingReleaseNotification = waitingReleaseNotifications.notifications.find((notification) =>
      notification.type === 'waiting-released' && notification.nodeId === addedCard.id)
    assert.ok(waitingReleaseNotification, 'AI가 담당자 본인의 대기를 해제했을 때 알림이 생성되지 않았습니다.')
    assert.equal(waitingReleaseNotification.userId, attribution.editorId)
    assert.equal(waitingReleaseNotification.actor.id, attribution.editorId)
    assert.equal(waitingReleaseNotification.actor.name, 'Claude Code(Claude Test Model)')

    const movedCardResult = await invoke('mindnprogress_move_card', { mapId, cardId: addedCard.id, newParentCardId: 'branch-b' })
    assert.equal(movedCardResult.responseMode, 'affected')
    assert.equal(movedCardResult.map, undefined, 'move_card 기본 응답에 전체 문서가 담기면 안 됩니다.')
    assert.equal(movedCardResult.card.id, addedCard.id)
    assert.equal(movedCardResult.hierarchy.newParentCardId, 'branch-b')
    assert.equal(movedCardResult.hierarchy.previousParentCardId, 'root')
    assert.ok(movedCardResult.affectedCards.every((entry) => entry.card.id !== addedCard.id))

    const movedBackResult = await invoke('mindnprogress_move_card', {
      mapId, cardId: addedCard.id, newParentCardId: 'root', responseMode: 'full',
    })
    assert.equal(movedBackResult.responseMode, 'full')
    assert.equal(movedBackResult.movedCardId, addedCard.id)
    assert.ok(movedBackResult.map.createdAt)
    assert.ok(movedBackResult.map.createdBy?.id)
    assert.ok(movedBackResult.map.edges.some((edge) => edge.source === 'root' && edge.target === addedCard.id))
    assert.ok(!movedBackResult.map.edges.some((edge) => edge.source === 'branch-b' && edge.target === addedCard.id))

    const detachedChildResult = await invoke('mindnprogress_add_card', {
      mapId,
      parentCardId: addedCard.id,
      data: { label: '삭제 후 분리될 카드', description: '', kind: 'branch', status: 'planned', progress: 0 },
    })
    await invoke('mindnprogress_add_knowledge_line', {
      mapId,
      sourceCardId: 'branch-a',
      targetCardId: addedCard.id,
      knowledgePolicy: 'inspect-if-insufficient',
    })

    const deletedCardResult = await invoke('mindnprogress_delete_card', { mapId, cardId: addedCard.id, includeDescendants: false })
    assert.equal(deletedCardResult.responseMode, 'affected')
    assert.equal(deletedCardResult.map, undefined, 'delete_card 기본 응답에 전체 문서가 담기면 안 됩니다.')
    assert.deepEqual(deletedCardResult.deletedCardIds, [addedCard.id])
    assert.equal(deletedCardResult.relationChanges.previousParentCardId, 'root')
    assert.deepEqual(deletedCardResult.relationChanges.detachedChildCardIds, [detachedChildResult.card.id])
    assert.deepEqual(deletedCardResult.relationChanges.removedKnowledgeLines.map((line) => ({
      sourceCardId: line.sourceCardId,
      targetCardId: line.targetCardId,
      knowledgePolicy: line.knowledgePolicy,
    })), [{
      sourceCardId: 'branch-a',
      targetCardId: addedCard.id,
      knowledgePolicy: 'inspect-if-insufficient',
    }])
    assert.equal(deletedCardResult.root.progress, 30)
    assert.ok(deletedCardResult.affectedCards.every((entry) => entry.card.id !== addedCard.id))

    const fullDeletedCardResult = await invoke('mindnprogress_delete_card', {
      mapId, nodeId: secondAddedCard.id, includeDescendants: true, responseMode: 'full',
    })
    assert.equal(fullDeletedCardResult.responseMode, 'full')
    assert.deepEqual(fullDeletedCardResult.deletedCardIds, [secondAddedCard.id])
    assert.ok(fullDeletedCardResult.map.createdAt)
    assert.ok(fullDeletedCardResult.map.createdBy?.id)
    assert.ok(!fullDeletedCardResult.map.nodes.some((node) => node.id === secondAddedCard.id))
    await invoke('mindnprogress_delete_card', { mapId, cardId: detachedChildResult.card.id, includeDescendants: true })

    documentResult = await invoke('mindnprogress_get_document', { mapId })
    const metadataResult = await invoke('mindnprogress_update_document_info', {
      mapId, baseVersion: documentResult.map.version, title: 'MCP 전체 회귀 문서 수정', color: 'red',
    })
    assert.equal(metadataResult.summary.color, 'red')

    const savedDocumentLayout = await invoke('mindnprogress_save_document_layout', {
      documentLayout: {
        version: 1,
        items: [
          { type: 'group', id: 'group-mcp-regression' },
          { type: 'map', id: secondaryMapId },
        ],
        groups: [{
          id: 'group-mcp-regression',
          name: 'JP-매니저 문서',
          mapIds: [mapId],
        }],
      },
    })
    assert.deepEqual(savedDocumentLayout.documentLayout.items, [
      { type: 'group', id: 'group-mcp-regression' },
      { type: 'map', id: secondaryMapId },
    ])
    assert.deepEqual(savedDocumentLayout.maps.map((map) => map.id), [mapId, secondaryMapId])

    const reordered = await invoke('mindnprogress_reorder_documents', { mapIds: [secondaryMapId, mapId] })
    assert.deepEqual(reordered.maps.map((map) => map.id), [secondaryMapId, mapId])
    assert.equal(reordered.documentLayout.groups[0].id, 'group-mcp-regression')
    assert.deepEqual(reordered.documentLayout.groups[0].mapIds, [mapId])

    const notificationsPath = path.join(testDataDirectory, '_notifications')
    await rm(notificationsPath, { recursive: true, force: true })
    await writeFile(notificationsPath, '알림 디렉터리 접근 실패 회귀 조건', 'utf8')
    const commentWithFailedNotification = await invoke('mindnprogress_add_comment', {
      mapId, cardId: 'root', summary: '[진행] 알림 실패와 무관하게 댓글이 한 번만 생성되는지 검증합니다.',
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

    await writeFile(path.join(notificationsPath, `${attribution.editorId}.json`), '{', 'utf8')
    const parentComment = await invoke('mindnprogress_add_comment', {
      mapId,
      cardId: 'root',
      summary: '[진행] 댓글 상태와 반응을 검증합니다.',
      detail: '답글, 해결 상태, 반응과 수정 후 메타데이터 보존을 순서대로 확인합니다.',
    })
    const replyComment = await invoke('mindnprogress_add_comment', {
      mapId, cardId: 'root', parentCommentId: parentComment.comment.id, summary: '[진행] 답글 생성을 검증합니다.',
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
      mapId,
      commentId: parentComment.comment.id,
      expectedText: parentComment.comment.text,
      summary: '[결과] 댓글 수정과 메타데이터 보존을 검증했습니다.',
      detail: '작성자, 생성 시각, 해결 상태와 이모지 반응이 수정 뒤에도 유지됩니다.',
    })
    assert.equal(updatedComment.comment.id, parentComment.comment.id)
    assert.equal(updatedComment.comment.text, '[결과] 댓글 수정과 메타데이터 보존을 검증했습니다.')
    assert.equal(updatedComment.comment.summary, updatedComment.comment.text)
    assert.equal(updatedComment.comment.detail, '작성자, 생성 시각, 해결 상태와 이모지 반응이 수정 뒤에도 유지됩니다.')
    assert.equal(updatedComment.comment.contentFormat, 'summary-detail')
    assert.equal(updatedComment.comment.createdAt, parentComment.comment.createdAt)
    assert.equal(updatedComment.comment.author.name, parentComment.comment.author.name)
    assert.equal(updatedComment.comment.resolvedAt, resolved.comment.resolvedAt)
    assert.ok(updatedComment.comment.reactions['👍'].includes(attribution.editorId))
    assert.ok(updatedComment.comment.updatedAt)
    commentList = await invoke('mindnprogress_list_comments', { mapId, nodeId: 'root' })
    assert.equal(commentList.comments.length, 2)
    assert.equal(commentList.comments.find((comment) => comment.id === parentComment.comment.id)?.detail, undefined)
    assert.equal(commentList.comments.find((comment) => comment.id === parentComment.comment.id)?.hasDetail, true)
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
    }, /최상위 카드의 직계 자식이 2개/)

    const rootPromotionDocument = await invoke('mindnprogress_create_document', {
      title: '최상위 카드 승격 검증', color: 'teal', rootLabel: '삭제할 최상위 카드', rootDescription: '',
    })
    const rootPromotionMapId = rootPromotionDocument.map.id
    const rootPromotionSourceId = rootPromotionDocument.map.nodes[0].id
    const rootPromotionChild = await invoke('mindnprogress_add_card', {
      mapId: rootPromotionMapId,
      parentCardId: rootPromotionSourceId,
      data: {
        label: '새 최상위 카드',
        description: '',
        kind: 'branch',
        status: 'planned',
        progress: 0,
      },
      responseMode: 'affected',
    })
    const rootPromotionResult = await invoke('mindnprogress_delete_card', {
      mapId: rootPromotionMapId,
      cardId: rootPromotionSourceId,
      includeDescendants: true,
    })
    assert.equal(rootPromotionResult.promotedRootCardId, rootPromotionChild.card.id)
    assert.equal(rootPromotionResult.root.id, rootPromotionChild.card.id)
    const promotedRootDocument = await invoke('mindnprogress_get_document', { mapId: rootPromotionMapId })
    assert.equal(promotedRootDocument.map.nodes.length, 1)
    assert.equal(promotedRootDocument.map.nodes[0].id, rootPromotionChild.card.id)
    assert.equal(promotedRootDocument.map.nodes[0].data.kind, 'root')
    await invoke('mindnprogress_move_document_to_trash', { mapId: rootPromotionMapId })
    await invoke('mindnprogress_delete_trashed_documents', {
      mapIds: [rootPromotionMapId], confirmPermanentDeletion: true,
    })
    await invokeExpectError('mindnprogress_add_comment', {
      mapId, nodeId: 'missing-card', summary: '[진행] 존재하지 않는 카드에 댓글을 작성합니다.',
    }, /댓글을 남길 노드를 찾을 수 없습니다/)
    await invokeExpectError('mindnprogress_add_comment', {
      mapId, cardId: 'root', summary: `[결과] ${'가'.repeat(241)}`,
    }, /summary는 240자 이하.*detail 인자로 분리.*구현과 검증을 완료.*## 수행 내용.*호환용 text/)
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
    await invokeExpectError('mindnprogress_save_document_layout', {
      documentLayout: {
        version: 1,
        items: [],
        groups: [],
      },
    }, /문서 그룹과 순서 데이터가 올바르지 않습니다/)
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
    const postExpiryClient = new Client({ name: 'mindnprogress-post-expiry-without-token', version: '1.0.0' })
    await postExpiryClient.connect(postExpiryTransport)
    try {
      const persistedComment = parseToolResult('mindnprogress_add_comment', await postExpiryClient.callTool({
        name: 'mindnprogress_add_comment',
        arguments: { mapId, nodeId: 'task-a', summary: '[진행] 토큰 만료 후 새 MCP 세션의 연결 대화 귀속을 검증합니다.' },
      }))
      assert.equal(persistedComment.comment.author.name, 'Claude Code(Claude Test Model)')
    } finally {
      await postExpiryClient.close()
    }

    const deleteLinkEditorLoginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mcp-test-editor@mind.local', password: 'McpEditor!2026' }),
    })
    assert.equal(deleteLinkEditorLoginResponse.status, 200)
    editorSessionCookie = deleteLinkEditorLoginResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(editorSessionCookie, '대화 연결 삭제용 테스트 편집자 세션 쿠키가 없습니다.')
    const deleteConversationLinkResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/cards/task-a/ai-conversations/conversation-test`, {
      method: 'DELETE',
      headers: { Cookie: editorSessionCookie, 'X-MNP-Client': 'mcp-test-client' },
    })
    assert.equal(deleteConversationLinkResponse.status, 200)
    const deletedConversationLink = await deleteConversationLinkResponse.json()
    assert.equal(deletedConversationLink.removedConversationId, 'conversation-test')
    assert.equal(deletedConversationLink.latestConversationId, null)
    assert.equal(deletedConversationLink.card.data.aiConversationId, undefined)
    assert.equal(deletedConversationLink.card.data.aiConversations, undefined)
    const emptyConversationListResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/cards/task-a/ai-conversations`, {
      headers: { Cookie: editorSessionCookie },
    })
    assert.equal(emptyConversationListResponse.status, 200)
    const emptyConversationList = await emptyConversationListResponse.json()
    assert.equal(emptyConversationList.latestConversationId, null)
    assert.deepEqual(emptyConversationList.conversations, [])
    const repeatedDeleteConversationLinkResponse = await fetch(`${apiBaseUrl}/api/maps/${encodeURIComponent(mapId)}/cards/task-a/ai-conversations/conversation-test`, {
      method: 'DELETE',
      headers: { Cookie: editorSessionCookie },
    })
    assert.equal(repeatedDeleteConversationLinkResponse.status, 404)

    const uncalledTools = registeredToolNames.filter((name) => !calledTools.has(name))
    assert.deepEqual(uncalledTools, [], `호출되지 않은 MCP 도구: ${uncalledTools.join(', ')}`)

    // 도구 호출 계측이 실제 MCP 프로세스에서 파일로 남는지 확인한다.
    // 샌드박스는 finally에서 삭제되므로 반드시 여기서 검증한다.
    const usageDirectory = path.join(testDataDirectory, MCP_TOOL_USAGE_DIRECTORY_NAME)
    let usageTotals = await readToolUsageTotals(usageDirectory)
    for (let attempt = 0; attempt < 50 && usageTotals.totalCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      usageTotals = await readToolUsageTotals(usageDirectory)
    }
    assert.ok(usageTotals.shardCount > 0, '도구 호출 계측 파일이 생성되지 않았습니다.')
    assert.equal(
      usageTotals.registeredToolCount,
      registeredToolNames.length,
      `계측에 등록된 도구 수가 다릅니다: ${usageTotals.registeredToolCount}`,
    )
    const measuredContext = usageTotals.tools.find((tool) => tool.name === 'mindnprogress_get_context')
    assert.ok(measuredContext.ok > 0, 'get_context 호출이 계측되지 않았습니다.')
    assert.ok(measuredContext.chars > 0, 'get_context 응답 크기가 계측되지 않았습니다.')
    assert.ok(
      usageTotals.tools.some((tool) => tool.fail > 0),
      '실패한 도구 호출이 계측되지 않았습니다.',
    )

    console.log(JSON.stringify({
      registeredTools: registeredToolNames.length,
      calledTools: calledTools.size,
      totalCalls: [...calledTools.values()].reduce((sum, count) => sum + count, 0),
      measuredTools: usageTotals.tools.filter((tool) => tool.calls > 0).length,
      measuredCalls: usageTotals.totalCalls,
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
