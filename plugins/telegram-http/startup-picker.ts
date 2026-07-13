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
  return null
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
}

/**
 * Start the interceptor. Mirrors startLoginExpiredWatchdog: poll each target's
 * pane; when a startup picker appears (and wasn't already surfaced for this
 * episode), call `surface` with the title + one button per real option label.
 * Debounce clears when the picker leaves the pane (answered or dismissed).
 */
export function startStartupPickerWatchdog(opts: {
  listTargets: () => Promise<PickerTarget[]>
  surface: (spec: SurfaceSpec) => void
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  pollMs?: number
}): void {
  const surfaced = new Map<string, boolean>() // tmux → already surfaced this episode
  const pollMs = opts.pollMs ?? 8_000
  const tick = async (): Promise<void> => {
    let targets: PickerTarget[] = []
    try { targets = await opts.listTargets() } catch { return }
    for (const t of targets) {
      const { stdout: pane } = await runCommand(['tmux', 'capture-pane', '-t', t.tmux, '-p'])
      if (!pane) continue
      const picker = detectStartupPicker(pane)
      if (picker) {
        if (!surfaced.get(t.tmux)) {
          surfaced.set(t.tmux, true)
          opts.log('warn', `startup picker '${picker.key}' on pane ${t.tmux} (${picker.options.length} options) — surfacing to TG`)
          opts.surface({
            title: `${picker.title}\n（${t.label}）點下面選項，我幫你選：`,
            buttons: picker.options.map((label, i) => ({
              text: `${i + 1}. ${label}`,
              callback_data: pickerCallback(t.tmux, picker.key, i),
            })),
          })
        }
      } else if (surfaced.get(t.tmux)) {
        surfaced.set(t.tmux, false) // episode over — re-arm
        opts.log('info', `startup picker cleared on pane ${t.tmux}`)
      }
    }
  }
  setInterval(() => { void tick() }, pollMs).unref()
  opts.log('info', `startup-picker interceptor ON (poll=${pollMs / 1000}s)`)
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
  await reply(
    res === 'ok' ? `✅ 已選好，claude 繼續了（${target.label}）`
    : res === 'gone' ? `⚠️ 剛要選時選單已消失（可能同時在別處被選掉）— 沒有動作`
    : `⚠️ 送出選擇了但選單還在（${target.label}）— 可能要再點一次或看一下畫面`,
  )
  return true
}
