# reviews/ — 審查報告（Codex → Owner）

> 級別：P2　｜　狀態：Confirmed（依 `00_Control/CODE_REVIEW_PROTOCOL.md`）　｜　最後更新：2026-07-19

這個資料夾是 **Codex 審查報告的唯一去處**。Codex 是審查者，**只評論、不改 code**；
它的產出就是這裡的一份報告。

## 規則

- 一次審查一份檔：`reviews/<模塊名>-YYYY-MM-DD.md`（例：`reviews/auth-login-2026-07-20.md`）。
- 內容用 `_TEMPLATE.md` 的固定格式，**強制產出結論**（通過／不通過），不接受「看起來沒問題」。
- 「我不同意實作者的地方」這段**不可留白**。長期留白代表審查沒有真的在做。
- 有分歧時不要和 Claude Code 私下取得共識 —— 兩邊意見都寫進報告，**升級給 Owner 裁決**。
- Codex 看不到 Claude Code 未 push 的東西。審查前先確認 `feature/<模塊>` 已 push。

## 通過標準（全部成立才可合併 main）

1. 五項必查全部通過（或標 N/A 並附理由）
2. 阻擋項全部清空
3. 測試實際跑過，結果已記錄（不是宣稱）
4. 分歧項已由 Owner 裁決
5. Owner 核准
