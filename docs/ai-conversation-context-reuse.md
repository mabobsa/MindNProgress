# 위임 대화의 컨텍스트 기준 재사용 정책

## 현재 상태: ON (2026-10-30 재활성화)

`server/lib/aiConversationContextHealth.mjs`의 공통 스위치 `AI_CONVERSATION_CONTEXT_REUSE_GUARD_ENABLED`는 `true`다.

- 2026-10-14(`86975df`)부터 임시 OFF였다.
- 2026-10-30 사용량 점검에서 개인 Max 5시간 한도 급증의 70%가 전날부터 이어진 대화로 확인되어 다시 켰다. 이 대화들의 시작 문맥은 중앙값 44만, 최대 95만 토큰이었다.
- 기본값은 "사용률 80% 이상이면 새 대화"다. 이어가는 편이 유리한 대화는 상위 AI가 사유를 남기면 90% 미만에서만 예외로 이어갈 수 있다.
- 서버의 일반 위임·그룹 문서 지시·대기 중 위임 검사와 MCP의 후보 선택 안내는 같은 스위치와 임계값을 사용한다.

## 판정 기준

- 실제 전체 문맥 크기를 확인한 사용률이 65% 이상이면 `caution`, 80% 이상이면 `saturated`다. 사용량이 확인되지 않은 상태면 아래 "사용량 확인 상태"를 따른다.
- 사용률을 확인하지 못하면 실행 턴 수(40/80)와 연속 재사용 횟수(5/10)는 `caution` 신호로만 쓰며 포화를 확정하지 않는다. 대화 이력을 확인하지 못하면 `unknown`이다.
- `resumeAllowed`는 `healthy`·`unverified`·`caution`이면 `true`, `saturated`·`unknown`이면 `false`다. 금지 모델 대화는 스위치와 무관하게 `false`다.
- `caution`은 `recommendation=new`지만 정확히 이어지는 작은 후속 작업은 최신 평가를 확인해 이어갈 수 있다.
- 스위치 상태와 지표가 평가 ID(`assessmentId`)에 들어간다. 이어가기 요청은 후보 조회 때 받은 최신 평가 ID를 전달해야 한다.

## 사용량 확인 상태

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

## 포화 예외(`contextOverride`)

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

## 기록과 남용 확인

- 예외를 실제로 적용한 요청만 위임·지시 기록에 `contextOverride`를 남긴다. 필드는 `reasonCode`, `reason`, `contextUsageRatio`, `assessmentId`, `appliedAt`이다.
- 사유 코드와 근거는 요청 서명에 들어가므로, 같은 `idempotencyKey`로 다른 예외를 보내면 다른 요청으로 구분된다. 예외가 없는 요청의 서명은 이전과 같다.
- `list_ai_delegations`·`list_group_document_instructions`의 일반 항목에 그대로 나타난다. 응답 예산으로 요약된 항목(`summary=true`)에서는 `decisionReason`처럼 빠지므로 한 건 조회로 다시 받는다.
- 완료 위임은 7일 뒤 상세 기록이 정리되지만, 요청 영수증(`_ai-request-receipts.json`)에 `contextOverride`가 남는다. 그룹 문서 지시(`_group-document-instructions.json`)는 정리하지 않는다.
- 남용 여부는 데이터 폴더의 `_ai-delegations.json`, `_ai-request-receipts.json`, `_group-document-instructions.json`에서 `contextOverride`가 있는 항목을 사유 코드별로 모아 확인한다. 같은 위임이 위임 기록과 영수증에 함께 있을 수 있으니 `id`로 중복을 제거한다.

## 대기 건

- 작업공간 대기 위임과 대기 중인 그룹 문서 지시는 시작·전달 직전에 문맥을 다시 평가한다.
- 요청 때와 같은 `assessmentId`일 때만 진행하므로 사용률도 요청 때와 같다. 이때 저장된 `contextOverride`에 같은 판정 함수를 다시 적용해, 요청 때 인정한 예외를 그대로 인정한다.
- 대화 내용·문맥 지표·스위치 상태가 바뀌어 평가가 달라지면 기존 규칙대로 거절·만료한다.

## 판정 밖의 경로

다음 경로에는 문맥 판정을 적용하지 않는다(변경 없음).

- 중단된 동일 위임의 복구·재개
- 하위 결과로 상위 대화가 자동 재개되는 경우
- `session-message` 회신
- 총괄·상위 AI 자신의 대화

## 응급 OFF

- 스위치를 `false`로 내리면 문맥 기준 차단, 90% 상한과 예외, MCP 선택 안내의 ON 문구가 함께 꺼진다. 문맥 지표는 참고용으로 계속 수집한다.
- 금지 모델, 실행 중인 대화의 중복 실행 금지, 대화·카드 접근 권한, 실행 환경·역할·작업공간 호환성 검사, 최신 평가 ID 확인, 중단 위임 복구 절차는 OFF여도 유지한다.
- 스위치 상태가 평가 ID에 들어가므로 전환 뒤에는 후보를 다시 조회해야 한다. 전환 시점에 대기 중인 resume 위임과 문서 지시는 평가 변경으로 거절·만료되므로, 대기 건이 없을 때 재시작한다.
- 초기 안내 문구가 바뀌므로 전환에는 지침 기준선(`tests/initial-guidance-restoration.test.mjs`) 재생성 승인이 필요하다.

변경 적용에는 MnP 서버 재시작과 MCP 서버 재연결이 필요하다. AionCore 코드 변경·재빌드는 필요 없다. 기존 대화와 결과 이력은 보존한다.

## 알려진 한계

409 거절은 접수 실패로 기록된다. 같은 업무를 예외와 `retryOfRequestId`로 다시 요청하면 경고가 해제된다. 그러나 거절 뒤 새 대화로 바꿔 맡기면 재접수로 인정되지 않아, 사용자가 접수 실패를 종료할 때까지 경고가 남는다. 금지 모델 거절에서도 같은 기존 동작이다.

AionCore가 최종 사용량을 120초 안에 받지 못하거나 강제 종료되면, 다음 사용량 저장 전까지 미확인 상태가 남는다. 그동안은 마지막으로 확인된 사용률로 보수적으로 판정한다. 그래서 문맥 압축 등으로 실제로는 여유가 생긴 대화도 포화로 막힐 수 있다.

## 검증

- `tests/ai-conversation-context-health.test.mjs`: 기본 ON, 경계값 80%·90%, 예외 판정 표, 금지 모델 유지, 인자 정규화, 응급 OFF, 사용량 확인 상태(`current`·`pending`·`unavailable`·알 수 없는 값·형식 오류)
- `tests/ai-conversation-selection-policy.test.mjs`: ON 초기 안내와 `contextOverride` 규칙, 응급 OFF 문구 유지
- `tests/sub-machine-routing-api.test.mjs`: 서브 머신 대화 95%+예외 거절, 85% 무사유 거절, 85%+예외 이어가기·기록, 재접수 참조로 접수 실패 해제
- `tests/group-project-api.test.mjs`: 그룹 문서 지시의 같은 세 경우와 형식 오류, 지시 기록 노출
- `tests/ai-delegation-context-override-queue.test.mjs`: 작업공간 대기 위임이 저장된 예외로 시작하고 사유 없는 포화 대화는 시작하지 않음
- `tests/completed-ai-history.test.mjs`, `tests/ai-delegations.test.mjs`, `tests/group-document-instructions.test.mjs`: 영수증 보존과 요청 서명
- `scripts/test-mcp.mjs`, `tests/mcp-instruction-surface.test.mjs`: 도구 인자 스키마와 서버 전달, 도구 설명 기준선 유지
- 행동 평가(BEH-02·16·17): [context-reuse-override-behavior-evaluation-20261030.md](context-reuse-override-behavior-evaluation-20261030.md)
