// keepwarm-local.ts — 保溫 and 讀信箱 reminders from the agent's own agent-inbox daemon, for agents the Mac mini
// delivery watchdog cannot see: the MBP's daddy-claude and txmonster's monster-steropes (Joey TG chiron:1483:
// 「全面動起來，為何…有兩台機器沒上」; Chiron btcc 9639). The daemon is already on that machine: it reads its own
// agent's transcript, asks BTCC for its own unread count with its own credential, and hands the line to its
// own session. No other machine is involved.
//
// The rules are the Mac mini watchdog's (~/cc-workspaces/claude-epeius/monitors/delivery-watchdog/keepwarm.py,
// spec rescue-site inbox-tiers.html #warm / #ring), ported function for function so both behave the same:
//   keep-warm: poke at 50 min idle (from the last main-thread api-request), not while a turn runs, not when
//              already cold (≥ 60 min, compacted, usage wall, 5-minute cache), not 24 h after the last real work,
//              stop after a poke that came back cold, once per idle stretch.
//   mailbox:   idle ≥ 50 min with unread mail → one 讀信箱 line (again after an hour if it produced no turn);
//              busy with mail waiting ≥ 1 h → one line an hour; held while Joey spoke within the hour.
//   The line comes from user "fleet-watchdog", the same sender the Mac mini watchdog uses, so both scans tell a
//   poke from real work the same way.
//
// Switch: KEEPWARM_LOCAL = live | dry | off (machine config ~/.config/crab-labs-plugins/env; default off). The
// Mac mini never sets it: its agents stay with the central watchdog, so no agent is poked twice.
// KEEPWARM_PROJECTS_DIR: the session's ~/.claude/projects/<dir> when the daemon's own default is wrong (the
// MBP's inbox daemon keeps its state in ~/.claude, not in daddy-claude's workspace).
// State and log: <state dir>/keepwarm-local.json, keepwarm-local.log.

import { appendFileSync, closeSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const KEEPWARM_AFTER_S = 50 * 60
export const CACHE_TTL_S = 60 * 60
export const STOP_AFTER_S = 24 * 3600
export const TAIL_BYTES = 4_000_000
export const MAIL_BUSY_AFTER_S = 3600
export const MAIL_RESEND_S = 3600
export const JOEY_RECENT_S = 3600
export const MARK = '[保溫]'
export const SENDER = 'fleet-watchdog'
export const POKE_TEXT = `${MARK} 你閒了 50 分鐘，這一則只是為了不讓對話過期、不被壓縮。沒有事要做：回一個句點就結束，不用工具、不發任何訊息。`
const MAILBOX_LIST_TOOL = 'mcp__plugin_agent-inbox_agent-inbox__mailbox_list'  // WO-99 v3: the fleet server is gone
const JOEY_TG_ID = '1828173984'

export function remindText(n: number, oldestS: number | null): string {
  const m = Math.floor((oldestS ?? 0) / 60)
  const age = m < 120 ? `${m} 分鐘` : `${Math.floor(m / 60)} 小時 ${m % 60} 分`
  return `讀信箱（${n} 封未讀，最舊的等了 ${age}）：先用 mailbox_list（${MAILBOX_LIST_TOOL}）看清單`
}

// ---------------------------------------------------------------- transcript (port of keepwarm.py)
const ts = (r: any): number | null => {
  const t = typeof r?.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
  return Number.isNaN(t) ? null : t / 1000
}
function openTag(text: string): string | null {
  const m = /<channel\b[^>]*>/.exec(text)
  return m ? m[0] : null
}
export function isPoke(text: string): boolean {
  const m = /<channel\b[^>]*>/.exec(text)
  if (!m || !m[0].includes('user="fleet-watchdog"')) return false
  return text.slice(m.index + m[0].length).trimStart().startsWith(MARK)
}
export function isJoey(text: string): boolean {
  const t = openTag(text)
  return !!t && (t.includes(`user_id="${JOEY_TG_ID}"`) || t.includes('user="Joey (BTCC)"'))
}
export function fromWatchdog(text: string): boolean {
  const t = openTag(text)
  return !!t && t.includes('user="fleet-watchdog"')
}
/** Did this user record hand the agent work? Channel messages are isMeta with origin.kind=channel. */
export function isRealInput(r: any, text: string): boolean {
  const origin = r?.origin && typeof r.origin === 'object' ? r.origin : {}
  if (origin.kind === 'channel' || text.trimStart().startsWith('<channel')) return !fromWatchdog(text)
  if (r?.isMeta || r?.isCompactSummary || r?.isVisibleInTranscriptOnly) return false
  return !isPoke(text)
}
function userText(r: any): [string, boolean] {
  const c = r?.message?.content
  if (typeof c === 'string') return [c, false]
  if (Array.isArray(c)) {
    const tr = c.some((x: any) => x && typeof x === 'object' && x.type === 'tool_result')
    return [c.filter((x: any) => x && typeof x === 'object' && x.type === 'text').map((x: any) => x.text ?? '').join(' '), tr]
  }
  return ['', false]
}
function* records(text: string): Generator<any> {
  for (const line of text.split('\n')) {
    if (!line) continue
    try { yield JSON.parse(line) } catch {}
  }
}

export interface KScan {
  last_req: number | null; turn_open: boolean; compact_after: boolean; walled: boolean
  last_real: number | null; last_joey: number | null; after_req_usage: any
}
export function scan(text: string): KScan {
  const s: KScan = { last_req: null, turn_open: false, compact_after: false, walled: false, last_real: null, last_joey: null, after_req_usage: null }
  let lastAssistant: number | null = null
  let turnEnd: number | null = null
  for (const r of records(text)) {
    const typ = r.type
    if (r.isSidechain) continue
    if (typ === 'api-request' && r.querySource === 'repl_main_thread') {
      s.last_req = ts(r) ?? s.last_req
      s.compact_after = false; s.walled = false; s.after_req_usage = null
    } else if (typ === 'system' && r.subtype === 'compact_boundary') {
      s.compact_after = true
    } else if (typ === 'system' && (r.subtype === 'turn_duration' || r.subtype === 'stop_hook_summary')) {
      turnEnd = ts(r) ?? turnEnd
    } else if (typ === 'assistant') {
      const msg = r.message ?? {}
      lastAssistant = ts(r) ?? lastAssistant
      if (msg.model === '<synthetic>' || r.isApiErrorMessage) {
        s.walled = r.error === 'rate_limit' || JSON.stringify(msg.content ?? null).slice(0, 400).includes('limit')
      } else {
        s.walled = false
        if (s.after_req_usage == null && msg.usage) s.after_req_usage = msg.usage
      }
    } else if (typ === 'user') {
      const [t, tr] = userText(r)
      if (tr || !t.trim() || !isRealInput(r, t)) continue
      s.last_real = ts(r) ?? s.last_real
      if (isJoey(t)) s.last_joey = ts(r) ?? s.last_joey
    } else if (typ === 'attachment' && r.attachment?.type === 'queued_command') {
      // a message absorbed mid-turn is recorded only as this attachment (Chiron btcc 9570)
      const att = r.attachment
      const t = typeof att.prompt === 'string' ? att.prompt : ''
      if (!t.trim() || !isRealInput({ origin: att.origin, isMeta: att.isMeta }, t)) continue
      const at = ts(r) ?? ts(att)
      s.last_real = Math.max(at ?? 0, s.last_real ?? 0) || s.last_real
      if (isJoey(t)) s.last_joey = Math.max(at ?? 0, s.last_joey ?? 0) || s.last_joey
    }
  }
  s.turn_open = !!(lastAssistant && (turnEnd == null || turnEnd < lastAssistant))
  return s
}
/** Usage of the first genuine main-thread answer after time t (a poke's answer). */
export function firstUsageAfter(text: string, t: number): any {
  for (const r of records(text)) {
    if (r.type !== 'assistant' || r.isSidechain) continue
    const at = ts(r)
    const msg = r.message ?? {}
    if (at && at > t && msg.model !== '<synthetic>' && msg.usage) return msg.usage
  }
  return null
}
export function fiveMinuteCache(usage: any): boolean {
  const cc = usage?.cache_creation ?? {}
  return (cc.ephemeral_5m_input_tokens ?? 0) > 0 && !(cc.ephemeral_1h_input_tokens ?? 0)
}
export function wasCold(usage: any): boolean {
  if (!usage) return false
  return (usage.cache_creation_input_tokens ?? 0) > (usage.cache_read_input_tokens ?? 0)
}

// ---------------------------------------------------------------- decisions (port of keepwarm.py)
export interface KState {
  poked_for?: number | null; poked_at?: number | null; poked_kind?: 'poke' | 'mail'; judged?: boolean
  last_real?: number | null; cold_stop?: number | null; busy_line_at?: number | null; noted?: string
  held_logged_at?: number | null; mail_why?: string; down_since?: number | null
}
const hm = (t: number) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

export function decide(s: KScan | null, st: KState, now: number): [string, string] {
  if (!s || !s.last_req) return ['skip', 'never called the model in this session']
  const idle = now - s.last_req
  if (s.turn_open) return ['skip', 'turn running']
  if (idle < KEEPWARM_AFTER_S) return ['skip', `idle ${(idle / 60).toFixed(1)}m`]
  if (st.poked_for === s.last_req) return ['skip', 'already poked for this idle stretch']
  if (idle >= CACHE_TTL_S) return ['note', `already cold: ${Math.round(idle / 60)}m since the last request`]
  if (s.compact_after) return ['note', 'already cold: compacted since the last request']
  if (s.walled) return ['note', 'usage wall: the last answer is the limit error']
  if (fiveMinuteCache(s.after_req_usage)) return ['note', '5-minute cache (over plan quota): a poke at 50 min would be cold']
  const reals = [s.last_real, st.last_real].filter((x): x is number => typeof x === 'number' && x > 0)
  const lastReal = reals.length ? Math.max(...reals) : null
  if (lastReal == null || now - lastReal >= STOP_AFTER_S) return ['note', '24h since the last real work: letting it go cold']
  if (st.cold_stop && lastReal <= st.cold_stop) return ['note', 'stopped: a poke turned out cold (5-minute cache?) — until the next real work']
  return ['poke', `idle ${(idle / 60).toFixed(1)}m since the last request; last real work ${((now - lastReal) / 3600).toFixed(1)}h ago`]
}

export function decideMail(s: KScan | null, st: KState, now: number, n: number, oldestS: number | null, joeyRecent: boolean): [string, string] {
  if (!s || !s.last_req) return ['skip', 'never called the model in this session']
  if (s.walled) return ['skip', 'usage wall']
  const idle = now - s.last_req
  if (s.turn_open || idle < KEEPWARM_AFTER_S) {
    if (n > 0 && (oldestS ?? 0) >= MAIL_BUSY_AFTER_S && !joeyRecent && now - (st.busy_line_at ?? 0) >= MAIL_BUSY_AFTER_S) {
      const state = s.turn_open ? 'turn open' : `idle ${Math.round(idle / 60)}m < 50m`
      return ['busy-line', `busy (${state}); ${n} open, oldest ${Math.floor((oldestS ?? 0) / 60)}m`]
    }
    return ['skip', s.turn_open ? 'busy' : `idle ${(idle / 60).toFixed(1)}m`]
  }
  if (st.poked_for === s.last_req) {
    if (st.poked_kind === 'mail' && n > 0 && !joeyRecent && now - (st.poked_at ?? 0) >= MAIL_RESEND_S) {
      return ['remind', `reminder at ${hm(st.poked_at ?? 0)} produced no turn; again`]
    }
    return ['skip', 'already poked for this idle stretch']
  }
  if (n > 0 && !joeyRecent) return ['remind', `idle ${(idle / 60).toFixed(1)}m; ${n} open`]
  return ['keepwarm', n > 0 ? 'Joey spoke within the hour' : '0 open']
}

// ---------------------------------------------------------------- the pass
/** This agent's unread mail: on = its mailbox is open; null = the query failed (wake no one). */
export type MailCount = { on: boolean; n: number; oldestS: number | null } | null
export interface LocalKeepwarmDeps {
  mode(): 'live' | 'dry' | 'off'
  projectsDir(): string | null
  mail(): Promise<MailCount>
  deliver(text: string): Promise<boolean>
  log(level: 'info' | 'warn' | 'error', msg: string): void
  stateDir: string
  name: string
  now?(): number
}

function newestJsonl(dir: string): string | null {
  let best: { p: string; m: number } | null = null
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return null }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    try { const m = statSync(join(dir, n)).mtimeMs; if (!best || m > best.m) best = { p: join(dir, n), m } } catch {}
  }
  return best?.p ?? null
}
function readTail(path: string, max = TAIL_BYTES): string {
  const size = statSync(path).size
  const start = Math.max(0, size - max)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    let s = buf.toString('utf8')
    if (start > 0) { const i = s.indexOf('\n'); s = i >= 0 ? s.slice(i + 1) : '' }
    return s
  } finally { closeSync(fd) }
}

export class LocalKeepwarm {
  private running = false
  constructor(private readonly d: LocalKeepwarmDeps) {}
  private now(): number { return this.d.now ? this.d.now() : Date.now() / 1000 }
  private statePath() { return join(this.d.stateDir, 'keepwarm-local.json') }

  /** One pass (every minute). Returns the log lines it wrote. */
  async run(): Promise<string[]> {
    const mode = this.d.mode()
    if (mode !== 'live' && mode !== 'dry') return []
    if (this.running) return []
    this.running = true
    const lines: string[] = []
    const name = this.d.name
    let st: KState = {}
    try { st = JSON.parse(readFileSync(this.statePath(), 'utf8')) } catch {}
    try {
      const now = this.now()
      const dir = this.d.projectsDir()
      const path = dir ? newestJsonl(dir) : null
      const text = path ? readTail(path) : ''
      const s = path ? scan(text) : null
      if (s?.last_real) st.last_real = Math.max(s.last_real, st.last_real ?? 0)
      if (st.poked_at && (st.poked_kind ?? 'poke') === 'poke' && !st.judged && path) {
        const u = firstUsageAfter(text, st.poked_at)
        if (u) {
          st.judged = true
          if (wasCold(u)) {
            st.cold_stop = st.poked_at
            lines.push(`KEEPWARM-COLD ${name}: the poke at ${hm(st.poked_at)} wrote ${u.cache_creation_input_tokens} / read ${u.cache_read_input_tokens} — stopping until real work`)
          }
        }
      }
      const send = async (text: string, why: string, tag: string): Promise<boolean> => {
        if (mode === 'live') {
          const ok = await this.d.deliver(text)
          lines.push(`${tag} ${name}: ${why}; delivered=${ok}`)
          return ok
        }
        lines.push(`${tag}-DRY ${name}: ${why}`)
        return true
      }
      const mail = await this.d.mail()
      let goKeepwarm = true
      if (mail === null) {
        // spec #ring: the mailbox query failed → wake no one this pass
        if (!st.down_since) { st.down_since = now; lines.push(`MAILBOX-QUERY-FAILED ${name} — no reminders and no pokes until it answers`) }
        goKeepwarm = false
      } else {
        if (st.down_since) { lines.push(`MAILBOX-QUERY-OK ${name} again after ${Math.floor((now - st.down_since) / 60)}m`); st.down_since = null }
        if (mail.on) {
          const joeyRecent = !!(s?.last_joey && now - s.last_joey < JOEY_RECENT_S)
          const [act, why] = decideMail(s, st, now, mail.n, mail.oldestS, joeyRecent)
          if (joeyRecent && act !== 'remind' && act !== 'busy-line') {
            const [would, wwhy] = decideMail(s, st, now, mail.n, mail.oldestS, false)
            if ((would === 'remind' || would === 'busy-line') && now - (st.held_logged_at ?? 0) >= 3600) {
              st.held_logged_at = now
              lines.push(`REMIND-HELD ${name}: Joey spoke ${Math.floor((now - (s!.last_joey ?? now)) / 60)}m ago; would have sent ${would} (${wwhy})`)
            }
          }
          if (act === 'remind') {
            await send(remindText(mail.n, mail.oldestS), why, 'REMIND')
            Object.assign(st, { poked_for: s!.last_req, poked_at: now, poked_kind: 'mail', judged: true })
            goKeepwarm = false
          } else if (act === 'busy-line') {
            await send(remindText(mail.n, mail.oldestS), why, 'REMIND-LINE')
            st.busy_line_at = now
            goKeepwarm = false
          } else if (act === 'keepwarm') {
            st.mail_why = why
          } else {
            goKeepwarm = false
          }
        }
      }
      if (goKeepwarm) {
        const [action, why] = decide(s, st, now)
        if (action === 'note') {
          const key = `${why.split(':')[0]}|${s?.last_req ?? ''}`
          if (st.noted !== key) { st.noted = key; lines.push(`KEEPWARM-SKIP ${name}: ${why}`) }
        } else if (action === 'poke') {
          const extra = mail?.on && st.mail_why ? ` [${st.mail_why}]` : ''
          delete st.mail_why
          await send(POKE_TEXT, why + extra, 'KEEPWARM')
          Object.assign(st, { poked_for: s!.last_req, poked_at: now, poked_kind: 'poke', judged: mode !== 'live' })
        }
      }
    } catch (e) {
      lines.push(`KEEPWARM-ERROR ${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300))
    } finally {
      try { writeFileSync(this.statePath() + '.tmp', JSON.stringify(st, null, 1)); renameSync(this.statePath() + '.tmp', this.statePath()) } catch {}
      if (lines.length) {
        const stamp = new Date(this.now() * 1000).toISOString().replace('T', ' ').slice(0, 19)
        try { appendFileSync(join(this.d.stateDir, 'keepwarm-local.log'), lines.map(l => `${stamp} ${l}\n`).join('')) } catch {}
        for (const l of lines) this.d.log('info', `keepwarm-local: ${l}`)
      }
      this.running = false
    }
    return lines
  }

  start(everyMs = 60_000): void {
    const t = setInterval(() => { void this.run() }, everyMs)
    t.unref?.()
    this.d.log('info', `keepwarm-local ON (${this.d.mode()}; projects ${this.d.projectsDir() ?? '?'})`)
  }
}
