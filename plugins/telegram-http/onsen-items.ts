import type { TakeMode } from './onsen-take.ts'

export type InboxItem = {
  id: string; number: number; member: string; session_id: string | null; kind: string; from: string
  state: string; reason: string | null; note?: string | null; version: number; updated_at: string; not_before?: string | null
  deadline?: string | null; half_done?: boolean; relay?: string | null; refs: Array<{ kind: string; value: string }>
  message_id?: string | null; action_id?: string | null; call_id?: string | null; mail_id?: string | null
  events?: Array<{ kind: string; note: string }>; payload: Record<string, any>
  claim?: { id: string; connector: string; taken_at: string; expires_at: string; session_id: string | null } | null
}

/** Only references travel in the M1 and lane journals. A waiting reference owns no claim. */
export type ItemRef = {
  onsen_item_id: string; onsen_version: number; kind: string; from: string; deadline?: string; main?: true
  note?: string; reason?: string; half_done?: true; conversation?: string
}
export function itemRef(it: InboxItem): ItemRef {
  return { onsen_item_id: it.id, onsen_version: it.version, kind: it.kind, from: it.from,
    ...(it.reason === 'reassigned' ? { main: true, note: it.note ?? undefined } : {}), ...(it.deadline ? { deadline: it.deadline } : {}),
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
  private wakeAt = Infinity
  private due?: ReturnType<typeof setTimeout>
  private timer?: ReturnType<typeof setTimeout>
  private reading = false
  private request?: AbortController

  constructor(readonly mode: TakeMode, readonly index: () => Map<string, number>,
    readonly route: (it: InboxItem, edit: boolean) => Promise<void>, readonly canRead: () => boolean) {}

  reset(): void {
    this.generation++
    this.request?.abort()
    this.changedAfter = this.page = this.nextChangedAfter = undefined
    this.routed = false
    this.previous.clear()
    this.seen.clear()
    clearTimeout(this.timer)
    if (this.mode.active && !this.reading) this.schedule(0)
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
    const ms = Date.parse(time)
    if (!(ms > Date.now() && ms < this.wakeAt)) return
    clearTimeout(this.due)
    this.wakeAt = ms
    this.due = setTimeout(() => { this.wakeAt = Infinity; this.reset() }, ms - Date.now())
    this.due.unref()
  }

  async poll(): Promise<void> {
    if (!this.mode.active || this.reading) return
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
      if (g !== this.generation || !this.mode.active) return
      if (r?.status === 409) {
        const why = r.json?.error?.code
        if (why === 'not_take_member' || why === 'not_current_connector') {
          this.mode.pause(why, why === 'not_current_connector' ? 45_000 : 60_000)
          return
        }
      }
      if (r?.status !== 200 || !Array.isArray(r.json.items) || typeof r.json.changed_after !== 'string' || !r.json.changed_after) { delay = 2000; return }
      const known = this.index()
      // Later pages can miss rows committed since page one. Resume from page one's token.
      this.nextChangedAfter ??= r.json.changed_after
      for (const it of r.json.items as InboxItem[]) {
        if (g !== this.generation || !this.canRead()) return
        if (it.not_before && Date.parse(it.not_before) > Date.now()) { this.dueAt(it.not_before); continue }
        const version = known.get(it.id)
        if (version === undefined || it.version > version) {
          if (this.previous.get(it.id) !== it.version && this.seen.get(it.id) !== it.version) {
            await this.route(it, version !== undefined)
            if (g !== this.generation) return
            this.routed = true
          }
        }
        if (g !== this.generation) return
        this.seen.set(it.id, it.version)
      }
      // A dispatched control may lift a gate and reset the cursor while this page is being routed.
      if (g !== this.generation) return
      this.page = r.json.next_cursor || undefined
      if (!this.page) {
        this.changedAfter = this.nextChangedAfter; this.nextChangedAfter = undefined
        this.previous = this.seen; this.seen = new Map()
        if (r.json.items.length) delay = this.routed ? 100 : 1000
        this.routed = false
      }
    } catch (err) { if (g === this.generation) this.mode.log('onsen take: peek failed: ' + err); delay = 2000 }
    finally {
      this.reading = false
      if (this.mode.active) this.schedule(g === this.generation ? delay : 0)
    }
  }
}
