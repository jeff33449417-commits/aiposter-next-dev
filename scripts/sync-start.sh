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

# 2. Run static analysis, tests, and D1 migrations
echo "🔍 正在檢查專案結構與健康狀態..."
npm run check
echo "🗄️ 正在進行本地 D1 資料庫遷移 (Migrations)..."
npx wrangler d1 migrations apply aiposter --local

# 3. Start dev server
echo "🚀 正在啟動本機開發伺服器..."
if [ "$CLOUD_SHELL" = "true" ]; then
  echo "💡 偵測到於 Google Cloud Shell 環境執行，已自動將連接埠設為 8080 以配合網頁預覽 (Web Preview)。"
  npx wrangler dev --port 8080
else
  npm run dev
fi
