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

**A turn ends at its last Stop.** Claude Code runs every Stop hook of the session in parallel, and the turn goes on, under the same `prompt_id`,
when any one of them blocks (decision `block` or exit 2; the next Stop then has `stop_hook_active: true`). main-hook.py cannot see the others'
answers: a main whose user settings carry their own Stop hook (the fleet's `check_tg_reply.py`) can have the Stop that main-hook.py let through
(`phase: final`) blocked by that hook. So a Stop is the end of the turn only until the same prompt shows up again:
- `Stop` (final): the turn's `bound` items become `done`, the gen goes `idle` with `stopped_prompt` = the prompt.
- Any later hook event of the gen with that `prompt_id` (PreToolUse, PostToolUse, a Stop, a StopFailure): the turn was not over. The gen goes back
  to `in_turn` on that prompt, and the items `done` at that Stop go back to `bound` with `reason: turn_continued` (what their `done` met, a
  hand-over's `main` obligation, is `open` again). From there they follow the one rule: `done` at the turn's next final Stop, `queued` at a
  StopFailure or at the end of the gen.
- An event with any other prompt starts a new turn and clears `stopped_prompt`. No time window decides any of this: only the prompt id.
- An item offered while the gen was idle between the Stop and the continuation (the gap) is not bound to the continued turn: it waits, `offered`,
  for the prompt it opens (its own UserPromptSubmit binds it). Nothing new is offered into the continued turn: the gen is `in_turn`, so an item
  that comes is pulled at its next tool boundary or Stop, like in any turn.
- The turn's `reply` / `send_to_agent` calls (what the answered gate checks) are kept for the prompt across the continuation.

How items move:
- **Owed** (M4's one wake rule): an item is owed to the main only while its event carries an open `main` obligation (`toMain`'s record, a hand-over,
  the synthesis's hand-over, a renew brief's `renew-…` record, the router fallback's `direct-…` record). An item with no such obligation is never
  offered or pulled; the digest never is.
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
  - `carry` is a note for the main: a `/main renew` brief, which has `target` = the new session id, or a fan-out synthesis. Each is owed through
    an M3 main obligation like any hand-over.
  - `digest` is information. It is never offered alone; it rides the next offer or pull.
- `via`: `tg` or `inbox`, the daemon whose MCP stream carries the offer.
- `event`: the inbound event id, when there is one.
- `notif`: the channel notification (`method`, `params.content`, `params.meta`). `meta.did` is the item id. An offer that carries the digest has
  `meta.did = "<item id>,<digest id>"`.
- `gen` and `prompt_id`, while `offered` or `bound`. `via_pull: true` means the item was pulled at a tool boundary or at `Stop`.
- `reason`, when the item returns to `queued`: `stop_failure:<error>`, `gen_end`, `interrupted` (a new prompt came with no Stop), `session_start`
  (the same process started a new session mid-turn). When it returns from `done` to `bound`: `turn_continued` (its turn went on after that Stop).
- `done` clears an earlier `reason`; it may carry `reason: asked_restart` (special case 1 below).
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
| `walled` | the MAIN's own wall: its turn ended in a StopFailure of an account kind (`kind`: `rate_limit`, `billing_error`, `account_on_hold`, `authentication_failed`, `oauth_org_not_allowed`, `cloud_credential_error`) |
| `gone` | `end_reason`: `asked` (/restart, /kill_stuck), `killed` (`kill -0` failed), `exited` (SessionEnd), or `replaced` (another process took the role, or /main renew) |

Other fields: `pid`, `session_id`, `transcript_path` (recorded, never read for state), `source`, `error`, and `stopped_prompt` on an `idle` gen: the
prompt whose Stop made it idle (a later event of that prompt re-opens the turn; see "A turn ends at its last Stop").

**The main's wall is its own record** (the lanes' wall, `wall` in `GET /lanes/state`, is another one and never moves this one):
- An account-kind StopFailure walls the gen and starts a wall episode: `wall_since` (set once per episode), `probes`, `retry_at`. Joey is told once
  (`main-wall-up`). Any other StopFailure (`server_error`, an overload, `unknown`) does not wall: the turn's items queue again, the gen is `idle`
  with `error`, and the next offer is the retry.
- At `retry_at` M1 offers the walled gen one item: its probe (a limit menu on its pane is driven first, and Joey is told what was chosen,
  `main-menu`). The gen leaves `walled` only on its own next hook event (the probe's UserPromptSubmit, or a SessionStart). A StopFailure in that
  turn is the same episode: `probes` + 1, a longer `retry_at`, no new notice. The episode ends at the gen's next final Stop: `wall_since`,
  `probes` and `retry_at` are cleared and Joey is told once (`main-wall-down`).
- A new gen starts `idle` or `starting`, whatever the lanes' wall says.
- `turn_started` is not used; the turn's start is the `in_turn` line's `ts`.

### `event` (M3): one record per inbound event

**Every inbound event has a record, whatever its route** (one helper in the router, `recordInbound`): one given to a lane (with what it owes),
one given to the main (a hand-over owed to it), and one the router keeps to itself: a `no_reply` notice, a peer message held by a hold or a flood
gate, an alert repeat, a message on a stopped thread. A hand-over never creates a record. What the main must know about an event is a field of its
record (below); the ledger (`ledger.jsonl`) is an audit log that no view and no state reads.

| state | meaning |
|---|---|
| `open` | something is still owed: an obligation is `open` or `requested` |
| `closed` | nothing is owed (every obligation is `met`, `handed`, `dropped` or `merged`; an event with no obligations is closed at once) |

Fields:
- `class`: `scheduled`, `peer`, `joey`, `alert` or `critical` (`followup` is no longer written). The router writes it from the routing rule's
  trigger. No hook parses prompt text for it.
- A scheduled event's receipt obligation takes its `run_id` from the event's meta (`meta.run_id`), and `meta.frequency: high` drops its Joey line.
  Both come from structured fields of the `/inject` body (`run_id`, `frequency`); nothing parses `[run:N]` or `[high-frequency]` from the text.
- **A follow-up is another run of its origin event**, not a new event: the follow-up scheduler queues a run of the origin event (the run's queued
  line carries `ev.followup` = the follow-up id; the routing row has `event` = the origin and `followup`). Its Joey line is the origin's: a line
  with a different `outcome` is a raise, the same outcome is refused; the origin's receipt is already met. A follow-up whose origin still has a run
  queued or running waits for it.
- `owner`: the lane id, `main`, or `router`: information nobody handles (it has no obligations).
- `outcome`: `normal`, `changed` or `failed`. It is the worst outcome any call reported (a structured field of `notify_joey`, `ask_joey` and `receipt`).
- `tool`: the call that changed the record. `refused`: the reason, when that call was refused.
- `thread`, `lane`, `from`, `text` (the first 300 characters).
- What the main must know (all optional):
  - `must_know: true`: a critical event, set when it opens (the digest's 【主線必須知道】 comes from this field);
  - `flags` (`authority-claim`, `instructions-to-agent`, `thread-not-yours`), `claim` (the matched words of an authority claim), `screen_p`;
  - `repeat_of` (the alert it repeats) and `repeat` (n) on an alert repeat, with `worse` (`old → new`) when the values got worse; the origin then
    carries `repeats` and `worse` too;
  - `gate` (`peer-flood`, `peer-hold`) and `episode` (the episode's first event) on a gated message; that first event carries `flood` or `hold`
    (`peer`, `count`, … and `ended` when the episode is over);
  - `answers`: the lane (or `main`) whose question a `no_reply` notice answers;
  - `stop`: `{why: hop | budget | already-stopped, thread, note}` on an event the thread gate stopped;
  - `chain_end` (`cap`, `no-change`) and `chain_runs`: its follow-up chain ended;
  - `result`: a fork's (or the curator's) final text; `did`: what the lane reported;
  - `lane_closed`: `{by, via, run, reported, stopped, last}` when its lane was closed while the run was running;
  - `proposals`: `[{id, text, joey, at, lane, decision, decided_at, writer}]`, the memory proposals filed in a run of this event (the main's
    `memory_decide`, or the curator, writes `decision`);
  - `promised`: the commitments a lane recorded in a run of this event;
  - `main_seen`: the version the main has seen because it made that change itself (a memory decision): the digest does not tell the main what it did.
- `obligations`: `[{id, kind, level, state, by, owner, due_at, ref, failed, outcome, into, ...}]`. `state`:
  - `open`: owed;
  - `requested`: the outbound call was accepted and is being delivered (`prev` holds what it was);
  - `met`: delivered (`ref` = the Telegram message id, the btcc id of a delivered mesh send, or the scheduler's answer). A failed delivery puts the
    obligation back to what it was, with `failed` = why: the lane's retry is a request like the first one, not a repeat;
  - `handed`: the one hand-over transition gave it to the main;
  - `dropped`: the event's thread was stopped before it ran (`by` says why); `merged`: another run handled it (`into`).
- `refused`, `refused_kind`: the reason and the kind of a refused request (every refusal is a journal line).
- `main_sends`: `[{to, ref, at, tier | delivered, prompt}]`: the main's Telegram replies (`to: joey`) and send_to_agent calls made in a turn this
  event's item was bound to.

| kind | levels | met by |
|---|---|---|
| `joey` | `line` < `decision` | `notify_joey` (a line), `ask_joey` (a decision; raising a met line is accepted, and so is a line whose `outcome` differs from the one it was met with), or the main's reply in a turn the event's item is bound to. A critical alert's line has `ring` and `due_at`: see "The ring" below. |
| `peer` | `answer`, `interim`, `commitment`, `message` | `reply_agent` to that peer, met when the inbox reports it delivered. `interim` is met by the router when a lane hands the request to the main and its fixed message is delivered; a new `answer` then opens with `owner: main` and a `due_at`. The main meets an answer by a delivered send_to_agent in a turn the event's item is bound to (else by a send on the promise's thread, quoting its message, or the promise aid). `commitment` is the main's own commitment tool, met by `commitment_done`. `message`: a lane's reply_agent to an agent its event did not owe (one per agent). |
| `receipt` | `run` (`run_id`) | the run's completion at the scheduler, once per scheduler run across every event: `receipt(run_id)`, or the lane's `./bin/btcc-receipt complete N` (`by: btcc-receipt`), whichever comes first. See "The scheduler receipt" below. |
| `main` | `handed` (`handoff`, `item`, `due_at`, `cls`, `what`) | the M1 item that carries it reaching `done` |

The one rule: a lane's outbound call asks to meet an obligation of its event.
- Meeting an open one is accepted (`requested`), and it is `met` on the delivery result. Raising one (line → decision, or a line with another outcome) is accepted.
- Repeating a met or requested one is refused, and the refusal names what is still open.
- **One hand-over transition** (`events.handOver`, used by handoff_main, the exit rule and the thread stop alike): one `main` obligation opens and
  every lane obligation still owed (`joey`, `peer`, `receipt`) moves to `handed`. An event already handed keeps its hand-over (no second item).
- **The main's replies and sends** are requests against the events whose items are bound to its running turn (M1: prompt → items → events). A
  reply meets their Joey line (handed or still owed) and rings a ring nobody rang; a delivered send_to_agent meets the answers they owe that agent.
  Nothing is matched by a parameter: the reply tool has no `handoff_id`. The tier of such a reply comes from the same events: a quoted message or a
  Joey message in the turn makes it ordinary; otherwise silent when every event's class is silent (a push class whose ring already rang is silent).

**The scheduler receipt.** A lane has two ways to complete scheduler run N: the receipt tool, and the scheduler card's CLI
`./bin/btcc-receipt complete N`. Both are one request, handled in one place (lanes.ts `completeRun`): meet the event's `receipt` obligation for run N,
then call the scheduler. The lane guard hook (lane-guard-hook.py, PreToolUse on Bash) does not let the CLI run: it posts the request to
`POST /lane-receipt` with the run's token and denies the Bash call with the daemon's answer. The first request completes the run; any later one, by
either path and from any event, is refused ("already completed"). `./bin/btcc-receipt ack` is not a completion and runs as it is. Without the daemon
the hook still denies the CLI. So the daemon is the only thing that completes a run at the scheduler.

**The lane stop.** The lane's Stop hook (lanes-hooks/lane-stop-hook.py) posts to `POST /lane-stop` with its run token (`LANE_RUN_TOKEN`; the port
is `LANES_HTTP_PORT`, set by the daemon in the lane's environment). The daemon blocks once with the open obligations, or lets the run end.

**The exit rule.** When a run ends, at whatever reason, its open obligations go to the main by the one hand-over transition, plus one M1 item.

**The ring.** A critical event rings Joey once. The first line about it that reaches Joey with a ring meets the ring: the lane's `notify_joey` or
`ask_joey` (the obligation is `met`), or the main's report on the event's hand-over (`rang`, `by: main`). If none has by `due_at`, the due sweep
rings (`rang`). Handing the event to the main, by `handoff_main` or by the exit rule, does not take the ring away from the router. Every later line
about the event goes out silent: a lane line (tier rule `+rang-at-due`) and the main's report in a turn bound to it (`+rang`).

**The due sweep** runs every second. It acts on open obligations past `due_at`:
- a critical line: the router rings once (`rang`), unless a line that rang reached Joey first;
- a hand-over, a promised answer, a commitment: Joey is told once (`told`).

A `main` obligation is due 300 s after the hand-over (`LANES_HANDOFF_FALLBACK_MS`). The sweep acts only on the `due_at` an obligation got when it was
created: nothing rewrites it, so a main that is away makes nothing due early (what was given to it waits; the wall or stuck notice told Joey once),
and Joey's own messages to the main have no `due_at` at all.

### `wake` (M4): a decision, logged

`id` is an item id or an event id. `state` is `wake` (M1 offers the item: the main was idle and something is owed to it) or `no_wake`. `reason` says
which: information, the main in a turn (the item is pulled at its next boundary), the main walled or gone, or the event owes nothing.

### `run` (M5): one record per lane run

| state | meaning |
|---|---|
| `queued` | waiting for a slot. Fields: `ev` (the event, without its channel payload), `priority`, `summary`, `enqueued`, `extra` (messages riding in it), `deaths`, `not_before` (the backoff after a death) |
| `leased` | picked: `run` (the lane run id, e.g. `adam.reflex.3.r2`) |
| `running` | spawned: `pid`, `budget` (the thread's budget state as the run starts) |
| `exited` | `reason`, `exit_code`, `signal`, `tokens` (what this run used), `budget` (the thread's budget state after it) |

Every line also has `event`, `lane` and `attempt`.

`tokens` is `{in, out, fresh, calls}`: the run's input-side tokens (uncached input, cache reads and cache writes), its output tokens, its fresh
tokens (uncached input, cache writes and output: what the thread budget counts, `freshTokens`) and its API calls. `budget` is
`{thread, used, limit}`: the thread, the fresh tokens its runs have spent, and the thread budget (`LANES_THREAD_BUDGET`). Both come from the
budget accounting itself (the same numbers the in-run budget check and the lanes.jsonl exit row use). A queued run refused at the budget before it
starts (`exited(budget)` with no `running`) carries the `budget` that refused it.

`reason` is one of:
- `normal`, `cap_turns`, `cap_usd`, `budget`, `wall:<kind>`, `died`, `timeout`: how the run ended;
- `merged` (coalesced into another run) or `dropped` (its thread was stopped): a queued run that never started;
- `closed`: its lane was closed, while it ran (the daemon's own decision, like `timeout`) or before it started. The exit rule then runs like for
  any other reason: what the event still owes goes to the main (Joey's messages steered into a closed lane that it never got too).

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

## The route record

One function (lanes.ts `routeRow`) writes every route record: a line of `<lanes dir>/routing.jsonl` and the same row to Logos as `lane.route`. That
holds for every rule: the router's own decisions, and the follow-up, coalesced, thread-stopped-drain, fan_out, fan_out-synthesis, open_worker,
fork, curate_memory, master-on/off, digest and registration rows. A row has `event`, `rule`, `target`, `lane`, `note`, and:
- `thread`: the owner's thread, i.e. the conversation the event belongs to after routing (the lane's thread, the thread a stop closed, the main's
  thread); `peer_thread`: the thread the sender supplied;
- `followup` on a follow-up row (its `event` is the origin event), `into` on a coalesced row, `episode` on a gated row.

## The digest and the activity list: one renderer over M3

The digest is information that rides an M1 offer or pull. It is never offered alone.
- One line per event record in the views whose `version` is past what the digests showed (and past its `main_seen`): the `events` of every digest item that is `done`, `offered` or
  `bound`, read from the journal (no file of its own). A digest item that goes back to `queued` shows nothing yet, so a turn that continues and
  then fails does not lose its digest's lines.
- At most 8 lines, in this order: owed to the main (`需主線`), waiting on Joey's decision, the rest. The overflow is named on one line.
- An open Joey memory proposal (from the M3 records' `proposals`) and an active peer hold are lines of every digest while they last.
- **The views** are every record whose owner is not `main`, except a record that rides on another: a gated message of an episode (its first
  event carries the episode) and an alert repeat that got no run (its origin carries it). A fresh lane on an old thread gets the thread's lines
  (`threadSummary`), and a closed lane's last lines come from its records too: nothing reads the ledger for them.
- A line is `• MM-DD HH:MM｜<who handled it>｜<what happened>｜來自 <sender>｜<where each obligation stands>` (lanes.ts digestLine).

**The activity list** (`ledger_query()` with no `kind` and no `text`) is the same renderer (lanes-digest.ts `renderEvents`) over the same lines, in the
same order, for every event record in the views changed in the window: the last 24 h, or since `since`. It has no line limit, and it is not
affected by what the digests showed. The main's own events are in neither view. A filtered `ledger_query(kind=…, text=…)` searches ledger.jsonl:
the audit log (its lines no longer carry `notify_main`).

## The main's hook

One script handles every event: `lanes-hooks/main-hook.py`. It replaces session-start-hook.py and main-midturn-hook.py, and it is the only hook the
main needs: it calls the model aids itself (main-summary-gate.py at the PreToolUse of the Telegram `reply` tool; main-memory-gate.py and
main-answered-gate.py at Stop), with the turn the daemon answers. No aid reads the transcript or the ledger.

The main session's settings must carry:

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "PreToolUse":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 30 }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 30 }] }],
    "StopFailure":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 15 }] }],
    "SessionEnd":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <plugin>/lanes-hooks/main-hook.py", "timeout": 2 }] }]
  }
}
```

memory-commit-hook.py keeps its own registration (PostToolUse on Write and Edit). The PreToolUse timeout is 30 s because the summary gate's Jev
calls (`SUMMARY_GATE_JEV`, `MAIN_REPLY_CHECK`, `TYPESAFE_*` must be in main-hook.py's environment) run inside it.

Do not register main-summary-gate.py, main-answered-gate.py or main-memory-gate.py as hooks of their own (run alone, the first two do nothing
unless their input carries `turn`). main-hook.py runs them at Stop, after it has asked the daemon
to pull. That way a Stop that some aid holds is never counted as the end of the turn. A Stop hook the plugin does not own (the user's) can still
block a Stop main-hook.py let through: the daemon re-opens that turn at its next event ("A turn ends at its last Stop").

Environment the hook needs. The keeper already sets these for the main:
- `TELEGRAM_HTTP_PORT`: the tg daemon's port.
- `MCP_TOKEN_DIR`: where the loopback token is, if it is not `~/.claude/agent-inbox/mcp-tokens`.
- `CLAUDE_PID`: set by Claude Code itself. Without it, the daemon identifies the caller of `SessionStart` by its socket.

What the hook sends to `POST /lanes/main-event`:
- always: `{event, session_id, prompt_id, pid, transcript_path, source, tool_name, error}`;
- UserPromptSubmit: `dids`, the `did="..."` values in the prompt;
- PostToolUse of every tool: `tool_input` (each string cut to 3000 characters; `to`, `reply_to`, `text` for reply / send_to_agent), `tool_response`
  (as text, cut to 20000) and `tool_error`. The daemon keeps the running turn's calls (the last 40) for the summary gate;
- StopFailure: `reason`, which is `last_assistant_message`;
- Stop: `phase: "check"` first, then `phase: "final"` when nothing holds the turn.

What the daemon answers besides:
- PreToolUse of the `reply` tool and the Stop check: `turn` = `{prompt_id, started_at, prev_started_at, items, calls}`: the running turn's prompt,
  when it and the main's previous turn started (M2), the items bound to it (`{id, kind, content, user}`; a digest item's content is the digest),
  and its tool calls with their results. The Stop check also answers `proposals` (the open Joey-sourced memory proposals, from M3) and `curator`.

What the hook prints, from the daemon's answer:
- SessionStart: `additionalContext`. That is the main-only rules for the accepted main, or "you are not the main".
- PreToolUse of `reply`: the summary gate's `deny`, when it has one.
- PostToolUse: `additionalContext` with the items pulled into this turn.
- Stop: `decision: block` with the items pulled, or with an aid's reason.

How the main is registered:
- A `SessionStart` is accepted when its session id is `.lanes/main-expected` (written by the keeper), or the new session of a `/main renew`, or when it
  comes from the process of the live gen (`/clear`, `/compact`).
- Any other SessionStart is refused. Joey is told once, and that process's MCP sessions lose the Telegram tools.

## Lanes

The daemon writes the lane settings into `.lanes/lane-settings.json`. The lane Stop hook is lane-stop-hook.py. A slot carries nothing for lanes.

A lane is the plugin's session, not the user's. It runs with `--settings .lanes/lane-settings.json --setting-sources project,local`: the user's
settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`) do not load, so neither their hooks nor the plugins they enable run in a
lane. Their hooks were written for an interactive session: the fleet's `check_tg_reply.py` blocks every Stop that sent no Telegram reply, which fights
a lane whose routine work is a silent line or a receipt, and whose Stop hook (lane-stop-hook.py) already owns what is still owed. The workspace's own
project and local settings still load. What a lane takes from the user's settings is explicit:
- their `env` (the login, `CLAUDE_CODE_OAUTH_TOKEN`), put into the lane's process environment, never written to a file;
- the guard hooks `LANES_USER_GUARDS` names (comma-separated script names, e.g. `eden_guard.py,redact_hook.py`), copied into the lane settings
  beside the plugin's hooks with their event, matcher and timeout. A named guard that is not in the user's settings is logged.

The main is a normal session: it keeps the user's settings and their hooks. That is why M1 ends a turn at its last Stop ("A turn ends at its last
Stop").

## Special cases kept (marked `SPECIAL CASE` in the code)

1. **An asked restart** (`/restart`, `/kill_stuck`): the items of the cut turn end `done` with `reason: asked_restart`, and Joey gets one line. They are
   not re-given. This is the owner's decision (002j, 5018d39), kept as data.

2. **The TUI relay's wall line** (`wallKind`). The relay (system-alert.ts, fleet code that stays) forwards the CLI's own error line from the
   main's pane or transcript. Deferring it to the one wall notice (002l D12) means recognising that line; no signal carries it. This is
   wallKind's only use: a lane's wall kind comes from its result status, the main's from StopFailure.

## Stuck (疑似卡死)

This is M2 only. The tg daemon checks every 5 s. A gen owes a hook event while a turn is open with no tool running (`in_turn`, no `tool_open`) or
while an item offered to it is not bound yet (`idle` or `walled` with an `offered` item). An open tool call is work, not silence (P14): its
PostToolUse is the event the gen owes when the tool ends, and Claude Code bounds a tool by its own timeout. It is stuck when it owes one and has sent none for `LANES_MAIN_STUCK_MS` (default 600 s); the silence counts
from its last hook event, or from the offer when that came later.
- One alarm per episode. For an idle gen the limit-menu pane read says whether a menu is the reason.
- The next hook event of the gen clears it, and Joey is told once. A later silence is a new episode.
- Nothing else moves this clock: an offer is written once, so a frozen main (SIGSTOP) is alarmed once and gets its offer when it runs again.
