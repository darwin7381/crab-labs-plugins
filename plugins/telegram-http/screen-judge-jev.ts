// screen-judge-jev.ts — WO-169: the judging step of screen-status.ts as Jev does it now (WO-165 A, Joey TG chiron:2485). JevJudge is one ScreenJudge:
// it asks Jev Chiron's questions (JCS screen-status/questions.json: state, fits_any, menu) about the screen's three regions and the program's facts, and
// the program collects Jev's answer into a ScreenVerdict: the menu rule, the publish threshold, an option this program does not map → null. Jev's own
// shapes (its option strings, probabilities, fits_any: JevRead) live only in this file and in its logs; nothing past judge() sees them (Joey TG
// chiron:2547: 「他後面還是要根據他的輸出選項結果再經過一個程式輸出…之後…只是把Jev那段換回程式／但輸出和接口都不…被影響」).
//
//   ask        one call with the three questions; JEV_SCREEN_TIMEOUT_MS (3 s); a 30–60 s pause after 429 / 529 (notBefore); a failed call rejects (the
//              reader asks once more after its retryMs)
//   logs       run/jev-calls.jsonl (every call, Jev's raw answers and usage); run/screen-questions-<sha>.json (each version asked);
//              run/screen-exceptions.jsonl: other, p below the threshold, fits_any < 0.5, the menu rule overrode a confident state, background counts
//              disagree, waiting with no menu, an option not mapped, the call failed, a verdict the program's facts contradict (WO-177 二:
//              contradicts_program, no verdict), and (settleMs later, the screen still showing) the record differs from statusOf's
//   version    the questions file's sha (WO-177 五): a new one is a new judge to the reader (its answers dropped, the screen asked again)
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StatusView } from './onsen-status.ts'
import { cut, isVerdictMenu, isVerdictState, lastLines, publishView, redactRegions, screenHash, screenRegions, type Parts, type Regions, type ScreenJudge,
  type ScreenVerdict } from './screen-status.ts'

// ------------------------------------------------------------------ Chiron's questions file
export const QUESTIONS_PATH_DEFAULT = (home: string): string => join(home, 'Development', 'Joey-Crablabs-Skills', 'screen-status', 'questions.json')
export type Questions = { questions: Record<string, any>; setting: string | null; model: string | null; threshold: number; version: unknown; sha: string
  path: string
  /** v2 (Chiron 18:40Z): `menu` not none with at least this probability → the state is `state` whatever the state question said (both from the file) */
  menuRule: { threshold: number; state: string } | null }
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
    threshold: Number.isFinite(thr) && thr > 0 && thr <= 1 ? thr : 0.6, version: j.version ?? null, sha: createHash('sha256').update(text).digest('hex').slice(0, 12), path,
    menuRule: (() => { const t = Number(j.if_menu_is_not_none_with_probability_at_least)
      return Number.isFinite(t) && t > 0 && t <= 1 && typeof j.then_state === 'string' && j.then_state ? { threshold: t, state: j.then_state } : null })() }
}

// ------------------------------------------------------------------ Jev's answer, and the program's collection of it into a ScreenVerdict
export type JevRead = { state: string | null; p: number; conf: number | null; probs: Record<string, number> | null; fits_any: number | null
  menu: string | null; menu_p: number | null; menu_probs: Record<string, number> | null
  /** decide(): the menu rule set the state; the state question's own answer and probability */
  by_menu?: { state: string | null; p: number } }
const num = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) ? x : null
const r2 = (x: number): number => Math.round(x * 100) / 100
export function readAnswers(a: Record<string, any>): JevRead {
  const s = a?.state ?? {}, m = a?.menu ?? {}
  const probs = s.probabilities && typeof s.probabilities === 'object' ? s.probabilities : null
  const mprobs = m.probabilities && typeof m.probabilities === 'object' ? m.probabilities : null
  const state = typeof s.choice === 'string' ? s.choice : null, menu = typeof m.choice === 'string' ? m.choice : null
  return { state, p: num(probs?.[state ?? '']) ?? 0, conf: num(s.confidence), probs, fits_any: num(a?.fits_any?.noul),
    menu, menu_p: menu ? num(mprobs?.[menu]) : null, menu_probs: mprobs }
}
/** the state that counts: the state question's answer, or, when the file's menu rule applies (a menu other than none with p ≥ its threshold), the
 *  rule's state with the menu's probability (by_menu keeps what the state question said) */
export function decide(j: JevRead, q: Pick<Questions, 'menuRule'>): JevRead {
  const r = q.menuRule
  if (!r || !j.menu || j.menu === 'none' || j.menu_p == null || j.menu_p < r.threshold || j.state === r.state) return j
  return { ...j, state: r.state, p: j.menu_p, by_menu: { state: j.state, p: j.p } }
}
/** the program's collection of Jev's reading (after decide()) into the fixed output: the state and the menu must be options of the two lists
 *  (screen-status.ts VERDICT_STATES / VERDICT_MENUS) and the state's p at least the file's threshold; anything else is no verdict (null). No menu answer:
 *  'other' for a waiting state (the menu could not be named), else 'none' */
export function verdictOf(j: JevRead, threshold: number): ScreenVerdict | null {
  if (!isVerdictState(j.state) || !(j.p >= threshold) || j.p > 1) return null
  const menu = j.menu ?? (j.state === 'waiting_for_human' ? 'other' : 'none')
  if (!isVerdictMenu(menu)) return null
  return { state: j.state, menu, p: j.p, by: 'jev' }
}
/** WO-177 二 (Chiron's ticket): a verdict the record would hold the main's items on must agree with the program's own facts, here, where Jev's answer
 *  becomes a ScreenVerdict, and nowhere else. waiting_for_human: no input box (a menu or a permission prompt replaces it: 64 screens of the question bank
 *  and the lab's 21 waiting rows have none; idle, working and interrupted all have one); usage_limit: the limit message is the latest output, or the
 *  program's own wall (a StopFailure that walled M2, usage_wall.py: statusOf's detail.walled); interrupted: Interrupted is the latest output. The facts are
 *  found_by_program's (questions v7, regions()). Returns the fact the verdict lacks (null: they agree, or a state these facts do not bear on) */
export function contradiction(v: Pick<ScreenVerdict, 'state'>, st: Regions, prog: StatusView | null): string | null {
  const f = st.found_by_program
  if (v.state === 'waiting_for_human' && st.has_input_box !== false) return 'has_input_box === false'
  if (v.state === 'usage_limit' && f.limit_message_is_latest_output !== true && !(prog?.detail as Record<string, unknown> | undefined)?.walled)
    return 'limit_message_is_latest_output === true, or the program\'s wall'
  if (v.state === 'interrupted' && f.interrupted_is_latest_output !== true) return 'interrupted_is_latest_output === true'
  return null
}
/** the exceptions an answer shows by itself (the comparison with statusOf is made settleMs later, once the screen held) */
export function answerExceptions(j: JevRead, st: Regions, threshold: number): string[] {
  const k: string[] = []
  if (j.state === 'other' || j.by_menu?.state === 'other') k.push('state_other')
  if (j.menu === 'other') k.push('menu_other')
  if (j.state && !isVerdictState(j.state) && j.state !== 'other') k.push(`state_unmapped:${j.state}`)
  if (j.menu && !isVerdictMenu(j.menu)) k.push(`menu_unmapped:${j.menu}`)
  if (j.p < threshold) k.push('state_p_low')
  if (j.fits_any == null || j.fits_any < 0.5) k.push('fits_any_low')
  if (j.by_menu && j.by_menu.p >= threshold) k.push(`menu_overrode_state:${j.by_menu.state}`)
  const c = st.counted_by_program, bg = c.running_agents + c.shells + c.monitors + c.background_tasks
  if (j.state === 'idle_background_running' && bg === 0) k.push('jev_background_program_none')
  if (j.state === 'idle' && bg > 0) k.push('program_background_jev_idle')
  if (j.state === 'waiting_for_human' && (j.menu === 'none' || j.menu == null)) k.push('waiting_menu_none')
  return k
}

// ------------------------------------------------------------------ JevJudge
export type JevAnswer = { answers?: Record<string, any>; error?: string; ms: number; usage?: Record<string, unknown> | null; model?: string | null }
export interface JevJudgeDeps {
  agent: string
  /** <workspace>/.lanes: run/jev-calls.jsonl (every call), run/screen-exceptions.jsonl, run/screen-questions-<sha>.json (each version asked) */
  lanesDir: string
  /** the agent's TypeSafe key is there (never its value) */
  hasKey(): boolean
  questionsPath: string
  ask(state: Record<string, unknown>, questions: Record<string, unknown>, timeoutMs: number, model: string | null): Promise<JevAnswer>
  /** one record for run/jev-calls.jsonl */
  logCall(rec: { site: string; question: unknown; inputs: unknown; answer: unknown; p: number | null; ms: number; err: string | null; usage?: unknown; model?: unknown }): void
  log(level: 'info' | 'warn', msg: string): void
  /** statusOf's view now (the side every verdict is compared with) */
  program(): StatusView
  /** the record the reader hands out now for statusOf's view `p` (the exception line's `published`) */
  published(p: StatusView): StatusView
  /** the screen with this hash still shows and this verdict is the one in use for it (the comparison, settleMs later) */
  holds(hash: string, v: ScreenVerdict): boolean
  now?(): number
  random?(): number
}
export interface JevJudgeOpts { timeoutMs: number; settleMs: number; backoffMs: number; exceptionsPerHour: number }
export const JEV_JUDGE_DEFAULTS: JevJudgeOpts = { timeoutMs: 3000, settleMs: 1500, backoffMs: 30_000, exceptionsPerHour: 120 }
export const SITE = 'screen-status'

export class JevJudge implements ScreenJudge {
  readonly name = 'jev'
  readonly o: JevJudgeOpts
  private q: { m: number; size: number; v: Questions | null } | null = null
  private qWritten = new Set<string>()
  private excAt: number[] = []
  private backoffUntil = 0
  readonly stats = { exceptions: 0 }
  constructor(readonly d: JevJudgeDeps, o: Partial<JevJudgeOpts> = {}) { this.o = { ...JEV_JUDGE_DEFAULTS, ...o } }
  private now(): number { return (this.d.now ?? Date.now)() }

  /** the key and Chiron's questions file */
  ready(): string {
    return !this.d.hasKey() ? 'no TypeSafe key (.secrets/typesafe.env)' : !this.questions() ? `no readable questions file (${this.d.questionsPath})` : ''
  }
  notBefore(): number { return this.backoffUntil }
  /** WO-177 五: what it judges by: the questions file's sha (null: no readable file) */
  version(): string | null { return this.questions()?.sha ?? null }
  health(): Record<string, unknown> {
    const q = this.q?.v
    return { exceptions: this.stats.exceptions, questions: q ? { version: q.version, sha: q.sha } : null,
      ...(this.backoffUntil > this.now() ? { paused_until: new Date(this.backoffUntil).toISOString() } : {}) }
  }
  /** Chiron's file, re-read when its mtime or size changes */
  questions(): Questions | null {
    let st: { mtimeMs: number; size: number }
    try { st = statSync(this.d.questionsPath) } catch { this.q = null; return null }
    if (this.q && this.q.m === st.mtimeMs && this.q.size === st.size) return this.q.v
    let v: Questions | null = null
    try { v = parseQuestions(readFileSync(this.d.questionsPath, 'utf8'), this.d.questionsPath) } catch {}
    if (!v) this.d.log('warn', `screen-status: ${this.d.questionsPath} is not in the expected shape (questions.state / fits_any / menu): not asked`)
    else if (this.q?.v?.sha !== v.sha) this.d.log('info', `screen-status: Jev's questions ${this.d.questionsPath} (version ${String(v.version)}, sha ${v.sha})`)
    this.q = { m: st.mtimeMs, size: st.size, v }
    return v
  }

  /** ask Jev about this screen, and collect its answer into a ScreenVerdict (null: no verdict). A failed call rejects */
  async judge(parts: Parts): Promise<ScreenVerdict | null> {
    const q = this.questions()
    if (!q) return null
    const st = redactRegions(parts.st), hash = screenHash(parts)
    const state: Record<string, unknown> = { ...(q.setting ? { setting: q.setting } : {}), ...st, claude_process_alive: true }
    let r: JevAnswer
    try { r = await this.d.ask(state, q.questions, this.o.timeoutMs, q.model) } catch (e: any) { r = { error: `${e?.name ?? 'Error'}: ${e?.message ?? e}`.slice(0, 200), ms: 0 } }
    this.writeQuestions(q)
    const jev = r.answers ? decide(readAnswers(r.answers), q) : null
    try {
      this.d.logCall({ site: SITE, question: { file: q.path, version: q.version, sha: q.sha, copy: `run/screen-questions-${q.sha}.json` },
        inputs: { agent: this.d.agent, hash, has_input_box: parts.st.has_input_box, counted_by_program: parts.st.counted_by_program,
          found_by_program: st.found_by_program, tail: cut(lastLines(st, 4), 400) },
        answer: r.answers ?? null, p: jev ? r2(jev.p) : null, ms: r.ms, err: r.error ?? null, usage: r.usage ?? null, model: r.model ?? q.model })
    } catch {}
    if (r.error || !r.answers || !jev) {
      if (/HTTP (429|529)/.test(String(r.error ?? ''))) this.backoffUntil = this.now() + this.o.backoffMs * (1 + (this.d.random ?? Math.random)())   // jittered: the fleet does not come back together
      this.exception(['call_failed'], parts, st, null, q, { error: r.error ?? 'no answers', ms: r.ms })
      throw new Error(`Jev: ${r.error ?? 'no answers'}`)
    }
    let v = verdictOf(jev, q.threshold)
    const kinds = answerExceptions(jev, parts.st, q.threshold)
    const model = r.model ?? q.model
    // WO-177 二: a verdict the program's facts contradict is no verdict (the record is statusOf's for this screen), recorded as contradicts_program
    const against = v ? contradiction(v, parts.st, this.d.program()) : null
    const contra = against ? { state: v!.state, menu: v!.menu, p: r2(v!.p), needs: against } : null
    if (contra) { kinds.push('contradicts_program'); v = null }
    // the comparison with statusOf: settleMs later, and only if the screen held (the registry and the screen move within ~0.5 s of each other;
    // comparing at once would write every turn's edge as a disagreement)
    const t = setTimeout(() => {
      const k = [...kinds]
      const prog = this.d.program()
      if (v && this.d.holds(hash, v) && publishView(v, parts.st, prog).state !== prog.state) k.push('differs_from_program')
      if (k.length) this.exception(k, parts, st, jev, q, { ms: r.ms, model, ...(contra ? { contradicts: contra } : {}) }, prog)
    }, this.o.settleMs)
    ;(t as any).unref?.()
    return v
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
    const rec = { ts: new Date(now).toISOString(), agent: this.d.agent, kinds, has_input_box: st.has_input_box, screen: screenRegions(st), counted_by_program: st.counted_by_program,
      found_by_program: st.found_by_program,
      jev: jev ? { state: jev.state, state_p: r2(jev.p), state_confidence: jev.conf, state_probabilities: jev.probs, fits_any: jev.fits_any, menu: jev.menu,
        menu_p: jev.menu_p, menu_probabilities: jev.menu_probs, ...(jev.by_menu ? { set_by_menu_rule: true, state_question: jev.by_menu } : {}), ...call } : { ...call },
      program: { state: program.state, detail: program.detail ?? null },
      published: (() => { try { const v = this.d.published(program); return { state: v.state, judged_by: v.detail?.judged_by ?? null } } catch { return null } })(),
      hash: screenHash(parts), questions: { version: q.version, sha: q.sha } }
    const f = join(this.d.lanesDir, 'run', 'screen-exceptions.jsonl')
    try {
      mkdirSync(join(this.d.lanesDir, 'run'), { recursive: true })
      try { if (statSync(f).size > 20 * 1024 * 1024) renameSync(f, `${f}.1`) } catch {}
      appendFileSync(f, JSON.stringify(rec) + '\n')
    } catch {}
  }
}
