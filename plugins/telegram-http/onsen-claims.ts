import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { Journal } from './lanes-state.ts'
import type { InboxItem, ItemRef } from './onsen-items.ts'
import type { ClaimStore, ItemReport, Outcome, ReportFields } from './onsen-receive.ts'

const intermediate = new Set<Outcome>(['in_session', 'owed', 'background', 'stuck'])
const week = 7 * 86400_000
type Claim = {
  claim_id: string; taken_at: string; session_id?: string; in_session_at?: string; last_outcome?: Outcome
  turn?: string; registry_session?: string; conversation?: string; message_id?: string; replies?: string[]
  stop?: { turn: string; at: number }
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
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(readonly file: string, readonly spool: Spool, readonly missed: (id: string, outcome: 'not_taken' | 'superseded') => void,
    readonly changed: () => void, readonly now = Date.now, readonly unboundOutcome: (id: string) => 'not_taken' | 'superseded' = () => 'not_taken') {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      this.rows = Object.assign(Object.create(null), data.claims)
      this.done = data.done ?? []
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
  held(): string[] { return Object.keys(this.rows) }
  owns(id: string): boolean {
    const row = this.rows[id]
    return !!row && (!row.last_outcome || intermediate.has(row.last_outcome))
  }
  inSession(id: string): boolean { return !!this.rows[id]?.in_session_at }
  blocked(): boolean { return this.spool.hasItemReports() }
  completed(id: string): boolean { return this.done.some(d => d.item_id === id && d.at > this.now() - week) }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = this.file + '.' + process.pid + '.tmp'
    this.done = this.done.filter(d => d.at > this.now() - week).slice(-5000)
    writeFileSync(tmp, JSON.stringify({ claims: this.rows, done: this.done }), { mode: 0o600 })
    renameSync(tmp, this.file)
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
    this.rows[row.id] = { claim_id: claim.id, taken_at: claim.taken_at, conversation: ref.conversation,
      ...(message != null ? { message_id: String(message) } : {}) }
    this.save(); this.clock(row.id); this.changed()
  }
  bind(id: string, session: string, turn: string, registrySession?: string): void {
    if (!this.owns(id)) return
    const row = this.rows[id]!
    Object.assign(row, { session_id: session, turn, registry_session: registrySession })
    if (!row.in_session_at) this.report(id, 'in_session', { session_id: session })
  }
  report(id: string, outcome: Outcome, fields: ReportFields = {}): boolean {
    const row = this.rows[id]
    if (!this.owns(id)) return false
    if (row.last_outcome === outcome) return true
    const body = { claim_id: row.claim_id, outcome, at: new Date(this.now()).toISOString(),
      ...(outcome === 'completed' && (row.replies || row.session_id === 'main') ? { response_message_ids: row.replies ?? [] } : {}), ...fields }
    if (!this.spool.recordItemReport({ item_id: id, body })) throw new Error('could not spool item report for ' + id)
    this.replay({ item_id: id, body })
    this.save(); this.clock(id)
    return true
  }
  /** Restore a line appended before a crash between the spool append and ledger rename. */
  replay({ item_id: id, body }: ItemReport): void {
    const row = this.rows[id]
    if (row?.claim_id !== body.claim_id) return
    row.last_outcome = body.outcome
    if (body.outcome === 'in_session') { row.in_session_at = body.at; row.session_id = body.session_id }
  }
  acknowledged(line: ItemReport, accepted: boolean): void {
    const { item_id: id, body } = line
    if (intermediate.has(body.outcome)) return
    if (accepted && body.outcome === 'completed' && !this.done.some(d => d.claim_id === body.claim_id && d.item_id === id))
      this.done.push({ item_id: id, claim_id: body.claim_id, at: this.now() })
    if (this.rows[id]?.claim_id === body.claim_id) delete this.rows[id]
    this.save(); this.clock(id); this.changed()
  }
  reply(turn: string | null | undefined, conversation: string, message: string, registrySession?: string | null, replyToMessageId?: string): void {
    let updated = false
    for (const row of Object.values(this.rows)) {
      const continued = row.last_outcome === 'background' && registrySession && row.registry_session === registrySession
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
      if (row.session_id !== 'main' || row.registry_session !== session) continue
      if (row.turn === turn || row.last_outcome === 'background') { row.stop = { turn, at: this.now() }; updated = true }
    }
    if (updated) this.save()
  }
  continued(turn: string): void {
    let updated = false
    for (const row of Object.values(this.rows)) if (row.stop?.turn === turn) { delete row.stop; updated = true }
    if (updated) this.save()
  }
  statusRecord(member: string, background: (session: string) => number | null, settleMs: number): void {
    if (['busy', 'stuck', 'compacting'].includes(member)) return
    for (const [id, row] of Object.entries(this.rows)) {
      if (!this.owns(id) || !row.stop || this.now() < row.stop.at + settleMs) continue
      const count = background(row.registry_session!)
      if (count == null) continue
      this.report(id, count > 0 ? 'background' : 'completed')
      delete row.stop
      this.save()
    }
  }
}
