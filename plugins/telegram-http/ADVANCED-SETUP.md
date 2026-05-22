# Advanced setup — channel-bot TUI control plane

> Setup guide for the **channel-bot** mode introduced in 1.1.0, where the
> daemon doesn't just relay Telegram messages to claude — it also intercepts
> a curated set of slash commands and applies them **directly to a long-lived
> claude TUI** running in a tmux session. From your phone you can `/clear`,
> `/restart`, `/resume <N>`, `/model Sonnet`, etc., all without SSHing to
> the host.
>
> This is **opt-in** and only relevant if you want a persistent claude TUI
> remote-controlled from a Telegram bot. For one-off `claude` invocations
> with Telegram as a notification channel, ignore this doc and use [SETUP.md](./SETUP.md).

---

## 0. What is "channel-bot" mode?

Conventional setup (in SETUP.md):

```
[you on phone] ─→ Telegram ─→ daemon ─→ claude TUI (started fresh each session)
```

Each `claude` invocation is a one-shot session — when you `/exit`, the
session ends.

Channel-bot mode:

```
[you on phone] ─→ Telegram ─→ daemon ─→ (long-lived claude TUI in tmux)
                                          ↑
                          /clear /resume /restart /sigint
                          all routed via tmux send-keys
                          to the running TUI directly
```

A **wrapper script** (managed by launchd) keeps the claude TUI alive forever
inside a tmux session. The daemon talks to the TUI via HTTP MCP for normal
chat AND can additionally drive its TUI keyboard via `tmux send-keys` to
trigger native claude slash commands.

Why this matters:

- **Persistent context** — one long-running claude conversation, you can come back to it days later
- **Cross-device** — your phone, iPad, laptop all share the same TUI
- **Remote recovery** — if claude hangs, `/restart` from Telegram brings it back without SSH
- **Session navigation** — `/resume_previous` walks back through history one step at a time

---

## 1. Prerequisites

Beyond what's in SETUP.md:

- **tmux** — `brew install tmux`
- **launchd** familiarity — wrapper + daemon are both launchd jobs
- **A pinned claude binary** — channel-bot requires 2.1.140 until upstream fixes the 2.1.141~2.1.148 HTTP MCP transport regression. See SETUP.md §11.2.

---

## 2. The four control-plane env vars

Setting any of these in the daemon plist's `EnvironmentVariables` enables
the control plane. Setting `CHANNEL_BOT_TMUX_SESSION` is the gate:

| Var | Required | Example | Purpose |
|---|---|---|---|
| `CHANNEL_BOT_TMUX_SESSION` | ✅ **yes** (enables feature) | `MyChannelBot` | tmux session name where claude TUI runs. Daemon `tmux send-keys -t <session>` here. MUST match the wrapper's `SESSION` variable. |
| `CHANNEL_BOT_PROJECTS_DIR` | yes (for `/resume*`) | `/Users/.../.claude/projects/-Users-...-workspace` | claude's per-cwd project dir (derived by replacing `/` with `-` in WORKDIR). Daemon scans this dir for `.jsonl` files to enumerate resumable sessions. |
| `CHANNEL_BOT_WRAPPER_LABEL` | yes (for `/restart` / `/resume`) | `com.user.channel-bot-wrapper` | launchd label of the wrapper plist. Daemon `launchctl kickstart -k gui/<uid>/<label>`. MUST match wrapper plist's `Label`. |
| `CHANNEL_BOT_NEXT_ARGS_FILE` | no (default `/tmp/channel-bot-next-args`) | `/tmp/channel-bot-next-args` | File the wrapper reads on each start to inject extra args (e.g. `--resume <id>`). Currently only used by `/restart` flow; 1.2.0+ `/resume` uses picker inline-switch instead. |
| `CHANNEL_BOT_RESUME_CHAIN_FILE` | no (default `/tmp/channel-bot-resume-chain.json`) | `/tmp/channel-bot-resume-chain.json` | 1.2.1+ chain state for `/resume_previous` walk-back semantics. |

If `CHANNEL_BOT_TMUX_SESSION` is unset, the daemon falls through to default
behavior (slashes forwarded to claude as ordinary chat content) — your
deployment is unaffected.

---

## 3. The three files

Channel-bot mode needs three files in addition to whatever SETUP.md
produced. Templates live in [`examples/channel-bot/`](./examples/channel-bot/):

### 3.1 Wrapper script (`restore-channel-bot.sh`)

Place anywhere readable; the launchd plist points to it. Copy from
[`examples/channel-bot/restore-channel-bot.sh.example`](./examples/channel-bot/restore-channel-bot.sh.example),
strip the `.example` suffix, customise the five labeled blocks (ENVIRONMENT,
SESSION+WORKDIR, PLUGIN PORTS, CLAUDE BINARY, RESUME ARGS), and `chmod +x`.

What it does on each loop tick (every 30s):

1. `is_claude_alive` — checks tmux session exists AND active pane is running claude (not the shell)
2. If alive → continue
3. If not alive →
   - `snapshot_pane` — capture last 5000 lines of tmux scrollback for postmortem
   - `tmux kill-session` (idempotent — session may already be gone)
   - `build_claude_cmd` — read `$NEXT_ARGS_FILE` (consume + audit-rename) and append to CLAUDE_CMD
   - `tmux new-session` + `send-keys CLAUDE_CMD Enter`
   - Detect + auto-confirm any "trust this folder" prompt

After 3 consecutive failures, sleeps 1 hour (cooldown). Manual recovery
instructions are printed to the log.

### 3.2 Wrapper plist (`com.user.channel-bot-wrapper.plist`)

Place at `~/Library/LaunchAgents/`. Tells launchd to run the wrapper at
login + keep it alive. Copy from
[`com.user.channel-bot-wrapper.plist.example`](./examples/channel-bot/com.user.channel-bot-wrapper.plist.example).

The `Label` MUST match the daemon's `CHANNEL_BOT_WRAPPER_LABEL` env var.

### 3.3 Daemon plist (`com.user.telegram-daemon.channel.plist`)

Place at `~/Library/LaunchAgents/`. Standard telegram-http daemon plist
plus the `CHANNEL_BOT_*` env block. Copy from
[`com.user.telegram-daemon.channel.plist.example`](./examples/channel-bot/com.user.telegram-daemon.channel.plist.example).

---

## 4. The wrapper-daemon contract (what MUST match)

Four identifiers tie the three files together. Mismatch = features break silently.

| Identifier | Set in | Read in |
|---|---|---|
| **tmux session name** | wrapper `SESSION="..."` | daemon `CHANNEL_BOT_TMUX_SESSION` |
| **Wrapper launchd label** | wrapper plist `<key>Label</key>` | daemon `CHANNEL_BOT_WRAPPER_LABEL` |
| **TELEGRAM_HTTP_PORT** | wrapper `TELEGRAM_HTTP_PORT=...` (also exported into claude's env so `.mcp.json`'s `${TELEGRAM_HTTP_PORT}` interpolates) | daemon plist `TELEGRAM_HTTP_PORT` |
| **Claude projects dir** | derived from wrapper's `WORKDIR` (`/` → `-`) | daemon `CHANNEL_BOT_PROJECTS_DIR` |

> **Important**: ALWAYS pass `--disallowedTools AskUserQuestion ExitPlanMode`
> to claude in the wrapper script. These picker-style tools need keyboard
> focus that the channel-bot can't supply — without disabling them, claude
> deadlocks the first time it tries to ask the user a question. See upstream
> issue #40644.

---

## 5. Install procedure

```bash
# Pick where to keep your wrapper script.
WORKDIR="$HOME/path/to/your/workspace"
mkdir -p "$WORKDIR/scripts" "$WORKDIR/logs"

# Copy template + customise (edit the 5 labeled blocks).
PLUGIN_DIR=~/.claude/plugins/marketplaces/crab-labs-plugins/plugins/telegram-http
cp "$PLUGIN_DIR/examples/channel-bot/restore-channel-bot.sh.example" \
   "$WORKDIR/scripts/restore-channel-bot.sh"
chmod +x "$WORKDIR/scripts/restore-channel-bot.sh"
$EDITOR "$WORKDIR/scripts/restore-channel-bot.sh"

# Copy launchd plists, customise paths + Label.
cp "$PLUGIN_DIR/examples/channel-bot/com.user.channel-bot-wrapper.plist.example" \
   ~/Library/LaunchAgents/com.user.channel-bot-wrapper.plist
cp "$PLUGIN_DIR/examples/channel-bot/com.user.telegram-daemon.channel.plist.example" \
   ~/Library/LaunchAgents/com.user.telegram-daemon.channel.plist
$EDITOR ~/Library/LaunchAgents/com.user.channel-bot-wrapper.plist
$EDITOR ~/Library/LaunchAgents/com.user.telegram-daemon.channel.plist

# Bootstrap both (daemon first so wrapper finds it).
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.telegram-daemon.channel.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.channel-bot-wrapper.plist

# Verify daemon up.
curl -s http://127.0.0.1:17631/healthz | jq

# Verify wrapper running + claude TUI alive in tmux.
launchctl list | grep channel-bot-wrapper
tmux ls   # should show "MyChannelBot" (whatever you set SESSION to)
tmux attach -t MyChannelBot   # peek at claude TUI; Ctrl+B then D to detach
```

Pair the bot via the standard skill:

```
/telegram-http:access
```

Then from Telegram, send `/status` — you should get back something like:

```
📊 channel-bot status

daemon: pid=12345 uptime=678s sessions=1
bot: YourBot polling=true
lastUpdate: 351669376
pending: 0
claude TUI pid: 67890
```

---

## 6. Smoke-test the control plane

From Telegram:

1. `/status` — confirms daemon + TUI both alive
2. `/clear` — claude TUI clears context (you'll see in `tmux attach`)
3. `/model Sonnet` — switches model inline
4. `/resume_list` — lists past claude sessions, header shows current
5. `/resume_previous` — walks back to previous session (no process restart!)
6. `/resume_previous` again — walks back another step (chain semantics)
7. `/restart` — full TUI restart via wrapper (~25s)

If any fail, check:

- `tail -50 $WORKDIR/logs/channel-bot-wrapper.log` — wrapper-side
- `tail -50 ~/.claude/channels/telegram/server.log` — daemon-side
- `tmux capture-pane -pt MyChannelBot | tail -30` — what the TUI actually shows

---

## 7. How the slash interception works (architecture)

Daemon flow on inbound Telegram message:

```
poll Telegram → bot update
              ↓
           gate() / allowFrom check
              ↓
        text starts with "/"?
        ├── yes → handleControlSlash() try to handle
        │         ├── matched → reply to TG with status; DON'T forward to claude
        │         └── no match → fall through, forward as <channel> notification
        └── no  → forward as <channel> notification
```

`handleControlSlash` dispatches by command name:

- **tmux send-keys family** (`/clear`, `/model`, `/effort`, `/agents`, `/mcp`, `/help`, `/sigint`)
  - Runs `tmux send-keys -t <session> <text> Enter` against the claude TUI
  - claude TUI handles it natively as if a human typed it
  - Status reply sent back to Telegram

- **System control family** (`/restart`, `/kill_stuck`, `/status`)
  - `launchctl kickstart -k gui/<uid>/<wrapper-label>` or `pkill -9` or `curl /healthz`

- **Resume family** (`/resume_list`, `/resume`, `/resume_previous`)
  - 1.2.0+ uses claude TUI's `/resume` picker via tmux nav: open picker → Down × N → Enter
  - Inline-switch: same TUI process, no restart, ~1.5s vs the old 5-10s restart
  - 1.2.1+ adds chain state for `/resume_previous` walk-back semantics (no ping-pong)

Security: `handleControlSlash` runs **after** `gate()` / `allowFrom`, so
non-allowlisted senders never reach it.

---

## 8. Risks & limits

1. **Mid-turn behavior** — sending `/clear` or `/resume` while claude is
   mid-turn may queue or be ignored. Run `/sigint` first if claude is busy.

2. **Cross-cwd resume rejected** — claude TUI picker refuses to load a
   session from a different cwd; the picker prints "different directory,
   cd + claude --resume". Resume is per-WORKDIR.

3. **Timing-based, not event-based** — picker driving uses sleep + capture.
   On heavily loaded hosts, you may need to bump the 1.5s render wait in
   `channel-bot-control.ts`'s `resumePickerInlineSwitch`.

4. **2.1.141~2.1.148 client-side regression** — must pin claude to 2.1.140
   until upstream fixes the silent HTTP MCP transport drop. See
   [SETUP.md §11.2](./SETUP.md) and [Claude Clinic note](https://md.blocktempo.ai/B_MVqPMbQsyLLxo7oGnTdg).

5. **Single channel-bot per cwd** — the projects dir is shared, so only one
   wrapper should manage one tmux session per WORKDIR. Multiple wrappers
   for the same cwd would interfere with the `/resume` picker's view of
   "which session is current".

6. **Daemon restart cuts MCP transport** — restarting the daemon kills
   claude TUI's MCP transport. Per the regression, claude TUI may not
   reconnect automatically. After a daemon `launchctl kickstart`, also
   `tmux kill-session -t <session>` so the wrapper relaunches claude with
   a fresh MCP connection.

---

## 9. Customising for non-Telegram channels

The discord-http plugin has the same control plane wired up. Same env vars
(prefixed `CHANNEL_BOT_*` are shared between both plugins). If both
daemons share the same `CHANNEL_BOT_TMUX_SESSION` they BOTH can drive the
same claude TUI — useful when you want both Telegram and Discord remote
control of one TUI.

---

## 10. Background reading

- Plugin CHANGELOG sections **1.1.0** / **1.2.0** / **1.2.1** — detailed history of the control plane evolution
- HedgeDoc report on the 2026-05-22 paradigm shift: <https://md.blocktempo.ai/cy8iIB95QPqgrBqI480kKg>
- Claude Code GitHub issues #21721, #60061, #59956 — context on the transport regression that prompted the 2.1.140 pin
