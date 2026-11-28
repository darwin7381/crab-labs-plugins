import type { TakeMode } from './onsen-take.ts'
import { contextMessageLine, memberOfTg, type MemberKind } from './onsen-client.ts'

export type InboxItem = {
  id: string; number: number; member: string; session_id: string | null; kind: string; from: string
  state: string; reason: string | null; version: number; updated_at: string; not_before?: string | null
  deadline?: string | null; half_done?: boolean; relay?: string | null; refs: Array<{ kind: string; value: string }>
  message_id?: string | null; action_id?: string | null; call_id?: string | null; mail_id?: string | null
  events?: Array<{ kind: string; note: string }>; payload: Record<string, any>
  claim?: { id: string; connector: string; taken_at: string; expires_at: string; session_id: string | null } | null
}

/** Only references travel in the M1 and lane journals. A waiting reference owns no claim. */
export type ItemRef = {
  onsen_item_id: string; onsen_version: number; kind: string; from: string; deadline?: string; main?: true
  note?: string; reason?: string; half_done?: true; conversation?: string; from_kind?: MemberKind | null
}
export function itemRef(it: InboxItem): ItemRef {
  const note = it.events?.findLast(e => e.kind === 'reassigned')?.note
  return { onsen_item_id: it.id, onsen_version: it.version, kind: it.kind, from: it.from,
    ...(it.session_id === 'main' ? { main: true, note } : {}), ...(it.deadline ? { deadline: it.deadline } : {}),
    ...(it.reason ? { reason: it.reason } : {}), ...(it.half_done ? { half_done: true } : {}),
    ...(it.payload.conversation_id != null ? { conversation: String(it.payload.conversation_id) } : {}) }
}

/** Old references lack from_kind. An explicit null means the registry could not identify this sender. */
export function personMessage(ref: ItemRef): boolean {
  return ref.kind === 'message' && (ref.from_kind === undefined || ref.from_kind === 'human' || ref.from_kind === 'guest')
}
/** The author of a person message or album. Legacy Telegram DMs identify the person by their account. */
export function personMember(refs: ItemRef[] | undefined, meta: Record<string, string>): string | null {
  if (refs?.length) {
    const author = refs[0]!.from
    return refs.every(ref => personMessage(ref) && ref.from === author) ? author : null
  }
  return /^\d+$/.test(meta.chat_id ?? '') ? memberOfTg(meta.user_id || meta.chat_id) : null
}
export function mayTakeItem(ref: ItemRef, phase: 'in_turn' | 'usage_limit'): boolean {
  if (ref.kind === 'message') return personMessage(ref)
  return phase === 'in_turn' && (ref.kind === 'call' || ref.kind === 'control' || Date.parse(ref.deadline ?? '') <= Date.now())
}

/** The server supplies these rows oldest first on the claim that advances this member's read position. */
export function messageContext(it: InboxItem): string {
  if (it.kind !== 'message') return ''
  const { context, context_omitted } = it.payload
  const lines = context_omitted > 0 ? [`還有 ${context_omitted} 則較早的，用 chat_history 查`] : []
  if (Array.isArray(context)) lines.push(...context.map(contextMessageLine))
  return lines.join('\n')
}

export class ItemPeek {
  private generation = 0
  private cursor?: string
  private page?: string
  private pageTime?: string
  private previous = new Map<string, number>()
  private boundary = new Map<string, number>()
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
    this.cursor = this.page = this.pageTime = undefined
    this.previous.clear()
    this.boundary.clear()
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
      if (this.cursor) q.set('changed_after', this.cursor)
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
      if (r?.status !== 200 || !Array.isArray(r.json.items) || !r.json.as_of) { delay = 2000; return }
      const known = this.index()
      const asOf = this.pageTime ?? r.json.as_of
      for (const it of r.json.items as InboxItem[]) {
        if (g !== this.generation || !this.canRead()) return
        if (it.not_before && Date.parse(it.not_before) > Date.now()) { this.dueAt(it.not_before); continue }
        const version = known.get(it.id)
        if (version === undefined || it.version > version) {
          if (this.previous.get(it.id) !== it.version && this.boundary.get(it.id) !== it.version) await this.route(it, version !== undefined)
        }
        if (g !== this.generation) return
        if (Date.parse(it.updated_at) >= Date.parse(asOf)) this.boundary.set(it.id, it.version)
      }
      // A dispatched control may lift a gate and reset the cursor while this page is being routed.
      if (g !== this.generation) return
      this.pageTime = asOf
      this.page = r.json.next_cursor || undefined
      if (!this.page) {
        this.cursor = asOf; this.pageTime = undefined
        this.previous = this.boundary; this.boundary = new Map()
        if (r.json.items.length) delay = 100
      }
    } catch (err) { if (g === this.generation) this.mode.log('onsen take: peek failed: ' + err); delay = 2000 }
    finally {
      this.reading = false
      if (this.mode.active) this.schedule(g === this.generation ? delay : 0)
    }
  }
}
