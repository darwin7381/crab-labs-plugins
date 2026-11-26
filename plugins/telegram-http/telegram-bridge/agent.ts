// agent.ts: one carried agent inside telegram-bridge (WO-196 part B): its bot (the token from its own .telegram-state/.env, in memory only), its
// access.json (read in place), and the pieces of the daemon's Telegram face it shares with the daemon's code: the ✍ reactor (onsen-visible.ts
// SeenReactor), the pinned status (onsen-visible.ts StatusPin, PendingTracker, SinceTracker, statusLine / pendingLine). The pinned status's own
// file lives in the bridge's state dir (pins/<member>/); the first time, the daemon's record (<state dir>/onsen/status-pin.json and its
// status-pin-off-<chat>.json markers) is copied there, so the message already pinned in Joey's chat is the one edited and a chat he turned off
// stays off.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PendingTracker, SEEN_EMOJI, SeenReactor, SinceTracker, StatusPin, pendingLine, statusLine, tpe } from '../onsen-visible.ts'
import { readAccess, type Access } from './tg-access.ts'
import { Tg, type TgOptions } from './tg.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export type EndpointState = 'ok' | 'conflict' | 'error'

export class Agent {
  tg: Tg
  tokenMtime: number
  botId: string
  username = ''
  displayName: string | null = null
  /** Onsen's endpoint list: 'ok' it took this member from us; 'conflict' another bridge carries it (`holder`); 'error' see lastError */
  state: EndpointState = 'error'
  holder: string | null = null
  accepted = false
  lastError: string | null = 'not registered with Onsen yet'
  telegramConflict = false
  lastUpdateAt: number | null = null
  stats = { written: 0, duplicates: 0, refused: 0, sorry: 0, drawn: 0, draw_failed: 0, pairing: 0 }
  readonly seen: SeenReactor
  readonly pending = new PendingTracker()
  private pinObj: StatusPin | null = null
  private since: SinceTracker | null = null
  /** the newest observation per chat: the pin's line 1 (line 2 is redrawn from it when the counts change) */
  readonly status = new Map<string, { status: any; at: number }>()
  constructor(readonly member: string, readonly stateDir: string, readonly source: string, token: { token: string; mtime: number }, readonly o: {
    bridgeDir: string; tgOptions: TgOptions; log: Log; now?: () => number
  }) {
    this.tg = new Tg(token.token, o.tgOptions)
    this.tokenMtime = token.mtime
    this.botId = this.tg.botId
    this.seen = new SeenReactor({ log: o.log, react: (chat, id) => this.tg.call('setMessageReaction', { chat_id: chat, message_id: id, reaction: [{ type: 'emoji', emoji: SEEN_EMOJI }] }) })
  }
  now(): number { return (this.o.now ?? Date.now)() }
  /** the token changed in .env: a new client (the poller picks it up at its next call) */
  setToken(token: { token: string; mtime: number }): void { this.tg = new Tg(token.token, this.o.tgOptions); this.tokenMtime = token.mtime; this.botId = this.tg.botId }
  access(): Access | null { return readAccess(this.stateDir) }
  /** the name to write in a sentence to the person: Onsen's display name, else the member */
  name(): string { return this.displayName || this.member }

  pinDir(): string { return join(this.o.bridgeDir, 'pins', this.member) }
  pin(): StatusPin {
    if (this.pinObj) return this.pinObj
    const dir = this.pinDir()
    if (!existsSync(join(dir, 'status-pin.json'))) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const old = join(this.stateDir, 'onsen')
        if (existsSync(join(old, 'status-pin.json'))) copyFileSync(join(old, 'status-pin.json'), join(dir, 'status-pin.json'))
        for (const f of (existsSync(old) ? readdirSync(old) : []).filter(n => /^status-pin-off-[0-9_-]+\.json$/.test(n))) copyFileSync(join(old, f), join(dir, f))
      } catch (e) { this.o.log('warn', `${this.member}: the daemon's pinned-status record was not copied (${(e as Error).message}); a new status message is pinned`) }
    }
    const kb = { inline_keyboard: [[{ text: '不要顯示這則', callback_data: 'opin:off' }]] }
    this.pinObj = new StatusPin({ dir, log: this.o.log, now: this.o.now, api: {
      send: async (chat, text) => Number((await this.tg.call('sendMessage', { chat_id: chat, text, disable_notification: true, reply_markup: kb })).message_id),
      pin: (chat, id) => this.tg.call('pinChatMessage', { chat_id: chat, message_id: id, disable_notification: true }),
      edit: (chat, id, text) => this.tg.call('editMessageText', { chat_id: chat, message_id: id, text, reply_markup: kb }),
      del: (chat, id) => this.tg.call('deleteMessage', { chat_id: chat, message_id: id }),
      pinnedId: async chat => { const c: any = await this.tg.call('getChat', { chat_id: chat }); return c?.pinned_message?.message_id ?? null },
    } })
    this.since = new SinceTracker({ ...this.pinObj.sinceStore(), now: this.o.now })
    return this.pinObj
  }
  /** an observation for this chat (a DM: the pinned status lives in DMs only, as today) */
  observe(chat: string, status: any): void {
    if (!/^\d+$/.test(chat)) return
    this.status.set(chat, { status, at: this.now() })
    this.redrawPin(chat)
  }
  redrawPin(chat: string): void {
    const s = this.status.get(chat)
    if (!s) return
    const pin = this.pin()
    const l1 = pinLine(s.status, this.since!, this.now())
    const l2 = pendingLine(this.pending.counts(chat))
    pin.update(chat, l2 ? `${l1}\n${l2}` : l1)
  }
  stop(): void { this.pinObj?.stopTimers() }
}

// ---- Onsen's MemberStatus (CONTRACT §3) → the daemon's pinned line 1 --------------------------------------------------------------------
const OFFLINE_OF: Record<string, string> = { process_gone: 'pid_gone', disconnected: 'not_connected', heartbeat_expired: 'not_connected', never_reported: 'no_registration' }

/** the daemon's StatusView (onsen-status.ts) for an Onsen v1 status, so statusLine draws it as today; null when there is nothing to say */
export function statusView(st: any, now: number): { view: { state: any; detail: Record<string, unknown>; last_activity_at: string | null }; since: number | null } | null {
  if (!st || typeof st !== 'object') return null
  const sessions: any[] = Array.isArray(st.sessions) ? st.sessions : []
  const main = sessions.find(s => s?.id === st.main_session_id) ?? sessions.find(s => s?.kind === 'main') ?? null
  const since = main?.activity_since ? Date.parse(main.activity_since) : NaN
  const sinceMs = Number.isFinite(since) ? since : null
  const expired = st.valid_until ? Date.parse(st.valid_until) <= now : false
  const last = st.last_activity_at ?? null
  if (st.presence === 'offline' || st.presence === 'unknown' || expired) {
    const r = OFFLINE_OF[String(st.presence_reason ?? '')] ?? (expired ? 'not_connected' : 'no_registration')
    return { view: { state: 'offline', detail: { reason: r }, last_activity_at: last }, since: sinceMs }
  }
  const detail: Record<string, unknown> = {}
  const blockers: any[] = Array.isArray(main?.blockers) ? main.blockers : []
  const wall = blockers.find(b => b?.reason === 'usage_limit')
  if (wall) detail.walled = { until: wall.until ?? null }
  if (st.lifecycle === 'starting') return { view: { state: 'starting', detail, last_activity_at: last }, since: sinceMs }
  const act = String(main?.activity ?? 'unknown')
  if (act === 'running') {
    const d = main?.doing ?? null
    if (d?.kind === 'compacting') detail.compacting = true
    if (d?.kind === 'tool' && d.tool) detail.tool = { name: String(d.tool) }
    if (d?.kind === 'waiting_subagents') detail.subagents = Number(st.background?.agents ?? 0) || 1
    return { view: { state: 'busy', detail, last_activity_at: last }, since: sinceMs }
  }
  if (act === 'stuck') {
    if (main?.turn?.started_at) detail.turn_started_at = main.turn.started_at
    return { view: { state: 'stuck', detail, last_activity_at: last }, since: sinceMs }
  }
  const ask = blockers.find(b => b?.reason === 'permission' || b?.reason === 'input_required')
  if (act === 'paused' || (act === 'idle' && ask)) {
    if (ask) detail.waitingFor = ask.menu_kind ?? (ask.reason === 'permission' ? 'permission' : 'other')
    return { view: { state: 'waiting', detail, last_activity_at: last }, since: sinceMs }
  }
  if (act === 'idle') {
    if (st.background && typeof st.background === 'object') detail.background = st.background
    if (main?.last_turn?.outcome === 'interrupted') detail.interrupted = true
    return { view: { state: 'idle', detail, last_activity_at: last }, since: sinceMs }
  }
  return null
}

/** line 1 of the pinned status: the daemon's statusLine on the mapped view; a state it has no words for: ⚪ and Onsen's own phrase */
export function pinLine(st: any, since: SinceTracker, now: number): string {
  const v = statusView(st, now)
  if (!v) {
    const at = since.track('unknown')
    return `⚪ ${String(st?.phrase ?? '狀態不明').replace(/\s+/g, ' ').slice(0, 80)}（${tpe(at)} 起）`
  }
  const at = since.track(v.view.state)
  return statusLine(v.view as any, v.since ?? at, now)
}
