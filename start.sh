#!/usr/bin/env bash
# ComfyUI Mobile 网关启动脚本（Linux / macOS / Git Bash）
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[错误 / Error] 未检测到 Node.js / Node.js not found. 请先安装 / Install it first: https://nodejs.org"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "[首次运行 / First run] 正在安装依赖 / Installing dependencies..."
  npm install --no-audit --no-fund
fi
echo "正在启动 ComfyUI Mobile 网关 / Starting ComfyUI Mobile gateway..."
exec node server/src/index.js
