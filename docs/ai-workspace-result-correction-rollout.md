# 통합 대기 결과 정정의 적용·복구 계획

## 승인과 적용 범위

2026-10-07 사용자의 “MnP 복구 보완과 GAS 보완 승인”에 따라 결과 정정 기능을 구현·검수했다. MnP 운영 적용·재시작과 GAS 배포는 별도 승인 단계로 유지한다.

변경 전 코드 기준은 `65c4b670abd21cdcd9a4f4bc440b95ebd5bebd93`이다. 변경 범위는 기존 위임 복구 API·MCP, 작업공간 풀의 정정 상태·후보 보존, 카드/그룹 복구 화면과 관련 검증·문서다. 새 위임이나 임의 작업공간 점유로 기존 결과를 대체하지 않는다.

실제 운영 위임·lease·작업공간 상태 파일과 사용자 Git 파일은 이번 구현·검수에서 변경하지 않는다. UI 빌드는 기존 `dist`를 덮지 않고 별도 임시 출력 위치에서 검증한다. 현재 4175 웹은 Vite로 소스를 제공하며 `/@vite/client`·`/src/main`을 사용하므로 승인된 UI 소스 변경은 즉시 반영될 수 있다. API 서버의 새 기능 적용에는 별도 재시작이 필요하다. 격리 테스트의 Git/HTTP 자료는 운영 상태와 구분한다.

## 검수 기록

기존 코드와 최종 변경분의 API·작업공간·MCP·두 UI 경로를 독립 리뷰했다. 최초 리뷰에서 소유권 불일치와 Git 실패의 잠금 유지, 상태 조회의 무실행, 종료된 정정 위임의 재요청 거부 경계를 보완했다. 테스트 개수는 서로 겹치므로 합산하지 않는다.

| 검증 범위 | 결과 |
| --- | --- |
| Root의 최종 위임·그룹·응답 계약 회귀 | 43 PASS / 0 FAIL |
| Root의 임시 Git 정정 통합·243바이트 파일 보존 및 API 응답 유실 복구 | 2 PASS / 0 FAIL, 종료 상태 보완 직전 수행 |
| 구현 담당의 기존 회귀 2개 묶음 | 각각 49 PASS / 0 FAIL, 50 PASS / 0 FAIL / 선택적 Git 3 SKIP |
| 신규 정정 테스트 11개 사례 | 사례별 분할 검수 통과. 새 후보·후속 결과 순서·소유권/HEAD 거부·준비/세션 중단·응답 유실·실행 불일치·Git 실패의 보존을 검증 |
| 마지막 종료 상태 보완 후 metadata·준비 중단·응답 유실/종료 상태 HTTP | 3 PASS / 0 FAIL / 0 CANCELLED. 종료 상태 4개의 위임 전체·풀 전체·실행 요청 수 불변 |
| 기존 미추적 충돌 통합의 실제 Git 사례 | 1 PASS |
| 타입·변경 파일 문법/린트·diff 검사 | exit 0 |
| 별도 출력 경로의 Vite 빌드 | exit 0, 크기 경고만 있음 |

실제 Git 검수는 운영 저장소 대신 임시 저장소를 사용했다. 마지막 명령은 `MNP_REAL_GIT_TEST=1`, `MNP_REAL_GIT_TEST_TIMEOUT_MS=300000`과 `--test-concurrency=1`을 사용했고 139679ms에 완료됐다. 전체 신규 suite를 마지막에 단일 명령으로 다시 실행하지는 않았다.

수정 중 후보 ref 이름 충돌, 검증 guard 위치와 테스트 재로그인 문제를 발견해 수정·재검증했다. 초기 구버전 실행의 180초 제한은 최종 직렬 검수에서 재현되지 않았다. 추가 종료 상태 검수는 이미 SIGTERM으로 종료된 child의 `exitCode=null`을 다시 기다리는 테스트 정리 경계 때문에 취소됐고, `signalCode`를 확인하도록 테스트만 보완한 뒤 최종 검수를 통과했다.

이전 검수 runner PID `112872`·`118592`의 수동 종료와 임시 폴더 정리 요청은 자동 승인 검토가 상세 이유 없이 거절했다. 명령 실행·우회·수동 재시도는 0이다. 해당 임시 폴더는 이미 등록된 테스트 `after` 훅이 자연 정리했고, 최종 읽기 관측에서는 두 runner만 남고 그 아래 API server child는 없었다. 이 잔존 프로세스를 운영 MnP 서버로 취급하거나 전체 프로세스 정리 완료로 보고하지 않는다.

## 운영 적용 순서

1. 운영 적용·재시작 승인 후 현재 등록 작업·실행 계정·기동 경로, 웹/API 응답과 PID·기동 시각을 확인한다. 현재 사용 중인 코드와 검수 커밋, 상태 저장 완료 및 진행 중 위임을 대사한다.
2. 검수된 코드 커밋과 현재 소스 지문을 확인한다. 현재 Vite 웹 기동 방식과 설정을 유지하며 격리 빌드 결과로 운영 `dist`를 덮지 않는다. 원 상태 파일·lease·작업공간 Git 이력은 편집하지 않는다.
3. 실제 설치의 `scripts/mnp-runtime.ps1 -Action restart`로 기존 서버 종료를 확인한 뒤 등록 작업을 시작한다. 웹·API 응답과 PID·기동 시각을 대조한다. 임시 서버로 대체하거나 AionCore/CLI를 중지하지 않는다.
4. MCP의 새 선택적 `recoveryMode`와 실제 위임 목록의 정정 가능 여부를 확인한다. 후보가 없는 단순 순서 대기에는 결과 정정을 요청하지 않는다.
5. 담당 문서 Root가 기존 icons 위임·원 owner·현재 카드 요구사항을 대사하고 원 승인 범위의 정정 요청을 명시한다. 원 owner는 MnP가 준비한 기존 source에서 초기 파일 상태·자동 생성 경위·현재 bytes/GUID/참조·다른 작업의 변경을 확인한다. 자기 우발 포함을 입증할 때만 정상 변경 체크포인트로 정정한다.
6. 정정 완료 후 새 후보·실제 통합과 원 결과/후보 보존을 확인한다. 뒤의 완료 결과는 같은 잠금 순서로 처리한다. 새 소스의 독립 품질 검수는 담당 문서의 기존 검수 경로를 따른다.

## 사용자 파일과 실패 처리

### 최초 원 dispatch 만료의 완료 관측 증거

원 dispatch 조회가 `AI_DELEGATION_STATUS_NOT_FOUND`인 첫 결과 정정에는 별도의 source 완료 증거 경로를 사용한다. 최초 `strategy=new`, 원 operation과 위임 ID의 일치, 이전 복구 이력 없음, 기존 completed 관측·turn·캡처 해시·통합 대기 provenance가 모두 필요하다. live 조회의 완료 응답을 합성하지 않으며, 403·503이나 중단된 정정 실행의 dispatch 만료에는 이 경로를 적용하지 않는다.

정상 최초 dispatch가 `pendingInstruction`을 소거하므로 완료 관측 경로에서만 최초 지시의 durable `instructionHash`를 사용한다. pending 원문이 남아 있으면 원문 exact 대사도 필요하며, 기존 누락 대화 복구의 pending exact 계약은 유지한다. 원 owner·origin·카드·사용자·시각·최초 전문에 기록된 6개 lease 필드·현재 작업공간이 일치해야 한다. 원문은 메모리에서만 처리하고 proof에는 ID·해시·시각·별개의 external turn/backend UUID·terminal tool error 개수만 보존한다.

원 owner의 raw 메시지를 최신부터 페이지당 100개, 최대 20페이지로 완결 조회하고 같은 커서의 원문 범위를 다시 읽는다. 유일한 최초 사용자 요청, 단일 backend 실행, 마지막 finished assistant text와 저장 캡처의 정확 일치 및 `final <= capturedAt <= childCompletedAt`, fresh idle owner를 확인한다. 첫 backend 이전의 완료된 unbound tips 한 개만 제외할 수 있다. 과거 terminal tool error는 실패 이력으로 개수를 보존하며 완료 실행 증거와 기능 PASS를 구분한다. 진행 중·알 수 없는 상태·불완전 페이지·원문 변화는 쓰기 전 HOLD다.

Root의 실제 원 자료 사전 대사에서는 최초 지시 해시, 최종 캡처 해시, 원 external turn, 단일 backend UUID와 7개 terminal tool error의 predicates가 통과했다. 완결 184개 메시지의 진단 결과와 최신 raw 100개를 비교하고 older 84개의 검증필드를 메모리에서 구성한 조건부 순수 대사다. 실제 older 페이지 loader·fresh 재조회·운영 정정 접수 또는 품질 PASS로 기록하지 않는다. 첫 preparing 재시도는 증거를 다시 확인하고, pending 응답 유실은 기존 요청을 이어가며, 정정 dispatch 이후 재개는 기존 live 이전 실행 검증만 사용한다.

완료 proof의 scope·lease·source·candidate/base는 pool의 보존된 원 결과와 intent 저장 전에 대사하고, exclusive prepare 내부에서도 optional proof CAS로 다시 확인한다. 저장 전 증거 거부는 전체 위임·풀을 보존한다. intent 저장 후 CAS가 실패하면 preparing intent와 원 proof를 유지하며 응답의 `storedStatePreserved:false`·`preparationIntentPreserved:true`로 이번 변경을 구분한다.

| dispatch 만료 보완의 최종 검증 | 결과 |
| --- | --- |
| 순수 완료 proof negative matrix·pool 원 결과 CAS·fresh owner·기존 original-message/lookup 회귀 | 78 PASS / 0 FAIL / 0 SKIP, 실제 운영 조회가 아닌 순수·fixture 검증 |
| 직렬 실제 임시 Git/HTTP의 기존 response-loss·before-dispatch-restart·dispatch-mismatch | 각각 64168ms·74693ms·54243ms, 3 PASS |
| 같은 임시 Git/HTTP의 새 source-proof | 85743ms, 1 PASS. 잘못된 증거·403/503의 전체 위임/풀 불변·POST 0, valid404 접수·동일 owner/lease·이전 후보·243 bytes 보존, 첫 preparing 재시작·응답 유실·proof 유무별 live 재개 |
| 위 HTTP/Git 한 명령의 최종 통계 | 4 PASS / 0 FAIL / 0 CANCELLED / 0 SKIP, 279388ms, exit 0 |
| 변경된 8개 JS 파일 문법·lint와 diff 검사 | exit 0. 이번 보완은 UI/build/dist를 변경하지 않음 |

최종 순수 명령은 `node --test --test-concurrency=1 tests/ai-delegation-source-completion.test.mjs tests/ai-delegation-dispatch-recovery.test.mjs tests/ai-delegation-status-lookup.test.mjs`다. 실제 Git/HTTP는 다음 한정 명령으로 검수했다. 서로 겹치는 기존 검수와 합산하지 않는다.

```powershell
$env:MNP_REAL_GIT_TEST='1'
$env:MNP_REAL_GIT_TEST_TIMEOUT_MS='300000'
node --test --test-concurrency=1 --test-name-pattern='API는 명시 모드' tests/ai-integration-result-correction.test.mjs
```

새 HTTP fixture의 첫 실행은 dispatch 403 응답을 409로 예상했으나 기존 경로가 503을 반환해 59812ms에 실패했다. 이때 기존 `fetchAionUi`가 명시한 fixture URL 외 discovery/default 서버 후보도 조회하는 것을 발견했다. 실제 Core 후보 GET의 시도·도달 가능성을 배제할 수 없으며 원인·운영 영향은 확정하지 않는다. 이 실행은 정정 dispatch POST 전 실패했고 POST 수는 0이다. 이후 모든 HTTP scenario의 child에 test-only fetch origin allowlist와 자체 discovery/usage 경로를 지정했다. 두 번째 실행은 87627ms에 기능 검증을 모두 마친 뒤 Windows child 종료가 JS exit hook 영수증을 남기지 않아 마지막 테스트 assertion만 실패했다. 제품 변경 없이 거절 순간의 marker로 보완했다. 최종 새 case는 fake upstream GET 138회·POST 3회(최초 정정 1회와 live 재개 2회)의 동일 origin을 확인했고 default 서버 후보는 실제 fetch 전에 차단했다. 운영 MnP recover·runtime 재시작·위임/lease/refs/worker 쓰기는 이 보완 담당이 실행하지 않았다.

Holdem integration의 `Assets/QHoldem/Editor/Scripts/JapanServiceDirectTmpGuard_JP.cs.meta`는 기존 미추적 243 bytes, SHA256 `f5d616f90fa05654fb8c6f2f9ca15ff24e03f35820ac25f34c9befb5a83f0a2c`를 보존한다. worker의 우발 추가를 정정하는 절차는 이 integration 파일의 삭제·이동·덮어쓰기를 허용하지 않는다.

소유권·HEAD·세션·후보·Git 작업·원문 무결성이 불일치하면 자동으로 정리하지 않는다. 정정 준비나 전달 응답 유실은 같은 지시·operation으로만 이어간다. 실행 대상 불일치와 알 수 없는 Git 실패의 `held`는 자료와 통합 잠금을 유지하며 증거 검토를 요구한다.

## 운영 복구 범위

정정 요청을 시작하기 전 API 운영 적용 실패는 변경 전 코드로 복원하고 같은 등록 작업을 재시작하는 범위로 처리할 수 있다. Vite 웹도 복원된 소스를 사용하며 기존 `dist`는 변경하지 않는다. 현재 소스에 추가 사용자 변경이 있으면 검수 변경분의 정확한 역적용 가능성을 먼저 확인한다.

정정 요청을 시작한 뒤에는 구버전 코드로 자동 복귀하지 않는다. 정정 상태·pending 요청·새 체크포인트를 구버전이 처리하도록 두지 않고 현재 코드와 원 자료를 유지한다. 상태 확인과 원 owner 작업을 마치거나, 정확한 상태 이행·복구안을 검수한 뒤 별도로 처리한다. 상태 파일 삭제, lease 강제 해제, 사용자 파일 정리로 우회하지 않는다.

GAS 구현·독립 검수는 별도 진행 중이다. 이 MnP 적용 절차에는 GAS 배포, 운영 POST, Sheet·ScriptProperties 쓰기가 포함되지 않는다.
