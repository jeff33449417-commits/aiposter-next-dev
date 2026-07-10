# AI Poster — 兩個獨立 App 的架構與邊界（交接筆記）

> **最重要規則:`my.aiposter.jp` 與 `pv.aiposter.jp` 是兩個完全獨立的產品。
> 它們的代碼永不互相合併、複製或污染。** 任何 AI 或人接手前，先讀這頁。

## 兩個 App 一覽

|  | **my.aiposter.jp / .tw** | **pv.aiposter.jp** |
|---|---|---|
| 產品 | 15 秒影片海報產生器 | 店面 AI Mockup（實境合成圖） |
| Cloudflare Worker | `aiposter-new` | `aiposter-v2` |
| GitHub Repo | `jeff33449417-commits/aiposter-next-dev`（public） | `jeff33449417-commits/aiposter-v2`（private） |
| 本機路徑 | `~/Documents/Codex/2026-06-26/aiposter-next-dev` | `~/aiposter-v2` |
| 主要分支 | `v2-dev` | `main` |
| 該有 AI Mockup 嗎？ | ❌ **不該有** | ✅ 那是它的核心功能 |

## 硬規則（不可違反）

1. **各自獨立**：my.aiposter.jp 的代碼只在 `aiposter-next-dev`；pv.aiposter.jp 的代碼只在 `aiposter-v2`。
2. **不互通**：絕不把一邊的代碼合併／複製到另一邊；絕不用一邊的 repo 部署到另一邊的 worker。
3. **不 force-push**：`aiposter-next-dev/v2-dev` 已設 GitHub 分支保護（禁 force-push、禁刪分支）。`aiposter-v2` 為私有、免費方案無法設保護，改以「只有 Jeff 帳號能推 + 協調規則」把關。
4. **Jeff 是唯一把關者**：未經 Jeff 明確同意，任何 AI 不得改動、push 或部署。
5. **唯一協作層是 git + GitHub**：不要把 Google Drive 當共用工作區（Drive 會弄壞 `.git`、且造成多份活副本互相污染）。

## 成本與 Secrets

- **不使用 Google Cloud**（Vertex Imagen / Google Translate）——付費死代碼已移除，`tests/ai-mockup.test.mjs` 會擋回任何重新引入。新功能優先走 **Cloudflare 原生 / 免費 / 純前端**。
- Secrets 只放 Cloudflare / GitHub，永不寫進被追蹤的檔案。

## 部署

- **my.aiposter.jp**：在 `aiposter-next-dev` 跑 `NPM_CONFIG_CACHE=/private/tmp/codex-npm-cache npx wrangler deploy`（→ worker `aiposter-new`）。
- **pv.aiposter.jp**：在 `aiposter-v2` 由該線自行部署（→ worker `aiposter-v2`）。
- 每次改動先跑：`npm run check`、`npm test`、`wrangler deploy --dry-run`。未經 Jeff 明確指示不部署。

## 歷史備註（2026-07-10 整頓）

- 曾有 session 把 pv 代碼 force-push 到 `aiposter-next-dev/v2-dev`（污染）。已還原成乾淨的 my.aiposter.jp（commit `4bc4d60`，無 mockup）。污染狀態存於 tag **`pre-restore-pv-contamination`**（可回溯）。
- 多餘的本機／Google Drive 活代碼副本已全部退役（移入垃圾桶，可救回）。此後只保留上表兩個正式 repo 作為活代碼來源。
