#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js（建议 22 LTS）：https://nodejs.org/"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm。请确认 Node.js 安装完整。"
  exit 1
fi

echo "==> Node $(node -v) / npm $(npm -v)"
echo "==> npm install"
npm install

echo "==> npm run typecheck"
npm run typecheck

echo "==> npm run build:electron"
npm run build:electron

echo ""
echo "本地构建完成。启动桌宠："
echo "  cd \"$ROOT\" && npm run electron"
echo "启动看板（另开终端）："
echo "  cd \"$ROOT\" && npm run dashboard"
