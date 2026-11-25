// Onsen step 3 (WO-143): the Telegram daemon records facts only. Nothing here changes what is delivered, to whom or when; nothing is shown on Telegram.
//
//   DeliveryFacts  delivered / seen / turn_end of each of Joey's messages (one per message and state; the first recipient wins at Onsen), spooled through
//                  OnsenClient.recordDelivery behind the message's own record.
//   StatusFacts    the main's status (idle / busy / gone / walled / compacting): every state change at once; while the state stays, a detail change (busy: the
//                  tool, the subagent count, Joey's queued messages) at most once per 5 s, always the latest (a trailing write).
//   LanesTap       lanes on: reads the lanes journal (M1 items, the main's M2 row, lane runs) and the main's hook events; it changes nothing in them.
//   TurnWatch      lanes off: no hook reaches the daemon, so the main's turns are read from its transcript (turn_duration ends a turn; tool_use / tool_result
//                  open and close tools), the file the daemon already reads for receipts.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
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
  constructor(readonly o: { agent: string; sink: (f: DeliveryFact) => void; settleMs?: number; now?: Now; max?: number }) {}
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
export type StatusView = { state: StatusState; detail?: Record<string, unknown> }
export type BusyInput = { turn_started_at: string | null; tool: { name: string; started_at: string | null } | null; subagents: number }
export type StatusInputs = { connected: boolean; starting?: boolean; walled?: { until: string | null; kind?: string | null } | null; compacting?: boolean
  busy?: BusyInput | null; queued_joey: number }
/** one rule for both modes: gone (no main session connected) > walled (usage limit) > compacting > busy > idle */
export function statusOf(i: StatusInputs): StatusView {
  if (!i.connected) return i.starting ? { state: 'gone', detail: { starting: true } } : { state: 'gone' }
  if (i.walled) return { state: 'walled', detail: { until: i.walled.until ?? null, ...(i.walled.kind ? { kind: i.walled.kind } : {}) } }
  if (i.compacting) return { state: 'compacting' }
  if (i.busy) return { state: 'busy', detail: { turn_started_at: i.busy.turn_started_at, tool: i.busy.tool, subagents: i.busy.subagents, queued_joey: i.queued_joey } }
  return { state: 'idle' }
}

export class StatusFacts {
  private last: { state: StatusState; key: string; ms: number } | null = null
  private pending: StatusView | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(readonly o: { agent: string; sink: (f: StatusFact) => void; throttleMs?: number; now?: Now }) {}
  private now(): number { return (this.o.now ?? Date.now)() }
  /** the status as the daemon sees it now: a state change is written at once; a detail change within the same state at most once per throttleMs (the latest) */
  update(v: StatusView): void {
    const key = JSON.stringify(v.detail ?? null)
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
    try { this.o.sink({ idem_key: idemStatus(this.o.agent, ms, v.state), agent: this.o.agent, state: v.state, at: iso(ms), ...(v.detail ? { detail: v.detail } : {}) }) } catch {}
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
  private turn: { prompt: string; at: string } | null = null
  private subagents = 0
  private compactingAt: number | null = null
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
    const tool = String(b.tool_name ?? '')
    if (ev === 'PreToolUse' && AGENT_TOOLS.has(tool)) this.subagents++
    else if (ev === 'PostToolUse' && AGENT_TOOLS.has(tool)) this.subagents = Math.max(0, this.subagents - 1)
    else if (ev === 'StopFailure' || (ev === 'Stop' && b.phase === 'final')) this.subagents = 0
    this.o.changed()
  }

  inputs(o: { queuedJoey: number; wall: { walled: boolean; until: string | null; kind: string | null } | null }): StatusInputs {
    const g = this.o.gen()
    const st = String(g?.state ?? 'gone')
    const connected = st === 'idle' || st === 'in_turn' || st === 'walled'
    const walled = o.wall?.walled ? { until: o.wall.until, kind: o.wall.kind } : st === 'walled' ? { until: null, kind: g?.kind ? String(g.kind) : null } : null
    const busy: BusyInput | null = st === 'in_turn' ? {
      turn_started_at: this.turn && this.turn.prompt === String(g?.prompt_id ?? '') ? this.turn.at : null,
      tool: g?.tool_open ? (this.tool?.name === g.tool_open ? this.tool : { name: String(g.tool_open), started_at: null }) : null,
      subagents: this.subagents } : null
    const compacting = this.compactingAt != null && this.now() - this.compactingAt < 15 * 60_000
    return { connected, starting: st === 'starting', walled, compacting, busy, queued_joey: o.queuedJoey }
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
  private tools = new Map<string, { name: string; at: string; agent: boolean }>()
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
        this.tools.set(String(x.id), { name: String(x.name ?? 'tool'), at: ts, agent: AGENT_TOOLS.has(String(x.name)) && !x.input?.run_in_background })
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
    let last: { name: string; at: string } | null = null
    let agents = 0
    for (const t of this.tools.values()) { if (t.agent) agents++; if (!last || Date.parse(t.at) >= Date.parse(last.at)) last = t }
    return { turn_started_at: this.turnAt, tool: last ? { name: last.name, started_at: last.at } : null, subagents: agents }
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
