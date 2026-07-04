@echo off
title AI Poster 跨裝置同步啟動助手
cd /d "%~dp0\.."

echo =========================================
echo 🔄 AI Poster 跨裝置同步啟動助手 (Windows)
echo =========================================

:: 1. Check node_modules
if not exist node_modules (
  echo 📦 未偵測到依賴套件，正在執行 npm install...
  call npm install
) else (
  echo ✅ 依賴套件 (node_modules) 已準備就緒。
)

:: 2. Run static analysis and tests
echo 🔍 正在檢查專案結構與健康狀態...
call npm run check

:: 3. Start dev server
echo 🚀 正在啟動本機開發伺服器...
call npm run dev
pause
