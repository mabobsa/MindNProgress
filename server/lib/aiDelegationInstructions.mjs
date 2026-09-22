import { MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, MNP_ROLE_POINTERS } from '../../src/utils/aiContextInstructions.mjs'
import {
  AI_DELEGATION_FOLLOWUP_INSTRUCTION,
  AI_DELEGATION_REPORT_INSTRUCTION,
  GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION,
} from '../../src/utils/aiApprovalInstructions.mjs'
import { buildWorkspaceInstruction } from './workspacePool.mjs'

export function buildDelegatedInstruction({
  mapId,
  cardId,
  editorId,
  attributionToken,
  instruction,
  workspaceLease,
  event = 'new',
  includeCompletion = false,
}) {
  const workspaceInstruction = buildWorkspaceInstruction(workspaceLease)
  const entryInstruction = event === 'new'
    ? MNP_CONTEXT_BOOTSTRAP_INSTRUCTION
    : `실행 상태: ${event}. 이미 바인딩된 대화이므로 get_context를 반복하지 말고 대상별 조회 도구로 최신 카드·문서·AI 작업 상태를 확인하세요.`
  const completionInstruction = includeCompletion
    ? '\n\n사용자가 중지한 같은 위임을 직접 이어 완료하는 턴입니다. 실제 작업·카드 기록·필수 체크포인트를 모두 마친 마지막 턴의 최종 답변 직전에만 `mindnprogress_complete_ai_delegation`을 호출하세요.'
    : ''
  return `# MindNProgress 하위 카드 위임 작업 요청

${entryInstruction}

상위 카드 AI가 실행을 위임했습니다. 제안에 그치지 말고 맡긴 범위를 수행하세요. editorId와 attributionToken은 MCP 작업이 끝날 때까지 유지합니다.

- mapId/cardId: \`${mapId}\` / \`${cardId}\`
- editorId/attributionToken: \`${editorId}\` / \`${attributionToken}\`

guide, selection.taskLinks.startupInspection, selection.aiWorkCoordination, nextStep을 따르세요. 쓰기 전 관련 AI 작업 상태를 확인하고 결과를 댓글과 공유 지식의 용도에 맞게 기록하세요. 분석·제안 범위는 구현으로 확대하지 않습니다. 조회할 수 없는 대상은 추측하지 말고 제약을 보고하세요.

${workspaceInstruction ? `${workspaceInstruction}\n\n` : ''}# 상위 AI 지시

${instruction.trim()}${completionInstruction}`
}

export function delegationRecoveryInstruction(delegation, instruction, recovery = null, conversationDisplayLabel = delegation.targetConversationId) {
  const inspection = delegation.coordinationOnly
    ? `${MNP_ROLE_POINTERS.document}\n그룹 기준·문서 계약·하위 위임·최근 결과를 대조하세요. worker나 lease를 임의로 만들지 마세요.`
    : '먼저 .ai-session.json, 브랜치, Git 변경과 최근 대화·카드 결과를 대조하세요. 다른 작업공간으로 이동하거나 새 lease를 만들지 마세요.'
  const externalLimitRecovery = ['usage-limit', 'rate-limit', 'model-capacity'].includes(recovery?.failureCategory)
  const userStopRecovery = recovery?.failureCategory === 'user-stop'
  const title = recovery?.failureCategory === 'model-capacity'
    ? '모델 실행 용량 확보 후 위임 복구'
    : externalLimitRecovery ? '외부 사용량 제한 해제 후 위임 복구'
      : userStopRecovery ? '사용자 중지 후 위임 재개' : '재시작 후 위임 복구'
  const reason = externalLimitRecovery
    ? `이전 실행은 ${recovery.failureCategory === 'rate-limit' ? '요청 한도' : recovery.failureCategory === 'model-capacity' ? '선택 모델의 실행 용량 부족' : '사용량 한도'}로 중단됐고 사용자가 원인 해소 뒤 같은 대화와 작업공간의 재개를 요청했습니다.`
    : userStopRecovery ? '사용자가 중지했던 기존 위임을 같은 대화에서 다시 이어가도록 요청했습니다.'
      : 'AionCore 또는 MindNProgress 재시작으로 이전 실행의 메모리 상태가 끊겼습니다.'
  const workspaceSummary = delegation.coordinationOnly
    ? '문서 조정 전용 · worker 없음'
    : delegation.workspaceLease ? '아래 할당된 작업공간 전문 1건' : '기존 대화 · worker lease 없음'
  return `# ${title}

실행 상태: recovery
${reason} 원래 지시를 반복하지 말고 미완료 부분만 이어서 수행하세요.

- 위임 ID: ${delegation.id}
- 대상 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- 대상 대화: ${conversationDisplayLabel}
- 작업공간: ${workspaceSummary}

${inspection}
현재 배정 전문만 사용하고 과거 경로·브랜치·lease를 복구 후보로 삼지 마세요. 완료한 변경과 외부 처리는 중복 실행하지 말고 검증과 보고만 하세요. 맡긴 범위 밖 변경은 상위 AI에 보고하며 분석·제안 위임은 계속 읽기 전용입니다.

# 복구 후 수행 지시

${instruction.trim()}`
}

function delegationResultSection(reportResult) {
  if (reportResult.availability === 'captured') return `## 하위 AI의 마지막 응답\n\n${reportResult.text}\n\n`
  if (reportResult.availability === 'integrity-failed') return '## 하위 AI 원문 무결성 오류\n\n저장 결과의 해시 또는 실행 턴이 맞지 않아 원문을 전달하지 않았습니다. 최신 대화 응답으로 대체하지 말고 위임 기록과 원본 대화를 따로 검토하세요.\n\n'
  return '## 하위 AI 원문 미캡처\n\n원문이 위임 기록에 없어 다른 작업이 이어졌을 수 있는 최신 대화 응답으로 대체하지 않았습니다. 아래 작업공간·체크포인트·통합 정보만 확인하세요.\n\n'
}

export function buildParentWakeInstruction({
  delegation,
  reportResult,
  groupCoordinator = false,
  outcome,
  conversationDisplayLabel,
}) {
  const roleInstruction = groupCoordinator
    ? `${MNP_ROLE_POINTERS.group} 승인 원문을 복제하지 말고 최신 그룹 문맥을 사용하세요.\n\n`
    : ''
  const followupInstruction = groupCoordinator
    ? GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION
    : AI_DELEGATION_FOLLOWUP_INSTRUCTION
  const workspaceResult = delegation.workspaceResult
    ? `- 작업공간: ${delegation.workspaceResult.workspaceId ?? delegation.workspaceLease?.workspaceId ?? '미확인'}\n- 체크포인트: ${delegation.workspaceResult.headCommit ?? '변경 없음'}\n- 통합 커밋: ${delegation.workspaceResult.integratedCommit ?? '통합되지 않음'}\n- 작업공간 결과: ${delegation.workspaceResult.status ?? '미확인'}\n`
    : ''
  return `# MindNProgress 하위 AI 작업 결과

실행 상태: parent-wake
위임한 하위 카드 작업이 ${outcome} 상태입니다. 대상 문서: ${delegation.mapId}. 상위 문서: ${delegation.parentMapId ?? delegation.mapId}.

- 위임 ID: ${delegation.id}
- 하위 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- 실행 대화: ${conversationDisplayLabel}
- 하위 실행 턴: ${delegation.childTurnId ?? '미확인'}
- 결과 원문: ${reportResult.availability === 'captured' ? '캡처됨' : reportResult.availability === 'integrity-failed' ? '무결성 오류로 제외됨' : '캡처되지 않음'}
- 선택 방식: ${delegation.strategy === 'resume' ? '기존 대화 이어가기' : '새 대화 시작'}
- 선택 이유: ${delegation.decisionReason}
${workspaceResult}

${roleInstruction}${delegationResultSection(reportResult)}${AI_DELEGATION_REPORT_INSTRUCTION}

${followupInstruction}`
}
