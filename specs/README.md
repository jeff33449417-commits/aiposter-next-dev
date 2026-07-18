# specs/ — 模塊需求（Owner → Claude Code）

> 級別：P2　｜　狀態：Confirmed（依 `00_Control/CODE_REVIEW_PROTOCOL.md`）　｜　最後更新：2026-07-19

這個資料夾是**需求的唯一來源**。任何模塊在動工前，需求必須先寫成一份 spec 檔，
不能只寫在對話裡 —— 因為 Codex 與 Claude Code 是不同平台，看不到彼此的對話。

## 規則

- 一個模塊一份檔：`specs/<模塊名>.md`（例：`specs/auth-login.md`）。
- 由 **Owner** 定義需求（可請 Claude Chat / Cowork 協助草擬，但由 Owner 定稿）。
- Claude Code 從這裡讀需求，實作到 `feature/<模塊名>` 分支。
- Codex 審查時也從這裡讀需求，比對實作是否符合 spec。
- 需求變更就改這份檔並更新「最後更新」，不要口頭改。

## 新增一份 spec

複製 `_TEMPLATE.md`，改名為模塊名，填完每一段。空著的段落代表需求未定義，
未定義的需求不進入實作。

## 交接鏈

```
specs/<模塊>.md  →  feature/<模塊>（Claude Code 實作）  →  reviews/<模塊>-YYYY-MM-DD.md（Codex 審查）
```
