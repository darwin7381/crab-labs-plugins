// usage-wall.ts — WO-120: an agent inside a usage-limit wall is one state, not a stream of events (Chiron; Joey TG
// chiron:2001; design ~/cc-workspaces/claude-epeius/knowledge/wo120-usage-wall-design.md).
//
// The state is decided by ONE program, ~/Development/Joey-Crablabs-Skills/tools/harness/usage_wall.py (its docstring is
// the contract), which writes ~/.claude/usage-wall/<tmux key>.json. The daemons read it for probes and notices.
//
// READER RULE (mandatory): the file is trusted only while its updated_at is under 180 s old and <dir>/OFF does not
// exist; USAGE_WALL_READ=0 turns reading off. Otherwise wallState() is null and every caller behaves exactly as before
// WO-120. USAGE_WALL_DIR overrides the directory (tests).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

export const FRESH_MS = 180_000
/** Fresh human input can measure the account once a minute after this session's own refusal. */
export function personCanProbe(lastWallMs: number | null | undefined, now = Date.now()): boolean {
  return lastWallMs == null || now - lastWallMs >= 60_000
}

export const CACHE_MS = 5_000

export type WallState = {
  walled: boolean
  episode: string
  since: string | null
  kind: string | null
  text: string | null
  resets_at: string | null
  cleared_at: string | null
  cleared_by: string | null
  agent: string | null
  tmux: string | null
  session: string | null
  /** The state file's name without .json (= the tmux key). */
  key: string
  sinceMs: number | null
  clearedMs: number | null
  /** Latest local refusal. During an active wall the hook can be newer than the keeper's last transcript scan. */
  lastWallMs: number | null
}

/** Which state file is this daemon's: any of tmux == CHANNEL_BOT_TMUX_SESSION, agent == AGENT_INBOX_SELF,
 *  dirname(transcript) == one of the daemon's transcript dirs. Empty identity = never matches (roamers). */
export type WallIdentity = { tmux?: string; agent?: string; transcriptDirs?: string[] }

export function wallDir(env: NodeJS.ProcessEnv = process.env): string {
  return (env.USAGE_WALL_DIR ?? '').trim() || join(homedir(), '.claude', 'usage-wall')
}

export function wallKey(tmux: string): string {
  return tmux.replace(/[^A-Za-z0-9._-]/g, '_')
}

const toMs = (s: unknown): number | null => {
  if (typeof s !== 'string' || !s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function toState(st: any, key: string): WallState {
  const transcript = toMs(st.last_transcript_wall), hook = toMs(st.last_wall_at)
  const lastWallMs = st.in_wall && transcript != null && hook != null ? Math.max(transcript, hook) : transcript ?? hook
  return {
    walled: st.in_wall === true, episode: st.episode, since: str(st.since), kind: str(st.kind), text: str(st.text),
    resets_at: str(st.resets_at), cleared_at: str(st.cleared_at), cleared_by: str(st.cleared_by), agent: str(st.agent),
    tmux: str(st.tmux), session: str(st.session), key, sinceMs: toMs(st.since), clearedMs: toMs(st.cleared_at),
    lastWallMs,
  }
}

/** One uncached read. null = reading is off, the dir is missing, or no fresh state file is this daemon's. */
export function readWallState(id: WallIdentity, opts: { dir?: string; now?: number; env?: NodeJS.ProcessEnv } = {}): WallState | null {
  const env = opts.env ?? process.env
  if ((env.USAGE_WALL_READ ?? '').trim() === '0') return null
  const dir = opts.dir ?? wallDir(env)
  if (existsSync(join(dir, 'OFF'))) return null
  const now = opts.now ?? Date.now()
  const tdirs = (id.transcriptDirs ?? []).filter(Boolean).map(d => resolve(d))
  const fresh = (st: any) => {
    const upd = toMs(st?.updated_at)
    return upd != null && now - upd < FRESH_MS && upd - now < FRESH_MS
  }
  const parse = (name: string): any => {
    try {
      const st = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      return st && typeof st === 'object' && typeof st.episode === 'string' && st.episode ? st : null
    } catch { return null }
  }
  // fast path: the tmux key names the file directly
  if (id.tmux) {
    const st = parse(`${wallKey(id.tmux)}.json`)
    if (st && st.tmux === id.tmux && fresh(st)) return toState(st, wallKey(id.tmux))
  }
  if (!id.agent && !tdirs.length) return null
  let names: string[]
  try { names = readdirSync(dir) } catch { return null }
  let best: { rank: number; upd: number; st: any; key: string } | null = null
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.') || n.includes('.held-')) continue
    const st = parse(n)
    if (!st || !fresh(st)) continue
    const rank = id.tmux && st.tmux === id.tmux ? 3
      : id.agent && st.agent === id.agent ? 2
      : tdirs.length && typeof st.transcript === 'string' && st.transcript && tdirs.includes(resolve(dirname(st.transcript))) ? 1
      : 0
    if (!rank) continue
    const upd = toMs(st.updated_at)!
    if (!best || rank > best.rank || (rank === best.rank && upd > best.upd)) best = { rank, upd, st, key: n.slice(0, -5) }
  }
  return best ? toState(best.st, best.key) : null
}

/** Cached reader (re-reads at most every cacheMs; env USAGE_WALL_CACHE_MS, default 5 s). onChange runs synchronously
 *  inside state() when the walled flag or the walled episode changes, or a new clear appears, before the caller acts on the new state. */
export class WallReader {
  private at = -Infinity
  private cur: WallState | null = null
  constructor(private readonly id: WallIdentity, private readonly opts: {
    dir?: string; cacheMs?: number; now?: () => number; env?: NodeJS.ProcessEnv
    onChange?: (prev: WallState | null, next: WallState | null) => void
  } = {}) {}

  cacheMs(): number {
    const env = this.opts.env ?? process.env
    const v = this.opts.cacheMs ?? Number(env.USAGE_WALL_CACHE_MS ?? CACHE_MS)
    return Number.isFinite(v) && v >= 0 ? v : CACHE_MS
  }

  state(): WallState | null {
    const now = this.opts.now?.() ?? Date.now()
    if (now - this.at < this.cacheMs()) return this.cur
    this.at = now
    const prev = this.cur
    let next: WallState | null = null
    try { next = readWallState(this.id, { dir: this.opts.dir, now, env: this.opts.env }) } catch { next = null }
    this.cur = next
    // 1.59.8 (Chiron, 1.59.7 lab): a new clear is a change too (after a stale state, prev null, neither the flag nor the episode moves)
    if ((prev?.walled ?? false) !== (next?.walled ?? false) || (next?.walled && prev?.episode !== next.episode)
      || (!!next && !next.walled && next.clearedMs != null && next.clearedMs !== prev?.clearedMs)) {
      try { this.opts.onChange?.(prev, next) } catch {}
    }
    return next
  }
}

/** 1.58.14: the limit message of a wall usage_wall.py cleared after the newest limit message it found in the transcript (the screen's verdict is not a wall
 *  while that same message is still the latest output: screen-status.ts recordView); null: no such clear. The one rule; server.ts reads it for the record */
export function clearedLimitTextOf(w: WallState | null): string | null {
  return w && !w.walled && w.text && w.clearedMs != null && w.clearedMs >= (w.lastWallMs ?? w.sinceMs ?? Infinity) ? w.text : null
}

function writeJsonAtomic(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 1))
  renameSync(tmp, path)
}

// ---------------------------------------------------------------- alerts (tg daemon)
export const CLEARED_HOW: Record<string, string> = {
  ok_turn: '恢復回應', probe_after_reset: '額度重置', probe_after_switch: '換帳號', probe_retry: '重試通了',
}
export const ALERTS_FILE = 'usage-wall-alerts.json'
const ALERT_KEEP_MS = 14 * 24 * 3600 * 1000

export function hhmmTaipei(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

/** Today's system-alert format (system-alert.ts sendAlert), the state's error line as the message. */
function withNote(text: string, note: string | null | undefined): string {
  return note && note.trim() ? `${text}\n${note.trim()}` : text
}

/** Lanes on (Sonn #10731): the enter alert says what happens to the messages for the main, and (11-23: the channel bot's main sat walled from 14:18
 *  to 18:00 because the notice did not say it) that the main does not move again by itself: a reset, another account or another model. */
export function lanesEnterNote(mainHeld: number): string {
  return '主線要等額度重置、換帳號或換模型才會再動。' + (mainHeld > 0 ? `給主線的 ${mainHeld} 則訊息先保留，一件都沒有丟；主線一能用就交給它。` : '') + '車道照常處理警報與同事的事。'
}

export function enterText(w: WallState): string {
  const msg = (w.text ?? '').trim() || `用量上限（${w.kind ?? 'unknown'}）`
  return `⚠️ 系統警告（claude TUI 自身輸出，非 AI 回覆）\n${msg.slice(0, 500)}\n(usage-wall ${w.agent ?? w.tmux ?? w.key})`
}

export function clearText(w: WallState, now = Date.now()): string {
  const how = CLEARED_HOW[w.cleared_by ?? ''] ?? (w.cleared_by || '已解除')
  return `✅ ${w.agent ?? w.tmux ?? w.key} 用量上限解除（${hhmmTaipei(w.clearedMs ?? now)}，${how}）。`
}

type AlertRec = { enter_at: string; clear_for?: string; clear_at?: string; enter_by?: string }

/** Two pushes per episode: enter (first time the episode is seen walled) and clear (cleared_at set, once per
 *  cleared_at). A reopened episode (walled again under the same id) sends nothing until its next clear. Which
 *  episodes were alerted is kept in <stateDir>/usage-wall-alerts.json, so a daemon restart doesn't alert again. */
/** The usage-wall machinery is running here: reading is on and the keeper's heartbeat (<dir>/.keeper) is fresh. A wall
 *  record seen before this agent's state file exists (its first wall) is then worth waiting for (system-alert defers it). */
export function wallKeeperAlive(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
  if ((env.USAGE_WALL_READ ?? '').trim() === '0') return false
  const dir = wallDir(env)
  if (existsSync(join(dir, 'OFF'))) return false
  try { return now - statSync(join(dir, '.keeper')).mtimeMs < FRESH_MS } catch { return false }
}

export class WallAlerts {
  private db: Record<string, AlertRec> | null = null
  constructor(private readonly o: {
    stateDir: string
    /** Default sender; system-alert.ts passes its own notify pipeline to tick() instead. */
    notify?: (text: string) => void
    log: (level: 'info' | 'warn' | 'error', msg: string) => void
    now?: () => number
    /** Someone else already pushed this episode's enter (lanes, before the state existed): record it, don't push it again. */
    enterToldElsewhere?: (w: WallState) => string | null
    /** An extra line under the enter alert (lanes on: what the main's held messages are doing; Sonn #10731). */
    enterNote?: (w: WallState) => string | null
  }) {}

  private path(): string { return join(this.o.stateDir, ALERTS_FILE) }

  private load(): Record<string, AlertRec> {
    if (this.db) return this.db
    try {
      const j = JSON.parse(readFileSync(this.path(), 'utf8'))
      this.db = j && typeof j === 'object' && !Array.isArray(j) ? j : {}
    } catch { this.db = {} }
    return this.db!
  }

  private save(now: number): void {
    const db = this.load()
    for (const [ep, r] of Object.entries(db)) {
      const t = toMs(r?.enter_at)
      if (t != null && now - t > ALERT_KEEP_MS) delete db[ep]
    }
    try { writeJsonAtomic(this.path(), db) } catch (err) {
      this.o.log('warn', `usage wall: could not write ${this.path()} (kept in memory): ${err}`)
    }
  }

  tick(w: WallState | null, notify: (text: string) => void = this.o.notify ?? (() => {})): 'enter' | 'clear' | null {
    if (!w) return null
    const now = this.o.now?.() ?? Date.now()
    const db = this.load()
    const rec = db[w.episode]
    if (w.walled) {
      if (rec) return null
      const by = this.o.enterToldElsewhere?.(w) ?? null
      db[w.episode] = { enter_at: new Date(now).toISOString(), ...(by ? { enter_by: by } : {}) }
      this.save(now)
      if (by) { this.o.log('info', `usage wall: enter for ${w.episode} already told by ${by} — not pushed again`); return null }
      notify(withNote(enterText(w), this.o.enterNote?.(w)))
      this.o.log('info', `usage wall: enter alert for ${w.episode}`)
      return 'enter'
    }
    if (!rec || !w.cleared_at || rec.clear_for === w.cleared_at) return null
    rec.clear_for = w.cleared_at
    rec.clear_at = new Date(now).toISOString()
    this.save(now)
    notify(clearText(w, now))
    this.o.log('info', `usage wall: clear alert for ${w.episode} (${w.cleared_by})`)
    return 'clear'
  }
}

/** A jsonl line that is a usage-wall answer (usage_wall.py is_wall: assistant + isApiErrorMessage + rate_limit /
 *  billing_error or HTTP 429). */
export function isWallRecordLine(line: string): boolean {
  if (!line.includes('"isApiErrorMessage":true')) return false
  try {
    const r = JSON.parse(line)
    return r?.type === 'assistant' && r?.isApiErrorMessage === true
      && (r?.error === 'rate_limit' || r?.error === 'billing_error' || r?.apiErrorStatus === 429)
  } catch { return false }
}

/** Does this episode cover a wall record written at tsMs (the state owns it, so it is not forwarded on its own)? */
export function wallCovers(w: WallState | null, tsMs: number): boolean {
  if (!w || w.sinceMs == null || w.sinceMs > tsMs + 120_000) return false
  return w.walled || (w.clearedMs ?? 0) >= tsMs - 5_000
}
