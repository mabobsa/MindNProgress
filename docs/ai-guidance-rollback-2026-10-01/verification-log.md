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
