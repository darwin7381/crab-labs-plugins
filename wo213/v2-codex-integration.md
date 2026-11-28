# C1–C6 連接器整合驗收

`chiron/v2-codex` 從 `origin/main@ef38f5a` 依序合入七個指定 commit。C4 的父系已含舊 C5，合併後由同一個 Item spool 處理建立和撤回。C7、WO-217 G 都在這條分支的祖先以外。續跑時本機的 origin/main 前進到 `6c1ee38`，另合入其三筆 chat_history 更新，保留主分支的查詢行為。

## 成員模式和 Item 寫入

`onsen-take.ts` 的 `reportedDelivery` 解讀伺服器回應，`MemberDelivery.active` 保存這個成員的遞送方式。tg 的 `TakeMode` 與另一個行程的 `OnsenPuller` 使用同一實作。tg 問帶 connector 的 Items API，舊信箱則讀自己的 GET 回應。啟動時若尚未取得能辨識模式的回應，使用預設的 pull。伺服器回 409 `not_current_connector` 即確認成員走 take 且租約屬於另一支 connector，本機暫停領件、保溫和續查，舊提醒繼續停寫。重探後的取件權由 `canReceive` 表示。原來的 `takingItems()`、`takeModeActive()` 和 `pausedForTake` 已移除。

`self`、`keepwarm`、`resume` 經過 `OnsenClient.recordItemWrite`。`ItemWrites` 保存回傳的 Item id 並處理冪等、版本及撤回。同一 spool 的 claim 回報可以先於卡住的普通記錄送出。C5 永久被拒的承諾或 followup 保留 `local_reminder`，只由本機提醒一次。

## 逐檔衝突

逐一用合併 commit 的兩個 parent 重建衝突，七支共 38 次檔案衝突、104 個區塊。稍後同步 main 多一處，合計 39 次檔案衝突、105 個區塊。以下是每個檔案由上到下的解法。路徑相對於 `plugins/telegram-http/`，表中的「假 S2」是 `test-fixtures/onsen-items.ts`。

| 合併 | 衝突檔 | 解法 |
|---|---|---|
| C1 | 無 | 直接合入版本、租約、原 claim 的遲到回報和舊信箱切換修正。 |
| C2 | `server.ts` | 1. 啟動時退役舊 Item 回執，租約使用 takeMode.now。<br>2. 保留無條件 inboundLog，移除 schedulerTaken 的轉送。 |
| C2 | `onsen-take-daemon.test.ts` | 共用 daemon fixture 同時保留 C1 的接收證據和 C2 的舊回執檢查。 |
| bench-cred | `server.ts` | Puller 使用 `ONSEN_BASE` 及該目的端的簽章，是否停拉由舊信箱的回應決定。 |
| C5 | `lanes.ts` | 1. 合併排程回執、Item writer 和未履約事項的 imports。<br>2. 保留 retireItemReceipts，讓同一 receiver 和 client 處理既有承諾的補寫。 |
| C5 | `onsen-client.ts` | 1. 以共用游標走訪待送記錄，另從上次已回報的位置重播 claim。<br>2. 在同一次送出循環優先處理 claim 並繼續對帳普通 Item。 |
| C5 | `onsen-inbox.ts` | 以伺服器回的 409 `take_member` 決定成員模式。 |
| C5 | `onsen-items.ts` | 1. Item 形狀同時容納 waiter、版本與 reassign 原因。<br>2. 傳入 waiter、保溫 not_before、deadline 和重派 note。 |
| C5 | `onsen-receive.ts` | 領取前同時檢查保溫時窗和 C1 拒領的 Item 版本。 |
| C5 | `server.ts` | 把 C5 的 writer、保溫器和 C1 的時鐘接入同一啟動回呼。 |
| C5 | `onsen-take-daemon.test.ts` | 1. 保留 C1 查帳本、Item 和送達證據的 imports。<br>2. fixture 沿用既有空設定檔名稱，使兩支測試都指向同一份設定。 |
| C5 | `onsen-take.test.ts` | 保留舊領取案例及新 self／保溫案例，各自檢查應有的 claim。 |
| C5 | 假 S2 | 1. 保留含 waiter、時間、claim 等欄位的完整 Row。<br>2. 同時保存排程 Call、建立和領取的冪等紀錄。<br>3. 在 C1 回應外層加入 observation 的時間與自己寫的 Item 投影。<br>4. 同時支援引用訊息查詢和測試帳號的私聊對話查詢。<br>5. 加入建立 Item 的權限與請求驗證，重用既有 connector 解析。<br>6. 列表以同一個分頁外層輸出並排除 events。<br>7. 領取後只計本成員仍等候的列，回傳簡表。<br>8. 取消時填入 cancelled_at，完成時間維持原本的回報處理。<br>9. 假服務同時暴露排程 Call、Item 操作紀錄與可推進的時鐘。 |
| C4 | `lanes-main.ts` | 1. 保留 session 切換的常數，把截斷回合型別交給新 resume 模組。<br>2. 取得保留的列後仍處理已消失的列，晚到的 claim 依原 resume 的撤回原因結算。<br>3. 主線介面同時提供暫停 offer、無綁定時的結果、resume 的路由和寫入回條。 |
| C4 | `onsen-items.ts` | 把 `in_session_at` 加入既有 Item 形狀供續接判斷。 |
| C4 | `onsen-receive.ts` | 1. receive 接口同時容納離開 waiting 的通知、claimed 子集合與被取代的判斷。<br>2. 對拒領的版本另查詳情，讓恢復中的 resume 區分已領和已結案。 |
| C4 | `server.ts` | 1. Claims 同時採用 C1 的伺服器時鐘與 C4 的 unboundOutcome。<br>2. 保留 edited/version 的辨識，再用種類和寄件人成員辨認自己的 resume。 |
| C4 | `onsen-take-daemon.test.ts` | 保留兩方 daemon 情境，重送和狀態切換共同走真 HTTP fixture。 |
| C4 | `onsen-take.test.ts` | 1. 測試工具合併 spyOn 與原先的檔案操作。<br>2. 保留真實回應形狀的契約測試和 C4 resume 的正常與競態案例。 |
| C4 | 假 S2 | 1. 冪等紀錄連同請求內容保存，並保留排程 Call 索引。<br>2. 歷史事件可用目前或最後一次的 claim id，保留 C1 回應外層。<br>3. 允許沒有 body 的 DELETE，保留錯誤回應與 connector 辨認。<br>4. 晚到、過期和已結案的回報均依原 claim 處理，保留 in_session 的時間。<br>5. 完成列保留回覆 id、完成時間，另處理自己的 resume/self/keepwarm。<br>6. 取消時間只在首次取消時寫入。 |
| C3 | `channel-bot-control.ts` | 複用既有控制工具，重試只處理舊 PID。 |
| C3 | `lanes-main.ts` | 1. 同時接受帶外 delivery id、owed 階段和未答訊息 id。<br>2. 保留 resume 回條版本追蹤，take 時由 S4 負責不能動與恢復的通知。<br>3. 既有本機提醒的 take 判斷統一讀成員模式。<br>4. Stop 的 owed 階段檢查漏答，開新回合時仍帶入來源。<br>5. Esc 的閒置判斷保留原中斷的收件證據，重開期間暫停判斷。 |
| C3 | `lanes.ts` | 1. 合併 call 寄件人、Item、承諾及重開流程的 imports。<br>2. 在模式變化時重建計時器，保留 C5 永久拒收的本機提醒。<br>3. 主線取得 retry/restart 回呼及 C5 的 Item writer。<br>4. 探測期間暫停 followup，走 take 時仍可處理 local_reminder。<br>5. 避免在同一 run 領兩次，同時沿用 C3 的 keeper 探測及逐 lane 重試。 |
| C3 | `onsen-claims.ts` | 1. 保留舊帳本訊息 id 的恢復與 wasOwed 查詢。<br>2. 回報回傳是否已記下該 outcome，完成時帶出該 claim 自己的回覆 id。 |
| C3 | `onsen-items.ts` | 1. ItemRef 加入拒領的 lane 並保留 C5 的 waiter 和 C1 的重派欄位。<br>2. 重派靠 reason/note，保溫、期限與拒絕的 lane 同時保留。<br>3. 保留 edited/version 的區分並通知排隊中的 lane 重新掃描。 |
| C3 | `onsen-receive.ts` | 1. ClaimStore 同時提供 inSession、completed 與 wasOwed。<br>2. 未收到回應時以相同冪等鍵重試，只在本 connector 仍可領取時繼續。<br>3. 保留拒領詳情的延後查詢，失去所有權或超時時釋回這次領到的列。 |
| C3 | `onsen-take.ts` | 1. 探測保留伺服器時鐘、狀態碼及錯誤原因。<br>2. 外部 connector 的 409 暫停本機領取，模式與可否執行各自更新。 |
| C3 | `server.ts` | 在同一啟動回呼設定回執、writer、回報重播、peek、保溫和 lane 計時器。 |
| C3 | `onsen-take-daemon.test.ts` | 共用 daemon 的重啟、時鐘與程序 fixture，保留 C3 各 lane 上限和先前切換案例。 |
| C3 | `onsen-take.test.ts` | 1. 共用 imports 保留 spyOn、existsSync 和既有的檔案工具。<br>2. 主線測試共用 Outcome、閒置確認時間與各種工具的 timeout 計算。<br>3. mainRig 改用具名選項，讓慢 offer、退避、程序重開及 PID 可獨立設定。<br>4. 入列記下 person message id，綁定時沿用指定的 prompt。<br>5. fixture 同時回傳 writer、通知、重開清單及舊 PID 結束的控制方法。<br>6. 保留 claim 歸屬與同寄件人多個 Call 共乘的案例。 |
| C6 | `lanes-main.ts` | 1. 從 pull 綁定時保留攜帶的 resume，傳入本機實際接收的 session 和 prompt。<br>2. 收到 hook 時仍區分背景通知，只有實際接受的列才綁定該 session。 |
| C6 | `onsen-claims.ts` | 1. 同時引入舊 journal 的型別、辨認真正模型輸入的證據和漫遊 target。<br>2. 帳本保留 message_id、replies、intakeAt 及原 target。<br>3. 建構 Claims 時保留既有的時鐘、未綁定結果並注入 target 的狀態查詢。<br>4. 舊帳本的 message_id 修復與 connector 交接記錄並存。<br>5. 記下剛領取的訊息 id 和原 target。<br>6. 回覆優先依引用及對話綁定，也接受實際接收的 session。<br>7. final Stop 後已沒有背景工作的 claim 透過同一完成流程附上自己的回覆。 |
| C6 | `onsen-items.ts` | 1. 保留 waiter 與版本，納入 failures 及 created_at 供重領判定。<br>2. ItemRef 同時保存 destination、原 target 及拒領 lane。<br>3. 完整列表提供給漫遊選擇，既有 lane 仍收到 waiting 的重掃通知。 |
| C6 | `onsen-receive.ts` | 保留回報計數，改以 C6 的實際接收對話綁定。 |
| C6 | `onsen-take.ts` | 漫遊交接採用可等待的啟動回呼，所有權暫停沿用同一模式。 |
| C6 | `server.ts` | 1. 合併普通主線觀察、漫遊 target 的型別與路由。<br>2. 憑證選擇保留目的 URL，同時載入漫遊的 Telegram 所有權設定。<br>3. 先完成輪詢權交接，再啟動已獲許可的 claim、peek、保溫、spool 和 lane 計時器。<br>4. 本機送出的回覆傳入引用訊息及實際 session，讓原 claim 收下自己的回覆。 |
| C6 | `onsen-take-daemon.test.ts` | 1. 共用檔案測試工具加入寫 transcript 及移除 registry 的方法。<br>2. 保留主線事件工具並引入獨立的 Onsen 替身。<br>3. daemon fixture 額外提供 registry 路徑與內容，讓測試能換掉正在接收的 session。<br>4. 保留回合中兩則訊息的引用歸屬及 final Stop 後離線、換 UUID 的案例。 |
| C6 | `onsen-take.test.ts` | 1. 沿用同時支援 C1/C3/C4 的測試 imports。<br>2. mainRig 同時能操作 writer、舊 PID 及指定對話的狀態。<br>3. 保留 C4 的中斷測試及 pre-C6 帳本重播測試。<br>4. 保留引用歸屬及未確認的 final Stop 遇到 target 離開的結算測試。 |
| C6 | 假 S2 | 1. 時鐘支援偏移，原有建立、領取及 Call 的索引一併保留。<br>2. 回應保留 C1 的外層與錯誤處理，viewer 換成實際成員。<br>3. 請求驗證及本機 Action 服務轉送都保留。<br>4. 聊天對話及依引用查訊息都使用測試指定的成員。<br>5. Items 路徑改用本成員，建立其他成員的列仍會被拒。<br>6. waiting 只數該成員，回應保留領取時間和下一次可領時間。<br>7. 推進測試時鐘同時更新偏移及租約，保留 Call 等查核工具。 |
| 更新 main | `onsen-client.ts` | 同時引入 C2 的 Step 型別和 main 的 HISTORY_ID_HINT，保留兩邊各自的回執與查詢邏輯。 |

## 契約裁決與審查

任務指定 §4b.1–79。驗收期間，正本在 09:34 UTC 增加 §80，解決了實跑測到的原始 Claude UUID 回 400 問題。09:40–09:42 UTC 加入的 §81–85 涵蓋 Fleet Core 雙版本回填、人按 control 的查詢與限額、Action 終局、讀取成員模式的權限、現任 connector 的心跳。這些要由伺服器、外部保溫程式與 C7 分別驗收。C1–C6 已領到 control 後若畫面沒有選單，會回報 `not_applied`。

- §32、44 取代分支早期各行程各設開關的做法。舊信箱遇到 409 仍交完及 ack 已取得的項目。執行中的所有權拒絕不會啟動舊到期通知。
- §48、54 取代以 Item 的 `session_id: main` 判定交還主線的做法。寄件人的預設值保留，這次實際接收對話記在 claim。重派由 `reason` 和 `note` 判定。
- §58、79 明定工作失敗時 Item 正常完成，Call 投影為 failed。步驟是 `result.body.text` 內的 Markdown。C2 的結構化 `result.steps` 會遭 0.42.2 拒絕，舊 spool 行在送出時也會轉換。
- §59、60 解決 C4 早期規格的歧義。只有攜帶續接文字的正常回合才撤回，背景通知另行處理，已進輸入佇列的以真正的收件證據結算。選填欄位可省略。
- §61–66 的文字來自 `payload.text`。保溫是上次模型請求後第 50 至 60 分鐘。「再看」沒有 waiter，承諾才指定。refs 使用 Onsen id。信件決定走現有 mailbox_decide。外部看門狗退場屬部署驗收。
- §67、80 取代 C6「傳原始 UUID」的規格。主線傳 `main`，分身傳既有完整 lane id。漫遊者採 `<member>.roam.<128 位 UUID 的無號十進位值>`。轉換可逆並保留前導零資訊，重啟不需要另外配號。舊帳本與舊 HTTP spool 均可讀。Item 報告的 4xx 有 error 等級的紀錄。
- §73–75 涉及本機 `/inject` 轉寫 self、退出舊拉取時刪除 Telegram 輪詢，以及在別處按掉選單時結束 Action。這些改動在另行交付的 C7。此版 C6 在切換時交接輪詢 offset，仍為尚在 pull 的成員保留舊路徑。
- §86 要求以回報回應裡的 Item 狀態為準。0.42.2 收到 completed 仍可能把未讀信排回 waiting。下次會再把它交進對話。舊帳本沒有伺服器完成證據的記號會失效。確實完成的命令若被重播，只重報，避免重複執行。
- §87 要求先取得同一件 Call 結果的 2xx，再送完成回報。spool 保存每筆已獲確認的位移，重啟時繼續尚待確認的項目。某筆 Call 被 4xx 拒收，會記 error 並保留待送資料，其他已領 Item 和排程仍可回報。
- §88、89 要求同機兩支常駐程式可區分，且授權錯誤不能把已知 take 成員切回 pull。每個狀態目錄原子建立、保存自己的 connector-id。漫遊交接時保留原來的輪詢 offset。Items 探測遇到 401/403 記 error，60 秒後再探，收到明確的 `not_take_member` 才切回 pull。舊收件匣端點則以 200 確認仍可拉件。
- §90 在 10:06 UTC 確認漫遊者自己的 self、resume 仍去指定 target，保溫只由擁有該對話的成員建立。取代早期整合中漫遊者也會替 target 保溫的做法，舊 spool 中尚未送出的漫遊保溫建立也會退役。
- C3 審查 1–7 和複審 N1 已落實。各 lane 可在 60 秒後以真工作探測，只有已報 stuck 的 claim 才觸發重開，重試指向舊 PID。漏答只 hold 一次。完成帶回覆 id。長工具使用自己的 timeout。409 暫停不改成舊提醒。整合另補第 8 項，非上限 TUI 警告進值班員本機日誌，已有 pane watcher 時即時複查。需要人決定的選單由原有 Action 處理。
- C4 審查 1–6 已涵蓋永久拒絕放行、已交入的真實結果、同一次中斷去重、選擇性撤回、遲到收件和按種類分流。整合修正了重建 claim 時查詢 waiting/claimed 的次序。
- C5 審查 H1–H2、M1–M5、L1–L5 已納入，包括履約後停止通知、信件決定交回原 lane、時間與下午半點解析、切換時略過舊提醒、忙碌中停止保溫重寫、永久拒絕回本機計時、撤回已結束的 followup、保存和清理建立回條、pull 上的重複檢查、保溫時戳容差。整合補上 C3 計時器與 L1 回退共存，以及無 lanes 漫遊者的 self 和 resume 遞送。
- C6 審查 1–7 已涵蓋同 PID 換段、final Stop 後離線、not_taken 等狀態變化、橋接確認所有權、pull 控制件維持舊語意、忙時原目標等待和切斷重領。若本機帳本遺失、伺服器歷史又只剩寄件人的預設 main，該件會留在 waiting，等得到能確認原目標的證據。

## 舊拉取比對

同一台機器、同一版 Bun、同一組九個檔案，在起始 `origin/main@ef38f5a` 及續跑時的 `origin/main@6c1ee38` 各通過 153 例，在整合版通過 154 例。涵蓋 `onsen-inbox`、`onsen-pull-daemon`、`onsen-step2-lanes`、`lanes-m1-delivery`、`lanes-m2-main`、`lanes-esc-hold`、`lanes-wo200`、`lanes-wo201`、`lanes-wo205`。多的一例驗證單獨啟用 tg 後舊信箱也能辨認 take_member。C2 daemon 另各跑 pull/take 的排程回執、訊息、wall 與 wake。C6 測本機輪詢與橋接的交接。

相對 main 觀察到的差異如下。

- 拉取的 person_edit 缺少原始時間時，優先使用已記錄的送達時間，連原時間也沒有就略過時鐘字樣。這是 C1 的顯示修正。
- 存在對話目錄而沒有 subagents 子目錄時，背景工作數是 0。C1 的 D1 裁決採用這個值，舊版在該情境回 null。
- 收到正式切換回應的 inbox 會停拉並繼續處理手上尚未 ack 的舊項目。未切換的成員繼續走原 pull 流程。
- 明確設定 bench 身分時，Onsen 和 Fleet Core 改用目的端專屬憑證。未設定時保留原身分選擇。舊的 `scheduler-taken` 本機端點由 C2 移除，pull 的排程開始回執仍由原本的 inbox 工作路徑送出。
- 舊拉取的巡查沒有任何到期的延後項目時，main 仍可能留下「批次喚醒因離線被擋」的日誌。整合版等第一件到期才檢查喚醒。真正到期的卡片仍依原規則遞送。相同斷言在起始 main 和修正前的整合版都能重現，修正後兩個相關測試檔通過 13/13。
- 續跑時同步的 main 支援用 `chat_history` 查編號。純數字和 `tg:N` 指當前聊天的 Telegram message_id，`#N` 指 Onsen 編號。整合後兩個相關測試檔通過 38/38。

## 整合時改了哪些測試

各支原有的個案保留。以下按實際改動的斷言或 fixture 記錄原因。同一參數化測試的各組參數共用表中那一項。

| 測試或 fixture | 修改原因 |
|---|---|
| WO-127 的 pull/take 初始化 | 同時觀察兩個行程各自從 HTTP 得知的成員模式。 |
| WO-127 的 decide_later → mailbox_decide | MailEvents 改接 puller 的模式物件，驗證信件仍回到原 thread。 |
| mail-events 的查詢中切換 | 透過同一模式物件改值，驗證舊 mail_due 和已有決定的不同處理。 |
| onsen-inbox 的單一成員開關 | 使用 0.42.2 的 `detail.code=take_member` 回應，並確認回到 200 後可再拉。 |
| C5 的 lanes 共用 fixture | 依真實 daemon 順序綁定 receiver、初始化及停止計時器，避免舊 fixture 清除後計時器仍寫檔。 |
| 承諾在暫停期間已完成 | 以真正的 409/200 探測切換，才能驗證恢復後關掉原 Item。 |
| 混有新舊期限的承諾 | 以伺服器確認的切換驗證只有仍有效、未通知的承諾會補寫。 |
| 入站 Item 逾期 | C3 將通知責任交給 Onsen，因此未拒收的 Item 期待零次本機催告。 |
| followup 的原 lane、寄件人及到期 | 在該 lane 設定拒絕時間，讓斷言觀察由 C3 逐 lane 控管的佇列。 |
| followup 等建立回條 | 保持原 lane 暫停，單獨驗證回傳的 Item id 和 refs。 |
| 已進／未進佇列的 no-change | 用明確切換及原 lane 的拒絕時間驗證舊 followup 可撤回。 |
| 等待 Jev 時新寫承諾的去重 | 兩個分支各用 HTTP 進入指定模式，使 pull 仍有原有行為。 |
| 尚未掛好 spool writer 的 lane | 模擬已確認的 pull/take，驗證閘門獨立於 writer 是否已掛好。 |
| 永久拒絕的 followup／承諾，含 replay | 分別維持 lane 拒絕，核對本機到期恰一次且不重建 Item。 |
| Call lookup 失敗後重啟重送 | 斷言完整 PUT 只有 result，步驟在 Markdown 內文。 |
| C2 排程 failed、有無已知 Call、nothing-to-do | 等 Call 結果那筆 spool 寫入完成，分開核對 Item 已完成及 Call 的工作結果。 |
| C2 預切換的舊 delivery | 明確等舊 batch 送達。status 和 claim 已送達各有自己的證據。 |
| tg 開、舊 inbox 無開關的 relay | inbound-log 要 200，C2 移除的 scheduler-taken 要 404。 |
| captured person／running worker | 複製擷取的真實 Item 時指定測試成員，保留原 message id 和路由欄位。 |
| 無 target 的 /roam 選擇 | take 的 Action 結果走 Item report，斷言舊 /applied 寫入為零。 |
| C2 執行中 409 的到期通知 | 保留前後各一次的行為驗證，檢查 C1 含 HTTP 409 的實際探測紀錄。 |
| 非上限 TUI 警告 | 向本機 daemon 送一筆 OTLP 事件，核對值班員紀錄內容以及零則 owner 訊息。 |
| C4 從 pull 遷移尚未送出的 cut | 走 409/200 真切換，驗證正在寫入 pull stream 的訊息只交一次。 |
| C4 永久拒絕的 DELETE | 等非同步拒收計數與 spool 游標落盤後，斷言一次結案。 |
| pre-C6 帳本和已排隊的 main 報告 | 同時檢查本機原 UUID、重播和對外 main 編號。 |
| 啟用條件、HTTP 拒絕及離線 | 同時驗證探測狀態與是否能領，保留舊 helper 對外結果。 |
| 另一個 connector 佔用 45 秒 | 驗證本成員仍走 take、這支不能領，45 秒後能正常恢復。 |
| 409 後重新探測 | 驗證暫時斷線、授權或限流均不會在已切換成員上啟動 pull 提醒。 |
| 普通主線的 idle 收件及 final Stop | 驗證對外 `main`，以本機 UUID 追蹤該回合。 |
| busy 期間的 PostToolUse 收件 | 同時驗證主線使用 `main` 回報、切換前工作不產生 Item report。 |
| idle、busy、walled 每次切換 | 用伺服器可接受的主線編號檢查 claim 不變條件。 |
| 一份相簿的三列 | 三列各綁到同一個 `main`，仍然只 take 一次、通知一次。 |
| 遲到衝突、永久 4xx | 驗證兩者都有 error 紀錄，也保留拒收檔和游標前進斷言。 |
| 漫遊對話編號的正反轉換 | 核對前導零、全部 128 位元、超界值、不同成員、舊 UUID 和一般 lane。 |
| 漫遊者的雙 stream 收件 | 用 A/B 各自的 Onsen 編號核對真正接受的 stream。 |
| target 在 final Stop 後離開 | 原編號仍完成，回覆留在該 claim。 |
| 同一 PID 換 UUID | 對外的兩個編號應不同，本機選擇紀錄仍使用 UUID。 |
| 同 PID 換段前已有 final Stop | 已結束的舊段保留自己的回覆，新段另外綁定。 |
| daemon 重啟時尚有長回合 | 用同一個 Onsen 編號核對原 transcript 的收件和完成。 |
| 沒收下的 Item 遇到 peek／重啟 | 只在原 UUID 狀態變化後領取，核對重領的對外編號。 |
| 選擇別的忙碌 target 後原 target 狀態變化 | 原件仍只可綁原編號。 |
| take 途中換 target | 只接受 Item 到達當時的對話編號。 |
| 換 target 前後的相簿分件 | 核對每一部份對應真實的接收編號。 |
| busy、延後第一次 peek 和重啟 | A 的舊件和 B 的新件各自回報自己的編號。 |
| cut 等 A 換 PID 回來 | 核對兩次 claim 的編號相同，寄件方預設 main 仍保留在 Item 上。 |
| 依較舊的 cut 歷史重建 | 讀取可逆的真正接收編號，只有預設 main 的歷史繼續等待。 |
| 漫遊者自己的 self、resume 及保溫 | 切 A/B，從已閒置 51 分鐘的 transcript 驗證漫遊者建立零筆保溫，self 和 resume 只發給被指定的 target。 |
| screen-menu 真 tmux fixture | 縮短獨立 socket 目錄名，保留真實 tmux 及選單斷言，讓較長的 workspace 路徑可用。 |
| observation 逾期心跳 | 把樣本的年齡固定為 200 毫秒後等真正的 60 毫秒 timer，避免在有效期限最後一毫秒意外量到仍新鮮的樣本。 |
| 共用假 S2 及主線 fixture | 假服務重現 HTTP error 外層、claimed 事件、Item 與 claim 各自的 session_id、`result` 格式。主線 fixture 同時支援慢 offer、重啟和退避。 |
| 同機兩個狀態目錄與探測切換 | 證明不同目錄有不同 connector、同一目錄重啟可重用，401/403 有 error，400/404/429 也不會把已知成員改成 pull。 |
| 已停、超預算及不存在 lane 的交回 | fixture 用持久識別建立舊 claim，與稍後啟動的同一支 daemon 相符。 |
| 沒有 bot token 的已切換漫遊者 | 驗證 observation 使用該目錄的 connector。 |
| 漫遊輪詢 offset 確認失敗後重啟 | 帳本必須留下同一個持久 connector 以及待確認的 offset。 |
| 重探成功後才交接 bridge | 驗證新身分的第一份 observation 在舊輪詢排空後才出現。 |
| C2 交完舊 batch 後繼續寫 observation | 查核的是此目錄真正的 connector。 |
| SIGKILL 後第一次 observation | 保留原有 held ids，並核對重啟前後的 connector 完全相同。 |
| 未讀信退回 waiting 與舊帳本 | 同一封信在第二次 MCP 收件時再次 in_session，重啟能移除舊格式留下的假完成記號。 |
| C2 排程結果的三種組合 | 對 HTTP 操作次序斷言，該 Call 的結果成功後才有該 Item 的 completed。 |
| 同時兩個排程和另一件訊息 | 第一筆結果拒收後仍保存在 spool，另一個排程和訊息先完成，重啟再補第一件。 |
| 舊漫遊保溫的 spool 重播 | 保留真正的 self 寫入，舊 keepwarm 建立退役，游標排空。 |
| 畫面判讀信心不足及後續逾時 | 第一筆例外要等畫面穩定後才寫入，第二筆會立即寫入。測試等第一筆確實落盤才送出第二個畫面，並用 reader 的時鐘驗證重試間隔，保留兩行的順序與完整內容斷言。 |
| 兩條工作線關閉後重啟，補結束仍有標記的那條 | 原本兩支測試子行程搶同一個放行檔，先醒的可能取走另一支的訊號。放行檔加上 lane id，兩支仍並行，並分別驗證有、無待結案標記的行為。 |
| WO-131 信箱輪替、另一條 lane 同時啟動 | 原 fixture 只等整份 argv 日誌的筆數增加，可能先讀到別支程序，再找不到要驗證的 lane。現在等目標事件、目標 lane 和新增的 argv 紀錄三者到齊，保留原本對 prompt、回條及重啟的斷言。 |
| Codex runner 同時處理五個 Call | 原測試確認五件 completed 後立即數回覆，非同步的第五個回覆可能仍在途中。現在等待五件完成且收到五個回覆，再檢查五個對話、並行上限與所有狀態。 |

## 跑過的測試

### 每次合併之後

| 當時的 HEAD | 通過 | 失敗 | 後續處理 |
|---|---:|---:|---|
| C1 `edb24e6` | 38 | 0 | 領取、租約、遲到回報 |
| C2 `5723b30` | 51 | 0 | 排程結果、舊回執、主線 |
| bench-cred `933fc4d` | 5 | 0 | 第一次快照少了相鄰外掛，5 例均無法啟動。用同一個 commit 補齊快照後重跑。 |
| C5 `245b194` | 54 | 0 | self、保溫、共用 spool |
| C4 `c355bfb` | 101 | 2 | 補好重建時等舊 claim 的處理，並等 DELETE 拒收落盤後驗證。 |
| C3 `1280805` | 42 | 6 | 合回 C5 本機提醒、各 lane 的拒絕與真正 409/200 切換，調整由 Onsen 負責的到期通知斷言。 |
| C6 `321356a` | 23 | 0 | 漫遊接收、切換和橋接 |

修正後，`onsen-take`、`onsen-c5-lanes` 與 `onsen-inbox` 三檔通過 159/159。`keepwarm-local`、`onsen-take` 與 `onsen-inbox` 驗證成員閘門和提醒，通過 165/165。舊 batch 已在切換前收到、必須交完的案例另以 12 個新 Bun 行程重跑，通過 12/12。

### Fleet Core 0.42.2 真實來回

採用 `fleet-core@30113d5`、當前分支的 Bun daemon 和 PostgreSQL 17.9，在 `127.0.0.1` 啟動。本機服務的驗證表在記憶體載入這一輪生成的測試身分。Onsen 的身分驗證、Items、Call 和資料庫投影均走真正的服務。Claude 端由本機 MCP 串流與 hook 事件驅動，排程 lane 使用可控制的 CLI fixture。每次建立獨立資料庫，結束後移除。驗收包含實際 HTTP 操作順序，並在 Item 完成時立即讀 Call。

| 路徑 | 從伺服器讀回的結果 |
|---|---|
| 普通主線 | 同一 claim 的原始 UUID 遭 400 拒收，改用 `main` 為 200。後續三種 Item 都各有一次 `claimed`、`in_session_at`、`claim.session_id=main`、`completed`，且 `failures=0`。 |
| 保溫 | 上次模型請求後進入 50–60 分鐘時窗。主線收到並完成 keepwarm #2。 |
| self | 經 MCP 建立指定 atlas 為 waiter 的承諾，self #3 進主線並完成。 |
| resume | `StopFailure` 回報 overloaded，連接器建立 resume #4，交到續接回合並完成。 |
| Call | 真正的排程產生 Item #5 和 Call #1。lane 回報一項失敗的工作步驟，Item 正常完成，Call.state 與 result.outcome 均為 failed，清單只在 Markdown 內文。 |
| 漫遊者 | 連到 A/B 兩條 MCP 串流。A 被中斷，切到 B 並重啟 daemon，B 只收到自己的新件。A 換 PID、沿用原 UUID 回來，同一件在原編號有兩次 claimed、兩次 in_session、一次 cut，最後 completed。B 閒置 51 分鐘時漫遊者建了零筆保溫，指定給 A 的 self 和 resume 都在 A 完成。 |
| 兩支同機 connector | 同一主機、同一成員、兩個狀態目錄的識別不同。有租約時第二支取件收到 409。 |
| 未讀的 mailbox 信件 | 伺服器接受 completed，實際回傳 waiting，not_before 是一小時後。只在拋棄式資料庫把這個期限提前，重啟後同一信件第二次進對話。收件程式完成讀信回條後才真正 completed，伺服器留下兩筆 in_session。 |

最終產品程式 `af8514b` 跑了 2 個跨行程案例，40 個斷言全過，用時 51.66 秒。其後的四筆程式碼提交只修改測試。測試結束後查詢 PostgreSQL，本次建立的臨時資料庫剩餘 0 個。

### 回歸與本機檢查

| 範圍 | 這台 runner 的結果 |
|---|---|
| 逐檔，各用新 Bun 行程 | 257 檔、2,306 例，2,285 通過、9 失敗、12 略過，19,818 個斷言。逐檔測試從 `4b69c67` 開始，WO-131 在修正後才執行，該檔 9/9 通過。七個失敗的檔案和九個案例與 main 逐一相符。 |
| 固定 `e977a8f` 以兩個行程跑完整套件 | 第一組 133 檔、1,300 通過、2 失敗、8 略過，530.86 秒。第二組 124 檔、984 通過、8 失敗、4 略過，529.50 秒。逐一比對檔名，兩組剛好覆蓋 257 檔。合計 2,284 通過、10 失敗、12 略過，19,813 個斷言。逐檔以外多的一例在數第五個 Call 的回覆時只讀到四個。`cb66417` 修正這個測試的等待條件。 |
| 最後一筆 `cb66417` | 只改 Codex runner 測試，重跑該檔 42 通過、1 個既有行程查詢失敗、304 個斷言。以這次結果替換該檔後，最終內容逐檔合計仍是 2,285 通過、9 失敗、12 略過。五 Call 並行案例再以新行程重跑 5/5。 |
| 起始 main `ef38f5a` 的 telegram-http 全套 | 252 檔、2,080 例。2,058 通過、10 失敗、12 略過，782.73 秒。當時的 tmux 測試 socket 路徑過長，整合已縮短。其餘失敗原因見下一節。 |
| 續跑時的 main `6c1ee38`，針對原生系統能力重跑 | 7 檔中選出相同的 9 例，9 例全部重現失敗，用時 20.20 秒。 |
| 整合中途的兩次單行程全套，各 257 檔、2,306 例 | `aa0f7e1` 為 2,284 通過、10 失敗、12 略過，1,026.69 秒。下一輪 `4b69c67` 為 2,251 通過、43 失敗、12 略過，另有 6 個非同步錯誤，966.32 秒。該輪抓到 WO-131 的 fixture 先看到別條 lane 的 argv，後續多個錯誤指向已被清除的同一個工作目錄。`e977a8f` 修正該等待條件，WO-131 單檔 9/9 通過。 |
| 續跑時的 main 與整合版，舊拉取九檔 | `6c1ee38` 通過 153/153，整合版通過 154/154。 |
| Call 結果的順序、拒收和重播 | `onsen-take`、`onsen-calls` 兩檔 146/146，排程 daemon 個案 4/4。當一件的結果被 400 拒收，另一排程和普通訊息能完成，重啟補交第一件的獨立案例 1/1、11 個斷言。各組可能涵蓋同一案例。 |
| 未讀信重送與控制命令防重播 | 兩個對照案例 2/2、18 個斷言，另以舊格式帳本獨立重跑信件 1/1。 |
| 持久 connector 識別、授權錯誤、漫遊者保溫 | 前兩項 3/3、43 個斷言。漫遊歷史 spool 與其他 Item 寫入 9/9、75 個斷言。 |
| Discord 外掛 | 五個測試檔 37/37、99 個斷言。 |
| Git 與版本標記 | 本機用 `tools/pre-push` 驗證 379 個標記。逐一核對七次指定合併與補進 main 的第二 parent，共 8/8。C7 和 WO-217 G 均在此分支祖先之外。 |
| 畫面日誌的兩筆例外與重試 | 全檔 34 通過、4 條件式略過，修正的案例用十個新 Bun 行程重跑 10/10。 |
| 工作線關閉及重啟 | 改用每條 lane 自己的放行檔後，7/7 通過，再用四個新 Bun 行程各跑完整檔案，共 28/28。 |
| lane 第一次收到 429 後，60 秒以真實工作重探 | 前一版整組執行時有一次未在 5 秒內看到恢復件的 in_session。獨立重跑 5/5，最終版整組執行同一案例通過，用時 8.05 秒。 |

## 跑不了的與原因

- 七個案例需要宿主機的 PID、argv 或程序父子關係。`session-finder` 的真實 ps、`lanes-golive-proc` 的 Mac 路徑、`lanes-m5-runs` 的 pgrep、`lanes-pl-s0lock` 的兩個行程鎖、`onsen-step3` 的孤兒 SharedCli 以及 `codex-runner` 的重啟追蹤都受影響。本機直接呼叫 `/bin/ps` 回 Operation not permitted，`pgrep` 無法存取 sysmon，exit 3。
- 兩個案例要求在時限內收到原生檔案通知。`onsen-step3` 要收到 watch callback，`onsen-step3-daemon` 要在 1 秒內更新 registry。直接在 repo 的隱藏與可見目錄寫檔，兩次 `fs.watch` 在 750 毫秒內均收到 0 次事件。daemon 的定時掃描仍會在約 1.7–2.0 秒發現變更。
- 套件自行略過十二個條件式案例。兩個需要 Linux 的 `/proc`，兩個需要指定的 clock shim，八個需要 Chiron 的畫面、標記、Jev 問卷／判讀記錄或外部 status 驗證程式。

## 要負責人定的問題

1. 指定能讀行程資訊、收到原生檔案事件的 runner，完成上述九例的發布驗收。若要求條件式案例也執行，另需 Linux、clock shim 和對應的測試資產。
2. 對照 Sonn 獨立整合版的漫遊對話編號。若兩版選用不同編碼，上線前需選定一種，並確認能讀回既有 claim 的對話編號。
3. 指定首批切換的成員及時間，並確認外部保溫程式依 §66 讀取成員模式。C7 與橋接的部署驗收另由負責人安排。
