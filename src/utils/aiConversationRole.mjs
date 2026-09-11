import { buildGroupCoordinatorRequest } from './aiApprovalInstructions.mjs'
import { DEFAULT_AI_EDITOR_REQUEST, normalizeAiAutomaticRequest, normalizeAiConversationPurpose } from './aiConversationLaunch.mjs'

// 진입 버튼이 아니라 최신 원본 문서와 그룹 설정으로 시작 역할을 결정한다.
export function resolveAiConversationRole(input, context) {
  const purpose = normalizeAiConversationPurpose(input.purpose)
  const fullInitialRequest = input.fullInitialRequest === true
  const automaticRequest = normalizeAiAutomaticRequest(input.initialRequest, fullInitialRequest) || DEFAULT_AI_EDITOR_REQUEST
  const ordinary = { purpose, automaticRequest, fullInitialRequest, groupId: null }
  if (!['card', 'group-coordination'].includes(purpose)) return ordinary

  const map = context?.map
  if (!map || map.id !== input.mapId || map.trashedAt || map.archivedAt
      || !Array.isArray(map.nodes) || !Array.isArray(map.edges)
      || !map.nodes.some((node) => node.id === input.cardId)
      || !Object.hasOwn(context, 'groupProject')) {
    throw new Error('대화 대상 문서와 최신 그룹 역할을 확인하지 못했습니다. 팝업을 다시 열어 주세요.')
  }
  // 서버의 documentRoot와 동일하게 지식선을 제외한 실제 최상위 원본을 판별한다.
  const targets = new Set(map.edges.filter((edge) => edge.data?.relation !== 'knowledge').map((edge) => edge.target))
  const root = map.nodes.find((node) => node.data?.kind === 'root' && !targets.has(node.id))
    ?? map.nodes.find((node) => !targets.has(node.id))
  const project = context.groupProject
  const coordinator = project?.role === 'coordinator' && project.coordinatorMapId === map.id
    && root?.id === input.cardId && !root.data?.reference
  if (purpose === 'group-coordination' && !coordinator) {
    throw new Error('총괄 문서 또는 최상위 루트가 변경되었습니다. 팝업을 닫고 현재 대상에서 다시 시작해 주세요.')
  }
  if (!coordinator) return ordinary
  if (!project.groupId || (input.groupId && input.groupId !== project.groupId)) {
    throw new Error('총괄 문서의 소속 그룹이 변경되었습니다. 팝업을 닫고 다시 시작해 주세요.')
  }
  return {
    purpose: 'group-coordination', groupId: project.groupId, fullInitialRequest: true,
    automaticRequest: purpose === 'group-coordination' && input.initialRequest?.trim()
      ? normalizeAiAutomaticRequest(input.initialRequest, true)
      : normalizeAiAutomaticRequest(buildGroupCoordinatorRequest({
        groupId: project.groupId,
        ...(input.initialRequest?.trim() ? { instruction: normalizeAiAutomaticRequest(input.initialRequest, fullInitialRequest) } : {}),
      }), true),
  }
}

export async function loadAiConversationRole(input, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (!['card', 'group-coordination'].includes(normalizeAiConversationPurpose(input.purpose))) return resolveAiConversationRole(input)
  const response = await fetchImpl(`/api/maps/${encodeURIComponent(input.mapId)}`, {
    credentials: 'include', cache: 'no-store', signal,
  })
  const context = await response.json()
  if (!response.ok) throw new Error(context.error || '대화 대상 문서의 역할을 확인하지 못했습니다.')
  return resolveAiConversationRole(input, context)
}
