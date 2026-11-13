import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'

const editorPassword = 'PolicyEditor!2026'
const options = (...ids) => ids.map((value) => ({ value, name: value }))
const agentRows = [
  { id: 'claude', name: 'Claude Code', backend: 'claude', installed: true, enabled: true,
    available_models: { available_models: options('opus', 'sonnet') },
    available_modes: { available_modes: options('default', 'acceptEdits', 'bypassPermissions') },
    config_options: [{ category: 'thought_level', options: options('high', 'xhigh', 'max') }] },
  { id: 'codex', name: 'Codex CLI', backend: 'codex', installed: true, enabled: true,
    available_models: { available_models: options('gpt-6.1-sol', 'gpt-6-astra') },
    available_modes: { available_modes: options('read-only', 'full-access') },
    config_options: [{ category: 'thought_level', options: options('high', 'xhigh', 'max') }] },
]
// 이어가기 대상의 현재 모델. 목록에 없는 대화(새로 만든 위임 대화 등)는 Codex Sol이다.
const conversationModels = { parent: ['claude', 'opus'], 'old-claude': ['claude', 'opus'], 'old-sol': ['codex', 'gpt-6.1-sol'], 'old-claude-retry': ['claude', 'opus'], 'root-sonnet': ['claude', 'sonnet'], 'root-sonnet-alone': ['claude', 'sonnet'], 'root-opus-old': ['claude', 'opus'], 'root-opus-new': ['claude', 'opus'] }
for (const card of [12, 13, 14, 15, 16, 17, 18]) {
  conversationModels[`sub-${card}-opus`] = ['claude', 'opus']
  conversationModels[`sub-${card}-sol-old`] = ['codex', 'gpt-6.1-sol']
  conversationModels[`sub-${card}-sol-new`] = ['codex', 'gpt-6.1-sol']
}
const link = (conversationId) => ({ conversationId, homeMachineId: 'isolated-storage',
  agent: { id: conversationModels[conversationId][0], label: conversationModels[conversationId][0] },
  model: { id: conversationModels[conversationId][1], label: conversationModels[conversationId][1] },
  skills: [], mcpServers: [], startedBy: { id: 'user-editor', label: '김용민' } })

test('하위 위임과 그룹 지시가 규칙에 맞는 최신 담당을 재사용하고 후보가 없을 때만 새 담당을 생성한다', { timeout: 90_000 }, async (t) => {
  const creates = []
  const unavailableConversationIds = new Set()
  const busy = new Set()
  const dispatches = new Map()
  const effort = new Map(), switched = []
  const remote = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost').pathname
    const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
    if (url === '/api/agents/management') return send(agentRows)
    if (url === '/api/internal/conversation-runtimes/active') return send({ schema_version: 1, generated_at: Date.now(), items: [] })
    if (url === '/api/internal/external-conversation-dispatches/capabilities') return send({ schemaVersion: 3, explicitCompletionAfterInterruption: true, historyOnlyReports: true })
    if (url === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.strategy === 'resume' && switched.includes(body.targetConversationId)) {
        assert.ok(['xhigh', 'max'].includes(effort.get(body.targetConversationId)), '실행 전달 이전에 실제 사고 강도를 맞춘다')
      }
      creates.push(body)
      const dispatch = { operationId: body.operationId, conversationId: body.targetConversationId ?? `child-${creates.length}`, state: 'running', turnId: `turn-${creates.length}` }
      if (body.create) conversationModels[dispatch.conversationId] = [body.create.agentId, body.create.modelId]
      dispatches.set(body.operationId, dispatch)
      return send(dispatch, 202)
    }
    if (url.startsWith('/api/internal/external-conversation-dispatches/')) {
      const dispatch = dispatches.get(decodeURIComponent(url.split('/').at(-1)))
      return send(dispatch ?? {}, dispatch ? 200 : 404)
    }
    if (url.startsWith('/api/conversations/')) {
      const id = url.split('/')[3]
      if (unavailableConversationIds.has(id)) return send({}, 503)
      const [agentId, modelId] = conversationModels[id] ?? ['codex', 'gpt-6.1-sol']
      if (url.endsWith('/runtime/ensure')) return send({ runtime: { state: busy.has(id) ? 'running' : 'idle' },
        config_options: [{ id: 'effort', category: 'thought_level', options: options('high', 'xhigh', 'max') }] })
      if (url.endsWith('/runtime-config')) return send({ model: { value: modelId, source: 'runtime' },
        thought_level: { value: effort.get(id) ?? 'high', source: 'runtime' } })
      if (request.method === 'PUT' && url.includes('/config-options/')) {
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        effort.set(id, JSON.parse(Buffer.concat(chunks).toString()).value); switched.push(id)
        return send({ confirmation: 'observed' })
      }
      return send({ id, type: 'acp', extra: { agent_id: agentId, current_model_id: modelId, backend: agentId },
        runtime: { state: busy.has(id) ? 'running' : 'idle', is_processing: busy.has(id), pending_confirmations: 0 } })
    }
    return send([])
  })
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => remote.close(resolve)))
  const api = await storageApi(t, { documents: 3,
    env: { MNP_AIONUI_URL: `http://127.0.0.1:${remote.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '600000' },
    seed: async ({ data, ids }) => {
      // 위임 규칙 설정은 로그인한 사람만 바꿀 수 있어 시험 편집자 비밀번호를 정한다(AI 연동 토큰은 거절).
      await writeFile(path.join(data, '_users.json'), JSON.stringify([{ id: 'user-editor', name: '김용민', email: 'editor@mind.local', role: 'editor', active: true,
        salt: 'fixture', passwordHash: scryptSync(editorPassword, 'fixture', 64).toString('hex') }]))
      const map = fixture(ids[0])
      Object.assign(map.nodes[0].data, { aiConversationId: 'parent', aiConversations: [{ ...link('parent'), mode: { id: 'acceptEdits', label: 'acceptEdits' } }] })
      // card-1은 하위에 다시 위임하는 중간 카드다(card-19가 그 하위).
      map.edges = map.edges.map((edge) => edge.target === 'card-19' ? { ...edge, source: 'card-1' } : edge)
      Object.assign(map.nodes[5].data, { aiConversationId: 'old-claude', aiConversations: [link('old-claude')] })
      Object.assign(map.nodes[6].data, { aiConversationId: 'old-sol', aiConversations: [link('old-sol')] })
      Object.assign(map.nodes[11].data, { aiConversationId: 'old-claude-retry', aiConversations: [link('old-claude-retry')] })
      for (const card of [12, 13, 14, 15, 16, 17, 18]) Object.assign(map.nodes[card].data, {
        aiConversationId: `sub-${card}-opus`, aiPrimaryConversationId: [13, 17].includes(card) ? `sub-${card}-sol-old` : card === 16 ? null : `sub-${card}-opus`,
        aiConversations: [
          { ...link(`sub-${card}-sol-new`), startedAt: '2026-11-09T00:00:00Z' },
          { ...link(`sub-${card}-sol-old`), startedAt: '2026-11-08T00:00:00Z' },
          { ...link(`sub-${card}-opus`), startedAt: '2026-11-10T00:00:00Z' },
        ],
      })
      await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
      await writeFile(path.join(data, '_ai-delegations.json'), JSON.stringify([{
        id: 'interrupted-original', mapId: ids[0], parentCardId: 'card-0', targetCardId: 'card-17',
        parentConversationId: 'parent', targetConversationId: 'sub-17-opus', state: 'waiting-child-resume',
        childStatus: 'interrupted', strategy: 'resume', startedBy: 'user-editor',
        createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
      }]))
      const target = fixture(ids[1])
      Object.assign(target.nodes[0].data, { aiConversationId: 'root-sonnet', aiConversations: [
        { ...link('root-opus-old'), startedAt: '2026-11-08T00:00:00Z' },
        { ...link('root-opus-new'), startedAt: '2026-11-09T00:00:00Z' },
        { ...link('root-sonnet'), startedAt: '2026-11-10T00:00:00Z' },
      ] })
      await writeFile(path.join(data, `${ids[1]}.json`), JSON.stringify(target))
      const alone = fixture(ids[2])
      Object.assign(alone.nodes[0].data, { aiConversationId: 'root-sonnet-alone', aiConversations: [link('root-sonnet-alone')] })
      await writeFile(path.join(data, `${ids[2]}.json`), JSON.stringify(alone))
      await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify([
        { mapId: ids[0], cardId: 'card-0', conversationId: 'parent', homeMachineId: 'isolated-storage', startedBy: 'user-editor' },
      ]))
      await writeFile(path.join(data, '_map-order.json'), JSON.stringify({ version: 1,
        items: [{ type: 'group', id: 'group-policy' }], groups: [{ id: 'group-policy', name: '위임 규칙 검증 그룹', mapIds: ids }] }))
      await mkdir(path.join(data, '_group-projects'), { recursive: true })
      await writeFile(path.join(data, '_group-projects/group-policy.json'), JSON.stringify({ version: 1,
        coordinatorMapId: ids[0], sources: [], objective: '위임 규칙 검증', instructions: '' }))
    },
  })
  const [mapId, targetMapId] = api.ids
  const currentMap = async (id) => (await api.call(`/api/maps/${id}`)).body.map
  const endpoint = `/api/maps/${mapId}/ai-delegations`
  const origin = { 'X-MNP-AI-Conversation-Id': 'parent', 'X-MNP-AI-Map-Id': mapId, 'X-MNP-AI-Card-Id': 'card-0' }
  const request = async (card, extra = {}) => ({ targetCardId: `card-${card}`, strategy: 'new',
    instruction: '위임 규칙 검증용 조사만 수행하세요.', decisionReason: '위임 규칙 검증',
    sourceRevision: (await currentMap(mapId)).version, idempotencyKey: `policy-card-${card}`, ...extra })
  const created = () => creates.at(-1).create
  const client = new Client({ name: 'delegation-policy-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...api.env, AIONUI_CONVERSATION_ID: 'parent' }, stderr: 'pipe' })
  try {
    await client.connect(transport)
    const invoke = async (name, args) => {
      const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
      assert.notEqual(result.isError, true, JSON.stringify(result))
      return JSON.parse(result.content.find((part) => part.type === 'text').text)
    }
    await invoke('get_context', { mapId, cardId: 'card-0', editorId: 'user-editor' })
    const tools = await client.listTools()
    for (const name of ['delegate_ai_work', 'send_group_document_instruction']) {
      const schema = tools.tools.find((tool) => tool.name === `mindnprogress_${name}`).inputSchema
      assert.ok(schema.required.includes('workType'), `${name}은 업무 유형을 반드시 받는다`)
      assert.deepEqual(schema.properties.workType.enum, ['review', 'other'])
      assert.ok(!schema.properties.newConversation.required?.includes('agentId'), `${name}은 AI 종류를 적지 않아도 된다`)
    }

    // 검수 외 하위 업무: Claude 상위 대화의 모드를 Codex에 넘기지 않는다.
    const sub = await invoke('delegate_ai_work', { mapId, ...await request(2, { workType: 'other' }) })
    assert.equal(sub.reasonCode, 'AI_DELEGATION_ACCEPTED', JSON.stringify(sub))
    assert.deepEqual([created().agentId, created().modelId, created().thoughtLevel, created().mode], ['codex', 'gpt-6.1-sol', 'xhigh', 'full-access'])
    assert.equal(sub.aiPolicy.rule, 'other/sub-card/standard')
    assert.deepEqual(sub.aiPolicy.applied, { agent: 'Codex CLI', model: 'gpt-6.1-sol', thoughtLevel: 'xhigh', mode: 'full-access' })
    const subLink = (await currentMap(mapId)).nodes[2].data.aiConversations.at(-1)
    assert.deepEqual([subLink.agent.id, subLink.model.id, subLink.thoughtLevel.id, subLink.mode.id], ['codex', 'gpt-6.1-sol', 'xhigh', 'full-access'])
    assert.equal((await currentMap(mapId)).nodes[2].data.aiPrimaryConversationId, subLink.conversationId)

    // 하위에 다시 위임하는 중간 카드도 하위 카드 규칙, 복잡한 분석은 max.
    const middle = await invoke('delegate_ai_work', { mapId, ...await request(1, { workType: 'other', analysisDepth: 'deep' }) })
    assert.equal(middle.aiPolicy.cardLevel, 'sub-card')
    assert.deepEqual([created().agentId, created().modelId, created().thoughtLevel], ['codex', 'gpt-6.1-sol', 'max'])

    // 검수는 하위 카드도 Claude Code·Opus. 같은 CLI의 상위 대화 모드는 물려받는다.
    const review = await invoke('delegate_ai_work', { mapId, ...await request(3, { workType: 'review' }) })
    assert.equal(review.aiPolicy.rule, 'review/any/standard')
    assert.deepEqual([created().agentId, created().modelId, created().thoughtLevel, created().mode], ['claude', 'opus', 'xhigh', 'acceptEdits'])

    // 기억한 옛 규칙 값은 규칙 값으로 바뀌고 응답에서 알린다.
    const stale = await invoke('delegate_ai_work', { mapId, ...await request(4, { workType: 'other',
      newConversation: { agentId: 'codex', modelId: 'gpt-6-astra', thoughtLevelId: 'high', modeId: 'read-only' } }) })
    assert.deepEqual([created().agentId, created().modelId, created().thoughtLevel, created().mode], ['codex', 'gpt-6.1-sol', 'xhigh', 'read-only'])
    assert.deepEqual(stale.aiPolicy.adjustments.map((item) => item.field), ['modelId', 'thoughtLevelId'])
    assert.match(stale.aiPolicy.message, /규칙 값을 적용/)

    // 규칙 모델과 다른 대화의 이어가기는 새 대화로 실행한다(평가 ID 없이도 이어가기 검사 전에 전환).
    const converted = await invoke('delegate_ai_work', { mapId, ...await request(5, { workType: 'other', strategy: 'resume', conversationId: 'old-claude' }) })
    assert.equal(converted.reasonCode, 'AI_DELEGATION_ACCEPTED', JSON.stringify(converted))
    assert.equal(creates.at(-1).strategy, 'new')
    assert.deepEqual([created().agentId, created().modelId], ['codex', 'gpt-6.1-sol'])
    assert.deepEqual(converted.aiPolicy.resumeConversion, { conversationId: 'old-claude', currentModelId: 'opus', expectedModelId: 'gpt-6.1-sol' })
    assert.equal(converted.delegation.strategy, 'new')
    assert.deepEqual((await currentMap(mapId)).nodes[5].data.aiConversations.map((item) => item.conversationId), ['old-claude', `child-${creates.length}`])
    assert.equal((await currentMap(mapId)).nodes[5].data.aiPrimaryConversationId, converted.delegation.targetConversationId)
    const convertedRepeat = await invoke('delegate_ai_work', { mapId, ...await request(5, { workType: 'other', strategy: 'resume', conversationId: 'old-claude' }),
      sourceRevision: converted.delegation.sourceRevision })
    assert.equal(convertedRepeat.reasonCode, 'AI_DELEGATION_REPEATED', '같은 요청을 다시 보내도 새 대화를 또 만들지 않는다')

    // 규칙 모델과 같은 대화는 기존 이어가기 검사를 그대로 탄다.
    const countBeforeSame = creates.length
    const sameModel = await api.call(endpoint, 'POST', { ...await request(6, { workType: 'other', strategy: 'resume', conversationId: 'old-sol' }) }, origin)
    assert.equal(sameModel.body.reasonCode, 'AI_DELEGATION_CONVERSATION_ASSESSMENT_REQUIRED', JSON.stringify(sameModel.body))
    assert.equal(creates.length, countBeforeSame)

    // 실제 사례: 담당 Opus와 규칙 Sol이 다르면 요청한 후보와 무관하게 최신 Sol을 선택·저장한다.
    const beforeCandidate = (await currentMap(mapId)).nodes[12].data
    const candidateRequest = await request(12, { workType: 'other', strategy: 'resume', conversationId: 'sub-12-sol-old' })
    const candidate = await invoke('delegate_ai_work', { mapId, ...candidateRequest })
    assert.equal(candidate.delegation.targetConversationId, 'sub-12-sol-new')
    assert.equal(candidate.delegation.strategy, 'resume')
    assert.equal(creates.at(-1).create, undefined)
    assert.equal(candidate.aiPolicy.primaryResolution.expectedConversationId, 'sub-12-opus')
    assert.equal((await currentMap(mapId)).nodes[12].data.aiPrimaryConversationId, 'sub-12-sol-new')
    const candidateData = (await currentMap(mapId)).nodes[12].data
    assert.equal(candidateData.aiConversationId, beforeCandidate.aiConversationId, '담당 전환이 최신 생성 대화 정보를 바꾸지 않는다')
    assert.deepEqual(candidateData.aiConversations.find((item) => item.conversationId === 'sub-12-sol-new'),
      { ...beforeCandidate.aiConversations.find((item) => item.conversationId === 'sub-12-sol-new'), thoughtLevel: { id: 'xhigh', label: 'xhigh' } }, '확인된 사고 강도만 갱신하고 생성 시각·나머지 메타데이터를 보존한다')
    assert.equal(effort.get('sub-12-sol-new'), 'xhigh')
    assert.equal(candidate.aiPolicy.applied.thoughtLevel, 'xhigh')
    const beforeRepeat = creates.length
    assert.equal((await invoke('delegate_ai_work', { mapId, ...candidateRequest })).repeated, true)
    assert.equal(creates.length, beforeRepeat)
    // 모델이 이미 맞는 담당은 최신 보조 후보가 있어도 유지한다. new 요청도 담당을 재사용한다.
    const kept = await invoke('delegate_ai_work', { mapId, ...await request(13, { workType: 'other' }) })
    assert.equal(kept.delegation.targetConversationId, 'sub-13-sol-old')
    assert.equal(creates.at(-1).create, undefined)
    const beforeRejected = creates.length
    unavailableConversationIds.add('sub-14-sol-new')
    const lookupFailure = await api.call(endpoint, 'POST', await request(14, { workType: 'other' }), origin)
    assert.equal(lookupFailure.body.reasonCode, 'AI_DELEGATION_PRIMARY_LOOKUP_UNAVAILABLE')
    busy.add('sub-15-sol-new')
    const busyCandidate = await api.call(endpoint, 'POST', await request(15, { workType: 'other' }), origin)
    assert.equal(busyCandidate.body.reasonCode, 'AI_DELEGATION_CONVERSATION_BUSY')
    assert.equal((await currentMap(mapId)).nodes[15].data.aiPrimaryConversationId, 'sub-15-opus')
    assert.equal((await api.call(endpoint, 'POST', await request(16, { workType: 'other' }), origin)).body.reasonCode, 'AI_DELEGATION_PRIMARY_REQUIRED')
    assert.equal(creates.length, beforeRejected, '조회 실패·실행 중·담당 해제 상태에서는 새 대화를 생성하지 않는다')
    const recovered = await invoke('delegate_ai_work', { mapId, ...await request(17, {
      workType: 'other', strategy: 'resume', conversationId: 'sub-17-opus',
    }) })
    assert.equal(recovered.delegation.targetConversationId, 'sub-17-opus', '중단된 동일 위임은 원래 대화에서 복구한다')
    assert.equal(recovered.delegation.resumesDelegationId, 'interrupted-original')
    assert.equal(recovered.delegation.primarySelection, undefined)
    assert.equal((await currentMap(mapId)).nodes[17].data.aiPrimaryConversationId, 'sub-17-sol-old')
    const explicit = await invoke('delegate_ai_work', { mapId, ...await request(18, {
      workType: 'other', aiPolicyOverride: { evidence: '사용자가 이번 작업을 별도 Sonnet 대화에 지정했습니다.' },
      newConversation: { agentId: 'claude', modelId: 'sonnet', thoughtLevelId: 'high' },
    }) })
    assert.equal(explicit.delegation.primarySelection, undefined)
    assert.equal(created().modelId, 'sonnet')
    assert.equal((await currentMap(mapId)).nodes[18].data.aiPrimaryConversationId, 'sub-18-opus')

    // new 요청이 최신 담당 이어가기로 자동 선택된 뒤 바쁨으로 실패해도, 원 요청으로 재접수할 수 있다.
    busy.clear()
    const retryAfterBusy = await invoke('delegate_ai_work', { mapId, ...await request(15, { workType: 'other',
      retryOfRequestId: busyCandidate.body.requestFailure.retryReference.requestId,
    }) })
    assert.equal(retryAfterBusy.delegation.targetConversationId, 'sub-15-sol-new')
    assert.equal((await currentMap(mapId)).nodes[15].data.aiPrimaryConversationId, 'sub-15-sol-new')

    // 사용자가 직접 지정한 설정은 근거와 함께일 때만 규칙 대신 쓴다.
    const override = await invoke('delegate_ai_work', { mapId, ...await request(7, { workType: 'other',
      aiPolicyOverride: { evidence: '사용자: 이번 하위 업무는 Sonnet으로 맡겨줘' }, newConversation: { agentId: 'claude', modelId: 'sonnet', thoughtLevelId: 'high' } }) })
    assert.equal(override.aiPolicy.override, true)
    assert.equal(override.aiPolicy.rule, null)
    assert.deepEqual([created().agentId, created().modelId, created().thoughtLevel], ['claude', 'sonnet', 'high'])
    const countBeforeInvalid = creates.length
    for (const [extra, reasonCode] of [
      [{ workType: 'other', aiPolicyOverride: { evidence: '사용자 지정' } }, 'AI_DELEGATION_POLICY_REQUEST_INVALID'],
      [{ workType: 'implementation' }, 'AI_DELEGATION_POLICY_REQUEST_INVALID'],
      [{ analysisDepth: 'deep' }, 'AI_DELEGATION_POLICY_REQUEST_INVALID'],
    ]) {
      const invalid = await api.call(endpoint, 'POST', await request(8, extra), origin)
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body))
      assert.equal(invalid.body.reasonCode, reasonCode)
    }
    // 규칙 모델이 실행 머신에 없으면 다른 모델로 바꾸지 않는다.
    agentRows[1].available_models.available_models = options('gpt-6-astra')
    const unavailable = await api.call(endpoint, 'POST', await request(8, { workType: 'other' }), origin)
    assert.equal(unavailable.status, 409, JSON.stringify(unavailable.body))
    assert.equal(unavailable.body.reasonCode, 'AI_DELEGATION_POLICY_UNAVAILABLE')
    assert.equal(creates.length, countBeforeInvalid)
    agentRows[1].available_models.available_models = options('gpt-6.1-sol', 'gpt-6-astra')

    // 규칙 값이 없는 이전 도구 정의의 요청은 기존처럼 상위 대화 설정을 상속한다.
    // 전환 기록과 운영 사례: 이어가기 요청이 문서 버전 충돌로 실패한 뒤 같은 지시로 재접수돼 새 대화로 바뀌어도 접수 실패 경고가 해제된다.
    const storedDelegations = async () => { const stored = await api.read('_ai-delegations.json'); return Array.isArray(stored) ? stored : stored.delegations ?? Object.values(stored) }
    assert.deepEqual((await storedDelegations()).find((item) => item.id === 'policy-card-5').aiPolicyResumeConversion,
      { conversationId: 'old-claude', currentModelId: 'opus', expectedModelId: 'gpt-6.1-sol' })
    const retryBase = await request(11, { workType: 'other', strategy: 'resume', conversationId: 'old-claude-retry' })
    const staleRetry = await api.call(endpoint, 'POST', { ...retryBase, idempotencyKey: 'policy-retry-first', sourceRevision: retryBase.sourceRevision + 100 }, origin)
    assert.equal(staleRetry.body.reasonCode, 'AI_DELEGATION_VERSION_CONFLICT', JSON.stringify(staleRetry.body))
    const failureId = staleRetry.body.requestFailure.retryReference.requestId
    const retried = await api.call(endpoint, 'POST', { ...retryBase, idempotencyKey: 'policy-retry-second', retryOfRequestId: failureId }, origin)
    assert.equal(retried.body.reasonCode, 'AI_DELEGATION_ACCEPTED', JSON.stringify(retried.body))
    assert.equal(retried.body.delegation.strategy, 'new')
    assert.equal(retried.body.aiPolicy.resumeConversion.conversationId, 'old-claude-retry')
    const listed = await api.call(`/api/maps/${mapId}/ai-delegations?parentCardId=card-0`, 'GET', undefined, origin)
    const retriedFailure = listed.body.requestFailures.find((item) => item.id === failureId)
    assert.equal(retriedFailure.resolvedByDelegationId, 'policy-retry-second', JSON.stringify(retriedFailure.retryVerification))
    assert.equal(retriedFailure.retryVerification.method, 'retry-reference')

    const legacy = await api.call(endpoint, 'POST', await request(9), origin)
    assert.equal(legacy.body.reasonCode, 'AI_DELEGATION_ACCEPTED', JSON.stringify(legacy.body))
    assert.equal(legacy.body.aiPolicy, undefined)
    assert.deepEqual([created().agentId, created().modelId], ['claude', 'opus'])

    // 같은 CLI의 기존 최신 담당 Sonnet과 규칙 Opus가 다르면 연결된 Opus 중 최신을 담당으로 선택한다.
    const groupRequest = { mapId, targetMapId, targetRevision: (await currentMap(targetMapId)).version,
      groupProjectVersion: 1, sourceRevision: (await currentMap(mapId)).version, strategy: 'resume', conversationId: 'root-sonnet',
      instructionType: 'planning', approvalScope: 'analysis-only', approvalEvidence: '사용자가 위임 규칙 검증용 분석을 요청했습니다.',
      instruction: '분석 결과를 정리하세요. 구현은 하지 마세요.', decisionReason: '문서 담당 대화 이어가기',
      idempotencyKey: 'policy-group', workType: 'other', analysisDepth: 'deep' }
    const beforeGroup = creates.length
    const group = await invoke('send_group_document_instruction', groupRequest)
    assert.equal(group.instruction.strategy, 'resume', JSON.stringify(group))
    assert.equal(group.instruction.requestedConversationId, 'root-opus-new')
    assert.equal(group.aiPolicy.primaryResolution.previousConversationId, 'root-sonnet')
    assert.equal((await currentMap(targetMapId)).nodes[0].data.aiPrimaryConversationId, 'root-opus-new')
    assert.equal(creates.length, beforeGroup + 1)
    assert.equal(creates.at(-1).targetConversationId, 'root-opus-new')
    assert.equal(creates.at(-1).create, undefined, '기존 일치 대화가 있으면 새 대화를 만들지 않는다')
    const repeated = await invoke('send_group_document_instruction', groupRequest)
    assert.equal(repeated.repeated, true)
    assert.equal(creates.length, beforeGroup + 1)

    // 규칙 인자가 없는 구형 HTTP 호출도 일치 모델이 없으면 규칙대로 만들고 담당을 저장한다.
    const aloneId = api.ids[2]
    const legacyRequest = { ...groupRequest, targetMapId: aloneId, targetRevision: (await currentMap(aloneId)).version,
      conversationId: 'root-sonnet-alone', idempotencyKey: 'policy-legacy-group' }
    delete legacyRequest.workType
    delete legacyRequest.analysisDepth
    const legacyGroup = await api.call(`/api/maps/${mapId}/group-document-instructions`, 'POST', legacyRequest, origin)
    assert.equal(legacyGroup.status, 202, JSON.stringify(legacyGroup.body))
    assert.equal(legacyGroup.body.instruction.strategy, 'new')
    assert.equal(creates.at(-1).create.modelId, 'opus')
    const newPrimary = legacyGroup.body.instruction.targetConversationId
    assert.ok(newPrimary)
    assert.equal((await currentMap(aloneId)).nodes[0].data.aiPrimaryConversationId, newPrimary)
    assert.equal((await api.call(`/api/maps/${mapId}/group-document-instructions`, 'POST', legacyRequest, origin)).body.repeated, true)
    assert.equal(creates.length, beforeGroup + 2, '같은 요청 재시도로 대화를 중복 생성하지 않는다')

    const choose = async (conversationId) => {
      const map = await currentMap(targetMapId), changed = structuredClone(map)
      changed.nodes[0].data.aiPrimaryConversationId = conversationId
      const saved = await api.call(`/api/maps/${targetMapId}/content-patch`, 'PATCH', { baseVersion: map.version, patch: createMapContentPatch(map, changed) })
      assert.equal(saved.status, 200, JSON.stringify(saved.body))
    }
    await choose('root-sonnet')
    unavailableConversationIds.add('root-opus-new')
    const lookup = await api.call(`/api/maps/${mapId}/group-document-instructions`, 'POST', {
      ...groupRequest, sourceRevision: (await currentMap(mapId)).version, targetRevision: (await currentMap(targetMapId)).version, idempotencyKey: 'policy-lookup-failed',
    }, origin)
    assert.equal(lookup.body.reasonCode, 'GROUP_DOCUMENT_INSTRUCTION_PRIMARY_LOOKUP_UNAVAILABLE')
    assert.equal((await currentMap(targetMapId)).nodes[0].data.aiPrimaryConversationId, 'root-sonnet')
    assert.equal(creates.length, beforeGroup + 2)
    unavailableConversationIds.clear()
    busy.add('root-opus-new')
    const queued = await api.call(`/api/maps/${mapId}/group-document-instructions`, 'POST', {
      ...groupRequest, sourceRevision: (await currentMap(mapId)).version, targetRevision: (await currentMap(targetMapId)).version, idempotencyKey: 'policy-busy-primary',
    }, origin)
    assert.equal(queued.body.instruction.state, 'queued', JSON.stringify(queued.body))
    assert.equal((await currentMap(targetMapId)).nodes[0].data.aiPrimaryConversationId, 'root-opus-new')
    assert.equal(creates.length, beforeGroup + 2, '실행 중인 일치 대화가 있으면 추가 대화를 만들지 않는다')
    await choose('root-sonnet')
    busy.clear()
    await api.tick(600000)
    let queuedResult
    for (let attempt = 0; attempt < 100; attempt++) {
      queuedResult = (await api.call(`/api/maps/${mapId}/group-document-instructions?instructionId=policy-busy-primary`)).body.instructions?.[0]
      if (queuedResult?.state === 'expired') break
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    assert.equal(queuedResult?.reasonCode, 'GROUP_DOCUMENT_INSTRUCTION_PRIMARY_CHANGED')
    assert.equal(creates.length, beforeGroup + 2, '대기 중 사람이 선택한 담당을 덮어쓰거나 이전 담당에 지시하지 않는다')

    // 계정 메뉴의 위임 규칙 설정: 저장하면 AI 대화에 알리지 않고 다음 위임부터 적용된다.
    const settingsPath = '/api/account/ai-delegation-policy'
    const byToken = await api.call(settingsPath)
    assert.equal(byToken.status, 401, 'AI 연동 토큰으로는 위임 규칙을 읽거나 바꿀 수 없다')
    const login = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'editor@mind.local', password: editorPassword }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const settings = async (method = 'GET', body) => {
      const response = await fetch(api.base + settingsPath, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json() }
    }
    const initial = await settings()
    assert.equal(initial.status, 200, JSON.stringify(initial.body))
    assert.equal(initial.body.source, 'default')
    assert.deepEqual(initial.body.policy, initial.body.defaults)
    assert.equal(initial.body.revision, sub.aiPolicy.revision, '위임 응답의 규칙 버전과 설정 화면의 버전이 같다')
    const edited = structuredClone(initial.body.policy)
    const subRule = edited.rules.find((rule) => rule.workType === 'other' && rule.cardLevel === 'sub-card' && rule.analysisDepth === 'standard')
    Object.assign(subRule, { modelId: 'gpt-6-astra', thoughtLevelId: 'high' })
    const saved = await settings('PUT', { ...edited, baseRevision: initial.body.revision })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.source, 'saved')
    assert.equal(saved.body.updatedBy.name, '김용민')
    assert.deepEqual((await api.read('_ai-delegation-policy.json')).rules.find((rule) => rule.modelId === 'gpt-6-astra').thoughtLevelId, 'high')
    const afterSave = await invoke('delegate_ai_work', { mapId, ...await request(10, { workType: 'other' }) })
    assert.deepEqual([created().agentId, created().modelId, created().thoughtLevel], ['codex', 'gpt-6-astra', 'high'])
    assert.equal(afterSave.aiPolicy.revision, saved.body.revision)
    const staleSave = await settings('PUT', { ...initial.body.policy, baseRevision: initial.body.revision })
    assert.equal(staleSave.status, 409, JSON.stringify(staleSave.body))
    assert.equal(staleSave.body.reasonCode, 'AI_DELEGATION_POLICY_CONFLICT')
    assert.equal(staleSave.body.current.revision, saved.body.revision)
    const uncovered = await settings('PUT', { ...edited, rules: edited.rules.filter((rule) => rule !== subRule), baseRevision: saved.body.revision })
    assert.equal(uncovered.status, 400)
    assert.equal(uncovered.body.reasonCode, 'AI_DELEGATION_POLICY_INVALID')
    assert.match(uncovered.body.error, /검수 외·하위 카드·기본\(맞는 행 없음\)/)
    assert.equal((await settings()).body.revision, saved.body.revision, '거절한 저장은 규칙을 바꾸지 않는다')
  } finally { await client.close() }
})
