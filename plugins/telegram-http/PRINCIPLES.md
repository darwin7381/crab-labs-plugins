# telegram-http — design principles (read before adding a feature)

> Recorded 2026-07-13 after a recurring miss: fixing a plugin-domain problem
> with machine-level env / boot plists / wrapper scripts *outside* the plugin.

## 1. Capabilities live IN the plugin, never scattered outside it

If a behaviour is part of what this plugin *does* — driving the TUI, watching
the pane, surfacing state to Telegram, handling a picker, recovering a stuck
session — it MUST be implemented inside the plugin's own code (server.ts /
`*-control.ts` / sibling modules), NOT as:

- a machine-level env var (`launchctl setenv …`) or a boot LaunchAgent,
- a one-off shell tweak in the per-agent wrapper script,
- a manual step the user repeats on each machine.

**Why:** every user on every machine installs the same plugin. A fix that lives
outside it (env, wrapper, boot plist) does NOT ship with the plugin — it works
on the one machine you touched and silently leaves every other user broken. The
plugin is the single distribution unit; the fix has to travel inside it.

**Litmus test before writing a fix:** "If another user installs this plugin
fresh on a clean machine, do they get this behaviour automatically?" If the
answer needs a manual env/plist/wrapper edit, you're solving it in the wrong
place — move it into the plugin.

**External state that legitimately stays outside:** genuinely per-deployment
*configuration* (bot token, chat ids, ports, tmux session name) — data the
operator supplies, not behaviour the plugin performs. Behaviour ≠ config.

### Worked example (the fix that prompted this)

Claude's large-session resume picker wedged keyboard-less daemon-launched
agents at restart. First attempt: suppress it with a machine-level env var +
boot plist — *outside* the plugin, so it only helped the one machine and gave
the user no choice. Correct fix: `startup-picker.ts` inside the plugin —
detect the picker on the pane, surface its real options to Telegram as inline
buttons, drive the chosen keystroke. Ships with the plugin, works for every
user, lets them choose. A temporary env stopgap is fine as a *safety net while
the real in-plugin fix is being built*, but it is removed once the plugin
handles it.

## 2. Keyboard-less daemon launches must never block on an interactive prompt

Daemon-launched claude (channel-bot / roamer) has no keyboard. Any TUI prompt
that can appear at startup or mid-run (model/effort confirm, resume picker,
trust prompt, login) must be either driven automatically or surfaced to
Telegram for the user to answer — never left to silently wedge. This is the
same reason `--disallowedTools AskUserQuestion ExitPlanMode` is mandatory.

## 3. Shared features must not assume a fixed session — thread the target, verify in roam

The plugin runs in TWO modes: **channel-bot** (one fixed session, env
`CHANNEL_BOT_TMUX_SESSION` → `TMUX_SESSION`) and **roamer** (no fixed session;
the target moves per `/roam`, its tmux is `current_target.tmux`). Any feature
that is meant to work in BOTH must be written target-agnostic:

- **Never gate a shared feature on `isControlEnabled()` or `tmuxName === TMUX_SESSION`.**
  `isControlEnabled()` is literally `TMUX_SESSION !== ''` — **always false in
  roamer mode**. Gating a shared behaviour on it silently kills it for every
  roamer while looking fine on channel-bot. Gate on the actual thing you need
  (e.g. "is there a target session?" → `tmuxName !== ''`), not on the mode.
- **Thread the explicit `tmuxName` through the whole call chain.** The tmux
  helpers default their arg to `TMUX_SESSION` (`tmuxSendKeys`, `isClaudeBusy`,
  `isPickerOpen`, `isYesNoConfirmPickerOpen`, `tmuxCapturePane`, …). A single
  call that forgets to pass the roamer's target defaults to the empty fixed
  session and drives the wrong (or no) pane. Pass the target everywhere.
- **Don't key shared state on `TMUX_SESSION`.** For roamers it's `''`, so a
  file like `…-${TMUX_SESSION || 'default'}.json` becomes ONE record shared
  across every roam target → cross-target contamination (e.g. target A's model
  switch mislabels target B's "current model"). Key per-target instead.

**Verification rule:** a fix that claims to support roam is NOT done until it
has been exercised **in roam mode**. #7 ("roamer bare /model gets the picker")
and #8 shipped *broken in roam for weeks* because they were only ever checked on
the fixed channel-bot session — the `isControlEnabled()` guard meant the picker
never actually reached a roamer. "Builds + works on channel-bot" ≠ "works in
roam." Test the roamer path, or it isn't fixed.
