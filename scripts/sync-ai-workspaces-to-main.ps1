[CmdletBinding()]
param(
  [string]$ApiUrl = 'http://127.0.0.1:4176',
  [string]$DataDirectory,
  [string[]]$WorkspaceId
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
  if (-not [string]::IsNullOrWhiteSpace($env:MNP_DATA_DIR)) {
    $DataDirectory = $env:MNP_DATA_DIR
  }
  else {
    $DataDirectory = Join-Path $projectRoot 'server\data'
  }
}

$tokenFile = Join-Path ([System.IO.Path]::GetFullPath($DataDirectory)) '_integration-token'
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
  throw "MindNProgress 연동 토큰을 찾지 못했습니다: $tokenFile"
}

$token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "MindNProgress 연동 토큰이 비어 있습니다: $tokenFile"
}

$body = @{}
if ($null -ne $WorkspaceId -and $WorkspaceId.Count -gt 0) {
  $normalizedWorkspaceIds = @(
    $WorkspaceId |
      ForEach-Object { $_ -split ',' } |
      ForEach-Object { $_.Trim() } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Select-Object -Unique
  )
  $body.workspaceIds = $normalizedWorkspaceIds
}

$uri = '{0}/api/internal/ai-workspaces/synchronize-idle' -f $ApiUrl.TrimEnd('/')
try {
  $result = Invoke-RestMethod `
    -Method Post `
    -Uri $uri `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json; charset=utf-8' `
    -Body ($body | ConvertTo-Json -Compress)
}
catch {
  $response = $_.Exception.Response
  if ($null -ne $response -and $null -ne $response.Content) {
    $detail = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    throw "AI 작업공간 동기화에 실패했습니다: $detail"
  }
  throw "실행 중인 MindNProgress API에 연결하지 못했습니다. 서버를 중지하지 말고 정상 기동한 상태에서 다시 실행하세요. 원인: $($_.Exception.Message)"
}

$result | ConvertTo-Json -Depth 8
