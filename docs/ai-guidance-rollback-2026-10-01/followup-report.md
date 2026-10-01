# 06 전체 롤백 후속 보완 결과

상세 지침과 정상 전달 경로가 기준선 원문과 일치하는 후보를 완성했다. 후속 main의 독립 사용자 변경 c541fd7을 보존했고 개발 검증은 통과했다. 07 독립 품질 검증, 루트의 최종 main 반영과 운영 적용은 남아 있다.

- 기준선: `11a5079d62a9493e55548fe5b1ccbe0ffa3eb94c`.
- 초기 시작 HEAD: `eaa7eeda712c76e59c19ed771cbba077b72ada1e`.
- 이번 보완 출발 후보: `08b22533640e13e1bd2f461c253f238c3723f9d9`.
- 별도 후속 보존 main: `c541fd7c85cc29caef0619d713945fd6018cafc8`, 확인 시 clean. 후보의 조상이며 해당 6개 파일의 원 변경과 병합 변경 줄이 정확히 일치한다.
- 병합: `378dc5eaa100c84435c316009545280f1e633f72`, 충돌 없이 안전 병합. 초기 복구 `37aac975`·보존 `08b22533`과 별도다.
- 완성된 제품·계측·테스트 코드: `7cc83acb459df10d908dfcde211784f5e4941054`. 최종 증거 커밋은 보고서·캡처·로그·감사 메타데이터만 보완한다. 정확한 최종 커밋 ID는 이 파일을 포함한 후보 브랜치의 `git rev-parse rollback/mnp-guidance-20261001` 및 06 결과 댓글에 확정한다.

## 구현과 계측의 확정 결과

SDK Client.getInstructions()의 실제 initialize 전문은 922자, 소스 지침 상수는 616자다. 실제 등록 전문은 Dooray 승인 예외와 구분 개행 306자를 포함하며 기준선 등록 전문과 정확히 같다. 이름 1,996·설명 12,546·schema JSON 46,313·실제 지침 922의 길이 합계는 61,777이다. 59개 이름·input schema 해시는 `5beb90c211a2bdcf2966215ec45788750e8bd8ff5101cc20d13670f2ad38313e`로 보존됐다. 이 합계와 17개 동적 예시 합계 35,521자는 실제 단일 대화 총주입량이 아니다. 호스트 선언 24,602자/도구당 wrapper 35자는 역사적 가정이다.

기존 before 캡처는 수정하지 않았다. 원 파일 SHA-256은 `3a86835358291223fb55ce905e3cb3b71163837a59bcdae7818e351236d11088`이고 Git blob도 그대로다. 과거 eaa7eed의 실제 initialize 468자는 Git archive 코드로 현재 별도 재현했다. 과거 운영 실측으로 소급 기록하지 않는다.

실제 MCP 핸들러와 각 Git 버전의 그룹 서비스로 기준선·eaa7eed·후보의 초기 응답을 격리 재현했다. read_me_first·일반 leaf·문서 담당 guide는 현재와 기준선이 13,568자 전체 일치, 총괄 guide는 16,750자 전체 일치, 세 역할의 그룹 guide는 5,403자 전체 일치다. 선택 문맥의 startupInspection·nextStep·groupProject.instruction·childDelegation 전체도 기준선과 정확히 같다. API fixture와 GET 요청만 사용했으며 운영 MCP·카드·API를 캡처에 사용하지 않았다.

순수 지침 4개 파일은 기준선 전체 일치로 복구했다. 제품·지침 혼합 파일은 상세 지침 구간 복구와 후속 제품 변경 보존을 구분한다. 전역 검색·workspace·Windows 런타임·모델 정책 회귀의 최신 main 대비 빈 diff와 c541fd7 그룹 회귀의 변경 줄 보존을 증명했다. 경량화 구조를 재적용하지 않았다.

RB07 최신 updatedAt·부분 대기 해제는 이번 보완에서 모두 no-op이다. 최신 목록 항목/시각의 존재 assertion은 이미 08b22533에서 추가됐고 부분 대기 단위는 초기 eaa7eed와 같다. `followup-commit-inventory.json.rb07`에 원 hunk·정확한 코드 단위·출처·의존성·해시·빈 후속 diff가 있다.

## 검증과 재현 경로

관련 회귀 140/140, MCP 등록·호출 59/59·207호출, 전체 unit 813건 중 798 통과·실패/취소 0·skip 15·todo 0, lint·build·Git 공백 검사가 통과했다. unit 단계별 수치와 실패·재실행·skip 조건은 [verification-log.md](verification-log.md)에 있다. 이번 최종 실행에는 실패로 인한 재실행이 없다. 기존 lint 경고 1건과 build chunk 권고는 유지된다. 15 skip은 기존 브라우저 조건 6개와 실제 Git pool 조건 9개다.

- [target-inventory.md](target-inventory.md), [followup-commit-inventory.json](followup-commit-inventory.json): 최신 main 22개 원본 커밋과 후보 전용 커밋, 파일·변경 단위·R/P/M·의존성·보존 diff.
- [initial-response-evidence.json](initial-response-evidence.json): Git 객체·현재 재현 시각·소스 원문·실제 등록 및 초기 응답 원문·guide 해시·fixture·GET 요청. `node scripts/capture-guidance-evidence.mjs`로 재현한다.
- [before-surface-and-prompts.json](before-surface-and-prompts.json), [after-surface-and-prompts.json](after-surface-and-prompts.json), [actual-guidance-comparison.md](actual-guidance-comparison.md): 원본과 실제 등록 전문을 구분한 전후 원문·표면·17개 전달 전문 비교. 현재 캡처는 `node scripts/capture-guidance-rollback.mjs after`, 계측 fixture는 `node scripts/measure-ai-instructions.mjs --write`다.
- [preserved-improvements.md](preserved-improvements.md): 독립 보존 출처·정확한 단위·재적용/기존 유지 구분. `node scripts/audit-guidance-preservation.mjs`로 보존 증거를 재생성한다.
- [followup-logs/2026-10-01T08-12-15-239Z-results.json](followup-logs/2026-10-01T08-12-15-239Z-results.json)과 같은 접두 `.log`: 실제 명령·시각·종료 코드·SHA-256·전체 원문. `node scripts/verify-guidance-rollback.mjs`로 필수 검증을 실행한다.

06 설명은 현재 전체 롤백 목적을 맨 앞에 명시하고 과거 경량화 목적·범위·완료 조건·결과 본문을 이력으로 보존했다. [card-before-followup.json](card-before-followup.json)에 수정 전 원문을 확보했다. 공유 지식에는 현행 확정 계약만 갱신하고 진행은 댓글에 기록한다. 저장 뒤 전체 문자열·SHA-256·상태를 다시 확인한다.

미검증은 07 독립 판정, 루트의 main 반영, 운영 배포·실제 외부 Dooray 연동·호스트 총주입량, 조건부 브라우저 6개와 실제 Git pool 9개다. 원격 fetch/push·강제 reset·사용자 커밋 rewrite·운영 재시작·모델 비교 실험을 수행하지 않았다. 지정 후보 외 작업 트리는 읽기 전용으로만 확인했다.
