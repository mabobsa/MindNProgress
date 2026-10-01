# 지침 전체 롤백 전수 대상표

기준선 `11a5079d62a9493e55548fe5b1ccbe0ffa3eb94c`, 시작 HEAD `eaa7eeda712c76e59c19ed771cbba077b72ada1e`. `commit-file-inventory.json`에 21개 커밋의 전체 파일 변경 단위를 기계적으로 기록했다. 아래 판정은 파일 전체가 아니라 해당 커밋의 변경 단위에 적용한다. `R`은 기준선의 지침·전달 방식을 복구하고, `P`는 지정된 독립 개선과 후속 제품 계약을 보존하며, `M`은 같은 커밋이나 파일에 두 성격이 섞인 경우다.

| 커밋 | 분류 | 변경 단위와 처리 | 의존성·검증 |
|---|---|---|---|
| `7aae8f0` | M | compact guide·역할 포인터·workflow/writePolicy·이벤트 builder·도구 설명 축약은 R. 복구 직후 최신 `updatedAt` 사용과 계측·snapshot 기반은 P. | RB02·03·07·08, 지침·MCP 회귀 |
| `1994e71` | M | 세 도구 안전 설명과 Dooray 실시간 대기는 P. 축약 설명 fixture는 복구된 전문으로 재생성. | RB04·06, 표면·Dooray 회귀 |
| `428c54a` | P | 그룹 문서 지시 폴러/최초 요청 동일 Promise와 회귀 유지. | 전달 결과 일관성 회귀 |
| `e4356cb` | P | 단위 테스트 파일 동시성 제한 유지. | 전체 unit |
| `66241ac` | P | runner 안전 정수 및 이벤트 스트림 기동 하네스 유지. | 관련 회귀·unit |
| `351b131` | M | Dooray 결과 복구·승인 대화 제품 경로는 P. 같은 파일의 proposal workflow 문구만 R. | Dooray 회귀·빌드 |
| `73dbf8a` | P | 모바일 위임 현황 표시 유지. | 빌드 |
| `cd80279` | P | 대화 문맥 통계·재사용·작업공간 재배정과 도구 계약 유지. | 문맥 건강도·workspace 회귀 |
| `e88881e` | P | 문맥 판정 근거·재사용 안내 보존. | 건강도 회귀 |
| `4d57e9a` | P | 모델별 대화 재사용 차단과 현재 판정 계약 보존. | 건강도·그룹 회귀 |
| `edda3bd` | P | Windows 배치 진입점과 한글 처리 유지. | 런타임 회귀 |
| `ac3390d` | P | 미구현 공유 버튼 제거 유지. | 빌드 |
| `60f4e51` | M | compact 바인딩·역할·재개 builder·축약 도구 설명은 R. `forDocument` 총괄 유효성 검사와 대기 일부 해제 회귀는 P. | RB03·05·07, 5개 역할 사례·MCP |
| `4694110` | P | Windows 런타임 테스트 계약 유지. | unit |
| `0fd56d8` | P | navigation 기동 하네스 유지. | unit |
| `38b0ba8` | P | 초기 문맥 판정 및 도구 계약 유지. | 건강도 회귀 |
| `7ae0121` | P | 문서 전체 검색 도구·API·UI·schema와 fixture 확장 유지. | 59개 MCP 이름/schema·검색 회귀 |
| `7d93271` | P | Windows 런타임 테스트 격리 유지. | unit |
| `754750e` | P | 공용 제한 파일 교체와 접힘 설정 회귀 유지. | unit |
| `3028e76` | P | 그룹 기획서 테스트의 파일 교체 경로 유지. | unit |
| `eaa7eed` | P | 작업공간 상태 파일 제한 재시도와 회귀 유지. | unit |

세부 원문은 `baseline-guide-sources.json`, 변경 전 실제 `before-surface-and-prompts.json`에 저장했다. 이후 실제 복구 전문·최신 MCP 표면과 대조해 문구뿐 아니라 전달 위치·동작을 검증한다. 기준선에도 있던 지식선·대기·pagination은 신규 보존 성과로 계수하지 않는다.

## 혼합 커밋의 파일·변경 단위 판정

위 표에서 P인 17개 커밋의 모든 변경 파일은 `commit-file-inventory.json`의 목록대로 제품 기능·계약 보존 대상이다. 다음 네 커밋은 파일 안의 서로 다른 변경 단위를 구분했다. 여기서 `R`은 상세 지침 원문과 조립 방식을 기준선으로 복구, `P`는 지정 독립 개선 또는 이후 제품 기능 유지, `M`은 같은 파일에 둘 다 있는 뜻이다.

| 커밋 | 파일과 단위 | 판정 |
|---|---|---|
| `7aae8f0` | `mcp/server.mjs`, `server/index.mjs`, `server/lib/aiDelegationInstructions.mjs`, `server/lib/groupDocumentInstructions.mjs`, `server/lib/groupProjects.mjs`, `server/lib/doorayResponses.mjs`, `src/utils/aiApprovalInstructions.mjs`, `src/utils/aiContextInstructions.mjs`, `src/utils/aiConversationLaunch.mjs`·`.d.mts`: compact guide, 역할 조건부 노출, workflow/writePolicy, new/resume/recovery builder·전달 문구를 복구. 같은 파일의 후속 제품 API·기능은 유지. | M |
| `7aae8f0` | `scripts/test-mcp.mjs`: 축약 문구 assertion은 복구, 복구 직후 목록·updatedAt은 유지. `scripts/measure-ai-instructions.mjs`, `tests/helpers/aiInstructionSnapshots.mjs`, `tests/ai-instruction-snapshots.test.mjs`, `tests/mcp-instruction-surface.test.mjs`, 두 fixture: 계측 기반을 남기되 실제 상세 전문·해시·의미·59개 도구로 재구성. | M |
| `7aae8f0` | `tests/ai-approval-instructions.test.mjs`, `tests/ai-context-instructions.test.mjs`, `tests/ai-conversation-launch.test.mjs`, `tests/ai-conversation-role.test.mjs`, `tests/ai-delegation-reports-api.test.mjs`, `tests/group-document-instructions.test.mjs`, `tests/group-project-api.test.mjs`, `tests/group-planning-sources.test.mjs`, `tests/ai-limit-workspace-recovery.test.mjs`, `tests/dooray-responses-api.test.mjs`: 축약 전문 전제는 복구, 후속 제품 경계 테스트는 유지. `package.json`: 계측 명령 유지. | M/P |
| `1994e71` | `mcp/server.mjs`: 세 안전 설명 보존. `tests/dooray-responses.test.mjs`: 실시간 3초 대기 보존. `scripts/measure-ai-instructions.mjs`, 두 fixture, `tests/mcp-instruction-surface.test.mjs`: 상세 전문에 맞는 계측·안전 설명 검사로 재구성. | P/M |
| `351b131` | `server/lib/doorayResponses.mjs`의 proposal workflow/writePolicy 안내만 복구. `server/index.mjs`·Dooray 기능·런치·UI·테스트·문서의 나머지 변경은 승인·원문 복구 제품 기능으로 보존. 정확한 파일 목록은 JSON의 해당 커밋 18개 항목. | M/P |
| `60f4e51` | `mcp/server.mjs`, `server/index.mjs`, `server/lib/aiDelegationInstructions.mjs`, `src/utils/aiContextInstructions.mjs`: compact/bound/workflow/builder를 복구. `server/lib/groupProjects.mjs`: 그룹 guide는 복구하되 `forDocument` 총괄 유효성 검사만 보존. `scripts/test-mcp.mjs`: 축약 assertion은 복구하고 대기 일부 해제 검증은 보존. snapshot·표면 테스트와 두 fixture는 상세 전문·59개 schema로 재구성. | M |

제품 변경의 출처 추적은 커밋별 전체 파일 목록(JSON), 위 변경 단위 표, 보존 diff 문서로 함께 한다. 순수 지침 파일인 `src/utils/aiContextInstructions.mjs`, `aiApprovalInstructions.mjs`, `aiConversationLaunch.mjs`와 `.d.mts`는 기준선 전체 문자열과 일치하도록 복구했다. 제품·지침 혼합 파일은 지침 구간을 복구하고 이후 제품 변경 단위를 보존했다. 파일 전체 복원이 전혀 없었다는 종전 절대 표현은 실제 Git diff와 달라 정정한다.

## 후속 main과 후보 추적

초기 시작 HEAD는 계속 `eaa7eeda712c76e59c19ed771cbba077b72ada1e`다. 보완 시작 후보는 `08b22533640e13e1bd2f461c253f238c3723f9d9`, 별도로 보존한 main HEAD는 `c541fd7c85cc29caef0619d713945fd6018cafc8`이다. 초기 21개는 이력 범위이며 최신 main까지 22개 원본 커밋을 `followup-commit-inventory.json`에 전수 등록한다. 후보 전용 복구·보존·병합·계측·보고 커밋은 같은 JSON의 `candidateOnlyCommits`로 구분한다. 최종 산출물 커밋 자신의 ID는 자기 본문에 기록할 수 없으므로 최종 HEAD는 06 결과 댓글과 최종 회신에서 확정한다.

| 후속 커밋 | 분류 | 파일·변경 단위 | 의존성·검증 |
|---|---|---|---|
| `c541fd7` | P | `server/lib/aiConversationContextHealth.mjs` 모델 정규식과 메시지, `server/index.mjs` 두 차단 메시지, `mcp/server.mjs` 후보 제외·새 대화 안내, `tests/ai-conversation-context-health.test.mjs`·`ai-delegations.test.mjs`·`group-project-api.test.mjs`의 GPT-6-Sol/GPT-6.0-Sol 차단과 GPT-6.1-Sol 허용 | 기존 assessment·모델 정책에 의존. 6개 파일의 원 변경과 병합 델타에서 추가/삭제 줄이 정확히 같은지 검사. 모델·위임·그룹 API 회귀 |
| `37aac975` | R | 상세 지침과 전달 경로 복구. 순수 지침 파일 전체 일치와 혼합 파일 구간 복구를 구분 | 기준선 실제 guide·전달 전문 대조 |
| `08b22533` | P/M | 세 안전 의미, 총괄 유효성, Dooray 기한 재적용과 복구된 지침 회귀. RB07 최신 updatedAt 존재 assertion만 추가. 대기 부분 해제 계약은 기존 유지 | `preserved-improvements.md`와 원본 hunk |
| `378dc5e` | P | clean main c541fd7을 공통 조상 eaa7eed에서 후보에 안전 병합. 충돌 없음 | main 변경 6개 파일의 변경 줄 일치와 c541fd7 조상 검사 |
| `7cc83ac` 및 최종 증거 커밋 | P | 실제 initialize 계측, 과거 Git 재현, 초기 guide 원문 검사, 대상표·로그 보완 | 제품 지침 구조를 재적용하지 않음. 최신 이름/schema·실제 초기 호출·unit·lint·build·Git 검사 |

`followup-commit-inventory.json`의 `mixedFileDiffs`는 최신 main 대비 혼합 6개 파일의 전문 diff다. `pureGuidanceRestoration`은 순수 지침 4개 파일의 전체 문자열·해시 일치 증거다. `preservedProductTestDiffs`는 검색·workspace·런타임·위임·문맥 건강도 테스트 6개 파일이 최신 main과 그대로 일치하는 증거다. 다른 지침 관련 회귀는 상세 원문 의미로 복구했고, c541fd7 그룹 API 추가 변경은 병합 델타의 줄 단위 대조로 보존을 확인했다.
