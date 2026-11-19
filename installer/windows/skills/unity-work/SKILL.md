---
name: unity-work
description: >
  Unity 프로젝트에서 MCP로 에디터를 조작하거나 Unity UI 코드를 작성할 때 사용한다.
  대상 에디터 인스턴스 지정(assetsPath → SHA1 hash 산출과 projectRoot 검증), 여러 에디터가
  한 MCP 서버를 공유할 때의 라우팅 사고 방지, execute_code 경로 가드, 임시 오브젝트 정리,
  다른 에디터에 남은 부산물 회수, UI 레이아웃 책임 분리(RectTransform·LayoutGroup·ScrollRect)를
  다룬다. unityMCP 도구(execute_code, manage_gameobject, manage_components, manage_prefabs,
  manage_asset, manage_scene, create_script, manage_editor, run_tests 등)를 호출하기 전이나
  Unity UI 배치를 다루는 코드를 쓰기 전에 읽는다.
---

# Unity 작업 절차

전역 지침에는 불변조건만 있다. 이 문서는 그 불변조건을 **어떻게 지키는지**와 어겼을 때의 복구 절차를 담는다.

Unity MCP 도구의 일반 사용법은 현재 연결된 도구 설명을 따르고, 이 문서는 이 환경에서 추가로 필요한 안전 규칙과 복구 절차를 정의한다.

## Fork 배정 직후 Unity 코드 반영 확인

배정(`leaseId`)마다 최초 1회 수행한다. 재개·지침 재전달 때는 이 배정의 확인 기록(5번)이 진행 보고에 있을 때만 생략하고, 기록을 찾지 못하면 1회 수행한다.

1. `unity-work`의 대상 지정 절차로 인스턴스를 확정한다(`mcpforunity://project/info`의 `projectRoot`가 배정된 `projectRoot`와 같아야 한다). 대상 에디터가 없거나 MCP가 연결되지 않으면 4번으로 간다.
2. `git status`와 `mcpforunity://editor/state`의 `compilation.last_compile_finished_unix_ms`·`last_domain_reload_after_unix_ms`를 요청 전 기준으로 기록하고, `unity_instance`를 지정해 `refresh_unity(mode="force", scope="all", compile="request", wait_for_ready=false)`를 한 번 호출한다.
3. `editor/state`에서 기준보다 새로운 컴파일 시작·종료와 재로딩 완료(시작 ≤ 종료 ≤ 재로딩)를 확인한다. 응답의 `data.unity.instance_id`가 대상과 다르면 근거로 쓰지 않는다. 그다음 경로 가드를 넣은 읽기 전용 `execute_code`로 `EditorUtility.scriptCompilationFailed=false`와 `EditorApplication.isCompiling`·`isUpdating`이 모두 false인지 확인한다. 요청 성공·`idle`·요청 전 기록은 완료 근거가 아니다.
4. 다음 경우에는 기다리지 않고 보고한 뒤 가능한 소스 작업을 계속한다.
   - 컴파일 실패: 재로딩을 기다리지 않고 `read_console` 오류를 근거로 "배정 시점 컴파일 실패"를 보고한다. 담당 범위 밖 오류는 고치지 않는다.
   - 요청 후 10분 안에 3번을 확인하지 못했거나 MCP가 연결되지 않음: **Unity 검증 미완료**로 보고한다. 연결이 끊기면 요청을 반복하지 않고 `unity-work`의 재연결 절차를 따른다.
5. 결과(`leaseId`, 기준·완료 시각, 실패 여부)를 진행 보고에 남긴다. 갱신 뒤 `git status`에 새 tracked 변경이 생겼으면 구현 체크포인트에 넣지 말고 경로를 보고한다.

## 빌드·컴파일·도메인 재로딩 중 Unity MCP 연결 끊김

Unity 빌드·스크립트 컴파일·도메인 재로딩 중에는 MCP 연결이 일시적으로 끊기거나 요청이 시간 초과될 수 있다. **연결 오류 한 번만으로 작업 실패·진행 불가를 판정하거나 상위 AI에 차단 보고하지 않는다.** 응답이 끊겼어도 요청한 작업은 계속 실행 중이거나 이미 완료됐을 수 있다.

1. **우선 재연결 대기로 처리한다.** 끊기기 직전 작업, 대상 프로젝트, 인스턴스와 작업 ID가 있으면 기록한다.
2. **30초 간격으로 연결과 상태를 재확인한다.** 재시도 대상은 인스턴스 목록·작업 상태 같은 조회다. 빌드·테스트·에셋 변경 명령을 반복 전송하지 않는다.
3. **5분간 복구되지 않으면 원인을 진단한다.** 해당 프로젝트의 에디터 프로세스와 로그를 확인한다. 빌드·컴파일 진행이 확인되면 기존 작업의 제한 시간 안에서 기다린다. 5분 경과만으로 실패 판정하지 않는다.
4. **재연결 후 대상부터 다시 검증한다.** 기존 인스턴스 지정만 믿지 말고 `projectRoot`가 배정된 프로젝트와 일치하는지 확인한다. 이후 호출에도 기존 `unity_instance` 지정·경로 가드 규칙을 적용한다.
5. **원래 작업의 결과를 확인하고 이어간다.** 완료됐다면 다음 단계로, 실행 중이면 상태 확인으로 이어간다. 실행 여부가 불명확한 변경 명령은 바로 재전송하지 않는다.
6. **복구를 기다리는 동안 가능한 독립 작업은 계속한다.** 진행 보고에는 “Unity MCP 재연결 대기 중”이라고 표시하고, 검증하지 못한 작업을 완료로 보고하지 않는다.
7. **차단 보고에는 확인 근거를 포함한다.** 에디터 종료·충돌, 작업 제한 시간 초과, 대기·진단 후에도 진행과 연결 복구를 확인할 수 없는 경우에는 경과 시간·재확인 횟수·마지막 오류·로그 근거·미완료 작업을 상위 AI에 보고한다.

연결 복구를 이유로 에디터나 MCP 서버를 임의로 종료·재시작하지 않는다. 명확한 컴파일 오류·권한 오류·잘못된 인자 오류는 일시적인 연결 끊김과 구분해 처리한다.

30초·5분은 기본 운영 기준이며 Unity가 보장하는 복구 시간은 아니다.

## Unity UI 레이아웃 관리 규칙

- **아래 배치 제한과 동적 레이아웃 승인 규칙은 실서비스에 사용되는 UI에만 적용한다.**
- 실서비스 UI의 레이아웃 값은 아트 디자이너가 프리팹과 에디터에서 결정한다. 다음 값을 코드에서 결정하거나 Play 진입 시 덮어쓰지 않는다.
  - `RectTransform`의 부모·앵커·피벗·위치·크기·스케일
  - `GridLayoutGroup`, `HorizontalLayoutGroup`, `VerticalLayoutGroup`의 셀 크기·간격·패딩·정렬·제약
  - `ScrollRect`의 가로·세로 활성화와 Viewport/Content 레이아웃
- UI 코드는 데이터 표시, 아이템 생성, 이벤트 연결, 서비스별 노출 여부 등 동작만 담당하고 시각적 배치는 직렬화된 프리팹 값을 사용한다.
- 데이터에 따라 반드시 동적으로 계산해야 하는 레이아웃은 사용자에게 필요성과 적용 범위를 먼저 설명하고 명시적으로 확인받은 경우에만 코드로 처리한다.
- 개발·디버그·검수·테스트 전용 UI는 코드로 배치와 동적 레이아웃을 구현할 수 있다. 승인된 구현 범위라면 아트 배치 확정이나 별도의 레이아웃 승인을 기다리지 않는다.
- 실행 환경이 아니라 UI의 실제 용도로 구분한다. Development 빌드의 개발 전용 패널도 예외에 포함하지만, 실서비스 UI를 검수한다는 이유만으로 예외를 적용하지 않는다.

## unityMCP 대상 에디터 지정 규칙

여러 유니티 에디터가 하나의 MCP 서버를 공유할 수 있다. 어느 에디터를 조작하는지 항상 확정한 뒤 작업한다.

- **unityMCP 도구를 처음 사용하기 전에 `set_active_instance`로 현재 작업 폴더에 해당하는 인스턴스를 지정한다.** 이 지정은 다른 세션에 영향을 주지 않는다. 다만 **세션 고정을 보장하지는 않으므로**(아래 「라우팅 사고 방지」 참조) 이것만 믿지 않고 매 변경 호출에 `unity_instance`를 함께 넘긴다.
- **인스턴스 ID는 사용자에게 묻지 않고 스스로 산출한다.**
  1. 현재 작업 폴더의 역슬래시를 `/`로 바꾸고 `/Assets`를 붙여 `assetsPath`를 만든다. (예: `C:\Git\Foo\client` → `C:/Git/Foo/client/Assets`)
  2. `SHA1(assetsPath)`의 앞 16자가 인스턴스 hash다.
  3. `mcpforunity://instances`에서 hash가 일치하는 항목의 `Name@hash`를 `set_active_instance`에 넘긴다.
  4. **검증**: `mcpforunity://project/info`의 `projectRoot`가 현재 작업 폴더와 같은지 확인한다. 다르면 잘못 잡은 것이므로 다시 지정한다.
- hash 산출이 맞지 않으면 후보를 하나 지정한 뒤 4번으로 확인하고, 틀리면 다른 후보로 교체하는 방식으로 판별한다.
- `mcpforunity://instances` 응답에는 프로젝트 경로가 없다. 같은 프로젝트를 복제해 병렬 작업하면 `name`이 겹치므로 **이름만으로 대상을 판단하지 않는다.**
- 인스턴스가 2개 이상 연결된 상태에서 지정하지 않으면 서버가 에러를 반환한다. 엉뚱한 에디터가 조작되지는 않으므로, 이 에러가 나면 지정 누락을 먼저 의심한다.
- 단발 호출만 다른 에디터로 보낼 때는 세션 기본값을 바꾸지 않고 해당 도구 호출에 `unity_instance` 파라미터를 넘긴다 (hash prefix 허용).
- 에디터가 하나만 연결된 상태에서도 지정해두면 이후 두 번째 에디터가 붙었을 때의 오동작을 예방할 수 있다.

### 라우팅 사고 방지 (필수)

`set_active_instance`는 세션 고정을 **보장하지 않는다.** 연결이 한 번 끊겼다 복구되면(`refresh_unity`가 `recovered from disconnect`를 반환하는 상황) 이후 호출이 조용히 다른 에디터로 넘어갈 수 있다. 이 때문에 다른 병렬 작업 폴더의 씬에 임시 오브젝트가 생성된 사고가 실제로 발생했다.

- **프로젝트를 변경하는 도구는 매 호출에 `unity_instance`를 직접 지정한다.** (`execute_code`, `manage_gameobject`, `manage_components`, `manage_prefabs`, `manage_asset`, `manage_scene`, `create_script`/`apply_text_edits`/`script_apply_edits`, `manage_editor`, `run_tests` 등) `set_active_instance`는 보조 수단으로만 쓴다.
- **클라이언트에 표시된 도구 스키마에 `unity_instance`가 없어도 인자로 넘긴다.** 서버 안내가 모든 도구 호출에 이 인자를 허용한다. 이 PC의 Claude Code 대화 기록에는 스키마에 없는 이 인자를 넘겨 성공한 호출이 있고, unity-guard 로그의 통과 호출도 대부분 이 인자를 포함했다(2026-10 확인. 로그는 클라이언트를 구분하지 않는다).
  - 클라이언트가 인자 자체를 거부(스키마 검증 오류)하면 변경 작업을 중단하고 사용자에게 보고한다. unity-guard를 우회하거나 `set_active_instance`만으로 변경을 진행하지 않는다.
  - 그 상태에서 조회만 계속할 때는 매 조회 직전에 `set_active_instance`를 다시 호출하고 `mcpforunity://project/info`의 `projectRoot`로 대상을 확인한다. 이렇게 얻은 결과도 보고할 때 라우팅을 인자로 고정하지 못했다고 밝힌다.
- **검증 근거로 쓰는 조회도 같은 인스턴스로 보낸다.** `read_console`, `get_test_job`, `find_gameobjects` 같은 조회는 unity-guard가 인스턴스 없이 통과시키지만(`manage_scene get_hierarchy` 같은 `manage_*` 조회 동작과 조회 전용 `batch_execute`는 `unity_instance`가 없으면 차단된다), 컴파일 성공·테스트 통과·씬 상태를 판단할 근거라면 변경 호출과 같은 `unity_instance`를 넘긴다. 재연결(`recovered from disconnect`) 뒤의 조회 결과는 `projectRoot`나 `execute_code` 경로 가드 결과로 대상을 다시 확인하기 전에는 근거로 쓰지 않는다.
- **`batch_execute`는 한 인스턴스만 대상으로 하고 상위 호출에 `unity_instance`를 넘긴다.** 내부 명령에도 같은 규칙(경로 가드, replay 금지)이 적용된다. 내부에 `set_active_instance`나 다른 `batch_execute`를 넣지 않고, 내부 `params`의 `unity_instance`로 대상을 바꾸지 않는다. 내부 인자의 라우팅 반영은 확인되지 않았다.
- unity-guard hook(`C:/Users/NHN/.agent-rules/hooks/unity-guard.cjs`, Claude·Codex 공용)이 위 규칙을 강제한다. 조회 전용으로 등록된 도구·동작 외의 호출은 `unity_instance`가 없으면 차단되고, 목록에 없는 새 도구·동작은 쓰기로 간주된다. 차단 메시지를 받으면 인자를 보완해 다시 호출하고 hook을 끄거나 우회하지 않는다. hook 자체의 파싱 실패·내부 오류로 차단되면 사용자에게 보고하고, hook 수정·등록 해제는 사용자 승인 뒤에만 한다.
- **`execute_code`는 첫 줄에 경로 가드를 넣는다.** 기대 경로가 아니면 아무것도 하지 않고 즉시 반환한다.
  ```csharp
  if (Application.dataPath != "C:/Git/Foo/client/Assets")
      return "WRONG INSTANCE: " + Application.dataPath + " — aborted";
  ```
- **`execute_code`의 `replay`는 쓰지 않는다.** 히스토리는 인스턴스별이므로 엉뚱한 에디터에서 전혀 다른 코드가 실행될 수 있다. 재실행이 필요하면 코드를 다시 보낸다.
- **리소스 조회(`mcpforunity://...`)에는 `unity_instance`를 넘길 수 없다.** 응답의 `instance_id`·`projectRoot`로 대상을 확인하고, 기대한 인스턴스가 아니면 그 결과를 판단 근거로 삼지 않는다.
- **에디터에서 생성한 임시 오브젝트는 `try`/`finally`로 파괴한다.** 예외가 발생하면 정리 코드에 도달하지 못해 씬에 부산물이 남는다.
- 쓰기 작업이 실패했거나 대상이 틀렸다면 **다른 에디터에 부산물이 남았는지 즉시 확인해 회수하고 사용자에게 보고한다.** 이때 다른 작업 폴더의 씬·에셋은 저장하지 않고 dirty 상태를 그대로 둔다.
