param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,
  [string]$ProjectPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

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

function Remove-SafeDirectory([string]$Path, [string]$AllowedRoot) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (-not (Test-PathInside $Path $AllowedRoot)) {
    throw "임시 폴더가 허용 범위를 벗어나 삭제하지 않았습니다: $Path"
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
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
    throw "복원을 위해 서버를 중지해야 하지만 지원하는 중지 배치를 찾지 못했습니다: $WorkspaceRoot"
  }
  & $stopScript
  if ($LASTEXITCODE -ne 0) {
    throw "MindNProgress 서버를 중지하지 못했습니다."
  }
}

function Start-MindNProgress([string]$WorkspaceRoot) {
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

  throw "복원 전 실행 상태를 되돌릴 실행 파일을 찾지 못했습니다: $WorkspaceRoot"
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
  throw "복원 후 MindNProgress 서버가 제한 시간 안에 다시 시작되지 않았습니다."
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

function Test-BackupPayload([string]$ExtractedRoot) {
  $manifestPath = Join-Path $ExtractedRoot 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "백업에 manifest.json이 없습니다."
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$manifest.formatVersion -ne 1 -or [string]$manifest.product -ne 'MindNProgress') {
    throw "지원하지 않는 MindNProgress 백업 형식입니다."
  }
  foreach ($entry in $manifest.files) {
    $relativePath = [string]$entry.path
    $filePath = Join-Path $ExtractedRoot ($relativePath.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      throw "백업 파일이 누락되었습니다: $relativePath"
    }
    $file = Get-Item -LiteralPath $filePath
    if ([long]$file.Length -ne [long]$entry.size) {
      throw "백업 파일 크기가 일치하지 않습니다: $relativePath"
    }
    $hash = Get-Sha256 $filePath
    if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) {
      throw "백업 파일 해시가 일치하지 않습니다: $relativePath"
    }
  }
  return $manifest
}

$resolvedProject = if ($ProjectPath) {
  Get-FullPath $ProjectPath (Get-Location).Path
} else {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
$resolvedArchive = Get-FullPath $ArchivePath (Get-Location).Path
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedProject '..'))
$dataTargetValue = if ($env:MNP_DATA_DIR) { $env:MNP_DATA_DIR } else { 'server\data' }
$dataTarget = Get-FullPath $dataTargetValue $resolvedProject

if (-not (Test-Path -LiteralPath $resolvedArchive -PathType Leaf)) {
  throw "복원할 ZIP 파일을 찾지 못했습니다: $resolvedArchive"
}
if ([System.IO.Path]::GetExtension($resolvedArchive) -ne '.zip') {
  throw "MindNProgress ZIP 백업만 복원할 수 있습니다."
}

$temporaryRoot = [System.IO.Path]::GetFullPath((Join-Path (
  [System.IO.Path]::GetTempPath()
) ('MindNProgress-Restore-' + [Guid]::NewGuid().ToString('N'))))
$newDataDirectory = Join-Path (Split-Path $dataTarget -Parent) (
  '.data-restore-new-' + [Guid]::NewGuid().ToString('N')
)
$rollbackDirectory = Join-Path (Join-Path $workspaceRoot '.mindnprogress') (
  'pre-restore-data-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
)
$wasRunning = Test-MindNProgressRunning $resolvedProject
$currentDataMoved = $false
$newDataInstalled = $false

try {
  New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
  Expand-Archive -LiteralPath $resolvedArchive -DestinationPath $temporaryRoot -Force
  $manifest = Test-BackupPayload $temporaryRoot
  $payloadData = Join-Path $temporaryRoot 'server\data'
  if (-not (Test-Path -LiteralPath $payloadData -PathType Container)) {
    throw "백업에 server\data 폴더가 없습니다."
  }

  if ($wasRunning) {
    Write-Output '[MindNProgress] 일관된 복원을 위해 서버를 잠시 중지합니다.'
    Stop-MindNProgress $workspaceRoot
  }

  Copy-Item -LiteralPath $payloadData -Destination $newDataDirectory -Recurse -Force
  if (Test-Path -LiteralPath $dataTarget) {
    New-Item -ItemType Directory -Force -Path (Split-Path $rollbackDirectory -Parent) | Out-Null
    Move-Item -LiteralPath $dataTarget -Destination $rollbackDirectory
    $currentDataMoved = $true
  }
  Move-Item -LiteralPath $newDataDirectory -Destination $dataTarget
  $newDataInstalled = $true

  $localConfigDirectory = Join-Path $temporaryRoot 'local-config'
  if (Test-Path -LiteralPath $localConfigDirectory -PathType Container) {
    Get-ChildItem -LiteralPath $localConfigDirectory -Force -File | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (
        Join-Path $resolvedProject $_.Name
      ) -Force
    }
  }

  Write-Output "[MindNProgress] 복원 완료: $resolvedArchive"
  Write-Output "[MindNProgress] 백업 생성 시각: $($manifest.createdAt)"
  Write-Output "[MindNProgress] 백업 Git 커밋: $($manifest.sourceCommit)"
  if ($currentDataMoved) {
    Write-Output "[MindNProgress] 복원 전 데이터 보관: $rollbackDirectory"
  }
} catch {
  if ($currentDataMoved -and -not $newDataInstalled -and (Test-Path -LiteralPath $rollbackDirectory)) {
    Move-Item -LiteralPath $rollbackDirectory -Destination $dataTarget
  }
  throw
} finally {
  Remove-SafeDirectory $temporaryRoot ([System.IO.Path]::GetTempPath())
  if (Test-Path -LiteralPath $newDataDirectory) {
    $serverDirectory = Split-Path $dataTarget -Parent
    Remove-SafeDirectory $newDataDirectory $serverDirectory
  }
  if ($wasRunning) {
    Write-Output '[MindNProgress] 복원 전 실행 상태로 서버를 복구합니다.'
    Start-MindNProgress $workspaceRoot
    Wait-MindNProgress
  }
}
