# MnP Suite macOS Git 설치 패키지

`Install-MnPSuite.sh`는 macOS에서 다음 작업을 한 번에 수행합니다.

1. 필수 도구와 설치 위치를 검사합니다.
2. MindNProgress, AionUi, AionCore와 선택한 Dooray/PPTX MCP 저장소를 clone 또는 재사용합니다.
3. npm·Bun·Python·Gradle 의존성을 준비하고 AionCore release 및 Dooray MCP를 빌드합니다.
4. PPTX MCP 선택 시 macOS 사용자용 한글 글꼴을 설치하고, Microsoft PowerPoint for Mac이 있으면 실제 PNG 렌더링을 검증합니다.
5. Claude Code와 Codex용 MnP Suite 스킬 및 관리 지침을 설치합니다.
6. Dev launcher와 비밀값이 없는 MCP descriptor를 생성합니다.
7. 요청하면 MindNProgress와 AionUi를 실행합니다. AionUi의 첫 bootstrap이 MCP를 DB에 등록하고 활성화합니다.

## 설치 결과

```text
<설치 루트>/
  ├─ MindNProgress/
  ├─ AionUi/
  ├─ AionCore/
  ├─ dooray-mcp-server/                 Dooray MCP 선택 시
  ├─ Office-PowerPoint-MCP-Server/      PPTX MCP 선택 시
  ├─ mcp/
  │   ├─ mnp-suite-mcp-bootstrap.json
  │   ├─ start-dooray-mcp.sh            Dooray MCP 선택 시
  │   └─ start-pptx-mcp.sh              PPTX MCP 선택 시
  ├─ dev/
  │   ├─ start-all-dev.command
  │   ├─ start-mindnprogress-dev.sh
  │   ├─ start-aionui-dev.sh
  │   ├─ stop-mindnprogress-dev.sh
  │   └─ rebuild-aioncore-release.sh
  ├─ workspace-pool/
  ├─ fonts/
  │   ├─ mnp-suite-korean-fonts.json    PPTX MCP 선택 시
  │   └─ licenses/                      직접 설치 글꼴 라이선스
  ├─ install-logs/
  │   └─ pptx-korean-font-smoke.png     PPTX MCP 선택 및 PowerPoint 설치 시
  └─ installation-manifest.json
```

AionUi와 AionCore에는 mabobsa fork가 `origin`, iOfficeAI 저장소가 `upstream`으로 설정됩니다. 모든 저장소의 기본 브랜치는 `main`입니다.

## 필수 도구

- macOS와 Xcode Command Line Tools
- Git
- Node.js 22 이상 25 미만과 npm
- Bun
- Rustup과 Cargo
- Python 3.11 이상
- Dooray MCP 선택 시 Java 21
- PPTX MCP 선택 시 fontconfig 및 한글 글꼴 8종
- PPTX MCP의 슬라이드 이미지(PNG) 내보내기에는 Microsoft PowerPoint for Mac(Microsoft 365 / Office for Mac)이 필요합니다. 설치기는 PowerPoint를 설치하지 않으며, `/Applications`나 `~/Applications`에 없으면 경고만 표시하고 설치를 계속합니다.

`--install-missing-prerequisites`를 지정하면 이미 설치된 Homebrew를 이용해 누락 항목을 준비합니다. Homebrew 자체가 없으면 [Homebrew](https://brew.sh)를 먼저 설치해야 합니다. Apple Silicon과 Intel Homebrew 경로를 모두 지원하며 keg-only인 `node@22`, `rustup`, `openjdk@21`도 launcher에 절대 경로로 기록합니다.

PPTX MCP를 선택하면 Noto Sans CJK KR, Noto Serif CJK KR, 나눔고딕, 나눔명조, 나눔스퀘어, 나눔바른고딕, 은바탕, 은돋움을 `~/Library/Fonts`에 준비합니다. Homebrew가 제공하는 글꼴은 cask로 설치하고, 나눔바른고딕과 은글꼴은 공식 배포 archive를 고정 SHA-256으로 검증한 뒤 설치합니다. 기존에 같은 font family가 있으면 유지하며, 다른 내용의 동명 사용자 폰트 파일은 자동으로 덮어쓰지 않습니다. PowerPoint도 이렇게 설치된 글꼴로 슬라이드를 그립니다. fontconfig는 설치기가 `fc-list`로 글꼴 설치 여부를 확인할 때만 쓰며, PPTX MCP launcher에는 fontconfig 설정을 기록하지 않습니다.

## ZIP 배포본에서 실행

압축을 푼 폴더의 Terminal에서 다음을 실행합니다.

```bash
chmod +x Install-MnPSuite.sh
./Install-MnPSuite.sh --install-missing-prerequisites
```

## Git 저장소에서 실행

```bash
cd installer/macos
chmod +x Install-MnPSuite.sh
./Install-MnPSuite.sh --install-missing-prerequisites
```

설치 루트, 선택 스킬, Dooray/PPTX MCP, 설치 직후 실행 여부를 순서대로 묻습니다. Dooray MCP를 선택했고 Keychain에 키가 없으면 API 키를 화면에 표시하지 않고 입력받습니다.

다섯 저장소와 두 선택 스킬을 모두 설치하고 바로 실행하는 무인 예시는 다음과 같습니다.

```bash
export DOORAY_API_KEY='설치 프로세스에만 전달할 Dooray API 키'
./Install-MnPSuite.sh \
  --non-interactive \
  --install-root "$HOME/Developer/MnPSuite" \
  --install-missing-prerequisites \
  --include-unity-work-skill \
  --include-pptx-skill \
  --include-dooray-mcp \
  --include-pptx-mcp \
  --launch
unset DOORAY_API_KEY
```

API 키를 명령행 인수로 넘기지 마세요. 설치기는 환경값을 현재 사용자의 macOS Keychain 서비스 `mnp-suite-dooray-api-key`에 저장하고, descriptor·manifest·launcher에는 키나 Keychain 값이 아닌 실행 경로만 기록합니다. 같은 macOS 사용자로 재설치할 때는 기존 Keychain 항목을 재사용할 수 있습니다.

## Claude Code·Codex 스킬

`mnp-dooray`와 `mnp-spec-driven-development`는 항상, `unity-work`와 `pptx`는 선택 시 `${CODEX_HOME:-~/.codex}/skills`와 `${CLAUDE_CONFIG_DIR:-~/.claude}/skills`에 설치합니다. 스킬은 `SKILL.md`만이 아니라 `references` 등을 포함한 디렉터리 전체를 배포 단위로 복사하고, `.mnp-suite-managed.json`에 설치한 파일과 SHA-256을 기록합니다. 재설치할 때 패키지에서 빠진 이전 설치 파일은 설치 후 수정되지 않은 경우에만 제거하며, 수정된 파일이 있으면 설치를 중단합니다. 같은 이름의 사용자 소유 스킬 폴더(표식 없음)가 있으면 덮어쓰지 않고 중단합니다.

AionUi에 Claude 계정을 2개 이상 등록해 쓰는 경우 설치기는 위 Claude 폴더 한 곳에만 설치합니다. 두 번째 계정 폴더의 지침 가져오기와 스킬 복사는 [Claude 멀티 계정](../../docs/ai-claude-accounts.md#mnp-suite-설치기와-두-번째-계정)을 따릅니다.

`pptx`는 이 폴더의 `skills/pptx`(macOS 렌더러 `powerpoint-applescript+pymupdf` 플랫폼 파생본)를, 나머지는 `../windows/skills`의 사본을 설치합니다. 이 사본들은 활성본(`~/.claude/skills`)에서 동기화한 파생본이며, 원본·파생 관계는 ai-guidance-library README의 「원본과 파생본」을 따릅니다.

## 주요 옵션

| 옵션 | 역할 |
| --- | --- |
| `--mindnprogress-branch NAME` | 설치할 MindNProgress 브랜치 선택 |
| `--aionui-branch NAME` | 설치할 AionUi 브랜치 선택 |
| `--aioncore-branch NAME` | 설치할 AionCore 브랜치 선택 |
| `--dooray-mcp-branch NAME` | 설치할 Dooray MCP 브랜치 선택 |
| `--pptx-mcp-branch NAME` | 설치할 PowerPoint MCP 브랜치 선택 |
| `--plan-only` | 파일을 변경하지 않고 선택 구성과 누락 도구만 출력 |
| `--reuse-existing-repositories` | 올바른 origin/main 저장소를 업데이트 없이 재사용 |
| `--update-existing-repositories` | 선택한 모든 저장소가 깨끗한지 먼저 확인한 후 `origin/main`으로 fast-forward |
| `--skip-dependency-install` | 이미 성공한 npm·Bun·Gradle·pip 결과를 재사용 |
| `--skip-aioncore-build` | 기존 `target/release/aioncore`를 재사용 |
| `--launch` | 설치 완료 후 MindNProgress와 AionUi를 각각 Terminal에서 실행 |

`--non-interactive`에서는 `--install-root`를 명시해야 합니다. 기존 저장소를 자동으로 덮어쓰거나 다른 브랜치로 전환하지 않으며, origin·현재 브랜치·작업 트리 조건이 맞지 않으면 중단합니다. 재설치 시 사용자 작업공간 설정인 `workspace-pool/workspaces.json`은 유지하고, 설치기가 관리하는 `workspace-pool/common/MULTI_WORKSPACE.md`는 최신 규칙으로 갱신합니다.

## MCP 등록 방식

`dev/start-aionui-dev.sh`는 다음 두 값을 AionUi 프로세스에 전달합니다.

```text
MINDNPROGRESS_MCP_ENTRY=<설치 루트>/MindNProgress/mcp/server.mjs
MNP_SUITE_MCP_CONFIG=<설치 루트>/mcp/mnp-suite-mcp-bootstrap.json
```

AionUi 시작 시 다음 항목이 등록되고 활성화됩니다.

```text
MindNProgress  node <설치 루트>/MindNProgress/mcp/server.mjs
dooray-mcp    <설치 루트>/mcp/start-dooray-mcp.sh       선택 시
pptx-mcp      <설치 루트>/mcp/start-pptx-mcp.sh         선택 시
```

MnP Suite가 등록한 서버에는 소유 표식을 남깁니다. 재설치 후 절대 경로가 달라지거나 서버가 비활성화되면 다음 AionUi 시작 때 수정하고, 선택 해제된 optional MCP는 MnP Suite 소유 항목만 삭제합니다. 같은 이름의 사용자 소유 서버는 덮어쓰지 않습니다.

macOS에는 PowerPoint COM이 없으므로 PPTX slide rendering은 `PPTX → PowerPoint for Mac(AppleScript) PDF → PyMuPDF PNG` 순서로 처리합니다(renderer `powerpoint-applescript+pymupdf`). macOS에서는 LibreOffice를 쓰지 않으며, PowerPoint가 없으면 PNG 내보내기가 `Slide export on macOS requires Microsoft PowerPoint for Mac` 오류를 냅니다. 설치기는 LibreOffice를 설치하지 않고, 이미 설치된 LibreOffice를 지우지도 않습니다.

설치기는 위 8개 font family를 `fc-list`로 확인한 다음, PowerPoint가 있으면 한글 smoke-test PPTX를 PowerPoint MCP와 같은 PowerPoint·PyMuPDF 코드로 렌더링합니다. 변환된 PDF에서 한글 문구가 유지되고(PowerPoint PDF는 한글 단어 사이 공백을 텍스트에 남기지 않으므로 공백을 빼고 비교) PNG가 비어 있지 않아야 설치가 성공하며, 최종 이미지는 `<설치 루트>/install-logs/pptx-korean-font-smoke.png`에 남깁니다. PDF에 포함된 글꼴 이름에 8개 family가 보이지 않으면 경고만 표시합니다. PowerPoint가 없으면 이 확인을 건너뛰고 경고하며, `installation-manifest.json`의 `fonts.smokeTestSkipped`에 그 사실을 기록합니다. 설치 글꼴 출처와 checksum은 `<설치 루트>/fonts/mnp-suite-korean-fonts.json`과 전체 `installation-manifest.json`에 기록합니다.

이 확인을 처음 실행할 때 PowerPoint가 작업 폴더 `~/Library/Caches/ppt-mcp-server/powerpoint-export`에 대한 「파일 액세스 부여」 창을 띄울 수 있습니다. 「선택…」으로 그 폴더를 허용하면 이후 Claude 등에서 PowerPoint MCP를 쓸 때는 다시 뜨지 않습니다. 설치기를 실행한 Terminal이 PowerPoint를 제어해도 되는지 묻는 창이 뜨면 허용합니다.

기존 설치 루트의 `Office-PowerPoint-MCP-Server`를 재사용할 때 PowerPoint for Mac 내보내기 경로(`_convert_pptx_to_pdf_via_powerpoint_mac`)가 없는 이전 코드이면 설치기는 의존성 설치 전에 중단합니다. `--update-existing-repositories`로 다시 실행하거나 해당 저장소를 `origin/main`으로 fast-forward한 뒤 다시 실행합니다.

## 재실행과 확인

설치 후에는 다음 파일을 Finder에서 더블클릭하거나 Terminal에서 실행할 수 있습니다.

```bash
<설치 루트>/dev/start-all-dev.command
```

MindNProgress 확인:

```bash
curl -fsS http://127.0.0.1:4176/api/health
```

AionUi 콘솔에서 `MCP bootstrap completed`와 `runBackendMigrations completed`가 출력되면 bootstrap이 끝난 것입니다. AionUi 설정의 MCP 목록에서 `MindNProgress`, 선택한 `dooray-mcp`, `pptx-mcp`가 활성 상태인지 확인합니다.

완료된 빌드를 재사용하는 예시는 다음과 같습니다.

```bash
./Install-MnPSuite.sh \
  --install-root "$HOME/Developer/MnPSuite" \
  --reuse-existing-repositories \
  --skip-dependency-install \
  --skip-aioncore-build
```

`server/data` 같은 MindNProgress 운영 데이터는 Git 업데이트로 동기화되지 않습니다. 새 Mac이나 다른 사용자 계정으로 설치 루트를 복사하면 Dooray Keychain 항목도 함께 이동하지 않으므로 키를 다시 입력해야 합니다.
