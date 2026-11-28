# WO-213 C2　由 Item 投影連接器的舊報告

分支 `wo213-c2`，基底 `ef79d7a`。以下程式行號相對於該版的 `plugins/telegram-http/`。契約為 `/Users/btai/rescue-site/onsen-ui/CONTRACT.md` §4b，已定 1–56，開工時 MD5 為 `74677ba677142a0feef8551eb96a5713`。範圍依 `TICKET-connector-facts.md` §2d、§3 C2、§6 與 `C1-spec.md` §4。

## 切換條件

Chiron 先在測試台逐項驗 S3，再對該測試成員啟用 C2。連接器沿用 C1 對本成員的 `TakeMode.active`（`onsen-take.ts:32`、`server.ts:357`）。未完成探測、探測拒絕、暫停及 pull 期間均走原有回報。agent-inbox 行程以 C1 的 puller 收到伺服器 409 後的模式為準。跨行程只設定一次的修正由 C1-fix D11 負責。主線完成與路由的測試台驗收也用到 C1-fix D1（沒有 subagents 目錄仍能報完成）與 D2（以 reassigned 辨識交回主線）。

停止的是新產生的舊回報。切換前已進 spool 的紀錄照原順序送完，已接手的舊 pull 工作及其 `/inbox/ack` 照已定 24、44 排空。C1 的 Item take、report、observation 和續約繼續運作。正式成員的切換另須 S4 和 C3 在測試台通過。

## 每項停寫與 S3 驗收對照

| 連接器在 take 停寫的資料 | S3 必須提供的投影 | Chiron 在測試台看的證據 |
|---|---|---|
| `POST /deliveries/batch`，含交入、已讀與回合結束（`onsen-client.ts:581`、`server.ts:4389`） | 契約 481、491–492。訊息的 `in_session_at`、`read_at` 取 Item 的 `in_session_at`。一般 waiting 或 claimed 尚未交入為 `not_started`，claimed 且已交入為 `running`，完成為 `completed`，取消為 `cancelled`，過渡期的 `parked`、`cancelled/gave_up` 為 `failed`。回覆 ID 來自 Item。 | 傳一則、交入、回覆、收工。逐步比對 Item、網頁回條、橋接 receipt 和 Telegram ✍。傳輸的 delivered/failed 時間仍由橋接寫。 |
| `PUT /v1/messages/<id>/receipt` 的 blocked handling（`server.ts:4173`、`onsen-client.ts:941`） | 契約 261、396–397、481、491。waiting 且原因為 `usage_limit` 或 `usage_limit_probe` 時顯示 `blocked`，`blocked_by=usage_limit`，`retry_after` 取 Item 原值。 | 拒絕人的訊息，核對網頁的原因和解除時間、Telegram ⚠️。解除並交入後警示消失，回到 running、completed。 |
| 連接器的 `PUT /v1/calls/<id>/state` 進度，以及排程自動 ack／舊回執（`onsen-status.ts:195`、`lanes.ts:503`、`3833`、`5575`、`7505`、`7547`、`server.ts:2050`、`2357`） | 契約 484–485、已定 11。waiting → queued、claimed 未交入 → accepted、已交入 → running、completed → completed、cancelled → cancelled。`parked` 和 `cancelled/gave_up` 過渡投影為 failed。`recipient_session_id` 取 Item 的 `session_id`。排程的 `project_call` 讀相同狀態。 | 對主線、分身各傳一通 Call 和一輪排程，比對收下、交入、交回、收工與舊讀者看到的狀態。核對連接器沒有為進度寫 Call、等待舊回執或叫 BTCC ack。下節列出舊回執額外攜帶的任務結果。 |
| `POST /wake/batch` 的路由與 hand-over（`server.ts:4568`、`4580`） | 契約 484、492。Item、其事件與目標 session 供 S3 查詢路由和交接，Call 直接讀該列。 | 對同一件事驗路由到分身及交回主線，核對 Item 事件、session 及 Call；本機路由仍能完成。 |
| §2d 另列的 `POST /v1/actions/<id>/applied`（`onsen-client.ts:1642`、`1655`、`1733`，Item 回報在 `server.ts:4991`） | 契約 393–394、487。control 列 waiting → held，claimed → sent，`applied_at` 取 `completed_at`。暫時無法套用先報 `deferred`，確認已失效則報 `not_applied`。 | 按一次選項，核對實際只套用一次、Item completed 與 Action 的 applied_at；按過期的控制件則核對取消。Action 建立、選項選擇、resolve 和 cancel 仍各有自己的用途。 |

行為依成員判定。保留 status、observation、Item report、訊息與傳輸收據等共用寫入。舊 spool 不重寫。observation 的 queue 由 S3 按本成員的訊息 Item 計算（契約 489）。S3 是部署前提，沒有額外開關、查能力端點或本機投影。

## Inventory 與排程結果

目標退休 O2（等 Call 寫入與重試）、L26（排程舊回執及重試）、D5（scheduler auto-ack）、W22 的連接器部分。排程 `running` 是開始訊號，Item 終止後 S3 提供 Call 的終止狀態。W2 `check_scheduled_receipt` 歸 Chiron，在 C2 後可移除。契約 485 保留發起人取消與補寫真正交回的 `result`。

須由負責人裁定的案例：「車道交 `receipt(outcome=failed)` 後正常結束，排程應看到 Item 投影的 completed，還是要保留舊 Call 的 failed？take 排程原有的結構化 outcome 和結果文字由誰補寫？」基底的 `lanes.ts:3817` 依行程結束方式報 Item，`lanes.ts:7581` 的排程回執則依任務結果寫 Call。契約 366 的 Item report 沒有排程結果欄位，契約 484 的 failed 只對應 parked 或 gave_up。C2 保留本機帳本的 outcome 和結果文字；S3 上線後，送舊進度也不會改變 Item 投影。若排程需讀到這個業務失敗或結構化結果，該對照項須等負責人定案再啟用。

## 驗證

- 同一個成員先走 pull、經 C1 探測進 take、暫停回 pull。量取發出的請求與新增 spool 行，逐項驗證表中的舊寫入及現行 Item 回報、status 與 observation，另驗已經排隊的舊回報。
- 測主線與分身、兩條 wake 來源、blocked 的兩種訊息識別方式、直接 applied 與 resolve 後的 applied。排程涵蓋 Call 記錄開／關與原本的 BTCC 路徑。pull 回歸沿用原測試。
- daemon 測試連跑五輪。測試配置指向 repo 內的空檔，僅用隔離身分和 127.0.0.1。真 S3、網頁及 Telegram 的驗收由 Chiron 在測試台用同一組 C1 動作比對。
