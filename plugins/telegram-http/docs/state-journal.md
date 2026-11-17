# The lanes state journal, and the hooks a slot must carry

Lanes mode (`GENESIS_LANES=1`) runs on five mechanisms with explicit state. One writer keeps all of it: the tg daemon (telegram-http, not
the agent-inbox daemon). Every other component asks the tg daemon.

| | mechanism | record | moved by |
|---|---|---|---|
| M1 | delivery ledger | one `msg` per item for the main | the main's hook events |
| M2 | main record | one `main` per main process (gen = pid) | the main's hook events, plus one `kill -0` |
| M3 | event record with obligations | one `event` per inbound event | the router, the lane's own tool calls, the run's exit |
| M4 | wake rule | `wake` lines, which log decisions and are not folded | M2 phase × what M3 owes the main |
| M5 | run record | one `run` per lane run | the lane process: spawn, its result JSON, its exit code |

No mechanism reads a transcript to learn a state.

## The file

`<STATE_DIR>/lanes/state.jsonl`. `STATE_DIR` is the tg daemon's state directory (`TELEGRAM_STATE_DIR`, by default
`~/.claude/channels/telegram`). In tests that do not pass one, it is `<lanes dir>/lanes/state.jsonl`.

- **Append-only.** Each transition is one line:

  ```
  {"ts": "<ISO-8601 with ms>", "rec": "msg|main|event|run|wake", "id": "<id>", "state": "<new state>", ...fields}
  ```

- **The journal is the state.** At boot the daemon folds the file and goes on from there.
  - A record's current value is the merge of its lines in file order: a later field replaces an earlier one, and a field written as `null` is cleared.
  - The fold also counts each record's lines: `version` (1 for a new record, +1 per line). It is not written in the lines; `GET /lanes/state` serves it.
    "Changed since" compares versions, never timestamps (two lines can share a millisecond).
  - Folding never offers anything. Items left `queued` are offered when M1 next finds an idle gen. Items left `offered` or `bound` stay with the gen they
    belonged to; if that process is gone, `kill -0` ends the gen and puts them back to `queued`. So a daemon restart re-offers each queued item exactly once.
- **`GET /lanes/state`** on the tg daemon's HTTP port (loopback token, like every `/lanes/` route) serves the folded state:
  `{current_gen, wall, msg: [...], main: [...], event: [...], run: [...]}`. Each record has its fields plus `created` (the ts of its first line) and `version`.

### `msg` (M1): one item for the main

| state | meaning |
|---|---|
| `queued` | waiting for an idle gen, or for the busy gen's next tool boundary or Stop |
| `offered` | written into the gen's MCP stream; it opens that gen's next turn |
| `bound` | inside turn `prompt_id` of gen `gen` |
| `done` | that turn ended with `Stop` |

The one rule: an item is `done` only when its turn ends with `Stop`. `StopFailure`, an interrupted turn, or the end of the gen put it back to `queued`.

How items move:
- **Offer.** An idle gen is offered one notification: the oldest queued item that is owed to the main, with the digest riding on it.
  An offer is written only into a stream that can take it: the gen's MCP GET stream is open and the SDK transport holds it (server.ts `streamLive`;
  the SDK drops a notification without an error when it has no GET stream). If no such stream exists, the item stays `queued` and nothing is
  offered; the next pump (the stream opening, a Stop, the 5-second tick) tries again. An item is offered to a gen once: an offer is never written again.
- **Bind.** At the first hook event with a new `prompt_id`, the daemon binds to that turn every item offered to this gen, plus any queued item the
  prompt names (`did="..."`).
- **Pull.** A busy gen is never offered anything. At its next PostToolUse, or at its Stop, every queued item is bound to the running prompt and
  handed over in the hook's output.

Fields:
- `kind`: `joey`, `peer`, `alert`, `digest`, `handoff` or `carry`.
  - `carry` is a note for the main: a `/main renew` brief, which has `target` = the new session id, or a fan-out synthesis.
  - `digest` is information. It is never offered alone; it rides the next offer or pull.
- `via`: `tg` or `inbox`, the daemon whose MCP stream carries the offer.
- `event`: the inbound event id, when there is one.
- `notif`: the channel notification (`method`, `params.content`, `params.meta`). `meta.did` is the item id. An offer that carries the digest has
  `meta.did = "<item id>,<digest id>"`.
- `gen` and `prompt_id`, while `offered` or `bound`. `via_pull: true` means the item was pulled at a tool boundary or at `Stop`.
- `reason`, when the item returns to `queued`: `stop_failure:<error>`, `gen_end`, `interrupted` (a new prompt came with no Stop), `session_start`
  (the same process started a new session mid-turn).
- `done` may carry `reason: asked_restart` (special case 1 below).
- Digest items also have `events` and `items`:
  - `events`: `{<event id>: <version>}`, the event records the digest shows, each at the `version` it was rendered from;
  - `items`: how many entries the digest lists (event lines plus the standing lines: open Joey memory proposals and peer holds).

### `main` (M2): one record per main process

`id` = the gen = the pid, as text.

| state | meaning |
|---|---|
| `starting` | `SessionStart` accepted; the tg daemon has no open MCP stream of this process yet (the main moves to `idle` when the SDK holds its GET stream) |
| `idle` | can be offered one item |
| `in_turn` | inside a turn: `prompt_id`; `tool_open` is set between PreToolUse and PostToolUse |
| `walled` | the account's model wall is up: `kind` is the StopFailure error (`rate_limit`, `server_error`, ...), or the kind of the lane wall |
| `gone` | `end_reason`: `asked` (/restart, /kill_stuck), `killed` (`kill -0` failed), `exited` (SessionEnd), or `replaced` (another process took the role, or /main renew) |

Other fields: `pid`, `session_id`, `transcript_path` (recorded, never read for state), `source`, `error`.

### `event` (M3): one record per inbound event

The router opens the record when it gives an event to a lane, or to the main.

| state | meaning |
|---|---|
| `open` | something is still owed: an obligation is `open`, or a `main` obligation is not met |
| `closed` | every obligation is `met` |

Fields:
- `class`: `scheduled`, `followup`, `peer`, `joey`, `alert` or `critical`. The router writes it from the routing rule's trigger, or the follow-up
  scheduler does. No hook parses prompt text for it.
- `owner`: the lane id, or `main`.
- `outcome`: `normal`, `changed` or `failed`. It is the worst outcome any call reported (a structured field of `notify_joey`, `ask_joey` and `receipt`).
- `tool`: the call that changed the record. `refused`: the reason, when that call was refused.
- `thread`, `lane`, `from`, `text` (the first 300 characters).
- `obligations`: `[{id, kind, level, state, by, owner, due_at, ...}]`, where `state` is `open`, `met` or `handed`.

| kind | levels | met by |
|---|---|---|
| `joey` | `line` < `decision` | `notify_joey` (a line), `ask_joey` (a decision; raising a met line is accepted). A critical alert's line has `ring` and `due_at`: when the due sweep rings, it sets `rang`. |
| `peer` | `answer`, `interim`, `commitment` | `reply_agent` to that peer. `interim` is met by the router when a lane hands the request to the main; a new `answer` then opens with `owner: main` and a `due_at`. `commitment` is the main's own commitment tool, met by `commitment_done`. |
| `receipt` | `run` (`run_id`) | `receipt(run_id)`, once per scheduler run across every event |
| `main` | `handed` (`handoff`, `item`, `due_at`, `cls`, `what`) | the M1 item that carries it reaching `done` |

The one rule: a lane's outbound call asks to meet an obligation of its event.
- Meeting an open one is accepted. Raising one (line → decision) is accepted.
- Repeating a met one is refused, and the refusal names what is still open.
- Handing an event to the main moves its open `joey` and `peer` obligations to `handed`.

**The lane stop.** The lane's Stop hook (lanes-hooks/lane-stop-hook.py) posts to `POST /lane-stop` with its run token (`LANE_RUN_TOKEN`; the port
is `LANES_HTTP_PORT`, set by the daemon in the lane's environment). The daemon blocks once with the open obligations, or lets the run end.

**The exit rule.** When a run ends, at whatever reason, its open obligations become one `main` obligation, plus one M1 item.

**The due sweep** runs every second. It acts on open obligations past `due_at`:
- a critical line: the router rings once (`rang`);
- a hand-over, a promised answer, a commitment: Joey is told once (`told`).

A `main` obligation is due 300 s after the hand-over (`LANES_HANDOFF_FALLBACK_MS`), or at once when the main has been away (gone or walled) for
60 s (`LANES_HANDOFF_DOWN_GRACE_MS`).

### `wake` (M4): a decision, logged

`id` is an item id or an event id. `state` is `wake` (M1 offers the item: the main was idle and something is owed to it) or `no_wake`. `reason` says
which: information, the main in a turn (the item is pulled at its next boundary), the main walled or gone, or the event owes nothing.

### `run` (M5): one record per lane run

| state | meaning |
|---|---|
| `queued` | waiting for a slot. Fields: `ev` (the event, without its channel payload), `priority`, `summary`, `enqueued`, `extra` (messages riding in it), `deaths`, `not_before` (the backoff after a death) |
| `leased` | picked: `run` (the lane run id, e.g. `adam.reflex.3.r2`) |
| `running` | spawned: `pid` |
| `exited` | `reason`, `exit_code`, `signal` |

Every line also has `event`, `lane` and `attempt`.

`reason` is one of:
- `normal`, `cap_turns`, `cap_usd`, `budget`, `wall:<kind>`, `died`, `timeout`: how the run ended;
- `merged` (coalesced into another run), `dropped` (its thread was stopped) or `closed` (its lane was closed): a queued run that never started.

How the reason is decided (exitReason):
- From the result JSON: `terminal_reason` `max_turns` / `subtype` `error_max_turns` is `cap_turns`; `error_max_budget_usd` is `cap_usd`;
  `is_error` with `terminal_reason: api_error` gives `wall:<kind>`, where the kind comes from `api_error_status`: 429 is `rate_limit`, 401/403 is
  `authentication_failed`, 5xx is `server_error`, anything else is `api_error`.
- From the daemon's own decisions: `timeout` (it stopped the run at `LANES_MAX_RUN_MS`) and `budget` (it stopped the run at the thread budget).
- Otherwise from the exit code: exit 0 with no signal is `normal`, anything else is `died`.
- Never from the error text.

What happens next:
- A wall is not an attempt: the event is queued again as it was, and the shared wall goes up.
- A death or a timeout is run again after `attempt × LANES_RETRY_BACKOFF_MS`, while the event still owes something. After 3 attempts, the exit
  rule hands what is open to the main.
- At boot, a run left `leased` or `running` died with the daemon. It gets `exited(died, signal daemon-restart)`, its lanes.jsonl exit row and a
  lane_lifecycle ledger line, and its event runs again.

**Busy** is "the lane has a queued, leased or running record" (`laneBusy`). The journal is the queue: there are no queue files.

## The digest: a renderer over M3

The digest is information that rides an M1 offer or pull. It is never offered alone.
- One line per event record whose `version` is past what the digests showed: `.lanes/digest.json` `{seen: {<event id>: <version>}}`, merged from a
  digest item's `events` when it reaches `done`, and the `events` of a digest item still `offered` or `bound`.
- At most 8 lines, in this order: owed to the main (`需主線`), waiting on Joey's decision, the rest. The overflow is named on one line.
- An open Joey memory proposal and an active peer hold are lines of every digest while they last.

## The main's hook

One script handles every event: `lanes-hooks/main-hook.py`. It replaces session-start-hook.py and main-midturn-hook.py, and it is the only Stop hook
the main needs: it calls main-memory-gate.py and main-answered-gate.py itself.

The main session's settings must carry:

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "PreToolUse":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 30 }] }],
    "StopFailure":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "SessionEnd":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 2 }] }]
  }
}
```

The model aids keep their own registrations:
- main-summary-gate.py: PreToolUse on the Telegram `reply` tool.
- memory-commit-hook.py: PostToolUse on Write and Edit.

Do not register main-answered-gate.py or main-memory-gate.py as hooks of their own. main-hook.py runs them at Stop, after it has asked the daemon
to pull. That way a Stop that some aid holds is never counted as the end of the turn.

Environment the hook needs. The keeper already sets these for the main:
- `TELEGRAM_HTTP_PORT`: the tg daemon's port.
- `MCP_TOKEN_DIR`: where the loopback token is, if it is not `~/.claude/agent-inbox/mcp-tokens`.
- `CLAUDE_PID`: set by Claude Code itself. Without it, the daemon identifies the caller of `SessionStart` by its socket.

What the hook sends to `POST /lanes/main-event`:
- always: `{event, session_id, prompt_id, pid, transcript_path, source, tool_name, error}`;
- UserPromptSubmit: `dids`, the `did="..."` values in the prompt;
- PostToolUse of `reply` or `send_to_agent`: `tool_input` (`to`, `reply_to`, `text`);
- StopFailure: `reason`, which is `last_assistant_message`;
- Stop: `phase: "check"` first, then `phase: "final"` when nothing holds the turn.

What the hook prints, from the daemon's answer:
- SessionStart: `additionalContext`. That is the main-only rules for the accepted main, or "you are not the main".
- PostToolUse: `additionalContext` with the items pulled into this turn.
- Stop: `decision: block` with the items pulled, or with an aid's reason.

How the main is registered:
- A `SessionStart` is accepted when its session id is `.lanes/main-expected` (written by the keeper), or the new session of a `/main renew`, or when it
  comes from the process of the live gen (`/clear`, `/compact`).
- Any other SessionStart is refused. Joey is told once, and that process's MCP sessions lose the Telegram tools.

## Lanes

The daemon writes the lane settings into `.lanes/lane-settings.json`. The lane Stop hook is lane-stop-hook.py. A slot carries nothing for lanes.

## Special cases kept (marked `SPECIAL CASE` in the code)

1. **An asked restart** (`/restart`, `/kill_stuck`): the items of the cut turn end `done` with `reason: asked_restart`, and Joey gets one line. They are
   not re-given. This is the owner's decision (002j, 5018d39), kept as data.

2. **The TUI relay's wall line** (`wallKind`). The relay (system-alert.ts, fleet code that stays) forwards the CLI's own error line from the
   main's pane or transcript. Deferring it to the one wall notice (002l D12) means recognising that line; no signal carries it. This is
   wallKind's only use: a lane's wall kind comes from its result status, the main's from StopFailure.

## Stuck (疑似卡死)

This is M2 only. The tg daemon checks every 5 s. A gen owes a hook event while a turn is open (`in_turn`) or while an item offered to it is not
bound yet (`idle` with an `offered` item). It is stuck when it owes one and has sent none for `LANES_MAIN_STUCK_MS` (default 600 s); the silence counts
from its last hook event, or from the offer when that came later.
- One alarm per episode. For an idle gen the limit-menu pane read says whether a menu is the reason.
- The next hook event of the gen clears it, and Joey is told once. A later silence is a new episode.
- Nothing else moves this clock: an offer is written once, so a frozen main (SIGSTOP) is alarmed once and gets its offer when it runs again.
