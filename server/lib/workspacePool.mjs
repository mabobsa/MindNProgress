import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { aiDelegationWorkspaceLeaseMatches, retryableExternalLimitCategory } from './aiDelegations.mjs'

const execFileAsync = promisify(execFile)
const idleDriftReason = '작업공간에 소유자를 확정할 수 없는 변경이 있습니다.'
const workspacePreparationFailedReasonCode = 'WORKSPACE_PREPARATION_FAILED'
const integrationGitProbeTimeoutMs = Math.max(
  1_000,
  Number(process.env.MNP_INTEGRATION_GIT_STATUS_TIMEOUT_MS) || 15_000,
)
export const integrationWorktreeDirtyMessage = '통합 작업공간에 커밋되지 않은 추적 파일 변경이 있습니다.'
export const integrationWorktreeDirtyReasonCode = 'integration-worktree-dirty'
export const integrationStatusRetryReasonCode = 'INTEGRATION_STATUS_RETRY'
const conversationBindableLeaseStatuses = new Set(['leased', 'checkpoint-required'])
const conversationReusableLeaseStatuses = new Set(['leased', 'checkpoint-required', 'finalizing'])
const conversationRebindOnlyLeaseStatuses = new Set([
  'finalizing',
  'waiting-integration',
  'integrating',
  'awaiting-conflict-resolution',
])
const protectedWorkspaceEntries = new Set([
  '.ai-workspace.json', '.agents', '.claude', '.codex',
  '_AIShared', // 기존 작업공간의 공용 폴더를 drift 정리에서 삭제하지 않기 위한 호환 보호 항목
  'AGENTS.md', 'CLAUDE.local.md',
])

export class WorkspacePoolUnavailableError extends Error {
  constructor(message, details = [], reasonCode = 'WORKSPACE_POOL_UNAVAILABLE') {
    super(message)
    this.name = 'WorkspacePoolUnavailableError'
    this.code = 'WORKSPACE_POOL_UNAVAILABLE'
    this.reasonCode = reasonCode
    this.details = details
  }
}

export class WorkspacePoolIntegrationError extends Error {
  constructor(message, details = null) {
    super(message)
    this.name = 'WorkspacePoolIntegrationError'
    this.code = 'WORKSPACE_POOL_INTEGRATION_FAILED'
    this.details = details
  }
}

class IntegrationWorkspaceBusyError extends Error {
  constructor(trackedChanges = []) {
    super(integrationWorktreeDirtyMessage)
    this.name = 'IntegrationWorkspaceBusyError'
    this.code = 'WORKSPACE_POOL_INTEGRATION_WAIT'
    this.reasonCode = integrationWorktreeDirtyReasonCode
    this.trackedChanges = trackedChanges
  }
}

export const checkpointCommitMessageExample = {
  summary: '일본 로그인 IDP 뷰 이중 등록 해소',
  background: '일본 로그인 진입 과정에서 동일 뷰가 중복 등록되어 초기화 순서가 불안정했습니다.',
  cause: '기존 초기화 경로와 일본 전용 진입 경로가 각각 뷰를 등록하고 있었습니다.',
  changes: '일본 전용 진입 경로로 등록 책임을 일원화하고 중복 등록을 제거했습니다.',
  scope: 'JAPAN_SERVICE 로그인 흐름에만 적용됩니다.',
}

function checkpointCommitMessageError(message) {
  return new WorkspacePoolUnavailableError(
    message,
    [{ commitMessage: checkpointCommitMessageExample }],
    'AI_WORKSPACE_CHECKPOINT_MESSAGE_INVALID',
  )
}

function normalizedCheckpointMessageField(value, name, maxLength, { inline = false } = {}) {
  if (typeof value !== 'string') throw checkpointCommitMessageError(`commitMessage.${name} 문자열이 필요합니다.`)
  const normalized = inline ? value.replace(/\s+/g, ' ').trim() : value.replace(/\r\n?/g, '\n').trim()
  if (!normalized) throw checkpointCommitMessageError(`commitMessage.${name} 내용을 입력해 주세요.`)
  if (normalized.length > maxLength) {
    throw checkpointCommitMessageError(`commitMessage.${name}은 ${maxLength}자를 넘을 수 없습니다.`)
  }
  if ([...normalized].some((character) => {
    const code = character.charCodeAt(0)
    return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)
  })) {
    throw checkpointCommitMessageError(`commitMessage.${name}에 제어문자를 사용할 수 없습니다.`)
  }
  if (/Co-Authored-By\s*:/i.test(normalized)) {
    throw checkpointCommitMessageError('Co-Authored-By 문구는 커밋 메시지에 사용할 수 없습니다.')
  }
  return normalized
}

export function normalizeCheckpointCommitMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw checkpointCommitMessageError('변경 체크포인트에는 실제 변경을 설명하는 commitMessage가 필요합니다.')
  }
  const allowedFields = new Set(['summary', 'background', 'cause', 'changes', 'scope'])
  const unknownFields = Object.keys(value).filter((field) => !allowedFields.has(field))
  if (unknownFields.length > 0) {
    throw checkpointCommitMessageError(`commitMessage에 지원하지 않는 필드가 있습니다: ${unknownFields.join(', ')}`)
  }
  const summary = normalizedCheckpointMessageField(value.summary, 'summary', 80, { inline: true })
  if (summary.startsWith('[김용민]')) {
    throw checkpointCommitMessageError('commitMessage.summary에는 [김용민] prefix를 넣지 마세요. 서버가 자동으로 추가합니다.')
  }
  const scope = value.scope === undefined || value.scope === null || value.scope === ''
    ? null
    : normalizedCheckpointMessageField(value.scope, 'scope', 2_000)
  return {
    summary,
    background: normalizedCheckpointMessageField(value.background, 'background', 2_000),
    cause: normalizedCheckpointMessageField(value.cause, 'cause', 2_000),
    changes: normalizedCheckpointMessageField(value.changes, 'changes', 4_000),
    scope,
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value ?? '').trim()).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function nullSeparated(value) {
  return String(value ?? '').split('\0').map((item) => item.trim()).filter(Boolean)
}

function safeRelativePath(value) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

function isProtectedWorkspacePath(relative) {
  return protectedWorkspaceEntries.has(String(relative ?? '').replaceAll('\\', '/').split('/')[0])
}

function pathInside(root, relative) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const prefix = `${normalizedPath(resolvedRoot)}${path.sep}`
  if (!normalizedPath(resolved).startsWith(prefix)) throw new Error(`작업공간 밖의 경로는 처리할 수 없습니다: ${relative}`)
  return resolved
}

function driftFolderName(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function atomicJson(file, value) {
  return (async () => {
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  })()
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function defaultGitRunner(cwd, args, { timeoutMs = 0 } = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    })
    return String(result.stdout ?? '').trim()
  } catch (error) {
    if (timeoutMs <= 0 || (error?.killed !== true && error?.code !== 'ETIMEDOUT')) throw error
    const timeoutError = new Error(`Git 읽기 명령이 ${timeoutMs}ms 안에 끝나지 않았습니다.`)
    timeoutError.code = 'GIT_COMMAND_TIMEOUT'
    timeoutError.cause = error
    throw timeoutError
  }
}

function normalizedCheckpointMnpField(value, maxLength) {
  if (typeof value !== 'string') return null
  const normalized = [...value]
    .map((character) => {
      const code = character.codePointAt(0)
      return code === 127 || code < 32 ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return null
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

export function normalizeCheckpointMnpContext(value, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const defaults = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}
  return {
    mapId: normalizedCheckpointMnpField(source.mapId ?? defaults.mapId, 200),
    cardId: normalizedCheckpointMnpField(source.cardId ?? defaults.cardId, 200),
    documentTitle: normalizedCheckpointMnpField(source.documentTitle ?? defaults.documentTitle, 200),
    cardTitle: normalizedCheckpointMnpField(source.cardTitle ?? defaults.cardTitle, 300),
  }
}

function normalizeRegistry(raw, registryFile) {
  const entries = Array.isArray(raw?.workspaces) ? raw.workspaces : []
  const workspaces = entries
    .filter((entry) => entry?.enabled !== false && String(entry?.id ?? '').trim() && String(entry?.root ?? '').trim())
    .map((entry) => ({
      ...entry,
      id: String(entry.id).trim(),
      root: path.resolve(String(entry.root).trim()),
      role: String(entry.role ?? '').trim() || (entry.id === 'main' ? 'integration' : 'worker'),
    }))
  const integration = workspaces.find((workspace) => workspace.role === 'integration')
    ?? workspaces.find((workspace) => workspace.id === 'main')
  return {
    schemaVersion: Number(raw?.schemaVersion) || 1,
    poolId: String(raw?.poolId ?? path.basename(String(raw?.sharedRoot ?? 'workspace-pool'))).trim() || 'workspace-pool',
    sharedRoot: path.resolve(String(raw?.sharedRoot ?? path.dirname(registryFile))),
    originUrl: String(raw?.originUrl ?? '').trim(),
    integration,
    workers: workspaces.filter((workspace) => workspace.role === 'worker' && workspace.id !== integration?.id),
    workspaces,
  }
}

function publicLease(lease) {
  return {
    poolId: lease.poolId,
    sharedRoot: lease.sharedRoot ?? null,
    workspaceId: lease.workspaceId,
    jobId: lease.jobId,
    leaseId: lease.leaseId,
    projectRoot: lease.projectRoot,
    assetsPath: lease.assetsPath,
    unityInstanceHash: lease.unityInstanceHash,
    branch: lease.branch,
    baseBranch: lease.baseBranch,
    baseCommit: lease.baseCommit,
    startedAt: lease.startedAt,
    checkpointCount: Array.isArray(lease.checkpoints) ? lease.checkpoints.length : 0,
  }
}

function checkpointMnpSection(mnpContext) {
  const document = `${mnpContext.documentTitle ?? '확인 불가'}${mnpContext.mapId ? ` (${mnpContext.mapId})` : ''}`
  const card = `${mnpContext.cardTitle ?? '확인 불가'}${mnpContext.cardId ? ` (${mnpContext.cardId})` : ''}`
  const relativePath = mnpContext.mapId && mnpContext.cardId
    ? `/mindmap/${encodeURIComponent(mnpContext.mapId)}/${encodeURIComponent(mnpContext.cardId)}`
    : '확인 불가'
  return `[MnP]\n문서: ${document}\n카드: ${card}\n경로: ${relativePath}`
}

function checkpointMessage(commitMessage, mnpContext) {
  const normalized = normalizeCheckpointCommitMessage(commitMessage)
  const normalizedMnpContext = normalizeCheckpointMnpContext(mnpContext)
  return {
    title: `[김용민] ${normalized.summary}`,
    body: `${checkpointMnpSection(normalizedMnpContext)}\n\n[배경]\n${normalized.background}\n\n[원인]\n${normalized.cause}\n\n[수정]\n${normalized.changes}${normalized.scope ? `\n\n[적용 범위]\n${normalized.scope}` : ''}`,
    normalized,
    mnpContext: normalizedMnpContext,
  }
}

function integrationConflictCheckpointMessage(lease) {
  const checkpoint = [...(Array.isArray(lease?.checkpoints) ? lease.checkpoints : [])]
    .reverse()
    .find((candidate) => candidate?.commitMessage)
  const source = checkpoint?.commitMessage
  if (!source) {
    throw new WorkspacePoolIntegrationError(
      '통합 충돌 보완 커밋에 사용할 구조화 커밋 메시지가 없습니다. 최신 체크포인트를 다시 생성해야 합니다.',
      { leaseId: lease?.leaseId ?? null },
    )
  }
  return checkpointMessage({
    summary: `${source.summary} 통합 충돌 해소`.slice(0, 80),
    background: `최신 main에 ${source.summary} 변경을 통합하는 과정에서 충돌이 발생했습니다.`,
    cause: 'worker와 최신 main이 동일한 코드 또는 자산 영역을 변경하여 자동 적용을 완료할 수 없었습니다.',
    changes: '기존 체크포인트의 변경 의도를 유지하면서 최신 main을 기준으로 충돌을 해결하고 통합 가능한 상태로 정리했습니다.',
    scope: source.scope ?? undefined,
  }, checkpoint?.mnpContext ?? {
    mapId: lease?.mapId,
    cardId: lease?.cardId,
    cardTitle: lease?.cardLabel,
  })
}

export function buildWorkspaceInstruction(lease) {
  if (!lease) return ''
  const sharedRoot = String(lease.sharedRoot ?? '').trim()
  return `# 할당된 작업공간

- workspaceId: \`${lease.workspaceId}\`
- jobId: \`${lease.jobId}\`
- leaseId: \`${lease.leaseId}\`
- projectRoot: \`${lease.projectRoot}\`
${sharedRoot ? `- sharedRoot: \`${sharedRoot}\`\n` : ''}- branch: \`${lease.branch}\`
- baseCommit: \`${lease.baseCommit}\`
- Unity assetsPath: \`${lease.assetsPath}\`
- Unity instance hash: \`${lease.unityInstanceHash}\`

이 작업에서는 위 \`projectRoot\`만 수정하세요. 다른 등록 작업공간으로 이동하거나 브랜치를 바꾸거나 lease를 직접 해제하지 마세요. \`.ai-session.json\`의 값이 위 정보와 일치하는지 먼저 확인하세요.${sharedRoot ? ` 공통 규칙과 지식은 \`sharedRoot\`에서 읽기 전용으로 사용하고, 제안은 \`knowledge-inbox/${lease.jobId}.md\`에 기록하세요.` : ''}

Unity Play Mode, 재임포트, 동적 폰트·Atlas 생성 등의 검증은 어떤 tracked 파일이든 자동으로 바꿀 수 있습니다. 구현 수정을 마친 뒤 각 검증을 시작하기 전에 \`mindnprogress_checkpoint_ai_workspace\`를 호출하여 의도한 변경 경로와 실제 변경을 설명하는 \`commitMessage\`를 함께 고정하세요. \`summary\`에는 \`[김용민]\` prefix나 \`[MnP]\` 출처를 넣지 말고, \`background\`·\`cause\`·\`changes\`에는 이번 체크포인트의 실제 변경을 작성하며 \`scope\`는 필요한 경우에만 작성하세요. MindNProgress가 현재 문서·카드 제목과 안정적인 ID를 조회해 커밋 본문의 \`[MnP]\` 섹션을 자동으로 추가합니다. 파일 변경이 전혀 없는 조사·검증 작업은 \`mindnprogress_confirm_ai_workspace_no_changes\`로 확인하세요. 검증 후 보완했다면 새 변경에 맞는 메시지로 다시 체크포인트를 만들고 검증하세요. Git으로 직접 커밋하지 마세요. 완료 시 MindNProgress는 명시적 체크포인트만 main에 통합하고 그 이후의 자동 변경은 복구 자료로 보존한 뒤 worker에서 제거합니다.`
}

export class WorkspacePoolManager {
  constructor({ registryFile, stateFile, gitRunner = defaultGitRunner } = {}) {
    this.registryFile = path.resolve(String(registryFile ?? '').trim())
    this.stateFile = path.resolve(String(stateFile ?? '').trim())
    this.git = gitRunner
    this.registry = null
    this.state = null
    this.queue = Promise.resolve()
  }

  runExclusive(operation) {
    const result = this.queue.catch(() => {}).then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  async initialize({ unconfirmedLeaseIds = [] } = {}) {
    return this.runExclusive(async () => {
      const rawRegistry = await readJson(this.registryFile, null)
      if (!rawRegistry) return false
      this.registry = normalizeRegistry(rawRegistry, this.registryFile)
      if (!this.registry.integration || this.registry.workers.length === 0) return false
      const stored = await readJson(this.stateFile, null)
      this.state = stored && typeof stored === 'object' ? stored : {
        schemaVersion: 1,
        poolId: this.registry.poolId,
        workspaces: {},
        leases: {},
        updatedAt: new Date().toISOString(),
      }
      this.state.workspaces ??= {}
      this.state.leases ??= {}
      for (const leaseId of unconfirmedLeaseIds) {
        const lease = this.state.leases[leaseId]
        if (lease?.status === 'quarantined') lease.executionUnconfirmed = true
      }
      this.state.integrationLeaseId ??= null
      this.state.poolId = this.registry.poolId
      for (const workspace of this.registry.workspaces) {
        this.state.workspaces[workspace.id] ??= {
          status: workspace.role === 'worker' ? 'idle' : 'integration',
          updatedAt: new Date().toISOString(),
        }
      }
      for (const workspace of this.registry.workers) {
        const current = this.state.workspaces[workspace.id]
        if (this.recoverablePreparationFailureState(current)) {
          try {
            await this.recoverPreparationFailureWorkspace(workspace, current)
          } catch (error) {
            this.state.workspaces[workspace.id] = {
              ...current,
              recoveryError: error?.message ?? String(error),
              updatedAt: new Date().toISOString(),
            }
          }
          continue
        }
        if (!this.recoverableCleanFailureLease(current?.leaseId ? this.state.leases[current.leaseId] : null)) continue
        try {
          await this.recoverCleanFailureWorkspace(workspace, current)
        } catch (error) {
          this.state.workspaces[workspace.id] = {
            ...current,
            recoveryError: error?.message ?? String(error),
            updatedAt: new Date().toISOString(),
          }
        }
      }
      await this.persist()
      return true
    })
  }

  poolForWorkspace(workspace) {
    if (!this.registry || !String(workspace ?? '').trim()) return null
    const requested = normalizedPath(workspace)
    return this.registry.workspaces.some((candidate) => normalizedPath(candidate.root) === requested)
      ? this.registry
      : null
  }

  publicSnapshot({ conversationId = '' } = {}) {
    if (!this.registry || !this.state) {
      return {
        available: false,
        poolId: null,
        integrationWorkspaceId: null,
        workspaces: [],
      }
    }
    const requestedConversationId = String(conversationId ?? '').trim()
    const activeLeaseStatuses = new Set([
      'leased',
      'checkpoint-required',
      'finalizing',
      'waiting-integration',
      'integrating',
      'awaiting-conflict-resolution',
      'resolving-integration-conflict',
    ])
    const assignedWorkspaceIds = new Set(
      requestedConversationId
        ? Object.values(this.state.leases ?? {})
            .filter((lease) => lease?.conversationId === requestedConversationId && activeLeaseStatuses.has(lease.status))
            .map((lease) => lease.workspaceId)
        : [],
    )
    const workspaces = this.registry.workspaces.map((workspace) => {
      const state = this.state.workspaces?.[workspace.id] ?? {
        status: workspace.role === 'worker' ? 'idle' : 'integration',
      }
      return {
        workspaceId: workspace.id,
        role: workspace.role,
        enabled: true,
        status: String(state.status ?? (workspace.role === 'worker' ? 'idle' : 'integration')),
        projectRoot: workspace.root,
        assetsPath: String(workspace.assetsPath ?? '').trim() || `${workspace.root.replaceAll('\\', '/')}/Assets`,
        unityInstanceHash: String(workspace.unityInstanceHash ?? '').trim() || null,
        assignedToCurrentConversation: assignedWorkspaceIds.has(workspace.id),
        ...(state.reason ? { reason: String(state.reason) } : {}),
        ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
      }
    })
    const statusCounts = Object.fromEntries(
      [...new Set(workspaces.map((workspace) => workspace.status))]
        .sort()
        .map((status) => [status, workspaces.filter((workspace) => workspace.status === status).length]),
    )
    return {
      available: true,
      poolId: this.registry.poolId,
      integrationWorkspaceId: this.registry.integration?.id ?? null,
      workspaces,
      statusCounts,
    }
  }

  recoverableIdleWorkspaceState(workspaceId) {
    const current = this.state?.workspaces?.[workspaceId] ?? { status: 'idle' }
    if (current.status === 'idle') return true
    if (current.status !== 'quarantined') return false
    if (this.recoverablePreparationFailureState(current)) return true
    const lease = current.leaseId ? this.state?.leases?.[current.leaseId] : null
    if (current.reason === idleDriftReason) {
      return !lease || ['completed', 'cancelled', 'quarantined'].includes(lease.status)
    }
    return this.recoverableCleanFailureLease(lease)
  }

  recoverableCleanFailureLease(lease) {
    if (!lease || lease.status !== 'quarantined') return false
    const result = lease.result
    if (!result) return false
    // 실행 응답이 유실되어 대화를 아직 연결하지 못한 lease는 Git이 clean이어도
    // 실제 AI가 시작됐을 수 있다. 재시작 시 회수하지 않고 명시적 복구로 확인한다.
    if (lease.executionUnconfirmed) return false
    if (retryableExternalLimitCategory(result.childError)) return false
    if (result.headCommit && result.headCommit !== lease.baseCommit) return false
    if (lease.integrationBranch || result.integrationBranch) return false
    if (Array.isArray(lease.commits) && lease.commits.length > 0) return false
    if (Array.isArray(lease.checkpoints) && lease.checkpoints.length > 0) return false
    return !Array.isArray(result.unmergedFiles) || result.unmergedFiles.length === 0
  }

  recoverablePreparationFailureState(current) {
    if (!current || current.status !== 'quarantined'
      || current.reasonCode !== workspacePreparationFailedReasonCode) return false
    const lease = current.leaseId ? this.state?.leases?.[current.leaseId] : null
    return !lease && Boolean(current.idleCommit) && Boolean(current.idleBranch)
  }

  async recoverPreparationFailureWorkspace(workspace, current) {
    if (!this.recoverablePreparationFailureState(current)) return false
    const sessionFile = path.join(workspace.root, '.ai-session.json')
    if (await exists(sessionFile)) {
      throw new Error('준비에 실패한 작업공간에 AI 세션 파일이 남아 있어 자동 회수하지 않았습니다.')
    }
    const dirty = await this.git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (dirty) {
      throw new Error('준비에 실패한 작업공간에 변경이 남아 있어 자동 회수하지 않았습니다.')
    }
    const [headCommit, branch] = await Promise.all([
      this.git(workspace.root, ['rev-parse', 'HEAD']),
      this.git(workspace.root, ['branch', '--show-current']),
    ])
    if (headCommit !== current.idleCommit || branch !== current.idleBranch) {
      throw new Error('준비에 실패한 작업공간의 브랜치 또는 HEAD가 준비 전 기준과 달라 자동 회수하지 않았습니다.')
    }

    const recoveredAt = new Date().toISOString()
    this.state.workspaces[workspace.id] = {
      status: 'idle',
      idleCommit: current.idleCommit,
      idleBranch: current.idleBranch,
      lastJobId: current.lastJobId ?? null,
      lastLeaseId: current.lastLeaseId ?? null,
      lastDriftArchive: current.lastDriftArchive ?? null,
      lastPreparationFailure: {
        jobId: current.jobId ?? null,
        preparationId: current.preparationId ?? current.leaseId ?? null,
        reason: current.reason ?? null,
        failedAt: current.updatedAt ?? null,
        recoveredAt,
      },
      updatedAt: recoveredAt,
    }
    await this.persist()
    return true
  }

  workerLastAssignedAt(workspaceId) {
    return Object.values(this.state?.leases ?? {}).reduce((latest, lease) => {
      if (lease?.workspaceId !== workspaceId) return latest
      const timestamp = Date.parse(String(lease.startedAt ?? ''))
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest
    }, 0)
  }

  orderedRecoverableWorkers() {
    return this.registry.workers
      .map((workspace, index) => ({
        workspace,
        index,
        lastAssignedAt: this.workerLastAssignedAt(workspace.id),
      }))
      .filter(({ workspace }) => this.recoverableIdleWorkspaceState(workspace.id))
      .sort((left, right) => left.lastAssignedAt - right.lastAssignedAt || left.index - right.index)
      .map(({ workspace }) => workspace)
  }

  async fetchIntegrationBranch(workspace, baseBranch) {
    await this.git(workspace.root, [
      'fetch', '--no-tags', this.registry.integration.root, `refs/heads/${baseBranch}`,
    ])
  }

  async switchWorkspaceToIdleCommit(workspace, baseBranch, idleCommit) {
    const normalizedCommit = String(idleCommit ?? '').trim()
    if (!normalizedCommit) throw new Error('작업공간 회수에 사용할 통합 기준 커밋이 없습니다.')

    const commitObject = `${normalizedCommit}^{commit}`
    try {
      await this.git(this.registry.integration.root, ['cat-file', '-e', commitObject])
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? '').trim()
      throw new Error(
        `통합 작업공간에서 회수 기준 커밋 ${normalizedCommit} 객체를 확인하지 못했습니다.`
        + (detail ? ` ${detail}` : ''),
      )
    }

    let lastError = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.fetchIntegrationBranch(workspace, baseBranch)
        await this.git(workspace.root, ['cat-file', '-e', commitObject])
        const idleBranch = `mnp/idle/${workspace.id}`
        await this.git(workspace.root, ['switch', '-C', idleBranch, normalizedCommit])
        return idleBranch
      } catch (error) {
        lastError = error
      }
    }

    const detail = String(lastError?.stderr ?? lastError?.message ?? '').trim()
    throw new Error(
      `작업공간 ${workspace.id}에 회수 기준 커밋 ${normalizedCommit}을 2회 가져온 뒤에도 객체를 확인하거나 전환하지 못했습니다.`
      + ' 기존 작업공간 상태를 보존하고 격리합니다.'
      + (detail ? ` ${detail}` : ''),
    )
  }

  async synchronizeIdleWorkersToIntegration({ workspaceIds } = {}) {
    return this.runExclusive(async () => {
      if (!this.registry || !this.state) {
        throw new WorkspacePoolUnavailableError(
          'AI 작업공간 풀이 준비되지 않았습니다.',
          [],
          'AI_WORKSPACE_SYNC_POOL_UNAVAILABLE',
        )
      }
      if (this.state.integrationLeaseId) {
        throw new WorkspacePoolUnavailableError(
          '통합 작업공간을 사용하는 작업이 진행 중이어서 동기화할 수 없습니다.',
          [{ integrationLeaseId: this.state.integrationLeaseId }],
          'AI_WORKSPACE_SYNC_INTEGRATION_BUSY',
        )
      }

      const requestedIds = workspaceIds === undefined
        ? this.registry.workers.map((workspace) => workspace.id)
        : [...new Set((Array.isArray(workspaceIds) ? workspaceIds : [])
          .map((id) => String(id ?? '').trim()).filter(Boolean))]
      if (requestedIds.length === 0) {
        throw new WorkspacePoolUnavailableError(
          '동기화할 worker 작업공간이 없습니다.',
          [],
          'AI_WORKSPACE_SYNC_TARGET_REQUIRED',
        )
      }
      const workersById = new Map(this.registry.workers.map((workspace) => [workspace.id, workspace]))
      const unknownIds = requestedIds.filter((id) => !workersById.has(id))
      if (unknownIds.length > 0) {
        throw new WorkspacePoolUnavailableError(
          `등록된 worker가 아닌 작업공간이 포함되어 있습니다: ${unknownIds.join(', ')}`,
          unknownIds.map((workspaceId) => ({ workspaceId })),
          'AI_WORKSPACE_SYNC_TARGET_INVALID',
        )
      }

      const integration = this.registry.integration
      const integrationStatus = nullSeparated(await this.git(integration.root, [
        'status', '--porcelain=v1', '-z', '--untracked-files=no',
      ], { timeoutMs: integrationGitProbeTimeoutMs }))
      if (integrationStatus.length > 0) {
        throw new WorkspacePoolUnavailableError(
          integrationWorktreeDirtyMessage,
          integrationStatus.map((entry) => ({ entry })),
          'AI_WORKSPACE_SYNC_INTEGRATION_DIRTY',
        )
      }

      const [baseBranch, baseCommit, baseTree] = await Promise.all([
        this.git(integration.root, ['branch', '--show-current']),
        this.git(integration.root, ['rev-parse', 'HEAD']),
        this.git(integration.root, ['rev-parse', 'HEAD^{tree}']),
      ])
      if (!baseBranch || !baseCommit || !baseTree) {
        throw new WorkspacePoolUnavailableError(
          '통합 작업공간의 현재 브랜치와 커밋을 확인하지 못했습니다.',
          [],
          'AI_WORKSPACE_SYNC_INTEGRATION_INVALID',
        )
      }

      const preflight = []
      for (const id of requestedIds) {
        const workspace = workersById.get(id)
        const current = this.state.workspaces[workspace.id]
        if (current?.status !== 'idle') {
          throw new WorkspacePoolUnavailableError(
            `${workspace.id} 작업공간이 idle 상태가 아니어서 동기화할 수 없습니다.`,
            [{ workspaceId: workspace.id, status: current?.status ?? null }],
            'AI_WORKSPACE_SYNC_WORKER_BUSY',
          )
        }
        if (await exists(path.join(workspace.root, '.ai-session.json'))) {
          throw new WorkspacePoolUnavailableError(
            `${workspace.id} 작업공간에 활성 세션 파일이 남아 있어 동기화할 수 없습니다.`,
            [{ workspaceId: workspace.id }],
            'AI_WORKSPACE_SYNC_SESSION_PRESENT',
          )
        }
        const trackedStatus = nullSeparated(await this.git(workspace.root, [
          'status', '--porcelain=v1', '-z', '--untracked-files=no',
        ]))
        if (trackedStatus.length > 0) {
          throw new WorkspacePoolUnavailableError(
            `${workspace.id} 작업공간에 커밋되지 않은 추적 파일 변경이 있습니다.`,
            trackedStatus.map((entry) => ({ workspaceId: workspace.id, entry })),
            'AI_WORKSPACE_SYNC_WORKER_DIRTY',
          )
        }
        const [branch, commit] = await Promise.all([
          this.git(workspace.root, ['branch', '--show-current']),
          this.git(workspace.root, ['rev-parse', 'HEAD']),
        ])
        if (current.idleBranch && branch !== current.idleBranch) {
          throw new WorkspacePoolUnavailableError(
            `${workspace.id}의 실제 브랜치가 풀에 기록된 idle 브랜치와 다릅니다.`,
            [{ workspaceId: workspace.id, expected: current.idleBranch, actual: branch }],
            'AI_WORKSPACE_SYNC_STATE_MISMATCH',
          )
        }
        if (current.idleCommit && commit !== current.idleCommit) {
          throw new WorkspacePoolUnavailableError(
            `${workspace.id}의 실제 커밋이 풀에 기록된 idle 커밋과 다릅니다.`,
            [{ workspaceId: workspace.id, expected: current.idleCommit, actual: commit }],
            'AI_WORKSPACE_SYNC_STATE_MISMATCH',
          )
        }
        preflight.push({ workspace, previousCommit: commit })
      }

      const synchronized = []
      for (const { workspace, previousCommit } of preflight) {
        const idleBranch = await this.switchWorkspaceToIdleCommit(workspace, baseBranch, baseCommit)
        const [actualBranch, actualCommit, actualTree, trackedStatus] = await Promise.all([
          this.git(workspace.root, ['branch', '--show-current']),
          this.git(workspace.root, ['rev-parse', 'HEAD']),
          this.git(workspace.root, ['rev-parse', 'HEAD^{tree}']),
          this.git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']),
        ])
        if (actualBranch !== idleBranch || actualCommit !== baseCommit || actualTree !== baseTree || trackedStatus) {
          throw new WorkspacePoolUnavailableError(
            `${workspace.id} 작업공간의 동기화 사후 검증에 실패했습니다.`,
            [{ workspaceId: workspace.id, actualBranch, actualCommit, actualTree }],
            'AI_WORKSPACE_SYNC_VERIFICATION_FAILED',
          )
        }
        const previous = this.state.workspaces[workspace.id]
        this.state.workspaces[workspace.id] = {
          ...previous,
          status: 'idle',
          idleCommit: baseCommit,
          idleBranch,
          updatedAt: new Date().toISOString(),
        }
        delete this.state.workspaces[workspace.id].recoveryError
        await this.persist()
        synchronized.push({
          workspaceId: workspace.id,
          branch: idleBranch,
          previousCommit,
          commit: baseCommit,
          changed: previousCommit !== baseCommit,
        })
      }

      const currentIntegrationCommit = await this.git(integration.root, ['rev-parse', 'HEAD'])
      if (currentIntegrationCommit !== baseCommit) {
        throw new WorkspacePoolUnavailableError(
          '동기화 도중 main 커밋이 변경되었습니다. 현재 main을 기준으로 다시 실행해 주세요.',
          [{ synchronizedCommit: baseCommit, currentIntegrationCommit }],
          'AI_WORKSPACE_SYNC_INTEGRATION_MOVED',
        )
      }

      return {
        poolId: this.registry.poolId,
        integrationWorkspaceId: integration.id,
        baseBranch,
        baseCommit,
        baseTree,
        workspaces: synchronized,
      }
    })
  }

  async recoverCleanFailureWorkspace(workspace, current) {
    const lease = current.leaseId ? this.state?.leases?.[current.leaseId] : null
    // 사용량 대기는 작업 소유권을 유지한다. 다른 위임의 배정 과정에서 회수하지 않는다.
    if (retryableExternalLimitCategory(lease?.result?.childError)) return false
    if (!this.recoverableCleanFailureLease(lease)) return false

    const sessionFile = path.join(workspace.root, '.ai-session.json')
    const session = await readJson(sessionFile, null)
    if (session && (
      session.workspaceId !== workspace.id
      || session.jobId !== lease.jobId
      || session.leaseId !== lease.leaseId
    )) {
      throw new Error('격리된 작업공간의 세션 소유권이 기존 lease와 일치하지 않습니다.')
    }
    const dirty = await this.git(workspace.root, ['status', '--porcelain', '--untracked-files=all'])
    if (dirty) throw new Error('격리된 작업공간에 보존해야 할 변경이 남아 있어 자동 회수하지 않았습니다.')
    const [headCommit, branch, idleCommit, idleBaseBranch] = await Promise.all([
      this.git(workspace.root, ['rev-parse', 'HEAD']),
      this.git(workspace.root, ['branch', '--show-current']),
      this.git(this.registry.integration.root, ['rev-parse', 'HEAD']),
      this.git(this.registry.integration.root, ['branch', '--show-current']),
    ])
    if (headCommit !== lease.baseCommit || branch !== lease.branch) {
      throw new Error('격리된 작업공간의 Git 기준선이 기존 lease와 달라 자동 회수하지 않았습니다.')
    }

    const idleBranch = await this.switchWorkspaceToIdleCommit(workspace, idleBaseBranch, idleCommit)
    await rm(sessionFile, { force: true })
    const recoveredAt = new Date().toISOString()
    const result = await this.writeResult(lease, {
      ...lease.result,
      status: 'failed-clean',
      recoveredFromQuarantine: true,
      recoveredAt,
    })
    lease.status = 'cancelled'
    lease.result = result
    this.state.workspaces[workspace.id] = {
      status: 'idle',
      idleCommit,
      idleBranch,
      lastJobId: lease.jobId,
      lastLeaseId: lease.leaseId,
      updatedAt: recoveredAt,
    }
    await this.persist()
    return true
  }

  async archiveAndRestoreDriftOnce(workspace, {
    reason,
    phase,
    jobId = null,
    leaseId = null,
    idleCommit = null,
    attempt = 1,
    previousArchives = [],
  } = {}) {
    const status = await this.git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!status) return null

    const detectedAt = new Date()
    const branch = await this.git(workspace.root, ['branch', '--show-current'])
    const headCommit = await this.git(workspace.root, ['rev-parse', 'HEAD'])
    const trackedDiff = await this.git(workspace.root, ['diff', '--binary', '--no-ext-diff'])
    const stagedDiff = await this.git(workspace.root, ['diff', '--cached', '--binary', '--no-ext-diff'])
    const untracked = nullSeparated(await this.git(workspace.root, ['ls-files', '--others', '--exclude-standard', '-z']))
      .map(safeRelativePath)
      .filter(Boolean)
    const protectedUntracked = untracked.filter(isProtectedWorkspacePath)
    if (protectedUntracked.length > 0) {
      throw new Error(`AI 작업공간 인프라 항목은 자동 정리하지 않습니다: ${protectedUntracked.join(', ')}`)
    }
    const archiveRoot = path.join(
      this.registry.sharedRoot,
      'workspace-drift',
      workspace.id,
      `${driftFolderName(detectedAt)}-${randomBytes(3).toString('hex')}`,
    )
    await mkdir(archiveRoot, { recursive: true })
    await Promise.all([
      writeFile(path.join(archiveRoot, 'tracked.diff'), trackedDiff, 'utf8'),
      writeFile(path.join(archiveRoot, 'staged.diff'), stagedDiff, 'utf8'),
    ])

    const archivedUntracked = []
    for (const relative of untracked) {
      const source = pathInside(workspace.root, relative)
      const target = pathInside(path.join(archiveRoot, 'untracked'), relative)
      const info = await lstat(source)
      await mkdir(path.dirname(target), { recursive: true })
      if (info.isFile()) {
        await copyFile(source, target)
        archivedUntracked.push({ path: relative, type: 'file', size: info.size })
      } else if (info.isSymbolicLink()) {
        const link = await readlink(source)
        await writeFile(`${target}.symlink.txt`, link, 'utf8')
        archivedUntracked.push({ path: relative, type: 'symbolic-link', target: link })
      } else {
        throw new Error(`복구 보존을 지원하지 않는 untracked 항목입니다: ${relative}`)
      }
    }

    const metadata = {
      schemaVersion: 1,
      poolId: this.registry.poolId,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      reason: String(reason ?? '자동 생성된 작업공간 drift'),
      phase: String(phase ?? 'idle'),
      jobId,
      leaseId,
      branch,
      headCommit,
      idleCommit,
      attempt,
      previousArchives,
      status,
      untracked: archivedUntracked,
      detectedAt: detectedAt.toISOString(),
    }
    await atomicJson(path.join(archiveRoot, 'metadata.json'), metadata)

    await this.git(workspace.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'])
    for (const relative of untracked) {
      await rm(pathInside(workspace.root, relative), { force: true })
    }
    const remaining = await this.git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (remaining) {
      metadata.remainingAfterRestore = remaining
      await atomicJson(path.join(archiveRoot, 'metadata.json'), metadata)
    }
    return { archiveRoot, metadata, remaining }
  }

  async archiveAndRestoreDrift(workspace, options = {}) {
    const archives = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const drift = await this.archiveAndRestoreDriftOnce(workspace, {
        ...options,
        attempt,
        previousArchives: [...archives],
      })
      if (!drift) {
        return archives.length > 0
          ? { archiveRoot: archives.at(-1), archiveRoots: archives }
          : null
      }
      archives.push(drift.archiveRoot)
      if (!drift.remaining) return { ...drift, archiveRoots: archives }
      if (attempt < 3) await delay(250)
    }
    throw new Error(`drift 복원 중 Unity가 변경을 계속 생성했습니다. 복구 자료: ${archives.join(', ')}`)
  }

  async prepareIdleWorkspace(workspace, current, context = {}) {
    const sessionFile = path.join(workspace.root, '.ai-session.json')
    if (await exists(sessionFile)) throw new Error('.ai-session.json이 이미 존재합니다.')
    const dirty = await this.git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    let drift = null
    if (dirty) {
      drift = await this.archiveAndRestoreDrift(workspace, {
        reason: current.reason ?? '유휴 worker에서 발견된 소유자 미확인 변경',
        phase: 'idle-preparation',
        jobId: context.jobId,
        leaseId: context.leaseId,
        idleCommit: current.idleCommit ?? null,
      })
    }
    this.state.workspaces[workspace.id] = {
      status: 'idle',
      idleCommit: current.idleCommit ?? null,
      lastJobId: current.lastJobId ?? null,
      lastLeaseId: current.lastLeaseId ?? null,
      lastDriftArchive: drift?.archiveRoot ?? current.lastDriftArchive ?? null,
      updatedAt: new Date().toISOString(),
    }
    await this.persist()
    return drift
  }

  async checkpoint(leaseId, {
    jobId,
    mapId,
    cardId,
    conversationId,
    paths,
    confirmNoChanges = false,
    commitMessage,
    mnpContext,
  } = {}) {
    return this.runExclusive(async () => {
      const lease = this.state?.leases?.[String(leaseId ?? '').trim()]
      if (!lease || !conversationBindableLeaseStatuses.has(lease.status)) {
        throw new WorkspacePoolUnavailableError('체크포인트를 생성할 활성 AI 작업공간 lease를 찾지 못했습니다.')
      }
      const requestedConversationId = String(conversationId ?? '').trim()
      if (String(jobId ?? '') !== lease.jobId
        || String(mapId ?? '') !== lease.mapId
        || String(cardId ?? '') !== lease.cardId
        || (requestedConversationId && requestedConversationId !== lease.conversationId)) {
        throw new WorkspacePoolUnavailableError('체크포인트 요청이 현재 AI 작업공간 소유권과 일치하지 않습니다.')
      }
      const workspace = this.registry.workspaces.find((candidate) => candidate.id === lease.workspaceId)
      if (!workspace) throw new WorkspacePoolUnavailableError('체크포인트 작업공간을 찾지 못했습니다.')
      const currentBranch = await this.git(workspace.root, ['branch', '--show-current'])
      if (currentBranch !== lease.branch) {
        throw new WorkspacePoolUnavailableError(`체크포인트 브랜치가 ${lease.branch}가 아닙니다.`)
      }
      const intendedPaths = [...new Set((Array.isArray(paths) ? paths : []).map(safeRelativePath).filter(Boolean))]
      if (intendedPaths.length === 0) {
        if (!confirmNoChanges) {
          throw new WorkspacePoolUnavailableError('체크포인트에 포함할 의도된 변경 경로가 필요합니다. 의도한 파일 변경이 없다면 mindnprogress_confirm_ai_workspace_no_changes를 사용하세요.')
        }
        if (commitMessage !== undefined && commitMessage !== null) {
          throw checkpointCommitMessageError('무변경 확인에는 commitMessage를 전달하지 마세요.')
        }
        const checkpoint = {
          commit: await this.git(workspace.root, ['rev-parse', 'HEAD']),
          paths: [],
          noCodeChanges: true,
          createdAt: new Date().toISOString(),
        }
        lease.checkpoints ??= []
        lease.checkpoints.push(checkpoint)
        lease.status = 'leased'
        lease.updatedAt = checkpoint.createdAt
        this.state.workspaces[workspace.id] = {
          status: 'leased',
          jobId: lease.jobId,
          leaseId: lease.leaseId,
          updatedAt: checkpoint.createdAt,
        }
        await this.persist()
        return { lease: publicLease(lease), checkpoint, noChanges: true }
      }
      if (confirmNoChanges) {
        throw new WorkspacePoolUnavailableError(
          '변경 경로가 있으면 mindnprogress_confirm_ai_workspace_no_changes를 사용할 수 없습니다.',
          [],
          'AI_WORKSPACE_CHECKPOINT_INPUT_INVALID',
        )
      }
      const normalizedCommitMessage = normalizeCheckpointCommitMessage(commitMessage)
      const scopedStatus = await this.git(workspace.root, [
        'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...intendedPaths,
      ])
      if (!scopedStatus) {
        return {
          lease: publicLease(lease),
          checkpoint: null,
          noChanges: true,
          paths: intendedPaths,
        }
      }
      await this.git(workspace.root, ['add', '--', ...intendedPaths])
      const stagedPaths = nullSeparated(await this.git(workspace.root, ['diff', '--cached', '--name-only', '-z']))
      const unexpected = stagedPaths.filter((item) => !intendedPaths.includes(item.replaceAll('\\', '/')))
      if (unexpected.length > 0) {
        await this.git(workspace.root, ['restore', '--staged', '--', ...stagedPaths])
        throw new WorkspacePoolUnavailableError(`의도하지 않은 staged 변경이 포함되어 체크포인트를 중단했습니다: ${unexpected.join(', ')}`)
      }
      const message = checkpointMessage(normalizedCommitMessage, normalizeCheckpointMnpContext(mnpContext, {
        mapId: lease.mapId,
        cardId: lease.cardId,
        cardTitle: lease.cardLabel,
      }))
      await this.git(workspace.root, ['commit', '-m', message.title, '-m', message.body])
      const commit = await this.git(workspace.root, ['rev-parse', 'HEAD'])
      const checkpoint = {
        commit,
        paths: intendedPaths,
        commitMessage: message.normalized,
        mnpContext: message.mnpContext,
        createdAt: new Date().toISOString(),
      }
      lease.checkpoints ??= []
      lease.checkpoints.push(checkpoint)
      lease.status = 'leased'
      lease.updatedAt = checkpoint.createdAt
      this.state.workspaces[workspace.id] = {
        status: 'leased',
        jobId: lease.jobId,
        leaseId: lease.leaseId,
        updatedAt: checkpoint.createdAt,
      }
      await this.persist()
      return { lease: publicLease(lease), checkpoint, noChanges: false }
    })
  }

  async acquire({ workspaceHint, mapId, cardId, conversationId, cardLabel, replacesLeaseId } = {}) {
    return this.runExclusive(async () => {
      if (!this.poolForWorkspace(workspaceHint)) return null
      if (replacesLeaseId) {
        const previous = this.state.leases[replacesLeaseId]
        if (previous?.status !== 'cancelled' || previous.result?.status !== 'failed-clean'
          || previous.result?.childStatus !== 'failed'
          || !retryableExternalLimitCategory(previous.result.childError)
          || previous.mapId !== mapId || previous.cardId !== cardId
          || !conversationId || previous.conversationId !== conversationId) {
          throw new WorkspacePoolUnavailableError('변경 없이 반납된 한도 중단 작업의 소유권을 확인할 수 없습니다.', [], 'RELEASED_LEASE_RECOVERY_MISMATCH')
        }
        // 배정 후 응답 유실·재시작이 있어도 같은 복구용 lease를 다시 사용한다.
        const existing = Object.values(this.state.leases).find((item) => item.replacesLeaseId === replacesLeaseId && item.status === 'leased')
        if (existing) return publicLease(existing)
        if (Object.values(this.state.leases).some((item) => item.conversationId === conversationId && !['completed', 'cancelled'].includes(item.status))) {
          throw new WorkspacePoolUnavailableError('같은 대화의 작업공간이 이미 점유되어 있습니다.', [], 'CONVERSATION_ALREADY_LEASED')
        }
      }
      const integration = this.registry.integration
      const integrationChanges = await this.integrationTrackedChanges(integration)
      if (integrationChanges.dirty) {
        throw new WorkspacePoolUnavailableError(
          integrationWorktreeDirtyMessage,
          integrationChanges.paths,
          integrationWorktreeDirtyReasonCode,
        )
      }
      const [baseCommit, baseBranch] = await Promise.all([
        this.git(integration.root, ['rev-parse', 'HEAD']),
        this.git(integration.root, ['branch', '--show-current']),
      ])
      if (!baseCommit || !baseBranch) {
        throw new WorkspacePoolUnavailableError(
          '통합 작업공간의 Git 기준선을 확인하지 못했습니다.',
          [],
          'INTEGRATION_BASE_UNAVAILABLE',
        )
      }

      const jobId = `job-${Date.now()}-${randomBytes(4).toString('hex')}`
      const leaseId = `lease-${randomBytes(16).toString('hex')}`
      const branch = `mnp/${jobId}`
      const failures = []
      for (const workspace of this.orderedRecoverableWorkers()) {
        let current = this.state.workspaces[workspace.id] ?? { status: 'idle' }
        if (this.recoverablePreparationFailureState(current)) {
          try {
            await this.recoverPreparationFailureWorkspace(workspace, current)
            current = this.state.workspaces[workspace.id]
          } catch (error) {
            const reason = error?.message ?? String(error)
            failures.push({ workspaceId: workspace.id, reason })
            this.state.workspaces[workspace.id] = {
              ...current,
              recoveryError: reason,
              updatedAt: new Date().toISOString(),
            }
            await this.persist()
            continue
          }
        }
        if (current.status === 'quarantined' && current.reason !== idleDriftReason) {
          try {
            await this.recoverCleanFailureWorkspace(workspace, current)
            current = this.state.workspaces[workspace.id]
          } catch (error) {
            const reason = error?.message ?? String(error)
            failures.push({ workspaceId: workspace.id, reason })
            this.state.workspaces[workspace.id] = {
              ...current,
              recoveryError: reason,
              updatedAt: new Date().toISOString(),
            }
            await this.persist()
            continue
          }
        }
        let preparationIdleCommit = current.idleCommit ?? null
        let preparationIdleBranch = current.idleBranch ?? null
        try {
          [preparationIdleCommit, preparationIdleBranch] = await Promise.all([
            this.git(workspace.root, ['rev-parse', 'HEAD']),
            this.git(workspace.root, ['branch', '--show-current']),
          ])
          this.state.workspaces[workspace.id] = {
            ...current,
            status: 'preparing',
            jobId,
            preparationId: leaseId,
            idleCommit: preparationIdleCommit,
            idleBranch: preparationIdleBranch,
            updatedAt: new Date().toISOString(),
          }
          await this.persist()
          const recoveredDrift = await this.prepareIdleWorkspace(workspace, current, { jobId, leaseId })
          const sessionFile = path.join(workspace.root, '.ai-session.json')
          const originUrl = await this.git(workspace.root, ['remote', 'get-url', 'origin'])
          if (this.registry.originUrl && originUrl !== this.registry.originUrl) {
            throw new Error('작업공간 origin URL이 registry와 일치하지 않습니다.')
          }
          await this.git(workspace.root, ['fetch', '--no-tags', integration.root, `refs/heads/${baseBranch}`])
          await this.git(workspace.root, ['branch', branch, baseCommit])
          await this.git(workspace.root, ['switch', branch])
          const startedAt = new Date().toISOString()
          const lease = {
            schemaVersion: 1,
            poolId: this.registry.poolId,
            sharedRoot: this.registry.sharedRoot,
            workspaceId: workspace.id,
            jobId,
            leaseId,
            projectRoot: workspace.root,
            assetsPath: workspace.assetsPath ?? path.join(workspace.root, 'Assets'),
            unityInstanceHash: String(workspace.unityInstanceHash ?? ''),
            branch,
            baseBranch,
            baseCommit,
            integrationWorkspaceId: integration.id,
            mapId: String(mapId ?? ''),
            cardId: String(cardId ?? ''),
            cardLabel: String(cardLabel ?? ''),
            conversationId: String(conversationId ?? ''),
            startedAt,
            status: 'leased',
            ...(replacesLeaseId ? { replacesLeaseId } : {}),
          }
          await atomicJson(sessionFile, {
            schemaVersion: 1,
            workspaceId: lease.workspaceId,
            jobId,
            leaseId,
            conversationId: lease.conversationId,
            projectRoot: lease.projectRoot,
            sharedRoot: lease.sharedRoot,
            branch,
            baseCommit,
            knowledgeMode: 'read-only',
            startedAt,
          })
          this.state.leases[leaseId] = lease
          this.state.workspaces[workspace.id] = {
            status: 'leased',
            jobId,
            leaseId,
            lastDriftArchive: recoveredDrift?.archiveRoot ?? current.lastDriftArchive ?? null,
            updatedAt: startedAt,
          }
          await this.persist()
          return publicLease(lease)
        } catch (error) {
          const reason = error?.message ?? String(error)
          failures.push({ workspaceId: workspace.id, reason })
          this.state.workspaces[workspace.id] = {
            status: 'quarantined',
            reason,
            reasonCode: reason === idleDriftReason ? 'IDLE_WORKTREE_DRIFT' : workspacePreparationFailedReasonCode,
            jobId,
            preparationId: leaseId,
            idleCommit: preparationIdleCommit,
            idleBranch: preparationIdleBranch,
            lastJobId: current.lastJobId ?? null,
            lastLeaseId: current.lastLeaseId ?? null,
            lastDriftArchive: current.lastDriftArchive ?? null,
            updatedAt: new Date().toISOString(),
          }
          await this.persist()
        }
      }
      throw new WorkspacePoolUnavailableError(
        '사용 가능한 AI 작업공간이 없습니다.',
        failures,
        failures.length > 0 ? workspacePreparationFailedReasonCode : 'CAPACITY_EXHAUSTED',
      )
    })
  }

  async reactivateQuarantinedLease(leaseId, {
    mapId,
    cardId,
    conversationId,
    failureCategory,
    confirmedDispatchLease,
  } = {}) {
    // 서버가 원본 operation 또는 만료 후 최초 위임 전문을 직접 검증한 경우에만 사용한다.
    // 요청 본문이나 AI가 주장한 대화 ID만으로 격리를 해제하지 않는다.
    const dispatchRecovery = failureCategory === 'confirmed-dispatch'
    if (dispatchRecovery && !aiDelegationWorkspaceLeaseMatches(this.state?.leases?.[leaseId], confirmedDispatchLease)) {
      throw new WorkspacePoolUnavailableError('기존 실행의 작업공간 소유권을 확인하지 못했습니다.')
    }
    // 재활성화 뒤 복구 요청 저장에 실패했어도 이미 확보한 소유권으로 재시도한다.
    if (this.state?.leases?.[leaseId]?.status === 'leased') {
      return this.reuseLease(leaseId, { mapId, cardId, conversationId })
    }
    return this.runExclusive(async () => {
      const normalizedLeaseId = String(leaseId ?? '').trim()
      const normalizedConversationId = String(conversationId ?? '').trim()
      if (!dispatchRecovery && !['usage-limit', 'rate-limit'].includes(String(failureCategory ?? '').trim())) {
        throw new WorkspacePoolUnavailableError(
          '외부 사용량 또는 요청 한도로 확인된 격리 lease만 재활성화할 수 있습니다.',
          [],
          'QUARANTINED_LEASE_FAILURE_NOT_RETRYABLE',
        )
      }
      const lease = this.state?.leases?.[normalizedLeaseId]
      if (!lease || lease.status !== 'quarantined' || lease.result?.status !== 'quarantined'
        || (!dispatchRecovery && lease.result?.childStatus !== 'failed')) {
        throw new WorkspacePoolUnavailableError(
          '재개할 격리 AI 작업공간 lease를 찾지 못했습니다.',
          [],
          'QUARANTINED_LEASE_NOT_FOUND',
        )
      }
      if (lease.mapId !== String(mapId ?? '') || lease.cardId !== String(cardId ?? '')) {
        throw new WorkspacePoolUnavailableError(
          '재개할 격리 AI 작업공간 lease의 문서 또는 카드가 일치하지 않습니다.',
          [],
          'QUARANTINED_LEASE_SCOPE_MISMATCH',
        )
      }
      if (!normalizedConversationId || (lease.conversationId !== normalizedConversationId && !(dispatchRecovery && !lease.conversationId))) {
        throw new WorkspacePoolUnavailableError(
          '재개할 격리 AI 작업공간 lease의 대화가 일치하지 않습니다.',
          [],
          'QUARANTINED_LEASE_CONVERSATION_MISMATCH',
        )
      }
      if (lease.integrationBranch || lease.result?.integrationBranch
        || (Array.isArray(lease.result?.unmergedFiles) && lease.result.unmergedFiles.length > 0)) {
        throw new WorkspacePoolUnavailableError(
          '통합이 시작됐거나 충돌이 남은 격리 작업공간은 하위 작업 재개 방식으로 복구할 수 없습니다.',
          [],
          'QUARANTINED_LEASE_INTEGRATION_PRESENT',
        )
      }

      const workspace = this.registry?.workspaces.find((candidate) => candidate.id === lease.workspaceId)
      const workspaceState = this.state?.workspaces?.[lease.workspaceId]
      if (!workspace || workspace.role !== 'worker' || workspace.enabled === false || workspaceState?.status !== 'quarantined'
        || workspaceState?.leaseId !== normalizedLeaseId) {
        throw new WorkspacePoolUnavailableError(
          '격리 작업공간의 점유 상태가 lease와 일치하지 않습니다.',
          [],
          'QUARANTINED_LEASE_STATE_MISMATCH',
        )
      }
      const conflictingLease = Object.values(this.state.leases).find((candidate) =>
        candidate?.leaseId !== normalizedLeaseId
        && candidate?.conversationId === normalizedConversationId
        && !['completed', 'cancelled', 'quarantined'].includes(candidate?.status))
      if (conflictingLease) {
        throw new WorkspacePoolUnavailableError(
          '같은 AI 대화가 이미 다른 활성 작업공간 lease에 연결되어 있습니다.',
          [{
            conversationId: normalizedConversationId,
            leaseId: conflictingLease.leaseId,
            workspaceId: conflictingLease.workspaceId,
          }],
          'CONVERSATION_ALREADY_LEASED',
        )
      }

      const sessionFile = path.join(workspace.root, '.ai-session.json')
      const session = await readJson(sessionFile, null)
      if (!session
        || session.workspaceId !== lease.workspaceId
        || session.jobId !== lease.jobId
        || session.leaseId !== normalizedLeaseId
        || (session.conversationId !== normalizedConversationId && !(dispatchRecovery && !session.conversationId))
        || (dispatchRecovery && (normalizedPath(session.projectRoot) !== normalizedPath(workspace.root) || normalizedPath(lease.projectRoot) !== normalizedPath(workspace.root)))
        || session.branch !== lease.branch
        || session.baseCommit !== lease.baseCommit) {
        throw new WorkspacePoolUnavailableError(
          '격리 작업공간의 세션 파일이 lease와 일치하지 않습니다.',
          [],
          'QUARANTINED_LEASE_SESSION_MISMATCH',
        )
      }

      const [dirty, currentBranch, currentHead, mergeHead, cherryPickHead, rebaseApply, rebaseMerge, unmerged] = await Promise.all([
        this.git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        this.git(workspace.root, ['branch', '--show-current']),
        this.git(workspace.root, ['rev-parse', 'HEAD']),
        this.gitPathExists(workspace.root, 'MERGE_HEAD'),
        this.gitPathExists(workspace.root, 'CHERRY_PICK_HEAD'),
        this.gitPathExists(workspace.root, 'rebase-apply'),
        this.gitPathExists(workspace.root, 'rebase-merge'),
        this.git(workspace.root, ['diff', '--name-only', '--diff-filter=U']),
      ])
      // 같은 세션의 작업 중 변경은 복구할 대상이다. 아래 소유권·HEAD·Git 작업 검증 후
      // 그대로 이어가며, 커밋이나 정리 작업을 강제하지 않는다.
      if (currentBranch !== lease.branch) {
        throw new WorkspacePoolUnavailableError(
          `격리 작업공간 브랜치가 ${lease.branch}가 아닙니다.`,
          [{ expected: lease.branch, actual: currentBranch }],
          'QUARANTINED_LEASE_BRANCH_MISMATCH',
        )
      }
      const expectedHead = String(lease.result?.headCommit ?? lease.headCommit ?? lease.baseCommit).trim()
      if (!expectedHead || currentHead !== expectedHead) {
        throw new WorkspacePoolUnavailableError(
          '격리 작업공간 HEAD가 서버에 기록된 커밋과 일치하지 않습니다.',
          [{ expected: expectedHead || null, actual: currentHead }],
          'QUARANTINED_LEASE_HEAD_MISMATCH',
        )
      }
      if (mergeHead || cherryPickHead || rebaseApply || rebaseMerge || unmerged) {
        throw new WorkspacePoolUnavailableError(
          '격리 작업공간에 완료되지 않은 Git 작업이 남아 있어 자동 재개하지 않았습니다.',
          [],
          'QUARANTINED_LEASE_GIT_OPERATION_PRESENT',
        )
      }
      for (const checkpoint of Array.isArray(lease.checkpoints) ? lease.checkpoints : []) {
        const commit = String(checkpoint?.commit ?? '').trim()
        if (!commit) continue
        try {
          await this.git(workspace.root, ['merge-base', '--is-ancestor', commit, currentHead])
        } catch {
          throw new WorkspacePoolUnavailableError(
            '격리 작업공간 HEAD에 기록된 체크포인트가 포함되어 있지 않습니다.',
            [{ checkpoint: commit, head: currentHead }],
            'QUARANTINED_LEASE_CHECKPOINT_MISMATCH',
          )
        }
      }

      const recoveredAt = new Date().toISOString()
      lease.recoveryHistory ??= []
      lease.recoveryHistory.push({
        type: dispatchRecovery ? 'confirmed-dispatch' : 'retryable-child-failure',
        previousStatus: lease.status,
        previousResult: lease.result,
        uncommittedChangesPreserved: Boolean(dirty),
        recoveredAt,
      })
      lease.recoveryHistory = lease.recoveryHistory.slice(-20)
      lease.status = 'leased'
      lease.conversationId = normalizedConversationId
      delete lease.executionUnconfirmed
      lease.updatedAt = recoveredAt
      delete lease.result
      delete lease.headCommit
      delete lease.commits
      this.state.workspaces[workspace.id] = {
        ...workspaceState,
        status: 'leased',
        reason: null,
        recoveryError: null,
        updatedAt: recoveredAt,
      }
      await atomicJson(sessionFile, {
        ...session,
        conversationId: normalizedConversationId,
        recovery: {
          type: dispatchRecovery ? 'confirmed-dispatch' : 'retryable-child-failure',
          recoveredAt,
        },
        updatedAt: recoveredAt,
      })
      await this.persist()
      return publicLease(lease)
    })
  }

  async reuseLease(leaseId, { mapId, cardId, conversationId } = {}) {
    return this.runExclusive(async () => {
      const normalizedLeaseId = String(leaseId ?? '').trim()
      const normalizedConversationId = String(conversationId ?? '').trim()
      const lease = this.state?.leases?.[normalizedLeaseId]
      if (!lease || !conversationReusableLeaseStatuses.has(lease.status)) {
        throw new WorkspacePoolUnavailableError('이어갈 AI 작업공간 lease를 찾지 못했습니다.')
      }
      if (lease.mapId !== String(mapId ?? '') || lease.cardId !== String(cardId ?? '')) {
        throw new WorkspacePoolUnavailableError('이어갈 AI 작업공간 lease의 문서 또는 카드가 일치하지 않습니다.')
      }
      if (!normalizedConversationId) {
        throw new WorkspacePoolUnavailableError('이어갈 AI 작업공간 lease에 연결할 대화 ID가 없습니다.')
      }
      if (lease.conversationId && lease.conversationId !== normalizedConversationId) {
        throw new WorkspacePoolUnavailableError('이어갈 AI 작업공간 lease가 다른 대화에 연결되어 있습니다.')
      }
      const conflictingLease = Object.values(this.state.leases).find((candidate) =>
        candidate?.leaseId !== normalizedLeaseId
        && candidate?.conversationId === normalizedConversationId
        && !['completed', 'cancelled', 'quarantined'].includes(candidate?.status))
      if (conflictingLease) {
        throw new WorkspacePoolUnavailableError(
          '같은 AI 대화가 이미 다른 활성 작업공간 lease에 연결되어 있습니다.',
          [{
            conversationId: normalizedConversationId,
            leaseId: conflictingLease.leaseId,
            workspaceId: conflictingLease.workspaceId,
          }],
          'CONVERSATION_ALREADY_LEASED',
        )
      }

      const workspace = this.registry?.workspaces.find((candidate) => candidate.id === lease.workspaceId)
      const workspaceState = this.state?.workspaces?.[lease.workspaceId]
      if (!workspace
        || !conversationReusableLeaseStatuses.has(workspaceState?.status)
        || workspaceState?.leaseId !== normalizedLeaseId) {
        throw new WorkspacePoolUnavailableError('이어갈 AI 작업공간의 점유 상태가 lease와 일치하지 않습니다.')
      }
      const sessionFile = path.join(workspace.root, '.ai-session.json')
      const session = await readJson(sessionFile, null)
      if (!session
        || session.workspaceId !== lease.workspaceId
        || session.jobId !== lease.jobId
        || session.leaseId !== normalizedLeaseId) {
        throw new WorkspacePoolUnavailableError('이어갈 AI 작업공간의 세션 파일이 lease와 일치하지 않습니다.')
      }
      const currentBranch = await this.git(workspace.root, ['branch', '--show-current'])
      if (currentBranch !== lease.branch) {
        throw new WorkspacePoolUnavailableError(`이어갈 AI 작업공간 브랜치가 ${lease.branch}가 아닙니다.`)
      }

      const updatedAt = new Date().toISOString()
      lease.conversationId = normalizedConversationId
      lease.status = 'leased'
      lease.updatedAt = updatedAt
      this.state.workspaces[lease.workspaceId] = {
        ...workspaceState,
        status: 'leased',
        updatedAt,
      }
      await atomicJson(sessionFile, {
        ...session,
        conversationId: normalizedConversationId,
        updatedAt,
      })
      await this.persist()
      return publicLease(lease)
    })
  }

  async bindConversation(leaseId, conversationId) {
    return this.runExclusive(async () => {
      const normalizedLeaseId = String(leaseId ?? '').trim()
      const normalizedConversationId = String(conversationId ?? '').trim()
      const lease = this.state?.leases?.[normalizedLeaseId]
      const canBind = conversationBindableLeaseStatuses.has(lease?.status)
      const canRebind = conversationRebindOnlyLeaseStatuses.has(lease?.status)
      if (!lease || (!canBind && !canRebind) || !normalizedConversationId) return null
      if (canRebind && lease.conversationId !== normalizedConversationId) return null
      if (lease.conversationId && lease.conversationId !== normalizedConversationId) {
        throw new WorkspacePoolUnavailableError('AI 작업공간 lease가 이미 다른 대화에 연결되어 있습니다.')
      }
      const conflictingLease = Object.values(this.state.leases).find((candidate) =>
        candidate?.leaseId !== normalizedLeaseId
        && candidate?.conversationId === normalizedConversationId
        && !['completed', 'cancelled', 'quarantined'].includes(candidate?.status))
      if (conflictingLease) {
        throw new WorkspacePoolUnavailableError(
          '같은 AI 대화가 이미 다른 활성 작업공간 lease에 연결되어 있습니다.',
          [{
            conversationId: normalizedConversationId,
            leaseId: conflictingLease.leaseId,
            workspaceId: conflictingLease.workspaceId,
          }],
          'CONVERSATION_ALREADY_LEASED',
        )
      }
      const workspace = this.registry?.workspaces.find((candidate) => candidate.id === lease.workspaceId)
      if (!workspace) return null
      const sessionFile = path.join(workspace.root, '.ai-session.json')
      const session = await readJson(sessionFile, null)
      if (!session || session.leaseId !== normalizedLeaseId) {
        throw new WorkspacePoolUnavailableError('AI 작업공간의 세션 파일이 lease와 일치하지 않습니다.')
      }
      if (lease.conversationId === normalizedConversationId && session.conversationId === normalizedConversationId) {
        return publicLease(lease)
      }
      const updatedAt = new Date().toISOString()
      lease.conversationId = normalizedConversationId
      lease.updatedAt = updatedAt
      await atomicJson(sessionFile, {
        ...session,
        conversationId: normalizedConversationId,
        updatedAt,
      })
      await this.persist()
      return publicLease(lease)
    })
  }

  async integrationTrackedChanges(integration = this.registry?.integration) {
    if (!integration) return { dirty: false, paths: [] }
    let status
    let paths
    try {
      status = await this.git(
        integration.root,
        ['status', '--porcelain=v1', '--untracked-files=no'],
        { timeoutMs: integrationGitProbeTimeoutMs },
      )
      paths = status
        ? (await this.git(
            integration.root,
            ['diff', '--name-only', 'HEAD'],
            { timeoutMs: integrationGitProbeTimeoutMs },
          )).split(/\r?\n/).map((item) => item.trim()).filter(Boolean).sort()
        : []
    } catch (error) {
      if (error?.code !== 'GIT_COMMAND_TIMEOUT') throw error
      throw new WorkspacePoolUnavailableError(
        '통합 작업공간의 Git 상태 확인이 지연되어 다음 폴링에서 다시 시도합니다.',
        [],
        integrationStatusRetryReasonCode,
      )
    }
    return { dirty: Boolean(status), paths }
  }

  async waitForIntegration(lease, workspace, {
    childStatus,
    childError,
    headCommit,
    blockingLeaseId = null,
    reasonCode = null,
    waitingReason = null,
    trackedChanges = [],
    keepIntegrationLock = false,
    recoveredFromQuarantine = false,
  } = {}) {
    const updatedAt = new Date().toISOString()
    const result = await this.writeResult(lease, {
      status: 'waiting-integration',
      childStatus: childStatus ?? null,
      childError: childError ?? null,
      headCommit: headCommit ?? lease.headCommit ?? lease.result?.headCommit ?? null,
      integratedCommit: null,
      integrationBaseCommit: lease.integrationBaseCommit ?? lease.result?.integrationBaseCommit ?? null,
      integrationBranch: lease.integrationBranch ?? lease.result?.integrationBranch ?? null,
      blockingLeaseId,
      reasonCode,
      waitingReason,
      trackedChanges,
      recoveredFromQuarantine,
      updatedAt,
    })
    lease.status = 'waiting-integration'
    lease.result = result
    if (!keepIntegrationLock && this.state.integrationLeaseId === lease.leaseId) {
      this.state.integrationLeaseId = null
    }
    this.state.workspaces[workspace.id] = {
      status: 'waiting-integration',
      ...(waitingReason ? { reason: waitingReason } : {}),
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      updatedAt,
    }
    await this.persist()
    return result
  }

  async recoverLegacyDirtyIntegration(leaseId) {
    return this.runExclusive(async () => {
      const lease = this.state?.leases?.[String(leaseId ?? '').trim()]
      const result = lease?.result
      const workspace = this.registry?.workers.find((candidate) => candidate.id === lease?.workspaceId)
      const workspaceState = this.state?.workspaces?.[lease?.workspaceId]
      const legacyDirtyFailure = result?.error === integrationWorktreeDirtyMessage
        || result?.reasonCode === integrationWorktreeDirtyReasonCode
      if (!lease || !workspace || lease.status !== 'quarantined'
        || result?.status !== 'quarantined' || !legacyDirtyFailure
        || result.childStatus !== 'completed'
        || result.integratedCommit || lease.integrationBranch || result.integrationBranch
        || (Array.isArray(result.unmergedFiles) && result.unmergedFiles.length > 0)
        || workspaceState?.status !== 'quarantined' || workspaceState?.leaseId !== lease.leaseId) return null

      const headCommit = String(result.headCommit ?? lease.headCommit ?? '').trim()
      const checkpoints = Array.isArray(lease.checkpoints) ? lease.checkpoints : []
      const commits = Array.isArray(lease.commits) ? lease.commits : []
      if (!headCommit || headCommit === lease.baseCommit
        || !checkpoints.some((checkpoint) => checkpoint?.commit === headCommit)
        || !commits.includes(headCommit)) return null

      const session = await readJson(path.join(workspace.root, '.ai-session.json'), null)
      if (!session
        || session.workspaceId !== lease.workspaceId
        || session.jobId !== lease.jobId
        || session.leaseId !== lease.leaseId
        || session.conversationId !== lease.conversationId
        || session.branch !== lease.branch
        || session.baseCommit !== lease.baseCommit) return null

      const [dirty, currentBranch, currentHead] = await Promise.all([
        this.git(workspace.root, ['status', '--porcelain', '--untracked-files=all']),
        this.git(workspace.root, ['branch', '--show-current']),
        this.git(workspace.root, ['rev-parse', 'HEAD']),
      ])
      if (dirty || currentBranch !== lease.branch || currentHead !== headCommit) return null
      try {
        await this.git(workspace.root, ['merge-base', '--is-ancestor', lease.baseCommit, headCommit])
      } catch {
        return null
      }

      const integrationChanges = await this.integrationTrackedChanges()
      return this.waitForIntegration(lease, workspace, {
        childStatus: result.childStatus,
        childError: result.childError,
        headCommit,
        reasonCode: integrationWorktreeDirtyReasonCode,
        waitingReason: integrationWorktreeDirtyMessage,
        trackedChanges: integrationChanges.paths,
        recoveredFromQuarantine: true,
      })
    })
  }

  async recoverCheckpointedFinalizationFailure(leaseId) {
    return this.runExclusive(async () => {
      const lease = this.state?.leases?.[String(leaseId ?? '').trim()]
      const result = lease?.result
      const workspace = this.registry?.workers.find((candidate) => candidate.id === lease?.workspaceId)
      const workspaceState = this.state?.workspaces?.[lease?.workspaceId]
      if (!lease || !workspace || lease.status !== 'quarantined'
        || result?.status !== 'quarantined' || result.childStatus !== 'completed'
        || result.integratedCommit || lease.integrationBranch || result.integrationBranch
        || (Array.isArray(result.unmergedFiles) && result.unmergedFiles.length > 0)
        || workspaceState?.status !== 'quarantined' || workspaceState?.leaseId !== lease.leaseId) return null

      const checkpoints = Array.isArray(lease.checkpoints) ? lease.checkpoints : []
      const checkpointCommits = new Set(
        checkpoints.map((checkpoint) => String(checkpoint?.commit ?? '').trim()).filter(Boolean),
      )
      const latestCheckpointCommit = String(checkpoints.at(-1)?.commit ?? '').trim()
      if (!latestCheckpointCommit || latestCheckpointCommit === lease.baseCommit) return null

      const session = await readJson(path.join(workspace.root, '.ai-session.json'), null)
      if (!session
        || session.workspaceId !== lease.workspaceId
        || session.jobId !== lease.jobId
        || session.leaseId !== lease.leaseId
        || session.conversationId !== lease.conversationId
        || session.branch !== lease.branch
        || session.baseCommit !== lease.baseCommit) return null

      const [dirty, currentBranch, currentHead] = await Promise.all([
        this.git(workspace.root, ['status', '--porcelain', '--untracked-files=all']),
        this.git(workspace.root, ['branch', '--show-current']),
        this.git(workspace.root, ['rev-parse', 'HEAD']),
      ])
      if (dirty || currentBranch !== lease.branch || currentHead !== latestCheckpointCommit) return null
      try {
        await this.git(workspace.root, ['merge-base', '--is-ancestor', lease.baseCommit, currentHead])
      } catch {
        return null
      }

      const commits = (await this.git(workspace.root, [
        'rev-list', '--reverse', `${lease.baseCommit}..${currentHead}`,
      ])).split(/\r?\n/).map((commit) => commit.trim()).filter(Boolean)
      if (commits.length === 0 || commits.some((commit) => !checkpointCommits.has(commit))) return null

      const integrationChanges = await this.integrationTrackedChanges()
      lease.headCommit = currentHead
      lease.commits = commits
      return this.waitForIntegration(lease, workspace, {
        childStatus: result.childStatus,
        childError: result.childError ?? null,
        headCommit: currentHead,
        reasonCode: integrationChanges.dirty ? integrationWorktreeDirtyReasonCode : null,
        waitingReason: integrationChanges.dirty ? integrationWorktreeDirtyMessage : null,
        trackedChanges: integrationChanges.paths,
        recoveredFromQuarantine: true,
      })
    })
  }

  async finalize(leaseId, { childStatus, childError } = {}) {
    return this.runExclusive(async () => {
      const lease = this.state?.leases?.[leaseId]
      if (!lease) return null
      if (['completed', 'quarantined'].includes(lease.status)) return lease.result ?? null
      if (lease.status === 'awaiting-conflict-resolution') return lease.result ?? null
      if (lease.status === 'waiting-integration'
        && this.state.integrationLeaseId
        && this.state.integrationLeaseId !== leaseId) {
        return lease.result ?? null
      }
      const workspace = this.registry.workspaces.find((candidate) => candidate.id === lease.workspaceId)
      const integration = this.registry.integration
      if (!workspace || !integration) throw new WorkspacePoolIntegrationError('작업공간 registry 항목을 찾지 못했습니다.')
      if (lease.status === 'waiting-integration'
        && lease.result?.reasonCode === integrationWorktreeDirtyReasonCode) {
        const integrationChanges = await this.integrationTrackedChanges(integration)
        if (integrationChanges.dirty) {
          if (JSON.stringify(integrationChanges.paths) === JSON.stringify(lease.result.trackedChanges ?? [])) {
            return lease.result
          }
          return this.waitForIntegration(lease, workspace, {
            childStatus,
            childError,
            headCommit: lease.result.headCommit,
            reasonCode: integrationWorktreeDirtyReasonCode,
            waitingReason: integrationWorktreeDirtyMessage,
            trackedChanges: integrationChanges.paths,
            keepIntegrationLock: this.state.integrationLeaseId === leaseId,
            recoveredFromQuarantine: lease.result.recoveredFromQuarantine === true,
          })
        }
      }
      const completed = childStatus === 'completed'
      this.state.workspaces[workspace.id] = {
        status: 'finalizing',
        jobId: lease.jobId,
        leaseId,
        updatedAt: new Date().toISOString(),
      }
      lease.status = 'finalizing'
      await this.persist()

      let headCommit = null
      let integratedCommit = null
      try {
        const currentBranch = await this.git(workspace.root, ['branch', '--show-current'])
        if (!lease.integrationBranch && currentBranch !== lease.branch) {
          throw new Error(`예상 브랜치 ${lease.branch}가 아닌 ${currentBranch}입니다.`)
        }
        const dirty = await this.git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
        const currentHead = await this.git(workspace.root, ['rev-parse', 'HEAD'])
        const hasCheckpoint = currentHead !== lease.baseCommit
          || (Array.isArray(lease.checkpoints) && lease.checkpoints.length > 0)
        if (!completed && !dirty && !lease.integrationBranch && !hasCheckpoint
          && !retryableExternalLimitCategory(childError)) {
          return await this.releaseCleanFailure(lease, workspace, {
            childStatus: childStatus ?? null,
            childError: childError ?? null,
            headCommit: currentHead,
          })
        }
        if (completed && !lease.integrationBranch && !hasCheckpoint) {
          return await this.requireCheckpoint(lease, workspace)
        }
        if (dirty && !lease.integrationBranch) {
          if (completed) {
            const drift = await this.archiveAndRestoreDrift(workspace, {
              reason: '명시적 체크포인트 이후 발생한 검증·Play·재임포트 변경',
              phase: 'post-checkpoint-verification',
              jobId: lease.jobId,
              leaseId: lease.leaseId,
            })
            lease.lastDriftArchive = drift?.archiveRoot ?? lease.lastDriftArchive ?? null
          }
        }
        headCommit = lease.headCommit ?? await this.git(workspace.root, ['rev-parse', 'HEAD'])
        if (headCommit !== lease.baseCommit) {
          await this.git(workspace.root, ['merge-base', '--is-ancestor', lease.baseCommit, headCommit])
        }
        const commits = lease.commits ?? (headCommit === lease.baseCommit
          ? []
          : (await this.git(workspace.root, ['rev-list', '--reverse', `${lease.baseCommit}..${headCommit}`]))
            .split(/\r?\n/).map((commit) => commit.trim()).filter(Boolean))
        lease.headCommit = headCommit
        lease.commits = commits

        if (!completed) {
          throw new WorkspacePoolIntegrationError('하위 AI 작업이 완료되지 않아 변경을 통합하지 않았습니다.', {
            childStatus,
            childError: childError ?? null,
            headCommit,
          })
        }
        if (commits.length === 0) {
          return await this.completeLease(lease, workspace, {
            status: 'completed',
            childStatus,
            childError: childError ?? null,
            headCommit,
            integratedCommit: null,
            completedAt: new Date().toISOString(),
          })
        }

        if (lease.integrationBranch
          && currentBranch === lease.integrationBranch
          && this.state.integrationLeaseId === leaseId) {
          const unmerged = await this.git(workspace.root, ['diff', '--name-only', '--diff-filter=U'])
          if (unmerged) return await this.awaitConflictResolution(lease, workspace, unmerged)
          if (await this.gitPathExists(workspace.root, 'CHERRY_PICK_HEAD')) {
            return await this.awaitConflictResolution(lease, workspace, '(cherry-pick --continue 필요)')
          }
          if (dirty) throw new Error('중단된 통합 브랜치에 소유자를 확정할 수 없는 변경이 있습니다.')
          integratedCommit = await this.applyIntegration(lease, workspace, integration)
          return await this.completeLease(lease, workspace, {
            status: 'completed',
            childStatus,
            childError: childError ?? null,
            headCommit,
            integratedCommit,
            integrationBaseCommit: lease.integrationBaseCommit,
            recoveredIntegration: true,
            completedAt: new Date().toISOString(),
          })
        }

        if (this.state.integrationLeaseId && this.state.integrationLeaseId !== leaseId) {
          return await this.waitForIntegration(lease, workspace, {
            childStatus,
            childError: childError ?? null,
            headCommit,
            blockingLeaseId: this.state.integrationLeaseId,
          })
        }

        const integrationChanges = await this.integrationTrackedChanges(integration)
        if (integrationChanges.dirty) {
          return await this.waitForIntegration(lease, workspace, {
            childStatus,
            childError: childError ?? null,
            headCommit,
            reasonCode: integrationWorktreeDirtyReasonCode,
            waitingReason: integrationWorktreeDirtyMessage,
            trackedChanges: integrationChanges.paths,
            recoveredFromQuarantine: lease.result?.recoveredFromQuarantine === true,
          })
        }
        this.state.integrationLeaseId = leaseId
        const integrationBranchName = await this.git(integration.root, ['branch', '--show-current'])
        if (integrationBranchName !== lease.baseBranch) {
          throw new Error(`통합 작업공간 브랜치가 ${lease.baseBranch}가 아닙니다.`)
        }
        const integrationBaseCommit = await this.git(integration.root, ['rev-parse', 'HEAD'])
        const integrationBranch = lease.integrationBranch ?? `mnp/integrate/${lease.jobId}`
        lease.integrationBranch = integrationBranch
        lease.integrationBaseCommit = integrationBaseCommit
        lease.integrationAttempt = Number(lease.integrationAttempt ?? 0) + 1
        lease.status = 'integrating'
        this.state.workspaces[workspace.id] = {
          status: 'integrating',
          jobId: lease.jobId,
          leaseId,
          updatedAt: new Date().toISOString(),
        }
        await this.persist()

        await this.git(workspace.root, ['fetch', '--no-tags', integration.root, `refs/heads/${lease.baseBranch}`])
        await this.git(workspace.root, ['switch', '-C', integrationBranch, integrationBaseCommit])
        try {
          await this.git(workspace.root, ['cherry-pick', ...commits])
        } catch (error) {
          const unmerged = await this.git(workspace.root, ['diff', '--name-only', '--diff-filter=U'])
          if (unmerged) return await this.awaitConflictResolution(lease, workspace, unmerged)
          throw error
        }
        integratedCommit = await this.applyIntegration(lease, workspace, integration)
        return await this.completeLease(lease, workspace, {
          status: 'completed',
          childStatus,
          childError: childError ?? null,
          headCommit,
          integratedCommit,
          integrationBaseCommit,
          completedAt: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof WorkspacePoolUnavailableError
          && error.reasonCode === integrationStatusRetryReasonCode) {
          return await this.waitForIntegration(lease, workspace, {
            childStatus: childStatus ?? null,
            childError: childError ?? null,
            headCommit,
            reasonCode: error.reasonCode,
            waitingReason: error.message,
            trackedChanges: [],
            keepIntegrationLock: Boolean(lease.integrationBranch),
            recoveredFromQuarantine: lease.result?.recoveredFromQuarantine === true,
          })
        }
        if (error instanceof IntegrationWorkspaceBusyError) {
          return await this.waitForIntegration(lease, workspace, {
            childStatus: childStatus ?? null,
            childError: childError ?? null,
            headCommit,
            reasonCode: error.reasonCode,
            waitingReason: error.message,
            trackedChanges: error.trackedChanges,
            keepIntegrationLock: Boolean(lease.integrationBranch),
            recoveredFromQuarantine: lease.result?.recoveredFromQuarantine === true,
          })
        }
        throw await this.quarantineIntegrationFailure(lease, workspace, error, {
          childStatus: childStatus ?? null,
          childError: childError ?? null,
          headCommit,
          integratedCommit,
        })
      }
    })
  }

  async requireCheckpoint(lease, workspace) {
    lease.checkpointRound = Number(lease.checkpointRound ?? 0) + 1
    if (lease.checkpointRound > 3) {
      throw new Error('명시적 체크포인트 요청 재시도 한도(3회)를 초과했습니다.')
    }
    const [tracked, staged, untracked] = await Promise.all([
      this.git(workspace.root, ['diff', '--name-only', '-z']),
      this.git(workspace.root, ['diff', '--cached', '--name-only', '-z']),
      this.git(workspace.root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    const changedFiles = [...new Set([
      ...nullSeparated(tracked),
      ...nullSeparated(staged),
      ...nullSeparated(untracked),
    ])].sort()
    const updatedAt = new Date().toISOString()
    const result = await this.writeResult(lease, {
      status: 'checkpoint-required',
      checkpointRound: lease.checkpointRound,
      changedFiles,
      error: '의도된 구현 변경을 검증 부산물과 구분할 명시적 체크포인트가 필요합니다.',
      updatedAt,
    })
    lease.status = 'checkpoint-required'
    lease.result = result
    this.state.workspaces[workspace.id] = {
      status: 'checkpoint-required',
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      updatedAt,
    }
    await this.persist()
    return result
  }

  async completeConflictResolution(leaseId, { childStatus, childError } = {}) {
    return this.runExclusive(async () => {
      const lease = this.state?.leases?.[leaseId]
      if (!lease) return null
      if (['completed', 'quarantined'].includes(lease.status)) return lease.result ?? null
      const workspace = this.registry.workspaces.find((candidate) => candidate.id === lease.workspaceId)
      const integration = this.registry.integration
      if (!workspace || !integration) throw new WorkspacePoolIntegrationError('작업공간 registry 항목을 찾지 못했습니다.')
      try {
        if (this.state.integrationLeaseId !== leaseId) throw new Error('통합 잠금 소유권이 현재 lease와 일치하지 않습니다.')
        if (childStatus !== 'completed') {
          throw new WorkspacePoolIntegrationError('충돌 해결 AI 작업이 완료되지 않았습니다.', {
            childStatus,
            childError: childError ?? null,
          })
        }
        const currentBranch = await this.git(workspace.root, ['branch', '--show-current'])
        if (currentBranch !== lease.integrationBranch) {
          throw new Error(`통합 브랜치 ${lease.integrationBranch}가 아닌 ${currentBranch}입니다.`)
        }
        let unmerged = await this.git(workspace.root, ['diff', '--name-only', '--diff-filter=U'])
        if (unmerged) return await this.awaitConflictResolution(lease, workspace, unmerged)

        const cherryPickHead = await this.gitPathExists(workspace.root, 'CHERRY_PICK_HEAD')
        if (cherryPickHead) {
          await this.git(workspace.root, ['add', '-A'])
          try {
            await this.git(workspace.root, ['-c', 'core.editor=true', 'cherry-pick', '--continue'])
          } catch (error) {
            unmerged = await this.git(workspace.root, ['diff', '--name-only', '--diff-filter=U'])
            if (unmerged) return await this.awaitConflictResolution(lease, workspace, unmerged)
            throw error
          }
        }

        const remainingChanges = await this.git(workspace.root, ['status', '--porcelain', '--untracked-files=all'])
        if (remainingChanges) {
          const message = integrationConflictCheckpointMessage(lease)
          await this.git(workspace.root, ['add', '-A'])
          await this.git(workspace.root, ['commit', '-m', message.title, '-m', message.body])
        }
        const integratedCommit = await this.applyIntegration(lease, workspace, integration)
        return await this.completeLease(lease, workspace, {
          status: 'completed',
          childStatus,
          childError: childError ?? null,
          headCommit: lease.headCommit,
          integratedCommit,
          integrationBaseCommit: lease.integrationBaseCommit,
          conflictResolvedByAi: true,
          completedAt: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof IntegrationWorkspaceBusyError) {
          return await this.waitForIntegration(lease, workspace, {
            childStatus: childStatus ?? null,
            childError: childError ?? null,
            headCommit: lease.headCommit ?? null,
            reasonCode: error.reasonCode,
            waitingReason: error.message,
            trackedChanges: error.trackedChanges,
            keepIntegrationLock: true,
            recoveredFromQuarantine: lease.result?.recoveredFromQuarantine === true,
          })
        }
        throw await this.quarantineIntegrationFailure(lease, workspace, error, {
          childStatus: childStatus ?? null,
          childError: childError ?? null,
          headCommit: lease.headCommit ?? null,
        })
      }
    })
  }

  async gitPathExists(root, name) {
    const gitPath = await this.git(root, ['rev-parse', '--git-path', name])
    return exists(path.resolve(root, gitPath))
  }

  async awaitConflictResolution(lease, workspace, unmerged) {
    lease.conflictRound = Number(lease.conflictRound ?? 0) + 1
    if (lease.conflictRound > 3) throw new Error('AI 충돌 해결 재시도 한도(3회)를 초과했습니다.')
    const updatedAt = new Date().toISOString()
    await atomicJson(path.join(workspace.root, '.ai-session.json'), {
      schemaVersion: 1,
      workspaceId: lease.workspaceId,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      projectRoot: lease.projectRoot,
      branch: lease.integrationBranch,
      baseCommit: lease.integrationBaseCommit,
      phase: 'integration-conflict',
      knowledgeMode: 'read-only',
      startedAt: lease.startedAt,
      updatedAt,
    })
    const result = await this.writeResult(lease, {
      status: 'awaiting-conflict-resolution',
      childStatus: 'completed',
      headCommit: lease.headCommit,
      integrationBaseCommit: lease.integrationBaseCommit,
      integrationBranch: lease.integrationBranch,
      conflictRound: lease.conflictRound,
      unmergedFiles: unmerged.split(/\r?\n/).map((file) => file.trim()).filter(Boolean),
      updatedAt,
    })
    lease.status = 'awaiting-conflict-resolution'
    lease.result = result
    this.state.workspaces[workspace.id] = {
      status: 'resolving-integration-conflict',
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      updatedAt,
    }
    await this.persist()
    return result
  }

  async applyIntegration(lease, workspace, integration) {
    const remainingChanges = await this.git(workspace.root, ['status', '--porcelain', '--untracked-files=all'])
    if (remainingChanges) throw new Error('통합 브랜치에 커밋되지 않은 변경이 남아 있습니다.')
    const integrationHead = await this.git(workspace.root, ['rev-parse', 'HEAD'])
    const integrationChanges = await this.integrationTrackedChanges(integration)
    if (integrationChanges.dirty) throw new IntegrationWorkspaceBusyError(integrationChanges.paths)
    const integrationBranchName = await this.git(integration.root, ['branch', '--show-current'])
    if (integrationBranchName !== lease.baseBranch) {
      throw new Error(`통합 작업공간 브랜치가 ${lease.baseBranch}가 아닙니다.`)
    }
    const currentIntegrationHead = await this.git(integration.root, ['rev-parse', 'HEAD'])
    if (currentIntegrationHead === integrationHead) return integrationHead
    if (currentIntegrationHead !== lease.integrationBaseCommit) {
      throw new Error('충돌 해결 중 통합 작업공간의 HEAD가 변경되었습니다.')
    }
    await this.git(integration.root, ['fetch', '--no-tags', workspace.root, `refs/heads/${lease.integrationBranch}`])
    const verifiedIntegrationHead = await this.git(integration.root, ['rev-parse', 'HEAD'])
    if (verifiedIntegrationHead === integrationHead) return integrationHead
    if (verifiedIntegrationHead !== lease.integrationBaseCommit) {
      throw new Error('통합 직전에 통합 작업공간의 HEAD가 변경되었습니다.')
    }
    await this.git(integration.root, ['merge', '--ff-only', integrationHead])
    return this.git(integration.root, ['rev-parse', 'HEAD'])
  }

  async completeLease(lease, workspace, resultFields) {
    const integration = this.registry.integration
    const idleCommit = resultFields.integratedCommit
      ?? await this.git(integration.root, ['rev-parse', 'HEAD'])
    const idleBranch = await this.switchWorkspaceToIdleCommit(workspace, lease.baseBranch, idleCommit)
    await rm(path.join(workspace.root, '.ai-session.json'), { force: true })
    let drift = null
    const postSwitchDirty = await this.git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (postSwitchDirty) {
      drift = await this.archiveAndRestoreDrift(workspace, {
        reason: '완료된 worker를 최신 main 기준으로 회수한 후 발생한 Unity 자동 변경',
        phase: 'idle-release',
        jobId: lease.jobId,
        leaseId: lease.leaseId,
        idleCommit,
      })
    }
    const lastDriftArchive = drift?.archiveRoot ?? lease.lastDriftArchive ?? null
    const result = await this.writeResult(lease, {
      ...resultFields,
      driftArchive: lastDriftArchive,
    })
    lease.status = 'completed'
    lease.result = result
    if (this.state.integrationLeaseId === lease.leaseId) this.state.integrationLeaseId = null
    this.state.workspaces[workspace.id] = {
      status: 'idle',
      idleCommit,
      idleBranch,
      lastJobId: lease.jobId,
      lastLeaseId: lease.leaseId,
      lastDriftArchive,
      updatedAt: result.completedAt,
    }
    await this.persist()
    return result
  }

  async releaseCleanFailure(lease, workspace, resultFields) {
    const integration = this.registry.integration
    const [idleCommit, idleBaseBranch] = await Promise.all([
      this.git(integration.root, ['rev-parse', 'HEAD']),
      this.git(integration.root, ['branch', '--show-current']),
    ])
    const idleBranch = await this.switchWorkspaceToIdleCommit(workspace, idleBaseBranch, idleCommit)
    await rm(path.join(workspace.root, '.ai-session.json'), { force: true })
    const completedAt = new Date().toISOString()
    const result = await this.writeResult(lease, {
      status: 'failed-clean',
      ...resultFields,
      completedAt,
    })
    lease.status = 'cancelled'
    lease.result = result
    this.state.workspaces[workspace.id] = {
      status: 'idle',
      idleCommit,
      idleBranch,
      lastJobId: lease.jobId,
      lastLeaseId: lease.leaseId,
      updatedAt: completedAt,
    }
    await this.persist()
    return result
  }

  async quarantineIntegrationFailure(lease, workspace, error, resultFields = {}) {
    const reason = error?.message ?? String(error)
    const completedAt = new Date().toISOString()
    const result = await this.writeResult(lease, {
      status: 'quarantined',
      headCommit: lease.headCommit ?? lease.result?.headCommit ?? null,
      integrationBaseCommit: lease.integrationBaseCommit ?? lease.result?.integrationBaseCommit ?? null,
      integrationBranch: lease.integrationBranch ?? lease.result?.integrationBranch ?? null,
      conflictRound: lease.conflictRound ?? lease.result?.conflictRound ?? null,
      unmergedFiles: lease.result?.unmergedFiles ?? [],
      ...resultFields,
      error: reason,
      completedAt,
    })
    lease.status = 'quarantined'
    lease.result = result
    if (this.state.integrationLeaseId === lease.leaseId) this.state.integrationLeaseId = null
    this.state.workspaces[workspace.id] = {
      status: 'quarantined',
      reason,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      updatedAt: completedAt,
    }
    await this.persist()
    return new WorkspacePoolIntegrationError(reason, result)
  }

  async cancel(leaseId, reason = '작업 시작 전에 위임이 취소되었습니다.') {
    return this.runExclusive(async () => {
      const lease = this.state?.leases?.[leaseId]
      if (!lease || ['completed', 'cancelled', 'quarantined'].includes(lease.status)) return lease?.result ?? null
      const workspace = this.registry.workspaces.find((candidate) => candidate.id === lease.workspaceId)
      if (!workspace) return null
      try {
        const dirty = await this.git(workspace.root, ['status', '--porcelain', '--untracked-files=all'])
        if (dirty) throw new Error('취소된 작업공간에 변경이 남아 있어 자동 회수하지 않았습니다.')
        const [idleCommit, idleBaseBranch] = await Promise.all([
          this.git(this.registry.integration.root, ['rev-parse', 'HEAD']),
          this.git(this.registry.integration.root, ['branch', '--show-current']),
        ])
        const idleBranch = await this.switchWorkspaceToIdleCommit(workspace, idleBaseBranch, idleCommit)
        await rm(path.join(workspace.root, '.ai-session.json'), { force: true })
        const result = await this.writeResult(lease, {
          status: 'cancelled',
          error: reason,
          completedAt: new Date().toISOString(),
        })
        lease.status = 'cancelled'
        lease.result = result
        this.state.workspaces[workspace.id] = {
          status: 'idle',
          idleCommit,
          idleBranch,
          lastJobId: lease.jobId,
          lastLeaseId: leaseId,
          updatedAt: result.completedAt,
        }
        await this.persist()
        return result
      } catch (error) {
        const quarantineReason = error?.message ?? String(error)
        const result = await this.writeResult(lease, {
          status: 'quarantined',
          error: quarantineReason,
          completedAt: new Date().toISOString(),
        })
        lease.status = 'quarantined'
        lease.result = result
        this.state.workspaces[workspace.id] = {
          status: 'quarantined',
          reason: quarantineReason,
          jobId: lease.jobId,
          leaseId,
          updatedAt: result.completedAt,
        }
        await this.persist()
        return result
      }
    })
  }

  async quarantine(leaseId, reason) {
    return this.runExclusive(async () => {
      const lease = this.state?.leases?.[leaseId]
      if (!lease) return null
      if (lease.status === 'quarantined') return lease.result ?? null
      if (!lease.conversationId) lease.executionUnconfirmed = true
      const completedAt = new Date().toISOString()
      const result = await this.writeResult(lease, {
        status: 'quarantined',
        headCommit: lease.headCommit ?? lease.result?.headCommit ?? null,
        integrationBaseCommit: lease.integrationBaseCommit ?? lease.result?.integrationBaseCommit ?? null,
        integrationBranch: lease.integrationBranch ?? lease.result?.integrationBranch ?? null,
        conflictRound: lease.conflictRound ?? lease.result?.conflictRound ?? null,
        unmergedFiles: lease.result?.unmergedFiles ?? [],
        error: String(reason ?? '작업 상태를 확정할 수 없습니다.'),
        completedAt,
      })
      lease.status = 'quarantined'
      lease.result = result
      if (this.state.integrationLeaseId === leaseId) this.state.integrationLeaseId = null
      this.state.workspaces[lease.workspaceId] = {
        status: 'quarantined',
        reason: result.error,
        jobId: lease.jobId,
        leaseId,
        updatedAt: completedAt,
      }
      await this.persist()
      return result
    })
  }

  async writeResult(lease, result) {
    const stored = {
      schemaVersion: 1,
      poolId: lease.poolId,
      workspaceId: lease.workspaceId,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      mapId: lease.mapId,
      cardId: lease.cardId,
      conversationId: lease.conversationId,
      branch: lease.branch,
      baseBranch: lease.baseBranch,
      baseCommit: lease.baseCommit,
      ...result,
    }
    await atomicJson(path.join(this.registry.sharedRoot, 'job-results', `${lease.jobId}.json`), stored)
    return stored
  }

  async persist() {
    if (!this.state) return
    this.state.updatedAt = new Date().toISOString()
    await atomicJson(this.stateFile, this.state)
  }
}
