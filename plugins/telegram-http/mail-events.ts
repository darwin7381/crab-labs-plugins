// mail-events — the mailbox's two events for the lane router (WO-126; seam claude-epeius/knowledge/lane-mailbox-seam.md v2, agreed with
// Sonn #10963; Joey TG chiron:2095).
//
// The main's mailbox (BTCC /api/mesh/mail) is the one list of what waits on the main's decision. BTCC never pushes anything into a session:
// the agent-inbox daemon hands the router two events, over the path every mesh item already takes (lanes.ts routeRemote → the tg daemon's
// /lanes/route):
//   mail_decision  the main answered a card (mailbox_decide). id mail-decision-<mail_id>. The router wakes the lane of that thread.
//   mail_due       an undecided card entered the window (GET /due?within=900, read every minute). id mail-due-<mail_id>-<deadline>; the
//                  router decides whether to wake the main. Only items new to the window are handed over.
// An event the router cannot take now (the tg daemon is down) waits in a file and goes again on the next tick: never dropped. The router
// dedupes by id, so a repeat after a lost answer opens nothing twice. Each event also carries a readable text and a channel notification,
// so a router that does not know the kind (or lanes switched off) gives it to the main as one item.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export type MailEventKind = 'mail_decision' | 'mail_due'
export type MailEvent = {
  id: string; source: 'mail'; kind: MailEventKind; from: string; text: string
  meta: Record<string, string>; notif: { method: string; params: { content: string; meta: Record<string, string> } }
  line: 'mail'; no_reply: true; verified: true
  mail_id: number; lane: string | null; thread: string | null; title: string; ref: string | null
  decision?: string; note?: string | null; card?: Record<string, unknown>
  deadline?: string; decide?: string; overdue?: boolean
}

export const WITHIN_S = 900          // Sonn #10963: the router wakes the main 15 minutes before a deadline at the latest
const DUE_KEEP_MS = 3 * 86400_000    // a deadline is at most 30 days out, but a key only has to outlive its window
const PENDING_MAX = 500

const DECISION_WORDS: Record<string, string> = { as_recommended: '照建議', changed: '改成', declined: '不做' }

function hm(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}

export function decisionWords(decision: string, note?: string | null): string {
  const w = DECISION_WORDS[decision] ?? decision
  return decision === 'changed' ? `${w}：${note ?? ''}` : note ? `${w}（${note}）` : w
}

function build(kind: MailEventKind, id: string, text: string, fields: Omit<MailEvent, 'id' | 'source' | 'kind' | 'from' | 'text' | 'meta' | 'notif' | 'line' | 'no_reply' | 'verified'>): MailEvent {
  const meta: Record<string, string> = { source: 'mail', kind, user: 'mailbox', mail_id: String(fields.mail_id), line: 'mail', no_reply: 'true',
    ...(fields.lane ? { lane: fields.lane } : {}), ...(fields.thread ? { lane_thread: fields.thread } : {}), ...(fields.ref ? { ref: fields.ref } : {}) }
  return { id, source: 'mail', kind, from: 'mailbox', text, meta, notif: { method: 'notifications/claude/channel', params: { content: text, meta } },
    line: 'mail', no_reply: true, verified: true, ...fields }
}

/** d = BTCC's answer to POST /{id}/decide */
export function decisionEvent(d: any): MailEvent {
  const lane = d.lane ?? null, thread = d.thread ?? null
  const text = `〔信箱｜主線的決定〕#${d.id}「${d.title ?? ''}」：${decisionWords(String(d.decision), d.note)}。`
    + (lane ? `交給 ${lane}${thread ? `（${thread}）` : ''} 照這個決定做完：回信、勾掉、補紀錄，向 Joey 回報一次。` : '照這個決定做完。')
  return build('mail_decision', `mail-decision-${d.id}`, text, { mail_id: Number(d.id), lane, thread, title: String(d.title ?? ''), ref: d.ref ?? null,
    decision: String(d.decision), note: d.note ?? null, card: d.card ?? {} })
}

/** it = one row of GET /due */
export function dueEvent(it: any): MailEvent {
  const text = `〔信箱｜等你決定，${it.overdue ? '已過期' : '快到期'}〕#${it.id}「${it.title ?? ''}」：${it.decide ?? ''}｜期限 ${hm(it.deadline)}`
    + `${it.recommend ? `｜建議：${it.recommend}` : ''}。用 mailbox_decide 回（照建議／改成…／不做）。`
  return build('mail_due', `mail-due-${it.id}-${it.deadline}`, text, { mail_id: Number(it.id), lane: it.lane ?? null, thread: it.thread ?? null,
    title: String(it.title ?? ''), ref: it.ref ?? null, deadline: String(it.deadline), decide: it.decide ?? '', overdue: it.overdue === true })
}

type Saved = { pending: MailEvent[]; due_sent: Record<string, number> }

export class MailEvents {
  pending: MailEvent[] = []
  dueSent: Record<string, number> = {}
  private flushing: Promise<number> | null = null
  constructor(private o: { file: string; send: (ev: MailEvent) => Promise<boolean>; log: (level: string, msg: string) => void; now?: () => number; onTake?: () => boolean }) {
    try {
      const s = JSON.parse(readFileSync(o.file, 'utf8')) as Saved
      this.pending = Array.isArray(s.pending) ? s.pending : []
      this.dueSent = s.due_sent && typeof s.due_sent === 'object' ? s.due_sent : {}
    } catch {}
  }
  private now(): number { return this.o.now ? this.o.now() : Date.now() }
  private save(): void {
    try {
      if (!existsSync(dirname(this.o.file))) mkdirSync(dirname(this.o.file), { recursive: true })
      const tmp = `${this.o.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ pending: this.pending, due_sent: this.dueSent } satisfies Saved))
      renameSync(tmp, this.o.file)
    } catch (e) { this.o.log('warn', `mail-events: cannot save ${this.o.file}: ${e}`) }
  }
  private async tryOne(ev: MailEvent): Promise<boolean> {
    try { return await this.o.send(ev) } catch (e) { this.o.log('warn', `mail-events: ${ev.id}: ${e}`); return false }
  }
  /** hand one event to the router now; if it cannot take it, it waits (in order, one per id) for the next flush */
  async emit(ev: MailEvent): Promise<'handed' | 'queued'> {
    await this.flush()                                  // what waits goes first: the router sees events in order
    if (!this.pending.length && await this.tryOne(ev)) return 'handed'
    if (!this.pending.some(p => p.id === ev.id)) {
      this.pending.push(ev)
      if (this.pending.length > PENDING_MAX) this.o.log('warn', `mail-events: ${this.pending.length} events wait for the router`)
    }
    this.save()
    this.o.log('warn', `mail-events: ${ev.id} waits (the router did not take it); ${this.pending.length} waiting`)
    return 'queued'
  }
  /** the waiting events, oldest first, until one is not taken; returns how many went */
  flush(): Promise<number> {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      let n = 0
      while (this.pending.length) {
        if (!await this.tryOne(this.pending[0])) break
        this.pending.shift(); n++
      }
      if (n) { this.save(); this.o.log('info', `mail-events: ${n} waiting event(s) handed to the router`) }
      return n
    })().finally(() => { this.flushing = null })
    return this.flushing
  }
  /** one tick: the waiting events, then the items new to the due window. fetchDue null = BTCC did not answer (try next tick). */
  async tick(fetchDue: () => Promise<any[] | null>): Promise<{ flushed: number; due: number }> {
    const flushed = await this.flush()
    if (this.o.onTake?.()) return { flushed, due: 0 }
    const items = await fetchDue().catch(() => null)
    let due = 0
    if (items && !this.o.onTake?.()) {
      const t = this.now()
      for (const it of items) {
        if (this.o.onTake?.()) break
        const ev = dueEvent(it)
        if (this.dueSent[ev.id]) continue
        this.dueSent[ev.id] = t
        await this.emit(ev)
        due++
      }
      let pruned = false
      for (const [k, at] of Object.entries(this.dueSent)) if (t - at > DUE_KEEP_MS) { delete this.dueSent[k]; pruned = true }
      if (due || pruned) this.save()
    }
    return { flushed, due }
  }
}
