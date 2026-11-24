import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { WorkspacePoolManager, integrationConflictCheckpointMessage, latestMessageCheckpoint, normalizeConfiguredCommitPrefix,
  resolveCheckpointCommitPrefix } from '../../server/lib/workspacePool.mjs'
import { RemoteWorkspaceArtifacts } from '../../server/lib/remoteWorkspaceArtifacts.mjs'
import {
  REMOTE_INTEGRATION_ROUND_LIMIT, REMOTE_WORKSPACE_VERSION, REMOTE_WORKSPACE_ACTIONS, identifier, commitId, git,
  jsonFile, saveJson, stableHash, workspaceError, workspaceLock, workerRoot, assignmentMatches,
} from '../../server/lib/remoteWorkspaceProtocol.mjs'

export function workspaceRuntimeIdle(callLocal) {
  return async (conversationId, root) => {
    const snapshot = await callLocal({ method: 'GET', pathname: '/api/internal/conversation-runtimes/active', timeoutMs: 10_000 })
    if (!snapshot.ok || !Array.isArray(snapshot.data?.items)) return false
    for (const item of snapshot.data.items) {
      if (item.conversation_id === conversationId) return false
      const conversation = await callLocal({ method: 'GET', pathname: `/api/conversations/${identifier(item.conversation_id)}`, timeoutMs: 10_000 })
      if (!conversation.ok || typeof conversation.data?.extra?.workspace !== 'string') return false
      if (path.resolve(conversation.data.extra.workspace) === root) return false
    }
    return true
  }
}

export async function createWorkspaceAgent({ registryFile, machineId, request, runtimeIdle = async () => false } = {}) {
  if (!registryFile) return null
  const raw = await jsonFile(path.resolve(registryFile))
  if (!raw) throw workspaceError('REMOTE_WORKSPACE_REGISTRY_NOT_FOUND')
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.workspaces)) throw workspaceError('REMOTE_WORKSPACE_REGISTRY_INVALID')
  const coordinatorId = identifier(raw.coordinatorId)
  identifier(machineId); identifier(raw.poolId)
  if (typeof raw.sharedRoot !== 'string' || !path.isAbsolute(raw.sharedRoot)
    || typeof raw.originUrl !== 'string' || !raw.originUrl) throw workspaceError('REMOTE_WORKSPACE_REGISTRY_INVALID')
  const sharedRoot = path.resolve(raw.sharedRoot)
  const workers = []
  const integrationRoots = await Promise.all((raw.workspaces ?? []).filter((entry) => entry.role === 'integration').map((entry) => workerRoot(entry.root)))
  for (const entry of raw.workspaces ?? []) {
    if (entry.role !== 'worker' || entry.enabled === false) continue
    const root = await workerRoot(entry.root)
    if (integrationRoots.includes(root)) throw workspaceError('REMOTE_WORKSPACE_REGISTRY_INVALID')
    workers.push({ id: identifier(entry.id), root, assetsPath: path.join(root, 'Assets'),
      unityInstanceHash: createHash('sha1').update(path.join(root, 'Assets').replaceAll('\\', '/')).digest('hex').slice(0, 16),
      role: 'worker', enabled: true })
  }
  if (!workers.length || new Set(workers.map((worker) => worker.root)).size !== workers.length
    || new Set(workers.map((worker) => worker.id)).size !== workers.length) {
    throw workspaceError('REMOTE_WORKSPACE_REGISTRY_INVALID')
  }
  const stateFile = path.join(sharedRoot, 'remote-runner', 'state.json')
  const state = await jsonFile(stateFile, { schemaVersion: 1, leases: {}, workspaces: {}, operations: {}, generations: {} })
  const identity = { coordinatorId, machineId, poolId: raw.poolId }
  if (state.identity && stableHash(state.identity) !== stableHash(identity)) throw workspaceError('REMOTE_WORKSPACE_OWNER_MISMATCH')
  state.identity = identity
  const artifacts = new RemoteWorkspaceArtifacts(path.join(sharedRoot, 'remote-runner', 'artifacts'))
  const manager = new WorkspacePoolManager({ registryFile, stateFile })
  manager.registry = { poolId: raw.poolId, sharedRoot, originUrl: raw.originUrl,
    commitPrefix: normalizeConfiguredCommitPrefix(raw.commitPrefix), workspaces: workers, workers }
  manager.state = state
  let queue = Promise.resolve()
  const exclusive = (action) => {
    const result = queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(stateFile), { recursive: true })
      const lock = path.join(path.dirname(stateFile), 'mutation.lock')
      try { await mkdir(lock) } catch (error) {
        if (error.code === 'EEXIST') throw workspaceError('REMOTE_WORKSPACE_RUNNER_LOCKED')
        throw error
      }
      try {
        const latest = await jsonFile(stateFile, state)
        if (latest.identity && stableHash(latest.identity) !== stableHash(identity)) throw workspaceError('REMOTE_WORKSPACE_OWNER_MISMATCH')
        Object.assign(state, latest)
        return await action()
      } finally { await rm(lock, { recursive: true, force: true }) }
    })
    queue = result.catch(() => {})
    return result
  }
  const persist = () => saveJson(stateFile, state)
  const apiPath = (lease, kind) => `/api/machines/${machineId}/runner/workspace-artifacts/${lease.leaseId}/${kind}`

  async function cleanupCompletedLease(leaseId) {
    const stored = state.leases[leaseId]
    if (!stored?.cleanupPending || stored.status !== 'completed'
      || !Object.values(state.operations).some((item) => item.leaseId === leaseId && item.action === 'release' && item.state === 'completed')) return
    await artifacts.cleanup(leaseId)
    stored.cleanupPending = false
    state.workspaces[stored.workspaceId] = { status: 'idle' }
    await persist()
  }

  async function download(lease, kind) {
    const manifest = artifacts.validate(await request(`${apiPath(lease, kind)}/manifest`, undefined, 'GET'))
    for (let index = 0; index * manifest.chunkBytes < manifest.size; index += 1) {
      await artifacts.receive(lease.leaseId, kind, manifest,
        await request(`${apiPath(lease, kind)}/chunks/${index}`, undefined, 'GET'))
    }
    await artifacts.finish(lease.leaseId, kind)
    return artifacts.file(lease.leaseId, kind)
  }
  async function upload(lease, kind) {
    const manifest = await artifacts.publish(lease.leaseId, kind)
    for (let index = 0; index * manifest.chunkBytes < manifest.size; index += 1) {
      await request(`${apiPath(lease, kind)}/chunks/${index}`, { manifest, chunk: await artifacts.chunk(lease.leaseId, kind, index) }, 'POST')
    }
    await request(`${apiPath(lease, kind)}/complete`, {}, 'POST')
    return manifest
  }
  async function ownerFile(worker) {
    return path.resolve(worker.root, await git(worker.root, ['rev-parse', '--git-path', 'mnp-remote-owner.json']))
  }
  async function gitPathExists(root, name) {
    const file = path.resolve(root, await git(root, ['rev-parse', '--git-path', name]))
    return stat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
  }
  const replayInProgress = async (root) => await gitPathExists(root, 'CHERRY_PICK_HEAD') || await gitPathExists(root, 'sequencer')
  const unmergedFiles = async (root) => (await git(root, ['diff', '--name-only', '--diff-filter=U'])).split('\n').map((item) => item.trim()).filter(Boolean)
  // 로컬 Fork 통합과 같은 checkout 정책이다. core.autocrlf=true인 저장소는 재생 명령의 checkout 변환만 input으로 바꾼다.
  async function gitReplay(root, args) {
    const autoCrlf = await git(root, ['config', '--get', 'core.autocrlf']).catch((error) => { if (error.code === 1) return ''; throw error })
    return git(root, [...(autoCrlf.toLowerCase() === 'true' ? ['-c', 'core.autocrlf=input'] : []), ...args], { timeoutMs: 600_000 })
  }
  // 메인에 이미 같은 변경이 있어 빈 커밋이 되는 경우는 쌓지 않는다. 이 옵션을 모르는 Git에서는 빈 커밋을 유지한다.
  async function cherryPick(root, commits) {
    try { return await gitReplay(root, ['cherry-pick', '--empty=drop', ...commits]) } catch (error) {
      if (!/unknown option|usage: git cherry-pick/i.test(String(error?.stderr ?? error?.message ?? ''))) throw error
      return gitReplay(root, ['cherry-pick', '--keep-redundant-commits', ...commits])
    }
  }
  // 통합 명령의 Git 오류는 Runner가 처리 후 거절한 결과로 돌려준다. 서버는 이를 확정 결과로 보고 격리한다.
  async function integrationCommand(action) {
    try { return await action() } catch (error) {
      if (typeof error?.reasonCode === 'string' && /^(REMOTE_WORKSPACE_|MNP_WORKSPACE_)/.test(error.reasonCode)) throw error
      throw workspaceError('REMOTE_WORKSPACE_INTEGRATION_COMMAND_FAILED',
        String(error?.message ?? error).split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 300) || '원격 통합 명령을 처리하지 못했습니다.')
    }
  }
  const candidateResult = (integration) => ({ status: 'candidate-ready', integrationBranch: integration.branch,
    integrationBaseCommit: integration.baseCommit, candidateCommit: integration.candidateCommit, candidateMode: integration.candidateMode,
    manifest: integration.manifest ?? null })
  // 통합 브랜치의 후보를 메인에 보낸다. 후보에 커밋되지 않은 변경이 남으면 보내지 않는다.
  async function finishCandidate(worker, lease, stored) {
    const integration = stored.integration
    const head = commitId(await git(worker.root, ['rev-parse', 'HEAD']))
    await git(worker.root, ['merge-base', '--is-ancestor', integration.baseCommit, head])
    if (await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw workspaceError('REMOTE_WORKSPACE_DIRTY', '통합 후보에 커밋되지 않은 변경이 남아 있습니다.')
    const candidateMode = head === integration.baseCommit ? 'present' : 'delta'
    let manifest = null
    if (candidateMode === 'delta') {
      const kind = `candidate-${integration.round}`
      const file = artifacts.file(lease.leaseId, kind)
      await mkdir(path.dirname(file), { recursive: true })
      await git(worker.root, ['bundle', 'create', file, `${integration.baseCommit}..refs/heads/${integration.branch}`])
      if (await git(worker.root, ['rev-parse', 'HEAD']) !== head) throw workspaceError('REMOTE_WORKSPACE_RESULT_HEAD_MISMATCH')
      manifest = await upload(lease, kind)
    }
    stored.integration = { ...integration, step: 'candidate-ready', candidateCommit: head, candidateMode, manifest }
    stored.status = 'integration-candidate'
    state.workspaces[worker.id] = { ...state.workspaces[worker.id], status: 'integration-candidate', leaseId: lease.leaseId }
    await persist()
    return candidateResult(stored.integration)
  }
  async function validate(lease, { idle = false, allowSealed = false } = {}) {
    const stored = state.leases[lease.leaseId]
    const worker = workers.find((item) => item.id === lease.workspaceId)
    if (!worker || !assignmentMatches(lease, stored) || worker.root !== lease.projectRoot
      || stored.conversationId !== lease.conversationId
      || state.workspaces[worker.id]?.leaseId !== lease.leaseId) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
    const session = await jsonFile(path.join(worker.root, '.ai-session.json'))
    if (!assignmentMatches(lease, session) || session.conversationId !== lease.conversationId) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
    // 원격 통합 충돌을 해결하는 동안에는 이 lease의 현재 통합 브랜치도 같은 작업으로 본다.
    const branch = await git(worker.root, ['branch', '--show-current'])
    if (branch !== lease.branch && !(stored.integration?.branch && branch === stored.integration.branch)) throw workspaceError('REMOTE_WORKSPACE_BRANCH_MISMATCH')
    const owner = await jsonFile(await ownerFile(worker))
    if (stableHash(owner) !== stableHash(identity)) throw workspaceError('REMOTE_WORKSPACE_OWNER_MISMATCH')
    if (!allowSealed && stored.sealed) throw workspaceError('REMOTE_WORKSPACE_RESULT_SEALED')
    if (idle && !await runtimeIdle(lease.conversationId, worker.root)) throw workspaceError('REMOTE_WORKSPACE_RUNTIME_ACTIVE')
    return { stored, worker, session }
  }
  async function prepare(lease) {
    const worker = workers.find((item) => item.id === lease.workspaceId)
    if (!worker || worker.root !== lease.projectRoot || lease.ownership.coordinatorId !== coordinatorId
      || lease.ownership.machineId !== machineId || lease.ownership.poolId !== raw.poolId) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
    const current = state.workspaces[worker.id]
    if (current?.leaseId && current.leaseId !== lease.leaseId) throw workspaceError('REMOTE_WORKSPACE_ALREADY_LEASED')
    if (Object.values(state.leases).some((item) => item.workspaceId === worker.id && item.cleanupPending)) {
      throw workspaceError('REMOTE_WORKSPACE_CLEANUP_REQUIRED')
    }
    const generation = Number(state.generations[worker.id] ?? 0)
    if (!Number.isSafeInteger(lease.ownership.generation) || lease.ownership.generation <= generation) throw workspaceError('REMOTE_WORKSPACE_FENCE_STALE')
    return workspaceLock(worker.root, async () => {
      const localOwnerFile = path.resolve(worker.root, await git(worker.root, ['rev-parse', '--git-path', 'mnp-local-owner.json']))
      if (await jsonFile(localOwnerFile)) throw workspaceError('REMOTE_WORKSPACE_OWNER_MISMATCH')
      if (await jsonFile(path.join(worker.root, '.ai-session.json'))) throw workspaceError('REMOTE_WORKSPACE_SESSION_EXISTS')
      if (!await runtimeIdle('', worker.root)) throw workspaceError('REMOTE_WORKSPACE_RUNTIME_ACTIVE')
      if (await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw workspaceError('REMOTE_WORKSPACE_DIRTY')
      if (await git(worker.root, ['remote', 'get-url', 'origin']) !== raw.originUrl) throw workspaceError('REMOTE_WORKSPACE_ORIGIN_MISMATCH')
      commitId(lease.baselineCommit)
      if (!['present', 'delta'].includes(lease.baselineMode)
        || await git(worker.root, ['rev-parse', 'HEAD']) !== lease.baselineCommit
        || lease.baselineMode === 'present' && lease.baselineCommit !== lease.baseCommit
        || lease.baselineMode === 'delta' && lease.baselineCommit === lease.baseCommit) {
        throw workspaceError('REMOTE_WORKSPACE_BASELINE_MISMATCH')
      }
      const owner = await jsonFile(await ownerFile(worker))
      if (owner && stableHash(owner) !== stableHash(identity)) throw workspaceError('REMOTE_WORKSPACE_OWNER_MISMATCH')
      await saveJson(await ownerFile(worker), { coordinatorId, machineId, poolId: raw.poolId })
      state.generations[worker.id] = lease.ownership.generation
      state.workspaces[worker.id] = { status: 'preparing', leaseId: lease.leaseId }
      state.leases[lease.leaseId] = { ...lease, status: 'preparing', checkpoints: [] }
      await persist()
      if (lease.baselineMode === 'delta') {
        const bundle = await download(lease, 'baseline')
        await git(worker.root, ['bundle', 'verify', bundle])
        await git(worker.root, ['fetch', '--no-tags', bundle, `refs/heads/${lease.baseBranch}`])
      }
      commitId(lease.baseCommit)
      await git(worker.root, ['cat-file', '-e', `${lease.baseCommit}^{commit}`])
      await git(worker.root, ['merge-base', '--is-ancestor', lease.baselineCommit, lease.baseCommit])
      await git(worker.root, ['switch', '-c', lease.branch, lease.baseCommit])
      state.leases[lease.leaseId].status = 'leased'
      state.workspaces[worker.id].status = 'leased'
      await saveJson(path.join(worker.root, '.ai-session.json'), lease)
      await persist()
      return { lease: state.leases[lease.leaseId] }
    })
  }
  async function mutate(action, lease, options) {
    if (action === 'prepare') return prepare(lease)
    const { worker, stored, session } = await validate(lease, { idle: ['reuse', 'seal', 'release', 'recover', 'integrate-prepare', 'integrate-complete'].includes(action),
      allowSealed: ['release', 'quarantine', 'recover', 'integrate-prepare', 'integrate-complete'].includes(action) })
    return workspaceLock(worker.root, async () => {
      if (action === 'bind') {
        const conversationId = identifier(options.conversationId)
        if (stored.conversationId && stored.conversationId !== conversationId) throw workspaceError('REMOTE_WORKSPACE_CONVERSATION_MISMATCH')
        stored.conversationId = conversationId
        await saveJson(path.join(worker.root, '.ai-session.json'), { ...session, conversationId })
        await persist()
        return { lease: stored }
      }
      if (action === 'reuse' || action === 'recover') {
        if (stored.sealed) throw workspaceError('REMOTE_WORKSPACE_RESULT_SEALED')
        const head = await git(worker.root, ['rev-parse', 'HEAD'])
        await git(worker.root, ['merge-base', '--is-ancestor', lease.baseCommit, head])
        stored.status = 'leased'
        state.workspaces[worker.id].status = 'leased'
        await persist()
        return { lease: stored }
      }
      if (action === 'checkpoint') return manager.checkpoint(lease.leaseId, options)
      if (action === 'quarantine') {
        stored.status = 'quarantined'; stored.reason = String(options.reason ?? '실행 상태 확인 필요')
        state.workspaces[worker.id].status = 'quarantined'
        await persist()
        return { quarantined: true }
      }
      if (action === 'seal') {
        if (!stored.checkpoints?.length) {
          const files = await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])
          return { status: 'checkpoint-required', changedFiles: files.split('\n').filter(Boolean), checkpointRound: options.checkpointRound }
        }
        const checkpoint = stored.checkpoints.at(-1)
        const head = await git(worker.root, ['rev-parse', 'HEAD'])
        if (head !== checkpoint.commit) throw workspaceError('REMOTE_WORKSPACE_UNCHECKPOINTED_COMMITS')
        if (await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
          const drift = await manager.archiveAndRestoreDrift(worker, { reason: '원격 체크포인트 이후 검증 변경', phase: 'remote-seal', jobId: lease.jobId, leaseId: lease.leaseId })
          stored.remoteDriftArchives ??= []
          stored.remoteDriftArchives.push(drift.archiveRoot)
          await persist()
        }
        const file = artifacts.file(lease.leaseId, 'result')
        const resultMode = head === lease.baseCommit ? 'present' : 'delta'
        let manifest = null
        if (resultMode === 'delta') {
          await mkdir(path.dirname(file), { recursive: true })
          await git(worker.root, ['bundle', 'create', file, `${lease.baseCommit}..refs/heads/${lease.branch}`])
          if (await git(worker.root, ['rev-parse', 'HEAD']) !== head) throw workspaceError('REMOTE_WORKSPACE_RESULT_HEAD_MISMATCH')
          manifest = await upload(lease, 'result')
        }
        stored.sealed = true; stored.headCommit = head
        stored.resultMode = resultMode
        await persist()
        return { status: 'sealed', headCommit: head, resultMode, checkpoints: stored.checkpoints, manifest,
          remoteDriftArchives: stored.remoteDriftArchives ?? [] }
      }
      if (action === 'integrate-prepare') {
        if (!stored.sealed) throw workspaceError('REMOTE_WORKSPACE_RESULT_NOT_SEALED')
        const round = Number(options.round)
        const branch = String(options.integrationBranch ?? '')
        if (!Number.isSafeInteger(round) || round < 1 || round > REMOTE_INTEGRATION_ROUND_LIMIT
          || branch !== `mnp/integrate/${lease.jobId}-${round}`) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
        const base = commitId(options.integrationBaseCommit)
        const commits = Array.isArray(options.commits) && options.commits.length ? options.commits.map(commitId) : null
        if (!commits || !['delta', 'present'].includes(options.mainMode)) throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
        return integrationCommand(async () => {
          // 이전 회차의 중단된 cherry-pick은 끝내고, 남은 변경은 보존 자료로 옮긴 뒤 새 통합 브랜치를 만든다.
          if (await replayInProgress(worker.root)) await git(worker.root, ['cherry-pick', '--abort'])
          if (await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
            const drift = await manager.archiveAndRestoreDrift(worker, { reason: '원격 통합 충돌 준비 전 변경', phase: 'remote-integration-prepare', jobId: lease.jobId, leaseId: lease.leaseId })
            stored.remoteDriftArchives ??= []
            stored.remoteDriftArchives.push(drift.archiveRoot)
            await persist()
          }
          if (options.mainMode === 'delta') {
            const bundle = await download(lease, `integration-${round}`)
            await git(worker.root, ['bundle', 'verify', bundle])
            await git(worker.root, ['fetch', '--no-tags', bundle, `refs/mnp/main-${round}`], { timeoutMs: 600_000 })
          } else if (base !== lease.baseCommit) throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
          await git(worker.root, ['cat-file', '-e', `${base}^{commit}`])
          await git(worker.root, ['merge-base', '--is-ancestor', lease.baseCommit, base])
          for (const commit of commits) await git(worker.root, ['cat-file', '-e', `${commit}^{commit}`])
          await gitReplay(worker.root, ['switch', '-C', branch, base])
          stored.integration = { round, branch, baseCommit: base, commits, step: 'preparing' }
          state.workspaces[worker.id] = { ...state.workspaces[worker.id], status: 'integrating', leaseId: lease.leaseId }
          await persist()
          try { await cherryPick(worker.root, commits) } catch (error) {
            const unmerged = await unmergedFiles(worker.root)
            if (!unmerged.length) throw error
            stored.integration = { ...stored.integration, step: 'resolving', unmergedFiles: unmerged }
            stored.status = 'resolving-integration-conflict'
            state.workspaces[worker.id] = { ...state.workspaces[worker.id], status: 'resolving-integration-conflict', leaseId: lease.leaseId }
            // 작업 배정 값은 그대로 두고 통합 단계 정보만 더한다. 하위 AI는 이 정보로 통합 브랜치에서 충돌을 해결한다.
            await saveJson(path.join(worker.root, '.ai-session.json'), { ...session, integration: { phase: 'integration-conflict', round, branch, baseCommit: base } })
            await persist()
            return { status: 'awaiting-conflict-resolution', integrationBranch: branch, integrationBaseCommit: base, unmergedFiles: unmerged }
          }
          return finishCandidate(worker, lease, stored)
        })
      }
      if (action === 'integrate-complete') {
        const integration = stored.integration
        if (!integration || integration.round !== Number(options.round) || integration.branch !== options.integrationBranch
          || integration.baseCommit !== options.integrationBaseCommit) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
        return integrationCommand(async () => {
          if (integration.step === 'candidate-ready') return candidateResult(integration)
          if (await git(worker.root, ['branch', '--show-current']) !== integration.branch) throw workspaceError('REMOTE_WORKSPACE_BRANCH_MISMATCH')
          const awaiting = (unmerged) => ({ status: 'awaiting-conflict-resolution', integrationBranch: integration.branch,
            integrationBaseCommit: integration.baseCommit, unmergedFiles: unmerged })
          let unmerged = await unmergedFiles(worker.root)
          if (unmerged.length) return awaiting(unmerged)
          if (await replayInProgress(worker.root)) {
            await git(worker.root, ['add', '-A'])
            try { await gitReplay(worker.root, ['-c', 'core.editor=true', 'cherry-pick', '--continue']) } catch (error) {
              unmerged = await unmergedFiles(worker.root)
              if (unmerged.length) return awaiting(unmerged)
              throw error
            }
          }
          // 하위 AI가 통합 과정에 남긴 보완 변경은 로컬 Fork와 같은 통합 충돌 보완 커밋으로 남긴다.
          if (await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
            const latest = latestMessageCheckpoint(stored)
            const legacyPrefix = latest && typeof latest.commitPrefix !== 'string'
              ? resolveCheckpointCommitPrefix({ configuredPrefix: manager.registry.commitPrefix, authorName: null }) : ''
            const message = integrationConflictCheckpointMessage(stored, legacyPrefix)
            await git(worker.root, ['add', '-A'])
            await git(worker.root, ['commit', '-m', message.title, '-m', message.body])
          }
          return finishCandidate(worker, lease, stored)
        })
      }
      if (action === 'release') {
        if (!stored.sealed && options.cancel !== true) throw workspaceError('REMOTE_WORKSPACE_RELEASE_UNSEALED')
        // 메인 통합이 끝난 뒤 남은 통합 충돌 상태는 쓸모가 없다. 진행 중인 cherry-pick을 끝내고 남은 변경은 보존 자료로 옮긴다.
        if (stored.integration && await replayInProgress(worker.root)) await git(worker.root, ['cherry-pick', '--abort'])
        if (stored.integration && await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
          const drift = await manager.archiveAndRestoreDrift(worker, { reason: '원격 통합 완료 후 남은 충돌 해결 변경', phase: 'remote-integration-release', jobId: lease.jobId, leaseId: lease.leaseId })
          stored.remoteDriftArchives ??= []
          stored.remoteDriftArchives.push(drift.archiveRoot)
        }
        if (await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw workspaceError('REMOTE_WORKSPACE_DIRTY')
        commitId(options.integratedCommit)
        if (lease.releaseMode === 'delta') {
          const bundle = await download(lease, 'release')
          await git(worker.root, ['bundle', 'verify', bundle])
          await git(worker.root, ['fetch', '--no-tags', bundle, `refs/heads/${lease.baseBranch}`])
        } else if (lease.releaseMode !== 'present') throw workspaceError('REMOTE_WORKSPACE_TRANSFER_CONTRACT_MISMATCH')
        await git(worker.root, ['cat-file', '-e', `${options.integratedCommit}^{commit}`])
        await git(worker.root, ['merge-base', '--is-ancestor', lease.baseCommit, options.integratedCommit])
        await git(worker.root, ['switch', '-C', `mnp/idle/${worker.id}`, options.integratedCommit])
        if (await git(worker.root, ['rev-parse', 'HEAD']) !== options.integratedCommit
          || await git(worker.root, ['branch', '--show-current']) !== `mnp/idle/${worker.id}`) throw workspaceError('REMOTE_WORKSPACE_RELEASE_MISMATCH')
        if (await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
          const drift = await manager.archiveAndRestoreDrift(worker, { reason: '원격 Fork 반환 후 자동 변경', phase: 'idle-release', jobId: lease.jobId, leaseId: lease.leaseId, idleCommit: options.integratedCommit })
          stored.remoteDriftArchives ??= []
          stored.remoteDriftArchives.push(drift.archiveRoot)
        }
        // Keep the ownership marker so a second coordinator cannot silently claim this worker.
        await rm(path.join(worker.root, '.ai-session.json'))
        stored.status = 'completed'; stored.cleanupPending = true
        state.workspaces[worker.id] = { status: 'cleanup-pending' }
        await persist()
        return { released: true, idleCommit: options.integratedCommit, remoteDriftArchives: stored.remoteDriftArchives ?? [] }
      }
      throw workspaceError('REMOTE_WORKSPACE_ACTION_INVALID')
    })
  }
  async function execute(body) {
    return exclusive(async () => {
      const operationId = identifier(body?.operationId)
      if (!REMOTE_WORKSPACE_ACTIONS.has(body?.action)) throw workspaceError('REMOTE_WORKSPACE_ACTION_INVALID')
      const fingerprint = stableHash(body)
      const prior = state.operations[operationId]
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw workspaceError('REMOTE_WORKSPACE_OPERATION_CONFLICT')
        if (prior.state === 'completed') {
          if (body.action === 'release') await cleanupCompletedLease(body.lease.leaseId).catch(() => {})
          return prior.result
        }
        if (prior.state === 'failed') throw workspaceError(prior.code)
        throw workspaceError('REMOTE_WORKSPACE_RECOVERY_REQUIRED')
      }
      const lease = body.lease
      identifier(lease?.leaseId); identifier(lease?.jobId)
      identifier(lease?.workspaceId)
      if (!lease.ownership || lease.ownership.coordinatorId !== coordinatorId || lease.ownership.machineId !== machineId
        || lease.ownership.poolId !== raw.poolId || lease.poolId !== raw.poolId || lease.sharedRoot !== sharedRoot || !Number.isSafeInteger(lease.ownership.generation)
        || lease.ownership.generation < 1 || lease.branch !== `mnp/${lease.jobId}`) throw workspaceError('MNP_WORKSPACE_ASSIGNMENT_MISMATCH')
      commitId(lease.baseCommit)
      await git(workers[0].root, ['check-ref-format', '--branch', lease.baseBranch])
      state.operations[operationId] = { fingerprint, state: 'started', action: body.action, leaseId: lease.leaseId }
      await persist()
      try {
        const result = await mutate(body.action, lease, body.options ?? {})
        state.operations[operationId] = { fingerprint, state: 'completed', action: body.action, leaseId: lease.leaseId, result: structuredClone(result) }
        await persist()
        if (body.action === 'release') await cleanupCompletedLease(lease.leaseId).catch(() => {})
        return result
      } catch (error) {
        state.operations[operationId] = { fingerprint, state: 'failed', action: body.action, leaseId: lease.leaseId,
          code: error.reasonCode ?? error.code ?? 'REMOTE_WORKSPACE_OPERATION_FAILED' }
        await persist()
        throw error
      }
    })
  }
  async function report() {
    return exclusive(async () => {
      for (const lease of Object.values(state.leases)) {
        if (lease.cleanupPending) await cleanupCompletedLease(lease.leaseId).catch(() => {})
      }
      const workspaces = []
      for (const worker of workers) {
        const session = await jsonFile(path.join(worker.root, '.ai-session.json'))
        const originUrl = await git(worker.root, ['remote', 'get-url', 'origin'])
        const dirty = Boolean(await git(worker.root, ['status', '--porcelain=v1', '--untracked-files=all']))
        const current = state.workspaces[worker.id]
        const owner = await jsonFile(await ownerFile(worker))
        const localOwner = await jsonFile(path.resolve(worker.root, await git(worker.root, ['rev-parse', '--git-path', 'mnp-local-owner.json'])))
        const foreignOwner = localOwner || owner && stableHash(owner) !== stableHash(identity)
        workspaces.push({ workspaceId: worker.id, projectRoot: worker.root, assetsPath: worker.assetsPath,
          unityInstanceHash: worker.unityInstanceHash, originUrl, headCommit: await git(worker.root, ['rev-parse', 'HEAD']),
          branch: await git(worker.root, ['branch', '--show-current']), dirty,
          status: foreignOwner ? 'foreign-owner' : current?.status ?? (session ? 'foreign-session' : dirty ? 'dirty' : 'idle'),
          leaseId: current?.leaseId ?? null, generation: state.generations[worker.id] ?? 0,
          runtimeIdle: await runtimeIdle(session?.conversationId ?? '', worker.root) })
      }
      return { version: REMOTE_WORKSPACE_VERSION, coordinatorId, machineId, poolId: raw.poolId, sharedRoot, originUrl: raw.originUrl,
        registryDigest: stableHash(raw), observedAt: new Date().toISOString(), workspaces }
    })
  }
  async function validateDispatchInner(requestBody) {
    const lease = requestBody?.workspaceLease
    if (!lease?.ownership) return
    const stored = state.leases[lease.leaseId]
    if (!['leased', 'checkpoint-required', 'resolving-integration-conflict'].includes(stored?.status)) throw workspaceError('REMOTE_WORKSPACE_RECOVERY_REQUIRED')
    if (requestBody.strategy === 'resume' && stored?.conversationId !== requestBody.targetConversationId
      || requestBody.strategy === 'new' && stored?.conversationId) throw workspaceError('REMOTE_WORKSPACE_CONVERSATION_MISMATCH')
    // 봉인된 결과는 통합 충돌을 해결하는 대화에만 다시 열어 준다.
    await validate({ ...lease, conversationId: stored?.conversationId ?? '' }, { allowSealed: stored.status === 'resolving-integration-conflict' })
  }
  const validateDispatch = (body) => exclusive(() => validateDispatchInner(body))
  return { execute, report, validateDispatch, state }
}
