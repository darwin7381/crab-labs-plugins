# telegram-http architecture

This document explains why this plugin exists, what it changes from the official `telegram@claude-plugins-official`, and how the pieces fit together. Read this if you're debugging, contributing, or wondering whether to deploy it.

## TL;DR

The official telegram plugin runs as a **stdio child process** of claude TUI. Claude periodically closes that stdio (for reasons not fully traced in the upstream codebase), which kills the plugin. Long-poll messages buffered in Grammy get lost, the reply path breaks, and the user sees their bot silently fail every few minutes.

This plugin replaces the stdio transport with an **HTTP MCP daemon**:

- The bot runs as a long-lived launchd process (`PPID=1`), holding the Telegram poll slot forever.
- Claude TUI connects via `StreamableHTTPClientTransport` (the MCP SDK's HTTP+SSE transport) at `http://127.0.0.1:$TELEGRAM_HTTP_PORT/mcp`.
- Claude TUI's lifecycle (crashes, restarts, periodic reconnects) is decoupled from the bot daemon's lifecycle.
- A **disk + memory replay queue** ensures messages that arrive during any restart-gap or handshake race window are delivered to the next claude session.

Same tools, same access control, same `<channel source="telegram">` notification format. Drop-in replacement.

## Why we forked: the stdio death cycle

The official plugin's `server.ts` reads:

```ts
await mcp.connect(new StdioServerTransport())
// ...
process.stdin.on('end',   shutdown)
process.stdin.on('close', shutdown)
```

This is the standard MCP stdio pattern: claude TUI spawns `bun server.ts` with piped stdin/stdout, and when claude closes stdin, the plugin shuts down. The intent is "die with my parent."

In practice, the parent's stdio gets closed for reasons other than parent death:

- claude TUI does periodic MCP reconnects (~5 minute interval observed)
- Some internal claude state transition closes/reopens the stdio handle
- Network or runtime hiccups inside claude

Each of those triggered `shutdown()`, the plugin died, Grammy's in-flight `getUpdates` long-poll was abandoned, and the bun process exited within ~244 seconds typical, sometimes as short as 22 seconds. Telegram has no message replay for dropped pollers, so anything in flight at the death moment was lost.

We tried patching individual death paths (file logging, stdin EOF grace window, ppid watchdog, advisory lock instead of mutual-kill). Each patch fixed one symptom but a new one surfaced — because **the architecture itself was the bug**: stdio coupling tied the bot's life to claude TUI's mood.

The fix is to detach. The daemon owns the bot, claude owns its own session, and they meet over HTTP.

## How Route B works

```
                                      ┌────────────────────────────┐
                                      │  Telegram Bot API (cloud)  │
                                      └─────────────┬──────────────┘
                                                    │ getUpdates long-poll
                                                    ▼
   ┌──────────────────┐                ┌────────────────────────────┐
   │   launchd        │  KeepAlive     │  bun server.ts (daemon)    │
   │   (this plist)   │ ──supervises──►│  PPID=1                    │
   └──────────────────┘                │                            │
                                       │  • Grammy bot              │
                                       │  • HTTP server :PORT       │
                                       │  • disk inbox/pending/     │
                                       │  • per-session mem queues  │
                                       └─────────────┬──────────────┘
                                                     │ HTTP/SSE
                                            127.0.0.1:$TELEGRAM_HTTP_PORT/mcp
                                                     │
                  ┌──────────────────────────────────┼──────────────────────────────────┐
                  ▼                                                                     ▼
       ┌────────────────────┐                                                ┌────────────────────┐
       │  claude TUI A      │                                                │  claude TUI B      │
       │  (cc-workspace 1)  │                  ... etc ...                   │  (cc-workspace 2)  │
       └────────────────────┘                                                └────────────────────┘
```

- **One daemon per bot token.** A daemon binds the `$TELEGRAM_STATE_DIR` (where `.env`, `access.json`, `bot.lock`, `server.log` live) and holds the Telegram poll slot exclusively. The advisory `bot.lock` file refuses to start a second daemon for the same STATE_DIR.
- **Daemon is long-lived.** launchd's `KeepAlive=true` plus `ThrottleInterval=10` means death-respawn is automatic and bounded.
- **claude connects via HTTP.** The plugin's `.mcp.json` is `{ "type": "http", "url": "http://127.0.0.1:${TELEGRAM_HTTP_PORT}/mcp" }`. Claude expands the env var at startup.
- **Multiple claude TUIs can connect to the same daemon** (multi-session broadcast). Useful for bots that span multiple cc-workspaces.

## The replay queue (delivery guarantees)

Inbound notifications can arrive in four states relative to claude sessions:

| State | What happens |
|---|---|
| 1. No claude session connected at all | Persist to `$STATE_DIR/inbox/pending/<ts>-<seq>.json`, replay on next session's first GET. |
| 2. Session registered but its SSE GET stream not yet established (handshake race) | Push into per-session in-memory queue; flush when GET arrives. |
| 3. Session has SSE open | Direct `server.notification()` — instant delivery. |
| 4. Multiple sessions, some with SSE open, some without | Mix of (2) and (3); plus disk safety-net if no session had SSE open. |

GC runs hourly. Prunes entries older than 7 days; caps at 1000 newest.

### The GET handler trick

`transport.handleRequest(req, res)` for `GET /mcp` is a long-poll: it returns only when the SSE stream is torn down (could be hours). If we `await` it before triggering replay, the replay never runs while the session is alive. So:

```ts
sseOpen.set(sessionId, true)                    // preemptive — future broadcasts go direct
const reqPromise = transport.handleRequest(req, res)
await new Promise(r => setTimeout(r, 50))       // let the SDK finish registering the stream
// Now the SDK's _streamMapping has the standalone SSE entry → notifications go through.
flushMemQueue(sessionId, server)
void replayPendingFromDisk(server)
try { await reqPromise } finally {
  sseOpen.set(sessionId, false)                 // SSE closed (client disconnected)
}
```

The 50ms delay is belt-and-suspenders for the Node↔Web adapter (`@hono/node-server`); the SDK's internal `_streamMapping.set` is synchronous within `handleGetRequest`.

### What replay does NOT save you from

- **Telegram daemon down for >7 days**: pending entries get GC'd. Operationally this means: keep the daemon alive (launchd does this), or accept loss on multi-week downtime.
- **The daemon process dies between `bot.api.getUpdates` returning and `persistInbound` writing the file**: tiny window (microseconds), unrecoverable, accept.
- **A zombie session whose TCP isn't closed yet but claude is dead**: the daemon will broadcast to that session's SSE stream (which TCP buffers silently swallow) AND any other active sessions. If the new claude session is up, it'll receive the broadcast normally; if not, broadcast goes only to zombies and is lost. The replay queue is built around `activeServers.size === 0` and SSE state, not TCP liveness — TCP keepalive detection is a known follow-up.

## File layout

```
~/.claude/channels/telegram/             ($TELEGRAM_STATE_DIR — default)
├── .env                                  TELEGRAM_BOT_TOKEN=...           (chmod 600)
├── access.json                           pairing + allowlist + dmPolicy
├── approved/<senderId>                   confirmation drops from /telegram:access
├── bot.lock                              advisory lock (PID of running daemon)
├── server.log                            structured log: boot/heartbeat/sessions/exits
├── launchd.out.log + launchd.err.log     launchd's raw capture
└── inbox/
    ├── 12345-abc.jpg                     downloaded attachments (claude's download_attachment)
    └── pending/
        └── <ts>-<seq>.json               replay queue entries
```

## Observability

`server.log` is the authoritative trace. Look for these lines:

- `boot: ppid=1 STATE_DIR=... TOKEN=...XXXXXX HTTP=127.0.0.1:PORT` — startup confirmation
- `MCP HTTP daemon listening on ...` — HTTP server ready
- `polling as @your_bot_username` — Grammy connected to Telegram API
- `MCP session opened: <uuid> (active=N, SSE pending)` — claude POST initialize succeeded
- `flushing N mem-queued notif(s) for session <uuid>` — handshake race recovered
- `disk-replayed N pending notification(s)` — restart-gap or daemon-restart recovered
- `heartbeat uptime=Ns mem=MMB lastUpdate=... sessions=N` — every 30s, baseline life signal
- `shutting down (reason: ...)` — clean exit; if you never see this and uptime keeps resetting, launchd is hard-restarting (check launchd.err.log)
- `MCP session closed: <uuid> (active=N)` — claude reconnected or died

## Correct usage

### Per-bot setup
1. Pick a unique TCP port per bot. We use 17631 / 17632 / 17633 / 17641 across the cc-workspace fleet — anything 1024-65535 that isn't taken works.
2. Pick a unique `$TELEGRAM_STATE_DIR` per bot. Two daemons sharing a STATE_DIR will refuse to start (advisory lock).
3. Put `TELEGRAM_BOT_TOKEN=...` in `$STATE_DIR/.env`. Make it `chmod 600`.
4. Write a launchd plist with `TELEGRAM_HTTP_PORT`, `TELEGRAM_STATE_DIR`, `TELEGRAM_HTTP_HOST` in `EnvironmentVariables`. See README for an example.
5. `launchctl bootstrap gui/$(id -u) <plist>`.

### Per-claude-instance setup
1. Set `TELEGRAM_HTTP_PORT=$port` in claude's env (the shell or tmux that launches claude). Without it, the `.mcp.json` substitution fails and the plugin won't load.
2. Run `claude --channels plugin:telegram-http@crab-labs-plugins`.

### Pairing
Same `/telegram:access` skill as the official plugin. First DM gets a 6-char code; run `/telegram:access pair <code>` in claude.

## Compatibility notes

- The MCP server registers as `name: "telegram"` (same as official). Don't run both plugins at once — they collide on the server name and on the bot poll slot.
- All tools (`reply`, `react`, `download_attachment`, `edit_message`) have the same input schemas and semantics as official.
- `/telegram:access` skill is byte-identical to upstream (we copied the `skills/` directory unchanged).
- Inbound `<channel source="telegram" chat_id="..." ...>` block is identical, including `image_path` and `attachment_*` meta keys.

## Differences from upstream you should know about

| | Official `telegram@claude-plugins-official` | This `telegram-http@crab-labs-plugins` |
|---|---|---|
| Transport | stdio (claude spawns bun child) | HTTP / SSE (StreamableHTTP) |
| Lifecycle | dies with claude stdio close | launchd-managed, independent |
| Multi-claude support | one claude at a time | multi-session broadcast |
| Message loss on claude restart | yes | no (replay queue) |
| Observability | stderr only (claude eats it) | file log + heartbeat + boot dump |
| Lock semantics | bot.pid + `process.kill()` mutual eviction | advisory O_EXCL lock, refuses to start on conflict |
| Startup deps | `bun install` on every claude spawn | one-time `bun install` then daemon stays alive |

## Debugging quick reference

| Symptom | Where to look |
|---|---|
| Bot stops receiving DMs | `tail -f server.log`; check `polling as @...` recent? `sessions=N` > 0? |
| Bot polling but claude not replying | Port listening? `lsof -nP -iTCP:$PORT`. TCP from claude? `lsof -nP -iTCP:$PORT -sTCP:ESTABLISHED`. |
| `409 Conflict` in log | Another bun is holding the poll slot. Likely a stale claude TUI's stdio child — `pgrep -f telegram` and kill. |
| `STATE_DIR ... is locked by live pid=` | Another daemon already running for this STATE_DIR. Don't double-launch. |
| `no active session — persisting to inbox/pending` | claude TUI is down. Wrapper should restart it. |
| `disk-replayed N` after every claude restart | Replay queue working as intended. |
| Memory growing without bound | session accumulation (zombie sessions from claude's 5min reconnect). Currently no in-daemon cleanup — restart daemon if RSS > 500MB. |
