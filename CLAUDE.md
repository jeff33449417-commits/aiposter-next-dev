# CLAUDE.md — aiposter-next-dev 實作者交接

> 給 **Claude Code（實作者）**。協作規則（角色、五項必查、審查流程）見 `AGENTS.md`。
> 本檔只講技術現況。級別：P2　｜　最後更新：2026-07-19

編輯前先讀本檔。改動保持小、可測試、易部署 —— **這是正式站**。

## 這個 repo 是什麼

- 定位：**正式站原始碼** `my.aiposter.jp` / `my.aiposter.tw`
- GitHub：`jeff33449417-commits/aiposter-next-dev`（🔴 目前 Public，Owner 待改 Private）
- 本機：`~/Projects/aiposter-next-dev`（**不放 iCloud**）
- 部署：Cloudflare Worker `aiposter-new`；renderer 走 GitHub Actions
- 常用分支：`main`、`v2-dev`（開發走 `feature/*`）

> v2 預覽站是另一個 repo：`aiposter-v2` → `pv.aiposter.jp`。新東西優先在 v2 試。

## Source Map

- `src/index.js` — 主 Cloudflare Worker API、admin UI、queue consumer、MP4 job 協調、R2/D1/KV 存取。
- `public/index.html` — 前端（含編輯器；此 repo 的 index.html 較大）。
- `renderer/server.js` — Node/FFmpeg renderer 服務；`renderer/Dockerfile` — renderer 容器。
- `src/renderer-worker.js` — Cloudflare Container proxy for renderer。
- `wrangler.jsonc` — 主 Worker 設定；`wrangler.renderer.jsonc` — renderer 設定。
- `migrations/` — D1 schema 與 queue guardrail migrations。
- `scripts/deploy-main.sh`、`scripts/deploy-renderer.sh` — 部署腳本。
- `.github/workflows/deploy-renderer.yml` — renderer 的 GitHub Actions。

## 提交前必跑

```bash
npm install                  # 第一次
npm run check                # 若專案有此 script
npm test                     # 若專案有測試
npx wrangler deploy --dry-run
```

預期：dry run 以 `--dry-run: exiting now.` 結束並列出 bindings。

## 部署（正式動作，由 Owner 決定時機）

- 主 App：`npx wrangler deploy`（或 GitHub Actions「Deploy AI Poster Main App」，ref 用 `v2-dev`）。
- Renderer：GitHub → Actions → `Deploy AI Poster Renderer` → Run workflow。
- 本機 renderer 部署在無 Docker 的機器上可能失敗。

## 已知產品／UX 規則

- 輸出必須是 `.mp4`，不是 `.html`。
- MP4 固定 15 秒、60 fps、540p 級距（`EXPORT_MAX_LONG_SIDE = 960`）。
- 上傳上限 `MAX_VIDEO_UPLOAD_MB=10`。
- 不要出現可見的 Turnstile／人機驗證或 timeout 文字。
- 只顯示目前匯出進度，不顯示舊的 stale job。
- 手機編輯（圖／影片／文字圖層移動縮放）必須可用；匯出不抖動。

## 不 commit secret

`RENDERER_TOKEN`、`RENDERER_URL`、`TURNSTILE_SECRET_KEY`、`CLOUDFLARE_API_TOKEN` 等放 Cloudflare/GitHub secret，不寫進 tracked 檔。

## 有用的除錯端點

`/api/health`、`/api/me`、`/api/jobs`、`/api/jobs/:jobId`、`/api/jobs/:jobId/output`、`/admin`（受 admin 角色限制）。
