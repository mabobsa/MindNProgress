param(
  [string]$Destination = $env:MNP_BACKUP_DIR,
  [string]$ProjectPath = '',
  # 기본 백업은 한 달 지난 문서 이력을 문서·날짜별 마지막 1개만 담는다. 전체 이력이 필요할 때만 지정한다.
  [switch]$KeepAllHistory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-FullPath([string]$Path, [string]$BasePath) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Test-PathInside([string]$Path, [string]$ParentPath) {
  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $fullParent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd('\', '/')
  return $fullPath.StartsWith(
    $fullParent + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Test-PathSameOrInside([string]$Path, [string]$ParentPath) {
  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $fullParent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd('\', '/')
  return $fullPath.Equals(
    $fullParent,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -or (Test-PathInside $fullPath $fullParent)
}

function Remove-SafeDirectory([string]$Path, [string]$AllowedRoot) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (-not (Test-PathInside $Path $AllowedRoot)) {
    throw "임시 폴더가 허용 범위를 벗어나 삭제하지 않았습니다: $Path"
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Get-RelativeFilePath([string]$FilePath, [string]$RootPath) {
  $fullFile = [System.IO.Path]::GetFullPath($FilePath)
  $fullRoot = [System.IO.Path]::GetFullPath($RootPath).TrimEnd('\', '/')
  if (-not (Test-PathInside $fullFile $fullRoot)) {
    throw "파일이 기준 폴더 밖에 있습니다: $fullFile"
  }
  return $fullFile.Substring($fullRoot.Length).TrimStart('\', '/').Replace('\', '/')
}

function Test-MindNProgressRunning([string]$ProjectRoot) {
  $escapedProject = [Regex]::Escape(
    [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
  )
  $connections = Get-NetTCPConnection -State Listen -LocalPort 4175, 4176 -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter (
      'ProcessId = ' + $connection.OwningProcess
    ) -ErrorAction SilentlyContinue
    if ($process.CommandLine -and $process.CommandLine -match $escapedProject) {
      return $true
    }
  }
  return $false
}

function Stop-MindNProgress([string]$WorkspaceRoot) {
  $stopScript = @(
    (Join-Path $WorkspaceRoot 'MindNProgress_Stop.bat'),
    (Join-Path $WorkspaceRoot 'dev\Stop-MindNProgress-Dev.bat')
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $stopScript) {
    throw "일관된 백업을 위해 서버를 중지해야 하지만 지원하는 중지 배치를 찾지 못했습니다: $WorkspaceRoot"
  }
  & $stopScript
  if ($LASTEXITCODE -ne 0) {
    throw "MindNProgress 서버를 중지하지 못했습니다."
  }
}

# 작업 스케줄러에 상시 실행 작업(\MindNProgress)이 등록된 설치는 서버 수명 주기를 공통 제어 스크립트(mnp-runtime.ps1)가 맡는다.
# 그 경우 스크립트 경로를, 등록 작업이 없는 설치(설치기 Suite·개발 PC 등)는 빈 문자열을 돌려준다. 빈 문자열이면 기존 런처로 시작한다.
function Get-MindNProgressRuntimeScript([string]$ProjectRoot) {
  $runtimeScript = Join-Path $ProjectRoot 'scripts\mnp-runtime.ps1'
  if (-not (Test-Path -LiteralPath $runtimeScript -PathType Leaf)) { return '' }
  $task = Get-ScheduledTask -TaskName 'MindNProgress' -TaskPath '\' -ErrorAction SilentlyContinue
  if ($null -eq $task) { return '' }
  return $runtimeScript
}

function Start-MindNProgress([string]$WorkspaceRoot, [string]$RuntimeScript) {
  if ($RuntimeScript) {
    # 등록 작업이 관리하는 서버는 런처로 대신 띄우지 않는다. 시작에 실패하면 그대로 실패를 알린다.
    # mnp-runtime.ps1은 실패하면 exit 1로 끝나므로 이 스크립트가 함께 끝나지 않도록 별도 프로세스로 실행하고 종료 코드로 판정한다.
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $RuntimeScript -Action start
    if ($LASTEXITCODE -ne 0) {
      throw "mnp-runtime.ps1로 MindNProgress 서버를 시작하지 못했습니다(종료 코드 $LASTEXITCODE). 런처를 직접 실행하지 않았습니다."
    }
    return
  }

  $launcher = Join-Path $WorkspaceRoot 'MindNProgress_Launcher.cjs'
  if (Test-Path -LiteralPath $launcher -PathType Leaf) {
    Start-Process -FilePath 'node.exe' -ArgumentList ('"' + $launcher + '"') `
      -WorkingDirectory $WorkspaceRoot -WindowStyle Hidden
    return
  }

  $suiteLauncher = Join-Path $WorkspaceRoot 'dev\Start-MindNProgress-Dev.bat'
  if (Test-Path -LiteralPath $suiteLauncher -PathType Leaf) {
    $commandProcessor = if ($env:ComSpec) { $env:ComSpec } else { Join-Path $env:SystemRoot 'System32\cmd.exe' }
    Start-Process -FilePath $commandProcessor -ArgumentList @('/d', '/c', ('"' + $suiteLauncher + '"')) `
      -WorkingDirectory $WorkspaceRoot -WindowStyle Hidden
    return
  }

  throw "백업 전 실행 상태를 복구할 실행 파일을 찾지 못했습니다: $WorkspaceRoot"
}

function Wait-MindNProgress([int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 300
    try {
      $webStatus = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4175/' -TimeoutSec 2).StatusCode
      $apiStatus = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4176/api/health' -TimeoutSec 2).StatusCode
      if ($webStatus -eq 200 -and $apiStatus -eq 200) { return }
    } catch {
      # 서버가 준비될 때까지 다시 확인합니다.
    }
  } while ((Get-Date) -lt $deadline)
  throw "백업 후 MindNProgress 서버가 제한 시간 안에 다시 시작되지 않았습니다."
}

function Get-GitValue([string]$ProjectRoot, [string[]]$Arguments) {
  try {
    $value = & git -C $ProjectRoot @Arguments 2>$null
    if ($LASTEXITCODE -eq 0) { return (($value | Out-String).Trim()) }
  } catch {
    # Git 정보는 백업 메타데이터용이므로 실패해도 백업은 계속합니다.
  }
  return ''
}

function Write-Utf8File([string]$Path, [string]$Content) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hash = $sha256.ComputeHash($stream)
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
  return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

# 문서 이력 파일의 저장 시각. 이력 ID 앞부분은 저장 시각(밀리초)의 36진수이고, 형식이 다르면 파일 앞부분의 archivedAt을 읽는다.
# 시각을 알 수 없으면 $null을 돌려주며, 호출 측은 그 파일을 그대로 백업한다.
function Get-HistoryRevisionTime([System.IO.FileInfo]$File) {
  if ($File.Name -cmatch '^([0-9a-z]{6,12})-[0-9a-f]+\.json$') {
    $digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    [long]$milliseconds = 0
    foreach ($character in $Matches[1].ToCharArray()) { $milliseconds = $milliseconds * 36 + $digits.IndexOf($character) }
    # 2020-01-01 ~ 2100-01-01 밖이면 이력 ID 형식이 아닌 것으로 보고 파일 앞부분을 읽는다.
    if ($milliseconds -ge 1577836800000 -and $milliseconds -lt 4102444800000) {
      return [DateTimeOffset]::FromUnixTimeMilliseconds($milliseconds)
    }
  }
  if ($File.Extension -ne '.json') { return $null }
  try {
    $stream = $File.OpenRead()
    try {
      $buffer = New-Object byte[] 4096
      $read = $stream.Read($buffer, 0, $buffer.Length)
    } finally {
      $stream.Dispose()
    }
    $head = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    if ($head -match '"archivedAt"\s*:\s*"([^"]+)"') {
      $parsed = [DateTimeOffset]::MinValue
      if ([DateTimeOffset]::TryParse($Matches[1], [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
        return $parsed
      }
    }
  } catch {
    # 읽지 못한 파일은 시각을 모르는 파일로 보고 그대로 백업한다.
  }
  return $null
}

# 백업 사본의 문서 이력(_history)을 복사한다. 기준 시각보다 오래된 이력은 문서·날짜(KST)별로 가장 늦게 저장된 1개만 복사하고,
# 기준 시각 이후 이력, 시각을 알 수 없는 파일, 이력 형식이 아닌 하위 폴더는 모두 복사한다. 운영 데이터는 읽기만 한다.
function Copy-BackupHistory([string]$Source, [string]$Destination, [DateTimeOffset]$Cutoff, [bool]$KeepAll) {
  $summary = [ordered]@{
    mode = $(if ($KeepAll) { 'all' } else { 'daily-latest-before-cutoff' })
    cutoff = $Cutoff.ToString('o')
    rule = $(if ($KeepAll) { '문서 이력(server/data/_history)을 모두 포함했습니다.' }
      else { '기준 시각보다 오래된 문서 이력(server/data/_history)은 문서·날짜(KST)별로 가장 늦게 저장된 1개만 포함했습니다. 기준 시각 이후 이력과 이력 밖의 파일은 모두 포함했습니다.' })
    totalFiles = 0
    totalBytes = [long]0
    olderFiles = 0
    includedFiles = 0
    includedBytes = [long]0
    excludedFiles = 0
    excludedBytes = [long]0
  }
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return $summary }
  if ($KeepAll) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
    foreach ($file in @(Get-ChildItem -LiteralPath $Source -Recurse -Force -File)) {
      $summary.totalFiles += 1
      $summary.totalBytes += [long]$file.Length
    }
    $summary.includedFiles = $summary.totalFiles
    $summary.includedBytes = $summary.totalBytes
    return $summary
  }

  $kst = [TimeSpan]::FromHours(9)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  foreach ($entry in @(Get-ChildItem -LiteralPath $Source -Force)) {
    if (-not $entry.PSIsContainer) {
      Copy-Item -LiteralPath $entry.FullName -Destination $Destination -Force
      $summary.totalFiles += 1
      $summary.totalBytes += [long]$entry.Length
      $summary.includedFiles += 1
      $summary.includedBytes += [long]$entry.Length
      continue
    }
    $targetDirectory = Join-Path $Destination $entry.Name
    New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
    foreach ($child in @(Get-ChildItem -LiteralPath $entry.FullName -Force -Directory)) {
      Copy-Item -LiteralPath $child.FullName -Destination $targetDirectory -Recurse -Force
      foreach ($nested in @(Get-ChildItem -LiteralPath $child.FullName -Recurse -Force -File)) {
        $summary.totalFiles += 1
        $summary.totalBytes += [long]$nested.Length
        $summary.includedFiles += 1
        $summary.includedBytes += [long]$nested.Length
      }
    }
    $files = @(Get-ChildItem -LiteralPath $entry.FullName -Force -File)
    $times = @{}
    $latestByDay = @{}
    foreach ($file in $files) {
      $time = Get-HistoryRevisionTime $file
      $times[$file.Name] = $time
      if ($null -eq $time -or $time -ge $Cutoff) { continue }
      $day = $time.ToOffset($kst).ToString('yyyy-MM-dd')
      if (-not $latestByDay.ContainsKey($day) -or $latestByDay[$day].Time -lt $time) {
        $latestByDay[$day] = @{ Name = $file.Name; Time = $time }
      }
    }
    $keptOlder = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($latest in $latestByDay.Values) { $null = $keptOlder.Add($latest.Name) }
    foreach ($file in $files) {
      $summary.totalFiles += 1
      $summary.totalBytes += [long]$file.Length
      $time = $times[$file.Name]
      $older = $null -ne $time -and $time -lt $Cutoff
      if ($older) { $summary.olderFiles += 1 }
      if ($older -and -not $keptOlder.Contains($file.Name)) {
        $summary.excludedFiles += 1
        $summary.excludedBytes += [long]$file.Length
        continue
      }
      [System.IO.File]::Copy($file.FullName, (Join-Path $targetDirectory $file.Name), $true)
      $summary.includedFiles += 1
      $summary.includedBytes += [long]$file.Length
    }
  }
  return $summary
}

function Test-BackupArchive([string]$Path) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $archiveEntries = New-Object 'System.Collections.Generic.Dictionary[string, System.IO.Compression.ZipArchiveEntry]' (
      [System.StringComparer]::Ordinal
    )
    foreach ($archiveEntry in $archive.Entries) {
      $relativePath = $archiveEntry.FullName.Replace('\', '/')
      if ($archiveEntries.ContainsKey($relativePath)) {
        throw "백업 파일 경로가 중복됩니다: $relativePath"
      }
      $archiveEntries.Add($relativePath, $archiveEntry)
    }
    if (-not $archiveEntries.ContainsKey('manifest.json')) {
      throw "백업 검증에 필요한 manifest.json이 없습니다."
    }
    $reader = New-Object System.IO.StreamReader($archiveEntries['manifest.json'].Open())
    try {
      $manifest = $reader.ReadToEnd() | ConvertFrom-Json
    } finally {
      $reader.Dispose()
    }

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      foreach ($entry in $manifest.files) {
        $relativePath = ([string]$entry.path).Replace('\', '/')
        if (-not $archiveEntries.ContainsKey($relativePath)) {
          throw "백업 파일이 누락되었습니다: $relativePath"
        }
        $file = $archiveEntries[$relativePath]
        if ([long]$file.Length -ne [long]$entry.size) {
          throw "백업 파일 크기가 일치하지 않습니다: $relativePath"
        }
        $stream = $file.Open()
        try {
          $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
          $stream.Dispose()
        }
        if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) {
          throw "백업 파일 해시가 일치하지 않습니다: $relativePath"
        }
      }
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $archive.Dispose()
  }
}

$resolvedProject = if ($ProjectPath) {
  Get-FullPath $ProjectPath (Get-Location).Path
} else {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedProject '..'))
$dataSourceValue = if ($env:MNP_DATA_DIR) { $env:MNP_DATA_DIR } else { 'server\data' }
$dataSource = Get-FullPath $dataSourceValue $resolvedProject
$imageAssetCleanupScript = Join-Path $resolvedProject 'scripts\cleanup-image-assets.mjs'
$backupRootValue = if ($Destination) { $Destination } else { Join-Path $workspaceRoot 'MindNProgress_Backup' }
$backupRoot = Get-FullPath $backupRootValue $resolvedProject

if (-not (Test-Path -LiteralPath $dataSource -PathType Container)) {
  throw "백업할 MindNProgress 데이터 폴더를 찾지 못했습니다: $dataSource"
}
if (-not (Test-Path -LiteralPath $imageAssetCleanupScript -PathType Leaf)) {
  throw "이미지 자산 정리 스크립트를 찾지 못했습니다: $imageAssetCleanupScript"
}
$backupDrive = [System.IO.Path]::GetPathRoot($backupRoot)
if (-not $backupDrive -or -not (Test-Path -LiteralPath $backupDrive -PathType Container)) {
  throw "백업 드라이브를 사용할 수 없습니다: $backupDrive"
}
if (Test-PathSameOrInside $backupRoot $dataSource) {
  throw "백업 폴더를 데이터 폴더 내부에 둘 수 없습니다: $backupRoot"
}
if (Test-PathSameOrInside $backupRoot $resolvedProject) {
  throw "백업 폴더를 Git 저장소 내부에 둘 수 없습니다: $backupRoot"
}

$dateText = Get-Date -Format 'yyyy-MM-dd'
$timeText = Get-Date -Format 'HHmmss'
$dateDirectory = Join-Path $backupRoot $dateText
New-Item -ItemType Directory -Force -Path $dateDirectory | Out-Null

$archiveBaseName = "MindNProgress_${dateText}_${timeText}"
$archivePath = Join-Path $dateDirectory ($archiveBaseName + '.zip')
$sequence = 1
while (Test-Path -LiteralPath $archivePath) {
  $archivePath = Join-Path $dateDirectory (
    $archiveBaseName + '-' + $sequence.ToString('00') + '.zip'
  )
  $sequence += 1
}

# 문서 이력 보관 기준: 백업 날짜(KST)의 한 달 전 00:00. 그보다 오래된 이력은 문서·날짜별 마지막 1개만 백업한다.
$keepAllHistory = $KeepAllHistory.IsPresent -or $env:MNP_BACKUP_KEEP_ALL_HISTORY -eq '1'
$kstOffset = [TimeSpan]::FromHours(9)
$kstNow = [DateTimeOffset]::UtcNow.ToOffset($kstOffset)
$historyCutoff = (New-Object DateTimeOffset ($kstNow.Year, $kstNow.Month, $kstNow.Day, 0, 0, 0, $kstOffset)).AddMonths(-1)

$operationId = [Guid]::NewGuid().ToString('N')
$stagingDirectory = Join-Path $dateDirectory ('.staging-' + $operationId)
$partialArchive = $archivePath + '.partial.zip'
$wasRunning = Test-MindNProgressRunning $resolvedProject
# 다시 시작할 경로는 서버를 중지하기 전에 정한다. 판정이 실패하면 서버를 멈추지 않은 채 끝난다.
$runtimeControlScript = if ($wasRunning) { Get-MindNProgressRuntimeScript $resolvedProject } else { '' }
$backupCompleted = $false
$serverRestored = $false

try {
  if ($wasRunning) {
    Write-Output '[MindNProgress] 일관된 백업을 위해 서버를 잠시 중지합니다.'
    if ($runtimeControlScript) {
      Write-Output '[MindNProgress] 다시 시작은 작업 스케줄러 등록 작업(\MindNProgress)을 mnp-runtime.ps1 -Action start로 실행합니다.'
    }
    Stop-MindNProgress $workspaceRoot
  }

  New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null
  $payloadData = Join-Path $stagingDirectory 'server\data'
  New-Item -ItemType Directory -Force -Path $payloadData | Out-Null
  # 문서 이력(_history)은 보관 기준에 맞는 파일만 따로 복사하고, 나머지는 기존처럼 통째로 복사한다.
  foreach ($dataEntry in @(Get-ChildItem -LiteralPath $dataSource -Force)) {
    if ($dataEntry.PSIsContainer -and $dataEntry.Name -eq '_history') { continue }
    Copy-Item -LiteralPath $dataEntry.FullName -Destination $payloadData -Recurse -Force
  }
  $historyRetention = Copy-BackupHistory (Join-Path $dataSource '_history') (Join-Path $payloadData '_history') $historyCutoff $keepAllHistory
  if ($keepAllHistory) {
    Write-Output ('[MindNProgress] 문서 이력 {0}개를 모두 백업에 포함합니다.' -f $historyRetention.totalFiles)
  } else {
    Write-Output ('[MindNProgress] {0} 이전 문서 이력 {1}개 중 {2}개({3:N0}MB)를 백업에서 제외했습니다. 문서·날짜별 마지막 이력은 남깁니다.' -f
      $historyCutoff.ToString('yyyy-MM-dd HH:mm zzz'), $historyRetention.olderFiles, $historyRetention.excludedFiles, ($historyRetention.excludedBytes / 1MB))
  }

  $localConfigDirectory = Join-Path $stagingDirectory 'local-config'
  $localConfigFiles = @(
    Get-ChildItem -LiteralPath $resolvedProject -Force -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq '.env' -or $_.Name -like '.env.*' -or $_.Name -like '*.local' }
  )
  if ($localConfigFiles.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $localConfigDirectory | Out-Null
    foreach ($configFile in $localConfigFiles) {
      Copy-Item -LiteralPath $configFile.FullName -Destination (
        Join-Path $localConfigDirectory $configFile.Name
      )
    }
  }

  if ($wasRunning) {
    Write-Output '[MindNProgress] 스냅샷 복사가 끝나 서버를 먼저 다시 시작합니다.'
    Start-MindNProgress $workspaceRoot $runtimeControlScript
    Wait-MindNProgress
    $serverRestored = $true
  }

  $commit = Get-GitValue $resolvedProject @('rev-parse', 'HEAD')
  $branch = Get-GitValue $resolvedProject @('branch', '--show-current')
  $gitStatus = Get-GitValue $resolvedProject @('status', '--porcelain')
  $restoreGuide = @"
MindNProgress 전체 데이터 백업

생성 시각: $((Get-Date).ToString('o'))
Git 커밋: $commit
문서 이력: $($historyRetention.rule)$(if (-not $keepAllHistory) { " 기준 시각: $($historyRetention.cutoff). 포함 $($historyRetention.includedFiles)개, 제외 $($historyRetention.excludedFiles)개." })

권장 복원 방법
1. 이 백업을 만든 소스와 동일한 MindNProgress 버전을 준비합니다.
2. 저장소의 MindNProgress_Restore.bat에 이 ZIP 파일을 첫 번째 인자로 전달합니다.
3. 복원 배치가 manifest.json의 크기와 SHA-256을 검증한 뒤 server\data를 교체합니다.
4. 복원 전 서버가 실행 중이었다면 작업 후 자동으로 다시 시작합니다.

수동 복원
1. MindNProgress를 중지합니다.
2. ZIP의 server\data를 프로젝트의 server\data 위치에 그대로 복사합니다.
3. local-config가 있으면 필요한 파일만 프로젝트 루트에 복사합니다.
4. MindNProgress를 다시 시작합니다.

주의: 이 백업에는 계정, 세션, MCP 토큰이 포함되므로 외부에 공유하지 마세요.
데이터 마이그레이션은 수행하지 않으므로 다른 버전으로 복원하는 것은 보장하지 않습니다.
"@
  Write-Utf8File (Join-Path $stagingDirectory 'RESTORE.txt') $restoreGuide

  $payloadFiles = @(
    Get-ChildItem -LiteralPath $stagingDirectory -Recurse -Force -File
  )
  $totalBytes = [long]0
  $fileEntries = @(
    foreach ($file in $payloadFiles) {
      $relativePath = Get-RelativeFilePath $file.FullName $stagingDirectory
      $totalBytes += [long]$file.Length
      [ordered]@{
        path = $relativePath
        size = [long]$file.Length
        sha256 = Get-Sha256 $file.FullName
      }
    }
  )
  $manifest = [ordered]@{
    formatVersion = 1
    product = 'MindNProgress'
    createdAt = (Get-Date).ToString('o')
    sourceCommit = $commit
    sourceBranch = $branch
    sourceDirty = [bool]$gitStatus
    sourceDataPath = $dataSource
    historyRetention = $historyRetention
    fileCount = $fileEntries.Count
    totalBytes = $totalBytes
    files = $fileEntries
  }
  Write-Utf8File (Join-Path $stagingDirectory 'manifest.json') (
    ($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine
  )

  Write-Output '[MindNProgress] 스냅샷을 Fastest 수준으로 압축합니다.'
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stagingDirectory,
    $partialArchive,
    [System.IO.Compression.CompressionLevel]::Fastest,
    $false
  )

  Write-Output '[MindNProgress] ZIP 내부 파일의 크기와 SHA-256을 검증합니다.'
  Test-BackupArchive $partialArchive
  Move-Item -LiteralPath $partialArchive -Destination $archivePath
  $backupCompleted = $true

  if ($wasRunning) {
    Write-Output '[MindNProgress] 미참조 이미지 자산 정리를 위해 서버를 잠시 중지합니다.'
    $serverRestored = $false
    Stop-MindNProgress $workspaceRoot
  }
  try {
    & node.exe $imageAssetCleanupScript --data-dir $dataSource
    if ($LASTEXITCODE -ne 0) {
      throw "미참조 이미지 자산을 정리하지 못했습니다."
    }
  } finally {
    if ($wasRunning -and -not $serverRestored) {
      Write-Output '[MindNProgress] 이미지 자산 정리가 끝나 서버를 다시 시작합니다.'
      Start-MindNProgress $workspaceRoot $runtimeControlScript
      Wait-MindNProgress
      $serverRestored = $true
    }
  }

  $archive = Get-Item -LiteralPath $archivePath
  Write-Output "[MindNProgress] 백업 완료: $archivePath"
  Write-Output "[MindNProgress] 파일 $($fileEntries.Count)개, 원본 $totalBytes 바이트, ZIP $($archive.Length) 바이트"
} finally {
  Remove-SafeDirectory $stagingDirectory $backupRoot
  if ((Test-Path -LiteralPath $partialArchive) -and (Test-PathInside $partialArchive $backupRoot)) {
    Remove-Item -LiteralPath $partialArchive -Force
  }
  if ($wasRunning -and -not $serverRestored) {
    Write-Output '[MindNProgress] 백업 전 실행 상태로 서버를 복구합니다.'
    if (-not (Test-MindNProgressRunning $resolvedProject)) {
      Start-MindNProgress $workspaceRoot $runtimeControlScript
    }
    Wait-MindNProgress
  }
}

if (-not $backupCompleted) {
  throw "MindNProgress 백업이 완료되지 않았습니다."
}
