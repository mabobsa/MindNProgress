param(
    [ValidateSet('status', 'start', 'stop', 'restart')][string]$Action = 'status',
    [ValidateRange(1, 300)][int]$StopTimeoutSeconds = 60,
    [ValidateRange(1, 300)][int]$StartTimeoutSeconds = 120,
    [switch]$OpenBrowser,
    [switch]$AllowLegacyStop,
    [switch]$UseGuiTaskHost
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime\process-owner.ps1')

function Invoke-MnpHiddenCommand([string]$Executable, [string]$Arguments, [int]$TimeoutSeconds = 15) {
    # 부모 PowerShell에 콘솔이 없으면 & 호출이 새 콘솔을 만들 수 있다. 일회성 조회만 이 경로로 실행한다.
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    $helper = New-Object Diagnostics.Process
    $helper.StartInfo = $startInfo
    try {
        if (-not $helper.Start()) { throw 'Could not start the hidden runtime query.' }
        $output = $helper.StandardOutput.ReadToEndAsync()
        $failure = $helper.StandardError.ReadToEndAsync()
        if (-not $helper.WaitForExit($TimeoutSeconds * 1000)) {
            # 직접 생성한 짧은 조회 프로세스만 정리한다. MnP 서버·예약 작업에는 사용하지 않는다.
            $helper.Kill()
            $helper.WaitForExit()
            throw 'Hidden runtime query timed out.'
        }
        return [pscustomobject]@{ ExitCode = $helper.ExitCode; Output = $output.GetAwaiter().GetResult(); Error = $failure.GetAwaiter().GetResult() }
    } finally { $helper.Dispose() }
}

function Get-MnpTaskLaunch($ActionDefinition, [string]$Root, [string]$Project, [string]$Launcher) {
    if ([IO.Path]::GetFullPath($ActionDefinition.WorkingDirectory) -ine $Root) {
        throw 'Scheduled task working directory does not match this installation.'
    }
    $legacyExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $hostExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if ($ActionDefinition.Execute -ieq $legacyExe) {
        # Keep the old action readable until the verified stop-and-migrate operation.
        if ($ActionDefinition.Arguments -notmatch "& '([^']+node\.exe)' ") { throw 'Cannot identify the registered Node executable.' }
        $node = $Matches[1]
        $expected = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& ''{0}'' ''{1}''; exit $LASTEXITCODE"' -f $node, $Launcher
    } elseif ($ActionDefinition.Execute -ieq $hostExe) {
        $hostScript = Join-Path $Project 'scripts\runtime\task-host.vbs'
        if (-not (Test-Path -LiteralPath $hostScript -PathType Leaf)) { throw 'Scheduled task host is missing.' }
        if ($ActionDefinition.Arguments -notmatch '^//B //NoLogo "[^"]+" "([^"]+node\.exe)" "[^"]+"$') { throw 'Cannot identify the registered Node executable.' }
        $node = $Matches[1]
        $expected = '//B //NoLogo "{0}" "{1}" "{2}"' -f $hostScript, $node, $Launcher
    } else {
        throw 'Scheduled task executable does not match this installation.'
    }
    if ($ActionDefinition.Arguments -ine $expected -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
        throw 'Scheduled task command differs from the verified launcher. No processes were stopped.'
    }
    return [pscustomobject]@{ TaskExe = $ActionDefinition.Execute; Node = $node }
}

function Get-MnpContext {
    $project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $root = Split-Path $project -Parent
    $launcher = Join-Path $root 'MindNProgress_Launcher.cjs'
    $required = @('scripts\dev.mjs', 'server\index.mjs', 'scripts\runtime\launcher.cjs',
        'scripts\runtime\supervisor.mjs', 'scripts\runtime\web.mjs', 'scripts\runtime\config.mjs',
        'server\lib\runtimeLifecycle.mjs', 'node_modules\vite\package.json')
    foreach ($file in @($launcher) + @($required | ForEach-Object { Join-Path $project $_ })) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Runtime file missing: $file" }
    }
    $task = Get-ScheduledTask -TaskName 'MindNProgress' -TaskPath '\'
    $account = $task.Principal.UserId
    if ($account -match '^S-1-') {
        $account = (New-Object Security.Principal.SecurityIdentifier($account)).Translate([Security.Principal.NTAccount]).Value
    }
    if (($account -split '\\')[-1] -ine 'NHN') { throw 'The registered task must run as NHN.' }
    $ownerSid = (New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value
    if (@($task.Actions).Count -ne 1) { throw 'Ambiguous scheduled task actions.' }
    $actionDefinition = $task.Actions[0]
    $launch = Get-MnpTaskLaunch $actionDefinition $root $project $launcher
    $taskExe = $launch.TaskExe
    $node = $launch.Node
    $settings = Invoke-MnpHiddenCommand $node ('"{0}"' -f (Join-Path $project 'scripts\runtime\config.mjs'))
    if ($settings.ExitCode -ne 0) { throw 'Could not read local runtime configuration.' }
    $config = $settings.Output | ConvertFrom-Json
    [pscustomobject]@{ Project = $project; Root = $root; Launcher = $launcher; Node = $node; Task = $task; OwnerSid = $ownerSid;
        TaskExe = $taskExe; Config = $config; Ports = @([int]$config.webPort, [int]$config.apiPort);
        StateDirectory = Join-Path $root '.mindnprogress' }
}

function Test-MnpCommand($ProcessRecord, [string]$Executable, [string]$Entry) {
    $pattern = '^(?:"' + [regex]::Escape($Executable) + '"|' + [regex]::Escape($Executable) + ')\s+(?:"' + [regex]::Escape($Entry) + '"|' + [regex]::Escape($Entry) + ')\s*$'
    return $ProcessRecord.ExecutablePath -ieq $Executable -and $ProcessRecord.CommandLine -imatch $pattern
}

function Test-MnpSameRecord($Before, $After) {
    return $null -ne $After -and $Before.ProcessId -eq $After.ProcessId -and
        $Before.ParentProcessId -eq $After.ParentProcessId -and $Before.CreationDate -eq $After.CreationDate -and
        $Before.ExecutablePath -ieq $After.ExecutablePath -and $Before.CommandLine -ceq $After.CommandLine
}

function Get-MnpTcpListeners([int[]]$Ports) {
    # 사전 검사와 최종 검사를 같은 숨김 조회로 수행한다. NetTCPIP 공급자의 빈 결과에 의존하지 않는다.
    # -p tcp는 IPv6 수신 포트를 제외하므로 전체 결과에서 TCP LISTENING만 선택한다.
    $netstat = Invoke-MnpHiddenCommand (Join-Path $env:SystemRoot 'System32\netstat.exe') '-ano'
    if ($netstat.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($netstat.Output) -or -not [string]::IsNullOrWhiteSpace($netstat.Error)) {
        throw 'Could not verify TCP port ownership.'
    }
    foreach ($line in ($netstat.Output -split '\r?\n')) {
        if ($line -notmatch '^\s*TCP\s+') { continue }
        if ($line -notmatch '^\s*TCP\s+\S+:(\d+)\s+\S+\s+(\S+)\s+(\d+)\s*$') {
            throw 'Unrecognized TCP row. Port ownership cannot be verified.'
        }
        if ($Matches[2] -eq 'LISTENING' -and $Ports -contains [int]$Matches[1]) {
            [pscustomobject]@{ LocalPort = [int]$Matches[1]; OwningProcess = [int]$Matches[3] }
        }
    }
}

function Get-MnpSnapshot($Context, [switch]$FastPorts) {
    # FastPorts는 기존 조회 호출과의 호환용이다. 지정 여부와 관계없이 같은 포트 검증을 사용한다.
    # Expensive identity queries are performed at boundaries, never inside polling loops.
    $all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='wscript.exe'")
    $definitions = @(
        @{ Role = 'launcher'; Entry = $Context.Launcher; Parent = 'task' },
        @{ Role = 'supervisor'; Entry = Join-Path $Context.Project 'scripts\dev.mjs'; Parent = 'launcher' },
        @{ Role = 'api'; Entry = Join-Path $Context.Project 'server\index.mjs'; Parent = 'supervisor' },
        @{ Role = 'web'; Entry = Join-Path $Context.Project 'scripts\runtime\web.mjs'; Parent = 'supervisor' },
        @{ Role = 'web'; Entry = Join-Path $Context.Project 'node_modules\vite\bin\vite.js'; Parent = 'supervisor' }
    )
    $records = @()
    $wrapperCommand = '"' + $Context.TaskExe + '" ' + $Context.Task.Actions[0].Arguments
    foreach ($item in $all) {
        if ($item.ExecutablePath -ieq $Context.TaskExe -and $item.CommandLine -ieq $wrapperCommand) {
            $records += [pscustomobject]@{ Role = 'task'; Parent = $null; Process = $item }
        }
        foreach ($definition in $definitions) {
            if (Test-MnpCommand $item $Context.Node $definition.Entry) {
                $records += [pscustomobject]@{ Role = $definition.Role; Parent = $definition.Parent; Process = $item }
            }
        }
    }
    # Tests and other sessions may run the same API source with isolated data/ports.
    # Only the exact deployment launcher and its descendants belong to this task.
    $launchers = @($records | Where-Object Role -eq 'launcher')
    $supervisors = @($records | Where-Object { $_.Role -eq 'supervisor' -and $launchers.Process.ProcessId -contains $_.Process.ParentProcessId })
    $records = @($records | Where-Object {
        $_.Role -in @('task', 'launcher') -or
        ($_.Role -eq 'supervisor' -and $launchers.Process.ProcessId -contains $_.Process.ParentProcessId) -or
        ($_.Role -in @('api', 'web') -and $supervisors.Process.ProcessId -contains $_.Process.ParentProcessId)
    })
    foreach ($record in $records) {
        if (@($records | Where-Object Role -eq $record.Role).Count -ne 1) { throw "Multiple $($record.Role) processes. Manual inspection required." }
        if ($record.Parent) {
            $parent = @($records | Where-Object Role -eq $record.Parent)
            # A stopped task wrapper may already be gone. Other ancestry must be intact.
            if ($parent.Count -eq 0 -and $record.Parent -eq 'task') {
                if ($all.ProcessId -contains $record.Process.ParentProcessId) { throw 'Launcher parent is not the registered task.' }
            } elseif ($parent.Count -ne 1 -or $record.Process.ParentProcessId -ne $parent[0].Process.ProcessId -or
                $record.Process.CreationDate -lt $parent[0].Process.CreationDate) { throw "Unverified parent for $($record.Role)." }
        }
        if ((Get-MnpProcessOwnerSid $record.Process.ProcessId) -ne $Context.OwnerSid) { throw "Cannot verify NHN ownership: $($record.Role)." }
    }
    $listeners = @(Get-MnpTcpListeners $Context.Ports)
    foreach ($listener in $listeners) {
        $expectedRole = if ($listener.LocalPort -eq $Context.Config.apiPort) { 'api' } else { 'web' }
        if (-not @($records | Where-Object { $_.Role -eq $expectedRole -and $_.Process.ProcessId -eq $listener.OwningProcess }).Count) {
            throw "Port $($listener.LocalPort) is not owned by the verified MnP $expectedRole. No unrelated process will be stopped."
        }
    }
    [pscustomobject]@{ Records = $records; Listeners = $listeners }
}

function Get-MnpLiveProcess($Record) {
    try { $live = [Diagnostics.Process]::GetProcessById([int]$Record.ProcessId) }
    catch [ArgumentException] { return $null }
    try {
        if ($live.HasExited) { $live.Dispose(); return $null }
        # Open the handle and check creation time + image; reused PIDs are never stop targets.
        $null = $live.Handle
        if ([math]::Abs(($live.StartTime.ToUniversalTime() - $Record.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1 -or
            $live.MainModule.FileName -ine $Record.ExecutablePath) { $live.Dispose(); return $null }
        return $live
    } catch { $live.Dispose(); throw }
}

function Test-MnpStopped($Context, $Snapshot) {
    foreach ($record in $Snapshot.Records) {
        $live = Get-MnpLiveProcess $record.Process
        if ($null -ne $live) { $live.Dispose(); return $false }
    }
    $ports = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return @($ports | Where-Object { $Context.Ports -contains $_.Port }).Count -eq 0
}

function Wait-MnpCondition([scriptblock]$Condition, [int]$Seconds, [string]$Failure, [scriptblock]$OnWaiting) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $nextReport = 0
    do {
        if (& $Condition) { return }
        if ($OnWaiting -and $watch.ElapsedMilliseconds -ge $nextReport) {
            & $OnWaiting
            $nextReport = $watch.ElapsedMilliseconds + 2000
        }
        Start-Sleep -Milliseconds 150
    } while ($watch.Elapsed.TotalSeconds -lt $Seconds)
    throw $Failure
}

function Write-MnpStopProgress($Context, $Snapshot) {
    $remaining = @($Snapshot.Records | ForEach-Object {
        $live = Get-MnpLiveProcess $_.Process
        if ($null -ne $live) {
            try { "$($_.Role)=$($_.Process.ProcessId)" } finally { $live.Dispose() }
        }
    })
    $ports = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $Context.Ports -contains $_.Port } | ForEach-Object Port | Sort-Object -Unique)
    Write-Host "[stop-wait] remaining PIDs: $($remaining -join ', '); occupied ports: $($ports -join ', '). Task Ready alone does not mean stopped."
}

function Get-MnpDescriptor($Context, $Snapshot) {
    $file = Join-Path $Context.StateDirectory 'runtime.json'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $descriptor = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    $supervisor = @($Snapshot.Records | Where-Object { $_.Role -eq 'supervisor' -and $_.Process.ProcessId -eq $descriptor.pid })
    if ($supervisor.Count -ne 1) { return $null } # Stale metadata is not authority.
    # Node's uptime starts after native initialization, not necessarily at Windows process creation.
    # Metadata must have been written by this process generation; the pipe then checks its random instance ID.
    $metadataWrittenAt = (Get-Item -LiteralPath $file).LastWriteTimeUtc
    $processCreatedAt = $supervisor[0].Process.CreationDate.ToUniversalTime()
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $key = $Context.Project.ToLowerInvariant() + "`n" + $Context.StateDirectory.ToLowerInvariant()
        $digest = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($key)))).Replace('-', '').ToLowerInvariant().Substring(0, 24)
        $expectedPipe = '\\.\pipe\mnp-runtime-' + $digest
    } finally { $hash.Dispose() }
    if ($descriptor.version -ne 1 -or $descriptor.projectDirectory -ine $Context.Project -or
        $descriptor.parentPid -ne $supervisor[0].Process.ParentProcessId -or
        $metadataWrittenAt -lt $processCreatedAt -or
        $descriptor.pipe -cne $expectedPipe -or $descriptor.instanceId -notmatch '^[a-f0-9-]{36}$') {
        throw 'Runtime descriptor identity mismatch. No shutdown request was sent.'
    }
    return $descriptor
}

function Send-MnpShutdown($Descriptor) {
    $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $Descriptor.pipe.Substring(9), [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try {
        $pipe.Connect(1000)
        $message = @{ type = 'mnp:shutdown'; instanceId = $Descriptor.instanceId } | ConvertTo-Json -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($message + "`n")
        $pipe.Write($bytes, 0, $bytes.Length)
        $pipe.Flush()
        $reader = New-Object IO.StreamReader($pipe)
        $read = $reader.ReadLineAsync()
        if (-not $read.Wait(2000) -or $read.Result -ne 'accepted') { throw 'Runtime did not accept the graceful shutdown request.' }
    } finally { $pipe.Dispose() }
}

function Stop-MnpLegacy($Snapshot) {
    Write-Warning 'Legacy runtime: graceful IPC is unavailable. Stopping only revalidated processes for this one-time migration.'
    $fresh = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='wscript.exe'")
    foreach ($record in @($Snapshot.Records | Sort-Object { switch ($_.Role) { 'api' { 0 } 'web' { 1 } 'supervisor' { 2 } default { 3 } } })) {
        $current = $fresh | Where-Object ProcessId -eq $record.Process.ProcessId
        if (-not $current) { continue }
        if (-not (Test-MnpSameRecord $record.Process $current)) { throw 'Process identity changed. Legacy stop aborted.' }
        $live = Get-MnpLiveProcess $record.Process
        if ($null -ne $live) {
            try { $live.Kill(); $null = $live.WaitForExit(500) } finally { $live.Dispose() }
        }
    }
}

function Test-MnpHttp($Context, [int]$TimeoutMilliseconds = 900) {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [timespan]::FromMilliseconds([math]::Max(1, $TimeoutMilliseconds))
    $web = $null; $api = $null; $webTask = $null; $apiTask = $null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $check = [ordered]@{ healthy = $false; timeoutMs = $TimeoutMilliseconds; webStatus = $null; apiStatus = $null; error = $null; elapsedMs = 0 }
    try {
        $webTask = $client.GetAsync($Context.Config.webUrl)
        $apiTask = $client.GetAsync($Context.Config.apiUrl)
        $web = $webTask.GetAwaiter().GetResult(); $api = $apiTask.GetAwaiter().GetResult()
        $check.webStatus = [int]$web.StatusCode
        $check.apiStatus = [int]$api.StatusCode
        if ([int]$web.StatusCode -ne 200 -or [int]$api.StatusCode -ne 200) {
            Write-Verbose "HTTP check: web=$([int]$web.StatusCode); api=$([int]$api.StatusCode)"
        } else {
            $check.healthy = ($api.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).status -eq 'ok'
        }
    } catch { $check.error = $_.Exception.GetBaseException().GetType().Name; Write-Verbose "HTTP check failed: $($_.Exception.Message)" }
    finally {
        # 한쪽 요청이 멈추거나 실패해도 이미 완료된 다른 쪽의 상태 코드를 진단에 남긴다.
        if ($webTask -and $webTask.Status -eq 'RanToCompletion') { $web = $webTask.Result; $check.webStatus = [int]$web.StatusCode }
        if ($apiTask -and $apiTask.Status -eq 'RanToCompletion') { $api = $apiTask.Result; $check.apiStatus = [int]$api.StatusCode }
        if ($web) { $web.Dispose() }; if ($api) { $api.Dispose() }; $client.Dispose(); $handler.Dispose()
        $check.elapsedMs = $watch.ElapsedMilliseconds
        $script:MnpLastHttpCheck = $check
    }
    return [bool]$check.healthy
}

function Wait-MnpHttpReady($Context, [datetime]$Deadline, [string]$Failure) {
    $nextReportAt = [datetime]::MinValue
    do {
        $remainingMs = [int][math]::Ceiling(($Deadline - [datetime]::UtcNow).TotalMilliseconds)
        if ($remainingMs -le 0) { break }
        # 전체 시작·최종 검증의 마감은 유지하되 멈춘 한 요청이 남은 시간을 전부 소비하지 않게 한다.
        # 기존 900ms보다 긴 정상 응답을 허용하고, 최대 5초마다 새 연결로 다시 확인한다.
        if (Test-MnpHttp $Context ([math]::Min(5000, $remainingMs))) { return }
        if ([datetime]::UtcNow -ge $nextReportAt) {
            $check = $script:MnpLastHttpCheck
            Write-Host "[http-wait] web=$($check.webStatus); api=$($check.apiStatus); error=$($check.error); elapsed=$($check.elapsedMs)ms"
            $nextReportAt = [datetime]::UtcNow.AddSeconds(2)
        }
        $sleepMs = [math]::Min(150, [math]::Max(0, ($Deadline - [datetime]::UtcNow).TotalMilliseconds))
        if ($sleepMs -gt 0) { Start-Sleep -Milliseconds ([int]$sleepMs) }
    } while ([datetime]::UtcNow -lt $Deadline)
    throw $Failure
}

function Get-MnpTaskPolicyXml([string]$TaskXml) {
    [xml]$document = $TaskXml
    $actions = @($document.DocumentElement.ChildNodes | Where-Object LocalName -eq 'Actions')
    foreach ($entry in $actions) { $null = $document.DocumentElement.RemoveChild($entry) }
    return $document.OuterXml
}

function Set-MnpGuiTaskHost($Context) {
    $hostExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if ($Context.TaskExe -ieq $hostExe) { return $Context }
    $arguments = '//B //NoLogo "{0}" "{1}" "{2}"' -f (Join-Path $Context.Project 'scripts\runtime\task-host.vbs'), $Context.Node, $Context.Launcher
    $actionDefinition = New-ScheduledTaskAction -Execute $hostExe -Argument $arguments -WorkingDirectory $Context.Root
    $null = Get-MnpTaskLaunch $actionDefinition $Context.Root $Context.Project $Context.Launcher
    $originalXml = Export-ScheduledTask -TaskName $Context.Task.TaskName -TaskPath $Context.Task.TaskPath
    $backup = Join-Path $Context.StateDirectory ('task-before-gui-host-' + [guid]::NewGuid().ToString('N') + '.xml')
    # Export-ScheduledTask declares UTF-16; preserve that encoding for a loadable backup.
    [IO.File]::WriteAllText($backup, $originalXml, [Text.Encoding]::Unicode)
    $null = Set-ScheduledTask -TaskName $Context.Task.TaskName -TaskPath $Context.Task.TaskPath -Action $actionDefinition
    $updatedXml = Export-ScheduledTask -TaskName $Context.Task.TaskName -TaskPath $Context.Task.TaskPath
    if ((Get-MnpTaskPolicyXml $originalXml) -cne (Get-MnpTaskPolicyXml $updatedXml)) {
        throw "Task policy unexpectedly changed. Startup was not attempted. Inspect backup: $backup"
    }
    $updatedContext = Get-MnpContext
    if ($updatedContext.TaskExe -ine $hostExe) { throw 'GUI task action was not saved. Startup was not attempted.' }
    Write-Host "[task-host] GUI action saved; task policy unchanged; backup=$backup"
    return $updatedContext
}

function Invoke-MnpRuntime {
    param([string]$Operation, [int]$StopSeconds, [int]$StartSeconds, [bool]$Browser, [bool]$Legacy, [bool]$GuiTaskHost = $false)
    if ($GuiTaskHost -and $Operation -ne 'restart') { throw 'GUI task host migration requires an explicit restart.' }
    $total = [Diagnostics.Stopwatch]::StartNew()
    $phases = [ordered]@{}
    $phaseName = 'preflight'
    $phase = [Diagnostics.Stopwatch]::StartNew()
    $lock = $null; $context = $null; $succeeded = $false
    $script:MnpLastHttpCheck = $null
    try {
        $context = Get-MnpContext
        if ($GuiTaskHost -and -not (Test-Path -LiteralPath (Join-Path $context.Project 'scripts\runtime\task-host.vbs') -PathType Leaf)) {
            throw 'GUI task host is missing. No processes were stopped.'
        }
        if ($Operation -ne 'status') {
            $null = [IO.Directory]::CreateDirectory($context.StateDirectory)
            $lock = [IO.File]::Open((Join-Path $context.StateDirectory 'runtime-operation.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        }
        $before = Get-MnpSnapshot $context
        $descriptor = Get-MnpDescriptor $context $before
        $phases.preflightMs = $total.ElapsedMilliseconds
        Write-Host "[preflight] $($phases.preflightMs)ms; task=$($context.Task.TaskPath)$($context.Task.TaskName); account=NHN"
        if ($Operation -eq 'status') {
            [pscustomobject]@{ TaskState = [string]$context.Task.State; Healthy = (Test-MnpHttp $context); GracefulShutdown = ($null -ne $descriptor);
                Processes = @($before.Records | ForEach-Object { [pscustomobject]@{ Role = $_.Role; Pid = $_.Process.ProcessId; StartedAt = $_.Process.CreationDate } }) } | ConvertTo-Json -Depth 5
            return
        }
        if ($Operation -in @('stop', 'restart')) {
            $hasNodes = @($before.Records | Where-Object Role -ne 'task').Count -gt 0
            if ($hasNodes -and -not $descriptor -and -not $Legacy) {
                throw 'Legacy runtime has no graceful IPC. Use -AllowLegacyStop once after confirming that active saves can be interrupted.'
            }
            Write-Host '[stop] stopping the registered task and draining existing servers...'
            Write-Host ('[stop-targets] verified PIDs: ' + (($before.Records | ForEach-Object { "$($_.Role)=$($_.Process.ProcessId)" }) -join ', '))
            $phaseName = 'stop'
            $phase = [Diagnostics.Stopwatch]::StartNew()
            Stop-ScheduledTask -TaskName $context.Task.TaskName -TaskPath $context.Task.TaskPath
            if (-not (Test-MnpStopped $context $before)) {
                if ($descriptor) {
                    Send-MnpShutdown $descriptor
                    Write-Host '[stop] graceful request accepted; waiting for the verified child PIDs and ports.'
                }
                elseif ($Legacy) { Stop-MnpLegacy $before }
            }
            Wait-MnpCondition { Test-MnpStopped $context $before } $StopSeconds 'Stop timed out. No forced shutdown or new instance was attempted. Check dev.out.log / dev.err.log, then retry status.' { Write-MnpStopProgress $context $before }
            $phases.stopMs = $phase.ElapsedMilliseconds
            # PID hints are cleared only after verified processes and ports have disappeared.
            $pidFile = Join-Path $context.StateDirectory 'dev.pids'
            if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile }
            Write-Host "[stop] confirmed; $($phases.stopMs)ms"
            if ($GuiTaskHost) {
                $phaseName = 'taskHostMigration'
                $phase.Restart()
                $context = Set-MnpGuiTaskHost $context
                $phases.taskHostMigrationMs = $phase.ElapsedMilliseconds
            }
        }
        if ($Operation -in @('start', 'restart')) {
            if ($Operation -eq 'start' -and $before.Records.Count -gt 0) {
                if (-not (Test-MnpHttp $context)) { throw 'An existing instance is not healthy. Start did not restart or replace it.' }
                Write-Host '[ready] already running; no restart performed.'
            } else {
                # Recheck fast port/process state immediately before starting the same registered task.
                if (-not (Test-MnpStopped $context $before)) { throw 'Processes or ports are still occupied. No instance was started.' }
                $startTime = [datetime]::UtcNow
                $startupDeadline = $startTime.AddSeconds($StartSeconds)
                $phaseName = 'taskStart'
                $phase = [Diagnostics.Stopwatch]::StartNew()
                Start-ScheduledTask -TaskName $context.Task.TaskName -TaskPath $context.Task.TaskPath
                $phases.taskStartMs = $phase.ElapsedMilliseconds
                $phaseName = 'httpReady'
                $phase.Restart()
                Wait-MnpHttpReady $context $startupDeadline 'Startup HTTP checks timed out. Inspect the task and dev logs; do not repeatedly start it.'
                $phases.httpReadyMs = $phase.ElapsedMilliseconds
                $phaseName = 'finalVerification'
                $phase.Restart()
                $after = Get-MnpSnapshot $context -FastPorts
                foreach ($role in @('api', 'web')) {
                    $record = @($after.Records | Where-Object Role -eq $role)
                    if ($record.Count -ne 1 -or $record[0].Process.CreationDate.ToUniversalTime() -lt $startTime -or
                        @($before.Records | Where-Object { Test-MnpSameRecord $_.Process $record[0].Process }).Count) {
                        throw "Fresh $role process identity was not verified."
                    }
                    $port = if ($role -eq 'api') { $context.Config.apiPort } else { $context.Config.webPort }
                    if (-not @($after.Listeners | Where-Object { $_.LocalPort -eq $port -and $_.OwningProcess -eq $record[0].Process.ProcessId }).Count) {
                        throw "Fresh $role port ownership was not verified."
                    }
                    Write-Host "[verified] $role PID=$($record[0].Process.ProcessId) started=$($record[0].Process.CreationDate.ToString('o'))"
                }
                Wait-MnpHttpReady $context $startupDeadline 'HTTP readiness was not restored within the startup deadline after final identity verification. No additional restart was attempted.'
                $phases.finalVerificationMs = $phase.ElapsedMilliseconds
                Write-Host '[ready] web=200; api=200; new NHN processes verified.'
            }
            if ($Browser) { Start-Process $context.Config.webUrl }
        }
        $succeeded = $true
    } finally {
        if (-not $phases.Contains($phaseName + 'Ms')) { $phases[$phaseName + 'Ms'] = $phase.ElapsedMilliseconds }
        $phases.totalMs = $total.ElapsedMilliseconds
        if ($lock) {
            try {
                $entry = @{ at = [datetime]::UtcNow.ToString('o'); action = $Operation; succeeded = $succeeded;
                    failedPhase = $(if ($succeeded) { $null } else { $phaseName }); phases = $phases; http = $script:MnpLastHttpCheck } | ConvertTo-Json -Depth 4 -Compress
                [IO.File]::AppendAllText((Join-Path $context.StateDirectory 'runtime-operations.jsonl'), $entry + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
            } finally { $lock.Dispose() }
        }
        Write-Host "[total] $($phases.totalMs)ms"
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-MnpRuntime $Action $StopTimeoutSeconds $StartTimeoutSeconds ([bool]$OpenBrowser) ([bool]$AllowLegacyStop) ([bool]$UseGuiTaskHost) }
    catch { Write-Error $_ -ErrorAction Continue; exit 1 }
}
