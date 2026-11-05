#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEFAULT_ROOT="$HOME/Developer/MnPSuite"
readonly KEYCHAIN_SERVICE='mnp-suite-dooray-api-key'
readonly GUIDANCE_START='<!-- BEGIN MnP Suite managed agent guidance -->'
readonly GUIDANCE_END='<!-- END MnP Suite managed agent guidance -->'
readonly NANUM_BARUN_GOTHIC_URL='https://hangeul.naver.com/hangeul_static/webfont/zips/nanum-barun-gothic.zip'
readonly NANUM_BARUN_GOTHIC_SHA256='950975a416c20ff7aabfeaf549d741a95f69eaf4a86dce2d7845fab909df6b68'
readonly UN_FONTS_URL='https://deb.debian.org/debian/pool/main/f/fonts-unfonts-core/fonts-unfonts-core_1.0.2-080608.orig.tar.xz'
readonly UN_FONTS_SHA256='14abb309f9d979cc20212fabfbd7f50b55c42183985ae507390c7461ce0b307c'

install_root="$DEFAULT_ROOT"
mindnprogress_branch='main'
aionui_branch='main'
aioncore_branch='main'
dooray_branch='main'
pptx_branch='main'
non_interactive=false
install_prerequisites=false
reuse_existing=false
update_existing=false
skip_dependencies=false
skip_aioncore_build=false
include_unity_skill=false
include_pptx_skill=false
include_dooray=false
include_pptx=false
plan_only=false
launch_after_install=false

usage() {
  cat <<'EOF'
Usage: ./Install-MnPSuite.sh [options]

  --install-root PATH                 Installation root (default: ~/Developer/MnPSuite)
  --mindnprogress-branch NAME         MindNProgress branch (default: main)
  --aionui-branch NAME                AionUi branch (default: main)
  --aioncore-branch NAME              AionCore branch (default: main)
  --dooray-mcp-branch NAME            Dooray MCP branch (default: main)
  --pptx-mcp-branch NAME              PowerPoint MCP branch (default: main)
  --non-interactive                   Do not ask questions; --install-root is required
  --install-missing-prerequisites     Install missing tools with Homebrew
  --reuse-existing-repositories       Reuse repositories without updating them
  --update-existing-repositories      Fast-forward all clean repositories together
  --skip-dependency-install           Skip npm, bun, pip, and Gradle dependency work
  --skip-aioncore-build               Skip the local release AionCore build
  --include-unity-work-skill          Install the Unity workflow skill
  --include-pptx-skill                Install the macOS PPTX workflow skill
  --include-dooray-mcp                Build and register Dooray MCP
  --include-pptx-mcp                  Prepare and register PowerPoint MCP
  --launch                            Start MindNProgress and AionUi after installation
  --plan-only                         Print checks and plan without writing files
  -h, --help                          Show this help
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
note() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
command_path() { command -v "$1" 2>/dev/null || true; }

ask_yes_no() {
  local prompt="$1" default="$2" reply
  read -r -p "$prompt [$([[ "$default" == y ]] && printf 'Y/n' || printf 'y/N')]: " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^([Yy]|yes|YES|네|예)$ ]]
}

normalize_path() {
  local value="$1"
  [[ "$value" == '~' ]] && value="$HOME"
  [[ "$value" == '~/'* ]] && value="$HOME/${value#~/}"
  [[ "$value" != /* ]] && value="$PWD/$value"
  printf '%s\n' "${value%/}"
}

node_supported() {
  local node_bin major
  node_bin="$(command_path node)"
  [[ -n "$node_bin" ]] || return 1
  major="$("$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22 && major < 25))
}

python_supported() {
  local python_bin
  python_bin="$(command_path python3)"
  [[ -n "$python_bin" ]] || return 1
  "$python_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

resolve_java21() {
  local candidate java_home
  for candidate in "$(command_path java)" /opt/homebrew/opt/openjdk@21/bin/java /usr/local/opt/openjdk@21/bin/java; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    if "$candidate" -version 2>&1 | head -1 | grep -Eq 'version "21([.]|\")'; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if command -v brew >/dev/null 2>&1; then
    java_home="$(brew --prefix openjdk@21 2>/dev/null || true)"
    candidate="$java_home/bin/java"
    [[ -x "$candidate" ]] && printf '%s\n' "$candidate" && return 0
  fi
  return 1
}

# pptx-mcp exports slide PNGs on macOS only through Microsoft PowerPoint for Mac
# (AppleScript PDF export, then PyMuPDF) and looks for it in these two places.
resolve_powerpoint_mac() {
  local candidate
  for candidate in '/Applications/Microsoft PowerPoint.app' "$HOME/Applications/Microsoft PowerPoint.app"; do
    [[ -d "$candidate" ]] && printf '%s\n' "$candidate" && return 0
  done
  return 1
}

warn_powerpoint_missing() {
  printf 'Warning: Microsoft PowerPoint for Mac was not found in /Applications or ~/Applications.\n' >&2
  printf '         PowerPoint MCP needs it to export slide images (PNG); the other PowerPoint MCP tools still work.\n' >&2
  printf '         Installation continues without the Korean font rendering check.\n' >&2
}

resolve_fontconfig_file() {
  local candidate prefix
  if [[ -n "${FONTCONFIG_FILE:-}" && -f "$FONTCONFIG_FILE" ]]; then
    printf '%s\n' "$FONTCONFIG_FILE"
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    prefix="$(brew --prefix 2>/dev/null || true)"
  else
    prefix=''
  fi
  for candidate in "$prefix/etc/fonts/fonts.conf" /opt/homebrew/etc/fonts/fonts.conf \
    /usr/local/etc/fonts/fonts.conf /etc/fonts/fonts.conf; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

brew_install_formula() {
  local formula="$1"
  note "Homebrew formula install: $formula"
  brew list --formula "$formula" >/dev/null 2>&1 || brew install "$formula"
}

brew_install_cask() {
  local cask="$1"
  note "Homebrew cask install: $cask"
  brew list --cask "$cask" >/dev/null 2>&1 || brew install --cask "$cask"
}

font_family_present() {
  local expected="$1" fc_list
  fc_list="$(command_path fc-list)"
  [[ -n "$fc_list" ]] || return 1
  "$fc_list" --format='%{family}\n' 2>/dev/null |
    tr ',' '\n' |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' |
    grep -Fx "$expected" >/dev/null
}

font_family_present_any() {
  local family
  for family in "$@"; do
    font_family_present "$family" && return 0
  done
  return 1
}

korean_pptx_fonts_ready() {
  font_family_present 'Noto Sans CJK KR' &&
    font_family_present 'Noto Serif CJK KR' &&
    font_family_present_any 'Nanum Gothic' 'NanumGothic' '나눔고딕' &&
    font_family_present_any 'Nanum Myeongjo' 'NanumMyeongjo' '나눔명조' &&
    font_family_present_any 'NanumSquare' '나눔스퀘어' &&
    font_family_present_any 'NanumBarunGothic' '나눔바른고딕' &&
    font_family_present_any 'UnBatang' '은 바탕' '은바탕' &&
    font_family_present_any 'UnDotum' '은 돋움' '은돋움'
}

wait_for_korean_pptx_fonts() {
  local attempt fc_cache
  fc_cache="$(command_path fc-cache)"
  [[ -n "$fc_cache" ]] || return 1
  for attempt in 1 2 3 4 5; do
    "$fc_cache" -f >/dev/null
    korean_pptx_fonts_ready && return 0
    sleep 1
  done
  return 1
}

download_verified() {
  local url="$1" destination="$2" expected_sha256="$3" actual_sha256
  curl --fail --location --silent --show-error "$url" --output "$destination"
  actual_sha256="$(shasum -a 256 "$destination" | awk '{print $1}')"
  [[ "$actual_sha256" == "$expected_sha256" ]] ||
    die "Font archive checksum mismatch: $url (expected $expected_sha256, got $actual_sha256)"
}

install_user_font_file() {
  local source="$1" destination="$HOME/Library/Fonts/$(basename "$1")"
  if [[ -e "$destination" ]]; then
    cmp -s "$source" "$destination" || die "A different user font already exists: $destination"
    return 0
  fi
  cp "$source" "$destination"
  info "Installed user font: $destination"
}

install_font_cask_if_missing() {
  local cask="$1"
  shift
  if ! font_family_present_any "$@"; then
    brew_install_cask "$cask"
    "$(command -v fc-cache)" -f >/dev/null
  fi
}

install_korean_pptx_fonts() {
  local font_temp nanum_archive un_archive font_source
  command -v brew >/dev/null 2>&1 || die 'Homebrew is required to install the macOS Korean font set.'
  command -v curl >/dev/null 2>&1 || die 'curl is required to download the macOS Korean font set.'
  command -v unzip >/dev/null 2>&1 || die 'unzip is required to prepare Nanum Barun Gothic.'
  command -v tar >/dev/null 2>&1 || die 'tar is required to prepare Un fonts.'
  command -v shasum >/dev/null 2>&1 || die 'shasum is required to verify font archives.'

  mkdir -p "$HOME/Library/Fonts" "$install_root/fonts/licenses"
  "$(command -v fc-cache)" -f >/dev/null
  install_font_cask_if_missing font-noto-sans-cjk-kr 'Noto Sans CJK KR'
  install_font_cask_if_missing font-noto-serif-cjk-kr 'Noto Serif CJK KR'
  install_font_cask_if_missing font-nanum-gothic 'Nanum Gothic' 'NanumGothic' '나눔고딕'
  install_font_cask_if_missing font-nanum-myeongjo 'Nanum Myeongjo' 'NanumMyeongjo' '나눔명조'
  install_font_cask_if_missing font-nanum-square 'NanumSquare' '나눔스퀘어'

  font_temp="$(mktemp -d "${TMPDIR:-/tmp}/mnp-suite-fonts.XXXXXX")"
  if ! font_family_present_any 'NanumBarunGothic' '나눔바른고딕'; then
    nanum_archive="$font_temp/nanum-barun-gothic.zip"
    download_verified "$NANUM_BARUN_GOTHIC_URL" "$nanum_archive" "$NANUM_BARUN_GOTHIC_SHA256"
    mkdir -p "$font_temp/nanum-barun-gothic"
    unzip -q "$nanum_archive" 'NanumBarunGothic*.ttf' -d "$font_temp/nanum-barun-gothic"
    for font_source in "$font_temp"/nanum-barun-gothic/NanumBarunGothic*.ttf; do
      [[ -f "$font_source" ]] || die 'Nanum Barun Gothic archive did not contain the expected TTF files.'
      install_user_font_file "$font_source"
    done
  fi

  if ! font_family_present_any 'UnBatang' '은 바탕' '은바탕' ||
    ! font_family_present_any 'UnDotum' '은 돋움' '은돋움'; then
    un_archive="$font_temp/fonts-unfonts-core.tar.xz"
    download_verified "$UN_FONTS_URL" "$un_archive" "$UN_FONTS_SHA256"
    mkdir -p "$font_temp/un-fonts"
    tar -xf "$un_archive" -C "$font_temp/un-fonts"
    for font_source in "$font_temp"/un-fonts/un-fonts-1.0.2-080608.orig/UnBatang*.ttf \
      "$font_temp"/un-fonts/un-fonts-1.0.2-080608.orig/UnDotum*.ttf; do
      [[ -f "$font_source" ]] || die 'Un font archive did not contain the expected TTF files.'
      install_user_font_file "$font_source"
    done
    cp "$font_temp/un-fonts/un-fonts-1.0.2-080608.orig/COPYING" \
      "$install_root/fonts/licenses/UN-FONTS-GPL-2.txt"
  fi

  rm -rf -- "$font_temp"
  wait_for_korean_pptx_fonts || die 'The complete Korean PPTX font set is not visible to fontconfig after installation.'
}

write_korean_font_manifest() {
  local manifest_path="$install_root/fonts/mnp-suite-korean-fonts.json"
  mkdir -p "$(dirname "$manifest_path")"
  MNP_FONT_MANIFEST="$manifest_path" MNP_FONT_DIR="$HOME/Library/Fonts" MNP_FONTCONFIG_FILE="$fontconfig_file" \
    MNP_NANUM_URL="$NANUM_BARUN_GOTHIC_URL" MNP_NANUM_SHA="$NANUM_BARUN_GOTHIC_SHA256" \
    MNP_UN_URL="$UN_FONTS_URL" MNP_UN_SHA="$UN_FONTS_SHA256" "$python_bin" - <<'PY'
import json
import os
from pathlib import Path

manifest = {
    'schemaVersion': 1,
    'platform': 'macos',
    'fontDirectory': os.environ['MNP_FONT_DIR'],
    'fontconfigFile': os.environ['MNP_FONTCONFIG_FILE'],
    'requiredFamilies': [
        'Noto Sans CJK KR', 'Noto Serif CJK KR', 'Nanum Gothic', 'Nanum Myeongjo',
        'NanumSquare', 'NanumBarunGothic', 'UnBatang', 'UnDotum',
    ],
    'homebrewCaskCandidates': [
        'font-noto-sans-cjk-kr', 'font-noto-serif-cjk-kr', 'font-nanum-gothic',
        'font-nanum-myeongjo', 'font-nanum-square',
    ],
    'pinnedArchives': [
        {'name': 'NanumBarunGothic', 'url': os.environ['MNP_NANUM_URL'], 'sha256': os.environ['MNP_NANUM_SHA']},
        {'name': 'UnBatang+UnDotum', 'url': os.environ['MNP_UN_URL'], 'sha256': os.environ['MNP_UN_SHA']},
    ],
}
Path(os.environ['MNP_FONT_MANIFEST']).write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
)
PY
  printf '%s\n' "$manifest_path"
}

configure_tool_paths() {
  local prefix
  if command -v brew >/dev/null 2>&1; then
    prefix="$(brew --prefix)"
    export PATH="$prefix/bin:$prefix/sbin:$PATH"
    prefix="$(brew --prefix node@22 2>/dev/null || true)"
    [[ -n "$prefix" ]] && export PATH="$prefix/bin:$PATH"
    prefix="$(brew --prefix rustup 2>/dev/null || true)"
    [[ -n "$prefix" ]] && export PATH="$prefix/bin:$PATH"
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
}

while (($#)); do
  case "$1" in
    --install-root) install_root="${2:?missing value for --install-root}"; shift 2 ;;
    --mindnprogress-branch) mindnprogress_branch="${2:?missing value for --mindnprogress-branch}"; shift 2 ;;
    --aionui-branch) aionui_branch="${2:?missing value for --aionui-branch}"; shift 2 ;;
    --aioncore-branch) aioncore_branch="${2:?missing value for --aioncore-branch}"; shift 2 ;;
    --dooray-mcp-branch) dooray_branch="${2:?missing value for --dooray-mcp-branch}"; shift 2 ;;
    --pptx-mcp-branch) pptx_branch="${2:?missing value for --pptx-mcp-branch}"; shift 2 ;;
    --non-interactive) non_interactive=true; shift ;;
    --install-missing-prerequisites) install_prerequisites=true; shift ;;
    --reuse-existing-repositories) reuse_existing=true; shift ;;
    --update-existing-repositories) update_existing=true; reuse_existing=true; shift ;;
    --skip-dependency-install) skip_dependencies=true; shift ;;
    --skip-aioncore-build) skip_aioncore_build=true; shift ;;
    --include-unity-work-skill) include_unity_skill=true; shift ;;
    --include-pptx-skill) include_pptx_skill=true; shift ;;
    --include-dooray-mcp) include_dooray=true; shift ;;
    --include-pptx-mcp) include_pptx=true; shift ;;
    --launch) launch_after_install=true; shift ;;
    --plan-only) plan_only=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == Darwin ]] || die 'This installer supports macOS only.'
if "$non_interactive" && [[ "$install_root" == "$DEFAULT_ROOT" ]]; then
  die '--non-interactive requires an explicit --install-root.'
fi
install_root="$(normalize_path "$install_root")"

if ! "$non_interactive"; then
  read -r -p "Installation root [$install_root]: " selected_root
  install_root="$(normalize_path "${selected_root:-$install_root}")"
  ask_yes_no 'Install unity-work skill for Codex and Claude Code?' n && include_unity_skill=true
  ask_yes_no 'Install macOS pptx skill for Codex and Claude Code?' n && include_pptx_skill=true
  ask_yes_no 'Build and register Dooray MCP?' n && include_dooray=true
  ask_yes_no 'Build and register PowerPoint MCP?' "$([[ "$include_pptx_skill" == true ]] && printf y || printf n)" && include_pptx=true
  ask_yes_no 'Start MindNProgress and AionUi after installation?' y && launch_after_install=true
fi

[[ -n "$install_root" && "$install_root" != / && "$install_root" != "$HOME" ]] || die 'Choose a dedicated subdirectory.'
case "$install_root" in
  /System|/System/*|/Library|/Library/*|/Applications|/Applications/*) die "System directory is not allowed: $install_root" ;;
esac

configure_tool_paths
missing_tools=()
command -v git >/dev/null 2>&1 || missing_tools+=(git)
node_supported || missing_tools+=(node@22)
command -v npm >/dev/null 2>&1 || missing_tools+=(npm)
command -v bun >/dev/null 2>&1 || missing_tools+=(bun)
command -v rustup >/dev/null 2>&1 || missing_tools+=(rustup)
command -v cargo >/dev/null 2>&1 || missing_tools+=(cargo)
python_supported || missing_tools+=(python3)
xcode-select -p >/dev/null 2>&1 || missing_tools+=(xcode-command-line-tools)
"$include_dooray" && ! resolve_java21 >/dev/null && missing_tools+=(openjdk@21)
"$include_pptx" && ! command -v fc-list >/dev/null 2>&1 && missing_tools+=(fontconfig)
"$include_pptx" && command -v fc-list >/dev/null 2>&1 && ! resolve_fontconfig_file >/dev/null && missing_tools+=(fontconfig-config)
"$include_pptx" && ! korean_pptx_fonts_ready && missing_tools+=(korean-pptx-fonts)

note 'Installation plan'
info "Root: $install_root"
info "Required repositories: MindNProgress@$mindnprogress_branch, AionUi@$aionui_branch, AionCore@$aioncore_branch"
"$include_dooray" && info "Optional repository: dooray-mcp-server@$dooray_branch"
"$include_pptx" && info "Optional repository: Office-PowerPoint-MCP-Server@$pptx_branch"
"$include_unity_skill" && info 'Optional skill: unity-work'
"$include_pptx_skill" && info 'Optional skill: pptx'
if ((${#missing_tools[@]})); then info "Missing prerequisites: ${missing_tools[*]}"; else info 'Prerequisites: ready'; fi
powerpoint_app=''
if "$include_pptx"; then
  if powerpoint_app="$(resolve_powerpoint_mac)"; then
    info "Microsoft PowerPoint for slide images: $powerpoint_app"
  else
    powerpoint_app=''
    warn_powerpoint_missing
  fi
fi
"$plan_only" && exit 0

if ((${#missing_tools[@]})); then
  "$install_prerequisites" || die "Missing prerequisites: ${missing_tools[*]}. Rerun with --install-missing-prerequisites."
  command -v brew >/dev/null 2>&1 || die 'Homebrew is required for automatic installation: https://brew.sh'
  command -v git >/dev/null 2>&1 || brew_install_formula git
  node_supported || brew_install_formula node@22
  command -v bun >/dev/null 2>&1 || brew_install_formula bun
  command -v rustup >/dev/null 2>&1 || brew_install_formula rustup
  python_supported || brew_install_formula python@3.12
  if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install
    die 'Complete the Command Line Tools dialog, then rerun the installer.'
  fi
  "$include_dooray" && ! resolve_java21 >/dev/null && brew_install_formula openjdk@21
  "$include_pptx" && ! command -v fc-list >/dev/null 2>&1 && brew_install_formula fontconfig
  configure_tool_paths
fi

node_supported || die 'Node.js >=22 and <25 is required.'
command -v npm >/dev/null 2>&1 || die 'npm was not found.'
command -v bun >/dev/null 2>&1 || die 'Bun was not found.'
command -v rustup >/dev/null 2>&1 || die 'rustup was not found.'
command -v cargo >/dev/null 2>&1 || die 'Cargo was not found.'
rustup show active-toolchain >/dev/null 2>&1 || rustup default stable
python_supported || die 'Python 3.11 or newer is required.'
if "$include_dooray"; then java_bin="$(resolve_java21)" || die 'Java 21 was not found.'; else java_bin=''; fi
node_bin="$(command -v node)"
npm_bin="$(command -v npm)"
bun_bin="$(command -v bun)"
cargo_bin="$(command -v cargo)"
python_bin="$(command -v python3)"
fontconfig_file=''
fontconfig_path=''
if "$include_pptx"; then
  fontconfig_file="$(resolve_fontconfig_file)" || die 'A usable fontconfig fonts.conf was not found.'
  fontconfig_path="$(dirname "$fontconfig_file")"
  export FONTCONFIG_FILE="$fontconfig_file"
  export FONTCONFIG_PATH="$fontconfig_path"
fi

mkdir -p "$install_root" "$install_root/dev" "$install_root/mcp" "$install_root/install-logs"
font_manifest=''
if "$include_pptx"; then
  command -v fc-list >/dev/null 2>&1 || die 'fontconfig was not found after prerequisite installation.'
  command -v fc-cache >/dev/null 2>&1 || die 'fc-cache was not found after prerequisite installation.'
  if ! korean_pptx_fonts_ready; then
    "$install_prerequisites" || die 'The Korean PPTX font set is incomplete. Rerun with --install-missing-prerequisites.'
    note 'Installing Korean fonts for PowerPoint PNG rendering'
    install_korean_pptx_fonts
  else
    info 'Korean PPTX font set is already available.'
  fi
  font_manifest="$(write_korean_font_manifest)"
fi

normalize_remote() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's#/$##; s#[.]git$##'; }

assert_repo() {
  local name="$1" destination="$2" expected_origin="$3" expected_branch="$4" actual_origin actual_branch
  [[ -e "$destination" ]] || return 0
  [[ -d "$destination/.git" ]] || die "$destination exists but is not a Git repository."
  actual_origin="$(git -C "$destination" remote get-url origin 2>/dev/null || true)"
  [[ "$(normalize_remote "$actual_origin")" == "$(normalize_remote "$expected_origin")" ]] || die "$name origin mismatch."
  actual_branch="$(git -C "$destination" branch --show-current)"
  [[ "$actual_branch" == "$expected_branch" ]] || die "$name must be on $expected_branch, not $actual_branch."
  if "$update_existing" && [[ -n "$(git -C "$destination" status --porcelain --untracked-files=all)" ]]; then
    die "$name has local changes; no repository was updated."
  fi
  "$reuse_existing" || die "$name already exists. Use --reuse-existing-repositories or --update-existing-repositories."
}

sync_repo() {
  local name="$1" destination="$2" origin="$3" upstream="$4" branch="$5"
  if [[ ! -e "$destination" ]]; then
    note "Cloning $name"
    git clone --branch "$branch" --single-branch "$origin" "$destination"
  elif "$update_existing"; then
    note "Fast-forwarding $name"
    git -C "$destination" fetch origin "$branch"
    git -C "$destination" merge --ff-only "origin/$branch"
  else
    info "Reusing $name: $destination"
  fi
  if [[ -n "$upstream" ]] && ! git -C "$destination" remote get-url upstream >/dev/null 2>&1; then
    git -C "$destination" remote add upstream "$upstream"
  fi
}

repositories=(
  "MindNProgress|$install_root/MindNProgress|https://github.com/mabobsa/MindNProgress.git||$mindnprogress_branch"
  "AionUi|$install_root/AionUi|https://github.com/mabobsa/AionUi.git|https://github.com/iOfficeAI/AionUi.git|$aionui_branch"
  "AionCore|$install_root/AionCore|https://github.com/mabobsa/AionCore.git|https://github.com/iOfficeAI/AionCore.git|$aioncore_branch"
)
"$include_dooray" && repositories+=("dooray-mcp|$install_root/dooray-mcp-server|https://github.com/mabobsa/dooray-mcp-server.git||$dooray_branch")
"$include_pptx" && repositories+=("pptx-mcp|$install_root/Office-PowerPoint-MCP-Server|https://github.com/mabobsa/Office-PowerPoint-MCP-Server.git||$pptx_branch")

for repository in "${repositories[@]}"; do
  IFS='|' read -r repo_name repo_path repo_origin repo_upstream repo_branch <<<"$repository"
  assert_repo "$repo_name" "$repo_path" "$repo_origin" "$repo_branch"
done
for repository in "${repositories[@]}"; do
  IFS='|' read -r repo_name repo_path repo_origin repo_upstream repo_branch <<<"$repository"
  sync_repo "$repo_name" "$repo_path" "$repo_origin" "$repo_upstream" "$repo_branch"
done

aion_bootstrap="$install_root/AionUi/packages/desktop/src/process/startup/bootstrap/mnpSuiteMcp.ts"
aion_migration="$install_root/AionUi/packages/desktop/src/process/utils/runBackendMigrations.ts"
[[ -f "$aion_bootstrap" && -f "$aion_migration" ]] || die 'AionUi MnP Suite MCP bootstrap source is missing.'
grep -q 'MINDNPROGRESS_MCP_ENTRY' "$aion_bootstrap" || die 'AionUi required MCP bootstrap is unavailable.'
grep -q 'buildMnPSuiteOptionalMcpBootstrap' "$aion_migration" || die 'AionUi optional MCP bootstrap is unavailable.'
# A reused pptx-mcp checkout older than its PowerPoint for Mac export path would
# still render slides through LibreOffice, which this installer no longer sets up.
if "$include_pptx" && ! grep -q 'def _convert_pptx_to_pdf_via_powerpoint_mac' \
  "$install_root/Office-PowerPoint-MCP-Server/tools/export_tools.py" 2>/dev/null; then
  die 'Office-PowerPoint-MCP-Server predates the PowerPoint for Mac slide export. Rerun with --update-existing-repositories or fast-forward it to origin/main.'
fi

if ! "$skip_dependencies"; then
  note 'Installing MindNProgress dependencies'
  (cd "$install_root/MindNProgress" && "$npm_bin" ci)
  note 'Installing AionUi dependencies'
  (cd "$install_root/AionUi" && "$bun_bin" install --frozen-lockfile)
fi

aioncore_bin="$install_root/AionCore/target/release/aioncore"
if ! "$skip_aioncore_build"; then
  note 'Building local release AionCore'
  (cd "$install_root/AionCore" && "$cargo_bin" build --release --locked --bin aioncore)
fi
[[ -x "$aioncore_bin" ]] || die "AionCore binary is missing: $aioncore_bin"

dooray_launcher=''
if "$include_dooray"; then
  note 'Building and testing Dooray MCP stdio server'
  if ! "$skip_dependencies"; then
    java_home="$(cd "$(dirname "$java_bin")/.." && pwd)"
    (cd "$install_root/dooray-mcp-server" && JAVA_HOME="$java_home" ./gradlew clean testMcpIntegration --no-daemon)
  fi
  dooray_jar="$(find "$install_root/dooray-mcp-server/build/libs" -maxdepth 1 -name '*-all.jar' -type f -print -quit)"
  [[ -f "$dooray_jar" ]] || die 'Dooray MCP fat JAR is missing.'
  dooray_launcher="$install_root/mcp/start-dooray-mcp.sh"
  cat > "$dooray_launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
key="\$(security find-generic-password -s '$KEYCHAIN_SERVICE' -a "\$USER" -w 2>/dev/null || true)"
[[ -n "\$key" ]] || { echo 'Dooray API key is missing from macOS Keychain.' >&2; exit 1; }
export DOORAY_API_KEY="\$key"
export DOORAY_BASE_URL='https://api.dooray.com'
export DOORAY_UPLOAD_ALLOWED_ROOTS="\$HOME:\${TMPDIR:-/tmp}:/tmp"
exec "$java_bin" -jar "$dooray_jar"
EOF
  chmod +x "$dooray_launcher"

  if [[ -n "${DOORAY_API_KEY:-}" ]]; then
    security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$USER" -w "$DOORAY_API_KEY" >/dev/null
  elif ! security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$USER" -w >/dev/null 2>&1; then
    if "$non_interactive"; then
      die 'Dooray MCP requires DOORAY_API_KEY or an existing MnP Suite Keychain entry.'
    fi
    read -r -s -p 'Dooray API key (stored in macOS Keychain): ' dooray_key
    printf '\n'
    [[ -n "$dooray_key" ]] || die 'Dooray API key cannot be empty.'
    security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$USER" -w "$dooray_key" >/dev/null
    unset dooray_key
  fi
fi

pptx_launcher=''
font_smoke_png=''
if "$include_pptx"; then
  note 'Preparing and verifying PowerPoint MCP'
  pptx_root="$install_root/Office-PowerPoint-MCP-Server"
  pptx_python="$pptx_root/.venv/bin/python"
  if ! "$skip_dependencies"; then
    "$python_bin" -m venv "$pptx_root/.venv"
    "$pptx_python" -m pip install --upgrade pip
    "$pptx_python" -m pip install -r "$pptx_root/requirements.txt"
  fi
  (cd "$pptx_root" && "$pptx_python" -c 'import pymupdf, mcp, PIL, pptx, ppt_mcp_server')
  if [[ -n "$powerpoint_app" ]]; then
    font_smoke_png="$install_root/install-logs/pptx-korean-font-smoke.png"
    note 'Rendering the Korean font smoke-test slide through Microsoft PowerPoint for Mac'
    info 'PowerPoint may ask for file access to ~/Library/Caches/ppt-mcp-server/powerpoint-export; grant it once.'
    info 'macOS may ask whether this Terminal may control Microsoft PowerPoint; allow it.'
    (cd "$pptx_root" && "$pptx_python" "$SCRIPT_DIR/verify_pptx_fonts.py" \
      --pptx-root "$pptx_root" --output "$font_smoke_png")
  else
    warn_powerpoint_missing
  fi
  pptx_launcher="$install_root/mcp/start-pptx-mcp.sh"
  cat > "$pptx_launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$pptx_python" "$pptx_root/ppt_mcp_server.py"
EOF
  chmod +x "$pptx_launcher"
fi

MNP_INSTALL_ROOT="$install_root" MNP_DOORAY_LAUNCHER="$dooray_launcher" MNP_PPTX_LAUNCHER="$pptx_launcher" "$python_bin" - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ['MNP_INSTALL_ROOT'])
servers = []
if os.environ['MNP_DOORAY_LAUNCHER']:
    servers.append({'name': 'dooray-mcp', 'description': 'Dooray MCP installed and managed by MnP Suite', 'command': os.environ['MNP_DOORAY_LAUNCHER'], 'args': []})
if os.environ['MNP_PPTX_LAUNCHER']:
    servers.append({'name': 'pptx-mcp', 'description': 'PowerPoint MCP installed and managed by MnP Suite', 'command': os.environ['MNP_PPTX_LAUNCHER'], 'args': []})
(root / 'mcp' / 'mnp-suite-mcp-bootstrap.json').write_text(json.dumps({'schemaVersion': 1, 'managedBy': 'MnPSuite', 'servers': servers}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY

workspace_root="$install_root/workspace-pool"
mkdir -p "$workspace_root/common"
if [[ ! -f "$workspace_root/workspaces.json" ]]; then
  MNP_WORKSPACE_ROOT="$workspace_root" "$python_bin" - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ['MNP_WORKSPACE_ROOT'])
registry = {'schemaVersion': 1, 'poolId': 'unity-local', 'sharedRoot': str(root), 'originUrl': '', 'workspaces': [
    {'id': 'integration', 'root': '', 'assetsPath': '', 'unityInstanceHash': '', 'role': 'integration', 'enabled': False},
    {'id': 'worker-01', 'root': '', 'assetsPath': '', 'unityInstanceHash': '', 'role': 'worker', 'enabled': False},
]}
(root / 'workspaces.json').write_text(json.dumps(registry, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY
fi

workspace_rules="$workspace_root/common/MULTI_WORKSPACE.md"
# Keep the shared sections identical to installer/windows Write-WorkspacePoolScaffold and Holdem_AIShared/common/MULTI_WORKSPACE.md.
cat > "$workspace_rules" <<'EOF'
# Unity 멀티 작업공간 공통 규칙

## 기본 모델

- 서로 다른 폴더에 있는 복수의 Unity/Git clone을 작업공간 풀로 사용합니다. 작업공간은 AI 종류에 귀속되지 않으며, 비어 있는 작업공간에는 어떤 AI든 배정될 수 있습니다.
- MindNProgress(MnP)가 비어 있는 worker 하나를 원자적으로 점유(lease)하고, AionCore가 위임 대화의 작업 폴더를 그 프로젝트 루트로 지정해 AI를 실행합니다. 하나의 작업공간에는 동시에 AI 하나만 들어갑니다.
- `workspaces.json`이 작업공간 목록과 경로의 유일한 정적 원본입니다. 운영자 스크립트가 이 파일을 작성하고, MnP는 서버 기동 시에만 읽습니다.
- 실제 가용 상태와 최신 목록은 MnP 작업공간 풀 조회 결과(`mindnprogress_get_ai_workspace_pool`)로 판단합니다. registry를 바꾼 뒤 MnP를 재시작하기 전에는 두 값이 다를 수 있으며, 이때도 AI는 조회 결과를 기준으로 삼습니다. `idle`이 아닌 worker를 임의로 사용하지 않습니다.
- 폴더명, 작업공간 개수, 특정 AI와 작업공간의 대응 관계를 문서·프롬프트·대화 기억으로 추측하거나 하드코딩하지 않습니다.
- `role=integration` 작업공간은 사용자 작업과 결과 통합의 기준입니다. `role=worker`, `enabled=true`인 항목만 AI 위임 후보입니다.
- 위임 전문이나 `.ai-session.json`이 없는 일반 대화에서는 worker를 임의로 선택하거나 점유하지 않습니다.

## AI 작업 규칙

1. 작업 시작 시 배정된 프로젝트 루트의 `.ai-workspace.json`과 `.ai-session.json`을 읽습니다.
2. 위임 전문이 지시하는 배정 값(`workspaceId`, `jobId`, `leaseId`, `projectRoot`, `branch`, `baseCommit` 등)이 `.ai-session.json`과 일치하는지 확인합니다. 확인할 필드와 불일치 시 보고 방법의 원본은 위임 전문이며, 불일치하면 작업하지 않고 위임 전문의 지시대로 보고합니다.
3. 배정된 `projectRoot`, `branch`, `jobId`, `leaseId`만 사용합니다. 배정된 프로젝트 루트 밖의 다른 작업공간으로 이동하거나 그곳을 읽거나 수정해 작업을 우회하지 않습니다.
4. 작업공간 선택, 점유, 전환과 해제는 MnP만 수행합니다. 브랜치를 임의로 전환하지 않으며, 전환이 필요하면 작업을 멈추고 MnP 작업으로 반환합니다.
5. 위임 작업에서는 Git 커밋을 직접 만들지 않습니다. 변경은 위임 전문이 안내하는 MnP 체크포인트(`mindnprogress_checkpoint_ai_workspace`)로 고정합니다. 통합 충돌 해결처럼 위임 전문이 Git 명령을 명시한 경우에만 그 범위에서 사용합니다.
6. 코드와 Unity 에셋은 Git으로만 전달합니다. 작업공간 사이에 `Assets`, `Packages`, `ProjectSettings`를 링크하거나 직접 복사하지 않습니다.
7. `Library`, `Temp`, `Logs`, `UserSettings`, `obj`, `.vs`, 빌드 출력, AI 세션·로그·인증 정보는 작업공간별로 분리합니다.
8. 공통 규칙·지식과 Skill은 일반 작업에서 읽기 전용입니다. 공유 루트나 프로젝트 저장소에 별도 지식 제안 파일을 만들지 않습니다.
9. 완료 시 변경 파일, 검증 결과, 체크포인트(커밋) 여부, dirty 상태, 잔여 작업을 구조화해 보고합니다.

## Unity MCP

Unity MCP 대상은 등록된 `assetsPath`와 `unityInstanceHash`로 구분합니다. 프로젝트를 변경하는 호출은 배정된 작업공간과 일치하는 Unity 인스턴스만 사용하고, 다른 작업공간의 Unity 에디터를 대신 사용하지 않습니다.
EOF
info "Updated managed workspace rules: $workspace_rules"

start_mnp="$install_root/dev/start-mindnprogress-dev.sh"
cat > "$start_mnp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$(dirname "$node_bin"):$(dirname "$npm_bin"):\$PATH"
export MNP_WORKSPACE_POOL_REGISTRY="$workspace_root/workspaces.json"
if grep -q '"name": "dooray-mcp"' "$install_root/mcp/mnp-suite-mcp-bootstrap.json"; then
  key="\$(security find-generic-password -s '$KEYCHAIN_SERVICE' -a "\$USER" -w 2>/dev/null || true)"
  [[ -n "\$key" ]] || { echo 'Dooray API key is missing from macOS Keychain.' >&2; exit 1; }
  export MNP_DOORAY_API_KEY="\$key"
  export MNP_DOORAY_BASE_URL='https://api.dooray.com'
fi
cd "$install_root/MindNProgress"
exec "$npm_bin" run dev
EOF

start_aion="$install_root/dev/start-aionui-dev.sh"
cat > "$start_aion" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$install_root/AionCore/target/release:$(dirname "$node_bin"):$(dirname "$bun_bin"):\$PATH"
export MINDNPROGRESS_MCP_ENTRY="$install_root/MindNProgress/mcp/server.mjs"
export MNP_SUITE_MCP_CONFIG="$install_root/mcp/mnp-suite-mcp-bootstrap.json"
export SENTRY_DSN=''
cd "$install_root/AionUi"
exec "$bun_bin" run dev
EOF

stop_mnp="$install_root/dev/stop-mindnprogress-dev.sh"
cat > "$stop_mnp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
project="$install_root/MindNProgress"
found=false
for port in 4175 4176; do
  for pid in \$(lsof -nP -tiTCP:"\$port" -sTCP:LISTEN 2>/dev/null || true); do
    command="\$(ps -p "\$pid" -o command= 2>/dev/null || true)"
    if [[ "\$command" == *"\$project"* ]]; then kill -TERM "\$pid"; found=true; fi
  done
done
"\$found" && echo '[MindNProgress] Stop signal sent.' || echo '[MindNProgress] Nothing is running.'
EOF

rebuild_core="$install_root/dev/rebuild-aioncore-release.sh"
cat > "$rebuild_core" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$(dirname "$cargo_bin"):\$PATH"
cd "$install_root/AionCore"
exec "$cargo_bin" build --release --locked --bin aioncore
EOF

start_all="$install_root/dev/start-all-dev.command"
cat > "$start_all" <<EOF
#!/usr/bin/env bash
set -euo pipefail
open -a Terminal "$start_mnp"
open -a Terminal "$start_aion"
EOF
chmod +x "$start_mnp" "$start_aion" "$stop_mnp" "$rebuild_core" "$start_all"

install_skill() {
  # Deploy the whole skill directory (SKILL.md plus references, scripts, assets) like the Windows installer.
  local agent_home="$1" name="$2" source="$3"
  MNP_SKILL_NAME="$name" MNP_SKILL_SOURCE="$source" MNP_SKILL_DEST="$agent_home/skills/$name" "$python_bin" - <<'PY' || die "Skill installation failed: $agent_home/skills/$name"
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

name = os.environ['MNP_SKILL_NAME']
source = Path(os.environ['MNP_SKILL_SOURCE'])
destination = Path(os.environ['MNP_SKILL_DEST'])
marker = destination / '.mnp-suite-managed.json'
ignored = {'.DS_Store', '__pycache__', '.mnp-suite-managed.json'}


def fail(message):
    print(f'Error: {message}', file=sys.stderr)
    raise SystemExit(1)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


if not (source / 'SKILL.md').is_file():
    fail(f'Packaged skill is missing SKILL.md: {source}')
if destination.exists() and not marker.is_file():
    fail(f'User-owned skill conflicts with MnP Suite skill: {destination}')

source_files = sorted(
    path.relative_to(source).as_posix()
    for path in source.rglob('*')
    if path.is_file() and not any(part in ignored for part in path.relative_to(source).parts)
)

# Remove files that a previous MnP Suite install wrote but the current package no longer ships.
if marker.is_file():
    previous = json.loads(marker.read_text(encoding='utf-8'))
    if previous.get('packageId') != 'mnp-suite' or previous.get('skillName') != name:
        fail(f'Unexpected MnP Suite skill marker: {marker}')
    root = destination.resolve()
    for entry in previous.get('files', []):
        relative = str(entry.get('path', '')).replace(chr(92), '/')
        target = (destination / relative).resolve()
        if not relative or Path(relative).is_absolute() or root not in target.parents:
            fail(f'Unsafe path in MnP Suite skill marker: {marker} ({relative})')
        if relative in source_files or not target.is_file():
            continue
        if sha256(target) != str(entry.get('sha256', '')).lower():
            fail(f'Packaged skill file was modified after install; not removing it: {target}')
        target.unlink()

files = []
for relative in source_files:
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / relative, target)
    files.append({'path': relative, 'sha256': sha256(target)})
marker.write_text(json.dumps({'schemaVersion': 1, 'packageId': 'mnp-suite', 'skillName': name, 'files': files}) + '\n', encoding='utf-8')
PY
}

merge_guidance() {
  local instructions="$1" guidance_file="$2"
  MNP_INSTRUCTIONS="$instructions" MNP_GUIDANCE="$guidance_file" MNP_GUIDANCE_START="$GUIDANCE_START" MNP_GUIDANCE_END="$GUIDANCE_END" "$python_bin" - <<'PY'
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

path = Path(os.environ['MNP_INSTRUCTIONS'])
path.parent.mkdir(parents=True, exist_ok=True)
existing = path.read_text(encoding='utf-8') if path.exists() else ''
start, end = os.environ['MNP_GUIDANCE_START'], os.environ['MNP_GUIDANCE_END']
if existing.count(start) != existing.count(end) or existing.count(start) > 1:
    raise SystemExit(f'Unsafe MnP Suite guidance markers: {path}')
guidance = Path(os.environ['MNP_GUIDANCE']).read_text(encoding='utf-8').strip()
block = f'{start}\n{guidance}\n{end}'
if start in existing:
    updated = re.sub(re.escape(start) + r'[\s\S]*?' + re.escape(end), block, existing, count=1)
elif existing.strip():
    updated = existing.rstrip() + '\n\n' + block + '\n'
else:
    updated = block + '\n'
if updated != existing:
    if path.exists():
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S%f')
        shutil.copy2(path, Path(str(path) + f'.mnp-suite-backup-{stamp}.bak'))
    path.write_text(updated, encoding='utf-8')
PY
}

guidance_file="$install_root/.mnp-suite-agent-guidance.md"
cat > "$guidance_file" <<'EOF'
## MindNProgress and Dooray work

- Read and follow the `mnp-dooray` skill before using MindNProgress MCP or handling Dooray work.
- Preserve user requirements and still-valid existing content.
- Do not create or modify Dooray work unless the user explicitly authorized it.

## MindNProgress common document workflow

- Read and follow the `mnp-spec-driven-development` skill before MindNProgress group-level preparation and planning, documents or sub-tasks that consume shared outputs, and final integrated verification.
- Perform each step only within the scope the user approved. Approval of the overall direction is not blanket approval for every document run or AI delegation.
EOF
"$include_unity_skill" && cat >> "$guidance_file" <<'EOF'

## Unity work

- Read and follow the `unity-work` skill before modifying a Unity project through MCP.
EOF
"$include_pptx_skill" && cat >> "$guidance_file" <<'EOF'

## PowerPoint work on macOS

- Read and follow the `pptx` skill before reviewing PowerPoint files.
- Verify text and tables together with PNG output rendered by Microsoft PowerPoint for Mac (AppleScript PDF export) and PyMuPDF.
EOF

for agent_home in "${CODEX_HOME:-$HOME/.codex}" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; do
  install_skill "$agent_home" mnp-dooray "$SCRIPT_DIR/../windows/skills/mnp-dooray"
  install_skill "$agent_home" mnp-spec-driven-development "$SCRIPT_DIR/../windows/skills/mnp-spec-driven-development"
  "$include_unity_skill" && install_skill "$agent_home" unity-work "$SCRIPT_DIR/../windows/skills/unity-work"
  "$include_pptx_skill" && install_skill "$agent_home" pptx "$SCRIPT_DIR/skills/pptx"
done
merge_guidance "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" "$guidance_file"
merge_guidance "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md" "$guidance_file"
rm -f "$guidance_file"

MNP_INSTALL_ROOT="$install_root" MNP_NODE_BIN="$node_bin" MNP_BUN_BIN="$bun_bin" MNP_CARGO_BIN="$cargo_bin" MNP_JAVA_BIN="$java_bin" MNP_POWERPOINT_APP="$powerpoint_app" MNP_INCLUDE_DOORAY="$include_dooray" MNP_INCLUDE_PPTX="$include_pptx" MNP_FONT_MANIFEST="$font_manifest" MNP_FONT_SMOKE_PNG="$font_smoke_png" "$python_bin" - <<'PY'
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ['MNP_INSTALL_ROOT'])
repositories = []
for name in ['MindNProgress', 'AionUi', 'AionCore', 'dooray-mcp-server', 'Office-PowerPoint-MCP-Server']:
    repo = root / name
    if not (repo / '.git').is_dir():
        continue
    value = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    repositories.append({'name': name, 'path': str(repo), 'branch': value('branch', '--show-current'), 'commit': value('rev-parse', 'HEAD'), 'origin': value('remote', 'get-url', 'origin')})
manifest = {
    'schemaVersion': 3,
    'installedAt': datetime.now(timezone.utc).isoformat(),
    'platform': 'macos',
    'architecture': os.uname().machine,
    'installRoot': str(root),
    'repositories': repositories,
    'optionalMcp': {'dooray-mcp': os.environ['MNP_INCLUDE_DOORAY'] == 'true', 'pptx-mcp': os.environ['MNP_INCLUDE_PPTX'] == 'true'},
    'tools': {key: os.environ[value] for key, value in [('node', 'MNP_NODE_BIN'), ('bun', 'MNP_BUN_BIN'), ('cargo', 'MNP_CARGO_BIN'), ('java', 'MNP_JAVA_BIN'), ('powerpoint', 'MNP_POWERPOINT_APP')] if os.environ[value]},
    'launchers': ['dev/start-all-dev.command', 'dev/start-mindnprogress-dev.sh', 'dev/start-aionui-dev.sh', 'dev/stop-mindnprogress-dev.sh', 'dev/rebuild-aioncore-release.sh'],
}
if os.environ['MNP_FONT_MANIFEST']:
    manifest['fonts'] = json.loads(Path(os.environ['MNP_FONT_MANIFEST']).read_text(encoding='utf-8'))
    if os.environ['MNP_FONT_SMOKE_PNG']:
        manifest['fonts']['smokeTestPng'] = os.environ['MNP_FONT_SMOKE_PNG']
        manifest['fonts']['smokeTestRenderer'] = 'powerpoint-applescript+pymupdf'
    else:
        manifest['fonts']['smokeTestSkipped'] = 'Microsoft PowerPoint for Mac was not found'
(root / 'installation-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY

required_files=("$install_root/MindNProgress/package.json" "$install_root/AionUi/package.json" "$install_root/AionCore/Cargo.toml" "$aioncore_bin" "$install_root/mcp/mnp-suite-mcp-bootstrap.json" "$workspace_root/workspaces.json" "$start_mnp" "$start_aion" "$start_all" "$install_root/installation-manifest.json")
"$include_dooray" && required_files+=("$dooray_launcher" "$dooray_jar")
"$include_pptx" && required_files+=("$pptx_launcher" "$pptx_python" "$font_manifest")
[[ -n "$font_smoke_png" ]] && required_files+=("$font_smoke_png")
for required_file in "${required_files[@]}"; do [[ -f "$required_file" ]] || die "Verification file is missing: $required_file"; done
"$python_bin" -m json.tool "$install_root/mcp/mnp-suite-mcp-bootstrap.json" >/dev/null
"$python_bin" -m json.tool "$workspace_root/workspaces.json" >/dev/null
"$python_bin" -m json.tool "$install_root/installation-manifest.json" >/dev/null

note 'Installation completed and verified'
info "MindNProgress launcher: $start_mnp"
info "AionUi launcher: $start_aion"
info "All launcher: $start_all"

if "$launch_after_install"; then
  note 'Starting MindNProgress and AionUi'
  open "$start_all"
fi
