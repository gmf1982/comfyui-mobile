@echo off
rem Install Windows scheduled tasks that keep the ComfyUI Mobile gateway running.
rem
rem Creates two user-level tasks (no admin required, no stored password, runs as
rem your own account; tasks are visible in Task Scheduler and removable):
rem   1. "ComfyUI Mobile Gateway"           - starts at logon
rem   2. "ComfyUI Mobile Gateway KeepAlive" - retries every 5 minutes (self-heals crashes)
rem Both run scripts\autostart-check.js, which does nothing while the gateway is
rem healthy and spawns it detached when it is down. Gateway log: logs\gateway.log.
rem
rem Note: tasks run only while you are logged on (Windows fast startup/lock screen
rem is fine). To survive reboots while away, enable Windows auto-logon, or create
rem the tasks with /RU SYSTEM yourself (requires admin).
rem Uninstall: scripts\uninstall-autostart.bat
setlocal
cd /d "%~dp0.."
set "ROOT=%cd%"
set "VBS=%ROOT%\scripts\gateway-keepalive.vbs"

set "NODEEXE="
for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%n"
if not defined NODEEXE (
  echo [error] node.exe not found in PATH. Install Node.js first.
  exit /b 1
)

rem /TR quoting: backslash-escaped inner quotes keep paths with spaces intact
schtasks /Create /F /TN "ComfyUI Mobile Gateway" /SC ONLOGON /TR "wscript.exe \"%VBS%\" \"%NODEEXE%\""
if errorlevel 1 (
  echo [warn] logon task creation failed - it needs admin rights; skipped.
  echo        The 5-minute keepalive task below alone is sufficient.
)
schtasks /Create /F /TN "ComfyUI Mobile Gateway KeepAlive" /SC MINUTE /MO 5 /TR "wscript.exe \"%VBS%\" \"%NODEEXE%\""
if errorlevel 1 (
  echo [error] failed to create keepalive task.
  exit /b 1
)

echo Running one keepalive check now (starts the gateway if it is down)...
wscript.exe "%VBS%" "%NODEEXE%"
echo Done. The gateway now survives logoff/reboot: it starts at logon and
echo self-heals within 5 minutes whenever it is found down.
endlocal
