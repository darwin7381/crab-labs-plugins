# Changelog

## 1.0.2 — 2026-05-22

Dead-transport detection patch. Counters claude-code 2.1.141~2.1.148 silent HTTP MCP transport drop regression — bot inbound silently stops arriving in claude TUI ~1 hour after claude restart, even though docs ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp#automatic-reconnection)) promise 5-attempt exponential backoff auto-reconnect. In practice the transport gives up silently; verified via upstream issues [#21721](https://github.com/anthropics/claude-code/issues/21721) ("MCP HTTP transport fails after ~89 minutes without automatic reconnection"), [#60061](https://github.com/anthropics/claude-code/issues/60061) ("Claude Code 2.1.143 silently hangs MCP tool calls after SSE drop"), [#59956](https://github.com/anthropics/claude-code/issues/59956), [#36308](https://github.com/anthropics/claude-code/issues/36308), [#43177](https://github.com/anthropics/claude-code/issues/43177).

### Added

- **TCP socket keepalive on SSE GET handler** — `req.socket.setKeepAlive(true, 30000)` triggers kernel-level probes every 30s (vs macOS default ~2h). Detects dead peers in 30-90s.
- **Application-level SSE keepalive comments** — `setInterval` writes `: keepalive <ts>\n\n` every 30s. SSE parsers ignore comment lines (RFC 6202) but the write exercises the socket end-to-end. If write fails (back-pressured buffer hit, socket destroyed), the daemon:
  1. Marks the session `sseOpen=false`
  2. Clears the keepalive timer
  3. Force-destroys the socket → Node fires `res.close` → SDK fires `transport.onclose` → full session cleanup (registry slot removed, no more zombie accumulation)
- **`res.once('close', ...)` defensive cleanup** — extra belt-and-suspenders to clear the keepalive timer if Node fires close before our explicit `finally`.

### Why
Symptom observed 2026-05-22 on @Sonn_Claude_bot channel-bot:
- Daemon's `active_sessions` accumulated to **2269 zombies** (every prior claude TUI restart left a dead session); broadcasts logged `queued for session ... SSE not yet open, queue=N` for thousands of dead sessions.
- New TG messages reached daemon (`last_update_id` incremented) but never appeared in claude TUI's `<channel>` tag.
- `lsof -p <claude_pid> -i :17631` showed **zero ESTABLISHED** despite `--channels plugin:telegram-http@crab-labs-plugins` flag still set and claude process alive — confirms client-side TCP died silently per #60061.

Post-patch verification: daemon restart wiped 2269 zombies, claude TUI restart re-handshaked, inbound messages now arrive in `<channel source="plugin:telegram-http:telegram-http">` tags within seconds.

### Compatibility
Backward-compatible with all MCP client versions. The SSE comment lines are part of the W3C EventSource spec; any conformant SSE client ignores them. No protocol-level changes.

## 1.0.1 — 2026-05-14

Compatibility + docs release. No daemon code changes.

### Fixed
- **`.mcp.json` URL now distinguishable from upstream `telegram@claude-plugins-official`** to avoid claude TUI's plugin MCP server dedup. Claude TUI's `YjH(config)` function uses the URL as the dedup signature; with identical URLs, the second-loaded plugin is silently suppressed with `Suppressing plugin MCP server "..." duplicates earlier plugin server "..."` in the debug log. Added `?v=crab-labs` query string to the URL; the daemon routes by `u.pathname` so the query string is transparent to it. **Side effect**: the inner `mcpServers` key is now `"telegram-http"` (was `"telegram"`), so the registered MCP server name in claude TUI is `plugin:telegram-http:telegram-http` (was `plugin:telegram-http:telegram`).

### Added
- [SETUP.md](./SETUP.md) — end-to-end first-time setup tutorial in Chinese: plugin install, per-bot configure (ackReaction emoji principles, dmPolicy choices), managed-settings.json (`allowedChannelPlugins` allowlist), launchd plist, claude TUI startup (with mandatory 2.1.140 pin), pairing, end-to-end testing, supervisor.sh integration, troubleshooting.

### Known issues
- **Claude binary 2.1.141 has an HTTP MCP transport regression** — TUIs silently lose all TCP connections to the daemon over time (process alive, network dead). **Pin to 2.1.140** in supervisor manifests / direct invocations until upstream confirms a fix. See SETUP.md §11.2 and HedgeDoc [incident report](https://md.blocktempo.ai/TFkYzCibQheCDaV2fyoaBg).

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
