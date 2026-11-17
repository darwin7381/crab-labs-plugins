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
  - Folding never offers anything. Items left `queued` are offered when M1 next finds an idle gen. Items left `offered` or `bound` stay with the gen they
    belonged to; if that process is gone, `kill -0` ends the gen and puts them back to `queued`. So a daemon restart re-offers each queued item exactly once.
- **`GET /lanes/state`** on the tg daemon's HTTP port (loopback token, like every `/lanes/` route) serves the folded state:
  `{current_gen, wall, msg: [...], main: [...], event: [...], run: [...]}`. Each record has its fields plus `created` (the ts of its first line).

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
  (the same process started a new session mid-turn), or `offer_unanswered` (see special case 1 below).
- `done` may carry `reason: asked_restart` (special case 2 below).
- Digest items also have `from`, `upto` and `items`: the ledger range they cover and how many entries.

### `main` (M2): one record per main process

`id` = the gen = the pid, as text.

| state | meaning |
|---|---|
| `starting` | `SessionStart` accepted; the tg daemon has no open MCP stream of this process yet |
| `idle` | can be offered one item |
| `in_turn` | inside a turn: `prompt_id`; `tool_open` is set between PreToolUse and PostToolUse |
| `walled` | the account's model wall is up: `kind` is the StopFailure error (`rate_limit`, `server_error`, ...), or the kind of the lane wall |
| `gone` | `end_reason`: `asked` (/restart, /kill_stuck), `killed` (`kill -0` failed), `exited` (SessionEnd), or `replaced` (another process took the role, or /main renew) |

Other fields: `pid`, `session_id`, `transcript_path` (recorded, never read for state), `source`, `error`.

### `event` (M3), `run` (M5), `wake` (M4)

| rec | id | states | fields |
|---|---|---|---|
| `event` | event id | `open`, `closed` | `class`, `owner`, `obligations`, `outcome`, `tool` (the call that changed it), `refused` (the reason, on a refused call) |
| `run` | run id | `queued`, `leased`, `running`, `exited` | `event`, `reason`, `exit_code` |
| `wake` | item id or event id | `wake`, `no_wake` | `reason` |

These are written from steps 2 and 3 of the rebuild on. Their fields are documented with those steps (below).

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

The lane settings are written by the daemon into `.lanes/lane-settings.json`. A slot carries nothing for them.

## Special cases kept (marked `SPECIAL CASE` in the code)

1. **The offer retry** (`LANES_OFFER_RETRY_MS`, default 20 s).
   - An offer written into a client that is still starting can be dropped by it (002h, 002i).
   - If no hook event at all comes from the idle gen after an offer, the item goes back to `queued` with `reason: offer_unanswered` and is offered again.
   - An unbound item has had no effect, so this is safe. No hook signals that a client is ready for input.
2. **An asked restart** (`/restart`, `/kill_stuck`): the items of the cut turn end `done` with `reason: asked_restart`, and Joey gets one line. They are
   not re-given. This is the owner's decision (002j, 5018d39), kept as data.

## Stuck (疑似卡死)

This is M2 only. The tg daemon checks every 5 s, and raises one alert per episode in either of two cases:
- a gen `in_turn` with no hook event for `LANES_MAIN_STUCK_MS` (default 600 s);
- an `idle` gen with an item offered and no hook event since then, for the same time. The limit-menu pane read says whether a menu is the reason.

The alert clears with the next hook event.
