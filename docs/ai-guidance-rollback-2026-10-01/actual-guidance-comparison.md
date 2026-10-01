# 실제 지침 전문 전후 대조

`before-surface-and-prompts.json`은 시작 HEAD `eaa7eeda`에서 수정 전에 수집했다. `after-surface-and-prompts.json`은 복구 커밋 `37aac975` 위에 독립 보존 델타를 적용한 후보 작업 트리에서 수집했으므로 JSON의 `head`는 그 기초 커밋을 가리킨다. 두 JSON의 `serverInstructions.text`, 도구별 `description`·`inputSchema`, 17개 `snapshots[].text`가 절단 없는 원문이다. `baseline-guide-sources.json`에는 기준선의 조립 소스 9개 전문을 별도로 보존했다. 이 문서는 사람이 읽는 대조이며, 정확한 문자열은 JSON 원문과 SHA-256으로 판정한다.

| 대상 | 변경 전 | 변경 후 | 의미 검사 |
|---|---:|---:|---|
| 서버 시작 지침 | 468자, `10877919e281127bdf4c99183c5fbd8f086ec41f49a8700d3afa9503af8cfb20` | 616자, `cd24be035e93b5923ec24f3148330ba5aac2c4f3a71c9851861b4e66e8c57cdd` | `read_me_first` → 최초 `get_context` → `guide`·`nextStep` 경로 |
| `read_me_first` 도구 설명 | 81자, `17bd7ffc...` | 127자, `48822e5f...` | 기준선의 상세 진입 설명과 원문 일치 |
| 그룹 총괄 새 대화 | 1,264자, `86e1cb5c...` | 4,348자, `63b0e668...` | 사용자 승인·그룹 두 단계 승인 전문과 실행 경계 |
| 문서 담당 새 대화 | 1,018자, `3caa38c1...` | 2,121자, `2b1973ed...` | 문서 담당 승인 전파와 하위 카드 소유권 |
| 그룹 문서 전달 | 1,080자, `4827bcad...` | 2,959자, `87945dcf...` | 현재 instructionId의 완료 보고 라우팅, 명시적 대체·자동 재개 |
| worker 새 대화(lease 있음) | 2,388자, `bccce8ca...` | 2,920자, `96d19f1a...` | 실제 할당 작업공간 1회, 중단 후 완료 신호 조건 |
| 그룹 상위 결과 수신 | 1,640자, `b7440170...` | 3,451자, `9b582b52...` | 결과 검수 후 승인된 후속 작업만 실행 |
| 사용자 중지 복구 | 2,906자, `990b8902...` | 3,710자, `87c085fd...` | 재구성된 미완료 작업·workspace·완료 신호 |

17개 동적 전문의 문자 합계는 21,135자 → 35,521자다. 이 합계는 서로 다른 경로의 예시 전문을 더한 계측값이지 단일 대화의 주입량이 아니다. 일부 전문(`parent-wake`, `dooray-proposal`)은 문자열 길이가 줄었지만, 기준선 조립 위치와 의미 검사를 통해 판정했다. 선택되지 않은 대화 전문은 전후 모두 빈 문자열이다. `tests/ai-instruction-snapshots.test.mjs`가 17개 각각의 전체 문자열 SHA-256, 승인·위임·복구·보고 의미, workspace 중복 여부를 검사한다. 실제 MCP 회귀는 초기 guide 및 선택 카드 context의 구조·행동을 별도로 검사한다.

MCP 도구는 전후 모두 **59개**이고 이름·`inputSchema` 조합 SHA-256은 양쪽 모두 `5beb90c211a2bdcf2966215ec45788750e8bd8ff5101cc20d13670f2ad38313e`다. 26개 도구 설명의 문자열이 변했고, `restore_history`, `update_document_info`, `recover_ai_delegation`의 안전 설명과 전역 `search_content` 설명은 유지됐다. 원시 등록 표면의 이름 1,996자, 설명 12,546자, 스키마 JSON 46,313자, 서버 지침 616자는 따로 측정했다. 호스트의 선언·wrapper·동적 주입 메타데이터는 이 저장소에서 관측하지 못하므로 원시 합계 61,471자를 실제 호스트 전체 주입량으로 해석하지 않는다. 과거 24,602자 선언과 도구당 35자 wrapper는 실측이 아니라 역사적 가정으로만 남겼다.

`tests/mcp-instruction-surface.test.mjs`는 59개 실제 MCP 응답을 전체 fixture와 비교하고, 기준선 직접 등록 도구의 상세 설명 문자열과 안전 설명·전역 검색의 의미를 검사한다. `npm run test:mcp`는 격리 서버에서 상세 guide, 최초 바인딩, 그룹 전달, 복구 후 상태 조회와 대기 일부 해제 등 동작 경로를 검증한다. 기준선에 이미 있던 지식선·대기·pagination 규칙은 신규 독립 개선으로 세지 않았다.
