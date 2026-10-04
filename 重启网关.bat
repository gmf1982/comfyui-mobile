@echo off
rem ComfyUI Mobile gateway restart (also works as first start)
rem Run from this folder; double-click is fine.
cd /d "%~dp0"
setlocal

rem 网关端口：自动读 server/config.json 的 port，读不到就用默认 8899
set GWPORT=8899
for /f "usebackq delims=" %%p in (`node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('server/config.json','utf8')).port??8899))}catch(e){process.stdout.write('8899')}" 2^>nul`) do set GWPORT=%%p

echo.
echo ============ ComfyUI Mobile 网关重启 ============
echo 端口：%GWPORT%
echo 正在查找旧网关进程...

set FOUND=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%GWPORT% " ^| findstr /C:"LISTENING"') do (
    set FOUND=1
    echo   结束旧进程 PID=%%a ...
    taskkill /PID %%a /F >nul 2>&1
)
if not defined FOUND echo   端口空闲，无需结束旧进程（等效首次启动）。

rem 等待端口释放
ping -n 2 127.0.0.1 >nul

echo 正在启动网关（停止：在本窗口按 Ctrl+C）...
echo.
node server/src/index.js

echo.
echo 网关已退出。若为异常退出，可把上方日志留在原处供排查。
pause
