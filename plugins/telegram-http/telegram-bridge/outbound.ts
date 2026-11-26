// outbound.ts: Onsen → Telegram (WO-196 part B, ticket item 3; CONTRACT §7d 「出」). Each BridgeItem of GET /v1/bridge/feed is drawn on the bot of
// its member, the way that agent's daemon draws it today:
//
//   message         the text in parts (access.json textChunkLimit ≤ 4096; a Rich Message, plain sendMessage when that fails), author_label as
//                   the first line, then each file as its own message (sendPhoto for a picture, else sendDocument; the file taken from Onsen with
//                   the bridge's credential, Onsen's own address only), reply_to on the first part (access.json replyToMode), silent when Onsen
//                   says so, when it is older than 15 min, and for an echo. An echo: the person's own message said in another client
//                   (origin_client is not telegram), drawn 「〔你在 Onsen 傳的〕」 + the text. Then POST /v1/messages/<id>/delivery
//                   {client:"telegram", state:"sent", client_msg_ids, at, error:null}. A send that fails is tried again 10 s, 30 s and 2 min
//                   later (a 429: its retry_after), only the parts not yet out; then `failed` with the ids that did go. A part Telegram did not
//                   answer in time is not sent again (it may have arrived): failed at once, its error starting `timeout` (Onsen: bridge_unknown).
//                   A report Onsen does not take is sent again every 10 s.
//   message_edit    the parts edited in place (rich, then plain); fewer parts: the extra ones deleted; more: the rest sent silently
//   reaction        the member's reaction on the person's message (one emoji: a bot's limit); the ✍ never lands on top of it
//   receipt         delivered: typing; in_session: ✍ (the daemon's SeenReactor) and typing; turn_end: nothing. Older than 15 min: dropped;
//                   typing only within 10 s. The pinned status's line 2 counts from these.
//   action          its summary and body, a button per option (oa:<key>), or a link button for a form, in the assignee's DM; then
//                   POST /v1/bridge/actions/<id>/delivery {client_user_id, client_msg_ids}; action_resolved: the buttons give way to the line
//                   「→ <option label>（<who>）」 (已取消 / 已過期)
//   observation     the pinned status message of that DM (onsen-visible.ts StatusPin: sent and pinned silently once, then edited at most every
//                   5 s); only the newest of a batch; one older than 15 min dropped
//   restart_line, thread, commands: stage-two.ts (DrawDeps.extra)
import type { Agent } from './agent.ts'
import { retryable, errSaid, type OnsenClient } from './onsen.ts'
import type { Progress, RetryRec, StateStore } from './state.ts'
import { editText, labelParts, MAX_CHUNK_LIMIT, sendTextParts, type Button } from './tg-format.ts'
import { errText, TgError, TgTimeout } from './tg.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export const OLD_MS = 15 * 60_000
export const RETRY_DELAYS_MS = [10_000, 30_000, 120_000]
const PHOTO_MIME = /^image\/(jpe?g|png|gif|webp)$/i
const PHOTO_EXT = /\.(jpe?g|png|gif|webp)$/i
const ONSEN_FILE_MAX = 25 * 1024 * 1024

export type DrawDeps = {
  onsen: OnsenClient
  state: StateStore
  log: Log
  agentOf: (member: string) => Agent | null
  useRich: boolean
  now?: () => number
  /** a member's display name (the outcome line's "by") */
  nameOf?: (member: string) => string
  /** stage two: the item types this file does not draw */
  extra?: (a: Agent, item: any) => Promise<boolean>
  /** a thread's topic in a chat, or the label its messages are drawn under when it has none (stage-two.ts threadOf) */
  threadOf?: (member: string, chat: string, thread: string) => { client_thread: string | null; label: string | null }
  /** the countdown's tick (1 s; tests may shorten it) */
  tickMs?: number
  /** the waits before the 2nd, 3rd, 4th try of a send (default RETRY_DELAYS_MS) */
  retryDelaysMs?: number[]
}

/** a client's name as the echo says it */
const clientName = (c: string): string => c === 'onsen' ? 'Onsen' : c

class Permanent extends Error {}

export class Drawer {
  private lanes = new Map<string, Promise<void>>()
  readonly stats = { items: 0, drawn: 0, failed: 0, retried: 0, reports: 0, reports_failed: 0, skipped: 0 }
  constructor(readonly d: DrawDeps) {}
  private now(): number { return (this.d.now ?? Date.now)() }
  private get st() { return this.d.state.data }

  /** run `fn` after everything queued for the same member and chat (Telegram order within a chat); never rejects */
  lane(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.lanes.get(key) ?? Promise.resolve()
    const p = prev.then(fn).catch(e => this.d.log('error', `drawing in ${key}: ${errText(e)}`))
    this.lanes.set(key, p)
    void p.finally(() => { if (this.lanes.get(key) === p) this.lanes.delete(key) })
    return p
  }
  /** one feed item, in its chat's order; resolves when its first try is over (sent, failed, or waiting for a retry) */
  enqueue(item: any): Promise<void> {
    this.stats.items++
    return this.lane(`${item?.member}:${item?.chat}`, () => this.draw(item))
  }
  /** the items of one feed batch to draw: every observation but the newest of its member and chat goes */
  static coalesce(items: any[]): any[] {
    const last = new Map<string, number>()
    items.forEach((it, i) => { if (it?.type === 'observation') last.set(`${it.member}:${it.chat}`, i) })
    return items.filter((it, i) => it?.type !== 'observation' || last.get(`${it.member}:${it.chat}`) === i)
  }

  async draw(item: any): Promise<void> {
    const a = item?.member ? this.d.agentOf(String(item.member)) : null
    if (!a) { this.stats.skipped++; this.d.log('warn', `feed item ${item?.seq} (${item?.type}) is for ${item?.member}, which this bridge does not carry now: not drawn`); return }
    try {
      switch (item.type) {
        case 'message': return await this.drawMessage(a, item)
        case 'message_edit': return await this.drawEdit(a, item)
        case 'reaction': return await this.drawReaction(a, item)
        case 'receipt': return await this.drawReceipt(a, item)
        case 'action': return await this.drawAction(a, item)
        case 'action_resolved': return await this.drawResolved(a, item)
        case 'observation': {
          if (this.now() - Date.parse(item.at) > OLD_MS) return
          a.observe(String(item.chat), item.status)
          return
        }
        default:
          if (this.d.extra && await this.d.extra(a, item)) return
          this.stats.skipped++
          this.d.log('warn', `feed item ${item.seq}: type ${item.type} is not drawn by this version`)
      }
    } catch (e) { this.d.log('warn', `${a.member}: drawing feed item ${item.seq} (${item.type}) in chat ${item.chat} failed: ${errText(e)}`) }
  }

  private conf(a: Agent): { limit: number; mode: 'length' | 'newline'; replyMode: 'off' | 'first' | 'all' } {
    const acc = a.access()
    return {
      limit: Math.max(1, Math.min(acc?.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT)),
      mode: this.d.useRich ? 'newline' : (acc?.chunkMode ?? 'length'),
      replyMode: acc?.replyToMode ?? 'first',
    }
  }

  // ---- message -------------------------------------------------------------------------------------------------------------------
  async drawMessage(a: Agent, item: any, rec?: RetryRec): Promise<void> {
    const msg = item.message ?? {}, id = String(msg.id ?? '')
    if (!id) { this.d.log('warn', `${a.member}: feed item ${item.seq} is a message without an id: not drawn`); return }
    if (this.st.sent[id] && !rec) { this.d.log('info', `${a.member}: message ${id} was drawn already (ids ${[...this.st.sent[id]!.text, ...this.st.sent[id]!.files].join(', ')}): not again`); return }
    const chat = String(item.chat)
    const echo = !!item.origin_client && item.origin_client !== 'telegram'
    const isDm = /^\d+$/.test(chat)
    let label: string | null = echo ? (isDm ? `〔你在 ${clientName(item.origin_client)} 傳的〕` : `〔${this.d.nameOf?.(String(msg.from)) ?? msg.from} 在 ${clientName(item.origin_client)} 傳的〕`) : (item.author_label ?? null)
    const old = this.now() - Date.parse(item.at) > OLD_MS
    const silent = !!item.silent || echo || old
    const c = this.conf(a)
    const replyTo = c.replyMode !== 'off' && /^\d+$/.test(String(item.reply_to_client_msg_id ?? '')) ? Number(item.reply_to_client_msg_id) : null
    let threadId = /^\d+$/.test(String(item.client_thread ?? '')) ? Number(item.client_thread) : null
    // a message of a thread (item.thread, Onsen's thread id) with no topic given: the bridge's own topic for it, else the main chat under the
    // thread's name (CONTRACT §7d: a thread a client cannot draw stays in Onsen; its messages are drawn in the main chat with the thread's name)
    if (threadId == null && item.thread != null && this.d.threadOf) {
      const t = this.d.threadOf(a.member, chat, String(item.thread))
      if (t.client_thread && /^\d+$/.test(t.client_thread)) threadId = Number(t.client_thread)
      else if (t.label) label = label ? `${t.label} ${label}` : t.label
    }
    const text = String(msg.body?.text ?? '')
    const files: any[] = Array.isArray(msg.attachments) ? msg.attachments : []
    const parts = text || label || !files.length ? labelParts(label, text, c.limit, this.d.useRich, c.mode) : { rich: [], plain: [] }
    const progress: Progress = rec?.progress ?? { text: [], files: [] }
    let fileError: string | null = null
    try {
      if (progress.text.length < parts.plain.length) {
        await sendTextParts(a.tg, chat, parts, { useRich: this.d.useRich, silent, threadId, replyTo, replyAll: c.replyMode === 'all', sent: progress.text, startAt: progress.text.length })
      }
      for (let i = progress.files.length; i < files.length; i++) {
        const f = files[i]
        const got = f?.url ? await this.d.onsen.getFile(String(f.url), ONSEN_FILE_MAX) : { error: 'Onsen keeps no copy of it (url null)', retry: false }
        if ('error' in got) {
          if (got.retry) throw new Error(`file ${f?.name ?? i + 1}: ${got.error}`)
          fileError = `file ${f?.name ?? i + 1} not sent: ${got.error}`
          this.d.log('warn', `${a.member}: message ${id}: ${fileError}`)
          progress.files.push(-1)
          continue
        }
        const name = String(f.name || `file-${i + 1}`)
        const photo = PHOTO_MIME.test(String(f.mime ?? got.mime ?? '')) || (!f.mime && PHOTO_EXT.test(name))
        const r = await a.tg.upload(photo ? 'sendPhoto' : 'sendDocument', {
          chat_id: chat, ...(replyTo != null && (c.replyMode === 'all' || (progress.text.length === 0 && i === 0)) ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
          ...(silent ? { disable_notification: true } : {}), ...(threadId != null ? { message_thread_id: threadId } : {}),
        }, got.bytes, name, f.mime ?? got.mime)
        progress.files.push(Number(r.message_id))
      }
    } catch (e) {
      return this.sendFailed(a, item, progress, rec, e)
    }
    // done: every part went (a file Onsen could not give us is the one exception: reported failed with the rest)
    const fileIds = progress.files.filter(n => n > 0)
    this.st.sent[id] = { member: a.member, chat, text: progress.text, files: fileIds, label, at: this.now() }
    if (rec) this.st.retries = this.st.retries.filter(r => r !== rec)
    this.d.state.dirty()
    this.stats.drawn++; a.stats.drawn++
    if (!echo) a.pending.out(chat, msg.type === 'system' ? 'system' : String(msg.from ?? a.member), this.now())
    a.redrawPin(chat)
    const ids = [...progress.text, ...fileIds].map(String)
    await this.report(id, fileError ? { client: 'telegram', state: 'failed', client_msg_ids: ids, at: new Date(this.now()).toISOString(), error: fileError }
      : { client: 'telegram', state: 'sent', client_msg_ids: ids, at: new Date(this.now()).toISOString(), error: null })
  }

  private async sendFailed(a: Agent, item: any, progress: Progress, rec: RetryRec | undefined, e: unknown): Promise<void> {
    const id = String(item.message.id)
    const why = (e instanceof TgTimeout ? 'timeout: ' : '') + errText(e)        // CONTRACT §7d: a timeout's error starts with `timeout` (Onsen: bridge_unknown)
    const attempt = (rec?.attempt ?? 0) + 1
    const timeout = e instanceof TgTimeout
    const permanent = e instanceof Permanent || (e instanceof TgError && (e.code === 400 || e.code === 403 || e.code === 401 || e.code === 404))
    const r429 = e instanceof TgError && e.code === 429 ? Math.max(1, e.retryAfter ?? 5) * 1000 : null
    const delays = this.d.retryDelaysMs ?? RETRY_DELAYS_MS
    if (timeout || permanent || attempt > delays.length) {
      if (rec) this.st.retries = this.st.retries.filter(r => r !== rec)
      this.d.state.dirty()
      this.stats.failed++; a.stats.draw_failed++
      this.d.log('warn', `${a.member}: message ${id} to chat ${item.chat} failed after ${attempt} tr${attempt > 1 ? 'ies' : 'y'} (${why}); ${progress.text.length + progress.files.filter(n => n > 0).length} part(s) went: reported failed`)
      const ids = [...progress.text, ...progress.files.filter(n => n > 0)].map(String)
      await this.report(id, { client: 'telegram', state: 'failed', client_msg_ids: ids, at: new Date(this.now()).toISOString(), error: why })
      return
    }
    const delay = r429 ?? delays[attempt - 1]!
    const next: RetryRec = { item, attempt, due: this.now() + delay, progress, lastError: why }
    if (rec) this.st.retries = this.st.retries.filter(r => r !== rec)
    this.st.retries.push(next)
    this.d.state.dirty()
    this.stats.retried++
    this.d.log('warn', `${a.member}: message ${id} to chat ${item.chat}: ${why}; tried again in ${Math.round(delay / 1000)} s (try ${attempt + 1})`)
  }

  /** POST /api/onsen/v1/messages/<id>/delivery; one Onsen does not take now is kept and sent again */
  async report(messageId: string, body: Record<string, unknown>, tries = 0): Promise<boolean> {
    let ok = false, keep = false, said = ''
    try {
      const r = await this.d.onsen.req('POST', `/messages/${encodeURIComponent(messageId)}/delivery`, body)
      ok = r.status >= 200 && r.status < 300
      keep = !ok && retryable(r)
      said = `HTTP ${r.status || 'no credential'} ${errSaid(r)}`
    } catch (e) { keep = true; said = errText(e) }
    if (ok) { this.stats.reports++; return true }
    if (keep) {
      if (tries === 0) this.d.log('warn', `delivery report of message ${messageId} (${body.state}) not taken (${said}); sent again every 10 s`)
      this.st.reports = this.st.reports.filter(x => x.message_id !== messageId || x.body.state !== body.state)
      this.st.reports.push({ message_id: messageId, body, tries: tries + 1, due: this.now() + 10_000 })
      if (this.st.reports.length > 2000) this.st.reports.splice(0, this.st.reports.length - 2000)
    } else {
      this.stats.reports_failed++
      this.d.log('warn', `delivery report of message ${messageId} (${body.state}) refused: ${said}; dropped`)
    }
    this.d.state.dirty()
    return false
  }

  /** every second: the retries and reports that are due */
  async tick(): Promise<void> {
    const t = this.now()
    for (const r of [...this.st.retries]) {
      if (r.due > t) continue
      r.due = Infinity                       // taken: not picked again while it runs
      const a = this.d.agentOf(String(r.item.member))
      if (!a) { this.st.retries = this.st.retries.filter(x => x !== r); this.d.state.dirty(); continue }
      void this.lane(`${r.item.member}:${r.item.chat}`, () => this.drawMessage(a, r.item, r))
    }
    for (const x of [...this.st.reports]) {
      if (x.due > t) continue
      this.st.reports = this.st.reports.filter(y => y !== x)
      await this.report(x.message_id, x.body, x.tries)
    }
  }

  // ---- the other types -------------------------------------------------------------------------------------------------------------
  async drawEdit(a: Agent, item: any): Promise<void> {
    const chat = String(item.chat), rec = this.st.sent[String(item.message_id)]
    const ids: number[] = rec?.text?.length ? rec.text : (Array.isArray(item.client_msg_ids) ? item.client_msg_ids : []).map(Number).filter((n: number) => n > 0)
    if (!ids.length) { this.d.log('warn', `${a.member}: an edit of message ${item.message_id}: no Telegram message of it is known; not drawn`); return }
    const c = this.conf(a)
    const parts = labelParts(rec?.label ?? null, String(item.text ?? ''), c.limit, this.d.useRich, c.mode)
    const n = Math.min(ids.length, parts.plain.length)
    for (let i = 0; i < n; i++) await editText(a.tg, chat, ids[i]!, { rich: parts.rich[i]!, plain: parts.plain[i]! }, this.d.useRich)
    const kept = ids.slice(0, n)
    for (const extra of ids.slice(n)) { try { await a.tg.call('deleteMessage', { chat_id: chat, message_id: extra }) } catch (e) { this.d.log('warn', `${a.member}: deleting part ${extra} of an edited message: ${errText(e)}`) } }
    if (parts.plain.length > n) {
      const more = await sendTextParts(a.tg, chat, { rich: parts.rich.slice(n), plain: parts.plain.slice(n) }, { useRich: this.d.useRich, silent: true, replyTo: ids[0] })
      kept.push(...more)
    }
    if (rec) { rec.text = kept; this.d.state.dirty() }
  }

  async drawReaction(a: Agent, item: any): Promise<void> {
    const chat = String(item.chat), id = String(item.client_msg_id ?? '')
    if (!/^\d+$/.test(id)) return
    a.seen.agentReacted(chat, id)
    await a.seen.settle(chat, id)
    const emojis: string[] = Array.isArray(item.emojis) ? item.emojis.map(String) : []
    const last = emojis[emojis.length - 1]
    await a.tg.call('setMessageReaction', { chat_id: chat, message_id: Number(id), reaction: last ? [{ type: 'emoji', emoji: last }] : [] })
  }

  async drawReceipt(a: Agent, item: any): Promise<void> {
    const age = this.now() - Date.parse(item.at)
    const chat = String(item.chat), id = String(item.client_msg_id ?? '')
    if (!(age <= OLD_MS) || !id) return
    const fresh = age <= 10_000
    const typing = () => a.tg.call('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {})
    if (item.state === 'delivered') {
      a.pending.fact({ chat, client_msg_id: id, state: 'delivered', at: item.at } as any)
      if (fresh) await typing()
    } else if (item.state === 'in_session') {
      a.pending.fact({ chat, client_msg_id: id, state: 'seen', at: item.at } as any)
      a.seen.seen(chat, id, 'main')
      if (fresh) await typing()
    }
    a.redrawPin(chat)
  }

  async drawAction(a: Agent, item: any): Promise<void> {
    const act = item.action ?? {}, chat = String(item.chat), aid = String(act.id ?? '')
    if (!aid) return
    const key = `${aid}:${chat}`
    if (this.st.actions[key]) return                                           // drawn already (a restart inside the batch)
    // the person it is drawn for: assignee_client_user_id (Onsen 0.35.1), else the first of assignee_client_user_ids (0.35.0), else the DM's chat
    const who = String(item.assignee_client_user_id ?? (Array.isArray(item.assignee_client_user_ids) ? item.assignee_client_user_ids[0] : null) ?? chat)
    // a connector's menu (source menu: /model and the like) is the one message: its body and the buttons; anything else: the summary above the body
    const bodyText = String(act.body?.text ?? '').trim()
    const text = (act.source === 'menu' && bodyText ? bodyText : [String(act.summary ?? '').trim(), bodyText].filter(Boolean).join('\n\n')) || '（要你決定的事）'
    // an open Action that ends in less than 60 s: each button shows the seconds left, counted down once a second (the 1.58.19 /clear countdown)
    const exp = act.expires_at ? Date.parse(String(act.expires_at)) : NaN
    const left0 = Number.isFinite(exp) ? Math.ceil((exp - this.now()) / 1000) : null
    const counting = left0 != null && left0 > 0 && left0 < 60 && act.kind !== 'form'
    let rows: Array<Array<{ text: string; callback_data: string }>> = []
    let keyboard: Button[][] | undefined
    if (act.state === 'open' || act.state == null) {
      if (act.kind === 'form' && act.form?.url) keyboard = [[{ text: '打開表單', url: String(act.form.url) }]]
      else if (Array.isArray(act.options) && act.options.length) {
        const btns = act.options.map((o: any) => {
          const k = (++this.st.keySeq).toString(36)
          this.st.keys[k] = { member: a.member, action: aid, option: String(o.id), label: String(o.label ?? o.id), at: this.now() }
          return { text: String(o.label ?? o.id).slice(0, 60), callback_data: `oa:${k}` }
        })
        const short = btns.length <= 3 && btns.every((b: Button) => [...b.text].length <= 12)
        rows = short ? [btns] : btns.map((b: Button) => [b])
        keyboard = counting ? withLeft(rows, left0!) : rows
      }
    }
    const c = this.conf(a)
    const parts = labelParts(null, text, c.limit, this.d.useRich, c.mode)
    const ids = await sendTextParts(a.tg, chat, parts, { useRich: this.d.useRich, keyboard, silent: this.now() - Date.parse(item.at) > OLD_MS })
    this.st.actions[key] = { member: a.member, chat, msgs: ids, text, at: this.now() }
    this.d.state.dirty()
    if (counting && rows.length && ids.length) {
      const last = ids[ids.length - 1]!, tick = this.d.tickMs ?? 1000
      for (let n = left0! - 1; n >= 0; n--) {
        const t = setTimeout(() => {
          if (this.st.actions[key]?.done) return                               // answered or ended meanwhile: action_resolved draws it
          void a.tg.call('editMessageReplyMarkup', { chat_id: chat, message_id: last, reply_markup: { inline_keyboard: n > 0 ? withLeft(rows, n) : [] } })
            .catch(e => this.d.log('warn', `${a.member}: Action ${aid} countdown (${n}) in chat ${chat}: ${errText(e)}`))
        }, (left0! - n) * tick)
        ;(t as any).unref?.()
      }
    }
    // CONTRACT §7d: which messages it became, so action_resolved can name them (after a restart too)
    try {
      const r = await this.d.onsen.req('POST', `/bridge/actions/${encodeURIComponent(aid)}/delivery`, { client_user_id: who, client_msg_ids: ids.map(String) })
      if (r.status < 200 || r.status >= 300) this.d.log('warn', `${a.member}: POST /bridge/actions/${aid}/delivery: HTTP ${r.status} ${errSaid(r)}`)
    } catch (e) { this.d.log('warn', `${a.member}: POST /bridge/actions/${aid}/delivery: ${errText(e)}`) }
  }

  async drawResolved(a: Agent, item: any): Promise<void> {
    const aid = String(item.action_id ?? ''), chat = String(item.chat)
    const rec = this.st.actions[`${aid}:${chat}`]
    const ids: number[] = (Array.isArray(item.client_msg_ids) && item.client_msg_ids.length ? item.client_msg_ids : rec?.msgs ?? []).map(Number).filter((n: number) => n > 0)
    const last = ids[ids.length - 1]
    if (last == null) return
    const line = resolvedLine(item, m => this.d.nameOf?.(m) ?? m)
    if (rec) {
      rec.done = true; this.d.state.dirty()                                    // first: a countdown edit still to come leaves it alone
      const c = this.conf(a)
      const parts = labelParts(null, `${rec.text}\n\n${line}`, c.limit, this.d.useRich, c.mode)
      const i = parts.plain.length - 1
      await editText(a.tg, chat, last, { rich: parts.rich[i]!, plain: parts.plain[i]! }, this.d.useRich, null)
    } else {
      // drawn before a restart that lost its text: the buttons go, the outcome follows as a silent reply to it
      await a.tg.call('editMessageReplyMarkup', { chat_id: chat, message_id: last, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      await a.tg.call('sendMessage', { chat_id: chat, text: line, disable_notification: true, reply_parameters: { message_id: last, allow_sending_without_reply: true } })
    }
  }
}

/** the buttons with the seconds left after each label: 「✅ Allow（5）」 */
export function withLeft(rows: Array<Array<{ text: string; callback_data: string }>>, n: number): Button[][] {
  return rows.map(r => r.map(b => ({ ...b, text: `${b.text}（${n}）` })))
}

/** the line under an Action that ended: the option chosen and who chose it; cancelled / expired with the Action's note when it has one (what
 *  happens instead, e.g. 「沒按：新的一段看得到之前的對話」), else as such (outcome is the Action's state) */
export function resolvedLine(item: any, nameOf: (m: string) => string): string {
  const by = item.by ? nameOf(String(item.by)) : ''
  const o = String(item.outcome ?? '')
  const note = String(item.note ?? item.action?.note ?? '').replace(/\s+/g, ' ').trim()
  if ((o === 'cancelled' || o === 'expired') && note) return `→ ${note}`
  const what = o === 'cancelled' ? '已取消' : o === 'expired' ? '已過期' : String(item.option_label ?? item.option_id ?? (o && o !== 'resolved' ? o : '已回答'))
  return `→ ${what}${by && o !== 'expired' ? `（${by}）` : ''}`
}
