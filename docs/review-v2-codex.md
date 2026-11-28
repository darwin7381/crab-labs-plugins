# 連接器 v2 獨立審查 · `4c85a9a`

| 編號 | 嚴重度 | 檔案與行（連接器路徑自 `plugins/telegram-http/` 起） | 發現 |
|---|---|---|---|
| P1 | 會壞正式的 | `fleet-mail.ts:333`、`lanes.ts:5848`、`lanes.ts:6866`、`server.ts:2335` | 還在拉的成員明寫理由、交新工作給本回合的來電者，v2 會把它寄成舊 Call 的免回覆。 |
| P2 | 會壞正式的 | `onsen-client.ts:713`、`:721`，對照 `origin/main` 同檔 `:655` | 直接用此 tip 出版會撤掉 1.59.14 的修正，已消失的 Call 又會反覆等，沒有本機 thread 的終局 Call 又會發通知。 |
| T1 | 要改才能上測試台 | `lanes.ts:7932`、`onsen-client.ts:955`、`:1046`、`:1065` | 排程的 Item 可以先完成，當下讀同一個 Call 取得 `completed / result=null`。 |
| T2 | 要改才能上測試台 | `lanes.ts:7936`、`onsen-client.ts:1086`、`test-fixtures/onsen-items.ts:123` | 有步驟的回執會被 0.42.2 回 400，結果不再重送，測試替身卻把這個形狀當成功。 |
| T3 | 要改才能上測試台 | `onsen-claims.ts:182`、`:214`、`:220`、`onsen-client.ts:850`、`roamer-items.ts:69` | 主線、漫遊者把本機 Claude UUID 送作 `in_session.session_id`，伺服器拒收後列仍能直接結案。 |
| T4 | 要改才能上測試台 | `onsen-client.ts:1052`、`onsen-claims.ts:101`、`:226`、`server.ts:5164` | 未讀信被伺服器排回一小時後，連接器卻跨重啟記為已完成，下次領到只回報、不再交信。 |
| T5 | 要改才能切正式成員 | `onsen-items.ts:27`、`onsen-receive.ts:43`、`onsen-claims.ts:170`、`roamer-items.ts:149` | 一封回覆原 Call 的 Item 已進入漫遊對話，目標在 Stop 前結束時仍會被報 cut，回到待交。 |
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

**出版判斷。** 先保住全隊仍走拉的行為。P1 在未配置走領時也成立，P2 取決於用哪個基底出版。兩者處理前不宜把這版鋪到全隊。走領測試成員的下一次驗收應先重驗 T1–T4；漫遊者、選單和多連接器還有各自的切換條件。這份判斷只涵蓋 C1–C6。

**比較基準。** `origin/v2@4c85a9a` 的共同祖先是 1.59.13 `b82e466`。C1 最終版、C2 和測試台憑證路由在 `98666f1`，之後依序為 C5 `536678d`、C4 `56eba3e`、C3 `0119abb`、C6 `4c85a9a`。本機 `origin/main@ef38f5a` 在共同祖先後有六個 commit，含 1.59.14。以下用這兩個基準區別整合引入的改動及主線已修復的回歸。契約以 `onsen-ui/CONTRACT.md` §4b 的條文、狀態表、投影表及已定 1–79 為準，另標出 09:34Z 才釐清判斷 5 的已定 80。外部源碼行號分別固定在 Fleet Core 0.42.2 `7d6e4f6` 與 BTCC `bfa8870`。

## 舊拉取

**P1 · 新工作被寫成回覆。** 讓主線在同一回合處理 Atlas 的 Call A，呼叫 `send_to_agent(line="call", to="atlas", because="另一件事", text="請做 B")`，省略 `reply_to`。在相同的工具入口及綁定條件下，main 送出的 `(reply_to, no_reply, call)` 為 `(空, false, 空)`，v2 為 `(44, true, "27")`。當中的 44、27 是本機傳輸替身觀察到的編號。實際未裝 ItemReceiver 的路由測試也把未填引用的主線呼叫對上當前來電（`lanes-wo175-reply.test.ts:99`）。分身的 `answerToCallArgs` 在既有「不填 line」之外，現在連明寫 `line=call` 的情況也補引用。兩處都在探測走領之前就適用。依 §4 及 §4b 已定 21、38、45，原 Call 的回覆不另開工作。後果是 B 可能沒有自己的 Call 與答覆責任，A 卻多一個回覆。保留明確另開工作的入口，並各驗一次同儕同回合的真回覆與獨立工作。

**P2 · 1.59.14 的兩項行為。** 實際呼叫兩個版本的 `checkWaitingCall`，令 GET 分別回 403、404，main 回 `final:http_403`、`final:http_404`，v2 皆回 `wait`。再給一個已完成、有 conversation、沒有本機 thread 的 Call，main 發 1 次 GET 即結束，v2 另發 1 次 POST 給對話；缺 conversation 時 v2 仍等待。原修正在 `e2c1c09`、`b5950d4`，已合入 `cfc5733`。此處是兩個 tip 的差異，出版時把 v2 合回現行 main 並保住這兩項修正即可避免；與 §4b 開關無關。

**P3 · 編輯訊息。** `person_edit` 優先恢復原文時間，沒有可用時間時不再顯示舊的未知時間佔位。明確設定 `ONSEN_TAKE=''` 的 daemon 案例也走這條路（`onsen-take-daemon.test.ts:237`）。這可保留為獨立的文案修正，但不能簽「舊拉取顯示完全相同」。它不改編輯的投遞編號或 ack。

## 排程回執

**T1 · 已完成的那一刻確實讀得到空結果。** 分身依序把排程結果（spool 的 `c`）與該次 claim 的終局回報（`ir`）寫進本機佇列。`completeRun` 的成功表示入列。`OnsenClient.pass()` 先送待回報的 `ir`，才送原順序的紀錄。這也是為了讓其他 claim 的回報能越過卡住的舊寫入。即使先加入 `c`，也沒有保證同一列的結果先送達。0.42.2 的 `app/onsen_projection.py:15` 直接用 Item 狀態和當時的 `result_outcome` 投影 Call。

在私有 PostgreSQL 上以真正的 v2 client 送件，每個 PUT 收到回應後立刻 GET 同一個 Call；把該次快照餵給真正的 `scheduler-worker/worker.py:678` 的 `project_call`，在另一讀寫步驟查排程列。下表每列是一個獨立 run。

| 同一個 run 的寫入順序 | 第一個回應之後的 Call → 排程 | 第二個回應之後的 Call → 排程 |
|---|---|---|
| 合法結果先入列，v2 優先送 completed | HTTP 200，`completed / null` → `acked / null` | 結果 HTTP 200，`failed / failed` → `completed / failed` |
| v2 帶 steps，優先送 completed | HTTP 200，`completed / null` → `acked / null` | 結果 HTTP 400，仍為 `completed / null` → `acked / null` |
| 對照組，先確認合法結果已送達，再送 completed | HTTP 200，`accepted / failed` → `delivered / null` | 回報 HTTP 200，`failed / failed` → `completed / failed` |

`worker.py:685` 檢查結果是否有內容。此版本沒有把空結果寫成成功，還會再查可投影的 run（`:709`、`:736`）；合法結果晚到能補正。若一直沒有合法結果，稍後可能啟動既有催辦、逾時流程（`:768` 起），本次沒有等到那個逾時。原 daemon 測試只等 Item 完成就查 Call，正好捕捉到真實的可見狀態。不應靠多等一下讓它過。

**T2 · 有步驟時，等也等不到。** `completeRun` 把步驟放進 `result.steps`；0.42.2 的 `app/onsen_calls.py:1221` 拒絕未知欄位。連接器把 400 記到拒收檔，游標往前後待送位元組為 0。替身只檢查外層有一個 `result`，還直接保存傳入物件；測試 `onsen-take-daemon.test.ts:1549`、`:1575` 把不合約的形狀寫成期望。這和 T1 可分別發生。

**最小修正及驗收條件。** 依已定 58、79，把步驟與摘要放入 `result.body.text`，保留機器值 `outcome`（包含 `nothing_to_do`）。只對**這個排程 Item、這次 claim 的 completed** 記下它等待的 Call 結果，該結果 PUT 收到 2xx 才送終局。這個相依關係要和 spool 一起跨重啟，含靠 run ref 查 Call 的路徑。結果遇 503 或回應遺失時重送同一結果，永久拒收則保留可查、可處理的未結案狀態。其他 Item 的回報繼續優先。只等 `syncNow()` 在另一趟 sync 執行中會立即返回（`onsen-client.ts:820`）。驗收要在第一次看見終局時讀 Call，同時驗有步驟、無步驟、查 run ref、寫入後斷線及重新啟動。工作失敗仍依已定 58 報 Item completed，工作結果寫 failed。

## 走領的交付、歸屬與重送

**T3 · 本機 UUID 與 Onsen 的對話編號。** 主線 bind 和漫遊 transcript 的 intake 都把實際 Claude UUID 傳給 `Claims.bind`（`lanes-main.ts:760`、`roamer-items.ts:149`）。它原樣送出，還會把舊佇列的 `main` 改回 UUID。拿 0.42.2 真實的同一筆 claim 送 UUID 得 400，改用合法分身編號得 200（`app/onsen5.py:204`、`app/onsen_items.py:430`）。連接器在本機入列就記 `in_session_at`，拒收後對中途結果直接返回；之後仍可回 completed，外面看不到這段實際執行過程。測試替身在 `test-fixtures/onsen-items.ts:262` 接受 UUID。拒收目前只記 warn，也不符已定 80 要求的 error。保留本機 UUID 追 transcript，送出時用 `main`、合法分身編號或跨重啟穩定的漫遊目標編號；舊帳本、舊 spool 和從歷程恢復都要支援。已定 14、48 說明誰在何時填寫，80 明定編號格式。

**T4 · 未讀信的一小時提醒失效。** 用真信箱建立一封未讀未勾的信，領走並報 completed。伺服器回 200，但回應的 Item 是 `waiting`，其 `not_before` 比更新時間晚 3,600 秒。連接器只把成功與否傳給 `Claims.acknowledged`，此時 `completed(id)` 為 true，重開帳本仍為 true。把本機測試列的到期時間提前後，伺服器再交出**同一 Item、新 claim**；daemon 的快取捷徑會直接重報 completed，整段跳過信件分流。快取上限是七天／5,000 筆，每次成功重報又能留下新時間。只有信箱的未讀信該回 waiting，直送信正常終局（已定 53、77，Core `app/onsen_items.py:456`、`:518`）。應依伺服器回傳的 Item 終局狀態決定是否快取，並處理已有此種快取的帳本。

**T5 · 回覆型 Call 沒在 intake 結束。** 本機真 daemon、替身 Item API、測試 MCP 目標：投一列 `kind=call`、含原 Call ref、`no_reply=true`、帶原訊息引用。漫遊目標看到內容並在 transcript 記下 claim，依然是 `claimed`；讓測試目標在 Stop 前結束，結果 `waiting / cut`。已定 21、38 要求這種回覆進了對話就做完，再交可能在同一段出現兩次。`ItemRef` 與 bind 沒保留這個區別，Core 也把一般 `in_session` 保持在 claimed（`app/onsen_items.py:448`）。須能辨認「原 Call 的回覆」，在確定它已進入目標時結案；一般待辦 Call 仍要等工作結束。

**T6 · 未引用回覆的歸屬太寬。** 在同一 Claude session、同一 conversation，以回合 A 收第一列，報 background，以回合 B 收另一列。只對 B 發一個沒有引用的回覆，兩列的 completed 都帶同一個訊息編號。本機直接跑 `Claims` 得到此結果。`reply()` 有引文時按 conversation 與原訊息編號比對，支援跨 session 的明確引用；沒有引文時，background 且傳入 session 的分支跳過 turn 比對，缺 session 時又只剩 turn。已定 35 用回覆編號算 answered，會遮掉應算未回答的工作。背景通知若屬於 A，需能對回 A 的延續關係。

**T7 · 選單的 deferred 沒實作。** 忙碌時選擇換模型，`runTuiSwitchCommand` 要等目前回合結束、鍵入後再確認結果。呼叫處啟動背景工作就回 true，Item 路徑依布林值當場報 completed。這中間若失敗或程式重啟，Onsen 已顯示套用。§4b「什麼時候可以領」與回報表規定先 deferred，套上後才 completed；已定 55 也明列 deferred 為中途結果。v2 的 Outcome 和中途集合都沒有它。現有「choice throws」測到同步丟例外，沒等這個背景工作的失敗。已無選單的 `not_applied` 是另一條正確路徑。

**T8 · 收下之前失聯的漫遊者。** 讓真實 0.42.2 的 claim 提前屆期並跑 sweep，讀到 `waiting / cut` 和三個事件 `created → claimed → lease_expired`。這時沒有 firstReceiver。給實際 `RoamerItems.destination` 同樣歷程，即使建立時的目標可查、仍在線，得到 null；只把事件改成替身使用的 `taken`，就能回到原目標。對已經收下才 cut 的列，跨機恢復另要求歷程上有裸 UUID，也須配合 T3 的穩定編號。已定 67 要求等待原目標，不能因無法辨認事件或編號而在原目標回來後仍等；真正無法辨認原目標時也不能改送別段。

**T9、T11 · 漫遊者的 self、resume 和保溫。** 同一個開著的 MCP 目標先成功接到普通訊息，再放一列自己寄給自己的 self。標準漫遊組態 `GENESIS_LANES=0` 沒有初始化 lanes；實測記錄讀取 `followups` 失敗，Item 留在 waiting，沒有回報。`ItemPeek` 的路由錯誤會退避重試（`onsen-items.ts:139`）。自己寄的 resume 也直接呼叫未初始化的 `main.routeResume`（靜態核對）。已定 28、39 允許自己留給自己的列，59 定義 resume 的收尾。保溫則更早就被 `!ROAMER` 排除；已定 23、62、66 把寫入責任交給連接器，沒有列出漫遊例外。即使負責人採納免保溫，也仍要讓既有合法 self 到得了原目標。

**T10 · 同機兩支連接器的界線。** 同一個狀態目錄有存活 PID 鎖，同埠也不能同時監聽。用不同目錄及埠時，兩支仍都自稱 `mac-mini/pheme`。用兩個獨立 HTTP client 對同一個本機 Core 探測，兩者都 200，換成別台機器的字串則得 409。同名 client 各領一個不同 Item 都成功；再領對方尚未過期的 Item 得零列。真實風險是合法列落到另一程序的對話，以及租約過期後的重交，不是同一筆有效 claim 被同時發兩次。已定 13、16、18 保留「機器＋成員」讓重啟可接手，部署若允許多 state dir，還需要同機同成員的互斥或明確的單實例保證。

**O1 · 探測失敗的模式。** 實測 200 建立走領後，重新 probe 得 401，`active` 變 false。無回應、5xx 在已啟用時走 unavailable 並保留 active，409 `not_current_connector` 也保留。這是憑證或配置短暫故障時的重複本機通知風險；本次沒有觀察到實際重複通知。已定 32 對非 200 有「照舊拉」的規則，若希望區分「首次探測」和「已知走領」，需由負責人明定。

**O2、O3 · 兩個測試的等待條件。** observation 的測試與實作已存在於 1.59.13。原檔單獨跑五遍全過；沒有更新、heartbeat 60 ms 的受控時鐘在第一拍落於 60 ms 時共送 2 筆，61 ms 時共送 1 筆，兩筆使用同一 `reported_at`。200 ms 只決定何時斷言，無法控制第一拍是否踩到 freshness 的等號。舊投遞的 drain 案例是另一個等待問題：原測試見到 completed、observation、status 就斷言已有 `/deliveries/batch`。在臨時測試副本中保留原斷言，額外等待該批實際包含 `before-switch`，三次都收到恰好一筆。本次沒有從這條失敗證實切換會丟舊投遞。
