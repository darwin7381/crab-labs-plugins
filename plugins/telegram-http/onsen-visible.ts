// Onsen step 3, the half Joey sees (WO-145). Three features, each behind its own switch; each also needs Onsen recording on for the agent (ONSEN_RECORD,
// ONSEN_AGENTS). A switch is a comma list of agent names or `*`, read like ONSEN_AGENTS (the daemon's env, then the machine config
// ~/.config/crab-labs-plugins/env, fleet-config.ts); unset or empty = off, and off changes nothing at all.
//   ONSEN_REACT_SEEN  SeenReactor: the moment the MAIN takes Joey's message in (its `seen` by main: lanes on M1 bound, lanes off the transcript shows it
//                     in a turn; WO-165: no longer the notification written into the session's stream, which is in_session and leaves 👀), the
//                     reaction on it becomes ✍. The daemon's 👀 (taken in) is unchanged; a lane's seen leaves 👀; the agent's own reaction is never
//                     replaced (and a later one of its own wins, as today). Line 2 of the pin counts by seen too: "not in yet" = not in a turn yet.
//   ONSEN_STATUS_PIN  StatusPin: one message per DM chat of an allowlisted person, sent and pinned without a notification, then only edited: line 1 the
//                     main's status (statusOf's view; statusLine), line 2 Joey's messages not in yet / seen and not answered (PendingTracker, from this
//                     daemon's own spool: works with Onsen down). Edited only when the text changes, at least 5 s apart. Joey unpins or deletes it: that
//                     chat is off (a marker file, status-pin-off-<chat>.json; delete it to start again).
//   ONSEN_FORM_LINKS  rewriteFormLinks: in a reply's text (the main's, a lane's line), every link to one of our pages (ONSEN_FORM_HOSTS) gets a one-time
//                     form key `k` (POST /forms); Telegram gets the keyed text, Onsen records it without the keys (SendCtx.redact). FormInbox: the answers
//                     (GET /forms/inbox long poll) go to the main as Joey's message would, are echoed in the chat without a notification, then acked.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DeliveryFact, OnsenItem, SpoolLine } from './onsen-client.ts'
import type { StatusView } from './onsen-status.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
type Now = () => number
const HOUR = 3600_000
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300)

// ------------------------------------------------------------------ switches
export const SWITCHES = ['ONSEN_REACT_SEEN', 'ONSEN_STATUS_PIN', 'ONSEN_FORM_LINKS'] as const
export type Switch = typeof SWITCHES[number]
/** `name` lists this agent (or `*`); unset / empty = off. The caller also requires Onsen recording on for the agent. */
export function switchOn(env: NodeJS.ProcessEnv, name: Switch, agent: string): boolean {
  const list = String(env[name] ?? '').split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}
export const FORM_HOSTS_DEFAULT = 'rescue.tunnel.fud.city,ops.fud.city'
/** ONSEN_FORM_HOSTS: the hosts whose links get a form key (default rescue.tunnel.fud.city, ops.fud.city) */
export function formHosts(env: NodeJS.ProcessEnv): Set<string> {
  const v = String(env.ONSEN_FORM_HOSTS ?? '').trim() || FORM_HOSTS_DEFAULT
  return new Set(v.split(',').map(x => x.trim().toLowerCase()).filter(Boolean))
}

// ------------------------------------------------------------------ 1. the ✍ reaction (ONSEN_REACT_SEEN)
export const SEEN_EMOJI = '✍'
const mk = (chat: string, id: string | number): string => `${chat}\u0000${id}`
/** the main took Joey's message in: ✍ on it, once, unless the agent reacted to it itself. Telegram refuses ✍ (REACTION_INVALID): logged once, no more
 *  ✍ in this daemon's life, the 👀 stays. */
export class SeenReactor {
  private agent = new Set<string>()
  private done = new Set<string>()
  private inflight = new Map<string, Promise<unknown>>()
  private acks = new Map<string, Promise<unknown>>()
  private refused = false
  private warnAt = 0
  readonly stats = { reacted: 0, skipped_agent: 0, failed: 0, refused: false }
  constructor(readonly o: { react: (chat: string, id: number) => Promise<unknown>; log: Log; max?: number }) {}
  private bound(s: Set<string>): void { if (s.size > (this.o.max ?? 5_000)) for (const k of [...s].slice(0, 1_000)) s.delete(k) }
  /** the agent reacted to this message (its react tool): no ✍ on it from now on */
  agentReacted(chat: string, id: string | number): void { this.agent.add(mk(chat, id)); this.bound(this.agent) }
  /** the daemon's 👀 on this message is on its way: a ✍ goes after it (≤ 3 s), never under it */
  ack(chat: string, id: string | number, p: Promise<unknown>): void {
    const k = mk(chat, id)
    this.acks.set(k, p)
    void p.catch(() => {}).finally(() => { if (this.acks.get(k) === p) this.acks.delete(k) })
    if (this.acks.size > 1_000) this.acks.delete(this.acks.keys().next().value!)
  }
  /** the react tool waits for a ✍ still in flight on the same message (≤ 3 s), so the agent's reaction lands last */
  async settle(chat: string, id: string | number): Promise<void> {
    const p = this.inflight.get(mk(chat, id))
    if (p) await Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, 3_000))])
  }
  /** a `seen` report (DeliveryFacts onSeen): `by` main only; a Telegram message id only (a page answer, form-<id>, has no message to react on) */
  seen(chat: string, id: string, by: string): void {
    if (by !== 'main' || this.refused || !/^\d+$/.test(String(id))) return
    const k = mk(chat, id)
    if (this.done.has(k)) return
    if (this.agent.has(k)) { this.done.add(k); this.stats.skipped_agent++; return }
    this.done.add(k); this.bound(this.done)
    const before = this.acks.get(k)
    const first = before ? Promise.race([before.catch(() => {}), new Promise(r => setTimeout(r, 3_000))]) : Promise.resolve()
    const p = first.then(() => this.agent.has(k) ? 'agent' : this.o.react(chat, Number(id))).then(x => { if (x === 'agent') this.stats.skipped_agent++; else this.stats.reacted++ }, e => {
      this.stats.failed++
      const why = errText(e)
      if (/REACTION_INVALID/i.test(why)) {
        this.refused = true; this.stats.refused = true
        this.o.log('warn', `onsen: Telegram refused the ${SEEN_EMOJI} reaction (${why.slice(0, 120)}): the 👀 stays; no ${SEEN_EMOJI} again until the daemon restarts`)
      } else if (Date.now() - this.warnAt > HOUR) {
        this.warnAt = Date.now()
        this.o.log('warn', `onsen: the ${SEEN_EMOJI} reaction on tg:${id} in chat ${chat} failed (${why.slice(0, 160)}); the 👀 stays`)
      }
    }).finally(() => { this.inflight.delete(k) })
    this.inflight.set(k, p)
  }
}

// ------------------------------------------------------------------ 2. the pinned status (ONSEN_STATUS_PIN)
/** HH:MM in Taipei (UTC+8, no daylight saving) */
export function tpe(ms: number): string {
  const d = new Date(ms + 8 * HOUR), p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}
const WAITING: Record<string, string> = { 'permission prompt': '權限詢問', 'dialog open': '選單', 'input needed': '它問了問題',
  // WO-165 A: the menu kinds Jev names (Chiron's questions file, `menu`)
  permission: '權限詢問', model_picker: '模型選單', trust_folder: '要不要信任這個資料夾', usage_limit_options: '撞上限後的選項', resume_picker: '選要接哪段對話',
  plan_or_question: '它問了問題', login: '要登入', other: '選單' }
const OFFLINE: Record<string, string> = { no_registration: '沒有 session', pid_gone: '行程不在了', pid_reused: '行程不在了', not_connected: '連不上' }
/** line 1: what statusOf says, in Joey's words. `sinceMs`: when this state began; `now` for stuck's minutes. Precedence: offline, then the usage wall,
 *  then the state (compacting before stuck: a compaction writes nothing for minutes). */
export function statusLine(v: StatusView, sinceMs: number, now = Date.now()): string {
  const d = (v.detail ?? {}) as Record<string, any>
  const since = `（${tpe(sinceMs)} 起）`
  if (v.state === 'offline') {
    const r = String(d.reason ?? 'no_registration')
    return `⚫ 失連${since}：${OFFLINE[r] ?? r}`
  }
  if (d.walled) {
    const u = d.walled.until ? Date.parse(String(d.walled.until)) : NaN
    return Number.isFinite(u) ? `🔴 撞上限，${tpe(u)} 解除` : '🔴 撞上限'
  }
  if (v.state === 'starting') return `⚪ 啟動中${since}`                  // WO-165 A (Jev reads the screen)
  if (v.state === 'idle') {
    // WO-165 A: what Jev's reading adds to idle (background work the program counted on the screen; a turn just interrupted)
    const b = d.background && typeof d.background === 'object' ? d.background : null
    const bg = b ? [Number(b.agents) > 0 ? `${Number(b.agents)} 隻子 agent` : '', Number(b.shells) > 0 ? `${Number(b.shells)} 個 shell` : '',
      Number(b.monitors) > 0 ? `${Number(b.monitors)} 個 monitor` : ''].filter(Boolean).join('、') : ''
    return bg ? `🟢 閒置${since}：背景還有 ${bg}` : d.interrupted ? `🟢 閒置${since}：剛被中斷` : `🟢 閒置${since}`
  }
  if (v.state === 'waiting') {
    const w = d.waitingFor == null ? '' : String(d.waitingFor)
    return w ? `🟠 等你按${since}：${WAITING[w.toLowerCase()] ?? w}` : `🟠 等你按${since}`
  }
  // busy, stuck (and any state statusOf may add later: shown as busy)
  if (d.compacting) return `🟡 處理中${since}：壓縮中`
  if (v.state === 'stuck') {
    const t = v.last_activity_at ? Date.parse(v.last_activity_at) : NaN
    const n = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : null
    // the busy turn's start, not when it went quiet: 「處理中（14:00 起）：已經 10 分鐘沒動靜」 (WO-145 review)
    const ts = d.turn_started_at ? Date.parse(String(d.turn_started_at)) : NaN
    const s2 = Number.isFinite(ts) ? `（${tpe(ts)} 起）` : since
    return n != null ? `🟡 處理中${s2}：已經 ${n} 分鐘沒動靜` : `🟡 處理中${s2}：很久沒動靜`
  }
  const subs = Number(d.subagents ?? 0)
  // an MCP tool shows its own name, not the server's prefix: mcp__plugin_telegram-http_telegram-http__reply → reply
  const tool = d.tool?.name ? String(d.tool.name).replace(/^mcp__.*__/, '') : ''
  const doing = subs > 0 ? `等 ${subs} 隻子 agent` : tool
  return doing ? `🟡 處理中${since}：${doing}` : `🟡 處理中${since}`
}
/** line 2 ('' = no line): Joey's messages delivered and not yet seen, seen with nothing sent after (a part that is 0 is left out) */
export function pendingLine(c: { unseen: number; seenNoOut: number }): string {
  const parts = [c.unseen > 0 ? `${c.unseen} 則還沒進去` : '', c.seenNoOut > 0 ? `${c.seenNoOut} 則看到了還沒回` : ''].filter(Boolean)
  return parts.length ? `你傳的：${parts.join('、')}` : ''
}
export function statusText(v: StatusView, sinceMs: number, c: { unseen: number; seenNoOut: number }, now = Date.now()): string {
  const l2 = pendingLine(c)
  return l2 ? `${statusLine(v, sinceMs, now)}\n${l2}` : statusLine(v, sinceMs, now)
}

/** when the main's current state began (the state as statusOf names it). Kept in the pin's state file: a daemon restart within `carryMs` in the same
 *  state keeps the time (a fleet rollout restarts every daemon in seconds). */
export class SinceTracker {
  private cur: { state: string; since: number } | null = null
  constructor(readonly o: { load?: () => { state: string; since: number; at: number } | null; save?: (x: { state: string; since: number; at: number }) => void
    carryMs?: number; now?: Now }) {}
  track(state: string): number {
    const now = (this.o.now ?? Date.now)()
    if (!this.cur) {
      const was = this.o.load?.() ?? null
      this.cur = was && was.state === state && now - was.at <= (this.o.carryMs ?? 120_000) && was.since <= now ? { state, since: was.since } : { state, since: now }
    } else if (this.cur.state !== state) this.cur = { state, since: now }
    try { this.o.save?.({ ...this.cur, at: now }) } catch {}
    return this.cur.since
  }
}

/** Joey's messages this daemon took in, per chat: delivered and not seen; seen and nothing the agent sent in that chat after (Onsen's /pending, computed
 *  from this daemon's own lines: its delivery facts, its inbound records (a command is not counted, as at Onsen), its outbound messages (a `system:*`
 *  sender is not an answer)). The last 48 h. */
export class PendingTracker {
  private rows = new Map<string, { chat: string; delivered: number | null; seen: number | null; command: boolean; at: number }>()
  private lastOut = new Map<string, number>()
  constructor(readonly o: { windowMs?: number; now?: Now } = {}) {}
  private now(): number { return (this.o.now ?? Date.now)() }
  private row(chat: string, id: string, at: number) {
    const k = mk(chat, id)
    let r = this.rows.get(k)
    if (!r) { r = { chat, delivered: null, seen: null, command: false, at }; this.rows.set(k, r) }
    if (this.rows.size > 5_000) this.prune(true)
    return r
  }
  private prune(hard = false): void {
    const old = this.now() - (this.o.windowMs ?? 48 * HOUR)
    for (const [k, r] of this.rows) if (r.at < old) this.rows.delete(k)
    if (hard && this.rows.size > 5_000) for (const k of [...this.rows.keys()].slice(0, this.rows.size - 4_000)) this.rows.delete(k)
  }
  /** one spool line (live: OnsenClient.observe; at start: the spool files) */
  line(l: SpoolLine | null | undefined, live = true): void {
    if (!l || !l.r) return
    if (l.k === 'd') this.fact(l.r)
    else if (l.k === 'm') {
      const m = l.r as OnsenItem
      if (m.direction === 'in') this.inbound(m)
      else if (m.status === 'ok') this.out(m.chat, m.sender, live ? this.now() : Date.parse(m.sent_at))
    }
  }
  fact(f: DeliveryFact): void {
    const at = Date.parse(f.at)
    const t = Number.isFinite(at) ? at : this.now()
    const r = this.row(f.chat, f.client_msg_id, t)
    if (f.state === 'delivered') r.delivered ??= t
    else if (f.state === 'seen') r.seen ??= t
  }
  inbound(m: OnsenItem): void {
    if (m.client_msg_id == null) return
    const at = Date.parse(m.sent_at)
    const r = this.row(m.chat, m.client_msg_id, Number.isFinite(at) ? at : this.now())
    if (m.kind === 'command') r.command = true
  }
  out(chat: string, sender: string, at: number): void {
    if (!Number.isFinite(at) || String(sender ?? '').startsWith('system:') || sender === 'system') return
    if (at > (this.lastOut.get(chat) ?? -Infinity)) this.lastOut.set(chat, at)
  }
  counts(chat: string): { unseen: number; seenNoOut: number } {
    this.prune()
    const out = this.lastOut.get(chat) ?? -Infinity
    let unseen = 0, seenNoOut = 0
    for (const r of this.rows.values()) {
      if (r.chat !== chat || r.command) continue
      if (r.seen != null) { if (!(out > r.seen)) seenNoOut++ }
      else if (r.delivered != null) unseen++
    }
    return { unseen, seenNoOut }
  }
  /** at start: the spool files (oldest first), so a restart does not forget what is still pending */
  load(paths: string[]): number {
    let n = 0
    for (const p of paths) {
      if (!existsSync(p)) continue
      try {
        for (const raw of readFileSync(p, 'utf8').split('\n')) {
          if (!raw || !(raw.startsWith('{"k":"d"') || raw.startsWith('{"k":"m"'))) continue
          try { this.line(JSON.parse(raw), false); n++ } catch {}
        }
      } catch {}
    }
    this.prune()
    return n
  }
}

export type PinApi = {
  /** sendMessage, disable_notification: the new message's id */
  send: (chat: string, text: string) => Promise<number>
  /** pinChatMessage, disable_notification */
  pin: (chat: string, id: number) => Promise<unknown>
  /** editMessageText */
  edit: (chat: string, id: number, text: string) => Promise<unknown>
  /** getChat(chat).pinned_message?.message_id (null: nothing pinned) */
  pinnedId: (chat: string) => Promise<number | null>
  /** deleteMessage (the 「不要顯示這則」 button) */
  del?: (chat: string, id: number) => Promise<unknown>
}
type Slot = { message_id: number | null; pinned: boolean; text: string | null; want: string | null; lastEditAt: number; lastCheckAt: number; busy: boolean
  timer: ReturnType<typeof setTimeout> | null; retryAt: number }
const GONE = /message to edit not found|MESSAGE_ID_INVALID|message not found/i
const SAME = /message is not modified/i
/** one status message per DM chat: sent and pinned silently once, then only edited. State in <dir>/status-pin.json (the message per chat, the state's
 *  since); a chat Joey unpinned or whose message he deleted has <dir>/status-pin-off-<chat>.json and gets nothing more until that file is deleted. */
export class StatusPin {
  readonly file: string
  private slots = new Map<string, Slot>()
  private saved: { chats: Record<string, { message_id: number; pinned: boolean; text: string | null }>; since?: { state: string; since: number; at: number } }
  private warnAt = new Map<string, number>()
  readonly stats = { sent: 0, edits: 0, pin_checks: 0, stopped: 0, errors: 0 }
  constructor(readonly o: { dir: string; api: PinApi; log: Log; now?: Now; minEditMs?: number; pinCheckMs?: number; retryMs?: number }) {
    this.file = join(o.dir, 'status-pin.json')
    this.saved = { chats: {} }
    try { const j = JSON.parse(readFileSync(this.file, 'utf8')); if (j && typeof j === 'object' && j.chats) this.saved = j } catch {}
  }
  private now(): number { return (this.o.now ?? Date.now)() }
  offFile(chat: string): string { return join(this.o.dir, `status-pin-off-${String(chat).replace(/[^0-9-]/g, '_')}.json`) }
  isOff(chat: string): boolean { return existsSync(this.offFile(chat)) }
  /** the since tracker's own record (one per agent), in the same file */
  sinceStore(): { load: () => { state: string; since: number; at: number } | null; save: (x: { state: string; since: number; at: number }) => void } {
    let lastWrite = 0
    return {
      load: () => this.saved.since ?? null,
      save: x => { const changed = x.state !== this.saved.since?.state || x.since !== this.saved.since?.since; this.saved.since = x
        if (changed || this.now() - lastWrite > 30_000) { lastWrite = this.now(); this.persist() } },
    }
  }
  private persist(): void {
    try {
      mkdirSync(this.o.dir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) { this.warn('persist', `onsen: could not write ${this.file} (${errText(e)})`) }
  }
  private warn(key: string, msg: string): void {
    const t = this.warnAt.get(key) ?? 0
    if (this.now() - t < HOUR) return
    this.warnAt.set(key, this.now())
    this.o.log('warn', msg)
  }
  private slot(chat: string): Slot {
    let s = this.slots.get(chat)
    if (!s) {
      const v = this.saved.chats[chat]
      s = { message_id: v?.message_id ?? null, pinned: !!v?.pinned, text: v?.text ?? null, want: null, lastEditAt: 0, lastCheckAt: 0, busy: false, timer: null, retryAt: 0 }
      this.slots.set(chat, s)
    }
    return s
  }
  private save(chat: string, s: Slot): void {
    if (s.message_id == null) delete this.saved.chats[chat]
    else this.saved.chats[chat] = { message_id: s.message_id, pinned: s.pinned, text: s.text }
    this.persist()
  }
  /** Joey does not want it in this chat: the marker file, the message forgotten (deleting the marker starts a new one) */
  /** the 「不要顯示這則」 button (Chiron WO-145 point 5, 06:04Z): stop in this chat as an unpin would (the marker, remembered across restarts), and
   *  delete the message. The message id it deleted, or null when there was none. */
  async dismiss(chat: string): Promise<number | null> {
    const v = this.saved.chats[chat]
    const s: Slot = this.slots.get(chat) ?? { message_id: v?.message_id ?? null, pinned: !!v?.pinned, text: v?.text ?? null, want: null, lastEditAt: 0, lastCheckAt: 0,
      busy: false, timer: null, retryAt: 0 }
    const id = s.message_id
    this.stop(chat, s, 'dismissed')
    if (id != null && this.o.api.del) { try { await this.o.api.del(chat, id) } catch (e) { this.o.log('warn', `onsen: deleting the status message ${id} in chat ${chat} failed (${errText(e)})`) } }
    return id
  }
  private stop(chat: string, s: Slot, why: 'unpinned' | 'deleted' | 'dismissed'): void {
    try {
      mkdirSync(this.o.dir, { recursive: true, mode: 0o700 })
      writeFileSync(this.offFile(chat), JSON.stringify({ chat, why, message_id: s.message_id, at: new Date(this.now()).toISOString(),
        note: 'Joey unpinned or deleted the status message: none is sent or edited in this chat. Delete this file to start again.' }, null, 2), { mode: 0o600 })
    } catch (e) { this.o.log('warn', `onsen: could not write ${this.offFile(chat)} (${errText(e)})`) }
    this.o.log('info', `onsen: status message ${s.message_id} in chat ${chat} was ${why} by Joey: no status message there any more (${this.offFile(chat)})`)
    this.stats.stopped++
    if (s.timer) clearTimeout(s.timer)
    this.slots.delete(chat)
    delete this.saved.chats[chat]
    this.persist()
  }
  /** the next update in this chat sends at once, not after the wait a failed send set (telegram-bridge: the person wrote to the bot) */
  retryNow(chat: string): void { const s = this.slots.get(chat); if (s) s.retryAt = 0 }
  /** the text this chat's status message should show now */
  update(chat: string, text: string): void {
    if (this.isOff(chat)) {
      const s = this.slots.get(chat)
      if (s) { if (s.timer) clearTimeout(s.timer); this.slots.delete(chat) }
      if (this.saved.chats[chat]) { delete this.saved.chats[chat]; this.persist() }
      return
    }
    const s = this.slot(chat)
    s.want = text
    void this.pump(chat, s)
  }
  private async pump(chat: string, s: Slot): Promise<void> {
    if (s.busy || s.want == null || this.slots.get(chat) !== s) return
    const now = this.now()
    if (s.message_id == null) {
      if (now < s.retryAt) return
      s.busy = true
      const text = s.want
      try {
        const id = await this.o.api.send(chat, text)
        this.stats.sent++
        s.message_id = id; s.text = text; s.lastEditAt = this.now(); s.lastCheckAt = this.now()
        this.save(chat, s)
        try { await this.o.api.pin(chat, id); s.pinned = true } catch (e) { this.warn(`pin:${chat}`, `onsen: pinning the status message ${id} in chat ${chat} failed (${errText(e)}); tried again at the next check`) }
        this.save(chat, s)
      } catch (e) {
        this.stats.errors++
        s.retryAt = this.now() + (this.o.retryMs ?? 600_000)
        this.warn(`send:${chat}`, `onsen: the status message could not be sent in chat ${chat} (${errText(e)}); tried again in ${Math.round((this.o.retryMs ?? 600_000) / 60_000)} min`)
      } finally { s.busy = false }
      return this.again(chat, s)
    }
    if (s.want === s.text) return
    const wait = s.lastEditAt + (this.o.minEditMs ?? 5_000) - now
    if (wait > 0) {
      if (!s.timer) { s.timer = setTimeout(() => { s.timer = null; void this.pump(chat, s) }, wait); (s.timer as any).unref?.() }
      return
    }
    s.busy = true
    try {
      if (now - s.lastCheckAt >= (this.o.pinCheckMs ?? 60_000)) {
        s.lastCheckAt = now
        this.stats.pin_checks++
        let pid: number | null | undefined
        try { pid = await this.o.api.pinnedId(chat) } catch (e) { pid = undefined; this.warn(`check:${chat}`, `onsen: getChat ${chat} failed (${errText(e)}); the pin is checked again later`) }
        if (pid !== undefined) {
          if (s.pinned && pid !== s.message_id) { s.busy = false; return this.stop(chat, s, 'unpinned') }
          if (!s.pinned) { try { await this.o.api.pin(chat, s.message_id); s.pinned = true; this.save(chat, s) } catch (e) { this.warn(`pin:${chat}`, `onsen: pinning the status message ${s.message_id} in chat ${chat} failed again (${errText(e)})`) } }
        }
      }
      const text = s.want
      try {
        await this.o.api.edit(chat, s.message_id, text)
        this.stats.edits++
        s.text = text
      } catch (e) {
        const why = errText(e)
        if (GONE.test(why)) { s.busy = false; return this.stop(chat, s, 'deleted') }
        if (SAME.test(why)) s.text = text
        else { this.stats.errors++; this.warn(`edit:${chat}`, `onsen: editing the status message ${s.message_id} in chat ${chat} failed (${why}); tried again with the next change`) }
      }
      s.lastEditAt = this.now()
      this.save(chat, s)
    } finally { s.busy = false }
    return this.again(chat, s)
  }
  private again(chat: string, s: Slot): void { if (s.want != null && s.want !== s.text && this.slots.get(chat) === s) void this.pump(chat, s) }
  /** tests / health: the message and its text per chat */
  view(): Record<string, { message_id: number | null; pinned: boolean; text: string | null }> {
    const out: Record<string, { message_id: number | null; pinned: boolean; text: string | null }> = {}
    for (const [c, s] of this.slots) out[c] = { message_id: s.message_id, pinned: s.pinned, text: s.text }
    return out
  }
  stopTimers(): void { for (const s of this.slots.values()) if (s.timer) { clearTimeout(s.timer); s.timer = null } }
}

// ------------------------------------------------------------------ 3. page forms (ONSEN_FORM_LINKS)
// a URL in a reply: ASCII URL characters (a markdown link's `)`, `<…>`, quotes and CJK punctuation end it); trailing sentence punctuation is not part of it
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g
const TRAIL = /[.,;:!?*_~]+$/
export type FormKey = { id: number; key: string; expires_at?: string }
/** the title of a form: the URL's own line without the link, else the nearest non-empty line above, then below; else the URL's path (≤ 120) */
export function formTitle(text: string, at: number, url: string): string {
  const lines = text.split('\n')
  let pos = 0, li = 0
  for (; li < lines.length; li++) { if (at <= pos + lines[li]!.length) break; pos += lines[li]!.length + 1 }
  const clean = (l: string): string => l.replace(URL_RE, ' ').replace(/\[([^\]]*)\]\(\s*\)/g, '$1').replace(/[<>[\]()*_`~|]/g, ' ')
    .replace(/^\s*(?:#+|[-+>]|\d+[.)])\s+/, '').replace(/[\s:：，,、。.]+$/, '').replace(/\s+/g, ' ').trim()
  const pick = (l: string | undefined): string => l == null ? '' : clean(l)
  let t = pick(lines[li])
  for (let i = li - 1; !t && i >= 0; i--) t = pick(lines[i])
  for (let i = li + 1; !t && i < lines.length; i++) t = pick(lines[i])
  if (!t) { try { const u = new URL(url); t = u.pathname && u.pathname !== '/' ? u.pathname : u.hostname } catch { t = url } }
  return [...t].slice(0, 120).join('')
}
/** the URL with `k` added: before the #fragment, `&k=` when it already has a query */
export function withKey(url: string, key: string): string {
  const h = url.indexOf('#')
  const base = h >= 0 ? url.slice(0, h) : url, frag = h >= 0 ? url.slice(h) : ''
  const q = base.indexOf('?')
  const sep = q < 0 ? '?' : (base.endsWith('?') || base.endsWith('&')) ? '' : '&'
  return `${base}${sep}k=${encodeURIComponent(key)}${frag}`
}
/** every link of the text to one of `hosts` (that has no `k` of its own) gets a form key: one POST /forms per distinct link (chat, title), all within
 *  `timeoutMs` (default 3 s). A link without a key in time stays as written. redact: [keyed link, link] for the record, then each bare key. */
export async function rewriteFormLinks(text: string, o: { hosts: Set<string>; chat: string; create: (title: string, url: string) => Promise<FormKey | null>
  timeoutMs?: number }): Promise<{ text: string; redact: Array<[string, string]>; forms: Array<{ id: number; url: string }>; missed: number; why: string[] }> {
  const found = new Map<string, number>()
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    const u = m[0].replace(TRAIL, '')
    if (found.has(u)) continue
    let ok = false
    try { const x = new URL(u); ok = o.hosts.has(x.hostname.toLowerCase()) && !x.searchParams.has('k') } catch {}
    if (ok) found.set(u, m.index ?? 0)
  }
  if (!found.size) return { text, redact: [], forms: [], missed: 0, why: [] }
  const why: string[] = []
  const deadline = new Promise<null>(r => { const t = setTimeout(() => r(null), o.timeoutMs ?? 3_000); (t as any).unref?.() })
  const keys = await Promise.all([...found].map(async ([u, at]) => {
    const k = await Promise.race([o.create(formTitle(text, at, u), u).catch(e => { why.push(errText(e).slice(0, 120)); return null }), deadline])
    return [u, k && typeof k.key === 'string' && k.key ? k : null] as const
  }))
  const keyed = new Map<string, { url: string; f: FormKey }>()
  for (const [u, k] of keys) if (k) keyed.set(u, { url: withKey(u, k.key), f: k })
  const out = keyed.size ? text.replace(URL_RE, m => { const u = m.replace(TRAIL, ''); const k = keyed.get(u); return k ? k.url + m.slice(u.length) : m }) : text
  const redact: Array<[string, string]> = [...keyed].map(([u, k]) => [k.url, u] as [string, string])
  for (const k of keyed.values()) redact.push([encodeURIComponent(k.f.key), ''])
  return { text: out, redact, forms: [...keyed].map(([u, k]) => ({ id: Number(k.f.id), url: u })), missed: found.size - keyed.size, why }
}

export type FormItem = { id: number; form_id: number; chat: string; title: string; body: string; at?: string; say?: boolean   // say (WO-159): Joey wrote it in Onsen
  /** WO-189: the files of a `say` item (Onsen's Message.attachments: kind, name, mime, bytes, url) */
  attachments?: Array<{ kind?: string | null; name?: string | null; mime?: string | null; bytes?: number | null; url?: string | null }>
  /** WO-194 (Chiron, mesh 12695): the message a page message (person_message via web) replies to, as Onsen gives it */
  reply_to?: { message_id?: string | number | null; client_msg_id?: string | number | null; from?: string | null; text?: string | null } }
/** a form answer's body as text: JSON (an object of plain values: `key: value` lines; anything else pretty-printed); a JSON string its text; else as sent */
export function formBodyText(body: unknown): string {
  const s = String(body ?? '')
  let j: unknown
  try { j = JSON.parse(s) } catch { return s }
  if (typeof j === 'string') return j
  if (j && typeof j === 'object' && !Array.isArray(j) && Object.values(j).every(v => v == null || typeof v !== 'object'))
    return Object.entries(j as Record<string, unknown>).map(([k, v]) => `${k}: ${v ?? ''}`).join('\n')
  if (j && typeof j === 'object') return JSON.stringify(j, null, 2)
  return s
}
/** what Joey sees in the chat for his own page answer (silent) */
export const formEchoText = (it: Pick<FormItem, 'title' | 'body' | 'say'>): string =>
  it.say ? `〔你在 Onsen 傳的〕\n${it.body}` : `〔你在頁面送出的｜${it.title}〕\n${formBodyText(it.body)}`

/** the answers to the forms this agent sent (GET /forms/inbox?wait=25, a long poll): each goes to the main (deliver), is echoed (echo), then acked; an ack
 *  Onsen does not take goes through the spool. An answer comes back until acked: the ids delivered are kept (<dir>/forms-delivered.json), never twice. */
export class FormInbox {
  readonly file: string
  private delivered: number[] = []
  private running = false
  private warnAt = new Map<string, number>()
  readonly stats = { polls: 0, delivered: 0, dropped: 0, acked: 0, ack_spooled: 0, errors: 0, last_error: null as string | null }
  constructor(readonly o: {
    dir: string
    /** one call to Onsen with the agent's credential (null: none) */
    request: (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; json: any } | null>
    /** queue it for the main; false: not deliverable (acked and dropped; the caller logs why) */
    deliver: (it: FormItem) => Promise<boolean>
    echo: (it: FormItem) => Promise<unknown>
    /** the ack through the spool (Onsen down); false: could not be spooled */
    spoolAck: (ids: number[]) => boolean
    log: Log
    waitS?: number; backoffMs?: number; maxBackoffMs?: number; sleep?: (ms: number) => Promise<void>
  }) {
    this.file = join(o.dir, 'forms-delivered.json')
    try { const j = JSON.parse(readFileSync(this.file, 'utf8')); if (Array.isArray(j?.ids)) this.delivered = j.ids.map(Number).filter(Number.isFinite) } catch {}
  }
  private warn(key: string, msg: string): void {
    const t = this.warnAt.get(key) ?? 0
    if (Date.now() - t < HOUR) return
    this.warnAt.set(key, Date.now())
    this.o.log('warn', msg)
  }
  has(id: number): boolean { return this.delivered.includes(id) }
  private remember(id: number): void {
    this.delivered.push(id)
    if (this.delivered.length > 2_000) this.delivered = this.delivered.slice(-1_500)
    try {
      mkdirSync(this.o.dir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ ids: this.delivered }), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) { this.warn('persist', `onsen: could not write ${this.file} (${errText(e)}): an answer may be delivered again after a restart`) }
  }
  private sleep(ms: number): Promise<void> { return this.o.sleep ? this.o.sleep(ms) : new Promise(r => { const t = setTimeout(r, ms); (t as any).unref?.() }) }
  start(): void {
    if (this.running) return
    this.running = true
    void (async () => {
      let backoff = 0
      while (this.running) {
        const r = await this.pollOnce().catch(e => ({ ok: false, wait: 0, why: errText(e) }))
        if (!this.running) break
        if (r.ok) { backoff = 0; if (r.wait) await this.sleep(r.wait); continue }
        backoff = r.wait || Math.min(Math.max(this.o.backoffMs ?? 5_000, backoff * 2), this.o.maxBackoffMs ?? 60_000)
        await this.sleep(backoff)
      }
    })()
  }
  stop(): void { this.running = false }
  /** one long poll and what it brought; ok false: wait (ms, 0 = the backoff) before the next */
  async pollOnce(): Promise<{ ok: boolean; wait: number; why?: string }> {
    const w = this.o.waitS ?? 25
    this.stats.polls++
    const t0 = Date.now()
    let r: { status: number; json: any } | null
    try { r = await this.o.request('GET', `/forms/inbox?wait=${w}`, undefined, (w + 15) * 1000) }
    catch (e) { return this.failed(`unreachable (${errText(e).slice(0, 120)})`) }
    if (r == null) { this.warn('cred', 'onsen: forms inbox: no mesh credential; page answers wait in Onsen'); return { ok: false, wait: 30_000, why: 'no credential' } }
    if (r.status === 404) { this.warn('404', 'onsen: forms inbox: Onsen answered 404 (no /forms/inbox there yet); asked again every minute'); return { ok: false, wait: 60_000, why: '404' } }
    if (r.status !== 200 || !Array.isArray(r.json?.items)) return this.failed(`HTTP ${r.status}`)
    const items = (r.json.items as any[]).filter(x => x && Number.isFinite(Number(x.id))).map(x => ({ ...x, id: Number(x.id), form_id: Number(x.form_id), chat: String(x.chat ?? ''),
      title: String(x.title ?? ''), body: String(x.body ?? ''), ...(x.say === true ? { say: true } : {}) }) as FormItem).sort((a, b) => a.id - b.id)
    const ack: number[] = []
    let broke = false
    for (const it of items) {
      if (this.has(it.id)) { ack.push(it.id); continue }                     // delivered before (its ack was lost or is still in the spool)
      let ok: boolean
      try { ok = await this.o.deliver(it) } catch (e) { this.stats.errors++; this.warn(`deliver:${it.id}`, `onsen: page answer ${it.id} could not be queued for the main (${errText(e)}); it comes back on the next poll`); broke = true; break }
      if (!ok) { this.stats.dropped++; ack.push(it.id); continue }
      this.remember(it.id)
      this.stats.delivered++
      this.o.log('info', `onsen: page answer ${it.id} (form ${it.form_id} 「${it.title.slice(0, 60)}」) queued for the main in chat ${it.chat}`)
      try { await this.o.echo(it) } catch (e) { this.warn(`echo:${it.chat}`, `onsen: the echo of page answer ${it.id} in chat ${it.chat} failed (${errText(e)})`) }
      ack.push(it.id)
    }
    if (ack.length) await this.ack(ack)
    this.stats.last_error = null
    // an Onsen that answers an empty inbox at once (no long poll) is not asked again in a tight loop
    return { ok: true, wait: broke ? 5_000 : !items.length && Date.now() - t0 < 1_000 ? 2_000 : 0 }
  }
  private failed(why: string): { ok: false; wait: number; why: string } {
    this.stats.errors++
    if (this.stats.last_error !== why) this.o.log('warn', `onsen: forms inbox: ${why}; asked again after a pause`)
    this.stats.last_error = why
    return { ok: false, wait: 0, why }
  }
  private async ack(ids: number[]): Promise<void> {
    let why = ''
    try {
      const r = await this.o.request('POST', '/forms/ack', { ids }, 5_000)
      if (r && r.status >= 200 && r.status < 300) { this.stats.acked += ids.length; return }
      why = r ? `HTTP ${r.status}` : 'no credential'
    } catch (e) { why = errText(e).slice(0, 120) }
    if (this.o.spoolAck(ids)) { this.stats.ack_spooled += ids.length; this.o.log('warn', `onsen: forms ack ${ids.join(',')} not taken directly (${why}); in the spool`) }
    else this.o.log('warn', `onsen: forms ack ${ids.join(',')} failed (${why}) and could not be spooled; Onsen hands them out again, the daemon does not deliver them twice`)
  }
}

/** delete a chat's status-off marker (what an operator does by hand: `rm <STATE_DIR>/onsen/status-pin-off-<chat>.json`) */
export function clearStatusOff(dir: string, chat: string): void { try { rmSync(join(dir, `status-pin-off-${String(chat).replace(/[^0-9-]/g, '_')}.json`)) } catch {} }
