/**
 * Channel-bot TUI control plane (Discord variant).
 *
 * Intercepts slash commands sent over Discord and runs them against the
 * channel-bot's claude TUI directly — instead of forwarding the slash as
 * a regular chat message.
 *
 * This file is the **discord-http** copy. The telegram-http plugin has a
 * functionally identical file at `../telegram-http/channel-bot-control.ts`
 * — both daemons drive the same claude TUI when configured with the same
 * `CHANNEL_BOT_TMUX_SESSION` and share the same chain state at
 * `/tmp/channel-bot-resume-chain.json` (so /resume_previous walk-back
 * remains coherent whether the user is typing from Telegram or Discord).
 *
 * KEEP IN SYNC with telegram-http/channel-bot-control.ts. If you change
 * one, change both.
 *
 * Architecture (per 2026-05-22 design with Joey):
 *
 *   Joey types /clear in Discord DM
 *         ↓
 *   plugin daemon handleInbound() sees text starts with "/"
 *         ↓
 *   handleControlSlash() — this file
 *     match against allowlist → dispatch:
 *       a. tmux send-keys for native claude slashes — incl. /resume picker
 *          driven by Down + Enter for inline-switch (no restart, same pid)
 *       b. launchctl kickstart wrapper (graceful claude restart)
 *       c. pkill -9 (force-kill stuck claude, wrapper respawns)
 *
 * Opt-in: requires CHANNEL_BOT_TMUX_SESSION env var. Without it, all
 * slash commands fall through to the normal claude-as-content forward
 * (supervisor bots / non-channel-bot deployments unaffected).
 *
 * Security: handleControlSlash trusts that the inbound message has
 * ALREADY passed the gate() / allowFrom check in server.ts — never call
 * this for an unauthenticated message.
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

// ---- env-var configuration -----------------------------------------------

const TMUX_SESSION = process.env.CHANNEL_BOT_TMUX_SESSION ?? ''
const PROJECTS_DIR = process.env.CHANNEL_BOT_PROJECTS_DIR ?? ''
const WRAPPER_LABEL =
  process.env.CHANNEL_BOT_WRAPPER_LABEL ?? 'com.btai.channel-bot-wrapper'
const RESUME_CHAIN_FILE =
  process.env.CHANNEL_BOT_RESUME_CHAIN_FILE ?? '/tmp/channel-bot-resume-chain.json'
// (CHANNEL_BOT_NEXT_ARGS_FILE was used in 1.1.0 to inject --resume on
// wrapper restart. 1.2.0 inline-switches via the /resume picker instead,
// so this is no longer needed. Wrapper script can still read it for other
// future overrides but daemon never writes to it.)

/** Whether channel-bot control mode is enabled in this daemon. */
export function isControlEnabled(): boolean {
  return TMUX_SESSION !== ''
}

// ---- helpers -------------------------------------------------------------

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
  })
}

/** tmux send-keys with Enter at the end. */
async function tmuxSendKeys(text: string): Promise<void> {
  const { exitCode, stderr } = await runCommand(
    ['tmux', 'send-keys', '-t', TMUX_SESSION, text, 'Enter'],
  )
  if (exitCode !== 0) {
    throw new Error(`tmux send-keys failed (${exitCode}): ${stderr.trim().slice(0, 200)}`)
  }
}

/** tmux send a single control key like C-c (Ctrl+C). */
async function tmuxSendCtrlKey(key: string): Promise<void> {
  const { exitCode, stderr } = await runCommand(
    ['tmux', 'send-keys', '-t', TMUX_SESSION, key],
  )
  if (exitCode !== 0) {
    throw new Error(`tmux send-keys failed (${exitCode}): ${stderr.trim().slice(0, 200)}`)
  }
}

/**
 * Trigger claude TUI restart via the wrapper.
 *
 * Sequence:
 *   1. tmux kill-session — wraps up the current claude TUI (it sees
 *      SIGHUP from its parent shell dying). Wrapper's monitor loop
 *      detects "session does not exist" on next check and triggers
 *      start_claude() which reads $CHANNEL_BOT_NEXT_ARGS_FILE if present.
 *   2. launchctl kickstart -k <wrapper> — restart the wrapper script
 *      process itself (so it immediately re-enters monitor loop rather
 *      than waiting up to 30s for the next poll cycle).
 *
 * NOTE: launchctl kickstart ALONE doesn't kill claude — it only restarts
 * the wrapper script. The tmux session + claude TUI stay alive, so the
 * new wrapper instance thinks everything is healthy and does nothing.
 * This was a bug in v1.1.0 before this fix.
 */
async function restartClaudeTUI(): Promise<void> {
  // Step 1: kill tmux session — this triggers wrapper's "session does
  // not exist" branch and forces start_claude on next monitor tick.
  const killResult = await runCommand(['tmux', 'kill-session', '-t', TMUX_SESSION])
  // killResult.exitCode != 0 may just mean session was already gone — proceed regardless.

  // Step 2: kickstart wrapper so it immediately re-enters monitor loop.
  // (Without this, the next check is up to 30s away.)
  const target = `gui/${process.getuid?.() ?? 501}/${WRAPPER_LABEL}`
  const { exitCode, stderr } = await runCommand(['launchctl', 'kickstart', '-k', target])
  if (exitCode !== 0) {
    throw new Error(
      `launchctl kickstart failed (${exitCode}): ${stderr.trim().slice(0, 200)} (tmux kill: ${killResult.exitCode})`,
    )
  }
}

/** pkill -9 on claude TUI matching the channel-bot args. */
async function killStuckClaude(): Promise<{ killed: number }> {
  // Match only claude TUIs with our plugin name to avoid hitting unrelated.
  const { exitCode } = await runCommand([
    'pkill',
    '-9',
    '-f',
    'claude.*--channels plugin:discord-http',
  ])
  // pkill exit 0 = at least one match; 1 = no match (already dead); >1 = error.
  return { killed: exitCode === 0 ? 1 : 0 }
}

// ---- claude session discovery (for /resume_list, /resume_previous) -------

type ClaudeSession = {
  id: string
  mtimeMs: number
  firstUserMessage?: string
  /** Last ~3 user/assistant messages from the session tail, as
   *  formatted "user: ..." / "asst: ..." lines. Each excerpt truncated
   *  to ~120 chars. Lets Joey recognize WHICH session by its recent
   *  conversation context rather than just session id prefix. */
  lastMessages?: string[]
  entrypoint?: string
}

/**
 * Read the last N complete JSON lines from a (potentially large) jsonl
 * file by seeking near the end. Avoids loading multi-MB session files
 * into memory just to grab the tail.
 */
function readJsonlTail(path: string, maxLines: number, bytesWindow = 64 * 1024): unknown[] {
  let fd: number | null = null
  try {
    const stat = statSync(path)
    if (stat.size === 0) return []
    fd = openSync(path, 'r')
    const window = Math.min(bytesWindow, stat.size)
    const buf = Buffer.alloc(window)
    readSync(fd, buf, 0, window, stat.size - window)
    let text = buf.toString('utf8')
    if (stat.size > window) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    const out: unknown[] = []
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const line = lines[i]
      if (!line.startsWith('{')) continue
      try { out.unshift(JSON.parse(line)) } catch {}
    }
    return out
  } catch {
    return []
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch {} }
  }
}

/** Extract a flat-text excerpt from a claude jsonl message record.
 *  Returns null for records that carry no conversational content (pure
 *  tool_use / tool_result blocks, system injections) so caller can walk
 *  further back. */
function extractMessageExcerpt(rec: any): { role: 'user' | 'asst'; text: string } | null {
  const role = rec?.role ?? rec?.message?.role
  if (role !== 'user' && role !== 'assistant') return null
  const content = rec?.content ?? rec?.message?.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === 'string') { text += c + ' ' }
      else if (c?.type === 'text' && typeof c.text === 'string') { text += c.text + ' ' }
    }
  }
  text = text.trim()
  if (!text) return null
  const m = text.match(/^<channel\b[^>]*>([\s\S]*?)<\/channel>\s*$/)
  if (m) text = m[1].trim()
  if (
    text.startsWith('<system') ||
    text.startsWith('<command-') ||
    text.startsWith('<local-command-') ||
    text.startsWith('Caveat: The messages below')
  ) return null
  return {
    role: role === 'assistant' ? 'asst' : 'user',
    text: text.replace(/\s+/g, ' ').slice(0, 120),
  }
}

/**
 * List claude sessions that match what claude TUI's `/resume` picker shows.
 *
 * Critical filter: `entrypoint === "cli"` only. Sessions created by
 * `claude --print` / SDK headless calls have `entrypoint: "sdk-cli"`, and
 * claude TUI's native picker hides them. We mirror that filter so our
 * `/resume_list` numbering aligns 1:1 with the picker (= safe to drive the
 * picker by Down-arrow count for inline-switch).
 *
 * For first-user-message preview: we DO include `<channel ...>` wrapped
 * messages (they are the real user content for channel-bot deployments),
 * stripped of their outer tag for readability. Only `<system>` framework
 * injections are skipped.
 */
function listClaudeSessions(limit = 30): ClaudeSession[] {
  if (!PROJECTS_DIR || !existsSync(PROJECTS_DIR)) return []
  const out: ClaudeSession[] = []
  for (const name of readdirSync(PROJECTS_DIR)) {
    if (!name.endsWith('.jsonl')) continue
    const full = join(PROJECTS_DIR, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isFile()) continue
    const id = name.replace(/\.jsonl$/, '')
    const session: ClaudeSession = { id, mtimeMs: stat.mtimeMs }
    try {
      const chunk = readFileSync(full, 'utf8').slice(0, 32 * 1024)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('{')) continue
        let j
        try { j = JSON.parse(line) } catch { continue }
        if (!session.entrypoint && typeof j.entrypoint === 'string') {
          session.entrypoint = j.entrypoint
        }
        if (!session.firstUserMessage) {
          const role = j.role ?? j.message?.role
          if (role === 'user') {
            const content = j.content ?? j.message?.content
            let text = ''
            if (typeof content === 'string') text = content
            else if (Array.isArray(content)) {
              for (const c of content) {
                if (typeof c === 'string') { text += c; break }
                if (c?.type === 'text' && typeof c.text === 'string') { text += c.text; break }
              }
            }
            text = text.trim()
            if (text && !text.startsWith('<system')) {
              const m = text.match(/^<channel\b[^>]*>([\s\S]*?)<\/channel>\s*$/)
              if (m) text = m[1].trim()
              session.firstUserMessage = text.slice(0, 100).replace(/\s+/g, ' ')
            }
          }
        }
        if (session.entrypoint && session.firstUserMessage) break
      }
    } catch {}
    // 40 records / 128KB window — walk past tool-heavy tail noise to
    // find real conversational excerpts.
    const tailRecs = readJsonlTail(full, 40, 128 * 1024)
    const tailExcerpts: string[] = []
    for (let i = tailRecs.length - 1; i >= 0 && tailExcerpts.length < 3; i--) {
      const ex = extractMessageExcerpt(tailRecs[i])
      if (ex) tailExcerpts.unshift(`${ex.role}: ${ex.text}`)
    }
    if (tailExcerpts.length > 0) session.lastMessages = tailExcerpts
    out.push(session)
  }
  // Match claude TUI picker: only entrypoint=cli interactive sessions visible.
  const filtered = out.filter(s => s.entrypoint === 'cli')
  filtered.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return filtered.slice(0, limit)
}

/** "Current" session: the .jsonl most recently modified (= the running claude TUI's session). */
function currentSessionId(): string | null {
  const sessions = listClaudeSessions(1)
  return sessions[0]?.id ?? null
}

/**
 * Drive claude TUI's /resume picker via tmux send-keys to inline-switch
 * (no process restart). Approach:
 *
 *   1. Send `/resume` to open picker
 *   2. Wait for picker render
 *   3. Press Down N times (picker starts highlighted on index 0 = current)
 *   4. Press Enter to confirm
 *
 * Reliability requires our session list ordering to match claude picker's
 * exactly — that's why listClaudeSessions filters by `entrypoint === "cli"`
 * (same as picker) and sorts by mtime DESC (same as picker).
 *
 * Same-pid inline-switch verified 2026-05-22 in claude-tui-test env
 * (pid 31042 → 31042 across switch). Daemon's MCP transport remains
 * connected; in-flight messages don't drop.
 */
async function resumePickerInlineSwitch(downCount: number): Promise<void> {
  await tmuxSendKeys('/resume')
  await new Promise(r => setTimeout(r, 1500))  // picker render
  for (let i = 0; i < downCount; i++) {
    await runCommand(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Down'])
    await new Promise(r => setTimeout(r, 100))
  }
  await new Promise(r => setTimeout(r, 200))
  await runCommand(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Enter'])
}

// ---- /resume_previous chain (walk-back history) --------------------------
//
// Naive "previous = mtime-second-newest" causes ping-pong: after switching
// A→B, mtime of B is now newest, A is second-newest, so next call goes
// B→A. Forever.
//
// Chain semantics: track sessions visited via /resume_previous within a
// single walk-back chain. Each call:
//   1. If current matches chain[last] → still in chain; advance to next
//      mtime-DESC session not yet visited.
//   2. Otherwise (user did /resume <N>, sent a new message in a different
//      session, etc.) → reset chain to [current].
//
// After K calls, chain.length = K+1; target picker index = chain.length-1
// when picker re-sorts (because all K prior visits became newest mtimes
// and now sit at picker indices 0..K-1).

type ResumeChain = { ids: string[]; ts: number }

function loadResumeChain(): ResumeChain {
  try {
    if (!existsSync(RESUME_CHAIN_FILE)) return { ids: [], ts: 0 }
    const raw = readFileSync(RESUME_CHAIN_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.ids)) return { ids: [], ts: 0 }
    return { ids: parsed.ids.filter((x: unknown) => typeof x === 'string'), ts: parsed.ts ?? 0 }
  } catch { return { ids: [], ts: 0 } }
}

function saveResumeChain(chain: ResumeChain): void {
  try {
    writeFileSync(RESUME_CHAIN_FILE, JSON.stringify(chain), { mode: 0o644 })
  } catch {}
}

/**
 * Render a resume confirmation reply that shows enough context for Joey
 * to recognize WHICH session he just switched to: id prefix, when it
 * started (first user msg), and where it left off (last ~3 messages).
 */
function formatResumeReply(opts: {
  header: string
  session: ClaudeSession
  footer: string
}): string {
  const { header, session, footer } = opts
  const lines = [
    `${header} → \`${session.id.slice(0, 8)}…\``,
    `started: ${(session.firstUserMessage ?? '(no preview)').slice(0, 100)}`,
  ]
  if (session.lastMessages?.length) {
    lines.push('', 'last messages (tail of session):')
    for (const m of session.lastMessages) lines.push(`  • ${m}`)
  }
  lines.push('', footer)
  return lines.join('\n')
}

// ---- daemon health (for /status) -----------------------------------------

async function daemonStatus(httpPort: string): Promise<string> {
  try {
    const r = await fetch(`http://127.0.0.1:${httpPort}/healthz`)
    const h: any = await r.json()
    const tuiPid =
      (
        await runCommand(['pgrep', '-f', 'claude.*--channels plugin:discord-http'])
      ).stdout.trim().split('\n')[0] || '?'
    return [
      `daemon: pid=${h.pid} uptime=${h.uptime_s}s sessions=${h.active_sessions}`,
      `bot: ${h.bot_username ?? '?'} polling=${h.polling}`,
      `lastUpdate: ${h.last_update_id ?? 0}`,
      `pending: ${h.pending_disk_count ?? 0}`,
      `claude TUI pid: ${tuiPid}`,
    ].join('\n')
  } catch (err) {
    return `(daemon health probe failed: ${err instanceof Error ? err.message : err})`
  }
}

// ---- main dispatch -------------------------------------------------------

/**
 * Try to handle `text` as a channel-bot control slash command.
 * Returns true if it was handled (caller should NOT forward to claude),
 * false if not (caller continues with normal claude forward).
 */
export async function handleControlSlash(
  text: string,
  httpPort: string,
  replyToTg: (msg: string) => Promise<void>,
): Promise<boolean> {
  if (!isControlEnabled()) return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false
  const [rawCmd, ...rest] = trimmed.split(/\s+/)
  const cmd = rawCmd.toLowerCase()
  const args = rest.join(' ').trim()

  const tryRun = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn() } catch (err) {
      await replyToTg(`❌ ${label} failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // ---- Phase 1: tmux send-keys (claude native slashes) -------------------
  if (cmd === '/clear' || cmd === '/help' || cmd === '/agents' || cmd === '/mcp') {
    await tryRun(`tmux send-keys ${cmd}`, async () => {
      await tmuxSendKeys(cmd)
      await replyToTg(`✅ sent \`${cmd}\` to claude TUI`)
    })
    return true
  }
  if (cmd === '/model' || cmd === '/effort') {
    if (!args) {
      await replyToTg(`usage: \`${cmd} <value>\``)
      return true
    }
    await tryRun(`tmux send-keys ${cmd} ${args}`, async () => {
      await tmuxSendKeys(`${cmd} ${args}`)
      await replyToTg(`✅ sent \`${cmd} ${args}\``)
    })
    return true
  }
  if (cmd === '/sigint') {
    await tryRun('tmux send-keys C-c', async () => {
      await tmuxSendCtrlKey('C-c')
      await replyToTg('✅ sent Ctrl+C — current turn interrupted')
    })
    return true
  }

  // ---- Phase 2: system-level control ------------------------------------
  if (cmd === '/restart') {
    await tryRun('restart claude TUI', async () => {
      await restartClaudeTUI()
      await replyToTg('🔁 restarting channel-bot — tmux session killed + wrapper kickstarted. claude TUI back online ~25s.')
    })
    return true
  }
  if (cmd === '/kill-stuck' || cmd === '/kill_stuck') {
    await tryRun('pkill -9 claude TUI', async () => {
      const r = await killStuckClaude()
      await replyToTg(
        r.killed > 0
          ? '⛔ kill -9 sent — wrapper will auto-respawn within ~30s'
          : '(no matching claude TUI to kill; wrapper may already be respawning)',
      )
    })
    return true
  }
  if (cmd === '/status') {
    const s = await daemonStatus(httpPort)
    await replyToTg(`📊 channel-bot status\n\n${s}`)
    return true
  }

  // ---- Phase 3: session resume (tmux picker inline-switch, no restart) --
  if (cmd === '/resume_list' || cmd === '/sessions' || cmd === '/list') {
    if (!PROJECTS_DIR) {
      await replyToTg('CHANNEL_BOT_PROJECTS_DIR env var not set — cannot list claude sessions.')
      return true
    }
    const sessions = listClaudeSessions(15)
    if (sessions.length === 0) {
      await replyToTg('no claude TUI sessions in project dir (entrypoint=cli).')
      return true
    }
    const cur = currentSessionId()
    const curSession = sessions.find(s => s.id === cur) ?? sessions[0]
    const chain = loadResumeChain()
    const chainNote =
      chain.ids.length > 1 && chain.ids[chain.ids.length - 1] === cur
        ? `   walk-back chain depth: ${chain.ids.length} (next /resume_previous → step ${chain.ids.length + 1})`
        : ''
    const lines = [
      `📍 *current session*  \`${curSession.id}\``,
      `   started: ${(curSession.firstUserMessage ?? '(no preview)').slice(0, 90)}`,
    ]
    if (curSession.lastMessages?.length) {
      lines.push(`   last:`)
      for (const m of curSession.lastMessages.slice(-2)) lines.push(`     • ${m}`)
    }
    if (chainNote) lines.push(chainNote)
    lines.push('', `claude TUI sessions (${sessions.length}, newest first — matches /resume picker):`, '')
    sessions.forEach((s, i) => {
      const tag = s.id === cur ? '  ← current' : ''
      const updated = new Date(s.mtimeMs).toISOString().slice(0, 16)
      const title = s.firstUserMessage ?? '(no preview)'
      lines.push(`${i + 1}. ${updated}  ${title.slice(0, 60)}${tag}`)
      lines.push(`   \`${s.id}\``)
      if (s.lastMessages?.length) {
        const last = s.lastMessages[s.lastMessages.length - 1]
        lines.push(`   ↳ ${last}`)
      }
    })
    lines.push(
      '',
      'use `/resume <number>` (e.g. `/resume 2`), `/resume <session-id>`, or `/resume_previous`.',
      '_(inline-switch via picker — no restart, no message loss)_',
    )
    await replyToTg(lines.join('\n'))
    return true
  }

  if (cmd === '/resume_previous') {
    if (!PROJECTS_DIR) {
      await replyToTg('CHANNEL_BOT_PROJECTS_DIR env var not set — cannot resume.')
      return true
    }
    const sessions = listClaudeSessions(50)
    if (sessions.length < 2) {
      await replyToTg(
        sessions.length === 0
          ? 'no claude TUI sessions found.'
          : 'only one session exists — nothing to walk back to.',
      )
      return true
    }
    const cur = sessions[0].id  // picker top = mtime newest = current

    // Chain semantics: if last chain entry == current, we're continuing the
    // walk-back. Otherwise reset (user did /resume <N>, sent a new message,
    // or some other action that moved us out of the chain).
    const chain = loadResumeChain()
    if (chain.ids[chain.ids.length - 1] !== cur) {
      chain.ids = [cur]
    }
    // Pick the first session in mtime-DESC order that isn't already in chain.
    const targetSession = sessions.find(s => !chain.ids.includes(s.id))
    if (!targetSession) {
      await replyToTg(
        `walked back through all ${chain.ids.length} session(s) — no older history. use \`/resume_list\` to jump anywhere.`,
      )
      return true
    }
    // Picker re-sorts on each invocation; target's picker index equals
    // chain.length because all chain.length prior visits now sit at the
    // top of mtime-DESC order.
    const targetPickerIdx = chain.ids.length
    chain.ids.push(targetSession.id)
    chain.ts = Date.now()

    await tryRun('resume_previous (chain walk-back)', async () => {
      await resumePickerInlineSwitch(targetPickerIdx)
      saveResumeChain(chain)
      await replyToTg(formatResumeReply({
        header: `↩️ walk-back step ${chain.ids.length - 1}`,
        session: targetSession,
        footer: `_(chain depth ${chain.ids.length}; \`/resume_previous\` again to go further back)_`,
      }))
    })
    return true
  }

  if (cmd === '/resume') {
    if (!PROJECTS_DIR) {
      await replyToTg('CHANNEL_BOT_PROJECTS_DIR env var not set — cannot resume.')
      return true
    }
    const sessions = listClaudeSessions(50)
    if (sessions.length < 2) {
      await replyToTg(
        sessions.length === 0
          ? 'no claude TUI sessions found.'
          : 'only one session exists — nothing to switch to.',
      )
      return true
    }
    if (!args) {
      await replyToTg('usage: `/resume <number|session-id>` (see `/resume_list`) or `/resume_previous`.')
      return true
    }
    let targetIdx = -1
    if (/^\d+$/.test(args)) {
      const i = parseInt(args, 10) - 1
      if (i < 0 || i >= sessions.length) {
        await replyToTg(`number out of range (1-${sessions.length}); use \`/resume_list\` to see ids.`)
        return true
      }
      targetIdx = i
    } else if (/^[0-9a-f-]{8,}$/i.test(args)) {
      const matches = sessions
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.id.startsWith(args.toLowerCase()))
      if (matches.length === 0) {
        await replyToTg(`no session matched prefix \`${args}\` — see \`/resume_list\``)
        return true
      }
      if (matches.length > 1) {
        await replyToTg(`prefix \`${args}\` ambiguous (matched ${matches.length}); use more chars or numeric index.`)
        return true
      }
      targetIdx = matches[0].i
    } else {
      await replyToTg(`unrecognized session ref \`${args}\` — use number from /resume_list or a session-id prefix.`)
      return true
    }
    if (targetIdx === 0) {
      await replyToTg('that is already the current session — nothing to do.')
      return true
    }
    const target = sessions[targetIdx]
    await tryRun('resume via picker (tmux inline-switch)', async () => {
      await resumePickerInlineSwitch(targetIdx)
      // Explicit pick resets walk-back chain to start fresh from this session.
      saveResumeChain({ ids: [target.id], ts: Date.now() })
      await replyToTg(formatResumeReply({
        header: `↩️ inline-switched to session #${targetIdx + 1}`,
        session: target,
        footer: '_(same TUI process — chain reset)_',
      }))
    })
    return true
  }

  return false
}

// ---- For Discord application command registration (if/when we wire it up).
// Discord doesn't auto-show the autocomplete the way Telegram setMyCommands
// does — slash commands need to be registered to the Discord application
// via the gateway, which the current daemon doesn't do. Exposed here for
// API symmetry with telegram-http; today users just type the command. ---

export function controlCommandsForBotApi(): Array<{
  command: string
  description: string
}> {
  if (!isControlEnabled()) return []
  return [
    { command: 'clear', description: 'clear claude TUI conversation (sends /clear via tmux)' },
    { command: 'model', description: 'switch claude model (/model <name>)' },
    { command: 'effort', description: 'switch claude effort level (/effort <low|med|high|max>)' },
    { command: 'agents', description: 'open claude agents picker' },
    { command: 'mcp', description: 'show MCP servers status in claude' },
    { command: 'sigint', description: 'send Ctrl+C — interrupt current turn' },
    { command: 'restart', description: 'restart channel-bot wrapper (graceful claude restart)' },
    { command: 'kill_stuck', description: 'kill -9 stuck claude TUI; wrapper respawns' },
    { command: 'status', description: 'show daemon + claude TUI health' },
    { command: 'resume_list', description: 'list recent claude sessions for resuming' },
    { command: 'resume', description: 'resume to a session by number or id (/resume 2)' },
    { command: 'resume_previous', description: 'resume to previous session (skipping current)' },
  ]
}
