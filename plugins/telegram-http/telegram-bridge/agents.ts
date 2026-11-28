// agents.ts: which agents' bots this machine's telegram-bridge carries, and where each one's .telegram-state is (WO-196 part B, ticket item 1:
// 「這台機器上、名字在 ONSEN_BRIDGE 名單裡的 agent（機器設定，每 30 秒重讀）；金鑰讀各 workspace 原地的 .telegram-state/.env，不搬、不複製、不印」).
//
//   the list   ONSEN_BRIDGE in the machine settings file (~/.config/crab-labs-plugins/env, CRAB_LABS_PLUGINS_ENV overrides the path; the same
//              line Sonn's connectors read, WO-197): a comma list of member names, or `*` (every agent found on this machine); unset, empty,
//              0 / off = none. Read again every 30 s. The bridge's own environment, when it sets ONSEN_BRIDGE, wins over the file.
//   the map    ONSEN_BRIDGE_STATE_DIRS in the same file (env wins the same way): member=/abs/state/dir pairs, comma-separated. Used before
//              discovery: a member mapped here takes that directory (e.g. codex, which has no daemon of its own, on a lab bot's state dir).
//              A mapped member is still carried only when ONSEN_BRIDGE names it or is `*`.
//   discovery  "on this machine" = the agent's Telegram daemon is installed here: a launchd plist (~/Library/LaunchAgents/*.plist, macOS) or a
//              systemd user unit with its drop-ins (~/.config/systemd/user/*.service, *.service.d/*.conf, Linux) that sets TELEGRAM_STATE_DIR
//              and not CHANNEL_INBOX_ONLY=1. Its member is the name the daemon itself reports to Onsen (onsen-client.ts agentName: LANES_AGENT,
//              else AGENT_INBOX_SELF, else AGENT_WORKSPACE_DIR's (else the state dir's parent's) claude-<name>). Two units giving one member: neither
//              is carried (one log line). A manifest whose daemon moved to another machine stays behind with no unit here: not this machine's.
//   the token  TELEGRAM_BOT_TOKEN in <state dir>/.env, read in place (the daemon's parse, server.ts 125-131), kept in memory only; never
//              copied, written or logged.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { agentName, isRoamerEnv, roamerMember } from '../onsen-client.ts'

export const MEMBER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** fleet-config.ts parseFleetConfig's rules (KEY=value, blank lines and # comments skipped, one pair of quotes taken off). Not imported: that
 *  module copies the file into process.env when it loads, and an env value would then hide every later change of the file from the re-read. */
export function parseSettings(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
    let val = line.slice(eq + 1).trim()
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) val = val.slice(1, -1)
    out[key] = val
  }
  return out
}

export type Settings = { list: Set<string> | '*'; dirs: Map<string, string>; errors: string[] }

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRAB_LABS_PLUGINS_ENV || join(env.HOME || homedir(), '.config', 'crab-labs-plugins', 'env')
}

/** ONSEN_BRIDGE and ONSEN_BRIDGE_STATE_DIRS: the bridge's environment first, then the settings file (read now) */
export function readSettings(env: NodeJS.ProcessEnv = process.env, file = settingsPath(env)): Settings {
  let fileVals: Record<string, string> = {}
  try { fileVals = parseSettings(readFileSync(file, 'utf8')) } catch {}
  const pick = (k: string): string => (env[k] !== undefined ? env[k]! : fileVals[k] ?? '').trim()
  const errors: string[] = []
  const raw = pick('ONSEN_BRIDGE')
  let list: Set<string> | '*' = new Set()
  if (raw && !['0', 'off', 'false', 'no'].includes(raw.toLowerCase())) {
    const names = raw.split(',').map(x => x.trim()).filter(Boolean)
    if (names.includes('*')) list = '*'
    else list = new Set(names.filter(n => { const ok = MEMBER_RE.test(n); if (!ok) errors.push(`ONSEN_BRIDGE: ${n} is not a member name`); return ok }))
  }
  const dirs = new Map<string, string>()
  for (const pair of pick('ONSEN_BRIDGE_STATE_DIRS').split(',').map(x => x.trim()).filter(Boolean)) {
    const i = pair.indexOf('=')
    const m = i > 0 ? pair.slice(0, i).trim() : '', d = i > 0 ? pair.slice(i + 1).trim() : ''
    if (!MEMBER_RE.test(m) || !isAbsolute(d)) { errors.push(`ONSEN_BRIDGE_STATE_DIRS: ${pair.slice(0, 80)} is not member=/absolute/dir`); continue }
    dirs.set(m, d)
  }
  return { list, dirs, errors }
}

function listDir(p: string): string[] { try { return readdirSync(p) } catch { return [] } }
function readText(p: string): string { try { return readFileSync(p, 'utf8') } catch { return '' } }

/** the environment a launchd plist sets (its EnvironmentVariables dict: <key>K</key><string>V</string>) */
export function plistEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? ''
  for (const m of dict.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) out[m[1]!] = m[2]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  return out
}

/** the environment a systemd unit (and drop-in) sets: Environment= lines, each one or more K=V words, quoted or not; %h is the home */
export function unitEnv(text: string, home: string, into: Record<string, string> = {}): Record<string, string> {
  for (const line of text.split('\n')) {
    const m = /^\s*Environment\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const words = m[1]!.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []
    for (let w of words) {
      if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) w = w.slice(1, -1)
      const i = w.indexOf('=')
      if (i > 0) into[w.slice(0, i)] = w.slice(i + 1).replace(/%h/g, home)
    }
  }
  return into
}

export type Found = { member: string; stateDir: string; source: string; roamerPort?: number }

/** the Telegram daemons installed on this machine: member → its state dir (see the header); `dupes`: members two units claim (not carried) */
export function discover(home: string, platform: string): { found: Map<string, Found>; dupes: string[] } {
  const units: Array<{ source: string; env: Record<string, string> }> = []
  if (platform === 'darwin') {
    const dir = join(home, 'Library', 'LaunchAgents')
    for (const f of listDir(dir).filter(n => n.endsWith('.plist'))) {
      const t = readText(join(dir, f))
      if (t.includes('TELEGRAM_STATE_DIR')) units.push({ source: f, env: plistEnv(t) })
    }
  } else {
    const dir = join(home, '.config', 'systemd', 'user')
    for (const f of listDir(dir).filter(n => n.endsWith('.service'))) {
      const env = unitEnv(readText(join(dir, f)), home)
      for (const c of listDir(join(dir, `${f}.d`)).filter(n => n.endsWith('.conf')).sort()) unitEnv(readText(join(dir, `${f}.d`, c)), home, env)
      if (env.TELEGRAM_STATE_DIR) units.push({ source: f, env })
    }
  }
  const found = new Map<string, Found>()
  const dupes = new Set<string>()
  for (const u of units) {
    const sd = (u.env.TELEGRAM_STATE_DIR ?? '').trim()
    if (!sd || !isAbsolute(sd) || u.env.CHANNEL_INBOX_ONLY === '1') continue
    // an agent-inbox unit sets TELEGRAM_STATE_DIR too (its own .agent-inbox-state): only a unit whose state dir holds a bot token is a
    // Telegram daemon (the Mac mini canary found every member "claimed twice": its telegram-daemon and its agent-inbox plist)
    const roamer = isRoamerEnv(u.env)
    if (/agent-inbox/.test(u.source) || (!roamer && !readToken(sd))) continue
    const member = roamer ? roamerMember(u.env) : agentName(u.env, (u.env.AGENT_WORKSPACE_DIR ?? '').trim() || dirname(sd))
    if (!member || !MEMBER_RE.test(member)) continue
    const had = found.get(member)
    if (had && had.stateDir !== sd) { dupes.add(member); continue }
    found.set(member, { member, stateDir: sd, source: u.source, ...(roamer ? { roamerPort: Number(u.env.TELEGRAM_HTTP_PORT) || 0 } : {}) })
  }
  for (const d of dupes) found.delete(d)
  return { found, dupes: [...dupes].sort() }
}

/** the agents to carry now: the explicit map first, then discovery; only those the list names (or all with `*`) */
export function carried(s: Settings, d: { found: Map<string, Found> }): Map<string, Found> {
  const out = new Map<string, Found>()
  const want = (m: string) => s.list === '*' || s.list.has(m)
  for (const [m, dir] of s.dirs) if (want(m)) {
    const installed = [...d.found.values()].find(f => f.stateDir === dir && f.roamerPort !== undefined)
    if (installed && installed.member !== m) continue
    out.set(m, { ...d.found.get(m), member: m, stateDir: dir, source: 'ONSEN_BRIDGE_STATE_DIRS' })
  }
  for (const [m, f] of d.found) if (want(m) && !out.has(m)) out.set(m, f)
  return [...out.keys()].sort().reduce((acc, k) => acc.set(k, out.get(k)!), new Map<string, Found>())
}

/** Initial handover requires confirmation from this bot's daemon. A previously accepted bridge keeps its bot during an outage (D9). */
export async function bridgeOwnsBot(f: Found, accepted: boolean, get = fetch): Promise<boolean> {
  const port = f.roamerPort
  if (port === undefined) return true
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  try {
    const r = await get(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500), redirect: 'error' })
    if (!r.ok) return accepted
    const h = await r.json()
    return h.agent === f.member && h.connector?.roamer === true && h.connector.on === true && h.polling === false
  } catch { return accepted }
}

/** TELEGRAM_BOT_TOKEN from <state dir>/.env, parsed as the daemon parses it (KEY=value lines; the value as written). Never logged.
 *  `mtime`: the file's, so a changed token is picked up. null: no file or no token. */
export function readToken(stateDir: string): { token: string; mtime: number } | null {
  const f = join(stateDir, '.env')
  try {
    const mtime = statSync(f).mtimeMs
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && m[1] === 'TELEGRAM_BOT_TOKEN') {
        const v = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
        return /^\d+:[A-Za-z0-9_-]+$/.test(v) ? { token: v, mtime } : null
      }
    }
  } catch {}
  return null
}

export const stateDirOk = (d: string): boolean => existsSync(d) && basename(d) !== ''
