// Onsen step 2 (WO-142), item 3: an edited message of Joey's reaches the agent.
//
// Before: Onsen recorded the edit (onsen-client.ts inboundEdit), but the agent only ever had the original text. Now, when an allowlisted person edits a
// message that this daemon delivered into the conversation:
//   - the original still waits unseen (lanes on: its M1 item still queued, never offered; lanes off: a session's in-memory queue): that
//     copy gets the new text instead (meta edited="true"), so the main reads it once, already corrected;
//   - otherwise a new inbound goes the way a normal message goes (dispatchInbound: the router / the wake / the queues), its text the full new text under
//     one line: 〔Joey 改了他 HH:MMZ 那一則（tg:N）〕. The time is the ORIGINAL message's, UTC with a Z as the <channel ts> and chat_history say it
//     (MM-DD HH:MMZ when the original is from an earlier UTC day than the edit).
// Either way Onsen gets an edit_delivered event on the message (data.replaced_in_queue). The bot's own messages and other people's edits: recorded only.

export type Notif = { method: string; params: unknown }
export type Params = { content: string; meta: Record<string, string> }

/** Joey's Telegram id: the edit line calls him Joey (anyone else by their Telegram name) */
export const JOEY_TG_ID = '1828173984'

export function editorName(from: any): string {
  const id = String(from?.id ?? '')
  if (id === JOEY_TG_ID) return 'Joey'
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim()
  return name || (from?.username ? `@${from.username}` : `tg:${id || '?'}`)
}

const p2 = (n: number): string => String(n).padStart(2, '0')
/** the original's time, UTC: HH:MMZ; MM-DD HH:MMZ when it is from an earlier UTC day than the edit */
export function originalTime(dateS: unknown, editS?: unknown): string {
  const d = new Date(Number(dateS) * 1000)
  if (!Number.isFinite(d.getTime()) || !Number(dateS)) return '??:??Z'
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}Z`
  const e = new Date(Number(editS ?? dateS) * 1000)
  const sameDay = Number.isFinite(e.getTime()) && e.toISOString().slice(0, 10) === d.toISOString().slice(0, 10)
  return sameDay ? hm : `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${hm}`
}

/** the one line in front of the new text. Telegram's edited_message keeps the original send time in `date`; `edit_date` is the edit's */
export function editHeader(m: any): string {
  return `〔${editorName(m?.from)} 改了他 ${originalTime(m?.date, m?.edit_date)} 那一則（tg:${m?.message_id ?? '?'}）〕`
}
export const editedAt = (m: any): string => new Date((Number(m?.edit_date) || Math.floor(Date.now() / 1000)) * 1000).toISOString()

/** what an unseen queued copy becomes: the original's copy takes the new text as it is (the main never saw the old one); an earlier edit still waiting
 *  (same message_id, meta edited_at) keeps its header form with the newest text */
export function rewriteQueued(p: Params, m: any, text: string): Params {
  const wasEdit = !!p.meta?.edited_at
  return { content: wasEdit ? `${editHeader(m)}\n${text}` : text, meta: { ...(p.meta ?? {}), edited: 'true', edited_at: editedAt(m) } }
}

const metaOf = (n: Notif): Record<string, unknown> => ((n?.params as any)?.meta ?? {}) as Record<string, unknown>
/** a queued notification that carries Telegram message `id` of `chat` */
export function carries(n: Notif, chat: string, id: string): boolean {
  const meta = metaOf(n)
  return n?.method === 'notifications/claude/channel' && String(meta.chat_id ?? '') === chat && String(meta.message_id ?? '') === id
}
/** a copy of `n` with its params rewritten (the queued object itself is never mutated: it may be shared with a delivery record) */
export function rewritten(n: Notif, m: any, text: string): Notif {
  const p = (n.params ?? {}) as Record<string, any>
  const nw = rewriteQueued({ content: String(p.content ?? ''), meta: { ...(p.meta ?? {}) } }, m, text)
  return { method: n.method, params: { ...p, content: nw.content, meta: nw.meta } }
}

/** the Telegram messages this daemon delivered into the conversation (routed, or buffered as an album): chat:id → its send time (s). Bounded. */
export class DeliveredIndex {
  private m = new Map<string, number>()
  constructor(private max = 5000) {}
  note(chat: string, id: unknown, dateS?: unknown): void {
    if (id == null || id === '') return
    const k = `${chat}:${id}`
    this.m.delete(k)
    this.m.set(k, Number(dateS) || 0)
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!)
  }
  has(chat: string, id: unknown): boolean { return this.m.has(`${chat}:${id}`) }
}

export type EditDeps = {
  /** this daemon delivered Telegram message `id` of `chat` into the conversation (not a command it answered itself, not a permission reply) */
  delivered: (chat: string, id: string) => boolean
  /** every unseen queued copy of the message rewritten; true = at least one (the edit is then not sent again) */
  replaceQueued: (chat: string, id: string, rewrite: (p: Params) => Params) => boolean
  /** the way a normal message goes (server.ts dispatchInbound) */
  dispatch: (chat: string, notif: Notif) => Promise<void>
  /** the meta a message gets (server.ts: chat_id, user, user_id, topic, reply / forward), without ts */
  meta: (m: any) => Record<string, string>
  /** Onsen: the edit_delivered event */
  record: (chat: string, id: string, editDate: number | string, replacedInQueue: boolean) => void
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/** an allowlisted person's edit of message m (Telegram edited_message), `text` its new full text: replaced in the queue, delivered as new, or not
 *  delivered (the original never reached the conversation) */
export async function deliverEdit(m: any, text: string, d: EditDeps): Promise<'replaced' | 'delivered' | 'not-delivered'> {
  const chat = String(m?.chat?.id ?? ''), id = String(m?.message_id ?? '')
  if (!chat || !id) return 'not-delivered'
  if (!d.delivered(chat, id)) { d.log('info', `edit of tg:${id} in chat ${chat}: the original never reached the conversation (a command the daemon answered, or before this daemon's records) — recorded only`); return 'not-delivered' }
  const editDate = m?.edit_date ?? Math.floor(Date.now() / 1000)
  if (d.replaceQueued(chat, id, p => rewriteQueued(p, m, text))) {
    d.record(chat, id, editDate, true)
    d.log('info', `edit of tg:${id} in chat ${chat}: the original was still queued, unseen — its text replaced, not sent twice`)
    return 'replaced'
  }
  const at = editedAt(m)
  await d.dispatch(chat, { method: 'notifications/claude/channel', params: {
    content: `${editHeader(m)}\n${text}`,
    meta: { ...d.meta(m), chat_id: chat, message_id: id, ts: at, edited: 'true', edited_at: at },
  } })
  d.record(chat, id, editDate, false)
  d.log('info', `edit of tg:${id} in chat ${chat}: delivered as a new message`)
  return 'delivered'
}
