import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createResourceQueue, currentStorageBudget } from './storageBudget.mjs'
import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { WorkspacePoolManager, WorkspacePoolUnavailableError, integrationWorktreeDirtyReasonCode } from './workspacePool.mjs'
import { RemoteWorkspaceArtifacts } from './remoteWorkspaceArtifacts.mjs'
import { aiDelegationBusyDispatchRejected, aiDelegationWorkspaceLeaseMatches } from './aiDelegations.mjs'
import { completedWorkspaceLeaseIds } from './completedAiHistory.mjs'
import { assertAiDelegationInterruptedLease } from './aiDelegationInterruptedRecovery.mjs'
import { REMOTE_STAGING_PHASE, STAGING_RECREATED, remoteStagingHold, remoteStagingHoldReason } from './remoteStagingFailure.mjs'
import { REMOTE_WORKSPACE_VERSION, identifier, commitId, git, hasCommit, jsonFile, saveJson, stableHash, workspaceError, assignmentMatches } from './remoteWorkspaceProtocol.mjs'

// staging 준비 중 Git 오류를 구분된 사유 코드와 요약으로 바꾼다. 파일별 오류 전문은 남기지 않는다.
function stagingError(error) {
  const failure = remoteStagingHoldReason(error)
  return Object.assign(workspaceError(failure.reasonCode, failure.message), failure.details ? { details: failure.details } : {})
}

// Remote paths are identities reported by the authenticated Runner, never local paths.
function workspaceIdentity(root) {
  if (typeof root !== 'string' || !root.trim()) return null
  const raw = root.trim().replaceAll('\\', '/')
  const value = path.posix.normalize(raw).replace(/\/$/, '')
  return /^[a-z]:\//i.test(raw) || raw.startsWith('//') ? value.toLowerCase() : value
}

export const UNSTARTED_RELEASE = 'unstarted'
const UNSTARTED_OPERATIONS = new Set(['prepare', 'bind', 'quarantine'])
// 외부 호출 뒤 서버 재검증 단계의 코드는 Runner가 반환을 처리했는지 알려 주지 않는다.
const UNCONFIRMED_RELEASE_CODES = new Set(['REMOTE_WORKSPACE_RESPONSE_PENDING', 'REMOTE_WORKSPACE_REVALIDATION_PENDING',
  'REMOTE_WORKSPACE_RESERVATION_CHANGED', 'REMOTE_WORKSPACE_REGISTRATION_MISMATCH', 'REMOTE_WORKSPACE_OPERATION_PENDING',
  'REMOTE_WORKSPACE_RECOVERY_REQUIRED'])

// 서버 기록으로 하위 실행 흔적이 없는 lease인지 확인한다. 체크포인트·봉인·재사용·복구 명령이 있으면 반환하지 않는다.
function assertUnstartedLease(lease) {
  const operations = Object.values(lease.operations ?? {})
  if (lease.sealed || lease.headCommit || lease.checkpoints?.length || lease.recoveryHistory?.length || lease.pendingOperation
    || !['leased', 'quarantined'].includes(lease.status)
    || !operations.some((operation) => operation.action === 'prepare')
    || operations.some((operation) => !UNSTARTED_OPERATIONS.has(operation.action)
      && !(operation.action === 'release' && operation.options?.cancel === true))
    || operations.some((operation) => ['prepare', 'bind'].includes(operation.action) && !assignmentMatches(lease, operation.lease))) {
    throw unstartedEvidenceError()
  }
}

function unstartedEvidenceError() {
  return workspaceError('REMOTE_WORKSPACE_UNSTARTED_EVIDENCE_REQUIRED', '하위 실행이 시작되지 않았다는 근거를 확인하지 못해 작업공간 격리를 유지했습니다.')
}

// Runner가 반환 명령을 처리하고 거절 코드를 돌려준 경우만 결정적 거절로 본다. 전송·응답 오류는 미확정이다.
function definitiveRunnerRejection(error) {
  const code = String(error?.reasonCode ?? error?.code ?? '')
  return /^(REMOTE_WORKSPACE_|MNP_WORKSPACE_)/.test(code) && !UNCONFIRMED_RELEASE_CODES.has(code)
}

export class RemoteWorkspacePool {
  constructor({ local, stateFile, mainMachineId, callRunner, now = () => Date.now() }) {
    Object.assign(this, { local, stateFile, mainMachineId, callRunner, now })
    this.root = path.join(path.dirname(stateFile), 'remote-workspaces')
    this.artifacts = new RemoteWorkspaceArtifacts(path.join(this.root, 'artifacts'))
    this.queue = createResourceQueue()
    this.queueContext = new AsyncLocalStorage()
    this.reservations = new Map()
    this.artifactQueues = new Map()
    this.artifactLocks = createResourceQueue()
    this.stages = new Map()
  }
  async exclusive(action) {
    const scope = { release: await this.queue.acquire('state:remote-workspace-pool'), active: true }
    try { return await this.queueContext.run(scope, action) }
    finally { scope.active = false; scope.release?.() }
  }
  async outside(lease, action, { checkPool = true } = {}) {
    const scope = this.queueContext.getStore()
    if (!scope?.active) return this.exclusive(() => this.outside(lease, action, { checkPool }))
    if (lease && this.reservations.has(lease.leaseId)) throw workspaceError('REMOTE_WORKSPACE_OPERATION_PENDING')
    const token = randomUUID()
    const snapshot = stableHash(lease ?? this.state.pools)
    const pool = lease && this.state.pools[this.key(lease.ownership.machineId, lease.poolId)]
    const registryDigest = pool?.registryDigest
    if (lease) this.reservations.set(lease.leaseId, token)
    scope.release(); scope.release = null
    const started = Date.now()
    let value, failure
    try { value = await action() } catch (error) { failure = error }
    const budget = currentStorageBudget()
    if (budget) budget.externalWaitMs += Date.now() - started
    // 실행된 외부 예약의 회수·결과 확인은 요청 취소로 생략하지 않는다.
    try { scope.release = await this.queue.acquire('state:remote-workspace-pool', 'write', null) }
    catch (error) {
      // 영속 pendingOperation은 보존하되 재접수 가능한 요청을 메모리 예약으로 영구 차단하지 않는다.
      if (lease && this.reservations.get(lease.leaseId) === token) this.reservations.delete(lease.leaseId)
      if (lease) throw Object.assign(workspaceError('REMOTE_WORKSPACE_REVALIDATION_PENDING', '외부 작업 이후 로컬 재검증을 완료하지 못했습니다. 보존된 같은 작업으로 결과를 확인하세요.'), {
        status: 503, outcome: 'processing', retryable: false, storageResourceError: true, cause: error,
      })
      throw error
    }
    if (!lease) {
      if (failure) throw failure
      if (stableHash(this.state.pools) !== snapshot) throw workspaceError('REMOTE_WORKSPACE_REGISTRATION_MISMATCH')
      return value
    }
    const valid = this.reservations.get(lease.leaseId) === token && this.state.leases[lease.leaseId] === lease && stableHash(lease) === snapshot
    if (this.reservations.get(lease.leaseId) === token) this.reservations.delete(lease.leaseId)
    if (!valid) throw workspaceError('REMOTE_WORKSPACE_RESERVATION_CHANGED')
    if (failure) throw failure
    if (checkPool) {
      const current = this.pool(lease.ownership.machineId).pool
      if (current.registryDigest !== registryDigest || current.poolId !== lease.poolId) throw workspaceError('REMOTE_WORKSPACE_REGISTRATION_MISMATCH')
    }
    return value
  }
  persist() { return saveJson(this.stateFile, this.state) }
  pruneCompletedLeases(options = {}) {
    return this.exclusive(async () => {
      if (!this.state) return { removed: 0 }
      const leases = Object.values(this.state.leases)
      const ids = completedWorkspaceLeaseIds(this.state, { now: this.now(), ...options, remote: true })
      for (const id of this.reservations.keys()) ids.delete(id)
      if (!ids.size) return { removed: 0 }
      const previous = this.state
      const generations = { ...previous.workerGenerations }
      const completedRequests = { ...previous.completedRequests }
      for (const lease of leases) {
        const key = `${lease.ownership.machineId}:${lease.ownership.poolId}:${lease.workspaceId}`
        generations[key] = Math.max(generations[key] ?? 0, lease.ownership.generation)
        if (ids.has(lease.leaseId) && lease.requestId) completedRequests[lease.requestId] = lease.leaseId
      }
      this.state = { ...previous, workerGenerations: generations, completedRequests,
        leases: Object.fromEntries(Object.entries(previous.leases).filter(([id]) => !ids.has(id))) }
      try { await this.persist() } catch (error) { this.state = previous; throw error }
      for (const id of ids) this.stages.delete(id)
      return { removed: ids.size }
    })
  }
  async initialize() {
    const stored = await jsonFile(this.stateFile)
    this.state = stored ?? { schemaVersion: 1, coordinatorId: `mnp-${randomUUID()}`, pools: {}, reports: {}, leases: {} }
    identifier(this.state.coordinatorId)
    if (!stored) await this.persist()
  }
  key(machineId, poolId) { return `${identifier(machineId)}:${identifier(poolId)}` }
  async observe(machineId, report) {
    return this.exclusive(async () => {
      if (!report) {
        if (this.state.reports[machineId]) this.state.reports[machineId].receivedAt = 0
        await this.persist(); return
      }
      if (report.version !== REMOTE_WORKSPACE_VERSION || report.machineId !== machineId
        || report.coordinatorId !== this.state.coordinatorId || !Array.isArray(report.workspaces)
        || report.workspaces.length > 32) throw workspaceError('REMOTE_WORKSPACE_REPORT_INVALID')
      identifier(report.poolId)
      if (!/^[a-f0-9]{64}$/.test(report.registryDigest ?? '') || typeof report.sharedRoot !== 'string'
        || !report.sharedRoot || report.sharedRoot.length > 4096 || typeof report.originUrl !== 'string'
        || !report.originUrl || report.originUrl.length > 4096) throw workspaceError('REMOTE_WORKSPACE_REPORT_INVALID')
      const ids = new Set(), roots = new Set()
      for (const worker of report.workspaces) {
        identifier(worker.workspaceId); commitId(worker.headCommit)
        if (!Number.isSafeInteger(worker.generation) || worker.generation < 0 || typeof worker.dirty !== 'boolean'
          || typeof worker.runtimeIdle !== 'boolean') throw workspaceError('REMOTE_WORKSPACE_REPORT_INVALID')
        if (typeof worker.projectRoot !== 'string' || !worker.projectRoot || worker.projectRoot.length > 4096
          || ids.has(worker.workspaceId) || roots.has(worker.projectRoot)) throw workspaceError('REMOTE_WORKSPACE_REPORT_INVALID')
        ids.add(worker.workspaceId); roots.add(worker.projectRoot)
      }
      this.state.reports[machineId] = { ...report, receivedAt: this.now() }
      await this.persist()
    })
  }
  async approve(machineId, { poolId, registryDigest, enabled }) {
    return this.exclusive(async () => {
      const key = this.key(machineId, poolId)
      if (typeof enabled !== 'boolean') throw workspaceError('REMOTE_WORKSPACE_REGISTRATION_INVALID')
      if (!enabled) {
        if (this.state.pools[key]) this.state.pools[key].enabled = false
        await this.persist(); return this.snapshot(machineId)
      }
      const report = this.report(machineId)
      if (!this.local.registry?.integration || report.version !== REMOTE_WORKSPACE_VERSION
        || report.poolId !== poolId || report.registryDigest !== registryDigest
        || report.originUrl !== this.local.registry.originUrl
        || report.workspaces.some((worker) => worker.originUrl !== report.originUrl)) throw workspaceError('REMOTE_WORKSPACE_REGISTRATION_MISMATCH')
      const previous = this.state.pools[key]
      if (previous && (previous.registryDigest !== registryDigest || previous.protocolVersion !== REMOTE_WORKSPACE_VERSION)
        && Object.values(this.state.leases).some((lease) => lease.ownership.machineId === machineId
          && lease.poolId === poolId && lease.status !== 'completed')) throw workspaceError('REMOTE_WORKSPACE_REGISTRY_BUSY')
      this.state.pools[key] = { enabled: true, machineId, poolId, registryDigest, protocolVersion: REMOTE_WORKSPACE_VERSION,
        originUrl: report.originUrl,
        workspaces: report.workspaces.map((worker) => ({ ...worker })), approvedAt: new Date(this.now()).toISOString() }
      await this.persist(); return this.snapshot(machineId)
    })
  }
  report(machineId) {
    const report = this.state.reports[machineId]
    if (!report || this.now() - report.receivedAt > 180_000) throw workspaceError('REMOTE_WORKSPACE_RUNNER_STALE')
    return report
  }
  pool(machineId) {
    if (!this.local.registry?.integration || !this.local.state) throw workspaceError('REMOTE_WORKSPACE_MAIN_POOL_UNAVAILABLE')
    const report = this.report(machineId)
    if (report.version !== REMOTE_WORKSPACE_VERSION) throw workspaceError('REMOTE_WORKSPACE_RUNNER_VERSION_MISMATCH')
    const pool = this.state.pools[this.key(machineId, report.poolId)]
    if (!pool?.enabled || pool.protocolVersion !== REMOTE_WORKSPACE_VERSION
      || pool.registryDigest !== report.registryDigest) throw workspaceError('REMOTE_WORKSPACE_POOL_NOT_APPROVED')
    return { pool, report }
  }
  hasLease(id) { return Boolean(this.state?.leases[id]) }
  publicLease(lease) {
    const { checkpoints, result: _result, operations: _operations, sealed: _sealed, pendingOperation: _pendingOperation, ...publicFields } = lease
    return { ...publicFields, checkpointCount: checkpoints?.length ?? 0 }
  }
  poolForWorkspace(root, machineId) {
    if (machineId && machineId === this.mainMachineId()) return null
    // Include unapproved observations so a managed Fork never falls through to ordinary dispatch.
    const identity = workspaceIdentity(root)
    if (!identity) return null
    const report = [...Object.values(this.state?.reports ?? {}), ...Object.values(this.state?.pools ?? {})].find((item) => (!machineId || item.machineId === machineId)
      && item.workspaces.some((worker) => workspaceIdentity(worker.projectRoot) === identity))
    if (report) return report
    // A missing observation must not turn an existing managed lease into ordinary dispatch.
    const lease = Object.values(this.state?.leases ?? {}).find((item) => (!machineId || item.ownership.machineId === machineId)
      && workspaceIdentity(item.projectRoot) === identity)
    return lease ? { machineId: lease.ownership.machineId, poolId: lease.poolId, originUrl: lease.originUrl } : null
  }
  snapshot(machineId) {
    const reports = Object.values(this.state?.reports ?? {}).filter((report) => !machineId || report.machineId === machineId)
    return { coordinatorId: this.state?.coordinatorId, remotePools: reports.map((report) => ({
      ...report, approved: Boolean(report.version === REMOTE_WORKSPACE_VERSION && this.state.pools[this.key(report.machineId, report.poolId)]?.enabled
        && this.state.pools[this.key(report.machineId, report.poolId)].protocolVersion === REMOTE_WORKSPACE_VERSION
        && this.state.pools[this.key(report.machineId, report.poolId)].registryDigest === report.registryDigest),
      stale: this.now() - report.receivedAt > 180_000,
      workspaces: report.workspaces.map((worker) => {
        const lease = Object.values(this.state.leases).find((item) => item.ownership.machineId === report.machineId
          && item.poolId === report.poolId && item.workspaceId === worker.workspaceId && item.status !== 'completed')
        return { ...worker, role: 'worker', machineId: report.machineId, poolId: report.poolId,
          status: lease?.status ?? worker.status, leaseId: lease?.leaseId ?? worker.leaseId }
      }),
    })) }
  }
  workspaceSnapshot({ machineId, conversationId = '' } = {}) {
    const snapshot = this.snapshot(machineId)
    const pool = snapshot.remotePools[0]
    const workspaces = (pool?.workspaces ?? []).map((worker) => ({ ...worker, enabled: Boolean(pool.approved && !pool.stale),
      assignedToCurrentConversation: Boolean(conversationId && Object.values(this.state.leases).some((lease) => lease.conversationId === conversationId
        && lease.ownership.machineId === machineId && lease.workspaceId === worker.workspaceId && lease.status !== 'completed')) }))
    const statusCounts = {}
    for (const worker of workspaces) statusCounts[worker.status] = (statusCounts[worker.status] ?? 0) + 1
    return { ...snapshot, available: Boolean(pool?.approved && !pool?.stale), poolId: pool?.poolId ?? null,
      integrationWorkspaceId: null, workspaces, statusCounts }
  }
  async command(lease, action, options = {}) {
    const body = { action, lease: this.publicLease(lease), options }
    // Persist the complete immutable body: later binding/status changes must not change retries.
    const key = action === 'checkpoint' ? `checkpoint-${identifier(options.requestId)}` : `${action}-${stableHash(options).slice(0, 32)}`
    lease.operations ??= {}
    if (lease.operations[key] && stableHash(lease.operations[key].options) !== stableHash(options)) throw workspaceError('REMOTE_WORKSPACE_OPERATION_CONFLICT')
    const operation = lease.operations[key] ??= { ...body, operationId: `${action}-${stableHash(body).slice(0, 48)}` }
    if (lease.pendingOperation && lease.pendingOperation !== operation.operationId) throw workspaceError('REMOTE_WORKSPACE_OPERATION_PENDING')
    const alreadyPending = Boolean(lease.pendingOperation)
    lease.pendingOperation = operation.operationId
    await this.persist()
    try {
      const result = await this.outside(lease, () => this.callRunner(lease.ownership.machineId, '/mnp/workspaces', { method: 'POST', body: operation, timeoutMs: 600_000 }))
      delete lease.pendingOperation
      await this.persist()
      return result
    } catch (error) {
      if (error.storageResourceError && ['REQUEST_DEADLINE_EXCEEDED', 'REQUEST_CANCELLED'].includes(error.code)) {
        if (error.externalOperationStarted || alreadyPending) {
          // 응답만 중단되었을 수 있다. 같은 영속 명령으로 결과를 확인하기 전에는 변경 없음을 단정하지 않는다.
          throw Object.assign(workspaceError('REMOTE_WORKSPACE_RESPONSE_PENDING', '외부 작업의 결과가 아직 확인되지 않았습니다. 보존된 같은 작업으로 결과를 확인하세요.'), {
            status: 503, outcome: 'processing', retryable: false, retryAfterMs: 250, storageResourceError: true, cause: error,
          })
        }
        // 이번에 처음 준비한 명령이 외부 호출 전에 거부된 경우만 예약을 취소한다.
        delete lease.pendingOperation
        await this.persist()
      }
      if ([error.reasonCode, error.code].some((code) => ['REMOTE_WORKSPACE_RUNTIME_ACTIVE', 'REMOTE_WORKSPACE_DIRTY', 'AI_WORKSPACE_CHECKPOINT_PATH_REJECTED'].includes(code))) {
        delete lease.pendingOperation
        await this.persist()
      }
      // Runner checkpoints reuse WorkspacePoolManager.checkpoint, so its path guard codes are surfaced unchanged.
      if (/^(REMOTE_|MNP_WORKSPACE_|AI_WORKSPACE_CHECKPOINT_)/.test(error.code ?? '')) error.reasonCode = error.code
      throw error
    }
  }
  async cleanupCompletedLease(lease) {
    if (lease.status !== 'completed' || !lease.cleanupPending) return
    if (this.reservations.has(lease.leaseId)) return
    await this.outside(lease, async () => {
    const artifactKeys = ['baseline', 'result', 'release'].map((kind) => `${lease.leaseId}:${kind}`)
    // Closing the lease rejects new requests; drain accepted reads/writes before deleting their files.
    await Promise.all(artifactKeys.map((key) => (this.artifactQueues.get(key) ?? Promise.resolve()).catch(() => {})))
    await this.artifacts.cleanup(lease.leaseId)
    const stagingRoot = path.join(this.root, 'staging', lease.leaseId)
    const legacyRecovery = await lstat(path.join(stagingRoot, 'workspace-drift')).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    const removalOptions = { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }
    if (legacyRecovery) {
      // Older completed results already reference this path. Keep their recovery data and receipts in place.
      await rm(path.join(stagingRoot, 'repository'), removalOptions)
      await rm(path.join(stagingRoot, 'state.json'), removalOptions)
    } else await rm(stagingRoot, removalOptions)
    }, { checkPool: false })
    this.stages.delete(lease.leaseId)
    const artifactKeys = ['baseline', 'result', 'release'].map((kind) => `${lease.leaseId}:${kind}`)
    for (const key of artifactKeys) this.artifactQueues.delete(key)
    lease.cleanupPending = false
    await this.persist()
  }
  async cleanupCompletedLeases() {
    for (const lease of Object.values(this.state.leases)) {
      if (lease.status === 'completed' && lease.cleanupPending) {
        try { await this.cleanupCompletedLease(lease) } catch {
          throw workspaceError('REMOTE_WORKSPACE_CLEANUP_REQUIRED')
        }
      }
    }
  }
  async acquire(options) {
    return this.exclusive(async () => {
      await this.cleanupCompletedLeases()
      const { machineId, requestId, mapId, cardId, conversationId = '', cardLabel } = options
      identifier(requestId)
      if (this.state.completedRequests?.[requestId]) throw workspaceError('REMOTE_WORKSPACE_REQUEST_COMPLETED')
      const prior = Object.values(this.state.leases).find((lease) => lease.requestId === requestId)
      if (prior) {
        if (this.reservations.has(prior.leaseId)) throw workspaceError('REMOTE_WORKSPACE_OPERATION_PENDING')
        if (prior.ownership.machineId !== machineId || prior.mapId !== mapId || prior.cardId !== cardId) throw workspaceError('REMOTE_WORKSPACE_REQUEST_CONFLICT')
        if (prior.status === 'preparing') {
          const prepared = await this.command(prior, 'prepare')
          if (!assignmentMatches(prior, prepared.lease)) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
          prior.status = 'leased'; await this.persist()
        }
        if (prior.status !== 'leased') throw workspaceError('REMOTE_WORKSPACE_RECOVERY_REQUIRED')
        return this.publicLease(prior)
      }
      const { pool, report } = this.pool(machineId)
      const knownHint = this.local.poolForWorkspace(options.workspaceHint) ? null
        : this.poolForWorkspace(options.workspaceHint, machineId) ?? this.poolForWorkspace(options.workspaceHint)
      if (knownHint && (knownHint.originUrl !== pool.originUrl || knownHint.machineId !== machineId
        || knownHint.poolId !== pool.poolId)) throw workspaceError('REMOTE_WORKSPACE_SCOPE_MISMATCH')
      const changes = await this.outside(null, () => this.local.integrationTrackedChanges())
      if (changes.dirty) throw new WorkspacePoolUnavailableError('통합 작업공간의 미커밋 변경을 먼저 정리해야 합니다.', changes.paths, integrationWorktreeDirtyReasonCode)
      const worker = report.workspaces.find((candidate) => candidate.status === 'idle' && !candidate.dirty && candidate.runtimeIdle
        && !candidate.leaseId && !Object.values(this.state.leases).some((lease) => lease.ownership.machineId === machineId
          && lease.workspaceId === candidate.workspaceId && lease.status !== 'completed'))
      if (!worker) throw new WorkspacePoolUnavailableError('사용 가능한 원격 worker가 없습니다.', [], 'CAPACITY_EXHAUSTED')
      const integration = this.local.registry.integration
      const workerSnapshot = stableHash(worker)
      const { baseBranch, baseCommit, baselineCommit, baselineMode } = await this.outside(null, async () => {
      const baseBranch = await git(integration.root, ['branch', '--show-current'])
      if (!baseBranch) throw workspaceError('REMOTE_WORKSPACE_BASE_BRANCH_INVALID')
      const baseCommit = commitId(await git(integration.root, ['rev-parse', 'HEAD']))
      const baselineCommit = commitId(worker.headCommit)
      if (baselineCommit !== baseCommit) {
        if (!await hasCommit(integration.root, baselineCommit)) throw workspaceError('REMOTE_WORKSPACE_BOOTSTRAP_REQUIRED')
        try { await git(integration.root, ['merge-base', '--is-ancestor', baselineCommit, baseCommit]) } catch (error) {
          if (error.code === 1) throw workspaceError('REMOTE_WORKSPACE_BOOTSTRAP_REQUIRED')
          throw error
        }
      }
      const baselineMode = baselineCommit === baseCommit ? 'present' : 'delta'
      return { baseBranch, baseCommit, baselineCommit, baselineMode }
      })
      const currentWorker = this.pool(machineId).report.workspaces.find((candidate) => candidate.workspaceId === worker.workspaceId)
      if (stableHash(currentWorker ?? null) !== workerSnapshot || Object.values(this.state.leases).some((lease) =>
        lease.ownership.machineId === machineId && lease.workspaceId === worker.workspaceId && lease.status !== 'completed')) {
        throw new WorkspacePoolUnavailableError('예약 전에 원격 worker 상태가 변경되었습니다.', [], 'CAPACITY_EXHAUSTED')
      }
      const jobId = `job-${randomUUID()}`, leaseId = `lease-${randomUUID()}`
      const generationKey = `${machineId}:${pool.poolId}:${worker.workspaceId}`
      const generation = Math.max(worker.generation ?? 0, this.state.workerGenerations?.[generationKey] ?? 0, ...Object.values(this.state.leases).filter((item) => item.ownership.machineId === machineId && item.workspaceId === worker.workspaceId).map((item) => item.ownership.generation)) + 1
      const lease = { poolId: pool.poolId, workspaceId: worker.workspaceId, jobId, leaseId, requestId,
        ownership: { coordinatorId: this.state.coordinatorId, machineId, poolId: pool.poolId, generation },
        projectRoot: worker.projectRoot, sharedRoot: report.sharedRoot, assetsPath: worker.assetsPath, unityInstanceHash: worker.unityInstanceHash,
        branch: `mnp/${jobId}`, baseBranch, baseCommit, baselineCommit, baselineMode, mapId, cardId, cardLabel, conversationId,
        status: 'preparing', startedAt: new Date().toISOString(), checkpoints: [] }
      this.state.leases[leaseId] = lease
      this.state.workerGenerations ??= {}
      this.state.workerGenerations[generationKey] = generation
      await this.persist()
      if (baselineMode === 'delta') {
        await this.outside(lease, async () => {
        const file = this.artifacts.file(leaseId, 'baseline')
        await mkdir(path.dirname(file), { recursive: true })
        await git(integration.root, ['bundle', 'create', file, `${baselineCommit}..refs/heads/${baseBranch}`])
        if (await git(integration.root, ['rev-parse', 'HEAD']) !== baseCommit) throw workspaceError('REMOTE_WORKSPACE_BASE_MOVED')
        await this.artifacts.publish(leaseId, 'baseline')
        })
      }
      const prepared = await this.command(lease, 'prepare')
      if (!assignmentMatches(lease, prepared.lease)) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
      lease.status = 'leased'; await this.persist()
      return this.publicLease(lease)
    }).catch(async (error) => {
      const lease = Object.values(this.state.leases).find((item) => item.requestId === options.requestId)
      if (lease) {
        error.workspaceLease = this.publicLease(lease)
      }
      throw error
    })
  }
  async retryPreparation(id, { confirmed, expectedLeaseId, generation } = {}) {
    const lease = this.scoped(id)
    if (!confirmed || lease.status !== 'preparing' || expectedLeaseId !== id || generation !== lease.ownership.generation) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_CONFIRMATION_REQUIRED')
    try {
      return await this.acquire({ machineId: lease.ownership.machineId, requestId: lease.requestId, mapId: lease.mapId, cardId: lease.cardId, conversationId: lease.conversationId, cardLabel: lease.cardLabel })
    } catch (error) {
      // These gates precede reservation/Git mutation. Other failures require receipt inspection.
      if (!['REMOTE_WORKSPACE_RUNTIME_ACTIVE', 'REMOTE_WORKSPACE_DIRTY'].includes(error.reasonCode ?? error.code)) throw error
      return this.exclusive(async () => {
        const prepared = await this.command(lease, 'prepare', { retryToken: randomUUID() })
        if (!assignmentMatches(lease, prepared.lease)) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
        lease.status = 'leased'; await this.persist()
        return this.publicLease(lease)
      })
    }
  }
  scoped(leaseId, options = {}) {
    const lease = this.state.leases[identifier(leaseId)]
    if (!lease) throw workspaceError('REMOTE_WORKSPACE_LEASE_NOT_FOUND')
    if (this.reservations.has(lease.leaseId) && !options.allowPending) throw workspaceError('REMOTE_WORKSPACE_OPERATION_PENDING')
    for (const key of ['mapId', 'cardId', 'conversationId']) {
      if (options[key] !== undefined && lease[key] !== options[key]) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
    }
    return lease
  }
  async bindConversation(id, conversationId) {
    return this.exclusive(async () => {
      const lease = this.scoped(id)
      if (!['leased', 'checkpoint-required'].includes(lease.status)) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_REQUIRED')
      if (lease.conversationId && lease.conversationId !== conversationId) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
      await this.command(lease, 'bind', { conversationId })
      lease.conversationId = conversationId; await this.persist()
      return this.publicLease(lease)
    })
  }
  async reuseLease(id, options) {
    return this.exclusive(async () => {
      if (!options?.mapId || !options.cardId || !options.conversationId) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
      const lease = this.scoped(id, options)
      if (lease.sealed || !['leased', 'checkpoint-required'].includes(lease.status)) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_REQUIRED')
      await this.command(lease, 'reuse', { ...options, attempt: randomUUID() })
      return this.publicLease(lease)
    })
  }
  async checkpoint(id, options) {
    return this.exclusive(async () => {
      const lease = this.scoped(id, options)
      if (lease.sealed) throw workspaceError('REMOTE_WORKSPACE_RESULT_SEALED')
      if (!['leased', 'checkpoint-required'].includes(lease.status)) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_REQUIRED')
      identifier(options.requestId)
      const result = await this.command(lease, 'checkpoint', options)
      if (result.checkpoint && !lease.checkpoints.some((entry) => entry.requestId === options.requestId)) lease.checkpoints.push({ ...result.checkpoint, requestId: options.requestId })
      lease.status = 'leased'; await this.persist()
      return { ...result, lease: this.publicLease(lease) }
    })
  }
  async stage(lease) {
    if (this.stages.has(lease.leaseId)) return this.stages.get(lease.leaseId)
    const root = path.join(this.root, 'staging', lease.leaseId)
    const stateFile = path.join(root, 'state.json'), workerPath = path.join(root, 'repository')
    await mkdir(root, { recursive: true })
    let state = await jsonFile(stateFile)
    if (!state) {
      // state 저장 전에 멈춘 staging 저장소는 통합에 쓰인 적 없는 파생 복제본이다. 지우지 않고 옆으로 옮겨 다시 만든다.
      const leftover = await lstat(workerPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
      if (leftover) {
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
        await rename(workerPath, path.join(root, `repository.incomplete-${stamp}-${randomUUID().slice(0, 8)}`))
      }
      // Keep staging refs and worktree separate while borrowing the integration repo's immutable Git objects.
      try { await git(this.local.registry.integration.root, ['-c', 'core.longpaths=true', 'clone', '--shared', '--no-checkout', '--single-branch', '--branch', lease.baseBranch,
        this.local.registry.integration.root, workerPath]) }
      catch (error) { throw stagingError(error) }
      // staging은 데이터 폴더 아래 깊은 경로에 만들어진다. Windows 기본 경로 한도를 넘는 Unity 경로도 꺼낼 수 있게
      // Git 긴 경로 지원을 켠다. Windows가 아닌 OS에서는 Git이 이 설정을 무시한다.
      await git(workerPath, ['config', 'core.longpaths', 'true'])
      for (const key of ['user.name', 'user.email']) {
        const identity = await git(this.local.registry.integration.root, ['config', '--get', key]).catch((error) => {
          if (error.code === 1) return null
          throw error
        })
        // Preserve configured identities without inventing a user or replacing Git's normal fallback.
        if (identity) await git(workerPath, ['config', key, identity])
      }
      await git(workerPath, ['remote', 'set-url', 'origin', this.local.registry.originUrl])
      // A clone does not inherit local checkout/ignore policy, including exclusions for lease metadata.
      for (const file of ['attributes', 'exclude']) {
        const source = path.resolve(this.local.registry.integration.root,
          await git(this.local.registry.integration.root, ['rev-parse', '--git-path', `info/${file}`]))
        const target = path.resolve(workerPath, await git(workerPath, ['rev-parse', '--git-path', `info/${file}`]))
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(source, target).catch((error) => { if (error.code !== 'ENOENT') throw error })
      }
      if (!['delta', 'present'].includes(lease.resultMode) || (lease.resultMode === 'present' && lease.headCommit !== lease.baseCommit)) {
        throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
      }
      try {
        if (lease.resultMode === 'delta') {
          await git(workerPath, ['bundle', 'verify', this.artifacts.file(lease.leaseId, 'result')])
          await git(workerPath, ['fetch', '--no-tags', this.artifacts.file(lease.leaseId, 'result'),
            `refs/heads/${lease.branch}:refs/heads/${lease.branch}`])
          await git(workerPath, ['switch', lease.branch])
        } else await git(workerPath, ['switch', '-c', lease.branch, lease.baseCommit])
      } catch (error) {
        // 결과를 꺼내는 Git 출력에는 프로젝트 전체의 파일별 오류가 섞인다. 구분된 사유와 요약만 남긴다.
        throw stagingError(error)
      }
      if (await git(workerPath, ['rev-parse', 'HEAD']) !== lease.headCommit) throw workspaceError('REMOTE_WORKSPACE_RESULT_HEAD_MISMATCH')
      await git(workerPath, ['merge-base', '--is-ancestor', lease.baseCommit, lease.headCommit])
      const staged = { ...lease, projectRoot: workerPath, status: 'leased', result: null }
      await saveJson(path.join(workerPath, '.ai-session.json'), staged)
      state = { leases: { [lease.leaseId]: staged }, workspaces: { [lease.workspaceId]: { status: 'leased', leaseId: lease.leaseId } }, integrationLeaseId: null }
      await saveJson(stateFile, state)
    }
    const manager = new WorkspacePoolManager({ stateFile })
    manager.registry = { ...this.local.registry, sharedRoot: path.join(this.root, 'recovery', lease.leaseId),
      workers: [{ id: lease.workspaceId, root: workerPath, role: 'worker' }],
      workspaces: [this.local.registry.integration, { id: lease.workspaceId, root: workerPath, role: 'worker' }] }
    manager.state = state
    const persist = manager.persist.bind(manager)
    manager.persist = async () => {
      await persist()
      this.local.state.integrationLeaseId = manager.state.integrationLeaseId
      await this.local.persist()
    }
    manager.runExclusive = (action) => this.local.runExclusive(async () => {
      manager.state.integrationLeaseId = this.local.state.integrationLeaseId
      return action()
    })
    this.stages.set(lease.leaseId, manager)
    return manager
  }
  async finalize(id, options = {}) {
    return this.exclusive(async () => {
      const lease = this.scoped(id)
      if (['completed', 'quarantined'].includes(lease.status)) return lease.result ?? null
      if (options.childStatus !== 'completed') return this.hold(lease, options.childError ?? '하위 실행이 완료되지 않았습니다.')
      if (!lease.sealed) {
        const sealed = await this.command(lease, 'seal', { checkpointRound: lease.checkpoints.length })
        if (sealed.status === 'checkpoint-required') {
          lease.status = sealed.status; lease.result = { ...sealed, leaseId: id, jobId: lease.jobId }
          await this.persist(); return lease.result
        }
        if (sealed.status !== 'sealed') throw workspaceError('REMOTE_WORKSPACE_RESULT_INVALID')
        if (sealed.resultMode === 'delta') {
          const manifest = await this.artifacts.manifest(id, 'result')
          if (stableHash(manifest) !== stableHash(sealed.manifest)) throw workspaceError('REMOTE_WORKSPACE_ARTIFACT_HASH_MISMATCH')
        } else if (sealed.resultMode !== 'present' || sealed.headCommit !== lease.baseCommit || sealed.manifest !== null) {
          throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
        }
        lease.headCommit = commitId(sealed.headCommit); lease.checkpoints = sealed.checkpoints; lease.sealed = true
        lease.resultMode = sealed.resultMode
        lease.remoteDriftArchives = sealed.remoteDriftArchives ?? []
        lease.status = 'waiting-integration'; await this.persist()
      }
      let stage
      try { stage = await this.outside(lease, () => this.stage(lease)) } catch (error) {
        if (error.storageResourceError) throw error
        // staging 준비는 메인 통합 저장소를 바꾸기 전 단계다. 봉인 결과를 보존하고 구분된 사유로 격리한다.
        const failure = remoteStagingHoldReason(error)
        return this.hold(lease, failure.message, { reasonCode: failure.reasonCode, phase: REMOTE_STAGING_PHASE, childStatus: 'completed',
          stagingRoot: path.join(this.root, 'staging', lease.leaseId), ...(failure.details ? { details: failure.details } : {}) })
      }
      let result
      try { result = await this.outside(lease, () => stage.finalize(id, options)) } catch (error) {
        return this.hold(lease, error.message, { stagedResult: stage.state.leases[id].result, stagingRoot: stage.state.leases[id].projectRoot, reasonCode: error.reasonCode ?? error.code })
      }
      if (result?.status === 'awaiting-conflict-resolution') {
        return this.hold(lease, '원격 결과의 메인 staging 통합 충돌입니다. staging에서 명시적으로 복구해야 합니다.', { stagedResult: result, stagingRoot: stage.state.leases[id].projectRoot, reasonCode: 'REMOTE_INTEGRATION_CONFLICT_MANUAL_REVIEW' })
      }
      if (result?.status !== 'completed') {
        lease.status = result?.status ?? 'waiting-integration'; lease.result = result
        await this.persist(); return result
      }
      return this.release(lease, result)
    })
  }
  async release(lease, result) {
    lease.status = 'release-pending'; lease.result = { ...result, status: 'waiting-integration', phase: 'release-pending' }
    await this.persist()
    await this.prepareRelease(lease)
    const released = await this.command(lease, 'release', { integratedCommit: lease.releaseCommit })
    if (!released.released || released.idleCommit !== lease.releaseCommit) throw workspaceError('REMOTE_WORKSPACE_RELEASE_MISMATCH')
    lease.status = 'completed'; lease.result = { ...result, remoteReleased: true, remoteDriftArchives: released.remoteDriftArchives ?? lease.remoteDriftArchives ?? [] }
    lease.cleanupPending = true
    await this.persist()
    // A cleanup failure never turns a confirmed remote release back into an incomplete lease.
    await this.cleanupCompletedLease(lease).catch(() => {})
    return lease.result
  }
  // 반환 기준 커밋과 증분 bundle은 처음 한 번만 정해 저장한다. 재시도는 저장된 값으로 같은 영수증을 쓴다.
  async prepareRelease(lease, { requireBaseAncestor = false } = {}) {
    if (!lease.releaseCommit) {
      const integration = this.local.registry.integration
      const { integratedCommit, releaseMode } = await this.outside(lease, async () => {
      const integratedCommit = commitId(await git(integration.root, ['rev-parse', 'HEAD']))
      if (await git(integration.root, ['branch', '--show-current']) !== lease.baseBranch
        || await git(integration.root, ['rev-parse', 'HEAD']) !== integratedCommit) throw workspaceError('REMOTE_WORKSPACE_BASE_MOVED')
      // 결과 없는 반환은 메인이 원 기준선에서 이어진 경우만 증분을 만든다. 이력이 바뀌었으면 반환하지 않는다.
      if (requireBaseAncestor && integratedCommit !== lease.baseCommit) {
        try { await git(integration.root, ['merge-base', '--is-ancestor', lease.baseCommit, integratedCommit]) } catch (error) {
          if (error.code === 1) throw workspaceError('REMOTE_WORKSPACE_BASE_DIVERGED', '메인 이력이 원 기준선에서 이어지지 않아 작업공간을 반환하지 않았습니다.')
          throw error
        }
      }
      const releaseMode = [lease.baseCommit, lease.headCommit].includes(integratedCommit) ? 'present' : 'delta'
      if (releaseMode === 'delta') {
        const file = this.artifacts.file(lease.leaseId, 'release')
        await mkdir(path.dirname(file), { recursive: true })
        await git(integration.root, ['bundle', 'create', file, `${lease.baseCommit}..refs/heads/${lease.baseBranch}`])
        if (await git(integration.root, ['rev-parse', 'HEAD']) !== integratedCommit) throw workspaceError('REMOTE_WORKSPACE_BASE_MOVED')
        await this.artifacts.publish(lease.leaseId, 'release')
      }
      return { integratedCommit, releaseMode }
      })
      lease.releaseMode = releaseMode; lease.releaseCommit = integratedCommit; await this.persist()
    }
    if (!['present', 'delta'].includes(lease.releaseMode)) throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
  }
  // 하위 실행 전에 끝난 lease만 결과 없이 반환한다. 근거가 하나라도 맞지 않으면 기존 계약대로 격리를 유지한다.
  // evidence.kind=before-dispatch는 서버가 dispatch 전송 전임을 확인한 호출이다. 그 밖에는 최신 Runner 보고가 이 lease를 반영해야 한다.
  async releaseUnstarted(id, { reason, evidence = null } = {}) {
    return this.exclusive(async () => {
      const lease = this.scoped(id)
      if (lease.status === 'completed' && lease.result?.releaseKind === UNSTARTED_RELEASE) return lease.result
      // 이미 반환 명령을 보냈을 수 있으면 보고 대신 같은 영수증으로만 결과를 확인한다.
      if (!(lease.status === 'release-pending' && lease.unstartedRelease?.attempt)) {
        assertUnstartedLease(lease)
        const { pool, report } = this.pool(lease.ownership.machineId)
        const worker = report.workspaces.find((item) => item.workspaceId === lease.workspaceId)
        const reflected = worker?.leaseId === id
        if (pool.poolId !== lease.poolId || !worker || (worker.leaseId && !reflected)
          || (evidence?.kind !== 'before-dispatch' && !reflected)
          || (reflected && (worker.projectRoot !== lease.projectRoot || worker.generation !== lease.ownership.generation
            || worker.branch !== lease.branch || worker.headCommit !== lease.baseCommit || worker.dirty || !worker.runtimeIdle
            || !['leased', 'quarantined'].includes(worker.status)))) throw unstartedEvidenceError()
        if (this.local.state.integrationLeaseId) throw workspaceError('REMOTE_WORKSPACE_INTEGRATION_BUSY', '메인 통합이 진행 중이라 작업공간 반환을 보류했습니다.')
        const releaseReason = String(reason ?? '').trim() || '하위 실행 전 실패로 작업공간을 결과 없이 반환합니다.'
        lease.unstartedRelease = { reason: releaseReason, evidence, previousStatus: lease.status, previousResult: lease.result ?? null,
          requestedAt: new Date(this.now()).toISOString(), attempt: randomUUID(), attempts: lease.unstartedRelease?.attempts ?? [] }
        lease.status = 'release-pending'
        lease.result = { status: 'release-pending', releaseKind: UNSTARTED_RELEASE, leaseId: id, jobId: lease.jobId, reason: releaseReason }
        await this.persist()
      }
      let stage = 'prepare', released
      try {
        await this.prepareRelease(lease, { requireBaseAncestor: true })
        stage = 'command'
        released = await this.command(lease, 'release', { integratedCommit: lease.releaseCommit, cancel: true, attempt: lease.unstartedRelease.attempt })
      } catch (error) {
        // 명령 전 실패나 Runner가 결정적으로 거절한 경우만 원래 격리로 되돌린다. 전달 결과 미확정은 같은 시도로만 다시 확인한다.
        if (!error.storageResourceError && (stage === 'prepare' || definitiveRunnerRejection(error))) await this.restoreUnstartedQuarantine(lease, error)
        throw error
      }
      if (!released?.released || released.idleCommit !== lease.releaseCommit) throw workspaceError('REMOTE_WORKSPACE_RELEASE_MISMATCH')
      const completedAt = new Date(this.now()).toISOString()
      lease.unstartedRelease = { ...lease.unstartedRelease, completedAt }
      lease.status = 'completed'
      lease.result = { status: 'cancelled', releaseKind: UNSTARTED_RELEASE, leaseId: id, jobId: lease.jobId,
        reason: lease.unstartedRelease.reason, idleCommit: released.idleCommit, releaseMode: lease.releaseMode, remoteReleased: true,
        remoteDriftArchives: released.remoteDriftArchives ?? [], previousResult: lease.unstartedRelease.previousResult ?? null, completedAt }
      lease.cleanupPending = true
      await this.persist()
      // A cleanup failure never turns a confirmed remote release back into an incomplete lease.
      await this.cleanupCompletedLease(lease).catch(() => {})
      return lease.result
    })
  }
  async restoreUnstartedQuarantine(lease, error) {
    const release = lease.unstartedRelease
    const code = error?.reasonCode ?? error?.code ?? null
    release.attempts = [...(release.attempts ?? []), { attempt: release.attempt, code, failedAt: new Date(this.now()).toISOString() }].slice(-20)
    release.attempt = null
    if (release.previousStatus === 'quarantined') {
      lease.status = 'quarantined'; lease.result = release.previousResult
      await this.persist()
      return
    }
    // dispatch 전 자동 반환이 실패하면 기존 계약대로 격리를 Runner에도 전달한다.
    await this.hold(lease, release.reason, { unstartedReleaseFailure: code })
  }
  async hold(lease, reason, details = {}) {
    if (lease.status === 'completed') return lease.result
    lease.status = 'quarantined'; lease.result = { status: 'quarantined', leaseId: lease.leaseId, jobId: lease.jobId, reason, ...details }
    await this.persist()
    // Failure to deliver quarantine is not evidence that the worker stopped.
    await this.command(lease, 'quarantine', { reason }).catch(() => {})
    return lease.result
  }
  quarantine(id, reason) { return this.exclusive(() => this.hold(this.scoped(id), reason)) }
  cancel(id, reason) { return this.quarantine(id, reason ?? '원격 작업 취소: 실행 여부 확인 후 명시적 복구가 필요합니다.') }
  async reactivateQuarantinedLease(id, options) {
    return this.exclusive(async () => {
      if (!options?.mapId || !options.cardId || !options.conversationId) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
      const lease = this.scoped(id, options)
      if (options.failureCategory === 'upstream-interrupted') assertAiDelegationInterruptedLease(lease, options.interruptedProof, options)
      if (!['quarantined', 'leased'].includes(lease.status)
        || !['confirmed-dispatch', 'recovery-dispatch-busy', 'upstream-interrupted', 'usage-limit', 'rate-limit', 'model-capacity'].includes(options.failureCategory)
        || options.failureCategory === 'recovery-dispatch-busy' && (!aiDelegationBusyDispatchRejected(options.rejectedDispatch, options.conversationId, options.rejectedDispatch?.operationId)
          || !aiDelegationWorkspaceLeaseMatches(lease, options.rejectedDispatch.workspaceLease))
        || options.failureCategory === 'confirmed-dispatch' && !aiDelegationWorkspaceLeaseMatches(lease, options.confirmedDispatchLease)) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_PROOF_REQUIRED')
      if (lease.sealed) throw workspaceError('REMOTE_WORKSPACE_RESULT_SEALED')
      await this.command(lease, 'recover', { ...options, attempt: randomUUID() })
      if (options.failureCategory === 'upstream-interrupted' && lease.result) {
        lease.recoveryHistory = [...(lease.recoveryHistory ?? []), { interruptedProof: options.interruptedProof, previousResult: lease.result }].slice(-20)
      }
      lease.status = 'leased'; lease.result = null; await this.persist()
      return this.publicLease(lease)
    })
  }
  async retryIntegration(id, { confirmed = false, expectedHead } = {}) {
    return this.exclusive(async () => {
      const lease = this.scoped(id)
      if (!lease.sealed) throw workspaceError('REMOTE_WORKSPACE_RESULT_NOT_SEALED')
      if (lease.status === 'completed') return lease.result
      // 이미 통합 대기로 돌려보낸 staging 재생성은 다시 만들지 않고 같은 기록을 돌려준다.
      if (lease.status === 'waiting-integration' && lease.result?.phase === STAGING_RECREATED) return lease.result
      const stage = await this.outside(lease, () => this.stage(lease))
      const head = await this.outside(lease, () => git(stage.state.leases[id].projectRoot, ['rev-parse', 'HEAD']))
      if (!confirmed || commitId(expectedHead) !== head) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_CONFIRMATION_REQUIRED')
      if (stage.state.leases[id].status === 'completed') return this.release(lease, stage.state.leases[id].result)
      // staging 준비에서 멈춘 lease는 staging 통합을 시도한 기록이 없다. 새로 만든 staging으로 일반 통합 대기에 돌려보내고
      // 실제 통합은 위임 대기열의 기존 finalize 경로가 이어서 수행한다.
      if (lease.status === 'quarantined' && remoteStagingHold(id, lease.result)
        && stage.state.leases[id].status === 'leased' && !stage.state.leases[id].result) {
        lease.status = 'waiting-integration'
        lease.result = { status: 'waiting-integration', leaseId: id, jobId: lease.jobId, childStatus: 'completed',
          phase: STAGING_RECREATED, previousResult: lease.result ?? null }
        await this.persist()
        return lease.result
      }
      const result = await this.outside(lease, () => stage.state.leases[id].status === 'awaiting-conflict-resolution'
        ? stage.completeConflictResolution(id, { childStatus: 'completed' }) : stage.recoverCheckpointedFinalizationFailure(id))
      lease.status = result?.status ?? 'waiting-integration'; lease.result = result
      await this.persist()
      return result?.status === 'completed' ? this.release(lease, result) : result
    })
  }
  async artifactRequest(machineId, leaseId, kind, suffix, method, body) {
    const validate = () => {
      const lease = this.scoped(leaseId, { allowPending: true })
      if (lease.ownership.machineId !== machineId || !['baseline', 'result', 'release'].includes(kind)) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
      if (lease.status === 'completed') throw workspaceError('REMOTE_WORKSPACE_ARTIFACT_LEASE_COMPLETED')
      if (kind === 'result' ? method !== 'POST' || lease.sealed : method !== 'GET') throw workspaceError('REMOTE_WORKSPACE_ARTIFACT_DIRECTION_INVALID')
    }
    validate()
    const key = `${leaseId}:${kind}`
    const action = async () => {
      // Ownership and lifecycle may change while this request waits behind another artifact operation.
      validate()
      if (method === 'GET' && suffix === 'manifest') return this.artifacts.manifest(leaseId, kind)
      const chunk = /^chunks\/(\d+)$/.exec(suffix)
      if (method === 'GET' && chunk) return this.artifacts.chunk(leaseId, kind, Number(chunk[1]))
      if (method === 'POST' && chunk && Number(chunk[1]) === body?.chunk?.index) return this.artifacts.receive(leaseId, kind, body.manifest, body.chunk)
      if (method === 'POST' && suffix === 'complete') return this.artifacts.finish(leaseId, kind)
      throw workspaceError('REMOTE_WORKSPACE_ARTIFACT_REQUEST_INVALID')
    }
    const previous = this.artifactQueues.get(key) ?? Promise.resolve()
    const result = this.artifactLocks.acquire(`state:remote-artifact/${key}`).then(async (release) => {
      try { return await action() } finally { release() }
    })
    const pending = Promise.allSettled([previous, result])
    this.artifactQueues.set(key, pending)
    void pending.then(() => { if (this.artifactQueues.get(key) === pending) this.artifactQueues.delete(key) })
    return result
  }
}

export function remoteWorkspaceFacade(local, remote) {
  const resolvePoolHint = ({ machineId, poolId }) => {
    identifier(poolId)
    if (machineId === remote.mainMachineId()) {
      if (local.registry?.poolId !== poolId || !local.registry?.integration?.root) {
        throw workspaceError('AI_WORKSPACE_POOL_SCOPE_MISMATCH', '요청한 작업공간 풀이 실행 머신의 풀과 일치하지 않습니다.')
      }
      return local.registry.integration.root
    }
    const { pool, report } = remote.pool(machineId)
    if (pool.poolId !== poolId || !report.workspaces[0]?.projectRoot) {
      throw workspaceError('AI_WORKSPACE_POOL_SCOPE_MISMATCH', '요청한 작업공간 풀이 실행 머신의 풀과 일치하지 않습니다.')
    }
    // 풀 식별용 힌트이며 실제 유휴 worker 선택과 lease 배정은 acquire가 원자적으로 수행한다.
    return report.workspaces[0].projectRoot
  }
  const methods = new Set(['bindConversation', 'reuseLease', 'checkpoint', 'finalize', 'cancel', 'quarantine', 'reactivateQuarantinedLease'])
  const unsupported = new Set(['completeConflictResolution', 'resumeIntegrationConflict', 'prepareIntegrationResultCorrection', 'resumeIntegrationResultCorrection',
    'recoverCheckpointedFinalizationFailure', 'recoverLegacyDirtyIntegration', 'recoverLocalChangesIntegrationFailure', 'recoverUntrackedIntegrationFailure',
    'recoverIntegrationHeadChangedFailure', 'recoverIntegrationCandidateWorktreeFailure', 'recoverIntegrationGitStatusFailure', 'recoverCheckpointIntegrationFailure', 'releasePreservedIntegrationFailure'])
  return new Proxy(local, { get(target, property) {
    if (property === 'resolvePoolHint') return resolvePoolHint
    if (property === 'state') return target.state ? { ...target.state, leases: { ...target.state.leases, ...remote.state?.leases } } : target.state
    if (property === 'initialize') return async (options) => { await remote.initialize(); return target.initialize(options) }
    if (property === 'poolForWorkspace') return (root, machineId) => remote.poolForWorkspace(root, machineId)
      ?? target.poolForWorkspace(root) ?? remote.poolForWorkspace(root)
    if (property === 'publicSnapshot') return (options) => options?.machineId && options.machineId !== remote.mainMachineId()
      ? remote.workspaceSnapshot(options) : ({ ...target.publicSnapshot(options), ...remote.snapshot() })
    if (property === 'acquire') return (options) => {
      const machineId = options.machineId || remote.mainMachineId()
      const prior = Object.values(remote.state?.leases ?? {}).find((lease) => lease.requestId === options.requestId)
      if (options.workspacePoolId) {
        const workspaceHint = resolvePoolHint({ machineId, poolId: options.workspacePoolId })
        if (prior && (prior.poolId !== options.workspacePoolId || prior.ownership.machineId !== machineId)) {
          throw workspaceError('AI_WORKSPACE_POOL_SCOPE_MISMATCH')
        }
        return machineId === remote.mainMachineId()
          ? target.acquire({ ...options, workspaceHint }) : remote.acquire({ ...options, machineId, workspaceHint })
      }
      const managed = remote.poolForWorkspace(options.workspaceHint, machineId) ?? remote.poolForWorkspace(options.workspaceHint)
      if (prior || managed) {
        if ((prior?.ownership.machineId ?? managed.machineId) !== machineId) throw workspaceError('REMOTE_WORKSPACE_SCOPE_MISMATCH')
        return remote.acquire({ ...options, machineId })
      }
      if (machineId !== remote.mainMachineId()) {
        if (target.poolForWorkspace(options.workspaceHint)) throw workspaceError('REMOTE_WORKSPACE_SCOPE_MISMATCH')
        return null
      }
      return target.acquire(options)
    }
    if (property === 'releaseUnstarted') return (id, ...args) => {
      if (!remote.hasLease(id)) throw workspaceError('REMOTE_WORKSPACE_LEASE_NOT_FOUND')
      return remote.releaseUnstarted(id, ...args)
    }
    // dispatch 전송 전 실패만 사용한다. 원격 lease는 실행 흔적이 없을 때 반환하고, 근거가 부족하면 기존 계약대로 격리한다.
    if (property === 'cancelBeforeDispatch') return async (id, reason) => {
      if (!remote.hasLease(id)) return target.cancel(id, reason)
      try { return await remote.releaseUnstarted(id, { reason, evidence: { kind: 'before-dispatch' } }) } catch (error) {
        if (error.storageResourceError) throw error
        const current = remote.state.leases[id]
        // 반환 결과가 미확정이면 같은 시도로만 확인한다. 격리로 덮어쓰지 않는다.
        if (['release-pending', 'quarantined', 'completed'].includes(current?.status)) return current.result ?? null
        return remote.quarantine(id, reason)
      }
    }
    if (methods.has(property)) return (id, ...args) => {
      if (property === 'reuseLease' && args[0]?.workspacePoolId) {
        const { workspacePoolId, machineId = remote.mainMachineId() } = args[0]
        resolvePoolHint({ machineId, poolId: workspacePoolId })
        const lease = remote.state?.leases?.[id] ?? target.state?.leases?.[id]
        if (!lease || lease.poolId !== workspacePoolId || (lease.ownership?.machineId ?? remote.mainMachineId()) !== machineId) {
          throw workspaceError('AI_WORKSPACE_POOL_SCOPE_MISMATCH')
        }
      }
      return remote.hasLease(id) ? remote[property](id, ...args) : target[property](id, ...args)
    }
    if (unsupported.has(property)) return (id, ...args) => {
      if (remote.hasLease(id)) throw workspaceError('REMOTE_WORKSPACE_EXPLICIT_RECOVERY_REQUIRED')
      return target[property](id, ...args)
    }
    const value = target[property]
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
