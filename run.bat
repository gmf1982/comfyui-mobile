@echo off
chcp 65001 >nul
title ComfyUI Mobile Gateway
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)
set NODEMAJOR=
for /f %%v in ('node -p "parseInt(process.versions.node)" 2^>nul') do set NODEMAJOR=%%v
if not defined NODEMAJOR set NODEMAJOR=0
if %NODEMAJOR% LSS 20 (
  echo [错误] Node.js 版本过低（当前 v%NODEMAJOR%），本项目需要 20 及以上，请安装 LTS 版：https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo [首次运行] 正在安装依赖...
  call npm install --no-audit --no-fund
)
echo 正在启动 ComfyUI Mobile 网关...
node server\src\index.js
pause
