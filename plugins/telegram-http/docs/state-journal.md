# The lanes state journal, and the hooks a slot must carry

Lanes mode (`GENESIS_LANES=1`) runs on five mechanisms with explicit state. One writer keeps all of it: the tg daemon (telegram-http, not
the agent-inbox daemon). Every other component asks the tg daemon.

| | mechanism | record | moved by |
|---|---|---|---|
| M1 | delivery ledger | one `msg` per item for the main | the main's hook events |
| M2 | main record | one `main` per main process (gen = pid) | hook events, adoption from the session registry, and the pid check |
| M3 | event record with obligations | one `event` per inbound event | the router, the lane's own tool calls, the run's exit |
| M4 | wake rule | `wake` lines, which log decisions and are not folded | M2 phase × what M3 owes the main |
| M5 | run record | one `run` per lane run | the lane process: spawn, its result JSON, its exit code |

No mechanism reads a transcript to learn a state, with one exception (WO-201, below): when a turn of the main ends with no normal end (its gen ends, its
process starts another session, a non-account StopFailure) while an item is bound to it, M1 asks the gen's transcript one question: did the model produce
genuine output after the item was bound?

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

The one rule: an item is `done` only when its turn ends with `Stop`. An item is offered again only when a fact says the last offer did not reach a turn
that completed (WO-201: Chiron's resend audit 2026-11-27, design rule 3, and his ruling mesh-13184; Joey TG chiron:2864). How the turn it was bound to
ended decides, four cases only:

| how the turn ended | its items |
|---|---|
| a normal end (its final `Stop`) | `done` (`received: stop`) |
| a compaction inside it (SessionStart `source: compact` from the gen's own process while `in_turn`) | the turn goes on under the same `prompt_id` (measured 2026-11-27: 82 of 82 on the lanes journals of the Mac mini and txmonster): the gen stays `in_turn` with its prompt, nothing is queued again |
| no normal end, and **no** genuine output after the item was bound | offered once more (`cuts: 1`); a second such end closes it (`done`, `reason: cut_twice`) with one line to Joey (`main-cut`). For a non-account StopFailure: the backoff and cap below |
| no normal end, output **already** there | `holdCut` queues it with `reason: interrupted`, `cut_at`, `cut_by` and its output evidence. After process loss (`gen_end`) it rides or leads the next offer the main can take with the wall down. An account cut is released at the keeper's clear. Both carry instructions to finish the work and avoid repeating actions, with the reason 對話結束 or 用量上限. |

A session change (`session_start`) or non-account StopFailure keeps `INTERRUPTED_LINE`. These items ride the next delivery or, after 600 s
of receivable time, lead one quiet offer (`interrupted_untaken`). Esc cuts retain their own rule. Joey's Esc-cut item only rides, while a
colleague's can lead after 600 s with the usual stuck notice.

Process loss and session changes share one bound-item counter, `cuts`, regardless of output. The second known cut closes the item with
`reason: cut_twice`. Joey's `main-cut` notice says whether work had started. A held process or session cut from 1.59.5 already records
the first cut in `cut_by`.

- **Output after the binding**: the item reached `done` at a final `Stop` before (`received: stop`, kept when its turn goes on: `turn_continued`), or M2
  itself received a hook event of the main for the item's own prompt, in its gen, after the item was bound (`noteOutput`, mesh-13196: PreToolUse /
  PostToolUse, i.e. the model emitted a tool call, or Stop; for an item pulled into a running turn only Stop, since a tool call after the pull may belong to
  the response that was already streaming; a subagent's event never: received live, so the last second the transcript may not have on disk yet when the gen
  ends is not missed; in memory, so after a daemon restart the transcript alone answers), or the gen's transcript has a genuine assistant record after the item's `bound_at` (liveness.ts `genuineAssistantAfterFile`: the fleet's one predicate
  `isGenuineAssistant`, i.e. not `isApiErrorMessage`, not model `<synthetic>`; and a response begun after `bound_at`: a block of a response already
  streaming then, same `message.id`, does not count, because Claude Code runs a tool while its response still streams). Output means the work started. The held item's line records the evidence (`output_by`: `stop`,
  `hook:<event>`, `transcript`).
- **Where it is decided**: the end of a gen (kill -0, SessionEnd, another process taking the role) and another session in the same process while a turn is
  open (`/clear`, `/resume`; not a compaction) settle each item of that gen (`settle`); a non-account StopFailure, its turn's items (`failTurn`). An item
  offered and never bound never reached a turn: `queued` again (`gen_end` / `session_start` / `stop_failure:<error>`), as before. A bound item for which it
  cannot be told (no transcript path, the file unreadable, the span after `bound_at` larger than 64 MB): `queued` again as before at a gen's end (the log
  says why), the backoff at a StopFailure.
- **A StopFailure that is not an account kind** (`server_error`, an overload, `unknown`), for the items with no output after them: back to `queued`
  (`stop_failure:<error>`) with `fails` + 1 and `fail_retry_at` = now + `wallBackoffMs(error, fails − 1)` (for these kinds the wall's base,
  `LANES_WALL_PROBE_MS`, 300 s); neither offered nor pulled before it. The `LANES_MAIN_FAIL_MAX`-th (3) failed turn parks the item (`reason:
  stop_failure_cap`, no retry time) and opens the stuck episode: one `main-stuck` line to Joey. The gen's next final `Stop` (the model answers again) clears
  every `fail_retry_at` and lets each parked item go once (`stop_failure_released`, `fail_released`); a released item that fails again is closed (`done`,
  `stop_failure_gave_up`) and Joey is told which. The account wall (`rate_limit`, …) is unchanged.
- An interrupted turn by Esc (statusIdle) or a new prompt with no Stop (beginTurn) holds its items the same way (`cut_by` cleared), as before.

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
  the synthesis's hand-over, a renew brief's `renew-…` record). An item with no such obligation is never
  offered or pulled; the digest never is.
- **Offer.** An idle gen is offered one notification: the oldest queued item that is owed to the main and whose own stream can take it (its `via`;
  002w E, gap 4: an item whose stream is down waits without holding the others; 2a936a7 tried only the oldest, so a mesh item behind a closed inbox
  stream held Joey's Telegram messages), with the digest riding on it.
  An offer is written only into a stream that can take it: the gen's MCP GET stream is open and the SDK transport holds it (server.ts `streamLive`;
  the SDK drops a notification without an error when it has no GET stream). If no such stream exists, the item stays `queued` and nothing is
  offered; the next pump (the stream opening, a Stop, the 5-second tick) tries again. An item is offered to a gen once, and once more when it stays
  unbound: an idle gen's after `LANES_OFFER_LEASE_MS` (20 s; `reason: offer_untaken`, nobody is told: 002x), a walled gen's probe item or an idle
  gen's item the lease has not written again at a stuck episode (below; `reason: stuck_unbound`, 002q H02/H03). `reoffered` on the item names
  the idle gen that got it twice: it is never written to that gen a third time.
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
- `bound_at` (WO-201): when it was bound (what "output after it" is measured from). `received` (`stop`), `output_by`, `cuts`, `cut_by`, `fails`, `fail_retry_at`, `fail_released`: above.
- `reason`, when the item returns to `queued`: `stop_failure:<error>`, `stop_failure_cap`, `stop_failure_released`, `gen_end`, `interrupted` (Esc, a new prompt with no Stop, or WO-201's case 4: `cut_by` says which), `interrupted_untaken` (an interrupted turn's item offered alone after `MAIN_STUCK_MS`), `session_start`
  (the same process started a new session, not a compaction, mid-turn), `stuck_unbound` (002q: offered, never bound, and the gen's stuck episode began), `offer_untaken` (002x: offered to an idle gen and not bound
  within `LANES_OFFER_LEASE_MS`: written once more). When it returns from `done` to `bound`: `turn_continued` (its turn went on after that Stop).
- `done` clears an earlier `reason`; it may carry `reason: asked_restart` (special case 1 below), or (WO-201) `cut_twice`, `stop_failure_gave_up`.
- Digest items also have `events` and `items`:
  - `events`: `{<event id>: <version>}`, the event records the digest shows, each at the `version` it was rendered from;
  - `proposals`: the ids of the open Joey memory proposals it carries as standing lines (002v): a digest of these that is `bound` or `done`
    means the main was shown them, and the main's memory gate holds the Stop of a turn while one is still undecided;
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

Other fields: `pid`, `session_id`, `transcript_path` (read for one question only: WO-201's output after the binding, above), `source`, `error`, and `stopped_prompt` on an `idle` gen: the
prompt whose Stop made it idle (a later event of that prompt re-opens the turn; see "A turn ends at its last Stop"). `owed_hold` (the prompt) and
`owed_events` (002q): the turn that the Stop check held because it still owed Joey a line, and those events (see "The main's Stop" below).

With no live gen, a registry change or the five-second tick can register the status source's main with `source: 'adopt'`.
Its session must be expected and its OS process start must match the registry file. After 60 seconds of disagreement,
Joey gets the agent, session, pid and reason once. Registering a live gen rearms the notice.

A main turn cut by StopFailure or process loss with no delivery item records `cut_turn` with `at` (epoch ms) and `why`.
A model error adds `retry_at`. A process loss can include `background_agents` from that session at the cut.
When program delivery is possible and there is no candidate, a successful continuation writes `resume_sent = cut_turn.at`
and increments `resumes`. The next gen inherits all three fields. The main's own final Stop clears the cut and its receipt.
`resumes` retains the agent's total.

**What a turn of the main works on** (002w B) is one set, M1's `turnWork(gen, prompt)`: the items bound to the prompt (not the digest) and their events;
for a turn that took in nothing (its own background task's notification opened it; Claude Code starts such turns on its own), the work the gen carries
on: the last turn that took items in (the gen's `work`: those items' aid view, their ids and their event ids, and every output since). Every per-turn duty
reads it: the Stop check's hold (step 2 below), the last-words check's `context` (step 3), `mark_no_reply`, and what the main's reply (`mainTurn` →
`replyTargets`, `mainReplied`, the tier) and send_to_agent (`mainSentInTurn`) meet. Before 002w only the last-words check got the carried work: in a turn
that took in nothing the owed hold asked nothing, mark_no_reply marked nothing, and the reply and the send met nothing (gap 8). The work is cleared at a
`SessionStart` with source `clear` (the new session never saw it: inventory 24a), and when the gen ends.

**The main's Stop** (`POST /lanes/main-event`, `phase: check`, then `phase: final` when nothing held the turn). The daemon's answer to a check, in order:
1. Items still queued are pulled into the turn: `block` 「這一輪先不要結束。…」 with them (M1).
2. 002q (H06), 002w (B): **the turn still owes what it works on.** The events of `turnWork` (above) on which the main still owes (`events.mainObs`, the
   question `openObs` asks of a lane): a `joey` line, a peer's `answer` or a `receipt`, `handed` to it (Joey's own message to the main, a hand-over,
   including the give-up hand-over's 「由你回報 Joey 一次」, a peer's message the router gave the main), or `open` where the main owns the obligation or the
   event (an answer the router promised in its name). Not `met`, `requested`, `dropped` or `merged`; a `commitment` (the main's own promise for later) is
   no turn's. If any, and this prompt is not already the gen's `owed_hold`: `block` 「這一輪還欠事沒交代，先不要結束：<who>「<first words>」：回 Joey 一句、回
   eve、排程 run N 的回執；…」, and the gen records `owed_hold` and `owed_events`. One hold per turn: the next Stop of the same turn goes on to step 3, and
   what is still owed stays open on its event. Code, no model call; it is the rule the lane stop applies to a lane. 2a936a7 asked Joey lines only: a peer
   handed to the main was never asked about (gap 9).
3. The aids' facts: `items` (the turn's bound items but the digest), `outputs` (its reply / send_to_agent calls), `turn`, `proposals`, `curator`.
   main-hook.py then runs the memory gate and the answered gate, which keeps its own narrow question (a turn of two or more messages).
   002w (G, gap 19): the Telegram reply tool is the main's: main-hook.py denies a subagent's PreToolUse of `…__reply` (the subagent returns its result
   to the main, which answers Joey); 2a936a7 printed nothing and the subagent could reply.
   002r (H05): a hook event that carries `agent_id` fired inside a subagent of the main (Claude Code runs the session's tool hooks for a subagent's
   calls too). main-hook.py posts it as `sub: true` and prints nothing; the daemon starts, continues and ends no turn by it, opens no tool, pulls
   nothing (a pull there would hand the main's message to the subagent) and only counts it as the gen's sign of life while a turn is open. Before
   this, background agents working after the main's Stop re-opened the stopped turn (`turn_continued`) and its items were delivered twice.
   002r (G02): the answered gate also asks whether the turn's last words reached anyone. When the turn made tool calls after its last delivered
   reply / send_to_agent (`turn.calls`) and ends on a text of substance (the Stop payload's `last_assistant_message`; no transcript is read), Jev
   is asked whether that text states an answer or result a sender asked for which no output of the turn contains; yes holds the turn once
   (「你最後寫的那段結果只出現在你自己的畫面上…」). An acknowledgement before the work met the event's Joey line, so step 2 holds nothing here.
   002v (002s r2 G02): every turn of the main is asked, whatever opened it. A turn that took in nothing (its own background task's notification
   opened it; Claude Code starts such turns on its own) carries on the work of the gen's last turn that took items in: the daemon keeps that work
   (its items, and every output since) and hands it with the Stop check as `context`; the answered gate asks the same question over the work's
   messages and outputs, and when the turn itself sent nothing, all of it came after the last output. Before this, such a turn had no items and
   no outputs and was never asked: the main counted 20 pages after a restart, ended the notification's turn on 「the total is 194」, and Joey never
   got it.
   002v (002s r2 C04): "不用回" is the router's (identity.md). At PreToolUse of send_to_agent the hook tells the daemon who it goes to; when the
   turn took in the last message of a conversation the thread gate stopped (the event's `stop`) and the send goes to that peer, the daemon answers
   `mark_no_reply` and the hook runs the main's own input with `no_reply: true` (`updatedInput`). Another peer, a send already no_reply and a
   later turn with items of its own (a new conversation is the main's to open) are not marked; a turn that took in nothing carries on the work, and
   its answer to that peer is marked (002w B, turnWork). The stop's hand-over tells the main its answer will be marked.

**The main's wall is its own record** (the lanes' wall, `wall` in `GET /lanes/state`, is another one and never moves this one):
- An account-kind StopFailure walls the gen and records `wall_refused_at` plus the episode's original `wall_since`. Joey is told once
  (`main-wall-up`). Any other StopFailure (`server_error`, an overload, `unknown`) does not wall: the gen is `idle`
  with `error`; the turn's items are an interrupted turn's when the model had answered them, otherwise offered again after a backoff, with a cap (WO-201, above).
- A keeper clear permits one program offer. M1 drives any limit menu first and records `uw_clear_used` after a successful stream write.
  With no fresh keeper state the walled gen waits for a clear or a person's message eligible under WO-200.
  Its own hook event takes it out of `walled`. A further refusal belongs to the same episode. Its next final Stop ends the episode
  and sends one recovery notice (`main-wall-down`).
- A new gen starts `idle` or `starting`, whatever the lanes' wall says.
- **The wall episode is the agent's, not a gen's** (002w E, gap 13): a gen that ends while walled (killed, replaced, restarted) hands its open episode
  (`wall_since`, `wall_menu`) to the next gen at its SessionStart (the ended record's fields are cleared); that gen's first final Stop ends it with the
  one wall-down notice. 2a936a7 lost the episode with the gen: Joey heard `main-wall-up` and never the recovery.
- **One limit, one notice each way** (002q, G07, T7-R): the two walls stay two records, but Joey's wall notices read both. A side that walls while
  the other is already walled (`main-wall-up` with the lanes' wall up, `wall-up` with the main's episode open), or recovers while the other is still
  walled, is a ledger line (`tier: ledger`, `tier_rule: <rule>+same-limit`), not a push. Joey hears the wall when the first side hits it and the
  recovery when the last side is through. A limit menu the probe dealt with (chosen, or gone) is recorded on the gen (`wall_menu`, cleared with the
  episode) and rides the episode's wall-down notice; only a menu Joey must choose on is told at once (`main-menu`).
- **One owner of the limit menu** (002y, X-1; 002x T7-R, every play, e.g. u002x-T7-s6-r3: main-wall-up msg 2013 @1232.0, the startup-picker
  watchdog's 「🔀 claude 停在一個選單，請選擇」 with buttons msg 2015 @1234.2, the probe's choice @1277.8). Two parts read the main's pane: the
  startup-picker watchdog (server.ts, an 8 s poll; it rang Joey with the menu at once) and this mechanism (the probe chose for him 44 s later). The
  probe chooses “Stop and wait for limit to reset” (option 1 on the T7-R menu). The probe delivers the retry when the keeper clears.
  “Wait here, then continue automatically” would schedule a second wake. A menu with no safe passive wait is re-armed for Joey. With lanes on, the menu is this mechanism's while the
  gen's wall episode is open (`wall_since`), and a limit menu (an option speaks of a limit, usage or a reset) on a gen still `in_turn` (the menu is
  drawn when the limit cuts the turn; the StopFailure can reach the daemon after the watchdog's poll): `mainMenuOwned`, passed to the watchdog as
  its `owner` for the main's pane. The watchdog does not send an owned menu unless the owner re-armed it (`rearmStartupPicker`): the probe found
  no safe option (Joey keeps that decision: the `main-menu` sentence and the menu's buttons), or its key press did not take, or the stuck alarm
  read it (below). So Joey hears the wall once (`main-wall-up`) and what was chosen in its wall-down notice. Every other menu (a starting main's
  resume menu, an idle main's prompt, another pane) and every menu with lanes off stays the watchdog's, as before.
- `turn_started` is not used; the turn's start is the `in_turn` line's `ts`.

### `event` (M3): one record per inbound event

**Every inbound event has a record, whatever its route** (one helper in the router, `recordInbound`): one given to a lane (with what it owes),
one given to the main (a hand-over owed to it, plus what its class owes, already `handed`: the same obligations a lane's event opens with, from one
builder; 002p), and one the router keeps to itself: a `no_reply` notice, a peer message held by a hold or a flood
gate, an alert repeat, a message on a stopped thread. 002w (D, gap 10): the router's failures go through the same builder: a Telegram message the
router threw on (server.ts) and a mesh message it threw on (`POST /lanes/route` answers `{rule: router-failed, target: main}`, so the inbox daemon
does not broadcast it) are given to the main by `toMainDirect` = `toMain` (their own record, what their class owes handed to the main, their M1 item);
a record the router had already opened gets the one hand-over. 2a936a7 opened a `direct-…` record with a main obligation only (no Joey line: the owed
hold never held, the main's reply met nothing) and the inbox daemon broadcast a mesh message to every open session. What remains broadcast is a mesh
message when the tg daemon itself cannot be reached (there is no M1 to queue into). A hand-over never creates a record. What the main must know about an event is a field of its
record (below); the ledger (`ledger.jsonl`) is an audit log that no view and no state reads.

| state | meaning |
|---|---|
| `open` | something is still owed: an obligation is `open` or `requested`, or a Joey line or a peer answer is `handed` to the main |
| `closed` | nothing is owed (every obligation is `met`, `dropped` or `merged`; an event with no obligations is closed at once) |

002q (T7-R, T8-R, T6-R): a Joey line or a peer answer handed to the main is owed by the main, so it keeps the event open until the main's reply or
send meets it. 002p closed the event when the hand-over's M1 item was done, with the line still owed. 002w (D, gap 17): a receipt handed to the main
is the main's too and holds the event open until the main completes the run (its own `./bin/btcc-receipt complete N`, below); before, a handed
receipt was never met and its event closed with the scheduler run still open.

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
  notify_joey's `outcome` is required, one of `normal | changed | failed | needs_you` (002q); a call without one is refused (nothing is journaled or
  sent). `needs_you` (Joey has to decide or do something before the matter can move) is not an outcome on the record: it is the call's level.
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
  - `proposals`: `[{id, text, joey, at, lane, decision, decided_at, writer, joey_event}]`, the memory proposals filed in a run of this event (the main's
    `memory_decide`, or the curator, writes `decision`);
  - `promised`: the commitments recorded about this event: a lane's (its commitment, ledger_write or receipt), and since 002w (F, gap 16) every
    promise **the one promise check** (`promiseCheck`) finds in an outbound text about it. That check runs on every outbound text: a lane's reply_agent
    and notify_joey, the main's send_to_agent (`/lanes/outbound`) and its Telegram reply (`mainReplied`). A relay a lane sends in a run of Joey's is
    his word passed on, recorded without asking (002k C2, `from: owner-relay`); any other text is asked promiseAsk's two questions (`from: lane-send` /
    `main-send`). The event is the run's own (a lane), or the one the main's line met, else its turn's first; a text of the main about no event opens a
    commitment record of the main (`by: promise-check`, no due time: the text gives none, the commitment tool's `due` does). One per lane run; none
    right after the main's own commitment tool. 2a936a7 checked the main's send_to_agent only, into the ledger only (the renew brief and the digest
    read M3 and never saw it), and a lane's text only in a run of Joey's;
  - `tg`: `{message_id, topic}` on Joey's own Telegram message (002t). **His own words travel with everything the main gets from his message**
    (002w I, 002v round 2 D02): ONE renderer (`joeyWords`) writes them from this record (`tg` and `text`, the router's transcript of the message),
    marked 〔Joey 原話｜分流器從 Telegram 收到的原文，不是車道的轉述〕, and every such item uses it: the hand-over of the event (after the lane's text),
    the digest line and activity-list line of the event, and a memory proposal filed in a run whose event set holds his message (`joey_event` on the
    proposal: its standing digest line, its `memory_proposal` ledger row that ledger_query(kind=memory_proposal) shows, and the memory gate's listing,
    the `joey_words` of the Stop check's `proposals`). 002t put them on the hand-over only: in D02 the lane filed Joey's 「記住」 in its own words and the
    main, held to decide it, vetoed it: 「我在主線對話紀錄裡找不到你 2006 那則的原文」;
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
  event's item was bound to that met (or rang) an obligation of this event, or that quote its message. A line that meets nothing is on no event (002p).
- `router_sends`: `[{to: joey, ref, at, rule}]` (002q, T8-R): a router line about this event, delivered (the asked-restart notice). It meets the
  event's Joey line still owed (`by: router (asked-restart)`, `ref` = the message id). 002y (X-4; 002x T8-R a-r3: 2013 answered by 2014 at
  1388.88, /restart at 1389.42, notice 2017 still said 「還要處理的話請再說一次」): the notice names only the cut messages whose Joey line is still
  owed (`mainOwed`, kind `joey`); a cut message the main already answered is closed (`done`, `reason: asked_restart`, like every cut item) without
  it, and its event gets no `router_sends`. None owed: no notice.
- `class`: the event's own class, whatever rule routed it (002p): an alert sender's event has its alert rule's class and severity (`critical` for a
  `[P1][critical]`) even when a rule without a class of its own (`default`, the master switch) gave it to the main. 002w (D, gap 17): any sender's
  (`senderRuleOf`: the first rule for that sender with a class of its own): a scheduler's event is `scheduled` wherever it goes, and owes its receipt
  (2a936a7 classed it `peer` under the master switch, the screen or `default`, with no receipt).

| kind | levels | met by |
|---|---|---|
| `joey` | `line` < `decision` | `notify_joey` (a line), `ask_joey` or `notify_joey` with `outcome: needs_you` (a decision: one code path, the same transition, tier and ledger row; `by` / `tool` name the call made; raising a met line is accepted, and so is a line whose `outcome` differs from the one it was met with), or the main's reply in a turn the event's item is bound to. A critical alert's line has `ring` and `due_at`: see "The ring" below. | An event the router opened with no Joey line (a high-frequency routine owes a receipt only; a fan-out part and a curator report to the main) takes a line only when there is news: `outcome` changed or failed, or a decision; a `normal` line is refused and the record grows no Joey line (002r, T2-R). The label alone does not decide (002s): a line the lane labelled `normal` is judged first (model aid `line-news`: does it state a difference from the previous run, an action taken, or a new problem); news goes out as `changed`, and a failed call lets the line out. |
| `peer` | `answer`, `interim`, `commitment`, `message`, `stop-notice` | `reply_agent` to that peer, met when the inbox reports it delivered. `interim` is the router's own line (`owner: router`, created `met` when its fixed message is delivered) when a lane hands the request to the main; it meets and refuses nothing of the lane's (002q, B09, A05 50006). The event's `answer`, handed to the main, then becomes the main's: `owner: main`, `open`, a `due_at`, `req` (the peer's message id), `sent` (the interim's id). The lane may still send the peer its own line (level `message`, one per agent). 002y (X-3, 002w r1 B09): in either order of the two calls. A lane's reply_agent that met the answer before its handoff_main stays met, as the lane's `message`, and the hand-over owes the answer again (`handOver` with `request`, set by handoff_main only), so the interim and the main's answer follow whichever call came first; before, the reply met the answer, the hand-over found nothing owed and the interim was skipped. The exit rule and the thread stop do not reopen what the lane answered. The main meets an answer by a delivered send_to_agent in a turn the event's item is bound to, or a turn that carries that work on (else by a send on the promise's thread, quoting its message, or the promise aid). 002w (B, gap 9): an answer handed to the main (`handed`, owner lane: a hand-over, a thread stop, a peer's message the router gave the main) is matched the same way as one the router promised (owner main, `open`), and it gets a `due_at` (`LANES_HANDOFF_REPLY_MIN` after it was handed, and `what`): at that time the due sweep tells Joey once (`answer-due`). A peer answer records the request it answers (`req`, the peer's btcc message id), so a later send that quotes it meets it. Before 002w a handed answer was met only inside the turn it was bound to, had no due time, and kept its event open for ever. `commitment` is the main's own commitment tool, met by `commitment_done`. `message`: a lane's reply_agent to an agent its event did not owe (one per agent). | `stop-notice` (002r, C04): the router's own line (`owner: router`, created `met` on delivery) when it stops a thread at its hop limit or budget: the peer is told once, in fixed words, marked no_reply (a flood is told the same way), that the exchange stopped and its last message is with the main. The `interim` (002r, B09) also carries the main's focus card when one is written: what the main is busy with reaches the peer in the router's line, whatever the lane's own reply says. A promise the main keeps outside the event's turn (matched by thread, by the quoted message, or by the promise aid) records the message that kept it (`ref`) and the event's `main_sends` gets the send (`matched`: thread, reply_to or jev) (002r, C07). |
| `receipt` | `run` (`run_id`) | the run's completion at the scheduler, once per scheduler run across every event: `receipt(run_id)`, or the lane's `./bin/btcc-receipt complete N` (`by: btcc-receipt`), whichever comes first. See "The scheduler receipt" below. |
| `main` | `handed` (`handoff`, `item`, `due_at`, `cls`, `what`) | the M1 item that carries it reaching `done` |

**A matter** (002q, B08): notify_joey and ask_joey take a structured `service` and `check`; together they are the line's matter (`subject` =
`<service>/<check>`, lowercased; never read from the text). Joey gets one line per matter and outcome across events and their follow-ups: a line
whose matter's last met line (any event; the fold over the records, latest `met_at`) has the same outcome is refused, the refusal names that event
and what it said, and this event's Joey line is settled `merged` (`into` = that event, `by: matter`): nothing is owed, so the stop does not ask for
it and the exit rule hands nothing to the main. A changed outcome is a raise. A line without `service` follows its event's own rule only. Joey line
fields: `subject`, `met_at` (when it was met).

The one rule: a lane's outbound call asks to meet an obligation of its event.
- Meeting an open one is accepted (`requested`), and it is `met` on the delivery result. Raising one (line → decision, or a line with another outcome) is accepted.
- Repeating a met or requested one is refused, and the refusal names what is still open.
- **One hand-over transition** (`events.handOver`, used by handoff_main, the exit rule and the thread stop alike): one `main` obligation opens and
  every lane obligation still owed (`joey`, `peer`, `receipt`) moves to `handed`. An event already handed keeps its hand-over (no second item).
  handoff_main hands the request itself (`request`, 002y X-3): a peer answer the lane's own reply_agent already met becomes that reply's `message` and
  a new answer to that peer is handed.
  Every hand-over tells the main 「處理完由你回報 Joey 一次」, so an event with no Joey obligation at all (a high-frequency routine, a task) gets one
  here: a `joey` line, `handed` (002q, T6-R: the main's report after a give-up hand-over met nothing and was on no event).
- **The main's replies and sends** are requests against the events whose items are bound to its running turn (M1: prompt → items → events). A
  reply's events are the quoted message's event when it quotes an item of the turn (`reply_to` = its message id), else **every** event of the turn
  whose Joey line is still owed (handed or open, or a ring nobody rang), hand-overs and Joey's own messages alike (002q, T7-R: one line answered
  three of Joey's questions and Eve's hand-over; 002p's "hand-overs first" bound it to the hand-over alone, silent). It meets their Joey line, rings a
  ring nobody rang, and each records the send; a reply that meets nothing records on no event (002p, A05). A delivered send_to_agent meets the
  answers they owe that agent. Nothing is matched by a parameter: the reply tool has no `handoff_id`.
- 002w (F, gap 14): a **lane's** line takes its tier from the class of the event it meets (`joeyRendering` → `metClass`: another event of the run's set
  has its record's `class`; the run's own event keeps the router's class of the run, the notify table's names), so
  Joey's message steered into a scheduled or peer run is answered at his tier; the lane's context block marks 嚴重警報 by its event's class, never for
  Joey's own message on a critical lane (2a936a7 read the run's class and the lane's flag).
- **The tier** of such a reply is the highest the obligations it meets require (design/notify 「類別 × 義務 × 結果」): Joey's own message
  requires an ordinary answer (push), a ring nobody rang a push, a lane's event handed to the main its class's tier (a push class whose ring already
  rang is silent). A reply that quotes a message is ordinary. A reply that meets nothing takes the highest tier of the turn's events.

**The scheduler receipt.** A lane has two ways to complete scheduler run N: the receipt tool, and the scheduler card's CLI
`./bin/btcc-receipt complete N`. Both are one request, handled in one place (lanes.ts `completeRun`): meet the event's `receipt` obligation for run N,
then call the scheduler. The lane guard hook (lane-guard-hook.py, PreToolUse on Bash) does not let the CLI run: it posts the request to
`POST /lane-receipt` with the run's token and denies the Bash call with the daemon's answer. The first request completes the run; any later one, by
either path and from any event, is refused ("already completed"). `./bin/btcc-receipt ack` is not a completion and runs as it is. Without the daemon
the hook still denies the CLI. So the daemon is the only thing that completes a run at the scheduler for a lane.

002w (D, gap 17): a receipt handed to the main (the exit rule, a hand-over, an event the router gave the main) is the main's. The main has no lane
guard: its own `./bin/btcc-receipt complete N` reaches the scheduler. At the PostToolUse of that Bash call the daemon meets the receipt for run N that
the main owes (`mainToolDone` → `meetReceipt`, the same request/result transition as a lane's completeRun, by `main (btcc-receipt)`); the main's Stop
check names a receipt still owed (step 2 of the main's Stop).

**Stopping a conversation** (002w C) is one function, `stopThread`: the event record's `stop`, the thread `stopped` and its queued peer events drained,
the router's stop notice to the peer (marked no_reply, the `stop-notice` obligation), and the one hand-over of the event to the main. Every place that
stops a thread goes through it: the router's thread gate on an inbound message (hop limit, thread budget), and **the one outbound gate**
(`outboundGate`), which decides every send on a thread: a lane's reply_agent, the router's interim (interimToPeer), and the main's send_to_agent (the
inbox daemon asks `POST /lanes/outbound-check` with `{thread, hop, no_reply}`). A send past the hop limit stops the conversation there (for the main's
send, the event answered is the newest message the peer sent on that thread). A `no_reply` send passes a stopped or over-limit thread and counts no hop:
it asks for nothing, so it cannot extend the loop; that is how the main's closing answer, marked no_reply at its PreToolUse, reaches the peer. Before
002w a lane's reply_agent past the limit only marked the thread stopped (no `stop`, no notice, the event handed over when the run ended), the main's send
past it was only refused, the interim skipped silently (gap 15), and the inbox daemon refused any send on a stopped thread, the main's no_reply answer
included (gap 1).

**The lane stop.** The lane's Stop hook (lanes-hooks/lane-stop-hook.py) posts to `POST /lane-stop` with its run token (`LANE_RUN_TOKEN`; the port
is `LANES_HTTP_PORT`, set by the daemon in the lane's environment). The daemon blocks once with the open obligations, or lets the run end.

**The exit rule.** When a run's work ends, at whatever reason (`runEnded`, 002w A), the open obligations of its event set (its event, what rides in
it, Joey's messages steered into it) go to the main by the one hand-over transition, one per event, plus one M1 item each.

**The ring.** A critical event rings Joey once. The first line about it that reaches Joey with a ring meets the ring: the lane's `notify_joey` or
`ask_joey` (the obligation is `met`), or the main's report on the event's hand-over (`rang`, `by: main`). If none has by `due_at`, the due sweep
rings (`rang`). Handing the event to the main, by `handoff_main` or by the exit rule, does not take the ring away from the router. Every later line
about the event goes out silent: a lane line (tier rule `+rang-at-due`) and the main's report in a turn bound to it (`+rang`).

**The due sweep** runs every second. It acts on open obligations past `due_at`:
- a critical line: the router rings once (`rang`), unless a line that rang reached Joey first;
- a hand-over, a promised answer, an answer handed to the main (002w), a commitment: Joey is told once (`told`).

A `main` obligation is due 300 s after the hand-over (`LANES_HANDOFF_FALLBACK_MS`). The sweep acts only on the `due_at` an obligation got when it was
created: nothing rewrites it, so a main that is away makes nothing due early (what was given to it waits; the wall or stuck notice told Joey once),
and Joey's own messages to the main have no `due_at` at all.

WO-201 (point 5; inventory L18): while the main cannot act (its M2 record `walled` or no live gen, or the status record's member `walled` or `offline`),
a `main` obligation's push (`handoff-due`, and a card's `card-due`) is not made: the wall's entry notice already told Joey that the main's items are kept
(1.59.0 pushed them with 「（主線現在不能用模型）」 / 「（主線現在不在線）」). Its clock pauses rather than restarts: back, and still not handled, it is pushed at
`due_at` + the time the sweep saw the main unable to act since the obligation began (kept in memory: a span before a daemon restart is not known, so the
push can come earlier, never while the main cannot act). `critical-due`, `answer-due`, `promise-due` and `commitment-due` are unchanged.

### `wake` (M4): a decision, logged

`id` is an item id or an event id. `state` is `wake` (M1 offers the item: the main was idle and something is owed to it) or `no_wake`. `reason` says
which: information, the main in a turn (the item is pulled at its next boundary), the main walled or gone, or the event owes nothing.

### `run` (M5): one record per lane run

| state | meaning |
|---|---|
| `queued` | waiting for a slot. Fields: `ev` (the event, without its channel payload), `priority`, `summary`, `enqueued`, `extra` (messages riding in it), `deaths`, `not_before` (the backoff after a death), `steered` (002w: Joey's messages steered into an earlier run of it) |
| `leased` | picked: `run` (the lane run id, e.g. `adam.reflex.3.r2`) |
| `running` | spawned: `pid`, `budget` (the thread's budget state as the run starts); a later `running` line adds `steered` when the steer hook hands Joey's message over (002w) |
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

**The end of a run (002w A) is one function, `runEnded`** (lanes.ts). Every way a run ends goes through it: the exit handler (every `reason`
above), a run the daemon restart cut (`restore`, at boot), and a queued run refused before it starts (`budget`, `closed`, and `gone`: its lane is no
longer in the state). The branches of the exit handler, restoreRuns and startRun's refusals no longer decide anything: each records what the run
reached (its ledger lines, its `deaths`, the hand-over text) and calls it. It works over **the run's event set** (`runEvents`): the run's event, what
rides in it (`extra`: a peer's coalesced messages, alert repeats, Joey's messages a run never reached), and every Joey message steered into a run of it
(`steered`, E18). `steered` is on the run record: the daemon writes it (a `running` line with `steered`) when the steer hook hands a message over, the
`queued` line of a re-run carries it, and restoreRuns reads it back. The lane stop, the exit rule, `runAgain`, the event a Joey line answers
(`joeyEventOf`, `replyEventFor`) and the owner-relay check (`byJoeyRun`) read this one set; the run token no longer holds a list of its own. Before
002w a re-run, a wall or a daemon restart dropped the steered messages (their Joey line was never asked about, never handed over, and the re-run's
line went to the run's own event: gap 2), and `extra` was read by nobody (gap 3).

What `runEnded` decides, in order:
- **The re-run**: `died`, `timeout`, `restore` and `wall:*` are retryable. The run is queued again while its event set still owes the lane something,
  or its task lane still owes its task (`runAgain`; `taskOwed` below). A wall is not an attempt (the attempt count goes back, no backoff); a death or
  a timeout waits `attempt × LANES_RETRY_BACKOFF_MS`. 2a936a7 re-queued a walled run whatever it owed (002v round 1 G07, gap 5).
- **The lanes' wall**: up on a wall; down on any other end of a run that reached the model (it wrote a result record or made a model call). 2a936a7
  took it down on a `normal` exit only: a probe that got through and then died, timed out or hit a cap left `pump` paused until the next backoff
  (gap 12). A refusal before the run and a restore never reached the model and move nothing.
- Otherwise (not retryable, nothing owed, or after the third attempt) the run's work has ended:
  - **a task lane's own duty** (`endTask`), when its closing call never came (`taskOwed`: a fan-out part without `report_result`, a synthesis
    without `deliver_synthesis`, a curator holding the write right without `curator_done`): the part's result is what it reached, or 「沒有結果」, so
    the synthesis starts (gap 6: only report_result, a cap and the last death did it); the synthesis hands what it reached to the main, the one
    hand-over with a `carry` item (gap 6); the curator gives the write right back (`curatorEnd(…, 'ended')`) and the main is told once, by the one
    hand-over of the curator's event (gap 7). `closeLane` does the same for a curator lane with no run going (a running one ends through its run);
  - **the exit rule** over the event set: each event that still owes is handed over as itself. A run whose lane is gone goes through it too (gap 22:
    it used to end with no decision at all).

What happens next:
- A wall is not an attempt: the event is queued again as it was (while its set owes something), and the shared wall goes up.
- A death or a timeout is run again after `attempt × LANES_RETRY_BACKOFF_MS`, while the event still owes something. After 3 attempts, the exit
  rule hands what is open to the main.
- **An attempt's record** (002q, G06): the run keeps every tool call with its result. A death adds to the run's `deaths` (on its next `queued` line)
  `{run, how, after_s, calls, steps, last_text, stderr}`, where `steps` = the attempt's calls in order (the last 10), each
  `"<tool> \`<input>\` → <result, 160 chars>"` or `"… → （沒有結果：死在這一步）"`. It replaces 002m's `last_tool` / `last_result` (the last call only:
  the main re-ran the status, logs and snapshots the first attempt had read). The give-up hand-over lists every attempt's steps, within M1's
  item body (3800 characters).
- At boot, a run left `leased` or `running` died with the daemon. It gets `exited(died, signal daemon-restart)`, its lanes.jsonl exit row and a
  lane_lifecycle ledger line, and its event runs again **only while it still owes the lane something** (002q, T6-R).
- **A restart is one record from its send** (002y, X-2; 002x G05 r1-r3: God killed the lane after `./bin/svc POST mock-api/restart` reached the
  service and before its result; 002m wrote the ledger action only when the command returned, so the re-run found none and could not tell whether
  it had restarted). A Bash restart (`restartCommand`) writes its ledger action when the command is sent: 「restart <svc>（已送出，結果還沒回來）」,
  `refs: {restart, state: sent, record, cmd, run}`; the running run's record carries it in `restarts` while it is out. One more line settles it
  (`refs.settles` = the record): `ok` / `failed` (「（沒有成功）」) when its result comes back; `unknown` (「（結果不明：送出後這一趟…，結果沒有回來）」,
  `ok: null`) when the run ends without it (it died, timed out or was stopped), and at boot for a run the daemon stopped with a restart out.
  The ledger stays append-only; ledger_query folds a settling line into its record (`foldSettled`): one entry per restart, at the time it was
  sent, with its last settlement, so runbook §4's count is one per restart.
- One rule decides every re-run (`runAgain`), a death, a timeout, a wall and a daemon restart alike: an event of the run's event set still has an
  obligation the lane owes, or the run's task is not done (`taskOwed`). Otherwise no new run, and the exit rule writes a `wake` line `no_wake` with
  "owes nothing more". 002p re-ran a closed event after a daemon restart, and the lane, finding everything done, ended without a line.

**Busy** is "the lane has a queued, leased or running record" (`laneBusy`). The journal is the queue: there are no queue files.

## The route record

One function (lanes.ts `routeRow`) writes every route record: a line of `<lanes dir>/routing.jsonl` and the same row to Logos as `lane.route`. That
holds for every rule: the router's own decisions, and the follow-up, coalesced, thread-stopped-drain, fan_out, fan_out-synthesis, open_worker,
fork, curate_memory, master-on/off, digest and registration rows. A row has `event`, `rule`, `target`, `lane`, `note`, and:
- `thread`: the owner's thread, i.e. the conversation the event belongs to after routing (the lane's thread, the thread a stop closed, the main's
  thread); `peer_thread`: the thread the sender supplied;
- `followup` on a follow-up row (its `event` is the origin event), `into` on a coalesced row, `episode` on a gated row.

The conversation a message belongs to (`thread_known`, rule `mesh-thread`): the thread it names, else the message it quotes (`reply_to`): one we sent
(its owner's thread), or, since 002p (A05), one **the same peer** sent us earlier (the thread the router put that message in; its owner now). A
peer's follow-up to its own question is therefore a run on its origin event's lane and thread; queued behind that lane's running run, follow-ups of
the same peer are its next run together (`coalesced`). Another peer quoting it is a new conversation.

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
affected by what the digests showed. It shows each record's text whole (`did`, `result`, `said`, `text`, `promised`, a hand-over's `what`: each is
bounded when it is written). A digest line keeps its budget, but a text longer than it ends at a sentence or clause (。；; ！？), never inside one,
followed by 「…（其餘見 ledger_query()）」 (002q, T1-R: the line cut a lane's `did` just before its restart, and the main told Joey there had been none). The main's own events are in neither view. A filtered `ledger_query(kind=…, text=…)` searches ledger.jsonl:
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

memory-commit-hook.py keeps its own registration (PostToolUse on Write and Edit). 002w (G, gap 21): its `commit(p, file)` is the one memory commit;
main-hook.py calls it at the main's final Stop with no file, and everything the turn changed under the memory dir is committed (a Bash or NotebookEdit
write included: 2a936a7 committed Write/Edit/MultiEdit only). The PreToolUse timeout is 30 s because the summary gate's Jev
calls (`SUMMARY_GATE_JEV`, `MAIN_REPLY_CHECK`, `TYPESAFE_*` must be in main-hook.py's environment) run inside it.

Do not register main-summary-gate.py, main-answered-gate.py or main-memory-gate.py as hooks of their own (run alone, the first two do nothing
unless their input carries `turn`). main-hook.py runs them at Stop, after it has asked the daemon
to pull. That way a Stop that some aid holds is never counted as the end of the turn. A Stop hook the plugin does not own (the user's) can still
block a Stop main-hook.py let through: the daemon re-opens that turn at its next event ("A turn ends at its last Stop").

Environment the hook needs. The keeper already sets these for the main:
- `TELEGRAM_HTTP_PORT`: the tg daemon's port.
- `MCP_TOKEN_DIR`: where the loopback token is, if it is not `~/.claude/agent-inbox/mcp-tokens`.
- `CLAUDE_PID`: set by Claude Code itself. Without it, the daemon identifies the caller of `SessionStart` by its socket.

**Which process is at the other end** (002y, X-5): the daemons map each MCP session to its claude pid by the request's socket (`noteMcpSocket`,
`callerClaudePid`: the socket's process, then up its parents to the first claude), and keep one live process per session id (`sessionHolder`:
the argv of every process). Every such fact comes from one platform layer, `lanes-proc.ts`, a function per fact: `peerPid(clientPort,
serverPort)`, `parentPid`, `argv`, `exe`, `sessionPids`. Linux reads `/proc` (`/proc/net/tcp*` + `/proc/<pid>/fd`, `stat`, `cmdline`, `exe`), as
before. macOS (the fleet's Macs, which have no `/proc`: through 002x no MCP session there was mapped to its pid, so the main was never offered
anything) asks `lsof -nP -w -iTCP:<clientPort> -sTCP:ESTABLISHED -Fpn` (the end whose local port is the client port), `ps -o ppid= | command= |
comm= -p <pid>` and `ps -axo pid=,command=`, with `LC_ALL=C` and a 3 s timeout. A missing command, a failure, a timeout or an empty answer is
unknown, and unknown is not judged (a session whose process is not known is not judged not-the-main; a session id no known process names is free).
The answer for a connection is kept on its socket (a keep-alive connection carries many requests); an unknown one is asked again on its next request.
Another platform: every fact unknown. The macOS half is verified against recorded lsof / ps output (lanes-y-x5.test.ts), not yet on a Mac end to end.

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
- PreToolUse of `send_to_agent` (002w F, gap 18): the C16 claims check (`main-summary-gate.py claims(p, turn)`, the same function the reply's gate
  starts with) over the `turn` the daemon now answers for it too: its `deny`; else 002v's `updatedInput` with no_reply when the daemon marks it.
- PostToolUse: `additionalContext` with the items pulled into this turn.
- Stop: `decision: block` with the items pulled, or with an aid's reason.

How the main is registered:
- A `SessionStart` is accepted when its session id is `.lanes/main-expected` (written by the keeper), or the new session of a `/main renew`, or when it
  comes from the process of the live gen (`/clear`, `/compact`). The accepted session id is written to `.lanes/main-expected`.
- `/clear` (Claude Code 2.1.322): `SessionEnd` with reason `clear`, then `SessionStart` source `clear` with a new session id, same process. A
  `SessionEnd` with reason `clear`, or of a session other than the gen's current one, ends no gen (002v: it used to end it, and the new session was
  refused: nobody was the main until the TUI restarted).
- Any other SessionStart is refused. Joey is told once, and that process's MCP sessions lose the Telegram tools, and send_to_agent too (002w G,
  gap 19): the not-the-main check is one function (`notMainSession`) for both daemons; the inbox daemon, which knows each MCP session's claude pid by
  the same socket read, asks the tg daemon (`POST /lanes/not-main`, the M2 rule `pidNotMain`). A session that is not the main lists no send_to_agent and
  its call is refused (2a936a7: the inbox daemon judged nobody, and a second session's sends were filed as the main's). A process that cannot be told
  apart, or a tg daemon that cannot be asked, is not judged.

The curator's memory writes (002w G, gap 20; design/memory MM5 「整理線只整理提案，不刪主線寫的內容」): while it holds the write right the lane guard
lets it write a new file, or Edit / MultiEdit when every edit's new text keeps the old text (a mark added next to it); a Write over an existing file, an
edit that removes text and a NotebookEdit are refused, with the way out (a memory_proposal 「建議刪除：…」 for the main). 2a936a7 let it write any file of
the memory dir; the rule was prompt text.

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
   not re-given. This is the owner's decision (002j, 5018d39), kept as data. That line is on the events it names (002q, T8-R): delivered, it meets
   each one's Joey line (`router_sends`). It names only the cut items whose Joey line is still owed (002y, X-4); one the main already answered is
   closed without it, and with none owed there is no line.

2. **The TUI relay's wall line** (`wallKind`). The relay (system-alert.ts, fleet code that stays) forwards the CLI's own error line from the
   main's pane or transcript. Deferring it to the one wall notice (002l D12) means recognising that line; no signal carries it. This is
   wallKind's only use: a lane's wall kind comes from its result status, the main's from StopFailure.

## Stuck (疑似卡死)

This is M2 only. The tg daemon checks every 5 s. A gen owes a hook event while a turn is open (`in_turn`) or
while an item offered to it is not bound yet (`idle` or `walled` with an `offered` item). An open tool call is work for as long as that tool is
bounded (P14, refined in 002q): main-hook.py sends a Bash call's own timeout with its PreToolUse (`tool_timeout_ms`), and the silence allowed while
it is open is the larger of `LANES_MAIN_STUCK_MS` and that bound (with a margin). A tool that declares no bound, such as an MCP call, is silence
like any other. The gen is stuck when it owes a hook event and has sent none for longer than that; the silence counts from its last hook event, or
from the offer when that came later. The alarm names the open tool.
- One alarm per episode. The limit-menu pane read says whether a menu is the reason (an idle or walled gen; since 002y, X-1, a gen in its turn
  too: a limit menu there is the main-wall mechanism's, not the watchdog's, and with no StopFailure this alarm is what puts it in front of Joey).
- **The episode is M1's recovery signal** (002q, H02/H03: a notification lost on the client side under host load stayed lost, and the play never
  started): when the alarm fires on an idle or walled gen with an offer it never bound, those items go back to `queued` (`reason: stuck_unbound`)
  and M1 offers again at once (a walled gen on a new keeper clear). Once per episode, no timer of its own. The alarm says so (「我再交給它一次」).
- **The offer has its own bound** (002x; 002w r1 A05 and r2 I04: an offer written half a second after the gen's stream opened was never bound and
  waited for the stuck episode, which is ten minutes outside the lab): an idle gen's offer still unbound after `LANES_OFFER_LEASE_MS` of silence
  (20 s; the 1,304 offers of 002v and 002w were bound within 1.6 s) goes back to `queued` (`reason: offer_untaken`, `reoffered: <gen>`) and M1
  writes it once more, telling nobody. An item the lease has written again is not written a third time at the episode; the alarm then says
  「已經再交給它一次，還是沒有被接手」.
- The next hook event of the gen clears it, and Joey is told once. A later silence is a new episode.
- **Owed items nobody can take** (002w E, gaps 4, 11) are an episode of the same rule: owed items queued for longer than `LANES_MAIN_STUCK_MS` while
  there is no live gen (「主線不在」), or while the live gen is `idle` or `starting`, holds no offer and could not be offered them (its stream is down:
  「主線收不到訊息」). One alarm per episode with the queued count (`main-undelivered`); the next delivery (an offer written, or items bound or pulled into
  a turn) ends it and Joey is told once (`main-delivered`). M2 stores the opening time in milliseconds as `undelivered_since` on the
  current or last registered gen. Before the first registration a `gone` record named `unregistered` holds it. A new gen inherits the
  field, daemon startup restores it, and delivery clears it on the latest gen. Silent-gen episodes keep their in-memory lifetime.
  2a936a7 counted only a gen in a turn or holding an offer:
  a stream that never opened, or no main at all, left Joey's messages waiting with nobody told (his own messages have no `due_at`).
- Nothing else moves this clock: a frozen main (SIGSTOP) is alarmed once and re-offered once; it gets what was written into it when it runs again.

## 002w, after 002v's round 3: two more paths of duties already owned

- **One receipt per scheduler run, the main included** (duty D22, the receipt; 002v r3 T3-R, u002v-T3-a-r3-20261120-081010: a lane completed
  run 62 through the daemon and the main completed it again 9 s later with `./bin/btcc-receipt`; two receipts reached the scheduler). The lane
  path was already the daemon's (the lane guard hands the CLI to `/lane-receipt`, `completeRun`). The main's path is now asked too: at the
  main's PreToolUse of a Bash call that carries `btcc-receipt`, main-hook.py posts the command and the daemon's `mainToolGate` answers `deny`
  when run N's receipt is already met or being sent, or is still a lane's to send; it lets the call through when the main holds the receipt
  (handed to it: met at PostToolUse, `mainToolDone`) or when no event of the router carries run N. The hook prints the deny.
- **A fork's result does not go back through a hand-over** (overview.md 「複製之後各走各的，不會自動合回去」; 002v r3 F03,
  u002v-F03-s5-r3-20261120-075430: the fork called handoff_main with its result and the main stopped to relay it). `handoff_main` from a
  lane of kind fork is refused, with the words that say what to do (notify_joey, or ask_joey; the main reads it in the digest), and the
  fork's lane context says it has no handoff_main. What a fork still owes when its run ends goes to the main by the exit rule, as for any lane.

## 002x: one promise record

002w round 1, C07 (u002w-C07-s3-r1-20261120-125819). 002w's F put every found promise on "the event the send is about" as a bare text in the
event's `promised` list. For the main's send to Eve in a turn Joey's message opened, that event was Joey's message (no thread): the promise could
not be found by the conversation it was made in (the level's check, and anyone asking "what did I promise Eve on this thread"), the digest called it
「車道答應」, and the mirror record changed name (`lane.main_commitment` to `lane.commitment_auto`) so the lab saw nothing. The main's report to Joey
(「已回 Eve：Joey 答應，週五前會有人做好」: 0.16 / 0.91) was recorded as a promise to Joey.

- **`recordPromise` is the one writer** of an event's `promised` list, for the four ways a promise is found (the outbound check, a lane's commitment
  tool, its ledger_write kind commitment, its receipt's `promised`). An entry is a record: `{text, by, to, thread, at, ref?}` (`by`: the lane id or
  `main`). Journals before 002x hold bare texts; `promiseOf` reads both.
- **Which event:** the event of the conversation the promise was made in. For the main's send that is the peer's newest message on the send's thread
  (`threadEvent`), when the thread is known: named by the send, quoted (`reply_to`), or one the main owes on (a promise, a hand-over). The peer's newest
  live thread is a guess (`peer-thread`) and is not used; then, and with no conversation at all, it is the event the turn works on. A lane's promise is
  on its run's event, whose thread is the lane's.
- **To Joey only the speaker's own promise counts.** The second question (a deadline passed on, whoever does it) records a promise made to somebody
  else on the owner's behalf; told to Joey it is his own decision coming back.
- Readers: the digest and activity list say whose promise it is (「主線答應」 / 「車道答應」); the /main renew brief lists the texts.


## lanes-golive: who owns what on the fleet (one entrance into the main)

With `GENESIS_LANES=1` each duty below has one owner. With lanes off none of this runs and the fleet paths are exactly 1.33.2's.

| Duty | Owner | Not |
|---|---|---|
| Deciding where an inbound item goes (Telegram, /inject, an Onsen item, wake-up line, parked delivery) | the router, `routeEvent` in the tg daemon; the agent-inbox daemon asks it (`/lanes/route`) through `laneDeliverMesh` (server.ts) | `dispatchInbound` building a Telegram event from a mesh notification |
| Writing anything into the main session | M1 (`lanes-main.ts`: offer when idle, pull at a boundary, re-offer after `OFFER_LEASE_MS`) | `broadcastNotification`, the disk replay (they run only when no router can be asked: `laneDeliverMesh` fallback) |
| Taking what is sent to the agent | the agent-inbox daemon's Onsen pull (`onsen-inbox.ts`, `deliverPulled` → the same delivery as /inject); hub sync (BTCC `/api/mesh/inbox/pending`, doorbells) was removed in 1.52.0 (WO-158) | |
| Knowing the main has a delivery | M1 `bound` (the main's turn took the item); `mainTookItems` sends a scheduler run's start receipt (ack) once | `receipt.ts` / `recordDelivery` / `sweepDeliveries` (fallback broadcasts only) |
| A run a lane takes | its start receipt when the router gives it to the lane (`laneDeliverMesh`: `maybeAutoAckScheduled`), its completion by `receipt(run_id)` / `btcc-receipt` (one per run, `toolGate`) | |
| Parked deliveries (`inbox/pending`) | the timer drain hands each back to the router (`laneRedeliver`) | replaying them into whichever session is open |
| Wake-up lines (keep-warm, STALL / RESTART / resume, 讀信箱) | the delivery watchdog sends them (Epeius; keepwarm-local on MBP / txmonster); the router gives each its fixed destination (`routeWake`: the main, or the mail lane) | the `mesh-no-reply` rule (ledger) |
| Reading mail | the mail lane (`routeMailWake`, mailbox tools through `/lanes/mail-tool`: fleet-mail.ts with the agent's credential); what it cannot judge it hands to the main | the main on a wake (it gets only the digest) |

## lanes-topics: work topics in Joey's private chat (1.35.0)

Measured 2026-11-23 in a real client (lanes-topics.ts has the facts): a bot message is shown inside a topic only when it carries
`message_thread_id`; `reply_parameters` alone lands outside the topic although the API's answer names it.

| Duty | Owner | Not |
|---|---|---|
| The bot's topic mode | one decision: `topicModeAtStart` (lanes-topics.ts) at start (`enable` sends `has_topics_enabled=true` and `allows_users_to_create_topics=false` in one call and checks both with getMe; `auto` changes nothing and warns once on the broken mode); `topicVerdict` over a fresh getMe each time a worker opens (`LanesDeps.topicsUsable`) | a worker topic opened while the user can open topics |
| The topic of an outgoing Telegram message | `targetTopic` (lanes.ts), asked by `topicFields` (server.ts) on every send path: the main's reply (each chunk, rich or plain, each file), the typing action, lane lines and router notices (`sendBot`), daemon-answered commands (`/lanes`, `/main`, control slashes, button taps) | a send that builds `message_thread_id` itself |

- **state.json `msg_topics`**: `"<chat>:<message id>"` → thread id, or `null` (outside topics). Written for Joey's Telegram messages as
  the router takes them (`routeEvent`) and for the bot's own sends (`noteSent`); the newest 3,000 are kept. Joey's messages are also in
  this journal (the event record's `tg.topic`), which `knownTopic` reads when the map does not have the id (an older message, a lost
  state.json).
- **state.json `topic_names`**: thread id → name as last known (the bot's own createForumTopic; the topic's creation or edit service
  message; the creation message a message typed in a topic replies to). The `<channel>` meta of a message typed in a topic is
  `topic="<id>"` and, when known, `topic_name`; that creation message is not shown as a reply.
- The decision: an explicit topic (`reply(topic=…)`, `"0"` = outside; a lane's own topic; the topic a command was typed in) → the topic of
  the message answered (`reply_to`), when known, outside included → for the main's reply only, the one topic every Telegram item of its
  turn is in (`mainTurn`: the items' events with a `tg` record) → none.
- **A worker lane's topic** (state.json `lanes[<id>]`): `topic_name` as stored (emoji dropped first: the server drops them from a name and
  still answers true); `topic_close: "pending"` from the close (the main's `lane_close`, Joey's `/lanes close`) until the ✅ icon and the one
  closing line went (`topic_done`: when). A close a restart cut off is finished at boot; a lane closed by an older version has neither field
  and is left alone. The topic is never deleted; once closed it is no longer in `topics`, so what Joey types there goes to the main.
- **A worker lane's anchor file** (`lanes[<id>].anchor`, relative to the workspace: `knowledge/lines/<slug>.md`): assigned and created (only if
  absent) when the lane opens, with the title, the topic, Joey's words of the opening turn and the brief. lane-guard-hook.py reads this field:
  the open worker lane may write that one path under `knowledge/` and nothing else there. The main lists it in `knowledge/REANCHOR.md`.
- **The lane's model** (lanes.jsonl `spawn`: `model`, `model_from`): worker and fork lanes `LANES_MODEL_WORKER` → the main's last genuine
  assistant record's model → `LANES_MODEL`; the other kinds `LANES_MODEL`.
