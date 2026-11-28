import { statSync } from 'fs'
import { dirname } from 'path'
import type { ItemRef, ReceivingTarget } from './onsen-items.ts'
import type { ItemReceiver } from './onsen-receive.ts'
import type { Claims } from './onsen-claims.ts'
import { REGISTRY_SETTLE_MS, TurnWatch, type Registry } from './onsen-status.ts'

type Notification = { method: string; params: unknown }
type Offer = { target: ReceivingTarget; stream: string }

/** Keep watching the original receiving turn across /roam and reconnects. All leases and reports belong to the common receiver. */
export class RoamerItems {
  private watches = new Map<string, TurnWatch>()
  private gate = ''
  private busyTurns = new Map<string, string>()
  constructor(readonly o: {
    selected(): ReceivingTarget | null
    refreshSession(target: ReceivingTarget, sessionId: string): void
    alive(pid: number): boolean
    stream(t: ReceivingTarget): string | undefined
    send(sid: string, notification: Notification): Promise<boolean>
    receiver: ItemReceiver; claims: Claims; registry: Registry
    watch: Pick<TurnWatch['o'], 'facts' | 'joey' | 'changed' | 'turnEnded'>
    revisit(): void
  }) {}

  private offerTo(): Offer | null {
    const target = this.o.selected()
    if (!target || !this.o.alive(target.claude_pid)) return null
    const reg = this.o.registry.main()
    if (!reg || reg.sessionId !== target.session_id || reg.pid !== target.claude_pid || reg.status !== 'idle') return null
    const stream = this.o.stream(target)
    return stream ? { target, stream } : null
  }

  async offer(refs: ItemRef[], notification: Notification): Promise<void> {
    const dest = this.offerTo()
    if (!dest) return
    const { target, stream } = dest
    // A long turn may outgrow TurnWatch's ordinary tail before the daemon restarts.
    try { target.transcriptOffset = statSync(target.transcript).size } catch { target.transcriptOffset = 0 }
    const given = (await this.o.receiver.receive(refs.map(r => ({ ...r, target })))).given
    if (!given.size) return
    const held = refs.filter(r => given.has(r.onsen_item_id))
    if (!this.o.alive(target.claude_pid)) { this.o.receiver.report(held, 'cut'); return }
    const next = this.offerTo()
    if (held.length !== refs.length || next?.stream !== stream || next.target.session_id !== target.session_id || next.target.claude_pid !== target.claude_pid) {
      this.o.receiver.report(held, 'not_taken')
      return
    }
    const p = notification.params as { content: string; meta?: Record<string, string> }
    const receipts = held.map(r => this.o.claims.receipt(r.onsen_item_id))
    const sent = await this.o.send(stream, { ...notification, params: { ...p, meta: { ...p.meta, onsen_claims: receipts.join(',') } } })
    if (!sent) this.o.receiver.report(held, 'not_taken')
  }

  tick(): void {
    const selected = this.o.selected()
    const all = this.o.claims.targets().sort((a, b) => (a.transcriptOffset ?? Infinity) - (b.transcriptOffset ?? Infinity))
    if (selected) all.push(selected)
    const live = new Set<string>()
    const entries = this.o.registry.entries()
    for (const t of all) {
      const sid = t.session_id
      const reg = entries.find(e => e.pid === t.claude_pid)
      if (!this.o.alive(t.claude_pid)) { this.o.claims.cutTarget(t); continue }
      if (reg && reg.sessionId !== sid) {
        this.o.claims.cutTarget(t)
        if (t === selected) this.o.refreshSession(t, reg.sessionId)
        continue
      }
      if (live.has(sid)) continue
      live.add(sid)
      let watch = this.watches.get(sid)
      if (!watch) {
        watch = new TurnWatch({ ...this.o.watch, dir: () => dirname(t.transcript), session: () => sid, exact: true, resumeOffset: t.transcriptOffset,
          channel: (a, turn) => { if (a.onsen_claims) this.o.claims.accept(sid, a.onsen_claims.split(','), turn) },
          turnEnded: end => { this.o.claims.finalStop(sid, end.turn_id); this.o.watch.turnEnded?.({ ...end, session: sid }) } })
        this.watches.set(sid, watch)
      }
      watch.tick()
      const turn = watch.turnFacts()?.id
      if (reg?.status === 'busy' && turn) this.busyTurns.set(sid, turn)
      if (reg?.status === 'idle' && turn && this.busyTurns.get(sid) === turn) {
        watch.endTurn(new Date().toISOString())
        this.o.watch.changed()
      }
      if (reg?.status !== 'busy') this.busyTurns.delete(sid)
      // The common status feed closes the selected session. A switched-away session still has its own registry facts.
      if (sid !== selected?.session_id && reg?.status === 'idle' && !watch.busy())
        this.o.claims.statusRecord(sid, 'idle', id => this.o.registry.backgroundAgents(id, dirname(t.transcript)), REGISTRY_SETTLE_MS)
    }
    for (const sid of this.watches.keys()) if (!live.has(sid)) { this.watches.delete(sid); this.busyTurns.delete(sid) }
    const dest = this.offerTo()
    const gate = dest ? dest.target.session_id + '/' + dest.stream : ''
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
    for (const t of this.o.claims.targets()) {
      if (this.o.stream(t) === stream) return { session: t.session_id, turn: this.watches.get(t.session_id)?.turnFacts()?.id ?? null }
    }
    return null
  }
}
