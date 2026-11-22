/**
 * lanes-proc.ts — 002y (X-5): the process facts lanes mode reads, one function per fact, one implementation per platform.
 *
 * Lanes mode tells MCP sessions apart by the claude process that owns them (lanes.ts: noteMcpSocket, callerClaudePid; the main's offers go to the MCP
 * session of its pid), and keeps one live process per session id (sessionHolder). Through 002x every fact was read from Linux /proc only. The fleet is
 * mostly macOS (Darwin, bun), where /proc does not exist: no MCP session was ever mapped to a pid there, so the main could never be offered anything.
 *
 *   peerPid(clientPort, serverPort)  the process holding the CLIENT end of the TCP connection <clientPort> → <serverPort> (an HTTP request's peer)
 *   parentPid(pid)                   its parent (the walk up to the claude process: a hook's python is a child of claude)
 *   argv(pid)                        its command line, split (Linux exactly, by NUL; macOS by white space, as ps prints it)
 *   exe(pid)                         the executable it runs (Linux /proc/<pid>/exe; macOS the path ps prints as `comm`)
 *   sessionPids()                    session id → pid of every live process whose argv resumes or names it (--resume, -r, --session-id), forks excluded
 *
 * Linux reads /proc as lanes.ts did (the one `stat` read is the parent pid; no start time is used). macOS asks lsof and ps (LC_ALL=C). Every fact fails safe: a command that is missing,
 * fails, times out or prints nothing gives null (an empty map for sessionPids), and the callers treat unknown as not judged, as they always did on Linux
 * (a session whose process is not known is not judged not-the-main; a session id no known process holds is free). Another platform: every fact unknown.
 * PURE parsers (lsofPeerPid, psFirstLine, psRows, sessionPidsOf) take the commands' output, so tests run them on recorded output.
 */
import { readFileSync, readdirSync, readlinkSync } from 'fs'
import { spawnSync } from 'child_process'

export type ProcFacts = {
  platform: string
  peerPid(clientPort: number, serverPort: number): number | null
  parentPid(pid: number): number | null
  argv(pid: number): string[] | null
  exe(pid: number): string | null
  sessionPids(): Map<string, number>
}
/** run a command: its stdout, or null when it could not run (missing, killed by the timeout) */
export type Run = (cmd: string, args: string[]) => string | null

const RUN_TIMEOUT_MS = 3_000
export const runCmd: Run = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
    return r.error || r.signal ? null : String(r.stdout ?? '')
  } catch { return null }
}

/** session id → pid, from (pid, argv) rows: the flags that resume or name a session; a fork (--fork-session) makes a new id and holds none */
export function sessionPidsOf(rows: Array<{ pid: number; argv: string[] }>, self = process.pid): Map<string, number> {
  const map = new Map<string, number>()
  for (const { pid, argv } of rows) {
    if (pid === self || argv.includes('--fork-session')) continue
    for (let k = 0; k < argv.length; k++) {
      const a = argv[k]
      if ((a === '--resume' || a === '-r' || a === '--session-id') && argv[k + 1]) map.set(argv[k + 1], pid)
      else if (a.startsWith('--resume=') || a.startsWith('--session-id=')) map.set(a.slice(a.indexOf('=') + 1), pid)
    }
  }
  return map
}

// ------------------------------------------------------------------ Linux: /proc
const hexPort = (p: number): string => p.toString(16).toUpperCase().padStart(4, '0')
/** inode of the CLIENT-side socket <clientPort> → <serverPort> */
function clientSocketInode(clientPort: number, serverPort: number): string | null {
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length < 10) continue
      const lp = c[1].split(':').pop(), rp = c[2].split(':').pop()
      if (lp === hexPort(clientPort) && rp === hexPort(serverPort)) return c[9]
    }
  }
  return null
}
function pidOfInode(inode: string): number | null {
  const want = `socket:[${inode}]`
  let pids: string[] = []
  try { pids = readdirSync('/proc').filter(x => /^\d+$/.test(x)) } catch { return null }
  for (const p of pids) {
    let fds: string[]
    try { fds = readdirSync(`/proc/${p}/fd`) } catch { continue }
    for (const fd of fds) {
      try { if (readlinkSync(`/proc/${p}/fd/${fd}`) === want) return Number(p) } catch {}
    }
  }
  return null
}
/** fields of /proc/<pid>/stat after the command name (field 3 = state is [0], field 4 = ppid is [1]) */
function statFields(pid: number): string[] | null {
  try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ') } catch { return null }
}
export const linuxFacts = (): ProcFacts => ({
  platform: 'linux',
  peerPid(clientPort, serverPort) { const inode = clientSocketInode(clientPort, serverPort); return inode ? pidOfInode(inode) : null },
  parentPid(pid) { const f = statFields(pid); return f ? Number(f[1]) : null },
  argv(pid) { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0') } catch { return null } },
  exe(pid) { try { return readlinkSync(`/proc/${pid}/exe`) } catch { return null } },
  sessionPids() {
    let pids: string[] = []
    try { pids = readdirSync('/proc').filter(x => /^\d+$/.test(x)) } catch { pids = [] }
    const rows: Array<{ pid: number; argv: string[] }> = []
    for (const p of pids) { try { rows.push({ pid: Number(p), argv: readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0') }) } catch {} }
    return sessionPidsOf(rows)
  },
})

// ------------------------------------------------------------------ macOS: lsof and ps
/** `lsof -nP -w -iTCP:<clientPort> -sTCP:ESTABLISHED -Fpn` output → the pid whose socket is <clientPort> → <serverPort>. -F prints `p<pid>` once per process,
 *  then per file `f<fd>` and `n<local>-><remote>` (IPv4 127.0.0.1:52344->127.0.0.1:17631, IPv6 [::1]:52344->[::1]:17631). Both ends of the connection
 *  are listed (the server's end is <serverPort> -> <clientPort>): only the end whose LOCAL port is the client port is the caller. */
export function lsofPeerPid(out: string, clientPort: number, serverPort: number): number | null {
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) { const n = Number(line.slice(1)); pid = Number.isInteger(n) && n > 0 ? n : null; continue }
    if (!line.startsWith('n') || pid == null) continue
    const m = line.slice(1).match(/^(.*):(\d+)->(.*):(\d+)$/)
    if (m && Number(m[2]) === clientPort && Number(m[4]) === serverPort) return pid
  }
  return null
}
/** the one value line of `ps -o <field>= -p <pid>`, trimmed; null for none (no such process prints nothing) */
export function psFirstLine(out: string | null): string | null {
  const l = (out ?? '').split('\n').map(s => s.trim()).find(Boolean)
  return l || null
}
/** `ps -axo pid=,command=` output → (pid, argv) rows */
export function psRows(out: string): Array<{ pid: number; argv: string[] }> {
  const rows: Array<{ pid: number; argv: string[] }> = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*\S)\s*$/)
    if (m) rows.push({ pid: Number(m[1]), argv: m[2].split(/\s+/) })
  }
  return rows
}
export const darwinFacts = (run: Run = runCmd): ProcFacts => {
  const ps = (field: string, pid: number): string | null => Number.isInteger(pid) && pid > 0 ? psFirstLine(run('ps', ['-o', `${field}=`, '-p', String(pid)])) : null
  return {
    platform: 'darwin',
    peerPid(clientPort, serverPort) {
      if (!(clientPort > 0 && serverPort > 0)) return null
      const out = run('lsof', ['-nP', '-w', `-iTCP:${clientPort}`, '-sTCP:ESTABLISHED', '-Fpn'])
      return out ? lsofPeerPid(out, clientPort, serverPort) : null
    },
    parentPid(pid) { const v = ps('ppid', pid); const n = Number(v); return v != null && Number.isInteger(n) && n >= 0 ? n : null },
    argv(pid) { const v = ps('command', pid); return v ? v.split(/\s+/) : null },
    exe(pid) { return ps('comm', pid) },
    sessionPids() { const out = run('ps', ['-axo', 'pid=,command=']); return out ? sessionPidsOf(psRows(out)) : new Map() },
  }
}

/** a platform with neither: every fact unknown (not judged) */
export const unknownFacts = (): ProcFacts => ({ platform: 'unknown', peerPid: () => null, parentPid: () => null, argv: () => null, exe: () => null, sessionPids: () => new Map() })

export function procFactsFor(platform: string = process.platform): ProcFacts {
  return platform === 'linux' ? linuxFacts() : platform === 'darwin' ? darwinFacts() : unknownFacts()
}
