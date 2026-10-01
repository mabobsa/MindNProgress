export const MNP_CONTEXT_BOOTSTRAP_INSTRUCTION = `# 대화 문맥 초기화

대화를 시작한 뒤 다른 MindNProgress 도구보다 먼저 \`mindnprogress_get_context\`를 한 번 성공적으로 호출하세요.

이 최초 성공 호출은 현재 대화의 편집자·AI 귀속, 시작 문서·카드와 제품 규칙을 바인딩하고 호출 시점의 초기 스냅샷을 확인하기 위한 것입니다.

사용자 중지, 취소, 시간 초과 또는 연결 종료로 응답을 받지 못한 시도는 성공 호출로 보지 말고 같은 대화에서 다시 호출하세요.

성공 응답을 받은 뒤에는 최신 상태 갱신만을 목적으로 \`mindnprogress_get_context\`를 반복 호출하지 마세요. 이후에는 응답의 \`guide.contextLifecycle\`에 따라 대상별 조회 도구를 사용하세요.`

export const MNP_MCP_SERVER_INSTRUCTIONS = `MindNProgress는 문서·카드와 AI 작업을 관리하는 서비스입니다.

문서와 카드가 지정되지 않은 대화는 \`mindnprogress_read_me_first\`를, 선택 문맥에서 시작한 대화는 다른 MindNProgress 작업보다 먼저 \`mindnprogress_get_context\`를 호출하세요. 새 호출에서는 \`cardId\` 계열 인자를 사용하고 ID·역할·자료·작업공간을 추측하지 마세요.

AionUi 대화의 AI 종류와 모델은 \`get_context\`가 확인하므로 임의로 채우지 마세요. 외부 MCP 세션은 두 값을 정확히 알 때만 함께 전달하세요.

상세 제품 규칙과 다음 행동은 조회 결과의 \`guide\`와 \`nextStep\`, 도구 호출 결과의 \`reasonCode\`와 \`message\`를 따르세요. 그룹 총괄은 \`mindnprogress_get_group_context\`의 승인 정책을 확인하고, 문서 담당·하위 AI는 사용자 요청 또는 전달받은 범위를 확대하지 마세요. 작업공간 목록이 필요하면 \`mindnprogress_get_ai_workspace_pool\`을 사용하고 임의로 worker를 선택하지 마세요. 변경 후에는 대상별 조회 도구로 실제 저장 결과를 확인하세요.`

export const MNP_CONTEXT_LIFECYCLE = Object.freeze({
  bootstrap: Object.freeze({
    tool: 'mindnprogress_get_context',
    successRequired: true,
    purpose: Object.freeze([
      '대화·편집자·AI 귀속 바인딩',
      '시작 문서·카드 확인',
      '제품 규칙 확인',
      '호출 시점의 초기 스냅샷 확보',
    ]),
  }),
  unsuccessfulAttempt: Object.freeze({
    retryAllowed: true,
    cases: Object.freeze([
      '사용자 중지',
      '취소',
      '시간 초과',
      '연결 종료',
      '응답을 받지 못함',
    ]),
  }),
  snapshot: 'get_context 응답은 호출 시점의 스냅샷이며 이후 데이터 변경을 자동 반영하지 않습니다.',
  refresh: Object.freeze({
    repeatGetContext: false,
    card: 'mindnprogress_get_card',
    document: 'mindnprogress_get_document',
    group: 'mindnprogress_get_group_context',
    aiWorkState: 'mindnprogress_get_ai_work_states',
    comments: 'mindnprogress_list_comments',
    rule: '최신 상태가 필요하면 get_context를 반복하지 않고 변경 대상에 맞는 조회 도구를 사용합니다.',
  }),
  staleWrite: Object.freeze({
    action: 'version 또는 SHA-256 불일치가 발생하면 저장하지 말고 충돌한 대상만 다시 조회해 판단을 갱신합니다.',
  }),
  verification: Object.freeze({
    action: '변경 후에는 변경 응답 또는 대상별 조회 도구로 실제 저장 결과를 확인합니다.',
  }),
})
