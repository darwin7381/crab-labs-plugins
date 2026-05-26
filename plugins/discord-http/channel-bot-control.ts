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

/** tmux send-keys with Enter at the end (accepts optional tmuxName override). */
async function tmuxSendKeys(text: string, tmuxName: string = TMUX_SESSION): Promise<void> {
  const { exitCode, stderr } = await runCommand(
    ['tmux', 'send-keys', '-t', tmuxName, text, 'Enter'],
  )
  if (exitCode !== 0) {
    throw new Error(`tmux send-keys failed (${exitCode}): ${stderr.trim().slice(0, 200)}`)
  }
}

async function tmuxSendCtrlKey(key: string, tmuxName: string = TMUX_SESSION): Promise<void> {
  const { exitCode, stderr } = await runCommand(
    ['tmux', 'send-keys', '-t', tmuxName, key],
  )
  if (exitCode !== 0) {
    throw new Error(`tmux send-keys failed (${exitCode}): ${stderr.trim().slice(0, 200)}`)
  }
}

async function tmuxCapturePane(tmuxName: string = TMUX_SESSION): Promise<string> {
  const { exitCode, stdout } = await runCommand(
    ['tmux', 'capture-pane', '-t', tmuxName, '-p'],
  )
  if (exitCode !== 0) return ''
  return stdout
}

// Yes/No confirmation picker detector + auto-confirm. KEEP IN SYNC with telegram-http.
// Joey 2026-05-26 msg 1696/1700.
async function isYesNoConfirmPickerOpen(tmuxName: string = TMUX_SESSION): Promise<boolean> {
  const pane = await tmuxCapturePane(tmuxName)
  const tail = pane.split('\n').slice(-25).join('\n')
  if (/Resume session/.test(tail)) return false
  return /❯\s*1\.\s*Yes/i.test(tail) && /No,\s*go\s*back/i.test(tail)
}

async function autoConfirmYesNoPicker(tmuxName: string): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (await isYesNoConfirmPickerOpen(tmuxName)) {
      await tmuxSendKeys('', tmuxName)
      return true
    }
  }
  return false
}

async function isPickerOpen(tmuxName: string = TMUX_SESSION): Promise<boolean> {
  const pane = await tmuxCapturePane(tmuxName)
  return /Resume session\s*(\(\d+ of \d+\))?/.test(pane)
}

async function isClaudeBusy(tmuxName: string = TMUX_SESSION): Promise<boolean> {
  const pane = await tmuxCapturePane(tmuxName)
  const tail = pane.split('\n').slice(-15).join('\n')

  if (!/❯\s/.test(tail)) return true

  // Active-only indicators. Previous regex matched `✻ Crunched for ...`
  // (past-tense completion marker) as busy → false positive after a turn.
  if (/\(esc to interrupt\)/.test(tail)) return true
  if (/[✻✢]\s+\w+ing\b/.test(tail)) return true
  if (/Calling .*plugin/.test(tail)) return true
  return false
}

// ============================================================================
// SHARED TUI slash forwarder — single source of truth for "send-keys to claude"
// commands. Channel-bot and roamer both delegate here.
// ============================================================================

const SHARED_TUI_SENDABLE = new Set([
  '/clear', '/agents', '/mcp', '/resume', '/help', '/init', '/compact',
])
const SHARED_TUI_SENDABLE_WITH_ARG = new Set(['/model', '/effort'])
const SHARED_TUI_CTRL_KEY: Record<string, string> = {
  '/sigint': 'C-c',
  '/cancel': 'C-c',
}

export function sharedTuiCommands(): string[] {
  return ['/input', ...SHARED_TUI_SENDABLE, ...SHARED_TUI_SENDABLE_WITH_ARG, ...Object.keys(SHARED_TUI_CTRL_KEY)].sort()
}

/**
 * /input — raw passthrough to tmux send-keys.
 *
 * `/input <text>` sends <text> as keystrokes to the tmux session with Enter at
 * the end. Multi-line messages: each newline-separated line is sent as its own
 * send-keys call (each gets its own Enter). Useful for typing slash commands
 * the plugin would otherwise intercept (e.g. `/plugin install foo`) or for any
 * literal input that should land in the claude TUI as if typed at the keyboard.
 *
 * Must run BEFORE the verbatim-send / ctrl-key branches in
 * `forwardSharedTuiSlash`, otherwise `/input /clear` would be captured by the
 * `/clear` handler instead of being typed literally.
 *
 * KEEP IN SYNC with telegram-http/channel-bot-control.ts.
 */
async function forwardInputPassthrough(
  text: string,
  tmuxName: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<boolean> {
  const m = /^\/input(\s|$)/.exec(text)
  if (!m) return false

  const sepIdx = '/input'.length
  const payload = m[1] === '' || sepIdx >= text.length ? '' : text.slice(sepIdx + 1)

  if (!payload.trim()) {
    await replyToTg(
      'usage: `/input <text>` — sends text as keystrokes to the claude TUI ' +
        '(multi-line supported, each line gets its own Enter). ' +
        'Example:\n```\n/input /plugin marketplace add anthropics/skills\n' +
        '/plugin install document-skills@anthropic-agent-skills\n```',
    )
    return true
  }

  const lines = payload.split('\n')
  const failures: string[] = []
  let sent = 0
  for (let i = 0; i < lines.length; i++) {
    try {
      await tmuxSendKeys(lines[i], tmuxName)
      sent++
    } catch (err) {
      failures.push(`line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (failures.length === 0) {
    await replyToTg(`✅ /input — sent ${sent} line${sent === 1 ? '' : 's'} to ${tmuxName}`)
  } else {
    await replyToTg(
      `⚠️ /input — sent ${sent}/${lines.length} lines to ${tmuxName}\nfailures:\n${failures.join('\n')}`,
    )
  }
  return true
}

export async function forwardSharedTuiSlash(
  text: string,
  tmuxName: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<boolean> {
  // /input passthrough first — must beat the verbatim-send branches below so
  // `/input /clear` types `/clear` literally into the TUI instead of being
  // intercepted by the /clear handler.
  if (await forwardInputPassthrough(text, tmuxName, replyToTg)) return true

  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false
  const [rawCmd, ...rest] = trimmed.split(/\s+/)
  const cmd = rawCmd.toLowerCase()
  const args = rest.join(' ').trim()

  if (cmd in SHARED_TUI_CTRL_KEY) {
    try {
      await tmuxSendCtrlKey(SHARED_TUI_CTRL_KEY[cmd], tmuxName)
      await replyToTg(`✅ 已送 ${SHARED_TUI_CTRL_KEY[cmd]}（${cmd}）到 ${tmuxName}`)
    } catch (err) {
      await replyToTg(`❌ ${cmd} 失敗: ${err instanceof Error ? err.message : err}`)
    }
    return true
  }

  if (SHARED_TUI_SENDABLE.has(cmd)) {
    // /resume with an argument needs Phase-3's resumePickerInlineSwitch.
    // KEEP IN SYNC with telegram-http. Joey 2026-05-26 msg 1656/1657.
    if (cmd === '/resume' && args) return false
    try {
      await tmuxSendKeys(cmd, tmuxName)
      await replyToTg(`✅ 已送 \`${cmd}\` 到 ${tmuxName}`)
    } catch (err) {
      await replyToTg(`❌ ${cmd} 失敗: ${err instanceof Error ? err.message : err}`)
    }
    return true
  }

  if (SHARED_TUI_SENDABLE_WITH_ARG.has(cmd)) {
    if (!args) {
      await replyToTg(`usage: \`${cmd} <value>\``)
      return true
    }
    try {
      await tmuxSendKeys(`${cmd} ${args}`, tmuxName)
      // Auto-confirm Yes/No picker (see telegram-http). KEEP IN SYNC.
      const confirmed = await autoConfirmYesNoPicker(tmuxName)
      const suffix = confirmed ? ' (auto-confirmed picker)' : ''
      await replyToTg(`✅ 已送 \`${cmd} ${args}\` 到 ${tmuxName}${suffix}`)
    } catch (err) {
      await replyToTg(`❌ ${cmd} 失敗: ${err instanceof Error ? err.message : err}`)
    }
    return true
  }

  return false
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
    text.startsWith('Caveat: The messages below') ||
    text.startsWith('Continue from where you left off') ||
    text.includes('<user-prompt-submit-hook')
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
export function listClaudeSessions(limit = 30, projectsDirOverride?: string): ClaudeSession[] {
  const dir = projectsDirOverride ?? PROJECTS_DIR
  if (!dir || !existsSync(dir)) return []
  const out: ClaudeSession[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const full = join(dir, name)
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
    // Tail: last 2 *user* messages only (assistant replies are long
    // and generic; user questions are short and disambiguating).
    // 200 records / 1MB window — one assistant turn can emit dozens
    // of large tool blocks; smaller windows miss the prior user.
    const tailRecs = readJsonlTail(full, 200, 1024 * 1024)
    const userTail: string[] = []
    for (let i = tailRecs.length - 1; i >= 0 && userTail.length < 2; i--) {
      const ex = extractMessageExcerpt(tailRecs[i])
      if (ex && ex.role === 'user') userTail.unshift(ex.text)
    }
    if (userTail.length > 0) session.lastMessages = userTail
    out.push(session)
  }
  // Match claude TUI picker: only entrypoint=cli interactive sessions visible.
  const filtered = out.filter(s => s.entrypoint === 'cli')
  filtered.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return filtered.slice(0, limit)
}

/** "Current" session: the .jsonl most recently modified (= the running claude TUI's session). */
export function currentSessionId(projectsDirOverride?: string): string | null {
  const sessions = listClaudeSessions(1, projectsDirOverride)
  return sessions[0]?.id ?? null
}

/**
 * Drive claude TUI's /resume picker via tmux send-keys to inline-switch
 * (no process restart). Approach:
 *
 *   1. Send `/resume` to open picker
 *   2. Wait for picker render
 *   3. Press Down `pickerIdx` times (picker idx 0 highlighted by default)
 *   4. Press Enter to confirm
 *
 * CRITICAL — picker excludes the current session.
 *   listClaudeSessions returns ALL cli sessions including current at
 *   array idx 0. The TUI's /resume picker INSTEAD hides the current
 *   session. So: list array idx N (N ≥ 1) = picker idx (N - 1). Caller
 *   does the -1 before calling this. Found via picker pane capture
 *   2026-05-24 (6 entries in picker vs 7 in listClaudeSessions).
 *
 * Same-pid inline-switch verified 2026-05-22 in claude-tui-test env
 * (pid 31042 → 31042 across switch). Daemon's MCP transport remains
 * connected; in-flight messages don't drop.
 */
export async function resumePickerInlineSwitch(pickerIdx: number, tmuxOverride?: string): Promise<void> {
  const tmuxName = tmuxOverride ?? TMUX_SESSION

  // Proactive cleanup — Escape + Ctrl-C instead of fragile busy-detection.
  // See telegram-http variant for full rationale (msg 1572).
  await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'Escape'])
  await new Promise(r => setTimeout(r, 200))
  await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'C-c'])
  await new Promise(r => setTimeout(r, 600))

  await tmuxSendKeys('/resume', tmuxName)

  let pickerOk = false
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 500))
    if (await isPickerOpen(tmuxName)) { pickerOk = true; break }
  }
  if (!pickerOk) {
    await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'Escape'])
    throw new Error('picker failed to open after /resume (3s timeout) — Escape sent for safety')
  }

  for (let i = 0; i < pickerIdx; i++) {
    await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'Down'])
    await new Promise(r => setTimeout(r, 100))
  }
  await new Promise(r => setTimeout(r, 200))
  await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'Enter'])

  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise(r => setTimeout(r, 500))
    if (!(await isPickerOpen(tmuxName))) return
  }
  await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'Escape'])
  throw new Error(
    'picker still open 2s after Enter — sent Escape for cleanup. Resume may have not completed.'
  )
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

export type ResumeChain = { ids: string[]; ts: number }
export type { ClaudeSession }

export function loadResumeChain(fileOverride?: string): ResumeChain {
  const file = fileOverride ?? RESUME_CHAIN_FILE
  try {
    if (!existsSync(file)) return { ids: [], ts: 0 }
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.ids)) return { ids: [], ts: 0 }
    return { ids: parsed.ids.filter((x: unknown) => typeof x === 'string'), ts: parsed.ts ?? 0 }
  } catch { return { ids: [], ts: 0 } }
}

export function saveResumeChain(chain: ResumeChain, fileOverride?: string): void {
  const file = fileOverride ?? RESUME_CHAIN_FILE
  try {
    writeFileSync(file, JSON.stringify(chain), { mode: 0o644 })
  } catch {}
}

/**
 * Render a resume confirmation reply that shows enough context for Joey
 * to recognize WHICH session he just switched to: id prefix, when it
 * started (first user msg), and where it left off (last ~3 messages).
 */
export function formatResumeReply(opts: {
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
    lines.push('', 'last user questions:')
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
/** Inline button + reply-options types — see telegram-http variant for docs. */
export type InlineButton = { text: string; callback_data: string }
export type ReplyOptions = { keyboard?: InlineButton[][] }

export async function handleControlSlash(
  text: string,
  httpPort: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
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

  // ---- Phase 1: shared TUI slash forward (delegates to single source of truth) -----
  if (await forwardSharedTuiSlash(text, TMUX_SESSION, replyToTg)) {
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
      lines.push(`   last user questions:`)
      for (const m of curSession.lastMessages) lines.push(`     • ${m}`)
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
        for (const m of s.lastMessages) lines.push(`   ↳ ${m}`)
      }
    })
    lines.push(
      '',
      '👇 Tap a button to resume that session (UUID passed directly, no off-by-one risk).',
      'Or use `/resume <number>`, `/resume <session-id>`, `/resume_previous`.',
    )
    // Inline button row (Discord ACTION_ROW max 5 buttons per row, max 5 rows
    // = 25 buttons total). For 15-session list we pack 3 per row → 5 rows.
    const BUTTONS_PER_ROW = 3
    const keyboard: InlineButton[][] = []
    sessions.forEach((s, i) => {
      const rowIdx = Math.floor(i / BUTTONS_PER_ROW)
      if (!keyboard[rowIdx]) keyboard[rowIdx] = []
      const mark = s.id === cur ? '📍' : '↩️'
      const title = (s.firstUserMessage ?? '?').slice(0, 20)
      const date = new Date(s.mtimeMs).toISOString().slice(5, 10)
      keyboard[rowIdx].push({
        text: `${mark} #${i + 1} ${date} ${title}`,
        callback_data: `resume:${s.id.slice(0, 8)}`,
      })
    })
    await replyToTg(lines.join('\n'), { keyboard })
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
    // chain.length - 1 because:
    //   - all chain.length prior visits sit at the top of mtime-DESC
    //   - BUT picker excludes the current session (= chain[last])
    //   - target = next non-visited = picker idx chain.length - 1
    const targetPickerIdx = chain.ids.length - 1
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
      // Picker excludes current (= sessions[0]) → list idx N maps to
      // picker idx (N - 1). targetIdx ≥ 1 by early-return above.
      await resumePickerInlineSwitch(targetIdx - 1)
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
/**
 * Handle a Discord button click `custom_id` payload. Format:
 *   `resume:<8-char-uuid-prefix>` — resume that session (bypasses list-idx
 *   → picker-idx mapping). Returns true if recognized + dispatched.
 */
export async function handleCallbackData(
  data: string,
  httpPort: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<boolean> {
  if (!data.startsWith('resume:')) return false
  const uuidPrefix = data.slice('resume:'.length).trim()
  if (!uuidPrefix) {
    await replyToTg('❌ empty UUID prefix in button payload')
    return true
  }
  return handleControlSlash(`/resume ${uuidPrefix}`, httpPort, replyToTg)
}

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
    { command: 'input', description: 'send raw text to tmux (multi-line, passthrough — bypasses plugin interception)' },
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
