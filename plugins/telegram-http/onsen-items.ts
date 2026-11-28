import type { TakeMode } from './onsen-take.ts'

export type InboxItem = {
  id: string; number: number; member: string; session_id: string | null; kind: string; from: string; waiter?: string
  state: string; reason: string | null; note?: string | null; released?: boolean; version: number; updated_at: string; not_before?: string | null
  in_session_at?: string | null; deadline?: string | null; half_done?: boolean; relay?: string | null; refs: Array<{ kind: string; value: string }>
  message_id?: string | null; action_id?: string | null; call_id?: string | null; mail_id?: string | null
  events?: Array<{ kind: string; note: string | null; at?: string; claim_id?: string | null; session_id?: string | null; state?: string; reason?: string | null }>; payload: Record<string, any>
  claim?: { id: string; connector: string; taken_at: string; expires_at: string; session_id: string | null } | null
}

/** Only references travel in the M1 and lane journals. A waiting reference owns no claim. */
export type ItemRef = {
  onsen_item_id: string; onsen_version: number; kind: string; from: string; deadline?: string; main?: true; refused_lane?: string
  note?: string; reason?: string; half_done?: true; conversation?: string; waiter?: string; not_before?: string
}
export function callSenders(refs: ItemRef[]): Set<string> {
  return new Set(refs.filter(r => r.kind === 'call').map(r => r.from))
}
export function hasCallFrom(refs: ItemRef[] | undefined, senders: Set<string>): boolean {
  return refs?.some(r => r.kind === 'call' && senders.has(r.from)) === true
}
export function itemRef(it: InboxItem): ItemRef {
  return { onsen_item_id: it.id, onsen_version: it.version, kind: it.kind, from: it.from,
    ...(it.waiter ? { waiter: it.waiter } : {}),
    ...(it.kind === 'keepwarm' && it.not_before ? { not_before: it.not_before } : {}),
    ...(it.reason === 'reassigned' ? { main: true, note: it.note ?? undefined } : {}), ...(it.deadline ? { deadline: it.deadline } : {}),
    ...(it.session_id && it.session_id !== 'main' && it.reason?.startsWith('usage_limit') ? { refused_lane: it.session_id } : {}),
    ...(it.reason ? { reason: it.reason } : {}), ...(it.half_done ? { half_done: true } : {}),
    ...(it.payload.conversation_id != null ? { conversation: String(it.payload.conversation_id) } : {}) }
}

export class ItemPeek {
  private generation = 0
  private changedAfter?: string
  private page?: string
  private nextChangedAfter?: string
  private routed = false
  private previous = new Map<string, number>()
  private seen = new Map<string, number>()
  private failures = new Map<string, { at: number; delay: number }>()
  private wakeAt = Infinity
  private due?: ReturnType<typeof setTimeout>
  private timer?: ReturnType<typeof setTimeout>
  private reading = false
  private request?: AbortController

  constructor(readonly mode: TakeMode, readonly index: () => Map<string, number>,
    readonly route: (it: InboxItem, change?: 'edited' | 'version') => Promise<void>, readonly canRead: () => boolean,
    readonly waitingReady?: () => void) {}

  reset(): void {
    this.generation++
    this.request?.abort()
    this.changedAfter = this.page = this.nextChangedAfter = undefined
    this.routed = false
    this.previous.clear()
    this.seen.clear()
    clearTimeout(this.timer)
    if (this.mode.canReceive && !this.reading) this.schedule(0)
  }

  stop(): void {
    this.reset()
    clearTimeout(this.timer)
    clearTimeout(this.due)
    this.wakeAt = Infinity
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.poll() }, ms)
    this.timer.unref()
  }

  dueAt(time: string): void {
    this.wake(Date.now() + (Date.parse(time) - this.mode.now()))
  }

  private wake(ms: number): void {
    if (!(ms > Date.now() && ms < this.wakeAt)) return
    clearTimeout(this.due)
    this.wakeAt = ms
    this.due = setTimeout(() => { this.wakeAt = Infinity; this.reset() }, ms - Date.now())
    this.due.unref()
  }

  private async routeWaiting(row: InboxItem, heldVersion?: number): Promise<void> {
    if (heldVersion === undefined) return this.route(row)
    const detail = await this.mode.req('GET', '/v1/items/' + encodeURIComponent(row.id))
    if (detail?.status === 404) return
    if (detail?.status !== 200) throw new Error('could not read item history for ' + row.id)
    const current: InboxItem = detail.json.data
    if (current.state === 'waiting') await this.route(current, current.events?.at(-1)?.kind === 'edited' ? 'edited' : 'version')
  }

  async poll(): Promise<void> {
    if (!this.mode.canReceive || this.reading) return
    this.reading = true
    const g = this.generation
    let delay = 0
    try {
      if (!this.canRead()) { delay = 250; return }
      const q = new URLSearchParams({ state: 'waiting', wait: '25', connector: this.mode.connector, limit: '100' })
      if (this.changedAfter) q.set('changed_after', this.changedAfter)
      if (this.page) q.set('cursor', this.page)
      this.request = new AbortController()
      const r = await this.mode.req('GET', this.mode.path + '?' + q, undefined, 35_000, undefined, this.request.signal)
      if (g !== this.generation || !this.mode.canReceive) return
      if (r?.status === 409) {
        const why = r.json?.error?.code
        if (why === 'not_take_member' || why === 'not_current_connector') {
          this.mode.pause(why, why === 'not_current_connector' ? 45_000 : 60_000)
          return
        }
      }
      if (r?.status !== 200 || !Array.isArray(r.json.items) || typeof r.json.changed_after !== 'string' || !r.json.changed_after) { delay = 2000; return }
      const known = this.index()
      let queued = false
      // Later pages can miss rows committed since page one. Resume from page one's token.
      this.nextChangedAfter ??= r.json.changed_after
      for (const it of r.json.items as InboxItem[]) {
        if (g !== this.generation || !this.canRead()) return
        if (it.not_before && Date.parse(it.not_before) > this.mode.now()) { this.dueAt(it.not_before); continue }
        const version = known.get(it.id)
        if (version !== undefined && !this.changedAfter) queued = true
        if (version === undefined || it.version > version) {
          const failure = this.failures.get(it.id)
          if (failure && failure.at > Date.now()) this.wake(failure.at)
          else if ((failure || this.previous.get(it.id) !== it.version) && this.seen.get(it.id) !== it.version) {
            try {
              await this.routeWaiting(it, version)
              this.failures.delete(it.id)
              if (g !== this.generation) return
              this.routed = true
            } catch (error) {
              const delay = Math.min(30_000, (failure?.delay ?? 500) * 2)
              const at = Date.now() + delay
              this.failures.set(it.id, { at, delay })
              this.wake(at)
              this.mode.log('onsen take: routing ' + it.id + ' failed: ' + error)
            }
          }
        }
        if (g !== this.generation) return
        this.seen.set(it.id, it.version)
      }
      // A dispatched control may lift a gate and reset the cursor while this page is being routed.
      if (g !== this.generation) return
      if (queued) this.waitingReady?.()
      this.page = r.json.next_cursor || undefined
      if (!this.page) {
        if (!this.changedAfter) for (const id of this.failures.keys()) if (!this.seen.has(id)) this.failures.delete(id)
        this.changedAfter = this.nextChangedAfter; this.nextChangedAfter = undefined
        this.previous = this.seen; this.seen = new Map()
        if (r.json.items.length) delay = this.routed ? 100 : 1000
        this.routed = false
      }
    } catch (err) { if (g === this.generation) this.mode.log('onsen take: peek failed: ' + err); delay = 2000 }
    finally {
      this.reading = false
      if (this.mode.canReceive) this.schedule(g === this.generation ? delay : 0)
    }
  }
}
