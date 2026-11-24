import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createResourceQueue, currentStorageBudget } from './storageBudget.mjs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { WorkspacePoolUnavailableError, integrationStatusRetryReasonCode, integrationUntrackedCollisionMessage, integrationUntrackedCollisionReasonCode,
  integrationWorktreeDirtyMessage, integrationWorktreeDirtyReasonCode } from './workspacePool.mjs'
import { RemoteWorkspaceArtifacts } from './remoteWorkspaceArtifacts.mjs'
import { aiDelegationBusyDispatchRejected, aiDelegationWorkspaceLeaseMatches } from './aiDelegations.mjs'
import { completedWorkspaceLeaseIds } from './completedAiHistory.mjs'
import { assertAiDelegationInterruptedLease } from './aiDelegationInterruptedRecovery.mjs'
import { INTEGRATION_REQUEUED, REMOTE_INTEGRATION_PHASE, remoteIntegrationFailureReason } from './remoteIntegrationFailure.mjs'
import { LONG_GIT_TIMEOUT_MS, committerIdentity, createRangeBundle, fetchBundle, isAncestor, linearCommits, openIntegrationStore, replayCommits } from './remoteObjectIntegration.mjs'
import { REMOTE_INTEGRATION_ROUND_LIMIT, REMOTE_WORKSPACE_VERSION, identifier, commitId, git, hasCommit, jsonFile, remoteArtifactKind, saveJson, stableHash, workspaceError, assignmentMatches } from './remoteWorkspaceProtocol.mjs'

// 원격 통합은 메인에서 이 회수만큼 하위 AI 충돌 해결을 요청한다. 로컬 Fork의 충돌 해결 한도와 같다.
const REMOTE_CONFLICT_ROUND_LIMIT = 3
// 같은 lease의 다른 외부 처리나 메인 상태 확인 지연은 격리하지 않고 다음 확인에서 다시 통합한다.
const TRANSIENT_INTEGRATION_CODES = new Set(['REMOTE_WORKSPACE_OPERATION_PENDING', 'REMOTE_WORKSPACE_RESERVATION_CHANGED', integrationStatusRetryReasonCode])

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
    const { checkpoints, result: _result, operations: _operations, sealed: _sealed, pendingOperation: _pendingOperation,
      integration: _integration, integrationHistory: _integrationHistory, releaseResult: _releaseResult, ...publicFields } = lease
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
    const artifactKeys = () => [...this.artifactQueues.keys()].filter((key) => key.startsWith(`${lease.leaseId}:`))
    await this.outside(lease, async () => {
    // Closing the lease rejects new requests; drain accepted reads/writes before deleting their files.
    await Promise.all(artifactKeys().map((key) => (this.artifactQueues.get(key) ?? Promise.resolve()).catch(() => {})))
    await this.artifacts.cleanup(lease.leaseId)
    // 작업 트리 없는 통합 저장소와 이전 형식의 staging 사본을 함께 정리한다.
    await rm(this.integrationStore(lease.leaseId), { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
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
    for (const key of artifactKeys()) this.artifactQueues.delete(key)
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
  integrationStore(leaseId) { return path.join(this.root, 'integration', `${identifier(leaseId)}.git`) }
  waitingResult(lease, fields = {}) {
    return { status: 'waiting-integration', leaseId: lease.leaseId, jobId: lease.jobId, childStatus: 'completed', childError: null,
      headCommit: lease.headCommit ?? null, integratedCommit: null, blockingLeaseId: null, reasonCode: null, waitingReason: null,
      trackedChanges: [], untrackedChanges: [], phase: REMOTE_INTEGRATION_PHASE, ...fields, updatedAt: new Date(this.now()).toISOString() }
  }
  async finalize(id, options = {}) {
    return this.exclusive(async () => {
      const lease = this.scoped(id)
      if (['completed', 'quarantined'].includes(lease.status)) return lease.result ?? null
      if (lease.status === 'release-pending') return this.release(lease, this.pendingReleaseResult(lease))
      // 원격 Fork의 충돌 준비·완료 명령 응답을 확인하지 못했으면 같은 명령으로만 이어서 확인한다.
      if (lease.status === 'integration-preparing') return this.prepareRemoteConflict(lease)
      if (lease.status === 'awaiting-conflict-resolution') {
        return lease.integration?.completeAttempt ? this.completeConflictStep(lease) : lease.result ?? null
      }
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
      return this.integrate(lease)
    })
  }
  // 봉인된 결과나 원격 Fork가 충돌을 해결한 후보를 메인에 통합한다.
  // 메인 서버에는 작업 트리를 만들지 않고, 메인 잠금은 tree 계산과 fast-forward 동안만 잡는다.
  async integrate(lease) {
    let outcome
    try { outcome = await this.outside(lease, () => this.integrateMain(lease), { checkPool: false }) } catch (error) {
      if (error.storageResourceError) throw error
      if (TRANSIENT_INTEGRATION_CODES.has(error.reasonCode ?? error.code)) {
        lease.status = 'waiting-integration'
        lease.result = this.waitingResult(lease, { reasonCode: error.reasonCode ?? error.code, waitingReason: '같은 작업공간의 다른 처리나 메인 상태 확인이 끝나면 다시 통합합니다.' })
        await this.persist(); return lease.result
      }
      const failure = remoteIntegrationFailureReason(error)
      return this.hold(lease, failure.message, { reasonCode: failure.reasonCode, phase: REMOTE_INTEGRATION_PHASE, childStatus: 'completed' })
    }
    if (outcome.kind === 'waiting') {
      lease.status = 'waiting-integration'
      lease.result = this.waitingResult(lease, outcome.fields)
      await this.persist(); return lease.result
    }
    if (outcome.kind === 'conflict') return this.prepareRemoteConflict(lease, outcome)
    const result = { status: 'completed', leaseId: lease.leaseId, jobId: lease.jobId, childStatus: 'completed', childError: null,
      headCommit: lease.headCommit, integratedCommit: outcome.integratedCommit, integrationBaseCommit: outcome.integrationBaseCommit,
      replayed: outcome.replayed, droppedCommits: outcome.droppedCommits, conflictResolvedByAi: Boolean(lease.integration?.candidateCommit),
      // 하위 AI가 충돌을 해결한 결과에 메인 대비 변경이 남지 않았으면 검토할 수 있게 표시한다.
      ...(lease.integration?.candidateMode === 'present' ? { conflictResolutionEmpty: true } : {}),
      completedAt: new Date(this.now()).toISOString() }
    return this.release(lease, result)
  }
  // 통합할 커밋 구간을 작업 트리 없는 저장소로 가져온다. 충돌 해결 후보가 있으면 그 후보를, 없으면 봉인된 결과를 쓴다.
  async integrationSource(lease, store) {
    const integration = lease.integration
    if (integration?.candidateCommit) {
      if (integration.candidateMode === 'delta') {
        const fetched = await fetchBundle(store, this.artifacts.file(lease.leaseId, `candidate-${integration.round}`),
          `refs/heads/${integration.branch}`, 'refs/mnp/candidate-source')
        if (fetched !== integration.candidateCommit) throw workspaceError('REMOTE_WORKSPACE_RESULT_HEAD_MISMATCH', '원격 Fork의 충돌 해결 후보가 기록된 HEAD와 다릅니다.')
      } else if (integration.candidateMode !== 'present' || integration.candidateCommit !== integration.baseCommit) {
        throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
      }
      return { base: integration.baseCommit, head: integration.candidateCommit,
        commits: await linearCommits(store, integration.baseCommit, integration.candidateCommit) }
    }
    if (lease.resultMode === 'delta') {
      const fetched = await fetchBundle(store, this.artifacts.file(lease.leaseId, 'result'), `refs/heads/${lease.branch}`, 'refs/mnp/result')
      if (fetched !== lease.headCommit) throw workspaceError('REMOTE_WORKSPACE_RESULT_HEAD_MISMATCH', '원격 결과 bundle의 HEAD가 봉인된 HEAD와 다릅니다.')
    } else if (lease.resultMode !== 'present' || lease.headCommit !== lease.baseCommit) {
      throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
    }
    return { base: lease.baseCommit, head: lease.headCommit, commits: await linearCommits(store, lease.baseCommit, lease.headCommit) }
  }
  // 메인 통합 저장소 잠금 안에서 후보를 만들고 fast-forward한다. lease 기록은 바꾸지 않고 결과만 돌려준다.
  async integrateMain(lease) {
    const integration = this.local.registry?.integration
    if (!integration || !this.local.state) throw workspaceError('REMOTE_WORKSPACE_MAIN_POOL_UNAVAILABLE')
    return this.local.runExclusive(async () => {
      const waiting = (fields) => ({ kind: 'waiting', fields })
      const holder = this.local.state.integrationLeaseId
      if (holder && holder !== lease.leaseId) return waiting({ blockingLeaseId: holder, waitingReason: '다른 위임의 메인 통합이 끝나기를 기다립니다.' })
      const changes = await this.local.integrationTrackedChanges(integration)
      if (changes.dirty) return waiting({ reasonCode: integrationWorktreeDirtyReasonCode, waitingReason: integrationWorktreeDirtyMessage, trackedChanges: changes.paths })
      if (await git(integration.root, ['branch', '--show-current']) !== lease.baseBranch) {
        throw workspaceError('REMOTE_INTEGRATION_BRANCH_MISMATCH', `통합 작업공간 브랜치가 ${lease.baseBranch}가 아닙니다.`)
      }
      const mainHead = commitId(await git(integration.root, ['rev-parse', 'HEAD']))
      const store = await openIntegrationStore(this.integrationStore(lease.leaseId), integration.root)
      const recordFile = path.join(store, 'mnp-integration.json')
      // fast-forward 뒤 기록 전에 멈춘 경우: 기록한 후보가 이미 메인에 있으면 다시 쌓지 않는다.
      const recorded = await jsonFile(recordFile)
      if (recorded?.candidate && await hasCommit(integration.root, recorded.candidate) && await isAncestor(integration.root, recorded.candidate, mainHead)) {
        return { kind: 'applied', integratedCommit: recorded.candidate, integrationBaseCommit: recorded.base,
          replayed: recorded.replayed === true, droppedCommits: recorded.droppedCommits ?? [] }
      }
      const source = await this.integrationSource(lease, store)
      if (!await isAncestor(store, source.base, mainHead)) {
        throw workspaceError('REMOTE_WORKSPACE_BASE_DIVERGED', '메인 이력이 원격 결과의 기준 커밋에서 이어지지 않아 통합하지 않았습니다.')
      }
      this.local.state.integrationLeaseId = lease.leaseId
      await this.local.persist()
      try {
        let candidate = source.head, replayed = false, droppedCommits = []
        if (source.commits.length && mainHead !== source.base) {
          const replay = await replayCommits(store, source.commits, mainHead, { committer: await committerIdentity(integration.root) })
          if (replay.conflict) {
            return { kind: 'conflict', mainHead, unmergedFiles: replay.unmergedFiles, sourceBase: source.base, sourceCommits: source.commits }
          }
          candidate = replay.head; replayed = true; droppedCommits = replay.dropped
        }
        if (!source.commits.length || candidate === mainHead) {
          return { kind: 'applied', integratedCommit: mainHead, integrationBaseCommit: mainHead, replayed, droppedCommits }
        }
        const scope = { baseBranch: lease.baseBranch, integrationBaseCommit: mainHead, integrationHeadCommit: candidate }
        const collisions = await this.local.integrationUntrackedChanges(scope, { root: store }, integration)
        if (collisions.length) {
          return waiting({ reasonCode: integrationUntrackedCollisionReasonCode, waitingReason: integrationUntrackedCollisionMessage, untrackedChanges: collisions })
        }
        await saveJson(recordFile, { base: mainHead, candidate, replayed, droppedCommits, recordedAt: new Date(this.now()).toISOString() })
        await git(store, ['update-ref', 'refs/mnp/candidate', candidate])
        await git(integration.root, ['fetch', '--no-tags', store, 'refs/mnp/candidate'], { timeoutMs: LONG_GIT_TIMEOUT_MS })
        if (await git(integration.root, ['rev-parse', 'HEAD']) !== mainHead) {
          return waiting({ waitingReason: '통합 직전에 메인이 바뀌어 다음 확인에서 최신 메인 기준으로 다시 통합합니다.' })
        }
        try {
          await git(integration.root, ['merge', '--ff-only', '--no-overwrite-ignore', candidate], { timeoutMs: LONG_GIT_TIMEOUT_MS })
        } catch (error) {
          // 검사 직후 생긴 메인 변경·미추적 파일은 대기로 처리한다. 그 밖의 반영 실패는 격리한다.
          if (await git(integration.root, ['rev-parse', 'HEAD']) !== mainHead) throw error
          const tracked = await this.local.integrationTrackedChanges(integration)
          if (tracked.dirty) return waiting({ reasonCode: integrationWorktreeDirtyReasonCode, waitingReason: integrationWorktreeDirtyMessage, trackedChanges: tracked.paths })
          const again = await this.local.integrationUntrackedChanges(scope, { root: store }, integration)
          if (again.length) return waiting({ reasonCode: integrationUntrackedCollisionReasonCode, waitingReason: integrationUntrackedCollisionMessage, untrackedChanges: again })
          throw error
        }
        if (await git(integration.root, ['rev-parse', 'HEAD']) !== candidate) {
          throw workspaceError('REMOTE_INTEGRATION_APPLY_MISMATCH', '통합 직후 메인 HEAD가 후보 커밋과 다릅니다.')
        }
        return { kind: 'applied', integratedCommit: candidate, integrationBaseCommit: mainHead, replayed, droppedCommits }
      } finally {
        if (this.local.state.integrationLeaseId === lease.leaseId) {
          this.local.state.integrationLeaseId = null
          await this.local.persist()
        }
      }
    })
  }
  // 메인에서 충돌한 결과는 원격 Fork의 하위 AI가 해결한다. 최신 메인 구간을 Fork에 보내 통합 브랜치에 충돌을 남긴다.
  // 해결하는 동안 메인 잠금은 잡지 않는다. 해결된 후보는 그 사이 진행된 메인 위에 다시 쌓는다.
  async prepareRemoteConflict(lease, conflict = null) {
    if (lease.status !== 'integration-preparing') {
      const round = Number(lease.integrationRound ?? 0) + 1
      if (round > REMOTE_INTEGRATION_ROUND_LIMIT || Number(lease.conflictRound ?? 0) >= REMOTE_CONFLICT_ROUND_LIMIT) {
        return this.hold(lease, `AI 충돌 해결 재시도 한도(${REMOTE_CONFLICT_ROUND_LIMIT}회)를 초과했습니다. 메인과 완료된 작업 결과는 변경되지 않았습니다.`,
          { reasonCode: 'REMOTE_INTEGRATION_CONFLICT_LIMIT', phase: REMOTE_INTEGRATION_PHASE, childStatus: 'completed', unmergedFiles: conflict.unmergedFiles })
      }
      lease.integrationRound = round
      lease.integration = { round, branch: `mnp/integrate/${lease.jobId}-${round}`, baseCommit: conflict.mainHead,
        sourceBase: conflict.sourceBase, sourceCommits: conflict.sourceCommits, unmergedFiles: conflict.unmergedFiles,
        mainMode: conflict.mainHead === lease.baseCommit ? 'present' : 'delta', step: 'preparing' }
      lease.status = 'integration-preparing'
      lease.result = this.waitingResult(lease, { waitingReason: '메인 충돌을 원격 Fork에서 해결하도록 통합 브랜치를 준비합니다.', unmergedFiles: conflict.unmergedFiles })
      await this.persist()
    }
    const integration = lease.integration
    const kind = `integration-${integration.round}`
    try {
      if (integration.mainMode === 'delta' && !await this.artifacts.manifest(lease.leaseId, kind).catch((error) => {
        if (error.reasonCode === 'REMOTE_ARTIFACT_NOT_FOUND') return null
        throw error
      })) {
        await this.outside(lease, async () => {
          await createRangeBundle(this.integrationStore(lease.leaseId), this.artifacts.file(lease.leaseId, kind),
            lease.baseCommit, integration.baseCommit, `refs/mnp/main-${integration.round}`)
          await this.artifacts.publish(lease.leaseId, kind)
        }, { checkPool: false })
      }
      const step = await this.command(lease, 'integrate-prepare', { round: integration.round, integrationBranch: integration.branch,
        integrationBaseCommit: integration.baseCommit, mainMode: integration.mainMode, commits: integration.sourceCommits })
      return await this.recordConflictStep(lease, step)
    } catch (error) {
      return this.conflictCommandFailure(lease, error, '원격 Runner가 통합 충돌 준비 명령을 처리하지 못했습니다.')
    }
  }
  // Runner가 결정적으로 거절한 명령만 격리한다. 응답을 확인하지 못한 명령은 같은 명령으로 다시 확인하도록 대기로 둔다.
  async conflictCommandFailure(lease, error, fallback) {
    if (error.storageResourceError) throw error
    const code = error.reasonCode ?? error.code
    if (definitiveRunnerRejection(error)) {
      // Runner가 처리 후 거절한 명령은 결과가 확정됐다. 이후 재시도 명령이 막히지 않게 대기 표시를 지운다.
      delete lease.pendingOperation
      const reason = code === 'REMOTE_WORKSPACE_ACTION_INVALID'
        ? '원격 Runner가 통합 충돌 해결 명령을 지원하지 않습니다. 서브 머신의 MnP를 갱신하고 Runner를 다시 시작한 뒤 통합 재시도를 요청하세요. 메인과 완료된 작업 결과는 변경되지 않았습니다.'
        : remoteIntegrationFailureReason(error).message
      if (lease.integration) delete lease.integration.completeAttempt
      return this.hold(lease, reason, { reasonCode: code ?? 'REMOTE_INTEGRATION_FAILED', phase: REMOTE_INTEGRATION_PHASE,
        childStatus: 'completed', unmergedFiles: lease.integration?.unmergedFiles ?? [] })
    }
    lease.result = this.waitingResult(lease, { reasonCode: code ?? null, waitingReason: `${fallback} 같은 명령의 결과를 다음 확인에서 다시 확인합니다.` })
    await this.persist()
    return lease.result
  }
  async recordConflictStep(lease, step) {
    const integration = lease.integration
    if (step?.integrationBranch !== integration.branch || step?.integrationBaseCommit !== integration.baseCommit) {
      throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
    }
    if (step.status === 'awaiting-conflict-resolution') {
      lease.conflictRound = Number(lease.conflictRound ?? 0) + 1
      const unmergedFiles = Array.isArray(step.unmergedFiles) ? step.unmergedFiles.map(String) : []
      lease.integration = { ...integration, step: 'resolving', unmergedFiles }
      if (lease.conflictRound > REMOTE_CONFLICT_ROUND_LIMIT) {
        return this.hold(lease, `AI 충돌 해결 재시도 한도(${REMOTE_CONFLICT_ROUND_LIMIT}회)를 초과했습니다. 메인과 완료된 작업 결과는 변경되지 않았습니다.`,
          { reasonCode: 'REMOTE_INTEGRATION_CONFLICT_LIMIT', phase: REMOTE_INTEGRATION_PHASE, childStatus: 'completed', unmergedFiles })
      }
      lease.status = 'awaiting-conflict-resolution'
      lease.result = { status: 'awaiting-conflict-resolution', leaseId: lease.leaseId, jobId: lease.jobId, childStatus: 'completed',
        headCommit: lease.headCommit, integrationBaseCommit: integration.baseCommit, integrationBranch: integration.branch,
        conflictRound: lease.conflictRound, unmergedFiles, phase: REMOTE_INTEGRATION_PHASE, updatedAt: new Date(this.now()).toISOString() }
      await this.persist()
      return lease.result
    }
    if (step.status !== 'candidate-ready') throw workspaceError('REMOTE_WORKSPACE_RESULT_INVALID')
    const candidateCommit = commitId(step.candidateCommit)
    if (step.candidateMode === 'delta') {
      const manifest = await this.artifacts.manifest(lease.leaseId, `candidate-${integration.round}`)
      if (stableHash(manifest) !== stableHash(step.manifest)) throw workspaceError('REMOTE_WORKSPACE_ARTIFACT_HASH_MISMATCH')
    } else if (step.candidateMode !== 'present' || candidateCommit !== integration.baseCommit) {
      throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
    }
    lease.integration = { ...integration, step: 'candidate-ready', candidateCommit, candidateMode: step.candidateMode }
    lease.status = 'waiting-integration'
    lease.result = this.waitingResult(lease, { waitingReason: '원격 Fork가 충돌을 해결한 후보를 메인에 통합합니다.' })
    await this.persist()
    return this.integrate(lease)
  }
  // 하위 AI가 원격 Fork에서 충돌 해결을 마치면 Fork에 남은 cherry-pick을 끝내고 후보를 받아 메인에 통합한다.
  async completeConflictResolution(id, { childStatus, childError } = {}) {
    return this.exclusive(async () => {
      const lease = this.scoped(id)
      if (['completed', 'quarantined'].includes(lease.status)) return lease.result ?? null
      if (lease.status === 'release-pending') return this.release(lease, this.pendingReleaseResult(lease))
      if (lease.status === 'integration-preparing') return this.prepareRemoteConflict(lease)
      if (lease.status === 'waiting-integration' && lease.integration?.candidateCommit) return this.integrate(lease)
      if (lease.status !== 'awaiting-conflict-resolution' || !lease.integration) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_REQUIRED')
      if (childStatus !== 'completed' && !lease.integration.completeAttempt) {
        return this.hold(lease, childError ?? '충돌 해결 AI 작업이 완료되지 않았습니다. 메인과 완료된 작업 결과는 변경되지 않았습니다.',
          { reasonCode: 'REMOTE_INTEGRATION_CONFLICT_UNRESOLVED', phase: REMOTE_INTEGRATION_PHASE, childStatus: childStatus ?? null,
            unmergedFiles: lease.integration.unmergedFiles ?? [] })
      }
      return this.completeConflictStep(lease)
    })
  }
  async completeConflictStep(lease) {
    const integration = lease.integration
    // 같은 완료 시도는 응답을 잃어도 같은 명령으로만 다시 확인한다. 결과를 받은 뒤의 새 시도는 새 명령이다.
    if (!integration.completeAttempt) { integration.completeAttempt = randomUUID(); await this.persist() }
    let step
    try {
      step = await this.command(lease, 'integrate-complete', { round: integration.round, integrationBranch: integration.branch,
        integrationBaseCommit: integration.baseCommit, attempt: integration.completeAttempt })
    } catch (error) {
      return this.conflictCommandFailure(lease, error, '원격 Runner가 통합 충돌 해결 결과를 처리하지 못했습니다.')
    }
    delete lease.integration.completeAttempt
    return this.recordConflictStep(lease, step)
  }
  // 반환 대기 중 재시작한 lease는 저장한 통합 결과로 같은 반환을 이어간다. 이전 형식 기록은 상태만 완료로 바꾼다.
  pendingReleaseResult(lease) {
    if (lease.releaseResult) return lease.releaseResult
    const { phase: _phase, ...result } = lease.result ?? {}
    return { ...result, status: 'completed' }
  }
  async release(lease, result) {
    lease.status = 'release-pending'; lease.releaseResult = result
    lease.result = { ...result, status: 'waiting-integration', phase: 'release-pending' }
    await this.persist()
    await this.prepareRelease(lease)
    const released = await this.command(lease, 'release', { integratedCommit: lease.releaseCommit })
    if (!released.released || released.idleCommit !== lease.releaseCommit) throw workspaceError('REMOTE_WORKSPACE_RELEASE_MISMATCH')
    lease.status = 'completed'; lease.result = { ...result, remoteReleased: true, remoteDriftArchives: released.remoteDriftArchives ?? lease.remoteDriftArchives ?? [] }
    delete lease.releaseResult
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
  // 사람이 확인한 재시도는 봉인된 결과부터 메인 통합을 다시 시작한다. 이전 통합 기록은 이력으로 보존한다.
  // 이 방식에서는 메인 작업 트리를 만들지 않으므로 이전 staging 방식에서 멈춘 lease도 같은 경로로 이어간다.
  async retryIntegration(id, { confirmed = false, expectedHead } = {}) {
    return this.exclusive(async () => {
      const lease = this.scoped(id)
      if (!lease.sealed) throw workspaceError('REMOTE_WORKSPACE_RESULT_NOT_SEALED')
      if (lease.status === 'completed') return lease.result
      if (lease.status === 'waiting-integration' && lease.result?.phase === INTEGRATION_REQUEUED) return lease.result
      if (!['quarantined', 'awaiting-conflict-resolution'].includes(lease.status)) {
        throw workspaceError('REMOTE_WORKSPACE_RECOVERY_REQUIRED', '격리됐거나 충돌 해결이 중단된 원격 통합만 다시 시도할 수 있습니다.')
      }
      if (!confirmed || commitId(expectedHead) !== lease.headCommit) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_CONFIRMATION_REQUIRED')
      const requeuedAt = new Date(this.now()).toISOString()
      lease.integrationHistory = [...(lease.integrationHistory ?? []), { integration: lease.integration ?? null, result: lease.result ?? null, requeuedAt }].slice(-20)
      delete lease.integration
      lease.conflictRound = 0
      lease.status = 'waiting-integration'
      lease.result = this.waitingResult(lease, { phase: INTEGRATION_REQUEUED, waitingReason: '봉인된 원격 결과부터 메인 통합을 다시 시도합니다.',
        previousResult: lease.result ?? null })
      await this.persist()
      return lease.result
    })
  }
  async artifactRequest(machineId, leaseId, kind, suffix, method, body) {
    const validate = () => {
      const lease = this.scoped(leaseId, { allowPending: true })
      const artifact = remoteArtifactKind(kind)
      if (lease.ownership.machineId !== machineId) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
      if (lease.status === 'completed') throw workspaceError('REMOTE_WORKSPACE_ARTIFACT_LEASE_COMPLETED')
      // result와 candidate만 Runner가 올린다. candidate는 진행 중인 충돌 해결 회차의 후보만 받는다.
      const upload = artifact.base === 'result' ? !lease.sealed
        : artifact.base === 'candidate' ? lease.integration?.round === artifact.round
          && ['integration-preparing', 'awaiting-conflict-resolution'].includes(lease.status) : null
      if (upload === null ? method !== 'GET' : method !== 'POST' || !upload) throw workspaceError('REMOTE_WORKSPACE_ARTIFACT_DIRECTION_INVALID')
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
  const methods = new Set(['bindConversation', 'reuseLease', 'checkpoint', 'finalize', 'cancel', 'quarantine', 'reactivateQuarantinedLease',
    'completeConflictResolution'])
  const unsupported = new Set(['resumeIntegrationConflict', 'prepareIntegrationResultCorrection', 'resumeIntegrationResultCorrection',
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
