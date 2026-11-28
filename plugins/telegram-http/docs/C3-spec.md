# WO-213 C3 由 Onsen 計失敗、停領與通知等候者

基準為 `ef79d7a`，分支為 `wo213-c3`。開工時 `CONTRACT.md` 的 MD5 為 `74677ba677142a0feef8551eb96a5713`。依據為 §4b 三、四表及已定 3、35–37、43、49、52–55，connector facts §2e、§2f、§3 C3、§6 READS，design-v3、v3-coverage、inventory、C1 規格與驗收紀錄，以及 settled49-table。以下行號對應此基準的 telegram-http。

## 適用成員與交接

以 C1 動態探測成功的 `TakeMode.active` 決定本機交付方式。切換者先交完既有 pull 收件，保留這些工作的內容。新 Item 使用同一份 claim 與 spool。Onsen 決定失敗次數、退避、第三次停領、完成正常一件後放回一次、放回後再失敗作廢。連接器繼續提供狀態、回報和 keeper 的上限事實。S4 與 C3 的測試台驗收是第一隻正式成員切換的前提。

## 逐項盤點

| inventory | 入口（基準行號） | take 成員的處理與通知歸屬 |
|---|---|---|
| L2、L3、L5、L6、L9 | lanes-main.ts 648–852、1149–1280 | 活行程的回合無進展時，對已收下的列報 `stuck`，一次呼叫現有 /restart 的本機重開，行程結束報 `cut`、note「卡住重開」。一個 claim 只算一次。保留工具 timeout、狀態、kill-0 與 registry 判別。一般錯誤、Esc、換段走 C1 的 `error/cut/cut_person`。舊 main-stuck/unstuck、undelivered/delivered 由 S4 `cannot_move/recovered` 按等待者及 episode 發送。 `cut_twice`、`stop_failure_gave_up`（既有 tellClosed 已檢查模式）、停領提示和 asked-restart 由 S4 `parked/cancelled` 與指令的 Item 狀態承接。 |
| D4（通知）、D15、L4、L13、W4 | server.ts 1215–1255、2928–2951，usage-wall.ts 205–263，lanes-main.ts 268–287、468–533、1020–1048，lanes.ts 3900–3958、4105–4184 | 上限進出、主線及車道 wall-up/down 讀同一件 Item 的狀態，S4 對人的等待發 `cannot_move` 一則並在恢復時發 `recovered` 一則。停 WallAlerts 的本機 episode 計帳與限額 TUI 轉送。保留 keeper 讀取、上限選單和人的訊息被拒 60 秒後可領；取消車道的假探測回合。keeper 說通、真實交入又被拒報 `usage_limit_probe`，本機重開一次。keeper 外部的 W4 需由 keeper 維護者協調。 |
| L14、L16、L17、L22 | lanes.ts 3323–3454、3687–3828、5027–5147、5302、5644–5672 | 分身接收／steer 共用 C1 的 take。失敗、超時、額度截斷交還原 claim。關閉或交接報 `reassigned` 帶說明，尚未領的留在 Onsen。每列獨立回報，下一輪等 Onsen 重新給。切斷本機的 run retry、交回副本、信箱 budget 重排與孤立 steering 重送。 |
| L18、L19 | lanes.ts 2225、2321、6022–6068 | 停止本機 due、批次叫醒與追問。critical-due → S4 `alert_needs_person`（最高級無人接）；commitment/promise/answer-due → 人的承諾 `promise_due`，一般來件逾期告訴原 waiter。handoff/card-due → 等待／deadline 規則，交接時間本身不推 Joey。C5 寫 self/waiter。 |
| L27、L21、已定 37 | lanes.ts 1931、2657–2676、2969–3036、3103、5894–5915 | 同一寄件人的呼叫併進同輪，各自回報。peer_hold 的列等解除再領。取消本機洗版計數、開始／結束推 Joey（第四表明列移除），相同警報的重送由 Item 事件表示，升為最高級依已定 52 成為另一列。交主線、thread-stop、flood 三種靜默回覆按**原寄件人**的 take 狀態決定。對 take 寄件人，證據在原列的 session、reassigned、note 與 deadline。 |
| L12、L23、L24、W1（connector） | lanes-main.ts 980–1004，lanes.ts 7250–7274、7313，lanes-hooks/main-hook.py 183–190 | 收工時缺回覆只列一次、報 `owed`，下一個確定的 Stop 報 `completed`，由 Onsen 算 answered。保留記憶決定、工具結果／內容檢查。獨立的 check_tg_reply 由 hook 維護者處理。 |
| W20 | inventory W20，外部 fleet-block-detector.py | S4 `fleet_same_cause` 依同一原因彙整。這支 launchd 程式與 keeper 的 usage_wall.py 均由各自專案維護。 |

main.tick 與 idleCheck 提供真實行程與 Esc 事實。take 的 dueTick、sweepQueue、floodTick 由原列到期／重新可領的事件接手。followupTick 與 keepwarm-local 的寫入替代由同批 C5 交付（§3），bare turn 的 resume 由 C4 交付。S3 投影與舊回條停寫由 C2 交付。C1-fix D1、D2／54、D4、D9、D12 分別涉及正常完成、交回主線、停領列重查、回報 spool 與 flood 重讀。

settled49-table 的 26 行中，A3–A5 是本步的靜默通知，A6 的 stall 由本機報 stuck 與重開或正式 alert 承接。A7–A8 依 C4，A9–A10 依 mail Item 與已定 53，A11 依原列，A12 依已定 52。其他行依原表的 Item、編輯、Notification 或本機內容路徑交付。

## 測試與驗收

用 loopback Onsen 與假的重開函式觀察正常入口。驗證卡住到行程退出的回報順序、同時多件只重開一次、無關 blocker、無直接推送、普通錯誤三次停領後只放回一次、上限與誤判、車道結束和收工只提一次。用既有 pull、C1 與 canary 測試檢查舊路徑。用空檔作 CRAB_LABS_PLUGINS_ENV，daemon 案例連跑五次。

實際 S4 測試台按 facts §3 驗收。人的來件遇上限，測試號收到一次「在等、動不了」及一次解除。同一列連續三次 API 錯誤，只發一次停領通知，正常完成另一件後只放回一次。connector 側直接推送應為零。

## 待定

「一般 connector 要從哪個已授權來源辨認原寄件人是 take 還是 pull？」S2 r2 設計第 67、77 行限定 delivery 讀權與 connector 探測身分，普通 Item 讀取對兩種成員都可成功。這會影響混合模式下三個原寄件人的回覆。待確認的行為須由負責人決定。
