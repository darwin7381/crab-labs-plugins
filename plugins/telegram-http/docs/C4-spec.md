# WO-213 C4 主線被打斷後的 resume Item

原始規格與以下 `plugins/telegram-http/` 行號以 `ef79d7a` 為基準。C4 審查修正版以 `origin/wo213-c5` 的 `38a6d46` 為基準，透過 C5 的 `takingItems()`、`recordItemWrite` 與 `writtenItemId` 共用寫入與回條。契約取自 2026-11-28 的 `onsen-ui/CONTRACT.md` §4b，啟動時 MD5 為 `74677ba677142a0feef8551eb96a5713`（已定至 56）。

## 產生與交入

- `lanes-main.ts:775,815,835,1046` 是 WO-209 分辨裸回合與有 item 回合的地方。只有本成員的 C1 `TakeMode.active` 生效才把裸回合的非帳號錯誤、用量上限、非刻意的行程結束寫成一列。已有 item 的回合照它的 claim 回報。使用者要求的 restart 沿用原判斷。
- S2 的 `POST /v1/members/<member>/items` 寫 `kind:"resume"`、`session_id:"main"`、`body:{format:"markdown",text:…}` 和 `refs:[]`。非上限錯誤的 `not_before` 是原本的 `cut.retry_at`。上限等待 keeper 解除，行程中斷等待可接收的主線，兩者省略這個欄位。同一段對話一次只等一列 resume。新的 prompt 在上限解除前又被拒時，沿用尚未交入的列。該列的建立請求保留同一把 Idempotency-Key，包含回應遺失、程式重新啟動的情況。
- `lanes-main.ts:579` 的台北時間、錯誤原因、正數背景工作數和不用回覆的通知共用同一個產生處。C1 的 peek（`onsen-items.ts:88`）按到期時間取得參照，經 `server.ts:4965` 依 kind 與寄件成員辨認自己的 resume，將它送到主線，M1 在可交入時才 take（`lanes-main.ts:462,539`），用既有的綁定、續約與完成回報。pull 成員繼續使用 WO-209 的本機通知及 receipt。切換時尚未交出的舊 cut 只能走一次。

## 已定 59 與 04:25Z 裁決

本輪開始時，含已定 59 的契約 MD5 為 `344b1d81510951fa1055bf04780e68ce`。

1. 還在等的 resume 原句跟著交給同一段 session 的下一列，包含閒置時的 stream 通知、工具邊界的 additionalContext 與 Stop 拉入的列。用交付的 receipt 記下帶的是哪一個 resume。帶過原句的回合正常 final Stop 才以版本化的 DELETE 送 `withdrawn`。沒有交入、Stop 被擋、或回合失敗時仍等。直接領取 resume 則依它自己的 claim 完成。
2. 背景工作的結束通知會開另一個回合。那個回合本身不作廢原 resume；若它後來收下另一列附帶的提示，適用同一條 final Stop 規則。
3. 通知已寫進 Claude Code 的輸入佇列時，可能在自行續跑之後才進入回合。收到原句的回合照一般的 `in_session`、`completed` 回報。原 claim 的 20 秒期限到時，若另一回合仍在跑，先以 `not_taken` 釋放。晚到的 delivery id 可重新領取並回報，不再寫入串流。若它仍未交入，自行續跑的回合在期限前已結束、釋放後達到 M2 的兩次閒置確認、或原對話結束時，回報 `superseded`。
4. S2 請求省略選填欄位等同傳 `null`，回應保留可空欄位。POST 的內文讀自 `payload.text`，有格式時讀 `payload.format`。

## Claude Code 自己繼續

`lanes-main.ts:857,914` 能分辨主線開了回合，以及哪一列實際交入。同一段對話自行續跑被打斷的工作時，會作廢尚未交入的 resume。子代理的 hook、session 註冊、背景通知、重複錯誤通知都不足以證明主線自己繼續。claim 已有 in_session_at，或 M1 有 bound、done 記錄的 resume 已交入。背景通知回合與 final Stop 後等待 registry 結算的幾秒，都讓原 claim 正常完成。prompt 帶的 delivery id 可追到同一個 Onsen item id。補領失敗時仍能辨認是哪一列開的回合。若第一個 hook 是工具或 Stop，則以該代已交出的列和持有的 claim 綁定。

M2 保存中斷與列的關聯。resume、self、keepwarm 的建立與 DELETE 共用一種 Item spool 記錄，舊的 C5 self 記錄照樣重播。回應遺失時以原鍵重送。永久拒絕的寫入移到 rejected，記一次 log，其他 resume 仍可交入。等待中的列用 `DELETE /v1/items/<id>`，送 `expected_version` 與 `outcome:"superseded"`。版本衝突時重讀該列。已領的用 C1 的 claim 與 report spool 送同一 outcome。兩者都成為 `cancelled/superseded`。建立、領走與 hook 可以交錯，重連後仍要保留作廢的決定。已定 55 的失敗數由 Onsen 計算，逾期後才到的中途回報只記事件。

## 清單與驗收

事實檔 §3 C4 退休的是 **W12 在連接器這一側的需求**，涵蓋設計第三張表「三明治大師停 35 分」。已定 37 的兩句 watchdog 提示「你的 session 重啟…」「你撞到用量上限」由這一列承接。watchdog 程式的退場屬於它的擁有者。漫遊者依事實檔 §5 由 C6 切換。

1. 先獨立提交 loopback fake（`test-fixtures/onsen-items.ts:90`）及 HTTP 合約測試。驗 POST 去重、作者、欄位與時間，DELETE 的作者、版本與 kind 限制，亦驗已領的 superseded、過期與已定 55。
2. 用主線 hook、C1 的 peek/take 及 report 驗出錯時立刻出現一列、到點前零交入、到點後原句一次。涵蓋上限解除、行程結束、仍有背景工作、已有 item、等待中及領走時自己繼續、重送及重啟。既有 WO-209 pull 測試原樣重跑。
3. 事實檔 §3 的 txmonster 驗收由負責人於 S2 就緒時執行。在 lab 的無 item 回合製造非上限 StopFailure，讀到唯一的 resume 與退避時間，到點後看到 take 和原句。另一次讓 Claude Code 在上限重置後自行續跑，查同一列為 cancelled/superseded，對話沒有第二次交入。

C1 並行修正提供正式資料的 list/detail 形狀（D2）、重送及伺服器時鐘校正（D8、D14），以及正常 Stop 後的 registry 結算（D1）。這一步使用 C1 介面，實體 S2 與 C1 修正合併後再由 lab 驗證。
