// Onsen step 4a (WO-147, Relay step 4; Chiron's ticket; Joey TG chiron:2353): every wake decision of this daemon becomes one row in Onsen
// (POST /wake/batch, fleet-core onsen4.py). A wake decision is one route record: routeRow in lanes.ts, the one writer of .lanes/routing.jsonl (routeEvent,
// its routeWake kinds, the main's own lane tools, the digest, …). One routing.jsonl line = one Onsen row: nothing is added, nothing left out.
//
// Behaviour unchanged: this module only maps a route record (plus what the daemon knew at that moment) to an Onsen row. It decides nothing, reads no
// field differently, and no agent sees anything of it. server.ts wires it (ONSEN_WAKE_LOG) and the rows go through the Onsen spool (onsen-client.ts,
// k 'w'): written locally first, synced in order, a resent line keeps its idem_key (the server answers duplicate).
//
// 1.49.1 (Chiron on WO-147, 09:56Z): the hand-over decisions too (#28 handoff_main, #29 a decision card, #30 the deferred cards' batch, #31 a lane run's end).
// They write no routing.jsonl line; each writes ONE event-keyed wake / no_wake line in the state journal (lanes/state.jsonl: rec "wake", id = the event).
// One Onsen row per such line (handItem): at = the line's ts, refs.event_id = its id, so each row joins its line exactly. The M1 item-keyed wake lines
// (id = an M1 item, m-…: an item's offer, its pull, its no_wake at enqueue, an unreachable stream) are the delivery of a decision already recorded (its
// routing.jsonl row or its event-keyed line) and are never sent. So: Onsen rows = routing.jsonl lines + state.jsonl event-keyed wake lines.
//
// The row (the contract of onsen4.py):
//   source_kind  what kind of thing reached the daemon (sourceKindOf)
//   urgency      interrupt | ordered | silent | state (keep-warm, stall, restart, resume: a state crossed): a decided row's is the decision's (WO-177 三:
//                the route row's wake_urgency); a row no decision made: how today's rules make it (urgencyOf)
//   target       whom it was given to (targetOf): main_now | main_after_step | lane:<kind> | ledger | held:<wall|starting|offline> | none
//   rule, note   the routing.jsonl rule id (a routeWake kind is its rule: wake-keepwarm, wake-mail, …) and note
//   member_state the agent's status at that moment (statusOf's view as the daemon last computed it; walled when the view carries a wall)
//   refs         btcc_msg_id run_id ticket tg event_id did thread form_id mail_id (what there is)
//   preview      the first 120 characters (code points) of the text
//   decided_by   WO-157: new (decideWake decided: LANES_WAKE_DECIDE; rule wake:<its rule>[/<the rule the doing code returned>], target its verdict when the
//                doing code did that) | old (the router's rules, the fixed paths). Onsen 0.9.4 ignores a field it does not know: until fleet-core stores it,
//                the rule's `wake:` prefix is what tells the two apart in Onsen
import type { InEvent, RouteTapCtx, WakeTapCtx } from './lanes.ts'

export const SOURCE_KINDS = ['joey_tg', 'joey_edit', 'joey_form', 'peer_call', 'peer_mail', 'mail_ring', 'mail_event', 'scheduled', 'alert', 'board',
  'wd_keepwarm', 'wd_mail', 'wd_stall', 'wd_restart', 'wd_resume', 'external', 'handoff', 'card', 'batch', 'lane_exit', 'other'] as const
export type SourceKind = typeof SOURCE_KINDS[number]
export type Urgency = 'interrupt' | 'ordered' | 'silent' | 'state'
export type WakeRefs = Partial<Record<'btcc_msg_id' | 'run_id' | 'ticket' | 'tg' | 'event_id' | 'did' | 'thread' | 'form_id' | 'mail_id', string>>
export type WakeItem = {
  idem_key: string; agent: string; host: string; at: string; source_kind: SourceKind; urgency?: Urgency; target: string
  rule?: string; note?: string; member_state?: string; sender?: string; refs: WakeRefs; preview?: string
  /** WO-157: which path decided */
  decided_by: 'new' | 'old'
}
export const PREVIEW_MAX = 120

/** ONSEN_WAKE_LOG: a comma list of agent names or `*` (the daemon's env, then the machine config); unset or empty = off. The caller also requires Onsen
 *  recording on for the agent and the lanes on (no lanes, no routing.jsonl, nothing to record). */
export function wakeLogOn(env: NodeJS.ProcessEnv, agent: string): boolean {
  const list = String(env.ONSEN_WAKE_LOG ?? '').split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}
/** the row's idem_key: unique per decision (the daemon's boot id and a counter); a spool line resent keeps it */
export const idemWake = (agent: string, boot: string, seq: number, atMs: number): string => `wake:${agent}:${atMs}:${boot}:${seq}`.slice(0, 300)

/** a string Postgres takes (no lone surrogate: the server could not store it and would answer 500 for the whole batch, holding the spool) */
function clean(s: unknown): string {
  const t = String(s ?? '')
  return typeof (t as any).toWellFormed === 'function' ? (t as any).toWellFormed() : t.replace(/[\uD800-\uDFFF]/g, '�')
}
/** the first `n` code points (never half a surrogate pair) */
export function cutPoints(s: unknown, n: number): string { return clean(Array.from(clean(s)).slice(0, n).join('')) }

const lc = (s: unknown): string => String(s ?? '').trim().toLowerCase()
const SCHEDULED_RUN = /^\[scheduled\]\[[^\]]*\]\[run:(\d+)\]/
const BOARD_TICKET = /^\[board\]\[(WO-\d+)\]/i

/** the kind of source of a route record. The event decides (its wake kind, its source, its sender, its line); a row with no event, or one the main or a
 *  lane made itself (its own tools, a follow-up, the digest, a refused registration), is `other`; a /lanes command (source joey) is Joey's. */
export function sourceKindOf(row: Record<string, unknown>, ev: InEvent | null, o: { alertSenders: string[]; roster: () => string[] }): SourceKind {
  const rs = String(row.source ?? ev?.source ?? '')
  if (rs === 'joey') return 'joey_tg'
  if (!ev || rs === 'followup' || rs === 'main' || rs === 'ledger') return 'other'
  const meta = ev.meta ?? {}
  const from = lc(ev.from ?? row.from)
  const wake = ev.wake ?? (typeof row.wake === 'string' ? row.wake : undefined)
  if (wake === 'keepwarm') return 'wd_keepwarm'
  if (wake === 'stall') return 'wd_stall'
  if (wake === 'restart') return 'wd_restart'
  if (wake === 'resume') return 'wd_resume'
  if (wake === 'mail') return meta.ring === 'true' || from === 'mailbox' ? 'mail_ring' : 'wd_mail'
  if (ev.source === 'telegram') {
    if (meta.via === 'web-form' || row.rule === 'web-form') return 'joey_form'
    if (meta.edited_at || /-edit-/.test(String(ev.id ?? ''))) return 'joey_edit'
    return 'joey_tg'
  }
  if (ev.source === 'mail') return 'mail_event'
  if (ev.source !== 'mesh') return 'other'
  if (from === 'main' || ev.fanout) return 'other'                       // the main's own tools (fork, open_worker, fan_out, curate_memory)
  // WO-157b: the sender's kind field (an Onsen item's kind, lanes.ts item_kind) names it when it says more than Onsen's default peer_call (the bench run
  // 14:59Z: a scheduled and an alert item sent by sonn were routed wake:scheduled / wake:alert but recorded source_kind peer_call)
  const sent = (ev as { item_kind?: unknown }).item_kind
  if (typeof sent === 'string' && sent !== 'peer_call' && (SOURCE_KINDS as readonly string[]).includes(sent)) return sent as SourceKind
  if (from === 'scheduler') return 'scheduled'
  if (o.alertSenders.map(lc).includes(from)) return 'alert'
  if (from === 'board' || BOARD_TICKET.test(String(ev.text ?? '').trimStart())) return 'board'
  if (from === 'fleet-watchdog') return 'wd_stall'                        // (wakeKind gives every line of this sender a wake kind; kept for a row without one)
  const line = ev.line ?? 'call'
  if (from === 'mailbox') return line === 'mail' ? 'peer_mail' : 'other'
  if (from === 'joey (btcc)') return 'other'                              // Joey's Comms console in BTCC: not Telegram
  if (o.roster().map(lc).includes(from)) return line === 'mail' ? 'peer_mail' : line === 'feed' ? 'other' : 'peer_call'
  return 'external'                                                       // a sender not in the roster (iris-slack, reply-watch, …)
}

const URGENCIES: ReadonlySet<string> = new Set(['interrupt', 'ordered', 'silent', 'state'])
const isUrgency = (u: unknown): u is Urgency => typeof u === 'string' && URGENCIES.has(u)
/** WO-177 三: only for a row no decideWake made (decided_by old: the old router, the fixed paths); a decided row carries the decision's urgency (wakeItem).
 *  How urgent today's rules make it (nothing here is read by any rule): a wake-up line for a state crossed (keep-warm, stall, restart, resume) is `state`;
 *  the mailbox reminder and the ring, a mail, a scheduled run, the mailbox's events are `ordered`; Joey is `interrupt`; a mesh push follows its line
 *  (feed silent, mail ordered, a push with none a call: interrupt), and a no_reply notice that is not an alert sender's is `silent` (today's mesh-no-reply
 *  files it in the ledger). The main's own tools and a follow-up are `ordered`; the digest is `silent`; a /lanes command and a refused registration have none. */
export function urgencyOf(kind: SourceKind, row: Record<string, unknown>, ev: InEvent | null, alertSenders: string[]): Urgency | undefined {
  if (kind === 'wd_keepwarm' || kind === 'wd_stall' || kind === 'wd_restart' || kind === 'wd_resume') return 'state'
  if (kind === 'wd_mail' || kind === 'mail_ring' || kind === 'mail_event' || kind === 'scheduled' || kind === 'peer_mail') return 'ordered'
  const rs = String(row.source ?? ev?.source ?? '')
  if (rs === 'joey' || row.rule === 'registration') return undefined
  if (kind === 'joey_tg' || kind === 'joey_edit' || kind === 'joey_form') return 'interrupt'
  if (row.rule === 'digest' || rs === 'ledger') return 'silent'
  if (rs === 'main' || rs === 'followup' || !ev) return 'ordered'
  if (ev.source !== 'mesh') return 'ordered'
  if (lc(ev.from) === 'main' || ev.fanout) return 'ordered'
  const line = ev.line ?? 'call'
  if (line === 'feed') return 'silent'
  if (line === 'mail') return 'ordered'
  if (ev.no_reply && !alertSenders.map(lc).includes(lc(ev.from))) return 'silent'
  return 'interrupt'
}

/** whom it was given to. The main: by its M2 record at that moment (what M1 does with the item): idle with nothing offered → main_now (offered now);
 *  in a turn, or idle with an offer already out → main_after_step (pulled at its next tool boundary or Stop); walled → held:wall (its probe or the clear);
 *  a gen not yet taking input → held:starting; no gen → held:offline. A lane: lane:<its kind>. The ledger: ledger. Anything else (none, refused): none. */
export function targetOf(row: Record<string, unknown>, ctx: Pick<RouteTapCtx, 'main' | 'laneKind'>): string {
  const t = String(row.target ?? '')
  if (t === 'lane') return `lane:${ctx.laneKind ?? 'unknown'}`
  if (t === 'ledger') return 'ledger'
  if (t !== 'main') return 'none'
  const m = ctx.main
  if (!m) return 'held:offline'
  if (m.state === 'idle') return m.offered ? 'main_after_step' : 'main_now'
  if (m.state === 'in_turn') return 'main_after_step'
  if (m.state === 'walled') return m.personProbe ? (m.offered ? 'main_after_step' : 'main_now') : 'held:wall'
  if (m.state === 'starting') return 'held:starting'
  return 'held:offline'
}

/** the agent's state at that moment: statusOf's view as the daemon last computed it (step 3), walled when the view carries a wall; before the first view,
 *  the main's M2 record (idle, busy, walled, offline) */
export function memberStateOf(view: { state: string; detail?: Record<string, unknown> } | null | undefined, m: RouteTapCtx['main']): string {
  // WO-157: statusOf's five states, and its detail's walled / compacting as states of their own (not when offline): the seven decideWake reads
  if (view?.state) return view.state !== 'offline' && view.detail?.walled ? 'walled' : view.state !== 'offline' && view.detail?.compacting ? 'compacting' : view.state
  if (!m) return 'offline'
  return m.state === 'idle' ? 'idle' : m.state === 'in_turn' ? 'busy' : m.state === 'walled' ? 'walled' : 'offline'
}

/** the ids that trace the row back: what the row and its event carry */
export function refsOf(row: Record<string, unknown>, ev: InEvent | null, did: string | null): WakeRefs {
  const meta = ev?.meta ?? {}
  const text = String(ev?.text ?? row.text ?? '').trimStart()
  const tgChat = ev?.source === 'telegram' ? meta.chat_id : undefined, tgMsg = ev?.source === 'telegram' ? meta.message_id : undefined
  const r: Record<string, unknown> = {
    btcc_msg_id: row.btcc_msg_id ?? ev?.btcc_msg_id,
    run_id: meta.run_id ?? text.match(SCHEDULED_RUN)?.[1],
    ticket: text.match(BOARD_TICKET)?.[1]?.toUpperCase(),
    tg: tgChat && tgMsg ? `${tgChat}:${tgMsg}` : undefined,
    event_id: row.event,
    did,
    thread: row.thread ?? row.peer_thread ?? ev?.thread,
    form_id: meta.form_id,
    mail_id: ev?.mail_id ?? row.mail_id,
  }
  const out: WakeRefs = {}
  for (const [k, v] of Object.entries(r)) if (v != null && v !== '') (out as any)[k] = cutPoints(v, 120)
  return out
}

/** WO-157: on the new path the row's target is decideWake's verdict when the doing code did what it said (the same kind of place: the main, a lane, the
 *  ledger); a gate or merge inside the doing code that went elsewhere (a repeat alert to the ledger, a board with no worker topic to the main) leaves the
 *  target the doing code's */
function verdictTarget(row: Record<string, unknown>, ctx: Pick<RouteTapCtx, 'main' | 'laneKind'>): string {
  const did = targetOf(row, ctx), v = typeof row.wake_target === 'string' ? row.wake_target : ''
  if (row.decided_by !== 'new' || !v) return did
  const cls = (t: string) => t.startsWith('main_') ? 'main' : t.startsWith('lane:') ? 'lane' : t
  if (v.startsWith('held:')) return did === 'ledger' || did === 'none' ? did : v
  if (cls(v) === 'main' && cls(did) === 'main') return v
  if (cls(v) === 'lane' && cls(did) === 'lane') return did                  // the lane the doing code picked (its kind)
  return did
}
/** one route record → one Onsen row */
export function wakeItem(row: Record<string, unknown>, ctx: Pick<RouteTapCtx, 'ev' | 'main' | 'laneKind' | 'alertSenders' | 'roster'> & { did?: string | null },
  o: { agent: string; host: string; at: string; idem: string; memberState: string | null }): WakeItem {
  const ev = ctx.ev
  const kind = sourceKindOf(row, ev, ctx)
  // WO-177 三 (Chiron's ticket; wo169-acceptance 「跟預期不同」 4: a no_reply call recorded silent while the decision used interrupt): a row decideWake made
  // carries the urgency the decision used (lanes.ts verdictRow); urgencyOf describes only the rows no decision made (the old router, the fixed paths)
  const urgency = row.decided_by === 'new' && isUrgency(row.wake_urgency) ? row.wake_urgency : urgencyOf(kind, row, ev, ctx.alertSenders)
  const text = typeof row.text === 'string' ? row.text : typeof ev?.text === 'string' ? ev.text : ''
  const sender = row.from ?? ev?.from
  return {
    idem_key: o.idem, agent: o.agent, host: o.host, at: o.at, source_kind: kind, ...(urgency ? { urgency } : {}), target: verdictTarget(row, ctx),
    ...(row.rule != null ? { rule: cutPoints(row.rule, 80) } : {}), ...(row.note != null && row.note !== '' ? { note: cutPoints(row.note, 300) } : {}),
    ...(o.memberState ? { member_state: o.memberState } : {}), ...(sender != null && sender !== '' ? { sender: cutPoints(sender, 120) } : {}),
    refs: refsOf(row, ev, ctx.did ?? null), ...(text ? { preview: cutPoints(text, PREVIEW_MAX) } : {}),
    decided_by: row.decided_by === 'new' ? 'new' : 'old',
  }
}

/** the rule ids of the hand-over rows (lanes.ts asWake callers), by kind:
 *  handoff   handoff_main (the lane tool) · handoff-woke-deferred (handoff_main on a matter waiting in the main's mailbox: wakes it now) · handoff-addToMain
 *            (handoff_main after a card of the same run already woke the main: one more item) · handoff-synthesis (deliver_synthesis)
 *  card      card-now (urgent_because / a critical run / no defer mode: woken now) · card-deferred (can wait: no item) · card-due (its due wake)
 *  batch     defer-batch (the deferred cards' batch wake)
 *  lane_exit exit-owes (the run ended owing: handed to the main) · exit-failed (the same after its last attempt) · exit-none (owed nothing: recorded only)
 *            · exit-synthesis (a synthesis ended without its conclusion) · exit-curator (a curator ended without curator_done) · exit-closed (a lane
 *            closed before Joey's message reached it)
 *  other     handoff-router-failed (the router threw on an event it had recorded) · handoff-thread-stop (a thread stopped at its hop / token limit) ·
 *            wake-row (an event-keyed wake line no caller named: none today) */
export const HAND_RULES = ['handoff_main', 'handoff-woke-deferred', 'handoff-addToMain', 'handoff-synthesis', 'card-now', 'card-deferred', 'card-due', 'defer-batch',
  'exit-owes', 'exit-failed', 'exit-none', 'exit-synthesis', 'exit-curator', 'exit-closed', 'handoff-router-failed', 'handoff-thread-stop', 'wake-row']
/** the hand-over's target: `wake` (the main idle at that moment: M1 offers its item) and a `no_wake` with an item (the main busy, walled, starting, gone)
 *  go by the main's M2 record like a route to the main; a `no_wake` with no item (a card that can wait, a run that owed nothing) is `none` */
export function handTarget(state: string, ctx: Pick<WakeTapCtx, 'main' | 'did'>): string {
  if (state === 'no_wake' && !ctx.did) return 'none'
  return targetOf({ target: 'main' }, { main: ctx.main, laneKind: null })
}
/** one event-keyed wake line of the state journal (a hand-over decision) → one Onsen row */
export function handItem(line: Record<string, unknown>, ctx: WakeTapCtx, o: { agent: string; host: string; idem: string; memberState: string | null }): WakeItem {
  const id = String(line.id ?? ''), rec = ctx.rec
  const sender = ctx.lane ?? (ctx.kind === 'batch' ? 'lanes' : 'router')
  const why = typeof line.reason === 'string' ? line.reason : ''
  const r: Record<string, unknown> = { event_id: id, did: ctx.did, thread: rec?.thread, tg: rec?.tg, run_id: rec?.run_id, mail_id: ctx.mail_id ?? rec?.mail_id }
  const refs: WakeRefs = {}
  for (const [k, v] of Object.entries(r)) if (v != null && v !== '') (refs as any)[k] = cutPoints(v, 120)
  const text = rec?.text ?? ''
  return {
    idem_key: o.idem, agent: o.agent, host: o.host, at: String(line.ts ?? new Date().toISOString()), source_kind: ctx.kind as SourceKind, ...(ctx.urgency ? { urgency: ctx.urgency } : {}),
    target: ((t: string) => ctx.decided_by === 'new' && ctx.wake_target && t !== 'none' && (ctx.wake_target.startsWith('held:') || ctx.wake_target.startsWith('main_')) ? ctx.wake_target : t)(handTarget(String(line.state ?? ''), ctx)), rule: cutPoints(ctx.decided_by === 'new' && ctx.wake_rule ? `wake:${ctx.wake_rule}/${ctx.rule}` : ctx.rule, 80),
    ...(why ? { note: cutPoints(why, 300) } : {}),                     // the line's reason, as written (with at and event_id it joins the line)
    ...(o.memberState ? { member_state: o.memberState } : {}), sender: cutPoints(sender, 120), refs, ...(text ? { preview: cutPoints(text, PREVIEW_MAX) } : {}),
    decided_by: ctx.decided_by === 'new' ? 'new' : 'old',
  }
}
