# AGENTS — 本 repo 的 AI 協作契約

> 級別：P2（程式碼與 spec）
> 狀態：Confirmed（依 `00_Control/CODE_REVIEW_PROTOCOL.md` v0.1、`AGENTS.md` v0.2，Owner 核准 2026-07-18）
> 最後更新：2026-07-19
> 權威來源：iCloud `Project Phoenix workspace/00_Control/`。本檔為治理層在程式 repo 內的落地版，**衝突時以 00_Control 為準**。

Codex、Claude Code，以及任何在這個 repo 工作的 AI，動手前都要先讀完本檔。

---

## 0. 這個 repo 是什麼

| 項目 | 內容 |
|---|---|
| 名稱 | `aiposter-next-dev` |
| 定位 | **正式站原始碼**：`my.aiposter.jp` / `my.aiposter.tw` |
| GitHub | `jeff33449417-commits/aiposter-next-dev` |
| 部署 | Cloudflare Worker `aiposter-new`；renderer 走 GitHub Actions |
| 技術 | HTML + 前端 JS + Cloudflare Workers（D1/KV/R2/Queues + renderer Worker/Container） |
| 市場 | Phase 1：JP（主）／TW（次） |
| 常用分支 | `main`、`v2-dev`（開發），另有 `fix/*`、`test/*`、`codex/*` |

> ⚠️ **這是正式站，改動會影響線上使用者。** v2 預覽站是另一個 repo（`aiposter-v2` → `pv.aiposter.jp`）。要嘗試新東西優先在 v2。

> 🔴 **待辦（Owner）：此 repo 目前為 Public，需改為 Private。** 在 GitHub → Settings → General → Danger Zone → Change visibility。此動作需在 GitHub 網頁操作，AI 無法代勞。

---

## 1. 兩個角色，職責必須不對稱

| | Claude Code | Codex |
|---|---|---|
| 角色 | **實作者** | **審查者** |
| repo 權限 | `feature/*` 分支寫入，**不可直接推 main** | **唯讀 + 評論，不改 code** |
| 產出 | 程式碼 + 測試 | `reviews/` 的審查報告 |
| 金鑰 | 可（本機執行，讀 `.dev.vars` / Keychain） | **不可讀取任何金鑰** |

**為什麼 Codex 不改 code**：審查者能直接改就會傾向順手改掉而非指出問題，Owner 失去發現分歧的機會。**分歧本身是有價值的訊號。**

---

## 2. 檔案是唯一交接介面

Codex 和 Claude Code 看不到彼此的對話。需求寫 `specs/<模塊>.md`，審查寫 `reviews/<模塊>-YYYY-MM-DD.md`。**Claude Code 未 push 的內容 Codex 看不到。**

---

## 3. 流程

```
1. Owner 定義需求         →  specs/<模塊>.md
2. Claude Code 實作 + 測試 →  push 到 feature/<模塊>
3. Codex 審查             →  reviews/<模塊>-YYYY-MM-DD.md
4. 有阻擋項？             →  回步驟 2
5. 兩邊有分歧？           →  Owner 裁決（結果寫入 DECISION_LOG.md）
6. Owner 核准             →  合併 main
```

⚠️ 步驟 5 不可省略。**不直接推 main** —— 對正式站尤其重要。

---

## 4. 五項必查（每個模塊都要，不可跳過）

完整清單見 `00_Control/CODE_REVIEW_PROTOCOL.md §3`。摘要：

1. **金鑰洩漏** — 前端 bundle 無金鑰（`grep -riE "sk-|api[_-]?key|secret" dist/`）；`.env`/`.dev.vars` 未進 git；第三方 API 走後端代理。
2. **市場資料隔離（最高風險）** — 每筆資料含 `market`；查詢帶 market 過濾；market 由**後端 session 取得，不從 request 參數取**；JP 帳號取不到 TW 資料。
3. **權限檢查** — 每個端點驗證身分；後端強制；越權回 404 非 403。
4. **四語支援** — 無字串拼接；具名參數完整句；`ja`/`en`/`zh-TW`/`cs` key 一致；法律文字依市場。
5. **個資處理（GDPR 基準）** — 讀取／匯出留 log；有刪除機制；同意紀錄可查；保留期限有定義。

### 本 repo 高風險項

正式站、雙市場、含登入與匯出。**最高風險是第 2（市場資料隔離）與第 3（權限檢查）**，且因正式對外，第 5（個資）比預覽站更需嚴格。

---

## 5. 審查報告格式（強制）

用 `reviews/_TEMPLATE.md`。**「我不同意實作者的地方」不可留白。**

---

## 6. 通過標準（全部成立才可合併 main）

1. 五項必查全部通過（或標 N/A 附理由）　2. 阻擋項清空　3. 測試實際跑過並記錄　4. 分歧已由 Owner 裁決　5. Owner 核准

---

## 7. 安全鐵律（見 `00_Control/SECURITY_RULES.md`）

- 三層金鑰防護：`.gitignore`（layer 1）／pre-commit（layer 2）／pre-push（layer 3），三層都要開。
- 金鑰絕不進 git、絕不進任何 AI 對話、絕不進前端 bundle。Cloudflare secret 放平台。
- repo 絕不放 iCloud；程式碼在 `~/Projects`，金鑰只留本機。
- 🔴 此 repo 需由 Public 改 Private（見 §0）。

---

## 8. 給 Codex 的話（你正在讀這個 repo）

- 你是**審查者**：唯讀 + 評論，**不改 code、不讀金鑰**。
- 從 `specs/<模塊>.md` 讀需求，結論寫進 `reviews/<模塊>-日期.md`。
- 把「我不同意實作者的地方」明確寫出來。**分歧升級給 Owner。**
- 這是正式站：任何觸碰認證、市場過濾、匯出配額的改動，從嚴審查。

## 9. 給 Claude Code 的話（你是實作者）

- 開工前 `git pull --rebase`；完成／換機器／交接前務必 push。
- 每個模塊在 `feature/<模塊>`，**不推 main**。
- 提交前跑專案既有驗證（`npm run check`、`npm test`、`wrangler deploy --dry-run`），結果據實記錄。
- 部署是正式動作，由 Owner 決定時機（renderer 走 GitHub Actions）。不自行部署。
