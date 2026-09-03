# Mind & Progress

Mind & Progress는 아이디어의 구조와 실제 업무 진행 상태를 하나의 문서에서 관리하는 웹 기반 협업 도구입니다. 마인드맵으로 생각과 업무의 관계를 정리하고, 같은 데이터를 칸반·타임라인·대시보드로 전환해 실행 상황을 확인할 수 있습니다.

선택한 카드에서 AionUi 대화를 시작하고 MindNProgress MCP를 연결하면 Claude, Codex, Copilot 등의 AI가 최신 문서 문맥을 조회하고 편집자의 권한으로 카드와 댓글을 수정할 수 있습니다. AI 응답은 AionUi에서 처리하며 MindNProgress에는 대화 연결 상태와 변경 결과만 반영됩니다.

## 주요 기능

### 마인드맵과 업무 관리

- 노드 생성·수정·다중 선택·복사·붙여넣기·삭제와 부모 변경
- PNG·JPEG·GIF·WebP 이미지 드래그 드롭과 클립보드 붙여넣기, 비율 유지 크기 조절, 확대 보기와 우클릭 원본 삭제
- 동일 문서 복사본과 문서 간 독립 Clone 또는 원본 Ref 붙여넣기
- Ref 노드의 원본 문서 이동과 원본 댓글 조회·작성·실시간 반영
- 상위 노드 이동 시 전체 하위 트리 동시 이동
- 베지어 화살표 기반 계층 연결과 지식 관계선 편집
- 노드별 제목, 업무 설명, 공유 지식, 상태, 진행률과 업무 링크 관리
- 담당자, 마감일, 체크리스트, 선행·후속 업무 관계
- 서버·아트·기획 등 구분을 고정하지 않는 복수 대기 항목과 재개 조건
- 노드의 상시 대기 말풍선과 문서 목록 대기 표시, 대기 항목 위치 바로가기
- 체크리스트 완료율과 업무 진행률 자동 동기화
- 완료, 진행 중, 예정, 차단 상태와 병목 표시
- 미니맵, 확대·축소, 전체 보기, 하위 가지 접기, 검색과 필터
- 문서 변경 시 마인드맵 전체 보기 전환과 현재 탭 기준 노드 링크 복사
- 문서 목록에서 Root 노드 진행률과 예정·진행 중·완료 상태 구분

### 여러 관점의 진행 상황

- 마인드맵: 문서의 전체 구조와 관계 편집
- 칸반: 업무 노드를 상태별로 조회하고 드래그하여 상태 변경
- 타임라인: 마감일 기준 실행 순서 확인
- 대시보드: Root 기준 문서 진행률과 전체 업무 단순 평균을 구분하고 완료율, 기한 초과, 담당자 분배와 차단·대기 병목 확인
- 대시보드 지표 카드: 전체·완료·진행 중·기한 초과·차단·대기 업무 목록을 선택하여 하단에서 확인

칸반·타임라인·대시보드에는 `업무 관리`가 활성화된 노드만 표시됩니다.

### 문서와 협업

- 여러 문서 생성, 1단계 그룹화, 그룹 접기·펼치기, 그룹·개별 문서 혼합 드래그 정렬
- 문서 색상 지정과 휴지통 이동·복원·영구 삭제
- 좌측 문서 목록과 우측 세부정보 패널의 너비 조절 및 브라우저별 너비 저장
- 문서별 최대 100단계 실행 취소·다시 실행
- 노드별 요약·접이식 상세 댓글, 답글, 멘션, 해결 상태와 이모지 반응
- 문서별 변경 이력을 최근 항목부터 50개씩 제한 없이 추가 조회하고 이전 버전 복원
- 날짜별 최신 상태를 제한 없이 보관하는 자동 일일 백업과 복원
- 기존 변경 이력의 날짜별 최신본을 일일 백업으로 자동 백필
- 다른 브라우저의 변경 감지, 실시간 커서와 뷰어 자동 반영
- 문서 버전 충돌 감지와 노드·필드 단위 3방향 자동 병합
- 담당 업무의 마감 3일 전·당일·기한 초과 알림
- 전체 활성 문서의 공유 지식 길이·구조·정확 중복·지식선 소비 현황을 원문 노출과 문서 변경 없이 조회

### 계정과 권한

- 관리자, 편집자, 뷰어 역할 구분
- 관리자 전용 편집자 계정 생성·수정·정지·비밀번호 초기화·삭제
- 로그인 사용자의 현재 비밀번호 확인 기반 비밀번호 변경
- 8시간 기본 세션과 최대 30일 `로그인 유지` 세션
- 로그인 뷰어의 문서 읽기·댓글 협업과 문서 편집 차단
- 로그인하지 않은 공유 방문자를 위한 공개 읽기 전용 접근
- 공개 뷰어의 문서·댓글 변경 요청을 API 서버에서도 차단
- 뷰어에게 AI 대화 상태를 표시하되 실행 시 편집자 전용 안내

### AionUi와 AI

- 선택 카드에서 AionUi 새 대화 시작
- 카드에서 시작한 여러 AionUi 대화와 당시 선택한 AI·모델·권한·사고 수준·스킬·MCP·작업 공간을 보존하고 선택해 다시 열기
- 마인드맵 노드 우클릭 메뉴에서 AI 대화 시작 또는 연결된 대화 열기
- AI 종류, 모델, 권한, 사고 수준, 스킬, MCP, 작업 공간 선택
- 문서별 작업 공간과 마지막 AI 옵션 기억
- `mindnprogress_get_context`의 선행 지식·외부 업무 조사·대화 기록 조회 지침을 첫 요청에 전달
- 선택 카드와 최상위 카드의 업무 링크를 독립적으로 AI 문맥에 제공
- 카드에 연결된 AionUi 대화 전문을 MCP에서 필요할 때 조회
- AI가 변경한 댓글과 변경 이력에 `{AI 종류}({모델})` 작성자 표시
- 문서·카드·업무·체크리스트·관계·댓글·대화·이력·휴지통·알림 MCP 도구

## 구성

```text
브라우저
  ├─ React + React Flow 화면        : 4175 (개발 서버)
  └─ HTTP API / 정적 파일 요청
          ↓
MindNProgress Node.js 서버          : 4176 (기본값)
  ├─ 문서·계정·댓글·이력·일일 백업 JSON 저장 : server/data
  ├─ 문서별 원본 이미지 자산 저장             : server/data/_assets
  ├─ AionUi 실행 포트 자동 탐색
  └─ 로컬 MCP 인증 토큰 관리
          ↕
AionUi ── Claude / Codex / Copilot 등
  └─ MindNProgress MCP (stdio)
```

현재 데이터 저장소는 별도 데이터베이스가 아닌 로컬 JSON 파일과 이미지 자산 폴더입니다. `server/data`의 런타임 파일은 Git에서 제외됩니다.

## 외부 전체 백업과 복원

Windows에서는 저장소 루트의 `MindNProgress_Backup.bat`을 실행하면 Git으로 복구할 수 없는 운영 데이터를 기본적으로 저장소와 같은 상위 폴더의 `MindNProgress_Backup\YYYY-MM-DD` 아래에 시간별 ZIP 파일로 백업합니다.

```bat
MindNProgress_Backup.bat
```

백업에는 `server/data` 전체와 존재하는 로컬 `.env*`·`*.local` 설정이 포함됩니다. 문서, 계정, 세션, 댓글, 알림, 변경 이력, 일일 백업, 문서별 원본 이미지, MCP 토큰과 AI 작성자 귀속을 함께 보존하며 `node_modules`, `dist`, 로그와 PID 같은 재생성 가능한 파일은 제외합니다. 서버가 실행 중이면 일관된 시점의 데이터를 복사하기 위해 잠시 중지하고, 스냅샷 복사가 끝나는 즉시 기존 실행 상태로 자동 복구한 뒤 압축과 검증을 계속합니다. ZIP 검증이 끝나면 서버를 다시 잠시 중지하고 현재 문서·변경 이력·일일 백업 어디에서도 참조하지 않는 24시간 이상 된 이미지 자산만 정리한 뒤 실행 상태를 복구합니다. 삭제 대상도 정리 직전 ZIP에는 포함되므로 필요하면 백업에서 복원할 수 있습니다.

각 ZIP에는 파일별 크기와 SHA-256을 기록한 `manifest.json`과 수동 복원 안내 `RESTORE.txt`가 포함됩니다. 배치는 ZIP을 다시 풀어 manifest와 대조한 뒤에만 완료 처리합니다. 복원은 동일한 소스 버전을 준비한 후 다음처럼 실행합니다.

```bat
MindNProgress_Restore.bat "..\MindNProgress_Backup\2026-07-30\MindNProgress_2026-07-30_120000.zip"
```

복원 배치는 ZIP을 검증하고 현재 `server/data`를 `.mindnprogress\pre-restore-data-*`에 보관한 뒤 백업 데이터로 교체합니다. 데이터 마이그레이션은 수행하지 않으므로 다른 버전으로의 복원은 보장하지 않습니다. 백업에는 계정과 세션, MCP 인증 토큰이 포함되므로 외부에 공유하지 마세요.

기본 백업 경로를 바꿔야 하는 테스트·운영 환경에서는 `MNP_BACKUP_DIR` 환경변수를 사용할 수 있습니다. 운영 데이터가 실수로 Git에 포함되지 않도록 저장소 루트와 그 하위 경로는 백업 대상으로 지정할 수 없으며, 반드시 저장소 외부 경로를 사용해야 합니다.

## 요구 사항

- Node.js `20.19.0` 이상 또는 `22.12.0` 이상
- npm
- AI 대화 기능을 사용할 경우 실행 중인 AionUi

## 설치 및 실행

### Windows Git 개발 환경 일괄 설치

MnP Suite Windows Git 설치 패키지는 업무 PC에 MindNProgress, AionUi와 AionCore 개발 환경을 한 번에 준비합니다. 현재 검증된 배포본은 [`MnPSuite-Windows-Git-Installer-20260828-v15.zip`](https://github.com/mabobsa/MindNProgress/releases/download/mnp-suite-installer-20260828-v15/MnPSuite-Windows-Git-Installer-20260828-v15.zip)이며, SHA-256은 `1E84D328A493924EE410D73DDC7135770D322BD2A5BE433A8B7C23B0D9F87E30`입니다. 배포 파일명은 `MnPSuite-Windows-Git-Installer-YYYYMMDD-vN.zip` 형식을 사용하며, 압축을 푼 뒤 루트의 `Install-MnPSuite.bat`을 실행합니다. 저장소에서 직접 사용할 때는 [`installer/windows`](installer/windows/README.md)의 같은 파일을 실행하면 됩니다.

설치 패키지는 다음 작업을 순서대로 수행합니다.

- 사용자가 선택한 설치 루트 아래에 MindNProgress, AionUi와 AionCore를 독립 Git 저장소로 설치
- 설치 중 각각 선택한 Dooray MCP와 PowerPoint MCP를 Git 저장소로 추가하고 Windows 네이티브 런타임 준비
- Node.js·Bun·Rust·Python·Visual Studio C++ Build Tools 등 필수 도구 확인과 선택적 자동 설치
- JavaScript 의존성 설치, 로컬 AionCore release 빌드와 전체 Dev 실행·중지·백업·복원 배치 생성
- AionUi 최초 실행 시 `MindNProgress · 필수`와 선택한 `dooray-mcp`·`pptx-mcp`를 자동 등록하고 현재 설치 경로로 동기화
- 비활성 상태의 Unity 멀티 작업공간 템플릿과 Unity MCP·Fork 운영 가이드 설치
- 현재 Windows 사용자의 Claude Code와 Codex에 팀 공통 전역 스킬과 호출 지침 설치

전역 스킬 구성은 다음과 같습니다.

| 스킬 | 설치 방식 | 적용 범위 |
| --- | --- | --- |
| `mnp-dooray` | 필수 | MnP 장문 안전 편집·복구, 업무 설명·공유 지식·댓글 역할, 상태·진행률, Dooray 기록 |
| `unity-work` | 선택 | Unity 인스턴스 오수정 방지, `execute_code` 경로 검증, Unity UI 레이아웃 책임 분리 |
| `pptx` | 선택 | PPTX 슬라이드의 PNG 렌더링과 텍스트·표 구조를 함께 확인하고 차이 기록 |

스킬은 Codex의 `.codex\skills`와 Claude Code의 `.claude\skills`에 각각 설치합니다. 두 전역 폴더가 모두 없거나 하나만 있어도 필요한 폴더를 생성합니다. 기존 `AGENTS.md`와 `CLAUDE.md`는 덮어쓰지 않고 MnP Suite 관리 블록만 병합하며, 실제 수정 직전에 같은 폴더에 날짜가 포함된 `<파일명>.mnp-suite-backup-YYYYMMDD-HHmmssfff.bak` 복사본을 매번 만듭니다. 문제가 생기면 AI 세션을 닫고 원하는 날짜의 복사본을 원래 지침 파일명으로 복사해 복원할 수 있습니다. 같은 이름의 사용자 소유 스킬이 있으면 덮어쓰지 않고 설치를 중단합니다. AionUi Assistant의 스킬이나 시스템 프롬프트는 변경하지 않습니다.

대화형 설치는 설치 위치 선택 후 신규 설치와 재설치 모두 `unity-work`, `pptx` 스킬과 `dooray-mcp`, `pptx-mcp` 설치 여부를 Y/N으로 각각 확인하고, 설치 계획 확인, 누락 도구 설치, 저장소 준비, 빌드·검증과 완료 안내로 이어집니다. 재설치에서 기존 패키지 관리 선택은 기본값이 `Y`입니다. 선택 스킬을 `N`으로 바꾸면 설치 후 수정되지 않은 스킬과 호출 지침만 안전하게 제거하고, 선택 MCP를 `N`으로 바꾸면 MnP Suite가 등록한 항목만 다음 AionUi 실행 때 제거합니다. Dooray API 키는 로그·manifest에 넣지 않고 현재 Windows 사용자 DPAPI로 암호화합니다. PowerPoint MCP는 전용 Python 가상환경과 Windows COM 의존성을 사용하며, 슬라이드 렌더링은 PowerPoint COM을 1순위로 선택합니다. COM이 없는 PC에서는 `pptx` 스킬이 AionUi에 기본 포함된 OfficeCLI HTML 렌더러를 사용합니다. OfficeCLI에는 원본 가로 크기의 150 DPI 환산 너비만 전달하고 높이와 최대 변 1920px 상한 처리는 렌더러에 맡깁니다. Windows PowerShell 5.1의 네이티브 인수 전달을 고려해 PowerPoint MCP 모듈 검사는 import 종료 코드로 판정하며, 네이티브 명령의 stdout·stderr도 설치 로그에 남깁니다. 무인 설치 옵션, 기존 저장소 재사용·업데이트 조건, 전역 설정 경로와 실패 후 재실행 방법은 [Windows 설치 패키지 상세 안내](installer/windows/README.md)를 확인하세요.

클라이언트 개발자가 Unity MCP를 연결하고 AionUi·AionCore 소스 fork와 Unity worker 작업공간을 구분해 운영하는 방법은 [`클라이언트 사용자용 Unity MCP 및 Fork 운영 가이드`](installer/windows/UNITY_MCP_AND_FORK_GUIDE.md)를 참고합니다.

설치 후 `dev\Start-All-Dev.bat`을 실행하고, AionUi가 열린 다음 MnP의 `AI 대화 시작`에서 `MindNProgress · 필수`와 설치 중 선택한 MCP가 표시되는지 확인합니다. 실제 적용된 저장소 버전, 선택 MCP, 스킬과 전역 설정 경로는 설치 루트의 `installation-manifest.json`에 기록됩니다.

PC마다 이렇게 설치한 MindNProgress의 `server/data`는 서로 독립되며 자동 동기화되지 않습니다. 설치 패키지 재실행이나 Git 업데이트가 운영 데이터를 동기화하지 않으므로, 공동 문서가 필요하면 별도의 팀 호스트 구성을 사용해야 합니다.

### macOS Git 개발 환경 일괄 설치

macOS에서는 [`installer/macos/Install-MnPSuite.sh`](installer/macos/Install-MnPSuite.sh)를 사용합니다. 이 설치기는 MindNProgress, AionUi, AionCore를 한 루트에 복제하고, 선택한 Dooray MCP와 PowerPoint MCP의 macOS 런타임을 준비합니다. Windows DPAPI 대신 Dooray 키를 macOS Keychain에 보관하고, PowerPoint COM 대신 LibreOffice 렌더링을 사용합니다. PowerPoint MCP 선택 시 Noto CJK·나눔·은글꼴을 사용자 폰트로 설치하고 한글 PPTX의 실제 PNG 렌더링까지 확인합니다.

```bash
cd installer/macos
chmod +x Install-MnPSuite.sh
./Install-MnPSuite.sh --install-missing-prerequisites \
  --include-dooray-mcp --include-pptx-mcp --launch
```

실제 파일을 만들지 않고 사전 점검하려면 `--plan-only`를 추가합니다. 전체 옵션과 실행 방법은 [macOS 설치 패키지 안내](installer/macos/README.md)를 확인하세요.

### MindNProgress만 직접 실행

```bash
git clone https://github.com/mabobsa/MindNProgress.git
cd MindNProgress
npm install
npm run dev
```

개발 서버가 실행되면 브라우저에서 `http://127.0.0.1:4175/`에 접속합니다. Vite 개발 서버가 화면을 제공하고 `/api` 요청을 `127.0.0.1:4176`의 API 서버로 전달합니다.

배포 빌드를 API 서버가 함께 제공하게 하려면 다음과 같이 실행합니다.

```bash
npm run build
npm start
```

이 경우 기본 접속 주소는 `http://127.0.0.1:4176/`입니다. 다른 PC에서도 접근하게 하려면 API 호스트와 공개 URL을 명시합니다.

```powershell
$env:MNP_API_HOST='0.0.0.0'
$env:MNP_API_PORT='4175'
$env:MNP_WEB_PORT='4175'
$env:MNP_PUBLIC_URL='http://192.168.0.10:4175'
npm start
```

방화벽에서 선택한 포트의 인바운드 연결도 허용해야 합니다. 이 프로젝트는 자체 HTTPS 종료를 제공하지 않으므로 외부 인터넷에 직접 노출하기보다는 신뢰할 수 있는 내부망에서 사용하거나 HTTPS 리버스 프록시 뒤에 배치하는 것을 권장합니다.

## 최초 관리자 계정

최초 실행 시 저장된 계정이 없으면 관리자 계정이 자동 생성됩니다. 기본 이메일은 `admin@mind.local`이며 일회성 임시 비밀번호가 서버 콘솔에 한 번 표시됩니다.

초기 계정을 직접 지정하려면 최초 실행 전에 환경변수를 설정합니다.

```powershell
$env:MNP_ADMIN_EMAIL='admin@example.com'
$env:MNP_ADMIN_PASSWORD='8자 이상의 비밀번호'
npm run dev
```

이 값은 관리자 계정을 처음 생성할 때만 적용됩니다. 로그인 후 우측 상단 사용자 메뉴의 `비밀번호 변경`에서 비밀번호를 교체할 수 있습니다.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `MNP_ADMIN_EMAIL` | `admin@mind.local` | 최초 관리자 이메일 |
| `MNP_ADMIN_PASSWORD` | 자동 임시 비밀번호 | 최초 관리자 비밀번호, 최소 8자 |
| `MNP_API_HOST` | `127.0.0.1` | API 서버 바인딩 주소 |
| `MNP_API_PORT` | `4176` | API 및 빌드된 정적 파일 제공 포트 |
| `MNP_WEB_PORT` | `4175` | 공유 URL 자동 생성에 사용할 웹 포트 |
| `MNP_PUBLIC_URL` | 로컬 IPv4 자동 감지 | 문서·카드 공유 URL의 기준 주소 |
| `MNP_DATA_DIR` | `server/data` | 문서와 운영 데이터 저장 경로 |
| `MNP_IMAGE_MAX_BYTES` | `15000000` | 이미지 파일 1개의 최대 업로드 크기(바이트) |
| `MNP_AIONUI_URL` | 자동 탐색 | AionUi 백엔드 주소 강제 지정 |
| `MNP_AIONUI_WEB_URL` | `MNP_PUBLIC_URL` 호스트의 7777 포트 | 원격 브라우저에서 AI 대화를 열 AionUi WebUI 주소 |
| `MNP_AIONUI_DISCOVERY_FILE` | OS 임시 폴더의 `aionui-backend.json` | AionUi 가변 포트 탐색 파일 |
| `MNP_WORKSPACE_POOL_REGISTRY` | 저장소의 `workspaces.json` | Unity integration·worker 작업공간 풀 구성 파일 |
| `MNP_AI_DELEGATION_POLL_INTERVAL_MS` | `3000` | 하위 AI 턴과 상위 대화 재개 상태 확인 간격. 최소 100ms |
| `MNP_AI_ATTRIBUTION_DURATION_MS` | 8시간 | AI 종류·모델 작성자 귀속 정보의 유지 시간(ms) |
| `MNP_DOORAY_API_KEY` | Suite 설치본은 DPAPI 키를 시작 시 전달, 그 외 환경은 Claude 설정에서 조회 | Dooray API 키 환경변수 우선 지정 |
| `MNP_DOORAY_BASE_URL` | Dooray MCP 설정 또는 `https://api.dooray.com` | Dooray API 기준 주소 |
| `MNP_DOORAY_CONFIG_FILE` | 사용자 홈의 `.claude.json` | Dooray MCP 설정을 읽을 Claude 설정 파일 |
| `MNP_DOORAY_MCP_SERVER_NAME` | `docker-dooray-mcp` | Claude 설정에서 조회할 Dooray MCP 서버 이름 |
| `MNP_API_URL` | `http://127.0.0.1:4176` | MCP가 호출할 MindNProgress API 주소 |
| `MNP_TOKEN_FILE` | 데이터 폴더의 `_integration-token` | MCP 인증 토큰 파일 경로 |
| `MNP_MCP_USAGE_DIR` | 데이터 폴더의 `_mcp-tool-usage` | MCP 도구 호출 계측 파일 저장 경로 |
| `MNP_MCP_USAGE_DISABLED` | 없음 | `1`이면 MCP 도구 호출 계측을 끔 |
| `MNP_MCP_USAGE_FLUSH_MS` | `2000` | 계측 파일 쓰기 최소 간격(ms) |

저장소에서 `npm run dev`, `npm run dev:server` 또는 `npm start`로 실행할 때는 Git에서 제외되는 루트 `.env.local`에 PC별 값을 둘 수 있습니다. 테스트가 서버 엔트리를 직접 실행할 때는 이 파일을 읽지 않으므로 개인 작업공간과 격리됩니다. 이미 OS나 실행 배치에서 지정한 환경변수가 있으면 그 값이 우선합니다. 설치본의 Dev 배치는 작업공간 구성 경로를 직접 전달하므로 `.env.local`이 없어도 됩니다.

카드의 `taskUrl`은 Dooray를 포함한 범용 업무 링크로 유지합니다. 일반 카드에 Dooray 업무 URL을 설정하면 카드 형태와 업무 문맥은 그대로 유지하고 제목 왼쪽에 Dooray 아이콘, 오른쪽에 원본 열기 아이콘을 표시합니다. 다른 웹 URL이면 일반 카드 표현을 그대로 유지합니다. 마인드맵 캔버스에 Dooray 업무 URL을 직접 붙여넣으면 MNP 서버가 업무 제목과 상태를 조회해 크기 조절 가능한 전용 Dooray 지식 카드로 추가합니다. 전용 카드의 Dooray 제목과 원본 정보는 저장된 값을 즉시 표시하며 제목은 편집할 수 없습니다. 원본 URL은 변경할 수 있고, 새 URL 확인에 성공하면 URL·제목·상태를 한 번에 교체합니다. 편집자가 문서를 열거나 카드 상세 보기를 열면 원본을 비동기로 다시 조회하고, 실제 변경이 있을 때만 저장 값을 갱신합니다. 조회에 실패하면 기존 저장 값을 유지합니다. 사용자는 AI가 지식으로 활용할 보충 설명을 입력하고 주요·보조 지식선으로 일반 카드에 연결합니다. 서버는 `MNP_DOORAY_API_KEY` 또는 `DOORAY_API_KEY`를 우선 사용하고, 값이 없으면 `MNP_DOORAY_CONFIG_FILE`의 `mcpServers.{MNP_DOORAY_MCP_SERVER_NAME}.env.DOORAY_API_KEY`를 읽습니다. Suite 설치본에서 Dooray MCP를 선택하면 Dev 런처가 사용자별 DPAPI 파일을 복호화해 `MNP_DOORAY_API_KEY`로 MnP 프로세스에 전달하므로 별도 평문 설정이 필요하지 않습니다. API 키는 브라우저, 문서 데이터와 API 응답에 포함되지 않습니다. 사용자 홈의 `.claude.json`은 저장소 밖에 있으므로 Git 커밋이나 MindNProgress 백업에 포함되지 않습니다.

## 접속과 공유 경로

- 로그인: `http://127.0.0.1:4175/`
- 권장 공유 화면: `/{탭}/{문서 ID}/{노드 ID}`
- 이전 주소 호환: `/viewer/{탭}/{문서 ID}/{노드 ID}`

탭에는 `mindmap`, `kanban`, `timeline`, `dashboard` 또는 `마인드맵`, `칸반`, `타임라인`, `대시보드`를 사용할 수 있습니다. `viewer`가 없는 권장 주소와 이전 호환 주소 모두 로그인 세션이 있으면 해당 계정 권한으로 동작하고, 로그인하지 않은 경우 공개 읽기 전용 계정으로 연결합니다. `/viewer`만 입력하면 마인드맵 공유 화면으로 연결됩니다.

공유 주소의 노드가 존재하면 해당 노드를 선택하고, 칸반·타임라인·대시보드에서는 `업무 관리`가 활성화된 노드만 선택합니다. 노드가 없거나 해당 탭에서 표시할 수 없으면 문서만 연 상태로 진입합니다. 문서가 없으면 지정한 탭을 유지하면서 첫 번째 문서로 진입합니다. 공개 뷰어는 문서와 댓글을 읽고 업무 링크를 열 수 있지만 댓글 작성·반응과 문서 변경은 할 수 없습니다.

주소 복사와 AI가 기록하는 접근 URL에는 `MNP_PUBLIC_URL`이 우선 적용됩니다. 자동 감지 주소가 실제 접근 주소와 다르면 이 값을 명시하세요.

상단 `공유` 버튼은 향후 문서별 공유 옵션을 제공하기 위한 자리이며, 현재는 준비 중 안내만 표시합니다. 실제 공유는 위 경로를 직접 사용하거나 카드 세부 정보의 링크 복사 버튼을 이용합니다.

## AionUi 연동

MindNProgress는 AionUi가 OS 임시 디렉터리에 게시하는 `aionui-backend.json`을 요청할 때마다 읽어 실행 중인 백엔드 포트를 찾습니다. 탐색 파일을 사용할 수 없으면 `127.0.0.1:1986`, `127.0.0.1:5830` 순서로 호환 연결을 시도합니다. 고정 주소를 사용한다면 `MNP_AIONUI_URL`로 지정할 수 있습니다.

다른 PC의 브라우저에서 `AI 대화 열기`를 누르면 AionUi WebUI의 `/#/conversation/{대화 ID}`를 매번 새 탭으로 엽니다. 닫힌 탭의 이름을 브라우저가 보존해 다음 실행이 무반응이 되는 상황을 피하기 위한 동작입니다. 기본 WebUI 주소는 `MNP_PUBLIC_URL`과 같은 호스트의 7777 포트이며, 주소나 포트가 다르면 `MNP_AIONUI_WEB_URL`을 지정합니다. `localhost` 또는 `127.0.0.1`로 접속한 브라우저는 기존 AionUi 데스크톱 딥링크를 사용하지만, `MNP_AIONUI_WEB_URL`을 명시하면 WebUI 열기가 우선됩니다.

`AI 대화 시작`의 작업공간은 새 PC·문서에서 현재 실행 중인 MindNProgress 저장소 경로를 동적으로 기본값으로 사용하며, 하드코딩된 PC 경로를 사용하지 않습니다. 이후에는 로그인 계정과 문서별 마지막 입력값을 유지합니다. 실제 대화를 시작한 작업공간은 로그인 계정의 서버 이력에 최대 10개까지 저장되어 PC와 4175 웹에서 같은 계정으로 접속하면 함께 표시되며, 각 항목의 `×` 버튼으로 양쪽 이력에서 제거할 수 있습니다. 기존 브라우저 이력은 처음 열 때 현재 로그인 계정의 서버 이력과 한 번 병합됩니다.

상위 카드의 AI는 하위 카드에 연결된 대화 후보의 AI·모델·사고 강도·MCP·스킬·작업공간·최근 활동과 실행 상태를 비교하고, 필요한 후보의 전문만 확인해 기존 대화를 이어가거나 새 대화를 선택할 수 있습니다. 위임할 때는 일반적인 작업 제안이 아니라 실행할 지시와 완료 조건을 전달합니다. `MNP_WORKSPACE_POOL_REGISTRY`에 등록된 Unity 프로젝트는 MindNProgress가 `main`의 현재 HEAD를 기준으로 유휴 worker와 작업 브랜치를 lease하고, 기존 대화도 AionCore를 통해 새 CWD로 재바인딩하므로 독립 하위 작업을 병렬로 실행할 수 있습니다. 가용 worker가 없으면 위임은 `_ai-delegations.json`에 `waiting-workspace`로 보존되고, worker가 회수된 후 FIFO로 자동 시작됩니다. 등록된 pool 작업은 lease 없이 임시 폴더 대화로 우회하지 않습니다. 완료된 worker 변경은 AI가 제출한 실제 변경의 제목·배경·원인·수정 내용을 `[김용민]` 커밋 형식으로 고정한 뒤 worker의 최신 `main` 기반 통합 브랜치에서 먼저 적용하고, 충돌이 없을 때만 실제 `main`을 fast-forward합니다. 충돌이 발생하면 `main`을 건드리지 않고 해당 작업을 수행한 같은 AI 대화를 같은 worker에서 재개해 충돌 해결과 검증을 수행하며, 통합이 성공한 뒤에만 상위 AI를 재개합니다. 다른 완료 작업은 통합 잠금이 풀릴 때까지 대기하지만 구현 작업은 계속 병렬로 진행할 수 있습니다. 중단·불명확한 변경·반복해서 해결하지 못한 충돌은 자동 삭제하지 않고 격리하지만, 변경·체크포인트·통합 진행이 전혀 없는 시작 실패는 worker를 안전하게 자동 회수합니다. pool 미등록 프로젝트에만 기존 작업공간 방식을 사용합니다. 서버는 하위 대화의 해당 `turnId`가 완료되거나 실패할 때까지 문서 JSON 밖의 `_ai-delegations.json`에서 상태를 추적하고, 상위 대화가 유휴 상태가 되면 하위 AI의 마지막 응답과 카드 재확인 지침을 보내 상위 AI를 자동 재개합니다. 여러 하위 결과가 동시에 끝나면 같은 상위 대화에 한 번에 하나씩 전달해 턴 충돌을 막습니다. 새 대화를 만들 때만 대상 카드의 AI 대화 목록 연결로 문서 버전이 증가하며, 위임 상태와 작업공간 lease 자체는 문서 버전과 변경 이력을 변경하지 않습니다.

AionUi에 다음 로컬 MCP 서버를 등록하고 활성화합니다.

```text
이름: MindNProgress
전송 방식: stdio
명령: node
인수: <MindNProgress 저장소 경로>\mcp\server.mjs
```

`<MindNProgress 저장소 경로>`는 현재 PC에 복제한 저장소의 실제 절대 경로로 바꿉니다.

Windows Git 일괄 설치본은 AionUi Dev 최초 실행 bootstrap에서 이 항목을 자동 등록하고 활성화하므로 수동 등록이 필요하지 않습니다. 다른 방식으로 직접 실행하는 환경에서는 위 값을 수동으로 등록합니다.

MCP는 데이터 폴더의 `_integration-token`을 사용해 로컬 API와 통신합니다. 이 토큰은 자동 생성되며 Git에 포함되지 않습니다. 비밀번호 변경 MCP 도구는 제공하지 않습니다.

AI가 MindNProgress 밖에서 시작되었다면 먼저 `mindnprogress_read_me_first`를 호출해 제품 개념과 작업 규칙을 확인할 수 있습니다. 카드에서 시작된 대화는 `mindnprogress_get_context`로 최신 문서 구조, 선택 카드, 접근 URL과 업무 링크를 함께 조회합니다. 기본 `focused` 모드는 선택 카드와 주요 선행 지식 원문 및 문서 개요를 반환하고, 전체 원문이 필요한 경우 `detailLevel=full`을 사용할 수 있습니다. 간략 응답에서 특정 카드 원문이 더 필요하면 `mindnprogress_get_card`, 오래된 댓글까지 필요하면 페이지 방식의 `mindnprogress_list_comments`를 사용합니다. 댓글 조회는 기본적으로 요약과 상세 존재 여부를 반환하며, 작업 근거나 검증 내용이 더 필요할 때 `includeDetail=true`를 사용합니다. 여러 카드로 구성된 새 문서는 `mindnprogress_create_mindmap`으로 한 번에 생성하는 것이 권장됩니다. 외부 전달물이나 결정 때문에 업무가 멈춘 경우 제목을 변경하지 않고 카드의 `waitingItems`에 자유 입력 항목을 추가하며, 대기 등록과 해제는 각각 `[차단]`, `[진행]` 댓글로 기록합니다.

## MindNProgress MCP 명령어

현재 MCP 서버는 49개 도구를 제공합니다. 카드가 선택된 작업은 먼저 `mindnprogress_get_context`로 최신 버전과 제품 규칙을 확인하고, 변경 후에는 `mindnprogress_get_document`로 실제 저장 결과를 다시 확인하는 흐름을 권장합니다. 조회 도구는 문서 버전을 변경하지 않으며 카드·관계 편집과 AI 대화 ID 연결 같은 저장 작업만 버전을 증가시킵니다. 선택 카드 이외의 형제·하위·선행 카드를 함께 수정할 때는 `mindnprogress_get_ai_work_states`로 다른 AI가 작업 중인지 먼저 확인합니다. 등록된 AI 작업공간의 최신 목록과 상태는 폴더명을 추측하지 않고 `mindnprogress_get_ai_workspace_pool`로 조회합니다.

### 시작과 조회

| 명령어 | 설명 |
| --- | --- |
| `mindnprogress_read_me_first` | 문서 선택 없이 제품 개념, 작성 규칙과 권장 작업 순서를 조회합니다. |
| `mindnprogress_list_documents` | 활성 문서 목록, 버전, 완료 현황과 문서 그룹·혼합 순서를 조회합니다. |
| `mindnprogress_get_context` | 선택 카드와 문서 구조, 관계, 댓글, 담당자, 업무 링크 및 선행 지식을 작업 문맥으로 조회합니다. `detailLevel`은 `focused` 또는 `full`을 사용합니다. |
| `mindnprogress_get_document` | 문서의 모든 카드와 연결 관계 및 외부 접근 URL을 조회합니다. |
| `mindnprogress_get_card` | 특정 카드의 설명, 공유 지식, 업무 필드와 댓글을 페이지 단위로 조회합니다. |
| `mindnprogress_list_shared_knowledge_candidates` | 정리가 필요한 공유 지식 후보의 우선순위·길이·SHA-256·검토 상태를 원문 없이 페이지 단위로 조회합니다. |
| `mindnprogress_get_shared_knowledge_review_context` | 후보 한 카드의 공유 지식 원문과 관계·최근 댓글·검토 기준을 조회합니다. |
| `mindnprogress_get_ai_work_states` | 지정한 카드 또는 문서 전체에서 연결된 AI 대화의 현재 작업·승인 대기·유휴·확인 불가 상태를 조회합니다. 문서 버전은 변경하지 않습니다. |
| `mindnprogress_get_ai_workspace_pool` | MindNProgress가 관리하는 AI 작업공간의 역할·경로·Unity 인스턴스 해시와 현재 상태를 조회합니다. 다른 대화의 lease·job 식별자는 노출하지 않습니다. |
| `mindnprogress_checkpoint_ai_workspace` | worker의 실제 변경 경로와 `summary`·`background`·`cause`·`changes`(선택 `scope`)를 받아 출처가 명확한 `[김용민]` 커밋으로 고정합니다. 구조화 커밋 메시지를 생략할 수 없습니다. |
| `mindnprogress_confirm_ai_workspace_no_changes` | 조사·검증 결과 의도한 파일 변경이 전혀 없음을 확인합니다. 변경 체크포인트의 빈 경로 호환 입력 대신 이 도구를 사용합니다. |
| `mindnprogress_list_ai_conversations` | 카드에 연결된 모든 AI 대화 후보의 실행 환경, 시작 정보, 최근 활동과 실시간 상태를 조회해 기존 대화 이어가기와 새 대화 시작 판단에 사용합니다. |
| `mindnprogress_delegate_ai_work` | 대화 시작 카드의 모든 깊이 하위 카드에 실행 가능한 지시를 전달해 기존 대화를 이어가거나 새 대화를 만들고, 해당 턴 완료 후 결과와 함께 상위 대화를 자동 재개합니다. 다른 카드 조회는 위임 기준을 바꾸지 않습니다. |
| `mindnprogress_complete_ai_delegation` | 사용자가 중지한 하위 위임을 같은 대화에서 직접 이어 실제 작업을 완료했을 때, 카드 기록과 작업공간 체크포인트 이후 마지막 턴에 명시적 완료 신호를 보냅니다. 단순 질의 응답과 중간 보고에는 사용하지 않습니다. |
| `mindnprogress_list_ai_delegations` | 하위 실행부터 상위 대화 재개까지 AI 작업 위임의 현재 상태, 대상 대화와 turnId를 조회합니다. 구버전 실행 기록의 자원 대기(`waiting-resource`) 상태도 호환 조회합니다. |
| `mindnprogress_recover_ai_delegation` | AionCore 재시작으로 복구가 필요해진 위임을 원 지시 자동 재생 없이 기존 대화·작업공간에서 명시적으로 이어갑니다. |
| `mindnprogress_get_ai_conversation_transcript` | 카드에 연결된 최근 AionUi 대화 또는 `conversationId`로 지정한 이전 대화 전문을 `전체 복사`와 같은 텍스트 형식으로 조회합니다. |
| `mindnprogress_list_users` | 담당자로 지정할 수 있는 편집자 계정 목록을 조회합니다. |

변경 체크포인트의 `commitMessage.summary`에는 `[김용민]`이나 `[MnP]` 출처를 넣지 않습니다. 서버가 제목 prefix와 `[MnP]`·`[배경]`·`[원인]`·`[수정]`·선택적 `[적용 범위]` 섹션을 생성하며 `Co-Authored-By`는 거부합니다. `[MnP]`에는 체크포인트 시점의 문서·카드 제목, 안정적인 `mapId`·`cardId`와 호스트에 의존하지 않는 상대 경로가 기록됩니다. 파일 변경이 없으면 변경 도구에 빈 `paths`를 보내지 않고 `mindnprogress_confirm_ai_workspace_no_changes`를 호출합니다.

### 문서와 카드 편집

| 명령어 | 설명 |
| --- | --- |
| `mindnprogress_create_mindmap` | 여러 카드로 구성된 새 문서와 계층 구조를 한 번에 생성하고 자동 배치합니다. |
| `mindnprogress_create_document` | Root 카드 하나만 포함한 빈 문서를 생성합니다. |
| `mindnprogress_save_document` | 기준 버전을 확인하면서 문서의 전체 카드와 연결 관계를 저장합니다. |
| `mindnprogress_add_card` | 새 카드 또는 지정한 상위 카드의 하위 카드를 추가합니다. 기본 `responseMode=affected`는 추가한 카드와 문서·Root 요약만, `full`은 변경 전과 같은 API 원본 전체 문서를 반환합니다. |
| `mindnprogress_update_card` | 전달한 필드만 부분 병합하여 카드 제목, 설명, 공유 지식, 상태, 진행률과 업무 관리 필드를 수정합니다. 일반 카드에서 생략한 필드와 위치는 보존됩니다. 기본 `responseMode=full`은 저활용 필드를 제외한 최신 전체 문서를, `affected`는 직접·간접 변경 카드와 문서·Root 요약을 반환합니다. |
| `mindnprogress_patch_card_text` | 조회한 SHA-256이 유지된 경우에만 설명 또는 공유 지식의 유일 문자열·경계 내부를 교체하거나 뒤에 추가합니다. 장문 필드 전체를 다시 생성하지 않습니다. |
| `mindnprogress_apply_shared_knowledge_review` | 문서 버전과 카드별 SHA-256이 모두 일치할 때만 최대 20개 카드의 정리 결과와 검토 기록을 한 번에 저장합니다. |
| `mindnprogress_move_card` | 카드와 전체 하위 구조를 다른 카드 아래로 이동합니다. 기본 `responseMode=affected`는 이동한 카드와 이전·새 상위 관계만, `full`은 변경 전과 같은 API 원본 전체 문서를 반환합니다. |
| `mindnprogress_delete_card` | 카드와 선택적으로 전체 하위 카드를 삭제합니다. Root 카드는 삭제할 수 없습니다. 기본 `responseMode=affected`는 삭제한 카드 ID와 끊어진 계층·지식선 관계 및 함께 조정된 카드만, `full`은 변경 전과 같은 API 원본 전체 문서를 반환합니다. |
| `mindnprogress_add_knowledge_line` | 두 카드 사이에 지식선을 추가합니다. 중복과 순환 관계를 거부합니다. |
| `mindnprogress_update_knowledge_line` | 지식선 정책을 `reuse-first` 또는 `inspect-if-insufficient`로 변경합니다. |
| `mindnprogress_delete_knowledge_line` | 두 카드 사이의 지식선만 삭제합니다. |
| `mindnprogress_update_document_info` | 문서 이름 또는 아이콘 색상을 변경합니다. |

처음부터 여러 카드가 필요한 경우 `mindnprogress_create_document`와 `mindnprogress_save_document`를 연속 호출하지 말고 `mindnprogress_create_mindmap`을 사용합니다. 지식선만 바꿀 때는 전체 카드와 장문 본문을 다시 전달하는 `mindnprogress_save_document` 대신 지식선 전용 도구를 사용합니다. 전용 도구는 최신 문서를 내부에서 조회해 관계 변경만 재적용하고 일시적인 버전 충돌을 최대 3회까지 다시 시도합니다. 전체 저장과 문서 정보 변경은 최신 `baseVersion`을 사용하며, 버전 충돌이 발생하면 문서를 다시 조회해야 합니다.

MCP 도구에서 카드를 지정할 때는 `cardId`를 사용합니다. 상위 카드는 `parentCardId`, 이동할 새 상위 카드는 `newParentCardId`, 답글의 상위 댓글은 `parentCommentId`로 지정합니다. 기존 `nodeId`, `parentId`, `newParentId`는 이미 시작된 AI 대화와의 호환을 위해 한시적으로 허용되지만 새 호출에서는 사용하지 않습니다. 선호 필드와 호환 필드를 동시에 서로 다른 값으로 전달하면 안전을 위해 요청이 거부됩니다. 원시 문서의 `nodes`, 댓글 저장 데이터의 `nodeId` 등 내부 저장 구조는 기존 문서 및 백업 호환을 위해 유지됩니다.

단일 카드의 일부 필드만 변경할 때는 `mindnprogress_update_card`의 `data`에 변경할 필드만 전달합니다. 현재 카드 전체 데이터를 재전송하면 조회 이후 다른 편집자가 변경한 값을 오래된 값으로 덮어쓸 수 있습니다. 일반 카드에서 생략한 필드와 `position`은 보존되고, 빈 문자열이나 빈 배열을 명시하면 해당 필드가 초기화됩니다. 단, `status=done` 또는 `progress>=100`을 적용하면 `waitingItems`는 전달 여부와 관계없이 자동으로 해제되며 Ref 카드는 원본이 관리하는 제목·설명·공유 지식·업무 필드 등이 최신 원본 값으로 동기화될 수 있습니다. `responseMode`를 생략하면 `full`이며 저장 직후 모든 카드의 본문·위치와 계층선·지식선을 반환합니다. 응답 크기를 줄이기 위해 카드의 AI 대화 상세 목록은 최근 대화 ID와 개수로 축약하고, 카드 타입 고정값과 연결선 렌더링 전용 값은 제외합니다. 단일 카드 수정 결과만 필요하면 `responseMode=affected`를 사용하며, 이때 `affectedCards`에는 직접 수정 카드와 Root 진행률 재계산 등 서버가 함께 조정한 카드가 포함됩니다.

`mindnprogress_add_card`, `mindnprogress_move_card`, `mindnprogress_delete_card`는 `responseMode`를 생략하면 `affected`입니다. 카드 하나를 추가·이동·삭제하는 호출에 문서 전체를 실어 보내면 응답이 문서 크기에 비례해 커지므로 기본값을 변경 결과로 두었습니다. `add_card`는 추가한 카드와 `parentCardId`, `move_card`는 이동한 카드와 `hierarchy`의 이전·새 상위 카드, `delete_card`는 `deletedCardIds`와 `relationChanges`를 돌려줍니다. `relationChanges`에는 삭제 전 상위 카드, 하위 카드를 함께 삭제하지 않아 연결이 끊어진 카드 ID, 삭제로 제거된 지식선이 포함됩니다. 세 도구 모두 문서 요약과 Root 요약, 서버가 함께 조정한 `affectedCards`를 포함하며 `card`로 이미 돌려주는 카드는 `affectedCards`에 중복해서 담지 않습니다. 저장 직후 변경 전과 같은 API 원본 전체 구조가 필요하면 `responseMode=full`을 지정하고, 저활용 필드를 제외한 최신 문서를 다시 조회하려면 `mindnprogress_get_document`를 호출합니다.

전체 활성 문서의 공유 지식 현황은 인증된 `GET /api/shared-knowledge/audit`로 조회합니다. `mapId` 쿼리를 지정하면 한 문서만 검사하며, 응답에는 원문 대신 길이·UTF-8 바이트·SHA-256·문단과 목록 수·정확히 반복된 문장 수·10,000자 한도 사용률·지식선 소비 카드 수가 포함됩니다. 3,000자는 관심, 5,000자는 정리 권장, 8,000자는 우선 정리 기준이며 Ref 카드는 원본 카드에서만 정리하도록 직접 처리 후보에서 제외됩니다.

공유 지식 검토 기록은 서버가 검토 시각·검토자·본문 SHA-256·결과(`cleaned` 또는 `accepted-long`)를 소유하는 메타데이터입니다. 현재 본문 해시와 일치하는 검토 완료 카드는 현황에 표시하되 정리 후보에서 제외하고, 이후 본문이 달라지면 기존 기록을 보존한 채 `stale`로 분류해 다시 후보에 포함합니다. 일반 문서 저장 요청은 이 기록을 새로 만들거나 덮어쓸 수 없습니다.

AI 정리는 `mindnprogress_list_shared_knowledge_candidates`로 원문 없는 후보를 고른 뒤, 필요한 카드만 `mindnprogress_get_shared_knowledge_review_context`로 확인합니다. 실제로 본문을 정리한 카드는 `cleaned`와 정리된 `replacement`를 보내고, 길지만 현재 내용 전체가 계속 필요하다고 판단한 경우에만 `accepted-long`을 사용합니다. 적용 요청은 문서 버전과 모든 대상 카드의 SHA-256을 먼저 검증하고 하나라도 달라졌으면 아무 카드도 저장하지 않습니다. 정리 결과가 빈 문자열이면 공유 지식과 검토 기록을 모두 제거하여 이후 후보에서 제외합니다.

공유 지식에는 다른 카드나 후속 세션이 재사용할 현재 유효한 사실·결정·제약·검증 결과와 적용 조건, 원문 출처만 남깁니다. 시간순 진행 기록, 도구 호출과 원문 로그, 설명·댓글의 단순 복사, 중복, 폐기된 결론은 제외하고 과정은 댓글에 기록합니다. 새 재사용 정보나 기존 결론의 변경이 없으면 수정하지 않으며, 같은 주제의 결론이 바뀌면 새 이력 절을 계속 덧붙이지 않고 SHA-256 조건부 부분 수정으로 기존 절만 교체합니다.

정리 후보가 있을 때는 주 1회, 그리고 주요 마일스톤 완료 후나 다른 사람·AI에게 인수인계하기 전에 현황을 점검합니다. 후보는 8,000자 이상 우선 정리, 5,000자 이상 정리 권장, 3,000자 이상 또는 정확 중복이 있는 관심 단계 순으로 검토합니다. 후보가 없으면 정리를 생략하고, 어떤 경우에도 자동 삭제·자동 축약하지 않으며 전용 문맥을 확인한 카드만 명시적으로 승인합니다. `accepted-long`은 장문 전체가 현재도 재사용에 필요하다는 예외 판단일 때만 사용하며, 본문이 바뀌지 않아도 승인 30일 후 다시 후보로 분류합니다.

### 문서 목록과 그룹

| 명령어 | 설명 |
| --- | --- |
| `mindnprogress_reorder_documents` | 좌측 문서 목록의 순서를 변경합니다. |
| `mindnprogress_save_document_layout` | 그룹, 그룹 내부 문서 순서와 그룹·개별 문서가 섞인 최상위 순서를 저장합니다. |

그룹이나 혼합 순서를 변경할 때는 먼저 `mindnprogress_list_documents`의 `documentLayout`을 확인하고 모든 활성 문서를 정확히 한 번 포함해야 합니다.

### 휴지통

| 명령어 | 설명 |
| --- | --- |
| `mindnprogress_move_document_to_trash` | 문서를 휴지통으로 이동합니다. |
| `mindnprogress_list_trash` | 휴지통 문서 목록을 조회합니다. |
| `mindnprogress_restore_document` | 휴지통의 문서를 활성 문서로 복원합니다. |
| `mindnprogress_delete_trashed_documents` | 휴지통에서 선택한 문서를 영구 삭제합니다. |
| `mindnprogress_empty_trash` | 휴지통의 모든 문서를 영구 삭제합니다. |

영구 삭제는 문서, 댓글과 변경 이력을 함께 제거하며 복구할 수 없습니다. `mindnprogress_delete_trashed_documents`와 `mindnprogress_empty_trash`는 `confirmPermanentDeletion=true`를 명시해야 합니다.

### 변경 이력

| 명령어 | 설명 |
| --- | --- |
| `mindnprogress_list_history` | 문서 변경 이력을 최신순으로 페이지 조회합니다. |
| `mindnprogress_restore_history` | 선택한 변경 이력 시점으로 문서를 복원합니다. |

`mindnprogress_list_history` 응답에 `nextOffset`이 있으면 다음 호출의 `offset`으로 전달해 계속 조회합니다.

### 댓글

| 명령어 | 설명 |
| --- | --- |
| `mindnprogress_list_comments` | 문서 전체 또는 특정 카드의 댓글과 답글을 페이지 조회합니다. `includeDetail=true`이면 상세 본문을 포함합니다. |
| `mindnprogress_add_comment` | 카드에 짧은 `summary`와 선택적 `detail`로 새 댓글 또는 답글을 작성합니다. |
| `mindnprogress_update_comment` | 기존 댓글이나 답글의 요약과 상세를 수정하고 기존 단일 본문 댓글을 새 형식으로 전환할 수 있습니다. `expectedText`를 보내면 조회 이후 원문이 달라졌을 때 수정을 거부합니다. |
| `mindnprogress_delete_comment` | 댓글과 연결된 답글을 삭제합니다. |
| `mindnprogress_set_comment_resolved` | 댓글 스레드를 해결하거나 다시 엽니다. |
| `mindnprogress_toggle_comment_reaction` | 댓글의 `👍`, `❤️`, `🎉`, `👀` 반응을 추가하거나 취소합니다. |

`mindnprogress_list_comments` 응답에 `nextOffset`이 있으면 다음 호출의 `offset`으로 전달합니다. AI 댓글의 `summary`는 의미 있는 진행, 차단과 완료 결과에 따라 `[진행]`, `[차단]`, `[결과]` 머리말로 시작하는 1~2문장으로 작성합니다. `detail`에는 다른 세션이 작업을 이어가거나 검증하는 데 필요한 수행 내용, 판단, 변경 범위, 검증 방법과 실제 결과, 산출물, 제한사항과 다음 단계 중 해당 내용을 충실하게 기록합니다. 요약 때문에 상세를 축약하지 않으며 개별 도구 호출과 의미 없는 반복만 제외합니다.

새 형식 댓글에는 `contentFormat=summary-detail`이 저장됩니다. 이 값이 없는 기존 단일 본문 댓글은 자동으로 변경하지 않으므로, 추후 원문을 확인하며 요약과 상세로 분류하는 마이그레이션 대상을 명확하게 식별할 수 있습니다.

#### 기존 댓글 무손실 마이그레이션

기존 단일 본문 댓글은 상세함이 낮아지지 않도록 원문 전체를 `detail`에 문자 단위로 보존하고, 원문과 카드의 시간순 문맥을 확인해 `summary`만 새로 작성하는 방식을 사용합니다. 진행 상태는 Git에서 제외되는 `server/data/_migrations/comment-summary-detail-v1.json`에 저장되며 전체 데이터 백업에 포함됩니다.

```bash
npm run comments:migration -- snapshot
npm run comments:migration -- status
npm run comments:migration -- list --status pending --limit 10
npm run comments:migration -- stage --input <요약 초안 JSON>
npm run comments:migration -- review --input <독립 검토 JSON>
npm run comments:migration -- apply --confirm --limit 10
npm run comments:migration -- verify
```

`stage` 입력은 `{ "commentId": "...", "summary": "[결과] ..." }` 항목의 배열이고, `review` 입력은 `{ "commentId": "...", "approved": true }` 항목의 배열입니다. 적용은 별도 검토에서 승인된 항목만 대상으로 하며 다음 조건을 모두 확인합니다.

- 초안의 `detail`과 스냅샷 원문 및 SHA-256이 일치
- 적용 직전 서버 댓글의 `text`와 `expectedText`가 일치
- 적용 후 ID, 작성자, 작성 시각, 답글 관계, 해결 상태와 반응이 유지
- 저장된 `summary`, `text`, `detail`과 `contentFormat`이 승인된 값과 일치

원문이나 메타데이터가 달라지면 해당 항목을 `needs-review`로 바꾸고 즉시 중지하므로, 다른 세션의 댓글 변경을 덮어쓰지 않습니다. 여러 세션에서 작업할 때는 같은 카드의 댓글을 시간순으로 확인하여 한 번에 3~8개씩 초안을 만들고, 다른 세션에서 검토한 뒤 적용하는 방식을 권장합니다.

### 알림

| 명령어 | 설명 |
| --- | --- |
| `mindnprogress_list_notifications` | 현재 AI 편집자의 알림을 조회합니다. |
| `mindnprogress_mark_notification_read` | 지정한 알림을 읽음으로 표시합니다. |
| `mindnprogress_mark_all_notifications_read` | 모든 알림을 읽음으로 표시합니다. |

## 주요 조작

| 입력 | 동작 |
| --- | --- |
| `Insert` | 선택 노드에 하위 노드 추가 |
| `Home` | 전체 노드가 보이도록 화면 맞춤 |
| `Ctrl+Z` | 실행 취소 |
| `Ctrl+Y` | 다시 실행 |
| 노드 드래그 | 노드와 하위 트리 이동 |
| 노드를 다른 노드에 드롭 | 대상 노드의 자식으로 이동 |
| 캔버스 우클릭 드래그 | 캔버스 이동 |
| 노드 우클릭 클릭 | AI 대화 시작·열기, 복사·자식으로 붙여넣기·삭제 메뉴 |
| `Ctrl`+노드 클릭 | 여러 노드 선택 |
| 여러 노드 선택 후 복사 | 선택 노드와 내부 계층선·지식선·상대 위치 복사 |
| 다른 문서에서 붙여넣기 | 독립 Clone 또는 원본 Ref 선택 |
| `Alt`+노드 드래그 | 노드 또는 선택한 전체 노드를 눈금에 맞춰 이동 |
| 이미지 더블클릭 또는 확대 버튼 | 화면 맞춤·100%·확대·축소·드래그 이동을 지원하는 원본 미리보기 |
| 제목·업무 링크에서 `Enter` | 입력을 완료하고 저장 |
| 노드 대기 말풍선 클릭 | 세부정보를 열고 대기 항목으로 이동 |
| 대시보드 지표 카드 클릭 | 해당 업무 목록 표시 또는 선택 해제 |
| 문서·그룹 드래그 | 그룹 내부와 최상위 혼합 순서 변경 |
| 좌우 패널 경계 드래그 | 문서 목록 또는 세부정보 패널 너비 조절 |
| 패널 경계 선택 후 방향키 | 패널 너비를 단계별로 조절 |

## 개발 명령

```bash
npm run dev          # 화면과 API 개발 서버 동시 실행
npm run dev:client   # Vite 화면만 실행
npm run dev:server   # API 서버만 watch 모드로 실행
npm run build        # TypeScript 검사와 배포 빌드
npm run lint         # oxlint 정적 검사
npm run test:unit    # Node 20·22 호환 단위 테스트
npm run test:mcp     # 격리된 임시 API를 이용한 전체 MCP 회귀 검사
npm run mcp          # MCP stdio 서버 직접 실행
npm run usage:mcp    # MCP 도구 호출 빈도와 응답 비용 집계 출력
npm run comments:migration -- <명령> # 댓글 요약·상세 마이그레이션 관리
npm start            # 빌드 결과와 API 서버 실행
```

`test:unit`은 3방향 병합, 진행률 롤업, 대기 해제와 AI 작성자 귀속 같은 순수 로직을 검사합니다. `test:mcp`는 운영 데이터와 분리된 임시 API 서버에서 모든 등록 도구의 성공 경로와 버전 충돌, 순환 이동, 루트 삭제, 영구 삭제 확인 등의 안전 경계를 검사합니다. 테스트 데이터는 종료 시 제거됩니다.

### MCP 도구 호출 계측

MCP 서버는 `registerTool` 래퍼 한 곳에서 도구별 호출 횟수, 성공·실패, 마지막 호출 시각과 응답 문자 수를 기록합니다. 인자 값과 카드 본문은 기록하지 않습니다. MCP는 stdio 전송이라 AI 클라이언트 연결마다 별도 프로세스가 뜨므로, 프로세스마다 `_mcp-tool-usage/<pid>-<난수>.json` shard 파일 하나만 임시 파일 후 rename 방식으로 덮어쓰고 합산은 읽는 쪽에서 합니다. 이전 프로세스의 shard가 남아 재시작 후에도 누적값이 유지됩니다.

```bash
npm run usage:mcp           # 표로 출력
npm run usage:mcp -- --json # 집계 JSON 출력
```

출력은 호출이 많은 도구 순 표, 응답 비용(호출 횟수 x 응답 크기) 상위 목록, 한 번도 호출되지 않은 도구 목록으로 구성됩니다. 각각 응답을 줄일 도구와 삭제 후보를 고르는 근거로 사용합니다. 계측을 끄려면 `MNP_MCP_USAGE_DISABLED=1`을 지정합니다.

## 현재 제한사항

- 단일 Node.js 프로세스와 로컬 JSON 파일 저장을 기준으로 하며 다중 서버 운영을 지원하지 않습니다.
- 공개 뷰어 링크를 아는 사용자는 로그인 없이 문서를 읽을 수 있으므로 민감한 정보를 저장하기에 적합하지 않습니다.
- 내장 HTTPS가 없고 세밀한 조직·그룹 권한 모델은 아직 제공하지 않습니다.
- AI 대화는 로컬에서 실행 중인 AionUi와 MindNProgress MCP 설정이 필요합니다.
- 일일 백업은 문서 제목·색상·노드·연결선을 복원하며 댓글은 현재 상태를 유지합니다.
- 상단 공유 버튼의 사용자 초대·권한 설정 기능은 아직 준비 중입니다.

## 보안 주의사항

- 현재 서비스는 신뢰할 수 있는 PC와 내부망 사용을 기준으로 합니다. 인터넷에 직접 노출하지 마세요.
- 개발 서버는 화면을 모든 네트워크 인터페이스에 바인딩합니다. 같은 네트워크의 다른 기기가 접근하면 공개 뷰어를 통해 전체 문서와 댓글을 읽을 수 있습니다.
- 로그인 시도 횟수 제한과 계정 잠금이 없으므로 외부 접근이 필요하면 방화벽, 접근 제어와 HTTPS 리버스 프록시를 함께 구성하세요.
- HTTP 세션 쿠키는 `HttpOnly`와 `SameSite=Strict`를 사용하지만 `Secure` 속성은 사용하지 않습니다. 암호화되지 않은 네트워크에서 로그인하지 마세요.
- MCP 통합 토큰과 세션·계정·문서 데이터가 저장되는 `server/data`를 공유하거나 Git에 강제로 추가하지 마세요.
- 보안 취약점을 발견하면 공개 이슈에 인증정보나 운영 데이터를 올리지 말고 저장소 소유자에게 비공개로 알려주세요.

## 이미지 자산

- `public/favicon.svg`는 MindNProgress를 위해 AI로 생성한 프로젝트 자산입니다.

## 라이선스

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다.
