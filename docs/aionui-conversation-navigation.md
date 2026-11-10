# AionUi에서 MindNProgress 카드 선택

AionUi 백엔드는 현재 대화가 MindNProgress 카드에 연결되어 있는지 조회하고, 사용자가 요청하면 같은 계정과 디바이스로 열어 둔 MindNProgress 화면에서 해당 문서와 카드를 선택할 수 있다. 로컬과 외부 접속에 같은 규칙을 적용하며 다른 사용자나 다른 디바이스의 화면에는 선택 이벤트를 보내지 않는다.

브라우저에 MindNProgress 연동 토큰을 노출하지 않도록 두 API는 AionUi 백엔드에서 호출한다.

## 카드의 담당 대화 선택

「AI 대화 선택」 목록의 담당 체크박스는 카드당 하나만 선택할 수 있으며 체크 변경 즉시 저장된다. 기존 카드의 초기 담당은 가장 최신 대화다. 다른 대화를 열거나 새 보조 대화를 연결해도 선택은 유지한다.

`PUT /api/maps/{mapId}/cards/{cardId}/ai-conversations/primary`는 로그인한 편집자가 사용한다. `conversationId`와 현재 선택인 `expectedPrimaryConversationId`를 보내며, 다른 곳에서 선택이 바뀌었으면 409로 응답한다. 연결된 대화와 머신 접근 권한을 검증하고 `aiPrimaryConversationId`만 변경한다. 이 API는 Aion 대화를 실행하거나 조회하지 않는다. 카드 대화 목록 응답의 `primaryConversationId`로 선택을 확인할 수 있다.

총괄 지시와 하위 카드 위임 모두 담당 모델이 위임 규칙과 다르면 규칙 모델에 맞는 최신 연결 대화를 담당으로 지정하고, 없으면 새로 만든다. 하위 위임의 담당 저장은 실행 확인 후 이루어진다. 자세한 전환·예외·대기 동작은 [AI 위임 규칙](ai-delegation-policy.md)의 담당 대화 항목을 따른다.

## 자기 카드의 후속 대화 시작

`mindnprogress_start_card_conversation`은 사용자가 요청한 인계를 위해 현재 대화의 원본 카드에 후속 대화를 만든다. 그룹 총괄 루트도 사용할 수 있으며, 하위 카드 위임이나 worker 배정을 수행하지 않는다. 현재 대화와 같은 실행 머신만 지원한다.

서버 경로는 `POST /api/maps/{mapId}/cards/{cardId}/ai-conversation-starts`다. 호출 대화의 원본 카드·시작 편집자·머신 접근 권한을 확인한다. 보관·휴지통 문서, Ref·이미지 카드, 진행 중인 위임·그룹 지시·작업공간 복구가 있는 경우에는 새 인계를 시작하지 않는다. 호출하는 현재 대화의 실행 중 상태 자체는 차단 조건이 아니다.

최초 호출에는 `requestId`, `predecessorConversationId`, `newConversation`, `initialMessage`, `decisionReason`, `approvalEvidence`가 필요하다. `newConversation`은 그룹 문서 지시와 같은 형식으로 `agentId`, `modelId`, 선택적인 `modeId`, `thoughtLevelId`, `enabledSkillIds`, `disabledBuiltinSkillIds`, `mcpIds`, `workspace`를 받는다. 생략한 선택 항목은 이전 대화 설정을 상속하고 필수 MnP MCP를 포함한다.

Claude는 선택적인 `claudeAccountId`로 새 대화의 계정을 고를 수 있다. 값은 `list_ai_conversations`가 반환하는 `claudeAccount.id`와 같다. 생략하면 이 도구를 호출한 현재 대화와 같은 계정을 쓴다. AionUi가 반환한 현재 대화의 실제 계정을 우선하며, 값이 없으면 기본 계정이다. AionUi에서 그 대화를 확인하지 못하면 MnP 연결 기록, 그다음 기본 계정을 쓴다. 위임·그룹 지시가 쓰는 '그 외' 용도 계정 정책은 인계에 적용하지 않는다. 새 대화의 AI 종류에서 고를 수 없는 계정을 지정하면 `CARD_CONVERSATION_START_CLAUDE_ACCOUNT_INVALID`로 생성 전에 거절한다. 확정한 계정은 `requestedConfig.claudeAccountId`·`claudeAccount`로 반환한다.

상속할 기본 외 계정이 목록에 없거나 목록 조회가 불완전하면 기본 계정으로 바꾸지 않고 같은 코드로 거절한다. 단일 계정 환경에서도 `claudeAccountId: "default"`는 허용한다. 기존 대화의 MCP 서버가 이전 스키마를 사용 중이면 새 계정 인자가 누락될 수 있으므로, 적용 시 MnP 서버 재시작과 함께 해당 대화의 MnP MCP도 재연결해야 한다.

`initialMessage`에는 파일 경로 대신 파일에서 읽은 원문을 전달한다. 원문 앞에 작성자 귀속과 `get_context` 안내를 붙이며, 원문의 공백·줄바꿈은 보존한다. 입력 10만 자 또는 안내 포함 256 KiB를 넘으면 원문을 자르지 않고 거절한다. 응답에는 원문의 길이와 SHA-256만 반환하고 본문·귀속 토큰은 노출하지 않는다.

요청은 `_card-conversation-starts.json`에 저장하며, 원격 호출은 문서 잠금 밖에서 수행한다. 같은 `requestId`에 다른 본문을 전달하면 거절한다. 동일 요청의 결과 조회와 미완료 단계 복구에는 다음 인자만 사용한다.

```json
{
  "mapId": "map-example",
  "cardId": "root-example",
  "requestId": "handoff:example:1",
  "resultOnly": true
}
```

처리 상태는 다음과 같다.

| 상태 | 의미 |
|---|---|
| `reserved`, `prepared`, `dispatching` | 요청 저장, 실행 환경 준비 또는 생성·전달 요청 중 |
| `observing` | 대화가 생성됐지만 첫 실행 시작은 아직 확인하지 못함 |
| `linked` | 첫 실행 시작을 확인하고 대표 연결을 옮겼으며, 실제 설정 확인은 남음 |
| `ready` | 대표 연결과 런타임이 반환한 필수 설정값을 확인함. AI 작업 완료를 뜻하지 않음 |
| `recovery-required` | 원격 결과 또는 연결을 확정하지 못함. 같은 요청을 조회하여 복구 |
| `failed` | MnP 검증 또는 Core의 생성 전 검사에서 거절됨. 사유를 해결한 뒤 새 요청 필요 |

AionCore가 반환하는 `starting`만으로는 대표 연결을 바꾸지 않는다. `running` 또는 `completed`와 `turnId`를 확인한 뒤 현재 대표가 이전 대화와 같은지 다시 검사한다. 다른 대화가 대표가 됐다면 덮어쓰지 않는다. 새 대화의 연결 이력과 이전 대화는 보존한다.

생성 요청 이후 응답이 유실되거나 서버가 재시작돼도 같은 `operationId`를 조회한다. 원격 처리 결과 자체를 찾을 수 없다면 임의로 다시 생성하지 않고 `recovery-required`를 유지한다. 카드 연결 저장만 실패한 경우에는 이미 생성된 대화의 연결 단계만 복구한다. 자동 확인은 최초 접수 후 10분까지이며, 이후에도 같은 요청의 명시적 조회로 복구할 수 있다.

`requestedConfig`는 요청·상속으로 확정한 설정이고 `runtimeConfig`는 AionCore의 조회 결과다. 각 값의 `source`는 `runtime`, `snapshot`, `unavailable`로 구분한다. 저장된 스냅샷을 실제 실행 확인으로 표시하지 않는다. 모드를 포함하는 AionCore `runtime-config`가 필요하며, 구버전 Core에서는 모드를 확인할 수 없어 `linked`로 남을 수 있다. 반환된 실제 모델 ID는 요청의 별칭과 다를 수 있으므로 요청값과 함께 확인한다.

기존 대화를 중지하거나 외부 총괄의 회신 주소를 변경하지 않는다. 인계 요청 기록도 해당 문서를 영구 삭제할 때 함께 정리한다. 운영 로그에는 요청·문서·카드·대화 ID와 상태만 남긴다.

## 서브 머신 Runner 중계

서브 머신의 AionCore는 로컬 MnP를 사용할 수 없으면 AionUi Runner의 로컬 중계 정보를 읽어 같은 조회·선택 API를 호출한다. Runner는 로컬 전용 토큰을 검증하고 메인 MnP로 보낼 때만 머신 토큰을 사용한다. 브라우저와 AionCore에는 머신 토큰을 전달하지 않는다.

Runner 요청에는 `X-MnP-Runner-MCP-Machine-Id`와 `X-MnP-AI-Conversation-Id`가 포함된다. 서버는 머신 토큰, 대화 원본의 실행 머신과 시작 계정, URL의 대화 ID와 헤더의 일치를 검증한다. 조회 경로는 GET, `/select` 경로는 POST만 허용한다. AionCore에서 구한 `X-MNP-Selection-Device-Address`를 중계에서도 보존하여 같은 계정·디바이스의 화면에만 선택 이벤트를 보낸다.

## 인증과 선택 식별자

로컬 직접 연결에서는 두 API 모두 MindNProgress 데이터 폴더의 `_integration-token` 값을 Bearer 토큰으로 사용한다. 서브 머신은 위 Runner 중계 절차로 인증한다.

```http
Authorization: Bearer {integration-token}
X-MNP-Selection-Device-Address: {AionUi 브라우저의 원본 접속 IP 주소}
```

선택 계정의 기준은 AionUi 계정이 아니라 MnP가 보유한 대화 연결 기록이다. MnP는 연결이 가리키는 문서·카드를 확인한 뒤 다음 순서로 `startedBy`를 해석한다.

1. `_ai-conversation-origins.json`의 해당 대화 원본
2. 해당 카드 `aiConversations`의 동일 대화 링크
3. 문서·카드·대화 ID가 모두 일치하는 영속 대화 귀속 정보

결정된 사용자는 현재도 활성 상태인 MnP 편집자 또는 관리자여야 한다. 계정 ID는 응답에 포함하지 않는다.

`X-MNP-AI-Editor-Id`는 선택 필수값이 아니다. AionCore가 인증 사용자와 MnP 계정 사이의 별도 신뢰 가능한 매핑을 보유한 경우에만 일치 확인용으로 보낼 수 있다.

```http
X-MNP-AI-Editor-Id: {신뢰 가능한 매핑으로 확인한 MnP 사용자 ID}
```

MnP 대화 연결 기록과 이 헤더가 모두 있으면 두 값이 같아야 한다. 다르면 조회와 선택 모두 `403 MNP_SELECTION_ACCOUNT_MISMATCH`로 거부한다. 연결 기록에 계정이 없을 때는 신뢰 가능한 헤더를 대체값으로 사용할 수 있지만, 현재 AionCore처럼 그런 매핑이 없다면 헤더를 생략해야 한다. 브라우저 입력, 프롬프트 문자열, AionUi 계정 ID 또는 이메일 추정값을 사용하면 안 된다.

`X-MNP-Selection-Device-Address`도 AionUi 백엔드가 요청 소켓 또는 신뢰하는 프록시 체인에서 구한 원본 브라우저 주소를 사용한다. AionUi 백엔드가 사용자 디바이스에서 직접 실행되어 MindNProgress를 호출한다면 이 헤더를 생략할 수 있고, 이때 MindNProgress는 요청 소켓 주소를 사용한다. 중앙 AionUi 서버가 외부 브라우저 요청을 중계한다면 반드시 이 헤더를 보낸다.

MindNProgress는 주소를 정규화한 뒤 해시만 SSE 접속 정보에 보관한다. 카드 선택용 디바이스 비교에서는 루프백 주소와 MnP 서버 PC의 실제 네트워크 인터페이스 주소를 하나의 로컬 디바이스로 묶는다. 따라서 메인 PC에서 MnP를 `127.0.0.1`로 열고 서브 머신의 AionUi에 LAN으로 접속해도 같은 계정의 MnP 화면을 찾을 수 있다. 다른 PC의 주소는 각각 구분하며, 작업공간 탐색 등 로컬 전용 API의 접근 허용 기준은 바꾸지 않는다. 주소 원문이나 해시는 API 응답에 포함하지 않는다.

## 연결 조회

```http
GET /api/integrations/aionui/conversations/{conversationId}/mindnprogress
```

카드에 연결된 대화는 `exists: true`와 현재 문서·카드 정보를 반환한다. 연결되지 않은 대화도 예상 가능한 조회 결과이므로 HTTP 200과 `exists: false`, `target: null`을 반환한다. AionUi 아이콘 표시 여부는 `exists`로 판단한다.

`selectionAvailable`은 대화 연결이 존재하고 서버 기록에서 결정한 계정·현재 요청 디바이스와 일치하는 MindNProgress SSE 화면이 하나 이상 연결되어 있음을 뜻한다. `matchingViewCount`는 그 화면 수다. `X-MNP-AI-Editor-Id`가 없어도 서버 기록에 유효한 `startedBy`가 있으면 두 값을 계산한다. 기존 `localSelectionAvailable`과 `localViewCount`는 이전 AionUi 구현과의 응답 호환을 위해 유지하지만 새 코드의 선택 가능 여부 판정에는 사용하지 않는다.

```json
{
  "conversationId": "2b31432e",
  "exists": true,
  "target": {
    "mapId": "map-123",
    "documentTitle": "개발 문서",
    "cardId": "card-456",
    "cardTitle": "연결 기능",
    "archived": false,
    "titlePrefix": "[상위] ",
    "cardRole": "document-root",
    "conversationRole": "primary",
    "primaryConversationId": "2b31432e"
  },
  "selectionAvailable": true,
  "matchingViewCount": 1,
  "localSelectionAvailable": false,
  "localViewCount": 0,
  "message": "MindNProgress에 연결된 대화입니다."
}
```

`target.titlePrefix`는 최신 문서 계층으로 판정한 대화 역할의 접두어다. 그룹 총괄 루트는 `[그룹 총괄] `, 일반 문서의 최상위 원본 카드는 `[상위] `, 하위 카드와 참조 카드는 빈 문자열을 반환한다. 신규 대화 제목과 자동 위임으로 생성한 제목에 같은 규칙을 적용한다. 기존 대화는 AionUi의 제목 동기화 버튼으로 반영하며, `[지식정리]` 등 별도 작업 용도의 접두어는 유지한다. 구버전 MnP가 이 필드를 생략하면 AionUi는 기존 역할 접두어를 보존한다.

### 담당·보조 구분

2026-11-10부터 같은 조회 응답의 `target`에 다음 필드를 추가한다. 별도 API를 호출하거나 제목 문자열을 분석할 필요가 없다. `POST .../mindnprogress/select`의 `target`에도 같은 필드가 포함된다.

| 필드 | 값과 의미 |
| --- | --- |
| `cardRole` | `group-coordinator`: 그룹 총괄 루트, `document-root`: 일반 문서 최상위 원본 카드, `card`: 그 밖의 카드 |
| `conversationRole` | `primary`: 이 카드의 담당 대화, `auxiliary`: 이 카드의 보조 대화 |
| `primaryConversationId` | 현재 담당 대화 ID. 담당이 없으면 `null` |

`cardRole`과 `conversationRole`은 서로 독립이다. 같은 상위 카드에 연결된 담당·보조 대화는 모두 `cardRole=document-root`이며 `conversationRole`만 다르다. 그룹 총괄 카드도 같은 방식이다. `titlePrefix`는 기존 `[상위] `·`[그룹 총괄] ` 계약을 유지하므로 이것만 보고 담당으로 판단하면 안 된다. Aion은 `conversationRole`로 담당·보조 배지나 제목 표기를 조합한다.

보조 대화의 응답 예시는 다음과 같다.

```json
{
  "cardRole": "group-coordinator",
  "conversationRole": "auxiliary",
  "primaryConversationId": "conversation-primary",
  "titlePrefix": "[그룹 총괄] "
}
```

- 판정 기준은 MnP 카드의 담당 선택이다. 미지정 상태의 기존 카드는 가장 최신 연결 대화를 초기 담당으로 취급한다.
- 담당을 바꾸면 다음 조회부터 새 담당은 `primary`, 이전 담당은 `auxiliary`다. 담당을 삭제해 재선택을 기다리는 상태면 남은 대화는 모두 `auxiliary`, 담당 ID는 `null`이다.
- 연결이 없으면 기존처럼 `exists=false`, `target=null`이다. 구버전 서버가 새 필드를 생략하면 **역할 미확인**으로 처리하며 담당이나 보조라고 추정하지 않는다.
- 조회는 MnP 저장 데이터만 사용한다. Aion 모델·런타임 추가 조회, 담당 자동 변경, 문서 저장을 수행하지 않는다. 위임 규칙에 따른 담당 자동 교체는 그룹 지시 접수 또는 하위 위임 실행 확인 시 처리한다.
- 응답은 `Cache-Control: no-store`다. Aion에서 별도로 캐시한다면 담당 변경 후 이전·새 담당 대화의 연결 정보를 다시 조회해야 한다. 이 API 추가만으로 Aion의 기존 제목이 자동 변경되지는 않는다.

## 같은 계정·디바이스 화면 선택

```http
POST /api/integrations/aionui/conversations/{conversationId}/mindnprogress/select
```

MindNProgress는 현재 SSE 연결 가운데 다음 조건을 모두 만족하는 화면에만 선택 이벤트를 보낸다.

- SSE 화면의 로그인 계정 ID가 MnP의 대화 연결 기록에서 결정한 계정과 같다.
- SSE 화면과 AionUi 브라우저의 정규화된 원본 접속 주소가 같다.

성공 응답은 `selected: true`, 선택 대상, 실제 이벤트를 받은 `deliveredClientCount`를 포함한다. MnP 화면은 이벤트를 받으면 문서와 카드 상세를 열고 카드 노드 선택 상태도 마우스로 클릭했을 때와 동일하게 갱신한다.

주요 실패 응답은 다음과 같다.

- `400 MNP_SELECTION_ACCOUNT_REQUIRED`: 대화 연결 기록과 신뢰 가능한 선택 헤더 어디에서도 MnP 계정을 결정할 수 없음
- `400 MNP_SELECTION_DEVICE_ADDRESS_INVALID`: 전달한 원본 접속 주소가 IP 주소가 아님
- `400 MNP_SELECTION_DEVICE_REQUIRED`: 비교할 디바이스 주소를 확인할 수 없음
- `403 MNP_SELECTION_ACCOUNT_UNAVAILABLE`: 계정이 없거나 비활성 또는 편집 권한 없음
- `403 MNP_SELECTION_ACCOUNT_MISMATCH`: 선택 헤더와 MnP 대화 연결 기록의 계정이 다름. GET과 POST 모두 해당
- `404 MNP_AI_CONVERSATION_NOT_FOUND`: 연결된 문서·카드를 찾을 수 없음
- `409 MNP_MATCHING_VIEW_NOT_CONNECTED`: 같은 계정·디바이스의 MnP 화면이 현재 연결되어 있지 않음

## 수신 메시지의 발신 대화 이동

다른 대화에 전달하는 전문에는 표시 전용 `MNP_CONVERSATION_SOURCE` 정보를 맨 앞에 붙인다. AionUi는 메시지 우상단에 발신 제목을 표시하고 해당 대화로 이동한다.

| 전달 경로 | 표시하는 대화 |
| --- | --- |
| 그룹 문서 지시의 신규·재개·대기 후 전달 | 지시한 그룹 총괄 대화 |
| 하위 카드 신규·재개·복구 위임, 체크포인트 보완, 통합 충돌 해결 요청 | 위임한 상위 대화 |
| 하위 결과의 이력 저장·상위 재개 보고, 복구 필요·통합 대기 알림 | 해당 하위 대화 |

요청은 `kind=delegation`, 보고·알림은 `kind=report`인 기존 표시 계약을 사용한다. 이 구분은 표시용이며 그룹 문서 지시를 worker 위임으로 바꾸거나 회신 대상·승인 범위를 변경하지 않는다. 회신 대상을 별도로 지정해도 발신 표시는 실제 지시한 대화를 가리킨다.

같은 머신의 대화는 내부에서 이동하고, 다른 머신은 발신 머신의 WebUI 주소를 사용한다. 제목 조회가 실패하면 ID를 표시한다. 다른 머신의 주소를 확인하지 못하면 이동을 비활성화하고 본문 전달은 유지한다. 하위 대화가 아직 생성되지 않은 통합 대기 알림은 발신 대화를 임의로 만들지 않는다.

사용자가 MnP 화면에서 직접 시작한 대화와 Dooray 자동 접수는 발신 AI 대화가 없으므로 표시 정보를 추가하지 않는다. 이전에 저장된 전문과 완료 보고의 고정 원문·해시는 다시 쓰지 않으며, 발신 정보 추가는 변경 반영 후 전달되는 전문부터 적용한다.

## 네트워크 경계

이 계약에서 디바이스 경계는 두 서비스가 관측한 원본 클라이언트 IP 주소다. 역방향 프록시는 신뢰할 수 있는 방식으로 실제 주소를 보존해야 한다. 같은 계정의 여러 물리 디바이스가 동일 NAT 공인 주소를 공유하는 환경까지 서로 구분해야 한다면 후속으로 두 앱이 공유하는 불투명 장치 ID 또는 페어링 토큰 계약이 필요하다.
