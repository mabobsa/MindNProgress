import { createHash } from 'node:crypto'
import { MNP_CONTEXT_BOOTSTRAP_INSTRUCTION } from '../../src/utils/aiContextInstructions.mjs'

export const GROUP_DOCUMENT_INSTRUCTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,95}$/
export const GROUP_DOCUMENT_INSTRUCTION_TYPES = Object.freeze([
  'planning',
  'scope-adjustment',
  'execution',
  'validation',
  'status-request',
])
export const GROUP_DOCUMENT_INSTRUCTION_SCOPES = Object.freeze([
  'analysis-only',
  'card-maintenance',
  'implementation',
  'validation',
])
const GROUP_DOCUMENT_REPLY_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/

export function isValidGroupDocumentInstructionId(value) {
  return GROUP_DOCUMENT_INSTRUCTION_ID_PATTERN.test(String(value ?? ''))
}

export function legacyGroupDelegationCreationAllowed(value) {
  return String(value ?? '').trim() === '1'
}

export function normalizeGroupDocumentReplyTarget(value) {
  if (value === undefined || value === null) return { mode: 'origin', conversationId: null, evidence: null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const mode = String(value.mode ?? '').trim()
  const conversationId = String(value.conversationId ?? '').trim()
  const evidence = String(value.evidence ?? '').trim()
  if (mode === 'origin') {
    if (conversationId || evidence) return null
    return { mode, conversationId: null, evidence: null }
  }
  if (mode !== 'explicit' || !GROUP_DOCUMENT_REPLY_CONVERSATION_ID_PATTERN.test(conversationId)
    || !evidence || evidence.length > 1_000) return null
  return { mode, conversationId, evidence }
}

function normalizeInstructionBlock(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

export function containsApprovalEvidenceDuplicate({ approvalEvidence, instruction } = {}) {
  const evidence = normalizeInstructionBlock(approvalEvidence)
  const body = normalizeInstructionBlock(instruction)
  return Boolean(evidence) && body.includes(evidence)
}

export function groupDocumentInstructionOperationId(id) {
  return `gdi:${id}`
}

export function createGroupDocumentInstructionSignature({
  parentMapId,
  parentCardId,
  targetMapId,
  targetRevision,
  groupProjectVersion,
  sourceRevision,
  strategy,
  conversationId,
  machineId,
  instructionType,
  approvalScope,
  approvalEvidence,
  instruction,
  decisionReason,
  replyTarget,
  newConversation,
}) {
  const requestedConversation = newConversation && typeof newConversation === 'object'
    ? {
        agentId: String(newConversation.agentId ?? '').trim() || null,
        modelId: String(newConversation.modelId ?? '').trim() || null,
        modeId: String(newConversation.modeId ?? '').trim() || null,
        thoughtLevelId: String(newConversation.thoughtLevelId ?? '').trim() || null,
        enabledSkillIds: [...new Set((newConversation.enabledSkillIds ?? []).map(String))].sort(),
        disabledBuiltinSkillIds: [...new Set((newConversation.disabledBuiltinSkillIds ?? []).map(String))].sort(),
        mcpIds: [...new Set((newConversation.mcpIds ?? []).map(String))].sort(),
        workspace: String(newConversation.workspace ?? '').trim() || null,
      }
    : null
  const normalizedReplyTarget = normalizeGroupDocumentReplyTarget(replyTarget)
  return createHash('sha256').update(JSON.stringify({
    parentMapId,
    parentCardId,
    targetMapId,
    targetRevision,
    groupProjectVersion,
    sourceRevision,
    strategy,
    conversationId: String(conversationId ?? '').trim() || null,
    machineId: String(machineId ?? '').trim() || null,
    instructionType,
    approvalScope,
    approvalEvidence,
    instruction,
    decisionReason,
    ...(normalizedReplyTarget?.mode === 'explicit' ? { replyTarget: normalizedReplyTarget } : {}),
    newConversation: strategy === 'new' ? requestedConversation : null,
  })).digest('hex')
}

export function buildGroupDocumentInstruction({
  groupId,
  parentMapId,
  targetMapId,
  targetCardId,
  targetRevision,
  groupProjectVersion,
  instructionId,
  parentConversationId,
  replyTarget,
  instructionType,
  approvalScope,
  approvalEvidence,
  instruction,
  editorId,
  attributionToken,
  documentCoordinatorInstruction,
}) {
  const defaultReplyConversationId = String(parentConversationId ?? '').trim()
  const explicitReplyConversationId = replyTarget?.mode === 'explicit'
    ? String(replyTarget.explicitConversationId ?? replyTarget.conversationId ?? '').trim()
    : ''
  const effectiveReplyConversationId = explicitReplyConversationId || defaultReplyConversationId
  const explicitReplyEvidence = replyTarget?.mode === 'explicit'
    ? String(replyTarget.evidence ?? '').trim()
    : ''
  const scopeInstruction = approvalScope === 'analysis-only'
    ? '이 지시는 읽기 전용 분석·제안 범위입니다. 카드·관계·코드·Prefab을 변경하거나 하위 AI에 구현을 위임하지 마세요.'
    : approvalScope === 'card-maintenance'
      ? '승인된 카드 정비 범위만 수행하고 구현이나 구현 위임으로 확대하지 마세요.'
      : approvalScope === 'implementation'
        ? '승인된 구현 범위는 문서 내부의 실제 하위 업무 카드에 AI 위임하고, 문서 루트 AI가 코드·Prefab을 직접 수정하지 마세요.'
        : '승인된 검증 범위만 수행하고 새로운 구현이나 범위 확대가 필요하면 총괄 AI에 수정안을 반환하세요.'
  return `# MindNProgress 그룹 문서 지시

이 전문은 그룹 총괄 문서 AI가 소속 문서의 루트 카드 AI에 전달한 지시입니다. AI 작업 위임이나 worker 작업공간 배정이 아닙니다. 지시 수신 자체를 업무 완료로 처리하지 말고, 실제 카드와 문서 내부 위임 결과를 기준으로 진행·완료를 판단하세요.

${MNP_CONTEXT_BOOTSTRAP_INSTRUCTION}

그런 다음 \`mindnprogress_get_group_context\`로 최신 그룹 기준과 담당 범위를 확인하세요. 이후 그룹 기준이나 승인 범위의 최신성을 다시 확인할 때는 \`mindnprogress_get_context\`가 아니라 \`mindnprogress_get_group_context\`를 사용하세요. \`editorId\`와 \`attributionToken\`은 이후 MindNProgress MCP 작업이 끝날 때까지 유지하세요.

- groupId: \`${groupId}\`
- mapId: \`${targetMapId}\`
- cardId: \`${targetCardId}\`
- editorId: \`${editorId}\`
- attributionToken: \`${attributionToken}\`
- instructionId: \`${instructionId}\`
- 발신 총괄 문서: \`${parentMapId}\`
- 그룹 기준 버전: \`${groupProjectVersion}\`
- 대상 문서 버전: \`${targetRevision}\`
- 지시 유형: \`${instructionType}\`
- 승인 범위: \`${approvalScope}\`

## 완료 보고 라우팅

- 기본 회신 대상: \`${defaultReplyConversationId}\`
- 현재 지시의 명시적 대체 대상: ${explicitReplyConversationId ? `\`${explicitReplyConversationId}\`` : '없음'}
${explicitReplyEvidence ? `- 대체 근거: ${explicitReplyEvidence}\n` : ''}- 전달 시점의 유효 회신 대상: \`${effectiveReplyConversationId}\`

회신 대상을 대화 이력에서 추정하지 마세요. 과거 그룹 지시, 과거 \`AION_SESSION_MESSAGE\`, 이전 \`reply_to\`와 AI의 기억은 이번 \`instructionId\`의 회신 근거가 아닙니다.
완료 보고 대상은 ① 이 지시 이후 사용자가 이 \`instructionId\`에 대해 명시한 대상, ② 위 명시적 대체 대상, ③ 기본 회신 대상 순서로 결정하세요. 사용자가 다른 세션을 말했지만 정확한 대상을 확인할 수 없으면 임의로 선택하지 말고 확인을 요청하세요.
최종 보고 직전에 현재 \`instructionId\`, 결정 근거와 유효 회신 대상을 다시 확인하고, 완료 보고에 \`instructionId\`를 포함하세요. \`waiting-workspace\` 같은 접수·대기 응답은 최종 완료 보고가 아닙니다. 하위 위임 완료 후 자동 재개된 턴에서도 이 확인을 다시 수행하세요.

${documentCoordinatorInstruction}

## 실행 권한 경계

${scopeInstruction}
총괄 AI가 전달한 확인 가능한 승인 근거는 아래와 같습니다. 같은 승인을 사용자에게 반복해서 요구하지 마세요. 근거와 지시가 서로 맞지 않거나 최신 그룹 기준·담당 범위가 달라졌다면 실행을 확대하지 말고 총괄 AI에 수정안을 보고하세요.

${approvalEvidence.trim()}

## 총괄 AI 지시

${instruction.trim()}`
}

export function groupDocumentInstructionPublicView(instruction, { includeContent = false } = {}) {
  const value = { ...instruction }
  if (includeContent) {
    value.instruction ??= value.pendingInstruction
    value.approvalEvidence ??= value.pendingApprovalEvidence
  }
  delete value.requestSignature
  delete value.pendingSelection
  delete value.pendingInstruction
  delete value.pendingApprovalEvidence
  if (!includeContent) {
    delete value.instruction
    delete value.approvalEvidence
    delete value.response
  }
  return value
}

export function groupDocumentInstructionResponseBody(statusCode, reasonCode, message, payload = {}) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    reasonCode: String(reasonCode ?? '').trim(),
    message: String(message ?? '').trim(),
    ...payload,
  }
}
