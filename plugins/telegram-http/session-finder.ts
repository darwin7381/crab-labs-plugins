// session-finder.ts: finding the Claude Code sessions on this machine and the tmux session each one runs in (board WO-183).
//
// The one copy. Until WO-183 this lived in roamer-control.ts (lines 178-231 at 5c04c0d: claudeAgents, findTmuxForPid and
// isProcessDescendant). The roamer imports claudeAgents and findTmuxForPid from here for /roam, unchanged (its /roam filter,
// isSystemSession, stays in the roamer). The claude-code-host extension (claude-code-host.ts) uses listSessions for Onsen's list of a
// machine's sessions.
//
//   claude agents --json          Claude Code's own registry: {pid, cwd, kind, startedAt, sessionId, status, name}
//   tmux list-panes -a -F …       every pane of the tmux server and the pid of the process it started
//   ps -o pid=,ppid= -A           the process table: a session's tmux is the first pane (tmux's order) whose process it descends from
//
// Read-only by construction: every command goes through runReadOnly, which starts only those three listings (and tmux list-sessions) and
// refuses anything else without starting it. Nothing here sends keys, starts, stops or restarts anything.
import { spawn } from 'node:child_process'

/** an entry of `claude agents --json` as the roamer types it */
export type ClaudeAgent = {
  pid: number
  cwd: string
  kind: 'interactive' | 'background'
  startedAt: number
  sessionId: string
  status: 'idle' | 'busy'
  name?: string
}
/** an entry as Claude Code wrote it, nothing assumed but the session id */
export type AgentEntry = {
  sessionId: string
  pid?: number | null
  cwd?: string | null
  kind?: string | null
  startedAt?: number | null
  status?: string | null
  name?: string | null
}
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Runner = (argv: string[], timeoutMs: number) => Promise<RunResult>
export type Pane = { session: string; panePid: number }
export type FinderOptions = {
  /** the claude binary (default: `claude` on PATH) */
  claudeBin?: string
  /** put before every tmux subcommand, e.g. ['-S', '/private/socket'] (tests use a private server; default: none, the user's server) */
  tmuxArgs?: string[]
  /** what runs the commands (default runReadOnly) */
  run?: Runner
}
export type FoundSession = AgentEntry & { tmux: string | null }

// ---- running a listing --------------------------------------------------------------------------------------------------------

/** the argv a listing may be: [<claude>, agents, --json]; [tmux, (-S|-L <x>)?, list-panes|list-sessions, …]; [ps, -o, pid=,ppid=, -A] */
export function isReadOnlyListing(argv: string[]): boolean {
  if (argv.length === 0) return false
  const bin = argv[0].split('/').pop() ?? ''
  if (bin === 'ps') return argv.length === 4 && argv[1] === '-o' && argv[2] === 'pid=,ppid=' && argv[3] === '-A'
  if (bin === 'tmux') {
    let i = 1
    if ((argv[1] === '-S' || argv[1] === '-L') && argv.length > 2) i = 3
    return argv[i] === 'list-panes' || argv[i] === 'list-sessions'
  }
  return argv.length === 3 && argv[1] === 'agents' && argv[2] === '--json' && /claude/i.test(bin)
}

function spawnCapture(argv: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise(resolve => {
    let proc: ReturnType<typeof spawn>
    try { proc = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (err) { resolve({ exitCode: -1, stdout: '', stderr: String(err) }); return }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill('SIGKILL') } catch {}
      resolve({ exitCode: 124, stdout, stderr: stderr + '\n[command timeout]' })
    }, timeoutMs)
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    proc.on('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
    proc.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err) })
    })
  })
}

/** run a listing (isReadOnlyListing); anything else is refused (exit 126) and never started. Past timeoutMs it is killed (SIGKILL). */
export const runReadOnly: Runner = (argv, timeoutMs) =>
  isReadOnlyListing(argv)
    ? spawnCapture(argv, timeoutMs)
    : Promise.resolve({ exitCode: 126, stdout: '', stderr: `refused: ${argv[0] ?? ''} is not a read-only listing` })

const runner = (o: FinderOptions): Runner => o.run ?? runReadOnly

// ---- the three listings -------------------------------------------------------------------------------------------------------

/** the roamer's list, exactly as roamer-control.ts had it: the interactive sessions with a pid, a session id and a folder; [] when the
 *  command failed or its output was not a JSON array */
export async function claudeAgents(o: FinderOptions = {}): Promise<ClaudeAgent[]> {
  const r = await runner(o)([o.claudeBin ?? 'claude', 'agents', '--json'], 8000)
  if (r.exitCode !== 0) return []
  try {
    const parsed = JSON.parse(r.stdout)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((a: any) => a.kind === 'interactive' && a.pid && a.sessionId && a.cwd)
  } catch { return [] }
}

/** every entry of `claude agents --json` with a session id (any folder, any kind); null when the command failed or its output was not a
 *  JSON array (the caller must not take that for an empty machine) */
export async function listAgents(o: FinderOptions = {}): Promise<AgentEntry[] | null> {
  const r = await runner(o)([o.claudeBin ?? 'claude', 'agents', '--json'], 8000)
  if (r.exitCode !== 0) return null
  let parsed: unknown
  try { parsed = JSON.parse(r.stdout) } catch { return null }
  if (!Array.isArray(parsed)) return null
  return parsed.filter((a: any) => a && typeof a === 'object' && typeof a.sessionId === 'string' && a.sessionId) as AgentEntry[]
}

/** every pane of the tmux server, in tmux's order: its session and the pid of its process; null when tmux failed (no server included) */
export async function listPanes(o: FinderOptions = {}): Promise<Pane[] | null> {
  const r = await runner(o)(['tmux', ...(o.tmuxArgs ?? []), 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'], 5000)
  if (r.exitCode !== 0) return null
  const out: Pane[] = []
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('\t')) continue
    const [session, pid] = line.split('\t')
    if (!pid) continue
    const panePid = parseInt(pid, 10)
    if (Number.isFinite(panePid)) out.push({ session, panePid })
  }
  return out
}

/** pid → parent pid from one `ps`; an empty map when ps failed */
export async function processParents(o: FinderOptions = {}): Promise<Map<number, number>> {
  const parentOf = new Map<number, number>()
  const r = await runner(o)(['ps', '-o', 'pid=,ppid=', '-A'], 3000)
  if (r.exitCode !== 0) return parentOf
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)/)
    if (m) parentOf.set(parseInt(m[1], 10), parseInt(m[2], 10))
  }
  return parentOf
}

// ---- which tmux a process is in -----------------------------------------------------------------------------------------------

/** pid is ancestor or descends from it (at most 50 steps up; init (1), a loop or a missing parent ends the walk) */
export function descendsFrom(pid: number, ancestor: number, parentOf: Map<number, number>): boolean {
  if (pid === ancestor) return true
  let cur = pid
  for (let i = 0; i < 50; i++) {
    if (cur === ancestor) return true
    const p = parentOf.get(cur)
    if (!p || p === cur || p === 1) return false
    cur = p
  }
  return false
}

/** the session of the first pane (tmux's order) whose process pid is or descends from; null: none */
export function tmuxForPid(pid: number, panes: Pane[], parentOf: Map<number, number>): string | null {
  for (const p of panes) if (descendsFrom(pid, p.panePid, parentOf)) return p.session
  return null
}

/** the roamer's question for one process: its tmux session, or null (one list-panes, then one ps when there are panes) */
export async function findTmuxForPid(pid: number, o: FinderOptions = {}): Promise<string | null> {
  const panes = await listPanes(o)
  if (!panes) return null
  if (panes.length === 0) return null
  return tmuxForPid(pid, panes, await processParents(o))
}

// ---- a machine's sessions -----------------------------------------------------------------------------------------------------

/** every Claude Code session on this machine with its tmux session or null: one `claude agents`, one list-panes, one ps. null when
 *  `claude agents` failed (the caller does not report a machine it did not see); tmux failing (no server) leaves every tmux null */
export async function listSessions(o: FinderOptions = {}): Promise<FoundSession[] | null> {
  const agents = await listAgents(o)
  if (!agents) return null
  if (agents.length === 0) return []
  const panes = (await listPanes(o)) ?? []
  const parentOf = panes.length ? await processParents(o) : new Map<number, number>()
  return agents.map(a => ({ ...a, tmux: Number.isInteger(a.pid) && (a.pid as number) > 0 ? tmuxForPid(a.pid as number, panes, parentOf) : null }))
}
