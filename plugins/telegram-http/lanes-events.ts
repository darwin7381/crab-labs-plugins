/**
 * lanes-events.ts — M3, the event record with obligations (docs/state-journal.md).
 *
 * The router opens one record per inbound event: { class, owner, obligations[], outcome }. An obligation is what the event still owes someone:
 *   joey     a line, or a decision (level line < decision); `ring` + due_at for a critical alert
 *   main     the event was handed to the main (level handed): an M1 item, met when that item is done
 *   peer     an answer to the peer that asked (level answer; handed to the main and promised by the router it is the main's: owner main, due_at),
 *            a message of the lane's own to an agent (level message), or the router's interim line (level interim, owner router)
 *   receipt  the completion of a scheduler run (run_id), once per run_id across every event
 * An obligation is open → requested (the outbound call was accepted and is being delivered) → met on the delivery result (the Telegram message
 * id, the mesh `delivered`, the scheduler's answer), or back to open with `failed` when the delivery failed. handed: one hand-over transition
 * (handOver) gave it to the main. dropped: the event's thread was stopped before it ran. merged: it was handled in another event's run.
 * waived (WO-177): an answer to a peer the lane closed its run without sending: it judged the item needed none (closeAccount).
 * The one rule: every outbound tool call of a lane is a request to meet an obligation of its event. Meeting an open one is accepted; raising it
 * (a line to a decision, or a line whose outcome changed) is accepted; repeating a met or requested one is refused, and the refusal names what is
 * still open. The router (lanes.ts) picks the tier and format from class × obligation × outcome. One sweep acts on obligations past their due time.
 * closed = nothing is owed (open, requested, or a Joey line / peer answer handed to the main). One writer: the tg daemon. Every transition is a journal line (rec event).
 */
import type { Journal, Row } from './lanes-state.ts'

export type EvClass = 'scheduled' | 'followup' | 'peer' | 'joey' | 'alert' | 'critical'
export type ObKind = 'joey' | 'main' | 'peer' | 'receipt'
export type Outcome = 'normal' | 'changed' | 'failed'
export type ObState = 'open' | 'requested' | 'met' | 'handed' | 'dropped' | 'merged' | 'waived'
export type Ob = { id: string; kind: ObKind; level: string; state: ObState; by?: string; owner?: string
  self?: import('./onsen-self.ts').SelfWrite
  /** WO-128: a hand-over that can wait (a decision card): the main's, but no M1 item and no due time until it is woken (`woke`: urgent | due); `card`: the
   *  hand-over is a decision card's (not listed in open-handoffs.md: the mailbox is the list) */
  defer?: boolean; woke?: 'urgent' | 'due' | 'batch'; woke_at?: string; card?: boolean      // WO-137 甲: `batch` = the batch wake's own obligation
  due_at?: number; ring?: boolean; rang?: boolean; told?: boolean; to?: string; run_id?: string; item?: string; handoff?: string; cls?: string; what?: string; req?: string; sent?: string
  /** the delivery that met it (message id, btcc id, the scheduler's answer); why the last delivery failed; the outcome a joey line was met with; the event a merged one went into */
  ref?: string; failed?: string; outcome?: Outcome; into?: string
  /** 1.41.1: a scheduler receipt recorded met on a refusal, owed again since this boot (lanes.ts restoreReceipts) */
  restored?: string
  /** 002q (B08): a Joey line's matter (`<service>/<check>`, from the call's structured service and check) and when it was met */
  subject?: string; met_at?: string
  /** while requested: what it was before the request (a failed delivery puts it back) */
  prev?: { state: ObState; level: string; outcome?: Outcome; by?: string } }
export type Want = { kind: ObKind; level: string; to?: string; run_id?: string; handoff?: string; outcome?: Outcome; subject?: string
  /** 002t: the line goes into the lane's own Telegram topic, where Joey talks with it (a worker): a conversation, so a met line refuses no later one */
  conversation?: boolean }
/** 002q (B08): the matter a Joey line is about, from the call's structured `service` and `check` (never from its text): one key across events */
export function matterKey(service: unknown, check: unknown): string | undefined {
  const n = (v: unknown): string => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return n(service) ? `${n(service)}/${n(check)}` : undefined
}
export type Verdict = { ok: boolean; why?: string; ob?: Ob; raised?: boolean; event?: Row }
export type HandOver = { handoff: string; by: string; what?: string; due_at?: number; cls?: string
  /** 002w (B, gap 9): the due time a peer's answer handed to the main gets (like an answer the router promised: the due sweep tells Joey once) */
  answer_due?: number
  /** 002y (X-3): the lane hands the peer's REQUEST itself to the main (handoff_main): the answer is the main's whatever the lane already sent. A reply of
   *  the lane's that met it (reply_agent) was the lane's own line: it stays met as level `message`, and the answer is handed like an owed one. The exit
   *  rule and the thread stop do not set it (what the lane already answered there stays answered). */
  request?: boolean
  /** WO-128: the hand-over can wait (a decision card): no M1 item, no due time (lanes.ts handToMain) */
  defer?: boolean
  /** WO-128: a decision card's hand-over (decide_later; a deferred mailbox_card) */
  card?: boolean }

const RANK: Record<string, number> = { none: 0, line: 1, decision: 2 }
const SEV: Record<Outcome, number> = { normal: 0, changed: 1, failed: 2 }
/** still owed: nothing has met it yet (a request in flight is not a delivery) */
export const owing = (o: Ob): boolean => o.state === 'open' || o.state === 'requested'
/** 002q (T7-R, T8-R, T6-R): what keeps an event open. Owed by whoever holds it: an open or requested obligation, or a Joey line, a peer answer or a
 *  scheduler receipt handed to the main (the main meets those: its reply, its send_to_agent, and since 002w D its own ./bin/btcc-receipt complete N). */
export const owed = (o: Ob): boolean => owing(o) || (o.state === 'handed' && (o.kind === 'joey' || o.kind === 'peer' || o.kind === 'receipt'))

export type EventsApi = ReturnType<typeof createEvents>
/** `changed`: called after every write of an event record (lanes-golive: the open-handoffs file follows the main's obligations). Never throws into a write. */
export function createEvents(J: Journal, changed?: () => void, promises?: (id: string, obs: Ob[], refs?: import('./onsen-items.ts').ItemRef[]) => void) {
  let k = 0
  const obId = (kind: string): string => `${kind}-${Date.now().toString(36)}-${(++k).toString(36)}`
  const get = (id: string): Row | undefined => J.get('event', id)
  const obsOf = (e: Row | undefined): Ob[] => (e?.obligations ?? []).map((o: Ob) => ({ ...o }))
  /** a receipt obligation is one per scheduler run, whichever event carries it (met, or being delivered) */
  const receiptMet = (run: string): Row | undefined => J.rows('event', e => (e.obligations ?? []).some((o: Ob) => o.kind === 'receipt' && o.run_id === run && (o.state === 'met' || o.state === 'requested')))[0]

  /** 002q (B08): the last Joey line met about a matter, in any event (a fold over the event records: no table of its own) */
  function lastOnMatter(subject: string): { e: Row; o: Ob } | undefined {
    let best: { e: Row; o: Ob } | undefined
    for (const e of J.rows('event')) if (e.class !== 'joey') for (const o of (e.obligations ?? []) as Ob[])
      if (o.kind === 'joey' && o.state === 'met' && o.subject === subject && (!best || String(o.met_at ?? '') >= String(best.o.met_at ?? ''))) best = { e, o }
    return best
  }
  /** closed = nothing is owed (owed: open, requested, or a Joey line / peer answer handed to the main). An event that owes nothing, information, is
   *  closed at once. 002q: a Joey line handed to the main keeps its event open until the main's line meets it (002p closed it when the hand-over's
   *  M1 item was done, with the line still owed). */
  function write(e: Row | { id: string }, obs: Ob[], f: Record<string, unknown> = {}): Row {
    promises?.(e.id, obs, (f.onsen_items ?? (e as Row).onsen_items) as import('./onsen-items.ts').ItemRef[] | undefined)
    const row = J.write('event', e.id, obs.some(owed) ? 'open' : 'closed', { obligations: obs, ...f })!
    try { changed?.() } catch {}
    return row
  }
  /** the router: one record per inbound event (an existing record is returned as it is: a retry is the same event) */
  /** the router: one record per inbound event (an existing record is returned as it is: a retry is the same event). `owner` is a lane, `main`, or
   *  `router` (information nobody handles: no obligations, closed at once). `fields` are what the main must know about it (must_know, flags, ...). */
  function open(id: string, f: { class: EvClass; owner: string; obligations: Array<Omit<Ob, 'id' | 'state'> & { state?: Ob['state'] }>; thread?: string | null; lane?: string | null; from?: string; text?: string; fields?: Record<string, unknown> }): Row {
    const was = get(id)
    if (was) return was
    const obs: Ob[] = f.obligations.map(o => ({ state: 'open', ...o, id: obId(o.kind) }) as Ob)
    for (const o of obs) if (o.kind === 'receipt' && o.run_id && receiptMet(o.run_id)) { o.state = 'met'; o.by = `already completed by ${receiptMet(o.run_id)!.id}` }
    return write({ id }, obs, { ...(f.fields ?? {}), class: f.class, owner: f.owner, outcome: 'normal', thread: f.thread ?? null, lane: f.lane ?? null, from: f.from ?? null, text: (f.text ?? '').slice(0, 300) })
  }
  /** what an event still owes from its lane (the stop hook's question, and the exit rule's) */
  function openObs(id: string): Ob[] { return obsOf(get(id)).filter(o => owing(o) && o.kind !== 'main' && (o.owner ?? 'lane') === 'lane') }
  /** 002w (B, gap 9): what an event still owes from the MAIN (its Stop check's question, the one openObs asks of a lane): a Joey line, a peer's answer or a
   *  scheduler receipt handed to it, or open where the main owns the obligation or the event. A commitment (the main's own promise, due later) is no turn's. */
  function mainObs(id: string): Ob[] {
    const e = get(id)
    return obsOf(e).filter(o => (o.kind === 'joey' || o.kind === 'receipt' || (o.kind === 'peer' && o.level === 'answer'))
      && (o.state === 'handed' || (o.state === 'open' && (o.owner === 'main' || e?.owner === 'main'))))
  }
  const openText = (id: string): string => {
    const os = openObs(id)
    return os.length ? `still open: ${os.map(o => o.kind === 'joey' ? `a ${o.level} for Joey (notify_joey; ask_joey if he must decide)` : o.kind === 'peer' ? `an answer to ${o.to} (reply_agent)` : `the receipt of scheduler run ${o.run_id} (receipt run_id=${o.run_id})`).join('; ')}.`
      : 'nothing else is open for this event: close with receipt (no run_id) or just end.'
  }

  /** THE rule: a lane's outbound call asks to meet an obligation of its event. Accepted = the obligation is `requested` (written); the caller
   *  delivers and reports the result (result()). Refused = a journal line with the reason; nothing changes. A hand-over is the one transition handOver. */
  function request(id: string, tool: string, want: Want, outcome?: Outcome, f: Record<string, unknown> = {}): Verdict {
    const e = get(id)
    if (!e) return { ok: true }                                    // no record: not an event the router routed (a unit's hand-made run); nothing to check or meet
    const obs = obsOf(e)
    const joey = obs.find(o => o.kind === 'joey'), main = obs.find(o => o.kind === 'main')
    let refused = '', ob: Ob | undefined, raised = false
    const ask = (o: Ob, level: string): void => { o.prev = { state: o.state, level: o.level, outcome: o.outcome, by: o.by }; o.state = 'requested'; o.level = level; o.by = tool; delete o.failed }
    switch (want.kind) {
      case 'joey': {
        ob = joey
        const out = outcome ?? 'normal'
        // 002q (B08): one matter, one line per outcome, across events and their follow-ups: the last line Joey got about this matter (any event) with the
        // same outcome makes this one a repeat: refused, and this event's line is settled as merged into the event that told him
        // The rule is about a lane's own reports. An event of class joey is Joey's own message: its line is the answer he asked for, never a repeat
        // (002q E03: his quote-reply about the same service was refused as a repeat and went to the main)
        const told = want.subject && want.level === 'line' && e.class !== 'joey' ? lastOnMatter(want.subject) : undefined
        if (told && (told.o.outcome ?? 'normal') === out && !(ob && (ob.state === 'requested' || ob.state === 'handed'))) {
          const said = told.e.said ? `: 「${String(told.e.said).slice(0, 160)}」` : ''
          refused = `Joey already has a line about ${want.subject} with outcome ${out} (event ${told.e.id}${told.e.lane ? `, ${told.e.lane}` : ''}${said}); one line per matter: another only when the outcome changed`
          if (ob && ob.state === 'open') { ob.state = 'merged'; ob.into = told.e.id; ob.by = 'matter' }
          else if (!ob) obs.push({ id: obId('joey'), kind: 'joey', level: 'line', state: 'merged', into: told.e.id, by: 'matter', subject: want.subject })
          const row = write(e, obs, { tool, refused, refused_kind: 'joey' })
          return { ok: false, why: `refused: ${refused}. ${openText(id)}`, ob: obs.find(o => o.kind === 'joey'), event: row }
        }
        // 002r (T2-R E5): an event the router opened with no Joey line (a high-frequency routine owes a receipt only; a fan-out part and a curator
        // report to the main) takes a line only when there is news: a changed or failed outcome, or a decision. "Nothing new" is the receipt's.
        if (!ob && want.level === 'line' && out === 'normal' && e.class !== 'joey')
          refused = 'this event owes Joey no line, and your line reports nothing new since the last run (a routine check tells him only when something changed, a part reports to the main): it goes in your receipt, not to Joey'
        else if (!ob) { ob = { id: obId('joey'), kind: 'joey', level: want.level, state: 'open' }; obs.push(ob); raised = true; ask(ob, want.level) }
        // WO-177 (Chiron 04:01Z item 3: the lane's 「完成」 03:52:00, Onsen 42072, and the main's 03:52:02, 42073, for one event): while the event is handed
        // to the main (its main obligation owed), the line to Joey is the main's (every hand-over says 「由你回報 Joey 一次」), also when the lane had met
        // its own line before it handed over (that line stays met; a raise of it is not the lane's any more)
        else if (ob.state === 'handed' || (main && owing(main))) refused = obs.some(o => o.kind === 'main' && o.defer && !o.woke && owing(o))       // WO-128: a card that can wait
          ? 'this matter waits on the main\'s decision in its mailbox (a card that can wait; the main is not woken for it): the run that finishes it after the decision tells Joey, once. Put what you did in your receipt'
          : 'this event is handed to the main: the main reports to Joey'
        else if (ob.state === 'requested') refused = 'a line about this event is being sent to Joey right now'
        // 002t (station 4, I03 and F01 live): a worker's own topic is a conversation with Joey, like the main's chat. The one-message rule is about
        // notifications (one line per event, per outcome); in a topic it refused the result Joey asked for, because the worker's greeting had met the
        // line (I03: 「14 份快照，最舊 10-30」 never reached him), and every progress report he asked for.
        else if (ob.state === 'met' && want.conversation && want.level === 'line' && ob.level === 'line') { ask(ob, 'line'); ob.outcome = out }
        else if (ob.state === 'met' && (RANK[want.level] < RANK[ob.level] || (RANK[want.level] === RANK[ob.level] && (ob.level === 'decision' || out === (ob.outcome ?? 'normal')))))
          refused = ob.level === 'decision' ? 'Joey was already asked to decide this event (ask_joey); one ask per event'
            : `Joey already has his line for this event (outcome ${ob.outcome ?? 'normal'}); one message per event: another line only when the outcome changed (put anything more in your receipt)`
        else if (ob.state === 'dropped' || ob.state === 'merged') refused = `this event's line was ${ob.state}${ob.into ? ` into ${ob.into}` : ''}`
        else { raised = ob.state === 'met'; ask(ob, want.level); ob.outcome = out }
        if (ob && ob.state === 'requested' && want.subject) ob.subject = want.subject
        break
      }
      case 'peer':
        ob = obs.find(o => o.kind === 'peer' && o.to === want.to && (o.owner ?? 'lane') === 'lane')
        if (!ob) { ob = { id: obId('peer'), kind: 'peer', level: 'message', to: want.to, state: 'open' }; obs.push(ob); ask(ob, 'message') }   // an agent the event did not owe: its own obligation
        else if (ob.state === 'open') ask(ob, ob.level)
        else if (ob.state === 'waived') { ob.state = 'open'; delete ob.by; ask(ob, ob.level) }   // WO-177: a send after the receipt undoes the waiver (owed until delivered)
        else refused = ob.state === 'requested' ? `a message to ${want.to} about this event is being delivered right now`
          : ob.state === 'handed' ? `this event is handed to the main: the main answers ${want.to}`
          : ob.level === 'message' ? `${want.to} already got a message about this event` : `${want.to} already has the answer to this event`
        break
      case 'receipt': {
        const prior = want.run_id ? receiptMet(want.run_id) : undefined
        ob = obs.find(o => o.kind === 'receipt' && o.run_id === want.run_id)
        if (prior) refused = `scheduler run ${want.run_id} was already completed (${prior.id === id ? 'by this event' : `by ${prior.id}`}); it is not completed again`
        else if (!ob) { ob = { id: obId('receipt'), kind: 'receipt', level: 'run', run_id: want.run_id, state: 'open' }; obs.push(ob); ask(ob, 'run') }
        else ask(ob, 'run')
        break
      }
      case 'main':
        if (main && owing(main)) refused = 'this event is already handed to the main'
        else if (joey?.state === 'met' && joey.level === 'decision') refused = 'Joey was asked to decide this event (ask_joey): he owns it; do not also hand it to the main'
        break
    }
    if (refused) {
      const row = write(e, obsOf(e), { tool, refused, refused_kind: want.kind })
      return { ok: false, why: `refused: ${refused}. ${openText(id)}`, ob, event: row }
    }
    if (want.kind === 'main') return { ok: true, event: e }                // accepted: the caller makes the one hand-over transition (handOver)
    const out: Outcome = outcome && SEV[outcome] > SEV[(e.outcome as Outcome) ?? 'normal'] ? outcome : (e.outcome ?? 'normal')
    const row = write(e, obs, { tool, refused: null, refused_kind: null, outcome: out, ...f })
    return { ok: true, ob: obs.find(o => o.id === ob!.id), raised, event: row }
  }
  /** the delivery of a requested obligation: met on success (ref = the message id / btcc id / the scheduler's answer), else back to what it was with
   *  `failed` (so the lane's retry is a request like the first one, not a repeat) */
  function result(id: string, obId_: string | undefined, ok: boolean, d: { ref?: string | number | null; why?: string } = {}, f: Record<string, unknown> = {}): Row | null {
    const e = get(id)
    if (!e) return null
    const obs = obsOf(e)
    const o = obId_ ? obs.find(x => x.id === obId_) : undefined
    if (!o || o.state !== 'requested') return null
    if (ok) { o.state = 'met'; o.ref = d.ref != null ? String(d.ref) : undefined; o.met_at = new Date().toISOString(); delete o.prev; delete o.failed }
    else { const p = o.prev ?? { state: 'open' as ObState, level: o.level }; o.state = p.state; o.level = p.level; o.outcome = p.outcome; o.by = p.by; o.failed = d.why ?? 'not delivered'; delete o.prev }
    return write(e, obs, { tool: ok ? 'delivered' : 'not-delivered', ...f })
  }
  /** THE hand-over (handoff_main, the exit rule, the thread stop alike): one `main` obligation (open, owned by the main) and every lane obligation
   *  still owed (a line for Joey, an answer to a peer, a receipt) moves to `handed`. Returns the open main obligation (the existing one when the
   *  event is already handed). 002q (T6-R): every hand-over tells the main 「處理完由你回報 Joey 一次」, so an event with no Joey obligation at all (a
   *  high-frequency routine, a task) gets one here, a line handed to the main: what the main reports meets it, and the event stays open until then. */
  function handOver(id: string, h: HandOver): Ob | null {
    const e = get(id)
    if (!e) return null
    const obs = obsOf(e)
    const open = obs.find(o => o.kind === 'main' && owing(o))
    if (open) return open
    const ob: Ob = { id: h.handoff, kind: 'main', level: 'handed', state: 'open', by: h.by, owner: 'main', handoff: h.handoff, at: new Date().toISOString(),
      ...(h.what != null ? { what: h.what } : {}), ...(h.due_at != null ? { due_at: h.due_at } : {}), ...(h.cls ? { cls: h.cls } : {}),
      ...(h.defer ? { defer: true } : {}), ...(h.card ? { card: true } : {}) }
    // 002y (X-3, 002w r1 B09): the peer's request handed over AFTER the lane's own reply met its answer left the main owing nothing and the peer never told
    // when the main would answer (the order of the two calls decided it). Handing the request over makes the answer owed again, as the main's: the
    // lane's reply becomes its own line (`message`, still met), and a new answer to that peer is owed below like any other.
    if (h.request) for (const o of [...obs]) if (o.kind === 'peer' && o.level === 'answer' && o.state === 'met' && (o.owner ?? 'lane') === 'lane' && o.by === 'reply_agent') {
      o.level = 'message'
      obs.push({ id: obId('peer'), kind: 'peer', level: 'answer', to: o.to, state: 'open', ...(o.req ? { req: o.req } : {}) })
    }
    for (const o of obs) if (owing(o) && (o.owner ?? 'lane') === 'lane' && o.kind !== 'main') {
      o.state = 'handed'; delete o.prev
      if (o.kind === 'peer' && o.level === 'answer' && h.answer_due != null && o.due_at == null) { o.due_at = h.answer_due; o.what ??= String(e.text ?? '').slice(0, 160) }   // 002w (B)
    }
    if (!obs.some(o => o.kind === 'joey')) obs.push({ id: obId('joey'), kind: 'joey', level: 'line', state: 'handed', by: h.by })
    obs.push(ob)
    write(e, obs, { tool: h.by, refused: null })
    return ob
  }
  /** WO-177 (Chiron 02:22Z, 六 last point): THE rule for an answer a lane owes a peer. The router opens one for every peer item that is not marked no_reply
   *  (the sender's flag is the router's to read: eventObligations); whether the item needs one (a result for the sender, a thing the lane cannot do,
   *  something it needs from the sender) only its reader can tell. The lane's receipt closes its account of the run (the card: the last call, after every
   *  send): an answer it has not sent by then, it judged not owed (waived, by receipt). Still owed: an answer it tried to send and could not deliver
   *  (`failed`: it had something for the sender), and every answer when its receipt says it could not do the thing (outcome failed: the sender is owed
   *  word of that). A send after the receipt is an answer like any other (request). A run that ends without its receipt (cut, a cap, failed) closed
   *  no account: what it owes goes to the main as before (the exit rule). Returns the record when something was waived. */
  function closeAccount(id: string, outcome: string): Row | null {
    if (outcome === 'failed') return null
    const e = get(id)
    if (!e) return null
    const obs = obsOf(e)
    const hit = obs.filter(o => o.kind === 'peer' && o.level === 'answer' && o.state === 'open' && !o.failed && (o.owner ?? 'lane') === 'lane')
    if (!hit.length) return null
    for (const o of hit) { o.state = 'waived'; o.by = 'receipt' }
    return write(e, obs, { tool: 'receipt' })
  }
  /** the event will not run: its thread was stopped (dropped) or another run handles it (merged into `into`). What it owed says so; nothing is met */
  function settleUnrun(id: string, how: 'dropped' | 'merged', by: string, into?: string): Row | null {
    const e = get(id)
    if (!e) return null
    const obs = obsOf(e)
    for (const o of obs) if (owing(o) && (o.owner ?? 'lane') === 'lane' && o.kind !== 'main') { o.state = how; o.by = by; if (into) o.into = into; delete o.prev }
    return write(e, obs, { tool: 'router', ...(into ? { merged_into: into } : {}) })
  }
  /** the router or the main meets an obligation (an interim answer, the M1 item of a hand-over done, a commitment marked done, a ring) */
  function set(id: string, obIdOrPred: string | ((o: Ob) => boolean), patch: Partial<Ob>, f: Record<string, unknown> = {}): Row | null {
    const e = get(id)
    if (!e) return null
    const obs = obsOf(e)
    const hit = obs.filter(o => typeof obIdOrPred === 'string' ? o.id === obIdOrPred : obIdOrPred(o))
    if (!hit.length) return null
    for (const o of hit) Object.assign(o, patch)
    return write(e, obs, f)
  }
  function add(id: string, o: Omit<Ob, 'id' | 'state'> & { id?: string; state?: Ob['state'] }, f: Record<string, unknown> = {}): Ob | null {
    const e = get(id)
    if (!e) return null
    const ob = { state: 'open', ...o, id: o.id ?? obId(o.kind) } as Ob
    write(e, [...obsOf(e), ob], f)
    return ob
  }
  /** a field on the record (what the lane did, for the digest), no obligation changes. byMain: the main made this change itself, so it has seen the
   *  record at this version (`main_seen`; the digest does not tell the main what it did) */
  function note(id: string, f: Record<string, unknown>, byMain = false): void { const e = get(id); if (e) write(e, obsOf(e), { ...f, ...(byMain ? { main_seen: e.version + 1 } : {}) }) }
  /** one more entry of a list field of the record (proposals, promised, main_sends) */
  function push(id: string, key: string, item: unknown, byMain = false): void { const e = get(id); if (e) write(e, obsOf(e), { [key]: [...((e[key] as unknown[]) ?? []), item], ...(byMain ? { main_seen: e.version + 1 } : {}) }) }
  /** obligations past their due time, not met, not acted on yet. A ring is Joey's, not the lane's: handing the event to the main does not take it away. */
  function due(now: number): Array<{ e: Row; o: Ob }> {
    const out: Array<{ e: Row; o: Ob }> = []
    for (const e of J.rows('event', r => r.state === 'open')) for (const o of (e.obligations ?? []) as Ob[]) {
      if (!(o.state === 'open' || (o.state === 'handed' && (o.ring || o.kind === 'peer'))) || o.due_at == null || now < o.due_at) continue   // 002w (B): a handed answer
      if (o.ring ? o.rang : o.told) continue
      out.push({ e, o })
    }
    return out
  }
  return { open, get, obsOf, openObs, mainObs, openText, request, result, handOver, closeAccount, settleUnrun, set, add, note, push, due, receiptMet,
    rows: (pred: (r: Row) => boolean = () => true) => J.rows('event', pred) }
}
