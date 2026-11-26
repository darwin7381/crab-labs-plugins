// screen-status.ts — WO-165 A (Joey TG chiron:2485, 2026-11-25): the bottom of the agent's own Claude Code screen is read, and that reading is the
// state the daemon reports. WO-169 (Joey TG chiron:2547, 2520: 「Jev頂替只是程式邏輯判斷的部分…後面還是要根據他的輸出選項結果再經過一個程式輸出，
// 然後輸出的東西才擺在各種應該擺的位置」「不是把它當成 Agent 而是把它當成就是一個小程式的一小段」) fixes the interface around the judging step:
//
//   above     this file, no Jev: the look (one tmux call), regions() (Chiron's jev_screen.py, ported line for line), the counts and facts the program
//             reads (counted_by_program, found_by_program), the hash of what can change the answer, the cadence (ask only when the hash changed, one in
//             flight, the cache, the 60 s re-ask, the cap a minute)
//   middle    a ScreenJudge: judge(parts) → ScreenVerdict | null. The one in use is JevJudge (screen-judge-jev.ts: Jev asked, its answer collected by the
//             program into a ScreenVerdict; Jev's own shapes never leave that file). SCREEN_JUDGE picks it (jev, the default | program: none yet, the
//             record is statusOf's); a program judge later implements the same interface and only the setting changes
//   below     this file, no Jev: publishView(verdict or null, regions, statusOf's view, facts) composes the one status record (offline → starting →
//             usage limit → waiting → compacting → stuck → busy → idle); the reader's view() is what server.ts's currentStatus() gives Onsen, the pin,
//             /healthz and the lanes' five readers. Nothing below knows who judged (detail.judged_by is a label only)
//   collect   every new screen hash's first verdict of the day: one line of <workspace>/.lanes/run/screen-verdicts.jsonl (the three regions masked as
//             the exception log, the program's facts, the verdict): the question bank a program judge is tested on
//
// statusOf (onsen-status.ts) stays exactly as it is: it is still computed, it is the trigger (its change makes the screen be looked at at once), the
// fallback (no verdict) and the side every verdict is compared with (JevJudge's exception log).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './duty-officer.ts'
import type { StatusView } from './onsen-status.ts'

// ------------------------------------------------------------------ regions (port of jev_screen.py regions(), 2026-11-26)
const RULE = /^\s*[─━]{20,}\s*$/
const ACT = /^\s*[*·✢✳✶✻✽]\s+\S.*…\s*(\(.*)?$/          // a live activity line: glyph, text, …, an optional parenthesis
const FIN = /^\s*[*·✢✳✶✻✽]\s+\S+ for .*· done /          // a turn's end: ✻ Worked for 17s · done 1:37 AM
const GLYPH = /^\s*[*·✢✳✶✻✽]\s+\S/                        // either, or any other glyph line (✻ Waiting for 2 background agents to finish)
/** Python's s[:n]: n code points */
export const cut = (s: string, n: number): string => { const a = Array.from(s); return a.length <= n ? s : a.slice(0, n).join('') }

export type Counted = { running_agents: number; shells: number; monitors: number; background_tasks: number }
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
  m = /(\d+) background tasks?/.exec(src); const background_tasks = m ? parseInt(m[1]!, 10) : 0   // v3 (Chiron 19:21Z): "· 2 background tasks · ctrl+t to show tasks"
  let agents = below.filter(r => /^\s*◯\s+\S/.test(r)).length
  // "Waiting for N background agents" counts only while it is the LAST marker line above the box: once they finish, the old line stays on the screen
  // under a later marker (✻ Crunched for 2s · done). Chiron WO-165 20:23Z (lab 20:11Z: background.agents 1 held for two minutes after it finished)
  const marks = above.filter(r => GLYPH.test(r))
  m = marks.length ? /Waiting for (\d+) background agents?/.exec(marks[marks.length - 1]!) : null
  if (m) agents = Math.max(agents, parseInt(m[1]!, 10))
  const actI: number[] = [], finI: number[] = []
  above.forEach((r, i) => { if (ACT.test(r)) actI.push(i); if (FIN.test(r)) finI.push(i) })
  const found: Found = {
    live_activity_line: actI.length ? above[actI[actI.length - 1]!]!.trim() : null,
    finished_marker_comes_after_it: !!(actI.length && finI.length && finI[finI.length - 1]! > actI[actI.length - 1]!),
    tool_running_line: above.slice(-10).some(r => r.includes('Running…')),
    esc_to_interrupt: blob.includes('esc to interrupt'),
  }
  return { st: { ...st, counted_by_program: { running_agents: agents, shells, monitors, background_tasks }, found_by_program: found }, above, box, below }
}
/** the state Chiron's script hands to Jev for one screen (jev_screen.py regions()) */
export const regions = (text: string): Regions => regionParts(text).st

// ------------------------------------------------------------------ the hash: what can change the answer
const digits = (s: string): string => s.replace(/\d+(?:[.,:]\d+)*/g, '#')
const AGENT_ROW = /^\s*◯\s+(\S+)/                          // a running sub-agent row: its kind stays, its live activity text changes all the time
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()     // column alignment moves when a timer gains a digit
/** one hashed line: digits masked, whitespace runs collapsed; a live activity line counts only as being there (its verb changes mid-turn, its glyph
 *  every second); a finished marker or any other glyph line with its glyph normalised */
const hl = (l: string): string => ACT.test(l) ? (/Compacting/i.test(l) ? '<activity line: compacting>' : '<activity line>')
  : squash(digits(GLYPH.test(l) ? l.replace(/^(\s*)[*·✢✳✶✻✽]/, '$1✻') : l))
// right-aligned notices ("stop hook problem · ctrl+o to see") and the usage notice ("You've used 79% of your weekly limit"): not a state (measured
// 11-25 19:27–19:31Z on a live pane: each one that came and went was a call)
const NOTICE = /^\s{16,}\S|You've used \d+% of your/
const parens = (l: string): number => (l.match(/\(/g)?.length ?? 0) - (l.match(/\)/g)?.length ?? 0)
/** lines as the hash reads them: notices left out; an activity line and the line(s) its parenthesis wraps onto ("… (running Stop hooks… 2/5 · 1m 27s ·"
 *  / "↓ 2.7k tokens)") are one line, and the wrap point moves as the timer grows */
function hashRows(rows: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i]!
    if (NOTICE.test(l)) continue
    if (ACT.test(l)) for (let d = parens(l), k = 0; d > 0 && k < 2 && i + 1 < rows.length; k++) d += parens(rows[++i]!)
    out.push(hl(l))
  }
  return out
}
/** the lines the hash is taken of: Chiron's list (WO-165 19:23Z, "only what can change the answer"; digits masked): has_input_box; whether there is
 *  an activity line, a finished marker after it, a "Running…", an "esc to interrupt"; the four counts; below_input_box in full; the last 2 lines above
 *  the input box; with no input box, screen_bottom in full. Masks on top, for the same purpose: a live activity line's text (and its wrapped tail), a
 *  ◯ sub-agent row's activity text (its kind stays; how many rows there are is a count), notices and whitespace runs are not part of it (exported
 *  for the tests) */
export function hashLines(p: Parts): string[] {
  const f = p.st.found_by_program, c = p.st.counted_by_program
  const out: string[] = [p.st.has_input_box ? 'box' : 'nobox',
    JSON.stringify([!!f.live_activity_line, f.finished_marker_comes_after_it, f.tool_running_line, f.esc_to_interrupt]),
    JSON.stringify([c.running_agents, c.shells, c.monitors, c.background_tasks])]
  if (p.st.has_input_box) {
    out.push(...hashRows(p.above).slice(-2))
    out.push('—below—')
    for (const l of p.below) { if (NOTICE.test(l)) continue; const a = AGENT_ROW.exec(l); out.push(a ? `◯ ${a[1]}` : hl(l)) }
  } else out.push(...hashRows(p.above))
  return out
}
export function screenHash(p: Parts): string {
  return createHash('sha1').update(hashLines(p).join('\n')).digest('hex').slice(0, 16)
}
/** the screen's text as it is (only for "has anything changed since the last ask": the 60 s re-ask) */
export function rawHash(p: Parts): string {
  const st = p.st
  return createHash('sha1').update(JSON.stringify([st.above_input_box, st.input_box, st.below_input_box, st.screen_bottom])).digest('hex').slice(0, 16)
}


// ------------------------------------------------------------------ 一 the fixed output: ScreenVerdict (its master copy: JCS screen-status/README.md)
/** the states a judge may answer. An option Chiron adds to questions.json is added here as well; one that is not does not reach the record */
export const VERDICT_STATES = ['working', 'idle', 'idle_background_running', 'waiting_for_human', 'interrupted', 'usage_limit', 'compacting', 'starting'] as const
/** the menus a judge may name */
export const VERDICT_MENUS = ['none', 'permission', 'model_picker', 'trust_folder', 'usage_limit_options', 'resume_picker', 'plan_or_question', 'login', 'other'] as const
export type VerdictState = typeof VERDICT_STATES[number]
export type VerdictMenu = typeof VERDICT_MENUS[number]
/** what a judge answers for one screen: one of the states, one of the menus, how sure (0–1), who judged (a label: nothing below reads it to decide) */
export type ScreenVerdict = { state: VerdictState; menu: VerdictMenu; p: number; by: 'jev' | 'program' }
const STATES: ReadonlySet<string> = new Set(VERDICT_STATES), MENUS: ReadonlySet<string> = new Set(VERDICT_MENUS)
export const isVerdictState = (s: unknown): s is VerdictState => typeof s === 'string' && STATES.has(s)
export const isVerdictMenu = (s: unknown): s is VerdictMenu => typeof s === 'string' && MENUS.has(s)
/** a verdict as the interface defines it (the two lists, p in 0–1, by jev | program); anything else a judge hands back is no verdict */
export function isVerdict(v: unknown): v is ScreenVerdict {
  const x = v as ScreenVerdict | null
  return !!x && typeof x === 'object' && isVerdictState(x.state) && isVerdictMenu(x.menu) && typeof x.p === 'number' && Number.isFinite(x.p) && x.p >= 0
    && x.p <= 1 && (x.by === 'jev' || x.by === 'program')
}
/** the four fields only (/healthz, the question bank) */
export const verdictFields = (v: ScreenVerdict): ScreenVerdict => ({ state: v.state, menu: v.menu, p: v.p, by: v.by })

// ------------------------------------------------------------------ 二 the replaceable piece: ScreenJudge, and the switch point
export interface ScreenJudge {
  /** its name as SCREEN_JUDGE names it */
  readonly name: string
  /** the verdict for this screen; null: it cannot tell this time (the record is statusOf's for this screen; asked about it again only by the 60 s
   *  re-ask). Rejected: the judging failed (asked once more after retryMs, never a third time) */
  judge(parts: Parts): Promise<ScreenVerdict | null>
  /** why it cannot judge now ('' or absent: it can) */
  ready?(): string
  /** not asked before this moment (ms; a pause after a 429) */
  notBefore?(): number
  /** its own counts, for /healthz */
  health?(): Record<string, unknown>
}
export const SCREEN_JUDGE_NAMES = ['jev', 'program'] as const
export type ScreenJudgeName = typeof SCREEN_JUDGE_NAMES[number]
/** SCREEN_JUDGE as a judge's name: jev (the default; also for a value that names no judge: `unknown` says which) or program */
export function screenJudgeName(v: string | null | undefined): { name: ScreenJudgeName; unknown?: string } {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s || s === 'jev') return { name: 'jev' }
  if (s === 'program') return { name: 'program' }
  return { name: 'jev', unknown: s }
}
/** the switch point. jev: JevJudge (screen-judge-jev.ts). program: the program judge, not written yet: null, and the record is statusOf's (judged_by
 *  program). Once it is written it is handed in as `program` here and nothing else changes */
export function judgeFor(name: ScreenJudgeName, judges: Partial<Record<ScreenJudgeName, ScreenJudge | null>>): ScreenJudge | null {
  return judges[name] ?? null
}

// ------------------------------------------------------------------ 三 the program's output: one status record from a verdict
const r2 = (x: number): number => Math.round(x * 100) / 100
/** statusOf's offline reasons that mean the process is gone (the OS says so): offline, the judge not asked */
export const GONE = new Set(['pid_gone', 'pid_reused'])
export const gone = (p: StatusView): boolean => p.state === 'offline' && GONE.has(String((p.detail as any)?.reason ?? ''))
const pick = (o: Record<string, unknown>, ks: string[]): Record<string, unknown> => Object.fromEntries(ks.filter(k => o[k] !== undefined).map(k => [k, o[k]]))
/** no verdict in use: statusOf's view, labelled */
export const programView = (p: StatusView): StatusView => ({ ...p, detail: { ...(p.detail ?? {}), judged_by: 'program' } })
/** the remaining-quota percentage stays out of the record (JCS screen-status/README.md) */
const noPct = (s: string): string => s.replace(/\d+(?:[.,]\d+)?\s*%/g, '#%')
/** what the program knows beside statusOf's view, for the record */
export type RecordFacts = {
  /** the main's pane runs Claude Code (the reader's last look); null: not looked at */
  alive?: boolean | null
}
/** the one status record, from a verdict (null: no verdict) and the program's facts: the regions' counts and statusOf's (the process, the usage wall,
 *  the turn's start and tool, stuck). The order is fixed (Chiron WO-169, 00:29Z): offline (the process is gone: statusOf's view) → starting (the
 *  process is there and not registered yet: statusOf's no_registration with Claude Code in the pane, or the verdict says starting) → usage limit (the
 *  verdict says so, or statusOf's wall) → waiting (a menu) → compacting → stuck (the verdict says working and statusOf counted the turn silent past
 *  its threshold: stuck stays, with the turn's start and tool) → busy → idle. No verdict: past offline and starting, statusOf's view as it is. The
 *  program's own detail stays: queued_joey, the wall, lane runs, the reason statusOf has for an offline the screen contradicts (a session this daemon
 *  has no stream with, one still registering). detail.judged_by = verdict.by (program: no verdict) and judge_p = verdict.p are labels: nothing
 *  downstream decides by them */
export function publishView(v: ScreenVerdict | null, st: Regions | null, prog: StatusView, f: RecordFacts = {}): StatusView {
  if (gone(prog)) return programView(prog)
  const pd = (prog.detail ?? {}) as Record<string, any>
  const registering = prog.state === 'offline' && pd.reason === 'no_registration' && (!!v || f.alive === true)
  const base = { ...pick(pd, ['queued_joey', 'walled', 'lanes']), ...(prog.state === 'offline' ? { program_offline: pd.reason ?? null } : {}) }
  if (!v || !st) {
    if (!registering) return programView(prog)
    return { state: 'starting', detail: { ...base, judged_by: 'program' }, last_activity_at: prog.last_activity_at ?? null }
  }
  const turn = prog.state === 'busy' || prog.state === 'stuck' || prog.state === 'waiting' ? pick(pd, ['turn_started_at', 'tool']) : {}
  const J = { judged_by: v.by, judge_p: r2(v.p) }
  const c = st.counted_by_program
  const out = (state: StatusView['state'], detail: Record<string, unknown>): StatusView => ({ state, detail: { ...detail, ...J }, last_activity_at: prog.last_activity_at ?? null })
  if (registering || v.state === 'starting') return out('starting', { ...base })
  if (v.state === 'usage_limit' || pd.walled) return out('walled', { ...base, walled: { until: pd.walled?.until ?? null, ...(pd.walled?.kind ? { kind: pd.walled.kind } : {}) } })
  if (v.state === 'waiting_for_human') {
    const text = st.has_input_box ? st.above_input_box ?? '' : st.screen_bottom ?? ''
    return out('waiting', { waitingFor: v.menu, ...(v.menu === 'other' ? { waiting_text: cut(noPct(redact(text)), 200) } : {}), ...turn, ...base })
  }
  if (v.state === 'compacting') return out('busy', { compacting: true, ...turn, ...base })
  if (v.state === 'working' && prog.state === 'stuck') return out('stuck', { threshold_s: pd.threshold_s ?? null, ...turn, subagents: c.running_agents, ...base })
  if (v.state === 'working') return out('busy', { ...turn, subagents: c.running_agents, ...base })
  if (v.state === 'idle_background_running') return out('idle', { background: { agents: c.running_agents, shells: c.shells, monitors: c.monitors, tasks: c.background_tasks }, ...base })
  if (v.state === 'interrupted') return out('idle', { interrupted: true, ...base })
  return out('idle', { ...base })
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
export interface ScreenDeps {
  agent: string
  /** <workspace>/.lanes: run/screen-verdicts.jsonl (the question bank) */
  lanesDir: string
  /** the JEV_SCREEN switch for this agent, now: the screen is read at all */
  switchOn(): boolean
  /** the judge SCREEN_JUDGE picks now (judgeFor); null: none, the record is statusOf's (judged_by program) */
  judge(): ScreenJudge | null
  /** SCREEN_JUDGE as it reads now (the log only) */
  judgeSetting?(): string
  snap(): Promise<{ cmd: string; pane: string } | null>
  /** the pane's foreground command is Claude Code */
  isClaude(cmd: string): boolean
  /** statusOf's view now (the program's side) */
  program(): StatusView
  /** the record this reader gives may have changed: report again (statusOf computed, view() applied) */
  publish(): void
  log(level: 'info' | 'warn', msg: string): void
  now?(): number
  random?(): number
}
export interface ScreenOpts {
  pollMs: number; maxPerMin: number; pokeMs: number[]; retryMs: number; activeCheckMs: number
  /** the first look after start: at a random moment within this (a fleet that restarts together does not ask together) */
  firstJitterMs: number
  /** a screen seen again within this (a notice that comes and goes, a flicker between two screens) takes its earlier verdict: not asked again */
  cacheMs: number
  /** Chiron 19:23Z: this long after the last ask, any change of the screen's text (not only of its hash) is asked again, cache or not (a change the
   *  hash does not see is caught within a minute) */
  refreshMs: number
}
export const SCREEN_DEFAULTS: ScreenOpts = { pollMs: 1000, maxPerMin: 20, pokeMs: [40, 450], retryMs: 10_000, activeCheckMs: 10_000, firstJitterMs: 5000,
  cacheMs: 10 * 60_000, refreshMs: 60_000 }
const CACHE_MAX = 16
/** the question bank's file is rotated past this; at start (and at a new day) its last BANK_TAIL bytes are read for the day's hashes */
const BANK_MAX = 20 * 1024 * 1024, BANK_TAIL = 8 * 1024 * 1024
type Cur = { hash: string; raw: string; parts: Parts; cmd: string; alive: boolean; at: number }
type Ans = { hash: string; at: number; v: ScreenVerdict | null; parts: Parts; seq: number }
const iso = (ms: number): string => new Date(ms).toISOString()

export class ScreenStatus {
  readonly o: ScreenOpts
  private cur: Cur | null = null
  private answer: Ans | null = null
  private cache = new Map<string, Ans>()
  private inflight: { hash: string; at: number } | null = null
  /** the last call: when, and the screen's text then (the 60 s re-ask) */
  private lastAsk: { at: number; raw: string } | null = null
  private failed: { hash: string; tries: number; at: number } | null = null
  private calls: number[] = []
  private capTold = 0
  private notVerdictTold = 0
  private looking = false
  private lastLookAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private pokes = new Set<number>()
  private progKey: string | null = null
  /** listed: JEV_SCREEN lists the agent; judge: the one SCREEN_JUDGE picks; on: listed, a judge, and it is ready */
  private act: { on: boolean; listed: boolean; judge: ScreenJudge | null; at: number; why: string } = { on: false, listed: false, judge: null, at: -Infinity, why: 'not checked' }
  private seq = 0
  /** the question bank: the hashes written today (UTC) */
  private bank: { day: string; hashes: Set<string> } | null = null
  /** judged_jev / judged_program: the records handed out (view(p, true)) with a Jev verdict in them / statusOf's */
  readonly stats = { looks: 0, changes: 0, calls: 0, refreshes: 0, cache_hits: 0, failed: 0, capped: 0, not_verdict: 0, judged_jev: 0, judged_program: 0, banked: 0 }
  constructor(readonly d: ScreenDeps, o: Partial<ScreenOpts> = {}) { this.o = { ...SCREEN_DEFAULTS, ...o } }
  private now(): number { return (this.d.now ?? Date.now)() }

  // ---- on / off
  /** the switch, the judge and its readiness, checked at most every activeCheckMs; a change is logged once. A new judge starts from nothing (the
   *  verdicts held were the other one's) */
  active(): boolean {
    const now = this.now()
    if (now - this.act.at < this.o.activeCheckMs) return this.act.on
    const listed = this.d.switchOn()
    const judge = listed ? this.d.judge() : null
    const why = !listed ? 'JEV_SCREEN does not list this agent' : !judge ? `SCREEN_JUDGE=${this.d.judgeSetting?.() || 'program'}: no screen judge` : judge.ready?.() ?? ''
    const on = !why
    if (on !== this.act.on || why !== this.act.why || judge !== this.act.judge) {
      this.d.log('info', on ? `screen-status: ON for ${this.d.agent} (judge ${judge!.name}; poll ${this.o.pollMs} ms)`
        : `screen-status: off for ${this.d.agent} (${why}): the status is statusOf's${listed ? ' (judged_by program)' : ', unchanged'}`)
      if (!on || judge !== this.act.judge) { this.answer = null; this.cur = null; this.failed = null; this.cache.clear() }
    }
    this.act = { on, listed, judge, at: now, why }
    return on
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
    this.cur = { hash, raw: rawHash(parts), parts, cmd, alive, at: now }
    if (!prev || prev.hash !== hash || prev.alive !== alive) {
      this.stats.changes++
      this.maybeAsk()
      this.d.publish()
    } else this.maybeAsk()
  }

  // ---- asking the judge
  private maybeAsk(): void {
    const c = this.cur, j = this.act.judge
    if (!c || this.inflight || !j || !this.act.on) return
    const now = this.now()
    const refresh = !!this.lastAsk && now - this.lastAsk.at >= this.o.refreshMs && this.lastAsk.raw !== c.raw
    if (!refresh && this.answer?.hash === c.hash) return
    if (!c.alive) return                                      // Claude Code is not the pane's program: not asked
    if (!refresh) {
      const hit = this.cache.get(c.hash)
      if (hit && now - hit.at < this.o.cacheMs) { this.stats.cache_hits++; this.answer = hit; this.d.publish(); return }
    }
    if (now < (j.notBefore?.() ?? 0)) return
    if (!refresh && this.failed?.hash === c.hash && (this.failed.tries >= 2 || now - this.failed.at < this.o.retryMs)) return
    if (gone(this.d.program())) return                        // the process is gone (the OS says so): offline, not asked
    this.calls = this.calls.filter(t => now - t < 60_000)
    if (this.calls.length >= this.o.maxPerMin) {
      this.stats.capped++
      if (now - this.capTold >= 60_000) { this.capTold = now; this.d.log('warn', `screen-status: ${this.o.maxPerMin} judge calls in the last minute: not asked until the minute frees (statusOf meanwhile)`) }
      return
    }
    if (j.ready?.()) return                                   // its own readiness, now (its file may have gone since active() looked)
    this.calls.push(now)
    if (refresh) this.stats.refreshes++
    this.lastAsk = { at: now, raw: c.raw }
    this.inflight = { hash: c.hash, at: now }
    void this.ask(c, j)
  }
  private async ask(c: Cur, j: ScreenJudge): Promise<void> {
    let v: ScreenVerdict | null = null, failed = false
    try {
      const r = await j.judge(c.parts)
      if (r != null && !isVerdict(r)) {
        this.stats.not_verdict++
        if (this.now() - this.notVerdictTold >= 3600_000) { this.notVerdictTold = this.now(); this.d.log('warn', `screen-status: judge ${j.name} answered something that is not a ScreenVerdict (${JSON.stringify(r).slice(0, 200)}): no verdict`) }
      } else v = r
    } catch { failed = true }
    this.inflight = null
    this.stats.calls++
    if (j !== this.act.judge) { this.maybeAsk(); return }      // SCREEN_JUDGE changed while it judged: that answer is not the new judge's
    if (failed) {
      this.stats.failed++
      this.failed = { hash: c.hash, tries: this.failed?.hash === c.hash ? this.failed.tries + 1 : 1, at: this.now() }
      this.d.publish()
      this.maybeAsk()
      return
    }
    this.failed = null
    const a: Ans = { hash: c.hash, at: this.now(), v, parts: c.parts, seq: ++this.seq }
    this.answer = a
    this.cache.delete(a.hash); this.cache.set(a.hash, a)
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
    if (v) this.bankIt(c, v)
    this.d.publish()
    if (this.cur && this.cur.hash !== c.hash) this.maybeAsk()                           // the screen moved on while it was judged: ask once more
  }

  // ---- what is published
  /** the record for statusOf's view `p` now: `p` untouched when JEV_SCREEN does not list this agent; the verdict's record (publishView) when the screen
   *  showing now has one (while a newer screen is being judged, the last verdict stands); else statusOf's view, judged_by program. `fed`: this is the
   *  one handed out (counted) */
  view(p: StatusView, fed = false): StatusView {
    if (!this.act.listed) return p
    const c = this.cur, a = this.answer
    const ok = this.act.on && !!c && c.alive && !gone(p) && !!a?.v && (a.hash === c.hash || !!this.inflight)
    if (fed) { if (ok && a!.v!.by === 'jev') this.stats.judged_jev++; else this.stats.judged_program++ }
    return ok ? publishView(a!.v!, a!.parts.st, p) : publishView(null, null, p, { alive: this.act.on && c ? c.alive : null })
  }
  /** the screen with this hash is still the one showing and this verdict is the one in use for it (a judge's own check, a moment later) */
  holds(hash: string, v: ScreenVerdict): boolean { return this.cur?.hash === hash && this.answer?.hash === hash && this.answer.v === v }
  /** for /healthz: the reader, its judge's own counts, the screen now, the verdict in use (ScreenVerdict's four fields) */
  health(): Record<string, unknown> {
    const j = this.act.judge, a = this.answer
    return { on: this.act.on, ...(this.act.on ? {} : { why: this.act.why }), judge: j?.name ?? null, poll_ms: this.o.pollMs, ...this.stats, ...(j?.health?.() ?? {}),
      screen: this.cur ? { hash: this.cur.hash, alive: this.cur.alive, at: iso(this.cur.at) } : null,
      answer: a?.v ? verdictFields(a.v) : null, answered: a ? { hash: a.hash, at: iso(a.at), verdict: !!a.v } : null, in_flight: !!this.inflight }
  }

  // ---- 五 the question bank
  /** a screen hash's first verdict of the day (UTC): one line of run/screen-verdicts.jsonl, its regions masked as the exception log masks them. The day's
   *  hashes are read back from the file's tail at start and when the day turns, so a restart does not write a screen twice */
  private bankIt(c: Cur, v: ScreenVerdict): void {
    const now = this.now(), day = iso(now).slice(0, 10)
    const f = join(this.d.lanesDir, 'run', 'screen-verdicts.jsonl')
    if (!this.bank || this.bank.day !== day) this.bank = { day, hashes: bankedOn(f, day) }
    if (this.bank.hashes.has(c.hash)) return
    this.bank.hashes.add(c.hash)
    const st = redactRegions(c.parts.st)
    const rec = { ts: iso(now), agent: this.d.agent, hash: c.hash, has_input_box: st.has_input_box, screen: screenRegions(st),
      counted_by_program: st.counted_by_program, found_by_program: st.found_by_program, verdict: verdictFields(v) }
    try {
      mkdirSync(join(this.d.lanesDir, 'run'), { recursive: true })
      try { if (statSync(f).size > BANK_MAX) renameSync(f, `${f}.1`) } catch {}
      appendFileSync(f, JSON.stringify(rec) + '\n')
      this.stats.banked++
    } catch {}
  }
}
/** the hashes the question bank already has for `day` (its file's last BANK_TAIL bytes; every line starts with its ts) */
function bankedOn(f: string, day: string): Set<string> {
  const out = new Set<string>()
  let text = ''
  let fd: number | null = null
  try {
    const size = statSync(f).size, n = Math.min(size, BANK_TAIL)
    const buf = Buffer.alloc(n)
    fd = openSync(f, 'r')
    readSync(fd, buf, 0, n, size - n)
    text = buf.toString('utf8')
  } catch { return out } finally { if (fd != null) try { closeSync(fd) } catch {} }
  const head = `{"ts":"${day}`
  for (const l of text.split('\n')) {
    if (!l.startsWith(head)) continue
    try { const h = JSON.parse(l).hash; if (typeof h === 'string') out.add(h) } catch {}
  }
  return out
}
/** the screen text that goes to Jev and into the logs: tokens, keys and e-mail addresses hidden (the duty officer's redact) */
export function redactRegions(st: Regions): Regions {
  const o: Regions = { ...st, found_by_program: { ...st.found_by_program, live_activity_line: st.found_by_program.live_activity_line == null ? null : redact(st.found_by_program.live_activity_line) } }
  for (const k of ['above_input_box', 'input_box', 'below_input_box', 'screen_bottom'] as const) if (typeof o[k] === 'string') o[k] = redact(o[k] as string)
  return o
}
/** the three regions (or, with no input box, the bottom of the screen) as the logs keep them */
export function screenRegions(st: Regions): Record<string, string | undefined> {
  return st.has_input_box ? { above_input_box: st.above_input_box, input_box: st.input_box, below_input_box: st.below_input_box } : { screen_bottom: st.screen_bottom }
}
export function lastLines(st: Regions, n: number): string {
  const t = st.has_input_box ? st.above_input_box ?? '' : st.screen_bottom ?? ''
  return t.split('\n').slice(-n).join('\n')
}
