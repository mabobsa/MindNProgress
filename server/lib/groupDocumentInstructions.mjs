import { createHash } from 'node:crypto'

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
  strategy = 'resume',
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

실행 상태: ${strategy === 'new' ? 'new' : 'resume'}
역할: document coordinator
이 지시는 그룹 문서 루트 조정이며 worker 위임이나 작업공간 배정이 아닙니다. 수신·대기 응답을 완료로 보지 말고 실제 카드와 하위 위임 결과를 확인하세요.

${strategy === 'new'
    ? '아직 바인딩되지 않았다면 아래 대상으로 get_context를 한 번 성공한 뒤 get_group_context를 조회하세요.'
    : '이미 바인딩된 대화이므로 get_context를 반복하지 말고 get_group_context와 대상별 조회로 최신 상태를 확인하세요.'}
역할 원문은 get_group_context의 guide.documentCoordinator 한 곳에서 사용합니다. editorId와 attributionToken은 끝까지 유지하세요.

- groupId: \`${groupId}\`
- mapId/cardId: \`${targetMapId}\` / \`${targetCardId}\`
- editorId/attributionToken: \`${editorId}\` / \`${attributionToken}\`
- instructionId: \`${instructionId}\`
- 발신 문서: \`${parentMapId}\`
- 그룹/대상 버전: \`${groupProjectVersion}\` / \`${targetRevision}\`
- 유형/승인 범위: \`${instructionType}\` / \`${approvalScope}\`

## 권한

${scopeInstruction}
아래 승인 근거를 다시 요구하지 마세요. 근거·지시와 최신 그룹 기준이 다르면 범위를 늘리지 말고 총괄에 수정안을 보고하세요.

${approvalEvidence.trim()}

## 완료 보고

- 기본 대상: \`${defaultReplyConversationId}\`
- 명시적 대체: ${explicitReplyConversationId ? `\`${explicitReplyConversationId}\`` : '없음'}
${explicitReplyEvidence ? `- 대체 근거: ${explicitReplyEvidence}\n` : ''}- 현재 유효 대상: \`${effectiveReplyConversationId}\`

이 instructionId 이후 사용자의 명시적 지정, 위 대체 대상, 기본 대상 순으로 결정하세요. 과거 지시·AION_SESSION_MESSAGE·reply_to·기억으로 추정하지 마세요. 최종 보고 직전에 instructionId와 대상을 다시 확인하고 보고에 instructionId를 포함하세요.

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
