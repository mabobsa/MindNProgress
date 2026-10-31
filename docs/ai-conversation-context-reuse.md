# 위임 대화의 컨텍스트 기준 재사용 정책

## 현재 상태: OFF (2026-10-31)

`server/lib/aiConversationContextHealth.mjs`의 공통 스위치 `AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED`는 `false`다. 아래 "ON일 때의 정책"(포화 예외, 사용량 확인 상태)의 코드는 다시 쓸 수 있게 남겨 두었다.

- 컨텍스트 크기·사용률·실행 턴 수·연속 재사용 횟수·통계 미확인만으로 기존 대화 이어가기를 차단하거나 새 대화를 권장하지 않는다.
- 사용량, 턴 통계, `state`, `reasonCodes`는 참고용으로 계속 수집한다. 따라서 `state=saturated`나 `state=unknown`도 OFF이면 `recommendation=resume`, `resumeAllowed=true`일 수 있다.
- `contextHealth.contextReuseGuardEnabled`로 실제 스위치 상태를 확인한다. 상태 이름만으로 새 대화를 선택하지 않는다.
- 서버의 일반 위임·그룹 문서 지시·대기 중 위임 검사와 MCP의 후보 선택 안내는 같은 스위치를 사용한다.
- 금지 모델, 실행 중인 대화의 중복 실행 금지, 대화·카드 접근 권한, 실행 환경·역할·작업공간 호환성 검사는 그대로 유지한다. 모델 정책이 차단한 대화는 OFF여도 `resumeAllowed=false`다.
- 이어가기의 최신 `assessmentId` 확인과 기존 중단 위임의 복구 절차도 유지한다. OFF는 이미 실행 중인 위임을 취소하거나 새로운 대화를 자동 실행하는 설정이 아니다.

## 변경 이력

- 2026-10-14(`86975df`): 임시 OFF로 바꿨다.
- 2026-10-30(`77581d7`): 다시 ON으로 바꿨다. 사용률 80% 이상이면 새 대화가 기본이고, 상위 AI가 사유(`contextOverride`)를 붙이면 90% 미만에서 예외로 이어가게 했다. 지침 기준선은 3차로 재생성했다.
- 2026-10-31(`f93cfc1`): AionCore 사용량 확인 상태(`_meta["aionui/contextUsage"]`)를 판정에 반영했다.
- 2026-10-31(`74180b1`): 사용자 결정으로 위 두 커밋을 되돌렸다. 근거는 다음과 같다.
  - MnP 카드는 담당 영역이 정해져 있어, 한 카드의 작업은 모두 이어지는 작업이다.
  - 같은 대화를 압축까지 이어 써도 지시 처리 품질에 차이가 보이지 않았다.
  - 그러므로 문맥 기준 새 대화 전환은 품질 이점 없이 대화 수만 늘린다. 10-24 이후 Claude 위임 대화의 지시 1회당 사용률 증가는 중앙값 22%였고, 80% 기준이면 약 3.6회마다 새 대화가 생긴다.
- 2026-10-31: 사용자가 나중에 다시 쓸 수 있게 코드는 남기고 OFF로 두되, 지침까지 포함해 개선 전과 같게 동작하도록 보장하라고 결정했다. 그래서 두 커밋의 코드를 다시 넣고 스위치를 끈 상태에서 개선 전과 같은 동작을 테스트로 보장했다.
- 행동 평가 기록은 `git show 77581d7:docs/context-reuse-override-behavior-evaluation-20261030.md`로 볼 수 있다.

## OFF 동작은 개선 전(`131eace`)과 같다

스위치가 꺼져 있으면 밖으로 보이는 동작이 `131eace`와 같다.

- 초기 안내와 선택 규칙은 2차 지침 기준선과 같다. 기준선은 재생성하지 않았다.
- `delegate_ai_work`·`send_group_document_instruction`에 `contextOverride` 인자를 등록하지 않는다. 도구 스키마는 `131eace` 스냅샷과 같다.
- 요청의 `contextOverride`는 모르는 필드처럼 무시한다. 형식 검증, 요청 서명, 기록에 쓰지 않는다.
- 판정 결과에는 `contextOverrideEligible`, `metrics.contextUsageStatus`·`contextUsageUpdatedAt`를 넣지 않는다. 사용량 확인 상태도 판정에 쓰지 않는다. 그래서 평가 ID도 같다.
- 409 거절은 금지 모델일 때만 나며, 사유 코드와 메시지는 개선 전과 같다.

다음 테스트가 이를 보장한다.

- `tests/ai-context-reuse-off-equivalence.test.mjs`
  - `131eace` 판정 함수·선택 안내의 고정 사본(`tests/fixtures/legacy-131eace/`)과 비교한다.
  - 474가지 입력(사용량 확인 상태 포함)과 금지 모델 경우에서, 판정 결과를 직렬화한 문자열까지 같은지 확인한다.
  - 선택 안내·규칙 원문도 같아야 하고, 예외 없는 이어가기 결정은 `resumeAllowed`와 같아야 한다.
- `tests/initial-guidance-restoration.test.mjs`(2차 기준선), `tests/mcp-instruction-surface.test.mjs`(`131eace` 도구 스키마 스냅샷), `tests/ai-conversation-selection-policy.test.mjs`, `tests/ai-conversation-context-health.test.mjs`, `tests/sub-machine-routing-api.test.mjs`, `tests/group-project-api.test.mjs`, `scripts/test-mcp.mjs`
  - 모두 `131eace`의 기대값을 그대로 쓴다.
  - 바꾼 것은 세 가지다. `ai-conversation-display`의 함수 주입 이름 2개, `ai-conversation-context-health`의 ON 지표 비교 1곳, `sub-machine-routing-api`의 기능 확인 응답 결함 수정 1줄이다.

## 다시 켜는 절차

1. 스위치를 `true`로 바꾼다.
2. 초기 안내와 도구 스키마가 바뀐다. 사용자 승인을 받아 지침 기준선을 재생성하고(`77581d7`의 3차 재생성 참고), `tests/fixtures/mcp-tool-input-schema.json`·`ai-instruction-budget.json`을 다시 만든다.
3. ON 테스트를 갖춘다.
   - `tests/ai-conversation-context-override.test.mjs`는 늘 실행한다.
   - `tests/ai-delegation-context-override-queue.test.mjs`는 OFF 동안 건너뛰므로, 켜면 실행된다.
   - 포화 예외 경우를 다루는 API 테스트(`sub-machine-routing-api`·`group-project-api`)와 `scripts/test-mcp.mjs`의 ON 검사는 `git show 77581d7 -- <파일>`에서 되살린다.
   - `tests/ai-context-reuse-off-equivalence.test.mjs`의 "스위치는 OFF다" 검사는 지운다. 나머지 동일성 검사는 OFF 인자를 직접 넘기므로 그대로 둔다.
4. 사용자 승인 아래 행동 평가(BEH-02·16·17, `77581d7` 기록 참고)를 실행한다.
5. 스위치 상태가 평가 ID에 들어가므로, 대기 중인 위임·지시가 없을 때 운영에 반영한다. MnP 서버 재시작과 MCP 재연결이 필요하고, AionCore 변경은 필요 없다.

## ON일 때의 정책

아래는 스위치를 켰을 때 적용되는 정책이다(`77581d7`·`f93cfc1`).

### 판정 기준

- 실제 전체 문맥 크기를 확인한 사용률이 65% 이상이면 `caution`, 80% 이상이면 `saturated`다. 사용량이 확인되지 않은 상태면 아래 "사용량 확인 상태"를 따른다.
- 사용률을 확인하지 못하면 실행 턴 수(40/80)와 연속 재사용 횟수(5/10)는 `caution` 신호로만 쓰며 포화를 확정하지 않는다. 대화 이력을 확인하지 못하면 `unknown`이다.
- `resumeAllowed`는 `healthy`·`unverified`·`caution`이면 `true`, `saturated`·`unknown`이면 `false`다. 금지 모델 대화는 스위치와 무관하게 `false`다.
- `caution`은 `recommendation=new`지만 정확히 이어지는 작은 후속 작업은 최신 평가를 확인해 이어갈 수 있다.
- 스위치 상태와 지표가 평가 ID(`assessmentId`)에 들어간다. 이어가기 요청은 후보 조회 때 받은 최신 평가 ID를 전달해야 한다.

### 사용량 확인 상태

AionCore(2026-10-30 `aa9513ed`부터)는 `GET /api/conversations/{id}/usage`의 `_meta["aionui/contextUsage"]`에 사용량 확인 상태를 남긴다.

- `status`는 세 가지다.
  - `pending`: 턴을 보내기 직전에 기록한다. 그 턴의 사용량을 아직 확인하지 못했다는 뜻이며, 실행 중이라는 뜻은 아니다.
  - `current`: 그 턴(`turn_id`)의 에이전트 사용량 보고가 저장됐다. 턴이 끝났거나 대화가 유휴라는 보장은 아니다.
  - `unavailable`: 확인하지 못했다. `reason`은 `timed_out`·`not_reported`·`persistence_failed`·`process_closed` 중 하나다.
- `updated_at`은 마지막으로 사용량 저장에 성공한 시각이고, `status_changed_at`은 상태가 바뀐 시각이다(둘 다 Unix 밀리초).
- `pending`·`unavailable`에서도 `used`·`size`는 마지막으로 저장에 성공한 값이 남는다. 이 값은 현재 사용률의 하한이나 상한을 보장하지 않는다. 문맥 압축 등으로 줄어들 수도 있다.
- `pending`은 Core가 강제 종료되거나 `unavailable` 기록이 실패하면 유휴 대화에도 남을 수 있다. Core를 다시 띄우거나 시간이 지나도 풀리지 않고, 다음 사용량 저장이 성공해야 `current`가 된다. 실행 여부는 이 상태가 아니라 대화 런타임 상태로 판단한다.

MnP는 다음처럼 판정한다.

- `current`이거나 확장이 없으면 기존 방식으로 판정한다. 확장이 없는 기존 기록은 호환을 위해 기존처럼 판정할 뿐, 최신성이 확인된 값은 아니다.
- 그 밖의 상태(`pending`·`unavailable`·알 수 없는 값)에 사용량 수치가 있으면 `CONVERSATION_CONTEXT_USAGE_UNCONFIRMED` 사유를 붙인다.
  - 마지막으로 확인된 사용률이 80% 이상이면 `saturated`, 65% 이상이면 `caution`으로 보수적으로 판정한다. 측정 사실이 아니라 운영 정책이므로, 사유 문구는 "마지막으로 확인된 사용률"과 "현재 사용률 미확인"을 구분해 적는다.
  - 그보다 낮으면 `healthy`가 아니라 `unverified`다. 실행 턴 수와 연속 재사용 횟수도 다시 `caution` 신호로 쓴다.
  - 확인되지 않은 사용률로 포화 판정한 대화는 90% 미만인지 알 수 없으므로 `contextOverrideEligible=false`다. 예외를 붙인 요청도 `*_CONTEXT_OVERRIDE_LIMIT`로 거절한다.
- 사용량 수치가 없으면 확인 상태와 무관하게 기존 판정을 유지한다.
- 판정 결과의 `metrics.contextUsageStatus`와 `metrics.contextUsageUpdatedAt`(마지막 확인 시각, ISO)에 확인 상태를 노출한다. 확장이 없으면 둘 다 `null`이다. 두 값은 평가 ID에 들어가므로 상태가 바뀌면 평가 ID도 바뀐다.

### 포화 예외(`contextOverride`)

`state=saturated`이고 사용률이 90% 미만인 대화만 예외 대상이다. 후보 조회 결과의 `contextHealth.contextOverrideEligible=true`가 이 조건을 뜻한다.

상위 AI는 `mindnprogress_delegate_ai_work` 또는 `mindnprogress_send_group_document_instruction`의 resume 요청에 `contextOverride: { reasonCode, reason }`를 붙인다. `reason`은 1~500자다.

| 사유 코드 | 쓰는 경우 |
|---|---|
| `unrecorded-context` | 같은 업무 흐름의 후속 작업이며 카드·댓글·위임 기록에 없는 대화 맥락이 많아 새 대화의 지시로 옮기기 어렵다 |
| `final-step` | 같은 위임을 마무리하는 짧은 마지막 단계다 |
| `continued-review` | 같은 검수 대화가 이전 판단·결함을 이어서 검수한다 |
| `user-requested` | 사용자가 이번 요청에서 그 대화를 이어가라고 직접 지시했다. `reason`에 사용자의 지시 발언을 적는다 |

업무 연속성·편의·비용 절감만으로는 예외를 쓰지 않는다. 판정은 `resolveAiConversationContextOverride()`가 맡는다.

| 평가 | 예외 없이 요청 | 예외를 붙여 요청 |
|---|---|---|
| `healthy`·`unverified`·`caution` | 허용 | 허용. 예외는 무시하고 기록하지 않음 |
| 금지 모델 | 거절(`*_MODEL_BLOCKED`) | 거절(`*_MODEL_BLOCKED`) |
| `saturated`, 90% 미만 | 거절 | 허용하고 기록 |
| `saturated`, 90% 이상 | 거절 | 거절(`*_CONTEXT_OVERRIDE_LIMIT`) |
| `saturated`, 사용률 미확인 | 거절 | 거절(`*_CONTEXT_OVERRIDE_LIMIT`) |
| `unknown` | 거절 | 거절 |

거절 코드는 다음과 같다.

| 경로 | 포화(예외 없음) | 90% 이상·미확인 사용률 예외 | 확인 불가 |
|---|---|---|---|
| 새 위임 | `AI_DELEGATION_CONVERSATION_CONTEXT_SATURATED` | `AI_DELEGATION_CONVERSATION_CONTEXT_OVERRIDE_LIMIT` | `AI_DELEGATION_CONVERSATION_CONTEXT_UNKNOWN` |
| 그룹 문서 지시 | `GROUP_DOCUMENT_INSTRUCTION_CONVERSATION_CONTEXT_UNAVAILABLE` | `GROUP_DOCUMENT_INSTRUCTION_CONVERSATION_CONTEXT_OVERRIDE_LIMIT` | `GROUP_DOCUMENT_INSTRUCTION_CONVERSATION_CONTEXT_UNAVAILABLE` |

`contextOverride`를 `strategy=new`에 붙이거나 형식이 맞지 않으면(허용 목록 밖의 코드, 빈 근거, 500자 초과) `*_REQUEST_INVALID`(400)로 거절한다.

### 기록과 남용 확인

- 예외를 실제로 적용한 요청만 위임·지시 기록에 `contextOverride`를 남긴다. 필드는 `reasonCode`, `reason`, `contextUsageRatio`, `assessmentId`, `appliedAt`이다.
- 사유 코드와 근거는 요청 서명에 들어가므로, 같은 `idempotencyKey`로 다른 예외를 보내면 다른 요청으로 구분된다. 예외가 없는 요청의 서명은 이전과 같다.
- `list_ai_delegations`·`list_group_document_instructions`의 일반 항목에 그대로 나타난다. 응답 예산으로 요약된 항목(`summary=true`)에서는 `decisionReason`처럼 빠지므로 한 건 조회로 다시 받는다.
- 완료 위임은 7일 뒤 상세 기록이 정리되지만, 요청 영수증(`_ai-request-receipts.json`)에 `contextOverride`가 남는다. 그룹 문서 지시(`_group-document-instructions.json`)는 정리하지 않는다.
- 남용 여부는 데이터 폴더의 `_ai-delegations.json`, `_ai-request-receipts.json`, `_group-document-instructions.json`에서 `contextOverride`가 있는 항목을 사유 코드별로 모아 확인한다. 같은 위임이 위임 기록과 영수증에 함께 있을 수 있으니 `id`로 중복을 제거한다.

### 대기 건

- 작업공간 대기 위임과 대기 중인 그룹 문서 지시는 시작·전달 직전에 문맥을 다시 평가한다.
- 요청 때와 같은 `assessmentId`일 때만 진행하므로 사용률도 요청 때와 같다. 이때 저장된 `contextOverride`에 같은 판정 함수를 다시 적용해, 요청 때 인정한 예외를 그대로 인정한다.
- 대화 내용·문맥 지표·스위치 상태가 바뀌어 평가가 달라지면 기존 규칙대로 거절·만료한다.

### 판정 밖의 경로

다음 경로에는 문맥 판정을 적용하지 않는다(변경 없음).

- 중단된 동일 위임의 복구·재개
- 하위 결과로 상위 대화가 자동 재개되는 경우
- `session-message` 회신
- 총괄·상위 AI 자신의 대화

### 알려진 한계

409 거절은 접수 실패로 기록된다. 같은 업무를 예외와 `retryOfRequestId`로 다시 요청하면 경고가 해제된다. 그러나 거절 뒤 새 대화로 바꿔 맡기면 재접수로 인정되지 않아, 사용자가 접수 실패를 종료할 때까지 경고가 남는다. 금지 모델 거절에서도 같은 기존 동작이다.

AionCore가 최종 사용량을 120초 안에 받지 못하거나 강제 종료되면, 다음 사용량 저장 전까지 미확인 상태가 남는다. 그동안은 마지막으로 확인된 사용률로 보수적으로 판정한다. 그래서 문맥 압축 등으로 실제로는 여유가 생긴 대화도 포화로 막힐 수 있다.

## 검증

- OFF 동일성: 위 "OFF 동작은 개선 전(`131eace`)과 같다"에 적은 테스트
- ON 기능: `tests/ai-conversation-context-override.test.mjs`(ON 판정, 경계값 80%·90%, 예외 판정 표, 금지 모델 유지, 인자 정규화, 응급 OFF, 사용량 확인 상태)와 `tests/ai-delegation-context-override-queue.test.mjs`(OFF 동안 건너뜀)
- 예외 기록: `tests/ai-delegations.test.mjs`, `tests/completed-ai-history.test.mjs`, `tests/group-document-instructions.test.mjs`(요청 서명과 영수증 보존, 스위치와 무관)
