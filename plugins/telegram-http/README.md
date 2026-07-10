# telegram-http

Telegram channel for Claude Code — **HTTP MCP daemon** edition.

Drop-in replacement for the official `telegram@claude-plugins-official` plugin. Same tools, same access control, same channel notification format. The only architectural change: the bot runs as a long-lived **HTTP MCP daemon** instead of a stdio child process of claude TUI.

> ⚡ **Quick start (first-time setup)**: [SETUP.md](./SETUP.md) — end-to-end tutorial in Chinese covering plugin install → bot configure (ackReaction emoji principles, dmPolicy) → managed-settings.json policy → launchd daemon → claude TUI startup (with required 2.1.140 pin) → pairing → end-to-end test → troubleshooting.
>
> 🤖 **Channel-bot mode** (1.1.0+): [ADVANCED-SETUP.md](./ADVANCED-SETUP.md) — drive a persistent claude TUI directly from Telegram with slash commands (`/clear`, `/resume`, `/model`, `/restart`, etc.). Same TUI process across switches, no message loss, fully remote-controllable from phone / iPad. Reference wrapper + plist templates in [`examples/channel-bot/`](./examples/channel-bot/).
>
> 🛰️ **Roamer mode** (1.4.0+): [ROAMER.md](./ROAMER.md) — one bot that lists every live claude session on the machine and hops between them (`/roam` inline picker, takeover, per-target routing). Includes full new-machine setup (env vars, plist template) and pitfalls.
>
> 📐 **Deep dive**: [ARCHITECTURE.md](./ARCHITECTURE.md) covers the design rationale, the upstream stdio death cycle, the replay queue, and debugging.
>
> 📋 **What changed vs upstream**: [CHANGELOG.md](./CHANGELOG.md).

## ✨ Highlights

- **Stable HTTP MCP transport** — no stdio death cycle; survives claude TUI restarts; pending messages replay from disk.
- **Multi-session broadcast** — one daemon serves many claude TUIs simultaneously.
- **Daemon-side keepalive (1.0.2+)** — TCP + SSE keepalive detects dead peers in 30-90s; mitigates the 2.1.141~2.1.148 client-side regression.
- **🆕 Full inbound context (1.13.0)** — replies carry the root message's text/sender/file (`reply_to_*`, `attachment_origin`, `reply_quote`), forwards carry the original author (`forward_*`), albums carry `media_group_id`, and animation/location/contact messages are handled instead of dropped. Attribute reference + agent-side reading guide: [docs/inbound-message-context.md](./docs/inbound-message-context.md).
- **🆕 Channel-bot TUI control plane (1.1.0+)** — opt-in slash commands intercepted by the daemon and applied to claude TUI itself via tmux send-keys + launchctl. From your phone/iPad you can:

  | Command | What it does |
  |---|---|
  | `/clear` | clear claude TUI context (same process, new session id) |
  | `/model` | tap-to-pick model keyboard with the **current model marked** (1.12.0) |
  | `/model <name>` `/effort <level>` | switch model / effort — **busy-safe** (waits for the turn to end instead of queueing), auto-confirms the switch picker, then sends a **verified ✅/⚠️ outcome notification** (1.12.0) |
  | `/codexgate` | enable the Codex stop-time review gate (types `/codex:setup --enable-review-gate` into the TUI, busy-safe + verified) (1.12.0) |
  | `/agents` `/mcp` `/help` | open native claude pickers (read-only inspection) |
  | `/sigint` | Ctrl+C — interrupt current claude turn |
  | `/restart` | full claude TUI restart via wrapper (~25s) |
  | `/kill_stuck` | `pkill -9` stuck claude + auto-respawn |
  | `/status` | daemon health + claude TUI pid |
  | `/resume_list` | list claude sessions (header shows current) |
  | `/resume <N\|uuid>` | inline-switch to a session via picker (~1.5s, same TUI process) |
  | `/resume_previous` | walk-back through session history one step at a time (chain semantics — no ping-pong) |

  Setup: see [ADVANCED-SETUP.md](./ADVANCED-SETUP.md) + the templates in [`examples/channel-bot/`](./examples/channel-bot/).

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

This plugin registers its MCP server as `name: "telegram-http"` and uses URL `http://127.0.0.1:${TELEGRAM_HTTP_PORT}/mcp?v=crab-labs` — distinct from the official plugin's `name: "telegram"` / `…/mcp` — so claude TUI's plugin MCP server dedup (which signs by URL) doesn't collide. **You can enable both `telegram@claude-plugins-official` and `telegram-http@crab-labs-plugins` simultaneously** in `enabledPlugins`. Use `--channels plugin:telegram-http@crab-labs-plugins` to direct channel notifications to this fork.

Inbound channel notifications in claude render as `<channel source="telegram-http" …>` (not `source="telegram"`) — the channel source name is whatever you put in --channels. Skill paths exposed are `/telegram-http:access` and `/telegram-http:configure`.

If you want to share `$STATE_DIR` with the official plugin (same `access.json`, same bot token), point both `TELEGRAM_STATE_DIR` env vars at the same dir. But they cannot both poll the same Telegram bot simultaneously — only one daemon at a time, enforced by the advisory lock at `$STATE_DIR/bot.lock`.

## License

Apache-2.0. Derived from `claude-plugins-official/telegram@0.0.6`.
