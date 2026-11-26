// inbound.ts: one bot's long poll inside telegram-bridge (WO-196 part B, ticket item 2): Telegram → Onsen's bridge interface (CONTRACT §7d 「進」).
//
//   poll      getUpdates with allowed_updates message, edited_message, callback_query, message_reaction (Telegram sends a person's reactions only
//             when asked). An update is confirmed to Telegram (the next call's offset passes it) only once it is done: written into Onsen, or
//             one that needs no write (a button, /start, a pairing reply, a dropped message). The first update not done holds the offset, so
//             nothing unwritten is ever confirmed: a restart gets it again.
//   gate      that agent's own access.json, as its daemon reads it (tg-access.ts): DM allowlist and pairing, group policy and mentions.
//   write     a person's message: its file fetched from Telegram (≤ 20 MB, onsen-files.ts telegramFile) and stored with POST /v1/files, a voice
//             note's local transcript (whisper, as the daemon's CHANNEL_BOT_VOICE_TRANSCRIBE), then POST /v1/bridge/messages (idem_key
//             tg:<agent>:<chat>:<message id>). Only when Onsen took it: 👀 (access.json ackReaction; unset = 👀, '' = none) and done. An edit:
//             POST /v1/bridge/messages/edit; a reaction: POST /v1/bridge/reactions. Writes go strictly in order, one at a time per bot.
//   Onsen down a write Onsen does not take (no answer, 5xx, 429, 401, 404 no_endpoint) is tried again (2 s, 4 s, then every 5 s) and holds every
//             later write of this bot. A person's message not written 15 s after it came gets one reply: 「Onsen 現在連不上，這一則還沒交給 <agent>；
//             連上會自動補交，不用重傳。」 (once per message, remembered across restarts). Nothing is dropped and nothing written twice (the idem_key).
//   refused   403 not_allowed (unknown_identity before Onsen 0.35.1): not tried again, nothing answered, done. 400: not tried again; in a DM one reply
//             saying it was not handed over.
//   local     /start and /help in a DM: the bridge answers (the daemon's text). Any other /command goes to Onsen as a message, kind `command`.
//             A button: an Action's option → POST /v1/bridge/actions/<id>/resolve; 「不要顯示這則」 under the pinned status → dismissed here.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { expandHiddenEntities } from '../entities.ts'
import { forwardFrom, inboundShape } from '../onsen-client.ts'
import { mimeOf, telegramFile, TG_BOT_FILE_MAX } from '../onsen-files.ts'
import { richToMarkdown } from '../rich-inbound.ts'
import type { Agent } from './agent.ts'
import { errCode, errSaid, retryable, type Answer, type OnsenClient } from './onsen.ts'
import type { StateStore } from './state.ts'
import { approvals, dmCommandGate, doneApproval, gate, mayAct, pairingText, PAIRED_TEXT } from './tg-access.ts'
import { displayName, mediaKindLabel, metaExcerpt, safeName } from './tg-format.ts'
import { errText, TgError } from './tg.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'message_reaction']
export const SORRY_MS = 15_000
export const sorryText = (name: string): string => `Onsen 現在連不上，這一則還沒交給 ${name}；連上會自動補交，不用重傳。`
export const START_TEXT = `This bot bridges Telegram to a Claude Code session.\n\nTo pair:\n1. DM me anything — you'll get a 6-char code\n2. In Claude Code: /telegram:access pair <code>\n\nAfter that, DMs here reach that session.`
export const HELP_TEXT = `Messages you send here route to a paired Claude Code session. Text and photos are forwarded; replies and reactions come back.\n\n/start — pairing instructions\n/status — check your pairing state`

type Entry = { u: any; id: number; done: boolean; kind: 'write' | 'local'; arrivedAt: number; cache: Record<string, any>; tries: number; nextAt: number }

export type PollerDeps = {
  onsen: OnsenClient
  state: StateStore
  log: Log
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** a button press: the Action and option behind its key (outbound.ts keeps them) */
  buttonKey?: (key: string) => { member: string; action: string; option: string; label: string } | null
  /** the endpoint list must be sent again (a write answered 404 no_endpoint) */
  reRegister?: () => void
  /** the topic names seen (stage two) */
  topicName?: (member: string, chat: string, thread: string) => string | null
  noteTopic?: (member: string, chat: string, thread: string, name: string) => void
  /** a button the outbound side owns (the restart line, stage two); true = handled */
  onButton?: (a: Agent, cq: any) => Promise<boolean>
  voice?: { on: boolean; cmd: string; whisper: string; model: string; dir: string }
  pollTimeoutS?: number
  /** the Onsen-down sentence after this long (default SORRY_MS, 15 s) */
  sorryMs?: number
  /** a member leaving the list got Telegram's 409 (its daemon polls the bot now): the bridge lets it go (called once, after this loop ended) */
  onHandover?: (a: Agent) => void
  /** shared by the bridge's pollers: until when client_meta is left out (an Onsen that does not take it yet answered 400 naming it) */
  clientMeta?: { offUntil: number }
}
/** how long an album's items are waited for after its newest one arrived (server.ts ALBUM_WINDOW_MS, 1.5 s), so media_group_count is known */
export const ALBUM_MS = 1_500
const CLIENT_META_MAX = 4_000
const META_UNKNOWN = /(不收的欄位|unknown)[^；;]*client_meta/i

/** the facts of a person's Telegram message that §7d's named fields do not carry, under the attribute names server.ts puts on the <channel> tag
 *  (CONTRACT §7d client_meta; the connector turns each key into that attribute). Values as the daemon writes them (strings). */
/** forward_from as the daemon's <channel> tag writes it (server.ts replyForwardMeta): the person's display name, a hidden sender's name, the
 *  chat's or channel's title; the kind, ids and username stay in client_meta (Chiron 15:40Z: one standard field, no second raw key) */
export function tagForwardFrom(m: any): string | null {
  const fo = m?.forward_origin
  if (!fo) return forwardFrom(m) ?? null                                   // an older update shape: what the record path gave
  if (fo.type === 'user' && fo.sender_user) return displayName(fo.sender_user)
  if (fo.type === 'hidden_user') return safeName(fo.sender_user_name) ?? 'hidden'
  if (fo.type === 'chat' && fo.sender_chat) return safeName(fo.sender_chat.title ?? fo.sender_chat.username) || String(fo.sender_chat.id)
  if (fo.type === 'channel' && fo.chat) return safeName(fo.chat.title ?? fo.chat.username) || String(fo.chat.id)
  return null
}

/** a Telegram 409 (another program still polls the bot, e.g. its daemon handing it over): look again this often (Chiron 18:00Z) */
export const TG_CONFLICT_RETRY_MS = 3_000

export function clientMetaOf(m: any, o: { fromReply?: boolean; transcript?: string | null; imageError?: boolean; albumCount?: number } = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const rt = m?.reply_to_message && !m.reply_to_message.forum_topic_created ? m.reply_to_message : null
  if (rt?.from) out.reply_to_user_id = String(rt.from.id)                          // server.ts replyForwardMeta (1.58.24 :3937)
  // the tag's reply_to_user (the Telegram name); the standard field carries the same, but the person_message's reply_to.from is the member
  // name when Onsen has the replied-to message, so the connector lets this key win (Chiron 12794, WO-197 check 3)
  if (rt) { const ru = rt.from ? displayName(rt.from) : rt.sender_chat ? (safeName(rt.sender_chat.title ?? rt.sender_chat.username) || String(rt.sender_chat.id)) : null; if (ru) out.reply_to_user = ru }
  if (rt && o.fromReply) out.attachment_origin = 'reply'                             // :3947
  const fo = m?.forward_origin
  if (fo) {
    out.forward_origin = String(fo.type)                                             // :3953
    if (fo.type === 'user' && fo.sender_user) {
      out.forward_from_id = String(fo.sender_user.id)                                // :3956
      if (fo.sender_user.username) out.forward_from_username = safeName(fo.sender_user.username)!   // :3957
    } else if (fo.type === 'chat' && fo.sender_chat) {
      out.forward_from_id = String(fo.sender_chat.id)                                // :3962
    } else if (fo.type === 'channel' && fo.chat) {
      out.forward_from_id = String(fo.chat.id)                                       // :3965
      if (fo.chat.username) out.forward_from_username = safeName(fo.chat.username)!  // :3966
      if (fo.message_id != null) out.forward_channel_message_id = String(fo.message_id)   // :3967
    }
  }
  if (o.imageError) out.image_error = 'download failed'                             // :4280 (one photo), :4478 (an album's)
  if (o.albumCount && o.albumCount > 0 && m?.media_group_id) out.media_group_count = String(o.albumCount)   // flushAlbum :4465
  if (o.transcript) out.voice_transcript = o.transcript                             // :4297 (maybeTranscribeVoice :4582: metaExcerpt, 500)
  // ≤ 4 KB as JSON (Onsen's limit; counted in UTF-8 bytes): the transcript, the only long value, is cut until it fits (… marks the cut)
  const bytes = () => new TextEncoder().encode(JSON.stringify(out)).length
  while (bytes() > CLIENT_META_MAX && out.voice_transcript && out.voice_transcript.length > 1) out.voice_transcript = out.voice_transcript.slice(0, Math.floor(out.voice_transcript.length * 0.9)) + '…'
  if (bytes() > CLIENT_META_MAX) delete out.voice_transcript
  return out
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(r => {
  if (signal.aborted) return r()
  const t = setTimeout(() => { signal.removeEventListener('abort', done); r() }, ms)
  const done = () => { clearTimeout(t); r() }
  signal.addEventListener('abort', done, { once: true })
})

export class Poller {
  private entries = new Map<number, Entry>()
  private ac = new AbortController()
  running = false
  private loopP: Promise<void> | null = null
  /** the first time Onsen did not take a write, while it still does not (null: it takes them) */
  failingSince: number | null = null
  private backoff = 0
  readonly stats = { polls: 0, updates: 0, written: 0, failed_tries: 0, conflicts: 0 }
  constructor(readonly a: Agent, readonly d: PollerDeps) {}
  private now(): number { return (this.d.now ?? Date.now)() }
  private sleep(ms: number): Promise<void> { return (this.d.sleep ?? defaultSleep)(ms, this.ac.signal) }

  start(): void {
    if (this.running) return
    this.running = true
    this.ac = new AbortController()
    this.loopP = this.loop().catch(e => this.d.log('error', `${this.a.member}: poll loop ended: ${errText(e)}`))
  }
  /** stop polling (within the call in flight: it is aborted); what is done gets confirmed to Telegram first */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.ac.abort()
    await this.loopP
    if (this.next != null) { try { await this.a.tg.call('getUpdates', { offset: this.next, timeout: 0, limit: 1, allowed_updates: ALLOWED_UPDATES }, { timeoutMs: 3000 }) } catch {} }
  }
  /** the offset of the next getUpdates: past every update done, up to the first one not done (undefined: none confirmed yet) */
  next: number | undefined
  offset(): number | undefined { return this.next }
  /** done updates at the front leave (the next call's offset confirms them to Telegram) */
  private advance(): void {
    for (const id of [...this.entries.keys()].sort((x, y) => x - y)) {
      if (!this.entries.get(id)!.done) break
      this.next = id + 1
      this.entries.delete(id)
    }
  }
  private blocked(): boolean { for (const e of this.entries.values()) if (!e.done && e.kind === 'write') return true; return false }
  pendingWrites(): number { let n = 0; for (const e of this.entries.values()) if (!e.done && e.kind === 'write') n++; return n }

  handedOver = false
  private async loop(): Promise<void> {
    await this.loopInner()
    if (this.handedOver) queueMicrotask(() => this.d.onHandover?.(this.a))
  }
  private async loopInner(): Promise<void> {
    while (this.running) {
      const blocked = this.blocked()
      let ups: any[] = []
      try {
        this.stats.polls++
        ups = await this.a.tg.getUpdates(this.next, blocked ? 0 : (this.d.pollTimeoutS ?? 50), ALLOWED_UPDATES, this.ac.signal)
        this.backoff = 0
        if (this.a.telegramConflict) { this.a.telegramConflict = false; this.d.log('info', `${this.a.member}: polling @${this.a.username} again (no 409 any more)`) }
      } catch (e) {
        if (!this.running) break
        const conflict = e instanceof TgError && e.code === 409
        // handing over (off the list): a 409 is its daemon polling the bot again, the signal to let go, not a poller to wait out. No more
        // getUpdates from here (another would end the daemon's): what was done was confirmed by the calls before this one
        if (conflict && this.a.leaving) { this.handedOver = true; this.running = false; break }
        if (conflict) { this.stats.conflicts++; if (!this.a.telegramConflict) this.d.log('warn', `${this.a.member}: Telegram 409: another program is polling @${this.a.username}; waiting for it to stop`); this.a.telegramConflict = true }
        else this.d.log('warn', `${this.a.member}: getUpdates failed: ${errText(e)}`)
        // a 409 is another poller still on the bot (a daemon handing it over): look again every 3 s, so the handover gap is seconds, not ~50 s of
        // doubling (Chiron 18:00Z); other failures back off doubling to 30 s
        this.backoff = conflict ? TG_CONFLICT_RETRY_MS : Math.min(30_000, Math.max(1_000, this.backoff * 2))
        await this.sleep(this.backoff)
        continue
      }
      for (const u of ups) {
        const id = Number(u?.update_id)
        if (!Number.isFinite(id) || this.entries.has(id) || (this.next != null && id < this.next)) continue
        this.stats.updates++
        this.a.lastUpdateAt = this.now()
        this.entries.set(id, { u, id, done: false, kind: 'local', arrivedAt: this.now(), cache: {}, tries: 0, nextAt: 0 })
      }
      await this.process()
      this.advance()
      if (this.running && this.blocked()) await this.sleep(this.wakeIn())
    }
  }
  /** blocked: how long until the next write try or the next Onsen-down sentence is due (at most 5 s: new updates are looked at that often) */
  private wakeIn(): number {
    const t = this.now()
    let w = 5_000
    for (const e of this.entries.values()) {
      if (e.done || e.kind !== 'write') continue
      w = Math.min(w, Math.max(200, e.nextAt - t))
      if (e.u.message && !e.cache.sorry) w = Math.min(w, Math.max(200, e.arrivedAt + (this.d.sorryMs ?? SORRY_MS) - t))
    }
    return w
  }

  /** every update not done, in order: the local ones at once, the writes one at a time (the first not written holds the rest) */
  async process(): Promise<void> {
    const ids = [...this.entries.keys()].sort((x, y) => x - y)
    let held = false
    for (const id of ids) {
      const e = this.entries.get(id)!
      if (e.done) continue
      if (!e.cache.classified) {
        e.cache.classified = true
        try { await this.classify(e) } catch (err) { this.d.log('error', `${this.a.member}: update ${e.id} could not be read (${errText(err)}); skipped`); e.done = true }
      }
      if (e.done) continue
      if (e.kind === 'write') {
        if (!held && this.albumReady(e) && this.now() >= e.nextAt) await this.write(e)
        if (!e.done) { held = true; await this.maybeSorry(e) }
      }
    }
  }

  /** an album's item is written once its album is complete: ALBUM_MS after the newest item of it arrived; its count kept for every item */
  private albums = new Map<string, number>()
  private albumReady(e: Entry): boolean {
    const m = e.u.message
    if (!m?.media_group_id) return true
    const key = `${m.chat?.id}:${m.media_group_id}`
    if (this.albums.has(key)) return true
    const same = [...this.entries.values()].filter(x => x.u.message?.media_group_id === m.media_group_id && String(x.u.message?.chat?.id) === String(m.chat?.id))
    const newest = Math.max(...same.map(x => x.arrivedAt))
    if (this.now() - newest < ALBUM_MS) { e.nextAt = Math.max(e.nextAt, newest + ALBUM_MS); return false }
    this.albums.set(key, same.length)
    if (this.albums.size > 500) this.albums.delete(this.albums.keys().next().value!)
    return true
  }

  // ---- what an update is -----------------------------------------------------------------------------------------------------------
  private async classify(e: Entry): Promise<void> {
    const u = e.u, a = this.a
    if (process.env.TELEGRAM_BRIDGE_DEBUG) this.d.log('info', `${a.member}: update ${e.id} keys=${Object.keys(u).join(',')} chat=${u.message?.chat?.id ?? ''} from=${u.message?.from?.id ?? ''} text=${typeof u.message?.text === 'string' ? u.message.text.length : '-'}`)
    if (u.callback_query) { await this.button(u.callback_query); e.done = true; return }
    if (u.edited_message) {
      const m = u.edited_message, acc = a.access()
      if (!m.from || m.from.is_bot || !acc || !mayAct(acc, m.chat, String(m.from.id))) { e.done = true; return }
      e.kind = 'write'; return
    }
    if (u.message_reaction) {
      const r = u.message_reaction, acc = a.access()
      if (!r.user || r.user.is_bot || !acc || !mayAct(acc, r.chat, String(r.user.id))) { e.done = true; return }
      e.kind = 'write'; return
    }
    const m = u.message
    if (!m) { e.done = true; return }
    // a topic's name, from its service messages (stage two); nothing to write
    if (m.forum_topic_created || m.forum_topic_edited) {
      const name = m.forum_topic_created?.name ?? m.forum_topic_edited?.name
      if (name && m.message_thread_id != null) this.d.noteTopic?.(a.member, String(m.chat.id), String(m.message_thread_id), String(name))
      e.done = true; return
    }
    const cmd = typeof m.text === 'string' && m.text.startsWith('/') ? m.text.slice(1).split(/[\s@]/)[0]!.toLowerCase() : ''
    if (cmd === 'start' || cmd === 'help') {
      // the bridge answers these two itself, in a DM, to whoever the daemon answered (no pairing side effects); never written (as the daemon)
      if (dmCommandGate(a.stateDir, m)) await this.send(String(m.chat.id), cmd === 'start' ? START_TEXT : HELP_TEXT)
      e.done = true; return
    }
    const g = gate(a.stateDir, m, a.username)
    if (g.action === 'drop') { if (process.env.TELEGRAM_BRIDGE_DEBUG) this.d.log('info', `${a.member}: update ${e.id} dropped by the gate`); e.done = true; return }
    if (g.action === 'pair') {
      a.stats.pairing++
      await this.send(String(m.chat.id), pairingText(g, this.now()))
      e.done = true; return
    }
    if (m.voice == null && m.audio == null && m.text == null && m.caption == null && !m.rich_message && !m.photo && !m.document && !m.video && !m.animation
      && !m.video_note && !m.sticker && !m.location && !m.contact) { e.done = true; return }        // a service message: nothing a person said
    e.kind = 'write'
  }

  private async send(chat: string, text: string, extra: Record<string, unknown> = {}): Promise<number | null> {
    try { return Number((await this.a.tg.call('sendMessage', { chat_id: chat, text, ...extra })).message_id) } catch (err) {
      this.d.log('warn', `${this.a.member}: a reply in chat ${chat} failed: ${errText(err)}`); return null
    }
  }

  // ---- writing into Onsen ----------------------------------------------------------------------------------------------------------
  private async write(e: Entry): Promise<void> {
    e.tries++
    let ans: Answer | null = null, what = ''
    try {
      if (e.u.message) { what = 'message'; ans = await this.writeMessage(e) }
      else if (e.u.edited_message) { what = 'edit'; ans = await this.writeEdit(e) }
      else if (e.u.message_reaction) { what = 'reaction'; ans = await this.writeReaction(e) }
      else { e.done = true; return }
    } catch (err) {
      ans = { status: -1, json: { error: { code: 'network', message: errText(err) } } }
    }
    if (ans.status >= 200 && ans.status < 300) return this.written(e, what, ans)
    const code = errCode(ans)
    if (ans.status === 409 && what === 'message') {                 // the same idem_key with other content: it is in Onsen already
      this.d.log('warn', `${this.a.member}: ${this.ref(e)} answered 409 (${errSaid(ans)}); it is in Onsen already, taken as written`)
      return this.written(e, what, ans)
    }
    if (ans.status === -1 || retryable(ans)) {
      if (ans.status === 404) this.d.reRegister?.()
      this.stats.failed_tries++
      if (this.failingSince == null) {
        this.failingSince = this.now()
        this.d.log('warn', `${this.a.member}: Onsen did not take ${this.ref(e)} (${ans.status === -1 ? errSaid(ans) : `HTTP ${ans.status || 'no credential'} ${code}`}); trying again, later updates wait behind it`)
      }
      e.nextAt = this.now() + (e.tries <= 1 ? 2_000 : e.tries === 2 ? 4_000 : 5_000)
      return
    }
    // refused for good: never tried again. 403 (not_allowed: the account is an agent or a system member; unknown_identity before Onsen 0.35.1):
    // nothing is answered, the update is done. 400 (the bridge sent something Onsen does not take): the person is told it was not handed over (a DM).
    this.a.stats.refused++
    this.d.log(ans.status === 403 ? 'warn' : 'error', `${this.a.member}: Onsen refused ${this.ref(e)}: HTTP ${ans.status} ${code} ${errSaid(ans)}; not handed over, not tried again`)
    if (what === 'message' && ans.status !== 403 && e.u.message.chat?.type === 'private') {
      const m = e.u.message
      await this.send(String(m.chat.id), `Onsen 收不下這一則（${code || ans.status}），沒有交給 ${this.a.name()}。`, { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } })
    }
    e.done = true
    this.ok()
  }
  private ok(): void {
    if (this.failingSince != null) { this.d.log('info', `${this.a.member}: Onsen takes writes again (after ${Math.round((this.now() - this.failingSince) / 1000)} s)`); this.failingSince = null }
  }
  private ref(e: Entry): string {
    const m = e.u.message ?? e.u.edited_message ?? e.u.message_reaction
    return `${e.u.message ? 'message' : e.u.edited_message ? 'the edit of' : 'a reaction on'} tg:${m?.message_id} in chat ${m?.chat?.id}`
  }
  private async written(e: Entry, what: string, ans: Answer): Promise<void> {
    e.done = true
    this.ok()
    this.stats.written++
    if (what !== 'message') return
    const m = e.u.message, chat = String(m.chat.id)
    if (ans.json?.data?.duplicate) this.a.stats.duplicates++; else this.a.stats.written++
    this.a.pending.inbound({ chat, client_msg_id: String(m.message_id), sent_at: new Date((m.date ?? 0) * 1000).toISOString(), kind: e.cache.body?.kind ?? 'text' } as any)
    // 👀: Onsen has it (the daemon's ackReaction; unset: 👀; '': none)
    const ack = this.a.access()?.ackReaction ?? '👀'
    if (ack) {
      const p = this.a.tg.call('setMessageReaction', { chat_id: chat, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: ack }] })
      this.a.seen.ack(chat, m.message_id, p)
      void p.catch(err => this.d.log('warn', `${this.a.member}: ${ack} on tg:${m.message_id} failed: ${errText(err)}`))
    }
    if (e.cache.sorry) this.d.log('info', `${this.a.member}: tg:${m.message_id} in chat ${chat} handed over after the Onsen-down sentence`)
  }
  private async maybeSorry(e: Entry): Promise<void> {
    const m = e.u.message
    if (!m || e.cache.sorry || this.failingSince == null || this.now() - e.arrivedAt < (this.d.sorryMs ?? SORRY_MS)) return
    const key = `${this.a.member}:${m.chat.id}:${m.message_id}`
    e.cache.sorry = true
    if (this.d.state.data.sorry[key]) return
    this.d.state.data.sorry[key] = this.now(); this.d.state.dirty()
    this.a.stats.sorry++
    await this.send(String(m.chat.id), sorryText(this.a.name()), { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } })
  }

  /** POST /v1/bridge/messages (CONTRACT §7d): every field present, null where there is nothing */
  async writeMessage(e: Entry): Promise<Answer> {
    const a = this.a, m = e.u.message, chat = String(m.chat.id)
    if (!e.cache.body) {
      const shape = inboundShape(m)
      let text: string
      if (m.text != null) text = expandHiddenEntities(String(m.text), m.entities)
      else if (m.caption != null) text = expandHiddenEntities(String(m.caption), m.caption_entities)
      else if (m.rich_message) text = richToMarkdown(m.rich_message) || '(rich message: nothing readable in it)'
      else if (m.location) {
        const v = m.venue
        text = `(location: ${m.location.latitude}, ${m.location.longitude}${v?.title ? ` — ${safeName(v.title)}${v.address ? `, ${safeName(v.address)}` : ''}` : ''})`
      } else if (m.contact) text = `(contact: ${safeName([m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')) || 'contact'}, ${safeName(m.contact.phone_number)})`
      else text = ''
      const rt = m.reply_to_message && !m.reply_to_message.forum_topic_created ? m.reply_to_message : null
      const thread = m.message_thread_id != null && m.is_topic_message !== false ? String(m.message_thread_id) : null
      let att = shape.attachments?.[0] ?? null, attK = attKind(shape.kind)
      // a text (or rich) message with no file of its own that replies to one with a file: that file comes with it (server.ts replyAttachment; the
      // tag then says attachment_origin="reply")
      if (!att && rt && (m.text != null || m.rich_message)) {
        const rs = inboundShape(rt)
        if (rs.attachments?.[0]?.file_id && rs.kind !== 'sticker') { att = rs.attachments[0]; attK = attKind(rs.kind); e.cache.fromReply = true; e.cache.photo = rs.kind === 'photo' }
      } else e.cache.photo = shape.kind === 'photo'
      const fo = m.forward_origin
      e.cache.body = {
        member: a.member, client_user_id: String(m.from.id),
        client_user: { username: m.from.username ?? null, display_name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || null },
        chat, client_msg_id: String(m.message_id), sent_at: new Date((m.date ?? 0) * 1000).toISOString(), text,
        kind: shape.kind, attachment_file_ids: [] as string[],
        attachments: att ? [{ kind: attK, name: att.name ?? null, mime: att.mime ?? mimeOf(att.name) ?? null, bytes: att.size ?? null, client_ref: att.file_id ?? null }] : [],
        reply_to_client_msg_id: rt ? String(rt.message_id) : null,
        reply_quote: m.quote?.text ? metaExcerpt(m.quote.text) : null,
        reply_to_text: rt ? ((t => t ? metaExcerpt(t) : null)(rt.text ?? rt.caption ?? (rt.rich_message ? richToMarkdown(rt.rich_message) || undefined : undefined) ?? mediaKindLabel(rt))) : null,
        reply_to_user: rt ? (rt.from ? displayName(rt.from) : rt.sender_chat ? (safeName(rt.sender_chat.title ?? rt.sender_chat.username) || String(rt.sender_chat.id)) : null) : null,
        client_thread: thread,
        topic_name: thread ? (m.reply_to_message?.forum_topic_created?.name ?? this.d.topicName?.(a.member, chat, thread) ?? null) : null,
        forward_from: tagForwardFrom(m),                                   // the daemon tag's value (Chiron 15:40Z ruling, §7d)
        forward_date: fo?.date || m.forward_date ? new Date(Number(fo?.date ?? m.forward_date) * 1000).toISOString() : null,
        media_group_id: m.media_group_id ? String(m.media_group_id) : null,
        idem_key: `tg:${a.member}:${chat}:${m.message_id}`,
      }
      if (thread && e.cache.body.topic_name) this.d.noteTopic?.(a.member, chat, thread, e.cache.body.topic_name)
    }
    const body = e.cache.body
    // the file: fetched from Telegram once (kept across tries), stored in Onsen; a voice note's transcript from the same bytes
    const att = body.attachments[0]
    if (att?.client_ref && !e.cache.fileDone) {
      if (!e.cache.got) {
        const got = await telegramFile({ fileId: att.client_ref, size: att.bytes ?? undefined, getFile: id => a.tg.getFile(id), fileUrl: p => a.tg.fileUrl(p) })
        if ('why' in got) {
          this.d.log('warn', `${a.member}: the file of tg:${m.message_id} is not stored in Onsen: ${got.why}; written with its name and Telegram id only`)
          e.cache.fileDone = true; e.cache.notStored = true
        } else e.cache.got = got
      }
      if (e.cache.got && (m.voice || m.audio) && this.d.voice?.on && e.cache.transcript === undefined) {
        e.cache.transcript = await transcribe(e.cache.got.bytes, `${chat}-${m.message_id}`, this.d.voice, this.d.log) ?? null
        // Chiron 15:40Z: a voice note with a caption keeps the caption as its text; the transcript then rides only in client_meta.voice_transcript
        if (e.cache.transcript && !(typeof m.caption === 'string' && m.caption.trim())) body.text = e.cache.transcript
      }
      if (e.cache.got && !e.cache.fileDone) {
        const r = await this.d.onsen.upload(e.cache.got.bytes, { key: body.idem_key, name: att.name ?? e.cache.got.name ?? null, mime: att.mime })
        if ('id' in r) { body.attachment_file_ids = [r.id]; e.cache.fileDone = true; e.cache.got = null }
        else if (r.retry) return { status: 503, json: { error: { code: 'service_unavailable', message: r.error } } }
        else { this.d.log('warn', `${a.member}: the file of tg:${m.message_id} is not stored in Onsen: ${r.error}`); e.cache.fileDone = true; e.cache.got = null; e.cache.notStored = true }
      }
    }
    const meta = clientMetaOf(m, { fromReply: e.cache.fromReply, transcript: e.cache.transcript ?? null, imageError: !!(e.cache.photo && e.cache.notStored),
      albumCount: m.media_group_id ? this.albums.get(`${chat}:${m.media_group_id}`) : undefined })
    const cm = this.d.clientMeta
    const withMeta = Object.keys(meta).length > 0 && !(cm && this.now() < cm.offUntil)
    const ans = await this.d.onsen.req('POST', '/bridge/messages', withMeta ? { ...body, client_meta: meta } : body, { idem: body.idem_key })
    // an Onsen that does not take client_meta yet (before 0.35.4) answers 400 naming it: the message goes again without it, and for 5 min none is sent
    if (withMeta && ans.status === 400 && META_UNKNOWN.test(errSaid(ans))) {
      if (cm) cm.offUntil = this.now() + 300_000
      this.d.log('warn', `${a.member}: Onsen does not take client_meta yet (${errSaid(ans).slice(0, 80)}): tg:${m.message_id} sent again without it; none sent for 5 min`)
      return this.d.onsen.req('POST', '/bridge/messages', body, { idem: body.idem_key })
    }
    return ans
  }
  async writeEdit(e: Entry): Promise<Answer> {
    const m = e.u.edited_message
    const text = m.text != null ? expandHiddenEntities(String(m.text), m.entities) : m.caption != null ? expandHiddenEntities(String(m.caption), m.caption_entities)
      : m.rich_message ? (richToMarkdown(m.rich_message) || '') : ''
    const ans = await this.d.onsen.req('POST', '/bridge/messages/edit', { member: this.a.member, chat: String(m.chat.id), client_msg_id: String(m.message_id), text,
      edited_at: new Date((Number(m.edit_date) || Math.floor(this.now() / 1000)) * 1000).toISOString() }, { idem: `tg:${this.a.member}:${m.chat.id}:${m.message_id}:edit:${m.edit_date ?? ''}` })
    if (ans.status === 404 && errCode(ans) !== 'no_endpoint') return { status: 200, json: { data: { changed: false, unknown: true } } }   // a message Onsen never had
    return ans
  }
  async writeReaction(e: Entry): Promise<Answer> {
    const r = e.u.message_reaction
    const emojis = (Array.isArray(r.new_reaction) ? r.new_reaction : []).map((x: any) => x?.type === 'emoji' ? x.emoji : x?.type === 'custom_emoji' ? `custom:${x.custom_emoji_id}` : null).filter(Boolean)
    const ans = await this.d.onsen.req('POST', '/bridge/reactions', { member: this.a.member, chat: String(r.chat.id), client_msg_id: String(r.message_id), client_user_id: String(r.user.id),
      emojis, at: new Date((Number(r.date) || Math.floor(this.now() / 1000)) * 1000).toISOString() })
    if (ans.status === 404 && errCode(ans) !== 'no_endpoint') return { status: 200, json: { data: { unknown: true } } }
    return ans
  }

  // ---- buttons ---------------------------------------------------------------------------------------------------------------------
  private async button(cq: any): Promise<void> {
    const a = this.a, data = String(cq.data ?? ''), uid = String(cq.from?.id ?? ''), chat = cq.message?.chat
    const answer = (text?: string) => a.tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text: text.slice(0, 190) } : {}) }).catch(() => {})
    const acc = a.access()
    if (!acc || !mayAct(acc, chat ?? { id: uid, type: 'private' }, uid)) { await answer('Not authorized.'); return }
    if (data === 'opin:off') {
      const id = await a.pin().dismiss(String(chat?.id ?? uid))
      this.d.log('info', `${a.member}: status message dismissed by tg:${uid} in chat ${chat?.id} (message ${id})`)
      await answer('不再顯示這則'); return
    }
    if (this.d.onButton && await this.d.onButton(a, cq)) return
    const mk = /^oa:([0-9a-z]+)$/.exec(data)
    const k = mk ? this.d.buttonKey?.(mk[1]!) : null
    if (!k || k.member !== a.member) { await answer(mk ? '這個按鈕已經不能用了' : undefined); return }
    let ans: Answer
    try {
      ans = await this.d.onsen.req('POST', `/bridge/actions/${encodeURIComponent(k.action)}/resolve`, { client_user_id: uid, option: k.option, at: new Date(this.now()).toISOString() })
    } catch (err) { this.d.log('warn', `${a.member}: resolving Action ${k.action}: ${errText(err)}`); await answer('Onsen 連不上，沒有送出；稍後再按一次'); return }
    if (ans.status >= 200 && ans.status < 300) {
      this.d.log('info', `${a.member}: Action ${k.action} answered ${k.option} by tg:${uid}`)
      await answer(`已送出：${k.label}`); return
    }
    const code = errCode(ans)
    this.d.log('warn', `${a.member}: resolving Action ${k.action} with ${k.option}: HTTP ${ans.status} ${code} ${errSaid(ans)}`)
    await answer(ans.status === 409 ? '已經有人回答了，或它已經不在了' : ans.status === 403 ? '你不能回答這一件' : retryable(ans) ? 'Onsen 連不上，沒有送出；稍後再按一次' : `沒有送出（${code || ans.status}）`)
  }

  /** /telegram:access paired someone: "Paired! Say hi to Claude." (server.ts checkApprovals) */
  async approvals(): Promise<void> {
    for (const id of approvals(this.a.stateDir)) {
      await this.send(id, PAIRED_TEXT)
      doneApproval(this.a.stateDir, id)
    }
  }
}

/** Onsen's attachment kind (CONTRACT §4) of a Telegram record kind (onsen-client.ts inboundShape) */
export function attKind(k: string): string {
  return k === 'photo' ? 'photo' : k === 'document' ? 'document' : k === 'voice' ? 'voice' : k === 'video' ? 'video' : 'other'
}

/** a voice note's text, from local whisper (server.ts transcribeVoiceFile 4225-4254: CHANNEL_BOT_TRANSCRIBE_CMD, else `whisper` on CPU); undefined on
 *  any failure (the message goes without a transcript, as the daemon's) */
export async function transcribe(bytes: Uint8Array, base: string, v: NonNullable<PollerDeps['voice']>, log: Log): Promise<string | undefined> {
  const dir = join(v.dir, 'voice'), name = base.replace(/[^0-9a-zA-Z_-]/g, '_')
  const audio = join(dir, `${name}.oga`), txt = join(dir, `${name}.txt`)
  const run = (cmd: string, args: string[]) => new Promise<string>((res, rej) =>
    execFile(cmd, args, { timeout: 240_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => err ? rej(err) : res(String(out))))
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(audio, bytes, { mode: 0o600 })
    let text: string
    if (v.cmd) text = await run(v.cmd, [audio])
    else {
      await run(v.whisper, [audio, '--model', v.model, '--device', 'cpu', '--fp16', 'False', '--output_format', 'txt', '--output_dir', dir, '--verbose', 'False'])
      text = readFileSync(txt, 'utf8')
    }
    return text.trim() ? metaExcerpt(text, 500) : undefined
  } catch (e) {
    log('warn', `voice transcription failed (the message goes without a transcript): ${errText(e)}`)
    return undefined
  } finally { for (const f of [audio, txt]) { try { rmSync(f, { force: true }) } catch {} } }
}

export { TG_BOT_FILE_MAX }
