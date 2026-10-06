import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'
import { aiDelegationAttemptHistory, aiDelegationRecoveryAvailability } from '../server/lib/aiDelegations.mjs'

const exec = promisify(execFile)
const realGit = { skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행', timeout: Number(process.env.MNP_REAL_GIT_TEST_TIMEOUT_MS) || 180_000 }
const git = async (cwd, ...args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim()
const scope = { mapId: 'map-test', cardId: 'card-test', conversationId: 'conversation-test' }
const accidental = 'Assets/자동 생성.meta'
const message = { summary: '결과 정정 검증', background: '통합 대기 결과 정정 검증', cause: '우발 meta 파일', changes: '담당 source 정정' }
const instruction = '원 담당자의 우발 meta를 정상 변경 체크포인트로 정정하세요. 통합 사용자 파일은 보존하세요.'
const hash = createHash('sha256').update(instruction).digest('hex')
const operationId = 'original:icons-correct-1'
const userBytes = Buffer.alloc(243, 0x73)
async function put(root, relative, content) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
  await writeFile(path.join(root, relative), content)
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-result-correction-'))
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}mnp-result-correction-`))
    await rm(root, { recursive: true, force: true })
  })
  const main = path.join(root, 'main'), worker = path.join(root, 'worker'), sharedRoot = path.join(root, 'shared')
  await mkdir(main); await mkdir(sharedRoot)
  await git(main, 'init', '-b', 'japan-master')
  const config = async cwd => {
    await git(cwd, 'config', 'user.name', 'MNP Test')
    await git(cwd, 'config', 'user.email', 'mnp@example.invalid')
    await git(cwd, 'config', 'core.autocrlf', 'false')
    await git(cwd, 'config', 'core.hooksPath', path.join(root, 'no-hooks'))
  }
  await config(main)
  await put(main, '.gitignore', '/.ai-session.json\n/.ai-workspace.json\n')
  await put(main, 'base.txt', 'base\n')
  await git(main, 'add', '.'); await git(main, 'commit', '-m', 'base')
  await git(root, 'clone', main, worker); await config(worker)
  await put(worker, '.ai-workspace.json', JSON.stringify({ workspaceId: 'worker', projectRoot: worker }))
  const registryFile = path.join(sharedRoot, 'workspaces.json'), stateFile = path.join(root, 'state.json')
  const workspaces = [{ id: 'main', root: main, role: 'integration', enabled: true }, { id: 'worker', root: worker, role: 'worker', enabled: true }]
  await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'test', sharedRoot, workspaces }))
  const createManager = () => new WorkspacePoolManager({ registryFile, stateFile })
  const manager = createManager(); await manager.initialize()
  const lease = await manager.acquire({ workspaceHint: main, ...scope })
  await put(worker, 'icons.txt', 'approved icons\n'); await put(worker, accidental, 'accidental meta\n')
  await manager.checkpoint(lease.leaseId, { jobId: lease.jobId, ...scope, paths: ['icons.txt', accidental], commitMessage: message })
  await put(main, accidental, userBytes)
  const result = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(result.reasonCode, 'integration-untracked-collision')
  const prepare = extra => manager.prepareIntegrationResultCorrection(lease.leaseId, { ...scope, expectedLease: lease, operationId, instructionHash: hash, ...extra })
  const checkpoint = async target => {
    const managerToUse = target ?? manager
    // 원 담당자의 정상 수정처럼 source의 우발 추가만 삭제한다. main에는 접근하지 않는다.
    await rm(path.join(worker, accidental))
    return managerToUse.checkpoint(lease.leaseId, { jobId: lease.jobId, ...scope, paths: [accidental], commitMessage: message })
  }
  return { root, main, worker, sharedRoot, registryFile, stateFile, manager, lease, result, createManager, prepare, checkpoint, config, workspaces }
}

test('정정은 후보가 있는 미추적 충돌에만 표시하고 원문·hash·turn을 감사 이력에 보존한다', () => {
  const original = { state: 'waiting-integration', childResultSnapshot: '원문', childResultHash: 'hash', childResultTurnId: 'turn',
    workspaceLease: { leaseId: 'lease' }, workspaceResult: { status: 'waiting-integration', childStatus: 'completed',
      reasonCode: 'integration-untracked-collision', integrationHeadCommit: 'head' } }
  assert.equal(aiDelegationRecoveryAvailability(original).recommendedAction, 'correct-integration-result')
  assert.equal(aiDelegationRecoveryAvailability({ ...original, workspaceResult: { ...original.workspaceResult, integrationHeadCommit: null } }), null)
  assert.equal(aiDelegationRecoveryAvailability({ ...original, workspaceResult: { ...original.workspaceResult, integratedCommit: 'head' } }), null)
  for (const state of ['completed', 'superseded', 'closed']) {
    for (const phase of ['preparing', 'dispatched']) {
      assert.equal(aiDelegationRecoveryAvailability({ ...original, state, resultCorrection: { phase } }), null)
    }
  }
  for (const state of ['recovery-required', 'waiting-parent']) {
    assert.equal(aiDelegationRecoveryAvailability({ ...original, state, childStatus: 'completed', resultCorrection: { phase: 'dispatched' },
      workspaceResult: { status: 'completed', childStatus: 'completed', integratedCommit: 'head' } }), null)
  }
  const history = aiDelegationAttemptHistory(original, '정정')[0]
  assert.equal(history.result, '원문'); assert.equal(history.resultHash, 'hash'); assert.equal(history.resultTurnId, 'turn')
})

test('같은 owner·lease의 정정 체크포인트로 새 후보를 통합하고 243byte 사용자 파일과 이전 후보를 보존한다', realGit, async t => {
  const f = await fixture(t)
  const original = structuredClone(f.manager.state.leases[f.lease.leaseId])
  const resumed = await f.prepare()
  assert.equal(resumed.leaseId, f.lease.leaseId); assert.equal(resumed.branch, f.lease.branch)
  assert.equal(await git(f.worker, 'branch', '--show-current'), f.lease.branch)
  const session = JSON.parse(await readFile(path.join(f.worker, '.ai-session.json'), 'utf8'))
  assert.equal(session.conversationId, scope.conversationId); assert.equal(session.resultCorrection.operationId, operationId)
  const correction = f.manager.state.leases[f.lease.leaseId].resultCorrection
  assert.equal(await git(f.worker, 'rev-parse', correction.sourceBackupRef), original.headCommit)
  assert.equal(await git(f.worker, 'rev-parse', correction.candidateBackupRef), original.integrationHeadCommit)
  await assert.rejects(f.manager.reuseLease(f.lease.leaseId, scope))
  await assert.rejects(f.manager.acquire({ ...scope, workspaceHint: f.main, conversationId: 'other-owner' }))
  assert.deepEqual(await f.manager.finalize(f.lease.leaseId, { childStatus: 'completed', operationId: 'old-operation' }), original.result)
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed', operationId }), /새 변경 체크포인트/)
  const checkpoint = await f.checkpoint()
  assert.equal(f.manager.state.workspaces.worker.status, 'correcting-result')
  const restarted = f.createManager(); await restarted.initialize()
  assert.equal(restarted.state.integrationLeaseId, f.lease.leaseId)
  assert.deepEqual(await restarted.finalize(f.lease.leaseId, { childStatus: 'completed', operationId: 'old-operation' }), original.result)
  // 정정 중 별개의 main 커밋이 생겨도 정정 source를 fresh 기준에서 다시 만든다.
  await put(f.main, 'fresh.txt', 'fresh main\n'); await git(f.main, 'add', 'fresh.txt'); await git(f.main, 'commit', '-m', 'fresh')
  await put(f.main, 'base.txt', '통합 사용자 수정\n')
  const dirtyWait = await restarted.finalize(f.lease.leaseId, { childStatus: 'completed', operationId })
  assert.equal(dirtyWait.status, 'waiting-integration'); assert.equal(dirtyWait.reasonCode, 'integration-worktree-dirty')
  assert.equal(restarted.state.integrationLeaseId, f.lease.leaseId)
  await git(f.main, 'restore', 'base.txt')
  const completed = await restarted.finalize(f.lease.leaseId, { childStatus: 'completed', operationId })
  assert.equal(completed.status, 'completed'); assert.equal(completed.headCommit, checkpoint.checkpoint.commit)
  assert.notEqual(completed.integratedCommit, original.integrationHeadCommit)
  assert.equal(await readFile(path.join(f.main, 'icons.txt'), 'utf8'), 'approved icons\n')
  assert.equal(await readFile(path.join(f.main, 'fresh.txt'), 'utf8'), 'fresh main\n')
  assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
  assert.equal(await git(f.main, 'ls-files', '--', accidental), '')
  assert.equal(await git(f.worker, 'rev-parse', original.integrationBranch), original.integrationHeadCommit)
  const saved = restarted.state.leases[f.lease.leaseId]
  assert.deepEqual(saved.resultCorrectionHistory[0].previousResult, original.result)
  assert.deepEqual(saved.checkpoints[0], original.checkpoints[0])
  assert.equal(saved.resultCorrection.phase, 'completed'); assert.equal(restarted.state.integrationLeaseId, null)
})

test('정정 준비 실패·Git switch와 세션 저장 사이 재시작은 같은 요청만 이어가고 자동 finalize를 막는다', realGit, async t => {
  const f = await fixture(t)
  const runner = f.manager.git
  let switched = false
  f.manager.git = async (cwd, args, options) => {
    const result = await runner(cwd, args, options)
    if (cwd === f.worker && args[0] === 'switch' && !switched) { switched = true; throw new Error('switch 뒤 중단') }
    return result
  }
  await assert.rejects(f.prepare(), /switch 뒤 중단/)
  const restarted = f.createManager(); await restarted.initialize()
  assert.equal(restarted.state.leases[f.lease.leaseId].status, 'result-correction-preparing')
  const originalHead = await git(f.main, 'rev-parse', 'HEAD')
  await restarted.finalize(f.lease.leaseId, { childStatus: 'completed', operationId })
  assert.equal(await git(f.main, 'rev-parse', 'HEAD'), originalHead)
  await assert.rejects(restarted.prepareIntegrationResultCorrection(f.lease.leaseId,
    { ...scope, expectedLease: f.lease, operationId: 'other-operation', instructionHash: hash }))
  const options = { ...scope, expectedLease: f.lease, operationId, instructionHash: hash }
  await restarted.prepareIntegrationResultCorrection(f.lease.leaseId, options)
  await restarted.prepareIntegrationResultCorrection(f.lease.leaseId, options)
  assert.equal(restarted.state.leases[f.lease.leaseId].status, 'correcting-result')
  assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
})

test('중단된 정정 세션 전환 뒤 저장 실패는 동일 owner·lease의 재개 요청으로만 이어간다', realGit, async t => {
  const f = await fixture(t); await f.prepare()
  const nextOperation = 'original:icons-correct-2'
  const persist = f.manager.persist.bind(f.manager)
  let writes = 0
  f.manager.persist = async () => { writes += 1; if (writes === 2) throw new Error('정정 세션 저장 뒤 중단'); return persist() }
  const options = { ...scope, expectedLease: f.lease, previousOperationId: operationId,
    operationId: nextOperation, instructionHash: hash }
  await assert.rejects(f.manager.resumeIntegrationResultCorrection(f.lease.leaseId, options), /세션 저장 뒤 중단/)
  const restarted = f.createManager(); await restarted.initialize()
  assert.equal(restarted.state.leases[f.lease.leaseId].resultCorrection.operationId, operationId)
  assert.equal(JSON.parse(await readFile(path.join(f.worker, '.ai-session.json'), 'utf8')).resultCorrection.operationId, nextOperation)
  await restarted.resumeIntegrationResultCorrection(f.lease.leaseId, options)
  await restarted.resumeIntegrationResultCorrection(f.lease.leaseId, options)
  assert.deepEqual(restarted.state.leases[f.lease.leaseId].resultCorrection.operationHistory, [operationId])
  assert.equal(restarted.state.integrationLeaseId, f.lease.leaseId)
  await f.checkpoint(restarted)
  assert.equal((await restarted.finalize(f.lease.leaseId, { childStatus: 'completed', operationId: nextOperation })).status, 'completed')
  assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
})

test('owner·HEAD·session·dirty·Git 작업·이미 통합된 후보·다른 lock 불일치를 쓰기 전에 거부한다', realGit, async t => {
  const f = await fixture(t)
  const original = structuredClone(f.manager.state)
  await assert.rejects(f.prepare({ conversationId: 'other-owner' }))
  await assert.rejects(f.prepare({ expectedLease: { ...f.lease, jobId: 'wrong-job' } }))
  const sessionFile = path.join(f.worker, '.ai-session.json'), sessionText = await readFile(sessionFile, 'utf8')
  await writeFile(sessionFile, JSON.stringify({ ...JSON.parse(sessionText), conversationId: 'other-owner' }))
  await assert.rejects(f.prepare()); await writeFile(sessionFile, sessionText)
  await put(f.worker, 'dirty.txt', 'dirty')
  await assert.rejects(f.prepare(), /커밋되지 않은/); await rm(path.join(f.worker, 'dirty.txt'))
  const mergeFile = path.resolve(f.worker, await git(f.worker, 'rev-parse', '--git-path', 'MERGE_HEAD'))
  await writeFile(mergeFile, original.leases[f.lease.leaseId].headCommit)
  await assert.rejects(f.prepare(), /Git 작업/); await rm(mergeFile)
  const candidate = original.leases[f.lease.leaseId]
  await git(f.worker, 'update-ref', `refs/heads/${candidate.integrationBranch}`, candidate.integrationBaseCommit, candidate.integrationHeadCommit)
  await assert.rejects(f.prepare())
  await git(f.worker, 'update-ref', `refs/heads/${candidate.integrationBranch}`, candidate.integrationHeadCommit, candidate.integrationBaseCommit)
  await git(f.worker, 'update-ref', `refs/heads/${f.lease.branch}`, f.lease.baseCommit, candidate.headCommit)
  await assert.rejects(f.prepare(), /source HEAD/)
  await git(f.worker, 'update-ref', `refs/heads/${f.lease.branch}`, candidate.headCommit, f.lease.baseCommit)
  await put(f.main, 'base.txt', '사용자 추적 파일 수정\n')
  await assert.rejects(f.prepare(), /추적 파일 변경/)
  await git(f.main, 'restore', 'base.txt')
  f.manager.state.integrationLeaseId = 'other-lease'; await assert.rejects(f.prepare())
  f.manager.state.integrationLeaseId = f.lease.leaseId
  assert.deepEqual(f.manager.state, original)
  // 후보가 이미 main의 조상인 상태를 Git plumbing으로 만들되 원 tree와 사용자 파일은 보존한다.
  await git(f.main, 'fetch', f.worker, candidate.integrationBranch)
  const tree = await git(f.main, 'rev-parse', `${candidate.integrationBaseCommit}^{tree}`)
  const integrated = await git(f.main, 'commit-tree', tree, '-p', candidate.integrationBaseCommit, '-p', candidate.integrationHeadCommit, '-m', 'already integrated')
  await git(f.main, 'update-ref', `refs/heads/${f.lease.baseBranch}`, integrated, candidate.integrationBaseCommit)
  await assert.rejects(f.prepare(), /이미 통합/)
  assert.equal(f.manager.state.leases[f.lease.leaseId].status, 'waiting-integration')
  assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
})

test('정정 중 뒤의 완료 결과는 같은 lock 뒤에서 기다리고 정정 통합 후 진행한다', realGit, async t => {
  const f = await fixture(t)
  const secondWorker = path.join(f.root, 'worker-second')
  await git(f.root, 'clone', f.main, secondWorker); await f.config(secondWorker)
  await put(secondWorker, '.ai-workspace.json', JSON.stringify({ workspaceId: 'worker-second', projectRoot: secondWorker }))
  const workspaces = [...f.workspaces, { id: 'worker-second', root: secondWorker, role: 'worker', enabled: true }]
  await writeFile(f.registryFile, JSON.stringify({ schemaVersion: 1, poolId: 'test', sharedRoot: f.sharedRoot, workspaces }))
  const manager = f.createManager(); await manager.initialize()
  const secondScope = { mapId: 'map-test', cardId: 'second-card', conversationId: 'second-owner' }
  const second = await manager.acquire({ workspaceHint: f.main, ...secondScope })
  await put(secondWorker, 'component.txt', 'component\n')
  await manager.checkpoint(second.leaseId, { jobId: second.jobId, ...secondScope, paths: ['component.txt'], commitMessage: message })
  const waiting = await manager.finalize(second.leaseId, { childStatus: 'completed' })
  assert.equal(waiting.blockingLeaseId, f.lease.leaseId)
  assert.equal(aiDelegationRecoveryAvailability({ state: 'waiting-integration', workspaceLease: second, workspaceResult: waiting }), null)
  await manager.prepareIntegrationResultCorrection(f.lease.leaseId, { ...scope, expectedLease: f.lease, operationId, instructionHash: hash })
  assert.deepEqual(await manager.finalize(second.leaseId, { childStatus: 'completed' }), waiting)
  await f.checkpoint(manager)
  await manager.finalize(f.lease.leaseId, { childStatus: 'completed', operationId })
  assert.equal((await manager.finalize(second.leaseId, { childStatus: 'completed' })).status, 'completed')
  assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
  assert.equal(await readFile(path.join(f.main, 'component.txt'), 'utf8'), 'component\n')
})

test('검증불가 dispatch는 정정 자료·lease·통합 lock을 hold로 보존한다', realGit, async t => {
  const f = await fixture(t)
  await f.prepare()
  const previous = structuredClone(f.manager.state.leases[f.lease.leaseId].resultCorrection)
  const held = await f.manager.quarantine(f.lease.leaseId, 'dispatch lease mismatch')
  assert.equal(held.status, 'result-correction-held')
  assert.equal(f.manager.state.integrationLeaseId, f.lease.leaseId)
  assert.deepEqual(f.manager.state.leases[f.lease.leaseId].resultCorrection.previousResult, previous.previousResult)
  const restarted = f.createManager(); await restarted.initialize()
  assert.deepEqual(await restarted.finalize(f.lease.leaseId, { childStatus: 'completed', operationId }), held)
  assert.equal(restarted.recoverableIdleWorkspaceState('worker'), false)
  assert.equal(restarted.publicSnapshot({ conversationId: scope.conversationId }).workspaces.find(item => item.workspaceId === 'worker').assignedToCurrentConversation, true)
  await assert.rejects(restarted.cancel(f.lease.leaseId))
  assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
})

test('새 후보 재구성의 실제 Git 실패는 이전 후보·사용자 파일과 통합 lock을 hold로 보존한다', realGit, async t => {
  const f = await fixture(t)
  await f.prepare(); await f.checkpoint()
  const original = structuredClone(f.manager.state.leases[f.lease.leaseId].resultCorrection)
  const runner = f.manager.git
  let cherryPicks = 0
  f.manager.git = async (cwd, args, options) => {
    if (cwd === f.worker && args[0] === 'cherry-pick') { cherryPicks += 1; throw new Error('검수용 Git 접근 오류') }
    return runner(cwd, args, options)
  }
  await assert.rejects(f.manager.finalize(f.lease.leaseId, { childStatus: 'completed', operationId }), /검수용 Git 접근 오류/)
  assert.equal(cherryPicks, 1)
  assert.equal(f.manager.state.leases[f.lease.leaseId].status, 'result-correction-held')
  assert.equal(f.manager.state.integrationLeaseId, f.lease.leaseId)
  assert.equal(await git(f.worker, 'rev-parse', original.candidateBranch), original.candidateHead)
  assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
  const restarted = f.createManager(); await restarted.initialize()
  assert.equal((await restarted.finalize(f.lease.leaseId, { childStatus: 'completed', operationId })).status, 'result-correction-held')
  assert.equal(restarted.state.integrationLeaseId, f.lease.leaseId)
})

for (const scenario of ['response-loss', 'before-dispatch-restart', 'dispatch-mismatch']) test(`API는 명시 모드·원 owner·lease와 캡처 이력을 보존한다 (${scenario})`, realGit, async t => {
  const f = await fixture(t)
  const dataDirectory = path.join(f.root, 'api-data'); await mkdir(dataDirectory)
  await writeFile(path.join(dataDirectory, '_workspace-pool.json'), JSON.stringify(f.manager.state))
  const now = new Date().toISOString(), resultText = '기존 담당자의 완료 원문'
  const delegation = { id: 'original:icons', mapId: scope.mapId, parentCardId: 'parent', targetCardId: scope.cardId,
    parentConversationId: 'parent-conversation', targetConversationId: scope.conversationId, state: 'waiting-integration',
    childStatus: 'completed', childTurnId: 'original-turn', childOperationId: 'original:icons',
    childResultSnapshot: resultText, childResultHash: createHash('sha256').update(resultText).digest('hex'), childResultTurnId: 'original-turn',
    workspaceLease: f.lease, workspaceResult: f.result, startedBy: 'user-admin', createdAt: now, updatedAt: now }
  await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify([delegation]))
  await writeFile(path.join(dataDirectory, 'map-test.json'), JSON.stringify({ id: scope.mapId, title: '결과 정정 검증', version: 1,
    nodes: [{ id: 'parent', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', status: 'planned', progress: 0, aiConversationId: 'parent-conversation' } },
      { id: scope.cardId, position: { x: 300, y: 0 }, data: { kind: 'task', label: 'icons', status: 'done', progress: 100, isWork: true,
        aiConversationId: scope.conversationId, aiConversations: [{ conversationId: scope.conversationId, agent: { id: 'test-agent', label: '검증 AI' }, model: { id: 'test-model', label: '검증 모델' }, workspace: f.worker }] } }],
    edges: [{ id: 'edge', source: 'parent', target: scope.cardId }] }))
  let posts = [], dispatches = new Map(), dropResponse = true, unavailable = true, ownerMismatch = false
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    const url = new URL(request.url, 'http://localhost')
    const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, data })) }
    if (url.pathname.endsWith('/capabilities')) return send({ schemaVersion: 3, workspaceLeaseVersion: 2, explicitCompletionAfterInterruption: true })
    if (url.pathname === `/api/conversations/${scope.conversationId}`) return send({ id: scope.conversationId, runtime: { state: 'idle', isProcessing: false, pendingConfirmations: 0 }, extra: { workspace: f.worker } })
    if (url.pathname === '/api/internal/conversation-runtimes/active') return send({ items: [] })
    if (url.pathname === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
      posts.push(input)
      if (scenario !== 'before-dispatch-restart' || !dropResponse) dispatches.set(input.operationId, {
        operationId: input.operationId, conversationId: scope.conversationId, state: 'running', turnId: 'corrected-turn',
        workspaceLease: scenario === 'dispatch-mismatch' ? { ...f.lease, jobId: 'wrong-job' } : f.lease })
      if (scenario === 'dispatch-mismatch') return send(dispatches.get(input.operationId), 202)
      if (dropResponse) { response.destroy(); return }
      return send(dispatches.get(input.operationId), 202)
    }
    const operation = url.pathname.match(/^\/api\/internal\/external-conversation-dispatches\/(.+)$/)
    if (operation) {
      const id = decodeURIComponent(operation[1])
      if (id === delegation.childOperationId) return send({ operationId: id, conversationId: ownerMismatch ? 'wrong-owner' : scope.conversationId, state: 'completed', turnId: 'original-turn', workspaceLease: f.lease })
      if (unavailable) return send({}, 503)
      return dispatches.has(id) ? send(dispatches.get(id)) : send({}, 404)
    }
    return send({}, 404)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let server, errors = ''
  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited
    }
  }
  async function start() {
    server = spawn(process.execPath, ['server/index.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MNP_DATA_DIR: dataDirectory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
        MNP_WORKSPACE_POOL_REGISTRY: f.registryFile, MNP_AIONUI_URL: `http://127.0.0.1:${upstream.address().port}`,
        MNP_AI_DELEGATION_POLL_INTERVAL_MS: '60000', MNP_ADMIN_PASSWORD: 'test-correction-password' } })
    server.stderr.on('data', chunk => { errors += chunk })
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(baseUrl + '/api/health')).ok) return } catch { /* 준비 대기 */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(errors)
  }
  try {
    await start()
    const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mind.local', password: 'test-correction-password' }) })
    assert.equal(login.status, 200)
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
    async function loginAfterRestart() {
      const response = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@mind.local', password: 'test-correction-password' }) })
      assert.equal(response.status, 200)
      headers.Cookie = response.headers.get('set-cookie').split(';')[0]
    }
    const endpoint = baseUrl + `/api/maps/map-test/ai-delegations/${encodeURIComponent(delegation.id)}/recover`
    const input = { instruction, expectedUpdatedAt: now, sourceRevision: 1, targetRevision: 1, confirmApprovedScope: true }
    const post = input => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) })
    assert.equal((await post(input)).status, 409)
    ownerMismatch = true
    assert.equal((await post({ ...input, recoveryMode: 'correct-integration-result' })).status, 409)
    assert.equal(posts.length, 0)
    ownerMismatch = false
    const accepted = await post({ ...input, recoveryMode: 'correct-integration-result' })
    if (scenario === 'dispatch-mismatch') {
      const body = await accepted.json()
      assert.equal(accepted.status, 409, JSON.stringify(body))
      assert.equal(body.code, 'AI_DELEGATION_RECOVERY_EXECUTION_MISMATCH')
      const saved = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8'))[0]
      const pool = JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8'))
      assert.equal(saved.resultCorrection.phase, 'held'); assert.equal(saved.pendingRecovery, null)
      assert.equal(pool.leases[f.lease.leaseId].status, 'result-correction-held')
      assert.equal(pool.integrationLeaseId, f.lease.leaseId)
      const session = JSON.parse(await readFile(path.join(f.worker, '.ai-session.json'), 'utf8'))
      assert.equal(session.conversationId, scope.conversationId); assert.equal(session.leaseId, f.lease.leaseId)
      assert.equal(await git(f.worker, 'rev-parse', pool.leases[f.lease.leaseId].resultCorrection.candidateBackupRef), f.result.integrationHeadCommit)
      await stop(); await start(); await loginAfterRestart()
      assert.equal((await post({ ...input, expectedUpdatedAt: saved.updatedAt, recoveryMode: 'correct-integration-result' })).status, 409)
      assert.equal(posts.length, 1)
      assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
      return
    }
    assert.equal(accepted.status, 503, JSON.stringify(await accepted.json()))
    assert.equal(posts.length, 1)
    const saved = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8'))[0]
    assert.equal(saved.pendingRecovery.operationId, 'original:icons-correct-1')
    assert.equal(saved.attemptHistory[0].result, resultText)
    assert.equal(saved.attemptHistory[0].resultHash, delegation.childResultHash)
    assert.equal(saved.attemptHistory[0].resultTurnId, 'original-turn')
    assert.equal(JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8')).integrationLeaseId, f.lease.leaseId)
    await stop(); unavailable = false; dropResponse = false; await start(); await loginAfterRestart()
    const pending = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8'))[0]
    if (scenario === 'before-dispatch-restart') {
      const refresh = await fetch(endpoint.replace(/recover$/, 'refresh'), { method: 'POST', headers,
        body: JSON.stringify({ expectedUpdatedAt: pending.updatedAt }) })
      assert.equal(refresh.status, 409)
      assert.equal(posts.length, 1, 'refresh는 실행 기록이 없어도 저장된 POST를 재전달하지 않습니다.')
    }
    const resumed = await post({ ...input, expectedUpdatedAt: pending.updatedAt, recoveryMode: 'correct-integration-result' })
    const body = await resumed.json()
    assert.equal(resumed.status, 202, JSON.stringify({ body, errors }))
    assert.equal(posts.length, scenario === 'before-dispatch-restart' ? 2 : 1)
    if (scenario === 'before-dispatch-restart') assert.deepEqual(posts[1], posts[0], '같은 operation과 저장된 전문만 재전달합니다.')
    assert.equal(dispatches.size, 1)
    assert.equal(body.delegation.workspaceLease.leaseId, f.lease.leaseId)
    assert.equal(body.delegation.childOperationId, 'original:icons-correct-1')
    assert.equal(body.delegation.childTurnId, 'corrected-turn')
    assert.equal(body.delegation.childResultHash, null)
    assert.equal(body.delegation.pendingRecovery, null)
    assert.equal((await post({ ...input, expectedUpdatedAt: body.delegation.updatedAt, recoveryMode: 'correct-integration-result' })).status, 202)
    assert.equal(posts.length, scenario === 'before-dispatch-restart' ? 2 : 1)
    assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
    if (scenario === 'response-loss') {
      await stop()
      const retained = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8'))[0]
      const endedStates = [
        { state: 'completed', phase: 'dispatched' }, { state: 'superseded', phase: 'dispatched' },
        { state: 'closed', phase: 'dispatched' }, { state: 'completed', phase: 'preparing' },
      ]
      for (const { state, phase } of endedStates) {
        const stage = value => process.stderr.write(`# terminal ${state}/${phase}: ${value}\n`)
        const terminal = { ...retained, state, resultCorrection: { ...retained.resultCorrection, phase },
          childStatus: 'completed', childResultSnapshot: '정정 담당자의 완료 원문', childResultTurnId: 'corrected-turn',
          childResultHash: createHash('sha256').update('정정 담당자의 완료 원문').digest('hex') }
        await writeFile(path.join(dataDirectory, '_ai-delegations.json'), JSON.stringify([terminal]))
        stage('start'); await start()
        stage('login'); await loginAfterRestart()
        const beforeDelegation = JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8'))
        const beforePool = JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8'))
        const postCount = posts.length
        stage('POST')
        const rejected = await post({ ...input, expectedUpdatedAt: terminal.updatedAt, recoveryMode: 'correct-integration-result' })
        assert.equal(rejected.status, 409, JSON.stringify(await rejected.clone().json()))
        assert.equal((await rejected.json()).code, 'AI_DELEGATION_RECOVERY_NOT_REQUIRED')
        assert.deepEqual(JSON.parse(await readFile(path.join(dataDirectory, '_ai-delegations.json'), 'utf8')), beforeDelegation,
          `${state}/${phase} 재요청은 결과와 감사 이력을 포함한 위임 전체를 변경하지 않습니다.`)
        assert.deepEqual(JSON.parse(await readFile(path.join(dataDirectory, '_workspace-pool.json'), 'utf8')), beforePool)
        assert.equal(posts.length, postCount, '종료된 정정 위임은 새 실행을 전달하지 않습니다.')
        stage('stop'); await stop(); stage('stopped')
      }
      assert.deepEqual(await readFile(path.join(f.main, accidental)), userBytes)
    }
  } finally {
    await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  }
})
