// WO-197 (Chiron; bridge steps 3 and 4, the connector's half; CONTRACT §7d 「連接器這一頭」; the Telegram end is Epeius's telegram-bridge, WO-196):
// an agent named in ONSEN_BRIDGE has its Telegram bot carried by the machine's telegram-bridge. Its telegram-http daemon is then a connector: it never
// long-polls, never calls the Bot API (and starts without a bot token); everything it did on Telegram it writes into Onsen with the agent's own
// credential, and Onsen queues it for the bridge, which draws it on Telegram and reports back. The two programs meet only in Onsen.
//
//   switch    ONSEN_BRIDGE (bridgeOn): a comma list of member names or `*`; unset, empty, 0 / off = none. The plist, else the machine config
//             ~/.config/crab-labs-plugins/env (the same line the bridge reads), read again at most every 30 s (BridgeSwitch). Taken off: the daemon
//             polls Telegram again (it has a token) within 30 s.
//   say       ConnectorSay: POST /v1/messages with conversation_id (never client / chat / delivery / client_msg_id), the whole text, the files as
//             attachment_file_ids (stored first with POST /v1/files), reply_to_message_id, urgency silent; tried again 1 s and 3 s later on no answer
//             or a 5xx; refused (4xx) or still not: the send fails (NOT_TAKEN). Then up to WAIT_MS (3 s) for the bridge's delivery report (GET
//             /messages/<id>: delivery.state, its numbers as aliases): sent → the Telegram numbers (the tool answers as today); not in 3 s, or failed
//             → HELD (said: Onsen has it; the bridge sends it again). Nothing to draw it (a person with no app account): sent at write, no numbers.
//   ids       OnsenIds: the agent hands back the opaque numbers its items carried (client.chat, client.msg_id: Telegram's); they are turned into
//             Onsen's conversation and message by asking Onsen (GET /v1/conversations/by-chat/<chat>, GET /v1/conversations/<id>/messages/
//             by-client-id/<n>, Onsen ≥ 0.35.2), cached; no table of our own, no client name sent. `onsen:<conversation id>` is a chat as it is.
//   react     POST /v1/messages/<id>/reactions {emojis}; Telegram's reaction set is checked here (REACTIONS), as Telegram refused before.
//   edit      PUT /v1/messages/<id> {text}.
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { parseFleetConfig } from './fleet-config.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export type Request = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; json: any } | null>

export const WAIT_MS = 3_000
export const POLL_MS = 150
export const RETRY_MS = [1_000, 3_000]
export const TRY_MS = 5_000
export const CACHE_MS = 10 * 60_000
export const HELD = '已寫進 Onsen（網頁看得到）；Telegram 還沒送到，會再送'
export const NOT_TAKEN = 'Onsen 沒收下，這一則沒有送出'
export const ONSEN_CHAT = /^onsen:(.+)$/
export const FORM_REF = /^form-(.+)$/
/** Telegram's reaction set (the Bot API's ReactionTypeEmoji): the bridge can draw nothing else */
export const REACTIONS = new Set(['👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱',
  '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃',
  '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡'])
/** an emoji as Telegram takes it: the variation selector (U+FE0F) dropped (❤️ is ❤) */
export const reactionOk = (e: string): boolean => REACTIONS.has(String(e ?? '').replace(/️/g, ''))

/** ONSEN_BRIDGE: unset, empty, 0 / off / false / no = none; a comma list of member names or `*` */
export function bridgeOn(value: string | undefined, agent: string): boolean {
  const v = String(value ?? '').trim()
  if (!v || ['0', 'off', 'false', 'no'].includes(v.toLowerCase())) return false
  const list = v.split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}

/** the switch for this agent: the plist's value when it set one (fixed), else the machine config's line, read again at most every 30 s */
export class BridgeSwitch {
  private at = -Infinity
  private v: string | undefined
  constructor(private o: { agent: string; plist?: string; file: string; everyMs?: number; read?: (f: string) => string; now?: () => number
    /** WO-197 segment 2: the machine config's key (default ONSEN_BRIDGE; ONSEN_OWNER: the agent's owner) */
    key?: string }) {}
  value(): string | undefined {
    if (this.o.plist !== undefined) return this.o.plist
    const now = (this.o.now ?? Date.now)()
    if (now - this.at >= (this.o.everyMs ?? 30_000)) {
      let v: string | undefined
      try { v = parseFleetConfig((this.o.read ?? (f => readFileSync(f, 'utf8')))(this.o.file))[this.o.key ?? 'ONSEN_BRIDGE'] } catch {}
      this.v = v; this.at = now
    }
    return this.v
  }
  on(): boolean { return bridgeOn(this.value(), this.o.agent) }
  /** WO-197 (Chiron 19:21Z): the machine config read now (before a poll starts), the value kept for the next 30 s */
  fresh(): boolean { this.at = -Infinity; return this.on() }
}

/** a Bot API call the connector refused to make (its bot is the bridge's now) */
export class NoTelegram extends Error {
  readonly noTelegram = true
  constructor(readonly method: string) {
    super(`${method}: not sent to Telegram: this agent's bot is carried by the Telegram bridge (ONSEN_BRIDGE); its daemon only writes into Onsen`)
  }
}
export const isNoTelegram = (e: unknown): boolean => !!(e as any)?.noTelegram

/** an Onsen error's words (v1: {error: {code, message}}; the old API: {detail}) */
export function why(r: { status: number; json: any } | null): string {
  if (!r) return 'no mesh credential'
  const j = r.json, d = j?.error?.message ?? j?.detail ?? j?.error
  return `HTTP ${r.status}${d ? `: ${typeof d === 'string' ? d : JSON.stringify(d)}` : ''}`.slice(0, 300)
}

/** Telegram numbers → Onsen ids, by asking Onsen (cached) */
export class OnsenIds {
  private conv = new Map<string, { id: string; at: number }>()
  private msg = new Map<string, { id: string; at: number }>()
  constructor(private o: { request: Request; ttlMs?: number; now?: () => number }) {}
  private fresh(e: { at: number } | undefined): boolean { return !!e && (this.o.now ?? Date.now)() - e.at < (this.o.ttlMs ?? CACHE_MS) }
  /** the conversation a chat id stands for (`onsen:<id>` as it is); throws when Onsen has none for it */
  async conversation(chat: string): Promise<string> {
    const m = ONSEN_CHAT.exec(String(chat))
    if (m) return m[1]!
    const had = this.conv.get(chat)
    if (had && this.fresh(had)) return had.id
    const r = await this.o.request('GET', `/v1/conversations/by-chat/${encodeURIComponent(chat)}`, undefined, TRY_MS)
    const id = r && r.status === 200 ? r.json?.data?.id : undefined
    if (id == null) throw new Error(`Onsen has no conversation for chat ${chat} (${why(r)})`)
    this.conv.set(chat, { id: String(id), at: (this.o.now ?? Date.now)() })
    return String(id)
  }
  /** the Onsen message a client message number stands for (`onsen:<id>` as it is), or null when Onsen has none */
  async message(chat: string, n: string): Promise<string | null> {
    const s = String(n ?? '').trim()
    const direct = ONSEN_CHAT.exec(s) ?? FORM_REF.exec(s)
    if (direct) return direct[1]!
    if (!s) return null
    const cid = await this.conversation(chat)
    const key = `${cid}:${s}`, had = this.msg.get(key)
    if (had && this.fresh(had)) return had.id
    const r = await this.o.request('GET', `/v1/conversations/${encodeURIComponent(cid)}/messages/by-client-id/${encodeURIComponent(s)}`, undefined, TRY_MS)
    if (r && r.status === 404) return null
    const id = r && r.status === 200 ? r.json?.data?.id : undefined
    if (id == null) throw new Error(`Onsen did not say which message ${s} is (${why(r)})`)
    this.msg.set(key, { id: String(id), at: (this.o.now ?? Date.now)() })
    return String(id)
  }
  /** WO-197 segment 2: the conversation a chat stands for, as Onsen answered a write (`member:<name>` → their direct conversation) */
  know(chat: string, id: string): void { this.conv.set(chat, { id, at: (this.o.now ?? Date.now)() }) }
  /** WO-197 segment 2: a conversation's thread for a client thread (the topic number a person's message carried): person_message's own `thread`
   *  (learned as they come), else GET /v1/conversations/<id>/threads?client_thread=<n>; null when Onsen has none */
  private threads = new Map<string, { id: string; at: number }>()
  learnThread(cid: string, clientThread: string, thread: string): void { this.threads.set(`${cid}:${clientThread}`, { id: thread, at: (this.o.now ?? Date.now)() }) }
  async thread(chat: string, clientThread: string): Promise<string | null> {
    const cid = await this.conversation(chat)
    const key = `${cid}:${clientThread}`, had = this.threads.get(key)
    if (had && this.fresh(had)) return had.id
    const r = await this.o.request('GET', `/v1/conversations/${encodeURIComponent(cid)}/threads?client_thread=${encodeURIComponent(clientThread)}`, undefined, TRY_MS)
    const it = r && r.status === 200 ? (r.json?.items ?? r.json?.data?.items ?? [])[0] : undefined
    if (!it?.thread) return null
    this.learnThread(cid, clientThread, String(it.thread))
    return String(it.thread)
  }
  /** the numbers a message became on its client are known (the bridge's report): each stands for it */
  learn(cid: string, nums: string[], id: string): void {
    const at = (this.o.now ?? Date.now)()
    for (const n of nums) this.msg.set(`${cid}:${n}`, { id, at })
  }
  get size(): { conversations: number; messages: number } { return { conversations: this.conv.size, messages: this.msg.size } }
}

export type Said = { onsenId: string; conversationId: string; ids: string[]; held: boolean; why?: string }
export type SayAsk = { chat: string; sender: string; text: string; kind?: string; turn_id?: string | null; replyTo?: string | null; thread?: string | null
  silent?: boolean; fileIds?: string[]; attachments?: Array<{ name: string; mime?: string; size?: number }> }
/** WO-197 segment 2: a chat that names a person rather than a conversation (`member:<name>`): written with `to` (their direct conversation with this
 *  agent, CONTRACT §7d), for what has no chat of its own (the agent's owner: system warnings, ops notices) */
export const MEMBER_CHAT = /^member:([a-z0-9][a-z0-9_.-]{0,63})$/
export const memberChat = (name: string): string => `member:${name}`

/** what the agent says, written into Onsen; then the bridge's report waited for (WAIT_MS) */
export class ConnectorSay {
  readonly stats = { written: 0, duplicates: 0, retries: 0, refused: 0, delivered: 0, held: 0, direct: 0, reply_unknown: 0, reacted: 0, edited: 0, thread_dropped: 0 }
  constructor(private o: { request: Request; ids: OnsenIds; agent: string; log: Log; waitMs?: number; pollMs?: number; retryMs?: number[] }) {}
  private sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  async say(a: SayAsk): Promise<Said> {
    const to = MEMBER_CHAT.exec(String(a.chat))?.[1]
    const cid = to ? '' : await this.o.ids.conversation(a.chat)
    let reply: string | null = null
    if (!to && a.replyTo != null && String(a.replyTo) !== '') {
      reply = await this.o.ids.message(a.chat, String(a.replyTo)).catch(e => { this.o.log('warn', `connector: reply_to ${a.replyTo}: ${e instanceof Error ? e.message : e}`); return null })
      if (reply == null) { this.stats.reply_unknown++; this.o.log('info', `connector: reply_to ${a.replyTo} is not a message Onsen knows in chat ${a.chat}: written without it`) }
    }
    const body: Record<string, unknown> = { ...(to ? { to } : { conversation_id: cid }), idem_key: `c:${this.o.agent}:${to ? `to-${to}` : cid}:out:${randomUUID()}`, sender: a.sender, body: a.text,
      kind: a.kind ?? 'text', sent_at: new Date().toISOString(), ...(reply != null ? { reply_to_message_id: reply } : {}),
      ...(a.thread ? { thread: String(a.thread) } : {}), ...(a.silent ? { urgency: 'silent', meta: { silent: true } } : {}),
      ...(a.turn_id ? { turn_id: String(a.turn_id).slice(0, 120) } : {}),
      ...(a.fileIds?.length ? { attachment_file_ids: a.fileIds } : {}), ...(a.attachments?.length ? { attachments: a.attachments } : {}) }
    const waits = this.o.retryMs ?? RETRY_MS
    let r: { status: number; json: any } | null = null, err = ''
    for (let i = 0; ; i++) {
      try { r = await this.o.request('POST', '/v1/messages', body, TRY_MS); err = '' } catch (e) { r = null; err = e instanceof Error ? e.message : String(e) }
      if (r && r.status < 300) break
      // WO-197 (segment 2, sonn's ruling 9): a thread Onsen does not have in this conversation (a Telegram topic number a lane kept from before the
      // switch): written again without it, once
      if (r && r.status === 400 && body.thread != null && /thread/i.test(why(r))) {
        this.o.log('warn', `connector: Onsen refused thread ${body.thread} (${why(r)}): written without a thread`)
        delete body.thread
        this.stats.thread_dropped++
        i--
        continue
      }
      if (r && r.status >= 400 && r.status < 500) { this.stats.refused++; throw new Error(`${NOT_TAKEN}（${why(r)}）`) }
      if (!r && !err) { this.stats.refused++; throw new Error(`${NOT_TAKEN}（no mesh credential）`) }
      if (i >= waits.length) { this.stats.refused++; throw new Error(`${NOT_TAKEN}（${err || why(r)}）`) }
      this.stats.retries++
      await this.sleep(waits[i]!)
    }
    const d = r!.json?.data ?? r!.json ?? {}
    const id = String(d.message_id ?? d.id), conv = String(d.conversation_id ?? cid)
    if (to && conv) this.o.ids.know(a.chat, conv)                        // the owner's conversation, for what follows
    if (d.duplicate) this.stats.duplicates++; else this.stats.written++
    if (d.delivery === 'sent') { this.stats.direct++; return { onsenId: id, conversationId: conv, ids: [], held: false } }   // nothing draws it
    return this.waitReport(id, conv)
  }

  /** the bridge's report: GET /messages/<id> until delivery leaves pending (WAIT_MS at most) */
  async waitReport(id: string, conv: string): Promise<Said> {
    const end = Date.now() + (this.o.waitMs ?? WAIT_MS)
    let last = 'pending'
    while (true) {
      const r = await this.o.request('GET', `/messages/${encodeURIComponent(id)}`, undefined, Math.max(500, Math.min(TRY_MS, end - Date.now()))).catch(() => null)
      const st = r?.status === 200 ? r.json?.delivery?.state : undefined
      if (st === 'sent') {
        const nums = numbersOf(r!.json)
        this.o.ids.learn(conv, nums, id)
        this.stats.delivered++
        return { onsenId: id, conversationId: conv, ids: nums, held: false }
      }
      if (st === 'failed') { last = `failed${r!.json?.delivery?.error ? `: ${r!.json.delivery.error}` : ''}`; break }
      if (Date.now() + (this.o.pollMs ?? POLL_MS) > end) break
      await this.sleep(this.o.pollMs ?? POLL_MS)
    }
    this.stats.held++
    this.o.log('info', `connector: message ${id} written into Onsen; the bridge has not reported it sent within ${Math.round((this.o.waitMs ?? WAIT_MS) / 1000)} s (${last})`)
    return { onsenId: id, conversationId: conv, ids: [], held: true, why: last }
  }

  async react(chat: string, n: string, emoji: string): Promise<string> {
    const id = await this.o.ids.message(chat, n)
    if (id == null) throw new Error(`message ${n} is not a message Onsen knows in chat ${chat}: no reaction written`)
    const r = await this.o.request('POST', `/v1/messages/${encodeURIComponent(id)}/reactions`, { emojis: [emoji] }, TRY_MS)
    if (!r || r.status >= 300) throw new Error(`Onsen did not take the reaction (${why(r)})`)
    this.stats.reacted++
    return id
  }

  async edit(chat: string, n: string, text: string): Promise<string> {
    const id = await this.o.ids.message(chat, n)
    if (id == null) throw new Error(`message ${n} is not a message Onsen knows in chat ${chat}: not edited`)
    const r = await this.o.request('PUT', `/v1/messages/${encodeURIComponent(id)}`, { text }, TRY_MS)
    if (!r || r.status >= 300) throw new Error(`Onsen did not take the edit (${why(r)})`)
    this.stats.edited++
    return id
  }
}

/** the client numbers of a message (GET /messages/<id>: aliases [{client_ref: "<chat>:<n>"}]), in order */
export function numbersOf(m: any): string[] {
  const out: string[] = []
  for (const a of Array.isArray(m?.aliases) ? m.aliases : []) {
    const ref = String(a?.client_ref ?? ''), n = ref.slice(ref.lastIndexOf(':') + 1)
    if (n && !out.includes(n)) out.push(n)
  }
  return out.sort((x, y) => (/^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0))
}

/** WO-197 segment 2 (sonn's ruling 4): Onsen draws a lane's or the router's label itself (fleet-core onsen_bridge.author_label of the sender part:
 *  〔agent·工作線#n〕 for <agent>.worker.<n>, 〔agent·分流器〕 for router), so the same line first in the text is dropped: the bridge does not draw it twice.
 *  Chiron mesh 12916 point 4: a first line that starts with the label loses the label; what is left of the line, without its leading 「｜」, is the
 *  first line (「〔agent·工作線#n〕｜負責：X」 and lanes.ts pushJoey's 「〔agent·工作線#n｜負責：X〕」 both → 「負責：X」). The header is drawn once, by
 *  author_label. A first line that does not start with it stays. `kindName`: a lane kind's name (lanes.ts KIND_NAME, Onsen's LANE_NAMES) */
export function withoutOnsenLabel(text: string, sender: string, agent: string, kindName: (k: string) => string): string {
  const m = /^([a-z0-9][a-z0-9-]*)\.([a-z_]+)\.(\d+)$/.exec(sender)
  const label = sender === 'router' ? `〔${agent}·分流器〕` : m ? `〔${m[1]}·${kindName(m[2]!)}#${m[3]}〕` : null
  if (!label) return text
  const nl = text.indexOf('\n'), first = nl < 0 ? text : text.slice(0, nl), after = nl < 0 ? null : text.slice(nl + 1)
  const open = label.slice(0, -1) + '｜'                                    // the owner inside the label's brackets (lanes.ts pushJoey's head)
  const left = first.startsWith(label) ? first.slice(label.length) : first.startsWith(open) && first.endsWith('〕') ? first.slice(open.length - 1, -1) : null
  if (left === null) return text
  const rest = left.replace(/^\s*｜?\s*/, '').trimEnd()
  if (!rest) return after ?? text                                           // the label alone: the line dropped (a text that is only the label stays)
  return after === null ? rest : `${rest}\n${after}`
}

export class HeldInOnsen extends Error {
  readonly heldInOnsen = true
  constructor(message: string, readonly onsenId: number, readonly sentIds: number[]) { super(message) }
}
