// telegram-bridge.ts: the Telegram bridge of Onsen (board WO-196 part B; CONTRACT §7d 「橋接介面（Bridge）」, §7b extensions; design
// https://rescue.tunnel.fud.city/onsen-bridge.html 二–四). Joey (TG chiron:2634): 「畢竟之後我們自己有客戶端也不一定用 telegram 後也能從這些機制
// 解放出來」. Telegram is one plug-in: every message between a person and an agent goes through Onsen; this program carries it to and from the
// agent's own bot. One per machine (Mac mini, MBP, txmonster), not one per agent (the Mac mini has 24 GB and ran out of memory on 11-25).
//
//   identity   a BTCC system identity telegram-bridge-<machine>; its credential ~/.config/mesh/telegram-bridge-<machine>.credential (read again
//              when the file changes, never logged). Registered as the extension of that name: PUT /v1/extensions/<name> {kind:"bridge",
//              client:"telegram", title, version, machine, collections:[endpoints]} at start, every 5 min, and again on a 404.
//   which bots agents.ts: ONSEN_BRIDGE (the machine settings, read again every 30 s) ∩ this machine's agents (ONSEN_BRIDGE_STATE_DIRS, then the
//              installed daemons). Each token from that agent's own .telegram-state/.env, in memory only.
//   endpoints  PUT /v1/extensions/<name>/collections/endpoints, one record per carried agent (see endpointRecord), when it changed and every
//              30 s (ttl 120 s). A bot is polled only once Onsen's list took its member from this bridge. 409 endpoint_taken: that member is
//              another bridge's (error.taken [{member, bridge}]): its record goes with state conflict (which claims nothing), its bot is not
//              polled, and it is asked for again every 5 min. Onsen not answering at start: the members it took last time (state.json) are polled meanwhile.
//   in         inbound.ts (one long poll per bot, all in this process). out: outbound.ts, from one long poll of GET /v1/bridge/feed (the cursor
//              in state.json; a restart goes on from it).
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Agent } from './agent.ts'
import { carried, discover, MEMBER_RE, readSettings, readToken, settingsPath, type Found, type Settings } from './agents.ts'
import { Poller, type PollerDeps } from './inbound.ts'
import { errCode, errSaid, OnsenClient } from './onsen.ts'
import { Drawer } from './outbound.ts'
import { StageTwo } from './stage-two.ts'
import { StateStore } from './state.ts'
import { isRich } from './tg-format.ts'
import { errText, TgError, type TgOptions } from './tg.ts'

export const KIND = 'bridge'
export const CLIENT = 'telegram'
export const LIST = 'endpoints'
export const TTL_S = 120
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NOT_ONE_LINE = /[\u0000-\u001f\u007f\u2028\u2029]/g
const LIMIT = { title: 200, line: 500, state: 40, attr: 2000 }
const oneLine = (s: string, most: number): string => { const t = s.replace(NOT_ONE_LINE, ' '); return t.length > most ? t.slice(0, most - 1) + '…' : t }

export type Config = {
  machine: string; name: string; base: string; credentialFile: string; stateDir: string; home: string; platform: string
  env: NodeJS.ProcessEnv; settingsFile: string
  settingsMs: number; endpointsMs: number; registerMs: number; membersMs: number; conflictRetryMs: number; feedWaitS: number; pollTimeoutS: number
  tg: TgOptions; useRich: boolean; version: string; handoverMs: number; pinCheckMs?: number; pinMinEditMs?: number; onsenTimeoutMs: number; sorryMs: number; retryDelaysMs: number[]
}

function pluginVersion(): string {
  try { return String(JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version || '') || 'unknown' } catch { return 'unknown' }
}
const num = (v: string | undefined, d: number, min: number): number => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d }

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || homedir()
  const machine = (env.TELEGRAM_BRIDGE_MACHINE ?? '').trim()
  if (!NAME_RE.test(machine)) throw new Error('TELEGRAM_BRIDGE_MACHINE is required: the machine name Onsen uses (macmini, mbp, txmonster)')
  const name = (env.TELEGRAM_BRIDGE_NAME ?? '').trim() || `telegram-bridge-${machine}`
  if (!NAME_RE.test(name)) throw new Error(`extension name ${name}: lowercase letters, digits and -, at most 64 (a mesh identity's name)`)
  const stateDir = (env.TELEGRAM_BRIDGE_STATE_DIR ?? '').trim() || join(home, '.local', 'state', 'telegram-bridge')
  return {
    machine, name, home, env, platform: env.TELEGRAM_BRIDGE_PLATFORM || process.platform, stateDir, settingsFile: settingsPath(env),
    base: ((env.ONSEN_BASE ?? '').trim() || 'https://core.kbro.ai/api/onsen').replace(/\/+$/, ''),
    credentialFile: (env.TELEGRAM_BRIDGE_CREDENTIAL_FILE ?? '').trim() || join(home, '.config/mesh', `${name}.credential`),
    settingsMs: num(env.TELEGRAM_BRIDGE_SETTINGS_S, 30, 0.05) * 1000,
    endpointsMs: num(env.TELEGRAM_BRIDGE_ENDPOINTS_S, 30, 0.05) * 1000,
    registerMs: num(env.TELEGRAM_BRIDGE_REGISTER_S, 300, 0.05) * 1000,
    membersMs: num(env.TELEGRAM_BRIDGE_MEMBERS_S, 300, 0.05) * 1000,
    conflictRetryMs: num(env.TELEGRAM_BRIDGE_CONFLICT_RETRY_S, 300, 0.05) * 1000,
    feedWaitS: Math.min(55, num(env.TELEGRAM_BRIDGE_FEED_WAIT_S, 50, 0)),
    pollTimeoutS: num(env.TELEGRAM_BRIDGE_POLL_TIMEOUT_S, 50, 0),
    tg: { apiRoot: (env.TELEGRAM_API_ROOT ?? '').trim() || undefined, sendTimeoutMs: num(env.TELEGRAM_SEND_TIMEOUT_S, 45, 1) * 1000,
      uploadTimeoutMs: num(env.TELEGRAM_UPLOAD_TIMEOUT_S, 300, 1) * 1000 },
    useRich: isRich(env),
    onsenTimeoutMs: num(env.TELEGRAM_BRIDGE_ONSEN_TIMEOUT_MS, 15_000, 100),
    handoverMs: num(env.TELEGRAM_BRIDGE_HANDOVER_S, 60, 0.05) * 1000,
    ...(env.TELEGRAM_BRIDGE_PIN_CHECK_S ? { pinCheckMs: num(env.TELEGRAM_BRIDGE_PIN_CHECK_S, 60, 0.05) * 1000 } : {}),
    ...(env.TELEGRAM_BRIDGE_PIN_EDIT_MS ? { pinMinEditMs: num(env.TELEGRAM_BRIDGE_PIN_EDIT_MS, 5000, 0) } : {}),
    sorryMs: num(env.TELEGRAM_BRIDGE_SORRY_S, 15, 0) * 1000,
    retryDelaysMs: ((env.TELEGRAM_BRIDGE_RETRY_S ?? '').trim() || '10,30,120').split(',').map(x => Number(x.trim()) * 1000).filter(n => Number.isFinite(n) && n >= 0),
    version: pluginVersion(),
  }
}

export function registration(cfg: Config) {
  return {
    kind: KIND, client: CLIENT, title: `${cfg.machine} 的 Telegram 橋接`, version: cfg.version, machine: cfg.machine,
    collections: [{ name: LIST, title: '這台機器帶的 Telegram bot（每隻 agent 一筆）', ttl_seconds: TTL_S }],
  }
}

const STATE_ZH: Record<string, string> = { ok: '收發中', conflict: '另一支橋接帶著', error: '有問題' }
/** one endpoint record (ticket item 5: the line says the bot account and its state) */
export function endpointRecord(a: { member: string; username: string; botId: string; state: string; holder: string | null; lastError: string | null; telegramConflict: boolean
  lastUpdateAt: number | null; stateDir: string; source: string; accepted: boolean; displayName: string | null; pendingWrites?: number; onsenFailingSince?: number | null }): Record<string, unknown> {
  const bot = a.username ? `@${a.username}` : `bot ${a.botId || '?'}`
  const why = a.state === 'conflict' ? (a.holder ? `由 ${a.holder} 帶` : '另一支橋接帶著') : a.state === 'error' ? (a.lastError ?? '') : a.telegramConflict ? 'Telegram 409：另一支程式在收這個 bot' : (a.pendingWrites ? `${a.pendingWrites} 則等 Onsen 收` : '')
  return {
    id: a.member,
    title: oneLine(`${a.displayName || a.member}（${bot}）`, LIMIT.title),
    line: oneLine([bot, a.member, STATE_ZH[a.state] ?? a.state, why].filter(Boolean).join('｜'), LIMIT.line),
    member: a.state === 'error' ? null : a.member,                 // Onsen 0.35.0: a conflict record claims nothing; an error one must not claim either
    state: a.state,
    attributes: {
      bot_id: a.botId || null, username: a.username || null, state_dir: a.stateDir.slice(0, LIMIT.attr), found_by: a.source.slice(0, LIMIT.attr),
      last_update_at: a.lastUpdateAt ? new Date(a.lastUpdateAt).toISOString() : null, error: a.lastError ? a.lastError.slice(0, LIMIT.attr) : null,
      telegram_conflict: a.telegramConflict, held_by: a.holder, writes_waiting: a.pendingWrites ?? 0,
      onsen_failing_since: a.onsenFailingSince ? new Date(a.onsenFailingSince).toISOString() : null,
    },
  }
}

/** the members a 409 endpoint_taken names (any of the shapes Onsen may use), among `ours`; and who holds them */
export function takenOf(json: any, ours: string[]): { members: string[]; holder: string | null } {
  const e = json?.error ?? json ?? {}
  const found = new Set<string>()
  const visit = (v: any, depth = 0): void => {
    if (depth > 3 || v == null) return
    if (typeof v === 'string') { if (ours.includes(v)) found.add(v); return }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return }
    if (typeof v === 'object') for (const k of ['member', 'members', 'taken', 'endpoint', 'endpoints', 'details', 'conflicts']) visit(v[k], depth + 1)
  }
  visit(e)
  const msg = String(e.message ?? '')
  for (const m of ours) if (new RegExp(`(^|[^a-z0-9-])${m.replace(/[-]/g, '\\-')}([^a-z0-9-]|$)`).test(msg)) found.add(m)
  const h = (Array.isArray(e.taken) ? e.taken[0]?.bridge ?? e.taken[0]?.by : null) ?? e.by ?? e.holder ?? e.bridge ?? e.extension
  return { members: [...found], holder: typeof h === 'string' ? h : null }
}

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export type BridgeDeps = { now?: () => number; fetch?: typeof fetch; log?: Log; pollerExtra?: Partial<PollerDeps> }

export class Bridge {
  readonly onsen: OnsenClient
  readonly state: StateStore
  readonly drawer: Drawer
  readonly two: StageTwo
  readonly agents = new Map<string, Agent>()
  readonly pollers = new Map<string, Poller>()
  private readonly unknownChatEndpoints = new Set<string>()
  /** client_meta left out until (an Onsen before 0.35.4 refuses it; shared by every poller) */
  readonly clientMeta = { offUntil: 0 }
  /** listed but not carried (no token, a token Telegram refuses, two daemons): member → why; shown as records with member null */
  readonly missing = new Map<string, { stateDir: string; source: string; why: string }>()
  private conflictAt = new Map<string, number>()
  settings: Settings = { list: new Set(), dirs: new Map(), errors: [] }
  known: Map<string, string> | null = null           // Onsen's members (name → display name); null: not read yet
  registered = false
  registeredAt = 0
  needRegister = true
  endpointsDirty = true
  endpointsAt = 0
  lastEndpoints = ''
  settingsAt = -Infinity
  membersAt = -Infinity
  approvalsAt = 0
  running = false
  private feedAc = new AbortController()
  private feedP: Promise<void> | null = null
  private quiet = new Map<string, number>()
  private logf: Log
  stats = { registered: 0, endpoints_put: 0, endpoint_conflicts: 0, feed_batches: 0, feed_items: 0, feed_errors: 0 }

  constructor(readonly cfg: Config, readonly deps: BridgeDeps = {}) {
    this.logf = deps.log ?? ((l, m) => console.log(`${new Date().toISOString()} ${l} ${m}`))
    this.onsen = new OnsenClient(cfg.base, cfg.credentialFile, cfg.onsenTimeoutMs, deps.fetch ?? fetch)
    mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
    this.state = new StateStore(cfg.stateDir, (l, m) => this.log(l as any, m))
    this.two = new StageTwo({ onsen: this.onsen, state: this.state, log: (l, m) => this.log(l, m), now: deps.now })
    this.drawer = new Drawer({ onsen: this.onsen, state: this.state, log: (l, m) => this.log(l, m), agentOf: m => this.agents.get(m) ?? null, useRich: cfg.useRich,
      now: deps.now, nameOf: m => this.known?.get(m) ?? m, retryDelaysMs: cfg.retryDelaysMs, extra: (a, item) => this.two.draw(a, item),
      threadOf: (m, c, t) => this.two.threadOf(m, c, t) })
  }
  now(): number { return (this.deps.now ?? Date.now)() }
  /** a log line; a warning with the same key at most once in 5 minutes */
  log(level: 'info' | 'warn' | 'error', msg: string, key?: string): void {
    if (key && level !== 'info') {
      const t = this.now()
      if ((this.quiet.get(key) ?? -Infinity) > t - 300_000) return
      this.quiet.set(key, t)
    }
    this.logf(level, msg)
  }

  // ---- which agents --------------------------------------------------------------------------------------------------------------
  /** what the settings and this machine say now (no network) */
  wanted(): Map<string, Found> {
    this.settings = readSettings(this.cfg.env, this.cfg.settingsFile)
    for (const e of this.settings.errors) this.log('warn', e, e)
    const d = discover(this.cfg.home, this.cfg.platform)
    for (const m of d.dupes) this.log('warn', `${m}: two installed daemons claim this member; not carried`, `dupe ${m}`)
    return carried(this.settings, d)
  }
  /** carry exactly the wanted agents: new ones get their token and getMe; gone ones stop within this call */
  async reconcile(): Promise<void> {
    this.settingsAt = this.now()
    const want = this.wanted()
    const before = JSON.stringify([...this.missing.entries()])
    this.missing.clear()
    for (const [m, a] of [...this.agents]) {
      const w = want.get(m)
      // off the list: carried on until its daemon takes the bot back (Telegram 409) or the hand-over time is up (tick); back on the list meanwhile: kept
      if (!w && !a.leaving) { a.leaving = { since: this.now() }; this.log('info', `${m}: off the list: still carried until its daemon polls @${a.username} (Telegram 409) or ${Math.round(this.cfg.handoverMs / 1000)} s`); continue }
      if (!w) continue
      if (a.leaving) { a.leaving = null; this.log('info', `${m}: back on the list during its hand-over: kept`) }
      if (w.stateDir !== a.stateDir || (this.known && !this.known.has(m))) await this.drop(m, w.stateDir !== a.stateDir ? 'its state dir changed' : 'Onsen does not know it')
    }
    for (const [m, w] of want) {
      if (this.known && !this.known.has(m)) { this.missing.set(m, { stateDir: w.stateDir, source: w.source, why: 'Onsen 沒有這個成員' }); continue }
      const tok = readToken(w.stateDir)
      const have = this.agents.get(m)
      if (!tok) {
        if (have) await this.drop(m, 'its .env has no token now')
        this.missing.set(m, { stateDir: w.stateDir, source: w.source, why: `${w.stateDir}/.env 沒有 TELEGRAM_BOT_TOKEN` })
        continue
      }
      if (have) {
        if (have.tokenMtime !== tok.mtime) {
          const was = have.botId
          have.setToken(tok)
          if (have.botId !== was) {
            this.log('info', `${m}: its .env has another bot now (${was} → ${have.botId}); polling that one`)
            have.username = ''; have.accepted = false; this.endpointsDirty = true
            await this.getMe(have)
            await this.restartPoller(m)
          }
        }
        if (!have.username) await this.getMe(have)
        continue
      }
      const a = new Agent(m, w.stateDir, w.source, tok, { bridgeDir: this.cfg.stateDir, tgOptions: { ...this.cfg.tg, fetch: this.deps.fetch }, log: (l, msg) => this.log(l, msg), now: this.deps.now,
        pinCheckMs: this.cfg.pinCheckMs, pinMinEditMs: this.cfg.pinMinEditMs })
      a.accepted = this.state.data.accepted.includes(m)
      a.displayName = this.known?.get(m) ?? null
      this.agents.set(m, a)
      this.endpointsDirty = true
      this.log('info', `${m}: carried from now on (state dir ${w.stateDir}, found by ${w.source}, bot ${a.botId})`)
      await this.getMe(a)
    }
    if (JSON.stringify([...this.missing.entries()]) !== before) this.endpointsDirty = true
    // Onsen not answering at start: the members it took from this bridge last time are polled meanwhile
    if (!this.registered) for (const a of this.agents.values()) if (a.accepted && a.username && a.state !== 'conflict') this.ensurePoller(a)
  }
  private async getMe(a: Agent): Promise<void> {
    try {
      const me = await a.tg.call('getMe', {}, { timeoutMs: 15_000 })
      a.username = String(me?.username ?? '')
      this.endpointsDirty = true
    } catch (e) {
      const refused = e instanceof TgError && (e.code === 401 || e.code === 404)
      a.lastError = refused ? 'Telegram 不認這個 token（getMe 401）' : `Telegram getMe 失敗：${errText(e)}`
      a.state = 'error'
      this.endpointsDirty = true
      this.log('warn', `${a.member}: getMe failed: ${errText(e)}${refused ? ' (the token is refused): not polled' : '; tried again at the next round'}`, `getme ${a.member}`)
    }
  }
  private async drop(m: string, why: string): Promise<void> {
    const a = this.agents.get(m)
    await this.pollers.get(m)?.stop()
    this.pollers.delete(m)
    a?.stop()
    this.agents.delete(m)
    this.endpointsDirty = true
    this.log('info', `${m}: not carried any more (${why}); its bot is no longer polled`)
  }
  private ensurePoller(a: Agent): void {
    if (this.pollers.get(a.member)?.running) return
    const p = new Poller(a, {
      unknownChatEndpoints: this.unknownChatEndpoints, agents: this.agents,
      onsen: this.onsen, state: this.state, log: (l, msg) => this.log(l, msg), now: this.deps.now, pollTimeoutS: this.cfg.pollTimeoutS,
      buttonKey: k => this.state.data.keys[k] ?? null, reRegister: () => { this.endpointsDirty = true; this.needRegister = true },
      onHandover: ag => { void this.drop(ag.member, 'its daemon polls the bot again (Telegram 409): handed over') },
      sorryMs: this.cfg.sorryMs, clientMeta: this.clientMeta, onButton: (ag, cq) => this.two.button(ag, cq),
      noteTopic: (m, c, t, n) => this.two.noteTopic(m, c, t, n), topicName: (m, c, t) => this.two.topicName(m, c, t), ...(this.deps.pollerExtra ?? {}),
    })
    this.pollers.set(a.member, p)
    p.start()
    this.log('info', `${a.member}: polling @${a.username}`)
  }
  private async restartPoller(m: string): Promise<void> {
    const p = this.pollers.get(m)
    if (!p) return
    await p.stop(); this.pollers.delete(m)
    const a = this.agents.get(m)
    if (a && a.state === 'ok') this.ensurePoller(a)
  }

  // ---- Onsen: register, endpoints, members -----------------------------------------------------------------------------------------
  async register(): Promise<boolean> {
    try {
      const r = await this.onsen.req('PUT', `/extensions/${this.cfg.name}`, registration(this.cfg))
      if (r.status === 200 || r.status === 201) {
        if (!this.registered || r.status === 201) this.log('info', `registered with Onsen as ${this.cfg.name}`)
        this.registered = true; this.registeredAt = this.now(); this.needRegister = false; this.stats.registered++
        return true
      }
      this.log('warn', `register: HTTP ${r.status || 'no credential in ' + this.cfg.credentialFile} ${errSaid(r)}`.trim(), `register ${r.status}`)
    } catch (e) { this.log('warn', `register: Onsen not reached (${errText(e)})`, 'register net') }
    return false
  }
  async refreshMembers(): Promise<void> {
    this.membersAt = this.now()
    const names = new Map<string, string>()
    let cursor: string | null = null
    try {
      for (let i = 0; i < 20; i++) {
        const r = await this.onsen.req('GET', `/members?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        if (r.status !== 200 || !Array.isArray(r.json?.items)) { this.log('warn', `members: HTTP ${r.status || 'no credential'}; the list of members stays as it was`, `members ${r.status}`); this.membersAt = this.now() - this.cfg.membersMs + 60_000; return }
        for (const m of r.json.items) if (typeof m?.name === 'string') names.set(m.name, typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name : m.name)
        cursor = r.json.next_cursor ?? null
        if (!cursor) break
      }
      this.known = names
      for (const a of this.agents.values()) a.displayName = names.get(a.member) ?? null
    } catch (e) { this.log('warn', `members: Onsen not reached (${errText(e)})`, 'members net'); this.membersAt = this.now() - this.cfg.membersMs + 60_000 }
  }
  records(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (const a of this.agents.values()) {
      const p = this.pollers.get(a.member)
      out.push(endpointRecord({ ...a, member: a.member, stateDir: a.stateDir, source: a.source, pendingWrites: p?.pendingWrites() ?? 0, onsenFailingSince: p?.failingSince ?? null }))
    }
    for (const [m, x] of this.missing) if (!this.agents.has(m)) out.push(endpointRecord({ member: m, username: '', botId: '', state: 'error', holder: null, lastError: x.why, telegramConflict: false,
      lastUpdateAt: null, stateDir: x.stateDir, source: x.source, accepted: false, displayName: this.known?.get(m) ?? null }))
    return out.sort((x, y) => String(x.id) < String(y.id) ? -1 : 1)
  }
  /** the list as it matters for a resend now (the time of the last update alone does not make one: the 30 s keep-alive carries it) */
  recordsKey(): string { return JSON.stringify(this.records().map((r: any) => ({ ...r, attributes: { ...r.attributes, last_update_at: null } }))) }
  private async putList(): Promise<{ status: number; json: any } | null> {
    try {
      this.stats.endpoints_put++
      return await this.onsen.req('PUT', `/extensions/${this.cfg.name}/collections/${LIST}`, { reported_at: new Date(this.now()).toISOString(), records: this.records() })
    } catch (e) { this.log('warn', `endpoints: Onsen not reached (${errText(e)})`, 'endpoints net'); return null }
  }
  /** send the endpoint list; settle each agent's state from Onsen's answer; start or stop the pollers to match */
  async syncEndpoints(): Promise<void> {
    const t = this.now()
    // who asks Onsen for its endpoint this time: every agent whose bot answered getMe, except another bridge's (asked again after a while)
    for (const a of this.agents.values()) {
      if (!a.username) { a.state = 'error'; continue }                            // getMe's lastError says why
      if (a.state === 'conflict') { if (t - (this.conflictAt.get(a.member) ?? 0) >= this.cfg.conflictRetryMs) { a.state = 'ok'; a.holder = null } else continue }
      a.state = 'ok'; a.lastError = null
    }
    let r = await this.putList()
    if (r && r.status === 404) { this.needRegister = true; if (await this.register()) r = await this.putList() }
    if (r && r.status === 409 && errCode(r) === 'endpoint_taken') {
      const asking = [...this.agents.values()].filter(a => a.state === 'ok').map(a => a.member)
      const tk = takenOf(r.json, asking)
      if (tk.members.length) { for (const m of tk.members) this.markConflict(m, tk.holder); r = await this.putList() }
      if (r && r.status === 409) r = await this.probe(asking)
    }
    if (r && (r.status === 200 || r.status === 201)) {
      this.endpointsAt = this.now(); this.endpointsDirty = false; this.lastEndpoints = this.recordsKey()
      for (const a of this.agents.values()) if (a.state === 'ok') a.accepted = true; else if (a.state === 'conflict') a.accepted = false
      this.state.data.accepted = [...this.agents.values()].filter(a => a.accepted).map(a => a.member); this.state.dirty()
    } else if (r) {
      this.log('warn', `endpoints: HTTP ${r.status || 'no credential in ' + this.cfg.credentialFile} ${errCode(r)} ${errSaid(r)}; the bots Onsen took before keep going, new ones wait`.trim(), `endpoints ${r.status}`)
    }
    for (const a of this.agents.values()) {
      const run = a.accepted && a.state === 'ok' && !!a.username
      if (run) this.ensurePoller(a)
      else if (this.pollers.has(a.member)) { await this.pollers.get(a.member)!.stop(); this.pollers.delete(a.member); this.log('info', `${a.member}: not polled (${a.state}${a.holder ? `, held by ${a.holder}` : ''})`) }
    }
  }
  private markConflict(m: string, holder: string | null): void {
    const a = this.agents.get(m)
    if (!a) return
    this.stats.endpoint_conflicts++
    if (a.state !== 'conflict') this.log('warn', `${m}: Onsen says another bridge carries it (409 endpoint_taken${holder ? `, ${holder}` : ''}): its bot is not polled here; asked again in ${Math.round(this.cfg.conflictRetryMs / 1000)} s`)
    a.state = 'conflict'; a.holder = holder; a.accepted = false; a.lastError = null
    this.conflictAt.set(m, this.now())
  }
  /** a 409 that names no member: ask for the members one at a time (the ones taken before first) */
  private async probe(asking: string[]): Promise<{ status: number; json: any } | null> {
    const order = [...asking].sort((x, y) => Number(this.agents.get(y)?.accepted) - Number(this.agents.get(x)?.accepted))
    for (const m of order) { const a = this.agents.get(m); if (a) { a.state = 'error'; a.lastError = '等 Onsen 一個一個確認' } }
    let last: { status: number; json: any } | null = null
    for (const m of order) {
      const a = this.agents.get(m)
      if (!a) continue
      a.state = 'ok'; a.lastError = null
      last = await this.putList()
      if (!last) { a.state = 'error'; a.lastError = 'Onsen 沒回應'; return null }
      if (last.status === 409) { const tk = takenOf(last.json, [m]); this.markConflict(m, tk.holder); continue }
      if (last.status !== 200 && last.status !== 201) return last
    }
    return last ? await this.putList() : last
  }

  // ---- the rounds ------------------------------------------------------------------------------------------------------------------
  /** one round (every second): settings, register, members, endpoints, approvals, the drawer's retries */
  async tick(): Promise<void> {
    const t = this.now()
    if (t - this.settingsAt >= this.cfg.settingsMs) await this.reconcile()
    if (this.needRegister || t - this.registeredAt >= this.cfg.registerMs) {
      if (!(await this.register()) && !this.registered) return
    }
    if (t - this.membersAt >= this.cfg.membersMs) {
      const had = this.known
      await this.refreshMembers()
      if (!had && this.known) await this.reconcile()
    }
    const now = this.recordsKey()
    for (const a of [...this.agents.values()]) if (a.leaving && t - a.leaving.since >= this.cfg.handoverMs) await this.drop(a.member, `off the list and no Telegram 409 in ${Math.round(this.cfg.handoverMs / 1000)} s: let go`)
    const conflictDue = [...this.agents.values()].some(a => a.state === 'conflict' && t - (this.conflictAt.get(a.member) ?? 0) >= this.cfg.conflictRetryMs)
    if (this.endpointsDirty || conflictDue || now !== this.lastEndpoints || t - this.endpointsAt >= this.cfg.endpointsMs) await this.syncEndpoints()
    if (t - this.approvalsAt >= 5_000) { this.approvalsAt = t; for (const p of this.pollers.values()) if (p.running) await p.approvals() }
    await this.drawer.tick()
  }

  /** the feed: GET /v1/bridge/feed?after=&wait=&limit=100, drawn in order per chat; the cursor kept after each batch */
  async feedLoop(): Promise<void> {
    let backoff = 0
    while (this.running) {
      if (!this.registered) { await this.sleep(500, this.feedAc.signal); continue }
      const f = this.state.data.feed
      let r: { status: number; json: any }
      try {
        r = await this.onsen.req('GET', `/bridge/feed?${f.after ? `after=${encodeURIComponent(f.after)}&` : ''}wait=${this.cfg.feedWaitS}&limit=100`, undefined,
          { timeoutMs: (this.cfg.feedWaitS + 20) * 1000, signal: this.feedAc.signal })
      } catch (e) {
        if (!this.running) break
        this.stats.feed_errors++
        this.log('warn', `feed: Onsen not reached (${errText(e)})`, 'feed net')
        backoff = Math.min(30_000, Math.max(1_000, backoff * 2)); await this.sleep(backoff, this.feedAc.signal); continue
      }
      if (r.status !== 200) {
        this.stats.feed_errors++
        if (r.status === 404 && errCode(r) !== 'not_found') this.needRegister = true
        this.log('warn', `feed: HTTP ${r.status || 'no credential'} ${errCode(r)} ${errSaid(r)}`.trim(), `feed ${r.status}`)
        backoff = Math.min(30_000, Math.max(1_000, backoff * 2)); await this.sleep(backoff, this.feedAc.signal); continue
      }
      backoff = 0
      const items: any[] = Array.isArray(r.json?.items) ? r.json.items : Array.isArray(r.json?.data?.items) ? r.json.data.items : []
      const next: string | null = r.json?.next ?? r.json?.data?.next ?? null
      this.stats.feed_batches++
      await this.drawBatch(items)
      this.state.data.feed = { after: next ?? f.after, drawn: [] }
      this.state.flush()
    }
  }
  async drawBatch(items: any[]): Promise<void> {
    const done = new Set(this.state.data.feed.drawn)
    const todo = Drawer.coalesce(items.filter(it => !done.has(String(it?.seq))))
    this.stats.feed_items += todo.length
    await Promise.all(todo.map(it => this.drawer.enqueue(it).then(() => { this.state.data.feed.drawn.push(String(it.seq)); this.state.dirty() })))
  }
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(res => { if (signal.aborted) return res(); const t = setTimeout(res, ms); signal.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true }) })
  }

  async start(): Promise<void> {
    this.running = true
    this.feedAc = new AbortController()
    this.feedP = this.feedLoop().catch(e => this.log('error', `feed loop ended: ${errText(e)}`))
  }
  async stop(): Promise<void> {
    this.running = false
    this.feedAc.abort()
    await this.feedP
    await Promise.all([...this.pollers.values()].map(p => p.stop()))
    for (const a of this.agents.values()) a.stop()
    this.state.flush()
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let cfg: Config
  try { cfg = configFromEnv() } catch (e) { console.error((e as Error).message); process.exit(2) }
  const b = new Bridge(cfg)
  if (argv.includes('--whoami')) {
    const r = await b.onsen.req('GET', '/me').catch(e => ({ status: -1, json: { error: { message: (e as Error).message } } }))
    console.log(r.status === 200 ? `${r.json.data.name} (${r.json.data.kind})` : `HTTP ${r.status || 'no credential in ' + cfg.credentialFile}: ${r.json?.error?.message ?? ''}`)
    process.exit(r.status === 200 && r.json.data.name === cfg.name ? 0 : 1)
  }
  if (argv.includes('--once')) {                  // what it would carry now; no bot is polled, nothing is written (no token printed)
    const want = b.wanted()
    const rows = [...want.values()].map(w => ({ member: w.member, state_dir: w.stateDir, found_by: w.source, token: readToken(w.stateDir) ? 'present' : 'missing' }))
    console.log(JSON.stringify({ extension: cfg.name, settings: cfg.settingsFile, list: b.settings.list === '*' ? '*' : [...b.settings.list], map: Object.fromEntries(b.settings.dirs),
      register: registration(cfg), carried: rows }, null, 2))
    process.exit(0)
  }
  let stopping = false
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => { stopping = true })
  b.log('info', `telegram-bridge up: ${cfg.name} (machine ${cfg.machine}, version ${cfg.version}) → ${cfg.base}; settings ${cfg.settingsFile} every ${cfg.settingsMs / 1000} s; state ${cfg.stateDir}`)
  if (!b.onsen.token()) b.log('warn', `no mesh credential in ${cfg.credentialFile}: nothing is sent until it is there (read again every round)`)
  await b.start()
  while (!stopping) {
    const t0 = Date.now()
    try { await b.tick() } catch (e) { b.log('error', `round failed: ${errText(e)}`, 'tick error') }
    const wait = Math.max(100, 1000 - (Date.now() - t0))
    for (let w = 0; w < wait && !stopping; w += 100) await Bun.sleep(Math.min(100, wait - w))
  }
  b.log('info', `telegram-bridge stopping (${JSON.stringify(b.stats)}); confirming to Telegram what was done`)
  await b.stop()
  process.exit(0)
}

if (import.meta.main) void main()
