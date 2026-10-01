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
| RB10 | 기준선 후 제품 커밋 다수 | 전역 검색, Windows 런타임, 파일 교체 재시도, 저장·승인·건강도·assessment·pagination·workspace/Git 제품 계약은 혼합 파일에서 지침 구간 복구와 제품 변경 보존으로 유지. 순수 지침 4개 파일은 기준선 전체 일치 복구. | 초기 21개와 후속 c541fd7까지의 대상표, 관련 회귀·MCP·unit·build |

`commit-file-inventory.json`은 21개 커밋과 변경 파일을 전수 등록한다. `target-inventory.md`는 커밋별 R/P/M 판정이다. `before-surface-and-prompts.json`과 `after-surface-and-prompts.json`은 실제 전문을 저장하므로 축약 예시만 보고 판정하지 않는다. 최종 보존 커밋의 정확한 파일별 diff가 최소 델타의 기계적 근거다.

## RB07의 현재 보존 단위

`followup-commit-inventory.json.rb07`은 원 커밋의 해당 hunk, 최초 시작 eaa7eed와 후보의 절단 없는 코드 단위 및 해시를 함께 담는다. 최신 updatedAt의 원 출처는 `7aae8f0`, 두 항목 부분 해제의 원 출처는 `60f4e51`다. 최신 목록의 항목·updatedAt 존재 assertion은 이미 `08b22533`에서 추가됐다. 부분 해제 단위는 eaa7eed와 정확히 같으며 다시 적용하지 않았다. 이번 08b22533 이후 보완에서는 두 단위 모두 no-op이고 `rb07CandidateFollowupDiff`가 빈 문자열이다. 원 계약을 새로 구현하거나 재적용했다고 보고하지 않는다.

복구된 실제 위임 목록에서 최신 시각을 읽어 후속 `expectedUpdatedAt`에 사용한다. 부분 해제는 두 항목 중 두 번째 원래 ID를 그대로 유지하고 `status !== done`을 확인한다. 이어지는 부분 병합 보존 검증도 `partiallyReleasedCard.card.data`를 기준으로 하여 남은 대기 항목을 유지한다. 전체 MCP 회귀가 두 계약을 실행한다. 원본 hunk에 함께 들어 있는 축약 guide assertion은 보존 성과가 아니라 롤백 대상이며 현재 상세 의미 회귀로 교체됐다.

후속 main c541fd7은 모델 제한·안내·관련 회귀라는 독립 사용자 변경이다. `mainPreservation`의 6개 파일별 `sourcePatch`와 `mergePatch`는 추가/삭제 줄이 정확히 같고, c541fd7은 후보의 조상이다. 이번 계측·증거 보완은 이 병합과도 별도 커밋으로 나눴다.
