# REQ-MNP-04 저장 요청 중복 방지·결과 확인

담당 카드: `node-mvq4frgn-55c83c`. 기준 커밋: `75217e476fa94a65d4bb8143b1f52f5f9ee09af9`.
확정 기준은 [공통 계약 4·5절](contract-v1.md), [원래 회귀 계약](regression-baseline.md)이며 02의 자원 잠금·후보 집합과 03의 원문·읽기 조건을 재사용한다. 구현자 자체 검증이며 상위 인수와 07의 독립 통합 검수는 별도다.

## 저장과 복구 경계

`server/lib/storageJournal.mjs`가 데이터 루트의 `_storage-transactions`를 관리한다. 요청 ID의 SHA-256 또는 임의 transaction ID별 디렉터리에 after-image, `intent.json`, `commit.json`, `applied.json`, 후속 효과 완료 기록을 저장한다. 거부 결과는 변경 없는 `terminal.json`으로 기록한다. 결과의 원본은 journal이며 메모리 인덱스는 시작할 때 재구성한다.

1. 02의 `storageChanges` 후보 집합에서 변경된 모든 파일, before/after 해시, 자원 키, 원래 응답, 후속 효과를 준비한다. revision과 기존 알림 참조의 이동·삭제도 같은 집합에 속한다.
2. after-image와 intent를 임시 파일에 쓰고 닫은 후 교체한다. commit marker는 intent 해시를 포함한다. marker 교체의 성공 여부가 불확실하면 실제 marker를 다시 확인한다.
3. 유효 marker 이전에는 정본을 바꾸지 않는다. marker 이후에는 rollback하지 않고 redo한다. 정본 전체가 before 또는 after 해시인지 먼저 검사하고, after-image를 반영한다. 일시 I/O 오류는 같은 잠금 안에서 한 번 redo하며 계속 실패하면 `RECOVERY_REQUIRED`로 격리한다.
4. 파일·필수 revision 반영 후 applied marker를 기록한다. 캐시를 무효화하고 이후 자원 작업을 허용한다. 응답은 이 경계 뒤에 전송하며 결과에는 변경 파일별 해시, 문서 version 및 lifecycleVersion을 제공한다.
5. 시작 복구는 인증 자료 로드, migration, scheduler, HTTP listen보다 먼저 실행한다. marker가 없으면 준비 기록을 정리하고, marker만 있으면 redo하며, applied가 있으면 재반영하지 않는다. 임의의 다른 정본은 덮지 않는다. 격리된 문서는 조회·쓰기에서 차단하고 무관한 문서는 계속 제공한다.

잠금 순서 `catalog → doc → state → notification`과 같은 자원의 RMW 보호를 유지한다. 영구 삭제, 여러 문서 사이의 카드 이동, 이력·일일 백업 복원, 재구성의 관련 파일도 이 경계를 사용한다. 재구성 orchestration의 기존 preparing 복구는 journal 복구 이후 실행한다. 이력 복원은 원본 문서의 생성자·생성 시각을 보존하여 다음 시작 migration이 확정된 정본을 다시 바꾸지 않게 했다.

정본 교체 중 문서 조회는 자원 잠금 또는 진행 상태 검사로 중간 파일을 노출하지 않는다. 목록 조회는 교체 epoch를 대조한다. 그룹 문맥에 들어가는 메모리 위임·문서 지시 상태도 해당 state 읽기 잠금으로 확정 이후에 조회한다. 이는 journal I/O가 늘면서 드러난 기존 메모리 상태 선노출 회귀를 막는다.

## 후속 효과

`storageChanges.effect`는 transaction ID·효과 종류·대상·순서로 안정 effect ID를 만든다. 새 알림과 자동 일일 백업은 원래 journal에 payload와 함께 남긴다. 각각의 데이터 RMW와 처리 사실은 effect별 하위 journal의 한 커밋으로 묶으며, 부모는 그 완료를 별도로 확인한다.

- 알림 ID는 effect ID에서 유도한다. 최대 200개 표시 목록에서 알림이 빠져도 하위 journal을 근거로 재생성을 막는다. 알림 확정 뒤 부모 확인 기록 전에 종료되어도 동일하다.
- 이미 있는 알림의 참조 이동·삭제는 본 변경의 필수 부분이다. 알림 저장소가 손상된 상태에서 댓글만 삭제하고 성공을 반환하지 않는다.
- 오래된 자동 백업의 재개는 현재 같은 날짜 백업의 version을 확인하며 최신 백업을 덮지 않는다. 삭제된 원본의 자동 백업을 다시 만들지 않는다.
- 실패한 후속 효과는 `sideEffectsPending`에 남는다. 시작 시와 60초 주기의 재개 작업이 journal을 사용한다. 부모의 미완료 효과가 있는 동안 부모·하위 기록을 정리하지 않는다.
- SSE는 확정 뒤 안정 `id:`와 payload의 `eventId`를 발행한다. 중복 전달은 가능하며 재연결 시 최신 snapshot을 조회한다. 네트워크 단일 전달은 보장하지 않는다.

## HTTP 요청과 결과

기존 저장 경로에 `Idempotency-Key: mnpw:{13자리 시각}:{32자리 소문자 hex}`를 추가한다. `X-MNP-Result-Only: 1`은 같은 인증·scope로 기존 결과만 조회하며 변경 본문이 필요하지 않다. 미등록 ID를 조회해도 저장을 시작하지 않는다.

digest는 HTTP method·경로·query, 원래 본문과 preconditions/read-set, 실제 편집자·대화·귀속 scope를 포함한다. 이미지 업로드는 바이너리 해시와 content type을 포함한다. 갱신되는 인증 token 자체는 포함하지 않는다. MCP의 원래 도구 의도 해시는 `X-MNP-Intent-Digest`로 함께 확인한다.

매 재전송·결과 조회에서 현재 인증과 편집 권한을 확인한다. 삭제된 문서의 결과도 journal에 보존된 scope로 보호한다. 같은 ID에 다른 내용은 `409 REQUEST_ID_REUSED`, 다른 scope는 결과를 포함하지 않는 `404 REQUEST_NOT_FOUND`다. 저장된 조건 충돌은 같은 ID로 조회·재전송해도 최신 기대값으로 바뀌지 않는다.

| 상태 | 응답과 의미 |
| --- | --- |
| 확정 | 기존 200/201 및 `outcome: committed`, requestId, transactionId, resources, replayed, sideEffectsPending. 같은 논리 결과를 재사용하며 최신 문서가 필요하면 별도 조회한다. |
| 처리·복구 중 | `202 REQUEST_PROCESSING`, `outcome: processing`, 같은 ID와 retryAfterMs. 격리된 복구는 `503 RECOVERY_REQUIRED`다. |
| 변경 전 거부 | 기존 4xx 및 `outcome: not-applied`, reasonCode, retryable=false. 확정된 조건 거부는 영속 보존한다. |
| 미확인 | 결과 조회의 `404 REQUEST_UNKNOWN`, `outcome: unknown`. MCP의 응답 유실도 unknown이며 실패 확정으로 해석하지 않는다. |
| 기간 종료 | `410 REQUEST_EXPIRED`, outcome=unknown. 새 ID로 자동 재실행하지 말고 권위 자원에서 결과를 대조한다. |

새 ID는 서버 기준 과거 24시간부터 미래 5분까지 허용한다. 미래 경계 초과는 `400 REQUEST_TIME_INVALID`다. 결과는 terminal 이후 최소 24시간 보존하고 ID 자체도 생성 허용 기간 밖으로 지난 뒤 정리한다. 처리·복구 중 또는 후속 효과 미완료 기록은 기간만으로 지우지 않는다. 보관 결과가 존재하면 생성 시각이 오래됐어도 같은 결과를 조회할 수 있다. 정리된 옛 ID는 새 저장으로 실행되지 않는다.

## MCP 호환 확장

`mcp/storageRequests.mjs`는 기존 저장 도구 23개의 논리 요청을 감싼다. 전체 도구 수는 60개로 유지한다. 일반 호출은 기존 입력 검증과 첫 성공 응답의 형태를 유지하면서 확정 정보가 추가된다. `resultOnly: true`에서는 requestId만 필수이며 본문 필드가 없어도 조회한다. 일반 저장에서 기존 필수 필드가 빠지면 여전히 거부한다.

첫 HTTP 저장 전에 논리 ID와 실제 전송 본문·원래 기대값을 `_mcp-write-intents`에 보존한다. 같은 프로세스의 동시 호출은 같은 ID별로 대기하고, 프로세스 간 최초 준비 파일은 덮어쓰지 않고 하나만 게시한다. MCP가 재시작되어도 준비된 전송을 재사용하며 handler를 다시 실행해 최신 원문·조건을 만들지 않는다. local cache가 있어도 서버에서 현재 권한과 결과를 먼저 확인한다. 서버의 expired 응답을 local cache로 우회하지 않는다.

배치·재구성 제안 도구는 기존에 업무 대상에 `requestId`라는 이름을 사용했다. 호환 규칙은 다음과 같다.

- 기존 `{ requestId: 제안대상ID, baseRevision, plan }` 호출을 그대로 허용한다. 응답의 기존 requestId도 보존하고 논리 저장 ID는 `storageRequestId`로 제공한다.
- 명시적인 새 호출은 `{ requestId: mnpw형식ID, proposalRequestId: 제안대상ID, baseRevision, plan }`다. 이 응답의 requestId는 논리 ID이며 제안 대상은 proposalRequestId다.
- 결과 조회는 `{ requestId: 논리ID, resultOnly: true }`로 수행한다. 기존 호출의 storageRequestId도 이 위치에 사용할 수 있다.

변환된 MCP 결과가 local cache에 있으면 원래 형태로 반환한다. 응답 유실로 변환 결과를 저장하지 못했거나 다른 MCP 머신에서 조회하면 서버 journal의 확정 HTTP 결과를 반환한다. 이 경우 transactionId·resources·원래 저장 결과를 기준으로 판정하며, 전체 최신 문서가 필요하면 기존 조회 도구를 사용한다.

HTTP에서 요청 ID를 생략한 레거시 호출도 저장·복구 journal을 사용하지만 서로 다른 호출의 중복 실행 방지는 보장하지 않는다. MCP도 호출자가 ID를 보존하지 않고 매번 새 호출하면 다른 논리 요청이다. ID 없는 HTTP 응답 형태는 유지된다. 외부 AionUi/Runner 실행, AI 위임 자체의 전역 단일 실행은 이번 일반 저장 보장에 포함하지 않는다.

## 검증·변경 분리

실행 명령, 환경, 대상 소스 해시, 로그 해시, 초기 실패와 해결, 미실행 범위는 [검증 기록](validation-04-20261027.json)에 기록했다. 모든 장애·부하 시험은 임시 데이터 루트·루프백 포트·모의 외부 서비스에서 수행했다.

- HTTP 동일 ID 동시 20회·순차·응답 유실에서 문서·revision·댓글·반응·알림을 한 번 적용했다. 다른 내용·scope, 현재 권한 회수, token 갱신, resultOnly도 확인했다.
- 제어 가능한 시계로 생성 허용 경계, terminal+24시간, 미완료 보존과 정리 후 재실행 금지를 검사했다.
- intent 전후, commit 직전·직후, 정본 교체 사이, applied 직전·직후, 응답 직전·직후에 SIGKILL하고 재시작했다. 다중 이동 11개, 이력 복원 3개, 영구 삭제 8개, 재구성 2개의 각 정본 파일 교체 뒤 종료를 검사했다. 파일은 기록된 after-image 해시와 대조했다.
- 실제 stdio MCP의 20회 재전송, 응답 drop, 서버·MCP 재시작, 최초 전송 미도달 후 원래 읽기 조건 보존을 검증했다. 기존 60개 도구 종합 시험과 관련 API·02·03 회귀, lint·빌드를 수행했다.
- 다른 업무의 대화 연결·웹 캐시 변경은 시작 원문과 diff를 보존했다. 기준 커밋의 archive에 담당 변경만 올린 격리 사본을 검증했으며, 공통 server/index.mjs는 시작 원문을 기준으로 담당 변경만 분리했다. 기존 진단 원본은 수정하지 않았다.

지원 조건은 데이터 루트당 콘텐츠 작성 API 한 프로세스이며, 장애 검증은 OS·디스크가 유지되는 서버 프로세스 종료·재시작까지다. 정전·OS crash 내구성, 운영 배포, 실제 외부 실행, 05의 기한·대기열 설계, 06 조회 최적화, 07 통합 인수 및 별도 웹 전체 전환은 이번 완료 주장에 포함하지 않는다.
