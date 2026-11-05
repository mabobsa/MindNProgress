# Dooray 멘션 확인함 (Claude 데스크톱 확장 프로그램, Windows)

> **제작 종료 (2026-11-05, 기록 보관용 브랜치)**: 편집자 PC의 Claude 데스크톱 4.16336.0에서 대화창 안 화면(MCP Apps)이 표시되지 않았다. 앱은 `resources/list`만 호출하고 화면 리소스(`resources/read`)는 요청하지 않았다(채팅이 `[CCD]` 세션으로 실행되고 `localMcpBridge`가 도구만 전달). 브라우저 화면은 열렸지만 사용이 불편해 편집자 결정으로 제작을 종료했다. 다시 시도하려면 Claude 앱의 로컬 확장 MCP Apps 지원 여부부터 확인한다. 확장 설정 저장 때 뜨는 Windows 확인 창에서 취소하면 "변경 사항을 저장할 수 없습니다"가 난다.

기획자가 자신이 멘션되거나 담당·참조로 지정된 Dooray 업무와 댓글을 화면에서 확인하고, 확인한 항목을 체크해 숨기는 확장 프로그램(`.mcpb`)이다. MnP 카드: 「기획자용 Claude 데스크톱 Dooray 멘션 확인함」(MnP 유지보수 › 요청사항 대응).

## 화면 두 가지 (같은 화면 코드)

- **대화창 안 화면(MCP Apps)**: Claude 채팅에서 "Dooray 멘션 확인함 열어 줘"라고 하면 대화창 안에 열린다. 확인 체크, 숨긴 항목 되돌리기, Dooray 원문 열기, Claude 새 대화로 이어가기, 이 대화에서 이어가기, 브라우저에서 열기를 버튼으로 한다.
- **브라우저 화면**: 확장 서버가 Claude 앱이 켜져 있는 동안 `http://127.0.0.1:<포트>/?key=<접근 키>`로 띄운다. 대화창 안 화면의 「브라우저에서 열기」나 "브라우저로 열어 줘" 요청으로 열고, 북마크해 두면 채팅 없이 바로 쓸 수 있다. "새 대화로 이어가기"는 `claude://claude.ai/new?q=…` 링크로 Claude 새 대화 입력창에 요청을 채운다(자동 전송 안 함).

## 구조

- `server/inbox.mjs`: 확인 표시 저장, 번호 목록, 백그라운드 수집, 화면 상태(`uiState`), 업무 상세 조회. 멘션 수집·판정은 MnP의 `server/lib/doorayMentions.mjs`를 그대로 쓴다.
- `server/index.mjs`: MCP 서버. AI가 쓰는 도구 4개(`open_dooray_mention_inbox`, `list_dooray_mentions`, `check_dooray_mentions`, `get_dooray_task_detail`)와 화면 전용 도구 1개(`dooray_inbox_state`, `visibility: ["app"]`), 화면 리소스 `ui://dooray-mention-inbox/inbox.html`
- `server/web.mjs`: 브라우저 화면용 로컬 웹 서버
- `server/main.mjs`: 확장 프로그램 진입점. 빌드된 `ui/inbox.html`을 읽어 서버와 브라우저 화면에 넘긴다.
- `shared/inbox-shared.mjs`: 서버·화면 공통 함수(종류 이름, 시각 표시, Dooray 링크 확인, 이어가기 요청 문구, Claude 새 대화 링크)
- `ui/inbox.html`, `ui/app.mjs`: 확인함 화면. 빌드 때 스크립트를 HTML 한 장에 넣는다.
- `manifest.json`: 확장 프로그램 정보(Windows 전용). 설치 화면에서 Dooray API 토큰(필수)과 확인할 프로젝트 코드(선택)를 받는다.
- `scripts/build.mjs`: 서버·화면을 묶고 `mcpb validate`·`pack`으로 `.mcpb`를 만든다.

## 빌드와 시험

```bash
npm install --prefix extensions/dooray-mention-inbox      # 처음 한 번(MCP SDK 1.29, MCP Apps SDK 1.7.5, zod 3)
node extensions/dooray-mention-inbox/scripts/build.mjs   # dist/dooray-mention-inbox-<버전>.mcpb
node --test tests/dooray-mention-inbox-extension.test.mjs
MNP_BROWSER_TEST=1 node --test tests/dooray-mention-inbox-browser.test.mjs   # Chrome으로 두 화면 확인
```

- 의존성은 이 폴더의 `package.json`에만 있고 MnP 본체 의존성과 섞지 않는다. 의존성이 없으면 서버·화면 시험은 건너뛴다.
- 번들은 의존성을 모두 묶으므로 설치한 PC에 `node_modules`가 필요 없다. 실행은 Claude 앱에 내장된 Node가 맡는다.
- 버전을 올릴 때는 `manifest.json`의 `version`과 `server/version.mjs`의 `SERVER_VERSION`을 함께 바꾼다. 빌드가 두 값과 이름 일치를 검사한다.

## 동작과 제약

- 처음 확인하거나 기간을 늘리면 참여 중인 프로젝트의 업무를 모두 확인한다. Dooray 요청 한도(초당 약 4.5건) 때문에 수 분이 걸릴 수 있다(프로젝트 51개·업무 488건, 14일 기준 약 4분). 다음부터는 바뀐 업무만 확인한다(같은 조건 약 16초). 화면은 저장된 마지막 목록을 먼저 보여 주고 진행률을 표시한다.
- 채팅 도구(`list_dooray_mentions`)는 최대 45초만 기다리고, 끝나지 않으면 진행 상황을 돌려준 뒤 백그라운드에서 수집을 계속한다. 채팅 번호는 목록을 보여 줄 때만 바뀐다.
- 확인 표시·캐시는 Dooray 사용자별로 이 PC에만 저장한다(`%APPDATA%\dooray-mention-inbox\state.json`, 확인 표시 180일 보존).
- 브라우저 화면은 `127.0.0.1`에서만 열리고, 포트와 접근 키를 `%APPDATA%\dooray-mention-inbox\web.json`에 저장해 다시 쓴다. 페이지는 주소의 접근 키, API는 `X-Inbox-Key` 헤더로 확인하며 Host·Origin을 검사한다. `Referrer-Policy: no-referrer`로 Dooray 링크를 열 때 접근 키가 전달되지 않게 한다. 다른 프로그램이 포트를 쓰면 새 포트를 골라 저장한다(이때 북마크를 다시 해야 한다).
- Dooray에서 온 제목·본문은 화면에서 글자로만 넣고 HTML로 해석하지 않는다. Dooray 원문 링크는 `https://*.dooray.com`일 때만 연다.
- 업무 본문·댓글을 쓰거나 Dooray 상태를 바꾸지 않는다. Dooray API는 조회만 한다.
