// startup-picker.ts — intercept claude's STARTUP blocking pickers and surface
// them to Telegram as tap-to-choose inline buttons (Joey 2026-07-13).
//
// The problem: on machine restart or session reopen, a daemon-launched claude
// (channel-bot / roamer) can come up on an interactive picker it has no
// keyboard to answer — the large-session "Resume from summary / full / don't
// ask" menu is the recurring one. The TUI sits blocked, the MCP bridge never
// connects, and NOTHING reaches Telegram: the agent is silently deaf.
//
// The fix (Joey's design): the daemon already reads the pane, drives pickers,
// and holds the TG bridge — so intercept the picker, render its REAL option
// labels as inline buttons in the channel chat, and let a tap drive the
// keystroke into the stuck TUI. The 1/2/3 is internal; the user taps a label.
//
// Modeled 1:1 on startLoginExpiredWatchdog (channel-bot-control.ts): a per-tick
// pane poll over the same WatchTarget list, with a per-tmux debounce so one
// picker episode surfaces exactly once.
import { spawn } from 'node:child_process'
import { tmuxHash6 } from './channel-bot-control.ts'

// Local copy of the tiny tmux-runner (channel-bot-control keeps its own private
// one; not worth exporting from a file under active edit just for this).
function runCommand(argv: string[], timeoutMs = 8000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
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
    proc.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

export type PickerTarget = { label: string; tmux: string }

/** The text of a tmux pane now ('' when it cannot be read). */
export async function capturePane(tmux: string): Promise<string> {
  const { stdout } = await runCommand(['tmux', 'capture-pane', '-t', tmux, '-p'])
  return stdout
}

export interface DetectedPicker {
  key: string           // pattern id (for logs)
  title: string         // human title line shown above the buttons
  options: string[]     // real option labels, in display order (idx 0 = top)
}

// Pattern table. Each entry detects a startup blocking picker and parses its
// option labels straight from the pane, so we surface whatever claude shows
// rather than hardcoded text. Add trust/theme/etc. here as they're observed.
const PICKERS: ReadonlyArray<{
  key: string
  detect: RegExp
  title: (pane: string) => string
}> = [
  {
    key: 'resume-large-session',
    // "This session is 44d 6h old and 511.2k tokens." + the summary/full/never list
    detect: /This session is .+ old and .+ tokens\.[\s\S]*Resume from summary/i,
    title: (pane) => {
      const m = pane.match(/This session is .+ old and .+ tokens\./i)
      return m ? `🔀 claude 開機停在 session resume 選單\n${m[0]}` : '🔀 claude 開機停在 session resume 選單'
    },
  },
]

// A numbered option line: optional cursor (❯/>/●), "N.", then the label.
const OPTION_LINE = /^\s*[❯>●*]?\s*(\d+)\.\s+(.+?)\s*$/

// A LIVE cursor sitting on a numbered option — the strong signal that the TUI is
// parked at a selection (not just numbered prose). Only interactive pickers draw
// these glyphs immediately before an option.
// 002l (D11): design/notify 「同一件事不會連發」. ● ○ ◉ are NOT cursor glyphs: ● is the TUI's own bullet in front of every assistant
// message, so the main's numbered summary (● 1. …) read as a menu and was sent to Joey three times (G07, #1054/#1059/#1064). The cursor must
// also be on an option line near the bottom of the pane (a parked menu is the last thing drawn), with no input box below it.
const CURSOR_OPTION_LINE = /^\s*[❯›▶>]\s*(\d+)\.\s+\S/
const MENU_TAIL_LINES = 15
const RULE_LINE = /^\s*[╭╰│]?[─━═]{10,}/          // the input box's border / the prompt's horizontal rules
const EMPTY_PROMPT = /^\s*[│|]?\s*[>❯]\s*[│|]?\s*$/

/** 002l (D11): the generic menu, read from the bottom of the pane only: the cursor line among the last MENU_TAIL_LINES non-blank lines, nothing below it
 *  that is the input box (an empty prompt or a box border), and a clean 1..N option run around it. null = not a parked menu. */
function genericMenu(pane: string): string[] | null {
  const lines = pane.split('\n').filter(l => l.trim())
  const tail = lines.slice(-MENU_TAIL_LINES)
  let cur = -1
  for (let i = tail.length - 1; i >= 0; i--) if (CURSOR_OPTION_LINE.test(tail[i])) { cur = i; break }
  if (cur < 0) return null
  if (tail.slice(cur + 1).some(l => RULE_LINE.test(l) || EMPTY_PROMPT.test(l))) return null     // the input box is below: the TUI is at its prompt
  if (cur > 0 && RULE_LINE.test(tail[cur - 1])) return null                                     // the "cursor" is the prompt line itself
  const options = parseOptions(tail.join('\n'))
  const n = Number(tail[cur].match(CURSOR_OPTION_LINE)![1])
  return options.length >= 2 && n >= 1 && n <= options.length ? options : null
}

function paneHasPickerCursor(pane: string): boolean {
  return genericMenu(pane) != null
}

// lanes-golive: the two 002l (D11) rules above (the bottom-of-pane generic menu, and one send per menu per pane) are the lanes daemon's. server.ts turns
// them on with lanes on (useLanesMenuRules); off (every fleet daemon), the generic menu is the fleet's rule, unchanged since 4d7860e: a cursor glyph
// (❯ › ▶ ● ○ ◉ >) on a numbered option anywhere in the pane, and a menu that leaves and comes back is sent again.
let lanesMenuRules = false
export function useLanesMenuRules(on: boolean): void { lanesMenuRules = on }
const FLEET_CURSOR_OPTION_LINE = /^\s*[❯›▶●○◉>]\s*\d+\.\s+\S/m
function fleetGenericMenu(pane: string): string[] | null {
  if (!FLEET_CURSOR_OPTION_LINE.test(pane)) return null
  const options = parseOptions(pane)
  return options.length >= 2 ? options : null
}

// Best-effort human title: the non-empty line just above the first "1." option
// (usually the question/prompt), else a generic label.
function genericPickerTitle(pane: string): string {
  const lines = pane.split('\n')
  const firstOpt = lines.findIndex((l) => /^\s*[❯>●*]?\s*1\.\s+\S/.test(l))
  for (let i = firstOpt - 1; i >= 0 && i >= firstOpt - 4; i--) {
    const t = lines[i].replace(/[│╭╮╰╯─�< >]+/g, ' ').trim()
    if (t && !/^\s*[❯>●*]?\s*\d+\./.test(lines[i]) && t.length > 3) {
      return `🔀 claude 停在一個選單，請選擇：\n${t.slice(0, 200)}`
    }
  }
  return '🔀 claude 停在一個選單，請選擇：'
}

function parseOptions(pane: string): string[] {
  const opts: { n: number; label: string }[] = []
  for (const line of pane.split('\n')) {
    const m = line.match(OPTION_LINE)
    if (m) opts.push({ n: parseInt(m[1], 10), label: m[2].trim() })
  }
  // keep only a clean 1..N run from the first "1." (avoids catching numbered
  // prose elsewhere on the pane)
  opts.sort((a, b) => a.n - b.n)
  const run: string[] = []
  let expect = 1
  for (const o of opts) {
    if (o.n === expect) { run.push(o.label); expect++ }
    else if (o.n > expect) break
  }
  return run
}

/** Detect a startup blocking picker in the pane; return its title + real
 *  option labels, or null. */
export function detectStartupPicker(pane: string): DetectedPicker | null {
  for (const p of PICKERS) {
    if (!p.detect.test(pane)) continue
    const options = parseOptions(pane)
    if (options.length < 2) return null // picker matched but options unreadable — don't surface a broken menu
    return { key: p.key, title: p.title(pane), options }
  }
  // GENERIC fallback (Joey 2026-07-17: "難道只能遇到一個建立一個嗎"): claude ships
  // new startup/blocking menus constantly; we shouldn't need a hand-written detect
  // RegExp per menu. When a LIVE cursor sits on a clean 1..N numbered option run,
  // the TUI is parked at a selection — surface it. The key is a hash of the option
  // LABELS so a stale tap can only ever drive the SAME menu (driveStartupPicker
  // re-checks live.key === expectKey before sending a keystroke → wrong/changed
  // menu = 'gone', nothing sent). New menu shapes now relay automatically.
  const options = lanesMenuRules ? genericMenu(pane) : fleetGenericMenu(pane)   // 002l (D11), lanes only: the bottom of the pane only, cursor on an option, no input box below
  if (options) return { key: `generic-${hash6(options.join('|'))}`, title: genericPickerTitle(pane), options }
  return null
}

/** The one-line description of a picker for logs and notices: its key AND the real option labels (002k G16: only the count was logged, so a
 *  stuck limit menu left no record of what it offered). */
export function describePicker(picker: DetectedPicker, tmux: string): string {
  return `startup picker '${picker.key}' on pane ${tmux} (${picker.options.length} options: ${picker.options.map((l, i) => `${i + 1}. ${l}`).join(' | ')})`
}

export type DriveResult = 'ok' | 'gone' | 'stuck'

/**
 * Drive the picker: from the top-anchored cursor, Down × idx then Enter.
 * (Same deterministic navigation resumePickerInlineSwitch uses.)
 *
 * CRITICAL — re-verify the LIVE pane before sending ANY key (a tapped button
 * can be stale: the picker may have been answered elsewhere, timed out, or been
 * replaced by a different picker or the normal prompt). Sending Down/Enter into
 * a non-picker pane submits garbage into claude's input; into a *different*
 * picker it selects the wrong thing. So we require the SAME picker (matched by
 * `expectKey`) with the option index still in range, captured now, or we abort
 * without touching the pane. Returns:
 *   'gone'  — no matching picker on the pane now (nothing sent)
 *   'ok'    — drove it and the picker cleared
 *   'stuck' — drove it but the picker is still up
 */
export async function driveStartupPicker(tmux: string, idx: number, expectKey: string): Promise<DriveResult> {
  const { stdout: pane } = await runCommand(['tmux', 'capture-pane', '-t', tmux, '-p'])
  const live = detectStartupPicker(pane)
  if (!live || live.key !== expectKey || idx < 0 || idx >= live.options.length) return 'gone'

  for (let i = 0; i < idx; i++) {
    await runCommand(['tmux', 'send-keys', '-t', tmux, 'Down'])
    await new Promise((r) => setTimeout(r, 100))
  }
  await new Promise((r) => setTimeout(r, 150))
  await runCommand(['tmux', 'send-keys', '-t', tmux, 'Enter'])
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 400))
    const { stdout } = await runCommand(['tmux', 'capture-pane', '-t', tmux, '-p'])
    if (!detectStartupPicker(stdout)) return 'ok'
  }
  return 'stuck'
}

/** WO-197: a Claude Code permission dialog as the pane shows it (its first option Yes…, its last No…): the channel's permission prompt carries it */
export function permissionShaped(options: string[]): boolean {
  return options.length >= 2 && /^Yes\b/i.test(options[0] ?? '') && /^No\b/i.test(options[options.length - 1] ?? '')
}

// A 6-char stable hash of a string (djb2) — used for both the tmux-name pin and
// the picker-key pin embedded in callback_data.
function hash6(s: string): string {
  let h = 5381
  for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(8, '0').slice(0, 6)
}

// callback_data = spick:<tmuxHash6>:<keyHash6>:<idx0>  (≤ ~30 bytes). The tmux
// hash pins the tap to a specific target; the key hash pins it to the SAME
// picker that was surfaced, so a stale tap can't drive a different picker that
// happens to be up now.
export function pickerCallback(tmux: string, key: string, idx: number): string {
  return `spick:${tmuxHash6(tmux)}:${hash6(key)}:${idx}`
}

export interface SurfaceSpec {
  title: string
  buttons: { text: string; callback_data: string }[]
  /** WO-197: the menu itself (its pane, the pane's label, its key and option labels), for its Onsen Action */
  picker?: { tmux: string; label: string; key: string; title: string; options: string[] }
}

/**
 * Start the interceptor. Mirrors startLoginExpiredWatchdog: poll each target's
 * pane; when a startup picker appears (and wasn't already surfaced for this
 * episode), call `surface` with the title + one button per real option label.
 * Debounce clears when the picker leaves the pane (answered or dismissed).
 */
// tmux → already surfaced this episode. Module level (002k G16) so a program that knows a picker is STILL up can re-arm it
// (rearmStartupPicker): the next poll then surfaces it to Joey again, with a fresh debounce.
const surfaced = new Map<string, boolean>()
// 002l (D11): a generic menu (same labels = same key) is sent to Joey once per pane for the daemon's life; it coming and going on the pane (scrolling
// prose, a redraw) is not a new menu. Only a program that knows the menu is still up asks for it again (rearmStartupPicker).
const sentGeneric = new Map<string, Set<string>>()
const forced = new Set<string>()
export function rearmStartupPicker(tmux: string): void { surfaced.set(tmux, false); forced.add(tmux) }
// 002y (X-1): tmux → the key of a menu another owner holds (logged once, not each poll)
const deferred = new Map<string, string>()

export function startStartupPickerWatchdog(opts: {
  listTargets: () => Promise<PickerTarget[]>
  surface: (spec: SurfaceSpec) => void
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  pollMs?: number
  /** Panes someone else is handling now (the duty officer, WO-97): not looked at. */
  skip?: (tmux: string) => boolean
  /** tests: the pane reader */
  capture?: (tmux: string) => Promise<string>
  /** WO-197: every look at a pane (skipped ones too: they are captured for this), the menu on it now or null, when it was captured. A pane that could
   *  not be read is not reported. The daemon closes the Onsen Actions of what is no longer on the screen from these */
  observe?: (t: PickerTarget, picker: DetectedPicker | null, at: number) => void
  /** 002y (X-1, 002x T7-R): who else owns this menu now (a name), or null. With lanes on, the main's limit menu in its wall episode is the lanes
   *  main-wall mechanism's (lanes.ts mainMenuOwned): it chooses the option that waits or continues, or puts the menu in front of Joey by re-arming
   *  it (rearmStartupPicker). An owned menu is not sent from here unless its owner re-armed it, and it is not marked surfaced (once the owner lets
   *  go, it is a menu like any other). Unset (lanes off), or a call that throws: every menu is the watchdog's, as before. */
  owner?: (t: PickerTarget, picker: DetectedPicker) => string | null
  /** WO-197 (Chiron lab round 3A, 1.58.27: a prompt answered on the screen took 8–14 s to be closed in Onsen, two 8 s looks): the panes to look at
   *  every `fastMs` (2 s) as well, between the polls: those with an Onsen Action of this daemon still open (a prompt, a menu). None: the poll alone */
  hot?: () => Iterable<string>
  fastMs?: number
}): void {
  const pollMs = opts.pollMs ?? (Number(process.env.STARTUP_PICKER_POLL_MS) || 8_000)   // the env: tests only
  const fastMs = Math.min(pollMs, opts.fastMs ?? (Number(process.env.STARTUP_PICKER_FAST_MS) || 2_000))
  const capture = opts.capture ?? capturePane
  const tick = async (only?: Set<string>): Promise<void> => {
    let targets: PickerTarget[] = []
    try { targets = await opts.listTargets() } catch { return }
    if (only) targets = targets.filter(t => only.has(t.tmux))
    for (const t of targets) {
      const skipped = opts.skip?.(t.tmux) ?? false
      if (skipped && !opts.observe) continue
      const at = Date.now()
      const pane = await capture(t.tmux)
      if (!pane) continue
      const picker = detectStartupPicker(pane)
      try { opts.observe?.(t, picker, at) } catch (e) { opts.log('warn', `startup picker observer failed: ${e}`) }
      if (skipped) continue
      if (picker) {
        if (!surfaced.get(t.tmux)) {
          let by: string | null = null
          if (opts.owner && !forced.has(t.tmux)) { try { by = opts.owner(t, picker) } catch (e) { opts.log('warn', `startup picker owner check failed (${e}); the watchdog sends it`) } }
          if (by) {
            if (deferred.get(t.tmux) !== picker.key) { deferred.set(t.tmux, picker.key); opts.log('info', `${describePicker(picker, t.tmux)} — ${by} owns it now; not sent to TG from here`) }
            continue
          }
          deferred.delete(t.tmux)
          surfaced.set(t.tmux, true)
          const seen = sentGeneric.get(t.tmux) ?? new Set<string>()
          if (lanesMenuRules && picker.key.startsWith('generic-') && seen.has(picker.key) && !forced.has(t.tmux)) {
            opts.log('info', `${describePicker(picker, t.tmux)} — already sent to TG once on this pane; not sent again`)
            continue
          }
          forced.delete(t.tmux)
          if (picker.key.startsWith('generic-')) { seen.add(picker.key); if (seen.size > 200) seen.clear(); sentGeneric.set(t.tmux, seen) }
          opts.log('warn', `${describePicker(picker, t.tmux)} — surfacing to TG`)
          opts.surface({
            title: `${picker.title}\n（${t.label}）點下面選項，我幫你選：`,
            buttons: picker.options.map((label, i) => ({
              text: `${i + 1}. ${label}`,
              callback_data: pickerCallback(t.tmux, picker.key, i),
            })),
            picker: { tmux: t.tmux, label: t.label, key: picker.key, title: picker.title, options: picker.options },
          })
        }
      } else if (deferred.delete(t.tmux)) {
        opts.log('info', `startup picker cleared on pane ${t.tmux} (its owner dealt with it)`)
      } else if (surfaced.get(t.tmux)) {
        surfaced.set(t.tmux, false) // episode over — re-arm
        opts.log('info', `startup picker cleared on pane ${t.tmux}`)
      }
    }
  }
  if (!opts.hot) {
    setInterval(() => { void tick() }, pollMs).unref()
    opts.log('info', `startup-picker interceptor ON (poll=${pollMs / 1000}s)`)
    return
  }
  // WO-197: the poll every pollMs as before; between, every fastMs, only the hot panes (one look at a time: a slow capture never overlaps the next)
  let last = Date.now(), running = false
  setInterval(() => {
    if (running) return
    const now = Date.now()
    let only: Set<string> | undefined
    if (now - last >= pollMs - fastMs / 2) last = now
    else {
      try { only = new Set(opts.hot!()) } catch { only = new Set() }
      if (!only.size) return
    }
    running = true
    void tick(only).finally(() => { running = false })
  }, fastMs).unref()
  opts.log('info', `startup-picker interceptor ON (poll=${pollMs / 1000}s; ${fastMs / 1000}s for a pane with an open Onsen Action)`)
}

/**
 * Handle a `spick:<tmuxHash>:<keyHash>:<idx>` button tap. Resolves the target
 * tmux by hash against the live target list, then driveStartupPicker re-verifies
 * the SAME picker (keyHash) is still on the pane before sending any key — so a
 * stale tap (picker answered elsewhere / timed out / replaced) never drives the
 * wrong TUI state. Reports the outcome.
 */
export async function handleStartupPickerCallback(
  data: string,
  listTargets: () => Promise<PickerTarget[]>,
  reply: (msg: string) => Promise<void>,
  /** WO-197: the keys were sent (ok: the menu cleared; stuck: still up) for option idx of this menu on this pane: its Onsen Action follows */
  pressed?: (tmux: string, key: string, idx: number, res: DriveResult) => void,
): Promise<boolean> {
  if (!data.startsWith('spick:')) return false
  const [, tmuxHash, keyHash, idxRaw] = data.split(':')
  const idx = parseInt(idxRaw, 10)
  if (!tmuxHash || !keyHash || Number.isNaN(idx)) { await reply('❌ 選單 callback 格式錯誤'); return true }
  const targets = await listTargets().catch(() => [] as PickerTarget[])
  const target = targets.find((t) => tmuxHash6(t.tmux) === tmuxHash)
  if (!target) { await reply('⚠️ 這個選單的 session 已經不在了（可能已重啟或換過 target）— 選項失效'); return true }

  // Confirm the SAME picker is still on the pane (guards a stale tap driving a
  // different picker or the normal prompt).
  const { stdout: pane } = await runCommand(['tmux', 'capture-pane', '-t', target.tmux, '-p'])
  const live = detectStartupPicker(pane)
  if (!live || hash6(live.key) !== keyHash) {
    await reply(`⚠️ 這個選單已經不在了（可能已在別處選過、逾時、或畫面已變）— 沒有動作。看一下 ${target.label} 現在的畫面`)
    return true
  }

  const res = await driveStartupPicker(target.tmux, idx, live.key)
  if (res !== 'gone') { try { pressed?.(target.tmux, live.key, idx, res) } catch {} }
  await reply(
    res === 'ok' ? `✅ 已選好，claude 繼續了（${target.label}）`
    : res === 'gone' ? `⚠️ 剛要選時選單已消失（可能同時在別處被選掉）— 沒有動作`
    : `⚠️ 送出選擇了但選單還在（${target.label}）— 可能要再點一次或看一下畫面`,
  )
  return true
}
