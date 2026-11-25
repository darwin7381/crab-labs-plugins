// screen-status.ts — WO-165 A (Joey TG chiron:2485, 2026-11-25): Jev reads the bottom of the agent's own Claude Code screen, and that reading is
// the state the daemon reports to Onsen. statusOf (onsen-status.ts) stays exactly as it is: it is still computed, it still drives the lanes, it is
// the trigger (its change makes the screen be looked at at once), the fallback (Jev unsure, failed, not asked) and the side every answer is compared
// with. Every disagreement and every answer that does not fit is written to run/screen-exceptions.jsonl, so the program rules (and Chiron's
// questions) can be fixed one exception at a time against the screen.
//
//   look      every pollMs (1 s) and right after the main's state changed (+40 ms, +450 ms): one tmux call that gives the pane's foreground command
//             and its visible text. The duty officer's own looks of the same pane (every 3 s) count as looks too.
//   regions   regions(): Chiron's jev_screen.py regions(), ported line for line: the input box is between the last two horizontal rules; the last 14
//             non-empty lines above it, the box, every line below it; no box (a menu, starting): the last 18 lines. The program reads facts
//             (counted_by_program, found_by_program) and hands them to Jev as facts, not as questions.
//   hash      screenHash(): what can change the answer. The input box's text, the spinner glyph, the activity line's parenthesis (elapsed time, tokens,
//             "thinking …"), every digit in the lines kept (timers, token counters, the status line's percentages) and right-aligned notices are left
//             out; the counts are hashed as numbers. Above the box only the lines from the last glyph line (activity / finished marker) down count:
//             a busy turn's output scrolling above its spinner is not a new state.
//   ask       only when the hash changed (one retry after a failed call, never a repeat of an answered screen; a screen seen again within 10 min
//             takes its earlier answer). One call in flight; a change while it flies is asked once it returns (coalesced, never queued). A timeout per
//             call, at most maxPerMin calls a minute, a 30–60 s pause after 429 / 529, the first look at a random moment of the first 5 s after start.
//             Not asked when the process is gone (the pane does not run Claude Code, or statusOf says pid_gone / pid_reused). The three questions (and
//             any others) and the publish threshold are Chiron's file, re-read when it changes:
//             ~/Development/Joey-Crablabs-Skills/screen-status/questions.json (JEV_SCREEN_QUESTIONS overrides); unreadable: the whole thing is off.
//   publish   state p ≥ the file's threshold (0.6): Jev's answer, mapped (publishView); else, and whenever Jev was not asked or failed: statusOf's view.
//             Both carry detail.judged_by ('jev' | 'program'). Off (the JEV_SCREEN switch, no key, no questions file): statusOf's view, untouched.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './duty-officer.ts'
import type { StatusView } from './onsen-status.ts'

// ------------------------------------------------------------------ regions (port of jev_screen.py regions(), 2026-11-26)
const RULE = /^\s*[─━]{20,}\s*$/
const ACT = /^\s*[*·✢✳✶✻✽]\s+\S.*…\s*(\(.*)?$/          // a live activity line: glyph, text, …, an optional parenthesis
const FIN = /^\s*[*·✢✳✶✻✽]\s+\S+ for .*· done /          // a turn's end: ✻ Worked for 17s · done 1:37 AM
const GLYPH = /^\s*[*·✢✳✶✻✽]\s+\S/                        // either, or any other glyph line (✻ Waiting for 2 background agents to finish)
/** Python's s[:n]: n code points */
const cut = (s: string, n: number): string => { const a = Array.from(s); return a.length <= n ? s : a.slice(0, n).join('') }

export type Counted = { running_agents: number; shells: number; monitors: number }
export type Found = { live_activity_line: string | null; finished_marker_comes_after_it: boolean; tool_running_line: boolean; esc_to_interrupt: boolean }
export type Regions = {
  has_input_box: boolean; above_input_box?: string; input_box?: string; below_input_box?: string; screen_bottom?: string
  counted_by_program: Counted; found_by_program: Found
}
export type Parts = { st: Regions; above: string[]; box: string[]; below: string[] }

export function regionParts(text: string): Parts {
  const rows = String(text ?? '').split('\n').map(r => r.replace(/\s+$/, ''))
  const idx: number[] = []
  rows.forEach((r, i) => { if (RULE.test(r)) idx.push(i) })
  const keep = (rs: string[]) => rs.filter(r => r.trim()).map(r => cut(r, 200))
  let above: string[], box: string[] = [], below: string[] = []
  let st: Omit<Regions, 'counted_by_program' | 'found_by_program'>
  if (idx.length >= 2) {
    const top = idx[idx.length - 2]!, bot = idx[idx.length - 1]!
    above = keep(rows.slice(0, top)).slice(-14)
    box = keep(rows.slice(top + 1, bot))
    below = keep(rows.slice(bot + 1))
    st = { has_input_box: true, above_input_box: above.join('\n'), input_box: cut(box.join('\n'), 300), below_input_box: below.join('\n') }
  } else {
    above = keep(rows).slice(-18)
    st = { has_input_box: false, screen_bottom: above.join('\n') }
  }
  const blob = [...above, ...below].join('\n')
  const src = below.join('\n') || blob
  let m = /(\d+) shells?/.exec(src); const shells = m ? parseInt(m[1]!, 10) : 0
  m = /(\d+) monitors?/.exec(src); const monitors = m ? parseInt(m[1]!, 10) : 0
  let agents = below.filter(r => /^\s*◯\s+\S/.test(r)).length
  m = /Waiting for (\d+) background agents?/.exec(blob)
  if (m) agents = Math.max(agents, parseInt(m[1]!, 10))
  const actI: number[] = [], finI: number[] = []
  above.forEach((r, i) => { if (ACT.test(r)) actI.push(i); if (FIN.test(r)) finI.push(i) })
  const found: Found = {
    live_activity_line: actI.length ? above[actI[actI.length - 1]!]!.trim() : null,
    finished_marker_comes_after_it: !!(actI.length && finI.length && finI[finI.length - 1]! > actI[actI.length - 1]!),
    tool_running_line: above.slice(-10).some(r => r.includes('Running…')),
    esc_to_interrupt: blob.includes('esc to interrupt'),
  }
  return { st: { ...st, counted_by_program: { running_agents: agents, shells, monitors }, found_by_program: found }, above, box, below }
}
/** the state Chiron's script hands to Jev for one screen (jev_screen.py regions()) */
export const regions = (text: string): Regions => regionParts(text).st

// ------------------------------------------------------------------ the hash: what can change the answer
const digits = (s: string): string => s.replace(/\d+(?:[.,:]\d+)*/g, '#')
const glyphLine = (s: string): string => GLYPH.test(s) ? s.replace(/^(\s*)[*·✢✳✶✻✽]/, '$1✻').replace(/\s*\([^()]*\)?\s*$/, ' (…)') : s
const NOTICE = /^\s{16,}\S/                                  // a right-aligned notice under the status line ("Stop hook error occurred · ctrl+o to see")
const AGENT_ROW = /^\s*◯\s+(\S+)/                          // a running sub-agent: its live activity and timers change all the time; its kind does not
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()     // column alignment moves when a timer gains a digit
/** the lines the hash is taken of (exported for the tests and for looking at a hash that moves) */
export function hashLines(p: Parts): string[] {
  const f = p.st.found_by_program
  // a tool's "Running…" coming and going in a turn whose activity line is live is the turn's output, not a new state (sandwich-master: 6 a minute)
  const live = !!f.live_activity_line && !f.finished_marker_comes_after_it
  const out: string[] = [p.st.has_input_box ? 'box' : 'nobox', JSON.stringify(p.st.counted_by_program),
    JSON.stringify([!!f.live_activity_line, f.finished_marker_comes_after_it, live ? null : f.tool_running_line, f.esc_to_interrupt])]
  if (p.st.has_input_box) {
    let i = -1
    for (let k = p.above.length - 1; k >= 0; k--) if (GLYPH.test(p.above[k]!)) { i = k; break }
    for (const l of i >= 0 ? p.above.slice(i) : p.above) out.push(squash(digits(glyphLine(l))))
    out.push('—box—')                                         // the box's text (typing, a suggestion) says nothing about the state
    for (const l of p.below) {
      if (NOTICE.test(l)) continue
      const a = AGENT_ROW.exec(l)
      out.push(a ? `◯ ${a[1]}` : squash(digits(l)))
    }
  } else for (const l of p.above) out.push(squash(digits(glyphLine(l))))
  return out
}
export function screenHash(p: Parts): string {
  return createHash('sha1').update(hashLines(p).join('\n')).digest('hex').slice(0, 16)
}

// ------------------------------------------------------------------ Chiron's questions file
export const QUESTIONS_PATH_DEFAULT = (home: string): string => join(home, 'Development', 'Joey-Crablabs-Skills', 'screen-status', 'questions.json')
export type Questions = { questions: Record<string, any>; setting: string | null; model: string | null; threshold: number; version: unknown; sha: string
  path: string }
/** the file as Chiron writes it (version, model, setting, publish_when_state_probability_at_least, questions.state / fits_any / menu); null when it
 *  is not that shape: the whole thing does not run */
export function parseQuestions(text: string, path: string): Questions | null {
  let j: any
  try { j = JSON.parse(text) } catch { return null }
  const q = j?.questions
  const crit = (x: any) => x?.criteria && typeof x.criteria === 'object' && !Array.isArray(x.criteria) && Object.keys(x.criteria).length > 0
  if (!q || typeof q !== 'object' || q.state?.type !== 'choice' || !crit(q.state) || q.menu?.type !== 'choice' || !crit(q.menu) || q.fits_any?.type !== 'noul') return null
  const thr = Number(j.publish_when_state_probability_at_least)
  return { questions: q, setting: typeof j.setting === 'string' && j.setting.trim() ? j.setting : null, model: typeof j.model === 'string' && j.model.trim() ? j.model.trim() : null,
    threshold: Number.isFinite(thr) && thr > 0 && thr <= 1 ? thr : 0.6, version: j.version ?? null, sha: createHash('sha256').update(text).digest('hex').slice(0, 12), path }
}

// ------------------------------------------------------------------ Jev's answer → the published view
export type JevRead = { state: string | null; p: number; conf: number | null; probs: Record<string, number> | null; fits_any: number | null
  menu: string | null; menu_p: number | null; menu_probs: Record<string, number> | null }
const num = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) ? x : null
export function readAnswers(a: Record<string, any>): JevRead {
  const s = a?.state ?? {}, m = a?.menu ?? {}
  const probs = s.probabilities && typeof s.probabilities === 'object' ? s.probabilities : null
  const mprobs = m.probabilities && typeof m.probabilities === 'object' ? m.probabilities : null
  const state = typeof s.choice === 'string' ? s.choice : null, menu = typeof m.choice === 'string' ? m.choice : null
  return { state, p: num(probs?.[state ?? '']) ?? 0, conf: num(s.confidence), probs, fits_any: num(a?.fits_any?.noul),
    menu, menu_p: menu ? num(mprobs?.[menu]) : null, menu_probs: mprobs }
}
/** the state options this program maps (point 5 of Chiron's 18:26Z comment); any other choice (not_claude, other, an option Chiron adds) is not
 *  published: statusOf's view is, and the screen is an exception */
export const MAPPED = new Set(['working', 'idle', 'idle_background_running', 'waiting_for_human', 'interrupted', 'usage_limit', 'compacting', 'starting'])
const r2 = (x: number): number => Math.round(x * 100) / 100
/** statusOf's offline reasons that mean the process is gone (the OS says so): offline, Jev not asked */
export const GONE = new Set(['pid_gone', 'pid_reused'])
const gone = (p: StatusView): boolean => p.state === 'offline' && GONE.has(String((p.detail as any)?.reason ?? ''))
const pick = (o: Record<string, unknown>, ks: string[]): Record<string, unknown> => Object.fromEntries(ks.filter(k => o[k] !== undefined).map(k => [k, o[k]]))
/** Jev's reading as Onsen's state and detail. The program's own facts stay in the detail: queued_joey, the usage wall, lane runs, and (during a turn
 *  statusOf also sees) the turn's start and its tool. detail.subagents in a turn = counted_by_program.running_agents */
export function publishView(j: JevRead, st: Regions, prog: StatusView): StatusView {
  const pd = (prog.detail ?? {}) as Record<string, any>
  // statusOf offline while Claude Code runs in the pane (not_connected: this daemon has no stream with it; no_registration: starting): the screen's state,
  // and the reason the program has, so a session this daemon cannot reach is not shown as simply idle
  const base = { ...pick(pd, ['queued_joey', 'walled', 'lanes']), ...(prog.state === 'offline' ? { program_offline: pd.reason ?? null } : {}) }
  const turn = prog.state === 'busy' || prog.state === 'stuck' || prog.state === 'waiting' ? pick(pd, ['turn_started_at', 'tool']) : {}
  const J = { judged_by: 'jev', judge_p: r2(j.p) }
  const c = st.counted_by_program
  const last = { last_activity_at: prog.last_activity_at ?? null }
  const v = (state: string, detail: Record<string, unknown>): StatusView => ({ state: state as StatusView['state'], detail: { ...detail, ...J }, ...last })
  switch (j.state) {
    case 'working': return v('busy', { ...turn, subagents: c.running_agents, ...base })
    case 'idle': return v('idle', { ...base })
    case 'idle_background_running': return v('idle', { background: { agents: c.running_agents, shells: c.shells, monitors: c.monitors }, ...base })
    case 'waiting_for_human': {
      const menu = j.menu ?? 'other'
      const text = st.has_input_box ? st.above_input_box ?? '' : st.screen_bottom ?? ''
      return v('waiting', { waitingFor: menu, ...(menu === 'other' ? { waiting_text: cut(redact(text), 200) } : {}), ...turn, ...base })
    }
    case 'interrupted': return v('idle', { interrupted: true, ...base })
    case 'usage_limit': return v('walled', { ...base, walled: { until: pd.walled?.until ?? null, ...(pd.walled?.kind ? { kind: pd.walled.kind } : {}) } })
    case 'compacting': return v('busy', { compacting: true, ...turn, ...base })
    case 'starting': return v('starting', { ...base })
  }
  return { ...prog, detail: { ...pd, judged_by: 'program' } }
}
/** the exceptions an answer shows by itself (the comparison with statusOf is made settleMs later, once the screen held) */
export function answerExceptions(j: JevRead, st: Regions, threshold: number): string[] {
  const k: string[] = []
  if (j.state === 'other') k.push('state_other')
  if (j.menu === 'other') k.push('menu_other')
  if (j.state && !MAPPED.has(j.state) && j.state !== 'other') k.push(`state_unmapped:${j.state}`)
  if (j.p < threshold) k.push('state_p_low')
  if (j.fits_any == null || j.fits_any < 0.5) k.push('fits_any_low')
  const c = st.counted_by_program, bg = c.running_agents + c.shells + c.monitors
  if (j.state === 'idle_background_running' && bg === 0) k.push('jev_background_program_none')
  if (j.state === 'idle' && bg > 0) k.push('program_background_jev_idle')
  if (j.state === 'waiting_for_human' && (j.menu === 'none' || j.menu == null)) k.push('waiting_menu_none')
  return k
}

// ------------------------------------------------------------------ one look at the pane: one tmux call
/** the pane's foreground command and its visible text, in ONE tmux client run (display-message ; capture-pane); null when the pane cannot be read.
 *  `-u` as the duty officer: a launchd daemon has no UTF-8 locale. Killed (SIGKILL) at timeoutMs */
export function snapPane(tmux: string, timeoutMs = 3000): Promise<{ cmd: string; pane: string } | null> {
  return new Promise(resolve => {
    let out = '', done = false
    let p: ReturnType<typeof spawn>
    try { p = spawn('tmux', ['-u', 'display-message', '-p', '-t', tmux, '#{pane_current_command}', ';', 'capture-pane', '-p', '-t', tmux], { stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return resolve(null) }
    const end = (v: { cmd: string; pane: string } | null) => { if (!done) { done = true; clearTimeout(t); resolve(v) } }
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {}; end(null) }, timeoutMs)
    p.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8') })
    p.on('error', () => end(null))
    p.on('close', code => {
      if (code !== 0) return end(null)
      const i = out.indexOf('\n')
      end(i < 0 ? null : { cmd: out.slice(0, i).trim(), pane: out.slice(i + 1) })
    })
  })
}

// ------------------------------------------------------------------ the reader
export type JevAnswer = { answers?: Record<string, any>; error?: string; ms: number; usage?: Record<string, unknown> | null; model?: string | null }
export interface ScreenDeps {
  agent: string
  /** <workspace>/.lanes: run/jev-calls.jsonl (every call), run/screen-exceptions.jsonl, run/screen-questions-<sha>.json (each version asked) */
  lanesDir: string
  /** the JEV_SCREEN switch for this agent, now */
  switchOn(): boolean
  /** the agent's TypeSafe key is there (never its value) */
  hasKey(): boolean
  questionsPath: string
  snap(): Promise<{ cmd: string; pane: string } | null>
  /** the pane's foreground command is Claude Code */
  isClaude(cmd: string): boolean
  /** statusOf's view now (the program's side) */
  program(): StatusView
  /** the view this reader gives may have changed: report again (statusOf computed, view() applied) */
  publish(): void
  ask(state: Record<string, unknown>, questions: Record<string, unknown>, timeoutMs: number, model: string | null): Promise<JevAnswer>
  /** one record for run/jev-calls.jsonl */
  logCall(rec: { site: string; question: unknown; inputs: unknown; answer: unknown; p: number | null; ms: number; err: string | null; usage?: unknown; model?: unknown }): void
  log(level: 'info' | 'warn', msg: string): void
  now?(): number
  random?(): number
}
export interface ScreenOpts {
  pollMs: number; timeoutMs: number; maxPerMin: number; settleMs: number; pokeMs: number[]; retryMs: number; backoffMs: number
  activeCheckMs: number; exceptionsPerHour: number
  /** the first look after start: at a random moment within this (a fleet that restarts together does not ask together) */
  firstJitterMs: number
  /** a screen seen again within this (a notice that comes and goes, a flicker between two screens) takes its earlier answer: not asked again */
  cacheMs: number
}
export const SCREEN_DEFAULTS: ScreenOpts = { pollMs: 1000, timeoutMs: 3000, maxPerMin: 20, settleMs: 1500, pokeMs: [40, 450], retryMs: 10_000,
  backoffMs: 30_000, activeCheckMs: 10_000, exceptionsPerHour: 120, firstJitterMs: 5000, cacheMs: 10 * 60_000 }
const CACHE_MAX = 16
export const SITE = 'screen-status'
type Cur = { hash: string; parts: Parts; cmd: string; alive: boolean; at: number }
type Ans = { hash: string; at: number; jev: JevRead; usable: boolean; parts: Parts; ms: number; model: string | null; seq: number }

export class ScreenStatus {
  readonly o: ScreenOpts
  private cur: Cur | null = null
  private answer: Ans | null = null
  private cache = new Map<string, Ans>()
  private inflight: { hash: string; at: number } | null = null
  private failed: { hash: string; tries: number; at: number } | null = null
  private calls: number[] = []
  private backoffUntil = 0
  private capTold = 0
  private looking = false
  private lastLookAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private pokes = new Set<number>()
  private progKey: string | null = null
  private act: { on: boolean; at: number; why: string } = { on: false, at: -Infinity, why: 'not checked' }
  private q: { m: number; size: number; v: Questions | null } | null = null
  private qWritten = new Set<string>()
  private excAt: number[] = []
  private seq = 0
  readonly stats = { looks: 0, changes: 0, calls: 0, cache_hits: 0, failed: 0, capped: 0, exceptions: 0, judged_jev: 0, judged_program: 0 }
  constructor(readonly d: ScreenDeps, o: Partial<ScreenOpts> = {}) { this.o = { ...SCREEN_DEFAULTS, ...o } }
  private now(): number { return (this.d.now ?? Date.now)() }

  // ---- on / off
  /** the switch, the key and Chiron's questions file, checked at most every activeCheckMs; a change is logged once */
  active(): boolean {
    const now = this.now()
    if (now - this.act.at < this.o.activeCheckMs) return this.act.on
    const why = !this.d.switchOn() ? 'JEV_SCREEN does not list this agent' : !this.d.hasKey() ? 'no TypeSafe key (.secrets/typesafe.env)'
      : !this.questions() ? `no readable questions file (${this.d.questionsPath})` : ''
    const on = !why
    if (on !== this.act.on || why !== this.act.why) {
      this.d.log('info', on ? `screen-status: ON for ${this.d.agent} (Jev reads the screen; questions ${this.d.questionsPath}, poll ${this.o.pollMs} ms)`
        : `screen-status: off for ${this.d.agent} (${why}): the status is statusOf's, unchanged`)
      if (!on) { this.answer = null; this.cur = null; this.failed = null; this.cache.clear() }
    }
    this.act = { on, at: now, why }
    return on
  }
  /** Chiron's file, re-read when its mtime or size changes */
  questions(): Questions | null {
    let st: { mtimeMs: number; size: number }
    try { st = statSync(this.d.questionsPath) } catch { this.q = null; return null }
    if (this.q && this.q.m === st.mtimeMs && this.q.size === st.size) return this.q.v
    let v: Questions | null = null
    try { v = parseQuestions(readFileSync(this.d.questionsPath, 'utf8'), this.d.questionsPath) } catch {}
    if (!v) this.d.log('warn', `screen-status: ${this.d.questionsPath} is not in the expected shape (questions.state / fits_any / menu): not asked`)
    this.q = { m: st.mtimeMs, size: st.size, v }
    return v
  }

  // ---- looking
  start(): void {
    if (this.timer || this.firstTimer) return
    const first = Math.floor((this.d.random ?? Math.random)() * Math.max(this.o.pollMs, this.o.firstJitterMs))   // a fleet that starts together does not look together
    this.firstTimer = setTimeout(() => { this.firstTimer = null; this.tick(); this.timer = setInterval(() => this.tick(), this.o.pollMs); (this.timer as any).unref?.() }, first)
    ;(this.firstTimer as any).unref?.()
  }
  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer); this.firstTimer = null
    if (this.timer) clearInterval(this.timer); this.timer = null
  }
  tick(): void {
    if (!this.active()) return
    if (this.now() - this.lastLookAt < this.o.pollMs * 0.6) return                     // the duty officer looked a moment ago
    void this.lookNow()
  }
  /** the main's state changed (a hook, the registry, a tool): look now and once more a moment later, without waiting for the poll */
  poke(): void {
    if (!this.act.on) return
    for (const ms of this.o.pokeMs) {
      if (this.pokes.has(ms)) continue
      this.pokes.add(ms)
      const t = setTimeout(() => { this.pokes.delete(ms); void this.lookNow() }, ms)
      ;(t as any).unref?.()
    }
  }
  /** statusOf's view was just computed: a change of its state or detail (not last_activity_at alone, not the heartbeat) is an event of the main */
  programChanged(v: StatusView): void {
    const k = JSON.stringify([v.state, v.detail ?? null])
    if (this.progKey !== null && k !== this.progKey) this.poke()
    this.progKey = k
  }
  async lookNow(): Promise<void> {
    if (this.looking || !this.act.on) return
    this.looking = true
    let s: { cmd: string; pane: string } | null = null
    try { s = await this.d.snap() } catch {} finally { this.looking = false }
    if (s) this.sample(s.pane, s.cmd)
    else if (this.cur) { this.cur = null; this.d.publish() }                           // the pane cannot be read: statusOf
  }
  /** one look at the pane (ours, or the duty officer's) */
  sample(pane: string, cmd: string): void {
    if (!this.act.on) return
    const now = this.now()
    this.lastLookAt = now
    this.stats.looks++
    const parts = regionParts(pane)
    const hash = screenHash(parts)
    const alive = this.d.isClaude(cmd)
    const prev = this.cur
    this.cur = { hash, parts, cmd, alive, at: now }
    if (!prev || prev.hash !== hash || prev.alive !== alive) {
      this.stats.changes++
      this.maybeAsk()
      this.d.publish()
    } else this.maybeAsk()
  }

  // ---- asking
  private maybeAsk(): void {
    const c = this.cur
    if (!c || this.inflight || this.answer?.hash === c.hash) return
    if (!c.alive) return                                      // Claude Code is not the pane's program: not asked
    const now = this.now()
    const hit = this.cache.get(c.hash)
    if (hit && now - hit.at < this.o.cacheMs) { this.stats.cache_hits++; this.answer = hit; this.d.publish(); return }
    if (now < this.backoffUntil) return
    if (this.failed?.hash === c.hash && (this.failed.tries >= 2 || now - this.failed.at < this.o.retryMs)) return
    const prog = this.d.program()
    if (gone(prog)) return                                    // the process is gone (the OS says so): offline, not asked
    this.calls = this.calls.filter(t => now - t < 60_000)
    if (this.calls.length >= this.o.maxPerMin) {
      this.stats.capped++
      if (now - this.capTold >= 60_000) { this.capTold = now; this.d.log('warn', `screen-status: ${this.o.maxPerMin} Jev calls in the last minute: not asked until the minute frees (statusOf meanwhile)`) }
      return
    }
    const q = this.questions()
    if (!q) return
    this.calls.push(now)
    this.inflight = { hash: c.hash, at: now }
    void this.ask(c, q)
  }
  private async ask(c: Cur, q: Questions): Promise<void> {
    const st = redactRegions(c.parts.st)
    const state: Record<string, unknown> = { ...(q.setting ? { setting: q.setting } : {}), ...st, claude_process_alive: true }
    let r: JevAnswer
    try { r = await this.d.ask(state, q.questions, this.o.timeoutMs, q.model) } catch (e: any) { r = { error: `${e?.name ?? 'Error'}: ${e?.message ?? e}`.slice(0, 200), ms: 0 } }
    this.inflight = null
    this.stats.calls++
    this.writeQuestions(q)
    const jev = r.answers ? readAnswers(r.answers) : null
    try {
      this.d.logCall({ site: SITE, question: { file: q.path, version: q.version, sha: q.sha, copy: `run/screen-questions-${q.sha}.json` },
        inputs: { agent: this.d.agent, hash: c.hash, has_input_box: c.parts.st.has_input_box, counted_by_program: c.parts.st.counted_by_program,
          found_by_program: st.found_by_program, tail: cut(lastLines(st, 4), 400) },
        answer: r.answers ?? null, p: jev ? r2(jev.p) : null, ms: r.ms, err: r.error ?? null, usage: r.usage ?? null, model: r.model ?? q.model })
    } catch {}
    if (r.error || !r.answers || !jev) {
      this.stats.failed++
      const now = this.now()
      this.failed = { hash: c.hash, tries: this.failed?.hash === c.hash ? this.failed.tries + 1 : 1, at: now }
      if (/HTTP (429|529)/.test(String(r.error ?? ''))) this.backoffUntil = now + this.o.backoffMs * (1 + (this.d.random ?? Math.random)())   // jittered: the fleet does not come back together
      this.exception(['call_failed'], c.parts, st, null, q, { error: r.error ?? 'no answers', ms: r.ms })
      this.d.publish()
      this.maybeAsk()
      return
    }
    this.failed = null
    const a: Ans = { hash: c.hash, at: this.now(), jev, usable: !!jev.state && MAPPED.has(jev.state) && jev.p >= q.threshold, parts: c.parts, ms: r.ms,
      model: r.model ?? q.model, seq: ++this.seq }
    this.answer = a
    this.cache.delete(a.hash); this.cache.set(a.hash, a)
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
    const kinds = answerExceptions(jev, c.parts.st, q.threshold)
    // the comparison with statusOf: settleMs later, and only if the screen held (the registry and the screen move within ~0.5 s of each other;
    // comparing at once would write every turn's edge as a disagreement)
    const t = setTimeout(() => {
      const k = [...kinds]
      const prog = this.d.program()
      if (a.usable && this.answer?.seq === a.seq && this.cur?.hash === a.hash) {
        const pub = publishView(jev, c.parts.st, prog)
        if (pub.state !== prog.state) k.push('differs_from_program')
      }
      if (k.length) this.exception(k, c.parts, st, jev, q, { ms: r.ms, model: a.model }, prog)
    }, this.o.settleMs)
    ;(t as any).unref?.()
    this.d.publish()
    if (this.cur && this.cur.hash !== c.hash) this.maybeAsk()                           // the screen moved on while Jev answered: ask once more
  }

  // ---- what is published
  /** the view to report: statusOf's untouched when off; Jev's reading when it is sure of the screen showing now; else statusOf's (judged_by program) */
  view(p: StatusView): StatusView {
    if (!this.act.on) return p
    const c = this.cur, a = this.answer
    const ok = !!c && c.alive && !gone(p) && !!a && a.usable && (a.hash === c.hash || !!this.inflight)
    if (ok) { this.stats.judged_jev++; return publishView(a!.jev, a!.parts.st, p) }
    this.stats.judged_program++
    return { ...p, detail: { ...(p.detail ?? {}), judged_by: 'program' } }
  }
  /** for /health */
  health(): Record<string, unknown> {
    return { on: this.act.on, ...(this.act.on ? {} : { why: this.act.why }), poll_ms: this.o.pollMs, ...this.stats,
      screen: this.cur ? { hash: this.cur.hash, alive: this.cur.alive, at: new Date(this.cur.at).toISOString() } : null,
      answer: this.answer ? { hash: this.answer.hash, state: this.answer.jev.state, p: r2(this.answer.jev.p), menu: this.answer.jev.menu, usable: this.answer.usable,
        at: new Date(this.answer.at).toISOString() } : null, in_flight: !!this.inflight }
  }

  // ---- files
  private writeQuestions(q: Questions): void {
    if (this.qWritten.has(q.sha)) return
    this.qWritten.add(q.sha)
    const f = join(this.d.lanesDir, 'run', `screen-questions-${q.sha}.json`)
    try { if (!existsSync(f)) { mkdirSync(join(this.d.lanesDir, 'run'), { recursive: true }); writeFileSync(f, readFileSync(q.path, 'utf8')) } } catch {}
  }
  private exception(kinds: string[], parts: Parts, st: Regions, jev: JevRead | null, q: Questions, call: Record<string, unknown>, prog?: StatusView): void {
    const now = this.now()
    this.excAt = this.excAt.filter(t => now - t < 3600_000)
    if (this.excAt.length >= this.o.exceptionsPerHour) return
    this.excAt.push(now)
    this.stats.exceptions++
    const program = prog ?? this.d.program()
    const screen = st.has_input_box ? { above_input_box: st.above_input_box, input_box: st.input_box, below_input_box: st.below_input_box } : { screen_bottom: st.screen_bottom }
    const rec = { ts: new Date(now).toISOString(), agent: this.d.agent, kinds, has_input_box: st.has_input_box, screen, counted_by_program: st.counted_by_program,
      found_by_program: st.found_by_program,
      jev: jev ? { state: jev.state, state_p: r2(jev.p), state_confidence: jev.conf, state_probabilities: jev.probs, fits_any: jev.fits_any, menu: jev.menu,
        menu_p: jev.menu_p, menu_probabilities: jev.menu_probs, ...call } : { ...call },
      program: { state: program.state, detail: program.detail ?? null }, published: (() => { const v = this.view(program); return { state: v.state, judged_by: v.detail?.judged_by ?? null } })(),
      hash: screenHash(parts), questions: { version: q.version, sha: q.sha } }
    const f = join(this.d.lanesDir, 'run', 'screen-exceptions.jsonl')
    try {
      mkdirSync(join(this.d.lanesDir, 'run'), { recursive: true })
      try { if (statSync(f).size > 20 * 1024 * 1024) renameSync(f, `${f}.1`) } catch {}
      appendFileSync(f, JSON.stringify(rec) + '\n')
    } catch {}
  }
}
/** the screen text that goes to Jev and into the logs: tokens, keys and e-mail addresses hidden (the duty officer's redact) */
function redactRegions(st: Regions): Regions {
  const o: Regions = { ...st, found_by_program: { ...st.found_by_program, live_activity_line: st.found_by_program.live_activity_line == null ? null : redact(st.found_by_program.live_activity_line) } }
  for (const k of ['above_input_box', 'input_box', 'below_input_box', 'screen_bottom'] as const) if (typeof o[k] === 'string') o[k] = redact(o[k] as string)
  return o
}
function lastLines(st: Regions, n: number): string {
  const t = st.has_input_box ? st.above_input_box ?? '' : st.screen_bottom ?? ''
  return t.split('\n').slice(-n).join('\n')
}
