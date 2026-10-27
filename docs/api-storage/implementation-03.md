# REQ-MNP-03 변경 대상별 충돌 판정

출발 커밋은 `9af4521ea59deb476602109a630e7652dc910cd8`이다. [공통 계약 3·8절](contract-v1.md), [작성 경로 감사](audit-20261027.md), [회귀 기준](regression-baseline.md)과 [02 구현](implementation-02.md)을 재사용한다. 이 문서는 03 구현자의 자체 검증 범위이며 운영 배포나 07 독립 통합 인수를 뜻하지 않는다.

## 감사 결과와 적용 경계

| 기존 경로 | 출발 코드의 판단 | 03 적용 |
|---|---|---|
| content-patch | 전체 baseVersion만 검사 | 선택적 preconditions로 카드·필드·필수 읽기 집합 검사. 조건 없는 기존 요청은 엄격한 버전 검사 유지 |
| MCP 카드 변경·지식선 | 일부 도구가 VERSION_CONFLICT 후 재조회·변경 재계산 | 최초 원문에서 만든 patch·기대값 고정. 필드·의존 충돌을 자동 반복하지 않음 |
| MCP 본문 부분 수정 | MCP의 UTF-8 SHA와 경계 유일성 검사 뒤 서버 버전 검사 | 기존 검사 유지. 원래 textOperations도 전송하여 서버 보호 구간에서 SHA·경계·계산 결과 재검증 |
| 공유 지식 검토 | 문서 버전과 본문 SHA | 검토 context token으로 설명·종류·Ref·직접 관계·관련 카드·댓글·원본 출처를 함께 검사 |
| 댓글 변경 | 본문 expectedText 선택 조건, 나머지는 잠금만 사용 | 요약/상세/레거시 본문 해시, 이전 해결 상태, 해당 actor/emoji membership, 삭제 대상+답글 집합 조건 |
| 전체 PUT·이력/일일 백업 복원 | PUT 버전 선택 조건, 복원에는 요청 조건 없음 | 전체 교체는 버전·수명주기 필수, 복원은 선택 스냅샷 해시도 필수. 기존 복원 호출부에서 전달 |

검사는 `withStorageRequest`의 권위 읽기·문서/Ref 잠금 안에서 수행한다. 후보는 최신 문서에 적용하고 `saveMap(expectedVersion=현재 보호 중 버전)`으로 기존 저장·귀속·집계·이력·백업·알림·SSE 경계를 사용한다. `storageResources.mjs`와 `storageChanges.mjs`의 잠금·확정·복구 보장은 변경하지 않았다.

## content-patch 입력

기존 `{baseVersion, patch}`에 선택적 `preconditions`와 `textOperations`를 추가했다. 기존 patch 형식·경로·도구 이름은 유지한다. 서버와 MCP는 `server/lib/contentPreconditions.mjs`를 공유한다.

`createContentPreconditions(before, patch)`는 다음을 생성한다.

- `schemaVersion:1`, `mapId`, `lifecycleVersion`.
- `nodeOrder`·`edgeOrder`: 변경 전 ID 배열의 정규 JSON SHA-256. 새 요청이 순서를 실제로 바꿨는지 판정하는 기준이다.
- `cards`: 카드별 `cardId`, `identity`(type·kind·reference의 존재/값 해시), `fields`.
- 각 필드 조건은 `scope:'node'|'data'`, `field`, `expected`다. 속성 없음은 `{exists:false}`, 존재는 `{exists:true,encoding,sha256}`다. 문자열은 `encoding:'utf8'`로 실제 원문을 해시한다. 다른 JSON 값은 `encoding:'canonical-json'`으로 객체 키를 정렬하고 배열 순서를 유지한다. 없음/null과 문자열/JSON 값은 서로 다르다. 유니코드 정규화는 하지 않는다.
- status·progress·checklist·waitingItems·isWork 중 하나를 변경하면 완료/대기 해제 판단에 쓰는 해당 필드 집합도 필수 조건이다. 실제 변경 필드나 카드 identity 조건을 누락하면 400으로 거부한다. 호출자는 판단에 사용한 추가 필드도 `cards[].fields`에 전달할 수 있다.

독립 필드 요청은 최신 카드·관계 배열 순서를 보존한다. node/edge 추가·삭제, edge 변경, 실제 순서 변경, 종류·Ref·isWork·blockedBy 변경은 구조 변경으로 분류하여 `baseVersion`까지 일치해야 한다. 이 단계에서는 구조 변경의 독립 병합을 약속하지 않는다. 카드 identity나 필드가 바뀌었으면 전역 버전과 관계없이 충돌한다.

`textOperations`에는 `cardId`, `field`, 원래 `expectedSha256`, 기존 `operation`을 전달한다. 서버는 보호 구간에서 원문 해시, `replace_once`·`replace_between`의 유일한 경계, 계산 결과와 patch의 일치 여부를 확인한다. MCP가 원래 해시를 최신 해시로 바꾸거나 force로 우회하지 않는다.

## 검토 문맥

기존 review-context 응답에 `reviewContextToken`과 직접 관계의 Ref 원본 `sources`를 추가했다. 토큰은 버전 1의 불변 읽기 조건 객체다. 인증 토큰이나 재시도 ID가 아니다.

토큰은 map/card/lifecycle과 `dependencies`의 card·relations·relatedCards·comments·sources 해시를 포함한다. 선택 카드의 label·description·kind·reference·taskUrl·재구성 출처·공유 지식과 검토/작성 메타데이터, 직접 연결 edge와 관련 카드, 해당 카드의 전체 댓글 집합을 검사한다. Ref 원본은 보호 중 원본 카드와 수명주기·댓글을 읽고 출처로 함께 제공한다. 일부 댓글·관련 카드만 응답에 표시돼도 전체 필수 집합을 보수적으로 보호한다. 문서 version·무관한 카드·서버 갱신 시각은 의존성에 포함하지 않는다.

기존 reviews 요청의 각 patch에 조회 당시 토큰을 그대로 붙인다. 모든 patch에 토큰이 있으면 무관한 문서 버전 증가는 허용한다. 하나라도 토큰을 생략하면 기존 엄격한 baseVersion 검사가 적용된다. 본문 SHA 검사는 항상 유지한다. 준비와 모든 조건 검사 후에만 전체 batch를 저장하므로 한 카드라도 충돌하면 모두 변경 없이 거부한다.

## 댓글·전체 변경과 호환

댓글 HTTP 입력은 `expectedContentSha256`, `expectedResolvedSha256`, `expectedReacted`, `expectedDeleteSha256`를 동작별로 선택 확장했다. 본문 해시는 summary·detail·text·contentFormat의 존재와 값을 포함한다. 해결 해시는 resolvedAt/By, 반응은 인증된 actor의 해당 emoji 가입 여부, 삭제는 대상과 모든 답글의 순서·내용을 검사한다. 다른 댓글의 추가 자체는 본문 충돌이 아니다. MCP는 한 번 읽은 조건을 보내며, 호출자가 제공한 기대값을 우선 보존한다. 조건 없는 기존 HTTP 댓글의 동작은 유지한다.

기존 문서 전체 PUT은 `baseVersion`과 `baseLifecycleVersion`이 필수다. 이력·일일 백업 복원은 두 값과 `expectedSnapshotSha256`이 필수다. 이력 목록·일일 백업 목록/미리보기의 `snapshotSha256`은 실제 복원하는 정규화된 스냅샷의 digest다. 조건이 없으면 `400 CONTENT_PRECONDITION_REQUIRED`, 달라지면 변경 전 409다. 외부 HTTP 전체 저장/복원 소비자는 이 입력을 전달해야 한다. 명시적 사용자 덮어쓰기인 기존 `force=true`는 별도로 유지하며 MCP는 사용하지 않는다.

MCP 이력 복원은 명시한 기대값을 보존하고, 생략한 경우 호출 시작의 현재 버전·수명주기와 지정 이력 해시를 한 번 고정한다. 웹 변경은 이력/일일 백업 복원 두 호출의 조건 전달과 응답 타입 확장에 한정했다. 웹 자동저장 전체 전환·충돌 후 내 변경 유지·2MB/5MB/10MB 전체 인수는 이 작업의 결과가 아니다.

## 충돌 응답과 후속 접점

HTTP 409와 기존 `VERSION_CONFLICT`, `TEXT_HASH_MISMATCH`, 검토 오류, `DOCUMENT_ARCHIVED`를 유지한다. 새 조건 충돌은 `reasonCode`, `conflicts:[{resource,cardId?,field,expected,current,kind}]`, `outcome:'not-applied'`, `retryable:false`를 반환한다. reasonCode는 `FIELD_CONFLICT`, `READ_DEPENDENCY_CHANGED`, `LIFECYCLE_CONFLICT`다. 새 조건의 응답에는 현재 본문 대신 해시·버전·존재 여부만 포함한다. 기존 content-patch 소비자용 레거시 버전 충돌의 map 응답은 유지한다.

MCP `apiRequest`와 `registerTool`이 이 판정을 보존한다. 충돌은 재조회 후 새 의도 판단의 근거이며 동일 논리 변경의 기대값을 자동 교체하는 근거가 아니다. 04는 이 read-set과 변경 내용을 요청 digest에 포함하고, 05는 비재시도 충돌 의미를 유지해야 한다. 04 journal·중복 방지·응답 유실 결과 조회와 05 전체 대기/재시도 설계는 구현하지 않았다.

## 검증과 재현

실행 명령·환경·소스 및 결과 해시·실제 통과/실패·미실행 범위는 [검증 기록](validation-03-20261027.json)에 보존한다.

- `content-preconditions-api`: 96문서×20카드, 댓글 100개, Ref 원본 5문서의 격리 자료. 독립 카드·동일 카드의 독립 필드·서로 의존하지 않는 검토를 각각 동시 1/10/20, 새 fixture 3회, 회당 20개로 실행한다. 540건 모두 성공·보존되고 매 회차 버전 21이다. 파일 교체 barrier와 같은 before를 사용한다. 검토용 독립 집합은 직접 관계가 없으며, 관계가 있는 경우는 별도의 의존 충돌 시험에서 검증한다.
- 같은 필드 경쟁은 승자 1/명시적 충돌 1이다. 설명·종류·관계·관련 카드·댓글·Ref 원본 변경은 검토 충돌, 무관한 카드 변경은 허용한다. 거부 전후 map·댓글·이력·일일 백업·알림 파일과 새 조회를 대조한다. 실제 보관/복원에 따른 lifecycle 증가, 전체 복원의 버전·원본 해시, 레거시 409, 텍스트 경계도 검사한다.
- `content-preconditions-mcp`: 실제 stdio MCP와 격리 HTTP 사이의 제어 가능한 전달 프록시가 같은 버전의 20개 요청을 모아 전달한다. 독립 20건 보존, 같은 필드 및 관계 경쟁의 전송 2회·성공 1·충돌 1, 원래 텍스트 해시/검토 토큰 전달과 비재시도를 검사한다.
- 기존 02 concurrency/lifecycle/resources와 관련 API·모듈 회귀를 재사용한다. 02의 레거시 검토 성공 보존 및 나머지 명시적 409 기대값은 완화하지 않았다. 전체 PUT을 준비에 쓰는 시험에는 새 lifecycle 입력만 추가했다. 도구 60개 수는 유지하며 입력 확장에 맞춰 스키마 fixture를 갱신했다.

```powershell
node --test --test-concurrency=2 tests/content-preconditions.test.mjs tests/content-preconditions-api.test.mjs tests/content-preconditions-mcp.test.mjs
npm run test:mcp
npm run lint -- server tests scripts src mcp runner
npm run build
```

운영 데이터·token·실제 Runner, 운영 재시작/배포, 원격 푸시·Dooray 기록은 사용하지 않았다. 실제 브라우저 전체 인수·07 독립 검수·전체 성능 비교는 미실행이다. 단일 API 프로세스라는 02 지원 조건과 영속 journal 부재에 따른 한계는 그대로다.
