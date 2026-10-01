# 독립 보존 변경의 출처와 최소 델타

첫 커밋 `37aac97573c727cfac8e044fd3ab13e0556a9011`은 상세 지침·전달 경로를 복구한다. 아래 표의 델타는 다음 커밋에서 `git show --format=fuller <보존 커밋> -- <파일>`로 독립 검토할 수 있다. 시작 HEAD에 이미 있던 개선도 출처와 최종 존재 여부를 분리해 기록한다. 기준선 상세 규칙과 pagination은 신규 성과가 아니다.

| 계약 | 원 출처 | 복구 커밋 대비 보존 델타 / 기존 유지 | 의존성·검증 |
|---|---|---|---|
| RB04 | `1994e71` | `mcp/server.mjs`의 세 도구 설명에 복원 직전 백업·전체 교체/변경 소실·새 이력·사후 조회, 최신 `baseVersion`/명시 승인 `force=true`/사후 조회, 복구 후 실제 위임 목록 조회만 각각 재적용. 서버 보호 로직은 추가하지 않음. | 도구 표면 fixture·의미 검사, MCP 전체 회귀 |
| RB05 | `60f4e51` | `server/lib/groupProjects.mjs:forDocument`에 총괄 그룹 소속·문서 존재·휴지통·루트 검증만 재적용. | `tests/group-project-coordinator-guard.test.mjs` 정상·그룹 밖·문서 없음·휴지통·루트 없음 5개 경우 |
| RB06 | `1994e71` | `tests/dooray-responses.test.mjs:until`의 고정 50회 대신 3초 실시간 기한, 경과 시간·시도 수·마지막 상태 진단 재적용. | Dooray 응답 회귀, 전체 unit |
| RB07 | `7aae8f0`, `60f4e51` | 시작 HEAD의 `scripts/test-mcp.mjs`에 있던 복구 직후 목록 재조회·최신 `updatedAt`, 대기 일부 해제 뒤 나머지 ID·미완료 보존은 유지. 보존 커밋에서 최신 목록 항목·시각의 존재 assertion을 추가했고, compact 문구 assertion은 기준선 상세 문구로 변경함. | MCP 전체 회귀; 복구 안내의 사후 목록 조회와 서로 보완 |
| RB08 | `7aae8f0` | `scripts/measure-ai-instructions.mjs`, snapshot helper/fixture, MCP 표면 테스트를 복구된 실제 `server/index.mjs` 조립 함수에 맞춰 재구성. 17개 전문 SHA-256·의미 검사, 59개 이름/schema 및 143개 schema 설명 검증. | 계측 재현, snapshot·MCP 표면 회귀 |
| RB09 | `7ae0121` 및 시작 HEAD | 59번째 전역 검색을 포함해 모든 이름·input schema 유지. 원시 설명, 서버 지침, 동적 전문, 관측 불가 호스트 메타데이터를 분리 측정. | 전후 표면 JSON과 동일 schema 해시 |
| RB10 | 기준선 후 제품 커밋 다수 | 전역 검색, Windows 런타임, 파일 교체 재시도, 저장·승인·건강도·assessment·pagination·workspace/Git 제품 계약은 파일 전체 복원이 아니라 지침 구간만 치환하여 유지. | 대상표의 21개 커밋, 관련 회귀·MCP·unit·build |

`commit-file-inventory.json`은 21개 커밋과 변경 파일을 전수 등록한다. `target-inventory.md`는 커밋별 R/P/M 판정이다. `before-surface-and-prompts.json`과 `after-surface-and-prompts.json`은 실제 전문을 저장하므로 축약 예시만 보고 판정하지 않는다. 최종 보존 커밋의 정확한 파일별 diff가 최소 델타의 기계적 근거다.
