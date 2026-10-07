import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const project = path.resolve(import.meta.dirname, '..')
const ps = path.join(process.env.SystemRoot ?? '', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const quote = value => `'${value.replaceAll("'", "''")}'`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function until(condition, message, milliseconds = 20_000) {
  const deadline = performance.now() + milliseconds
  while (performance.now() < deadline) { if (await condition()) return; await pause(100) }
  throw new Error(message)
}
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function control(descriptor) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.pipe)
    socket.setTimeout(2000, () => socket.destroy(new Error('fixture control timeout')))
    socket.on('error', reject)
    socket.on('connect', () => socket.end(JSON.stringify({ type: 'mnp:shutdown', instanceId: descriptor.instanceId }) + '\n'))
    socket.resume()
    socket.on('end', resolve)
  })
}
async function clean(directory) {
  assert.equal(path.dirname(directory), tmpdir())
  assert.ok(path.basename(directory).startsWith('mnp-force-'))
  await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}
async function runPowerShell(file, env = {}) {
  const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  return { child, done: new Promise((resolve, reject) => { child.once('exit', code => resolve({ code, output })); child.once('error', reject) }) }
}

test('실제 교착 API는 공통 재시작의 마지막 kill로 회수되고 다른 동일 소스 서버는 유지된다', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-force-recovery-'))
  const fixture = path.join(root, 'MindNProgress'), state = path.join(root, '.mindnprogress')
  const launcher = path.join(root, 'MindNProgress_Launcher.cjs')
  const apiPort = await freePort(), webPort = await freePort(), otherPort = await freePort()
  const hostScript = path.join(project, 'scripts/runtime/task-host.vbs')
  const hostArguments = `//B //NoLogo "${hostScript}" "${process.execPath}" "${launcher}"`
  const env = { ...process.env, MNP_FIXTURE_API_PORT: String(apiPort), MNP_FIXTURE_WEB_PORT: String(webPort), MNP_FIXTURE_BLOCK: '1' }
  const children = []
  let descriptor, oldPids = [], recovery
  try {
    await mkdir(path.join(fixture, 'scripts/runtime'), { recursive: true })
    await mkdir(path.join(fixture, 'server'), { recursive: true })
    await writeFile(path.join(root, 'MindNProgress_Mcp.cjs'), '// Isolated marker.\n')
    await writeFile(launcher, `require(${JSON.stringify(path.join(project, 'scripts/runtime/launcher.cjs'))})(__dirname);\n`)
    await writeFile(path.join(fixture, 'scripts/dev.mjs'), `
import { supervise } from ${JSON.stringify(pathToFileURL(path.join(project, 'scripts/runtime/supervisor.mjs')).href)};
await supervise({ projectDirectory: ${JSON.stringify(fixture)}, stateDirectory: ${JSON.stringify(state)}, entries: [
  { name: 'api', file: ${JSON.stringify(path.join(fixture, 'server/index.mjs'))} },
  { name: 'web', file: ${JSON.stringify(path.join(fixture, 'scripts/runtime/web.mjs'))} }
] });`)
    const service = (portName, block) => `
import { createServer } from 'node:http';
import { createRuntimeLifecycle, installRuntimeShutdown } from ${JSON.stringify(pathToFileURL(path.join(project, 'server/lib/runtimeLifecycle.mjs')).href)};
const runtime = createRuntimeLifecycle();
const server = createServer(runtime.request((_request, response) => response.end(JSON.stringify({ status: 'ok' }))));
installRuntimeShutdown(() => runtime.stop(server));
if (${block} && process.env.MNP_FIXTURE_BLOCK === '1') void runtime.track(() => new Promise(() => {}), 'Fixture blocked work');
server.listen(Number(process.env.${portName}), '127.0.0.1');`
    await writeFile(path.join(fixture, 'server/index.mjs'), service('MNP_FIXTURE_API_PORT', 'true'))
    await writeFile(path.join(fixture, 'scripts/runtime/web.mjs'), service('MNP_FIXTURE_WEB_PORT', 'false'))
    const host = spawn(path.join(process.env.SystemRoot, 'System32/wscript.exe'), ['//B', '//NoLogo', hostScript, process.execPath, launcher], { windowsHide: true, env, stdio: 'ignore' })
    children.push(host)
    const hostExited = new Promise(resolve => host.once('exit', resolve))
    await until(async () => {
      try {
        descriptor = JSON.parse(await readFile(path.join(state, 'runtime.json'), 'utf8'))
        const results = await Promise.all([apiPort, webPort].map(port => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })))
        await Promise.all(results.map(result => result.text()))
        return results.every(result => result.status === 200)
      } catch { return false }
    }, 'Blocked fixture did not become ready')
    oldPids = [...(await readFile(path.join(state, 'dev.pids'), 'utf8')).trim().split(/\s+/).map(Number), ...descriptor.children.map(entry => entry.pid)]
    host.kill(); await hostExited
    const other = spawn(process.execPath, [path.join(fixture, 'server/index.mjs')], { windowsHide: true, env: { ...env, MNP_FIXTURE_API_PORT: String(otherPort), MNP_FIXTURE_BLOCK: '0' }, stdio: 'ignore' })
    children.push(other)
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${otherPort}`, { signal: AbortSignal.timeout(500) })).status === 200 } catch { return false } }, 'Other fixture server did not become ready')
    const script = path.join(root, 'restart.ps1')
    await writeFile(script, `
$ErrorActionPreference = 'Stop'
. ${quote(path.join(project, 'scripts/mnp-runtime.ps1'))}
function Get-MnpContext {
  return [pscustomobject]@{ Project=${quote(fixture)}; Root=${quote(root)}; Launcher=${quote(launcher)}; Node=${quote(process.execPath)};
    TaskExe=(Join-Path $env:SystemRoot 'System32\\wscript.exe'); OwnerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    Task=[pscustomobject]@{TaskName='isolated-force-fixture';TaskPath='\\';Actions=@([pscustomobject]@{Arguments=${quote(hostArguments)}})};
    StateDirectory=${quote(state)}; Ports=@(${apiPort},${webPort}); Config=[pscustomobject]@{apiPort=${apiPort};webPort=${webPort};apiUrl='http://127.0.0.1:${apiPort}/api/health';webUrl='http://127.0.0.1:${webPort}/'} }
}
function Stop-ScheduledTask { param($TaskName,$TaskPath); if ($TaskName -ne 'isolated-force-fixture') { throw 'Wrong fixture task' } }
function Start-ScheduledTask {
  param($TaskName,$TaskPath)
  if ($TaskName -ne 'isolated-force-fixture') { throw 'Wrong fixture task' }
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=Join-Path $env:SystemRoot 'System32\\wscript.exe'
  $info.Arguments=${quote(hostArguments)}
  $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.WindowStyle='Hidden'
  $info.EnvironmentVariables['MNP_FIXTURE_BLOCK']='0'
  $child=New-Object Diagnostics.Process; $child.StartInfo=$info
  if (-not $child.Start()) { throw 'Fixture start failed' }
  [IO.File]::WriteAllText(${quote(path.join(root, 'new-host.pid'))}, [string]$child.Id)
  $child.Dispose()
}
Invoke-MnpRuntime restart 1 30 $false $false $false 10
`)
    recovery = await runPowerShell(script, env)
    const result = await recovery.done
    assert.equal(result.code, 0, result.output)
    const record = JSON.parse((await readFile(path.join(state, 'runtime-operations.jsonl'), 'utf8')).trim().split(/\r?\n/).at(-1))
    assert.equal(record.succeeded, true)
    assert.equal(record.shutdownMode, 'forced')
    assert.equal(record.forceReason, 'stop-timeout')
    assert.ok(record.forcedProcesses.some(entry => entry.role === 'api'))
    assert.ok(record.forcedProcesses.every(entry => oldPids.includes(entry.pid)))
    assert.ok(oldPids.every(pid => !alive(pid)))
    assert.equal(alive(other.pid), true)
    assert.equal((await fetch(`http://127.0.0.1:${otherPort}`)).status, 200)
    descriptor = JSON.parse(await readFile(path.join(state, 'runtime.json'), 'utf8'))
    console.log(`[isolated forced restart] stopped ${record.forcedProcesses.length} verified processes; web/API ready; other server alive`)
  } finally {
    if (recovery?.child.exitCode === null) { recovery.child.kill(); await recovery.done }
    try { descriptor = JSON.parse(await readFile(path.join(state, 'runtime.json'), 'utf8')); await control(descriptor) } catch {}
    const owned = [...oldPids, ...(descriptor?.children.map(entry => entry.pid) ?? []), ...(descriptor ? [descriptor.pid, descriptor.parentPid] : [])]
    try { owned.push(Number(await readFile(path.join(root, 'new-host.pid'), 'utf8'))) } catch {}
    await until(() => owned.every(pid => !alive(pid)), 'Owned fixture did not stop', 5000).catch(() => {})
    const remaining = [...new Set(owned)].filter(alive)
    if (remaining.length) {
      // 이전 PID가 재사용됐어도 임시 설치 경로·실행 파일·계정이 맞는 대상을 핸들로만 정리한다.
      const cleanupFile = path.join(root, 'cleanup.ps1')
      await writeFile(cleanupFile, `
$ErrorActionPreference='Stop'
. ${quote(path.join(project, 'scripts/mnp-runtime.ps1'))}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$handles=@()
try {
  foreach ($fixturePid in @(${remaining.join(',')})) {
    $record=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $fixturePid)
    if (-not $record) { continue }
    if ($record.ExecutablePath -ine ${quote(process.execPath)} -and $record.ExecutablePath -ine (Join-Path $env:SystemRoot 'System32\\wscript.exe')) { throw 'Fixture executable changed' }
    if ($record.CommandLine -notmatch ${quote(`[" ]${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]`)}) { throw 'Fixture command changed' }
    $live=Get-MnpLiveProcess $record
    if (-not $live) { continue }
    $handles+=$live
    if ((Get-MnpProcessOwnerSid $record.ProcessId) -ne $owner) { throw 'Fixture owner changed' }
  }
  foreach ($live in $handles) { if (-not $live.HasExited) { $live.Kill(); $null=$live.WaitForExit(2000) } }
} finally { foreach ($live in $handles) { $live.Dispose() } }
`)
      const cleanup = await runPowerShell(cleanupFile)
      const result = await cleanup.done
      assert.equal(result.code, 0, result.output)
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done }
    await clean(root)
  }
})

test('강제 종료의 신원·계정·포트 재검증은 실제 다른 프로세스를 보존한다', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-force-identities-'))
  const children = []
  let verification
  try {
    const service = "import { createServer } from 'node:http'; const s=createServer((_q,r)=>r.end('ok')); s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port}));"
    const launch = async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', service], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      children.push(child)
      return { child, port: (await new Promise(resolve => child.once('message', resolve))).port }
    }
    const target = await launch(), other = await launch()
    const script = path.join(root, 'identities.ps1')
    await writeFile(script, `
$ErrorActionPreference='Stop'
. ${quote(path.join(project, 'scripts/mnp-runtime.ps1'))}
function Expect-Failure($Work,$Pattern) { try { & $Work } catch { if ($_.Exception.Message -match $Pattern) { return }; throw }; throw 'Expected refusal' }
$original=Get-CimInstance Win32_Process -Filter 'ProcessId=${target.child.pid}'
$context=[pscustomobject]@{OwnerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;Ports=@(${target.port});Config=[pscustomobject]@{apiPort=${target.port};webPort=0}}
$record=$original | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine
$record.CreationDate=$original.CreationDate.AddSeconds(1)
$snapshot=[pscustomobject]@{Records=@([pscustomobject]@{Role='api';Process=$record})}
$recovery=@{forcedProcesses=@()}
Expect-Failure { Stop-MnpVerifiedProcesses $context $snapshot $recovery ([Diagnostics.Stopwatch]::StartNew()) 10 } 'identity changed'
$record=$original | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine
$record.CommandLine+=' changed';$snapshot.Records[0].Process=$record
Expect-Failure { Stop-MnpVerifiedProcesses $context $snapshot $recovery ([Diagnostics.Stopwatch]::StartNew()) 10 } 'identity changed'
$snapshot.Records[0].Process=$original;$sid=$context.OwnerSid;$context.OwnerSid='S-1-5-18'
Expect-Failure { Stop-MnpVerifiedProcesses $context $snapshot $recovery ([Diagnostics.Stopwatch]::StartNew()) 10 } 'owner changed'
$context.OwnerSid=$sid;$context.Ports=@(${target.port},${other.port});$context.Config.webPort=${other.port}
Expect-Failure { Stop-MnpVerifiedProcesses $context $snapshot $recovery ([Diagnostics.Stopwatch]::StartNew()) 10 } 'Port owner changed'
if ($recovery.forcedProcesses.Count -ne 0) { throw 'Refusal killed a process' }
$context.Ports=@(${target.port});$watch=[Diagnostics.Stopwatch]::StartNew()
Stop-MnpVerifiedProcesses $context $snapshot $recovery $watch 10
Wait-MnpCondition { Test-MnpStopped $context $snapshot } 3 'Target did not stop'
if ($recovery.forcedProcesses.Count -ne 1 -or $recovery.forcedProcesses[0].pid -ne ${target.child.pid}) { throw 'Wrong force target' }
`)
    verification = await runPowerShell(script)
    const result = await verification.done
    assert.equal(result.code, 0, result.output)
    assert.equal(alive(target.child.pid), false)
    assert.equal(alive(other.child.pid), true)
    assert.equal((await fetch(`http://127.0.0.1:${other.port}`)).status, 200)
  } finally {
    if (verification?.child.exitCode === null) { verification.child.kill(); await verification.done }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done }
    await clean(root)
  }
})
