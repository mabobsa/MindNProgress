# REQ-MNP-02 승인 대화 연결 회귀 보완

기존 완료 조건 `mnp-api-02-4`의 권한·귀속·실패 일관성 보완이다. 이전 02 검증과 원래 체크리스트를 보존한다. 출발 소스는 통합 `258faef`이며 03~06의 후속 구현을 사용한다. 운영 두 건의 복구 여부는 아래 코드 시험과 별도로 기록한다.

## 확인한 원인과 변경 경계

기존 재현 `.tmp/diagnose-launch-lock-20261028/result.json`의 SHA-256은 `9256fb00fa55780a9f8eb926eadddbd0895af0ddfe16dd57440d734d86cdba56`이다. 같은 완료 HTTP 요청이 `10afee7`에서는 200과 양쪽 연결, `9af4521` 및 `258faef`에서는 409와 카드만 연결된다. 승인 파일을 뒤늦게 획득해 `RESOURCE_ORDER_VIOLATION`이 발생한 것이 원인이다. 서버 재시작 추측을 원인으로 채택하지 않는다.

- callback은 기존 05의 예약 → 외부 조회 → 재획득·검증 순서를 유지하고 최초/재획득 집합에 `state:_dooray-responses/{startedBy}.json`을 포함한다. 시작 귀속·ticket 경로도 현재 사용자의 같은 키를 포함한다. 다른 사용자의 승인 파일을 함께 잠그지 않는다.
- Dooray 서비스의 사용자별 RMW는 공통 자원 어댑터를 사용한다. 공통 보호와 별도 사용자 Promise 큐를 중첩해 역순 대기하지 않는다. 독립 사용 시 기존 큐를 유지한다. 설정의 외부 조회는 잠금 밖에서 수행하고 재제안은 다시 읽은 원문과 대조한다. 설정 저장은 기존 설정 큐의 독립 변경이다.
- callback의 카드·귀속·origin·승인은 하나의 `storageChanges.run`과 04 journal로 확정한다. 후보 실패 시 메모리를 복구하고 성공 상태·HTTP·SSE는 확정 뒤 공개한다. marker 이후 중단은 기존 04 redo로 복구한다. 일반 요청 ID·잠금 순서·기한·문서 버전/수명주기 재검증을 완화하지 않는다.
- 생성된 대화 ID는 검증 뒤 기록한다. 소유 편집자의 `/launches/{token}/confirm`은 기록된 같은 대화만 재확인한다. 완료된 동일 연결 재통보는 기존 승인과 문서 버전을 보존하며 다른 대화는 거부한다. 새 대화를 자동 생성하지 않는다.
- 팝업은 대화 생성과 연결 확정 실패를 구분한다. 수동 재확인은 같은 완료 처리를 실행한다. 서버 재시작/만료로 시작 상태가 404이면 `/response-approvals/{id}/confirmation`에서 revision·handoff와 기존 승인 검증을 통과한 영속 연결만 조회한다. 연결 없는 실패를 성공으로 표시하지 않는다.

## 제한된 기존 연결 복구

`POST /api/integrations/dooray/response-approvals/{id}/repair-link`는 소유 편집자의 이미 생성된 대화 연결만 복구한다. 새 승인/새 대화 생성 경로가 아니다. 이번 운영 적용 대상은 다음 두 쌍뿐이다.

| 요청 | 기존 대화 | 문서 / 카드 |
| --- | --- | --- |
| `dooray-92b22ed25883454d9565f7e4` | `e962013a` | `map-muy2j5pz-ac1a48` / `root-9f52b0869547f5fa` |
| `dooray-9ba6b8c492d2de87bfcc70f2` | `363838dc` | `map-reorg-4c5406f5817c99760b5a` / `root` |

입력은 `mapId`, `cardId`, `conversationId`, `proposalRevision`이다. `dryRun: true`는 증거 확인만 수행한다.

복구는 사용자·승인자·revision·현재 카드 링크·origin·귀속을 대조하고 잠금을 해제한 상태에서 실제 AionUi 대화와 최초 사용자 요청 전문을 조회한다. 원래 승인 전문 및 최초 요청의 귀속 토큰 해시가 저장 귀속과 일치해야 한다. 승인·생성·연결·완료 시각의 순서도 확인한다. 재획득 후 원문 SHA-256·문서 버전·origin·귀속이 달라지면 거부한다. 기존 `assertDoorayApproval`을 그대로 사용하며 목록 `completed/approved`를 새 `approved` 상태로 바꾸지 않는다.

실제 저장은 미리 확인한 `expectedStateSha256`(파일 전체 원문)·`expectedMapVersion`이 필요하다. 같은 잠금·journal 안에서 `_dooray-approval-link-backups/{userId}/{responseId}-{sha256}.json`에 원본 바이트를 백업하고 `approval.conversation`만 추가한다. 승인자·승인 시각·제안·범위·제외·완료 상태·다른 기록을 보존한다. 같은 대화의 재실행은 변경 없이 반환한다. 외부 프로세스는 운영 JSON을 덮어쓰지 않는다.

## 검증과 재현

새 API 시험은 기존 `storage-api-harness`의 검증된 임시 데이터 루트·독립 포트·모의 AionUi·파일 barrier·journal 단계 주입을 재사용한다. 실제 Runner나 운영 문서에는 시험을 쓰지 않는다.

- `dooray-approval-storage-api`: 정상 완료·동일 재확인, 다른 사용자/대화 거부, 완료된 부분 연결의 증거·해시 조건 복구, 백업 바이트와 전체 JSON 대조, 변경된 제안/무효 승인/다른 승인자/원본 요청 누락 거부, 카드·귀속·origin·승인 후보의 실패 복구, 같은 대화 수동 재확인, marker 뒤 중단·재시작 복구를 검증한다.
- `dooray-approval-locks`: 사용자 RMW가 공통 키에서 실제 대기 중인 장벽을 확인하고 callback 중첩 저장을 완료한다. 별도 큐와의 교착을 타이밍 우연 없이 검사한다. 목록 완료 뒤 같은 연결의 재확인도 검사한다.
- 기존 `dooray-responses`, `dooray-responses-api`, `aionui-launch-tracking`과 05의 `launch callback` 사례를 재실행한다. 05 사례의 외부 대기 중 독립 저장은 177ms로 5초 계약 안에 완료됐다.
- 실제 브라우저 `ai-conversation-role-browser`에서 기존 대화 재확인과 시작 상태 만료 후 영속 연결 조회를 확인했다. 두 흐름 모두 새 ticket 요청이 늘지 않았다. `npm run build`와 `npm run lint`가 통과했다. 기존 `no-unsafe-finally` 및 빌드 chunk 크기 경고는 남는다.

```powershell
node --test tests/dooray-approval-locks.test.mjs tests/dooray-approval-storage-api.test.mjs tests/dooray-responses.test.mjs tests/dooray-responses-api.test.mjs tests/aionui-launch-tracking.test.mjs
node --test --test-name-pattern='launch callback' tests/storage-budgets-api.test.mjs
$env:MNP_BROWSER_TEST='1'
node --test tests/ai-conversation-role-browser.test.mjs
npm run lint
npm run build
```

검증 로그는 `.tmp/req-mnp02-approval-validation-20261028/`에 보존한다. 최초 잠금 단위 시험의 합성 자료에 `settings`가 빠져 실패한 것을 보완한 뒤 해당 시험과 추가 API 시험을 다시 통과했다. 기존 진단 원본과 07 검수 자료는 수정하지 않았다. 운영 반영·두 기록 복구 및 07 독립 검수·상위 인수는 각각 따로 판정한다.
