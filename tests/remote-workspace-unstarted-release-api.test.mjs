import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { remoteWorkspaceFixture } from './helpers/remote-workspace-fixture.mjs'
import { isolatedBundledRunner } from './helpers/isolated-runner.mjs'
import { git, saveJson } from '../server/lib/remoteWorkspaceProtocol.mjs'
import { hashMachineToken } from '../server/lib/subMachines.mjs'

// 실제 MnP HTTP·저장소, 실제 내장 Runner bundle, 실제 workspace agent와 임시 Git을 연결한다.
// Core만 격리 모의 서버이며 운영 대화·registry·descriptor·인증을 사용하지 않는다.
const runnerEntry = process.env.MNP_BUNDLED_RUNNER_TEST_ENTRY
const skip = !runnerEntry && 'MNP_BUNDLED_RUNNER_TEST_ENTRY에 검증한 내장 Runner bundle의 절대 경로를 지정해야 합니다.'
const password = 'UnstartedRelease!2026'
const mapId = 'map-bench-0', parentId = 'parent-release', childId = 'child-release'
const failure = '대상 대화의 위임 규칙 적용·확인에 실패해 작업을 시작하지 않았습니다.'
const idle = { state: 'idle', is_processing: false, pending_confirmations: 0, can_send_message: true, turn_id: null }
const options = (...values) => values.map(value => ({ value, name: value }))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(read, accept, label) {
  let value
  for (let attempt = 0; attempt < 300; attempt++) {
    value = await read()
    if (accept(value)) return value
    await wait(100)
  }
  assert.fail(`${label}: ${JSON.stringify(value)}`)
}

function delegationRecord(lease, patch = {}) {
  const now = new Date().toISOString()
  return { id: lease.requestId, mapId, parentCardId: 'card-0', targetCardId: 'card-1', parentConversationId: parentId,
    parentHomeMachineId: 'isolated-storage', targetConversationId: childId, targetHomeMachineId: 'macbook', startedBy: 'user-editor',
    state: 'failed', childStatus: 'rejected', strategy: 'resume', childOperationId: lease.requestId, childError: failure,
    failureReasonCode: 'AI_DELEGATION_POLICY_RUNTIME_UNAVAILABLE', workspaceLease: lease, reportStatus: 'received',
    createdAt: now, updatedAt: now, ...patch }
}

async function environment(t, { prepare = async () => ({ delegations: [] }), env = {} } = {}) {
  const f = await remoteWorkspaceFixture(t, { mapId, cardId: 'card-1', conversationId: childId })
  const prepared = await prepare(f)
  const calls = [], dispatches = []
  const core = { lookup: 'missing' }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    calls.push({ method: req.method, path: req.url })
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    const ok = data => send({ success: true, data })
    if (req.url === '/api/internal/conversation-runtimes/active') return ok({ items: [] })
    if (req.url.endsWith('/capabilities')) return ok({ schemaVersion: 3, workspaceLeaseVersion: 3, remoteWorkspaceOwnership: true,
      atomicWorkspaceRebind: true, releasesRuntimeOnTerminal: true, explicitCompletionAfterInterruption: true })
    if (req.url === '/api/internal/external-conversation-dispatches' && req.method === 'POST') {
      dispatches.push(body)
      return ok({ operationId: body.operationId, conversationId: childId, state: 'running', turnId: 'unexpected', workspaceLease: body.workspaceLease })
    }
    if (req.url.startsWith('/api/internal/external-conversation-dispatches/')) {
      if (core.lookup === 'exists') return ok({ operationId: req.url.split('/').at(-1), conversationId: childId, state: 'failed' })
      if (core.lookup === 'error') return send({ success: false, error: { code: 'INTERNAL_ERROR', message: '격리 조회 실패' } }, 500)
      return send({ success: false, error: { code: 'EXTERNAL_DISPATCH_NOT_FOUND', message: '격리된 실행 기록이 없습니다.' } }, 404)
    }
    if (req.url === '/api/agents/management') return ok([{ id: 'codex', name: 'Codex CLI', backend: 'codex', installed: true, enabled: true,
      available_models: { available_models: options('gpt-6.1-sol') }, available_modes: { available_modes: options('full-access') },
      config_options: [{ category: 'thought_level', options: options('xhigh') }] }])
    if (req.url === `/api/conversations/${childId}/runtime/ensure`) {
      return send({ success: false, error: { code: 'FORBIDDEN', message: '격리 정책 준비 거부' } }, 403)
    }
    if (req.url.startsWith('/api/conversations/')) {
      const id = req.url.split('/')[3]
      return ok({ id, name: id, type: 'acp', extra: { agent_id: 'codex', backend: 'codex', current_model_id: 'gpt-6.1-sol', workspace: f.integration },
        runtime: idle })
    }
    return ok([])
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const selection = { agent: { id: 'codex', label: 'Codex CLI' }, model: { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
    thoughtLevel: { id: 'xhigh', label: 'xhigh' }, mode: { id: 'full-access', label: 'full-access' }, workspace: f.integration }
  const api = await storageApi(t, { documents: 1, env: { MNP_WORKSPACE_POOL_REGISTRY: path.join(f.root, 'local.json'), ...env },
    seed: async ({ data }) => {
      const users = JSON.parse(await readFile(path.join(data, '_users.json'), 'utf8'))
      for (const user of users) user.passwordHash = scryptSync(password, user.salt, 64).toString('hex')
      await writeFile(path.join(data, '_users.json'), JSON.stringify(users))
      const map = fixture(mapId)
      for (const [index, conversationId, homeMachineId] of [[0, parentId, 'isolated-storage'], [1, childId, 'macbook']]) {
        Object.assign(map.nodes[index].data, { aiConversationId: conversationId, aiPrimaryConversationId: conversationId,
          aiConversations: [{ ...selection, conversationId, homeMachineId, startedBy: { id: 'user-editor' } }] })
      }
      await saveJson(path.join(data, `${mapId}.json`), map)
      await saveJson(path.join(data, '_ai-delegations.json'), prepared.delegations)
      await saveJson(path.join(data, '_ai-conversation-origins.json'), [
        { conversationId: parentId, homeMachineId: 'isolated-storage', startedBy: 'user-editor', mapId, cardId: 'card-0' },
        { conversationId: childId, homeMachineId: 'macbook', startedBy: 'user-editor', mapId, cardId: 'card-1' },
      ])
      await saveJson(path.join(data, '_distributed-work-settings.json'), [{ userId: 'user-editor', enabled: true, defaultMachineId: 'macbook' }])
      await saveJson(path.join(data, '_machines.json'), [
        { machineId: 'isolated-storage', role: 'main', enabled: true },
        { machineId: 'macbook', role: 'sub', ownerUserId: 'user-editor', enabled: true, tokenHash: hashMachineToken('isolated-runner-token') },
      ])
      await saveJson(path.join(data, '_workspace-pool.json'), f.local.state)
      await saveJson(path.join(data, '_remote-workspace-pools.json'), f.remote.state)
    } })
  const isolated = await isolatedBundledRunner(t, { entry: runnerEntry, apiUrl: api.base,
    coreUrl: `http://127.0.0.1:${server.address().port}`, workspaceRoot: f.root,
    registryFile: path.join(f.root, 'remote.json'), agentModule: path.resolve(import.meta.dirname, '../runner/lib/workspaceAgent.mjs') })
  const runner = await isolated.start()
  await isolated.descriptor()
  const login = async (email) => {
    const response = await fetch(`${api.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  const owner = await login('editor@mind.local')
  const as = (cookie, route, method = 'GET', body) => api.call(route, method, body, { Authorization: '', Cookie: cookie })
  const seededObservedAt = f.remote.state.reports.macbook.observedAt
  // 실제 Runner의 heartbeat가 들어와 보고가 바뀐 뒤에 시험한다.
  const pool = await waitFor(() => as(owner, '/api/machines/macbook/workspace-pool'),
    value => value.status === 200 && value.body.remotePools?.[0]?.observedAt !== seededObservedAt, 'Runner 보고 대기')
  return { f, api, core, calls, dispatches, isolated, runner, owner, login, as, pool,
    delegation: async (id) => (await api.read('_ai-delegations.json')).find(item => item.id === id),
    lease: async (id) => (await api.read('_remote-workspace-pools.json')).leases[id],
    agentState: async () => JSON.parse(await readFile(path.join(f.root, 'remote-shared', 'remote-runner', 'state.json'), 'utf8')) }
}

async function quarantinedPolicyFailure(f, requestId) {
  const lease = await f.acquire(requestId)
  await f.remote.bindConversation(lease.leaseId, childId)
  await f.remote.quarantine(lease.leaseId, failure)
  const leased = f.remote.publicLease(f.remote.state.leases[lease.leaseId])
  return { lease: { ...leased, status: 'leased' } }
}

test('운영자 반환 API: 권한·확인값·Core 판정·반환 기록·재시작 멱등을 실제 Runner로 검증한다', { timeout: 240_000, skip }, async t => {
  let lease, mainHead
  const e = await environment(t, { prepare: async f => {
    ({ lease } = await quarantinedPolicyFailure(f, 'v512-operator-release'))
    await writeFile(path.join(f.integration, 'main-next.txt'), '메인 진행\n')
    await git(f.integration, ['add', 'main-next.txt']); await git(f.integration, ['commit', '-m', '[김용민] 메인 진행'])
    mainHead = await git(f.integration, ['rev-parse', 'HEAD'])
    await f.observe()
    return { delegations: [delegationRecord(lease)] }
  } })
  try {
    const route = `/api/machines/macbook/workspace-pool/leases/${lease.leaseId}/release-unstarted`
    const body = { confirmed: true, delegationId: lease.requestId, expectedLeaseId: lease.leaseId, expectedGeneration: 1, expectedBaseCommit: lease.baseCommit }
    assert.deepEqual(Object.keys(e.pool.body.operationQueue).sort(), ['dispatched', 'pending', 'waiting'])

    await t.test('로그인하지 않았거나 다른 사용자이거나 AI 통합 토큰이면 실행 전에 거절한다', async () => {
      assert.equal((await e.api.call(route, 'POST', body, { Authorization: '' })).status, 401)
      assert.equal((await e.api.call(route, 'POST', body)).status, 401)
      const other = await e.login('second@mind.local')
      assert.equal((await e.as(other, route, 'POST', body)).status, 403)
      assert.equal((await e.lease(lease.leaseId)).status, 'quarantined')
    })
    await t.test('확인값이 하나라도 다르면 반환하지 않는다', async () => {
      for (const patch of [{ confirmed: false }, { delegationId: 'other' }, { expectedLeaseId: 'lease-other' }, { expectedGeneration: 2 },
        { expectedBaseCommit: mainHead }]) {
        const result = await e.as(e.owner, route, 'POST', { ...body, ...patch })
        assert.equal(result.status, 409, JSON.stringify(patch))
        assert.equal(result.body.reasonCode, 'REMOTE_WORKSPACE_RELEASE_CONFIRMATION_REQUIRED')
      }
      assert.equal((await e.lease(lease.leaseId)).status, 'quarantined')
    })
    await t.test('Core에 실행 기록이 있거나 조회가 실패하면 반환하지 않는다', async () => {
      e.core.lookup = 'exists'
      assert.equal((await e.as(e.owner, route, 'POST', body)).body.reasonCode, 'REMOTE_WORKSPACE_DISPATCH_RECORDED')
      e.core.lookup = 'error'
      assert.equal((await e.as(e.owner, route, 'POST', body)).body.reasonCode, 'REMOTE_WORKSPACE_DISPATCH_UNCONFIRMED')
      e.core.lookup = 'missing'
      const saved = await e.lease(lease.leaseId)
      assert.equal(saved.status, 'quarantined')
      assert.equal(Object.values(saved.operations).some(item => item.action === 'release'), false)
    })
    await t.test('정확한 확인값이면 결과 없이 반환하고 실패 위임에 반환 결과만 추가한다', async () => {
      const released = await e.as(e.owner, route, 'POST', body)
      assert.equal(released.status, 200, JSON.stringify(released))
      assert.equal(released.body.repeated, undefined)
      assert.equal(released.body.result.status, 'cancelled'); assert.equal(released.body.result.releaseKind, 'unstarted')
      assert.equal(released.body.delegation.workspaceResult.releaseKind, 'unstarted')
      const saved = await e.delegation(lease.requestId)
      assert.equal(saved.workspaceResult.status, 'cancelled'); assert.equal(saved.workspaceResult.releaseKind, 'unstarted')
      assert.equal(saved.workspaceResult.idleCommit, mainHead)
      assert.equal(saved.state, 'failed'); assert.equal(saved.childStatus, 'rejected')
      assert.equal(saved.failureReasonCode, 'AI_DELEGATION_POLICY_RUNTIME_UNAVAILABLE'); assert.equal(saved.childError, failure)
    })
    await t.test('반환 결과와 이력을 보존하고 재요청·서버 재시작 뒤에도 같은 결과만 돌려준다', async () => {
      const saved = await e.lease(lease.leaseId)
      assert.equal(saved.result.previousResult.reason, failure)
      assert.equal(saved.unstartedRelease.evidence.kind, 'operator')
      assert.equal(saved.unstartedRelease.evidence.dispatchLookup, 'EXTERNAL_DISPATCH_NOT_FOUND')
      assert.deepEqual(Object.values(saved.operations).map(item => item.action).sort(), ['bind', 'prepare', 'quarantine', 'release'])
      assert.equal(await git(e.f.worker, ['branch', '--show-current']), 'mnp/idle/fork1')
      assert.equal(await git(e.f.worker, ['rev-parse', 'HEAD']), mainHead)
      const agent = await e.agentState()
      assert.equal(agent.leases[lease.leaseId].status, 'completed')
      assert.equal(Object.values(agent.operations).filter(item => item.leaseId === lease.leaseId && item.action === 'release').length, 1)
      await e.api.restart()
      const again = await e.as(await e.login('editor@mind.local'), route, 'POST', body)
      assert.equal(again.status, 200, JSON.stringify(again)); assert.equal(again.body.repeated, true)
      assert.deepEqual(again.body.result, saved.result)
      assert.equal(Object.values((await e.agentState()).operations).filter(item => item.leaseId === lease.leaseId && item.action === 'release').length, 1)
      assert.equal(e.dispatches.length, 0)
    })
  } finally {
    await e.isolated.stop()
  }
})

for (const variant of ['하위 turn 기록', '같은 lease의 진행 중 위임']) test(`운영자 반환 API: ${variant}이 있으면 Core 조회 전에 거절하고 격리를 유지한다`, { timeout: 180_000, skip }, async t => {
  let lease
  const e = await environment(t, { prepare: async f => {
    ({ lease } = await quarantinedPolicyFailure(f, 'v512-traced-release'))
    await f.observe()
    const record = delegationRecord(lease, variant === '하위 turn 기록' ? { childTurnId: 'turn-recorded' } : {})
    return { delegations: variant === '하위 turn 기록' ? [record]
      : [record, { ...record, id: 'other-active', state: 'running', childStatus: 'running', childOperationId: 'other-active' }] }
  } })
  try {
    const before = e.calls.filter(item => item.path.startsWith('/api/internal/external-conversation-dispatches/')).length
    const result = await e.as(e.owner, `/api/machines/macbook/workspace-pool/leases/${lease.leaseId}/release-unstarted`, 'POST',
      { confirmed: true, delegationId: lease.requestId, expectedLeaseId: lease.leaseId, expectedGeneration: 1, expectedBaseCommit: lease.baseCommit })
    assert.equal(result.status, 409, JSON.stringify(result))
    assert.equal(result.body.reasonCode, 'REMOTE_WORKSPACE_UNSTARTED_EVIDENCE_REQUIRED')
    assert.equal(e.calls.filter(item => item.path.startsWith('/api/internal/external-conversation-dispatches/')).length, before)
    const saved = await e.lease(lease.leaseId)
    assert.equal(saved.status, 'quarantined'); assert.equal(saved.unstartedRelease, undefined)
    assert.equal(await git(e.f.worker, ['branch', '--show-current']), lease.branch)
  } finally {
    await e.isolated.stop()
  }
})

test('운영자 반환 API: 응답 유실로 release-pending에 남은 반환은 같은 영수증으로만 완료한다', { timeout: 180_000, skip }, async t => {
  let lease
  const e = await environment(t, { prepare: async f => {
    ({ lease } = await quarantinedPolicyFailure(f, 'v512-pending-release'))
    await f.observe()
    f.lose('release')
    await assert.rejects(() => f.remote.releaseUnstarted(lease.leaseId, { evidence: { kind: 'operator' } }), /lost response/)
    assert.equal(f.remote.state.leases[lease.leaseId].status, 'release-pending')
    return { delegations: [delegationRecord(lease)] }
  } })
  try {
    const attempt = (await e.lease(lease.leaseId)).unstartedRelease.attempt
    const result = await e.as(e.owner, `/api/machines/macbook/workspace-pool/leases/${lease.leaseId}/release-unstarted`, 'POST',
      { confirmed: true, delegationId: lease.requestId, expectedLeaseId: lease.leaseId, expectedGeneration: 1, expectedBaseCommit: lease.baseCommit })
    assert.equal(result.status, 200, JSON.stringify(result))
    assert.equal(result.body.result.releaseKind, 'unstarted')
    const saved = await e.lease(lease.leaseId)
    assert.equal(saved.status, 'completed'); assert.equal(saved.unstartedRelease.attempt, attempt)
    assert.equal(Object.values(saved.operations).filter(item => item.action === 'release').length, 1)
    assert.equal(Object.values((await e.agentState()).operations).filter(item => item.leaseId === lease.leaseId && item.action === 'release').length, 1)
    assert.equal((await e.delegation(lease.requestId)).workspaceResult.releaseKind, 'unstarted')
  } finally {
    await e.isolated.stop()
  }
})

test('운영자 반환 API: 반환 완료 뒤 위임 기록 저장이 누락된 상태는 재실행 없이 기록만 보완한다', { timeout: 180_000, skip }, async t => {
  let lease, released
  const e = await environment(t, { prepare: async f => {
    ({ lease } = await quarantinedPolicyFailure(f, 'v512-record-missing'))
    await f.observe()
    // 반환 응답 뒤 위임 저장이 실패한 상태를 같은 영속 기록으로 재현한다.
    released = await f.remote.releaseUnstarted(lease.leaseId, { reason: '저장 실패 재현', evidence: { kind: 'operator' } })
    return { delegations: [delegationRecord(lease)] }
  } })
  try {
    assert.equal((await e.delegation(lease.requestId)).workspaceResult, undefined)
    const lookups = () => e.calls.filter(item => item.path.startsWith('/api/internal/external-conversation-dispatches/')).length
    const before = lookups()
    const result = await e.as(e.owner, `/api/machines/macbook/workspace-pool/leases/${lease.leaseId}/release-unstarted`, 'POST',
      { confirmed: true, delegationId: lease.requestId, expectedLeaseId: lease.leaseId, expectedGeneration: 1, expectedBaseCommit: lease.baseCommit })
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.repeated, true)
    assert.deepEqual(result.body.result, released)
    assert.deepEqual((await e.delegation(lease.requestId)).workspaceResult, released)
    assert.equal(lookups(), before, '이미 반환된 lease는 Core 조회나 Runner 명령을 다시 하지 않는다')
    assert.equal(Object.values((await e.agentState()).operations).filter(item => item.leaseId === lease.leaseId && item.action === 'release').length, 1)
  } finally {
    await e.isolated.stop()
  }
})

test('위임 대기열: 실행 정책 준비가 실패하면 하위 dispatch 없이 원격 worker를 결과 없이 반환하고 실패 기록에 남긴다', { timeout: 240_000, skip }, async t => {
  const e = await environment(t, { env: { MNP_AI_DELEGATION_POLL_INTERVAL_MS: '200' } })
  try {
    const origin = { 'X-MNP-AI-Conversation-Id': parentId, 'X-MNP-AI-Map-Id': mapId, 'X-MNP-AI-Card-Id': 'card-0' }
    const listed = await e.api.call(`/api/maps/${mapId}/cards/card-1/ai-conversations`)
    assert.equal(listed.status, 200, JSON.stringify(listed))
    const candidate = listed.body.conversations.find(item => item.conversationId === childId)
    const version = (await e.api.call(`/api/maps/${mapId}`)).body.map.version
    const accepted = await e.api.call(`/api/maps/${mapId}/ai-delegations`, 'POST', { targetCardId: 'card-1', strategy: 'resume',
      conversationId: childId, conversationAssessmentId: candidate.contextHealth.assessmentId, machineId: 'macbook', workspacePoolId: 'mac-pool',
      instruction: '격리 시험 지시입니다.', decisionReason: '정책 준비 실패 시 반환 검증', sourceRevision: version,
      idempotencyKey: 'auto-unstarted-release', workType: 'other', analysisDepth: 'standard' }, origin)
    assert.equal(accepted.status, 202, JSON.stringify(accepted))
    // 실패 위임은 이후 기존 상위 보고 단계(waiting-parent)로 넘어가므로 하위 실행 상태로 판정한다.
    const failed = await waitFor(() => e.delegation('auto-unstarted-release'), value => value?.childStatus === 'rejected', '정책 실패 대기')
    assert.ok(['failed', 'waiting-parent'].includes(failed.state), failed.state)
    assert.equal(failed.failureReasonCode, 'AI_DELEGATION_POLICY_RUNTIME_UNAVAILABLE')
    assert.equal(failed.workspaceResult?.status, 'cancelled', JSON.stringify(failed)); assert.equal(failed.workspaceResult.releaseKind, 'unstarted')
    const saved = await e.lease(failed.workspaceLease.leaseId)
    assert.equal(saved.status, 'completed'); assert.equal(saved.unstartedRelease.evidence.kind, 'before-dispatch')
    assert.equal(saved.unstartedRelease.previousStatus, 'leased')
    assert.ok(e.calls.some(item => item.path === `/api/conversations/${childId}/runtime/ensure`))
    assert.equal(e.dispatches.length, 0)
    assert.equal(await git(e.f.worker, ['branch', '--show-current']), 'mnp/idle/fork1')
    assert.equal((await e.agentState()).leases[saved.leaseId].status, 'completed')
  } finally {
    await e.isolated.stop()
  }
})
