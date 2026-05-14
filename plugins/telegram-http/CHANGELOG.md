# Changelog

## 1.0.0 — 2026-05-14

Initial release of `telegram-http` as a Crab Labs fork of `telegram@claude-plugins-official` v0.0.6.

### Architecture

- **Replaced stdio MCP transport with HTTP MCP daemon** (`StreamableHTTPServerTransport`).
  Plugin runs as a long-lived launchd process, claude TUI connects via HTTP.
  Decouples bot lifetime from claude TUI lifecycle. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full rationale.
- **Multi-session broadcast** — a single daemon can serve multiple claude TUI sessions concurrently.
- **Disk + memory replay queue** — messages that arrive during claude restart gaps, SSE handshake races, or daemon restarts are persisted to `$STATE_DIR/inbox/pending/` and replayed on the next session's GET. Hourly GC prunes >7 days / >1000 entries.
- **Advisory file lock** (`bot.lock`) replaces upstream's `bot.pid` mutual-kill — daemons refuse to start on STATE_DIR conflict rather than SIGTERM the holder.

### Observability (new vs upstream)

- File log at `$STATE_DIR/server.log` (upstream had stderr only, which claude swallows)
- 30s heartbeat with uptime / RSS / lastUpdate / session count
- SIGPIPE handler (don't die on broken pipe)
- `beforeExit` / `exit` handlers capture last-moment state
- Boot config dump on startup (env / state dir / token tail)

### Removed from upstream

- `process.stdin.on('end', shutdown)` and `.on('close', shutdown)` — the actual cause of upstream's 2-3 minute death cycle
- `ppid` watchdog — irrelevant for an HTTP daemon (`PPID=1` always)
- `bot.pid` mutual-kill logic — replaced with advisory lock
- 409 Conflict → forced shutdown — replaced with patient backoff retry

### Preserved from upstream (unchanged semantics)

- All 4 tools: `reply`, `react`, `download_attachment`, `edit_message`
- `access.json` schema and `/telegram:access` skill (skills/ copied verbatim)
- Inbound `<channel source="telegram" ...>` notification format including `image_path` and `attachment_*` meta keys
- Permission request inline keyboard + "yes xxxxx" text reply intercept
- Pairing flow (6-char hex code, 1h expiry, 3-attempt cap)
- MarkdownV2 formatting support
- Static mode (`TELEGRAM_ACCESS_MODE=static`)

### New env vars

- `TELEGRAM_HTTP_PORT` (required) — TCP port for the MCP HTTP server
- `TELEGRAM_HTTP_HOST` (optional, default `127.0.0.1`) — bind host

### Breaking changes from upstream

- `.mcp.json` is now `{ "type": "http", "url": "http://127.0.0.1:${TELEGRAM_HTTP_PORT}/mcp" }` instead of stdio command. Claude must have `TELEGRAM_HTTP_PORT` set in its env to load the plugin.
- Claude no longer spawns the plugin as a child process — daemon must be running independently (launchd).

## Unreleased

### Added
- `GET /healthz` endpoint — JSON snapshot of daemon state for supervisor health checks (bot username/tag, uptime, RSS, active session count, polling/ws state, pending disk count, pid).
