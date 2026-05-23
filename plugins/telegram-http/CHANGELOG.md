# Changelog

## 1.3.1 — 2026-05-24

### Fixed
- **Picker can no longer get stuck open** — `resumePickerInlineSwitch` was vulnerable to a race where rapid button taps or daemon restart mid-resume left the `/resume` picker overlay rendered with no Down/Enter ever completing it. While the picker was open, claude TUI ignored all inbound `<channel>` notifications → 3 silent message drops on claude-builder 2026-05-24.

### Added — 4-step defensive picker driver
1. **Pre-Escape** — always send Escape before opening picker (kills any prior open picker / partial input).
2. **Busy guard** — `isClaudeBusy()` checks pane footer for `❯` prompt + spinners (`✻ Cooked for...`, `✢ Fiddle-faddling`, `⏺ Bash(...)`, `Calling ...plugin`); if TUI is mid-tool-call, refuse picker driving rather than racing keystrokes against the UI state machine.
3. **Verify picker open** — poll `tmux capture-pane` for "Resume session" substring up to 3s (six 500ms ticks) before sending Down. Without this, Down can fire before picker renders → goes to main input → corrupts state.
4. **Verify picker closed** — after Enter, poll up to 2s for picker to disappear. If still open, force-Escape + throw error to surface the failure to the user (instead of silently leaving picker stuck).

New helpers `tmuxCapturePane()`, `isPickerOpen()`, `isClaudeBusy()`.

### Synced
- discord-http 1.2.1 ships the same fix.

## 1.3.0 — 2026-05-24

### Added
- **Inline keyboard for `/resume_list`** — every session now appears as a Telegram inline button. Tap once → daemon receives `callback_query` with `resume:<uuid_prefix>` → routes through existing `/resume <uuid>` by-prefix handler → claude TUI inline-switches. **Bypasses the entire list-index → picker-index mapping** that caused the 1.2.5 off-by-one bug. Joey 2026-05-24: 「讓他直接產生出 telegram 選項按鈕讓我點哪個會更準不會歪掉」.

### Changed
- `handleControlSlash` `replyToTg` signature widened to `(msg, opts?: ReplyOptions)` where `opts.keyboard?: InlineButton[][]`. server.ts callers translate to Telegram `reply_markup.inline_keyboard`. Plain `/clear` `/status` etc. callers can still call without opts; only `/resume_list` populates the keyboard.
- New exports from `channel-bot-control.ts`: `InlineButton`, `ReplyOptions`, `handleCallbackData`. The callback handler is wired in server.ts `bot.on('callback_query:data')` before the existing perm-button regex.
- New server.ts helper `sendTextWithMaybeKeyboard(chatId, text, keyboard?)` — splits long text (4000-char chunks) and attaches keyboard to the LAST chunk only.

### Synced
- discord-http 1.2.0 ships the same feature using Discord ACTION_ROW + ButtonBuilder (max 5 per row × 5 rows = 25 buttons; we pack 3 per row).

## 1.2.6 — 2026-05-24

### Added
- **Trailing protocol reminder in every channel notification** — each inbound from Telegram now arrives with an appended `[protocol] You MUST respond via mcp__plugin_telegram-http_telegram-http__reply(chat_id="...") ...` hint inside the same `<channel>` block. Mitigates the "CLAUDE.md is one-shot at session start → attention dilutes as context grows → silent CLI reply" failure mode. Joey 2026-05-24: 「就連你都有幾乎 20% 的機率常常會忘了回覆結果就自己結束工作了」.

This is the contextual companion to the infrastructure-level [check_tg_reply.py Stop hook](https://github.com/btai/dotfiles) fix shipped same day. Two-layer defense:
1. **Stop hook** (infrastructure): blocks turn end if channel-turn lacked reply tool call
2. **Per-inbound reminder** (contextual): every channel msg arrives with a fresh tool-call hint that the model sees in-context (not buried in CLAUDE.md from session start)

The `[protocol]` prefix marks the line as system-injected meta-text so the model can distinguish it from user content. Allowlisted senders can forge the marker by typing it, but no privilege is conferred (only a reminder), so the forgery risk is null.

### Synced
- discord-http 1.1.5 ships the same reminder with the discord-http reply tool name.

## 1.2.5 — 2026-05-24

### Fixed
- **`/resume <N>` and `/resume_previous` off-by-one** — claude TUI's `/resume` picker **excludes the current session** (you can't resume to yourself); our `listClaudeSessions` includes it at array idx 0. We were passing array idx as picker idx → every switch landed on the session BELOW the intended one. Joey 2026-05-24: 「我發現你現在輸入排列好嗎的 resume 功能是錯亂的欸，明明看好了結果起的卻是另一個」.

  Verified empirically by capturing claude-research's `/resume` picker pane: 6 entries in picker vs 7 in listClaudeSessions (delta = current session, hidden by picker).

### Changed
- `resumePickerInlineSwitch` parameter renamed `downCount` → `pickerIdx`. Caller is now responsible for the array-idx → picker-idx conversion (subtract 1).
- `/resume <N>`: `resumePickerInlineSwitch(targetIdx - 1)` (was `targetIdx`).
- `/resume_previous`: `targetPickerIdx = chain.ids.length - 1` (was `chain.ids.length`).

### Synced
- discord-http 1.1.4 ships the same fix.

## 1.2.4 — 2026-05-24

### Changed
- **Tail excerpts now show last 2 *user* questions only** (was: mixed user+assistant up to 3). Joey 2026-05-24: 「資訊還是不夠多，看到的還是很多廢話 — 要多抓兩則我最後問的問題才行」. Assistant replies tend to be long and generic, user questions are short and disambiguating (「在嗎」「處理好了沒」). Per-row format changed from `↳ user: ...` to `↳ ...` (role prefix dropped since all entries are user now).
- `readJsonlTail` window widened from `(40 records, 128KB)` → `(200 records, 1MB)` — one channel-bot assistant turn can emit dozens of large tool blocks (Bash with big stdout, file reads), making per-user-message footprint multi-hundred-KB. Smaller windows were only finding the single most recent user msg on busy sessions.
- `extractMessageExcerpt` also skips `Continue from where you left off` (auto-inserted by Anthropic harness on session restart) and `<user-prompt-submit-hook>` blocks — both were polluting the user-question list.

### Format example

`/resume_list` current-session header now reads:
```
📍 *current session*  `cc557b36-...`
   started: 馬上進行 B 一次完成
   last user questions:
     • 什麼鬼怎麼寫在 Clinic？還有專案到底有記錄嗎？
     • 你為何總是忘記該紀錄的所有位置？要多抓兩則我最後問的問題才行
```

Each session row also gains 2 `↳` lines (was: 1 mixed user/asst).

### Synced
- discord-http 1.1.3 ships the same change.

## 1.2.3 — 2026-05-24

### Fixed
- **`extractMessageExcerpt` no longer emits `[tool_use]` / `[tool_result]` placeholder text** — those tags were Joey-facing noise in `/resume_list` rows. A turn whose `content` array is purely `tool_use` or `tool_result` blocks now returns null → caller walks further back in the session to find real prose. Joey 2026-05-24 screenshot: rows 4 and 5 showed `↳ user: [tool_result]` — useless for picker disambiguation.

### Changed
- `readJsonlTail` window widened from `(8 records, 64KB)` to `(40 records, 128KB)` so the walk-back can skip past tool-heavy tails (long agent turns can easily emit 10+ tool blocks before any text comment).
- `extractMessageExcerpt` also skips records whose text starts with `<local-command-` or `Caveat: The messages below` (auto-injected by `/resume` itself — they were appearing as the "first user msg" of resumed sessions).

### Synced
- discord-http 1.1.2 ships the same fix.

## 1.2.2 — 2026-05-24

### Fixed
- **`/resume`, `/resume_previous`, `/resume_list` replies now include `last messages (tail of session)` excerpts** — previously the only context was an 8-char session-id prefix + the FIRST user message. Joey: 「現在這樣重啟後我根本看不出來他到底重啟到了哪個你懂嗎？還是要列一些對話，例如新的對話的結尾」(2026-05-23 screenshot showed `↩️ walk-back step 1 → 43261680…` with no recognizable conversation context).

  Switched-to session reply now shows:
  ```
  ↩️ walk-back step 1 → `43261680…`
  started: 你看看這是另一隻 agent 的建議 …
  
  last messages (tail of session):
    • user: 我們要先做什麼比較好？
    • asst: 建議先把 Cost panel 跑通 …
    • user: 好，那就開工
  
  _(chain depth 2; `/resume_previous` again to go further back)_
  ```

  `/resume_list` per-session row gains a `↳ <last-msg>` line so Joey can disambiguate which session is which in the picker.

### Added
- `readJsonlTail(path, maxLines, bytesWindow=64KB)` — seeks to file end + reads back N lines without loading multi-MB session files into memory.
- `extractMessageExcerpt(rec)` — flat-text extraction from claude jsonl records; handles `string | Array<text|tool_use|tool_result>`, strips `<channel>` framing, skips `<system>` and `<command-…>` injections, returns `{role: 'user'|'asst', text}` truncated to 120 chars.
- `formatResumeReply({header, session, footer})` — shared renderer used by both `/resume` and `/resume_previous` so the format stays in sync.
- `ClaudeSession.lastMessages?: string[]` — populated in `listClaudeSessions` from the tail of each jsonl. Each entry formatted as `user: ...` or `asst: ...`, max 3 per session.

### Synced
- discord-http 1.1.1 ships the same change (keep-in-sync rule between channel-bot-control.ts copies).

## 1.2.1 — 2026-05-22

### Fixed
- **`/resume_previous` ping-pong bug** — 1.2.0 always went to "mtime-second-newest", so after switching A→B, the next call went B→A (mtime of B was now newest, A second-newest). Forever. Joey: 「resume previous 的邏輯…只會瘋狂的在倒數前兩個切換」.

  New chain-walk semantics: state file `/tmp/channel-bot-resume-chain.json` tracks `{ids: [...], ts}`. Each `/resume_previous`:
  1. If `chain[last] == currentSessionId` → still in chain; pick first mtime-DESC session NOT in chain → that's target. Target's picker index = `chain.length` (because all prior visits sit at picker indices 0..chain.length-1 after their mtime touches).
  2. Otherwise (user did `/resume <N>`, sent a new message, etc.) → reset chain to `[current]` and proceed as step 1.

  Result: `/resume_previous` walks back through history one step at a time, no ping-pong. After exhausting history, replies with "no older history; use /resume_list to jump anywhere".

- **`/resume <N>` and `/resume <uuid>` reset chain** — explicit picks save chain as `[target]` so a subsequent `/resume_previous` walks back from there.

- **`/resume_list` header** — now leads with `📍 current session  <full-uuid>` + preview text, plus chain depth note if user is mid walk-back. Per Joey: 「Resume list 打的時候不是第一行應該要先秀這是在哪個 session 嗎？」

### Added
- New env var `CHANNEL_BOT_RESUME_CHAIN_FILE` (default `/tmp/channel-bot-resume-chain.json`) for chain state persistence. /tmp keeps state across daemon restarts (within reboot).

### Verified
Simulated walk on workspace-telegram cwd (15 cli sessions):
```
step 0: cur=cc557b36 chain=[1]
step 1: target=54a538c2 picker_idx=1
step 2: target=62dd0ab1 picker_idx=2
step 3: target=33844aaa picker_idx=3
step 4: target=911a7999 picker_idx=4
```

## 1.2.0 — 2026-05-22

**`/resume` inline-switch via tmux picker navigation** — replaces 1.1.0's kill-tmux + wrapper-restart approach. Same TUI process (no pid change), no message loss, ~1.5s vs ~5-10s.

### Changed
- `/resume <n|uuid>` and `/resume_previous` now drive claude TUI's native `/resume` picker via tmux send-keys: `/resume` → wait 1.5s → Down × N → Enter. Picker performs an inline conversation-history reload without process restart. Verified pid unchanged across switch in `claude-tui-test` env (2026-05-22).
- **`listClaudeSessions` filter fix**: now filters by `entrypoint === "cli"` (matches claude TUI picker's actual hidden filter). Previously skipped `<channel>` wrapped messages as "framework injections" but they ARE the real user content for channel-bot deployments — that bug made `/resume_list` invert the picker's filter (showed `--print` SDK sessions, hid real channel-bot ones). Now numbering aligns 1:1 with picker → Down-arrow count is reliable.
- `<channel ...>` outer wrapper is now stripped from session preview text in `/resume_list` for readability.

### Why
Joey's 2026-05-22 feedback after 1.1.0 deploy:
> "Resume previous 會吃的很多空的，跟官方的 resume 還是有差…是否該重新思考 /resume 和 /resume_previous 根本不需要殺 tmux"

Empirical testing (claude-tui-test env + workspace-telegram picker probe) confirmed:
1. claude TUI's `/resume` picker filters `entrypoint=sdk-cli` sessions, NOT by content emptiness
2. The picker supports full keyboard navigation via tmux send-keys (Down/Up arrows + Enter)
3. Selecting via Enter performs inline conversation reload — same process, MCP transport remains connected, in-flight messages don't drop
4. Picker order = mtime DESC, current session = index 0, "previous" = index 1

### Removed
- Daemon no longer writes to `$CHANNEL_BOT_NEXT_ARGS_FILE` for `/resume`. The wrapper script's `build_claude_cmd` reading that file is now dormant (kept for potential future overrides — restart of `/restart` still goes through the same wrapper path but doesn't inject `--resume`).

### Risks / known limits
- Picker driven by Down-count assumes our `listClaudeSessions` ordering matches picker order. We mirror mtime DESC + `entrypoint === "cli"` filter; verified on workspace-telegram cwd (18 jsonl files → 15 entries match picker exactly).
- If claude TUI is mid-turn when `/resume` is sent, picker may queue or be ignored. Recovery: send `/sigint` first.
- Cross-cwd resume is rejected by picker ("different directory, cd + --resume"). Not a regression — same in 1.1.0.

## 1.1.0 — 2026-05-22

**Channel-bot TUI control plane** — new feature. Opt-in via `CHANNEL_BOT_TMUX_SESSION` env var. When enabled, the daemon intercepts a curated set of slash commands before forwarding them as ordinary chat content to claude TUI. The handlers run side-effects directly against the channel-bot deployment:

- **tmux send-keys** (claude TUI alive, no restart needed):
  - `/clear` `/help` `/agents` `/mcp` — send claude's native slash directly
  - `/model <name>` — switch model via claude's native /model
  - `/effort <low|med|high|max>` — switch effort via claude's native /effort
  - `/sigint` — send Ctrl+C, interrupt current turn

- **system control** (launchctl / pkill):
  - `/restart` — `launchctl kickstart -k <wrapper>`, claude TUI restarts ~30s
  - `/kill_stuck` — `pkill -9` against claude TUI matching our channels flag; wrapper respawns
  - `/status` — show daemon healthz + claude TUI pid

- **session resume** (writes args-override file + kickstarts wrapper):
  - `/resume_list` — scan `$CHANNEL_BOT_PROJECTS_DIR` for `*.jsonl`, output numbered list with first-user-message preview
  - `/resume <number|session-id-prefix>` — resolve to full id, write `--resume <id>` to `$CHANNEL_BOT_NEXT_ARGS_FILE`, kickstart wrapper. The wrapper script reads the file on next start and appends to CLAUDE_CMD.
  - `/resume_previous` — find most-recent session that ISN'T the current one (skip current), then same flow

The control commands are registered with Telegram's setMyCommands (both `default` and `all_private_chats` scopes) so they show up in the `/` autocomplete menu.

### Required environment variables (opt-in)

| Var | Example | Purpose |
|---|---|---|
| `CHANNEL_BOT_TMUX_SESSION` | `Agent-Son-Claude-Telegram-Channel` | tmux session name where claude TUI runs (enables the feature when set) |
| `CHANNEL_BOT_PROJECTS_DIR` | `/Users/btai/.claude/projects/-Users-btai--claude-workspace-telegram` | claude's project dir for session listing |
| `CHANNEL_BOT_WRAPPER_LABEL` | `com.btai.channel-bot-wrapper` | launchd label for kickstart-style restart |
| `CHANNEL_BOT_NEXT_ARGS_FILE` | `/tmp/channel-bot-next-args` | file the wrapper reads to inject `--resume <id>` on next start |

### Required wrapper integration (for /resume to work)

The wrapper script that launches claude TUI must support reading the next-args file:

```sh
NEXT_ARGS_FILE="/tmp/channel-bot-next-args"
build_claude_cmd() {
  local extra=""
  if [ -f "$NEXT_ARGS_FILE" ]; then
    extra=$(<"$NEXT_ARGS_FILE")
    mv "$NEXT_ARGS_FILE" "$NEXT_ARGS_FILE.used.$(date +%s)" 2>/dev/null || rm -f "$NEXT_ARGS_FILE"
  fi
  CLAUDE_CMD="... $CLAUDE_BIN --channels ... $extra"
}
```

Example wrapper in `~/.claude/workspace-telegram/scripts/restore-channel-bot.sh`.

### Security note

Slash interception runs AFTER the existing gate()/allowFrom authentication. Non-allowlisted senders never reach this code.

### Why
Joey asked: can we drive claude TUI from Telegram? Previously the user had to SSH into the Mac mini and attach tmux to type `/clear` `/resume` etc. in claude TUI directly. With this feature, all those operations work straight from TG DM. Particularly useful for `/restart` when claude TUI gets stuck — recovery is now possible without physical access.

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
