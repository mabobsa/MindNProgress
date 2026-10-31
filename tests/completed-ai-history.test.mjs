import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { completedDelegationIds, completedRequestReceipt, completedWorkspaceLeaseIds } from '../server/lib/completedAiHistory.mjs'
import { saveHistoryCleanupBackup, pruneHistoryCleanupBackups, readHistoryCleanupBackup, mergeHistoryCleanupBackup, readCompletedJobResults } from '../server/lib/historyCleanupBackup.mjs'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'
import { RemoteWorkspacePool } from '../server/lib/remoteWorkspacePool.mjs'

const now = Date.parse('2026-10-25T00:00:00Z')
const old = '2026-10-01T00:00:00Z'
const resultHash = 'a'.repeat(64)
const done = (id, extra = {}) => ({ id, state: 'completed', childStatus: 'completed', completedAt: old,
  parentConversationId: 'parent', childResultHash: resultHash,
  reportReceipt: { at: old, method: 'dispatch-delivered', parentConversationId: 'parent', resultHash }, ...extra })
const lease = (id, extra = {}) => ({ leaseId: id, jobId: 'job-' + id, workspaceId: 'fork1', status: 'completed', startedAt: old,
  result: { status: 'completed', completedAt: old }, ...extra })
async function temp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-completed-history-'))
  t.after(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('mnp-completed-history-')) throw Error('임시 경로 검증 실패')
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('7일 경과·명시적 수신·반환이 확인된 완료만 정리하며 복구·최근 변경·모호한 과거 기록은 보존한다', () => {
  const rows = [done('old'), done('recent', { updatedAt: '2026-10-24T00:00:00Z' }),
    done('unreceived', { state: 'waiting-parent' }), done('legacy', { reportReceipt: undefined }),
    done('missing-hash', { childResultHash: undefined }), done('wrong-hash', { childResultHash: 'b'.repeat(64) }),
    done('recovery', { pendingRecovery: {} }), done('archive', { reportArchive: { status: 'failed' } }),
    done('lease', { workspaceLease: { leaseId: 'busy' }, workspaceResult: { status: 'completed' } }),
    done('referenced'), done('parent', { state: 'running', resumesDelegationId: 'referenced' })]
  assert.deepEqual([...completedDelegationIds(rows, { now, leases: { busy: lease('busy', { status: 'leased' }) } })], ['old'])
  assert.deepEqual([...completedDelegationIds([done('old')], { now, extraReferences: [{ sourceDelegationId: 'old' }] })], [])
  assert.deepEqual([...completedDelegationIds([done('six-days', { updatedAt: new Date(now - 6 * 86400000).toISOString() })], { now })], [])
  const withLease = done('old', { workspaceLease: { leaseId: 'l' }, workspaceResult: { status: 'completed' } })
  assert.deepEqual([...completedDelegationIds([withLease], { now, leases: { l: lease('l') }, protectedLeaseIds: new Set(['l']) })], [])
  assert.deepEqual([...completedDelegationIds([withLease], { now, leases: { l: lease('l') }, remoteLeaseIds: new Set(['l']) })], [])
  assert.deepEqual([...completedDelegationIds([withLease], { now, leases: { l: lease('l', { cleanupPending: true }) } })], [])
  assert.equal(Object.hasOwn(completedRequestReceipt(done('old', { childResultSnapshot: '원문', requestSignature: 'signature' })), 'childResultSnapshot'), false)
})

test('완료 lease의 활성 참조·반환 미확인·백업 이후 변경은 삭제에서 제외한다', () => {
  const state = { leases: { a: lease('a'), b: lease('b'), c: lease('c', { status: 'leased', replacesLeaseId: 'b' }) }, workspaces: {} }
  assert.deepEqual([...completedWorkspaceLeaseIds(state, { now })], ['a'])
  const snapshot = structuredClone(state.leases)
  state.leases.a.note = '백업 후 변경'
  assert.deepEqual([...completedWorkspaceLeaseIds(state, { now, expectedLeases: snapshot })], [])
  assert.deepEqual([...completedWorkspaceLeaseIds({ leases: { a: lease('a') } }, { now, remote: true })], [])
})

test('실제 상태 저장 후 완료 상세를 삭제해도 마지막 배정 시각을 유지하고 활성 lease를 보존한다', async (t) => {
  const root = await temp(t)
  const manager = new WorkspacePoolManager({ stateFile: path.join(root, 'state.json') })
  manager.registry = { sharedRoot: root }
  manager.state = { leases: { a: lease('a'), b: lease('b', { workspaceId: 'fork2', status: 'leased' }) }, workspaces: {} }
  await mkdir(path.join(root, 'job-results'))
  await writeFile(path.join(root, 'job-results', 'job-a.json'), JSON.stringify(manager.state.leases.a.result))
  const before = manager.workerLastAssignedAt('fork1')
  assert.equal((await manager.pruneCompletedLeases({ now })).removed, 1)
  assert.equal(manager.workerLastAssignedAt('fork1'), before)
  assert.equal(manager.state.leases.a, undefined); assert.ok(manager.state.leases.b)
  assert.equal(Date.parse(JSON.parse(await readFile(manager.stateFile, 'utf8')).lastAssignedAt.fork1), Date.parse(old))
  await assert.rejects(readFile(path.join(root, 'job-results', 'job-a.json')), { code: 'ENOENT' })
})

test('원격 완료 상세 삭제 후에도 generation과 중복 요청 차단 정보를 유지한다', async (t) => {
  const root = await temp(t)
  const manager = new RemoteWorkspacePool({ stateFile: path.join(root, 'remote.json'), now: () => now })
  manager.state = { leases: { a: lease('a', { requestId: 'request-a', ownership: { machineId: 'mac', poolId: 'pool', generation: 7 },
    result: { status: 'completed', completedAt: old, remoteReleased: true } }) } }
  assert.equal((await manager.pruneCompletedLeases()).removed, 1)
  assert.equal(manager.state.workerGenerations['mac:pool:fork1'], 7)
  assert.equal(manager.state.completedRequests['request-a'], 'a')
  await assert.rejects(manager.acquire({ requestId: 'request-a' }), /REMOTE_WORKSPACE_REQUEST_COMPLETED/)
})

test('복원본은 원문을 손실 없이 복원하고 30일 지난 복원본만 제거한다', async (t) => {
  const root = await temp(t)
  const records = { delegations: [done('old', { childResultSnapshot: '한글 결과 원문\n보존' })], localLeases: { a: lease('a') }, remoteLeases: {} }
  const backup = await saveHistoryCleanupBackup(root, records, now)
  const restored = JSON.parse(gunzipSync(await readFile(backup.file)).toString('utf8'))
  assert.deepEqual(restored.delegations, records.delegations)
  assert.deepEqual(restored.localLeases, records.localLeases)
  await utimes(backup.file, new Date(now), new Date(now))
  assert.equal(await pruneHistoryCleanupBackups(root, now + 29 * 86400000), 0)
  assert.equal(await pruneHistoryCleanupBackups(root, now + 31 * 86400000), 1)
  const blocked = path.join(root, 'cannot-create')
  await writeFile(blocked, '파일이므로 디렉터리를 만들 수 없음')
  await assert.rejects(saveHistoryCleanupBackup(blocked, records, now))
})

test('복원 후보는 현재 배정·잠금·원문과 중복 방지 정보를 덮어쓰지 않는다', async (t) => {
  const root = await temp(t)
  await mkdir(path.join(root, 'job-results'))
  const original = '{"결과":"한글 원문", "진단":true}\n'
  await writeFile(path.join(root, 'job-results', 'job-a.json'), original)
  const localLeases = { a: lease('a') }
  const localResultFiles = await readCompletedJobResults(root, localLeases)
  assert.equal(localResultFiles['job-a'], original)
  const saved = await saveHistoryCleanupBackup(root, { delegations: [done('a'), done('b')],
    localLeases, remoteLeases: {}, localResultFiles }, now)
  const backup = await readHistoryCleanupBackup(saved.file)
  const current = { delegations: [done('a', { childResultSnapshot: '현재 원문' })],
    local: { leases: { active: lease('active', { status: 'leased' }) }, integrationLeaseId: 'active', lastAssignedAt: { fork1: '2026-10-24' } },
    remote: { leases: {}, workerGenerations: { key: 9 }, completedRequests: { request: 'lease' } } }
  const merged = mergeHistoryCleanupBackup(backup, current)
  assert.equal(merged.delegations.find((item) => item.id === 'a').childResultSnapshot, '현재 원문')
  assert.ok(merged.delegations.find((item) => item.id === 'b'))
  assert.deepEqual(merged.local.leases.active, current.local.leases.active)
  assert.equal(merged.local.integrationLeaseId, 'active')
  assert.deepEqual(merged.local.lastAssignedAt, current.local.lastAssignedAt)
  assert.deepEqual(merged.remote, current.remote)
  assert.equal(backup.localResultFiles['job-a'], original)
})

test('복원 내보내기 명령은 현재 파일을 보존하고 데이터 디렉터리 안의 출력을 거부한다', async (t) => {
  const root = await temp(t)
  const data = path.join(root, 'data')
  await mkdir(data)
  const original = JSON.stringify([done('current', { childResultSnapshot: '현재 결과' })])
  await writeFile(path.join(data, '_ai-delegations.json'), original)
  await writeFile(path.join(data, '_workspace-pool.json'), JSON.stringify({ leases: {}, lastAssignedAt: { fork1: old } }))
  await writeFile(path.join(data, '_remote-workspace-pools.json'), JSON.stringify({ leases: {}, coordinatorId: '현재 coordinator' }))
  const backup = await saveHistoryCleanupBackup(root, { delegations: [done('old')], localLeases: { a: lease('a') },
    remoteLeases: {}, localResultFiles: { 'job-a': '{"결과":"원문"}\n' } }, now)
  const script = path.resolve(import.meta.dirname, '../scripts/export-completed-ai-history.mjs')
  const run = (output) => promisify(execFile)(process.execPath, [script, '--data-dir', data, '--backup', backup.file, '--output-dir', output], { windowsHide: true })
  const output = path.join(root, 'review')
  await run(output)
  assert.equal(await readFile(path.join(data, '_ai-delegations.json'), 'utf8'), original)
  const restored = JSON.parse(await readFile(path.join(output, '_ai-delegations.json'), 'utf8'))
  assert.deepEqual(new Set(restored.map((item) => item.id)), new Set(['old', 'current']))
  assert.equal(await readFile(path.join(output, 'job-results', 'job-a.json'), 'utf8'), '{"결과":"원문"}\n')
  await assert.rejects(run(path.join(data, 'unsafe')), /운영 데이터 디렉터리 밖/)
  await assert.rejects(run(output), /EEXIST/)
})
