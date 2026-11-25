// Onsen (WO-139, Relay step 1): the Telegram client's half of "every Joey <-> agent message is one record in Onsen's own database".
//
// Onsen is served by Fleet Core (ONSEN_BASE, default https://core.kbro.ai/api/onsen). This module:
//   - records: recordMessage / recordEvent append one line to a local spool (<STATE_DIR>/onsen/spool.jsonl) and return. They never throw and never touch
//     the network, so a send to Telegram is never slowed or failed by Onsen.
//   - syncs: a loop (every 5 s, and right after an append, coalesced) posts the unsent lines IN ORDER (messages via /messages/batch, events via /events),
//     then moves a cursor (<STATE_DIR>/onsen/cursor.json, byte offset). Network error / 5xx / 401 / 403 / 408 / 429: kept, retried with backoff (cap 60 s).
//     A 4xx for one item: logged and moved to rejected.jsonl (never retried forever). `duplicate` counts as sent (the server dedupes by idem_key), so a
//     crash between the POST and the cursor write costs nothing. The spool IS the queue: a daemon restart resumes from the cursor.
//   - answers chat_history: GET /messages (or one message) with this agent's mesh credential; Onsen silent for ~4 s: the local spool answers, and says so.
//   - knows who sent each Telegram call: server.ts runs a send inside `withSender(<who>, …)` (AsyncLocalStorage); the Bot API wrappers read it.
//   - step 2 (WO-142): draws and lifts restart lines (Joey's /clear and its button: POST /restart-lines, /restart-lines/lift), directly with a short
//     timeout, else through the spool in order; keeps the lines it drew in <STATE_DIR>/onsen/lines.json so the spool's answer respects them too;
//     records edit_delivered (an edited message of Joey's reached the agent).
//   - step 3 (WO-143): delivery facts (k 'd': delivered / seen / turn_end of Joey's messages, POST /deliveries/batch) and the main's status (k 's', POST
//     /status/batch; 1.45.1: the registry's states and last_activity_at) go through the same spool, in order behind the messages they are about (onsen-status.ts decides them; server.ts wires them). A batch
//     refused as a whole (an Onsen without those routes) goes to rejected.jsonl: the messages behind it are never held.
//   - WO-147 (step 4a, onsen-wake.ts): every wake decision (one route record of the lanes router) as one row (k 'w', POST /wake/batch), through the same
//     spool and the same batch rules as the step 3 facts: written locally first, synced in order, a resent line keeps its idem_key (duplicate = sent).
//   - WO-145 (the half Joey sees, onsen-visible.ts): a send context may carry `redact` (a reply's page links with their one-time form keys → the links as the
//     agent wrote them): the record keeps the text WITHOUT the keys. A form answer's ack that Onsen did not take directly goes through the spool (k 'a',
//     POST /forms/ack). `observe` lets the daemon read every line it appends (the pinned status's local counts). `request`: one call with the credential.
// The credential (the agent's mesh credential, read from the agent-inbox daemon's state dir) is never logged, printed or written anywhere.

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import type { WakeItem } from './onsen-wake.ts'

// ------------------------------------------------------------------ records (the contract posted on WO-139)
export type OnsenAttachment = { name?: string; mime?: string; size?: number; file_id?: string }
export type OnsenItem = {
  idem_key: string; agent: string; client: 'telegram'; chat: string; direction: 'in' | 'out'; sender: string; body: string
  kind: 'text' | 'command' | 'voice' | 'photo' | 'document' | 'video' | 'sticker' | 'rich'
  sent_at: string; client_msg_id?: string; reply_to_client_msg_id?: string; thread?: string; forward_from?: string
  attachments?: OnsenAttachment[]; status: 'ok' | 'failed'; error?: string; backfilled?: false; meta?: Record<string, unknown>
}
export type OnsenEvent = {
  idem_key: string; agent: string; client: 'telegram'; chat: string; target_client_msg_id: string
  kind: 'edit' | 'reaction' | 'retract' | 'edit_delivered'; actor: string; body?: string; data?: Record<string, unknown>; at: string
}
/** step 2 (WO-142): Joey's /clear draws a line (POST /restart-lines); idem_key tg:<agent>:<chat>:line:<the /clear message id> */
export type RestartLineDraw = { agent: string; client: 'telegram'; chat: string; idem_key: string; at: string; by?: string; client_msg_id?: string }
/** step 2: his button lifts it (POST /restart-lines/lift). draw_idem (local only, never posted): a lift queued behind a draw still in the spool, resolved
 *  to that draw's line id when the spool reaches it */
export type RestartLineLift = { agent: string; client: 'telegram'; chat: string; at: string; by?: string; line_id?: number; draw_idem?: string }
/** a line this daemon drew, kept in lines.json (the spool's answer filters by it); id null: not yet in Onsen */
export type LocalLine = { chat: string; at: string; idem_key: string; client_msg_id?: string; by?: string; id: number | null; lifted_at: string | null
  lifted_by?: string | null; rejected?: boolean }
/** step 3 (WO-143): one fact about one of Joey's messages reaching the agent (POST /deliveries/batch). delivered: the daemon took it in (queued);
 *  seen: it entered a session (`by` main or the lane id); turn_end: the turn that saw it ended (`by` as for seen). One per (message, recipient, state). */
export type DeliveryState = 'delivered' | 'seen' | 'turn_end'
export type DeliveryFact = { idem_key: string; agent: string; client: 'telegram'; chat: string; client_msg_id: string; state: DeliveryState; at: string; by?: string
  detail?: Record<string, unknown> }
/** step 3: the main's status (POST /status/batch). 1.45.1: the state is Claude Code's own session registry's (onsen-status.ts statusOf); last_activity_at =
 *  the newest write to the main's transcript or its subagents' (null = none found) */
export type StatusState = 'offline' | 'idle' | 'busy' | 'waiting' | 'stuck'
export type StatusFact = { idem_key: string; agent: string; state: StatusState; at: string; detail?: Record<string, unknown>; last_activity_at?: string | null }
/** WO-145: the form answers this daemon queued for the main (POST /forms/ack), when Onsen did not take the ack directly */
export type FormAck = { ids: number[]; at: string }
export type SpoolLine = { k: 'm'; r: OnsenItem } | { k: 'e'; r: OnsenEvent } | { k: 'l'; r: RestartLineDraw } | { k: 'u'; r: RestartLineLift }
  | { k: 'd'; r: DeliveryFact } | { k: 's'; r: StatusFact } | { k: 'a'; r: FormAck } | { k: 'w'; r: WakeItem }
const SPOOL_KINDS = new Set(['m', 'e', 'l', 'u', 'd', 's', 'a', 'w'])
/** the batch route of each kind that is posted in runs (≤500 a batch) */
const BATCH_PATH: Record<string, string> = { d: '/deliveries/batch', s: '/status/batch', w: '/wake/batch' }

export const idemIn = (agent: string, chat: string, id: string | number): string => `tg:${agent}:${chat}:in:${id}`
export const idemOut = (agent: string, chat: string, id: string | number): string => `tg:${agent}:${chat}:out:${id}`
export const idemOutFailed = (agent: string, chat: string): string => `tg:${agent}:${chat}:out-failed:${randomUUID()}`
export const idemLine = (agent: string, chat: string, clearMsgId: string | number): string => `tg:${agent}:${chat}:line:${clearMsgId}`
/** step 2: the callback data of the button under the /clear reply (≤ 64 bytes): olift:<line id, or - while the draw is in the spool>:<the /clear message id> */
export const liftData = (lineId: number | null, clearMsgId: string | number): string => `olift:${lineId ?? '-'}:${clearMsgId}`
/** step 3 (WO-143): one fact per (message, state); the recipient is the first to report it (a second `seen` is a duplicate at Onsen: first wins) */
export const idemDelivery = (agent: string, chat: string, id: string | number, state: DeliveryState): string => `tg:${agent}:${chat}:dlv:${id}:${state}`
export const idemStatus = (agent: string, ms: number, state: StatusState): string => `tg:${agent}:st:${ms}:${state}`

// ------------------------------------------------------------------ who is sending (server.ts sets it around each send path)
export type SendCtx = { sender: string; part?: number; parts?: number; richAttempt?: boolean; skip?: boolean
  /** WO-145: [what Telegram got, what Onsen records] pairs applied to the recorded text, in order (a page link with its one-time key → the link without) */
  redact?: Array<[string, string]> }
const als = new AsyncLocalStorage<SendCtx>()
/** the author of a Telegram call made outside every named send path (server.ts records it all the same) */
export const DEFAULT_CTX: SendCtx = { sender: 'system:daemon' }
/** run `fn` with `sender` as the author of every Telegram call it makes; `extra` (WO-145): `redact` for the record */
export function withSender<T>(sender: string, fn: () => T, extra?: Pick<SendCtx, 'redact'>): T {
  return als.run(extra?.redact?.length ? { sender, redact: extra.redact } : { sender }, fn)
}
/** WO-145: the text as Onsen keeps it: every [sent, kept] pair of the send context applied */
export function redactText(s: string, redact?: Array<[string, string]>): string {
  if (!redact?.length) return s
  for (const [from, to] of redact) if (from) s = s.split(from).join(to)
  return s
}
/** `sender` unless a caller already named the author (a shared helper: its callers name themselves) */
export function withDefaultSender<T>(sender: string, fn: () => T): T { return als.getStore() ? fn() : als.run({ sender }, fn) }
/** the Telegram calls `fn` makes are not recorded (a stranger's pairing: not part of any conversation Onsen keeps) */
export function withoutRecord<T>(fn: () => T): T { return als.run({ sender: '', skip: true }, fn) }
/** inside a send: this call is part i of n of one text */
export function withPart<T>(part: number, parts: number, fn: () => T): T {
  const c = als.getStore()
  return c && parts > 1 ? als.run({ ...c, part, parts }, fn) : fn()
}
/** inside a send: a rich attempt that falls back to plain on failure (its failure is not a failed message: the plain one is the message) */
export function richAttempt<T>(fn: () => T): T {
  const c = als.getStore()
  return c ? als.run({ ...c, richAttempt: true }, fn) : fn()
}
export const sendCtx = (): SendCtx | undefined => als.getStore()

// ------------------------------------------------------------------ building records from Telegram objects
const str = (v: unknown): string | undefined => v == null || v === '' ? undefined : String(v)
const iso = (unixS: unknown): string => {
  const n = Number(unixS)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString()
}

/** the original author of a forwarded Telegram message, as one string (undefined: not a forward) */
export function forwardFrom(m: any): string | undefined {
  const o = m?.forward_origin
  if (o) {
    if (o.type === 'user' && o.sender_user) {
      const u = o.sender_user, name = [u.first_name, u.last_name].filter(Boolean).join(' ')
      return `tg:${u.id}${u.username ? ` @${u.username}` : ''}${name ? ` ${name}` : ''}`
    }
    if (o.type === 'hidden_user') return `hidden:${o.sender_user_name ?? ''}`
    if ((o.type === 'chat' || o.type === 'channel') && (o.sender_chat || o.chat)) {
      const c = o.sender_chat ?? o.chat
      return `chat:${c.id}${c.title ? ` ${c.title}` : ''}${o.author_signature ? ` (${o.author_signature})` : ''}`
    }
    return o.type ? String(o.type) : 'forwarded'
  }
  if (m?.forward_from) return `tg:${m.forward_from.id}${m.forward_from.username ? ` @${m.forward_from.username}` : ''}`
  if (m?.forward_sender_name) return `hidden:${m.forward_sender_name}`
  return undefined
}

/** the message's OWN file (never the replied-to message's) and the record kind it gives */
export function inboundShape(m: any): { kind: OnsenItem['kind']; attachments?: OnsenAttachment[] } {
  const a = (f: any, name?: string, mime?: string): OnsenAttachment[] =>
    [{ ...(name ? { name } : {}), ...(mime ? { mime } : {}), ...(f?.file_size != null ? { size: Number(f.file_size) } : {}), ...(f?.file_id ? { file_id: String(f.file_id) } : {}) }]
  if (m?.photo?.length) return { kind: 'photo', attachments: a(m.photo[m.photo.length - 1], undefined, 'image/jpeg') }
  if (m?.animation) return { kind: 'video', attachments: a(m.animation, m.animation.file_name, m.animation.mime_type) }
  if (m?.document) return { kind: 'document', attachments: a(m.document, m.document.file_name, m.document.mime_type) }
  if (m?.voice) return { kind: 'voice', attachments: a(m.voice, undefined, m.voice.mime_type) }
  if (m?.audio) return { kind: 'voice', attachments: a(m.audio, m.audio.file_name ?? m.audio.title, m.audio.mime_type) }
  if (m?.video) return { kind: 'video', attachments: a(m.video, m.video.file_name, m.video.mime_type) }
  if (m?.video_note) return { kind: 'video', attachments: a(m.video_note) }
  if (m?.sticker) return { kind: 'sticker', attachments: a(m.sticker, m.sticker.emoji) }
  if (m?.text == null && m?.caption == null && m?.rich_message) return { kind: 'rich' }
  return { kind: typeof m?.text === 'string' && m.text.startsWith('/') ? 'command' : 'text' }
}

/** one `in` item for a human's Telegram message. body: what they said (text / caption, entity-expanded; a voice note's transcript) */
export function inboundItem(agent: string, m: any, body: string): OnsenItem {
  const chat = String(m?.chat?.id ?? ''), id = m?.message_id
  const shape = inboundShape(m)
  const rt = m?.reply_to_message
  // a message typed in a topic replies to the topic's creation service message: that is not a reply of the human's
  const replyTo = rt && !rt.forum_topic_created ? str(rt.message_id) : undefined
  const thread = m?.message_thread_id != null && m?.is_topic_message !== false ? String(m.message_thread_id) : undefined
  const fwd = forwardFrom(m)
  const meta: Record<string, unknown> = {
    ...(m?.from?.username ? { user: m.from.username } : m?.from?.first_name ? { user: m.from.first_name } : {}),
    ...(m?.media_group_id ? { media_group_id: String(m.media_group_id) } : {}),
    ...(m?.forward_date || m?.forward_origin?.date ? { forward_date: iso(m.forward_origin?.date ?? m.forward_date) } : {}),
    ...(m?.chat?.type && m.chat.type !== 'private' ? { chat_type: m.chat.type, ...(m.chat.title ? { chat_title: m.chat.title } : {}) } : {}),
  }
  return {
    idem_key: idemIn(agent, chat, id), agent, client: 'telegram', chat, direction: 'in', sender: `tg:${m?.from?.id ?? '?'}`,
    body: String(body ?? ''), kind: shape.kind, sent_at: iso(m?.date), client_msg_id: str(id),
    ...(replyTo ? { reply_to_client_msg_id: replyTo } : {}), ...(thread ? { thread } : {}), ...(fwd ? { forward_from: fwd } : {}),
    ...(shape.attachments ? { attachments: shape.attachments } : {}), status: 'ok', backfilled: false,
    ...(Object.keys(meta).length ? { meta } : {}),
  }
}

/** an allowlisted person edited a message they sent (Telegram edited_message): an edit event, the new full text. Keyed by edit_date: a re-delivered update is
 *  the same event. */
export function inboundEdit(agent: string, m: any): OnsenEvent {
  const chat = String(m?.chat?.id ?? ''), id = String(m?.message_id ?? '')
  const body = String(m?.text ?? m?.caption ?? '')
  return { idem_key: `tg:${agent}:${chat}:edit:${id}:${m?.edit_date ?? Math.floor(Date.now() / 1000)}`, agent, client: 'telegram', chat, target_client_msg_id: id, kind: 'edit',
    actor: `tg:${m?.from?.id ?? '?'}`, body, at: iso(m?.edit_date) }
}

const OUT_KIND: Record<string, OnsenItem['kind']> = {
  sendMessage: 'text', sendRichMessage: 'rich', sendPhoto: 'photo', sendDocument: 'document', sendVideo: 'video', sendAnimation: 'video',
  sendVoice: 'voice', sendAudio: 'voice', sendSticker: 'sticker',
}
/** the methods recorded: a message out, or an event on one */
export const RECORDED_METHODS = new Set([...Object.keys(OUT_KIND), 'editMessageText', 'setMessageReaction', 'deleteMessage'])

const fileOf = (r: any, method: string): any => {
  if (!r || typeof r !== 'object') return undefined
  if (method === 'sendPhoto') return Array.isArray(r.photo) ? r.photo[r.photo.length - 1] : undefined
  return r.document ?? r.video ?? r.animation ?? r.voice ?? r.audio ?? r.sticker
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300)

/** the record of one Bot API call the daemon made (result: its answer; err: why it failed), or null (a method not recorded, a failed event) */
export function outboundRecord(agent: string, ctx: SendCtx, method: string, payload: any, result: any, err?: unknown): SpoolLine | null {
  if (!RECORDED_METHODS.has(method) || !payload || payload.chat_id == null) return null
  const chat = String(payload.chat_id), at = new Date().toISOString()
  if (method === 'editMessageText' || method === 'setMessageReaction' || method === 'deleteMessage') {
    if (err !== undefined || payload.message_id == null) return null           // an event is a change that happened: a failed edit changed nothing
    const target = String(payload.message_id)
    const kind: OnsenEvent['kind'] = method === 'editMessageText' ? 'edit' : method === 'setMessageReaction' ? 'reaction' : 'retract'
    const body = method === 'editMessageText' ? redactText(String(payload.text ?? payload.rich_message?.markdown ?? ''), ctx.redact) : undefined
    const emoji = method === 'setMessageReaction' ? (Array.isArray(payload.reaction) && payload.reaction[0] ? payload.reaction[0].emoji ?? payload.reaction[0].custom_emoji_id ?? null : null) : undefined
    return { k: 'e', r: {
      idem_key: `tg:${agent}:${chat}:${kind}:${target}:${randomUUID()}`, agent, client: 'telegram', chat, target_client_msg_id: target, kind, actor: ctx.sender,
      ...(body !== undefined ? { body } : {}), ...(method === 'setMessageReaction' ? { data: { emoji } } : {}), at,
    } }
  }
  const kind = OUT_KIND[method]!
  const body = redactText(String(method === 'sendRichMessage' ? payload.rich_message?.markdown ?? '' : method === 'sendMessage' ? payload.text ?? '' : payload.caption ?? ''), ctx.redact)
  const replyTo = payload.reply_parameters?.message_id ?? payload.reply_to_message_id
  const f = err === undefined ? fileOf(result, method) : undefined
  const fname = f?.file_name ?? payload?.[method.slice(4).toLowerCase()]?.filename
  const attachments: OnsenAttachment[] | undefined = kind === 'text' || kind === 'rich' ? undefined
    : [{ ...(fname ? { name: String(fname) } : {}), ...(f?.mime_type ? { mime: f.mime_type } : {}), ...(f?.file_size != null ? { size: Number(f.file_size) } : {}), ...(f?.file_id ? { file_id: f.file_id } : {}) }]
  const meta: Record<string, unknown> = {
    ...(ctx.parts && ctx.parts > 1 ? { part: ctx.part, parts: ctx.parts } : {}),
    ...(payload.disable_notification ? { silent: true } : {}),
    ...(payload.reply_markup ? { buttons: true } : {}),
    ...(method === 'sendMessage' && payload.parse_mode ? { parse_mode: payload.parse_mode } : {}),
  }
  const id = err === undefined ? result?.message_id : undefined
  return { k: 'm', r: {
    idem_key: id != null ? idemOut(agent, chat, id) : idemOutFailed(agent, chat), agent, client: 'telegram', chat, direction: 'out', sender: ctx.sender, body, kind,
    sent_at: result?.date ? iso(result.date) : at, ...(id != null ? { client_msg_id: String(id) } : {}),
    ...(replyTo != null ? { reply_to_client_msg_id: String(replyTo) } : {}),
    ...(payload.message_thread_id != null ? { thread: String(payload.message_thread_id) } : {}),
    ...(attachments && Object.keys(attachments[0]).length ? { attachments } : {}),
    status: id != null ? 'ok' : 'failed', ...(id == null ? { error: err !== undefined ? errText(err) : 'Telegram answered without a message_id' } : {}),
    backfilled: false, ...(Object.keys(meta).length ? { meta } : {}),
  } }
}

// ------------------------------------------------------------------ the client
type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export type OnsenConfig = {
  /** the spool dir (<STATE_DIR>/onsen) */
  dir: string
  base: string
  agent: string
  /** false (ONSEN_RECORD=0): nothing is recorded or synced; chat_history still asks Onsen */
  record: boolean
  /** the agent's mesh credential, read fresh each time (null: none) */
  credential: () => string | null
  /** where the credential is expected (for the one warning an hour; never its content) */
  credentialWhere?: string
  log: Log
  fetch?: typeof fetch
  intervalMs?: number
  maxBackoffMs?: number
  rotateBytes?: number
  queryTimeoutMs?: number
  postTimeoutMs?: number
  /** the Telegram id of Joey's DM chat (chat_history's default chat; `tg:<it>` reads as Joey), or '' */
  joeyChat?: () => string
}
export type HistoryArgs = { limit?: unknown; since?: unknown; until?: unknown; q?: unknown; id?: unknown; chat?: unknown }
/** WO-144: a caller's own bounds on one query (the lane opening's block): how long Onsen gets before the spool answers, and where a body is cut */
/** `inbound` (WO-148 lab): a caller's set; queryHistory adds the key (`tg:<id>`, else `#<Onsen id>`) of every listed message that came in from a person
 *  (direction in, not a system:* sender), Onsen's answer and the spool's alike, so the caller can tell the DM human's lines by direction whatever name
 *  Onsen gives that member (joey, joey-test, rosie). The text is unchanged */
export type HistoryOpts = { timeoutMs?: number; cut?: number; inbound?: Set<string> }
/** WO-148 lab: the listed rows that came in from a person, into `set` (see HistoryOpts.inbound) */
export function noteInbound(rows: any[], set: Set<string> | undefined): void {
  if (!set) return
  for (const m of rows) {
    if (String(m?.direction ?? '') !== 'in' || /^system(:|$)/.test(String(m?.sender ?? ''))) continue
    const tg = tgIdOf(m)
    if (tg) set.add(`tg:${tg}`); else if (m?.id != null) set.add(`#${m.id}`)
  }
}

const RETRYABLE_4XX = new Set([401, 403, 408, 425, 429])
const HOUR = 3600_000
const READ_WINDOW = 1 << 20          // bytes read from the cursor per pass

export class OnsenClient {
  readonly spool: string
  readonly spoolOld: string
  readonly cursorFile: string
  readonly rejected: string
  readonly linesFile: string
  private running = false
  private again = false
  private kickTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private backoffMs = 0
  private nextTryAt = 0
  private credWarnAt = 0
  private appendWarnAt = 0
  private authWarnAt = 0
  private observers: Array<(line: SpoolLine) => void> = []
  readonly stats = { recorded: 0, posted: 0, duplicates: 0, rejected: 0, last_ok_at: null as string | null, last_error: null as string | null,
    lines_drawn: 0, lines_lifted: 0, lines_spooled: 0, edits_delivered: 0, deliveries_recorded: 0, status_recorded: 0, form_acks_spooled: 0, wake_recorded: 0 }

  constructor(readonly cfg: OnsenConfig) {
    this.spool = join(cfg.dir, 'spool.jsonl')
    this.spoolOld = join(cfg.dir, 'spool.1.jsonl')
    this.cursorFile = join(cfg.dir, 'cursor.json')
    this.rejected = join(cfg.dir, 'rejected.jsonl')
    this.linesFile = join(cfg.dir, 'lines.json')
  }
  private get f(): typeof fetch { return this.cfg.fetch ?? fetch }

  // ---------------------------------------------------------------- recording (the send path: never throws, never waits)
  recordMessage(item: OnsenItem): void { this.append({ k: 'm', r: item }) }
  recordEvent(ev: OnsenEvent): void { this.append({ k: 'e', r: ev }) }
  recordLine(line: SpoolLine | null): void { if (line) this.append(line) }
  /** step 3 (WO-143): a delivery fact / a status of the main, through the same spool (in order behind the message they are about) */
  recordDelivery(f: DeliveryFact): void { if (this.append({ k: 'd', r: f })) this.stats.deliveries_recorded++ }
  recordStatus(f: StatusFact): void { if (this.append({ k: 's', r: f })) this.stats.status_recorded++ }
  /** WO-147: one wake decision (onsen-wake.ts wakeItem), through the same spool; false = not spooled (recording off, or the append failed) */
  recordWake(w: WakeItem): boolean { const ok = this.append({ k: 'w', r: w }); if (ok) this.stats.wake_recorded++; return ok }
  /** WO-145: form answers queued for the main whose ack Onsen did not take directly: POST /forms/ack when the spool reaches it. false = not spooled */
  recordFormAck(ids: number[]): boolean {
    const ok = ids.length > 0 && this.append({ k: 'a', r: { ids, at: new Date().toISOString() } })
    if (ok) this.stats.form_acks_spooled++
    return ok
  }
  /** WO-145: `fn` reads every line appended from now on (after it is in the spool; it never changes or holds the line) */
  observe(fn: (line: SpoolLine) => void): void { this.observers.push(fn) }
  private append(line: SpoolLine): boolean {
    if (!this.cfg.record) return false
    try {
      mkdirSync(this.cfg.dir, { recursive: true, mode: 0o700 })
      appendFileSync(this.spool, JSON.stringify(line) + '\n', { mode: 0o600 })
      this.stats.recorded++
      this.kick()
      for (const o of this.observers) { try { o(line) } catch {} }
      return true
    } catch (e) {
      if (Date.now() - this.appendWarnAt > HOUR) { this.appendWarnAt = Date.now(); this.cfg.log('warn', `onsen: could not append to the spool (${errText(e)}); this record is lost`) }
      return false
    }
  }

  // ---------------------------------------------------------------- sync loop
  start(): void {
    if (!this.cfg.record || this.interval) return
    this.interval = setInterval(() => { void this.syncNow() }, this.cfg.intervalMs ?? 5000)
    ;(this.interval as any).unref?.()
    this.kick()
  }
  stop(): void {
    if (this.interval) clearInterval(this.interval)
    if (this.kickTimer) clearTimeout(this.kickTimer)
    this.interval = null; this.kickTimer = null
  }
  /** right after an append: one pass soon (coalesced; never during a backoff) */
  private kick(): void {
    if (!this.interval || this.kickTimer) return
    this.kickTimer = setTimeout(() => { this.kickTimer = null; void this.syncNow() }, 50)
    ;(this.kickTimer as any).unref?.()
  }
  /** one sync pass now unless one is running (then another follows it) or a backoff is pending; `force` ignores the backoff (tests) */
  async syncNow(force = false): Promise<void> {
    if (this.running) { this.again = true; return }
    if (!force && Date.now() < this.nextTryAt) return
    this.running = true
    try {
      do { this.again = false; await this.pass() } while (this.again && Date.now() >= this.nextTryAt)
    } catch (e) {
      this.fail(`sync error: ${errText(e)}`)
    } finally { this.running = false }
  }
  /** what is still to be sent (bytes after the cursor) */
  pendingBytes(): number {
    try { return Math.max(0, statSync(this.spool).size - this.readCursor()) } catch { return 0 }
  }
  private readCursor(): number {
    try { const n = Number(JSON.parse(readFileSync(this.cursorFile, 'utf8')).offset); return Number.isFinite(n) && n >= 0 ? n : 0 } catch { return 0 }
  }
  private writeCursor(offset: number): void {
    const tmp = `${this.cursorFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ offset, at: new Date().toISOString() }), { mode: 0o600 })
    renameSync(tmp, this.cursorFile)
  }
  private fail(why: string): void {
    this.backoffMs = Math.min(Math.max(1000, this.backoffMs * 2), this.cfg.maxBackoffMs ?? 60_000)
    this.nextTryAt = Date.now() + this.backoffMs
    if (this.stats.last_error !== why) this.cfg.log('warn', `onsen: ${why}; kept in the spool, next try in ${Math.round(this.backoffMs / 1000)} s`)
    this.stats.last_error = why
  }
  private ok(): void { this.backoffMs = 0; this.nextTryAt = 0; this.stats.last_ok_at = new Date().toISOString(); this.stats.last_error = null }
  private reject(line: unknown, why: string): void {
    this.stats.rejected++
    try { appendFileSync(this.rejected, JSON.stringify({ at: new Date().toISOString(), why, line }) + '\n', { mode: 0o600 }) } catch {}
    const key = (line as any)?.r?.idem_key ?? '?'
    this.cfg.log('warn', `onsen: rejected ${key} (${why}); moved to rejected.jsonl, not retried`)
  }
  /** step 3: a whole batch refused: each line to rejected.jsonl, one log line for the lot */
  private rejectRun(lines: unknown[], why: string): void {
    this.stats.rejected += lines.length
    try { appendFileSync(this.rejected, lines.map(line => JSON.stringify({ at: new Date().toISOString(), why, line })).join('\n') + '\n', { mode: 0o600 }) } catch {}
    this.cfg.log('warn', `onsen: rejected ${lines.length} line(s) (${why}); moved to rejected.jsonl, not retried`)
  }
  private headers(cred: string, extra: Record<string, string> = {}): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${cred}`, 'User-Agent': `onsen-telegram/${this.cfg.agent}`, ...extra }
  }
  /** WO-145: one call to Onsen with this agent's credential (null: no credential); throws on a network error or the timeout */
  async request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; json: any } | null> {
    const cred = this.cfg.credential()
    if (!cred) return null
    if (method === 'POST') return this.post(path, body ?? {}, cred, timeoutMs)
    const r = await this.f(`${this.cfg.base}${path}`, { headers: this.headers(cred), signal: AbortSignal.timeout(timeoutMs) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
  private async post(path: string, body: unknown, cred: string, timeoutMs?: number): Promise<{ status: number; json: any }> {
    const r = await this.f(`${this.cfg.base}${path}`, { method: 'POST', headers: this.headers(cred), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs ?? this.cfg.postTimeoutMs ?? 15_000) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }

  /** the lines after the cursor (complete lines only), each with the offset just past it */
  private unsent(): Array<{ line: SpoolLine | null; raw: string; end: number }> {
    let fd: number | null = null
    const start = this.readCursor()
    try {
      const size = statSync(this.spool).size
      if (size <= start) return []
      fd = openSync(this.spool, 'r')
      const len = Math.min(size - start, READ_WINDOW)
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, start)
      const out: Array<{ line: SpoolLine | null; raw: string; end: number }> = []
      let from = 0
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 0x0a) continue
        const raw = buf.subarray(from, i).toString('utf8')
        let line: SpoolLine | null = null
        try { const j = JSON.parse(raw); if (SPOOL_KINDS.has(j.k) && j.r) line = j } catch {}
        out.push({ line, raw, end: start + i + 1 })
        from = i + 1
      }
      if (!out.length && len === READ_WINDOW) {
        // one line longer than the window: unreadable as a record; skip it so the queue moves
        out.push({ line: null, raw: '(a line over 1 MB)', end: start + len })
      }
      return out
    } catch { return [] }
    finally { if (fd != null) try { closeSync(fd) } catch {} }
  }

  private async pass(): Promise<void> {
    const todo = this.unsent()
    if (!todo.length) { this.rotateIfDrained(); return }
    const cred = this.cfg.credential()
    if (!cred) {
      if (Date.now() - this.credWarnAt > HOUR) {
        this.credWarnAt = Date.now()
        this.cfg.log('warn', `onsen: no mesh credential${this.cfg.credentialWhere ? ` at ${this.cfg.credentialWhere}` : ''}; ${this.pendingBytes()} bytes of records wait in the spool`)
      }
      this.nextTryAt = Date.now() + 30_000
      return
    }
    let i = 0
    while (i < todo.length) {
      const t = todo[i]!
      if (!t.line) { this.reject(t.raw.slice(0, 2000), 'unreadable spool line'); this.writeCursor(t.end); i++; continue }
      if (t.line.k === 'l' || t.line.k === 'u') {
        // step 2 (WO-142): a restart line drawn or lifted while Onsen did not answer, in its place in the order
        const done = await this.syncLine(t.line, cred)
        if (done !== true) return this.failStatus(done, t.line.k === 'l' ? '/restart-lines' : '/restart-lines/lift')
        this.writeCursor(t.end); this.ok(); i++
        continue
      }
      if (t.line.k === 'd' || t.line.k === 's' || t.line.k === 'w') {
        // step 3 (WO-143): a run of delivery facts (or of status lines; WO-147: of wake decisions): one batch (≤500), in its place in the order
        const k = t.line.k, path = BATCH_PATH[k]!
        const run: Array<{ line: SpoolLine; end: number }> = []
        while (i < todo.length && run.length < 500 && todo[i]!.line?.k === k) { run.push({ line: todo[i]!.line!, end: todo[i]!.end }); i++ }
        const r = await this.post(path, { items: run.map(x => x.line.r) }, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (r.status >= 200 && r.status < 300 && Array.isArray(r.json?.results) && r.json.results.length === run.length) {
          r.json.results.forEach((res: any, n: number) => {
            if (res && res.error == null && res.id != null) { if (res.duplicate) this.stats.duplicates++; else this.stats.posted++ }
            else this.reject(run[n]!.line, `item refused: ${String(res?.error ?? 'no id in the answer').slice(0, 200)}${res?.status != null ? ` (${res.status})` : ''}`)
          })
          this.writeCursor(run[run.length - 1]!.end); this.ok()
          continue
        }
        if (r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status)) {
          // refused as a whole (no single-item route for these): every line to rejected.jsonl, one log line, so the messages behind them are not held
          this.rejectRun(run.map(x => x.line), `${path} answered HTTP ${r.status} ${String(r.json?.error ?? JSON.stringify(r.json?.detail ?? '')).slice(0, 200)}`)
          this.writeCursor(run[run.length - 1]!.end); this.ok()
          continue
        }
        return this.failStatus(r, path)
      }
      if (t.line.k === 'a') {
        // WO-145: a form answers' ack (the answers are already queued for the main; unacked, Onsen would hand them out again)
        const r = await this.post('/forms/ack', { ids: t.line.r.ids }, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (r.status >= 200 && r.status < 300) this.stats.posted++
        else if (r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status)) this.reject(t.line, `HTTP ${r.status} ${String(r.json?.error ?? r.json?.detail ?? '').slice(0, 200)}`)
        else return this.failStatus(r, '/forms/ack')
        this.writeCursor(t.end); this.ok(); i++
        continue
      }
      if (t.line.k === 'e') {
        const r = await this.post('/events', t.line.r, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (r.status >= 200 && r.status < 300) { if (r.json?.duplicate) this.stats.duplicates++; else this.stats.posted++ }
        else if (r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status)) this.reject(t.line, `HTTP ${r.status} ${String(r.json?.error ?? r.json?.detail ?? '').slice(0, 200)}`)
        else return this.failStatus(r, '/events')
        this.writeCursor(t.end); this.ok(); i++
        continue
      }
      // a run of messages: one batch (≤500)
      const run: Array<{ line: SpoolLine; end: number }> = []
      while (i < todo.length && run.length < 500 && todo[i]!.line?.k === 'm') { run.push({ line: todo[i]!.line!, end: todo[i]!.end }); i++ }
      const r = await this.post('/messages/batch', { items: run.map(x => x.line.r) }, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
      if (r.status >= 200 && r.status < 300 && Array.isArray(r.json?.results) && r.json.results.length === run.length) {
        r.json.results.forEach((res: any, k: number) => {
          if (res && res.error == null && res.id != null) { if (res.duplicate) this.stats.duplicates++; else this.stats.posted++ }
          else this.reject(run[k]!.line, `item refused: ${String(res?.error ?? 'no id in the answer').slice(0, 200)}`)
        })
        this.writeCursor(run[run.length - 1]!.end); this.ok()
        continue
      }
      if (r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status)) {
        // the batch as a whole was refused: one by one, so one bad item does not hold the others
        for (const x of run) {
          const s = await this.post('/messages', x.line.r, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
          if (s.status >= 200 && s.status < 300) { if (s.json?.duplicate) this.stats.duplicates++; else this.stats.posted++ }
          else if (s.status >= 400 && s.status < 500 && !RETRYABLE_4XX.has(s.status)) this.reject(x.line, `HTTP ${s.status} ${String(s.json?.error ?? s.json?.detail ?? '').slice(0, 200)}`)
          else return this.failStatus(s, '/messages')
          this.writeCursor(x.end); this.ok()
        }
        continue
      }
      return this.failStatus(r, '/messages/batch')
    }
    this.again = true          // more may be past the read window, or appended meanwhile
  }
  private failStatus(r: { status: number; json: any }, path: string): void {
    if (r.status === 401 || r.status === 403) {
      if (Date.now() - this.authWarnAt > HOUR) { this.authWarnAt = Date.now(); this.cfg.log('warn', `onsen: ${path} answered ${r.status}: the credential was not accepted`) }
    }
    this.fail(r.status ? `${path} answered HTTP ${r.status}` : `${path} unreachable (${String(r.json?.error ?? '').slice(0, 120)})`)
  }
  /** all sent and the spool is big: it becomes spool.1.jsonl (kept for chat_history's local answer), a new one starts. Synchronous: no append can interleave. */
  private rotateIfDrained(): void {
    try {
      const size = statSync(this.spool).size
      if (size < (this.cfg.rotateBytes ?? 4 << 20) || this.readCursor() < size) return
      renameSync(this.spool, this.spoolOld)
      this.writeCursor(0)
    } catch {}
  }

  health(): Record<string, unknown> {
    return { record: this.cfg.record, base: this.cfg.base, pending_bytes: this.pendingBytes(), backoff_s: Math.round(this.backoffMs / 1000), ...this.stats,
      active_lines: this.readLines().filter(l => !l.lifted_at && !l.rejected).length }
  }

  // ---------------------------------------------------------------- restart lines (step 2, WO-142)
  /** the lines this daemon drew (lines.json), oldest first */
  readLines(): LocalLine[] {
    try { const j = JSON.parse(readFileSync(this.linesFile, 'utf8')); return Array.isArray(j?.lines) ? j.lines : [] } catch { return [] }
  }
  private writeLines(lines: LocalLine[]): void {
    try {
      mkdirSync(this.cfg.dir, { recursive: true, mode: 0o700 })
      const tmp = `${this.linesFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ lines: lines.slice(-200) }), { mode: 0o600 })
      renameSync(tmp, this.linesFile)
    } catch (e) { this.cfg.log('warn', `onsen: could not write lines.json (${errText(e)})`) }
  }
  private updateLine(idem: string, f: (l: LocalLine) => void): LocalLine | undefined {
    const all = this.readLines(), l = all.find(x => x.idem_key === idem)
    if (l) { f(l); this.writeLines(all) }
    return l
  }
  /** the active line of a chat as this daemon knows it: its newest drawn, unlifted, not refused line; null = none */
  activeLine(chat: string): LocalLine | null {
    let best: LocalLine | null = null
    for (const l of this.readLines()) if (l.chat === chat && !l.lifted_at && !l.rejected && (!best || Date.parse(l.at) >= Date.parse(best.at))) best = l
    return best
  }

  /** Joey's /clear (message `clientMsgId` in `chat`, by `tg:<id>`): draw the line now. Directly with a short timeout; Onsen silent or refusing: into
   *  the spool (synced in order; the idem_key keeps it single). Recording off: null (nothing is drawn). Never throws. */
  async drawLine(o: { chat: string; clientMsgId: string | number; by: string; at?: string; timeoutMs?: number }): Promise<{ id: number | null; spooled: boolean; idem_key: string } | null> {
    if (!this.cfg.record) return null
    const idem_key = idemLine(this.cfg.agent, o.chat, o.clientMsgId)
    const body: RestartLineDraw = { agent: this.cfg.agent, client: 'telegram', chat: o.chat, idem_key, at: o.at ?? new Date().toISOString(), by: o.by, client_msg_id: String(o.clientMsgId) }
    // first locally: the spool's answer respects the line at once, whatever Onsen does
    const all = this.readLines().filter(x => x.idem_key !== idem_key)
    all.push({ chat: o.chat, at: body.at, idem_key, client_msg_id: body.client_msg_id, by: o.by, id: null, lifted_at: null })
    this.writeLines(all)
    let why = ''
    const cred = this.cfg.credential()
    if (!cred) why = 'no mesh credential'
    else {
      try {
        const r = await this.post('/restart-lines', body, cred, o.timeoutMs ?? 2500)
        if (r.status >= 200 && r.status < 300 && r.json?.id != null) {
          const id = Number(r.json.id)
          this.updateLine(idem_key, l => { l.id = id })
          this.stats.lines_drawn++
          return { id, spooled: false, idem_key }
        }
        why = `HTTP ${r.status}`
      } catch (e) { why = errText(e).slice(0, 120) }
    }
    this.append({ k: 'l', r: body })
    this.stats.lines_spooled++
    this.cfg.log('warn', `onsen: restart line in chat ${o.chat} not drawn directly (${why}); in the spool, drawn when Onsen answers`)
    return { id: null, spooled: true, idem_key }
  }

  /** Joey's button: lift line `lineId` (else the line his /clear `clientMsgId` drew, else the newest of the chat). Locally at once; Onsen directly, or
   *  through the spool behind a draw that is still there. nothing: there was no line to lift. Never throws. */
  async liftLine(o: { chat: string; lineId?: number | null; clientMsgId?: string | number | null; by: string; timeoutMs?: number }): Promise<{ lifted: boolean; spooled: boolean; nothing: boolean }> {
    const at = new Date().toISOString()
    const all = this.readLines()
    const idem = o.clientMsgId != null && o.clientMsgId !== '' ? idemLine(this.cfg.agent, o.chat, o.clientMsgId) : undefined
    let local = (o.lineId != null ? all.find(x => x.id === o.lineId && x.chat === o.chat) : undefined) ?? (idem ? all.find(x => x.idem_key === idem) : undefined)
    if (!local && o.lineId == null && !idem) local = all.filter(x => x.chat === o.chat && !x.lifted_at && !x.rejected).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
    if (local?.rejected) return { lifted: false, spooled: false, nothing: true }            // Onsen refused that draw: there is no line
    if (local) { local.lifted_at = at; local.lifted_by = o.by; this.writeLines(all) }
    const lineId = o.lineId ?? local?.id ?? null
    const body: RestartLineLift = { agent: this.cfg.agent, client: 'telegram', chat: o.chat, at, by: o.by, ...(lineId != null ? { line_id: lineId } : {}) }
    // its draw is still in the spool: the lift goes behind it, in order (resolved to the draw's id when the spool reaches it)
    if (lineId == null && local && this.cfg.record) {
      this.append({ k: 'u', r: { ...body, draw_idem: local.idem_key } })
      this.stats.lines_spooled++
      return { lifted: true, spooled: true, nothing: false }
    }
    let why = ''
    const cred = this.cfg.credential()
    if (!cred) why = 'no mesh credential'
    else {
      try {
        const r = await this.post('/restart-lines/lift', body, cred, o.timeoutMs ?? 2500)
        if (r.status >= 200 && r.status < 300) { this.stats.lines_lifted++; return { lifted: true, spooled: false, nothing: !!r.json?.duplicate } }
        if (r.status === 404) return { lifted: false, spooled: false, nothing: true }
        why = `HTTP ${r.status}`
      } catch (e) { why = errText(e).slice(0, 120) }
    }
    if (!this.cfg.record) { this.cfg.log('warn', `onsen: restart line lift in chat ${o.chat} failed (${why}); recording is off, so it is not queued`); return { lifted: false, spooled: false, nothing: false } }
    this.append({ k: 'u', r: body })
    this.stats.lines_spooled++
    this.cfg.log('warn', `onsen: restart line lift in chat ${o.chat} not sent directly (${why}); in the spool`)
    return { lifted: true, spooled: true, nothing: false }
  }

  /** the sync loop's half of a spooled draw / lift: true = done (or refused for good: moved to rejected.jsonl); else the answer to back off on */
  private async syncLine(line: { k: 'l'; r: RestartLineDraw } | { k: 'u'; r: RestartLineLift }, cred: string): Promise<true | { status: number; json: any }> {
    const fail = (e: unknown) => ({ status: 0, json: { error: errText(e) } })
    if (line.k === 'l') {
      const r = await this.post('/restart-lines', line.r, cred).catch(fail)
      if (r.status >= 200 && r.status < 300) {
        if (r.json?.id != null) this.updateLine(line.r.idem_key, l => { l.id = Number(r.json.id) })
        if (r.json?.duplicate) this.stats.duplicates++; else { this.stats.posted++; this.stats.lines_drawn++ }
        return true
      }
      if (r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status)) {
        this.reject(line, `HTTP ${r.status} ${String(r.json?.error ?? JSON.stringify(r.json?.detail ?? '')).slice(0, 200)}`)
        this.updateLine(line.r.idem_key, l => { l.rejected = true })
        return true
      }
      return r
    }
    const { draw_idem, ...body } = line.r
    if (body.line_id == null && draw_idem) {
      const d = this.readLines().find(x => x.idem_key === draw_idem)
      if (d?.rejected) { this.cfg.log('info', `onsen: lift of ${draw_idem} skipped: its draw was refused`); return true }
      if (d?.id != null) body.line_id = d.id
    }
    const r = await this.post('/restart-lines/lift', body, cred).catch(fail)
    if (r.status >= 200 && r.status < 300) { this.stats.posted++; this.stats.lines_lifted++; return true }
    if (r.status === 404) { this.cfg.log('info', `onsen: lift in chat ${body.chat}: no line to lift`); return true }
    if (r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status)) { this.reject(line, `HTTP ${r.status}`); return true }
    return r
  }

  /** step 2 (WO-142): Joey's edit of message `target` reached the agent (a new inbound, or the queued original's text replaced) */
  recordEditDelivered(chat: string, target: string | number, editDate: string | number, replacedInQueue: boolean): void {
    this.stats.edits_delivered++
    this.recordEvent({ idem_key: `tg:${this.cfg.agent}:${chat}:edit_delivered:${target}:${editDate}`, agent: this.cfg.agent, client: 'telegram', chat,
      target_client_msg_id: String(target), kind: 'edit_delivered', actor: 'system:daemon', data: { replaced_in_queue: replacedInQueue }, at: new Date().toISOString() })
  }
  /** the `in` item this daemon recorded for Telegram message `id` in `chat` (its spool and the previous generation), or null */
  findInbound(chat: string, id: string | number): OnsenItem | null {
    const want = String(id)
    let hit: OnsenItem | null = null
    for (const p of [this.spoolOld, this.spool]) {
      if (!existsSync(p)) continue
      try {
        for (const raw of readFileSync(p, 'utf8').split('\n')) {
          if (!raw || !raw.includes(`"client_msg_id":"${want}"`)) continue
          try { const l = JSON.parse(raw); if (l.k === 'm' && l.r?.direction === 'in' && l.r.chat === chat && l.r.client_msg_id === want) hit = l.r } catch {}
        }
      } catch {}
    }
    return hit
  }

  // ---------------------------------------------------------------- chat_history
  /** via: who looks it up, for Onsen's lookup counts (tool = the agent's chat_history; hook = a hook putting history back, Onsen step 2) */
  async queryHistory(a: HistoryArgs, via: 'tool' | 'hook' = 'tool', o: HistoryOpts = {}): Promise<string> {
    const tmo = o.timeoutMs ?? this.cfg.queryTimeoutMs ?? 4000, cut = o.cut ?? CUT
    const limit = Math.max(1, Math.min(200, Math.floor(Number(a.limit ?? 20)) || 20))
    let since: string | undefined, until: string | undefined
    try { since = parseWhen(a.since); until = parseWhen(a.until) } catch (e) { return errText(e) }
    const q = str(a.q)
    const joey = this.cfg.joeyChat?.() ?? ''
    const chat = str(a.chat) ?? (joey || undefined)
    const id = str(a.id)?.trim()
    const cred = this.cfg.credential()
    let why = ''
    if (!cred) why = '這個 agent 沒有 mesh credential'
    else {
      try {
        if (id) {
          const row = await this.fetchOne(id, chat, cred, via, tmo)
          if (row?.__behind) return behindLine(row.__behind)                     // step 2: before Joey's restart line (and nothing after it quotes it)
          if (row) return formatFull(row, joey)
          return `Onsen 裡找不到 ${id}${chat ? `（chat ${chat}）` : ''}。`
        }
        const p = new URLSearchParams({ agent: this.cfg.agent, limit: String(limit) })
        if (chat) p.set('chat', chat)
        if (since) p.set('since', since)
        if (until) p.set('until', until)
        if (q) p.set('q', q)
        const r = await this.get(`/messages?${p}`, cred, via, tmo)
        if (r.status === 200 && Array.isArray(r.json?.messages)) {
          const rows = r.json.messages as any[]
          noteInbound(rows, o.inbound)                                           // WO-148 lab: the DM human's lines, by direction
          // step 2 (WO-142): the agent's own read stops at Joey's restart line; one line at the top says so
          const rl = r.json.restart_line_applied && r.json.restart_line?.at ? `${restartHead(r.json.restart_line.at)}\n` : ''
          return rl + formatList(rows, typeof r.json.total === 'number' ? r.json.total : rows.length, joey, cut)
        }
        why = `Onsen 回 HTTP ${r.status}`
      } catch (e) {
        why = e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`) ? `Onsen ${Math.round(tmo / 1000)} 秒內沒回應` : `Onsen 連不上（${errText(e).slice(0, 80)}）`
      }
    }
    return this.localHistory({ limit, since, until, q, id, chat, cut, inbound: o.inbound }, why, joey)
  }
  private async get(path: string, cred: string, via: 'tool' | 'hook' = 'tool', timeoutMs = this.cfg.queryTimeoutMs ?? 4000): Promise<{ status: number; json: any }> {
    const r = await this.f(`${this.cfg.base}${path}`, { headers: this.headers(cred, { 'X-Onsen-Via': via }), signal: AbortSignal.timeout(timeoutMs) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
  /** one message in full: an Onsen id; `tg:<n>` (the Telegram alias in `chat`); a bare number: the Onsen id first, then the alias.
   *  step 2: `{ __behind: <the line's time> }` when Onsen answers 404 because the message is before Joey's restart line */
  private async fetchOne(id: string, chat: string | undefined, cred: string, via: 'tool' | 'hook' = 'tool', tmo?: number): Promise<any | null> {
    const tg = /^tg:(\d+)$/i.exec(id)
    const behind = (r: { status: number; json: any }): string | null => r.status === 404 && r.json?.detail?.restart_line ? String(r.json.detail.restart_line) : null
    let onsenBehind: string | null = null
    if (!tg) {
      const r = await this.get(`/messages/${encodeURIComponent(id)}`, cred, via, tmo)
      if (r.status === 200 && r.json && typeof r.json === 'object') return r.json.message ?? r.json
      if (r.status !== 404 && r.status !== 400) throw new Error(`HTTP ${r.status}`)
      onsenBehind = behind(r)
      if (!/^\d+$/.test(id)) return onsenBehind ? { __behind: onsenBehind } : null
    }
    if (!chat) return onsenBehind ? { __behind: onsenBehind } : null
    const msgId = tg ? tg[1]! : id
    const r = await this.get(`/alias/telegram/${encodeURIComponent(this.cfg.agent)}/${encodeURIComponent(chat)}/${msgId}`, cred, via, tmo)
    if (r.status === 404) { const b = behind(r) ?? onsenBehind; return b ? { __behind: b } : null }
    if (r.status !== 200 || !r.json) throw new Error(`HTTP ${r.status}`)
    const j = r.json.message ?? r.json
    if (j && (j.body != null || Array.isArray(j.events))) return j
    const oid = j?.id ?? j?.message_id
    if (oid == null) return null
    const full = await this.get(`/messages/${encodeURIComponent(String(oid))}`, cred, via, tmo)
    if (behind(full)) return { __behind: behind(full) }
    return full.status === 200 && full.json ? full.json.message ?? full.json : null
  }

  /** the local answer: this daemon's spool (and its previous generation), messages with their edits applied */
  private localHistory(o: { limit: number; since?: string; until?: string; q?: string; id?: string; chat?: string; cut?: number; inbound?: Set<string> }, why: string, joey: string): string {
    const lines: SpoolLine[] = []
    for (const p of [this.spoolOld, this.spool]) {
      if (!existsSync(p)) continue
      try { for (const raw of readFileSync(p, 'utf8').split('\n')) { if (!raw) continue; try { lines.push(JSON.parse(raw)) } catch {} } } catch {}
    }
    const msgs = new Map<string, any>()
    for (const l of lines) {
      if (l.k === 'm') {
        const m = l.r
        msgs.set(m.idem_key, { id: null, at: m.sent_at, direction: m.direction, sender: m.sender, kind: m.kind, body: m.body, client_msg_id: m.client_msg_id ?? null,
          reply_to_client_msg_id: m.reply_to_client_msg_id ?? null, status: m.status, chat: m.chat, edited: false, events: [] as any[] })
      }
    }
    const byTg = new Map<string, any>()
    for (const m of msgs.values()) if (m.client_msg_id) byTg.set(`${m.chat}:${m.client_msg_id}`, m)
    for (const l of lines) {
      if (l.k !== 'e') continue
      const m = byTg.get(`${l.r.chat}:${l.r.target_client_msg_id}`)
      if (!m) continue
      m.events.push({ kind: l.r.kind, actor: l.r.actor, body: l.r.body, data: l.r.data, at: l.r.at })
      if (l.r.kind === 'edit' && l.r.body != null) { m.body = l.r.body; m.edited = true }
    }
    const head = `（${why || 'Onsen 沒回應'}：以下是這個常駐程式本機暫存的紀錄，只有它自己記下的，可能不完整）`
    // step 2 (WO-142): the restart lines this daemon drew (lines.json) apply here as Onsen applies them: only what is after the active line of each chat;
    // a message before it is shown by id only when a message after the line quotes it
    const lineCache = new Map<string, number>()
    const lineAt = (chat: string): number | null => {
      if (!lineCache.has(chat)) { const l = this.activeLine(chat); lineCache.set(chat, l ? Date.parse(l.at) : NaN) }
      const v = lineCache.get(chat)!
      return Number.isFinite(v) ? v : null
    }
    const after = (m: any): boolean => { const l = lineAt(m.chat); return l == null || Date.parse(m.at) > l }
    if (o.id) {
      const tg = /^tg:(\d+)$/i.exec(o.id)?.[1] ?? (/^\d+$/.test(o.id) ? o.id : undefined)
      const m = tg ? [...msgs.values()].find(x => x.client_msg_id === tg && (!o.chat || x.chat === o.chat)) : undefined
      if (m && !after(m) && ![...msgs.values()].some(x => x.chat === m.chat && after(x) && x.reply_to_client_msg_id != null && x.reply_to_client_msg_id === m.client_msg_id))
        return `${head}\n${behindLine(new Date(lineAt(m.chat)!).toISOString())}`
      return m ? `${head}\n${formatFull(m, joey)}` : `${head}\n本機暫存裡找不到 ${o.id}。`
    }
    const sinceMs = o.since ? Date.parse(o.since) : -Infinity, untilMs = o.until ? Date.parse(o.until) : Infinity
    const ql = o.q?.toLowerCase()
    const inScope = [...msgs.values()].filter(m => (!o.chat || m.chat === o.chat))
    const all = inScope.filter(m => after(m) && Date.parse(m.at) >= sinceMs && Date.parse(m.at) <= untilMs && (!ql || String(m.body).toLowerCase().includes(ql)))
      .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    const cutAt = o.cut ?? CUT
    const rows = all.slice(0, o.limit).map(m => {
      const b = String(m.body ?? '')
      return [...b].length > cutAt ? { ...m, body: [...b].slice(0, cutAt).join(''), truncated: true } : m
    })
    noteInbound(rows, o.inbound)                                                 // WO-148 lab: as Onsen's answer
    const cut = [...new Set(o.chat ? [o.chat] : inScope.map(m => m.chat))].map(c => lineAt(c)).filter((x): x is number => x != null)
    const rl = cut.length ? `${restartHead(new Date(Math.max(...cut)).toISOString())}\n` : ''
    return `${head}\n${rl}${formatList(rows, all.length, joey, cutAt)}`
  }
}

// ------------------------------------------------------------------ formatting (Chiron's WO-139 format: oldest first, UTC, one line each)
const CUT = 300
/** ISO or a relative span back from now ("2h", "30m", "3d", "45s", "1w"); undefined when empty */
export function parseWhen(v: unknown, now = Date.now()): string | undefined {
  const s = str(v)?.trim()
  if (!s) return undefined
  const rel = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d|w)$/i.exec(s)
  if (rel) {
    const unit = rel[2]!.toLowerCase(), mult = unit === 's' ? 1e3 : unit === 'm' || unit === 'min' ? 6e4 : unit === 'h' ? 3.6e6 : unit === 'd' ? 8.64e7 : 6.048e8
    return new Date(now - Number(rel[1]) * mult).toISOString()
  }
  const t = Date.parse(s)
  if (!Number.isFinite(t)) throw new Error(`看不懂時間「${s}」：用 ISO（2026-11-24T21:00Z）或相對時間（30m、2h、3d）`)
  return new Date(t).toISOString()
}
export function whenUtc(at: unknown): string {
  const t = Date.parse(String(at ?? ''))
  if (!Number.isFinite(t)) return '??-?? ??:??Z'
  const d = new Date(t), p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}
export function whoOf(m: { direction?: string; sender?: string; sender_part?: string }, joeyChat = ''): string {
  let s = String(m.sender ?? '')
  // the full row (GET /messages/{id}) names the member (agent:<name>) and the part of it that spoke (sender_part: main / a lane id / router)
  if (/^agent:/.test(s)) s = String(m.sender_part ?? '') || 'main'
  if (s === 'joey' || s === 'member:joey' || (joeyChat && s === `tg:${joeyChat}`)) return 'Joey'
  if (s.startsWith('system:') || s === 'system') return '系統'
  return s || (m.direction === 'in' ? '?' : 'main')
}
/** the Telegram message id of a row: the list's client_msg_id; the full row's meta.client_msg_id or its telegram alias (client_ref <chat>:<id>) */
function tgIdOf(m: any): string | undefined {
  if (m.client_msg_id != null) return String(m.client_msg_id)
  if (m.meta?.client_msg_id != null) return String(m.meta.client_msg_id)
  const a = Array.isArray(m.aliases) ? m.aliases.find((x: any) => x?.client === 'telegram' && x.client_ref) : undefined
  return a ? String(a.client_ref).split(':').pop() : undefined
}
const ref = (m: any): string => { const tg = tgIdOf(m); return [m.id != null ? `#${m.id}` : '', tg ? `tg:${tg}` : ''].filter(Boolean).join(' ') || '#?' }
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ⏎ ').trim()
function lineOf(m: any, joey: string, cutAt = CUT): string {
  const full = oneLine(String(m.body ?? ''))
  // a body already cut at CUT (Onsen's list, the spool) is not cut again at CUT; a shorter cut (WO-144: the lane opening's block) cuts it again
  const over = [...full].length > cutAt && (!m.truncated || cutAt < CUT)
  const body = over ? [...full].slice(0, cutAt).join('') : full
  const flags = `${m.status === 'failed' ? '（沒送出）' : ''}${m.edited ? '（改過）' : ''}`
  return `${whenUtc(m.at)}｜${whoOf(m, joey)}｜${ref(m)}｜${flags}${body}${m.truncated || over ? '…（全文用 id 取）' : ''}`
}
/** step 2 (WO-142): the line at the top of a list the restart line cut */
export function restartHead(at: unknown): string { return `Joey 在 ${whenUtc(at)} 叫你重新開始：線之前的對話不顯示（他引用的那則照樣看得到）` }
/** step 2: an id lookup of a message before the line */
export function behindLine(at: unknown): string { return `這一則在 Joey 叫你重新開始（${whenUtc(at)}）之前，看不到` }
/** the list: rows newest first as the API gives them, shown oldest first */
export function formatList(rows: any[], total: number, joey = '', cutAt = CUT): string {
  if (!rows.length) return `沒有符合的訊息。\n共 ${total} 則，顯示 0 則`
  const shown = [...rows].reverse().map(m => lineOf(m, joey, cutAt))
  return `${shown.join('\n')}\n共 ${total} 則，顯示 ${rows.length} 則`
}
/** one message in full: a header line, the whole body, then its events */
export function formatFull(m: any, joey = ''): string {
  const extra = [m.kind && m.kind !== 'text' ? m.kind : '', m.status === 'failed' ? `沒送出${m.error ? `：${m.error}` : ''}` : '', m.edited ? '改過' : '',
    m.reply_to_client_msg_id != null ? `回覆 tg:${m.reply_to_client_msg_id}` : '', m.forward_from ? `轉傳自 ${m.forward_from}` : '', m.thread ? `話題 ${m.thread}` : '']
    .filter(Boolean).join('，')
  const att = Array.isArray(m.attachments) && m.attachments.length ? `\n附件：${m.attachments.map((x: any) => x.name ?? x.mime ?? x.file_id ?? '?').join('、')}` : ''
  const evs = Array.isArray(m.events) ? m.events : []
  const evLines = evs.map((e: any) => {
    const who = whoOf({ sender: e.actor, sender_part: e.actor_part }, joey)
    if (e.kind === 'edit') return `- ${whenUtc(e.at)} ${who} 改成：${e.body ?? ''}`
    if (e.kind === 'reaction') return `- ${whenUtc(e.at)} ${who} 按了 ${e.data?.emoji ?? '（收回表情）'}`
    if (e.kind === 'retract') return `- ${whenUtc(e.at)} ${who} 收回了這則`
    if (e.kind === 'edit_delivered') return `- ${whenUtc(e.at)} 改過的內容交給了 agent${e.data?.replaced_in_queue ? '（原訊息還在佇列裡，直接換掉）' : ''}`
    return `- ${whenUtc(e.at)} ${who} ${e.kind}`
  })
  return `${whenUtc(m.at)}｜${whoOf(m, joey)}｜${ref(m)}${extra ? `｜${extra}` : ''}\n${String(m.body ?? '')}${att}${evLines.length ? `\n事件：\n${evLines.join('\n')}` : ''}`
}

export { CHAT_HISTORY_TOOL, FORM_CLOSE_TOOL, formClose } from './onsen-tool.ts'

// ------------------------------------------------------------------ wiring helpers for server.ts
/** this agent's fleet name: LANES_AGENT, else AGENT_INBOX_SELF, else the workspace dir's claude-<name> */
export function agentName(env: NodeJS.ProcessEnv, workspaceDir: string): string {
  const v = (env.LANES_AGENT ?? '').trim() || (env.AGENT_INBOX_SELF ?? '').trim()
  if (v) return v
  const b = basename(workspaceDir)
  return b.startsWith('claude-') ? b.slice(7) : b || 'unknown-agent'
}
/** ONSEN_RECORD: on unless 0 / off / false / no */
export function recordOn(env: NodeJS.ProcessEnv): boolean {
  const v = (env.ONSEN_RECORD ?? '').trim().toLowerCase()
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no')
}
/** ONSEN_AGENTS (the canary switch): a comma list of agent names, or `*` (unset = `*`). Recording runs only for an agent in it, and only with ONSEN_RECORD on. */
export function recordFor(env: NodeJS.ProcessEnv, agent: string): boolean {
  if (!recordOn(env)) return false
  const list = (env.ONSEN_AGENTS ?? '*').split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}
export const onsenBase = (env: NodeJS.ProcessEnv): string => ((env.ONSEN_BASE ?? '').trim() || 'https://core.kbro.ai/api/onsen').replace(/\/+$/, '')
