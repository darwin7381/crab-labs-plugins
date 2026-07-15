# Changelog

## 1.18.1 (2026-07-16)

### Fixed — /restart false-❌ 124 + fleet-wide supervisor bounce (Joey's recurring 2026-07-14/15 reports)
- `/restart` replied `❌ restart claude TUI failed: launchctl kickstart failed (124)` while the agent actually came back fine. Root cause (log-verified on the 2026-07-15 16:07Z incident): supervisor-managed agents all share `CHANNEL_BOT_WRAPPER_LABEL=com.btai.agent-supervisor`, so step 2's `launchctl kickstart -k` bounced the ENTIRE fleet watchdog per /restart. Joey's real usage is several /restarts in a row (builder→elsa→athena→atlas within 35s); each kickstart after the first lands inside the previous respawn's `ThrottleInterval=10s` window, `kickstart -k` blocks until launchd's deferred respawn, and `runCommand`'s 8s default timeout SIGKILLed launchctl → exit 124 → false ❌. Even a solo /restart measured ~7s kill→respawn — 1s of margin. Side damage: every bounce wiped supervisor in-memory state (fail counts / orphan tracking) and the killed kickstart left the supervisor DOWN for the rest of the throttle window, so TUIs killed in the same window waited minutes for the fresh supervisor's serial first pass (builder took ~2.5min).
- Rework: the tmux kill IS the restart (wrapper/supervisor tick ≤30s picks it up — same mechanism the supervisor's own `/api/restart` relies on). Step 2 is now a health backstop only: `launchctl print` (5s) verifies the wrapper service is running; only if NOT running, plain `kickstart` (no `-k`) starts it with a 25s timeout (> ThrottleInterval) so a throttle-deferred spawn completes instead of becoming a fake 124. `restartClaudeTUI()` returns which path it took and the TG reply states it honestly, with a realistic 30–60s estimate (old text promised "~25s" + claimed a kickstart that is no longer unconditional).
- Uniform for both wrapper patterns (dedicated channel-bot-wrapper AND shared agent-supervisor) — no label-specific branching; the dedicated wrapper also polls every 30s, so semantics are identical.

## 1.17.6 (2026-07-13)

### Fixed — /model "current model" line could show another roam target's model
- The last-confirmed-switch record (`saveLastConfirmedSwitch`) stored only `{value, ts}` with no target identity. A roamer daemon keeps ONE record file (its `TELEGRAM_STATE_DIR/last-model-switch.json`) shared across all roam targets, so after switching model on target A, opening `/model` on target B would read A's record and mislabel B's "目前模型". Now the record carries `tmux` and `detectCurrentModel()` only honors it for the matching target (channel-bot passes its fixed `TMUX_SESSION`, unaffected; pre-existing record files without the field are ignored → fall through to the jsonl's real last-reply model). Part of a full sweep for roam-unaware "fixed-session" logic prompted by the 1.17.5 report; see PRINCIPLES.md §3. The rest of the shared path (`runTuiSwitchCommand`, `runCodexGate`, `/input`, ctrl-keys) was audited and already threads the target tmux correctly.

### Docs
- PRINCIPLES.md §3: "Shared features must not assume a fixed session — thread the target, verify in roam" — the discipline that would have caught #7/#8 shipping broken in roam.

## 1.17.5 (2026-07-13)

### Fixed — bare /model picker was dead in roamer mode (regression report 2026-07-13)
- In a roam session, `/model` (no argument) returned `usage: /model <value>` instead of the tap-to-pick model keyboard. Root cause: the picker branch was gated on `isControlEnabled()`, which is `TMUX_SESSION !== ''` — always FALSE for a roamer daemon (no fixed channel-bot session). This has been broken since 1.15.2, whose "#7 roamer bare /model gets the picker" fix dropped the `tmuxName === TMUX_SESSION` half of the guard but kept `isControlEnabled()`, so the picker never actually reached roamers (the #7/#8 fixes were verified only against a fixed channel-bot). NOT caused by the 1.17.3/1.17.4 system-alert work. Fix: gate on `tmuxName !== ''` (the actual target — fixed session OR the roam-<x> pane, non-empty in both modes); the branch below already builds dynamic-target callbacks via the tmuxHash6 suffix, and the tap path (`handleModelCallbackForCurrentTarget`) already routes to the current target, so both display and selection now work in roam. `/model <value>` (with an explicit id) was unaffected throughout. Channel-bot mode unchanged (`tmuxName` = TMUX_SESSION).

## 1.17.4 (2026-07-13)

### Fixed — roamer system-alert now tails the EXACT target session, not newest-in-dir (issue #6 follow-up)
- The 1.17.3 fix resolved the right *directory* but still handed it to `newestJsonl(dir)` — and a single cwd can hold several session jsonls. When the roamer's current target sits idle while a sibling session in the same cwd is active, the sibling wins the newest-mtime race, so API-death / login-expiry alerts get tailed from (and attributed to) the WRONG session, and the real target's alerts are missed. The roamer already knows its target exactly (`current_target.cwd` + `session_id`), so the watcher now resolves that one transcript directly via a `resolveFile()` (was `resolveDir()`), bypassing the newest-jsonl guess. Follows `/roam` (null between targets; a 0-turn target with no jsonl yet is simply skipped until it writes). Channel-bot mode unchanged (static dir + newest-jsonl, one primary session per fixed dir). Caught by the Codex stop-gate review.

## 1.17.3 (2026-07-13)

### Fixed — roamer system-alert jsonl fallback now follows the moving target (issue #6)
- The jsonl-tail fallback resolved its watch dir ONCE from a static env (`SYSTEM_ALERT_PROJECTS_DIR` / `CHANNEL_BOT_PROJECTS_DIR`), which roamer can't set (target moves per `/roam`) — so the fallback was disabled and API-death / login-expiry alerts never fired in roamer mode. `startSystemAlertWatcher` now takes an optional `resolveDir()` re-called each tick; roamer passes `roamerCurrentProjectsDir()` (current_target.cwd → same cwdSlug/PROJECTS_ROOT as transcriptPath). The existing newest-jsonl file-switch logic then follows target switches automatically (new dir → new file → offset reset to end, no replay). Channel-bot mode unchanged (static env dir).

## 1.17.2 (2026-07-13)

### Fixed — roamer bare `/model` picker's "current model" line no longer always "無法判定" (issue #8)
- The picker called `detectCurrentModel()` with no projects-dir override, so in roamer mode it read the unset channel-bot `CHANNEL_BOT_PROJECTS_DIR` and never found the session jsonl → always "無法判定 / 尚無回覆紀錄" even on a busy target. `forwardSharedTuiSlash` now takes an optional `projectsDirOverride`; roamer derives it from `current_target.cwd` via the same `cwdSlug`/`PROJECTS_ROOT` used for `transcriptPath`, so the picker reads THIS target's history. Channel-bot mode unaffected (falls back to the env as before).

## 1.17.1 (2026-07-13)

### Fixed — startup-picker: a stale button tap can no longer drive the wrong TUI state
- The tap only validated the target session, not that the SAME picker was still on the pane. A stale tap (picker already answered elsewhere, timed out, or replaced by a different picker / the normal prompt) would blind-send Down/Enter into whatever was there. Now the callback carries a picker-key hash (`spick:<tmuxHash6>:<keyHash6>:<idx>`) and both the callback handler and `driveStartupPicker` re-capture the live pane and require the same picker (matching key, in-range idx) before sending ANY key — otherwise they abort untouched and tell the user the menu is gone.

## 1.17.0 (2026-07-13)

### Added — startup-picker interceptor: surface claude's boot-time blocking pickers to Telegram as tap-to-choose buttons
- New `startup-picker.ts`: a pane watchdog (sibling of the login-expired watchdog) that detects claude's large-session resume menu — and any startup blocking picker — on the tmux pane, parses its REAL option labels, and surfaces them to the channel chat as inline buttons. A tap drives the keystroke (Down×idx + Enter) into the stuck TUI. The 1/2/3 is internal; the user taps a label.
- Fixes the silent-wedge: a keyboard-less daemon-launched claude (channel-bot / roamer) that came up on the resume picker at restart / session-reopen sat blocked with nothing reaching Telegram. Now it's visible and one-tap answerable from the phone — the user also keeps the summary-vs-full choice (blind suppression would auto-pick full and waste usage on huge sessions).
- Callback `spick:<tmuxHash6>:<idx>` pins the tap to the specific target (a stale button can't drive the wrong session). Wired into server.ts with a shared `paneWatchTargets` (dedups with the login watchdog) + a `spick:` callback branch.
- Added `PRINCIPLES.md`: capabilities that belong to the plugin must be implemented IN the plugin, never scattered to machine env / boot plists / wrapper scripts (the wrong first-attempt fix for this exact bug); + keyboard-less launches must never block on an interactive prompt.
- Supersedes issue #9's env-suppression stopgap (that was an out-of-plugin band-aid; this is the in-plugin fix).

## 1.16.0 (2026-07-12)

- **agent-inbox: full A2A mesh.** `CHANNEL_INBOX_ONLY=1` mode is now bidirectional:
  a `send_to_agent` tool lets any agent message any fleet agent via the shared
  registry (`~/.claude/agent-inbox/registry.json`); deliveries are durable and
  auto-logged to the BTCC Comms console. New sibling plugin `agent-inbox` boots
  this mode standalone (own process/port/state per agent, zero Telegram coupling).

## 1.15.2 (2026-07-12)

### Fixed — roamer bare `/model` now opens the same tap-to-pick picker as channel-bot (issue #7)
- The picker was deliberately gated to the fixed channel-bot session because a `model:` callback lost its target context and would mis-drive TMUX_SESSION in roamer mode. Dynamic targets now embed a 6-char tmux-name hash in the callback (`model:<value>@<hash6>`, ≤64 bytes verified); at tap time the roamer validates the hash against the CURRENT target — target switched in between ⇒ friendly refusal instead of driving the wrong session.
- On match the tap reuses the proven `/model <value>` with-args path (send-keys + busy-safe auto-confirm) on the target tmux — no forked logic.
- Roamer bot menu description updated to advertise the picker. Same-version UX between channel-bot and roamer eliminates the "deployment must be stale" misread (the actual trigger for 1.15.1's freshness self-report).

## 1.15.1 (2026-07-12)

### Added — boot-time version self-report + freshness check (Joey rule: never silently run stale code)
- New `version-check.ts`: at every daemon boot, resolve the running copy's version (top CHANGELOG entry) + git short HEAD, `git fetch origin main`, and count commits behind. Fail-open (offline / non-git copies degrade to "freshness unknown"; boot never blocked).
- Startup log now prints the version line; **stale copies log a loud ⚠️ with the exact fix commands** (`git -C <dir> pull` + `launchctl kickstart -k`).
- `/healthz` gains `version` / `commit` / `behind_origin` — any machine's daemon freshness is now one `curl` away.
- Roamer `/whoami` leads with the same version line.
- Background: JL-machine incident — a roamer daemon ran a 1.1.0-era copy for weeks because its plist pointed at a frozen path and nothing ever verified freshness (issue #5 was the cache-key half; this closes the daemon half).

## 1.15.0 (2026-07-12)

- **`POST /inject` — localhost agent-wake inbox.** Locally-originated messages (e.g. the
  Argus→Hephaestus on-call wake) now ride the SAME durable delivery path as Telegram
  inbounds: memQueue + disk pending replay + delete-on-delivery. Replaces tmux send-keys
  injection (fragile: TUI busy/menus, silent loss, shell-execution risk if the pane died
  back to zsh). Optional `CHANNEL_INJECT_TOKEN` env gates it on top of the 127.0.0.1 bind.

## 1.14.3 — 2026-07-11

### Added — notify on silent model fallback

Joey: "補plugin，如果被 failback 至少要通知我". Claude Code silently swaps the
selected model for a stabler one when the primary errors/overloads — it lands
in the session jsonl as an assistant content block
`{type:"fallback", from:{model}, to:{model}}`. The user believes they're on
model X but replies actually come from Y (e.g. a `--model claude-fable-5`
session quietly running on `claude-opus-4-8` after 7 fallbacks). The
system-alert jsonl-tail layer now detects this block and forwards a one-line
notice: "⚠️ 模型自動退回：X → Y …". Requires SYSTEM_ALERT_FORWARD=1 (already on
for channel-bot). Tested against real fallback lines; normal text/tool_use
lines still return null (no false alerts).

## 1.14.2 — 2026-07-10

### Fixed — roamer falsely warns "尚未連線 target" while roam is actually connected

Joey: "最近明明 roam 連著，但有時候我傳訊息他會彈出沒連叫我再一次 roam." Root cause:
the target's MCP session is tracked in the in-memory `tmuxToMcpSession` map,
which is written ONLY on the takeover path and is emptied by any daemon
restart — while `current_target` is persisted on disk. So a daemon restart (we
restarted 4–5× today deploying 1.12→1.14.1), or ANY plain MCP reconnect of an
already-claimed target (SSE drop, zombie-GC eviction + reconnect), left the
target alive and re-bridged but UNMAPPED in memory. `getCurrentTargetMcp
SessionId()` returned null and `dispatchInbound` replied "尚未連線 target"
persistently, until the next `/roam` re-claimed. Confirmed in the production
time_travelers logs: across 4 daemon restarts the same target claude
reconnected each time with NO "claimed for pending takeover" line — every
message in those windows would have hit the false warning.

Fix: `dispatchInbound` now resolves the target via
`resolveCurrentTargetMcpSession(activeSessionIds)`, which self-repairs the map:
if `current_target` is genuinely alive (tmux + claude pid) but unmapped, it
re-adopts the reconnected MCP session (only when there's a single unambiguous
unclaimed active session — never guesses between multiple bridged claudes) and
routes normally. A live target whose bridge is still mid-reconnect gets an
honest "連線重整中，稍等幾秒" reply (with a brief internal retry) instead of the
misleading /roam prompt; only a genuinely-dead target is told to /roam.
Lab-verified before/after on the same action (roam a target → restart daemon →
send without re-/roam): pre-fix → false "尚未連線"; post-fix → message routes to
the target and it replies (daemon logs "re-adopted reconnected session … map
was out of sync"), mid-reconnect → honest "連線重整中".

## 1.14.1

- **system-alert: surface Claude's OWN human usage-limit message, not the raw provider 429 string.** When Claude hits a usage/rate limit it writes a human-readable assistant record (`isApiErrorMessage: true`, e.g. "You've hit your weekly limit · resets Jun 9 at 6am (Asia/Taipei)"). The jsonl-tail layer now forwards that verbatim, and the OTLP layer suppresses the raw HTTP 429 "exceed your account's rate limit" string (which named the wrong problem). Login/refusal/other-status api_error alerts unchanged. (Joey 2026-07-10)

## 1.14.0 — 2026-07-10

Merged release: inbound/media hardening (#2 #6 #12 #13) + orchestration/
guardian hardening (#3 #4 #5 #7 #8 #9 #10 #15 #16), from the post-1.13.0
imperfection roadmap.

### Orchestration/guardian hardening — roadmap #3 #4 #5 #7 #8 #9 #10 #15 #16

- **#3 login-expired pane watchdog** (channel-bot AND roamer targets): a
  `Login expired` marker in a watched pane DMs the allowFrom users with the
  /login → /restart recovery path; per-pane per-episode debounce so one
  outage is one alert.
- **#4 roamer argv capture/replay**: original claude argv is captured via
  `ps` at takeover/discovery, whitelisted flags persist in state+registry
  and are REPLAYED on takeover respawn and /restart — a `--model`-pinned or
  custom-flagged target no longer loses its flags. Non-whitelisted flags
  are ignored, logged, and surfaced in the TG notify.
- **#5 EADDRINUSE bind retry** 10×1s before exit — fast daemon restarts no
  longer die on the previous socket lingering (~1.3s window, hit live).
- **#7 per-tmux switch lock**: a second `/model`/`/effort` during a running
  orchestration is refused, naming the in-flight target.
- **#8 /status fixed for paired users in control mode**: grammy's command
  middleware preempted handleControlSlash so the daemon-health /status was
  unreachable; paired /status now includes the daemon/TUI health block.
- **#9 keyword-guarded auto-confirm**: the switch orchestrator only
  auto-Enters a Yes/No picker whose pane text matches the command's keyword
  (Switch model? / effort) — never blind-confirms an unrelated dialog.
- **#10 `CHANNEL_BOT_MODEL_SCOPE=session`** (opt-in): after a confirmed
  /model switch, the pre-switch global default is restored to
  settings.json — in-TUI effect only, machine-wide default unpolluted.
- **#15 stable idle detection**: idle = two consecutive clean pane samples;
  busy markers extracted to a `BUSY_PANE_MARKERS` constant for easy
  per-TUI-version updates.
- **#16 pairing code TTL 30min** (was 1h): pairing prompt and /status show
  remaining validity; periodic sweep prunes expired codes.

### Inbound/media hardening — roadmap #2 #6 #12 #13

**#2 — photo download failure is no longer silent.** Before: a failed photo
download produced a bare caption-only message (no image_path, no marker, no
file_id — the agent answered as if it saw nothing). Now the meta carries
`image_error="download failed"` plus `attachment_kind="photo"` +
`attachment_file_id` (+ size) so the agent can retry via download_attachment,
and the MCP instructions direct the agent to TELL the user the image didn't
come through. Photo/file fetches also honor `TELEGRAM_API_ROOT` (was
hard-coded), and photo downloads now check HTTP status instead of writing
error pages to disk. Lab-verified with a real network failure
(`TELEGRAM_API_ROOT=http://127.0.0.1:9`), no injected test code.

**#6 — album aggregation.** Photos sharing a `media_group_id` are buffered
~1.5s (timer resets per item) and delivered as ONE notification:
`image_path` / `image_path_2` / … in album order, `media_group_count`,
captions joined as the body (`(album: N photos)` when uncaptioned). Failed
items keep their position as `image_error[_k]` + `attachment_file_id[_k]`.
Single photos completely unaffected; non-photo album items unchanged.
Lab-verified: 2-photo and 3-photo albums each arrived as one message.

**#12 — opt-in voice transcription.** `CHANNEL_BOT_VOICE_TRANSCRIBE=1` makes
the daemon download voice/audio attachments and run LOCAL whisper (CLI, CPU,
`CHANNEL_BOT_WHISPER_MODEL` default "small"; `CHANNEL_BOT_WHISPER_BIN` to
point at the binary; `CHANNEL_BOT_TRANSCRIBE_CMD` full override). Result
rides in meta as `voice_transcript` (≤500 chars, sanitized, truncation
marked). Failure never blocks: message still ships with its file_id (both
paths lab-verified). Default OFF — zero behavior change. NOTE:
media-alchemist's transcribe.sh was rejected as the backend — its forced-MPS
local mode currently dies with SparseMPS NotImplementedError on modern torch
(verified on the Mac mini with both small and large-v3).

**#13 — truncation & sanitization markers.** `metaExcerpt` truncation now
appends `…` (was a silent 200-char cut); media-kind labels flow through the
same cap. `safeName` replaces delimiter chars with readable FULL-WIDTH
lookalikes（`<>[];` → ＜＞［］；, CR/LF → space）instead of `_`, preserving
meaning; quotes/parens untouched. Lab-verified: 261-char reply root rendered
as 199 chars + `…`; document named `re[port]<v2>;final.txt` arrived as
`re［port］＜v2＞；final.txt`.

## 1.13.0 — 2026-07-10

### Added — reply / forward / album context in inbound <channel> meta

Joey: "Reply 或 forward 的時候沒有帶有根訊息、檔案和發送者資訊?" — correct on
all three counts. Before: a reply arrived as a bare standalone message (root
message's text and sender lost; only its FILE was smuggled in by
replyAttachment with no marker saying whose it was), a forward looked as if
the forwarder authored it (origin lost entirely), album photos arrived as
unrelated singles, and location/contact messages were dropped with no
handler at all. New meta attributes (sanitized, excerpts capped at 200
chars so payload can't balloon):

- `reply_to_message_id` / `reply_to_user` / `reply_to_user_id` /
  `reply_to_text` — the replied-to root message (text or media-kind label)
- `reply_quote` — the specifically-quoted passage (Bot API TextQuote)
- `attachment_origin="reply"` — attachment/image came from the ROOT message
- `forward_origin` (user|hidden_user|chat|channel) + `forward_from` /
  `forward_from_id` / `forward_from_username` / `forward_date` /
  `forward_channel_message_id` — the ORIGINAL author of a forward
- `media_group_id` — album correlation (same id ⇒ one album)

### Added — animation / location / contact inbound handlers

`message:animation` (registered BEFORE message:document — animation
messages carry a legacy document field that would swallow them),
`message:location` (venue title included), `message:contact`. Previously
location/contact were silently dropped (no gate, no ack, nothing).

All verified end-to-end on the lab bot (payloads read back from the lab
TUI's session transcript): reply-to-own / reply-to-bot / reply-to-document
(+origin marker) / user-forward / channel-forward (Telegram News, original
post id + date) / 2-photo album (same media_group_id, both image_paths) /
location / contact / gif-as-document / true MPEG4 animation / partial-quote
reply.

## 1.12.0 — 2026-07-10

### Fixed — /model & /effort "幾乎都失敗" on claude 2.1.206 (P1)

Root cause (reproduced on lab): a control slash typed while claude is MID-TURN
is not executed — 2.1.206 puts it in the QUEUED MESSAGES buffer ("Press up to
edit queued messages"). When the turn ends the queued command runs and (with
history) opens the "Switch model?" confirm picker — but the old fire-and-forget
25s autoConfirm window was long dead by then, so the picker sat open forever:
session stuck, model unchanged. Production agents are almost always mid-turn ⇒
"幾乎都失敗". Compounding it, `isClaudeBusy()` no longer recognized 2.1.206's
busy markers (footer is `esc to interrupt` without parens; spinner glyph `✶`;
new queued-state marker), so busy TUIs were treated as idle.

Fix: `runTuiSwitchCommand` orchestrator replaces the fire-and-forget path —
waits for idle BEFORE typing (≤10min; dismisses leftover confirm pickers),
types with Ctrl-U draft-clear, Enter-confirms the picker whenever it appears,
and VERIFIES the switch actually took effect. `isClaudeBusy()` updated for
both TUI generations.

### Added — real switch-outcome notification (P4)

The immediate reply no longer claims "✅ 已送" success. It says sent/scheduled,
and a follow-up message reports the VERIFIED outcome: ✅ with evidence
(global settings.json `model` flip — claude persists /model there immediately —
or the TUI's "Set model to …" line), or ⚠️ honest "sent but unconfirmed" with
the pane tail (e.g. invalid model id). Confirmed /model switches also warn
that the value became the machine-wide global default.

### Added — /model picker marks the current model (P3)

Bare `/model` keyboard now shows `✅ <label>（目前）` on the active model plus a
`目前模型: <id>（source）` line. Detection, newest wins: last confirmed switch
(state file) → newest assistant record's `message.model` in the current session
jsonl → global settings.json default (labeled honestly as such).

### Fixed — roamer takeover killed the target tmux & kicked attached humans (P2a)

`/roam` takeover of an existing-but-unbridged tmux did `tmux kill-session`:
the user's session died and any attached client was forcibly disconnected —
iron-rule violation ("never touch attached sessions" — someone ELSE's
session), reproduced on lab with an attached observer. Takeover now uses
`tmux respawn-pane -k`: only the pane process is replaced; the session and
attachments survive, and the relaunched claude joins the bridge with
`--resume` continuity.

### Changed — roamer /restart & /kill_stuck = full target restart with auto reconnect (P2b)

Old /restart killed the target tmux, dropped the bridge, and demanded a
fresh /roam; /kill_stuck's SIGKILL collapsed exec-pane sessions anyway.
Now both do a FULL restart of the roamer-managed target from its persisted
metadata (tmux name / cwd / session_id in the roamer state file): kill +
recreate the SAME-NAMED tmux (per Joey — sometimes tmux itself is the wedged
part, and a dead target must be rebuildable too), relaunch a bridged claude
in the original workspace with `--resume`, auto re-bridge, keep chatting —
the TG side never re-/roams. Recreating the roamer's OWN target is the
feature; the never-kill-attached rule protects other people's sessions
(takeover path above).

### Added — /codexgate command (P5)

`/codexgate` (TG commands can't carry a colon) types
`/codex:setup --enable-review-gate` into the attached claude — channel-bot
and roamer modes both. Same busy-safety as /model (wait-for-idle so it isn't
queued as chat) and a verified follow-up notification (fresh pane-echo
evidence vs a pre-type baseline).

## 1.11.3 — 2026-07-03

### Added — auto-reclaim pre-fix log bloat on daemon start (no manual script)

1.11.1/1.6.4 capped FUTURE growth but a machine that already accumulated a giant
server.log still had to be truncated by hand — which nobody would remember to do.
Now `reclaimBloatedLogsOnStartup()` runs on every daemon start: it rotates an
oversized live log and DELETES any archive far larger than a healthy rotation
(a real archive is <= ~cap; a multi-GB one is pre-fix accumulation). So any machine
just does `git pull` + daemon restart and the disk space comes back automatically.
Verified: planted a 60MB server.log → daemon start → reclaimed to 4KB, no archives.

## 1.11.2 — 2026-07-03

### Fixed — /model (and /effort) control-slash getting stuck / not applying

Two root causes behind "換 model 後不會 enter 導致 agent 卡住" (Joey), both reproduced
+ fixed + verified on the lab bot with a real test account tapping the buttons:

1. **Confirm picker missed when it appears late.** With conversation history, `/model <id>`
   (to a DIFFERENT model) opens a "Switch model? / 1. Yes / 2. No" picker. If claude was
   busy when the command landed, the picker shows up SECONDS later — past the old 3s
   autoConfirm window — so it was never Enter-confirmed and the session sat stuck forever.
   Fix: `autoConfirmYesNoPicker` now polls ~25s, and the caller fires it in the BACKGROUND
   (the "✅ sent" reply is immediate). Verified: claude busy 11s → picker appeared late →
   auto-confirmed → model switched, no stuck.

2. **Input-box pollution.** Control slashes are typed at the cursor; a leftover draft made
   `send-keys "/model X" Enter` submit `<draft>/model X` as a CHAT MESSAGE — command never
   ran, model unchanged. Fix: `clearFirst` sends Ctrl-U to clear the input line before the
   command (own send-keys call — `Escape C-u` merges into an escape sequence and no-ops).
   Verified: draft present → /model → draft cleared, model switched clean, no garbage sent.

## 1.11.1 — 2026-07-03

### Fixed — server.log self-rotation (prevents unbounded growth / disk-fill)

server.log had no size cap and grew unbounded — one host's hit **14GB** and filled
the disk (631MB free). Added in-plugin rename-rotation in `log()`: past 20MB the
current log rotates to `.1`/`.2` (keeps 2 archives), checked every 200 log calls.
Since `appendFileSync` reopens per-call there's no held fd, so plain rename is safe
and the next write re-creates a fresh file. **In the plugin so every machine is
protected** (git pull + daemon restart), not just one host's launchd job.

## 1.11.0 — 2026-07-02

### Added — bare `/model` shows a tap-to-pick inline keyboard

Typing exact model ids from a phone was hostile UX (Joey msg 2434: "我哪知道
準確的代號是什麼"). Bare `/model` (no arg) now replies with an inline keyboard
of model choices; tapping a button runs the existing `/model <id>` send-keys +
auto-confirm path. Manual `/model <id>` unchanged; `/effort` unchanged.

- Default choices: Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5 / Default.
  Override per-daemon via `CHANNEL_BOT_MODEL_CHOICES="Label=value|Label=value"`.
- Callback format `model:<value>` (validated against `[A-Za-z0-9._\[\]-]{1,48}`
  before it can reach tmux send-keys).
- Channel-bot mode only: roamer keeps the usage text (its dynamic tmux target
  can't be routed through the `model:` callback).
- Picker message warns that claude 2.1.198's `/model` persists the choice as the
  machine-wide GLOBAL default (`~/.claude/settings.json` `model` key) — every
  un-pinned agent's next restart inherits it.

## 1.10.0 — 2026-06-22

### Changed — Rich Messages is now ON BY DEFAULT (no env flag needed)

1.9.0 gated Rich Messages behind opt-in `TELEGRAM_RICH_MESSAGES=1`, which meant
every machine had to edit each daemon plist + restart to get it. Unnecessary:
Rich Messages is a server-side Telegram feature and rich sends already fall back
to plain `sendMessage` on any failure, so defaulting it on is safe.

- `reply` / `edit_message` now default to rich markdown with NO configuration —
  other machines just `git pull` and it works; no per-daemon launch-command edits.
- Opt OUT with `TELEGRAM_RICH_MESSAGES=0` (also `off`/`false`/`no`) only if a
  deployment specifically needs the legacy plain/MarkdownV2 path.
- Existing `TELEGRAM_RICH_MESSAGES=1` flags become harmless no-ops (still = on).

## 1.9.0 — 2026-06-22

### Added — native Rich Messages output (opt-in: `TELEGRAM_RICH_MESSAGES=1`)

Telegram Bot API 10.1 (2026-06-11) added Rich Messages, whose `InputRichMessage`
accepts a `markdown` field directly. When enabled, `reply` and `edit_message`
send the caller's text as **normal GFM markdown** (pipe tables, **bold**, `code`,
fenced blocks, links) rendered natively — NO MarkdownV2 escaping, no converter.

- `reply`: unset `format` now defaults to `rich` when the flag is on. Sends via
  raw `sendRichMessage` (grammy 1.41.x doesn't expose it yet). Chunks long text
  on paragraph boundaries (`newline` mode) so pipe tables never split mid-block.
  Inline keyboards (`reply_parameters`/threading) pass through.
- `edit_message`: uses `editMessageText`'s new `rich_message` param for rich
  progress edits.
- `format` enum gains `rich`; `text` forces plain, `markdownv2` keeps legacy.
- **Fallback-safe**: any rich send/edit failure falls back to plain `sendMessage`
  so a message is never lost; the fallback is logged.
- Verified: build + standalone boot + `tools/list` enum + live `sendRichMessage`
  with table & inline keyboard + live `editMessageText` rich edit (all `ok:true`).

## 1.8.0 — 2026-06-12

### Changed — system-alert primary layer is now the official OTel schema (no text matching)

Joey msg 2221: string-matching jsonl text breaks the day Anthropic rewords an
error. Claude Code's documented telemetry (code.claude.com/docs/en/monitoring-usage)
emits structured `claude_code.api_error` / `api_refusal` / `api_retries_exhausted`
events — that is the canonical injection point for these warnings.

- Daemon now hosts an OTLP/HTTP JSON logs receiver at `POST /v1/logs`
  (always 200s; forwards alert events only when `SYSTEM_ALERT_FORWARD=1`).
- Launch the TUI with `CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:<daemon port>/v1/logs`.
  Event identity = structured `event.name` attribute; alert text is built from
  `error` / `status_code` / `model` / `attempt` attributes. 401 adds a
  "run /login" hint derived from status_code, not wording. ~5s latency.
- jsonl tail demoted to FALLBACK (covers TUIs not yet restarted with OTel env);
  both layers share one dedupe map, so double-detection still sends once.
- Verified end-to-end with a real `claude -p` process exporting genuine OTLP
  (forced api_error via bogus model; alert delivered to Telegram DM).

## 1.7.0 — 2026-06-12

### Added — system-alert forwarder (opt-in: `SYSTEM_ALERT_FORWARD=1`)

Forwards claude TUI's own non-AI system warnings to Telegram. Without this,
API-layer deaths render only in the tmux pane and the channel side goes
silent (2026-06-11 trio: 401 login expiry, "API Error: Internal server error"
turn kill, Usage-Policy refusal storm — Joey msg 2218).

- New `system-alert.ts`: tails the newest session jsonl in
  `CHANNEL_BOT_PROJECTS_DIR` (override: `SYSTEM_ALERT_PROJECTS_DIR`) every 20s;
  detects `system/api_error` records, assistant-text `API Error*` /
  `Please run /login`, and `stop_reason: refusal`; DMs every `allowFrom` chat.
- Anti-spam: per-message dedupe (volatile ids stripped) with a 10-min window;
  the next alert after the window carries a suppressed-count. Timestamp gate
  skips records older than watcher start (no replay storms on daemon restart).
- Inert unless the env flag is set — fleet daemons are unaffected until each
  plist opts in.

## 1.6.3 — 2026-06-10

### Fixed — zombie MCP session GC (silent inbound loss)

Inbound notifications were broadcast into dead MCP sessions and silently lost
("the agent talks but doesn't hear"). Root cause: claude-code's MCP client churns
sessions on every reconnect, but a dead SSE GET stream never fires `transport.onclose`
on our side, so dead sessions accumulate without bound (observed 25/2269/78 opens, 0
closes) and the inbound broadcast queues into a zombie's dead in-memory queue forever.

- **Broadcast** now evicts any session that has had no open SSE past a grace window
  (`SESSION_GRACE_MS`, 120s) instead of queuing inbound into it.
- **GC timer** (every 30s) reaps zombie sessions independently of `transport.onclose`,
  tracking per-session `sessionLastActiveAt` (set on session create, SSE open, and each
  successful keepalive write).
- **Keepalive** hardened with a back-pressure check (`writableLength` threshold) to catch
  half-dead sockets whose buffered writes "succeed" but never reach the peer.
- **`/healthz`** now reports `sessions_with_open_sse` and `max_queue_depth` for fast diagnosis.

Same fix applied to `discord-http`. Verified on the lab bot: a never-opened-SSE session
is reaped after grace, a live open-SSE session is spared, and inbound delivery to the live
session is unaffected. See GitHub issue #3.

## 1.6.0 — 2026-05-25

### Added — `/input` raw passthrough slash command

`/input <text>` sends `<text>` as keystrokes into the channel-bot's tmux session
(or, in roamer mode, the current target's session) with `Enter` at the end.

**Why.** Some claude TUI slash commands (`/plugin marketplace add`, `/plugin install`,
arbitrary multi-step setup) need to be typed at the TUI directly — but the existing
channel-bot control plane intercepts known slashes (`/clear`, `/restart`, ...) before
they reach the TUI. `/input` is the explicit "type this literally, do not interpret"
escape hatch. Saves Joey from having to walk to the Mac mini to type setup commands.

**Multi-line semantics.** Each newline-separated line in the payload is sent as its
own `tmux send-keys ... Enter` call. Example:

```
/input /plugin marketplace add anthropics/skills
/plugin install document-skills@anthropic-agent-skills
```

→ Two lines typed into the TUI, each with Enter, as if Joey had typed them at the
Mac mini's keyboard.

**Precedence.** `/input` is checked *first* in `forwardSharedTuiSlash`, before
the existing verbatim-send and ctrl-key branches. This makes `/input /clear`
type a literal `/clear` instead of being captured by the channel-bot's `/clear`
handler.

**Files touched.**
- `channel-bot-control.ts` — added `forwardInputPassthrough()` + wired into
  `forwardSharedTuiSlash`. `sharedTuiCommands()` and `controlCommandsForBotApi()`
  now include `/input` for help text + Telegram autocomplete.

**Joey 2026-05-25 (msg 1596)**: "打了後面就可以空一個繞過 tg 直接送 tmux 輸入" — exactly this.

### Sync

discord-http v1.6.0 ships the same `/input` command. KEEP IN SYNC.

## 1.5.1 — 2026-05-25

### Changed — picker driver: regex busy-detection → proactive interrupt

Replaced `isClaudeBusy()` pre-flight check in `resumePickerInlineSwitch` with unconditional Escape + Ctrl-C before driving the picker.

**Why.** Regex-based pane-text busy-detection was fragile:
- claude TUI's completion-marker format `✻ Crunched for X` (past-tense) was historical / "turn finished" content but my regex matched it as if claude was still active. Result: 20s busy-poll timeout on `/resume_list` button clicks even when claude had been idle for an hour.
- claude TUI strings shift between versions / locales — any regex over them ages fast.
- User intent matters: clicking a `/resume` button is an explicit "switch now" signal. Any mid-turn response is acceptable collateral.

**How.** `resumePickerInlineSwitch` now:
1. Escape (dismiss any open picker/dialog overlay)
2. Wait 200ms
3. Ctrl-C (interrupt any active turn / streaming response)
4. Wait 600ms (let claude TUI process the cancellation cleanly)
5. Drive picker as before (send `/resume` → Down × N → Enter)

`isClaudeBusy()` still exists for other call-sites that may want it, but the regex was narrowed to active-only indicators (`(esc to interrupt)`, `[✻✢] <verb>ing`, `Calling .*plugin`) — no more `\w+ed for` past-tense matches.

**Joey 2026-05-25 (msg 1572)**: "他們會常常改字吧？為何不就把它打斷就好了？" — exactly the right call.

### Sync

- discord-http 1.5.1 ships identical change.

## 1.5.0 — 2026-05-25

### Added — Roamer parity with channel-bot + auto-discovery + history-aware takeover

This release closes the feature gap between channel-bot mode and roamer mode: any command that worked on `@Sonn_Claude_bot` now works on roamer bots against the dynamically-selected target. Also adds cross-protocol coordination so TG and DC roamer bots can coexist without manual wiring.

#### `channel-bot-control.ts` — shared TUI slash forwarder

- New exported function `forwardSharedTuiSlash(text, tmuxName, replyTo)` — single source of truth for "send-keys to claude" commands across BOTH channel-bot and roamer modes. Channel-bot's `handleControlSlash` now delegates to it instead of keeping its own list.
- New exported constants:
  - `SHARED_TUI_SENDABLE` = `{/clear, /agents, /mcp, /resume, /help, /init, /compact}`
  - `SHARED_TUI_SENDABLE_WITH_ARG` = `{/model, /effort}`
  - `SHARED_TUI_CTRL_KEY` = `{/sigint: 'C-c', /cancel: 'C-c'}`
- Adding a new TUI-forward command requires updating ONE place (these constants).

#### `channel-bot-control.ts` — context-aware high-level helpers

These were previously hardcoded to `CHANNEL_BOT_*` env vars; now accept optional override parameters so roamer can pass its `current_target` context:

- `listClaudeSessions(limit?, projectsDirOverride?)` — now exported, accepts dir override
- `currentSessionId(projectsDirOverride?)` — now exported, accepts dir override
- `resumePickerInlineSwitch(pickerIdx, tmuxOverride?)` — now exported, accepts tmux override
- `loadResumeChain(fileOverride?)` — exported, accepts file override
- `saveResumeChain(chain, fileOverride?)` — exported, accepts file override
- `formatResumeReply(opts)` — exported
- Type exports: `ClaudeSession`, `ResumeChain`
- Low-level helpers (`tmuxSendKeys`, `tmuxSendCtrlKey`, `tmuxCapturePane`, `isPickerOpen`, `isClaudeBusy`) now accept optional `tmuxName` param; default still env-based for backwards compat.

#### `roamer-control.ts` — channel-bot command parity

New `handleChannelBotCommandsForCurrentTarget` dispatcher inside `handleRoamerSlash` (calls the now-exported helpers with `current_target.tmux` / `current_target.cwd`'s project folder / per-bot resume-chain file). Supports:

- `/resume_list /sessions /list` — list current target's project sessions with inline keyboard buttons
- `/resume <n|prefix>` — drive current target's TUI picker
- `/resume_previous` — walk-back chain (per-bot resume-chain file `/tmp/roamer-<bot>-resume-chain-<cwd-slug>.json`)
- `/restart` — kill current target tmux + clear state (forces re-/roam to re-bridge)
- `/kill_stuck` / `/kill-stuck` — SIGKILL current target's claude PID

`handleRoamerCallback` extended to dispatch `resume:` prefix callbacks (clicking buttons from /resume_list in roamer mode drives the current target's picker).

#### Cross-protocol auto-discovery

- New shared registry `~/.claude/channels/roamer-daemons.json` — every roamer daemon self-registers on boot, unregisters on shutdown. Entry: `{protocol, bot, port, pid, registered_at}`.
- New exports `registerSelfAsDaemon()` / `unregisterSelfAsDaemon()` wired into server.ts boot/exit.
- Takeover spawn auto-picks a live partner-protocol daemon via deterministic order (lowest port). When a TG roamer takes over, the spawned claude is loaded with BOTH `--channels` flags (its own TG roamer + the discovered DC roamer) so the same claude is reachable from either side.
- Fallback to single-`--channels` if no partner protocol daemon alive. Zero per-plist pairing wiring required.

#### Cross-protocol independence in registry filter

- `RoamerRegistryEntry` now carries `protocol: 'telegram' | 'discord'`.
- `listRoamableSessions` only filters out claims from OTHER bots of the SAME protocol. Cross-protocol claims are visible and selectable (a TG roamer's list shows sessions claimed by DC roamers, and vice versa).

#### History-aware takeover

- `findLatestNonEmptySessionForCwd(cwd)` scans the project folder for the latest non-empty jsonl. Used as the `--resume <sid>` target when the live claude's session is empty (fresh screen-spawn with no turns).
- Previous behavior took over the LIVE PID's session-id (which could be empty) and started fresh; new behavior prefers continuity with the user's real prior conversation in that project.
- Notification varies:
  - 📜 接回 live session ...
  - 📜 live session 是空的，自動接回 project 最近有歷史的 session ...
  - 📭 該 project 沒任何歷史 session，開新 claude (fresh) ...

#### server.ts integration delta

- Callback handler unifies `resume:` + `roam:` dispatch — in roamer mode, both go through `handleRoamerCallback`; in channel-bot mode, `resume:` goes through `handleCallbackData`.
- `handleControlSlash` now delegates `/clear /agents /mcp /resume /help /init /compact /model /effort /sigint /cancel` to `forwardSharedTuiSlash` instead of its own dispatch.

### Sync

- discord-http 1.5.0 ships identical changes (mirror).

### Migration notes

- No breaking changes for channel-bot deployments. Existing `@Sonn_Claude_bot` env-based config keeps working — all overrides are optional parameters with env fallback.
- New roamer deployments inherit auto-discovery automatically (just spawn the daemon, no manual port wiring).

## 1.4.0 — 2026-05-25

### Added — Roamer mode (claude session 漫遊)

Lets a TG bot remote-control any local naked claude session on the machine. User picks via inline keyboard, daemon respawns the target claude with `--channels` so it joins the plugin's existing MCP bridge, then TG inbound routes to that specific claude (not broadcast).

- **New file**: `roamer-control.ts` — all roamer-specific logic in one module, gated by `ROAMER_MODE=1` env. When unset, every export is a no-op (zero impact on channel-bot deployments).
- **Discovery**: `listRoamableSessions()` wraps `claude agents --json`, filters out cc-workspaces / channel-bot / agy-workspaces / agy-tg-bridges, computes tmux membership for each PID via parent-chain walk + `tmux list-panes`.
- **Takeover**: SIGINT naked claude (or kill existing non-bridged tmux) → spawn new tmux running `claude --channels plugin:telegram-http@crab-labs-plugins --resume <sid>` (drops `--resume` if session has no transcript). `TELEGRAM_HTTP_PORT` env is interpolated into the plugin's `.mcp.json` URL so the new claude connects to the same roamer daemon.
- **MCP session ↔ tmux mapping**: takeover sets `pendingTakeoverTmux`. When server.ts's `onsessioninitialized` fires for a new MCP session, it calls `roamerOnNewMcpSession(id)` which claims it for the pending takeover. `tmuxToMcpSession` map is built up over time. `roamerOnMcpSessionClosed(id)` cleans up on disconnect.
- **Routing**: in `handleInbound`, when `isRoamerEnabled()`, replaces `broadcastNotification` with `sendToMcpSession(currentTargetMcpSessionId, notif)` — TG inbound goes ONLY to the currently-selected target's claude, not all bridged claudes.
- **Multi-roamer coordination**: shared registry at `~/.claude/channels/roamer-registry.json` keyed by bot username. Each entry: `{tmux, claude_pid, daemon_pid, session_id, cwd, updated_at}`. Read-time activeness check via `kill -0 <pid>` × 2 + `tmux has-session`. Stale entries auto-purged. Listings exclude sessions claimed by OTHER live roamers.
- **Per-instance state**: `roamer-state.json` in `TELEGRAM_STATE_DIR` holds `{current_target: {tmux, claude_pid, session_id, cwd} | null}`.
- **Slash commands**: `/roam` (list w/ inline buttons), `/roam_status` (show current target + registry).
- **Callback handler**: `roam:<8-char-sid-prefix>` button data routes through `handleRoamerCallback` → `connectToSession`.

### server.ts integration points

- Imports from `roamer-control.ts`: `isRoamerEnabled`, `handleRoamerSlash`, `handleRoamerCallback`, `roamerCommandsForBotApi`, `onNewMcpSession`, `onMcpSessionClosed`, `getCurrentTargetMcpSessionId`.
- `handleInbound`: roamer slash dispatcher BEFORE existing `handleControlSlash`; non-slash text routes via `sendToMcpSession` when roamer enabled.
- `bot.on('callback_query:data')`: new `roam:` prefix handler alongside `resume:` (channel-bot) and `perm:` (permission relay).
- `onsessioninitialized`: calls `roamerOnNewMcpSession(id)` (no-op if roamer disabled).
- `transport.onclose`: calls `roamerOnMcpSessionClosed(sessionId)`.
- `pollLoop` `onStart`: merges `roamerCommandsForBotApi()` into TG bot autocomplete.
- New helper `sendToMcpSession(sessionId, notif)` — point-to-point variant of `broadcastNotification`; queues in `memQueue` if SSE not yet open.

### Decision-log (kept short)

Initial impl (rejected) used tmux send-keys + capture-pane + jsonl tailing for routing — duplicated work the plugin's MCP layer already handles, fragile, and broke on tool-using turns. Final impl uses the plugin's native MCP notification + reply tool pipeline; routing is just point-to-point send instead of broadcast. See agent memory `feedback_decision_logic_failure_patterns.md` for the meta-lessons.

### Required env (roamer instance)

- `ROAMER_MODE=1`
- `ROAMER_BOT_NAME=<botname>` (matches `@<botname>_bot` on Telegram)
- `ROAMER_STATE_FILE=<path>` (per-instance, holds current_target)
- `TELEGRAM_HTTP_PORT=<port>`, `TELEGRAM_STATE_DIR=<path>` (standard plugin env)

### Not affected

Channel-bot mode (existing `@Sonn_Claude_bot` daemon): `ROAMER_MODE` unset → entire roamer module is no-op → routing falls through to existing `broadcastNotification`. Zero behavioral change.

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
