import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { remoteWorkspaceFixture } from './helpers/remote-workspace-fixture.mjs'
import { isolatedBundledRunner } from './helpers/isolated-runner.mjs'
import { git, jsonFile, saveJson } from '../server/lib/remoteWorkspaceProtocol.mjs'
import { hashMachineToken } from '../server/lib/subMachines.mjs'

// 실제 MnP HTTP·저장소, 실제 내장 Runner bundle, 실제 workspace agent와 임시 Git을 연결한다.
// Core만 격리 모의 서버이며 운영 대화·registry·descriptor·인증을 사용하지 않는다.
const runnerEntry = process.env.MNP_BUNDLED_RUNNER_TEST_ENTRY
const skip = !runnerEntry && 'MNP_BUNDLED_RUNNER_TEST_ENTRY에 검증한 내장 Runner bundle의 절대 경로를 지정해야 합니다.'
const password = 'RemoteIntegration!2026'
const mapId = 'map-bench-0', parentId = 'parent-remote', childId = 'child-remote'
const idle = { state: 'idle', is_processing: false, pending_confirmations: 0, can_send_message: true, turn_id: null }
const options = (...values) => values.map(value => ({ value, name: value }))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const longFile = 'Assets/AdPopcornReward/Plugins/iOS/AdPopcornOfferwall.framework/AdPopcornOfferwall.bundle/Contents/Resources/en.lproj/Localizable.strings'

async function waitFor(read, accept, label) {
  let value
  for (let attempt = 0; attempt < 300; attempt++) {
    value = await read()
    if (accept(value)) return value
    await wait(100)
  }
  assert.fail(`${label}: ${JSON.stringify(value)}`)
}

// 하위 AI 작업을 체크포인트하고 Runner에서 결과를 봉인한다. 메인 통합은 서버 대기열이 맡는다.
async function sealedResult(f, requestId, text) {
  const lease = await f.acquire(requestId)
  await f.remote.bindConversation(lease.leaseId, childId)
  await writeFile(path.join(f.worker, 'feature.txt'), text)
  await f.checkpoint(lease)
  const stored = f.remote.state.leases[lease.leaseId]
  const sealed = await f.remote.command(stored, 'seal', { checkpointRound: stored.checkpoints.length })
  Object.assign(stored, { headCommit: sealed.headCommit, checkpoints: sealed.checkpoints, sealed: true, resultMode: sealed.resultMode })
  await f.observe()
  return stored
}

async function environment(t, { scenario, delegationState }) {
  const f = await remoteWorkspaceFixture(t, { mapId, cardId: 'card-1', conversationId: childId })
  const stored = await sealedResult(f, `v512-${scenario}`, '원격 결과\n')
  if (scenario === 'conflict') {
    await writeFile(path.join(f.integration, 'feature.txt'), '메인 변경\n')
    await git(f.integration, ['add', 'feature.txt']); await git(f.integration, ['commit', '-m', '[김용민] 메인 변경'])
  }
  const mainHead = await git(f.integration, ['rev-parse', 'HEAD'])
  const dispatches = [], core = { completed: new Set() }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    const ok = data => send({ success: true, data })
    if (req.url === '/api/internal/conversation-runtimes/active') return ok({ items: [] })
    if (req.url.endsWith('/capabilities')) return ok({ schemaVersion: 3, workspaceLeaseVersion: 3, remoteWorkspaceOwnership: true,
      atomicWorkspaceRebind: true, releasesRuntimeOnTerminal: true, explicitCompletionAfterInterruption: true })
    if (req.url === '/api/internal/external-conversation-dispatches' && req.method === 'POST') {
      dispatches.push(body)
      return ok({ operationId: body.operationId, conversationId: body.targetConversationId ?? parentId, state: 'running', turnId: `turn-${dispatches.length}` })
    }
    if (req.url.startsWith('/api/internal/external-conversation-dispatches/')) {
      const operationId = decodeURIComponent(req.url.split('/').at(-1))
      const dispatch = dispatches.find(item => item.operationId === operationId)
      if (!dispatch) return send({ success: false, error: { code: 'EXTERNAL_DISPATCH_NOT_FOUND', message: '격리된 실행 기록이 없습니다.' } }, 404)
      return ok({ operationId, conversationId: dispatch.targetConversationId, state: core.completed.has(operationId) ? 'completed' : 'running',
        turnId: `turn-${dispatches.indexOf(dispatch) + 1}` })
    }
    if (req.url === '/api/agents/management') return ok([{ id: 'codex', name: 'Codex CLI', backend: 'codex', installed: true, enabled: true,
      available_models: { available_models: options('gpt-6.1-sol') }, available_modes: { available_modes: options('full-access') },
      config_options: [{ category: 'thought_level', options: options('xhigh') }] }])
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
  let dataRoot, legacyReason = null
  const api = await storageApi(t, { documents: 1, env: { MNP_WORKSPACE_POOL_REGISTRY: path.join(f.root, 'local.json'), MNP_AI_DELEGATION_POLL_INTERVAL_MS: '200' },
    seed: async ({ data }) => {
      dataRoot = data
      const users = JSON.parse(await readFile(path.join(data, '_users.json'), 'utf8'))
      for (const user of users) user.passwordHash = scryptSync(password, user.salt, 64).toString('hex')
      await writeFile(path.join(data, '_users.json'), JSON.stringify(users))
      const map = fixture(mapId)
      for (const [index, conversationId, homeMachineId] of [[0, parentId, 'isolated-storage'], [1, childId, 'macbook']]) {
        Object.assign(map.nodes[index].data, { aiConversationId: conversationId, aiPrimaryConversationId: conversationId,
          aiConversations: [{ ...selection, conversationId, homeMachineId, startedBy: { id: 'user-editor' } }] })
      }
      await saveJson(path.join(data, `${mapId}.json`), map)
      // 봉인 결과 bundle은 메인 서버 데이터 폴더에 보존돼 있어야 통합할 수 있다.
      await cp(path.join(f.root, 'remote-workspaces', 'artifacts'), path.join(data, 'remote-workspaces', 'artifacts'), { recursive: true })
      let result, leaseStatus
      if (scenario === 'legacy') {
        // 수정 전 Windows 서버와 같은 형태: Git 출력 전문을 사유 코드 없이 저장했고 미완성 staging 사본이 남았다.
        const repository = path.join(data, 'remote-workspaces', 'staging', stored.leaseId, 'repository')
        legacyReason = `Command failed: git --no-optional-locks -C ${repository} switch ${stored.branch}\nerror: unable to create file ${longFile}: Filename too long\n`
        result = { status: 'quarantined', leaseId: stored.leaseId, jobId: stored.jobId, reason: legacyReason }
        leaseStatus = 'quarantined'
        await mkdir(repository, { recursive: true })
        await writeFile(path.join(repository, 'partial.txt'), '미완성 checkout\n')
      } else {
        result = { status: 'waiting-integration', leaseId: stored.leaseId, jobId: stored.jobId, childStatus: 'completed' }
        leaseStatus = 'waiting-integration'
      }
      await saveJson(path.join(data, '_remote-workspace-pools.json'), { ...f.remote.state,
        leases: { ...f.remote.state.leases, [stored.leaseId]: { ...stored, status: leaseStatus, result } } })
      const now = new Date().toISOString()
      await saveJson(path.join(data, '_ai-delegations.json'), [{ id: stored.requestId, mapId, parentCardId: 'card-0', targetCardId: 'card-1',
        targetCardLabel: '원격 통합 검증', parentConversationId: parentId, parentHomeMachineId: 'isolated-storage', targetConversationId: childId,
        targetHomeMachineId: 'macbook', startedBy: 'user-editor', state: delegationState, childStatus: 'completed', strategy: 'resume',
        childOperationId: stored.requestId, childTurnId: 'turn-child-completed', workspaceLease: f.remote.publicLease(stored), workspaceResult: result,
        ...(legacyReason ? { workspaceError: legacyReason, integrationError: legacyReason, recoveryRequiredAt: now } : {}), createdAt: now, updatedAt: now }])
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
    } })
  const isolated = await isolatedBundledRunner(t, { entry: runnerEntry, apiUrl: api.base,
    coreUrl: `http://127.0.0.1:${server.address().port}`, workspaceRoot: f.root,
    registryFile: path.join(f.root, 'remote.json'), agentModule: path.resolve(import.meta.dirname, '../runner/lib/workspaceAgent.mjs') })
  await isolated.start()
  await isolated.descriptor()
  const response = await fetch(`${api.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'editor@mind.local', password }) })
  assert.equal(response.status, 200)
  const owner = response.headers.get('set-cookie').split(';')[0]
  const as = (route, method = 'GET', body) => api.call(route, method, body, { Authorization: '', Cookie: owner })
  const seededObservedAt = f.remote.state.reports.macbook.observedAt
  // 실제 Runner의 heartbeat가 들어와 보고가 바뀐 뒤에 시험한다.
  await waitFor(() => as('/api/machines/macbook/workspace-pool'),
    value => value.status === 200 && value.body.remotePools?.[0]?.observedAt !== seededObservedAt, 'Runner 보고 대기')
  return { f, api, as, isolated, dispatches, core, stored, mainHead, legacyReason,
    data: (...parts) => path.join(dataRoot, ...parts),
    retry: body => as(`/api/machines/macbook/workspace-pool/leases/${stored.leaseId}/retry-integration`, 'POST', body),
    delegation: async () => (await api.read('_ai-delegations.json')).find(item => item.id === stored.requestId),
    publicDelegation: async () => (await as(`/api/maps/${mapId}/ai-delegations?delegationId=${stored.requestId}`)).body.delegations[0],
    lease: async () => (await api.read('_remote-workspace-pools.json')).leases[stored.leaseId] }
}

test('원격 통합 API: 수정 전 staging 실패 기록은 AI 재개를 막고 재시도로 봉인 결과부터 통합해 worker를 반환한다', { timeout: 240_000, skip }, async t => {
  const e = await environment(t, { scenario: 'legacy', delegationState: 'integration-recovery-required' })
  try {
    await t.test('화면·AI 조회는 Git 출력 전문 대신 구분된 사유와 다음 조치를 받는다', async () => {
      const view = await e.publicDelegation()
      assert.equal(view.recovery.failureCategory, 'remote-integration')
      assert.equal(view.recovery.recoveryAvailable, false)
      assert.equal(view.recovery.recommendedAction, 'retry-remote-integration')
      assert.equal(view.reasonCode, 'REMOTE_WORKSPACE_STAGING_PATH_TOO_LONG')
      assert.match(view.message, /경로 초과 1건/); assert.doesNotMatch(view.message, /Command failed/)
      assert.equal(view.message, view.recovery.message)
    })
    await t.test('사람의 기존 작업 재개 요청도 하위 AI 실행 없이 거절한다', async () => {
      const result = await e.as(`/api/maps/${mapId}/ai-delegations/${e.stored.requestId}/recover`, 'POST',
        { instruction: '기존 작업을 이어서 통합하세요.', sourceRevision: 1 })
      assert.equal(result.status, 409, JSON.stringify(result))
      assert.equal(result.body.code, 'AI_DELEGATION_REMOTE_INTEGRATION_RETRY_REQUIRED')
      assert.equal(e.dispatches.length, 0)
      const saved = await e.delegation()
      assert.equal(saved.state, 'integration-recovery-required'); assert.equal(saved.pendingRecovery, undefined)
    })
    await t.test('봉인 HEAD를 확인하지 않은 재시도는 lease와 위임을 바꾸지 않고 staging도 만들지 않는다', async () => {
      const result = await e.retry({ confirmed: true, expectedHead: 'a'.repeat(40) })
      assert.equal(result.status, 409, JSON.stringify(result))
      assert.equal(result.body.reasonCode, 'REMOTE_WORKSPACE_RECOVERY_CONFIRMATION_REQUIRED')
      assert.equal((await e.lease()).status, 'quarantined')
      assert.equal((await e.delegation()).state, 'integration-recovery-required')
      assert.deepEqual(await readdir(e.data('remote-workspaces', 'staging', e.stored.leaseId)), ['repository'])
      assert.deepEqual(await readdir(e.data('remote-workspaces', 'staging', e.stored.leaseId, 'repository')), ['partial.txt'])
      assert.equal(await git(e.f.integration, ['rev-parse', 'HEAD']), e.mainHead)
    })
    await t.test('확인한 재시도는 통합 대기로 돌리고 대기열이 Git 객체로 메인에 통합한 뒤 worker를 반환한다', async () => {
      const result = await e.retry({ confirmed: true, expectedHead: e.stored.headCommit })
      assert.equal(result.status, 200, JSON.stringify(result))
      assert.equal(result.body.status, 'waiting-integration'); assert.equal(result.body.phase, 'integration-requeued')
      assert.equal(result.body.previousResult.reason, e.legacyReason)
      const lease = await waitFor(() => e.lease(), value => value?.status === 'completed', '재시도 후 통합 완료 대기')
      assert.equal(lease.result.remoteReleased, true); assert.equal(lease.integrationHistory.length, 1)
      assert.equal(await readFile(path.join(e.f.integration, 'feature.txt'), 'utf8'), '원격 결과\n')
      assert.equal(await git(e.f.worker, ['branch', '--show-current']), 'mnp/idle/fork1')
      // 대기열은 통합 결과를 먼저 기록한 뒤 상위 보고 단계로 넘긴다. 두 기록이 모두 끝날 때까지 기다린다.
      const saved = await waitFor(() => e.delegation(), value => value?.workspaceResult?.status === 'completed'
        && !['integration-recovery-required', 'waiting-integration'].includes(value.state), '위임 통합 결과 기록 대기')
      assert.equal(saved.workspaceResult.remoteReleased, true); assert.equal(saved.integrationError, null)
      assert.equal(e.dispatches.filter(item => item.targetConversationId === childId).length, 0, '하위 AI를 다시 실행하지 않는다')
      await assert.rejects(() => stat(e.data('remote-workspaces', 'staging', e.stored.leaseId)), { code: 'ENOENT' })
      await assert.rejects(() => stat(e.data('remote-workspaces', 'integration', `${e.stored.leaseId}.git`)), { code: 'ENOENT' })
    })
  } finally {
    await e.isolated.stop()
  }
})

test('원격 통합 API: 이어서 통합할 위임이 없으면 재시도가 lease를 바꾸지 않는다', { timeout: 180_000, skip }, async t => {
  const e = await environment(t, { scenario: 'legacy', delegationState: 'closed' })
  try {
    const result = await e.retry({ confirmed: true, expectedHead: e.stored.headCommit })
    assert.equal(result.status, 409, JSON.stringify(result))
    assert.equal(result.body.reasonCode, 'REMOTE_WORKSPACE_INTEGRATION_RETRY_DELEGATION_REQUIRED')
    assert.equal((await e.lease()).status, 'quarantined')
    assert.equal((await e.delegation()).state, 'closed')
  } finally {
    await e.isolated.stop()
  }
})

test('원격 통합 API: 메인 충돌은 실제 Runner의 원격 Fork에서 하위 AI 충돌 해결로 이어지고 해결 후보만 메인에 반영한다', { timeout: 240_000, skip }, async t => {
  const e = await environment(t, { scenario: 'conflict', delegationState: 'waiting-integration' })
  try {
    const dispatch = await waitFor(async () => e.dispatches.find(item => item.targetConversationId === childId), Boolean, '충돌 해결 대화 요청 대기')
    assert.match(dispatch.operationId, /integrate-1$/)
    assert.match(dispatch.instruction, /통합 충돌 해결 요청/)
    assert.match(dispatch.instruction, new RegExp(`mnp/integrate/${e.stored.jobId}-1`))
    assert.equal(dispatch.workspaceLease.leaseId, e.stored.leaseId)
    const lease = await e.lease()
    assert.equal(lease.status, 'awaiting-conflict-resolution'); assert.deepEqual(lease.result.unmergedFiles, ['feature.txt'])
    assert.equal(await git(e.f.integration, ['rev-parse', 'HEAD']), e.mainHead, '충돌 해결 전에는 메인을 바꾸지 않는다')
    assert.equal(await git(e.f.worker, ['branch', '--show-current']), `mnp/integrate/${e.stored.jobId}-1`)
    assert.equal((await jsonFile(path.join(e.f.worker, '.ai-session.json'))).integration.phase, 'integration-conflict')
    const running = await waitFor(() => e.delegation(), value => value?.state === 'integration-running', '충돌 해결 실행 상태 대기')
    assert.equal(running.workspaceResult.status, 'awaiting-conflict-resolution')
    // 하위 AI가 충돌을 해결하고 stage한 뒤 턴을 마친 상황을 재현한다.
    await writeFile(path.join(e.f.worker, 'feature.txt'), '메인 변경과 원격 결과를 합친 내용\n')
    await git(e.f.worker, ['add', 'feature.txt'])
    e.core.completed.add(dispatch.operationId)
    const completed = await waitFor(() => e.lease(), value => value?.status === 'completed', '충돌 해결 후보 통합 완료 대기')
    assert.equal(completed.result.conflictResolvedByAi, true); assert.equal(completed.result.remoteReleased, true)
    assert.equal(await readFile(path.join(e.f.integration, 'feature.txt'), 'utf8'), '메인 변경과 원격 결과를 합친 내용\n')
    assert.equal(await git(e.f.integration, ['rev-parse', 'HEAD^']), e.mainHead)
    assert.equal(await git(e.f.worker, ['branch', '--show-current']), 'mnp/idle/fork1')
    const saved = await waitFor(() => e.delegation(), value => value?.workspaceResult?.status === 'completed'
      && !value.state.startsWith('integration-') && value.state !== 'waiting-integration', '위임 통합 결과 기록 대기')
    assert.equal(saved.workspaceResult.conflictResolvedByAi, true)
    assert.equal(e.dispatches.filter(item => item.targetConversationId === childId).length, 1, '충돌 해결 대화는 한 번만 요청한다')
  } finally {
    await e.isolated.stop()
  }
})
