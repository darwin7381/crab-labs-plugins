# C7 連接器獨立審查

| 編號 | 嚴重度 | 對應 commit | 檔案與行（見表下路徑說明） | 發現 |
|---|---|---|---|---|
| 01 | 會壞正式的 | `dfde1f1`、基底 `62879d1` | `codex-runner/codex-runner.ts:387,568,583` | 舊 runner 失去租約後仍會啟動工作，兩台機器可各執行同一列一次。 |
| 02 | 會壞正式的 | `1f1b065` 審到，基底 `62879d1` | `codex-runner/codex-runner.ts:884,974` | Core 已接受 peer 回覆，runner 仍因連續三次收不到預期的訊息 ID，把成功工作記為失敗。 |
| 03 | 會壞正式的 | `1f1b065` 審到，基底 `62879d1` | `codex-runner/codex-runner.ts:879,896,914`、`onsen-client.ts:868` | peer 回覆先佔了 Call 的結果，稍後的失敗結果 PUT 收到 200，呼叫端卻看到成功完成。 |
| 04 | 會壞正式的 | `fcb96a6` | `roamer-items.ts:148`、`onsen-claims.ts:119,137,169` | 漫遊者用 Claude 的 UUID 回報收件對話，Core 回 400，本機卻已記為收下。 |
| 05 | 要改才能併 | `fcb96a6` | `roamer-items.ts:57,74`、`server.ts:3655` | 漫遊者在綁定前斷線後，接手者讀錯事件名稱，即使原對話仍在也一直留件。 |
| 06 | 會壞正式的 | `fcb96a6` | `roamer-items.ts:113,124`、`onsen-receive.ts:67` | 訊息在看見與領取之間被編輯，漫遊者仍把舊指令交進對話。 |
| 07 | 會壞正式的 | `250098e` 審到，基底 `f71b383` | `server.ts:3543`、`../agent-inbox/README.md:5` | 普通 `/inject` 請求沒有穩定事件鍵，遺失成功回應後重試會建立第二列。 |
| 08 | 要改才能併 | `1f1b065` 審到，基底 `a02a0b9` | `onsen-client.ts:89,856,878` | 升級前暫存中同帶 `state` 和有效 `result` 的 Call 記錄，重啟後會靜默略過。 |
| 09 | 會壞正式的 | `ec6e77a` | `duty-officer.ts:122,1021,1434` | 只移動選單游標就可能把仍在畫面上的原 Action 取消。 |
| 10 | 要改才能併 | `ec6e77a` | `duty-officer.ts:971,1437`、`onsen-client.ts:1531,1625` | 遠端取消尚未成功，本機已寫結案，斷線後重啟會留下仍可作答的舊 Action。 |
| 11 | 要改才能併 | `ec6e77a` 審到，沿用基底判斷 | `startup-picker.ts:215`、`server.ts:1315,3678` | 啟動選單沒送出 Enter 也會回報 control 已套用。 |
| 12 | 會壞正式的 | `dfde1f1`、`fcb96a6`，一般 pull 刪除早於基底 | `onsen-take.ts:38,61`、`server.ts:139,324`、`docs/C7-spec.md:7` | 將此版部署給仍在 pull 的成員會切斷收件，程式沒有檢查全體 pull 歸零或漫遊者橋接已接手。 |
| 13 | 要改才能併 | `dfde1f1` | `server.ts:324,3205`、`codex-runner/codex-runner.ts:449` | 啟動時本機停用的成員沒有 60 秒重探，修正設定後仍收不到。 |
| 14 | 要改才能併 | `dfde1f1`，跨 Core | `server.ts:3254`、Core `app/onsen_v1_items.py:63,143` | 已沒有有效連接器的成員送出普通 idle observation，Core 仍把等待列標為可領。 |
| 15 | 要改才能併 | `250098e` | `lanes.ts:1868`、`lanes-main.ts:452,619` | `/inject` 的閒時規則套到所有 self，連有期限的既有承諾逾時也不在工具邊界領。 |
| 16 | 只是觀察 | `fcb96a6` | `server.ts:314,343`、`onsen-client.ts:1371,915` | 漫遊者升級後，第一次探取模式前就會嘗試送出舊磁碟上保留的訊息。 |
| 17 | 要改才能併 | `fcb96a6`、`ec6e77a` | repo 根 `tools/pre-push:13`、`tools/canaries.txt:9,227,276` | 送出前檢查的 330 個標記有 11 個找不到，現有 hook 會以 1 結束。 |
| 18 | 會壞正式的 | `fcb96a6`、`250098e` 沿用基底分流 | `onsen-items.ts:21`、`server.ts:3645`、`lanes.ts:1868` | 寄件方預填 main 的普通話題訊息繞過話題分流，排進主線。 |
| 19 | 要改才能併 | `fcb96a6` 審到，舊審查 7 | `server.ts:3437`、`onsen-items.ts:100` | 對無法分流的人訊息只記一行就返回，列一直 waiting，C1 的處置尚未接回。 |
| 20 | 要改才能併 | `fcb96a6` 審到，舊審查 8 | `server.ts:337,3685`、`keepwarm-local.ts:242` | 這個 tip 能收保溫列，但缺少切換後負責寫這些列的 C5 路徑。 |
| 21 | 要改才能併 | `dfde1f1` 審到，舊審查 9 | `onsen-take.ts:17,65`、`lanes.ts:329` | C3 用來區分探測與舊模式的條件尚未整合，舊計時器在此版仍會啟動。 |

**合併判斷：先擋下 C7。** 本機重現了同一件工作啟動兩次、失敗 Call 顯示完成、漫遊者收下的對話無法登記，以及普通訊息進錯主線。即使修掉這些問題，撤掉舊收件程式仍有成員清冊與橋接驗收兩項部署前提。

審查範圍為 `origin/wo213-c7` 的 `b2f523f..ec6e77a` 五個 commit。除另註外，檔案位置以 `ec6e77a:plugins/telegram-http/` 為基準。下文「已定」指契約正本 `onsen-ui/CONTRACT.md` 第 4b 節。Core 行號對應本機 Fleet Core 0.42.1（`20a9dc0`）。表內「基底」表示進入這五個 commit 前已存在。已定 78 的頂層 `note` 與 79 的 `result.steps` 已由其他工作處理，不計入本表。

## 漏交、重複執行與交錯對話

**01．兩個 runner 都啟動了工作（已定 13、14、16–18、22、72）。** A 在下載附件前就把列綁到 `main`。讓下載暫停、令 A 收到 409、停止續租，將測試時鐘推進 46 秒。B 用另一個狀態目錄領回並完成同一列，此時才放行 A 的下載。兩個真 runner 啟動了兩次測試工作程序，穩定的回覆鍵讓假伺服器只記一則回覆。A 的暫停回呼只停 peek，下載後的 `Claims.owns` 只讀自己的記錄（`onsen-claims.ts:50`）。本機真 Core 也確認第二支連接器探取會收到 409，非現任連接器的 observation 可收 200 卻沒有續租。檢查工作是否還能啟動必須涵蓋準備時失去租約的情況，回覆去重無法撤銷已執行的工作。

**02．回覆已送達，runner 卻判失敗（已定 26、35、58）。** 本機 Core 的 `/send` 回傳 `to, seq, duplicate, call_id, pulling, recipient`。同一鍵送三次，`duplicate` 依序為 false、true、true。runner 只認 `results[0].message_id` 中的 `cm<數字>`，達三次就改寫工作結果。一個結束碼 0 的工作也成了本機 `failed`。Core 的回覆組裝在 `app/onsen5.py:409`，runner 的假 Core 則主動補了要求的欄位（`codex-runner/codex-runner.test.ts:60`）。回覆 ID 要能指回已建立的那一則，不能拿收件序號猜。

**03．有結果的 PUT 回 200，結果仍然丟了（已定 58）。** runner 先對 peer 送帶原 Call ref 的回覆，再寫 `{result}`，最後回報 Item `completed`。Core 在連回原 Call 時先把訊息文字寫入結果，稍後只在既有結果文字為空時收 typed result（`app/onsen_calls.py:496,526,1285`）。獨立送一則回覆再 PUT 合法的 `outcome:failed`，讀回仍是第一則文字、`outcome:null`。再以真 runner 各跑一件結束碼 0 和 3 的工作，兩個 Call 都是 `completed`、`result.outcome=null`、各一則回覆。失敗投影讀的正是遺失的欄位（`app/onsen_projection.py:12`）。即使修好 02 的 ID，此先後順序仍會丟結果。另見 `codex-runner.ts:920`，有工作失敗、無回覆錯誤時，結果文字還會被抄進 Item 完成回報的 `note`。

**04．漫遊者的本機對話 ID 無法登記（已定 14、48、67、74）。** transcript 提供的 UUID 從 `RoamerItems.tick` 一路原樣進 `Claims.bind` 和 `in_session.session_id`。用同一份合法 claim 對真 Core 回報，裸 UUID 得到 400 `invalid_request`，讀回 `in_session_at=null`。改成契約格式 `space-roamers.roam.1` 得到 200（驗證見 Core `app/onsen_items.py:422`）。本機在入 spool 時就寫了收下時間，永久拒絕也不撤回中間狀態（`onsen-claims.ts:162,169`）。新機恢復時又只接受 UUID（`roamer-items.ts:65`）。原 daemon 測試有兩段真 MCP 測試連線，但它的假 Core 接受 UUID，還直接覆寫寄件方指定的 Item.session_id（`onsen-take-daemon.test.ts:534`、`test-fixtures/onsen-items.ts:133`）。需要讓本機對話與契約 ID 的對應在換機後也找得回來。

**05．斷在 claim 與收下之間（已定 17、67）。** 正常領走、尚未 `in_session` 就 `cut`，真 Core 的事件依序為 `created, claimed, cut, failure`（寫入見 `app/onsen_items.py:346`）。接手者沒有本機 firstReceiver 時卻要求事件 `taken`，提早返回，沒有走到用列的建立時間查歷史目標那一行。在元件測試保留原 A 的選擇紀錄及活著的 A，`destination()` 仍回 null，daemon 把列留在 Onsen。測試替身產生的事件正好叫 `taken`（`test-fixtures/onsen-items.ts:113`）。

**06．領到修正版，交進對話的仍是舊版（已定 17、29、34）。** 漫遊者從 peek 的 payload 組通知。在 peek 之後、take 之前把同一個 waiting Item 的文字從「原指令」改成「更正指令」。真 `ItemReceiver` 收到新版列，`RoamerItems.offer` 只取回傳的 ID 集合，再把先前通知送進 stream。實測只送一次，內容為原指令。這種 waiting edit 原地改一列，之後正常完成也沒有第二列替人補交。

**07．本機發件者重試（「寫一列」、已定 64、73）。** 對真 daemon 模擬「第一次已寫入、呼叫端沒收到回應」，用已授權的相同身分重送常見的 `{from,text}`。允許寫入的測試端收到兩個 UUID，產生兩列。另一對相同請求帶穩定 `dedupe`，只產生一列，合計四請求三列。程式僅對可信來源提供的 `dedupe` 或整數 `msg_id` 重用鍵。另用已定 78 的合法 body 直打真 Core，重用鍵得到同一 ID，換鍵得到兩個 ID。這一項在已定 78 修完後仍成立。發件方需保留可跨重試的事件識別，單靠文字無法辨別兩次有意發送。

**08．舊磁碟上的最後一筆結果（已定 58）。** 建立一筆舊型別本來就允許的 `k:c`，內含 `state:failed`、Call ID 與有效的失敗結果。重啟同步後，PUT 次數 0、待送 0，也沒有拒絕記錄；帶 state 的分支直接移過游標。既有測試的舊樣本只有 state（`onsen-spool-skip.test.ts:33`）。只有能證明所有舊 spool 都已送清，才能排除這條升級漏件路。

**18．正常話題被當成分身交回（已定 48、51、54）。** 在 daemon 先把話題 555 綁到 `adam.worker.1`，再投一則普通人訊息，寄件方指定 `session_id:main`，沒有 `reason:reassigned`。實測主線的待交記錄出現該 Item 且 `main:true`。現有正向話題測試用沒預填 main 的列（`onsen-take-daemon.test.ts:285`）。`itemRef` 只看 session_id 便設 main，`routeEvent` 在話題規則前直接轉主線。它也從歷史找最後一次 reassigned 的註記，可能沿用舊說明。契約給本次交回的辨識依據是列上當下的 `reason` 和 `note`。

## 選單與按鍵

**09．選單仍在卻被取消（已定 75）。** 讓真 DutyOfficer 看同一個 pane 的同一份選項，只把反白從第一列移至第二列。選項和提示仍在，沒有 Enter、沒有送鍵，原 Action 卻被取消一次，原因為「在別處按了」。`thash` 包含游標，`step` 在 OTHER → OTHER 只要雜湊變了就呼叫 `closeGone`。共享 permission 的取消也會移除相應 pending prompt（`server.ts:1157`）。判斷應能區分同一選單的畫面變化與真正離開。

**10．網路恢復後原 Action 還開著（已定 75）。** 讓選單確實消失，對同一 Action 的取消連續回三次 503，然後重啟 DutyOfficer。遠端 handle 仍 open，本機已持久化 `closed/action_closed`，啟動掃描略過，恢復取消次數 0。Telegram 回答後的分支也在確認前寫入結案（`duty-officer.ts:1533`）。現有短暫失敗重試保存在記憶體，需要能從磁碟辨認尚待確認的取消。

**11．沒按下的選項算作成功（第 4b 節 control 的 `not_applied`，已定 75）。** 讓啟動選單收到 Down 後仍停在原選項，重新擷取確認游標未到位。實際驅動函式回 `stuck`，測試 tmux 只錄到 Down。呼叫端只將 `gone` 當作失敗，這個 `stuck` 會呼叫 `applied` 並回 true，之後把 control 列報成 `completed`。另一種「已送 Enter、畫面還在」也叫 stuck，兩種事實在此已無從區別。

## 還在 pull 的成員與升級

**12．混合期間必須保留舊程式（已定 24、32、44、66、71–74）。** 在 0.42.1 把本機測試成員設成 pull，帶 connector 的短探與欄位完全合法的 self POST 都回 409 `not_take_member`（Core `app/onsen_items.py:642`）。C7 收到前者後停領，後者在 `/inject` 端也回 409。原 `onsen-take-daemon.test.ts:126` 在假伺服器 409 模式還能寫 self，因替身只按帶 connector 的請求拒絕。若該成員仍保有舊程式，既有 pull/ack 可繼續，若換成 C7 則無收件路可退。實際刪除邊界如下。

| 等待條件 | 受影響路徑 | 邊界在哪裡 |
|---|---|---|
| 逐成員停舊拉、交完已收的件、補完 ack，全體 pull 成員數歸零 | 一般 daemon 與 runner 的 OnsenPuller、cursor/累積 ack、本機 pending 暫存、清理與重播（D1–D3）、D7 的人訊息／Action／lane 交接、D10 舊寫入、O5 表單匣、O6 mention 喚醒、O7 舊入口 | 多數早於本次五個 commit（如 `b99c054`、`1aee4ff`）。舊 inbox-only 行程呼叫新 daemon 已撤的交接路由會得到 404。`/lanes/mail-event` 仍是獨立路徑。已定 71 要求 pull 方仍收得到 notice。 |
| 各漫遊者 bot 已由機器上的橋接接管、四身分完成 C6 測試，且達上述舊拉退休條件 | `fcb96a6` 刪 `roamer-telegram.ts`、Telegram polling 及該路的測試，改由共用接收器入 MCP | 刪除對整個版本生效。`docs/C7-spec.md:7` 是人工清單，程式不查全體成員模式、橋接或 C6 驗收。即使 24 小時零 GET /inbox，安靜的 pull 成員仍可能存在。 |
| 每一輪按成員讀模式，第一隻正式切換前成立 | 已定 66 的 watchdog 對 take 停寫，pull 繼續舊保溫 | 另須有 C5 寫 take 的 keepwarm，見 20。 |
| 所有本機寄件端搬完，連續 24 小時零次 `/inject` | 保留的 `/inject` writer | 已定 73 有自己的計數與退休時間。此版保留路由；混用期間要確認各寄件者所對的成員及版本。 |

**13．本機條件沒有每分鐘重看（已定 72）。** 真 daemon 用 `ONSEN_RECORD=0` 啟動，再把同一份機器設定改成 1。61.5 秒後，`/healthz` 仍是 `recording_off`，Item 探取次數 0。daemon 在啟動時計算 `takeOffReason`，分支外沒有重建 TakeMode 的計時器。runner 停用時也在啟動早退。已建好 TakeMode 後碰到遠端 `not_take_member` 的 60 秒重探另有實作。

**14．Core 的可領判定仍少一個條件（已定 18、22、41、72）。** 在獨立 PG 放一列 waiting self，讓 take 成員最後一次有效 connector 出現在 61 秒前，再送一筆新鮮 idle observation，省略 `connector` 與 `held_item_ids`。真 Core 的 `GET /items/<id>` 回 `takeable:{now:true,why:null}`。C7 對這兩個鍵的省略符合契約，0.42.1 的讀取判定卻只看 observation 狀態與新鮮度。這會使等待的人看不到 offline 原因。修正應仍認得另一支真正活著的現任連接器。

**15．一般 self 與逾時承諾（「什麼時候可以領」表、已定 15、39、73）。** `250098e` 把所有 self 固定送主線，又在忙碌回合的 `readyInTurn` 排除所有 self 的 deadline。讓主線忙碌並觸發 PostToolUse，一列逾時 self 仍沒被領，同一時點、相同 deadline 的 mail 已領。契約允許 self 承諾指定 deadline 和目標對話，逾時任何一列可在工具邊界領；一般無 deadline 的注入等閒時符合規則。正式庫中是否已有指定分身的 self，本審查沒有量測。

**16．舊漫遊者 spool 的影響取決於既有資料（已定 24、67、74）。** `fcb96a6` 移除漫遊者的記錄排除後，daemon 沿用同一個狀態目錄，並在探取前啟動同步。用一筆保留的 `k:m` 啟動元件，確實在第一次 probe 前就呼叫一次 `/messages/batch`、移過游標。正式是否存在這些資料、舊鍵在接收端是否仍能去重均未驗，不能據此稱已經重交。升級清冊要能區別未送、已送待確認，以及預期封存的記錄。

**17．保護合併的標記失效。** 在本機把待檢查的 ref 餵給 `sh tools/pre-push`，全程沒有 push。基底與前三個 commit 的清單各為 338/338，`fcb96a6` 缺 8/330，`ec6e77a` 缺 11/330，結束碼 1。缺項在 repo 根 `tools/canaries.txt:9,113,227,230,231,232,234,252,253,256,276`，涉及共用 permission、picker、回覆與其他舊標記。有些是函式已移動或簽名已變，應逐項核對原本保護的行為，不能把 11 計為 11 個功能回歸。

**19–21．整合前仍缺的三條路。** 19：`receivePerson` 對缺 chat/號碼或不在 allowlist 的訊息直接 return，peek 隨即標該版本已看，重新完整掃描才再嘗試。這裡需要接回 C1 的無法分流處置並保留拒絕原因，與已定 67 明確要求漫遊者等原對話的情境分開。20：已定 23 要求連接器替自己寫 keepwarm，這個 tip 只有把收到的列轉為 `wd_keepwarm`，沒有建構寫入端。C5 的對應啟動處在其 `server.ts:3007`。21：C7 的 TakeMode 沒有 C3 的 `checking/canReceive` 區分，`lanes.ts:329,2999,4200,6003` 仍啟用或執行 sweep、follow-up、due 與 flood 流程。整合時需保留 C3 在探測／拒領時防止舊流程寫第二份的行為。這兩項是分支相接的缺口，本次沒有觀測到正式重複保溫或提醒。
