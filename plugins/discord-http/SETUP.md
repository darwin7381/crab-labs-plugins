# discord-http — Setup

`discord-http` 是 `telegram-http` 的 Discord 對應版，架構完全一致。**完整教學請看 [telegram-http/SETUP.md](../telegram-http/SETUP.md)**。

兩個 plugin 配對：

| 項目 | telegram-http | discord-http |
|---|---|---|
| Port（預設） | 17631 channel / 17632+ supervisor | 17641 channel |
| STATE_DIR | `~/.claude/channels/telegram/` | `~/.claude/channels/discord/` |
| Token env | `TELEGRAM_BOT_TOKEN` | `DISCORD_BOT_TOKEN` |
| HTTP port env | `TELEGRAM_HTTP_PORT` | `DISCORD_HTTP_PORT` |
| Bot 註冊 | [@BotFather](https://t.me/BotFather) | [Discord Developer Portal](https://discord.com/developers/applications) |
| Cache 路徑 | `~/.claude/plugins/cache/crab-labs-plugins/telegram-http/1.0.0/` | `~/.claude/plugins/cache/crab-labs-plugins/discord-http/1.0.0/` |
| Plist Label | `com.btai.telegram-daemon.<name>` | `com.btai.discord-daemon.<name>` |
| Channels flag | `--channels plugin:telegram-http@crab-labs-plugins` | `--channels plugin:discord-http@crab-labs-plugins` |

setup 流程（managed-settings.json、access.json、launchd plist、claude 啟動 pin 2.1.140、testing、troubleshooting）全部跟 telegram-http 同步骤，把上表的對應值替換即可。

完整教學：[../telegram-http/SETUP.md](../telegram-http/SETUP.md)
