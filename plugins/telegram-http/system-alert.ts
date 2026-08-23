/**
 * System-alert forwarder — surfaces claude TUI's non-AI system warnings
 * (API errors, login expiry, refusals) on Telegram.
 *
 * Problem (Joey msg 2218, 2026-06-12; built after the 2026-06-11 trio of
 * silent-death modes): when the claude TUI dies at the API layer, nothing
 * goes through MCP, so the Telegram side is a pure black hole.
 *
 * TWO detection layers sharing one dedupe/notify pipeline:
 *
 * 1. PRIMARY — OTLP logs receiver (structured, documented schema; Joey msg
 *    2221 "用正規的方式"). Claude Code's official telemetry emits
 *    `claude_code.api_error` / `api_refusal` / `api_retries_exhausted`
 *    events with structured attributes (error, status_code, model, attempt)
 *    — see code.claude.com/docs/en/monitoring-usage. The daemon accepts
 *    OTLP/HTTP JSON on POST /v1/logs; launch the TUI with:
 *      CLAUDE_CODE_ENABLE_TELEMETRY=1
 *      OTEL_LOGS_EXPORTER=otlp
 *      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
 *      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:<daemon port>/v1/logs
 *    No text matching — survives any wording change. ~5s latency
 *    (OTEL_LOGS_EXPORT_INTERVAL default).
 *
 * 2. FALLBACK — session-jsonl tail. Covers TUIs launched without the OTel
 *    env (not yet restarted onto new config). The `system/api_error` record
 *    and `stop_reason: refusal` field are structured; only the assistant-text
 *    match ("API Error*" / "Please run /login") is wording-sensitive, which
 *    is acceptable for a fallback layer.
 *
 * Opt-in via SYSTEM_ALERT_FORWARD=1. Watch dir defaults to
 * CHANNEL_BOT_PROJECTS_DIR; SYSTEM_ALERT_PROJECTS_DIR overrides (lab tests).
 *
 * Anti-spam: identical-ish alerts (request ids / uuids stripped) are
 * suppressed for a 10-minute window; the next alert after the window
 * reports how many were suppressed. Both layers share the dedupe map, so
 * an incident caught by OTLP and jsonl still sends once.
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
  // Claude's OWN human-readable API-error line (usage/rate-limit, credit
  // exhaustion, etc.) rides on assistant records flagged isApiErrorMessage.
  // e.g. "You've hit your weekly limit · resets Jun 9 at 6am (Asia/Taipei)".
  // Surface THAT verbatim — never the raw provider "rate limit" string, which
  // names the wrong problem (Joey 2026-07-10).
  const hasApiErrFlag = line.includes('"isApiErrorMessage":true')
  // Model fallback: Claude Code silently swaps the selected model for a stabler
  // one when the primary errors/overloads. Rides on an assistant record as a
  // content block {type:"fallback", from:{model}, to:{model}}. The user thinks
  // they're on model X but replies are actually coming from Y — surface it
  // (Joey 2026-07-11: "被 fallback 至少要通知我").
  const hasFallback = line.includes('"type":"fallback"')
  if (!hasApiErr && !hasLogin && !hasRefusal && !hasApiErrText && !hasApiErrFlag && !hasFallback) return null
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
        for (const c of content) {
          if (c?.type === 'text' && typeof c.text === 'string') text += c.text + ' '
          if (c?.type === 'fallback') {
            const from = c?.from?.model ?? '?'
            const to = c?.to?.model ?? '?'
            return `⚠️ 模型自動退回：${from} → ${to}（primary 報錯/過載，Claude Code 已切到備援模型；你以為在跑 ${from}，實際是 ${to}）`
          }
        }
      }
      text = text.trim()
      // Claude's own human-readable API-error message — forward exactly as the
      // TUI renders it (this is the usage-limit line the user actually sees).
      if (j?.isApiErrorMessage === true && text) return text
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

// ---- shared notify/dedupe pipeline (both layers feed this) ----------------

let _notify: Notify = () => {}
let _log: Log = () => {}
const recent = new Map<string, { suppressed: number; lastSentAt: number }>()

function sendAlert(msg: string, source: string): void {
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
  _notify(`⚠️ 系統警告（claude TUI 自身輸出，非 AI 回覆）\n${msg.slice(0, MAX_ALERT_CHARS)}\n(${source})${suffix}`)
  _log('info', `system-alert forwarded: ${key.slice(0, 80)}`)
}

/**
 * Ops-alert entry point for OTHER modules (delivery watchdog etc.) — same
 * dedupe window and allowFrom notify pipeline as the TUI-warning forwarders.
 * Safe to call unconditionally: before startSystemAlertWatcher wires _notify
 * (SYSTEM_ALERT_FORWARD unset, or INBOX_ONLY daemons with no bot token) the
 * default notify is a no-op, so callers degrade to their own log line.
 * Added 2026-08-23: the "delivery still unconsumed" watchdog had detected the
 * channel-bot's 7h Fable-quota blackout perfectly — and told nobody (log-only).
 */
export function sendOpsAlert(msg: string, source: string): void {
  sendAlert(msg, source)
}

// ---- PRIMARY layer: OTLP/HTTP JSON logs receiver ---------------------------

/** Events worth waking the user for. Other telemetry events are ignored. */
const OTLP_ALERT_EVENTS = new Set(['api_error', 'api_refusal', 'api_retries_exhausted'])

/** Flatten an OTLP attribute list ([{key, value:{stringValue|intValue|...}}]) to a map. */
function otlpAttrs(list: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(list)) return out
  for (const kv of list) {
    const key = (kv as any)?.key
    const v = (kv as any)?.value
    if (typeof key !== 'string' || !v || typeof v !== 'object') continue
    const val = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue
    if (val !== undefined && val !== null) out[key] = String(val)
  }
  return out
}

/**
 * Handle an OTLP/HTTP JSON logs export payload (POST /v1/logs body).
 * Returns the number of alert-worthy events found. Never throws.
 *
 * Event identity comes from the structured `event.name` attribute (falling
 * back to the record body string `claude_code.<event>`), per the documented
 * schema — NO free-text matching.
 */
export function handleOtlpLogs(payload: unknown): number {
  let found = 0
  try {
    const resourceLogs = (payload as any)?.resourceLogs
    if (!Array.isArray(resourceLogs)) return 0
    for (const rl of resourceLogs) {
      for (const sl of rl?.scopeLogs ?? []) {
        for (const rec of sl?.logRecords ?? []) {
          const attrs = otlpAttrs(rec?.attributes)
          const bodyStr = typeof rec?.body?.stringValue === 'string' ? rec.body.stringValue : ''
          const eventName = (attrs['event.name'] ?? bodyStr.replace(/^claude_code\./, '')).trim()
          if (!OTLP_ALERT_EVENTS.has(eventName)) continue
          // 429 = usage/rate limit. Claude's TUI writes its OWN human-readable
          // line ("You've hit your weekly limit · resets …") as an assistant
          // isApiErrorMessage record, which the jsonl-tail layer forwards.
          // Suppress the raw provider "exceed your account's rate limit"
          // string here — it names the wrong problem (Joey 2026-07-10).
          if (eventName === 'api_error' && attrs['status_code'] === '429') continue
          found++
          const parts: string[] = []
          if (eventName === 'api_error') {
            parts.push(`API error${attrs['status_code'] ? ` (HTTP ${attrs['status_code']})` : ''}: ${attrs['error'] ?? '(no message)'}`)
            if (attrs['status_code'] === '401') parts.push('→ 登入憑證失效，需要在 TUI 跑 /login')
            if (attrs['attempt'] && attrs['attempt'] !== '1') parts.push(`(重試 ${attrs['attempt']} 次後放棄)`)
          } else if (eventName === 'api_refusal') {
            parts.push('API refusal (Usage Policy) — 模型拒絕回應這個請求')
          } else {
            parts.push('API retries exhausted — 該請求重試耗盡後失敗')
          }
          if (attrs['model']) parts.push(`model=${attrs['model']}`)
          sendAlert(parts.join('\n'), `otel:${eventName}`)
        }
      }
    }
  } catch (err) {
    _log('warn', `system-alert: otlp parse failed: ${err instanceof Error ? err.message : err}`)
  }
  return found
}

// ---- FALLBACK layer: session-jsonl tail ------------------------------------

/** Newest `.jsonl` by mtime in `dir` (channel-bot: one primary session per
 *  fixed dir, so newest == the one to tail). */
export function newestJsonl(dir: string): { path: string; size: number } | null {
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

/**
 * Decide which jsonl the watcher tails this tick (issue #6).
 * - Roamer (`resolveFile` present): its current target's EXACT transcript —
 *   NOT the newest-in-dir. A cwd can hold several sessions; if the target is
 *   idle a newer sibling would win the mtime race and we'd tail the wrong
 *   session, missing the target's API/login alerts. null between /roam targets;
 *   a 0-turn target whose jsonl doesn't exist yet is skipped (statSync throws).
 * - Channel-bot (no `resolveFile`): newest jsonl in the static dir.
 * Exported for tests.
 */
export function resolveWatchFile(
  resolveFile: (() => string | null) | undefined,
  staticDir: string,
): { path: string; size: number } | null {
  if (resolveFile) {
    const f = resolveFile()
    if (!f) return null
    try { return { path: f, size: statSync(f).size } } catch { return null }
  }
  return newestJsonl(staticDir)
}

export function startSystemAlertWatcher(opts: {
  notify: Notify
  log: Log
  // Exact session-jsonl resolver — re-called EACH tick. Roamer returns its
  // current target's EXACT transcript (cwd + session_id → one file), so the
  // watcher tails precisely that session and NOT merely the newest jsonl in the
  // dir — a cwd can hold several sessions, and an idle roamer target loses the
  // newest-mtime race to a sibling, which would tail the wrong session. Moves
  // with /roam (returns null between targets). Omitted → static env dir +
  // newest-jsonl (channel-bot: one primary session per fixed dir). (issue #6)
  resolveFile?: () => string | null
}): void {
  _notify = opts.notify
  _log = opts.log
  const staticDir = process.env.SYSTEM_ALERT_PROJECTS_DIR || process.env.CHANNEL_BOT_PROJECTS_DIR || ''
  if (!staticDir && !opts.resolveFile) {
    opts.log('warn', 'system-alert: no SYSTEM_ALERT_PROJECTS_DIR / CHANNEL_BOT_PROJECTS_DIR and no dynamic resolver — jsonl fallback disabled (OTLP receiver still active)')
    return
  }
  const startedAt = Date.now()
  let watchedFile = ''
  let offset = 0
  let remainder = ''

  const tick = () => {
    const cur = resolveWatchFile(opts.resolveFile, staticDir)
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
        sendAlert(alert, `jsonl session ${watchedFile.split('/').pop()?.slice(0, 8) ?? '?'}…`)
      }
    } catch (err) {
      opts.log('warn', `system-alert: read failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch {} }
    }
  }

  setInterval(tick, POLL_MS).unref()
  opts.log('info', `system-alert forwarder ON (otlp=/v1/logs primary; jsonl fallback=${opts.resolveFile ? '(dynamic: roamer current target transcript)' : staticDir}, poll=${POLL_MS / 1000}s, dedupe=${DEDUPE_WINDOW_MS / 60000}min)`)
}
