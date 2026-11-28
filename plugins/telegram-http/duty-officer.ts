// duty-officer.ts — 值班員: every agent's own Telegram daemon watches its own terminal for a screen that is
// waiting for a key (a permission prompt, a Claude Code offer, a startup menu …) and has it handled
// (BTCC WO-97, 2026-11-16; the formal version of Chiron's interim tools/menu_aide/duty_officer.py).
//
//   detect   every POLL_MS: the pane's last 12 non-empty lines → WORKING / IDLE / STARTING / OTHER
//            (same rules as Chiron's). OTHER with the same screen for STALL_MS = stalled. One more gate
//            from the transcript: a screen with no key hint while the agent's transcript is still being
//            written is not a stall yet (it is printing or starting); a screen with a key hint always is.
//   judge    one headless `claude -p` (Opus 5.5, effort low, no tools, JSON schema) with Chiron's two
//            files: aide_prompt.md as the system prompt and rulings.md in the evidence bundle. Both are
//            re-read on every call and never copied: Chiron maintains them.
//   act      none     → one log line.
//            do       → only fixed keys (Up Down Left Right Enter Esc Tab Space); the screen is re-captured
//                       right before pressing and must be unchanged; after pressing it is looked at again;
//                       a follow-up dialog is handled as the next step (max 3).
//            ask_joey → the agent's OWN bot sends Joey the duty officer's note with one button per option.
//                       His tap comes back to this same daemon: re-check the screen, press, look again, edit
//                       the message with the result, mail the ruling to Chiron. No agent session is involved.
//            failure  (model error, over budget, rule files missing) → Joey gets the raw screen, with buttons
//                       when the screen is a plain numbered menu.
//
// State lives in ~/.claude/duty-officer/ on each machine:
//   config.json   the switch, read every tick: {"enabled": "*" | [tmux or label …], "dry_keys": bool,
//                 "test_targets": {"dotest-1": "<owning daemon's tmux>"}}. No file / not listed = off for that
//                 target, and the old startup-picker keeps handling it exactly as before.
//   claims/<tmux> touched every tick by the daemon that watches that pane (content = pid). Chiron's interim
//                 loop skips a pane whose claim is fresh, so handing a pane over (or back, by switching this
//                 off) needs no coordination; two daemons never handle the same pane.
//   log.jsonl     one line per event (the "30 秒內有一筆紀錄" check reads this).
//   ask/<id>.json each question sent to Joey (survives a daemon restart: the tap still works).
//   calls/        one empty file per model call (machine-wide budget).

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------- constants (Chiron's interim values)
export const MODEL = 'claude-opus-5-5'
// used only when MODEL refuses a judgement on its safeguards (an AUP false flag: Opus 5.5 refused a permission
// prompt to `rm -rf` its own scratch dir at 23:01Z that it had judged fine four times earlier). config: fallback_model
export const FALLBACK_MODEL = 'claude-sonnet-5-5'
export const EFFORT = 'low'
export const KEYMAP: Readonly<Record<string, string>> = {
  Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right', Enter: 'Enter', Esc: 'Escape', Tab: 'Tab', Space: 'Space',
}
const MAX_KEYS = 12
const TAIL_N = 12
const SCREEN_LINES = 60
const SNIP = 400
const FIELD_MAX = 1500
const ROLE_MAX = 200
const N_COMMANDS = 3
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024
const JOEY_ID = '1828173984'
const SHELLS = new Set(['zsh', 'bash', 'sh', '-zsh', '-bash', '-sh', 'fish'])
const FOOTER = ['bypass permissions on', '? for shortcuts']
const HINTS = ['enter confirm', 'Enter to confirm', 'Enter to select', 'esc not now',
  'Esc to cancel', 'esc to cancel', '↑/↓', 'Do you want to']
// variables that would tie the `claude -p` child to a Claude Code session; the duty officer runs on its own
const SCRUB_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CODE_SAFE_MODE']

export interface Limits {
  pollMs: number; stallMs: number; modelTimeoutMs: number; callsPerHour: number; callsPerTargetHour: number
  renotifyMs: number; maxChain: number; keyGapMs: number; verifyAfterMs: number; settleMaxMs: number
  claimFreshMs: number; attendedMs: number
}
/** WO-176 r4: DUTY_OFFICER_HOURLY_CAP_AGENTS (`agent:N[,agent:N…]`): this agent's hourly judging cap a pane (1–600), else null (the default) */
export function hourlyCapFor(value: string | undefined, agent: string): number | null {
  for (const part of String(value ?? '').split(',')) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(\d{1,3})\s*$/.exec(part)
    if (m && m[1] === agent) { const n = Number(m[2]); return n >= 1 && n <= 600 ? n : null }
  }
  return null
}
export const DEFAULT_LIMITS: Limits = {
  pollMs: 3000, stallMs: 8000, modelTimeoutMs: 60_000, callsPerHour: 30, callsPerTargetHour: 6,
  renotifyMs: 3_600_000, maxChain: 3, keyGapMs: 200, verifyAfterMs: 2000, settleMaxMs: 30_000,
  claimFreshMs: 30_000,
  // someone at the terminal (a tmux client pressed a key this recently): hands off. Same grace as modal-guard's
  // model-switch menu (ratelimit-modal-guard.sh :74); Chiron btcc 9592
  attendedMs: 120_000,
}

// ---------------------------------------------------------------- screen
export type State = 'WORKING' | 'IDLE' | 'STARTING' | 'OTHER'

export function tailLines(pane: string, n = TAIL_N): string[] {
  return pane.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim()).slice(-n)
}
export function hasHints(lines: string[]): boolean {
  return lines.some(l => HINTS.some(h => l.includes(h)))
}
export function isClaudeCmd(cmd: string, extra: ReadonlySet<string> = new Set()): boolean {
  return cmd === 'claude' || cmd === 'node' || /^\d+\.\d+\.\d+$/.test(cmd) || extra.has(cmd)
}
export function classify(lines: string[], cmd: string, extra: ReadonlySet<string> = new Set()): State {
  const text = lines.join('\n')
  const dialog = hasHints(lines)
  // a sub-agent's permission prompt can sit under a spinner line: the hints win
  if (text.includes('esc to interrupt') && !dialog) return 'WORKING'
  if (isClaudeCmd(cmd, extra) && FOOTER.some(f => text.includes(f)) && !dialog) return 'IDLE'
  if (SHELLS.has(cmd)) return 'STARTING'
  return 'OTHER'
}
// /rate-limit-options (Chiron btcc 9583): at a quota wall every agent shows it at once and `claude -p` has no
// quota either, so it is never sent to the model; com.btai.ratelimit-modal-guard answers it until it is merged here
const RATE_LIMIT = /Stop and wait|Switch to usage credits|Upgrade your plan/
const CONFIRM = /Esc.*cancel|Enter.*confirm/
export function isRateLimitMenu(lines: string[]): boolean {
  const t = lines.join('\n')
  return RATE_LIMIT.test(t) && CONFIRM.test(t)
}
const STATUSY = /tokens.*[·↓↑]|[·↓↑].*tokens|until auto-compact/
/** Hash of the tail; only status lines (token counters, timers) have their digits masked. */
export function thash(lines: string[]): string {
  const norm = lines.map(l => STATUSY.test(l) ? l.replace(/\d+(?:\.\d+)?/g, '#') : l)
  return createHash('sha1').update(norm.join('\n')).digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------- redaction (port of collect.py)
const EMAIL = /\b([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g
const PATTERNS: Array<[RegExp, boolean]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, false],
  [/\bapikey_[A-Za-z0-9_-]{6,}/g, false],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, false],
  [/\b(?:ghp|gho|ghs|ghu|github_pat|xox[abpr]|glpat|AKIA)[A-Za-z0-9_-]{10,}/g, false],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, false], // Telegram bot token
  [/\b(token|secret|password|passwd|api[_-]?key)(\s*[=:]\s*)['"]?[^\s'"]{8,}/gi, true],
]
const RUN = /[A-Za-z0-9_\-+/=]{32,}/g
function entropy(s: string): number {
  const c = new Map<string, number>()
  for (const ch of s) c.set(ch, (c.get(ch) ?? 0) + 1)
  let e = 0
  for (const v of c.values()) e -= (v / s.length) * Math.log2(v / s.length)
  return e
}
function tokenish(run: string): boolean {
  const inner = run.replace(/^\/+|\/+$/g, '')
  if (inner.includes('/') && (run.match(/\//g) ?? []).length >= 2) return false // path
  if ((run.match(/-/g) ?? []).length >= 4 && entropy(run) < 4.3) return false // slug / UUID / project dir
  if (/^[0-9a-f]{40,}$/.test(run)) return true
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter(p => p.test(run)).length
  return classes >= 2 && entropy(run) >= 4.3
}
export function redact(s: string): string
export function redact(s: unknown): unknown
export function redact(s: unknown): unknown {
  if (typeof s !== 'string') return s
  let out = s
  for (const [p, grouped] of PATTERNS) out = out.replace(p, grouped ? '$1$2(hidden)' : '(hidden)')
  out = out.replace(RUN, m => tokenish(m) ? '(hidden)' : m)
  return out.replace(EMAIL, (_m, user: string, dom: string) => `${user.slice(0, 2)}***@${dom}`)
}
export function clip(s: unknown, n: number): string | null {
  if (s == null) return null
  const t = String(s)
  return t.length <= n ? t : `${t.slice(0, n)}…(+${t.length - n} chars)`
}
function clipFields(o: unknown, n = FIELD_MAX): unknown {
  if (typeof o === 'string') return redact(clip(o, n))
  if (Array.isArray(o)) return o.map(x => clipFields(x, n))
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clipFields(v, n)]))
  return o
}

// ---------------------------------------------------------------- time
export const iso = (ms: number) => new Date(ms).toISOString()
const pad = (n: number) => String(n).padStart(2, '0')
export function tpe(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} TPE`
}
const hmz = (ms: number) => `${pad(new Date(ms).getUTCHours())}:${pad(new Date(ms).getUTCMinutes())}Z`
function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s >= 86400) return `${Math.floor(s / 86400)} d`
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}
const tsOf = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// ---------------------------------------------------------------- transcript (port of collect.py scan)
type UserMsg = { ts: number; text: string; channel: boolean; attrs: Record<string, string> }
export interface Scan {
  uses: Map<string, { ts: number; name: string; input: unknown; req: string | null }>
  results: Map<string, number>
  texts: Array<[number, string]>
  users: UserMsg[]
  assistantReq: Array<[number, string | null]>
  turnEnds: number[]
  firstUser: [number, string] | null
  commands: Array<{ ts: number; name: string; args: string; output: string | null }>
  model: [string, number] | null
}
const CHAN_ATTR = /<channel\s+([^>]*)>/
function chanAttrs(text: string): Record<string, string> {
  const m = CHAN_ATTR.exec(text)
  if (!m) return {}
  return Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(x => [x[1], x[2]]))
}
const stripReminders = (t: string) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
const CMD_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const CMD_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
const CMD_OUT = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
function recordText(r: any): string {
  if (r.type === 'system') return typeof r.content === 'string' ? r.content : ''
  const c = r.message && typeof r.message === 'object' ? r.message.content : undefined
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('\n')
  return ''
}

export function scanTranscript(text: string, at: number): Scan {
  const out: Scan = { uses: new Map(), results: new Map(), texts: [], users: [], assistantReq: [], turnEnds: [],
    firstUser: null, commands: [], model: null }
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"turn_duration"')
      && !line.includes('"queued_command"') && !line.includes('"local_command"')) continue
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    const ts = tsOf(r.timestamp)
    if (ts == null || ts > at) continue
    const typ = r.type
    if ((typ === 'user' || (typ === 'system' && r.subtype === 'local_command'))
      && (line.includes('<command-name>') || line.includes('<local-command-std'))) {
      const t = recordText(r)
      const m = CMD_NAME.exec(t)
      if (m) {
        const a = CMD_ARGS.exec(t)
        out.commands.push({ ts, name: m[1].trim(), args: a ? a[1].trim() : '', output: null })
      } else {
        const o = CMD_OUT.exec(t)
        const last = out.commands[out.commands.length - 1]
        if (o && last && last.output == null) last.output = o[1].replace(ANSI, '').trim()
      }
      if (typ === 'system') continue
    }
    if (typ === 'assistant' && !r.isSidechain) {
      const mm = r.message?.model
      if (mm && mm !== '<synthetic>') out.model = [mm, ts]
    }
    if (typ === 'attachment') {
      // a message absorbed mid-turn is recorded only as a queued_command attachment
      const att = r.attachment && typeof r.attachment === 'object' ? r.attachment : {}
      if (att.type !== 'queued_command') continue
      const t = stripReminders(typeof att.prompt === 'string' ? att.prompt : '')
      const isCh = att.origin?.kind === 'channel' || t.trimStart().startsWith('<channel')
      if (t && !out.users.some(u => u.text === t)) out.users.push({ ts, text: t, channel: isCh, attrs: chanAttrs(t) })
      continue
    }
    if (typ === 'system' && r.subtype === 'turn_duration') { out.turnEnds.push(ts); continue }
    const content = r.message && typeof r.message === 'object' ? r.message.content : undefined
    if (typ === 'assistant') {
      out.assistantReq.push([ts, r.requestId ?? null])
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_use') out.uses.set(b.id, { ts, name: b.name, input: b.input, req: r.requestId ?? null })
          else if (b?.type === 'text' && (b.text ?? '').trim()) out.texts.push([ts, b.text])
        }
      }
    } else if (typ === 'user') {
      let t = ''
      if (Array.isArray(content)) {
        let hasResult = false
        for (const b of content) {
          if (b?.type === 'tool_result') { hasResult = true; out.results.set(b.tool_use_id, ts) }
        }
        if (hasResult) continue
        t = content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('\n')
      } else if (typeof content === 'string') t = content
      if (out.firstUser == null && t) out.firstUser = [ts, t]
      const isCh = r.origin?.kind === 'channel' || t.trimStart().startsWith('<channel')
      if (r.isMeta && !isCh) continue
      t = stripReminders(t)
      if (!t || t.startsWith('<local-command') || t.startsWith('<command-')) continue
      if (out.users.slice(-5).some(u => u.text === t)) continue
      out.users.push({ ts, text: t, channel: isCh, attrs: chanAttrs(t) })
    }
  }
  out.users.sort((a, b) => a.ts - b.ts)
  out.texts.sort((a, b) => a[0] - b[0])
  return out
}

/** Live pending tool calls: no result yet and no newer assistant API response after them. */
export function pendingIn(ev: Scan) {
  const live: Array<{ id: string; ts: number; name: string; input: unknown; req: string | null }> = []
  let stale = 0
  for (const [id, u] of ev.uses) {
    if (ev.results.has(id)) continue
    const newer = ev.assistantReq.some(([ts, req]) => ts > u.ts && req !== u.req)
    if (newer) stale++
    else live.push({ id, ...u })
  }
  return { live, stale }
}

function readTail(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): string {
  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    let s = buf.toString('utf8')
    if (start > 0) { const i = s.indexOf('\n'); s = i >= 0 ? s.slice(i + 1) : '' }
    return s
  } finally { closeSync(fd) }
}
function newestJsonl(dir: string): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return null }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    try {
      const m = statSync(join(dir, n)).mtimeMs
      if (!best || m > best.mtime) best = { path: join(dir, n), mtime: m }
    } catch {}
  }
  return best
}
/** Newest write to the session's transcript or one of its sub-agent transcripts. */
export function transcriptMtime(projectsDir: string | null | undefined): number | null {
  if (!projectsDir) return null
  const main = newestJsonl(projectsDir)
  if (!main) return null
  const sub = newestJsonl(join(main.path.slice(0, -'.jsonl'.length), 'subagents'))
  return Math.max(main.mtime, sub?.mtime ?? 0)
}

// ---------------------------------------------------------------- tmux
export interface PaneInfo { cmd: string; inMode: boolean; path: string }
export interface Tmux {
  capture(target: string, scrollback?: number): Promise<string | null>
  /** Last key pressed by any attached tmux client, epoch ms; null = nobody attached. Keys sent with
   *  `send-keys -t` (ours, the supervisor's) do not move it; keys typed through a client do. */
  clientActivity(target: string): Promise<number | null>
  info(target: string): Promise<PaneInfo | null>
  sendKey(target: string, key: string): Promise<void>
  cancelMode(target: string): Promise<void>
}
function run(argv: string[], timeoutMs = 8000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    let out = ''
    let done = false
    const p = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { if (!done) { done = true; try { p.kill('SIGKILL') } catch {}; resolve({ code: 124, out }) } }, timeoutMs)
    p.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    p.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out }) } })
    // 'close', not 'exit': 'exit' can fire before stdout has been read, and an empty capture looks like no pane
    p.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -1, out }) } })
  })
}
// `-u` on every call: a launchd daemon has no UTF-8 locale, and without it tmux prints control characters as
// '_' (the tab between display-message fields came back as "python3.12_0", so no pane ever parsed: 1.29.0
// canary) and may do the same to non-ASCII screen text.
export const realTmux: Tmux = {
  async capture(t, scrollback) {
    const r = await run(['tmux', '-u', 'capture-pane', '-p', ...(scrollback ? ['-S', `-${scrollback}`] : []), '-t', t])
    return r.code === 0 ? r.out : null
  },
  async info(t) {
    const r = await run(['tmux', '-u', 'display-message', '-p', '-t', t, '#{pane_current_command}\t#{pane_in_mode}\t#{pane_current_path}'])
    const p = r.out.replace(/\n$/, '').split('\t')
    if (r.code !== 0 || p.length !== 3) return null
    return { cmd: p[0], inMode: p[1] === '1', path: p[2] }
  },
  async clientActivity(t) {
    const r = await run(['tmux', '-u', 'list-clients', '-t', t, '-F', '#{client_activity}'])
    const ts = r.out.split('\n').map(x => parseInt(x, 10)).filter(n => n > 0)
    return r.code === 0 && ts.length ? Math.max(...ts) * 1000 : null
  },
  async sendKey(t, key) { await run(['tmux', '-u', 'send-keys', '-t', t, key]) },
  async cancelMode(t) { await run(['tmux', '-u', 'send-keys', '-t', t, '-X', 'cancel']) },
}

// ---------------------------------------------------------------- evidence bundle (port of collect.py build)
export interface Target { label: string; tmux: string; projectsDir?: string | null; test?: boolean }

function readManifest(dir: string): any | null {
  try { return JSON.parse(readFileSync(join(dir, '.cc-agent.json'), 'utf8')) } catch { return null }
}
function findManifest(tmux: string, panePath: string | null, home: string): { m: any; dir: string } | null {
  if (panePath) { const m = readManifest(panePath); if (m) return { m, dir: panePath } }
  let names: string[] = []
  try { names = readdirSync(join(home, 'cc-workspaces')) } catch { return null }
  for (const n of names) {
    const dir = join(home, 'cc-workspaces', n)
    const m = readManifest(dir)
    if (m && m.tmux_session === tmux) return { m, dir: m.workspace_dir || dir }
  }
  return null
}
function personaRole(dir: string | null): string | null {
  if (!dir) return null
  let head: string | null = null
  let quote: string | null = null
  try {
    const lines = readFileSync(join(dir, 'CLAUDE.md'), 'utf8').split('\n').slice(0, 61)
    for (const raw of lines) {
      if (head && quote) break
      const s = raw.trim()
      if (head == null && /^#\s+\S/.test(s)) head = s.replace(/^#+/, '').trim()
      else if (quote == null && s.startsWith('>') && s.replace(/^>\s*/, '').trim()) quote = s.replace(/^>\s*/, '').trim()
    }
  } catch { return null }
  const role = [head, quote].filter(Boolean).join(' — ').replaceAll('**', '')
  return role ? redact(clip(role, ROLE_MAX)!) : null
}
export const projectDirOf = (home: string, workspace: string) =>
  join(home, '.claude', 'projects', workspace.replaceAll('/', '-').replaceAll('.', '-'))
function screenTail(text: string): string {
  const lines = text.replace(/\n+$/, '').split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.slice(-SCREEN_LINES).join('\n')
}

export function buildBundle(o: {
  target: Target; at: number; screen: string | null; panePath: string | null; rulings: string; home: string
}): Record<string, unknown> {
  const { target, at, home } = o
  const found = findManifest(target.tmux, o.panePath, home)
  const wsOk = o.panePath && (o.panePath.startsWith(join(home, 'cc-workspaces') + '/') || o.panePath.startsWith(join(home, '.claude', 'workspace-')))
  const workspace = found?.dir ?? (wsOk ? o.panePath : null)
  const name = found?.m?.name ?? target.label
  const profile: Record<string, unknown> = {
    name, role: personaRole(workspace), model_registered: found?.m?.model ?? null, model_in_use: null,
    model_in_use_seen_at: null, known_agent: !!found,
  }
  if (!found) profile.note = 'unknown agent: no manifest for this pane'
  const bundle: Record<string, unknown> = { agent: name, now: { utc: iso(at), taipei: tpe(at) }, agent_profile: profile }
  bundle.screen = o.screen == null ? null : redact(screenTail(o.screen))
  bundle.screen_source = `tmux capture-pane -p -S -${SCREEN_LINES} -t ${target.tmux} (last ${SCREEN_LINES} lines)`

  const pdir = target.projectsDir ?? (workspace ? projectDirOf(home, workspace) : null)
  const tr = pdir ? newestJsonl(pdir)?.path ?? null : null
  bundle.transcript = tr ? tr.replace(home, '~') : null
  let main: Scan | null = null
  try { main = tr ? scanTranscript(readTail(tr), at) : null } catch { main = null }
  if (main?.model) { profile.model_in_use = main.model[0]; profile.model_in_use_seen_at = tpe(main.model[1]) }

  // sub-agent transcripts active in the 6 h before now
  const side: Array<{ file: string; meta: any; ev: Scan }> = []
  if (tr) {
    const sdir = join(tr.slice(0, -'.jsonl'.length), 'subagents')
    let names: string[] = []
    try { names = readdirSync(sdir) } catch {}
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const f = join(sdir, n)
      try { if (statSync(f).mtimeMs < at - 6 * 3600_000) continue } catch { continue }
      let meta: any = {}
      try { meta = JSON.parse(readFileSync(f.slice(0, -'.jsonl'.length) + '.meta.json', 'utf8')) } catch {}
      try { side.push({ file: n, meta, ev: scanTranscript(readTail(f), at) }) } catch {}
    }
  }
  type Cand = { u: ReturnType<typeof pendingIn>['live'][number]; src: string; side: typeof side[number] | null }
  const cands: Cand[] = []
  let stale = 0
  if (main) { const p = pendingIn(main); stale += p.stale; cands.push(...p.live.map(u => ({ u, src: 'main', side: null }))) }
  for (const s of side) { const p = pendingIn(s.ev); stale += p.stale; cands.push(...p.live.map(u => ({ u, src: s.file, side: s }))) }
  cands.sort((a, b) => b.u.ts - a.u.ts)
  const fmt = (c: Cand) => ({
    source: c.src === 'main' ? 'main thread' : `subagent sidechain ${c.src}`,
    ts: iso(c.u.ts), ts_taipei: tpe(c.u.ts), waiting_for: ago(at - c.u.ts),
    tool: c.u.name, tool_use_id: c.u.id, input: clipFields(c.u.input),
    ...(c.side ? { subagent_description: redact(c.side.meta?.description ?? null) } : {}),
  })
  if (cands.length) {
    bundle.pending_tool_call = fmt(cands[0])
    bundle.other_pending = cands.slice(1, 5).map(c => {
      const { input: _i, ...rest } = fmt(c)
      return { ...rest, input_summary: clip(redact(JSON.stringify(c.u.input)), 300) }
    })
    const s = cands[0].side
    if (s) {
      bundle.subagent = {
        file: s.file, agentType: s.meta?.agentType ?? null, description: redact(s.meta?.description ?? null),
        launched_by_tool_use_id: s.meta?.toolUseId ?? null, requestShape: s.meta?.requestShape ?? null,
        task_prompt: s.ev.firstUser ? redact(clip(s.ev.firstUser[1], SNIP)) : null,
        last_texts: s.ev.texts.slice(-2).map(([t, x]) => ({ ts: iso(t), text: redact(clip(x, SNIP)) })),
      }
    }
  } else {
    bundle.pending_tool_call = null
    bundle.other_pending = []
  }
  bundle.stale_unanswered_tool_calls_ignored = stale
  bundle.recent_commands = (main?.commands.slice(-N_COMMANDS) ?? []).map(c => ({
    ts_taipei: tpe(c.ts), ago: ago(at - c.ts), name: c.name, args: redact(clip(c.args, 200)),
    output: c.output ? redact(clip(c.output, 160)) : null,
  }))
  const rec: Record<string, unknown> = { assistant_texts: [], user_messages: [], last_joey_message: null, last_turn_ended_at: null }
  if (main) {
    const body = (x: string) => x.replace(/^\s*<channel[^>]*>\s*/, '').replace(/\s*<\/channel>\s*$/, '')
    const via = (a: Record<string, string>) => (a.source ?? '').split(':').pop() || null
    rec.assistant_texts = main.texts.slice(-4).map(([t, x]) => ({ ts: iso(t), ts_taipei: tpe(t), text: redact(clip(x, SNIP)) }))
    rec.user_messages = main.users.slice(-2).map(u => ({
      ts: iso(u.ts), ts_taipei: tpe(u.ts), from: u.channel ? (u.attrs.user ?? 'channel') : 'typed/system',
      via: u.channel ? via(u.attrs) : null, text: redact(clip(body(u.text), SNIP)),
    }))
    const joey = main.users.filter(u => u.channel && u.attrs.user_id === JOEY_ID)
    const j = joey[joey.length - 1]
    if (j && j.ts >= at - 6 * 3600_000) {
      rec.last_joey_message = { ts: iso(j.ts), ts_taipei: tpe(j.ts), via: via(j.attrs), message_id: j.attrs.message_id ?? null, text: redact(clip(body(j.text), SNIP)) }
    }
    if (main.turnEnds.length) {
      const te = main.turnEnds[main.turnEnds.length - 1]
      const lastUser = main.users.length ? main.users[main.users.length - 1].ts : null
      if (lastUser == null || te >= lastUser) rec.last_turn_ended_at = { ts: iso(te), ts_taipei: tpe(te) }
    }
  }
  bundle.recent = rec
  bundle.rulings = o.rulings
  return bundle
}

// ---------------------------------------------------------------- the model call
const KEY_ITEM = { anyOf: [
  { type: 'string', enum: Object.keys(KEYMAP) },
  { type: 'object', properties: { type: { type: 'string' } }, required: ['type'], additionalProperties: false },
] }
export const SCHEMA = {
  type: 'object',
  properties: {
    what: { type: 'string' }, why_now: { type: 'string' },
    options: { type: 'array', items: {
      type: 'object',
      properties: { on_screen: { type: 'string' }, means: { type: 'string' }, button: { type: 'string' }, keys: { type: 'array', items: KEY_ITEM } },
      required: ['on_screen', 'means', 'button', 'keys'], additionalProperties: false } },
    if_nobody_answers: { type: 'string' }, covered_by: { type: ['string', 'null'] },
    action: { type: 'string', enum: ['do', 'ask_joey', 'none'] }, choose: { type: 'string' }, reason: { type: 'string' },
    to_joey: { type: 'string' }, unsure: { type: 'array', items: { type: 'string' } },
  },
  required: ['what', 'why_now', 'options', 'if_nobody_answers', 'covered_by', 'action', 'choose', 'reason', 'to_joey', 'unsure'],
  additionalProperties: false,
}
export interface DecisionOption { on_screen: string; means: string; button: string; keys: unknown[] }
export interface Decision {
  what: string; why_now: string; options: DecisionOption[]; if_nobody_answers: string; covered_by: string | null
  action: 'do' | 'ask_joey' | 'none'; choose: string; reason: string; to_joey: string; unsure: string[]
}
export interface ModelResult { decision: Decision | null; meta: Record<string, unknown>; fail: string | null }

export function extractJson(text: unknown): [unknown, string | null] {
  const t = String(text ?? '').trim()
  try { return [JSON.parse(t), 'raw'] } catch {}
  const m = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(t)
  if (m) { try { return [JSON.parse(m[1]), 'fenced'] } catch {} }
  const i = t.indexOf('{'); const j = t.lastIndexOf('}')
  if (i >= 0 && j > i) { try { return [JSON.parse(t.slice(i, j + 1)), 'embedded'] } catch {} }
  return [null, null]
}
const validDecision = (d: any): d is Decision => !!d && typeof d === 'object' && ['do', 'ask_joey', 'none'].includes(d.action)

export function claudeBin(home = homedir()): string {
  if (process.env.DUTY_OFFICER_CLAUDE) return process.env.DUTY_OFFICER_CLAUDE
  const p = join(home, '.local', 'bin', 'claude')
  return existsSync(p) ? p : 'claude'
}
export function modelArgs(systemPrompt: string, model = MODEL): string[] {
  return ['-p', '--model', model, '--tools', '', '--system-prompt', systemPrompt, '--output-format', 'json',
    '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--max-budget-usd', '5', '--effort', EFFORT, '--json-schema', JSON.stringify(SCHEMA)]
}

/** One headless `claude -p` from a fresh empty directory; the bundle goes on stdin. */
export function askModelCli(bundle: Record<string, unknown>, systemPrompt: string, timeoutMs: number, model = MODEL): Promise<ModelResult> {
  const sent = Object.fromEntries(Object.entries(bundle).filter(([k]) => !k.startsWith('_')))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SCRUB_ENV.includes(k)) env[k] = v
  env.CLAUDE_EFFORT = EFFORT
  const scratch = mkdtempSync(join(tmpdir(), 'duty-officer-'))
  const t0 = Date.now()
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (r: ModelResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { rmSync(scratch, { recursive: true, force: true }) } catch {}
      r.meta.seconds = Math.round((Date.now() - t0) / 100) / 10
      resolve(r)
    }
    let p: ReturnType<typeof spawn>
    try {
      p = spawn(claudeBin(), modelArgs(systemPrompt, model), { cwd: scratch, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ decision: null, meta: {}, fail: `could not run claude: ${String(e).slice(0, 120)}` })
      return
    }
    const timer = setTimeout(() => {
      try { process.kill(-p.pid!, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} }
      finish({ decision: null, meta: {}, fail: `timeout ${Math.round(timeoutMs / 1000)}s` })
    }, timeoutMs)
    p.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    p.stderr?.on('data', (c: Buffer) => { err += c.toString() })
    p.on('error', e => finish({ decision: null, meta: {}, fail: `could not run claude: ${String(e).slice(0, 120)}` }))
    p.on('close', code => { // 'close': all of stdout has been read
      const meta: Record<string, unknown> = { returncode: code, model }
      let envl: any
      try { envl = JSON.parse(out) } catch {
        meta.stderr_head = redact(err.slice(0, 300))
        finish({ decision: null, meta, fail: 'no JSON envelope from claude' })
        return
      }
      Object.assign(meta, { cost: envl.total_cost_usd, api_ms: envl.duration_api_ms, is_error: envl.is_error, subtype: envl.subtype,
        output_tokens: envl.usage?.output_tokens })
      let d: unknown = envl.structured_output
      let how: string | null = 'structured_output'
      if (!validDecision(d)) [d, how] = extractJson(envl.result)
      meta.json_how = how
      if (!validDecision(d)) {
        meta.result_head = redact(String(envl.result).slice(0, 300))
        if (envl.is_error && /safeguards|usage polic|legal\/aup/i.test(String(envl.result))) {
          meta.refused = true
          finish({ decision: null, meta, fail: `refused by ${model}'s safeguards` })
          return
        }
        finish({ decision: null, meta, fail: 'invalid JSON from the duty officer' })
        return
      }
      finish({ decision: d, meta, fail: null })
    })
    p.stdin?.on('error', () => {})
    p.stdin?.end(JSON.stringify(sent, null, 1))
  })
}

/** A `do` decision is pressed only when its keys are the fixed tokens; otherwise it goes to Joey. */
export function checkDo(d: Decision): { keys: string[] } | { bad: string } {
  const opt = (d.options ?? []).find(o => o && typeof o === 'object' && o.button === d.choose)
  if (!opt) return { bad: "choose matches no option's button" }
  const keys = opt.keys
  if (!Array.isArray(keys) || !keys.length || keys.length > MAX_KEYS) return { bad: 'keys missing or too long' }
  if (!keys.every(k => typeof k === 'string' && k in KEYMAP)) return { bad: 'keys contain something other than the fixed tokens (typing goes to Joey)' }
  return { keys: keys as string[] }
}
const fixedKeys = (keys: unknown): string[] | null =>
  Array.isArray(keys) && keys.length > 0 && keys.length <= MAX_KEYS && keys.every(k => typeof k === 'string' && k in KEYMAP) ? keys as string[] : null

// ---------------------------------------------------------------- plain numbered menus (fallback buttons)
const MENU_LINE = /^\s*([❯›▶●○◉>*]?)\s*(\d+)\.\s+(.+?)\s*$/
/** A numbered menu with a live cursor: its labels and the keys that move from the cursor to each one. */
export function numberedMenu(pane: string): Array<{ button: string; keys: string[] }> | null {
  const rows: Array<{ n: number; label: string; cursor: boolean }> = []
  for (const l of pane.split('\n')) {
    const m = MENU_LINE.exec(l)
    if (m) rows.push({ n: parseInt(m[2], 10), label: m[3].replace(/[│╮╯]+$/, '').trim(), cursor: !!m[1] && '❯›▶>'.includes(m[1]) })
  }
  // the last clean 1..N run on the screen (the menu is drawn last)
  let run: typeof rows = []
  for (const r of rows) {
    if (r.n === 1) run = [r]
    else if (run.length && r.n === run[run.length - 1].n + 1) run.push(r)
  }
  const at = run.findIndex(r => r.cursor)
  if (run.length < 2 || at < 0) return null
  return run.map((r, i) => ({
    button: `${r.n}. ${r.label}`.slice(0, 60),
    keys: [...Array(Math.abs(i - at)).fill(i > at ? 'Down' : 'Up'), 'Enter'],
  }))
}

// ---------------------------------------------------------------- the officer
export interface Button { text: string; callback_data: string }
export interface Sent { chat: string; msg: number }
export interface OfficerDeps {
  listTargets(): Promise<Target[]>
  tmux: Tmux
  model(bundle: Record<string, unknown>, systemPrompt: string, timeoutMs: number, model?: string): Promise<ModelResult>
  send(chats: string[], text: string, buttons: Button[][] | null): Promise<Sent[]>
  edit(s: Sent, text: string): Promise<void>
  /** `to` is set only for a test target (config test_rulings_to); otherwise the daemon's rulings recipient. */
  mail(title: string, body: string, to?: string): Promise<string>
  recipients(): string[]
  /** lanes-golive (C8): another program owns this screen (with lanes on: the main's usage-limit menu is the lanes main-wall probe's): its name, or null.
   *  An owned screen is never judged, pressed or sent; absent = nobody else owns anything (the fleet's behaviour). */
  owner?(t: Target, lines: string[]): string | null
  log(level: 'info' | 'warn' | 'error', msg: string): void
  /** WO-165 A: every look at a pane (its foreground command and visible text), for the screen-status reader of that pane */
  onLook?(tmux: string, cmd: string, pane: string): void
  /** WO-176: this daemon's menus as Onsen Actions; absent: none (the officer works exactly as before) */
  actions?: MenuActions
  now?(): number
  sleep?(ms: number): Promise<void>
}
export interface OfficerOpts {
  dir?: string; rulesDirs?: string[]; home?: string; host?: string; limits?: Partial<Limits>; extraClaude?: string[]
}
interface Config {
  enabled: '*' | string[]; dry_keys: boolean
  // acceptance tests: a scratch pane watched by the daemon that owns it; its questions go to test_recipients
  // (not Joey) and its rulings to test_rulings_to
  test_targets: Record<string, string>; test_recipients: string[]; test_rulings_to: string | null
  // extra foreground commands that count as Claude Code (fake_dialog.py runs as python: its idle footer is idle)
  claude_cmds: string[]
  // model asked when MODEL refuses on its safeguards; null = no second try (Joey gets the raw screen)
  fallback_model: string | null
}
const NO_CONFIG: Config = { enabled: [], dry_keys: false, test_targets: {}, test_recipients: [], test_rulings_to: null, claude_cmds: [], fallback_model: FALLBACK_MODEL }
interface Rec { action: string; t: number; askId?: string; resolved?: boolean | null }
interface PaneState { hash: string; state: State; since: number; rec: Rec | null; attendedLogged?: boolean }
interface Ask {
  id: string; tmux: string; label: string; host: string; hash: string; created: string; kind: 'ask_joey' | 'unreadable'; test?: boolean
  reason: string; text: string; options: Array<{ button: string; keys: string[] | null; means?: string
    /** WO-176 r2: the option as the screen shows it (the decision's on_screen) */
    screen?: string }>
  decision: Decision | null; screen_tail: string; messages: Sent[]; notified: number[]
  closed?: { how: 'answered' | 'gone'; at: string; by?: string; choice?: string; result?: string
    /** WO-176: the option pressed (its Action option id), the member who pressed it, and where (Telegram or Onsen) */
    option_id?: string; member?: string | null; via?: 'telegram' | 'onsen' }
  /** WO-176: its Action in Onsen. action_key: set when this pane's menus are this agent's Actions (MenuActions.pane); action_id / action_version: once
   *  Onsen made it; menu_kind / session_id: the menu and session it answers. An option's Action id is its index + 1 (only options with keys) */
  action_key?: string; action_id?: string; action_version?: number; menu_kind?: string | null; session_id?: string | null
  /** WO-176: its Action was cancelled when the daemon started again (the officer looks at the pane afresh and asks again if the menu is still there) */
  action_closed?: true
  /** WO-176 r2 (CONTRACT §6 「畫面上同一個詢問只有一個 Action」): the Action is the channel's permission prompt's, not one of its own; its options are
   *  allow / deny (permOptionOf maps the ask's options) */
  action_shared?: 'permission'
  /** WO-180 (Chiron 04:42Z, 1): the members the question went to (its Action's assignees, MenuActions.assignees of the chats it was sent to) */
  assignees?: string[]
  /** WO-176 r4: the permission prompt this question is about, taken when it was asked (MenuActions.bindPermission) */
  perm_bind?: PermBinding
}
// ---------------------------------------------------------------- WO-176: the menus as Onsen Actions
/** a menu's Action as an ask keeps it: the key it was made with, and Onsen's id and version once known */
export interface ActionRef { key: string; id?: string; version?: number }
export const PRESSED_ELSEWHERE = '在別處按了'
export interface MenuActionFields { menu_kind: string | null; session_id: string | null; assignees: string[]; summary: string; body: string | null
  options: Array<{ id: string; label: string }> }
/** WO-176: what the duty officer tells Onsen about its menus (server.ts gives Onsen's, onsen-client.ts OnsenActions). Every call returns at once; Onsen
 *  being slow or down never holds a message, a key or a tap */
export interface MenuActions {
  /** this pane's menus are this agent's Actions: the session it shows and the menu on it now (`bundle`: what the officer judged); null: not this agent's */
  pane(t: { tmux: string; test?: boolean }, bundle?: Record<string, unknown>): { session_id: string | null; menu_kind: string | null } | null
  /** the members these Telegram chats are (the assignees of a question sent to them) */
  assignees(chats: string[]): string[]
  /** a question to a person: an open Action; `made` hears its id and version once Onsen made it */
  open(f: MenuActionFields, key: string, made: (id: string, version: number) => void): void
  /** Bind an open permission Action before asking about the same prompt. */
  bindPermission?(t: { tmux: string; test?: boolean }, bundle?: Record<string, unknown>): PermBinding
  /** The original permission dialog disappeared after a local keypress. */
  permissionGone?(bound: NonNullable<Exclude<PermBinding, string>>): Promise<void> | void
  /** The keys requested by an Onsen control reached the pane. */
  applied(ref: ActionRef, o: { at?: string; option_id?: string; resolved_by?: string }): void
  /** nothing was pressed: the menu went away, the screen changed, the officer is off */
  cancel(ref: ActionRef, reason: string): void
  /** WO-176 r2 (CONTRACT §6 「畫面上同一個詢問只有一個 Action」): the open Action that already stands for the menu on this pane (the channel's
   *  permission prompt for that session; after a restart, Onsen's open one), which a question to `assignees` uses instead of a new one, joining
   *  them to it (Onsen 0.24.0) when one is not an assignee yet; `joined` hears the version after that. id / version once Onsen made it; null: none */
  shared?(t: { tmux: string; test?: boolean }, menu_kind: string | null, assignees: string[], joined: (version: number) => void, bound?: PermBinding):
    Promise<{ key: string; id?: string; version?: number } | null> | { key: string; id?: string; version?: number } | null
}
/** WO-176 r4: the daemon's token for the permission prompt a screen shows (MenuActions.bindPermission); kept as it is, also in the ask file */
export type PermBinding = { key: string } | { lookup: { tool: string | null; before: string } } | 'none' | 'unsure' | null
/** an Action option id ↔ the ask's option index */
export const optionIdOf = (i: number): string => String(i + 1)
/** WO-176 r2: a permission prompt's option as the channel's Action names it: Claude Code's 「Yes…」 (also 「Yes, and don't ask again…」) allow, 「No…」
 *  deny; anything else null */
export function permOptionOf(o: { button?: string; screen?: string } | undefined): 'allow' | 'deny' | null {
  for (const t of [o?.screen, o?.button]) {
    const x = String(t ?? '').replace(/^\s*[❯›▶>]?\s*\d+\.\s*/, '').trim()
    if (/^(yes\b|allow\b|允許)/i.test(x)) return 'allow'
    if (/^(no\b|deny\b|拒絕)/i.test(x)) return 'deny'
  }
  return null
}
export const optionIndexOf = (id: string): number => /^[1-9]\d?$/.test(id) ? Number(id) - 1 : -1
const ACTION_LABEL = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 80)
/** the ask's text as an Action body (markdown): the screen lines in a code block */
export function askBody(text: string): string {
  const cut = text.indexOf('\n\n— 畫面最後幾行 —\n')
  if (cut < 0) return text
  const fence = (s: string) => '```\n' + s.replace(/```/g, "'''") + '\n```'
  const rest = text.slice(cut + '\n\n— 畫面最後幾行 —\n'.length)
  const tool = rest.indexOf('\n\n— 等待中的工具呼叫 —\n')
  return tool < 0 ? `${text.slice(0, cut)}\n\n畫面最後幾行：\n${fence(rest)}`
    : `${text.slice(0, cut)}\n\n畫面最後幾行：\n${fence(rest.slice(0, tool))}\n\n等待中的工具呼叫：\n${fence(rest.slice(tool + '\n\n— 等待中的工具呼叫 —\n'.length))}`
}
type Look = { state: State; hash: string; lines: string[]; info: PaneInfo; pane: string } | null

export class DutyOfficer {
  readonly dir: string
  readonly host: string
  readonly L: Limits
  private readonly home: string
  private readonly rulesDirs: string[]
  private readonly extra: Set<string>
  private readonly st = new Map<string, PaneState>()
  private readonly busy = new Set<string>()
  private readonly asks = new Map<string, Ask>()
  private readonly lookFailed = new Map<string, number>()
  private readonly labels = new Map<string, string>()
  private cfgCache: { mtime: number; cfg: Config } = { mtime: -1, cfg: NO_CONFIG }
  private enabledNow = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(private readonly d: OfficerDeps, o: OfficerOpts = {}) {
    this.home = o.home ?? homedir()
    this.dir = o.dir ?? join(this.home, '.claude', 'duty-officer')
    this.host = o.host ?? hostname().split('.')[0]
    this.L = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) }
    this.extra = new Set(o.extraClaude ?? [])
    this.rulesDirs = o.rulesDirs ?? [
      ...(process.env.DUTY_OFFICER_RULES_DIR ? [process.env.DUTY_OFFICER_RULES_DIR] : []),
      join(this.home, 'Development', 'Joey-Crablabs-Skills', 'duty-officer'),
      join(this.home, 'cc-workspaces', 'claude-chiron', 'tools', 'menu_aide'),
    ]
    for (const sub of ['', 'claims', 'ask', 'calls']) { try { mkdirSync(join(this.dir, sub), { recursive: true }) } catch {} }
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now() }
  private sleep(ms: number): Promise<void> { return this.d.sleep ? this.d.sleep(ms) : new Promise(r => setTimeout(r, ms)) }

  // ---- config, claims, budget, log
  config(): Config {
    const p = join(this.dir, 'config.json')
    let m = -2
    try { m = statSync(p).mtimeMs } catch {}
    if (m !== this.cfgCache.mtime) {
      let cfg: Config = NO_CONFIG
      if (m >= 0) {
        try {
          const j = JSON.parse(readFileSync(p, 'utf8'))
          cfg = {
            enabled: j.enabled === '*' ? '*' : Array.isArray(j.enabled) ? j.enabled.map(String) : [],
            dry_keys: j.dry_keys === true,
            test_targets: j.test_targets && typeof j.test_targets === 'object' ? j.test_targets : {},
            test_recipients: Array.isArray(j.test_recipients) ? j.test_recipients.map(String) : [],
            test_rulings_to: typeof j.test_rulings_to === 'string' && j.test_rulings_to.trim() ? j.test_rulings_to.trim() : null,
            claude_cmds: Array.isArray(j.claude_cmds) ? j.claude_cmds.map(String) : [],
            fallback_model: j.fallback_model === null || j.fallback_model === '' ? null
              : typeof j.fallback_model === 'string' ? j.fallback_model : FALLBACK_MODEL,
          }
        } catch (e) { this.d.log('warn', `duty-officer: config.json unreadable (${String(e).slice(0, 80)}) — off`) }
      }
      this.cfgCache = { mtime: m, cfg }
    }
    return this.cfgCache.cfg
  }
  private isEnabled(t: Target, cfg: Config): boolean {
    return cfg.enabled === '*' || cfg.enabled.includes(t.tmux) || cfg.enabled.includes(t.label)
  }
  /** The switch as it is right now (config.json re-read). Checked again before judging, after the model answers
   *  and right before any key is pressed: switching off stops a press that is already on its way. */
  stillOn(tmux: string): boolean {
    const cfg = this.config()
    if (Object.prototype.hasOwnProperty.call(cfg.test_targets, tmux)) return true
    const label = this.labels.get(tmux)
    return cfg.enabled === '*' || cfg.enabled.includes(tmux) || (!!label && cfg.enabled.includes(label))
  }
  /** Someone is at that terminal: an attached tmux client pressed a key within attendedMs. */
  async attended(tmux: string): Promise<number | null> {
    const a = await this.d.tmux.clientActivity(tmux).catch(() => null)
    return a != null && this.now() - a < this.L.attendedMs ? a : null
  }
  /** True when this daemon's duty officer is watching that pane (the old startup-picker steps aside). */
  handles(tmux: string): boolean { return this.enabledNow.has(tmux) }

  private claimPath(tmux: string) { return join(this.dir, 'claims', tmux.replace(/[^A-Za-z0-9._-]/g, '_')) }
  /** Claim the pane for this process unless another live process holds a fresh claim. */
  claim(tmux: string): boolean {
    const p = this.claimPath(tmux)
    try {
      const st = statSync(p)
      const pid = parseInt(readFileSync(p, 'utf8'), 10)
      if (pid && pid !== process.pid && Date.now() - st.mtimeMs < this.L.claimFreshMs) {
        try { process.kill(pid, 0); return false } catch {}
      }
    } catch {}
    try { writeFileSync(p, String(process.pid)) } catch {}
    return true
  }
  private release(tmux: string) {
    const p = this.claimPath(tmux)
    try { if (parseInt(readFileSync(p, 'utf8'), 10) === process.pid) unlinkSync(p) } catch {}
  }
  /** Machine-wide budget, shared by every daemon on this machine: one file per call, `<ms>-<rand>-<tmux>`. */
  private budgetOk(tmux: string): boolean {
    const dir = join(this.dir, 'calls')
    const safe = tmux.replace(/[^A-Za-z0-9._-]/g, '_')
    const now = Date.now()
    let mine = 0
    let all = 0
    let names: string[] = []
    try { names = readdirSync(dir) } catch {}
    for (const n of names) {
      const parts = n.split('-')
      const t = parseInt(parts[0], 10)
      if (!t || now - t > 3600_000) { try { unlinkSync(join(dir, n)) } catch {}; continue }
      all++
      if (parts.slice(2).join('-') === safe) mine++
    }
    if (all >= this.L.callsPerHour || mine >= this.L.callsPerTargetHour) return false
    try { writeFileSync(join(dir, `${now}-${randomBytes(2).toString('hex')}-${safe}`), '') } catch {}
    return true
  }
  event(ev: string, kw: Record<string, unknown> = {}): void {
    const p = join(this.dir, 'log.jsonl')
    try { if (statSync(p).size > 20 * 1024 * 1024) renameSync(p, `${p}.1`) } catch {}
    try { appendFileSync(p, JSON.stringify({ time: iso(this.now()), event: ev, host: this.host, pid: process.pid, ...kw }) + '\n') } catch {}
  }

  // ---- rule files (Chiron's; never copied)
  rules(): { prompt: string; rulings: string; dir: string } | null {
    for (const dir of this.rulesDirs) {
      try {
        return { prompt: readFileSync(join(dir, 'aide_prompt.md'), 'utf8'), rulings: readFileSync(join(dir, 'rulings.md'), 'utf8'), dir }
      } catch {}
    }
    return null
  }

  // ---- looking at a pane
  async look(tmux: string): Promise<Look> {
    const [info, pane] = await Promise.all([this.d.tmux.info(tmux), this.d.tmux.capture(tmux)])
    if (!info || pane == null) return null
    try { this.d.onLook?.(tmux, info.cmd, pane) } catch {}
    const lines = tailLines(pane)
    const extra = new Set([...this.extra, ...this.config().claude_cmds])
    return { state: classify(lines, info.cmd, extra), hash: thash(lines), lines, info, pane }
  }

  private async targets(cfg: Config): Promise<Target[]> {
    let ts: Target[] = []
    try { ts = await this.d.listTargets() } catch { return [] }
    const own = new Set(ts.map(t => t.tmux))
    for (const [tmux, owner] of Object.entries(cfg.test_targets)) {
      if (own.has(owner) && !own.has(tmux)) ts.push({ label: `${tmux} (test)`, tmux, projectsDir: null, test: true })
    }
    return ts
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.L.pollMs)
    this.timer.unref?.()
    this.d.log('info', `duty-officer ON (poll=${this.L.pollMs / 1000}s, stall=${this.L.stallMs / 1000}s, switch=${join(this.dir, 'config.json')})`)
    this.cancelOrphans()
  }
  /** WO-176: the questions this daemon's panes had open when it last stopped: their Actions are cancelled (a restarted officer looks at each pane afresh
   *  and asks again if the menu is still there, so the old one would wait in Joey's list for nothing). Telegram is not touched: its buttons work as before */
  cancelOrphans(): number {
    if (!this.d.actions) return 0
    let n = 0
    try {
      const dir = join(this.dir, 'ask'), since = Date.now() - 2 * 86_400_000
      const names = readdirSync(dir).filter(x => /^[0-9a-f]{8}\.json$/.test(x)).map(x => { try { return { x, m: statSync(join(dir, x)).mtimeMs } } catch { return { x, m: 0 } } })
        .filter(f => f.m >= since).sort((a, b) => b.m - a.m).slice(0, 500)
      for (const { x } of names) {
        let a: Ask
        try { a = JSON.parse(readFileSync(join(dir, x), 'utf8')) as Ask } catch { continue }
        // a shared Action (the channel's permission prompt): MenuActions.cancel leaves it alone while the channel still holds it (its restart grace)
        if (a.host !== this.host || a.closed || !a.action_id || a.action_closed || !this.actionPane({ tmux: a.tmux, test: a.test })) continue
        this.actionCall(a, (acts, ref) => acts.cancel(ref, '常駐程式重開了：值班員會重新看這個畫面，還在的話會再問一次'))
        a.action_closed = true
        this.saveAsk(a)
        this.asks.set(a.id, a)
        n++
      }
    } catch {}
    if (n) this.event('actions_cancelled_at_start', { count: n })
    return n
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const cfg = this.config()
      const now = this.now()
      const on = new Set<string>()
      for (const t of await this.targets(cfg)) {
        this.labels.set(t.tmux, t.label)
        if (!this.isEnabled(t, cfg) && !t.test) {
          if (this.enabledNow.has(t.tmux)) this.release(t.tmux)
          continue
        }
        if (!this.claim(t.tmux)) continue
        on.add(t.tmux)
        if (this.busy.has(t.tmux)) continue
        const lk = await this.look(t.tmux)
        if (!lk) {
          // a pane we cannot read is said once an hour, never skipped silently
          const last = this.lookFailed.get(t.tmux) ?? 0
          // (a test pane that was closed is normal: not logged)
          if (!t.test && now - last >= this.L.renotifyMs) { this.lookFailed.set(t.tmux, now); this.event('look_failed', { agent: t.label, tmux: t.tmux }) }
          continue
        }
        await this.step(t, lk, now)
      }
      for (const tmux of this.enabledNow) if (!on.has(tmux)) this.release(tmux)
      this.enabledNow = on
    } catch (e) {
      this.event('error', { where: 'tick', error: String(e).slice(0, 300) })
    } finally {
      this.ticking = false
    }
  }

  private async step(t: Target, lk: NonNullable<Look>, now: number): Promise<void> {
    const { state, hash, lines } = lk
    let s = this.st.get(t.tmux)
    if (!s || s.hash !== hash || s.state !== state) {
      const prevAsk = s?.rec?.askId
      if (prevAsk) void this.closeGone(prevAsk, state)
      s = { hash, state, since: now, rec: null }
      this.st.set(t.tmux, s)
      if (state === 'OTHER') this.event('seen_other', { agent: t.label, tmux: t.tmux, screen_hash: hash })
    }
    if (state !== 'OTHER' || now - s.since < this.L.stallMs) return
    // a raw notice held back by the hourly cap: after the hour, look again (the model may be back)
    if (s.rec?.action === 'suppressed' && now - s.rec.t >= this.L.renotifyMs) s.rec = null
    if (!s.rec) {
      const owner = this.d.owner?.(t, lines) ?? null
      if (owner) {
        s.rec = { action: 'left_to_owner', t: now }
        this.event('left_to_owner', { agent: t.label, tmux: t.tmux, owner, screen_hash: hash, tail: lines })
        return
      }
    }
    if (!s.rec && isRateLimitMenu(lines)) {
      s.rec = { action: 'left_to_modal_guard', t: now }
      this.event('left_to_modal_guard', { agent: t.label, tmux: t.tmux, screen_hash: hash, tail: lines })
      return
    }
    if (!s.rec) {
      // a person at the terminal (Joey on the MBP, or on his phone) may have opened this menu himself or be
      // reading it: not a stall. Nothing is judged, pressed or sent; once nobody has typed for attendedMs, it is.
      const who = await this.attended(t.tmux)
      if (who != null) {
        if (!s.attendedLogged) {
          s.attendedLogged = true
          this.event('attended', { agent: t.label, tmux: t.tmux, screen_hash: hash, last_key_s_ago: Math.round((now - who) / 1000), tail: lines })
        }
        return
      }
      if (!hasHints(lines)) {
        const m = transcriptMtime(t.projectsDir ?? (lk.info.path ? projectDirOf(this.home, lk.info.path) : null))
        if (m != null && Date.now() - m < this.L.stallMs) return // the agent is still writing: not a stall yet
      }
      s.rec = { action: 'pending', t: now }
      this.busy.add(t.tmux)
      this.event('stalled', { agent: t.label, tmux: t.tmux, screen_hash: hash, stalled_s: Math.round((now - s.since) / 100) / 10, tail: lines })
      void this.handle(t, lk, s.since)
      return
    }
    // still the same unanswered question: remind once an hour
    const ask = s.rec.askId ? this.asks.get(s.rec.askId) : undefined
    if (ask && !ask.closed && now - (ask.notified[ask.notified.length - 1] ?? 0) >= this.L.renotifyMs) {
      this.event('renotify', { agent: t.label, tmux: t.tmux, ask: ask.id })
      await this.deliver(ask, `（仍在等你選，${Math.round((now - Date.parse(ask.created)) / 60000)} 分鐘了）\n`)
    }
  }

  async handle(t: Target, lk: NonNullable<Look>, appeared: number, step = 1): Promise<void> {
    try {
      await this.judge(t, lk, appeared, step)
    } catch (e) { // never a silent drop: Joey gets the raw screen
      this.event('error', { agent: t.label, tmux: t.tmux, where: 'handle', error: String(e).slice(0, 300) })
      try { await this.rawAsk(t, lk, `duty officer error: ${String(e).slice(0, 60)}`) } catch (e2) {
        this.event('error', { agent: t.label, tmux: t.tmux, where: 'raw ask after error', error: String(e2).slice(0, 300) })
      }
    } finally {
      this.busy.delete(t.tmux)
    }
  }

  private setRec(tmux: string, hash: string, rec: Rec | null) {
    const s = this.st.get(tmux)
    if (s && s.hash === hash) s.rec = rec
  }

  private async judge(t: Target, lk: NonNullable<Look>, appeared: number, step: number): Promise<void> {
    if (!this.stillOn(t.tmux)) {
      this.event('aborted', { agent: t.label, tmux: t.tmux, step, why: 'switched off before judging', screen_hash: lk.hash })
      this.setRec(t.tmux, lk.hash, null)
      return
    }
    const rules = this.rules()
    if (!rules) { await this.rawAsk(t, lk, 'aide_prompt.md / rulings.md not found'); return }
    const at = this.now()
    let bundle: Record<string, unknown>
    try {
      const screen = await this.d.tmux.capture(t.tmux, SCREEN_LINES)
      bundle = buildBundle({ target: t, at, screen, panePath: lk.info.path || null, rulings: rules.rulings, home: this.home })
    } catch (e) {
      this.event('error', { agent: t.label, tmux: t.tmux, where: 'bundle', error: String(e).slice(0, 300) })
      await this.rawAsk(t, lk, 'could not build the evidence bundle')
      return
    }
    if (!this.budgetOk(t.tmux)) {
      this.event('budget_exceeded', { agent: t.label, tmux: t.tmux, limit: `${this.L.callsPerHour}/h machine, ${this.L.callsPerTargetHour}/h pane` })
      await this.rawAsk(t, lk, 'over the hourly budget', bundle)
      return
    }
    let res = await this.d.model(bundle, rules.prompt, this.L.modelTimeoutMs)
    const fb = this.config().fallback_model
    if (res.meta.refused && fb && this.stillOn(t.tmux)) {
      this.event('model_refused', { agent: t.label, tmux: t.tmux, step, model: res.meta.model ?? MODEL, retry_with: fb, result_head: res.meta.result_head })
      if (this.budgetOk(t.tmux)) res = await this.d.model(bundle, rules.prompt, this.L.modelTimeoutMs, fb)
      else res = { decision: null, meta: { ...res.meta }, fail: `${res.fail}; no budget left for ${fb}` }
    }
    if (!this.stillOn(t.tmux)) { // switched off while the model was thinking: no key, no message
      this.event('aborted', { agent: t.label, tmux: t.tmux, step, why: 'switched off while judging', screen_hash: lk.hash, action: res.decision?.action ?? null })
      this.setRec(t.tmux, lk.hash, null)
      return
    }
    if (await this.attended(t.tmux) != null) { // someone sat down while the model was thinking
      this.event('attended', { agent: t.label, tmux: t.tmux, step, why: 'a person started typing while judging', screen_hash: lk.hash, action: res.decision?.action ?? null })
      this.setRec(t.tmux, lk.hash, null)
      return
    }
    const base = { agent: t.label, tmux: t.tmux, step, seconds: res.meta.seconds, cost: res.meta.cost,
      since_appeared_s: Math.round((this.now() - appeared) / 100) / 10, screen_hash: lk.hash, rules_dir: rules.dir }
    if (res.fail || !res.decision) {
      this.event('model_failed', { ...base, why: res.fail, meta: res.meta })
      await this.rawAsk(t, lk, res.fail ?? 'no decision', bundle)
      return
    }
    const d = res.decision
    if (d.action === 'none') {
      this.event('decision', { ...base, action: 'none', decision: d })
      this.setRec(t.tmux, lk.hash, { action: 'none', t: this.now() })
      return
    }
    if (d.action === 'do') {
      const c = checkDo(d)
      if ('bad' in c) {
        this.event('decision', { ...base, action: 'ask_joey', downgraded_from: 'do', why: c.bad, decision: d })
        await this.askJoey(t, lk, bundle, d, `downgraded from do: ${c.bad}`)
        return
      }
      this.event('decision', { ...base, action: 'do', decision: d })
      await this.press(t, lk, appeared, step, d, c.keys, bundle)
      return
    }
    this.event('decision', { ...base, action: 'ask_joey', decision: d })
    await this.askJoey(t, lk, bundle, d, 'the duty officer asks Joey')
  }

  /** Press `keys` if the screen is still the one that was judged; returns the screen afterwards. */
  private async pressKeys(tmux: string, hash: string, keys: string[], dry: boolean, byJoey = false): Promise<{ ok: false; now: Look; off?: boolean; attended?: boolean } | { ok: true; after: Look; leftMode: boolean; at: number }> {
    if (!this.stillOn(tmux)) return { ok: false, now: null, off: true }
    // Joey's tap on a button is his decision, not the duty officer's: a person at the terminal does not hold it back
    if (!byJoey && await this.attended(tmux) != null) return { ok: false, now: null, attended: true }
    const before = await this.look(tmux)
    if (!before || before.hash !== hash) return { ok: false, now: before }
    if (dry) return { ok: true, after: before, leftMode: false, at: this.now() }
    let leftMode = false
    if (before.info.inMode) { await this.d.tmux.cancelMode(tmux); leftMode = true } // keys would go to copy mode
    const at = this.now()
    for (let i = 0; i < keys.length; i++) {
      if (i) await this.sleep(this.L.keyGapMs)
      await this.d.tmux.sendKey(tmux, KEYMAP[keys[i]])
    }
    await this.sleep(this.L.verifyAfterMs)
    return { ok: true, after: await this.look(tmux), leftMode, at }
  }

  private async press(t: Target, lk: NonNullable<Look>, appeared: number, step: number, d: Decision, keys: string[], bundle: Record<string, unknown>): Promise<void> {
    const dry = this.config().dry_keys
    const bound = !dry && this.actionPane(t, bundle)?.menu_kind === 'permission' ? this.bindPerm(t, bundle) : null
    const r = await this.pressKeys(t.tmux, lk.hash, keys, dry)
    const base = { agent: t.label, tmux: t.tmux, step, choose: d.choose, keys, screen_hash: lk.hash }
    if (!r.ok && r.off) {
      this.event('aborted', { ...base, why: 'switched off before pressing' })
      this.setRec(t.tmux, lk.hash, null)
      return
    }
    if (!r.ok && r.attended) {
      this.event('attended', { ...base, why: 'a person started typing before pressing' })
      this.setRec(t.tmux, lk.hash, null)
      return
    }
    if (!r.ok) {
      this.event('aborted', { ...base, why: 'screen changed before pressing', before_tail: lk.lines, now_tail: r.now?.lines ?? null })
      this.setRec(t.tmux, lk.hash, null) // the loop looks at whatever is showing now
      return
    }
    if (dry) {
      this.event('pressed', { ...base, dry_keys: true, resolved: null })
      this.setRec(t.tmux, lk.hash, { action: 'do(dry)', t: this.now() })
      return
    }
    const a = r.after
    if (!a) {
      this.event('pressed', { ...base, pressed_at: iso(r.at), appeared_to_press_s: Math.round((r.at - appeared) / 100) / 10, resolved: null, why: 'pane gone after pressing' })
      this.setRec(t.tmux, lk.hash, { action: 'do', t: this.now(), resolved: null })
      return
    }
    const resolved = a.state === 'IDLE' || a.state === 'WORKING' || a.hash !== lk.hash
    this.event('pressed', { ...base, pressed_at: iso(r.at), appeared_to_press_s: Math.round((r.at - appeared) / 100) / 10,
      left_copy_mode: r.leftMode, before_tail: lk.lines, after_tail: a.lines, after_state: a.state, resolved, to_joey_draft: d.to_joey })
    this.setRec(t.tmux, lk.hash, { action: 'do', t: this.now(), resolved })
    if (resolved && bound && typeof bound === 'object') await this.d.actions?.permissionGone?.(bound)
    if (!resolved) {
      await this.askJoey(t, lk, bundle, d, 'pressed the keys, the screen did not change', keys)
      return
    }
    if (a.state !== 'OTHER') return
    // a different screen that is neither idle nor working: maybe a follow-up dialog
    const end = this.now() + this.L.settleMaxMs
    let cur = a
    let since = this.now()
    while (this.now() < end) {
      await this.sleep(1000)
      const x = await this.look(t.tmux)
      if (!x || x.state !== 'OTHER') return
      if (x.hash !== cur.hash) { cur = x; since = this.now(); continue }
      if (this.now() - since >= this.L.stallMs) {
        this.st.set(t.tmux, { hash: x.hash, state: 'OTHER', since, rec: { action: 'pending', t: this.now() } })
        if (step >= this.L.maxChain) {
          this.event('chain_limit', { agent: t.label, tmux: t.tmux, step, tail: x.lines })
          await this.rawAsk(t, x, `${this.L.maxChain} chained dialogs already answered`)
          return
        }
        this.event('follow_up', { agent: t.label, tmux: t.tmux, step: step + 1, screen_hash: x.hash })
        await this.judge(t, x, since, step + 1)
        return
      }
    }
    // never settled: the main loop picks it up as a fresh stall
  }

  // ---- asking Joey
  private newAsk(t: Target, lk: NonNullable<Look>, kind: Ask['kind'], reason: string, text: string, options: Ask['options'], d: Decision | null,
    bundle?: Record<string, unknown>): Ask {
    const ask: Ask = { id: randomBytes(4).toString('hex'), tmux: t.tmux, label: t.label, host: this.host, hash: lk.hash,
      created: iso(this.now()), kind, ...(t.test ? { test: true } : {}), reason, text, options, decision: d, screen_tail: redact(lk.lines.join('\n')), messages: [], notified: [] }
    // WO-176: this pane's menus are this agent's Actions: the ask gets one (made when it is first sent)
    const pane = this.actionPane(t, bundle)
    if (pane) Object.assign(ask, { action_key: `menu:${this.host}:ask:${ask.id}`, menu_kind: pane.menu_kind, session_id: pane.session_id })
    if (pane?.menu_kind === 'permission') { const b = this.bindPerm(t, bundle); if (b != null) ask.perm_bind = b }   // r4: the prompt it is asking about
    this.asks.set(ask.id, ask)
    return ask
  }
  private actionPane(t: { tmux: string; test?: boolean }, bundle?: Record<string, unknown>): { session_id: string | null; menu_kind: string | null } | null {
    if (!this.d.actions) return null
    try { return this.d.actions.pane(t, bundle) } catch { return null }
  }
  private bindPerm(t: { tmux: string; test?: boolean }, bundle?: Record<string, unknown>): PermBinding {
    if (!this.d.actions?.bindPermission) return null
    try { return this.d.actions.bindPermission(t, bundle) ?? null } catch { return 'unsure' }
  }
  private saveAsk(a: Ask) {
    try { writeFileSync(join(this.dir, 'ask', `${a.id}.json`), JSON.stringify(a, null, 1)) } catch {}
  }
  loadAsk(id: string): Ask | null {
    if (!/^[0-9a-f]{8}$/.test(id)) return null
    const m = this.asks.get(id)
    if (m) return m
    try {
      const a = JSON.parse(readFileSync(join(this.dir, 'ask', `${id}.json`), 'utf8')) as Ask
      this.asks.set(id, a)
      return a
    } catch { return null }
  }
  private keyboard(a: Ask): Button[][] | null {
    const rows = a.options.map((o, i) => o.keys ? [{ text: o.button.slice(0, 60), callback_data: `duty:${a.id}:${i}` }] : null).filter(Boolean) as Button[][]
    return rows.length ? rows : null
  }
  private chatsFor(a: Ask): string[] {
    const cfg = this.config()
    return a.test && cfg.test_recipients.length ? cfg.test_recipients : this.d.recipients()
  }
  /** Who may answer: the people the question went to (a test question: its test recipients too). */
  mayAnswer(data: string, sender: string): boolean {
    const a = this.loadAsk(data.split(':')[1] ?? '')
    if (a?.test && this.config().test_recipients.includes(sender)) return true
    return this.d.recipients().includes(sender)
  }
  private async deliver(a: Ask, prefix = ''): Promise<void> {
    const chats = this.chatsFor(a)
    const sent = chats.length ? await this.d.send(chats, prefix + a.text, this.keyboard(a)) : []
    a.messages.push(...sent)
    a.notified.push(this.now())
    this.saveAsk(a)
    this.event('notified', { agent: a.label, tmux: a.tmux, ask: a.id, kind: a.kind, to: sent.map(s => s.chat), messages: sent.map(s => s.msg), reminder: !!prefix })
    if (!prefix) await this.openAction(a, chats)
  }
  /** WO-176: the ask as an open Action in Onsen: its options with keys (the buttons Telegram shows), assigned to the people it went to */
  private async openAction(a: Ask, chats: string[]): Promise<void> {
    const acts = this.d.actions
    if (!acts || !a.action_key || a.action_id) return
    try { a.assignees = acts.assignees(chats) } catch {}                  // WO-180: whom it asked (a status blocker's assignee once the Action is there)
    // WO-176 r2: a question about a permission prompt the channel already made an Action for uses that Action (one per prompt on the screen), with the
    // people it asks joined to it
    if (a.menu_kind === 'permission' && acts.shared) {
      let sh: { key: string; id?: string; version?: number } | null = null
      try {
        sh = await acts.shared({ tmux: a.tmux, test: a.test }, 'permission', acts.assignees(chats), version => {
          if (a.action_shared && version > (a.action_version ?? 0)) { a.action_version = version; this.saveAsk(a) }
        }, a.perm_bind ?? null)
      } catch {}
      if (sh) {
        Object.assign(a, { action_key: sh.key, action_shared: 'permission', ...(sh.id ? { action_id: sh.id } : {}), ...(sh.version ? { action_version: sh.version } : {}) })
        this.saveAsk(a)
        this.event('action', { agent: a.label, tmux: a.tmux, ask: a.id, action_id: sh.id ?? null, shared: 'permission' })
        return
      }
    }
    const options = a.options.map((o, i) => o.keys ? { id: optionIdOf(i), label: ACTION_LABEL(o.button) || optionIdOf(i) } : null)
      .filter((o): o is { id: string; label: string } => !!o).slice(0, 10)
    if (!options.length) { this.event('action_skipped', { agent: a.label, tmux: a.tmux, ask: a.id, why: 'no option with keys' }); return }
    const summary = a.kind === 'ask_joey' && a.decision?.what ? `${a.label}：${a.decision.what}` : `${a.label} 停在一個要按鍵的畫面，值班員判斷不了（${a.reason}）`
    try {
      acts.open({ menu_kind: a.menu_kind ?? null, session_id: a.session_id ?? null, assignees: acts.assignees(chats), summary, body: askBody(a.text), options },
        a.action_key, (id, version) => {
          a.action_id = id; a.action_version = version
          this.saveAsk(a)
          this.event('action', { agent: a.label, tmux: a.tmux, ask: a.id, action_id: id })
        })
    } catch (e) { this.event('error', { agent: a.label, tmux: a.tmux, where: 'action open', error: String(e).slice(0, 200) }) }
  }
  private refOf(a: Ask): ActionRef | null {
    return a.action_key ? { key: a.action_key, ...(a.action_id ? { id: a.action_id } : {}), ...(a.action_version ? { version: a.action_version } : {}) } : null
  }
  private actionCall(a: Ask, fn: (acts: MenuActions, ref: ActionRef) => void): void {
    const acts = this.d.actions, ref = this.refOf(a)
    if (!acts || !ref) return
    try { fn(acts, ref) } catch (e) { this.event('error', { agent: a.label, tmux: a.tmux, where: 'action', error: String(e).slice(0, 200) }) }
  }
  /** WO-176: the ask whose Action this is (this process's, else the ask files of the last two days); null: none */
  askOfAction(actionId: string): Ask | null {
    // several asks may name one shared Action (a question before a restart, and the one asked again after it): the open one, newest
    const rank = (a: Ask): number => (a.closed || a.action_closed ? 0 : 2) + (a.host === this.host ? 1 : 0)
    let had: Ask | null = null
    for (const a of this.asks.values()) if (a.action_id === actionId && (!had || rank(a) > rank(had) || (rank(a) === rank(had) && a.created > had.created))) had = a
    if (had && !had.closed && !had.action_closed) return had
    let names: Array<{ n: string; m: number }> = []
    try {
      const dir = join(this.dir, 'ask'), since = Date.now() - 2 * 86_400_000
      names = readdirSync(dir).filter(n => /^[0-9a-f]{8}\.json$/.test(n)).map(n => { try { return { n, m: statSync(join(dir, n)).mtimeMs } } catch { return { n, m: 0 } } })
        .filter(x => x.m >= since).sort((x, y) => y.m - x.m).slice(0, 500)
    } catch {}
    for (const { n } of names) {
      const id = n.slice(0, 8)
      if (this.asks.has(id)) continue
      try {
        const a = JSON.parse(readFileSync(join(this.dir, 'ask', n), 'utf8')) as Ask
        if (a.action_id === actionId && a.host === this.host) { this.asks.set(a.id, a); if (!a.closed && !a.action_closed) return a; had ??= a }
      } catch {}
    }
    return had
  }
  /** WO-176: the newest ask still open on this pane with an Action for this menu (a status blocker's action_id); null: none */
  openActionFor(tmux: string, menu: string | null): string | null { return this.openAsk(tmux, menu)?.action_id ?? null }
  /** WO-180 (Chiron 04:42Z, 1): the officer asked a person about the menu on this pane: that question's Action and the first person it went to (a
   *  status blocker's assignee and action_id from then on); null: it asked nobody (the menu is the officer's own) */
  openAskFor(tmux: string, menu: string | null): { action_id: string; assignee: string | null } | null {
    const a = this.openAsk(tmux, menu)
    if (!a?.action_id) return null
    let who = a.assignees
    if (!who?.length) { try { who = this.d.actions?.assignees(this.chatsFor(a)) } catch {} }   // an ask written before WO-180 kept no assignees
    return { action_id: a.action_id, assignee: who?.[0] ?? null }
  }
  private openAsk(tmux: string, menu: string | null): Ask | null {
    let best: Ask | null = null
    for (const a of this.asks.values()) {
      if (a.tmux !== tmux || a.closed || a.action_closed || !a.action_id) continue
      if (menu && a.menu_kind && a.menu_kind !== menu) continue
      if (!best || a.created >= best.created) best = a
    }
    return best
  }

  private screenBlock(lines: string[], bundle?: Record<string, unknown>): string {
    let s = `\n\n— 畫面最後幾行 —\n${redact(lines.join('\n'))}`
    const p = bundle?.pending_tool_call as any
    if (p) s += `\n\n— 等待中的工具呼叫 —\n${p.tool}（${p.source}，等了 ${p.waiting_for}）${clip(redact(JSON.stringify(p.input)), 400)}`
    return s
  }

  private async askJoey(t: Target, lk: NonNullable<Look>, bundle: Record<string, unknown>, d: Decision, reason: string, pressed?: string[]): Promise<void> {
    const options = (d.options ?? []).map(o => ({ button: String(o.button ?? '').trim() || String(o.on_screen ?? '?').slice(0, 20), keys: fixedKeys(o.keys), means: o.means,
      ...(o.on_screen ? { screen: String(o.on_screen).slice(0, 120) } : {}) }))
    const typing = options.filter(o => !o.keys).map(o => o.button)
    // to_joey is the note for Joey only when the duty officer chose ask_joey; for a `do` that was downgraded
    // it is a one-line draft, so Joey gets what / why / the recommendation instead
    const note = d.action === 'ask_joey' && String(d.to_joey ?? '').trim()
      ? String(d.to_joey).trim()
      : `${t.label}：${d.what}\n${d.why_now}\n沒人答會怎樣：${d.if_nobody_answers}\n建議選「${d.choose}」：${d.reason}`
    let text = `${note}\n\n（值班員・${t.label}・${this.host}）`
    if (pressed) text += `\n我先按了 ${pressed.join(' ')}，畫面沒變，所以轉給你。`
    if (typing.length) text += `\n要打字的選項沒有按鈕（${typing.join('、')}）：要選它的話跟 ${t.label} 說。`
    text += this.screenBlock(lk.lines, bundle)
    const ask = this.newAsk(t, lk, 'ask_joey', reason, text.slice(0, 3900), options, d, bundle)
    this.setRec(t.tmux, lk.hash, { action: 'ask_joey', t: this.now(), askId: ask.id })
    await this.deliver(ask)
  }

  /** One raw notice per machine per hour (Chiron btcc 9583): when the model is unreachable every pane fails at
   *  once, and Joey should get one message, not one per agent. Shared by every daemon through a file's mtime. */
  private rawSlot(): boolean {
    const p = join(this.dir, 'raw-last')
    try { if (Date.now() - statSync(p).mtimeMs < this.L.renotifyMs) return false } catch {}
    try { writeFileSync(p, `${process.pid} ${iso(Date.now())}`) } catch {}
    return true
  }

  private async rawAsk(t: Target, lk: NonNullable<Look>, why: string, bundle?: Record<string, unknown>): Promise<void> {
    if (!t.test && !this.rawSlot()) {
      this.event('raw_suppressed', { agent: t.label, tmux: t.tmux, why, screen_hash: lk.hash, tail: lk.lines })
      this.setRec(t.tmux, lk.hash, { action: 'suppressed', t: this.now() })
      return
    }
    const menu = numberedMenu(lk.pane)
    let text = `${t.label} 停在一個要按鍵的畫面，值班員判斷不了（${why}），要你決定。\n這台（${this.host}）接下來一小時其他停住的畫面不再一則一則通知，紀錄在 ~/.claude/duty-officer/log.jsonl。\n\n（值班員・${t.label}・${this.host}）`
    text += menu ? '\n下面的按鈕照畫面上的選項排，按了我才送鍵。' : '\n畫面上沒有能直接按的編號選項：要處理的話跟它說，或找 Epeius。'
    text += this.screenBlock(lk.lines, bundle)
    const ask = this.newAsk(t, lk, 'unreadable', why, text.slice(0, 3900), (menu ?? []).map(m => ({ button: m.button, keys: m.keys })), null, bundle)
    this.setRec(t.tmux, lk.hash, { action: 'unreadable', t: this.now(), askId: ask.id })
    await this.deliver(ask)
  }

  private async closeGone(id: string, state: State): Promise<void> {
    const a = this.loadAsk(id)
    if (!a || a.action_closed || (a.closed && a.closed.via !== 'telegram')) return
    a.closed ??= { how: 'gone', at: iso(this.now()), result: state }
    a.action_closed = true
    this.saveAsk(a)
    this.event('ask_gone', { agent: a.label, tmux: a.tmux, ask: a.id, now_state: state })
    this.actionCall(a, (acts, ref) => acts.cancel(ref, PRESSED_ELSEWHERE))
    for (const m of a.messages) {
      await this.d.edit(m, fit(a.text, `\n\n— 不用選了：畫面已經離開這個選單（${hmz(this.now())}，現在${state === 'IDLE' ? '閒著' : state === 'WORKING' ? '在做事' : '在啟動'}）。`)).catch(() => {})
    }
  }

  /** Joey tapped `duty:<id>:<idx>`. Returns the short text for the tap's toast. `member` (WO-176): his Onsen member name, for the Action */
  async onTap(data: string, by: string, member: string | null = null): Promise<string> {
    const [, id, idxRaw] = data.split(':')
    const a = id ? this.loadAsk(id) : null
    const idx = parseInt(idxRaw ?? '', 10)
    if (!a) return '這個選單的紀錄不在了，沒有按。'
    if (a.closed) return a.closed.how === 'answered' ? `已經處理過了（${a.closed.by} 選了「${a.closed.choice}」）。` : '畫面已經離開這個選單，不用選了。'
    const opt = a.options[idx]
    if (!opt || !opt.keys) return '這個選項沒有對應的按鍵，沒有按。'
    if (this.busy.has(a.tmux)) return '值班員正在處理這個畫面，幾秒後再按一次。'
    return (await this.answer(a, idx, by, member, 'telegram')).result
  }

  /** Execute the control for an open ask. Only a choice executed for Onsen can complete its control Item. */
  async onOnsen(actionId: string, optionId: string, version: number, by: Promise<string | null> | null = null, applied?: () => void): Promise<string> {
    const a = this.askOfAction(actionId)
    if (!a) return 'unknown'
    if (version > (a.action_version ?? 0)) a.action_version = version
    if (a.action_closed && !a.closed) { this.actionCall(a, (acts, ref) => acts.cancel(ref, '常駐程式重開過，這個選單已經重新判斷，沒有按')); return 'gone' }
    const settled = async (): Promise<string | null> => {
      if (!a.closed) return null
      if (a.closed.via === 'onsen' && a.closed.how === 'answered' && a.closed.option_id) {
        this.actionCall(a, (acts, ref) => acts.applied(ref, { option_id: a.closed!.option_id, ...(a.closed!.member ? { resolved_by: a.closed!.member } : {}) }))
        applied?.()
        return `answered in onsen before (${a.closed.option_id})`
      }
      if (a.closed.how === 'answered' && !a.action_closed) {
        const pane = await this.look(a.tmux)
        if (!pane || pane.hash === a.hash) return 'gone'
        a.action_closed = true
        this.saveAsk(a)
      }
      this.actionCall(a, (acts, ref) => acts.cancel(ref, PRESSED_ELSEWHERE))
      return 'gone'
    }
    const done = await settled()
    if (done) return done
    const idx = a.action_shared ? a.options.findIndex(o => !!o.keys && permOptionOf(o) === optionId) : optionIndexOf(optionId)
    if (!a.options[idx]?.keys) { this.actionCall(a, (acts, ref) => acts.cancel(ref, `選項 ${optionId} 沒有對應的按鍵，沒有按`)); return 'no such option' }
    for (let i = 0; i < 80 && this.busy.has(a.tmux); i++) await this.sleep(250)   // the officer is judging or pressing this pane: wait for it (20 s)
    const later = await settled()
    if (later) return later
    if (this.busy.has(a.tmux)) { this.actionCall(a, (acts, ref) => acts.cancel(ref, '值班員正在處理這個畫面，沒有按')); return 'busy' }
    const who = (by ?? Promise.resolve(null)).then(x => x || 'Onsen', () => 'Onsen')
    const out = await this.answer(a, idx, who, null, 'onsen')
    if (out.off) this.actionCall(a, (acts, ref) => acts.cancel(ref, '值班員已經關掉，沒有按'))
    if (a.closed?.how === 'answered' && a.closed.option_id) applied?.()
    return out.result
  }

  /** WO-176 r2: the Action option an ask's option is: its index + 1; a shared permission Action's allow / deny (null: neither) */
  private actionOptionOf(a: Ask, idx: number): string | null { return a.action_shared ? permOptionOf(a.options[idx]) : optionIdOf(idx) }
  private closedOption(a: Ask, idx: number): { option_id?: string } { const o = this.actionOptionOf(a, idx); return o ? { option_id: o } : {} }

  /** press option `idx` of an ask for a person (a tap, or a press in Onsen), edit every copy, tell Onsen. The caller checked it is open and has keys */
  private async answer(a: Ask, idx: number, by: string | Promise<string>, member: string | null, via: 'telegram' | 'onsen'): Promise<{ result: string; off?: boolean }> {
    const opt = a.options[idx]!
    this.busy.add(a.tmux)
    try {
      const r = await this.pressKeys(a.tmux, a.hash, opt.keys!, false, true)
      const who = typeof by === 'string' ? by : await by
      if (via === 'onsen') member = who === 'Onsen' ? null : who
      let result: string
      let afterTail = ''
      if (!r.ok && r.off) {
        this.event('joey_tap_off', { agent: a.label, tmux: a.tmux, ask: a.id, by: who, choice: opt.button, via })
        return { result: '值班員已經關掉，沒有按。', off: true }
      }
      if (!r.ok) {
        result = '畫面已經變了，沒有按'
        afterTail = r.now ? r.now.lines.slice(-8).join('\n') : '（看不到畫面）'
        this.event('joey_tap_stale', { agent: a.label, tmux: a.tmux, ask: a.id, by: who, choice: opt.button, via, now_tail: r.now?.lines ?? null })
        a.closed = { how: 'gone', at: iso(this.now()), by: who, choice: opt.button, result, ...this.closedOption(a, idx), member, via }
        this.actionCall(a, (acts, ref) => acts.cancel(ref, PRESSED_ELSEWHERE))
      } else {
        const x = r.after
        const resolved = !!x && (x.state === 'IDLE' || x.state === 'WORKING' || x.hash !== a.hash)
        result = !x ? '按了，之後看不到畫面（可能重開了）' : resolved ? '按了，畫面已經往下走' : '按了，但畫面沒變'
        afterTail = x ? x.lines.slice(-8).join('\n') : ''
        this.event('joey_answered', { agent: a.label, tmux: a.tmux, ask: a.id, by: who, choice: opt.button, keys: opt.keys, via, resolved, after_state: x?.state ?? null, after_tail: x?.lines ?? null })
        a.closed = { how: 'answered', at: iso(this.now()), by: who, choice: opt.button, result, ...this.closedOption(a, idx), member, via }
        if (x) this.st.set(a.tmux, { hash: x.hash, state: x.state, since: this.now(), rec: resolved ? null : { action: 'joey', t: this.now(), askId: a.id } })
        void this.mailRuling(a, opt.button, result, afterTail)
        const at = iso(r.at), oid = this.actionOptionOf(a, idx)
        if (via === 'onsen' && oid != null) {
          this.actionCall(a, (acts, ref) => acts.applied(ref, { at, ...(a.action_shared ? { option_id: oid } : {}) }))
        } else if (resolved) {
          a.action_closed = true
          this.actionCall(a, (acts, ref) => acts.cancel(ref, PRESSED_ELSEWHERE))
        }
      }
      this.saveAsk(a)
      const end = via === 'onsen' ? '\n從 Onsen 按的' : ''
      for (const m of a.messages) {
        await this.d.edit(m, fit(a.text, `\n\n— ${who} 選了「${opt.button}」（${hmz(this.now())}）：${result}。${afterTail ? `\n\n— 之後的畫面 —\n${redact(afterTail)}` : ''}${end}`)).catch(() => {})
      }
      return { result }
    } finally {
      this.busy.delete(a.tmux)
    }
  }

  private async mailRuling(a: Ask, choice: string, result: string, afterTail: string): Promise<void> {
    const what = (a.decision?.what ?? a.reason).replace(/\s+/g, ' ')
    const title = `裁決：${a.label}｜${what}`.slice(0, 50)
    const opts = a.options.map(o => `- ${o.button}${o.means ? `：${o.means}` : ''}${o.keys ? '' : '（要打字，沒給按鈕）'}`).join('\n')
    const body = [
      `Joey 在 ${a.label}（${a.host}）的畫面上選了「${choice}」，${result}。由你決定要不要寫進 rulings.md。`,
      `\n畫面（判斷時）：\n${a.screen_tail}`,
      `\n選項：\n${opts}`,
      a.decision ? `\n值班員的判斷：${a.decision.what}\n為什麼現在跳：${a.decision.why_now}\n沒人答會怎樣：${a.decision.if_nobody_answers}\n適用的規矩：${a.decision.covered_by ?? '（沒有）'}\n建議：${a.decision.choose}（${a.decision.reason}）` : `\n值班員沒判斷（${a.reason}），Joey 看原畫面選的。`,
      afterTail ? `\n按完的畫面：\n${redact(afterTail)}` : '',
      `\n紀錄：${a.host}:~/.claude/duty-officer/ask/${a.id}.json`,
    ].join('\n').slice(0, 3400)
    let r: string
    const to = a.test ? (this.config().test_rulings_to ?? undefined) : undefined
    try { r = await this.d.mail(a.test ? `（測試）${title}`.slice(0, 50) : title, body, to) } catch (e) { r = `failed: ${String(e).slice(0, 120)}` }
    this.event('ruling_mailed', { agent: a.label, tmux: a.tmux, ask: a.id, result: r })
    if (!/^#\d+/.test(r)) {
      try { appendFileSync(join(this.dir, 'rulings-unsent.jsonl'), JSON.stringify({ time: iso(this.now()), title, body }) + '\n') } catch {}
    }
  }
}

export const isDutyCallback = (data: string) => /^duty:[0-9a-f]{8}:\d{1,2}$/.test(data)

/** Telegram's limit is 4096: keep the suffix (the result) whole and cut the original text. */
export function fit(base: string, suffix: string, max = 4000): string {
  return base.length + suffix.length <= max ? base + suffix : base.slice(0, Math.max(0, max - suffix.length - 1)) + '…' + suffix
}
