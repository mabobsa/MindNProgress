# 승인된 지침 롤백 검증 보완 결과 (2026-10-01)

## 담당·출발 상태와 승인 경계

06의 문서 326에 기록된 승인 계약과 AUDIT-UTF8-01 / AUDIT-GUIDANCE-02만 구현했다. 승인 출처는 사용자 “보완 진행하자.” 및 “완료되면 커밋하고 푸시해줘.”다. 과거 전체 롤백의 push 제외 이력과 이번 루트의 push 승인은 별개다. 07 독립 판정과 최종 main 통합·원격 push는 루트/07 소유이며 여기서 수행하지 않았다.

- 후보: C:\Git\MindNProgress\.rollback-guidance-20261001 / rollback/mnp-guidance-20261001.
- 시작 HEAD: 84e8add0b9127230826a2b101e594a106033705d, clean. .ai-workspace.json / .ai-session.json 없음, 등록 worker lease 없음.
- 구현 커밋: 398168c9f5f2d8e3f077ac33273d6effbe8baa4b.
- 구현 커밋 시각: 2026-10-01 19:10:26 +0900 (10:10:26 UTC). 제목은 “[김용민] 지침 롤백 검증의 UTF-8 수집과 초기 전달 비교 보완”, 한국어 [배경]/[원인]/[수정], Co-Authored-By 없음.
- 이 보고서와 새 로그·해시 근거는 별도 증거 커밋으로 보존한다. 그 커밋은 검사 소스를 바꾸지 않으며 정확한 최종 HEAD·커밋 시각·clean은 06 결과 댓글과 인계 응답으로 확정한다.
- 완료된 rb06-* 7개는 과거 완료 이력으로 보존하고 supp06-* 3개만 이번 수행 결과로 갱신한다. 다른 카드/Ref와 Dooray를 작성하지 않았다.

## AUDIT-UTF8-01

변경 파일은 scripts/collect-child-output.mjs, scripts/verify-guidance-rollback.mjs, tests/collect-child-output.test.mjs다.

- 실제 runner가 사용하는 collectChildOutput은 stdout/stderr에 각각 StringDecoder를 둔다. Buffer 청크를 독립적으로 toString해서 누적하거나 양 스트림을 하나의 바이트 디코더로 섞지 않는다.
- 각 스트림의 end에서 잔여 바이트를 flush한다. child exit가 아니라 stdio 종료 뒤의 close를 기다리고, end가 관측되지 않은 경우에도 close에서 한 번만 flush한다. exitCode와 signal을 보존하고 spawn/pipe 오류는 성공으로 바꾸지 않는다.
- 합친 로그는 스트림별 디코더가 완성된 문자열을 내보낸 순서다. 서로 다른 pipe의 실제 쓰기 총순서를 보장하지는 않으며, 각 스트림 원문과 유효한 UTF-8 문자를 보존한다.
- runner는 main 진입 가드로 import 부작용을 없앴다. 새 로그는 supplement-logs의 새로운 runId로만 저장하고 로그 파일에는 wx를 적용해 같은 이름을 덮어쓰지 않는다.
- 회귀 이름: 각 스트림의 한글·다중 바이트 모든 분할 경계, 양 스트림의 모든 분할 경계 교차 및 한 바이트 교차, exit 이후 출력과 양 end를 close까지 대기, 종료 잔여 바이트 단일 flush·빈 출력·signal, 실제 자식 프로세스 종료 직전 양 pipe 대량 출력, spawn 오류 거부, runner import 무부작용.
- 종료 불완전 UTF-8과 spawn 오류는 의도적 입력이며 기대된 flush/거부를 assertion으로 확인한다. 유효한 한글/다중 바이트 출력에 대한 손실 허용이나 조건·timeout 완화가 아니다.

## AUDIT-GUIDANCE-02

변경 파일은 tests/initial-guidance-restoration.test.mjs다. scripts/capture-guidance-evidence.mjs 및 기존 fixture/증거 원문은 변경하지 않았다.

실제 captureInitialResponses(root, temp)의 선택 응답 leaf / group-coordinator / document-coordinator에서 다음 전체 값을 저장된 Git 기준선 baseline 응답과 deepEqual한다.

- selection.taskLinks.startupInspection
- nextStep
- groupProject.instruction
- selection.aiWorkCoordination.childDelegation

양쪽 모두 경로의 각 필드가 own property로 존재하고 null/undefined나 빈 값이 아님을 먼저 검사한다. 네 시나리오의 이름·수·순서를 각각 명시된 목록과 비교한다. read-me-first에는 위 네 필드가 없는 기존 계약을 그대로 검사한다. 기존 guide/groupGuide 원문 equality·SHA와 의미 assertion, 실제 GET-only 격리 호출은 모두 유지했다.

반례는 실제 호출 결과의 복제본과 기존 baseline 복제본에만 적용한다. 각 선택 시나리오·필드의 actual 누락, baseline 누락, 양쪽 동시 누락을 거부한다. 각 필드의 문구 변경, 시나리오 누락·이름·순서 변경, read-me-first 필드 추가도 거부한다. 이 검출은 assert.throws의 통과 근거이며 실제 테스트 실패나 운영 응답 변경이 아니다. 저장 응답 audit만으로 live 호출 회귀를 대체하지 않았고 기준선을 재생성하지 않았다.

## 실제 실행 기록

모든 실행은 node scripts/verify-guidance-rollback.mjs로 새 스트림별 수집 경로를 사용했다. Node/npm 경로와 각 시작·종료 UTC 시각, exitCode/signal, 명령, 단계별 수치와 로그 SHA-256은 각 results.json에 있다.

- 개발 검증 runId: 2026-10-01T10-06-11-439Z. 검사 시작 HEAD는 84e8add이며 그 위의 미커밋 보완 코드를 검사했다. 완료 뒤 main 함수 들여쓰기만 정리하고 구현 커밋을 만들었다.
- 커밋 기준 재검증 runId: 2026-10-01T10-10-42-261Z. 검사 HEAD는 398168c9f5f2d8e3f077ac33273d6effbe8baa4b이며 보완 소스의 working-tree Git object와 해당 커밋 object가 모두 일치한다.
- 두 실행 모두 보완 회귀 11/11, 관련 지침·surface·snapshot 회귀 143/143, fail/cancel/skip/todo 모두 0.
- 두 실행 모두 test:mcp 등록/호출 59/59, totalCalls 207, measuredTools 59, measuredCalls 224, status=passed. MCP는 TAP 수치가 아니라 이 JSON과 종료 코드로 확인한다.
- 두 실행 모두 lint 종료 0. 기존 tests/ai-conversation-role-browser.test.mjs:198의 no-unsafe-finally 경고 1건만 있다.
- 두 실행 모두 build 종료 0. 기존 500 kB 초과 chunk 안내만 있다.
- 두 실행 모두 git diff --check 종료 0. 개발 실행의 LF→CRLF 안내와 빈 재검증 로그를 원문 그대로 보존했다.

전체 unit의 단계별 수치는 두 실행이 동일하다. tests는 실행 단계별 TAP summary를 합한 값이며 같은 테스트의 별도 검증 실행을 합쳐 독립 요구사항 수로 보고하지 않는다.

| 단계 | tests | pass | fail | cancel | skip | todo |
|---|---:|---:|---:|---:|---:|---:|
| 일반, 137 files / concurrency 4 | 814 | 799 | 0 | 0 | 15 | 0 |
| Windows 진입점, concurrency 1 | 7 | 7 | 0 | 0 | 0 | 0 |
| 격리 감시자, concurrency 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| 작업 호스트, concurrency 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| 합계 | 823 | 808 | 0 | 0 | 15 | 0 |

15 skip은 기존 MNP_BROWSER_TEST=1 조건 6개 및 MNP_REAL_GIT_TEST=1 조건 9개다. 새 skip/timeout/assertion 완화는 없다. 첫 실행은 개발 검증, 두 번째는 커밋 기준 확인이며 실제 실패 때문에 재실행한 것이 아니다. 필수 검증의 실제 실패·취소는 없었다. 읽기 전용 원문 해시 진단 한 번은 비동기 실행의 session 응답을 완료 exitCode로 처리한 호출 측 오류가 있었고, 충분한 대기 시간으로 다시 조회하여 성공했다. skip 출처 탐색에서 존재하지 않는 단일 경로 1개가 포함된 rg 호출은 오류를 냈으며 rg --files와 실제 파일 전역 조회로 확인했다. 두 진단 문제는 코드·조건 변경이나 필수 검증 실패가 아니다.

## 기존 증거와 제품 계약 보존

supplement-preservation.json은 기존 11개 파일의 시작 Git blob/현재 원문 SHA-256과 6로그의 과거 results.json 기록 해시 일치를 기록한다. 기존 6로그와 새 14로그 모두 U+FFFD 개수 0이다. 과거 로그·results.json, initial-response-evidence.json, before/after-surface-and-prompts.json, followup-commit-inventory.json의 원문을 덮어쓰거나 소급 수정하지 않았다.

검사 소스 4개의 working-tree SHA-256, Git blob SHA-256 및 정규화된 Git object 일치도 같은 JSON에 있다. 새 14로그 및 두 results.json의 실제 바이트 SHA-256을 보존했다. supplement-logs의 로컬 .gitignore와 .gitattributes는 로그 추적과 줄바꿈 변환 방지만 담당하며 제품 설정을 바꾸지 않는다.

시작 HEAD 대비 변경은 위 검증 helper/runner/test 4개, 새 로그 전용 속성 2개와 새 보완 증거에 한정한다. mcp/server.mjs, src/utils 상세 지침, server 제품 runtime, 기존 schema/fixture, scripts/test-mcp.mjs 및 독립 보존 제품 개선은 diff에 없다. 관련 회귀와 MCP/unit이 최신 59개 이름/schema, 상세 guide와 전달 방식, 세 도구 안전 안내, 총괄 5개 상태, Dooray 기한, 최신 updatedAt, 부분 대기 보존 및 기존 후속 기능을 확인했다. c541fd7은 시작 후보와 구현 후보의 조상으로 그대로 보존된다.

## 한계·인계

06의 구현·개발 검증과 후보 커밋 완료이며 07 독립 판정, clean main 통합 및 원격 HEAD 일치 완료를 뜻하지 않는다. 로컬 main은 읽기 전용 조회에서 여전히 84e8add였다. 원격 fetch/push, 강제 push/reset, 사용자 이력 rewrite, 운영 재시작·배포, Dooray 쓰기, 원인/모델 비교 실험은 하지 않았다. 조건부 브라우저/real Git pool 15개, 운영 외부 연동 및 호스트 총주입량은 이번 검증 범위 밖이다.

실제 초기 응답은 기존 격리 GET fixture와 실제 MCP 핸들러/SDK 호출 경로의 회귀다. 운영 MCP/카드에서 캡처를 실행한 것이 아니다. 최종 후보 코드가 구현 커밋과 같고 역사적 증거·새 로그의 Git blob이 기록 해시와 같은지, 커밋 형식 및 clean은 증거 커밋 뒤 다시 읽어 인계한다.
