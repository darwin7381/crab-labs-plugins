# telegram-http

Telegram channel for Claude Code — **HTTP MCP daemon** edition.

Drop-in replacement for the official `telegram@claude-plugins-official` plugin. Same tools, same access control, same channel notification format. The only architectural change: the bot runs as a long-lived **HTTP MCP daemon** instead of a stdio child process of claude TUI.

> 📐 **Deep dive**: [ARCHITECTURE.md](./ARCHITECTURE.md) covers the design rationale, the upstream stdio death cycle, the replay queue, and debugging.
>
> 📋 **What changed vs upstream**: [CHANGELOG.md](./CHANGELOG.md).

## Why this fork

The official plugin uses stdio transport: claude TUI spawns the bun process as a subprocess and pipes stdin/stdout. If claude closes the stdio (which it does periodically — observed every ~5 minutes in multi-channel setups), the plugin dies. With Grammy long-polling Telegram, every death drops messages and breaks reply flow.

This fork moves the bot daemon out of claude's process tree:

- **Daemon** runs as a launchd job, `PPID=1`, holds the Telegram poll slot forever
- **Claude** connects via `StreamableHTTPClientTransport` (HTTP + SSE) at `http://127.0.0.1:$TELEGRAM_HTTP_PORT/mcp`
- **Restarts** of claude TUI drop its session; the daemon keeps polling; the next claude opens a fresh session
- **Multi-session broadcast**: multiple claude TUIs can connect to one daemon (e.g. several workspaces sharing a bot)

All tools (`reply`, `react`, `edit_message`, `download_attachment`) and inbound `notifications/claude/channel` semantics are preserved. The `/telegram:access` skill works unchanged.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Install

```
/plugin marketplace add darwin7381/crab-labs-plugins
/plugin install telegram-http@crab-labs-plugins
```

## Configure

1. Put your token in the channel's state dir:
   ```
   mkdir -p ~/.claude/channels/telegram
   echo "TELEGRAM_BOT_TOKEN=123456789:AAH..." > ~/.claude/channels/telegram/.env
   chmod 600 ~/.claude/channels/telegram/.env
   ```

2. Run the daemon. Two options:

   The daemon needs `node_modules/`. The `start` script in `package.json` runs `bun install --no-summary && bun server.ts`, so invoking `bun run start` handles install + run idempotently.

   **a. Direct (for testing):**
   ```bash
   cd ~/.claude/plugins/marketplaces/crab-labs-plugins/plugins/telegram-http
   TELEGRAM_HTTP_PORT=17631 \
   TELEGRAM_STATE_DIR=~/.claude/channels/telegram \
     bun run start
   ```

   **b. Launchd (recommended for production):**

   Drop a plist at `~/Library/LaunchAgents/com.you.telegram-daemon.plist`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.you.telegram-daemon</string>
     <key>ProgramArguments</key>
     <array>
       <string>/Users/YOU/.bun/bin/bun</string>
       <string>run</string>
       <string>start</string>
     </array>
     <key>WorkingDirectory</key>
     <string>/Users/YOU/.claude/plugins/marketplaces/crab-labs-plugins/plugins/telegram-http</string>
     <key>EnvironmentVariables</key>
     <dict>
       <key>PATH</key><string>/Users/YOU/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
       <key>HOME</key><string>/Users/YOU</string>
       <key>TELEGRAM_STATE_DIR</key><string>/Users/YOU/.claude/channels/telegram</string>
       <key>TELEGRAM_HTTP_PORT</key><string>17631</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>ThrottleInterval</key><integer>10</integer>
     <key>StandardOutPath</key><string>/Users/YOU/.claude/channels/telegram/launchd.out.log</string>
     <key>StandardErrorPath</key><string>/Users/YOU/.claude/channels/telegram/launchd.err.log</string>
   </dict>
   </plist>
   ```
   then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.telegram-daemon.plist`.

3. Set `TELEGRAM_HTTP_PORT` in the env of whatever shell launches `claude`, so the plugin's `.mcp.json` substitution picks up the right port:
   ```
   export TELEGRAM_HTTP_PORT=17631
   claude --channels plugin:telegram-http@crab-labs-plugins
   ```

4. DM your bot. First message triggers a 6-char pairing code; run `/telegram:access pair <code>` in claude to allowlist yourself. See [ACCESS.md](./ACCESS.md) for advanced setups.

## Per-bot configuration

Each daemon needs:
- a unique `TELEGRAM_HTTP_PORT` (one per Telegram bot you run)
- a unique `TELEGRAM_STATE_DIR` (so different bots don't share `access.json` or the advisory lock)
- a matching `.env` containing the bot token, at `$TELEGRAM_STATE_DIR/.env`

Running multiple bots = multiple daemons + multiple plists + multiple ports. claude TUIs running in different workspaces each get their own `TELEGRAM_HTTP_PORT` env and connect to the matching daemon.

## Required env

| Env var | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | The bot token from BotFather. Loaded from `$TELEGRAM_STATE_DIR/.env`. |
| `TELEGRAM_HTTP_PORT` | yes | TCP port for the MCP HTTP server (daemon binds, claude connects). |
| `TELEGRAM_STATE_DIR` | no | Where `access.json`, `.env`, `server.log`, `bot.lock` live. Default: `~/.claude/channels/telegram`. |
| `TELEGRAM_HTTP_HOST` | no | Bind host. Default: `127.0.0.1`. |
| `TELEGRAM_ACCESS_MODE` | no | Set to `static` to snapshot access.json at boot and never reload (useful for CI / locked-down deployments). |

## Observability

- `$TELEGRAM_STATE_DIR/server.log` — structured log with boot info, MCP session lifecycle, heartbeats every 30s, polling errors, exit reasons.
- `$TELEGRAM_STATE_DIR/launchd.{out,err}.log` — raw launchd capture (mainly for catching startup failures before our logger initializes).
- `$TELEGRAM_STATE_DIR/bot.lock` — advisory lock holding the pid of the active daemon.

## Compatibility

This plugin registers its MCP server as `name: "telegram"`, same as the official plugin, so claude's `<channel source="telegram">` notifications and all `/telegram:access` skill paths work unchanged. **Don't enable both `telegram@claude-plugins-official` and `telegram-http@crab-labs-plugins` simultaneously** — they will collide on the MCP server name and the bot token slot.

## License

Apache-2.0. Derived from `claude-plugins-official/telegram@0.0.6`.
