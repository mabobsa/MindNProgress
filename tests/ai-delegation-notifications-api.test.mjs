import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAiDelegationRequestSignature } from '../server/lib/aiDelegations.mjs'

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

test('사용자 완료 알림을 제거하면서 상위 보고를 유지하고, 검증된 복원본 저장 뒤에만 오래된 완료를 삭제한다', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-delegation-notification-'))
  const removeDirectory = async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mnp-delegation-notification-')) throw new Error('테스트 임시 경로 검증 실패')
    await rm(directory, { recursive: true, force: true })
  }
  const reportMessages = new Map()
  const dispatchRequests = []
  const fake = createServer(async (request, response) => {
    const send = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: status === 200, data }))
    }
    if (request.url === '/api/internal/external-conversation-dispatches/capabilities') return send({ historyOnlyReports: true, schemaVersion: 3, explicitCompletionAfterInterruption: true })
    if (request.method === 'POST' && request.url?.endsWith('/external-reports')) {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      const messageId = `external-report-${hash(input.operationId)}`
      reportMessages.set(input.operationId, { content: input.content, messageId })
      return send({ operationId: input.operationId, conversationId: 'parent-chat', messageId, contentHash: hash(input.content), executionRequested: false })
    }
    if (request.url?.startsWith('/api/conversations/')) {
      const id = request.url.split('/')[3]
      // 상위 대화는 실행 중이다. 사용자 알림을 제거해도 보고 대기와 원문 저장은 유지한다.
      const busy = id === 'parent-chat'
      return send({ id, type: 'acp', extra: {}, runtime: { state: busy ? 'running' : 'idle', is_processing: busy, turn_id: busy ? 'parent-turn' : null, pending_confirmations: 0 } })
    }
    if (request.method === 'POST' && request.url === '/api/internal/external-conversation-dispatches') {
      let body = ''
      for await (const chunk of request) body += chunk
      dispatchRequests.push(JSON.parse(body))
      return send({ operationId: 'unexpected', conversationId: 'parent-chat', state: 'running', turnId: 'unexpected-turn' })
    }
    if (request.url?.startsWith('/api/internal/external-conversation-dispatches/')) {
      // 진행 중인 하위 실행은 계속 running으로 관측된다.
      return send({ state: 'running', turnId: 'child-running-turn' })
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
      MNP_ADMIN_EMAIL: 'notification-test@mind.local', MNP_ADMIN_PASSWORD: 'NotifyTest!2026',
    }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr.on('data', (chunk) => { errors += chunk })
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(baseUrl + '/api/health')).ok) return } catch { /* 테스트 서버 시작 대기 */ }
      await pause(50)
    }
    throw new Error(`테스트 서버 시작 실패: ${errors}`)
  }
  async function api(url, method = 'GET', body) {
    const response = await fetch(baseUrl + url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
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
  const editorId = 'user-editor'
  await writeFile(path.join(directory, '_users.json'), JSON.stringify([{
    id: editorId, name: '위임 편집자', email: 'delegator@mind.local', role: 'editor', active: true,
    salt: '00', passwordHash: '00'.repeat(64),
  }]), 'utf8')
  try {
    await start()
    const token = (await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()
    headers = { Authorization: `Bearer ${token}`, 'X-MNP-AI-Editor-Id': editorId, 'Content-Type': 'application/json' }
    const created = await api('/api/maps', 'POST', { title: '위임 알림 회귀', map: {
      nodes: [
        { id: 'parent-card', type: 'mind', position: { x: 0, y: 0 }, data: { label: '상위 기능', kind: 'root', aiConversationId: 'parent-chat', status: 'in-progress', progress: 50 } },
        { id: 'child-card', type: 'mind', position: { x: 300, y: 0 }, data: { label: '완료된 하위', kind: 'task', aiConversationId: 'child-done', status: 'done', progress: 100 } },
        { id: 'busy-card', type: 'mind', position: { x: 300, y: 200 }, data: { label: '진행 중 하위', kind: 'task', aiConversationId: 'child-busy', status: 'in-progress', progress: 30 } },
      ],
      edges: [{ id: 'edge-1', source: 'parent-card', target: 'child-card' }, { id: 'edge-2', source: 'parent-card', target: 'busy-card' }],
    } })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const mapId = created.body.map.id
    const replayRequest = { idempotencyKey: 'delegation-expired', targetCardId: 'child-card', strategy: 'resume',
      conversationId: 'child-old', instruction: '이미 끝난 작업', decisionReason: '완료 상태 재조회', sourceRevision: 1 }
    const base = {
      mapId, parentCardId: 'parent-card', parentCardLabel: '상위 기능', parentConversationId: 'parent-chat',
      startedBy: editorId, createdAt: '2026-09-18T01:00:00.000Z', updatedAt: '2026-09-18T01:00:00.000Z',
    }
    await stop(child)
    child = null
    await writeFile(path.join(directory, '_ai-delegations.json'), JSON.stringify([
      {
        ...base, id: 'delegation-done', state: 'waiting-parent',
        targetCardId: 'child-card', targetCardLabel: '완료된 하위', targetConversationId: 'child-done',
        childStatus: 'completed', childTurnId: 'child-finished', childResultTurnId: 'child-finished',
        childResultSnapshot: '검증된 하위 결과', childResultHash: hash('검증된 하위 결과'),
        workspaceLease: { leaseId: 'done-lease' }, workspaceResult: { status: 'completed' },
      },
      {
        ...base, id: 'delegation-busy', state: 'running', childOperationId: 'child-busy-operation',
        targetCardId: 'busy-card', targetCardLabel: '진행 중 하위', targetConversationId: 'child-busy',
      },
      {
        ...base, id: 'delegation-expired', state: 'completed', completedAt: base.createdAt,
        requestSignature: createAiDelegationRequestSignature({ ...replayRequest, mapId, parentCardId: 'parent-card' }),
        targetCardId: 'child-card', targetConversationId: 'child-old', childStatus: 'completed',
        childResultSnapshot: '삭제 전에 복원본에 보존할 결과',
        childResultHash: hash('삭제 전에 복원본에 보존할 결과'),
        reportReceipt: { method: 'dispatch-delivered', at: base.createdAt, parentConversationId: 'parent-chat', resultHash: hash('삭제 전에 복원본에 보존할 결과') },
      },
    ]), 'utf8')
    await writeFile(path.join(directory, '_ai-conversation-origins.json'), JSON.stringify([
      { conversationId: 'parent-chat', mapId, cardId: 'parent-card', startedBy: editorId, linkedAt: base.createdAt },
    ]), 'utf8')
    const notificationFile = path.join(directory, '_notifications', `${editorId}.json`)
    await mkdir(path.dirname(notificationFile), { recursive: true })
    await writeFile(notificationFile, JSON.stringify([
      { id: 'old-completion', userId: editorId, type: 'ai-delegation-completed', mapId, createdAt: base.createdAt },
      { id: 'keep-mention', userId: editorId, type: 'mention', mapId, createdAt: base.createdAt },
      { id: 'old-checkpoint', userId: editorId, type: 'ai-delegation', mapId, createdAt: base.createdAt, readAt: null,
        dedupeKey: 'ai-delegation-checkpoint:delegation-expired:1', message: '체크포인트 자동 보완 요청' },
      { id: 'pending-report', userId: editorId, type: 'ai-delegation', mapId, createdAt: base.createdAt, readAt: base.createdAt,
        dedupeKey: 'ai-delegation-recovery:delegation-done:hash', message: '복구 필요' },
    ]))
    const backupDirectory = path.join(directory, '_completed-ai-cleanup-backups')
    await writeFile(backupDirectory, '복원본 저장 실패를 주입하는 파일')
    await start()
    assert.equal((await api('/api/health')).status, 200, '정리 실패로 운영 서버 기동이 중단되지 않는다')
    assert.ok(JSON.parse(await readFile(path.join(directory, '_ai-delegations.json'), 'utf8')).some((item) => item.id === 'delegation-expired'), '복원본 저장 실패 시 원본을 삭제하지 않는다')
    await stop(child); child = null
    await rm(backupDirectory)
    await start()
    const notifications = async () => (await api('/api/notifications')).body.notifications
    await pause(600)
    const settled = await notifications()
    assert.equal(settled.some((item) => item.type === 'ai-delegation-completed'), false)
    assert.ok(settled.some((item) => item.id === 'keep-mention'), '멘션 등 다른 사용자 알림을 유지한다')
    const resolved = settled.find((item) => item.id === 'old-checkpoint')
    assert.equal(resolved.delegationStatus.status, 'resolved', '완료 이력을 정리한 뒤에도 기존 알림은 완료 영수증으로 해결됨을 표시한다')
    assert.equal(resolved.readAt, null)
    assert.equal(resolved.message, '체크포인트 자동 보완 요청')
    assert.equal(settled.find((item) => item.id === 'pending-report').delegationStatus.status, 'report-pending')
    const markRead = await api('/api/notifications/old-checkpoint/read', 'PATCH')
    assert.equal(markRead.body.notification.delegationStatus.status, 'resolved')
    const readAll = await api('/api/notifications/read-all', 'POST')
    assert.equal(readAll.body.notifications.find((item) => item.id === 'old-checkpoint').delegationStatus.status, 'resolved')
    assert.equal(JSON.parse(await readFile(notificationFile, 'utf8')).find((item) => item.id === 'old-checkpoint').delegationStatus, undefined,
      '읽음 저장에 조회용 상태가 섞이지 않는다')
    assert.equal(settled.some((item) => item.nodeId === 'busy-card'), false)
    const delegations = (await api(`/api/maps/${mapId}/ai-delegations`)).body.delegations
    assert.equal(delegations.find((item) => item.id === 'delegation-done').state, 'waiting-parent', '상위 수신 전 기록은 삭제하지 않는다')
    assert.equal(delegations.find((item) => item.id === 'delegation-busy').state, 'running')
    assert.equal(delegations.some((item) => item.id === 'delegation-expired'), false)
    await until(async () => reportMessages.size, (size) => size > 0)
    assert.equal(dispatchRequests.length, 0, '알림 제거가 상위 busy 상태를 무시한 재실행을 만들지 않는다')
    const stored = JSON.parse(await readFile(path.join(directory, '_ai-delegations.json'), 'utf8'))
    const doneRecord = stored.find((item) => item.id === 'delegation-done')
    assert.equal(doneRecord.completedNotificationKey, undefined)
    assert.equal(stored.find((item) => item.id === 'delegation-busy').completedNotificationKey, undefined)
    const [backupFile] = await readdir(backupDirectory)
    const backup = JSON.parse(gunzipSync(await readFile(path.join(backupDirectory, backupFile))).toString('utf8'))
    assert.equal(backup.delegations.find((item) => item.id === 'delegation-expired').childResultSnapshot, '삭제 전에 복원본에 보존할 결과')
    const receipts = JSON.parse(await readFile(path.join(directory, '_ai-request-receipts.json'), 'utf8'))
    assert.ok(receipts.some((item) => item.id === 'delegation-expired'))
    assert.equal(receipts.some((item) => item.childResultSnapshot), false)
    headers['X-MNP-AI-Conversation-Id'] = 'parent-chat'
    const repeated = await api(`/api/maps/${mapId}/ai-delegations`, 'POST', replayRequest)
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body))
    assert.equal(repeated.body.repeated, true)
    assert.equal(repeated.body.executionRequested, false)
    assert.equal(repeated.body.delegation.historyDeleted, true)
    assert.equal((await api(`/api/maps/${mapId}/ai-delegations`, 'POST', { ...replayRequest, instruction: '다른 지시' })).status, 409)
    assert.equal(dispatchRequests.length, 0)
    await stop(child)
    child = null
    await start()
    await pause(600)
    assert.equal((await notifications()).some((item) => item.type === 'ai-delegation-completed'), false)
    assert.equal(JSON.parse(await readFile(notificationFile, 'utf8')).some((item) => item.id === 'old-completion'), false)
  } finally {
    await stop(child)
    await new Promise((resolve) => fake.close(resolve))
    await removeDirectory()
  }
})
