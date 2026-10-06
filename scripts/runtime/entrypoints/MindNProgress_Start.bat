@echo off
rem AI MAINTENANCE: This BAT owns shared startup settings for both BAT and VBS.
rem No arguments: console output, pausing only when the run fails. --hidden: hidden execution without pause.
rem MindNProgress_Start.vbs only invokes this BAT with --hidden and reports failure.
rem Edit controller options here; keep lifecycle logic in MindNProgress\scripts\mnp-runtime.ps1.
rem When changing the hidden option or exit-code contract, update BOTH BAT and VBS.
rem Keep BOTH installation-root files synchronized with their respective repository templates
rem under scripts/runtime/entrypoints/ (same filenames).
setlocal EnableExtensions DisableDelayedExpansion
set "MNP_EXIT_CODE=1"
set "MNP_HIDDEN="
set "MNP_WINDOW_OPTION="
if "%~1"=="" goto run
if /i not "%~1"=="--hidden" goto usage
set "MNP_HIDDEN=1"
set "MNP_WINDOW_OPTION=-WindowStyle Hidden"
if not "%~2"=="" goto usage

:run
pushd "%~dp0"
if errorlevel 1 goto directory_error
set "MNP_CONTROLLER=%~dp0MindNProgress\scripts\mnp-runtime.ps1"
if not exist "%MNP_CONTROLLER%" goto missing_controller

echo [MindNProgress] Restarting. The browser opens when the server is ready.
echo.
rem The runtime controller prints Korean text. On the default CP949 console that
rem output is mojibake for callers reading it as UTF-8 (pipes, log capture), so
rem run under UTF-8 and restore the previous code page afterwards.
set "MNP_PREV_CP="
for /f "tokens=2 delims=:" %%p in ('chcp') do set "MNP_PREV_CP=%%p"
set "MNP_PREV_CP=%MNP_PREV_CP: =%"
set "MNP_PREV_CP=%MNP_PREV_CP:.=%"
chcp 65001 >nul 2>&1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive %MNP_WINDOW_OPTION% -ExecutionPolicy Bypass -File "%MNP_CONTROLLER%" -Action restart -AllowLegacyStop -OpenBrowser
set "MNP_EXIT_CODE=%errorlevel%"
if defined MNP_PREV_CP chcp %MNP_PREV_CP% >nul 2>&1
echo.
if "%MNP_EXIT_CODE%"=="0" (
  echo [MindNProgress] Restart complete.
) else (
  echo [MindNProgress] Restart failed. Exit code: %MNP_EXIT_CODE%
  echo [MindNProgress] Check "%~dp0.mindnprogress\runtime-operations.jsonl" and "%~dp0.mindnprogress\dev.err.log".
)
goto finish

:missing_controller
echo [MindNProgress] Runtime controller is missing: "%MNP_CONTROLLER%"

:finish
popd
goto done

:directory_error
echo [MindNProgress] Cannot access installation directory: "%~dp0"
goto done

:usage
echo [MindNProgress] Usage: MindNProgress_Start.bat [--hidden]

:done
rem Keep the window open only when the run failed, so a successful start closes
rem by itself. Under --hidden the console exists but nobody sees it, and without
rem console input (scheduled task, pipe) pause would block forever. timeout.exe
rem is called by full path because PATH may resolve timeout to the Git Bash
rem coreutils build. This covers every failure path, including usage errors.
if not "%MNP_EXIT_CODE%"=="0" (
  if not defined MNP_HIDDEN (
    "%SystemRoot%\System32\timeout.exe" /t 0 /nobreak >nul 2>&1 && (
      echo.
      echo Press any key to close this window.
      pause >nul
    )
  )
)
exit /b %MNP_EXIT_CODE%
