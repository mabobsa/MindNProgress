@echo off
setlocal EnableExtensions

if "%~1"=="" (
  echo Usage: %~nx0 "%~dp0..\MindNProgress_Backup\YYYY-MM-DD\MindNProgress_YYYY-MM-DD_HHmmss.zip"
  exit /b 1
)

set "SCRIPT=%~dp0scripts\restore-data.ps1"
if not exist "%SCRIPT%" (
  echo [MindNProgress] Restore script not found: %SCRIPT%
  exit /b 1
)

rem %~dp0 ends with a backslash and PowerShell -File reads the trailing \" as an
rem escaped quote, which made every run fail with "Illegal characters in path".
rem Pass the project directory without the trailing separator.
set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

rem The restore script prints Korean text. On the default CP949 console that
rem output is mojibake for callers reading it as UTF-8 (scheduled tasks, pipes),
rem so run under UTF-8 and restore the previous code page afterwards.
set "PREV_CP="
for /f "tokens=2 delims=:" %%p in ('chcp') do set "PREV_CP=%%p"
set "PREV_CP=%PREV_CP: =%"
set "PREV_CP=%PREV_CP:.=%"
chcp 65001 >nul 2>&1

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -ArchivePath "%~1" -ProjectPath "%PROJECT_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"

if defined PREV_CP chcp %PREV_CP% >nul 2>&1

rem Pause only when a real console is attached. Without console input (scheduled
rem task, pipe) pause would block forever. timeout.exe is called by full path
rem because PATH may resolve timeout to the Git Bash coreutils build.
if not "%MNP_BACKUP_NO_PAUSE%"=="1" (
  "%SystemRoot%\System32\timeout.exe" /t 0 /nobreak >nul 2>&1 && pause
)
exit /b %EXIT_CODE%
