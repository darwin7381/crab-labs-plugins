# agent-inbox

每隻 agent 的**常駐本機收件匣**。獨立 daemon（自己的 process/port/state/佇列），
跟 Telegram daemon 完全解耦——TG polling 卡死/升級/掉登入都不影響投遞。

- 投遞：`POST http://127.0.0.1:<port>/inject` body `{"text": "...", "from": "<sender>"}`，
  header `X-Inject-Token`（env `CHANNEL_INJECT_TOKEN` 有設就必帶）。
- 投遞語意：與 TG 訊息同一條耐久佇列（memQueue + 磁碟 pending + 確認送達才刪 + 重連重播）。
- TUI 端：`claude --channels plugin:agent-inbox@crab-labs-plugins`（可與 telegram-http 並存），
  env `AGENT_INBOX_PORT` 指向 daemon port。
- 這個 channel **只進不出**（無 reply/react tools）——agent 回應走它自己的 TG channel 或 BTCC。
- 引擎 = telegram-http server.ts 的 `CHANNEL_INBOX_ONLY=1` 模式（獨立=instance 不是 codebase）。

Port 慣例：17650=hephaestus，之後每隻 +1，登記在 cc-agent-create skill 的 port 表。
