import { sharedKnowledgeMaxLength } from './sharedKnowledgePolicy.mjs'
import { AI_EXECUTION_APPROVAL_INSTRUCTION } from './aiApprovalInstructions.mjs'

const REFERENCE_SUFFIX_PATTERN = /\s*\(ref\)\s*$/i

export const AI_CONVERSATION_PURPOSES = Object.freeze([
  'card',
  'shared-knowledge-review',
  'group-coordination',
  'document-reconstruction',
])

export const AI_EDITOR_REQUEST_MAX_LENGTH = 4_000

export const DEFAULT_AI_EDITOR_REQUEST = `이 카드의 최신 내용을 검토하세요.

먼저 읽기 전용으로 검토하고 필요한 정비와 다음 작업을 제안하세요. 자동 적용된 이 문구 자체는 변경 승인이 아닙니다. 그룹 소속 카드라면 최신 그룹 기준과 전체 방향·문서별 실행 계획의 사용자 승인 범위를 확인하세요.

검토 결과 이미 확정된 요구사항, 결정 또는 조사 결과가 카드의 업무 설명, 공유 지식, 상태, 체크리스트 또는 대기 항목에 누락되어 있거나 현재 내용과 어긋나면 수정안을 제안하세요. 실제 사용자가 승인한 정비 범위에서만 필요한 필드를 수정하고 저장 결과를 확인하세요. 추측이나 아직 결정되지 않은 내용은 카드에 확정 정보처럼 기록하지 마세요.

개발 계획을 세우거나 카드를 정비할 때 이 카드 안에서 직접 수행하며 독립적으로 완료 여부를 판정할 구현·검증 조건이 2개 이상이면 결과 중심 체크리스트를 제안하고, 승인된 정비 범위에서만 생성하거나 갱신하고 저장 결과를 확인하세요. 별도 하위 카드로 추적할 작업은 체크리스트에 중복하지 말고, 단일 작업이나 완료 조건을 아직 확정할 수 없는 카드에는 억지로 만들지 마세요.

승인된 실행 결과를 기록할 때 공유 지식에는 다른 카드가 다시 사용할 현재 유효한 결론만 남기세요. 진행 기록·도구 로그·중복·폐기 결론은 넣지 말고, 같은 주제의 결론은 새 이력으로 덧붙이지 말고 기존 내용을 안전하게 갱신하세요.

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
  const prefix = purpose === 'document-reconstruction' ? '[문서 정리] ' : purpose === 'group-coordination' ? '[그룹 총괄] ' : normalizeAiConversationPurpose(purpose) === 'shared-knowledge-review' ? '[지식정리] ' : ''
  return `${prefix}${text(documentTitle)}: ${text(cardTitle)}`.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function normalizeAiCardTitle(value) {
  return text(value).replace(REFERENCE_SUFFIX_PATTERN, '').trim()
}

export function normalizeAiEditorRequest(value) {
  return text(value).slice(0, AI_EDITOR_REQUEST_MAX_LENGTH)
}

export function combineAiEditorRequest(automaticRequest, userInput) {
  return [normalizeAiEditorRequest(automaticRequest), normalizeAiEditorRequest(userInput)]
    .filter(Boolean)
    .join('\n\n')
}

function explicitTarget(value) {
  if (!isRecord(value)) return null
  const mapId = text(value.mapId)
  const cardId = text(value.cardId)
  if (!mapId || !cardId) return null
  const initialRequest = normalizeAiEditorRequest(value.initialRequest)
  return {
    source: 'explicit',
    purpose: normalizeAiConversationPurpose(value.purpose),
    mapId,
    cardId,
    cardTitle: normalizeAiCardTitle(value.cardTitle) || cardId,
    documentTitle: text(value.documentTitle),
    knowledgeSources: [],
    ...(initialRequest ? { initialRequest } : {}),
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

export function buildAiConversationPrompt(input) {
  const mapId = text(input?.mapId)
  const cardId = text(input?.cardId)
  const editorId = text(input?.editorId)
  const attributionToken = text(input?.attributionToken)
  const normalizedRequest = text(input?.request)
  if (!mapId || !cardId || !editorId || !attributionToken || !normalizedRequest) {
    throw new Error('AI 대화 전문을 만들 정보가 부족합니다.')
  }
  return `# MindNProgress 작업 요청\n\n가장 먼저 MindNProgress MCP 도구 \`mindnprogress_get_context\`를 아래 값으로 한 번 성공적으로 호출하세요. 사용자 중지, 취소, 시간 초과 또는 연결 종료로 응답을 받지 못한 시도는 호출 횟수에 포함하지 말고, 같은 대화를 이어갈 때 다시 호출하세요. 성공 응답을 받은 뒤에는 같은 대화에서 반복 호출하지 마세요. \`editorId\`는 이 대화를 시작한 편집자 계정으로 MindNProgress를 조회하고 수정하기 위한 값이므로 이후 MCP 작업이 끝날 때까지 유지하세요. \`attributionToken\`은 댓글과 변경 이력에 현재 AI 종류와 모델을 정확히 기록하기 위한 보조 값입니다. 이 도구가 MindNProgress의 제품 개념과 작성 규칙, 최신 문서 구조, 선택 카드 정보를 함께 제공합니다. 프롬프트에는 카드 스냅샷이 포함되어 있지 않으므로 반드시 MCP 조회 결과를 기준으로 답변하고 필요한 작업을 수행해야 합니다.\n\n- mapId: \`${mapId}\`\n- cardId: \`${cardId}\`\n- editorId: \`${editorId}\`\n- attributionToken: \`${attributionToken}\`\n\n${AI_EXECUTION_APPROVAL_INSTRUCTION}\n\n${INSPECTION_INSTRUCTION}\n\nMCP 도구를 사용할 수 없거나 해당 문서 또는 카드를 찾지 못하면 임의로 추측하지 말고 그 사실을 알려주세요.\n\n# 편집자 요청\n\n${normalizedRequest}`
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
