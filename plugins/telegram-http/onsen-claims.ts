import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { genuineAssistantAfterFile } from './liveness.ts'
import type { InboxItem, ItemRef, ReceivingState, ReceivingTarget } from './onsen-items.ts'
import type { ClaimStore, ItemReport, Outcome, ReportFields } from './onsen-receive.ts'

const intermediate = new Set<Outcome>(['in_session', 'owed', 'background', 'stuck'])
const week = 7 * 86400_000
type Claim = {
  claim_id: string; taken_at: string; session_id?: string; in_session_at?: string; last_outcome?: Outcome
  turn?: string; registry_session?: string; conversation?: string; replies?: string[]
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
  pollOffset: number | null = null
  private connector?: string
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(readonly file: string, readonly spool: Spool, readonly missed: (id: string) => void,
    readonly changed: () => void, readonly now = Date.now, readonly targetState?: (t: ReceivingTarget) => ReceivingState | undefined) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      this.rows = Object.assign(Object.create(null), data.claims)
      // Pre-C6 main claims stored the receiving UUID separately from the wire value "main".
      for (const row of Object.values(this.rows)) if (row.registry_session) {
        row.session_id = row.registry_session
        delete row.registry_session
      }
      this.waits = new Map(data.waits ?? [])
      this.done = data.done ?? []
      this.connector = data.connector
      this.pollOffset = data.pollOffset ?? null
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }

  carriedBy(connector: string): boolean { return this.connector === connector }
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
  blocked(): boolean { return this.spool.hasItemReports() }
  completed(id: string): boolean { return this.done.some(d => d.item_id === id && d.at > this.now() - week) }

  private save(connector = this.connector, pollOffset = this.pollOffset): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = this.file + '.' + process.pid + '.tmp'
    this.done = this.done.filter(d => d.at > this.now() - week).slice(-5000)
    writeFileSync(tmp, JSON.stringify({ claims: this.rows, done: this.done, connector, pollOffset: pollOffset ?? undefined, waits: [...this.waits] }), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  waitingSessions() { return this.waits.keys() }
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
      try { this.report(id, 'not_taken') }
      catch { this.timers.set(id, setTimeout(expire, 1000).unref()); return }
      this.missed(id)
    }
    const delay = Math.max(0, Date.parse(row.taken_at) + 20_000 - this.now())
    this.timers.set(id, setTimeout(expire, delay).unref())
  }
  start(): void { for (const id of this.held()) this.clock(id) }
  stop(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear() }

  taken(row: InboxItem, ref: ItemRef): void {
    const claim = row.claim!
    if (this.rows[row.id]?.claim_id === claim.id) return
    this.rows[row.id] = { claim_id: claim.id, taken_at: claim.taken_at, conversation: ref.conversation, target: ref.target }
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
  report(id: string, outcome: Outcome, fields: ReportFields = {}): void {
    const row = this.rows[id]
    if (!this.owns(id) || row.last_outcome === outcome) return
    const body = { claim_id: row.claim_id, outcome, at: new Date(this.now()).toISOString(), ...fields }
    if (!this.spool.recordItemReport({ item_id: id, body })) throw new Error('could not spool item report for ' + id)
    this.replay({ item_id: id, body })
    this.save(); this.clock(id)
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
    if (body.outcome === 'in_session') { row.in_session_at = body.at; row.session_id ??= body.session_id }
  }
  /** A queued pre-C6 report has the old wire value even after the ledger has been migrated. */
  reportBody({ item_id, body }: ItemReport): ItemReport['body'] {
    const row = this.rows[item_id]
    if (body.outcome === 'in_session' && body.session_id === 'main' && row?.claim_id === body.claim_id && row.session_id)
      return { ...body, session_id: row.session_id }
    return body
  }
  acknowledged(line: ItemReport, accepted: boolean): void {
    const { item_id: id, body } = line
    if (intermediate.has(body.outcome)) return
    if (accepted && body.outcome === 'completed') {
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
  reply(turn: string, conversation: string, message: string, session?: string | null): void {
    let updated = false
    for (const row of Object.values(this.rows)) {
      if (session && row.session_id !== session) continue
      const continued = row.last_outcome === 'background' && session
      if ((!continued && row.turn !== turn) || row.conversation !== conversation) continue
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
