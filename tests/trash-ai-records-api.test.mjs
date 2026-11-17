import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repository = path.resolve(import.meta.dirname, '..')
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}
const stores = [
  '_ai-attributions.json', '_ai-conversation-attributions.json', '_ai-conversation-origins.json',
  '_ai-delegations.json', '_group-document-instructions.json', '_ai-delegation-request-failures.json',
]
const relatedTo = (record, ids) => ['mapId', 'parentMapId', 'targetMapId'].some((key) => ids.includes(record[key]))

test('휴지통 영구 삭제는 해당 문서의 AI 기록을 지우고 무관한 문서는 재시작 뒤에도 보존한다', { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-trash-ai-records-'))
  const data = path.join(directory, 'data')
  await mkdir(data)
  const mapIds = ['map-trash-a', 'map-trash-b', 'map-retained']
  const now = new Date().toISOString()
  const writeJson = (name, value) => writeFile(path.join(data, name), `${JSON.stringify(value)}\n`, 'utf8')
  const readJson = async (name) => JSON.parse(await readFile(path.join(data, name), 'utf8'))
  for (const [index, id] of mapIds.entries()) {
    await writeJson(`${id}.json`, {
      id, title: `격리 문서 ${index + 1}`, version: 1, createdAt: now, updatedAt: now,
      ...(index < 2 ? { trashedAt: now } : {}),
      nodes: [
        { id: 'root', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', description: '보존 여부를 검증합니다.', aiConversationId: `chat-${index}` } },
        { id: 'task', position: { x: 300, y: 0 }, data: { kind: 'task', label: '업무', description: '', sharedKnowledge: '해당 문서의 공유 지식입니다.' } },
      ], edges: [{ id: 'edge', source: 'root', target: 'task' }],
    })
  }
  await writeJson('_ai-attributions.json', [...mapIds.map((mapId, index) => ({
    tokenHash: String(index + 1).repeat(64), expiresAt: Date.now() + 3600000,
    mapId, cardId: 'root', conversationId: `chat-${index}`, authorName: '격리 AI', userId: 'user-editor',
  })), { tokenHash: '4'.repeat(64), expiresAt: Date.now() + 3600000, conversationId: 'chat-0', authorName: '대화 전용 AI' }])
  await writeJson('_ai-conversation-attributions.json', [...mapIds.map((mapId, index) => ({
    mapId, cardId: 'root', conversationId: `chat-${index}`, authorName: '격리 AI', userId: 'user-editor',
  })), { mapId: mapIds[2], cardId: 'shared-link', conversationId: 'chat-0', authorName: '다른 문서의 대화 연결' }])
  await writeJson('_ai-conversation-origins.json', mapIds.map((mapId, index) => ({
    mapId, cardId: 'root', conversationId: `chat-${index}`, startedBy: 'user-editor', linkedAt: now,
  })))
  const scopes = [
    { id: 'target-a', mapId: mapIds[0], parentMapId: mapIds[2] },
    { id: 'parent-a', mapId: mapIds[2], parentMapId: mapIds[0] },
    { id: 'target-b', mapId: mapIds[1], parentMapId: mapIds[2] },
    { id: 'parent-b', mapId: mapIds[2], parentMapId: mapIds[1] },
    { id: 'retained', mapId: mapIds[2], parentMapId: mapIds[2] },
  ]
  await writeJson('_ai-delegations.json', scopes.map((scope) => ({
    ...scope, parentCardId: 'root', targetCardId: 'task', parentConversationId: `parent-${scope.id}`, targetConversationId: `target-${scope.id}`,
    state: scope.id === 'target-a' ? 'running' : 'completed', childStatus: 'completed', parentDispatchState: 'completed', startedBy: 'user-editor', createdAt: now, updatedAt: now,
    childResultSnapshot: '문서에 연결된 하위 AI 결과 전문', childResultFullSnapshot: '문서에 연결된 하위 AI 결과 전문',
    attemptHistory: [{ reason: '보존된 복구 이력', at: now }],
    integrationRecoveryRequest: { requestId: `recovery-${scope.id}`, status: 'failed', message: '통합 복구 기록', updatedAt: now },
  })))
  await writeJson('_group-document-instructions.json', scopes.map(({ id, mapId, parentMapId }) => ({
    id: `instruction-${id}`, parentMapId, targetMapId: mapId, parentCardId: 'root', targetCardId: 'task', parentConversationId: `parent-${id}`,
    state: 'replied', createdAt: now, updatedAt: now, instruction: '문서의 작업 지시 전문', reply: '문서의 결과 보고 전문',
  })))
  await writeJson('_ai-delegation-request-failures.json', scopes.map((scope) => ({
    ...scope, id: `failure-${scope.id}`, kind: 'request-failure', state: 'request-failed',
    parentCardId: 'root', targetCardId: 'task', parentConversationId: `parent-${scope.id}`,
    accepted: false, executionState: 'not-started', phase: 'preflight', reasonCode: 'ISOLATED_TEST',
    message: '문서의 위임 접수 실패 기록', createdAt: now, updatedAt: now,
  })))

  const externalWrites = []
  const upstream = createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) externalWrites.push({ method: request.method, path: request.url })
    const result = request.url === '/api/agents/management'
      ? [{ id: 'test-agent', name: '격리 AI', installed: true, enabled: true, available_models: { available_models: [{ value: 'test-model', name: '격리 모델' }] } }]
      : ['/api/providers', '/api/skills', '/api/mcp/servers'].includes(request.url) ? [] : { items: [], unavailable: true }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: true, data: result }))
  })
  const upstreamPort = await listen(upstream)
  const probe = createServer(), port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  let child, output = '', headers
  const start = async () => {
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, MNP_DATA_DIR: data, MNP_TOKEN_FILE: path.join(data, '_integration-token'),
        MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
        MNP_API_URL: base, MNP_AIONUI_URL: `http://127.0.0.1:${upstreamPort}`,
        MNP_AIONUI_DISCOVERY_FILE: path.join(directory, 'no-discovery.json'),
        MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'), MNP_MCP_USAGE_DISABLED: '1',
        MNP_AI_DELEGATION_POLL_INTERVAL_MS: '600000',
        MNP_ADMIN_EMAIL: 'trash-test@mind.local', MNP_ADMIN_PASSWORD: 'IsolatedTrash!2026', AIONUI_CONVERSATION_ID: '',
      },
    })
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* 격리 서버 시작 대기 */ }
      if (child.exitCode !== null) throw new Error(output)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`격리 서버 시작 실패: ${output}`)
  }
  const stop = async () => {
    if (child?.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await exited
    }
  }
  t.after(async () => {
    await stop()
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    assert.match(path.basename(directory), /^mnp-trash-ai-records-/)
    await rm(directory, { recursive: true, force: true })
  })
  const api = async (pathname, method = 'GET', body, requestHeaders = headers) => {
    const response = await fetch(base + pathname, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  await start()
  headers = { Authorization: `Bearer ${(await readFile(path.join(data, '_integration-token'), 'utf8')).trim()}`, 'X-MNP-AI-Editor-Id': 'user-admin', 'Content-Type': 'application/json' }
  const baseline = Object.fromEntries(await Promise.all(stores.map(async (store) => [store, await readJson(store)])))
  for (const store of stores) assert.ok(baseline[store].some((record) => relatedTo(record, [mapIds[0]])), `${store}: 기동 시 삭제 대상이 실제 로드되어야 한다.`)
  const originalRetainedMap = await readFile(path.join(data, `${mapIds[2]}.json`), 'utf8')
  const before = await api(`/api/maps/${mapIds[2]}/ai-delegations?includeResult=true`)
  assert.equal(before.status, 200)
  assert.equal(before.body.delegations.length, 5)
  assert.equal(before.body.requestFailures.length, 5)

  assert.equal((await api('/api/maps/trash', 'DELETE', { mapIds: [mapIds[0]] }, { 'Content-Type': 'application/json' })).status, 401)
  assert.equal((await api('/api/maps/trash', 'DELETE', { mapIds: [mapIds[2]] })).status, 404)
  const busy = await api('/api/maps/trash', 'DELETE', { mapIds: [mapIds[0]] })
  assert.equal(busy.status, 409)
  assert.equal(busy.body.code, 'TRASH_AI_WORK_BUSY')
  for (const store of stores) assert.deepEqual(await readJson(store), baseline[store], `${store}: 거부된 요청은 AI 기록을 변경하지 않는다.`)
  assert.ok(await readFile(path.join(data, `${mapIds[0]}.json`)), '실행 중인 문서의 원본도 보존한다.')
  await stop()
  await writeJson('_ai-delegations.json', baseline['_ai-delegations.json'].map((record) => record.id === 'target-a'
    ? { ...record, state: 'recovery-required', childStatus: 'interrupted' } : record))
  await start()

  const assertRemaining = async (deletedIds) => {
    for (const store of stores) {
      assert.deepEqual(await readJson(store), baseline[store].filter((record) => !relatedTo(record, deletedIds)), `${store}: 삭제 범위 밖 기록도 그대로 보존한다.`)
    }
    for (const id of deletedIds) {
      await assert.rejects(readFile(path.join(data, `${id}.json`)), { code: 'ENOENT' })
      const listed = await api(`/api/maps/${id}/ai-delegations?includeResult=true`)
      assert.equal(listed.status, 200)
      assert.deepEqual([listed.body.delegations, listed.body.requestFailures], [[], []], '문서 파일이 없어도 삭제된 AI 기록은 목록에 남지 않는다.')
      const instructions = await api(`/api/maps/${id}/group-document-instructions?includeContent=true`)
      assert.equal(instructions.status, 200)
      assert.deepEqual(instructions.body.instructions, [])
    }
    const retained = await api(`/api/maps/${mapIds[2]}/ai-delegations?includeResult=true`)
    assert.equal(retained.status, 200)
    assert.deepEqual(retained.body.delegations.map((record) => record.id).sort(), baseline['_ai-delegations.json'].filter((record) => !relatedTo(record, deletedIds)).map((record) => record.id).sort())
    assert.deepEqual(retained.body.requestFailures.map((record) => record.id).sort(), baseline['_ai-delegation-request-failures.json'].filter((record) => !relatedTo(record, deletedIds)).map((record) => record.id).sort())
    const instructions = await api(`/api/maps/${mapIds[2]}/group-document-instructions?includeContent=true`)
    assert.deepEqual(instructions.body.instructions.map((record) => record.id).sort(), baseline['_group-document-instructions.json'].filter((record) => record.parentMapId === mapIds[2] && !relatedTo(record, deletedIds)).map((record) => record.id).sort())
    assert.equal(await readFile(path.join(data, `${mapIds[2]}.json`), 'utf8'), originalRetainedMap)
  }
  const originalTrashMap = await readFile(path.join(data, `${mapIds[0]}.json`), 'utf8')
  const originsFile = path.resolve(data, '_ai-conversation-origins.json')
  const savedOriginsFile = path.resolve(data, '_ai-conversation-origins.fixture-backup')
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
  assert.match(path.basename(directory), /^mnp-trash-ai-records-/)
  for (const target of [originsFile, savedOriginsFile]) assert.equal(path.dirname(target), path.resolve(directory, 'data'))
  await rename(originsFile, savedOriginsFile)
  await mkdir(originsFile)
  try {
    const failed = await api('/api/maps/trash', 'DELETE', { mapIds: [mapIds[0]] })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.code, 'TRASH_AI_RECORD_CLEANUP_FAILED')
    assert.equal(await readFile(path.join(data, `${mapIds[0]}.json`), 'utf8'), originalTrashMap, 'AI 기록 쓰기 실패 시 문서 원문은 삭제하지 않는다.')
    assert.ok((await api('/api/maps/trash')).body.maps.some((map) => map.id === mapIds[0]), '실패한 문서는 휴지통에 남아 재시도할 수 있다.')
  } finally {
    await rm(originsFile, { recursive: true, force: true })
    await rename(savedOriginsFile, originsFile)
  }
  const restored = await api(`/api/maps/${mapIds[0]}/restore`, 'POST', {})
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  const attribution = await api('/api/integrations/aionui/attributions', 'POST', {
    agentId: 'test-agent', modelId: 'test-model', mapId: mapIds[0], cardId: 'root', workspace: directory, workspaceConfirmed: true,
  })
  assert.equal(attribution.status, 201, JSON.stringify(attribution.body))
  assert.ok((await readJson('_ai-attributions.json')).some((record) => record.mapId === mapIds[0] && record.agentId === 'test-agent'), '같은 프로세스에서 문서를 복원하면 새 AI 귀속을 정상 저장할 수 있다.')
  assert.equal((await api(`/api/maps/${mapIds[0]}`, 'DELETE')).status, 200)
  const deleted = await api('/api/maps/trash', 'DELETE', { mapIds: [mapIds[0]] })
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  assert.deepEqual(deleted.body.deletedIds, [mapIds[0]])
  await assertRemaining([mapIds[0]])
  assert.ok((await api('/api/maps/trash')).body.maps.some((map) => map.id === mapIds[1]), '선택하지 않은 휴지통 문서는 보존한다.')

  await stop()
  await start()
  await assertRemaining([mapIds[0]])
  const emptied = await api('/api/maps/trash', 'DELETE', { all: true })
  assert.equal(emptied.status, 200, JSON.stringify(emptied.body))
  assert.deepEqual(emptied.body.deletedIds, [mapIds[1]])
  await assertRemaining(mapIds.slice(0, 2))
  assert.deepEqual(externalWrites, [], 'MnP 기록 삭제는 실제 AI 대화나 외부 작업공간을 변경하지 않는다.')
})
