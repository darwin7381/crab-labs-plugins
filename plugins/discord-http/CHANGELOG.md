# Changelog

## 1.0.0 — 2026-05-14

Initial release of `discord-http` as a Crab Labs fork of `discord@claude-plugins-official` v0.0.4.

### Architecture

- **Replaced stdio MCP transport with HTTP MCP daemon** (`StreamableHTTPServerTransport`).
  Plugin runs as a long-lived launchd process, claude TUI connects via HTTP.
  Decouples bot lifetime from claude TUI lifecycle. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full rationale.
- **Multi-session broadcast** — a single daemon can serve multiple claude TUI sessions concurrently.
- **Disk + memory replay queue** — messages that arrive during claude restart gaps, SSE handshake races, or daemon restarts are persisted to `$STATE_DIR/inbox/pending/` and replayed on the next session's GET. Hourly GC prunes >7 days / >1000 entries.
- **Advisory file lock** (`bot.lock`) — prevents two daemons from sharing the same `$DISCORD_STATE_DIR`.

### Observability (new vs upstream)

The official Discord plugin had no file logging, no heartbeat, no advisory lock — this fork adds the full observability layer:

- File log at `$STATE_DIR/server.log`
- 30s heartbeat with uptime / RSS / `ws` state (discord.js gateway status) / session count
- SIGPIPE handler
- `beforeExit` / `exit` handlers capture last-moment state
- Boot config dump on startup
- Advisory lock at `$STATE_DIR/bot.lock`

### Removed from upstream

- `process.stdin.on('end', shutdown)` and `.on('close', shutdown)` — same architectural vulnerability as the telegram fork addressed
- `client.login()` with no retry on failure — replaced with `loginLoop()` that backs off on initial login errors

### Preserved from upstream (unchanged semantics)

- All 5 tools: `reply`, `react`, `edit_message`, `download_attachment`, `fetch_messages`
- `access.json` schema and `/discord:access` skill (skills/ copied verbatim)
- Inbound `<channel source="discord" ...>` notification format including `attachment_count` / `attachments` meta keys
- Permission request button UI (`ButtonBuilder`, `ActionRowBuilder`, `interactionCreate`) and "yes xxxxx" text reply intercept
- Pairing flow (6-char hex code, 1h expiry, 3-attempt cap)
- DM channel ↔ user ID mapping (`dmChannelUsers`)
- Thread → parent channel gate lookup
- Recently-sent message ID tracking (for thread-reply mention detection)
- Static mode (`DISCORD_ACCESS_MODE=static`)

### New env vars

- `DISCORD_HTTP_PORT` (required) — TCP port for the MCP HTTP server
- `DISCORD_HTTP_HOST` (optional, default `127.0.0.1`) — bind host

### Breaking changes from upstream

- `.mcp.json` is now `{ "type": "http", "url": "http://127.0.0.1:${DISCORD_HTTP_PORT}/mcp" }` instead of stdio command. Claude must have `DISCORD_HTTP_PORT` set in its env to load the plugin.
- Claude no longer spawns the plugin as a child process — daemon must be running independently (launchd).
