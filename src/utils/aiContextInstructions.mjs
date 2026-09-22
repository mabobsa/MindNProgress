export const MNP_CONTEXT_BOOTSTRAP_INSTRUCTION = `# 대화 문맥 초기화

진입 상태는 \`selected\`입니다. 전달된 \`mapId\`와 \`cardId\`로 다른 MindNProgress 도구보다 먼저 \`mindnprogress_get_context\`를 한 번 성공적으로 호출하세요. 응답을 받지 못한 시도만 다시 호출할 수 있습니다. 성공 뒤에는 \`guide.contextLifecycle\`의 대상별 조회 도구로 최신 상태를 확인하고 \`get_context\`를 반복하지 마세요.`

export const MNP_MCP_SERVER_INSTRUCTIONS = `MindNProgress는 문서·카드와 AI 작업을 관리합니다.

첫 조회는 진입 상태에 따라 하나만 선택하세요.
- \`approval-first\`: 전달된 \`responseId\`와 \`proposalRevision\`으로 \`mindnprogress_get_dooray_response_approval\`
- \`selected\`: 전달된 \`mapId\`와 \`cardId\`로 \`mindnprogress_get_context\`
- \`unselected\`: \`mindnprogress_read_me_first\`

첫 조회의 오류는 \`reasonCode\`와 \`message\`를 우선 따르고, 응답이 없었던 시도만 재시도하세요. ID·역할·자료·권한·작업공간과 AI 종류·모델을 추측하지 말고 사용자 요청이나 전달 범위를 확대하지 마세요. 전용 workflow의 승인·읽기 전용·쓰기 금지 조건은 일반 \`guide\`와 \`nextStep\`보다 우선합니다.`

export const MNP_CONTEXT_LIFECYCLE = Object.freeze({
  binding: Object.freeze({
    state: 'bound',
    snapshot: '현재 응답은 호출 시점의 스냅샷이며 이후 변경을 자동 반영하지 않습니다.',
  }),
  refresh: Object.freeze({
    repeatGetContext: false,
    card: 'mindnprogress_get_card',
    document: 'mindnprogress_get_document',
    group: 'mindnprogress_get_group_context',
    comments: 'mindnprogress_list_comments',
    aiWorkState: 'mindnprogress_get_ai_work_states',
    rule: '최신 상태는 대상별 조회 도구로 확인하며 mindnprogress_get_context를 반복하지 않습니다.',
  }),
  writeSafety: Object.freeze({
    before: '쓰기 전에 최신 version 또는 SHA-256과 선택 카드 밖 관련 카드의 AI 작업 상태를 확인합니다.',
    stale: '불일치하면 저장하지 않고 충돌 대상만 다시 조회합니다.',
    verify: '변경 응답 또는 변경 대상 조회 도구로 실제 저장 결과를 확인합니다.',
  }),
})

export const MNP_RECORDING_POLICY = Object.freeze({
  allowed: '의미 있는 진행·차단·결과만 [진행]·[차단]·[결과] summary와 검증 가능한 detail 댓글로 남기고, 후속 카드가 재사용할 확정 결론만 sharedKnowledge에 요약합니다.',
  forbidden: '읽기 전용 workflow에서는 대화로만 결과를 반환하고 카드·댓글·sharedKnowledge·상태를 변경하지 않습니다.',
})

export const MNP_WORKFLOW_POLICIES = Object.freeze({
  normal: Object.freeze({ workflow: 'card-work', writePolicy: 'allowed', instruction: '사용자 요청 또는 위임 범위의 카드 작업과 기록을 허용합니다.' }),
  approvalRequired: Object.freeze({ workflow: 'group-coordination', writePolicy: 'approval-required', instruction: '최신 그룹 승인 범위를 확인하고, 미승인 분석·제안은 대화로만 반환합니다.' }),
  proposalOnly: Object.freeze({ workflow: 'proposal-only', writePolicy: 'forbidden', instruction: '승인 화면에 반환할 제안만 작성하고 원본 카드와 기록을 변경하지 않습니다.' }),
  reconstruction: Object.freeze({ workflow: 'reconstruction', writePolicy: 'forbidden', instruction: '전용 요청의 제안함만 사용할 수 있으며 원본 문서·카드·기록을 변경하지 않습니다.' }),
  layout: Object.freeze({ workflow: 'layout', writePolicy: 'forbidden', instruction: '배치 제안함만 사용할 수 있으며 카드·계층·좌표와 원본 기록을 직접 변경하지 않습니다.' }),
  doorayProposal: Object.freeze({ workflow: 'dooray-proposal', writePolicy: 'forbidden', instruction: '읽기 전용 제안만 반환하고 MnP·Dooray 원본을 변경하지 않습니다.' }),
})

export const MNP_CONTEXT_NEXT_STEP = '`selection.taskLinks.startupInspection`을 따른 뒤 사용자 요청 또는 위임 범위의 작업을 수행하세요. 기록 가능 여부는 `selection.workflow.writePolicy`, 기록 형식은 `guide.recordingPolicy`, 저장 확인은 `guide.contextLifecycle.writeSafety`를 따르세요.'

export const MNP_ROLE_POINTERS = Object.freeze({
  group: '역할: group coordinator. mindnprogress_get_group_context의 현재 역할 guide에서 최신 승인·소유권 정책을 확인하세요.',
  document: '역할: document coordinator. mindnprogress_get_group_context의 guide.documentCoordinator를 사용하고 구현은 자기 문서의 실제 하위 업무에 위임하세요.',
  worker: '역할: delegated worker. 상위 AI가 맡긴 카드 범위와 직접 연결된 지식만 사용하세요.',
})
