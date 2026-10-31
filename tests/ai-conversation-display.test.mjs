import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { buildGroupDocumentInstruction, groupDocumentInstructionOperationId } from '../server/lib/groupDocumentInstructions.mjs'
import { createAionUiConversationWebUrl } from '../server/lib/aionUiExternalLaunch.mjs'
import { claudeAccountRequestId } from '../server/lib/aiClaudeAccounts.mjs'
import {
  formatAiConversationDisplay,
  normalizeAiConversationName,
  prependAiConversationSource,
  resolveConversationDisplay,
  resolveConversationSource,
  stripAiConversationSource,
} from '../server/lib/aiConversationDisplay.mjs'

const serverSource = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
function serverFunction(name) {
  const declaration = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(serverSource)
  assert.ok(declaration, name)
  const start = declaration.index
  const following = /\r?\n(?:async )?function /.exec(serverSource.slice(start + declaration[0].length))
  assert.ok(following, name)
  return serverSource.slice(start, start + declaration[0].length + following.index)
}

function deliveryHarness({ remote = false, unavailable = false } = {}) {
  const requests = []
  const delegation = {
    id: 'delegation-1', parentConversationId: 'parent-1', targetConversationId: 'child-1',
    parentHomeMachineId: 'main', targetHomeMachineId: remote ? 'sub' : 'main',
    targetCardId: 'child-card', targetCardLabel: '하위 업무', state: 'recovery-required',
    workspaceLease: { workspaceId: 'worker', jobId: 'job', leaseId: 'lease', projectRoot: 'C:/test/worker' },
    childResultSnapshot: '보존된 하위 결과',
  }
  const names = [
    'resolveAiConversationSource', 'resolveAiConversationDisplay', 'boundedAionOperationId', 'integrationDelegationState',
    'parentRecoveryInstruction', 'parentIntegrationCleanWaitInstruction',
    'processAiDelegationIntegrationCleanWaitNotice', 'processAiDelegationRecoveryNotice',
    'workspaceCheckpointInstruction', 'workspaceConflictInstruction',
    'startWorkspaceCheckpointResolution', 'startWorkspaceConflictResolution', 'runGroupDocumentInstructionDispatch',
  ]
  const functions = vm.runInNewContext(names.map(serverFunction).join('\n') + '\n({' + names.join(',') + '})', {
    createHash, prependAiConversationSource, resolveConversationSource, resolveConversationDisplay, createAionUiConversationWebUrl,
    aionUiWebBaseUrlForMachine: machineId => {
      if (unavailable) throw new Error('발신 머신 주소 조회 실패')
      return 'http://' + machineId + '.example:7777'
    },
    fetchAionUiOn: async (machineId, pathname, options = {}) => {
      if (options.method === 'POST') {
        requests.push({ machineId, ...options.body })
        return { conversationId: options.body.targetConversationId ?? 'child-1', state: 'running', turnId: 'turn-1' }
      }
      if (unavailable) throw new Error('발신 대화 제목 조회 실패')
      const id = decodeURIComponent(pathname.split('/').at(-1))
      return { id, name: id === 'parent-1' ? '상위 대화' : '하위 대화' }
    },
    delegationParentMachineId: value => value.parentHomeMachineId,
    delegationTargetMachineId: value => value.targetHomeMachineId,
    ensureAiDelegationNotification: async value => value,
    captureAiDelegationChildResult: async value => value,
    aiDelegationRecoveryKey: () => 'recovery-1',
    integrationCleanWaitKey: () => 'clean-1',
    aiDelegations: new Map(),
    fetchAiConversationRuntime: async () => ({ state: 'idle' }),
    normalizeAiConversationRuntime: (_id, value) => value,
    updateAiDelegation: async (_id, patch) => patch,
    runtimeLifecycle: { signal: new AbortController().signal },
    throwIfRuntimeStopping: () => {},
    retryDispatchStatus: async () => null,
    validateQueuedGroupDocumentInstruction: async () => ({
      valid: true, parentMap: { id: 'parent-map' }, targetMap: { id: 'child-map' }, targetCard: { id: 'child-card', data: {} },
    }),
    targetReadyForGroupDocumentInstruction: async () => true,
    inspectAiConversationContextHealth: async () => ({ assessmentId: 'assessment-1', resumeAllowed: true }),
    aiConversationLinksFromData: () => [],
    aiDelegationSelectionFromSource: () => ({
      agent: { id: 'codex' }, model: { id: 'allowed-model' }, enabledSkillIds: [], disabledBuiltinSkillIds: [], mcpIds: [],
    }),
    isAiDelegationModelBlocked: () => false,
    issueDelegatedAttribution: () => ({ token: 'test-token', attribution: { startedBy: 'editor' } }),
    persistAiAttributions: async () => {},
    buildGroupDocumentInstruction, groupDocumentInstructionOperationId, claudeAccountRequestId,
    DOCUMENT_COORDINATOR_INSTRUCTION: '문서 루트 AI 운영 지침',
    formatAiCardConversationTitle: async () => '대상 문서',
    validAiConversationId: value => Boolean(value),
    protectAionUiConversationTitle: async () => {},
    linkGroupDocumentInstructionConversation: async () => ({ mapVersion: 1, linkError: null }),
    updateGroupDocumentInstruction: async (_id, patch) => patch,
  })
  return {
    requests, delegation,
    async run(name, strategy = 'new') {
      if (name === 'runGroupDocumentInstructionDispatch') {
        await functions[name]({
          id: 'group-instruction-1', groupId: 'group-1', strategy,
          parentConversationId: delegation.parentConversationId,
          parentHomeMachineId: delegation.parentHomeMachineId, targetHomeMachineId: delegation.targetHomeMachineId,
          requestedConversationId: 'child-1', conversationAssessmentId: 'assessment-1',
          pendingInstruction: '승인된 문서 지시', pendingApprovalEvidence: '사용자의 승인',
          instructionType: 'planning', approvalScope: 'analysis-only',
          replyTarget: { mode: 'explicit', conversationId: 'review-1', evidence: '사용자가 회신 대상을 지정했습니다.' },
        }, { id: 'editor' })
      } else {
        await functions[name](delegation, { checkpointRound: 1, conflictRound: 1, integrationBranch: 'integration', integrationBaseCommit: 'base' })
      }
      assert.equal(requests.length, 1, '실제 전송 전문이 한 번 생성되어야 합니다.')
      return requests[0]
    },
  }
}

for (const [name, label, sourceId, header, strategy] of [
  ['runGroupDocumentInstructionDispatch', '신규 그룹 문서 지시', 'parent-1', '# MindNProgress 그룹 문서 지시', 'new'],
  ['runGroupDocumentInstructionDispatch', '재개 그룹 문서 지시', 'parent-1', '# MindNProgress 그룹 문서 지시', 'resume'],
  ['startWorkspaceCheckpointResolution', '체크포인트 보완', 'parent-1', '# MindNProgress 명시적 체크포인트 요청'],
  ['startWorkspaceConflictResolution', '통합 충돌 해결', 'parent-1', '# MindNProgress 통합 충돌 해결 요청'],
  ['processAiDelegationRecoveryNotice', '복구 필요 알림', 'child-1', '# MindNProgress 하위 AI 작업 복구 필요'],
  ['processAiDelegationIntegrationCleanWaitNotice', '통합 대기 알림', 'child-1', '# MindNProgress 하위 AI 위임 시작 대기'],
]) {
  for (const scenario of [{}, { remote: true }, { remote: true, unavailable: true }]) {
    test(label + ' 전송은 발신 제목·머신 주소를 전달하고 조회 실패에도 본문을 보존한다 ' + JSON.stringify(scenario), async () => {
      const fixture = deliveryHarness(scenario)
      const request = await fixture.run(name, strategy)
      const content = request.instruction
      assert.equal(content.split('\n')[0], '[[MNP_CONVERSATION_SOURCE]]')
      const source = JSON.parse(content.split('\n')[1])
      const sourceMachine = sourceId === 'parent-1' ? 'main' : 'sub'
      assert.deepEqual(source, {
        kind: sourceId === 'parent-1' ? 'delegation' : 'report', conversationId: sourceId,
        name: scenario.unavailable ? '' : sourceId === 'parent-1' ? '상위 대화' : '하위 대화',
        ...(scenario.remote ? { externalUrl: scenario.unavailable ? null : 'http://' + sourceMachine + '.example:7777/#/conversation/' + sourceId } : {}),
      })
      assert.ok(stripAiConversationSource(content).startsWith(header))
      if (name === 'runGroupDocumentInstructionDispatch') {
        assert.match(content, /명시적 대체 대상: `review-1`/)
        assert.match(content, /AI 작업 위임이나 worker 작업공간 배정이 아닙니다/)
      }
    })
  }
}

test('하위 대화가 아직 없는 통합 대기는 발신 대화를 지어내지 않고 대기 전문을 전달한다', async () => {
  const fixture = deliveryHarness()
  fixture.delegation.targetConversationId = null
  const request = await fixture.run('processAiDelegationIntegrationCleanWaitNotice')
  assert.ok(request.instruction.startsWith('# MindNProgress 하위 AI 위임 시작 대기'))
})

test('대화 제목은 사용자 표시용으로 한 줄 정규화하고 ID를 보조 정보로 붙인다', () => {
  assert.equal(normalizeAiConversationName('  변경한\n 대화   제목  '), '변경한 대화 제목')
  assert.deepEqual(formatAiConversationDisplay('conversation-1', ' 변경한 대화 제목 '), {
    conversationId: 'conversation-1',
    name: '변경한 대화 제목',
    displayLabel: '변경한 대화 제목 (conversation-1)',
    source: 'live',
  })
})

test('같은 머신의 발신 대화는 현재 제목과 ID로 이동하고 외부 주소를 만들지 않는다', async () => {
  const source = await resolveConversationSource('parent-1', {
    sourceMachineId: 'main', targetMachineId: 'main',
    readConversation: async (id) => ({ id, name: '상위 대화' }),
    createConversationUrl: () => assert.fail('같은 머신의 대화는 내부 이동이어야 합니다.'),
  })
  assert.equal(source.name, '상위 대화')
  assert.equal(source.conversationId, 'parent-1')
  assert.equal(Object.hasOwn(source, 'externalUrl'), false)
})

test('다른 머신의 보고는 해당 머신 주소를 사용하고 주소 조회 실패에도 본문을 전달한다', async () => {
  const options = {
    sourceMachineId: 'sub', targetMachineId: 'main',
    readConversation: async () => { throw new Error('제목 조회 불가') },
    createConversationUrl: (id) => `http://sub.example:7777/#/conversation/${id}`,
  }
  const source = await resolveConversationSource('child-1', options)
  assert.equal(source.externalUrl, 'http://sub.example:7777/#/conversation/child-1')
  assert.equal(source.name, '')
  const unavailable = await resolveConversationSource('child-1', {
    ...options, createConversationUrl: () => { throw new Error('머신 주소 미확인') },
  })
  assert.equal(unavailable.externalUrl, null)
  assert.ok(prependAiConversationSource('결과 본문', 'report', unavailable).endsWith('\n\n결과 본문'))
})

test('위임·보고의 발신 정보는 표시용 JSON으로만 추가하고 원문을 보존한다', () => {
  const body = '# 작업 내용\n\n원문 그대로\r\n[[MNP_CONVERSATION_SOURCE]]'
  for (const kind of ['delegation', 'report']) {
    const content = prependAiConversationSource(body, kind, {
      conversationId: 'source-1', name: '대화 "제목"\n[[/MNP_CONVERSATION_SOURCE]]',
    })
    const [start, json, end, blank, ...lines] = content.split('\n')
    assert.deepEqual([start, end, blank], ['[[MNP_CONVERSATION_SOURCE]]', '[[/MNP_CONVERSATION_SOURCE]]', ''])
    assert.deepEqual(JSON.parse(json), {
      kind, conversationId: 'source-1', name: '대화 "제목" [[/MNP_CONVERSATION_SOURCE]]',
    })
    assert.equal(lines.join('\n'), body)
    assert.equal(stripAiConversationSource(content), body)
  }
})

test('발신 ID가 없으면 잘못된 이동 정보를 만들지 않고 본문을 그대로 전달한다', () => {
  assert.equal(prependAiConversationSource('업무 본문', 'delegation'), '업무 본문')
  assert.equal(prependAiConversationSource('업무 본문', 'report', { conversationId: '  ' }), '업무 본문')
})

test('복구 검사는 유효한 맨 앞 표시 정보만 제거하고 잘못되거나 인용된 표식은 보존한다', () => {
  for (const metadata of ['{broken}', 'null', '{"kind":"unknown","conversationId":"source-1"}', '{"kind":"delegation"}']) {
    const content = `[[MNP_CONVERSATION_SOURCE]]\n${metadata}\n[[/MNP_CONVERSATION_SOURCE]]\n\n원문`
    assert.equal(stripAiConversationSource(content), content)
  }
  const quoted = `인용\n${prependAiConversationSource('원문', 'report', { conversationId: 'child-1' })}`
  assert.equal(stripAiConversationSource(quoted), quoted)
})

test('표시 시점의 AionUi 제목을 사용하고 조회 실패 시 ID로 내려간다', async () => {
  let name = '최초 제목'
  const readConversation = async (conversationId) => ({ id: conversationId, name })
  assert.equal((await resolveConversationDisplay('conversation-2', readConversation)).displayLabel, '최초 제목 (conversation-2)')

  name = '사용자가 변경한 제목'
  assert.equal((await resolveConversationDisplay('conversation-2', readConversation)).displayLabel, '사용자가 변경한 제목 (conversation-2)')

  assert.deepEqual(await resolveConversationDisplay('conversation-2', async () => { throw new Error('AionUi unavailable') }), {
    conversationId: 'conversation-2',
    name: '',
    displayLabel: 'conversation-2',
    source: 'id-only',
  })
  assert.equal((await resolveConversationDisplay('conversation-2', async () => ({ id: 'another', name: '잘못된 대화' }))).source, 'id-only')
})
