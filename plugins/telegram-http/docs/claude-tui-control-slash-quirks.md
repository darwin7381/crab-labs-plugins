# Claude TUI control-slash forwarding — quirks & gotchas

Channel-bot mode forwards a few slash commands (`/model`, `/effort`, `/clear`, `/agents`, …)
into the claude TUI's tmux session via `tmux send-keys`. Driving a live TUI blind (no
human at the keyboard) hits several non-obvious behaviors. Each item below was reproduced
empirically on the lab bot (2026-07-03) while fixing Joey's "換 model 後卡住" report.
Read this before touching `tmuxSendKeys` / `autoConfirmYesNoPicker` / `forwardSharedTuiSlash`.

## 1. Input-box pollution — clear the draft first (Ctrl-U)

A control slash is typed **at the cursor**. If the user left an unsent draft in the TUI
input box, `send-keys "/model X" Enter` produces `<draft>/model X` and Enter submits the
**whole line as a CHAT MESSAGE** — the slash command never runs, the model doesn't change,
and to the user it looks stuck.

Fix: send `C-u` (clear-to-start) on its own `send-keys` call *before* typing the command
(`tmuxSendKeys(..., clearFirst=true)`). Verified: draft present → `/model` → draft cleared,
model switched cleanly, claude received no garbage.

## 2. `Escape C-u` in one send-keys call is an escape SEQUENCE, not two keys

The obvious "clear the line" is `Escape` then `Ctrl-U`. **Do not** put them in one call:
`tmux send-keys -t s Escape C-u` — the terminal reads `ESC` immediately followed by another
key as a single **escape sequence** (meta/alt), so the clear silently no-ops. (This was our
first, failed fix.) Send `C-u` **alone**. Also avoid a leading `Escape` entirely: at the
prompt it's unnecessary, and mid-turn `Escape` **interrupts** claude's running response.

## 3. The confirm picker appears LATE when claude is busy — poll long, in the background

With conversation history, `/model <id>` to a **different** model opens a
`Switch model? / ❯ 1. Yes / 2. No, go back` picker (and `/effort` similarly). Default cursor
is on Yes, so a bare `Enter` confirms it. Two traps:

- **Fresh conversation / same model → NO picker** (it just sets directly). So a smoke test on
  a brand-new TUI "passes" while real use with history sticks. Always test with history.
- **If claude was busy when the command landed, the picker shows up SECONDS later** (after the
  in-flight turn finishes). A short auto-confirm window (we had 3s) misses it → never
  confirmed → stuck forever. `autoConfirmYesNoPicker` polls ~25s. The caller must run it in
  the **background** (`void autoConfirmYesNoPicker(...)`) so the user's "✅ sent" reply is
  immediate — otherwise the no-picker path stalls the reply for the whole window.

## 4. `tmux capture-pane -p` is unreliable for claude's alt-screen TUI

Picker/overlay detection reads the pane via `capture-pane`. It sometimes returns the
underlying buffer (stale scrollback) rather than the live overlay, and occasionally blank.
Detection (`isYesNoConfirmPickerOpen`) is therefore best-effort — which is *why* #3 pairs a
generous poll window with a default-cursor-on-Yes assumption rather than trusting a single
capture. Never gate a destructive/irreversible keystroke on one capture-pane read.

## 5. `/input` must stay verbatim

`clearFirst` is opt-in and used only for the known control slashes. `/input` raw passthrough
must NOT clear or alter the payload — it exists to type arbitrary keystrokes verbatim.

## 6. (2.1.206) A slash typed MID-TURN is queued as a CHAT message, not executed

Claude 2.1.206 puts input typed during an active turn into the queued-messages buffer
(`Press up to edit queued messages`). The command executes only when the turn ends — and
if it then opens the confirm picker, any short fire-and-forget confirm window is long dead
⇒ picker stuck forever. This was the root cause of "換 model 幾乎都失敗" (production agents
are almost always mid-turn). Since 1.12.0 `runTuiSwitchCommand` therefore waits for IDLE
before typing, and keeps watching (extending the window while the queued-marker is visible)
until it can verify the outcome.

## 7. (2.1.206) Busy markers changed — keep `isClaudeBusy()` in sync

The footer is now `esc to interrupt` WITHOUT parens, spinner glyphs rotate through more
characters (`✶ ✳ ✻ ✢ …`), and the queued-state marker (`Press up to edit queued messages`)
is itself a busy signal. The old paren-only regex judged a mid-turn 2.1.206 TUI "idle".
New TUI versions keep adding spinner glyphs — when busy-detection misbehaves, capture a
live busy pane first and diff the markers.

## 8. Verify success against a PRE-TYPE baseline — stale scrollback false-confirms

The pane may still show an IDENTICAL old command echo + its old `Set model to …` result
from a previous switch. Anchoring on "the last occurrence of the command string" confirmed
a switch that had not happened (bitten in lab 2026-07-10). Rules: count `Set model/effort`
occurrences BEFORE typing and only accept an INCREASE as pane evidence; for `/model <id>`
prefer the filesystem signal (`~/.claude/settings.json` `model` flips the moment the switch
applies — claude persists the choice globally).
