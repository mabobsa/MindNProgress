import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = (value) => createHash('sha256').update(value).digest('hex')
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

test('재시작 후 전달 기록을 복원하고, 실행 중인 상위 AI의 명시적 수신 확인과 유휴 시 자동 보고를 분리한다', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-report-receipt-'))
  const removeDirectory = async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mnp-report-receipt-')) throw new Error('테스트 임시 경로 검증 실패')
    await rm(directory, { recursive: true, force: true })
  }
  let parentBusy = true
  const dispatchRequests = []
  const operationReads = []
  const fake = createServer(async (request, response) => {
    const send = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: status === 200, data }))
    }
    if (request.url?.startsWith('/api/conversations/')) {
      const id = request.url.split('/')[3]
      return send({ id, type: 'acp', extra: {}, runtime: { state: id === 'parent-report' && parentBusy ? 'running' : 'idle', is_processing: id === 'parent-report' && parentBusy, turn_id: id === 'parent-report' && parentBusy ? 'parent-long-turn' : null } })
    }
    if (request.method === 'POST' && request.url === '/api/internal/external-conversation-dispatches') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      dispatchRequests.push(input)
      parentBusy = true
      return send({ operationId: input.operationId, conversationId: 'parent-report', state: 'running', turnId: 'new-report-turn' })
    }
    if (request.url?.startsWith('/api/internal/external-conversation-dispatches/')) {
      operationReads.push(request.url)
      return send({ state: 'recovery_required', errorMessage: 'interrupted_by_restart' })
    }
    return send({}, 404)
  })
  const fakePort = await listen(fake)
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let child
  let errors = ''
  let headers = {}
  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: projectDirectory, env: {
      ...process.env, MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
      MNP_AIONUI_URL: `http://127.0.0.1:${fakePort}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '100',
      MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'),
      MNP_ADMIN_EMAIL: 'report-test@mind.local', MNP_ADMIN_PASSWORD: 'ReportTest!2026',
    }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr.on('data', (chunk) => { errors += chunk })
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(baseUrl + '/api/health')).ok) return } catch { /* 테스트 서버 시작 대기 */ }
      await pause(50)
    }
    throw new Error(`테스트 서버 시작 실패: ${errors}`)
  }
  async function api(url, method = 'GET', body, extraHeaders = {}) {
    const response = await fetch(baseUrl + url, { method, headers: { ...headers, ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  async function until(read, predicate) {
    for (let i = 0; i < 100; i++) {
      const value = await read()
      if (predicate(value)) return value
      await pause(50)
    }
    throw new Error(`상태 전환 대기 실패: ${errors}`)
  }
  try {
    await start()
    const token = (await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()
    headers = { Authorization: `Bearer ${token}`, 'X-MNP-Editor-Id': 'user-editor', 'Content-Type': 'application/json' }
    const created = await api('/api/maps', 'POST', { title: '보고 수신 회귀', map: {
      nodes: [
        { id: 'parent-card', type: 'mind', position: { x: 0, y: 0 }, data: { label: '상위', kind: 'root', aiConversationId: 'parent-report', status: 'in-progress', progress: 50 } },
        { id: 'child-card', type: 'mind', position: { x: 300, y: 0 }, data: { label: '하위', kind: 'task', aiConversationId: 'child-report', status: 'done', progress: 100 } },
      ], edges: [{ id: 'edge', source: 'parent-card', target: 'child-card' }],
    } })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const mapId = created.body.map.id
    const mapUrl = `/api/maps/${mapId}`
    const listUrl = `${mapUrl}/ai-delegations`
    const base = {
      mapId, parentCardId: 'parent-card', parentCardLabel: '상위', targetCardId: 'child-card', targetCardLabel: '하위',
      parentConversationId: 'parent-report', targetConversationId: 'child-report',
      childStatus: 'completed', childTurnId: 'child-finished', childResultTurnId: 'child-finished',
      childResultSnapshot: '검증된 하위 결과', childResultHash: hash('검증된 하위 결과'),
      createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z',
      workspaceLease: { leaseId: 'old-lease' }, workspaceResult: { status: 'completed' },
    }
    const delivery = {
      state: 'waking-parent', wakeOperationId: 'old-wake', reportPayloadHash: hash('보존된 전달 전문'),
      reportResultAvailability: 'captured', reportResultHash: base.childResultHash, reportResultTurnId: base.childTurnId,
      parentTurnId: 'parent-long-turn', parentDispatchState: 'running',
    }
    await stop(child)
    child = null
    await writeFile(path.join(directory, '_ai-delegations.json'), JSON.stringify([
      { ...base, ...delivery, id: 'old-delivered' },
      { ...base, ...delivery, id: 'stopped-delivered', parentDispatchState: 'waiting-resume' },
      { ...base, id: 'pending-ack', state: 'waiting-parent' },
      { ...base, id: 'pending-auto', state: 'waiting-parent' },
    ]), 'utf8')
    await writeFile(path.join(directory, '_ai-conversation-origins.json'), JSON.stringify([
      { conversationId: 'parent-report', mapId, cardId: 'parent-card', startedBy: 'user-editor', linkedAt: base.createdAt },
      { conversationId: 'other-parent', mapId, cardId: 'parent-card', startedBy: 'user-editor', linkedAt: base.createdAt },
    ]), 'utf8')
    await start()
    headers['X-MNP-AI-Map-Id'] = mapId
    headers['X-MNP-AI-Card-Id'] = 'parent-card'
    headers['X-MNP-AI-Conversation-Id'] = 'parent-report'
    const list = async () => (await api(listUrl)).body.delegations
    const restored = await until(list, (items) => items.filter((x) => x.state === 'completed').length === 2 && items.find((x) => x.id === 'pending-ack')?.reportWaitReason === 'parent-busy')
    const beforeMap = (await api(mapUrl)).body.map
    assert.equal(dispatchRequests.length, 0, '상위 실행 중에는 추가 턴을 요청하지 않는다.')
    assert.equal(operationReads.length, 0, '재시작 전 확인된 전달을 만료된 operation으로 되돌리지 않는다.')
    assert.equal(restored.find((x) => x.id === 'old-delivered').reportPending, false)
    const plain = restored.find((x) => x.id === 'pending-ack')
    assert.equal(plain.result, undefined, '기본 목록에 긴 원문을 중복 포함하지 않는다.')
    const full = (await api(`${listUrl}?targetCardId=child-card&includeResult=true`)).body.delegations.find((x) => x.id === plain.id)
    assert.equal(full.result, base.childResultSnapshot)
    assert.equal(full.resultHash, base.childResultHash)
    assert.equal((await list()).find((x) => x.id === plain.id).state, 'waiting-parent', 'GET은 수신 확인이 아니다.')
    const ackUrl = `${listUrl}/${plain.id}/refresh`
    const ack = { expectedUpdatedAt: full.updatedAt, acknowledgeResultHash: full.resultHash }
    assert.equal((await api(ackUrl, 'POST', { ...ack, acknowledgeResultHash: hash('틀린 원문') })).status, 409)
    assert.equal((await api(ackUrl, 'POST', { ...ack, expectedUpdatedAt: 'stale' })).status, 409)
    assert.equal((await api(ackUrl, 'POST', ack, { 'X-MNP-AI-Conversation-Id': 'other-parent' })).status, 403)
    assert.equal((await api(ackUrl, 'POST', ack, { 'X-MNP-AI-Conversation-Id': '' })).status, 403)
    let result = await api(ackUrl, 'POST', ack)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.delegation.state, 'completed')
    assert.equal(result.body.delegation.reportReceipt.method, 'parent-acknowledged')
    assert.equal(result.body.executionRequested, false)
    result = await api(ackUrl, 'POST', { ...ack, expectedUpdatedAt: result.body.delegation.updatedAt })
    assert.equal(result.status, 200)
    assert.deepEqual((await api(mapUrl)).body.map, beforeMap, '수신 확인은 카드나 문서 버전을 변경하지 않는다.')
    assert.equal(dispatchRequests.length, 0)
    parentBusy = false
    const after = await until(list, (items) => items.every((x) => x.state === 'completed'))
    assert.equal(dispatchRequests.length, 1, '아직 미전달인 결과만 한 번 자동 전달한다.')
    assert.equal(dispatchRequests[0].targetConversationId, 'parent-report')
    assert.match(dispatchRequests[0].instruction, /acknowledgeResultHash/)
    assert.equal(after.find((x) => x.id === 'pending-auto').parentDispatchState, 'running')
    assert.equal(after.find((x) => x.id === 'pending-auto').reportPending, false)
    await stop(child)
    child = null
    await start()
    await pause(250)
    assert.equal(dispatchRequests.length, 1, '두 번째 재시작에서도 완료 보고를 중복 실행하지 않는다.')
    assert.deepEqual((await api(mapUrl)).body.map, beforeMap)
  } finally {
    await stop(child)
    await new Promise((resolve) => fake.close(resolve))
    await removeDirectory()
  }
})
