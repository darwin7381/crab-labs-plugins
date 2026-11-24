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
// The credential (the agent's mesh credential, read from the agent-inbox daemon's state dir) is never logged, printed or written anywhere.

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'

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
  kind: 'edit' | 'reaction' | 'retract'; actor: string; body?: string; data?: Record<string, unknown>; at: string
}
type SpoolLine = { k: 'm'; r: OnsenItem } | { k: 'e'; r: OnsenEvent }

export const idemIn = (agent: string, chat: string, id: string | number): string => `tg:${agent}:${chat}:in:${id}`
export const idemOut = (agent: string, chat: string, id: string | number): string => `tg:${agent}:${chat}:out:${id}`
export const idemOutFailed = (agent: string, chat: string): string => `tg:${agent}:${chat}:out-failed:${randomUUID()}`

// ------------------------------------------------------------------ who is sending (server.ts sets it around each send path)
export type SendCtx = { sender: string; part?: number; parts?: number; richAttempt?: boolean }
const als = new AsyncLocalStorage<SendCtx>()
/** run `fn` with `sender` as the author of every Telegram call it makes */
export function withSender<T>(sender: string, fn: () => T): T { return als.run({ sender }, fn) }
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
    const body = method === 'editMessageText' ? String(payload.text ?? payload.rich_message?.markdown ?? '') : undefined
    const emoji = method === 'setMessageReaction' ? (Array.isArray(payload.reaction) && payload.reaction[0] ? payload.reaction[0].emoji ?? payload.reaction[0].custom_emoji_id ?? null : null) : undefined
    return { k: 'e', r: {
      idem_key: `tg:${agent}:${chat}:${kind}:${target}:${randomUUID()}`, agent, client: 'telegram', chat, target_client_msg_id: target, kind, actor: ctx.sender,
      ...(body !== undefined ? { body } : {}), ...(method === 'setMessageReaction' ? { data: { emoji } } : {}), at,
    } }
  }
  const kind = OUT_KIND[method]!
  const body = String(method === 'sendRichMessage' ? payload.rich_message?.markdown ?? '' : method === 'sendMessage' ? payload.text ?? '' : payload.caption ?? '')
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

const RETRYABLE_4XX = new Set([401, 403, 408, 425, 429])
const HOUR = 3600_000
const READ_WINDOW = 1 << 20          // bytes read from the cursor per pass

export class OnsenClient {
  readonly spool: string
  readonly spoolOld: string
  readonly cursorFile: string
  readonly rejected: string
  private running = false
  private again = false
  private kickTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private backoffMs = 0
  private nextTryAt = 0
  private credWarnAt = 0
  private appendWarnAt = 0
  private authWarnAt = 0
  readonly stats = { recorded: 0, posted: 0, duplicates: 0, rejected: 0, last_ok_at: null as string | null, last_error: null as string | null }

  constructor(readonly cfg: OnsenConfig) {
    this.spool = join(cfg.dir, 'spool.jsonl')
    this.spoolOld = join(cfg.dir, 'spool.1.jsonl')
    this.cursorFile = join(cfg.dir, 'cursor.json')
    this.rejected = join(cfg.dir, 'rejected.jsonl')
  }
  private get f(): typeof fetch { return this.cfg.fetch ?? fetch }

  // ---------------------------------------------------------------- recording (the send path: never throws, never waits)
  recordMessage(item: OnsenItem): void { this.append({ k: 'm', r: item }) }
  recordEvent(ev: OnsenEvent): void { this.append({ k: 'e', r: ev }) }
  recordLine(line: SpoolLine | null): void { if (line) this.append(line) }
  private append(line: SpoolLine): void {
    if (!this.cfg.record) return
    try {
      mkdirSync(this.cfg.dir, { recursive: true, mode: 0o700 })
      appendFileSync(this.spool, JSON.stringify(line) + '\n', { mode: 0o600 })
      this.stats.recorded++
      this.kick()
    } catch (e) {
      if (Date.now() - this.appendWarnAt > HOUR) { this.appendWarnAt = Date.now(); this.cfg.log('warn', `onsen: could not append to the spool (${errText(e)}); this record is lost`) }
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
  private headers(cred: string, extra: Record<string, string> = {}): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${cred}`, 'User-Agent': `onsen-telegram/${this.cfg.agent}`, ...extra }
  }
  private async post(path: string, body: unknown, cred: string): Promise<{ status: number; json: any }> {
    const r = await this.f(`${this.cfg.base}${path}`, { method: 'POST', headers: this.headers(cred), body: JSON.stringify(body), signal: AbortSignal.timeout(this.cfg.postTimeoutMs ?? 15_000) })
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
        try { const j = JSON.parse(raw); if ((j.k === 'm' || j.k === 'e') && j.r) line = j } catch {}
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
    return { record: this.cfg.record, base: this.cfg.base, pending_bytes: this.pendingBytes(), backoff_s: Math.round(this.backoffMs / 1000), ...this.stats }
  }

  // ---------------------------------------------------------------- chat_history
  async queryHistory(a: HistoryArgs): Promise<string> {
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
          const row = await this.fetchOne(id, chat, cred)
          if (row) return formatFull(row, joey)
          return `Onsen 裡找不到 ${id}${chat ? `（chat ${chat}）` : ''}。`
        }
        const p = new URLSearchParams({ agent: this.cfg.agent, limit: String(limit) })
        if (chat) p.set('chat', chat)
        if (since) p.set('since', since)
        if (until) p.set('until', until)
        if (q) p.set('q', q)
        const r = await this.get(`/messages?${p}`, cred)
        if (r.status === 200 && Array.isArray(r.json?.messages)) {
          const rows = r.json.messages as any[]
          return formatList(rows, typeof r.json.total === 'number' ? r.json.total : rows.length, joey)
        }
        why = `Onsen 回 HTTP ${r.status}`
      } catch (e) {
        why = e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`) ? `Onsen ${Math.round((this.cfg.queryTimeoutMs ?? 4000) / 1000)} 秒內沒回應` : `Onsen 連不上（${errText(e).slice(0, 80)}）`
      }
    }
    return this.localHistory({ limit, since, until, q, id, chat }, why, joey)
  }
  private async get(path: string, cred: string): Promise<{ status: number; json: any }> {
    const r = await this.f(`${this.cfg.base}${path}`, { headers: this.headers(cred, { 'X-Onsen-Via': 'tool' }), signal: AbortSignal.timeout(this.cfg.queryTimeoutMs ?? 4000) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
  /** one message in full: an Onsen id; `tg:<n>` (the Telegram alias in `chat`); a bare number: the Onsen id first, then the alias */
  private async fetchOne(id: string, chat: string | undefined, cred: string): Promise<any | null> {
    const tg = /^tg:(\d+)$/i.exec(id)
    if (!tg) {
      const r = await this.get(`/messages/${encodeURIComponent(id)}`, cred)
      if (r.status === 200 && r.json && typeof r.json === 'object') return r.json.message ?? r.json
      if (r.status !== 404 && r.status !== 400) throw new Error(`HTTP ${r.status}`)
      if (!/^\d+$/.test(id)) return null
    }
    if (!chat) return null
    const msgId = tg ? tg[1]! : id
    const r = await this.get(`/alias/telegram/${encodeURIComponent(this.cfg.agent)}/${encodeURIComponent(chat)}/${msgId}`, cred)
    if (r.status === 404) return null
    if (r.status !== 200 || !r.json) throw new Error(`HTTP ${r.status}`)
    const j = r.json.message ?? r.json
    if (j && (j.body != null || Array.isArray(j.events))) return j
    const oid = j?.id ?? j?.message_id
    if (oid == null) return null
    const full = await this.get(`/messages/${encodeURIComponent(String(oid))}`, cred)
    return full.status === 200 && full.json ? full.json.message ?? full.json : null
  }

  /** the local answer: this daemon's spool (and its previous generation), messages with their edits applied */
  private localHistory(o: { limit: number; since?: string; until?: string; q?: string; id?: string; chat?: string }, why: string, joey: string): string {
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
    if (o.id) {
      const tg = /^tg:(\d+)$/i.exec(o.id)?.[1] ?? (/^\d+$/.test(o.id) ? o.id : undefined)
      const m = tg ? [...msgs.values()].find(x => x.client_msg_id === tg && (!o.chat || x.chat === o.chat)) : undefined
      return m ? `${head}\n${formatFull(m, joey)}` : `${head}\n本機暫存裡找不到 ${o.id}。`
    }
    const sinceMs = o.since ? Date.parse(o.since) : -Infinity, untilMs = o.until ? Date.parse(o.until) : Infinity
    const ql = o.q?.toLowerCase()
    const all = [...msgs.values()].filter(m => (!o.chat || m.chat === o.chat) && Date.parse(m.at) >= sinceMs && Date.parse(m.at) <= untilMs && (!ql || String(m.body).toLowerCase().includes(ql)))
      .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    const rows = all.slice(0, o.limit).map(m => {
      const b = String(m.body ?? '')
      return [...b].length > CUT ? { ...m, body: [...b].slice(0, CUT).join(''), truncated: true } : m
    })
    return `${head}\n${formatList(rows, all.length, joey)}`
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
function lineOf(m: any, joey: string): string {
  let body = oneLine(String(m.body ?? ''))
  if ([...body].length > CUT && !m.truncated) body = [...body].slice(0, CUT).join('')
  const cut = m.truncated || [...oneLine(String(m.body ?? ''))].length > CUT
  const flags = `${m.status === 'failed' ? '（沒送出）' : ''}${m.edited ? '（改過）' : ''}`
  return `${whenUtc(m.at)}｜${whoOf(m, joey)}｜${ref(m)}｜${flags}${body}${cut ? '…（全文用 id 取）' : ''}`
}
/** the list: rows newest first as the API gives them, shown oldest first */
export function formatList(rows: any[], total: number, joey = ''): string {
  if (!rows.length) return `沒有符合的訊息。\n共 ${total} 則，顯示 0 則`
  const shown = [...rows].reverse().map(m => lineOf(m, joey))
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
    return `- ${whenUtc(e.at)} ${who} ${e.kind}`
  })
  return `${whenUtc(m.at)}｜${whoOf(m, joey)}｜${ref(m)}${extra ? `｜${extra}` : ''}\n${String(m.body ?? '')}${att}${evLines.length ? `\n事件：\n${evLines.join('\n')}` : ''}`
}

export { CHAT_HISTORY_TOOL } from './onsen-tool.ts'

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
