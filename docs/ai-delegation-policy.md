# AI 위임 규칙(서버 적용)

2026-11-09 사용자 결정으로 하위 카드 위임·그룹 문서 지시의 새 대화 CLI·모델·사고 강도를 서버가 정한다.

이전에는 이 규칙이 총괄·문서 루트 AI 대화와 카드 본문에만 있었다. 그래서 규칙이 바뀌면 총괄 AI가 문서 루트 AI들에게 알렸고, 깨어난 AI마다 맡은 카드를 모두 다시 읽어 옛 모델 문구를 고쳤다. 이 때문에 주간 사용량이 급격히 늘었다. 이제 규칙은 한 곳에만 두고, AI 대화에는 전달하지 않는다.

## 규칙 원본과 바꾸는 방법

규칙은 웹 화면의 **계정 메뉴 → AI 위임 규칙**에서 바꾼다. 저장하면 `server/data/_ai-delegation-policy.json`에 기록되고, 서버 재시작 없이 다음 위임부터 적용된다. AI 대화나 카드에는 알리지 않는다.

- 편집자만 열 수 있다(분산 작업 설정과 같은 조건). 로그인한 사람만 저장할 수 있고, AI 연동 토큰으로는 읽거나 바꿀 수 없다. 저장한 사람·시각을 남긴다.
- CLI·모델·사고 강도·권한 모드는 AionUi 에이전트 목록에서 고른다. AionUi에서 확인되지 않는 저장값은 「AionUi에서 확인 안 됨」으로 표시하고 지우지 않는다. 실행 머신에 없는 값은 위임할 때 거절된다.
- 업무 유형·카드 구분(모두·문서 루트·하위 카드)·분석 규모(모두·기본·대규모)의 조합 8개가 모두 정확히 한 행에 맞아야 저장된다. 화면이 빠지거나 겹친 조건을 먼저 알리고, 서버도 같은 기준으로 다시 검증한다.
- 다른 사람이 먼저 저장했으면 덮어쓰지 않고 409(`AI_DELEGATION_POLICY_CONFLICT`)로 거절한다. 화면을 다시 열어 최신 규칙에서 고친다.
- 저장값이 없으면 `server/lib/aiDelegationPolicy.mjs`의 기본 규칙(아래 표, 2026-11-09 결정)을 쓴다. 화면의 「기본값 불러오기」로 되돌릴 수 있다.
- 파일 형식이 깨져 있으면 다른 규칙으로 대신하지 않고 서버 기동을 멈춘다. Claude 계정 정책 파일과 같다.
- 위임할 때는 그 시점의 규칙을 한 번 읽어 그 요청이 끝날 때까지 같은 규칙을 쓴다. 응답 `aiPolicy.revision`은 화면에 표시하는 규칙 버전과 같다.

기본 규칙:

| 행 ID | 업무 유형(`workType`) | 카드 구분 | 분석 규모(`analysisDepth`) | CLI | 모델 | 사고 강도 |
|---|---|---|---|---|---|---|
| `review/any/standard` | `review` | 모두 | `standard` | Claude Code | `opus` | `xhigh` |
| `review/any/deep` | `review` | 모두 | `deep` | Claude Code | `opus` | `max` |
| `other/document-root/any` | `other` | 문서 루트 | 모두 | Claude Code | `opus` | `xhigh` |
| `other/sub-card/standard` | `other` | 하위 | `standard` | Codex CLI | `gpt-6.1-sol` | `xhigh` |
| `other/sub-card/deep` | `other` | 하위 | `deep` | Codex CLI | `gpt-6.1-sol` | `max` |

- 행 ID는 조건(업무 유형/카드 구분/분석 규모)으로 만든다.
- 검수 여부를 먼저 본다. 검수는 하위 카드도 Claude Code·Opus다.
- 조합마다 정확히 한 행만 일치하며, 여러 행의 값을 섞지 않는다(`tests/ai-delegation-policy.test.mjs`).
- 문서 루트(계층상 부모가 없는 원본 루트)만 상위 카드다. 하위에 다시 위임하는 중간 카드도 하위 카드다.
- 그룹 문서 지시의 대상은 항상 문서 루트이므로 상위 카드 규칙을 쓴다.
- CLI는 AionUi 에이전트의 `backend`(`claude`·`codex`)로 찾는다. 실행 머신마다 에이전트 ID가 달라도 같은 규칙이 적용된다.
- 권한 모드는 규칙에 없다. 같은 CLI의 요청값이나 대상 카드·상위 대화의 모드를 쓰고, 없으면 화면의 「기본 권한 모드」(기본값 Claude Code `acceptEdits`, Codex CLI `full-access`)를 쓴다. 다른 CLI의 모드는 물려받지 않는다.
- 기술·MCP·작업 디렉토리·Claude 계정은 기존 상속·계정 정책을 그대로 따른다.

## AI가 보내는 값

`mindnprogress_delegate_ai_work`와 `mindnprogress_send_group_document_instruction`은 다음 값을 받는다.

- `workType`(필수): `review`(검수) 또는 `other`(그 밖의 업무).
- `analysisDepth`(선택, 기본 `standard`): 대규모 검수나 복잡한 원인 분석이면 `deep`.
- `aiPolicyOverride`(선택): 사용자가 이번 요청에서 다른 AI 설정을 직접 지정한 경우에만 쓴다. 그 발언을 `evidence`에 적고 `newConversation`의 `agentId`·`modelId`와 함께 보낸다. 카드나 과거 지시에 적힌 설정은 근거가 아니다.

`newConversation`의 `agentId`·`modelId`는 선택 항목이 됐다. 예외 없이 적은 값은 규칙 값으로 바뀌고, 응답 `aiPolicy.adjustments`에 바뀐 항목이 표시된다. AI가 기억한 옛 규칙은 이렇게 위임할 때 그 AI에게만 바로잡히고, 다른 대화는 깨우지 않는다.

`workType`이 없는 HTTP 요청은 이전과 같이 명시값·상속으로 정한다. 도구 정의가 바뀌기 전에 열린 대화의 MCP 연결과 기존 시험이 여기에 해당한다. 새 도구 정의는 `workType`을 필수로 받는다.

## 이어가기

이어갈 대화의 현재 모델(AionUi `current_model_id`, 없으면 연결 기록의 모델)이 규칙 모델과 다르면 새 대화로 바꿔 실행한다(사용자 결정 2026-11-09). 이 경우 이전 대화의 맥락은 이어지지 않는다.

- 이어가기 검사(문맥 평가 ID 등)보다 먼저 판단하므로, 평가 ID 없이도 새 대화로 진행한다.
- 응답 `aiPolicy.resumeConversion`과 `delegation.strategy=new`로 알리고, 서버 로그에 `[AI delegation policy resume conversion]`(그룹 지시는 `[Group document instruction policy resume conversion]`)을 남긴다.
- 거절하지 않고 바꾸는 이유가 있다. 기존 접수 실패 기록은 같은 전략의 재접수만 같은 업무로 인정한다. 그래서 거절하면 「접수 실패」 경고가 해제되지 않고 남는다.
- 사고 강도는 비교하지 않는다. 같은 모델이면 사고 강도가 달라도 이어간다.
- 중단된 같은 위임의 재개(`waiting-child-resume`)와 `aiPolicyOverride`가 있는 요청은 바꾸지 않는다.
- 현재 모델을 확인하지 못하면 바꾸지 않고 기존 이어가기 검사에 맡긴다.

## 응답

접수한 위임·지시의 응답에는 `aiPolicy`가 붙는다.

- `rule`: 적용한 행 ID. 예외면 `null`이다.
- `cardLevel`: `document-root` 또는 `sub-card`.
- `applied`: 실제로 고른 CLI·모델·사고 강도·모드.
- `adjustments`: 요청값 중 규칙 값으로 바뀐 항목.
- `resumeConversion`: 이어가기를 새 대화로 바꾼 경우의 기록.
- `message`: 위 내용을 알리는 문장.
- `revision`: 규칙 버전(규칙 표의 해시).

규칙의 모델이나 사고 강도가 실행 머신의 AionUi에 없으면 다른 값으로 바꾸지 않는다. 이때는 `AI_DELEGATION_POLICY_UNAVAILABLE`(그룹 지시는 `GROUP_DOCUMENT_INSTRUCTION_POLICY_UNAVAILABLE`, 409)로 거절한다. 입력 값이 잘못되면 `*_POLICY_REQUEST_INVALID`(400)다.

## 적용하지 않는 곳

- 같은 카드의 대화 인계(`start_card_conversation`)는 이전 대화 설정을 그대로 잇는다.
- Dooray 업무 대응의 AI 설정은 기존 화면 선택과 `aiModelPolicy`를 따른다.

## 이미 퍼진 규칙 사본

총괄·문서 루트 AI 대화에는 2026-11-09 규칙 표가 주입돼 있고, 문서 루트 카드 설명과 일부 하위 카드에 사본·주석이 있다.

- 지금의 표와 같으므로 당장 충돌은 없다.
- 다음에 규칙이 바뀌어도 대화에 알리지 않는다. 옛 값으로 위임하면 서버가 바로잡고 응답으로 알린다.
- 카드 본문에 남은 앞으로의 위임 설정 문구는 「위임 AI 설정은 MnP 위임 규칙을 따른다」로 바꾼다. 과거 실행 기록은 그대로 둔다. 이 정리는 AI 대화를 깨우지 않고, 별도 승인을 받아 한 번에 처리한다.
