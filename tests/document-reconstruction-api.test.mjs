import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { documentLifecycleBrowser } from './helpers/documentLifecycleBrowser.mjs'
import { reconstructionLayoutFixture } from './helpers/reconstructionLayoutFixture.mjs'

const root = path.resolve(import.meta.dirname, '..')
const node = (id, data = {}) => ({ id, type: 'mind', position: { x: 0, y: 0 }, data: { label: id, description: '한국어 요구사항을 보존합니다.', sharedKnowledge: '', kind: 'task', isWork: true, status: 'planned', progress: 0, ...data } })

test('보관·전환 HTTP/MCP 경로는 임시 서버에서 원본·댓글·이미지·Ref·권한·그룹·복원을 보존한다', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-lifecycle-api-'))
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const fakeAion = createHttpServer((request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: true, data: { unavailable: true } })) })
  await new Promise((resolve) => fakeAion.listen(0, '127.0.0.1', resolve))
  const env = { ...process.env, MNP_DATA_DIR: directory, MNP_TOKEN_FILE: path.join(directory, '_integration-token'), MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_API_URL: base, MNP_ADMIN_PASSWORD: 'TestOnly!2026', MNP_ADMIN_EMAIL: 'reconstruction-test@mind.local', MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'), MNP_MCP_USAGE_DISABLED: '1', AIONUI_CONVERSATION_ID: '', MNP_AIONUI_URL: 'http://127.0.0.1:1' }
  let child; let stderr = ''; let mcp
  env.MNP_AIONUI_URL = `http://127.0.0.1:${fakeAion.address().port}`
  env.MNP_AIONUI_DISCOVERY_FILE = path.join(directory, 'no-discovery.json')
  const stop = async () => { if (child?.exitCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await exited } }
  t.after(async () => {
    await mcp?.close(); await stop()
    await new Promise((resolve) => fakeAion.close(resolve))
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.match(path.basename(directory), /^mnp-lifecycle-api-/)
    await rm(directory, { recursive: true, force: true })
  })
  const start = async () => {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr.on('data', (value) => { stderr += value })
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + '/api/health')).ok) return } catch { /* 시작 대기 */ }
      if (child.exitCode !== null) throw new Error(stderr)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('시험 서버 시작 실패: ' + stderr)
  }
  await start()
  const headers = { Authorization: `Bearer ${(await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()}`, 'X-MNP-Editor-Id': 'user-editor', 'Content-Type': 'application/json' }
  const api = async (url, method = 'GET', body, customHeaders = headers) => {
    const res = await fetch(base + url, { method, headers: customHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: res.status, body: await res.json() }
  }
  const verifiedPreview = async (plan) => {
    let result = await api('/api/document-reconstructions/preview', 'POST', { plan })
    for (const action of ['measure-layout', 'verify-layout']) {
      assert.equal(result.status, 200, JSON.stringify(result.body))
      result = await api(`/api/document-reconstructions/${action}`, 'POST', { plan, previewHash: result.body.previewHash, measurements: reconstructionLayoutFixture(result.body) })
    }
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result
  }
  const waiting = [{ id: 'wait', label: '서버 계약 대기', note: '실제 API 미연결', resumeCondition: '계약 확정 후 연동 검증', since: '2026-09-10T00:00:00.000Z' }]
  const created = await api('/api/maps', 'POST', { title: 'v0.4 원본', map: { nodes: [node('root', { kind: 'root', isWork: false }), node('task', { checklist: [{ id: 'c1', text: '실제 계약을 검증한다', done: false }], waitingItems: waiting })], edges: [{ id: 'e1', source: 'root', target: 'task' }] } })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const source = created.body.map
  const comment = await api(`/api/maps/${source.id}/comments`, 'POST', { nodeId: 'task', summary: '[진행] 원문 댓글', detail: '보존할 상세 결론' })
  assert.equal(comment.status, 201, JSON.stringify(comment.body))
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const uploaded = await fetch(`${base}/api/maps/${source.id}/images`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: imageBytes })
  assert.equal(uploaded.status, 201)
  const image = (await uploaded.json()).image
  const refCreated = await api('/api/maps', 'POST', { title: '외부 참조', map: { nodes: [node('ref', { kind: 'root', isWork: false, reference: { mapId: source.id, nodeId: 'task' } })], edges: [] } })
  assert.equal(refCreated.status, 201)
  const sourcePath = path.join(directory, source.id + '.json')
  const commentsPath = path.join(directory, '_comments', source.id + '.json')
  const originalBytes = await readFile(sourcePath)
  const originalComments = await readFile(commentsPath)
  const groupId = 'group-reconstruction-test'
  let library = (await api('/api/maps')).body
  const layout = { version: 1, groups: [{ id: groupId, name: '실험 그룹', mapIds: [source.id] }], items: [{ type: 'group', id: groupId }, ...library.maps.filter((m) => m.id !== source.id).map((m) => ({ type: 'map', id: m.id }))] }
  assert.equal((await api('/api/maps/layout', 'PATCH', { documentLayout: layout })).status, 200)
  const context = await api(`/api/document-reconstructions/context?mapId=${source.id}`)
  assert.equal(context.status, 200)
  const plan = { id: 'compact-api', mode: 'compact', baseline: 'v0.4 유지', reason: '규모 정리 시험', sources: context.body.sources, targets: [{ key: 'next', title: '정리된 현재 업무', nodes: [node('root-next', { kind: 'root', isWork: false }), { ...structuredClone(source.nodes[1]), id: 'task-next' }], edges: [{ id: 'next-e1', source: 'root-next', target: 'task-next' }] }], decisions: [{ mapId: source.id, cardId: 'root', disposition: 'carry', reason: '기준 유지', targets: [{ key: 'next', cardId: 'root-next' }] }, { mapId: source.id, cardId: 'task', disposition: 'carry', reason: '미완료 조건 승계', targets: [{ key: 'next', cardId: 'task-next' }] }] }
  plan.groupBaselines = context.body.groupBaselines
  plan.targets.push({ key: 'guide', title: '새 문서 간 참조', nodes: [node('guide-root', { kind: 'root', isWork: false }), node('guide-ref', { isWork: false, reference: { targetKey: 'next', nodeId: 'task-next' } })], edges: [{ id: 'guide-edge', source: 'guide-root', target: 'guide-ref' }] })
  const requestBody = { mode: 'compact', mapIds: [source.id], baseline: plan.baseline, notes: '우클릭 정리 요청 시험', analysisOnly: true }
  const requestCreated = await api('/api/document-reconstructions/requests', 'POST', requestBody)
  assert.equal(requestCreated.status, 201, JSON.stringify(requestCreated.body))
  const requestId = requestCreated.body.id
  assert.equal((await api(`/api/document-reconstructions/requests/${requestId}/proposal`, 'POST', { baseRevision: 0, plan })).status, 200)
  assert.deepEqual(await readFile(sourcePath), originalBytes, '제안 제출은 원본을 변경하지 않는다')
  assert.deepEqual(await readFile(commentsPath), originalComments)
  assert.equal((await api(`/api/document-reconstructions/requests/${requestId}/proposal`, 'POST', { baseRevision: 0, plan })).status, 409, '오래된 제안함 덮어쓰기 금지')
  assert.deepEqual((await api(`/api/document-reconstructions/choices?mapId=${source.id}`)).body.documents.map((doc) => doc.id), [source.id])
  let preview = await api('/api/document-reconstructions/preview', 'POST', { plan })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal((await api('/api/maps/archive')).body.maps.length, 0)
  assert.equal((await api('/api/document-reconstructions/apply', 'POST', { plan, previewHash: preview.body.previewHash })).status, 400, '실제 승인 근거 필요')
  plan.approval = { statement: '임시 시험 전환안을 적용한다.', source: '자동 회귀 시험 입력' }
  assert.equal((await api('/api/document-reconstructions/apply', 'POST', { plan, previewHash: preview.body.previewHash })).body.code, 'RECONSTRUCTION_LAYOUT_REVIEW_REQUIRED')
  preview = await verifiedPreview(plan)
  const viewerLogin = await fetch(base + '/api/auth/viewer-access', { method: 'POST' })
  assert.equal(viewerLogin.status, 200)
  const viewerHeaders = { Cookie: viewerLogin.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  assert.equal((await api('/api/document-reconstructions/requests', 'POST', requestBody, viewerHeaders)).status, 403)
  assert.equal((await api(`/api/document-reconstructions/requests/${requestId}/proposal`, 'POST', { baseRevision: 1, plan }, viewerHeaders)).status, 403)
  assert.equal((await api('/api/document-reconstructions/apply', 'POST', { plan, previewHash: preview.body.previewHash }, viewerHeaders)).status, 403)
  assert.equal((await api(`/api/maps/${source.id}/archive`, 'PATCH', { baseVersion: source.version, baseLifecycleVersion: 0, archived: true }, viewerHeaders)).status, 403)
  const applied = await api('/api/document-reconstructions/apply', 'POST', { plan, previewHash: preview.body.previewHash })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  const nextId = applied.body.operation.targetMapIds[0]
  const guideId = applied.body.operation.targetMapIds[1]
  assert.deepEqual(await readFile(sourcePath), originalBytes)
  assert.deepEqual(await readFile(commentsPath), originalComments)
  assert.equal(applied.body.maps.some((m) => m.id === source.id), false)
  assert.deepEqual(applied.body.documentLayout.groups[0].mapIds, [nextId, guideId])
  const nextReference = (await api(`/api/maps/${guideId}`)).body
  assert.deepEqual(nextReference.unresolvedReferenceNodeIds, [])
  assert.deepEqual(nextReference.map.nodes[1].data.reference, { mapId: nextId, nodeId: 'task-next' })
  assert.equal((await api('/api/maps/archive', 'GET', undefined, viewerHeaders)).body.maps[0].id, source.id)
  assert.equal((await api(`/api/maps/${source.id}`)).body.map.version, source.version)
  assert.equal((await api(`/api/maps/${source.id}/comments?nodeId=task`)).body.comments[0].summary, '[진행] 원문 댓글')
  const readImage = await fetch(`${base}/api/maps/${source.id}/images/${image.assetId}`, { headers })
  assert.equal(readImage.status, 200); assert.deepEqual(Buffer.from(await readImage.arrayBuffer()), imageBytes)
  const resolved = (await api(`/api/maps/${refCreated.body.map.id}`)).body
  assert.deepEqual(resolved.unresolvedReferenceNodeIds, [])
  assert.equal(resolved.map.nodes[0].data.description, source.nodes[1].data.description)
  const nextMap = (await api(`/api/maps/${nextId}`)).body.map
  assert.equal(nextMap.nodes[1].data.waitingItems[0].resumeCondition, waiting[0].resumeCondition)
  assert.equal(nextMap.nodes[1].data.reconstructionSources[0].cardId, 'task')
  for (const [url, method, body] of [
    [`/api/maps/${source.id}`, 'PUT', { map: source, baseVersion: source.version }],
    [`/api/maps/${source.id}`, 'PATCH', { title: '보관 원문 변경 금지' }],
    [`/api/maps/${source.id}`, 'DELETE'],
    [`/api/maps/${source.id}/comments`, 'POST', { nodeId: 'task', summary: '추가 금지' }],
    [`/api/maps/${source.id}/comments/${comment.body.comment.id}`, 'DELETE'],
    [`/api/maps/${source.id}/images/${image.assetId}`, 'DELETE'],
    [`/api/maps/${source.id}/history/fake/restore`, 'POST', {}],
    [`/api/maps/${source.id}/ai-conversations`, 'POST', {}],
  ]) assert.equal((await api(url, method, body)).status, 409, method + ' ' + url)
  assert.equal((await api(`/api/maps/${source.id.replace('map-', '%6dap-')}/comments`, 'POST', { nodeId: 'task', summary: '인코딩 우회 금지' })).status, 409)
  assert.equal((await api('/api/maps/trash')).body.maps.length, 0)
  assert.equal((await api('/api/document-reconstructions/apply', 'POST', { plan, previewHash: preview.body.previewHash })).body.operation.id, plan.id)
  assert.equal((await api('/api/maps/layout', 'PATCH', { documentLayout: applied.body.documentLayout })).status, 200)
  if (process.env.MNP_BROWSER_TEST === '1') t.diagnostic(JSON.stringify(await documentLifecycleBrowser(base, directory, source.id, nextId)))
  await stop(); await start()
  assert.equal((await api('/api/maps/archive')).body.maps.some((map) => map.id === source.id), true)
  assert.equal((await api('/api/document-reconstructions/compact-api/rollback', 'POST', {})).status, 200)
  library = (await api('/api/maps')).body
  assert.deepEqual(library.documentLayout.groups[0].mapIds, [source.id], '정렬 저장과 재시작 뒤에도 원본 그룹 복원')
  assert.deepEqual(await readFile(sourcePath), originalBytes)
  // 새 MCP 도구의 실제 stdio 등록·직렬화·호출 확인. 실제 대화 get_context는 반복하지 않는다.
  mcp = new Client({ name: 'lifecycle-test', version: '1' })
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'], cwd: root, env, stderr: 'pipe' }))
  const tools = await mcp.listTools()
  for (const name of ['get_reconstruction_context', 'preview_reconstruction', 'apply_reconstruction', 'set_document_archive', 'rollback_reconstruction', 'get_reconstructions', 'list_archived_documents']) assert.equal(tools.tools.some((tool) => tool.name === 'mindnprogress_' + name), true)
  const mcpContext = await mcp.callTool({ name: 'mindnprogress_get_reconstruction_context', arguments: { mapIds: [source.id] } })
  assert.equal(mcpContext.isError, undefined, JSON.stringify(mcpContext))
  const mcpSourceContext = JSON.parse(mcpContext.content[0].text)
  const nextPlan = { ...plan, id: 'mcp-preview', sources: mcpSourceContext.sources, groupBaselines: mcpSourceContext.groupBaselines }
  const mcpPreview = await mcp.callTool({ name: 'mindnprogress_preview_reconstruction', arguments: { plan: nextPlan } })
  assert.equal(mcpPreview.isError, undefined, JSON.stringify(mcpPreview))
  assert.equal(typeof JSON.parse(mcpPreview.content[0].text).previewHash, 'string')
  const mcpRequest = await mcp.callTool({ name: 'mindnprogress_get_reconstruction_request', arguments: { requestId } })
  assert.equal(mcpRequest.isError, undefined, JSON.stringify(mcpRequest))
  assert.equal(JSON.parse(mcpRequest.content[0].text).revision, 1, '재시작 후 제안함 보존')
  const { approval: _unusedApproval, ...proposalPlan } = nextPlan
  const mcpSubmitted = await mcp.callTool({ name: 'mindnprogress_submit_reconstruction_proposal', arguments: { requestId, baseRevision: 1, plan: proposalPlan, editorId: 'user-editor' } })
  assert.equal(mcpSubmitted.isError, undefined, JSON.stringify(mcpSubmitted))
  assert.equal(JSON.parse(mcpSubmitted.content[0].text).revision, 2)
  // 총괄은 유지하고, 연결된 AI 상태를 확인할 수 없으면 보관하지 않는다.
  const group = await api(`/api/groups/${groupId}`, 'PATCH', { baseVersion: 0, createCoordinator: true })
  assert.equal(group.status, 200, JSON.stringify(group.body))
  const coordinator = group.body.coordinator
  const coordinatorMap = (await api(`/api/maps/${coordinator.id}`)).body.map
  const choices = (await api(`/api/document-reconstructions/choices?groupId=${groupId}`)).body.documents
  assert.equal(choices.find((doc) => doc.id === coordinator.id).excluded, true)
  assert.equal(choices.find((doc) => doc.id === source.id).excluded, false)
  assert.equal((await api('/api/document-reconstructions/requests', 'POST', { ...requestBody, mapIds: [coordinator.id] })).status, 409)
  assert.equal((await api(`/api/maps/${coordinator.id}/archive`, 'PATCH', { baseVersion: coordinatorMap.version, baseLifecycleVersion: 0, archived: true })).status, 409)
  const activeSource = (await api(`/api/maps/${source.id}`)).body.map
  activeSource.nodes[1].data.aiConversationId = 'unavailable-test-conversation'
  const aiLinked = (await api(`/api/maps/${source.id}`, 'PUT', { map: activeSource, baseVersion: activeSource.version })).body.map
  const blocked = await api(`/api/maps/${source.id}/archive`, 'PATCH', { baseVersion: aiLinked.version, baseLifecycleVersion: activeSource.lifecycleVersion, archived: true })
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body)); assert.equal(blocked.body.code, 'RECONSTRUCTION_AI_BUSY')
})
