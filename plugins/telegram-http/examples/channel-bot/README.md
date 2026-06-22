# Channel-bot examples

Reference templates for setting up a Telegram (or Discord) **channel-bot** — a
persistent claude TUI that reads commands from a chat channel and is
remotely controllable via the [TUI control plane](../../ADVANCED-SETUP.md).

## Files

| File | Purpose | Install path |
|---|---|---|
| `restore-channel-bot.sh.example` | Wrapper script that keeps claude TUI alive inside a tmux session. Defaults each restart to `claude --continue` (auto-resume most recent session — no context loss on crash); overrides via `/tmp/channel-bot-next-args` (`--resume <id>`) or `/tmp/channel-bot-fresh` (force a new session) | `~/path/to/your/workspace/scripts/restore-channel-bot.sh` |
| `com.user.channel-bot-wrapper.plist.example` | launchd job that runs the wrapper at login + keeps it alive | `~/Library/LaunchAgents/com.user.channel-bot-wrapper.plist` |
| `com.user.telegram-daemon.channel.plist.example` | launchd job for the telegram-http MCP daemon, with `CHANNEL_BOT_*` env vars enabling the control plane | `~/Library/LaunchAgents/com.user.telegram-daemon.channel.plist` |

All three are templates — customise the ALL_CAPS placeholders (`USERNAME`,
paths, labels, ports) for your environment.

## Quick start

1. Copy the three files, rename them to drop `.example`, and fill in the placeholders.
2. `chmod +x` the wrapper script.
3. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.telegram-daemon.channel.plist`
4. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.channel-bot-wrapper.plist`
5. Pair the bot via `/telegram-http:access` skill in another terminal.
6. From Telegram, type `/status` — should see daemon health + claude TUI pid.

Detailed guide: [ADVANCED-SETUP.md](../../ADVANCED-SETUP.md).

## Required matching IDs

These four identifiers MUST match across the three files:

| Identifier | Where it appears |
|---|---|
| tmux session name | wrapper `SESSION="..."` + daemon `CHANNEL_BOT_TMUX_SESSION` |
| Wrapper launchd label | wrapper plist `Label` + daemon `CHANNEL_BOT_WRAPPER_LABEL` |
| TELEGRAM_HTTP_PORT | wrapper script + daemon plist env var |
| claude projects dir | derived from `WORKDIR` (replace `/` with `-`); set as daemon `CHANNEL_BOT_PROJECTS_DIR` |
