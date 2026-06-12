/**
 * System-alert forwarder — watches the newest claude session jsonl for
 * non-AI system warnings and forwards them to Telegram.
 *
 * Problem (Joey msg 2218, 2026-06-12; built after the 2026-06-11 trio of
 * silent-death modes): when the claude TUI dies at the API layer, the only
 * trace is text rendered in the tmux pane / records appended to the session
 * jsonl — none of it goes through MCP, so the Telegram side is a pure black
 * hole. Observed modes, all of which DO land in the session jsonl:
 *   1. login credential expiry  → system api_error records (401) + assistant
 *      text "Please run /login · API Error: 401 ..."
 *   2. turn killed mid-flight   → assistant text "API Error: Internal server error"
 *   3. refusal storm            → assistant records with stop_reason "refusal"
 *
 * Detection point: the session jsonl (pipeline-native — the same artifact
 * claude itself writes), NOT pane scraping (capture-pane is blank for
 * claude's alt-screen TUI, see memory project_capture_pane_blank_claude_tui).
 *
 * Opt-in via SYSTEM_ALERT_FORWARD=1. Watch dir defaults to
 * CHANNEL_BOT_PROJECTS_DIR; SYSTEM_ALERT_PROJECTS_DIR overrides (lab tests).
 *
 * Anti-spam: identical-ish alerts (request ids / uuids stripped) are
 * suppressed for a 10-minute window; the next alert after the window
 * reports how many were suppressed. A 401 storm thus produces one DM per
 * 10 min with a count, not one per failed message.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

type Notify = (text: string) => void
type Log = (level: 'info' | 'warn' | 'error', msg: string) => void

const POLL_MS = 20_000
const DEDUPE_WINDOW_MS = 10 * 60_000
const MAX_ALERT_CHARS = 500

export function isSystemAlertEnabled(): boolean {
  return process.env.SYSTEM_ALERT_FORWARD === '1'
}

/** Strip volatile fragments so retries of the same error dedupe together. */
function dedupeKey(msg: string): string {
  return msg
    .replace(/req_[A-Za-z0-9]+/g, 'req_*')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, 'uuid')
    .replace(/\d+/g, 'N')
    .slice(0, 160)
}

/** Parse one jsonl line; return human-readable alert text or null. */
export function extractSystemAlert(line: string): string | null {
  if (!line.startsWith('{')) return null
  // Cheap pre-filter — most lines never get JSON.parsed.
  const hasApiErr = line.includes('"subtype":"api_error"')
  const hasLogin = line.includes('Please run /login')
  const hasRefusal = line.includes('"stop_reason":"refusal"')
  const hasApiErrText = line.includes('API Error') // assistant-text form, e.g. "API Error: Internal server error"
  if (!hasApiErr && !hasLogin && !hasRefusal && !hasApiErrText) return null
  try {
    const j: any = JSON.parse(line)
    if (j?.type === 'system' && j?.subtype === 'api_error') {
      const m = j?.error?.message ?? JSON.stringify(j?.error ?? {})
      return `API error: ${String(m)}`
    }
    if (j?.type === 'assistant') {
      const content = j?.message?.content
      let text = ''
      if (Array.isArray(content)) {
        for (const c of content) if (c?.type === 'text' && typeof c.text === 'string') text += c.text + ' '
      }
      text = text.trim()
      if (j?.message?.stop_reason === 'refusal') {
        return `Refusal (Usage Policy): ${text || '(no text)'}`
      }
      if (text.startsWith('API Error') || text.includes('Please run /login')) return text
    }
    return null
  } catch {
    return null
  }
}

/** Record timestamp (ms) from a jsonl line, or null. */
function lineTimestampMs(line: string): number | null {
  const i = line.indexOf('"timestamp":"')
  if (i < 0) return null
  const t = Date.parse(line.slice(i + 13, i + 37).split('"')[0])
  return Number.isNaN(t) ? null : t
}

export function startSystemAlertWatcher(opts: { notify: Notify; log: Log }): void {
  const dir = process.env.SYSTEM_ALERT_PROJECTS_DIR || process.env.CHANNEL_BOT_PROJECTS_DIR || ''
  if (!dir) {
    opts.log('warn', 'system-alert: no SYSTEM_ALERT_PROJECTS_DIR / CHANNEL_BOT_PROJECTS_DIR — watcher disabled')
    return
  }
  const startedAt = Date.now()
  let watchedFile = ''
  let offset = 0
  let remainder = ''
  const recent = new Map<string, { suppressed: number; lastSentAt: number }>()

  const newestJsonl = (): { path: string; size: number } | null => {
    try {
      let best: string | null = null
      let bestM = 0
      let bestSize = 0
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const full = join(dir, name)
        try {
          const st = statSync(full)
          if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = full; bestSize = st.size }
        } catch {}
      }
      return best ? { path: best, size: bestSize } : null
    } catch {
      return null
    }
  }

  const sendAlert = (msg: string, sessionFile: string) => {
    const key = dedupeKey(msg)
    const now = Date.now()
    const entry = recent.get(key)
    if (entry && now - entry.lastSentAt < DEDUPE_WINDOW_MS) {
      entry.suppressed++
      return
    }
    const suffix = entry?.suppressed
      ? `\n（同類警告過去 ${Math.round(DEDUPE_WINDOW_MS / 60000)} 分鐘內另發生 ${entry.suppressed} 次，已合併）`
      : ''
    recent.set(key, { suppressed: 0, lastSentAt: now })
    const sid = sessionFile.split('/').pop()?.slice(0, 8) ?? '?'
    opts.notify(`⚠️ 系統警告（claude TUI 自身輸出，非 AI 回覆）\n${msg.slice(0, MAX_ALERT_CHARS)}\n(session ${sid}…)${suffix}`)
    opts.log('info', `system-alert forwarded: ${key.slice(0, 80)}`)
  }

  const tick = () => {
    const cur = newestJsonl()
    if (!cur) return
    if (cur.path !== watchedFile) {
      watchedFile = cur.path
      remainder = ''
      // New (or first-seen) file: replay from byte 0 only if small — the
      // timestamp gate below stops historical noise; large files start at end.
      offset = cur.size < 256 * 1024 ? 0 : cur.size
      opts.log('info', `system-alert: watching ${watchedFile} from offset ${offset}`)
    }
    let size: number
    try { size = statSync(watchedFile).size } catch { return }
    if (size < offset) { offset = 0; remainder = '' } // truncated/rotated
    if (size === offset) return
    let fd: number | null = null
    try {
      fd = openSync(watchedFile, 'r')
      const len = Math.min(size - offset, 4 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, offset)
      offset += len
      const text = remainder + buf.toString('utf8')
      const lines = text.split('\n')
      remainder = lines.pop() ?? ''
      for (const line of lines) {
        const alert = extractSystemAlert(line)
        if (!alert) continue
        // Only forward records newer than watcher start (minus skew) —
        // prevents replaying yesterday's errors on daemon restart.
        const ts = lineTimestampMs(line)
        if (ts !== null && ts < startedAt - 120_000) continue
        sendAlert(alert, watchedFile)
      }
    } catch (err) {
      opts.log('warn', `system-alert: read failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch {} }
    }
  }

  setInterval(tick, POLL_MS).unref()
  opts.log('info', `system-alert forwarder ON (dir=${dir}, poll=${POLL_MS / 1000}s, dedupe=${DEDUPE_WINDOW_MS / 60000}min)`)
}
