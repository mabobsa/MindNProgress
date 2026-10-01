# 개발 검증 로그와 범위

후보 작업 트리 `C:\Git\MindNProgress\.rollback-guidance-20261001`에서 실행했다. 최초 `.ai-workspace.json`·`.ai-session.json`은 없었고, 시작 branch는 `rollback/mnp-guidance-20261001`, HEAD는 `eaa7eeda712c76e59c19ed771cbba077b72ada1e`, Git 상태는 clean이었다. `npm ci`는 후보 트리에서만 실행했으며 lockfile 변경은 없었다. 다른 MnP 작업 트리·Holdem pool·운영 서버·예약 작업·외부 앱·원격 저장소에는 쓰지 않았다.

| 실행 | 실제 결과 |
|---|---|
| `node --test ...` 상세 지침·역할·그룹 회귀 | 복구 대상 6개 파일의 세부 테스트 통과. 별도 `group-project-coordinator-guard`의 정상·그룹 밖·총괄 문서 없음·휴지통·루트 없음 5개 판정 통과. 17개 전문 snapshot와 59개 도구 표면·schema 회귀 통과. 그룹 API 단독 회귀 통과. |
| `npm run test:mcp` | 최종 실행 종료 코드 0, `registeredTools=59`, `calledTools=59`, `totalCalls=207`, `measuredTools=59`, `measuredCalls=224`, `status=passed`. `readMeFirstResponseChars=15269`, `selectedContextResponseChars=22052`. |
| `npm run test:unit` | 최종 재실행 종료 코드 0. phase 1 일반 135파일 787 통과·실패 0, phase 2 Windows 진입점 7 통과·실패 0, phase 3 런타임 감시자 1 통과·실패 0, phase 4 예약 작업 GUI 1 통과·실패 0. 총 796 통과·실패 0. 기존 조건부 skip/todo는 변경하지 않았다. 최종 재실행은 `TEMP`·`TMP`를 후보 트리의 `.rollback-test-temp`로 지정했고, 종료 후 이 테스트 생성 디렉터리만 확인·제거했다. |
| `npm run lint` | 종료 코드 0. 변경과 무관한 기존 `tests/ai-conversation-role-browser.test.mjs:198`의 `eslint(no-unsafe-finally)` 경고 1건. |
| `npm run build` | 종료 코드 0, TypeScript build 및 Vite 286 modules 성공. 기존 500 kB 초과 chunk 권고 1건. |
| `git diff --check` | 종료 코드 0, 공백 오류 없음. Windows CRLF 변환 경고는 파일 내용 오류가 아니다. 최종 staging diff도 별도 확인한다. |

첫 회귀 시도에서 `scripts/test-mcp.mjs`의 4.25 compact guide와 조건부 역할·전달 문구 기대가 상세 기준선과 달라 실패했다. 전문 원문에 맞는 구조·의미 assertion으로 교체했고 이후 MCP 전체가 통과했다. 단위 테스트 첫 전체 실행은 `tests/ai-limit-workspace-recovery.test.mjs` 두 사례에서 섹션 제목이 본문에 인용된 것까지 센 `2 !== 1` assertion과 `tests/group-planning-sources.test.mjs`의 상세 기획서 문구 부재 assertion이 실패했다. 실제 중복 섹션이 아님을 확인하고 제목 줄만 검사하도록 정정했으며, 두 복구 API 사례와 그룹 기획서 테스트를 단독 통과시켰다. 다음 전체 실행은 `tests/dooray-responses-api.test.mjs`의 옛 축약 승인 인계 문구 1건이 실패했다. 서버 승인 조회·허용/제외 범위의 실제 상세 문구를 검사하도록 수정한 뒤 단독 통과했다. 최종 전체 실행은 위 표처럼 실패 0이다. assertion의 안전 조건·timeout·skip/todo를 완화하지 않았다.

검증 서버는 `scripts/test-mcp.mjs`의 후보 트리 내부 `.mcp-test-data`와 동적 `127.0.0.1` 포트, 테스트 AionUi 모의 서버를 사용한다. 복구 API·Dooray API 단위 테스트도 격리 데이터 디렉터리와 동적 localhost 서버를 사용한다. 테스트의 외부 Dooray 업무나 운영 MnP 데이터는 사용하지 않았다. 최종 단위 재실행의 임시 디렉터리는 후보 트리 안에 두고 테스트 뒤 제거했다. 초기 탐색 재실행 일부는 기존 테스트의 OS 기본 임시 경로를 사용했으나 각 fixture가 자체 정리했고 운영 데이터는 사용하지 않았다.

미검증: 실제 MCP 호스트가 선언·wrapper·도구 설명을 렌더링해 주입하는 전체 크기, 운영 서버에서의 배포·재시작, 실제 Dooray 외부 연동, 07의 독립 읽기 전용 판정과 루트의 로컬 main 통합. 과거 모델 인과 조사·모델 비교 실험은 요청 범위에서 제외했다. 후보 구현 완료는 main 반영 완료를 뜻하지 않는다.

## 후속 main 통합·계측 보완의 최종 개발 검증

보완 출발 후보는 clean `08b22533640e13e1bd2f461c253f238c3723f9d9`이고 main은 clean `c541fd7c85cc29caef0619d713945fd6018cafc8`이었다. 공통 조상 eaa7eed에서 후보에만 안전 병합한 커밋은 `378dc5eaa100c84435c316009545280f1e633f72`다. 원격 fetch/push, reset, 사용자 커밋 삭제·rewrite, 운영 재시작은 없었다. 지침 경량화 구조를 다시 적용하지 않았다.

완성된 제품·계측·검증 코드 커밋 `7cc83acb459df10d908dfcde211784f5e4941054`에서 `node scripts/verify-guidance-rollback.mjs`를 실행했다. 원문 로그와 각 명령·시각·종료 코드·SHA-256·단계별 수치는 `followup-logs/2026-10-01T08-12-15-239Z-results.json` 및 같은 접두의 `.log` 파일들에 있다. 이후 최종 산출물 커밋은 보고서·증거와 감사 메타데이터만 보완하며 제품·fixture·검증 테스트 코드는 바꾸지 않는다.

| 검증 | 실제 결과 |
|---|---|
| 관련 12개 파일 회귀 | 140/140 통과, 실패·취소·skip·todo 0. 세 도구 안전 의미, 총괄 유효성 5개 상태, Dooray 3초 기한, 최신 모델 정책과 그룹·위임 API, 초기 상세 guide 원문·전달 경로, 59개 표면·17개 전문 포함 |
| `npm run test:mcp` | 종료 0. 등록/호출 59/59, 기본 호출 207, 계측 도구 58, 계측 호출 223, `status=passed`. 초기 guide·startupInspection·nextStep, 최신 updatedAt 재조회와 부분 대기 보존을 실제 격리 경로에서 검증. 계측 recorder의 관측 범위를 전체 도구 호출 커버리지와 혼동하지 않음 |
| `npm run test:unit` | 종료 0. 아래 단계표 참조. 총 813, 통과 798, 실패·취소 0, skip 15, todo 0 |
| `npm run lint` | 종료 0. 기존 `tests/ai-conversation-role-browser.test.mjs:198` no-unsafe-finally 경고 1개 |
| `npm run build` | 종료 0. TypeScript·Vite 286 modules, 기존 500 kB chunk 권고 |
| `git diff --check` | 종료 0. 공백 오류 없음, LF→CRLF 안내만 있음 |
| Git 보존 감사 | 최신 main 22개 커밋과 후보 전용 커밋 추적, c541fd7 조상, 원 변경/병합 변경 6개 파일의 추가·삭제 줄 정확히 일치, 순수 지침 4개 파일의 기준선 전체 일치, 혼합 파일 diff와 후속 제품 테스트 6개 파일의 최신 main 대비 빈 diff |

| 전체 unit 단계 | 파일 | 총 tests | pass | fail | cancel | skip | todo |
|---|---:|---:|---:|---:|---:|---:|---:|
| 일반·병렬(동시성 4) | 136 | 804 | 789 | 0 | 0 | 15 | 0 |
| Windows 진입점 | 1 | 7 | 7 | 0 | 0 | 0 | 0 |
| 격리 런타임 감시자 | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| 예약 작업 GUI 하네스 | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| 총합 | 139 | 813 | 798 | 0 | 0 | 15 | 0 |

15개 조건부 skip은 `MNP_BROWSER_TEST=1`을 설정하지 않은 브라우저 테스트 6개와 `MNP_REAL_GIT_TEST=1`을 설정하지 않은 실제 Git pool 테스트 9개다. 원문 로그에 각 테스트 이름과 조건이 있다. skip을 새로 추가하거나 timeout·assertion을 완화하지 않았다. 이번 보완의 관련·MCP·전체 unit·lint·build는 모두 첫 최종 실행에서 통과했고 실패로 인한 재실행은 없었다. 앞 절의 과거 후보 실패와 재실행 이력은 별도로 보존한다.

감사 메타데이터의 원문 경로 비교와 no-op 구분을 확정한 뒤 감사 스크립트를 다시 실행해 통과했고 lint·Git 공백 검사를 재확인해 종료 0이었다. `git fsck --no-reflogs`도 종료 0이며 연결되지 않은 기존 객체 안내만 출력했다. 객체를 삭제하거나 정리하지 않았다. 로그 SHA-256, 이전 before 파일의 문자열 해시와 Git blob, 커밋 제목·세 본문 절·Co-Authored-By 부재를 별도로 검증했다.

먼저 수행한 초기 guide·표면·snapshot·모델·총괄 guard 5파일 확인은 16/16 통과했다. 별도로 Git archive 재현에서 기준선과 현재의 read_me_first, leaf·총괄·문서 담당 get_context guide 및 세 get_group_context guide 전체 문자열·해시 일치를 확인했다. 저장된 실제 응답에서 startupInspection·nextStep·groupProject.instruction·childDelegation 전체도 기준선과 정확히 같다. 이전 before 원본은 변경하지 않았다.

이번 보완에서도 운영 서버·예약 작업·실제 Dooray 연동·Holdem 작업공간을 변경하지 않았다. 단위 테스트의 격리 서버·임시 fixture와 테스트 생성 프로세스만 사용했다. 미검증은 07 독립 판정, 루트의 main 반영, 운영 적용과 실제 호스트 총주입량, 조건부 브라우저 6개·실제 Git pool 9개다. 06 자체 검증을 07 독립 품질 검증 완료라고 해석하지 않는다.
