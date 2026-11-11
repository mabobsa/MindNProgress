import { createHash } from 'node:crypto'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// 인계 자체가 추가하는 AI 연결만 제외한다. 업무 내용·계층·그룹 기준 변경은 별도로 재검토한다.
export function rootHandoffDocumentHash(map, cardId) {
  return hash({ title: map.title, edges: map.edges, nodes: map.nodes.map((node) => {
    if (node.id !== cardId) return node
    const data = { ...node.data }
    for (const key of ['aiConversationId', 'aiPrimaryConversationId', 'aiConversations']) delete data[key]
    return { ...node, data }
  }) })
}

export function createRootHandoffPlan(instructionId, map, cardId, predecessorConversationId, selection, policyRevision) {
  const key = hash([instructionId, map.id, cardId, predecessorConversationId, policyRevision])
  return {
    requestId: `root-handoff:${key}`, operationId: `rhp:${key}`,
    predecessorConversationId, documentHash: rootHandoffDocumentHash(map, cardId), policyRevision,
    newConversation: {
      agentId: selection.agent.id, modelId: selection.model.id,
      thoughtLevelId: selection.thoughtLevel.id,
      ...(selection.mode ? { modeId: selection.mode.id } : {}),
      enabledSkillIds: selection.enabledSkillIds, disabledBuiltinSkillIds: selection.disabledBuiltinSkillIds,
      mcpIds: selection.mcpIds, ...(selection.workspace ? { workspace: selection.workspace } : {}),
      ...(selection.claudeAccountId ? { claudeAccountId: selection.claudeAccountId } : {}),
    },
  }
}

export function buildRootHandoffRequest(instruction) {
  const handoff = instruction.rootHandoff
  return `# 위임 규칙 변경에 따른 루트 담당 대화 인계

사용자가 저장한 AI 위임 규칙(${handoff.policyRevision})에 따라 이 루트 카드의 CLI를 전환합니다.
새 업무 지시 ${instruction.id}는 서버 대기열에 보관되어 있습니다. 이번 턴은 인계 준비만 수행하세요.
기존 승인 범위를 넓히거나 새 업무 실행·추가 위임·카드 수정·외부 메시지 전송을 하지 마세요.

1. get_context와 최신 그룹 기준, 기존 위임·완료 보고를 확인하세요.
2. 현재 승인 범위·사용자 결정과 대기 지시·완료 결과와 증거·미완료 사항·회신 대상 및 지시 ID·주의사항을 한국어 인계문으로 작성하세요. 확인하지 못한 사실을 완료로 기록하지 마세요.
3. mindnprogress_start_card_conversation을 다음 값으로 한 번 호출하세요. initialMessage에는 작성한 인계문 원문을 넣고, decisionReason에는 루트 CLI 전환 인계임을 적으세요.
${JSON.stringify({ mapId: instruction.targetMapId, cardId: instruction.targetCardId,
    requestId: handoff.requestId, predecessorConversationId: handoff.predecessorConversationId,
    machineId: instruction.targetHomeMachineId, newConversation: handoff.newConversation }, null, 2)}
approvalEvidence에는 사용자 저장 위임 규칙 ${handoff.policyRevision}과 대기 지시 ${instruction.id}에 따른 자동 인계임을 적으세요. 새로운 사용자 발언을 만들어내지 마세요.
4. 접수 후 이번 응답 턴을 마치세요. 후속 대화의 인수 확인·실행 설정 확인·담당 전환과 대기 업무 전달은 서버가 처리합니다. 원래 대화를 종료하거나 삭제하지 마세요.
`
}
