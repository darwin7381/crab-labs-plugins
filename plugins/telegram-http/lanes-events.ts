/**
 * lanes-events.ts — M3, the event record with obligations (docs/state-journal.md).
 *
 * The router opens one record per inbound event: { class, owner, obligations[], outcome }. An obligation is what the event still owes someone:
 *   joey     a line, or a decision (level line < decision); `ring` + due_at for a critical alert
 *   main     the event was handed to the main (level handed): an M1 item, met when that item is done
 *   peer     an answer to the peer that asked (level answer), the main's promised answer (level answer, owner main, due_at), or a message to an agent
 *            the event did not owe (level message)
 *   receipt  the completion of a scheduler run (run_id), once per run_id across every event
 * An obligation is open → requested (the outbound call was accepted and is being delivered) → met on the delivery result (the Telegram message
 * id, the mesh `delivered`, the scheduler's answer), or back to open with `failed` when the delivery failed. handed: one hand-over transition
 * (handOver) gave it to the main. dropped: the event's thread was stopped before it ran. merged: it was handled in another event's run.
 * The one rule: every outbound tool call of a lane is a request to meet an obligation of its event. Meeting an open one is accepted; raising it
 * (a line to a decision, or a line whose outcome changed) is accepted; repeating a met or requested one is refused, and the refusal names what is
 * still open. The router (lanes.ts) picks the tier and format from class × obligation × outcome. One sweep acts on obligations past their due time.
 * closed = nothing is open or requested. One writer: the tg daemon. Every transition is a journal line (rec event).
 */
import type { Journal, Row } from './lanes-state.ts'

export type EvClass = 'scheduled' | 'followup' | 'peer' | 'joey' | 'alert' | 'critical'
export type ObKind = 'joey' | 'main' | 'peer' | 'receipt'
export type Outcome = 'normal' | 'changed' | 'failed'
export type ObState = 'open' | 'requested' | 'met' | 'handed' | 'dropped' | 'merged'
export type Ob = { id: string; kind: ObKind; level: string; state: ObState; by?: string; owner?: string
  due_at?: number; ring?: boolean; rang?: boolean; told?: boolean; to?: string; run_id?: string; item?: string; handoff?: string; cls?: string; what?: string; req?: string; sent?: string
  /** the delivery that met it (message id, btcc id, the scheduler's answer); why the last delivery failed; the outcome a joey line was met with; the event a merged one went into */
  ref?: string; failed?: string; outcome?: Outcome; into?: string
  /** while requested: what it was before the request (a failed delivery puts it back) */
  prev?: { state: ObState; level: string; outcome?: Outcome; by?: string } }
export type Want = { kind: ObKind; level: string; to?: string; run_id?: string; handoff?: string; outcome?: Outcome }
export type Verdict = { ok: boolean; why?: string; ob?: Ob; raised?: boolean; event?: Row }
export type HandOver = { handoff: string; by: string; what?: string; due_at?: number; cls?: string }

const RANK: Record<string, number> = { none: 0, line: 1, decision: 2 }
const SEV: Record<Outcome, number> = { normal: 0, changed: 1, failed: 2 }
/** still owed: nothing has met it yet (a request in flight is not a delivery) */
export const owing = (o: Ob): boolean => o.state === 'open' || o.state === 'requested'

export type EventsApi = ReturnType<typeof createEvents>
export function createEvents(J: Journal) {
  let k = 0
  const obId = (kind: string): string => `${kind}-${Date.now().toString(36)}-${(++k).toString(36)}`
  const get = (id: string): Row | undefined => J.get('event', id)
  const obsOf = (e: Row | undefined): Ob[] => (e?.obligations ?? []).map((o: Ob) => ({ ...o }))
  /** a receipt obligation is one per scheduler run, whichever event carries it (met, or being delivered) */
  const receiptMet = (run: string): Row | undefined => J.rows('event', e => (e.obligations ?? []).some((o: Ob) => o.kind === 'receipt' && o.run_id === run && (o.state === 'met' || o.state === 'requested')))[0]

  /** closed = no obligation is open or requested (an event that owes nothing, information, is closed at once) */
  function write(e: Row | { id: string }, obs: Ob[], f: Record<string, unknown> = {}): Row {
    return J.write('event', e.id, obs.some(owing) ? 'open' : 'closed', { obligations: obs, ...f })!
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
        if (!ob) { ob = { id: obId('joey'), kind: 'joey', level: want.level, state: 'open' }; obs.push(ob); raised = true; ask(ob, want.level) }
        else if (ob.state === 'handed') refused = 'this event is handed to the main: the main reports to Joey'
        else if (ob.state === 'requested') refused = 'a line about this event is being sent to Joey right now'
        else if (ob.state === 'met' && (RANK[want.level] < RANK[ob.level] || (RANK[want.level] === RANK[ob.level] && (ob.level === 'decision' || out === (ob.outcome ?? 'normal')))))
          refused = ob.level === 'decision' ? 'Joey was already asked to decide this event (ask_joey); one ask per event'
            : `Joey already has his line for this event (outcome ${ob.outcome ?? 'normal'}); one message per event: another line only when the outcome changed (put anything more in your receipt)`
        else if (ob.state === 'dropped' || ob.state === 'merged') refused = `this event's line was ${ob.state}${ob.into ? ` into ${ob.into}` : ''}`
        else { raised = ob.state === 'met'; ask(ob, want.level); ob.outcome = out }
        break
      }
      case 'peer':
        ob = obs.find(o => o.kind === 'peer' && o.to === want.to && (o.owner ?? 'lane') === 'lane')
        if (!ob) { ob = { id: obId('peer'), kind: 'peer', level: 'message', to: want.to, state: 'open' }; obs.push(ob); ask(ob, 'message') }   // an agent the event did not owe: its own obligation
        else if (ob.state === 'open') ask(ob, ob.level)
        else refused = ob.level === 'interim' ? `the router already told ${want.to} that the main decides this and by when: send ${want.to} nothing more about it`
          : ob.state === 'requested' ? `a message to ${want.to} about this event is being delivered right now`
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
    if (ok) { o.state = 'met'; o.ref = d.ref != null ? String(d.ref) : undefined; delete o.prev; delete o.failed }
    else { const p = o.prev ?? { state: 'open' as ObState, level: o.level }; o.state = p.state; o.level = p.level; o.outcome = p.outcome; o.by = p.by; o.failed = d.why ?? 'not delivered'; delete o.prev }
    return write(e, obs, { tool: ok ? 'delivered' : 'not-delivered', ...f })
  }
  /** THE hand-over (handoff_main, the exit rule, the thread stop alike): one `main` obligation (open, owned by the main) and every lane obligation
   *  still owed (a line for Joey, an answer to a peer, a receipt) moves to `handed`. Returns the open main obligation (the existing one when the
   *  event is already handed). */
  function handOver(id: string, h: HandOver): Ob | null {
    const e = get(id)
    if (!e) return null
    const obs = obsOf(e)
    const open = obs.find(o => o.kind === 'main' && owing(o))
    if (open) return open
    const ob: Ob = { id: h.handoff, kind: 'main', level: 'handed', state: 'open', by: h.by, owner: 'main', handoff: h.handoff,
      ...(h.what != null ? { what: h.what } : {}), ...(h.due_at != null ? { due_at: h.due_at } : {}), ...(h.cls ? { cls: h.cls } : {}) }
    for (const o of obs) if (owing(o) && (o.owner ?? 'lane') === 'lane' && o.kind !== 'main') { o.state = 'handed'; delete o.prev }
    obs.push(ob)
    write(e, obs, { tool: h.by, refused: null })
    return ob
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
      if (!(o.state === 'open' || (o.state === 'handed' && o.ring)) || o.due_at == null || now < o.due_at) continue
      if (o.ring ? o.rang : o.told) continue
      out.push({ e, o })
    }
    return out
  }
  return { open, get, obsOf, openObs, openText, request, result, handOver, settleUnrun, set, add, note, push, due, receiptMet,
    rows: (pred: (r: Row) => boolean = () => true) => J.rows('event', pred) }
}
