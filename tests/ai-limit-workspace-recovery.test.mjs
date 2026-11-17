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
  await assert.rejects(() => restarted.finalize(lease.leaseId, { childStatus: 'failed', childError: 'Selected model is at capacity. Please try a different model.' }))
  await restarted.reactivateQuarantinedLease(lease.leaseId, { ...scope, failureCategory: 'model-capacity' })
  assert.equal(restarted.state.leases[lease.leaseId].recoveryHistory.length, 3)
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

test('busy 격리 복구도 서버 거절 증거와 원 세션·Git 검사를 유지하며 변경을 보존한다', async t => {
  const { manager, scope, lease, worker } = await fixture(t)
  const errorMessage = `Conversation is busy: conversation ${scope.conversationId} is already running`
  await writeFile(path.join(worker, 'work.txt'), '보존할 미커밋 변경\n')
  await assert.rejects(manager.finalize(lease.leaseId, { childStatus: 'failed', childError: errorMessage }))
  const rejectedDispatch = { operationId: 'job-recover-1', state: 'failed', conversationId: scope.conversationId, errorMessage, workspaceLease: lease }
  const options = { ...scope, failureCategory: 'recovery-dispatch-busy', rejectedDispatch }
  for (const patch of [{ turnId: 'started-turn' }, { conversationId: 'foreign-chat' },
    { workspaceLease: { ...lease, jobId: 'foreign-job' } }]) {
    await assert.rejects(manager.reactivateQuarantinedLease(lease.leaseId, { ...options, rejectedDispatch: { ...rejectedDispatch, ...patch } }))
    assert.equal(manager.state.leases[lease.leaseId].status, 'quarantined')
  }
  await git(worker, 'switch', '-c', 'foreign-branch')
  await assert.rejects(manager.reactivateQuarantinedLease(lease.leaseId, options), /브랜치/)
  await git(worker, 'switch', lease.branch)
  const recovered = await manager.reactivateQuarantinedLease(lease.leaseId, options)
  assert.equal(recovered.leaseId, lease.leaseId)
  assert.equal(await readFile(path.join(worker, 'work.txt'), 'utf8'), '보존할 미커밋 변경\n')
  assert.equal(manager.state.leases[lease.leaseId].recoveryHistory.at(-1).type, 'rejected-recovery-dispatch')
})

for (const pending of [false, true]) test(`복구 API의 ${pending ? '응답 유실 후 조회' : '구버전 busy 격리'}는 거절을 작업 실패로 바꾸지 않고 같은 lease에서 다시 복구한다`,
  { concurrency: true, timeout: Number(process.env.MNP_REAL_GIT_TEST_TIMEOUT_MS) || 120_000 }, async t => {
    const { manager, scope, lease, worker, root, registryFile } = await fixture(t)
    const directory = path.join(root, 'server-data')
    await mkdir(directory)
    const errorMessage = `Conversation is busy: conversation ${scope.conversationId} is already running`
    await writeFile(path.join(worker, 'work.txt'), '보존할 작업 변경\n')
    await assert.rejects(manager.finalize(lease.leaseId, { childStatus: 'failed', childError: errorMessage }))
    const previousResult = structuredClone(manager.state.leases[lease.leaseId].result)
    if (pending) await manager.reactivateQuarantinedLease(lease.leaseId, { ...scope, failureCategory: 'model-capacity' })
    await writeFile(path.join(directory, '_workspace-pool.json'), JSON.stringify(manager.state))
    const now = new Date().toISOString()
    const wireLease = { workspaceId: lease.workspaceId, jobId: lease.jobId, leaseId: lease.leaseId, projectRoot: lease.projectRoot }
    const seed = { id: 'busy-recovery-test', mapId: 'map-a', parentCardId: 'parent-card', targetCardId: 'card-a',
      parentConversationId: 'parent-conversation', targetConversationId: scope.conversationId,
      childOperationId: 'busy-recovery-test-recover-1', childTurnId: null, childStatus: 'failed', childError: '통합하지 않았습니다.',
      strategy: 'resume', state: 'failed', workspaceLease: lease, workspaceResult: previousResult, startedBy: 'user-admin',
      createdAt: now, updatedAt: now, recoveryOperationId: 'busy-recovery-test-recover-1', recoveryAttempt: 1,
      attemptHistory: [{ operationId: 'original-task', childTurnId: 'original-turn', childError: '모델 용량 부족', result: '보존할 원 결과' }] }
    if (pending) Object.assign(seed, { state: 'waiting-model-capacity', childOperationId: 'original-task', childTurnId: 'original-turn',
      pendingRecovery: { operationId: seed.recoveryOperationId, attempt: 1, sourceState: 'waiting-model-capacity', workspaceLease: lease } })
    await writeFile(path.join(directory, '_ai-delegations.json'), JSON.stringify([seed]))
    const mapFile = path.join(directory, 'map-a.json')
    await writeFile(mapFile, JSON.stringify({ id: 'map-a', title: '복구 검증', version: 1, nodes: [
      { id: 'parent-card', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', aiConversationId: 'parent-conversation' } },
      { id: 'card-a', position: { x: 300, y: 0 }, data: { kind: 'task', label: '기존 작업', status: 'planned', progress: 0, isWork: true,
        description: '사용자 요구사항 원문', sharedKnowledge: '기존 결과 보존', aiConversationId: scope.conversationId } },
    ], edges: [{ id: 'edge', source: 'parent-card', target: 'card-a' }] }))
    let mismatch = !pending, busy = true
    const posted = [], receipts = new Map()
    const upstream = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
      const url = new URL(request.url, 'http://localhost')
      const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
      if (url.pathname.endsWith('/capabilities')) return send({ schemaVersion: 3, workspaceLeaseVersion: 2, explicitCompletionAfterInterruption: true })
      const operation = url.pathname.match(/^\/api\/internal\/external-conversation-dispatches\/([^/]+)$/)
      if (operation) return send(receipts.get(operation[1]) ?? { operationId: seed.recoveryOperationId, conversationId: scope.conversationId,
        state: 'failed', errorMessage, workspaceLease: { ...wireLease, ...(mismatch ? { jobId: 'foreign-job' } : {}) } })
      if (url.pathname === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
        posted.push(body)
        const receipt = { operationId: body.operationId, conversationId: body.targetConversationId, workspaceLease: wireLease,
          state: busy ? 'failed' : 'running', ...(busy ? { errorMessage } : { turnId: 'actual-recovery-turn' }) }
        receipts.set(body.operationId, receipt)
        return send(receipt, 202)
      }
      const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
      if (conversation) return send({ id: conversation[1], name: '복구 검증 대화', runtime: { state: 'idle', is_processing: false, pending_confirmations: 0 },
        extra: { agent_id: 'test-agent', current_model_id: 'test-model', workspace: worker } })
      if (url.pathname.endsWith('/messages')) return send({ items: [{ position: 'left', type: 'text', content: { content: '다른 수동 턴의 중간 답변' } }] })
      if (url.pathname === '/api/internal/conversation-runtimes/active') return send({ schema_version: 1, generated_at: Date.now(), items: [] })
      return send({}, 404)
    })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
    const baseUrl = `http://127.0.0.1:${port}`
    const server = spawn(process.execPath, ['server/index.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
        MNP_WORKSPACE_POOL_REGISTRY: registryFile, MNP_AIONUI_URL: `http://127.0.0.1:${upstream.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '3600000',
        MNP_ADMIN_PASSWORD: 'test-busy-password' } })
    let errors = ''; server.stderr.on('data', chunk => { errors += chunk })
    try {
      let ready = false
      for (let attempt = 0; attempt < 200; attempt++) {
        try { if ((await fetch(baseUrl + '/api/health')).ok) { ready = true; break } } catch { /* 준비 대기 */ }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.ok(ready, errors)
      // 시작 시 구버전 문서 정규화가 끝난 이후의 원문을 복구 동작과 비교한다.
      const originalMap = await readFile(mapFile, 'utf8')
      const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@mind.local', password: 'test-busy-password' }) })
      assert.equal(login.status, 200)
      const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
      const file = path.join(directory, '_ai-delegations.json')
      const saved = async () => JSON.parse(await readFile(file, 'utf8')).find(entry => entry.id === seed.id)
      const recover = async () => { const current = await saved(); return fetch(`${baseUrl}/api/maps/map-a/ai-delegations/${seed.id}/recover`, {
        method: 'POST', headers, body: JSON.stringify({ instruction: '완료된 검수는 반복하지 말고 마지막 체크포인트와 보고만 마무리하세요.',
          sourceRevision: 1, targetRevision: 1, expectedUpdatedAt: current.updatedAt, confirmApprovedScope: true }),
      }) }
      if (!pending) {
        const rejected = await recover()
        assert.equal(rejected.status, 409)
        assert.equal((await rejected.json()).code, 'AI_DELEGATION_RECOVERY_REJECTION_UNCONFIRMED')
        assert.equal(posted.length, 0)
        assert.equal((await saved()).state, 'failed')
        mismatch = false
      }
      const refused = await recover(), refusedBody = await refused.json()
      assert.equal(refused.status, 409, JSON.stringify({ refusedBody, errors }))
      assert.equal(refusedBody.code, 'AI_DELEGATION_RECOVERY_CONVERSATION_BUSY')
      const preserved = await saved()
      assert.equal(preserved.state, 'recovery-required')
      assert.equal(preserved.childOperationId, seed.childOperationId)
      assert.equal(preserved.childTurnId, seed.childTurnId)
      assert.equal(preserved.childResultSnapshot, undefined)
      assert.equal(preserved.recoveryDispatchRejection.executionStarted, false)
      assert.equal(posted.length, pending ? 0 : 1)
      assert.deepEqual(preserved.attemptHistory.slice(0, seed.attemptHistory.length), seed.attemptHistory)
      assert.equal(await readFile(path.join(worker, 'work.txt'), 'utf8'), '보존할 작업 변경\n')
      const beforeRefresh = await readFile(file, 'utf8')
      const refreshed = await fetch(`${baseUrl}/api/maps/map-a/ai-delegations/${seed.id}/refresh`, { method: 'POST', headers,
        body: JSON.stringify({ expectedUpdatedAt: preserved.updatedAt, sourceRevision: 1, targetRevision: 1 }) })
      assert.equal(refreshed.status, 200, JSON.stringify(await refreshed.json()))
      assert.equal(await readFile(file, 'utf8'), beforeRefresh, '상태 조회가 과거 오류·다른 수동 턴을 현재 실행으로 적용하지 않는다.')
      assert.equal(posted.length, pending ? 0 : 1)
      busy = false
      const resumed = await recover(), result = await resumed.json()
      assert.equal(resumed.status, 202, JSON.stringify({ result, errors }))
      assert.equal(result.delegation.childTurnId, 'actual-recovery-turn')
      assert.equal(result.delegation.workspaceLease.leaseId, lease.leaseId)
      assert.equal(result.delegation.targetConversationId, scope.conversationId)
      assert.equal((await saved()).recoveryDispatchRejection, null)
      assert.equal(await readFile(mapFile, 'utf8'), originalMap)
      assert.equal(await readFile(path.join(worker, 'work.txt'), 'utf8'), '보존할 작업 변경\n')
    } finally {
      if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped }
      upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
    }
  })

// Git 프로세스 실행이 느린 검증 환경에서만 예산을 늘린다. 기본 제한과 기능 검증은 유지한다.
for (const expired of [false, true]) test(`복구 API는 ${expired ? '실행 기록 만료 뒤 최초 전문으로' : '원본 실행 기록으로'} 기존 대화·lease를 찾아 미완료 확인만 전달한다`, { timeout: Number(process.env.MNP_REAL_GIT_TEST_TIMEOUT_MS) || 80_000 }, async (t) => {
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
    assert.ok(posted[0].instruction.includes(`- workspaceId: \`${lease.workspaceId}\``))
    assert.ok(posted[0].instruction.includes(`- jobId: \`${lease.jobId}\``))
    assert.ok(posted[0].instruction.includes(`- leaseId: \`${lease.leaseId}\``))
    assert.equal([...posted[0].instruction.matchAll(/^# 할당된 작업공간$/gm)].length, 1)
    assert.match(posted[0].instruction, /이번 전문의 `# 할당된 작업공간`에 기재된 현재 배정만 사용.*이전 경로·브랜치·lease를 복구 후보로 사용하지 마세요/s)
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
