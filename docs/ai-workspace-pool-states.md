# AI 작업공간 풀 상태와 기록 파일

이 문서는 로컬 Unity/Git 작업공간 풀의 실제 상태 값과 기록 파일의 작성 주체를 정리한다. 프로젝트 공유 루트의 계약 문서(예: Holdem `middleware/MIDDLEWARE_CONTRACT.md`)는 상태 목록을 따로 복제하지 않고 이 문서를 참조한다. 기준 코드는 `server/lib/workspacePool.mjs`(로컬 풀)와 `server/lib/remoteWorkspacePool.mjs`(서브 머신 원격 풀)이며, 상태 이름을 바꾸거나 추가하면 이 문서를 함께 고친다.

## 기록 파일과 작성 주체

| 파일 | 작성 주체 | 반영 시점·비고 |
| --- | --- | --- |
| registry `workspaces.json` | 운영자 또는 공유 루트의 등록 스크립트(예: Holdem `scripts/register-workspace.ps1`) | MnP는 registry를 쓰지 않는다. 경로는 `MNP_WORKSPACE_POOL_REGISTRY`, 미설정 시 MnP 프로젝트의 `workspaces.json`이다. 서버 기동 시 `initialize()`에서만 읽으므로 worker 추가·비활성화·경로 변경 뒤에는 MnP를 재시작해야 반영된다. |
| 풀 상태 `data/_workspace-pool.json` | MnP | 작업공간 상태와 lease를 저장한다. 서버 실행 중에 직접 편집하지 않는다. |
| `<projectRoot>/.ai-session.json` | MnP | lease를 만들 때 기록하고 회수할 때 제거한다. 필드는 `schemaVersion`, `workspaceId`, `jobId`, `leaseId`, `conversationId`, `projectRoot`, `sharedRoot`, `branch`, `baseCommit`, `knowledgeMode`, `startedAt`이다. 통합 충돌 해결 중에는 `branch`·`baseCommit`이 통합 브랜치 기준으로 바뀌고 `phase=integration-conflict`가 추가된다. AI는 읽기만 한다. |
| `<sharedRoot>/job-results/<jobId>.json` | MnP | 결과 상태를 기록한다. 공통 필드는 `schemaVersion`, `poolId`, `workspaceId`, `jobId`, `leaseId`, `mapId`, `cardId`, `conversationId`, `branch`, `baseBranch`, `baseCommit`, `status`이며, 상태에 따라 `childStatus`, `childError`, `headCommit`, `integratedCommit`, `integrationBaseCommit`, `completedAt`, `driftArchive` 등이 붙는다. AI는 쓰지 않는다. |
| `<sharedRoot>/workspace-drift/<workspaceId>/...` | MnP | 소유자를 확정할 수 없는 변경이나 체크포인트 이후 자동 변경을 복구 자료로 보존한다. |

registry에서 `enabled=false`인 항목은 풀에 올리지 않는다(운영자가 제외한 상태이며 별도 `disabled` 상태 값은 없다). `role=integration` 항목은 하나이고, 나머지 `role=worker` 항목이 위임 후보다.

## 작업공간 상태

작업공간 상태는 `mindnprogress_get_ai_workspace_pool` 조회 결과의 각 작업공간 `status`로 보인다. AI는 이 값을 보고 작업공간을 직접 선택하거나 점유하지 않는다.

| 상태 | 의미 |
| --- | --- |
| `integration` | 통합 작업공간이다. 사용자 작업과 완료 결과 통합의 기준이며 AI worker 후보가 아니다. |
| `idle` | 새 배정 후보다. 실제 배정은 MnP가 한다. |
| `preparing` | lease를 발급하기 전에 Git 기준선·브랜치·세션 파일을 준비하는 중이다. 준비에 실패하면 가짜 lease 없이 `quarantined`로 남긴다. |
| `leased` | AI 하나가 작업 중이다. |
| `checkpoint-required` | 하위 AI가 끝났지만 명시적 체크포인트 없이 변경이 남아 있어 같은 대화에 체크포인트를 다시 요청한 상태다. 요청은 최대 3회다. |
| `finalizing` | 결과와 작업공간 상태를 회수하는 중이다. |
| `waiting-integration` | 결과를 보존한 채 통합을 기다린다. 다른 작업의 통합 잠금, 통합 작업공간의 미커밋 변경·미추적 충돌, 일시적인 Git 상태 확인 실패 등이 원인이다. 원인이 정리되면 자동으로 다시 통합하므로 재위임하지 않는다. 세부 사유는 [작업 완료 후 통합 정리 대기](./ai-workspace-integration-retry.md)를 따른다. |
| `integrating` | 최신 통합 기준에서 만든 통합 브랜치(`mnp/integrate/<jobId>`)에 체크포인트를 적용하는 중이다. |
| `resolving-integration-conflict` | 통합 충돌을 같은 worker에서 같은 하위 AI 대화가 해결하는 중이다. 이때 lease 상태는 `awaiting-conflict-resolution`이다. |
| `result-correction-preparing`, `correcting-result` | 통합 대기 결과의 명시적 정정을 준비하거나 진행하는 중이다. [통합 대기 결과 정정](./ai-workspace-integration-retry.md#통합-대기-결과-정정)을 따른다. |
| `quarantined` | dirty 상태, 준비 실패, 기준선 불일치, 비정상 종료처럼 자동 재사용할 수 없는 상태다. 사용자 변경을 자동 삭제하지 않으며, 원인을 확인하고 명시적으로 복구해야 한다. 일부 안전한 경우(변경 없는 과거 실패 등)만 다음 배정 전에 자동 회수한다. |

## lease 상태

lease 상태는 위 작업공간 상태와 대부분 같은 이름을 쓰고, 다음 값이 추가된다.

| 상태 | 의미 |
| --- | --- |
| `awaiting-conflict-resolution` | 통합 충돌 해결을 기다리거나 진행 중이다(작업공간은 `resolving-integration-conflict`). |
| `result-correction-held` | 결과 정정 중 통합을 보류했다. |
| `completed` | 통합까지 끝나 작업공간을 회수했다. |
| `cancelled` | 변경 없이 종료되었거나 결과를 보존한 채 반환했다. 결과 파일 상태(`failed-clean`, `released-preserved`, `cancelled`)로 구분한다. |

## 결과 파일 상태

`job-results/<jobId>.json`의 `status`는 다음 값을 쓴다.

| 상태 | 의미 |
| --- | --- |
| `completed` | 명시적 체크포인트를 통합 기준에 반영했다(`integratedCommit`). 무변경 확인으로 끝난 작업도 여기에 포함된다. |
| `checkpoint-required` | 체크포인트를 다시 요청했다. |
| `waiting-integration` | 통합을 기다린다. 원격 풀에서는 `phase=release-pending`이 함께 기록될 수 있다. |
| `awaiting-conflict-resolution` | 통합 충돌 해결을 기다린다. |
| `result-correction-held` | 결과 정정 중 보류했다. |
| `failed-clean` | 변경 없이 실패해 작업공간을 깨끗하게 회수했다. |
| `released-preserved` | 통합하지 않고 결과를 Git 참조로 보존한 뒤 반환했다. 업무 성공으로 보지 않는다. |
| `cancelled` | 취소 후 변경 없이 회수했다. |
| `quarantined` | 격리 상태로 남겼다. |

## 통합 후보의 Git 상태 조회 실패 복구

하위 실행이 끝나고 명시적 체크포인트가 보존된 로컬 작업공간에서 통합 후보의 `git status --porcelain --untracked-files=all`이 실패하면 `quarantined`로 보존한다. 새 실패는 `integrationFailure.reasonCode=integration-git-status-failed`와 함께 단계, 명령, 작업 경로, 종료 코드, 종료 신호, 프로세스 종료·시간 초과 여부와 마지막 4,000자의 stderr를 기록한다.

위임 복구 화면은 이 경우 **통합 재시도**를 제공한다. 후보 HEAD를 저장하기 전에 같은 명령 오류만 남은 과거 기록도 지원하지만, 오류 문구만으로 격리를 해제하지 않는다. 현재 lease·세션·원본 브랜치·전체 체크포인트·후보의 부모와 tree, Git 진행 상태와 미커밋 변경을 다시 검증한다. 검증 실패 시 원본과 격리를 유지하며 파일이나 Git 잠금을 자동 삭제하지 않는다. 원격 lease는 이 로컬 복구 경로로 처리하지 않는다.

검증이 통과하면 기존 후보와 실패 기록을 보존하고 통합 대기로 전환한다. 통합 기준이 진행됐으면 최신 기준에서 별도 후보를 만들고, 이미 반영된 후보는 중복 적용하지 않는다. 하위 AI를 다시 실행하거나 카드 업무를 완료로 변경하지 않으며, 담당 AI가 보고한 잔여 검증은 별도로 처리해야 한다.

## 원격 풀

서브 머신 원격 풀은 위 상태에 더해 `release-pending`(통합 성공 후 Runner 반환 확인 대기)과 `cleanup-pending`(완료 산출물 정리 재시도 중, 새 배정 차단)을 쓴다. 세부 계약은 [서브 머신 Unity Fork 풀](./remote-fork-workspaces.md)을 따른다. Runner는 배정 기록이 없는 작업공간을 미커밋 변경이 있으면 `dirty`, 이 Runner가 만들지 않은 `.ai-session.json`이 있으면 `foreign-session`, 다른 코디네이터나 로컬 풀이 소유하면 `foreign-owner`로 보고하며, 이 상태들은 새 배정 후보가 아니다.

원격 Fork 체크포인트도 Runner에서 `WorkspacePoolManager.checkpoint`를 거치므로 아래 경로 제한이 똑같이 적용되고, 거부 사유는 코디네이터에서도 같은 `reasonCode`로 보인다. Runner 머신이 이 방어가 없는 이전 코드로 실행 중이면 적용되지 않으므로 Runner도 함께 갱신해야 한다.

## 체크포인트 경로 제한

`mindnprogress_checkpoint_ai_workspace`는 프로젝트 루트의 `knowledge-inbox/` 아래 파일을 추가·수정하는 변경을 `AI_WORKSPACE_CHECKPOINT_PATH_REJECTED`로 거부한다. 예전 위임 전문의 상대 경로 안내 때문에 지식 제안 파일이 게임 저장소에 커밋된 사고를 막기 위한 방어이며, 이미 추적된 파일의 삭제는 막지 않는다.

### 폴더 범위와 대량 삭제

`operation.action=commit-changes`의 `paths`에는 프로젝트 내부의 파일 또는 폴더 상대 경로를 지정한다. 폴더를 지정하면 그 아래의 추가·수정·삭제 파일을 모두 포함한다. 입력 범위는 최대 2,000개지만 폴더에서 펼쳐지는 파일 수에는 이 제한을 적용하지 않는다. 경로는 문자 그대로 해석하며 와일드카드·프로젝트 밖 경로·프로젝트 루트 전체 지정은 허용하지 않는다. 호출 전 `git status`와 diff로 지정한 폴더의 모든 변경이 해당 업무의 의도된 결과인지 확인한다.

서버는 전체 상태를 한 번 조회해 범위를 확정하고, 실제 파일 목록을 NUL 구분 파일로 Git에 전달한다. Windows 명령줄 길이와 무관하게 한 번의 커밋으로 기록한다. 추적 파일의 삭제·수정은 `git add -u`로 처리하므로 현재 `.gitignore` 아래에 있는 추적 파일도 삭제할 수 있다. 삭제만 있는 작업도 `commit-changes`를 사용하고, `confirm-no-changes`로 우회하지 않는다.

스테이징은 별도 임시 인덱스에서 수행한다. 범위 밖의 기존 staged 변경은 `AI_WORKSPACE_CHECKPOINT_STAGED_OUT_OF_SCOPE`로 거부하고 보존한다. 스테이징·커밋이 실패하면 기존 인덱스와 작업 파일을 유지한다. 다른 Git 작업이 인덱스를 사용 중이면 `AI_WORKSPACE_CHECKPOINT_INDEX_LOCKED`로 거부하며 기존 잠금을 지우지 않는다. 커밋 이후 기록 저장이나 인덱스 반영 자체가 실패한 경우에는 `AI_WORKSPACE_CHECKPOINT_RECOVERY_REQUIRED`와 복구 경로를 반환하므로 재커밋 전에 저장된 커밋·인덱스를 확인해야 한다.

체크포인트가 없어서 멈춘 기존 작업은 서버 갱신 후 동일 lease·브랜치·대화에서 변경 범위를 다시 확인하고 `commit-changes`를 재시도한다. 성공 응답의 `checkpoint.paths`는 실제 커밋 파일 목록, `checkpoint.requestedPaths`는 요청한 범위다. 검증 후 기존 담당 AI가 결과를 보고하면 기존 통합 흐름을 사용한다. 새 위임으로 worker를 재배정하거나 `reset`·직접 커밋으로 우회하지 않는다.

체크포인트 보완 지시에는 전체 변경 수와 최대 25개·6KB의 경로 미리보기만 넣는다. 나머지 목록은 담당 AI가 배정된 작업공간에서 `git status`로 확인한다. 대량 삭제 경로 전체를 지시에 붙여 AionCore의 요청 본문(320KiB)·지시문(256KiB) 제한을 초과하는 일을 방지한다.

구버전 복구 요청이 접수되지 않아 `복구 요청 기록을 찾지 못함`에 머무르면, 상태 조회 시 동일 lease·회차의 당시 파일 목록과 AionCore의 404 응답을 함께 확인한다. 당시 목록만으로 지시문 제한을 초과했고 새 요약 형식의 요청이 아닌 경우에만 미접수 복구 요청을 종료한다. 작업 결과·체크포인트·작업공간은 유지하고 AI를 실행하지 않는다. 사용자는 `기존 작업 재개`로 새 회차의 요약 지시를 보낼 수 있다. 404만 있거나 당시 근거가 없으면 접수 여부 불확실 상태를 그대로 보존한다.
