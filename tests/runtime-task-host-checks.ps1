param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\mnp-runtime.ps1')
Add-Type -Path (Join-Path $PSScriptRoot 'runtime-window-monitor.cs')

function Assert-MnpHost($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

$mnpFixture = Join-Path ([IO.Path]::GetTempPath()) ('mnp-task-host-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($mnpFixture)
$mnpHostScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\runtime\task-host.vbs'))
$mnpChildScript = Join-Path $mnpFixture 'waiting launcher.cjs'
$mnpReadyPath = Join-Path $mnpFixture 'ready.json'
$mnpReleasePath = Join-Path $mnpFixture 'release'
$mnpMonitor = $null
$mnpHostProcess = $null
try {
    [IO.File]::WriteAllText($mnpChildScript, @'
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'ready.json'), JSON.stringify({ pid: process.pid, parent: process.ppid, cwd: process.cwd() }));
const timer = setInterval(() => {
  if (fs.existsSync(path.join(__dirname, 'release'))) process.exit(Number(fs.readFileSync(path.join(__dirname, 'release'), 'utf8')));
}, 20);
setTimeout(() => process.exit(99), 10000).unref();
'@, (New-Object Text.UTF8Encoding($false)))
    $mnpMonitor = New-Object MnpWindowMonitor
    Assert-MnpHost $mnpMonitor.SelfTestPassed 'Window observer self-test failed'
    $mnpObservedPids = @()
    foreach ($mnpCode in @(0, 7, 0, 7, 0, 7, 0, 7, 0, 7)) {
        foreach ($mnpFile in @($mnpReadyPath, $mnpReleasePath)) {
            if (Test-Path -LiteralPath $mnpFile) { Remove-Item -LiteralPath $mnpFile }
        }
        $mnpStart = New-Object Diagnostics.ProcessStartInfo
        $mnpStart.FileName = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $mnpStart.Arguments = '//B //NoLogo "{0}" "{1}" "{2}"' -f $mnpHostScript, $NodePath, $mnpChildScript
        $mnpStart.UseShellExecute = $false
        # Do not let the test parent hide a broken host. wscript is a GUI host;
        # the production task likewise does not supply CREATE_NO_WINDOW.
        $mnpStart.CreateNoWindow = $false
        $mnpHostProcess = [Diagnostics.Process]::Start($mnpStart)
        $mnpObservedPids += $mnpHostProcess.Id
        $mnpDeadline = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath $mnpReadyPath)) {
            if ($mnpHostProcess.HasExited -or $mnpDeadline.Elapsed.TotalSeconds -gt 8) { throw 'Task host did not start the fixture launcher' }
            Start-Sleep -Milliseconds 20
        }
        $mnpChild = Get-Content -LiteralPath $mnpReadyPath -Raw | ConvertFrom-Json
        $mnpObservedPids += $mnpChild.pid
        Assert-MnpHost ($mnpChild.parent -eq $mnpHostProcess.Id) 'Task host did not directly own its launcher'
        Assert-MnpHost ($mnpChild.cwd -ieq $mnpFixture) 'Task host lost the launcher working directory'
        Start-Sleep -Milliseconds 150
        Assert-MnpHost (-not $mnpHostProcess.HasExited) 'Task host detached and returned before its launcher'
        [IO.File]::WriteAllText($mnpReleasePath, [string]$mnpCode)
        Assert-MnpHost ($mnpHostProcess.WaitForExit(8000)) 'Task host did not exit with its launcher'
        Assert-MnpHost ($mnpHostProcess.ExitCode -eq $mnpCode) 'Task host did not preserve its launcher exit code'
        Assert-MnpHost ($null -eq (Get-Process -Id $mnpChild.pid -ErrorAction SilentlyContinue)) 'Fixture launcher remained after its host exited'
        $mnpHostProcess.Dispose(); $mnpHostProcess = $null
    }
    $mnpInvalid = Invoke-MnpHiddenCommand (Join-Path $env:SystemRoot 'System32\wscript.exe') ('//B //NoLogo "{0}" "{1}" "{2}"' -f $mnpHostScript, $NodePath, (Join-Path $mnpFixture 'missing.cjs'))
    Assert-MnpHost ($mnpInvalid.ExitCode -ne 0) 'Missing launcher was reported as successful'
    # Exercise the actual user entrypoint, its PowerShell controller and native
    # helper calls as well. Only the scheduled action is replaced with a fixture.
    $mnpFixtureScripts = Join-Path $mnpFixture 'MindNProgress\scripts'
    $null = [IO.Directory]::CreateDirectory($mnpFixtureScripts)
    $mnpStartIcon = Join-Path $mnpFixture 'MindNProgress_Start.vbs'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\scripts\runtime\entrypoints\MindNProgress_Start.vbs') -Destination $mnpStartIcon
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\scripts\runtime\entrypoints\MindNProgress_Start.bat') -Destination (Join-Path $mnpFixture 'MindNProgress_Start.bat')
    $mnpController = @'
param([string]$Action, [switch]$AllowLegacyStop, [switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
try {
if ($Action -ne 'restart' -or -not $AllowLegacyStop -or -not $OpenBrowser) { throw 'Start icon lost its arguments' }
. '__CONTROLLER__'
$nodeQuery = Invoke-MnpHiddenCommand '__NODE__' '--version'
if ($nodeQuery.ExitCode -ne 0) { throw 'Node query failed' }
$portQuery = Invoke-MnpHiddenCommand (Join-Path $env:SystemRoot 'System32\netstat.exe') '-ano -p tcp'
if ($portQuery.ExitCode -ne 0) { throw 'Port query failed' }
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = Join-Path $env:SystemRoot 'System32\wscript.exe'
$startInfo.Arguments = '__HOST_ARGUMENTS__'
$startInfo.UseShellExecute = $false
$child = [Diagnostics.Process]::Start($startInfo)
if (-not $child.WaitForExit(15000) -or $child.ExitCode -ne 0) { throw 'Fixture task host failed' }
$child.Dispose()
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'completed'), 'ok')
exit 0
} catch {
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'failure'), ($_ | Out-String))
    exit 1
}
'@
    $mnpController = $mnpController.Replace('__CONTROLLER__', ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\mnp-runtime.ps1'))).Replace("'", "''")).Replace('__NODE__', $NodePath.Replace("'", "''")).Replace('__HOST_ARGUMENTS__', $mnpStart.Arguments.Replace("'", "''"))
    [IO.File]::WriteAllText((Join-Path $mnpFixtureScripts 'mnp-runtime.ps1'), $mnpController, (New-Object Text.UTF8Encoding($true)))
    [IO.File]::WriteAllText($mnpReleasePath, '0')
    $mnpStart.Arguments = '//B //NoLogo "{0}"' -f $mnpStartIcon
    $mnpHostProcess = [Diagnostics.Process]::Start($mnpStart)
    $mnpObservedPids += $mnpHostProcess.Id
    Assert-MnpHost ($mnpHostProcess.WaitForExit(30000)) 'Start icon fixture did not finish'
    $mnpFailure = if (Test-Path -LiteralPath (Join-Path $mnpFixtureScripts 'failure')) { Get-Content -LiteralPath (Join-Path $mnpFixtureScripts 'failure') -Raw } else { 'no completion marker' }
    Assert-MnpHost ($mnpHostProcess.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $mnpFixtureScripts 'completed'))) ('Start icon fixture failed: ' + $mnpFailure)
    $mnpHostProcess.Dispose(); $mnpHostProcess = $null
    Start-Sleep -Milliseconds 200
    $mnpEvents = @($mnpMonitor.Snapshot() | Where-Object {
        $mnpIds = $_.Ancestry
        # Console hosts may deny process-parent queries: never silently discard
        # their SHOW events just because ancestry could not be resolved.
        $_.WindowClass -match 'ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS' -or @($mnpObservedPids | Where-Object { $mnpIds -contains $_ }).Count -gt 0
    })
    $mnpEventDetails = @($mnpEvents | ForEach-Object {
        $mnpEvent = $_
        [pscustomobject]@{
            ProcessId = $mnpEvent.ProcessId
            Ancestry = $mnpEvent.Ancestry
            WindowClass = $mnpEvent.WindowClass
            FixtureAncestryMatch = @($mnpObservedPids | Where-Object { $mnpEvent.Ancestry -contains $_ }).Count -gt 0
        }
    })
    Assert-MnpHost ($mnpEvents.Count -eq 0) ('Visible startup windows detected: ' + ($mnpEventDetails | ConvertTo-Json -Depth 4 -Compress) + '; fixture PIDs: ' + ($mnpObservedPids -join ','))
    Write-Host 'Task host checks passed: 10 launches; 0 SHOW events; start-icon chain, lifetime, parent, cwd, exit 0/7 and missing-file checks passed.'
} finally {
    # Only release the fixture we created. Its own deadline also prevents orphans.
    if ($mnpHostProcess) {
        [IO.File]::WriteAllText($mnpReleasePath, '99')
        $null = $mnpHostProcess.WaitForExit(12000)
        $mnpHostProcess.Dispose()
    }
    if ($mnpMonitor) { $mnpMonitor.Dispose() }
    $mnpResolved = [IO.Path]::GetFullPath($mnpFixture)
    if ([IO.Path]::GetDirectoryName($mnpResolved) -ine ([IO.Path]::GetTempPath().TrimEnd('\')) -or [IO.Path]::GetFileName($mnpResolved) -notlike 'mnp-task-host-*') { throw 'Unsafe fixture cleanup path' }
    Remove-Item -LiteralPath $mnpResolved -Recurse -Force
}
