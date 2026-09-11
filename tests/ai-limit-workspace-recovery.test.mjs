import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'
import { originalDelegationMessage } from './helpers/aiDelegationOriginalMessage.mjs'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim()

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-limit-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const integration = path.join(root, 'integration')
  const worker = path.join(root, 'worker')
  const shared = path.join(root, 'shared')
  await mkdir(integration); await mkdir(shared)
  await git(integration, 'init', '--initial-branch=main')
  await git(integration, 'config', 'user.name', 'Recovery Test')
  await git(integration, 'config', 'user.email', 'recovery@example.test')
  await writeFile(path.join(integration, '.gitignore'), '.ai-session.json\n.ai-workspace.json\n')
  await writeFile(path.join(integration, 'work.txt'), '원래 작업\n')
  await git(integration, 'add', '.')
  await git(integration, 'commit', '-m', '[김용민] 복구 검증 기준선', '-m', '[배경]\n격리된 테스트 저장소 구성\n[원인]\n복구 검증 기준선 필요\n[수정]\n초기 파일 생성')
  await git(root, 'clone', integration, worker)
  const registryFile = path.join(shared, 'workspaces.json')
  const stateFile = path.join(shared, 'state.json')
  await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'test', sharedRoot: shared, workspaces: [
    { id: 'integration', root: integration, role: 'integration', enabled: true },
    { id: 'worker', root: worker, role: 'worker', enabled: true },
  ] }))
  const createManager = () => new WorkspacePoolManager({ registryFile, stateFile })
  const manager = createManager()
  await manager.initialize()
  const scope = { workspaceHint: integration, mapId: 'map-a', cardId: 'card-a', conversationId: 'conversation-a', cardLabel: '중단 복구 검증' }
  const lease = await manager.acquire(scope)
  return { manager, createManager, scope, lease, worker, root, registryFile }
}

for (const dirty of [false, true]) test(`한도 중단은 ${dirty ? '미커밋 변경' : '변경 없는 세션'}을 재시작 뒤에도 보존하고 같은 lease로 재개한다`, async (t) => {
  const { manager, createManager, scope, lease, worker } = await fixture(t)
  const draft = '중단 시점의 수정\n'
  if (dirty) {
    await writeFile(path.join(worker, 'work.txt'), draft)
    await writeFile(path.join(worker, 'new.txt'), draft)
  }
  await assert.rejects(() => manager.finalize(lease.leaseId, { childStatus: 'failed', childError: 'usage limit exceeded' }))
  assert.equal(manager.state.leases[lease.leaseId].status, 'quarantined')
  assert.equal(manager.recoverableIdleWorkspaceState('worker'), false)
  const restarted = createManager()
  await restarted.initialize()
  assert.equal(restarted.state.leases[lease.leaseId].status, 'quarantined')
  await assert.rejects(() => restarted.acquire({ ...scope, conversationId: 'another-conversation' }))
  assert.equal(JSON.parse(await readFile(path.join(worker, '.ai-session.json'), 'utf8')).leaseId, lease.leaseId)
  const resumed = await restarted.reactivateQuarantinedLease(lease.leaseId, { ...scope, failureCategory: 'usage-limit' })
  assert.equal(resumed.leaseId, lease.leaseId)
  const repeated = await restarted.reactivateQuarantinedLease(lease.leaseId, { ...scope, failureCategory: 'usage-limit' })
  assert.equal(repeated.leaseId, lease.leaseId, '재개 요청 저장 전 장애가 같은 lease 복구를 막았습니다.')
  assert.equal(await git(worker, 'branch', '--show-current'), lease.branch)
  if (dirty) {
    assert.equal(await readFile(path.join(worker, 'work.txt'), 'utf8'), draft)
    assert.equal(await readFile(path.join(worker, 'new.txt'), 'utf8'), draft)
  }
  await assert.rejects(() => restarted.finalize(lease.leaseId, { childStatus: 'failed', childError: 'too many requests' }))
  await restarted.reactivateQuarantinedLease(lease.leaseId, { ...scope, failureCategory: 'rate-limit' })
  assert.equal(restarted.state.leases[lease.leaseId].recoveryHistory.length, 2)
})

test('구버전에서 변경 없이 반납한 한도 중단은 풀에서 복구용 lease를 한 번만 배정한다', async (t) => {
  const { manager, createManager, scope, lease } = await fixture(t)
  await manager.finalize(lease.leaseId, { childStatus: 'failed', childError: 'legacy failure' })
  const previous = manager.state.leases[lease.leaseId]
  previous.result.childError = 'usage limit exceeded'
  await manager.persist()
  const replacement = await manager.acquire({ ...scope, replacesLeaseId: lease.leaseId })
  assert.notEqual(replacement.leaseId, lease.leaseId)
  const restarted = createManager()
  await restarted.initialize()
  const repeated = await restarted.acquire({ ...scope, replacesLeaseId: lease.leaseId })
  assert.equal(repeated.leaseId, replacement.leaseId)
  await assert.rejects(() => restarted.acquire({ ...scope, cardId: 'another-card', replacesLeaseId: lease.leaseId }))
  assert.equal(restarted.state.leases[lease.leaseId].result.status, 'failed-clean')
})

test('응답 검증으로 격리된 미연결 실행은 네 필드와 실제 Git·세션 검증 후 같은 lease를 복구한다', async (t) => {
  const { manager, scope, lease, worker } = await fixture(t)
  manager.state.leases[lease.leaseId].conversationId = null
  const sessionFile = path.join(worker, '.ai-session.json')
  const session = JSON.parse(await readFile(sessionFile, 'utf8'))
  await writeFile(sessionFile, JSON.stringify({ ...session, conversationId: null }))
  await manager.quarantine(lease.leaseId, '실행 응답 검증 실패')
  const options = { ...scope, failureCategory: 'confirmed-dispatch', confirmedDispatchLease: {
    workspaceId: lease.workspaceId, jobId: lease.jobId, leaseId: lease.leaseId, projectRoot: lease.projectRoot,
  } }
  await assert.rejects(() => manager.reactivateQuarantinedLease(lease.leaseId, { ...options, confirmedDispatchLease: { ...options.confirmedDispatchLease, jobId: 'other-job' } }))
  await git(worker, 'switch', '-c', 'unexpected-branch')
  await assert.rejects(() => manager.reactivateQuarantinedLease(lease.leaseId, options), /브랜치/)
  await git(worker, 'switch', lease.branch)
  const recovered = await manager.reactivateQuarantinedLease(lease.leaseId, options)
  assert.equal(recovered.leaseId, lease.leaseId)
  assert.equal(manager.state.leases[lease.leaseId].conversationId, scope.conversationId)
  assert.equal(JSON.parse(await readFile(sessionFile, 'utf8')).conversationId, scope.conversationId)
  assert.equal(manager.state.leases[lease.leaseId].recoveryHistory.at(-1).type, 'confirmed-dispatch')
  assert.equal(await git(worker, 'status', '--porcelain'), '')
})

for (const expired of [false, true]) test(`복구 API는 ${expired ? '실행 기록 만료 뒤 최초 전문으로' : '원본 실행 기록으로'} 기존 대화·lease를 찾아 미완료 확인만 전달한다`, { timeout: 80_000 }, async (t) => {
  const { manager, scope, lease, worker, root, registryFile } = await fixture(t)
  const dataDirectory = path.join(root, 'server-data')
  await mkdir(dataDirectory)
  manager.state.leases[lease.leaseId].conversationId = null
  const sessionFile = path.join(worker, '.ai-session.json')
  const session = JSON.parse(await readFile(sessionFile, 'utf8'))
  await writeFile(sessionFile, JSON.stringify({ ...session, conversationId: null }))
  await manager.quarantine(lease.leaseId, '실행 응답 검증 실패')
  // 구버전에는 보존 표식이 없었다. 서버가 미연결 위임 기록으로 복원해야 한다.
  delete manager.state.leases[lease.leaseId].executionUnconfirmed
  await writeFile(path.join(dataDirectory, '_workspace-pool.json'), JSON.stringify(manager.state))
  const wireLease = { workspaceId: lease.workspaceId, jobId: lease.jobId, leaseId: lease.leaseId, projectRoot: lease.projectRoot }
  const now = new Date().toISOString()
  const delegation = { id: 'original-operation', mapId: 'map-a', parentCardId: 'parent-card', targetCardId: 'card-a',
    parentConversationId: 'parent-conversation', targetConversationId: '', childOperationId: 'original-operation',
    strategy: 'new', state: 'recovery-required', workspaceLease: lease, startedBy: 'user-admin',
    createdAt: now, updatedAt: now, childError: 'AionCore 작업공간 lease 불일치', recoveryRequiredAt: now,
    pendingSelection: { agent: { id: 'test-agent', label: '검증 AI' }, model: { id: 'test-model', label: '검증 모델' }, workspace: worker },
    pendingInstruction: '분석만 수행하고 구현은 하지 마세요.',
  }
  delegation.instructionHash = createHash('sha256').update(delegation.pendingInstruction).digest('hex')
  const originalMessage = originalDelegationMessage(delegation)
  await writeFile(path.join(dataDirectory, '_ai-conversation-origins.json'), JSON.stringify([
    { conversationId: scope.conversationId, mapId: delegation.mapId, cardId: delegation.targetCardId, startedBy: delegation.startedBy, linkedAt: now },
  ]))
  await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify([delegation]))
  await writeFile(path.join(dataDirectory, 'map-a.json'), JSON.stringify({ id: 'map-a', title: '복구 검증', version: 1,
    nodes: [{ id: 'parent-card', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', status: 'planned', progress: 0, aiConversationId: 'parent-conversation' } },
      { id: 'card-a', position: { x: 300, y: 0 }, data: { kind: 'task', label: '분석', status: 'done', progress: 100, isWork: true, sharedKnowledge: '완료된 분석 결과 보존' } }],
    edges: [{ id: 'edge', source: 'parent-card', target: 'card-a' }] }))
  const posted = []
  let mismatch = true
  let wrongDirectory = false
  let incompleteMessages = false
  const messageRequests = []
  const upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    const url = new URL(request.url, 'http://localhost')
    const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
    if (url.pathname.endsWith('/capabilities')) return send({ schemaVersion: 3, workspaceLeaseVersion: 2, explicitCompletionAfterInterruption: true })
    if (url.pathname === '/api/internal/external-conversation-dispatches/original-operation') return expired ? send({}, 404)
      : send({ operationId: 'original-operation', conversationId: scope.conversationId,
        state: 'completed', turnId: 'original-turn', workspaceLease: { ...wireLease, ...(mismatch ? { jobId: 'unrelated-job' } : {}) } })
    if (url.pathname === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
      posted.push(body)
      return send({ operationId: body.operationId, conversationId: body.targetConversationId, state: 'running', workspaceLease: wireLease, turnId: 'recovery-turn' }, 202)
    }
    const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (conversation) return send({ id: conversation[1], created_at: originalMessage.created_at - 1, runtime: { state: 'idle', isProcessing: false, pendingConfirmations: 0 },
      extra: { agent_id: 'test-agent', current_model_id: 'test-model', workspace: wrongDirectory ? dataDirectory : worker } })
    if (url.pathname === `/api/conversations/${scope.conversationId}/messages`) {
      messageRequests.push(url.searchParams.get('before'))
      if (incompleteMessages) return send({ items: [originalMessage] })
      if (!url.searchParams.has('before')) return send({ items: [{ id: 'latest', type: 'text', position: 'left', created_at: originalMessage.created_at + 2000 }], has_more_before: true, oldest_cursor: 'previous-page' })
      const message = structuredClone(originalMessage)
      if (mismatch) message.content.content += '\n승인되지 않은 추가 구현'
      return send({ items: [message], has_more_before: false })
    }
    if (url.pathname === '/api/internal/conversation-runtimes/active') return send({ items: [] })
    return send({}, 404)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let errors = ''
  const server = spawn(process.execPath, ['server/index.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MNP_DATA_DIR: dataDirectory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
      MNP_WORKSPACE_POOL_REGISTRY: registryFile, MNP_AIONUI_URL: `http://127.0.0.1:${upstream.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '60000',
      MNP_ADMIN_PASSWORD: 'test-recovery-password' } })
  server.stderr.on('data', (chunk) => { errors += chunk })
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(baseUrl + '/api/health')).ok) { ready = true; break } } catch { /* 준비 대기 */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(ready, errors)
    const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mind.local', password: 'test-recovery-password' }) })
    assert.equal(login.status, 200)
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
    const endpoint = baseUrl + '/api/maps/map-a/ai-delegations/original-operation/recover'
    const input = { instruction: '완료된 분석은 반복하지 말고 기존 결과를 확인한 뒤 변경 없음 확인과 완료 보고만 수행하세요.', sourceRevision: 1, targetRevision: 1, expectedUpdatedAt: now, confirmApprovedScope: true }
    const rejected = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) })
    assert.equal(rejected.status, 409, JSON.stringify(await rejected.json()))
    assert.equal(posted.length, 0)
    if (expired) {
      assert.deepEqual(messageRequests.slice(0, 2), [null, 'previous-page'], '최초 페이지까지 확인해야 한다.')
      incompleteMessages = true
      const incomplete = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) })
      assert.equal(incomplete.status, 409)
      assert.equal(posted.length, 0)
      incompleteMessages = false
    }
    mismatch = false
    wrongDirectory = true
    const wrongCwd = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) })
    assert.equal(wrongCwd.status, 409)
    assert.match((await wrongCwd.json()).error, expired ? /확증하지 못했습니다/ : /실제 작업 디렉토리/)
    assert.equal(posted.length, 0)
    const unchangedMap = JSON.parse(await readFile(path.join(dataDirectory, 'map-a.json'), 'utf8'))
    assert.equal(unchangedMap.version, 1)
    assert.equal(unchangedMap.nodes.find((node) => node.id === 'card-a').data.aiConversationId, undefined)
    assert.equal(JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8')).leases[lease.leaseId].status, 'quarantined')
    wrongDirectory = false
    const recovered = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) })
    const result = await recovered.json()
    assert.equal(recovered.status, 202, JSON.stringify({ result, errors, lease: JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8')).leases[lease.leaseId] }))
    assert.equal(posted.length, 1)
    assert.equal(posted[0].strategy, 'resume')
    assert.equal(posted[0].targetConversationId, scope.conversationId)
    assert.equal(posted[0].workspaceLease.leaseId, lease.leaseId)
    assert.ok(posted[0].instruction.includes(input.instruction))
    assert.equal(result.delegation.targetConversationId, scope.conversationId)
    assert.equal(result.delegation.dispatchRecoveryProof.kind, expired ? 'original-message-after-operation-expiry' : 'original-operation')
    if (expired) assert.equal(result.delegation.dispatchRecoveryProof.messageId, originalMessage.id)
    const savedMap = JSON.parse(await readFile(path.join(dataDirectory, 'map-a.json'), 'utf8'))
    const target = savedMap.nodes.find((node) => node.id === 'card-a')
    assert.equal(target.data.sharedKnowledge, '완료된 분석 결과 보존')
    assert.equal(target.data.aiConversationId, scope.conversationId)
    assert.equal(target.data.status, 'done')
  } finally {
    if (server.exitCode === null) { const stopped = new Promise((resolve) => server.once('exit', resolve)); server.kill(); await stopped }
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
  }
})
