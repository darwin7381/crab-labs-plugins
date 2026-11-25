// Onsen step 3 (WO-143): the Telegram daemon records facts only. Nothing here changes what is delivered, to whom or when; nothing is shown on Telegram.
//
//   DeliveryFacts  delivered / seen / turn_end of each of Joey's messages (one per message and state; the first recipient wins at Onsen), spooled through
//                  OnsenClient.recordDelivery behind the message's own record.
//   StatusFacts    the main's status: every state change at once; while the state stays, a change of the detail or of last_activity_at at most once per 5 s,
//                  always the latest (a trailing write).
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
import { idemDelivery, idemStatus, type DeliveryFact, type DeliveryState, type StatusFact, type StatusState } from './onsen-client.ts'
import type { Row } from './lanes-state.ts'

type Now = () => number
const iso = (ms: number): string => new Date(ms).toISOString()
const k2 = (chat: string, id: string): string => `${chat}\u0000${id}`

// ------------------------------------------------------------------ delivery facts
export class DeliveryFacts {
  /** idem keys spooled by this daemon (bounded): each fact is written once per daemon life; across lives Onsen answers duplicate */
  private sent = new Map<string, true>()
  /** an album: the first message's id (the one the delivery carries) → every message id of it */
  private groups = new Map<string, string[]>()
  /** the main's turn closed these at a Stop; written once that turn stayed closed for settleMs (another Stop hook can still hold it) */
  private later = new Map<string, { chat: string; id: string; by: string; at: string; detail?: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }>()
  /** Joey's messages taken in and not yet into a turn (lanes off: the queued count) */
  private open = new Map<string, { at: number; seen: boolean; taken: boolean }>()
  /** onSeen (WO-145, the ✍ reaction): every `seen` report, for each message of it (an album: every item), the recipient named; a repeat too (the
   *  caller keeps its own once) */
  constructor(readonly o: { agent: string; sink: (f: DeliveryFact) => void; settleMs?: number; now?: Now; max?: number
    onSeen?: (chat: string, id: string, by: string) => void }) {}
  private now(): number { return (this.o.now ?? Date.now)() }

  /** the album's messages: what happens to the first (the one delivered) happens to each */
  album(chat: string, ids: Array<string | number>): void {
    const all = ids.map(String).filter(Boolean)
    if (all.length < 2) return
    this.groups.set(k2(chat, all[0]!), all)
    if (this.groups.size > 500) this.groups.delete(this.groups.keys().next().value!)
  }
  private idsOf(chat: string, id: string): string[] { return this.groups.get(k2(chat, id)) ?? [id] }
  private emit(chat: string, id: string, state: DeliveryState, by: string | undefined, at: string | undefined, detail?: Record<string, unknown>): void {
    for (const mid of this.idsOf(chat, id)) {
      const idem = idemDelivery(this.o.agent, chat, mid, state)
      if (this.sent.has(idem)) continue
      this.sent.set(idem, true)
      if (this.sent.size > (this.o.max ?? 20_000)) for (const k of [...this.sent.keys()].slice(0, 5_000)) this.sent.delete(k)
      try {
        this.o.sink({ idem_key: idem, agent: this.o.agent, client: 'telegram', chat, client_msg_id: mid, state, at: at ?? iso(this.now()),
          ...(by ? { by } : {}), ...(detail && Object.keys(detail).length ? { detail } : {}) })
      } catch {}
    }
  }
  delivered(chat: string, id: string | number, at?: string): void {
    const s = String(id)
    this.emit(chat, s, 'delivered', undefined, at)
    if (!this.open.has(k2(chat, s))) this.open.set(k2(chat, s), { at: this.now(), seen: false, taken: false })
    if (this.open.size > 2_000) this.open.delete(this.open.keys().next().value!)
  }
  seen(chat: string, id: string | number, by: string, at?: string): void {
    const s = String(id)
    this.emit(chat, s, 'seen', by, at)
    for (const m of this.idsOf(chat, s)) { const e = this.open.get(k2(chat, m)); if (e) e.seen = true }
    if (this.o.onSeen) for (const m of this.idsOf(chat, s)) { try { this.o.onSeen(chat, m, by) } catch {} }
  }
  /** lanes off: the transcript shows it taken into a turn (not a fact of its own: the queued count) */
  taken(chat: string, id: string | number): void {
    for (const m of this.idsOf(chat, String(id))) { const e = this.open.get(k2(chat, m)); if (e) { e.seen = true; e.taken = true } }
  }
  turnEnd(chat: string, id: string | number, by: string, at?: string, detail?: Record<string, unknown>): void {
    const s = String(id)
    this.cancelTurnEnd(chat, s, by)
    this.emit(chat, s, 'turn_end', by, at, detail)
    for (const m of this.idsOf(chat, s)) this.open.delete(k2(chat, m))
  }
  turnEndLater(chat: string, id: string | number, by: string, at: string, detail?: Record<string, unknown>): void {
    const s = String(id), key = `${k2(chat, s)}\u0000${by}`
    const was = this.later.get(key)
    if (was) clearTimeout(was.timer)
    const timer = setTimeout(() => { const l = this.later.get(key); if (l) this.turnEnd(l.chat, l.id, l.by, l.at, l.detail) }, this.o.settleMs ?? 60_000)
    ;(timer as any).unref?.()
    this.later.set(key, { chat, id: s, by, at, ...(detail ? { detail } : {}), timer })
  }
  /** the turn went on after that Stop: no turn_end yet */
  cancelTurnEnd(chat: string, id: string | number, by: string): void {
    const key = `${k2(chat, String(id))}\u0000${by}`, l = this.later.get(key)
    if (l) { clearTimeout(l.timer); this.later.delete(key) }
  }
  /** a new turn began (or the daemon stops): what waited to settle is final */
  flushLater(by?: string): void {
    for (const l of [...this.later.values()]) if (!by || l.by === by) this.turnEnd(l.chat, l.id, l.by, l.at, l.detail)
  }
  pendingLater(): number { return this.later.size }
  /** Joey's messages taken in by the daemon and not yet seen (mode seen) / not yet into a turn (mode taken); older than 6 h: dropped */
  queued(mode: 'seen' | 'taken'): number {
    const old = this.now() - 6 * 3600_000
    let n = 0
    for (const [k, e] of this.open) { if (e.at < old) { this.open.delete(k); continue } if (!(mode === 'seen' ? e.seen : e.taken)) n++ }
    return n
  }
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
export type StatusInputs = { main: { status: string; waiting_for?: string | null; status_at?: number | null } | null; offline?: OfflineReason; last_activity_at: string | null
  queued_joey: number; walled?: { until: string | null; kind?: string | null } | null; compacting?: boolean; turn?: BusyInput | null; lanes?: LaneRunInfo[]
  edges?: TurnEdges | null }
/** where the main's state comes from. A source reads one kind of evidence and fills StatusInputs; statusOf is the only judge. Registry is the one in use;
 *  another (a terminal reader, herdr / moshi style) implements this and nothing else changes. */
export interface StatusSource { inputs(shared: StatusShared): StatusInputs }
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
      return { state: 'idle', detail: { registry_stale: st, ...extras }, ...last }
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

export class StatusFacts {
  private last: { state: StatusState; key: string; ms: number } | null = null
  private pending: StatusView | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(readonly o: { agent: string; sink: (f: StatusFact) => void; throttleMs?: number; now?: Now }) {}
  private now(): number { return (this.o.now ?? Date.now)() }
  /** the status as the daemon sees it now: a state change is written at once; a change of the detail or last_activity_at within the same state at most
   *  once per throttleMs (the latest) */
  update(v: StatusView): void {
    const key = JSON.stringify([v.detail ?? null, v.last_activity_at ?? null])
    if (!this.last || this.last.state !== v.state) return this.send(v, key)
    if (this.last.key === key) { this.pending = null; return }
    const wait = this.last.ms + (this.o.throttleMs ?? 5_000) - this.now()
    if (wait <= 0) return this.send(v, key)
    this.pending = v
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; const p = this.pending; this.pending = null; if (p) this.update(p) }, wait)
      ;(this.timer as any).unref?.()
    }
  }
  private send(v: StatusView, key: string): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.pending = null
    const ms = Math.max(this.now(), (this.last?.ms ?? 0) + 1)          // one idem key per write
    this.last = { state: v.state, key, ms }
    try { this.o.sink({ idem_key: idemStatus(this.o.agent, ms, v.state), agent: this.o.agent, state: v.state, at: iso(ms), ...(v.detail ? { detail: v.detail } : {}),
      last_activity_at: v.last_activity_at ?? null }) } catch {}
  }
  current(): { state: StatusState; at: string } | null { return this.last ? { state: this.last.state, at: iso(this.last.ms) } : null }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.pending = null }
}

// ------------------------------------------------------------------ lanes on: the journal and the main's hook events
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
  constructor(readonly o: { facts: DeliveryFacts; joey: JoeyOf; gen: () => Row | null; changed: () => void; now?: Now }) {}
  private now(): number { return (this.o.now ?? Date.now)() }

  journal(row: Row, line: Record<string, unknown>): void {
    const F = this.o.facts
    if (row.rec === 'msg') {
      const j = this.o.joey((row.notif?.params as any)?.meta)
      if (j && line.state === 'bound') {
        // M1 bound it to a turn of the main: offered and opened the turn, or pulled at a tool boundary / Stop. bound again after its Stop
        // (turn_continued): that Stop was not the turn's end
        if (line.reason === 'turn_continued') F.cancelTurnEnd(j.chat, j.id, 'main')
        else F.seen(j.chat, j.id, 'main', row.ts)
      } else if (j && line.state === 'done') {
        F.turnEndLater(j.chat, j.id, 'main', row.ts, row.reason ? { reason: String(row.reason) } : undefined)
      }
    } else if (row.rec === 'run') {
      const evs = [row.ev, ...(Array.isArray(row.extra) ? row.extra : []), ...(Array.isArray(row.steered) ? row.steered : [])]
        .filter((e: any) => e && e.source === 'telegram').map((e: any) => this.o.joey(e.meta)).filter((x): x is { chat: string; id: string } => !!x)
      const lane = String(row.lane ?? 'lane')
      if (line.state === 'running') {
        this.runs.add(row.id)
        for (const e of evs) F.seen(e.chat, e.id, lane, row.ts)                  // spawned with it in its prompt, or steered into it
      } else if (line.state === 'exited' && this.runs.has(row.id)) {
        this.runs.delete(row.id)
        for (const e of evs) F.turnEnd(e.chat, e.id, lane, row.ts, row.reason ? { reason: String(row.reason) } : undefined)
      }
    } else if (row.rec === 'main') {
      if (typeof line.tool_open === 'string') this.tool = { name: line.tool_open, started_at: row.ts }
      else if ('tool_open' in line) this.tool = null
      if (row.state === 'in_turn' && row.prompt_id && row.prompt_id !== this.turn?.prompt) {
        this.turn = { prompt: String(row.prompt_id), at: row.ts }
        this.subagents = 0
        F.flushLater('main')                                                      // a new prompt: the last turn's Stop was its end
      }
      if (row.state !== 'in_turn') { this.tool = null; this.subagents = 0 }
    }
    this.o.changed()
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
    const tool = String(b.tool_name ?? '')
    if (ev === 'PreToolUse') this.toolTimeout = { name: tool, s: Number(b.tool_timeout_ms) > 0 ? Number(b.tool_timeout_ms) / 1000 : null }
    else if (ev === 'PostToolUse' || ev === 'Stop' || ev === 'StopFailure') this.toolTimeout = null
    if (ev === 'PreToolUse' && AGENT_TOOLS.has(tool)) this.subagents++
    else if (ev === 'PostToolUse' && AGENT_TOOLS.has(tool)) this.subagents = Math.max(0, this.subagents - 1)
    else if (ev === 'StopFailure' || (ev === 'Stop' && b.phase === 'final')) this.subagents = 0
    this.o.changed()
  }

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

export class TurnWatch {
  private file: string | null = null
  private offset = 0
  private rest = ''
  private dropFirst = false
  private scannedAt = 0
  private emitFloor = 0
  private inTurn = false
  private turnAt: string | null = null
  private tools = new Map<string, { name: string; at: string; agent: boolean; timeout_s: number | null }>()
  private taken = new Map<string, { chat: string; id: string }>()
  constructor(readonly o: { dir: () => string | null; facts: DeliveryFacts; joey: JoeyOf; changed: () => void; tailBytes?: number; rescanMs?: number; now?: Now }) {}
  private now(): number { return (this.o.now ?? Date.now)() }

  /** read what the main's transcript gained since the last tick */
  tick(): void {
    const dir = this.o.dir()
    if (!dir) return
    if (!this.file || this.now() - this.scannedAt >= (this.o.rescanMs ?? 10_000)) {
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
  /** a new transcript (a new session, a /clear): its tail is read for the current turn; a turn_end older than 10 min before now is not written again */
  private switchTo(f: string): void {
    this.file = f; this.rest = ''
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
    if (j.type === 'system' && j.subtype === 'turn_duration') return this.end(ts)
    if (j.type === 'attachment' && j.attachment?.type === 'queued_command') { const b = this.begin(ts); this.takeIn(String(j.attachment.prompt ?? '')); return b }
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
      const b = this.begin(ts); this.takeIn(text); return b
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
    this.inTurn = true; this.turnAt = ts; this.tools.clear(); this.taken.clear()
    return true
  }
  private takeIn(text: string): void {
    for (const a of channelTags(text)) {
      if (!/telegram/.test(a.source ?? '')) continue
      const j = this.o.joey(a)
      if (!j) continue
      this.taken.set(k2(j.chat, j.id), j)
      this.o.facts.taken(j.chat, j.id)
    }
  }
  private end(ts: string): boolean {
    if (!this.inTurn) return false
    const t = Date.parse(ts)
    if (!(t < this.emitFloor)) for (const j of this.taken.values()) this.o.facts.turnEnd(j.chat, j.id, 'main', ts)
    this.inTurn = false; this.turnAt = null; this.tools.clear(); this.taken.clear()
    return true
  }
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
export function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } }
/** the process's start time as `ps` gives it in UTC (the registry's procStart is written the same way), or null */
export function osProcStart(pid: number): string | null {
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
    const out = String(r.stdout ?? '').trim()
    return r.status === 0 && out ? out : null
  } catch { return null }
}
/** the same start time: the same text, or (another platform's wording) the same second within 2 s; text neither can read is not taken as different */
export function sameStart(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\s+/g, ' ').trim()
  if (n(a) === n(b)) return true
  const x = Date.parse(`${n(a)} UTC`), y = Date.parse(`${n(b)} UTC`)
  return !(Number.isFinite(x) && Number.isFinite(y)) || Math.abs(x - y) <= 2_000
}

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

  main(): RegEntry | null {
    return pickMain(this.entries(), { workspace: this.o.workspace, tmux: this.o.tmux ?? null, sessionId: this.o.sessionId?.() ?? null, alive: p => this.alive(p) })
  }
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
    return { main: { status: e.status, waiting_for: e.waitingFor ?? null, status_at: e.statusAt ?? null }, last_activity_at: this.lastActivity(e.sessionId), ...base }
  }
}
