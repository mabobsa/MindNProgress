import assert from 'node:assert/strict'
import test from 'node:test'
import { AI_CONVERSATION_SELECTION_INSTRUCTION, aiConversationSelectionRules } from '../mcp/aiConversationSelectionPolicy.mjs'
import { blockedAiModelLabels } from '../server/lib/aiModelPolicy.mjs'

test('초기 안내도 같은 카드의 연속 검수 재사용과 독립성 구분을 전달한다', () => {
  assert.match(AI_CONVERSATION_SELECTION_INSTRUCTION, /같은 카드의 연속 작업·검수는 관련 기존 대화를 우선/)
  assert.match(AI_CONVERSATION_SELECTION_INSTRUCTION, /독립 검수는 구현자와 검수자의 분리이며 매번 새 대화를 뜻하지 않습니다/)
  assert.match(AI_CONVERSATION_SELECTION_INSTRUCTION, /입력 파일·구현 담당자·검수 단계 변경만으로 새 대화를 만들지 마세요/)
  assert.match(AI_CONVERSATION_SELECTION_INSTRUCTION, /포화·상태 확인 불가·금지 모델·호환 불가·역할 충돌/)
  assert.match(AI_CONVERSATION_SELECTION_INSTRUCTION, /caution은 정확히 이어지는 작은 후속 작업/)
  assert.doesNotMatch(AI_CONVERSATION_SELECTION_INSTRUCTION, /caution·saturated·unknown 또는 독립 검수·새 범위는 새 대화를 선택/)
})

test('최신순 정렬과 무관하게 관련 후보를 비교하고 선택한 대화의 평가를 사용한다', () => {
  const rules = aiConversationSelectionRules()
  assert.match(rules.candidateSelection, /첫 번째나 최신 대화만 고정 선택하지 마세요/)
  assert.match(rules.candidateSelection, /후보별 requestPreview와 위임 기록/)
  assert.match(rules.candidateSelection, /관련 후보가 여러 개이면 업무 연속성과 현재 문맥 건강도를 비교/)
  assert.match(rules.candidateSelection, /선택한 conversationId의 contextHealth와 assessmentId.*다른 대화의 평가를 적용하지/s)
  assert.match(rules.chooseNew, /한 후보의 포화·금지 모델을 다른 관련 후보에 적용하지/)
})

test('같은 검수 흐름의 입력·구현자·단계 변경만으로 대화를 분리하지 않는다', () => {
  const rules = aiConversationSelectionRules()
  assert.match(rules.preferResume, /같은 카드의 연속 검수·수정분 재검수/)
  assert.match(rules.preferResume, /입력 파일·구현 담당자·검수 단계가 바뀌었다는 사실만으로 새 대화를 선택하지/)
  assert.match(rules.reviewIndependence, /검수 대상 구현에 참여하지 않았다면 검수 대상이 바뀌어도 독립성은 유지/)
  assert.match(rules.chooseNew, /입력 파일·구현 담당자·검수 단계 변경만으로 별개 업무라고 판단하지/)
  assert.doesNotMatch(rules.chooseNew, /독립 검토·새 범위이면 새 대화를 선택/)
})

test('구현 참여로 역할이 충돌하거나 별도 관점 검수가 요청되면 새 대화를 선택한다', () => {
  const rules = aiConversationSelectionRules()
  assert.match(rules.reviewIndependence, /검수 대상 구현에 참여해 역할이 충돌/)
  assert.match(rules.reviewIndependence, /원 검수자와 별도의 관점으로 재검수하도록 요청받은 경우에는 새 검수 대화를 선택/)
  assert.match(rules.chooseNew, /의도적인 별도 관점 검수 또는 별개 업무 목적·범위/)
})

test('문맥·모델 차단과 주의 상태의 좁은 예외를 유지한다', () => {
  const rules = aiConversationSelectionRules()
  assert.match(rules.exclude, /available=false.*resumeAllowed=false/)
  assert.match(rules.exclude, /runtime\.state가 idle이 아닌 대화/)
  assert.ok(rules.exclude.includes(blockedAiModelLabels()))
  assert.ok(rules.chooseNew.includes(blockedAiModelLabels()))
  assert.match(rules.chooseNew, /saturated·unknown.*resumeAllowed=false/)
  assert.match(rules.chooseNew, /newConversation에 사용 가능한 다른 모델을 명시/)
  assert.match(rules.chooseNew, /caution은 정확히 이어지는 작은 후속 작업일 때만 평가를 확인하고 예외적으로 이어갈/)
  assert.match(rules.preferResume, /unverified.*포화 여부를 판정할 수 없는 상태/)
})

test('실행 중 중복 대화 생성과 작업공간 경로만으로 교체하는 것을 금지한다', () => {
  const rules = aiConversationSelectionRules()
  assert.match(rules.busy, /현재 실행과 관련 위임의 통합이 끝난 뒤 후보 목록을 다시 조회/)
  assert.match(rules.busy, /같은 업무의 새 대화를 열거나 새 위임을 자동 예약하지/)
  assert.match(rules.busy, /같은 업무의 중복 실행·동시 편집을 허용하는 것은 아닙니다/)
  assert.match(rules.chooseNew, /단지 실행 중이면 busy 규칙.*새 대화로 대체하지/s)
  assert.match(rules.preferResume, /workspaceBinding=pool-rebindable.*workspacePoolId/)
  assert.match(rules.chooseNew, /같은 workspacePoolId 안의 Fork 경로 차이만으로 새 대화를 만들지/)
  assert.equal(Object.hasOwn(rules, 'queuedResume'), false)
})

test('새 대화 선택 근거는 관련 후보의 평가와 실제 분리 필요성을 기록한다', () => {
  const rules = aiConversationSelectionRules()
  assert.match(rules.metrics, /관련 conversationId와 그 대화의 현재 평가/)
  assert.match(rules.metrics, /관련 기존 대화를 재사용할 수 없는 이유나 별개 업무·역할 충돌·별도 관점이 필요한 근거/)
  assert.match(rules.metrics, /독립 검수라는 표현이나 입력 파일·구현 담당자 변경만을 근거로 삼지/)
  assert.match(rules.metrics, /contextSize=null.*퍼센트.*포화·여유라고 단정하지/s)
  assert.match(rules.recovery, /중단된 동일 위임.*새 위임을 만들지.*기존 위임 복구·재개/s)
})
