#!/usr/bin/env bun
// WO-157 phase 1: replay recorded wake decisions through decideWake (wake-decide.ts) and compare targets. Read only: it reads this machine's lanes records and
// writes its results to --out (nothing else is touched, no daemon is asked, no network).
//
// The questions (the "题目") are the Onsen /wake rows (WO-147). Onsen has one row per routing.jsonl line and one per event-keyed wake line of the state journal
// (onsen-wake.ts: "Onsen rows = routing.jsonl lines + state.jsonl event-keyed wake lines"), but the wake log only started at 09:40Z 2026-11-25 and only for the
// agents with ONSEN_WAKE_LOG: those rows are read as written from each daemon's Onsen spool (<STATE_DIR>/onsen/spool.jsonl, k 'w': the spool IS what is posted).
// For every earlier decision the same row is rebuilt from its routing.jsonl line / wake line with onsen-wake.ts's own functions (sourceKindOf, urgencyOf,
// targetOf, memberStateOf) and the moment's state from the journal (M2 `main` lines, M1 `msg` offers) and the Onsen status lines (k 's'). Where both exist the
// rebuilt row is checked against the written one (`validation` in the output).
//
// Each row then becomes a phase-2 item (the fields a sender writes: kind, urgency as the sender would fill it, no_reply, sender, refs) and a state (member,
// main_offered, owner, gate, worker_topics), and decideWake answers. Usage:
//   bun tools/wake-replay.ts --since 2026-11-24T00:00:00Z --out <dir>
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { sourceKindOf, urgencyOf, targetOf } from '../onsen-wake.ts'
import { decideWake, legacyAgentRules, loadWakeTable, type WakeItem, type WakeState, type WakeVerdict } from '../wake-decide.ts'

const args = process.argv.slice(2)
const arg = (k: string, d: string): string => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const SINCE = arg('--since', '2026-11-24T00:00:00Z')
const OUT = arg('--out', join(process.cwd(), 'wake-replay-out'))
const HOME = homedir()
const TABLE = loadWakeTable()
const FLEET_ROUTER = JSON.parse(readFileSync(join(import.meta.dir, '..', 'lanes-router.fleet.json'), 'utf8'))
const ALERT_SENDERS = FLEET_ROUTER.alert_senders as string[]
const ROSTER: string[] = (() => { try { return Object.keys(JSON.parse(readFileSync(join(HOME, '.claude/agent-inbox/registry.json'), 'utf8'))) } catch { return [] } })()

type J = Record<string, any>
function jsonl(p: string): J[] {
  if (!existsSync(p)) return []
  const out: J[] = []
  for (const l of readFileSync(p, 'utf8').split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)) } catch {} }
  return out
}
const ms = (s: unknown): number => Date.parse(String(s ?? ''))
/** first index i with arr[i].t > t (arr sorted by t) */
function upper(arr: { t: number }[], t: number): number { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) lo = m + 1; else hi = m } return lo }
const laneKindOf = (lanes: J, id: unknown): string | null => {
  if (typeof id !== 'string' || !id || id === 'main') return id === 'main' ? 'main' : null
  return lanes[id]?.kind ?? (id.split('.')[1] && ['reflex', 'mail', 'worker', 'fork', 'curator', 'synthesis'].includes(id.split('.')[1]) ? id.split('.')[1] : 'reflex')
}
/** a preview with anything key-shaped cut out (24+ characters of [A-Za-z0-9_-]) */
const safe = (s: unknown, n = 70): string => String(s ?? '').replace(/\s+/g, ' ').replace(/[A-Za-z0-9_\-]{24,}/g, '‹…›').slice(0, n)

type Agent = { name: string; ws: string; stateDir: string }
function agents(): Agent[] {
  const out: Agent[] = []
  const root = join(HOME, 'cc-workspaces')
  for (const d of readdirSync(root)) {
    const ws = join(root, d)
    if (!existsSync(join(ws, '.lanes', 'routing.jsonl'))) continue
    if (d.startsWith('claude-lab-')) continue                                   // the test benches (their records are reset by the tests)
    out.push({ name: d.replace(/^claude-/, ''), ws, stateDir: join(ws, '.telegram-state') })
  }
  const sonn = join(HOME, '.claude', 'workspace-telegram')
  if (existsSync(join(sonn, '.lanes', 'routing.jsonl'))) out.push({ name: 'sonn', ws: sonn, stateDir: join(HOME, '.claude', 'channels', 'telegram') })
  return out
}

// the route rules that are not a decision about an arriving item (excluded from the share, counted)
const NOT_DECISION: Record<string, string> = {
  digest: 'the digest rides another delivery; it never wakes alone (lanes-main.ts M:184)',
  coalesced: 'a second record of an event already routed (handled in the same run as another)',
  'mail-lane-renewed': 'a second record of an event already routed (moved to the renewed mail lane)',
  registration: 'a refused main registration, not an item', 'register-refused': 'a refused main registration, not an item',
}
const OWN_RULES = new Set(['fork', 'fan_out', 'fan_out-synthesis', 'open_worker', 'curate_memory', 'followup'])
const GATE_OF: Record<string, string> = { 'peer-hold': 'peer_hold', 'peer-flood': 'peer_flood', 'alert-repeat': 'alert_repeat', 'thread-gate': 'thread_stopped',
  'thread-stopped-drain': 'thread_stopped', 'mail-decision-repeat': 'repeat', 'master-off-ring': 'lanes_off_ring' }
const OWNER_RULES = new Set(['mesh-thread', 'tg-quote-lane', 'tg-worker-topic', 'mail-decision', 'incident-merge'])

/** a pre-1.49.1 event-keyed wake line → its hand-over decision (the line's reason is the only record of which caller wrote it) */
function handOf(reason: string): { kind: string; rule: string; urgency: string } {
  if (/^the run ended; the event owes nothing more/.test(reason)) return { kind: 'lane_exit', rule: 'exit-none', urgency: 'silent' }
  if (/^owed to the main \(syn-/.test(reason)) return { kind: 'handoff', rule: 'handoff-synthesis|exit-synthesis', urgency: 'ordered' }
  if (/^owed to the main \([^)]*\), but it can wait/.test(reason)) return { kind: 'card', rule: 'card-deferred', urgency: 'silent' }
  if (/^cards that can wait/.test(reason)) return { kind: 'batch', rule: 'defer-batch', urgency: 'ordered' }
  if (/^cannot wait after all/.test(reason)) return { kind: 'handoff', rule: 'handoff-woke-deferred', urgency: 'interrupt' }
  if (/^due soon/.test(reason)) return { kind: 'card', rule: 'card-due', urgency: 'ordered' }
  if (/^owed to the main/.test(reason)) return { kind: 'handoff', rule: 'handoff_main|exit-owes|card-now', urgency: 'ordered' }
  return { kind: 'other', rule: 'wake-row', urgency: 'ordered' }
}

type Row = {
  agent: string; at: string; src: 'onsen' | 'rebuilt'; line: 'route' | 'hand'
  rule: string; old_target: string; source_kind: string; rec_urgency?: string; member_state: string; m2: string; offered: boolean
  item: WakeItem; state: WakeState; verdict?: WakeVerdict; excluded?: string; preview: string; note?: string
  check?: { target: boolean; kind: boolean; member: boolean; wrote: J }
}

const rows: Row[] = []
const perAgent: Record<string, { route: number; hand: number; onsen: number }> = {}

for (const a of agents()) {
  const route = jsonl(join(a.ws, '.lanes', 'routing.jsonl')).filter(r => ms(r.ts) >= ms(SINCE))
  const journal = jsonl(join(a.stateDir, 'lanes', 'state.jsonl'))
  const spool = [...jsonl(join(a.stateDir, 'onsen', 'spool.1.jsonl')), ...jsonl(join(a.stateDir, 'onsen', 'spool.jsonl'))]
  const lanes = (() => { try { return JSON.parse(readFileSync(join(a.ws, '.lanes', 'state.json'), 'utf8')).lanes ?? {} } catch { return {} } })()
  const noJournal = !existsSync(join(a.stateDir, 'lanes', 'state.jsonl'))     // no Telegram daemon here (social-writer): M2 and M1 cannot be rebuilt
  const routerPath = join(a.ws, '.lanes', 'router.json')
  const agentRouter = existsSync(routerPath) ? (() => { try { return JSON.parse(readFileSync(routerPath, 'utf8')) } catch { return null } })() : null
  const agentRules = agentRouter ? legacyAgentRules(agentRouter, FLEET_ROUTER) : []

  // M2 (the main's record) and M1 offers over time; the Onsen status view over time
  const m2: { t: number; state: string }[] = []
  const offers: { t: number; id: string; state: string }[] = []
  const evInfo = new Map<string, J>()             // event id → what the journal knows (its record, a run's ev, an M1 item's meta)
  const msgIds = new Set<string>()
  for (const l of journal) {
    const t = ms(l.ts)
    if (l.rec === 'main' && l.state) m2.push({ t, state: String(l.state) })
    else if (l.rec === 'msg') {
      msgIds.add(String(l.id))
      if (l.state) offers.push({ t, id: String(l.id), state: String(l.state) })
      if (l.event && l.notif?.params?.meta) evInfo.set(String(l.event), { ...(evInfo.get(String(l.event)) ?? {}), meta: l.notif.params.meta })
    } else if (l.rec === 'run' && l.ev?.id) evInfo.set(String(l.ev.id), { ...(evInfo.get(String(l.ev.id)) ?? {}), ev: l.ev, meta: l.ev.meta })
    else if (l.rec === 'event' && l.id) evInfo.set(String(l.id), { ...(evInfo.get(String(l.id)) ?? {}), rec: { ...(evInfo.get(String(l.id))?.rec ?? {}), ...l } })
  }
  // offered-ness at time t: replay the M1 item states in order (an item is offered from its 'offered' line until its next line)
  const offeredAt: { t: number; n: number }[] = []
  { const st = new Map<string, string>(); let n = 0
    for (const o of offers) { const was = st.get(o.id); if (was === 'offered') n--; st.set(o.id, o.state); if (o.state === 'offered') n++; offeredAt.push({ t: o.t, n }) } }
  const status: { t: number; state: string }[] = spool.filter(x => x.k === 's' && x.r?.state).map(x => ({ t: ms(x.r.at), state: x.r.state !== 'offline' && x.r.detail?.walled ? 'walled' : String(x.r.state) }))
    .sort((p, q) => p.t - q.t)
  const wrote = spool.filter(x => x.k === 'w' && x.r).map(x => x.r as J)
  const wroteRoute = new Map<string, J[]>(), wroteHand = new Map<string, J>()
  for (const w of wrote) {
    const ev = String(w.refs?.event_id ?? '')
    if (String(w.rule ?? '').match(/^(handoff|card|defer-batch|exit|wake-row)/)) wroteHand.set(`${ev}|${w.at}`, w)
    else { const k = `${ev}|${w.rule}`; wroteRoute.set(k, [...(wroteRoute.get(k) ?? []), w]) }
  }
  const m2At = (t: number): string => { const i = upper(m2, t) - 1; return i >= 0 ? m2[i].state : 'none' }
  const offeredAtT = (t: number): boolean => { const i = upper(offeredAt, t - 1) - 1; return i >= 0 && offeredAt[i].n > 0 }
  const statusAt = (t: number): string | null => { const i = upper(status, t) - 1; return i >= 0 ? status[i].state : null }
  const memberFromM2 = (s: string): string => s === 'idle' ? 'idle' : s === 'in_turn' ? 'busy' : s === 'walled' ? 'walled' : s === 'starting' ? 'starting' : 'offline'
  perAgent[a.name] = { route: 0, hand: 0, onsen: 0 }

  // ---------------------------------------------------------------- routing.jsonl lines
  for (const r of route) {
    const t = ms(r.ts), rule = String(r.rule ?? '')
    const info = evInfo.get(String(r.event ?? '')) ?? {}
    const meta: J = { ...(info.meta ?? {}) }
    const isMesh = r.source === 'mesh'
    const line = rule === 'mesh-mail' ? 'mail' : (meta.line ?? (r.wake === 'mail' ? 'mail' : 'call'))
    const noReply = rule === 'mesh-no-reply' || meta.no_reply === 'true'
    if (r.wake === 'mail' && String(r.from).toLowerCase() === 'mailbox') meta.ring = 'true'
    const ev: J | null = r.source && !['main', 'followup', 'ledger', 'joey'].includes(r.source) ? {
      id: r.event, source: r.source, from: r.from, text: r.text ?? info.rec?.text ?? '', meta, wake: r.wake ?? info.ev?.wake ?? undefined,
      line: isMesh ? line : undefined, no_reply: noReply, verified: meta.verified !== 'false', fanout: info.ev?.fanout,
      kind: info.rec?.kind ?? info.ev?.kind,
    } : (r.source === 'main' || r.source === 'followup' ? { id: r.event, source: r.source, from: r.from, text: '', meta: {} } : null)
    const m2s = m2At(t), offered = offeredAtT(t)
    const main = m2s === 'none' ? null : { state: m2s, offered }
    const laneKind = laneKindOf(lanes, r.lane)
    const kindRec = sourceKindOf(r, ev as any, { alertSenders: ALERT_SENDERS, roster: () => ROSTER.filter(n => n !== a.name) })   // registryNames: the roster without itself
    const urgRec = urgencyOf(kindRec, r, ev as any, ALERT_SENDERS)
    const oldRebuilt = targetOf(r, { main, laneKind })
    const w = (wroteRoute.get(`${r.event}|${rule}`) ?? []).find(x => Math.abs(ms(x.at) - t) < 3000)
    const member = w?.member_state ?? statusAt(t) ?? memberFromM2(m2s)
    perAgent[a.name].route++
    if (w) perAgent[a.name].onsen++

    // the phase-2 item: the kind is the sender's field (here: what onsen-wake derived, the same kinds); urgency as the sender would fill it (none: the
    // table's default for the kind, e.g. a call interrupts whatever its no_reply); no_reply carried
    let kind: string = kindRec
    // a /lanes command of Joey's (source joey: /lanes off, on, close …) is recorded with rule master-<sub>; it is a command, not an item to route
    let excluded: string | undefined = NOT_DECISION[rule] ?? (r.source === 'joey' ? 'a /lanes command, not an item' : undefined)
      ?? (noJournal ? 'no state journal on this machine (no Telegram daemon): the state at that moment cannot be rebuilt' : undefined)
    if (!excluded && kindRec === 'other' && OWN_RULES.has(rule)) kind = 'own'
    let sub: string | undefined
    if (kind === 'mail_event') sub = /decision/.test(rule) || /主線的決定/.test(String(r.text ?? '')) ? 'decision' : 'due'
    const item: WakeItem = { kind, ...(noReply ? { no_reply: true } : {}), sender: String(r.from ?? ''), ...(sub ? { sub } : {}),
      refs: { event_id: String(r.event ?? ''), ...(r.btcc_msg_id ? { btcc_msg_id: String(r.btcc_msg_id) } : {}), ...(r.peer_thread ? { thread: String(r.peer_thread) } : {}) } }
    // the state: one member state; what the router's tables said about this item (its owner, a gate), recorded by its rule and note
    const state: WakeState = { member, main_offered: offered }
    if (GATE_OF[rule]) state.gate = GATE_OF[rule]
    if (rule === 'wake-mail' && r.target === 'ledger') state.gate = 'mail_run_waiting'
    if (rule === 'master-off') state.lanes_off = true
    if (OWNER_RULES.has(rule) || kind === 'own') state.owner = r.target === 'lane' ? laneKind : 'main'
    const ans = String(r.note ?? '').match(/answer to (\S+) → digest/)?.[1] ?? info.rec?.answers
    if (rule === 'mesh-no-reply' && ans) state.owner = ans === 'main' ? 'main' : laneKindOf(lanes, ans)
    if (rule === 'mesh-board' && /no worker topic/.test(String(r.note ?? ''))) state.worker_topics = false
    const row: Row = { agent: a.name, at: String(r.ts), src: w ? 'onsen' : 'rebuilt', line: 'route', rule, old_target: w?.target ?? oldRebuilt, source_kind: w?.source_kind ?? kindRec,
      rec_urgency: w?.urgency ?? urgRec, member_state: member, m2: m2s, offered, item, state, preview: safe(r.text), note: safe(r.note, 90), ...(excluded ? { excluded } : {}),
      ...(w ? { check: { target: w.target === oldRebuilt, kind: w.source_kind === kindRec, member: w.member_state === (statusAt(t) ?? memberFromM2(m2s)), wrote: w } } : {}) }
    rows.push(row)
  }

  // ---------------------------------------------------------------- event-keyed wake lines of the state journal (the hand-over decisions)
  for (const l of journal) {
    if (l.rec !== 'wake' || ms(l.ts) < ms(SINCE)) continue
    const id = String(l.id ?? '')
    if (!id || msgIds.has(id) || id.startsWith('m-')) continue                          // an M1 item's own line: the delivery of a decision recorded already
    const t = ms(l.ts), reason = String(l.reason ?? '')
    const w = wroteHand.get(`${id}|${l.ts}`)
    const h = w ? { kind: String(w.source_kind), rule: String(w.rule), urgency: String(w.urgency ?? 'ordered') } : handOf(reason)
    const m2s = m2At(t), offered = offeredAtT(t)
    const hasItem = l.state === 'wake' || /pulled or offered when it is idle/.test(reason)
    // handTarget: a wake (idle) or a no_wake with an item go by M2; a no_wake with no item is none
    const named = reason.match(/main (in_turn|gone|walled|starting|idle)/)?.[1]
    const m2Now = l.state === 'wake' ? 'idle' : named ?? m2s
    const oldRebuilt = !hasItem ? 'none' : targetOf({ target: 'main' }, { main: m2Now === 'none' ? null : { state: m2Now, offered: l.state === 'wake' ? offered : false }, laneKind: null })
    const member = w?.member_state ?? statusAt(t) ?? memberFromM2(m2Now)
    perAgent[a.name].hand++
    if (w) perAgent[a.name].onsen++
    const rec = evInfo.get(id)?.rec
    const item: WakeItem = { kind: h.kind, urgency: h.urgency as any, sender: String(w?.sender ?? 'lane'), refs: { event_id: id } }
    const state: WakeState = { member, main_offered: l.state === 'wake' ? offered : m2Now === 'idle' }
    rows.push({ agent: a.name, at: String(l.ts), src: w ? 'onsen' : 'rebuilt', line: 'hand', rule: h.rule, old_target: w?.target ?? oldRebuilt, source_kind: h.kind, rec_urgency: h.urgency,
      member_state: member, m2: m2Now, offered, item, state, preview: safe(rec?.text), note: safe(reason, 90),
      ...(w ? { check: { target: w.target === oldRebuilt, kind: true, member: w.member_state === (statusAt(t) ?? memberFromM2(m2Now)), wrote: w } } : {}) })
  }

  // ---------------------------------------------------------------- Onsen rows with no local line (should be none)
  for (const w of wrote) {
    if (ms(w.at) < ms(SINCE)) continue
    const found = rows.some(x => x.agent === a.name && x.check?.wrote === w)
    if (!found) rows.push({ agent: a.name, at: String(w.at), src: 'onsen', line: 'route', rule: String(w.rule), old_target: String(w.target), source_kind: String(w.source_kind),
      rec_urgency: w.urgency, member_state: String(w.member_state ?? 'offline'), m2: '?', offered: false,
      item: { kind: String(w.source_kind), sender: String(w.sender ?? '') }, state: { member: String(w.member_state ?? 'offline') }, preview: safe(w.preview), excluded: 'an Onsen row with no local line (unmatched)' })
  }
  void agentRules
}

// ---------------------------------------------------------------- decide and compare
const norm = (t: string): string => t === 'none' ? 'ledger' : t
const cls = (t: string): string => t.startsWith('main_') ? 'main' : t.startsWith('held:') ? 'held' : t.startsWith('lane:') ? 'lane' : t
type Cmp = 'same' | 'same-behaviour' | 'state-source' | 'diff'
const results: Array<Row & { new_target: string; new_rule: string; then?: string; cmp: Cmp; key: string }> = []
// an agent's router.json as it was at the row's time: a `router.json.bak-*` copy is the file before the change made when it was copied (its mtime), so a row
// older than that copy is decided with the copy's rules (Iris: iris-slack-wake added 2026-11-25T08:07Z); newer rows with the current file
const routerVersions = new Map<string, Array<{ until: number; rules: any[] }>>()
const rulesOf = (p: string): any[] => { try { return legacyAgentRules(JSON.parse(readFileSync(p, 'utf8')), FLEET_ROUTER) } catch { return [] } }
for (const a of agents()) {
  const dir = join(a.ws, '.lanes')
  const baks = readdirSync(dir).filter(f => f.startsWith('router.json.bak')).map(f => ({ until: statSync(join(dir, f)).mtimeMs, rules: rulesOf(join(dir, f)) })).sort((x, y) => x.until - y.until)
  routerVersions.set(a.name, [...baks, { until: Infinity, rules: existsSync(join(dir, 'router.json')) ? rulesOf(join(dir, 'router.json')) : [] }])
}
const rulesAt = (agent: string, at: string): any[] => (routerVersions.get(agent) ?? []).find(v => ms(at) < v.until)?.rules ?? []
for (const r of rows) {
  if (r.excluded) continue
  const ar = rulesAt(r.agent, r.at)
  const v = decideWake(r.item, r.state, TABLE, ar)
  r.verdict = v
  const oldT = norm(r.old_target), newT = norm(v.target)
  let cmp: Cmp = 'diff'
  if (oldT === newT && !(v.target.startsWith('held:') && v.then && v.then !== 'main')) cmp = 'same'          // an old hold always releases to the main
  else if (v.target === 'held:wall' && v.then === oldT) cmp = 'same-behaviour'                // the lane queue waits behind the wall today too
  else {
    // the same rule with the member state M2 implies gives the old target: the difference is only which of the two state sources was read
    const m2member = r.m2 === 'idle' ? 'idle' : r.m2 === 'in_turn' ? 'busy' : r.m2 === 'walled' ? 'walled' : r.m2 === 'starting' ? 'starting' : 'offline'
    const v2 = decideWake(r.item, { ...r.state, member: m2member }, TABLE, ar)
    if (norm(v2.target) === oldT && m2member !== r.state.member) cmp = 'state-source'
  }
  const key = `${r.source_kind}|${r.rule}|${oldT}→${newT}|${v.rule}`
  results.push({ ...r, new_target: v.target, new_rule: v.rule, ...(v.then ? { then: v.then } : {}), cmp, key })
}

// ---------------------------------------------------------------- report
mkdirSync(OUT, { recursive: true })
const byKind = new Map<string, { n: number; same: number; beh: number; st: number; diff: number; onsen: number }>()
for (const r of results) {
  const k = byKind.get(r.source_kind) ?? { n: 0, same: 0, beh: 0, st: 0, diff: 0, onsen: 0 }
  k.n++; if (r.src === 'onsen') k.onsen++
  if (r.cmp === 'same') k.same++; else if (r.cmp === 'same-behaviour') k.beh++; else if (r.cmp === 'state-source') k.st++; else k.diff++
  byKind.set(r.source_kind, k)
}
const groups = new Map<string, typeof results>()
for (const r of results) if (r.cmp !== 'same') groups.set(`${r.cmp}|${r.key}`, [...(groups.get(`${r.cmp}|${r.key}`) ?? []), r])
const excluded = new Map<string, number>()
for (const r of rows) if (r.excluded) excluded.set(`${r.rule}: ${r.excluded}`, (excluded.get(`${r.rule}: ${r.excluded}`) ?? 0) + 1)
const val = rows.filter(r => r.check)
const valT = val.filter(r => r.check!.target).length, valK = val.filter(r => r.check!.kind).length, valM = val.filter(r => r.check!.member).length
const valMiss = val.filter(r => !r.check!.target).map(r => ({ agent: r.agent, at: r.at, rule: r.rule, wrote: r.check!.wrote.target, rebuilt: r.line === 'hand' ? 'hand' : '', m2: r.m2, offered: r.offered }))
const tot = results.length, same = results.filter(r => r.cmp === 'same').length
const beh = results.filter(r => r.cmp === 'same-behaviour').length, st = results.filter(r => r.cmp === 'state-source').length
const summary = {
  since: SINCE, generated: new Date().toISOString(), table_version: TABLE.version,
  rows_read: rows.length, decisions: tot, onsen_rows: results.filter(r => r.src === 'onsen').length, rebuilt_rows: results.filter(r => r.src === 'rebuilt').length,
  excluded: Object.fromEntries(excluded), identical: same, identical_share: +(same / tot).toFixed(4),
  same_behaviour_label: beh, state_source: st, differ: tot - same - beh - st,
  by_kind: Object.fromEntries([...byKind.entries()].sort((x, y) => y[1].n - x[1].n)),
  by_agent: perAgent,
  validation: { onsen_rows_matched: val.length, target_equal: valT, kind_equal: valK, member_equal: valM, target_misses: valMiss.slice(0, 40) },
  groups: [...groups.entries()].sort((x, y) => y[1].length - x[1].length).map(([k, list]) => ({
    key: k, n: list.length, onsen: list.filter(r => r.src === 'onsen').length, agents: [...new Set(list.map(r => r.agent))].slice(0, 12),
    samples: list.slice(0, 3).map(r => ({ agent: r.agent, at: r.at, src: r.src, sender: r.item.sender, rule: r.rule, member: r.member_state, m2: r.m2, old: r.old_target, new: r.new_target,
      then: r.then, new_rule: r.new_rule, preview: r.preview, note: r.note })),
  })),
}
writeFileSync(join(OUT, 'replay-summary.json'), JSON.stringify(summary, null, 2))
writeFileSync(join(OUT, 'replay-rows.jsonl'), results.map(r => JSON.stringify({ agent: r.agent, at: r.at, src: r.src, line: r.line, source_kind: r.source_kind, rule: r.rule,
  rec_urgency: r.rec_urgency, member: r.member_state, m2: r.m2, offered: r.offered, item: r.item, state: r.state, old: r.old_target, new: r.new_target, then: r.then,
  new_rule: r.new_rule, cmp: r.cmp })).join('\n') + '\n')
console.log(`rows ${rows.length}, decisions ${tot} (Onsen-written ${summary.onsen_rows}, rebuilt ${summary.rebuilt_rows}); identical ${same} (${(100 * same / tot).toFixed(1)}%), `
  + `same behaviour other label ${beh}, state source ${st}, differ ${summary.differ}; validation ${val.length} rows: target ${valT}, kind ${valK}, member ${valM}`)
console.log(`out: ${OUT}`)
