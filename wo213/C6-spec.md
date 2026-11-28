# WO-213 C6 · 漫遊者接上成員連接器

分支 `wo213-c6`，基底 `ef79d7a`。依據為共用 brief、`TICKET-connector-facts.md` §2–5、`ANCHOR.md` 第 4 點①、`roamer-facts.md`、設計 v3 與 C1 驗收記錄。開工時 `CONTRACT.md` 的 MD5 為 `74677ba677142a0feef8551eb96a5713`，§4b 到已定 56。下列程式行號相對於基底的 `plugins/telegram-http/`。

## Epeius 的註冊清單

下表是請註冊的固定成員代號。§2 規定小寫英數與連字號。代號取自 bot 名稱，去除 Telegram 的 bot 尾碼、轉小寫、底線轉連字號。部署時將表內代號明確配給該支 tg daemon（現有 `LANES_AGENT` 身分設定，與 `GENESIS_LANES` 分開）；bridge 從同一個安裝單元取得名稱。每一列需要一個 `kind=agent` 成員、正確的 `machine`，以及只代表該成員的一份 mesh 憑證。

| 主機 | Telegram bot | 請註冊的成員 | 憑證交付對象 |
|---|---|---|---|
| Mac mini | `@space_roamersbot` | `space-roamers` | 該機 space_roamers 的 tg daemon，埠 17652 |
| Mac mini | `@time_travelersbot` | `time-travelers` | 該機 time_travelers 的 tg daemon，埠 17653 |
| MBP | `@SpaceX_Roamer_bot` | `spacex-roamer` | 該機 roamer-mbp 的 tg daemon |
| MBP | `@SpaceY_Roamer_bot` | `spacey-roamer` | 該機 roamer2-mbp 的 tg daemon |

Mac mini 的對照來自 `tg-dialogue/roamer-facts.md` §2。MBP 的兩組對照來自 `tg-dialogue/backfill/_other_machines.md:13`，daemon 名稱亦見 `CHANGELOG.md:87`。MBP 的目前 plist 與埠須在該機核對。每支 daemon 用現有的 `ONSEN_CREDENTIAL_FILE` 指向自己的檔案，以自己的身分讀 Items、take、report、送 observation、訊息、指令與 Action。Joey 的 Telegram 帳號已有 `joey` 對應，沿用 `ONSEN_OWNER` 與該帳號的對應。橋接用自己的橋接憑證，沿用每支 bot 現有的 token 和 access allowlist。成員註冊與切換是兩個步驟。

## 模式與交接

1. 唯一領件行程是該成員的 tg daemon。四支都只有這個行程，現場設定沒有 lanes。以 C1 的成員篩選、記錄與 observation 條件及伺服器探測判斷 take。收件、續約與回報沿用 `TakeMode`、`ItemPeek`、`ItemReceiver`、`Claims` 和同一個 spool。入口在 `server.ts:156`、`:339`、`:347`、`:363`、`onsen-take.ts:8` 及 `onsen-client.ts:1470`。
2. 探測使用成員憑證與既有 `<machine>/<member>`。未點名、條件不足或初次探測非 200 時走現行本機路徑，包含 token 檢查、poll、按鈕、只送目前 target、無 target 時的原文，以及停止 Onsen 記錄。C1 的再探測可在成員切換後啟用 take。運作中失去連接器所有權時遵守 C1 暫停和重試規則。
3. 成員啟用 take 後，橋接成為該 bot 的唯一 Telegram 輪詢者。探索入口在 `telegram-bridge/agents.ts:120`，接手在 `telegram-bridge/telegram-bridge.ts:196`。探索要辨認 daemon 的成員身分和實際模式，涵蓋一般 plist 名稱和全機 `*`。登記成員、安裝 plist 或讀到 `*` 本身都不足以接手正在本機輪詢的 bot。遷移後訊息、回覆、表情、檔案、指令及選項走 §7d。

## Target 與一列 Item

- `roamer-control.ts:103` 的 `current_target.session_id` 是 Claude session UUID。`:373` 解出的是可用來送通知的 MCP transport session ID。接收前確認目前選取的 target、其存活的 Claude 行程以及對應的開啟中 stream。換 target 時後續交入重新取目標。曾經連過的其他 session 不得收到。
- 在 `server.ts:3507`、`:3873`、`:4965` 的收件路徑接入共同 receiver。先 peek，一到該 target 可收的時刻才 take。離線、無 target 或連線未明時，普通列保持 waiting。連接器仍須能處理選擇第一個 target 的 `/roam` 控制件。照已定 14，`POST …/items/take` 只帶 connector、item_ids、wait 和 limit。target 真正收下時才回報其 Claude session UUID。
- 對非艦隊 session，用確切 target 的回合證據判斷收下與結束。證據來源已有 `roamerCurrentTranscript`（`roamer-control.ts:1435`）及 `TurnWatch`（`onsen-status.ts:745`）。成功寫入 SSE 只代表送到通道。20 秒未收下沿用 `not_taken`，回覆只計 Onsen 收下的 ID。續約列出仍持有的 Item ID。已領的綁回原本那段，target 行程死亡回報 `cut`；回線先補 spool。等待與恢復的通知屬 S4。
- `server.ts:564`、`:581`、`:1824`、`:3234` 共用既有指令登錄、選單 Action 和回派。`roamer-control.ts:1442` 的 17 個名稱為 `roam`、`roam_status`、`resume_list`、`resume`、`resume_previous`、`restart`、`kill_stuck`、`clear`、`agents`、`mcp`、`help`、`init`、`compact`、`model`、`effort`、`codexgate`、`sigint`。`/help` 亦是橋接內建指令。按鈕只有一件 `source:"menu"` 的 Action，`roam:`、`resume:`、`model:`、`effort:` 經 `kind:control` 使用原有 handler。WO-215 的兩個 /resume 呼叫點由 `95b51e7` 提供。

## 退休範圍與依賴

§3 C6 列沒有分配整個 inventory ID。對已切換成員，停用本機 bot 輪詢、回覆、按鈕、重新尋找連線與無 target 警告（inventory D16 的漫遊者部分、§8 #10）。D9 的橋接斷線保留繼續生效。最後一支切完才可實體刪除 `roamer-telegram.ts` 和本機 transport 分支。正式成員切換以 S4 與 C3 的台架驗收為前提。整合依賴 C1 的真實 Item payload、已定 48/54、回合完成與 spool 修正，以及 C2/C3 的投影與單次通知。

## 驗證

- 用本機 stand-in 核對未點名、初次 409、404、斷線、200 與之後切換。觀察 bot 呼叫數、成員名、指令表、spool、observation 和 owner。橋接使用全機 `*` 時，混合已切換與未切換的兩支，逐支核對唯一輪詢者。
- 用兩條不同的 MCP stream 和兩份 transcript。依序選 A、傳第一則、確認進入回合與回覆 ID，再選 B、傳第二則。包含同一工作目錄的兩段、take 請求中途換 target、已領後行程死亡、斷線再接回、無 target 下的 `/roam`、重複按同一選項。逐項核對目的地、狀態轉移及次數。舊成員用 WO-197 的現有相容測試比對。
- §5 的 txmonster 台架由驗收人用 lab 成員與 lab bot 操作。在 A 收到第一則並完成、換到 B 後第二則只到 B；殺掉仍持有一列的 target，該列回到 `waiting/cut`，Joey 測試號只收到一則等待通知。現場驗收須能區分寄件時已填 `main` 和原本為 null 的兩種列。

## 已定的收件身分

`in_session.session_id` 寫實際收到 Item 的 Claude session UUID。台架核對當次 `claim.session_id` 或完成後的收件事件。依已定 48，`Item.session_id` 保留寄件人預填的值，原值為 null 才填 UUID。主線和漫遊者都用收件 UUID 辨識回合的 Stop、idle 與回覆。舊帳本裡的 `registry_session` 是已領主線工作的 UUID。

### 在基底重現

| 本機實驗（同一個 target UUID） | `ef79d7a` 的結果 |
|---|---|
| 對 loopback fake 送 `POST …/items/take` 並帶 `session_id` | HTTP 400。省略該欄位後 HTTP 200。 |
| 對預填 `main` 的列回報 `in_session` 並帶 UUID | fake 把 `Item.session_id` 和 `claim.session_id` 一起改為 UUID。這個 fake 的行為和已定 48 有差異。 |
| 交給 C1 的 `Claims.bind`，登記同一個實際 UUID 與 turn，最後觸發 `finalStop` 並回報 idle、背景數 0 | 對外編號傳 `main` 時得到 `in_session → completed`。傳 UUID 時只有 `in_session`。 |

這兩個編號在 C1 已經分開存。呼叫點 `lanes-main.ts:627` 傳 `main` 和 registry 的 session UUID；`onsen-claims.ts:114` 用兩者比對收工。驗收須核對 A 的 Stop 只能結束 A 收下的列。

## 實作與驗收對照

- 首次切換由 tg daemon 的 C1 probe 決定。收到 200 後，把已交給哪個 connector 記在既有 claims 帳本，排完本機 poll 和更新處理，再在 `/healthz` 宣告 connector。切換過的 daemon 重啟時，以帳本維持橋接所有權，等 Onsen 回線；首次探測失敗的成員仍走本機路徑。
- `roamer-items.ts` 使用與主線相同的 receiver、報告與帳本。只接到由 takeover 認領或可用 PID 證明的開啟中 stream；take 返回後再核對一次。送出時把該次 claim ID 放入本機通知，讀取確切 UUID 的 transcript 時才登記 `in_session`。已切離的 target 仍有自己的回合與登錄檔，直到原列結束。台架覆蓋 transcript Stop，以及同一回合確實觀察到的 busy → idle。
- 主線與當前 target 的狀態觀測都以實際 UUID 呼叫 `Claims.statusRecord`。升級時若舊主線帳本已有 `registry_session`，同一 UUID 也用於重送 spool 中尚未送出的 `in_session`。測試分別檢查預填 `main` 及原為 null 的 Item。
- 選單台架透過 `/roam` 指令與一件 `source:menu` Action 選到已連線的測試 session。`roam:`、`resume:`、`model:` 和 `effort:` 四種選項均經 `kind:control` 回派；過期選項回報 `not_applied`。現場只有 S4 負責等待通知。
