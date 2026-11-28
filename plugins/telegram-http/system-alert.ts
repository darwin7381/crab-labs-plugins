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
import { isWallRecordLine, wallCovers, type WallState } from './usage-wall.ts'

type Notify = (text: string) => void
type Log = (level: 'info' | 'warn' | 'error', msg: string) => void

const POLL_MS = 20_000
const DEDUPE_WINDOW_MS = 10 * 60_000
const MAX_ALERT_CHARS = 500
// WO-120: the usage-wall state (usage-wall.ts) owns usage walls: one alert at enter, one at clear (WallAlerts), and no
// API-error text forwarded one by one while walled. _wall() null (no fresh state) = everything as before.
const WALL_TICK_MS = 5_000
const WALL_DEFER_MS = 60_000   // a wall record the state hasn't picked up within this long is forwarded as before
let _wall: () => WallState | null = () => null
let _keeperAlive: () => boolean = () => false   // WO-120: the usage-wall keeper is running here

/** WO-120: what the jsonl tail does with an alert while the usage-wall state is fresh. 'send' = as before; 'drop' =
 *  the wall's own two alerts cover it; 'defer' = a wall record the state hasn't shown as walled yet: wait for it. */
export function wallRoute(line: string, alert: string, w: WallState | null, keeperAlive = false): 'send' | 'drop' | 'defer' {
  if (alert.includes('Please run /login')) return 'send'
  // no state yet: an agent's first wall can be read here before its state file exists; with the keeper running the
  // state follows within seconds, so wait for it (else two ⚠️ at enter). Reading off / no keeper → as before.
  if (!w) return keeperAlive && isWallRecordLine(line) ? 'defer' : 'send'
  const apiError = line.includes('"isApiErrorMessage":true') || line.includes('"subtype":"api_error"') || /^API Error/i.test(alert)
  if (!apiError) return 'send'
  if (w.walled) return 'drop'
  return isWallRecordLine(line) ? 'defer' : 'send'
}

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

// 002l (D12): design/notify 「同一件事不會連發」. With lanes on, the daemon tells Joey about a model wall itself, once, naming the session that hit it
// (lanes.ts mainWallUp / wallUp). The TUI relay of the same usage-limit line was a third notice for one wall (G07: #1053 relay, #1055 main wall,
// #1056 lanes wall). A relayed TUI line that the defer function claims is not sent (and logged); everything else is relayed as before.
type Defer = (msg: string, source: string) => boolean | 'duty-officer'
let _defer: Defer | null = null
export function setSystemAlertDefer(f: Defer | null): void { _defer = f }
/** the TUI-output layers (jsonl / OTLP) relay through here; ops alerts (sendOpsAlert) never defer */
export function relayTuiAlert(msg: string, source: string): void {
  if (_defer) {
    let skip: ReturnType<Defer> = false
    try { skip = _defer(msg, source) } catch {}
    if (skip === 'duty-officer') return
    if (skip) { _log('info', `system-alert deferred to the lanes wall notice: ${dedupeKey(msg).slice(0, 80)} (${source})`); return }
  }
  sendAlert(msg, source)
}

/**
 * Ops-alert entry point for OTHER modules (delivery watchdog etc.) — same
 * dedupe window and notify pipeline (opsRecipients: alertTo, else allowFrom) as
 * the TUI-warning forwarders.
 * Safe to call unconditionally: before startSystemAlertWatcher wires _notify
 * (SYSTEM_ALERT_FORWARD unset, or INBOX_ONLY daemons with no bot token) the
 * default notify is a no-op, so callers degrade to their own log line.
 * Added 2026-08-23 after two same-day incidents (originally conflated as one
 * "7h channel-bot blackout" — that number was RETRACTED the same day; the
 * provable channel-bot outage was ~1h, extended by the wrapper's flat
 * sleep 3600, and its only detector was the wrapper): the "delivery still
 * unconsumed" watchdog detected ATLAS's stuck session perfectly — and told
 * nobody (log-only). For the channel-bot the watchdog never even ran
 * (delivery-triggered, empty queue). Both shapes argued for the same fix:
 * detection without notification is not detection.
 */
export function sendOpsAlert(msg: string, source: string): void {
  sendAlert(msg, source)
}

// ---- PRIMARY layer: OTLP/HTTP JSON logs receiver ---------------------------

/** Events worth waking the user for. Other telemetry events are ignored. */
const OTLP_ALERT_EVENTS = new Set(['api_error', 'api_refusal', 'api_retries_exhausted'])

/**
 * Was the failed request issued by the agent's MAIN loop? Only those mean "the
 * TUI is dying at the API layer" — this forwarder's whole purpose. Documented
 * `query_source` values: "repl_main_thread" (TUI; may carry a suffix), "sdk"
 * (`claude -p`), "compact", or a sub-agent's name. A sub-agent's failed request
 * (e.g. a WebFetch of a blocked domain → 400 "domains are not accessible to our
 * user agent") reaches the main loop as a tool error and the session carries on,
 * so it is not boss-worthy (research 4639: 2 such pushes in a week, both from
 * sub-agents, both self-recovered). No query_source (older CLI) → treat as main,
 * i.e. keep alerting as before.
 */
export function isMainLoopQuery(querySource: string | undefined): boolean {
  if (!querySource) return true
  return querySource.startsWith('repl_main_thread') || querySource === 'sdk' || querySource === 'compact'
}

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
          // WO-120: inside a usage wall API errors are not forwarded one by one (the wall's enter/clear alerts are)
          if ((eventName === 'api_error' || eventName === 'api_retries_exhausted') && _wall()?.walled) {
            _log('info', `system-alert: not forwarded (${eventName} inside a usage wall): ${(attrs['error'] ?? '').slice(0, 160)}`)
            continue
          }
          // The server already retried this refusal on another model, so the
          // user never saw it (documented server_fallback_hop=true).
          if (eventName === 'api_refusal' && attrs['server_fallback_hop'] === 'true') continue
          if (!isMainLoopQuery(attrs['query_source'])) {
            _log('info', `system-alert: not forwarded (${eventName} from query_source=${attrs['query_source']}, not the main loop): ${(attrs['error'] ?? '').slice(0, 160)}`)
            continue
          }
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
          relayTuiAlert(parts.join('\n'), `otel:${eventName}`)
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
  /** 002l (D12): a relayed TUI line this returns true for is told by someone else (the lanes wall notice) and is not sent */
  defer?: Defer
  // Exact session-jsonl resolver — re-called EACH tick. Roamer returns its
  // current target's EXACT transcript (cwd + session_id → one file), so the
  // watcher tails precisely that session and NOT merely the newest jsonl in the
  // dir — a cwd can hold several sessions, and an idle roamer target loses the
  // newest-mtime race to a sibling, which would tail the wrong session. Moves
  // with /roam (returns null between targets). Omitted → static env dir +
  // newest-jsonl (channel-bot: one primary session per fixed dir). (issue #6)
  resolveFile?: () => string | null
  // WO-120: this daemon's usage-wall state (usage-wall.ts WallReader.state) and its enter/clear alerts (WallAlerts).
  wall?: () => WallState | null
  wallAlerts?: { tick(w: WallState | null, notify: Notify): unknown }
  keeperAlive?: () => boolean
}): void {
  _notify = opts.notify
  _log = opts.log
  if (opts.defer) _defer = opts.defer
  _wall = opts.wall ?? (() => null)
  _keeperAlive = opts.keeperAlive ?? (() => false)
  if (opts.wallAlerts) {
    const wa = opts.wallAlerts
    setInterval(() => { try { wa.tick(_wall(), _notify) } catch (err) { opts.log('warn', `usage wall alerts: ${err}`) } }, WALL_TICK_MS).unref()
  }
  const staticDir = process.env.SYSTEM_ALERT_PROJECTS_DIR || process.env.CHANNEL_BOT_PROJECTS_DIR || ''
  if (!staticDir && !opts.resolveFile) {
    opts.log('warn', 'system-alert: no SYSTEM_ALERT_PROJECTS_DIR / CHANNEL_BOT_PROJECTS_DIR and no dynamic resolver — jsonl fallback disabled (OTLP receiver still active)')
    return
  }
  const startedAt = Date.now()
  let watchedFile = ''
  let offset = 0
  let remainder = ''
  const deferred: Array<{ alert: string; src: string; ts: number; at: number }> = []   // WO-120

  const tick = () => {
    // WO-120: wall records held back for the state: dropped once it shows them covered, else forwarded as before
    for (let i = deferred.length - 1; i >= 0; i--) {
      const d = deferred[i]
      const w = _wall()
      if (w && wallCovers(w, d.ts)) { deferred.splice(i, 1); continue }
      if ((!w && !_keeperAlive()) || Date.now() - d.at >= WALL_DEFER_MS) { deferred.splice(i, 1); relayTuiAlert(d.alert, d.src) }
    }
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
        const src = `jsonl session ${watchedFile.split('/').pop()?.slice(0, 8) ?? '?'}…`
        // WO-120 first (a fresh usage-wall state owns the wall's alerts), then the lanes defer (relayTuiAlert; null with lanes off)
        const route = wallRoute(line, alert, _wall(), _keeperAlive())
        if (route === 'drop') { opts.log('info', `system-alert: not forwarded (inside a usage wall): ${alert.slice(0, 80)}`); continue }
        if (route === 'defer') { deferred.push({ alert, src, ts: ts ?? Date.now(), at: Date.now() }); continue }
        relayTuiAlert(alert, src)
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
