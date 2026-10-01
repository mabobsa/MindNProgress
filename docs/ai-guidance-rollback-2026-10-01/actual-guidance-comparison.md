# 실제 지침 전문 전후 대조

`before-surface-and-prompts.json`은 시작 HEAD `eaa7eeda`에서 수집한 역사적 원본이며 수정하지 않았다. 당시 `serverInstructions` 필드는 SDK initialize 응답이 아니라 `MNP_MCP_SERVER_INSTRUCTIONS` 상수였다. 초기 guide 원문도 포함하지 않았다. `after-surface-and-prompts.json`은 이번 보완에서 실제 SDK initialize 전문을 `serverInstructions`로, 상수를 `sourceConstant`로 분리했다. 캡처 시점과 기반 HEAD·작업 diff 해시도 별도로 담는다. 도구별 `description`·`inputSchema`와 17개 `snapshots[].text`는 절단 없는 원문이다. `baseline-guide-sources.json`에는 기준선의 조립 소스 9개 전문을 보존했다. 아래 비교의 이전 상수 값을 실제 등록 전문 실측으로 소급 주장하지 않는다.

| 대상 | 변경 전 | 변경 후 | 의미 검사 |
|---|---:|---:|---|
| 소스 지침 상수 | 468자, `10877919e281127bdf4c99183c5fbd8f086ec41f49a8700d3afa9503af8cfb20` | 616자, `cd24be035e93b5923ec24f3148330ba5aac2c4f3a71c9851861b4e66e8c57cdd` | 상수와 실제 등록 전문을 구분 |
| SDK initialize 등록 전문 | 격리된 eaa7eed 코드의 후속 재현 468자 | 922자, `8b9f506f7079ef160331fdfecdc0cd3ab77d9a4814c087c97389c43a6da74844` | Dooray 승인 예외 306자(구분 개행 포함), 기준선 등록 전문과 정확히 일치 |
| `read_me_first` 도구 설명 | 81자, `17bd7ffc...` | 127자, `48822e5f...` | 기준선의 상세 진입 설명과 원문 일치 |
| 그룹 총괄 새 대화 | 1,264자, `86e1cb5c...` | 4,348자, `63b0e668...` | 사용자 승인·그룹 두 단계 승인 전문과 실행 경계 |
| 문서 담당 새 대화 | 1,018자, `3caa38c1...` | 2,121자, `2b1973ed...` | 문서 담당 승인 전파와 하위 카드 소유권 |
| 그룹 문서 전달 | 1,080자, `4827bcad...` | 2,959자, `87945dcf...` | 현재 instructionId의 완료 보고 라우팅, 명시적 대체·자동 재개 |
| worker 새 대화(lease 있음) | 2,388자, `bccce8ca...` | 2,920자, `96d19f1a...` | 실제 할당 작업공간 1회, 중단 후 완료 신호 조건 |
| 그룹 상위 결과 수신 | 1,640자, `b7440170...` | 3,451자, `9b582b52...` | 결과 검수 후 승인된 후속 작업만 실행 |
| 사용자 중지 복구 | 2,906자, `990b8902...` | 3,710자, `87c085fd...` | 재구성된 미완료 작업·workspace·완료 신호 |

17개 동적 전문의 문자 합계는 21,135자 → 35,521자다. 이 합계는 서로 다른 경로의 예시 전문을 더한 계측값이지 단일 대화의 주입량이 아니다. 일부 전문(`parent-wake`, `dooray-proposal`)은 문자열 길이가 줄었지만, 기준선 조립 위치와 의미 검사를 통해 판정했다. 선택되지 않은 대화 전문은 전후 모두 빈 문자열이다. `tests/ai-instruction-snapshots.test.mjs`가 17개 각각의 전체 문자열 SHA-256, 승인·위임·복구·보고 의미, workspace 중복 여부를 검사한다. 실제 MCP 회귀는 초기 guide 및 선택 카드 context의 구조·행동을 별도로 검사한다.

MCP 도구는 전후 모두 **59개**이고 이름·`inputSchema` 조합 SHA-256은 양쪽 모두 `5beb90c211a2bdcf2966215ec45788750e8bd8ff5101cc20d13670f2ad38313e`다. 26개 도구 설명의 문자열이 변했고, `restore_history`, `update_document_info`, `recover_ai_delegation`의 안전 설명과 전역 `search_content` 설명은 유지됐다. 원시 표면의 이름 1,996자, 설명 12,546자, 스키마 JSON 46,313자, 실제 등록 전문 922자를 따로 계측한다. 문자열 길이 합계는 61,777자다. 이전 61,471자는 상수만 넣어 306자를 누락한 산식이었다. 이 합계는 전송 JSON 크기나 실제 호스트 총주입량이 아니다. 호스트 선언·wrapper·동적 주입 메타데이터는 관측하지 못했으며 과거 24,602자 선언과 도구당 35자 wrapper는 역사적 가정으로만 남겼다.

`tests/mcp-instruction-surface.test.mjs`는 59개 실제 MCP 응답을 전체 fixture와 비교하고, 기준선 직접 등록 도구의 상세 설명 문자열과 안전 설명·전역 검색의 의미를 검사한다. `npm run test:mcp`는 격리 서버에서 상세 guide, 최초 바인딩, 그룹 전달, 복구 후 상태 조회와 대기 일부 해제 등 동작 경로를 검증한다. 기준선에 이미 있던 지식선·대기·pagination 규칙은 신규 독립 개선으로 세지 않았다.

## 초기 응답과 정상 조립 경로 원문

`node scripts/capture-guidance-evidence.mjs`는 기준선 11a5079, 초기 시작 eaa7eed와 후보 HEAD의 Git archive를 후보 작업공간 안에 격리 추출한다. 실제 `mcp/server.mjs`·SDK Client를 실행하며 API는 결정적 fixture를 GET으로만 제공한다. 그룹 API는 각 Git 코드의 실제 `createGroupProjects.context`·`forDocument`를 실행한다. 운영 MCP·운영 카드·운영 API를 변경하거나 캡처에 사용하지 않는다. 원문·시각·Git 객체·소스 전체 문자열과 해시·요청 목록은 `initial-response-evidence.json`의 `runs`에 있다. 과거 코드를 현재 재현한 시점과 원래 Git 시점을 구분하므로 당시 운영 실측이라고 주장하지 않는다.

| 실제 guide | 초기 eaa7eed 후속 재현 | 기준선과 후보 | 기준선 전체 일치 해시 |
|---|---:|---:|---|
| `read_me_first.guide` | 1,471자 | 13,568자 | `585bf6a21ff8ad2646f38fb2d963bf6a50b5cef84b1f53d6eb67acb1c895ee74` |
| leaf `get_context.guide` | 1,742자 | 13,568자 | 위와 동일 |
| 총괄 `get_context.guide` | 1,742자 | 16,750자 | `696346e920fe9f58f70251cea9b1ed8bd3f47ae9136edc34ef0411ae97d9f2cc` |
| 문서 담당 `get_context.guide` | 1,742자 | 13,568자 | 일반 guide와 동일 |
| leaf·문서 담당 `get_group_context.guide` | 1,472자 | 5,403자 | `45562da4592486bfddf64175bece1674f29d51639aaab3457b14bc7fc5ffbda6` |
| 총괄 `get_group_context.guide` | 3,502자 | 5,403자 | 위와 동일 |

상수·등록 전문·도구 표면·초기 응답 guide·이벤트 17개 전문은 다른 계측 층이다. 위 guide 수치는 fixture의 해당 JSON 문자열이며 단일 대화 총주입량을 뜻하지 않는다. `sessions[].response.text`와 `groupResponse.text`가 실제 반환 원문이고 `guide.text`와 `groupGuide.text`는 그 안의 guide 전체를 직렬화한 문자열이다. `comparisons`와 `tests/initial-guidance-restoration.test.mjs`는 현재 실제 호출 결과가 기준선의 전체 guide와 정확히 같은지 검사한다. 상세 dataModel·operationRules·lifecycle, 총괄의 두 단계 승인, startupInspection·nextStep와 그룹 전달 경로를 확인한다. 17개 시작·위임·복구 전문은 기존 별도 snapshot 회귀로 함께 검증한다.
