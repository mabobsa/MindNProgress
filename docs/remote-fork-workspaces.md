# 서브 머신 Unity Fork 풀

이 기능은 `feature/remote-fork-workspaces` 분리 worktree에서 구현한 뒤 MnP main에 병합되었다(2026-10-11 `65c7b7e`까지 main의 조상으로 확인). 작업공간 풀 조회 결과에도 `coordinatorId`와 `remotePools`가 노출된다. 다만 2026-10-21 조사 시점 `remotePools`는 빈 배열이었고, 서브 머신 원격 풀이 실제로 활성화되어 운영 중인지는 확인하지 않았다. 원격 풀을 활성화하기 전에는 아래 「검증과 적용 전 조건」을 여전히 확인해야 한다.

## 소유권과 실행 계약

메인 MnP는 등록 승인, worker 선택, 내구 lease, 결과 통합을 맡는다. Runner는 서브 머신의 명시적 registry를 읽어 실제 Git root/origin/HEAD/dirty/session/runtime 상태를 보고하고 준비·체크포인트·결과 봉인·격리·반환을 수행한다. AionCore는 원격 소유권을 응답에 그대로 보존하고, 실행 전 로컬 `.ai-session.json`을 대사한다.

원격 lease에는 기존 `workspaceId/jobId/leaseId/projectRoot/branch/baseCommit` 외에 `ownership={coordinatorId,machineId,poolId,generation}`이 있다. 서로 다른 OS 경로를 메인 파일 시스템 경로로 사용하지 않는다. registry digest나 전송 프로토콜 버전이 달라지면 새 등록 승인이 필요하다. 진행 중 lease가 있으면 registry·프로토콜 교체를 거절한다.

```text
승인된 보고 → 공통 Git 기준 확인 → preparing → Runner prepare receipt → leased
  → checkpoint → sealed + SHA256 검증 증분 bundle
  → 메인 staging → 통합 검증/fast-forward → release-pending
  → Runner 반환 receipt → completed → 완료 산출물 정리
```

명시적 체크포인트가 없으면 기존 보완 대화 흐름으로 돌아간다. 원격 체크포인트에는 `requestId`가 필수이며, 새 변경에는 새 ID, 동일 요청 재시도에는 같은 ID를 쓴다. 동일 ID의 다른 입력은 거절한다.

기존 로컬 풀의 lease는 별도 유지한다. 메인 통합 잠금만 기존 manager의 직렬화 경로와 공유한다. 새 원격 결과는 서버 데이터 디렉터리의 `remote-workspaces/staging/<leaseId>/repository`에서 기존 체크포인트·dirty·untracked 충돌·HEAD/브랜치 이동 검사를 거친다. staging의 Git 참조와 작업 트리는 독립적이지만 기준 Git 객체는 메인 저장소와 공유해 전체 팩을 매번 복제하지 않는다. staging의 전체 작업 트리 체크아웃은 여전히 임시 디스크를 차지하므로 운영 전 크기를 측정해야 한다. staging이 남아 있는 동안 메인 저장소의 객체 정리나 이력 재작성으로 필요한 기준 객체를 제거해서는 안 된다. 네트워크가 끊겼다고 worker를 반환하거나 재배정하지 않는다.

새 staging은 checkout 전에 메인 저장소의 로컬 `info/attributes`와 `info/exclude`를 복사한다. 공유 clone은 이 파일들을 자동 상속하지 않으므로, 기존 CRLF 파일의 checkout 정책이나 lease 메타데이터의 제외 정책이 달라져 가짜 dirty 상태가 생기는 것을 방지한다. 메인에 설정된 Git 신원은 복사하되, 미설정이면 임의의 이름·이메일을 만들지 않고 Git의 기본 동작을 유지한다. 실제 메인·worker의 파일, 속성 설정, 미커밋 변경을 자동 정리하거나 dirty 검사를 생략하지 않는다.

전송 계약 v2에서는 Runner가 보고한 유휴 worker HEAD가 메인 기준 커밋과 같으면 기준선 bundle을 만들지 않는다. 뒤처져 있으면 해당 HEAD가 메인 기준 커밋의 조상인지 확인한 뒤 그 사이의 증분 bundle만 보낸다. 메인에서 공통 기준을 검증할 수 없으면 `REMOTE_WORKSPACE_BOOTSTRAP_REQUIRED`로 배정을 차단하며, 전체 이력 bundle로 자동 우회하지 않는다. 결과는 `baseCommit..작업 브랜치`, 반환은 `baseCommit..통합 브랜치` 범위의 증분 bundle이다. 무변경 결과나 Runner가 이미 보유한 통합 커밋은 bundle을 생략한다.

## 설정과 승인 순서

1. AionCore의 `workspaceLeaseVersion >= 3`, `remoteWorkspaceOwnership=true` 빌드를 먼저 검증한다.
2. 메인 MnP와 서브 머신에서 로컬 풀을 운영하는 MnP를 함께 갱신한다. 같은 물리 Fork를 기존 로컬 풀과 원격 풀에 동시에 활성화하지 않는다. 기존 lease는 먼저 정상 완료·반환한다. 기존 owner marker를 편의상 삭제하지 않는다.
3. 서브 머신용 별도 registry를 명시적으로 준비한다. 실제 root를 확인하고 기존 main registry를 복사해 경로를 추측하지 않는다. `coordinatorId`는 메인 분산 작업 설정 또는 Runner heartbeat 응답에서 조회한다.
4. Runner에 `MNP_RUNNER_WORKSPACE_REGISTRY=<절대 registry 경로>`를 지정한다. 내장 AionUi Runner에는 추가로 `MNP_RUNNER_WORKSPACE_AGENT_MODULE=<설치된 MnP>/runner/lib/workspaceAgent.mjs`를 지정한다. 내장 Runner가 부모 프로세스의 환경을 상속하므로 이 환경으로 AionUi를 시작해야 한다. 엔진과 서버는 함께 갱신한다.
5. MnP 분산 작업 설정에서 Runner가 보고한 실제 경로·origin·상태를 확인하고 풀을 승인한다. `workspacePoolIds`만 수정해서 활성화하지 않는다. 최초 배정은 Git tracked/untracked가 모두 깨끗하고 해당 root의 AionCore runtime이 유휴일 때만 가능하다.

registry 예시의 경로는 실제 설정에 사용할 값이 아니라 계약 설명용이다.

```json
{
  "schemaVersion": 1,
  "coordinatorId": "mnp-example-coordinator",
  "poolId": "mac-unity",
  "sharedRoot": "/absolute/shared-root",
  "originUrl": "https://example.invalid/project.git",
  "workspaces": [
    { "id": "fork1", "root": "/absolute/verified-git-root", "role": "worker", "enabled": true }
  ]
}
```

선택 필드 `commitPrefix`(문자열)를 두면 이 풀의 체크포인트 커밋 제목 prefix로 사용한다. 빈 문자열은 prefix 없음이다. 지정하지 않으면 메인 서버가 전달한 MnP 편집자 계정 이름으로 `[이름]`을 만들고, 이름도 없으면 붙이지 않는다. registry를 바꾸면 digest가 달라지므로 풀을 다시 승인해야 한다.

## API

- `POST /api/machines/:machineId/runner/heartbeat`: 인증된 Runner의 `workspacePool` 보고. 메인이 받은 시각 기준 180초 뒤 만료한다. 보고 중단도 기존 풀을 일반 작업공간으로 바꾸지 않는다.
- `GET/PUT /api/machines/:machineId/workspace-pool`: 소유자/관리자 전용 조회·승인. PUT `{poolId,registryDigest,enabled}`. 비활성화는 새 배정만 막고 기존 lease는 보존한다.
- Runner 큐의 `POST /mnp/workspaces`: `{operationId,action,lease,options}`. 로컬 AionCore에 전달하지 않는 Runner 전용 경로다.
- `GET .../runner/workspace-artifacts/:leaseId/{baseline|release}/manifest`, `/chunks/:index`: 필요한 경우에만 기준선/반환 증분 bundle 다운로드.
- `POST .../runner/workspace-artifacts/:leaseId/result/chunks/:index`, `/complete`: 결과 bundle 업로드. 인증된 머신과 lease 귀속을 검사한다.
- `POST /api/machines/:machineId/workspace-pool/leases/:leaseId/retry-integration`: 메인 staging을 직접 검토·해결한 소유자/관리자만 `{confirmed:true,expectedHead:<검토한 staging HEAD>}`로 통합 복구한다. Mac 대화에 메인 staging 경로를 전달하지 않는다.
- `POST /api/machines/:machineId/workspace-pool/leases/:leaseId/retry-preparation`: prepare 응답 유실로 보존된 원 위임에 대해 `{confirmed:true,expectedLeaseId,generation}`으로 같은 prepare receipt를 확인한다. 완료 receipt가 확인된 경우에만 원 위임을 다시 배정 대기로 돌린다. 중단된 started receipt를 강제 재실행하지 않는다.

전송은 256KiB chunk와 전체 SHA256, 고정 크기·manifest 검증을 사용하며 bundle당 상한은 8GiB다. 중복 chunk는 같은 내용만 허용한다. Git bundle verify는 수신 측의 선행 커밋 보유 여부까지 검사하며, 기준 커밋 조상 관계와 봉인 HEAD도 검증한다. 상한은 대용량 증분 전송을 허용한다는 뜻이 아니다. 실제 변경량·임시 디스크 여유·Windows↔Mac 전송 시간을 확인하기 전에는 운영 활성화하지 않는다.

## worker 배정이 필수인 위임 요청

`machineId`는 실행 머신을 선택하며 풀 배정을 보장하지 않는다. `newConversation.workspace`에 일반 integration 경로를 보내면 일반 대화로 실행될 수 있다. 최신 `mindnprogress_get_ai_workspace_pool`에서 확인한 `poolId`를 위임 요청의 `workspacePoolId`로 명시하면 worker lease가 필수가 된다. 서버가 해당 머신의 풀에서 worker를 원자적으로 선택하므로 호출자가 물리 worker를 골라 점유하지 않는다.

```json
{
  "strategy": "resume",
  "conversationId": "기존_카드_담당_ID",
  "machineId": "macbook",
  "workspacePoolId": "unity-macbook"
}
```

위 예시는 추가할 실행 조건만 표시한다. 기존 도구의 문서·카드 ID, 최신 `sourceRevision`, `conversationAssessmentId`, 업무 지시, 위임 규칙, 새 `idempotencyKey` 등 필수 인자는 그대로 제공한다. `workspacePoolId`와 `newConversation.workspace`를 함께 보내면 `AI_WORKSPACE_POOL_PATH_CONFLICT`로 거부한다. 풀 ID는 중복 요청 서명에도 포함되므로 같은 키를 일반 실행과 풀 실행 사이에서 바꿔 재사용할 수 없다.

- `new`가 기존 담당 재사용 규칙에 의해 `resume`으로 바뀌어도 필수 풀 조건과 최초 실행 머신을 유지한다. 다른 머신의 담당으로 바뀌거나 기존 재개 lease의 풀이 다르면 거부한다.
- 미승인·만료·풀/머신 불일치 시 일반 대화로 우회하지 않는다. 일반 비-pool 요청에는 `workspacePoolId`를 생략하며 기존 동작을 유지한다.
- 문서 간 조정 대화는 worker 배정 대상이 아니므로 이 필드를 거부한다. 구현은 해당 문서의 하위 카드에 위임한다.
- lease 없이 종료된 integration 고정 대화도 유휴 상태·문맥 평가·진행 중 위임·중복 점유 검사 후 정식 pool lease를 받아 재사용할 수 있다. Runner가 예약과 session 소유권을 확인하고 AionCore가 turn을 확보한 뒤 runtime과 경로를 원자적으로 재귀속한다. 직접 DB나 대화 workspace를 변경하지 않는다.
- 배정 대기 응답의 lease가 아직 없는 것은 비동기 준비 상태다. `AI_WORKSPACE_ALLOCATION_PENDING`의 동일 위임을 조회하고, `starting/running`에서 발급된 lease와 실제 session을 확인한다. 대기 중 중복 제출하지 않는다.
- 성공적으로 lease 실행을 인계한 뒤 카드 연결의 workspace와 poolId도 갱신한다. 기존 대화 생성 시각·사용자가 변경한 담당 선택은 보존한다.
- 이 인자를 사용하려면 메인 MnP 서버와 호출 머신의 MCP 도구 스키마를 함께 갱신해야 한다. 예전 서버·MCP가 필드를 무시하는 상태에서 재위임하지 않는다.

## 실패와 복구

- prepare/result/release 응답 유실: 내구 operation receipt와 같은 요청 본문만 사용한다. 완료 receipt는 재시작 후에도 같은 결과를 반환한다.
- 중단된 `started` receipt 또는 남은 물리/mutation 잠금: 자동 재실행·잠금 탈취를 하지 않고 복구 필요로 중단한다. 실제 Runner/Core runtime·Git 상태·session·receipt를 검토한 운영자 절차가 필요하다. 현재 자동 중단 복구나 강제 lease 반환 API는 제공하지 않는다.
- 머신/대화/generation/branch/session 불일치: Git 변경이나 dispatch를 시작하지 않는다.
- 취소·실행 실패: 원격 lease를 격리해서 보존한다. Git clean만으로 실패 작업을 자동 회수하지 않는다. 기존 서버의 확인된 dispatch/외부 한도 복구 흐름에서 소유권과 유휴 상태를 확인한 경우에만 재활성화한다.
- 메인 dirty/untracked 충돌: 기존 manager의 통합 대기와 재검증을 사용한다. 사용자 파일을 정리하지 않는다.
- 메인 staging 통합 충돌: 원격 Fork와 staging을 보존하고 `REMOTE_INTEGRATION_CONFLICT_MANUAL_REVIEW`로 격리한다. 자동 충돌 해결 대화를 Mac에 잘못 보내지 않는다. 통합 잠금은 명시적 복구 전까지 보존한다.
- 통합 성공/반환 실패: `release-pending`으로 유지한다. 반환 ack 전까지 용량으로 계산하지 않는다.
- 양쪽의 `completed` receipt가 영속 저장된 뒤 해당 lease의 bundle·chunk와 메인 staging을 정리한다. 정리 실패는 완료 결과를 뒤집지 않지만 `cleanup-pending`으로 새 배정을 막고 재시도한다. 중단된 `started` receipt, `release-pending`, 격리 상태의 산출물과 소유권 표시는 정리하지 않는다.
- staging에서 생긴 추적·미추적 drift 복구 자료와 결과 기록은 `remote-workspaces/recovery/<leaseId>/`에 보존하며 완료 정리 대상에 넣지 않는다. 이전 버전의 결과가 staging 안의 `workspace-drift`를 가리키면 해당 복구 경로와 결과 기록은 그대로 유지하고 큰 `repository`와 임시 상태만 정리한다. 복구 자료의 삭제·보존 기간 결정은 별도 운영 절차다.
- artifact 요청은 접수 시와 큐 실행 시에 머신 귀속·봉인·완료 상태를 다시 검사한다. 완료 lease의 새 전송은 거절한다. 완료 정리는 해당 lease의 모든 artifact 큐가 끝날 때까지 기다려 이미 실행 중인 업로드·다운로드와 파일 삭제가 경합하지 않게 한다. 완료 receipt 재조회는 정리된 bundle을 다시 요구하지 않는다.

`.git/mnp-remote-owner.json`과 `.git/mnp-local-owner.json`은 coordinator 간 경합을 막는 영구 소유권 표시다. 물리 Git 잠금과 Runner state mutation 잠금은 프로세스 간 원자적 mkdir로 획득한다. 장애 후 잠금을 시간만 보고 삭제하면 안 된다.

## 검증과 적용 전 조건

실제 Git 임시 저장소 테스트는 증분 기준선·결과·반환과 전체 이력 우회 차단, prepare/checkpoint/메인 staging 통합/반환, generation 증가, dirty 대기, prepare/release 응답 유실과 재시작, 완료 산출물 정리·정리 실패 재시도, 충돌 수동 복구, 기존 local 통합 잠금 보존, artifact 변조·중복·머신 귀속, 체크포인트 멱등성을 포함한다. AionUi bridge의 독립 테스트는 feature opt-in, 허용 경로, 로컬 API 전달 차단과 dispatch 소유권 거절을 포함한다.

실제 메인 서버의 registry·진행 중 lease·최신 미커밋 변경은 현재 대화의 Runner relay 권한으로 조회할 수 없었다. Mac에서 발견한 integration/Fork의 미커밋 변경도 그대로 보존했다. 운영 적용 전에 메인 권한으로 최신 상태를 재확인하고, Rust 빌드/회귀 테스트와 실제 Windows↔Mac 전송·Unity 검증을 완료해야 한다. 이 Mac 환경에는 cargo/rustc가 없어 AionCore 변경을 컴파일했다고 보고하지 않는다.

### 2026-10-11 로컬 검증 결과

- MnP 원격/기존 풀·실제 Git 통합 및 복구 테스트 71개 통과.
- MnP Runner·머신 큐·인증 API·위임 회귀 테스트 108개 통과.
- AionUi Runner 관련 4개 테스트 파일의 35개 테스트 및 TypeScript 검사 통과.
- MnP TypeScript/production 빌드 통과. 기존 대형 bundle 경고는 남아 있다.
- MCP smoke test의 등록 도구 59개 호출 검증 통과.
- AionUi 새 bridge/test 파일 lint·format, Runner sidecar CJS bundle 생성 통과.
- 세 저장소의 `git diff --check` 통과. 원본 AionUi의 `bun.lock` 변경은 보존했다.

### v2 완료 정리 보완 검증

- 원격 Git 테스트 25개와 기존 풀·통합·복구 테스트 58개 통과. 완료 후 drift 자료 보존, 이전 버전의 복구 경로 유지, 대기·실행 중인 업로드와 정리 경합, receipt 재조회, 로컬 checkout·ignore 정책 복제를 추가 검증했다.
- Runner·머신 큐·인증 API·위임 회귀 테스트 108개 및 production 빌드 통과.
- 실제 Mac 프로젝트는 별도 shared staging에서 원본 HEAD·브랜치를 유지하고 파일 정책을 복제한 후 clean 상태임을 확인했다. 원본 풀 상태 변경·Runner 호출을 금지한 검증이며 Windows↔Mac 전송·Unity 실행 검증을 대체하지 않는다.
- AionCore 게시·Rust 검증과 운영 적용 조건은 여전히 별도로 확인해야 한다. 이번 보완은 main 병합·배포·재시작·원격 풀 활성화를 포함하지 않는다.

MnP의 Git/복구 검증 재현 명령:

```sh
MNP_REAL_GIT_TEST=1 node --test tests/remote-workspace.test.mjs tests/workspace-pool.test.mjs tests/ai-limit-workspace-recovery.test.mjs tests/ai-integration-result-correction.test.mjs tests/workspace-untracked-integration.test.mjs
node --test tests/machine-operations.test.mjs tests/runner-loop.test.mjs tests/runner-aionui-client.test.mjs tests/machine-runner-api.test.mjs tests/ai-delegations.test.mjs tests/ai-delegation-dispatch-recovery.test.mjs
```

아래 AionCore 검증은 Rust toolchain이 준비된 환경에서 아직 실행해야 한다:

```sh
cargo fmt --all --check
cargo test -p aionui-api-types external_conversation_dispatch
cargo test -p aionui-conversation remote_workspace_ownership
cargo test -p aionui-conversation external_dispatch
```
