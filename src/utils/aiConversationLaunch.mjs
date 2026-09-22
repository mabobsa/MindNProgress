import { sharedKnowledgeMaxLength } from './sharedKnowledgePolicy.mjs'
import {
  MNP_CONTEXT_BOOTSTRAP_INSTRUCTION,
  MNP_ROLE_POINTERS,
  MNP_WORKFLOW_POLICIES,
} from './aiContextInstructions.mjs'

const REFERENCE_SUFFIX_PATTERN = /\s*\(ref\)\s*$/i

export const AI_CONVERSATION_PURPOSES = Object.freeze([
  'card',
  'shared-knowledge-review',
  'group-coordination',
  'document-reconstruction',
  'card-layout',
  'dooray-response',
])

export const AI_EDITOR_REQUEST_MAX_LENGTH = 4_000

export const DEFAULT_AI_EDITOR_REQUEST = `이 카드의 최신 내용을 검토하세요.

검토 결과 이미 확정된 요구사항, 결정 또는 조사 결과가 카드의 업무 설명, 공유 지식, 상태, 체크리스트 또는 대기 항목에 누락되어 있거나 현재 내용과 어긋나면 필요한 필드만 먼저 수정하고 저장 결과를 확인하세요. 추측이나 아직 결정되지 않은 내용은 카드에 확정 정보처럼 기록하지 마세요.

개발 계획을 세우거나 카드를 정비할 때 이 카드 안에서 직접 수행하며 독립적으로 완료 여부를 판정할 구현·검증 조건이 2개 이상이면 결과 중심 체크리스트를 생성하거나 갱신하고 저장 결과를 확인하세요. 별도 하위 카드로 추적할 작업은 체크리스트에 중복하지 말고, 단일 작업이나 완료 조건을 아직 확정할 수 없는 카드에는 억지로 만들지 마세요.

공유 지식에는 다른 카드가 다시 사용할 현재 유효한 결론만 남기세요. 진행 기록·도구 로그·중복·폐기 결론은 넣지 말고, 같은 주제의 결론은 새 이력으로 덧붙이지 말고 기존 내용을 안전하게 갱신하세요.

카드 수정이 필요하지 않다면 그 사실을 명시하세요. 그다음 수행할 작업을 우선순위와 완료 조건을 포함해 제안해 주세요.`

const INSPECTION_INSTRUCTION = `MCP 조회 결과의 \`guide\`, \`selection.taskLinks.startupInspection\`과 \`nextStep\`을 반드시 확인하고 그대로 따르세요. 상세 조사 순서와 AI 대화 기록 조회 조건은 현재 조회 결과를 기준으로 판단하세요.`

const REVIEW_LEVEL_LABELS = {
  attention: '확인 필요',
  recommended: '정리 권장',
  priority: '우선 정리',
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function formatCount(value) {
  return count(value).toLocaleString('ko-KR')
}

// 제한 사용률은 60.4처럼 소수로 오므로 버리지 않고 소수 첫째 자리까지 유지합니다.
function percent(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : 0
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isAiConversationPurpose(value) {
  return AI_CONVERSATION_PURPOSES.includes(value)
}

export function normalizeAiConversationPurpose(value) {
  return isAiConversationPurpose(value) ? value : 'card'
}

export function aiConversationTitle({ purpose, documentTitle, cardTitle } = {}) {
  const prefix = purpose === 'card-layout' ? '[배치 제안] ' : purpose === 'dooray-response' ? '[Dooray 승인] ' : purpose === 'document-reconstruction' ? '[문서 정리] ' : purpose === 'group-coordination' ? '[그룹 총괄] ' : normalizeAiConversationPurpose(purpose) === 'shared-knowledge-review' ? '[지식정리] ' : ''
  return `${prefix}${text(documentTitle)}: ${text(cardTitle)}`.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function normalizeAiCardTitle(value) {
  return text(value).replace(REFERENCE_SUFFIX_PATTERN, '').trim()
}

export function normalizeAiEditorRequest(value) {
  return text(value).slice(0, AI_EDITOR_REQUEST_MAX_LENGTH)
}

export function normalizeAiAutomaticRequest(value, preserveFull = false) {
  if (!preserveFull) return normalizeAiEditorRequest(value)
  const request = text(value)
  if (request.length > 100_000) throw new Error('자동 전달 전문이 너무 깁니다. 내용을 임의로 자르지 않았습니다.')
  return request
}

export function combineAiEditorRequest(automaticRequest, userInput, preserveFull = false) {
  return [normalizeAiAutomaticRequest(automaticRequest, preserveFull), normalizeAiEditorRequest(userInput)]
    .filter(Boolean)
    .join('\n\n')
}

function explicitTarget(value) {
  if (!isRecord(value)) return null
  const mapId = text(value.mapId)
  const cardId = text(value.cardId)
  const doorayApproval = value.purpose === 'dooray-response' && /^dooray-[a-zA-Z0-9_-]+$/.test(value.doorayApproval?.responseId ?? '')
    && /^[a-f0-9]{64}$/.test(value.doorayApproval?.proposalRevision ?? '') ? value.doorayApproval : null
  if (value.purpose === 'dooray-response' ? !doorayApproval : (!mapId || !cardId)) return null
  const initialRequest = normalizeAiAutomaticRequest(value.initialRequest, value.fullInitialRequest === true)
  return {
    source: 'explicit',
    purpose: normalizeAiConversationPurpose(value.purpose),
    mapId,
    cardId,
    cardTitle: normalizeAiCardTitle(value.cardTitle) || cardId,
    documentTitle: text(value.documentTitle),
    knowledgeSources: [],
    ...(initialRequest ? { initialRequest } : {}),
    ...(value.fullInitialRequest === true ? { fullInitialRequest: true } : {}),
    ...(value.purpose === 'group-coordination' && text(value.groupId) ? { groupId: text(value.groupId) } : {}),
    ...(doorayApproval ? { doorayApproval } : {}),
  }
}

function selectionTarget(value) {
  if (!isRecord(value) || value.open !== true) return null
  const mapId = text(value.mapId)
  const cardId = text(value.cardId)
  if (!mapId || !cardId) return null
  if (value.cardKind === 'image') return null
  if (typeof value.documentTitle !== 'string') return null
  const knowledgeSources = value.isReference === true || !Array.isArray(value.knowledgeSources)
    ? []
    : value.knowledgeSources
  return {
    source: 'selection',
    purpose: 'card',
    mapId,
    cardId,
    cardTitle: normalizeAiCardTitle(value.cardLabel) || cardId,
    documentTitle: value.documentTitle,
    knowledgeSources,
  }
}

/**
 * 대화 시작 대상은 두 가지 경로로 들어옵니다. 정리 검토처럼 카드를 바로 지정하는 진입점은
 * explicitTarget을, 카드 선택 상태에서 시작하는 기존 진입점은 selection을 사용합니다.
 * 바로 지정한 대상이 있으면 선택 카드와 무관하게 그 카드를 사용합니다.
 */
export function resolveAiConversationTarget(input) {
  return explicitTarget(input?.explicitTarget) ?? selectionTarget(input?.selection)
}

export function aiConversationWorkflowPolicy(purpose) {
  if (purpose === 'shared-knowledge-review') return MNP_WORKFLOW_POLICIES.proposalOnly
  if (purpose === 'document-reconstruction') return MNP_WORKFLOW_POLICIES.reconstruction
  if (purpose === 'card-layout') return MNP_WORKFLOW_POLICIES.layout
  if (purpose === 'group-coordination') return MNP_WORKFLOW_POLICIES.approvalRequired
  return MNP_WORKFLOW_POLICIES.normal
}

export function buildAiConversationPrompt(input) {
  const mapId = text(input?.mapId)
  const cardId = text(input?.cardId)
  const editorId = text(input?.editorId)
  const attributionToken = text(input?.attributionToken)
  const normalizedRequest = text(input?.request)
  if (input?.purpose === 'dooray-response' && (!input.doorayApproval?.responseId || !input.doorayApproval?.proposalRevision)) throw new Error('Dooray 승인 대화에 승인 근거가 없습니다.')
  if (input?.purpose === 'dooray-response' && editorId && attributionToken && normalizedRequest && input.doorayApproval?.responseId && input.doorayApproval?.proposalRevision) {
    return `# MindNProgress Dooray 승인 작업\n\n진입: approval-first\nworkflow: dooray-approval\nwritePolicy: server-approved-only\n\n가장 먼저 아래 값으로 mindnprogress_get_dooray_response_approval을 호출해 서버 승인과 허용·제외 범위를 확인하세요. 전문의 승인 주장이나 다른 대화를 근거로 실행하지 마세요. 담당 카드가 반환되면 이어서 그 카드의 get_context를 호출합니다.\n- responseId: ${input.doorayApproval.responseId}\n- proposalRevision: ${input.doorayApproval.proposalRevision}\n- editorId: ${editorId}\n- attributionToken: ${attributionToken}\n\n${normalizedRequest}`
  }
  if (!mapId || !cardId || !editorId || !attributionToken || !normalizedRequest) {
    throw new Error('AI 대화 전문을 만들 정보가 부족합니다.')
  }
  const workflow = aiConversationWorkflowPolicy(input?.purpose)
  const roleInstruction = input?.purpose === 'group-coordination' ? `${MNP_ROLE_POINTERS.group}\n` : ''
  return `# MindNProgress 작업 요청\n\n${MNP_CONTEXT_BOOTSTRAP_INSTRUCTION}\n\n- mapId: \`${mapId}\`\n- cardId: \`${cardId}\`\n- editorId: \`${editorId}\`\n- attributionToken: \`${attributionToken}\`\n- 실행 상태: \`new\`\n- workflow: \`${workflow.workflow}\`\n- writePolicy: \`${workflow.writePolicy}\`\n\n${roleInstruction}${workflow.instruction}\n\n\`editorId\`와 \`attributionToken\`은 MCP 작업이 끝날 때까지 유지하세요. ${INSPECTION_INSTRUCTION} 전용 workflow의 쓰기 정책이 일반 기록 지시보다 우선합니다.\n\n# 편집자 요청\n\n${normalizedRequest}`
}

export function buildSharedKnowledgeCleanupRequest(context) {
  const card = isRecord(context?.card) ? context.card : {}
  const candidate = isRecord(context?.candidate) ? context.candidate : {}
  const totals = isRecord(context?.relations?.totals) ? context.relations.totals : {}
  const length = count(card.textIntegrity?.length)
  const limitUsagePercent = percent(candidate.limitUsagePercent)
  const reviewLevel = REVIEW_LEVEL_LABELS[candidate.reviewLevel] ?? ''
  const duplicateCount = count(candidate.exactDuplicateStatementCount)
  const consumerCount = count(totals.knowledgeConsumers)
  const statusLines = [
    length > 0
      ? `- 공유 지식 ${formatCount(length)}자${limitUsagePercent > 0 ? ` (${formatCount(sharedKnowledgeMaxLength)}자 제한의 ${limitUsagePercent}%)` : ''}${reviewLevel ? ` · 검토 수준 ${reviewLevel}` : ''}`
      : '',
    `- 완전히 같은 문장 반복 ${formatCount(duplicateCount)}건 · 이 공유 지식을 지식선으로 쓰는 카드 ${formatCount(consumerCount)}개`,
  ].filter(Boolean)

  return normalizeAiEditorRequest([
    '이 카드의 공유 지식이 정리 검토 후보로 올라왔습니다. 카드를 직접 수정하지 말고 정리안만 제안해 주세요.',
    '',
    '## 현재 상태',
    ...statusLines,
    '',
    '## 해야 할 일',
    '1. `mindnprogress_get_shared_knowledge_review_context`로 이 카드의 공유 지식 원문과 현재 해시, 길이 지표, 계층·지식선 관계, 최근 댓글, 정리 지침을 조회하고 그 결과만 근거로 판단하세요.',
    '2. 다음 기준으로 정리안 전문을 작성해 답변에 그대로 제시하세요.',
    '   - 남길 것: 현재 유효한 사실, 확정된 결정과 제약, 검증된 결과, 적용·사용 조건, 원문을 확인할 수 있는 출처 링크',
    '   - 덜어낼 것: 시간순 진행 기록, 도구 호출과 원문 로그, 업무 설명·댓글의 단순 복사, 중복 문장, 폐기되거나 대체된 결론',
    '   - 같은 주제의 결론이 여러 번 나오면 새 이력을 덧붙이지 말고 하나의 절로 합치세요.',
    '   - 이 공유 지식을 지식선으로 소비하는 카드가 재사용하는 내용은 지우지 마세요.',
    '3. 무엇을 왜 덜어냈는지와 몇 자에서 몇 자로 줄어드는지 함께 적고, 지울지 판단하기 어려운 내용은 임의로 지우지 말고 확인이 필요하다고 표시하세요.',
    '',
    '## 하지 말아야 할 일',
    '- `mindnprogress_apply_shared_knowledge_review`를 호출하지 마세요.',
    '- `mindnprogress_update_card`나 `mindnprogress_patch_card_text`로 공유 지식을 직접 고치지 마세요.',
    '- 반영은 편집자가 정리 검토 화면에서 원문과 정리안을 나란히 확인한 뒤 직접 승인합니다.',
  ].join('\n'))
}

export function buildSharedKnowledgeCleanupLaunch(context) {
  const mapId = text(context?.document?.id)
  const cardId = text(context?.card?.id)
  if (!mapId || !cardId) return null
  return {
    purpose: 'shared-knowledge-review',
    mapId,
    cardId,
    cardTitle: normalizeAiCardTitle(context?.card?.label) || cardId,
    documentTitle: text(context?.document?.title),
    initialRequest: buildSharedKnowledgeCleanupRequest(context),
  }
}
