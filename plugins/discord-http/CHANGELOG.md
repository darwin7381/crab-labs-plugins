# Changelog

## 1.2.1 — 2026-05-24

Synced from [telegram-http 1.3.1](../telegram-http/CHANGELOG.md): 4-step defensive picker driver (Pre-Escape, busy guard, verify picker open, verify picker closed) prevents the `/resume` picker from getting stuck open when daemon-driven from rapid button taps or restart races. Fixes the 2026-05-24 claude-builder silent-drop incident.

## 1.2.0 — 2026-05-24

Synced from [telegram-http 1.3.0](../telegram-http/CHANGELOG.md): `/resume_list` now renders sessions as Discord buttons (ACTION_ROW + ButtonBuilder, 3 buttons per row, max 5 rows). Click → `interactionCreate` → `handleCallbackData` → `/resume <uuid>` flow. Eliminates the list-idx → picker-idx mapping that caused the 1.2.5 off-by-one bug.

## 1.1.5 — 2026-05-24

Synced from [telegram-http 1.2.6](../telegram-http/CHANGELOG.md): every Discord channel notification now has a trailing `[protocol] ...reply via mcp__plugin_discord-http_discord-http__reply...` reminder. Contextual companion to the Stop-hook infrastructure fix; addresses LLM attention dilution against the one-shot CLAUDE.md model.

## 1.1.4 — 2026-05-24

Synced from [telegram-http 1.2.5](../telegram-http/CHANGELOG.md): fixes `/resume <N>` and `/resume_previous` off-by-one — picker excludes the current session, so array idx N maps to picker idx (N - 1).

## 1.1.3 — 2026-05-24

Synced from [telegram-http 1.2.4](../telegram-http/CHANGELOG.md): tail excerpts now show last 2 *user* questions only (not mixed user+assistant), `readJsonlTail` window widened to 1MB / 200 records, also filter `Continue from where you left off` and `<user-prompt-submit-hook>` framework injections.

## 1.1.2 — 2026-05-24

Synced from [telegram-http 1.2.3](../telegram-http/CHANGELOG.md): tail excerpts now skip pure tool_use / tool_result records and `<local-command-…>` / `Caveat:` framework injections, walking back through up to 40 records / 128KB so resume picker rows always show real prose, not `[tool_result]` noise.

## 1.1.1 — 2026-05-24

**Resume replies now show session-tail excerpts** — synced from
[telegram-http 1.2.2](../telegram-http/CHANGELOG.md). `/resume`,
`/resume_previous`, and `/resume_list` now include the last ~3 user/assistant
messages of the target session so the user can recognize WHICH conversation
they just switched to (id prefix + first message wasn't enough).

Includes new helpers `readJsonlTail`, `extractMessageExcerpt`,
`formatResumeReply`, and a `lastMessages?: string[]` field on `ClaudeSession`.

## 1.1.0 — 2026-05-23

**Channel-bot TUI control plane** — Discord parity for the feature shipped in
[telegram-http 1.1.0~1.2.1](../telegram-http/CHANGELOG.md). When the daemon
is configured with `CHANNEL_BOT_TMUX_SESSION` (and friends), slash commands
from Discord are intercepted and applied directly to the claude TUI via
tmux send-keys / launchctl / pkill, instead of being forwarded as chat
content. Functional list:

- **tmux send-keys** (claude TUI alive, no restart):
  - `/clear` `/help` `/agents` `/mcp` — claude native slashes
  - `/model <name>` `/effort <level>` — switch model / effort
  - `/sigint` — Ctrl+C, interrupt current turn
- **system control** (launchctl / pkill):
  - `/restart` — graceful claude TUI restart via wrapper kickstart
  - `/kill_stuck` — `pkill -9` against claude TUI, wrapper respawns
  - `/status` — daemon healthz + claude TUI pid
- **session resume via picker** (1.5s inline-switch, same TUI process):
  - `/resume_list` — list claude sessions (header shows current)
  - `/resume <number|uuid>` — pick a session, picker drives via Down × N + Enter
  - `/resume_previous` — walk back through session history one step at a time (chain semantics, no ping-pong)

### Implementation
- Added `channel-bot-control.ts` — a near-verbatim copy of
  `telegram-http/channel-bot-control.ts` (only the `--channels` plugin
  filter substring in `pkill`/`pgrep` differs). The two files must be
  kept in sync; the file's docstring spells this out. Both daemons drive
  the SAME claude TUI when configured with the same `CHANNEL_BOT_TMUX_SESSION`
  and share `/tmp/channel-bot-resume-chain.json`, so `/resume_previous`
  walk-back stays coherent across the Telegram and Discord entrypoints.
- Wired into `handleInbound` between the permission-reply intercept and
  the typing-indicator — when `msg.content.trim().startsWith('/')` and
  control mode is enabled, `handleControlSlash` runs first.
- Reply callback wraps `msg.reply()` so users see status updates in Discord
  (the daemon's CLI log is invisible to them).

### Required env vars (opt-in, same as telegram-http 1.1.0)

| Var | Purpose |
|---|---|
| `CHANNEL_BOT_TMUX_SESSION` | tmux session name where claude TUI runs (enables the feature when set) |
| `CHANNEL_BOT_PROJECTS_DIR` | claude's project dir for session listing |
| `CHANNEL_BOT_WRAPPER_LABEL` | launchd label for graceful restart |
| `CHANNEL_BOT_NEXT_ARGS_FILE` | path the wrapper reads for `--resume` overrides (1.1.0 only; 1.2.0+ inline-switches via picker) |
| `CHANNEL_BOT_RESUME_CHAIN_FILE` | walk-back chain state (default `/tmp/channel-bot-resume-chain.json`) |

### Security
Slash interception runs AFTER the existing `gate()`/`access.allowFrom`
check. Non-allowlisted senders never reach this code.

## 1.0.2 — 2026-05-22

Dead-transport detection patch. Same architecture and rationale as [telegram-http 1.0.2](../telegram-http/CHANGELOG.md). Counters claude-code 2.1.141~2.1.148 silent HTTP MCP transport drop regression that leaves the daemon broadcasting forever to silently-dead claude TUI sessions.

### Added

- **TCP socket keepalive on SSE GET handler** — kernel probes every 30s.
- **Application-level SSE keepalive comments** — `: keepalive <ts>\n\n` every 30s; on write failure the daemon marks the session dead, destroys the socket, and lets the SDK clean up.
- **`res.once('close', ...)` defensive cleanup** — clears the keepalive timer if Node closes the response before our `finally`.

### Verified concurrently with telegram-http 1.0.2

Both daemons observed accumulating thousands of zombie sessions (Discord daemon had **2332** at the time of the patch). Discord daemon restart wiped them; post-patch new claude TUI re-handshaked and inbound channel messages flow normally.

## 1.0.1 — 2026-05-14

Compatibility + docs release. No daemon code changes.

### Fixed
- **`.mcp.json` URL now distinguishable from upstream `discord@claude-plugins-official`** to avoid claude TUI's plugin MCP server dedup. Same root cause and fix pattern as [telegram-http 1.0.1](../telegram-http/CHANGELOG.md). Added `?v=crab-labs` query string + inner `mcpServers` key renamed to `discord-http`.

### Added
- [SETUP.md](./SETUP.md) — pointer to shared [telegram-http SETUP.md](../telegram-http/SETUP.md) (architecture identical, only env vars / paths differ; SETUP doc has a translation table).

### Known issues
- Same as telegram-http 1.0.1 — pin claude binary to 2.1.140 until 2.1.141 HTTP MCP transport regression is fixed upstream.

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

## Unreleased

### Added
- `GET /healthz` endpoint — JSON snapshot of daemon state for supervisor health checks (bot username/tag, uptime, RSS, active session count, polling/ws state, pending disk count, pid).
