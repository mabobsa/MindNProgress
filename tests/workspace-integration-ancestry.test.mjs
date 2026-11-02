import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'
import { integrationCandidateDirtyReasonCode } from '../server/lib/aiDelegations.mjs'

const candidate = 'c'.repeat(40), base = 'a'.repeat(40), advanced = 'd'.repeat(40)
const integration = { root: 'main' }

test('worker에만 보존된 후보는 main 미반영이며 유효하지 않은 객체의 ancestor 검사를 하지 않는다', async () => {
  const calls = []
  const manager = new WorkspacePoolManager({ gitRunner: async (cwd, args) => {
    calls.push({ cwd, args })
    assert.equal(cwd, integration.root)
    assert.deepEqual(args, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    throw Object.assign(new Error('객체 없음'), { code: 1 })
  } })
  assert.equal(await manager.integrationCommitApplied(integration, candidate, advanced), false)
  assert.equal(calls.length, 1, '확인 중 fetch·checkout·merge 또는 working tree 변경을 하면 안 된다.')
})

for (const alreadyApplied of [false, true]) test(`main에 후보 객체가 있는 경우에만 조상 여부를 판정한다: ${alreadyApplied}`, async () => {
  const calls = []
  const manager = new WorkspacePoolManager({ gitRunner: async (cwd, args) => {
    calls.push({ cwd, args })
    if (args[0] === 'rev-parse') return candidate
    assert.deepEqual(args, ['merge-base', '--is-ancestor', candidate, advanced])
    if (!alreadyApplied) throw Object.assign(new Error('조상이 아님'), { code: 1 })
    return ''
  } })
  assert.equal(await manager.integrationCommitApplied(integration, candidate, advanced), alreadyApplied)
  assert.equal(calls.length, 2)
})

test('알 수 없는 Git 오류나 다른 후보는 미반영으로 우회하지 않는다', async () => {
  for (const phase of ['rev-parse', 'merge-base']) {
    const failure = Object.assign(new Error('저장소 오류'), { code: 128 })
    const manager = new WorkspacePoolManager({ gitRunner: async (_cwd, args) => {
      if (args[0] === phase) throw failure
      return candidate
    } })
    await assert.rejects(manager.integrationCommitApplied(integration, candidate, advanced), error => error === failure)
  }
  const manager = new WorkspacePoolManager({ gitRunner: async () => advanced })
  await assert.rejects(manager.integrationCommitApplied(integration, candidate, advanced), /후보 커밋/)
})

test('미반영 후보의 최초 반영은 기존 안전 검사 후 fetch·fast-forward 순서를 유지한다', async () => {
  let mainHead = base, objectAvailable = false, untrackedChecked = false
  const calls = []
  const manager = new WorkspacePoolManager({ gitRunner: async (cwd, args) => {
    calls.push({ cwd, args })
    if (args[0] === 'status') return ''
    if (args[0] === 'branch') return 'japan-master'
    if (args[0] === 'rev-parse') {
      if (args[1] === 'HEAD') return cwd === 'worker' ? candidate : mainHead
      if (!objectAvailable) throw Object.assign(new Error('객체 없음'), { code: 1 })
      return candidate
    }
    if (args[0] === 'fetch') {
      assert.equal(untrackedChecked, true)
      objectAvailable = true
      return ''
    }
    if (args[0] === 'merge') {
      assert.equal(objectAvailable, true)
      assert.deepEqual(args, ['merge', '--ff-only', '--no-overwrite-ignore', candidate])
      mainHead = candidate
      return ''
    }
    throw new Error(`예기치 않은 명령: ${args.join(' ')}`)
  } })
  manager.integrationTrackedChanges = async () => ({ dirty: false, paths: [] })
  manager.integrationUntrackedChanges = async () => { untrackedChecked = true; return [] }
  const lease = { baseBranch: 'japan-master', integrationBaseCommit: base,
    integrationBranch: 'mnp/integrate/job-test', integrationHeadCommit: candidate,
    integrationRecoveryHistory: [{ type: 'integration-head-changed', preservedHead: candidate }] }
  assert.equal(await manager.applyIntegration(lease, { root: 'worker' }, integration), candidate)
  assert.equal(calls.filter(call => call.args[0] === 'fetch').length, 1)
  assert.equal(calls.some(call => call.args[0] === 'merge-base'), false)
})

for (const type of ['integration-git-lock', 'integration-head-changed', integrationCandidateDirtyReasonCode, 'integration-git-status-failed']) {
test(`${type}: 복구 접수 후 finalize도 main에 없는 후보를 재격리하지 않는다`, async () => {
  const source = 'b'.repeat(40), worker = { id: 'fork2', root: 'worker' }
  const lease = { leaseId: 'lease-test', workspaceId: worker.id, status: 'waiting-integration',
    baseBranch: 'japan-master', baseCommit: base, headCommit: source, commits: [source],
    integrationBranch: 'mnp/integrate/job-test', integrationBaseCommit: base, integrationHeadCommit: candidate,
    integrationRecoveryHistory: [{ type, preservedHead: candidate }], result: { status: 'waiting-integration' } }
  let objectChecks = 0, integrationCalls = 0
  const manager = new WorkspacePoolManager({ gitRunner: async (cwd, args) => {
    if (args[0] === 'status' || args[0] === 'diff') return ''
    if (args[0] === 'branch') return cwd === worker.root ? lease.integrationBranch : lease.baseBranch
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return cwd === worker.root ? candidate : base
    if (cwd === integration.root && args[0] === 'rev-parse' && args.at(-1) === `${candidate}^{commit}`) {
      objectChecks++
      throw Object.assign(new Error('객체 없음'), { code: 1 })
    }
    if (cwd === worker.root && args[0] === 'merge-base' && args[2] === base && args[3] === source) return ''
    throw new Error(`예기치 않은 명령: ${cwd}: ${args.join(' ')}`)
  } })
  manager.registry = { integration, workspaces: [worker] }
  manager.state = { leases: { [lease.leaseId]: lease }, workspaces: { [worker.id]: { leaseId: lease.leaseId } } }
  manager.persist = async () => {}
  manager.gitPathExists = async () => false
  manager.applyIntegration = async () => { integrationCalls++; return candidate }
  manager.completeLease = async (_lease, _worker, result) => result
  manager.quarantineIntegrationFailure = async (_lease, _worker, error) => error
  const completed = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.integratedCommit, candidate)
  assert.equal(objectChecks, 1)
  assert.equal(integrationCalls, 1)
})
}
