import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port }
const cases = [
  { state: 'failed', name: '구버전 Git 상태 조회 실패도 복구 버튼용 판정과 멱등 접수를 제공하며 원 결과를 보존한다',
    failureCategory: 'integration-git-status-failed', error: 'Command failed: git status --porcelain --untracked-files=all\n' },
  { state: 'failed', name: '통합 복구 HTTP는 긴 검증 전에 내구 접수를 반환하고 재시작·응답 유실도 같은 요청으로 확인한다',
    failureCategory: 'integration-head-changed', error: '통합 직전에 통합 작업공간의 HEAD가 변경되었습니다.' },
  { state: 'waking-parent', name: '상위 보고가 재개 대기 중이어도 화면에서 통합 잠금 실패를 접수하고 원 결과·권한·중복 방지를 유지한다',
    failureCategory: 'integration-git-lock', error: `Command failed: git merge --ff-only --no-overwrite-ignore ${'c'.repeat(40)}\nfatal: Unable to create 'C:/isolated/integration/.git/index.lock': File exists.\n` },
]
for (const scenario of cases) test(scenario.name, { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-integration-async-api-')), data = path.join(root, 'data')
  await mkdir(data)
  const originalResult = { status: 'quarantined', childStatus: 'completed', branch: 'source', headCommit: 'b'.repeat(40),
    integrationBranch: 'integration', integrationBaseCommit: 'a'.repeat(40), integrationHeadCommit: 'c'.repeat(40),
    integratedCommit: null, error: scenario.error }
  const now = new Date().toISOString(), text = '기존 완료 결과'
  const delegation = { id: 'test-async', mapId: 'map-test', parentCardId: 'parent', targetCardId: 'target',
    parentConversationId: 'parent-chat', targetConversationId: 'target-chat', state: scenario.state, childStatus: 'completed',
    ...(scenario.state === 'waking-parent' ? { wakeOperationId: 'report-operation', parentDispatchState: 'waiting-resume', parentTurnId: 'report-turn' } : {}),
    childOperationId: 'original-operation', childTurnId: 'original-turn', childResultTurnId: 'original-turn',
    childResultSnapshot: text, childResultHash: createHash('sha256').update(text).digest('hex'),
    workspaceLease: { leaseId: 'lease-test' }, workspaceResult: originalResult, startedBy: 'user-admin', createdAt: now, updatedAt: now }
  await writeFile(path.join(data, '_ai-delegations.json'), JSON.stringify([delegation]))
  const map = { id: 'map-test', title: '격리 API 검증', version: 1, nodes: [
    { id: 'parent', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', aiConversationId: 'parent-chat' } },
    { id: 'target', position: { x: 300, y: 0 }, data: { kind: 'task', label: '대상', aiConversationId: 'target-chat' } },
  ], edges: [{ id: 'edge', source: 'parent', target: 'target' }] }
  await writeFile(path.join(data, 'map-test.json'), JSON.stringify(map))
  const paused = [], parentResponses = [], posts = []
  const upstream = createServer((request, response) => {
    const send = value => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: true, data: value })) }
    if (request.method === 'POST') posts.push(request.url)
    if (request.url === '/api/conversations/target-chat') { paused.push(() => { if (!response.destroyed) send({ id: 'target-chat', runtime: { state: 'idle' } }) }); return }
    if (request.url === '/api/internal/external-conversation-dispatches/report-operation') {
      parentResponses.push(() => { if (!response.destroyed) send({ operationId: 'report-operation', conversationId: 'parent-chat', turnId: 'report-turn', state: 'completed' }) })
      return
    }
    if (request.url.endsWith('/capabilities')) return send({ workspaceLeaseVersion: 0 })
    if (request.url.endsWith('/active')) return send({ items: [] })
    response.writeHead(404); response.end('{}')
  })
  const upstreamPort = await listen(upstream), probe = createServer(), port = await listen(probe)
  await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`, repository = path.resolve(import.meta.dirname, '..')
  let child, output = ''
  const start = async () => {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, MNP_DATA_DIR: data, MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_API_HOST: '127.0.0.1',
      MNP_AIONUI_URL: `http://127.0.0.1:${upstreamPort}`, MNP_WORKSPACE_POOL_REGISTRY: path.join(root, 'missing-registry.json'),
      MNP_AI_DELEGATION_POLL_INTERVAL_MS: '100', MNP_ADMIN_EMAIL: 'admin@async.test', MNP_ADMIN_PASSWORD: 'async-test-password',
    } })
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(base + '/api/health')).ok) return } catch { /* 기동 대기 */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(output)
  }
  const stop = async () => { if (child?.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited } }
  t.after(async () => {
    await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('mnp-integration-async-api-')) throw new Error('격리 검증 폴더 경로 확인 실패')
    await rm(root, { recursive: true, force: true })
  })
  await start()
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@async.test', password: 'async-test-password', remember: true }) })
  assert.equal(login.status, 200)
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  const token = (await readFile(path.join(data, '_integration-token'), 'utf8')).trim()
  const readState = async () => {
    const result = await fetch(base + '/api/maps/map-test/ai-delegations', { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(result.status, 200)
    return (await result.json()).delegations.find(d => d.id === 'test-async')
  }
  if (scenario.state === 'waking-parent') {
    for (let attempt = 0; parentResponses.length === 0 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(parentResponses.length, 1, '기존 상위 보고의 상태 확인이 진행 중인 조건을 재현한다.')
  }
  const listed = await readState()
  assert.equal(listed.state, scenario.state)
  assert.equal(listed.recovery.recoveryAvailable, true, '복구 목록에서 통합 재시도 버튼을 제공할 수 있어야 한다.')
  assert.equal(listed.recovery.recommendedAction, 'retry-integration')
  assert.equal(listed.recovery.failureCategory, scenario.failureCategory)
  const input = { recoveryRequestId: 'request-api-test', expectedUpdatedAt: now, sourceRevision: 1, targetRevision: 1, confirmApprovedScope: true, instruction: '완료 결과의 통합만 요청합니다.' }
  const endpoint = base + '/api/maps/map-test/ai-delegations/test-async/recover'
  const post = body => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401)
  const wrongOrigin = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    'X-MNP-AI-Map-Id': 'map-test', 'X-MNP-AI-Card-Id': 'target' }, body: JSON.stringify(input) })
  assert.equal(wrongOrigin.status, 403)
  assert.equal((await wrongOrigin.json()).code, 'AI_DELEGATION_RECOVERY_ORIGIN_MISMATCH')
  assert.equal((await post({ ...input, confirmApprovedScope: false })).status, 400)
  assert.equal((await post({ ...input, expectedUpdatedAt: '오래된 상태' })).status, 409)
  assert.equal((await post({ ...input, targetRevision: 2 })).status, 409)
  const response = await post(input)
  assert.equal(response.status, 202)
  const accepted = await response.json()
  assert.equal(accepted.recovery.status, 'queued')
  assert.equal(accepted.delegation.state, scenario.state, '접수만으로 통합 성공·대기 상태를 만들지 않는다.')
  assert.equal(accepted.recovery.childReexecuted, false)
  assert.equal(accepted.delegation.integrationRecoveryRequest.authorization, undefined)
  assert.equal(JSON.parse(await readFile(path.join(data, '_ai-delegations.json'), 'utf8'))[0].integrationRecoveryRequest.requestId, input.recoveryRequestId)
  assert.equal((await post(input)).status, 202)
  assert.equal((await post({ ...input, instruction: '변경 지시' })).status, 409)
  assert.equal((await fetch(base + '/api/health')).status, 200)
  if (scenario.state === 'waking-parent') {
    for (const release of parentResponses.splice(0)) release()
    // 접수 직전에 시작한 보고 조회가 늦게 완료되어도 복구의 원 상태를 덮어쓰지 않는다.
    await new Promise(resolve => setTimeout(resolve, 250))
    const checking = await readState()
    assert.equal(checking.state, 'waking-parent')
    assert.equal(checking.parentDispatchState, 'waiting-resume')
    assert.equal(checking.integrationRecoveryRequest.status, 'checking')
    assert.equal(checking.recovery.recoveryAvailable, false)
    assert.equal(checking.recovery.recommendedAction, 'refresh-status')
  }
  await stop()
  await start()
  let finished
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const release of paused.splice(0)) release()
    finished = await readState()
    if (finished.integrationRecoveryRequest.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(finished.integrationRecoveryRequest.status, 'failed', output)
  assert.equal(finished.integrationRecoveryRequest.requestId, input.recoveryRequestId)
  assert.match(finished.integrationRecoveryRequest.message, /소유권/)
  assert.deepEqual(finished.workspaceResult, originalResult)
  assert.equal(finished.childTurnId, 'original-turn')
  const saved = JSON.parse(await readFile(path.join(data, '_ai-delegations.json'), 'utf8'))[0]
  assert.equal(saved.childResultSnapshot, text)
  assert.equal(saved.childResultHash, delegation.childResultHash)
  assert.equal(saved.childOperationId, delegation.childOperationId)
  assert.deepEqual(posts, [], '하위 실행·Core 변경 요청을 하지 않는다.')
  assert.deepEqual(JSON.parse(await readFile(path.join(data, 'map-test.json'), 'utf8')).nodes, map.nodes)
})
