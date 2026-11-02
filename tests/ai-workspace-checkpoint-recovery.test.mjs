import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { aiDelegationRecoveryAvailability } from '../server/lib/aiDelegations.mjs'
import { checkpointChangedFilesText, rejectedOversizedCheckpointRecoveryPatch,
  workspaceCheckpointInstruction } from '../server/lib/aiWorkspaceCheckpointInstruction.mjs'

const manyFiles = Array.from({ length: 21_543 }, (_, i) => `preparation/실행 기록/검증 자료/translation-${i}/evidence/measurements/translation-stage/report-${i}.json`)
function fixture(id = 'legacy', changedFiles = manyFiles) {
  const at = '2026-11-02T14:11:26.874Z'
  const workspaceLease = { workspaceId: `worker-${id}`, jobId: `job-${id}`, leaseId: `lease-${id}`,
    projectRoot: `C:/isolated/${id}`, branch: `mnp/${id}` }
  const workspaceResult = { status: 'checkpoint-required', checkpointRound: 1, changedFiles, checkpoints: [] }
  return { id, mapId: 'map-test', parentCardId: 'parent', targetCardId: id, targetCardLabel: '삭제 기록 정리',
    parentConversationId: 'parent-chat', targetConversationId: `chat-${id}`, state: 'integration-recovery-required',
    childOperationId: `original-${id}`, childTurnId: 'original-turn', childStatus: 'completed',
    childResultSnapshot: '승인된 범위의 삭제 완료. 체크포인트 생성 대기.', childResultHash: 'preserved-result',
    workspaceLease, workspaceResult, recoveryAttempt: 0, createdAt: at, updatedAt: at,
    pendingRecovery: { operationId: `${id}-integrate-recover-1`, attempt: 1, requestedAt: at,
      integrationRecovery: true, sourceState: 'integration-recovery-required', workspaceLease: { ...workspaceLease } },
    attemptHistory: [{ at, reason: '사용자가 승인 범위의 기존 작업 재개 요청', state: 'integration-recovery-required',
      workspaceLease: { ...workspaceLease }, workspaceResult: { ...workspaceResult } }] }
}

test('21,543개 변경은 제한된 미리보기로 전달하고 전체 범위 확인 지침과 lease는 유지한다', () => {
  const d = fixture()
  const instruction = workspaceCheckpointInstruction(d, d.workspaceResult)
  assert.ok(Buffer.byteLength(manyFiles.map(file => `- ${file}`).join('\n')) > 320 * 1024)
  assert.ok(Buffer.byteLength(instruction) < 10_000)
  assert.match(instruction, /전체 변경 후보: 21543개/)
  assert.match(instruction, /21518개 경로를 생략/)
  assert.ok(instruction.includes(manyFiles[24]))
  assert.ok(!instruction.includes(manyFiles[25]))
  assert.match(instruction, /git status --porcelain=v1 -z --untracked-files=all/)
  assert.match(instruction, /이 요약만으로 체크포인트 범위를 정하지 마세요/)
  assert.match(instruction, /폴더 범위로 대량 추가·수정·삭제/)
  for (const value of Object.values(d.workspaceLease).slice(0, 4)) assert.ok(instruction.includes(value))
})

test('작은 목록·빈 목록은 보존하며 긴 UTF-8 경로도 바이트 제한을 넘기지 않는다', () => {
  const small = ['자료/설명.md', '기록/삭제.json']
  const text = checkpointChangedFilesText(small)
  for (const file of small) assert.ok(text.includes(file))
  assert.ok(!text.includes('생략'))
  assert.match(checkpointChangedFilesText([]), /Git status/)
  for (const files of [[`자료/${'한'.repeat(2_100)}`], Array(25).fill(`자료/${'한'.repeat(200)}`)]) {
    const preview = checkpointChangedFilesText(files)
    assert.ok(Buffer.byteLength(preview) < 7_000)
    assert.match(preview, /경로를 생략/)
    assert.match(preview, /전체 목록은 할당된 projectRoot/)
  }
})

test('과거 초과 요청만 종료하고 결과·lease·완료 보고·복구 알림 회차를 보존한다', () => {
  const d = fixture()
  const before = structuredClone(d)
  const patch = rejectedOversizedCheckpointRecoveryPatch(d)
  assert.equal(patch.pendingRecovery, null)
  assert.equal(patch.rejectedCheckpointRecovery.operationId, d.pendingRecovery.operationId)
  assert.equal(patch.rejectedCheckpointRecovery.attempt, 1)
  assert.equal(patch.rejectedCheckpointRecovery.minimumInstructionBytes,
    Buffer.byteLength(manyFiles.map(file => `- ${file}`).join('\n')))
  const saved = { ...d, ...patch }
  for (const key of ['state', 'childOperationId', 'childTurnId', 'childStatus', 'childResultSnapshot',
    'childResultHash', 'workspaceLease', 'workspaceResult', 'attemptHistory', 'recoveryAttempt']) assert.deepEqual(saved[key], before[key])
  assert.deepEqual(d, before, '판정만으로 원본 기록을 바꾸지 않는다.')
  assert.equal(aiDelegationRecoveryAvailability(saved).recommendedAction, 'resume-existing')
  assert.equal(aiDelegationRecoveryAvailability(saved).recoveryAvailable, true)
  assert.equal(rejectedOversizedCheckpointRecoveryPatch(saved), null)
})

for (const [label, mutate] of [
  ['작은 과거 목록', d => { d.attemptHistory[0].workspaceResult.changedFiles = ['small.txt'] }],
  ['요약 전문을 사용하는 새 요청', d => { d.pendingRecovery.checkpointInstructionVersion = 1 }],
  ['저장된 전문이 있는 요청', d => { d.pendingRecovery.dispatchBody = { instruction: '짧은 실제 전문' } }],
  ['결과 정정 요청', d => { d.pendingRecovery.resultCorrection = true }],
  ['일반 하위 복구', d => { d.pendingRecovery.integrationRecovery = false }],
  ['진행 중인 실행', d => { d.state = 'integration-running' }],
  ['체크포인트 이후 통합', d => { d.workspaceResult = { status: 'waiting-integration' } }],
  ['다른 현재 lease', d => { d.workspaceLease = { ...d.workspaceLease, leaseId: 'other' } }],
  ['다른 시도 lease', d => { d.attemptHistory[0].workspaceLease.leaseId = 'other' }],
  ['다른 시도의 기록', d => { d.attemptHistory[0].at = '2026-11-02T14:12:00Z' }],
  ['다른 기록 종류', d => { d.attemptHistory[0].reason = '상태 조회' }],
  ['당시 목록 없음', d => { d.attemptHistory = [] }],
  ['잘못된 파일 목록', d => { d.attemptHistory[0].workspaceResult.changedFiles = [null] }],
  ['유효하지 않은 시도 번호', d => { d.pendingRecovery.attempt = 0 }],
]) test(`접수되지 않았다고 단정하지 않는다: ${label}`, () => {
  const d = fixture()
  mutate(d)
  assert.equal(rejectedOversizedCheckpointRecoveryPatch(d), null)
})

test('격리 API에서 404+초과 근거만 재개 가능하게 하고 조회 실패·새 요청·실행 중 요청은 보존한다', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-checkpoint-recovery-api-'))
  const cases = [fixture('refresh'), fixture('recover'), fixture('small', ['small.txt']), fixture('modern'), fixture('network'), fixture('accepted')]
  cases.find(d => d.id === 'modern').pendingRecovery.checkpointInstructionVersion = 1
  const map = { id: 'map-test', title: '체크포인트 복구 격리 검증', version: 1,
    nodes: [{ id: 'parent', position: { x: 0, y: 0 }, data: { kind: 'root', label: '상위', aiConversationId: 'parent-chat' } },
      ...cases.map(d => ({ id: d.targetCardId, position: { x: 300, y: 0 }, data: { kind: 'task', label: d.id, aiConversationId: d.targetConversationId } }))], edges: [] }
  await writeFile(path.join(directory, '_ai-delegations.json'), JSON.stringify(cases))
  await writeFile(path.join(directory, 'map-test.json'), JSON.stringify(map))
  const posts = [], gets = []
  const upstream = createServer((request, response) => {
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: status === 200, data })) }
    if (request.method === 'POST') posts.push(request.url)
    if (request.method === 'GET') gets.push(request.url)
    if (request.url.endsWith('/capabilities')) return send(200, { workspaceLeaseVersion: 0, schemaVersion: 3, explicitCompletionAfterInterruption: true })
    if (request.url.endsWith('/active')) return send(200, { items: [] })
    if (request.url.endsWith('/network-integrate-recover-1')) return send(503, {})
    if (request.url.endsWith('/accepted-integrate-recover-1')) {
      const d = cases.find(item => item.id === 'accepted')
      return send(200, { operationId: d.pendingRecovery.operationId, conversationId: d.targetConversationId,
        workspaceLease: d.workspaceLease, state: 'running', turnId: 'existing-turn' })
    }
    return send(404, {})
  })
  const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port }
  const upstreamPort = await listen(upstream), probe = createServer(), port = await listen(probe)
  await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`, repository = path.resolve(import.meta.dirname, '..')
  const origin = `http://127.0.0.1:${upstreamPort}`
  let child, output = ''
  const stop = async () => {
    if (child?.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited }
  }
  t.after(async () => {
    await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mnp-checkpoint-recovery-api-')) throw new Error('격리 검증 폴더 경로 확인 실패')
    await rm(directory, { recursive: true, force: true })
  })
  const start = async () => {
    child = spawn(process.execPath, ['--import', './tests/helpers/isolatedAionUiFetch.mjs', 'server/index.mjs'], {
      cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
        MNP_AIONUI_URL: origin, MNP_TEST_ALLOWED_FETCH_ORIGINS: JSON.stringify([origin]), AIONUI_CONVERSATION_ID: '',
        MNP_AIONUI_DISCOVERY_FILE: path.join(directory, 'missing-discovery.json'), MNP_AIONUI_USAGE_FILE: path.join(directory, 'missing-usage.json'),
        MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'missing-registry.json'), MNP_AI_DELEGATION_POLL_INTERVAL_MS: '600000',
        MNP_ADMIN_EMAIL: 'admin@checkpoint.test', MNP_ADMIN_PASSWORD: 'checkpoint-test-password',
      } })
    const capture = chunk => { output = (output + chunk).slice(-20_000) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(base + '/api/health')).ok) return } catch { /* 격리 서버 기동 대기 */ }
      if (child.exitCode !== null) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(output)
  }
  await start()
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@checkpoint.test', password: 'checkpoint-test-password' }) })
  assert.equal(login.status, 200)
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  const saved = async id => JSON.parse(await readFile(path.join(directory, '_ai-delegations.json'), 'utf8')).find(d => d.id === id)
  for (const d of cases) {
    const action = d.id === 'recover' ? 'recover' : 'refresh'
    const before = await saved(d.id)
    const response = await fetch(`${base}/api/maps/map-test/ai-delegations/${d.id}/${action}`, { method: 'POST', headers,
      body: JSON.stringify({ expectedUpdatedAt: before.updatedAt, sourceRevision: 1, targetRevision: 1,
        confirmApprovedScope: true, instruction: '승인된 기존 작업의 체크포인트를 이어서 진행합니다.' }) })
    const body = await response.json(), after = await saved(d.id)
    if (['refresh', 'recover'].includes(d.id)) {
      assert.equal(response.status, d.id === 'recover' ? 409 : 200, body.error)
      assert.equal(body.executionRequested, false)
      if (d.id === 'recover') assert.equal(body.code, 'AI_DELEGATION_CHECKPOINT_RECOVERY_RETRY_READY')
      assert.equal(body.delegation.recovery.recoveryAvailable, true)
      assert.equal(body.delegation.recovery.recommendedAction, 'resume-existing')
      assert.equal(after.pendingRecovery, null)
      assert.equal(after.rejectedCheckpointRecovery.operationId, d.pendingRecovery.operationId)
      assert.equal(after.rejectedCheckpointRecovery.attempt, 1)
      assert.equal(after.recoveryAttempt, 0, '조회만으로 상위 복구 알림 회차를 증가시키지 않는다.')
    } else if (d.id === 'accepted') {
      assert.equal(response.status, 200, body.error)
      assert.equal(body.executionRequested, false)
      assert.equal(after.state, 'integration-running')
      assert.equal(after.integrationOperationId, d.pendingRecovery.operationId)
      assert.equal(after.integrationTurnId, 'existing-turn')
      assert.equal(after.rejectedCheckpointRecovery, undefined)
    } else {
      assert.equal(response.status, d.id === 'network' ? 500 : 409, body.error)
      if (d.id !== 'network') assert.equal(body.code, 'AI_DELEGATION_STATUS_NOT_FOUND')
      assert.deepEqual(after, before, `${d.id}: 접수 여부가 불명확한 기록을 그대로 보존한다.`)
    }
    for (const key of ['childOperationId', 'childTurnId', 'childResultSnapshot', 'childResultHash', 'workspaceLease', 'workspaceResult', 'attemptHistory']) {
      assert.deepEqual(after[key], before[key], `${d.id}: ${key} 보존`)
    }
    assert.ok(gets.includes(`/api/internal/external-conversation-dispatches/${d.pendingRecovery.operationId}`))
  }
  assert.deepEqual(posts, [], '상태 확인·미접수 정리 과정은 AI를 실행하지 않는다.')
  const settled = await saved('refresh')
  await stop()
  await start()
  assert.deepEqual(await saved('refresh'), settled, '재시작해도 미접수 판정과 재시도 회차 근거를 유지한다.')
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'map-test.json'), 'utf8')).nodes, map.nodes)
  assert.deepEqual(posts, [], '재시작만으로 AI를 실행하지 않는다.')
})
