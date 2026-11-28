// Codex receives Onsen Items when a worker and its thread are free. Its answers and
// files are sent before the terminal claim report. Sessions and running children survive a restart.
import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs'
import { promisify } from 'node:util'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, join, relative } from 'node:path'
import { Claims } from '../onsen-claims.ts'
import { OnsenClient, refusedForGood } from '../onsen-client.ts'
import { ItemPeek, itemRef, type InboxItem } from '../onsen-items.ts'
import { ItemReceiver } from '../onsen-receive.ts'
import { TakeMode, machineName } from '../onsen-take.ts'
import { ObservationPut } from '../onsen-observation.ts'
import type { Observation } from '../screen-status.ts'

// ------------------------------------------------------------------ configuration
export const ROLE = '外部模型（OpenAI Codex CLI）：審設計、寫程式、生圖'
export const DISPLAY_NAME = 'Codex'
export const TOOL = 'codex exec'
const SEND_TEXT_MAX = 4000            // Onsen /send payload.text
const RESULT_ATTACH_AT = 3500         // an answer longer than this goes along whole as a file (the body keeps room for the notes)
const SAY_MAX = 100_000               // an answer recorded in Joey's conversation (Onsen keeps up to 200 000)

export type Cfg = {
  agent: string; base: string; credentialFile: string; host: string; root: string; stateDir: string; logFile: string
  codexBin: string; sandbox: string; max: number; timeoutMs: number; killGraceMs: number; waitS: number
  maxFiles: number; maxFileBytes: number; retryMs: number; adoptPollMs: number
  /** Codex's own home (CODEX_HOME for the child) and the HOME it runs with; null: the inherited ones (CODEX_RUNNER_CODEX_HOME=inherit) */
  codexHome: string | null; childHome: string | null
  /** --setup: the personal Codex home whose login (auth.json) is linked */
  authFrom: string
  /** the runner's own model and reasoning effort (CODEX_RUNNER_MODEL / CODEX_RUNNER_EFFORT), given to every run; null: Codex's own home's
   *  config.toml decides. Never the personal config's (Chiron mesh 13227; Joey TG chiron:2884 「開發任務你多分一些給 codex 的頂級模型」) */
  model: string | null; effort: string | null
  /** the effort of a #dev item (Chiron #200750: max; CODEX_RUNNER_DEV_EFFORT): the ordinary calls keep `effort` */
  devEffort: string | null
  /** #dev items (Chiron mesh 13257): their own time limit (CODEX_RUNNER_DEV_TIMEOUT_S, 3600), the repo names that stand for a local path
   *  (CODEX_RUNNER_DEV_REPOS name=path,…; an absolute path to any local git repo works too), the throwaway PostgreSQL the brief names */
  devTimeoutMs: number; devRepos: Record<string, string>; devPg: string
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void; now?: () => number; heartbeatMs?: number; declareRetryMs?: number
}
/** the #dev repo shortcuts: name → local path (Chiron mesh 13257: a shortcut, never a list that refuses the others) */
export function devRepos(v: string | undefined, home: string): Record<string, string> {
  const out: Record<string, string> = {
    'bt-control-center': join(home, 'bt-control-center'),
    'fleet-core': join(home, 'cc-workspaces', 'claude-epeius', 'repos', 'fleet-core'),
    'crab-labs-plugins': join(home, 'cc-workspaces', 'claude-epeius', 'repos', 'crab-labs-plugins'),   // a full clone: the live checkout is shallow
    'Joey-Crablabs-Skills': join(home, 'Development', 'Joey-Crablabs-Skills'),
  }
  for (const part of (v ?? '').split(',')) {
    const m = /^\s*([A-Za-z0-9._-]+)\s*=\s*(\/[^,]+?)\s*$/.exec(part)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}
/** `#dev repo=<name or /abs/path> [branch=<name>]` on the first line the caller wrote → what it asks for; null: not a dev item. A Call sent with
 *  send_to_agent starts with the line the mesh adds (「因為：…」), so that line and blank ones are skipped (Chiron mesh 13262: Call 774) */
export function devAsk(text: string): { repo: string; branch: string | null } | null {
  const first = text.split('\n').map(l => l.trim()).find(l => l && !/^(因為|因为|because)\s*[:：]/i.test(l)) ?? ''
  if (!/^#dev\b/.test(first)) return null
  const repo = /\brepo=(\S+)/.exec(first)?.[1] ?? ''
  const branch = /\bbranch=([A-Za-z0-9._\/-]{1,100})/.exec(first)?.[1] ?? null
  return { repo, branch }
}
const num = (v: string | undefined, d: number): number => { const n = Number(v); return v != null && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : d }
/** the reasoning efforts the Codex CLI lists (models_cache.json, CLI 0.169.0: low, medium, high, xhigh, max, ultra; minimal older); null: not set or unknown */
export const effortOf = (v: string | undefined): string | null => /^(minimal|low|medium|high|xhigh|max|ultra)$/.test((v ?? '').trim()) ? v!.trim() : null
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Cfg {
  const home = env.HOME || homedir()
  const root = (env.CODEX_RUNNER_ROOT || join(home, 'onsen-codex')).replace(/\/+$/, '')
  const stateDir = env.CODEX_RUNNER_STATE_DIR || join(root, '.runner')
  return {
    agent: (env.CODEX_RUNNER_AGENT || 'codex').trim(),
    base: ((env.ONSEN_BASE ?? '').trim() || 'https://core.kbro.ai/api/onsen').replace(/\/+$/, ''),
    credentialFile: env.CODEX_RUNNER_CREDENTIAL_FILE || join(home, '.config/mesh/codex.credential'),
    host: (env.ONSEN_HOST || '').trim() || hostname().replace(/\.local$/, ''),
    root, stateDir, logFile: env.CODEX_RUNNER_LOG || join(stateDir, 'runner.log'),
    codexBin: env.CODEX_BIN || 'codex', sandbox: env.CODEX_RUNNER_SANDBOX || 'workspace-write',
    max: Math.floor(num(env.CODEX_RUNNER_MAX, 3)), timeoutMs: num(env.CODEX_RUNNER_TIMEOUT_S, 1800) * 1000,
    killGraceMs: num(env.CODEX_RUNNER_KILL_GRACE_S, 10) * 1000, waitS: num(env.CODEX_RUNNER_WAIT_S, 25),
    maxFiles: 20, maxFileBytes: 25 * 1024 * 1024, retryMs: 15_000, adoptPollMs: 2_000,
    ...codexHomes(env, root), authFrom: env.CODEX_RUNNER_AUTH_FROM || join(home, '.codex'),
    devTimeoutMs: num(env.CODEX_RUNNER_DEV_TIMEOUT_S, 3600) * 1000,
    devRepos: devRepos(env.CODEX_RUNNER_DEV_REPOS, home),
    devPg: (env.CODEX_RUNNER_DEV_PG || 'postgresql://postgres@127.0.0.1:55432').trim(),
    model: /^[A-Za-z0-9._:-]{1,80}$/.test((env.CODEX_RUNNER_MODEL ?? '').trim()) ? env.CODEX_RUNNER_MODEL!.trim() : null,
    effort: effortOf(env.CODEX_RUNNER_EFFORT),
    // Chiron #200750 (11-27; Joey told, TG chiron:2929 and 2884): a #dev item thinks at max; ultra is accepted but not the default (its sharding
    // with the sandbox and the time limit is not measured)
    devEffort: effortOf(env.CODEX_RUNNER_DEV_EFFORT) ?? 'max',
  }
}
function codexHomes(env: NodeJS.ProcessEnv, root: string): { codexHome: string | null; childHome: string | null } {
  const v = (env.CODEX_RUNNER_CODEX_HOME ?? '').trim()
  if (v === 'inherit') return { codexHome: null, childHome: null }
  const codexHome = (v || join(root, '.codex-home')).replace(/\/+$/, '')
  return { codexHome, childHome: (env.CODEX_RUNNER_CHILD_HOME || '').trim() || join(codexHome, 'home') }
}

// ------------------------------------------------------------------ Codex's own home (--setup)
/** the config.toml of Codex's own home: nothing of the Mac's personal setup. Its model: the runner's own (CODEX_RUNNER_MODEL / _EFFORT), else what
 *  this home's config.toml already says (`current`); never the personal config's (Chiron mesh 13227) */
export function cleanConfig(current: string, own: { model?: string | null; effort?: string | null } = {}): string {
  const line = (k: string, v: string | null | undefined): string[] => v ? [`${k} = "${v}"`] : []
  const keep = own.model || own.effort
    ? [...line('model', own.model), ...line('model_reasoning_effort', own.effort)]
    : current.split('\n').filter(l => /^\s*(model|model_reasoning_effort)\s*=\s*"[^"\n]*"\s*$/.test(l)).map(l => l.trim())
  return ['# codex-runner: the Onsen member codex runs with this Codex home, not the Mac\'s personal one (WO-184 part 2, Chiron 08:49Z note 2).',
    '# No MCP servers, no plugins, no apps, no skills, no hooks, no memories, no browser or computer use, no personal instructions (no AGENTS.md).',
    ...(keep.length ? ['# the model: the runner\'s own (CODEX_RUNNER_MODEL / CODEX_RUNNER_EFFORT; every run is also given them), never the personal config\'s', ...keep] : []),
    '', '[features]', 'image_generation = true', 'plugins = false', 'apps = false', 'hooks = false', 'memories = false', 'browser_use = false',
    'computer_use = false', 'in_app_browser = false', '', '[skills.bundled]', 'enabled = false', ''].join('\n')
}
/** make (or check) Codex's own home: the folders, config.toml, auth.json and auth.lock linked to the personal home's (the login is never read or
 *  printed here), and the rollouts of the sessions the runner already has, so they resume. Returns the lines to print. */
export function setupCodexHome(cfg: Cfg, o: { force?: boolean } = {}): string[] {
  if (!cfg.codexHome || !cfg.childHome) return ['CODEX_RUNNER_CODEX_HOME=inherit: Codex runs with the inherited home; nothing to set up']
  const out: string[] = []
  for (const d of [cfg.codexHome, cfg.childHome]) mkdirSync(d, { recursive: true, mode: 0o700 })
  const conf = join(cfg.codexHome, 'config.toml')
  if (!existsSync(conf) || o.force) {
    let current = ''
    try { current = readFileSync(conf, 'utf8') } catch {}
    writeFileSync(conf, cleanConfig(current, { model: cfg.model, effort: cfg.effort }), { mode: 0o600 })
    out.push(`wrote ${conf}`)
  } else out.push(`kept ${conf} (--force writes it again)`)
  for (const f of ['auth.json', 'auth.lock']) {
    const link = join(cfg.codexHome, f), target = join(cfg.authFrom, f)
    let st: ReturnType<typeof lstatSync> | null = null
    try { st = lstatSync(link) } catch {}
    if (st?.isSymbolicLink() && readlinkSync(link) === target) { out.push(`kept ${link} -> ${target}`); continue }
    if (st && !o.force) { out.push(`left ${link}: it is there and not a link to ${target} (--force replaces it)`); continue }
    if (f === 'auth.json' && !existsSync(target)) { out.push(`no ${target}: log Codex in first (codex login), then --setup again`); continue }
    if (f === 'auth.lock' && !existsSync(target)) writeFileSync(target, '', { mode: 0o600 })
    if (st) rmSync(link, { force: true })
    symlinkSync(target, link)
    out.push(`linked ${link} -> ${target}`)
  }
  // the sessions the runner has: their rollouts copied, so a thread started before the switch still resumes
  let ids: string[] = []
  try { ids = Object.values(JSON.parse(readFileSync(join(cfg.stateDir, 'state.json'), 'utf8')).sessions ?? {}).map((x: any) => x?.session_id).filter(Boolean) } catch {}
  let copied = 0
  const from = join(cfg.authFrom, 'sessions')
  const walk = (d: string): void => {
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      const p = join(d, n)
      let s2
      try { s2 = lstatSync(p) } catch { continue }
      if (s2.isDirectory()) walk(p)
      else if (s2.isFile() && ids.some(id => n.endsWith(`-${id}.jsonl`))) {
        const dest = join(cfg.codexHome!, 'sessions', relative(from, p))
        if (!existsSync(dest)) { mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); copyFileSync(p, dest); copied++ }
      }
    }
  }
  if (ids.length) walk(from)
  out.push(`sessions: ${ids.length} the runner knows, ${copied} rollout file(s) copied into ${join(cfg.codexHome, 'sessions')}`)
  return out
}
/** Codex's own home is there: its config and a login it can read */
export function codexHomeReady(cfg: Cfg): string | null {
  if (!cfg.codexHome) return null
  if (!existsSync(join(cfg.codexHome, 'config.toml'))) return `Codex 的專用設定還沒建好（${cfg.codexHome}/config.toml 不在）：在 Mac mini 跑 codex-runner.ts --setup`
  if (!existsSync(join(cfg.codexHome, 'auth.json'))) return `Codex 的專用設定沒有登入（${cfg.codexHome}/auth.json 不在或連不到）：在 Mac mini 跑 codex-runner.ts --setup`
  return null
}

// ------------------------------------------------------------------ Onsen, with the codex credential
export type Answer = { status: number; json: any } | null
export class Onsen {
  private tok: { mtime: number; value: string | null } = { mtime: -1, value: null }
  readonly origin: string
  constructor(readonly base: string, readonly credentialFile: string) { this.origin = new URL(base).origin }
  /** the credential (re-read when the file changes); null when it is missing or not a mesh credential. Never logged. */
  token(): string | null {
    try {
      const m = statSync(this.credentialFile).mtimeMs
      if (m !== this.tok.mtime) { const v = readFileSync(this.credentialFile, 'utf8').trim(); this.tok = { mtime: m, value: v.startsWith('mesh_') ? v : null } }
    } catch { this.tok = { mtime: -1, value: null } }
    return this.tok.value
  }
  /** one JSON request to base + path; null = no credential; throws on a network error or the timeout */
  async req(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<Answer> {
    const t = this.token()
    if (!t) return null
    const r = await fetch(this.base + path, { method, headers: { Authorization: `Bearer ${t}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
  /** POST /v1/files: the file's bytes, its type, its name (percent-encoded), an Idempotency-Key */
  async upload(file: string, name: string, mime: string, idem: string, timeoutMs = 300_000): Promise<Answer> {
    const t = this.token()
    if (!t) return null
    const r = await fetch(`${this.base}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': mime,
      'X-File-Name': encodeURIComponent(name), 'Idempotency-Key': idem }, body: readFileSync(file), signal: AbortSignal.timeout(timeoutMs) })
    let json: any = null
    try { json = await r.json() } catch {}
    return { status: r.status, json }
  }
  /** an attachment's url, only on Onsen's own origin (the credential goes nowhere else) */
  async download(url: string, dest: string, timeoutMs = 300_000): Promise<{ ok: boolean; bytes?: number; why?: string }> {
    let u: URL
    try { u = new URL(url) } catch { return { ok: false, why: 'not a url' } }
    if (u.origin !== this.origin) return { ok: false, why: `not on Onsen (${u.origin})` }
    const t = this.token()
    if (!t) return { ok: false, why: 'no credential' }
    const r = await fetch(u.href, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(timeoutMs) })
    if (r.status !== 200) return { ok: false, why: `HTTP ${r.status}` }
    const buf = Buffer.from(await r.arrayBuffer())
    writeFileSync(dest, buf)
    return { ok: true, bytes: buf.length }
  }
}

// ------------------------------------------------------------------ state
export type Att = { name: string | null; mime: string | null; kind: string | null; url: string | null }
export type JobState = 'lookup' | 'queued' | 'starting' | 'running' | 'finishing' | 'done' | 'failed' | 'skipped'
export type Job = {
  id: string; source: 'call' | 'person'; key: string; text: string; attachments: Att[]; state: JobState; received_at: string
  item_id: string; claim_id: string; response_message_ids?: string[]
  call_id?: string | null; number?: number | null; caller?: string; kind?: string
  /** the session's thread (an agent's item); hop: the item's hop, the answer's is one more */
  thread?: string; thread_given?: boolean; hop?: number
  message_id?: string; chat?: string
  conversation_id?: string; via?: string; context?: string[]
  dir?: string; n?: number; resumed?: string | null; images?: string[]; notes?: string[]
  started_at?: string; ended_at?: string; pid?: number | null; exit?: number | null; signal?: string | null; timed_out?: boolean
  before?: Record<string, string>
  outcome?: 'completed' | 'failed'; result_text?: string; files?: string[]; skipped_files?: string[]
  uploads?: Record<string, string>; steps?: Record<string, boolean>; why?: string
  /** a #dev item (Chiron mesh 13257): the repo it asked for, the clone the runner made in its folder, the branch, the base it started from,
   *  where the branch went (pushed: the ref and commit; push_error: why not), and whether its one automatic continuation was used */
  dev?: { repo: string; local: string; clone: string; branch: string; base: string; origin: string; pushed?: string; push_error?: string;
    commits?: string[]; continued?: boolean }
}
/** one Codex session: an agent's thread (key t:<thread>) or a person's conversation (key say:<chat>: the page's say rows and that chat's
 *  person_message items alike, one conversation; conv:<conversation id> for a person_message with no client chat) */
export type Sess = { dir: string; conversation_id: string | null; session_id: string | null; runs: number; thread: string | null; first_number: number | null }
export type State = { v: 1; seq: number; jobs: Job[]; sessions: Record<string, Sess>
  span: { id: string; started_at: string; trigger: any } | null; last_turn: { id: string; outcome: 'done' | 'failed'; ended_at: string } | null
  idle_since: string | null; last_activity_at: string | null }
const BUSY: ReadonlySet<JobState> = new Set(['starting', 'running', 'finishing'])
const OPEN: ReadonlySet<JobState> = new Set(['lookup', 'queued', 'starting', 'running', 'finishing'])
const KEEP_DONE = 200

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/plain', '.py': 'text/x-python',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.zip': 'application/zip', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
export const mimeOf = (name: string): string => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
const isImage = (a: Att): boolean => a.kind === 'photo' || /^image\/(png|jpeg|gif|webp)$/.test(a.mime ?? '')
/** a file name safe in the folder: its last path part, no control characters, not hidden, not the runner's own names */
export function safeName(name: string | null, fallback: string): string {
  let n = String(name ?? '').split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, '').trim()
  n = n.replace(/^\.+/, '')
  if (!n || /^last-\d+\.txt$/.test(n)) n = fallback
  return n.slice(0, 200)
}
/** a thread as the lanes write it (telegram-http lanes: <agent>#t-<hex>, what a daemon carries over to a reply); Codex's new ones are codex#t-<12 hex> */
export const THREAD_RE = /^[a-z0-9_-]{1,32}#t-[0-9a-f]{4,16}$/i
export const newThread = (agent: string): string => `${agent}#t-${Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('')}`
function threadOf(it: InboxItem): string | null {
  const value = it.payload.thread ?? it.refs.find(ref => ref.kind === 'thread')?.value
  return typeof value === 'string' && THREAD_RE.test(value) ? value : null
}
function sessionKey(it: InboxItem): string | null {
  if (it.kind === 'message') {
    const chat = it.payload.client?.chat
    return chat != null ? 'say:' + chat : 'conv:' + it.payload.conversation_id
  }
  const thread = threadOf(it)
  return thread && 't:' + thread
}
/** what a person_message says besides its text, as lines of the prompt: the message it replies to, the passage quoted, where it was forwarded from */
export function contextOf(p: Record<string, any>): string[] {
  const out: string[] = []
  const r = p.reply_to && typeof p.reply_to === 'object' ? p.reply_to as Record<string, any> : null
  if (r) out.push(`（這一則回覆${typeof r.from === 'string' && r.from ? ` ${r.from} ` : ''}的一則訊息${typeof r.text === 'string' && r.text.trim() ? `：「${cut(r.text.trim(), 500)}」` : ''}）`)
  if (typeof p.reply_quote === 'string' && p.reply_quote.trim()) out.push(`（引用其中這一段：「${cut(p.reply_quote.trim(), 1000)}」）`)
  if (typeof p.forward_from === 'string' && p.forward_from.trim()) out.push(`（轉傳自 ${cut(p.forward_from.trim(), 200)}）`)
  return out
}
/** a key as a folder name */
const folderOf = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'conversation'
const tail = (s: string, lines: number, chars: number): string => { const t = s.split('\n').slice(-lines).join('\n'); return t.length > chars ? '…' + t.slice(-chars) : t }
const cut = (s: string, n: number): string => s.length <= n ? s : s.slice(0, n - 1) + '…'
const dur = (ms: number): string => ms >= 60_000 ? `${Math.round(ms / 60_000)} 分鐘` : `${Math.round(ms / 1000)} 秒`
const size = (n: number): string => n >= 1_048_576 ? `${Math.round(n / 1_048_576)} MB` : `${n} bytes`

// ------------------------------------------------------------------ the folder: what a run made
const SCAN_MAX = 5000
/** every regular file under dir (relative path → size:mtime), hidden names and symlinks skipped, at most SCAN_MAX */
export function snapshot(dir: string, skip?: string): Record<string, string> {
  const out: Record<string, string> = {}
  let n = 0
  const walk = (d: string, depth: number): void => {
    if (depth > 6 || n >= SCAN_MAX) return
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const name of names.sort()) {
      if (name.startsWith('.') || n >= SCAN_MAX) continue
      if (skip && depth === 0 && name === skip) continue                // a #dev item's clone: its branch is the answer, not its files
      const p = join(d, name)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(p, depth + 1)
      else if (st.isFile()) { out[relative(dir, p)] = `${st.size}:${Math.round(st.mtimeMs)}`; n++ }
    }
  }
  walk(dir, 0)
  return out
}
/** the files this run made or changed (not last-<n>.txt), oldest first */
export function madeBy(dir: string, before: Record<string, string>, skip?: string): string[] {
  const now = snapshot(dir, skip)
  const changed = Object.keys(now).filter(k => before[k] !== now[k] && !/^last-\d+\.txt$/.test(k))
  return changed.sort((a, b) => Number(now[a]!.split(':')[1]) - Number(now[b]!.split(':')[1]) || a.localeCompare(b))
}
/** the --json events: the session id (thread.started), whether the turn completed, the last error message */
export function readEvents(file: string): { session: string | null; completed: boolean; failed: boolean; error: string | null } {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch {}
  let session: string | null = null, completed = false, failed = false, error: string | null = null
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    if (e?.type === 'thread.started' && typeof e.thread_id === 'string' && !session) session = e.thread_id
    else if (e?.type === 'turn.completed') completed = true
    else if (e?.type === 'turn.failed') { failed = true; error = String(e?.error?.message ?? e?.message ?? error ?? 'turn failed') }
    else if (e?.type === 'error') error = String(e?.message ?? e?.error?.message ?? 'error')
  }
  return { session, completed: completed && !failed, failed, error }
}
const alive = (pid: number | null | undefined): boolean | null => {
  if (!pid) return false
  try { process.kill(pid, 0) } catch (e: any) { return e?.code === 'EPERM' ? null : false }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  // A restricted process table tells us nothing about a PID which the OS still sees.
  return r.status === 0 ? /codex/.test(r.stdout) : null
}
const killGroup = (pid: number, sig: NodeJS.Signals): void => {
  try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch {} }
}

// ------------------------------------------------------------------ the runner
export class CodexRunner {
  readonly onsen: Onsen
  state: State
  private readonly items: OnsenClient
  private readonly mode: TakeMode
  private readonly claims: Claims
  private readonly peek: ItemPeek
  private readonly receiver: ItemReceiver
  private pendingTake?: Promise<void>
  private recovered = false
  private readonly obs: ObservationPut
  private procs = new Map<string, ChildProcess | null>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private reporting = new Set<string>()
  private stopped = false
  readonly stats = { taken: 0, ignored: 0, runs: 0, completed: 0, failed: 0, reports_retried: 0, last_error: null as string | null }

  constructor(readonly cfg: Cfg) {
    this.onsen = new Onsen(cfg.base, cfg.credentialFile)
    mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
    this.state = this.load()
    const log = this.log.bind(this)
    this.items = new OnsenClient({ dir: join(cfg.stateDir, 'onsen'), base: cfg.base, agent: cfg.agent, record: true, log,
      credential: () => this.onsen.token() })
    this.claims = new Claims(join(cfg.stateDir, 'item-claims.json'), this.items,
      id => this.log('warn', 'worker did not start within the take window: ' + id), () => this.changed(), cfg.now)
    this.items.watchItemReports(line => this.claims.replay(line), (line, ok) => this.claims.acknowledged(line, ok))
    this.mode = new TakeMode(cfg.agent, this.items.request.bind(this.items), active => {
      if (!active) { this.peek.stop(); return }
      this.claims.start()
      if (!this.recovered) { this.recovered = true; this.recover() }
      this.changed()
      this.peek.reset()
    }, msg => this.log('info', msg), machineName(cfg.host))
    this.peek = new ItemPeek(this.mode, () => new Map(), it => this.pendingTake = this.take(it),
      () => !this.claims.blocked() && this.busy().length < cfg.max, cfg.waitS)
    this.receiver = new ItemReceiver(this.mode, this.claims, at => this.peek.dueAt(at))
    this.obs = new ObservationPut({ agent: cfg.agent, on: () => !this.stopped && this.mode.active, put: (o, t) => this.observe(o, t),
      refresh: () => this.obs.update(this.observation()), exception: line => this.log('warn', `observation rejected: ${JSON.stringify(line).slice(0, 500)}`),
      log: (l, m) => this.log(l, m), now: cfg.now }, cfg.heartbeatMs ? { heartbeatMs: cfg.heartbeatMs } : {})
  }
  private now(): number { return (this.cfg.now ?? Date.now)() }
  private iso(ms = this.now()): string { return new Date(ms).toISOString() }
  log(level: 'info' | 'warn' | 'error', msg: string): void {
    if (this.cfg.log) { this.cfg.log(level, msg); return }
    const line = `${this.iso()} ${level} ${msg}`
    try { appendFileSync(this.cfg.logFile, line + '\n', { mode: 0o600 }) } catch {}
    console.error(line)
  }

  // ---------------------------------------------------------------- state file
  private load(): State {
    const empty: State = { v: 1, seq: 0, jobs: [], sessions: {}, span: null, last_turn: null, idle_since: null, last_activity_at: null }
    try {
      const j = JSON.parse(readFileSync(join(this.cfg.stateDir, 'state.json'), 'utf8'))
      if (j?.v !== 1 || !Array.isArray(j.jobs)) throw new Error('invalid codex-runner state.json')
      return { ...empty, ...j }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return empty
    }
  }
  /** the state file (atomic, 0600). A stopped runner writes it once more (stop) and never again: the next one owns it */
  save(force = false): void {
    if (this.stopped && !force) return
    const s = this.state
    const done = s.jobs.filter(j => !OPEN.has(j.state))
    if (done.length > KEEP_DONE) { const drop = new Set(done.slice(0, done.length - KEEP_DONE).map(j => j.id)); s.jobs = s.jobs.filter(j => !drop.has(j.id)) }
    const f = join(this.cfg.stateDir, 'state.json'), tmp = f + '.tmp'
    try { writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 }); renameSync(tmp, f) } catch (e) { this.log('error', `state not written: ${e}`) }
  }

  // ---------------------------------------------------------------- life
  async start(): Promise<void> {
    if (this.state.jobs.some(j => OPEN.has(j.state) && (!j.item_id || !j.claim_id))) {
      throw new Error('Drain unfinished jobs with the previous codex-runner before switching this member to take.')
    }
    mkdirSync(this.cfg.root, { recursive: true, mode: 0o700 })
    this.state.idle_since ??= this.iso()
    this.log('info', `codex-runner up: ${this.cfg.agent} on ${this.cfg.host}, Onsen ${this.cfg.base}, at most ${this.cfg.max} at once, timeout ${this.cfg.timeoutMs / 1000} s, folders under ${this.cfg.root}`)
    if (!this.onsen.token()) this.log('warn', `no mesh credential in ${this.cfg.credentialFile}: nothing is taken until it is there (read again on every request)`)
    const notReady = codexHomeReady(this.cfg)
    if (notReady) this.log('error', `${notReady}: every item fails with this note until it is there`)
    else this.log('info', this.cfg.codexHome ? `Codex runs with its own home ${this.cfg.codexHome} (HOME ${this.cfg.childHome})` : 'Codex runs with the inherited home (CODEX_RUNNER_CODEX_HOME=inherit)')
    this.items.start()
    await this.mode.probe()
    this.later(1_000, () => void this.declareWork(0))
  }
  /** Onsen 0.29.2: codex takes work (members.takes_work), so a reply to its answer is a Call of its own. Declared once at start (its first status
   *  report makes the member: a 404 is asked again); an Onsen that does not know the field (400) is told once: follow-ups are then taken without a
   *  Call, as before */
  async declareWork(tries: number): Promise<void> {
    let r: Answer = null
    try { r = await this.onsen.req('PUT', `/v1/members/${encodeURIComponent(this.cfg.agent)}/profile`, { takes_work: true }) } catch {}
    if (r?.status === 200) { this.log('info', `${this.cfg.agent} takes work in Onsen (a reply to its answer is a Call)`); return }
    if (r?.status === 400) { this.log('warn', `Onsen does not take takes_work (before 0.29.2): a reply to Codex's answer is a follow-up without a Call`); return }
    if (tries >= 20) { this.log('warn', `takes_work not declared after ${tries} tries (${r ? `HTTP ${r.status}` : 'no answer'})`); return }
    this.later(this.cfg.declareRetryMs ?? 20_000, () => void this.declareWork(tries + 1))
  }
  /** stop taking work; a clean stop reports offline. Runs going on are left to finish (their own process group): the next start follows them. */
  async stop(o: { offline?: boolean } = {}): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.obs.stop()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    const wasActive = this.mode.active
    this.mode.stop()
    await this.pendingTake
    this.claims.stop()
    this.items.stop()
    this.save(true)
    if (wasActive && o.offline !== false) await this.observe(this.observation(true), 5000).catch(() => null)
    this.log('info', 'codex-runner stopped')
  }
  private later(ms: number, fn: () => void): void {
    if (this.stopped) return
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn() }, Math.max(0, ms))
    this.timers.add(t)
  }
  private changed(): void { this.save(); if (!this.stopped) this.obs.update(this.observation()) }

  private async observe(body: Observation, timeout: number) {
    const res = await this.items.request('PUT', '/v1/members/' + encodeURIComponent(this.cfg.agent) + '/observation',
      body, timeout, { 'Idempotency-Key': crypto.randomUUID() })
    if (res?.status === 409 && res.json?.error?.code === 'not_current_connector') this.mode.pause('not_current_connector', 45_000)
    return res
  }

  busy(): Job[] { return this.state.jobs.filter(j => BUSY.has(j.state)) }
  private available(row: InboxItem): boolean {
    const busy = this.busy(), key = sessionKey(row)
    return busy.length < this.cfg.max && !busy.some(j => j.key === key || j.item_id === row.id)
  }

  private async take(peeked: InboxItem): Promise<void> {
    if (!this.available(peeked)) return
    const { rows } = await this.receiver.receive([itemRef(peeked)])
    const row = rows[0]
    if (!row) return
    if (this.stopped || !this.mode.active || !this.available(row)) {
      this.claims.report(row.id, 'not_taken')
      return
    }
    if (this.claims.completed(row.id)) {
      this.claims.report(row.id, 'completed')
      return
    }
    const p = row.payload, person = row.kind === 'message'
    if (row.kind === 'control' || !['message', 'call', 'alert', 'schedule'].includes(row.kind) || p.urgency === 'silent') {
      this.claims.report(row.id, row.kind === 'control' ? 'not_applied' : 'completed')
      this.stats.ignored++
      return
    }
    if (person && (!row.message_id || !p.conversation_id)) {
      this.log('warn', row.id + ': missing message or conversation id')
      this.claims.report(row.id, 'error')
      return
    }
    const thread = person ? undefined : threadOf(row) ?? newThread(this.cfg.agent)
    const number = p.msg_id ?? row.refs.find(ref => ref.kind === 'btcc_msg_id')?.value
    const job: Job = { id: 'j' + ++this.state.seq, state: 'starting', received_at: this.iso(), source: person ? 'person' : 'call',
      item_id: row.id, claim_id: row.claim!.id, key: sessionKey(row) ?? 't:' + thread, text: String(p.text ?? p.body ?? ''),
      caller: row.from, call_id: row.call_id, conversation_id: p.conversation_id != null ? String(p.conversation_id) : undefined,
      message_id: row.message_id ?? undefined, attachments: Array.isArray(p.attachments) ? p.attachments : [],
      chat: p.client?.chat != null ? String(p.client.chat) : undefined, kind: row.kind, via: p.via, context: contextOf(p),
      thread, thread_given: !!threadOf(row), number: Number.isSafeInteger(Number(number)) && Number(number) > 0 ? Number(number) : null, hop: Number(p.hop) || 0 }
    this.state.jobs.push(job)
    this.stats.taken++
    void this.begin(job)
  }
  private openSpan(j: Job): void {
    if (this.state.span) return
    const c = this.state.sessions[j.key]
    this.state.span = { id: `codex-turn-${this.now()}`, started_at: this.iso(),
      trigger: j.source !== 'call' && j.message_id ? { kind: 'message', conversation_id: j.conversation_id ?? c?.conversation_id ?? null, message_id: j.message_id }
        : { kind: 'other' } }
  }
  private closeSpanIfIdle(outcome: 'done' | 'failed'): void {
    if (this.busy().length || !this.state.span) return
    this.state.last_turn = { id: this.state.span.id, outcome, ended_at: this.iso() }
    this.state.span = null
    this.state.idle_since = this.iso()
  }

  /** accept → folder and attachments → running → codex */
  private async begin(j: Job): Promise<void> {
    j.state = 'starting'
    this.openSpan(j)
    this.state.last_activity_at = this.iso()
    this.changed()
    try {
      const conv = this.session(j)
      j.dir = conv.dir
      mkdirSync(join(conv.dir, '.codex-runner'), { recursive: true, mode: 0o700 })
      await this.fetchAttachments(j)
      const ask = devAsk(j.text)
      if (ask) await this.prepareDev(j, ask)                              // the clone and its branch, before Codex starts (it never pushes)
      conv.runs++
      j.n = conv.runs
      j.resumed = conv.session_id
      j.before = snapshot(conv.dir, j.dev ? 'repo' : undefined)
      j.started_at = this.iso()
      if (this.stopped) return                                      // restart returns this unstarted claim to Onsen
      const notReady = codexHomeReady(this.cfg)                     // Codex's own home missing: this item fails with the note, never runs elsewhere
      if (notReady) throw new Error(notReady)
      if (!this.mode.active || !this.claims.owns(j.item_id, j.claim_id)) {
        if (this.claims.owns(j.item_id, j.claim_id)) this.claims.report(j.item_id, 'not_taken')
        j.state = 'skipped'; this.after(j); return
      }
      this.spawnRun(j)
    } catch (e) {
      this.log('error', `${j.id}: could not start: ${e instanceof Error ? e.message : e}`)
      j.started_at ??= this.iso()
      j.ended_at = this.iso(); j.outcome = 'failed'; j.result_text = `Codex 這一件沒開始：codex-runner 準備時出錯（${e instanceof Error ? e.message : e}）。`
      j.state = 'finishing'
      this.changed()
      void this.report(j)
    }
  }
  /** a #dev item (Chiron mesh 13257): the runner clones the repo into the item's folder (./repo, `git clone --reference` the local copy, so the
   *  local copy is only read) and checks out its branch (codex/call-<id> unless branch= names one; an existing branch on origin goes on from
   *  there). A follow-up in the same session reuses the clone. Throws with the reason when it cannot (the item then fails, saying so). */
  private async prepareDev(j: Job, ask: { repo: string; branch: string | null }): Promise<void> {
    const local = ask.repo.startsWith('/') ? ask.repo : this.cfg.devRepos[ask.repo]
    if (!local) throw new Error(`#dev repo=${ask.repo}：不認得這個名字（可用 ${Object.keys(this.cfg.devRepos).join('、')}，或本機 git repo 的絕對路徑）`)
    const git = async (args: string[], cwd?: string): Promise<string> => {
      const { stdout } = await promisify(execFile)('git', args, { cwd, timeout: 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      return stdout.trim()
    }
    try { await git(['rev-parse', '--git-dir'], local) } catch { throw new Error(`#dev repo=${ask.repo}：${local} 不是本機的 git repo`) }
    let origin = ''
    try { origin = await git(['remote', 'get-url', 'origin'], local) } catch { origin = local }
    const clone = join(j.dir!, 'repo')
    const mark = join(j.dir!, '.codex-runner', 'dev-clone.json')
    const branch = ask.branch || `codex/${folderOf(j.call_id ? `call-${j.call_id}` : j.id)}`
    // a ./repo the runner did not make (Codex cloned one itself before #dev existed: Call 774) is moved aside, never reused: its origin and
    // base are unknown. Nothing in it is lost; the brief names where it went.
    let movedAside: string | null = null
    if (existsSync(clone) && !existsSync(mark)) {
      movedAside = join(j.dir!, `repo-before-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`)
      renameSync(clone, movedAside)
    }
    if (!existsSync(join(clone, '.git'))) {
      // --reference only from a full repo: git refuses a shallow one (Sonn #200705: the live crab-labs-plugins checkout is shallow)
      let shallow = false
      try { shallow = await git(['rev-parse', '--is-shallow-repository'], local) === 'true' } catch {}
      await git(['clone', '--quiet', ...(shallow || origin === local ? [] : ['--reference', local]), origin, clone])
      writeFileSync(mark, JSON.stringify({ origin, local, at: this.iso() }) + '\n', { mode: 0o600 })
    } else await git(['fetch', '--quiet', 'origin'], clone)
    // the base: origin's own default branch (`ls-remote --symref`), not a symbolic ref a copied clone may carry
    let base = ''
    try { base = `origin/${/^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(await git(['ls-remote', '--symref', 'origin', 'HEAD'], clone))?.[1] ?? ''}` } catch {}
    if (base === 'origin/') try { base = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], clone) } catch { base = 'origin/main' }
    if (movedAside) (j.notes ??= []).push(`這一件資料夾裡原本有一個不是 runner 開的 ./repo，已經移到 ${basename(movedAside)}，沒有刪`)
    const onOrigin = await (async () => { try { await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], clone); return true } catch { return false } })()
    const here = await (async () => { try { await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], clone); return true } catch { return false } })()
    if (here) await git(['checkout', '--quiet', branch], clone)
    else await git(['checkout', '--quiet', '-b', branch, onOrigin ? `origin/${branch}` : base], clone)
    j.dev = { repo: ask.repo, local, clone, branch, base: onOrigin ? `origin/${branch}` : base, origin }
    this.log('info', `${j.id}: #dev ${ask.repo}: clone ${clone} on ${branch} (from ${j.dev.base})`)
  }
  /** after a #dev run: push its branch to origin (that branch only, never main, never forced). The result says where it went or why not. */
  private async pushDev(j: Job): Promise<void> {
    const d = j.dev!
    const run = async (args: string[]) => {
      try {
        const { stdout } = await promisify(execFile)('git', args, { cwd: d.clone, timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
        return { ok: true, out: stdout.trim() }
      } catch (err) { return { ok: false, out: String(err) } }
    }
    const log = await run(['log', '--format=%h %s', `${d.base}..HEAD`])
    d.commits = log.ok && log.out ? log.out.split('\n').slice(0, 50) : []
    if (!d.commits.length) { d.push_error = '這個分支沒有新的 commit'; return }
    if (/^(main|master)$/.test(d.branch)) { d.push_error = `不推 ${d.branch}`; return }
    const p = await run(['push', '--quiet', 'origin', `HEAD:refs/heads/${d.branch}`])
    const head = (await run(['rev-parse', '--short', 'HEAD'])).out
    if (p.ok) d.pushed = `${d.branch} @ ${head}`
    else d.push_error = p.out.slice(0, 300) || 'git push 失敗'
    this.log(p.ok ? 'info' : 'warn', `${j.id}: #dev push ${d.branch}: ${p.ok ? `ok ${head}` : d.push_error}`)
  }
  /** the lines a #dev item's answer always carries (kept whole when the answer is cut) */
  private devLine(j: Job): string {
    const d = j.dev
    if (!d) return ''
    const where = d.pushed ? `推上去了：${d.origin} ${d.pushed}` : `沒有推：${d.push_error ?? '還沒跑完'}（clone 留著）`
    return `\n\n**開發任務**\n- clone：${d.clone}\n- 分支：${d.branch}（從 ${d.base} 開）\n- ${where}` +
      (d.commits?.length ? `\n- commit：${d.commits.length} 個（${cut(d.commits.slice(0, 5).join('；'), 400)}）` : '')
  }

  private session(j: Job): Sess {
    let c = this.state.sessions[j.key]
    if (c) return c
    const cid = j.conversation_id ?? null
    const dm = j.source !== 'call'
    const top = folderOf(cid ?? (dm ? `dm-${j.chat}` : `call-${j.caller}`))
    const sub = dm ? 'dm' : j.thread_given ? folderOf(j.thread!) : folderOf(j.call_id ? `call-${j.call_id}` : j.id)
    const dir = join(this.cfg.root, top, sub)
    c = this.state.sessions[j.key] = { dir, conversation_id: cid, session_id: null, runs: existsSync(dir) ? this.runsIn(dir) : 0,
      thread: j.thread ?? null, first_number: j.number ?? null }
    if (this.state.span && this.state.span.trigger?.kind === 'message' && this.state.span.trigger.conversation_id == null && cid) this.state.span.trigger.conversation_id = cid
    return c
  }
  private runsIn(dir: string): number {
    try { return Math.max(0, ...readdirSync(dir).map(n => Number(/^last-(\d+)\.txt$/.exec(n)?.[1] ?? 0))) } catch { return 0 }
  }
  private async fetchAttachments(j: Job): Promise<void> {
    j.images = []; j.notes = []
    const taken = new Set<string>()
    for (const [i, a] of j.attachments.entries()) {
      let name = safeName(a.name, `attachment-${j.id}-${i + 1}${extname(String(a.name ?? '')) || ''}`)
      if (!a.url) {                                             // a file only the client has (a Telegram photo Onsen keeps no copy of): named, not available
        j.notes.push(`附件 ${a.name ? name : `一個沒有檔名的 ${a.kind ?? '檔案'}`} 拿不到：沒有網址，Onsen 沒存那個檔${j.via && j.via !== 'web' ? `，只在 ${j.via} 上` : ''}`)
        continue
      }
      let dest = join(j.dir!, name)
      for (let k = 1; (existsSync(dest) || taken.has(dest)) && k < 100; k++) {
        const e = extname(name), b = name.slice(0, name.length - e.length)
        dest = join(j.dir!, `${b}-${k}${e}`)
      }
      taken.add(dest)
      let got: { ok: boolean; why?: string } = { ok: false }
      try { got = await this.onsen.download(a.url, dest) } catch (e) { got = { ok: false, why: String(e) } }
      if (!got.ok) { j.notes.push(`附件 ${name} 沒下載到（${got.why}）`); this.log('warn', `${j.id}: attachment ${name}: ${got.why}`); continue }
      if (isImage(a)) j.images.push(dest)
      else j.notes.push(`附件 ${basename(dest)} 已放在工作資料夾`)
    }
  }

  // ---------------------------------------------------------------- the run
  /** new: exec <options> --json -o <last> [-i …] -- <text>; resume: exec <options> resume <session> --json -o <last> [-i …] -- <text> (resume takes
   *  --json, -o and -i after its name; -s and -C only before it). `--` keeps the text from being read as one more image (-i takes several). */
  argv(j: Job): string[] {
    const out = ['--json', '-o', join(j.dir!, `last-${j.n}.txt`)]
    const imgs = (j.images ?? []).flatMap(p => ['-i', p])
    // a person's message may have no text (a photo with no caption); one with neither text nor attachments says its kind
    const head = j.text.trim() || (j.source === 'person' && !j.attachments.length ? `（一則沒有文字的 ${j.kind ?? 'text'} 訊息）` : '（只有附件）')
    const brief = j.dev ? [this.devBrief(j), ''] : []
    const text = [...brief, head, ...(j.context?.length ? ['', ...j.context] : []), ...(j.notes?.length ? ['', ...j.notes.map(n => `（${n}）`)] : [])].join('\n')
    const effort = j.dev ? this.cfg.devEffort ?? this.cfg.effort : this.cfg.effort     // Chiron #200750: #dev at max, the rest as set
    const model = [...(this.cfg.model ? ['-m', this.cfg.model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      ...(j.dev ? ['-c', 'sandbox_workspace_write.network_access=true'] : [])]   // #dev: 127.0.0.1 and the throwaway PG (it opens the internet too)
    return ['exec', '--skip-git-repo-check', '-s', this.cfg.sandbox, '-C', j.dir!, ...model, ...(j.resumed ? ['resume', j.resumed] : []), ...out, ...imgs, '--', text]
  }
  /** the fixed opening of every #dev item (Chiron mesh 13257) */
  devBrief(j: Job): string {
    const d = j.dev!
    const db = `codex_${folderOf(j.call_id ? `call_${j.call_id}` : j.id).replace(/-/g, '_')}`.toLowerCase()
    return [`開發任務（codex-runner 已經準備好：./repo 是 ${d.repo} 的 clone，分支 ${d.branch}，從 ${d.base} 開）。規矩：`,
      '- 只在 ./repo 裡改，小步 commit；不要 push、不要切到 main（做完 runner 會把這個分支推上去）。',
      '- 不開任何憑證檔：.env、*.credential、auth.json、.secrets、mesh-credential。',
      `- 網路只用在本機的測試：127.0.0.1；要資料庫用拋棄式 PostgreSQL ${this.cfg.devPg}，用你自己的 db 名（例如 ${db}）。`,
      '- 不對任何人或任何線上服務送東西。',
      '- 最後的回覆要有：commit 清單；在這個環境跑過的測試與數字；跑不了的（和原因）；要負責人定的問題。「跑過的」和「跑不了的」分開寫。'].join('\n')
  }
  /** the child's environment: the runner's, without its own settings (CODEX_RUNNER_*, ONSEN_*), with Codex's own home and HOME */
  childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (!/^(CODEX_RUNNER_|ONSEN_)/.test(k)) env[k] = v
    if (this.cfg.codexHome && this.cfg.childHome) { env.CODEX_HOME = this.cfg.codexHome; env.HOME = this.cfg.childHome }
    return env
  }
  private spawnRun(j: Job): void {
    const meta = join(j.dir!, '.codex-runner')
    const out = openSync(join(meta, `run-${j.n}.jsonl`), 'a', 0o600), err = openSync(join(meta, `run-${j.n}.stderr`), 'a', 0o600)
    let child: ChildProcess
    try {
      child = spawn(this.cfg.codexBin, this.argv(j), { cwd: j.dir!, detached: true, stdio: ['ignore', out, err], env: this.childEnv() })
    } finally { closeSync(out); closeSync(err) }
    j.pid = child.pid ?? null
    j.state = 'running'
    this.stats.runs++
    this.procs.set(j.id, child)
    this.log('info', `${j.id}: codex ${j.resumed ? `resume ${j.resumed}` : 'new session'} in ${j.dir} (run ${j.n}, pid ${j.pid}, ${j.images?.length ?? 0} image(s))`)
    this.changed()
    child.on('error', e => { if (j.state === 'running') { j.why = `無法啟動 codex（${e.message}）`; this.exited(j, null, null) } })
    child.on('exit', (code, signal) => this.exited(j, code, signal))
    if (j.pid) this.claims.bind(j.item_id, 'main', j.id)
    this.armTimeout(j)
  }
  private limit(j: Job): number { return j.dev ? this.cfg.devTimeoutMs : this.cfg.timeoutMs }
  private armTimeout(j: Job): void {
    const left = Date.parse(j.started_at!) + this.limit(j) - this.now()
    this.later(left, () => {
      if (j.state !== 'running' || !j.pid) return
      if (!this.procs.get(j.id) && alive(j.pid) !== true) {
        this.log('warn', j.id + ': could not verify the adopted PID at timeout; still observing')
        return
      }
      j.timed_out = true
      this.log('warn', `${j.id}: ${Math.round(this.limit(j) / 1000)} s without finishing: SIGTERM to its process group, SIGKILL in ${this.cfg.killGraceMs / 1000} s`)
      this.save()
      const pid = j.pid                                       // this run's: a #dev continuation gets a new pid before the SIGKILL fires
      killGroup(pid, 'SIGTERM')
      this.later(this.cfg.killGraceMs, () => killGroup(pid, 'SIGKILL'))   // the whole group: what codex started dies with it
      // an adopted run has no exit event: the poll sees it go
    })
  }
  /** the process ended (its exit event, or the poll of an adopted one): what it left decides */
  private exited(j: Job, code: number | null, signal: string | null): void {
    if (j.state !== 'running' || this.stopped) return              // stopped: the next start follows it (restart)
    const child = this.procs.get(j.id)
    this.procs.delete(j.id)
    // what codex started dies with it, however it ended (Chiron 08:49Z note 3: after a SIGKILL its `sleep 120` lived on)
    if (child && j.pid) { const pid = j.pid; killGroup(pid, 'SIGTERM'); this.later(this.cfg.killGraceMs, () => killGroup(pid, 'SIGKILL')) }
    j.exit = code; j.signal = signal; j.ended_at = this.iso()
    const meta = join(j.dir!, '.codex-runner')
    const ev = readEvents(join(meta, `run-${j.n}.jsonl`))
    const conv = this.state.sessions[j.key]
    if (ev.session && conv && !conv.session_id) conv.session_id = ev.session
    let last = ''
    try { last = readFileSync(join(j.dir!, `last-${j.n}.txt`), 'utf8').trim() } catch {}
    // #dev (Chiron mesh 13257): the first time its limit stops it, it goes on once in the same session instead of failing
    if (j.timed_out && j.dev && !j.dev.continued && !j.why && conv) {
      j.dev.continued = true
      j.timed_out = false
      conv.runs++
      j.n = conv.runs
      j.resumed = ev.session ?? conv.session_id
      j.text = `時間到了（${dur(this.limit(j))}），你被停下來了。請在同一個分支接著把剩下的做完，做完照原本的格式回覆（commit 清單、跑過的、跑不了的、要負責人定的）。`
      j.started_at = this.iso()
      this.log('info', `${j.id}: #dev stopped at its limit: going on once in the same session (run ${j.n})`)
      this.changed()
      this.spawnRun(j)
      return
    }
    const adopted = code === null && signal === null && !j.why
    const ok = !j.timed_out && !j.why && (adopted ? ev.completed && !!last : code === 0)
    if (ok) {
      j.outcome = 'completed'
      j.result_text = last || '（Codex 沒有留下最後一則訊息）'
      const made = madeBy(j.dir!, j.before ?? {}, j.dev ? 'repo' : undefined)
      const big: string[] = [], over: string[] = []
      const files: string[] = []
      for (const rel of made.slice().reverse()) {            // the newest first when more than the limit were made
        let size = 0
        try { size = statSync(join(j.dir!, rel)).size } catch { continue }
        if (size > this.cfg.maxFileBytes) big.push(rel)
        else if (files.length < this.cfg.maxFiles) files.push(rel)
        else over.push(rel)
      }
      if (j.result_text.length > RESULT_ATTACH_AT) {           // the full answer goes along as a file: it takes one of the slots
        if (files.length >= this.cfg.maxFiles) over.push(files.pop()!)
        files.unshift(`last-${j.n}.txt`)
      }
      j.files = files.reverse()
      j.skipped_files = [...big.map(r => `${r}（超過 ${size(this.cfg.maxFileBytes)}，沒有附上）`), ...over.map(r => `${r}（超過 ${this.cfg.maxFiles} 個，沒有附上）`)]
    } else {
      j.outcome = 'failed'
      let stderr = ''
      try { stderr = readFileSync(join(meta, `run-${j.n}.stderr`), 'utf8') } catch {}
      const why = j.why ?? (j.timed_out ? `超過 ${dur(this.limit(j))}沒結束，已停止`
        : adopted ? 'codex-runner 重新啟動時，這一件的 codex 程序已經不在，事件裡也沒有完成的紀錄'
          : signal ? `codex 被 ${signal} 結束` : `codex 結束碼 ${code}`)
      const t = tail(stderr.trim(), 30, 3000)
      j.result_text = [`Codex 這一件沒做完：${why}。`, ev.error ? `\nCodex 回報的錯誤：${cut(ev.error, 500)}` : '',
        t ? `\n錯誤輸出的最後幾行：\n\`\`\`\n${t}\n\`\`\`` : '\n（沒有錯誤輸出）'].join('\n').trim()
      j.files = []; j.skipped_files = []
    }
    j.state = 'finishing'
    this.log('info', `${j.id}: codex ended (${code !== null ? `exit ${code}` : signal ?? 'gone'}${j.timed_out ? ', timed out' : ''}): ${j.outcome}${j.files?.length ? `, ${j.files.length} file(s)` : ''}`)
    this.changed()
    void this.report(j)
  }

  // ---------------------------------------------------------------- finish: the reports (each step once, again until it lands)
  private async report(j: Job): Promise<void> {
    if (this.reporting.has(j.id) || this.stopped) return
    this.reporting.add(j.id)
    j.steps ??= {}; j.uploads ??= {}
    let retry = false
    try {
      if (j.dev && !j.steps.branch) {
        await this.pushDev(j)
        j.steps.branch = true; this.save()
      }
      // the files
      const ids: string[] = []
      for (const rel of j.files ?? []) {
        if (!j.uploads[rel]) {
          const name = rel === `last-${j.n}.txt` ? `codex-answer-${j.n}.md` : basename(rel)
          let r: Answer = null
          try { r = await this.onsen.upload(join(j.dir!, rel), name, rel === `last-${j.n}.txt` ? 'text/markdown' : mimeOf(rel), `codex-runner:${j.id}:${rel}`) } catch (e) { r = null; this.stats.last_error = String(e) }
          if (r && (r.status === 200 || r.status === 201) && r.json?.data?.id) j.uploads[rel] = String(r.json.data.id)
          else if (r && [400, 403, 404, 409, 413].includes(r.status)) { j.uploads[rel] = '-'; (j.skipped_files ??= []).push(`${rel}（Onsen 不收：HTTP ${r.status}）`); this.log('warn', `${j.id}: ${rel} not uploaded: HTTP ${r.status} ${JSON.stringify(r.json?.error ?? r.json?.detail ?? '').slice(0, 200)}`) }
          else { retry = true; continue }
          this.save()
        }
        if (j.uploads[rel] && j.uploads[rel] !== '-') ids.push(j.uploads[rel]!)
      }
      if (retry) return
      const fileLines = (j.files ?? []).filter(r => j.uploads![r] && j.uploads![r] !== '-')
      if (!j.steps.reply) {
        const r = j.source === 'call' ? await this.reply(j, ids, fileLines) : await this.answerNew(j, ids)
        if (r === 'retry') return void (retry = true)
        if (r === 'refused') j.outcome = 'failed'
        j.steps.reply = true; this.save()
      }
      const outcome = j.outcome === 'completed' ? 'completed' : j.timed_out || j.signal || (!j.why && j.pid && j.exit == null) ? 'cut' : 'error'
      if (this.claims.owns(j.item_id, j.claim_id)) {
        this.claims.report(j.item_id, outcome, { ...(j.response_message_ids ? { response_message_ids: j.response_message_ids } : {}),
          ...(outcome === 'cut' ? { half_done: !!j.dir && madeBy(j.dir, j.before ?? {}, j.dev ? 'repo' : undefined).length > 0 } : {}) })
      }
      j.state = j.outcome === 'completed' ? 'done' : 'failed'
      if (j.outcome === 'completed') this.stats.completed++; else this.stats.failed++
      this.after(j)
    } catch (err) {
      this.log('warn', j.id + ': report failed: ' + err)
      retry = true
    } finally {
      this.reporting.delete(j.id)
      if (retry) { this.stats.reports_retried++; this.save(); this.later(this.cfg.retryMs, () => void this.report(j)) }
    }
  }
  /** the job left the busy set: the turn ends when nothing else is busy; the next ones start */
  private after(j: Job): void {
    this.state.last_activity_at = this.iso()
    this.closeSpanIfIdle(j.outcome === 'failed' ? 'failed' : 'done')
    this.log('info', `${j.id}: ${j.state}${j.why && j.state === 'skipped' ? ` (${j.why})` : ''}`)
    this.changed()
    this.peek.reset()
  }
  private skippedList(j: Job, budget: number): string {
    const sk = j.skipped_files ?? []
    if (!sk.length) return ''
    const lines: string[] = []
    let used = 0
    for (const x of sk) {
      const l = `- ${x}`
      if (used + l.length + 1 > budget) break
      lines.push(l); used += l.length + 1
    }
    const rest = sk.length - lines.length
    return `\n\n${lines.join('\n')}${rest ? `${lines.length ? '\n' : ''}- …另外 ${rest} 個沒有附上（在 Mac mini 的 ${j.dir ?? '它的資料夾'}）` : ''}`
  }
  /** the line that names the session's thread (a Call's result, the reply): how the caller goes on in it */
  private threadLine(j: Job): string {
    return j.thread ? `\n\n（Codex 對話串 ${j.thread}：要它在同一段接著做，reply_to 這一則，或送的時候帶 thread=${j.thread}；不帶的是新的一段）` : ''
  }
  /** what the reply answers: the item's own number; a follow-up with none, the number of the Call that started its session (never new: a peer_call
   *  without reply_to_id would be a new Call from Codex) */
  private replyNumber(j: Job): number | null {
    return j.number ?? this.state.sessions[j.key]?.first_number ?? null
  }
  /** the answer to a peer's Call or follow-up, in its inbox (it reaches the caller as every Call's answer does), carrying the session's thread */
  private async reply(j: Job, ids: string[], files: string[]): Promise<'ok' | 'retry' | 'refused'> {
    const attachments = files.map((rel, i) => `- ${basename(rel)}：${join(j.dir!, rel)}\n  ${this.cfg.base}/v1/files/${ids[i]}`)
    const list = attachments.length ? '\n\n附件：\n' + cut(attachments.join('\n'), 600) : ''
    const more = this.skippedList(j, 500) + this.devLine(j) + this.threadLine(j)
    const full = files.indexOf(`last-${j.n}.txt`)
    const note = full >= 0 ? `\n\n（全文在附件 codex-answer-${j.n}.md）` : `\n\n（全文在 Mac mini 的 ${join(j.dir ?? '', `last-${j.n}.txt`)}）`
    const answer = j.result_text ?? ''
    const extras = list + more
    const text = answer.length + extras.length <= SEND_TEXT_MAX ? answer + extras
      : cut(answer, Math.max(0, SEND_TEXT_MAX - extras.length - note.length)) + note + extras
    let r: Answer = null
    try {
      r = await this.onsen.req('POST', '/send', { to: j.caller, kind: 'peer_call', no_reply: true, dedupe: `codex-reply:${j.item_id}:${j.claim_id}`,
        // no_reply: the answer is the result; the caller owes Codex nothing for it, and an answer to it would be new work for Codex (takes_work), answered
        // again, up to the hop limit (Chiron mesh 12558: his lanes held each result as a call owed an answer)
        payload: { text, reply_to_id: this.replyNumber(j), no_reply: true, ...(j.thread ? { thread: j.thread, hop: (j.hop ?? 0) + 1 } : {}) },
        refs: { thread: j.thread, ...(j.call_id ? { call: j.call_id } : {}) }, ...(ids.length ? { attachment_file_ids: ids } : {}) })
    } catch (e) { this.stats.last_error = String(e) }
    if (r?.status === 200 && r.json?.results?.[0]?.to === j.caller) {
      const id = r.json.results[0].message_id
      if (typeof id === 'string' && /^cm\d+$/.test(id)) j.response_message_ids = [id]
      return 'ok'
    }
    if (r && refusedForGood(r)) {
      this.log('warn', `${j.id}: reply to ${j.caller}: HTTP ${r.status} ${JSON.stringify(r.json?.detail ?? r.json?.error ?? '').slice(0, 200)}; not sent again`)
      return 'refused'
    }
    this.log('warn', `${j.id}: reply to ${j.caller}: ${r ? `HTTP ${r.status}` : 'no answer'}; sent again later`)
    return 'retry'
  }
  /** the answer's text in a conversation: the last message, and the files that did not go along */
  private answerBody(j: Job): string {
    const more = this.skippedList(j, 800) + this.devLine(j)
    return cut(cut(j.result_text ?? '', SAY_MAX - more.length) + more, SAY_MAX)
  }
  /** the answer to a person's message (person_message): written new-style into its conversation (Onsen 0.35.0, CONTRACT §7d 連接器這一頭):
   *  conversation_id, no agent / client / chat / client_msg_id / delivery. Onsen decides which bridge draws it (delivery pending until that
   *  bridge reports; sent at write when none has to) */
  private async answerNew(j: Job, ids: string[]): Promise<'ok' | 'retry' | 'refused'> {
    const rec = { conversation_id: j.conversation_id, reply_to_message_id: j.message_id, idem_key: `codex:out:item:${j.item_id}:${j.claim_id}`, sent_at: j.ended_at ?? this.iso(), body: this.answerBody(j),
      sender: 'main', turn_id: `codex-${j.id}`, ...(ids.length ? { attachment_file_ids: ids } : {}) }
    let r: Answer = null
    try { r = await this.onsen.req('POST', '/v1/messages', rec) } catch (e) { this.stats.last_error = String(e) }
    if (r?.status === 200 || r?.status === 201) {
      const d = r.json?.data ?? r.json ?? {}                        // /api/onsen/messages answers {id, duplicate, conversation_id, delivery}
      const id = d.message_id ?? d.id
      if (id == null) return 'retry'
      j.response_message_ids = [String(id)]
      this.log('info', `${j.id}: answer ${d.message_id ?? d.id ?? '?'} written into conversation ${d.conversation_id ?? j.conversation_id}`
        + `${d.duplicate ? ' (already there)' : ''}${d.delivery ? `, delivery ${d.delivery}` : ''}${ids.length ? `, ${ids.length} file(s)` : ''}`)
      return 'ok'
    }
    if (r && refusedForGood(r)) {
      this.log('warn', `${j.id}: answer not written into conversation ${j.conversation_id}: HTTP ${r.status} ${JSON.stringify(r.json?.detail ?? r.json?.error ?? '').slice(0, 200)}; not sent again`)
      return 'refused'
    }
    this.log('warn', `${j.id}: answer into conversation ${j.conversation_id}: ${r ? `HTTP ${r.status}` : 'no answer'}; sent again later`)
    return 'retry'
  }
  // ---------------------------------------------------------------- restart
  /** what the last process left: a job half started goes back to the queue; a run still going is followed; one gone is settled; reports go again */
  recover(): void {
    let n = 0
    for (const j of this.state.jobs) {
      if (j.state === 'starting') {
        if (this.claims.owns(j.item_id, j.claim_id)) this.claims.report(j.item_id, 'not_taken')
        j.state = 'skipped'; n++
      }
      else if (j.state === 'running') {
        n++
        if (alive(j.pid) !== false) {
          this.log('info', `${j.id}: its codex (pid ${j.pid}) is still running after the restart: followed to its end`)
          this.procs.set(j.id, null)
          this.armTimeout(j)
          const poll = (): void => { if (j.state !== 'running') return; if (alive(j.pid) !== false) this.later(this.cfg.adoptPollMs, poll); else this.exited(j, null, null) }
          this.later(this.cfg.adoptPollMs, poll)
        } else this.exited(j, null, null)
      } else if (j.state === 'finishing') { n++; void this.report(j) }
    }
    if (this.busy().length && !this.state.span) this.openSpan(this.busy()[0]!)
    if (!this.busy().length && this.state.span) this.closeSpanIfIdle('done')
    if (n) this.log('info', `restart: ${n} job(s) picked up from the state file`)
    this.save()
  }

  // ---------------------------------------------------------------- status
  /** CONTRACT §3's observation: online; the main session running (doing codex exec) while any job is busy, else idle; offline at a clean stop */
  observation(offline = false): Observation {
    const s = this.state, busy = this.busy(), reported = this.iso()
    const queued = s.jobs.filter(j => j.state === 'queued' || j.state === 'lookup').length
    const lease = { connector: this.mode.connector, held_item_ids: offline ? [] : this.claims.held() }
    if (offline) return { ...lease, presence: 'offline', presence_reason: 'disconnected', lifecycle: 'stopped', main_session_id: 'main',
      sessions: [{ id: 'main', kind: 'main', thread_id: null, activity: 'unknown', activity_since: null, turn: null, doing: null, blockers: [], last_turn: s.last_turn }],
      background: null, queue: { pending: queued, unread_by_member: 0 }, last_activity_at: s.last_activity_at, reported_at: reported, evidence: { source: 'runtime', confidence: null } } as any
    const run = !!busy.length && !!s.span
    return { ...lease, presence: 'online', presence_reason: null, lifecycle: 'ready', main_session_id: 'main',
      sessions: [{ id: 'main', kind: 'main', thread_id: null, activity: run ? 'running' : 'idle', activity_since: run ? s.span!.started_at : (s.idle_since ?? reported),
        turn: run ? { id: s.span!.id, started_at: s.span!.started_at, trigger: s.span!.trigger } : null,
        doing: run ? { kind: 'tool', tool: TOOL, since: s.span!.started_at } : null, blockers: [], last_turn: s.last_turn }],
      background: { agents: 0, shells: 0, tasks: busy.length, monitors: 0 }, queue: { pending: queued, unread_by_member: 0 },
      last_activity_at: s.last_activity_at, reported_at: reported, evidence: { source: 'runtime', confidence: null } } as Observation
  }
  health(): Record<string, unknown> {
    return { ...this.stats, busy: this.busy().map(j => j.id), queued: this.state.jobs.filter(j => j.state === 'queued').length, take: { active: this.mode.active, held: this.claims.held() }, observation: this.obs.health() }
  }
}

// ------------------------------------------------------------------ one instance
function lock(stateDir: string): boolean {
  const f = join(stateDir, 'runner.pid')
  try {
    const pid = Number(readFileSync(f, 'utf8').trim())
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); if (/codex-runner/.test(r.stdout)) return false } catch {}
    }
  } catch {}
  writeFileSync(f, String(process.pid), { mode: 0o600 })
  return true
}

async function main(): Promise<void> {
  const cfg = configFromEnv()
  const args = process.argv.slice(2)
  const onsen = new Onsen(cfg.base, cfg.credentialFile)
  if (args.includes('--setup')) {
    for (const l of setupCodexHome(cfg, { force: args.includes('--force') })) console.log(l)
    const bad = codexHomeReady(cfg)
    console.log(bad ? `not ready: ${bad}` : `ready: CODEX_HOME=${cfg.codexHome} HOME=${cfg.childHome}`)
    process.exit(bad ? 1 : 0)
  }
  if (args.includes('--whoami') || args.includes('--profile')) {
    if (!onsen.token()) { console.error(`no mesh credential in ${cfg.credentialFile}`); process.exit(2) }
    if (args.includes('--profile')) {
      const prof = { display_name: process.env.CODEX_RUNNER_DISPLAY_NAME || DISPLAY_NAME, role: process.env.CODEX_RUNNER_ROLE || ROLE }
      let r = await onsen.req('PUT', `/v1/members/${cfg.agent}/profile`, { ...prof, takes_work: true })
      if (r?.status === 400) { console.error('this Onsen does not take takes_work (before 0.29.2): the profile without it'); r = await onsen.req('PUT', `/v1/members/${cfg.agent}/profile`, prof) }
      console.log(`PUT profile: HTTP ${r?.status} ${r?.json?.data?.line ?? JSON.stringify(r?.json?.error ?? '')}`)
      if (r?.status === 404) console.error(`${cfg.agent} is not an Onsen member yet: start the runner first (its first status report makes the member), then run --profile again`)
      if (r?.status !== 200) process.exit(1)
    }
    const me = await onsen.req('GET', '/v1/me')
    const m = await onsen.req('GET', `/v1/members/${cfg.agent}`)
    console.log(`me: HTTP ${me?.status} ${JSON.stringify(me?.json?.data ?? me?.json?.error ?? null)}`)
    console.log(`member: HTTP ${m?.status} ${m?.json?.data?.line ?? JSON.stringify(m?.json?.error ?? null)}`)
    process.exit(me?.status === 200 ? 0 : 1)
  }
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  if (!lock(cfg.stateDir)) { console.error('another codex-runner is running (runner.pid)'); process.exit(1) }
  const r = new CodexRunner(cfg)
  let stopping = false
  const stop = (sig: string): void => {
    if (stopping) return
    stopping = true
    r.log('info', `${sig}: stopping (runs going on keep running; the next start follows them)`)
    void r.stop().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 8_000).unref()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  await r.start()
}

if (import.meta.main) void main()
