# MnP 저장 회귀와 성능 비교 기준

REQ-MNP-01이 확정한 02~07의 최소 검증 계약이다. 이번 01은 기존 결과의 원문·코드·시험 구성을 대조했으며, 아래 후속 동시 부하·장애 주입·화면 시험을 실행한 것으로 기록하지 않는다. 운영 서버 재시작·운영 자료 재구성·집중 호출은 하지 않았다.

## 재사용할 원본과 적용 범위

공통 원본 루트는 `C:/Git/MindNProgress/MindNProgress/server/data/_api-diagnostics`다.

| 원본 | 확인된 내용·적용 한계 |
|---|---|
| `run-2026-10-27T01-49-42-514Z.summary.txt` 및 report/analysis/grouped JSON | 운영 10:49:42.514~11:28:30.090 KST, 4,012 HTTP 요청·AI 식별 23개. AI 최대 61ms, Runner 제외 최대 211ms. 과거 timeout은 재현하지 못함. 운영 저장 유실의 증거가 아님. |
| `api-2026-10-27T01-42-19-100Z-60432.jsonl` | 위 운영 관측의 원본. 실제 로그는 기존 자료이며 이번에 계측을 다시 켜지 않음. HTTP 문자 수와 wire bytes, 전체 작업 시간과 서버 처리 시간을 혼동하지 않음. |
| `concurrency-20261027.routes.json` | 관측된 24개 HTTP 경로의 코드 추적. 전체 쓰기 경로 목록은 아니며 [추가 감사](audit-20261027.md)로 보완함. |
| `concurrency-20261027.result.json` | 2026-10-27 02:41:48.102 UTC 시작 격리 시험. 14종 조회+get_card와 같은 3 HTTP 묶음, 동시 1·10·20, 각 3회 묶음. 댓글·공유 지식 유실과 인위적 gate·remote 큐 대기. |
| `concurrency-20261027.confirm.json` | 02:43:27.337 UTC 시작. 새 문서로 10/20 조건 각각 추가 3회, 순차·batch·다른 문서 대조군. |
| `concurrency-20261027.mjs` 및 `--confirm` | 임시 데이터, 별도 Node 서버·루프백 포트, 모의 AionUi. 원본 result/confirm 이름에 다시 저장하므로 보존 원본을 덮어쓰는 방식으로 재실행하지 않음. 정식 테스트/비교 harness로 옮길 때 실행별 출력 경로를 사용. |

원문 SHA-256:

- result: `4c8007596ee8b4a7291b53c898e10bf65e2fb7d7859821e6c6004dad2b699b79`
- confirm: `1649242f327d82890ddbbe68aecb3e38dbe4cb10bc47559f219abc984a1993b6`
- routes: `95916e5aba931211b94fde242b0dfc73a7f2315338205d961d492740595e7012`

| 기존 쓰기 조건 | HTTP 성공 수 | 최종 저장 수 | 문서 버전 |
|---|---:|---:|---:|
| 댓글 동시 1/10/20 | 1/10/20 | 1/1/1 | 댓글만 바뀌므로 별도 문서 증가 없음 |
| 서로 다른 카드 지식 동시 1/10/20 | 1/10/20 | 1/1/1 | 모두 2 |
| 동일 문서 순차 20 | 댓글 20, 지식 20 | 각각 20 | 지식 21 |
| 지식 20카드 batch 1회 | 1 | 20 | 2 |
| 서로 다른 20문서 지식 동시 | 20 | 20 | 각 문서 2 |

confirm의 추가 3회 모두 댓글·지식 10/20 성공 대비 저장 1이었다. 이 결과는 동일 버전 전체 파일 RMW 경쟁을 보여준다. `content-patch`의 현재 Gx와 모든 GET에도 같은 유실이 발생했다는 결론은 아니다.

기존 조회 평균은 일반 문서 13.3/20.8/36.9ms, Ref 문서 15/45.8/68.2ms, 알림 27.8/176.5/350ms다(동시 1/10/20 순). localhost 응답 수신까지의 시간이며 운영 SLA·CPU 비용이 아니다. 빈 AI 위임 목록의 속도는 실제 이력이 있는 목록의 개선 기준으로 사용하지 않는다. 약 1.2초 body 지연을 이용한 gate 보유는 대기 전파 확인이며 과거 30초 timeout 원인을 입증하지 않는다.

## 동일 자료와 환경

변경 전 기준은 `10afee7`(추적 소스가 `29d70a5`와 동일), 변경 후는 승인된 통합 SHA를 사용한다. 원래 result와 새 결과를 직접 빼서 개선율을 내지 않는다. 변경 전·후 코드를 같은 harness와 아래 fixture로 다시 실행하는 것은 후속 07의 일이다.

1. 임시 루트의 합성 문서 96개, 문서당 카드 20개, 기존 원본 fixture 문자열·순서 유지. 대표 문서 `JSON.stringify` 길이는 151,642 문자, 댓글 100개, Ref는 원본 5문서에 연결한다. UTF-8 bytes는 별도 측정한다.
2. 각 쓰기 round는 버전 1의 새 fixture에서 시작하고 요청마다 독립 marker/ID를 쓴다. 하나의 round에 논리 변경 20개를 고정한다. 동시 1은 20개 순차, 10은 두 wave, 20은 한 wave이며, 각 조건을 새 자료로 3 round 실행해 동일하게 60개 표본을 확보한다. 성공한 처리량과 실패율을 같이 비교한다.
3. 읽기는 cold 1회와 warm-up 5회를 분리하고, warm 측정은 같은 총 요청 수 60개를 동시 1/10/20으로 수행한다. fixture·선행 cache 상태·조회 필드·댓글 page·Ref 수를 양 버전에서 일치시킨다. warm-up 결과는 latency 통계에 넣지 않는다.
4. 기존 빈 위임 목록 fixture는 기존 결과 재현용으로만 유지한다. 실제 비용 비교에는 완료 위임 200개(각 결과 본문 1,000문자)의 고정 이력 fixture를 양 버전에 추가한다. 실제 AI/Runner는 실행하지 않는다. 알림도 일정 조건 없음과 담당자/기한이 있는 카드 20개 조건을 나누고, 생성 이후 dedupe된 반복 GET을 구분한다.
5. OS·CPU 코어/모델·메모리·디스크·Node 실행 파일/버전, 소스 SHA, fixture bytes/hash, 환경 변수의 비밀값을 제외한 설정, timeout/queue/retry 값, 실행 시각·반복 순서·background 활성 여부를 manifest에 기록한다. 실제 Runner·AionUi discovery·운영 data와 token 경로를 사용하지 않는다.
6. baseline/candidate의 순서를 번갈아 실행하고 background 작업 설정을 같게 한다. 평상시 성능 셀에서는 실제 외부 대기·장애 주입을 섞지 않는다. 외부 지연·혼합 읽기/쓰기는 별도 셀로 표시한다. 같은 운영 자료의 시점 차이를 성능 개선으로 해석하지 않는다.

2MB·5MB·10MB 전체 소비자 전환 시험은 기존 별도 카드가 소유한다. 이번 분기의 기본 fixture를 그 시험으로 대체하거나 별도 카드 완료를 대신하지 않는다. 해당 대형 자료가 후속 통합에 제공되면 동일 계약 검증의 추가 자료로 재사용한다.

## 정식 회귀로 편입할 최소 집합

02는 기존 재현의 fixture와 저장 후 파일 대조를 `node:test`의 격리 API 회귀로 옮긴다. 이 표는 시험 계획이며 이번에 테스트 코드를 추가하지 않았다. 기존 시험의 권한·귀속·Ref·집계·백업·알림 검증을 재사용한다.

| 소유 | 필수 사례와 판정 | 재사용할 기반 |
|---|---|---|
| 02 | 댓글 1/10/20 전부 201·ID/본문 보존. review 10/20은 200 건수만큼 보존하고 나머지는 명시적 409 허용. 같은 문서의 댓글/본문/알림 혼합, 서로 다른 문서 병렬, 예약 backup·귀속 복구와 경쟁 | 기존 동시성 스크립트; `comments-api`, `shared-knowledge-audit-api`, `shared-knowledge-review-api`, `document-read-store` |
| 02 | source↔target 역방향 이동과 동시 저장, Ref 문서 추가/변경, archive/trash/restore/reconstruct/영구 삭제와 경쟁. 잠금 교착·부분 노출·유실 없음. 같은 문서 작업이 순서상 먼저 확정되면 전환 후보가 이를 포함하거나 충돌해야 함 | `cross-document-card-move-api`, `document-reconstruction-api`, `document-trash-review-api`, `trash-ai-records-api`, `group-project-api`, `card-layout-requests` |
| 03 | 독립 카드/필드 20개 모두 보존, 같은 필드에서 같은 before로 다른 값을 쓰면 승자 하나와 명시적 충돌. 관련 댓글/Ref/구조 변경 시 검토 read-set 충돌. 검토와 무관한 카드 변경으로 문서 버전만 증가해도 새 계약은 성공. 레거시의 엄격한 버전 검사와 호환 | `map-content-patch`, `map-content-patch-api`, `shared-knowledge-maintenance`, `merge-map-content`의 기존 의미 확인 |
| 04 | 동일 ID의 동시 20회·순차 재전송·응답 drop에서 한 번만 적용. 다른 내용/다른 scope 거부. reaction toggle·댓글 추가·revision·알림도 한 번. terminal+24h와 오래된 미등록 ID 거부를 가짜 시계로 검사 | 새 transaction/idempotency 시험; 기존 AI 위임 receipt 시험을 일반 저장 완료 근거로 대체하지 않음 |
| 04 | intent 전/후, commit marker 직전/직후, 각 canonical 파일 교체 사이, applied marker 직전/직후, 응답 직전/직후에 격리 서버 프로세스 종료. 재시작 후 결과 ID·파일·버전·effect 대조. redo 불일치 시 자원 격리 | journal 단계별 장애 주입. 다중 이동·복원·삭제·재구성 수습 포함. 정상 종료 시험만으로 crash 통과하지 않음 |
| 05 | 키당 128/전체 1,024 상한, 5/10초 대기, 대기자 취소, 시작된 저장의 연결 종료, 동일 논리 요청 최대 3회와 지연/전체 예산 준수. 느린 body는 문서 잠금 없음 | 자원 큐 단위 시험에서 가짜 시계/주입된 scheduler 사용. 운영 부하로 큐 포화를 만들지 않음 |
| 05 | 모의 AionUi/Runner 8초 지연·미연결·완료 이력 정리 중 무관한 문서 변경 20개가 5초 대기 예산 내 처리. 예약/작업공간 소유·재검증 유지 | 기존 1.2초 gate 대조와 RemoteWorkspacePool 큐 구조 재사용. 정상 25초 claim은 별도 long-poll 분류 |
| 06 | 1/10/20 조회에서 서버의 실제 전체 clone/Ref 확장/댓글 parse 횟수·HTTP 수·bytes 감소. 원본/댓글/Ref/권한/그룹 변경 즉시 무효화, 진행 중 read 교체·복구도 검사 | `document-read-store`, 카드·댓글/Ref/API 기존 시험; 비어 있지 않은 위임·일정 fixture |
| 07 | 위 모든 통합 사례와 권한·AI 귀속·Ref 원본 관리·체크리스트/Root 집계·대기 해제·revision·backup·알림·SSE·웹 동기화. 실제 화면의 저장/댓글/지식 반영·오류/재연결 흐름 확인 | `scripts/test-mcp.mjs`, 관련 API 테스트, 실제 웹 검수. 독립 검수자는 실제 통합 SHA에서 재실행 |

동시성은 우연한 timing에만 맡기지 않는다. 테스트에서 주입 가능한 저장 어댑터나 격리 harness의 barrier로 여러 요청이 같은 사전 상태를 관측하는 순서를 만들고, 기존 구현에서 실패하는 것과 새 구현에서 성공/충돌로 수렴하는 것을 확인한다. 테스트 hook을 운영 API의 무제한 지연 기능으로 추가하지 않는다. 실패에 대응하는 회귀만 보강하며 관계없는 테스트 전수 재실행을 이 계약의 새 완료 조건으로 만들지 않는다.

## 무결성 판정식

- `attempts`: 실제 HTTP 시도 수. 동일 ID 재전송도 포함한다.
- `logicalRequests`: 서로 다른 논리 ID 수. batch 한 요청은 1이다.
- `successResponses`: 200/201 확정 응답 수. replay 응답도 여기에 포함될 수 있다.
- `committedIds`: 최초/재조회/재전송으로 확정된 서로 다른 요청 ID 집합. 202는 포함하지 않는다.
- `expectedEffects`: committedIds의 연산별 예상 효과 집합. batch 1개가 20개 카드 효과를 가질 수 있다.
- `actualEffects`: 권위 파일과 새 HTTP 조회에서 확인한 ID·내용 해시·버전·effect 집합.

합격은 `actualEffects == expectedEffects`이고, 모든 성공 응답의 ID가 committedIds에 있으며, 거부된 변경의 효과가 0이고, 같은 ID의 버전/댓글/알림/revision 중복이 없는 것이다. 응답 drop은 결과 확인 뒤 committedIds에 포함한다. 완료되지 않은 processing/unknown이 남으면 성공으로 세지 않는다. 문서 단일 변경 N개의 최종 버전은 초기+실제 내용 변경 N, 댓글만 변경하면 문서 버전은 유지다. batch/no-op/replay는 무조건 요청 수만큼 버전을 올리지 않는다.

이후 합법적인 수정·삭제·이동·보관은 앞선 성공을 지우는 유실과 구분한다. 이 경우 직렬화된 transaction 순서와 이전/이후 해시·revision·이동 결과를 대조한다. 예를 들어 저장 성공 뒤 승인된 삭제가 확정되면 활성 파일에 없다는 이유만으로 유실 판정을 하지 않지만, 삭제의 확정 근거 없이 사라진 성공은 실패다.

## 성능 판정과 보고

API별 HTTP 시도/논리 요청/확정 수, 요청·응답 UTF-8 bytes, queueWait·lockHold·persist·externalWait, 응답 수신 p50/p95/max, 오류 코드별 개수, 재시도 횟수, 프로세스 CPU user/system·RSS peak, 실제 저장 효과를 함께 기록한다. p95는 정렬한 표본의 `ceil(0.95*N)-1` 값을 사용하며 N을 붙인다. Node 프로세스 CPU는 코어 하나 100% 기준인지 전체 코어 정규화인지 명시한다. 모델 사고·사용자 대기는 API 처리 지연에 합산하지 않는다.

무결성 실패 셀은 개선 판정에서 탈락한다. 저장 1개만 남아 빠른 baseline과 정상 저장 20개의 시간을 단순 개선율로 비교하지 않는다. 실제 확정 효과당 비용·처리량을 함께 보고한다. 읽기 개선은 동일 내용에서 HTTP/bytes/전체 문서 처리의 실제 감소와 p95·최대·CPU·메모리를 보여야 한다. 저장 무결성 때문에 증가한 동기화 비용은 분리해서 설명한다.

사전에 임의의 전체 성능 향상률을 필수 SLA로 추가하지 않는다. 05의 기한과 무결성 판정은 반드시 통과해야 하며, 06의 대상 비용이 실제로 줄었는지 양 버전의 같은 fixture 측정으로 판정한다. 처리 수·내용을 줄여 만든 속도나 빈 위임 fixture만의 개선은 인수하지 않는다.

01의 완료 근거는 작성 경로 감사, 확정 계약, 이 비교/판정 조건과 원문 대조다. 02~07 실행 결과·정전 내구성·과거 운영 timeout 원인은 이번 01의 완료로 승계하지 않는다.
