// WO-169 (Joey TG chiron:2547 / 2520; Chiron's ticket): the judging step is a ScreenJudge whose output is a fixed ScreenVerdict; a program composes the one
// status record from it; that record goes everywhere. Synthetic screens only (this repo is public).
//   1  JevRead lives only in screen-judge-jev.ts; publishView takes a ScreenVerdict. A fake ScreenJudge through the whole path (the reader, the record,
//      the report Onsen gets): when JevJudge returns the same verdict, every record is the same field by field; the downstream readers (decideWake's
//      member, the 此刻 line) cannot tell who judged
//   2  the composition order (offline → usage limit → waiting → compacting → stuck → busy → idle): stuck is not overwritten by working
//   3  the interface holds: an option outside the two lists, a p outside 0–1 is no verdict; the switch (SCREEN_JUDGE): jev | program (no judge yet)
//   4  /healthz: the verdict as its four fields; StatusFacts.current() is the record Onsen holds (state, since, at, detail, last_activity_at)
//   5  run/screen-verdicts.jsonl: one line per new screen hash per day, masked as the exception log, none twice (a restart included)
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreenStatus, VERDICT_MENUS, VERDICT_STATES, isVerdict, judgeFor, programView, publishView, regionParts, regions, screenHash, screenJudgeName,
  type ScreenDeps, type ScreenJudge, type ScreenVerdict } from './screen-status.ts'
import { JevJudge, type JevAnswer } from './screen-judge-jev.ts'
import { StatusFacts, type StatusView } from './onsen-status.ts'
import { memberStateOf } from './onsen-wake.ts'
import { mainNowWords } from './lanes.ts'

const R = '─'.repeat(80)
const screen = (above: string[], below: string[] = ['  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], box = '❯ ') =>
  ['', ...above, '', R, box, R, ...below, '', ''].join('\n')
const IDLE = screen(['⏺ Done: the report is written.', '', '✻ Worked for 17s · done 1:37 AM'])
const BUSY = screen(['⏺ Bash(sleep 60)', '  ⎿  Running…', '', '✳ Cerebrating… (5m 4s · ↓ 24.2k tokens)'])
const SHELL = screen(['⏺ Started the build in the background.', '', '✻ Brewed for 28s · done 2:29 AM · 1 shell still running'],
  ['  Fable 5.2 · 7d 72%', '  ⏵⏵ bypass permissions on · 1 shell'])
const SUB = screen(['⏺ A helper is on it.', '', '✳ Cerebrating… (12s)'], ['  Opus 5.5 · 7d 72%', '  ⏵⏵ bypass permissions on', '', '  ⏺ main',
  '  ◯ general-purpose  Run sleep 25 and report    7s · ↓ 41.5k tokens'])
const MENU = ['', '   Select model', '   Switch between Claude models.', '   ❯ 1. Default (recommended)', '     2. Opus',
  '   Enter to set as default · s to use this session only · Esc to cancel', ''].join('\n')
const INTERRUPTED = screen(['✻ Churned for 6s · done 12:07 AM', '  ⎿  Interrupted · What should Claude do instead?'])
const COMPACT = screen(['✻ Compacting conversation… (12s)'])
// WO-177 二: a usage_limit verdict holds only where the limit message is the latest output (or the program has its own wall)
const LIMIT_SCREEN = screen(['⏺ Working on it.', "  ⎿  You've hit your session limit · resets 5am (UTC)"])
const SECRET = screen(['⏺ The key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and mail joey.example@example.com', '', '✻ Worked for 3s · done 1:00 AM'])
const SIX: Array<[string, string, ScreenVerdict['state'], ScreenVerdict['menu']]> = [
  ['a busy', BUSY, 'working', 'none'], ['b background shell', SHELL, 'idle_background_running', 'none'], ['c sub-agent', SUB, 'working', 'none'],
  ['d /model', MENU, 'waiting_for_human', 'model_picker'], ['e Esc', INTERRUPTED, 'interrupted', 'none'], ['f /compact', COMPACT, 'compacting', 'none']]
const V = (state: ScreenVerdict['state'], p = 0.9, menu: ScreenVerdict['menu'] = 'none', by: ScreenVerdict['by'] = 'jev'): ScreenVerdict => ({ state, menu, p, by })
const T0 = Date.parse('2026-11-26T03:00:00.000Z')
const prog = (state: StatusView['state'], detail: Record<string, unknown> = {}): StatusView => ({ state, detail: { queued_joey: 0, ...detail }, last_activity_at: '2026-11-26T02:59:00.000Z' })
const TURN = { turn_started_at: '2026-11-26T02:50:00.000Z', tool: { name: 'Bash', since: '2026-11-26T02:50:01.000Z' }, subagents: 0 }
/** statusOf's views a record is composed with: each fact the composition reads */
const PROGS: Array<[string, StatusView]> = [
  ['idle', prog('idle')], ['busy+turn', prog('busy', TURN)], ['stuck', prog('stuck', { threshold_s: 600, ...TURN })], ['waiting dialog', prog('waiting', { waitingFor: 'dialog open', ...TURN })],
  ['idle dialog_open', prog('idle', { dialog_open: true })], ['offline not_connected', prog('offline', { reason: 'not_connected' })],
  ['walled', prog('busy', { walled: { until: '2026-11-26T05:00:00.000Z', kind: 'session' }, ...TURN })], ['lanes', prog('idle', { lanes: [{ id: 'x.reflex.1', run: 'x.reflex.1.r1', since: 'y' }] })]]
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const lines = (f: string): any[] => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }

/** a reader over a fake pane with the given judge; `clock` is its now */
function reader(judge: () => ScreenJudge | null, o: { dir?: string; clock?: { t: number }; opts?: Record<string, number>; switchOn?: () => boolean; program?: () => StatusView } = {}) {
  const dir = o.dir ?? tmp('wo169-reader-'), clock = o.clock ?? { t: T0 }
  const st = { program: prog('idle'), published: 0 }
  const deps: ScreenDeps = { agent: 'lab-test', lanesDir: dir, switchOn: o.switchOn ?? (() => true), judge, snap: async () => null, isClaude: c => c !== 'zsh',
    program: o.program ?? (() => st.program), publish: () => { st.published++ }, log: () => {}, now: () => clock.t }
  const s = new ScreenStatus(deps, { retryMs: 30, ...(o.opts ?? {}) })
  s.active()
  return { s, st, dir, clock, bank: () => lines(join(dir, 'run', 'screen-verdicts.jsonl')) }
}
/** a judge that answers what it is told */
class FakeJudge implements ScreenJudge {
  readonly name = 'fake'
  n = 0
  constructor(public answer: (p: any) => ScreenVerdict | null | Promise<ScreenVerdict | null>) {}
  async judge(parts: any) { this.n++; return this.answer(parts) }
}
/** Jev's raw answer that JevJudge collects into exactly this verdict */
const jevFor = (v: ScreenVerdict): JevAnswer => ({ answers: { state: { choice: v.state, confidence: v.p, probabilities: { [v.state]: v.p } }, fits_any: { noul: 0.95 },
  menu: { choice: v.menu, probabilities: { [v.menu]: 0.5 } } }, ms: 150, usage: { input_tokens: 2000 }, model: 'jev-1.14.0' })
function jevJudge(dir: string, answer: (state: any) => JevAnswer, r: { s?: ScreenStatus }, program: () => StatusView): JevJudge {
  const qp = join(dir, 'questions.json')
  writeFileSync(qp, JSON.stringify({ version: 5, model: 'jev-1.14.0', setting: 'S', publish_when_state_probability_at_least: 0.6,
    questions: { state: { type: 'choice', instructions: 'x', criteria: Object.fromEntries([...VERDICT_STATES, 'not_claude', 'other'].map(k => [k, k])) }, fits_any: { type: 'noul', instructions: 'y' },
      menu: { type: 'choice', instructions: 'z', criteria: Object.fromEntries(VERDICT_MENUS.map(k => [k, k])) } } }))
  return new JevJudge({ agent: 'lab-test', lanesDir: dir, hasKey: () => true, questionsPath: qp, ask: async state => answer(state), logCall: () => {}, log: () => {},
    program, published: p => r.s ? r.s.view(p) : p, holds: (h, v) => !!r.s?.holds(h, v) }, { settleMs: 5 })
}

describe('1 the interface: JevRead only in JevJudge; publishView takes a ScreenVerdict; who judged does not reach the downstream', () => {
  test('source: JevRead appears only in screen-judge-jev.ts (and tests); publishView(v: ScreenVerdict, …)', () => {
    const dir = import.meta.dir
    const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    const has = files.filter(f => readFileSync(join(dir, f), 'utf8').includes('JevRead'))
    expect(has).toEqual(['screen-judge-jev.ts'])
    const ss = readFileSync(join(dir, 'screen-status.ts'), 'utf8')
    expect(ss).toMatch(/export function publishView\(v: ScreenVerdict \| null, st: Regions \| null, prog: StatusView, f: RecordFacts = \{\}\): StatusView/)
    for (const k of ['probabilities', 'fits_any', 'readAnswers', 'menu_p']) expect(ss.includes(k)).toBe(false)
    expect(readFileSync(join(dir, 'server.ts'), 'utf8').includes('JevRead')).toBe(false)
  })

  test('a fake ScreenJudge and JevJudge returning the same verdict: the same record, field by field, for every state × statusOf context, and the same report to Onsen', async () => {
    let checked = 0
    for (const [, text, state, menu] of [...SIX, ['idle', IDLE, 'idle', 'none'] as const, ['starting', MENU, 'starting', 'none'] as const, ['limit', LIMIT_SCREEN, 'usage_limit', 'usage_limit_options'] as const]) {
      for (const [, p] of PROGS) {
        const v = V(state, 0.87, menu)
        const fake = new FakeJudge(() => ({ ...v }))
        const a = reader(() => fake, { program: () => p })
        const ref: { s?: ScreenStatus } = {}, h: { j: ScreenJudge | null } = { j: null }
        const b = reader(() => h.j, { program: () => p, opts: { activeCheckMs: 0 } })
        h.j = jevJudge(b.dir, () => jevFor(v), ref, () => p)
        ref.s = b.s
        b.s.active()                                                            // the judge exists now (it is read when active() looks)
        // the downstream's report: StatusFacts as server.ts feeds it (the same clock)
        const sentA: any[] = [], sentB: any[] = []
        const fa = new StatusFacts({ agent: 'lab-test', sink: f => sentA.push(f), heartbeatMs: 0, now: () => T0 })
        const fb = new StatusFacts({ agent: 'lab-test', sink: f => sentB.push(f), heartbeatMs: 0, now: () => T0 })
        a.s.sample(text, '2.1.322'); b.s.sample(text, '2.1.322')
        await wait(2)
        const ra = a.s.view(p, true), rb = b.s.view(p, true)
        expect(rb).toEqual(ra)
        expect(ra.detail!.judged_by).toBe('jev')
        fa.update(ra); fb.update(rb)
        expect(sentB).toEqual(sentA)
        expect(fb.current()).toEqual(fa.current()!)
        expect(a.s.health().answer).toEqual(b.s.health().answer)
        checked++
      }
    }
    expect(checked).toBe(9 * PROGS.length)
  })

  test("the downstream cannot tell who judged: a verdict by 'program' gives the same member state, 此刻 line and report but for the label", async () => {
    for (const [, text, state, menu] of SIX) for (const [, p] of PROGS) {
      const byJev = publishView(V(state, 0.9, menu, 'jev'), regions(text), p), byProg = publishView(V(state, 0.9, menu, 'program'), regions(text), p)
      const strip = (x: StatusView) => ({ ...x, detail: { ...x.detail, judged_by: undefined } })
      expect(strip(byProg)).toEqual(strip(byJev))
      expect(byProg.detail!.judged_by).toBe('program')
      expect(memberStateOf(byProg, null)).toBe(memberStateOf(byJev, null))
      expect(mainNowWords(byProg, null)).toBe(mainNowWords(byJev, null))
    }
  })
})

describe('2 the composition order: offline → starting → usage limit → waiting → compacting → stuck → busy → idle', () => {
  const st = regions(BUSY)
  test('starting (Chiron 00:29Z): the process there and not registered yet (no_registration) with any verdict, or the verdict starting; with no verdict only when the pane runs Claude Code', () => {
    const reg = prog('offline', { reason: 'no_registration' })
    for (const s of VERDICT_STATES) expect(publishView(V(s), st, reg)).toMatchObject({ state: 'starting', detail: { program_offline: 'no_registration', judged_by: 'jev' } })
    expect(publishView(V('working'), st, prog('busy', { walled: { until: null }, ...TURN }))).toMatchObject({ state: 'walled' })
    expect(publishView(V('starting'), st, prog('busy', { walled: { until: null }, ...TURN }))).toMatchObject({ state: 'starting' })   // starting comes before the wall
    expect(publishView(V('starting'), st, prog('idle'))).toMatchObject({ state: 'starting', detail: { judged_by: 'jev' } })
    expect(publishView(null, null, reg, { alive: true })).toEqual({ state: 'starting', detail: { queued_joey: 0, program_offline: 'no_registration', judged_by: 'program' }, last_activity_at: '2026-11-26T02:59:00.000Z' })
    for (const alive of [false, null, undefined]) expect(publishView(null, null, reg, { alive })).toEqual(programView(reg))
    // not_connected is not starting: the screen's state with the reason (and no verdict: statusOf's offline)
    expect(publishView(V('idle'), st, prog('offline', { reason: 'not_connected' }))).toMatchObject({ state: 'idle', detail: { program_offline: 'not_connected' } })
    expect(publishView(null, null, prog('offline', { reason: 'not_connected' }), { alive: true })).toEqual(programView(prog('offline', { reason: 'not_connected' })))
    // the process gone: offline whatever the verdict, before starting
    expect(publishView(V('starting'), st, prog('offline', { reason: 'pid_gone' }))).toEqual(programView(prog('offline', { reason: 'pid_gone' })))
  })
  test('stuck is not overwritten by working; it keeps the turn start, the tool and the threshold', () => {
    const r = publishView(V('working'), st, prog('stuck', { threshold_s: 600, ...TURN }))
    expect(r).toEqual({ state: 'stuck', detail: { threshold_s: 600, turn_started_at: TURN.turn_started_at, tool: TURN.tool, subagents: 0, queued_joey: 0, judged_by: 'jev', judge_p: 0.9 },
      last_activity_at: '2026-11-26T02:59:00.000Z' })
    expect(memberStateOf(r, null)).toBe('stuck')
    expect(mainNowWords(r, null)).toContain('可能卡住了')
  })
  test('the screen says idle / interrupted / background while statusOf counted stuck: the screen (no turn is open, nothing is stuck)', () => {
    for (const s of ['idle', 'interrupted', 'idle_background_running'] as const) expect(publishView(V(s), st, prog('stuck', { threshold_s: 600, ...TURN })).state).toBe('idle')
  })
  test('waiting and compacting come before stuck (a menu, a compaction write nothing for minutes)', () => {
    expect(publishView(V('waiting_for_human', 0.9, 'permission'), st, prog('stuck', { threshold_s: 600, ...TURN }))).toMatchObject({ state: 'waiting', detail: { waitingFor: 'permission', tool: TURN.tool } })
    expect(publishView(V('compacting'), st, prog('stuck', { threshold_s: 600, ...TURN }))).toMatchObject({ state: 'busy', detail: { compacting: true } })
  })
  test("the usage limit: the screen's or statusOf's wall, before everything but offline", () => {
    const wall = { walled: { until: '2026-11-26T05:00:00.000Z', kind: 'session' } }
    for (const s of ['working', 'idle', 'waiting_for_human', 'compacting'] as const)
      expect(publishView(V(s, 0.9, s === 'waiting_for_human' ? 'model_picker' : 'none'), st, prog('busy', { ...wall, ...TURN }))).toEqual({ state: 'walled',
        detail: { queued_joey: 0, walled: wall.walled, judged_by: 'jev', judge_p: 0.9 }, last_activity_at: '2026-11-26T02:59:00.000Z' })
    expect(publishView(V('usage_limit', 0.9, 'usage_limit_options'), st, prog('idle'))).toMatchObject({ state: 'walled', detail: { walled: { until: null } } })
  })
  test('offline: the process gone is statusOf\'s view whatever the verdict; a session this daemon cannot see is the screen\'s, with the reason', () => {
    for (const s of VERDICT_STATES) expect(publishView(V(s), st, prog('offline', { reason: 'pid_gone' }))).toEqual(programView(prog('offline', { reason: 'pid_gone' })))
    expect(publishView(V('idle'), st, prog('offline', { reason: 'not_connected' }))).toMatchObject({ state: 'idle', detail: { program_offline: 'not_connected' } })
  })
  test('the remaining-quota percentage stays out of the record (an unknown menu\'s text)', () => {
    const r = publishView(V('waiting_for_human', 0.9, 'other'), regions(screen(['Some panel', "You've used 79% of your weekly limit", 'press a key'])), prog('idle'))
    expect(String(r.detail!.waiting_text)).not.toContain('79%')
    expect(String(r.detail!.waiting_text)).toContain('press a key')
  })
})

describe('3 the interface holds, and the switch', () => {
  test('a judge answer outside the lists or p outside 0–1 is no verdict: the record is statusOf\'s (judged_by program), counted', async () => {
    for (const bad of [{ state: 'not_claude', menu: 'none', p: 0.9, by: 'jev' }, { state: 'idle', menu: 'effort_picker', p: 0.9, by: 'jev' }, { state: 'idle', menu: 'none', p: 1.5, by: 'jev' },
      { state: 'idle', menu: 'none', p: 0.9, by: 'someone' }, { state: 'idle' }]) {
      expect(isVerdict(bad)).toBe(false)
      const r = reader(() => new FakeJudge(() => bad as any))
      r.s.sample(IDLE, '2.1.322'); await wait(2)
      expect(r.s.view(r.st.program)).toEqual(programView(r.st.program))
      expect(r.s.health()).toMatchObject({ not_verdict: 1, answer: null })
      expect(r.bank()).toEqual([])
    }
    expect(isVerdict(V('idle'))).toBe(true)
  })
  test('JevJudge: an option Chiron adds to questions.json but not to the lists does not reach the record (and is an exception)', async () => {
    const ref: { s?: ScreenStatus } = {}, h: { j: ScreenJudge | null } = { j: null }
    const r = reader(() => h.j, { opts: { activeCheckMs: 0 } })
    h.j = jevJudge(r.dir, () => ({ answers: { state: { choice: 'idle', probabilities: { idle: 0.9 } }, fits_any: { noul: 0.9 }, menu: { choice: 'effort_picker', probabilities: { effort_picker: 0.7 } } }, ms: 5 }), ref, () => r.st.program)
    ref.s = r.s; r.s.active()
    r.s.sample(IDLE, '2.1.322'); await wait(20)
    expect(r.s.view(r.st.program).detail!.judged_by).toBe('program')
    expect(lines(join(r.dir, 'run', 'screen-exceptions.jsonl')).map(e => e.kinds)).toEqual([['menu_unmapped:effort_picker']])
  })
  test('SCREEN_JUDGE: jev (default, and for a name it does not know), program; the switch point', () => {
    expect(screenJudgeName(undefined)).toEqual({ name: 'jev' }); expect(screenJudgeName(' JEV ')).toEqual({ name: 'jev' })
    expect(screenJudgeName('program')).toEqual({ name: 'program' }); expect(screenJudgeName('Program ')).toEqual({ name: 'program' })
    expect(screenJudgeName('gpt')).toEqual({ name: 'jev', unknown: 'gpt' })
    const f = new FakeJudge(() => V('idle'))
    expect(judgeFor('jev', { jev: f, program: null })).toBe(f)
    expect(judgeFor('program', { jev: f, program: null })).toBeNull()
  })
  // WO-177 ⑤ (Chiron 03:41Z): with no judge the pane is still read (the program's own cut); nothing is asked; an idle screen leaves statusOf's record
  test('program (no judge): the pane read, nothing asked, the record is statusOf\'s judged_by program on an idle screen; JEV_SCREEN off: statusOf untouched', async () => {
    const r = reader(() => null)
    expect(r.s.active()).toBe(false)
    expect(r.s.health()).toMatchObject({ on: false, reading: true, judge: null })
    r.s.sample(IDLE, '2.1.322'); await wait(2)
    expect(r.s.health()).toMatchObject({ looks: 1, calls: 0 })
    expect(r.s.view(r.st.program)).toEqual(programView(r.st.program))
    const off = reader(() => new FakeJudge(() => V('idle')), { switchOn: () => false })
    expect(off.s.view(off.st.program)).toBe(off.st.program)
  })
  test('the setting changes while running (jev → program → jev): the verdict held is dropped at once; asked again under the new judge', async () => {
    const f = new FakeJudge(() => V('working'))
    let cur: ScreenJudge | null = f
    const r = reader(() => cur, { opts: { activeCheckMs: 0 } })
    r.s.sample(BUSY, '2.1.322'); await wait(2)
    expect(r.s.view(r.st.program).state).toBe('busy')
    cur = null; r.s.active()
    expect(r.s.view(r.st.program)).toEqual(programView(r.st.program))
    cur = f; r.s.active()
    r.s.sample(BUSY, '2.1.322'); await wait(2)
    expect(f.n).toBe(2)
    expect(r.s.view(r.st.program).state).toBe('busy')
  })
  test('null: no verdict for that screen, not asked again for it (the 60 s re-ask aside); a rejection: asked once more after retryMs', async () => {
    let n = 0
    const nul = new FakeJudge(() => { n++; return null })
    const r = reader(() => nul)
    for (let i = 0; i < 3; i++) { r.s.sample(IDLE, '2.1.322'); await wait(2) }
    expect(n).toBe(1)
    expect(r.s.view(r.st.program).detail!.judged_by).toBe('program')
    const bad = new FakeJudge(() => Promise.reject(new Error('down')))
    const q = reader(() => bad, { clock: { t: Date.now() } })
    q.s.sample(IDLE, '2.1.322'); await wait(2)
    expect(q.s.health()).toMatchObject({ failed: 1 })
  })
})

describe('4 /healthz and the record Onsen holds', () => {
  test('screen_status.answer is the ScreenVerdict: its four fields', async () => {
    const r = reader(() => new FakeJudge(() => V('waiting_for_human', 0.93, 'model_picker')))
    r.s.sample(MENU, '2.1.322'); await wait(2)
    const h = r.s.health() as any
    expect(h.answer).toEqual({ state: 'waiting_for_human', menu: 'model_picker', p: 0.93, by: 'jev' })
    expect(Object.keys(h.answer).sort()).toEqual(['by', 'menu', 'p', 'state'])
    expect(h.judge).toBe('fake')
  })
  test("StatusFacts.current(): state, since (the first report of the state, as Onsen's), at, detail as sent, last_activity_at (the newest one sent)", () => {
    let t = T0
    const saved: any[] = []
    const f = new StatusFacts({ agent: 'lab-test', sink: () => {}, heartbeatMs: 15_000, now: () => t, since: { load: () => null, save: x => saved.push(x) } })
    f.update({ state: 'idle', detail: { queued_joey: 0 }, last_activity_at: '2026-11-26T02:00:00.000Z' })
    expect(f.current()).toEqual({ state: 'idle', at: '2026-11-26T03:00:00.000Z', since: '2026-11-26T03:00:00.000Z', detail: { queued_joey: 0, heartbeat_s: 15 }, last_activity_at: '2026-11-26T02:00:00.000Z' })
    t += 5000; f.update({ state: 'idle', detail: { queued_joey: 1 }, last_activity_at: null })
    expect(f.current()).toMatchObject({ state: 'idle', at: '2026-11-26T03:00:05.000Z', since: '2026-11-26T03:00:00.000Z', detail: { queued_joey: 1 }, last_activity_at: '2026-11-26T02:00:00.000Z' })
    t += 5000; f.update({ state: 'busy', detail: { queued_joey: 0 }, last_activity_at: '2026-11-26T03:00:09.000Z' })
    expect(f.current()).toMatchObject({ state: 'busy', since: '2026-11-26T03:00:10.000Z' })
    expect(saved).toEqual([{ state: 'idle', since: '2026-11-26T03:00:00.000Z' }, { state: 'busy', since: '2026-11-26T03:00:10.000Z' }])
    f.stop()
    // a restart in the same state keeps since (Onsen keeps it: the state did not change); in another state, a new one
    const g = new StatusFacts({ agent: 'lab-test', sink: () => {}, heartbeatMs: 0, now: () => t + 60_000, since: { load: () => saved.at(-1), save: () => {} } })
    g.update({ state: 'busy', detail: {}, last_activity_at: null })
    expect(g.current()).toMatchObject({ since: '2026-11-26T03:00:10.000Z' })
    const h = new StatusFacts({ agent: 'lab-test', sink: () => {}, heartbeatMs: 0, now: () => t + 60_000, since: { load: () => saved.at(-1), save: () => {} } })
    h.update({ state: 'idle', detail: {}, last_activity_at: null })
    expect(h.current()).toMatchObject({ since: '2026-11-26T03:01:10.000Z' })
  })
})

describe('5 run/screen-verdicts.jsonl: the question bank', () => {
  test('the six screens a–f (and idle): one line each with every field; the same screens again write nothing; a restart the same day nothing; the next day again', async () => {
    const clock = { t: T0 }
    const want = new Map<string, ScreenVerdict>(SIX.map(([, text, state, menu]) => [text, V(state, 0.88, menu)]))
    want.set(IDLE, V('idle', 0.95))
    const judge = new FakeJudge(p => {
      for (const [text, v] of want) if (screenHash(regionParts(text)) === screenHash(p)) return v
      return null
    })
    const r = reader(() => judge, { clock, opts: { cacheMs: 1 } })
    const showAll = async () => { for (const text of [IDLE, ...SIX.map(s => s[1])]) { r.s.sample(text, '2.1.322'); await wait(2); clock.t += 1000 } }
    await showAll()
    let bank = r.bank()
    expect(bank).toHaveLength(7)
    expect(new Set(bank.map(b => b.hash)).size).toBe(7)
    for (const b of bank) {
      expect(Object.keys(b)).toEqual(['ts', 'agent', 'hash', 'judge_version', 'has_input_box', 'screen', 'counted_by_program', 'found_by_program', 'verdict'])   // WO-177 五: the judge's version
      expect(Object.keys(b.verdict).sort()).toEqual(['by', 'menu', 'p', 'state'])
    }
    const byState = Object.fromEntries(bank.map(b => [b.verdict.state + (b.verdict.state === 'working' ? `:${b.counted_by_program.running_agents}` : ''), b]))
    expect(byState['working:0']).toMatchObject({ has_input_box: true, found_by_program: { tool_running_line: true } })
    expect(byState['working:1'].counted_by_program.running_agents).toBe(1)
    expect(byState.idle_background_running.counted_by_program.shells).toBe(1)
    expect(byState.waiting_for_human).toMatchObject({ has_input_box: false, verdict: { menu: 'model_picker' } })
    expect(byState.waiting_for_human.screen.screen_bottom).toContain('Select model')
    expect(byState.interrupted.screen.above_input_box).toContain('Interrupted')
    expect(byState.compacting.screen.above_input_box).toContain('Compacting')
    // again (asked again: the cache is 1 ms here): nothing new
    await showAll()
    expect(judge.n).toBeGreaterThan(7)
    expect(r.bank()).toHaveLength(7)
    // a restart (a new reader on the same workspace) the same day: nothing new
    const r2 = reader(() => judge, { dir: r.dir, clock, opts: { cacheMs: 1 } })
    for (const text of [IDLE, MENU]) { r2.s.sample(text, '2.1.322'); await wait(2); clock.t += 1000 }
    expect(r2.bank()).toHaveLength(7)
    // the next day (UTC): a line again
    clock.t += 24 * 3600_000
    r2.s.sample(BUSY, '2.1.322'); await wait(2)
    bank = r2.bank()
    expect(bank).toHaveLength(8)
    expect(bank[7].ts.slice(0, 10)).toBe('2026-11-27')
  })
  test('masked as the exception log masks the screen (the duty officer\'s redact): the same text in both files', async () => {
    const ref: { s?: ScreenStatus } = {}, h: { j: ScreenJudge | null } = { j: null }
    const r = reader(() => h.j, { opts: { activeCheckMs: 0 } })
    // JevJudge with an answer whose fits_any is low: an exception line for the same screen
    h.j = jevJudge(r.dir, () => ({ answers: { state: { choice: 'idle', probabilities: { idle: 0.9 } }, fits_any: { noul: 0.2 }, menu: { choice: 'none', probabilities: { none: 0.9 } } }, ms: 5 }), ref, () => r.st.program)
    ref.s = r.s; r.s.active()
    r.s.sample(SECRET, '2.1.322'); await wait(20)
    const [b] = r.bank(), [e] = lines(join(r.dir, 'run', 'screen-exceptions.jsonl'))
    expect(e.kinds).toEqual(['fits_any_low'])
    expect(b.screen).toEqual(e.screen)
    expect(b.screen.above_input_box).not.toContain('sk-ant-api03-AAAA')
    expect(b.screen.above_input_box).not.toContain('joey.example@')
    expect(b.verdict).toEqual({ state: 'idle', menu: 'none', p: 0.9, by: 'jev' })
  })
})

describe('13 a failed call is not given up on (Chiron 00:57Z: Jev down 00:07–00:40Z; the screens that did not change stayed on program)', () => {
  test('a judge that fails for 3 minutes, then answers: asked at 0 s, 10 s, then every 60 s; judged_by back to jev within 60 s of its recovery; the state never moves', async () => {
    const clock = { t: T0 }
    let calls: number[] = []
    const judge = new FakeJudge(() => { calls.push(clock.t - T0); return clock.t - T0 < 180_000 ? Promise.reject(new Error('HTTP 400 Unknown model')) : V('idle', 0.97) })
    const r = reader(() => judge, { clock, opts: { retryMs: 10_000 } })
    const seen: Array<{ s: number; state: string; by: unknown }> = []
    for (let s = 0; s <= 300; s++) {                                         // the reader's own look, once a second, the screen unchanged
      clock.t = T0 + s * 1000
      r.s.sample(IDLE, '2.1.322')
      await new Promise(res => setTimeout(res, 0))
      const v = r.s.view(r.st.program)
      seen.push({ s, state: v.state, by: v.detail?.judged_by })
    }
    expect(calls.slice(0, 5)).toEqual([0, 10_000, 70_000, 130_000, 190_000])
    expect(calls).toHaveLength(5)                                             // once it answered, the same screen is not asked again
    const firstJev = seen.find(x => x.by === 'jev')!
    expect(firstJev.s).toBe(190)
    expect(firstJev.s - 180).toBeLessThanOrEqual(60)
    expect(new Set(seen.map(x => x.state))).toEqual(new Set(['idle']))         // no flip while it recovered
    expect(seen.filter(x => x.s < 190).every(x => x.by === 'program')).toBe(true)
    expect(seen.filter(x => x.s >= 190).every(x => x.by === 'jev')).toBe(true)
    expect(r.s.health()).toMatchObject({ failed: 4, answer: { state: 'idle', by: 'jev' } })
  })
  test('a judge that answers but cannot tell (null) is not asked again for that screen; a new screen is asked at once even while failing', async () => {
    const clock = { t: T0 }
    let n = 0
    const r = reader(() => new FakeJudge(() => { n++; return null }), { clock })
    for (let s = 0; s <= 200; s += 5) { clock.t = T0 + s * 1000; r.s.sample(IDLE, '2.1.322'); await new Promise(res => setTimeout(res, 0)) }
    expect(n).toBe(1)
    let m = 0
    const f = reader(() => new FakeJudge(() => { m++; return Promise.reject(new Error('down')) }), { clock: { t: T0 } })
    f.s.sample(IDLE, '2.1.322'); await new Promise(res => setTimeout(res, 0))
    f.s.sample(BUSY, '2.1.322'); await new Promise(res => setTimeout(res, 0))
    expect(m).toBe(2)
  })
})
