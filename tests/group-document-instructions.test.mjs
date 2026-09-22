import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildGroupDocumentInstruction,
  containsApprovalEvidenceDuplicate,
  createGroupDocumentInstructionSignature,
  groupDocumentInstructionOperationId,
  groupDocumentInstructionPublicView,
  groupDocumentInstructionResponseBody,
  isValidGroupDocumentInstructionId,
  legacyGroupDelegationCreationAllowed,
  normalizeGroupDocumentReplyTarget,
} from '../server/lib/groupDocumentInstructions.mjs'

const request = {
  parentMapId: 'map-coordinator',
  parentCardId: 'root-coordinator',
  targetMapId: 'map-lobby',
  targetRevision: 7,
  groupProjectVersion: 3,
  sourceRevision: 11,
  strategy: 'new',
  conversationId: '',
  machineId: 'main',
  instructionType: 'execution',
  approvalScope: 'implementation',
  approvalEvidence: '사용자가 문서별 실행 전문을 승인했습니다. 대화 turn-42.',
  instruction: '로비 문서의 승인된 범위를 정비하고 하위 구현 카드에 위임하세요.',
  decisionReason: '문서 담당 대화가 없습니다.',
  newConversation: {
    agentId: 'codex', modelId: 'gpt-5', enabledSkillIds: ['b', 'a'], mcpIds: ['mnp'], workspace: 'C:\\Git\\MindNProgress',
  },
}

test('그룹 문서 지시 키와 요청 서명은 안정적이며 다른 지시를 구분한다', () => {
  assert.equal(isValidGroupDocumentInstructionId('group:3-map-lobby-v7'), true)
  assert.equal(isValidGroupDocumentInstructionId('bad key'), false)
  assert.equal(groupDocumentInstructionOperationId('group:3-map-lobby-v7'), 'gdi:group:3-map-lobby-v7')
  assert.equal(
    createGroupDocumentInstructionSignature(request),
    createGroupDocumentInstructionSignature({
      ...request,
      newConversation: { ...request.newConversation, enabledSkillIds: ['a', 'b'] },
    }),
  )
  assert.notEqual(
    createGroupDocumentInstructionSignature(request),
    createGroupDocumentInstructionSignature({ ...request, approvalScope: 'analysis-only' }),
  )
  assert.equal(
    createGroupDocumentInstructionSignature(request),
    createGroupDocumentInstructionSignature({ ...request, replyTarget: { mode: 'origin' } }),
  )
  assert.notEqual(
    createGroupDocumentInstructionSignature(request),
    createGroupDocumentInstructionSignature({
      ...request,
      replyTarget: { mode: 'explicit', conversationId: 'conversation-review', evidence: '사용자가 현재 지시에서 지정했습니다.' },
    }),
  )
})

test('완료 보고 대상은 기본 발신 대화와 현재 지시의 명시적 예외만 허용한다', () => {
  assert.deepEqual(normalizeGroupDocumentReplyTarget(undefined), { mode: 'origin', conversationId: null, evidence: null })
  assert.deepEqual(normalizeGroupDocumentReplyTarget({ mode: 'origin' }), { mode: 'origin', conversationId: null, evidence: null })
  assert.deepEqual(normalizeGroupDocumentReplyTarget({
    mode: 'explicit', conversationId: 'conversation-review', evidence: '사용자가 이번 지시에서 별도 회신을 요청했습니다.',
  }), {
    mode: 'explicit', conversationId: 'conversation-review', evidence: '사용자가 이번 지시에서 별도 회신을 요청했습니다.',
  })
  assert.equal(normalizeGroupDocumentReplyTarget({ mode: 'explicit', conversationId: 'conversation-review' }), null)
  assert.equal(normalizeGroupDocumentReplyTarget({ mode: 'origin', conversationId: 'stale-conversation' }), null)
})

test('과거 교차 문서 위임 생성은 명시적인 마이그레이션 테스트 설정에서만 허용한다', () => {
  assert.equal(legacyGroupDelegationCreationAllowed(undefined), false)
  assert.equal(legacyGroupDelegationCreationAllowed('true'), false)
  assert.equal(legacyGroupDelegationCreationAllowed('1'), true)
})

test('승인 근거 전문의 실행 지시 중복만 검출하고 일반적인 승인 범위 표현은 허용한다', () => {
  assert.equal(containsApprovalEvidenceDuplicate({
    approvalEvidence: '사용자가 문서별 실행 전문을 승인했습니다.\r\n대화 turn-42.',
    instruction: '로비 문서를 검증하세요.\n\n사용자가 문서별 실행 전문을 승인했습니다.\n대화 turn-42.',
  }), true)
  assert.equal(containsApprovalEvidenceDuplicate({
    approvalEvidence: request.approvalEvidence,
    instruction: '승인된 범위에서 로비 문서를 검증하세요.',
  }), false)
})

test('그룹 문서 지시 전문은 위임·worker 완료와 분리하고 승인 경계를 전달한다', () => {
  const instruction = buildGroupDocumentInstruction({
    groupId: 'group-project',
    parentMapId: request.parentMapId,
    targetMapId: request.targetMapId,
    targetCardId: 'root-lobby',
    targetRevision: request.targetRevision,
    groupProjectVersion: request.groupProjectVersion,
    instructionId: 'group:3-map-lobby-v7',
    parentConversationId: 'conversation-coordinator',
    instructionType: request.instructionType,
    approvalScope: request.approvalScope,
    approvalEvidence: request.approvalEvidence,
    instruction: request.instruction,
    editorId: 'editor-1',
    attributionToken: 'token-1',
    documentCoordinatorInstruction: '문서 루트 AI 운영 지침',
  })
  assert.match(instruction, /^# MindNProgress 그룹 문서 지시/m)
  assert.match(instruction, /worker 위임이나 작업공간 배정이 아닙니다/)
  assert.match(instruction, /실제 하위 업무 카드에 AI 위임/)
  assert.match(instruction, /승인 근거를 다시 요구하지 마세요/)
  assert.match(instruction, /기본 대상: `conversation-coordinator`/)
  assert.match(instruction, /명시적 대체: 없음/)
  assert.match(instruction, /과거 지시·AION_SESSION_MESSAGE·reply_to·기억/)
  assert.match(instruction, /최종 보고 직전에 instructionId와 대상을 다시 확인/)
  assert.match(instruction, /역할 원문은 get_group_context의 guide\.documentCoordinator 한 곳/)
  assert.match(instruction, /사용자가 문서별 실행 전문을 승인했습니다/)
  assert.equal(instruction.split(request.approvalEvidence).length - 1, 1)
  assert.ok(instruction.length <= 1_800)
  assert.doesNotMatch(instruction, /# MindNProgress 하위 카드 위임 작업 요청/)
})

test('그룹 문서 지시 전문은 사용자가 현재 지시에서 지정한 대체 회신 대상을 우선 표시한다', () => {
  const instruction = buildGroupDocumentInstruction({
    groupId: 'group-project', parentMapId: request.parentMapId, targetMapId: request.targetMapId,
    targetCardId: 'root-lobby', targetRevision: request.targetRevision, groupProjectVersion: request.groupProjectVersion,
    instructionId: 'group:3-map-lobby-v8', parentConversationId: 'conversation-coordinator',
    instructionType: request.instructionType, approvalScope: request.approvalScope,
    approvalEvidence: request.approvalEvidence, instruction: request.instruction,
    editorId: 'editor-1', attributionToken: 'token-1', documentCoordinatorInstruction: '문서 루트 AI 운영 지침',
    replyTarget: {
      mode: 'explicit', explicitConversationId: 'conversation-review',
      evidence: '사용자가 이번 지시의 완료 보고를 검수 대화로 요청했습니다.',
    },
  })
  assert.match(instruction, /명시적 대체: `conversation-review`/)
  assert.match(instruction, /현재 유효 대상: `conversation-review`/)
  assert.match(instruction, /대체 근거: 사용자가 이번 지시의 완료 보고를 검수 대화로 요청했습니다/)
})

test('그룹 문서 지시 공개 응답은 기본적으로 전문을 숨기고 reasonCode와 message를 보장한다', () => {
  const stored = {
    id: 'instruction-1', state: 'delivered', requestSignature: 'hash',
    pendingSelection: { agent: { id: 'codex' } }, pendingInstruction: '대기 원문',
    pendingApprovalEvidence: '승인 원문', instruction: '전달 원문', approvalEvidence: '승인 근거', response: '응답 원문',
  }
  assert.deepEqual(groupDocumentInstructionPublicView(stored), { id: 'instruction-1', state: 'delivered' })
  assert.equal(groupDocumentInstructionPublicView(stored, { includeContent: true }).instruction, '전달 원문')
  assert.deepEqual(
    groupDocumentInstructionResponseBody(202, 'GROUP_DOCUMENT_INSTRUCTION_DELIVERED', '전달했습니다.', { repeated: false }),
    { ok: true, reasonCode: 'GROUP_DOCUMENT_INSTRUCTION_DELIVERED', message: '전달했습니다.', repeated: false },
  )
})
