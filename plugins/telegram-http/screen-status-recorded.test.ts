// WO-169: the downstream proved on REAL screens and REAL Jev answers recorded on this machine (skipped where they are not; this repo is public, no
// recorded text is in it). Jev is down since 2026-11-26 00:07Z, so the live path is the null one; this is the check that what Jev answered before,
// collected by JevJudge, gives through the fixed interface exactly the record a fake judge with the same verdict gives, and an observation that passes
// the contract's Status rules.
//   - Chiron's 55 labelled screens (claude-chiron/knowledge/tg-dialogue/screen-eval + labels.json): the label as the verdict
//   - every exception line with Jev's answers in this machine's agents' run/screen-exceptions.jsonl (their screen, Jev's answer, statusOf's view then)
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreenStatus, isVerdictMenu, isVerdictState, regionParts, type ScreenJudge, type ScreenVerdict } from './screen-status.ts'
import { JevJudge, type JevAnswer } from './screen-judge-jev.ts'
import type { StatusView } from './onsen-status.ts'
import { checkObservation } from './test-fixtures/status-v1-check.ts'

const EVAL = join(homedir(), 'cc-workspaces', 'claude-chiron', 'knowledge', 'tg-dialogue', 'screen-eval')
const JCS = join(homedir(), 'Development', 'Joey-Crablabs-Skills', 'screen-status', 'questions.json')
const RULE = '─'.repeat(80)
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
/** two readers over the same screen: one with a fake judge that answers `v`, one with JevJudge whose (fake) Jev answers `answers` */
async function pair(pane: string, prog: StatusView, v: ScreenVerdict | null, answers: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'wo169-rec-'))
  const qp = join(dir, 'q.json')
  writeFileSync(qp, existsSync(JCS) ? readFileSync(JCS, 'utf8') : JSON.stringify({ version: 0, publish_when_state_probability_at_least: 0.6, if_menu_is_not_none_with_probability_at_least: 0.6,
    then_state: 'waiting_for_human', questions: { state: { type: 'choice', criteria: { idle: 'x' } }, menu: { type: 'choice', criteria: { none: 'x' } }, fits_any: { type: 'noul' } } }))
  const mk = (judge: () => ScreenJudge | null) => new ScreenStatus({ agent: 'rec', lanesDir: dir, switchOn: () => true, judge, snap: async () => null, isClaude: () => true,
    program: () => prog, publish: () => {}, log: () => {} }, { activeCheckMs: 0 })
  const fake: ScreenJudge = { name: 'fake', judge: async () => v ? { ...v } : null }
  const a = mk(() => fake)
  const ref: { s?: ScreenStatus } = {}
  const jj = new JevJudge({ agent: 'rec', lanesDir: dir, hasKey: () => true, questionsPath: qp, ask: async (): Promise<JevAnswer> => ({ answers, ms: 1 }), logCall: () => {}, log: () => {},
    program: () => prog, published: p => ref.s!.view(p), holds: (h, x) => ref.s!.holds(h, x) }, { settleMs: 1 })
  const b = mk(() => jj); ref.s = b
  a.active(); b.active()
  a.sample(pane, 'claude'); b.sample(pane, 'claude')
  await wait(3)
  const f = { now: Date.parse('2026-11-26T01:00:00.000Z'), session_id: 's', queue: { pending: 0, unread_by_member: 0 },
    turn: prog.detail?.turn_started_at ? { id: 'p', started_at: String(prog.detail.turn_started_at), trigger: { kind: 'other' as const } } : null }
  return { a: a.record(prog, f), b: b.record(prog, f), answer: b.health().answer }
}
const answersFor = (state: string, menu: string, p = 0.9) => ({ state: { type: 'choice', choice: state, confidence: p, probabilities: { [state]: p } }, fits_any: { type: 'noul', noul: 0.9 },
  menu: { type: 'choice', choice: menu, probabilities: { [menu]: menu === 'none' ? 0.9 : 0.9 } } })

describe('real screens and real answers through the fixed interface', () => {
  test.skipIf(!existsSync(join(EVAL, 'labels.json')))("Chiron's labelled screens: the label as Jev's answer and as a fake judge's verdict: the same record and observation; the observation passes", async () => {
    const labels = JSON.parse(readFileSync(join(EVAL, 'labels.json'), 'utf8')) as Record<string, { state: string; menu?: string }>
    let n = 0, none = 0
    for (const [file, l] of Object.entries(labels)) {
      if (!existsSync(join(EVAL, file))) continue
      const pane = readFileSync(join(EVAL, file), 'utf8')
      const menu = l.menu ?? (l.state === 'waiting_for_human' ? 'other' : 'none')
      const v: ScreenVerdict | null = isVerdictState(l.state) && isVerdictMenu(menu) ? { state: l.state, menu, p: 0.9, by: 'jev' } : null
      const prog: StatusView = { state: l.state === 'working' ? 'busy' : 'idle', detail: { queued_joey: 0, ...(l.state === 'working' ? { turn_started_at: '2026-11-26T00:59:00.000Z', tool: null, subagents: 0 } : {}) }, last_activity_at: null }
      const r = await pair(pane, prog, v, answersFor(l.state, menu))
      expect({ file, view: r.b.view, obs: r.b.observation }).toEqual({ file, view: r.a.view, obs: r.a.observation })
      expect({ file, bad: checkObservation(r.b.observation) }).toEqual({ file, bad: [] })
      if (v) expect({ file, answer: r.answer }).toEqual({ file, answer: v }); else { none++; expect(r.b.view.detail?.judged_by).toBe('program') }
      n++
    }
    console.log(`labelled real screens: ${n} (no verdict: ${none})`)
    expect(n).toBeGreaterThan(40)
  })

  const files = [join(homedir(), '.claude', 'workspace-telegram', '.lanes', 'run', 'screen-exceptions.jsonl'),
    ...(existsSync(join(homedir(), 'cc-workspaces')) ? readdirSync(join(homedir(), 'cc-workspaces')).map(d => join(homedir(), 'cc-workspaces', d, '.lanes', 'run', 'screen-exceptions.jsonl')) : [])].filter(f => existsSync(f))
  test.skipIf(!files.length)("this machine's recorded exceptions with Jev's answers: JevJudge's verdict through the reader = a fake judge's with that verdict; observations pass", async () => {
    let n = 0
    const got: Record<string, number> = {}
    for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
      let j: any
      try { j = JSON.parse(line) } catch { continue }
      const jv = j?.jev
      if (!jv?.state || !jv.state_probabilities || !j.screen) continue
      const sc = j.screen
      const pane = j.has_input_box ? [sc.above_input_box ?? '', RULE, sc.input_box ?? '', RULE, sc.below_input_box ?? ''].join('\n') : String(sc.screen_bottom ?? '')
      const answers = { state: { type: 'choice', choice: jv.state_question?.state ?? jv.state, probabilities: jv.state_question ? { [jv.state_question.state]: jv.state_question.p } : jv.state_probabilities },
        fits_any: { type: 'noul', noul: jv.fits_any }, menu: { type: 'choice', choice: jv.menu, probabilities: jv.menu_probabilities ?? {} } }
      const prog: StatusView = { state: j.program?.state ?? 'idle', detail: j.program?.detail ?? {}, last_activity_at: null }
      // JevJudge's collection, then the same verdict from a fake judge
      const probe = await pair(pane, prog, null, answers)
      const v = probe.answer as ScreenVerdict | null
      const r = await pair(pane, prog, v, answers)
      expect({ line: n, view: r.b.view, obs: r.b.observation }).toEqual({ line: n, view: r.a.view, obs: r.a.observation })
      expect({ line: n, bad: checkObservation(r.b.observation) }).toEqual({ line: n, bad: [] })
      const k = v ? `${v.state}/${v.menu}` : 'no verdict'
      got[k] = (got[k] ?? 0) + 1
      n++
    }
    console.log(`recorded Jev answers: ${n}`, JSON.stringify(got))
    expect(n).toBeGreaterThan(0)
  }, 60000)
})
