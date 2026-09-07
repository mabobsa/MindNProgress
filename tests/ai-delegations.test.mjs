import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_DELEGATION_WAIT_POLL_DELAYS_MS,
  activeAiDelegationsForConversation,
  aiDelegationWaitPollDue,
  aiDelegationBlocksResume,
  aiDelegationStateAfterParentWake,
  aiDelegationSucceeded,
  aiDelegationWorkspaceLeaseMatches,
  createAiDelegationRequestSignature,
  explicitCompletionAiDelegationsForConversation,
  failedAiIntegrationRecoveryRuntime,
  mergeAiDelegationSelections,
  formatAiConversationTitle,
  initialAiDelegationRuntime,
  isValidAiDelegationId,
  nextAiDelegationWaitPoll,
  shouldReconcileAiDelegationChildWorkspace,
} from '../server/lib/aiDelegations.mjs'

test('AI 위임 대기 폴링은 상태별로 3초에서 30초까지 백오프하고 상태 변경 시 초기화한다', () => {
  const delegation = { state: 'waiting-workspace' }
  let entry = null
  let now = 1_000
  const delays = []
  for (let index = 0; index < 6; index += 1) {
    assert.equal(aiDelegationWaitPollDue(entry, delegation, now), true)
    entry = nextAiDelegationWaitPoll(entry, delegation, now)
    delays.push(entry.delayMs)
    assert.equal(aiDelegationWaitPollDue(entry, delegation, now), false)
    now = entry.nextAt
  }
  assert.deepEqual(delays, [3_000, 5_000, 10_000, 30_000, 30_000, 30_000])
  assert.deepEqual(AI_DELEGATION_WAIT_POLL_DELAYS_MS, [3_000, 5_000, 10_000, 30_000])

  const changed = { state: 'waiting-integration-clean' }
  const reset = nextAiDelegationWaitPoll(entry, changed, now)
  assert.equal(reset.attempt, 1)
  assert.equal(reset.delayMs, 3_000)
  assert.equal(aiDelegationWaitPollDue(entry, changed, now), true)
})

test('같은 위임 ID의 새 대화 실행 설정이 달라지면 다른 요청으로 판정한다', () => {
  const base = {
    mapId: 'map-a',
    parentCardId: 'card-parent',
    targetCardId: 'card-child',
    strategy: 'new',
    conversationId: '',
    instruction: '작업을 진행하세요.',
    decisionReason: '최신 대화가 없습니다.',
    sourceRevision: 12,
    newConversation: {
      agentId: 'claude',
      modelId: 'opus',
      providerId: 'anthropic',
      thoughtLevelId: 'high',
      enabledSkillIds: ['skill-b', 'skill-a'],
      mcpIds: ['mcp-b', 'mcp-a'],
      workspace: 'C:\\Git\\Game_Worker02\\game-client',
    },
  }
  const signature = createAiDelegationRequestSignature(base)
  assert.equal(signature, createAiDelegationRequestSignature({
    ...base,
    newConversation: {
      ...base.newConversation,
      enabledSkillIds: ['skill-a', 'skill-b'],
      mcpIds: ['mcp-a', 'mcp-b'],
    },
  }))
  assert.equal(signature, createAiDelegationRequestSignature({ ...base, machineId: '' }))
  assert.notEqual(signature, createAiDelegationRequestSignature({
    ...base,
    newConversation: { ...base.newConversation, modelId: 'sonnet' },
  }))
  assert.notEqual(signature, createAiDelegationRequestSignature({
    ...base,
    newConversation: { ...base.newConversation, workspace: 'C:\\Git\\Game_Worker03\\game-client' },
  }))
  assert.notEqual(signature, createAiDelegationRequestSignature({
    ...base,
    machineId: 'macbook',
  }))
})

test('AionCore가 실제 사용한 작업공간 lease를 모든 식별자로 비교한다', () => {
  const expected = {
    workspaceId: 'fork2',
    jobId: 'job-12',
    leaseId: 'lease-12',
    projectRoot: 'C:\\Git\\Game_Worker02\\game-client\\',
  }
  assert.equal(aiDelegationWorkspaceLeaseMatches(expected, {
    ...expected,
    projectRoot: 'c:/git/game_worker02/game-client',
  }), true)
  assert.equal(aiDelegationWorkspaceLeaseMatches(expected, {
    ...expected,
    leaseId: 'lease-other',
  }), false)
  assert.equal(aiDelegationWorkspaceLeaseMatches(expected, null), false)
  assert.equal(aiDelegationWorkspaceLeaseMatches(null, null), true)
})

test('필수 체크포인트 대화 실패는 상위 완료가 아니라 통합 복구 대기로 유지한다', () => {
  assert.deepEqual(failedAiIntegrationRecoveryRuntime({
    state: 'failed',
    turnId: 'turn-checkpoint-failed',
    errorMessage: 'Agent process disconnected',
  }, '2026-08-17T08:18:26.000Z'), {
    state: 'integration-recovery-required',
    integrationStatus: 'failed',
    integrationTurnId: 'turn-checkpoint-failed',
    integrationError: 'Agent process disconnected',
    recoveryRequiredAt: '2026-08-17T08:18:26.000Z',
    integrationResource: null,
  })
  assert.equal(failedAiIntegrationRecoveryRuntime({ state: 'completed' }), null)
})

test('상위 대화 알림 성공과 하위 작업 성공을 별도로 판정한다', () => {
  const completed = {
    childStatus: 'completed',
    workspaceLease: { leaseId: 'lease-1' },
    workspaceResult: { status: 'completed' },
    integrationOperationId: 'operation-checkpoint',
    integrationStatus: 'completed',
    workspaceError: null,
  }
  assert.equal(aiDelegationSucceeded(completed), true)
  assert.equal(aiDelegationStateAfterParentWake(completed, 'completed'), 'completed')

  const integrationFailed = {
    ...completed,
    workspaceResult: { status: 'checkpoint-required' },
    integrationStatus: 'failed',
    integrationError: 'Agent process disconnected',
  }
  assert.equal(aiDelegationSucceeded(integrationFailed), false)
  assert.equal(aiDelegationStateAfterParentWake(integrationFailed, 'completed'), 'failed')
  assert.equal(aiDelegationStateAfterParentWake(completed, 'failed'), 'parent-wake-failed')
})

test('새 대화에서 명시하지 않은 실행 환경은 최근 대화와 상위 대화에서 필드별로 상속한다', () => {
  const selection = mergeAiDelegationSelections(
    {
      agentId: 'claude', modeId: 'bypassPermissions', thoughtLevelId: 'high',
    },
    {
      agent: { id: 'codex', label: 'Codex CLI' }, model: { id: 'gpt', label: 'GPT' },
      enabledSkillIds: ['skill-a'], mcpIds: ['mcp-a'],
    },
    {
      agent: { id: 'claude', label: 'Claude Code' }, model: { id: 'opus', label: 'Opus' },
      enabledSkillIds: ['skill-a'], mcpIds: ['mcp-a'],
      workspace: 'C:\\Git\\Game_Integration\\game-client',
    },
  )

  assert.equal(selection.agent.id, 'claude')
  assert.equal(selection.model.id, 'opus')
  assert.equal(selection.mode.id, 'bypassPermissions')
  assert.equal(selection.thoughtLevel.id, 'high')
  assert.deepEqual(selection.enabledSkillIds, ['skill-a'])
  assert.deepEqual(selection.mcpIds, ['mcp-a'])
  assert.equal(selection.workspace, 'C:\\Git\\Game_Integration\\game-client')
})

test('명시적인 빈 스킬과 MCP 목록은 상위 설정으로 다시 채우지 않는다', () => {
  const selection = mergeAiDelegationSelections(
    { agentId: 'claude', modelId: 'opus', enabledSkillIds: [], mcpIds: [] },
    { agentId: 'claude', modelId: 'opus', enabledSkillIds: ['skill-a'], mcpIds: ['mcp-a'] },
  )
  assert.deepEqual(selection.enabledSkillIds, [])
  assert.deepEqual(selection.mcpIds, [])
})

test('AI 위임으로 만든 새 대화 제목에 문서와 카드 제목을 함께 사용한다', () => {
  assert.equal(formatAiConversationTitle('JP-로그인', '더미 UI 준비'), 'JP-로그인: 더미 UI 준비')
  assert.equal(formatAiConversationTitle('문서\n제목', '카드   제목'), '문서 제목: 카드 제목')
  assert.equal(formatAiConversationTitle('문서', '카드'.repeat(60)).length, 120)
})

test('콜론을 포함한 위임 ID를 요청과 재시작 복원에서 사용할 수 있다', () => {
  assert.equal(isValidAiDelegationId('map-a:card-b:1258:p0-download-errors'), true)
  assert.equal(isValidAiDelegationId('map-a/card-b/1258'), false)
  assert.equal(isValidAiDelegationId('map-a card-b 1258'), false)
})

test('이미 끝난 AionCore operation은 상위 대화 재개 대기 상태로 복구한다', () => {
  assert.deepEqual(initialAiDelegationRuntime({
    state: 'completed',
    turnId: 'turn-child',
  }, '2026-08-11T09:00:00.000Z'), {
    state: 'waiting-parent',
    childStatus: 'completed',
    childTurnId: 'turn-child',
    childError: null,
    childCompletedAt: '2026-08-11T09:00:00.000Z',
  })
})

test('구버전 자원 대기 상태를 하위 작업 완료로 오인하지 않는다', () => {
  const runtime = initialAiDelegationRuntime({
    state: 'waiting_resource',
    turnId: 'turn-waiting',
    resource: {
      kind: 'unity_project',
      key: 'unity:abc123',
      projectRoot: 'C:/Git/Game_Integration/game-client',
    },
  })
  assert.equal(runtime.state, 'waiting-resource')
  assert.equal(runtime.childTurnId, 'turn-waiting')
  assert.equal(runtime.resource.key, 'unity:abc123')
})

test('서버 재시작 시 하위 실행 단계의 작업공간만 다시 연결한다', () => {
  assert.equal(shouldReconcileAiDelegationChildWorkspace({ state: 'running' }), true)
  assert.equal(shouldReconcileAiDelegationChildWorkspace({ state: 'waiting-child-resume' }), true)
  assert.equal(shouldReconcileAiDelegationChildWorkspace({ state: 'waiting-integration' }), false)
  assert.equal(shouldReconcileAiDelegationChildWorkspace({ state: 'waiting-parent' }), false)
  assert.equal(shouldReconcileAiDelegationChildWorkspace({ state: 'waking-parent' }), false)
  assert.equal(shouldReconcileAiDelegationChildWorkspace({ state: 'recovery-required' }), false)
})

test('사용자가 중지한 하위 턴은 상위 대화 재개가 아닌 하위 재개 대기로 유지한다', () => {
  assert.deepEqual(initialAiDelegationRuntime({
    state: 'waiting_resume',
    turnId: 'turn-interrupted',
    errorMessage: 'Agent process disconnected',
  }, '2026-08-13T09:00:00.000Z'), {
    state: 'waiting-child-resume',
    childStatus: 'interrupted',
    childTurnId: 'turn-interrupted',
    childError: 'Agent process disconnected',
    childInterruptedAt: '2026-08-13T09:00:00.000Z',
  })
})

test('명시적 완료는 현재 카드와 대화에서 중지 후 재개를 기다리는 위임만 대상으로 한다', () => {
  const matches = explicitCompletionAiDelegationsForConversation([
    {
      id: 'waiting-old', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      childOperationId: 'operation-old', state: 'waiting-child-resume', updatedAt: '2026-08-18T08:00:00.000Z',
    },
    {
      id: 'waiting-new', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      childOperationId: 'operation-new', state: 'waiting-child-resume', updatedAt: '2026-08-18T09:00:00.000Z',
    },
    {
      id: 'running', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      childOperationId: 'operation-running', state: 'running', updatedAt: '2026-08-18T10:00:00.000Z',
    },
    {
      id: 'other-card', mapId: 'map-a', targetCardId: 'card-b', targetConversationId: 'conversation-a',
      childOperationId: 'operation-other', state: 'waiting-child-resume', updatedAt: '2026-08-18T11:00:00.000Z',
    },
    {
      id: 'missing-operation', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      state: 'waiting-child-resume', updatedAt: '2026-08-18T12:00:00.000Z',
    },
  ], {
    mapId: 'map-a',
    targetCardId: 'card-a',
    targetConversationId: 'conversation-a',
  })

  assert.deepEqual(matches.map((delegation) => delegation.id), ['running', 'waiting-new', 'waiting-old'])
})

test('AionCore 재시작 상태는 완료 처리하지 않고 명시적 복구 대기로 유지한다', () => {
  assert.deepEqual(initialAiDelegationRuntime({
    state: 'recovery_required',
    conversationId: 'conversation-child',
    turnId: 'turn-before-restart',
    errorMessage: 'interrupted_by_restart',
  }, '2026-08-15T12:00:00.000Z'), {
    state: 'recovery-required',
    childStatus: 'interrupted-by-restart',
    childTurnId: 'turn-before-restart',
    childError: 'interrupted_by_restart',
    recoveryRequiredAt: '2026-08-15T12:00:00.000Z',
  })
})

test('같은 카드와 대화에서 아직 끝나지 않은 위임만 최신순으로 찾는다', () => {
  const matches = activeAiDelegationsForConversation([
    {
      id: 'old-waiting', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      state: 'waiting-child-resume', createdAt: '2026-08-15T09:00:00.000Z',
    },
    {
      id: 'new-running', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      state: 'running', createdAt: '2026-08-15T10:00:00.000Z',
    },
    {
      id: 'newest-recovery', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      state: 'recovery-required', createdAt: '2026-08-15T10:30:00.000Z',
    },
    {
      id: 'workspace-queued', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      state: 'waiting-workspace', createdAt: '2026-08-15T10:45:00.000Z',
    },
    {
      id: 'integration-clean-wait', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      state: 'waiting-integration-clean', createdAt: '2026-08-15T10:50:00.000Z',
    },
    {
      id: 'completed', mapId: 'map-a', targetCardId: 'card-a', targetConversationId: 'conversation-a',
      state: 'completed', createdAt: '2026-08-15T11:00:00.000Z',
    },
    {
      id: 'other-card', mapId: 'map-a', targetCardId: 'card-b', targetConversationId: 'conversation-a',
      state: 'running', createdAt: '2026-08-15T12:00:00.000Z',
    },
  ], {
    mapId: 'map-a',
    targetCardId: 'card-a',
    targetConversationId: 'conversation-a',
  })

  assert.deepEqual(matches.map((delegation) => delegation.id), [
    'integration-clean-wait', 'workspace-queued', 'newest-recovery', 'new-running', 'old-waiting',
  ])
  assert.equal(activeAiDelegationsForConversation(matches, {
    mapId: 'map-a',
    targetCardId: 'card-a',
    targetConversationId: 'conversation-a',
    excludeId: 'new-running',
  }).at(0)?.id, 'integration-clean-wait')
})

test('완료 결과를 전달받은 동일 상위 turn은 waking-parent 중에도 같은 하위 대화를 다시 위임할 수 있다', () => {
  const delegation = {
    state: 'waking-parent',
    parentConversationId: 'conversation-parent',
    parentTurnId: 'turn-parent-wake',
    childStatus: 'completed',
    workspaceError: null,
    workspaceLease: { leaseId: 'lease-a' },
    workspaceResult: { status: 'completed' },
    integrationOperationId: 'integration-a',
    integrationStatus: 'completed',
  }

  assert.equal(aiDelegationBlocksResume(delegation, {
    parentConversationId: 'conversation-parent',
    parentTurnId: 'turn-parent-wake',
  }), false)
  assert.equal(aiDelegationBlocksResume(delegation, {
    parentConversationId: 'conversation-parent',
    parentTurnId: 'turn-other',
  }), true)
  assert.equal(aiDelegationBlocksResume(delegation, {
    parentConversationId: 'conversation-other',
    parentTurnId: 'turn-parent-wake',
  }), true)
})

test('하위 작업이나 통합이 끝나지 않은 waking-parent 위임은 같은 상위 turn에서도 다시 위임할 수 없다', () => {
  const base = {
    state: 'waking-parent',
    parentConversationId: 'conversation-parent',
    parentTurnId: 'turn-parent-wake',
    childStatus: 'completed',
    workspaceError: null,
    workspaceLease: { leaseId: 'lease-a' },
    workspaceResult: { status: 'completed' },
    integrationOperationId: 'integration-a',
    integrationStatus: 'completed',
  }
  const scope = {
    parentConversationId: 'conversation-parent',
    parentTurnId: 'turn-parent-wake',
  }

  assert.equal(aiDelegationBlocksResume({ ...base, childStatus: 'running' }, scope), true)
  assert.equal(aiDelegationBlocksResume({ ...base, workspaceResult: { status: 'waiting-integration' } }, scope), true)
  assert.equal(aiDelegationBlocksResume({ ...base, integrationStatus: 'running' }, scope), true)
  assert.equal(aiDelegationBlocksResume({ ...base, workspaceError: '통합 실패' }, scope), true)
})
