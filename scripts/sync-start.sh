#!/bin/bash
set -e

# Change directory to project root
cd "$(dirname "$0")/.."

echo "========================================="
echo "🔄 AI Poster 跨裝置同步啟動助手"
echo "========================================="

# 1. Check node_modules
if [ ! -d "node_modules" ]; then
  echo "📦 未偵測到依賴套件，正在執行 npm install..."
  npm install
else
  echo "✅ 依賴套件 (node_modules) 已準備就緒。"
fi

# 2. Run static analysis and tests
echo "🔍 正在檢查專案結構與健康狀態..."
npm run check

# 3. Start dev server
echo "🚀 正在啟動本機開發伺服器..."
npm run dev
