import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { git } from '../server/lib/remoteWorkspaceProtocol.mjs'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const options = (...values) => values.map(value => ({ value, name: value }))

for (const strategy of ['new', 'resume']) test(`필수 풀 API: ${strategy} 요청의 고정 담당을 lease로 재배정하고 일반 대화와 중복 방지를 보존한다`, { timeout: 60_000 }, async t => {
  const posted = [], receipts = new Map(), workspaces = new Map(), effort = new Map()
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: status < 400, data })) }
    if (url.endsWith('/capabilities')) return send({ schemaVersion: 3, workspaceLeaseVersion: 3, atomicWorkspaceRebind: true, remoteWorkspaceOwnership: true, releasesRuntimeOnTerminal: true, explicitCompletionAfterInterruption: true })
    if (url === '/api/internal/conversation-runtimes/active') return send({ items: [] })
    if (url === '/api/agents/management') return send([{ id: 'codex', name: 'Codex CLI', backend: 'codex', installed: true, enabled: true,
      available_models: { available_models: options('gpt-6.1-sol') }, available_modes: { available_modes: options('full-access') },
      config_options: [{ category: 'thought_level', options: options('xhigh') }] }])
    if (url === '/api/internal/external-conversation-dispatches' && req.method === 'POST') {
      posted.push(body)
      const conversationId = body.targetConversationId ?? 'created-ordinary'
      if (body.workspaceLease) workspaces.set(conversationId, body.workspaceLease.projectRoot)
      const receipt = { operationId: body.operationId, conversationId, state: 'running', turnId: `turn-${posted.length}`, workspaceLease: body.workspaceLease ?? null }
      receipts.set(body.operationId, receipt); return send(receipt, 202)
    }
    if (url.startsWith('/api/internal/external-conversation-dispatches/')) return send(receipts.get(url.split('/').at(-1)) ?? {}, receipts.has(url.split('/').at(-1)) ? 200 : 404)
    if (url.startsWith('/api/conversations/')) {
      const id = url.split('/')[3]
      if (url.endsWith('/usage')) return send({ used: 100, size: 200000 })
      if (url.endsWith('/messages')) return send({ items: [], has_more_before: false })
      if (url.endsWith('/runtime/ensure')) return send({ runtime: { state: 'idle' }, config_options: [{ id: 'effort', category: 'thought_level', options: options('high', 'xhigh') }] })
      if (url.endsWith('/runtime-config')) return send({ model: { value: 'gpt-6.1-sol', source: 'runtime' }, thought_level: { value: effort.get(id) ?? 'high', source: 'runtime' } })
      if (req.method === 'PUT' && url.includes('/config-options/')) { effort.set(id, body.value); return send({ confirmation: 'observed' }) }
      return send({ id, name: id, type: 'acp', extra: { agent_id: 'codex', backend: 'codex', current_model_id: 'gpt-6.1-sol', workspace: workspaces.get(id) ?? '/ordinary/integration' },
        runtime: { state: 'idle', is_processing: false, pending_confirmations: 0 } })
    }
    return send([])
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  t.after(() => { backend.closeAllConnections(); backend.close() })
  const env = { MNP_AIONUI_URL: `http://127.0.0.1:${backend.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '200' }
  let worker
  const api = await storageApi(t, { documents: 1, env, seed: async ({ data, ids }) => {
    const root = path.dirname(data), integration = path.join(root, 'integration'); worker = path.join(root, 'worker')
    await mkdir(integration)
    await git(integration, ['init', '-b', 'main'])
    await git(integration, ['config', 'user.name', 'MnP test']); await git(integration, ['config', 'user.email', 'test@example.invalid'])
    await writeFile(path.join(integration, '.gitignore'), '.ai-session.json\n.ai-workspace.json\n')
    await writeFile(path.join(integration, 'base.txt'), '기준 파일\n')
    await git(integration, ['add', '.']); await git(integration, ['commit', '-m', '[김용민] 풀 배정 검증 기준'])
    await git(root, ['clone', integration, worker])
    env.MNP_WORKSPACE_POOL_REGISTRY = path.join(root, 'registry.json')
    await writeFile(env.MNP_WORKSPACE_POOL_REGISTRY, JSON.stringify({ schemaVersion: 1, poolId: 'required-pool', sharedRoot: path.join(root, 'shared'),
      workspaces: [{ id: 'integration', root: integration, role: 'integration' }, { id: 'worker', root: worker, role: 'worker' }] }))
    const map = fixture(ids[0])
    for (const [i, id] of [[0, 'parent'], [1, 'child-fixed']]) Object.assign(map.nodes[i].data, { aiConversationId: id, aiPrimaryConversationId: id,
      aiConversations: [{ conversationId: id, homeMachineId: 'isolated-storage', agent: { id: 'codex', label: 'Codex' }, model: { id: 'gpt-6.1-sol', label: 'Astra' }, workspace: '/ordinary/integration', startedBy: { id: 'user-editor' } }] })
    await writeFile(path.join(data, `${ids[0]}.json`), JSON.stringify(map))
  } })
  const mapId = api.ids[0], endpoint = `/api/maps/${mapId}/ai-delegations`
  const origin = { 'X-MNP-AI-Conversation-Id': 'parent', 'X-MNP-AI-Map-Id': mapId, 'X-MNP-AI-Card-Id': 'card-0' }
  const version = async () => (await api.call(`/api/maps/${mapId}`)).body.map.version
  const request = { targetCardId: 'card-1', strategy, machineId: 'isolated-storage', workspacePoolId: 'required-pool',
    instruction: '배정 검증만 수행합니다.', decisionReason: '기존 고정 담당을 정식 worker로 재배정', sourceRevision: await version(),
    idempotencyKey: `required-${strategy}`, workType: 'other', analysisDepth: 'standard' }
  if (strategy === 'resume') {
    request.conversationId = 'child-fixed'
    const listed = await api.call(`/api/maps/${mapId}/cards/card-1/ai-conversations`)
    request.conversationAssessmentId = listed.body.conversations.find(c => c.conversationId === 'child-fixed').contextHealth.assessmentId
  }
  const conflict = await api.call(endpoint, 'POST', { ...request, idempotencyKey: 'path-conflict', newConversation: { workspace: '/ordinary/integration' } }, origin)
  assert.equal(conflict.body.reasonCode, 'AI_WORKSPACE_POOL_PATH_CONFLICT')
  const missing = await api.call(endpoint, 'POST', { ...request, idempotencyKey: 'missing-pool', workspacePoolId: 'absent' }, origin)
  assert.equal(missing.body.reasonCode, 'AI_WORKSPACE_POOL_SCOPE_MISMATCH', JSON.stringify(missing))
  assert.equal(posted.length, 0, '필수 풀 실패는 일반 실행으로 우회하지 않는다')
  const accepted = await api.call(endpoint, 'POST', request, origin)
  assert.equal(accepted.status, 202, JSON.stringify(accepted))
  assert.equal(accepted.body.reasonCode, 'AI_WORKSPACE_ALLOCATION_PENDING')
  assert.equal(accepted.body.delegation.strategy, 'resume', 'new도 기존 담당을 유지한다')
  assert.equal(accepted.body.delegation.workspacePoolId, 'required-pool')
  for (let i = 0; i < 200 && !posted.some(p => p.targetConversationId === 'child-fixed'); i++) await pause(50)
  const dispatch = posted.find(p => p.targetConversationId === 'child-fixed')
  assert.ok(dispatch?.workspaceLease?.leaseId, JSON.stringify({ posted, delegations: (await api.call(endpoint)).body }))
  assert.equal(dispatch.strategy, 'resume'); assert.equal(dispatch.workspaceLease.projectRoot, worker)
  const repeat = await api.call(endpoint, 'POST', request, origin)
  assert.equal(repeat.body.repeated, true, JSON.stringify(repeat))
  assert.equal(posted.filter(p => p.targetConversationId === 'child-fixed').length, 1)
  const changedIntent = await api.call(endpoint, 'POST', { ...request, workspacePoolId: undefined }, origin)
  assert.equal(changedIntent.status, 409)
  let card
  for (let i = 0; i < 100; i++) {
    card = (await api.call(`/api/maps/${mapId}`)).body.map.nodes.find(n => n.id === 'card-1')
    if (card.data.aiConversations.find(c => c.conversationId === 'child-fixed').workspacePoolId) break
    await pause(50)
  }
  const linked = card.data.aiConversations.find(c => c.conversationId === 'child-fixed')
  assert.equal(linked.workspace, worker); assert.equal(linked.workspacePoolId, 'required-pool')
  assert.equal(card.data.aiPrimaryConversationId, 'child-fixed')
  const ordinary = await api.call(endpoint, 'POST', { ...request, targetCardId: 'card-2', strategy: 'new', conversationId: undefined, conversationAssessmentId: undefined,
    idempotencyKey: 'ordinary-work', sourceRevision: await version(), workspacePoolId: undefined, newConversation: { workspace: '/ordinary/integration' } }, origin)
  assert.equal(ordinary.status, 202, JSON.stringify(ordinary))
  assert.equal(ordinary.body.delegation.workspaceLease, null)
})
