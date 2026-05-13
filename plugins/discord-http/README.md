# discord-http

Discord channel for Claude Code — **HTTP MCP daemon** edition.

Drop-in replacement for the official `discord@claude-plugins-official` plugin. Same tools (`reply`, `react`, `edit_message`, `download_attachment`, `fetch_messages`), same access control, same channel notification format. The only architectural change: the bot runs as a long-lived **HTTP MCP daemon** instead of a stdio child process of claude TUI.

## Why this fork

The official plugin uses stdio transport: claude TUI spawns the bun process as a subprocess and pipes stdin/stdout. If claude closes the stdio (which can happen periodically), the plugin dies. With the Discord gateway WebSocket holding state, every death drops messages and breaks reply flow.

This fork moves the bot daemon out of claude's process tree:

- **Daemon** runs as a launchd job, `PPID=1`, holds the Discord gateway WebSocket forever
- **Claude** connects via `StreamableHTTPClientTransport` (HTTP + SSE) at `http://127.0.0.1:$DISCORD_HTTP_PORT/mcp`
- **Restarts** of claude TUI drop its session; the daemon keeps the gateway connection; the next claude opens a fresh session
- **Multi-session broadcast**: multiple claude TUIs can connect to one daemon
- **Disk + memory replay queue**: any inbound that arrives during claude restart, SSE-handshake race, or daemon restart is persisted to `$DISCORD_STATE_DIR/inbox/pending/` and replayed when a new session's SSE GET stream is established

All tools and inbound `notifications/claude/channel` semantics are preserved. The `/discord:access` skill works unchanged.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A Discord bot token from [Discord Developer Portal](https://discord.com/developers/applications)

## Install

```
/plugin marketplace add darwin7381/crab-labs-plugins
/plugin install discord-http@crab-labs-plugins
```

## Configure

1. Put your token in the channel's state dir:
   ```
   mkdir -p ~/.claude/channels/discord
   echo "DISCORD_BOT_TOKEN=MTIz..." > ~/.claude/channels/discord/.env
   chmod 600 ~/.claude/channels/discord/.env
   ```

2. Run the daemon. Two options:

   **a. Direct (for testing):**
   ```bash
   cd ~/.claude/plugins/marketplaces/crab-labs-plugins/plugins/discord-http
   DISCORD_HTTP_PORT=17641 \
   DISCORD_STATE_DIR=~/.claude/channels/discord \
     bun run start
   ```

   **b. Launchd (recommended for production):**

   Drop a plist at `~/Library/LaunchAgents/com.you.discord-daemon.plist`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.you.discord-daemon</string>
     <key>ProgramArguments</key>
     <array>
       <string>/Users/YOU/.bun/bin/bun</string>
       <string>run</string>
       <string>start</string>
     </array>
     <key>WorkingDirectory</key>
     <string>/Users/YOU/.claude/plugins/marketplaces/crab-labs-plugins/plugins/discord-http</string>
     <key>EnvironmentVariables</key>
     <dict>
       <key>PATH</key><string>/Users/YOU/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
       <key>HOME</key><string>/Users/YOU</string>
       <key>DISCORD_STATE_DIR</key><string>/Users/YOU/.claude/channels/discord</string>
       <key>DISCORD_HTTP_PORT</key><string>17641</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>ThrottleInterval</key><integer>10</integer>
     <key>StandardOutPath</key><string>/Users/YOU/.claude/channels/discord/launchd.out.log</string>
     <key>StandardErrorPath</key><string>/Users/YOU/.claude/channels/discord/launchd.err.log</string>
   </dict>
   </plist>
   ```
   then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.discord-daemon.plist`.

3. Set `DISCORD_HTTP_PORT` in the env of whatever shell launches `claude`, so the plugin's `.mcp.json` substitution picks up the right port:
   ```
   export DISCORD_HTTP_PORT=17641
   claude --channels plugin:discord-http@crab-labs-plugins
   ```

4. Pair: in claude, run `/discord:access pair <your-discord-user-id>`, then DM your bot. See [ACCESS.md](./ACCESS.md) for advanced setups (allowlist, group channels, mention triggers).

## Required env

| Env var | Required | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | Bot token from Discord Developer Portal. Loaded from `$DISCORD_STATE_DIR/.env`. |
| `DISCORD_HTTP_PORT` | yes | TCP port for the MCP HTTP server. |
| `DISCORD_STATE_DIR` | no | Where `access.json`, `.env`, `server.log`, `bot.lock`, `inbox/` live. Default: `~/.claude/channels/discord`. |
| `DISCORD_HTTP_HOST` | no | Bind host. Default: `127.0.0.1`. |
| `DISCORD_ACCESS_MODE` | no | Set to `static` to snapshot access.json at boot and never reload. |

## Replay queue (delivery guarantees)

Inbound Discord messages are persisted to disk + memory queues to survive race windows:

| Race window | Recovery mechanism |
|---|---|
| No active claude session (TUI restarting) | Disk persist → replayed on next session's first GET |
| Session open but SSE GET handshake not yet complete | Per-session memory queue → flushed when GET arrives |
| Daemon restart (KeepAlive=true) | Disk safety-net persist → next daemon reads pending dir |

GC runs hourly: prunes pending older than 7 days, caps at 1000 newest entries.

## Observability

- `$DISCORD_STATE_DIR/server.log` — structured log with boot info, gateway state, MCP session lifecycle, heartbeats every 30s
- `$DISCORD_STATE_DIR/launchd.{out,err}.log` — raw launchd capture
- `$DISCORD_STATE_DIR/bot.lock` — advisory lock (PID of active daemon)
- `$DISCORD_STATE_DIR/inbox/pending/` — disk-persistent replay queue

## Compatibility

This plugin registers its MCP server as `name: "discord"`, same as the official plugin, so claude's `<channel source="discord">` notifications and all `/discord:access` skill paths work unchanged. **Don't enable both `discord@claude-plugins-official` and `discord-http@crab-labs-plugins` simultaneously** — they will collide on the MCP server name and the bot gateway slot.

## License

Apache-2.0. Derived from `claude-plugins-official/discord@0.0.4`.
