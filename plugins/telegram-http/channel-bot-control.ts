/**
 * Channel-bot TUI control plane.
 *
 * Intercepts slash commands sent over Telegram and runs them against the
 * channel-bot's claude TUI directly — instead of forwarding the slash as
 * a regular chat message (which claude would treat as user content, not
 * as a TUI command).
 *
 * Architecture (per discussion 2026-05-22 with Joey):
 *
 *   Joey types /clear in Telegram DM
 *         ↓
 *   plugin daemon handleInbound() sees text starts with "/"
 *         ↓
 *   handleControlSlash() — this file
 *     match against allowlist → dispatch:
 *       a. tmux send-keys (no restart, claude TUI alive)
 *       b. launchctl kickstart wrapper (graceful restart)
 *       c. pkill -9 (force-kill stuck claude, wrapper respawns)
 *       d. write /tmp/channel-bot-next-args + kickstart wrapper (resume
 *          to specific session-id by relaunching with --resume <id>)
 *
 * Opt-in: requires CHANNEL_BOT_TMUX_SESSION env var. Without it, all
 * slash commands fall through to the normal claude-as-content forward
 * (supervisor bots / non-channel-bot deployments unaffected).
 *
 * Security: handleControlSlash trusts that the inbound message has
 * ALREADY passed the gate() / allowFrom check in server.ts — never call
 * this for an unauthenticated message.
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

// ---- env-var configuration -----------------------------------------------

const TMUX_SESSION = process.env.CHANNEL_BOT_TMUX_SESSION ?? ''
const PROJECTS_DIR = process.env.CHANNEL_BOT_PROJECTS_DIR ?? ''
const WRAPPER_LABEL =
  process.env.CHANNEL_BOT_WRAPPER_LABEL ?? 'com.btai.channel-bot-wrapper'
const NEXT_ARGS_FILE =
  process.env.CHANNEL_BOT_NEXT_ARGS_FILE ?? '/tmp/channel-bot-next-args'

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
    'claude.*--channels plugin:telegram-http',
  ])
  // pkill exit 0 = at least one match; 1 = no match (already dead); >1 = error.
  return { killed: exitCode === 0 ? 1 : 0 }
}

// ---- claude session discovery (for /resume_list, /resume_previous) -------

type ClaudeSession = {
  id: string
  mtimeMs: number
  firstUserMessage?: string
}

function listClaudeSessions(limit = 20): ClaudeSession[] {
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
    // Best-effort: read first 32 KiB and find the first user-message text.
    try {
      const chunk = readFileSync(full, 'utf8').slice(0, 32 * 1024)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('{')) continue
        try {
          const j = JSON.parse(line)
          // claude jsonl varies: top-level may be {type, message, ...} or {role, content, ...}
          const role = j.role ?? j.message?.role
          if (role !== 'user') continue
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
          if (!text) continue
          // Skip framework injection ("<channel>" wrappers / system prompts)
          if (text.startsWith('<channel') || text.startsWith('<system')) continue
          session.firstUserMessage = text.slice(0, 100).replace(/\n/g, ' ')
          break
        } catch {}
      }
    } catch {}
    out.push(session)
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, limit)
}

/** "Current" session: the .jsonl most recently modified (= the running claude TUI's session). */
function currentSessionId(): string | null {
  const sessions = listClaudeSessions(1)
  return sessions[0]?.id ?? null
}

// ---- daemon health (for /status) -----------------------------------------

async function daemonStatus(httpPort: string): Promise<string> {
  try {
    const r = await fetch(`http://127.0.0.1:${httpPort}/healthz`)
    const h: any = await r.json()
    const tuiPid =
      (
        await runCommand(['pgrep', '-f', 'claude.*--channels plugin:telegram-http'])
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

  // ---- Phase 3: session resume (writes args file + kickstart) -----------
  if (cmd === '/resume_list' || cmd === '/sessions' || cmd === '/list') {
    if (!PROJECTS_DIR) {
      await replyToTg('CHANNEL_BOT_PROJECTS_DIR env var not set — cannot list claude sessions.')
      return true
    }
    // Pull 30 so we still have plenty after filtering out empty sessions.
    const allSessions = listClaudeSessions(30)
    // Filter out sessions with no first-user message (claude opens these
    // for brief inspections that never get a prompt — they're noise).
    const sessions = allSessions
      .filter(s => s.firstUserMessage && s.firstUserMessage.length > 0)
      .slice(0, 15)
    if (sessions.length === 0) {
      const skipped = allSessions.length
      await replyToTg(
        `no claude sessions with user messages found${skipped > 0 ? ` (${skipped} empty session(s) skipped)` : ''}.`,
      )
      return true
    }
    const cur = currentSessionId()
    const lines = [`claude TUI sessions (${sessions.length} shown, newest first; empty skipped):`, '']
    sessions.forEach((s, i) => {
      const tag = s.id === cur ? '  ← current' : ''
      const updated = new Date(s.mtimeMs).toISOString().slice(0, 16)
      const title = s.firstUserMessage ?? '(no user message)'
      // Two-line format: header with number + title + timestamp; full
      // UUID on its own line so it's selectable for copy-paste from TG.
      lines.push(`${i + 1}. ${updated}  ${title.slice(0, 60)}${tag}`)
      lines.push(`   \`${s.id}\``)
    })
    lines.push('', 'use `/resume <number>` (e.g. `/resume 2`), `/resume <session-id>`, or `/resume_previous`.')
    await replyToTg(lines.join('\n'))
    return true
  }

  if (cmd === '/resume' || cmd === '/resume_previous') {
    if (!PROJECTS_DIR) {
      await replyToTg('CHANNEL_BOT_PROJECTS_DIR env var not set — cannot resume.')
      return true
    }
    const allSessions = listClaudeSessions(30)
    // Apply the same empty-session filter — /resume_previous would
    // otherwise hop to an empty inspection session, which is useless
    // (claude has nothing to reload). For /resume by id/number we
    // also filter, but lookup still includes raw matches for users who
    // explicitly typed a session-id we filtered out.
    const sessions = allSessions.filter(s => s.firstUserMessage && s.firstUserMessage.length > 0)
    if (sessions.length === 0) {
      await replyToTg(
        `no claude sessions with user messages found${allSessions.length > 0 ? ` (${allSessions.length} empty session(s) skipped)` : ''}.`,
      )
      return true
    }
    const cur = currentSessionId()

    let targetId: string | null = null
    if (cmd === '/resume_previous') {
      // Find most-recent session that isn't current AND has actual content.
      const candidate = sessions.find(s => s.id !== cur)
      if (!candidate) {
        await replyToTg('only one session with messages exists, or you are already at the most recent. use `/resume_list` to pick.')
        return true
      }
      targetId = candidate.id
    } else {
      if (!args) {
        await replyToTg(
          'usage: `/resume <number|session-id>` (see `/resume_list`) or `/resume_previous`.',
        )
        return true
      }
      if (/^\d+$/.test(args)) {
        const idx = parseInt(args, 10) - 1
        if (idx < 0 || idx >= sessions.length) {
          await replyToTg(`number out of range (1-${sessions.length}); use \`/resume_list\` to see ids.`)
          return true
        }
        targetId = sessions[idx].id
      } else if (/^[0-9a-f-]{8,}$/i.test(args)) {
        // Looks like a session UUID prefix — find unique match.
        const matches = sessions.filter(s => s.id.startsWith(args.toLowerCase()))
        if (matches.length === 0) {
          await replyToTg(`no session matched prefix \`${args}\` — see \`/resume_list\``)
          return true
        }
        if (matches.length > 1) {
          await replyToTg(`prefix \`${args}\` ambiguous (matched ${matches.length}); use more characters or numeric index.`)
          return true
        }
        targetId = matches[0].id
      } else {
        await replyToTg(`unrecognized session ref \`${args}\` — use number from /resume_list or a session-id prefix.`)
        return true
      }
    }

    if (!targetId) {
      await replyToTg('(internal error: target resolution failed)')
      return true
    }

    // Write the wrapper's next-args override + kickstart.
    try {
      writeFileSync(NEXT_ARGS_FILE, `--resume ${targetId}\n`, { mode: 0o644 })
    } catch (err) {
      await replyToTg(`❌ failed to write ${NEXT_ARGS_FILE}: ${err instanceof Error ? err.message : err}`)
      return true
    }
    try {
      await restartClaudeTUI()
      await replyToTg(
        `🔁 resuming claude TUI with session \`${targetId.slice(0, 8)}…\` — tmux killed + wrapper restarting. claude online ~25s with full history reloaded.`,
      )
    } catch (err) {
      await replyToTg(`❌ restart failed: ${err instanceof Error ? err.message : err}\n\nrun \`tmux kill-session -t ${TMUX_SESSION} && launchctl kickstart -k gui/$(id -u)/${WRAPPER_LABEL}\` manually.`)
    }
    return true
  }

  return false
}

// ---- For the bot menu (Telegram setMyCommands) ---------------------------

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
