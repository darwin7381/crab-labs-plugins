// Onsen step 3 (WO-143): the Telegram daemon records facts only. Nothing here changes what is delivered, to whom or when; nothing is shown on Telegram.
//
//   DeliveryFacts  delivered / in_session / seen / turn_end of each of Joey's messages (one per message and state; the first recipient wins at Onsen),
//                  spooled through OnsenClient.recordDelivery behind the message's own record. WO-165: seen = it entered a turn; in_session = it was
//                  handed to the session (until WO-165 that moment was `seen`).
//   StatusFacts    the main's status: every change of the state or the detail at once; last_activity_at moving alone at most once per 1 s, always the
//                  latest (a trailing write); nothing new for 15 s: the same again (WO-162: the heartbeat, detail.heartbeat_s).
//   statusOf       1.45.1: the one rule that turns a source's inputs into the status: offline / idle / busy / waiting / stuck.
//   Registry       1.45.1, the source of the state (a StatusSource): Claude Code's own session registry (~/.claude/sessions/<pid>.json, what
//                  `claude agents --json` reads), checked against that CLI at start and every 10 min; the CLI is read instead when they disagree.
//   LanesTap       lanes on: reads the lanes journal (M1 items, the main's M2 row, lane runs) and the main's hook events; it changes nothing in them. For the
//                  status it gives detail only (the tool, the subagent count, a compaction, the main's own wall).
//   TurnWatch      lanes off: no hook reaches the daemon, so the main's turns are read from its transcript (turn_duration ends a turn; tool_use / tool_result
//                  open and close tools), the file the daemon already reads for receipts. For the status: detail only.
import { spawn, spawnSync } from 'child_process'
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, watch, writeFileSync, writeSync,
  type FSWatcher } from 'fs'
import { basename, join } from 'path'
import { idemDelivery, idemStatus, type CallLineFate, type CallRef, type CallStateLine, type CallStateName, type DeliveryFact, type DeliveryState, type RunCallLookup, type StatusFact, type StatusState } from './onsen-client.ts'
import type { Row } from './lanes-state.ts'

type Now = () => number
const iso = (ms: number): string => new Date(ms).toISOString()
const k2 = (chat: string, id: string): string => `${chat}\u0000${id}`

// ------------------------------------------------------------------ delivery facts
/** WO-172 / WO-171 (Onsen 0.16.0 delivery_events turn_id, outcome, bound: top-level fields of a fact, not its detail; Chiron WO-171 01:52Z): the turn
 *  a seen or turn_end fact belongs to (the observation's sessions[].turn.id: the main's prompt id, lanes off `turn-<ms>`, a lane's run id), and on
 *  turn_end how that turn ended and what was bound into it */
export type TurnFields = { turn_id?: string | null; outcome?: TurnOutcome; bound?: string[] }
const turnFields = (t?: TurnFields): Partial<DeliveryFact> => !t ? {} : { ...(t.turn_id ? { turn_id: t.turn_id } : {}), ...(t.outcome ? { outcome: t.outcome } : {}),
  ...(t.bound ? { bound: [...t.bound] } : {}) }
/** WO-197: the `by` of the turn_end of a message the daemon handled itself (DeliveryFacts.handledHere): not main, not a lane */
export const HANDLED_HERE = 'daemon'
/** WO-177: the member states of a record that shows the main's turn still running (a Stop another Stop hook pushed back) */
const TURN_RUNNING: ReadonlySet<string> = new Set(['busy', 'stuck', 'compacting'])
export class DeliveryFacts {
  /** idem keys spooled by this daemon (bounded): each fact is written once per daemon life; across lives Onsen answers duplicate */
  private sent = new Map<string, true>()
  /** an album: the first message's id (the one the delivery carries) → every message id of it */
  private groups = new Map<string, string[]>()
  /** the main's turn closed these at a Stop (stopMs: when); written when the status record shows that turn over (turnOver), or a new turn began
   *  (flushLater). WO-172 (Chiron 02:43Z; WO-177 1.58.3): no timer. Until 1.58.2 they waited ONSEN_TURN_SETTLE_MS (60 s) in case another Stop hook held
   *  the Stop, and Onsen showed every normal turn's message 「not done」 for 15–60 s. A turn another Stop hook pushed back keeps the record busy (the
   *  screen shows it going on), and its next hook event takes the fact back (cancelTurnEnd, turn_continued) */
  private later = new Map<string, { chat: string; id: string; by: string; at: string; detail?: Record<string, unknown>; turn?: TurnFields; stopMs: number }>()
  /** Joey's messages taken in and not yet into a turn (lanes off: the queued count). session: handed to the session (in_session), sessionAt when;
   *  turn: into a turn (seen, or WO-162's turnBegan for the count alone) */
  private open = new Map<string, { at: number; session: boolean; turn: boolean; sessionAt?: number }>()
  /** onSeen (WO-145, the ✍ reaction): every `seen` report (WO-165: the message entered a turn; in_session never calls it), for each message of it
   *  (an album: every item), the recipient named; a repeat too (the caller keeps its own once) */
  /** changed (WO-162): the queued count may have changed (a message taken in, written into the stream, into a turn, its turn ended): the status is
   *  computed again now rather than at the next 2 s tick */
  constructor(readonly o: { agent: string; sink?: (f: DeliveryFact) => void; now?: Now; max?: number
    onSeen?: (chat: string, id: string, by: string) => void; changed?: () => void }) {}
  private now(): number { return (this.o.now ?? Date.now)() }
  private changed(): void { try { this.o.changed?.() } catch {} }

  /** the album's messages: what happens to the first (the one delivered) happens to each */
  album(chat: string, ids: Array<string | number>): void {
    const all = ids.map(String).filter(Boolean)
    if (all.length < 2) return
    this.groups.set(k2(chat, all[0]!), all)
    if (this.groups.size > 500) this.groups.delete(this.groups.keys().next().value!)
  }
  private idsOf(chat: string, id: string): string[] { return this.groups.get(k2(chat, id)) ?? [id] }
  private emit(chat: string, id: string, state: DeliveryState, by: string | undefined, at: string | undefined, detail?: Record<string, unknown>, turn?: TurnFields, retry?: string): void {
    for (const mid of this.idsOf(chat, id)) {
      const idem = idemDelivery(this.o.agent, chat, mid, state) + (retry ? `:after:${retry}` : '')
      if (this.sent.has(idem)) continue
      this.sent.set(idem, true)
      if (this.sent.size > (this.o.max ?? 20_000)) for (const k of [...this.sent.keys()].slice(0, 5_000)) this.sent.delete(k)
      try {
        this.o.sink?.({ idem_key: idem, agent: this.o.agent, client: 'telegram', chat, client_msg_id: mid, state, at: at ?? iso(this.now()),
          ...(by ? { by } : {}), ...(detail && Object.keys(detail).length ? { detail } : {}), ...turnFields(turn) })
      } catch {}
    }
  }
  delivered(chat: string, id: string | number, at?: string): void {
    const s = String(id)
    this.emit(chat, s, 'delivered', undefined, at)
    if (!this.open.has(k2(chat, s))) this.open.set(k2(chat, s), { at: this.now(), session: false, turn: false })
    if (this.open.size > 2_000) this.open.delete(this.open.keys().next().value!)
    this.changed()
  }
  /** WO-197 (Chiron, WO-197 15:45Z: Joey's /clear to nestor, prometheus, hephaestus, Onsen 43345 / 43357 / 43369, stayed at accepted_at, not_started):
   *  a person's message the daemon handles itself (its own command, a permission reply) is never handed to a session. took: the daemon took it
   *  (delivered, at that moment), not counted as queued (a message that turns out not to be the daemon's own goes on and is counted by delivered()) */
  took(chat: string, id: string | number, at?: string): void { this.emit(chat, String(id), 'delivered', undefined, at) }
  /** WO-197: its handler finished: turn_end with how (done; failed: the handler threw); Onsen's receipt: handling completed / failed, started_at null
   *  (no turn read it), read_at null. `by` HANDLED_HERE, not a session: Onsen reads a session's later turn_end (main, a lane id) as that session having
   *  moved on, and would end the main's running message with it. No turn, nothing bound. detail.handled_here: which path */
  handledHere(chat: string, id: string | number, outcome: 'done' | 'failed', how: string, at?: string, turnId?: string | null): void {
    // WO-197 (round 3A): the turn its answer was sent in (Onsen links the messages of that turn to it: response_message_ids)
    this.emit(chat, String(id), 'turn_end', HANDLED_HERE, at, { handled_here: how }, { outcome, ...(turnId ? { turn_id: turnId } : {}) })
  }
  /** WO-165: handed to a session (lanes off: written into the main's stream, where Claude Code may queue it; lanes on: M1 offered it, or bound it at a
   *  boundary; a lane run started with it). Not seen: the ✍ waits for seen */
  inSession(chat: string, id: string | number, by: string, at?: string, retry?: string): void {
    const s = String(id)
    this.emit(chat, s, 'in_session', by, at, undefined, undefined, retry)
    for (const m of this.idsOf(chat, s)) { const e = this.open.get(k2(chat, m)); if (e) { e.session = true; e.sessionAt = this.now() } }
    this.changed()
  }
  /** WO-165: it entered a turn (lanes on: M1 bound it to a prompt, a lane run started with it; lanes off: the main's transcript shows it taken in, as
   *  the prompt of a turn or absorbed mid-turn). Until WO-165 this was the in_session moment. quiet: the fact only, no onSeen (the transcript's tail
   *  read again at start: a message taken in before this daemon began) */
  seen(chat: string, id: string | number, by: string, at?: string, quiet = false, turnId?: string | null, retry?: string): void {
    const s = String(id)
    this.emit(chat, s, 'seen', by, at, undefined, turnId ? { turn_id: turnId } : undefined, retry)
    for (const m of this.idsOf(chat, s)) { const e = this.open.get(k2(chat, m)); if (e) { e.session = true; e.turn = true } }
    if (this.o.onSeen && !quiet) for (const m of this.idsOf(chat, s)) { try { this.o.onSeen(chat, m, by) } catch {} }
    this.changed()
  }
  /** WO-162 (1), lanes off: a turn of the main began at `at` (ms; the registry's statusUpdatedAt of its busy). What was written into its stream by then
   *  is what that turn took in: a session that starts a turn takes in what waits in its queue. The transcript shows it one read later; until now the
   *  first status row of every turn counted the message being answered as queued (Chiron's lab, 28/28). slackMs: the daemon notes in_session right
   *  after the write, Claude Code writes its busy after reading it. The queued count only: the seen fact waits for the transcript (WO-165) */
  turnBegan(at: number, slackMs = 100): void {
    for (const e of this.open.values()) if (e.session && !e.turn && e.sessionAt != null && e.sessionAt <= at + slackMs) e.turn = true
  }
  turnEnd(chat: string, id: string | number, by: string, at?: string, detail?: Record<string, unknown>, turn?: TurnFields): void {
    const s = String(id)
    this.cancelTurnEnd(chat, s, by)
    this.emit(chat, s, 'turn_end', by, at, detail, turn)
    for (const m of this.idsOf(chat, s)) this.open.delete(k2(chat, m))
    this.changed()
  }
  turnEndLater(chat: string, id: string | number, by: string, at: string, detail?: Record<string, unknown>, turn?: TurnFields): void {
    const s = String(id), key = `${k2(chat, s)}\u0000${by}`
    this.later.set(key, { chat, id: s, by, at, ...(detail ? { detail } : {}), ...(turn ? { turn } : {}), stopMs: this.now() })
  }
  /** the turn went on after that Stop: no turn_end yet */
  cancelTurnEnd(chat: string, id: string | number, by: string): void {
    this.later.delete(`${k2(chat, String(id))}\u0000${by}`)
  }
  /** WO-172 / WO-177 (Chiron 02:43Z: 「Stop 之後，狀態紀錄顯示這個回合結束了（idle，或開了新的回合）就送；被擋回去繼續做的，紀錄還是 busy，不送」): the
   *  status record handed out now (server.ts feed), as its member state (onsen-wake memberStateOf). A record that shows no turn running (none of busy,
   *  stuck, compacting) makes final what a Stop before it closed */
  statusRecord(member: string, atMs = this.now()): void {
    if (TURN_RUNNING.has(member)) return
    for (const l of [...this.later.values()]) if (l.stopMs <= atMs) this.turnEnd(l.chat, l.id, l.by, l.at, l.detail, l.turn)
  }
  /** a new turn began (or the daemon stops): what waited to settle is final */
  flushLater(by?: string): void {
    for (const l of [...this.later.values()]) if (!by || l.by === by) this.turnEnd(l.chat, l.id, l.by, l.at, l.detail, l.turn)
  }
  pendingLater(): number { return this.later.size }
  /** Joey's messages taken in by the daemon and not yet into a turn (mode seen: the main's transcript is read) / not yet handed to the session (mode
   *  in_session: no transcript to read); older than 6 h: dropped. WO-165 renamed the modes with the facts; the counts are what 'taken' / 'seen' were */
  /** WO-169 (the observation's queue): Joey's messages not yet handed into the session / handed in and not yet in a turn */
  counts(): { pending: number; unread_by_member: number } {
    const old = this.now() - 6 * 3600_000
    let pending = 0, unread = 0
    for (const e of this.open.values()) { if (e.at < old) continue; if (!e.session) pending++; else if (!e.turn) unread++ }
    return { pending, unread_by_member: unread }
  }
  queued(mode: 'seen' | 'in_session'): number {
    const old = this.now() - 6 * 3600_000
    let n = 0
    for (const [k, e] of this.open) { if (e.at < old) { this.open.delete(k); continue } if (!(mode === 'seen' ? e.turn : e.session)) n++ }
    return n
  }
}

// ------------------------------------------------------------------ WO-175: the Calls this agent received
/** WO-175 (Chiron's ticket 一 and his 02:58Z ruling; Onsen contract v1 §4): the moments of each Call this agent received (a peer's call that is not a
 *  reply, a scheduled run, a paged alert, an urgent board item), as its daemon knows them, sent as PUT /v1/calls/<id>/state through the spool. One
 *  owner of the rules; the facts come from where they are decided:
 *    routed      the router gave it to a session (lanes.ts recordRoute): accepted, session main or the lane's full id; recorded only (no session):
 *                accepted with no session and completed at once, result 「只記錄，沒有交給任何一條 session」
 *    running     in a turn: the main's M1 item bound to a turn (LanesTap), a lane's run running (LanesTap)
 *    putBack     the main's turn was cut and the item went back to the queue: accepted (the one step back Onsen takes), only after running
 *    completed   the main's turn that took it ended (once the status record shows it over, as a Joey message's turn_end: completeLater / statusRecord;
 *                a turn that goes on takes it back: cancelLater); a lane's run ended for good owing nothing (lanes.ts runEnded), its summary as the
 *                result (a scheduled run's receipt outcome as result.outcome; a failed receipt: failed)
 *    handedOver  a lane handed it to the main (the event's main obligation opened: LanesTap; handoff_main, the exit rule): accepted, session main
 *                (the step back from running). Onsen 0.25.1 (35e5242) has one writer for a Call the daemon reports (calls.reported_at, set by its first
 *                accepted): it no longer takes state, session or result from the exit and wake rows, so the change of hands is ours to send; the main
 *                then holds the Call while it waits, and its turn reports running and the end as for any Call of the main
 *  A lane run that hands the item to the main sends no end: a change of hands, not an end. Only forward:
 *  a moment at or behind the last one sent is not sent again (a completed Call takes a result once more, when the first had none). */
export const CALL_LEDGER_RESULT = '只記錄，沒有交給任何一條 session'
export type CallResult = { outcome?: string; text?: string | null }
/** WO-175 (Chiron 05:55Z): what a receipt needs of the Onsen client (onsen-client.ts OnsenClient): what Onsen said to a spooled line, a run's Call */
export type CallClient = { callFate(idem: string): Promise<CallLineFate>; findRunCall(run: string): Promise<RunCallLookup>
  getCall(id: string): Promise<{ state: string | null; result: unknown } | null> }
/** a receipt as its Call's end: recorded (`resend`: the Call was there already), or why not (refused: Onsen's sentence; pending: Onsen did not
 *  answer within the wait, the line stays in the spool; nocred: no mesh credential; over: the Call ended otherwise) */
export type CallReceipt = { ok: true; state: string | null; resend?: boolean } | { ok: false; fate: 'refused' | 'pending' | 'nocred' | 'over'; why: string }
const CALL_RANK: Record<CallStateName, number> = { accepted: 1, running: 2, completed: 3, failed: 3 }
export class CallFacts {
  private sent = new Map<string, { state: CallStateName; result: boolean; session: string | null; idem?: string }>()
  private later = new Map<string, { call: CallRef; session: string; at: string; stopMs: number; result?: CallResult }>()
  readonly stats = { moments: 0, skipped: 0, ledger: 0 }
  constructor(readonly o: { sink: (line: CallStateLine) => void; now?: Now; max?: number; client?: CallClient | null }) {}
  private now(): number { return (this.o.now ?? Date.now)() }
  /** putBack: the one step back (running → accepted); any other moment at or behind the last one is not sent */
  /** the line's idem key, or null: not sent (at or behind the last moment) */
  private emit(event: string, call: CallRef, state: CallStateName, session: string | null, at: string, result?: CallResult, putBack = false, hand = false): string | null {
    const was = this.sent.get(event)
    // a hand-over (handedOver): accepted with the new session, from running or from an accepted of another session
    const handed = hand && !!was && was.session !== session && (was.state === 'running' || was.state === 'accepted') && state === 'accepted'
    const body = result && (result.outcome || result.text) && state === 'completed'          // failed takes no result (Onsen)
      ? { ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.text ? { body: { format: 'markdown' as const, text: result.text.slice(0, 4000) } } : {}) } : undefined
    const back = (putBack && was?.state === 'running' && state === 'accepted') || handed
    const fill = was?.state === 'completed' && state === 'completed' && !was.result && !!body
    if (was && !back && !fill && CALL_RANK[state] <= CALL_RANK[was.state]) { this.stats.skipped++; return null }
    if (was && (was.state === 'completed' || was.state === 'failed') && !fill) { this.stats.skipped++; return null }
    const idem = `call:${event}:${state}:${handed ? 'hand:' : back ? 'back:' : ''}${fill ? 'fill:' : ''}${at}`
    this.sent.set(event, { state, result: !!body || !!was?.result, session, idem })
    if (this.sent.size > (this.o.max ?? 20_000)) for (const k of [...this.sent.keys()].slice(0, 5_000)) this.sent.delete(k)
    this.stats.moments++
    try {
      this.o.sink({ call_id: call.id, kind: call.kind, event, idem, body: { state, session_id: session, ...(body ? { result: body } : {}), at } })
    } catch {}
    return idem
  }
  routed(event: string, call: CallRef, session: string | null, at = iso(this.now())): void {
    this.emit(event, call, 'accepted', session, at)
    if (session == null) { this.stats.ledger++; this.emit(event, call, 'completed', null, at, { text: CALL_LEDGER_RESULT }) }
  }
  running(event: string, call: CallRef, session: string, at = iso(this.now())): void {
    this.later.delete(event)
    // a session that is in its turn with it was handed it first: a lane's run starts inside the routing step, before the router's record of it
    if (!this.sent.has(event)) this.emit(event, call, 'accepted', session, at)
    this.emit(event, call, 'running', session, at)
  }
  /** the item was handed to the main while a lane had it (handoff_main, the exit rule: a change of hands, not an end): accepted, session main (Onsen
   *  0.25.1: the daemon is the one writer of a Call it reports; the main has not started), once; the main's turn then reports running and the end */
  handedOver(event: string, call: CallRef, at = iso(this.now())): void {
    const w = this.sent.get(event)
    if (!w || w.session === 'main' || (w.state !== 'running' && w.state !== 'accepted')) return
    this.later.delete(event)
    this.emit(event, call, 'accepted', 'main', at, undefined, false, true)
  }
  putBack(event: string, call: CallRef, session: string, at = iso(this.now())): void {
    this.later.delete(event)
    if (this.sent.get(event)?.state === 'running') this.emit(event, call, 'accepted', session, at, undefined, true)
  }
  ended(event: string, call: CallRef, session: string, how: 'completed' | 'failed', at = iso(this.now()), result?: CallResult): string | null {
    this.later.delete(event)
    return this.emit(event, call, how, session, at, result)
  }
  /** WO-175 (Chiron 05:55Z: a receipt goes to Onsen only): a scheduled run's receipt (lanes.ts completeRun) as its Call's end, through the spool,
   *  then what Onsen said (the client waits ≤10 s: the first try and three more). A refused step is recorded when the Call is already where the
   *  receipt puts it (a resend); so is a receipt this daemon sent before, once Onsen took that line */
  async receipt(event: string, call: CallRef, session: string, how: 'completed' | 'failed', result?: CallResult, at = iso(this.now())): Promise<CallReceipt> {
    const was = this.sent.get(event)
    const wanted = (state: string | null | undefined, res: unknown): boolean => how === 'failed' ? state === 'failed' : state === 'completed' && res != null
    let idem = this.ended(event, call, session, how, at, result), resend = false
    if (!idem) {
      if (!was || !(how === 'failed' ? was.state === 'failed' : was.state === 'completed' && was.result))
        return { ok: false, fate: 'over', why: `the Call is already ${was?.state ?? 'past this step'} (this daemon reported that before); this receipt changes nothing` }
      if (!was.idem) return { ok: true, state: was.state, resend: true }
      idem = was.idem; resend = true
    }
    const client = this.o.client
    if (!client) return { ok: true, state: how, ...(resend ? { resend } : {}) }
    const f = await client.callFate(idem)
    if (f.fate === 'took') return { ok: true, state: f.state, ...(resend ? { resend } : {}) }
    if (f.fate === 'refused') {
      const now = await client.getCall(call.id).catch(() => null)
      if (now && wanted(now.state, now.result)) return { ok: true, state: now.state, resend: true }
      return { ok: false, fate: 'refused', why: `Onsen refused it (HTTP ${f.status}): ${f.said}${now?.state ? `; the Call is ${now.state}` : ''}` }
    }
    return { ok: false, fate: f.fate, why: f.why }
  }
  /** WO-175: run `run`'s Call in Onsen, for a receipt whose item named none (no client: none) */
  findRun(run: string): Promise<RunCallLookup> { return this.o.client ? this.o.client.findRunCall(run) : Promise.resolve({ none: true }) }
  /** the main's turn that took it ended at its Stop: final once the status record shows no turn running (statusRecord), or when a new turn begins */
  completeLater(event: string, call: CallRef, session: string, at: string): void {
    this.later.set(event, { call, session, at, stopMs: this.now() })
    if (this.later.size > 2_000) this.later.delete(this.later.keys().next().value!)
  }
  /** the turn went on after that Stop (another Stop hook held it): not over yet */
  cancelLater(event: string): void { this.later.delete(event) }
  statusRecord(member: string, atMs = this.now()): void {
    if (TURN_RUNNING.has(member)) return
    for (const [ev, l] of [...this.later]) if (l.stopMs <= atMs) this.ended(ev, l.call, l.session, 'completed', l.at, l.result)
  }
  flushLater(): void { for (const [ev, l] of [...this.later]) this.ended(ev, l.call, l.session, 'completed', l.at, l.result) }
  pendingLater(): number { return this.later.size }
  health(): Record<string, unknown> { return { ...this.stats, settling: this.later.size, followed: this.sent.size } }
}

// ------------------------------------------------------------------ status
/** 1.45.1: the main's status. The state is Claude Code's own (its session registry, through a StatusSource); what the hooks (lanes on) or the transcript
 *  (lanes off) see of the turn, the usage wall, a compaction and Joey's held messages ride as detail only. */
export type StatusView = { state: StatusState; detail?: Record<string, unknown>; last_activity_at?: string | null }
export type BusyInput = { turn_started_at: string | null; tool: { name: string; started_at: string | null; timeout_s?: number | null } | null; subagents: number }
export type OfflineReason = 'no_registration' | 'pid_gone' | 'pid_reused' | 'not_connected'
/** what the daemon knows beside the source (detail only): the usage wall (or the lanes main's own), Joey's messages it holds, the turn, a compaction */
export type StatusShared = { queuedJoey: number; wall: { walled: boolean; until: string | null; kind: string | null } | null; turn?: BusyInput | null; compacting?: boolean
  /** WO-157: the main's last turn start and its last final Stop as its hooks reported them (ms; lanes on) */
  edges?: TurnEdges | null
  /** WO-157 (Chiron 13:46Z, 5): this agent's lane runs in progress (detail.lanes) */
  lanes?: LaneRunInfo[] }
/** WO-157: the main's last turn start (UserPromptSubmit / PreToolUse) and its last final Stop (the daemon's own Stop hook passed it) */
export type TurnEdges = { started_at: number | null; ended_at: number | null }
/** one lane run in progress: the lane, its run (lane.rN), its kind, since when */
export type LaneRunInfo = { id: string; run: string; kind?: string; since: string }
/** what a source says: the main's own state (null = offline, `offline` says why), the newest write to its transcripts, and the shared detail */
export type StatusInputs = { main: { status: string; waiting_for?: string | null; status_at?: number | null
    /** WO-157 (Chiron 12112, A): background sub-agents of the main still working (their transcripts written lately); null: not read */
    background_agents?: number | null } | null; offline?: OfflineReason; last_activity_at: string | null
  queued_joey: number; walled?: { until: string | null; kind?: string | null } | null; compacting?: boolean; turn?: BusyInput | null; lanes?: LaneRunInfo[]
  edges?: TurnEdges | null }
/** where the main's state comes from. A source reads one kind of evidence and fills StatusInputs; statusOf is the only judge. Registry is the one in use;
 *  another (a terminal reader, herdr / moshi style) implements this and nothing else changes. */
export interface StatusSource { inputs(shared: StatusShared): StatusInputs }
/** WO-157b: how long after the main's final Stop the session file may still say busy before it counts as stale (it is rewritten within ~0.5 s) */
export const REGISTRY_SETTLE_MS = 3_000
/** stuck: the registry says busy and nothing was written to the main's transcripts for this long (ONSEN_STUCK_S, default 600 s; the value is Chiron's) */
export const stuckS = (): number => { const n = Number(process.env.ONSEN_STUCK_S ?? 600); return Number.isFinite(n) && n > 0 ? n : 600 }

/** the one rule. Registry status → state: (no main) offline {reason} | idle → idle | shell (out of a turn, a background shell runs) → idle
 *  {background_shell} | waiting → waiting {waitingFor} | busy → busy, or stuck {threshold_s} when last_activity_at is older than the threshold | any other
 *  value → busy {registry_status}. Every state's detail: queued_joey, walled {until, kind} and compacting when so; busy / waiting / stuck: the turn
 *  (turn_started_at, tool {name, since}, subagents) when the hooks or the transcript show one */
export function statusOf(i: StatusInputs, o: { now?: number; stuckS?: number } = {}): StatusView {
  const extras = { queued_joey: i.queued_joey, ...(i.walled ? { walled: { until: i.walled.until ?? null, ...(i.walled.kind ? { kind: i.walled.kind } : {}) } } : {}),
    ...(i.compacting ? { compacting: true } : {}), ...(i.lanes?.length ? { lanes: i.lanes } : {}) }
  const turn = i.turn ? { turn_started_at: i.turn.turn_started_at, tool: i.turn.tool ? { name: i.turn.tool.name, since: i.turn.tool.started_at,
    ...(Number(i.turn.tool.timeout_s) > 0 ? { timeout_s: Number(i.turn.tool.timeout_s) } : {}) } : null, subagents: i.turn.subagents } : {}
  const last = { last_activity_at: i.last_activity_at ?? null }
  if (!i.main) return { state: 'offline', detail: { reason: i.offline ?? 'no_registration', ...extras }, ...last }
  let st = i.main.status
  // WO-157 (Chiron 13:46Z, 3): the registry's status can go stale. The 28 rows where statusOf and the hook state disagreed (11-24/25, Mac mini): 25 times
  // the file said busy (2 times waiting, `dialog open`) for seconds to two hours after the main's turn had ended, and the main took the next item within
  // 0.1 s (sandwich-master's file said busy from 11:35:15Z on through dozens of turns). When the hooks show the turn ended (a final Stop) after Claude Code
  // last wrote the status, and no turn began since, the status is idle (detail registry_stale: what the file said); when they show a turn began after the
  // file said idle and it has not ended, busy. A file written after the hook evidence wins as before.
  const at = Number(i.main.status_at), e = i.edges
  if (e && Number.isFinite(at) && at > 0) {
    if ((st === 'busy' || st === 'waiting') && e.ended_at != null && e.ended_at > at && (e.started_at == null || e.started_at <= e.ended_at)) {
      // WO-157 (Chiron 12112, A): the file keeps busy after the turn while background sub-agents still run (the pane: 「✻ Waiting for 1 background agent
      // to finish」); all 24 such rows of the replay had 1–3 of them writing within 2 min. The count when it can be read, else true (as background_shell)
      // WO-157b (Chiron status-latency-lab 「會判錯的」 6): Claude Code rewrites the file a moment after the final Stop (−0.3 to +0.2 s of the screen); the
      // first row after every turn end said background_agents: true for 5 s with none running (7 of 7). Within REGISTRY_SETTLE_MS of the Stop the file is
      // not stale yet: idle, nothing claimed. After it, a file still busy is the background-agent case
      if ((o.now ?? Date.now()) - e.ended_at < REGISTRY_SETTLE_MS) return { state: 'idle', detail: { ...extras }, ...last }
      const bg = st === 'busy' ? (Number(i.main.background_agents) > 0 ? Number(i.main.background_agents) : true) : undefined
      return { state: 'idle', detail: { registry_stale: st, ...(bg !== undefined ? { background_agents: bg } : {}), ...extras }, ...last }
    }
    if ((st === 'idle' || st === 'shell') && e.started_at != null && e.started_at > at && (e.ended_at == null || e.ended_at < e.started_at)) {
      const turn2 = i.turn ? { turn_started_at: i.turn.turn_started_at, tool: i.turn.tool ? { name: i.turn.tool.name, since: i.turn.tool.started_at } : null, subagents: i.turn.subagents } : {}
      return { state: 'busy', detail: { registry_stale: st, ...turn2, ...extras }, ...last }
    }
  }
  // WO-157 (3), the two rows the edges do not explain (kot 07:14Z, nestor 07:16Z): `waiting: dialog open` written a few seconds after the turn's final
  // Stop, and the main took the next item within 0.1 s (2 of the 7 `dialog open` spells on this machine had turns inside them). A dialog outside a turn does
  // not keep channel input from the main: idle {dialog_open}. Inside a turn (a start after the last Stop) it stays waiting; a permission prompt is always
  // inside one.
  if (st === 'waiting' && i.main.waiting_for === 'dialog open' && e && e.ended_at != null && (e.started_at == null || e.started_at <= e.ended_at)) {
    return { state: 'idle', detail: { dialog_open: true, ...extras }, ...last }
  }
  if (st === 'idle' || st === 'shell') return { state: 'idle', detail: { ...(st === 'shell' ? { background_shell: true } : {}), ...extras }, ...last }
  if (st === 'waiting') return { state: 'waiting', detail: { waitingFor: i.main.waiting_for ?? null, ...turn, ...extras }, ...last }
  if (st !== 'busy') return { state: 'busy', detail: { registry_status: st, ...turn, ...extras }, ...last }
  // an open tool that declared its own timeout (a long Bash, an MCP call) may run silently that long: the threshold is the larger of the two, with the
  // lanes-main watchdog's 1.25 margin (WO-143: Chiron's criterion 4 「長 sleep 的工具呼叫 → busy」)
  const toolS = Number(i.turn?.tool?.timeout_s) > 0 ? Math.round(Number(i.turn!.tool!.timeout_s) * 1.25) : 0
  const lim = Math.max(o.stuckS ?? stuckS(), toolS), t = i.last_activity_at ? Date.parse(i.last_activity_at) : NaN
  if (Number.isFinite(t) && (o.now ?? Date.now()) - t > lim * 1000) return { state: 'stuck', detail: { threshold_s: lim, ...turn, ...extras }, ...last }
  return { state: 'busy', detail: { ...turn, ...extras }, ...last }
}

/** WO-162 (3): a status is reported at least this often while the daemon computes it, unchanged or not; each report carries detail.heartbeat_s so Onsen
 *  can tell a reporter that stopped (no report for 3 × heartbeat_s) from one that has nothing new to say */
export const HEARTBEAT_MS = 15_000
export class StatusFacts {
  private last: { state: StatusState; key: string; act: string | null; ms: number } | null = null
  private pending: StatusView | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private beat: ReturnType<typeof setTimeout> | null = null
  /** the last view handed in, and when: the heartbeat repeats it only while it is fresh (a compute loop that stopped is not reported as alive) */
  private latest: { v: StatusView; ms: number } | null = null
  private stopped = false
  /** WO-169: the last report as Onsen keeps it (member_status_now): its state, at, detail as sent, since (the at of the first report of this state),
   *  last_activity_at (the newest one any report carried) */
  private sent: { state: StatusState; at: string; since: string; detail: Record<string, unknown>; last_activity_at: string | null } | null = null
  /** throttleMs: last_activity_at alone moving is written at most this often (default 1 s); heartbeatMs: the longest gap between two reports (default
   *  HEARTBEAT_MS; 0 = no heartbeat, no heartbeat_s); freshMs: the heartbeat repeats the latest view only if it was handed in within the larger of
   *  this (default 5 s; the daemon computes one every 2 s) and heartbeatMs; since (WO-169): where the last report's state and since are kept across a
   *  restart (a first report in the same state keeps that since, as Onsen does) */
  /** WO-177 六: the since of this daemon's first report: Onsen's since (remote()) is taken while the state has not changed since that report */
  private firstSince: string | null = null
  private remoteAsked = false
  constructor(readonly o: { agent: string; sink: (f: StatusFact) => void; throttleMs?: number; heartbeatMs?: number; freshMs?: number; now?: Now
    since?: { load(): { state?: unknown; since?: unknown } | null; save(x: { state: string; since: string }): void
      /** WO-177 六 (Chiron's ticket: after the fleet's restart athena's and sandwich-master's /healthz since was the restart, Onsen's was right): the
       *  record as Onsen holds it now (GET /status: its state and since), asked once after start; null: not known */
      remote?(): Promise<{ state?: unknown; since?: unknown } | null> } }) {}
  private now(): number { return (this.o.now ?? Date.now)() }
  private get beatMs(): number { const n = Number(this.o.heartbeatMs ?? HEARTBEAT_MS); return Number.isFinite(n) && n > 0 ? n : 0 }
  /** the status as the daemon sees it now. WO-162 (2): a new state or any change of the detail (a tool starting or ending, waitingFor, dialog_open, a
   *  count) is written at once; until 1.55.0 a detail change waited up to 5 s, so tools under 2 s never showed and a 4 s tool showed once it was over.
   *  Only last_activity_at moving on its own (each transcript write) waits, at most throttleMs, the latest. Nothing new for heartbeatMs: written again */
  update(v: StatusView): void {
    if (this.stopped) return
    this.latest = { v, ms: this.now() }
    const key = JSON.stringify(v.detail ?? null), act = v.last_activity_at ?? null
    if (!this.last || this.last.state !== v.state || this.last.key !== key) return this.send(v)
    if (this.beatMs && this.now() - this.last.ms >= this.beatMs) return this.send(v)
    if (this.last.act === act) { this.pending = null; return }
    const wait = this.last.ms + (this.o.throttleMs ?? 1_000) - this.now()
    if (wait <= 0) return this.send(v)
    this.pending = v
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; const p = this.pending; this.pending = null; if (p) this.update(p) }, wait)
      ;(this.timer as any).unref?.()
    }
  }
  private send(v: StatusView): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.pending = null
    const ms = Math.max(this.now(), (this.last?.ms ?? 0) + 1)          // one idem key per write
    this.last = { state: v.state, key: JSON.stringify(v.detail ?? null), act: v.last_activity_at ?? null, ms }
    const beat = this.beatMs
    const detail = beat ? { ...(v.detail ?? {}), heartbeat_s: beat / 1000 } : v.detail
    try { this.o.sink({ idem_key: idemStatus(this.o.agent, ms, v.state), agent: this.o.agent, state: v.state, at: iso(ms), ...(detail ? { detail } : {}),
      last_activity_at: v.last_activity_at ?? null }) } catch {}
    this.noteSent(v, ms, detail)
    this.arm()
  }
  private noteSent(v: StatusView, ms: number, detail: Record<string, unknown> | undefined): void {
    const first = !this.sent
    let prev: { state?: unknown; since?: unknown } | null = this.sent
    if (!prev) { try { prev = this.o.since?.load() ?? null } catch { prev = null } }
    const keep = !!prev && prev.state === v.state && typeof prev.since === 'string' && !Number.isNaN(Date.parse(prev.since))
    const since = keep ? String(prev!.since) : iso(ms)
    this.sent = { state: v.state, at: iso(ms), since, detail: detail ?? {}, last_activity_at: v.last_activity_at ?? this.sent?.last_activity_at ?? null }
    if (!keep) { try { this.o.since?.save({ state: v.state, since }) } catch {} }
    if (first) { this.firstSince = since; this.askRemote() }
  }
  /** WO-177 六: once after start, Onsen's record (its state and since). While this daemon's state has not changed since its first report, Onsen's since is
   *  this record's since too (Onsen keeps since while the state stays; the local file is only what this daemon last saved, and may be missing or old) */
  private askRemote(): void {
    if (this.remoteAsked || !this.o.since?.remote) return
    this.remoteAsked = true
    let p: Promise<{ state?: unknown; since?: unknown } | null>
    try { p = this.o.since.remote() } catch { return }
    void p.then(r => {
      if (!r || typeof r.state !== 'string' || typeof r.since !== 'string' || Number.isNaN(Date.parse(r.since))) return
      const s = this.sent, since = new Date(r.since).toISOString()          // Onsen's spelling (+00:00, µs) in this daemon's (Z, ms): the same instant
      if (!s || s.state !== r.state || s.since !== this.firstSince || s.since === since) return
      s.since = since; this.firstSince = since
      try { this.o.since?.save({ state: s.state, since: s.since }) } catch {}
    }).catch(() => {})
  }
  /** the heartbeat: heartbeatMs after the last report, the latest view again, if one was handed in within that time; otherwise nothing (the next
   *  update() reports at once, the beat being overdue) */
  private arm(): void {
    if (this.beat) clearTimeout(this.beat)
    this.beat = null
    const beat = this.beatMs
    if (!beat || this.stopped) return
    this.beat = setTimeout(() => {
      this.beat = null
      const l = this.latest
      if (l && !this.stopped && this.now() - l.ms <= Math.max(beat, this.o.freshMs ?? 5_000)) this.send(l.v)
    }, beat)
    ;(this.beat as any).unref?.()
  }
  /** WO-169: the last report as Onsen holds it (/status: state, since, at, detail, last_activity_at) */
  current(): { state: StatusState; at: string; since: string; detail: Record<string, unknown>; last_activity_at: string | null } | null {
    return this.sent ? { ...this.sent, detail: { ...this.sent.detail } } : null
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.pending = null
    if (this.beat) clearTimeout(this.beat); this.beat = null
  }
}

/** WO-162 (1), lanes off: the start of a turn of the main, as the registry shows it: busy after anything but busy or waiting (waiting → busy is the same
 *  turn going on after a prompt). observe() is handed the registry's main each time the status is computed; it answers when the turn began (ms: the
 *  registry's statusUpdatedAt, else now) the first time it sees that turn, else null */
export class TurnStarts {
  private was: string | null = null
  observe(main: { status: string; status_at?: number | null } | null, now: number): number | null {
    const st = main?.status ?? null, was = this.was
    this.was = st
    if (st !== 'busy' || was === 'busy' || was === 'waiting') return null
    const at = Number(main?.status_at)
    return Number.isFinite(at) && at > 0 ? at : now
  }
}

// ------------------------------------------------------------------ lanes on: the journal and the main's hook events
/** WO-172: how a turn ended — computed once (LanesTap for the main and the lanes, TurnWatch for a main with no lanes), the same value on every
 *  turn_end fact of that turn and on the observation's last_turn. done: it ended with Stop (a lane's run: exited normally); interrupted: cut (Esc, a
 *  new prompt with no Stop; a lane closed while it ran); failed: StopFailure, the wall, a lane run that died, timed out or hit a cap */
export type TurnOutcome = 'done' | 'interrupted' | 'failed'
/** WO-172: one turn that ended: whose (main, a lane id), which (the prompt id / run id: sessions[].turn.id), how, and the messages bound into it
 *  (Joey's by their client_msg_id, a colleague's item by its msg id); `facts`: how many turn_end facts it gave (one per Joey message in it) */
export type TurnEnded = { session: string; turn_id: string; outcome: TurnOutcome; bound: string[]; ended_at: string; facts: number }
/** a lane run's exit reason (lanes.ts exitReason; closed: its lane closed while it ran) as the turn's outcome */
export const runOutcome = (reason: unknown): TurnOutcome => { const r = String(reason ?? ''); return r === 'normal' ? 'done' : r === 'closed' ? 'interrupted' : 'failed' }
/** WO-169: what opened a turn (Onsen contract v1 §3 Trigger) */
export type TurnTrigger = { kind: 'message'; conversation_id: string; message_id: string } | { kind: 'thread'; thread_id: string } | { kind: 'schedule' } | { kind: 'other' }
/** Joey's Telegram message behind these meta (allowlisted sender, not an edit's re-delivery), or null */
export type JoeyOf = (meta: Record<string, unknown> | undefined | null) => { chat: string; id: string } | null
const AGENT_TOOLS = new Set(['Agent', 'Task'])

export class LanesTap {
  /** lane runs that reached `running` in this daemon's life (an exit of a run that never ran, or ran before a restart, ends no turn) */
  private runs = new Set<string>()
  private tool: { name: string; started_at: string } | null = null
  /** the open tool's declared timeout (PreToolUse tool_timeout_ms), for the stuck threshold */
  private toolTimeout: { name: string; s: number | null } | null = null
  private turn: { prompt: string; at: string } | null = null
  private subagents = 0
  private compactingAt: number | null = null
  /** WO-157: the main's last turn start and last final Stop (ms), for statusOf's stale-registry rule */
  private startedAt: number | null = null
  private endedAt: number | null = null
  /** WO-169 (the observation): the M2 turn open now (its prompt id stays in this.turn), the first item bound to each prompt (what opened that turn), the
   *  last turn that ended and how; a StopFailure seen before the M2 row that ends its turn */
  private open = false
  private opened: { prompt: string; trigger: TurnTrigger; thread: string | null; lead: boolean } | null = null
  private lead: string | null = null
  private leadOpen = true
  private last: { id: string; outcome: TurnOutcome; ended_at: string } | null = null
  /** the turn that ended before `last`: `last` again when the turn `last` names goes on (a Stop that was not its end) */
  private before: { id: string; outcome: TurnOutcome; ended_at: string } | null = null
  private failed = false
  /** WO-172: each prompt's bound items (M1 row ids) and their message ids (bound), the outcome its first ending line gave, how many facts it gave */
  private boundOf = new Map<string, { rows: Set<string>; ids: string[]; ending: TurnOutcome | null; facts: number }>()
  /** WO-175: the M1 items whose Call this tap reported running (an item put back after it: its Call goes back to accepted) */
  private callBound = new Set<string>()
  /** trigger (WO-169): an M1 item as the trigger of the turn it opened, and its thread (lanes.ts knows the threads); turnEnded (WO-172): each turn of the
   *  main or of a lane that ended, once; calls / callOf (WO-175): the Calls' turn moments (an M1 item bound, done, put back; a lane run running) and the
   *  Call an event is (lanes.ts callOfEvent) */
  constructor(readonly o: { facts: DeliveryFacts; joey: JoeyOf; gen: () => Row | null; changed: () => void; now?: Now
    trigger?: (row: Row) => { trigger: TurnTrigger; thread: string | null } | null; turnEnded?: (t: TurnEnded) => void
    calls?: CallFacts | null; callOf?: (event: string) => CallRef | null }) {}
  private callOf(event: unknown): CallRef | null { try { return event && this.o.calls && this.o.callOf ? this.o.callOf(String(event)) : null } catch { return null } }
  private turnBound(prompt: string) {
    let b = this.boundOf.get(prompt)
    if (!b) { b = { rows: new Set(), ids: [], ending: null, facts: 0 }; this.boundOf.set(prompt, b); if (this.boundOf.size > 50) this.boundOf.delete(this.boundOf.keys().next().value!) }
    return b
  }
  /** an item's message id as `bound` names it: Joey's message by its client_msg_id, a colleague's item by its msg id; none for what has neither */
  private msgIdOf(row: Row, j: { chat: string; id: string } | null): string | null {
    if (j) return j.id
    const m = ((row.notif?.params as any)?.meta ?? {}) as Record<string, unknown>
    return m.btcc_msg_id != null && String(m.btcc_msg_id) !== '' ? String(m.btcc_msg_id) : null
  }
  private ended(t: TurnEnded): void { try { this.o.turnEnded?.(t) } catch {} }
  private now(): number { return (this.o.now ?? Date.now)() }

  journal(row: Row, line: Record<string, unknown>): void {
    const F = this.o.facts
    if (row.rec === 'msg') {
      if (line.reason === 'call_already_final') return  // closed before delivery; the remote Call already has its outcome
      // WO-175: a Call's turn moments on the main: bound into a turn → running; the turn ended (its Stop, final once the record shows it over) →
      // completed; bound again after that Stop (the turn went on) → not yet; back in the queue after it was in a turn (cut, failed, its gen gone) → accepted
      const call = row.kind !== 'digest' ? this.callOf(row.event) : null
      if (call) {
        const C = this.o.calls!, ev = String(row.event), rid = String(row.id)
        if (line.state === 'bound' && line.reason === 'turn_continued') C.cancelLater(ev)
        else if (line.state === 'bound') { this.callBound.add(rid); C.running(ev, call, 'main', row.ts) }
        else if (line.state === 'done') { this.callBound.delete(rid); C.completeLater(ev, call, 'main', row.ts) }
        else if (line.state === 'queued' && this.callBound.delete(rid)) C.putBack(ev, call, 'main', row.ts)
        if (this.callBound.size > 2_000) this.callBound.delete(this.callBound.values().next().value!)
      }
      const meta = (row.notif?.params as any)?.meta
      const j = row.person_message_ids?.length && meta?.chat_id && meta?.message_id ? { chat: meta.chat_id, id: meta.message_id } : this.o.joey(meta)
      if (j && line.state === 'offered') F.inSession(j.chat, j.id, 'main', row.ts, row.wall_blocked)   // WO-165: written into the idle main's stream
      else if (j && line.state === 'bound') {
        // M1 bound it to a turn of the main: offered and opened the turn, or pulled at a tool boundary / Stop. bound again after its Stop
        // (turn_continued): that Stop was not the turn's end. WO-165: a pulled item reaches the session as it is bound (in_session the same moment;
        // an offered one has it already, this daemon writes each fact once)
        if (line.reason === 'turn_continued') F.cancelTurnEnd(j.chat, j.id, 'main')
        else { F.inSession(j.chat, j.id, 'main', row.ts, row.wall_blocked); F.seen(j.chat, j.id, 'main', row.ts, false, line.prompt_id ? String(line.prompt_id) : this.turn?.prompt ?? null, row.wall_blocked) }
      }
      // WO-172: how the turn ended, from its items: done at its Stop; queued again because it was cut (interrupted) or ended in StopFailure (failed; any
      // other requeue of a bound item: the gen ended under it, failed). The first such line of a prompt sets the turn's outcome; each Joey message in it
      // gets its turn_end fact with the outcome and everything bound into the turn
      const endP = line.state === 'done' ? (row.prompt_id ? String(row.prompt_id) : this.turn?.prompt ?? null)
        : line.state === 'queued' && this.turn && this.boundOf.get(this.turn.prompt)?.rows.has(String(row.id)) ? this.turn.prompt : null
      if (endP) {
        const b = this.turnBound(endP)
        const outcome: TurnOutcome = line.state === 'done' ? 'done' : line.reason === 'interrupted' ? 'interrupted' : 'failed'
        if (!b.ending) b.ending = outcome
        if (j && !line.wall_blocked) {
          const detail = row.reason && line.state === 'done' ? { reason: String(row.reason) } : undefined
          const turn: TurnFields = { turn_id: endP, outcome: b.ending, bound: [...b.ids] }
          if (line.state === 'done') F.turnEndLater(j.chat, j.id, 'main', row.ts, detail, turn)
          else F.turnEnd(j.chat, j.id, 'main', row.ts, detail, turn)
          b.facts++
        }
      }
      // WO-169: what opened a turn: the item M1 offered it (the offer's lead: M1 writes `offered` for the lead first, then for the items riding it —
      // an interrupted turn's, the digest — with no other line between), else the first item bound to the prompt; an item pulled into a turn already
      // running opened nothing
      if (line.state === 'offered') { if (this.leadOpen && row.kind !== 'digest') { this.lead = String(row.id); this.leadOpen = false } }
      else this.leadOpen = true
      const P = line.prompt_id ? String(line.prompt_id) : null
      if (line.state === 'bound' && line.reason !== 'turn_continued' && P && row.kind !== 'digest') {           // WO-172: what is bound into the turn
        const b = this.turnBound(P), mid = this.msgIdOf(row, j)
        if (!b.rows.has(String(row.id))) { b.rows.add(String(row.id)); if (mid && !b.ids.includes(mid)) b.ids.push(mid) }
      }
      if (line.state === 'bound' && line.reason !== 'turn_continued' && P && !line.via_pull && row.kind !== 'digest') {
        const lead = row.id === this.lead
        if (this.opened?.prompt !== P || (lead && !this.opened.lead)) {
          let t: { trigger: TurnTrigger; thread: string | null } | null = null
          try { t = this.o.trigger?.(row) ?? null } catch {}
          this.opened = { prompt: P, trigger: t?.trigger ?? { kind: 'other' }, thread: t?.thread ?? null, lead }
        }
      }
    } else if (row.rec === 'event' && this.o.calls) {
      // WO-175: the event is handed to the main (its main obligation open): a lane's Call changes hands
      const call = ((row.obligations ?? []) as Array<{ kind?: string; state?: string }>).some(o => o.kind === 'main' && (o.state === 'open' || o.state === 'requested')) ? this.callOf(row.id) : null
      if (call) this.o.calls.handedOver(String(row.id), call)
    } else if (row.rec === 'run') {
      const all = [row.ev, ...(Array.isArray(row.extra) ? row.extra : []), ...(Array.isArray(row.steered) ? row.steered : [])].filter((e: any) => e)
      const evs = all.filter((e: any) => e.source === 'telegram').map((e: any) => this.o.joey(e.meta)).filter((x): x is { chat: string; id: string } => !!x)
      const lane = String(row.lane ?? 'lane')
      if (line.state === 'running') {
        this.runs.add(row.id)
        for (const e of evs) { F.inSession(e.chat, e.id, lane, row.ts); F.seen(e.chat, e.id, lane, row.ts, false, String(row.run ?? row.id)) }   // spawned with it in its prompt, or steered into it
        for (const e of all) { const call = this.callOf(e.id); if (call) this.o.calls!.running(String(e.id), call, lane, row.ts) }   // WO-175: the lane run is in its turn
      } else if (line.state === 'exited' && this.runs.has(row.id)) {
        this.runs.delete(row.id)
        // WO-172: the run is the lane's turn: its outcome from the exit reason, bound = its items (Joey's client_msg_id, a colleague's msg id)
        const outcome = runOutcome(row.reason)
        const bound: string[] = []
        for (const e of all) {
          const j = e.source === 'telegram' ? this.o.joey(e.meta) : null
          const mid = j ? j.id : e.btcc_msg_id != null && String(e.btcc_msg_id) !== '' ? String(e.btcc_msg_id) : null
          if (mid && !bound.includes(mid)) bound.push(mid)
        }
        for (const e of evs) F.turnEnd(e.chat, e.id, lane, row.ts, row.reason ? { reason: String(row.reason) } : undefined, { turn_id: String(row.run ?? row.id), outcome, bound })
        this.ended({ session: lane, turn_id: String(row.run ?? row.id), outcome, bound, ended_at: String(row.ts), facts: evs.length })
      }
    } else if (row.rec === 'main') {
      this.leadOpen = true
      if (typeof line.tool_open === 'string') this.tool = { name: line.tool_open, started_at: row.ts }
      else if ('tool_open' in line) this.tool = null
      if (row.state === 'in_turn' && row.prompt_id && row.prompt_id !== this.turn?.prompt) {
        // WO-169: a new prompt while the last one never ended (no Stop: it was cut, as M2's beginTurn closes it) ends that one as interrupted
        if (this.open && this.turn) this.closeTurn('interrupted', row.ts)
        this.turn = { prompt: String(row.prompt_id), at: row.ts }
        this.open = true; this.failed = false
        this.subagents = 0
        F.flushLater('main')                                                      // a new prompt: the last turn's Stop was its end
        this.o.calls?.flushLater()                                                // WO-175: so were its Calls'
      }
      else if (row.state === 'in_turn' && row.prompt_id && row.prompt_id === this.turn?.prompt && !this.open) {
        // the same turn went on (another Stop hook held its Stop: lanes-main continueTurn): it never ended. An open turn is never its own last_turn,
        // last_turn goes back to the one before it (Chiron WO-169 01:47Z B; chiron 01:27Z: turn and last_turn both 1dbb40a3…), and how it ended is
        // decided again at its real end (WO-172: that Stop's turn_end facts were taken back, turn_continued)
        this.open = true
        if (this.last?.id === this.turn.prompt) this.last = this.before
        const b = this.boundOf.get(this.turn.prompt)
        if (b) { b.ending = null; b.facts = 0 }
      }
      if (row.state !== 'in_turn') {
        this.tool = null; this.subagents = 0
        if (this.open && this.turn) this.closeTurn(line.ended_by === 'interrupted' ? 'interrupted' : row.state === 'walled' || this.failed ? 'failed' : 'done', row.ts)
        this.open = false; this.failed = false
      }
    }
    this.o.changed()
  }

  /** WO-169 / WO-172: the main's open turn ended. Its outcome is the one its items' lines gave (the one each turn_end fact carried), else `fallback`
   *  (a turn with nothing bound: M2's row) */
  private closeTurn(fallback: TurnOutcome, at: string): void {
    const p = this.turn!.prompt, b = this.boundOf.get(p)
    const outcome = b?.ending ?? fallback
    if (this.last?.id !== p) this.before = this.last
    this.last = { id: p, outcome, ended_at: at }
    this.ended({ session: 'main', turn_id: p, outcome, bound: [...(b?.ids ?? [])], ended_at: at, facts: b?.facts ?? 0 })
  }
  /** a hook event of the main (before M2 handles it): compacting and the subagent count */
  mainEvent(b: any): void {
    if (!b || b.sub) return
    const ev = String(b.event ?? '')
    if (ev === 'SessionStart') { this.compactingAt = null; this.o.changed(); return }
    const g = this.o.gen()
    if (!g || !b.pid || Number(g.pid) !== Number(b.pid)) return
    if (ev === 'PreCompact') this.compactingAt = this.now()
    else this.compactingAt = null
    if (ev === 'UserPromptSubmit' || ev === 'PreToolUse') this.startedAt = this.now()
    else if ((ev === 'Stop' && b.phase === 'final') || ev === 'StopFailure') this.endedAt = this.now()
    // WO-169: how the last turn ended. A StopFailure comes before M2's row; the Esc wrap-up tells its Stop (interrupted) after M2 closed the turn
    if (ev === 'StopFailure') { if (this.open) this.failed = true; else if (this.last) this.last = { ...this.last, outcome: 'failed' } }
    if (ev === 'Stop' && b.interrupted === true && !this.open && this.last && this.last.id === this.turn?.prompt) this.last = { ...this.last, outcome: 'interrupted' }
    const tool = String(b.tool_name ?? '')
    if (ev === 'PreToolUse') this.toolTimeout = { name: tool, s: Number(b.tool_timeout_ms) > 0 ? Number(b.tool_timeout_ms) / 1000 : null }
    else if (ev === 'PostToolUse' || ev === 'Stop' || ev === 'StopFailure') this.toolTimeout = null
    if (ev === 'PreToolUse' && AGENT_TOOLS.has(tool)) this.subagents++
    else if (ev === 'PostToolUse' && AGENT_TOOLS.has(tool)) this.subagents = Math.max(0, this.subagents - 1)
    else if (ev === 'StopFailure' || (ev === 'Stop' && b.phase === 'final')) this.subagents = 0
    this.o.changed()
  }

  /** WO-169: the main's open turn (M2 in_turn): its prompt id, when it began, what opened it (the first item bound to the prompt; none: other) */
  turnFacts(): { id: string; started_at: string; trigger: TurnTrigger; thread: string | null } | null {
    const g = this.o.gen()
    if (String(g?.state ?? '') !== 'in_turn' || !g?.prompt_id) return null
    const p = String(g.prompt_id), o = this.opened?.prompt === p ? this.opened : null
    return { id: p, started_at: this.turn?.prompt === p ? this.turn.at : String(g.ts ?? new Date(this.now()).toISOString()), trigger: o?.trigger ?? { kind: 'other' }, thread: o?.thread ?? null }
  }
  /** WO-169: the last turn of the main that ended: done (Stop), interrupted (cut: Esc, or a new prompt with no Stop), failed (StopFailure, the wall) */
  lastTurn(): { id: string; outcome: 'done' | 'interrupted' | 'failed'; ended_at: string } | null { return this.last }
  /** 1.45.1, detail only: the main's turn as M2 and its hook events show it (null = M2 has it out of a turn) */
  turnDetail(): BusyInput | null {
    const g = this.o.gen()
    if (String(g?.state ?? '') !== 'in_turn') return null
    return { turn_started_at: this.turn && this.turn.prompt === String(g?.prompt_id ?? '') ? this.turn.at : null,
      tool: g?.tool_open ? { ...(this.tool?.name === g.tool_open ? this.tool : { name: String(g.tool_open), started_at: null }),
        timeout_s: this.toolTimeout?.name === String(g.tool_open) ? this.toolTimeout.s : null } : null, subagents: this.subagents }
  }
  /** WO-157: the main's turn edges as its hooks reported them (statusOf corrects a stale registry status with them) */
  turnEdges(): TurnEdges { return { started_at: this.startedAt, ended_at: this.endedAt } }
  /** detail only: a PreCompact of the main, until its next hook event (at most 15 min) */
  compacting(): boolean { return this.compactingAt != null && this.now() - this.compactingAt < 15 * 60_000 }
  /** detail only: the main's own wall (M2 walled after an account-kind StopFailure; until unknown), or null */
  walled(): { walled: true; until: null; kind: string | null } | null {
    const g = this.o.gen()
    return String(g?.state ?? '') === 'walled' ? { walled: true, until: null, kind: g?.kind ? String(g.kind) : null } : null
  }
}

// ------------------------------------------------------------------ lanes off: the main's transcript
/** every <channel …> tag in a text, its attributes */
export function channelTags(text: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  for (const m of String(text ?? '').matchAll(/<channel\s([^>]*)>/g)) {
    const a: Record<string, string> = {}
    for (const x of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) a[x[1]!] = x[2]!
    out.push(a)
  }
  return out
}
const LOCAL_CMD = /^\s*(<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>|Caveat: )/

/** a turn read from the transcript has no prompt id: its id is its start */
const turnIdOf = (at: string): string => `turn-${Date.parse(at) || at}`
export class TurnWatch {
  private file: string | null = null
  private offset = 0
  private rest = ''
  private dropFirst = false
  private scannedAt = 0
  private emitFloor = 0
  private inTurn = false
  private turnAt: string | null = null
  /** WO-169: the first Joey message taken into the open turn, and the last turn that ended (turn_duration) */
  private firstTaken: { chat: string; id: string } | null = null
  private lastEnded: { id: string; outcome: 'done'; ended_at: string } | null = null
  private tools = new Map<string, { name: string; at: string; agent: boolean; timeout_s: number | null }>()
  private taken = new Map<string, { chat: string; id: string }>()
  /** WO-165: the newest own timestamp of a record read from this transcript (ms), and when this watch began (a message taken in before it is the last
   *  daemon life's: its seen is written again, Onsen keeps the first, but no ✍) */
  private latestMs = 0
  private readonly bornMs: number
  /** session (WO-165): the main's session id when known (the registry's), its transcript read in preference to the newest file */
  /** WO-172: a colleague's items the open turn took in (their msg ids), for its bound */
  private peerIds: string[] = []
  constructor(readonly o: { dir: () => string | null; facts: DeliveryFacts; joey: JoeyOf; changed: () => void; tailBytes?: number; rescanMs?: number; now?: Now
    session?: () => string | null; turnEnded?: (t: TurnEnded) => void }) {
    this.bornMs = this.now()
  }
  private now(): number { return (this.o.now ?? Date.now)() }

  /** read what the main's transcript gained since the last tick */
  tick(): void {
    const dir = this.o.dir()
    if (!dir) return
    // WO-165: the main's own transcript (<its session id>.jsonl, the registry's main) the moment it exists, so a new session's first message is seen at
    // once, not at the next rescan (up to rescanMs after it; the bench, 11-25 18:45Z: 4.1 s); while it is read, no rescan takes another file
    const sid = this.o.session?.() ?? null, own = sid ? join(dir, `${sid}.jsonl`) : null
    if (own && own !== this.file && existsSync(own)) { this.scannedAt = this.now(); this.switchTo(own) }
    else if (!this.file || (own !== this.file && this.now() - this.scannedAt >= (this.o.rescanMs ?? 10_000))) {
      this.scannedAt = this.now()
      const f = newestJsonl(dir)
      if (f && f !== this.file) this.switchTo(f)
    }
    if (!this.file) return
    let size = 0
    try { size = statSync(this.file).size } catch { this.file = null; return }
    if (size < this.offset) { this.switchTo(this.file); size = statSync(this.file).size }   // rewritten: read it again from its tail
    if (size <= this.offset) return
    let fd: number | null = null
    let changed = false
    try {
      fd = openSync(this.file, 'r')
      const len = Math.min(size - this.offset, 4 << 20)
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, this.offset)
      this.offset += n
      const text = this.rest + buf.subarray(0, n).toString('utf8')
      const lines = text.split('\n')
      this.rest = lines.pop() ?? ''
      if (this.dropFirst && lines.length) { lines.shift(); this.dropFirst = false }      // the tail began inside a line
      if (this.rest.length > 8 << 20) this.rest = ''
      for (const l of lines) { if (!l) continue; let j: any; try { j = JSON.parse(l) } catch { continue } if (this.handle(j)) changed = true }
    } catch {} finally { if (fd != null) try { closeSync(fd) } catch {} }
    if (changed) this.o.changed()
  }
  /** a new transcript (a new session, a /clear): its tail is read for the current turn; a seen or turn_end older than 10 min before now is not written
   *  again */
  private switchTo(f: string): void {
    this.file = f; this.rest = ''; this.latestMs = 0
    this.inTurn = false; this.turnAt = null; this.tools.clear(); this.taken.clear()
    this.emitFloor = this.now() - 10 * 60_000
    let size = 0
    try { size = statSync(f).size } catch {}
    this.offset = Math.max(0, size - (this.o.tailBytes ?? 1 << 20))
    this.dropFirst = this.offset > 0
  }
  /** one transcript record; true = the turn state changed */
  handle(j: any): boolean {
    if (!j || typeof j !== 'object' || j.isSidechain === true) return false
    const ts = typeof j.timestamp === 'string' ? j.timestamp : iso(this.now())
    // WO-165: a queued_command attachment (a message absorbed mid-turn at a tool boundary) carries its ENQUEUE time (2.1.3xx: the same as its
    // queue-operation enqueue, seconds before); it is written after the queue-operation remove (absorbed_mid_turn). Its moment is the newest own
    // timestamp read before it
    const before = this.latestMs, own = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN
    if (own > this.latestMs) this.latestMs = own
    if (j.type === 'system' && j.subtype === 'turn_duration') return this.end(ts)
    if (j.type === 'attachment' && j.attachment?.type === 'queued_command') {
      const at = before > (Number.isFinite(own) ? own : 0) ? iso(before) : ts
      const b = this.begin(at); this.takeIn(String(j.attachment.prompt ?? ''), at); return b
    }
    if (j.type === 'user') {
      if (j.isCompactSummary || j.isVisibleInTranscriptOnly) return false
      const c = j.message?.content
      if (Array.isArray(c) && c.some((x: any) => x?.type === 'tool_result')) {
        let ch = false
        for (const x of c) if (x?.type === 'tool_result' && this.tools.delete(String(x.tool_use_id))) ch = true
        return ch
      }
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => String(x.text ?? '')).join('\n') : ''
      if (!text.trim() || LOCAL_CMD.test(text)) return false
      const b = this.begin(ts); this.takeIn(text, ts); return b
    }
    if (j.type === 'assistant') {
      let ch = this.begin(ts)
      for (const x of Array.isArray(j.message?.content) ? j.message.content : []) {
        if (x?.type !== 'tool_use' || !x.id) continue
        this.tools.set(String(x.id), { name: String(x.name ?? 'tool'), at: ts, agent: AGENT_TOOLS.has(String(x.name)) && !x.input?.run_in_background,
          timeout_s: Number(x.input?.timeout) > 0 ? Number(x.input.timeout) / 1000 : null })
        ch = true
      }
      return ch
    }
    return false
  }
  private begin(ts: string): boolean {
    if (this.inTurn) return false
    this.inTurn = true; this.turnAt = ts; this.tools.clear(); this.taken.clear(); this.firstTaken = null; this.peerIds = []
    return true
  }
  /** WO-165: the Joey messages of a record that took them into a turn: seen at `at` (that record's moment) */
  private takeIn(text: string, at: string): void {
    const t = Date.parse(at)
    for (const a of channelTags(text)) {
      if (!/telegram/.test(a.source ?? '')) { if (a.btcc_msg_id && this.inTurn && !this.peerIds.includes(a.btcc_msg_id)) this.peerIds.push(a.btcc_msg_id); continue }   // WO-172
      const j = this.o.joey(a)
      if (!j) continue
      this.taken.set(k2(j.chat, j.id), j)
      if (!this.firstTaken && this.inTurn) this.firstTaken = j
      if (!(t < this.emitFloor)) this.o.facts.seen(j.chat, j.id, 'main', at, t < this.bornMs, this.inTurn && this.turnAt ? turnIdOf(this.turnAt) : null)
    }
  }
  private end(ts: string): boolean {
    if (!this.inTurn) return false
    const t = Date.parse(ts)
    // WO-172: a turn the transcript shows ending (turn_duration) ended done; bound = the Joey messages and the colleagues' items it took in
    const bound = [...[...this.taken.values()].map(j => j.id), ...this.peerIds.filter(id => ![...this.taken.values()].some(j => j.id === id))]
    let facts = 0
    const turn_id = this.turnAt ? turnIdOf(this.turnAt) : null
    if (!(t < this.emitFloor)) for (const j of this.taken.values()) { this.o.facts.turnEnd(j.chat, j.id, 'main', ts, undefined, { turn_id, outcome: 'done', bound }); facts++ }
    if (this.turnAt) {
      this.lastEnded = { id: turnIdOf(this.turnAt), outcome: 'done', ended_at: ts }
      try { this.o.turnEnded?.({ session: 'main', turn_id: this.lastEnded.id, outcome: 'done', bound, ended_at: ts, facts }) } catch {}
    }
    this.inTurn = false; this.turnAt = null; this.tools.clear(); this.taken.clear(); this.firstTaken = null; this.peerIds = []
    return true
  }
  /** WO-169: the open turn as the transcript shows it (its id from its start), and what opened it: the first Joey message it took in, else other */
  turnFacts(): { id: string; started_at: string; trigger: TurnTrigger; thread: null } | null {
    if (!this.inTurn || !this.turnAt) return null
    const j = this.firstTaken
    return { id: turnIdOf(this.turnAt), started_at: this.turnAt, trigger: j ? { kind: 'message', conversation_id: j.chat, message_id: j.id } : { kind: 'other' }, thread: null }
  }
  lastTurn(): { id: string; outcome: 'done'; ended_at: string } | null { return this.lastEnded }
  busy(): BusyInput | null {
    if (!this.inTurn) return null
    let last: { name: string; at: string; timeout_s: number | null } | null = null
    let agents = 0
    for (const t of this.tools.values()) { if (t.agent) agents++; if (!last || Date.parse(t.at) >= Date.parse(last.at)) last = t }
    return { turn_started_at: this.turnAt, tool: last ? { name: last.name, started_at: last.at, timeout_s: last.timeout_s } : null, subagents: agents }
  }
  watching(): string | null { return this.file }
}

/** the newest top-level .jsonl of a transcript dir (lanes off: the main's session), or null */
export function newestJsonl(dir: string): string | null {
  let best: { f: string; m: number } | null = null
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.jsonl')) continue
      const f = join(dir, n)
      try { const m = statSync(f).mtimeMs; if (!best || m > best.m) best = { f, m } } catch {}
    }
  } catch {}
  return best?.f ?? null
}

// ------------------------------------------------------------------ 1.45.1: the main's state from Claude Code's session registry
// Claude Code keeps one file per live session, ~/.claude/sessions/<pid>.json (2.1.322: pid, sessionId, cwd, startedAt, procStart, kind, tmux, name, status
// idle | busy | waiting | shell, waitingFor, statusUpdatedAt, updatedAt). `claude agents --json` is the documented read of the same registry
// (code.claude.com/docs/en/agent-view, "read session state from a script"); it prints pid, cwd, kind, startedAt, sessionId, name, status, and shows `shell`
// as `busy`. The daemon reads the files (a watch, and the status tick's 2 s read). About a minute after start and then every ~10 minutes (jittered) the
// two are compared; when they disagree the CLI's reading is used instead, read again every 30 s and compared, until they agree. Every switch is logged.
// 1.48.3 (11-25 06:35Z, the Mac mini ran out of memory): a file in another shape is read as far as it goes and never switches the read by itself; the CLI
// is read through SharedCli, one run at a time on the whole machine, killed at its timeout, its answer shared by every daemon.
export type RegEntry = { pid: number; sessionId: string; cwd: string; kind: string; status: string; waitingFor?: string; procStart?: string; tmux?: string; startedAt?: number; entrypoint?: string
  /** WO-157: when Claude Code last wrote `status` (statusUpdatedAt, ms) */
  statusAt?: number }
/** the registry statuses statusOf knows */
export const REG_STATUSES = new Set(['idle', 'busy', 'waiting', 'shell'])
/** a registry file younger than this is not judged by its shape (a starting session fills it in a moment later) */
export const REG_YOUNG_MS = 5_000
/** a file in another shape younger than this is left out of the comparison with the CLI: when the whole fleet restarts at once a loaded machine takes
 *  longer than REG_YOUNG_MS to fill the files in (11-25 06:35Z: 38 daemons judged their main's file at 5 s) */
export const REG_SETTLE_MS = 60_000
/** WO-157: a background sub-agent counts as still working when its transcript was written this recently (a long tool call writes nothing meanwhile) */
export const BG_AGENT_ACTIVE_MS = 10 * 60_000
/** one registry record (a file, or an item of the CLI's array) in the shape 2.1.322 writes; null = not that shape */
export function regEntry(j: any): RegEntry | null {
  if (!j || typeof j !== 'object' || !Number.isInteger(j.pid) || j.pid <= 0) return null
  for (const k of ['sessionId', 'cwd', 'kind', 'status']) if (typeof j[k] !== 'string') return null
  return { pid: j.pid, sessionId: j.sessionId, cwd: j.cwd, kind: j.kind, status: j.status, ...(typeof j.waitingFor === 'string' ? { waitingFor: j.waitingFor } : {}),
    ...(typeof j.procStart === 'string' ? { procStart: j.procStart } : {}), ...(typeof j.tmux === 'string' ? { tmux: j.tmux } : {}),
    ...(typeof j.startedAt === 'number' ? { startedAt: j.startedAt } : {}), ...(typeof j.entrypoint === 'string' ? { entrypoint: j.entrypoint } : {}),
    ...(typeof j.statusUpdatedAt === 'number' ? { statusAt: j.statusUpdatedAt } : {}) }
}
const realOf = (p: string): string => { try { return realpathSync(p) } catch { return p } }
const samePath = (a: string, b: string): boolean => a === b || realOf(a) === realOf(b)
/** this daemon's main among the registry's sessions: an interactive session (a lane's `claude -p` shares the folder) whose cwd is the workspace; in the
 *  tmux session the channel bot drives when that is set (an entry that names a tmux pane); the main's session id when the lanes know it; else the newest
 *  live one (startedAt) */
/** a session that can be an agent's main: interactive and not a `claude -p` run. Lane runs register too (2.1.322: kind interactive, entrypoint
 *  sdk-cli, no tmux; seen 11-25 04:1xZ for nestor and sandwich-master); the main TUIs are entrypoint cli (43/43 on the Mac mini) (WO-143, 1.47.3) */
export const mainCandidate = (e: { kind?: string; entrypoint?: string }): boolean => e.kind === 'interactive' && e.entrypoint !== 'sdk-cli'
export function pickMain(es: RegEntry[], o: { workspace: string; tmux?: string | null; sessionId?: string | null; alive?: (pid: number) => boolean }): RegEntry | null {
  let c = es.filter(e => mainCandidate(e) && samePath(e.cwd, o.workspace))
  if (o.tmux) c = c.filter(e => e.tmux === undefined || e.tmux.split(':')[0] === o.tmux)
  if (o.sessionId) { const m = c.find(e => e.sessionId === o.sessionId); if (m) return m }
  const live = o.alive ? c.filter(e => o.alive!(e.pid)) : c
  return [...(live.length ? live : c)].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null
}
/** the files and the CLI describe the same sessions of this workspace (the files' `shell` is the CLI's `busy`; a dead pid's file left behind is not a
 *  session); null = they agree, else what differs */
export function compareRegistry(files: RegEntry[], cli: RegEntry[], workspace: string, alive: (pid: number) => boolean = pidAlive,
  ignore: ReadonlySet<number> = new Set()): string | null {
  const mine = (e: RegEntry) => samePath(e.cwd, workspace) && !ignore.has(e.pid)
  const f = new Map(files.filter(e => mine(e) && alive(e.pid)).map(e => [e.pid, e])), c = new Map(cli.filter(mine).map(e => [e.pid, e]))
  const pids = (m: Map<number, RegEntry>) => [...m.keys()].sort((a, b) => a - b).join(',')
  if (pids(f) !== pids(c)) return `sessions differ: files [${pids(f)}], cli [${pids(c)}]`
  for (const [pid, a] of f) {
    const b = c.get(pid)!
    if (a.sessionId !== b.sessionId || a.kind !== b.kind) return `pid ${pid}: session or kind differs`
    if ((a.status === 'shell' ? 'busy' : a.status) !== b.status) return `pid ${pid}: status ${a.status} in the file, ${b.status} from the cli`
    if (b.waitingFor !== undefined && a.waitingFor !== b.waitingFor) return `pid ${pid}: waitingFor differs`
  }
  return null
}
/** how long a dead pid's registry file may linger before the reason is pid_gone rather than a normal close (no_registration) */
export const DEAD_GRACE_MS = 3_000
export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}
/** the process's start time in the form Claude Code writes the registry's procStart on this platform, or null. Linux: /proc/<pid>/stat field 22
 *  (starttime, clock ticks since boot; the 20th field after the last `)`), as Claude Code writes it there (WO-187: builder's procStart "3154" = its
 *  /proc stat field 22). macOS: `ps -o lstart=` in UTC */
export function osProcStart(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const v = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? ''
      return /^\d+$/.test(v) ? v : null
    } catch { return null }
  }
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
    const out = String(r.stdout ?? '').trim()
    return r.status === 0 && out ? out : null
  } catch { return null }
}
/** the same start time: the same text; two tick counts (Linux): the same number; a tick count and a date: two wordings that cannot be compared, not
 *  taken as different; two dates (another platform's wording): the same second within 2 s; dates neither can read are not taken as different. A tick
 *  count never goes to Date.parse (Bun reads "3154 UTC" as the year 3154: every Claude Code started in a Linux box's first 46 minutes was pid_reused,
 *  txmonster 11-26 07:45Z, WO-187) */
function compareStart(a: string, b: string): boolean | null {
  const n = (s: string) => s.replace(/\s+/g, ' ').trim()
  const A = n(a), B = n(b), tick = (s: string) => /^\d+$/.test(s)
  if (A === B) return true
  if (tick(A) || tick(B)) return tick(A) && tick(B) ? false : null
  const x = Date.parse(`${A} UTC`), y = Date.parse(`${B} UTC`)
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) <= 2_000 : null
}
export const sameStart = (a: string, b: string): boolean => compareStart(a, b) !== false

/** a run's own deadline (1.48.4): `perl -e 'alarm N; exec …'` arms SIGALRM in the process that becomes `bin`, so the run ends at N s even when the daemon
 *  that started it is gone (a crash, a SIGKILL during a wave), when nothing else would ever kill it. Without perl: `bin` as is (the daemon's timer only) */
export const PERL: string | null = ['/usr/bin/perl', '/bin/perl', '/usr/local/bin/perl'].find(p => existsSync(p)) ?? null
export function withDeadline(bin: string, args: string[], seconds: number): [string, string[]] {
  return PERL ? [PERL, ['-e', 'alarm shift; exec @ARGV or exit 127', String(Math.max(1, Math.ceil(seconds))), bin, ...args]] : [bin, args]
}
/** `claude agents --json`'s deadline on its own (withDeadline) */
export const CLI_DEADLINE_S = 15

/** run `bin args`: its stdout when it exits 0; null when it fails, prints more than maxBytes, or is still running at timeoutMs, in which case it is
 *  killed (SIGKILL: a process stuck in a swapping machine may never handle SIGTERM) (1.48.3); onSpawn: its pid (1.48.4) */
export function runCli(bin: string, args: string[], timeoutMs = 15_000, o: { maxBytes?: number; onSpawn?: (pid: number) => void } = {}): Promise<string | null> {
  const maxBytes = o.maxBytes ?? 4 * 1024 * 1024
  return new Promise(res => {
    let done = false, out = '', size = 0
    const end = (v: string | null) => { if (!done) { done = true; clearTimeout(t); res(v) } }
    let p: ReturnType<typeof spawn>
    try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return res(null) }
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {}; end(null) }, timeoutMs)
    if (p.pid) { try { o.onSpawn?.(p.pid) } catch {} }
    p.stdout?.on('data', (b: Buffer) => { size += b.length; if (size > maxBytes) { try { p.kill('SIGKILL') } catch {}; end(null) } else out += b.toString('utf8') })
    p.on('error', () => end(null))
    p.on('close', code => end(code === 0 ? out : null))
  })
}
/** pid is still a `claude agents --json` run (its command line says so): pids are reused, so nothing else is ever killed */
export function isAgentsRun(pid: number): boolean {
  try {
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const c = String(r.stdout ?? '')
    return r.status === 0 && c.includes('agents') && c.includes('--json')
  } catch { return false }
}

/** one `claude agents --json` read shared by every daemon of this machine (1.48.3). 11-25 06:35Z: the whole fleet restarted at once, 38 daemons each
 *  spawned the CLI every 10 s with no wait for the last one, and the Mac mini (24 GB) ran out of memory and was reset twice. Now: at most one run at a
 *  time on the machine (an exclusive lock file); a daemon that wants a read while one runs waits for it and takes its answer (a cache file every daemon
 *  reads); in one daemon a second caller gets the read already in flight. The answer lists every session of the machine; each daemon keeps its own.
 *  1.48.4, a holder that dies mid-run (Codex review): its run carries its own deadline (withDeadline) and its pid is recorded (agents-cli.run); the lock
 *  is taken over only after deadHolderMs (past that deadline), its run is killed first if it somehow still lives, and the takeover moves only that stale
 *  lock (rename, then check its token); a holder removes the lock only while it is still its own (token), so it never frees a successor's */
export class SharedCli {
  private inflight: Promise<string | null> | null = null
  /** dir: where the lock and the cache live (one per machine and user); run: the CLI itself, reporting its pid (runCli on withDeadline); deadHolderMs: a
   *  lock whose holder is gone is taken over after this long (longer than the run's own deadline); lockStaleMs: a lock older than this is taken over
   *  even with its holder alive (a stalled holder; its run is past its deadline); waitMs: how long a caller waits for an answer; endRun: kills a dead
   *  holder's run (default: SIGKILL when isAgentsRun) */
  constructor(readonly o: { dir: string; run: (onSpawn: (pid: number) => void) => Promise<string | null>; now?: Now; deadHolderMs?: number
    lockStaleMs?: number; waitMs?: number; stepMs?: number; alive?: (pid: number) => boolean; endRun?: (pid: number) => void }) {}
  private now(): number { return (this.o.now ?? Date.now)() }
  private get lockPath(): string { return join(this.o.dir, 'agents-cli.lock') }
  private get runPath(): string { return join(this.o.dir, 'agents-cli.run') }
  private get cachePath(): string { return join(this.o.dir, 'agents-cli.json') }
  private json(f: string): any { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
  /** the last answer of any daemon: { at: when that run started, out: its stdout or null (it failed) } */
  cached(): { at: number; out: string | null } | null {
    const j = this.json(this.cachePath)
    return typeof j?.at === 'number' ? { at: j.at, out: typeof j.out === 'string' ? j.out : null } : null
  }
  /** the lock: this taking's token, or null (another daemon holds it) */
  private async lock(): Promise<string | null> {
    const token = `${process.pid}.${Math.random().toString(36).slice(2, 10)}`
    for (let i = 0; i < 2; i++) {
      try { const fd = openSync(this.lockPath, 'wx'); try { writeSync(fd, JSON.stringify({ pid: process.pid, token, at: this.now() })) } finally { closeSync(fd) } return token }
      catch (e: any) {
        if (e?.code !== 'EEXIST') return null
        let mtime = this.now()
        try { mtime = statSync(this.lockPath).mtimeMs } catch { continue }       // gone meanwhile: try again
        const j = this.json(this.lockPath)
        const age = this.now() - (typeof j?.at === 'number' ? j.at : mtime)
        const gone = Number.isInteger(j?.pid) && !(this.o.alive ?? pidAlive)(j.pid)
        if (!(age > (this.o.lockStaleMs ?? 60_000) || (gone && age > (this.o.deadHolderMs ?? 25_000)))) return null
        await this.endRun(j?.token)
        if (!this.takeOver(j?.token)) return null
      }
    }
    return null
  }
  /** a dead or stalled holder's run, if it still lives: killed (only a `claude agents --json` process, only the one that lock recorded), and waited for
   *  (up to 3 s) so the next run never overlaps it */
  private async endRun(token: unknown): Promise<void> {
    const r = this.json(this.runPath)
    if (!r || r.token !== token || !Number.isInteger(r.pid)) return
    const alive = this.o.alive ?? pidAlive
    if (alive(r.pid)) {
      let killed = false
      try { if (this.o.endRun) { this.o.endRun(r.pid); killed = true } else if (isAgentsRun(r.pid)) { process.kill(r.pid, 'SIGKILL'); killed = true } } catch {}
      for (let i = 0; killed && i < 150 && alive(r.pid); i++) await new Promise(res => setTimeout(res, 20))
    }
    try { unlinkSync(this.runPath) } catch {}
  }
  /** move the stale lock away: only the one whose token was read (another daemon may have taken over in between and written its own) */
  private takeOver(token: unknown): boolean {
    const tmp = `${this.lockPath}.takeover.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
    try { renameSync(this.lockPath, tmp) } catch { return false }
    const j = this.json(tmp)
    if ((j?.token ?? null) === (token ?? null)) { try { unlinkSync(tmp) } catch {}; return true }
    try { linkSync(tmp, this.lockPath) } catch {}                          // it was a fresh lock: put it back (unless a lock is there again)
    try { unlinkSync(tmp) } catch {}
    return false
  }
  private unlock(token: string): void {
    if (this.json(this.runPath)?.token === token) { try { unlinkSync(this.runPath) } catch {} }
    if (this.json(this.lockPath)?.token === token) { try { unlinkSync(this.lockPath) } catch {} }
  }
  /** an answer from a run that started at or after notBefore (ms); null = the run failed, or none came within waitMs */
  read(notBefore: number): Promise<string | null> {
    if (!this.inflight) this.inflight = this.doRead(notBefore).finally(() => { this.inflight = null })
    return this.inflight
  }
  private async doRead(notBefore: number): Promise<string | null> {
    try { mkdirSync(this.o.dir, { recursive: true }) } catch {}
    const until = this.now() + (this.o.waitMs ?? 40_000)
    for (;;) {
      const c = this.cached()
      if (c && c.at >= notBefore) return c.out
      const token = await this.lock()
      if (token) {
        try {
          const c2 = this.cached()
          if (c2 && c2.at >= notBefore) return c2.out
          const at = this.now()
          const out = await this.o.run(pid => { try { writeFileSync(this.runPath, JSON.stringify({ token, pid, at: this.now() })) } catch {} })
          try { const tmp = `${this.cachePath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ at, out })); renameSync(tmp, this.cachePath) } catch {}
          return out
        } finally { this.unlock(token) }
      }
      if (this.now() >= until) return null
      await new Promise(r => setTimeout(r, this.o.stepMs ?? 200))
    }
  }
}

/** the claude processes this daemon has a stream with (offline not_connected). A stream's peer is looked up once (null = not found: counted as any pid,
 *  not found is no proof of absence); a pid stays connected 15 s after its last open stream (Claude Code's MCP reconnect closes the old one first) */
export class Streams {
  private peer = new Map<string, number | null>()
  private at = new Map<number, number>()
  private anyAt = -Infinity
  constructor(readonly o: { open: () => Iterable<[string, boolean]>; graceMs?: number; now?: Now }) {}
  note(sid: string, pid: number | null): void { this.peer.set(sid, pid) }
  connected(pid: number): boolean {
    const now = (this.o.now ?? Date.now)(), open = new Set<string>()
    for (const [sid, up] of this.o.open()) {
      if (!up) continue
      open.add(sid)
      const p = this.peer.get(sid)
      if (p == null) this.anyAt = now; else this.at.set(p, now)
    }
    for (const sid of [...this.peer.keys()]) if (!open.has(sid)) this.peer.delete(sid)
    return now - Math.max(this.at.get(pid) ?? -Infinity, this.anyAt) < (this.o.graceMs ?? 15_000)
  }
}

type Via = { via: 'files' | 'cli'; why: string; check: { at: string; agree: boolean; why: string | null } | null }
export class Registry implements StatusSource {
  private cache = new Map<string, { m: number; size: number; e: RegEntry | null; bad: boolean }>()
  private v: Via = { via: 'files', why: '', check: null }
  private cliRead: RegEntry[] = []
  private watcher: FSWatcher | null = null
  private timers: Array<ReturnType<typeof setInterval>> = []
  private starts = new Map<number, { at: number; v: string | null }>()
  /** pid → when it was first seen dead while its registry file was still there (DEAD_GRACE_MS) */
  private deadSince = new Map<number, number>()
  private shapeTold = ''
  private started = false
  private checkTimer: ReturnType<typeof setTimeout> | null = null
  /** the CLI read in flight in this daemon (1.48.3: never a second one while one runs) */
  private cliBusy: Promise<RegEntry[] | null> | null = null
  /** dir: the registry (~/.claude/sessions); workspace: AGENT_WORKSPACE_DIR; transcripts: the workspace's project dir (~/.claude/projects/<escaped>);
   *  tmux: CHANNEL_BOT_TMUX_SESSION; sessionId: the lanes' main session id; connected: this daemon has a stream with that claude pid; cli: the output of
   *  `claude agents --json` from a run that started at or after notBefore (SharedCli.read; null = could not run; absent = no CLI: the files only);
   *  changed: a registry file changed (the watch); firstCheckMs: the first comparison after start (default 10–70 s at random, so a fleet that starts
   *  at once does not compare at once); checkMs: then every checkMs ± 20 %; cliPollMs: the CLI's reading read again while it is in force */
  constructor(readonly o: { dir: string; workspace: string; transcripts: () => string | null; tmux?: string | null; sessionId?: () => string | null
    connected: (pid: number) => boolean; cli?: (notBefore: number) => Promise<string | null>; changed?: () => void; log?: (m: string) => void
    alive?: (pid: number) => boolean; procStart?: (pid: number) => string | null; now?: Now; firstCheckMs?: number; checkMs?: number; cliPollMs?: number
    retryMs?: number }) {}
  private now(): number { return (this.o.now ?? Date.now)() }
  private alive(pid: number): boolean { return (this.o.alive ?? pidAlive)(pid) }
  private log(m: string): void { try { this.o.log?.(m) } catch {} }

  /** the watch on the registry dir; the comparison about a minute after start and then every ~10 min; while the CLI's reading is in force, it is read
   *  again (shared, at most one run on the machine) and compared every 30 s */
  start(): void {
    this.started = true
    this.watchDir()
    if (!this.o.cli) return  // files() retries the watch; only CLI comparisons need timers
    const next = (ms: number) => {
      this.checkTimer = setTimeout(() => { this.watchDir(); void this.crossCheck().finally(() => { if (this.started) next(this.jitter(this.o.checkMs ?? 600_000)) }) }, ms)
      ;(this.checkTimer as any).unref?.()
    }
    next(this.o.firstCheckMs ?? 10_000 + Math.random() * 60_000)
    this.timers.push(setInterval(() => { if (this.v.via === 'cli') void this.pollCli() }, this.o.cliPollMs ?? 30_000))
    for (const t of this.timers) (t as any).unref?.()
  }
  private jitter(ms: number): number { return ms * (0.8 + Math.random() * 0.4) }
  stop(): void {
    this.started = false; for (const t of this.timers) clearInterval(t); this.timers = []
    if (this.checkTimer) clearTimeout(this.checkTimer); this.checkTimer = null
    try { this.watcher?.close() } catch {}; this.watcher = null
  }
  private watchDir(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.o.dir, (_ev, name) => { if (String(name ?? '').endsWith('.json')) { try { this.o.changed?.() } catch {} } })
      this.watcher.on('error', () => { try { this.watcher?.close() } catch {}; this.watcher = null })
    } catch { this.watcher = null }                                     // no dir yet: the 2 s read still runs and watches again (files)
  }

  /** the registry files now: a file is parsed again only when its mtime or size changed; one that is not JSON yet (written while read) keeps its last
   *  reading. `bad`: files of this workspace in another shape (1.48.3: still read as far as they go); `unsettled`: the pids of those younger than
   *  REG_SETTLE_MS, left out of the comparison with the CLI */
  files(): { entries: RegEntry[]; bad: string[]; unsettled: Set<number> } {
    const entries: RegEntry[] = [], bad: string[] = [], seen = new Set<string>(), unsettled = new Set<number>()
    if (this.started && !this.watcher) this.watchDir()                  // the dir appeared after start (a first session on this machine), or the watch failed
    let names: string[] = []
    try { names = readdirSync(this.o.dir).filter(n => /^\d+\.json$/.test(n)) } catch {}
    for (const n of names) {
      const f = join(this.o.dir, n)
      seen.add(f)
      let st: { mtimeMs: number; size: number }
      try { st = statSync(f) } catch { continue }
      let c = this.cache.get(f)
      if (!c || c.m !== st.mtimeMs || c.size !== st.size) {
        let j: any
        try { j = JSON.parse(readFileSync(f, 'utf8')) } catch { if (c) entries.push(...(c.e ? [c.e] : [])); continue }
        const e = regEntry(j)
        const mine = typeof j?.cwd === 'string' && samePath(j.cwd, this.o.workspace)
        // only an interactive session can be the main: a lane's short-lived `claude -p` file in the same folder (other kind, other fields) must not send
        // the daemon to the CLI (1.47.0 on epeius: 83124.json, a few seconds' session, flipped the read to the CLI until the 10-min check)
        c = { m: st.mtimeMs, size: st.size, e, bad: mine && mainCandidate(j ?? {}) && (!e || !REG_STATUSES.has(e.status) || typeof j.procStart !== 'string') }
        this.cache.set(f, c)
      }
      // a session that just started writes its file before every field is filled (seen 11-25 05:46Z: the lab main's 63377.json): a file younger than
      // REG_YOUNG_MS is not judged yet, it is read again on the next pass
      if (c.bad && Date.now() - st.mtimeMs < REG_YOUNG_MS) { this.cache.delete(f); continue }
      if (c.e) entries.push(c.e)
      if (c.bad) { bad.push(n); if (Date.now() - st.mtimeMs < REG_SETTLE_MS) unsettled.add(Number(n.slice(0, -5))) }
    }
    for (const f of [...this.cache.keys()]) if (!seen.has(f)) this.cache.delete(f)
    return { entries, bad, unsettled }
  }
  /** the reading in force: the files, or (they disagreed with the CLI) the CLI's last answer. 1.48.3: a file in another shape is read as far as it goes
   *  (an odd status is busy {registry_status}; a file without the fields regEntry needs is not a session) and is logged once; it never switches the read
   *  to the CLI by itself (11-25 06:35Z that switch, in 38 daemons at once, started the memory run on the Mac mini) */
  entries(): RegEntry[] {
    if (this.v.via === 'cli') return this.cliRead
    const r = this.files()
    if (r.bad.length) {
      const key = r.bad.sort().join(',')
      if (this.shapeTold !== key) { this.shapeTold = key; this.log(`onsen: registry file(s) ${key} of this workspace are not in the known shape: read as far as they go (the next comparison with \`claude agents --json\` decides)`) }
    }
    return r.entries
  }
  /** the CLI's sessions from a run that started at or after notBefore; one call in flight at a time in this daemon (a second caller gets the same) */
  private cliEntries(notBefore: number): Promise<RegEntry[] | null> {
    if (!this.o.cli) return Promise.resolve(null)
    if (!this.cliBusy) {
      this.cliBusy = (async () => {
        const out = await this.o.cli!(notBefore).catch(() => null)
        if (out == null) return null
        try { const a = JSON.parse(out); return Array.isArray(a) ? a.map(regEntry).filter((e): e is RegEntry => !!e) : null } catch { return null }
      })().finally(() => { this.cliBusy = null })
    }
    return this.cliBusy
  }
  /** while the CLI's reading is in force: read it again (an answer up to 25 s old, any daemon's, will do) and compare; agreeing switches back */
  private async pollCli(): Promise<void> {
    const cli = await this.cliEntries(this.now() - (this.o.cliPollMs ?? 30_000) + 5_000)
    if (!cli || this.v.via !== 'cli') return
    this.cliRead = cli
    const f = this.files()
    if (!compareRegistry(f.entries, cli, this.o.workspace, p => this.alive(p), f.unsettled)) this.setVia(null)
    try { this.o.changed?.() } catch {}
  }
  private setVia(why: string | null): void {
    const was = this.v.via
    this.v = { via: why ? 'cli' : 'files', why: why ?? '', check: { at: iso(this.now()), agree: !why, why } }
    if (was !== this.v.via) this.log(why ? `onsen: the registry files disagree with \`claude agents --json\` (${why}): the CLI is read instead (every 30 s, shared)`
      : 'onsen: the registry files agree with `claude agents --json` again: the files are read')
    else if (why) this.log(`onsen: registry cross-check: still disagree (${why})`)
  }
  /** files vs CLI. A status can change between the two reads: a difference is read again once (retryMs, a new run) before it counts. A file in another
   *  shape younger than REG_SETTLE_MS is left out. No CLI, or it did not answer: nothing to compare, the reading stays as it is */
  async crossCheck(): Promise<Via['check']> {
    if (!this.o.cli) return this.v.check
    let why: string | null = null
    for (let i = 0; i < 2; i++) {
      // the first read takes an answer another daemon got in the last 5 s (a fleet that starts at once shares one run); the retry, one from the last 1 s
      const asked = this.now(), cli = await this.cliEntries(asked - (i === 0 ? 5_000 : 1_000))
      if (!cli) { this.log('onsen: `claude agents --json` did not answer: the registry files are not cross-checked this time'); return this.v.check }
      const f = this.files()
      why = compareRegistry(f.entries, cli, this.o.workspace, p => this.alive(p), f.unsettled)
      if (!why) break
      this.cliRead = cli
      if (i === 0) await new Promise(r => setTimeout(r, this.o.retryMs ?? 1_500))
    }
    this.setVia(why)
    if (why) { this.shapeTold = ''; try { this.o.changed?.() } catch {} }
    return this.v.check
  }
  mode(): Via { return this.v }

  private pick(entries: RegEntry[]): RegEntry | null {
    return pickMain(entries, { workspace: this.o.workspace, tmux: this.o.tmux, sessionId: this.o.sessionId?.(), alive: p => this.alive(p) })
  }
  main(): RegEntry | null { return (this.lastMain = this.pick(this.entries())) }
  /** M2 can adopt the status source's candidate only with positive process identity. The CLI can omit entrypoint,
   *  tmux and procStart. Confirm its selection against the same session file and a fresh OS read (pids can be reused). */
  mainForAdoption() {
    const e = this.main()
    if (!e || !this.alive(e.pid)) return null
    const file = this.v.via === 'files' ? e : this.files().entries.find(f => f.pid === e.pid && f.sessionId === e.sessionId)
    if (file && file !== e && !this.pick([file])) return null
    const start = (this.o.procStart ?? osProcStart)(e.pid)
    const match = start && file?.procStart ? compareStart(start, file.procStart) : null
    const dir = this.o.transcripts()
    return { pid: e.pid, sessionId: e.sessionId, transcript: dir ? join(dir, `${e.sessionId}.jsonl`) : undefined,
      issue: match === true ? null : match === false ? 'procStart mismatch' : 'procStart unavailable or incomparable' }
  }
  /** WO-165: the main as last read (no read of its own: the status computes it every 2 s and at each change); TurnWatch follows its transcript */
  private lastMain: RegEntry | null = null
  mainSessionId(): string | null { return this.lastMain?.sessionId ?? null }
  /** the OS start time of `pid`, read at most every 30 s */
  private startOf(pid: number): string | null {
    const c = this.starts.get(pid), now = this.now()
    if (c && now - c.at < 30_000) return c.v
    const v = (this.o.procStart ?? osProcStart)(pid)
    this.starts.set(pid, { at: now, v })
    if (this.starts.size > 50) this.starts.delete(this.starts.keys().next().value!)
    return v
  }
  /** the newest write to the main's transcript (<sessionId>.jsonl; without a session: the newest transcript of the workspace) and its subagents'
   *  (<sessionId>/subagents/*.jsonl, where 2.1.322 writes them; an older Claude Code wrote sidechains into the main file), ISO; null = none found */
  /** WO-157 (Chiron 12112, A): the main's background sub-agents still working: their transcripts (<session>/subagents/agent-*.jsonl, launched in the
   *  background per the .meta.json, or with no meta) written in the last BG_AGENT_ACTIVE_MS; null when the folder cannot be read */
  backgroundAgents(sid: string | null): number | null {
    const dir = this.o.transcripts()
    const f = dir ? (sid ? join(dir, `${sid}.jsonl`) : newestJsonl(dir)) : null
    if (!dir || !f) return null
    const sub = join(dir, basename(f, '.jsonl'), 'subagents'), since = this.now() - BG_AGENT_ACTIVE_MS
    let n = 0
    try {
      for (const name of readdirSync(sub)) {
        if (!name.endsWith('.jsonl')) continue
        let m = 0
        try { m = statSync(join(sub, name)).mtimeMs } catch { continue }
        if (m < since) continue
        try { const meta = JSON.parse(readFileSync(join(sub, name.replace(/\.jsonl$/, '.meta.json')), 'utf8')); if (meta?.requestShape && meta.requestShape !== 'background') continue } catch {}
        n++
      }
    } catch { return null }
    return n
  }
  lastActivity(sid: string | null): string | null {
    const dir = this.o.transcripts()
    if (!dir) return null
    const f = sid ? join(dir, `${sid}.jsonl`) : newestJsonl(dir)
    if (!f) return null
    let m = 0
    try { m = statSync(f).mtimeMs } catch {}
    const sub = join(dir, basename(f, '.jsonl'), 'subagents')
    try { for (const n of readdirSync(sub)) if (n.endsWith('.jsonl')) { try { m = Math.max(m, statSync(join(sub, n)).mtimeMs) } catch {} } } catch {}
    return m > 0 ? iso(m) : null
  }
  inputs(s: StatusShared): StatusInputs {
    const base = { queued_joey: s.queuedJoey, walled: s.wall?.walled ? { until: s.wall.until, kind: s.wall.kind } : null, compacting: !!s.compacting, turn: s.turn ?? null,
      ...(s.lanes?.length ? { lanes: s.lanes } : {}), ...(s.edges ? { edges: s.edges } : {}) }
    const e = this.main()
    const off = (why: OfflineReason): StatusInputs => ({ main: null, offline: why, last_activity_at: this.lastActivity(e?.sessionId ?? this.o.sessionId?.() ?? null), ...base })
    if (!e) return off('no_registration')
    if (!this.alive(e.pid)) {
      // a normal close (/exit) ends the process a moment before Claude Code deletes its registry file: wait DEAD_GRACE_MS for the file to go, so a
      // closed session is offline `no_registration` and only a process that died with its file left behind (kill -9, a crash) is `pid_gone` (WO-143)
      const since = this.deadSince.get(e.pid) ?? this.now()
      this.deadSince.set(e.pid, since)
      if (this.now() - since < DEAD_GRACE_MS) return { main: { status: e.status, waiting_for: e.waitingFor ?? null, status_at: e.statusAt ?? null }, last_activity_at: this.lastActivity(e.sessionId), ...base }
      return off('pid_gone')
    }
    this.deadSince.delete(e.pid)
    if (e.procStart) { const os = this.startOf(e.pid); if (os && !sameStart(os, e.procStart)) return off('pid_reused') }
    if (!this.o.connected(e.pid)) return off('not_connected')
    return { main: { status: e.status, waiting_for: e.waitingFor ?? null, status_at: e.statusAt ?? null,
      ...(e.status === 'busy' ? { background_agents: this.backgroundAgents(e.sessionId) } : {}) }, last_activity_at: this.lastActivity(e.sessionId), ...base }
  }
}
