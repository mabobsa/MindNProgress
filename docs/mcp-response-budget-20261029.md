# MCP 응답 크기 예산: get_context·update_card (2026-10-29)

## 배경

AI 클라이언트는 큰 MCP 응답을 그대로 받지 못한다. Claude Code는 25,000토큰(MnP JSON 실측: 48,499자 통과, 56,289자 초과)을 넘는 결과를 파일로 저장하고, AI는 그 파일을 스크립트로 읽는다. Codex는 결과 객체를 코드로 받지만 출력이 중간에서 잘린다. 2026-10-07~29 대화 기록(읽기 전용 집계)에서 두 도구의 상황은 다음과 같았다.

| 도구 | 클라이언트 | 호출 | 중앙값 | 90% | 48k자 초과 |
|---|---|---:|---:|---:|---:|
| `get_context` | Claude | 221 | 106,527자 | 305,622자 | 169건(76%) |
| `get_context` | Codex | 994 | 38,375자 | 121,475자 | 166건(17%) |
| `update_card` | Claude | 312 | 24,230자 | 170,224자 | 98건(31%) |
| `update_card` | Codex | 1,346 | 35,901자 | 42,900자 | 88건(7%) |

`get_context`는 모든 대화의 첫 호출이고 규칙(`guide`)이 들어 있다. 응답이 파일로 저장되면 규칙도 파일 안에만 있게 되고, 저장 파일을 열지 않고 진행한 사례가 29건 있었다.

## 원인

- **`get_context`**: 규칙 문구(`guide`, 위임·조사 규칙, `nextStep`)만 2.3만~3.1만 자다. 가장 큰 데이터는 주요 선행 지식(`selection.knowledgeSources.primary`)으로, 원천마다 카드 원문 전체를 담아 초과 사례 기준 중앙값 4만 자, 최대 58만 자였다. 다음이 선택 카드 본문(중앙값 1.4만 자, 90% 4.1만 자)이다.
- **`update_card`(affected)**:
  - 변경 전 문서는 Ref 원본이 투영된 조회본(GET)이고, 저장 API(`content-patch`)는 투영하지 않은 저장본을 돌려준다(`server/index.mjs`). 둘을 그대로 비교해 바뀌지 않은 Ref 카드가 모두 "server-adjusted"로 잡혔고, 저장본에 남은 오래된 사본이 반환됐다. 초과 사례의 서버 조정 카드 908장 중 861장이 Ref였다. 크기 문제이자 정확성 문제다.
  - 요청 카드가 `card`와 `affectedCards`(reason=`requested`)에 두 번 들어갔다(84/84건).
  - 요청 카드와 서버 조정 카드 모두 바꾸지 않은 큰 필드까지 원문 전체를 돌려줬다.

## 원칙

- 규칙 원문은 첫 응답에 그대로 둔다([롤백 교훈](ai-guidance-rollback-2026-10-01/rollback-cause-record.md)). 줄이는 것은 데이터뿐이다.
- 생략한 내용은 경로·이유·회수 도구를 응답에 표기한다(`get_document` outline의 `omitted`와 같은 방식).
- 회수 경로의 응답도 한도 안에 들어와야 한다.
- 한도 안의 응답은 바꾸지 않는다.
- 성공 기준은 문자 수 절감이 아니라 한도 초과 없이 규칙과 필수 데이터가 첫 응답에 도착하고 행동 평가가 나빠지지 않는 것이다.

## 변경

### Ref 비교 수정 (`mcp/affectedCards.mjs`, `server/lib/referenceProjection.mjs`)

- 투영 필드 목록(`REFERENCE_CONTENT_KEYS`)과 `projectReferenceNodeData`를 서버와 MCP가 같이 쓰는 모듈로 옮겼다. 서버 동작은 같다.
- 변경 카드 판정은 Ref 카드의 투영 필드와 `label`을 빼고 비교한다. 위치·참조 대상 같은 로컬 변경은 그대로 잡는다.
- 응답의 Ref 카드는 같은 문서 원본이면 저장 후 값을, 다른 문서 원본이면 조회 시점 투영값을 쓴다.
- 공용 함수라 `add_card`·`update_card`·`move_card`·`delete_card`의 affected 응답에 함께 적용된다.

### `update_card` affected 응답

- 요청 카드는 `card`에만 둔다.
- `card.data`는 이번에 보낸 필드와 저장 중 바뀐 필드(진행률·상태·대기 등)를 원문으로 준다. 바꾸지 않은 1,000자 초과 필드는 생략하고 `card.omittedFields`와 `card.textIntegrity`로 알린다. 바꾼 원문은 그대로 오므로 "저장 후 원문을 읽어 대조" 규칙은 응답만으로 충족된다.
- `affectedCards`는 서버가 함께 조정한 다른 카드의 상태 요약(`label`·`kind`·`status`·`progress`·`isWork`)과 `changedKeys`만 준다.
- 생략이 있으면 `omitted`(생략 경로·규칙·`get_card` 회수 인자)를 붙인다.
- 기본값 `full`은 바꾸지 않았다. 실제 호출은 거의 모두 `affected`이고(Claude 314/314, Codex 1,345/1,346), 기본값을 바꾸려면 `guide` 문장을 고쳐야 한다.

### `get_context` focused 예산 (`mcp/contextBudget.mjs`)

최종 응답(그룹 메타데이터 포함)이 4만 자(`CONTEXT_RESPONSE_BUDGET_CHARS`)를 넘을 때만 아래 순서로 줄이고, 들어오면 멈춘다. `detailLevel=full`은 그대로다.

| 순서 | 단계 ID | 줄이는 데이터 | 회수 경로 |
|---|---|---|---|
| 1 | `knowledgeSourceSupplements` | 주요 선행 지식의 설명·댓글·보조 필드(sharedKnowledge·상태는 유지) | `get_card` |
| 2 | `knowledgeSourceIndex` | 선행 지식 항목을 색인으로(ID·제목·정책·상태·본문 길이) | `get_card` |
| 3 | `knowledgeLinksScope` | 선택 카드와 무관한 문서 지식선(개수만 남김) | `get_document` |
| 4 | `waitingDetails` | 관계·개요 카드의 대기 상세(개수로), 최상위 카드 선택 시 개요와 겹치는 `descendants` | `get_document` |
| 5 | `recentComments` | 선택 카드 댓글을 최근 5건으로 | `list_comments` |
| 6 | `outlineFields` | 문서 개요를 `id`·`label`·`parentId`·`status`·`progress`로 | `get_document` |
| 7 | `knowledgeSourceSharedKnowledge` | 선행 지식 sharedKnowledge(뒤 원천부터, 예산에 들 때까지) | `get_card` |
| 8 | `selectionComments` | 선택 카드 댓글 전체 | `list_comments` |
| 9 | `outline` | 문서 개요 전체 | `get_document` |
| 10~11 | `selectedDescription`·`selectedSharedKnowledge` | 선택 카드 description, sharedKnowledge | `get_card` |
| 12 | `selectedLargeFields` | 선택 카드의 2,000자 초과 보조 필드(checklist·waitingItems 제외) | `get_card` |

- **항상 남기는 것**: `guide` 전문, `groupProject`, `aiAttribution`, 문서 메타·`stats`, 선택 카드의 상태·`checklist`·`waitingItems`·`blockedBy`·`textIntegrity`, `selection.taskLinks`(startupInspection 포함), `selection.aiWorkCoordination`, `knowledgeSources.rule`과 모든 원천의 ID·정책·상태, `selection.commentsPage`, `teamMembers`, `nextStep`.
- **표기**: 줄였을 때만 `detailLevel` 바로 뒤에 `contextBudget`(`limitChars`·`focusedChars`·`returnedChars`·`appliedSteps`·`exceeded`)과 `omitted`(`fields`·`counts`·`cardIds`·`selectedCardFields`·`cardAccessUrlTemplate`·`notOmitted`·`rule`·`retrieval`)를 둔다. 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이게 하기 위해서다.
- **`exceeded`**: 규칙과 색인만으로 예산을 넘으면 모든 단계를 적용한 뒤 `exceeded=true`로 알린다. 규칙은 줄이지 않는다.
- `contextSchemaVersion`을 3.4로 올렸다. 예산 안의 응답은 이 값 외에는 같다.
- 예산은 그룹 메타데이터를 붙인 최종 응답에 적용한다(`registerTool`의 `finalizeResult`). 그래서 `returnedChars`가 실제 응답 크기와 같다.

### `get_card` 회수 인자

- `fields`: 지정하면 `label`과 그 data 필드만 반환한다. `textIntegrity`는 항상 전체 description·sharedKnowledge 기준이다.
- `includeComments=false`: 댓글 본문 없이 `commentsPage.total`만 반환한다.
- 인자를 주지 않으면 기존과 같다. `get_context`의 `omitted.retrieval`이 이 인자를 안내한다.

### 도구 설명

`get_context`·`get_card`·`update_card`는 기준선 설명 문장을 그대로 두고 생략·회수 안내만 뒤에 덧붙였다. 코드로 필드를 꺼내는 AI가 생략된 경로를 조용히 빈 값으로 읽지 않도록 생략될 수 있는 필드를 이름으로 밝혔다(`tests/mcp-instruction-surface.test.mjs`).

## 호환성과 배포

- 바뀌는 코드는 MCP 쪽이다. 서버는 투영 필드 목록의 위치만 옮겼다. 그래서 서버와 MCP 버전이 어긋나도 동작이 깨지지 않는다.
- 이미 열린 대화는 MCP를 다시 연결할 때부터 적용된다.
- Codex가 생략된 경로를 코드로 읽으면 `undefined`가 된다. 응답 앞쪽 `omitted`, 도구 설명, 같은 경로 유지(`textIntegrity.*.length` 등)로 줄였고 행동 평가로 확인했다.

## 검증

### 테스트

- 새 테스트
  - `tests/mcp-affected-cards.test.mjs`: Ref 비교, 응답 Ref 투영, 서버 조정 요약, 요청 카드 축소.
  - `tests/mcp-context-budget.test.mjs`: 예산 안 그대로 반환, 단계 순서·조기 중단, 생략 기록·회수 인자, `exceeded`.
  - `tests/mcp-response-budget-mcp.test.mjs`: 실제 MCP와 격리 API로 큰 문맥 축소, `get_card` 회수(길이·SHA-256 대조), 작은 문맥 무변경, Ref 오탐 없음, Ref 직접 수정 시 투영값을 확인.
- 관련 테스트 16개 파일 104건(직렬): 통과. `npm run test:mcp`: 통과. 변경 파일 `oxlint`: 경고 없음.
- `npm run test:unit`: 1,585건 중 실패 5건.
  - 4건은 `65704ea` 기준선의 기존 실패다(`ai-limit-workspace-recovery` 2건, `card-layout-api`, `sub-machine-routing-api`).
  - 1건(`storage-concurrency-api` "댓글·검토 1/10/20 동시 요청")은 병렬 실행 중 동시 20건 구간의 `LOCK_WAIT_TIMEOUT`이었다. 직렬 재실행에서 6/6 통과했다. 이번 변경은 저장·댓글 경로를 바꾸지 않았다.
- 지침 fixture: 도구 설명 699자, 입력 스키마 설명 2개(`get_card`의 새 인자)가 늘었다. 고정 fixture의 `get_context` 응답 크기는 그대로다.

### 운영 데이터 사본 측정 (읽기 전용)

운영 `server/data`에서 문서·댓글·그룹·이미지 파일만 임시 폴더로 복사해 격리 서버를 띄웠다. 개정 전(`ae3b60b`)과 개정 후 MCP로 같은 카드를 호출했다. Dooray·세션·연동 토큰·작업공간 파일은 복사하지 않았고, 측정 후 사본을 지웠다.

- 대상: 활성 문서 52개. 문서마다 최상위 카드, 들어오는 지식선이 있는 카드 전부, 설명이 긴 업무 카드 3장.
- `update_card`는 현재 상태 값을 그대로 보내는 무변경 호출로 쟀다. 서버가 저장하지 않으므로 응답 구성만 비교한다.
- 휴지통 문서(조회 404)와 보관 문서(변경 거부 `DOCUMENT_ARCHIVED`)는 제외했다.

| 도구 | 개정 | 호출 | 중앙값 | 90% | 최대 | 48k자 초과 |
|---|---|---:|---:|---:|---:|---:|
| `get_context` | 전 | 464 | 68,770자 | 177,593자 | 341,602자 | 359건(77%) |
| `get_context` | 후 | 464 | 37,949자 | 39,783자 | 44,169자 | 0건 |
| `update_card` | 전 | 412 | 26,013자 | 159,936자 | 312,833자 | 162건(39%) |
| `update_card` | 후 | 412 | 3,426자 | 4,562자 | 6,229자 | 0건 |

- 개정 후 `get_context`는 391건에 축소가 적용됐다. 선택 카드 설명은 464건 중 252건(54%)에서 첫 응답에 남았다.
- 규칙과 색인만으로 4만 자를 넘은 경우(`exceeded`)는 20건이고, 최대 44,169자였다.

### 행동 평가

[행동 평가 체크리스트](ai-guidance-rollback-2026-10-01/behavior-evaluation-checklist.md)에 따라 도구 설명 변경 전후를 같은 모델로 비교했다. 실행 원본은 저장소 밖 `C:\Git\MindNProgress\behavior-eval-response-budget-20261029`에 있다.

- **방식**: 그룹 문맥 평가 하네스를 카드 단위 대화로 바꿔 썼다. 실행마다 합성 문서·가짜 AionUi·격리 MnP 서버를 띄웠고 운영 MnP·Dooray에는 연결하지 않았다.
- **모델**: Claude 개인 Max(`C:\Users\NHN\.claude-max`) `claude-opus-5-5`, Codex `gpt-6-astra`(AionUi와 같은 exec 코드 모드, MnP 도구 자동 승인). 사고 강도 xhigh 12회, high 8회.
- **fixture**: 선택 카드에 선행 지식 12개, 댓글 22건, 형제 카드 15장, Ref 6장(저장본에 예전 사본)을 두었다. 개정 전 `get_context`는 110,130자(Claude는 파일 저장), 개정 후는 38,886자(선행 지식 원문 12개 생략)였다. 판별 단서는 원문 한 곳에만 둔다: F1 선택 카드 설명, F2 앞쪽 원천, F3·F4 뒤쪽 원천.
- **시나리오**: BEH-15(신규, 축소된 문맥에서 생략 원문을 반영한 계획), BEH-12(체크리스트 한 항목 수정 후 확인), BEH-11(새 결론 없는 검증 완료).

| 시나리오 | 사고 강도 | Claude 전 | Claude 후 | Codex 전 | Codex 후 |
|---|---|---|---|---|---|
| BEH-15 축소된 최초 문맥의 원문 회수 | xhigh / high | 통과 / 통과 | 통과 / 통과 | 통과 / 통과 | 통과 / 통과 |
| BEH-12 최초 문맥 바인딩 후 대상별 조회 | xhigh / high | 통과 / 통과 | 통과 / 통과 | 통과 / 실패 | 통과 / 통과 |
| BEH-11 공유 지식 갱신 조건 | xhigh | 통과 | 통과 | 통과 | 통과 |

개정 후 판정이 개정 전보다 나빠진 시나리오는 없다.

- **개정 후 AI는 생략 표기를 따라 원문을 회수했다.** BEH-15 4회 모두 생략된 원천 12개를 `get_card(fields)`로 읽었고(뒤쪽 원천 포함), 네 단서를 근거 카드와 함께 반영했다. `get_context` 재호출이나 `full` 조회로 돌아간 실행은 없었다.
- **개정 전 Claude는 매번 저장 파일을 처리했다.** 실행당 파일 처리 호출이 5~11회였고 평균 3.3분이 걸렸다. 개정 후는 평균 1.6분이었다.
- **Ref 오탐은 실제로 AI를 헷갈리게 했다.** Claude 개정 전 BEH-12 xhigh는 저장 응답의 Ref 6장이 예전 제목·`planned`로 보이자 따로 다시 조회했다.
- **`omittedFields`를 삭제로 해석하거나 생략된 필드를 다시 보낸 실행은 없었다.** 모든 `update_card` 호출이 `checklist`만 보냈고, 설명·공유 지식은 모든 실행에서 그대로였다.
- **Codex 개정 전 BEH-12 high의 실패**: 카드를 이미 읽은 뒤 저장 직전에 `get_context`를 다시 호출했다(금지 행동).
- **이번 변경과 무관한 관찰**: Codex는 개정 전후 모두 형식에 맞지 않는 `requestId`를 넣어 두 번 거부된 뒤 성공했다(`update_card`·`manage_comment`).
- **판정 보정**: Claude 개정 전 BEH-15 high는 F3를 '이월' 대신 '다음 날 배치로 넘어갑니다'로 써서 자동 키워드 검사가 놓쳤다. 최종 응답 원문으로 확인해 통과로 판정했다.
- **사용량**: Claude 10회 환산 $12.04(Max 한도에서 차감), Codex 10회 입력 534만 토큰(캐시 476만), 출력 2.9만 토큰.
- **평가의 한계**: 조합마다 1회만 실행했고 합성 데이터다. Claude 평가 권한은 지난 평가와 같다(`dontAsk`, Bash는 python·node 등 일부만 허용). 그래서 개정 전 파일 처리 방식은 실제 AionUi 대화와 다를 수 있다. BEH-07(최종 회신)은 실행하지 않았다.

## 한계와 후속

- 규칙이 큰 문맥은 더 줄일 수 없는 최소 응답도 4만 자를 넘는다(운영 측정 20건, 최대 44,169자). 규칙은 줄이지 않는다.
- 큰 문맥에서는 선행 지식 원문을 원천 수만큼 `get_card`로 따로 읽으므로 호출 수가 늘어난다.
- 단일 필드가 4.8만 자 안팎인 카드는 `fields`로 나눠 받아도 그 필드 하나가 한도를 넘을 수 있다.
- `list_comments`, `get_card` 기본 응답, `get_document`의 `full`·`compact` 크기는 범위가 아니다. `get_document`의 `outline`과 `list_ai_delegations`는 아래 후속 절에서 다룬다.

## 후속: `get_document` outline 예산

### 배경과 원인

- 2026-10 대화 기록에서 `get_document`는 Claude 파일 저장 187건, Codex 5.6만 자 초과 1,717건으로 가장 많았다.
- 기본 `full`은 문서 전체를 주는 계약이다(`mcp/documentViews.mjs`: 기존 응답과 바이트 단위로 같아야 한다). 백업·전수 감사에 쓰이므로 바꾸지 않는다.
- 구조 파악용 `outline`도 운영 문서 74개 중 11개에서 4.8만 자를 넘었다(최대 1,045,284자). 원인은 문서마다 다르다.
  - 큰 비원문 필드: JP-게임룸 · 인게임 v0.3의 `requirementsLedger` 55만 자 등
  - 대기 메모 원문: 감사 문서들의 `waitingItems` 4만~7.5만 자
  - 카드별 `textIntegrity`, 공유 지식 갱신 기록, 지식선
- `get_context` 예산이 생략한 문서 개요의 회수 경로가 `outline`이라, 큰 문서에서는 회수 경로도 한도를 넘었다.

### 변경 (`mcp/documentViews.mjs`)

`outline` 응답이 4만 자(`OUTLINE_RESPONSE_BUDGET_CHARS`)를 넘을 때만 아래 순서로 줄이고 예산 안에 들면 멈춘다. 서버가 만든 응답에 MCP가 그룹 메타데이터·로컬 이미지 경로를 덧붙이므로 1천 자를 여유로 둔다.

| 순서 | 단계 ID | 줄이는 데이터 |
|---|---|---|
| 1 | `largeFields` | 원문 이외의 2천 자 초과 필드(카드별 `omittedFields`에 이름) |
| 2 | `integrityLengths` | `textIntegrity`의 SHA-256(길이는 유지) |
| 3 | `metadataFields` | 공유 지식 갱신·검토 기록, 재구성 출처, 외부 링크 미리보기 |
| 4 | `mediumFields` | 원문 이외의 500자 초과 필드 |
| 5 | `waitingNotes` | 대기 메모 원문(큰 카드부터, 예산에 들 때까지) |
| 6 | `waitingCounts` | 대기 항목을 개수로(큰 카드부터) |
| 7 | `minimalCards` | 카드를 id·계층·제목·상태만으로(큰 카드부터, `minimal=true`) |
| 8 | `knowledgeLinks` | 지식선 목록(개수만 남김) |

- 구조(`cards[]`의 id·`parentId`·`childCount`), 상태·진행률, `cardIds`로 고른 카드 전문(`selectedCards`)은 줄이지 않는다. 고른 카드 전문만으로 예산을 넘으면 개요를 줄이지 않고 `exceeded=true`와 함께 `cardIds`를 줄이라고 안내한다. 줄여도 어차피 한도를 넘어 정보만 잃기 때문이다.
- 대기 메모는 재개를 제한하는 조건을 담을 수 있으므로 늦은 단계에서만 줄인다. 줄였을 때는 대기 재개·완료·위임 판단 전에 원문을 확인하라는 안내와 `retrieval.cardFields`(`get_card` `fields`)를 붙인다.
- 줄였을 때 `view` 바로 뒤에 `responseBudget`(`limitChars`·`originalChars`·`returnedChars`·`appliedSteps`·`exceeded`)을 두고 `omitted.fields`·`counts`·`notOmitted`·`retrieval.cardFields`를 갱신한다. MCP는 최종 응답 기준으로 `returnedChars`를 다시 맞춘다.
- `DOCUMENT_VIEW_FORMAT`을 4로 올려, 이전 형식으로 받은 `documentEtag`가 새 응답과 맞지 않게 했다.
- `get_document` 도구 설명은 기준선 문장 뒤에 `outline` 예산 안내만 덧붙였다. `get_context`의 생략 안내 문구도 `outline`이 예산을 지킨다는 내용으로 고쳤다.
- `outline`은 서버가 만들므로 운영 반영에는 서버 재시작이 필요하다. 서버와 MCP 버전이 어긋나도 응답이 스스로 설명하므로 동작은 깨지지 않는다.

### 측정 (운영 문서 파일, 읽기 전용)

| 범위 | 개정 전 중앙값 | 개정 전 최대 | 4.8만 자 초과 | 개정 후 최대 | 개정 후 초과 |
|---|---:|---:|---:|---:|---:|
| 휴지통 제외 74개 | 21,852자 | 1,045,284자 | 11개 | 38,840자 | 0개 |
| 활성 52개 | 11,867자 | 1,045,284자 | 7개 | 38,840자 | 0개 |

- 예산 적용 19개(활성 9개), `exceeded` 0개. 4만 자 안의 문서 55개는 그대로다.
- 대기 메모가 많은 감사 문서는 큰 카드부터 필요한 만큼만 줄여 3.8만 자 안팎까지 원문을 유지했다(예: JP 감사 · 누락 33항목 112,084자 → 38,348자).

### 행동 평가

개정 전은 `f401193`(이 절 이전 변경까지 포함), 개정 후는 이 변경을 더한 작업 트리다. 실행 원본은 저장소 밖 `C:\Git\MindNProgress\behavior-eval-outline-budget-20261029`에 있다.

- **시나리오 BEH-03(넓은 요청의 대상 분모 확인), 문서 단위**: 문서의 모든 대기 항목을 메모·재개 조건과 함께 빠짐없이 보고하게 했다(카드·댓글 수정 금지).
- **fixture**: 카드 36장에 대기 항목 50개(라벨 W-01~W-50)를 두었다. 대기 메모가 가장 긴 카드 네 곳의 메모에만 판별 단서 P1~P4를 두었다. 개정 전 `outline`은 74,763자, 개정 후는 37,954자다(메모 20개 생략, P1·P2 생략, P3·P4 유지).
- **모델**: Claude 개인 Max `claude-opus-5-5`, Codex `gpt-6-astra`(exec 코드 모드), 사고 강도 xhigh·high. 8회.

| 사고 강도 | Claude 전 | Claude 후 | Codex 전 | Codex 후 |
|---|---|---|---|---|
| xhigh | 통과 | 통과 | 통과 | 통과 |
| high | 통과 | 통과 | 통과 | 통과 |

- 8회 모두 대기 항목 50/50개와 총수(50건)를 보고했고, 판별 단서 네 개를 원문 그대로 옮겼다. 쓰기는 없었다.
- **Codex 개정 후**는 예산이 적용된 `outline`(38,365자)을 받은 뒤 메모가 생략된 카드 10장만 `get_card(fields=["waitingItems"])`로 읽어 P1·P2를 회수했다. 개정 전은 75,174자 `outline`(또는 93,696자 `compact`)을 객체로 받았다.
- **Claude**는 개정 전후 모두 "빠짐없이" 요청에 원문을 모두 담는 `compact`를 먼저 골라 파일 저장 뒤 카드 36장을 `get_card`로 읽었다. 개정 후 high 1회만 `cardIds` 12장으로 `outline`을 더 조회했다(38,979자, 한도 안).
- **사용량**: Claude 4회 환산 $6.01(Max 한도에서 차감), Codex 4회 입력 128만 토큰(캐시 108만), 출력 1.6만 토큰.
- **한계**: 조합마다 1회, 합성 데이터다. Claude는 `cardIds` 없는 `outline`을 고르지 않아, Claude가 메모 생략 응답을 받은 경우는 평가하지 못했다.

## 후속: 단계 중간 판정 보정 (`get_context`·`outline`)

`list_ai_delegations` 예산을 측정하다가 발견했다. 같은 구조인 앞의 두 예산에도 같은 문제가 있었다.

- **원인**: 카드·원천을 하나씩 줄이는 단계는 줄일 때마다 크기를 다시 잰다. 그런데 이때 재는 응답에 그 단계의 생략 기록이 빠져 있었다.
  - `get_context`의 `knowledgeSourceSharedKnowledge`: 생략 안내(`fields`)와 단계 ID를 반복이 끝난 뒤에 붙였다.
  - `outline`의 카드별 단계: 단계 ID만 빠졌다.
  - 그 결과 예산에 든 것으로 판정한 응답이 실제로는 기록만큼 컸다.
- **영향**:
  - `get_context`에서는 다음 판정에서 예산을 넘은 것으로 보고, 필요 없는 다음 단계(선택 카드 댓글·개요 생략 등)까지 적용했다. 최종 크기는 한도 안이었다.
  - `outline`은 단계 ID 몇십 자만큼 후처리 여유분(1천 자)을 잠식했다.
- **수정**:
  - 단계 ID를 먼저 `appliedSteps`에 넣고 시작한다. 줄인 것이 없으면 뺀다.
  - 생략 기록은 줄일 때마다 남긴 뒤 크기를 잰다.
- **테스트**: 여러 규모를 훑는 테스트를 추가했다. 이전 코드에서 실패하는 것을 확인했다.
  - `get_context`: 원천 원문이 남았는데 다음 단계까지 줄였는지를 본다.
  - `outline`: 후처리 여유분을 남겼는지를 본다.

## 후속: `list_ai_delegations` 예산

### 배경과 원인

2026-10-07~29 대화 기록을 읽기 전용으로 집계했다(행동 평가 세션 제외).

| 클라이언트 | 호출 | 중앙값 | 90% | 최대 | 4.8만 자 초과 |
|---|---:|---:|---:|---:|---:|
| Claude | 320 | 12,902자 | 116,223자 | 1,488,720자 | 66건(21%) |
| Codex | 4,793 | 24,450자 | 53,058자 | 527,608자 | 1,592건(33%) |

- 응답은 문서(또는 카드)의 위임 기록 전체다. 위임마다 작업공간 결과, lease, 판정 사유, 지시 미리보기를 담는다. `includeResult=true`이면 결과 원문(최대 12,000자)도 담는다.
- 운영 기록 599건 중 593건(99.0%)이 정리된 이력이다(완료 584, 대체 7, 종료 2). 나머지 6건은 실패다.
- 대상 카드 348장 중 137장(39%)에 위임이 2건 이상 쌓였다(최대 14건). Codex 호출의 54%가 `includeResult`와 `targetCardId`를 함께 쓴다. 그래서 카드 이력만 조회해도 한도를 넘었다.
- 응답의 `requestFailures`(접수 실패 기록)도 줄이지 않았다. 문서 하나에 재접수가 확인된 기록 38건(49,516자)이 쌓여, 위임이 1건인데도 응답이 55,306자였다.

### 변경 (`mcp/delegationBudget.mjs`)

응답이 4만 자(`DELEGATION_RESPONSE_BUDGET_CHARS`)를 넘을 때만 정리된 이력을 아래 순서로 줄인다. 예산 안에 들면 멈춘다.

| 순서 | 단계 ID | 줄이는 데이터 |
|---|---|---|
| 1 | `olderSettledResults` | 카드별 최신이 아닌 정리된 위임의 결과 원문(`resultHash`·길이 유지, `resultOmitted=true`) |
| 2 | `settledRequestFailureSummaries` | 정리된 접수 실패를 요약으로(ID·카드·사유 코드·시각·재접수 위임 ID·`retryVerification.state`·`method`) |
| 3 | `olderSettledSummaries` | 카드별 최신이 아닌 정리된 위임을 요약으로(ID·상태·카드·대화·시각·보고 상태·결과 해시, `summary=true`) |
| 4 | `settledRequestFailuresRemoved` | 오래된 정리된 접수 실패를 목록에서 빼고 문서/카드별 개수만 남김 |
| 5 | `latestSettledResults` | 카드별 최신 정리된 위임의 결과 원문 |
| 6 | `latestSettledSummaries` | 카드별 최신 정리된 위임을 요약으로 |
| 7 | `oldSettledRemoved` | 오래된 정리된 위임을 목록에서 빼고 문서/카드별 개수만 남김 |

- **줄이지 않는 것**: 판단이 필요한 위임과 미해결 접수 실패다.
  - 위임: 미종료·실패·복구 가능(`recovery.recoveryAvailable`)·종료 처리 가능(`closure.closeAvailable`)·보고 대기(`reportPending`), 그리고 표시 상태가 저장 상태와 다른 위임
  - 접수 실패: `retryVerification.state`가 `confirmed`·`closed`가 아니거나 `retryReference`가 있는 기록
  - 이 둘은 원문과 결과를 그대로 둔다. 상위 AI의 복구·재접수·수신 확인 판단 근거이기 때문이다.
- **"카드별 최신"**: `mapId/targetCardId`마다 가장 최근의 정리된 위임이다. 검토에서 가장 먼저 읽는 보고라 마지막까지 결과를 남긴다.
- **표기**: 줄였을 때 `mapId` 바로 뒤에 `responseBudget`과 `omitted`를 둔다.
  - `responseBudget`: `limitChars`·`originalChars`·`returnedChars`·`appliedSteps`·`exceeded`
  - `omitted`: `fields`·`counts`·`resultOmittedDelegationIds`·`removedByTarget`·`removedRequestFailuresByTarget`·`rule`·`retrieval`
  - `returnedChars`는 그룹 메타데이터를 붙인 최종 응답 크기와 같다.
- **회수 경로**:
  - 새 인자 `delegationId`로 위임 한 건을 조회한다. 이 조회는 줄이지 않는다.
  - 서버(`GET /api/maps/:id/ai-delegations?delegationId=`)와 MCP가 함께 거른다.
  - 접수 실패는 그 위임을 요청했거나 그 위임으로 재접수가 확인된 기록만 준다.
  - 목록에서 뺀 이력은 `targetCardId`로 카드별로 조회한다.
- **도구 설명·안내**:
  - `list_ai_delegations` 도구 설명은 기준선 문장 뒤에 예산 안내만 덧붙였다.
  - 그룹 문맥 요약(`server/lib/groupContextSummary.mjs`)의 위임 회수 안내에 `delegationId`를 더했다.

### 테스트

- `tests/mcp-delegation-budget.test.mjs`(새 테스트): 판정 기준, 예산 안 무변경, 단계 순서와 카드별 최신 유지, 개수화, 접수 실패 축소, 여러 규모의 최종 크기를 확인한다.
- `tests/mcp-response-budget-mcp.test.mjs`: 실제 MCP와 격리 API로 다음을 확인한다.
  - 카드 이력 축소
  - `delegationId` 회수(줄이지 않은 원문)
  - 연결된 접수 실패만 반환
  - 복구 위임 유지
- `npm run test:mcp`: 통과.
- `npm run test:unit`: 1,588건 중 실패 4건. `65704ea` 기준선의 기존 실패 4건과 같다.
- 변경 파일 `oxlint`: 경고 없음.

### 측정 (운영 데이터 사본, 읽기 전용)

운영 `server/data`에서 문서 파일, 위임 기록, 접수 실패 기록, 그룹 파일만 임시 폴더로 복사해 격리 서버를 띄웠다. 개정 전(`4fd6700`)과 개정 후 MCP로 같은 조회를 했다. 연동 토큰·세션·Dooray 파일은 복사하지 않았고, 측정 후 사본을 지웠다.

| 조회 | 개정 | 호출 | 중앙값 | 90% | 최대 | 4만 자 초과 | 4.8만 자 초과 |
|---|---|---:|---:|---:|---:|---:|---:|
| 문서 전체 | 전 | 37 | 51,017자 | 118,686자 | 284,488자 | 23 | 21 |
| 문서 전체 | 후 | 37 | 21,381자 | 34,502자 | 39,574자 | 0 | 0 |
| 문서 전체 + 결과 | 전 | 37 | 71,136자 | 150,728자 | 398,921자 | 26 | 24 |
| 문서 전체 + 결과 | 후 | 37 | 22,840자 | 37,066자 | 39,890자 | 0 | 0 |
| 카드별 + 결과(위임 2건 이상) | 전 | 118 | 9,669자 | 34,436자 | 129,442자 | 10 | 6 |
| 카드별 + 결과(위임 2건 이상) | 후 | 118 | 9,669자 | 28,477자 | 39,342자 | 0 | 0 |

- 4만 자 안의 응답은 그대로다. `exceeded`는 0건이다.
- 예산이 적용된 응답은 55건(문서 전체 조회, 결과 포함·미포함)이다.
  - 오래된 위임을 목록에서 뺀 경우는 5건이고, 나머지는 결과 생략·요약에서 멈췄다.
  - 정리된 접수 실패는 14건에서 요약했고, 7건에서 목록에서 뺐다.
- `get_context`가 실패해 위 표에서 빠진 문서 1개는 따로 쟀다. 접수 실패 기록이 큰 그 문서다. 55,306자에서 39,949자가 됐다. 운영 데이터가 측정 중에도 바뀌므로 수치는 측정 시점 기준이다.
- 첫 측정에서 개수화 단계가 끝난 응답이 40,128자·40,170자로 한도를 넘었다. 원인은 개수 기록과 안내를 마지막 크기 판정 뒤에 붙인 것이었다. 이를 고치면서 위 "단계 중간 판정 보정"도 함께 찾았다.

### 행동 평가

개정 전은 `4fd6700`, 개정 후는 이 변경을 더한 작업 트리다. 실행 원본은 저장소 밖 `C:\Git\MindNProgress\behavior-eval-delegation-budget-20261029`에 있다.

- **시나리오 BEH-09(반복 보완의 중단), 이력 검토형**: 상위 AI에게 한 카드의 위임 이력을 검토하게 했다. 요청은 다음 세 가지이고, 위임·복구·수신 확인·카드 수정은 금지했다.
  - 회차별 결론 코드·달성 결과·남은 문제를 빠짐없이 정리한다.
  - 같은 남은 문제가 반복됐는지 밝힌다.
  - 지금 판단이 필요한 위임이 있는지 밝힌다.
- **fixture**:
  - 완료 위임 12회차(결과 원문 약 4,800자씩)와 복구가 필요한 13회차를 두었다.
  - 반복(8~10회차)은 오래된 결과 원문에만 있다.
  - 개정 전 카드 조회는 74,865자다. 개정 후는 23,852자로, 1~11회차 결과 원문이 생략되고 12·13회차는 유지된다.
- **모델**: Claude 개인 Max `claude-opus-5-5`, Codex `gpt-6-astra`(exec 코드 모드), 사고 강도 xhigh·high. 8회.

| 사고 강도 | Claude 전 | Claude 후 | Codex 전 | Codex 후 |
|---|---|---|---|---|
| xhigh | 통과 | 통과 | 통과 | 통과 |
| high | 통과 | 통과 | 통과 | 통과 |

- **결과**: 8회 모두 다음을 보고했다.
  - 1~12회차 결론 코드 12/12와 각 결과·남은 문제
  - 8~10회차의 같은 남은 문제
  - 13회차가 `recovery-required`(권장 `resume-existing`)라 판단이 필요하다는 점
  - 복구·위임·수신 확인·카드 수정은 없었고, 데이터는 그대로였다.
- **개정 후** 네 실행 모두 `omitted.resultOmittedDelegationIds`의 11건을 `delegationId`로 한 건씩(각 약 6,360자) 읽었다. 생략된 회차를 추측하거나 건너뛴 실행은 없었다.
- **개정 전 Claude**는 저장 파일을 처리했다(파일 처리 호출 5~8회). 두 실행 모두 원문 전체를 읽지 못했다고 스스로 밝혔다.
  - xhigh: "13~10회차는 직접 읽었고, 나머지 회차는 … 필드를 뽑아 읽었습니다"
  - high: "셸을 쓸 수 없어 … 패턴 검색으로 확인했습니다"
- **개정 전 Codex**는 `includeFullResult`를 붙인 74,865자 응답을 객체로 받아 코드로 정리했다.
- **시간·사용량**:
  - Claude: 개정 전 1.7~2.5분, 개정 후 1.3~1.4분. 비용은 개정 후가 회당 $0.10~0.21 많았다(4회 환산 $4.69, Max 한도에서 차감). 회수 조회 11회가 대화에 더해졌기 때문이다.
  - Codex: 개정 전 1.1~1.9분, 개정 후 1.3~2.2분. 입력 토큰은 개정 후가 12~18% 많았다(4회 입력 115만, 캐시 96만, 출력 1.0만 토큰).
- **관찰**: Claude 개정 후 high는 첫 문장에 "9~13회차 … 모두 읽었습니다"라고 잘못 썼다. 표와 조회 기록은 1~13회차 전부다.
- **한계**: 조합마다 1회, 합성 데이터다. 접수 실패 축소는 행동 평가에 포함하지 않았고 단위·E2E 테스트로만 확인했다.
