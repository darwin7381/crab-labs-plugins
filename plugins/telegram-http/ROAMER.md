# Roamer — drive ANY local claude session from Telegram

Roamer mode turns a Telegram bot into a **roaming remote control for every claude
session on the machine**. The regular channel-bot setup bridges ONE fixed claude;
a roamer lists all live claude sessions (`claude agents --json`), lets you pick one
from an inline keyboard, takes it over, and from then on your TG messages route to
that session — replies come back to the same chat. Switch targets any time.

Use it when you want one bot that can hop between work-in-progress claudes
(a repo session here, a scratch session there) without standing up a dedicated
bot per workspace.

## How it works

```
TG message ──► roamer daemon (server.ts + roamer-control.ts, ROAMER_MODE=1)
                 │  /roam → list live claudes (claude agents --json, tmux-aware)
                 │  pick target → takeover:
                 │    already in tmux → tmux respawn-pane -k IN PLACE (1.12.0 —
                 │      session + any attached human client SURVIVE; only the
                 │      pane process is replaced)
                 │    naked claude → SIGINT + spawn a fresh roam-* tmux
                 │    relaunch: claude --channels plugin:telegram-http@crab-labs-plugins --resume <sid>
                 │    (drops --resume if the session has no transcript)
                 ▼
               target claude joins the daemon's MCP bridge (new MCP session
               claimed via pendingTakeover → onsessioninitialized)
                 │
                 ▼
               inbound TG routes ONLY to the current target (sendToMcpSession,
               not broadcast); replies/reactions flow back as usual
```

Key implementation points (full detail in `roamer-control.ts` header + CHANGELOG 1.4.0/1.5.0):

- **Discovery** wraps `claude agents --json`, filters out cc-workspaces / channel-bot /
  agy workspaces, and computes tmux membership per PID (parent-chain walk).
- **Takeover** respawns the target with `--channels` so it connects to *this* daemon's
  port (`TELEGRAM_HTTP_PORT` is interpolated into the plugin's `.mcp.json` URL).
  If the live session is empty, it auto-resumes the project's latest non-empty jsonl.
- **Multi-roamer coordination**: shared registry `~/.claude/channels/roamer-registry.json`,
  keyed by bot username. A TG roamer's list hides sessions claimed by OTHER TG roamers
  but shows DC-roamer claims (one target can be bridged to both protocols at once).
  Activeness is checked at read time (`kill -0` + `tmux has-session`) so stale entries self-clear.
- **Per-roamer state**: `roamer-state.json` in the state dir holds `current_target`.

## Command surface (in the bot's TG chat)

| Command | Effect |
| --- | --- |
| `/roam` | List roamable claude sessions as inline buttons; tap to take over |
| `/roam_status` | Show current target (tmux, pid, cwd, session id) |
| `/sessions` / `/resume_list` / `/list` | List the current target project's session history as buttons |
| `/resume <uuid-prefix>` | Inline-switch the target to a specific past session |
| `/resume_previous` | Step back along the resume chain |
| `/restart` | **Full target restart (1.12.0)**: kill + recreate the SAME-NAMED tmux from persisted metadata, relaunch claude in the original workspace with `--resume`, auto re-bridge — keep chatting, no re-`/roam`. Works even when the target tmux is already dead/wedged. A terminal attached to the old session re-attaches to the recreated same-named one. |
| `/kill_stuck` | Same full rebuild as `/restart` (respawn is forceful — exactly what a wedged claude needs) |
| `/model` `/effort` `/codexgate` `/clear` … | Shared TUI commands forwarded to the current target (same busy-safe + verified-notification behavior as channel-bot mode, 1.12.0) |
| `/whoami` | Bot identity + mode sanity check |

Non-slash text goes to the current target as a normal prompt.

## Setting up a roamer on a new machine

Prereqs: this repo cloned as a marketplace (`~/.claude/plugins/marketplaces/crab-labs-plugins`),
`bun`, `jq`, and claude code new enough for `--channels` + `claude agents --json`.

1. **Create a dedicated bot** via @BotFather (`/newbot`). One bot per roamer.
   Never reuse another bridge's token.

2. **State dir + token + access**:

   ```bash
   STATE=~/.claude/channels/roamer-<name>
   mkdir -p "$STATE" && chmod 700 "$STATE"
   printf 'TELEGRAM_BOT_TOKEN=<token>\n' > "$STATE/.env" && chmod 600 "$STATE/.env"
   cat > "$STATE/access.json" <<'EOF'
   {
     "dmPolicy": "allowlist",
     "allowFrom": ["<your numeric TG user id>"],
     "groups": {},
     "pending": {},
     "ackReaction": "👀"
   }
   EOF
   ```

3. **LaunchAgent** (macOS) — mirror this working example, changing name/port/paths
   (`~/Library/LaunchAgents/com.<you>.telegram-daemon.roamer-<name>.plist`):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.you.telegram-daemon.roamer-myroamer</string>
     <key>ProgramArguments</key><array>
       <string>/Users/you/.bun/bin/bun</string>
       <string>run</string>
       <string>/Users/you/.claude/plugins/marketplaces/crab-labs-plugins/plugins/telegram-http/server.ts</string>
     </array>
     <key>EnvironmentVariables</key><dict>
       <key>HOME</key><string>/Users/you</string>
       <key>PATH</key><string>/Users/you/.local/bin:/Users/you/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
       <key>TELEGRAM_HTTP_HOST</key><string>127.0.0.1</string>
       <key>TELEGRAM_HTTP_PORT</key><string>17653</string>
       <key>TELEGRAM_STATE_DIR</key><string>/Users/you/.claude/channels/roamer-myroamer</string>
       <key>ROAMER_MODE</key><string>1</string>
       <key>ROAMER_BOT_NAME</key><string>myroamer</string>
       <key>ROAMER_STATE_FILE</key><string>/Users/you/.claude/channels/roamer-myroamer/roamer-state.json</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>ThrottleInterval</key><integer>10</integer>
   </dict></plist>
   ```

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.telegram-daemon.roamer-myroamer.plist
   curl -s http://127.0.0.1:17653/healthz   # ok:true + polling:true
   ```

   `PATH` must include the dir containing the `claude` binary — takeover shells out to it.

4. **Verify end-to-end**: have a naked `claude` running somewhere, DM the bot `/roam`,
   tap the session button, then send a prompt — the target claude should answer in TG.

### Env var reference

| Var | Required | Meaning |
| --- | --- | --- |
| `ROAMER_MODE` | yes (`1`) | Enables roamer; unset = all roamer exports are no-ops |
| `ROAMER_BOT_NAME` | yes | Registry key for this roamer (use the bot's name) |
| `ROAMER_STATE_FILE` | yes | Path to this roamer's `roamer-state.json` |
| `ROAMER_REGISTRY_FILE` | no | Shared registry (default `~/.claude/channels/roamer-registry.json`) |
| `ROAMER_CHANNEL_PLUGIN` | no | `--channels plugin:<slug>` used at takeover (default `telegram-http@crab-labs-plugins`) |

All three required vars must be set or `isRoamerEnabled()` stays false and the daemon
behaves as a plain channel bot.

### Discord variant

`discord-http` ships the same roamer code path. Same env vars on the discord daemon
(`DISCORD_HTTP_PORT`, `DISCORD_STATE_DIR`, plus the `ROAMER_*` trio; set
`ROAMER_CHANNEL_PLUGIN=discord-http@crab-labs-plugins`). A TG roamer and a DC roamer
can drive the same target simultaneously — takeover loads both `--channels`.

## Pitfalls (each cost us real debugging time)

- **One roamer = one bot = one port = one state dir.** Sharing a token between bridges
  causes getUpdates 409 conflict cascades.
- **Takeover kills/respawns the target claude.** In-flight TUI work is interrupted —
  by design. Don't point a roamer at production cc-workspaces agents (discovery
  filters them, don't bypass it).
- **The picker is unusable mid-turn** while a TG conversation is actively streaming
  (upstream issue #2 in this repo).
- **claude binary version matters**: HTTP-MCP reconnect regressions exist in many
  2.1.14x+ builds — if a taken-over claude goes deaf after a daemon restart, restart
  the TUI; the daemon's 1.6.3 zombie-session GC keeps inbound from silently vanishing.
- **`--disallowedTools AskUserQuestion ExitPlanMode`** is NOT auto-added at takeover;
  if the target opens a picker dialog, the channel can't relay it (upstream #40644).
  Send `/kill_stuck` and retake if the target wedges on a picker.
