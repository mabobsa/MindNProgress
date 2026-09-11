import { createHash } from 'node:crypto'

export const AI_DELEGATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/
export const AI_DELEGATION_WAIT_POLL_DELAYS_MS = Object.freeze([3_000, 5_000, 10_000, 30_000])

export const ACTIVE_AI_DELEGATION_STATES = new Set([
  'waiting-usage-limit',
  'waiting-rate-limit',
  'waiting-document-work',
  'waiting-workspace',
  'waiting-integration-clean',
  'starting',
  'waiting-resource',
  'running',
  'resuming',
  'waiting-child-resume',
  'recovery-required',
  'waiting-integration',
  'integration-starting',
  'integration-waiting-resource',
  'integration-running',
  'integration-waiting-resume',
  'integration-recovery-required',
  'waiting-parent',
  'waking-parent',
])

const CHILD_WORKSPACE_RECONCILIATION_STATES = new Set([
  'starting',
  'waiting-resource',
  'running',
  'waiting-child-resume',
])

const EXPLICIT_COMPLETION_CANDIDATE_STATES = new Set([
  'starting',
  'waiting-resource',
  'running',
  'waiting-child-resume',
])

export function aiDelegationWaitPollDue(entry, delegation, now = Date.now()) {
  if (!entry || entry.state !== delegation?.state) return true
  return Number(entry.nextAt ?? 0) <= now
}

export function nextAiDelegationWaitPoll(entry, delegation, now = Date.now()) {
  const state = String(delegation?.state ?? '')
  const attempt = entry?.state === state ? Math.max(0, Number(entry.attempt) || 0) : 0
  const delayMs = AI_DELEGATION_WAIT_POLL_DELAYS_MS[
    Math.min(attempt, AI_DELEGATION_WAIT_POLL_DELAYS_MS.length - 1)
  ]
  return {
    state,
    attempt: attempt + 1,
    delayMs,
    nextAt: now + delayMs,
  }
}

export function shouldReconcileAiDelegationChildWorkspace(delegation) {
  return CHILD_WORKSPACE_RECONCILIATION_STATES.has(delegation?.state)
}

function normalizedSelectionOption(value, fallbackId = '') {
  if (value && typeof value === 'object') {
    const id = String(value.id ?? '').trim()
    return id ? { id, label: String(value.label ?? id).trim() || id } : null
  }
  const id = String(fallbackId || value || '').trim()
  return id ? { id, label: id } : null
}

function normalizedSelectionList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value?.id ?? value ?? '').trim()).filter(Boolean))].slice(0, 128)
}

function partialAiDelegationSelectionFromSource(source) {
  if (!source || typeof source !== 'object') return null
  const agent = normalizedSelectionOption(source.agent, source.agentId)
  const model = normalizedSelectionOption(source.model, source.modelId)
  return {
    agent,
    model,
    providerId: String(source.providerId ?? '').trim() || null,
    mode: normalizedSelectionOption(source.mode, source.modeId),
    thoughtLevel: normalizedSelectionOption(source.thoughtLevel, source.thoughtLevelId),
    enabledSkillIds: normalizedSelectionList(source.enabledSkillIds ?? source.skills),
    disabledBuiltinSkillIds: normalizedSelectionList(source.disabledBuiltinSkillIds),
    mcpIds: normalizedSelectionList(source.mcpIds ?? source.mcpServers),
    workspace: String(source.workspace ?? '').trim().slice(0, 4_096) || null,
  }
}

export function aiDelegationSelectionFromSource(source) {
  const selection = partialAiDelegationSelectionFromSource(source)
  return selection?.agent && selection?.model ? selection : null
}

function sourceDefinesAny(source, keys) {
  return source && typeof source === 'object' && keys.some((key) => Object.hasOwn(source, key))
}

export function mergeAiDelegationSelections(...sources) {
  const entries = sources
    .map((source) => ({ source, selection: partialAiDelegationSelectionFromSource(source) }))
    .filter((entry) => entry.selection)
  if (entries.length === 0) return null

  const agent = entries.find((entry) => entry.selection.agent)?.selection.agent ?? null
  const compatibleEntries = agent
    ? [
        ...entries.filter((entry) => !entry.selection.agent || entry.selection.agent.id === agent.id),
        ...entries.filter((entry) => entry.selection.agent && entry.selection.agent.id !== agent.id),
      ]
    : entries
  const firstValue = (key, candidates = compatibleEntries) =>
    candidates.find((entry) => entry.selection[key])?.selection[key] ?? null
  const firstList = (keys, key) => compatibleEntries
    .find((entry) => sourceDefinesAny(entry.source, keys))?.selection[key]
    ?? compatibleEntries[0].selection[key]
  const merged = {
    agent,
    model: firstValue('model'),
    providerId: firstValue('providerId'),
    mode: firstValue('mode'),
    thoughtLevel: firstValue('thoughtLevel'),
    enabledSkillIds: firstList(['enabledSkillIds', 'skills'], 'enabledSkillIds'),
    disabledBuiltinSkillIds: firstList(['disabledBuiltinSkillIds'], 'disabledBuiltinSkillIds'),
    mcpIds: firstList(['mcpIds', 'mcpServers'], 'mcpIds'),
    workspace: firstValue('workspace', entries),
  }
  return merged.agent && merged.model ? merged : null
}

export function isValidAiDelegationId(value) {
  return AI_DELEGATION_ID_PATTERN.test(String(value ?? ''))
}

function normalizedRequestList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))].sort()
}

export function createAiDelegationRequestSignature({
  mapId,
  parentMapId,
  targetRevision,
  parentCardId,
  targetCardId,
  strategy,
  conversationId,
  machineId,
  instruction,
  decisionReason,
  sourceRevision,
  newConversation,
}) {
  const normalizedMachineId = String(machineId ?? '').trim()
  const requested = newConversation && typeof newConversation === 'object'
    ? {
        agentId: String(newConversation.agentId ?? '').trim() || null,
        modelId: String(newConversation.modelId ?? '').trim() || null,
        providerId: String(newConversation.providerId ?? '').trim() || null,
        modeId: String(newConversation.modeId ?? '').trim() || null,
        thoughtLevelId: String(newConversation.thoughtLevelId ?? '').trim() || null,
        enabledSkillIds: normalizedRequestList(newConversation.enabledSkillIds),
        disabledBuiltinSkillIds: normalizedRequestList(newConversation.disabledBuiltinSkillIds),
        mcpIds: normalizedRequestList(newConversation.mcpIds),
        workspace: String(newConversation.workspace ?? '').trim() || null,
      }
    : null
  return createHash('sha256').update(JSON.stringify({
    mapId,
    ...(parentMapId ? { parentMapId, targetRevision } : {}),
    parentCardId,
    targetCardId,
    strategy,
    conversationId,
    ...(normalizedMachineId ? { machineId: normalizedMachineId } : {}),
    instruction,
    decisionReason,
    sourceRevision,
    newConversation: strategy === 'new' ? requested : null,
  })).digest('hex')
}

function normalizedWorkspaceRoot(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

export function aiDelegationWorkspaceLeaseMatches(expected, actual) {
  if (!expected && !actual) return true
  if (!expected || !actual) return false
  return String(expected.workspaceId ?? '') === String(actual.workspaceId ?? '')
    && String(expected.jobId ?? '') === String(actual.jobId ?? '')
    && String(expected.leaseId ?? '') === String(actual.leaseId ?? '')
    && normalizedWorkspaceRoot(expected.projectRoot) === normalizedWorkspaceRoot(actual.projectRoot)
}

export function failedAiIntegrationRecoveryRuntime(dispatch, recoveredAt = new Date().toISOString()) {
  if (String(dispatch?.state ?? '').trim() !== 'failed') return null
  return {
    state: 'integration-recovery-required',
    integrationStatus: 'failed',
    integrationTurnId: String(dispatch?.turnId ?? '').trim() || null,
    integrationError: String(dispatch?.errorMessage ?? '').trim()
      || '필수 체크포인트 또는 통합 작업이 실패해 명시적인 재개가 필요합니다.',
    recoveryRequiredAt: recoveredAt,
    integrationResource: null,
  }
}

export function aiDelegationSucceeded(delegation) {
  if (delegation?.state === 'waiting-document-work') return false
  if (delegation?.childStatus !== 'completed' || delegation?.workspaceError) return false
  if (delegation?.integrationOperationId && delegation?.integrationStatus !== 'completed') return false
  if (delegation?.workspaceLease?.leaseId && delegation?.workspaceResult?.status !== 'completed') return false
  return true
}

export function retryableExternalLimitCategory(error) {
  const message = String(error ?? '').trim()
  if (!message) return null
  if (/usage limit|usage cap|credit limit|insufficient credits?|사용량.{0,12}(제한|한도|초과)|크레딧.{0,12}(부족|소진)/iu.test(message)) {
    return 'usage-limit'
  }
  if (/rate.?limit|too many requests|요청.{0,12}(제한|한도|초과)/iu.test(message)) return 'rate-limit'
  return null
}

export function aiDelegationRecoveryAvailability(delegation) {
  if (delegation?.pendingRecovery) return { failurePhase: 'dispatch', failureCategory: 'unknown', recoveryAvailable: false, recommendedAction: 'refresh-status', recoveryTool: 'mindnprogress_refresh_ai_delegation' }
  if (!['parent-wake-failed', 'failed', 'waiting-usage-limit', 'waiting-rate-limit', 'recovery-required', 'integration-recovery-required', 'waiting-child-resume'].includes(delegation?.state)) return null
  if (['recovery-required', 'integration-recovery-required', 'waiting-child-resume'].includes(delegation.state)) {
    return { failurePhase: 'child', failureCategory: delegation.state === 'waiting-child-resume' ? 'user-stop' : 'restart', recoveryAvailable: true, recommendedAction: 'resume-existing', recoveryTool: 'mindnprogress_recover_ai_delegation' }
  }
  if (aiDelegationSucceeded(delegation)) {
    return {
      failurePhase: 'parent-wake',
      failureCategory: 'parent-notification',
      recoveryAvailable: false,
      recommendedAction: 'review-existing-result',
      reportRetryAvailable: delegation.state === 'parent-wake-failed',
    }
  }

  const childFailure = delegation?.workspaceResult?.childError ?? delegation?.childError
  const failureCategory = retryableExternalLimitCategory(childFailure)
  const hasRecoverableWorkspace = Boolean(
    delegation?.workspaceLease?.leaseId
    && delegation?.workspaceResult?.status === 'quarantined'
    && delegation?.workspaceResult?.childStatus === 'failed',
  )
  const canResume = Boolean(failureCategory && (hasRecoverableWorkspace || !delegation?.workspaceLease?.leaseId))
  return {
    failurePhase: 'child',
    failureCategory: failureCategory ?? 'non-retryable',
    recoveryAvailable: canResume,
    recommendedAction: canResume
      ? 'resume-existing'
      : 'inspect-failure',
    ...(canResume
      ? { recoveryTool: 'mindnprogress_recover_ai_delegation' }
      : {}),
  }
}

export function aiDelegationLimitState(delegation) {
  if (aiDelegationSucceeded(delegation) || delegation?.childStatus !== 'failed') return null
  const category = retryableExternalLimitCategory(delegation.childError ?? delegation.workspaceResult?.childError)
  return category === 'usage-limit' ? 'waiting-usage-limit' : category === 'rate-limit' ? 'waiting-rate-limit' : null
}

export function aiDelegationAttemptHistory(delegation, reason, at = new Date().toISOString()) {
  // 직전 시도의 결과와 전달 실패를 보존한다. 현재 결과에는 새 시도의 결과만 표시한다.
  return [...(delegation.attemptHistory ?? []), {
    at, reason, state: delegation.state, operationId: delegation.childOperationId,
    childTurnId: delegation.childTurnId, childStatus: delegation.childStatus,
    childError: delegation.childError ?? null, parentError: delegation.parentError ?? null,
    parentDispatchState: delegation.parentDispatchState, wakeOperationId: delegation.wakeOperationId,
    result: delegation.childResultSnapshot ?? '', resultCapturedAt: delegation.childResultCapturedAt ?? null,
  }]
}

export function aiDelegationWorkPending(delegation) {
  // 업무 성공과 상위 결과 전달을 구분한다. 보고 실패만으로 하위 업무를 미완료 처리하지 않는다.
  return !aiDelegationSucceeded(delegation) && !['completed', 'failed', 'superseded'].includes(delegation.state)
}

export function aiDelegationCanBeSupersededBy(delegation, replacement) {
  if (!['waiting-usage-limit', 'waiting-rate-limit'].includes(delegation?.state)) return false
  if (!replacement || replacement.id === delegation.id || replacement.state !== 'completed' || !aiDelegationSucceeded(replacement)) return false
  if (replacement.mapId !== delegation.mapId
      || (replacement.parentMapId ?? replacement.mapId) !== (delegation.parentMapId ?? delegation.mapId)
      || replacement.parentCardId !== delegation.parentCardId
      || replacement.targetCardId !== delegation.targetCardId) return false
  if (String(replacement.createdAt ?? '') <= String(delegation.createdAt ?? '')) return false
  if (delegation.workspaceLease?.leaseId
      && !['failed-clean', 'cancelled'].includes(delegation.workspaceResult?.status)) return false
  return true
}

export function completedAiDelegationReplacement(delegation, delegations) {
  return [...delegations]
    .filter((candidate) => aiDelegationCanBeSupersededBy(delegation, candidate))
    .sort((first, second) => String(second.createdAt ?? '').localeCompare(String(first.createdAt ?? '')))[0]
    ?? null
}

export function aiDelegationDisplayState(delegation) {
  if (delegation.pendingRecovery) return 'recovery-dispatch-pending'
  return aiDelegationLimitState(delegation) ?? delegation.state
}

export function aiDelegationStateAfterParentWake(delegation, parentDispatchState) {
  if (parentDispatchState !== 'completed') return 'parent-wake-failed'
  return aiDelegationSucceeded(delegation) ? 'completed' : 'failed'
}

export function aiDelegationBlocksResume(delegation, {
  parentConversationId,
  parentTurnId,
} = {}) {
  const sameCompletedParentWake = delegation?.state === 'waking-parent'
    && aiDelegationSucceeded(delegation)
    && String(parentConversationId ?? '').trim()
    && delegation.parentConversationId === parentConversationId
    && String(parentTurnId ?? '').trim()
    && delegation.parentTurnId === parentTurnId
  return !sameCompletedParentWake
}

export function activeAiDelegationsForConversation(delegations, {
  mapId,
  targetCardId,
  targetConversationId,
  excludeId = null,
} = {}) {
  return [...delegations]
    .filter((delegation) => delegation?.id !== excludeId
      && delegation?.mapId === mapId
      && delegation?.targetCardId === targetCardId
      && delegation?.targetConversationId === targetConversationId
      && ACTIVE_AI_DELEGATION_STATES.has(delegation?.state))
    .sort((first, second) => String(second.createdAt ?? '').localeCompare(String(first.createdAt ?? '')))
}

export function explicitCompletionAiDelegationsForConversation(delegations, {
  mapId,
  targetCardId,
  targetConversationId,
} = {}) {
  return [...delegations]
    .filter((delegation) => delegation?.mapId === mapId
      && delegation?.targetCardId === targetCardId
      && delegation?.targetConversationId === targetConversationId
      && EXPLICIT_COMPLETION_CANDIDATE_STATES.has(delegation?.state)
      && String(delegation?.childOperationId ?? '').trim())
    .sort((first, second) => String(second.updatedAt ?? second.createdAt ?? '')
      .localeCompare(String(first.updatedAt ?? first.createdAt ?? '')))
}

export function formatAiConversationTitle(documentTitle, cardTitle) {
  return `${documentTitle}: ${cardTitle}`.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function initialAiDelegationRuntime(dispatch, completedAt = new Date().toISOString()) {
  const state = String(dispatch?.state ?? '').trim()
  const childTurnId = String(dispatch?.turnId ?? '').trim() || null
  const resource = dispatch?.resource && typeof dispatch.resource === 'object'
    ? dispatch.resource
    : null
  if (state === 'completed' || state === 'failed') {
    return {
      state: aiDelegationLimitState({ childStatus: state, childError: dispatch?.errorMessage }) ?? 'waiting-parent',
      childStatus: state,
      childTurnId,
      childError: String(dispatch?.errorMessage ?? '').trim() || null,
      childCompletedAt: completedAt,
    }
  }
  if (state === 'waiting_resume') {
    return {
      state: 'waiting-child-resume',
      childStatus: 'interrupted',
      childTurnId,
      childError: String(dispatch?.errorMessage ?? '').trim() || null,
      childInterruptedAt: completedAt,
    }
  }
  if (state === 'recovery_required') {
    return {
      state: 'recovery-required',
      childStatus: 'interrupted-by-restart',
      childTurnId,
      childError: String(dispatch?.errorMessage ?? '').trim() || 'interrupted_by_restart',
      recoveryRequiredAt: completedAt,
    }
  }
  if (state === 'waiting_resource') {
    return {
      state: 'waiting-resource',
      childTurnId,
      resource,
    }
  }
  return {
    state: state === 'running' ? 'running' : 'starting',
    childTurnId,
    ...(resource ? { resource } : {}),
  }
}
