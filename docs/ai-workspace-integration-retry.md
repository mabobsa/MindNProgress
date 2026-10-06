# 작업 완료 후 통합 정리 대기

MnP는 하위 AI 작업 완료와 `main` 반영 완료를 구분한다. 완료된 결과를 반영할 때 사용자 파일 때문에 진행할 수 없다면, 같은 위임·lease·커밋을 보존하고 정리될 때까지 기다린다. 자동 통합 재시도는 하위 AI를 다시 실행하거나 새 위임을 만들지 않는다. 승인된 기존 결과 자체의 정정은 아래 명시적 모드를 사용한다.

## 자동 재시도 대상

- 위임 전 `main` 추적 파일 변경: 기존 `waiting-integration-clean`에서 위임 시작을 대기한다.
- 작업 완료 후 `main` 추적 파일 변경: 기존 `waiting-integration`에서 통합을 대기한다.
- 작업 완료 후 반영 경로와 미추적 파일 충돌: `waiting-integration`, 사유 `integration-untracked-collision`로 대기한다.
- 미추적 파일 전체가 아니라 반영 경로와 실제로 충돌하는 파일만 검사한다. ignored 파일, 파일/디렉터리 경로 충돌도 보호한다.

기존 위임 폴링의 3 → 5 → 10 → 30초 간격을 사용한다. 파일이 정리되면 기존 통합 후보를 fast-forward하고 실제 HEAD를 확인한 뒤 worker를 `idle`로 반환하고 상위 보고 절차로 이어간다. 통합 도중에는 통합 잠금을 유지해 다른 worker 결과와 섞이지 않게 한다.

## 사용자 파일 보호

- `main`의 파일을 자동 삭제·이동·리버트하지 않는다. 미추적 파일은 일반 Revert로 제거되지 않을 수 있다.
- 후보 커밋과 기준 브랜치/HEAD를 고정하고, 재시도 때 예기치 않은 변경이 확인되면 자동 처리를 중단한다.
- Git merge에도 `--no-overwrite-ignore`를 사용한다. 검사 직후 발생한 충돌은 다시 검사해 대기로 전환한다.
- 알 수 없는 Git 오류, 세션/소유권 불일치, 실제 병합 충돌은 이 자동 복구로 우회하지 않는다.
- 서버 재시작 후 같은 통합 후보를 이어 사용한다. 이미 반영된 경우 다시 병합하지 않고 반환 절차를 마친다.

## 구버전 격리 기록 복구

서버 시작 시 완료된 하위 작업 중 `git merge --ff-only`가 미추적 파일 덮어쓰기 방지로 실패한 기록만 복구 후보로 삼는다. 실제 worker 메타데이터, 세션, lease, 브랜치, HEAD, 체크포인트 및 통합 후보의 실제 차이를 검증한다. 다른 활성 위임이나 복구 요청이 있으면 건드리지 않는다.

검증된 기록만 통합 대기로 전환하고 기존 실패 결과·보고 정보는 복구 이력에 보존한다. 기준 변경 등으로 검증에 실패하면 격리를 유지한다. 위임 레코드 저장 전에 서버가 중단된 경우에도 풀에 저장한 복구 결과를 이어 반영한다.

## 통합 대기 결과 정정

기존 담당자의 우발 변경이 포함된 완료 결과는 기존 `recover` API 또는 `mindnprogress_recover_ai_delegation`의 `recoveryMode: "correct-integration-result"`로 정정을 요청한다. 목록의 `recovery.recommendedAction=correct-integration-result`는 기록 기준 후보이며 실제 Git·소유권 검증을 통과했다는 뜻이 아니다. 후보 HEAD가 없는 단순 통합 순서 대기는 대상이 아니다. 카드와 그룹 총괄 UI의 **통합 대기 결과 정정**도 같은 모드를 명시한다.

- 현재 완료 operation과 원 owner 대화·lease, source 브랜치와 최신 체크포인트, 후보 브랜치·HEAD·기준, 메타데이터·세션을 검증한다. 이미 반영된 후보, 변경된 main 기준, dirty worker/main 추적 파일, 진행 중인 Git 작업, 다른 잠금은 거부한다.
- MnP가 동일 worker·job·lease의 기존 source 브랜치와 `.ai-session.json`을 정정용으로 준비한다. 기존 source와 후보는 `refs/mnp/result-correction/<정정키>/source|candidate`, 원 결과·캡처·hash·turn은 풀과 위임 감사 이력에 보존한다. 정정은 결과 검증이나 품질 승인, 사용자 파일 삭제 권한이 아니다.
- 원 담당자는 원 요구사항과 체크포인트를 대사하고 자신의 우발 변경만 정상 변경 체크포인트로 정정한다. 직접 커밋, reset, rebase로 기록된 source 이력을 바꾸지 않는다. 사용자 integration 파일을 삭제·이동·덮어쓰지 않는다.
- `result-correction-preparing`과 `correcting-result`는 점유 상태다. 통합 잠금은 기존 lease에 유지되어 뒤의 완료 결과가 먼저 반영되지 않는다. 원 operation의 늦은 완료 응답·자동 finalize는 새 source를 반영할 수 없다.
- 정정 operation의 실제 완료와 새 변경 체크포인트가 일치해야 fresh main 기준에서 별도 후보를 구성한다. 기존 후보 HEAD는 바꾸지 않는다. 기존 CAS·tracked/untracked 충돌 보호를 통과한 뒤에만 통합하고 잠금을 해제한다.
- 준비·세션 저장·POST 경계에서 중단됐거나 응답이 유실되면 같은 지시와 모드로 기존 recover 요청을 이어간다. 저장된 pending 요청은 동일 operation·전문으로만 조회/재전달하며 새 위임을 만들지 않는다. refresh와 자동 폴링은 조회만 수행하며 실행 기록이 없을 때 재전달하지 않는다. 실제로 중단된 정정 실행은 종료 상태를 확인한 뒤 같은 lease에서 별도 재개 operation을 만들고 그 완료만 반영한다.
- 실행 응답의 대화·lease 불일치나 알 수 없는 후보 Git 실패는 `result-correction-held`로 자료와 통합 잠금을 보존한다. 자동 finalize·claim·취소·격리 해제로 우회하지 않는다. 이 상태는 별도 증거 검토가 필요하다.

API 변경 적용과 서버 재시작은 별도 운영 절차를 따른다. Vite를 사용 중인 웹 UI는 소스 변경이 HMR로 반영될 수 있으므로 API 적용 상태와 구분한다. 검수용 build는 운영 dist를 덮지 않는 별도 출력 경로를 사용한다.

## 검증

실제 임시 Git 저장소 기반 회귀 테스트:

```powershell
$env:MNP_REAL_GIT_TEST = '1'
$env:MNP_REAL_GIT_TEST_TIMEOUT_MS = '300000'
node --test --test-concurrency=1 tests/ai-integration-result-correction.test.mjs tests/workspace-untracked-integration.test.mjs tests/workspace-pool.test.mjs
```

테스트는 운영 Holdem 저장소를 사용하지 않는다. 충돌 파일 보존, 정리 후 완료, 재시작, 중복 반영 방지, 과거 격리 복구, 잘못된 소유권/기준 거부, ignored 파일 및 파일/디렉터리 충돌을 검증한다.
