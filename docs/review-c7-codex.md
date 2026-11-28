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
| 14 | 要改才能併 | `dfde1f1`，跨 Core | `server.ts:3254`、Core 0.42.1 `app/onsen_v1_items.py:143`、0.42.2 `app/onsen_v1_members.py:957` | 0.42.1 會把離線成員顯示為可領，0.42.2 的拒領者能把仍在線的現任連接器蓋成離線。 |
| 15 | 要改才能併 | `250098e` | `lanes.ts:1868`、`lanes-main.ts:452,619` | `/inject` 的閒時規則套到所有 self，連有期限的既有承諾逾時也不在工具邊界領。 |
| 16 | 只是觀察 | `fcb96a6` | `server.ts:314,343`、`onsen-client.ts:1371,915` | 漫遊者升級後，第一次探取模式前就會嘗試送出舊磁碟上保留的訊息。 |
| 17 | 要改才能併 | `fcb96a6`、`ec6e77a` | repo 根 `tools/pre-push:13`、`tools/canaries.txt:9,227,276` | 送出前檢查的 330 個標記有 11 個找不到，現有 hook 會以 1 結束。 |
| 18 | 會壞正式的 | `fcb96a6`、`250098e` 沿用基底分流 | `onsen-items.ts:21`、`server.ts:3645`、`lanes.ts:1868` | 寄件方預填 main 的普通話題訊息繞過話題分流，排進主線。 |
| 19 | 要改才能併 | `fcb96a6` 審到，舊審查 7 | `server.ts:3437`、`onsen-items.ts:100` | 對無法分流的人訊息只記一行就返回，列一直 waiting，C1 的處置尚未接回。 |
| 20 | 要改才能併 | `fcb96a6` 審到，舊審查 8 | `server.ts:337,3685`、`keepwarm-local.ts:242` | 這個 tip 能收保溫列，但缺少切換後負責寫這些列的 C5 路徑。 |
| 21 | 要改才能併 | `dfde1f1` 審到，舊審查 9 | `onsen-take.ts:17,65`、`lanes.ts:329` | C3 用來區分探測與舊模式的條件尚未整合，舊計時器在此版仍會啟動。 |

**此版先不要合併。** 本機重現了同一件工作啟動兩次、失敗 Call 顯示完成、漫遊者收下的對話無法登記，以及普通訊息進錯主線。即使修掉這些問題，撤掉舊收件程式仍有成員清冊與橋接驗收兩項部署前提。

審查範圍為 `origin/wo213-c7` 的 `b2f523f..ec6e77a` 五個 commit。除另註外，檔案位置以 `ec6e77a:plugins/telegram-http/` 為基準。下文「已定」指契約正本 `/Users/btai/rescue-site/onsen-ui/CONTRACT.md` 第 4b 節。Core 行號預設對應本機 0.42.1（`20a9dc0`）。另以 0.42.2 整合版（`7d6e4f6`）重跑，與共用測試台的 0.42.1 分別計數。表內「基底」表示該行為在這五個 commit 之前就已存在。已定 78 的頂層 `note` 與 79 的 `result.steps` 由另一件工作修正，本表的發現即使修好這兩項仍然成立。

## 漏交、重複執行與交錯對話

**01．兩個 runner 都啟動了工作（已定 13、14、16–18、22、72）。** A 在下載附件前就把列綁到 `main`。讓下載暫停、令 A 收到 409、停止續租，將測試時鐘推進 46 秒。B 用另一個狀態目錄領回並完成同一列，此時才放行 A 的下載。兩個真 runner 啟動了兩次測試工作程序，穩定的回覆鍵讓假伺服器只記一則回覆。A 的暫停回呼只停 peek，下載後的 `Claims.owns` 只讀自己的記錄（`onsen-claims.ts:50`）。本機真 Core 也確認第二支連接器探取會收到 409，非現任連接器的 observation 可收 200 卻沒有續租。檢查工作是否還能啟動必須涵蓋準備時失去租約的情況，回覆去重無法撤銷已執行的工作。

**02．回覆已送達，runner 卻判失敗（已定 26、35、58）。** 本機 Core 的 `/send` 回傳 `to, seq, duplicate, call_id, pulling, recipient`。同一鍵送三次，`duplicate` 依序為 false、true、true。runner 只認 `results[0].message_id` 中的 `cm<數字>`，達三次就改寫工作結果。一個結束碼 0 的工作也成了本機 `failed`。Core 的回覆組裝在 `app/onsen5.py:409`，runner 的假 Core 則主動補了要求的欄位（`codex-runner/codex-runner.test.ts:60`）。回覆 ID 要能指回已建立的那一則，不能拿收件序號猜。

**03．有結果的 PUT 回 200，結果仍然丟了（已定 58）。** runner 先對 peer 送帶原 Call ref 的回覆，再寫 `{result}`，最後回報 Item `completed`。Core 在連回原 Call 時先把訊息文字寫入結果，稍後只在既有結果文字為空時收 typed result（`app/onsen_calls.py:496,526,1285`）。獨立送一則回覆再 PUT 合法的 `outcome:failed`，讀回仍是第一則文字、`outcome:null`。以真 runner 分別連接 0.42.1 和 0.42.2，每版各跑一件結束碼 0 和 3 的工作。兩版讀回的 Call 全都是 `completed`、`result.outcome=null`、各一則回覆。失敗投影讀的正是遺失的欄位（`app/onsen_projection.py:12`）。即使修好 02 的 ID，此先後順序仍會丟結果。另見 `codex-runner/codex-runner.ts:920`，有工作失敗、無回覆錯誤時，結果文字還會被抄進 Item 完成回報的 `note`。

**04．漫遊者的本機對話 ID 無法登記（已定 14、48、67、74）。** transcript 提供的 UUID 從 `RoamerItems.tick` 一路原樣進 `Claims.bind` 和 `in_session.session_id`。用同一份合法 claim 對真 Core 回報，裸 UUID 得到 400 `invalid_request`，讀回 `in_session_at=null`。改成契約格式 `space-roamers.roam.1` 得到 200（驗證見 Core `app/onsen_items.py:422`）。本機在入 spool 時就寫了收下時間，永久拒絕也不撤回中間狀態（`onsen-claims.ts:162,169`）。新機恢復時又只接受 UUID（`roamer-items.ts:65`）。原 daemon 測試有兩段真 MCP 測試連線，但它的假 Core 接受 UUID，還直接覆寫寄件方指定的 Item.session_id（`onsen-take-daemon.test.ts:534`、`test-fixtures/onsen-items.ts:133`）。需要讓本機對話與契約 ID 的對應在換機後也找得回來。

**05．斷在 claim 與收下之間（已定 17、67）。** 正常領走、尚未 `in_session` 就 `cut`，真 Core 的事件依序為 `created, claimed, cut, failure`（寫入見 `app/onsen_items.py:346`）。接手者沒有本機 firstReceiver 時卻要求事件 `taken`，提早返回，沒有走到用列的建立時間查歷史目標那一行。在元件測試保留原 A 的選擇紀錄及活著的 A，`destination()` 仍回 null，daemon 把列留在 Onsen。測試替身產生的事件正好叫 `taken`（`test-fixtures/onsen-items.ts:113`）。

**06．領到修正版，交進對話的仍是舊版（已定 17、29、34）。** 漫遊者從 peek 的 payload 組通知。在 peek 之後、take 之前把同一個 waiting Item 的文字從「原指令」改成「更正指令」。真 `ItemReceiver` 收到新版列，`RoamerItems.offer` 只取回傳的 ID 集合，再把先前通知送進 stream。實測只送一次，內容為原指令。這種 waiting edit 原地改一列，之後正常完成也沒有第二列替人補交。

**07．本機發件者重試（「寫一列」、已定 64、73）。** 對真 daemon 模擬「第一次已寫入、呼叫端沒收到回應」，用已授權的相同身分重送常見的 `{from,text}`。允許寫入的測試端收到兩個 UUID，產生兩列。另一對相同請求帶穩定 `dedupe`，只產生一列，合計四請求三列。程式僅對可信來源提供的 `dedupe` 或整數 `msg_id` 重用鍵。另用已定 78 的合法 body 直打真 Core，重用鍵得到同一 ID，換鍵得到兩個 ID。這一項在已定 78 修完後仍成立。發件方需保留可跨重試的事件識別，單靠文字無法辨別兩次有意發送。

**08．舊磁碟上的最後一筆結果（已定 58）。** 建立一筆舊型別本來就允許的 `k:c`，內含 `state:failed`、Call ID 與有效的失敗結果。重啟同步後，PUT 次數 0、待送 0，也沒有拒絕記錄。帶 state 的分支直接移過游標。既有測試的舊樣本只有 state（`onsen-spool-skip.test.ts:33`）。只有能證明所有舊 spool 都已送清，才能排除這條升級漏件路。

**18．正常話題被當成分身交回（已定 48、51、54）。** 在 daemon 先把話題 555 綁到 `adam.worker.1`，再投一則普通人訊息，寄件方指定 `session_id:main`，沒有 `reason:reassigned`。實測主線的待交記錄出現該 Item 且 `main:true`。現有正向話題測試用沒預填 main 的列（`onsen-take-daemon.test.ts:285`）。`itemRef` 只看 session_id 便設 main，`routeEvent` 在話題規則前直接轉主線。它也從歷史找最後一次 reassigned 的註記，可能沿用舊說明。契約給本次交回的辨識依據是列上當下的 `reason` 和 `note`。

## 選單與按鍵

**09．選單仍在卻被取消（已定 75）。** 讓真 DutyOfficer 看同一個 pane 的同一份選項，只把反白從第一列移至第二列。選項和提示仍在，沒有 Enter、沒有送鍵，原 Action 卻被取消一次，原因為「在別處按了」。`thash` 包含游標，`step` 在 OTHER → OTHER 只要雜湊變了就呼叫 `closeGone`。共享 permission 的取消也會移除相應 pending prompt（`server.ts:1158–1162`）。判斷應能區分同一選單的畫面變化與真正離開。

**10．網路恢復後原 Action 還開著（已定 75）。** 讓選單確實消失，對同一 Action 的取消連續回三次 503，然後重啟 DutyOfficer。遠端 handle 仍 open，本機已持久化 `closed/action_closed`，啟動掃描略過，恢復取消次數 0。Telegram 回答後的分支也在確認前寫入結案（`duty-officer.ts:1533`）。現有短暫失敗重試保存在記憶體，需要能從磁碟辨認尚待確認的取消。

**11．沒按下的選項算作成功（第 4b 節 control 的 `not_applied`，已定 75）。** 讓啟動選單收到 Down 後仍停在原選項，重新擷取確認游標未到位。實際驅動函式回 `stuck`，測試 tmux 只錄到 Down。呼叫端只將 `gone` 當作失敗，這個 `stuck` 會呼叫 `applied` 並回 true，之後把 control 列報成 `completed`。另一種「已送 Enter、畫面還在」也叫 stuck，兩種事實在此已無從區別。

## 還在 pull 的成員與升級

**12．混合期間必須保留舊程式（已定 24、32、44、66、71–74）。** 分別在本機 0.42.1 和 0.42.2 把測試成員設為 pull，帶 connector 的短探與欄位完全合法的 self POST 都回 409 `not_take_member`（Core `app/onsen_items.py:642`）。C7 收到前者後停領，後者在 `/inject` 端也回 409。原 `onsen-take-daemon.test.ts:126` 在假伺服器 409 模式還能寫 self，因替身只按帶 connector 的請求拒絕。保留舊程式的成員能繼續 pull/ack。仍設為 pull 的成員換版後會停止收件。

| 等待條件 | 受影響路徑 | 邊界在哪裡 |
|---|---|---|
| 逐成員停舊拉、交完已收的件、補完 ack，全體 pull 成員數歸零 | 一般 daemon 與 runner 的 OnsenPuller、cursor/累積 ack、本機 pending 暫存、清理與重播（D1–D3）、D7 的人訊息／Action／lane 交接、D10 舊寫入、O5 表單匣、O6 mention 喚醒、O7 舊入口 | 多數早於本次五個 commit（如 `b99c054`、`1aee4ff`）。舊 inbox-only 行程呼叫新 daemon 已撤的交接路由會得到 404。`/lanes/mail-event` 仍是獨立路徑。已定 71 要求 pull 方仍收得到 notice。 |
| 各漫遊者 bot 已由機器上的橋接接管、四身分完成 C6 測試，且達上述舊拉退休條件 | `fcb96a6` 刪 `roamer-telegram.ts`、Telegram polling 及該路的測試，改由共用接收器入 MCP | 刪除對整個版本生效。`docs/C7-spec.md:7` 是人工清單，程式不查全體成員模式、橋接或 C6 驗收。即使 24 小時零 GET /inbox，安靜的 pull 成員仍可能存在。 |
| 每一輪按成員讀模式，第一隻正式切換前成立 | 已定 66 的 watchdog 對 take 停寫，pull 繼續舊保溫 | 另須有 C5 寫 take 的 keepwarm，見 20。 |
| 所有本機寄件端搬完，連續 24 小時零次 `/inject` | 保留的 `/inject` writer | 已定 73 有自己的計數與退休時間。此版保留路由，混用期間要確認各寄件者所對的成員及版本。 |

**13．本機條件沒有每分鐘重看（已定 72）。** 真 daemon 用 `ONSEN_RECORD=0` 啟動，再把同一份機器設定改成 1。61.5 秒後，`/healthz` 仍是 `recording_off`，Item 探取次數 0。daemon 在啟動時計算 `takeOffReason`，分支外沒有重建 TakeMode 的計時器。runner 停用時也在啟動早退。已建好 TakeMode 後碰到遠端 `not_take_member` 時，則會排定 60 秒後重探。

**14．拒領者能改變別人看到的可領狀態（已定 13、18、22、41、72）。** 在獨立 PG 放一列 waiting self，把最後一次有效 connector 的時間設為 61 秒前。送一筆依 72 省略兩個 connector 欄位的新鮮 idle observation 後讀回 Item。0.42.1 回 `{now:true,why:null}`。0.42.2 的 `delivery_observation` 已把這例正確判為 offline（該版 `app/onsen_v1_items.py:144`）。

在 0.42.2 再讓 A 取得 connector 並送出 idle observation。B 的短探收到 409 `not_current_connector`，接著依 C7 送普通 idle observation。讀回 delivery 時現任仍是 A，但同一等待列在 A 心跳、B 心跳、A 再次心跳後依序是 **可領 → offline → 可領**。Core 用 member 當唯一鍵覆寫最後一份 observation（該版 `app/onsen_v1_members.py:957`）。兩支 daemon 同時執行期間，等候者看到的原因會隨最後回報者改變。

**15．一般 self 與逾時承諾（「什麼時候可以領」表、已定 15、39、73）。** `250098e` 把所有 self 固定送主線，又在忙碌回合的 `readyInTurn` 排除所有 self 的 deadline。讓主線忙碌並觸發 PostToolUse，一列逾時 self 仍沒被領，同一時點、相同 deadline 的 mail 已領。契約允許 self 承諾指定 deadline 和目標對話，逾時的列可在工具邊界領。一般無 deadline 的注入等閒時符合規則。正式庫中是否已有指定分身的 self，本審查沒有量測。

**16．舊漫遊者 spool 的影響取決於既有資料（已定 24、67、74）。** `fcb96a6` 移除漫遊者的記錄排除後，daemon 沿用同一個狀態目錄，並在探取前啟動同步。用一筆保留的 `k:m` 啟動元件，確實在第一次 probe 前就呼叫一次 `/messages/batch`、移過游標。正式是否存在這些資料、舊鍵在接收端是否仍能去重均未驗，不能據此稱已經重交。升級清冊要能區別未送、已送待確認，以及預期封存的記錄。

**17．保護合併的標記失效。** 在本機把待檢查的 ref 餵給 `sh tools/pre-push`，全程沒有 push。基底與前三個 commit 的清單各為 338/338，`fcb96a6` 缺 8/330，`ec6e77a` 缺 11/330，結束碼 1。缺項在 repo 根 `tools/canaries.txt:9,113,227,230,231,232,234,252,253,256,276`，涉及共用 permission、picker、回覆與其他舊標記。有些是函式已移動或簽名已變，應逐項核對原本保護的行為，不能把 11 計為 11 個功能回歸。

**19．無法分流的人訊息（第 4b 節「連接器不丟列」、C1 修正）。** `receivePerson` 對缺 chat/號碼或不在 allowlist 的訊息直接 return，peek 隨即標該版本已看，重新完整掃描才再嘗試。C1 的修正用 dropped 回傳處置無法交付的列。在共同版本應核對永久拒絕的紀錄，以及已定 67 要求暫留、日後仍可交付的列。

**20．保溫的寫入端未接回（已定 23、66）。** 已定 23 要求連接器替自己寫 keepwarm，這個 tip 只有把收到的列轉為 `wd_keepwarm`，沒有建構寫入端。C5 的對應啟動處在其 `server.ts:3007`。

**21．暫停時舊計時器仍在（已定 32、72 與 C3 的切換條件）。** C7 的 TakeMode 沒有 C3 的 `checking/canReceive` 區分，`lanes.ts:329,2999,4200,6003` 仍啟用或執行 sweep、follow-up、due 與 flood 流程。整合時需保留 C3 在探測／拒領時防止舊流程寫第二份的行為。20、21 是整合缺口。部署後重複保溫或提醒的次數未知。

## 舊審查逐條核對

前份 `/Users/btai/Development/wo213/review-c7.md` 看的是 `2ea1744`。下表以相同編號核對到 `ec6e77a`，也標出實際修復是否早於本次範圍。

| 舊項 | 此 tip 的判定與依據 |
|---|---|
| 1. 本機發件者收到 404 | **已修，早於基底。** `f71b383` 恢復成員埠的 `POST /inject`，委派給 `writeInject`（`server.ts:3520,3748`）。此次 b 改寫 self 內容及閒時收件。舊報告點名的排程、監看程式和 watchdog 寄件清冊仍需逐一核對。重試及 pull 的限制見 07、12。 |
| 2. Call.result 寫入被整段刪掉 | **已修，早於基底。** `a02a0b9` 恢復 `recordScheduleResult → recordCall` 及只帶 result 的 PUT（`server.ts:3024`、`lanes.ts:7540`、`onsen-client.ts:856`）。本次 c 的四行替換全在測試。真正的 peer 回覆順序及升級問題見 02、03、08。 |
| 3. 不認得的 spool 靜默略過 | **已修，早於基底。** `226528f` 明列退休的 d/a/r/w/blocked，未知的記錄和原因寫到 rejected，包含原始內容（`onsen-client.ts:83,908`、`onsen-spool-skip.test.ts:65`）。被保留在 rejected 的 C4/C5 舊寫入仍要有對應的 Item writer 才能交。已知的舊 c 同帶結果是另外一條略過路，見 08。 |
| 4a. runner 不寫 Call 結果 | **寫入已修，早於基底。** `62879d1` 的 `completeClaim` 會持久化 result（`codex-runner/codex-runner.ts:909`）。實際讀回的 outcome 仍錯，見 03。 |
| 4b. 失敗工作報 error、每個 claim 各回一次 | **已修，早於基底。** `62879d1` 用 Item 身分建立回覆鍵、一般失敗也報 Item completed（runner `:537,920`）。已定 58 的工作結果仍受 02、03 影響。 |
| 4c. 409 或暫停時長工作失去續租 | **原要求部分不適用，失租處置未修。** 現任連接器送 held IDs，已定 72 要求拒領時省略 connector。此次 a 已採用這個規則，舊工作失租後仍執行的條件見 01。 |
| 4d. 慢下載超過 20 秒才綁定 | **原先逾時已修，收下時間仍過早。** `62879d1` 把 bind 移到下載和 clone 前。既有 runner 測試在 Core 已見 in_session 時反而斷言工作啟動記錄為空（`codex-runner/codex-runner.test.ts:812`）。已定 14、17 的 20 秒起點與真正開始工作仍要同時滿足，見 01。 |
| 4e. alert/schedule 都當作 peer_call 回覆 | **已修，早於基底。** runner `:879` 明確跳過這兩種的 peer 回信，仍入結果 spool。本機測試兩種都執行過。 |
| 4f. 2xx 缺 ID 永遠重試 | **無限重試已修，早於基底。** runner `:884` 把次數存下，三次到限便釋放工作槽。真 Core 正常的 peer 回應就會打滿三次，見 02。舊審查所指測試「禁止 Call PUT、期待 error」已不適用。 |
| 5. pull 拒收沒告警、健康資訊缺失 | **告警要求不適用，健康欄已修。** `64cc6ab` 加 /healthz，此次 a 依已定 72 移除額外告警。拒收 long poll、健康原因與遠端再探已有測試。本機停用的再探、Core 對等候者呈現的狀態與混合部署見 12–14。 |
| 6. 漫遊者被排除且保留 Telegram 輪詢 | **本次 d 已接回共用接收器並刪輪詢，完整 C6 驗收證據仍待提供。** 舊載入點在 `1f1b065` 的 `server.ts:329`，新收件在 `server.ts:335,3653`。原對話 ID、恢復與編輯見 04–06，切換條件見 12。 |
| 7. C1 對無法分流的人訊息的處置 | **未修。** 仍只記 not routed，見 19。C1 的 dropped 回傳與一般可等候列需在整合版分別驗收。 |
| 8. C4/C5 的保溫 writer 接點被拔掉 | **未修。** 新版能處理一列已存在的 keepwarm，寫入責任仍有缺口，見 20 與已定 66。 |
| 9. C3 暫停時啟動舊計時器 | **未修。** C3 的 `takeModeActive`、`checking`、`canReceive` 與 C7 的暫停語義仍需整合，見 21。 |
| 10a. 在外面按沒有 applied_at | **原缺陷不適用。** 已定 75 要求保留 null。本次 e 正常路會取消同一 Action。判斷畫面、重啟及實際送鍵問題見 09–11。 |
| 10b. 舊暫存目錄沒有啟動清點 | **已修，基底 `b2f523f`。** `server.ts:4096` 記 pending、undeliverable、hub-doorbell 的檔數及兩個 JSON 的位元組數。這份紀錄不能證明交付已清空。 |
| 10c. 死碼、零 session 的 broadcast、插件說明 | **部分未修。** `CallFacts`（`onsen-status.ts:192`）、`keepwarm-local.ts:242`、`receipt.ts:17` 仍在，daemon 沒有恢復舊處理。lanes 關閉時的 `broadcastNotification` 對空 session 集合依然沒有收件者（`server.ts:2707`）。**說明已修／原疑慮不適用**，agent-inbox 宣告的 /inject 現已存在。 |

舊報告列出的相依符號也核過。C1 的 `personArrived/inboundStore` 不能直接套進新的 person 路徑，舊 OnsenPuller／auto-ack 受 12 的退休條件約束。C2 的結果端已接回，舊 Call 狀態投影由 Item 接手。C3 的 `deliveryMode/checking` 與 C4/C5 的 onTake、keepwarm、MailEvents 接點需在共同版本核對，C7 的 `/lanes/mail-event` 只收郵件卡片回呼。C6 的舊 Telegram／Onsen-first 符號已由 d 刪除，新接收器必須證明保住 67 的收件對話。以本地 refs 做 `git merge-tree --write-tree --name-only`，各自將 C7 對 C1 至 C6 比較，衝突檔數依序為 **12、9、5、12、10、15**。這是六次獨立的樹比較，舊報告的 hunk 數不能沿用。

舊審查最後的五個契約問題已有裁決。拒領狀態與沉默由 72 決定，/inject 保留與退休由 73、78 決定，Call 的結果端由 58、79 決定，漫遊者撤舊路由 67、74 決定，外部按鍵的 applied_at 由 75 決定。可交付版本仍要滿足各裁決的驗收條件。

## 這次查到正常的路

- **看過、沒有在拒領時多發警報或長掛 Item 拉取。** 現有 daemon 與 runner 測試涵蓋拒領後的健康原因、停止長輪詢及 observation 省略兩個鍵。遠端 `not_take_member` 的等待是 60 秒，另一支現任連接器的租期是 45 秒（`onsen-take.ts:57`）。
- **看過、沒有因重送同一個 take 而得到第二份 claim。** 真 Core 重送同一鍵得到相同 claim，另一支 connector 同時探取得到 409。新格式的結果 spool 遇 503 重啟後，先用原鍵與原 body 重送 PUT，再送 Item completed（`onsen-spool-skip.test.ts:12`）。
- **看過、沒有在舊程式正常運作時漏掉混合模式的逾期通知。** 本機 0.42.2 讓 take 成員的 Call 逾期，pull 等候者以舊 `GET /inbox` 收到 `item_notice`，文字與該 Item 的 line 相同。同一個 seq 連續 ack 兩次回 1、0，原列最終為 completed，最後事件是 legacy_acked。另以唯讀身分查到一隻 take、一隻 pull，嘗試切換得到 403。這驗到已定 66 的讀權限與 71 的舊路徑，watchdog 在正式機每輪是否使用它仍待查驗。
- **看過、沒有同時走本機直送與 Item 兩條路。** 可信 /inject 有穩定鍵且後端接受時只建一列，請求內改收件者也仍寫本成員。一般沒有 deadline 的 self 會等目標閒時才領（`onsen-take-daemon.test.ts:126`、`onsen-take.test.ts:156`）。
- **看過、沒有把已識別的漫遊者 A 件交給剛切到的 B。** 既有雙 MCP 目標測試裡 B 仿收 A 的憑據沒有生效。原目標最後 Stop 已入帳再退出時 `cutTarget` 會 completed（`onsen-claims.ts:122`）。跨機恢復與真 Core 接受身分的限制見 04、05。
- **看過、沒有為外部按鍵補造 control 或 applied_at。** 真 Core 上取消原本的 Action 後，狀態 cancelled、applied_at 為 null、相關 control 列數 0。真 daemon 加 tmux 測試也看到實際 Enter／Esc 離開後取消原件。和 09 的「只移動游標」有不同的判定依據。

## 在這個環境跑過的

Bun 1.3.11 執行 13 個既有測試檔中的 186 個不同案例，186 通過、0 失敗，共 1,362 個斷言。下表另外列出獨立重現、真 Core 驗證與失敗的 hook。

| 測試與實際端點 | 結果 |
|---|---|
| 既有 `onsen-take`、`onsen-calls`、`onsen-spool-skip`、`onsen-actions`、`duty-officer-actions` 五檔 | 88 通過，0 失敗，544 個斷言。 |
| `onsen-take-daemon.test.ts`，真 daemon 與本機假 Core | 47 通過，0 失敗，394 個斷言。 |
| `onsen-screen-menu-daemon`、`onsen-actions-daemon`、`onsen-screen-fast-daemon`，本機選單與按鍵 | 9 + 2 通過，0 失敗，84 + 12 個斷言。 |
| `roamer-sessions`、`rich-inbound` 及 `wo197-final` 的原生 Telegram 輪詢靜態檢查 | 3 + 1 通過，0 失敗，18 + 4 個斷言。 |
| `codex-runner/codex-runner.test.ts` | 36 通過，0 失敗，306 個斷言。測試使用真正的 runner、替身 worker 與替身 Core。另有 6 例受本次限制。 |
| 獨立重現，真 daemon／runner、元件及可控制的本機替身 | 12 種情境，34 個斷言。包括兩支 runner、跨 peek 編輯、cut 恢復、spool、無鍵注入、停用 61.5 秒、選單、逾時 self 及預填 main 的話題。這些斷言驗的是缺陷能否重現。 |
| 本機 Fleet Core 0.42.1、0.42.2 及拋棄式 PostgreSQL | 0.42.1 跑了 12 個情境，0.42.2 跑相同 12 個及另外 3 個，共 15 個。兩版各用真 runner 執行結束碼 0、3 的工作，並由呼叫端讀回結果。新增的三項為唯讀模式權限、pull 的 notice/ack、兩支連接器交替送 observation。每次使用本次專屬的兩個庫，結束後查詢殘留數 0。 |
| 共用測試台唯讀查詢 | healthz、OpenAPI 各 200，版本 0.42.1。4 個普通成員身分各查自己的 delivery 皆 403，以有讀取權的測試台身分再查，`lab-a`、`lab-b`、`space-roamers`、`time-travelers` 四筆皆 200、皆為 pull。這是當次快照。 |
| 本機執行送出前 hook、C1–C6 樹比較 | **hook 已跑且失敗**，tip 319/330，詳見 17。六次樹比較均有衝突。 |

## 跑不了的與驗證界線

- 完整 runner 的 6 例包含 5 個需要執行 git push 的 #dev 案例，以及 1 個要建立、連結 `auth.json` 的登入設定案例。這兩種操作超出本次授權。
- 正式全體 pull 成員數、連續 24 小時的 /inbox 與 /inject 計數、舊程序／本機待送與 ack 是否清空，只能由有正式清冊與紀錄的負責人驗證。
- 四個漫遊者 bot 的真機橋接與完整 C6 領取、Telegram 真人按鍵均需要真實傳送或切換身分。本次測試台只讀，測到的兩個漫遊者名稱不能代表四隻均已通過。
- 完整 C1–C6 與 C7 合併後的行為，須先解開上述六組分支衝突。此交付只有審查文件，沒有整合版本可驗收。

## 要負責人定的問題

1. **Call 與 claim 的修正由誰接？** 請指定 Core 和 runner 的負責方，定下回覆重送後如何取回同一個 `cm…`、先到的訊息文字如何與明確的工作結果相容，以及失租後如何阻止舊 worker 啟動。驗收要能從呼叫端讀回真實 outcome，並直接數工作啟動次數。
2. **漫遊者的對話身分由誰持久保存？** 需決定 UUID 與契約 session ID 的可恢復對應及交接位置，讓接手機器依已定 67 保留原對話並在其恢復時交件。驗收另應確認 take 回傳的最新文字真的進入對話。
3. **誰簽核最後一次部署？** 請指定提供全體模式清冊、舊件與 ack 排空、watchdog 分流、四隻橋接及 C6 驗收的人。/inject 的各發件者另需決定事件鍵來源與重試期，舊 spool 的清點也要有承接人。
4. **哪些跨分支修正一起驗收？** C1 的無法分流與錯投、C3 的舊計時器、C5 的 keepwarm writer、Core 在兩支連接器並存時的可領判定，以及 11 個 canary 均需指定合併次序及負責人。已有裁決的欄位形狀依 78、79 辦理。
