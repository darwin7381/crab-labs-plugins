# agent-inbox

每隻 agent 的**常駐本機收件匣**。獨立 daemon 有自己的 process、port 和 state。

- 投遞：`POST http://127.0.0.1:<port>/inject` body `{"text": "...", "from": "<sender>"}`，
  header `X-Inject-Token`（env `CHANNEL_INJECT_TOKEN` 有設就必帶）。
- 回傳 `injected: true` 和 `item_id` 表示 Onsen 已寫入該成員的 Item。成員的 connector 從 Onsen 領取並投遞。
- TUI 端：`claude --channels plugin:agent-inbox@crab-labs-plugins`（可與 telegram-http 並存），
  env `AGENT_INBOX_PORT` 指向 daemon port。
- 這個 channel **只進不出**（無 reply/react tools）——agent 回應走它自己的 TG channel 或 BTCC。
- 引擎 = telegram-http server.ts 的 `CHANNEL_INBOX_ONLY=1` 模式（獨立=instance 不是 codebase）。

Port 慣例：17650=hephaestus，之後每隻 +1，登記在 cc-agent-create skill 的 port 表。

## ⚠️ 必要前置：managed-settings 頻道白名單（每台機器，root）

Claude Code 有 org 級 **managed channel 白名單** `/Library/Application Support/ClaudeCode/managed-settings.json` → `allowedChannelPlugins`。**agent-inbox 沒列進去的話，claude 會連上這個 MCP daemon（tools 正常）但「Channel notifications skipped」— 靜默拒絕投遞訊息，agent 完全收不到、且不報錯。**

每台跑 agent-inbox 的機器都要有這行（root 寫）：
```json
{"marketplace": "crab-labs-plugins", "plugin": "agent-inbox"}
```
驗證：agent 啟動後看 `~/Library/Caches/claude-cli-nodejs/<proj>/mcp-logs-plugin-agent-inbox-agent-inbox/*.jsonl` 最後一行是 `Channel notifications registered`（不是 skipped）。

> 2026-07-15 MBP daddy 整整卡在這 — 白名單漏了 agent-inbox，症狀是「訊息 injected 200 但 agent 不起 turn」。診斷靠讀上面那個 MCP client log（別猜 transport）。
