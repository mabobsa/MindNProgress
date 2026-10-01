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
