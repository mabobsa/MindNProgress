import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(action, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await action()
    if (result) return result
    await pause(100)
  }
  throw new Error(message)
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}
async function stop(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited
}

test('그룹 기획 관리와 문서 루트 위임은 범위·동시 실행·복구·하위 완료 경계를 유지한다', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-group-api-'))
  const conversations = new Map()
  const dispatches = new Map()
  const calls = []
  let child
  const fake = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: status < 400, data: value })) }
    let body = {}
    if (req.method === 'POST' || req.method === 'PATCH') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    }
    if (url.pathname === '/api/agents/management') return send([{ id: 'claude', name: 'Claude', agent_type: 'acp', backend: 'claude', installed: true, enabled: true, available_models: { current_model_id: 'opus', available_models: [{ value: 'opus', name: 'Opus' }] } }])
    if (['/api/providers', '/api/skills', '/api/mcp/servers'].includes(url.pathname)) return send([])
    if (url.pathname === '/api/internal/conversation-runtimes/active') return send({ conversations: [] })
    if (url.pathname.endsWith('/capabilities')) return send({ schemaVersion: 3, explicitCompletionAfterInterruption: true })
    if (url.pathname === '/api/internal/external-conversation-dispatches' && req.method === 'POST') {
      calls.push(body)
      const id = body.strategy === 'new' ? `conversation-${calls.length}` : body.targetConversationId
      conversations.set(id, { ...(conversations.get(id) ?? {}), id, name: body.newConversation?.name ?? '문서 담당', extra: { agent_id: 'claude', current_model_id: 'opus', backend: 'claude' } })
      const dispatch = { operationId: body.operationId, conversationId: id, state: /-wake-\d+$/.test(body.operationId) ? 'completed' : 'running', turnId: `turn-${calls.length}` }
      dispatches.set(body.operationId, dispatch)
      return send({ ...dispatch, state: 'starting' }, 202)
    }
    const operation = url.pathname.match(/^\/api\/internal\/external-conversation-dispatches\/([^/]+)$/)
    if (operation) return send(dispatches.get(decodeURIComponent(operation[1])) ?? {}, dispatches.has(decodeURIComponent(operation[1])) ? 200 : 404)
    const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (conversation) {
      const id = decodeURIComponent(conversation[1])
      const saved = conversations.get(id)
      if (!saved) return send({}, 404)
      if (req.method === 'PATCH') { conversations.set(id, { ...saved, ...body }); return send(conversations.get(id)) }
      return send({ ...saved, runtime: { state: 'idle', is_processing: false, can_send_message: true, pending_confirmations: 0 } })
    }
    if (url.pathname.endsWith('/messages')) return send({ items: [{ type: 'text', position: 'left', content: '문서 분석과 하위 업무 검증 결과입니다.' }] })
    return send({}, 404)
  })
  const fakePort = await listen(fake)
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let errors = ''
  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: projectDirectory, env: {
      ...process.env, MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
      MNP_AIONUI_URL: `http://127.0.0.1:${fakePort}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '100',
      MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-workspace-pool.json'),
    }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr.on('data', (chunk) => { errors += chunk })
    await until(async () => { try { return (await fetch(baseUrl + '/api/health')).ok } catch { return false } }, `서버를 시작하지 못했습니다. ${errors}`)
  }
  try {
    await start()
    const token = (await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()
    const headers = { Authorization: `Bearer ${token}`, 'X-MNP-Editor-Id': 'group-test-editor', 'Content-Type': 'application/json' }
    async function api(url, method = 'GET', body, extraHeaders = {}) {
      const response = await fetch(baseUrl + url, { method, headers: { ...headers, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json() }
    }
    await api('/api/maps', 'POST', { title: '그룹 밖 문서', map: { nodes: [{ id: 'outside-root', type: 'mind', position: { x: 0, y: 0 }, data: { label: '그룹 밖 원본', description: '', kind: 'root', isWork: false, status: 'planned', progress: 0 } }], edges: [] } })
    const initial = (await api('/api/maps')).body
    const groupId = 'group-test-project'
    const layout = { version: 1, items: [...initial.documentLayout.items, { type: 'group', id: groupId }], groups: [...initial.documentLayout.groups, { id: groupId, name: '기획 기반 개발', mapIds: [] }] }
    assert.equal((await api('/api/maps/layout', 'PATCH', { documentLayout: layout })).status, 200)
    assert.equal((await api('/api/groups/' + groupId)).body.project.version, 0)
    const source = 'C:\\기획\\매니저_v0.3.pptx'
    const prepared = await api('/api/groups/' + groupId, 'PATCH', { baseVersion: 0, source, sourceVersion: 'v0.3', objective: '전체 기획 구현', instructions: '첫 절\n\n마지막 절은 보존합니다.', createCoordinator: true })
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
    let context = prepared.body
    const coordinatorId = context.coordinator.id
    const coordinatorRoot = context.coordinator.root.id
    assert.equal(context.coordinator.root.data.isWork, false)
    assert.equal(calls.length, 0, '그룹 준비는 AI를 실행하지 않는다')
    const stale = await api('/api/groups/' + groupId, 'PATCH', { baseVersion: 0, instructions: '덮어쓰기' })
    assert.equal(stale.status, 409)
    context = (await api('/api/groups/' + groupId, 'PATCH', { baseVersion: 1, sourceVersion: 'v0.4', createCoordinator: true })).body
    assert.equal(context.coordinator.id, coordinatorId)
    assert.equal(context.project.source, source)
    assert.equal(context.project.instructions, '첫 절\n\n마지막 절은 보존합니다.')
    assert.equal(context.documents.length, 1)

    const created = await api(`/api/groups/${groupId}/documents`, 'POST', { baseVersion: 2, title: '획득과 로비', description: '원본 전수 분석과 진입 흐름 검증' })
    assert.equal(created.status, 201)
    const target = created.body.map
    const targetRoot = target.nodes[0].id
    assert.equal(target.nodes[0].data.isWork, false)
    const targetDoc = (await api(`/api/maps/${target.id}`)).body
    assert.equal(targetDoc.groupProject.role, 'document')
    assert.equal(targetDoc.groupProject.coordinatorMapId, coordinatorId)
    assert.equal((await api(`/api/groups/${groupId}`)).body.documents.length, 2)

    const viewerResponse = await fetch(baseUrl + '/api/auth/viewer-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const cookie = viewerResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const viewerGet = await fetch(`${baseUrl}/api/groups/${groupId}`, { headers: { Cookie: cookie } })
    assert.equal(viewerGet.status, 200)
    const viewerWrite = await fetch(`${baseUrl}/api/groups/${groupId}`, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: 2, objective: '뷰어 변경' }) })
    assert.equal(viewerWrite.status, 403)

    const attribution = await api('/api/integrations/aionui/attributions', 'POST', { agentId: 'claude', modelId: 'opus', mapId: coordinatorId, cardId: coordinatorRoot, purpose: 'group-coordination', workspace: projectDirectory })
    assert.equal(attribution.status, 201, JSON.stringify(attribution.body))
    conversations.set('group-parent', { id: 'group-parent', name: '그룹 총괄', extra: { agent_id: 'claude', current_model_id: 'opus', backend: 'claude' } })
    const completeLink = await fetch(attribution.body.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'group-parent' }) })
    assert.equal(completeLink.status, 200)
    const sourceHeaders = { 'X-MNP-AI-Map-Id': coordinatorId, 'X-MNP-AI-Card-Id': coordinatorRoot, 'X-MNP-AI-Conversation-Id': 'group-parent', 'X-MNP-AI-Attribution': attribution.body.attributionToken, 'X-MNP-AI-Editor-Id': attribution.body.editorId }
    await api(`/api/maps/${coordinatorId}`, 'GET', undefined, sourceHeaders)
    const parent = (await api(`/api/maps/${coordinatorId}`)).body.map
    const args = { targetMapId: target.id, targetCardId: targetRoot, targetRevision: target.version, sourceRevision: parent.version, strategy: 'new', instruction: '담당 범위를 분석하고 하위 업무를 구성하세요.', decisionReason: '문서 담당 대화가 없습니다.', idempotencyKey: 'group-first', newConversation: { agentId: 'claude', modelId: 'opus', workspace: projectDirectory } }
    const delegateUrl = `/api/maps/${coordinatorId}/ai-delegations`
    assert.equal((await api(delegateUrl, 'POST', { ...args, targetRevision: 999 }, sourceHeaders)).status, 409)
    const outsideMap = initial.maps[0]?.id
    assert.ok(outsideMap)
    const outside = (await api(`/api/maps/${outsideMap}`)).body.map
    assert.equal((await api(delegateUrl, 'POST', { ...args, targetMapId: outsideMap, targetCardId: outside.nodes[0].id, targetRevision: outside.version }, sourceHeaders)).status, 400)
    const delegated = await api(delegateUrl, 'POST', args, sourceHeaders)
    assert.equal(delegated.status, 202, JSON.stringify(delegated.body))
    assert.equal(delegated.body.delegation.groupId, groupId)
    assert.equal(delegated.body.delegation.parentMapId, coordinatorId)
    assert.equal(delegated.body.delegation.mapId, target.id)
    assert.equal(delegated.body.delegation.coordinationOnly, true)
    assert.equal(delegated.body.delegation.workspaceLease, null)
    assert.match(calls[0].instruction, /코드·Prefab은 직접 수정하지 마세요/)
    assert.equal((await api(delegateUrl, 'POST', args, sourceHeaders)).body.repeated, true)
    assert.equal(calls.length, 1)
    const currentTarget = (await api(`/api/maps/${target.id}`)).body.map
    const duplicate = await api(delegateUrl, 'POST', { ...args, targetRevision: currentTarget.version, idempotencyKey: 'duplicate-target' }, sourceHeaders)
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.code, 'AI_DELEGATION_ALREADY_ACTIVE')
    assert.equal(calls.length, 1)
    const library = (await api('/api/maps')).body
    const movedLayout = structuredClone(library.documentLayout)
    movedLayout.groups.find((group) => group.id === groupId).mapIds = [coordinatorId]
    movedLayout.items.push({ type: 'map', id: target.id })
    assert.equal((await api('/api/maps/layout', 'PATCH', { documentLayout: movedLayout })).status, 409)
    assert.equal((await api(`/api/maps/${target.id}`, 'DELETE')).status, 409)
    assert.equal((await api(delegateUrl)).body.delegations[0].id, 'group-first')

    dispatches.get('group-first').state = 'recovery_required'
    await until(async () => (await api(`/api/groups/${groupId}`)).body.delegations.some((item) => item.state === 'recovery-required'), '복구 필요 상태가 되지 않았습니다.')
    await stop(child); await start()
    assert.equal((await api(`/api/groups/${groupId}`)).body.project.source, source)
    const recovery = await api(`${delegateUrl}/group-first/recover`, 'POST', { sourceRevision: parent.version, instruction: '현재 문서 분석을 이어가세요.' }, sourceHeaders)
    assert.equal(recovery.status, 202, JSON.stringify(recovery.body))
    assert.equal(recovery.body.delegation.parentMapId, coordinatorId)
    const operationId = recovery.body.delegation.childOperationId
    assert.ok(dispatches.has(operationId))
    const recoveryCall = calls.find((call) => call.operationId === operationId)
    assert.match(recoveryCall.instruction, /코드·Prefab은 직접 수정하지 마세요/)
    assert.match(recoveryCall.instruction, /worker 배정 없음/)
    assert.doesNotMatch(recoveryCall.instruction, /먼저 `\.ai-session\.json`/)
    const documentConversationId = delegated.body.delegation.targetConversationId
    const childHeaders = { 'X-MNP-AI-Map-Id': target.id, 'X-MNP-AI-Card-Id': targetRoot, 'X-MNP-AI-Conversation-Id': documentConversationId, 'X-MNP-AI-Editor-Id': attribution.body.editorId }
    const beforeLeaf = (await api(`/api/maps/${target.id}`, 'GET', undefined, childHeaders)).body.map
    const leafId = 'implementation-leaf'
    const withLeaf = await api(`/api/maps/${target.id}`, 'PUT', {
      baseVersion: beforeLeaf.version,
      map: {
        nodes: [...beforeLeaf.nodes, { id: leafId, type: 'mind', position: { x: 300, y: 0 }, data: { label: '하위 구현', description: '로비 진입 구현과 검증', kind: 'task', isWork: true, status: 'planned', progress: 0 } }],
        edges: [...beforeLeaf.edges, { id: 'root-to-leaf', source: targetRoot, target: leafId, data: { relation: 'hierarchy' } }],
      },
    }, childHeaders)
    assert.equal(withLeaf.status, 200)
    const leaf = await api(`/api/maps/${target.id}/ai-delegations`, 'POST', {
      targetCardId: leafId, sourceRevision: withLeaf.body.map.version, strategy: 'new', instruction: '하위 구현을 검증하세요.', decisionReason: '독립 하위 업무입니다.', idempotencyKey: 'nested-leaf', newConversation: { agentId: 'claude', modelId: 'opus', workspace: projectDirectory },
    }, childHeaders)
    assert.equal(leaf.status, 202, JSON.stringify(leaf.body))
    dispatches.get(operationId).state = 'completed'
    await until(async () => (await api(`/api/groups/${groupId}`)).body.delegations.some((item) => item.state === 'waiting-document-work'), '하위 구현을 기다리지 않고 총괄에 완료를 보고했습니다.')
    assert.equal(calls.some((call) => /^group-first-wake-/.test(call.operationId)), false)
    dispatches.get('nested-leaf').state = 'completed'
    await until(async () => (await api(`/api/groups/${groupId}`)).body.delegations.some((item) => item.state === 'completed'), '총괄 결과 회수가 완료되지 않았습니다.')
    const finished = (await api(`/api/groups/${groupId}`)).body
    assert.match(finished.delegations[0].result, /문서 분석과 하위 업무 검증/)
    const wake = calls.find((call) => /^group-first-wake-\d+$/.test(call.operationId))
    assert.equal(wake.targetConversationId, 'group-parent')
    assert.ok(wake.instruction.includes(target.id))
    assert.ok(wake.instruction.includes(coordinatorId))
    assert.equal((await api('/api/maps/layout', 'PATCH', { documentLayout: movedLayout })).status, 200)
    assert.equal((await api(`/api/maps/${target.id}`)).body.groupProject, null)
  } finally {
    await stop(child)
    await new Promise((resolve) => fake.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
