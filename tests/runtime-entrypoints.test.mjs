import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const entrypoint = new URL('../scripts/runtime/entrypoints/MindNProgress_Start.vbs', import.meta.url)
const consoleEntrypoint = new URL('../scripts/runtime/entrypoints/MindNProgress_Start.bat', import.meta.url)

test('시작 아이콘은 콘솔을 숨기고 재시작 완료 대기·브라우저 열기·실패 안내를 유지한다', async () => {
  const script = await readFile(entrypoint, 'utf8')
  assert.match(script, /WshShell\.Run\(Command, 0, True\)/)
  assert.match(script, /FileSystem\.BuildPath\(RootDirectory, "MindNProgress_Start\.bat"\)/)
  assert.match(script, /BatchPath & """ --hidden"""/)
  assert.doesNotMatch(script, /powershell\.exe|-Action restart|-AllowLegacyStop|-OpenBrowser/)
  assert.match(script, /If Result <> 0 Then\s+If WScript\.Interactive Then MsgBox/)
  assert.match(script, /WScript\.Quit Result/)
})

test('공통 배치는 같은 재시작 명령에서 숨김 옵션만 분기하고 결과를 보존한다', async () => {
  const script = await readFile(consoleEntrypoint, 'utf8')
  assert.match(script, /-Action restart -AllowLegacyStop -OpenBrowser/)
  assert.match(script, /set "MNP_WINDOW_OPTION=-WindowStyle Hidden"/)
  assert.match(script, /-NonInteractive %MNP_WINDOW_OPTION% -ExecutionPolicy/)
  assert.doesNotMatch(script, /wscript\.exe|cscript\.exe|\bstart\s+"/i)
  assert.match(script, /set "MNP_EXIT_CODE=%errorlevel%"/)
  assert.match(script, /if not defined MNP_HIDDEN \(\s+"%SystemRoot%\\System32\\timeout\.exe" \/t 0 \/nobreak >nul 2>&1 && \(\s+echo\.\s+echo Press any key to close this window\.\s+pause >nul\s+\)\s+\)\s+exit \/b %MNP_EXIT_CODE%/)
  assert.equal([...script.matchAll(/^\s*pause >nul\s*$/gm)].length, 1)
})

for (const scenario of [
  { name: '성공', controllerExitCode: 0 },
  { name: '실패', controllerExitCode: 7 },
  { name: '제어 스크립트 누락', controllerExitCode: null },
]) {
  test(`Windows 파이프 배치 격리 실행: ${scenario.name}`, { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
    // 공백과 특수 문자가 있는 설치 경로 및 다른 현재 디렉터리에서도 실행해야 한다.
    const directory = await mkdtemp(path.join(tmpdir(), 'mnp-console-restart space & bang!-'))
    const scripts = path.join(directory, 'MindNProgress', 'scripts')
    try {
      await mkdir(scripts, { recursive: true })
      const launcher = path.join(directory, 'MindNProgress_Start.bat')
      await writeFile(launcher, await readFile(consoleEntrypoint))
      await writeFile(path.join(directory, 'MindNProgress_Start.vbs'), await readFile(entrypoint))
      if (scenario.controllerExitCode !== null) {
        // 실제 서버·예약 작업·브라우저 대신 인수, 완료 대기, 표준 출력/오류 전달만 확인한다.
        await writeFile(path.join(scripts, 'mnp-runtime.ps1'), String.raw`param([string]$Action, [switch]$AllowLegacyStop, [switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
Write-Output '[preflight] fixture controller started'
Start-Sleep -Milliseconds 100
$result = @{ action = $Action; legacy = [bool]$AllowLegacyStop; browser = [bool]$OpenBrowser; directory = (Get-Location).Path }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'probe.json'), ($result | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output '[controller] fixture controller finished'
[Console]::Error.WriteLine('[diagnostic] fixture stderr')
exit ${scenario.controllerExitCode}
`)
      }
      const execution = promisify(execFile)(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), [
        '/d', '/s', '/c', `""${launcher}""`,
      ], {
        cwd: tmpdir(), windowsHide: true, windowsVerbatimArguments: true, timeout: 15_000,
      })
      // 파이프 입력을 닫아 대화형 콘솔이 없는 실행을 재현한다.
      execution.child.stdin.end()
      const result = await execution.then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
      )
      assert.equal(result.code, scenario.controllerExitCode ?? 1, `${result.stdout}\n${result.stderr}`)
      assert.doesNotMatch(result.stdout, /Press any key/i)
      assert.doesNotMatch(result.stderr, /Press any key/i)
      if (scenario.controllerExitCode === null) {
        assert.match(result.stdout, /Runtime controller is missing/)
        assert.doesNotMatch(result.stdout, /Restart complete|fixture controller/)
      } else {
        const probe = JSON.parse(await readFile(path.join(scripts, 'probe.json'), 'utf8'))
        assert.deepEqual(probe, { action: 'restart', legacy: true, browser: true, directory })
        assert.match(result.stdout, /\[preflight\] fixture controller started/)
        assert.match(result.stdout, /\[controller\] fixture controller finished/)
        assert.match(result.stderr, /\[diagnostic\] fixture stderr/)
        assert.match(result.stdout, scenario.controllerExitCode === 0 ? /Restart complete/ : /Restart failed\. Exit code: 7/)
        if (scenario.controllerExitCode !== 0) assert.doesNotMatch(result.stdout, /Restart complete/)
      }
    } finally {
      assert.equal(path.dirname(directory), tmpdir())
      assert.ok(path.basename(directory).startsWith('mnp-console-restart space & bang!-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
}

for (const exitCode of [0, 7]) {
  test(`Windows VBS → 공통 배치의 숨김 실행·종료 코드 ${exitCode} 전달`, { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mnp-hidden-restart space & bang!-'))
    const scripts = path.join(directory, 'MindNProgress', 'scripts')
    try {
      await mkdir(scripts, { recursive: true })
      const launcher = path.join(directory, 'MindNProgress_Start.vbs')
      await writeFile(launcher, await readFile(entrypoint))
      await writeFile(path.join(directory, 'MindNProgress_Start.bat'), await readFile(consoleEntrypoint))
      // 실제 제어 명령 대신 창 표시와 인수만 기록한다. 서버·예약 작업·브라우저는 조작하지 않는다.
      await writeFile(path.join(scripts, 'mnp-runtime.ps1'), String.raw`param([string]$Action, [switch]$AllowLegacyStop, [switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MnpConsoleProbe {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr window);
}
'@
$result = @{ visible = [MnpConsoleProbe]::IsWindowVisible([MnpConsoleProbe]::GetConsoleWindow()); action = $Action; legacy = [bool]$AllowLegacyStop; browser = [bool]$OpenBrowser }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'probe.json'), ($result | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
exit ${exitCode}
`)
      const execution = promisify(execFile)(path.join(process.env.SystemRoot, 'System32', 'wscript.exe'), ['//B', '//NoLogo', launcher], {
        windowsHide: true, timeout: 15_000,
      })
      if (exitCode === 0) await execution
      else await assert.rejects(execution, { code: exitCode })
      const result = JSON.parse(await readFile(path.join(scripts, 'probe.json'), 'utf8'))
      assert.deepEqual(result, { visible: false, action: 'restart', legacy: true, browser: true })
    } finally {
      assert.equal(path.dirname(directory), tmpdir())
      assert.ok(path.basename(directory).startsWith('mnp-hidden-restart space & bang!-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
}
