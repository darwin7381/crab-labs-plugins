import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { reportSession } from './onsen-session.ts'
import type { Journal } from './lanes-state.ts'
import { genuineAssistantAfterFile } from './liveness.ts'
import { scheduleRef, type InboxItem, type ItemRef, type ReceivingState, type ReceivingTarget } from './onsen-items.ts'
import type { ClaimStore, ItemReport, Outcome, ReportFields } from './onsen-receive.ts'

const intermediate = new Set<Outcome>(['in_session', 'owed', 'background', 'stuck'])
const week = 7 * 86400_000
type Claim = {
  kind?: string; schedule?: ItemReport['schedule']
  claim_id: string; taken_at: string; session_id?: string; in_session_at?: string; last_outcome?: Outcome
  turn?: string; registry_session?: string; conversation?: string; message_id?: string; replies?: string[]
  intakeAt?: string; target?: ReceivingTarget
  stop?: { turn: string; at: number }
}
// Away from a target the registry still supplies its status. Only its own transcript can supply a turn.
function sameState(before: ReceivingState, now: ReceivingState): boolean {
  return before.status === now.status && (now.turn === undefined || (before.turn === now.turn && before.lastTurn === now.lastTurn))
}
type Done = { item_id: string; claim_id: string; at: number }
type Spool = {
  recordItemReport(line: ItemReport): boolean
  hasItemReports(): boolean
}

/** The spool owns retries. Only its acknowledgement can retire a terminal claim. */
export class Claims implements ClaimStore {
  private rows: Record<string, Claim> = Object.create(null)
  private done: Done[] = []
  private waits = new Map<string, { state: ReceivingState; ids: string[] }>()
  private selections: Array<{ at: number; target: ReceivingTarget | null }> = []
  private receivers = new Map<string, string>()
  pollOffset: number | null = null
  private connector?: string
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(readonly file: string, readonly spool: Spool, readonly missed: (id: string, outcome: 'not_taken' | 'superseded') => void,
    readonly changed: () => void, readonly now = Date.now, readonly unboundOutcome: (id: string) => 'not_taken' | 'superseded' = () => 'not_taken',
    readonly targetState?: (t: ReceivingTarget) => ReceivingState | undefined) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      this.rows = Object.assign(Object.create(null), data.claims)
      // Pre-C6 main claims stored the receiving UUID separately from the wire value "main".
      for (const row of Object.values(this.rows)) if (row.registry_session) {
        row.session_id = row.registry_session
        delete row.registry_session
      }
      this.waits = new Map(data.waits ?? [])
      this.selections = data.selections ?? []
      this.receivers = new Map(data.receivers ?? [])
      // A C6 ledger from before ruling 27 can still hold an accepted or unacknowledged cut claim.
      for (const [id, r] of Object.entries(this.rows))
        if (r.target && r.in_session_at && r.session_id && !this.receivers.has(id)) this.receivers.set(id, r.session_id)
      this.done = data.done ?? []
      this.connector = data.connector
      this.pollOffset = data.pollOffset ?? null
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }

  /** Older claim ledgers omitted message_id. The original delivery recorded its Item and message ids together, in album order. */
  restoreMessageIds(journal: Journal): void {
    const missing = new Set(this.held().filter(id => this.rows[id]!.conversation && !this.rows[id]!.message_id))
    const count = missing.size
    if (!count) return
    const restore = (delivery?: { onsen_items?: ItemRef[]; person_message_ids?: string[] }) => {
      const refs = delivery?.onsen_items, ids = delivery?.person_message_ids
      if (!refs || !ids || refs.length !== ids.length) return
      refs.forEach((ref, i) => {
        if (ids[i] && missing.delete(ref.onsen_item_id)) this.rows[ref.onsen_item_id]!.message_id = ids[i]
      })
    }
    for (const msg of journal.rows('msg', r => !!r.onsen_items)) restore({ onsen_items: msg.onsen_items, person_message_ids: msg.person_message_ids })
    if (missing.size) for (const run of journal.rows('run')) {
      for (const event of [run.ev, ...(run.extra ?? []), ...(run.steered ?? [])]) restore(event)
    }
    if (missing.size < count) this.save()
  }

  wasOwed(id: string): boolean { return this.rows[id]?.last_outcome === 'owed' }
  carriedBy(connector: string): boolean { return this.connector === connector }
  upgradeCarrier(previous: string, connector: string): void {
    if (!this.carriedBy(previous)) return
    this.save(connector, this.pollOffset)
    this.connector = connector
  }
  rememberCarrier(connector: string): void {
    if (this.carriedBy(connector)) return
    this.save(connector, null)
    this.connector = connector
    this.pollOffset = null
  }
  rememberPollOffset(offset: number | null): void {
    if (this.pollOffset === offset) return
    this.save(this.connector, offset)
    this.pollOffset = offset
  }
  held(): string[] { return Object.keys(this.rows) }
  owns(id: string): boolean {
    const row = this.rows[id]
    return !!row && (!row.last_outcome || intermediate.has(row.last_outcome))
  }
  inSession(id: string): boolean { return !!this.rows[id]?.in_session_at }
  blocked(): boolean { return this.spool.hasItemReports() }
  completed(id: string): boolean { return this.done.some(d => d.item_id === id && d.at > this.now() - week) }

  waiting(id: string): void {
    // A server can return an unread mail Item to waiting even after accepting its completed report.
    if (this.done.some(d => d.item_id === id)) {
      this.done = this.done.filter(d => d.item_id !== id)
      this.save()
    }
  }

  private save(connector = this.connector, pollOffset = this.pollOffset): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = this.file + '.' + process.pid + '.tmp'
    this.done = this.done.filter(d => d.at > this.now() - week).slice(-5000)
    writeFileSync(tmp, JSON.stringify({ claims: this.rows, done: this.done, connector, pollOffset: pollOffset ?? undefined, waits: [...this.waits],
      selections: this.selections.length ? this.selections : undefined, receivers: this.receivers.size ? [...this.receivers] : undefined }), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  waitingSessions() { return this.waits.keys() }
  recordSelection(target: ReceivingTarget | null, at: number): void {
    const last = this.selections.at(-1)
    if (last?.target?.session_id === target?.session_id && last?.target?.claude_pid === target?.claude_pid) return
    this.selections.push({ at: Math.max(last?.at ?? 0, at), target })
    this.save()
  }
  selectedAt(at: number): ReceivingTarget | null {
    return this.selections.findLast(s => s.at <= at)?.target ?? null
  }
  lastTarget(session: string): ReceivingTarget | null {
    return this.selections.findLast(s => s.target?.session_id === session)?.target ?? null
  }
  firstReceiver(id: string): string | undefined { return this.receivers.get(id) }
  recoverReceiver(id: string, session: string): void {
    if (!this.receivers.has(id)) { this.receivers.set(id, session); this.save() }
  }
  waitingForState(session: string, id: string): boolean { return this.waits.get(session)?.ids.includes(id) ?? false }
  observeState(session: string, state: ReceivingState): void {
    const wait = this.waits.get(session)
    if (wait && !sameState(wait.state, state)) { this.waits.delete(session); this.save() }
  }
  private clock(id: string): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    const row = this.rows[id]
    if (!this.owns(id) || row.in_session_at) return
    const expire = () => {
      if (!this.owns(id) || this.rows[id]?.in_session_at) return
      const outcome = this.unboundOutcome(id)
      try { this.report(id, outcome) }
      catch { this.timers.set(id, setTimeout(expire, 1000).unref()); return }
      this.missed(id, outcome)
    }
    const delay = Math.max(0, Date.parse(row.taken_at) + 20_000 - this.now())
    this.timers.set(id, setTimeout(expire, delay).unref())
  }
  start(): void { for (const id of this.held()) this.clock(id) }
  stop(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear() }

  taken(row: InboxItem, ref: ItemRef): void {
    const claim = row.claim!
    if (this.rows[row.id]?.claim_id === claim.id) return
    const message = row.message_id ?? row.payload?.message_id
    this.rows[row.id] = { kind: row.kind, schedule: scheduleRef(row), claim_id: claim.id, taken_at: claim.taken_at, conversation: ref.conversation, target: ref.target,
      ...(message != null ? { message_id: String(message) } : {}) }
    this.save(); this.clock(row.id); this.changed()
  }
  /** Only an observed claim from the transcript of the offered target can bind a row. */
  targets(): ReceivingTarget[] {
    return Object.entries(this.rows).flatMap(([id, r]) => this.owns(id) && r.target ? [r.target] : [])
  }
  receipt(id: string): string { return this.rows[id]!.claim_id }
  accept(session: string, receipts: string[], turn: string, at: string): void {
    for (const [id, r] of Object.entries(this.rows))
      if (r.target?.session_id === session && !r.in_session_at && receipts.includes(r.claim_id)) {
        r.intakeAt = at
        this.bind(id, session, turn)
      }
  }
  cutTarget(t: ReceivingTarget): void {
    for (const [id, r] of Object.entries(this.rows)) {
      if (!this.owns(id) || r.target?.session_id !== t.session_id || r.target.claude_pid !== t.claude_pid) continue
      if (r.stop) this.complete(id, r)
      else {
        const intake = r.intakeAt ?? r.in_session_at
        const output = intake && genuineAssistantAfterFile(t.transcript, Date.parse(intake))
        this.report(id, 'cut', { half_done: !!r.replies?.length || !!output })
      }
    }
  }
  bind(id: string, session: string, turn: string): void {
    if (!this.owns(id)) return
    const row = this.rows[id]!
    Object.assign(row, { session_id: session, turn })
    if (!row.in_session_at) this.report(id, 'in_session', { session_id: session })
  }
  report(id: string, outcome: Outcome, fields: ReportFields = {}): boolean {
    const row = this.rows[id]
    if (!this.owns(id)) return false
    if (row.last_outcome === outcome) return true
    const body = { claim_id: row.claim_id, outcome, at: new Date(this.now()).toISOString(),
      ...(outcome === 'completed' ? { response_message_ids: row.replies ?? [] } : {}), ...fields }
    if (!this.spool.recordItemReport({ item_id: id, kind: row.kind, schedule: row.schedule, body })) throw new Error('could not spool item report for ' + id)
    this.replay({ item_id: id, body })
    this.save(); this.clock(id)
    return true
  }
  /** Restore a line appended before a crash between the spool append and ledger rename. */
  replay({ item_id: id, body }: ItemReport): void {
    const row = this.rows[id]
    if (row?.claim_id !== body.claim_id) return
    if (body.outcome === 'not_taken' && row.target && row.last_outcome !== 'not_taken') {
      const session = row.target.session_id
      const state = this.targetState?.(row.target) ?? row.target.stateAtOffer
      if (state) {
        const old = this.waits.get(session)
        const ids = old && sameState(old.state, state) ? old.ids : []
        if (!ids.includes(id)) ids.push(id)
        this.waits.set(session, { state, ids })
      }
    }
    row.last_outcome = body.outcome
    if (body.outcome === 'in_session') {
      row.in_session_at = body.at; row.session_id ??= body.session_id
      if (row.target && row.session_id && !this.receivers.has(id)) this.receivers.set(id, row.session_id)
    }
  }
  /** Translate at HTTP send time, including reports already durable in an older connector's spool. */
  reportBody({ body }: ItemReport, roamerMember?: string): ItemReport['body'] {
    return body.session_id ? { ...body, session_id: reportSession(body.session_id, roamerMember) } : body
  }
  acknowledged(line: ItemReport, accepted: boolean, state?: string): void {
    const { item_id: id, body } = line
    if (intermediate.has(body.outcome)) return
    if (accepted && (state === 'completed' || state === 'cancelled')) this.receivers.delete(id)
    if (accepted && state === 'waiting') this.waiting(id)
    if (accepted && state === 'completed') {
      if (!this.done.some(d => d.claim_id === body.claim_id && d.item_id === id))
        this.done.push({ item_id: id, claim_id: body.claim_id, at: this.now() })
      for (const [sid, wait] of this.waits) {
        wait.ids = wait.ids.filter(waiting => waiting !== id)
        if (!wait.ids.length) this.waits.delete(sid)
      }
    }
    if (this.rows[id]?.claim_id === body.claim_id) delete this.rows[id]
    this.save(); this.clock(id); this.changed()
  }
  reply(turn: string | null | undefined, conversation: string, message: string, registrySession?: string | null, replyToMessageId?: string): void {
    let updated = false
    for (const row of Object.values(this.rows)) {
      if (registrySession && row.session_id !== registrySession) continue
      const continued = row.last_outcome === 'background' && registrySession
      if (row.conversation !== conversation) continue
      // Receipts match an explicit quote by its Onsen message id. Unquoted replies belong to the work of this turn.
      if (replyToMessageId != null ? row.message_id !== replyToMessageId : !turn || (!continued && row.turn !== turn)) continue
      const replies = row.replies ??= []
      if (!replies.includes(message)) { replies.push(message); updated = true }
    }
    if (updated) this.save()
  }
  finalStop(session: string, turn: string): void {
    let updated = false
    for (const row of Object.values(this.rows)) {
      if (row.session_id !== session) continue
      if (row.stop?.turn !== turn && (row.turn === turn || row.last_outcome === 'background')) { row.stop = { turn, at: this.now() }; updated = true }
    }
    if (updated) this.save()
  }
  continued(session: string, turn: string): void {
    let updated = false
    for (const row of Object.values(this.rows)) if (row.session_id === session && row.stop?.turn === turn) { delete row.stop; updated = true }
    if (updated) this.save()
  }
  private complete(id: string, row: Claim): void {
    this.report(id, 'completed', { response_message_ids: row.replies ?? [] })
  }
  /** A member-wide record can also establish that a stopped main departed. A transcript watcher speaks only for its own UUID. */
  statusRecord(session: string | null, member: string, background: (session: string) => number | null, settleMs: number, memberRecord = false): void {
    for (const [id, row] of Object.entries(this.rows)) {
      if (!row.stop || !this.owns(id)) continue
      if (memberRecord && !row.target && (member === 'offline' || (session && session !== row.session_id))) {
        this.complete(id, row)
        continue
      }
      if (!session || row.session_id !== session || ['busy', 'stuck', 'compacting'].includes(member) || this.now() < row.stop.at + settleMs) continue
      const count = background(session)
      if (count == null) continue
      if (count > 0) this.report(id, 'background')
      else this.complete(id, row)
      delete row.stop
      this.save()
    }
  }
}
