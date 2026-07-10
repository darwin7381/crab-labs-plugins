/**
 * Claude Roamer control plane.
 *
 * Lets the user switch their TG conversation between any live claude
 * session on the machine. Unlike channel-bot-control.ts which drives ONE
 * fixed channel-bot claude, roamer picks ANY claude session via
 * `claude agents --json` and respawns it with `--channels` so it joins
 * the plugin's existing MCP bridge — same notification + reply pipeline
 * as the channel bot.
 *
 * Gated by ROAMER_MODE=1 in the daemon's env. When unset, every export
 * here is a no-op.
 *
 * Multi-roamer coordination: shared registry at
 * ~/.claude/channels/roamer-registry.json. Each daemon writes its own
 * entry keyed by bot username. Listings filter sessions claimed by OTHER
 * roamers. Activeness verified at read time via kill -0 + tmux
 * has-session so stale entries auto-clear.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import {
  forwardSharedTuiSlash,
  sharedTuiCommands,
  listClaudeSessions,
  currentSessionId,
  resumePickerInlineSwitch,
  loadResumeChain,
  saveResumeChain,
  formatResumeReply,
  type InlineButton as CBCInlineButton,
} from './channel-bot-control.ts'

// ---- env-var configuration -----------------------------------------------

const ROAMER_MODE = process.env.ROAMER_MODE === '1'
const ROAMER_BOT_NAME = process.env.ROAMER_BOT_NAME ?? ''
const ROAMER_REGISTRY_FILE =
  process.env.ROAMER_REGISTRY_FILE ?? join(homedir(), '.claude', 'channels', 'roamer-registry.json')
const ROAMER_STATE_FILE = process.env.ROAMER_STATE_FILE ?? ''

/** Plugin manifest slug used in `--channels plugin:<slug>` */
const ROAMER_CHANNEL_PLUGIN =
  process.env.ROAMER_CHANNEL_PLUGIN ?? 'telegram-http@crab-labs-plugins'

export function isRoamerEnabled(): boolean {
  return ROAMER_MODE && ROAMER_BOT_NAME !== '' && ROAMER_STATE_FILE !== ''
}

// ---- types --------------------------------------------------------------

export type InlineButton = { text: string; callback_data: string }

export type ReplyOptions = {
  keyboard?: InlineButton[][]
}

type ClaudeAgent = {
  pid: number
  cwd: string
  kind: 'interactive' | 'background'
  startedAt: number
  sessionId: string
  status: 'idle' | 'busy'
  name?: string
}

type RoamerRegistryEntry = {
  tmux: string
  claude_pid: number
  daemon_pid: number
  session_id: string
  cwd: string
  updated_at: number
  /**
   * Bridge protocol of the roamer that owns this entry. Used by
   * listRoamableSessions for cross-protocol filter exemption:
   * a TG roamer's list excludes claims by OTHER TG roamers, but NOT
   * claims by DC roamers (a target claude can be reached from both
   * bridges simultaneously since spawn loads both --channels).
   */
  protocol: 'telegram' | 'discord'
}

/** This module's bridge protocol — telegram-http. */
const SELF_PROTOCOL: 'telegram' | 'discord' = 'telegram'

/** Shared registry of all live roamer daemons (across both protocols) used
 *  for cross-protocol auto-discovery — no per-plist pairing wiring. */
const ROAMER_DAEMONS_FILE =
  process.env.ROAMER_DAEMONS_FILE ?? join(homedir(), '.claude', 'channels', 'roamer-daemons.json')

type RoamerDaemonEntry = {
  protocol: 'telegram' | 'discord'
  bot: string
  port: number
  pid: number
  registered_at: number
}
type RoamerDaemonRegistry = Record<string, RoamerDaemonEntry>  // key: `${protocol}-${bot}`

type RoamerRegistry = Record<string, RoamerRegistryEntry>

type RoamerState = {
  current_target: {
    tmux: string
    claude_pid: number
    session_id: string
    cwd: string
  } | null
}

type DetectedSession = {
  pid: number
  cwd: string
  projectName: string
  sessionId: string
  status: 'idle' | 'busy'
  tmuxName: string | null            // null = naked claude
  claimedBy: string | null            // bot name claiming this session, null = free or own
}

// ---- subprocess helper --------------------------------------------------

function runCommand(
  argv: string[],
  timeoutMs = 8000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const proc = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
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

function pidAlive(pid: number): boolean {
  if (!pid || pid < 2) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  const r = await runCommand(['tmux', 'has-session', '-t', name], 3000)
  return r.exitCode === 0
}

// ---- session detection --------------------------------------------------

async function claudeAgents(): Promise<ClaudeAgent[]> {
  const r = await runCommand(['claude', 'agents', '--json'], 8000)
  if (r.exitCode !== 0) return []
  try {
    const parsed = JSON.parse(r.stdout)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((a: any) => a.kind === 'interactive' && a.pid && a.sessionId && a.cwd)
  } catch { return [] }
}

async function findTmuxForPid(pid: number): Promise<string | null> {
  const r = await runCommand(
    ['tmux', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'],
    5000,
  )
  if (r.exitCode !== 0) return null
  const panes = r.stdout.split('\n').filter(l => l.includes('\t'))
  for (const line of panes) {
    const [session, panePid] = line.split('\t')
    if (!panePid) continue
    const isDesc = await isProcessDescendant(pid, parseInt(panePid, 10))
    if (isDesc) return session
  }
  return null
}

async function isProcessDescendant(pid: number, ancestor: number): Promise<boolean> {
  if (pid === ancestor) return true
  const r = await runCommand(['ps', '-o', 'pid=,ppid=', '-A'], 3000)
  if (r.exitCode !== 0) return false
  const parentOf: Map<number, number> = new Map()
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)/)
    if (m) parentOf.set(parseInt(m[1], 10), parseInt(m[2], 10))
  }
  let cur = pid
  for (let i = 0; i < 50; i++) {
    if (cur === ancestor) return true
    const p = parentOf.get(cur)
    if (!p || p === cur || p === 1) return false
    cur = p
  }
  return false
}

function projectName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

function isSystemSession(agent: ClaudeAgent): boolean {
  const home = homedir()
  const cwd = agent.cwd
  if (cwd.startsWith(join(home, 'cc-workspaces') + '/')) return true
  if (cwd === join(home, '.claude', 'workspace-telegram')) return true
  if (cwd.startsWith(join(home, 'agy-workspaces') + '/')) return true
  return false
}

// ---- registry I/O -------------------------------------------------------

function atomicWriteJson(path: string, obj: any): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, path)
}

function readRegistry(): RoamerRegistry {
  try { return JSON.parse(readFileSync(ROAMER_REGISTRY_FILE, 'utf8')) as RoamerRegistry }
  catch { return {} }
}

async function readActiveRegistry(): Promise<RoamerRegistry> {
  const raw = readRegistry()
  const out: RoamerRegistry = {}
  let changed = false
  for (const [bot, entry] of Object.entries(raw)) {
    const daemonOk = pidAlive(entry.daemon_pid)
    const claudeOk = pidAlive(entry.claude_pid)
    const tmuxOk = await tmuxSessionExists(entry.tmux)
    if (daemonOk && claudeOk && tmuxOk) out[bot] = entry
    else changed = true
  }
  if (changed) {
    try { atomicWriteJson(ROAMER_REGISTRY_FILE, out) } catch {}
  }
  return out
}

function writeRegistryEntry(bot: string, entry: RoamerRegistryEntry): void {
  const reg = readRegistry()
  reg[bot] = entry
  atomicWriteJson(ROAMER_REGISTRY_FILE, reg)
}

function deleteRegistryEntry(bot: string): void {
  const reg = readRegistry()
  if (bot in reg) {
    delete reg[bot]
    atomicWriteJson(ROAMER_REGISTRY_FILE, reg)
  }
}

// ---- daemon-registry (cross-protocol auto-discovery) -------------------

function readDaemonRegistry(): RoamerDaemonRegistry {
  try { return JSON.parse(readFileSync(ROAMER_DAEMONS_FILE, 'utf8')) as RoamerDaemonRegistry }
  catch { return {} }
}

function selfDaemonKey(): string {
  return `${SELF_PROTOCOL}-${ROAMER_BOT_NAME}`
}

/** Register this daemon in the shared roamer-daemons.json. Called on boot. */
export function registerSelfAsDaemon(): void {
  if (!isRoamerEnabled()) return
  const port = parseInt(process.env.TELEGRAM_HTTP_PORT ?? '', 10)
  if (!port) return
  const reg = readDaemonRegistry()
  reg[selfDaemonKey()] = {
    protocol: SELF_PROTOCOL,
    bot: ROAMER_BOT_NAME,
    port,
    pid: process.pid,
    registered_at: Date.now(),
  }
  try { atomicWriteJson(ROAMER_DAEMONS_FILE, reg) } catch {}
}

/** Remove this daemon from the shared registry. Called on shutdown. */
export function unregisterSelfAsDaemon(): void {
  if (!isRoamerEnabled()) return
  try {
    const reg = readDaemonRegistry()
    const key = selfDaemonKey()
    if (key in reg) {
      delete reg[key]
      atomicWriteJson(ROAMER_DAEMONS_FILE, reg)
    }
  } catch {}
}

/** Find the port of a partner (other-protocol) live daemon.
 *  Deterministic order (lowest port wins) so same TG roamer always picks
 *  the same DC partner across spawns. Returns null if no partner alive. */
function findPartnerPort(otherProtocol: 'telegram' | 'discord'): number | null {
  const reg = readDaemonRegistry()
  const candidates: RoamerDaemonEntry[] = []
  for (const entry of Object.values(reg)) {
    if (entry.protocol !== otherProtocol) continue
    if (!pidAlive(entry.pid)) continue
    candidates.push(entry)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.port - b.port)
  return candidates[0].port
}

// ---- per-instance state ------------------------------------------------

function readState(): RoamerState {
  try { return JSON.parse(readFileSync(ROAMER_STATE_FILE, 'utf8')) as RoamerState }
  catch { return { current_target: null } }
}

function writeState(state: RoamerState): void {
  atomicWriteJson(ROAMER_STATE_FILE, state)
}

// ---- MCP session ↔ tmux mapping ----------------------------------------
// When takeover spawns a new claude with `--channels`, the new claude
// connects back to this daemon and opens an MCP session. We need to know
// which MCP session belongs to which roamer target so TG inbound routes
// to the right one.
//
// Strategy: takeover sets pendingTakeoverTmux + timestamp BEFORE spawning.
// server.ts calls onNewMcpSession when any new MCP session opens. If a
// takeover is pending and within timeout, we claim the new session for it.

let pendingTakeover: { tmux: string; setAt: number } | null = null
const tmuxToMcpSession = new Map<string, string>()   // tmux → mcp sessionId
const PENDING_TIMEOUT_MS = 60_000

export function startTakeoverWait(tmuxName: string): void {
  pendingTakeover = { tmux: tmuxName, setAt: Date.now() }
}

/**
 * Called by server.ts when ANY new MCP session opens. If a takeover is
 * pending and within window, claim this session for it.
 */
export function onNewMcpSession(mcpSessionId: string): boolean {
  if (!pendingTakeover) return false
  if (Date.now() - pendingTakeover.setAt > PENDING_TIMEOUT_MS) {
    pendingTakeover = null
    return false
  }
  tmuxToMcpSession.set(pendingTakeover.tmux, mcpSessionId)
  pendingTakeover = null
  return true
}

/** Called by server.ts when an MCP session closes — drop stale mapping. */
export function onMcpSessionClosed(mcpSessionId: string): void {
  for (const [tmux, sid] of tmuxToMcpSession) {
    if (sid === mcpSessionId) tmuxToMcpSession.delete(tmux)
  }
}

/** Look up the MCP session id for the currently-routed target. */
export function getCurrentTargetMcpSessionId(): string | null {
  const state = readState()
  if (!state.current_target) return null
  return tmuxToMcpSession.get(state.current_target.tmux) ?? null
}

async function waitForTakeoverMcpSession(tmuxName: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (tmuxToMcpSession.has(tmuxName)) return true
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

// ---- list sessions for /roam keyboard ---------------------------------

export async function listRoamableSessions(): Promise<DetectedSession[]> {
  const agents = await claudeAgents()
  const myDaemonPid = process.pid
  const registry = await readActiveRegistry()

  // Only filter out claims from OTHER bots of the SAME protocol.
  // Cross-protocol claims (e.g. DC roamer holding session X) are visible
  // and selectable from this TG roamer — same claude can be reached from
  // both bridges concurrently.
  const claimers: Map<string, string> = new Map()
  for (const [bot, entry] of Object.entries(registry)) {
    if (entry.daemon_pid === myDaemonPid) continue
    if (entry.protocol !== SELF_PROTOCOL) continue
    claimers.set(entry.session_id, bot)
  }

  const out: DetectedSession[] = []
  for (const a of agents) {
    if (isSystemSession(a)) continue
    const tmuxName = await findTmuxForPid(a.pid)
    const claimer = claimers.get(a.sessionId) ?? null
    out.push({
      pid: a.pid,
      cwd: a.cwd,
      projectName: projectName(a.cwd),
      sessionId: a.sessionId,
      status: a.status,
      tmuxName,
      claimedBy: claimer,
    })
  }
  out.sort((a, b) => {
    if (a.claimedBy !== b.claimedBy) return a.claimedBy ? 1 : -1
    return b.pid - a.pid
  })
  return out
}

// ---- takeover (using --channels for native bridge) --------------------

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
function cwdSlug(cwd: string): string {
  return '-' + cwd.replace(/\//g, '-').replace(/^-+/, '')
}
function transcriptPath(cwd: string, sessionId: string): string {
  return join(PROJECTS_ROOT, cwdSlug(cwd), `${sessionId}.jsonl`)
}

/**
 * Pick the most-recently-modified non-empty session jsonl for a project.
 *
 * Rationale (2026-05-25, msg 1534): "roam to project X" should resume the
 * user's most recent real conversation in that project, not whatever
 * empty session happened to be the live PID. Without this, naked claudes
 * spawned moments ago (zero turns, no jsonl) get taken over and start
 * fresh — losing apparent continuity with the user's history.
 *
 * Returns null if no non-empty jsonl exists for that cwd.
 */
function findLatestNonEmptySessionForCwd(cwd: string): string | null {
  const dir = join(PROJECTS_ROOT, cwdSlug(cwd))
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return null }

  type Candidate = { sid: string; mtime: number; size: number }
  const candidates: Candidate[] = []
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue
    const sid = f.slice(0, -'.jsonl'.length)
    const full = join(dir, f)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      if (st.size <= 0) continue
      candidates.push({ sid, mtime: st.mtimeMs, size: st.size })
    } catch {}
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].sid
}

/**
 * Spawn claude in a new tmux session with --channels so it auto-connects
 * to this daemon's MCP bridge. Uses --resume only if the original session
 * has a written transcript (sessions with zero turns have no jsonl).
 */
/**
 * Spawn claude with BOTH telegram-http AND discord-http channels loaded.
 *
 * Rationale (2026-05-25): one target claude should be reachable from
 * either TG or DC roamer bots interchangeably (Joey msg 1503). We always
 * load both plugins so the same claude shows up on both bridges.
 *
 * Cross-protocol coordination: env ports for BOTH bridges are picked up
 * from this daemon's env (TELEGRAM_HTTP_PORT, DISCORD_HTTP_PORT). When
 * the TG roamer spawns, it forwards its own TELEGRAM_HTTP_PORT plus a
 * DISCORD_HTTP_PORT it reads from a well-known config or env (see
 * DISCORD_BRIDGE_PORT_FOR_ROAMER env, defaults to 17641 = channel-bot's
 * discord port). Same logic mirrored on the DC side.
 */
/**
 * Build the shell command that launches a bridged claude for `cwd`, resuming
 * the most meaningful session. Returns null when TELEGRAM_HTTP_PORT is
 * missing (can't bridge without our own port).
 */
function buildChannelClaudeLaunch(
  cwd: string,
  sessionId: string,
): { cmd: string; hasHistory: boolean; resumedSid: string | null } | null {
  // Prefer the LATEST non-empty session in this project folder — gives
  // the user continuity with their most recent real conversation, instead
  // of force-fresh just because the live PID we took over was empty.
  const liveJsonl = transcriptPath(cwd, sessionId)
  let resumeSid: string | null = null
  try {
    if (statSync(liveJsonl).size > 0) resumeSid = sessionId
  } catch {}
  if (!resumeSid) resumeSid = findLatestNonEmptySessionForCwd(cwd)
  const hasHistory = resumeSid !== null

  // Own bridge's port (this TG daemon's own port via env).
  const ownPort = process.env.TELEGRAM_HTTP_PORT
  if (!ownPort) return null

  // Cross-bridge: auto-discover a live DC roamer daemon via shared registry.
  // No per-plist wiring — just picks first live DC roamer (deterministic
  // lowest-port order). Falls back to single-channels if no DC roamer alive.
  const dcPort = findPartnerPort('discord')
  const loadDc = dcPort !== null

  const flags = [
    `--channels plugin:telegram-http@crab-labs-plugins`,
    loadDc ? `--channels plugin:discord-http@crab-labs-plugins` : '',
    '--disallowedTools AskUserQuestion ExitPlanMode',
    '--dangerously-skip-permissions',
    resumeSid ? `--resume ${resumeSid}` : '',
  ].filter(Boolean).join(' ')

  const envPart = loadDc
    ? `TELEGRAM_HTTP_PORT=${ownPort} DISCORD_HTTP_PORT=${dcPort}`
    : `TELEGRAM_HTTP_PORT=${ownPort}`
  return {
    cmd: `cd ${shellQuote(cwd)} && ${envPart} exec claude ${flags}`,
    hasHistory,
    resumedSid: resumeSid,
  }
}

async function spawnTmuxWithChannelClaude(
  tmuxName: string,
  cwd: string,
  sessionId: string,
): Promise<{ ok: boolean; hasHistory: boolean; resumedSid: string | null }> {
  const launch = buildChannelClaudeLaunch(cwd, sessionId)
  if (!launch) return { ok: false, hasHistory: false, resumedSid: null }
  const newRes = await runCommand(['tmux', 'new-session', '-d', '-s', tmuxName], 5000)
  if (newRes.exitCode !== 0) return { ok: false, hasHistory: launch.hasHistory, resumedSid: null }
  const sendRes = await runCommand(['tmux', 'send-keys', '-t', tmuxName, launch.cmd, 'Enter'], 5000)
  return { ok: sendRes.exitCode === 0, hasHistory: launch.hasHistory, resumedSid: launch.resumedSid }
}

/**
 * Relaunch a bridged claude INSIDE an existing tmux session via
 * `tmux respawn-pane -k` — the session (and any attached human client)
 * survives; only the pane's process is replaced.
 *
 * 2026-07-10 (Joey P2): the old takeover/restart paths did
 * `tmux kill-session` on the target — which forcibly disconnected any human
 * attached to that session and destroyed it (fleet iron rule violation:
 * never kill a session someone is attached to). respawn-pane is the correct
 * primitive: kill/replace the process, keep the session + attachment.
 */
async function respawnPaneWithChannelClaude(
  tmuxName: string,
  cwd: string,
  sessionId: string,
): Promise<{ ok: boolean; hasHistory: boolean; resumedSid: string | null }> {
  const launch = buildChannelClaudeLaunch(cwd, sessionId)
  if (!launch) return { ok: false, hasHistory: false, resumedSid: null }
  // Target the session's first pane (mirrors findClaudePidInTmux's assumption
  // that roamer targets are single-pane sessions).
  const panes = await runCommand(['tmux', 'list-panes', '-t', tmuxName, '-F', '#{pane_id}'], 3000)
  const paneId = panes.exitCode === 0 ? (panes.stdout.trim().split('\n')[0] ?? '') : ''
  if (!paneId) return { ok: false, hasHistory: launch.hasHistory, resumedSid: null }
  const res = await runCommand(['tmux', 'respawn-pane', '-k', '-t', paneId, launch.cmd], 5000)
  return { ok: res.exitCode === 0, hasHistory: launch.hasHistory, resumedSid: launch.resumedSid }
}

async function sigintWait(pid: number, timeoutMs = 4000): Promise<boolean> {
  if (!pidAlive(pid)) return true
  try { process.kill(pid, 'SIGINT') } catch { return false }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise(r => setTimeout(r, 200))
  }
  try { process.kill(pid, 'SIGTERM') } catch {}
  await new Promise(r => setTimeout(r, 1000))
  if (!pidAlive(pid)) return true
  try { process.kill(pid, 'SIGKILL') } catch {}
  await new Promise(r => setTimeout(r, 500))
  return !pidAlive(pid)
}

async function findClaudePidInTmux(tmuxName: string): Promise<number | null> {
  const r = await runCommand(
    ['tmux', 'list-panes', '-t', tmuxName, '-F', '#{pane_pid}'],
    3000,
  )
  if (r.exitCode !== 0) return null
  const panePid = parseInt(r.stdout.trim().split('\n')[0] ?? '', 10)
  if (!panePid) return null

  const ps = await runCommand(['ps', '-o', 'pid=,ppid=,comm=', '-A'], 3000)
  if (ps.exitCode !== 0) return null
  type Row = { pid: number; ppid: number; comm: string }
  const byPid = new Map<number, Row>()
  const byPpid = new Map<number, Row[]>()
  for (const line of ps.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const row: Row = { pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), comm: m[3].trim() }
    byPid.set(row.pid, row)
    if (!byPpid.has(row.ppid)) byPpid.set(row.ppid, [])
    byPpid.get(row.ppid)!.push(row)
  }
  const isClaude = (comm: string): boolean =>
    /claude/i.test(comm) && !/bun|node/i.test(comm)

  const self = byPid.get(panePid)
  if (self && isClaude(self.comm)) return panePid

  const stack = [panePid]
  while (stack.length) {
    const cur = stack.pop()!
    for (const child of byPpid.get(cur) ?? []) {
      if (isClaude(child.comm)) return child.pid
      stack.push(child.pid)
    }
  }
  return null
}

async function findSessionIdForPid(pid: number, retries = 6): Promise<string | null> {
  for (let i = 0; i < retries; i++) {
    const agents = await claudeAgents()
    const match = agents.find(a => a.pid === pid)
    if (match) return match.sessionId
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

/**
 * Take over and connect to a target session.
 *
 * Path:
 *  - Already in tmux: ALSO respawn with --channels (the existing claude
 *    isn't connected to our bridge — even if tmux'd, it was started
 *    plain). Only exception: if its tmux is already in tmuxToMcpSession,
 *    skip respawn (already bridged).
 *  - Naked claude: SIGINT + new tmux + spawn with --channels
 *
 * After spawn, wait for the new MCP session to register with our bridge
 * (via onNewMcpSession callback from server.ts).
 */
export async function connectToSession(
  session: DetectedSession,
  notify: (msg: string) => Promise<void>,
): Promise<{ ok: boolean; message: string }> {
  if (!isRoamerEnabled()) return { ok: false, message: 'roamer mode not enabled' }

  if (session.claimedBy && session.claimedBy !== ROAMER_BOT_NAME) {
    const registry = await readActiveRegistry()
    if (registry[session.claimedBy]?.session_id === session.sessionId) {
      const m = `❌ session 已被 @${session.claimedBy}_bot 接著用，無法接管。等他切走或那邊 /exit 後再試。`
      await notify(m)
      return { ok: false, message: m }
    }
  }

  // If this target's existing tmux already has an MCP session in our map,
  // skip respawn — just point.
  if (session.tmuxName && tmuxToMcpSession.has(session.tmuxName)) {
    await notify(`🔗 該 session 已連在 bridge 上（${session.tmuxName}）— 純指針切換，零重啟`)
    const claudePid = await findClaudePidInTmux(session.tmuxName) ?? session.pid
    writeState({
      current_target: {
        tmux: session.tmuxName,
        claude_pid: claudePid,
        session_id: session.sessionId,
        cwd: session.cwd,
      },
    })
    writeRegistryEntry(ROAMER_BOT_NAME, {
      tmux: session.tmuxName,
      claude_pid: claudePid,
      daemon_pid: process.pid,
      session_id: session.sessionId,
      cwd: session.cwd,
      updated_at: Date.now(),
      protocol: SELF_PROTOCOL,
    })
    const m = `✅ 已切換到 ${session.projectName}（${session.cwd}）— 可以開始對話`
    await notify(m)
    return { ok: true, message: m }
  }

  // Need to relaunch claude with --channels so it joins our bridge.
  //  - already in tmux → respawn the PANE in place (`tmux respawn-pane -k`):
  //    the tmux session and any attached human client survive. 2026-07-10
  //    fix — the old path did `tmux kill-session` here, destroying the
  //    session and kicking whoever was attached (Joey P2).
  //  - naked claude → stop it, spawn a fresh roam-* tmux as before.
  let tmuxName: string
  let spawned: { ok: boolean; hasHistory: boolean; resumedSid: string | null }
  if (session.tmuxName) {
    tmuxName = session.tmuxName
    await notify(
      `🔄 ${session.projectName} 已在 tmux（${tmuxName}）但未掛 bridge — 原地重生 claude 接入 bridge（tmux session 與 attached 連線保留）`,
    )
    startTakeoverWait(tmuxName)
    spawned = await respawnPaneWithChannelClaude(tmuxName, session.cwd, session.sessionId)
  } else {
    await notify(`🛑 停止本機 claude（PID ${session.pid}）...`)
    const ok = await sigintWait(session.pid)
    if (!ok) {
      const m = `❌ 無法停止本機 claude PID ${session.pid}`
      await notify(m)
      return { ok: false, message: m }
    }
    tmuxName = `roam-${ROAMER_BOT_NAME}-${session.sessionId.slice(0, 8)}`
    startTakeoverWait(tmuxName)
    spawned = await spawnTmuxWithChannelClaude(tmuxName, session.cwd, session.sessionId)
  }
  if (!spawned.ok) {
    const m = `❌ 無法重生 claude（缺 TELEGRAM_HTTP_PORT env？tmux pane 異常？）`
    await notify(m)
    return { ok: false, message: m }
  }

  if (spawned.resumedSid) {
    if (spawned.resumedSid === session.sessionId) {
      await notify(`📜 接回 live session ${session.sessionId.slice(0, 8)} 的歷史 + 掛上 bridge...`)
    } else {
      await notify(`📜 live session 是空的，自動接回 project 最近有歷史的 session ${spawned.resumedSid.slice(0, 8)} + 掛上 bridge...`)
    }
  } else {
    await notify(`📭 該 project 沒任何歷史 session，開新 claude (fresh) + 掛上 bridge...`)
  }

  // Wait for the new MCP session to register with our bridge.
  const bridged = await waitForTakeoverMcpSession(tmuxName, 45_000)
  if (!bridged) {
    const m = `❌ claude 連 bridge 超時（>45s）— tmux ${tmuxName} 仍在，可手動 attach 看 log`
    await notify(m)
    return { ok: false, message: m }
  }

  const claudePid = await findClaudePidInTmux(tmuxName) ?? 0
  const actualSid = claudePid > 0 ? (await findSessionIdForPid(claudePid) ?? session.sessionId) : session.sessionId
  if (actualSid !== session.sessionId) {
    await notify(`ℹ️ 新 claude session-id：${actualSid.slice(0, 8)}（原 ${session.sessionId.slice(0, 8)} 已被替代）`)
  }

  writeState({
    current_target: {
      tmux: tmuxName,
      claude_pid: claudePid,
      session_id: actualSid,
      cwd: session.cwd,
    },
  })
  writeRegistryEntry(ROAMER_BOT_NAME, {
    tmux: tmuxName,
    claude_pid: claudePid,
    daemon_pid: process.pid,
    session_id: actualSid,
    cwd: session.cwd,
    updated_at: Date.now(),
    protocol: SELF_PROTOCOL,
  })

  const finalMsg = `✅ 已連線到 ${session.projectName}（${session.cwd}）— 可以開始對話`
  await notify(finalMsg)
  return { ok: true, message: finalMsg }
}

// ---- /roam slash command + callback ----------------------------------

export async function handleRoamerSlash(
  text: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<boolean> {
  if (!isRoamerEnabled()) return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false
  const [rawCmd] = trimmed.split(/\s+/)
  const cmd = rawCmd.toLowerCase()

  if (cmd === '/roam' || cmd === '/list' || cmd === '/start') {
    const sessions = await listRoamableSessions()
    const state = readState()
    const curSid = state.current_target?.session_id ?? null

    if (sessions.length === 0) {
      await replyToTg(
        '目前沒偵測到任何可漫遊的 claude session。\n\n' +
        '在 Mac mini 上 terminal 開 claude (任何專案目錄)，再回來打 /roam。',
      )
      return true
    }

    const lines = ['📍 *可漫遊的 claude session*', '']
    sessions.forEach((s, i) => {
      const mark = s.sessionId === curSid ? '🟢 當前' :
                   s.claimedBy ? `🔒 @${s.claimedBy}_bot` :
                   s.tmuxName ? '🔓 已在 tmux' :
                   '⚪ 裸 claude'
      lines.push(`${i + 1}. ${s.projectName}`)
      lines.push(`   ${s.cwd}`)
      lines.push(`   ${mark}`)
    })
    lines.push('', '👇 點按鈕切換')

    const keyboard: InlineButton[][] = sessions
      .filter(s => !s.claimedBy || s.sessionId === curSid)
      .map(s => [{
        text: `${s.sessionId === curSid ? '🟢' : '↩️'} ${s.projectName}`,
        callback_data: `roam:${s.sessionId.slice(0, 8)}`,
      }])

    await replyToTg(lines.join('\n'), { keyboard })
    return true
  }

  if (cmd === '/roam_status' || cmd === '/whoami') {
    const state = readState()
    const registry = await readActiveRegistry()
    const lines = [
      `bot: @${ROAMER_BOT_NAME}_bot`,
      `daemon pid: ${process.pid}`,
      `current target: ${state.current_target ? state.current_target.cwd : '(none)'}`,
      `bridged MCP sessions: ${tmuxToMcpSession.size}`,
      `registry entries: ${Object.keys(registry).length}`,
    ]
    for (const [bot, entry] of Object.entries(registry)) {
      lines.push(`  - ${bot}: ${entry.cwd} (claude pid ${entry.claude_pid})`)
    }
    await replyToTg(lines.join('\n'))
    return true
  }

  // Channel-bot-style commands (resume_list, resume, resume_previous, restart,
  // kill_stuck) using the CURRENT TARGET context instead of channel-bot env.
  // Delegates to the same helpers in channel-bot-control — single source of
  // truth for the heavy logic (session scan, picker driving, chain walk).
  const cbResult = await handleChannelBotCommandsForCurrentTarget(text, replyToTg)
  if (cbResult !== 'not_handled') return true

  // Otherwise: shared TUI slashes (/clear /agents /mcp /resume /model /effort
  // /sigint /help /init /compact) → forwarded to current target tmux.
  return handleTuiSlashForward(text, replyToTg)
}

/**
 * Handle channel-bot-style high-level commands using the current_target
 * context. Returns:
 *  - 'handled' if a known command was dispatched (handler replied to TG)
 *  - 'not_handled' if not a known channel-bot command (caller falls through)
 */
async function handleChannelBotCommandsForCurrentTarget(
  text: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<'handled' | 'not_handled'> {
  const trimmed = text.trim()
  const [rawCmd, ...rest] = trimmed.split(/\s+/)
  const cmd = rawCmd.toLowerCase()
  const args = rest.join(' ').trim()

  const isResumeList = (cmd === '/resume_list' || cmd === '/sessions' || cmd === '/list')
  const isResume = (cmd === '/resume')
  const isResumePrev = (cmd === '/resume_previous')
  const isRestart = (cmd === '/restart')
  const isKillStuck = (cmd === '/kill_stuck' || cmd === '/kill-stuck')

  if (!isResumeList && !isResume && !isResumePrev && !isRestart && !isKillStuck) {
    return 'not_handled'
  }

  const state = readState()
  if (!state.current_target) {
    await replyToTg(`⚠️ 尚未連線 target。打 /roam 選一個 session 再執行 ${rawCmd}。`)
    return 'handled'
  }
  const target = state.current_target
  const targetTmux = target.tmux
  const targetProjectsDir = join(PROJECTS_ROOT, cwdSlug(target.cwd))
  const targetResumeChainFile = `/tmp/roamer-${ROAMER_BOT_NAME}-resume-chain-${cwdSlug(target.cwd).replace(/[^A-Za-z0-9-]/g, '_')}.json`

  // /restart & /kill_stuck can rebuild a DEAD tmux from persisted metadata —
  // don't early-out for them. Other commands need a live target.
  if (!isRestart && !isKillStuck && !(await tmuxSessionExists(targetTmux))) {
    writeState({ current_target: null })
    deleteRegistryEntry(ROAMER_BOT_NAME)
    await replyToTg('⚠️ 當前 target 的 tmux 已不存在。重新 /roam（或 /restart 重建）。')
    return 'handled'
  }

  // /restart & /kill_stuck — 2026-07-10 rework, semantics per Joey:
  //
  // OLD behavior: /restart killed the target tmux and DROPPED the bridge —
  // the user had to /roam again from scratch; /kill_stuck SIGKILLed the
  // claude pid, which (exec panes) collapsed the session anyway.
  //
  // NEW behavior (both commands): a FULL restart of the roamer-managed
  // target driven by the persisted target metadata (tmux name / cwd /
  // session_id in ROAMER_STATE_FILE): kill + recreate the SAME-NAMED tmux
  // session (sometimes tmux itself is the thing that's wedged — and a dead
  // target is rebuildable too), relaunch a bridged claude in the original
  // workspace with --resume for conversation continuity, auto re-bridge,
  // keep chatting — no re-/roam. Recreating our OWN managed target is the
  // feature; the never-kill-attached iron rule protects OTHER people's
  // sessions (the takeover path therefore still uses in-place
  // respawn-pane). A client attached to the old session must re-attach to
  // the recreated same-named session.
  if (isRestart || isKillStuck) {
    try {
      await replyToTg(
        (isKillStuck
          ? `⛔ 強制重啟 target（原 claude PID ${target.claude_pid}）— `
          : `🔁 重啟 target — `) +
        `重建 tmux session (${targetTmux}) + 於 ${target.cwd} 重啟 claude（帶對話 resume），正在重新掛 bridge…`,
      )
      // Drop the stale tmux→MCP mapping first — otherwise waitForTakeoverMcpSession
      // sees the OLD (dying) claude's entry and declares "bridged" instantly.
      tmuxToMcpSession.delete(targetTmux)
      startTakeoverWait(targetTmux)
      // Full recreate: kill the old session (exit code ignored — it may already
      // be dead), then spawn a fresh same-named session with a bridged claude.
      await runCommand(['tmux', 'kill-session', '-t', targetTmux], 3000)
      await new Promise(r => setTimeout(r, 500))
      const spawned = await spawnTmuxWithChannelClaude(targetTmux, target.cwd, target.session_id)
      if (!spawned.ok) {
        await replyToTg(`❌ tmux 重建 / claude 啟動失敗 — 用 /roam 重新接管。`)
        writeState({ current_target: null })
        deleteRegistryEntry(ROAMER_BOT_NAME)
        return 'handled'
      }
      const bridged = await waitForTakeoverMcpSession(targetTmux, 45_000)
      if (!bridged) {
        await replyToTg(
          `⚠️ tmux ${targetTmux} 已重建、claude 已啟動，但 45s 內未接回 bridge — ` +
          `稍等再傳訊息試試，或 /roam 重新接管。`,
        )
        return 'handled'
      }
      const claudePid = await findClaudePidInTmux(targetTmux) ?? 0
      const actualSid = claudePid > 0
        ? (await findSessionIdForPid(claudePid) ?? target.session_id)
        : target.session_id
      writeState({
        current_target: {
          tmux: targetTmux,
          claude_pid: claudePid,
          session_id: actualSid,
          cwd: target.cwd,
        },
      })
      writeRegistryEntry(ROAMER_BOT_NAME, {
        tmux: targetTmux,
        claude_pid: claudePid,
        daemon_pid: process.pid,
        session_id: actualSid,
        cwd: target.cwd,
        updated_at: Date.now(),
        protocol: SELF_PROTOCOL,
      })
      await replyToTg(
        `✅ ${isKillStuck ? 'kill_stuck' : 'restart'} 完成 — tmux ${targetTmux} 已重建、claude 已重啟並接上 bridge` +
        `${spawned.resumedSid ? `（resume ${spawned.resumedSid.slice(0, 8)}… 對話脈絡保留）` : '（該 project 無歷史，fresh session）'}，直接繼續對話即可。` +
        `（原本 attach 在舊 session 的終端需重新 attach 同名 session）`,
      )
    } catch (err) {
      await replyToTg(`❌ ${isKillStuck ? 'kill_stuck' : 'restart'} 失敗: ${err instanceof Error ? err.message : err}`)
    }
    return 'handled'
  }

  // /resume_list — list sessions in current target's project folder.
  if (isResumeList) {
    const sessions = listClaudeSessions(15, targetProjectsDir)
    if (sessions.length === 0) {
      await replyToTg(`該 project (${target.cwd}) 沒有歷史 session。`)
      return 'handled'
    }
    const cur = currentSessionId(targetProjectsDir)
    const lines = [
      `📂 *${target.cwd}* 的歷史 session`,
      `（最近 ${sessions.length} 筆，最新在最前）`,
      '',
    ]
    sessions.forEach((s, i) => {
      const tag = s.id === cur ? '  ← current' : ''
      const updated = new Date(s.mtimeMs).toISOString().slice(0, 16)
      const title = (s.firstUserMessage ?? '(no preview)').slice(0, 60)
      lines.push(`${i + 1}. ${updated}  ${title}${tag}`)
      lines.push(`   \`${s.id}\``)
      if (s.lastMessages?.length) {
        for (const m of s.lastMessages) lines.push(`   ↳ ${m}`)
      }
    })
    lines.push('', '👇 點按鈕切換到該 session（picker driven via tmux）')

    const keyboard: CBCInlineButton[][] = sessions.map((s, i) => {
      const mark = s.id === cur ? '📍' : '↩️'
      const title = (s.firstUserMessage ?? '(no preview)').slice(0, 40)
      const date = new Date(s.mtimeMs).toISOString().slice(5, 16).replace('T', ' ')
      return [{
        text: `${mark} #${i + 1} ${date} ${title}`,
        callback_data: `resume:${s.id.slice(0, 8)}`,
      }]
    })

    await replyToTg(lines.join('\n'), { keyboard })
    return 'handled'
  }

  // /resume_previous — walk-back chain.
  if (isResumePrev) {
    const sessions = listClaudeSessions(50, targetProjectsDir)
    if (sessions.length < 2) {
      await replyToTg(sessions.length === 0 ? '該 project 沒有 session。' : '該 project 只有 1 個 session — 沒上一個可走。')
      return 'handled'
    }
    const cur = sessions[0].id
    const chain = loadResumeChain(targetResumeChainFile)
    if (chain.ids[chain.ids.length - 1] !== cur) chain.ids = [cur]
    const targetSession = sessions.find(s => !chain.ids.includes(s.id))
    if (!targetSession) {
      await replyToTg(`已走完該 project 全部 ${chain.ids.length} 個 session — 沒更早的。`)
      return 'handled'
    }
    const targetPickerIdx = chain.ids.length - 1
    chain.ids.push(targetSession.id)
    chain.ts = Date.now()
    try {
      await resumePickerInlineSwitch(targetPickerIdx, targetTmux)
      saveResumeChain(chain, targetResumeChainFile)
      await replyToTg(formatResumeReply({
        header: `↩️ walk-back step ${chain.ids.length - 1}`,
        session: targetSession,
        footer: `_(chain depth ${chain.ids.length}; \`/resume_previous\` again to go further back)_`,
      }))
    } catch (err) {
      await replyToTg(`❌ resume_previous 失敗: ${err instanceof Error ? err.message : err}`)
    }
    return 'handled'
  }

  // /resume <n> or /resume <uuid-prefix>
  if (isResume) {
    const sessions = listClaudeSessions(50, targetProjectsDir)
    if (sessions.length < 2) {
      await replyToTg(sessions.length === 0 ? '該 project 沒有 session。' : '該 project 只有 1 個 session — 沒可切換。')
      return 'handled'
    }
    if (!args) {
      await replyToTg('usage: `/resume <number|session-id>` (see `/resume_list`) or `/resume_previous`.')
      return 'handled'
    }
    let targetIdx = -1
    if (/^\d+$/.test(args)) {
      const i = parseInt(args, 10) - 1
      if (i < 0 || i >= sessions.length) {
        await replyToTg(`number out of range (1-${sessions.length}); use /resume_list to see ids.`)
        return 'handled'
      }
      targetIdx = i
    } else if (/^[0-9a-f-]{8,}$/i.test(args)) {
      const matches = sessions.map((s, i) => ({ s, i })).filter(({ s }) => s.id.startsWith(args.toLowerCase()))
      if (matches.length === 0) { await replyToTg(`no session matched prefix \`${args}\``); return 'handled' }
      if (matches.length > 1) { await replyToTg(`prefix \`${args}\` ambiguous (${matches.length} matches)`); return 'handled' }
      targetIdx = matches[0].i
    } else {
      await replyToTg(`unrecognized session ref \`${args}\``)
      return 'handled'
    }
    if (targetIdx === 0) { await replyToTg('that is already the current session.'); return 'handled' }
    const targetSession = sessions[targetIdx]
    try {
      await resumePickerInlineSwitch(targetIdx - 1, targetTmux)
      saveResumeChain({ ids: [targetSession.id], ts: Date.now() }, targetResumeChainFile)
      await replyToTg(formatResumeReply({
        header: `↩️ inline-switched to session #${targetIdx + 1}`,
        session: targetSession,
        footer: '_(same TUI process — chain reset)_',
      }))
    } catch (err) {
      await replyToTg(`❌ resume 失敗: ${err instanceof Error ? err.message : err}`)
    }
    return 'handled'
  }

  return 'not_handled'
}

/**
 * Forward a slash command to the current target's claude TUI via tmux
 * send-keys. Mirrors channel-bot-control's TUI-command set but uses the
 * dynamic roamer current_target instead of a fixed CHANNEL_BOT_TMUX_SESSION.
 *
 * Supported commands (claude TUI native): /clear /agents /mcp /model /effort
 * /resume /sigint (sends C-c). Other slashes get an "unknown" reply.
 *
 * Returns true if handled (so server.ts caller doesn't fall back to
 * cross-channel routing).
 */
/**
 * Delegate to the shared TUI slash forwarder in channel-bot-control. Single
 * source of truth — any TUI commands added to forwardSharedTuiSlash are
 * automatically available in roamer mode (and vice versa).
 */
async function handleTuiSlashForward(
  text: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false

  const state = readState()
  if (!state.current_target) {
    await replyToTg(`⚠️ 尚未連線 target。打 /roam 選一個 session 再執行 ${trimmed.split(/\s+/)[0]}。`)
    return true
  }
  const tmuxName = state.current_target.tmux

  if (!(await tmuxSessionExists(tmuxName))) {
    writeState({ current_target: null })
    deleteRegistryEntry(ROAMER_BOT_NAME)
    await replyToTg('⚠️ 當前 target 的 tmux 已不存在。重新 /roam。')
    return true
  }

  // Delegate to shared forwarder.
  const handled = await forwardSharedTuiSlash(text, tmuxName, replyToTg)
  if (handled) return true

  // Not a known shared TUI command. Show available list.
  const cmdName = trimmed.split(/\s+/)[0]
  const available = ['/roam', '/roam_status', ...sharedTuiCommands()].join(', ')
  await replyToTg(`未知指令 \`${cmdName}\`。可用：${available}`)
  return true
}

export async function handleRoamerCallback(
  data: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<boolean> {
  if (!isRoamerEnabled()) return false

  if (data.startsWith('roam:')) {
    const sidPrefix = data.slice('roam:'.length).trim()
    if (!sidPrefix) {
      await replyToTg('❌ empty session id prefix in callback')
      return true
    }
    const sessions = await listRoamableSessions()
    const target = sessions.find(s => s.sessionId.startsWith(sidPrefix))
    if (!target) {
      await replyToTg(`❌ 找不到 session 開頭為 \`${sidPrefix}\` 的（可能已退出）。重新 /roam`)
      return true
    }
    await replyToTg(`🔌 連線中：${target.projectName} → ${target.cwd}`)
    await connectToSession(target, msg => replyToTg(msg))
    return true
  }

  // resume: callback from /resume_list in roamer mode → drive current target's picker.
  if (data.startsWith('resume:')) {
    const sidPrefix = data.slice('resume:'.length).trim()
    if (!sidPrefix) {
      await replyToTg('❌ empty session id prefix in resume callback')
      return true
    }
    const state = readState()
    if (!state.current_target) {
      await replyToTg('⚠️ 尚未連線 target。打 /roam 選一個 session 再 resume。')
      return true
    }
    const target = state.current_target
    const targetTmux = target.tmux
    const targetProjectsDir = join(PROJECTS_ROOT, cwdSlug(target.cwd))
    const targetResumeChainFile = `/tmp/roamer-${ROAMER_BOT_NAME}-resume-chain-${cwdSlug(target.cwd).replace(/[^A-Za-z0-9-]/g, '_')}.json`
    // Reuse the same logic as `/resume <prefix>` text command — pass as text.
    return handleRoamerSlash(`/resume ${sidPrefix}`, replyToTg)
  }

  return false
}

export function roamerCommandsForBotApi(): Array<{ command: string; description: string }> {
  if (!isRoamerEnabled()) return []
  return [
    // Roamer-native
    { command: 'roam', description: 'list local claude sessions to roam' },
    { command: 'roam_status', description: 'show current target + bridge state' },
    // Channel-bot high-level commands operating on current target
    { command: 'resume_list', description: 'list current target project\'s historical sessions' },
    { command: 'resume', description: 'switch current target to a historical session (/resume <n>)' },
    { command: 'resume_previous', description: 'walk back to previous session on current target' },
    { command: 'restart', description: 'rebuild target tmux + restart claude with resume, auto re-bridge' },
    { command: 'kill_stuck', description: 'force rebuild target tmux + claude (resume kept), auto re-bridge' },
    // Shared TUI forward
    { command: 'clear', description: 'clear current target claude TUI conversation' },
    { command: 'agents', description: 'open agents picker in current target' },
    { command: 'mcp', description: 'show MCP server status in current target' },
    { command: 'help', description: 'claude TUI /help on current target' },
    { command: 'init', description: 'claude TUI /init on current target' },
    { command: 'compact', description: 'claude TUI /compact on current target' },
    { command: 'model', description: 'change current target model (/model <name>)' },
    { command: 'effort', description: 'change current target effort (/effort <level>)' },
    { command: 'codexgate', description: 'enable Codex stop-time review gate on current target' },
    { command: 'sigint', description: 'send Ctrl+C to current target' },
  ]
}
