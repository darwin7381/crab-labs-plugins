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

/**
 * tmux send-keys with Enter at the end.
 *
 * Accepts optional tmuxName so callers outside channel-bot context
 * (e.g. roamer-control) can target a different pane. Default = the
 * channel-bot's own TMUX_SESSION env.
 */
async function tmuxSendKeys(text: string, tmuxName: string = TMUX_SESSION, clearFirst = false): Promise<void> {
  // clearFirst — 2026-07-03: a control slash (/model, /clear, ...) is typed AT THE
  // CURSOR. If the user left a draft in the TUI input box, `send-keys "/model X"
  // Enter` appends → the whole `<draft>/model X` line submits as a CHAT MESSAGE,
  // the command never runs, and it looks stuck (Joey's report, reproduced on lab).
  // Ctrl-U clears claude's input line (verified). MUST be its own send-keys call:
  // `send-keys Escape C-u` merges into an escape SEQUENCE and does nothing, and
  // Escape also risks interrupting a running turn — so C-u alone, on its own call.
  // NOT used by /input (raw passthrough must stay verbatim).
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

/** tmux send a single control key like C-c (Ctrl+C). */
async function tmuxSendCtrlKey(key: string, tmuxName: string = TMUX_SESSION): Promise<void> {
  const { exitCode, stderr } = await runCommand(
    ['tmux', 'send-keys', '-t', tmuxName, key],
  )
  if (exitCode !== 0) {
    throw new Error(`tmux send-keys failed (${exitCode}): ${stderr.trim().slice(0, 200)}`)
  }
}

/** tmux capture-pane → returns plain text (with ANSI stripped). */
async function tmuxCapturePane(tmuxName: string = TMUX_SESSION): Promise<string> {
  const { exitCode, stdout } = await runCommand(
    ['tmux', 'capture-pane', '-t', tmuxName, '-p'],
  )
  if (exitCode !== 0) return ''
  return stdout
}

/**
 * Detect a Yes/No confirmation picker (e.g. /effort, /model — TUI asks
 * "Change effort level? ❯ 1. Yes, switch ... 2. No, go back"). Default cursor
 * is "Yes" so a bare Enter confirms.
 *
 * Heuristic: pane contains "Yes" + "go back" near each other within the last
 * 20 lines (typical picker footprint) AND a numbered "1." line marked with
 * the cursor "❯". Excludes the /resume picker (already driven separately).
 *
 * `requiredKeyword` (#9, 2026-07-10): callers about to AUTO-ENTER the picker
 * must pass the keyword matching THEIR command (`Switch model?` for /model,
 * `effort` for /effort). A generic Yes/No picker without the keyword (some
 * other dialog that happened to open) then does NOT get blind-confirmed.
 * Callers that only need "is any confirm picker blocking the pane" (leftover
 * dismissal) omit it.
 */
async function isYesNoConfirmPickerOpen(tmuxName: string = TMUX_SESSION, requiredKeyword?: RegExp): Promise<boolean> {
  const pane = await tmuxCapturePane(tmuxName)
  const tail = pane.split('\n').slice(-25).join('\n')
  if (/Resume session/.test(tail)) return false // handled separately
  if (!(/❯\s*1\.\s*Yes/i.test(tail) && /No,\s*go\s*back/i.test(tail))) return false
  if (requiredKeyword && !requiredKeyword.test(tail)) return false
  return true
}

// (autoConfirmYesNoPicker — the 1.11.2 fire-and-forget 25s picker poll — was
// removed 2026-07-10: subsumed by runTuiSwitchCommand below, which waits for
// idle BEFORE typing and keeps confirming/verifying until an honest outcome.)

// ---- /model & /effort switch orchestration (P1/P3/P4, 2026-07-10) ---------
//
// Root cause of Joey's "/model 幾乎都失敗" (reproduced on lab, claude 2.1.206):
// a control slash typed while claude is MID-TURN is not executed — the TUI
// puts it in the QUEUED MESSAGES buffer ("Press up to edit queued messages").
// When the turn finally ends the queued command executes and (with enough
// history) opens the "Switch model? / 1. Yes / 2. No, go back" picker — but by
// then the old fire-and-forget 25s autoConfirm window was long dead, so the
// picker sat open forever and the session looked hung. Production agents are
// almost always mid-turn when Joey sends /model ⇒ "幾乎都失敗".
//
// Fix: an orchestrator that (1) waits for idle BEFORE typing (no queueing),
// (2) types the command, (3) watches for the confirm picker and Enters it
// whenever it shows up (bounded but generous), (4) VERIFIES the switch took
// effect (global settings.json for /model — claude 2.1.198+ persists the
// choice there immediately; pane "Set model to …" line as fallback), and
// (5) sends a follow-up TG message reporting confirmed / unconfirmed
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

/**
 * #10 (2026-07-10, opt-in): CHANNEL_BOT_MODEL_SCOPE=session — claude's /model
 * always persists the choice as the MACHINE-WIDE default in ~/.claude/
 * settings.json (side effect: every un-pinned agent inherits it on restart).
 * With session scope, after a CONFIRMED switch we write the pre-switch value
 * back, so the switch is effective inside the live TUI only and the global
 * default stays unpolluted. Default (env unset) keeps today's behavior.
 */
function isModelScopeSession(): boolean {
  return (process.env.CHANNEL_BOT_MODEL_SCOPE ?? '').trim().toLowerCase() === 'session'
}

/** Write `model` back into ~/.claude/settings.json (null ⇒ remove the key),
 *  preserving every other key. Returns false on any error. */
function restoreGlobalDefaultModel(prev: string | null): boolean {
  try {
    const p = join(homedir(), '.claude', 'settings.json')
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (prev === null) delete j.model
    else j.model = prev
    writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
    return true
  } catch { return false }
}

/**
 * #7 (2026-07-10): per-tmux switch-in-flight lock. runTuiSwitchCommand can
 * legitimately run for MINUTES (waits out a busy turn before typing). A second
 * /model fired during that window used to start a SECOND orchestrator against
 * the same pane — two idle-waiters racing to type, double confirm-Enters, and
 * interleaved notifications. Now the second command is refused immediately
 * with the in-flight target named. Value = human-readable `cmd value` string.
 */
const switchInFlight = new Map<string, string>()  // tmuxName → "/model X"

/** Where we remember the last CONFIRMED /model switch (per-daemon). */
function lastSwitchStatePath(): string {
  const stateDir = process.env.TELEGRAM_STATE_DIR ?? process.env.DISCORD_STATE_DIR ?? ''
  if (stateDir) return join(stateDir, 'last-model-switch.json')
  return `/tmp/channel-bot-last-model-switch-${TMUX_SESSION || 'default'}.json`
}

function saveLastConfirmedSwitch(value: string, tmux: string): void {
  try {
    writeFileSync(lastSwitchStatePath(), JSON.stringify({ value, ts: Date.now(), tmux }), { mode: 0o644 })
  } catch {}
}

function loadLastConfirmedSwitch(tmux: string): { value: string; ts: number } | null {
  try {
    const j = JSON.parse(readFileSync(lastSwitchStatePath(), 'utf8'))
    // Per-target: a roamer daemon keeps ONE record file shared across all its
    // roam targets, so only trust it for the SAME target it was recorded on —
    // otherwise a switch on target A would mislabel target B's "current model".
    // Records from before this field existed (no j.tmux) are ignored → the
    // caller falls through to the jsonl's actual last-reply model. Channel-bot
    // always passes its fixed TMUX_SESSION, so it matches and is unaffected.
    if (typeof j?.value === 'string' && typeof j?.ts === 'number' && j?.tmux === tmux) {
      return { value: j.value, ts: j.ts }
    }
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
export function detectCurrentModel(projectsDirOverride?: string, tmuxName?: string): { id: string; source: string } | null {
  let best: { id: string; source: string; ts: number } | null = null

  // Per-target record: only honor a recorded switch when we know which target
  // we're reporting for (roamer passes its current target's tmux; channel-bot
  // passes TMUX_SESSION). Without a tmux we skip it and rely on the jsonl.
  const sw = tmuxName ? loadLastConfirmedSwitch(tmuxName) : null
  if (sw && sw.value !== 'default') best = { id: sw.value, source: '剛切換（TUI 已確認）', ts: sw.ts }

  const dir = projectsDirOverride ?? PROJECTS_DIR
  const sid = dir ? currentSessionId(dir) : null
  if (dir && sid) {
    // Widen the tail window until an assistant record with `model` appears.
    // A fixed 80-line/1MB read can land entirely inside a run of huge
    // tool-result lines on a long session and miss every assistant record —
    // then the old code fell through to the global default and REPORTED IT AS
    // CURRENT (2026-07-28: Joey's /model said fable-5 while the agent was
    // actually running opus-4-8).
    const path = join(dir, `${sid}.jsonl`)
    outer: for (const [lines, bytes] of [[80, 1024 * 1024], [320, 4 * 1024 * 1024], [1280, 16 * 1024 * 1024], [5120, 64 * 1024 * 1024]] as const) {
      const recs = readJsonlTail(path, lines, bytes)
      for (let i = recs.length - 1; i >= 0; i--) {
        const r: any = recs[i]
        const model = r?.message?.model
        if (r?.type === 'assistant' && typeof model === 'string' && model) {
          const ts = Date.parse(r?.timestamp ?? '') || 0
          if (!best || ts > best.ts) best = { id: model, source: '本 session 最近回覆實際使用', ts }
          break outer
        }
      }
    }
  }

  // The global default NEVER competes with live evidence. The old
  // settings.json-mtime race let a freshly-touched default (another bot's
  // /model confirm, a guard write, a manual edit) outrank what the live TUI
  // demonstrably ran — the exact "顯示 fable5、實跑 4.8" lie. A default only
  // describes what an un-pinned TUI adopts on its NEXT restart, so it is
  // reported only when there is no live evidence at all, labeled as such.
  if (best) return { id: best.id, source: best.source }
  const g = readGlobalDefaultModel()
  if (g) return { id: g, source: '全域預設（查無本 session 實跑紀錄，重啟後才保證生效）' }
  return null
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
  // #9: the auto-Enter of the confirm picker requires the picker to carry the
  // keyword of THIS command — never blind-confirm an unrelated Yes/No dialog.
  const confirmKeyword = cmd === '/model' ? /Switch model\?/i : /effort/i
  try {
    // Phase 1 — wait for idle. Typing mid-turn queues the command as a chat
    // message (2.1.206) instead of executing it: the original P1 failure.
    // #15: idle requires two consecutive clean samples (isClaudeIdleStable) —
    // a single pane capture can land mid-repaint and read false-idle.
    let idleOk = false
    while (Date.now() - t0 < SWITCH_IDLE_WAIT_MS) {
      // A leftover Yes/No confirm picker from an earlier wedged switch blocks
      // everything — dismiss it (Escape = "No, go back": safe, non-destructive).
      if (await isYesNoConfirmPickerOpen(tmuxName)) {
        await runCommand(['tmux', 'send-keys', '-t', tmuxName, 'Escape'])
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      if (await isClaudeIdleStable(tmuxName)) { idleOk = true; break }
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
    // earlier switch, and matching those would false-confirm (hit on lab
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

      // #9: Enter ONLY when the picker carries this command's keyword
      // (`Switch model?` / `effort`) — a keyword-less Yes/No dialog that
      // happens to open mid-watch is NOT ours and must not be blind-confirmed.
      if (await isYesNoConfirmPickerOpen(tmuxName, confirmKeyword)) {
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
      // #10 — session scope: undo the global-default side effect BEFORE
      // recording the confirmed switch, so detectCurrentModel's newest-
      // timestamp-wins logic prefers the confirmed switch over the (older,
      // restored) settings.json mtime.
      let scopeNote = ''
      if (isModel && value !== 'default' && isModelScopeSession()) {
        const ok = restoreGlobalDefaultModel(prevModel)
        scopeNote = ok
          ? `\n🔒 scope=session：全域預設已還原為 \`${prevModel ?? '(未設定)'}\` — 本 TUI 內用 \`${value}\`，其他 agent 不受污染。`
          : `\n⚠️ scope=session 還原全域預設失敗 — 請手動檢查 ~/.claude/settings.json（原值 \`${prevModel ?? '(未設定)'}\`）。`
      }
      if (isModel) saveLastConfirmedSwitch(value, tmuxName)
      await notify(`✅ \`${full}\` 已生效（${confirmed}${confirmedPicker ? '，切換確認已自動按 Enter' : ''}）${scopeNote}`)
      if (isModel && !isModelScopeSession() && prevModel && normalizeModelId(prevModel) !== normalizeModelId(value) && value !== 'default') {
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
  } finally {
    // #7: release the per-tmux in-flight lock no matter how we exited.
    switchInFlight.delete(tmuxName)
  }
}

/**
 * /codexgate — type `/codex:setup --enable-review-gate` into the attached
 * claude TUI (Joey 2026-07-10 P5). Same busy-safety as runTuiSwitchCommand:
 * wait for idle so the command isn't queued as a chat message, type it, then
 * verify the TUI actually received/echoed it (fresh occurrence count vs a
 * pre-type baseline — old scrollback doesn't count) and report honestly.
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
      if (await isClaudeIdleStable(tmuxName)) { idleOk = true; break }  // #15 double-sample
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

/** Is claude TUI's `/resume` picker overlay currently rendered? */
async function isPickerOpen(tmuxName: string = TMUX_SESSION): Promise<boolean> {
  const pane = await tmuxCapturePane(tmuxName)
  return /Resume session\s*(\(\d+ of \d+\))?/.test(pane)
}

/**
 * Busy-marker table (#15, 2026-07-10 — extracted to a constant so the marker
 * set has ONE home; adding a new TUI-generation marker means one line here).
 *
 * Active-only busy indicators:
 *   - `esc to interrupt` — canonical "claude is actively processing" footer.
 *     2.1.198-era footers wrapped it in parens `(esc to interrupt)`; claude
 *     2.1.206 renders it bare in the status bar (`… · esc to interrupt · …`).
 *     Match WITHOUT parens so both generations register as busy (verified on
 *     lab 2026-07-10 — the paren-only regex called a mid-turn 2.1.206 idle).
 *   - `✻/✢/✶/✽ <verb>ing` — present-continuous spinner (Crunching, Creating…).
 *     2.1.206 rotates through more spinner glyphs (✶ observed live).
 *   - `Press up to edit queued messages` — input already queued behind an
 *     active turn ⇒ definitely busy (2.1.206 queued-state marker).
 *   - `Calling .*plugin` — active plugin call
 *
 * Joey 2026-05-25 (msg 1570): previous regex matched `✻ Crunched for 1m 17s`
 * (past-tense historical marker shown AFTER turn completes) as busy →
 * /resume_list buttons failed even when claude was idle for an hour.
 */
const BUSY_PANE_MARKERS: readonly RegExp[] = [
  /esc to interrupt/,
  /[✻✢✶✽✳✱∗]\s+\w+ing\b/,
  /Press up to edit queued messages/,
  /Calling .*plugin/,
]

/** Is claude TUI mid-tool-call / mid-turn (not at the idle ❯ prompt)? */
async function isClaudeBusy(tmuxName: string = TMUX_SESSION): Promise<boolean> {
  const pane = await tmuxCapturePane(tmuxName)
  const tail = pane.split('\n').slice(-15).join('\n')

  // No prompt indicator at bottom → busy.
  if (!/❯\s/.test(tail)) return true

  return BUSY_PANE_MARKERS.some(re => re.test(tail))
}

// #15 (2026-07-10): single-sample idle checks race the TUI's render loop — a
// pane captured mid-repaint (footer momentarily blank between spinner frames /
// during a screen clear) reads as idle for one frame even though a turn is
// running, and typing on that false-idle queues the command as chat. Require
// TWO consecutive idle samples, a beat apart, before declaring idle.
const IDLE_CONFIRM_SAMPLES = 2
const IDLE_SAMPLE_GAP_MS = 500

/** Idle only if `IDLE_CONFIRM_SAMPLES` consecutive samples all read idle. */
async function isClaudeIdleStable(tmuxName: string = TMUX_SESSION): Promise<boolean> {
  for (let i = 0; i < IDLE_CONFIRM_SAMPLES; i++) {
    if (await isClaudeBusy(tmuxName)) return false
    if (i < IDLE_CONFIRM_SAMPLES - 1) await new Promise(r => setTimeout(r, IDLE_SAMPLE_GAP_MS))
  }
  return true
}

// ============================================================================
// SHARED TUI slash forwarder — single source of truth for "send-keys to claude"
// commands. Channel-bot and roamer both delegate here. Adding a new TUI-side
// slash means updating ONLY the constants below.
// ============================================================================

const SHARED_TUI_SENDABLE = new Set([
  '/clear', '/agents', '/mcp', '/resume', '/help', '/init', '/compact',
])
const SHARED_TUI_SENDABLE_WITH_ARG = new Set(['/model', '/effort'])

/**
 * Model options offered by the bare `/model` inline keyboard (Joey 2026-07-02
 * msg 2434: typing exact model ids from memory is hostile UX — tap to pick).
 * Override without a code change via CHANNEL_BOT_MODEL_CHOICES, format:
 *   "Label=value|Label=value"  e.g. "Fable 5=claude-fable-5|Opus=claude-opus-4-8"
 * Values are what gets typed after `/model ` in the claude TUI (alias or full id).
 */
const DEFAULT_MODEL_CHOICES: Array<{ label: string; value: string }> = [
  { label: '🌟 Fable 5', value: 'claude-fable-5' },
  { label: '🏺 Opus 5', value: 'claude-opus-5' },
  { label: '🏛️ Opus 4.8', value: 'claude-opus-4-8' },
  { label: '🎼 Sonnet 5', value: 'claude-sonnet-5' },
  { label: '⚡ Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { label: '↩️ Default（回 TUI 預設）', value: 'default' },
]

/** Short stable hash of a tmux name — embedded in model: callback_data so a
 * roamer picker tap can be validated against the CURRENT target at tap time
 * (guards the "opened picker for A, switched to B, tapped" mis-target case
 * that originally kept the picker channel-bot-only — issue #7). */
export function tmuxHash6(name: string): string {
  let h = 5381
  for (const c of name) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(8, '0').slice(0, 6)
}

/** Effort options for the bare `/effort` inline keyboard (Joey 2026-07-24 msg
 * 5417: bare /effort answered `usage:` while bare /model gives a picker —
 * inconsistent UX). Levels verified against the pinned CLI binary literal:
 * `"level": "low" | "medium" | "high" | "xhigh" | "max"`. */
const EFFORT_CHOICES: Array<{ label: string; value: string }> = [
  { label: '🐢 low', value: 'low' },
  { label: '⚖️ medium', value: 'medium' },
  { label: '🚀 high', value: 'high' },
  { label: '🔥 xhigh', value: 'xhigh' },
  { label: '🏔️ max', value: 'max' },
]
const EFFORT_VALUE_RE = /^(low|medium|high|xhigh|max)$/

/** Current effort for the picker's ✅ mark — claude's /effort persists to
 * machine-global settings.json `effortLevel` (same pattern as /model). */
function detectCurrentEffort(): { level: string; source: string } | null {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    if (typeof s.effortLevel === 'string' && s.effortLevel) {
      return { level: s.effortLevel, source: 'settings.json 全域' }
    }
  } catch { /* unreadable settings — picker still works, just no ✅ mark */ }
  return null
}

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
 * TG bot commands can't contain a colon, hence the alias. Enables the codex
 * plugin's stop-time review gate on the session.
 */
const CODEX_GATE_TUI_CMD = '/codex:setup --enable-review-gate'

/** Names of all shared TUI commands, for help text + roamer's unknown-command branch. */
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
 * Returns true if handled.
 */
async function forwardInputPassthrough(
  text: string,
  tmuxName: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<boolean> {
  // Match "/input" followed by whitespace (space, tab, newline) or end-of-string.
  // Case-sensitive — `/Input` is a user typo, don't silently absorb it.
  const m = /^\/input(\s|$)/.exec(text)
  if (!m) return false

  // Payload starts after the first separator char (space / tab / \n).
  // If matched `$`, payload is empty.
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

/**
 * Try to handle text as one of the shared TUI commands. Sends keys to the
 * given tmux pane. Returns true if handled (so caller skips further dispatch).
 */
export async function forwardSharedTuiSlash(
  text: string,
  tmuxName: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
  // Roamer passes the CURRENT target's projects dir (derived from its cwd) so
  // the bare-/model picker's "current model" line reads the right session's
  // jsonl. Omitted in channel-bot mode → detectCurrentModel falls back to the
  // fixed CHANNEL_BOT_PROJECTS_DIR env. (issue #8)
  projectsDirOverride?: string,
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
  // claude (types /codex:setup --enable-review-gate; TG commands can't
  // carry a colon). Busy-safe + verified in the background like /model.
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
    // /resume with an argument needs Phase-3's resumePickerInlineSwitch (which
    // drives the picker by tmux arrow keys to reach a specific session).
    // The bare send-keys path here only types the command literally — it can't
    // navigate the picker and silently drops the UUID/number arg. Fall through
    // so handleControlSlash's /resume <id> branch gets it. (Joey 2026-05-26 msg
    // 1656/1657: inline-keyboard button clicks were a no-op because of this.)
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
      // Bare `/model` → tap-to-pick inline keyboard (Joey 2026-07-02 msg 2434:
      // "我哪知道準確的代號是什麼"). Works for BOTH the fixed channel-bot session
      // and dynamic roamer targets (issue #7 — same-version UX was inconsistent
      // and read as "old deployment"): dynamic targets embed a tmux-name hash in
      // the callback so the tap is validated against the CURRENT target.
      // Gate on having a target session, NOT isControlEnabled(): the latter is
      // `TMUX_SESSION !== ''`, which is FALSE in roamer mode (no fixed session),
      // so it silently killed the bare-/model picker for roamers — bare /model
      // fell through to the `usage: /model <value>` error (regression report
      // 2026-07-13). `tmuxName` is the actual target (fixed session OR the
      // roam-<x> pane) and is non-empty in both modes; the branch below already
      // handles dynamic roamer targets via the tmuxHash6 callback suffix.
      if (cmd === '/model' && tmuxName !== '') {
        // Mark the current model on its button + a status line (Joey
        // 2026-07-10: "選單要能看出目前是哪個模型").
        const isFixed = tmuxName === TMUX_SESSION
        const cbSuffix = isFixed ? '' : `@${tmuxHash6(tmuxName)}`
        const current = detectCurrentModel(projectsDirOverride, tmuxName)
        const curNorm = current ? normalizeModelId(current.id) : null
        const keyboard: InlineButton[][] = modelChoices().map(c => {
          const isCur = curNorm !== null && c.value !== 'default' && normalizeModelId(c.value) === curNorm
          return [{ text: isCur ? `✅ ${c.label}（目前）` : c.label, callback_data: `model:${c.value}${cbSuffix}` }]
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
      // Bare `/effort` → same tap-to-pick UX as bare /model (Joey 5417).
      if (cmd === '/effort' && tmuxName !== '') {
        const isFixed = tmuxName === TMUX_SESSION
        const cbSuffix = isFixed ? '' : `@${tmuxHash6(tmuxName)}`
        const cur = detectCurrentEffort()
        const keyboard: InlineButton[][] = EFFORT_CHOICES.map(c => {
          const isCur = cur !== null && c.value === cur.level
          return [{ text: isCur ? `✅ ${c.label}（目前）` : c.label, callback_data: `effort:${c.value}${cbSuffix}` }]
        })
        const curLine = cur
          ? `目前 effort：\`${cur.level}\`（${cur.source}）\n`
          : '目前 effort：無法判定（settings.json 無 effortLevel）\n'
        await replyToTg(
          '🎚️ 點一個 effort 等級切換（或手動 `/effort <value>`）：\n' +
            curLine +
            '⚠️ claude 的 /effort 會存成整台機器的全域預設（下次重啟的 agent 都吃它）。',
          { keyboard },
        )
        return true
      }
      await replyToTg(`usage: \`${cmd} <value>\``)
      return true
    }
    try {
      // #7 (2026-07-10): one switch orchestration per tmux at a time. A second
      // /model|/effort while one is still in flight (possibly minutes of
      // idle-waiting) is refused with the in-flight target named — otherwise
      // two orchestrators race the same pane (double type, double Enter).
      const inFlight = switchInFlight.get(tmuxName)
      if (inFlight) {
        await replyToTg(
          `⏳ 已有切換進行中（目標 \`${inFlight}\`）— 等它完成（成功/失敗都會通知）後再下 \`${cmd} ${args}\`。`,
        )
        return true
      }
      switchInFlight.set(tmuxName, `${cmd} ${args}`)
      // 2026-07-10 (P1/P4 rework): do NOT type immediately — claude 2.1.206
      // queues a mid-turn slash as a chat message instead of executing it, and
      // the confirm picker can appear only after the current turn ends (past
      // any short auto-confirm window) → stuck picker + "switch failed".
      // runTuiSwitchCommand waits for idle, types, confirms the picker whenever
      // it appears, VERIFIES the switch (settings.json / pane), and follows up
      // with an honest ✅/⚠️ notification. We reply immediately so the user
      // knows the command was accepted (but no longer claim it was "sent").
      const busyNow = await isClaudeBusy(tmuxName)
      await replyToTg(
        busyNow
          ? `🕐 claude 正在跑 turn — \`${cmd} ${args}\` 已排程，等 turn 結束後執行（最多等 ${Math.round(SWITCH_IDLE_WAIT_MS / 60000)} 分鐘），結果會再通知`
          : `📤 已送 \`${cmd} ${args}\` 到 ${tmuxName} — 生效與否稍後通知`,
      )
      void runTuiSwitchCommand({ cmd, value: args, tmuxName, notify: msg => replyToTg(msg) })
    } catch (err) {
      switchInFlight.delete(tmuxName)  // don't leave a stale lock if the pre-flight reply threw
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
 *      detects "session does not exist" on next check (≤30s) and triggers
 *      start_claude() which reads $CHANNEL_BOT_NEXT_ARGS_FILE if present.
 *      THIS ALONE is the restart — step 2 is only a health backstop.
 *   2. launchctl print <wrapper> — verify the wrapper service is running.
 *      Only if it is NOT running, plain `launchctl kickstart` (no -k)
 *      starts it, with a timeout that rides out launchd's
 *      ThrottleInterval spawn deferral.
 *
 * 2026-07-16 rework — the old step 2 was `kickstart -k` (kill + respawn)
 * to make the wrapper re-enter its loop immediately instead of ≤30s later.
 * For supervisor-managed agents WRAPPER_LABEL is the SHARED
 * com.btai.agent-supervisor, so every /restart bounced the fleet-wide
 * watchdog; consecutive /restarts (Joey restarting several bots in a row)
 * landed each kickstart inside the previous respawn's ThrottleInterval=10s
 * window, `kickstart -k` blocks until the deferred respawn, runCommand's
 * 8s default SIGKILLed it → exit 124 → "❌ restart failed" while the agent
 * was in fact fine. The bounce also wiped supervisor in-memory state
 * (fail counts / orphan tracking / cooldowns) and forced a slow serial
 * first-pass heal of every TUI killed in the same window. Killing the
 * kickstart also left the supervisor DOWN for the rest of the throttle
 * window. Net: -k was strictly worse than letting the running wrapper's
 * own tick pick up the dead session.
 */
async function restartClaudeTUI(): Promise<string> {
  // Step 1: kill tmux session — this triggers wrapper's "session does
  // not exist" branch and forces start_claude on next monitor tick.
  const killResult = await runCommand(['tmux', 'kill-session', '-t', TMUX_SESSION])
  // killResult.exitCode != 0 may just mean session was already gone — proceed regardless.

  // Step 2: health backstop — never `kickstart -k` a healthy wrapper.
  const target = `gui/${process.getuid?.() ?? 501}/${WRAPPER_LABEL}`
  const probe = await runCommand(['launchctl', 'print', target], 5000)
  if (probe.exitCode === 0 && /state = running/.test(probe.stdout)) {
    return `wrapper (${WRAPPER_LABEL}) 健在，監控 tick 會自動重啟 TUI`
  }
  // Wrapper not running / not loaded → plain kickstart (no -k: nothing to
  // kill). 25s timeout > ThrottleInterval=10s so a throttle-deferred spawn
  // completes instead of being SIGKILLed into a fake 124.
  const kick = await runCommand(['launchctl', 'kickstart', target], 25000)
  if (kick.exitCode !== 0) {
    throw new Error(
      `wrapper ${WRAPPER_LABEL} not running AND kickstart failed (${kick.exitCode}): ${kick.stderr.trim().slice(0, 200)} (tmux kill: ${killResult.exitCode})`,
    )
  }
  return `wrapper (${WRAPPER_LABEL}) 剛才沒在跑，已重新拉起`
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
    // If we started mid-line, drop the partial line at the front.
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
 *  tool_use / tool_result blocks, system injections, empty messages) so
 *  the caller can walk further back to find a real user/assistant
 *  utterance. Joey 2026-05-24: `↳ user: [tool_result]` is noise — the
 *  excerpt only counts if it's something a human said or claude said
 *  to the human. */
function extractMessageExcerpt(rec: any): { role: 'user' | 'asst'; text: string } | null {
  const role = rec?.role ?? rec?.message?.role
  if (role !== 'user' && role !== 'assistant') return null
  const content = rec?.content ?? rec?.message?.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    // Only concat real text blocks; ignore tool_use/tool_result so a
    // tool-only turn returns no text → caller skips it.
    for (const c of content) {
      if (typeof c === 'string') { text += c + ' ' }
      else if (c?.type === 'text' && typeof c.text === 'string') { text += c.text + ' ' }
    }
  }
  text = text.trim()
  if (!text) return null
  // Strip <channel ...>...</channel> framing for readability
  const m = text.match(/^<channel\b[^>]*>([\s\S]*?)<\/channel>\s*$/)
  if (m) text = m[1].trim()
  // Skip pure system/hook injections and other framework wrappers that
  // aren't real conversation
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
    // Tail: last 2 *user* messages so caller can see WHERE each
    // session left off. User messages disambiguate better than
    // assistant messages: user questions are short and specific
    // ("在嗎", "處理好了沒"), while assistant replies tend to be long
    // and generic. Joey 2026-05-24: 「資訊還是不夠多，看到的還是很多
    // 廢話 — 要多抓兩則我最後問的問題才行」.
    //
    // Read 200 records / 1MB window because a single assistant turn
    // on a channel-bot session can emit dozens of large tool_use /
    // tool_result records (Bash with big stdout, file reads, etc.)
    // making the per-user-message footprint multi-hundred-KB.
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

/** "Current" session: the .jsonl most recently modified. */
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
 *   session (you can't resume to yourself). So:
 *     listClaudeSessions array idx N (for N ≥ 1) = picker idx (N - 1)
 *   Caller is responsible for the -1 conversion before calling this.
 *   Joey 2026-05-24: 「/resume 功能是錯亂的欸，明明看好了結果起的卻是
 *   另一個」 — root cause was caller passing array idx instead of picker
 *   idx, so every /resume was off-by-one (got the session below the
 *   intended one). Empirically verified by capturing claude-research's
 *   picker pane: 6 entries in picker vs 7 in listClaudeSessions (delta
 *   = current session, excluded).
 *
 * Same-pid inline-switch verified 2026-05-22 in claude-tui-test env
 * (pid 31042 → 31042 across switch). Daemon's MCP transport remains
 * connected; in-flight messages don't drop.
 */
export async function resumePickerInlineSwitch(pickerIdx: number, tmuxOverride?: string): Promise<void> {
  const tmuxName = tmuxOverride ?? TMUX_SESSION

  // Proactive cleanup instead of fragile pane-text busy-detection.
  // Joey 2026-05-25 (msg 1572): "他們會常常改字吧？為何不就把它打斷就好了？"
  // — busy-detection by regex on claude TUI output broke when claude
  // changed its completion-marker format (`✻ Crunched for X` was past-tense
  // history but my regex treated it as active). Cleaner approach: when the
  // user clicks a /resume button they explicitly want to switch — interrupt
  // whatever's in progress and drive the picker. Any mid-turn response is
  // acceptable collateral; user can re-ask after switch.
  //
  // Sequence: Escape (dismiss any open dialog/picker) → wait → Ctrl-C
  // (interrupt any active turn) → wait → drive picker.
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
  const RESUME_CHAIN_FILE_TARGET = fileOverride ?? RESUME_CHAIN_FILE
  _saveResumeChainInternal(chain, RESUME_CHAIN_FILE_TARGET)
}

function _saveResumeChainInternal(chain: ResumeChain, file: string): void {
  try {
    writeFileSync(file, JSON.stringify(chain), { mode: 0o644 })
  } catch {}
}

/**
 * Render a resume confirmation reply that shows enough context for Joey
 * to recognize WHICH session he just switched to: id prefix, when it
 * started (first user msg), and where it left off (last ~3 messages).
 *
 * Without `lastMessages`, the original reply only showed an 8-char id
 * prefix + first msg — useless for picking up an old conversation
 * mid-stream. Joey called this out 2026-05-24.
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

// ---- #3: login-expired pane watchdog (2026-07-10) --------------------------
//
// When the TUI's OAuth credential dies, the agent goes silent on TG with no
// signal (the jsonl/OTLP system-alert layers only fire if an API call is
// attempted AND logged). This watchdog looks at the SOURCE of truth the human
// would see — the tmux pane — for login-expiry wording, and DMs an alert with
// the recovery path. Debounced per-pane: one alert per expiry EPISODE (marker
// appearing after being absent); a persisting marker never re-fires, and the
// state re-arms when the pane goes clean again (post-/login).

export type WatchTarget = { label: string; tmux: string }

/** Pane wordings that indicate the TUI lost its login/credential. Keep the
 *  generic entries LAST — the match hit is reported in the alert.
 *
 *  Kept deliberately BROAD (bare phrases) so an upstream rewording of the
 *  banner can't blind us to a real login death (Joey 5387). The pane renders
 *  the CONVERSATION though, so these phrases also appear as quoted prose when
 *  an agent documents/debugs a login incident (2026-07-21 false alert, Joey
 *  5384) — that's handled by probeAuthDead(): a marker hit is only ALERTED
 *  after a live API probe of the machine's credential chain confirms (or
 *  cannot rule out) that auth is really broken. */
const LOGIN_EXPIRED_PANE_MARKERS: readonly RegExp[] = [
  /Please run \/login/i,
  /OAuth token (has )?(expired|revoked)/i,
  /Login expired/i,
  /Invalid API key/i,
  /authentication[_ ]error/i,
]

/**
 * Ground-truth auth check (2026-07-21, Joey 5387: don't anchor on banner
 * wording — verify). Resolves the credential the TUI would actually use,
 * mirroring claude's own precedence: the shared Keychain account grant
 * (claudeAiOauth.accessToken) is read BEFORE the settings.json env
 * setup-token — exactly the shadow that killed atlas/hephaestus. Probes
 * /v1/messages with 1 token:
 *   'dead'       → HTTP 401/403 on the top-precedence credential
 *   'alive'      → any non-auth response (200/400/429/…) — auth works
 *   'unverified' → no credential found / network error — CANNOT rule out a
 *                  real death, caller must still alert (fail toward alerting)
 */
async function probeAuthDead(): Promise<'dead' | 'alive' | 'unverified'> {
  let token = ''
  try {
    const kc = await runCommand(['security', 'find-generic-password', '-w', '-s', 'Claude Code-credentials'])
    if (kc.exitCode === 0) {
      const cred = JSON.parse(kc.stdout.trim())
      token = cred?.claudeAiOauth?.accessToken ?? ''
    }
  } catch { /* no keychain grant / unreadable — fall through to env token */ }
  if (!token) {
    try {
      const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
      token = settings?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? ''
    } catch { /* no settings */ }
  }
  if (!token) return 'unverified'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    clearTimeout(timer)
    if (r.status === 401 || r.status === 403) return 'dead'
    return 'alive'
  } catch {
    return 'unverified'
  }
}

const LOGIN_WATCH_POLL_MS = 20_000

/**
 * Start the watchdog. `listTargets` is called each tick so dynamic targets
 * (roamer's current_target) are re-resolved live. server.ts wires notify to
 * a DM-all-allowFrom sender.
 */
export function startLoginExpiredWatchdog(opts: {
  listTargets: () => Promise<WatchTarget[]>
  notify: (msg: string) => void
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}): void {
  const alerted = new Map<string, boolean>()  // tmux → alert already sent for the CURRENT expiry episode
  const tick = async (): Promise<void> => {
    let targets: WatchTarget[] = []
    try { targets = await opts.listTargets() } catch { return }
    for (const t of targets) {
      const pane = await tmuxCapturePane(t.tmux)
      if (!pane) continue  // capture failed (session gone / tmux hiccup) — keep episode state as-is
      const hit = LOGIN_EXPIRED_PANE_MARKERS.find(re => re.test(pane))
      if (hit) {
        if (!alerted.get(t.tmux)) {
          // Episode is marked handled either way — a suppressed false positive
          // must not re-probe every 20s while the quoted text stays on screen.
          // Re-arms when the pane goes clean, same as the alert path.
          alerted.set(t.tmux, true)
          const verdict = await probeAuthDead()
          if (verdict === 'alive') {
            opts.log('info',
              `login-expired marker in pane ${t.tmux} (${String(hit)}) but API probe says auth ALIVE — ` +
              `suppressed as conversation-text false positive`)
            continue
          }
          const proof = verdict === 'dead'
            ? '已用 API 實測確認：憑證真的失效（401/403）'
            : 'API 驗證無法完成（無憑證可測或網路錯誤），保守通知'
          opts.log('warn', `login-expired marker in pane ${t.tmux}: ${String(hit)} — probe=${verdict}`)
          opts.notify(
            `🔐 登入疑似過期 — ${t.label}（tmux ${t.tmux}）畫面出現登入失效訊息（匹配 ${String(hit)}；${proof}）。\n` +
            `處理：在 TUI 跑 /login 重新登入（可從這裡用 \`/input /login\` 送），完成後可 /restart 重啟。\n` +
            `（同一狀態不重複提醒；畫面恢復後若再過期會再通知）`,
          )
        }
      } else if (alerted.get(t.tmux)) {
        alerted.set(t.tmux, false)  // episode over — re-arm
        opts.log('info', `login-expired marker cleared in pane ${t.tmux}`)
      }
    }
  }
  setInterval(() => { void tick() }, LOGIN_WATCH_POLL_MS).unref()
  opts.log('info', `login-expired pane watchdog ON (poll=${LOGIN_WATCH_POLL_MS / 1000}s)`)
}

// ---- daemon health (for /status) -----------------------------------------

/**
 * #8 (2026-07-10): exported so server.ts's `bot.command('status')` (grammy
 * command middleware runs BEFORE message:text, so /status NEVER reached
 * handleControlSlash's /status branch) can merge the daemon/TUI health block
 * into the paired-user reply in control mode.
 */
export async function controlStatusText(httpPort: string): Promise<string> {
  return daemonStatus(httpPort)
}

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
 * Inline-keyboard button spec for Telegram (TG) and Discord (DC).
 * - text: visible label (TG ≤ 64 chars, DC ≤ 80)
 * - callback_data: opaque payload sent back when user taps (TG ≤ 64 bytes,
 *   DC custom_id ≤ 100 chars). Format we use: `resume:<8-char-uuid-prefix>`.
 */
export type InlineButton = { text: string; callback_data: string }

export type ReplyOptions = {
  /**
   * Inline keyboard. Outer array = rows (TG max 100 rows; DC max 5 rows of 5).
   * Inner array = buttons in that row. server.ts callers translate to the
   * platform-native shape (Telegram reply_markup.inline_keyboard or Discord
   * components ACTION_ROW).
   */
  keyboard?: InlineButton[][]
}

/**
 * Try to handle `text` as a channel-bot control slash command.
 * Returns true if it was handled (caller should NOT forward to claude),
 * false if not (caller continues with normal claude forward).
 *
 * `replyToTg` signature: (msg, opts?) where opts.keyboard is the inline
 * keyboard. Caller is responsible for rendering it via Telegram/Discord
 * native APIs. Pass undefined/omit opts for plain text replies.
 */
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
  // This block handles /clear /agents /mcp /resume /help /init /compact /model /effort /sigint /cancel
  // for BOTH channel-bot mode (here, with TMUX_SESSION) and roamer mode (which
  // calls forwardSharedTuiSlash directly with its current_target tmux).
  if (await forwardSharedTuiSlash(text, TMUX_SESSION, replyToTg)) {
    return true
  }

  // ---- Phase 2: system-level control ------------------------------------
  if (cmd === '/restart') {
    await tryRun('restart claude TUI', async () => {
      const how = await restartClaudeTUI()
      await replyToTg(`🔁 restarting — tmux session 已砍，${how}。TUI 回線約 30–60s（監控 tick + 啟動等待）。`)
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
        // 2 most recent user questions — disambiguates session even
        // when first-user-msg ("在嗎") is identical across sessions.
        for (const m of s.lastMessages) lines.push(`   ↳ ${m}`)
      }
    })
    lines.push(
      '',
      '👇 Tap a button to resume that session (UUID passed directly, no off-by-one risk).',
      'Or use `/resume <number>`, `/resume <session-id>`, `/resume_previous`.',
    )
    // Inline keyboard: one button per session, labeled with #N + brief.
    // callback_data = `resume:<8-char-uuid-prefix>` (reused by handleCallbackData).
    // TG callback_data max 64 bytes; "resume:" + 8-char prefix = 15 bytes — fits.
    const keyboard: InlineButton[][] = sessions.map((s, i) => {
      const mark = s.id === cur ? '📍' : '↩️'
      const title = (s.firstUserMessage ?? '(no preview)').slice(0, 40)
      const date = new Date(s.mtimeMs).toISOString().slice(5, 16).replace('T', ' ')
      return [{
        text: `${mark} #${i + 1} ${date} ${title}`,
        callback_data: `resume:${s.id.slice(0, 8)}`,
      }]
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
    //   - so the remaining chain.length-1 prior visits occupy picker
    //     indices 0..chain.length-2
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
    // Numeric ONLY for short args (list caps at 50 → ≤2 digits). An 8-char
    // UUID prefix can be all digits (e.g. `11571718-…`) — resume: button taps
    // send exactly that, and parsing it as a list number broke every tap on
    // such sessions with "number out of range" (Joey 2026-07-21, msg 5365).
    if (/^\d+$/.test(args) && args.length <= 2) {
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
      // picker idx (N - 1). targetIdx ≥ 1 guaranteed by the
      // "already the current session" early-return above.
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

/**
 * Handle a Telegram callback_query / Discord interaction.
 * `data` is the `callback_data` (TG) or `custom_id` (DC) set by the button
 * we emitted in /resume_list. Currently supported format:
 *   `resume:<8-char-uuid-prefix>` — resume that session (UUID prefix passed
 *   straight through; bypasses entire list-idx → picker-idx mapping that
 *   caused the 1.2.5 off-by-one bug).
 *
 * Returns true if data was understood + dispatched, false otherwise.
 */
export async function handleCallbackData(
  data: string,
  httpPort: string,
  replyToTg: (msg: string, opts?: ReplyOptions) => Promise<void>,
): Promise<boolean> {
  // `model:<value>` — emitted by the bare-`/model` inline keyboard. Reuse the
  // `/model <value>` slash path (send-keys + auto-confirm) so logic isn't forked.
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
  // `effort:<value>` — emitted by the bare-`/effort` inline keyboard. Strict
  // whitelist (5 known levels) — forged callback payloads never reach tmux.
  if (data.startsWith('effort:')) {
    const value = data.slice('effort:'.length).trim()
    if (!EFFORT_VALUE_RE.test(value)) {
      await replyToTg(`❌ invalid effort value in callback: \`${value.slice(0, 30)}\``)
      return true
    }
    return handleControlSlash(`/effort ${value}`, httpPort, replyToTg)
  }
  if (!data.startsWith('resume:')) return false
  const uuidPrefix = data.slice('resume:'.length).trim()
  if (!uuidPrefix) {
    await replyToTg('❌ empty UUID prefix in callback data')
    return true
  }
  // Reuse the `/resume <uuid>` path so we don't fork resume logic.
  return handleControlSlash(`/resume ${uuidPrefix}`, httpPort, replyToTg)
}

// ---- For the bot menu (Telegram setMyCommands) ---------------------------

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
