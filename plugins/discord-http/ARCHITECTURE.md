# discord-http architecture

This document explains why this plugin exists, what it changes from the official `discord@claude-plugins-official`, and how the pieces fit together. Read this if you're debugging, contributing, or wondering whether to deploy it.

## TL;DR

The official discord plugin runs as a **stdio child process** of claude TUI. Same architectural fragility as the telegram fork situation — claude can close the plugin's stdio at unpredictable moments and kill the bot. With Discord's WebSocket gateway holding session state, every death drops messages and breaks reply flow.

This plugin replaces stdio with an **HTTP MCP daemon**:

- The bot runs as a long-lived launchd process (`PPID=1`), holding the Discord gateway WebSocket connection forever.
- Claude TUI connects via `StreamableHTTPClientTransport` at `http://127.0.0.1:$DISCORD_HTTP_PORT/mcp`.
- Claude TUI's lifecycle is decoupled from the bot daemon's lifecycle.
- A **disk + memory replay queue** ensures messages that arrive during any restart-gap or handshake race window are delivered to the next claude session.

Same tools (`reply`, `react`, `edit_message`, `download_attachment`, `fetch_messages`), same access control, same `<channel source="discord">` notification format. Drop-in replacement.

## Research history (where the receipts live)

The investigation that produced this fix was driven by the Telegram plugin failures, but the architectural fix applies identically to Discord. Full evidence chain — logs, hypotheses, patches that didn't root-fix, root cause — is published as HedgeDoc reports under the sibling plugin:

| Report | What's in it |
|---|---|
| [Telegram plugin 反覆死亡 debug 全紀錄](https://md.blocktempo.ai/0EXKOeo-QRS6Plby7lUePQ) | 4 rounds of hypothesis testing; 9 stdio-era patches that did NOT root-fix; root cause finally pinpointed via file-logging; Route A vs Route B comparison; final decision rationale |
| [Earlier root-cause + patch design](https://md.blocktempo.ai/7Q318gHJSdOV3BH2ub8fyg) | 14-death-path audit; bug categorization; file-logger patch that made debugging possible |
| [Route B 完成報告 (Telegram side)](https://md.blocktempo.ai/B_MVqPMbQsyLLxo7oGnTdg) | Deployment timeline, ironclad evidence (0 deaths vs 22-244s typical) — Telegram, but the architecture is what got mirrored here |
| [Switchover SOP](https://md.blocktempo.ai/StFH9rUCT2OmGW5T2EM61g) | Step-by-step migration playbook (Scenario A vs B); applies to both channels |

The Telegram and Discord plugins share the same upstream architecture (stdio child of claude TUI, with `process.stdin.on('end', shutdown)`) so they share the same architectural vulnerability. Discord just hadn't visibly broken yet in our deployment.

## Why we forked

Identical motivation to the telegram-http fork: claude TUI periodically closes plugin stdio, the upstream `process.stdin.on('end', shutdown)` handler kills the bun process. With Discord's WebSocket gateway, the gateway connection is lost; with discord.js's reconnect logic gone (because the process is dead), the bot stops receiving messages until a manual restart.

In practice the Discord plugin was less visibly broken than the Telegram one in our deployment — Discord's gateway uses a persistent WebSocket which interacts differently with claude's stdio close behavior, and the official Discord plugin lacks the bot.pid mutual-kill that compounded telegram's failures. The Discord daemon we observed survived 44+ minutes where Telegram daemons were dying every 22-244 seconds. But the **architectural vulnerability is identical** — same `stdio.on('end')` shutdown path, same potential to silently die.

We forked prophylactically + to land the same fix consistently across both channels. Better to fix it before the death pattern emerges than after.

## How it works

```
                                      ┌────────────────────────────┐
                                      │  Discord Gateway (cloud)   │
                                      └─────────────┬──────────────┘
                                                    │ WebSocket gateway
                                                    ▼
   ┌──────────────────┐                ┌────────────────────────────┐
   │   launchd        │  KeepAlive     │  bun server.ts (daemon)    │
   │   (this plist)   │ ──supervises──►│  PPID=1                    │
   └──────────────────┘                │                            │
                                       │  • discord.js Client       │
                                       │  • HTTP server :PORT       │
                                       │  • disk inbox/pending/     │
                                       │  • per-session mem queues  │
                                       └─────────────┬──────────────┘
                                                     │ HTTP/SSE
                                          127.0.0.1:$DISCORD_HTTP_PORT/mcp
                                                     │
                  ┌──────────────────────────────────┼──────────────────────────────────┐
                  ▼                                                                     ▼
       ┌────────────────────┐                                                ┌────────────────────┐
       │  claude TUI A      │                                                │  claude TUI B      │
       └────────────────────┘                                                └────────────────────┘
```

Same overall shape as `telegram-http`. Key Discord specifics:

- **WebSocket gateway (not long-poll).** discord.js manages the WS connection internally, including automatic reconnect on network drops. The plugin doesn't need a retry loop for normal operation — only for the initial `client.login()` which we wrap in `loginLoop()` with backoff.
- **`bot.lock` via advisory file lock.** Discord's gateway slot is enforced by Discord (one session per token); we add a file lock to prevent two daemons sharing the same `$DISCORD_STATE_DIR` from both trying to connect.
- **5 tools (not 4).** Discord plugin includes `fetch_messages` to retrieve channel history (Discord doesn't expose a search API to bots; long-poll history is the only way to look back).
- **DM channel ID ≠ user ID.** Telegram's chat_id equals the user ID for DMs; Discord's DM channel ID is its own opaque snowflake. We maintain a `dmChannelUsers` map (channel ID → user ID) so the outbound `fetchAllowedChannel()` gate can verify DM allowlist correctly.
- **Threads.** Discord channels can be thread children of parent channels; the inbound gate looks at `msg.channel.parentId` for thread messages so opt-in policy is keyed on the parent channel.
- **Button-style permission UI.** Uses `ButtonBuilder` + `ActionRowBuilder` for the See more / Allow / Deny buttons on permission_request, vs Telegram's inline keyboard.

## The replay queue

Identical mechanism to `telegram-http` — see that plugin's `ARCHITECTURE.md` for the full walkthrough. Summary:

| State | What happens |
|---|---|
| 1. No claude session connected | Persist to `$STATE_DIR/inbox/pending/<ts>-<seq>.json`, replay on next session's first GET. |
| 2. Session registered but SSE GET not yet open (handshake race) | Push into per-session in-memory queue; flush when GET arrives. |
| 3. Session has SSE open | Direct `server.notification()` — instant delivery. |
| 4. Multiple sessions | Mix of (2) and (3); plus disk safety-net if no session had SSE open. |

GC hourly: prunes >7 days, caps at 1000 newest.

## Discord vs Telegram architecture differences

| | telegram-http | discord-http |
|---|---|---|
| Underlying lib | Grammy (HTTP long-poll) | discord.js (WebSocket gateway) |
| Connection retry | grammy's polling loop + outer try/catch | `loginLoop()` for initial login; discord.js handles WS reconnect |
| Message lib quirks | `parse_mode`, MarkdownV2 escaping rules | Standard markdown, but 2000 char limit (vs 4096) |
| Attachment download | Two-step: `getFile(file_id)` → fetch URL | One-step: `attachment.url` |
| Permission UI | Inline keyboard (callback_query) | Button components (interactionCreate) |
| Identifiers | chat_id == user_id for DMs | dmChannelId ≠ userId; needs map |
| Threads | n/a | Yes; gate uses `channel.parentId` |
| Extra tool | — | `fetch_messages` (channel history) |

## File layout

```
~/.claude/channels/discord/              ($DISCORD_STATE_DIR — default)
├── .env                                  DISCORD_BOT_TOKEN=...           (chmod 600)
├── access.json                           pairing + allowlist + group policies
├── approved/<senderId>                   pairing confirmation drops
├── bot.lock                              advisory lock (PID of running daemon)
├── server.log                            structured log: boot/heartbeat/sessions/exits
├── launchd.out.log + launchd.err.log     launchd's raw capture
└── inbox/
    ├── 12345-abc.png                     downloaded attachments
    └── pending/
        └── <ts>-<seq>.json               replay queue entries
```

## Observability

Same `server.log` format as `telegram-http`, plus:

- `gateway connected as <username>#NNNN` — discord.js Client successfully logged into Discord gateway
- `heartbeat ... ws=N sessions=N` — `ws` is discord.js's `Client.ws.status` enum (0=READY, 1=CONNECTING, 2=RECONNECTING, 3=IDLE, 4=NEARLY, 5=DISCONNECTED). Healthy state is `ws=0`.
- `client.login failed (attempt N): ... — retrying in Ns` — initial login retry loop
- `permission_request send to <userId> failed: ...` — DM send fail for permission button delivery (typically rare; usually means user blocked the bot or token invalid)

## Correct usage

### Per-bot setup
1. Pick a TCP port (we use 17641 for the channel bot).
2. Pick `$DISCORD_STATE_DIR` (default `~/.claude/channels/discord`).
3. Put `DISCORD_BOT_TOKEN=...` in `$STATE_DIR/.env`, `chmod 600`.
4. Write a launchd plist with `DISCORD_HTTP_PORT`, `DISCORD_STATE_DIR`, `DISCORD_HTTP_HOST` in `EnvironmentVariables`.
5. `launchctl bootstrap gui/$(id -u) <plist>`.

### Per-claude-instance setup
1. Set `DISCORD_HTTP_PORT=$port` in claude's env. Without it the `.mcp.json` substitution fails.
2. Run `claude --channels plugin:discord-http@crab-labs-plugins`.

### Pairing
Same `/discord:access` skill as the official plugin.

## Health endpoint

`GET /healthz` returns a JSON snapshot of daemon state for health probes / dashboards:

```json
{
  "ok": true,
  "plugin": "discord-http",
  "bot_tag": "your-bot#1234",
  "uptime_s": 3600,
  "mem_rss_mb": 92,
  "active_sessions": 1,
  "ws_state": 0,
  "ws_ready": true,
  "pending_disk_count": 0,
  "pid": 12345
}
```

`ws_state` follows discord.js's `Client.ws.status` enum: 0=READY, 1=CONNECTING, 2=RECONNECTING, 3=IDLE, 4=NEARLY, 5=DISCONNECTED. Anything other than 0 means the gateway WebSocket isn't fully connected. `pending_disk_count > 0` means replay queue has unread messages.

Cheap, unauthenticated; relies on `127.0.0.1` bind for security.

## Compatibility notes

- The MCP server registers as `name: "discord-http"` (1.0.1+; was `"discord"` in 1.0.0). The `.mcp.json` URL is `…/mcp?v=crab-labs`. This differentiates from upstream's `name: "discord"` / `…/mcp` so claude TUI's URL-based plugin MCP server dedup doesn't suppress this fork. **You can safely enable both** `discord@claude-plugins-official` and `discord-http@crab-labs-plugins` in `enabledPlugins`.
- One gateway connection per Discord bot token — don't run two daemons against the same token concurrently (Discord gateway rejects duplicate identifies).
- All tools (`reply`, `react`, `edit_message`, `download_attachment`, `fetch_messages`) have the same input schemas and semantics as official.
- `/discord:access` skill is byte-identical to upstream (we copied unchanged). Skill paths exposed as `/discord-http:access` and `/discord-http:configure`.
- Inbound channel notifications render as `<channel source="discord-http" chat_id="..." ...>` (1.0.1+). Meta keys (`attachment_count`, `attachments`, etc.) are identical to upstream.

## Differences from upstream you should know about

| | Official `discord@claude-plugins-official` | This `discord-http@crab-labs-plugins` |
|---|---|---|
| Transport | stdio (claude spawns bun child) | HTTP / SSE (StreamableHTTP) |
| Lifecycle | dies with claude stdio close | launchd-managed, independent |
| Multi-claude support | one claude at a time | multi-session broadcast |
| Message loss on claude restart | yes | no (replay queue) |
| File logging | none (stderr only) | structured log at `$STATE_DIR/server.log` |
| Heartbeat | none | 30s heartbeat with ws-state |
| SIGPIPE handling | none | ignored (don't die on broken pipe) |
| Advisory lock | none | yes (`bot.lock`) |
| Login retry | exits on first failure | `loginLoop()` with backoff |

## Debugging quick reference

Same as `telegram-http`'s debugging table, plus:

| Symptom | Where to look |
|---|---|
| `ws=5` in heartbeat (DISCONNECTED) | Network issue or token revoked. discord.js will auto-reconnect; if persistent, check token validity. |
| `client.login failed` looping | Bad token, or rate-limited by Discord. Wait + verify token. |
| Bot online in Discord but doesn't see DMs | Check intents — `GatewayIntentBits.DirectMessages` + `MessageContent` + `Partials.Channel` must all be on (they are in our config). |
| Inline buttons not responding | `interactionCreate` listener verifies sender is in `access.allowFrom`. Check pairing. |
