import { aiConversationLinksFromData, primaryAiConversationIdFromData } from '../../src/utils/aiConversations.mjs'
import { aiDelegationResumeModelMatches } from './aiDelegationPolicy.mjs'

// 모델이 다를 때만 후보를 최신순으로 확인한다. 실행 중인 일치 대화도 유지하며 전달은 대기열이 맡는다.
// 조회 실패를 일치 모델 없음으로 취급하면 중복 대화가 생기므로 실패는 호출자에게 그대로 전달한다.
export async function resolvePrimaryConversationPolicy(data, rule, readModel) {
  const primaryConversationId = primaryAiConversationIdFromData(data)
  const links = aiConversationLinksFromData(data)
  const primary = links.find((link) => link.conversationId === primaryConversationId)
  if (!primary || !rule) return null
  const currentModelId = await readModel(primary)
  if (aiDelegationResumeModelMatches(rule, currentModelId) === true) return null
  for (const candidate of [...links].reverse()) {
    if (candidate.conversationId === primaryConversationId) continue
    const modelId = await readModel(candidate)
    if (aiDelegationResumeModelMatches(rule, modelId) === true) return {
      previousConversationId: primaryConversationId, conversationId: candidate.conversationId,
      currentModelId, expectedModelId: rule.modelId, strategy: 'resume',
    }
  }
  return { previousConversationId: primaryConversationId, conversationId: null, currentModelId, expectedModelId: rule.modelId, strategy: 'new' }
}

const delegationPrimaryError = (reasonCode, message) => Object.assign(new Error(message), { status: 409, reasonCode })

export async function resolveAiDelegationPrimary(data, rule, readModel, request) {
  const expectedConversationId = primaryAiConversationIdFromData(data)
  const links = aiConversationLinksFromData(data)
  if (links.length && !links.some((link) => link.conversationId === expectedConversationId)) {
    throw delegationPrimaryError('AI_DELEGATION_PRIMARY_REQUIRED', '담당 대화가 없습니다. AI 대화 선택 목록에서 담당을 체크해 주세요.')
  }
  const resolution = await resolvePrimaryConversationPolicy(data, rule, readModel)
  const conversationId = resolution ? resolution.conversationId : expectedConversationId
  return { expectedConversationId, modelId: rule.modelId,
    requestedStrategy: request.strategy, requestedConversationId: request.conversationId,
    strategy: conversationId ? 'resume' : 'new', conversationId,
    ...(resolution ? { resolution } : {}) }
}

export function assertAiDelegationPrimaryUnchanged(data, selection) {
  if (selection && primaryAiConversationIdFromData(data) !== selection.expectedConversationId) {
    throw delegationPrimaryError('AI_DELEGATION_PRIMARY_CHANGED', '위임 준비 중 담당 대화가 변경되었습니다. 최신 담당과 위임 규칙으로 다시 요청해 주세요.')
  }
}

// 담당 선택과 새 대화 생성을 분리하여 보조 대화로 지시가 임의 전달되지 않도록 한다.
export function resolveGroupInstructionConversation(data, { strategy, conversationId = '', targetConversationRole = 'primary', overrideEvidence }) {
  const links = aiConversationLinksFromData(data)
  const primaryConversationId = primaryAiConversationIdFromData(data)
  const fail = (code, message) => ({ valid: false, reasonCode: `GROUP_DOCUMENT_INSTRUCTION_${code}`, message, primaryConversationId })
  if (!['primary', 'auxiliary'].includes(targetConversationRole)) return fail('CONVERSATION_ROLE_INVALID', '대화 역할은 primary 또는 auxiliary여야 합니다.')
  if (targetConversationRole === 'auxiliary') {
    if (!String(overrideEvidence ?? '').trim()) return fail('AUXILIARY_APPROVAL_REQUIRED', '보조 대화에 지시하려면 이번 보조 AI 사용을 지정한 사용자 요청을 aiPolicyOverride.evidence에 전달하세요.')
    if (strategy === 'resume' && !links.some((link) => link.conversationId === conversationId)) return fail('CONVERSATION_INVALID', '보조 대화는 대상 카드에 연결된 conversationId를 지정해야 합니다.')
    return { valid: true, conversationId, primaryConversationId }
  }
  if (strategy === 'new') {
    if (links.length) return fail('PRIMARY_CONVERSATION_EXISTS', '이미 연결된 대화가 있습니다. AI 대화 선택에서 담당을 선택하거나 명시적인 인계 도구로 담당을 교체하세요. 새 보조 대화를 자동 생성하지 않습니다.')
    return { valid: true, conversationId: '', primaryConversationId: null }
  }
  if (!primaryConversationId || !links.some((link) => link.conversationId === primaryConversationId)) return fail('PRIMARY_CONVERSATION_REQUIRED', '담당 대화가 없습니다. AI 대화 선택 목록에서 담당 대화를 체크해 주세요.')
  if (conversationId && conversationId !== primaryConversationId) return fail('PRIMARY_CONVERSATION_MISMATCH', '지정한 대화는 현재 담당이 아닙니다. primaryConversationId의 담당 대화를 사용하거나 AI 대화 선택에서 담당을 변경해 주세요.')
  return { valid: true, conversationId: primaryConversationId, primaryConversationId }
}
