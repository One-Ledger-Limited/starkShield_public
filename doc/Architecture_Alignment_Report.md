# StarkShield 架構一致性分析與修正報告

日期：2026-02-09

## 1. 比對基準

本次比對以以下文件作為「原設計基線」：
- `doc/Hackathon_Delivery_Playbook.md`

比對對象：
- `frontend/`
- `solver/`
- `contracts/`
- `docs/`

## 2. 一致性結論（摘要）

- **整體方向一致**：已具備 FE + Solver + Contract + Circuit 四層架構。
- **關鍵不一致已修正（本次）**：API 路由、anti-replay、expiry 校驗、deterministic matching、confirm/cancel 流程、correlation tracing。
- **仍保留為 deferred（符合黑客松策略）**：完整簽名驗證、完整合約級 replay/invariant、審計與法遵閉環。

## 3. 發現的不一致與處置

### A. API 命名與流程不一致
- 原狀：使用 `/intent` 等舊路由，缺少 `cancel`、`confirm`。
- 基線要求：`/v1/intents`、`/v1/intents/{id}/cancel`、`/v1/matches/{id}/confirm`。
- 處置：已新增 `/v1/*` 路由並保留舊路由 alias。

### B. Replay/Expiry 保護不足
- 原狀：缺少 `(user, nonce)` 保護；`deadline` 檢查不完整。
- 基線要求：nonce + expiry 防重放。
- 處置：新增 Redis nonce reservation；提交時強制 `deadline > now`。

### C. 撮合規則不夠 deterministic
- 原狀：Hash set 迭代順序不穩定，且可重複配對風險。
- 基線要求：可預期、可重現的匹配策略。
- 處置：改為穩定排序 + 決定性選擇（surplus、time、nullifier tie-breaker）。

### D. Settlement 觸發時機不一致
- 原狀：匹配後立即自動 settlement。
- 基線要求：支持確認流程。
- 處置：改成 `confirm` API 觸發 settlement。

### E. Traceability 不足
- 原狀：缺少 correlation id。
- 基線要求：操作可追蹤。
- 處置：新增 `x-correlation-id` 支援與回傳。

## 4. 本次實際修改檔案

- `solver/src/models.rs`
- `solver/src/storage.rs`
- `solver/src/matcher.rs`
- `solver/src/api.rs`
- `solver/src/starknet.rs`
- `docs/architecture.md`
- `solver/Cargo.toml`
- `frontend/package.json`
- `tests/package.json`
- `CHANGELOG.md`

## 5. 尚未完全一致（建議保留到下一階段）

- 前端仍有部分 mock/直連合約流程，未全面改為 solver API 為主。
- 合約層錯誤碼、事件欄位尚未完全對齊 playbook 的 forensics 結構。
- 完整簽名驗證目前僅做到欄位存在校驗，未做密碼學驗簽。

## 6. 我接下來的工作安排

### Wave 1（今天可做）
1. FE 改為統一調用 solver v1 API（submit/query/cancel/confirm）。
2. 移除/替換 UI 中 mock intent 資料來源。
3. 補前端錯誤碼映射檔（統一提示文案）。

### Wave 2（1-2 天）
1. 補 solver API 單元測試（expiry/replay/cancel/confirm）。
2. 補整合測試（happy path + adversarial basic）。
3. 整理 deploy 前檢查清單與 deploy 後健康檢查腳本。

### Wave 3（黑客松前）
1. 合約事件與錯誤碼最小對齊。
2. benchmark 報告模板（public vs shielded）。
3. demo runbook + known limitations 文件。
