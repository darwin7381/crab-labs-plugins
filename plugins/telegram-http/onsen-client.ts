// Onsen (WO-139, Relay step 1): the Telegram client's half of "every Joey <-> agent message is one record in Onsen's own database".
//
// Onsen is served by Fleet Core (ONSEN_BASE, default https://core.kbro.ai/api/onsen). This module:
//   - records: recordMessage / recordEvent append one line to a local spool (<STATE_DIR>/onsen/spool.jsonl) and return. They never throw and never touch
//     the network, so a send to Telegram is never slowed or failed by Onsen.
//   - syncs: a loop (every 5 s, and right after an append, coalesced) posts the unsent lines IN ORDER (messages via /messages/batch, events via /events),
//     then moves a cursor (<STATE_DIR>/onsen/cursor.json, byte offset). Network error / 5xx / 401 (the credential) / 408 / 425 / 429: kept, retried
//     with backoff (cap 60 s). Any other 4xx (1.58.32: 403 too) for one record: logged and moved to rejected.jsonl, never retried, never holding the
//     queue (/healthz onsen.skipped). `duplicate` counts as sent (the server dedupes by idem_key), so a
//     crash between the POST and the cursor write costs nothing. The spool IS the queue: a daemon restart resumes from the cursor.
//   - answers chat_history: GET /messages (or one message) with this agent's mesh credential; Onsen silent for ~4 s: the local spool answers, and says so.
//   - knows who sent each Telegram call: server.ts runs a send inside `withSender(<who>, …)` (AsyncLocalStorage); the Bot API wrappers read it.
//   - step 2 (WO-142): draws and lifts restart lines (Joey's /clear and its button: POST /restart-lines, /restart-lines/lift), directly with a short
//     timeout, else through the spool in order; keeps the lines it drew in <STATE_DIR>/onsen/lines.json so the spool's answer respects them too;
//     records edit_delivered (an edited message of Joey's reached the agent).
//   - step 3 (WO-143): delivery facts (k 'd': delivered / in_session / seen / turn_end of Joey's messages, POST /deliveries/batch) and the main's status (k 's', POST
//     /status/batch; 1.45.1: the registry's states and last_activity_at) go through the same spool, in order behind the messages they are about (onsen-status.ts decides them; server.ts wires them). A batch
//     refused as a whole (an Onsen without those routes) goes to rejected.jsonl: the messages behind it are never held.
//   - WO-147 (step 4a, onsen-wake.ts): every wake decision (one route record of the lanes router) as one row (k 'w', POST /wake/batch), through the same
//     spool and the same batch rules as the step 3 facts: written locally first, synced in order, a resent line keeps its idem_key (duplicate = sent).
//   - WO-145 (the half Joey sees, onsen-visible.ts): a send context may carry `redact` (a reply's page links with their one-time form keys → the links as the
//     agent wrote them): the record keeps the text WITHOUT the keys. A form answer's ack that Onsen did not take directly goes through the spool (k 'a',
//     POST /forms/ack). `observe` lets the daemon read every line it appends (the pinned status's local counts). `request`: one call with the credential.
//   - WO-192 (onsen-first.ts, ONSEN_FIRST): a reply written into Onsen before Telegram (A, directly) has its delivery report (B, k 'r', POST
//     /messages/<id>/delivery) go through the same spool, in order; 409 (already delivered) is settled, not rejected.
// The credential (the agent's mesh credential, read from the agent-inbox daemon's state dir) is never logged, printed or written anywhere.

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { OnsenIds } from './onsen-connector.ts'
import type { Step } from './lanes-boundary.ts'
import type { WakeItem } from './onsen-wake.ts'
import type { TakeMode } from './onsen-take.ts'

// ------------------------------------------------------------------ records (the contract posted on WO-139)
export type OnsenAttachment = { name?: string; mime?: string; size?: number; file_id?: string }
export type OnsenItem = {
  idem_key: string; agent: string; client: 'telegram'; chat: string; direction: 'in' | 'out'; sender: string; body: string
  kind: 'text' | 'command' | 'voice' | 'photo' | 'document' | 'video' | 'sticker' | 'rich'
  sent_at: string; client_msg_id?: string; reply_to_client_msg_id?: string; thread?: string; forward_from?: string
  attachments?: OnsenAttachment[]; status: 'ok' | 'failed'; error?: string; backfilled?: false; meta?: Record<string, unknown>
  /** WO-172 (Chiron 02:43Z; Onsen app/onsen.py reads the item's own turn_id into messages.turn_id): an outbound message's turn, a field of the item itself
   *  as on seen and turn_end (not in meta) */
  turn_id?: string
  /** WO-179 (Chiron; Onsen 0.22.2 keeps them for display only, never to tell who is who): on an INCOMING message, the group's name (chat.title, only for
   *  group / supergroup) and the speaker's Telegram name (first_name + last_name, else @username). Fields of the item itself, not meta. */
  chat_title?: string
  sender_name?: string
  /** WO-190 (Onsen ≥ 0.29.1 on `out`, ≥ 0.29.4 on `in`): the files Onsen keeps for this message (POST /v1/files ids, this agent's own uploads), in
   *  `attachments` order. Never in the spool line itself: the sync joins them when it sends a line marked `fw` (OnsenClient.recordWithFiles) */
  attachment_file_ids?: string[]
}
export type OnsenEvent = {
  idem_key: string; agent: string; client: 'telegram'; chat: string; target_client_msg_id: string
  kind: 'edit' | 'reaction' | 'retract' | 'edit_delivered'; actor: string; body?: string; data?: Record<string, unknown>; at: string
}
/** step 2 (WO-142): Joey's /clear draws a line (POST /restart-lines); idem_key tg:<agent>:<chat>:line:<the /clear message id> */
export type RestartLineDraw = { agent: string; client: 'telegram'; chat: string; idem_key: string; at: string; by?: string; client_msg_id?: string }
  /** WO-197 segment 2 (Onsen 0.35.8, CONTRACT §7d 「重新開始線屬於對話」): the conversation instead of agent / client / chat (never both: 400) */
  | { conversation_id: string; idem_key: string; at: string; by?: string; client_msg_id?: string }
/** step 2: his button lifts it (POST /restart-lines/lift). draw_idem (local only, never posted): a lift queued behind a draw still in the spool, resolved
 *  to that draw's line id when the spool reaches it */
export type RestartLineLift = { agent?: string; client?: 'telegram'; chat?: string; conversation_id?: string; at: string; by?: string; line_id?: number; draw_idem?: string }
/** a line this daemon drew, kept in lines.json (the spool's answer filters by it); id null: not yet in Onsen */
export type LocalLine = { chat: string; at: string; idem_key: string; client_msg_id?: string; by?: string; id: number | null; lifted_at: string | null
  lifted_by?: string | null; rejected?: boolean }
/** step 3 (WO-143): one fact about one of Joey's messages reaching the agent (POST /deliveries/batch). delivered: the daemon took it in (queued);
 *  in_session (WO-165): it was handed to a session (written into the main's stream; lanes on: M1 offered it, or bound it at a boundary; a lane run
 *  started with it), which may hold it in its own queue; seen: it entered a turn of that session (lanes on: M1 bound it to a prompt; lanes off: the
 *  main's transcript shows it taken in; a lane run started with it), `by` main or the lane id; until WO-165 seen was the in_session moment;
 *  turn_end: the turn that saw it ended (`by` as for seen). One per (message, recipient, state). An Onsen that does not list in_session yet refuses
 *  that item alone (400 in its result: logged, rejected.jsonl); the rest of the batch goes in. */
export type DeliveryState = 'delivered' | 'in_session' | 'seen' | 'turn_end'
export type DeliveryFact = { idem_key: string; agent: string; client: 'telegram'; chat: string; client_msg_id: string; state: DeliveryState; at: string; by?: string
  detail?: Record<string, unknown>
  /** WO-172 (Onsen 0.16.0, WO-171): seen and turn_end: the turn (the observation's sessions[].turn.id); turn_end: how it ended and what was bound into it */
  turn_id?: string; outcome?: 'done' | 'interrupted' | 'failed'; bound?: string[] }
/** step 3: the main's status (POST /status/batch). 1.45.1: the state is Claude Code's own session registry's (onsen-status.ts statusOf); last_activity_at =
 *  the newest write to the main's transcript or its subagents' (null = none found) */
export type StatusState = 'offline' | 'idle' | 'busy' | 'waiting' | 'stuck' | 'walled' | 'starting'   // walled, starting: WO-165 A (Jev reads the screen; Onsen 0.12.5)
export type StatusFact = { idem_key: string; agent: string; state: StatusState; at: string; detail?: Record<string, unknown>; last_activity_at?: string | null }
/** WO-145: the form answers this daemon queued for the main (POST /forms/ack), when Onsen did not take the ack directly */
export type FormAck = { ids: number[]; at: string }
/** fw (WO-190, local only, never posted): this message's files are being stored in Onsen; the sync joins their ids when it sends the line */
import type { ItemReport } from './onsen-receive.ts'
import { claudeSessionId, roamerSessionId } from './onsen-items.ts'
import { isDeepStrictEqual } from 'node:util'
import { ItemWrites, type ItemWrite } from './onsen-item-writes.ts'
export type SpoolLine = { k: 'm'; r: OnsenItem; fw?: 1 } | { k: 'e'; r: OnsenEvent } | { k: 'l'; r: RestartLineDraw } | { k: 'u'; r: RestartLineLift }
  | { k: 'd'; r: DeliveryFact } | { k: 's'; r: StatusFact } | { k: 'a'; r: FormAck } | { k: 'w'; r: WakeItem }
  /** WO-164: one thread event (lanes-threads.ts OnsenThreadEvent), POST /threads/events */
  | { k: 't'; r: Record<string, unknown> & { thread: string; dedupe: string } }
  /** WO-175: one moment of a Call this agent received (onsen-status.ts CallFacts), PUT /v1/calls/<id>/state */
  | { k: 'c'; r: CallStateLine | ScheduledResultLine }
  | { k: 'ir'; r: ItemReport }
  | { k: 'item' | 'self'; r: ItemWrite } // self = spool entries written before the shared Item writer
  | { k: 'blocked'; r: BlockedReceipt }
  /** WO-192: what Telegram did with a reply written into Onsen first (onsen-first.ts), POST /messages/<message_id>/delivery */
  | { k: 'r'; r: DeliveryReportLine }
type BlockedReceipt = ({ message_id: string } | { chat: string; client_msg_id: string }) & { retry_after: string | null }
const SPOOL_KINDS = new Set(['item', 'self', 'ir', 'blocked', 'm', 'e', 'l', 'u', 'd', 's', 'a', 'w', 't', 'c', 'r'])
/** WO-192 (Onsen 0.31.0, WO-191 B): one delivery report: the Onsen message A wrote, and the body Onsen takes */
export type DeliveryReportLine = { message_id: number
  body: { client: 'telegram'; state: 'sent' | 'failed'; client_msg_ids: string[]; at: string; error?: string } }
/** WO-175 (Onsen contract v1 §4, §9; Onsen 0.24.1: a pulled item carries its `call_id`): the Call a received item is, as the item names it */
export type CallRef = { kind: 'peer_call' | 'scheduled' | 'alert' | 'board'; id: string }
export type CallWait = 'wall' | 'offline' | 'restart'
export type CallCheck = { final: string } | 'open' | 'wait'
export type CallStateName = 'accepted' | 'running' | 'completed' | 'failed'
/** one PUT /v1/calls/<id>/state, as spooled: the Call, the body Onsen takes (state, session_id, result, at), the event and an idem key (local only:
 *  what moment of which item this is) */
export type CallStateLine = { call_id: string; kind: CallRef['kind']; event: string; idem: string
  body: { state: CallStateName; session_id: string | null; result?: { outcome?: string; body?: { format: 'markdown'; text: string } }; at: string } }
/** A take receipt supplements the Call. Only the Item reports the turn's progress. */
export type ScheduledResultLine = { event: string; idem: string; call_id: string | null; run_id: string
  body: { state?: never; result: { outcome: string; steps?: Step[]; body?: { format: 'markdown'; text: string } } } }
/** WO-175 (Chiron 05:55Z: a receipt goes to Onsen only): what became of one spooled Call line. took: Onsen answered 2xx (its state then);
 *  refused: a 4xx (Onsen's sentence; the line is in rejected.jsonl); pending: no answer, or 5xx, within the wait (the line stays in the spool and
 *  goes when Onsen answers); nocred: this daemon has no mesh credential (a broken setup) */
export type CallLineFate = { fate: 'took'; state: string | null } | { fate: 'refused'; status: number; said: string } | { fate: 'pending'; why: string }
  | { fate: 'nocred'; why: string }
/** 1.58.32: the Call an item answers, from its refs (`call`: the id the answer names; CONTRACT §4 「回覆的 refs 帶 {kind: "call", value: <call_id>}」,
 *  Onsen's /send refs.call): Onsen links it only to a Call its recipient made (fleet-core onsen_calls.py _named_call), so the agent that receives it
 *  is that Call's caller and never writes its state. null: it names none */
export function answeredCall(refs: unknown): string | null {
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return null
  const v = (refs as Record<string, unknown>).call
  return (typeof v === 'string' || typeof v === 'number') && /^\d{1,18}$/.test(String(v).trim()) ? String(v).trim() : null
}
/** a run's Call as Onsen lists it (GET /v1/calls?ref_kind=run&ref_value=<run>), or why there is none to say */
export type RunCallLookup = { found: { id: string; state: string | null; result: unknown } } | { none: true } | CallLineFate
/** btcc-receipt's budget (Chiron 05:55Z): the first try and three more, all within 10 s */
export const CALL_RECEIPT_WAIT_MS = 10_000
const CALL_RETRY_AT = [0, 1_000, 3_000, 7_000]
const callsForRun = (run: string) => `/v1/calls?ref_kind=run&ref_value=${encodeURIComponent(run)}&limit=5`
const firstRunCall = (json: any) => Array.isArray(json?.items) ? json.items.find((c: any) => c?.id != null) : undefined
/** the batch route of each kind that is posted in runs (≤500 a batch) */
const BATCH_PATH: Record<string, string> = { d: '/deliveries/batch', s: '/status/batch', w: '/wake/batch', t: '/threads/events' }

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
  redact?: Array<[string, string]>
  /** WO-172: the turn the message is sent in (the main's prompt id, a lane's run id; the observation's sessions[].turn.id); a notice of the daemon's
   *  own has none */
  turn_id?: string | null
  /** WO-190: the local file this send carries (the reply tool's `files`, one per send): stored in Onsen too once Telegram took it (ONSEN_FILES) */
  file?: string
  /** WO-197 (Chiron lab round 3A: /status's receipt listed no response): the turn of a person's message the daemon answers itself (withAnswering):
   *  every message sent inside carries it, so Onsen links the answer to the message (its turn_end names the same turn). `named`: false while the
   *  sender is the scope's default (an inner withDefaultSender names it) */
  answering?: string; named?: boolean }
const als = new AsyncLocalStorage<SendCtx>()
/** the author of a Telegram call made outside every named send path (server.ts records it all the same) */
export const DEFAULT_CTX: SendCtx = { sender: 'system:daemon' }
/** run `fn` with `sender` as the author of every Telegram call it makes; `extra` (WO-145): `redact` for the record */
export function withSender<T>(sender: string, fn: () => T, extra?: Pick<SendCtx, 'redact' | 'turn_id' | 'file'>): T {
  const answering = als.getStore()?.answering                            // WO-197: inside a command the daemon answers, its turn goes on
  return als.run({ sender, ...(extra?.redact?.length ? { redact: extra.redact } : {}), ...(extra?.turn_id ? { turn_id: extra.turn_id } : {}),
    ...(extra?.file ? { file: extra.file } : {}), ...(answering ? { answering } : {}) }, fn)
}
/** WO-197 (round 3A): everything `fn` sends answers the person's message whose handling turn is `turn` (the daemon's own command, a permission reply) */
export function withAnswering<T>(turn: string, fn: () => T): T {
  const c = als.getStore()
  return als.run(c ? { ...c, answering: turn } : { ...DEFAULT_CTX, answering: turn, named: false }, fn)
}
/** the turn a message sent in this context belongs to: its own (a session's), else the self-answered message's (withAnswering) */
export const turnOfCtx = (c: SendCtx | undefined): string | null => c?.turn_id ?? c?.answering ?? null
/** WO-145: the text as Onsen keeps it: every [sent, kept] pair of the send context applied */
export function redactText(s: string, redact?: Array<[string, string]>): string {
  if (!redact?.length) return s
  for (const [from, to] of redact) if (from) s = s.split(from).join(to)
  return s
}
/** `sender` unless a caller already named the author (a shared helper: its callers name themselves) */
export function withDefaultSender<T>(sender: string, fn: () => T): T {
  const c = als.getStore()
  return !c ? als.run({ sender }, fn) : c.named === false ? als.run({ ...c, sender, named: true }, fn) : fn()
}
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
  const chatTitle = (m?.chat?.type === 'group' || m?.chat?.type === 'supergroup') && typeof m?.chat?.title === 'string' && m.chat.title.trim() ? m.chat.title.trim() : undefined
  const senderName = displayName(m?.from)
  return {
    idem_key: idemIn(agent, chat, id), agent, client: 'telegram', chat, direction: 'in', sender: `tg:${m?.from?.id ?? '?'}`,
    body: String(body ?? ''), kind: shape.kind, sent_at: iso(m?.date), client_msg_id: str(id),
    ...(replyTo ? { reply_to_client_msg_id: replyTo } : {}), ...(thread ? { thread } : {}), ...(fwd ? { forward_from: fwd } : {}),
    ...(shape.attachments ? { attachments: shape.attachments } : {}), status: 'ok', backfilled: false,
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(chatTitle ? { chat_title: chatTitle } : {}), ...(senderName ? { sender_name: senderName } : {}),
  }
}

/** WO-179: a Telegram user's display name: first_name + ' ' + last_name (or first_name alone); @username only when neither is there */
export function displayName(u: any): string | undefined {
  const full = [u?.first_name, u?.last_name].filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim()).join(' ')
  if (full) return full
  return typeof u?.username === 'string' && u.username.trim() ? `@${u.username.trim()}` : undefined
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
    ...(turnOfCtx(ctx) ? { turn_id: String(turnOfCtx(ctx)).slice(0, 120) } : {}),   // WO-172: the turn it was sent in, top level (WO-177 1.58.3: was meta.turn_id); WO-197: a self-answered message's
  } }
}

// ------------------------------------------------------------------ the client
type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export type OnsenConfig = {
  /** the spool dir (<STATE_DIR>/onsen) */
  dir: string
  base: string
  agent: string
  roamer?: boolean
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
  /** WO-162: the newest status also goes out at once on its own (default true; false: only through the spool, in order) */
  fastStatus?: boolean
  /** the Telegram id of Joey's DM chat (chat_history's default chat; `tg:<it>` reads as Joey), or '' */
  joeyChat?: () => string
  /** WO-164: Onsen's answer to each thread event the spool posted (/threads/events): `conflict` (another thread is open on its key; nothing stored) and a
   *  refusal (a 4xx for that item) go back to the lanes (lanes.ts threadConflict / threadRefused) */
  onThread?: (ev: any, res: any) => void
  /** WO-190: how long the sync waits for a message's files to be stored before it sends the message without them (default FILES_WAIT_MS) */
  filesWaitMs?: number
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

// 1.58.32 (Chiron, Joey: a refused record never blocks the queue). Onsen (CONTRACT §1; fleet-core webauth.py / auth.py) answers a credential it
// does not know, or none, with 401 not_authenticated, and a known credential not allowed to do this one thing with 403 not_authorized: a Call state
// written by its caller (「只有收件人 X 的常駐程式能回報」), another agent's conversation, a message it did not write. The spool waits on and tries
// again only what can pass later unchanged: the credential itself (401, or a 403 whose code says not_authenticated), a timeout (408), too early
// (425), too fast (429). Every other 4xx (403, 404, 409, 400, 422 …) is Onsen refusing that one record for good: rejected.jsonl, one log line,
// counted in `skipped`, and the cursor moves on, so one such record never holds the ones behind it (until 1.58.31 a 403 was retried forever:
// chiron's daemon stood 5½ h on /v1/calls/541/state, sonn's on 485).
const RETRYABLE_4XX = new Set([401, 408, 425, 429])
/** the code of Onsen's error answer ({error: {code}}), '' for the older shapes */
const errCode = (j: any): string => { const e = j?.error; return e && typeof e === 'object' && typeof e.code === 'string' ? e.code.slice(0, 60) : '' }
/** 1.58.32: the credential itself was not accepted (401; a 403 that says not_authenticated): kept and tried again, never thrown away */
export const credentialRefused = (r: { status: number; json: any }): boolean => r.status === 401 || (r.status === 403 && errCode(r.json) === 'not_authenticated')
/** 1.58.32: Onsen refused this one record for good (a 4xx that is not the credential, a timeout, too early or too fast) */
export const refusedForGood = (r: { status: number; json: any }): boolean =>
  r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status) && !credentialRefused(r)
/** 1.58.32: what Onsen refused, as /healthz onsen.skipped shows it */
export type SkippedInfo = { kind: string; path: string; status: number; code?: string }
const HOUR = 3600_000
const READ_WINDOW = 1 << 20          // bytes read from the cursor per pass
/** WO-190: Onsen's own limit for one file (ONSEN_FILE_MAX_BYTES, 25 MB): a bigger one is not sent */
export const ONSEN_FILE_MAX = 25 * 1024 * 1024
/** WO-190: the longest the sync holds a message for its files (the Telegram fetch and the upload are each bounded inside it) */
export const FILES_WAIT_MS = 120_000
/** WO-190: a header value that is plain ASCII: a file's name, percent-encoded (Onsen decodes X-File-Name) */
const headerName = (name: string): string => encodeURIComponent(name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 1000)

/** a spool line's key for a log line: its record's idem_key (a Call state's `idem`; a delivery report's Onsen message), never its content */
function lineKey(line: unknown): string {
  const l = line as any
  return String(l?.r?.idem_key ?? l?.r?.idem ?? l?.r?.key ?? (l?.r?.message_id != null ? `delivery:${l.r.message_id}` : '?')).slice(0, 200)
}
/** what Onsen said in an error answer ({error: {code, message}}, or older shapes) */
function callSaid(j: any): string {
  const e = j?.error
  return String((e && typeof e === 'object' ? e.message ?? e.code : e) ?? j?.detail ?? '').slice(0, 300) || 'no reason given'
}
export class OnsenClient {
  readonly spool: string
  readonly spoolOld: string
  readonly cursorFile: string
  readonly rejected: string
  private readonly itemWrites: ItemWrites
  readonly linesFile: string
  private running = false
  private again = false
  private kickTimer: ReturnType<typeof setTimeout> | null = null
  // WO-162 (Chiron 16:10Z: a busy row took 0.9–2.0 s to show, an idle row 0.3–0.5 s): a pass sends the spool in order, one POST per run of one
  // kind, and in a turn the kinds interleave (messages, facts, wake decisions, status), so a status line waited behind several round trips. The
  // status is latest-wins on the server (an older report is ignored, the same idem_key is a duplicate), so the newest one also goes out on its
  // own at once, never behind a pass; the spool still carries every line in order (the history). ONSEN_STATUS_FAST=0 turns the fast path off.
  private fastPending: StatusFact | null = null
  private fastRunning = false
  readonly fastStats = { sent: 0, failed: 0 }
  private interval: ReturnType<typeof setInterval> | null = null
  private backoffMs = 0
  private nextTryAt = 0
  private credWarnAt = 0
  private appendWarnAt = 0
  private authWarnAt = 0
  private observers: Array<(line: SpoolLine) => void> = []
  /** WO-175: what became of the Call lines sent lately (idem → fate), and who waits for one not sent yet */
  private itemReports = 0
  private reportedThrough: number
  private itemAck?: (line: ItemReport, ok: boolean) => void

  watchItemReports(replay: (line: ItemReport) => void, ack: (line: ItemReport, ok: boolean) => void): void {
    this.itemAck = ack
    this.itemReports = 0
    for (const { line } of this.pendingReports()) { this.itemReports++; replay(line.r) }
  }

  private *pendingReports() {
    let offset = Math.max(this.readCursor(), this.reportedThrough)
    for (;;) {
      const lines = this.unsent(offset)
      if (!lines.length) return
      for (const entry of lines) if (entry.line?.k === 'ir') yield { ...entry, line: entry.line }
      offset = lines[lines.length - 1]!.end
    }
  }

  private *pendingLines(): Generator<SpoolLine> {
    let offset = this.readCursor()
    for (;;) {
      const lines = this.unsent(offset)
      if (!lines.length) break
      for (const { line } of lines) if (line) yield line
      offset = lines[lines.length - 1]!.end
    }
  }
  hasItemReports(): boolean { return this.itemReports > 0 }
  private itemWriteAck?: (write: ItemWrite, row?: import('./onsen-items.ts').InboxItem) => void
  watchItemWrites(ack: NonNullable<typeof this.itemWriteAck>): void { this.itemWriteAck = ack }
  mayWithdrawKeepwarm?: (row: import('./onsen-items.ts').InboxItem) => boolean
  onItemCreateSettled?: (key: string, id?: string) => void
  hasPendingItemCreate(keys: Set<string>): boolean {
    for (const line of this.pendingLines()) {
      if ((line.k === 'item' || line.k === 'self') && keys.has(line.r.key) && !line.r.outcome && !line.r.complete) return true
    }
    return false
  }
  *rejectedSelfCreates(): Generator<string> {
    let lines: string
    try { lines = readFileSync(this.rejected, 'utf8') }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    for (const raw of lines.split('\n')) {
      if (!raw) continue
      let line: SpoolLine | undefined
      try { line = JSON.parse(raw).line } catch { continue }
      if ((line?.k === 'item' || line?.k === 'self') && line.r.item.kind === 'self' && !line.r.outcome && !line.r.complete) yield line.r.key
    }
  }
  writtenItemId(key: string): string | undefined { return this.itemWrites.id(key) }
  recordItemWrite(write: ItemWrite): void {
    if ((write.outcome || write.complete) && !write.id) {
      const id = this.writtenItemId(write.key)
      if (id) write = { ...write, id }
      else if (this.hasPendingItemCreate(new Set([write.key]))) write = { ...write, pending_create: true }
    }
    const resume = write.item.kind === 'resume'
    if (resume || (write.id && write.outcome === 'withdrawn' && write.item.kind === 'keepwarm')) {
      for (const line of this.pendingLines()) {
        if (line.k !== 'item' && line.k !== 'self') continue
        const pending = line.r
        if (write.id && pending.id === write.id && pending.outcome === write.outcome && pending.expected_version === write.expected_version) return
        if (resume && !write.outcome && !write.complete && !pending.outcome && !pending.complete
          && pending.key === write.key && isDeepStrictEqual(pending.item, write.item)) return
      }
    }
    if (!this.append({ k: 'item', r: write })) throw new Error('could not record the Onsen Item')
  }
  recordItemReport(line: ItemReport): boolean {
    if (!this.append({ k: 'ir', r: line })) return false
    if (!this.itemReports) this.nextTryAt = 0 // let the first report past a non-report's backoff
    this.itemReports++
    return true
  }

  private callFates = new Map<string, CallLineFate>()
  private callWaits = new Map<string, Array<(f: CallLineFate) => void>>()
  /** WO-190: a message's files being stored (its idem_key → when the upload started, and its end), and the ids once known ([] = none: failed, late,
   *  lost with a restart, or refused by Onsen) */
  private fileJobs = new Map<string, { at: number; p: Promise<void> }>()
  private fileIds = new Map<string, string[]>()
  readonly stats = { recorded: 0, posted: 0, duplicates: 0, rejected: 0, last_ok_at: null as string | null, last_error: null as string | null,
    lines_drawn: 0, lines_lifted: 0, lines_spooled: 0, edits_delivered: 0, deliveries_recorded: 0, status_recorded: 0, form_acks_spooled: 0, wake_recorded: 0,
    thread_events: 0, thread_conflicts: 0, calls_spooled: 0, calls_put: 0, calls_unchanged: 0,
    files_uploaded: 0, files_upload_failed: 0, files_late: 0, files_lost: 0, files_refused: 0,
    delivery_reports: 0, delivery_reported: 0, delivery_conflicts: 0 }
  /** 1.58.32: the records Onsen refused for good (a 4xx; also counted in `rejected`) and the last of them; /healthz onsen.skipped */
  readonly skipped = { count: 0, last: null as (SkippedInfo & { at: string; key: string }) | null }

  constructor(readonly cfg: OnsenConfig) {
    this.spool = join(cfg.dir, 'spool.jsonl')
    this.spoolOld = join(cfg.dir, 'spool.1.jsonl')
    this.cursorFile = join(cfg.dir, 'cursor.json')
    this.reportedThrough = this.readCursor('reportedThrough')
    this.rejected = join(cfg.dir, 'rejected.jsonl')
    this.linesFile = join(cfg.dir, 'lines.json')
    this.itemWrites = new ItemWrites(join(cfg.dir, 'item-ids'), cfg.agent, (...args) => this.request(...args))
  }
  private get f(): typeof fetch { return this.cfg.fetch ?? fetch }

  // ---------------------------------------------------------------- recording (the send path: never throws, never waits)
  recordMessage(item: OnsenItem): void { this.append({ k: 'm', r: item }) }
  /** WO-190: a message whose files go into Onsen too. The line goes into the spool NOW, in its place in the order (marked fw), exactly as
   *  recordMessage would write it; `upload` starts at once and gives the files' Onsen ids in `attachments` order (a file not stored is left out; the
   *  upload logs why); the sync joins them as attachment_file_ids when it sends the line (filesOf). Never throws, never waits. Recording off:
   *  nothing is recorded or uploaded */
  recordWithFiles(item: OnsenItem, upload: () => Promise<string[]>): void {
    if (!this.cfg.record) return
    const idem = item.idem_key
    const p = (async () => {
      try { return await upload() }
      catch (e) { this.cfg.log('warn', `onsen: files: ${idem}: ${errText(e)}; recorded with the name and Telegram id only`); return [] as string[] }
    })().then(ids => {
      if (!this.fileIds.has(idem)) this.keepIds(idem, ids.filter(x => typeof x === 'string' && x))
      this.fileJobs.delete(idem)
      this.kick()
    })
    this.fileJobs.set(idem, { at: Date.now(), p })
    this.append({ k: 'm', r: item, fw: 1 })
  }
  private keepIds(idem: string, ids: string[]): void {
    this.fileIds.set(idem, ids)
    if (this.fileIds.size > 2_000) this.fileIds.delete(this.fileIds.keys().next().value!)
  }
  /** WO-190: one file into Onsen's own storage: POST /v1/files, the bytes as the body (Onsen 0.28.0, app/onsen_files.py upload), the type in
   *  Content-Type (an image's is left to Onsen, which reads it from the bytes), the name in X-File-Name (percent-encoded), Idempotency-Key `key` (the
   *  same key and file answer the same File: a retry never stores it twice). Over ONSEN_FILE_MAX (25 MB) or empty: not sent. This agent's credential,
   *  Onsen's own base only. Never throws: the File's id, or why not */
  async uploadFile(bytes: Uint8Array, o: { key: string; name?: string | null; mime?: string | null }, timeoutMs = 90_000): Promise<{ id: string; url: string | null } | { error: string }> {
    const no = (error: string) => { this.stats.files_upload_failed++; return { error } }
    if (!bytes.byteLength) return no('the file is empty')
    if (bytes.byteLength > ONSEN_FILE_MAX) return no(`over Onsen's 25 MB (${bytes.byteLength} bytes)`)
    const cred = this.cfg.credential()
    if (!cred) return no(this.noCredText())
    const declared = String(o.mime ?? '').split(';')[0]!.trim().toLowerCase()
    const type = !declared || /^image\/(png|jpe?g|pjpeg|gif|webp)$/.test(declared) ? 'application/octet-stream' : declared
    const headers: Record<string, string> = { Authorization: `Bearer ${cred}`, 'User-Agent': `onsen-telegram/${this.cfg.agent}`, 'Content-Type': type,
      'Idempotency-Key': o.key.slice(0, 200), ...(o.name && headerName(o.name) ? { 'X-File-Name': headerName(o.name) } : {}) }
    try {
      const r = await this.f(`${this.cfg.base}/v1/files`, { method: 'POST', headers, body: bytes, signal: AbortSignal.timeout(timeoutMs) })
      let json: any = null
      try { json = await r.json() } catch {}
      const d = json?.data ?? json
      if (r.status >= 200 && r.status < 300 && d?.id != null && /^\d{1,18}$/.test(String(d.id))) {
        this.stats.files_uploaded++
        return { id: String(d.id), url: typeof d.url === 'string' ? d.url : null }
      }
      return no(`POST /v1/files answered HTTP ${r.status}${json ? ` (${callSaid(json)})` : ''}`)
    } catch (e) { return no(`POST /v1/files: ${errText(e)}`) }
  }
  /** WO-190: the ids to send with a message marked fw: known ones at once; an upload still running is waited for up to filesWaitMs from its start;
   *  none (its upload was lost with a restart, or did not end in time): [] and one log line, the message goes without them */
  private async filesOf(idem: string): Promise<string[]> {
    const known = this.fileIds.get(idem)
    if (known) return known
    const job = this.fileJobs.get(idem)
    if (!job) {
      this.keepIds(idem, []); this.stats.files_lost++
      this.cfg.log('warn', `onsen: files: ${idem}: its upload did not finish in this daemon (a restart); recorded with the name and Telegram id only`)
      return []
    }
    const wait = this.cfg.filesWaitMs ?? FILES_WAIT_MS, left = job.at + wait - Date.now()
    if (left > 0) await Promise.race([job.p, new Promise(r => { const t = setTimeout(r, left); (t as any).unref?.() })])
    const got = this.fileIds.get(idem)
    if (got) return got
    this.keepIds(idem, []); this.stats.files_late++
    this.cfg.log('warn', `onsen: files: ${idem}: not stored within ${Math.round(wait / 1000)} s; recorded with the name and Telegram id only (a late file is left to Onsen's 24 h sweep)`)
    return []
  }
  /** WO-190: the items to post for a run of message lines: a line marked fw carries its files' ids (attachment_file_ids), when there are any */
  private async withFiles(lines: SpoolLine[]): Promise<OnsenItem[]> {
    const out: OnsenItem[] = []
    for (const l of lines) {
      const item = l.r as OnsenItem
      if (l.k !== 'm' || !l.fw) { out.push(item); continue }
      const ids = await this.filesOf(item.idem_key)
      out.push(ids.length ? { ...item, attachment_file_ids: ids } : item)
    }
    return out
  }
  /** WO-190 (Epeius on the ticket, 09:46Z): Onsen refused a message that carried files (an older Onsen on an `in` message, a file swept or not this
   *  agent's): the same message once more without them, as it was recorded before WO-190 (name and Telegram id); one log line. true: settled (taken,
   *  or refused on its own: rejected.jsonl); else Onsen's answer (no answer, 5xx): the caller holds the spool at this line */
  private async withoutFiles(line: SpoolLine, item: OnsenItem, said: string, cred: string): Promise<true | { status: number; json: any }> {
    this.keepIds(item.idem_key, []); this.stats.files_refused++
    this.cfg.log('warn', `onsen: files: ${item.idem_key}: Onsen refused it with its files (${said.slice(0, 200)}); recorded again without them (name and Telegram id only)`)
    const { attachment_file_ids: _files, ...bare } = item
    const s = await this.post('/messages', bare, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
    if (s.status >= 200 && s.status < 300) { if (s.json?.duplicate) this.stats.duplicates++; else this.stats.posted++; return true }
    if (refusedForGood(s)) { this.reject(line, `HTTP ${s.status} ${callSaid(s.json)}`, { kind: 'm', path: '/messages', status: s.status, code: errCode(s.json) }); return true }
    return s
  }
  recordEvent(ev: OnsenEvent): void { this.append({ k: 'e', r: ev }) }
  recordLine(line: SpoolLine | null): void { if (line) this.append(line) }
  /** step 3 (WO-143): a delivery fact / a status of the main, through the same spool (in order behind the message they are about) */
  recordDelivery(f: DeliveryFact): void { if (this.append({ k: 'd', r: f })) this.stats.deliveries_recorded++ }
  recordStatus(f: StatusFact): void { if (this.append({ k: 's', r: f })) { this.stats.status_recorded++; this.fastStatus(f) } }
  /** WO-192: what Telegram did with a reply written into Onsen first (B), through the same spool: in order before a later edit or reaction of that
   *  message (Onsen finds their target by the numbers B gives it), and kept across a restart. false = not spooled */
  recordDeliveryReport(messageId: number, body: DeliveryReportLine['body']): boolean {
    const ok = this.append({ k: 'r', r: { message_id: messageId, body } })
    if (ok) this.stats.delivery_reports++
    return ok
  }
  /** WO-147: one wake decision (onsen-wake.ts wakeItem), through the same spool; false = not spooled (recording off, or the append failed) */
  recordWake(w: WakeItem): boolean { const ok = this.append({ k: 'w', r: w }); if (ok) this.stats.wake_recorded++; return ok }
  /** WO-164: thread events (lanes-threads.ts threadEvents), one spool line each, posted in order as /threads/events batches; false = not all spooled */
  recordThreads(evs: unknown[]): boolean {
    let ok = true
    for (const e of evs) ok = this.append({ k: 't', r: e as Record<string, unknown> & { thread: string; dedupe: string } }) && ok
    if (ok) this.stats.thread_events += evs.length
    return ok
  }
  /** WO-175: one moment of a Call (onsen-status.ts CallFacts), PUT /v1/calls/<id>/state when the spool reaches it. false = not spooled */
  recordBlocked(r: BlockedReceipt): boolean { return this.append({ k: 'blocked', r }) }
  recordCall(c: CallStateLine | ScheduledResultLine): boolean { const ok = this.append({ k: 'c', r: c }); if (ok) this.stats.calls_spooled++; return ok }
  /** WO-175 (Chiron 05:55Z): wait for what Onsen says to Call line `idem` (spooled already): the spool is tried at once and three more times within
   *  `ms`, whatever its backoff, as btcc-receipt does. A line sent before keeps its fate; one still unsent after `ms` stays in the spool (pending) */
  callFate(idem: string, ms = CALL_RECEIPT_WAIT_MS): Promise<CallLineFate> {
    const known = this.callFates.get(idem)
    if (known) return Promise.resolve(known)
    if (!this.cfg.record) return Promise.resolve({ fate: 'pending', why: 'recording to Onsen is off' })
    if (!this.cfg.credential()) return Promise.resolve({ fate: 'nocred', why: this.noCredText() })
    return new Promise(resolve => {
      const timers: Array<ReturnType<typeof setTimeout>> = []
      let done = false
      const finish = (f: CallLineFate): void => {
        if (done) return
        done = true
        for (const t of timers) clearTimeout(t)
        const ws = (this.callWaits.get(idem) ?? []).filter(w => w !== finish)
        if (ws.length) this.callWaits.set(idem, ws); else this.callWaits.delete(idem)
        resolve(f)
      }
      this.callWaits.set(idem, [...(this.callWaits.get(idem) ?? []), finish])
      for (const at of CALL_RETRY_AT) if (at < ms) timers.push(setTimeout(() => { if (!done) void this.syncNow(true) }, at))
      timers.push(setTimeout(() => finish({ fate: 'pending', why: this.stats.last_error ?? 'Onsen did not answer' }), ms))
      for (const t of timers) (t as any).unref?.()
    })
  }
  private settleCall(idem: string, f: CallLineFate): void {
    this.callFates.set(idem, f)
    if (this.callFates.size > 2_000) this.callFates.delete(this.callFates.keys().next().value!)
    for (const w of this.callWaits.get(idem) ?? []) { try { w(f) } catch {} }
  }
  private noCredText(): string { return `no mesh credential${this.cfg.credentialWhere ? ` at ${this.cfg.credentialWhere}` : ''}` }
  /** WO-175 (Chiron 05:55Z): run `run`'s Call in Onsen (this agent's own Calls), tried again while Onsen does not answer or answers 5xx, within `ms` */
  async findRunCall(run: string, ms = CALL_RECEIPT_WAIT_MS): Promise<RunCallLookup> {
    if (!this.cfg.credential()) return { fate: 'nocred', why: this.noCredText() }
    const r = await this.retried(callsForRun(run), ms)
    if ('fate' in r) return r
    const call = firstRunCall(r.json)
    return call ? { found: { id: String(call.id), state: call.state ?? null, result: call.result ?? null } } : { none: true }
  }
  /** WO-175: one Call as Onsen has it now (GET /v1/calls/<id>), or null */
  async getCall(id: string, ms = 3_000): Promise<{ state: string | null; result: unknown; thread_id?: string; conversation_id?: string; caller?: string } | null> {
    const r = await this.retried(`/v1/calls/${encodeURIComponent(id)}`, ms).catch(() => null)
    if (!r || 'fate' in r) return null
    const c = r.json?.data ?? r.json
    return c && typeof c === 'object' ? { state: c.state ?? null, result: c.result ?? null,
      thread_id: c.thread_id, conversation_id: c.conversation_id, caller: c.caller } : null
  }
  /** Validate a delayed delivery. The stable key also covers a restart between recording the line and closing M1's item. */
  async checkWaitingCall(id: string, why: CallWait, thread?: string): Promise<CallCheck> {
    const call = await this.getCall(id)
    if (!call?.state) return 'wait'
    if (!['failed', 'cancelled', 'completed', 'expired'].includes(call.state)) return 'open'
    const when = { wall: '上限解除時', offline: '主線恢復連線時', restart: '重新啟動時' }
    const text = `${when[why]}這件已經是 ${call.state}，沒有交給主線`
    const key = `waited-call:${id}:${call.state}`
    if (thread) {
      const at = new Date().toISOString()
      return this.recordThreads([{ thread, event: 'item', at, dedupe: key,
        item: { id: key, kind: 'notice', at, text } }]) ? { final: call.state } : 'wait'
    }
    if (!call.conversation_id) return 'wait'
    const r = await this.request('POST', `/v1/conversations/${encodeURIComponent(call.conversation_id)}/messages`, {
      type: 'system', body: { format: 'markdown', text }, to: call.caller ? [call.caller] : [],
      thread_ids: call.thread_id ? [call.thread_id] : [], client_message_id: key,
    })
    return r && r.status >= 200 && r.status < 300 ? { final: call.state } : 'wait'
  }
  /** a GET tried at CALL_RETRY_AT while Onsen does not answer or answers 5xx (408, 429), all within `ms`: the 2xx answer, or a fate */
  private async retried(path: string, ms: number): Promise<{ status: number; json: any } | CallLineFate> {
    const t0 = Date.now()
    let why = 'Onsen did not answer'
    for (let n = 0; n < CALL_RETRY_AT.length; n++) {
      const wait = t0 + CALL_RETRY_AT[n]! - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      const left = t0 + ms - Date.now()
      if (left <= 100) break
      const r = await this.request('GET', path, undefined, Math.min(3_000, left - 50)).catch(e => ({ status: 0, json: { error: errText(e) } }))
      if (!r) return { fate: 'nocred', why: this.noCredText() }
      if (r.status >= 200 && r.status < 300) return r
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return { fate: 'refused', status: r.status, said: callSaid(r.json) }
      why = r.status ? `GET ${path.split('?')[0]} answered HTTP ${r.status}` : `GET ${path.split('?')[0]} unreachable (${String(r.json?.error ?? '').slice(0, 120)})`
    }
    return { fate: 'pending', why }
  }
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
  private fastStatus(f: StatusFact): void {
    if (!this.interval || this.cfg.fastStatus === false) return
    this.fastPending = f
    if (!this.fastRunning) void this.fastFlush()
  }
  /** the newest status now (one in flight; a newer one replaces what waits); a failure is left to the spool, which retries */
  private async fastFlush(): Promise<void> {
    const cred = this.cfg.credential()
    if (!cred) { this.fastPending = null; return }
    this.fastRunning = true
    try {
      while (this.fastPending) {
        const f = this.fastPending
        this.fastPending = null
        const r = await this.post(BATCH_PATH.s!, { items: [f] }, cred, 5_000).catch(() => null)
        if (r && r.status >= 200 && r.status < 300) this.fastStats.sent++
        else { this.fastStats.failed++; break }
      }
    } finally { this.fastRunning = false }
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
  private readCursor(key = 'offset'): number {
    try { const n = Number(JSON.parse(readFileSync(this.cursorFile, 'utf8'))[key]); return Number.isFinite(n) && n >= 0 ? n : 0 } catch { return 0 }
  }
  private writeCursor(offset: number, reportEnd = this.reportedThrough): void {
    const tmp = `${this.cursorFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ offset, ...(reportEnd > offset ? { reportedThrough: reportEnd } : {}), at: new Date().toISOString() }), { mode: 0o600 })
    renameSync(tmp, this.cursorFile)
    this.reportedThrough = reportEnd > offset ? reportEnd : 0
  }
  private fail(why: string): void {
    this.backoffMs = Math.min(Math.max(1000, this.backoffMs * 2), this.cfg.maxBackoffMs ?? 60_000)
    this.nextTryAt = Date.now() + this.backoffMs
    if (this.stats.last_error !== why) this.cfg.log('warn', `onsen: ${why}; kept in the spool, next try in ${Math.round(this.backoffMs / 1000)} s`)
    this.stats.last_error = why
  }
  private ok(): void { this.backoffMs = 0; this.nextTryAt = 0; this.stats.last_ok_at = new Date().toISOString(); this.stats.last_error = null }
  /** `skip` (1.58.32): Onsen refused it (a 4xx, an item's own refusal in a batch): counted in `skipped`, the last one kept for /healthz */
  private reject(line: unknown, why: string, skip?: SkippedInfo): void {
    this.stats.rejected++
    try { appendFileSync(this.rejected, JSON.stringify({ at: new Date().toISOString(), why, line }) + '\n', { mode: 0o600 }) } catch {}
    const key = lineKey(line)
    if (skip) this.noteSkipped(1, skip, key)
    this.cfg.log('warn', `onsen: rejected ${key} (${why}); moved to rejected.jsonl, not retried`)
  }
  /** step 3: a whole batch refused: each line to rejected.jsonl, one log line for the lot */
  private rejectRun(lines: unknown[], why: string, skip?: SkippedInfo): void {
    this.stats.rejected += lines.length
    try { appendFileSync(this.rejected, lines.map(line => JSON.stringify({ at: new Date().toISOString(), why, line })).join('\n') + '\n', { mode: 0o600 }) } catch {}
    if (skip) this.noteSkipped(lines.length, skip, lineKey(lines[lines.length - 1]))
    this.cfg.log('warn', `onsen: rejected ${lines.length} line(s) (${why}); moved to rejected.jsonl, not retried`)
  }
  private noteSkipped(n: number, s: SkippedInfo, key: string): void {
    this.skipped.count += n
    this.skipped.last = { at: new Date().toISOString(), kind: s.kind, path: s.path, status: s.status, ...(s.code ? { code: s.code } : {}), key }
  }
  private headers(cred: string, extra: Record<string, string> = {}): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${cred}`, 'User-Agent': `onsen-telegram/${this.cfg.agent}`, ...extra }
  }
  /** WO-145: one call to Onsen with this agent's credential (null: no credential); throws on a network error or the timeout. `headers` (WO-176): extra
   *  request headers (an Idempotency-Key) */
  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeoutMs = 15_000, headers?: Record<string, string>, cancel?: AbortSignal): Promise<{ status: number; json: any } | null> {
    const cred = this.cfg.credential()
    if (!cred) return null
    if (method === 'POST') return this.post(path, body ?? {}, cred, timeoutMs, headers)
    if (method === 'PUT') return this.put(path, body ?? {}, cred, timeoutMs)      // WO-197: the connector's edit (PUT /v1/messages/<id>)
    const timeout = AbortSignal.timeout(timeoutMs)
    const r = await this.f(`${this.cfg.base}${path}`, { method, headers: this.headers(cred, headers), body: method === 'DELETE' ? JSON.stringify(body) : undefined,
      signal: cancel ? AbortSignal.any([cancel, timeout]) : timeout })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
  /** WO-172: a PUT whose body is bytes (an avatar), with this agent's credential; null: no credential; throws on a network error or the timeout */
  async putBytes(path: string, bytes: Uint8Array, contentType: string, timeoutMs = 20_000, headers?: Record<string, string>): Promise<{ status: number; json: any } | null> {
    const cred = this.cfg.credential()
    if (!cred) return null
    const r = await this.f(`${this.cfg.base}${path}`, { method: 'PUT', headers: this.headers(cred, { 'Content-Type': contentType, ...headers }), body: bytes, signal: AbortSignal.timeout(timeoutMs) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
  /** WO-189: a file Onsen keeps (an attachment's `url`, Onsen's File.url) with this agent's credential. Only Onsen's own address (the origin and path of
   *  this client's base): the credential never goes anywhere else, another address throws. null: no credential. Throws on a network error, the
   *  timeout, or a body over `maxBytes` (its Content-Length, else what arrived) */
  async getFile(url: string, maxBytes: number, timeoutMs = 20_000): Promise<{ status: number; bytes: Uint8Array | null; mime: string | null } | null> {
    let u: URL, b: URL
    try { u = new URL(url); b = new URL(this.cfg.base) } catch { throw new Error('not an address') }
    if (u.origin !== b.origin || !u.pathname.startsWith(`${b.pathname.replace(/\/+$/, '')}/`)) throw new Error("not Onsen's own address")
    const cred = this.cfg.credential()
    if (!cred) return null
    const r = await this.f(u.toString(), { headers: { Authorization: `Bearer ${cred}`, 'User-Agent': `onsen-telegram/${this.cfg.agent}` }, signal: AbortSignal.timeout(timeoutMs) })
    const mime = r.headers.get('content-type')
    if (!r.ok) { try { await r.body?.cancel() } catch {} return { status: r.status, bytes: null, mime } }
    const len = Number(r.headers.get('content-length') ?? NaN)
    if (Number.isFinite(len) && len > maxBytes) { try { await r.body?.cancel() } catch {} throw new Error(`too large (${len} bytes)`) }
    const bytes = new Uint8Array(await r.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`too large (${bytes.byteLength} bytes)`)
    return { status: r.status, bytes, mime }
  }
  /** WO-175: a JSON PUT with this agent's credential (a Call's state) */
  private async put(path: string, body: unknown, cred: string, timeoutMs?: number, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
    const r = await this.f(`${this.cfg.base}${path}`, { method: 'PUT', headers: this.headers(cred, headers), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs ?? this.cfg.postTimeoutMs ?? 15_000) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
  private async post(path: string, body: unknown, cred: string, timeoutMs?: number, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
    const r = await this.f(`${this.cfg.base}${path}`, { method: 'POST', headers: this.headers(cred, headers), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs ?? this.cfg.postTimeoutMs ?? 15_000) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }

  /** the lines after the cursor (complete lines only), each with the offset just past it */
  private unsent(start = this.readCursor()): Array<{ line: SpoolLine | null; raw: string; end: number }> {
    let fd: number | null = null
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
    const fifo = this.unsent()
    const todo = this.itemReports ? [...this.pendingReports(), ...fifo] : fifo
    if (!todo.length) {
      this.rotateIfDrained()
      if (this.interval) await this.itemWrites.reconcile()
      return
    }
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
      if (t.line.k === 'd' || t.line.k === 's' || t.line.k === 'w' || t.line.k === 't') {
        // step 3 (WO-143): a run of delivery facts (or of status lines; WO-147: of wake decisions; WO-164: of thread events): one batch (≤500), in its place in the order
        const k = t.line.k, path = BATCH_PATH[k]!
        const run: Array<{ line: SpoolLine; end: number }> = []
        while (i < todo.length && run.length < 500 && todo[i]!.line?.k === k) { run.push({ line: todo[i]!.line!, end: todo[i]!.end }); i++ }
        const r = await this.post(path, { items: run.map(x => x.line.r) }, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (r.status >= 200 && r.status < 300 && Array.isArray(r.json?.results) && r.json.results.length === run.length) {
          r.json.results.forEach((res: any, n: number) => {
            if (res && res.error == null && res.id != null) { if (res.duplicate) this.stats.duplicates++; else this.stats.posted++ }
            else this.reject(run[n]!.line, `item refused: ${String(res?.error ?? 'no id in the answer').slice(0, 200)}${res?.status != null ? ` (${res.status})` : ''}`,
              { kind: k, path, status: Number(res?.status ?? 0) || 0 })
            if (k === 't' && this.cfg.onThread && (res?.conflict === true || res?.error != null)) {
              if (res?.conflict === true) this.stats.thread_conflicts++
              try { this.cfg.onThread((run[n]!.line as any).r, res) } catch (e) { this.cfg.log('warn', `onsen: thread answer hook: ${errText(e)}`) }
            }
          })
          this.writeCursor(run[run.length - 1]!.end); this.ok()
          continue
        }
        if (refusedForGood(r)) {
          // refused as a whole (no single-item route for these): every line to rejected.jsonl, one log line, so the messages behind them are not held
          this.rejectRun(run.map(x => x.line), `${path} answered HTTP ${r.status} ${errCode(r.json) ? callSaid(r.json) : String(r.json?.error ?? JSON.stringify(r.json?.detail ?? '')).slice(0, 200)}`,
            { kind: k, path, status: r.status, code: errCode(r.json) })
          this.writeCursor(run[run.length - 1]!.end); this.ok()
          continue
        }
        return this.failStatus(r, path)
      }
      if (t.line.k === 'a') {
        // WO-145: a form answers' ack (the answers are already queued for the main; unacked, Onsen would hand them out again)
        const r = await this.post('/forms/ack', { ids: t.line.r.ids }, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (r.status >= 200 && r.status < 300) this.stats.posted++
        else if (refusedForGood(r)) this.reject(t.line, `HTTP ${r.status} ${callSaid(r.json)}`, { kind: 'a', path: '/forms/ack', status: r.status, code: errCode(r.json) })
        else return this.failStatus(r, '/forms/ack')
        this.writeCursor(t.end); this.ok(); i++
        continue
      }
      if (t.line.k === 'blocked') {
        const receipt = t.line.r
        const ids = new OnsenIds({ request: (m, p, b, ms) => this.request(m, p, b, ms) })
        const id = 'message_id' in receipt ? receipt.message_id : /^form-(\d+)$/.exec(receipt.client_msg_id)?.[1] ?? await ids.message(receipt.chat, receipt.client_msg_id)
        const path = id ? `/v1/messages/${encodeURIComponent(id)}/receipt` : ''
        const r = id ? await this.put(path, { handling: { state: 'blocked', blocked_by: 'usage_limit', retry_after: receipt.retry_after } }, cred)
          : { status: 404, json: { error: 'message no longer exists' } }
        if (r.status >= 200 && r.status < 300) this.stats.posted++
        else if (refusedForGood(r)) this.reject(t.line, `blocked receipt: HTTP ${r.status} ${callSaid(r.json)}`)
        else return this.failStatus(r, path)
        this.writeCursor(t.end); this.ok(); i++
        continue
      }
      if (t.line.k === 'item' || t.line.k === 'self') {
        const path = '/v1/members/' + encodeURIComponent(this.cfg.agent) + '/items'
        const r = await this.itemWrites.sync(path, t.line.r, this.mayWithdrawKeepwarm).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (!r) return
        if (r.status >= 200 && r.status < 300) this.stats.posted++
        else if (refusedForGood(r)) this.reject(t.line, `${t.line.r.item.kind} Item: HTTP ${r.status} ${callSaid(r.json)}`, { kind: 'item', path, status: r.status, code: errCode(r.json) })
        else return this.failStatus(r, path)
        this.itemWriteAck?.(t.line.r, r.status >= 200 && r.status < 300 ? r.json?.data : undefined)
        if (!t.line.r.outcome && !t.line.r.complete) this.onItemCreateSettled?.(t.line.r.key, r.status < 300 ? r.json?.data?.id : this.itemWrites.id(t.line.r.key))
        this.writeCursor(t.end)
        this.ok(); i++; continue
      }
      if (t.line.k === 'ir') {
        // The FIFO cursor can now pass a report acknowledged ahead of a stuck record.
        if (t.end <= this.reportedThrough) { this.writeCursor(t.end); i++; continue }
        const line = t.line.r
        // A C6 spool may outlive both its local claim and take mode. Migrate its wire body even without a watcher.
        const sid = line.body.session_id
        const body = claudeSessionId(sid) ? { ...line.body, session_id: this.cfg.roamer ? roamerSessionId(this.cfg.agent, sid) : 'main' } : line.body
        const path = '/v1/items/' + encodeURIComponent(line.item_id) + '/report'
        const key = ['ir', line.item_id, body.claim_id, body.outcome].map(encodeURIComponent).join(':')
        const r = await this.put(path, body, cred, undefined, { 'Idempotency-Key': key }).catch(e => ({ status: 0, json: { error: errText(e) } }))
        const ok = r.status === 200
        if (!ok) {
          const code = errCode(r.json)
          if (r.status === 409 && code === 'version_conflict') this.cfg.log('info', `onsen: late item report ${key}: version_conflict`)
          else if (refusedForGood(r)) this.reject(t.line, `PUT ${path}: HTTP ${r.status} ${callSaid(r.json)}`, { kind: 'ir', path, status: r.status, code })
          else return this.failStatus(r, path)
        }
        if (ok) this.itemWrites.observe(r.json?.data)
        this.itemAck?.(line, ok)
        this.writeCursor(this.readCursor(), t.end)
        this.itemReports = Math.max(0, this.itemReports - 1)
        this.ok(); i++; continue
      }
      if (t.line.k === 'c') {
        const c = t.line.r
        let id = c.call_id ?? ''
        if ('run_id' in c && !id) {
          // Resolve inside the spool so an outage before the lookup cannot lose the receipt.
          const path = callsForRun(c.run_id)
          const lookup = await this.get(path, cred, 'hook').catch(e => ({ status: 0, json: { error: errText(e) } }))
          if (lookup.status !== 200 && !refusedForGood(lookup)) return this.failStatus(lookup, path)
          const call = lookup.status === 200 && firstRunCall(lookup.json)
          if (!call) {
            this.reject(t.line, `GET ${path}: ${lookup.status === 200 ? 'no Call for this scheduler run' : callSaid(lookup.json)}`)
            this.writeCursor(t.end); this.ok(); i++; continue
          }
          id = String(call.id)
        }
        const r = await this.put(`/v1/calls/${encodeURIComponent(id)}/state`, c.body, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (r.status >= 200 && r.status < 300) {
          const st = r.json?.data?.state
          if (c.body.state && st && st !== c.body.state) this.stats.calls_unchanged++; else this.stats.calls_put++
          this.settleCall(c.idem, { fate: 'took', state: st ?? null })
        }
        // a step Onsen already has past (it took a reply, or a lane's exit row, first), a Call that is over, or (1.58.32) one this agent is not the
        // recipient of (403 not_authorized), a Call Onsen does not have (404): refused for good, not retried, nothing behind it held
        else if (refusedForGood(r)) {
          this.reject(t.line, `PUT /v1/calls/${id}/state ${c.body.state ?? 'result'}: HTTP ${r.status} ${callSaid(r.json)}`,
            { kind: 'c', path: `/v1/calls/${id}/state`, status: r.status, code: errCode(r.json) })
          this.settleCall(c.idem, { fate: 'refused', status: r.status, said: callSaid(r.json) })
        }
        else return this.failStatus(r, `/v1/calls/${id}/state`)
        this.writeCursor(t.end); this.ok(); i++
        continue
      }
      if (t.line.k === 'r') {
        // WO-192 (B): a reply written into Onsen first: what Telegram did with it. The same report again is a duplicate (200); 409: the message is
        // already delivered (a later failure is not taken) or was not written for delivery: settled either way, never retried
        const { message_id: mid, body } = t.line.r
        const r = await this.post(`/messages/${encodeURIComponent(String(mid))}/delivery`, body, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (r.status >= 200 && r.status < 300) { if (r.json?.duplicate) this.stats.duplicates++; else this.stats.delivery_reported++ }
        else if (r.status === 409) { this.stats.delivery_conflicts++; this.cfg.log('info', `onsen: delivery ${body.state} of Onsen message ${mid}: Onsen answered 409 (${callSaid(r.json)}); taken as delivered`) }
        else if (refusedForGood(r)) this.reject(t.line, `POST /messages/${mid}/delivery: HTTP ${r.status} ${callSaid(r.json)}`,
          { kind: 'r', path: `/messages/${mid}/delivery`, status: r.status, code: errCode(r.json) })
        else return this.failStatus(r, `/messages/${mid}/delivery`)
        this.writeCursor(t.end); this.ok(); i++
        continue
      }
      if (t.line.k === 'e') {
        const r = await this.post('/events', t.line.r, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
        if (r.status >= 200 && r.status < 300) { if (r.json?.duplicate) this.stats.duplicates++; else this.stats.posted++ }
        else if (refusedForGood(r)) this.reject(t.line, `HTTP ${r.status} ${callSaid(r.json)}`, { kind: 'e', path: '/events', status: r.status, code: errCode(r.json) })
        else return this.failStatus(r, '/events')
        this.writeCursor(t.end); this.ok(); i++
        continue
      }
      // a run of messages: one batch (≤500)
      const run: Array<{ line: SpoolLine; end: number }> = []
      while (i < todo.length && run.length < 500 && todo[i]!.line?.k === 'm') { run.push({ line: todo[i]!.line!, end: todo[i]!.end }); i++ }
      const items = await this.withFiles(run.map(x => x.line))         // WO-190: a message's files (attachment_file_ids), once stored
      const r = await this.post('/messages/batch', { items }, cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
      if (r.status >= 200 && r.status < 300 && Array.isArray(r.json?.results) && r.json.results.length === run.length) {
        for (let k = 0; k < run.length; k++) {
          const res = r.json.results[k]
          if (res && res.error == null && res.id != null) { if (res.duplicate) this.stats.duplicates++; else this.stats.posted++; continue }
          const said = `item refused: ${String(res?.error ?? 'no id in the answer').slice(0, 200)}`
          if (!items[k]!.attachment_file_ids) { this.reject(run[k]!.line, said, { kind: 'm', path: '/messages/batch', status: Number(res?.status ?? 0) || 0 }); continue }
          // WO-190: refused with its files: once more without them; Onsen not answering holds the spool at this line (the ones before it are in;
          // those after it went in too and come back as duplicates)
          const s = await this.withoutFiles(run[k]!.line, items[k]!, said, cred)
          if (s !== true) { if (k > 0) this.writeCursor(run[k - 1]!.end); return this.failStatus(s, '/messages') }
        }
        this.writeCursor(run[run.length - 1]!.end); this.ok()
        continue
      }
      if (refusedForGood(r)) {
        // the batch as a whole was refused: one by one, so one bad item does not hold the others
        for (let k = 0; k < run.length; k++) {
          const x = run[k]!
          const s = await this.post('/messages', items[k], cred).catch(e => ({ status: 0, json: { error: errText(e) } }))
          if (s.status >= 200 && s.status < 300) { if (s.json?.duplicate) this.stats.duplicates++; else this.stats.posted++ }
          else if (refusedForGood(s)) {
            const said = `HTTP ${s.status} ${callSaid(s.json)}`
            if (!items[k]!.attachment_file_ids) this.reject(x.line, said, { kind: 'm', path: '/messages', status: s.status, code: errCode(s.json) })
            else { const w = await this.withoutFiles(x.line, items[k]!, said, cred); if (w !== true) return this.failStatus(w, '/messages') }   // WO-190
          }
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
    if (credentialRefused(r)) {
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
      skipped: { count: this.skipped.count, last: this.skipped.last },        // 1.58.32: what Onsen refused for good, and the last of them
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
  async drawLine(o: { chat: string; clientMsgId: string | number; by: string; at?: string; timeoutMs?: number; conversationId?: string }): Promise<{ id: number | null; spooled: boolean; idem_key: string } | null> {
    if (!this.cfg.record) return null
    const idem_key = idemLine(this.cfg.agent, o.chat, o.clientMsgId)
    // WO-197 segment 2: a connector names the conversation (Onsen 0.35.8); off the connector the old client / chat form, as before
    const body: RestartLineDraw = o.conversationId
      ? { conversation_id: o.conversationId, idem_key, at: o.at ?? new Date().toISOString(), ...(o.by ? { by: o.by } : {}), client_msg_id: String(o.clientMsgId) }
      : { agent: this.cfg.agent, client: 'telegram', chat: o.chat, idem_key, at: o.at ?? new Date().toISOString(), by: o.by, client_msg_id: String(o.clientMsgId) }
    // first locally: the spool's answer respects the line at once, whatever Onsen does
    const all = this.readLines().filter(x => x.idem_key !== idem_key)
    all.push({ chat: o.chat, at: body.at, idem_key, client_msg_id: String(o.clientMsgId), by: o.by, id: null, lifted_at: null })
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
  async liftLine(o: { chat: string; lineId?: number | null; clientMsgId?: string | number | null; by: string; timeoutMs?: number; conversationId?: string }): Promise<{ lifted: boolean; spooled: boolean; nothing: boolean }> {
    const at = new Date().toISOString()
    const all = this.readLines()
    const idem = o.clientMsgId != null && o.clientMsgId !== '' ? idemLine(this.cfg.agent, o.chat, o.clientMsgId) : undefined
    let local = (o.lineId != null ? all.find(x => x.id === o.lineId && x.chat === o.chat) : undefined) ?? (idem ? all.find(x => x.idem_key === idem) : undefined)
    if (!local && o.lineId == null && !idem) local = all.filter(x => x.chat === o.chat && !x.lifted_at && !x.rejected).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
    if (local?.rejected) return { lifted: false, spooled: false, nothing: true }            // Onsen refused that draw: there is no line
    if (local) { local.lifted_at = at; local.lifted_by = o.by; this.writeLines(all) }
    const lineId = o.lineId ?? local?.id ?? null
    const body: RestartLineLift = { ...(o.conversationId ? { conversation_id: o.conversationId } : { agent: this.cfg.agent, client: 'telegram' as const, chat: o.chat }), at, by: o.by,
      ...(lineId != null ? { line_id: lineId } : {}) }
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
      if (refusedForGood(r)) {
        this.reject(line, `HTTP ${r.status} ${errCode(r.json) ? callSaid(r.json) : String(r.json?.error ?? JSON.stringify(r.json?.detail ?? '')).slice(0, 200)}`,
          { kind: 'l', path: '/restart-lines', status: r.status, code: errCode(r.json) })
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
    if (refusedForGood(r)) { this.reject(line, `HTTP ${r.status}`, { kind: 'u', path: '/restart-lines/lift', status: r.status, code: errCode(r.json) }); return true }
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
/** WO-197 (Chiron 18:46Z: chat_history printed 「轉傳自 [object Object]」 for tg:1159 and tg:1139): who a forwarded message came from, as the tag's
 *  forward_from names them. Onsen keeps forward_from as an object (fleet-core onsen._forward): {origin: <one line>} from the daemon's record
 *  ("tg:<id> @user Name", "hidden:<name>", "chat:<id> <title> (signature)", forwardFrom above) or the bridge's (the display name itself), or an object
 *  as sent; person_message gives the origin as one string. The username, else the name; the chat's title; the hidden sender's name; else as given */
export function forwardName(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['username', 'name', 'title', 'display_name']) if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim()
    if (o.origin != null) return forwardName(o.origin)
    return JSON.stringify(v)
  }
  const t = String(v).trim()
  const tg = /^tg:(\d+)(?: @(\S+))?(?: (.+))?$/.exec(t)
  if (tg) return tg[2] ?? tg[3]?.trim() ?? tg[1]!
  const hid = /^hidden:(.*)$/.exec(t)
  if (hid) return hid[1]!.trim() || 'hidden'
  const ch = /^chat:(-?\d+)(?: (.*?))?(?: \([^)]*\))?$/.exec(t)
  if (ch) return ch[2]?.trim() || ch[1]!
  return t
}
/** one message in full: a header line, the whole body, then its events */
export function formatFull(m: any, joey = ''): string {
  const extra = [m.kind && m.kind !== 'text' ? m.kind : '', m.status === 'failed' ? `沒送出${m.error ? `：${m.error}` : ''}` : '', m.edited ? '改過' : '',
    m.reply_to_client_msg_id != null ? `回覆 tg:${m.reply_to_client_msg_id}` : '', m.forward_from ? `轉傳自 ${forwardName(m.forward_from)}` : '', m.thread ? `話題 ${m.thread}` : '']
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
/** The member registered for this roamer. Existing installations name their bot with underscores. */
export function roamerMember(env: NodeJS.ProcessEnv): string | undefined {
  if (!isRoamerEnv(env)) return
  const name = env.LANES_AGENT?.trim() || env.ROAMER_BOT_NAME?.trim().toLowerCase().replace(/^@|_?bot$/g, '').replace(/_/g, '-')
  if (name && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return name
}
/** ONSEN_RECORD: on unless 0 / off / false / no */
export function recordOn(env: NodeJS.ProcessEnv): boolean {
  const v = (env.ONSEN_RECORD ?? '').trim().toLowerCase()
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no')
}
/** A local-polling roamer starts with recording off. Its own member may record after the take handover. */
export const isRoamerEnv = (env: NodeJS.ProcessEnv): boolean => (env.ROAMER_MODE ?? '').trim() === '1'
/** ONSEN_AGENTS (the canary switch): a comma list of agent names, or `*` (unset = `*`). Recording runs only for an agent in it, and only with ONSEN_RECORD on;
 *  a roamer also needs a confirmed connector handover. */
export function recordFor(env: NodeJS.ProcessEnv, agent: string, roamerConnector = false): boolean {
  if (!recordOn(env) || (isRoamerEnv(env) && !roamerConnector)) return false
  const list = (env.ONSEN_AGENTS ?? '*').split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}
export const onsenBase = (env: NodeJS.ProcessEnv): string => ((env.ONSEN_BASE ?? '').trim() || 'https://core.kbro.ai/api/onsen').replace(/\/+$/, '')

// ------------------------------------------------------------------ WO-176: Actions (Onsen client API v1 /v1/actions; fleet-core onsen_actions.py)
// A thing waiting on a person's decision that this daemon relays: a Claude Code permission prompt, a menu the duty officer asks about; and a menu the duty
// officer pressed itself (made resolved, assignees duty-officer). The daemon makes the Action, reports a press in Telegram (resolve, then applied; Onsen
// answered first: applied with what was really pressed), a press it made for Onsen (applied), and a menu that went away (cancel). Every call is
// best-effort: it runs in the background (nothing here is awaited by a Telegram send or by Claude Code's answer), 5 s each, two more tries after a
// transport failure, a 5xx or a 429; it never throws. The calls of one Action run in order, its create first; an Action Onsen never made takes no other
// call. ONSEN_ACTIONS (a comma list of agent names or `*`; unset = every agent; 0 = none) is the stop switch for making new ones.
export const ACTION_CONTROL_KIND = 'action_control'
export const ACTION_CONTROL_SENDER = 'onsen'
export type ActionOption = { id: string; label: string }
export type ActionSource = 'permission' | 'menu'
export type NewAction = { source: ActionSource; menu_kind?: string | null; session_id?: string | null; assignees: string[]; summary: string
  body?: string | null; options: ActionOption[]
  /** WO-197 segment 2 (CONTRACT §7d 「幾秒內有效的選項」): when it stops being an answer; Onsen marks it expired then (Onsen 0.36.0: expiry is Onsen's) */
  expires_at?: string
  /** Onsen 0.36.0 (WO-196, Chiron mesh 12917): the line Onsen writes into its note when nobody answered by expires_at (what happens then); one line,
   *  2000 characters at most; sent only with expires_at on an open Action (anything else is Onsen's 400), else dropped */
  expiry_note?: string
  /** the duty officer's own press: made resolved (the option it pressed, resolved_by duty-officer), applied at once; `at` (WO-176 r3, Onsen 0.24.3):
   *  when the keys were sent (resolved_at and applied_at), `opened_at`: when the menu appeared (created_at) */
  resolved?: { option_id: string; by: string; at?: string; opened_at?: string } }
export type ActionReq = (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number, headers?: Record<string, string>) => Promise<{ status: number; json: any } | null>
export type ActionState = 'pending' | 'open' | 'resolved' | 'expired' | 'cancelled' | 'failed'
/** an Action control item's payload (onsen_actions.py _control) */
export type ActionControl = { action_id: string; option_id: string; version: number }
/** Telegram user ids → Onsen member names (fleet-core onsen.py HUMAN_ALIASES); anyone else has no name Onsen knows */
export const TG_MEMBERS: Readonly<Record<string, string>> = { '1828173984': 'joey', '6736970916': 'joey-test' }
export const memberOfTg = (id: unknown): string | null => TG_MEMBERS[String(id ?? '')] ?? null
/** 1.58.13: the person on a Telegram account, for a DM thread's title (lanes-threads.ts): the Onsen member that account is (memberOfTg, the mapping the
 *  blockers' person and every Action's assignees go through; an account that is no member: Onsen's guest name tg-<id>), by its display name (GET
 *  /v1/members/<name>), else its member name. personOf → null while it is not known yet: asked once per member; when the answer (or no answer) is in,
 *  `changed` runs (server.ts: Lanes.refreshDmTitles) */
export class MemberNames {
  private names = new Map<string, string | null>()                      // member → display name ('' none, or not answered; null: being asked)
  constructor(readonly o: { get: (name: string) => Promise<{ status: number; json: any } | null>; changed: () => void; log?: (m: string) => void }) {}
  personOf(chat: string): string | null {
    const member = memberOfTg(chat) ?? `tg-${chat}`
    if (!this.names.has(member)) {
      this.names.set(member, null)
      void (async () => {
        let d = ''
        try {
          const r = await this.o.get(member)
          const m = r && r.status === 200 ? (r.json?.data ?? r.json) : null
          if (m && typeof m.display_name === 'string') d = m.display_name.replace(/\s+/g, ' ').trim().slice(0, 40)
        } catch (e) { this.o.log?.(`onsen: the display name of ${member}: no answer (${errText(e)}); its member name is used`) }
        this.names.set(member, d)
        try { this.o.changed() } catch {}
      })()
      return null
    }
    const d = this.names.get(member)
    return d == null ? null : (d || member)
  }
}
/** the assignees of a question sent to these Telegram chats: the members among them (in order, once each), else joey */
export function assigneesOf(chats: unknown[]): string[] {
  const out: string[] = []
  for (const c of chats) { const m = memberOfTg(c); if (m && !out.includes(m)) out.push(m) }
  return out.length ? out : ['joey']
}
/** ONSEN_ACTIONS: unset or empty = on; 0 / off / false / no = off; else a comma list of agent names or `*` */
/** WO-175: ONSEN_CALL_STATE, the stop switch of the Call moments this agent's daemon reports (on unless 0 / off / false / no; a comma list: those
 *  agents, or `*`). On, the two old start receipts (a lane taking a scheduled run, the main binding it into a turn) are gone: the moments replace them */
export function callStateOn(env: NodeJS.ProcessEnv, agent: string): boolean {
  const v = (env.ONSEN_CALL_STATE ?? '').trim()
  if (!v) return true
  if (['0', 'off', 'false', 'no'].includes(v.toLowerCase())) return false
  const list = v.split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}
export function actionsOn(env: NodeJS.ProcessEnv, agent: string): boolean {
  const v = (env.ONSEN_ACTIONS ?? '').trim()
  if (!v) return true
  if (['0', 'off', 'false', 'no'].includes(v.toLowerCase())) return false
  const list = v.split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}
/** an action_control item's payload, checked: {action_id (digits), option_id, version}; null when it is not one */
export function actionControlOf(p: unknown): ActionControl | null {
  const o = (p ?? {}) as Record<string, unknown>
  const id = typeof o.action_id === 'number' ? String(o.action_id) : o.action_id
  if (typeof id !== 'string' || !/^\d{1,18}$/.test(id)) return null
  if (typeof o.option_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/.test(o.option_id)) return null
  if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) return null
  return { action_id: id, option_id: o.option_id, version: o.version }
}
/** one line of at most n characters */
/** Onsen 0.36.0 NOTE_MAX: an expiry_note's length at most */
export const EXPIRY_NOTE_MAX = 2000
export const actionLine = (s: unknown, n: number): string => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…' }

/** one Action as this daemon follows it. id / version: null / 0 until Onsen made it; `tail`: its calls, in order */
export class ActionHandle {
  id: string | null = null
  version = 0
  state: ActionState = 'pending'
  appliedAt: string | null = null
  /** the option Onsen has as answered (selected_option_id) */
  selected: string | null = null
  tail: Promise<void> = Promise.resolve()
  constructor(readonly key: string, public source: ActionSource | null, public assignees: string[], public menu_kind: string | null, readonly made = Date.now()) {}
  /** a name in its assignees: `who` when it is one, else the first */
  assignee(who: string | null | undefined): string { return who && this.assignees.includes(who) ? who : this.assignees[0] ?? (who || 'joey') }
}
type CallResult = { status: number; json: any } | null

export class OnsenActions {
  readonly stats = { created: 0, resolved: 0, applied: 0, cancelled: 0, conflicts: 0, failed: 0, skipped: 0, last_error: null as string | null }
  private byKey = new Map<string, ActionHandle>()
  private byId = new Map<string, ActionHandle>()
  private credWarnAt = 0
  private callErr = ''
  constructor(readonly o: { req: ActionReq; log: Log; on?: boolean | (() => boolean); takeMode?: Pick<TakeMode, 'active'>; timeoutMs?: number; retryMs?: number[]; keep?: number }) {}
  /** making new Actions (ONSEN_ACTIONS); the calls about one that exists go on either way. WO-197 (Chiron mesh 12852): a function is asked each time
   *  (server.ts: a connector's Actions are on whatever ONSEN_ACTIONS says, from the moment it is named) */
  get on(): boolean { const v = this.o.on; return typeof v === 'function' ? v() !== false : v !== false }

  /** a new Action (returns at once; Onsen makes it in the background). `made`: called once Onsen gave it an id. null: off, or not a valid Action */
  open(a: NewAction, key: string, made?: (h: ActionHandle) => void): ActionHandle | null {
    if (!this.on) return null
    const why = !a.assignees.length ? 'no assignee' : !a.options.length ? 'no option' : a.options.length > 10 ? 'more than 10 options' : !actionLine(a.summary, 200) ? 'no summary' : ''
    if (why) { this.stats.skipped++; this.o.log('info', `onsen action: not made (${why}): ${key}`); return null }
    const h = new ActionHandle(key, a.source, a.assignees, a.menu_kind ?? null)
    this.keep(h)
    this.queue(h, async () => {
      const body: Record<string, unknown> = { source: a.source, assignees: a.assignees, summary: actionLine(a.summary, 200),
        options: a.options.map(x => ({ id: x.id, label: actionLine(x.label, 80) || x.id })) }
      if (a.menu_kind !== undefined) body.menu_kind = a.menu_kind
      if (a.session_id) body.session_id = String(a.session_id).slice(0, 120)
      if (a.body) body.body = { format: 'markdown', text: a.body.length > 4000 ? a.body.slice(0, 3999) + '…' : a.body }
      if (a.expires_at) body.expires_at = a.expires_at
      const xnote = a.expires_at && !a.resolved ? actionLine(a.expiry_note, EXPIRY_NOTE_MAX) : ''
      if (xnote) body.expiry_note = xnote
      if (a.resolved) Object.assign(body, { state: 'resolved', selected_option_id: a.resolved.option_id, resolved_by: a.resolved.by })
      if (a.resolved?.at) body.resolved_at = a.resolved.at
      if (a.resolved?.opened_at) body.opened_at = a.resolved.opened_at
      const r = await this.call('POST', '/v1/actions', body, { 'Idempotency-Key': key })
      if (r && (r.status === 201 || r.status === 200) && r.json?.data?.id != null) {
        this.take(h, r.json.data)
        this.stats.created++
        this.o.log('info', `onsen action ${h.id}: made (${a.source}${a.menu_kind ? ` ${a.menu_kind}` : ''}, ${h.state}${a.resolved ? ` ${a.resolved.option_id} by ${a.resolved.by}` : ''}, for ${a.assignees.join(',')})`)
        try { made?.(h) } catch {}
      } else {
        h.state = 'failed'
        this.fail(`create ${key}`, r)
      }
    })
    return h
  }
  /** the handle of an Action this process did not make (a control item, an ask kept on disk): the one it has, else a new one at that version */
  adopt(id: string, version: number, key?: string): ActionHandle {
    const had = this.byId.get(id) ?? (key ? this.byKey.get(key) : undefined)
    if (had) { if (had.id == null) { had.id = id; this.byId.set(id, had) } if (version > had.version) had.version = version; return had }
    const h = new ActionHandle(key ?? `adopted:${id}`, null, [], null)
    h.id = id; h.version = version; h.state = 'open'
    this.keep(h)
    return h
  }
  find(key?: string | null, id?: string | null): ActionHandle | undefined { return (key ? this.byKey.get(key) : undefined) ?? (id ? this.byId.get(id) : undefined) }

  /** pressed in Telegram by `by` (a member): resolve, then applied; Onsen answered first (409): applied with what was really pressed. `at` (Onsen
   *  0.24.3): when it was pressed (resolved_at, and applied's at). `asIs` (WO-176 r3): `by` is sent as it is, not taken for an assignee (the duty
   *  officer pressing a permission prompt on the screen: Onsen 0.24.3 takes resolved_by duty-officer on a permission / menu Action). `where`
   *  (WO-197, lab 18:0xZ): where it was pressed, for the log line (`in Telegram`; the duty officer's press: `on the screen by the duty officer`) */
  pressedElsewhere(h: ActionHandle | null | undefined, option_id: string, by: string, at?: string, asIs = false, where = 'in Telegram'): void {
    if (!h) return
    this.queue(h, async () => {
      if (!h.id) return
      const who = asIs ? by : h.assignee(by)
      const r = await this.call('POST', `/v1/actions/${h.id}/resolve`, { option_id, expected_version: h.version, resolved_by: who, ...(at ? { at } : {}) })
      if (r?.status === 200) { this.take(h, r.json?.data); this.stats.resolved++; this.o.log('info', `onsen action ${h.id}: resolved ${option_id} by ${who} (pressed ${where})`) }
      else if (r?.status === 409) { this.stats.conflicts++; this.o.log('info', `onsen action ${h.id}: answered in Onsen first (${errOf(r)}); reporting what was pressed ${where} (${option_id})`) }
      else { this.fail(`resolve ${h.id}`, r); return }
      await this.appliedNow(h, { ...(at ? { at } : {}), ...(r?.status === 409 ? { option_id, resolved_by: who } : {}) })
    })
  }
  /** this daemon pressed the answer (for Onsen's control item, or the answer Telegram gave before it came: option_id and resolved_by) */
  applied(h: ActionHandle | null | undefined, o: { at?: string; option_id?: string; resolved_by?: string } = {}): void {
    if (!h) return
    this.queue(h, () => this.appliedNow(h, o))
  }
  /** the menu went away, the session closed, or nothing was pressed: cancelled (an open Action, or one answered in Onsen and not applied). A version that
   *  moved meanwhile is read once and tried again */
  cancel(h: ActionHandle | null | undefined, reason: string): void {
    if (!h) return
    this.queue(h, async () => {
      if (!h.id || h.state === 'cancelled' || h.state === 'expired' || h.appliedAt) return
      // WO-197 (Onsen 0.35.8, CONTRACT §7d): `note` is what the Action shows (the bridge draws it; without it only 「→ 已取消」); `reason` its event's
      const why = actionLine(reason, 300)
      let r = await this.call('POST', `/v1/actions/${h.id}/cancel`, { expected_version: h.version, reason: why, note: why })
      if (r?.status === 409) {
        const g = await this.call('GET', `/v1/actions/${h.id}`)
        const d = g?.status === 200 ? g.json?.data : null
        if (d && (d.state === 'open' || (d.state === 'resolved' && !d.applied_at)) && Number(d.version) !== h.version) {
          this.take(h, d)
          r = await this.call('POST', `/v1/actions/${h.id}/cancel`, { expected_version: h.version, reason: why, note: why })
        } else if (d) this.take(h, d)
      }
      if (r?.status === 200) { this.take(h, r.json?.data); this.stats.cancelled++; this.o.log('info', `onsen action ${h.id}: cancelled (${actionLine(reason, 120)})`) }
      else if (r?.status === 409) { this.stats.conflicts++; this.o.log('info', `onsen action ${h.id}: not cancelled, already over (${errOf(r)})`) }
      else this.fail(`cancel ${h.id}`, r)
    })
  }
  /** WO-176 r2 (Onsen 0.24.0 join): a question to people about an Action that already stands for it (the duty officer asking about a permission prompt):
   *  the ones not yet assignees are added (POST /v1/actions {action_id, assignees}, 200 with the Action; a change moves its version, which the handle
   *  follows). Nothing to add, or the Action not open: no call. `done` hears the handle after the join (or at once when there was nothing to add) */
  join(h: ActionHandle | null | undefined, assignees: string[], done?: (h: ActionHandle) => void): void {
    if (!h) return
    this.queue(h, async () => {
      const add = assignees.filter(x => !h.assignees.includes(x))
      if (h.id && h.state === 'open' && add.length) {
        const r = await this.call('POST', '/v1/actions', { action_id: h.id, assignees })
        if (r?.status === 200) { this.take(h, r.json?.data); this.o.log('info', `onsen action ${h.id}: joined by ${add.join(',')} (v${h.version})`) }
        else if (r?.status === 409) { this.stats.conflicts++; this.o.log('info', `onsen action ${h.id}: not joined, not open (${errOf(r)})`) }
        else this.fail(`join ${h.id}`, r)
      }
      try { done?.(h) } catch {}
    })
  }
  /** WO-176 r2: the newest open Action this agent asked that `pred` takes (GET /v1/actions?requested_by=<agent>&state=open, one try, 3 s), as a handle
   *  (its key `<prefix><id>`); null: none, or Onsen did not answer */
  async findOpen(agent: string, pred: (d: any) => boolean, keyPrefix = 'adopted:'): Promise<ActionHandle | null> {
    const d = (await this.listOpen(agent)).filter(pred).sort((a, b) => Number(b.id) - Number(a.id))[0]
    return d ? this.adoptData(d, keyPrefix) : null
  }
  /** WO-176 r4: this agent's open Actions as Onsen has them (one GET, 3 s; [] when Onsen does not answer) */
  async listOpen(agent: string): Promise<any[]> {
    try {
      const r = await this.o.req('GET', `/v1/actions?requested_by=${encodeURIComponent(agent)}&state=open`, undefined, 3000)
      const items: any[] = r?.status === 200 && Array.isArray(r.json?.items) ? r.json.items : []
      return items.filter(x => x && x.state === 'open' && /^\d{1,18}$/.test(String(x.id ?? '')))
    } catch { return [] }
  }
  /** a handle for an Action as Onsen gave it (listOpen's item) */
  adoptData(d: any, keyPrefix = 'adopted:'): ActionHandle {
    const h = this.adopt(String(d.id), Number(d.version) || 1, `${keyPrefix}${d.id}`)
    this.take(h, d)
    return h
  }
  /** who answered it in Onsen (resolved_by), for the closing line in Telegram; null: not known within 3 s */
  async resolver(id: string): Promise<string | null> {
    try {
      const r = await this.o.req('GET', `/v1/actions/${id}`, undefined, 3000)
      const d = r?.status === 200 ? r.json?.data : null
      return d && typeof d.resolved_by === 'string' ? d.resolved_by : null
    } catch { return null }
  }
  /** the newest Action still open of these (made by this process, Onsen has it) */
  newestOpen(pred: (h: ActionHandle) => boolean): ActionHandle | null {
    let best: ActionHandle | null = null
    for (const h of this.byKey.values()) if (h.id && h.state === 'open' && pred(h) && (!best || h.made >= best.made)) best = h
    return best
  }
  health(): Record<string, unknown> { return { on: this.on, ...this.stats, followed: this.byKey.size } }

  private async appliedNow(h: ActionHandle, o: { at?: string; option_id?: string; resolved_by?: string }): Promise<void> {
    if (!h.id || this.o.takeMode?.active) return
    if (h.appliedAt && (!o.option_id || o.option_id === h.selected)) return   // WO-176 r2: applied is reported once
    const r = await this.call('POST', `/v1/actions/${h.id}/applied`, o)
    if (r?.status === 200) { this.take(h, r.json?.data); this.stats.applied++; this.o.log('info', `onsen action ${h.id}: applied${o.option_id ? ` ${o.option_id}` : ''}`) }
    else if (r?.status === 409) { this.stats.conflicts++; this.o.log('info', `onsen action ${h.id}: applied not recorded (${errOf(r)})`) }
    else this.fail(`applied ${h.id}`, r)
  }
  private take(h: ActionHandle, d: any): void {
    if (!d || typeof d !== 'object') return
    if (d.id != null && h.id == null) { h.id = String(d.id); this.byId.set(h.id, h) }
    if (Number.isInteger(d.version)) h.version = d.version
    if (typeof d.state === 'string') h.state = d.state as ActionState
    if (d.applied_at !== undefined) h.appliedAt = d.applied_at ?? null
    if (d.selected_option_id !== undefined) h.selected = d.selected_option_id ?? null
    if (Array.isArray(d.assignees) && d.assignees.every((x: unknown) => typeof x === 'string')) h.assignees = d.assignees
    if (h.source == null && (d.source === 'permission' || d.source === 'menu')) h.source = d.source
    if (h.menu_kind == null && typeof d.menu_kind === 'string') h.menu_kind = d.menu_kind
  }
  private keep(h: ActionHandle): void {
    this.byKey.set(h.key, h)
    if (h.id) this.byId.set(h.id, h)
    const max = this.o.keep ?? 500
    while (this.byKey.size > max) {
      const k = this.byKey.keys().next().value!
      const old = this.byKey.get(k)
      this.byKey.delete(k)
      if (old?.id && this.byId.get(old.id) === old) this.byId.delete(old.id)
    }
  }
  private queue(h: ActionHandle, fn: () => Promise<void>): void {
    h.tail = h.tail.then(fn).catch(e => { this.stats.failed++; this.o.log('warn', `onsen action ${h.id ?? h.key}: ${e instanceof Error ? e.message : e}`) })
  }
  /** one call, tried again after a transport failure, a 5xx or a 429 (retryMs, default 1 s and 4 s); null: no credential, or every try failed */
  private async call(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<CallResult> {
    const waits = this.o.retryMs ?? [1000, 4000]
    let last: CallResult = null, lastErr = ''
    this.callErr = ''
    for (let i = 0; i <= waits.length; i++) {
      if (i) await new Promise(r => { const t = setTimeout(r, waits[i - 1]); (t as any).unref?.() })
      try {
        const r = await this.o.req(method, path, body, this.o.timeoutMs ?? 5000, headers)
        if (!r) {
          if (Date.now() - this.credWarnAt > HOUR) { this.credWarnAt = Date.now(); this.o.log('warn', 'onsen action: no mesh credential; Actions are not reported to Onsen') }
          return null
        }
        last = r
        if (r.status < 500 && r.status !== 429) return r
      } catch (e) { lastErr = e instanceof Error ? e.message : String(e) }
    }
    if (!last && lastErr) this.callErr = lastErr.slice(0, 160)
    return last
  }
  private fail(what: string, r: CallResult): void {
    this.stats.failed++
    this.stats.last_error = `${what}: ${r ? `HTTP ${r.status} ${errOf(r)}` : this.callErr || 'no answer'}`.slice(0, 200)
    this.o.log('warn', `onsen action: ${this.stats.last_error}`)
  }
}
const errOf = (r: CallResult): string => { const e = r?.json?.error; return e && typeof e === 'object' ? `${e.code ?? ''} ${actionLine(e.message, 140)}`.trim() : actionLine(r?.json?.detail ?? '', 140) }

// ------------------------------------------------------------------ WO-176 r4: which permission prompt the duty officer is pressing
/** a channel permission prompt still open, as the binder sees it: its key (the prompt's Action key), its tool, its input preview, when its request came */
export type OpenPrompt = { key: string; tool: string; preview: string; opened: number }
const toolTail = (t: string): string => t.split('__').pop() ?? t
const sameTool = (a: string, b: string): boolean => !!a && !!b && (a === b || toolTail(a) === toolTail(b))
/** the waiting call's input fits a prompt's input preview (Claude Code's input_preview: JSON, maybe cut): each field the preview shows starts the same */
export function previewFits(preview: string, input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const inp = input as Record<string, unknown>
  const head = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/…$/, '').slice(0, 60)
  try {
    const pv = JSON.parse(preview)
    if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
      const keys = Object.keys(pv)
      return keys.length > 0 && keys.every(k => k in inp && (head(inp[k]).startsWith(head(pv[k]).slice(0, 40)) || head(pv[k]).startsWith(head(inp[k]).slice(0, 40))))
    }
  } catch {}
  const p = String(preview ?? '').slice(0, 60)
  return !!p && JSON.stringify(inp).includes(p.slice(1, 40))
}
/** WO-176 r4 (Chiron 06:00Z: 「值班員決定要按的那一刻就記下它看的是哪一個詢問…按完只結那一個；找不到對應的就什麼都不記」): the permission prompt the duty
 *  officer is looking at when it decides to press. Only prompts whose request came by `now` (the moment of deciding: a prompt the next screen brings is
 *  never it) count; the tool call waiting in the transcript (the officer's evidence) picks by its tool, then by its input when several share the tool;
 *  with no such evidence, only a single open prompt. One that fits: its key. None open: 'none' (nothing of the channel's to answer). Several, or
 *  none that fits: 'unsure' (nothing is recorded on any of them; the channel's own close or cancel ends them) */
export function bindPrompt(prompts: OpenPrompt[], waiting: { tool?: unknown; input?: unknown } | null | undefined, now: number): { key: string } | 'none' | 'unsure' {
  const c = prompts.filter(p => p.opened <= now + 1000)
  if (!c.length) return 'none'
  const tool = typeof waiting?.tool === 'string' ? waiting.tool : ''
  if (!tool) return c.length === 1 ? { key: c[0]!.key } : 'unsure'
  const byTool = c.filter(p => sameTool(p.tool, tool))
  if (byTool.length === 1) return { key: byTool[0]!.key }
  if (!byTool.length) return 'unsure'
  const byInput = byTool.filter(p => previewFits(p.preview, waiting?.input))
  return byInput.length === 1 ? { key: byInput[0]!.key } : 'unsure'
}
