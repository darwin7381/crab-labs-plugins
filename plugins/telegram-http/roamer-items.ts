import { statSync } from 'fs'
import { dirname } from 'path'
import type { InboxItem, ItemRef, ReceivingState, ReceivingTarget } from './onsen-items.ts'
import type { ItemReceiver } from './onsen-receive.ts'
import { receivingUUID } from './onsen-session.ts'
import type { Claims } from './onsen-claims.ts'
import { REGISTRY_SETTLE_MS, TurnWatch, type RegEntry, type Registry } from './onsen-status.ts'

type Notification = { method: string; params: unknown }
type Offer = { target: ReceivingTarget; stream: string }

/** Keep watching the original receiving turn across /roam and reconnects. All leases and reports belong to the common receiver. */
export class RoamerItems {
  private watches = new Map<string, TurnWatch>()
  private gate = ''
  private busyTurns = new Map<string, string>()
  private pending = new Map<string, string>()
  constructor(readonly o: {
    selected(): ReceivingTarget | null
    selectionWrittenAt(): number
    transcript(cwd: string, session: string): string
    refreshSession(target: ReceivingTarget, sessionId: string): void
    alive(pid: number): boolean
    stream(t: ReceivingTarget): string | undefined
    send(sid: string, notification: Notification): Promise<boolean>
    receiver: ItemReceiver; claims: Claims; registry: Registry
    watch: Pick<TurnWatch['o'], 'facts' | 'joey' | 'changed' | 'turnEnded'>
    revisit(): void
  }) {}

  private edge(reg: RegEntry): ReceivingState {
    const watch = this.watches.get(reg.sessionId)
    return { status: reg.status, turn: watch?.turnFacts()?.id ?? null, lastTurn: watch?.lastTurn()?.id ?? null }
  }
  stateOf(t: ReceivingTarget): ReceivingState | undefined {
    const reg = this.o.registry.entries().find(e => e.pid === t.claude_pid && e.sessionId === t.session_id)
    if (reg && this.watches.has(reg.sessionId)) return this.edge(reg)
  }
  observeBusy(session: string | null): void {
    if (!session) return
    const turn = this.watches.get(session)?.turnFacts()?.id
    if (turn) this.busyTurns.set(session, turn)
  }
  recordSelection(selected = this.o.selected(), entries = this.o.registry.entries()): void {
    let target = selected, at = this.o.selectionWrittenAt()
    const reg = selected && entries.find(e => e.pid === selected.claude_pid && e.sessionId)
    if (selected && reg && reg.sessionId !== selected.session_id) {
      target = { ...selected, session_id: reg.sessionId, transcript: this.o.transcript(reg.cwd, reg.sessionId) }
      at = Math.max(at, reg.statusAt ?? Date.now())
    }
    // Both the selection and Item.created_at use Onsen's clock, including on a delayed first peek.
    this.o.claims.recordSelection(target, at + (this.o.claims.now() - Date.now()))
  }
  async destination(row: InboxItem): Promise<string | null> {
    this.recordSelection()
    let session = this.o.claims.firstReceiver(row.id)
    if (!session && (row.reason === 'cut' || row.released || row.failures)) {
      // A previous connector may have acknowledged the cut and discarded its local claim.
      const res = await this.o.receiver.mode.req('GET', '/v1/items/' + encodeURIComponent(row.id))
      if (res?.status === 404) return null
      if (res?.status !== 200) throw new Error('could not read the receiving session for ' + row.id)
      const detail: InboxItem = res.json.data
      if (detail.state !== 'waiting') return null
      const created = detail.events?.find(e => e.kind === 'created')
      const first = detail.events?.filter(e => e.kind === 'in_session').sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''))[0]
      if (!created) return null
      if (first) {
        // Older events can repeat Item.session_id. A sender preset alone cannot identify a receiver.
        const member = this.o.receiver.mode.member
        const received = first.session_id !== created.session_id ? first.session_id : null
        const sid = receivingUUID(member, received) ?? (created.session_id == null ? receivingUUID(member, detail.session_id) : null)
        if (!sid) return null
        this.o.claims.recoverReceiver(row.id, sid)
        session = sid
      } else if (detail.reason === 'cut' && !detail.events?.some(e => e.kind === 'claimed' || e.kind === 'taken')) return null
    }
    session ??= this.o.claims.selectedAt(Date.parse(row.created_at ?? ''))?.session_id
    if (session) this.pending.set(row.id, session)
    return session ?? null
  }
  fullList(waiting: ReadonlyMap<string, number>): void {
    for (const id of this.pending.keys()) if (!waiting.has(id)) this.pending.delete(id)
  }
  selectedFor(session: string | null | undefined): boolean {
    const target = this.o.selected()
    if (!target || target.session_id !== session) return false
    const reg = this.o.registry.entries().find(e => e.pid === target.claude_pid)
    return !reg || reg.sessionId === session
  }
  ready(session: string | null): boolean { return !!session && !!this.offerTo(session) }
  private targetFor(reg: RegEntry): ReceivingTarget {
    const last = this.o.claims.lastTarget(reg.sessionId)
    return { session_id: reg.sessionId, claude_pid: reg.pid, transcript: this.o.transcript(reg.cwd, reg.sessionId),
      tmux: last?.claude_pid === reg.pid ? last.tmux : '' }
  }
  private offerTo(session: string, entries = this.o.registry.entries()): Offer | null {
    const matches = entries.filter(e => e.sessionId === session && this.o.alive(e.pid))
    const reg = matches[0]
    if (matches.length !== 1 || reg.status !== 'idle' || !this.watches.has(session)) return null
    const target = this.targetFor(reg)
    const stream = this.o.stream(target)
    return stream ? { target: { ...target, stateAtOffer: this.edge(reg) }, stream } : null
  }

  async offer(refs: ItemRef[], notification: Notification): Promise<void> {
    const session = refs[0]?.destination
    if (!session || refs.some(ref => ref.destination !== session)) return
    const dest = this.offerTo(session)
    if (!dest) return
    const { target, stream } = dest
    if (refs.some(ref => this.o.claims.waitingForState(target.session_id, ref.onsen_item_id))) return
    // A long turn may outgrow TurnWatch's ordinary tail before the daemon restarts.
    try { target.transcriptOffset = statSync(target.transcript).size } catch { target.transcriptOffset = 0 }
    const given = (await this.o.receiver.receive(refs.map(r => ({ ...r, target })))).given
    if (!given.size) return
    const held = refs.filter(r => given.has(r.onsen_item_id))
    if (!this.o.alive(target.claude_pid)) { this.o.receiver.report(held, 'cut', { half_done: false }); return }
    const next = this.offerTo(session)
    if (held.length !== refs.length || next?.stream !== stream || next.target.session_id !== target.session_id || next.target.claude_pid !== target.claude_pid) {
      this.o.receiver.report(held, 'not_taken')
      return
    }
    const p = notification.params as { content: string; meta?: Record<string, string> }
    const receipts = held.map(r => this.o.claims.receipt(r.onsen_item_id))
    const sent = await this.o.send(stream, { ...notification, params: { ...p, meta: { ...p.meta, onsen_claims: receipts.join(',') } } })
    if (!sent) this.o.receiver.report(held, 'not_taken')
    else for (const ref of held) this.pending.delete(ref.onsen_item_id)
  }

  tick(): void {
    const selected = this.o.selected()
    const all = this.o.claims.targets().sort((a, b) => (a.transcriptOffset ?? Infinity) - (b.transcriptOffset ?? Infinity))
    // An incomplete registry write is not evidence that the selected UUID has gone away.
    const entries = this.o.registry.entries().filter(e => e.sessionId)
    this.recordSelection(selected, entries)
    const selectedEntry = selected && entries.find(e => e.pid === selected.claude_pid)
    const switched = selected && selectedEntry && selectedEntry.sessionId !== selected.session_id
    if (selected && !switched && this.o.alive(selected.claude_pid)) all.push(selected)
    const wanted = new Set(this.pending.values())
    for (const reg of entries) if (wanted.has(reg.sessionId) && this.o.alive(reg.pid)) all.push(this.targetFor(reg))
    const live = new Set<string>()
    for (const t of all) {
      const sid = t.session_id
      const reg = entries.find(e => e.pid === t.claude_pid)
      if (live.has(sid)) continue
      live.add(sid)
      let watch = this.watches.get(sid)
      if (!watch) {
        watch = new TurnWatch({ ...this.o.watch, dir: () => dirname(t.transcript), session: () => sid, exact: true, resumeOffset: t.transcriptOffset,
          channel: (a, turn, at) => { if (a.onsen_claims) this.o.claims.accept(sid, a.onsen_claims.split(','), turn, at) },
          turnEnded: end => { this.o.claims.finalStop(sid, end.turn_id); this.o.watch.turnEnded?.({ ...end, session: sid }) } })
        this.watches.set(sid, watch)
      }
      const more = watch.tick()
      if (!this.o.alive(t.claude_pid) || (reg && reg.sessionId !== sid)) {
        // A final Stop can have reached disk between the last tick and the process exit.
        if (!more) this.o.claims.cutTarget(t)
        continue
      }
      if (reg?.status === 'busy') this.observeBusy(sid)
      else {
        const turn = watch.turnFacts()?.id
        if (reg?.status === 'idle' && turn && this.busyTurns.get(sid) === turn) {
          watch.endTurn(new Date().toISOString())
          this.o.watch.changed()
        }
        this.busyTurns.delete(sid)
      }
      if (reg) this.o.claims.observeState(sid, this.edge(reg))
      // The common status feed closes the selected session. A switched-away session still has its own registry facts.
      if (sid !== selected?.session_id && reg?.status === 'idle' && !watch.busy())
        this.o.claims.statusRecord(sid, 'idle', id => this.o.registry.backgroundAgents(id, dirname(t.transcript)), REGISTRY_SETTLE_MS)
    }
    for (const sid of this.o.claims.waitingSessions()) {
      if (live.has(sid)) continue
      const reg = entries.find(e => e.sessionId === sid)
      if (reg) this.o.claims.observeState(sid, { status: reg.status })
    }
    if (selected && switched && this.o.alive(selected.claude_pid) && !this.o.claims.targets().some(t => t.session_id === selected.session_id))
      this.o.refreshSession(selected, selectedEntry.sessionId)
    for (const sid of this.watches.keys()) if (!live.has(sid)) { this.watches.delete(sid); this.busyTurns.delete(sid) }
    if (selected) wanted.add(selected.session_id)
    const gate = JSON.stringify([selected?.session_id, ...[...wanted].sort().map(sid => {
      const dest = this.offerTo(sid, entries)
      return dest ? [sid, dest.stream, dest.target.stateAtOffer] : null
    })])
    if (gate !== this.gate) { this.gate = gate; this.o.revisit(); this.o.watch.changed() }
  }
  private current() { return this.watches.get(this.o.selected()?.session_id ?? '') }
  busy() { return this.current()?.busy() ?? null }
  watching() { return !!this.current()?.watching() }
  turnFacts() { return this.current()?.turnFacts() ?? null }
  lastTurn() { return this.current()?.lastTurn() ?? null }
  replyFrom(stream: string | undefined) {
    if (!stream) return null
    // Read the transcript before attaching a fast reply to its open turn.
    this.tick()
    const entries = this.o.registry.entries()
    for (const t of this.o.claims.targets()) {
      if (this.o.stream(t) === stream && entries.some(e => e.pid === t.claude_pid && e.sessionId === t.session_id))
        return { session: t.session_id, turn: this.watches.get(t.session_id)?.turnFacts()?.id ?? null }
    }
    return null
  }
}
