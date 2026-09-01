[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [string]$MindNProgressRepository = 'https://github.com/mabobsa/MindNProgress.git',
  [string]$AionUiRepository = 'https://github.com/mabobsa/AionUi.git',
  [string]$AionCoreRepository = 'https://github.com/mabobsa/AionCore.git',
  [string]$DoorayMcpRepository = 'https://github.com/mabobsa/dooray-mcp-server.git',
  [string]$PptxMcpRepository = 'https://github.com/mabobsa/Office-PowerPoint-MCP-Server.git',
  [string]$MindNProgressBranch = 'main',
  [string]$AionUiBranch = 'main',
  [string]$AionCoreBranch = 'main',
  [string]$DoorayMcpBranch = 'main',
  [string]$PptxMcpBranch = 'main',
  [switch]$NonInteractive,
  [switch]$InstallMissingPrerequisites,
  [switch]$ReuseExistingRepositories,
  [switch]$UpdateExistingRepositories,
  [switch]$SkipDependencyInstall,
  [switch]$SkipAionCoreBuild,
  [switch]$IncludeUnityWorkSkill,
  [switch]$IncludePptxSkill,
  [switch]$IncludeDoorayMcp,
  [switch]$IncludePptxMcp,
  [switch]$AllowPptxWithoutPowerPoint,
  [switch]$CreateDesktopShortcuts,
  [switch]$NoLaunchPrompt,
  [switch]$PlanOnly,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$script:TranscriptStarted = $false
$script:InstallLogPath = ''
$script:AgentGuidanceStartMarker = '<!-- BEGIN MnP Suite managed agent guidance -->'
$script:AgentGuidanceEndMarker = '<!-- END MnP Suite managed agent guidance -->'
$script:ManagedSkillMarkerName = '.mnp-suite-managed.json'
$script:OptionalMcpConfigRelativePath = 'mcp\mnp-suite-mcp-bootstrap.json'
$script:DooraySecretRelativePath = 'secrets\dooray-api-key.dpapi'

function Write-Step {
  param([int]$Number, [int]$Total, [string]$Message)
  Write-Host ''
  Write-Host "[$Number/$Total] $Message" -ForegroundColor Cyan
}

function Write-Info {
  param([string]$Message)
  Write-Host "  $Message"
}

function Write-Success {
  param([string]$Message)
  Write-Host "  [완료] $Message" -ForegroundColor Green
}

function Write-Utf8File {
  param([string]$Path, [string]$Content)
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Read-Utf8File {
  param([string]$Path)
  try {
    return [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true))
  } catch {
    throw "UTF-8 텍스트 파일을 안전하게 읽을 수 없습니다: $Path. 원본 파일을 UTF-8로 저장한 뒤 다시 실행하세요. ($($_.Exception.Message))"
  }
}

function Get-MnPSuitePackagedSkillPath {
  param([string]$Name)
  $path = Join-Path $PSScriptRoot "skills\$Name"
  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    throw "설치 패키지 스킬 폴더가 없습니다: $path"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $path 'SKILL.md') -PathType Leaf)) {
    throw "설치 패키지 스킬의 SKILL.md가 없습니다: $path"
  }
  return $path
}

function Get-MnPSuiteManagedSkillMarker {
  param([string]$DestinationPath)
  return Join-Path $DestinationPath $script:ManagedSkillMarkerName
}

function Test-MnPSuiteManagedSkill {
  param([string]$SkillsRoot, [string]$Name)
  $destination = Join-Path $SkillsRoot $Name
  $markerPath = Get-MnPSuiteManagedSkillMarker $destination
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $false }
  try {
    $marker = Read-Utf8File $markerPath | ConvertFrom-Json
    return [string]$marker.packageId -eq 'mnp-suite' -and [string]$marker.skillName -eq $Name
  } catch {
    return $false
  }
}

function Assert-MnPSuiteManagedSkillTarget {
  param([string]$SkillsRoot, [string]$Name)
  $destination = Join-Path $SkillsRoot $Name
  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    throw "스킬 설치 대상이 폴더가 아닙니다: $destination"
  }
  if ((Test-Path -LiteralPath $destination) -and -not (Test-MnPSuiteManagedSkill $SkillsRoot $Name)) {
    throw "사용자 소유 스킬과 이름이 충돌합니다. 기존 폴더를 보존하기 위해 설치를 중단합니다: $destination"
  }
}

function Assert-MnPSuiteManagedSkillRemoval {
  param([string]$SkillsRoot, [string]$Name)
  if (-not (Test-MnPSuiteManagedSkill $SkillsRoot $Name)) { return }

  $destination = [IO.Path]::GetFullPath((Join-Path $SkillsRoot $Name)).TrimEnd([char[]]'\/')
  $destinationPrefix = $destination + [IO.Path]::DirectorySeparatorChar
  $markerPath = Get-MnPSuiteManagedSkillMarker $destination
  $marker = Read-Utf8File $markerPath | ConvertFrom-Json
  $trackedFiles = @{}
  foreach ($file in @($marker.files)) {
    $relativePath = [string]$file.path
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath)) {
      throw "패키지 관리 스킬 표식의 파일 경로가 안전하지 않습니다: $markerPath ($relativePath)"
    }
    $trackedPath = [IO.Path]::GetFullPath((Join-Path $destination $relativePath))
    if (-not $trackedPath.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "패키지 관리 스킬 표식의 파일 경로가 스킬 폴더 밖을 가리킵니다: $markerPath ($relativePath)"
    }
    if ($trackedFiles.ContainsKey($trackedPath)) {
      throw "패키지 관리 스킬 표식에 중복 파일 경로가 있습니다: $markerPath ($relativePath)"
    }
    $trackedFiles[$trackedPath] = ([string]$file.sha256).ToLowerInvariant()
  }

  foreach ($currentFile in Get-ChildItem -LiteralPath $destination -File -Recurse) {
    if ($currentFile.FullName -eq $markerPath) { continue }
    if (-not $trackedFiles.ContainsKey($currentFile.FullName)) {
      throw "패키지 관리 스킬 폴더에 사용자 파일이 있어 자동 제거하지 않습니다: $($currentFile.FullName)"
    }
  }
  foreach ($trackedPath in $trackedFiles.Keys) {
    if (-not (Test-Path -LiteralPath $trackedPath -PathType Leaf)) {
      throw "패키지 관리 스킬 파일이 설치 후 삭제되어 자동 제거하지 않습니다: $trackedPath"
    }
    $currentHash = (Get-FileHash -LiteralPath $trackedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentHash -ne $trackedFiles[$trackedPath]) {
      throw "패키지 관리 스킬 파일이 설치 후 수정되어 자동 제거하지 않습니다: $trackedPath"
    }
  }
}

function Remove-MnPSuiteManagedSkill {
  param([string]$SkillsRoot, [string]$Name)
  if (-not (Test-MnPSuiteManagedSkill $SkillsRoot $Name)) { return $false }

  Assert-MnPSuiteManagedSkillRemoval $SkillsRoot $Name
  $destination = [IO.Path]::GetFullPath((Join-Path $SkillsRoot $Name))
  $markerPath = Get-MnPSuiteManagedSkillMarker $destination
  foreach ($currentFile in Get-ChildItem -LiteralPath $destination -File -Recurse) {
    if ($currentFile.FullName -ne $markerPath) {
      Remove-Item -LiteralPath $currentFile.FullName -Force
    }
  }
  Remove-Item -LiteralPath $markerPath -Force

  $directories = @(Get-ChildItem -LiteralPath $destination -Directory -Recurse | Sort-Object { $_.FullName.Length } -Descending)
  foreach ($directory in $directories) {
    if (@([IO.Directory]::EnumerateFileSystemEntries($directory.FullName)).Count -eq 0) {
      [IO.Directory]::Delete($directory.FullName, $false)
    }
  }
  if (@([IO.Directory]::EnumerateFileSystemEntries($destination)).Count -eq 0) {
    [IO.Directory]::Delete($destination, $false)
  }
  return $true
}

function Assert-MnPSuiteManagedBlockTarget {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path -PathType Container) {
    throw "전역 지침 파일 대상이 폴더입니다: $Path"
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  $existing = Read-Utf8File $Path
  $startCount = [regex]::Matches($existing, [regex]::Escape($script:AgentGuidanceStartMarker)).Count
  $endCount = [regex]::Matches($existing, [regex]::Escape($script:AgentGuidanceEndMarker)).Count
  if ($startCount -ne $endCount -or $startCount -gt 1) {
    throw "MnP Suite 관리 블록 표식이 손상되어 전역 지침을 안전하게 갱신할 수 없습니다: $Path"
  }
  if ($startCount -eq 1) {
    $pattern = [regex]::Escape($script:AgentGuidanceStartMarker) + '[\s\S]*?' + [regex]::Escape($script:AgentGuidanceEndMarker)
    if ([regex]::Matches($existing, $pattern).Count -ne 1) {
      throw "MnP Suite 관리 블록 표식 순서가 손상되어 전역 지침을 안전하게 갱신할 수 없습니다: $Path"
    }
  }
}

function Install-MnPSuiteManagedSkill {
  param(
    [string]$SourcePath,
    [string]$SkillsRoot,
    [string]$Name
  )
  Assert-MnPSuiteManagedSkillTarget $SkillsRoot $Name
  $destination = Join-Path $SkillsRoot $Name
  New-Item -ItemType Directory -Path $destination -Force | Out-Null

  $sourceRoot = [IO.Path]::GetFullPath($SourcePath).TrimEnd('\', '/')
  $installedFiles = @()
  foreach ($sourceFile in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse) {
    $relativePath = $sourceFile.FullName.Substring($sourceRoot.Length).TrimStart([char[]]'\/')
    $destinationFile = Join-Path $destination $relativePath
    $destinationParent = Split-Path -Parent $destinationFile
    if (-not (Test-Path -LiteralPath $destinationParent)) {
      New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    }
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $destinationFile -Force
    $installedFiles += [ordered]@{
      path = $relativePath.Replace('/', '\')
      sha256 = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }

  $marker = [ordered]@{
    schemaVersion = 1
    packageId = 'mnp-suite'
    skillName = $Name
    installedAt = (Get-Date).ToString('o')
    files = $installedFiles
  }
  Write-Utf8File (Get-MnPSuiteManagedSkillMarker $destination) ($marker | ConvertTo-Json -Depth 5)
  return [pscustomobject]@{
    Name = $Name
    Path = $destination
    Files = $installedFiles
  }
}

function New-MnPSuiteInstructionBackup {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "백업할 전역 지침 파일이 없습니다: $Path"
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
  $backupBase = $Path + '.mnp-suite-backup-' + $timestamp
  $backupPath = $backupBase + '.bak'
  $sequence = 1
  while (Test-Path -LiteralPath $backupPath) {
    $backupPath = $backupBase + '-' + $sequence + '.bak'
    $sequence++
  }

  Copy-Item -LiteralPath $Path -Destination $backupPath
  return $backupPath
}

function Set-MnPSuiteManagedBlock {
  param([string]$Path, [string]$Content)
  Assert-MnPSuiteManagedBlockTarget $Path
  $existing = if (Test-Path -LiteralPath $Path -PathType Leaf) { Read-Utf8File $Path } else { '' }
  $newLine = if ($existing -match "`r`n") { "`r`n" } else { "`n" }
  # Git can check out this installer with CRLF even when a newly created guidance file uses LF.
  # Normalize the managed content to the target file's newline before comparing so an identical
  # reinstall does not create a redundant backup solely because of mixed line endings.
  $normalizedContent = $Content.Replace("`r`n", "`n").Replace("`r", "`n")
  if ($newLine -eq "`r`n") {
    $normalizedContent = $normalizedContent.Replace("`n", "`r`n")
  }
  $block = $script:AgentGuidanceStartMarker + $newLine + $normalizedContent.Trim() + $newLine + $script:AgentGuidanceEndMarker
  $startCount = [regex]::Matches($existing, [regex]::Escape($script:AgentGuidanceStartMarker)).Count

  if ($startCount -eq 1) {
    $pattern = [regex]::Escape($script:AgentGuidanceStartMarker) + '[\s\S]*?' + [regex]::Escape($script:AgentGuidanceEndMarker)
    $updated = [regex]::Replace($existing, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $block }, 1)
  } elseif ([string]::IsNullOrWhiteSpace($existing)) {
    $updated = $block + $newLine
  } else {
    $updated = $existing.TrimEnd([char[]]"`r`n") + $newLine + $newLine + $block + $newLine
  }

  $backupPath = ''
  if ($updated -ne $existing) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      $backupPath = New-MnPSuiteInstructionBackup $Path
    }
    Write-Utf8File $Path $updated
  }
  return [pscustomobject]@{ Path = $Path; BackupPath = $backupPath; Changed = $updated -ne $existing }
}

function Get-MnPSuiteAgentGuidance {
  param([bool]$IncludeUnityWork, [bool]$IncludePptx)
  $sections = @(@'
## MindNProgress·Dooray 작업

- MindNProgress MCP 도구를 호출하거나 Dooray 업무·댓글을 다루기 전에 `mnp-dooray` 스킬을 읽고 따른다.
- 사용자가 작성한 요구사항과 아직 유효한 기존 내용을 임의로 삭제하거나 의미가 달라지도록 바꾸지 않는다.
- 한국어 자연어는 실제 문자로 작성하고, 긴 원문은 파일로 확보해 프로그램으로 수정한 뒤 저장 문자열을 비교한다.
- Dooray 업무 생성·수정은 사용자가 승인했거나 현재 요청에서 명시한 경우에만 수행한다.
'@.Trim())

  if ($IncludeUnityWork) {
    $sections += @'
## Unity 작업

- Unity MCP로 프로젝트를 변경하거나 Unity UI 배치 코드를 작성하기 전에 `unity-work` 스킬을 읽고 따른다.
- 변경 호출마다 대상 `unity_instance`를 명시하고, `execute_code` 첫 줄에서 `Application.dataPath`를 검증하며 `replay`를 사용하지 않는다.
- `RectTransform`, `LayoutGroup`, `ScrollRect`의 시각적 배치를 런타임 코드로 덮어쓰지 않는다.
'@.Trim()
  }

  if ($IncludePptx) {
    $sections += @'
## PowerPoint 파일 확인

- pptx·ppt·파워포인트·발표 자료·기획서 슬라이드 내용을 확인하기 전에 `pptx` 스킬을 읽고 따른다.
- 슬라이드 PNG는 `pptx-mcp`의 PowerPoint COM 렌더링을 먼저 사용하고, COM을 사용할 수 없는 경우에만 `officecli --render html`로 대체한다. OfficeCLI에는 원본 가로 크기의 150 DPI 환산 너비만 전달하고 높이·최대 변 1920px 상한 처리는 렌더러에 맡긴다.
- 텍스트·표 구조와 모든 슬라이드 이미지를 함께 확인한다. 두 렌더러를 모두 사용할 수 없으면 텍스트만으로 내용을 확정하지 말고 필요한 연결을 사용자에게 알린다.
- 이미지와 추출 구조가 다르면 차이를 기록하고 PowerPoint에서 직접 확인할 필요가 있는지 명시한다.
'@.Trim()
  }

  return $sections -join "`n`n"
}

function Assert-MnPSuiteAgentConfigurationTargets {
  param(
    [string]$CodexHome,
    [string]$ClaudeHome,
    [bool]$IncludeUnityWork,
    [bool]$IncludePptx
  )
  $skillNames = @('mnp-dooray')
  if ($IncludeUnityWork) { $skillNames += 'unity-work' }
  if ($IncludePptx) { $skillNames += 'pptx' }
  $platforms = @(
    [pscustomobject]@{ Name = 'Codex'; SkillsRoot = (Join-Path $CodexHome 'skills'); Instructions = (Join-Path $CodexHome 'AGENTS.md') },
    [pscustomobject]@{ Name = 'Claude Code'; SkillsRoot = (Join-Path $ClaudeHome 'skills'); Instructions = (Join-Path $ClaudeHome 'CLAUDE.md') }
  )
  foreach ($skillName in $skillNames) {
    Get-MnPSuitePackagedSkillPath $skillName | Out-Null
    foreach ($platform in $platforms) {
      Assert-MnPSuiteManagedSkillTarget $platform.SkillsRoot $skillName
    }
  }
  foreach ($platform in $platforms) {
    if (-not $IncludeUnityWork -and (Test-MnPSuiteManagedSkill $platform.SkillsRoot 'unity-work')) {
      Assert-MnPSuiteManagedSkillRemoval $platform.SkillsRoot 'unity-work'
    }
    if (-not $IncludePptx -and (Test-MnPSuiteManagedSkill $platform.SkillsRoot 'pptx')) {
      Assert-MnPSuiteManagedSkillRemoval $platform.SkillsRoot 'pptx'
    }
    Assert-MnPSuiteManagedBlockTarget $platform.Instructions
  }
}

function Install-MnPSuiteAgentConfiguration {
  param(
    [string]$CodexHome,
    [string]$ClaudeHome,
    [bool]$IncludeUnityWork,
    [bool]$IncludePptx
  )
  Assert-MnPSuiteAgentConfigurationTargets $CodexHome $ClaudeHome $IncludeUnityWork $IncludePptx
  $skillNames = @('mnp-dooray')
  if ($IncludeUnityWork) { $skillNames += 'unity-work' }
  if ($IncludePptx) { $skillNames += 'pptx' }
  $platforms = @(
    [pscustomobject]@{ Name = 'Codex'; SkillsRoot = (Join-Path $CodexHome 'skills'); Instructions = (Join-Path $CodexHome 'AGENTS.md') },
    [pscustomobject]@{ Name = 'Claude Code'; SkillsRoot = (Join-Path $ClaudeHome 'skills'); Instructions = (Join-Path $ClaudeHome 'CLAUDE.md') }
  )
  $guidance = Get-MnPSuiteAgentGuidance $IncludeUnityWork $IncludePptx
  $platformResults = @()
  foreach ($platform in $platforms) {
    $installedSkills = @()
    foreach ($skillName in $skillNames) {
      $installedSkills += Install-MnPSuiteManagedSkill (Get-MnPSuitePackagedSkillPath $skillName) $platform.SkillsRoot $skillName
    }
    $instructionResult = Set-MnPSuiteManagedBlock $platform.Instructions $guidance
    $removedSkills = @()
    if (-not $IncludeUnityWork -and (Remove-MnPSuiteManagedSkill $platform.SkillsRoot 'unity-work')) {
      $removedSkills += 'unity-work'
    }
    if (-not $IncludePptx -and (Remove-MnPSuiteManagedSkill $platform.SkillsRoot 'pptx')) {
      $removedSkills += 'pptx'
    }
    $platformResults += [pscustomobject]@{
      Name = $platform.Name
      SkillsRoot = $platform.SkillsRoot
      Instructions = $instructionResult.Path
      InstructionsBackup = $instructionResult.BackupPath
      Skills = $installedSkills
      RemovedSkills = $removedSkills
    }
  }
  return [pscustomobject]@{
    Skills = $skillNames
    Platforms = $platformResults
  }
}

function Show-InstallerMessage {
  param(
    [string]$Text,
    [string]$Title,
    [ValidateSet('Information', 'Warning', 'Error')]
    [string]$Icon = 'Information'
  )
  if ($NonInteractive) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $messageIcon = [Windows.Forms.MessageBoxIcon]::$Icon
    [Windows.Forms.MessageBox]::Show(
      $Text,
      $Title,
      [Windows.Forms.MessageBoxButtons]::OK,
      $messageIcon
    ) | Out-Null
  } catch {
    # Console output remains the fallback when WinForms is unavailable.
  }
}

function Read-YesNo {
  param([string]$Question, [bool]$Default = $false)
  if ($NonInteractive) { return $Default }
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  $answer = (Read-Host "$Question $hint").Trim()
  if (-not $answer) { return $Default }
  return $answer -match '^(?i:y|yes|예|네)$'
}

function Get-MnPSuiteAgentHomes {
  $userProfileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if ([string]::IsNullOrWhiteSpace($userProfileRoot)) {
    $userProfileRoot = $env:USERPROFILE
  }
  if ([string]::IsNullOrWhiteSpace($userProfileRoot)) {
    throw '현재 사용자의 프로필 경로를 확인할 수 없습니다.'
  }

  $codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Join-Path $userProfileRoot '.codex'
  } else {
    $env:CODEX_HOME
  }
  $claudeHome = if ([string]::IsNullOrWhiteSpace($env:CLAUDE_CONFIG_DIR)) {
    Join-Path $userProfileRoot '.claude'
  } else {
    $env:CLAUDE_CONFIG_DIR
  }

  return [pscustomobject]@{
    UserProfile = [IO.Path]::GetFullPath($userProfileRoot)
    CodexHome = [IO.Path]::GetFullPath($codexHome)
    ClaudeHome = [IO.Path]::GetFullPath($claudeHome)
  }
}

function Resolve-InstallRoot {
  if ($InstallRoot) {
    return [IO.Path]::GetFullPath($InstallRoot)
  }
  if ($NonInteractive) {
    throw 'NonInteractive 모드에서는 -InstallRoot를 지정해야 합니다.'
  }

  $defaultRoot = Join-Path $env:USERPROFILE 'source\MnPSuite'
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'MnP Suite 설치 루트를 선택하거나 새 폴더를 만드세요. 선택한 폴더 아래에 MindNProgress, AionUi, AionCore가 설치됩니다.'
    $dialog.ShowNewFolderButton = $true
    $candidateParent = Split-Path -Parent $defaultRoot
    if (Test-Path -LiteralPath $candidateParent) {
      $dialog.SelectedPath = $candidateParent
    }
    $result = $dialog.ShowDialog()
    if ($result -eq [Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
      $selected = [IO.Path]::GetFullPath($dialog.SelectedPath)
      $leaf = Split-Path -Leaf $selected
      if ($leaf -ne 'MnPSuite' -and (Read-YesNo "선택한 폴더 아래에 MnPSuite 폴더를 만들어 설치할까요?`n$selected" $true)) {
        return Join-Path $selected 'MnPSuite'
      }
      return $selected
    }
  } catch {
    Write-Info '폴더 선택 창을 열 수 없어 콘솔 입력으로 전환합니다.'
  }

  $answer = (Read-Host "설치 루트를 입력하세요 [$defaultRoot]").Trim().Trim('"')
  if (-not $answer) { $answer = $defaultRoot }
  return [IO.Path]::GetFullPath($answer)
}

function Assert-SafeInstallRoot {
  param([string]$Path)
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $root = [IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
  if ($fullPath.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw '드라이브 루트에는 설치할 수 없습니다. 전용 하위 폴더를 선택하세요.'
  }

  $blocked = @(
    $env:WINDIR,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramData
  ) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\', '/') }
  foreach ($blockedPath in $blocked) {
    if ($fullPath.Equals($blockedPath, [StringComparison]::OrdinalIgnoreCase) -or
      $fullPath.StartsWith($blockedPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "시스템 관리 폴더에는 설치할 수 없습니다: $blockedPath"
    }
  }

  if ($fullPath -match '(?i)\\OneDrive(?:\\|$)') {
    if (-not (Read-YesNo '선택한 경로가 OneDrive 안에 있습니다. Git 저장소와 로컬 운영 데이터 충돌 위험이 있습니다. 계속할까요?' $false)) {
      throw '사용자가 OneDrive 경로 설치를 취소했습니다.'
    }
  }
}

function Get-MindNProgressInstallBlockers {
  param([string]$RootPath)

  $projectPath = [IO.Path]::GetFullPath((Join-Path $RootPath 'MindNProgress')).TrimEnd('\', '/')
  if (-not (Test-Path -LiteralPath $projectPath -PathType Container)) { return @() }
  $normalizedProjectPath = $projectPath.Replace('/', '\')

  $blockers = @{}
  $runtimeNames = @('node.exe', 'bun.exe', 'electron.exe')
  $processes = @()
  try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    Write-Warning "실행 중인 프로세스의 명령행을 확인하지 못했습니다: $($_.Exception.Message)"
  }

  foreach ($process in $processes) {
    $processId = [int]$process.ProcessId
    $processName = [string]$process.Name
    $commandLine = [string]$process.CommandLine
    if ($processId -eq $PID -or [string]::IsNullOrWhiteSpace($commandLine)) { continue }
    if ($runtimeNames -notcontains $processName.ToLowerInvariant()) { continue }
    if ($commandLine.Replace('/', '\').IndexOf($normalizedProjectPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }

    $blockers[$processId] = [pscustomobject]@{
      ProcessId = $processId
      Name = $processName
      Reason = 'MindNProgress 설치 경로 사용'
    }
  }

  $connections = @()
  try {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort 4175,4176 -ErrorAction Stop)
  } catch {
    $connections = @()
  }
  foreach ($connection in $connections) {
    $processId = [int]$connection.OwningProcess
    if ($processId -le 0 -or $processId -eq $PID) { continue }
    $reason = "MnP 포트 $($connection.LocalPort) 사용"
    if ($blockers.ContainsKey($processId)) {
      if ($blockers[$processId].Reason -notmatch [regex]::Escape($reason)) {
        $blockers[$processId].Reason += ", $reason"
      }
      continue
    }
    $process = $processes | Where-Object { [int]$_.ProcessId -eq $processId } | Select-Object -First 1
    if (-not $process -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine) -or
        ([string]$process.CommandLine).Replace('/', '\').IndexOf($normalizedProjectPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      continue
    }
    $processName = [string]$process.Name
    $blockers[$processId] = [pscustomobject]@{
      ProcessId = $processId
      Name = $processName
      Reason = $reason
    }
  }

  return @($blockers.Values | Sort-Object ProcessId)
}

function Get-MindNProgressStopGuidance {
  param([string]$RootPath, [object[]]$Blockers)

  $stopPath = Join-Path $RootPath 'MindNProgress_Stop.bat'
  $detected = @($Blockers | ForEach-Object { "$($_.Name) (PID $($_.ProcessId), $($_.Reason))" }) -join "`n- "
  $stopInstruction = if (Test-Path -LiteralPath $stopPath -PathType Leaf) {
    "2. 바탕화면의 MindNProgress-Dev-Stop 바로가기 또는 다음 파일을 실행하세요.`n   $stopPath"
  } else {
    '2. MnP 개발 콘솔에서 Ctrl+C를 누르고 콘솔 창을 닫으세요.'
  }

  return @"
MindNProgress가 실행 중이어서 npm 의존성 파일을 안전하게 교체할 수 없습니다.

감지된 프로세스:
- $detected

재부팅할 필요는 없습니다.
1. MnP와 AionUi Dev 창을 닫으세요.
$stopInstruction
3. 프로세스 종료를 확인한 뒤 설치를 계속하세요.

다른 Node.js 작업을 보호하기 위해 설치 프로그램은 node.exe를 일괄 강제 종료하지 않습니다.
"@
}

function Assert-MindNProgressStoppedForInstall {
  param([string]$RootPath, [switch]$NoPrompt)

  $blockers = @(Get-MindNProgressInstallBlockers $RootPath)
  if ($blockers.Count -eq 0) { return }

  $guidance = Get-MindNProgressStopGuidance $RootPath $blockers
  Write-Host ''
  Write-Host $guidance -ForegroundColor Yellow
  if (-not $NoPrompt -and -not $NonInteractive) {
    [void](Read-Host '위 프로세스를 종료한 뒤 Enter 키를 누르면 다시 확인합니다')
    $blockers = @(Get-MindNProgressInstallBlockers $RootPath)
    if ($blockers.Count -eq 0) {
      Write-Success 'MindNProgress 종료 확인'
      return
    }
    $guidance = Get-MindNProgressStopGuidance $RootPath $blockers
  }

  throw $guidance
}

function Refresh-ProcessPath {
  $current = $env:Path
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $segments = @($current, $machine, $user) |
    Where-Object { $_ } |
    ForEach-Object { $_ -split ';' } |
    Where-Object { $_ } |
    Select-Object -Unique
  $env:Path = $segments -join ';'
  $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
  if ((Test-Path -LiteralPath $cargoBin) -and $env:Path -notlike "*$cargoBin*") {
    $env:Path = "$cargoBin;$env:Path"
  }
}

function Get-CommandVersion {
  param([string]$Command, [string[]]$Arguments = @('--version'))
  $resolved = Get-Command $Command -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $resolved) { return $null }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $resolved.Source @Arguments 2>&1 | Select-Object -First 1
    if (-not $output) { return $null }
    return [string]$output
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function ConvertTo-Version {
  param([string]$Text)
  if ($Text -match '(\d+)\.(\d+)(?:\.(\d+))?') {
    $patch = if ($matches[3]) { [int]$matches[3] } else { 0 }
    return [Version]::new([int]$matches[1], [int]$matches[2], $patch)
  }
  return $null
}

function Get-PythonVersion {
  $launcher = Get-PythonLauncher
  if ($launcher) { return $launcher.VersionText }
  return $null
}

function Get-PythonLauncher {
  $candidates = @(
    @{ Command = 'py'; PrefixArguments = @('-3.14') },
    @{ Command = 'py'; PrefixArguments = @('-3.13') },
    @{ Command = 'py'; PrefixArguments = @('-3.12') },
    @{ Command = 'py'; PrefixArguments = @('-3.11') },
    @{ Command = 'python'; PrefixArguments = @() }
  )
  foreach ($candidate in $candidates) {
    $versionArguments = @($candidate.PrefixArguments) + '--version'
    $version = Get-CommandVersion $candidate.Command $versionArguments
    $parsed = ConvertTo-Version $version
    if ($parsed -and $parsed -ge [Version]'3.11.0') {
      return [pscustomobject]@{
        Command = $candidate.Command
        PrefixArguments = @($candidate.PrefixArguments)
        Version = $parsed
        VersionText = $version
      }
    }
  }
  return $null
}

function Get-JavaMajorVersion {
  param([string]$JavaPath)
  if (-not $JavaPath -or -not (Test-Path -LiteralPath $JavaPath -PathType Leaf)) { return $null }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = (& $JavaPath -version 2>&1 | Select-Object -First 1) -join ''
    if ($output -match 'version\s+"(\d+)') { return [int]$matches[1] }
    if ($output -match 'openjdk\s+(\d+)') { return [int]$matches[1] }
    return $null
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Get-Java21Path {
  param([string]$RootPath = '')
  $candidates = @()
  if ($RootPath) { $candidates += Join-Path $RootPath 'tools\jdk-21\bin\java.exe' }
  if ($env:JAVA_HOME) { $candidates += Join-Path $env:JAVA_HOME 'bin\java.exe' }
  $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($javaCommand) { $candidates += $javaCommand.Source }
  $candidates += 'C:\tools\jdk-21\bin\java.exe'
  if ($env:ProgramFiles) {
    $adoptiumRoot = Join-Path $env:ProgramFiles 'Eclipse Adoptium'
    if (Test-Path -LiteralPath $adoptiumRoot -PathType Container) {
      $candidates += @(Get-ChildItem -LiteralPath $adoptiumRoot -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'bin\java.exe' })
    }
  }
  foreach ($candidate in @($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if ((Get-JavaMajorVersion $candidate) -eq 21) { return [IO.Path]::GetFullPath($candidate) }
  }
  return $null
}

function Install-PortableJdk21 {
  param([string]$RootPath)
  $existing = Get-Java21Path $RootPath
  if ($existing) { return $existing }

  $architecture = switch ($env:PROCESSOR_ARCHITECTURE.ToUpperInvariant()) {
    'AMD64' { 'x64' }
    'ARM64' { 'aarch64' }
    default { throw "portable JDK 21 자동 설치를 지원하지 않는 아키텍처입니다: $env:PROCESSOR_ARCHITECTURE" }
  }
  $toolsRoot = Join-Path $RootPath 'tools'
  $targetRoot = Join-Path $toolsRoot 'jdk-21'
  if (Test-Path -LiteralPath $targetRoot) {
    throw "기존 JDK 대상이 Java 21이 아니어서 덮어쓰지 않았습니다: $targetRoot"
  }
  New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
  $stageRoot = Join-Path $toolsRoot ('.jdk-21-stage-' + [Guid]::NewGuid().ToString('N'))
  $archivePath = Join-Path $stageRoot 'jdk.zip'
  try {
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    Write-Info 'Eclipse Adoptium에서 portable Temurin JDK 21 정보를 확인합니다.'
    $assetUri = "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=$architecture&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&vendor=eclipse"
    $assets = @(Invoke-RestMethod -Uri $assetUri -Method Get)
    $package = $assets | ForEach-Object { $_.binary.package } | Where-Object { $_.link -and $_.checksum } | Select-Object -First 1
    if (-not $package) { throw 'Temurin JDK 21 다운로드 정보를 확인할 수 없습니다.' }
    Invoke-WebRequest -Uri ([string]$package.link) -OutFile $archivePath -UseBasicParsing
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$package.checksum).ToLowerInvariant()) {
      throw 'Temurin JDK 21 다운로드 SHA-256 검증에 실패했습니다.'
    }
    $expandedRoot = Join-Path $stageRoot 'expanded'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedRoot
    $java = Get-ChildItem -LiteralPath $expandedRoot -File -Recurse -Filter 'java.exe' |
      Where-Object { $_.FullName -match '\\bin\\java\.exe$' } | Select-Object -First 1
    if (-not $java -or (Get-JavaMajorVersion $java.FullName) -ne 21) {
      throw '압축을 푼 Temurin JDK가 Java 21인지 확인할 수 없습니다.'
    }
    $jdkHome = Split-Path -Parent (Split-Path -Parent $java.FullName)
    Move-Item -LiteralPath $jdkHome -Destination $targetRoot
  } finally {
    if (Test-Path -LiteralPath $stageRoot) {
      $stageFull = [IO.Path]::GetFullPath($stageRoot).TrimEnd([char[]]'\/')
      $toolsFull = [IO.Path]::GetFullPath($toolsRoot).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
      if (-not $stageFull.StartsWith($toolsFull, [StringComparison]::OrdinalIgnoreCase) -or
          (Split-Path -Leaf $stageFull) -notlike '.jdk-21-stage-*') {
        throw "임시 JDK 폴더 정리 대상이 안전하지 않습니다: $stageFull"
      }
      Remove-Item -LiteralPath $stageFull -Recurse -Force
    }
  }
  $installed = Get-Java21Path $RootPath
  if (-not $installed) { throw 'portable Temurin JDK 21 설치 결과를 확인할 수 없습니다.' }
  Write-Success "portable Temurin JDK 21 준비: $installed"
  return $installed
}

function Test-PowerPointInstalled {
  try {
    return $null -ne [Type]::GetTypeFromProgID('PowerPoint.Application')
  } catch {
    return $false
  }
}

function Get-MsvcBuildToolsPath {
  $vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  foreach ($vswhere in $vswhereCandidates) {
    $result = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($LASTEXITCODE -eq 0 -and $result) { return ([string]$result).Trim() }
  }
  return $null
}

function Get-PrerequisiteState {
  param([bool]$IncludeDooray = $false, [string]$RootPath = '')
  Refresh-ProcessPath
  $gitVersion = Get-CommandVersion 'git'
  $gitReady = $gitVersion -match '^git version\s+\d'
  $nodeText = Get-CommandVersion 'node'
  $nodeVersion = ConvertTo-Version $nodeText
  $nodeSupported = $nodeVersion -and $nodeVersion.Major -ge 22 -and $nodeVersion.Major -lt 25
  $npmVersion = Get-CommandVersion 'npm'
  $npmReady = [bool](ConvertTo-Version $npmVersion)
  $bunVersion = Get-CommandVersion 'bun'
  $bunReady = [bool](ConvertTo-Version $bunVersion)
  $cargoVersion = Get-CommandVersion 'cargo'
  $rustupVersion = Get-CommandVersion 'rustup'
  $cargoReady = $cargoVersion -match '^cargo\s+\d' -and $rustupVersion -match '^rustup\s+\d'
  $pythonVersion = Get-PythonVersion
  $buildToolsPath = Get-MsvcBuildToolsPath
  $cargoDisplay = ("$cargoVersion / $rustupVersion").Trim()

  return @(
    [pscustomobject]@{ Key = 'Git'; Ready = [bool]$gitReady; Version = $gitVersion; WingetId = 'Git.Git'; InstallKind = 'winget'; Description = 'Git 저장소 clone과 업데이트' }
    [pscustomobject]@{ Key = 'Node'; Ready = [bool]$nodeSupported; Version = $nodeText; WingetId = 'OpenJS.NodeJS.LTS'; InstallKind = 'winget'; Description = 'AionUi는 Node.js 22 이상 25 미만 필요' }
    [pscustomobject]@{ Key = 'npm'; Ready = [bool]$npmReady; Version = $npmVersion; WingetId = 'OpenJS.NodeJS.LTS'; InstallKind = 'winget'; Description = 'MindNProgress 의존성 설치' }
    [pscustomobject]@{ Key = 'Bun'; Ready = [bool]$bunReady; Version = $bunVersion; WingetId = 'Oven-sh.Bun'; InstallKind = 'winget'; Description = 'AionUi 의존성 설치와 Dev 실행' }
    [pscustomobject]@{ Key = 'Cargo'; Ready = [bool]$cargoReady; Version = $cargoDisplay; WingetId = 'Rustlang.Rustup'; InstallKind = 'winget'; Description = 'AionCore 빌드와 고정 Rust toolchain 관리' }
    [pscustomobject]@{ Key = 'Python'; Ready = [bool]$pythonVersion; Version = $pythonVersion; WingetId = 'Python.Python.3.12'; InstallKind = 'winget'; Description = 'AionUi 네이티브 모듈과 PowerPoint MCP 가상환경' }
    [pscustomobject]@{ Key = 'MSVC'; Ready = [bool]$buildToolsPath; Version = $buildToolsPath; WingetId = 'Microsoft.VisualStudio.2022.BuildTools'; InstallKind = 'winget'; Description = 'Windows Rust MSVC와 네이티브 모듈 빌드' }
    if ($IncludeDooray) {
      $java21Path = Get-Java21Path $RootPath
      [pscustomobject]@{ Key = 'Java21'; Ready = [bool]$java21Path; Version = $java21Path; WingetId = ''; InstallKind = 'portable-jdk'; Description = 'Dooray MCP 빌드와 실행용 portable JDK 21' }
    }
  )
}

function Show-PrerequisiteState {
  param([object[]]$State)
  foreach ($item in $State) {
    $marker = if ($item.Ready) { '[OK]' } else { '[필요]' }
    $color = if ($item.Ready) { 'Green' } else { 'Yellow' }
    $version = if ($item.Version) { " - $($item.Version)" } else { '' }
    Write-Host "  $marker $($item.Key)$version" -ForegroundColor $color
    if (-not $item.Ready) { Write-Info "    용도: $($item.Description)" }
  }
}

function Assert-WingetReady {
  $wingetCommand = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $wingetCommand) {
    throw '누락 도구를 자동 설치하려면 winget이 필요합니다. 사내 표준 소프트웨어 배포 도구로 필수 항목을 설치한 뒤 다시 실행하세요.'
  }

  $wingetVersion = Get-CommandVersion 'winget' @('--version')
  Write-Info "winget 상태 확인: $wingetVersion"
  & winget search --id Git.Git --exact --source winget --accept-source-agreements | Out-Null
  $probeExitCode = $LASTEXITCODE
  if ($probeExitCode -ne 0) {
    throw "winget 커뮤니티 소스를 사용할 수 없습니다 (exit $probeExitCode). Microsoft Store 또는 사내 배포 도구에서 '앱 설치 관리자(Desktop App Installer)'를 업데이트한 뒤 다시 실행하거나, 필수 도구를 수동 설치하세요."
  }
}

function Install-PrerequisitePackages {
  param([object[]]$Missing, [string]$RootPath)
  $wingetMissing = @($Missing | Where-Object { $_.InstallKind -eq 'winget' })
  if ($wingetMissing.Count -gt 0) { Assert-WingetReady }
  $packageIds = $wingetMissing | Select-Object -ExpandProperty WingetId -Unique
  foreach ($packageId in $packageIds) {
    Write-Info "winget 설치: $packageId (source: winget)"
    $arguments = @(
      'install', '--id', $packageId, '--exact',
      '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements'
    )
    if ($packageId -eq 'Microsoft.VisualStudio.2022.BuildTools') {
      $arguments += @(
        '--override',
        '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
      )
    } else {
      $arguments += '--silent'
    }
    & winget @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "winget 설치에 실패했습니다: $packageId (exit $LASTEXITCODE)"
    }
    Refresh-ProcessPath
  }
  if (@($Missing | Where-Object { $_.InstallKind -eq 'portable-jdk' }).Count -gt 0) {
    Install-PortableJdk21 $RootPath | Out-Null
  }
}

function Invoke-NativeCommand {
  param(
    [string]$Command,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [string]$Description
  )
  Write-Info $Description
  Push-Location $WorkingDirectory
  try {
    # Windows PowerShell 5.1의 Start-Transcript는 네이티브 프로세스의
    # stdout/stderr를 누락할 수 있다. Write-Host를 거쳐 콘솔과 설치 로그에
    # 같은 내용을 남기되, stderr가 ErrorRecord로 승격되어 설치를 먼저
    # 중단하지 않도록 이 호출 범위에서만 Continue로 처리한다.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $Command @Arguments 2>&1 | ForEach-Object {
        Write-Host ([string]$_)
      }
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
      throw "$Description 실패 (exit $exitCode)"
    }
  } finally {
    Pop-Location
  }
}

function Normalize-GitRemote {
  param([string]$Remote)
  return $Remote.Trim().TrimEnd('/').ToLowerInvariant() -replace '\.git$', ''
}

function Assert-RepositoryUpdateSet {
  param([object[]]$Repositories)
  if (-not $UpdateExistingRepositories) { return }

  foreach ($repository in $Repositories) {
    if (-not (Test-Path -LiteralPath $repository.Path)) { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $repository.Path '.git'))) {
      throw "기존 대상이 Git 저장소가 아닙니다: $($repository.Path)"
    }

    $originOutput = @(& git -C $repository.Path remote get-url origin 2>$null)
    $originExitCode = $LASTEXITCODE
    $actualOrigin = $originOutput | Select-Object -First 1
    if ($originExitCode -ne 0 -or -not $actualOrigin) {
      throw "$($repository.Name) 기존 저장소의 origin을 확인할 수 없습니다: $($repository.Path)"
    }
    if ((Normalize-GitRemote $actualOrigin) -ne (Normalize-GitRemote $repository.Origin)) {
      throw "$($repository.Name) 기존 저장소 origin이 설치 설정과 다릅니다.`n기존: $actualOrigin`n예상: $($repository.Origin)"
    }

    $changes = & git -C $repository.Path status --porcelain
    if ($LASTEXITCODE -ne 0) { throw "$($repository.Name) 변경 상태를 확인할 수 없습니다." }
    if ($changes) {
      throw "$($repository.Name) 저장소에 커밋되지 않은 변경이 있어 어떤 저장소도 업데이트하지 않았습니다: $($repository.Path)"
    }
    $currentBranch = (& git -C $repository.Path branch --show-current).Trim()
    if ($currentBranch -ne $repository.Branch) {
      throw "$($repository.Name) 현재 브랜치가 '$currentBranch'입니다. 어떤 저장소도 업데이트하지 않았습니다."
    }
  }
}

function Install-GitRepository {
  param(
    [string]$Name,
    [string]$TargetPath,
    [string]$OriginUrl,
    [string]$UpstreamUrl,
    [string]$Branch
  )
  if (-not (Test-Path -LiteralPath $TargetPath)) {
    Invoke-NativeCommand 'git' @('-c', 'core.longpaths=true', 'clone', '--branch', $Branch, '--single-branch', $OriginUrl, $TargetPath) (Split-Path -Parent $TargetPath) "$Name clone"
  } else {
    $gitDirectory = Join-Path $TargetPath '.git'
    if (-not (Test-Path -LiteralPath $gitDirectory)) {
      throw "기존 대상이 Git 저장소가 아닙니다: $TargetPath"
    }
    $originOutput = @(& git -C $TargetPath remote get-url origin 2>$null)
    $originExitCode = $LASTEXITCODE
    $actualOrigin = $originOutput | Select-Object -First 1
    if ($originExitCode -ne 0 -or -not $actualOrigin) {
      throw "$Name 기존 저장소의 origin을 확인할 수 없습니다: $TargetPath"
    }
    if ((Normalize-GitRemote $actualOrigin) -ne (Normalize-GitRemote $OriginUrl)) {
      throw "$Name 기존 저장소 origin이 설치 설정과 다릅니다.`n기존: $actualOrigin`n예상: $OriginUrl"
    }

    $shouldUpdate = [bool]$UpdateExistingRepositories
    $shouldReuse = [bool]($ReuseExistingRepositories -or $UpdateExistingRepositories)
    if (-not $shouldReuse -and -not $NonInteractive) {
      Write-Host ''
      Write-Host "기존 $Name 저장소가 있습니다: $TargetPath" -ForegroundColor Yellow
      $choice = (Read-Host "[R] 그대로 재사용  [U] origin/$Branch fast-forward 업데이트  [C] 취소").Trim()
      if ($choice -match '^(?i:u)$') { $shouldReuse = $true; $shouldUpdate = $true }
      elseif ($choice -match '^(?i:r)$') { $shouldReuse = $true }
    }
    if (-not $shouldReuse) {
      throw "기존 $Name 저장소를 덮어쓰지 않았습니다. 재사용하려면 -ReuseExistingRepositories, 업데이트하려면 -UpdateExistingRepositories를 지정하세요."
    }

    if ($shouldUpdate) {
      $changes = & git -C $TargetPath status --porcelain
      if ($LASTEXITCODE -ne 0) { throw "$Name 변경 상태를 확인할 수 없습니다." }
      if ($changes) { throw "$Name 저장소에 커밋되지 않은 변경이 있어 업데이트하지 않았습니다: $TargetPath" }
      $currentBranch = (& git -C $TargetPath branch --show-current).Trim()
      if ($currentBranch -ne $Branch) {
        throw "$Name 현재 브랜치가 '$currentBranch'입니다. 자동으로 '$Branch'로 전환하지 않았습니다."
      }
      Invoke-NativeCommand 'git' @('pull', '--ff-only', 'origin', $Branch) $TargetPath "$Name fast-forward 업데이트"
    } else {
      Write-Info "$Name 기존 저장소 재사용"
    }
  }

  Invoke-NativeCommand 'git' @('config', 'core.longpaths', 'true') $TargetPath "$Name long path 설정"
  if ($UpstreamUrl) {
    $remoteNames = @(& git -C $TargetPath remote)
    if ($LASTEXITCODE -ne 0) { throw "$Name remote 목록을 확인할 수 없습니다." }
    if ($remoteNames -notcontains 'upstream') {
      Invoke-NativeCommand 'git' @('remote', 'add', 'upstream', $UpstreamUrl) $TargetPath "$Name upstream 등록"
    } else {
      $upstreamOutput = @(& git -C $TargetPath remote get-url upstream 2>$null)
      $upstreamExitCode = $LASTEXITCODE
      $existingUpstream = $upstreamOutput | Select-Object -First 1
      if ($upstreamExitCode -ne 0 -or -not $existingUpstream) { throw "$Name upstream 주소를 확인할 수 없습니다." }
      if ((Normalize-GitRemote $existingUpstream) -ne (Normalize-GitRemote $UpstreamUrl)) {
        Write-Warning "$Name upstream이 예상 주소와 달라 기존 값을 유지합니다: $existingUpstream"
      }
    }
  }
  Write-Success "$Name 준비됨"
}

function ConvertTo-PowerShellSingleQuotedLiteral {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Protect-MnPSuiteSecretFile {
  param([string]$Path)
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $currentIdentity.User) { throw '현재 Windows 사용자 SID를 확인할 수 없습니다.' }
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($currentIdentity.User)
  $acl.SetAccessRuleProtection($true, $false)
  $identities = @(
    $currentIdentity.User,
    [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  )
  foreach ($identity in $identities) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Test-DooraySecretFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $protected = Read-Utf8File $Path
    $secure = ConvertTo-SecureString $protected
    return $secure.Length -gt 0
  } catch {
    return $false
  }
}

function Write-DooraySecretFile {
  param([string]$Path, [Security.SecureString]$SecureApiKey)
  if (-not $SecureApiKey -or $SecureApiKey.Length -eq 0) { throw 'Dooray API 키가 비어 있습니다.' }
  $protected = ConvertFrom-SecureString $SecureApiKey
  Write-Utf8File $Path $protected
  Protect-MnPSuiteSecretFile $Path
}

function Get-DoorayApiKeyForInstall {
  param([string]$SecretPath)
  $hasReusableSecret = Test-DooraySecretFile $SecretPath
  if ($NonInteractive) {
    if (-not [string]::IsNullOrWhiteSpace($env:DOORAY_API_KEY)) {
      return ConvertTo-SecureString $env:DOORAY_API_KEY -AsPlainText -Force
    }
    if ($hasReusableSecret) { return $null }
    throw '비대화식 Dooray MCP 설치에는 현재 프로세스의 DOORAY_API_KEY 환경값이 필요합니다. 키를 명령행 인자로 전달하지 마세요.'
  }
  if ($hasReusableSecret -and (Read-YesNo '기존에 암호화해 저장한 Dooray API 키를 계속 사용할까요?' $true)) {
    return $null
  }
  $secure = Read-Host 'Dooray API 키를 입력하세요. 입력 내용은 화면과 설치 로그에 표시되지 않습니다' -AsSecureString
  if (-not $secure -or $secure.Length -eq 0) { throw 'Dooray API 키가 입력되지 않았습니다.' }
  return $secure
}

function Write-DoorayMcpLauncher {
  param(
    [string]$RootPath,
    [string]$JavaPath,
    [string]$JarPath,
    [string]$SecretPath
  )
  $launcherPath = Join-Path $RootPath 'mcp\Start-Dooray-Mcp.ps1'
  $javaLiteral = ConvertTo-PowerShellSingleQuotedLiteral ([IO.Path]::GetFullPath($JavaPath))
  $jarLiteral = ConvertTo-PowerShellSingleQuotedLiteral ([IO.Path]::GetFullPath($JarPath))
  $secretLiteral = ConvertTo-PowerShellSingleQuotedLiteral ([IO.Path]::GetFullPath($SecretPath))
  $content = @"
`$ErrorActionPreference = 'Stop'
`$secretPath = $secretLiteral
`$protectedSecret = [IO.File]::ReadAllText(`$secretPath, [Text.UTF8Encoding]::new(`$false, `$true))
`$secureSecret = ConvertTo-SecureString `$protectedSecret
`$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(`$secureSecret)
`$exitCode = 1
try {
  `$env:DOORAY_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(`$secretPointer)
  `$env:DOORAY_BASE_URL = 'https://api.dooray.com'
  & $javaLiteral '-jar' $jarLiteral
  `$exitCode = `$LASTEXITCODE
} finally {
  Remove-Item Env:DOORAY_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:DOORAY_BASE_URL -ErrorAction SilentlyContinue
  if (`$secretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR(`$secretPointer)
  }
}
exit `$exitCode
"@
  Write-Utf8File $launcherPath $content
  return $launcherPath
}

function Install-DoorayMcpRuntime {
  param([string]$RootPath, [string]$RepositoryPath, [bool]$SkipInstall)
  $javaPath = Get-Java21Path $RootPath
  if (-not $javaPath) { throw 'Dooray MCP에 필요한 Java 21을 찾을 수 없습니다.' }
  $gradleWrapper = Join-Path $RepositoryPath 'gradlew.bat'
  if (-not (Test-Path -LiteralPath $gradleWrapper -PathType Leaf)) {
    throw "Dooray MCP Gradle Wrapper가 없습니다: $gradleWrapper"
  }
  if (-not $SkipInstall) {
    $previousJavaHome = $env:JAVA_HOME
    try {
      $env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $javaPath)
      Invoke-NativeCommand $gradleWrapper @('clean', 'testMcpIntegration', '--no-daemon') $RepositoryPath 'Dooray MCP fat JAR 빌드와 stdio 도구 검사'
    } finally {
      if ($null -eq $previousJavaHome) { Remove-Item Env:JAVA_HOME -ErrorAction SilentlyContinue }
      else { $env:JAVA_HOME = $previousJavaHome }
    }
  }
  $jars = @(Get-ChildItem -LiteralPath (Join-Path $RepositoryPath 'build\libs') -File -Filter '*-all.jar' -ErrorAction SilentlyContinue)
  if ($jars.Count -ne 1) { throw "Dooray MCP fat JAR를 하나로 확정할 수 없습니다: $RepositoryPath\build\libs" }

  $secretPath = Join-Path $RootPath $script:DooraySecretRelativePath
  $secureApiKey = Get-DoorayApiKeyForInstall $secretPath
  if ($secureApiKey) { Write-DooraySecretFile $secretPath $secureApiKey }
  if (-not (Test-DooraySecretFile $secretPath)) { throw 'Dooray API 키 암호화 파일을 현재 사용자로 읽을 수 없습니다.' }
  $launcherPath = Write-DoorayMcpLauncher $RootPath $javaPath $jars[0].FullName $secretPath
  Write-Success 'Dooray MCP Windows 런타임과 사용자별 DPAPI 비밀 저장 준비'
  return [pscustomobject]@{
    Name = 'dooray-mcp'
    RepositoryPath = $RepositoryPath
    JavaPath = $javaPath
    JarPath = $jars[0].FullName
    LauncherPath = $launcherPath
    SecretPath = $secretPath
  }
}

function Install-PptxMcpRuntime {
  param([string]$RepositoryPath, [bool]$SkipInstall)
  $launcher = Get-PythonLauncher
  if (-not $launcher) { throw 'PowerPoint MCP에 사용할 Python 3.11 이상을 찾을 수 없습니다.' }
  $venvPython = Join-Path $RepositoryPath '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    if ($SkipInstall) { throw "의존성 설치를 생략했지만 PowerPoint MCP 가상환경이 없습니다: $venvPython" }
    $venvArguments = @($launcher.PrefixArguments) + @('-m', 'venv', '.venv')
    Invoke-NativeCommand $launcher.Command $venvArguments $RepositoryPath 'PowerPoint MCP 전용 Python 가상환경 생성'
  }
  if (-not $SkipInstall) {
    Invoke-NativeCommand $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip') $RepositoryPath 'PowerPoint MCP pip 갱신'
    Invoke-NativeCommand $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '-r', 'requirements.txt', 'pywin32') $RepositoryPath 'PowerPoint MCP Windows 의존성 설치'
  }
  $serverPath = Join-Path $RepositoryPath 'ppt_mcp_server.py'
  if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "PowerPoint MCP 서버 파일이 없습니다: $serverPath" }
  # Windows PowerShell 5.1은 네이티브 명령에 넘기는 -c 문자열 안의 큰따옴표를
  # 제거할 수 있다. 성공은 종료 코드로 판단하므로 별도 출력문을 넣지 않는다.
  $importProbe = 'import mcp, pptx, pymupdf, fontTools, PIL, pythoncom, win32com.client, ppt_mcp_server'
  Invoke-NativeCommand $venvPython @('-c', $importProbe) $RepositoryPath 'PowerPoint MCP Python·COM 모듈 검사'
  Write-Success 'PowerPoint MCP Windows 가상환경 준비'
  return [pscustomobject]@{
    Name = 'pptx-mcp'
    RepositoryPath = $RepositoryPath
    PythonPath = $venvPython
    ServerPath = $serverPath
    PowerPointInstalled = [bool](Test-PowerPointInstalled)
  }
}

function Write-MnPSuiteMcpBootstrapConfig {
  param([string]$RootPath, [object]$DoorayRuntime, [object]$PptxRuntime)
  $servers = @()
  if ($DoorayRuntime) {
    $powershellCommand = Get-Command powershell.exe -ErrorAction Stop | Select-Object -First 1
    $servers += [ordered]@{
      name = 'dooray-mcp'
      description = 'Dooray MCP installed and managed by MnP Suite'
      command = [IO.Path]::GetFullPath($powershellCommand.Source)
      args = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $DoorayRuntime.LauncherPath)
    }
  }
  if ($PptxRuntime) {
    $servers += [ordered]@{
      name = 'pptx-mcp'
      description = 'PowerPoint MCP installed and managed by MnP Suite'
      command = [IO.Path]::GetFullPath($PptxRuntime.PythonPath)
      args = @([IO.Path]::GetFullPath($PptxRuntime.ServerPath))
    }
  }
  $descriptor = [ordered]@{
    schemaVersion = 1
    managedBy = 'MnPSuite'
    servers = $servers
  }
  $configPath = Join-Path $RootPath $script:OptionalMcpConfigRelativePath
  $json = $descriptor | ConvertTo-Json -Depth 6
  if ($json -match 'DOORAY_API_KEY' -or $json -match 'dooray-api-key\.dpapi') {
    throw 'MCP bootstrap 구성에 Dooray 비밀 경로 또는 키 이름이 포함되었습니다.'
  }
  Write-Utf8File $configPath $json
  return [pscustomobject]@{
    Path = $configPath
    SelectedServers = @($servers | ForEach-Object { $_.name })
  }
}

function Ensure-AionUiMindNProgressBootstrap {
  param([string]$RepositoryPath)

  $bootstrapRelativePath = 'packages\desktop\src\process\startup\bootstrap\mnpSuiteMcp.ts'
  $migrationRelativePath = 'packages\desktop\src\process\utils\runBackendMigrations.ts'
  $testRelativePath = 'tests\unit\bootstrap\mnpSuiteMcp.test.ts'
  $bootstrapSource = Join-Path $RepositoryPath $bootstrapRelativePath
  $migrationSource = Join-Path $RepositoryPath $migrationRelativePath
  if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) {
    $bootstrapRelativePath = 'packages\desktop\src\process\utils\mindNProgressMcpBootstrap.ts'
    $testRelativePath = 'tests\unit\mindNProgressMcpBootstrap.test.ts'
    $bootstrapSource = Join-Path $RepositoryPath $bootstrapRelativePath
  }
  $bootstrapMarker = 'MINDNPROGRESS_MCP_ENTRY'
  $migrationMarker = 'buildMindNProgressMcpServer'
  $optionalBootstrapMarker = 'MNP_SUITE_MCP_CONFIG'
  $optionalMigrationMarker = 'buildMnPSuiteOptionalMcpBootstrap'

  $baseReady = (Test-Path -LiteralPath $bootstrapSource -PathType Leaf) -and
    (Test-Path -LiteralPath $migrationSource -PathType Leaf) -and
    ((Get-Content -LiteralPath $bootstrapSource -Raw) -match $bootstrapMarker) -and
    ((Get-Content -LiteralPath $migrationSource -Raw) -match $migrationMarker)
  if (-not $baseReady) {
    $overlayPath = Join-Path $PSScriptRoot 'overlays\AionUi-MindNProgress-Mcp.patch'
    if (-not (Test-Path -LiteralPath $overlayPath -PathType Leaf)) {
      throw "MindNProgress MCP 자동 등록용 AionUi overlay가 없습니다: $overlayPath"
    }
    Invoke-NativeCommand 'git' @('apply', '--check', '--whitespace=error-all', $overlayPath) $RepositoryPath 'AionUi MindNProgress MCP overlay 사전 검사'
    Invoke-NativeCommand 'git' @('apply', '--whitespace=error-all', $overlayPath) $RepositoryPath 'AionUi MindNProgress MCP overlay 적용'
  }

  $optionalReady = (Test-Path -LiteralPath $bootstrapSource -PathType Leaf) -and
    (Test-Path -LiteralPath $migrationSource -PathType Leaf) -and
    ((Get-Content -LiteralPath $bootstrapSource -Raw) -match $optionalBootstrapMarker) -and
    ((Get-Content -LiteralPath $migrationSource -Raw) -match $optionalMigrationMarker)
  if (-not $optionalReady) {
    $optionalOverlayPath = Join-Path $PSScriptRoot 'overlays\AionUi-MnPSuite-Optional-Mcp.patch'
    if (-not (Test-Path -LiteralPath $optionalOverlayPath -PathType Leaf)) {
      throw "선택 MCP 자동 등록용 AionUi overlay가 없습니다: $optionalOverlayPath"
    }
    Invoke-NativeCommand 'git' @('apply', '--check', '--whitespace=error-all', $optionalOverlayPath) $RepositoryPath 'AionUi 선택 MCP overlay 사전 검사'
    Invoke-NativeCommand 'git' @('apply', '--whitespace=error-all', $optionalOverlayPath) $RepositoryPath 'AionUi 선택 MCP overlay 적용'
  }

  if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf) -or
    -not (Test-Path -LiteralPath $migrationSource -PathType Leaf) -or
    ((Get-Content -LiteralPath $bootstrapSource -Raw) -notmatch $bootstrapMarker) -or
    ((Get-Content -LiteralPath $migrationSource -Raw) -notmatch $migrationMarker) -or
    ((Get-Content -LiteralPath $bootstrapSource -Raw) -notmatch $optionalBootstrapMarker) -or
    ((Get-Content -LiteralPath $migrationSource -Raw) -notmatch $optionalMigrationMarker)) {
    throw 'AionUi MCP bootstrap overlay 적용 결과를 확인할 수 없습니다.'
  }

  $bootstrapChanges = @(& git -C $RepositoryPath status --porcelain -- $bootstrapRelativePath $migrationRelativePath $testRelativePath)
  if ($LASTEXITCODE -ne 0) { throw 'AionUi MCP bootstrap 변경 상태를 확인할 수 없습니다.' }
  $source = if ($bootstrapChanges.Count -gt 0) { 'installer-overlay' } else { 'repository' }
  if ($source -eq 'installer-overlay') { Write-Success 'AionUi에 MindNProgress와 선택 MCP 최초 실행 bootstrap overlay 적용' }
  else { Write-Info 'AionUi 저장소에 MindNProgress와 선택 MCP bootstrap이 이미 포함되어 있습니다.' }
  return [pscustomobject]@{ Applied = $bootstrapChanges.Count -gt 0; Source = $source; OptionalMcpManaged = $true }
}

function Write-WorkspacePoolScaffold {
  param([string]$RootPath)

  $poolRoot = Join-Path $RootPath 'workspace-pool'
  $commonDirectory = Join-Path $poolRoot 'common'
  $inboxDirectory = Join-Path $poolRoot 'knowledge-inbox'
  $appliedDirectory = Join-Path $poolRoot 'knowledge-applied'
  foreach ($directory in @($poolRoot, $commonDirectory, $inboxDirectory, $appliedDirectory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $registryPath = Join-Path $poolRoot 'workspaces.json'
  if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    $registry = [ordered]@{
      schemaVersion = 1
      poolId = 'unity-local'
      sharedRoot = $poolRoot
      originUrl = ''
      workspaces = @(
        [ordered]@{
          id = 'integration'
          root = ''
          assetsPath = ''
          unityInstanceHash = ''
          role = 'integration'
          enabled = $false
        },
        [ordered]@{
          id = 'worker-01'
          root = ''
          assetsPath = ''
          unityInstanceHash = ''
          role = 'worker'
          enabled = $false
        }
      )
    }
    Write-Utf8File $registryPath ($registry | ConvertTo-Json -Depth 6)
  } else {
    Write-Info "기존 작업공간 구성 유지: $registryPath"
  }

  $rulesPath = Join-Path $commonDirectory 'MULTI_WORKSPACE.md'
  $rules = @'
# Unity 멀티 작업공간 공통 규칙

## 기본 모델

- `workspaces.json`이 작업공간 목록과 경로의 유일한 정적 원본입니다.
- `role=integration` 작업공간은 사용자 작업과 결과 통합 기준입니다.
- `role=worker`, `enabled=true`인 항목만 AI 위임 후보입니다.
- 실제 가용 상태는 MindNProgress 작업공간 풀 조회 결과로 판단합니다.
- 위임 전문이나 `.ai-session.json`이 없는 일반 대화에서는 worker를 임의로 선택하거나 점유하지 않습니다.

## AI 작업 규칙

1. 배정된 프로젝트 루트의 `.ai-workspace.json`과 `.ai-session.json`을 확인합니다.
2. 배정된 `projectRoot`, `branch`, `jobId`, `leaseId`만 사용합니다.
3. 다른 작업공간으로 이동하거나 그곳을 수정하지 않습니다.
4. 작업공간 선택, 점유, 전환과 해제는 MindNProgress만 수행합니다.
5. 코드와 Unity 에셋은 Git으로만 전달하며 작업공간 사이에 직접 복사하거나 링크하지 않습니다.
6. 공통 지식 제안은 `knowledge-inbox/<jobId>.md`에 기록하고, 적용이 끝난 항목은 `knowledge-applied`에 보관합니다.

## Unity MCP

Unity MCP 대상은 등록된 `assetsPath`와 `unityInstanceHash`로 구분합니다. 프로젝트를 변경하는 호출은 배정된 작업공간과 일치하는 Unity 인스턴스만 사용합니다.
'@
  Write-Utf8File $rulesPath $rules
  Write-Info "관리 작업공간 규칙 최신화: $rulesPath"

  return [pscustomobject]@{
    Root = $poolRoot
    Registry = $registryPath
    Rules = $rulesPath
  }
}

function Write-DevLaunchers {
  param([string]$RootPath)
  $devDirectory = Join-Path $RootPath 'dev'
  New-Item -ItemType Directory -Path $devDirectory -Force | Out-Null

  $startMindNProgress = @'
@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "SUITE_ROOT=%~dp0.."
set "PROJECT=%SUITE_ROOT%\MindNProgress"
set "MNP_POWERSHELL_LAUNCHER=%~dp0Start-MindNProgress-Dev.ps1"
set "MNP_WORKSPACE_POOL_REGISTRY=%SUITE_ROOT%\workspace-pool\workspaces.json"

if not exist "%PROJECT%\package.json" (
  echo [ERROR] MindNProgress repository was not found: %PROJECT%
  pause
  exit /b 1
)
if not exist "%MNP_POWERSHELL_LAUNCHER%" (
  echo [ERROR] MindNProgress PowerShell launcher was not found: %MNP_POWERSHELL_LAUNCHER%
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node was not found on PATH.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  pause
  exit /b 1
)

cd /d "%PROJECT%"
echo ============================================================
echo  MindNProgress development server
echo   Web : http://127.0.0.1:4175/
echo   API : http://127.0.0.1:4176/api/health
echo   Pool: %MNP_WORKSPACE_POOL_REGISTRY%
echo   Stop: Ctrl+C in this window
echo ============================================================
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%MNP_POWERSHELL_LAUNCHER%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
'@

  $startMindNProgressPowerShell = @'
$ErrorActionPreference = 'Stop'
$suiteRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectPath = Join-Path $suiteRoot 'MindNProgress'
$bootstrapPath = Join-Path $suiteRoot 'mcp\mnp-suite-mcp-bootstrap.json'
$secretPath = Join-Path $suiteRoot 'secrets\dooray-api-key.dpapi'
$secretPointer = [IntPtr]::Zero
$exitCode = 1

try {
  if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
    throw "MnP Suite MCP bootstrap config was not found: $bootstrapPath"
  }
  try {
    $bootstrap = [IO.File]::ReadAllText($bootstrapPath, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
  } catch {
    throw "MnP Suite MCP bootstrap config could not be read: $bootstrapPath ($($_.Exception.Message))"
  }
  $dooraySelected = @($bootstrap.servers | Where-Object { [string]$_.name -eq 'dooray-mcp' }).Count -gt 0
  if ($dooraySelected) {
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
      throw "Dooray DPAPI secret was not found: $secretPath"
    }
    $protectedSecret = [IO.File]::ReadAllText($secretPath, [Text.UTF8Encoding]::new($false, $true))
    $secureSecret = ConvertTo-SecureString $protectedSecret
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $env:MNP_DOORAY_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    $env:MNP_DOORAY_BASE_URL = 'https://api.dooray.com'
    Write-Host ' Dooray: Suite DPAPI credential enabled for MindNProgress'
  }

  $npm = Get-Command npm.cmd -ErrorAction Stop | Select-Object -First 1
  Set-Location -LiteralPath $projectPath
  & $npm.Source 'run' 'dev'
  $exitCode = $LASTEXITCODE
} finally {
  Remove-Item Env:MNP_DOORAY_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:MNP_DOORAY_BASE_URL -ErrorAction SilentlyContinue
  if ($secretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  }
}
exit $exitCode
'@

  $stopMindNProgress = @'
@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "SUITE_ROOT=%~dp0.."
set "PROJECT=%SUITE_ROOT%\MindNProgress"
set "MNP_STOP_PROJECT=%PROJECT%"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$project=[Regex]::Escape([IO.Path]::GetFullPath($env:MNP_STOP_PROJECT)); $ids=Get-NetTCPConnection -State Listen -LocalPort 4175,4176 -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $_.OwningProcess) -ErrorAction SilentlyContinue; if($p.CommandLine -and $p.CommandLine -match $project){ $p.ProcessId } } | Sort-Object -Unique; if($ids){ $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction Stop }; Write-Host '[MindNProgress] Stopped.' } else { Write-Host '[MindNProgress] Nothing is running.' }"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
'@

  $rebuildAionCore = @'
@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "SUITE_ROOT=%~dp0.."
set "PROJECT=%SUITE_ROOT%\AionCore"

if not exist "%PROJECT%\Cargo.toml" (
  echo [ERROR] AionCore repository was not found: %PROJECT%
  pause
  exit /b 1
)
where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo was not found on PATH.
  pause
  exit /b 1
)

cd /d "%PROJECT%"
echo [AionCore] Building release aioncore.exe...
call cargo build --release --locked --bin aioncore
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" echo [AionCore] Build completed: %PROJECT%\target\release\aioncore.exe
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
'@

  $backupMindNProgress = @'
@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "SUITE_ROOT=%~dp0.."
set "MNP_BACKUP_NO_PAUSE=1"
call "%SUITE_ROOT%\MindNProgress\MindNProgress_Backup.bat" -Destination "%SUITE_ROOT%\MindNProgress_Backup"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
'@

  $restoreMindNProgress = @'
@echo off
setlocal EnableExtensions
chcp 65001 >nul
if "%~1"=="" (
  echo Usage: %~nx0 "^<backup.zip^>"
  pause
  exit /b 1
)
set "SUITE_ROOT=%~dp0.."
set "MNP_BACKUP_NO_PAUSE=1"
call "%SUITE_ROOT%\MindNProgress\MindNProgress_Restore.bat" "%~1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
'@

  $startAionUi = @'
@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "SUITE_ROOT=%~dp0.."
set "AION_UI_DIR=%SUITE_ROOT%\AionUi"
set "AION_CORE_BIN=%SUITE_ROOT%\AionCore\target\release"
set "MINDNPROGRESS_MCP_ENTRY=%SUITE_ROOT%\MindNProgress\mcp\server.mjs"
set "MNP_SUITE_MCP_CONFIG=%SUITE_ROOT%\mcp\mnp-suite-mcp-bootstrap.json"

if not exist "%AION_UI_DIR%\package.json" (
  echo [ERROR] AionUi repository was not found: %AION_UI_DIR%
  pause
  exit /b 1
)
if not exist "%AION_CORE_BIN%\aioncore.exe" (
  echo [ERROR] Local AionCore release binary was not found.
  echo         Run Rebuild-AionCore-Release.bat first.
  pause
  exit /b 1
)
if not exist "%MINDNPROGRESS_MCP_ENTRY%" (
  echo [ERROR] MindNProgress MCP entry was not found: %MINDNPROGRESS_MCP_ENTRY%
  pause
  exit /b 1
)
if not exist "%MNP_SUITE_MCP_CONFIG%" (
  echo [ERROR] MnP Suite MCP bootstrap config was not found: %MNP_SUITE_MCP_CONFIG%
  pause
  exit /b 1
)
where bun >nul 2>nul
if errorlevel 1 (
  echo [ERROR] bun was not found on PATH.
  pause
  exit /b 1
)

set "PATH=%AION_CORE_BIN%;%PATH%"
set "SENTRY_DSN="
set "NoDefaultCurrentDirectoryInExePath="
cd /d "%AION_UI_DIR%"
echo ============================================================
echo  AionUi development mode
echo   AionCore: %AION_CORE_BIN%\aioncore.exe
echo   MnP MCP : %MINDNPROGRESS_MCP_ENTRY%
echo   MCP list: %MNP_SUITE_MCP_CONFIG%
echo   Telemetry: disabled for this launcher
echo   Stop     : close AionUi or press Ctrl+C in this window
echo ============================================================
call bun run dev
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
'@

  $startAll = @'
@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "DEV_DIR=%~dp0"

start "MindNProgress Dev" cmd.exe /d /k ""%DEV_DIR%Start-MindNProgress-Dev.bat""
start "AionUi Dev" cmd.exe /d /k ""%DEV_DIR%Start-AionUi-Dev.bat""
echo MindNProgress and AionUi development windows were started.
echo MnP: http://127.0.0.1:4175/
exit /b 0
'@

  $compatibilityStop = @'
@echo off
setlocal EnableExtensions
call "%~dp0dev\Stop-MindNProgress-Dev.bat"
exit /b %ERRORLEVEL%
'@

  $compatibilityLauncher = @'
const { spawn } = require('node:child_process')
const path = require('node:path')

const rootDirectory = __dirname
const launcher = path.join(rootDirectory, 'dev', 'Start-MindNProgress-Dev.bat')
const commandProcessor = process.env.ComSpec || 'cmd.exe'
const child = spawn(commandProcessor, ['/d', '/c', `"${launcher}"`], {
  cwd: rootDirectory,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
'@

  Write-Utf8File (Join-Path $devDirectory 'Start-MindNProgress-Dev.bat') $startMindNProgress
  Write-Utf8File (Join-Path $devDirectory 'Start-MindNProgress-Dev.ps1') $startMindNProgressPowerShell
  Write-Utf8File (Join-Path $devDirectory 'Stop-MindNProgress-Dev.bat') $stopMindNProgress
  Write-Utf8File (Join-Path $devDirectory 'Rebuild-AionCore-Release.bat') $rebuildAionCore
  Write-Utf8File (Join-Path $devDirectory 'Backup-MindNProgress-Data.bat') $backupMindNProgress
  Write-Utf8File (Join-Path $devDirectory 'Restore-MindNProgress-Data.bat') $restoreMindNProgress
  Write-Utf8File (Join-Path $devDirectory 'Start-AionUi-Dev.bat') $startAionUi
  Write-Utf8File (Join-Path $devDirectory 'Start-All-Dev.bat') $startAll
  Write-Utf8File (Join-Path $RootPath 'MindNProgress_Stop.bat') $compatibilityStop
  Write-Utf8File (Join-Path $RootPath 'MindNProgress_Launcher.cjs') $compatibilityLauncher
  return $devDirectory
}

function Write-InstalledReadme {
  param([string]$RootPath)
  $content = @'
# MnP Suite 개발 환경

이 폴더에는 필수 Git 저장소 세 개와 설치 중 선택한 MCP 저장소가 서로 독립된 형제 폴더로 설치되어 있습니다.

```text
MindNProgress/
AionUi/
AionCore/
dooray-mcp-server/                 Dooray MCP 선택 시
Office-PowerPoint-MCP-Server/      PowerPoint MCP 선택 시
mcp/
  mnp-suite-mcp-bootstrap.json
  Start-Dooray-Mcp.ps1             Dooray MCP 선택 시
secrets/
  dooray-api-key.dpapi             Dooray MCP 선택 시, 현재 사용자 DPAPI 암호화
workspace-pool/
  common/MULTI_WORKSPACE.md
  knowledge-inbox/
  knowledge-applied/
  workspaces.json
dev/
  Start-MindNProgress-Dev.ps1      Dooray 선택 시 DPAPI 키를 MnP 프로세스에 전달
UNITY_MCP_AND_FORK_GUIDE.md
```

## 실행

- 전체 실행: `dev\Start-All-Dev.bat`
- MindNProgress만 실행: `dev\Start-MindNProgress-Dev.bat`
- AionUi만 실행: `dev\Start-AionUi-Dev.bat`
- AionCore 다시 빌드: `dev\Rebuild-AionCore-Release.bat`
- MindNProgress 강제 중지: `dev\Stop-MindNProgress-Dev.bat`
- MindNProgress 데이터 백업: `dev\Backup-MindNProgress-Data.bat`
- MindNProgress 데이터 복원: `dev\Restore-MindNProgress-Data.bat <backup.zip>`

루트의 `MindNProgress_Launcher.cjs`와 `MindNProgress_Stop.bat`은 기존 백업·복원 스크립트가 Suite 실행 상태를 중지하고 복구할 수 있도록 연결하는 호환 실행 파일입니다.

MindNProgress 주소는 `http://127.0.0.1:4175/`입니다. AionUi는 Electron 창으로 열리며 로컬 `AionCore\target\release\aioncore.exe`를 사용합니다.

## 재설치 전 실행 상태 확인

같은 경로에 Suite를 재설치할 때 MnP 또는 해당 경로의 MCP가 실행 중이면 설치 프로그램이 PID와 종료 방법을 안내합니다. MnP와 AionUi Dev 창을 닫고 `MindNProgress_Stop.bat`을 실행한 뒤 설치 창에서 Enter를 누르세요. 설치 프로그램은 다른 개발 작업을 보호하기 위해 `node.exe` 전체를 자동 종료하지 않으며, 정상적으로 종료되면 PC를 재부팅할 필요가 없습니다.

## AionUi의 MCP 자동 등록

AionUi Dev 런처는 설치된 MCP 엔트리 경로를 전달합니다. AionUi는 백엔드가 준비되면 다음 서버를 자동 등록하고 활성 상태 및 경로를 현재 설치 위치에 맞춥니다.

```text
이름: MindNProgress
전송 방식: stdio
명령: node
인수: <이 설치 루트>\MindNProgress\mcp\server.mjs
```

`mcp\mnp-suite-mcp-bootstrap.json`에는 설치 중 선택한 `dooray-mcp`와 `pptx-mcp` 실행 경로가 기록됩니다. AionUi Dev 런처가 이 파일을 전달하면 최초 실행 bootstrap이 선택 서버를 목록에 추가하고, 재설치로 경로가 바뀌면 MnP Suite가 만든 항목만 갱신합니다. 같은 이름의 사용자 소유 서버는 덮어쓰지 않습니다. 선택을 해제한 뒤 재설치하면 MnP Suite 관리 표식이 있는 항목만 다음 AionUi 시작 때 제거합니다.

Dooray API 키는 bootstrap JSON이나 설치 manifest에 기록하지 않습니다. 현재 Windows 사용자만 복호화할 수 있는 DPAPI 파일로 저장합니다. `Start-Dooray-Mcp.ps1`은 Dooray MCP 프로세스에 전달하고, `dev\Start-MindNProgress-Dev.ps1`은 bootstrap에서 Dooray MCP 선택 상태를 확인한 뒤 MnP 프로세스에 `MNP_DOORAY_API_KEY`로 전달합니다. 선택을 해제하면 암호 파일이 남아 있어도 MnP에 전달하지 않습니다.

MnP의 `AI 대화 시작` 창을 다시 열면 `MindNProgress · 필수`가 표시되고, 설치한 선택 MCP는 체크 가능한 목록 항목으로 표시됩니다. MCP 설정과 Assistant 기본값 변경은 새 대화부터 적용될 수 있으며 현재 열려 있는 대화에 소급 적용되지 않습니다.

## Claude Code와 Codex 전역 스킬

설치기는 현재 Windows 사용자에게 다음 구성을 적용합니다.

- 필수: `mnp-dooray`
- 선택: 설치 중 각각 선택한 `unity-work`, `pptx`
- Codex: `.codex\skills`와 `.codex\AGENTS.md`
- Claude Code: `.claude\skills`와 `.claude\CLAUDE.md`

Claude Code 또는 Codex의 전역 구성 폴더가 아직 없어도 필요한 폴더와 파일을 생성합니다. 기존 전역 지침은 유지하고 MnP Suite 표식 사이의 관리 블록만 추가·갱신합니다. 기존 지침 파일을 실제로 변경하기 직전에 같은 폴더에 `<파일명>.mnp-suite-backup-YYYYMMDD-HHmmssfff.bak` 복사본을 매번 만듭니다. 같은 이름의 사용자 소유 스킬이 있으면 덮어쓰지 않고 설치를 중단합니다. 실제 적용 경로, 선택 스킬과 이번 설치에서 만든 백업 경로는 `installation-manifest.json`에서 확인할 수 있습니다.

전역 지침에 문제가 생기면 Claude Code·Codex 세션을 닫고, 복원할 날짜의 `.bak` 파일을 원래 `AGENTS.md` 또는 `CLAUDE.md` 이름으로 복사한 뒤 새 세션을 시작하세요. `.bak` 원본은 이후 복원을 위해 남겨두는 것이 좋습니다.

대화형 재설치에서도 `unity-work`와 `pptx`를 각각 다시 묻습니다. 이미 설치된 선택 스킬은 기본값이 `Y`이며, `N`을 선택하면 MnP Suite가 설치했고 이후 수정되지 않은 스킬과 해당 호출 지침만 제거합니다. 설치 후 파일이 수정·삭제되었거나 사용자 파일이 추가된 스킬은 자동 제거하지 않고 설치를 중단합니다.

`pptx`를 선택하면 PowerPoint 파일 확인 절차가 설치됩니다. PowerPoint MCP도 선택하면 Git 저장소와 전용 Python 가상환경을 준비하고 AionUi에 `pptx-mcp`로 등록합니다. 슬라이드 PNG는 PowerPoint COM을 1순위로 사용합니다. Microsoft PowerPoint COM을 사용할 수 없는 PC에서는 AionUi에 기본 포함된 OfficeCLI를 사용해 `officecli --render html`로 모든 슬라이드를 개별 PNG로 렌더링합니다. OfficeCLI에는 작성자가 지정한 가로 크기의 150 DPI 환산 너비만 전달하며, 높이 자동 계산과 최대 변 1920px 상한 내 비례 축소는 렌더러에 맡깁니다. fallback 결과는 PowerPoint와 배치가 달라질 수 있으므로 사용한 렌더러와 직접 확인 필요 여부를 함께 기록합니다.

Dooray MCP를 선택하면 Java 21 fat JAR를 빌드해 AionUi에 `dooray-mcp`로 등록합니다. 기존 Unity Java 환경과 충돌하지 않도록 시스템 `PATH`와 `JAVA_HOME`은 바꾸지 않고, 필요한 경우 설치 루트의 `tools\jdk-21`에 portable Temurin을 준비합니다.

## Unity MCP와 Fork

Unity 프로젝트 연결, 여러 Unity Editor의 안전한 구분, AionUi·AionCore 소스 fork와 Unity worker 작업공간의 차이는 `UNITY_MCP_AND_FORK_GUIDE.md`를 확인하세요.

설치 시 `workspace-pool\workspaces.json`과 공용 폴더가 생성됩니다. 예시 integration·worker 항목은 안전을 위해 비활성 상태입니다. 실제 Unity Git clone의 절대 경로, `Assets` 경로, 인스턴스 해시와 원격 주소를 입력한 뒤 필요한 항목만 `enabled=true`로 바꾸고 MindNProgress를 다시 시작하세요.

## 저장소 업데이트

각 저장소의 변경 상태와 브랜치를 확인한 뒤 개별적으로 업데이트합니다. 작업 파일이 있는 상태에서 설치 스크립트를 업데이트 모드로 다시 실행하지 마세요. AionCore가 바뀌면 `Rebuild-AionCore-Release.bat`을 실행하고 AionUi를 다시 시작해야 합니다.

## 데이터

MindNProgress 운영 데이터는 `MindNProgress\server\data`에 저장됩니다. Git 소스 업데이트와 별도로 백업해야 하며 다른 PC 설치와 자동 동기화되지 않습니다.
'@
  Write-Utf8File (Join-Path $RootPath 'README_FIRST.md') $content
}

function Copy-UserGuides {
  param([string]$RootPath)
  $sourcePath = Join-Path $PSScriptRoot 'UNITY_MCP_AND_FORK_GUIDE.md'
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "설치 패키지의 Unity MCP 및 Fork 가이드가 없습니다: $sourcePath"
  }
  $destinationPath = Join-Path $RootPath 'UNITY_MCP_AND_FORK_GUIDE.md'
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
  return $destinationPath
}

function New-DesktopShortcut {
  param(
    [string]$Name,
    [string]$TargetPath,
    [string]$WorkingDirectory,
    [string]$DesktopPath = ''
  )
  $shell = New-Object -ComObject WScript.Shell
  $desktop = $DesktopPath
  if (-not $desktop) {
    $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  }
  if (-not $desktop) {
    $desktop = [string]$shell.SpecialFolders.Item('Desktop')
  }
  if (-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
    throw "바탕화면 경로를 사용할 수 없습니다: $desktop"
  }
  $shortcutPath = Join-Path $desktop "$Name.lnk"
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = 'MnP Suite development launcher'
  $shortcut.Save()
  return $shortcutPath
}

function Get-RepositoryManifest {
  param([string]$Name, [string]$Path, [string]$ExpectedBranch, [string]$ExpectedOrigin)
  $commit = (& git -C $Path rev-parse HEAD).Trim()
  $branch = (& git -C $Path branch --show-current).Trim()
  $origin = (& git -C $Path remote get-url origin).Trim()
  return [ordered]@{
    name = $Name
    path = $Path
    origin = $origin
    expectedOrigin = $ExpectedOrigin
    branch = $branch
    expectedBranch = $ExpectedBranch
    commit = $commit
  }
}

function Get-ExistingOptionalMcpSelections {
  param([string]$RootPath)
  $configPath = Join-Path $RootPath $script:OptionalMcpConfigRelativePath
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return @() }
  try {
    $config = Read-Utf8File $configPath | ConvertFrom-Json
    if ($config.schemaVersion -ne 1 -or -not $config.servers) { return @() }
    return @($config.servers | ForEach-Object { [string]$_.name } | Where-Object { $_ })
  } catch {
    throw "기존 선택 MCP bootstrap 구성을 읽을 수 없습니다: $configPath ($($_.Exception.Message))"
  }
}

function Invoke-SelfTest {
  $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("mnp suite installer test " + [Guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    $workspacePool = Write-WorkspacePoolScaffold $temporaryRoot
    $mcpBootstrap = Write-MnPSuiteMcpBootstrapConfig $temporaryRoot $null $null
    $dev = Write-DevLaunchers $temporaryRoot
    Write-InstalledReadme $temporaryRoot
    $guide = Copy-UserGuides $temporaryRoot
    $pptxSkillText = Read-Utf8File (Join-Path (Get-MnPSuitePackagedSkillPath 'pptx') 'SKILL.md')
    if ($pptxSkillText -notmatch 'PowerPoint COM' -or
        $pptxSkillText -notmatch 'officecli view.+screenshot --render html' -or
        $pptxSkillText -notmatch '--screenshot-width \$renderWidth' -or
        $pptxSkillText -match '--screenshot-height' -or
        $pptxSkillText -notmatch '\$renderDpi = 150' -or
        $pptxSkillText -notmatch 'slideWidthEmu \* \$renderDpi / 914400' -or
        $pptxSkillText -notmatch '최대 변이 1920px' -or
        $pptxSkillText -notmatch 'officecli-html') {
      throw 'pptx 스킬의 COM 우선·OfficeCLI fallback 절차 누락'
    }
    $expected = @(
      'Start-MindNProgress-Dev.bat',
      'Stop-MindNProgress-Dev.bat',
      'Rebuild-AionCore-Release.bat',
      'Backup-MindNProgress-Data.bat',
      'Restore-MindNProgress-Data.bat',
      'Start-AionUi-Dev.bat',
      'Start-All-Dev.bat'
    )
    foreach ($file in $expected) {
      $path = Join-Path $dev $file
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "생성 파일 누락: $file" }
      $text = Get-Content -LiteralPath $path -Raw
      if ($text -match '(?i)[A-Z]:\\Git\\') { throw "하드코딩된 Git 경로 발견: $file" }
      if ($text -notmatch '%~dp0') { throw "상대 설치 루트 해석 누락: $file" }
    }
    $compatibilityStop = Join-Path $temporaryRoot 'MindNProgress_Stop.bat'
    $compatibilityLauncher = Join-Path $temporaryRoot 'MindNProgress_Launcher.cjs'
    foreach ($path in @($compatibilityStop, $compatibilityLauncher)) {
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "백업·복원 호환 실행 파일 누락: $path" }
    }
    & node --check $compatibilityLauncher
    if ($LASTEXITCODE -ne 0) { throw '백업·복원 호환 Node 실행 파일 구문 오류' }
    if (-not (Test-Path -LiteralPath $guide -PathType Leaf)) { throw 'Unity MCP 및 Fork 가이드 복사 실패' }
    $registryText = Get-Content -LiteralPath $workspacePool.Registry -Raw
    $registry = $registryText | ConvertFrom-Json
    if (@($registry.workspaces).Count -lt 2) { throw 'integration과 worker 작업공간 예시 누락' }
    if (@($registry.workspaces | Where-Object { $_.enabled -ne $false }).Count -ne 0) { throw '작업공간 예시는 비활성 상태여야 함' }
    if (-not (Test-Path -LiteralPath $workspacePool.Rules -PathType Leaf)) { throw '작업공간 공통 규칙 생성 실패' }
    Write-Utf8File $workspacePool.Rules '# outdated user-edited managed rules'
    $workspacePool = Write-WorkspacePoolScaffold $temporaryRoot
    $rulesText = Read-Utf8File $workspacePool.Rules
    if ($rulesText -match 'outdated user-edited managed rules' -or
        $rulesText -notmatch '# Unity 멀티 작업공간 공통 규칙') {
      throw '재설치 시 관리 작업공간 규칙 최신화 실패'
    }
    $mindNProgressLauncher = Get-Content -LiteralPath (Join-Path $dev 'Start-MindNProgress-Dev.bat') -Raw
    if ($mindNProgressLauncher -notmatch 'MNP_WORKSPACE_POOL_REGISTRY=%SUITE_ROOT%\\workspace-pool\\workspaces\.json') {
      throw 'MindNProgress 런처의 작업공간 구성 연결 누락'
    }
    if ($mindNProgressLauncher -notmatch 'Start-MindNProgress-Dev\.ps1') {
      throw 'MindNProgress 배치의 PowerShell 보안 런처 연결 누락'
    }
    $mindNProgressPowerShellPath = Join-Path $dev 'Start-MindNProgress-Dev.ps1'
    if (-not (Test-Path -LiteralPath $mindNProgressPowerShellPath -PathType Leaf)) {
      throw 'MindNProgress PowerShell 보안 런처 누락'
    }
    $mindNProgressPowerShell = Get-Content -LiteralPath $mindNProgressPowerShellPath -Raw
    if ($mindNProgressPowerShell -notmatch 'mnp-suite-mcp-bootstrap\.json' -or
        $mindNProgressPowerShell -notmatch "name -eq 'dooray-mcp'" -or
        $mindNProgressPowerShell -notmatch 'dooray-api-key\.dpapi' -or
        $mindNProgressPowerShell -notmatch 'MNP_DOORAY_API_KEY' -or
        $mindNProgressPowerShell -notmatch 'MNP_DOORAY_BASE_URL') {
      throw 'MindNProgress PowerShell 런처의 Dooray DPAPI 연결 누락'
    }
    $launcherTokens = $null
    $launcherErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile(
      $mindNProgressPowerShellPath,
      [ref]$launcherTokens,
      [ref]$launcherErrors
    )
    if ($launcherErrors.Count -gt 0) {
      throw "MindNProgress PowerShell 보안 런처 구문 오류: $($launcherErrors[0].Message)"
    }
    $aionUiLauncher = Get-Content -LiteralPath (Join-Path $dev 'Start-AionUi-Dev.bat') -Raw
    if ($aionUiLauncher -notmatch 'MINDNPROGRESS_MCP_ENTRY=%SUITE_ROOT%\\MindNProgress\\mcp\\server\.mjs') {
      throw 'AionUi 런처의 MindNProgress MCP bootstrap 경로 누락'
    }
    if ($aionUiLauncher -notmatch 'MNP_SUITE_MCP_CONFIG=%SUITE_ROOT%\\mcp\\mnp-suite-mcp-bootstrap\.json') {
      throw 'AionUi 런처의 선택 MCP bootstrap 구성 경로 누락'
    }
    $overlayPath = Join-Path $PSScriptRoot 'overlays\AionUi-MindNProgress-Mcp.patch'
    $overlayText = Get-Content -LiteralPath $overlayPath -Raw
    if ($overlayText -notmatch 'buildMindNProgressMcpServer' -or $overlayText -notmatch 'MINDNPROGRESS_MCP_ENTRY') {
      throw 'AionUi MindNProgress MCP bootstrap overlay 누락 또는 손상'
    }
    $optionalOverlayPath = Join-Path $PSScriptRoot 'overlays\AionUi-MnPSuite-Optional-Mcp.patch'
    $optionalOverlayText = Get-Content -LiteralPath $optionalOverlayPath -Raw
    if ($optionalOverlayText -notmatch 'buildMnPSuiteOptionalMcpBootstrap' -or
        $optionalOverlayText -notmatch 'MNP_SUITE_MCP_CONFIG' -or
        $optionalOverlayText -notmatch 'mnpSuite') {
      throw 'AionUi 선택 MCP bootstrap overlay 누락 또는 손상'
    }
    $mcpBootstrapText = Read-Utf8File $mcpBootstrap.Path
    $mcpBootstrapJson = $mcpBootstrapText | ConvertFrom-Json
    if ($mcpBootstrapJson.schemaVersion -ne 1 -or @($mcpBootstrapJson.servers).Count -ne 0) {
      throw '선택하지 않은 MCP bootstrap 구성의 기본 상태 오류'
    }
    if ($mcpBootstrapText -match 'DOORAY_API_KEY' -or $mcpBootstrapText -match 'dooray-api-key\.dpapi') {
      throw 'MCP bootstrap 구성에 Dooray 비밀 정보가 포함됨'
    }
    $secretTestPath = Join-Path $temporaryRoot $script:DooraySecretRelativePath
    $secretTestValue = 'SELFTEST_DOORAY_SECRET_' + [Guid]::NewGuid().ToString('N')
    Write-DooraySecretFile $secretTestPath (ConvertTo-SecureString $secretTestValue -AsPlainText -Force)
    if (-not (Test-DooraySecretFile $secretTestPath)) { throw 'Dooray DPAPI 비밀 파일 재사용 검사 실패' }
    if ((Read-Utf8File $secretTestPath) -match [regex]::Escape($secretTestValue)) { throw 'Dooray API 키가 암호화되지 않고 저장됨' }

    $fakeProject = Join-Path $temporaryRoot 'MindNProgress'
    Write-Utf8File (Join-Path $fakeProject 'package.json') '{}'
    $blockerScriptPath = Join-Path $fakeProject 'selftest-install-blocker.cjs'
    Write-Utf8File $blockerScriptPath 'setInterval(() => {}, 1000)'
    $nodeCommand = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1
    $blockerProcess = $null
    try {
      $blockerProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + $blockerScriptPath + '"') -WindowStyle Hidden -PassThru
      $detectedBlockers = @()
      for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $detectedBlockers = @(Get-MindNProgressInstallBlockers $temporaryRoot)
        if (@($detectedBlockers | Where-Object { $_.ProcessId -eq $blockerProcess.Id }).Count -gt 0) { break }
        Start-Sleep -Milliseconds 50
      }
      if (@($detectedBlockers | Where-Object { $_.ProcessId -eq $blockerProcess.Id }).Count -eq 0) {
        throw '재설치 전 MindNProgress 실행 프로세스 감지 실패'
      }
      $installBlocked = $false
      try {
        Assert-MindNProgressStoppedForInstall $temporaryRoot -NoPrompt
      } catch {
        $installBlocked = $_.Exception.Message -match '재부팅할 필요는 없습니다' -and
          $_.Exception.Message -match 'MindNProgress_Stop\.bat' -and
          $_.Exception.Message -match [regex]::Escape([string]$blockerProcess.Id)
      }
      if (-not $installBlocked) { throw '재설치 전 실행 상태 안내 검증 실패' }
    } finally {
      if ($blockerProcess -and -not $blockerProcess.HasExited) {
        Stop-Process -Id $blockerProcess.Id -Force -ErrorAction SilentlyContinue
        $blockerProcess.WaitForExit()
      }
    }
    $fakeBin = Join-Path $temporaryRoot 'selftest-bin'
    $captureScriptPath = Join-Path $fakeBin 'Capture-Mnp-Dooray.ps1'
    $captureResultPath = Join-Path $fakeBin 'capture-result.json'
    $captureScript = @'
$apiKey = [string]$env:MNP_DOORAY_API_KEY
$apiKeyHash = ''
if (-not [string]::IsNullOrEmpty($apiKey)) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $apiKeyHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($apiKey)))).Replace('-', '')
  } finally {
    $sha.Dispose()
  }
}
$result = [ordered]@{
  hasApiKey = -not [string]::IsNullOrEmpty($apiKey)
  apiKeySha256 = $apiKeyHash
  baseUrl = [string]$env:MNP_DOORAY_BASE_URL
}
[IO.File]::WriteAllText(
  (Join-Path $PSScriptRoot 'capture-result.json'),
  ($result | ConvertTo-Json -Compress),
  [Text.UTF8Encoding]::new($false)
)
'@
    Write-Utf8File $captureScriptPath $captureScript
    $fakeNpm = @'
@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Capture-Mnp-Dooray.ps1"
exit /b %ERRORLEVEL%
'@
    Write-Utf8File (Join-Path $fakeBin 'npm.cmd') $fakeNpm
    $fakeDoorayLauncher = Join-Path $temporaryRoot 'mcp\selftest-dooray.ps1'
    Write-Utf8File $fakeDoorayLauncher '# selftest Dooray MCP launcher'
    Write-MnPSuiteMcpBootstrapConfig $temporaryRoot ([pscustomobject]@{ LauncherPath = $fakeDoorayLauncher }) $null | Out-Null

    $originalPath = $env:PATH
    $originalMnpDoorayApiKey = [Environment]::GetEnvironmentVariable('MNP_DOORAY_API_KEY', 'Process')
    $originalMnpDoorayBaseUrl = [Environment]::GetEnvironmentVariable('MNP_DOORAY_BASE_URL', 'Process')
    try {
      $env:PATH = "$fakeBin;$originalPath"
      Remove-Item Env:MNP_DOORAY_API_KEY -ErrorAction SilentlyContinue
      Remove-Item Env:MNP_DOORAY_BASE_URL -ErrorAction SilentlyContinue
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $mindNProgressPowerShellPath
      if ($LASTEXITCODE -ne 0) { throw "MindNProgress DPAPI 전달 실행 검사 실패: exit $LASTEXITCODE" }
      $captureResult = Read-Utf8File $captureResultPath | ConvertFrom-Json
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $expectedSecretHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($secretTestValue)))).Replace('-', '')
      } finally {
        $sha.Dispose()
      }
      if (-not $captureResult.hasApiKey -or
          $captureResult.apiKeySha256 -ne $expectedSecretHash -or
          $captureResult.baseUrl -ne 'https://api.dooray.com') {
        throw 'MindNProgress 프로세스의 Dooray DPAPI 환경 전달 결과 오류'
      }

      Write-MnPSuiteMcpBootstrapConfig $temporaryRoot $null $null | Out-Null
      Remove-Item -LiteralPath $captureResultPath -Force
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $mindNProgressPowerShellPath
      if ($LASTEXITCODE -ne 0) { throw "MindNProgress Dooray 선택 해제 실행 검사 실패: exit $LASTEXITCODE" }
      $deselectedCapture = Read-Utf8File $captureResultPath | ConvertFrom-Json
      if ($deselectedCapture.hasApiKey -or -not [string]::IsNullOrEmpty([string]$deselectedCapture.baseUrl)) {
        throw 'Dooray 선택 해제 상태에서 MnP 프로세스에 DPAPI 환경이 전달됨'
      }
    } finally {
      $env:PATH = $originalPath
      [Environment]::SetEnvironmentVariable('MNP_DOORAY_API_KEY', $originalMnpDoorayApiKey, 'Process')
      [Environment]::SetEnvironmentVariable('MNP_DOORAY_BASE_URL', $originalMnpDoorayBaseUrl, 'Process')
    }

    $mcpCases = @(
      [pscustomobject]@{ Name = 'none'; Dooray = $false; Pptx = $false },
      [pscustomobject]@{ Name = 'dooray-only'; Dooray = $true; Pptx = $false },
      [pscustomobject]@{ Name = 'pptx-only'; Dooray = $false; Pptx = $true },
      [pscustomobject]@{ Name = 'both'; Dooray = $true; Pptx = $true }
    )
    foreach ($mcpCase in $mcpCases) {
      $caseRoot = Join-Path $temporaryRoot ('mcp-case-' + $mcpCase.Name)
      $fakeDooray = if ($mcpCase.Dooray) { [pscustomobject]@{ LauncherPath = (Join-Path $caseRoot 'Start-Dooray-Mcp.ps1') } } else { $null }
      $fakePptx = if ($mcpCase.Pptx) { [pscustomobject]@{ PythonPath = (Join-Path $caseRoot 'python.exe'); ServerPath = (Join-Path $caseRoot 'ppt_mcp_server.py') } } else { $null }
      if ($fakeDooray) { Write-Utf8File $fakeDooray.LauncherPath '# selftest launcher' }
      if ($fakePptx) {
        Write-Utf8File $fakePptx.PythonPath ''
        Write-Utf8File $fakePptx.ServerPath ''
      }
      $caseConfig = Write-MnPSuiteMcpBootstrapConfig $caseRoot $fakeDooray $fakePptx
      $caseJsonText = Read-Utf8File $caseConfig.Path
      $caseJson = $caseJsonText | ConvertFrom-Json
      $expectedNames = @()
      if ($mcpCase.Dooray) { $expectedNames += 'dooray-mcp' }
      if ($mcpCase.Pptx) { $expectedNames += 'pptx-mcp' }
      $actualNames = @($caseJson.servers | ForEach-Object { [string]$_.name })
      if (@(Compare-Object $expectedNames $actualNames).Count -ne 0) { throw "MCP 선택 조합 오류: $($mcpCase.Name)" }
      if ($caseJsonText -match [regex]::Escape($secretTestValue) -or $caseJsonText -match 'dooray-api-key\.dpapi') {
        throw "MCP 선택 구성에 비밀 정보가 포함됨: $($mcpCase.Name)"
      }
    }
    $installedReadme = Read-Utf8File (Join-Path $temporaryRoot 'README_FIRST.md')
    if ($installedReadme -notmatch 'UNITY_MCP_AND_FORK_GUIDE\.md') { throw '설치 안내의 추가 가이드 참조 누락' }
    if ($installedReadme -notmatch 'mnp-dooray') { throw '설치 안내의 사용자 전역 스킬 설명 누락' }

    $agentCases = @(
      [pscustomobject]@{ Name = 'neither-exists'; CodexExists = $false; ClaudeExists = $false },
      [pscustomobject]@{ Name = 'codex-only'; CodexExists = $true; ClaudeExists = $false },
      [pscustomobject]@{ Name = 'claude-only'; CodexExists = $false; ClaudeExists = $true },
      [pscustomobject]@{ Name = 'both-exist'; CodexExists = $true; ClaudeExists = $true }
    )
    foreach ($agentCase in $agentCases) {
      $caseRoot = Join-Path $temporaryRoot ("agent-case-" + $agentCase.Name)
      $testCodexHome = Join-Path $caseRoot '.codex'
      $testClaudeHome = Join-Path $caseRoot '.claude'
      $codexOriginal = "CODEX_EXISTING_GUIDANCE 한글 보존: $($agentCase.Name)"
      $claudeOriginal = "CLAUDE_EXISTING_GUIDANCE 한글 보존: $($agentCase.Name)"
      if ($agentCase.CodexExists) {
        Write-Utf8File (Join-Path $testCodexHome 'AGENTS.md') $codexOriginal
      }
      if ($agentCase.ClaudeExists) {
        Write-Utf8File (Join-Path $testClaudeHome 'CLAUDE.md') $claudeOriginal
      }

      $agentResult = Install-MnPSuiteAgentConfiguration $testCodexHome $testClaudeHome $true $true
      foreach ($platform in $agentResult.Platforms) {
        if (-not (Test-Path -LiteralPath $platform.Instructions -PathType Leaf)) {
          throw "전역 지침 생성 실패 ($($agentCase.Name)): $($platform.Instructions)"
        }
        $instructionText = Read-Utf8File $platform.Instructions
        if ([regex]::Matches($instructionText, [regex]::Escape($script:AgentGuidanceStartMarker)).Count -ne 1) {
          throw "전역 지침 관리 블록 개수 오류 ($($agentCase.Name)): $($platform.Instructions)"
        }
        foreach ($skillName in @('mnp-dooray', 'unity-work', 'pptx')) {
          if (-not (Test-MnPSuiteManagedSkill $platform.SkillsRoot $skillName)) {
            throw "전역 스킬 설치 검증 실패 ($($agentCase.Name)): $($platform.Name) $skillName"
          }
        }
      }
      if ($agentCase.CodexExists) {
        if ((Read-Utf8File (Join-Path $testCodexHome 'AGENTS.md')) -notmatch [regex]::Escape($codexOriginal)) {
          throw "Codex 기존 지침 보존 실패: $($agentCase.Name)"
        }
        $codexBackups = @(Get-ChildItem -LiteralPath $testCodexHome -File -Filter 'AGENTS.md.mnp-suite-backup-*.bak')
        if ($codexBackups.Count -ne 1 -or $codexBackups[0].Name -notmatch '^AGENTS\.md\.mnp-suite-backup-\d{8}-\d{9}(?:-\d+)?\.bak$') {
          throw "Codex 날짜 백업 파일명 검증 실패: $($agentCase.Name)"
        }
        if ((Read-Utf8File $codexBackups[0].FullName) -ne $codexOriginal) {
          throw "Codex 기존 지침 백업 검증 실패: $($agentCase.Name)"
        }
      }
      if ($agentCase.ClaudeExists) {
        if ((Read-Utf8File (Join-Path $testClaudeHome 'CLAUDE.md')) -notmatch [regex]::Escape($claudeOriginal)) {
          throw "Claude 기존 지침 보존 실패: $($agentCase.Name)"
        }
        $claudeBackups = @(Get-ChildItem -LiteralPath $testClaudeHome -File -Filter 'CLAUDE.md.mnp-suite-backup-*.bak')
        if ($claudeBackups.Count -ne 1 -or $claudeBackups[0].Name -notmatch '^CLAUDE\.md\.mnp-suite-backup-\d{8}-\d{9}(?:-\d+)?\.bak$') {
          throw "Claude 날짜 백업 파일명 검증 실패: $($agentCase.Name)"
        }
        if ((Read-Utf8File $claudeBackups[0].FullName) -ne $claudeOriginal) {
          throw "Claude 기존 지침 백업 검증 실패: $($agentCase.Name)"
        }
      }

      $backupCountsBeforeRerun = @{}
      foreach ($instructionsPath in @((Join-Path $testCodexHome 'AGENTS.md'), (Join-Path $testClaudeHome 'CLAUDE.md'))) {
        $backupCountsBeforeRerun[$instructionsPath] = @(Get-ChildItem -LiteralPath (Split-Path -Parent $instructionsPath) -File -Filter ((Split-Path -Leaf $instructionsPath) + '.mnp-suite-backup-*.bak')).Count
      }
      Install-MnPSuiteAgentConfiguration $testCodexHome $testClaudeHome $true $true | Out-Null
      foreach ($instructionsPath in @((Join-Path $testCodexHome 'AGENTS.md'), (Join-Path $testClaudeHome 'CLAUDE.md'))) {
        $instructionText = Read-Utf8File $instructionsPath
        if ([regex]::Matches($instructionText, [regex]::Escape($script:AgentGuidanceStartMarker)).Count -ne 1) {
          throw "전역 지침 재설치 멱등성 검증 실패 ($($agentCase.Name)): $instructionsPath"
        }
        $backupCountAfterRerun = @(Get-ChildItem -LiteralPath (Split-Path -Parent $instructionsPath) -File -Filter ((Split-Path -Leaf $instructionsPath) + '.mnp-suite-backup-*.bak')).Count
        if ($backupCountAfterRerun -ne $backupCountsBeforeRerun[$instructionsPath]) {
          throw "내용이 같은 재설치에서 불필요한 날짜 백업이 생성됨 ($($agentCase.Name)): $instructionsPath"
        }
      }
    }

    $changedGuidanceRoot = Join-Path $temporaryRoot 'agent-case-changed-guidance'
    $changedGuidanceCodex = Join-Path $changedGuidanceRoot '.codex'
    $changedGuidanceClaude = Join-Path $changedGuidanceRoot '.claude'
    Write-Utf8File (Join-Path $changedGuidanceCodex 'AGENTS.md') 'CODEX_BEFORE_FIRST_CHANGE'
    Write-Utf8File (Join-Path $changedGuidanceClaude 'CLAUDE.md') 'CLAUDE_BEFORE_FIRST_CHANGE'
    Install-MnPSuiteAgentConfiguration $changedGuidanceCodex $changedGuidanceClaude $false $false | Out-Null
    $codexAfterFirstChange = Read-Utf8File (Join-Path $changedGuidanceCodex 'AGENTS.md')
    $claudeAfterFirstChange = Read-Utf8File (Join-Path $changedGuidanceClaude 'CLAUDE.md')
    Install-MnPSuiteAgentConfiguration $changedGuidanceCodex $changedGuidanceClaude $true $true | Out-Null
    $changedGuidanceChecks = @(
      [pscustomobject]@{ Home = $changedGuidanceCodex; File = 'AGENTS.md'; Original = 'CODEX_BEFORE_FIRST_CHANGE'; AfterFirst = $codexAfterFirstChange },
      [pscustomobject]@{ Home = $changedGuidanceClaude; File = 'CLAUDE.md'; Original = 'CLAUDE_BEFORE_FIRST_CHANGE'; AfterFirst = $claudeAfterFirstChange }
    )
    foreach ($backupCheck in $changedGuidanceChecks) {
      $backups = @(Get-ChildItem -LiteralPath $backupCheck.Home -File -Filter ($backupCheck.File + '.mnp-suite-backup-*.bak'))
      if ($backups.Count -ne 2) { throw "전역 지침 변경별 날짜 백업 개수 오류: $($backupCheck.File)" }
      $backupContents = @($backups | ForEach-Object { Read-Utf8File $_.FullName })
      if ($backupContents -notcontains $backupCheck.Original -or $backupContents -notcontains $backupCheck.AfterFirst) {
        throw "전역 지침 변경별 복원 원문 보존 실패: $($backupCheck.File)"
      }
    }

    $emptyGuidanceRoot = Join-Path $temporaryRoot 'agent-case-empty-guidance'
    $emptyGuidanceCodex = Join-Path $emptyGuidanceRoot '.codex'
    $emptyGuidanceClaude = Join-Path $emptyGuidanceRoot '.claude'
    Write-Utf8File (Join-Path $emptyGuidanceCodex 'AGENTS.md') ''
    Write-Utf8File (Join-Path $emptyGuidanceClaude 'CLAUDE.md') ''
    Install-MnPSuiteAgentConfiguration $emptyGuidanceCodex $emptyGuidanceClaude $false $false | Out-Null
    foreach ($emptyInstructions in @((Join-Path $emptyGuidanceCodex 'AGENTS.md'), (Join-Path $emptyGuidanceClaude 'CLAUDE.md'))) {
      $emptyBackups = @(Get-ChildItem -LiteralPath (Split-Path -Parent $emptyInstructions) -File -Filter ((Split-Path -Leaf $emptyInstructions) + '.mnp-suite-backup-*.bak'))
      if ($emptyBackups.Count -ne 1 -or $emptyBackups[0].Length -ne 0) {
        throw "빈 전역 지침 파일의 날짜 백업 검증 실패: $emptyInstructions"
      }
    }

    $requiredOnlyRoot = Join-Path $temporaryRoot 'agent-case-required-only'
    $requiredOnlyCodex = Join-Path $requiredOnlyRoot '.codex'
    $requiredOnlyClaude = Join-Path $requiredOnlyRoot '.claude'
    $requiredOnlyResult = Install-MnPSuiteAgentConfiguration $requiredOnlyCodex $requiredOnlyClaude $false $false
    foreach ($platform in $requiredOnlyResult.Platforms) {
      if (-not (Test-MnPSuiteManagedSkill $platform.SkillsRoot 'mnp-dooray')) { throw '필수 mnp-dooray 설치 실패' }
      if (Test-Path -LiteralPath (Join-Path $platform.SkillsRoot 'unity-work')) { throw '선택하지 않은 unity-work가 설치됨' }
      if (Test-Path -LiteralPath (Join-Path $platform.SkillsRoot 'pptx')) { throw '선택하지 않은 pptx가 설치됨' }
      $instructionText = Read-Utf8File $platform.Instructions
      if ($instructionText -match '## Unity 작업') { throw '선택하지 않은 unity-work 전역 지침이 추가됨' }
      if ($instructionText -match '## PowerPoint 파일 확인') { throw '선택하지 않은 pptx 전역 지침이 추가됨' }
      if ($instructionText -notmatch '## MindNProgress·Dooray 작업') { throw '필수 mnp-dooray 전역 지침이 누락됨' }
    }

    $optionalSkillCases = @(
      [pscustomobject]@{ Name = 'unity-only'; IncludeUnity = $true; IncludePptx = $false },
      [pscustomobject]@{ Name = 'pptx-only'; IncludeUnity = $false; IncludePptx = $true }
    )
    foreach ($optionalCase in $optionalSkillCases) {
      $optionalRoot = Join-Path $temporaryRoot ("agent-case-" + $optionalCase.Name)
      $optionalResult = Install-MnPSuiteAgentConfiguration (Join-Path $optionalRoot '.codex') (Join-Path $optionalRoot '.claude') $optionalCase.IncludeUnity $optionalCase.IncludePptx
      foreach ($platform in $optionalResult.Platforms) {
        if (-not (Test-MnPSuiteManagedSkill $platform.SkillsRoot 'mnp-dooray')) { throw "선택 조합의 필수 mnp-dooray 누락: $($optionalCase.Name)" }
        if ((Test-MnPSuiteManagedSkill $platform.SkillsRoot 'unity-work') -ne $optionalCase.IncludeUnity) { throw "unity-work 선택 조합 오류: $($optionalCase.Name)" }
        if ((Test-MnPSuiteManagedSkill $platform.SkillsRoot 'pptx') -ne $optionalCase.IncludePptx) { throw "pptx 선택 조합 오류: $($optionalCase.Name)" }
        $instructionText = Read-Utf8File $platform.Instructions
        if (($instructionText -match '## Unity 작업') -ne $optionalCase.IncludeUnity) { throw "Unity 전역 지침 선택 조합 오류: $($optionalCase.Name)" }
        if (($instructionText -match '## PowerPoint 파일 확인') -ne $optionalCase.IncludePptx) { throw "PowerPoint 전역 지침 선택 조합 오류: $($optionalCase.Name)" }
      }
    }

    $removalRoot = Join-Path $temporaryRoot 'agent-case-option-removal'
    $removalCodex = Join-Path $removalRoot '.codex'
    $removalClaude = Join-Path $removalRoot '.claude'
    Install-MnPSuiteAgentConfiguration $removalCodex $removalClaude $true $true | Out-Null
    $removalResult = Install-MnPSuiteAgentConfiguration $removalCodex $removalClaude $false $false
    foreach ($platform in $removalResult.Platforms) {
      if (@($platform.RemovedSkills).Count -ne 2 -or
          $platform.RemovedSkills -notcontains 'unity-work' -or
          $platform.RemovedSkills -notcontains 'pptx') {
        throw "선택 해제 스킬 제거 결과 오류: $($platform.Name)"
      }
      foreach ($removedSkill in @('unity-work', 'pptx')) {
        if (Test-Path -LiteralPath (Join-Path $platform.SkillsRoot $removedSkill)) {
          throw "선택 해제한 패키지 관리 스킬 폴더가 남음: $($platform.Name) $removedSkill"
        }
      }
      if (-not (Test-MnPSuiteManagedSkill $platform.SkillsRoot 'mnp-dooray')) {
        throw "선택 해제 중 필수 mnp-dooray가 제거됨: $($platform.Name)"
      }
      $instructionText = Read-Utf8File $platform.Instructions
      if ($instructionText -match '## Unity 작업' -or $instructionText -match '## PowerPoint 파일 확인') {
        throw "선택 해제한 스킬의 전역 호출 지침이 남음: $($platform.Name)"
      }
      $instructionBackups = @(Get-ChildItem -LiteralPath (Split-Path -Parent $platform.Instructions) -File -Filter ((Split-Path -Leaf $platform.Instructions) + '.mnp-suite-backup-*.bak'))
      if ($instructionBackups.Count -ne 1) {
        throw "선택 해제 전 전역 지침 백업 개수 오류: $($platform.Name)"
      }
    }

    $modifiedRemovalRoot = Join-Path $temporaryRoot 'agent-case-modified-option-removal'
    $modifiedRemovalCodex = Join-Path $modifiedRemovalRoot '.codex'
    $modifiedRemovalClaude = Join-Path $modifiedRemovalRoot '.claude'
    Install-MnPSuiteAgentConfiguration $modifiedRemovalCodex $modifiedRemovalClaude $true $false | Out-Null
    $modifiedSkillPath = Join-Path $modifiedRemovalCodex 'skills\unity-work\SKILL.md'
    $modifiedSkillContent = (Read-Utf8File $modifiedSkillPath) + "`n사용자 수정 보존 검사"
    Write-Utf8File $modifiedSkillPath $modifiedSkillContent
    $modifiedRemovalBlocked = $false
    try {
      Install-MnPSuiteAgentConfiguration $modifiedRemovalCodex $modifiedRemovalClaude $false $false | Out-Null
    } catch {
      $modifiedRemovalBlocked = $true
    }
    if (-not $modifiedRemovalBlocked) { throw '설치 후 수정된 선택 스킬의 자동 제거를 차단하지 못함' }
    if ((Read-Utf8File $modifiedSkillPath) -ne $modifiedSkillContent) {
      throw '자동 제거가 차단된 선택 스킬의 사용자 수정 내용이 변경됨'
    }
    if (-not (Test-MnPSuiteManagedSkill (Join-Path $modifiedRemovalClaude 'skills') 'unity-work')) {
      throw '사전 검증 실패 전에 다른 플랫폼의 선택 스킬이 변경됨'
    }

    $conflictRoot = Join-Path $temporaryRoot 'agent-case-conflict'
    $conflictCodex = Join-Path $conflictRoot '.codex'
    $conflictSkill = Join-Path $conflictCodex 'skills\mnp-dooray'
    Write-Utf8File (Join-Path $conflictSkill 'SKILL.md') 'USER_OWNED_SKILL'
    $conflictDetected = $false
    try {
      Assert-MnPSuiteAgentConfigurationTargets $conflictCodex (Join-Path $conflictRoot '.claude') $false $false
    } catch {
      $conflictDetected = $true
    }
    if (-not $conflictDetected) { throw '사용자 소유 스킬 충돌을 감지하지 못함' }
    if ((Read-Utf8File (Join-Path $conflictSkill 'SKILL.md')) -ne 'USER_OWNED_SKILL') {
      throw '충돌한 사용자 소유 스킬이 변경됨'
    }

    $brokenGuidancePath = Join-Path $temporaryRoot 'agent-case-broken-markers\AGENTS.md'
    Write-Utf8File $brokenGuidancePath ($script:AgentGuidanceEndMarker + "`n" + $script:AgentGuidanceStartMarker)
    $brokenMarkersDetected = $false
    try {
      Assert-MnPSuiteManagedBlockTarget $brokenGuidancePath
    } catch {
      $brokenMarkersDetected = $true
    }
    if (-not $brokenMarkersDetected) { throw '손상된 전역 지침 관리 블록을 감지하지 못함' }

    $testDesktop = Join-Path $temporaryRoot 'Desktop'
    New-Item -ItemType Directory -Path $testDesktop -Force | Out-Null
    $shortcutPath = New-DesktopShortcut 'MnP-Suite-Dev-Start' (Join-Path $dev 'Start-All-Dev.bat') $temporaryRoot $testDesktop
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw 'ASCII 바탕화면 바로가기 생성 실패' }
    & $env:ComSpec /d /c "`"$compatibilityStop`""
    if ($LASTEXITCODE -ne 0) { throw "경로 공백을 포함한 중지 배치 실행 실패 (exit $LASTEXITCODE)" }
    Write-Host '[SelfTest] Dev launcher template validation passed.' -ForegroundColor Green
  } finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
      Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
  }
}

if ($SelfTest) {
  Invoke-SelfTest
  exit 0
}

$resolvedRoot = ''
try {
  Write-Host '============================================================' -ForegroundColor DarkCyan
  Write-Host ' MnP + AionUi + AionCore Git 개발 환경 설치' -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor DarkCyan

  $resolvedRoot = Resolve-InstallRoot
  Assert-SafeInstallRoot $resolvedRoot

  $agentHomes = Get-MnPSuiteAgentHomes
  $codexSkillsRoot = Join-Path $agentHomes.CodexHome 'skills'
  $claudeSkillsRoot = Join-Path $agentHomes.ClaudeHome 'skills'
  $existingUnityWork = (Test-MnPSuiteManagedSkill $codexSkillsRoot 'unity-work') -or
    (Test-MnPSuiteManagedSkill $claudeSkillsRoot 'unity-work')
  if ($NonInteractive) {
    $installUnityWork = [bool]$IncludeUnityWorkSkill -or $existingUnityWork
  } elseif ($existingUnityWork) {
    $installUnityWork = Read-YesNo 'unity-work 스킬이 이미 설치되어 있습니다. 계속 유지할까요?' $true
  } else {
    $installUnityWork = Read-YesNo 'Unity MCP를 사용하는 사용자를 위한 unity-work 스킬을 설치할까요?' ([bool]$IncludeUnityWorkSkill)
  }
  $existingPptx = (Test-MnPSuiteManagedSkill $codexSkillsRoot 'pptx') -or
    (Test-MnPSuiteManagedSkill $claudeSkillsRoot 'pptx')
  if ($NonInteractive) {
    $installPptx = [bool]$IncludePptxSkill -or $existingPptx
  } elseif ($existingPptx) {
    $installPptx = Read-YesNo 'pptx 스킬이 이미 설치되어 있습니다. 계속 유지할까요?' $true
  } else {
    $installPptx = Read-YesNo 'PowerPoint 파일 검토 사용자를 위한 pptx 스킬을 설치할까요?' ([bool]$IncludePptxSkill)
  }
  $existingOptionalMcps = @(Get-ExistingOptionalMcpSelections $resolvedRoot)
  $existingDoorayMcp = $existingOptionalMcps -contains 'dooray-mcp'
  $existingPptxMcp = $existingOptionalMcps -contains 'pptx-mcp'
  if ($NonInteractive) {
    $installDoorayMcp = [bool]$IncludeDoorayMcp -or $existingDoorayMcp
    $installPptxMcp = [bool]$IncludePptxMcp -or $existingPptxMcp
  } else {
    $doorayDefault = [bool]$IncludeDoorayMcp -or $existingDoorayMcp
    $pptxMcpDefault = [bool]$IncludePptxMcp -or $existingPptxMcp -or $installPptx
    $doorayQuestion = if ($existingDoorayMcp) { 'dooray-mcp가 이미 설치되어 있습니다. 계속 유지하고 갱신할까요?' } else { 'Dooray MCP를 Git 기반으로 설치하고 AionUi에 등록할까요?' }
    $pptxMcpQuestion = if ($existingPptxMcp) { 'pptx-mcp가 이미 설치되어 있습니다. 계속 유지하고 갱신할까요?' } else { 'PowerPoint MCP를 Git 기반으로 설치하고 AionUi에 등록할까요?' }
    $installDoorayMcp = Read-YesNo $doorayQuestion $doorayDefault
    $installPptxMcp = Read-YesNo $pptxMcpQuestion $pptxMcpDefault
  }
  $powerPointInstalled = [bool](Test-PowerPointInstalled)
  if ($installPptxMcp -and -not $powerPointInstalled) {
    Write-Warning 'Microsoft PowerPoint COM을 사용할 수 없어 슬라이드 PNG는 AionUi 기본 OfficeCLI HTML 렌더러로 대체합니다.'
  }
  Assert-MnPSuiteAgentConfigurationTargets $agentHomes.CodexHome $agentHomes.ClaudeHome $installUnityWork $installPptx

  Write-Host ''
  Write-Host '설치 계획' -ForegroundColor Cyan
  Write-Info "설치 루트    : $resolvedRoot"
  Write-Info "MindNProgress: $MindNProgressRepository ($MindNProgressBranch)"
  Write-Info "AionUi       : $AionUiRepository ($AionUiBranch)"
  Write-Info "AionCore     : $AionCoreRepository ($AionCoreBranch)"
  Write-Info "Dooray MCP   : $(if ($installDoorayMcp) { "$DoorayMcpRepository ($DoorayMcpBranch) 설치·AionUi 등록" } else { '설치 안 함' })"
  Write-Info "PowerPoint MCP: $(if ($installPptxMcp) { "$PptxMcpRepository ($PptxMcpBranch) 설치·AionUi 등록" } else { '설치 안 함' })"
  Write-Info 'Dev 실행 파일: <설치 루트>\dev'
  Write-Info '작업공간 구성: <설치 루트>\workspace-pool\workspaces.json (초기 비활성)'
  Write-Info '필수 전역 스킬: mnp-dooray (Claude Code + Codex)'
  Write-Info "Unity 전역 스킬: $(if ($installUnityWork) { 'unity-work 설치' } else { '설치 안 함' })"
  Write-Info "PowerPoint 전역 스킬: $(if ($installPptx) { 'pptx 설치' } else { '설치 안 함' })"
  if ($installPptx -or $installPptxMcp) {
    Write-Info "PPTX 렌더러 : $(if ($powerPointInstalled) { 'PowerPoint COM (1순위)' } else { 'OfficeCLI HTML fallback' })"
  }
  Write-Info "Codex 전역 구성: $($agentHomes.CodexHome)"
  Write-Info "Claude 전역 구성: $($agentHomes.ClaudeHome)"

  Write-Step 1 10 '필수 도구 확인'
  $prerequisites = @(Get-PrerequisiteState $installDoorayMcp $resolvedRoot)
  Show-PrerequisiteState $prerequisites
  $missing = @($prerequisites | Where-Object { -not $_.Ready })

  if ($PlanOnly) {
    if ($missing.Count -gt 0) {
      Write-Warning "누락 또는 지원 범위 밖 도구: $($missing.Key -join ', ')"
    }
    Write-Host ''
    Write-Host '[PlanOnly] 파일과 시스템을 변경하지 않았습니다.' -ForegroundColor Green
    exit 0
  }

  if (-not $NonInteractive -and -not (Read-YesNo '이 계획으로 설치를 진행할까요?' $true)) {
    throw '사용자가 설치를 취소했습니다.'
  }

  New-Item -ItemType Directory -Path $resolvedRoot -Force | Out-Null
  $logDirectory = Join-Path $resolvedRoot 'install-logs'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $script:InstallLogPath = Join-Path $logDirectory ("install-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
  Start-Transcript -LiteralPath $script:InstallLogPath | Out-Null
  $script:TranscriptStarted = $true
  Assert-MindNProgressStoppedForInstall $resolvedRoot

  if ($missing.Count -gt 0) {
    $autoInstall = [bool]$InstallMissingPrerequisites
    if (-not $autoInstall -and -not $NonInteractive) {
      $autoInstall = Read-YesNo '누락 도구를 준비할까요? 일반 도구는 winget, Dooray용 Java 21은 설치 루트의 portable JDK로 설치합니다.' $true
    }
    if (-not $autoInstall) {
      throw "필수 도구가 준비되지 않았습니다: $($missing.Key -join ', ')"
    }
    Install-PrerequisitePackages $missing $resolvedRoot
    $prerequisites = @(Get-PrerequisiteState $installDoorayMcp $resolvedRoot)
    Show-PrerequisiteState $prerequisites
    $missing = @($prerequisites | Where-Object { -not $_.Ready })
    if ($missing.Count -gt 0) {
      throw "도구 설치 후 현재 프로세스에서 확인되지 않는 항목이 있습니다: $($missing.Key -join ', '). Windows를 다시 시작하거나 새 터미널에서 설치 스크립트를 다시 실행하세요."
    }
  }

  Write-Step 2 10 'Git 저장소 준비'
  $mindNProgressPath = Join-Path $resolvedRoot 'MindNProgress'
  $aionUiPath = Join-Path $resolvedRoot 'AionUi'
  $aionCorePath = Join-Path $resolvedRoot 'AionCore'
  $doorayMcpPath = Join-Path $resolvedRoot 'dooray-mcp-server'
  $pptxMcpPath = Join-Path $resolvedRoot 'Office-PowerPoint-MCP-Server'
  $repositorySet = @(
    [pscustomobject]@{ Name = 'MindNProgress'; Path = $mindNProgressPath; Origin = $MindNProgressRepository; Branch = $MindNProgressBranch },
    [pscustomobject]@{ Name = 'AionUi'; Path = $aionUiPath; Origin = $AionUiRepository; Branch = $AionUiBranch },
    [pscustomobject]@{ Name = 'AionCore'; Path = $aionCorePath; Origin = $AionCoreRepository; Branch = $AionCoreBranch }
  )
  if ($installDoorayMcp) { $repositorySet += [pscustomobject]@{ Name = 'dooray-mcp'; Path = $doorayMcpPath; Origin = $DoorayMcpRepository; Branch = $DoorayMcpBranch } }
  if ($installPptxMcp) { $repositorySet += [pscustomobject]@{ Name = 'pptx-mcp'; Path = $pptxMcpPath; Origin = $PptxMcpRepository; Branch = $PptxMcpBranch } }
  Assert-RepositoryUpdateSet $repositorySet
  Install-GitRepository 'MindNProgress' $mindNProgressPath $MindNProgressRepository '' $MindNProgressBranch
  Install-GitRepository 'AionUi' $aionUiPath $AionUiRepository 'https://github.com/iOfficeAI/AionUi.git' $AionUiBranch
  Install-GitRepository 'AionCore' $aionCorePath $AionCoreRepository 'https://github.com/iOfficeAI/AionCore.git' $AionCoreBranch
  if ($installDoorayMcp) { Install-GitRepository 'dooray-mcp' $doorayMcpPath $DoorayMcpRepository '' $DoorayMcpBranch }
  if ($installPptxMcp) { Install-GitRepository 'pptx-mcp' $pptxMcpPath $PptxMcpRepository '' $PptxMcpBranch }
  $aionUiMcpBootstrap = Ensure-AionUiMindNProgressBootstrap $aionUiPath

  Write-Step 3 10 'JavaScript 의존성 설치'
  if ($SkipDependencyInstall) {
    Write-Warning 'SkipDependencyInstall이 지정되어 npm/bun 의존성 설치를 생략했습니다.'
  } else {
    Invoke-NativeCommand 'npm' @('ci') $mindNProgressPath 'MindNProgress npm ci'
    Invoke-NativeCommand 'bun' @('install', '--frozen-lockfile') $aionUiPath 'AionUi bun install --frozen-lockfile'
  }

  Write-Step 4 10 'AionCore release 빌드'
  if ($SkipAionCoreBuild) {
    Write-Warning 'SkipAionCoreBuild가 지정되어 AionCore 빌드를 생략했습니다.'
  } else {
    Invoke-NativeCommand 'cargo' @('build', '--release', '--locked', '--bin', 'aioncore') $aionCorePath 'AionCore cargo release build'
  }

  Write-Step 5 10 '선택 MCP Windows 런타임과 AionUi bootstrap 구성'
  $doorayRuntime = $null
  $pptxRuntime = $null
  if ($installDoorayMcp) { $doorayRuntime = Install-DoorayMcpRuntime $resolvedRoot $doorayMcpPath ([bool]$SkipDependencyInstall) }
  if ($installPptxMcp) { $pptxRuntime = Install-PptxMcpRuntime $pptxMcpPath ([bool]$SkipDependencyInstall) }
  $mcpBootstrap = Write-MnPSuiteMcpBootstrapConfig $resolvedRoot $doorayRuntime $pptxRuntime
  Write-Success "AionUi 선택 MCP bootstrap 구성: $($mcpBootstrap.Path)"

  Write-Step 6 10 '작업공간 템플릿과 Dev 실행 배치 생성'
  $workspacePool = Write-WorkspacePoolScaffold $resolvedRoot
  $devDirectory = Write-DevLaunchers $resolvedRoot
  Write-InstalledReadme $resolvedRoot
  $unityMcpGuidePath = Copy-UserGuides $resolvedRoot
  Write-Success "Dev 실행 파일 생성: $devDirectory"
  Write-Success "작업공간 템플릿 생성: $($workspacePool.Registry)"
  Write-Success "Unity MCP 및 Fork 가이드 복사: $unityMcpGuidePath"

  Write-Step 7 10 'Claude Code와 Codex 사용자 전역 구성'
  $agentConfiguration = Install-MnPSuiteAgentConfiguration $agentHomes.CodexHome $agentHomes.ClaudeHome $installUnityWork $installPptx
  foreach ($platform in $agentConfiguration.Platforms) {
    Write-Success "$($platform.Name) 지침 병합: $($platform.Instructions)"
    Write-Success "$($platform.Name) 스킬 설치: $($agentConfiguration.Skills -join ', ')"
    if ($platform.RemovedSkills.Count -gt 0) {
      Write-Success "$($platform.Name) 선택 해제 스킬 제거: $($platform.RemovedSkills -join ', ')"
    }
  }

  Write-Step 8 10 '설치 결과 검증'
  $requiredFiles = @(
    (Join-Path $mindNProgressPath 'package.json'),
    (Join-Path $aionUiPath 'package.json'),
    (Join-Path $aionCorePath 'Cargo.toml'),
    (Join-Path $devDirectory 'Start-All-Dev.bat'),
    (Join-Path $devDirectory 'Start-MindNProgress-Dev.ps1'),
    (Join-Path $devDirectory 'Backup-MindNProgress-Data.bat'),
    (Join-Path $devDirectory 'Restore-MindNProgress-Data.bat'),
    (Join-Path $resolvedRoot 'MindNProgress_Stop.bat'),
    (Join-Path $resolvedRoot 'MindNProgress_Launcher.cjs'),
    (Join-Path $resolvedRoot 'README_FIRST.md'),
    $mcpBootstrap.Path,
    $workspacePool.Registry,
    $workspacePool.Rules,
    $unityMcpGuidePath
  )
  foreach ($platform in $agentConfiguration.Platforms) {
    $requiredFiles += $platform.Instructions
    foreach ($skill in $platform.Skills) {
      $requiredFiles += Join-Path $skill.Path 'SKILL.md'
      $requiredFiles += Get-MnPSuiteManagedSkillMarker $skill.Path
    }
  }
  if (-not $SkipAionCoreBuild) {
    $requiredFiles += Join-Path $aionCorePath 'target\release\aioncore.exe'
  }
  if ($doorayRuntime) {
    $requiredFiles += $doorayRuntime.JavaPath
    $requiredFiles += $doorayRuntime.JarPath
    $requiredFiles += $doorayRuntime.LauncherPath
    $requiredFiles += $doorayRuntime.SecretPath
  }
  if ($pptxRuntime) {
    $requiredFiles += $pptxRuntime.PythonPath
    $requiredFiles += $pptxRuntime.ServerPath
  }
  foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      throw "설치 검증 파일이 없습니다: $requiredFile"
    }
  }
  $expectedMcpNames = @()
  if ($installDoorayMcp) { $expectedMcpNames += 'dooray-mcp' }
  if ($installPptxMcp) { $expectedMcpNames += 'pptx-mcp' }
  $mcpBootstrapJsonText = Read-Utf8File $mcpBootstrap.Path
  $mcpBootstrapJson = $mcpBootstrapJsonText | ConvertFrom-Json
  $actualMcpNames = @($mcpBootstrapJson.servers | ForEach-Object { [string]$_.name })
  if (@(Compare-Object $expectedMcpNames $actualMcpNames).Count -ne 0) {
    throw "AionUi 선택 MCP bootstrap 목록이 설치 선택과 다릅니다: $($actualMcpNames -join ', ')"
  }
  if ($mcpBootstrapJsonText -match 'DOORAY_API_KEY' -or $mcpBootstrapJsonText -match 'dooray-api-key\.dpapi') {
    throw 'AionUi 선택 MCP bootstrap에 Dooray 비밀 정보가 포함되었습니다.'
  }

  $repositoryManifest = @(
    (Get-RepositoryManifest 'MindNProgress' $mindNProgressPath $MindNProgressBranch $MindNProgressRepository),
    (Get-RepositoryManifest 'AionUi' $aionUiPath $AionUiBranch $AionUiRepository),
    (Get-RepositoryManifest 'AionCore' $aionCorePath $AionCoreBranch $AionCoreRepository)
  )
  if ($installDoorayMcp) { $repositoryManifest += Get-RepositoryManifest 'dooray-mcp' $doorayMcpPath $DoorayMcpBranch $DoorayMcpRepository }
  if ($installPptxMcp) { $repositoryManifest += Get-RepositoryManifest 'pptx-mcp' $pptxMcpPath $PptxMcpBranch $PptxMcpRepository }

  $manifest = [ordered]@{
    schemaVersion = 3
    installedAt = (Get-Date).ToString('o')
    installRoot = $resolvedRoot
    repositories = $repositoryManifest
    launchers = @(
      'dev\Start-All-Dev.bat',
      'dev\Start-MindNProgress-Dev.bat',
      'dev\Start-MindNProgress-Dev.ps1',
      'dev\Stop-MindNProgress-Dev.bat',
      'dev\Start-AionUi-Dev.bat',
      'dev\Rebuild-AionCore-Release.bat',
      'dev\Backup-MindNProgress-Data.bat',
      'dev\Restore-MindNProgress-Data.bat',
      'MindNProgress_Stop.bat',
      'MindNProgress_Launcher.cjs'
    )
    guides = @(
      'README_FIRST.md',
      'UNITY_MCP_AND_FORK_GUIDE.md'
    )
    workspacePool = [ordered]@{
      root = 'workspace-pool'
      registry = 'workspace-pool\workspaces.json'
      enabledByDefault = $false
    }
    aionUiMindNProgressMcpBootstrap = [ordered]@{
      source = $aionUiMcpBootstrap.Source
      overlayApplied = [bool]$aionUiMcpBootstrap.Applied
      environmentVariable = 'MINDNPROGRESS_MCP_ENTRY'
      enabled = $true
    }
    optionalMcpBootstrap = [ordered]@{
      source = $aionUiMcpBootstrap.Source
      overlayApplied = [bool]$aionUiMcpBootstrap.Applied
      environmentVariable = 'MNP_SUITE_MCP_CONFIG'
      configPath = $mcpBootstrap.Path
      selectedServers = $expectedMcpNames
      registrationTiming = 'next-aionui-start'
      dooraySecretStorage = if ($installDoorayMcp) { 'Windows DPAPI CurrentUser' } else { $null }
      powerPointInstalled = $powerPointInstalled
    }
    agentConfiguration = [ordered]@{
      scope = 'user-global'
      requiredSkills = @('mnp-dooray')
      selectedOptionalSkills = @($agentConfiguration.Skills | Where-Object { $_ -ne 'mnp-dooray' })
      platforms = @($agentConfiguration.Platforms | ForEach-Object {
        [ordered]@{
          name = $_.Name
          instructions = $_.Instructions
          instructionsBackup = $_.InstructionsBackup
          skillsRoot = $_.SkillsRoot
          skills = @($_.Skills | ForEach-Object { [ordered]@{ name = $_.Name; path = $_.Path } })
          removedSkills = @($_.RemovedSkills)
        }
      })
    }
    dependencyInstallSkipped = [bool]$SkipDependencyInstall
    aionCoreBuildSkipped = [bool]$SkipAionCoreBuild
  }
  Write-Utf8File (Join-Path $resolvedRoot 'installation-manifest.json') ($manifest | ConvertTo-Json -Depth 6)
  Write-Success '저장소, 실행 배치와 설치 manifest 검증 완료'

  Write-Step 9 10 '바탕화면 바로가기'
  $createShortcutsNow = [bool]$CreateDesktopShortcuts
  if (-not $createShortcutsNow -and -not $NonInteractive) {
    $createShortcutsNow = Read-YesNo '바탕화면에 전체 Dev 실행과 MnP 중지 바로가기를 만들까요?' $true
  }
  if ($createShortcutsNow) {
    try {
      New-DesktopShortcut 'MnP-Suite-Dev-Start' (Join-Path $devDirectory 'Start-All-Dev.bat') $resolvedRoot | Out-Null
      New-DesktopShortcut 'MindNProgress-Dev-Stop' (Join-Path $devDirectory 'Stop-MindNProgress-Dev.bat') $resolvedRoot | Out-Null
      Write-Success '바탕화면 바로가기 생성'
    } catch {
      Write-Warning "바탕화면 바로가기를 만들지 못했습니다. 설치는 완료 상태로 유지됩니다: $($_.Exception.Message)"
    }
  }

  Write-Step 10 10 '설치 완료'
  $selectedMcpSummary = if ($expectedMcpNames.Count -gt 0) { $expectedMcpNames -join ', ' } else { '없음' }
  $summary = @"
설치가 완료되었습니다.

설치 위치: $resolvedRoot
전체 실행: $devDirectory\Start-All-Dev.bat
MnP 주소: http://127.0.0.1:4175/
안내 문서: $resolvedRoot\README_FIRST.md
Unity 가이드: $unityMcpGuidePath
작업공간 구성: $($workspacePool.Registry) (초기 비활성)
전역 스킬: $($agentConfiguration.Skills -join ', ')
선택 MCP: $selectedMcpSummary
Codex 지침: $($agentHomes.CodexHome)\AGENTS.md
Claude 지침: $($agentHomes.ClaudeHome)\CLAUDE.md
설치 기록: $script:InstallLogPath

AionUi를 처음 열면 MindNProgress MCP와 선택한 MCP가 자동 등록됩니다. MnP의 AI 대화 시작 창을 다시 열어 `MindNProgress · 필수`와 선택 MCP 목록을 확인하세요.
"@
  Write-Host ''
  Write-Host $summary -ForegroundColor Green
  Show-InstallerMessage $summary 'MnP Suite 설치 완료' 'Information'

  if (-not $NoLaunchPrompt -and -not $NonInteractive -and (Read-YesNo '지금 MnP와 AionUi Dev를 실행할까요?' $true)) {
    Start-Process -FilePath (Join-Path $devDirectory 'Start-All-Dev.bat') -WorkingDirectory $resolvedRoot
  }
} catch {
  $message = $_.Exception.Message
  Write-Host ''
  Write-Host "[설치 실패] $message" -ForegroundColor Red
  if ($script:InstallLogPath) { Write-Host "설치 기록: $script:InstallLogPath" -ForegroundColor Yellow }
  Show-InstallerMessage "$message`n`n설치 기록: $script:InstallLogPath" 'MnP Suite 설치 실패' 'Error'
  exit 1
} finally {
  if ($script:TranscriptStarted) {
    Stop-Transcript | Out-Null
    $script:TranscriptStarted = $false
  }
}

exit 0
