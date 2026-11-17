/**
 * lanes-events.ts — M3, the event record with obligations (docs/state-journal.md).
 *
 * The router opens one record per inbound event: { class, owner, obligations[], outcome }. An obligation is what the event still owes someone:
 *   joey     a line, or a decision (level line < decision); `ring` + due_at for a critical alert
 *   main     the event was handed to the main (level handed): an M1 item, met when that item is done
 *   peer     an answer to the peer that asked (level answer), or the main's promised answer (level answer, owner main, due_at)
 *   receipt  the completion of a scheduler run (run_id), once per run_id across every event
 * The one rule: every outbound tool call of a lane is a request to meet an obligation of its event. Meeting an open one is accepted; raising it
 * (a line to a decision) is accepted; repeating a met one is refused, and the refusal names what is still open. The router (lanes.ts) picks the tier
 * and format from class × obligation × outcome. One sweep acts on obligations past their due time.
 * One writer: the tg daemon. Every transition is a journal line (rec event).
 */
import type { Journal, Row } from './lanes-state.ts'

export type EvClass = 'scheduled' | 'followup' | 'peer' | 'joey' | 'alert' | 'critical'
export type ObKind = 'joey' | 'main' | 'peer' | 'receipt'
export type Outcome = 'normal' | 'changed' | 'failed'
export type Ob = { id: string; kind: ObKind; level: string; state: 'open' | 'met' | 'handed'; by?: string; owner?: string
  due_at?: number; ring?: boolean; rang?: boolean; told?: boolean; to?: string; run_id?: string; item?: string; handoff?: string; cls?: string; what?: string; req?: string; sent?: string }
export type Want = { kind: ObKind; level: string; to?: string; run_id?: string; handoff?: string }
export type Verdict = { ok: boolean; why?: string; ob?: Ob; raised?: boolean; event?: Row }

const RANK: Record<string, number> = { none: 0, line: 1, decision: 2 }
const SEV: Record<Outcome, number> = { normal: 0, changed: 1, failed: 2 }
const done = (o: Ob): boolean => o.state !== 'open'

export type EventsApi = ReturnType<typeof createEvents>
export function createEvents(J: Journal) {
  let k = 0
  const obId = (kind: string): string => `${kind}-${Date.now().toString(36)}-${(++k).toString(36)}`
  const get = (id: string): Row | undefined => J.get('event', id)
  const obsOf = (e: Row | undefined): Ob[] => (e?.obligations ?? []).map((o: Ob) => ({ ...o }))
  /** a receipt obligation is one per scheduler run, whichever event carries it */
  const receiptMet = (run: string): Row | undefined => J.rows('event', e => (e.obligations ?? []).some((o: Ob) => o.kind === 'receipt' && o.run_id === run && o.state === 'met'))[0]

  function write(e: Row | { id: string }, obs: Ob[], f: Record<string, unknown> = {}): Row {
    const closed = obs.length > 0 && obs.every(done) && !obs.some(o => o.kind === 'main' && o.state === 'open')
    return J.write('event', e.id, closed ? 'closed' : 'open', { obligations: obs, ...f })!
  }
  /** the router: one record per inbound event (an existing record is returned as it is: a retry is the same event) */
  function open(id: string, f: { class: EvClass; owner: string; obligations: Array<Omit<Ob, 'id' | 'state'> & { state?: Ob['state'] }>; thread?: string | null; lane?: string | null; from?: string; text?: string }): Row {
    const was = get(id)
    if (was) return was
    const obs: Ob[] = f.obligations.map(o => ({ state: 'open', ...o, id: obId(o.kind) }) as Ob)
    for (const o of obs) if (o.kind === 'receipt' && o.run_id && receiptMet(o.run_id)) { o.state = 'met'; o.by = `already completed by ${receiptMet(o.run_id)!.id}` }
    return write({ id }, obs, { class: f.class, owner: f.owner, outcome: 'normal', thread: f.thread ?? null, lane: f.lane ?? null, from: f.from ?? null, text: (f.text ?? '').slice(0, 300) })
  }
  /** what an event still owes from its lane (the stop hook's question, and the exit rule's) */
  function openObs(id: string): Ob[] { return obsOf(get(id)).filter(o => o.state === 'open' && o.kind !== 'main' && (o.owner ?? 'lane') === 'lane') }
  const openText = (id: string): string => {
    const os = openObs(id)
    return os.length ? `still open: ${os.map(o => o.kind === 'joey' ? `a ${o.level} for Joey (notify_joey; ask_joey if he must decide)` : o.kind === 'peer' ? `an answer to ${o.to} (reply_agent)` : `the receipt of scheduler run ${o.run_id} (receipt run_id=${o.run_id})`).join('; ')}.`
      : 'nothing else is open for this event: close with receipt (no run_id) or just end.'
  }

  /** THE rule: a lane's outbound call asks to meet an obligation of its event */
  function request(id: string, tool: string, want: Want, outcome?: Outcome, dry = false, f: Record<string, unknown> = {}): Verdict {
    const e = get(id)
    if (!e) return { ok: true }                                    // an event the router did not record (a main-tool task): nothing to check
    const obs = obsOf(e)
    const joey = obs.find(o => o.kind === 'joey'), main = obs.find(o => o.kind === 'main')
    let refused = '', ob: Ob | undefined, raised = false
    switch (want.kind) {
      case 'joey':
        ob = joey
        if (!ob) { ob = { id: obId('joey'), kind: 'joey', level: want.level, state: 'met', by: tool }; obs.push(ob); raised = true }
        else if (ob.state === 'handed') refused = 'this event is handed to the main: the main reports to Joey'
        else if (ob.state === 'met' && RANK[want.level] <= RANK[ob.level]) refused = ob.level === 'decision' ? 'Joey was already asked to decide this event (ask_joey); one ask per event' : 'Joey already has his line for this event; one message per event (put anything more in your receipt)'
        else { raised = ob.state === 'met'; ob.state = 'met'; ob.level = want.level; ob.by = tool }
        break
      case 'peer':
        ob = obs.find(o => o.kind === 'peer' && o.to === want.to && (o.owner ?? 'lane') === 'lane')
        if (!ob) return { ok: true }                                // another agent, not the one this event owes: a new conversation, no obligation
        if (ob.state !== 'open') refused = ob.level === 'interim' ? `the router already told ${want.to} that the main decides this and by when: send ${want.to} nothing more about it` : `${want.to} already has the answer to this event`
        else { ob.state = 'met'; ob.by = tool }
        break
      case 'receipt': {
        const prior = want.run_id ? receiptMet(want.run_id) : undefined
        ob = obs.find(o => o.kind === 'receipt' && o.run_id === want.run_id)
        if (prior) refused = `scheduler run ${want.run_id} was already completed (${prior.id === id ? 'by this event' : `by ${prior.id}`}); it is not completed again`
        else if (!ob) { ob = { id: obId('receipt'), kind: 'receipt', level: 'run', run_id: want.run_id, state: 'met', by: tool }; obs.push(ob) }
        else { ob.state = 'met'; ob.by = tool }
        break
      }
      case 'main':
        ob = main
        if (main) refused = 'this event is already handed to the main'
        else if (joey?.state === 'met' && joey.level === 'decision') refused = 'Joey was asked to decide this event (ask_joey): he owns it; do not also hand it to the main'
        else {
          ob = { id: want.handoff ?? obId('main'), kind: 'main', level: 'handed', state: 'open', by: tool, owner: 'main', ...(want.handoff ? { handoff: want.handoff } : {}) }; obs.push(ob)
          for (const o of obs) if (o.state === 'open' && (o.owner ?? 'lane') === 'lane' && (o.kind === 'joey' || o.kind === 'peer')) o.state = 'handed'
        }
        break
    }
    if (dry) return refused ? { ok: false, why: `refused: ${refused}. ${openText(id)}`, ob } : { ok: true, ob }   // what it would say: nothing is written
    const out: Outcome = outcome && SEV[outcome] > SEV[(e.outcome as Outcome) ?? 'normal'] ? outcome : (e.outcome ?? 'normal')
    const row = write(e, obs, { tool, refused: refused || null, outcome: out, ...(refused ? {} : f) })
    if (refused) return { ok: false, why: `refused: ${refused}. ${openText(id)}`, ob, event: row }
    return { ok: true, ob, raised, event: row }
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
  /** a field on the record (what the lane did, for the digest), no obligation changes */
  function note(id: string, f: Record<string, unknown>): void { const e = get(id); if (e) write(e, obsOf(e), f) }
  /** obligations past their due time, not met, not acted on yet. A ring is Joey's, not the lane's: handing the event to the main does not take it away. */
  function due(now: number): Array<{ e: Row; o: Ob }> {
    const out: Array<{ e: Row; o: Ob }> = []
    for (const e of J.rows('event', r => r.state === 'open')) for (const o of (e.obligations ?? []) as Ob[]) {
      if (o.state === 'met' || (o.state === 'handed' && !o.ring) || o.due_at == null || now < o.due_at) continue
      if (o.ring ? o.rang : o.told) continue
      out.push({ e, o })
    }
    return out
  }
  return { open, get, obsOf, openObs, openText, request, set, add, note, due, receiptMet,
    rows: (pred: (r: Row) => boolean = () => true) => J.rows('event', pred) }
}
