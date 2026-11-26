// claude-code-host.ts: the claude-code-host extension of Onsen (board WO-183; Chiron's design in the ticket's comment of 11-26 07:41:48Z,
// section 二; CONTRACT §7b 「外掛（Extension）」). Joey (TG chiron:2642, 07:16Z) asked that finding which AI sessions run on each machine be a
// plug-in or sub-program of Onsen, not part of its main system. Onsen's main system knows no runtime; this program is the part that knows
// Claude Code and tmux. One per machine (Mac mini, MBP, txmonster); it needs no bot and no agent's daemon.
//
//   find      session-finder.ts listSessions: every entry of `claude agents --json` (no folder filtered), with the tmux session it runs in
//   member    the nearest folder at or above the session's cwd with a .cc-agent.json or a .lanes/main-settings.json: its manifest's
//             `mesh_id`, else the `--agent <id>` its claude_command passes to lanes-launch, else LANES_AGENT in that workspace's
//             .lanes/main-settings.json (written by lanes-launch). A lane runs in its owner's workspace, so it counts as the owner's.
//             None: null.
//   client    telegram: one of this machine's Telegram daemons has the session as its main (/healthz main_session, main_phase not gone,
//             an open SSE stream), or a live Telegram roamer claims it (~/.claude/channels/roamer-registry.json). Otherwise none;
//             onsen is reserved for sessions that talk to Onsen directly. The daemons: the telegram ports of the manifests
//             (~/cc-workspaces/*/, ~/.claude/workspace-*/), of the launchd plists (macOS) or systemd user units (Linux) that set
//             TELEGRAM_HTTP_PORT, of ~/.claude/channels/roamer-daemons.json, and CLAUDE_CODE_HOST_DAEMON_PORTS.
//   names     the members' display names from Onsen GET /v1/members with this extension's own credential, every 5 minutes; until then,
//             or for a member Onsen does not list, the mesh id
//   report    PUT /v1/extensions/<name> (register and heartbeat) at start, every 5 minutes, and again when Onsen no longer knows it;
//             PUT /v1/extensions/<name>/collections/sessions with the whole list: at once when it changed (looked at every 5 s), and
//             every 15 s otherwise. ttl_seconds 45. Onsen not answering: that report is dropped and the next one carries the list as
//             it is then (no queue, no resend of an old list); repeated failures back off up to 60 s.
//
// Read-only: the only commands are the listings session-finder.ts allows (`claude agents --json`, `tmux list-panes`, `ps -o pid=,ppid=
// -A`); everything else it reads is files and the daemons' /healthz. It never sends a key, never starts, stops, signals or restarts
// anything. The credential goes only to Onsen and is never logged.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type FinderOptions, type FoundSession, listSessions, processParents } from '../session-finder.ts'

export const KIND = 'host'
export const LIST = 'sessions'
export const TTL_S = 45
export type Client = 'telegram' | 'onsen' | 'none'
export const CLIENT_ZH: Record<Client, string> = { telegram: '接 Telegram', onsen: '接 Onsen', none: '沒有接' }
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NOT_ONE_LINE = /[\u0000-\u001f\u007f\u2028\u2029]/g
// Onsen's limits for a record (app/onsen_extensions.py): a field past them would make Onsen refuse the whole list
const LIMIT = { title: 200, line: 500, state: 40, attr: 2000 }

export type Config = {
  machine: string
  name: string
  base: string                 // Onsen's v1 root, e.g. https://core.kbro.ai/api/onsen/v1
  credentialFile: string
  home: string
  platform: string
  scanMs: number
  reportMs: number
  membersMs: number
  registerMs: number
  healthTimeoutMs: number
  requestTimeoutMs: number
  extraPorts: number[]
  finder: FinderOptions
  version: string
}

function pluginVersion(): string {
  try { return String(JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version || '') || 'unknown' } catch { return 'unknown' }
}

function num(v: string | undefined, d: number, min: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= min ? n : d
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || homedir()
  const machine = (env.CLAUDE_CODE_HOST_MACHINE ?? '').trim()
  if (!ID_RE.test(machine)) throw new Error('CLAUDE_CODE_HOST_MACHINE is required: the machine name Onsen uses (macmini, mbp, txmonster)')
  const name = (env.CLAUDE_CODE_HOST_NAME ?? '').trim() || `claude-code-host-${machine}`
  if (!ID_RE.test(name) || name.length > 48) throw new Error(`extension name ${name}: lowercase letters, digits and -, at most 48 (a mesh identity's name)`)
  const base = ((env.ONSEN_BASE ?? '').trim() || 'https://core.kbro.ai/api/onsen').replace(/\/+$/, '') + '/v1'
  const socket = (env.CLAUDE_CODE_HOST_TMUX_SOCKET ?? '').trim()
  return {
    machine, name, base, home, platform: env.CLAUDE_CODE_HOST_PLATFORM || process.platform,
    credentialFile: (env.CLAUDE_CODE_HOST_CREDENTIAL_FILE ?? '').trim() || join(home, '.config/mesh', `${name}.credential`),
    scanMs: num(env.CLAUDE_CODE_HOST_SCAN_S, 5, 1) * 1000,
    reportMs: num(env.CLAUDE_CODE_HOST_REPORT_S, 15, 1) * 1000,
    membersMs: num(env.CLAUDE_CODE_HOST_MEMBERS_S, 300, 10) * 1000,
    registerMs: num(env.CLAUDE_CODE_HOST_REGISTER_S, 300, 10) * 1000,
    healthTimeoutMs: num(env.CLAUDE_CODE_HOST_HEALTH_TIMEOUT_MS, 1500, 100),
    requestTimeoutMs: num(env.CLAUDE_CODE_HOST_REQUEST_TIMEOUT_MS, 8000, 500),
    extraPorts: (env.CLAUDE_CODE_HOST_DAEMON_PORTS ?? '').split(',').map(x => parseInt(x.trim(), 10)).filter(p => p > 0 && p < 65536),
    finder: { claudeBin: (env.CLAUDE_BIN ?? '').trim() || 'claude', ...(socket ? { tmuxArgs: ['-S', socket] } : {}) },
    version: pluginVersion(),
  }
}

// ---- reading files ----------------------------------------------------------------------------------------------------------------

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function listDir(p: string): string[] {
  try { return readdirSync(p) } catch { return [] }
}

function lanesAgent(dir: string): string | null {
  const a = readJson(join(dir, '.lanes', 'main-settings.json'))?.env?.LANES_AGENT
  return typeof a === 'string' && ID_RE.test(a) ? a : null
}

/** the member a manifest names: its mesh_id, else lanes-launch's --agent in its claude_command, else its workspace's LANES_AGENT */
export function manifestMember(m: any, dir: string): string | null {
  if (typeof m?.mesh_id === 'string' && ID_RE.test(m.mesh_id)) return m.mesh_id
  const a = /--agent[= ]+([a-z0-9][a-z0-9-]{0,63})/.exec(typeof m?.claude_command === 'string' ? m.claude_command : '')
  if (a) return a[1]
  return lanesAgent(typeof m?.workspace_dir === 'string' && m.workspace_dir ? m.workspace_dir : dir) ?? (m?.workspace_dir ? lanesAgent(dir) : null)
}

/** the member a session's cwd belongs to (see the header); cache: one Map per scan */
export function memberOf(cwd: string | null | undefined, cache: Map<string, string | null> = new Map()): string | null {
  if (!cwd) return null
  let dir = resolve(cwd)
  const seen: string[] = []
  for (let i = 0; i < 16; i++) {
    if (cache.has(dir)) { const v = cache.get(dir)!; for (const s of seen) cache.set(s, v); return v }
    seen.push(dir)
    let found: string | null | undefined
    if (existsSync(join(dir, '.cc-agent.json'))) found = manifestMember(readJson(join(dir, '.cc-agent.json')), dir)
    else if (existsSync(join(dir, '.lanes', 'main-settings.json'))) found = lanesAgent(dir)
    if (found !== undefined) { for (const s of seen) cache.set(s, found); return found }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const s of seen) cache.set(s, null)
  return null
}

// ---- this machine's Telegram daemons ----------------------------------------------------------------------------------------------

function manifestPaths(home: string): string[] {
  const out: string[] = []
  const roots = [join(home, 'cc-workspaces'), ...listDir(join(home, '.claude')).filter(n => n.startsWith('workspace-')).map(n => join(home, '.claude', n))]
  for (const r of roots) {
    const dirs = r.endsWith('cc-workspaces') ? listDir(r).map(n => join(r, n)) : [r]
    for (const d of dirs) for (const f of listDir(d)) if (f === '.cc-agent.json' || /^\.cc-agent-.+\.json$/.test(f)) out.push(join(d, f))
  }
  return out
}

/** the ports of this machine's Telegram daemons (see the header), ascending */
export function daemonPorts(home: string, platform: string, extra: number[] = []): number[] {
  const ports = new Set<number>(extra)
  const add = (v: unknown) => { const p = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10); if (p > 0 && p < 65536) ports.add(p) }
  for (const f of manifestPaths(home)) add(readJson(f)?.channels?.telegram?.http_port)
  if (platform === 'darwin') {
    const dir = join(home, 'Library', 'LaunchAgents')
    for (const f of listDir(dir).filter(n => n.endsWith('.plist'))) {
      let t = ''
      try { t = readFileSync(join(dir, f), 'utf8') } catch { continue }
      const m = /<key>TELEGRAM_HTTP_PORT<\/key>\s*<string>\s*(\d+)\s*<\/string>/.exec(t)
      if (m) add(m[1])
    }
  } else {
    const dir = join(home, '.config', 'systemd', 'user')
    const files = listDir(dir).filter(n => n.endsWith('.service')).map(n => join(dir, n))
    for (const d of listDir(dir).filter(n => n.endsWith('.service.d'))) files.push(...listDir(join(dir, d)).filter(n => n.endsWith('.conf')).map(n => join(dir, d, n)))
    for (const f of files) {
      let t = ''
      try { t = readFileSync(f, 'utf8') } catch { continue }
      for (const m of t.matchAll(/TELEGRAM_HTTP_PORT=(\d+)/g)) add(m[1])
    }
  }
  const roamers = readJson(join(home, '.claude', 'channels', 'roamer-daemons.json'))
  if (roamers && typeof roamers === 'object') for (const v of Object.values(roamers) as any[]) if (!v?.protocol || v.protocol === 'telegram') add(v?.port)
  return [...ports].sort((a, b) => a - b)
}

export type Health = { port: number; main_session?: unknown; main_phase?: unknown; sessions_with_open_sse?: unknown }

/** GET /healthz of each port at once (127.0.0.1, no credential); a daemon that does not answer in time is left out */
export async function probeDaemons(ports: number[], timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<Health[]> {
  const one = async (port: number): Promise<Health | null> => {
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) return null
      const j = await r.json() as any
      return j && typeof j === 'object' ? { port, main_session: j.main_session, main_phase: j.main_phase, sessions_with_open_sse: j.sessions_with_open_sse } : null
    } catch { return null }
  }
  return (await Promise.all(ports.map(one))).filter((h): h is Health => h !== null)
}

/** the session ids a Telegram daemon serves now: a daemon's main (not gone, with an open SSE stream), or a live Telegram roamer's claim */
export function telegramSessions(healths: Health[], roamerRegistry: any, alive: (pid: number) => boolean): Set<string> {
  const out = new Set<string>()
  for (const h of healths) {
    if (typeof h.main_session === 'string' && h.main_session && h.main_phase !== 'gone' && Number(h.sessions_with_open_sse ?? 0) >= 1) out.add(h.main_session)
  }
  if (roamerRegistry && typeof roamerRegistry === 'object') {
    for (const e of Object.values(roamerRegistry) as any[]) {
      if (!e || typeof e.session_id !== 'string' || (e.protocol && e.protocol !== 'telegram')) continue
      if (alive(Number(e.daemon_pid)) && alive(Number(e.claude_pid))) out.add(e.session_id)
    }
  }
  return out
}

// ---- the records ------------------------------------------------------------------------------------------------------------------

export type ExtRecord = { id: string; title: string; line: string; member: string | null; state: string | null; attributes: Record<string, string | number | boolean | null> }

const TPE_OFFSET_MS = 8 * 3600 * 1000

/** CONTRACT §1: MM-DD HH:MM 台北 (another year than now's: YYYY-MM-DD HH:MM 台北) */
export function tpe(ms: number, nowMs: number): string {
  const d = new Date(ms + TPE_OFFSET_MS)
  const p = (n: number) => String(n).padStart(2, '0')
  const md = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  return (d.getUTCFullYear() !== new Date(nowMs + TPE_OFFSET_MS).getUTCFullYear() ? `${d.getUTCFullYear()}-` : '') + md + ' 台北'
}

function oneLine(s: string, most: number): string {
  const t = s.replace(NOT_ONE_LINE, ' ')
  return t.length > most ? t.slice(0, most - 1) + '…' : t
}

export function folderOf(cwd: string | null | undefined): string {
  if (!cwd) return '不明'
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

/** one record (Chiron's section 二): id the session id; member; state Claude Code's status; title the member's display name, else the
 *  folder; line {成員|未登記}｜{tmux|無 tmux}｜{folder}｜{接 Telegram|接 Onsen|沒有接}｜{state}｜起於 {time}; attributes the six keys */
export function buildRecord(s: FoundSession, member: string | null, displayName: string | null, client: Client, nowMs: number): ExtRecord {
  const folder = folderOf(s.cwd)
  const who = member ? (displayName || member) : null
  const started = typeof s.startedAt === 'number' && Number.isFinite(s.startedAt) && s.startedAt > 0 ? s.startedAt : null
  const state = typeof s.status === 'string' && s.status.trim() ? oneLine(s.status, LIMIT.state) : null
  const pid = Number.isInteger(s.pid) && (s.pid as number) > 0 ? (s.pid as number) : null
  return {
    id: s.sessionId,
    title: oneLine(who ?? folder, LIMIT.title),
    line: oneLine([who ?? '未登記', s.tmux ?? '無 tmux', folder, CLIENT_ZH[client], state ?? '狀態不明', `起於 ${started ? tpe(started, nowMs) : '不明'}`].join('｜'), LIMIT.line),
    member,
    state,
    attributes: {
      session_id: s.sessionId,
      cwd: s.cwd ? String(s.cwd).slice(0, LIMIT.attr) : null,
      tmux: s.tmux ? s.tmux.slice(0, LIMIT.attr) : null,
      pid,
      started_at: started ? new Date(started).toISOString() : null,
      client,
    },
  }
}

/** every record, in a fixed order (the session's start, then its id) so an unchanged machine sends an unchanged list */
export function buildRecords(sessions: FoundSession[], tg: Set<string>, names: Map<string, string>, nowMs: number): ExtRecord[] {
  const cache = new Map<string, string | null>()
  const sorted = [...sessions].sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
  const seen = new Set<string>()
  const out: ExtRecord[] = []
  for (const s of sorted) {
    if (seen.has(s.sessionId)) continue                 // Onsen refuses a list with an id twice
    seen.add(s.sessionId)
    const member = memberOf(s.cwd, cache)
    out.push(buildRecord(s, member, member ? names.get(member) ?? null : null, tg.has(s.sessionId) ? 'telegram' : 'none', nowMs))
  }
  return out
}

// ---- Onsen, with this extension's credential -------------------------------------------------------------------------------------

export class Onsen {
  private tok: { mtime: number; value: string | null } = { mtime: -1, value: null }
  constructor(readonly base: string, readonly credentialFile: string, readonly timeoutMs: number, readonly fetchImpl: typeof fetch = fetch) {}
  /** the credential, read again when the file changes; null when missing or not a mesh credential. Never logged. */
  token(): string | null {
    try {
      const m = statSync(this.credentialFile).mtimeMs
      if (m !== this.tok.mtime) { const v = readFileSync(this.credentialFile, 'utf8').trim(); this.tok = { mtime: m, value: v.startsWith('mesh_') ? v : null } }
    } catch { this.tok = { mtime: -1, value: null } }
    return this.tok.value
  }
  /** one JSON request; status 0 = no credential; throws on a network error or the timeout */
  async req(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const t = this.token()
    if (!t) return { status: 0, json: null }
    const r = await this.fetchImpl(this.base + path, {
      method, signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Authorization: `Bearer ${t}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'User-Agent': 'claude-code-host/1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
}

export function registration(cfg: Config) {
  return {
    kind: KIND, title: `${cfg.machine} 上的 Claude Code 對話`, version: cfg.version, machine: cfg.machine,
    collections: [{ name: LIST, title: '這台機器上的 Claude Code 對話（tmux、成員、接哪一種客戶端）', ttl_seconds: TTL_S }],
  }
}

// ---- the loop ---------------------------------------------------------------------------------------------------------------------

export type HostDeps = {
  now?: () => number
  fetch?: typeof fetch            // Onsen and the daemons' /healthz
  log?: (level: string, msg: string) => void
  list?: (o: FinderOptions) => Promise<FoundSession[] | null>
  alive?: () => Promise<(pid: number) => boolean>   // which pids are running (default: one `ps`)
}

export class Host {
  readonly onsen: Onsen
  private now: () => number
  private fetchImpl: typeof fetch
  private logf: (level: string, msg: string) => void
  private list: (o: FinderOptions) => Promise<FoundSession[] | null>
  private aliveOf: () => Promise<(pid: number) => boolean>
  registeredAt = 0
  needRegister = true
  lastSent = ''                   // the records of the last list Onsen took
  lastTry = 0                     // the last time a list was sent (taken or not)
  heardAt = 0                     // the last time Onsen answered a write
  failures = 0
  names = new Map<string, string>()
  namesAt = 0
  private quiet = new Map<string, number>()
  stats = { scans: 0, sent: 0, taken: 0, dropped: 0, unchanged: 0, registered: 0, listFailed: 0 }

  constructor(readonly cfg: Config, deps: HostDeps = {}) {
    this.now = deps.now ?? Date.now
    this.fetchImpl = deps.fetch ?? fetch
    this.logf = deps.log ?? ((l, m) => console.log(`${new Date().toISOString()} ${l} ${m}`))
    this.list = deps.list ?? listSessions
    this.aliveOf = deps.alive ?? (async () => {
      const table = await processParents(this.cfg.finder)
      return (pid: number) => table.has(pid)
    })
    this.onsen = new Onsen(cfg.base, cfg.credentialFile, cfg.requestTimeoutMs, this.fetchImpl)
  }

  /** a log line; the same message at most once in 5 minutes */
  log(level: string, msg: string, key = msg): void {
    const t = this.now()
    if (level !== 'info' && (this.quiet.get(key) ?? -Infinity) > t - 300_000) return
    if (level !== 'info') this.quiet.set(key, t)
    this.logf(level, msg)
  }

  private backoffMs(): number {
    return this.failures ? Math.min(60_000, this.cfg.scanMs * 2 ** Math.min(this.failures - 1, 6)) : 0
  }

  async register(): Promise<boolean> {
    try {
      const r = await this.onsen.req('PUT', `/extensions/${this.cfg.name}`, registration(this.cfg))
      if (r.status === 200 || r.status === 201) {
        this.registeredAt = this.now(); this.needRegister = false; this.heardAt = this.now(); this.failures = 0; this.stats.registered++
        if (r.status === 201) this.log('info', `registered with Onsen as ${this.cfg.name}`)
        return true
      }
      this.failures++
      this.log('warn', `register: HTTP ${r.status || 'no credential in ' + this.cfg.credentialFile} ${r.json?.error?.message ?? ''}`.trim(), `register ${r.status}`)
    } catch (e) {
      this.failures++
      this.log('warn', `register: Onsen not reached (${(e as Error).name})`, 'register net')
    }
    return false
  }

  async refreshNames(): Promise<void> {
    const names = new Map<string, string>()
    let cursor: string | null = null
    try {
      for (let i = 0; i < 20; i++) {
        const r = await this.onsen.req('GET', `/members?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        if (r.status !== 200 || !Array.isArray(r.json?.items)) {
          this.log('warn', `members: HTTP ${r.status || 'no credential'}; names stay as they were (mesh ids until the first read)`, `members ${r.status}`)
          this.namesAt = this.now() - this.cfg.membersMs + 60_000          // tried again in a minute
          return
        }
        for (const m of r.json.items) if (typeof m?.name === 'string' && typeof m?.display_name === 'string' && m.display_name.trim()) names.set(m.name, m.display_name)
        cursor = r.json.next_cursor ?? null
        if (!cursor) break
      }
      this.names = names
      this.namesAt = this.now()
    } catch (e) {
      this.log('warn', `members: Onsen not reached (${(e as Error).name}); names stay as they were`, 'members net')
      this.namesAt = this.now() - this.cfg.membersMs + 60_000
    }
  }

  /** what this machine looks like now: the records, or null when `claude agents` failed */
  async scan(): Promise<ExtRecord[] | null> {
    const sessions = await this.list(this.cfg.finder)
    if (!sessions) return null
    const ports = daemonPorts(this.cfg.home, this.cfg.platform, this.cfg.extraPorts)
    const healths = await probeDaemons(ports, this.cfg.healthTimeoutMs, this.fetchImpl)
    const roamers = readJson(join(this.cfg.home, '.claude', 'channels', 'roamer-registry.json'))
    const alive = roamers && typeof roamers === 'object' && Object.keys(roamers).length ? await this.aliveOf() : () => false
    return buildRecords(sessions, telegramSessions(healths, roamers, alive), this.names, this.now())
  }

  /** one round: register when due, look, send the list when it changed or the keep-alive is due */
  async tick(): Promise<void> {
    this.stats.scans++
    const t = this.now()
    if (this.failures && t - this.lastTry < this.backoffMs()) return
    if (this.needRegister || t - this.registeredAt >= this.cfg.registerMs) {
      if (!(await this.register())) { this.lastTry = t; return }
    }
    if (t - this.namesAt >= this.cfg.membersMs) await this.refreshNames()
    const records = await this.scan()
    if (!records) {
      this.stats.listFailed++
      this.log('warn', '`claude agents --json` failed: no list this round (Onsen keeps the last one until it expires)', 'agents failed')
      if (t - this.heardAt >= this.cfg.reportMs) await this.register()      // the heartbeat still goes: the extension is alive, its list is not
      return
    }
    const key = JSON.stringify(records)
    if (key === this.lastSent && t - this.lastTry < this.cfg.reportMs) { this.stats.unchanged++; return }
    this.lastTry = t
    this.stats.sent++
    try {
      const r = await this.onsen.req('PUT', `/extensions/${this.cfg.name}/collections/${LIST}`, { reported_at: new Date(this.now()).toISOString(), records })
      if (r.status === 200) {
        this.lastSent = key; this.heardAt = this.now(); this.failures = 0; this.stats.taken++
        return
      }
      this.stats.dropped++
      if (r.status === 404) this.needRegister = true                  // Onsen no longer knows it (or the collection): register again next round
      if (r.status >= 500 || r.status === 429) this.failures++
      this.log('warn', `sessions list: HTTP ${r.status || 'no credential in ' + this.cfg.credentialFile} ${r.json?.error?.message ?? ''}; dropped`.trim(), `list ${r.status}`)
    } catch (e) {
      this.stats.dropped++
      this.failures++
      this.log('warn', `sessions list: Onsen not reached (${(e as Error).name}); dropped, the next one carries the list as it is then`, 'list net')
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let cfg: Config
  try { cfg = configFromEnv() } catch (e) { console.error((e as Error).message); process.exit(2) }
  const host = new Host(cfg)
  if (argv.includes('--whoami')) {
    const r = await host.onsen.req('GET', '/me').catch(e => ({ status: -1, json: { error: { message: (e as Error).message } } }))
    console.log(r.status === 200 ? `${r.json.data.name} (${r.json.data.kind})` : `HTTP ${r.status || 'no credential in ' + cfg.credentialFile}: ${r.json?.error?.message ?? ''}`)
    process.exit(r.status === 200 && r.json.data.name === cfg.name ? 0 : 1)
  }
  if (argv.includes('--once')) {                        // what it would send now; writes nothing (reads the members if the credential is there)
    if (host.onsen.token()) await host.refreshNames()
    const records = await host.scan()
    console.log(JSON.stringify({ extension: cfg.name, register: registration(cfg), list: records === null ? null : { reported_at: new Date().toISOString(), records } }, null, 2))
    process.exit(records === null ? 1 : 0)
  }
  let stopping = false
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => { stopping = true })
  host.log('info', `claude-code-host up: ${cfg.name} (machine ${cfg.machine}, version ${cfg.version}) → ${cfg.base}; scan ${cfg.scanMs / 1000} s, keep-alive ${cfg.reportMs / 1000} s, ttl ${TTL_S} s`)
  if (!host.onsen.token()) host.log('warn', `no mesh credential in ${cfg.credentialFile}: nothing is sent until it is there (read again every round)`, 'no cred')
  while (!stopping) {
    const t0 = Date.now()
    try { await host.tick() } catch (e) { host.log('error', `round failed: ${(e as Error).message}`, 'tick error') }
    const wait = Math.max(200, cfg.scanMs - (Date.now() - t0))
    for (let w = 0; w < wait && !stopping; w += 200) await Bun.sleep(Math.min(200, wait - w))
  }
  host.log('info', `claude-code-host stopping (${JSON.stringify(host.stats)}); Onsen marks the list stale ${TTL_S} s after the last one`)
  process.exit(0)
}

if (import.meta.main) void main()
