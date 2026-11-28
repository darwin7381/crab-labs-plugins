# Onsen 連接器第二輪驗收

本輪從第一輪的 `3d72297` 接續，合入本機 `origin/main` 的 `6c1ee38`。唯一的合併衝突在 `onsen-client.ts` 的 import。排程回執需要 `Step`，主線的歷史查詢需要 `HISTORY_ID_HINT`，兩者都保留。版本是主線的 1.59.14。

## Fleet Core 0.42.2

測試啟動了 `7d6e4f6` 的 HTTP 伺服器與真正的 Telegram connector daemon。Claude 分身由本機測試程式代替。每支 daemon 有自己的埠與狀態目錄，Core 和子程序只使用這次的拋棄式資料庫。資料庫是 `codex_call_1212`、`codex_call_1212_fleet`，執行後在 PostgreSQL 查得剩餘 0 個。以下編號都屬於這次實跑。[HTTP 順序、伺服器事件及兩次進入分身的時間](v2-fix2-events.jsonl)

| 案例 | 前後與斷言 |
|---|---|
| 排程 Item 1、Call 1 | `created → claimed → in_session → completed`。先確認舊的 `result.steps` 得 400。正常回執的 `PUT /calls/1/state` 得 200，再送同一個 claim 的 `completed`。在該回應回到 connector 之前，呼叫者 GET 已讀到 `completed`、`outcome=ok` 和兩個已勾步驟。 |
| 信箱 Item 2、信 200000 | 同一封信有兩組 `claimed → in_session → mail_unread`。第一次完成回應為 `waiting`，下次到期距伺服器更新時間正好 3,600 秒。停止 daemon，只在私有庫提前該列到期時間，再用原目錄重啟。新 claim 的分身 prompt 再次含來信本文。 |
| 同機同成員兩支 daemon | 第一支收到排程。第二支對同一成員探測得 409 `not_current_connector`。兩支同時在線時新信由第一支領到，第二支領取數為 0。第一支以原目錄重啟後保留原 connector 名稱。 |

## T3 對話編號逐點核對

表中的原行為以整合版 `4c85a9a` 為準。右欄是第一輪改完並經本輪核對的行為。對照依據包括原始碼、舊帳本及 spool 的重啟測試，以及第一輪四個真 Core 情境。[第一輪的伺服器事件](v2-fix1-events.jsonl)

| 檔案、函式 | 整合版 | 現在 |
|---|---|---|
| `lanes-main.ts` 的 `pull`、`beginTurn`、`restoreResumeClaim` | 主線綁定時把 Claude UUID 當成收件編號 | 主線傳 `main`，另以 UUID 查本機行程與回合。 |
| `lanes.ts` 的 `startRun` 及 `syncSteer` | 分身使用完整 lane ID | 維持完整成員編號，例如 `adam.reflex.1` 或 `adam.mail.1`。 |
| `roamer-items.ts` 的 `tick`、`destination`，以及 `Claims.accept` | 漫遊 intake 送出 UUID，恢復依賴 UUID | 對小寫目標 UUID 做 SHA-256，取前 128 位轉十進位，組成 `<成員>.roam.<數字>`。恢復可辨認本成員的公開編號及舊 UUID，再比對本機目標。 |
| `onsen-claims.ts` 的 constructor、`bind`、`report`、`replay` | 完成及中途回報沿用儲存的 UUID，舊帳本可能混用兩種編號 | 分別保存公開的 `session_id` 與本機的 `registry_session`。已綁定的 `in_session`、`completed`、`cut` 等共用公開編號。 |
| `onsen-client.ts` 的 `watchItemReports`、`pass` | 重送舊 spool 會將公開編號改回本機 UUID | 重送可讀取舊綁定，將舊 UUID 換成 `main` 或該漫遊編號。本機 turn binding 留在 spool。4xx 的錯誤行含 Item、outcome 與伺服器回應。 |
| `onsen-receive.ts` 的 `ItemReceiver.receive`，及 `test-fixtures/onsen-items.ts` 的 report handler | 領取時由伺服器發 claim，替身曾收下 UUID | 領取請求省略 `session_id`。替身驗證收件成員編號，`in_session` 為 claim 補公開編號，保留 Item 已有的預填值。 |
| `onsen-resume.ts` 的 `ResumeItems.cutFields`、`lanes.ts` 的 `followupWrite`、`keepwarm-local.ts` 的 `LocalKeepwarm.schedule` | resume 和主線保溫用 `main`，self 用工作所屬對話 | 維持相同寫法，self 在分身使用完整 lane ID。 |
| `onsen-item-writes.ts` 的 `ownItem` 與 `ItemWrites.sync` | 建立 Item 的 POST 使用寫入者提供的對話編號 | self、keepwarm、resume 的 POST 沿用上列編號。查詢待領保溫列亦使用 `main`。 |
| `onsen-status.ts` 的 `CallFacts.emit` | 舊拉取的 Call 狀態用主線或分身編號，無承接對話時為 null | 維持原 Call 狀態契約。走領由 Item 投影狀態，排程補送的 `{result}` 不帶對話欄位。 |

## 舊拉取的比對

在兩個獨立的本機測試目錄，以相同的輸入跑 `origin/main@6c1ee38` 及本分支。主線與分身都把明寫 `line=call`、`because` 且沒有引用的新工作送給原來電者。兩版都保留回覆義務，未填舊的 Call 或訊息引用。分支上的 daemon 測試另查 `send_to_agent → /lanes/call-answered → /send` 的實際 request，並驗證有引用的回答仍標為免回覆。

## 跑過的

在隔離的 HOME，以 Bun 1.3.11 的 `bun --no-env-file --no-install test ./<測試檔>` 逐檔執行全部 257 個檔。以每個案例在最終程式及測試檔上的結果計一次，合計 **2,306 過、4 略、9 失敗，共 2,319 案**。起點 `3d72297` 的 9 個同名失敗都已在同機重現。

| 執行 | 結果 |
|---|---|
| 起點 `3d72297`，單一 Bun 測試程序 | 257 檔、2,257 過、12 略、23 失敗，共 2,292 案。其中包含本輪要修的 C2 排程回執。 |
| 本輪，257 檔各自啟動 Bun | 初次為 2,297 過、12 略、10 失敗。最後版的 `lanes-h14.test.ts` 透過正式的 take 探測入口建立測試狀態，整檔重跑 11 過、0 失敗。 |
| 4 個畫面觀測檔，補上本機既有樣本 | `screen-status`、`screen-status-recorded`、`screen-status-wo177b`、`screen-status-observation` 整檔重跑，69 過、0 略、0 失敗，含初次略過的 8 案。 |
| 含畫面樣本與斷線案例，再跑全部 257 檔 | 以 4 個程序執行不同測試檔，共 2,300 過、4 略、15 失敗。額外 6 案中，兩個權限 Action、一次狀態心跳延遲、兩個 WO-128 喚醒在整檔重跑全過（分別為 12/12、7/7、10/10）。最後一案是審查 O3，原斷言在舊投遞送出前便讀取，已補上對該筆投遞的等待。 |
| 收件及 daemon 整檔 | `onsen-take.test.ts` 133 過、`onsen-take-daemon.test.ts` 103 過、`onsen-calls.test.ts` 27 過。其中有舊版將 `result.steps` 寫在 spool 後升級的案例。 |
| C2 排程回執 | 三種有無舊進度及不同結果的組合，各連跑五次，15 過、0 失敗。另一列在結果請求仍未回應時可先報完成。另驗證 4xx，以及 Core 已儲存但連線遺失 2xx 的情形。連接器重啟後以同一個冪等鍵與內容重送，收到成功回應才報完成。 |
| 舊拉取的 P1 | `origin/main` 與本分支各 1 案、6 個斷言全過。另跑本分支含實際送出請求的 3 檔共 18 過、0 失敗。 |
| 其餘核對 | 原工作樹的 8 個針對性案例全過，涵蓋回執、對話編號、未讀重投、跨回合、連接器識別與權限。忙碌切換另覆蓋成功、失敗、重啟與直接指令。原 observation 檔 10 過、0 失敗。 |

各列含重疊案例及不同執行環境，總數僅取每一檔最終那次的結果。

### 起點與本輪都失敗的 9 案

把 7 個失敗檔和 1 個相關的喚醒決策檔在起點逐檔重跑，得到 103 過、1 略、9 失敗。逐一比對完整測試名稱，與本輪一致。

| 測試檔 | 案數 | 本機實際結果 |
|---|---:|---|
| `codex-runner/codex-runner.test.ts` | 1 | runner 重啟後找不到原先繼續執行的程序，回報成 `failed`。 |
| `lanes-golive-proc.test.ts`、`session-finder.test.ts` | 2 | `lsof` 看不到預期的 PID，實際執行 `ps` 被沙箱拒絕。 |
| `lanes-pl-s0lock.test.ts` | 2 | 同一分身的 PID 與從外部恢復該 session 的 PID 均讀不到，兩個行程鎖斷言失敗。 |
| `onsen-step3.test.ts` | 2 | SharedCli 測試以 `ps` 確認子程序存活失敗。另一次 registry 檔案替換等了 5 秒也沒收到 watch 事件。 |
| `onsen-step3-daemon.test.ts` | 1 | registry 寫入到狀態進 spool 的最長延遲為 1,902 ms，超過測試的 1,000 ms。 |
| `lanes-m5-runs.test.ts` | 1 | daemon 重啟後，原已結案事件的 run 計數為 3，預期為 1。 |

## 跑不了的

- 兩個案例只在 Linux 執行。`onsen-step3.test.ts` 讀 `/proc/<pid>/stat`，`lanes-y-x5.test.ts` 讀 socket 與行程的 `/proc` 資料。本機是 macOS。
- `lanes-jevlog.test.ts` 與 `lanes-hooks-jevlog.test.ts` 各一案依賴 Linux 的 `/home/god/genesis/clock/libgenesis_clock.so`。本機缺這個時鐘函式庫。
- 涉及下列檔名的 23 個測試檔透過隔離副本執行。程式和測試的路徑常值一併換成合成檔名，涵蓋讀寫和拒收行為。以原憑證檔名執行的情況未驗證。同一檔可能出現在兩列。路徑相對於 `plugins/telegram-http/`。

| 原名 | 使用該路徑的測試檔 |
|---|---|
| `mesh-credential` | `bench-cred.daemon.test.ts`、`lanes-wo144.test.ts`、`lanes-wo175.test.ts`、`mesh-identity.test.ts`、`onsen-actions-daemon.test.ts`、`onsen-client.test.ts`、`onsen-inbound-daemon.test.ts`、`onsen-pull-daemon.test.ts`、`onsen-status-wo162.test.ts`、`onsen-status-wo165.test.ts`、`onsen-step2-daemon.test.ts`、`onsen-step3-daemon.test.ts`、`screen-status-daemon.test.ts` |
| `.secrets` | `lanes-append.test.ts`、`lanes-golive-defaults.test.ts`、`lanes-golive-jevkey.test.ts`、`lanes-golive-peer-scope.test.ts`、`lanes-wo140.test.ts` |
| `.env` | `telegram-bridge/telegram-bridge-stage2.test.ts`、`telegram-bridge/telegram-bridge.test.ts`、`wo197-final.test.ts` |
| `*.credential` | `claude-code-host/claude-code-host.test.ts`、`codex-runner/codex-runner.test.ts`、`telegram-bridge/telegram-bridge.test.ts` |
| `auth.json` | `codex-runner/codex-runner.test.ts` |

## 上台與出版

本輪列為普通成員上測試台前必修的 P1、P2、T1–T4 均已通過對應驗證。出版版本號目前仍為合入主線的 1.59.14。第一個正式成員改走領之前，契約 66 要求已部署的 watchdog 每輪查成員模式並跳過 take 的成員，這次只驗證本機 connector 與 Core。漫遊者正式切換仍待後續處理 T5、T8、T9。T11 的現有行為符合已定 90，漫遊者不建立保溫列。

O3 的舊投遞測試現在等 `/deliveries/batch` 出現相同的冪等鍵，再核對整批只有該筆投遞。此案例連跑五次，5 過、0 失敗。P3 的舊拉取編輯標頭、O2 的觀測心跳邊界及 O4 的漫遊者啟動探測沿用第一輪的行為。O2 在整合途中同一 Bun 程序的全套執行曾失敗，逐檔執行通過。
