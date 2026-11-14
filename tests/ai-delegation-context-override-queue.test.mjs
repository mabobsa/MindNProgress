import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { aiDelegationSelectionFromSource } from '../server/lib/aiDelegations.mjs'
import { AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED } from '../server/lib/aiConversationContextHealth.mjs'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim()
const projectDirectory = path.resolve(import.meta.dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const adminPassword = 'context-override-queue-password'

async function poolFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-context-override-queue-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const integration = path.join(root, 'integration')
  const worker = path.join(root, 'worker')
  const shared = path.join(root, 'shared')
  const dataDirectory = path.join(root, 'server-data')
  await mkdir(integration); await mkdir(shared); await mkdir(dataDirectory)
  await git(integration, 'init', '--initial-branch=main')
  await git(integration, 'config', 'user.name', 'Context Override Test')
  await git(integration, 'config', 'user.email', 'context-override@example.test')
  await writeFile(path.join(integration, '.gitignore'), '.ai-session.json\n.ai-workspace.json\n')
  await writeFile(path.join(integration, 'work.txt'), '원래 작업\n')
  await git(integration, 'add', '.')
  await git(integration, 'commit', '-m', '[김용민] 포화 예외 대기 검증 기준선', '-m', '[배경]\n격리된 테스트 저장소 구성\n[원인]\n대기 위임 시작 검증 기준선 필요\n[수정]\n초기 파일 생성')
  await git(root, 'clone', integration, worker)
  const registryFile = path.join(shared, 'workspaces.json')
  await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'test', sharedRoot: shared, workspaces: [
    { id: 'integration', root: integration, role: 'integration', enabled: true },
    { id: 'worker', root: worker, role: 'worker', enabled: true },
  ] }))
  return { integration, worker, registryFile, dataDirectory }
}

// 두 대화 모두 사용률 85%(포화, 예외 가능 구간)다. 실행 요청은 기록만 하고 실행 중으로 응답한다.
async function startAionUi(t, worker) {
  const posted = []
  const receipts = new Map()
  const effort = new Map()
  const models = new Map()
  const upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    const url = new URL(request.url, 'http://localhost')
    const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
    if (url.pathname.endsWith('/capabilities')) {
      return send({ schemaVersion: 3, workspaceLeaseVersion: 2, atomicWorkspaceRebind: true, releasesRuntimeOnTerminal: true, explicitCompletionAfterInterruption: true })
    }
    if (url.pathname === '/api/internal/conversation-runtimes/active') return send({ schema_version: 1, items: [] })
    if (url.pathname === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
      posted.push(body)
      const lease = body.workspaceLease
      const receipt = { operationId: body.operationId, conversationId: body.targetConversationId ?? 'new-primary', state: 'running', turnId: `turn-${posted.length}`,
        ...(lease ? { workspaceLease: { workspaceId: lease.workspaceId, jobId: lease.jobId, leaseId: lease.leaseId, projectRoot: lease.projectRoot } } : {}) }
      receipts.set(body.operationId, receipt)
      return send(receipt, 202)
    }
    const operation = url.pathname.match(/^\/api\/internal\/external-conversation-dispatches\/([^/]+)$/)
    if (operation) return receipts.has(decodeURIComponent(operation[1])) ? send(receipts.get(decodeURIComponent(operation[1]))) : send({}, 404)
    const configId = url.pathname.split('/')[3]
    if (url.pathname.endsWith('/runtime/ensure')) return send({ runtime: { state: 'idle' },
      config_options: [{ id: 'model', category: 'model', options: ['test-model', 'test-model-new'].map(value => ({ value })) },
        { id: 'effort', category: 'thought_level',
        options: (configId === 'target-runtime-failed' ? ['high'] : ['xhigh', 'high']).map(value => ({ value })) }] })
    if (url.pathname.endsWith('/runtime-config')) return send({ model: { value: models.get(configId) ?? 'test-model', source: 'runtime' },
      thought_level: { value: effort.get(configId) ?? 'high', source: 'runtime' } })
    if (request.method === 'PUT' && url.pathname.includes('/config-options/')) {
      if (url.pathname.endsWith('/model')) models.set(configId, body.value)
      else effort.set(configId, body.value)
      return send({ confirmation: 'observed' })
    }
    if (/^\/api\/conversations\/[^/]+\/usage$/.test(url.pathname)) return send({ used: 170_000, size: 200_000 })
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(url.pathname)) {
      return send({ items: [{ id: 'message-1', type: 'text', position: 'left', content: { content: '이전 작업 결과' } }], has_more_before: false })
    }
    const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (conversation) {
      return send({ id: decodeURIComponent(conversation[1]), name: '포화 예외 검증 대화', modified_at: '2026-10-30T00:00:00.000Z',
        runtime: { state: 'idle', is_processing: false, pending_confirmations: 0 },
        extra: { agent_id: 'test-agent', backend: 'codex', current_model_id: models.get(configId) ?? 'test-model', workspace: worker } })
    }
    return send({}, 404)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)) })
  return { port: upstream.address().port, posted, effort }
}

async function startServer({ dataDirectory, registryFile, upstreamPort, pollIntervalMs }) {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: projectDirectory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MNP_DATA_DIR: dataDirectory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
      MNP_WORKSPACE_POOL_REGISTRY: registryFile, MNP_AIONUI_URL: `http://127.0.0.1:${upstreamPort}`,
      MNP_AI_DELEGATION_POLL_INTERVAL_MS: String(pollIntervalMs), MNP_ADMIN_PASSWORD: adminPassword, MNP_MCP_USAGE_DISABLED: '1' } })
  let errors = ''
  child.stderr.on('data', (chunk) => { errors += chunk })
  const stop = async () => {
    if (child.exitCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exited
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 200 && !ready; attempt++) {
      try { ready = (await fetch(baseUrl + '/api/health')).ok } catch { /* 준비 대기 */ }
      if (!ready) await pause(100)
    }
    assert.ok(ready, errors)
    const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@mind.local', password: adminPassword }) })
    assert.equal(login.status, 200, errors)
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
    const get = async (pathname, { allowProcessing = false } = {}) => {
      const response = await fetch(baseUrl + pathname, { headers })
      const body = await response.json()
      if (allowProcessing && response.status === 503 && body.code === 'STORAGE_PROCESSING') return null
      assert.equal(response.status, 200, `${pathname}\n${errors}`)
      return body
    }
    return { get, stop, errors: () => errors }
  } catch (error) {
    await stop()
    throw error
  }
}

// 문맥 기준 재사용이 ON일 때만 의미가 있는 서버 경로라, OFF 동안에는 실행하지 않고 재활성화 때 다시 돌린다.
test('작업공간 대기 후 시작할 때 요청 때 인정한 포화 예외만 다시 인정하고 사유 없는 포화 대화는 시작하지 않는다', {
  timeout: Number(process.env.MNP_REAL_GIT_TEST_TIMEOUT_MS) || 120_000,
  skip: !AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED && '문맥 기준 재사용이 OFF라 실행하지 않는다(docs/ai-conversation-context-reuse.md)',
}, async (t) => {
  const { integration, worker, registryFile, dataDirectory } = await poolFixture(t)
  const aion = await startAionUi(t, worker)
  await writeFile(path.join(dataDirectory, 'map-a.json'), JSON.stringify({ id: 'map-a', title: '포화 예외 대기 검증', version: 1, nodes: [
    { id: 'parent-card', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', status: 'planned', progress: 0, aiConversationId: 'parent-conversation' } },
    { id: 'card-override', position: { x: 300, y: 0 }, data: { kind: 'task', label: '예외 이어가기', status: 'planned', progress: 0, isWork: true, aiConversationId: 'conversation-override' } },
    { id: 'card-plain', position: { x: 300, y: 200 }, data: { kind: 'task', label: '사유 없는 이어가기', status: 'planned', progress: 0, isWork: true, aiConversationId: 'conversation-plain' } },
  ], edges: [
    { id: 'edge-override', source: 'parent-card', target: 'card-override' },
    { id: 'edge-plain', source: 'parent-card', target: 'card-plain' },
  ] }))

  // 첫 실행에서 서버가 계산한 후보 평가를 받는다. 대기 위임은 자기 자신을 통계에서 빼므로 시작 때 같은 평가가 나온다.
  const assessments = {}
  const first = await startServer({ dataDirectory, registryFile, upstreamPort: aion.port, pollIntervalMs: 3_600_000 })
  try {
    for (const [cardId, conversationId] of [['card-override', 'conversation-override'], ['card-plain', 'conversation-plain']]) {
      const listed = await first.get(`/api/maps/map-a/cards/${cardId}/ai-conversations`)
      const contextHealth = listed.conversations.find((item) => item.conversationId === conversationId).contextHealth
      assert.equal(contextHealth.state, 'saturated', JSON.stringify(contextHealth))
      assert.equal(contextHealth.resumeAllowed, false)
      assert.equal(contextHealth.contextOverrideEligible, true)
      assessments[conversationId] = contextHealth.assessmentId
    }
  } finally {
    await first.stop()
  }
  assert.equal(aion.posted.length, 0)

  const instruction = '같은 업무의 남은 수정을 이어서 마무리하세요.'
  const contextOverride = { reasonCode: 'final-step', reason: '같은 위임의 마지막 검증과 보고만 남았습니다.', contextUsageRatio: 0.85,
    assessmentId: assessments['conversation-override'], appliedAt: '2026-10-30T00:00:00.000Z' }
  const queued = (id, targetCardId, targetConversationId, createdAt, extra = {}) => ({
    id, requestSignature: `signature-${id}`, mapId: 'map-a', parentCardId: 'parent-card', parentCardLabel: '상위',
    targetCardId, targetCardLabel: targetCardId, parentConversationId: 'parent-conversation', targetConversationId,
    childOperationId: id, strategy: 'resume', conversationAssessmentId: assessments[targetConversationId],
    decisionReason: '같은 업무의 후속 작업', sourceRevision: 1, instructionPreview: instruction,
    instructionHash: createHash('sha256').update(instruction).digest('hex'), state: 'waiting-workspace',
    resource: { kind: 'workspace_pool', key: 'test', projectRoot: integration }, startedBy: 'user-admin',
    pendingInstruction: instruction,
    // 서버가 대기 위임에 저장하는 것과 같은 정규화된 실행 환경이다.
    pendingSelection: aiDelegationSelectionFromSource({ agent: { id: 'test-agent', label: '검증 AI' }, model: { id: 'test-model', label: '검증 모델' }, workspace: worker }),
    pendingWorkspaceHint: integration, workspaceWaitStartedAt: createdAt, workspaceWaitReasonCode: 'AI_WORKSPACE_ALLOCATION_PENDING',
    createdAt, updatedAt: createdAt, ...extra,
  })
  await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify([
    queued('queued-override', 'card-override', 'conversation-override', '2026-10-30T00:00:01.000Z', { contextOverride }),
    queued('queued-plain', 'card-plain', 'conversation-plain', '2026-10-30T00:00:02.000Z'),
  ]))

  const second = await startServer({ dataDirectory, registryFile, upstreamPort: aion.port, pollIntervalMs: 200 })
  try {
    let delegations = []
    for (let attempt = 0; attempt < 300; attempt++) {
      delegations = (await second.get('/api/maps/map-a/ai-delegations')).delegations
      const started = delegations.filter((item) => ['queued-override', 'queued-plain'].includes(item.id) && item.state !== 'waiting-workspace')
      if (started.length === 2 && aion.posted.length > 0) break
      await pause(200)
    }
    const overridden = delegations.find((item) => item.id === 'queued-override')
    const plain = delegations.find((item) => item.id === 'queued-plain')
    assert.equal(plain.state, 'failed', JSON.stringify({ plain, errors: second.errors() }))
    assert.equal(plain.childStatus, 'rejected')
    assert.match(plain.childError, /포화 기준에 도달해 일반적인 새 위임은 새 대화로 시작해야 합니다\. 사용률이 90% 미만이므로/)
    assert.equal(plain.conversationContextHealth.state, 'saturated')
    assert.equal(plain.conversationContextHealth.assessmentId, assessments['conversation-plain'], '사유 없는 대화는 평가가 같아도 시작하지 않는다.')
    assert.notEqual(overridden.state, 'failed', JSON.stringify({ overridden, errors: second.errors() }))
    assert.notEqual(overridden.state, 'waiting-workspace')
    assert.equal(overridden.conversationContextHealth, undefined)
    assert.deepEqual(overridden.contextOverride, contextOverride, '요청 때 기록한 예외를 시작 뒤에도 그대로 보존한다.')
    const work = aion.posted.filter(item => item.targetConversationId !== 'parent-conversation')
    assert.equal(work.length, 1)
    assert.equal(work[0].strategy, 'resume')
    assert.equal(work[0].targetConversationId, 'conversation-override')
    assert.ok(work[0].workspaceLease?.leaseId, '대기 위임은 작업공간 lease를 받아 시작한다.')
  } finally {
    await second.stop()
  }
})

for (const strategy of ['resume', 'new']) test(`재시작한 하위 위임 대기열은 ${strategy} 실행 확인 후 담당을 저장하고 사용자 선택·모델 변경을 보존한다`, {
  timeout: Number(process.env.MNP_REAL_GIT_TEST_TIMEOUT_MS) || 120_000,
}, async (t) => {
  const { integration, worker, registryFile, dataDirectory } = await poolFixture(t)
  const aion = await startAionUi(t, worker)
  const names = ['changed', 'model-changed', ...(strategy === 'resume' ? ['runtime-failed'] : []), 'stable']
  const map = { id: 'map-primary', title: '하위 담당 대기열 검증', version: 1,
    nodes: [{ id: 'parent-card', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', aiConversationId: 'parent-conversation' } },
      ...names.map((name, index) => ({ id: name, position: { x: 300, y: index * 200 }, data: { kind: 'task', label: name,
        isWork: true, status: 'planned', progress: 0, aiConversationId: `old-${name}`,
        aiPrimaryConversationId: name === 'changed' ? `target-${name}` : `old-${name}`,
        aiConversations: [{ conversationId: `old-${name}` }, { conversationId: `target-${name}` }],
      } }))], edges: names.map(name => ({ id: `edge-${name}`, source: 'parent-card', target: name })) }
  await writeFile(path.join(dataDirectory, 'map-primary.json'), JSON.stringify(map))
  const first = await startServer({ dataDirectory, registryFile, upstreamPort: aion.port, pollIntervalMs: 3_600_000 })
  const assessments = {}
  try {
    for (const name of names) {
      const listed = await first.get(`/api/maps/map-primary/cards/${name}/ai-conversations`)
      assessments[name] = listed.conversations.find(item => item.conversationId === `target-${name}`).contextHealth.assessmentId
    }
  } finally { await first.stop() }
  const instruction = '담당 선택 대기열 검증 작업을 수행하세요.'
  const queued = names.map((name, index) => ({
    id: `queued-${name}`, requestSignature: `signature-${name}`, mapId: map.id, parentCardId: 'parent-card',
    targetCardId: name, parentConversationId: 'parent-conversation', targetConversationId: strategy === 'resume' ? `target-${name}` : '',
    childOperationId: `queued-${name}`, strategy, sourceRevision: 1, decisionReason: '담당 변경 검증',
    conversationAssessmentId: assessments[name], instructionHash: createHash('sha256').update(instruction).digest('hex'),
    state: 'waiting-workspace', resource: { kind: 'workspace_pool', key: 'test', projectRoot: integration }, startedBy: 'user-admin',
    pendingInstruction: instruction,
    pendingSelection: aiDelegationSelectionFromSource({ agent: { id: 'test-agent', label: '검증 AI' }, model: { id: 'test-model', label: '검증 모델' }, workspace: worker }),
    ...(strategy === 'resume' ? { resumeRuntimePolicy: { modelId: name === 'stable' ? 'test-model-new' : 'test-model', thoughtLevelId: 'xhigh', ...(name === 'stable' ? { backend: 'codex' } : {}) } } : {}),
    pendingWorkspaceHint: integration, workspaceWaitStartedAt: '2026-11-11T00:00:00.000Z',
    workspaceWaitReasonCode: 'AI_WORKSPACE_ALLOCATION_PENDING',
    createdAt: `2026-11-11T00:00:0${index}.000Z`, updatedAt: '2026-11-11T00:00:00.000Z',
    primarySelection: { expectedConversationId: `old-${name}`, modelId: name === 'model-changed' ? 'another-model' : 'test-model',
      strategy, conversationId: strategy === 'resume' ? `target-${name}` : null },
  })).filter(record => strategy === 'resume' || record.targetCardId !== 'model-changed')
  await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify(queued))
  const second = await startServer({ dataDirectory, registryFile, upstreamPort: aion.port, pollIntervalMs: 200 })
  try {
    let delegations
    // 사고 강도 거부 시 실제 Git 작업공간을 회수한 뒤 다음 작업을 배정하므로 전체 처리 시간을 기다린다.
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const result = await second.get('/api/maps/map-primary/ai-delegations', { allowProcessing: true })
      if (!result) { await pause(100); continue }
      delegations = result.delegations
      if (delegations.find(item => item.id === 'queued-stable')?.state === 'running'
        && delegations.filter(item => item.id !== 'queued-stable').every(item => item.state === 'failed' && item.reportStatus === 'received')) break
      await pause(100)
    }
    assert.equal(delegations.find(item => item.id === 'queued-changed').failureReasonCode, 'AI_DELEGATION_PRIMARY_CHANGED')
    if (strategy === 'resume') assert.equal(delegations.find(item => item.id === 'queued-model-changed').failureReasonCode, 'AI_DELEGATION_PRIMARY_MODEL_CHANGED')
    const stable = delegations.find(item => item.id === 'queued-stable')
    assert.equal(stable.state, 'running', JSON.stringify({ delegations, errors: second.errors() }))
    assert.equal(stable.linkError, null)
    const work = aion.posted.filter(item => item.targetConversationId !== 'parent-conversation')
    const notices = aion.posted.filter(item => item.targetConversationId === 'parent-conversation')
    assert.equal(work.length, 1)
    assert.equal(work[0].strategy, strategy)
    assert.equal(notices.length, queued.length - 1)
    for (const failed of delegations.filter(item => item.id !== 'queued-stable')) {
      assert.equal(failed.state, 'failed')
      assert.equal(failed.childStatus, 'rejected')
      assert.equal(failed.reportStatus, 'received')
      assert.equal(failed.reportPending, false)
      assert.equal(failed.reportReceipt.kind, 'startup-failure')
      assert.equal(failed.workCompleted, false)
      assert.equal(failed.workspaceWaitReasonCode, null)
      assert.equal(notices.filter(item => item.instruction.includes(`위임 ID: ${failed.id}\n`)).length, 1)
    }
    if (strategy === 'resume') {
      const runtimeFailed = delegations.find(item => item.id === 'queued-runtime-failed')
      assert.equal(runtimeFailed.failureReasonCode, 'AI_DELEGATION_POLICY_RUNTIME_UNSUPPORTED', JSON.stringify(runtimeFailed))
      assert.equal(aion.effort.has('target-runtime-failed'), false)
      assert.equal(aion.effort.get('target-stable'), 'xhigh')
      assert.equal(stable.runtimePolicyVerification.thoughtLevelId, 'xhigh')
      assert.equal(stable.runtimePolicyVerification.previousModelId, 'test-model')
      assert.equal(stable.runtimePolicyVerification.modelId, 'test-model-new')
    }
    const updated = (await second.get('/api/maps/map-primary')).map
    assert.equal(updated.nodes.find(node => node.id === 'stable').data.aiPrimaryConversationId, strategy === 'resume' ? 'target-stable' : 'new-primary')
    if (strategy === 'resume') assert.equal(updated.nodes.find(node => node.id === 'stable').data.aiConversations.find(link => link.conversationId === 'target-stable').model.id, 'test-model-new')
    assert.equal(updated.nodes.find(node => node.id === 'changed').data.aiPrimaryConversationId, 'target-changed')
    assert.equal(updated.nodes.find(node => node.id === 'stable').data.aiConversations.length, strategy === 'resume' ? 2 : 3)
  } finally { await second.stop() }
})
