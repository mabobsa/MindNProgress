import { blockedAiModelLabels } from '../server/lib/aiModelPolicy.mjs'

export const AI_CONVERSATION_SELECTION_INSTRUCTION = '기존 대화 선택 전 mindnprogress_list_ai_conversations로 후보별 contextHealth와 실행 상태를 확인하세요. 같은 카드의 연속 작업·검수는 관련 기존 대화를 우선하며, 첫 번째나 최신 대화만 고정 선택하지 마세요. 독립 검수는 구현자와 검수자의 분리이며 매번 새 대화를 뜻하지 않습니다. 입력 파일·구현 담당자·검수 단계 변경만으로 새 대화를 만들지 마세요. 포화·상태 확인 불가·금지 모델·호환 불가·역할 충돌 또는 의도적인 별도 관점 검수는 새 대화가 필요합니다. caution은 정확히 이어지는 작은 후속 작업에 한해 최신 평가를 확인하고 예외적으로 이어가세요.'

export function aiConversationSelectionRules() {
  return {
    exclude: `available=false이거나 contextHealth.resumeAllowed=false인 대화는 일반 위임의 이어가기 후보에서 제외하세요. ${blockedAiModelLabels()}로 기록되었거나 현재 그 모델을 사용하는 대화도 새 위임에 이어 쓰지 않습니다. runtime.state가 idle이 아닌 대화에는 지금 이어가기를 요청하지 마세요.`,
    candidateSelection: '목록은 최신순이지만 첫 번째나 최신 대화만 고정 선택하지 마세요. 후보별 requestPreview와 위임 기록으로 현재 작업·검수 대상·이전 결함과 관련된 대화를 먼저 찾고, 관련 후보가 여러 개이면 업무 연속성과 현재 문맥 건강도를 비교하세요. 선택한 conversationId의 contextHealth와 assessmentId를 사용하며 다른 대화의 평가를 적용하지 마세요. 메타데이터만으로 관련성이 불명확하면 필요한 후보의 전문만 조회하세요.',
    preferResume: 'contextHealth.resumeAllowed=true이고 현재 지시가 같은 업무 흐름의 후속 작업이며 실행 환경(agent, model, mode, MCP)이 호환되는 idle 대화는 contextHealth.state가 healthy이면 이어가세요. unverified는 문맥 사용량 또는 전체 크기가 없어 포화 여부를 판정할 수 없는 상태입니다. 전체 이력을 조회한 짧은 대화는 턴 ID 누락만으로 새 대화를 선택하지 마세요. 실제 업무 연속성과 확인 가능한 사용량을 살펴 같은 흐름의 후속 작업에 한해서만 경고를 인지한 채 이어가기를 시도할 수 있습니다. 같은 카드의 연속 검수·수정분 재검수도 이 원칙을 따릅니다. 입력 파일·구현 담당자·검수 단계가 바뀌었다는 사실만으로 새 대화를 선택하지 마세요. workspaceBinding=fixed이면 workspace도 일치해야 합니다. workspaceBinding=pool-rebindable이면 같은 workspacePoolId 안의 worker 경로 차이는 호환되며 MnP가 기존 worker를 우선하되 필요하면 안전하게 재배정합니다. resume에는 선택한 대화의 contextHealth.assessmentId를 전달하세요.',
    reviewIndependence: '독립 검수는 구현자와 검수자의 분리이며 매번 새 대화를 뜻하지 않습니다. 기존 검수 대화가 검수 대상 구현에 참여하지 않았다면 검수 대상이 바뀌어도 독립성은 유지됩니다. 이전 판단·결함·예외 조건을 활용하는 연속 검수는 관련 기존 검수 대화를 우선하세요. 해당 대화가 검수 대상 구현에 참여해 역할이 충돌하거나, 원 검수자와 별도의 관점으로 재검수하도록 요청받은 경우에는 새 검수 대화를 선택하세요.',
    busy: '같은 업무의 대상 대화가 running 또는 waiting-confirmation이면 현재 실행과 관련 위임의 통합이 끝난 뒤 후보 목록을 다시 조회하고 판단하세요. 실행 중이라는 이유만으로 같은 업무의 새 대화를 열거나 새 위임을 자동 예약하지 마세요. 역할 충돌 또는 의도적인 별도 관점 검수는 별도 대화가 필요할 수 있지만 같은 업무의 중복 실행·동시 편집을 허용하는 것은 아닙니다.',
    chooseNew: `관련 후보들을 비교한 결과 contextHealth가 saturated·unknown 또는 resumeAllowed=false이거나 실행 환경 호환 불가·역할 충돌로 재사용 가능한 대화가 없을 때, 관련 대화가 처음부터 없을 때, 의도적인 별도 관점 검수 또는 별개 업무 목적·범위일 때 새 대화를 선택하세요. 한 후보의 포화·금지 모델을 다른 관련 후보에 적용하지 마세요. 관련 대화가 단지 실행 중이면 busy 규칙을 따르고 새 대화로 대체하지 마세요. 같은 카드의 연속 검수에서 입력 파일·구현 담당자·검수 단계 변경만으로 별개 업무라고 판단하지 마세요. ${blockedAiModelLabels()} 대화를 대신할 때는 newConversation에 사용 가능한 다른 모델을 명시하세요. 생략하면 이전 모델을 상속할 수 있습니다. 같은 workspacePoolId 안의 Fork 경로 차이만으로 새 대화를 만들지 마세요. caution은 정확히 이어지는 작은 후속 작업일 때만 평가를 확인하고 예외적으로 이어갈 수 있습니다.`,
    metrics: 'decisionReason에는 검토한 관련 conversationId와 그 대화의 현재 평가, 업무 연속성 또는 실제 새 대화 사유를 기록하세요. 새 대화를 선택했다면 관련 기존 대화를 재사용할 수 없는 이유나 별개 업무·역할 충돌·별도 관점이 필요한 근거를 구체적으로 적고, 독립 검수라는 표현이나 입력 파일·구현 담당자 변경만을 근거로 삼지 마세요. conversationTurnCount는 실행 턴, eventCount는 저장 이벤트, toolCallCount는 도구 호출로 구분하세요. eventCount나 toolCallCount를 메시지 수 또는 실행 턴 수라고 표현하지 마세요. contextSize=null이면 contextUsed를 임의의 퍼센트로 환산하거나 포화·여유라고 단정하지 마세요.',
    recovery: '중단된 동일 위임은 문맥 포화나 모델 재사용 제한과 관계없이 새 위임을 만들지 말고 기존 위임 복구·재개 절차를 사용하세요.',
    inspect: '목록 메타데이터만으로 관련성을 판단하기 어려운 후보에 한해서 mindnprogress_get_ai_conversation_transcript에 conversationId를 지정해 확인하세요.',
  }
}
