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
import { homedir } from 'node:os'
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
async function tmuxSendKeys(text: string, tmuxName: string = TMUX_SESSION, clearFirst = false): Promise<void> {
  // clearFirst — 2026-07-03 (ported from telegram-http): a control slash
  // (/model, /clear, ...) is typed AT THE CURSOR. If the user left a draft in
  // the TUI input box, `send-keys "/model X" Enter` appends → the whole
  // `<draft>/model X` line submits as a CHAT MESSAGE, the command never runs,
  // and it looks stuck. Ctrl-U clears claude's input line. MUST be its own
  // send-keys call: `send-keys Escape C-u` merges into an escape SEQUENCE and
  // does nothing, and Escape also risks interrupting a running turn — so C-u
  // alone, on its own call. NOT used by /input (raw passthrough stays verbatim).
  if (clearFirst) {
    await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'C-u'])
    await new Promise(r => setTimeout(r, 100))  // let the TUI apply the clear before typing
  }
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

// (autoConfirmYesNoPicker — the old fire-and-forget picker poll — was removed
// 2026-07-10, KEEP IN SYNC with telegram-http 1.12.0: subsumed by
// runTuiSwitchCommand below, which waits for idle BEFORE typing and keeps
// confirming/verifying until an honest outcome.)

// ---- /model & /effort switch orchestration (ported from telegram-http 1.12.0) ----
//
// Root cause of Joey's "/model 幾乎都失敗" (reproduced on TG lab, claude 2.1.206):
// a control slash typed while claude is MID-TURN is not executed — the TUI
// puts it in the QUEUED MESSAGES buffer ("Press up to edit queued messages").
// When the turn finally ends the queued command executes and (with enough
// history) opens the "Switch model? / 1. Yes / 2. No, go back" picker — but by
// then the old fire-and-forget auto-confirm window was long dead, so the
// picker sat open forever and the session looked hung. Production agents are
// almost always mid-turn when Joey sends /model ⇒ "幾乎都失敗".
//
// Fix: an orchestrator that (1) waits for idle BEFORE typing (no queueing),
// (2) types the command, (3) watches for the confirm picker and Enters it
// whenever it shows up (bounded but generous), (4) VERIFIES the switch took
// effect (global settings.json for /model — claude 2.1.198+ persists the
// choice there immediately; pane "Set model to …" line as fallback), and
// (5) sends a follow-up Discord message reporting confirmed / unconfirmed
// honestly. The immediate "已送" reply no longer claims success.

/** How long we're willing to wait for claude to go idle before typing. */
const SWITCH_IDLE_WAIT_MS = 10 * 60_000
/** Post-type verification window (extended while the command sits queued). */
const SWITCH_VERIFY_MS = 45_000
/** Hard cap on the whole orchestration, idle-wait included. */
const SWITCH_TOTAL_CAP_MS = 12 * 60_000

/** Strip context-window suffixes like `[1m]` and lowercase, for comparisons. */
function normalizeModelId(v: string): string {
  return v.trim().toLowerCase().replace(/\[[0-9]+m\]$/, '')
}

/** `model` key of ~/.claude/settings.json — what claude TUI's /model persists. */
function readGlobalDefaultModel(): string | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    return typeof j?.model === 'string' && j.model ? j.model : null
  } catch { return null }
}

/** Where we remember the last CONFIRMED /model switch (per-daemon). */
function lastSwitchStatePath(): string {
  const stateDir = process.env.DISCORD_STATE_DIR ?? process.env.TELEGRAM_STATE_DIR ?? ''
  if (stateDir) return join(stateDir, 'last-model-switch.json')
  return `/tmp/channel-bot-last-model-switch-${TMUX_SESSION || 'default'}.json`
}

function saveLastConfirmedSwitch(value: string): void {
  try {
    writeFileSync(lastSwitchStatePath(), JSON.stringify({ value, ts: Date.now() }), { mode: 0o644 })
  } catch {}
}

function loadLastConfirmedSwitch(): { value: string; ts: number } | null {
  try {
    const j = JSON.parse(readFileSync(lastSwitchStatePath(), 'utf8'))
    if (typeof j?.value === 'string' && typeof j?.ts === 'number') return j
  } catch {}
  return null
}

/**
 * Best-effort "which model is this agent on right now" for the /model picker
 * (Joey 2026-07-10: the picker must show the current model).
 *
 * Sources, newest-timestamp wins:
 *  1. last CONFIRMED switch recorded by runTuiSwitchCommand (this daemon)
 *  2. `message.model` of the newest assistant record in the current session
 *     jsonl — the model that actually produced the agent's latest reply
 *  3. global ~/.claude/settings.json `model` (what an un-pinned TUI inherits)
 */
export function detectCurrentModel(projectsDirOverride?: string): { id: string; source: string } | null {
  let best: { id: string; source: string; ts: number } | null = null

  const sw = loadLastConfirmedSwitch()
  if (sw && sw.value !== 'default') best = { id: sw.value, source: '剛切換（TUI 已確認）', ts: sw.ts }

  const dir = projectsDirOverride ?? PROJECTS_DIR
  const sid = dir ? currentSessionId(dir) : null
  if (dir && sid) {
    const recs = readJsonlTail(join(dir, `${sid}.jsonl`), 80, 1024 * 1024)
    for (let i = recs.length - 1; i >= 0; i--) {
      const r: any = recs[i]
      const model = r?.message?.model
      if (r?.type === 'assistant' && typeof model === 'string' && model) {
        const ts = Date.parse(r?.timestamp ?? '') || 0
        if (!best || ts > best.ts) best = { id: model, source: '本 session 最近回覆實際使用', ts }
        break
      }
    }
  }

  // Global default competes by settings.json mtime: if the default changed
  // AFTER this agent's last reply (another bot's /model, manual edit, or a
  // restart-inheritance), it is the freshest signal. An un-pinned TUI adopts
  // it on its next start, so label it honestly as the default, not a
  // guarantee of the live TUI value.
  const g = readGlobalDefaultModel()
  if (g) {
    let mtime = 0
    try { mtime = statSync(join(homedir(), '.claude', 'settings.json')).mtimeMs } catch {}
    if (!best || mtime > best.ts) best = { id: g, source: '全域預設（未 pin 的 TUI 重啟後採用）', ts: mtime }
  }
  return best ? { id: best.id, source: best.source } : null
}

/**
 * Execute `/model X` or `/effort X` against the TUI reliably, then report the
 * REAL outcome to the user. Designed to be run in the background (caller
 * replies immediately). Never throws — all outcomes end in a notify().
 */
async function runTuiSwitchCommand(opts: {
  cmd: string
  value: string
  tmuxName: string
  notify: (msg: string) => Promise<void>
}): Promise<void> {
  const { cmd, value, tmuxName, notify } = opts
  const t0 = Date.now()
  const full = `${cmd} ${value}`
  try {
    // Phase 1 — wait for idle. Typing mid-turn queues the command as a chat
    // message (2.1.206) instead of executing it: the original failure.
    let idleOk = false
    while (Date.now() - t0 < SWITCH_IDLE_WAIT_MS) {
      // A leftover Yes/No confirm picker from an earlier wedged switch blocks
      // everything — dismiss it (Escape = "No, go back": safe, non-destructive).
      if (await isYesNoConfirmPickerOpen(tmuxName)) {
        await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'Escape'])
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      if (!(await isClaudeBusy(tmuxName))) { idleOk = true; break }
      await new Promise(r => setTimeout(r, 1000))
    }
    if (!idleOk) {
      await notify(
        `❌ \`${full}\` 未執行 — claude 忙碌超過 ${Math.round(SWITCH_IDLE_WAIT_MS / 60000)} 分鐘，` +
        `為避免指令被排進訊息佇列造成卡死，已放棄。等 turn 結束後再試一次。`,
      )
      return
    }

    // Phase 2 — snapshot + type (Ctrl-U clears any draft first).
    // The pane-evidence BASELINE must be taken before typing: scrollback may
    // already contain an identical old `/model X` + "Set model to …" from an
    // earlier switch, and matching those would false-confirm (hit on TG lab
    // 2026-07-10 — only evidence FRESHER than this baseline may count).
    const setLineRe = /Set (model|effort)[^\n]*/g
    const countSetLines = (pane: string): number => (pane.match(setLineRe) ?? []).length
    const baselineSetLines = countSetLines(await tmuxCapturePane(tmuxName))
    const prevModel = readGlobalDefaultModel()
    await tmuxSendKeys(full, tmuxName, true)

    // Phase 3 — watch for outcome. Confirm the Yes/No picker whenever it
    // appears; verify via settings.json (/model) or a fresh "Set model/effort"
    // pane line. If the command still ended up queued (race: a new inbound
    // started a turn between the idle check and our keystroke), keep watching
    // until the queue flushes, within the total cap.
    const isModel = cmd === '/model'
    const wantSettings = isModel && value !== 'default'
    let deadline = Date.now() + SWITCH_VERIFY_MS
    let confirmedPicker = false
    let confirmed: string | null = null
    while (Date.now() < deadline && Date.now() - t0 < SWITCH_TOTAL_CAP_MS) {
      await new Promise(r => setTimeout(r, 400))

      if (await isYesNoConfirmPickerOpen(tmuxName)) {
        await tmuxSendKeys('', tmuxName)  // bare Enter — default cursor is on "Yes"
        confirmedPicker = true
        continue
      }

      if (wantSettings) {
        // PRIMARY evidence for /model: claude persists the choice to global
        // settings.json the moment the switch applies. Filesystem truth — no
        // pane-parsing ambiguity.
        const cur = readGlobalDefaultModel()
        if (cur && normalizeModelId(cur) === normalizeModelId(value)) {
          confirmed = `settings.json → \`${cur}\``
          break
        }
      }
      const pane = await tmuxCapturePane(tmuxName)
      // Secondary evidence (and primary for /effort and `/model default`):
      // a "Set model/effort …" line COUNT above the pre-type baseline — old
      // identical lines in scrollback don't count.
      if (countSetLines(pane) > baselineSetLines) {
        const all = pane.match(setLineRe) ?? []
        confirmed = `TUI:「${(all[all.length - 1] ?? '').trim().slice(0, 80)}」`
        break
      }
      // Command got queued behind a racing turn — extend the watch window.
      if (/Press up to edit queued messages/.test(pane)) {
        deadline = Date.now() + SWITCH_VERIFY_MS
      }
    }

    if (confirmed) {
      if (isModel) saveLastConfirmedSwitch(value)
      await notify(`✅ \`${full}\` 已生效（${confirmed}${confirmedPicker ? '，切換確認已自動按 Enter' : ''}）`)
      if (isModel && prevModel && normalizeModelId(prevModel) !== normalizeModelId(value) && value !== 'default') {
        await notify(
          `⚠️ 注意：claude 的 /model 會把 \`${value}\` 存成整台機器的全域預設（原本是 \`${prevModel}\`）— ` +
          `其他未 pin --model 的 agent 下次重啟會繼承。`,
        )
      }
    } else {
      const pane = await tmuxCapturePane(tmuxName)
      const tail = pane.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' ⏎ ')
      await notify(
        `⚠️ \`${full}\` 已送出，但 ${Math.round((Date.now() - t0) / 1000)}s 內未觀察到生效證據` +
        `（settings.json 未變、TUI 沒有 Set model/effort 回應）。可能 model id 無效或 TUI 狀態異常。\n` +
        `pane 尾部：${tail.slice(0, 200)}`,
      )
    }
  } catch (err) {
    await notify(`❌ \`${full}\` 執行過程出錯: ${err instanceof Error ? err.message : err}`).catch(() => {})
  }
}

/**
 * /codexgate — type `/codex:setup --enable-review-gate` into the attached
 * claude TUI (ported from telegram-http 1.12.0, Joey 2026-07-10 P5). Same
 * busy-safety as runTuiSwitchCommand: wait for idle so the command isn't
 * queued as a chat message, type it, then verify the TUI actually
 * received/echoed it (fresh occurrence count vs a pre-type baseline — old
 * scrollback doesn't count) and report honestly.
 */
async function runCodexGate(tmuxName: string, notify: (msg: string) => Promise<void>): Promise<void> {
  const t0 = Date.now()
  try {
    let idleOk = false
    while (Date.now() - t0 < SWITCH_IDLE_WAIT_MS) {
      if (await isYesNoConfirmPickerOpen(tmuxName)) {
        await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'Escape'])
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      if (!(await isClaudeBusy(tmuxName))) { idleOk = true; break }
      await new Promise(r => setTimeout(r, 1000))
    }
    if (!idleOk) {
      await notify(
        `❌ \`/codexgate\` 未執行 — claude 忙碌超過 ${Math.round(SWITCH_IDLE_WAIT_MS / 60000)} 分鐘，等 turn 結束後再試。`,
      )
      return
    }

    const countGateLines = (pane: string): number => (pane.match(/codex:setup/g) ?? []).length
    const baseline = countGateLines(await tmuxCapturePane(tmuxName))
    await tmuxSendKeys(CODEX_GATE_TUI_CMD, tmuxName, true)

    let deadline = Date.now() + SWITCH_VERIFY_MS
    let seen = false
    while (Date.now() < deadline && Date.now() - t0 < SWITCH_TOTAL_CAP_MS) {
      await new Promise(r => setTimeout(r, 400))
      const pane = await tmuxCapturePane(tmuxName)
      const queued = /Press up to edit queued messages/.test(pane)
      if (queued) { deadline = Date.now() + SWITCH_VERIFY_MS; continue }
      if (countGateLines(pane) > baseline) { seen = true; break }
    }

    if (seen) {
      await notify(
        `✅ \`/codexgate\` — 已在 ${tmuxName} 執行 \`${CODEX_GATE_TUI_CMD}\`（TUI 已收到，Codex stop-time review gate 開啟中）`,
      )
    } else {
      const pane = await tmuxCapturePane(tmuxName)
      const tail = pane.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' ⏎ ')
      await notify(
        `⚠️ \`${CODEX_GATE_TUI_CMD}\` 已送出但 ${Math.round((Date.now() - t0) / 1000)}s 內未在 TUI 觀察到執行痕跡。pane 尾部：${tail.slice(0, 200)}`,
      )
    }
  } catch (err) {
    await notify(`❌ /codexgate 執行過程出錯: ${err instanceof Error ? err.message : err}`).catch(() => {})
  }
}

async function isPickerOpen(tmuxName: string = TMUX_SESSION): Promise<boolean> {
  const pane = await tmuxCapturePane(tmuxName)
  return /Resume session\s*(\(\d+ of \d+\))?/.test(pane)
}

async function isClaudeBusy(tmuxName: string = TMUX_SESSION): Promise<boolean> {
  const pane = await tmuxCapturePane(tmuxName)
  const tail = pane.split('\n').slice(-15).join('\n')

  if (!/❯\s/.test(tail)) return true

  // Active-only busy indicators (KEEP IN SYNC with telegram-http 1.12.0):
  //   - `esc to interrupt` — canonical "claude is actively processing" footer.
  //     2.1.198-era footers wrapped it in parens `(esc to interrupt)`; claude
  //     2.1.206 renders it bare in the status bar (`… · esc to interrupt · …`).
  //     Match WITHOUT parens so both generations register as busy (verified on
  //     TG lab 2026-07-10 — the paren-only regex called a mid-turn 2.1.206 idle).
  //   - `✻/✢/✶/✽ <verb>ing` — present-continuous spinner (Crunching, Creating…).
  //     2.1.206 rotates through more spinner glyphs (✶ observed live).
  //   - `Press up to edit queued messages` — input already queued behind an
  //     active turn ⇒ definitely busy (2.1.206 queued-state marker).
  //   - `Calling .*plugin` — active plugin call
  //
  // Previous regex matched `✻ Crunched for ...` (past-tense completion marker)
  // as busy → false positive after a turn.
  if (/esc to interrupt/.test(tail)) return true
  if (/[✻✢✶✽✳✱∗]\s+\w+ing\b/.test(tail)) return true
  if (/Press up to edit queued messages/.test(tail)) return true
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

/**
 * Model options offered by the bare `/model` inline keyboard (ported from
 * telegram-http; Joey 2026-07-02 msg 2434: typing exact model ids from memory
 * is hostile UX — tap to pick). Override without a code change via
 * CHANNEL_BOT_MODEL_CHOICES, format:
 *   "Label=value|Label=value"  e.g. "Fable 5=claude-fable-5|Opus=claude-opus-4-8"
 * Values are what gets typed after `/model ` in the claude TUI (alias or full id).
 */
const DEFAULT_MODEL_CHOICES: Array<{ label: string; value: string }> = [
  // Fable 5.1 requires CLI >=2.1.251 (fleet on 2.1.259 since 2026-09-03).
  { label: '✨ Fable 5.1', value: 'claude-fable-5-1' },
  { label: '🌟 Fable 5', value: 'claude-fable-5' },
  // Opus 4.8 → Opus 5, aligned with telegram-http (Joey 5461 dropped 4.8
  // from the picker; still selectable manually via `/model claude-opus-4-8`).
  { label: '🏺 Opus 5', value: 'claude-opus-5' },
  { label: '🎼 Sonnet 5', value: 'claude-sonnet-5' },
  { label: '⚡ Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { label: '↩️ Default（回 TUI 預設）', value: 'default' },
]

export function modelChoices(): Array<{ label: string; value: string }> {
  const raw = process.env.CHANNEL_BOT_MODEL_CHOICES
  if (!raw) return DEFAULT_MODEL_CHOICES
  const parsed = raw
    .split('|')
    .map(pair => {
      const eq = pair.indexOf('=')
      if (eq <= 0) return null
      return { label: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() }
    })
    .filter((x): x is { label: string; value: string } => !!x && !!x.label && !!x.value)
  return parsed.length > 0 ? parsed : DEFAULT_MODEL_CHOICES
}

const SHARED_TUI_CTRL_KEY: Record<string, string> = {
  '/sigint': 'C-c',
  '/cancel': 'C-c',
}

/**
 * /codexgate → types this into the attached claude TUI (Joey 2026-07-10 P5).
 * Kept as an alias on Discord too (parity with TG, where bot commands can't
 * contain a colon). Enables the codex plugin's stop-time review gate.
 */
const CODEX_GATE_TUI_CMD = '/codex:setup --enable-review-gate'

export function sharedTuiCommands(): string[] {
  return ['/input', '/codexgate', ...SHARED_TUI_SENDABLE, ...SHARED_TUI_SENDABLE_WITH_ARG, ...Object.keys(SHARED_TUI_CTRL_KEY)].sort()
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

  // /codexgate — enable the Codex stop-time review gate on the attached
  // claude (types /codex:setup --enable-review-gate). Busy-safe + verified
  // in the background like /model. KEEP IN SYNC with telegram-http 1.12.0.
  if (cmd === '/codexgate') {
    const busyNow = await isClaudeBusy(tmuxName)
    await replyToTg(
      busyNow
        ? `🕐 claude 正在跑 turn — /codexgate 已排程，等 turn 結束後送 \`${CODEX_GATE_TUI_CMD}\`，結果會再通知`
        : `📤 /codexgate — 正在送 \`${CODEX_GATE_TUI_CMD}\` 到 ${tmuxName}，結果稍後通知`,
    )
    void runCodexGate(tmuxName, msg => replyToTg(msg))
    return true
  }

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
      await tmuxSendKeys(cmd, tmuxName, true)  // clearFirst: drop any draft so the command isn't polluted
      await replyToTg(`✅ 已送 \`${cmd}\` 到 ${tmuxName}`)
    } catch (err) {
      await replyToTg(`❌ ${cmd} 失敗: ${err instanceof Error ? err.message : err}`)
    }
    return true
  }

  if (SHARED_TUI_SENDABLE_WITH_ARG.has(cmd)) {
    if (!args) {
      // Bare `/model` → tap-to-pick inline buttons (Joey 2026-07-02 msg 2434:
      // "我哪知道準確的代號是什麼"). Channel-bot mode only (fixed TMUX_SESSION):
      // the `model:` callback routes through handleCallbackData → TMUX_SESSION,
      // which would mis-target in roamer mode, so roamer keeps the usage text.
      if (cmd === '/model' && tmuxName === TMUX_SESSION && isControlEnabled()) {
        // Mark the current model on its button + a status line (Joey
        // 2026-07-10: "選單要能看出目前是哪個模型").
        const current = detectCurrentModel()
        const curNorm = current ? normalizeModelId(current.id) : null
        const keyboard: InlineButton[][] = modelChoices().map(c => {
          const isCur = curNorm !== null && c.value !== 'default' && normalizeModelId(c.value) === curNorm
          return [{ text: isCur ? `✅ ${c.label}（目前）` : c.label, callback_data: `model:${c.value}` }]
        })
        const curLine = current
          ? `目前模型：\`${current.id}\`（${current.source}）\n`
          : '目前模型：無法判定（尚無本 session 回覆紀錄）\n'
        await replyToTg(
          '🎛️ 點一個模型切換（或手動 `/model <id>`）：\n' +
            curLine +
            '⚠️ claude 的 /model 會把選擇存成「全域預設」— 這台機器所有 agent 下次重啟都會用它（有 --model pin 的除外）。',
          { keyboard },
        )
        return true
      }
      await replyToTg(`usage: \`${cmd} <value>\``)
      return true
    }
    try {
      // 2026-07-10 rework (KEEP IN SYNC with telegram-http 1.12.0): do NOT
      // type immediately — claude 2.1.206 queues a mid-turn slash as a chat
      // message instead of executing it, and the confirm picker can appear
      // only after the current turn ends (past any short auto-confirm window)
      // → stuck picker + "switch failed". runTuiSwitchCommand waits for idle,
      // types, confirms the picker whenever it appears, VERIFIES the switch
      // (settings.json / pane), and follows up with an honest ✅/⚠️
      // notification. We reply immediately so the user knows the command was
      // accepted (but no longer claim it was "sent").
      const busyNow = await isClaudeBusy(tmuxName)
      await replyToTg(
        busyNow
          ? `🕐 claude 正在跑 turn — \`${cmd} ${args}\` 已排程，等 turn 結束後執行（最多等 ${Math.round(SWITCH_IDLE_WAIT_MS / 60000)} 分鐘），結果會再通知`
          : `📤 已送 \`${cmd} ${args}\` 到 ${tmuxName} — 生效與否稍後通知`,
      )
      void runTuiSwitchCommand({ cmd, value: args, tmuxName, notify: msg => replyToTg(msg) })
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
  // `model:<value>` — emitted by the bare-`/model` inline buttons. Reuse the
  // `/model <value>` slash path (busy-safe orchestration) so logic isn't forked.
  if (data.startsWith('model:')) {
    const value = data.slice('model:'.length).trim()
    if (!value) {
      await replyToTg('❌ empty model value in callback data')
      return true
    }
    // Model ids/aliases only — defense against forged callback payloads
    // (send-keys with shell-ish chars must never reach tmux).
    if (!/^[A-Za-z0-9._\[\]-]{1,48}$/.test(value)) {
      await replyToTg(`❌ invalid model value in callback: \`${value.slice(0, 60)}\``)
      return true
    }
    return handleControlSlash(`/model ${value}`, httpPort, replyToTg)
  }
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
    { command: 'model', description: 'switch claude model — tap-to-pick buttons, or /model <id>' },
    { command: 'codexgate', description: 'enable Codex stop-time review gate (/codex:setup --enable-review-gate)' },
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
