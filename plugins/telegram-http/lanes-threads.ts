// WO-164 phase 1 (Chiron's ticket; Joey TG chiron:2434 「從正規的通訊軟體來思考…弄成正規機制」, 2405): every item belongs to a thread with a fixed key, and
// goes to that thread's owner. This module is the pure half (no state, no I/O):
//   - threadKeyOf(item, links): the thread an item belongs to, read from its FIELDS only. The sender's key field for its kind (a mail → refs.conversation,
//     a scheduled run → refs.schedule, a board item → refs.ticket, an alert → refs.incident); else the structured links the router already keeps (a call's
//     thread, the item a reply quotes, the lane message Joey quoted, the worker topic he wrote in); Joey's chat → tg:<chat>[:<topic>]; a mail that starts
//     a conversation → its own message id (Chiron 16:50Z (9): a mail's key is refs.conversation, always; Onsen 0.12.3 fills it, and these links only cover
//     a mail that arrives without it); otherwise the item is its own thread. Never a guess from the text: the old text readings ([WO-n] in a board
//     item, [run:N] in a scheduled head) are only reported when a sender left the field out (lanes.ts thread_key_missing rows).
//   - threadEvents(view, sent): what Onsen must be told about one thread (fleet-core onsen6.py, Epeius WO-163 15:32Z / 15:50Z): open / assign / transfer /
//     item / close / reopen / wait / snooze, each with a per-agent dedupe, from the difference between the thread now and what Onsen was last told.
//   - sentOf(row): what an Onsen thread row says, as that `sent` (the start handshake compares the two).
// lanes.ts holds the threads (S.threads, the key index) and decides; server.ts carries the events through the Onsen spool (onsen-client.ts, k 't').

export const KEY_KINDS = ['peer_call', 'mail', 'schedule', 'ticket', 'incident', 'tg', 'item'] as const
export type KeyKind = typeof KEY_KINDS[number]
export type ThreadState = 'open' | 'waiting_peer' | 'snoozed' | 'closed'
/** the sender's thread-key fields (Onsen /send `refs`, WO-163 point 5; the BTCC senders' run_id / ticket / alert), as strings */
export type ThreadRefs = Partial<Record<'conversation' | 'schedule' | 'run' | 'run_id' | 'ticket' | 'incident' | 'alert' | 'thread' | 'btcc_msg_id', string>>
export const REF_FIELDS = ['conversation', 'schedule', 'run', 'run_id', 'ticket', 'incident', 'alert', 'thread', 'btcc_msg_id'] as const

/** the refs of an /inject body or an Onsen item, kept to the known fields (a number or a short string each); undefined = none */
export function refsOf(v: unknown): ThreadRefs | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: ThreadRefs = {}
  for (const k of REF_FIELDS) {
    const x = (v as Record<string, unknown>)[k]
    if ((typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.trim())) out[k] = String(x).trim().slice(0, 120)
  }
  return Object.keys(out).length ? out : undefined
}
/** a ticket reference as the board writes it (164, "164", "WO-164") → "164"; null when it is none */
export function ticketOf(v: unknown): string | null {
  const m = String(v ?? '').trim().match(/^(?:WO-)?(\d{1,9})$/i)
  return m ? m[1] : null
}
/** the run id the sender wrote as a field (refs.run, refs.run_id, the inject body's run_id), digits only; null = none */
export function runOf(refs: ThreadRefs | undefined, bodyRun?: unknown): string | null {
  for (const v of [refs?.run, refs?.run_id, bodyRun]) { const s = String(v ?? '').trim(); if (/^\d+$/.test(s)) return s }
  return null
}

/** what threadKeyOf reads of an item: its fields only */
export type KeyItem = {
  id: string; source: 'telegram' | 'mesh' | 'mail'; kind: string; refs?: ThreadRefs
  /** a call's thread (the sender's daemon stamps it); a mailbox event's card thread */
  thread?: string; reply_to_id?: string; btcc_msg_id?: string
  /** Joey's chat, the topic he wrote in, the bot message he quoted */
  chat?: string; topic?: string; reply_to_message_id?: string
}
/** the router's own tables, as lookups (lanes.ts): each answers a local thread id or null */
export type KeyLinks = {
  /** a call's thread: the thread when it is ours and the sender may speak in it; null when it belongs to another peer; undefined when it is new to us */
  callThread: (thread: string) => string | null | undefined
  /** the thread the item replied to is in (our send it quotes, the peer's own earlier message) */
  replyThread: (id: string) => string | null
  /** the thread of the lane whose bot message Joey quoted */
  quotedThread: (messageId: string) => string | null
  /** the thread of the worker lane whose topic Joey wrote in */
  topicThread: (topic: string) => string | null
}
/** where an item belongs: an existing thread (`thread`, found through a link) or a key (`key_kind` + `key`, the thread found or opened by it) */
export type ThreadKey = { via: string; thread?: string; key_kind?: KeyKind; key?: string }

/** the key field the sender writes for each kind (Chiron WO-164 point 2) */
const FIELD_OF: Record<string, [keyof ThreadRefs, KeyKind]> = {
  peer_mail: ['conversation', 'mail'], scheduled: ['schedule', 'schedule'], board: ['ticket', 'ticket'], alert: ['incident', 'incident'],
}
/** the field key alone (no links): what the sender wrote for this kind, or null */
export function fieldKey(it: Pick<KeyItem, 'kind' | 'refs'>): { key_kind: KeyKind; key: string } | null {
  const f = FIELD_OF[it.kind]
  if (!f) return null
  const raw = it.refs?.[f[0]]
  const key = f[1] === 'ticket' ? ticketOf(raw) : raw ? String(raw) : null
  return key ? { key_kind: f[1], key } : null
}
/** the thread an item belongs to, from its fields (see the head of this file) */
export function threadKeyOf(it: KeyItem, links: KeyLinks): ThreadKey {
  const f = fieldKey(it)
  if (f) return { ...f, via: 'field' }
  if (it.source === 'telegram') {
    const q = it.reply_to_message_id ? links.quotedThread(it.reply_to_message_id) : null
    if (q) return { thread: q, via: 'quoted' }
    const t = it.topic ? links.topicThread(it.topic) : null
    if (t) return { thread: t, via: 'topic' }
    return { key_kind: 'tg', key: `tg:${it.chat ?? '?'}${it.topic ? `:${it.topic}` : ''}`, via: 'tg' }
  }
  if (it.source === 'mail') {                                     // the mailbox's events carry the thread of the lane that asked (the card)
    if (it.thread) return { thread: it.thread, via: 'card' }
    return { key_kind: 'item', key: it.id, via: 'own' }
  }
  if (it.thread) {
    const t = links.callThread(it.thread)
    if (t) return { thread: t, via: 'thread' }
    if (t === undefined) return { key_kind: 'peer_call', key: it.thread, via: 'thread' }   // the peer opened it: its id is the key
  }
  if (it.reply_to_id) {
    const t = links.replyThread(it.reply_to_id)
    if (t) return { thread: t, via: 'reply_to' }
  }
  if (it.kind === 'peer_mail' && it.btcc_msg_id) return { key_kind: 'mail', key: String(it.btcc_msg_id), via: 'msg_id' }   // a mail that starts a conversation names it
  return { key_kind: 'item', key: it.id, via: 'own' }
}

// ------------------------------------------------------------------ Onsen (fleet-core onsen6.py)
export type LastItem = { id: string; kind: string; at: string; preview: string }
/** one thread as Onsen gets it */
export type ThreadView = { thread: string; key_kind: KeyKind; key: string; title?: string | null; owner: string | null; state: ThreadState
  snooze_until?: string | null; last_item?: LastItem | null }
/** what Onsen was last told about a thread (n: the per-thread event counter of the dedupe) */
export type Sent = { owner: string | null; state: ThreadState; item: string | null; n: number }
export type OnsenThreadEvent = { thread: string; event: 'open' | 'assign' | 'transfer' | 'snooze' | 'close' | 'reopen' | 'item' | 'wait'; at: string; dedupe: string
  key_kind?: KeyKind; key?: string; title?: string; owner?: string | null; note?: string; snooze_until?: string; by?: string
  item?: { id: string; kind: string; at: string; text: string } }

const itemOf = (l: LastItem) => ({ id: l.id, kind: l.kind, at: l.at, text: l.preview })
/** the events that bring Onsen from `sent` to `v` (none when nothing it keeps changed), and the new `sent`. `epoch` makes the dedupe unique per agent
 *  across a lost state file (Onsen's dedupe is per agent). The order: back to open first, then the owner, then the item, then a close / wait / snooze. */
export function threadEvents(v: ThreadView, sent: Sent | undefined, o: { at: string; epoch: string; by?: string; note?: string }): { events: OnsenThreadEvent[]; sent: Sent } {
  const out: OnsenThreadEvent[] = []
  let n = sent?.n ?? 0
  const push = (event: OnsenThreadEvent['event'], extra: Partial<OnsenThreadEvent> = {}): void => {
    n += 1
    out.push({ thread: v.thread, event, at: o.at, dedupe: `${o.epoch}:${v.thread}:${n}`.slice(0, 200), ...(o.by ? { by: o.by } : {}), ...extra })
  }
  const item = v.last_item ?? null
  if (!sent) {
    // the first event carries the key (Onsen opens the thread on it); a thread already closed opens closed (the handshake's backfill)
    push(v.state === 'closed' ? 'close' : 'open', { key_kind: v.key_kind, key: v.key, ...(v.title ? { title: v.title } : {}), owner: v.owner, ...(item ? { item: itemOf(item) } : {}) })
    if (v.state === 'waiting_peer') push('wait')
    else if (v.state === 'snoozed' && v.snooze_until) push('snooze', { snooze_until: v.snooze_until })
    return { events: out, sent: { owner: v.owner, state: v.state, item: item?.id ?? null, n } }
  }
  const was = sent.state
  if (was === 'closed' && v.state !== 'closed') push('reopen')
  else if ((was === 'waiting_peer' || was === 'snoozed') && v.state === 'open') push('open')
  if (v.owner !== sent.owner) push(sent.owner && v.owner ? 'transfer' : 'assign', { owner: v.owner, ...(o.note ? { note: o.note } : {}) })
  if (item && item.id !== sent.item) push('item', { item: itemOf(item) })
  if (v.state !== was) {
    if (v.state === 'closed') push('close')
    else if (v.state === 'waiting_peer') push('wait')
    else if (v.state === 'snoozed' && v.snooze_until) push('snooze', { snooze_until: v.snooze_until })
  }
  return { events: out, sent: { owner: v.owner, state: v.state, item: item?.id ?? sent.item, n } }
}
/** an Onsen thread row (GET /threads) as `sent`: what Onsen holds now (n kept from the local count, so a dedupe never repeats) */
export function sentOf(row: { owner?: unknown; state?: unknown; last_item?: unknown }, n: number): Sent {
  const st = String(row.state ?? 'open')
  const li = row.last_item as { id?: unknown } | null | undefined
  return { owner: row.owner == null ? null : String(row.owner), state: (['open', 'waiting_peer', 'snoozed', 'closed'].includes(st) ? st : 'open') as ThreadState,
    item: li?.id != null ? String(li.id) : null, n }
}
/** a title: the first line of the first item, at most 80 characters (Onsen masks and cuts it again) */
export function titleOf(text: string): string {
  return Array.from(String(text ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? '').slice(0, 80).join('')
}
/** an item's preview: its text on one line, at most 80 characters */
export function previewOf(text: string): string {
  return Array.from(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, 80).join('')
}
