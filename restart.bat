@echo off
chcp 65001 >nul
rem ComfyUI Mobile gateway restart (also works as first start)
rem Run from this folder; double-click is fine.
cd /d "%~dp0"
setlocal

rem 网关端口：自动读 server/config.json 的 port，读不到就用默认 8899
set GWPORT=8899
for /f "usebackq delims=" %%p in (`node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('server/config.json','utf8')).port??8899))}catch(e){process.stdout.write('8899')}" 2^>nul`) do set GWPORT=%%p

echo.
echo ============ ComfyUI Mobile 网关重启 / Gateway restart ============
echo 端口 / Port: %GWPORT%
echo 正在查找旧网关进程 / Looking for an existing gateway process...

set FOUND=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%GWPORT% " ^| findstr /C:"LISTENING"') do (
    set FOUND=1
    echo   结束旧进程 / Stopping old process PID=%%a ...
    taskkill /PID %%a /F >nul 2>&1
)
if not defined FOUND echo   端口空闲，无需结束旧进程 / Port is free; no old process to stop. 等效首次启动 / Same as first start.

rem 等待端口释放
ping -n 2 127.0.0.1 >nul

rem 把本命令窗口隐藏到系统托盘 / Hide this console window into the system tray
rem 左键点托盘图标 = 显示/隐藏窗口（看日志）；右键 = 显示/隐藏、退出
if exist "%~dp0Tray.exe" "%~dp0Tray.exe" "ComfyUI Mobile Gateway"
echo 正在启动网关 / Starting gateway... 停止 / Stop: show the window from the tray icon, then press Ctrl+C
echo.
node server/src/index.js

echo.
echo 网关已退出 / Gateway exited. 若为异常退出，可把上方日志留在原处供排查 / Keep the log above if it crashed.
pause
