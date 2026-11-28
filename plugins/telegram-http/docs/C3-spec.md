# WO-213 C3 由 Onsen 計失敗、停領與通知等候者

基準為 `ef79d7a`，分支為 `wo213-c3`。開工時 `CONTRACT.md` 的 MD5 為 `74677ba677142a0feef8551eb96a5713`。依據為 §4b 三、四表及已定 3、35–37、43、49、52–55，connector facts §2e、§2f、§3 C3、§6 READS，design-v3、v3-coverage、inventory、C1 規格與驗收紀錄，以及 settled49-table。以下行號對應此基準的 telegram-http。

## 適用成員與交接

以 C1 動態探測成功的 `TakeMode.active` 決定本機交付方式。切換者先交完既有 pull 收件，保留這些工作的內容。新 Item 使用同一份 claim 與 spool。Onsen 決定失敗次數、退避、第三次停領、完成正常一件後放回一次、放回後再失敗作廢。連接器繼續提供狀態、回報和 keeper 的上限事實。S4 與 C3 的測試台驗收是第一隻正式成員切換的前提。

## d503fc6 審查修訂

審查修正開始時重讀 §4b，契約 MD5 為 `fbee7e7295a1e0e90e1b64ee753af7d9`。04:25Z 的裁決發布後複核，契約 MD5 為 `b95c0bb6a6fca963ec8af825ada122af`。N1 複審重讀已定 3、36 時的 MD5 為 `40948e23f6fa921174eac6c99ca87294`。以下行號對應 review-c3。

1. `lanes.ts:3956,4219` 各車道保存自己的拒絕時間。keeper 未顯示該車道的牆時，60 秒後放一筆真實工作探測。成功清除，再拒就從該次重算。主線的牆只適用於相符模型。
2. `lanes-main.ts` 的 `restartForReport` 以舊 PID 退出為準。第一次用精確的 tmux 名稱交給 wrapper 重開。舊 PID 過數秒仍活著就解除 hook 封鎖，後續重試直接給這個 PID `SIGTERM`。3 秒後檢查它是否仍在，並核對可讀到的行程啟動時間，再決定是否給 `SIGKILL`。測試讓舊行程留在同名新 session 外，確認新 TUI 存活，同一次卡住只報一次。
3. `lanes-main.ts:1228` 卡住時至少要成功記錄一筆持有中 claim 的 `stuck` 才重開。手打回合、本地列、過期 claim 均以回歸測試驗證。
4. `main-hook.py:190` 保留逐則漏答與工具結果未送出的內容判斷，同一次 Stop 合併提醒，對應的 claim 報 `owed`。本機及切換前的列也保留內容檢查。
5. `onsen-claims.ts` 每筆 `completed` 附上屬於該 claim 的回覆訊息 ID，涵蓋車道直接完成與提醒後完成。
6. `lanes.ts:3623,5281` 車道的工具等待依主線 hook 的工具 timeout 來源計時，涵蓋 MCP、WebFetch 與 Bash；工具結果進來後從最後活動重新計算沉默時間。
7. `onsen-take.ts` 的 `takeModeActive(mode)` 讀 C1 的 `TakeMode.active`，供 `followupTick` 與 `dueTick` 共用。收件 409 暫停領件，等模式探測確認 pull 才啟動舊計時器。測試包含暫停期間已到期的列。

Chiron 的 `RULINGS-20261128T0425Z.md` 第 2、3 題確認各車道的 60 秒探測與 take 收工的 `_missed` 內容檢查。第 4 題確認已定 37 的收件模式由 Onsen 在寫入時判斷。測試台另驗 relayed TUI alert 交值班員、main-menu 的 choose Action。

## 逐項盤點

| inventory | 入口（基準行號） | take 成員的處理與通知歸屬 |
|---|---|---|
| L2、L3、L5、L6、L9 | lanes-main.ts 648–852、1149–1280 | 活行程的回合無進展時，對已收下的列報 `stuck`，一次呼叫現有 /restart 的本機重開，行程結束報 `cut`、note「卡住重開」。一個 claim 只算一次。保留工具 timeout、狀態、kill-0 與 registry 判別。一般錯誤、Esc、換段走 C1 的 `error/cut/cut_person`。舊 main-stuck/unstuck、undelivered/delivered 由 S4 `cannot_move/recovered` 按等待者及 episode 發送。 `cut_twice`、`stop_failure_gave_up`（既有 tellClosed 已檢查模式）、停領提示和 asked-restart 由 S4 `parked/cancelled` 與指令的 Item 狀態承接。 |
| D4（通知）、D15、L4、L13、W4 | server.ts 1215–1255、2928–2951，usage-wall.ts 205–263，lanes-main.ts 268–287、468–533、1020–1048，lanes.ts 3900–3958、4105–4184 | 上限進出、主線及車道 wall-up/down 讀同一件 Item 的狀態，S4 對人的等待發 `cannot_move` 一則並在恢復時發 `recovered` 一則。停 WallAlerts 的本機 episode 計帳與限額 TUI 轉送。保留 keeper 讀取、上限選單和人的訊息被拒 60 秒後可領；取消車道的假探測回合。keeper 說通、真實交入又被拒報 `usage_limit_probe`，本機重開一次。keeper 外部的 W4 需由 keeper 維護者協調。 |
| L14、L16、L17、L22 | lanes.ts 3323–3454、3687–3828、5027–5147、5302、5644–5672 | 分身接收／steer 共用 C1 的 take。失敗、超時、額度截斷交還原 claim。關閉或交接報 `reassigned` 帶說明，尚未領的留在 Onsen。每列獨立回報，下一輪等 Onsen 重新給。切斷本機的 run retry、交回副本、信箱 budget 重排與孤立 steering 重送。 |
| L18、L19 | lanes.ts 2225、2321、6022–6068 | 停止本機 due、批次叫醒與追問。critical-due → S4 `alert_needs_person`（最高級無人接）；commitment/promise/answer-due → 人的承諾 `promise_due`，一般來件逾期告訴原 waiter。handoff/card-due → 等待／deadline 規則，交接時間本身不推 Joey。C5 寫 self/waiter。 |
| L27、L21 | lanes.ts 1931、2969–3036、3103 | 同一寄件人的呼叫併進同輪，各自回報。peer_hold 的列等解除再領。取消本機洗版計數、開始／結束推 Joey（第四表明列移除），相同警報的重送由 Item 事件表示，升為最高級依已定 52 成為另一列。 |
| 已定 37（A3–A5） | lanes.ts 的 `interimToPeer`、`stopThread`、`peerGate` | 交主線、對話線停止，以及 pull 洗版管制觸發時，分流器都沿用 `urgency: "silent"`、`no_reply: true` 回給原寄件人。這位收件人走 take 時，Onsen 在寫入時依已定 49 收掉回覆。走 pull 時照常交付。take 成員可從原列讀到 session、`reassigned` 及 note，逾期依第四表通知。 |
| L12、L23、L24、W1（connector） | lanes-main.ts 980–1004，lanes.ts 7250–7274、7313，lanes-hooks/main-hook.py 183–190 | 收工時缺回覆只列一次、報 `owed`，下一個確定的 Stop 報 `completed`，由 Onsen 算 answered。保留記憶決定、工具結果／內容檢查。獨立的 check_tg_reply 由 hook 維護者處理。 |
| W20 | inventory W20，外部 fleet-block-detector.py | S4 `fleet_same_cause` 依同一原因彙整。這支 launchd 程式與 keeper 的 usage_wall.py 均由各自專案維護。 |

main.tick 與 idleCheck 提供真實行程與 Esc 事實。take 的 dueTick、sweepQueue、floodTick 由原列到期／重新可領的事件接手。followupTick 與 keepwarm-local 的寫入替代由同批 C5 交付（§3），bare turn 的 resume 由 C4 交付。S3 投影與舊回條停寫由 C2 交付。C1-fix D1、D2／54、D4、D9、D12 分別涉及正常完成、交回主線、停領列重查、回報 spool 與 flood 重讀。

settled49-table 的 26 行中，A3–A5 見上表。A6 的 stall 由本機報 stuck 與重開或正式 alert 承接。A7–A8 依 C4，A9–A10 依 mail Item 與已定 53，A11 依原列，A12 依已定 52。其他行依原表的 Item、編輯、Notification 或本機內容路徑交付。

## 測試與驗收

用 loopback Onsen 與假的重開函式觀察正常入口。驗證卡住到行程退出的回報順序、同時多件只重開一次、無關 blocker、無直接推送、普通錯誤三次停領後只放回一次、上限與誤判、車道結束和收工只提一次。用既有 pull、C1 與 canary 測試檢查舊路徑。用空檔作 CRAB_LABS_PLUGINS_ENV，daemon 案例連跑五次。

已定 37 在本機檢查送往 inbox 的收件人及兩個欄位。take 的同事來電交主線或碰到對話線上限時，只需探測本成員的模式。pull 的洗版回覆也帶相同的靜默標記。

實際 S4 測試台按 facts §3 驗收。人的來件遇上限，測試號收到一次「在等、動不了」及一次解除。同一列連續三次 API 錯誤，只發一次停領通知，正常完成另一件後只放回一次。connector 側直接推送應為零。

本機驗證使用同一個人的 Item，在回報中看到一次 `usage_limit`、恢復後的 `in_session` 與 `completed`，connector 直推為零。三次 API 失敗後測試伺服器將原列標為 `parked`，正常完成另一列後只有一個 `released` 事件，再失敗的原因為 `gave_up`。正常結束仍欠回覆的主線與車道都只有一個 `owed`。S4 在人的收件匣實際產生幾列、橋接畫出幾則，仍須用 S4 與測試號驗收。

### 第四表通知對照

| 舊推送 | 接手者 |
|---|---|
| WallAlerts enter、main-wall-up、wall-up、main-undelivered、main-stuck | S4 `cannot_move`，人的來件依等待事件發一次 |
| WallAlerts clear、main-wall-down、wall-down、main-delivered、main-unstuck | S4 `recovered`，對應同一段等待 |
| cut_twice、stop_failure_gave_up、asked-restart | S4 依原列實際狀態發 `parked` 或 `cancelled`。人的指令沒有套上時發 `control_failed` |
| main-menu | 需要人選時由 Action 的 `choose` 通知處理 |
| critical-due | S4 按最高級警報的接手狀態發 `alert_needs_person` |
| commitment-due、promise-due、answer-due | 人的承諾走 `promise_due`。同事的問題逾期走原列的 waiter |
| handoff-due、card-due、peer-flood 開始／結束、一般 TUI 警告 | 第四表取消這些直推。交接與到期由原列表示，畫面警告歸值班員 |
| fleet-block-detector | S4 `fleet_same_cause`。舊 sender 在外部 W20 |
