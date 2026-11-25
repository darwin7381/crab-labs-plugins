// WO-157 phase 1 (Onsen step 4b; Chiron's ticket; Joey TG chiron:2160–2185, 2353, 2405; design rescue-site/onsen-step4.html): the ONE receiver-side wake
// decision. Today "wake whom / whether" is decided in four places (the BTCC senders, the watchdog, routeEvent + routeWake, the lanes handing to the main;
// claude-chiron/knowledge/tg-dialogue/step4-facts.md lists 40 decision points). This module is the one function that replaces their judgement:
//
//   decideWake(item, state, rules) → { target, urgency, rule, then?, tell? }
//
// item   what the sender wrote (phase 2: every item is in Onsen with these fields): kind, urgency, no_reply, deadline, sender, refs. The kind is the
//        sender's field (no text prefix decides anything); urgency is the sender's (interrupt / ordered / silent; `state` for a state crossing), and
//        when it filled none the rule table's default for that kind. no_reply is carried and recorded but decides nothing (design page: 「欠不欠回覆」is
//        another matter, no longer read as 「叫不叫醒」).
// state  this agent's one state: `member` (Onsen's status of the main, the one pinned in the chat: idle busy waiting stuck menu compacting walled starting
//        offline gone), `main_offered` (an item already offered to an idle main: one offer opens one turn), `lane_free` (a lane slot is free), and what the
//        router's own tables say about this item: `owner` (the line its conversation belongs to: 'main' or a lane kind), `gate` (an admission gate already
//        said no: hold, flood, repeat, merge, stopped thread), `worker_topics` (a worker lane can be opened), `lanes_off`.
// target main_now | main_after_step | lane:<reflex|mail|worker|fork|curator|synthesis> | ledger (record only) | held:<wall|offline|starting|waiting|stuck>
//        (`then`: where it goes when released). `tell`: who is told it is held (joey | waiter).
//
// Pure: no I/O, no clock, no model. The table is data (lanes-wake-rules.json); an agent adds its own rules in <workspace>/.lanes/router.json `wake_rules`
// (same shape), and its older router.json rules are translated (legacyAgentRules) so today's per-agent choices carry over without editing any file.
// Phase 1: nothing calls it from the router yet (the replay, tools/wake-replay.ts, and the tests do).
import { readFileSync } from 'fs'
import { join } from 'path'

export const WAKE_KINDS = ['joey_tg', 'joey_edit', 'joey_form', 'peer_call', 'peer_mail', 'mail_ring', 'mail_event', 'scheduled', 'alert', 'board',
  'wd_keepwarm', 'wd_mail', 'wd_stall', 'wd_restart', 'wd_resume', 'external', 'handoff', 'card', 'batch', 'lane_exit', 'own', 'other'] as const
export type WakeKind = typeof WAKE_KINDS[number]
export type Urgency = 'interrupt' | 'ordered' | 'silent' | 'state'
export const MEMBER_STATES = ['idle', 'busy', 'waiting', 'stuck', 'menu', 'compacting', 'walled', 'starting', 'offline', 'gone'] as const
export type MemberState = typeof MEMBER_STATES[number]

export type WakeItem = {
  kind: WakeKind | string
  /** the sender's urgency; absent → the table's default for the kind */
  urgency?: Urgency
  /** 「不用回我」: carried, never decides the target */
  no_reply?: boolean
  deadline?: string
  sender?: string
  /** who waits on it (joey, an agent, outside, nobody): carried for the `tell` and the record */
  waiting?: string
  /** a sub-kind the sender knows (mail_event: decision | due) */
  sub?: string
  refs?: Partial<Record<'btcc_msg_id' | 'run_id' | 'ticket' | 'tg' | 'event_id' | 'thread' | 'reply_to' | 'mail_id' | 'lane', string>>
}
export type WakeState = {
  member: MemberState | string
  main_offered?: boolean
  lane_free?: boolean
  /** the line the item's conversation belongs to (router tables: its thread, a reply to our message, the quoted lane message, the worker topic, the
   *  ticket's worker, the incident's lane, the lane that asked for a decision): 'main', a lane kind, or null */
  owner?: string | null
  /** an admission gate that already said no: peer_hold | peer_flood | alert_repeat | mail_run_waiting | thread_stopped | repeat */
  gate?: string | null
  worker_topics?: boolean
  lanes_off?: boolean
}
export type MapCell = string | { target: string; tell?: string }
export type WakeRule = {
  id: string
  when: {
    kind?: string[]; urgency?: string[]; sender?: string[]; no_reply?: boolean; sub?: string[]; member?: string[]
    /** 'any' (set), 'none' (unset), 'lane' (a lane kind), 'main', or a list of lane kinds */
    owner?: string | string[]
    gate?: 'any' | string[]
    worker_topics?: boolean; lanes_off?: boolean; lane_free?: boolean
  }
  /** main | owner | ledger | lane:<kind> */
  to: string
  /** the state map that resolves `to` (main | joey | state | lane); absent: main for main/owner, lane for lane:* */
  map?: string
  replaces?: string[]
  doc?: string
  /** where the rule came from: fleet | agent (router.json wake_rules) | legacy:<router.json rule id> */
  origin?: string
}
export type WakeTable = { version: number; urgency_default: Record<string, string>; maps: Record<string, Record<string, MapCell>>; rules: WakeRule[] }
export type WakeVerdict = {
  target: string
  urgency: Urgency
  /** the rule that decided (agent rules first, then the fleet table) */
  rule: string
  origin: string
  /** a held item: where it goes when released */
  then?: string
  /** who is told it is held */
  tell?: string
  /** the lane destination has no free slot right now: it waits in that lane's queue (no new queue) */
  wait?: 'lane_slot'
}

const lc = (s: unknown): string => String(s ?? '').trim().toLowerCase()
const LANE_KINDS = new Set(['reflex', 'mail', 'worker', 'fork', 'curator', 'synthesis'])

/** the fleet table (lanes-wake-rules.json next to this file) */
export function loadWakeTable(path = join(import.meta.dir, 'lanes-wake-rules.json')): WakeTable {
  const t = JSON.parse(readFileSync(path, 'utf8')) as WakeTable
  for (const r of t.rules) r.origin ??= 'fleet'
  return t
}

function ownerMatches(want: string | string[], owner: string | null | undefined): boolean {
  const o = owner ? lc(owner) : ''
  if (Array.isArray(want)) return !!o && want.map(lc).includes(o)
  if (want === 'any') return !!o
  if (want === 'none') return !o
  if (want === 'lane') return !!o && o !== 'main'
  return o === lc(want)
}
/** does rule r apply to this item in this state (every named predicate must hold) */
export function ruleMatches(r: WakeRule, item: WakeItem, state: WakeState, urgency: Urgency): boolean {
  const w = r.when ?? {}
  if (w.kind && !w.kind.includes(String(item.kind))) return false
  if (w.urgency && !w.urgency.includes(urgency)) return false
  if (w.sender && !w.sender.map(lc).includes(lc(item.sender))) return false
  if (typeof w.no_reply === 'boolean' && !!item.no_reply !== w.no_reply) return false
  if (w.sub && !w.sub.includes(String(item.sub ?? ''))) return false
  if (w.member && !w.member.includes(String(state.member))) return false
  if (w.owner != null && !ownerMatches(w.owner, state.owner)) return false
  if (w.gate != null) {
    if (!state.gate) return false
    if (Array.isArray(w.gate) && !w.gate.includes(state.gate)) return false
  }
  if (typeof w.worker_topics === 'boolean' && (state.worker_topics !== false) !== w.worker_topics) return false
  if (typeof w.lanes_off === 'boolean' && !!state.lanes_off !== w.lanes_off) return false
  if (typeof w.lane_free === 'boolean' && (state.lane_free !== false) !== w.lane_free) return false
  return true
}

function cell(map: Record<string, MapCell> | undefined, key: string): { target: string; tell?: string } | null {
  const c = map?.[key]
  if (c == null) return null
  return typeof c === 'string' ? { target: c } : { target: c.target, ...(c.tell ? { tell: c.tell } : {}) }
}
/** a destination (`main`, `lane:<kind>`) through a state map → a target */
function resolve(dest: string, mapName: string | undefined, state: WakeState, t: WakeTable): { target: string; then?: string; tell?: string } {
  if (dest === 'ledger') return { target: 'ledger' }
  const member = String(state.member || 'offline')
  if (dest === 'main') {
    const map = t.maps[mapName ?? 'main'] ?? t.maps.main
    const c = (member === 'idle' && state.main_offered ? cell(map, 'idle+offered') : null) ?? cell(map, member) ?? cell(t.maps.main, member) ?? { target: 'held:offline' }
    return c.target.startsWith('held:') ? { ...c, then: 'main' } : c
  }
  // a lane destination: goes on except where the lane map holds it
  const c = cell(t.maps[mapName ?? 'lane'] ?? t.maps.lane, member)
  return c && c.target.startsWith('held:') ? { ...c, then: dest } : { target: dest }
}

/** the one decision. `agentRules` (router.json wake_rules + legacyAgentRules) are read before the fleet table. */
export function decideWake(item: WakeItem, state: WakeState, table: WakeTable, agentRules: WakeRule[] = []): WakeVerdict {
  const urgency = (item.urgency ?? (table.urgency_default[String(item.kind)] as Urgency | undefined) ?? 'ordered') as Urgency
  for (const r of [...agentRules, ...table.rules]) {
    if (!ruleMatches(r, item, state, urgency)) continue
    let dest = r.to
    if (dest === 'owner') {
      const o = lc(state.owner)
      dest = !o ? 'main' : o === 'main' ? 'main' : LANE_KINDS.has(o) ? `lane:${o}` : 'main'
    }
    // a lane destination goes through the lane map; the main through the rule's main map (main | joey | state). An `owner` rule names the main's map
    // and its owner may turn out to be a lane: the lane map then.
    const mapName = dest.startsWith('lane:') ? 'lane' : dest === 'main' ? (r.map && r.map !== 'lane' ? r.map : 'main') : undefined
    const res = resolve(dest, mapName, state, table)
    const v: WakeVerdict = { target: res.target, urgency, rule: r.id, origin: r.origin ?? 'fleet', ...(res.then ? { then: res.then } : {}), ...(res.tell ? { tell: res.tell } : {}) }
    if (res.target.startsWith('lane:') && state.lane_free === false) v.wait = 'lane_slot'
    return v
  }
  return { target: resolve('main', 'main', state, table).target, urgency, rule: 'none', origin: 'fleet' }
}
// ------------------------------------------------------------------ an agent's own rules
/** the kind(s) an older router.json rule id stands for (lanes-router.fleet.json) */
const LEGACY_KIND: Record<string, string[]> = {
  'tg-main': ['joey_tg', 'joey_edit', 'joey_form'], 'tg-quote-lane': ['joey_tg', 'joey_edit'], 'tg-worker-topic': ['joey_tg', 'joey_edit'],
  'mesh-mail': ['peer_mail'], 'mesh-scheduled': ['scheduled'], 'mesh-alert': ['alert'], 'mesh-board': ['board'], 'mesh-peer-call': ['peer_call'],
  'mail-event': ['mail_event'],
}
const LEGACY_TO: Record<string, string> = { main: 'main', reflex: 'lane:reflex', mail_lane: 'lane:mail', ledger: 'ledger', worker_for_ticket: 'lane:worker',
  thread_owner: 'owner', quoted_lane: 'owner', topic_worker: 'owner' }
/** An agent's router.json, read against the fleet's (lanes-router.fleet.json): every rule that is new or whose destination differs becomes a wake rule
 *  (kind from its id, sender from match.from, no_reply from match.no_reply), in the agent's order, before the fleet table. Rules equal to the fleet's add
 *  nothing (the fleet table already says it). `wake_rules` in the same file are taken as they are, first. */
export function legacyAgentRules(agentRouter: any, fleetRouter: any): WakeRule[] {
  const out: WakeRule[] = []
  for (const r of Array.isArray(agentRouter?.wake_rules) ? agentRouter.wake_rules : []) out.push({ ...r, origin: r.origin ?? 'agent' })
  const fleet = new Map<string, any>((fleetRouter?.rules ?? []).map((r: any) => [r.id, r]))
  for (const r of agentRouter?.rules ?? []) {
    const f = fleet.get(r.id)
    if (f && f.to === r.to && JSON.stringify(f.match ?? {}) === JSON.stringify(r.match ?? {})) continue
    const to = LEGACY_TO[r.to]
    if (!to) continue
    const m = r.match ?? {}
    const when: WakeRule['when'] = {}
    const kinds = LEGACY_KIND[r.id] ?? (m.source === 'telegram' ? ['joey_tg', 'joey_edit', 'joey_form'] : undefined)
    if (kinds) when.kind = kinds
    if (Array.isArray(m.from)) when.sender = m.from
    if (m.no_reply === true) when.no_reply = true
    if (!when.kind && !when.sender && when.no_reply == null) continue           // a catch-all of its own: the fleet's default already decides
    out.push({ id: `legacy:${r.id}`, when, to, ...(to === 'main' ? { map: 'main' } : {}), origin: `legacy:${r.id}`, doc: r.note ?? `router.json rule ${r.id}` })
  }
  return out
}
