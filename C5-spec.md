# WO-213 C5 · 承諾、後續檢查與保溫

基準為 `ef79d7a`。契約以 `CONTRACT.md` §4b 至已定 56 為準，開工時 MD5 為 `74677ba677142a0feef8551eb96a5713`。下列行號指基準的 `plugins/telegram-http/`。依據另含 connector facts §2a–2f、§3 C5、§4b、§5，設計第三版、coverage、inventory，以及 C1 規格與驗收紀錄。

## 寫入與收取

- 只在該成員的 C1 take 模式運作。沿用成員的 Onsen client、S2 的 `POST /v1/members/<name>/items`、markdown body、RFC 3339 時間、`Ref[]` 與穩定的 `Idempotency-Key`。Onsen 從認證決定 `from`。提早完成等待中的承諾走 `DELETE /v1/items/<id>`，帶實際版本與 `outcome:"completed"`。已領的列依 C1 的 claim 回報。
- `lanes.ts:4219,6748,6881` 的 followup 在原 thread／lane 留下 `self`，最早時間沿用工具算出的 due。一般「再看」沒有回覆期限。有明確承諾時，M3 的對象就是 waiter。寫入方保留原事件、鏈長、結果指紋與每串三筆上限，讓同一個結果停止下一筆，一條鏈預設最多四趟。`ItemPeek` 到點分流，既有接收器在交入時才領。既有 pull 的本機 followup 和已保存的排程仍須能處理。
- `lanes.ts:5810,6160,6740,6898,8045` 的主線／分身工具、已送出的承諾和收尾回執沿用 M3 的記錄與去重。實際收件人來自那次回覆或承諾，包含測試帳號與 peer。答應的時間寫在 `not_before`，說定的回報期限寫在 `deadline`；沒有約定時限的欄位留 null。提早做完的承諾要能按工具給的識別碼收掉。M3 本機到期掃描（`lanes.ts:6023`）對由 Item 處理的等待不再另推一次。
- 第四表與 §4b「agent 答應人的事」由 S4 產生一筆 `notice`，`reason=promise_due`、`about_item_id` 指承諾、收件人為 waiter。C5 只寫承諾與完成事實。C3 處理其他 M3 通知與舊催促。
- 依已定 23，保溫寫入者是連接器。`keepwarm-local.ts:162,248` 沿用主線 transcript 的最後一次動作、上次真正工作、快取及冷卻判斷。以同一個 idle stretch 為鍵寫一筆 `keepwarm` 給 main，`not_before = last_req + 50 分鐘`、`deadline=null`。冷了或距真正工作已達 24 小時不寫。成員自己的憑證完成寫入；交入由 C1 的 idle gate 決定。保溫本身不能重置「真正工作」時鐘。
- `server.ts:2236,3000` 的舊信箱到期／決定事件、保溫直送與每小時信箱提醒只為 pull 成員保留。信箱的列與已定 53 處理 take 的再交入。兩支 daemon 沿用 C1 的成員切換事實。agent-inbox 只設 tg 的開關即可辨識 take 這一點依賴平行的 C1 fix D11。收取時間與真資料形狀依賴 C1 的 D2/D4/D14。此步退休 L25、D11、D12、W6–W9 的連接器部分。漫遊者由 C6 接入。

## 驗收

1. 先獨立補 `test-fixtures/onsen-items.ts` 的 S2 寫入契約。驗證權限、可寫 kinds、時間、收件人預設值、欄位、相同鍵重送、換內容的衝突，及等待／已領／版本不符時的 DELETE。
2. 由主線實際送出回覆後的 M3 入口驗證「10 分鐘後回報」。以可控時鐘與本機假 Onsen 驗證只有一筆 self，waiter 為測試號，過期一次、重掃仍一次；提前完成時為零筆通知。檢查 peer、明訂 deadline 的工具與沒有時限的 followup。
3. 由 lane 工具查 thread 上限、chain 上限、相同結果、重啟後重讀與到期交入。相同 followup 不會同時由本機 tick 與 take 再交一次。保溫測 50 分鐘、60 分鐘冷掉、24 小時沒工作、忙碌、重送與下一次動作。pull 的舊測試沿用。
4. 本機測試只用 `127.0.0.1`、記憶體身分及空的 fleet config。daemon 測試連跑五輪。§3 真機 bench 由測試號傳給 lab 成員，收到承諾後查唯一的 self，未履約則測試號只收到一則；這一步需可送訊息的 S2/S4 測試台。
