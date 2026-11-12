import { aiDelegationIsTerminal } from './aiDelegations.mjs'
import { reconstructionError } from './documentReconstruction.mjs'

const settledInstructions = new Set(['replied', 'expired', 'failed', 'cancelled', 'closed'])

// 개별 보관에만 적용한다. 총괄을 원본으로 삼는 문서 재구성은 계속 금지한다.
export function assertCoordinatorArchiveAllowed({ group, coordinatorMapId, delegations, documentInstructions,
  delegationInFlight = () => false, instructionInFlight = () => false }) {
  if (group.mapIds.some((id) => id !== coordinatorMapId)) {
    throw reconstructionError('그룹에 다른 활성 문서가 있어 총괄 문서를 보관할 수 없습니다. 다른 문서를 먼저 보관하거나 이동해 주세요.', 409, 'RECONSTRUCTION_COORDINATOR')
  }
  const relevant = (item) => item.groupId === group.id
    || [item.mapId, item.parentMapId, item.targetMapId].includes(coordinatorMapId)
  const delegation = [...delegations].find((item) => relevant(item)
    && (!aiDelegationIsTerminal(item) || item.pendingRecovery || delegationInFlight(item.id)))
  if (delegation) {
    throw reconstructionError(`그룹의 AI 위임 또는 복구가 끝나지 않아 총괄 문서를 보관할 수 없습니다: ${delegation.id}`, 409, 'RECONSTRUCTION_AI_BUSY')
  }
  const instruction = [...documentInstructions].find((item) => relevant(item)
    && (!settledInstructions.has(item.state) || instructionInFlight(item.id)))
  if (instruction) {
    throw reconstructionError(`그룹 문서 지시의 전달·회신 처리가 끝나지 않아 총괄 문서를 보관할 수 없습니다: ${instruction.id} (${instruction.state})`, 409, 'RECONSTRUCTION_GROUP_INSTRUCTION_BUSY')
  }
}
