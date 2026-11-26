# claude-code-host — which Claude Code sessions run on this machine (WO-183)

Onsen's main system knows no runtime (Joey, TG chiron:2642: detection is a plug-in or sub-program, not part of Onsen's core). This program is the Onsen **extension** that knows Claude Code and tmux. It runs once per machine (Mac mini, MBP, txmonster) and needs no bot and no agent's daemon.

It registers as the extension `claude-code-host-<machine>` (kind `host`) and reports one list, `sessions`, through Onsen's generic extension interface (CONTRACT §7b; Onsen 0.30.0 or later).

## What it reports

The list holds one record per entry of `claude agents --json`. No folder is filtered out.

| Field | Value |
|---|---|
| `id` | the Claude Code session id |
| `member` | see **member** below; `null` when no member owns the folder |
| `state` | Claude Code's own status string (`idle`, `busy`, …) |
| `title` | the member's display name, else the folder's last segment |
| `line` | `{display name or 未登記}｜{tmux session or 無 tmux}｜{folder's last segment}｜{接 Telegram / 接 Onsen / 沒有接}｜{state}｜起於 {MM-DD HH:MM 台北}` |
| `attributes` | `{session_id, cwd, tmux, pid, started_at, client}` |

`started_at` is an RFC 3339 time. `client` is `telegram`, `onsen` or `none`.

**member.** The program looks for the nearest folder at or above the session's cwd that holds a `.cc-agent.json` or a `.lanes/main-settings.json`. The member is the first of these it finds:
1. the manifest's `mesh_id`;
2. the `--agent <id>` its `claude_command` passes to lanes-launch;
3. `LANES_AGENT` in that workspace's `.lanes/main-settings.json`, which lanes-launch writes.

A lane runs in its owner's workspace, so it counts as the owner's. A manifest that names no one ends the search with `null`. Real cases:
- `channel-bot`'s manifest has no `--agent`, but its lanes settings say `sonn`.
- `claude-lab-relay` and `claude-monster-steropes` on txmonster have no manifest, only the lanes settings.

**client.** `telegram` in either of two cases:
- One of this machine's Telegram daemons has the session as its main. Its `/healthz` shows `main_session` equal to the session id, `main_phase` is not `gone`, and `sessions_with_open_sse` is at least 1.
- A live Telegram roamer claims the session in `~/.claude/channels/roamer-registry.json`, and both its pids are in `ps`.

Otherwise the value is `none`. `onsen` is kept for sessions that talk to Onsen directly (the next step, not built here).

The daemons are found from these ports:
- the manifests' `channels.telegram.http_port` (`~/cc-workspaces/*/`, `~/.claude/workspace-*/`);
- `TELEGRAM_HTTP_PORT` in `~/Library/LaunchAgents/*.plist` on macOS, or in `~/.config/systemd/user/*.service` and their drop-ins on Linux;
- `~/.claude/channels/roamer-daemons.json` (Telegram roamers);
- `CLAUDE_CODE_HOST_DAEMON_PORTS`.

Only a daemon with lanes on shows `main_session`. On 11-26 every live daemon on the Mac mini does; the two roamers don't, and the roamer registry covers them.

**names.** It reads `GET /v1/members` with its own credential, every 5 minutes. Until the first read succeeds, and for a member Onsen doesn't list, the title is the mesh id.

## When it reports

- **Looking.** Every 5 s it runs one `claude agents --json`, one `tmux list-panes -a`, one `ps -o pid=,ppid= -A`, the daemons' `/healthz` and file reads.
- **Sending.**
  - `PUT /v1/extensions/<name>` registers it and is its heartbeat. It is sent at start, every 5 minutes, and again when Onsen answers 404.
  - `PUT /v1/extensions/<name>/collections/sessions` sends the whole list. It goes at once when the list changed, and every 15 s otherwise. `ttl_seconds` is 45.
- **Onsen not answering.** That list is dropped. The next one carries the list as it is then; nothing is queued or resent. Repeated failures back off, up to 60 s.
- **`claude agents` failing.** No list is sent. Onsen keeps the last list, which goes stale 45 s after it was sent. The heartbeat still goes.
- **Stopped.** Onsen marks the list stale 45 s after the last one. When the program starts again the list is fresh.

## Read-only

The only commands are the three listings above. `session-finder.ts`'s `runReadOnly` starts nothing else; anything else is refused before it starts. Beyond those, it reads files and the daemons' `/healthz` (a GET on 127.0.0.1).

It never sends a key, and it never starts, stops, signals or restarts anything. The credential goes only to Onsen and is never logged.

## Install (per machine)

**1. Credential.** Mint one on BTCC as a **system** identity named after the extension (`mesh_admin`, A2A-COMMS):

```sh
.venv/bin/python -m app.mesh_admin mint claude-code-host-macmini --kind system    # -mbp, -txmonster
```

Put the token in `~/.config/mesh/claude-code-host-<machine>.credential`, mode 600, on that machine. Onsen picks the identity up from BTCC's credential table within 5 minutes.

**2. Its own checkout.** It runs from a pinned checkout, `~/.claude/claude-code-host`, not the live plugin checkout, so a fleet pull or wave never changes it:

```sh
git clone https://github.com/darwin7381/crab-labs-plugins.git ~/.claude/claude-code-host   # or a worktree of a clone you have
git -C ~/.claude/claude-code-host checkout --detach <commit>
```

**Check it**, from `~/.claude/claude-code-host/plugins/telegram-http/claude-code-host`:

```sh
CLAUDE_CODE_HOST_MACHINE=macmini bun claude-code-host.ts --whoami   # "claude-code-host-macmini (system)", exit 0
CLAUDE_CODE_HOST_MACHINE=macmini bun claude-code-host.ts --once     # the register body and the list it would send; writes nothing
```

**3. Load it.**
- **Mac mini / MBP** (launchd, label `com.btai.claude-code-host`):

  ```sh
  sed -e "s#__HOME__#$HOME#g" -e "s#__MACHINE__#macmini#g" com.btai.claude-code-host.plist.example > ~/Library/LaunchAgents/com.btai.claude-code-host.plist   # mbp on the MBP
  plutil -lint ~/Library/LaunchAgents/com.btai.claude-code-host.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.claude-code-host.plist
  tail -f ~/Library/Logs/claude-code-host.log      # "claude-code-host up …", then "registered with Onsen as …"
  ```

- **txmonster** (`systemd --user`):

  ```sh
  install -m 644 claude-code-host.service ~/.config/systemd/user/claude-code-host.service
  systemctl --user daemon-reload && systemctl --user enable --now claude-code-host
  journalctl --user -u claude-code-host -f
  ```

**4. See it in Onsen**, as the owner or the auditor role:
- `GET /api/onsen/v1/extensions` lists `claude-code-host-<machine>`.
- `GET /api/onsen/v1/extensions/claude-code-host-<machine>/collections/sessions` gives the list.
- `GET /api/onsen/v1/members/<agent>/extension-records` gives an agent's main.

**Update the code**: `git -C ~/.claude/claude-code-host fetch origin && git -C ~/.claude/claude-code-host checkout --detach <commit>`, then restart:
- launchd: `launchctl kickstart -k gui/$(id -u)/com.btai.claude-code-host`
- systemd: `systemctl --user restart claude-code-host`

It is not part of `rollout-fleet.sh`'s wave.

## Stop and roll back

- **Stop.**
  - launchd: `launchctl bootout gui/$(id -u)/com.btai.claude-code-host`
  - systemd: `systemctl --user disable --now claude-code-host`

  Onsen marks the machine's list stale after 45 s and keeps showing the last one. Nothing else depends on this program; no agent, daemon or session changes.
- **Remove.** Stop it, then delete the plist or unit. Revoke the credential with `mesh_admin revoke claude-code-host-<machine> --all`.
- **A bad release.** Check `~/.claude/claude-code-host` out at the commit before it, then restart as above.
- **Onsen side.** `ONSEN_EXTENSIONS=0` on fleet-core refuses every extension write (503) and keeps answering reads.

## Environment

| Variable | Default | |
|---|---|---|
| `CLAUDE_CODE_HOST_MACHINE` | (required) | the machine name Onsen uses: `macmini`, `mbp`, `txmonster` |
| `CLAUDE_CODE_HOST_NAME` | `claude-code-host-<machine>` | the extension's name, which is the credential's identity |
| `CLAUDE_CODE_HOST_CREDENTIAL_FILE` | `~/.config/mesh/<name>.credential` | read again when the file changes |
| `ONSEN_BASE` | `https://core.kbro.ai/api/onsen` | `/v1` is added |
| `CLAUDE_CODE_HOST_SCAN_S` | `5` | how often it looks |
| `CLAUDE_CODE_HOST_REPORT_S` | `15` | the keep-alive for an unchanged list |
| `CLAUDE_CODE_HOST_MEMBERS_S` | `300` | display names |
| `CLAUDE_CODE_HOST_REGISTER_S` | `300` | the register heartbeat |
| `CLAUDE_CODE_HOST_DAEMON_PORTS` | — | extra Telegram daemon ports, comma-separated |
| `CLAUDE_CODE_HOST_TMUX_SOCKET` | — | a private tmux socket (`-S`), for tests only |
| `CLAUDE_BIN` | `claude` | |

## Tests

From `plugins/telegram-http`:

```sh
bun test claude-code-host/claude-code-host.test.ts session-finder.test.ts roamer-sessions.test.ts
```

- **The host's tests** use a fake Onsen (`Bun.serve`) that checks every request against CONTRACT §7b's shapes, fake daemons, and a home folder they build. The one program run points tmux at a socket that doesn't exist.
- **`session-finder.test.ts`** starts a tmux server of its own on a private `-S` socket. Run it with `TMUX` unset; it is skipped when `TMUX` is set.
- **`roamer-sessions.test.ts`** pins the roamer's `/roam` list with fake `claude`, `tmux` and `ps` on `PATH`.
