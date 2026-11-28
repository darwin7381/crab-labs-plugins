# 連接器 v2 獨立審查 · `4c85a9a`

| 編號 | 嚴重度 | 檔案與行（連接器路徑自 `plugins/telegram-http/` 起） | 發現 |
|---|---|---|---|
| P1 | 會壞正式的 | `fleet-mail.ts:333`、`lanes.ts:5848`、`lanes.ts:6866`、`server.ts:2335` | 還在拉的成員明寫理由、交新工作給本回合的來電者，v2 會把它寄成舊 Call 的免回覆。 |
| P2 | 會壞正式的 | `onsen-client.ts:713`、`:721`，對照 `origin/main` 同檔 `:655` | 直接用此 tip 出版會撤掉 1.59.14 的修正，已消失的 Call 又會反覆等，沒有本機 thread 的終局 Call 又會發通知。 |
| T1 | 要改才能上測試台 | `lanes.ts:7932`、`onsen-client.ts:955`、`:1046`、`:1065` | 排程的 Item 可以先完成，當下讀同一個 Call 取得 `completed / result=null`。 |
| T2 | 要改才能上測試台 | `lanes.ts:7936`、`onsen-client.ts:1086`、`test-fixtures/onsen-items.ts:123` | 有步驟的回執會被 0.42.2 回 400，結果不再重送，測試替身卻把這個形狀當成功。 |
| T3 | 要改才能上測試台 | `onsen-claims.ts:182`、`:214`、`:220`、`onsen-client.ts:850`、`roamer-items.ts:69` | 主線、漫遊者把本機 Claude UUID 送作 `in_session.session_id`，伺服器拒收後列仍能直接結案。 |
| T4 | 要改才能上測試台 | `onsen-client.ts:1052`、`onsen-claims.ts:101`、`:226`、`server.ts:5164` | 未讀信被伺服器排回一小時後，連接器卻跨重啟記為已完成，下次領到只回報、不再交信。 |
| T5 | 要改才能切正式成員 | `onsen-items.ts:27`、`onsen-receive.ts:43`、`onsen-claims.ts:170`、`roamer-items.ts:149` | 一列回覆原 Call 的 Item 已進入漫遊對話，目標在 Stop 前結束時仍會被報 cut，回到待交。 |
| T6 | 要改才能切正式成員 | `onsen-claims.ts:241`、`server.ts:2890` | 同一對話中，後一回合沒有引用的回覆也會掛到前一個 background Item，讓兩列都看似答過。 |
| T7 | 要改才能切正式成員 | `onsen-receive.ts:6`、`server.ts:700`、`:5202`、`channel-bot-control.ts:1435` | 忙碌時換模型只排入背景就回 completed，選單可顯示已套用，實際操作仍在等。 |
| T8 | 要改才能切正式成員 | `roamer-items.ts:55`、`:74`、`server.ts:5171`、`test-fixtures/onsen-items.ts:236` | 漫遊者領到後、收下前失聯，真實歷程寫 claimed，恢復程式只認 taken，即使原目標在也不能再交。 |
| T9 | 要改才能切正式成員 | `server.ts:439`、`:4290`、`:5174`、`lanes.ts:4490`、`:3637` | 無 lanes 的漫遊者把寄給自己的 self 和 resume 送去 lanes，實測 self 重試時仍無人收到。 |
| T10 | 要改才能切正式成員 | `server.ts:179`、`:296`、`onsen-take.ts:41` | 同機同成員用兩個狀態目錄、兩個埠啟動時，兩個收件者使用同一個 connector 名稱，可各領走不同列。 |
| T11 | 要改才能切正式成員 | `server.ts:409`、`:3093`、`:3127` | 漫遊者沒有建立保溫列的路徑，現行保溫條文沒有載明這個例外。 |
| P3 | 只是觀察 | `server.ts:4888`、`onsen-edit.ts:28`、`:37` | 舊拉取送進對話的編輯標頭改用原訊息時間，時間未知時省略，屬於可見的文字差異。 |
| O1 | 只是觀察 | `onsen-take.ts:17`、`:54`、`lanes.ts:310` | 已知走領的成員重新探測遇到 401 會在本機轉回拉，啟用拉取的計時器。 |
| O2 | 可以之後 | `onsen-observation.ts:94`、`:139`、`onsen-observation.test.ts:91` | 沒有新樣本時，第一次心跳正好踩到邊界會重送同一筆，原測試的 200 ms 等待無法固定這個先後。 |
| O3 | 可以之後 | `onsen-take-daemon.test.ts:1516`、`onsen-client.ts:955` | 切換時清舊投遞的測試只等了狀態和觀測，可能在舊投遞送出前檢查它。 |
| O4 | 只是觀察 | `server.ts:448`、`onsen-take.ts:18` | 符合探測條件、列於名單的漫遊者即使仍走拉，也先等一次最多 5 秒的模式探測才啟動舊輪詢。 |

**出版判斷。** 先保住全隊仍走拉的行為。P1 在未配置走領時也成立，P2 取決於用哪個基底出版。兩者處理前不宜把這版鋪到全隊。走領測試成員的下一次驗收應先重驗 T1–T4。漫遊者、選單和多連接器還有各自的切換條件。審查涵蓋 C1–C6。

**比較基準。** `origin/v2@4c85a9a` 的共同祖先是 1.59.13 `b82e466`。C1 最終版、C2 和測試台憑證路由在 `98666f1`，之後依序為 C5 `536678d`、C4 `56eba3e`、C3 `0119abb`、C6 `4c85a9a`。本機 `origin/main@ef38f5a` 在共同祖先後有六個 commit，含 1.59.14。以下用這兩個基準區別整合引入的改動及主線已修復的回歸。契約以 `onsen-ui/CONTRACT.md` §4b 的條文、狀態表、投影表及已定 1–79 為準，另標出 09:34Z 才釐清判斷 5 的已定 80。外部源碼行號分別固定在 Fleet Core 0.42.2 `7d6e4f6` 與 BTCC `bfa8870`。

## 舊拉取

**P1 · 新工作被寫成回覆。** 這條行為來自整合前的 C1 提交 `9bb315e`。讓主線在同一回合處理 Atlas 的 Call A，呼叫 `send_to_agent(line="call", to="atlas", because="另一件事", text="請做 B")`，省略 `reply_to`。在相同的工具入口及綁定條件下，main 送出的 `(reply_to, no_reply, call)` 為 `(空, false, 空)`，v2 為 `(44, true, "27")`。當中的 44、27 是本機傳輸替身觀察到的編號。實際未裝 ItemReceiver 的路由測試也把未填引用的主線呼叫對上當前來電（`lanes-wo175-reply.test.ts:99`）。分身的 `answerToCallArgs` 在既有「不填 line」之外，現在連明寫 `line=call` 的情況也補引用。兩處都在探測走領之前就適用。依 §4 及 §4b 已定 21、38、45，原 Call 的回覆不另開工作。後果是 B 可能沒有自己的 Call 與答覆責任，A 卻多一個回覆。保留明確另開工作的入口，並各驗一次同儕同回合的真回覆與獨立工作。

**P2 · 1.59.14 的兩項行為。** 實際呼叫兩個版本的 `checkWaitingCall`，令 GET 分別回 403、404，main 回 `final:http_403`、`final:http_404`，v2 皆回 `wait`。再給一個已完成、有 conversation、沒有本機 thread 的 Call，main 發 1 次 GET 即結束，v2 另發 1 次 POST 給對話。缺 conversation 時 v2 仍等待。原修正在 `e2c1c09`、`b5950d4`，已合入 `cfc5733`。此處是兩個 tip 的差異，出版時把 v2 合回現行 main 並保住這兩項修正即可避免。與 §4b 開關無關。

**P3 · 編輯訊息。** `person_edit` 優先恢復原文時間，沒有可用時間時不再顯示舊的未知時間佔位。明確設定 `ONSEN_TAKE=''` 的 daemon 案例也走這條路（`onsen-take-daemon.test.ts:237`）。這可保留為獨立的文案修正，但不能簽「舊拉取顯示完全相同」。它不改編輯的投遞編號或 ack。

## 排程回執

**T1 · 已完成的那一刻確實讀得到空結果。** 分身依序把排程結果（spool 的 `c`）與該次 claim 的終局回報（`ir`）寫進本機佇列。`completeRun` 的成功表示入列。`OnsenClient.pass()` 先送待回報的 `ir`，才送原順序的紀錄。這也是為了讓其他 claim 的回報能越過卡住的舊寫入。即使先加入 `c`，也沒有保證同一列的結果先送達。0.42.2 的 `app/onsen_projection.py:15` 直接用 Item 狀態和當時的 `result_outcome` 投影 Call。

在私有 PostgreSQL 上以真正的 v2 client 送件，每個 PUT 收到回應後立刻 GET 同一個 Call。把該次快照餵給真正的 `scheduler-worker/worker.py:678` 的 `project_call`，在另一讀寫步驟查排程列。下表每列是一個獨立 run。

| 同一個 run 的寫入順序 | 第一個回應之後的 Call → 排程 | 第二個回應之後的 Call → 排程 |
|---|---|---|
| 合法結果先入列，v2 優先送 completed | HTTP 200，`completed / null` → `acked / null` | 結果 HTTP 200，`failed / failed` → `completed / failed` |
| v2 帶 steps，優先送 completed | HTTP 200，`completed / null` → `acked / null` | 結果 HTTP 400，仍為 `completed / null` → `acked / null` |
| 對照組，先確認合法結果已送達，再送 completed | HTTP 200，`accepted / failed` → `delivered / null` | 回報 HTTP 200，`failed / failed` → `completed / failed` |

`worker.py:685` 檢查結果是否有內容。此版本把空結果暫記為 acked，還會再查可投影的 run（`:709`、`:736`）。合法結果晚到能補正。若一直沒有合法結果，稍後可能啟動既有催辦、逾時流程（`:768` 起），本次沒有等到那個逾時。原 daemon 測試只等 Item 完成就查 Call，正好捕捉到真實的可見狀態。不應靠多等一下讓它過。

**T2 · 有步驟時，等也等不到。** `completeRun` 把步驟放進 `result.steps`。0.42.2 的 `app/onsen_calls.py:1221` 拒絕未知欄位。連接器把 400 記到拒收檔，游標往前後待送位元組為 0。替身只檢查外層有一個 `result`，還直接保存傳入物件。測試 `onsen-take-daemon.test.ts:1549`、`:1575` 把不合約的形狀寫成期望。這和 T1 可分別發生。

**最小修正及驗收條件。** 依已定 58、79，把步驟與摘要放入 `result.body.text`，保留機器值 `outcome`（包含 `nothing_to_do`）。只對**這個排程 Item、這次 claim 的 completed** 記下它等待的 Call 結果，該結果 PUT 收到 2xx 才送終局。這個相依關係要和 spool 一起跨重啟，含靠 run ref 查 Call 的路徑。結果遇 503 或回應遺失時重送同一結果，永久拒收則保留可查、可處理的未結案狀態。其他 Item 的回報繼續優先。只等 `syncNow()` 在另一趟 sync 執行中會立即返回（`onsen-client.ts:820`）。驗收要在第一次看見終局時讀 Call，同時驗有步驟、無步驟、查 run ref、寫入後斷線及重新啟動。工作失敗仍依已定 58 報 Item completed，工作結果寫 failed。

要重跑會看到空值的原案例，可在 `plugins/telegram-http/` 以隔離的 HOME、TMPDIR 和空測試設定執行 `bun --no-env-file --no-install test ./onsen-take-daemon.test.ts -t "C2 scheduled receipt"`。要固定先後，在 client 尚未開始 sync 時依序記錄結果與 completed，在同一趟 `syncNow` 的每個 PUT 返回後立即讀 Call，即得到上表第一、二列。

## 走領的交付、歸屬與重送

**T3 · 本機 UUID 與 Onsen 的對話編號。** 主線 bind 和漫遊 transcript 的 intake 都把實際 Claude UUID 傳給 `Claims.bind`（`lanes-main.ts:760`、`roamer-items.ts:149`）。它原樣送出，還會把舊佇列的 `main` 改回 UUID。拿 0.42.2 真實的同一筆 claim 送 UUID 得 400，改用合法分身編號得 200（`app/onsen5.py:204`、`app/onsen_items.py:430`）。連接器在本機入列就記 `in_session_at`，拒收後對中途結果直接返回。之後仍可回 completed，外面看不到這段實際執行過程。測試替身在 `test-fixtures/onsen-items.ts:262` 接受 UUID。拒收目前只記 warn，也不符已定 80 要求的 error。保留本機 UUID 追 transcript，送出時用 `main`、合法分身編號或跨重啟穩定的漫遊目標編號。舊帳本、舊 spool 和從歷程恢復都要支援。已定 14、48 說明誰在何時填寫，80 明定編號格式。

**T4 · 未讀信的一小時提醒失效。** 用真信箱建立一封未讀未勾的信，領走並報 completed。伺服器回 200，但回應的 Item 是 `waiting`，其 `not_before` 比更新時間晚 3,600 秒。連接器只把成功與否傳給 `Claims.acknowledged`，此時 `completed(id)` 為 true，重開帳本仍為 true。把本機測試列的到期時間提前後，伺服器再交出**同一 Item、新 claim**。daemon 的快取捷徑會直接重報 completed，整段跳過信件分流。快取上限是七天／5,000 筆，每次成功重報又能留下新時間。只有信箱的未讀信該回 waiting，直送信正常終局（已定 53、77，Core `app/onsen_items.py:456`、`:518`）。應依伺服器回傳的 Item 終局狀態決定是否快取，並處理已有此種快取的帳本。

**T5 · 回覆型 Call 沒在 intake 結束。** 在本機真 daemon 接上替身 Item API 和測試 MCP 目標，投一列 `kind=call`、含原 Call ref、`no_reply=true`、帶原訊息引用。漫遊目標看到內容並在 transcript 記下 claim，依然是 `claimed`。讓測試目標在 Stop 前結束，結果 `waiting / cut`。已定 21、38 要求這種回覆進了對話就做完，再交可能在同一段出現兩次。`ItemRef` 與 bind 沒保留這個區別，Core 也把一般 `in_session` 保持在 claimed（`app/onsen_items.py:448`）。須能辨認「原 Call 的回覆」，在確定它已進入目標時結案。一般待辦 Call 仍要等工作結束。

**T6 · 未引用回覆的歸屬太寬。** 在同一 Claude session、同一 conversation，以回合 A 收第一列，報 background，以回合 B 收另一列。只對 B 發一個沒有引用的回覆，兩列的 completed 都帶同一個訊息編號。本機直接跑 `Claims` 得到此結果。`reply()` 有引文時按 conversation 與原訊息編號比對，支援跨 session 的明確引用。沒有引文時，background 且傳入 session 的分支跳過 turn 比對，缺 session 時又只剩 turn。已定 35 用回覆編號算 answered，會遮掉應算未回答的工作。背景通知若屬於 A，需能對回 A 的延續關係。

**T7 · 選單的 deferred 沒實作。** 忙碌時選擇換模型，`runTuiSwitchCommand` 要等目前回合結束、鍵入後再確認結果。呼叫處啟動背景工作就回 true，Item 路徑依布林值當場報 completed。這中間若失敗或程式重啟，Onsen 已顯示套用。§4b「什麼時候可以領」與回報表規定先 deferred，套上後才 completed。已定 55 也明列 deferred 為中途結果。v2 的 Outcome 和中途集合都沒有它。現有「choice throws」測到同步丟例外，沒等這個背景工作的失敗。已無選單的 `not_applied` 是另一條正確路徑。

**T8 · 收下之前失聯的漫遊者。** 讓真實 0.42.2 的 claim 提前屆期並跑 sweep，讀到 `waiting / cut` 和三個事件 `created → claimed → lease_expired`。這時沒有 firstReceiver。給實際 `RoamerItems.destination` 同樣歷程，即使建立時的目標可查、仍在線，得到 null。只把事件改成替身使用的 `taken`，就能回到原目標。對已經收下才 cut 的列，跨機恢復另要求歷程上有裸 UUID，也須配合 T3 的穩定編號。已定 67 要求等待原目標，不能因無法辨認事件或編號而在原目標回來後仍等。真正無法辨認原目標時也不能改送別段。

**T9、T11 · 漫遊者的 self、resume 和保溫。** 同一個開著的 MCP 目標先成功接到普通訊息，再放一列自己寄給自己的 self。標準漫遊組態 `GENESIS_LANES=0` 沒有初始化 lanes。實測記錄讀取 `followups` 失敗，Item 留在 waiting，沒有回報。`ItemPeek` 的路由錯誤會退避重試（`onsen-items.ts:139`）。自己寄的 resume 也直接呼叫未初始化的 `main.routeResume`（靜態核對）。已定 28、39 允許自己留給自己的列，59 定義 resume 的收尾。保溫則更早就被 `!ROAMER` 排除。已定 23、62、66 把寫入責任交給連接器，沒有列出漫遊例外。即使負責人採納免保溫，也仍要讓既有合法 self 到得了原目標。

**T10 · 同機兩支連接器的界線。** 同一個狀態目錄有存活 PID 鎖，同埠也不能同時監聽。用不同目錄及埠時，兩支仍都自稱 `mac-mini/pheme`。用兩個獨立 HTTP client 對同一個本機 Core 探測，兩者都 200，換成別台機器的字串則得 409。同名 client 各領一個不同 Item 都成功。再領對方尚未過期的 Item 得零列。真實風險是合法列落到另一程序的對話，以及租約過期後的重交。已定 13、16、18 保留「機器＋成員」讓重啟可接手，部署若允許多 state dir，還需要同機同成員的互斥或明確的單實例保證。

**O1 · 探測失敗的模式。** 實測 200 建立走領後，重新 probe 得 401，`active` 變 false。無回應、5xx 在已啟用時走 unavailable 並保留 active，409 `not_current_connector` 也保留。這是憑證或配置短暫故障時的重複本機通知風險。本次沒有觀察到實際重複通知。已定 32 對非 200 有「照舊拉」的規則，若希望區分「首次探測」和「已知走領」，需由負責人明定。

**O2、O3 · 兩個測試的等待條件。** observation 的測試與實作已存在於 1.59.13。原檔單獨跑五遍全過。沒有更新、heartbeat 60 ms 的受控時鐘在第一拍落於 60 ms 時共送 2 筆，61 ms 時共送 1 筆，重送時仍使用同一 `reported_at`。200 ms 只決定何時斷言，無法控制第一拍是否踩到 freshness 的等號。舊投遞 drain 的原測試見到 completed、observation、status 就斷言已有 `/deliveries/batch`。在臨時測試副本中保留原斷言，額外等待該批實際包含 `before-switch`，三次都收到恰好一筆。本次沒有從這條失敗證實切換會丟舊投遞。

## 負責人的六個合併判斷

| 判斷 | 複核結果 |
|---|---|
| 1 · Claims 整合 | **本機鍵與合併內容正確，送出格式有 T3。** `onsen-claims.ts:39` 的最後一個建構參數確實是 `targetState`，`server.ts:428` 也依此順序傳入。舊 `registry_session` 會移入本機 session 鍵。C1 的訊息編號復原及引用、C3 的 `wasOwed` 和按成功回報的 claim 計數（`onsen-receive.ts:37`）、C4 的 20 秒 missed／unbound 結果選擇都在。引用歸屬與送出的欄位格式另見 T6、T3。 |
| 2 · completed 帶回覆編號 | **「只有 UUID」不準確。** `onsen-claims.ts:192` 的條件是已有 replies，或本機 session 為 UUID。分身即使綁的是 lane ID，也要帶實際送出的編號。daemon 在有、無 owed 的兩種 lane 都驗到這件事。UUID 沒有回覆時可以帶空陣列。`Claims.complete` 和被過濾的人訊息路徑也能明給空陣列。保住分身的編號，否則已定 35 會把答過的工作算成沒答。 |
| 3 · 引用與回合歸屬 | **有引文的部分成立，無引文的部分有 T6。** 比對 conversation 和被引用的 Onsen 訊息編號，所以另一段 Claude session 可以明確回答原訊息。沒有引文時，當前實作沒有保證「同一段且同一回合」。既有覆蓋含同一 turn 的多筆 Item 和合法背景延續，仍缺「背景 A 和新工作 B 互不相關」這個反例。 |
| 4 · 啟用 callback 與漫遊保溫 | **callback 的數量及順序正確，保溫例外未有裁決。** `server.ts:409` 先檢查舊 spool、停止本機輪詢、記交接，再開始 connector。一般成員才跑 retire、resumeSelfItems、deliveryModeChanged，lane hook 和回報後 sweep 都有相同的非漫遊條件。這保住 C6 的交接順序。跳過漫遊保溫是另一項產品行為（T11），入站還要處理 T9。 |
| 5 · UUID 與 /applied 的測試改動 | **前者應改回 wire 斷言，後者正確。** 已定 48 限定 Item 預填值和這次 claim 的歸屬。正式契約第 4 節的編號形狀及後補的已定 80 已釐清。測試應同時驗本機 UUID、Onsen `main`／分身／穩定漫遊目標和拒收紀錄。走領的 `/roam` 選單則由 control Item 投影，`onsen-client.ts:1845` 對 take 跳過舊 `/applied`，次數 1→0 符合 §4b「上線期間」表。走拉仍有原路徑。非同步套用另見 T7。 |
| 6 · 以 409 測走拉，退休 L18 | **兩項成立。** 暫停某支 connector 只關 canReceive，member 的 active 可以仍然為真。在測試中用明確 409 `not_take_member` 重新 probe 才是走拉（已定 32、44、72）。對普通走領 Item，原 L18 overdue push 預期 0，通知交給 Onsen。C5 永久拒建後的 `local_reminder` 仍要響一次，已有兩條重播案例。 |

## 五個合併衝突與舊路徑

| 原本要收斂的地方 | v2 的實際界線 |
|---|---|
| 走領的判斷 | Telegram daemon 中 `takeModeActive` 與 lanes 的 `takingItems()` 都讀同一個 `TakeMode.active`。搶領、peek、steer 與 observation 是否報自己，另讀 `canReceive`。獨立的 INBOX_ONLY 程序仍有 `OnsenPuller.pausedForTake`，由舊 `GET /inbox` 的 `409 take_member` 設定、200 清除（`onsen-inbox.ts:191`、`:262`），它無法共用另一行程的物件，仍有呼叫者。O1 是重新探測時的例外。 |
| 誰寫 Item | 自建 self、resume、keepwarm 的 POST 和 DELETE 都匯入 `OnsenClient.recordItemWrite`（`onsen-client.ts:508`、`lanes.ts:3598`、`server.ts:3097`），由 `ItemWrites.sync` 實際送出（`onsen-item-writes.ts:125`、`:149`）。keepwarm 列表及按 ID 查狀態仍是讀取。claim 的 take、report 是另外兩種契約操作。C4 沒留下自有的 POST／DELETE 重試佇列。 |
| C3 與 C5 的本機提醒 | `lanes.ts:3609`、`:3620` 把永久拒建的 followup／promise 標作 `local_reminder`。`:4418`、`:6356` 過濾一般 take 提醒，准許這兩種在本機補一次。 |
| Item 本文 | 入站編輯、self、resume 及找舊資料用 `payload.text`（`server.ts:5161`、`:5176`、`onsen-item-writes.ts:171`），建立請求仍用 `body.text`。兩個方向符合已定 34 及裁決 9。 |
| meshAuth 的 URL | Onsen client 依 `ONSEN_BASE` 選身分。會依目的地變動的 HTTP helper 和 roster 公告的 push URL 分別傳 `meshAuth(url)`、`meshAuth(pushUrl)`（`server.ts:378`、`:2230`、`:2249`、`:2552`）。另有固定 BTCC／mesh 的 ack、紀錄等呼叫使用預設身分（例如 `:2146`、`:4421`）。mailbox inject 也明確維持 mesh。URL 的比對含 origin 與 path 邊界。這項依源碼複核，真實憑證未參與測試。 |

## C3–C6 前次審查的逐項結果

編號沿用 `review-c3.md` 至 `review-c6.md` 及其複驗紀錄。下列判定均核對整合 tip。C5 裁決 9–16 的編號指 04:25Z 的裁決單。

| 來源 | 在 v2 上的結果 |
|---|---|
| C3 1、2、3 | **已修。** 分身各自記拒絕時間，自己模型的牆允許 60 秒後實際工作探測。主線要有成功記下的 stuck claim 才重啟。舊 PID 活著或重啟失敗都能再試。測試覆蓋失敗後 hook 能恢復的情形。 |
| C3 4、5、6 | **已修。** Stop 把 missed 和 unsent 合成一次 owed，含切換前的舊工作。分身 completed 保留本次 reply IDs。主線與分身皆依 MCP／WebFetch 工具時限判斷靜默。沒有設定上限的長工具會持續等待，此為裁決接受的行為。歸屬另見 T6。 |
| C3 7、8、N1–N3 | **7、N1 已修。** 暫停不會因一次 409 就開舊通知。首次重啟可用精確 tmux 名稱，重試傳 generation 儲存的舊 PID。只給它 TERM，三秒後還在才 KILL（`lanes-main.ts:244`、`channel-bot-control.ts:1447`）。本機測到替代 tmux session 存活。**N2、N3 為已知取捨**。每條受限 lane 最快每 60 秒探一次，等確認回拉最長約 60 秒。**8 須外部驗收**。take 壓掉本機 TUI 警示，值班端的 choose／告警須由 S4 投遞。混合模式 waiter 收舊 notice 的本機結果見下。 |
| C4 1、2、3 | **已修。** 共用 spool 的永久 400／403／409 各只拒一次，後面的 resume 可交。已進對話或 background 的 resume 不會被誤作 superseded。同一 session 的兩個被拒 prompt 共用一個未交的 resume。見 `onsen-resume.ts:66`、`:86`、`:145` 及 C4 測試。 |
| C4 4、5、6 | **已修，4 依裁決 5–7。** 帶著 resume 文句的回合正常 Stop 才撤回。無關回合、背景通知不撤回。缺第一個 hook、遲到／領不到的 did 不會撤掉別件。已進 Claude 輸入佇列的文字依實際 intake 結果報。入站用 kind 和 `from===member` 辨識，不靠預填 `session_id`。一般成員通過，漫遊分派另見 T9。 |
| C5 H1、H2、M1、M2 | **已修。** 自動辨識承諾有時間才建列，免誤報的承諾沒有 deadline。主線、分身可用 `commitment_done` 關掉可辨認的承諾。mailbox_decide 仍把決定送回讀信線，只關 mail_due 的 tick。時間限定在承諾子句。15:00 的「3 點半前回報」現在得到當天 15:30。 |
| C5 M3、M4、M5 | **已修或由 C3 接管。** 初次啟用不補已提醒、已過時承諾。忙碌中的 keepwarm 不建，讀完列表／寫入前重驗 idle。M5 涉及的普通 L18 已由 C3 退休，永久拒建另有本機兜底。 |
| C5 L1、L2、L3、L4、L5 | **已修。** L1 永久拒建的 followup 與 promise 跨重啟走本機提醒一次。L2 取消已結束的 followup，舊 peek 不再啟動它。L3 在游標前記住 POST 回的 Item ID，按 ID 撤回。`item-ids` 在已知終局時清除，停機期間的到期由 idle 掃描核對（`onsen-item-writes.ts:70`、`:78`）。L4 Jev 等待後的去重只給 take，兩種模式都有測。L5 keepwarm 時間比對容許約一秒。原先直送的 keepwarm DELETE 已走共用 spool，帶版本並在送出前覆查。 |
| C5 後兩輪的裁決 9–16 | **9** 本文用 `payload.text`。**10** 自動承諾無 deadline，明確承諾有本機 ID 可提前結束。**11** 無時間不建 Item。**12a** 非漫遊 keepwarm 用上次活動 +50 分可領、+60 分到期，冷掉不再喚醒。是否寫 notice 屬伺服器。**12b** 再看不設 waiter，對他人的承諾才設。**13** refs 只帶真的 Onsen Item／run 等，followup 的本機 key 另記回傳 ID。**14** 重送同鍵，伺服器管理鍵的生命週期。**15** 讀信決定仍在本機接線，未讀信的伺服器兜底另有 T4。**16** 外部 watchdog 對 take 跳過，是第一隻正式成員切換前的部署條件。 |
| C6 1、2、3 | **一般路徑已修。** 同 PID 換 UUID 會收尾舊 target、更新新 target。最後 Stop 已出現才離線／換段會 completed，沒有 Stop 則依輸出／回覆決定 half_done。missed 會記下原 session 的狀態，等狀態改變再交，重啟保留。這些 daemon 測試使用寬鬆的 wire 替身，碰到真實伺服器還有 T3、T5、T8。 |
| C6 4、5、6 | **4 的程式已修**，discovery 合併 unit 與 state 設定及名稱辨識，目錄用 realpath，health 同時看成員、connector、輪詢（`telegram-bridge/agents.ts:137`、`:163`、`:173`）。本次依源碼核對 discovery。**5 已修**，選單同步丟例外時 pull 沿用舊 applied、take 報 not_applied。**6 依已定 67** 等 idle，目標依到件時決定，切 /roam 和跨切換的相簿已有正反例。 |
| C6 7a–7d 與原來的三個契約問題 | **7a–7c 已修。** 首次接手遇舊 spool 未清會保持舊輪詢。必須確認並持久化最後的 Telegram offset 才交橋接。執行中切換也會啟用 registry CLI fallback。**7d 仍存在（O4）**，漫遊者列於 `ONSEN_TAKE` 時，啟動舊 poll 前先等 probe，請求逾時上限 5 秒。未列入時照舊。忙碌等待、cut 只回原段、Stop 後離線 completed 三個裁決已套入，實際送出的欄位格式及收下前屆期的例外見 T3、T8。 |

## 其餘核對過的路徑

- **舊拉取的收、ack 與重送。** 沒列名時 daemon 不探 Item。舊 /inbox 的游標、pending、去重、重開後補送及切換前最後一批 ack 有測到。用本機真實 0.42.2 寫一筆走領成員給走拉 waiter 的 notice，再由 v2 的 `OnsenPuller` 走舊 API，交付 callback 收到一次完整 `item_notice`（sender 為 onsen、no_reply 為 true），一次 ack，重開 puller 再讀沒有重交。涵蓋已定 44、71 到舊收件入口這一段。
- **舊拉取的通知、保溫與排程。** 一般成員原本的 due／followup／wall 通知、KEEPWARM_LOCAL 開關和忙碌／cache 時窗仍有拉取測試。排程開始在 pull 的本機 BTCC 替身收到 1 筆 ack，take 收到 0 筆。普通 pull 收尾仍走既有 Call 或 BTCC 設定。P1–P3 是這個範圍內已識別的差異。
- **走領的通常重送。** 同一次遺失 take 回應重試用同一鍵，暫不能交不會佔住別件。hook 等領取最多 3 秒、未綁定 20 秒後報 not_taken／superseded，45 秒租約用 observation 的 held IDs 續。已完成回報在 spool，程序被終止再起先續約、清回報，才重新 peek。跨頁沿用伺服器第一頁的 `changed_after`，以 Item ID 與 version 排重（已定 13–18、33、42、64）。這些案例沒再找到第二個收件者或無限 claimed。T4、T8、T10 是有反例的邊界。
- **普通訊息的接收與重啟。** 主線已有回合時可在工具邊界接入人的新訊息，同一批相簿保留訊息編號。漫遊者切換兩個目標時，相簿兩側各交建立時的目標，重啟後追原 transcript。已看到最後 Stop 才離線會完成原列。這些本機 daemon 案例覆蓋路由，真伺服器對 session 欄位的拒收另見 T3。
- **交接、選單與責任人。** 分身收下前關閉會帶 note 交回主線，收下後正常退出會 completed。選單已不存在會報 not_applied。C3 只在 take 壓掉本機通知，已定 37、49、62 把寄件人成員模式的過濾和 keepwarm 不發 notice 交給 Onsen。C7 的 /inject 改寫、全隊清零才退休舊拉取屬後續版本。

## 在這個環境跑過的

Bun 1.3.11 使用本機既有、同 lockfile 的相依套件及隔離的測試狀態。下列三組首跑共 **21 檔、571 案，570 過、1 失敗**。重跑另計。

| 範圍 | 測試結果 |
|---|---|
| Item／Call／C4／C5／keepwarm／inbox／WO-127 | 8 檔，241 過、0 失敗。檔名為 `onsen-take`、`onsen-calls`、`onsen-items-write`、`onsen-item-writes`、`onsen-c5-lanes`、`keepwarm-local`、`onsen-inbox`、`lanes-wo127`。 |
| 舊拉取相關回歸 | 12 檔，231 過、0 失敗。涵蓋 mail-events、actions、M1/M2/M3、H14、followup、主線 hook、WO-175 回覆、usage wall、WO-200。 |
| `onsen-take-daemon.test.ts` 全檔 | 99 案，98 過、1 失敗。失敗是 O3。原案例另外跑 3 次，2 過、1 失敗。臨時副本只補等待該筆舊投遞，再跑 3 次全過。 |
| 原 C2 排程案例重跑 | 3 種案例 × 5 輪，13 過、2 失敗。具名 Call 的 nothing-to-do 和以 run 查 Call 的 failed 各失敗一次，皆在 Item 終局時取得 null。 |
| 原 observation 檔重跑 | 10 案 × 5 輪，50 過、0 失敗。另用受控時鐘分別釘住 60 與 61 ms（O2）。 |
| 審查重現 | 額外的 10 個對照案例全過，含兩個版本的工具／waiting Call、回覆歸屬、兩種事件名稱、401 及兩個心跳邊界。另外 2 個真 daemon 重現案例全過，分別確認漫遊 self 卡住、回覆型 Call 在 intake 後被 cut。此處的「過」表示斷言驗到表中所述行為。 |
| 0.42.2、PostgreSQL、排程讀者 | 在 127.0.0.1 的 Fleet Core 與專用資料庫實跑前述 3 組排程，另驗 UUID／分身編號 400／200、未讀信 3,600 秒重領、同名／異機所有權、真實租約屆期歷程，以及混合模式 notice 一收一 ack。每輪建立的兩個拋棄式 DB 已清除。 |
| 出版標記、測試台版本 | 在候選 commit 本機執行 `tools/pre-push` 的內容檢查，379／379 個標記齊全。測試台僅讀一次 `GET /healthz`，HTTP 200，回報 0.42.2。版本字串無法鑑別部署 SHA。 |

## 本環境沒有執行或無法確認的

- **257 檔全套未重跑。** 原套件含會建立、開啟指定禁止檔名的身分、bench-cred 與 Telegram bridge 測試（`mesh-identity.test.ts:62`、`bench-cred.daemon.test.ts:39`、`telegram-bridge/telegram-bridge.test.ts:56`）。負責人在同一候選版記錄的全套數字是 257 檔、2,277 過／6 略過／2 失敗。
- **沒有共用測試台的成員寫入或真實 Telegram／Claude／tmux 交付。** 因任務限定不對外送件，以私有 PG、loopback、MCP 目標與隔離的 daemon 驗證。收件 API 與排程投影用了實作。公開測試台實際 SHA、真實 TUI 套用時刻、值班者手機是否收到 S4 告警、長時間重試和兩支完整常駐程式同時運行未驗。
- **未核對正式部署。** 外部 watchdog 是否已依已定 66 每輪查 mode、部署中的排程讀者是否為 `bfa8870` 及正式成員的單實例配置，需由所屬負責人提供版本或部署驗收結果。本次只執行排程投影函式與其 SQL，沒有啟動真實 scheduler 的輪詢、催辦或通知。

## 要負責人定的問題

1. 全隊安裝要以哪個包含 1.59.14 的提交出版？P1 的同儕同回合中，明寫 `because`、沒有引用時，是否保留為獨立工作？P3 的舊拉取編輯文案是否接受？
2. 依已定 80，漫遊者由哪個跨重啟穩定的目標身分生成 Onsen 編號、如何讓接手機器恢復映射？已保存且沒有可辨認首次 intake 的舊列，何時由誰核對原目標？
3. 漫遊成員是否免寫保溫列？若需要保溫，要針對哪些目標、用哪段活動時間。若免除，需把例外寫入已定 23、62、66 的適用範圍。
4. 同機同成員是否在部署層保證只有一個常駐實例，涵蓋不同目錄、不同埠？已知走領後遇 401／403 是否仍依已定 32 暫開舊計時器？
5. 第一隻正式成員切換前，由誰確認測試台讀者與 watchdog 的版本，並驗收第一次看到排程終局即有合法結果、信箱第二次真的交入，以及 S4 的值班通知？
