// codex-runner.ts — WO-184 part 2 (Chiron's ticket section 二; Joey TG chiron:2642 「Codex 你給他身分讓他正式註冊，然後正常用我們的 Onsen」, Onsen
// #42397 「你現在跟 Codex 的溝通是否也可以升級到是使用 Onsen？」): Codex is the Onsen member `codex`, and this resident program on the Mac mini is the
// part of it that takes work. An agent hands it work with send_to_agent(to: "codex", line: "call"), Joey talks to it on the Onsen page; the request, the
// progress and the result (the files it makes included) all live in Onsen.
//
//   take      the codex credential, the pull every daemon uses (onsen-inbox.ts OnsenPuller: GET /inbox?after=&wait=25, POST /inbox/ack) for the Calls,
//             and the forms inbox (GET /forms/inbox?wait=25, POST /forms/ack) for what Joey says on the page (items marked `say`). Every item is first
//             written to this program's state file, then acked. Not taken as work: a reply, a silent notice, a mail bell, a press, a poke that is no Call.
//   accept    PUT /v1/calls/<id>/state accepted; the folder ~/onsen-codex/<Onsen conversation id>/ (its .codex-runner/ holds this program's files);
//             the item's attachments downloaded into it with the credential (only from Onsen's own origin).
//   run       PUT running, then `codex exec --skip-git-repo-check -s workspace-write -C <dir> --json -o <dir>/last-<n>.txt [-i <image>…] -- "<text>"`,
//             stdin /dev/null; from the second item of the same Onsen conversation on, `… resume <that conversation's first session id> …` (the
//             session id is thread.started's thread_id in the --json events). stdout and stderr go to files, so a restart can pick the run up.
//   finish    completed: result.body = the last message, the files new or changed in the folder by this run (≤ 20, each ≤ 25 MB) POST /files-ed and
//             listed in result.attachment_file_ids. A non-zero exit, or CODEX_RUNNER_TIMEOUT_S (1800) without finishing (SIGTERM to its process
//             group, SIGKILL 10 s later): failed, result.body = the error and the last lines of stderr. A peer's Call also gets a reply (POST /send,
//             peer_call, reply_to_id = its number) so the answer reaches the caller's session as every Call's answer does; a page message gets the
//             answer recorded in Joey's conversation with Codex (POST /messages, its files attached) and its delivery facts.
//   at most   CODEX_RUNNER_MAX (3) at once; the rest stay `queued` in Onsen (queued is Onsen's own state: no PUT until one is started). Two items of
//             one conversation never run at once: the second resumes the session of the first, so it waits for it.
//   status    PUT /v1/members/codex/observation (onsen-observation.ts, at each change and every 15 s): online while alive; the main session running
//             with doing {kind: tool, tool: "codex exec"} while any item is being worked on, else idle; offline at a clean stop.
//   restart   a run the state file says is running: its process still alive → followed to its end; gone → completed when its events show the turn
//             completed and the last message is there, else failed with a note. Reports a restart interrupted are sent again (each is idempotent).
//   scope     never starts anything on its own, never reads a mailbox, never posts on the wall; the credential goes only to Onsen and is never logged.
//
// Run: bun codex-runner.ts (launchd com.btai.codex-runner, see README.md). One-shot: --whoami, --profile (sets Codex's display name and role in Onsen).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, extname, join, relative } from 'node:path'
import { OnsenInbox, OnsenPuller, itemKey, type HandResult, type PullItem } from '../onsen-inbox.ts'
import { ObservationPut } from '../onsen-observation.ts'
import type { Observation } from '../screen-status.ts'

// ------------------------------------------------------------------ configuration
export const ROLE = '外部模型（OpenAI Codex CLI）：審設計、寫程式、生圖'
export const DISPLAY_NAME = 'Codex'
export const TOOL = 'codex exec'
const SEND_TEXT_MAX = 4000            // Onsen /send payload.text
const RESULT_MAX = 30_000             // a Call's result body (the full answer is attached as a file beyond it)
const SAY_MAX = 100_000               // an answer recorded in Joey's conversation (Onsen keeps up to 200 000)

export type Cfg = {
  agent: string; base: string; credentialFile: string; host: string; root: string; stateDir: string; logFile: string
  codexBin: string; sandbox: string; max: number; timeoutMs: number; killGraceMs: number; waitS: number
  maxFiles: number; maxFileBytes: number; lookupDelayMs: number; retryMs: number; adoptPollMs: number
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void; now?: () => number; heartbeatMs?: number
}
const num = (v: string | undefined, d: number): number => { const n = Number(v); return v != null && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : d }
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
    maxFiles: 20, maxFileBytes: 25 * 1024 * 1024, lookupDelayMs: 35_000, retryMs: 15_000, adoptPollMs: 2_000,
  }
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
  id: string; source: 'call' | 'say'; key: string; text: string; attachments: Att[]; state: JobState; received_at: string
  call_id?: string | null; number?: number | null; caller?: string; kind?: string; no_reply?: boolean; lookup_at?: string
  message_id?: string; chat?: string
  dir?: string; n?: number; resumed?: string | null; images?: string[]; notes?: string[]
  started_at?: string; ended_at?: string; pid?: number | null; exit?: number | null; signal?: string | null; timed_out?: boolean
  before?: Record<string, string>
  outcome?: 'completed' | 'failed'; result_text?: string; files?: string[]; skipped_files?: string[]
  uploads?: Record<string, string>; steps?: Record<string, boolean>; why?: string
}
export type Conv = { dir: string; conversation_id: string | null; session_id: string | null; runs: number }
export type State = { v: 1; seq: number; jobs: Job[]; convs: Record<string, Conv>; says: string[]
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
/** a key as a folder name */
const folderOf = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'conversation'
const tail = (s: string, lines: number, chars: number): string => { const t = s.split('\n').slice(-lines).join('\n'); return t.length > chars ? '…' + t.slice(-chars) : t }
const cut = (s: string, n: number): string => s.length <= n ? s : s.slice(0, n - 1) + '…'
const dur = (ms: number): string => ms >= 60_000 ? `${Math.round(ms / 60_000)} 分鐘` : `${Math.round(ms / 1000)} 秒`
const size = (n: number): string => n >= 1_048_576 ? `${Math.round(n / 1_048_576)} MB` : `${n} bytes`

// ------------------------------------------------------------------ the folder: what a run made
const SCAN_MAX = 5000
/** every regular file under dir (relative path → size:mtime), hidden names and symlinks skipped, at most SCAN_MAX */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  let n = 0
  const walk = (d: string, depth: number): void => {
    if (depth > 6 || n >= SCAN_MAX) return
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const name of names.sort()) {
      if (name.startsWith('.') || n >= SCAN_MAX) continue
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
export function madeBy(dir: string, before: Record<string, string>): string[] {
  const now = snapshot(dir)
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
const alive = (pid: number | null | undefined): boolean => {
  if (!pid) return false
  try { process.kill(pid, 0) } catch (e: any) { return e?.code === 'EPERM' }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return r.status === 0 && /codex/.test(r.stdout)
}
const killGroup = (pid: number, sig: NodeJS.Signals): void => {
  try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch {} }
}

// ------------------------------------------------------------------ the runner
export class CodexRunner {
  readonly onsen: Onsen
  state: State
  private readonly inbox: OnsenInbox
  private readonly puller: OnsenPuller
  private readonly obs: ObservationPut
  private procs = new Map<string, ChildProcess | null>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private reporting = new Set<string>()
  private stopped = false
  private formsLoop: Promise<void> | null = null
  private formsWake: (() => void) | null = null
  readonly stats = { taken: 0, ignored: 0, says: 0, runs: 0, completed: 0, failed: 0, reports_retried: 0, last_error: null as string | null }

  constructor(readonly cfg: Cfg) {
    this.onsen = new Onsen(cfg.base, cfg.credentialFile)
    mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
    this.state = this.load()
    this.inbox = new OnsenInbox({ file: join(cfg.stateDir, 'onsen-inbox.json'), log: (l, m) => this.log(l, m) })
    this.puller = new OnsenPuller({ req: (m, p, b, t) => this.onsen.req(m, p, b, t), base: cfg.base, inbox: this.inbox, host: cfg.host,
      deliver: it => this.deliver(it), log: (l, m) => this.log(l, m), waitS: cfg.waitS })
    this.obs = new ObservationPut({ agent: cfg.agent, on: () => !this.stopped, put: (o, t) => this.onsen.req('PUT', `/v1/members/${cfg.agent}/observation`, o, t),
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
    const empty: State = { v: 1, seq: 0, jobs: [], convs: {}, says: [], span: null, last_turn: null, idle_since: null, last_activity_at: null }
    try {
      const j = JSON.parse(readFileSync(join(this.cfg.stateDir, 'state.json'), 'utf8'))
      if (j && j.v === 1 && Array.isArray(j.jobs)) return { ...empty, ...j }
    } catch {}
    return empty
  }
  /** the state file (atomic, 0600). A stopped runner writes it once more (stop) and never again: the next one owns it */
  save(force = false): void {
    if (this.stopped && !force) return
    const s = this.state
    const done = s.jobs.filter(j => !OPEN.has(j.state))
    if (done.length > KEEP_DONE) { const drop = new Set(done.slice(0, done.length - KEEP_DONE).map(j => j.id)); s.jobs = s.jobs.filter(j => !drop.has(j.id)) }
    if (s.says.length > 2000) s.says = s.says.slice(-2000)
    const f = join(this.cfg.stateDir, 'state.json'), tmp = f + '.tmp'
    try { writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 }); renameSync(tmp, f) } catch (e) { this.log('error', `state not written: ${e}`) }
  }

  // ---------------------------------------------------------------- life
  async start(): Promise<void> {
    mkdirSync(this.cfg.root, { recursive: true, mode: 0o700 })
    this.state.idle_since ??= this.iso()
    this.log('info', `codex-runner up: ${this.cfg.agent} on ${this.cfg.host}, Onsen ${this.cfg.base}, at most ${this.cfg.max} at once, timeout ${this.cfg.timeoutMs / 1000} s, folders under ${this.cfg.root}`)
    if (!this.onsen.token()) this.log('warn', `no mesh credential in ${this.cfg.credentialFile}: nothing is taken until it is there (read again on every request)`)
    this.recover()
    this.puller.start()
    this.formsLoop = this.pullForms()
    this.changed()
    this.pump()
  }
  /** stop taking work; a clean stop reports offline. Runs going on are left to finish (their own process group): the next start follows them. */
  async stop(o: { offline?: boolean } = {}): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.obs.stop()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.formsWake?.()
    await Promise.allSettled([this.puller.stop(), this.formsLoop])
    this.save(true)
    if (o.offline !== false) {
      try { await this.onsen.req('PUT', `/v1/members/${this.cfg.agent}/observation`, this.observation(true), 5_000) } catch {}
    }
    this.log('info', 'codex-runner stopped')
  }
  private later(ms: number, fn: () => void): void {
    if (this.stopped) return
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn() }, Math.max(0, ms))
    this.timers.add(t)
  }
  private changed(): void { this.save(); if (!this.stopped) this.obs.update(this.observation()) }

  // ---------------------------------------------------------------- take: the Calls
  /** a pulled item → a job (written before Onsen hears the ack), or nothing */
  async deliver(it: PullItem): Promise<HandResult> {
    if (this.stopped) throw new Error('stopping: left pending for the next start')   // the puller keeps it, in order
    const key = itemKey(it)
    if (key && this.inbox.seen(key)) return 'duplicate'
    const p = (it.payload ?? {}) as Record<string, any>
    const callId = (it as any).call_id != null ? String((it as any).call_id) : null
    if (callId && this.state.jobs.some(j => j.call_id === callId)) { if (key) this.inbox.record(key); return 'duplicate' }
    const n = Number.isInteger(p.msg_id) ? p.msg_id : Number.isInteger(it.refs?.btcc_msg_id) ? it.refs!.btcc_msg_id as number : null
    let why: string | null = null
    if (it.kind === 'action_control') why = 'a press for a Telegram daemon'
    else if (p.reply_to_id != null) why = 'a reply (codex calls nobody)'
    else if (p.urgency === 'silent') why = 'a silent notice'
    else if (it.kind === 'peer_mail') why = 'a mail bell (codex reads no mailbox)'
    else if (!callId && !(it.kind === 'peer_call' && n != null)) why = 'not a Call'
    if (why) {
      this.stats.ignored++
      this.log('info', `inbox seq ${it.seq} from ${it.sender} (${it.kind ?? '?'}): not taken: ${why}`)
      if (key) this.inbox.record(key)
      return 'delivered'
    }
    const atts: Att[] = Array.isArray((it as any).attachments) ? (it as any).attachments.map((a: any) => ({ name: a?.name ?? null, mime: a?.mime ?? null, kind: a?.kind ?? null, url: a?.url ?? null })) : []
    const j: Job = { id: `j${++this.state.seq}`, source: 'call', key: `call:${it.sender}`, text: String(p.text ?? ''), attachments: atts,
      state: callId ? 'queued' : 'lookup', received_at: this.iso(), call_id: callId, number: n, caller: it.sender, kind: it.kind ?? 'peer_call',
      no_reply: (it as any).no_reply === true || p.no_reply === true }
    if (!callId) j.lookup_at = this.iso(this.now() + this.cfg.lookupDelayMs)
    this.state.jobs.push(j)
    this.stats.taken++
    this.log('info', `${j.id}: ${callId ? `Call ${callId}` : `peer_call #${n} without a Call yet (looked up in ${Math.round(this.cfg.lookupDelayMs / 1000)} s)`} from ${it.sender}, ${atts.length} attachment(s): queued`)
    this.changed()                                                // the job is on disk before its key is (a crash between: taken again, not lost)
    if (key) this.inbox.record(key)
    if (!callId) this.later(this.cfg.lookupDelayMs, () => void this.lookup(j))
    this.pump()
    return 'delivered'
  }
  /** a peer_call that came without its Call id (Onsen makes it in /send's transaction, or its sweep within 30 s): asked once; none → not a Call */
  private async lookup(j: Job): Promise<void> {
    if (j.state !== 'lookup') return
    let r: Answer = null
    try { r = await this.onsen.req('GET', `/v1/calls?recipient=${encodeURIComponent(this.cfg.agent)}&number=${j.number}&caller=${encodeURIComponent(j.caller ?? '')}`) } catch {}
    const c = r?.status === 200 && Array.isArray(r.json?.items) ? r.json.items[0] : null
    if (c?.id != null && !['completed', 'failed', 'cancelled'].includes(c.state)) {
      j.call_id = String(c.id); j.state = 'queued'
      this.log('info', `${j.id}: its Call is ${j.call_id}: queued`)
    } else {
      j.state = 'skipped'; j.why = r ? 'no Call for it (a poke or a notice): not work' : 'Onsen did not answer the lookup'
      this.log('info', `${j.id}: ${j.why}`)
    }
    this.changed()
    this.pump()
  }

  // ---------------------------------------------------------------- take: what Joey says on the page
  private async pullForms(): Promise<void> {
    let backoff = 0
    while (!this.stopped) {
      try {
        const r = await this.onsen.req('GET', `/forms/inbox?wait=${this.cfg.waitS}`, undefined, (this.cfg.waitS + 15) * 1000)
        if (!r) { await this.pause(60_000); continue }
        if (r.status !== 200) throw new Error(`GET /forms/inbox: HTTP ${r.status}`)
        const items: any[] = Array.isArray(r.json?.items) ? r.json.items : []
        const ids: number[] = []
        for (const it of items) {
          const mid = String(it?.id ?? '')
          if (!mid) continue
          ids.push(Number(it.id))
          if (this.state.says.includes(mid)) continue
          this.state.says.push(mid)
          if (it.say !== true) { this.stats.ignored++; this.log('info', `forms inbox ${mid}: a form answer, not a message: not taken`); continue }
          const atts: Att[] = Array.isArray(it.attachments) ? it.attachments.map((a: any) => ({ name: a?.name ?? null, mime: a?.mime ?? null, kind: a?.kind ?? null, url: a?.url ?? null })) : []
          const j: Job = { id: `j${++this.state.seq}`, source: 'say', key: `say:${it.chat}`, text: String(it.body ?? ''), attachments: atts, state: 'queued',
            received_at: this.iso(), message_id: mid, chat: String(it.chat ?? ''), caller: 'joey' }
          this.state.jobs.push(j)
          this.stats.says++
          this.log('info', `${j.id}: message ${mid} from the page (chat ${j.chat}), ${atts.length} attachment(s): queued`)
          void this.facts(j, ['delivered'])
        }
        if (items.length) {
          this.changed()
          const a = await this.onsen.req('POST', '/forms/ack', { ids }, 10_000)
          if (a?.status !== 200) this.log('warn', `forms ack ${ids.join(',')}: HTTP ${a?.status ?? 'no credential'} (given again: already taken, dropped)`)
          this.pump()
        }
        backoff = 0
      } catch (e) {
        if (this.stopped) break
        backoff = backoff ? Math.min(backoff * 2, 60_000) : 2_000
        this.stats.last_error = `${e instanceof Error ? e.message : e}`.slice(0, 200)
        this.log('warn', `forms inbox: ${this.stats.last_error}; again in ${backoff / 1000} s`)
        await this.pause(backoff)
      }
    }
  }
  private pause(ms: number): Promise<void> {
    return new Promise(res => { const t = setTimeout(() => { this.formsWake = null; res() }, ms); this.formsWake = () => { clearTimeout(t); this.formsWake = null; res() } })
  }

  // ---------------------------------------------------------------- at most N at once, one per conversation
  busy(): Job[] { return this.state.jobs.filter(j => BUSY.has(j.state)) }
  pump(): void {
    if (this.stopped) return
    const busy = this.busy()
    const keys = new Set(busy.map(j => j.key))
    let free = this.cfg.max - busy.length
    for (const j of this.state.jobs) {
      if (free <= 0) break
      if (j.state !== 'queued' || keys.has(j.key)) continue
      keys.add(j.key)
      free--
      void this.begin(j)
    }
  }
  private openSpan(j: Job): void {
    if (this.state.span) return
    const c = this.state.convs[j.key]
    this.state.span = { id: `codex-turn-${this.now()}`, started_at: this.iso(),
      trigger: j.source === 'say' && j.message_id ? { kind: 'message', conversation_id: c?.conversation_id ?? null, message_id: j.message_id } : { kind: 'other' } }
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
      const conv = await this.conversation(j)
      if (j.source === 'call') {
        const ok = await this.callState(j, 'accepted')
        if (ok === 'gone') { j.state = 'skipped'; j.why = 'the Call is over (cancelled, or done elsewhere) before it started'; this.log('info', `${j.id}: ${j.why}`); this.after(j); return }
      }
      j.dir = conv.dir
      mkdirSync(join(conv.dir, '.codex-runner'), { recursive: true, mode: 0o700 })
      await this.fetchAttachments(j)
      conv.runs++
      j.n = conv.runs
      j.resumed = conv.session_id
      j.before = snapshot(conv.dir)
      j.started_at = this.iso()
      if (this.stopped) return                                      // stopping: still 'starting' on disk, queued again at the next start
      if (j.source === 'call') await this.callState(j, 'running')
      else void this.facts(j, ['in_session', 'seen'])
      if (this.stopped) return
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
  /** the conversation's folder and session (state.convs, keyed call:<caller> / say:<chat>); its Onsen id asked once */
  private async conversation(j: Job): Promise<Conv> {
    let c = this.state.convs[j.key]
    if (c) return c
    let cid: string | null = null
    try {
      const r = j.source === 'call' && j.call_id ? await this.onsen.req('GET', `/v1/calls/${encodeURIComponent(j.call_id)}`)
        : j.message_id ? await this.onsen.req('GET', `/v1/messages/${encodeURIComponent(j.message_id)}`) : null
      const v = r?.status === 200 ? r.json?.data?.conversation_id : null
      if (typeof v === 'string' && v || typeof v === 'number') cid = String(v)
    } catch {}
    const dir = join(this.cfg.root, folderOf(cid ?? j.key.replace(':', '-')))
    c = this.state.convs[j.key] = { dir, conversation_id: cid, session_id: null, runs: existsSync(dir) ? this.runsIn(dir) : 0 }
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
      if (!a.url) { j.notes.push(`附件 ${name} 沒有網址（Onsen 沒存那個檔）`); continue }
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
    const text = [j.text.trim() || '（只有附件）', ...(j.notes?.length ? ['', ...j.notes.map(n => `（${n}）`)] : [])].join('\n')
    return ['exec', '--skip-git-repo-check', '-s', this.cfg.sandbox, '-C', j.dir!, ...(j.resumed ? ['resume', j.resumed] : []), ...out, ...imgs, '--', text]
  }
  private spawnRun(j: Job): void {
    const meta = join(j.dir!, '.codex-runner')
    const out = openSync(join(meta, `run-${j.n}.jsonl`), 'a', 0o600), err = openSync(join(meta, `run-${j.n}.stderr`), 'a', 0o600)
    let child: ChildProcess
    try {
      child = spawn(this.cfg.codexBin, this.argv(j), { cwd: j.dir!, detached: true, stdio: ['ignore', out, err], env: process.env })
    } finally { closeSync(out); closeSync(err) }
    j.pid = child.pid ?? null
    j.state = 'running'
    this.stats.runs++
    this.procs.set(j.id, child)
    this.log('info', `${j.id}: codex ${j.resumed ? `resume ${j.resumed}` : 'new session'} in ${j.dir} (run ${j.n}, pid ${j.pid}, ${j.images?.length ?? 0} image(s))`)
    this.changed()
    child.on('error', e => { if (j.state === 'running') { j.why = `無法啟動 codex（${e.message}）`; this.exited(j, null, null) } })
    child.on('exit', (code, signal) => this.exited(j, code, signal))
    this.armTimeout(j)
  }
  private armTimeout(j: Job): void {
    const left = Date.parse(j.started_at!) + this.cfg.timeoutMs - this.now()
    this.later(left, () => {
      if (j.state !== 'running' || !j.pid) return
      j.timed_out = true
      this.log('warn', `${j.id}: ${Math.round(this.cfg.timeoutMs / 1000)} s without finishing: SIGTERM to its process group, SIGKILL in ${this.cfg.killGraceMs / 1000} s`)
      this.save()
      killGroup(j.pid, 'SIGTERM')
      this.later(this.cfg.killGraceMs, () => { if (j.pid) killGroup(j.pid, 'SIGKILL') })   // the whole group: what codex started dies with it
      // an adopted run has no exit event: the poll sees it go
    })
  }
  /** the process ended (its exit event, or the poll of an adopted one): what it left decides */
  private exited(j: Job, code: number | null, signal: string | null): void {
    if (j.state !== 'running' || this.stopped) return              // stopped: the next start follows it (restart)
    this.procs.delete(j.id)
    j.exit = code; j.signal = signal; j.ended_at = this.iso()
    const meta = join(j.dir!, '.codex-runner')
    const ev = readEvents(join(meta, `run-${j.n}.jsonl`))
    const conv = this.state.convs[j.key]
    if (ev.session && conv && !conv.session_id) conv.session_id = ev.session
    let last = ''
    try { last = readFileSync(join(j.dir!, `last-${j.n}.txt`), 'utf8').trim() } catch {}
    const adopted = code === null && signal === null && !j.why
    const ok = !j.timed_out && !j.why && (adopted ? ev.completed && !!last : code === 0)
    if (ok) {
      j.outcome = 'completed'
      j.result_text = last || '（Codex 沒有留下最後一則訊息）'
      const made = madeBy(j.dir!, j.before ?? {})
      const big: string[] = [], over: string[] = []
      const files: string[] = []
      for (const rel of made.slice().reverse()) {            // the newest first when more than the limit were made
        let size = 0
        try { size = statSync(join(j.dir!, rel)).size } catch { continue }
        if (size > this.cfg.maxFileBytes) big.push(rel)
        else if (files.length < this.cfg.maxFiles) files.push(rel)
        else over.push(rel)
      }
      if (j.result_text.length > RESULT_MAX) {                 // the full answer goes along as a file: it takes one of the slots
        if (files.length >= this.cfg.maxFiles) over.push(files.pop()!)
        files.unshift(`last-${j.n}.txt`)
      }
      j.files = files.reverse()
      j.skipped_files = [...big.map(r => `${r}（超過 ${size(this.cfg.maxFileBytes)}，沒有附上）`), ...over.map(r => `${r}（超過 ${this.cfg.maxFiles} 個，沒有附上）`)]
    } else {
      j.outcome = 'failed'
      let stderr = ''
      try { stderr = readFileSync(join(meta, `run-${j.n}.stderr`), 'utf8') } catch {}
      const why = j.why ?? (j.timed_out ? `超過 ${dur(this.cfg.timeoutMs)}沒結束，已停止`
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
      if (j.source === 'call') {
        if (!j.steps.state && j.call_id) {
          const st = j.outcome === 'completed' ? 'completed' : 'failed'
          const body = cut(j.result_text ?? '', RESULT_MAX) + (j.skipped_files?.length ? `\n\n${j.skipped_files.map(s => `- ${s}`).join('\n')}` : '')
          let r = await this.put(j, st, { body: { format: 'markdown', text: body }, ...(ids.length ? { attachment_file_ids: ids } : {}) })
          if (r === 'gone' && ids.length) {                   // its files refused (swept after a long outage): the words still land
            r = await this.put(j, st, { body: { format: 'markdown', text: `${body}\n\n（${ids.length} 個檔案沒能附上；在 Mac mini 的 ${j.dir}）` } })
          }
          if (r === 'retry') return void (retry = true)
          if (r === 'gone') { j.steps.reply = true; this.log('warn', `${j.id}: the Call took no ${st} (over, or not ours): no reply sent`) }
          j.steps.state = true; this.save()
        }
        if (!j.steps.reply) {
          if (j.kind === 'peer_call' && j.number != null && !j.no_reply) {
            const r = await this.reply(j, ids, fileLines)
            if (r === 'retry') return void (retry = true)
          }
          j.steps.reply = true; this.save()
        }
      } else {
        if (!j.steps.facts_before) { if (!(await this.facts(j, ['delivered', 'in_session', 'seen']))) return void (retry = true); j.steps.facts_before = true }
        if (!j.steps.answer) {
          const r = await this.answer(j, ids)
          if (r === 'retry') return void (retry = true)
          j.steps.answer = true; this.save()
        }
        if (!j.steps.facts_end) { if (!(await this.facts(j, ['turn_end']))) return void (retry = true); j.steps.facts_end = true }
      }
      j.state = j.outcome === 'completed' ? 'done' : 'failed'
      if (j.outcome === 'completed') this.stats.completed++; else this.stats.failed++
      this.after(j)
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
    this.pump()
  }
  /** PUT /v1/calls/<id>/state; 'gone' when Onsen says the Call can no longer take it (over, not ours), 'retry' on no answer */
  private async put(j: Job, state: string, result?: Record<string, unknown>): Promise<'ok' | 'gone' | 'retry'> {
    let r: Answer = null
    try {
      r = await this.onsen.req('PUT', `/v1/calls/${encodeURIComponent(j.call_id!)}/state`, { state, session_id: 'main', at: this.iso(),
        ...(result ? { result } : {}) })
    } catch (e) { this.stats.last_error = String(e) }
    if (r?.status === 200) return 'ok'
    if (r && [400, 403, 404].includes(r.status)) {
      this.log('warn', `${j.id}: Call ${j.call_id} ${state}: HTTP ${r.status} ${JSON.stringify(r.json?.error?.message ?? r.json?.detail ?? '').slice(0, 200)}`)
      return 'gone'
    }
    this.log('warn', `${j.id}: Call ${j.call_id} ${state}: ${r ? `HTTP ${r.status}` : 'no answer'}; sent again later`)
    return 'retry'
  }
  /** accepted / running: a Call already over is 'gone' (it is not started); no answer: on we go (the end is what must land) */
  private async callState(j: Job, state: 'accepted' | 'running'): Promise<'ok' | 'gone' | 'retry'> {
    if (!j.call_id) return 'ok'
    const r = await this.put(j, state)
    if (r === 'gone' && state === 'accepted') {
      let c: Answer = null
      try { c = await this.onsen.req('GET', `/v1/calls/${encodeURIComponent(j.call_id)}`) } catch {}
      const st = c?.status === 200 ? c.json?.data?.state : null
      if (st && ['completed', 'failed', 'cancelled'].includes(st)) return 'gone'
      return 'ok'
    }
    return r
  }
  /** the answer to a peer's Call, in its inbox (it reaches the caller's session as every Call's answer does) */
  private async reply(j: Job, ids: string[], files: string[]): Promise<'ok' | 'retry'> {
    const list = files.length ? `\n\n附件（Onsen 的檔，用你的憑證取；Mac mini 上的路徑在後）：\n${files.map((rel, i) => `- ${basename(rel)}：${join(j.dir!, rel)}\n  ${this.cfg.base}/v1/files/${ids[i]}`).join('\n')}` : ''
    const more = j.skipped_files?.length ? `\n\n${j.skipped_files.map(s => `- ${s}`).join('\n')}` : ''
    const note = '\n\n（全文在 Onsen 這一通呼叫的結果）'
    let text = (j.result_text ?? '') + list + more
    if (text.length > SEND_TEXT_MAX) text = cut(j.result_text ?? '', SEND_TEXT_MAX - list.length - more.length - note.length - 1) + note + list + more
    text = cut(text, SEND_TEXT_MAX)
    let r: Answer = null
    try {
      r = await this.onsen.req('POST', '/send', { to: j.caller, kind: 'peer_call', payload: { text, reply_to_id: j.number }, dedupe: `codex-reply:${j.call_id ?? j.id}`,
        ...(ids.length ? { attachment_file_ids: ids } : {}) })
    } catch (e) { this.stats.last_error = String(e) }
    if (r?.status === 200) return 'ok'
    if (r && r.status >= 400 && r.status < 500 && ![401, 408, 425, 429].includes(r.status)) {
      this.log('warn', `${j.id}: reply to ${j.caller}: HTTP ${r.status} ${JSON.stringify(r.json?.detail ?? r.json?.error ?? '').slice(0, 200)}; not sent again`)
      return 'ok'
    }
    this.log('warn', `${j.id}: reply to ${j.caller}: ${r ? `HTTP ${r.status}` : 'no answer'}; sent again later`)
    return 'retry'
  }
  /** the answer to what Joey said on the page: recorded in his conversation with Codex, its files attached (POST /messages) */
  private async answer(j: Job, ids: string[]): Promise<'ok' | 'retry'> {
    const more = j.skipped_files?.length ? `\n\n${j.skipped_files.map(s => `- ${s}`).join('\n')}` : ''
    const body = cut(j.result_text ?? '', SAY_MAX) + more
    const rec = { agent: this.cfg.agent, client: 'telegram', chat: j.chat, direction: 'out', idem_key: `codex:out:${j.id}`, sent_at: j.ended_at ?? this.iso(),
      body, sender: 'main', client_msg_id: `cx-${j.id}`, turn_id: `codex-${j.id}`, ...(ids.length ? { attachment_file_ids: ids } : {}) }
    let r: Answer = null
    try { r = await this.onsen.req('POST', '/messages', rec) } catch (e) { this.stats.last_error = String(e) }
    if (r?.status === 200) {
      if (ids.length && r.json?.duplicate !== true && r.json?.attachments == null) {
        // an Onsen without attachment_file_ids on the record (before WO-184 part 2's Onsen change): the files are said, not lost
        this.log('warn', `${j.id}: Onsen took the answer without its ${ids.length} file(s) (attachment_file_ids not known there)`)
        try {
          await this.onsen.req('POST', '/messages', { ...rec, idem_key: `codex:out:${j.id}:files`, client_msg_id: `cx-${j.id}f`, attachment_file_ids: undefined,
            body: `（這一則的 ${ids.length} 個檔案沒能附上：Onsen 還不收訊息的附件。檔案在 Mac mini 的 ${j.dir}：${(j.files ?? []).join('、')}）` })
        } catch {}
      }
      return 'ok'
    }
    if (r && r.status >= 400 && r.status < 500 && ![401, 408, 425, 429].includes(r.status)) {
      this.log('warn', `${j.id}: answer not recorded: HTTP ${r.status} ${JSON.stringify(r.json?.detail ?? '').slice(0, 200)}; not sent again`)
      return 'ok'
    }
    return 'retry'
  }
  /** delivery facts on a page message (POST /deliveries/batch; each idempotent by its key): delivered at take; in_session and seen when its run
   *  starts (its turn codex-<job>); turn_end when it ends (done / failed, bound to it). True when Onsen took them */
  async facts(j: Job, states: Array<'delivered' | 'in_session' | 'seen' | 'turn_end'>): Promise<boolean> {
    if (j.source !== 'say' || !j.message_id) return true
    const ref = `form-${j.message_id}`
    const at = (s: string): string => s === 'delivered' ? j.received_at : s === 'turn_end' ? (j.ended_at ?? this.iso()) : (j.started_at ?? this.iso())
    const items = states.filter(s => s !== 'turn_end' || j.ended_at).map(s => ({ idem_key: `codex:${ref}:${s}`, agent: this.cfg.agent, client: 'telegram', chat: j.chat,
      client_msg_id: ref, state: s, at: at(s), by: 'main', ...(s !== 'delivered' ? { turn_id: `codex-${j.id}` } : {}),
      ...(s === 'turn_end' ? { outcome: j.outcome === 'completed' ? 'done' : 'failed', bound: [ref] } : {}) }))
    if (!items.length) return true
    let r: Answer = null
    try { r = await this.onsen.req('POST', '/deliveries/batch', { items }) } catch {}
    if (r?.status === 200) return true
    this.log('warn', `${j.id}: delivery facts ${states.join(',')}: ${r ? `HTTP ${r.status}` : 'no answer'}`)
    return !!r && r.status >= 400 && r.status < 500 && ![401, 408, 425, 429].includes(r.status)
  }

  // ---------------------------------------------------------------- restart
  /** what the last process left: a job half started goes back to the queue; a run still going is followed; one gone is settled; reports go again */
  recover(): void {
    let n = 0
    for (const j of this.state.jobs) {
      if (j.state === 'starting') { j.state = 'queued'; n++ }
      else if (j.state === 'lookup') this.later(Math.max(0, Date.parse(j.lookup_at ?? this.iso()) - this.now()), () => void this.lookup(j))
      else if (j.state === 'running') {
        n++
        if (alive(j.pid)) {
          this.log('info', `${j.id}: its codex (pid ${j.pid}) is still running after the restart: followed to its end`)
          this.procs.set(j.id, null)
          this.armTimeout(j)
          const poll = (): void => { if (j.state !== 'running') return; if (alive(j.pid)) this.later(this.cfg.adoptPollMs, poll); else this.exited(j, null, null) }
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
    if (offline) return { presence: 'offline', presence_reason: 'disconnected', lifecycle: 'stopped', main_session_id: 'main',
      sessions: [{ id: 'main', kind: 'main', thread_id: null, activity: 'unknown', activity_since: null, turn: null, doing: null, blockers: [], last_turn: s.last_turn }],
      background: null, queue: { pending: queued, unread_by_member: 0 }, last_activity_at: s.last_activity_at, reported_at: reported, evidence: { source: 'runtime', confidence: null } } as any
    const run = !!busy.length && !!s.span
    return { presence: 'online', presence_reason: null, lifecycle: 'ready', main_session_id: 'main',
      sessions: [{ id: 'main', kind: 'main', thread_id: null, activity: run ? 'running' : 'idle', activity_since: run ? s.span!.started_at : (s.idle_since ?? reported),
        turn: run ? { id: s.span!.id, started_at: s.span!.started_at, trigger: s.span!.trigger } : null,
        doing: run ? { kind: 'tool', tool: TOOL, since: s.span!.started_at } : null, blockers: [], last_turn: s.last_turn }],
      background: { agents: 0, shells: 0, tasks: busy.length, monitors: 0 }, queue: { pending: queued, unread_by_member: 0 },
      last_activity_at: s.last_activity_at, reported_at: reported, evidence: { source: 'runtime', confidence: null } } as Observation
  }
  health(): Record<string, unknown> {
    return { ...this.stats, busy: this.busy().map(j => j.id), queued: this.state.jobs.filter(j => j.state === 'queued').length, inbox: this.puller.health(), observation: this.obs.health() }
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
  if (args.includes('--whoami') || args.includes('--profile')) {
    if (!onsen.token()) { console.error(`no mesh credential in ${cfg.credentialFile}`); process.exit(2) }
    if (args.includes('--profile')) {
      const r = await onsen.req('PUT', `/v1/members/${cfg.agent}/profile`, { display_name: process.env.CODEX_RUNNER_DISPLAY_NAME || DISPLAY_NAME, role: process.env.CODEX_RUNNER_ROLE || ROLE })
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
